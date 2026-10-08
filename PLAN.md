# PLAN

## 目的

`fellTree` が根元の東側へ移動できないだけで終了せず、到達できる場所から選択した一本を伐採・回収する。ブロック中心が隠れていても、到達範囲内の表面に照準が届けば採掘を許可し、接近の完了判定・採掘前チェック・実際の照準を同じ幾何条件に揃える。

ユーザーの指摘を反映し、**中心の可視性を必須にする設計は採用しない**。中心遮蔽を理由に、見えている対象の手前のブロックを不要に壊さない。

## 完了条件と確認方法

- 実ブロック形状・raycast・pathfinderを使うfixtureで、根元の東側が塞がれ、西側から作業できる木を `fellTree` 一回で回収できる。`complete`、選択した原木の破壊数と実回収数が一致、足場の残留ゼロ、地上へ復帰。他の木・建築・畑のブロックを変更しない。
- 中心へのrayが遮られていても表面へのrayが対象に最初に当たる場合、`approachBlock` は実位置で `ready`、`breakBlockAt` と `fellTree` はその点を狙って採掘する。面中央も隠れる後述の端寄りのケースを含む。採掘同期wrapperで再び中心チェックに拒否されない。
- 非full-cubeのブロック／遮蔽物も、実 `shapes` への交点で判定する。射程外、対象変更、未ロード、停止時は採掘開始packetを送らない。完全遮蔽のfixtureは成功にせず、汎用接近では遮蔽物を破壊・足場を設置しない。
- 目標へ着いたという経路探索の結果だけで成功扱いしない。実際の目の位置から最新の対象へ再raycastし、照準後・採掘開始直前にも再確認する。
- `fellTree` の資材／空きslot事前確認、選木範囲、自然葉の制限、server確認、drop回収、足場台帳、停止と後始末の契約を保持する。停止後は新たなworld変更を始めず、残留物は結果に残す。
- 共通接近を使う指定チェストの観察・入出庫も確認する。照準と実際の指定チェストが一致し、近傍チェストへ置換せず、成功・失敗・停止で開いたcontainerを閉じる。
- 下記offline suiteと隔離serverでの主動作確認が通り、README／SDK説明が表面への照準に対応している。playへの反映は完了条件に含めない。

## 範囲と制約

- 実装の所有repoはこのforkの `autonomy`。共有依存を更新・編集せず、既存Mineflayer、prismarineの形状／raycast、pathfinder、採掘同期処理を再利用する。
- 着手前からある `skills.js` の `viewChest` と `tests/run-tests.cjs` の対応差分を保持し、今回のcommitに混ぜない。新helperを作る場合は、それを読むdisposable fixtureのcopy一覧も検索して更新する。
- 手動playのsource pin、bundle、server、bot、UI、Ollamaを変更しない。live確認は既存CaseServerが作る使い捨てworld copy、空いているloopback `25569` / `25570` のみ。ユーザーのworld template/saveはread-only。
- 資材不足時の調達優先ルールは既に `play/BOT_RULES.md` にある。この計画は上記二つのスキル／相互作用の問題を直す。modelの早期終了、30秒の進捗監視、全域の木探索方針は別課題。

## 根拠と残る不確実性

### playで確認した失敗

2026-10-08の調達優先実験（task `71d5364e-e4d4-437e-8138-c8b3a9b8491b`）では、`fellTree` は4回呼ばれた。2回は資材不足、資材が足りた2回は原木／足場を変更する前に `No path to the goal`。その後の個別操作で原木を回収している。詳細は [実験REPORT](../mindcraft-tools/results/procurement-first-play/20261008T115247Z-71d5364e/REPORT.md)。同じ履歴を再開した実験であり、ルール変更だけの効果を分離した測定ではない。

- [`fellTree`](src/agent/library/skills.js) は `harvestReachable` より先に `tree.root.offset(1, 0, 0)` への厳密な `GoalBlock` を要求する。初回接近の失敗は葉の処理や足場工程まで到達しない。
- `approachBlock` の `GoalLookAtBlock` は面を見られる位置を受理するが、最終判定と採掘は `bot.canSeeBlock` の中心rayを要求する。playでも対象 `(76,72,-275)` に対し接近成功後に `visible:false` / `canDig:true` を繰り返した。
- [`mining_sync.js`](src/agent/library/mining_sync.js) にも中心rayの必須チェックがあり、`fellTree` だけ直しても止まる。collectblock／pathfinder／手動採掘／farmからの `bot.dig` にも影響する。指定チェストも共通 `approachBlock` のcaller。

### 隔離した判別実験

実行環境はNode 20と既存read-only依存。`results/interaction-planning-20261008/{probe.cjs,result.json,face-probe.cjs,face-result.json}` に一時probeと結果を保存した。合成のloaded地形を使い、実prismarine形状／world raycast／pathfinder AStar／Mineflayer採掘pluginを実行した。worldやserverを操作していない。

| 判別したこと | 観測と設計への反映 |
| --- | --- |
| 東側への固定接近が必要か | 根元 `(0,64,0)`、東側 `(1,64,0)` / `(1,65,0)` に石を置くと、制限付きMovementsで東側は `noPath`、西側は `success`。東固定を撤廃する。実playの障害物を再現した証拠ではない。 |
| 中心が隠れると採掘できないか | 対象 `(0,65,0)`、石 `(-2,64,-2)`、足元 `(-2.5,64,-1.5)`。中心は不可視だがnative `dig(block,true,'raycast')` は北面に照準して開始packetを送る。同じ条件で現行同期wrapperは `Block is not visible`、packetゼロ。独自の中心制限を撤廃する。 |
| nativeの面中央候補だけで足りるか | 目 `(-2.9,65.62,-2.1)`、対象 `(0,65,0)`、石 `(-2,65,-1)`。可視面の中央は隠れるが `(0.75,65.05,0)` へのrayは北面に到達。nativeの `raycast` モードは `Block not in view`。面内の点も候補にする。 |
| 表面の交点を照準に使えるか | 一時adapterでnativeの面指定と照準点を揃えると、上記の点を狙い、同じ北面の開始packetを送れた。実際の破壊timing／stop／server確認は既存pluginへ任せる設計を候補にする。 |

native採掘probeの通信先はfixtureで、air確認も模擬している。**実serverがこの照準・面で採掘を受理するかは未検証**。実装の最初の確認として隔離CaseServer copyで中心遮蔽／端寄りの二ケースを直接実行し、server airを確認する。受理されなければadapterの照準／面を修正し、同期確認を弱めて通さない。

`tree_felling.test.cjs`、`targeted_sdk.test.cjs`、`mining_sync.test.cjs` は現状でも成功した。既存tree fixtureは任意GoalBlockへ移動できるmockのため、この初回接近失敗を検出しない。今回の回帰は実形状と実経路探索を含める。

## 実装方針

1. **表面への照準を一か所で決める。** 小さな内部helperを設け、最新block、目の座標、到達範囲から、照準点・交差面・交点距離を返す。`block.shapes` の外側の面に対して中央、端寄り、面内候補を試し、既存world raycastの最初のhitが指定blockである場合だけ採用する。中心rayの可否は採掘の許可条件にしない。候補数／細分化上限／探索時間は名前付き定数にし、経路探索中も有限にする。有限samplingで見つからなかったことを「全面が見えない」証拠と呼ばず、理由は照準点未発見とする。極細の隙間で未発見の場合は別の到達位置を有限に探す。全pixelの可視性を網羅する幾何solverは追加しない。
2. **接近と実操作に同じhelperを使う。** `GoalLookAtBlock` の既存heuristicを再利用したinteraction goalは、仮の足元／目からhelperで判定する。実到着時は実entity positionとeyeHeightで再判定する。SDKの到達範囲4.5と `canDigBlock` の制約を保ち、交点までの距離で操作可否を決める。採掘同期wrapperの中心チェックを置換し、既存の限定的なlookAt adapterへ照準点を渡し、nativeの面指定を交差面に揃える。照準後のfresh target／rayを開始packet前に確認する。`forceLook:'ignore'` は現在の照準rayを検証し、見えている別の点だけを理由に通さない。legacy callerのrange／forceLook／digFaceを調べて、全callerの射程を不用意に広げたり新たに一律で縮めたりしない。形状を持たない草等はnativeの既存扱いを調べ、別途fixtureで互換を確かめる。
3. **観察と実際の照準を揃える。** `world.inspectBlockAt` の既存 `visible` と中心距離 `interactionDistance` は互換のため保持し、表面への照準結果を追加する。中心不可視でも `ready` になり得ること、raycast不可／未ロードと候補未発見の違いをSDK説明に示す。`breakBlockAt`／tree内の採掘・足場回収・drop支持葉処理を中心チェックから移す。指定チェストについては `openContainer` の既存照準／activate APIまで確認し、接近後に再び中心だけを向いて失敗しないよう同じ点を使用する。
4. **木の初回接近を作業可能性で選ぶ。** 資材等のpreflight後、現在位置から見える選択木の原木を先に処理する。表面に照準が届くなら `clearRay` で手前の葉を壊さない。届かない場合だけ、選択木の原木／既存の範囲内の同種自然葉に限定して安全に視界を開ける。接近が必要なら選択原木へのinteraction goalを使う。手前の自然葉もまずそこへ接近して処理できるようにし、変更後に原木の観察・経路を更新する。一般blockを経路開拓のために破壊しない。候補と前回の状態を記録し、同じ障害を無限に再試行しない。原因不明の `NoPath` は障害物を推定で断定せず、対象・試した作業／接近先・観測したray阻害・経路statusをreasonに残す。足場の基点へ立つ工程の厳密な `GoalBlock` は必要なので保持する。

## 次の作業

- [ ] 共通の照準helperと限定adapterを実装し、中心遮蔽・面中央遮蔽・非full-cube・完全遮蔽・範囲・unknown・対象変更・停止を実形状／native dig fixtureで確認する。隔離serverの二ケースでserver airまで確認して採掘方式を確定する。探索候補の上限で既存経路探索がtimeoutしないことも確認し、問題があれば候補生成／探索方法を修正する。
- [ ] `approachBlock`、採掘同期、個別採掘、観察、指定チェストのcallerを接続し、既存SDK／container／採掘同期の契約を確認する。helper依存のfixture copy一覧を更新する。
- [ ] `fellTree` の初回接近と視界処理を変更し、東側閉塞・自然葉の先行処理・不許可障害物を回帰確認する。既存一本伐採・枝・足場回収・中止testsを維持する。隔離serverで一回の `fellTree` の実回収／足場残留／接地／周囲の不変を観察する。
- [ ] README、world/skillsのAPI説明、native SDK説明を更新し、Node 20でfull offline suiteと `git diff --check` を実行する。今回の差分だけを見直し、own originの `autonomy` にcommit/pushしてremote SHAを確認する。失敗時はsource修正を止めて原因を調べ、未達の条件を弱めない。playは変更しない。

検証コマンド（repo rootから。新しいfocused testを作る場合もfull suiteへ接続する）:

```bash
MC_VERIFY_NODE=/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node
"$MC_VERIFY_NODE" tests/mining_sync.test.cjs
"$MC_VERIFY_NODE" tests/targeted_sdk.test.cjs
"$MC_VERIFY_NODE" tests/tree_felling.test.cjs
"$MC_VERIFY_NODE" tests/chest_transfer.test.cjs
"$MC_VERIFY_NODE" tests/run-tests.cjs
git diff --check
```

計画時のprobe再実行は同じNodeで `results/interaction-planning-20261008/face-probe.cjs`。先行probeに含まれる「中心可視に揃えるtrial」は判別用の記録であり、採用案ではない。

## 後続

play反映と同一指示での再実験は、source検証・push後に明示依頼された場合に行う。その際は `mindcraft-tools` / evalのmanifest・bundle手順に従い、従前のsource pinとbundleをrollback先として保持する。この計画だけでbot切替や稼働world変更は行わない。
