# SDK引数契約の見直し

2026-10-07。設計・実装計画。実装・隔離検証済み。稼働playへの反映と最終確認を進める。

Goal: native Codexが操作対象のbotや位置引数の順序を覚えずにSDKを呼べる。入力の誤りは内部関数・RPCへ渡す前に、間違ったfieldと修正例を示して拒否する。

## 調査で確認したこと

- 開発HEADは `cf117b2c22784aa26e5e02959177fb8b2421a9bb`。`play/config.json` → `.active-bundle.json` が指すbundleは `bundle-053b331f25584fbfb2a74f81b9fd9a20`、play pinは `1ebc2209ab205684f4cb813fea83cd3e00b04046`。その差分は倉庫指示とチェスト転送・places説明等の改善。開発checkoutには別作業の `viewChest` / `tests/run-tests.cjs` 未commit差分がある。
- [`coder.js`](src/agent/coder.js) は `skills` / `world` の関数をほぼそのままSESへ渡し、呼出側が `bot` を渡す。`vision` / `places` 等は既にhost側で対象を束縛する。method名のlintはあるが、引数契約の共通検証はない。
- 倉庫の保存済み隔離trace4件には計28 operation resultがあり、11件が失敗、そのうち8件は `bot` の欠落・別の値をbot扱いしたTypeError。`world.getPosition()`、`world.getNearbyBlockTypes(12)`、`world.inspectBlockAt(x,y,z)` 等。うち2 runは全操作がこの誤用で失敗。これは当該fixtureの観測数で、通常playの失敗率ではない。[調査文書](docs/warehouse-20261007.md)、[private results](../mindcraft-tools/results/warehouse-20261007/)を参照。
- 現bundleへ引き継がれたBot3の `memory.json` には、2026-10-07 12:53 JSTの `places.find({text:"chest"})` と `text must be a non-empty string` の組がある。Bot4も同型の呼出しを保存しているが、awaitの欠落もありerror欄はnull。これらは切替前bundleでの履歴で、現bundleで新たに発生した失敗とは数えない。
- [`index.js`](src/agent/library/index.js) は関数内JSDocから説明を抽出するが、全methodの署名は生成しない。`world.getNearestBlocks` の距離は実装default 8、説明default 16と不一致。`craftRecipe` の `num` はレシピ実行回数で、JSDocのparamに記載されていない。[内部実装](src/agent/library/skills.js)を数量契約の根拠にする。

H1: method選択や説明読込の不足だけではなく、botの有無・位置引数・object形式の不統一が、観測した誤用を許している。

使い捨てのNode20 fixtureで実 `world.js` と実SESを読取り、上記3種類の誤呼出しを再現した。botをclosureに束縛し名前付きobjectを変換する小さい仮adapterでは、引数なし位置観測、近傍検索、絶対block観測が通った。未知field・NaN・radius超過・小数limit・旧位置引数・文字列座標・bot fieldの7種類は内部検索前に拒否でき、2botの束縛も分離された。fixtureは終了時に削除し、共有dependencyはread-only、Minecraftには接続していない。この実験は境界の実現性を支持するが、実装済みSDKやモデル成功率の改善を示さない。

## 採用する設計方針

1. **モデル向けAPIはbotをhostで束縛する。** nativeの全namespaceで呼出側の `bot` 引数を廃止する。Botを要しないpure helperはそのまま対象なし。内部skills/world、reflex、chat command、legacy生成コードは既存契約を使う。
2. **入力があるmethodは名前付きobjectを1つ受け取る。** 引数なしmethodは `method()` / `method({})` を許す。全fieldがoptionalのmethodも省略時は `{}` とする。入力が必要ならobject必須。文字列略記、旧位置引数、引数の自動ずらし、型変換による救済は提供しない。
3. **意味をfield名に出す。** 絶対座標は `position: {x,y,z}`、相対座標は `offset: {x,y,z}`。開始点の選択は `startPosition`、チェスト選択は `chestPosition`。探索距離は `radius`、結果数上限は `limit`、到達許容距離は `minDistance`。時間は `milliseconds` / `seconds` で単位を明記する。
4. **数量は単位を保つ。** 採掘は `count`（blocks）、アイテム移動は `quantity`（items）、craftは `times`（recipe executions）。転送の全量は明示的な `quantity: 'all'` とし、内部だけで `-1` に変換する。nativeの転送ではquantityを必須にして、省略による全量移動を避ける。他methodのdefaultは既存挙動を根拠に決め、schemaと説明を一致させる。
5. **実行と説明は同じ明示的なmethod定義を使う。** 定義に名前、fields、required/default、制約、内部関数への変換、意味・結果・例を持たせる。その定義からnative facade、deferred文書、catalogを作る。既存JSDocは内部/legacy用として残す。関数の文字列解析やarityからbot・defaultを推測しない。
6. **入力検証は共通の入口で行う。** 未知field、不足、型、finite数、正整数、enum、nested position、排他的optionを確認する。radius等の上限は有効なhost設定を使う。SES由来のobjectは別realmなのでprototypeの同一性を条件にしない。predicate/functionや観測済みBlock/Entityを受ける既存methodは、必要なfield型を定義し、JSON化を強制しない。
7. **引数エラーを修正可能な形にする。** `SdkArgumentError` に `code: 'INVALID_ARGUMENT'`、`method`、`field`、`expected`、公開署名、短い修正例を持たせる。既存operation result/message・診断にこの情報を残し、内部Bot内容や無制限の入力dumpは載せない。未知fieldは黙ってdefault扱いせず拒否する。domainのfalse/blocked、キャンセル、無効機能、RPC障害とは区別する。

例（新しいnative API）：

```js
await Promise.resolve();
const p = world.getPosition();
const blocks = world.getNearestBlocks({
    blockTypes: ['chest', 'trapped_chest'], radius: 16, limit: 3
});
const target = world.inspectBlockAt({position: {x: 10, y: 64, z: -3}});
const below = world.getBlockAtPosition({offset: {x: 0, y: -1, z: 0}});
const moved = await skills.goToPosition({position: p, minDistance: 2});
const stored = await skills.putInChest({
    itemName: 'oak_log', quantity: 'all', chestPosition: {x: 10, y: 64, z: -3}
});
const placesFound = await places.find({text: '倉庫', kind: 'storage'});
const image = await vision.lookAtBlock({position: {x: 10, y: 64, z: -3}});
log(bot, JSON.stringify({blocks, target, below, moved, stored, placesFound, image}));
```

`log(bot, message)` とraw botは既存execution templateの補助経路として残す。SDK methodのbot束縛とraw bot accessの廃止を混同しない。`skills.log` がnative catalogへ載る場合は `{message}` へ束縛する。新しい結果型やasync化、目標判定器、再試行機構は追加しない。同期world観測と既存boolean/構造化結果・server確認を維持する。

## 変更する境界

- native method定義とfacadeをlibraryへ置き、`Coder._stageCode` のnative分岐で既存の `guardSdk`・false-mode・operation ownershipの内側へ接続する。native taskへ一度束縛したbot/SDKを使い、process-wideの可変botを設けない。
- 現native catalogに載る全methodを明示的に移し、`skills` / `world` / `places` / `vision` / `diagnostics` / `communication` の新旧混在を防ぐ。既存method名は維持し、引数の意味だけを明示する。生の内部関数をnative namespaceへ漏らさない。
- native sessionのdeferred説明とCoderのmethod lintは同じnative定義を参照する。legacyの `SkillLibrary` 文書選択やchat command解析へ新署名を流さない。`places` は現在exec templateのmain引数でも渡されるため、compartmentのendowmentだけでなくmainへ渡す値も揃える。
- `src/process/codex/AGENTS.md` のAPI案内・communication例等を新契約に更新する。catalogを手書きしない。SDK scope hashとcontext protocolを更新し旧署名のthreadを一度新規化する。その後の通常再開・memory・previous-task診断を維持し、古いコードを自動実行しない。
- 入力エラーの構造化情報をActionManager → native operation result → task diagnosticsまで必要な範囲で伝える。例外の処理やowner終了条件をバイパスしない。

## 完了条件と検証

- 現行catalogの全methodが新定義に存在し、runtime公開method・説明・lintが同じ集合になる。native文書・例に旧bot位置引数が残らず、default/requiredが定義と一致する。
- 保存済み誤用を実Coder/SES/ActionManagerで再生する。`world.getPosition()` と `places.find({text:'chest'})` は成功する。数値のみの `world.getNearbyBlockTypes(12)` 等は内部TypeErrorではなく公開fieldと修正例を示す入力エラーになり、示された修正版は同じtaskで通る。
- 入力不正時は、その呼出しによる移動、look、container open、dig/place、RPC送信が0。複合コードで先行した正しい変更まで巻き戻したと報告しない。未知fieldやnull、非有限座標、全量・数量単位、排他的farm optionを確認する。
- 既存bot-firstの内部/legacy/chat経路を維持する。nativeもキャンセル・settlement・guard・画像・diagnostics・通信認証・false-mode・複数bot分離を保つ。既存targeted/vision/placement/place/native fixturesとNode20 offline suite、syntax、whitespace checkを実行する。
- モデル効果は隔離確認する。既存倉庫fixture・依頼・model/effortを固定しbefore/after各3回を新規threadで比較する（この回数を定数として実験条件に残す）。初期状態を毎回resetし、引数エラー数、同じ誤用の反復、説明取得、操作数、要求した倉庫の実観測結果を分けて記録する。各fixtureの成功率を一般化しない。結果が悪化したら当該引数/説明の証拠を調べて計画を更新する。
- 引数エラー後の修正呼出し、thread切替後の新規・再開を確認する。CLI隔離実験はowner repoの `results/<experiment>/codex-home/` を使い、auth/configだけsymlink、普段のsessionsを共有しない。

## 次の作業

- [x] 全公開methodのfield・意味・default・変換を既存実装/呼出しと照合し、共通validatorと明示的registryを作る。数量・座標・省略の契約は上記を基準にする。
- [x] nativeのfacade、deferred docs、method lint、bot指示、scope、入力エラー診断を一緒に接続し、旧経路との混在を防ぐ。実境界で誤用→エラー→修正成功と副作用0を検証し、既存suiteを通す。
- [x] 同条件の隔離モデル比較で成果と引数エラーを確認し、README/AGENTS等の必要な記述と調査結果を更新する。task差分だけを `autonomy` のown originへcommit/pushする。

## 制約と後続作業

- 2026-10-07の `$exec` と「反映までやっていいよ」により実装・検証・play pin更新・bot/UIだけの切替が承認された。既存未commit差分を保持し、server/world/Ollamaは切替で停止しない。
- 実装時も共有dependencyをread-onlyで使い、新規依存や内部skillsの全面改造は不要。隔離live確認は既存CaseServer copy・許可されたloopback portだけを使い、ユーザーworld/templateを変更しない。
- 検証済みfull SHAのown origin push確認後、既存applyで稼働playへ反映する。旧bundleとpin・memoryを保持し、失敗時は既存applyのrollbackと4体readiness確認で復旧する。新契約のthread scopeを旧版のものとして再利用しない。
- [ ] 反映後、4体named readiness、UI応答、source/export契約一致、server/Ollamaのprocess継続、memory/namespace/設定維持を確認してactivation記録を残す。

実装検証: 83 method、実Coder/SESとNode20 offline suite、実CLI新規/再開・画像を確認。隔離比較は引数error 9→1、実測倉庫1/3→3/3。after overlayに既存viewChest差分が含まれる制約は結果文書へ記載。
