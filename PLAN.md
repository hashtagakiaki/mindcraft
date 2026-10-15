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

## native SDKの公開面縮小 — 2026-10-16（設計のみ）

Goal: 日常の依頼でbotが選ぶ公開メソッドを82件から46件へ減らす。採取・製作・建築・収納・農作業・移動・戦闘・場所記憶・画像確認は短いSDK呼出しで行え、接近手順や派生観測の名前を選ばなくてよい。以下は提案であり未実装。上のdesktop-bot計画とは独立して進める。

### 根拠と選択

- 調査基準はHEAD `bc18f93c7e032898850bc771030bfa204ceaf345` と既存worktree。[`native_sdk.js`](src/agent/library/native_sdk.js) をimportして実数82件（skills 43 / world 21 / places 13 / vision 3 / diagnostics 1 / communication 1）を確認した。前回の引数・確認契約整理は維持するが、「個別の用途がある」だけでは公開理由にしない。
- 現行の名前一覧・deferred docs・native facade・lintは同じregistryから作られる。[`coder.js`](src/agent/coder.js) のnative入口を狭めれば、内部/legacy関数を削除せず実際の選択肢を減らせる。common/advancedに表示を分けるだけの82件公開は採用しない。
- [`world.js`](src/agent/library/world.js) の単体最寄り、predicate検索、player一覧、種類一覧は少数の検索から導ける。一方、座標/属性predicateは保護対象を避ける限定batchに必要なので失わない。`getNearestBlocksWhere` と [`targeted_sdk.test.cjs`](tests/targeted_sdk.test.cjs) には「座標predicateを適用してからlimit」の既存契約がある。取得済み上位N件を後からfilterする代替では不十分。
- [`skills.js`](src/agent/library/skills.js) の接近、道具装備、操作後確認は目的skillの内部で動く。内部callerや [`commands/actions.js`](src/agent/commands/actions.js) が使う関数まで消さない。固定経路方針、数量の確認・部分完了、取消/所有、inventory gateも変えない。
- [`places.js`](src/agent/places.js) は現在地点登録と観測地点登録を既に別の小さな内部処理で実現し、登録名を個人aliasにする。伝聞はsource:user / existence:unverifiedとして保存される。alias/home解決、再観測、ID移動も既存処理を再利用できる。永続schemaや新しい場所検索器は不要。
- native navigationは `canOpenDoors:false` でdoor補助intervalも抑止されるため、`useDoor` は単なる移動の内部処理にできない。出入りを手動の開閉・通過手順へ戻さないため公開に残す。地形保全と経路編集の2つの座標移動も、破壊範囲の意味が違うため残す。
- 採用する公開面は46件。数の目標を先に決めた最小化ではなく、派生名・内部手順・専門的操作を外した結果である。さらに減らすために製作/収納/農作業を汎用actionへまとめたり、接近・装備・道具操作を長い手順としてcallerへ戻したりしない。使いやすさの改善量や必要十分性を今回の静的調査で実測したとは扱わない。

### 公開する46件と引数

以下はschemaの略記。実際は名前付きobjectを1つ渡し、`?` は省略可、無入力は `()`。記載のない引数は追加しない。既定値・単位は現行を維持し、変更点は後述する。top-level fieldは合計90個（schema上必須38 / 任意52、現行138個）。positionのx/y/zは1対象を表す1fieldとして数える。施設登録時のpositionなど条件付き必須は別途検証する。各呼出しで90個を判断する意味ではない。

```text
skills.craftItem({itemName, quantity?})
skills.smeltItem({itemName, quantity?, furnacePosition?})
skills.attackEntity({entity, kill?})
skills.defendSelf({radius?})
skills.collectBlock({blockType, count?, exclude?})
skills.pickupNearbyItems()
skills.breakBlockAt({position})
skills.inspectChest({position?})
skills.placeBlock({blockType, position, facing?, axis?, half?, attachTo?, dontCheat?})
skills.equip({itemName})
skills.discard({itemName, quantity})
skills.putInChest({itemName, quantity, chestPosition?})
skills.takeFromChest({itemName, quantity, chestPosition?})
skills.consume({itemName?})
skills.giveToPlayer({itemName, playerName, quantity?})
skills.goToPosition({position})
skills.reachPosition({position})
skills.goToPlayer({username, minDistance?})
skills.followPlayer({username, minDistance?})
skills.avoidEnemies({distance?})
skills.stay({seconds?})
skills.useDoor({position?})
skills.goToBed()
skills.tillAndSow({position, seedType?})
skills.goToSurface()
skills.useToolOn({toolName, targetName})
skills.useToolOnBlock({position, toolName?})
skills.useItem({itemName})
skills.tendNearbyFarm({scope?, searchRadius?, radius?, startPosition?, seedReserve?, chestPosition?})
skills.fellTree({startPosition?, searchRadius?})
world.inspectBlockAt({position})
world.getNearestFreeSpace({size?, radius?})
world.getNearestBlocks({blockTypes?, predicate?, radius?, limit?})
world.getNearbyEntities({radius?})
world.getInventoryCounts()
world.getPosition()
places.find({text?, kind?, purpose?, dimension?, existence?, staleBefore?, limit?})
places.inspect({placeId})
places.goTo({place})
places.remember({name, kind?, purpose?, position?})
places.rememberReported({name, kind, position, purpose?, dimension?})
places.setOutputStorage({fromId, storageId})
places.tendFarm({farmId, seedReserve?})
vision.lookAtPosition({position})
diagnostics.lastTask()
communication.sendToBot({recipient, message})
```

内訳はskills 30 / world 6 / places 7 / vision 1 / diagnostics 1 / communication 1。現行の45名を残して1名 `places.remember` を追加し、現行37名をnativeから外すため、差引36件減る。残す45件もすべて変更するのではなく、変更は次の小さな集約に限定する。

- **block検索を1入口にする。** `getNearestBlocks` に任意のfunction predicateを加える。blockTypesだけなら既存のpalette最適化、predicateがあれば座標付きBlockで判定する。両指定時はAND、無指定時は既存の非air検索。判定後のdistance順にlimitを適用する。predicateはfilterであり編集を含まない。radius上限・同期戻り値・BlockのgetProperties()/position・未知の扱いを保つ。numeric ID指定の専門入口は内部に残し、nativeでは名前とfunctionを使う。
- **観測済み場所の登録を1入口にする。** 新しい `remember` はkind既定other。position省略は現在の代表点をbase/otherとして登録する場合だけ許可し、storage/farm等は対応するloaded blockのpositionを必須にする。position指定時は既存rememberObservedAtの検証を使う。自動aliasは登録名のまま、施設の範囲や出入口まで観測したとは扱わない。`rememberReported` は別methodとして残し、未ロード地点や他dimensionの伝聞を観測済みにしない。
- **保存地点への移動を1入口にする。** `goTo({place})` のplaceはstable IDまたは正確な個人alias/home文字列。fuzzy検索や直前のselected状態で移動先を決めない。両方に解決して違うIDになる場合は曖昧さとして拒否し、解決後は既存のdimension/欠落/到着確認を使う。返す結果には確定したplaceIdを含める。findは曖昧な候補選択、goToは確定した1対象への移動のまま。
- **保存recordの確認を1入口にする。** `inspect({placeId})` は保存snapshotと現在確認を返す。現在dimensionのloaded target、または近傍のbase/other代表点だけ既存verifyで再観測する。未ロード・遠方・別dimensionはhistorical recordと現在unknownの区別を返し、観測時刻/存在状態を更新しない。見た事実なしに伝聞をobservedへ昇格しない。store/RPC失敗をunknownに握りつぶさない。記録更新を伴うqueryであることを説明する。
- **blockの通常操作を既存入口へ寄せる。** `useToolOnBlock` のtoolName既定をhandにし、lever等の素手activationも表す。item/toolを使うときだけ指定する。現在対象の再解決、内部接近、バケツの確認は現行のまま。開く/通過/閉じるdoor専用手順は残すuseDoorに任せる。

### 外す現行37名の対応（重複なし）

**既存の公開操作または上の集約へ吸収する19件**。下の名前はnative一覧・doc tool・facade・lintから除き、内部/legacyには残す。

```text
skills.log skills.attackNearest skills.activateNearestBlock
world.getBlockAtOffset world.getSurroundingBlocks world.getNearestBlocksWhere world.getNearestBlock world.getNearestEntityWhere world.getNearbyPlayers world.getNearbyEntityTypes world.getNearbyPlayerNames world.getNearbyBlockTypes
places.verify places.resolveAlias places.goToAlias places.rememberHere places.rememberObservedAt
vision.lookAtBlock vision.lookAtPlayer
```

logは既存 `log(bot, message)`、最寄りの単体blockは `getNearestBlocks({blockTypes,limit:1})[0]`、entity/playerは近傍配列のfind/filter、種類一覧はその配列のmap/Setで十分。相対block/足元3点は現在位置から `inspectBlockAt` へ渡す短い座標計算で得られる。block/playerを見るときも既知の中心/目の座標を唯一のvision入口へ渡す。lookAtPlayerのwith（視線方向の模倣）はこの置換に含まれず、後述の非対応範囲となる。最寄り攻撃は近傍配列のfindとattackEntity、block activationは座標指定useToolOnBlockが担う。いずれもraw bot/pluginを通常の代替にしない。

**内部手順にする6件**。

```text
skills.wait skills.approachBlock skills.goToNearestBlock skills.goToNearestEntity
world.isEntityType world.isClearPath
```

目的skillの接近・分類・経路・有限waitを直接選ばせない。製作/収納等はそれ自体を呼び、確認待ちは内部で完結する。playerへの一時接近/追従はそれぞれ専用の残すmethodを使う。waitをstayへ機械変換しない（stayはmodeとGoalsに意味がある）。任意のlandmarkへのcloseness指定まで同等に残す計画ではない。

**日常公開面から意図的に外す12件**。

```text
skills.clearNearestFurnace skills.moveAway skills.moveAwayFromEntity skills.showVillagerTrades skills.tradeWithVillager skills.digDown
world.getFirstBlockAboveHead world.getVillagerProfession world.getCraftableItems world.getBiomeName
places.setHome places.setAlias
```

取引、炉内全回収、任意方向/任意entityからの退避、指定深さの垂直穴、専用の頭上走査、職業/biome/製作可能品の網羅列挙、既存地点へのhome/alias再割当、および先述したplayerの視線方向の模倣は初回のnative公開範囲に含めない。敵からの退避、目的座標への地下移動、要求アイテムの製作、登録名で帰る日常用途は残るが、上記の完全な代替ではない。既存home/aliasと内部/chat機能は壊さない。減らした機能の代わりにrawアクセスや長い手順をbotへ指示しない。

### 日常の呼出しが長い手順へ戻らないこと

```js
// 採取→製作→配置。接近・道具装備・確認用waitは選ばない。
await skills.collectBlock({blockType:'oak_log', count:2});
await skills.craftItem({itemName:'oak_planks', quantity:8});
await skills.placeBlock({blockType:'oak_planks', position:{x:10,y:64,z:-3}});

// 範囲と成熟度で絞ったbatch。predicateを通った8件を取得してから編集する。
const crops = world.getNearestBlocks({blockTypes:['wheat'], radius:8, limit:8,
  predicate:b => b.position.x >= 10 && Number(b.getProperties().age) === 7});
for (const crop of crops) await skills.breakBlockAt({position:crop.position});
// 畑全体の収穫・再植付けはtendNearbyFarm/tendFarmを1回呼ぶ。

// 明示収納と素手activation。最寄り選択は省略時だけ行う。
const chest = await skills.inspectChest();
await skills.putInChest({itemName:'oak_planks', quantity:4, chestPosition:chest.position});
await skills.useToolOnBlock({position:{x:11,y:64,z:-3}});

// 観測した施設を保存し、同じ名前で帰る。出力収納の関係も維持できる。
const store = await places.remember({name:'共有倉庫',kind:'storage',position:chest.position});
await places.goTo({place:'共有倉庫'});
const currentStore = await places.inspect({placeId:store.place.id});

// 日常の追従・戦闘・探索を維持。存在しない対象を成功扱いしない。
await skills.followPlayer({username:'Steve'}); // 追従は取消まで続く独立依頼。
// 別の依頼で、近傍配列は距離順。対象選択が必要な攻撃だけfindする。
const zombie = world.getNearbyEntities().find(e => e.name === 'zombie');
if (zombie) await skills.attackEntity({entity:zombie});
await skills.reachPosition({position:{x:30,y:50,z:-3}});
await skills.goToSurface();
await vision.lookAtPosition({position:{x:10.5,y:64.5,z:-2.5}});
```

例は別々の短い依頼/batchを示し、全部を1operationに連結する例ではない。API削減を理由に保護領域を推定させたり、predicateで対象を選ぶ責任や最後の成果確認を省いたりしない。block/playerの照準に必要なloaded状態・座標は構造化観測から取得し、画像未取得を確認済みにしない。

### 実装順序と受入確認

- [ ] **公開境界を46件へ変更する。** registry定義と薄いnative adapterだけを中心に、上の全件分類を実装する。世界操作core、内部export、chat、legacy capability docsはそのまま利用できることを確認する。新しいadvanced registry、discovery tool、action/mode unionやglobal設定は作らない。`native_sdk.test.cjs` で提案した公開名・引数・既定値とdocs/facade/metadataの一致を確認する。削除37名はdot/bracket参照のどちらもnative facadeに存在せず、説明toolにも載らない。件数とfield数は設計の集計値であり、使い勝手に必要な修正を妨げる独立した上限にしない。現在の「world exportをすべて公開する」fixtureは明示した公開subsetへ直す。
- [ ] **少数の集約と通常workflowを完成させる。** blockTypes＋predicateのAND、filter前後のlimit、距離順、palette最適化、座標付きBlockは `targeted_sdk.test.cjs` の既存fixtureで確認する。`place_agent.test.cjs` / `place_actions.test.cjs` / `place_rpc.test.cjs` で現在地点/施設/伝聞の登録、loaded/unknownの再確認、ID/alias衝突拒否、home互換、world/dimension境界、storage linkと保存farmを確認する。位置指定の素手activationは既存interaction fixtureで確認する。別の巨大な探索・場所管理層は追加しない。
- [ ] **botの実行導線を同じ公開面に揃える。** [`src/process/codex/AGENTS.md`](src/process/codex/AGENTS.md) の推奨predicate検索と施設登録を新入口へ変え、削除methodを前処理/回復策として案内しない。READMEのnative例、動的catalog、deferred docs、lint、native bindingsを揃える。protocol 10を次へ進め、`codex_session.test.cjs` で旧scopeは新threadを1回選び、同じ新scopeは再開することを確認する。既存memory/threadファイルを削除・移行しない。
- [ ] **短い組合せを実行境界まで確認して完了する。** real Coder/SES/ActionManager fixtureで採取→製作→設置、明示チェスト、保存farm/場所移動、近傍entity選択→攻撃、画像取得の代表コードが削除名なしで通り、各actionのpartial/unknown/取消後は後続SDKが止まることを確認する。query false/null/unknownはdataとして続けられること、catch/未awaitで失敗停止を迂回できないこと、確認数量・内部cleanup記録を失わないことを保つ。fixtureは実ゲームでの使いやすさの測定とは区別する。

実装時は既定Node20の関連fixture後に必須 `tests/run-tests.cjs`、Shared CLI `codex-test run --scope fast --project mindcraft`、full diff/`git diff --check`を行う。今回の中心は公開境界と検索/記憶adapterなので、変更しないゲームcoreの全域live benchmarkは追加しない。実装中にworld操作coreを変える必要が判明した場合だけ、その差分の未確認事項に限って既存templateコピー・許可loopback 25569/25570で直接確認する。公開件数だけで成功率向上を主張しない。

### 境界と回復

- 今回はPLAN追記と静的確認だけ。機能実装、suite、依存install、ゲーム起動、live操作、manual pin/applyは行わない。計画文書だけをcommit/pushする。5つの既存dirtyファイルとdesktop-bot計画を保持する。専門用途を公開対象から外す判断は本案の提案であり、実装済み・ユーザー確認済みとは扱わない。
- 実装が依頼されたら既存user差分を分離してtask差分だけを検証・own originへcommit/pushし、親AGENTSの継続指示に従い検証済sourceをbot-only applyする。対象の正本・bundle/readinessをplay手順で確認し、server/world、memory/thread保存内容、Ollama停止を保持する。
- rollbackは直前の検証済source/bundleへ戻す。新しい公開面と旧scopeを混在させず、旧履歴を削除しない。作業済みのblock/inventory変更はsource rollbackで戻らないため、曖昧な結果をreplayしない。登録recordの永続形式は変えない。
- nativeから外した専門機能は需要が具体的に発生した時に、その目的を短く満たす入口として再検討する。最初から全82件を復帰できる裏口や、常用外method一覧を用意しない。
