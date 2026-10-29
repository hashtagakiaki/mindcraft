<h1 align="center">🧠mindcraft⛏️</h1>

## Change entrypoints

| Change area | Main source | Focused existing check | Final check |
|---|---|---|---|
| Native session, thread and context | `src/process/codex_session.js`, `src/agent/codex_runtime.js` | `tests/codex_session.test.cjs` | `tests/run-tests.cjs` |
| Public native SDK contract | `src/agent/library/native_sdk.js` | `tests/native_sdk.test.cjs` | `tests/run-tests.cjs` |
| Mining, movement and placement | `src/agent/library/` | Matching existing fixture, such as `tests/block_interaction.test.cjs` or `tests/block_placement.test.cjs` | `tests/run-tests.cjs` |

From the `mindcraft/` repository root, set the existing Node 20 binary once in the current shell, then copy the relevant fixture command:

```sh
MINDCRAFT_NODE=/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node
"$MINDCRAFT_NODE" tests/codex_session.test.cjs
"$MINDCRAFT_NODE" tests/native_sdk.test.cjs
"$MINDCRAFT_NODE" tests/block_interaction.test.cjs
"$MINDCRAFT_NODE" tests/block_placement.test.cjs
```

Run focused fixtures while iterating and the required suite once for final verification. The runner summarizes passing fixtures as `[ok]` and keeps failure detail. See [development instructions](AGENTS.md) for command boundaries; this README's later sections describe contracts and historical evidence when relevant.

## Personal development fork

`main.js --ui-only` はprofileを未接続のagentとして登録し、UIのConnectで初めて起動する。通常起動は従来どおり全agentを接続する。手動playでは [`../play/start.sh --ui-only`](../play/README.md) を使う。

操作者はbotに目的と明示的な制約を渡し、方法・準備・実行・失敗からの回復を自律的に判断させる。bot共通指示は6-lunaでの利用を前提に、最優先の方針と「未達の成果を確認 → 次の作業と不足を選択 → 不足だけ補って実行 → 結果から続行・回復・完了を判断」の循環を中心にする。道具の準備や原因別の回復には具体例を残し、確認や準備は次の行動に必要な範囲で終える。個別場面の方法・経路は固定せず、SDKの実行境界と確認済みの操作結果を使う。正本は [bot用AGENTS.md](src/process/codex/AGENTS.md)。

管理UIの状態APIと `!stats` は、HP・空腹度を丸めずに返す。統括役とbotが同じ実測値でしきい値を判定でき、HP 9.5 が管理側だけ10になることを防ぐ。

管理UIのヘッダーは、接続中のbotから取得したMinecraft内の時刻を24時間表記で表示する。最新の状態を取得できないときは `--:--` と表示する。

bot用AGENTSには行動方針・SDK文書の読み方・共通の実行境界を置く。個別メソッドの引数・動作・戻り値・固定経路方針は [`native_sdk.js`](src/agent/library/native_sdk.js) の遅延文書に集約し、使用前に必要な文書を読む。実行時にAGENTSへ追加するSDK一覧はメソッド名のみとする。

The native SDK uses one explicit method registry for execution, argument validation, deferred documentation, completion metadata and code linting. Legacy SDK documentation retains its `places`/`vision` method map. The opt-in native Codex runtime uses deferred SDK documentation and direct image results; see [Opt-in Codex task session](#opt-in-codex-task-session). The selection and helper-model description below applies to legacy tasks. Relevant place methods are selected by task relevance; vision methods remain in the always-shown docs. Native `lookAtPosition` aims at the exact requested coordinates and returns structured aim, timestamp and image analysis; legacy `lookAtPosition(x, y, z)` retains its `y + 2` camera offset. `lookAtBlock` resolves a loaded block and aims at its center. Native `codex-session` skips embedding model construction and example/skill embedding initialization; legacy selection retains its embedding path and text-overlap fallback.

Legacy generated vision calls use `await vision.lookAtPosition(x, y, z)` or `await vision.lookAtPlayer("Steve", "at")`, without a `bot` argument. Position coordinates must be finite numbers; player names must be nonempty strings and direction is `"at"` (default) or `"with"`. Invalid arguments fail before changing the view or capturing an image, so an owned operation can report the error and continue with a corrected call in the same task. Log the returned analysis, for example `log(bot, await vision.lookAtPosition(75, 73, -292));`.

Minecraft disconnect reasons are decoded with the version-specific chat component decoder, including modern NBT reasons. The offline `tests/vision_sdk_validation.test.cjs` fixture checks Coder/SES/ActionManager rejection and continuation, chat commands, disabled vision, and reason decoding. Isolated vanilla 1.21.1 verification records are in [the LoginGuard investigation](../mindcraft-tools/docs/login-guard-invalid-rotation-20261006.md); camera/image analysis is stubbed in these checks.

`blocked_actions` disables named chat commands and removes those commands from command documentation. It does not prohibit equivalent operations through the SDK, raw bot access, or plugins.

### Native SDK arguments

With `agent_runtime: "codex-session"`, every SDK method binds the current bot on the host. Pass one named argument object, or omit it when all fields are optional. Internal functions, legacy generated code and chat commands retain their existing signatures; the bot-first examples in the following sections describe those paths.

```js
const position = world.getPosition();
const target = world.inspectBlockAt({ position: { x: 10, y: 64, z: -3 } });
const chests = world.getNearestBlocks({ blockTypes: ['chest'], radius: 16, limit: 3 });
const saved = await places.find({ kind: 'storage' });
const made = await skills.craftItem({ itemName: 'stick', quantity: 5 });
const chest = await skills.inspectChest();
const farm = await places.tendFarm({ farmId: 'farm-1', seedReserve: 1 });
const preserved = await skills.goToPosition({ position });
const excavated = await skills.reachPosition({ position });
log(bot, JSON.stringify({ target, chests, saved, made, chest, farm, preserved, excavated }));
```

Absolute block coordinates use `position`; native `world.getBlockAtOffset` takes a relative `offset`. Item transfers use a required positive `quantity` or explicit `'all'`; `craftItem.quantity` is the minimum number of new output items, rounded up to whole recipe executions. Collection uses `count` for blocks. Unknown fields, missing fields and invalid values throw `SdkArgumentError` before calling the internal SDK. The settled result and previous-task diagnostic retain `argumentError` with the method, field, expectation, signature and corrected example. A prior valid mutation in compound code remains effective.

Read each selected method's deferred documentation for its fields, defaults, result and availability. The canonical definitions are in [`native_sdk.js`](src/agent/library/native_sdk.js). Native actions return a structured result: boolean skills become `{ok,status,code?,reason?,...}` with the cause reported where the skill decided (for example `missing_item`, `target_not_found`, `route_failed`), and a delegated failure keeps its child's cause. `collectBlock`, `discard`, `giveToPlayer` and `tradeWithVillager` also report `unit`, `requestedQuantity`, `confirmedQuantity` and `remainingQuantity`; fewer than requested is `partial`/`unknown`, never success, and unknown quantities are `null`. The same result reaches `skillResults`, `sdkFailure` and `diagnostics.lastTask()`. Actions stop the current code batch on failure or incomplete results; query values such as `false`, `null`, and `unknown` remain data. Internal and legacy bot-first callers keep their boolean returns. Crafting, smelting, chest transfers and farm tending return domain quantities and statuses where available. Native chest transfers return `{ok,status,itemName,requestedQuantity,confirmedQuantity,remainingQuantity}` from server-confirmed inventory changes; partial and unknown results stop the current batch. For example:

```js
const transfer = await skills.putInChest({
  itemName: 'cobblestone', quantity: 3,
  chestPosition: { x: 10, y: 64, z: -3 }
});
log(bot, JSON.stringify(transfer));
```

`inspectChest({position?})` gives one structured observation; an explicit position never falls back to a nearby chest. Places return structured records, and `places.find` can filter by `kind` or `purpose` without `text`. `log(bot, message)` is the output helper; native `skills.log` is not exposed. `consume()` selects the inventory food with the most food points, excluding harmful, teleporting and golden foods; an explicit `itemName` is never substituted. `useItem({itemName, hand?, holdMs?, position?|entity?})` aims, activates, holds and always releases, including on cancellation; completion means the input was sent, not that it hit. Players are named with `playerName`. This SDK contract increments the native context protocol to 11: old-contract threads start fresh once, then matching tasks resume normally.

Native block search is `world.getNearestBlocks({blockTypes?, predicate?, radius?, limit?})`: pass either names or a Block predicate, use `limit:1` and `[0]` for the nearest block, and expect `[]` when nothing is found. The default radius is 8, so pass `radius` for wider searches. Predicates apply to loaded Blocks with coordinates, so conditions on `block.position` are supported; they use Mineflayer's slower full-block search. Internal `world.getNearestBlocksWhere` keeps numeric block IDs and ID arrays on the palette optimization. Retired native names (`world.getNearestBlock`, `world.getNearestBlocksWhere`, `world.isEntityType`, `skills.log`) fail lint with their replacement. Keep the search radius small and log compact summaries instead of dumping thousands of Blocks.

ベッド・半ブロック・チェストなどの上を通る途中地点には、pathfinderが保持する元の整数探索座標を使います。描画・移動用に補正された足元座標を切り捨てて探索目標に戻さず、到着時も接地中の段差を探索と同じ座標系で判定します。利用者が指定する最終到着マスと、安全な接地の確認条件は従来どおりです。

### Inspect an explicit target and continue after a failure

Use absolute coordinates to distinguish nearby targets:

```js
const target = world.inspectBlockAt(bot, 10, 64, -3);
const chest = await skills.inspectChestAt(bot, 10, 64, -3); // legacy bot-first API
log(bot, JSON.stringify(chest));
log(bot, JSON.stringify(await vision.lookAtBlock(10, 64, -3)));
```

`inspectBlockAt` returns loaded state, position/name/properties, corner distance, legacy eye-to-center `interactionDistance` and Mineflayer `visible`, installed bot `canDig` admission, dimension and observation time. With `mining_sync`, `canDig` requires a diggable block and uses the same surface resolver as SDK approach and digging. Its `interaction` field independently reports `status` (`ready`, `unknown`, `blocked`), a reachable surface `aim`, intersection `face`, eye-to-hit `distance`, and `reason`. A block may have `visible: false` with `interaction.status: "ready"`; center visibility is not required. Unavailable raycasting, unloaded ray cells and unloaded targets remain unknown. Native `skills.inspectChest({position?})` returns the actual selected position, contents and time; omission chooses the nearest chest, while an explicit position never substitutes another. Double chest contents are combined. Legacy `inspectChestAt` and `viewChest` retain their bot-first compatibility APIs. An opened container is closed on success, failure or cancellation. Container observations are historical reads, not inventory transfers.

Use `skills.putInChest(bot, itemName, num = -1, options = {})` and `skills.takeFromChest(bot, itemName, num = -1, options = {})` to transfer items. `num: -1` means all matching items available for that transfer; a positive safe integer is the exact requested quantity. A larger request moves only the available amount and returns `false` so callers do not mistake a partial transfer for completion. Pass `{ chestPosition: { x, y, z } }` to select one explicit chest; without it, the legacy nearest chest is used. Both methods retain boolean results and log a compact JSON record with `requestedQuantity`, `confirmedQuantity`, `remainingQuantity`, and the actual `chestPosition`; `confirmedQuantity` and `remainingQuantity` are `null` when server snapshots cannot confirm the transfer. For example:

```js
const deposited = await skills.putInChest(bot, 'wheat_seeds', 262, {
  chestPosition: { x: 10, y: 64, z: -3 }
});
log(bot, `deposit complete: ${deposited}`);

const withdrawn = await skills.takeFromChest(bot, 'wheat_seeds', -1, {
  chestPosition: { x: 10, y: 64, z: -3 }
});
log(bot, `withdraw complete: ${withdrawn}`);
```

`skills.approachBlock(bot, x, y, z)` uses the existing owned pathfinder and a `GoalLookAtBlock` with surface-ray completion, without digging or scaffolding. It rechecks the actual eye ray to a target surface within 4.5 blocks and returns `ready`, `unknown` or `blocked` with a fresh target observation and reason. Movement alone is not successful interaction. The shared shape-aware resolver checks face centers and bounded interior/edge samples; an aim not found is not proof that every tiny visible sliver is occluded. `breakBlockAt`, tree work and explicit chest operations use reachable surface points, including when the center or face centers are hidden. Installed native mining also uses the 4.5-block surface reach; its old center-distance veto is removed. When this check rejects a block that the pathfinder planned to break, the rejection is recorded as `bot_dig_rejected` and that block is excluded from the active route's breaks, so the pathfinder replans instead of retrying every tick. `breakBlockAt` は採取可能な道具を優先し、道具がなくても素手で破壊できるブロックなら採掘する。この場合ドロップは得られないことがある。ブロックの採取が目的なら、対応道具を使う `collectBlock` を利用する。`forceLook: "ignore"` must already point at the target. The target state and ray are checked again before the start packet. `goToPosition`, `breakBlockAt` and legacy placement reject invalid Bot/finite coordinates before side effects, with a corrected example; strict orientation placement keeps its existing `false` validation contract. `collectBlock(bot, blockType, num, exclude)` validates its Bot/name/count/exclusions; `exclude` means positions to skip, not positions to collect. Mineflayer palette entries have `position:null`, so coordinate and terrain checks run only on the subsequent positioned match.

`vision.lookAtBlock(x,y,z)` takes no Bot argument. It returns `{status, target, aim, observedAt, analysis}`; unknown targets cause no view change or capture. Existing position commands/SDK retain the `y+2` aim. Offline fixtures stub image interpretation; live image quality and chest/build correctness require dedicated trusted templates and observers.

Native tasks can read `diagnostics.lastTask()` to explain the previous task's exact error and code without replaying it. The bounded snapshot is saved in existing `memory.json`, scoped by Bot name and configured `place_world_id`; no scope, missing records, old format or mismatches return `available:false` with a reason. It retains the latest six operations plus the latest failure, bounded skill results and confirmed/unconfirmed changes with timestamps. Code/error/output limits are 6000/4000/3000 characters; structural entries and depth are also bounded. Raw Bot/plugin changes may be untracked. The initial model input lists availability and task identity; details are read only when requested. Bundle handoff can carry the existing memory file; old trace files are never automatically replayed. Save success is recorded separately in `diagnosticSaveSucceeded`.

Native decision instructions require comparing the entire request with observed state, checking a cause before changing the failing conditions, and verifying again after the last mutation. Resumed turns repeat the accepted request alongside the completed operation result. A failed method or recovery-only inspection is not treated as sufficient evidence of an impossible task. These are model instructions, not an automatic goal validator; the existing task budgets still apply. [The isolated recovery verification](docs/native-goal-recovery-20261006.md) records actual chest repair and occluded harvesting with `gpt-6-luna` at medium effort.

資材探索では必要量の所在が分かったら回収へ移り、不足分だけ追加探索します。操作失敗後は、原因を変えられる別手段を次の実行で試し、その結果または試せない具体的な根拠を確かめてから未達を報告します。共通指示による行動方針であり、モデルが必ず従う保証ではありません。

`skills.useDoor({position?, open?})` は木製ドアと柵のゲートに対応します。`open:true` は開けたまま、`open:false` は閉じた状態にし、サーバーのblock更新を確認します。状態指定時は自動で通過しないため、動物の誘導中も開けておけます。省略時は従来の「開ける→通過→閉じる」を保ちます。legacyは `skills.useDoor(bot, position, {open:true})`。既に要求状態なら再クリックせず成功し、状態が不明・未確認なら失敗します。

The Node20 `tests/targeted_sdk.test.cjs`, `tests/vision_sdk_validation.test.cjs` and `tests/codex_session.test.cjs` fixtures exercise the real Coder/SES/ActionManager boundary. They cover distinct targets, validation before side effects, unknown/occluded/unreachable targets, cancellation and close, compatibility, and diagnosis in a new task after a saved TypeError.

### Fell one tree and clean up its pillars

Use `skills.fellTree(bot)` for a complete single-tree job rather than collecting a requested number of logs:

```js
const result = await skills.fellTree(bot, {
    startPosition: { x: 10, y: 64, z: -4 }
});
log(bot, JSON.stringify(result));
```

`startPosition` selects a trunk log; omission searches within `searchRadius` (default 24, maximum 64). The skill follows touching same-species logs, including diagonal branches in tall oak, and verifies natural leaves and soil before cutting. It rejects unloaded boundaries, connected trees with different grounded trunks, and 2×2 trunks. Its limits are 24 blocks of height, 6 blocks of horizontal reach from the root, and 192 connected logs. Supported log families are oak, birch, spruce, jungle, acacia, dark oak and cherry; only single-trunk trees qualify.

The skill harvests reachable selected logs from its current position first, then approaches a reachable surface rather than requiring the east neighbor of the root. If needed, it approaches and clears only selected logs or matching natural leaves within the selected tree bounds. Visible surface points are used before clearing a center-ray obstruction; a blocked east side alone does not end the job. Pillar bases still require exact standing positions.

Bring an axe, two free inventory slots, and dirt/cobblestone. Taller trees require a reserve at least as large as the highest log's height above the root. The skill climbs temporary single-block pillars, clears obstructing natural leaves, and removes pillars from the top down to return to soil. A branch pillar needs natural ground at the root's height. Pathfinder digging, bridging and towers are disabled: only the selected logs, obstructing matching natural leaves, and this call's recorded pillar blocks may be dug. Leaves that do not obstruct work remain to decay naturally; planting a replacement sapling is a separate task.

`status: "complete"` requires all selected logs and placed pillar blocks to be observed removed, this bot's log/pillar drop pickups to be confirmed, and the bot to be back on ground. Inspect `logsBroken`, `logsCollected`, `scaffoldPlaced`, `scaffoldRemoved`, `scaffoldRecovered`, `remainingLogs`, `leftoverScaffolds`, `grounded` and `reason`. Item merging uses the drop's current metadata at collection time. Failure attempts pillar cleanup while the operation is still active. Stop starts no further world changes; a cancelled result can contain pillar positions needing later recovery. Partial work is never reported as complete.

The offline `tests/tree_felling.test.cjs` covers ordinary and leaf-obscured tall branched trees, scope/load/material checks, merged drops, failed-placement cleanup and cancellation. Live verification details are in [the tree-felling record](docs/tree-felling-20261007.md). Surface interaction and east-blocked approach verification are recorded in [the surface interaction record](docs/surface-interaction-20261008.md). Adding source does not activate a new skill in an already-running manual-play bundle.

### Placement with a requested orientation

Oriented placement uses the pathfinder's existing interactive-support classification to choose posture. It normally stands on ordinary supports, crouches to bypass support activation or when face geometry requires it, and restores the original crouch state while it still owns the operation. This preserves ordinary adjacent-chest merging when placing on a floor; the caller must still observe both chest halves to verify a double chest.

Ask the bot to place a block with a world direction, for example “place a furnace facing north” or “place an upside-down stair facing west.” Generated code uses an options object as the sixth `placeBlock` argument:

```js
const placed = await skills.placeBlock(bot, 'oak_stairs', x, y, z, {
    facing: 'west', half: 'top'
});
if (!placed) {
    log(bot, 'Placement failed; inspect the reported state before continuing.');
    return;
}
```

| Option | Meaning |
|---|---|
| `facing` | Resulting Minecraft block state: `north` (-Z), `south` (+Z), `east` (+X), `west` (-X). Six-direction blocks also accept `up` / `down`. This specifies the block state; the helper chooses the bot's look direction. |
| `axis` | Log/wood/stem/hyphae axis: `x` (east-west), `y` (vertical), `z` (north-south). |
| `half` | Stairs/slabs occupying the `top` or `bottom` half. Slabs map this option to block state `type`. |
| `attachTo` | Side of the target containing its support: `bottom`, `top`, or a horizontal direction. An explicit support is required and never falls back to another side. |

For example, use `{axis:'x'}` for a horizontal log, or `{attachTo:'north', facing:'south'}` with inventory `torch` for a south-facing `wall_torch`. A wall `facing` can infer its required support. Button/lever `attachTo` selects wall, floor, or ceiling; floor/ceiling default to `bottom` when omitted. Unspecified look/axis/half choices use north, vertical, and bottom respectively, with axis/half adjusted for an explicit support. Only requested or implied state properties are checked; stair corner shape and waterlogging are not requested by this API.

| Block family | Supported orientation |
|---|---|
| Furnace, blast furnace, smoker, chest, trapped chest, repeater, comparator | Horizontal facing |
| Stairs / slabs | Stairs: horizontal facing and half; slabs: half |
| Logs, wood, stems, hyphae (including stripped variants) | Axis |
| Torch, soul torch, redstone torch and their wall names; ladder | Wall facing / support; torches also support the floor |
| Buttons / lever | Wall, floor, ceiling and horizontal facing |
| Observer, piston, sticky piston, dispenser, dropper | Six-direction facing; observer `facing` names its detecting face, while piston/dispenser/dropper name their output face |
| Doors / beds | Horizontal facing and confirmation of both halves/parts |
| Stone, cobblestone, dirt, crafting table, planks | Strict placement without orientation properties |

Literal commands can use `!placeBlockFacing("furnace", x, y, z, "north")`. Axis, half, and combined options use generated code through the existing natural-language action flow. The original `!placeHere(type)` and string `placeOn` calls retain their existing syntax and behavior. The seventh `dontCheat` argument also remains available.

Object placement returns `true` only when the loaded server state matches all required properties, including both door/bed blocks. An already matching target is a successful no-op and consumes no item. Occupied or differently oriented blocks return `false` without being broken or replaced; the output includes the observed state. Unloaded targets, incompatible options, missing support, unreachable placement faces, server refusal, confirmation timeout, and cancellation fail explicitly. The helper uses existing pathfinding without digging or scaffolding, checks transmitted yaw/pitch before placing, and restores its sneak/movement settings. Each call sends at most one normal placement and never automatically breaks or retries a wrong-facing result.

When cheat mode is explicitly enabled, object placement uses registry-validated `/setblock ... keep` commands and the same server-state confirmation. It does not enable cheat mode to work around normal-placement failure. Unsupported families/properties (for example rail shapes, sign rotation, door hinge, chest joining, or stair corner shape) are rejected before placement. A placement confirmation describes the observed moment; another player can later change the block. See [the placement verification record](docs/oriented-placement-20261006.md) for Minecraft 1.21.1 evidence and limits. Source updates require a separately selected play bundle to reach existing bots.

Stage-four navigation evidence is in [the D03 report](docs/navigation-progress-stage4-20261005.md); existing lifecycle admission and priority behavior is summarized in [the D07 report](docs/lifecycle-priority-stage4-20261005.md).

`goToSurface` searches loaded columns within 16 blocks for safe standing surfaces connected to an adjacent column at the same height or one block up/down. It reports success only after confirming the bot is on the support block with clear feet/head space, `onGround`, and a loaded connected standing neighbor; this avoids treating an isolated shaft as the surface. Native skills use fixed route policies from the SDK registry: ordinary work and target access preserve the route, `collectBlock` and `goToSurface` may dig and leave confirmed scaffolds, and combat/retreat can leave confirmed scaffolds but cannot dig. ただし観測された危険状態からの脱出中は生存を優先し、サーバー確認付きで採掘・足場設置を行ってから通常方針へ戻ります。 These rules also apply inside movement plugins; selected work targets retain their skill's own permissions and return values are unchanged. Recipes that need a crafting table first approach the selected loaded table and require a fresh `ready` surface interaction result before opening it. An unknown, blocked, or changed table target returns `false` without opening a crafting window; cancellation keeps the existing cancellation contract. See [the surface and crafting confirmation record](docs/surface-and-crafting-confirmation-20261010.md).

経路の足場設置は支持面へ視線を合わせてから、プレイヤーが設置先の上端を超えたことを確認して送信する。旋回待ちで送信時のクリアランス確認が古くなることを防ぐ。Navigation中の装備・採掘・設置が失敗した場合は、その移動が所有するgoalを解除し、元のエラーで終了する。pathfinderが装備失敗を内部で握りつぶす場合も、ジャンプ入力や設置中状態を保持したまま停滞させない。

つた・はしごの中で壁に当たるかジャンプ入力があると、バニラの物理では上昇する。pathfinderは同じ高さの移動でこれを想定せず、1ブロック未満の高さずれを到着とみなして前進を続けるため、意図せず登り続けることがあった。[`climbable_navigation.js`](src/agent/library/climbable_navigation.js) は全探索で同じ高さのまま登れるブロックへ入る移動にコスト2を加え、実行中は登れるブロック内で次ノードが上にない場合にジャンプ入力を、0.5ブロックを超えて上にずれた場合は前進・ダッシュ入力も解除して元の高さへ戻す。予定された登りは変えない。[fixture](tests/climbable_navigation.test.cjs) は実際のpathfinder探索での迂回と入力解除を確認する。

MindServer state polling is single-flight with a per-bot 750ms acknowledgement deadline and explicit fresh/stale/unknown state labels. Late state from a replaced connection or removed listener is discarded. Vision camera capture waits for a ready world view, permits one capture at a time, enforces a 2 MiB JPEG limit, and reports bounded shutdown drain status. See [the D13 lifecycle report](docs/state-polling-camera-lifecycle-stage4-20261005.md); offline fixtures do not measure live rendering performance.

World block helpers preserve Mineflayer's `null` result for unloaded blocks as unknown; they do not reinterpret it as air. Full-state and native Codex observations include an observation time, dimension, and separately labeled management connection/readiness metadata. The Minecraft world-connection generation remains unknown because the management socket generation does not identify a world connection. Place, break, and dig helpers reject a null target before starting the corresponding block mutation. See [the D08 observation report](docs/unknown-block-observation-stage4-20261005.md) for scope and limitations.

Native Codex sessions checkpoint the model's final text and generation time before memory handling; successful routing and its report time are recorded separately, followed by one task terminal. The turn is atomically saved in the existing `memory.json` format before any long natural-language summary runs. Native summaries are single-flight background work; a new intent or shutdown invalidates stale work without dropping pending turns. Existing `memory.json` loading remains supported, and task JSONL records are not automatically resumed. Trace write failures remain separate from memory-save status and are not described as persisted; see [the D10 checkpoint report](docs/long-summary-checkpoint-stage4-20261005.md).

Ollama model errors are surfaced as failures instead of ordinary answer text. `params.request_timeout_ms` sets the request timeout in milliseconds (default 120000); the reserved parameter is not sent to Ollama as a generation option. Cancellation reaches Ollama chat/vision fetches for coding, superseded conversations, vision, and memory summaries. Usage diagnostics include only provider-supplied prompt/completion counts and the request-start purpose/task/action scope; missing counts remain absent. Legacy Codex vision requests use the same owned-process cancellation and cleanup boundary as coding requests. See [the D11 model request report](docs/model-request-ownership-stage4-20261005.md).

`generated_code_fail_on_false` selects SDK functions whose `false` return throws inside generated newAction code; its default is empty, and direct skill/command boolean results keep their normal meaning. Navigation stall monitoring reads `navigation_stall_timeout_ms` and `navigation_check_interval_ms` when each path starts (defaults 8000 and 250). Goal-distance improvement, arrival at a new node in the active path, a completed dig, or a server-confirmed route placement counts as navigation progress; a path recalculation or revisiting the same node does not. While a dig is inside its own finite ground/look/break deadline (`bot.miningSync.activeDeadline()` from `mining_sync.js`), both the navigation clock and the native stall clock pause and restart when it ends; an expired deadline does not hold them. A stall fails with `NavigationStallTimeoutError` carrying `error.navigation` (`code: no_progress`, phase, final position, last path status), which reaches `skillResults`. `collectBlock` stops at its first approach or collection failure and reports that cause with the confirmed counts; `exploreUntilBlock` returns `blocked` with `no_progress` when a step stalls, turns only on `route_not_found`/`search_limit`, and raises other errors. A configured `generated_code_fail_on_false` error names the code and reason the skill reported. While phase is `navigation`, the native stall monitor uses that owned route progress instead of raw position changes, so an unresponsive path still hits the existing native stall limit. When a stopped action clears the navigation goal, the call fails with `ActionStopped` naming the stop reason (for example `stall`) instead of the pathfinder's `GoalChanged`. The operation hard timeout remains active. Navigation and smelting waits record their phase, reason, finite deadline and result under the owning SDK call. Smelting keeps its existing 11000ms quiet period, reset by a confirmed output. The legacy Codex CLI adapter forwards its selected profile model with `--model`; the native Codex session keeps its existing model negotiation. `src/agent/source_capabilities.json` lists individually versioned source features that runtime preparers may use to skip matching overlays; unsupported versions fail closed, and a declaration does not imply support for undeclared features.

Native generated code may use `communication.sendToBot(recipient, message)` in legacy or protected management. The hub stamps the sender from the bot's credential (protected) or from its registered agent socket (legacy); unregistered clients cannot send native peer messages. Its ACK means the recipient retained a bounded message in an already-active native task inbox; the message appears once as context on a following turn. When the recipient has no running task on the same connection, the message is queued (ACK `acceptance: receiver-next-task`) and delivered as context on its next task's first turn; a reconnect discards it. The operator `context` CLI uses the existing operator management boundary and the same task inbox for factual updates in legacy or protected management. Both preserve the original task and do not confirm that the recipient acted. The current task ID, message ID and content are checked; same-ID/same-content retries dedupe, while conflicting content and stale task scopes are rejected. Normal completion closes admission and drains accepted messages into another judgment turn before reporting. Host events such as a death report enter the same inbox as `system` context, so the running task sees them on its next turn. Stop, task replacement, management replacement, and completion discard the running task's queued messages; messages arriving after completion go to the next task. Legacy bot conversations keep their existing chat route. Per-process message and dispatch-ID retention has finite caps and fails closed when full; it does not provide crash recovery or exactly-once delivery. Offline fixtures do not measure gameplay benefit.

The native bot's basic instructions and common gameplay policy live in [`src/process/codex/AGENTS.md`](src/process/codex/AGENTS.md). CodexSession copies the bundle's file into its dedicated workspace at each new task or thread resume, adds the generated SDK method catalog, and uses Codex's standard workspace instruction loader. There is no separate rules file, configuration key, CLI option, or per-decision policy injection. Edit the bot file in source and update the manual bot bundle to activate it; edits to a bundle's instruction file are read at its next session start or resume. Instructions guide the model and do not mechanically enforce game actions. This repository's root `AGENTS.md` contains development instructions and is not passed to the bot.

This repository is the `hashtagakiaki/mindcraft` development fork used as the source owner for craft synchronization, farm skills, and server-confirmed mining. The `autonomy` branch is the fork's default branch and starts from upstream stable commit `b36eaf7e61b3f6bd031fdb531812b2e3c42b6c73`. Evaluation exports the full SHA pinned in `mindcraft-eval/mindcraft-source.json`; manual play exports its independent pin in `play/mindcraft-source.json` through [mindcraft-tools](../mindcraft-tools/README.md). Craft synchronization, `tendNearbyFarm`, and mining sync are maintained here as normal source; play overlays are owned by `mindcraft-tools`.

Recipes that need a crafting table are not sent to the player inventory's 2×2 grid unless a table is found after placement or already present nearby. If table placement fails and no table is observed, `craftRecipe` returns `false` before moving ingredients. Before using an observed table, it also requires a fresh reachable-surface approach and rechecks that the same loaded block is still a crafting table; movement failure never proceeds to window activation.

When Mineflayer's packet parser raises `PartialReadError`, the bot records up to eight distinct failing inbound frames per process at `bots/<bot>/logs/partial-read-errors.jsonl`. Records include the protocol state, packet ID when readable, frame length and SHA-256, a frame capture (up to 256 KiB), and the parser stack. These files are private runtime data and may contain item metadata or book text; do not commit or share them without inspecting and redacting the contents.

`tillAndSow` accepts a seed item name or a supported crop name (for example, `wheat` maps to `wheat_seeds`). In both survival and cheat modes it reports planting success only after the requested crop is observed; an existing different crop is not treated as success. Farm harvest counts require the target block to become air and this bot to collect a matching nearby drop. Bucket interactions require the expected inventory change, and bucket placement also checks the destination block. Door traversal waits for the open state, and lethal attacks report success only for the target entity's death event.

`tendNearbyFarm(bot, options = {})` defaults to one connected plot: it selects the nearest farmland within `searchRadius` (default 32), then follows all same-height edge-adjacent farmland, including empty soil. Water gaps and diagonal contacts do not connect plots. The selected plot can extend beyond `searchRadius`; an unloaded boundary throws before work starts. Use `startPosition: {x, y, z}` to select a particular farmland block. Use `{scope: 'radius', radius: 32}` to tend all farmland within a working radius instead. `radius` is only valid for radius scope; `searchRadius` and `startPosition` are only valid for connected scope. Both modes accept `seedReserve` (default 1) and `chestPosition`; legacy bot-first calls without chest coordinates select a nearby chest within 32 blocks, while the native facade keeps harvested items in inventory unless an exact `chestPosition` is supplied. One call performs one cycle and returns confirmed `{harvested, planted, stored}` counts; missing seeds or unreachable crops are not a claim of completion. This options object replaces the old positional arguments.

For local development, keep this full-history clone separate from the read-only upstream checkout at `mindcraft-eval/runtime/upstream`. Reuse the existing compatible `node_modules` only as a read-only dependency input; do not run `npm install`, `npm ci`, or postinstall in the shared dependency tree. See [AGENTS.md](AGENTS.md) for repository, runtime, and live-server boundaries.

Optional shared place memory is configured at MindServer startup in the root `settings.js` with both `place_state_dir` (an absolute path) and `place_world_id` (a UUID). Leave both `null` to keep place memory disabled. These are process-wide settings and are not editable through individual agent settings; agent processes receive only the enabled flag and world ID, not the state path. MindServer stores each namespace in `place_state_dir/worlds/<place_world_id>.json`; place state loads independently of `load_memory` and survives bundle changes that reuse the same state root and world ID. Changing the world ID selects a separate ledger and keeps the prior ledger. The state root has an exclusive `.place-store.lock`; only one MindServer may use that root at once. Normal SIGINT/SIGTERM and UI shutdown release the lock. After a crash, the next MindServer start reclaims the lock only when the process recorded in it no longer exists; a live owner, an unreadable lock, or a lock without a PID still fails with `STORE_LOCKED`. Never remove a lock while a writer may be active.

Saved places can be searched with `!findPlace("forest")`, inspected by stable ID with `!inspectPlace("<id>")`, and visited with `!goToPlace("<id>")`. `!rememberHere("name")` keeps its existing syntax and records the bot's current point as observed when persistent memory is enabled; otherwise it remains a session bookmark. `!recordPlaceHere("name", "shelter")` records a general point and purpose. A `base` record is a representative point, not proof that a structure exists around it. Use `!recordPlaceBlock("name", "farm", "food", x, y, z)` for a loaded target block; farm records require farmland and storage records require a chest or trapped chest. `!recordReportedPlace(...)` explicitly stores user-provided coordinates as unverified. Place IDs, personal aliases, home preferences, death bookmarks, observation timestamps, and explicit output-storage relations survive restart. Ambiguous search results must be selected by ID. Persistent travel checks dimension and reports the adapter's actual movement result; reaching an unverified coordinate does not make the place observed. Related storage must have the same dimension. NewAction receives only a limited async `places` SDK (search, inspect, record, verify, travel, farm, relation, and personal alias operations), never the RPC socket or state path. Useful resource locations should be recorded only from the bot's current position or a loaded target block matching the place kind; stale and user-reported coordinates remain visibly unverified until checked.

Run the offline craft, farm, mining, navigation, interaction, cancellation, furnace, management-reconnect, and process-lifecycle fixtures with `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs`. The runner builds disposable fixtures and does not start Minecraft, call an LLM API, or modify shared dependencies. Test-only dependency resolution prefers `node_modules` inside the source/runtime root and falls back to the read-only eval upstream tree in the development checkout. The mining fixture uses real Mineflayer digging, plugin loader, Block, and Tool implementations and checks target air plus this bot's server `playerCollect` event. Farm harvesting, planting, reserve handling, and chest storage, as well as bucket, door, and combat interactions, use mocks; eval's live smoke only invokes the farm skill in a surveyed no-target area. Furnace tests use actual Mineflayer inventory/furnace plugins. Process tests spawn only disposable fixture-owned Node processes and clean them up in `finally`. Shutdown fixtures exercise actual `Agent.shutdown` and `ActionManager` behavior, task and Cooking setup guards, init signal/IPC handling, parent supervisor task-ending and owned-process cleanup, and MindServer hub/PlaceStore drain and close behavior. They distinguish successful task completion (exit code 0), retained abnormal exit codes, owned-process cleanup results, and shutdown-record save failures.

The aggregate runner captures each child fixture's combined stdout/stderr in a temporary file. Successful fixtures print one summary line; a failed fixture prints its full captured output, reports the child exit code or signal, and fails the suite. Directly running an individual fixture still prints its own diagnostics.

An eval-owned isolated CaseServer smoke on 2026-10-02, using source pin `d549e73` ([eval smoke record](https://github.com/hashtagakiaki/mindcraft-eval#verify-crafting-synchronization)), verified same-connection smelt→craft→equip with a disposable world and direct skill calls (without background mode control): smelt one ingot, fill all 36 storage slots, abort after opening a furnace with confirmed inventory and no residue, then craft a shield and auto-equip it in the offhand. The bot kept the same PID and login, spawned once, did not end, and the Minecraft connection remained open. Other covered cases included tree crafting/recovery, a no-op farm target, and crafting with the tool-break-recovery template. Templates, shared dependencies, and the previous runtime hash remained unchanged, and all three owned client/server processes were cleaned up. This isolated skill smoke does not verify production play, full Agent orchestration, or LLM-driven behavior; offline fixtures and the isolated live smoke describe separate scopes.

### Action cancellation and reconnect behavior

移動中断は所有するpathfinder goalを直ちに解除し、実際の`goto`終了と子操作のsettleを待ってから後続actionへ移る。次の経路地点まで待つsoft stopで、移動不能時の停止待ちを継続しない。停止watchdog自体は維持し、発火時の`action_stop_watchdog`と`agent_shutdown_started`で理由・task/action・割込を追跡できる。

管理状態の`taskAdmission`はworker受付可能性、拒否理由、worker/runtime/intentのtask IDと現在actionを返す。`action.isIdle`はゲーム操作の状態であり、推論や受付処理の終了を意味しない。`action.phase`は`acting`（SDK actionを実行中）、`thinking`（native task中でSDK actionの間、つまり推論待ち）、`idle`（どちらでもない）を返し、管理UIのaction欄はこれで表示を分ける。task-startの拒否理由は`outcome.admission`にも保存し、task-readで照会できる。受付不明・未settleの任務を重複実行しない契約は維持する。

native操作結果の`operationsWithoutProgress`は確認済みの変更や移動進捗がない連続操作数を返し、3回以降はモデルへ進捗の見直しを促す。観測による新情報の取得を認め、追加の回数制限・強制終了・任務差替えは行わない。container開封失敗は元の例外に対象、操作面、上部ブロック、sneak/手持ち等の観測を添える。操作面への到達や起動要求の成功は開封・精錬の成功とは区別する。

自己防衛 `defendSelf` は50msごとに近い脅威を選び直し、複数の敵すべてから距離を取る移動と攻撃を一つの戦闘ループで管理する。対象切替では既存PVPの武器別攻撃間隔を守り、PVPが設定する追従目標を戦闘用の移動目標へ置き換える。新しい敵は指定radius内で受け入れ、交戦済みの敵は `max(radius,24)` ブロック以内で追跡する。吹き飛ばしや退避で索敵範囲を出ただけでは中断しない。死亡確認後も1.5秒間は分裂などによる追加の敵を確認し、全対象の死亡を確認してから成功する。消失だけ・自分の死亡・切断・取消は成功扱いせず、終了時に戦闘目標と専用listenerを解除する。明示攻撃 `attackEntity` も同じ処理を使うが、攻撃対象は指定されたEntityだけとする。武器・防具は必須ではなく、自己防衛中のドロップ回収は行わない。経路編集方針と足場設置後の装備復元は維持する。

`cowardice` が退避の対象にするのは差し迫った敵だけである。クリーパーは7ブロック以内、見通しのある遠隔攻撃の敵は直近3秒以内に被弾したかHP10未満のときに限り、近接の敵は経路で到達できる8ブロック以内（`self_defense` が反撃する距離と同じ）とする。2026-10-28のplayでは近接の敵による退避310件のうち271件が8ブロック超の敵で、作業が中断され続けた。対象外の敵では実行中の行動を中断しない。`cowardice` と `self_defense` が両方有効なら、HP10以上・空腹度6超で、ゾンビ（子供を含む）、ハスク、村人ゾンビ、地上のドラウンド、クモへ共通の条件で反撃する。HP20なら最大3体、HP20未満なら単独を対象とする。退避対象の敵全てがこの種類で、手にアイテムを持たず、既知の乾いた地面にいて、自分も泳いでおらず、自己防衛が一時停止されていないことが条件。毒・遠隔・爆発を持つ敵、武器持ち、水中、これを超える群れや低体力では退避を選ぶ。これは自動modeの開始判断であり、SDKの `defendSelf` 自体には3体の上限を設けない。

自動modeの遭遇判断と `avoidEnemies` は、敵からbotへの接近経路を採掘・足場・タワー・パルクールなしで最大25msずつ探索する。壁や高低差で接近できない敵を距離だけで退避対象にせず、遠隔・飛行型の敵は読み込み済みブロックによる射線も確認する。探索が未完了なら接近可能とは判定しない。これは読み込み済み地形と通常歩行モデルによる判定で、敵固有の全移動能力を再現するものではない。`isClearPath` も足場を使わない経路だけを成功とする。

`avoidEnemies` は対象全体から離れる一つの目標を使い、敵の位置がマスをまたいだときに更新する。最寄りの敵だけを交互に避けたり、退避中に敵を追って攻撃したりしない。経路探索の失敗、5秒間距離を稼げない状態、または30秒の上限で `false` を返し、取消を含め終了時には移動目標とlistenerを解除する。自動退避が失敗した場合は、その場の位置、近傍地形、最終被弾時刻、または退避対象の敵の顔ぶれが変わるまで同じ退避や自己防衛で作業を再中断しない。追ってくる敵は毎tick位置が変わり、自然回復でHPも変わるため、これらを条件に含めると失敗した退避の再試行が繰り返された（2026-10-28のplayで約400回）。ただし退避に失敗した後でも、敵が3ブロック以内に来たら `self_defense` が反撃する。逃げられない状態で殴られ続けないためである。[退避fixture](tests/enemy_retreat.test.cjs) は実際のpathfinderによる壁・足場・高低差・複数敵の経路と、射線・進捗停止・取消を確認する。自動modeの再試行条件は [recovery fixture](tests/recovery_replanning.test.cjs) で確認する。

全actionを中断する危険対応mode（`self_preservation`、`cowardice`、`self_defense`）の実行中に、Codexのコードやコマンドなどmode以外のactionが届いても、その反射行動は上書きされない。届いたactionは反射行動の終了を待ってから開始し、待機開始時に `action_waiting_for_reflex` を記録する。2026-10-28のplayでは、退避・反撃・瀕死退避の計152件が、Codexの次のコードに上書きされて途中で止まっていた。mode同士の優先順位、`stop()` による停止、operatorの新しい指示によるepochの更新は従来どおり反射行動より優先する。[action manager fixture](tests/action_manager.test.cjs) で確認する。

overworldの夜（`timeOfDay` 12541〜23458）は1晩に1回だけ扱う。Codex taskが動いていればそのtaskへ日没を1回通知し、寝るか作業を続けるかはbotが判断する。通知した夜は、その後待機に戻っても自動では寝ない。待機中なら `sleeping` modeが作業に割り込まずに `skills.skipNight` を実行し、model turnは始めない。ベッドに入る前に失敗したら30秒後に再試行し、ベッドに入った時点でその夜は終わる。profileの `modes.sleeping: false` で通知と自動睡眠の両方を止める。`skipNight` は64ブロック以内の置かれたベッドを使い、なければ持っているベッドを6ブロック以内の空いた床に置いて、起きた後に回収する。設置は草のない床を優先し、草しかなければ刈ってから置く。再試行では毎回別のマスを使う（隔離serverで草のマスへの設置が拒否され、同じマスで向きを変えた再試行が移動停止で90秒止まったため）。ドロップ品の出現は破壊の確認より遅れるので、回収は最大3秒待つ。60秒で夜が明けなければ起きて `night_not_skipped` を返す。[skip night fixture](tests/skip_night.test.cjs) で確認する。

`collectBlock` は通常ブロックでも mineflayer-collectblock の `collect()` を使わず、移動（鉱石は `GoalNear` 2、その他は `GoalLookAtBlock`）、道具の装備、`bot.dig`、`pickupNearbyItems` を順に実行する。プラグインの `collect()` はドロップの消失を期限も取消もなく待つため、2026-10-28のplayでは土の採取が2回止まり、停止watchdogによるbot再起動に至った。

auto-eatの設定（`foodPoints` 優先、空腹度14以下で開始、除外食料）はプラグインの既定値に上書きして足す。以前はoptionsをオブジェクトごと置き換えていたため `eatingTimeout` などが消え、食事が完了前に打ち切られていた。

2026-10-22の隔離vanilla 1.21.1 / Normalで、素手・防具なし・自然回復なしの単独戦と複数戦を確認した。旧処理ではゾンビ2体で死亡したが、新処理では2体・3体やクモとの混在を討伐できた。条件別の勝敗・残HPと限界は[戦闘検証記録](docs/melee-combat-20261022.md)を参照。個別の少数試行であり、全地形・全敵編成の勝率を保証する結果ではない。

The `unstuck` mode has been removed. Staying at the same position no longer interrupts an action or starts an automatic escape movement. Mode listings and default profiles omit it; existing saved `unstuck` settings are ignored. Navigation progress checks and action deadlines still apply.

Normal successful work, including smelting and furnace clearing, keeps the current Minecraft connection. A cooperative stop also keeps that connection. `!stop` suppresses automatic resume and goal retries; a later explicit user instruction may start new work after the old action settles. A replacement instruction waits for the prior action to settle before its body can mutate the world.

Timeouts, movement stalls, and rapid repeated failures request a bounded stop and recovery. When the old action settles safely, the bot checks confirmed state and tries one recovery/replan; unchanged repeated failures do not loop indefinitely. At the recovery limit, it pauses and reports the blocker while staying connected. A management-socket disconnect also pauses work; after Socket.IO reconnect, settings and place namespace are checked before registration and login resume, and autonomous/action execution stays gated until a fresh explicit human instruction arrives. Old commands and uncertain RPC mutations are not replayed. An interrupted container transaction (for example a death or a lost furnace window during smelting) marks the inventory unconfirmed; the next action first takes a fresh full player-inventory snapshot and runs only if it succeeds, instead of rejecting every action as `inventory-unconfirmed` until reconnect. The furnace is observed again by the next smelt. A process restart sends the bot a notice asking it to continue the interrupted operator request from current state, rather than a bare restart message that it would report as a finished goal.

LLM cancellation is a programmatic request cancellation, not a natural-language request for the model to stop. Cancelled or stale responses and staged code cannot execute. The Codex adapter waits for its registered helper/CLI process group to close before removing the request directory; process ownership guarantees apply to groups recorded by the live bot supervisor. An unsupported provider may continue computing remotely, but its stale answer is discarded.

The MindCraft UI's `Last Message` field shows each bot's latest outgoing reply, including replies sent as whispers to the configured allowed players.

Minecraft reconnect is reserved for an already lost connection, an old action/process that cannot be safely stopped or isolated, or an explicit restart initiated by a literal human `!restart` command or the management UI. LLM-generated `!restart` is rejected; recovery prompts are told not to restart. A normal success, cooperative cancellation, recovery attempt, or temporary management-socket loss does not reconnect the bot. A forced stop is reported as a stop failure until the old action or owned process is actually gone; a timeout or race alone is not treated as proof of settlement.

Mining sync corrects affected block-instance material data per bot so Mineflayer, Tool, and pathfinder use consistent pickaxe speeds without changing shared registries. It requires a reachable, current target; waits a bounded time for ground contact where applicable; and treats server block updates as authoritative for break completion. Collection requires both target-block air and a server `playerCollect` event for a tracked expected drop near that block. See [the investigation and implementation record](docs/mining-investigation-2026-09-30.md) for offline and isolated live results.

To publish a source update, make the source change on `autonomy`, run the offline test command, and push the reviewed commit to this fork. Then update the eval manifest to that exact full SHA and run the eval tests and isolated live smoke against the pin. Review and commit/push the eval change after those checks, then prepare a new play bundle. Keep the eval dependency tree read-only; do not reinstall packages as part of a source-only update. Bot-only activation follows the applicable project instructions. For changes originating in this parent project, its continuing instruction authorizes apply after the required checks and push; it preserves the Minecraft server, world and saved memory/thread, and keeps Ollama stopped while `codex-session` is selected.

### Group operator instructions

In Minecraft public chat, use `@all gather wood` to instruct every connected, in-game bot, or `@Bot2,@Bot3 gather wood` to instruct a group. `@Bot2 @Bot3 ...` and `@Bot2,Bot3 ...` also work; names are case-insensitive and duplicates are removed. Addressing must be at the start, followed by whitespace and the instruction. Unknown names, an explicitly named disconnected bot, or mixing `@all` with names rejects the message. Ordinary individual whispers and the existing single-bot public-chat behavior remain supported. The `only_chat_with` allowlist still applies.

The UI is a chat view with a bot status column. Right-click the chat (or a status card), or tap/click the recipient button above the input, to open the recipient menu; it lists every bot with a check mark and stays open so several bots can be toggled, and offers **Select all connected** and **Clear selection**. Shift+right-click keeps the browser menu, and a touch long-press in the input keeps the native paste menu. On phones, use the recipient button. Narrow screens (900px or less) show Chat and Bots as separate tabs, with an unread count on Chat; the bulk Disconnect/Shutdown/New Agent buttons appear on the Bots tab. The page is sized to the visible viewport so the on-screen keyboard keeps the latest messages and the composer in view, the input uses a 16px font to avoid iOS focus zoom and grows with its text, and tapping Send keeps the keyboard open. Clicking or tapping a status card outside its buttons also toggles that bot. The composer shows the current recipients; Enter sends to all of them and Shift+Enter inserts a newline. Sent operator messages appear in the chat beside bot replies for that page session only; the server history still holds only bot replies. Stop/Stay and lifecycle buttons on the status cards keep their individual-bot scope. An explicit address prefix in a message overrides the selection and can be sent without one. Disconnected or removed bots are dropped from the selection. Successful UI sends display the resolved recipient names; errors retain the input. `@all` resolves the connected bots at send time. Explicit selections are validated together before dispatch, so an invalid selection is not partly sent. This is simultaneous dispatch, not synchronized action starts or guaranteed delivery through a later disconnect; management recovery does not replay instructions.

Every recipient receives the same instruction plus the full recipient list, recorded as operator context in its history before handling the instruction. This lets bots know who else was instructed and coordinate when useful; it does not itself allocate roles or prove that others completed the work. Literal commands such as `@all !stop` retain their normal command semantics. Existing bot-conversation routing is separate from operator addressing.

<h1 align="center">
  <a href="https://trendshift.io/repositories/9163" target="_blank"><img src="https://trendshift.io/api/badge/repositories/9163" alt="kolbytn%2Fmindcraft | Trendshift" style="width: 250px; height: 55px;" width="250" height="55"/></a>
</h1>

<p align="center">Crafting minds for Minecraft with LLMs and <a href="https://prismarinejs.github.io/mineflayer/#/">Mineflayer!</a></p>

<p align="center">
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md">FAQ</a> | 
  <a href="https://discord.gg/mp73p35dzC">Discord Support</a> | 
  <a href="https://www.youtube.com/watch?v=gRotoL8P8D8">Video Tutorial</a> | 
  <a href="https://kolbynottingham.com/mindcraft/">Blog Post</a> | 
  <a href="https://mindcraft-minecollab.github.io/index.html">Paper Website</a> | 
  <a href="https://github.com/mindcraft-bots/mindcraft/blob/main/minecollab.md">MineCollab</a>
</p>

> [!Caution]
Do not connect this bot to public servers with coding enabled. This project allows an LLM to write/execute code on your computer. The code is sandboxed, but still vulnerable to injection attacks. Code writing is disabled by default, you can enable it by setting `allow_insecure_coding` to `true` in `settings.js`. Ye be warned.

# Getting Started
## Requirements

- [Minecraft Java Edition](https://www.minecraft.net/en-us/store/minecraft-java-bedrock-edition-pc) (up to v1.21.11, recommend v1.21.6)
- [Node.js Installed](https://nodejs.org/) (Node v18 or v20 LTS recommended. Node v24+ may cause issues with native dependencies)
- At least one API key from a supported API provider. See [supported APIs](#model-customization). OpenAI is the default.

> [!Important]
> If installing node on windows, ensure you check `Automatically install the necessary tools`
>
> If you encounter `npm install` errors on macOS, see the [FAQ](FAQ.md#common-issues) for troubleshooting native module build issues

## Install and Run

1. Make sure you have the requirements above.

2. Download the [latest release](https://github.com/mindcraft-bots/mindcraft/releases/latest) and unzip it, or clone the repository.

3. Rename `keys.example.json` to `keys.json` and fill in your API keys (you only need one). The desired model is set in `andy.json` or other profiles. For other models refer to the table below.

4. In terminal/command prompt, run `npm install` from the installed directory

5. Start a minecraft world and open it to LAN on localhost port `55916`

6. Run `node main.js` from the installed directory

If you encounter issues, check the [FAQ](https://github.com/mindcraft-bots/mindcraft/blob/main/FAQ.md) or find support on [discord](https://discord.gg/mp73p35dzC). We are currently not very responsive to github issues. To run tasks please refer to [Minecollab Instructions](minecollab.md#installation)


# Configuration
## MindServer management access

MindServer keeps its historical unauthenticated local control behavior when `management_auth_mode` is `legacy` (the default). Launchers that advertise the `management-auth-bootstrap` source capability can select `protected`. Protected mode requires `MINDCRAFT_SESSION_FILE` to point outside `src/mindcraft/public`, inside a directory accessible only to its owner. MindServer creates that file with mode `0600`, containing separate operator and read-only observer tokens; it refuses to replace an existing file and removes its own file during graceful shutdown.

The operator UI stores the operator token in that browser profile's `localStorage` after entry, so page reloads do not prompt again. Use **Forget saved token** to remove it. The token is readable by scripts running on the UI origin, so use this only in a browser profile you control; the server-side session file remains private and bundle-scoped. Do not paste the token into settings, profiles, shell history, logs, or source files. Agent processes receive distinct, spawn-bound bot tokens over their existing private parent-child IPC channel; reconnects within a spawn keep the token, while stopping or replacing a spawn revokes it. Protected Socket.IO clients must authenticate at connection and management handlers derive the sender from the authenticated identity. An observer can call named `readiness` only and receives no agent status or viewer-port broadcasts. A process signal triggers graceful agent and hub cleanup; after a crash, a stale private session file is unusable with a new hub and must not be copied or reused. A new bundle creates a new operator token, so the saved browser token must be replaced after a bundle update.

The explicit Python API option is `Mindcraft.init(port=8080, session_file="/private/path/session.json")`. Benchmark and play launchers create a fresh private session path per run/bundle and select protected mode only for a verified source capability. A source checkout without that capability remains on the legacy path.

## Model Customization

You can configure project details in `settings.js`. [See file.](settings.js)

You can configure the agent's name, model, and prompts in their profile like `andy.json`. The model can be specified with the `model` field, with values like `model: "gemini-2.5-pro"`. You will need the correct API key for the API provider you choose. See all supported APIs below.

<details>
<summary><strong>⭐ VIEW SUPPORTED APIs ⭐</strong></summary>

| API Name | Config Variable| Docs |
|------|------|------|
| `openai` | `OPENAI_API_KEY` | [docs](https://platform.openai.com/docs/models) |
| `google` | `GEMINI_API_KEY` | [docs](https://ai.google.dev/gemini-api/docs/models/gemini) |
| `anthropic` | `ANTHROPIC_API_KEY` | [docs](https://docs.anthropic.com/claude/docs/models-overview) |
| `xai` | `XAI_API_KEY` | [docs](https://docs.x.ai/docs) |
| `deepseek` | `DEEPSEEK_API_KEY` | [docs](https://api-docs.deepseek.com/) |
| `ollama` (local) | n/a | [docs](https://ollama.com/library) |
| `qwen` | `QWEN_API_KEY` | [Intl.](https://www.alibabacloud.com/help/en/model-studio/developer-reference/use-qwen-by-calling-api)/[cn](https://help.aliyun.com/zh/model-studio/getting-started/models) |
| `mistral` | `MISTRAL_API_KEY` | [docs](https://docs.mistral.ai/getting-started/models/models_overview/) |
| `replicate` | `REPLICATE_API_KEY` | [docs](https://replicate.com/collections/language-models) |
| `groq` (not grok) | `GROQCLOUD_API_KEY` | [docs](https://console.groq.com/docs/models) |
| `huggingface` | `HUGGINGFACE_API_KEY` | [docs](https://huggingface.co/models) |
| `novita` | `NOVITA_API_KEY` | [docs](https://novita.ai/model-api/product/llm-api?utm_source=github_mindcraft&utm_medium=github_readme&utm_campaign=link) |
| `openrouter` | `OPENROUTER_API_KEY` | [docs](https://openrouter.ai/models) |
| `glhf` | `GHLF_API_KEY` | [docs](https://glhf.chat/user-settings/api) |
| `hyperbolic` | `HYPERBOLIC_API_KEY` | [docs](https://docs.hyperbolic.xyz/docs/getting-started) |
| `vllm` | n/a | n/a |
| `cerebras` | `CEREBRAS_API_KEY` | [docs](https://inference-docs.cerebras.ai/introduction) |
| `mercury` | `MERCURY_API_KEY` | [docs](https://www.inceptionlabs.ai/) |

</details>

For more comprehensive model configuration and syntax, see [Model Specifications](#model-specifications).

For local models we support [ollama](https://ollama.com/) and we provide our own finetuned models for you to use. 
To install our models, install ollama and run the following terminal command:
```bash
ollama pull sweaterdog/andy-4:micro-q8_0 && ollama pull embeddinggemma
```

## Online Servers
To connect to online servers your bot will need an official Microsoft/Minecraft account. You can use your own personal one, but will need another account if you want to connect too and play with it. To connect, change these lines in `settings.js`:
```javascript
"host": "111.222.333.444",
"port": 55920,
"auth": "microsoft",

// rest is same...
```
> [!Important]
> The bot's name in the profile.json must exactly match the Minecraft profile name! Otherwise the bot will spam talk to itself.

To use different accounts, Mindcraft will connect with the account that the Minecraft launcher is currently using. You can switch accounts in the launcher, then run `node main.js`, then switch to your main account after the bot has connected.

## Tasks

Tasks automatically start the bot with a prompt and a goal item to aquire or blueprint to construct. To run a simple task that involves collecting 4 oak_logs run 

`node main.js --task_path tasks/basic/single_agent.json --task_id gather_oak_logs`

Here is an example task json format: 

```
{
    "gather_oak_logs": {
      "goal": "Collect at least four logs",
      "initial_inventory": {
        "0": {
          "wooden_axe": 1
        }
      },
      "agent_count": 1,
      "target": "oak_log",
      "number_of_target": 4,
      "type": "techtree",
      "max_depth": 1,
      "depth": 0,
      "timeout": 300,
      "blocked_actions": {
        "0": [],
        "1": []
      },
      "missing_items": [],
      "requires_ctable": false
    }
}
```

The `initial_inventory` is what the bot will have at the start of the episode, `target` refers to the target item and `number_of_target` refers to the number of target items the agent needs to collect to successfully complete the task. 

If you want more optimization and automatic launching of the minecraft world, you will need to follow the instructions in [Minecollab Instructions](minecollab.md#installation)

## Docker Container

If you intend to `allow_insecure_coding`, it is a good idea to run the app in a docker container to reduce risks of running unknown code. This is strongly recommended before connecting to remote servers, although still does not guarantee complete safety.

```bash
docker build -t mindcraft . && docker run --rm --add-host=host.docker.internal:host-gateway -p 8080:8080 -p 12000-12010:12000-12010 -e SETTINGS_JSON='{"auto_open_ui":false,"profiles":["./profiles/gemini.json"],"host":"host.docker.internal"}' --volume ./keys.json:/app/keys.json --name mindcraft mindcraft
```
or simply
```bash
docker-compose up --build
```

When running in docker, if you want the bot to join your local minecraft server, you have to use a special host address `host.docker.internal` to call your localhost from inside your docker container. Put this into your [settings.js](settings.js):

```javascript
"host": "host.docker.internal", // instead of "localhost", to join your local minecraft from inside the docker container
```

To connect to an unsupported minecraft version, you can try to use [viaproxy](services/viaproxy/README.md)

# Bot Profiles

Bot profiles are json files (such as `andy.json`) that define:

1. Bot backend LLMs to use for talking, coding, and embedding.
2. Prompts used to influence the bot's behavior.
3. Examples help the bot perform tasks.

## Model Specifications

LLM models can be specified simply as `"model": "gpt-4o"`, or more specifically with `"{api}/{model}"`, like `"openrouter/google/gemini-2.5-pro"`. See all supported APIs [here](#model-customization).

The `model` field can be a string or an object. A model object must specify an `api`, and optionally a `model`, `url`, and additional `params`. You can also use different models/providers for chatting, coding, vision, embedding, and voice synthesis. See the example below.

```json
"model": {
  "api": "openai",
  "model": "gpt-4o",
  "url": "https://api.openai.com/v1/",
  "params": {
    "max_tokens": 1000,
    "temperature": 1
  }
},
"code_model": {
  "api": "openai",
  "model": "gpt-4",
  "url": "https://api.openai.com/v1/"
},
"vision_model": {
  "api": "openai",
  "model": "gpt-4o",
  "url": "https://api.openai.com/v1/"
},
"embedding": {
  "api": "openai",
  "url": "https://api.openai.com/v1/",
  "model": "text-embedding-ada-002"
},
"speak_model": "openai/tts-1/echo"
```

`model` is used for chat, `code_model` is used for newAction coding, `vision_model` is used for image interpretation, `embedding` is used to embed text for example selection, and `speak_model` is used for voice synthesis. `model` will be used by default for all other models if not specified. Not all APIs support embeddings, vision, or voice synthesis.

All apis have default models and urls, so those fields are optional. The `params` field is optional and can be used to specify additional parameters for the model. It accepts any key-value pairs supported by the api. Is not supported for embedding models.

## Embedding Models

Embedding models are used to embed and efficiently select relevant examples for conversation and coding.

Supported Embedding APIs: `openai`, `google`, `replicate`, `huggingface`, `novita`

If you try to use an unsupported model, then it will default to a simple word-overlap method. Expect reduced performance. We recommend using supported embedding APIs.

## Voice Synthesis Models

Voice synthesis models are used to narrate bot responses and specified with `speak_model`. This field is parsed differently than other models and only supports strings formatted as `"{api}/{model}/{voice}"`, like `"openai/tts-1/echo"`. We only support `openai` and `google` for voice synthesis.

## Specifying Profiles via Command Line

By default, the program will use the profiles specified in `settings.js`. You can specify one or more agent profiles using the `--profiles` argument: `node main.js --profiles ./profiles/andy.json ./profiles/jill.json`


# Contributing

We welcome contributions to the project! We are generally less responsive to github issues, and more responsive to pull requests. Join the [discord](https://discord.gg/mp73p35dzC) for more active support and direction.

While AI generated code is allowed, please vet it carefully. Submitting tons of sloppy code and documentation actively harms development.

## Patches

Some of the node modules that we depend on have bugs in them. To add a patch, change your local node module file and run `npx patch-package [package-name]`

## Development Team
Thanks to all who contributed to the project, especially the official development team: [@MaxRobinsonTheGreat](https://github.com/MaxRobinsonTheGreat), [@kolbytn](https://github.com/kolbytn), [@icwhite](https://github.com/icwhite), [@Sweaterdog](https://github.com/Sweaterdog), [@Ninot1Quyi](https://github.com/Ninot1Quyi), [@riqvip](https://github.com/riqvip), [@uukelele-scratch](https://github.com/uukelele-scratch), [@mrelmida](https://github.com/mrelmida)


## Citation:
This work is published in the paper [Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning](https://arxiv.org/abs/2504.17950). Please use this citation if you use this project in your research:
```
@article{mindcraft2025,
  title = {Collaborating Action by Action: A Multi-agent LLM Framework for Embodied Reasoning},
  author = {White*, Isadora and Nottingham*, Kolby and Maniar, Ayush and Robinson, Max and Lillemark, Hansen and Maheshwari, Mehul and Qin, Lianhui and Ammanabrolu, Prithviraj},
  journal = {arXiv preprint arXiv:2504.17950},
  year = {2025},
  url = {https://arxiv.org/abs/2504.17950},
}
```


## Opt-in Codex task session

The [20×20 terrain trial](https://github.com/hashtagakiaki/mindcraft-eval/blob/main/docs/compound-loop-20261009.md) records the compound-loop checks, a failed protection attempt and its correction. The final trial completed all 400 columns with no protected changes, using 82 operations versus 179 for the baseline; total time fell from 16m35s to 14m58s. These are single trials, not a success-rate estimate.

The subsequent [SDK safety trial](https://github.com/hashtagakiaki/mindcraft-eval/blob/main/docs/sdk-owned-safety-20261009.md) completed 400/400 columns with no protected changes or human follow-ups. Generated code fell from 59,212 to 32,349 characters and total time from 14m58s to 13m42s; operations increased from 82 to 100. Action failure stops, cancellation, navigation restrictions and the soft execution window are now managed by the native SDK/host. Manual play was not updated by this trial.

The follow-up [surface admission correction](docs/surface-admission-20261009.md) reproduces that trial's seven distance errors and aligns approach, installed `canDigBlock` and dig-packet admission on the shared surface resolver. The permanent bot instructions also require continuing known work across fresh batches within one execution; batch size remains a model choice, with host failure/cancellation/time boundaries active.

Native生成コードでは、SDK操作を短い有限ループで呼び出せます。actionが例外または`ok:false`で終わると実行ホストは停止し、catch後のSDK呼び出しも拒否して途中結果を保持します。観測値はデータとして扱います。`approachBlock`が`unknown`/`blocked`を返す場合と`fellTree`が未完了の場合も、構造化結果を保持して操作を停止します。native guardはSDK呼び出し前に取消状態と`codex_session.execution_window_ms`（既定45,000ms）を確認し、上限到達時は実行中の呼び出しがsettleした後に通常終了します。SDKが確認した結果を重ねて確かめるための時計、安全編集回数、重複したapproach/equip、直後の再確認は不要です。既存のhard deadline、stall、task予算は引き続き適用されます。nativeの座標移動APIはpositionを受け取り、Minecraftのマス目で到着を判定します。要求座標とbot足元の`floor(x)`、`floor(y)`、`floor(z)`がすべて一致する必要があり、負座標も同じです。たとえば`(44,33,-70)`はx `[44,45)`、y `[33,34)`、z `[-70,-69)`の範囲です。成功には、読み込み済みの身体・足場観測、安全な接地、連続する2回のphysics tickでの確認が必要です。`already_at_goal`は既に指定マスにいたことを示し、移動したことは意味しません。`skills.goToPosition({position:{x,y,z}})`は既存地形を保ち、経路にdirt/cobblestoneの足場を置く場合があり、サーバーで撤去を確認してから成功します。`skills.reachPosition({position:{x,y,z}})`は採掘や足場設置を行う場合があり、確認済み足場を残し、到着後の撤去は開始しません。どちらも`{ok,status,arrivalReached,finalPosition,reason,code,diagnostics}`を返し、必要な保全が未完了なら成功扱いになりません。`route_not_found`は現在読み込まれたchunk、移動方針、探索上限のもとで経路が見つからなかったという意味で、world内で到達不能とは断定しません。その他のcodeは不正な目標、観測不足、探索上限、進捗停止、安全でない状態、到着または編集の未確認を区別します。`breakBlockAt`、チェスト操作、crafting、farming、tree作業、follow、保存地点への移動などは遅延SDK説明に記載された固定経路方針を使います。`collectBlock`と`goToSurface`は採掘や足場を許可し、combatとretreatは採掘せず足場を置く場合があります。内部・legacy呼び出しのskillは通常のboolean、観測結果、作業要約を保ち、native呼び出しでは同じ判断箇所の原因・数量を構造化結果として返します。作業対象にはそのskillで定義された権限を使います。native呼び出し元は経路overrideや生の`goToGoal` objectを渡せません。legacyのbot-first形式は既存signatureと結果を保ちます。`skills.digDown`は別操作です。

採掘なしの座標移動が`noPath`で終わった場合、安全な現在位置から採掘だけを許可して最大250msの追加探索を行います。採掘を伴う候補が見つかれば`ok:false, code:digging_required`を返します。この探索は移動・採掘・設置を実行せず、他の経路制約を維持します。追加探索でも候補がなければ`route_not_found`、期限や探索回数の上限なら`search_limit`です。候補発見は実際の通行成功や、採掘が唯一の方法であることを保証しません。

nativeの座標移動は最大512ブロック・32経路区間・180秒の範囲で再探索します。通常移動にはSDKの固定route policyを適用しますが、開始時に水・溶岩・接触危険を観測した場合は、まず生存を優先して共通の脱出処理を行います。落下中に始まった移動は、脱出経路を探さずに着地を待ち（最大5秒、取消可能）、着地した状態で同じ判定を行います。空中の一瞬（段差の下り・戦闘中のノックバック）を危険として扱うと空中で脱出経路の移動が始まり、2026-10-28のplayで約100件が失敗していたためです。脱出中は通常の地形保全方針にかかわらず採掘し、所持するdirt/cobblestoneで足場を設置できます。設置・破壊はサーバーで確認し、予定編集後も残る足場と足元・頭の空間を調べます。安全な乾地への接地を確認した後、元の危険領域へ再進入させず通常移動へ戻ります。nativeの`goToPosition`も脱出用足場の撤去を要求しません。通常経路の一時足場とlegacyの明示的なcleanup指定は従来どおりです。

採掘を許可した経路探索（`reachPosition`、`goToSurface`、危険脱出、`digging_required`の追加探索）には、pathfinderの`searchRadius`を使いません。これは距離ではなく「開始時の推定距離+半径」のコスト上限で、素手の石1個（約23）のような掘削コストを含む経路はすぐ超えて`noPath`になるためです。採掘なしの探索は従来どおり64を使います。非破壊経路を優先する探索の高い掘削・設置コストはその探索と実行中だけに適用し、終了時に元へ戻します。pathfinderの探索期限は掘削中も経過するため、掘削完了または目標・経路区間への前進後のTimeoutでは同じ目標で移動を続け、進捗のない経路は既存の停滞検知で止めます。2026-10-27の[隔離確認](../mindcraft-tools/results/surface-egress-20261027/README.md)では、石中y50から地表y99へ、旧版は素手で即`noPath`、石のツルハシでもツルハシが壊れたy93で`noPath`でした。修正後はツルハシ（途中から素手）で195秒で地表に到達しました。素手の`reachPosition`は180秒の予算内にy57まで進み、`stalled`を返します。素手で深い位置から脱出するのは遅く、1回の呼び出しで完了するとは限りません。

#### Hazard recovery evidence and remaining boundary

共通の局所探索は半径32ブロック、連結危険ブロック2048個、着地点候補4096件、探索全体30秒を上限とします。候補ごとのA*は最大6秒、1回50ms・最大2048回の探索処理を行い、event loopへ戻して取消を確認します。移動距離と必要な掘削・設置の手間で退避先を評価し、先頭8候補だけの切捨てと経路16地点の制限はありません。30秒は探索の予算です。移動・掘削・設置には既存の停滞検知・操作期限・取消を適用し、脱出に進捗があっても一律10秒や30秒で止める制限は設けません。`search_limit`は探索予算への到達、`route_not_found`は観測範囲と移動方針の下で探索を終えても経路を得られなかったことを示し、どちらも世界全体の到達不能を意味しません。チェスト操作などの呼び出し元にも元の失敗理由を保持します。

浅瀬専用の別探索と、深さ4・設置1個という条件は廃止しました。水中では探索・掘削中も浮上入力を維持し、安全な乾地への接地で解除します。既存pathfinderが接地中にしか採掘を開始しないため、水中では予定された障害物へ接近し、所有するSDKの掘削を実行・確認して経路を更新します。未知chunk、新しい危険、粉雪・気泡柱など未対応の遷移、安全な着地先を得られない状態は明示的に失敗します。取消後は新たな編集やcleanupを開始しません。

水中脱出の経路探索は、水面上の空中からさらに泳いで上昇する経路や、液体を設置の支点とする経路を除外します。水面より高い岸には、利用可能な足場と設置可能な支点があれば足場を使います。

2026-10-27の隔離vanilla 1.21.1 CaseServerでは、頭まで水没した深い縦穴から石の蓋2個を掘り、約25秒・HP20で乾いた石支持に接地して目標へ到達しました。別の深い水のケースでも足場を設置して水面より高い岸へ上がり、約6秒・HP20で到達しました。旧版では同じ地形で`route_not_found`でした。旧版の8ブロック半径・64個の危険領域・8候補・16地点を超える探索、設置のサーバー確認、通常移動方針の復元は既存offline fixtureで確認します。[実ゲームの記録と適用検証](../mindcraft-tools/results/hazard-recovery-20261027/README.md)を参照してください。これは特定の地形での確認で、すべての危険状態からの生還を保証するものではありません。

2026-10-20の[水・溶岩・接触危険の記録](../mindcraft-tools/results/nav-common-hazard-recovery-20261020/)と[浅瀬の足場設置記録](../mindcraft-tools/results/nav-water-exit-staging-20261020/)は、当時の実装の物理確認です。現在の実装の新しい設置・破壊動作を検証した記録としては扱いません。

本番の通常移動中に新しい危険領域へ入る許可はない。復旧候補が見つからない場合、別skillへの暗黙fallbackや危険許可の再発行はしない。

`goToSurface` failures include the final position, grounded state, and safe candidate count in action output. If navigation returns without confirmed arrival, the output also records the nearest candidate's individual support, clearance, and connection checks. This helps distinguish pathfinding failure from failure of the final surface admission checks.

The bot still selects authorized targets, interprets observations and verifies the entire operator request. It refreshes bounded target queries per batch or after movement/failure, rather than scanning the whole work area for each edit. Protection boundaries are not inferred automatically from prose. These guarantees cover public native SDK calls; raw bot/plugins and pure busy loops remain outside the guard. Internal/legacy/chat callers keep their existing return contracts and navigation behavior. A change to the generated SDK list or its deferred documentation changes the native thread scope; old-contract threads start fresh once.

Root `settings.js` の `agent_runtime: "codex-session"` と `allow_insecure_coding: true`、profileの明示的な `codex/<model>` で使用する。既定値は `legacy`。`code_model` による判断・実行の役割分離はこの経路では使わない。Codex app-serverのexperimental dynamic toolsを使用するため、対応するCLIが必要（標準待機・遅延SDK読込・画像・永続thread再開・圧縮を隔離確認したCLIは0.160.1）。モデルとreasoning effortの一致を確認し、fallbackは拒否する。reasoning effortはprofile model objectの `params.reasoning_effort`、既定は `medium`。

`minecraft_execute` で複数skillをまとめたJavaScriptを既存Coder/SES/lintとActionManagerへ渡す。native runtimeの同期照会はダミーの `await` を必要とせず、非同期操作のawait・所有・取消と他のlint規則は維持する。初期観測と操作結果には、観測時刻・dimensionとともに `timeOfDay`（欠測は `null`）を渡す。Codex標準のdynamic tool応答待機を使い、settleした結果をその呼出しへ返す。操作ごとのturn interrupt・次turnへの結果手渡し・実行中のLLM pollingは行わない。現在のshared bot rulesと受理済みoperator/peer contextを結果に添え、読込失敗や取消後に判断を再開しない。

 botの基本指示と共通方針は [`src/process/codex/AGENTS.md`](src/process/codex/AGENTS.md) が正本。sessionの新規開始・thread再開前にbundle内の同ファイルを専用cwdへ `AGENTS.md` としてコピーし、生成SDK一覧を付けてCodex標準workspace instruction loaderで読む。`baseInstructions` の独自上書きやtool resultごとの規約追加は行わない。指示更新は次のsession開始・再開時に読み込む。現在の能力・予算・受理したoperator requestはhostが各判断に渡す。開発用root `AGENTS.md` はbotへ渡さない。native SDK契約変更でcontext protocolを10へ更新し、旧context contractのthreadは一度だけ新規開始する。保存済みの会話・要約とworld namespaceは維持する。

SDK全量をbaseInstructionsへ埋め込まず、既存文書を `minecraft_sdk` namespaceの `deferLoading: true` ツールとして登録する。ツールは説明を読むだけで、ゲーム操作は `minecraft_execute` が所有する。SDK文書のmethod名から一覧を自動生成し、bot専用cwdのAGENTSへ固定指示と合わせて一度配置する。名前一覧から使うmethodを選び、code modeで選んだ説明を読む。例えば `world.getPosition` の説明toolは `tools.minecraft_sdk__world_getPosition({})`。CLI 0.160.1には `tools.tool_search` がない。名前を先頭3件ずつ探索する旧経路は使わず、複数の説明は一度に取得できる。[SDK一覧の比較記録](docs/native-sdk-catalog-20261006.md)を参照する。実行ツールはprocess限定の `features.code_mode.direct_only_tool_namespaces=["functions"]` で直接公開し、code modeの外で呼ぶ。`--strict-config` で無効な設定キーを起動時に拒否する。独自検索indexや説明選択modelは追加しない。CLIへ仕様を登録するサイズと、モデルに常時公開するcontextサイズは区別する。

bot専用CLIではApps/plugins/skill searchを無効化し、`skills.max_context_tokens=1` で無関係なskill一覧を抑える。multi-agentは `features.multi_agent=false` に加え `agents.enabled=false` で説明文も止める。専用cwd内の一時 `CODEX_HOME` へ、元の `CODEX_HOME`（未指定なら `~/.codex`）の `auth.json`、`config.toml` と `MINDCRAFT_CODEX_SESSIONS_DIR` のrollout保存先だけをsymlinkし、グローバルAGENTSを読込対象から外す。保存先が未指定の場合は元home直下の `mindcraft-sessions/` を使い、通常のCodex一覧へbot threadを混ぜない。bot用AGENTSはcwdの標準loaderで読む。既存のfile認証を `cli_auth_credentials_store="file"` で利用し、通常の認証更新は同じファイルへ届く。keyringだけの認証はこの経路の対象外。設定・AGENTSを編集したり認証内容を複製したりしない。手動playと評価runnerは各bot-run/実験run専用の保存先を渡し、保存threadは一時home削除後も再開できる。traceの `instructionSources` に実際の読込元を記録する。検証と内訳は[context分離記録](docs/native-context-isolation-20261006.md)を参照する。

各判断に本人名、task ID、受理済み依頼、最新規約、残り時間・操作数・host decision数を渡す。decision数は初回入力とtool応答のhost counterで、Codex内部の推論回数ではない。在庫は種類別合計と個々の道具・装備の残り耐久をモデルへ渡し、実行trace/診断は生観測を保持する。スロット詳細はSDKで読む。executor成功、domain false、部分変更、確認範囲、観測scope/時刻、settlement、exact errorを保ったまま、空の補助fieldと重複説明を省く。

native入力は既知の定型shutdown通知だけを除く。未送信のraw sequenceを選んでから除外するため、依頼・宛先・behavior/failure情報やcursorをずらさない。旧memoryの生通知は保持する。新shutdown通知は既存archiveへ保存し、保存失敗時はmemoryへ残す。通常のnative会話trimもarchive成功後に行う。legacyのshutdown経路は従来どおり。context contract更新時は旧threadを一度新規化し、以後は同じscopeで再開する。[今回の観測・検証範囲](docs/native-context-revision-20261006.md)を参照する。

world scope（root `place_world_id`）がある場合、同じbot/world/model/effort/SDK仕様のthreadをoperator request間で再開する。既存 `memory.json` の `codex_thread` にversion・thread ID・scope・ローカル履歴cursorを保存し、会話・画像と標準compactionはCodexのCODEX_HOME側が所有する。再開時は未送信のローカルcontext（最新依頼・recipient context・behavior logなど）だけを渡し、過去会話全量を再注入しない。bot/world/model/SDK・vision設定の不一致、history clear、再起動時の `load_memory: false` は新しいthreadにする。world scopeがない場合はtask限定のephemeral threadを使う。保存threadがCodex側にない場合は明示的なtask errorとなり、ゲーム操作は自動replayしない。

Codex app-serverには `model_auto_compact_token_limit=180000` を指定し、モデル既定のしきい値より前に標準自動compactionを開始する。値はtoken使用量通知が示すcontext windowの範囲内で設定し、大きなtool結果が続く長時間threadでも上限まで余裕を保つ。

native taskのvisionはJPEGをtool resultの `inputImage` として判断中のCodexへ直接返す。`allow_vision` と画像対応のnative modelが必要で、別の `vision_model` は不要。既存vision SDKの戻り値・`analysis` は画像添付markerと観測metadataになり、画像はモデルが解釈する。上限は1操作4枚、各2 MiB。失敗前に取得できた画像は部分結果として保持し、取消後の画像は次taskへ渡さない。Mindcraft JSONL/diagnosticsにはmetadataだけを残しbase64を入れない。legacyの画像解釈・自然言語memory要約は従来どおり。

`codex_session` の既定値は、`execution_window_ms: 45000`、`stall_timeout_ms: 30000`、`action_timeout_ms: 600000`、`output_limit: 16000`、`max_search_radius: 64`、`task_budget_ms: null`、`max_operations: null`、`max_turns: null`。この3つだけは`null`で上限を無効化でき、既定では長時間taskを時間・操作・判断回数で打ち切らない。有限の上限を使う場合は正の数（操作・判断回数は整数）を設定する。各判断の残りbudgetも無制限は`null`を返す。

`codex_session.goals: true` は標準Codex Goalsを使う明示opt-in（既定false）。受理した依頼をthreadの目標に設定し、最初の応答後の自動続行も同じtask・操作ownerで受け取る。CLI 0.162.0で模擬課題の2ターン実行を確認した。Goalsはephemeral threadでは使えないため、world scopeがない場合も保存可能な新規threadを作るが、次の依頼へ自動再開しない。依頼は標準APIの4,000文字上限に従い、上限超過やAPI非対応を通常実行へfallbackしない。自動続行もhostの時間・操作・判断予算、Stop・差替え・shutdownの対象になる。bot指示は依頼全体の達成を現在の証拠で確認した同じturn内でGoalをcompleteにし、更新成功後に最終回答するよう定める。完了更新だけの次turnを避けるための指示であり、未達Goalの自動続行は維持する。[隔離した実モデル比較](docs/goal-completion-20261026.md)では、時刻観測・同期照会lintの改善と合わせて追加実行の削減を確認した。goal statusを終了記録へ残すが、モデルのcompleteはゲーム上の達成を独立検証した意味ではない。次のターンが発生しないactive goalにも既存model待機期限を適用する。単独 `skills.stay` の成功だけでGoalを完了させず、任務途中の待機と独立した待機依頼の終了を通常のGoal判断で扱う。[標準Goals API](https://learn.chatgpt.com/docs/app-server#manage-a-thread-goal)

task budgetの経過時間はmodel待ち・再試行・operation待ちを含み、operation数は受理した実行要求、旧名 `max_turns` はhostの判断再開数（turn開始と各SDK tool resultによる再開）を数え、Codex内部の検索・圧縮回数は含めない。先に達した上限は停止を要求し、実operationのsettlementを代替しない。

通常actionでは位置の0.5 block以上の変化か在庫の変化で停滞timerを更新する。navigation phase中はnative monitorも生の位置変化でなくowned callの進捗（目標への接近、未訪問route node到達、採掘完了）を使うため、無応答は既定30秒でstopする。`goToGoal` はさらに既定8秒（250ms間隔で検査）の無進捗期限を保ち、同じnodeの再到達やpath再計算だけでは時計を更新しない。採掘が自身の有限期限内にある間は、どちらの時計も止まり、採掘の終了時から数え直す。1操作のhard timeoutは既定10分で、task全体の制限と独立して働く。settleしたtimeout/stallの結果は同じtaskへ返し、状態確認と修正を続けられる。

失敗した同じcode・error・観測状態が進捗なしで3回繰り返された場合は、次の実行を拒否してtask errorとして報告する。途中の読み取り成功だけではこの回数を消さず、異なる失敗条件・観測状態、確認済み変更、または観測された操作進捗で更新する。同期のblock検索はこのruntimeに限り指定半径を超えるとerrorを返す。任意の同期codeや協調停止しない操作をtimerで強制停止できる保証はない。既存10秒stop watchdogと親process回収が最終境界となる。

Codex app-serverから受信した確定済み `agentMessage` は、Codex turnが終わるのを待たず、MindServer operator UIのチャット欄へ時刻・bot名・本文付きで追記する。ページ接続時は保存済み `bots/<bot>/histories/codex-*.jsonl` とmanifest付きdiagnostics streamから確定済み回答を読み込み、旧bundleに残る履歴も含めて直近200件を表示する。diagnostics root/segmentが壊れている場合は旧形式へfallbackせず履歴APIを失敗させる。履歴APIは回答本文とtask失敗だけを返し、内部推論や実行traceは返さない。ログ本体はサーバーに残るCodex task traceを使い、ブラウザーlocalStorageには保存しない。保護モードのobserver接続には配信しない。

経路診断は次ノードの掘削・設置予定、pathfinderの採掘・設置状態、操作入力と周辺ブロックを経路更新・状態変化・停止時に記録する。消費済みの直近編集予定、実際の設置呼出しと結果、path resetの理由も残す。設置呼出しの成功はserver確認そのものを意味せず、内部で待機している理由をpathfinderが公開しない場合は不明として扱う。

返却結果には位置、在庫、耐久度、health/food、部分output、error、停止理由を含める。executor成功はskillのboolean結果と別fieldで返す。skill call ID/parent ID、task ID、確認できた事実と未確認部分をoperation resultへ載せる。navigation route ID、bounded route/path update、movement policy、reset、arrival、stallも同じtask/action/call scopeへ記録する。navigation/smeltingの有限waitは同じskill callへphase、理由、timeout、outcomeを記録する。Codex app-server request/response/timeout、tool request/response、session interruptionもcall IDで結ぶ。公開SDK呼出しとその未await子処理はsettleまで所有するが、raw bot/plugin操作全体の停止や回収は保証しない。Codex session closeはhelper processを回収した時点で完了し、未終了のgame tool workのdrainを待たない。未終了操作はActionManagerの所有下に残り、協調停止できなければ既存watchdogからagent shutdownへ進むため、同じ接続で次操作を重ねない。management経由の次taskは旧actionの停止を最大4秒待つ。MindServerの5秒ACK期限より前にsettleしない場合はtask IDと理由を返して明示拒否し、後で旧actionがsettleしてもそのtaskを実行しない。旧actionは元の停止watchdogとagent shutdownに従う。4,232文字のoutputは既定で省略しない。16,000文字を超えるoutputは明示して先頭/末尾を残す。既定のnative task traceは `bots/<name>/histories/codex-<uuid>.jsonl` に保存する。`settings.diagnostics` が有効なmanual/eval runtimeでは同じtask eventを `diagnostics/stream/segments/` のmanifest付きsegmentへ保存し、`bot.dig` の要求・admission・packet・server確認・結果、SDK/navigation、lifecycle、model境界を共通IDへ記録する。manual runtimeはbotごとに120秒または8MiB ringを持ち、異常triggerまたはoperator captureでincidentへ退避して30秒追記する。ringの退避は1回のlockとquota確認でまとめて書き込む（1件ずつの書込みでは約1,200件に10秒以上かかり、サーバー接続がtimeoutした）。親とbotのstdout/stderrはsecret patternを除去してconsole poolへteeする。readerはroot manifestで保存形式を選択し、新形式のsegmentが壊れていても旧traceへ暗黙fallbackしない。task terminalは受理task IDで絞り込み、reported/unknown、終了理由、operation settlement、保存結果を別々に記録する。shared bot rulesはturn開始・SDK tool resultによる判断再開ごとに読み直す。現在のvision設定を古いmemoryより優先する。Stop、新しい人間の指示、management切断、shutdownは現在のturnと操作を取り消し、旧結果による判断再開を拒否する。取消済みthreadを次のtaskで使う場合も新しい依頼と現在観測から判断し、取消操作の自動replayはしない。native task中は旧recovery actorを並行起動しない。既存literal commandも使用できる。

確認eventはserver由来の観測を根拠にする。chest transferは前後のfull `window_items` snapshotがstatistics fence内で揃い、containerとplayer inventoryの差分が一致した量だけを記録する。Mineflayerのoptimistic slot表示だけ、片側差分、またはsnapshot欠落はunknownとして在庫操作gateを維持する。legacy command/historyには同じsettled operation resultから状態と確認事実を短く投影する。domain `false` や `returned_true` は依頼全体の達成確認を意味しない。

native Codexではphaseが `commentary` の途中説明をUIへ流し、最終回答には含めない。最終文章と生成時刻をcheckpointし、route完了時刻とtask terminalを分けて記録する。nativeのローカルturnは `max_messages` 件に制限して古い分をfull historyへ保存し、補助modelで要約しない。既存memoryの読込形式とlegacy `History.add()` / single-flight要約を保ち、task JSONLから自動再開しない。JSONL保存失敗はmemory保存成否と分離し、保存済みと報告しない。旧要約方式の検証は[D10記録](docs/long-summary-checkpoint-stage4-20261005.md)、標準harness移行は[今回の記録](docs/codex-standard-harness-20261006.md)を参照。

OllamaのHTTP/model失敗は通常回答文字列にせず失敗として返し、`params.request_timeout_ms`（既定120000ms）と実fetch cancellation signalを適用する。会話差替え、vision、memory要約、codingの既存owner signalを使い、要約epoch invalidationは現在の要約requestもcancelする。usageはproviderが返した数値だけをrequest開始時のpurpose/task/action scopeへ記録し、欠測値は省略する。Codex legacy visionもowned CLI cancellationを共有する。[D11記録](docs/model-request-ownership-stage4-20261005.md)。

Offline fixtureは `node tests/codex_session.test.cjs`（上記Node20）で実行し、通常suiteにも含まれる。fake app-serverと所有helperで専用homeの共有範囲、file認証更新、削除後のthread再開とbot指示更新、AGENTS配置と標準読込設定、SDK名前一覧と遅延説明の分離・再開時の一覧復元、同一turn内のtool result待機、phase、thread再開とscope/reset、native画像と上限、高速完了、部分失敗、停滞、停止/差替え/管理切断/shutdownの結果破棄、本体message入口を確認する。実ゲーム結果はbenchmark repoの記録を参照。manual playのsource pinや稼働botはこの追加で自動更新されない。

manual `settings.diagnostics` は空き10GiB未満をmaintenance eventへ記録し、5GiB未満では新しいCodex taskを拒否する。実行中のtaskはこの閾値だけでは停止しない。

診断poolの共有排他にはLinux `flock` を使う。診断を有効にするruntime hostには既存のutil-linux `flock` コマンドが必要で、lock待ちは有限時間で明示エラーになる。共有inodeを保つためlock fileは残り、process異常終了時はOSがlockを解放する。
