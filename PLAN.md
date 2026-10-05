# 向きを指定したブロック設置

Goal: 「かまどを北向きに置く」「原木を横向きに置く」「西向きの逆さ階段を置く」と指示すると、botが設置位置・クリック面・姿勢を選び、サーバーで観測した状態が指定に一致した場合だけ成功を返す。

2026-10-06時点の設計。実装・実ゲーム検証・manual playへの反映は未実施。

## 受け入れ条件と確認方法

- 通常のsurvival設置で、かまど・チェスト・階段の水平4方向、原木の3軸、階段とハーフブロックの上下、壁付けたいまつ・はしごの4方向を指定できる。隔離Minecraft 1.21.1で直接skillを呼び、全指定の `name` と `getProperties()` をRCONのblock state観測と照合する。
- レバー・ボタンは壁/床/天井と水平向き、リピーター・コンパレーターは水平向き、ドア・ベッドは水平向きと両方のブロック、オブザーバー・ピストン・ディスペンサー・ドロッパーは6方向を扱う。後述の実験で設置規則を確定し、検証できた種別だけ対応表へ登録する。未登録を成功扱いしない。
- 明示した状態を満たせない条件では、別の向きへ妥協せず理由と観測値を報告する。指定不正、支持面なし、到達不能、同じ種類だが向き違い、chunk未観測、server拒否、更新timeout、停止をfixtureで確認する。
- 指定どおりの既存ブロックなら、在庫消費・設置packetなしで `true`。同種の向き違い/別種の占有では `false`、既存ブロックを壊さない。
- generated codeとliteral commandから同じ処理を利用でき、向きの不一致/未確認をモデルへ渡す。JSDocの選択、SESを通るoptions、command解析とoperation resultのfixtureで確認する。
- 従来の位置引数、文字列 `placeOn`、第7引数 `dontCheat` を使う呼び出しは互換を保つ。既存offline suiteを通す。
- cheat設置も同じ要求状態と確認条件を使い、`/setblock` の送信だけで成功を返さない。通常経路の代わりにcheatへ切り替える処理は追加しない。

## 境界

- source ownerはこのrepoの `autonomy` branch。共有dependencyの更新・編集、新依存、新serviceは不要。
- 現在の未コミット変更は `skills.js`、`modes.js`、`recovery_replanning.test.cjs`、`run-tests.cjs`。実装時に差分を読み直し、他作業の変更を巻き戻したり混ぜてcommitしない。
- 設計段階は文書とread-onlyのoffline実験のみ。稼働play/server/world/Ollama、source pin、bundle、UIを変更しない。
- 実装時の実ゲーム検証は既存CaseServerのdisposable copy、loopback 25569/25570を使う。ユーザーtemplate/worldと共有dependencyはread-only、25566は使わない。検証の入口/手順/結果はowner repoへ記録する。
- 配置失敗後の自動破壊、在庫を持つ既存ブロックの置換、無限retryは設計に含めない。修正はモデルが観測結果を読み、別の明示操作として判断する。

## 確認できた現状

- source HEADは `d3a4cf83a4ad4c545c37d09d1645b49db6e5b939`。manual manifestも同SHAを指定しているが、checkoutには上記の未コミット変更がある。
- [placeBlock](src/agent/library/skills.js) は `placeBlock(bot, blockType, x, y, z, placeOn='bottom', dontCheat=false)`。通常経路は指定された側の隣接ブロックを優先し、他の側へfallbackする。占有時は既存ブロックを掘り、同種なら向きを確認せず `false`。支持ブロックを見た後に `bot.placeBlock` を呼ぶ。
- cheat経路は一部のblock種にだけ `facing` を組み立て、ドア上半分/ベッド頭部を固定offsetで置く。これは新しい明示指定の経路へ流用しない。
- [actions.js](src/agent/commands/actions.js) の `!placeHere` は種類のみ。command parserは固定引数数で文字列/数値/booleanを受け、objectや任意のoptional引数は扱わない。
- [skill_library.js](src/agent/library/skill_library.js) は `skills.placeBlock` のJSDocを常時提示する。[library/index.js](src/agent/library/index.js) はfunction内のJSDocを取り出す。[coder.js](src/agent/coder.js) の既存SDKは引数を渡せるため、新しい権限やraw plugin公開は不要。
- [operation_context.js](src/agent/library/operation_context.js) の `trackSkill`、`recordConfirmation`、`recordUncertainty`、owned waitと既存action cancellationを再利用する。新しい結果ledgerは作らない。
- ローカルdependency inputは `../mindcraft-eval/runtime/upstream/node_modules/`。確認した版はMineflayer 4.39.0、pathfinder 2.4.5、minecraft-data 3.117.0。上流資料は [placement API](https://github.com/PrismarineJS/mineflayer/blob/master/docs/api.md#botplaceblockreferenceblock-facevector)、[generic placement](https://github.com/PrismarineJS/mineflayer/blob/master/lib/plugins/generic_place.js)、[GoalPlaceBlock](https://github.com/PrismarineJS/mineflayer-pathfinder/blob/master/lib/goals.js)。判断はローカル実装を優先する。

### 実施したoffline実験

共有dependency directoryをcwdに、`node` のstdin scriptで実際のmoduleを呼び出した。network/server接続、world変更、ファイル作成はなし。

1. 仮説: `GoalPlaceBlock(..., {facing})` の名前がクリック点への実際の視線と一致する。
   - 方法: `world.getBlock=()=>null` でgoalを作り、6個の単位方向ベクトルを `goal.checkFacing` へ渡す。
   - 結果: `north` は南向きベクトル、`east` は西、`south` は北、`west` は東を許可。`up/down` は同方向。
   - 決定: 水平の反転をローカルadapterで吸収する。公開APIの `facing` はblock stateの意味を守り、pathfinderの値を利用者へ露出しない。
2. 仮説: Mineflayerの既存pluginでクリック位置の上下指定と自動look抑制を扱える。
   - 方法: `generic_place` をmock botにinjectし、`_client.write` をメモリへ記録。南面に `half:'top', forceLook:'ignore'` と `half:'bottom'` を順に渡す。
   - 結果: 両方 `direction=3`。`cursorY` は0.75/0.25、look呼出は後者のみ。
   - 決定: pluginを再実装しない。private APIへの依存は一つのadapterへ閉じ込める。これはpacket生成の確認であり、serverの設置規則や姿勢の送信完了を証明しない。
3. minecraft-data('1.21.1')のstate一覧を照会した。
   - 階段は `facing/half/shape`、slabの上下は `half` でなく `type`、原木は `axis`、壁たいまつ/はしごは `facing`、lever/buttonは `face/facing`、6方向blockは6値の `facing` を持つ。torch自体にはstateがない。ドアは `half/hinge`、ベッドは `part` を持つ。
   - 決定: block registryで値の存在は検証できるが、同じstate名から同じ設置操作を推測しない。設置規則は小さな種別表で管理する。

実験対象のSHA-256:

| dependency内のファイル | SHA-256 |
|---|---|
| `mineflayer/lib/plugins/place_block.js` | `6d9941df1725432adb12c3a439de4806077c134e569b3af78a80882bd2737d1b` |
| `mineflayer/lib/plugins/generic_place.js` | `cadaeca976c9da54d7d02432f5ea0cd1269845e8bc2bd2fdc6f1d7bfdd024a4d` |
| `mineflayer-pathfinder/lib/goals.js` | `9679be36c66fe267de988e96fe3de072ea865432e84795db51b75622a2454fce` |

## 公開API

既存 `placeBlock` の第6引数へoptions objectを追加する。文字列なら従来経路、objectなら下記の明示指定経路を使う。第7引数 `dontCheat` は両方で従来どおり有効とし、objectに同じ設定を重複させない。

```js
await skills.placeBlock(bot, 'furnace', x, y, z, { facing: 'north' });
await skills.placeBlock(bot, 'oak_log', x, y, z, { axis: 'x' });
await skills.placeBlock(bot, 'oak_stairs', x, y, z, {
    facing: 'west', half: 'top'
});
await skills.placeBlock(bot, 'torch', x, y, z, {
    attachTo: 'north', facing: 'south'
});
```

| option | 意味 |
|---|---|
| `facing` | 設置後のMinecraft block state `facing`。水平4方向、6方向対応blockだけ `up/down` も可 |
| `axis` | 原木等の長軸 `x/y/z`。`x`=東西、`y`=上下、`z`=南北 |
| `half` | 階段/slabの上半分 `top` または下半分 `bottom`。slabではstate `type` へ変換 |
| `attachTo` | 設置座標から見た支持ブロックの側。`bottom/top/north/south/east/west`。明示時は必須条件で、別の側へfallbackしない |

方位はワールド座標で `north=-Z`、`south=+Z`、`east=+X`、`west=-X`。`facing` はbotの視線ではない。blockの「正面」の意味は種別によるため、オブザーバー等はstateの意味をJSDocへ例示する。相対指示はモデルが現在の観測から世界方位へ変換する。向きの曖昧さは既存の対話で確認する。

- object経路は方向なしの `{}` も厳密な設置として扱う。未知key、無効値、非finite座標、未対応property/block種、`axis` と `facing` など非対応組合せはworld mutation前にrejectする。
- 必須なのは指定されたpropertyだけ。階段の `shape` や `waterlogged` 等の未指定stateは成功判定に含めない。必要な既定値は種別表へ明記し、勝手に要求stateを増やさない。
- registryで可能なstate/値を検証し、種別表で通常設置可能な指定を検証する。`blockType='oak_stairs[facing=north]'` のような文字列は新APIでは受けない。
- `torch` 等は在庫itemと設置結果blockを分けて正規化する。壁設置ならexpected blockは `wall_torch`。`attachTo` と `facing` が両立しない場合は事前に失敗する。
- 戻り値は従来と同じboolean。既存状態を満たすno-opと新規設置をログ/operation resultで区別する。

literal入口として `!placeBlockFacing(type, x, y, z, facing)` を追加し、object APIへ委譲する。固定5引数で既存command parserを利用する。axis/half/複合指定は自然言語からgenerated codeを利用する。`!placeHere` の引数数を変更しない。

## 内部構成と設置手順

`src/agent/library/block_placement.js` にoptions正規化、対応種別表、要求state照合、支持面/視線変換、private plugin adapterをまとめる。`skills.js` はobjectを検出してこの処理へ委譲し、既存のpublic trackingを通す。汎用strategy/plugin frameworkは作らない。

種別表には在庫item/結果block、対応property、設置規則、複数blockのoffset/確認条件を持たせる。材質別の同一規則は既存registryの名前/state情報を使ってまとめるが、未検証のblockを `facing` があるだけで対応扱いしない。

| 種別 | 操作を決める要素 |
|---|---|
| かまど・チェスト・リピーター等 | blockごとの水平視線との対応、床支持、チェストの結合条件 |
| 階段・slab | 水平視線（階段）、クリック面/位置による上下。`half` のstate変換 |
| 原木 | 支持ブロックのクリック面の軸 |
| 壁たいまつ・はしご | 支持面とblock facingの対応、在庫item/結果blockの差 |
| ボタン・レバー | 壁/床/天井の支持面、必要な水平視線 |
| オブザーバー・ピストン等 | 6方向の視線/相対位置。水平種別との反転差を実測 |
| ドア・ベッド | 向きに加え、上半分/頭部の空き・支持・両blockの整合性 |

1. **事前観測**: options、registry、種別表を検証し、対象と必要な周囲blockを読む。すでに要求どおりならno-op成功。未観測/占有/方向違いは失敗。多blockでは全占有領域を先に確認する。在庫やblock entity dataを壊して調整しない。
2. **候補決定**: 対応規則から支持面・クリック点・必要な視線/相対位置を決める。`GoalPlaceBlock` のfaces/half/LOSを再利用し、水平反転はadapter内で補正する。候補は最大6隣接面、有限の順序で調べる。pathfinderの `faces` が「targetから支持blockへ」、MineflayerのfaceVectorがその逆であることを統一する。
3. **移動**: 既存 `goToGoal` とnavigation進捗/停止処理を利用する。この配置用Movementsは `canDig=false`、`allow1by1towers=false`、scaffolding無効とし、立ち位置探しでworldを改変しない。複数blockの占有領域も避ける。
4. **送信直前の再確認**: 移動で観測状態が変わるので、対象・支持・両blockの空き・在庫・停止状態を再確認し、goalを必要に応じて再作成する。実際のeyeHeightからLOS/クリック点/規則を確認する。container等を支持に使う場合はsneakが必要で、変更したcontrolだけを所有action内で復元する。sneak時のeyeHeightで候補を再評価し、成立しなければ送信しない。
5. **配置**: block update listenerを送信前に登録する。既存 `_placeBlockWithOptions` を一つのadapterから呼び、クリック位置 `delta` を渡す。視線は通常のlook完了を待つ経路を優先し、`forceLook:true` の即時resolveをserver姿勢確定と見なさない。`forceLook:'ignore'` は事前に姿勢送信が確認できる必要ケースに限り実験後に採用する。raw packet writerを作らない。
6. **確認**: server更新後の `name` と指定propertyを比較する。多blockは全座標で対応する `half/part/facing` を確認する。plugin resolve/throwだけで結論を決めず、即時updateも取り逃さず、実際の状態を判断する。timeout/中断時にnullをair扱いしない。
7. **結果と後片付け**: 新規一致には要求/観測stateと座標を `recordConfirmation`、不一致/更新不明には要求/実測値/理由を `recordUncertainty` へ渡す。no-opは「既存状態が一致」と報告し、新しく置いた数量へ加算しない。誤向きのblockが残った場合はその事実も返す。停止後の再送や自動置き直しは行わない。

確認待ちはnamed constantで上限を定め、既存plugin内の5秒待ちとの整合を取る。listener/timerはfinallyで解除し、plugin promiseは所有actionのsettlementまで追跡する。停止要求だけで未完了のpacket/待ちが消えた扱いにしない。終了時はそのactionが変更したcontrolとMovementsを復元し、後続actionの設定を上書きしない。

同一bot内は既存の直列SDK実行を使う。他bot/playerとの競合は送信前の観測とserver結果で検出し、world lockや別の調停serviceは追加しない。成功は確認時点の観測を意味し、後から他者が変更しない保証はしない。

## cheat経路

object経路では同じ正規化済み要求から、安全なregistry由来のblock名/state値だけで `/setblock` を組み立てる。サーバーが置いた結果を通常経路と同じpredicateで確認する。既存ブロックを上書きしない契約には `keep` と事前観測を使う。

ドア上半分/ベッド頭部のoffsetは向きから計算し、両blockの確認が必要。途中まで置けた失敗は部分成功の観測を返し、自動で既存blockを巻き戻さない。向き指定なしの旧cheat経路の変更は、この機能に必要な互換修正以外へ広げない。

## 実装前に残す実ゲーム実験

offline実験だけでは、serverの設置規則・視線送信順序・複数blockを証明できない。設計だけの今回は保留し、実装時の最初の作業とする。以下が決まる前に種別表を実装しきらない。

- **方法**: 既存CaseServer copyに足場と在庫を隔離fixtureとして準備する。直接Mineflayer pluginを呼び、item、支持座標/クリック面、cursor、bot位置/eyeHeight/視線、結果block stateを記録。RCONで最終stateを独立照合する。case間はそのdisposable world内だけをリセットする。
- **識別する問い**: 水平4方向のblockとbot視線の対応、6方向blockの向き反転と位置条件、階段/slabの上下指定、原木の軸、壁/床/天井のlever/button、インタラクティブな支持へのsneak、隣接チェストの結合、ドア/ベッドの向き別offset。
- **決定基準**: 通常survivalで要求stateを生成でき、wrong stateを確実に検出できる操作を種別表へ採用する。`GoalPlaceBlock` で足りない6方向の位置条件等は、既存goalに局所的なpredicateを足す。専用の別pathfinderは作らない。
- **成立しない場合**: 該当種別と必要条件を明記し、その依存作業だけを保留する。userの要求状態を緩めて成功にしない。通常設置の不足をcheatで隠さない。

## 次の作業

- [ ] 隔離実験で上記の設置規則を確定し、対応表と期待値をPLANへ反映する。最初の水平/軸/上下/壁付けケースが成立してから実装へ進む。
- [ ] object APIとblock placement helperを実装する。方向・支持面・block/itemの変換、事前検証、占有/no-op、server確認、停止/timeout/cleanupをfocused fixtureで確認する。private plugin adapterも実際のdependencyを使って確認する。
- [ ] literal command、JSDoc、generated code/SES、operation resultへ接続する。新commandの失敗が単なるexecutor成功として報告されないこと、指定optionsがモデルとSDKに届くことを確認する。
- [ ] 検証済みの規則に基づいて多block/6方向/lever等とcheat経路を完成させ、部分配置と不一致の観測を確認する。対応表に未検証項目を対応済みと書かない。
- [ ] Node 20で `tests/run-tests.cjs`、関連fixture、syntax、`git diff --check` を実行する。隔離実ゲームで受け入れ条件を照合し、必要な通常callerのcrafting table/furnace/torchに互換破壊がないことを確認する。
- [ ] READMEへ利用例・対応表・制限・検証範囲を追加し、検証手順/commandが増えた場合はAGENTSも更新する。全差分を確認し、task変更のみown originのautonomyへcommit/pushする。新規helperを既存disposable fixtureへコピーするsetupも更新する。

## 今回の対象外と反映条件

- 自動で既存建築を回転する機能、階段shape/ドアhinge/チェスト結合の明示指定、rail形状、看板の16段階rotation、建築blueprint全体の回転は別の要求として扱う。未対応指定は実行前に明示errorとする。
- sourceの設計/実装完了だけでは稼働playへ反映されない。将来の反映ではpushed SHAをevalで検証し、manual pinの選択とbot-only切替を明示依頼の範囲で実施する。rollbackは保存済みの旧bundle/pinを使い、Minecraft worldは操作しない。
