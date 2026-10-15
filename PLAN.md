# PLAN

Goal: The Codex agent in the user's desktop chat can assign tasks to selected existing Minecraft bots, continue other work while those bots run, collect their progress/results, and cancel only the assigned tasks.

Scope: Design only, as explicitly requested. The caller is desktop Codex, not another Minecraft bot. [Design review and evidence](docs/desktop-bot-subagent-design-review-20261013.md).

## Architecture and choices

```text
Desktop Codex -> local task adapter -> MindServer operator task API
                                      -> selected bot's existing CodexRuntime
              <- task handle / progress / terminal outcome <-
```

- Reuse each bot's own model, game connection, SDK, instructions and saved context. Do not start a second controller or a new reasoning model for the same bot. Pass a bounded subgoal, constraints and acceptance criteria rather than the desktop's full coding transcript.
- Add a small asynchronous operator task API in `mindcraft/`. The local adapter and isolated integration checks belong to `mindcraft-tools/`; live configuration/data stay in `play/`. Preserve the unrelated existing `mindcraft-tools/PLAN.md`.
- Prefer a local stdio MCP adapter to expose the operations directly as desktop tools, subject to a disposable compatibility check and the tools repo's no-new-dependency constraint. If a suitable existing implementation is unavailable, use a local CLI plus skill over the same API. Select one entry implementation after that check; do not build both initially. Neither adds a listening port or a system service.
- Standard custom Codex agents configure newly spawned sessions. No documented registration setting was found for attaching an existing bot to native `agents.spawn_agent`. This design provides external worker lifecycle tools; native subagent UI integration is not an acceptance criterion. An extra Codex agent that merely relays to the bot is unnecessary.
- Preserve the configured management mode. Desktop operator access can use `legacy`; `protected` uses the existing operator credentials through the adapter without placing them in tool arguments, model context or logs. Protected-only native bot peer messaging is not used by this design.

## Task contract

Proposed operations (names and exact schemas may be adjusted during implementation):

| Operation | Purpose |
| --- | --- |
| `list_bots()` | Read bot identity, connected/runtime status, idle/busy/unknown state and world scope. Availability is advisory until admission. |
| `start_task({bot, requestId, objective, constraints, acceptanceCriteria})` | Select exactly one existing bot and return its task handle promptly after atomic admission. Reject busy/offline/unsupported targets. |
| `read_task({handle, afterCursor})` | Read compact progress and the retained terminal outcome for this exact task. |
| `wait_tasks({handles, afterCursors, waitMs})` | Bounded wait for progress or terminal state across several bots; return the latest snapshot on wait timeout. |
| `cancel_task({handle})` | Request stop of this exact task and return its stop status. Never cancel by bot name alone. |

- The adapter resolves the intended run from canonical `play/config.json`, the active bundle pointer and runtime metadata; the hub reports its generation/world/runtime identity. A handle binds request/task IDs, bot name and the hub/agent runtime incarnation. Never select a plausible service just by port or bot name.
- Task acceptance is authoritative in the receiving Agent process. Idle check, reservation and intent assignment share an admission boundary with normal operator messages. Release that boundary after assigning the runtime owner, before awaiting gameplay; user Stop and superseding input must remain responsive during a long task. The hub keeps correlation records, rather than maintaining a second independent authoritative task scheduler.
- Operator task input is plain task data: its `bot` field is the target. Bypass chat mention routing and literal command parsing for this API. Preserve existing management, shutdown, inventory and owned-action guards.
- At most one active external task per bot; several different bots may run concurrently. Ordinary explicit user input may supersede a task through existing intent rules, and that task becomes cancelled/superseded. API submission itself cannot displace an existing task.
- Retried `requestId` returns the same request/outcome within the same hub incarnation; a changed payload with the same ID is rejected. Missing ACK means acceptance is unknown until queried, not that execution failed. Do not create a new ID or replay game changes automatically.
- Separate admission, execution (`accepted`, `running`, `stopping`, `finished`, `error`, `cancelled`, `unknown`) and operation settlement. Publish the terminal result from the exact `CodexRuntime.terminalOutcome` after cleanup; return the final report, scope/times, bounded diagnostics/observations and save status.
- A final report does not prove gameplay success. Desktop Codex supplies a concrete subgoal and constraints, partitions work across bots, and evaluates returned evidence against the requested outcome. Prose constraints are not a new host-enforced edit boundary.
- A finite tool wait expires only the wait. Game task duration follows existing configured task limits; stopping is explicit or due to a task deadline if one is configured. Closing a transient adapter connection does not create an implicit stop or replay. The caller cancels its remaining jobs when abandoning the gameplay goal, and reports any job deliberately left running.
- Cancellation compares handle/task/runtime ownership inside the admission boundary. A stale handle returns `superseded` or `unknown` without stopping the replacement task. Keep `stopping` until the owned action settles; disconnect/stop failure stays `unknown` and blocks new API admission until the current runtime state is reconciled.
- Retain bounded task results so missed completion events can be queried. Use existing traces/diagnostics as evidence; do not introduce a durable cross-process job scheduler or exactly-once guarantee across restart. A hub restart invalidates old handles and never restarts their work. Report retention limits and lost history explicitly.
- Keep commentary/results correlated with the task. Do not use a public chat message, generic `bot-output`, or an idle snapshot as the completion signal. Retain current bot report/history behavior for ordinary requests. Bounded waits are the notification mechanism; automatic wakeup of an idle desktop chat is not assumed.

## Acceptance criteria and verification

- In an isolated integration, desktop Codex can discover the selected entry, submit a task to Bot2, receive a handle, do other work, and then retrieve Bot2's actual terminal report. No additional coordinator model is started.
- Two bots can accept independent read-only tasks concurrently. A second request for the same busy bot is rejected without cancelling its existing task.
- Fixtures exercise admission racing with a UI/operator instruction, prompt mentions/command-like text, duplicate IDs with same/different payload, lost ACK/completion, task-scoped cancellation racing with replacement, disconnect/stop failure, and old handles across runtime/hub replacement.
- Wait timeout does not stop a bot. Failed cancellation does not claim settlement or free an unknown running target. Returned task status remains distinct from gameplay success and persistence success.
- Verify the complete entry-to-existing-CodexRuntime-to-result path with two bots on an existing isolated server copy at approved loopback ports. Do not infer real integration or collaboration quality from fake app-server fixtures alone.
- Run required source tests and affected tools checks after implementation, review the full task diff, and commit/push only task-owned changes to owned origins. No test/deploy is part of this design review.

## Evidence and deferred experiment

- [`src/mindcraft/mindserver.js`](src/mindcraft/mindserver.js) accepts operator/legacy `send-message` calls and task-ID acceptance ACKs. It parses mentions in the message, can override the supplied target, and exposes no correlated terminal-result/cancellation API.
- [`src/agent/agent.js`](src/agent/agent.js) cancels the old native runtime when accepting a new operator intent. A separate idle snapshot does not make this safe for external worker admission.
- [`src/agent/codex_runtime.js`](src/agent/codex_runtime.js) owns the task and exposes `terminalOutcome` after cleanup with operation settlement and trace/save status. [`src/agent/library/full_state.js`](src/agent/library/full_state.js) exposes advisory idle state, not task outcomes.
- Current `play/config.json` selects native Codex and legacy management. This review did not verify live connections or change that selection.
- [Official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp) describes local stdio tools and bounded tool timeouts; [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents) describes new custom agent sessions, not external bot attachment.
- Deferred entry experiment: inspect maintained MCP support already available on this host, then use a disposable fake-task stdio adapter and a scoped disposable Codex configuration to confirm discovery, quick start, bounded wait and reconnection behavior. Adopt MCP only if the desktop host can use it within current dependency constraints; otherwise choose CLI plus skill. Do not alter persistent Codex configuration during the experiment. Detailed entry packaging follows that result.

## Constraints and next actions

- User authorization currently covers design only. No implementation, live messages, configuration registration, bot activation or management-mode change now.
- Preserve all unrelated worktree changes and plans. The server/world, Ollama, memories and saved threads are outside the feature's ordinary update scope.
- [ ] When implementation is requested, resolve the entry experiment, then implement the shared task admission/result/cancellation contract and one adapter.
- [ ] Verify the isolated complete workflow and required suites; document actual tool entry/limits and commit/push task changes.
- [ ] For source changes covered by the parent folder's standing instruction, perform verified bot-only apply after commit/push using the existing readiness/rollback procedure. Preserve the selected management mode and verify server/Ollama identity continuity. Desktop entry registration must use verified host configuration and activation conditions.

---

## native SDKの公開面整理 — 2026-10-16（設計のみ）

Goal: 日常・専門の目的をそのまま呼べるnative SDKを保ち、同じ観測の派生名と重複出力だけを整理する。専門機能をnativeから外す従前の46件案は撤回する。件数を目標にせず、意味のある引数が少なく自然に使えることを優先する。以下は未実装の設計で、上のdesktop-bot計画とは独立している。

### 根拠と残す境界

- 機能source `bc18f93c7e032898850bc771030bfa204ceaf345`（現在HEAD `29b553cc067b9434db9a4c269d8ffd3d61383ddf` はその後の文書変更）の [`native_sdk.js`](src/agent/library/native_sdk.js) は82件。内訳はskills 43 / world 21 / places 13 / vision 3 / diagnostics 1 / communication 1。名前一覧・deferred docs・facade・lint・完了metadataの正本は同じregistryのままにする。
- 専門性は非公開にする理由ではない。取引、炉内回収、縦掘り、任意entityからの退避、職業/biome/製作候補、home/alias割当を通常の公開SDKに残す。hidden advanced一覧、追加discovery tool、module loader、mode/action unionは作らない。説明は現行どおり必要なmethodだけ遅延読込する。
- [`skills.js`](src/agent/library/skills.js) の `wait` は取消可能な有限待機、`stay` はmodeとGoalsに意味のある行動で、置換できない。`approachBlock` は操作面を確保する目的、nearest移動はminDistance付き立位選択であり、目的座標を算術で選ぶ代替にしない。`isClearPath` は編集なしの経路照会で、移動実行と違う。これらはすべて公開に残す。ただし破壊・収納等の通常skillの前に重複して呼ばせない。
- [`world.js`](src/agent/library/world.js) の `getBlockAtOffset` はメソッドを持つBlock/null、`inspectBlockAt` は時刻・loaded・操作面を持つ観測object。両者を同一視しない。surrounding/頭上照会も用途が明確な入口として残す。`vision.lookAtBlock` のloaded解決・中心照準と `lookAtPlayer` のat/withも、callerの手動確認・照準計算へ戻さない。
- [`places.js`](src/agent/places.js) の現在地点・実物観測・伝聞は登録根拠が異なる。inspectは保存snapshotの読取、verifyは再観測と永続record更新、resolveAliasは移動なしの解決である。自動再観測やID/aliasを兼用する新引数へまとめず、現在の13入口と信頼区分を維持する。source:user/unverifiedを観測事実なしに昇格させない。
- 地形保全の `goToPosition` と経路編集の `reachPosition`、各skillの固定経路方針、コンパクトな結果、数量のserver確認、部分完了、取消・owner・inventory gateを保つ。native navigationはdoor自動開放を抑止しているため `useDoor` も残す。内部で使うというだけで公開目的を取り去らない。

### 全82件の対応

**現行名で継続公開する74件**。後述するblock検索・entity観測の整理以外、名前・引数・既定値・戻り値・確認強度を維持する。取引等もregistry、実facade、lint、deferred doc toolに存在する通常のpublic methodとする。

```text
skills.craftItem skills.wait skills.smeltItem skills.clearNearestFurnace
skills.attackNearest skills.attackEntity skills.defendSelf skills.collectBlock
skills.pickupNearbyItems skills.breakBlockAt skills.approachBlock skills.inspectChest
skills.placeBlock skills.equip skills.discard skills.putInChest
skills.takeFromChest skills.consume skills.giveToPlayer skills.goToPosition
skills.reachPosition skills.goToNearestBlock skills.goToNearestEntity skills.goToPlayer
skills.followPlayer skills.moveAway skills.moveAwayFromEntity skills.avoidEnemies
skills.stay skills.useDoor skills.goToBed skills.tillAndSow
skills.activateNearestBlock skills.showVillagerTrades skills.tradeWithVillager skills.digDown
skills.goToSurface skills.useToolOn skills.useToolOnBlock skills.useItem
skills.tendNearbyFarm skills.fellTree
world.inspectBlockAt world.getNearestFreeSpace world.getBlockAtOffset world.getSurroundingBlocks
world.getFirstBlockAboveHead world.getNearestBlocks world.getNearbyEntities world.getVillagerProfession
world.getInventoryCounts world.getCraftableItems world.getPosition world.getBiomeName
world.isEntityType world.isClearPath
places.find places.inspect places.verify places.setHome
places.goTo places.resolveAlias places.goToAlias places.rememberHere
places.rememberObservedAt places.rememberReported places.setOutputStorage places.setAlias
places.tendFarm
vision.lookAtPlayer vision.lookAtPosition vision.lookAtBlock
diagnostics.lastTask
communication.sendToBot
```

**公開名だけを統合する8件**。内部/legacy/chatの関数は削除しない。新method名は追加しない。

| 現行名 | 公開SDKでの代替・維持する意味 |
| --- | --- |
| `skills.log` | 既存の出力helper `log(bot, message)`。同じoperation outputへ書く入口を1つにする。 |
| `world.getNearestBlocksWhere` | `world.getNearestBlocks({predicate, radius?, limit?})`。座標付きBlockのfunction、numeric ID、ID配列を既存同様に扱う。 |
| `world.getNearestBlock` | `world.getNearestBlocks({blockTypes:[name], radius, limit:1})[0] ?? null`。単体Block/nullと最寄り選択を保持。 |
| `world.getNearestEntityWhere` | 距離順 `world.getNearbyEntities({radius}).find(predicate) ?? null`。任意predicateで最寄りの1体を選べる。 |
| `world.getNearbyPlayers` | `world.getNearbyEntities({radius}).filter(e => e.type === 'player')`。自分以外のloaded playerを距離順に得る。 |
| `world.getNearbyEntityTypes` | 近傍entity配列のnameをmap/Setで重複除去する。 |
| `world.getNearbyPlayerNames` | 上のplayer配列のusernameをmap/Setで重複除去する。 |
| `world.getNearbyBlockTypes` | 近傍block配列のnameをmap/Setで重複除去する。 |

集計は **82→74件**（skills 42 / world 14 / places 13 / vision 3 / diagnostics 1 / communication 1）。全82件は継続公開74件と統合8件に重複なく対応し、専門機能の除外・内部化はない。これは設計の集計であり、実装時の自然な使用に必要な調整を妨げる上限ではない。

### 統合部分だけの仕様

1. **block検索。** `getNearestBlocks({blockTypes?, predicate?, radius?, limit?})` のpredicateは現在のblockPredicate型を引き継ぐ。両条件があればAND、predicateを指定してblockTypesを省略した場合はそのpredicate自体を使い、air等の明示検索を勝手に除外しない。両方省略時は現在の非air検索を維持する。filterを適用してから距離順にlimitをかける。取得済み上位N件の後段filterへ置き換えない。numeric ID/名前のみは既存palette最適化、functionは座標付きBlockとgetProperties()/Vec3を使う。同期値・radius上限・未ロードをairと解釈しない境界を保つ。
2. **entity観測。** `getNearbyEntities({radius?})` は現在の距離順とEntity referenceを保持し、native projectionで自身のentity IDを除く。loaded entityの照会であり、LOSで可視な対象だけとはしない。player/他botも残す。find/filterはこの1回の配列に行い、キャッシュや追加の世界走査を作らない。旧最寄りpredicateの半径端点は他の近傍観測と同じ「半径以内」に揃える。
3. **半径の意味。** 派生helperの旧既定（entity種16 / player名64 / block種16 / 単体block16）は短い呼出し例のradiusで表し、host設定のmax_search_radius内に収める。特に無引数のentity種/player名が設定上限を迂回していた挙動は維持しない。検索上限を広げず、旧16/64より設定値が小さければ観測範囲も設定値までとなることを記す。deferred docsの例にはhost側で有効半径を数値として埋め込み、callerに設定取得やmin計算を要求しない。entityの既定16、blockの既定8は変えない。
4. **短い観測の扱い。** 種類/名前の配列は取得済み候補の要約であり、読み込み範囲全体や未ロード領域にその種類が存在しない保証にはしない。block種の旧件数上限10000、順序、null/unknownと空の候補の区別を既存の観測契約に沿って説明する。安全な短いfilter/map/findを代替にできるものだけを統合し、raw bot/pluginや長い手順は代替にしない。

### 呼び方と公開能力の確認例

```js
// 属性・範囲を適用してから8件を選ぶ。接近/装備/確認待ちはskill側。
const crops = world.getNearestBlocks({blockTypes:['wheat'],radius:8,limit:8,
  predicate:b => b.position.x >= 10 && Number(b.getProperties().age) === 7});
for (const crop of crops) await skills.breakBlockAt({position:crop.position});
// 農地全体なら既存のtendNearbyFarm/tendFarmを使う。

// 観測派生は短い配列操作。半径はhost上限内の有効値を使う。
const nearby = world.getNearbyEntities();
const players = nearby.filter(e => e.type === 'player');
const types = [...new Set(nearby.map(e => e.name))];
const cow = nearby.find(e => e.name === 'cow') ?? null;
log(bot, JSON.stringify({players:players.map(e => e.username),types}));

// 専門操作も通常のdeferred docsを読んで直接呼ぶ。raw操作は不要。
const trades = await skills.showVillagerTrades({entityId:123});
const first = trades?.find(t => !t.disabled);
if (first) await skills.tradeWithVillager({entityId:123,index:first.index,times:1});
await skills.clearNearestFurnace({furnacePosition:{x:10,y:64,z:-3}});
await skills.digDown({distance:3});
await vision.lookAtPlayer({playerName:'Steve',direction:'with'});
```

例は独立した目的の抜粋で、全行を1依頼として連結する意味ではない。専門操作の対象・取引選択・作業許可はcallerが決め、SDKは既存の接近・装備・確認・取消を担当する。API整理を理由に既存の結果保証を強く書き換えたり、確認待ちをwaitの連打としてcallerへ戻したりしない。

### 実装順序と受入確認

- [ ] **統合8名だけをnative公開面から外し、薄い検索adapterを揃える。** `native_sdk.js` の定義を基準にcatalog・deferred docs・facade・完了metadata・lintを同時更新する。`native_sdk.test.cjs` で継続名、追加predicate、削除名のdot/bracketアクセス不可、2bot分離、sync/asyncと引数検証の保持を確認する。件数だけを通過条件にしない。world export全公開を要求する現fixtureは意図した公開subsetへ修正する。
- [ ] **派生観測が短く安全に置換できることを確認する。** `targeted_sdk.test.cjs` / `world_observation.test.cjs` で座標predicateがlimit前に作用すること、blockTypesとのAND、ID/ID配列とfunction、airの明示検索、距離順、Blockメソッド、unknown、entity自身の除外とplayer/他bot保持を確認する。小さいmax_search_radiusでは旧16/64を迂回せず、doc例も有効値になることを確認する。内部/legacyの既存helperは変更しない。
- [ ] **残す専門目的がnativeから使えることを代表workflowで確認する。** real Coder/SES/ActionManager境界の既存fixtureに必要な最小ケースを加え、取引一覧→1始まりindexの取引、明示炉回収、digDown、任意entity退避、nearest block/entityのminDistance、approachBlockとisClearPathの照会を通す。画像fixtureではblock未知時に撮影しないこととplayerのwith、場所fixtureではhome/alias設定→解決/移動、現在地点/実物/伝聞の登録とread-only inspect/verify更新の区別を保持する。wait中の取消とstayのmode/単独Goals完了が混同されないことも既存session/interaction fixtureで確認する。これらはAPI到達性と既存契約の回帰確認であり、新たなゲーム内成功保証ではない。
- [ ] **botの案内と保存scopeを一致させて完了する。** READMEと [`src/process/codex/AGENTS.md`](src/process/codex/AGENTS.md) の推奨block検索・派生観測・出力を更新する。接近/equipは通常作業の前処理として重複実装させず、必要な専門目的では使えると説明する。places/visionの既存自然な入口は変えない。protocol 10を次へ進め、`codex_session.test.cjs` で旧SDK scopeは一度新threadを選び、新scopeは再開することを確認する。旧履歴は削除しない。queryのfalse/null/unknownはdata、action失敗/部分結果はbatch停止、catch/未awaitでも停止を迂回できない契約を維持する。

実装時は既定Node20の関連fixture後、必須 `tests/run-tests.cjs`、Shared CLI `codex-test run --scope fast --project mindcraft`、full diff/`git diff --check`を行う。変更しない専門ゲームcoreまで一律のlive benchmarkは増やさない。実装中にworld操作を変える必要が生じた場合だけ、その具体的な未確認事項を既存templateコピー・許可loopback 25569/25570で確認する。使いやすさや成功率の改善を今回の静的調査から実測値として主張しない。

### 境界と回復

- 今回は計画修正と静的確認だけ。機能実装、suite、依存install、ゲーム起動、live操作、manual pin/applyを行わない。計画文書だけを通常の規則でcommit/pushし、desktop-bot計画と既存5 dirtyファイルを保持する。
- 実装が依頼されたらuser差分を分離し、task差分だけを検証・own originへcommit/pushした後、親AGENTSの継続指示とplayの対象確認/readiness/rollback手順に従いbot-only applyする。server/world、memory/thread保存内容、Ollama停止状態を保つ。
- source/bundleを戻せば公開契約を復元できる。新旧SDK scopeを混在させず、旧履歴を削除しない。実行済みのblock/inventory変更はsource rollbackで戻らないため、不確かな操作をreplayしない。永続record schemaと専門機能の実装は変えない。
