# PLAN

## 目的

native SDKを、必要な操作を少ない判断で選べ、単純な引数で実行でき、結果から完了・不足・回復方法を判断できる入口にする。既存のゲーム操作と、確認済みの不足であるアイテム使用の照準・保持・解除をSDKだけで完結させる。SDK数の削減自体を目標にせず、目的・副作用が異なる機能の分離は維持する。

## 完了条件と検証

- 数量を要求する操作は、全量完了・部分完了・未確認を区別する。`collectBlock(count:10)`で1個だけ採取、`discard(quantity:10)`で2個だけ廃棄、`tradeWithVillager(times:10)`で2回だけ実行した場合は成功扱いにせず、要求数・確認済み数・残数を返す。数量の単位を明示し、ブロック数・アイテム数・取引回数を混同しない。`collectBlock`の確認済み数はサーバー確認済みの破壊ブロック数とし、ドロップの取得は別の観測値として返して`confirmedQuantity`へ混ぜない。`giveToPlayer`の確認済み数は自分のインベントリ減少で確認した投下数とし、相手の受領は拾得を観測できた場合だけ確認済み、それ以外は`null`とする。未確認量は`null`とする。既存fixtureで不足時と全量完了時を確認する。
- 公開actionは成否と観測した原因を構造化して返す。失敗した対象・不足品・変更済みの部分を、ログの文章解析なしに判断できる。失敗結果は`minecraft_execute`の`sdkFailure`と次の判断・`diagnostics.lastTask()`まで保持される。queryの`false`・`null`・`unknown`は観測値として維持する。
- `consume()`と`consume({itemName:""})`は利用可能な食料を選び（負の効果・ランダム転移・希少品である`rotten_flesh`、`spider_eye`、`poisonous_potato`、`pufferfish`、`chorus_fruit`、`suspicious_stew`、`golden_apple`、`enchanted_golden_apple`は省略時の候補から除外し、残りから満腹度回復量の大きいものを選ぶ）、明示的な`itemName`はその品だけを使う。食料なし・指定品なし・消費効果が未確認の場合を区別する。通常の自己給餌は明示品の指定やraw bot操作を要求しない。
- 公開定義・実行・引数検証・遅延文書・一覧・lintの契約が一致する。不要な公開入口を整理しても、型による検索・座標条件による検索・最寄り1件の取得・対象なしのアイテム使用が可能である。`getNearestBlocks`のデフォルト`radius`は現行の8を維持し、旧`getNearestBlock`（デフォルト16）の代替例・遅延文書では必要な`radius`を明示する。非公開化した名前や旧引数は修正先が分かるエラーになり、暗黙の互換経路を追加しない。
- プレイヤー名は`playerName`に統一する。Entity操作の指定方法（Entity参照と`entityId`の混在）は利用頻度に対して移行コストが大きいため今回は変更しない。ブロック/アイテムのregistry数値IDを通常の呼び出しに要求しない。配置の向きなど、目的達成に必要な引数は残す。
- 有限のアイテム使用は、照準（`position`または観測済みEntity参照`entity`のどちらか一方。同時指定は明示エラー、省略時は現在の向き）・必要な装備・指定時間の保持・解除・取消時の後始末を一度のSDK呼び出しで扱う。入力送信の成功と、命中・飲食・ブロック変化などのゲーム上の効果を区別する。既存の所有・取消境界で、正常終了と取消の両方で使用状態が解消することを確認する。
- 内部呼び出し・旧コマンド・legacy生成コードのboolean契約を壊さない。特に`if (!await skill(...))`が結果オブジェクトのtruthinessで成功扱いにならない。既存の接近、サーバー確認、経路方針、危険脱出、部分変更の保持を維持する。
- 実装後は登録済み`mindcraft`のaffected検証を通し、push済みsourceの標準bot-only applyまで完了する。計画作成だけの今回の作業では実装・pin変更・applyを行わない。

## 制約

- 主なownerはこの`mindcraft` repoの`autonomy` branch。通常の依存更新、install/ci、親への共通runner追加はしない。親`../PLAN.md`の別件の未完了計画は保持する。
- 開始時の既存差分は`src/process/codex/AGENTS.md`。内容を保持し、他の変更と合わせて誤ってstageしない。実装時に同じファイルを更新する必要があれば、既存差分と今回分を分けて扱う。
- 引数はbotを渡さない名前付きオブジェクト1つ。別名の並立、型を推測する引数変換、ログからの原因推測、失敗時の別対象への自動代替を追加しない。
- SDKの個別仕様は`src/agent/library/native_sdk.js`の遅延文書を正本とする。bot用AGENTSには共通原則と自動生成された名前一覧だけを置く。共通のSDK設計原則をroot AGENTSへ短く残し、READMEのnative契約・例も同じ変更に合わせる。文書更新は`project-docs`に従う。
- 操作に追加の承認・安全用編集上限・重複した事前確認を設けない。raw bot遮断やsandboxの作り直しは今回の改善手段にしない。通常操作がraw botへ降りずに完結する公開APIを整える。
- 認証情報、保存world、memory、thread、共有placeデータを削除・改変しない。既存のSDK仕様変更検出で必要な新threadを開始しても、保存済み履歴は保持する。

## 根拠と設計判断

- プレイヤー名引数の統一は、観測済みの不統一に基づく。nativeの`giveToPlayer`は`playerName`だが`goToPlayer`/`followPlayer`は`username`。Entity指定も`tradeWithVillager`/`showVillagerTrades`の`entityId`と`attackEntity`/`moveAwayFromEntity`/`isClearPath`のEntity参照が混在するが、対象メソッドの利用が少なく移行コストに見合わないため対象外とした。数量・原因の修正と同じSDK文書hash更新にまとめ、thread新規化を一度で済ませる。
- 計画外の既存バグ: `skills.js`の`useToolOn`は`!bot.game.gameMode === 'creative'`が常に`false`で、道具の所持確認が働かない。同関数の整理時に直す。
- 調査基準は2026-10-27、source `49bcaef`。`native_sdk.js`には82メソッド（skills 43 / world 21 / places 13 / vision 3 / diagnostics 1 / communication 1）がある。`skills.log`と別公開の`log(bot,message)`、`useToolOn(targetName:"nothing")`と`useItem`が重複している。
- 同ファイルは公開契約の共通registry。`coder.js`の`nativeExecutionSafety()`は失敗・未完了を後続SDK呼び出しの停止へ変換する。構造化結果を返す処理でも、registryのquery/action・completionと実行側の判定が一致する必要がある。
- `skills.js`の`collectBlock`は`collected > 0`、`discard`は1個以上の廃棄、`tradeWithVillager`は上限で切り詰めた回数の終了を成功としている。実関数を切り出しnative adapterへ接続したモックで、10要求に対してそれぞれ1・2・2の処理でも`true`になることを確認済み。
- 同じモックで、リンゴを持っている`consume()`は`false`と`You do not have any undefined to eat.`、`consume({itemName:"apple"})`は`true`を返した。省略時の食料選択が実装されていない。明示品がないときに別の食料へ代替する仕様にはしない。
- `operation_context.js`にはcall ID、親子関係、確認・未確認の変更、`call.result`があり、`skills.js`の公開bindingは`trackSkill()`で包まれる。原因と数量は発生箇所で作り、これらの既存経路へ載せる。別の結果台帳やbooleanから成功量を推定する仕組みは追加しない。
- チェスト転送、製作、精錬、移動、農作業には既に構造化結果がある。共通部分は`ok`・`status`・機械判定用`code`・人間向け`reason`とし、数量処理では既存の`requestedQuantity`・`confirmedQuantity`・`remainingQuantity`を使う。`reason`と同じ文章の`message`は増やさず、`reached`など意味のある既存status・診断も保持する。queryや場所recordへ機械的な共通envelopeを被せない。
- `useItem`とインストール済みMineflayerの実関数を組み合わせた追加モックでは、使用後に`usingHeldItem:true`、送信は`use_item`だけ、公開解除メソッドなし。内部`deactivateItem()`で`block_dig(status:5)`が送られ`false`に戻った。実サーバーの発射・命中を示す証拠ではない。
- モックの実行方法は既存Node 20による`node --input-type=module`の使い捨てheredoc。`node:fs/promises`で当該関数を読み、`node:vm`でゲーム依存を置き換え、`createNativeSdk()`から上記入力を呼んだ。再利用ツールや恒久ファイルは作っていない。実装時には同じ失敗条件を既存fixtureへ組み込んで修正前後を比較する。
- レビュー時の登録済みaffected検証は全成功。記録は[summary.json](/home/akito/.local/state/codex-test-manager/runs/20261027T052127Z-0429e0c7/summary.json)。既存suiteの成功と、上記の数量不足・デフォルト食料選択の不具合が併存していた。

## 次の作業

- [ ] **公開契約と共通結果の通り道を確定する。** registry全体をaction/query、完了条件、必要な失敗情報、内部・legacy呼び出しの有無で確認する。共通結果は既存の構造化結果へ合わせ、既知の失敗分岐で原因を保持する。最初に`equip`と`collectBlock`を使い、同じ実装の結果をnativeでは構造化、内部・legacyでは明示的にbooleanへ投影できることを既存fixtureで確認する。結果を返すコアと互換境界を分け、関数ごとの`details`フラグ追加を広げない。親子callの結果・数量が混ざらず、所有contextなしの旧呼び出しも動くことが採用条件。第一候補は、コアが結果オブジェクトを返し、内部・legacyの呼び出し境界だけで`ok`のbooleanへ投影する薄いwrapperを置く方式。この2関数で採用条件を満たすか確認するまで他の関数へ広げず、採用した方式を計画へ反映してから次へ進む。
- [ ] **要求数と消費の契約を直す。** 上記3つの不足再現、全量完了、0件、不明量、途中取消を既存`targeted_sdk`・`operation_context`系fixtureで確認し、`consume`の省略・明示指定・食料なしも修正する。他の数量操作にも同じ成功判定が残っていないか確認し、今回確認した原因がある箇所を一貫して直す。`giveToPlayer`などは投げた量と相手の受領を区別する。結果の確認済み数をログ文やrequested値から作らない。
- [ ] **残る公開actionの原因を結果へ通す。** 装備、配置、接近、戦闘、道具使用、収納、場所操作などの失敗分岐を共通結果経路へ移し、対象・不足・経路失敗・未確認・取消を説明する。内部から外部への委譲で原因が消えないようにする。`nativeExecutionSafety`、`skillResults`、`sdkFailure`、task diagnosticsへ同じ結果を伝え、既存のcatch後・未await呼び出しの停止契約を維持する。「作業不要で達成済み」と「対象がなく未達」の扱いは各操作の目的から定義する。queryの通常データは停止へ変換しない。
- [ ] **公開入口と引数を整理する。** `skills.log`とnative公開の`world.isEntityType`を外し、`useToolOn`の`"nothing"`指定は`useItem`へ一本化する。ブロック検索は`getNearestBlocks({blockTypes?,predicate?,radius?,limit?})`へまとめ、`blockTypes`と`predicate`の同時指定は明示エラー、最寄り1件は`limit:1`、未発見は空配列とする。nativeのpredicateはBlock関数に絞り、数値ID指定は内部・legacyに残す。座標predicateと型検索の最適化を維持し、nativeの`getNearestBlock`・`getNearestBlocksWhere`は公開しない。`username`を`playerName`へ移行し、`dontCheat`はnative引数から外して既存host modeに従わせる。`useToolOn`の所持確認の条件式も直す。破壊/採取、通常/掘削移動、保存農場/その場の農作業の分離は維持する。削減した入口の代替例・不正な組合せ・古い引数の説明を`native_sdk` fixtureで確認する。
- [ ] **アイテム使用を一回の操作で完結させる。** `useItem`へ必要最小限の照準・使用する手・保持時間の指定を加え、正常終了と取消の両方で解除する。SDKを開始/停止の細かいメソッド群へ分けず、既存の割込可能なwaitと所有処理を再利用する。使用開始だけで命中などの効果を成功報告しない。省略時の一回使用、有限保持、装備不能、取消時解除を既存fixtureで確認する。実プロトコルで保持・解除が成立するかは下記の隔離実験で確定する。
- [ ] **呼び出し元と文書を同じ契約へそろえる。** native例、lint、遅延SDK文書、bot共通指示、READMEを更新し、内部・legacyの旧signatureは明確に区別する。既存の`native_sdk`・`targeted_sdk`・`codex_session`・`operation_context`と、影響する既存機能fixtureを使う。公開数と代替操作を確認し、今回外す4入口によって予定82→78メソッドでも機能が欠けないことを確認する。SDK文書hashとcontext protocolを更新し、旧仕様threadの一度だけの新規化、以後の再開、履歴保持を既存fixtureで確認する。未編集のeval pin/caseは変更せず、他ownerの修正が必要なら先にそちらの指示を読む。
- [ ] **検証済みsourceを手動playへ反映する。** `/home/akito/workspace/project/test-manager/bin/codex-test run --scope affected --project mindcraft`を実行し、summaryの必須offline taskを含む成功を確認する。同じsuiteを別コマンドで重複実行しない。差分と関連文書を確認し、task差分だけをown originへcommit/pushする。その後`../play/README.md`の現行手順で`../play/mindcraft-source.json`にpush済みfull SHAを選び、`python3 ../play/apply.py`を実行する。apply内の選択SHAの検証・readiness・rollbackを利用し、独自の重複照合は増やさない。停止中のbot/UIは停止を保ち、server/world、保存memory/thread/placeデータ、Ollamaを変更しない。成功・失敗、適用SHA、残る実ゲーム上の未確認点を記録する。

## 実装時に行う隔離実験と回復

- **確認する問い:** 改善した有限アイテム使用で、実サーバーへ保持・解除が届き、取消でも使用状態が残らないか。計画時のモックは実packet関数までであり、この結果は未確認。
- **方法と判断:** 既存CaseServer/隔離smoke手順を使い、loopback `25569`/`25570`の使い捨てworldで、通常の一回使用、保持後解除が必要なアイテム、保持途中の取消を各1回確認する。解除送信・サーバー側で確認できる使用効果・次操作の開始を記録する。命中まで確認していなければ命中成功とは報告しない。既存機構では観測できない効果の自動判定は実装せず、結果の保証範囲を入力/観測へ明示する。所有操作がsettleしない、解除が届かない場合はapplyへ進まず原因を直す。新しい汎用smoke runnerは追加しない。
- API変更による主要な影響先はnative実行コード、遅延文書、再開thread、内部/legacy呼び出し。全てを整合させてから一つの検証済みsourceとして反映し、旧新SDKの混在やゲーム操作の自動replayをしない。
- applyの前提不成立またはreadiness失敗は既存applyに従って中止・旧bundleへ復元する。bot停止時は停止を維持する。保存データやthreadを削除して復旧しない。計画作成中にlive操作は行わない。
