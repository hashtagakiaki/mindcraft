<h1 align="center">🧠mindcraft⛏️</h1>

## Personal development fork

The SDK documentation and code linter share one explicit `places`/`vision` method map. Relevant place methods are selected by task relevance; vision methods remain in the always-shown docs. The vision SDK reuses the existing screenshot interpretation commands; await a method and log its returned analysis into action output. It requires `allow_vision` and a vision-capable model, and returns a disabled message when unavailable. The vision SDK exposes `lookAtPlayer`, `lookAtPosition`, and `lookAtBlock`; `lookAtPosition` retains the existing aim at `y + 2`, while `lookAtBlock` resolves a loaded block and aims at its center. When embeddings are unavailable, skill selection scores the documentation text directly.

Generated vision calls use `await vision.lookAtPosition(x, y, z)` or `await vision.lookAtPlayer("Steve", "at")`, without a `bot` argument. Position coordinates must be finite numbers; player names must be nonempty strings and direction is `"at"` (default) or `"with"`. Invalid arguments fail before changing the view or capturing an image, so an owned operation can report the error and continue with a corrected call in the same task. Log the returned analysis, for example `log(bot, await vision.lookAtPosition(75, 73, -292));`.

Minecraft disconnect reasons are decoded with the version-specific chat component decoder, including modern NBT reasons. The offline `tests/vision_sdk_validation.test.cjs` fixture checks Coder/SES/ActionManager rejection and continuation, chat commands, disabled vision, and reason decoding. Isolated vanilla 1.21.1 verification records are in [the LoginGuard investigation](../mindcraft-tools/docs/login-guard-invalid-rotation-20261006.md); camera/image analysis is stubbed in these checks.

`blocked_actions` disables named chat commands and removes those commands from command documentation. It does not prohibit equivalent operations through the SDK, raw bot access, or plugins.

### Inspect an explicit target and continue after a failure

Use absolute coordinates to distinguish nearby targets:

```js
const target = world.inspectBlockAt(bot, 10, 64, -3);
const chest = await skills.inspectChestAt(bot, 10, 64, -3);
log(bot, JSON.stringify(chest));
log(bot, JSON.stringify(await vision.lookAtBlock(10, 64, -3)));
```

`inspectBlockAt` returns loaded state, position/name/properties, corner distance, eye-to-center interaction distance, Mineflayer visibility/canDig checks, dimension and observation time. Unloaded targets remain unknown. `inspectChestAt` returns the actual selected position, contents and time; it never substitutes a nearest chest. Double chest contents are combined. The existing nearest `viewChest(bot)` keeps its boolean contract. An opened container is closed on success, failure or cancellation. Container observations are historical reads, not inventory transfers.

`skills.approachBlock(bot, x, y, z)` uses the existing owned pathfinder and `GoalLookAtBlock`, without digging or scaffolding, then rechecks reach and block-center visibility. It returns `ready`, `unknown` or `blocked` with a fresh target observation and reason. Movement alone is not successful interaction. A visible face of a partial block may still have an occluded center; this is reported as blocked rather than bypassing the dig guard. `breakBlockAt` uses this approach when out of reach or occluded. `goToPosition`, `breakBlockAt` and legacy placement reject invalid Bot/finite coordinates before side effects, with a corrected example; strict orientation placement keeps its existing `false` validation contract. `collectBlock(bot, blockType, num, exclude)` validates its Bot/name/count/exclusions; `exclude` means positions to skip, not positions to collect. Mineflayer palette entries have `position:null`, so coordinate and terrain checks run only on the subsequent positioned match.

`vision.lookAtBlock(x,y,z)` takes no Bot argument. It returns `{status, target, aim, observedAt, analysis}`; unknown targets cause no view change or capture. Existing position commands/SDK retain the `y+2` aim. Offline fixtures stub image interpretation; live image quality and chest/build correctness require dedicated trusted templates and observers.

Native tasks can read `diagnostics.lastTask()` to explain the previous task's exact error and code without replaying it. The bounded snapshot is saved in existing `memory.json`, scoped by Bot name and configured `place_world_id`; no scope, missing records, old format or mismatches return `available:false` with a reason. It retains the latest six operations plus the latest failure, bounded skill results and confirmed/unconfirmed changes with timestamps. Code/error/output limits are 6000/4000/3000 characters; structural entries and depth are also bounded. Raw Bot/plugin changes may be untracked. The initial model input lists availability and task identity; details are read only when requested. Bundle handoff can carry the existing memory file; old trace files are never automatically replayed. Save success is recorded separately in `diagnosticSaveSucceeded`.

The Node20 `tests/targeted_sdk.test.cjs`, `tests/vision_sdk_validation.test.cjs` and `tests/codex_session.test.cjs` fixtures exercise the real Coder/SES/ActionManager boundary. They cover distinct targets, validation before side effects, unknown/occluded/unreachable targets, cancellation and close, compatibility, and diagnosis in a new task after a saved TypeError.

### Placement with a requested orientation

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

MindServer state polling is single-flight with a per-bot 750ms acknowledgement deadline and explicit fresh/stale/unknown state labels. Late state from a replaced connection or removed listener is discarded. Vision camera capture waits for a ready world view, permits one capture at a time, enforces a 2 MiB JPEG limit, and reports bounded shutdown drain status. See [the D13 lifecycle report](docs/state-polling-camera-lifecycle-stage4-20261005.md); offline fixtures do not measure live rendering performance.

World block helpers preserve Mineflayer's `null` result for unloaded blocks as unknown; they do not reinterpret it as air. Full-state and native Codex observations include an observation time, dimension, and separately labeled management connection/readiness metadata. The Minecraft world-connection generation remains unknown because the management socket generation does not identify a world connection. Place, break, and dig helpers reject a null target before starting the corresponding block mutation. See [the D08 observation report](docs/unknown-block-observation-stage4-20261005.md) for scope and limitations.

Native Codex sessions checkpoint the model's final text and generation time before memory handling; successful routing and its report time are recorded separately, followed by one task terminal. The turn is atomically saved in the existing `memory.json` format before any long natural-language summary runs. Native summaries are single-flight background work; a new intent or shutdown invalidates stale work without dropping pending turns. Existing `memory.json` loading remains supported, and task JSONL records are not automatically resumed. Trace write failures remain separate from memory-save status and are not described as persisted; see [the D10 checkpoint report](docs/long-summary-checkpoint-stage4-20261005.md).

Ollama model errors are surfaced as failures instead of ordinary answer text. `params.request_timeout_ms` sets the request timeout in milliseconds (default 120000); the reserved parameter is not sent to Ollama as a generation option. Cancellation reaches Ollama chat/vision fetches for coding, superseded conversations, vision, and memory summaries. Usage diagnostics include only provider-supplied prompt/completion counts and the request-start purpose/task/action scope; missing counts remain absent. Legacy Codex vision requests use the same owned-process cancellation and cleanup boundary as coding requests. See [the D11 model request report](docs/model-request-ownership-stage4-20261005.md).

`generated_code_fail_on_false` selects SDK functions whose `false` return throws inside generated newAction code; its default is empty, and direct skill/command boolean results keep their normal meaning. Navigation stall monitoring reads `navigation_stall_timeout_ms` and `navigation_check_interval_ms` when each path starts (defaults 90000 and 5000). Goal-distance improvement or arrival at a new node in the active path counts as navigation progress; a path recalculation or revisiting the same node does not. While phase is `navigation`, the native stall monitor uses that owned route progress instead of raw position changes, so an unresponsive path still hits the existing native stall limit. The operation hard timeout remains active. Navigation and smelting waits record their phase, reason, finite deadline and result under the owning SDK call. Smelting keeps its existing 11000ms quiet period, reset by a confirmed output. The legacy Codex CLI adapter forwards its selected profile model with `--model`; the native Codex session keeps its existing model negotiation. `src/agent/source_capabilities.json` lists individually versioned source features that runtime preparers may use to skip matching overlays; unsupported versions fail closed, and a declaration does not imply support for undeclared features.

Native generated code may use `communication.sendToBot(recipient, message)` on an authenticated protected management connection. Its ACK means the recipient retained a bounded message in an already-active native task inbox; the message appears once as context on a following turn. It does not start a recipient task or confirm that the recipient acted. Stop, task replacement, management replacement, and completion discard queued messages. Legacy bot conversations keep their existing chat route. Per-process message and dispatch-ID retention has finite caps and fails closed when full; it does not provide crash recovery or exactly-once delivery. See the [stage-five communication record](docs/native-peer-communication-stage5-20261005.md); offline fixtures do not measure two-bot gameplay benefit.

Shared bot rules are configured with root `settings.js` key `bot_rules_file`: an absolute path to a UTF-8 Markdown file, or `null` (default, disabled). MindServer supplies the same path to every agent; individual profiles and UI agent settings cannot override it. Conversation/action decisions, newAction code generation, bot-response decisions, and goal setting reread the file for each request and append it to the system prompt after template expansion. Literal prompt placeholders in the rules remain unchanged. Memory summarization and image interpretation do not append the rules.

Editing or atomically replacing the file takes effect on each bot's next decision without restarting; an in-flight decision or action is not interrupted. An empty file adds no rules. A configured file that cannot be read causes an explicit error before sending the model request. Rules take precedence over conflicting profile preferences and older memory; a current explicit operator instruction can make an exception. This supplies instructions to the model and does not enforce inventory actions or automatic reflex modes mechanically. See [manual play](../play/README.md) for the shared file and activation procedure.

This repository is the `hashtagakiaki/mindcraft` development fork used as the source owner for craft synchronization, farm skills, and server-confirmed mining. The `autonomy` branch is the fork's default branch and starts from upstream stable commit `b36eaf7e61b3f6bd031fdb531812b2e3c42b6c73`. Evaluation exports the full SHA pinned in `mindcraft-eval/mindcraft-source.json`; manual play exports its independent pin in `play/mindcraft-source.json` through [mindcraft-tools](../mindcraft-tools/README.md). Craft synchronization, `tendNearbyFarm`, and mining sync are maintained here as normal source; play overlays are owned by `mindcraft-tools`.

Recipes that need a crafting table are not sent to the player inventory's 2×2 grid unless a table is found after placement or already present nearby. If table placement fails and no table is observed, `craftRecipe` returns `false` before moving ingredients.

When Mineflayer's packet parser raises `PartialReadError`, the bot records up to eight distinct failing inbound frames per process at `bots/<bot>/logs/partial-read-errors.jsonl`. Records include the protocol state, packet ID when readable, frame length and SHA-256, a frame capture (up to 256 KiB), and the parser stack. These files are private runtime data and may contain item metadata or book text; do not commit or share them without inspecting and redacting the contents.

`tillAndSow` accepts a seed item name or a supported crop name (for example, `wheat` maps to `wheat_seeds`). In both survival and cheat modes it reports planting success only after the requested crop is observed; an existing different crop is not treated as success. Farm harvest counts require the target block to become air and this bot to collect a matching nearby drop. Bucket interactions require the expected inventory change, and bucket placement also checks the destination block. Door traversal waits for the open state, and lethal attacks report success only for the target entity's death event.

`tendNearbyFarm(bot, options = {})` defaults to one connected plot: it selects the nearest farmland within `searchRadius` (default 32), then follows all same-height edge-adjacent farmland, including empty soil. Water gaps and diagonal contacts do not connect plots. The selected plot can extend beyond `searchRadius`; an unloaded boundary throws before work starts. Use `startPosition: {x, y, z}` to select a particular farmland block. Use `{scope: 'radius', radius: 32}` to tend all farmland within a working radius instead. `radius` is only valid for radius scope; `searchRadius` and `startPosition` are only valid for connected scope. Both modes accept `seedReserve` (default 1) and `chestPosition`; omitted chest coordinates use a chest within 32 blocks after tending. One call performs one cycle and returns confirmed `{harvested, planted, stored}` counts; missing seeds or unreachable crops are not a claim of completion. This options object replaces the old positional arguments.

For local development, keep this full-history clone separate from the read-only upstream checkout at `mindcraft-eval/runtime/upstream`. Reuse the existing compatible `node_modules` only as a read-only dependency input; do not run `npm install`, `npm ci`, or postinstall in the shared dependency tree. See [AGENTS.md](AGENTS.md) for repository, runtime, and live-server boundaries.

Optional shared place memory is configured at MindServer startup in the root `settings.js` with both `place_state_dir` (an absolute path) and `place_world_id` (a UUID). Leave both `null` to keep place memory disabled. These are process-wide settings and are not editable through individual agent settings; agent processes receive only the enabled flag and world ID, not the state path. MindServer stores each namespace in `place_state_dir/worlds/<place_world_id>.json`; place state loads independently of `load_memory` and survives bundle changes that reuse the same state root and world ID. Changing the world ID selects a separate ledger and keeps the prior ledger. The state root has an exclusive `.place-store.lock`; only one MindServer may use that root at once. Normal SIGINT/SIGTERM and UI shutdown release the lock. After a crash, first verify that no MindServer can still write the state root, then remove the stale lock file before starting again. Never remove a lock while a writer may be active.

Saved places can be searched with `!findPlace("forest")`, inspected by stable ID with `!inspectPlace("<id>")`, and visited with `!goToPlace("<id>")`. `!rememberHere("name")` keeps its existing syntax and records the bot's current point as observed when persistent memory is enabled; otherwise it remains a session bookmark. `!recordPlaceHere("name", "shelter")` records a general point and purpose. A `base` record is a representative point, not proof that a structure exists around it. Use `!recordPlaceBlock("name", "farm", "food", x, y, z)` for a loaded target block; farm records require farmland and storage records require a chest or trapped chest. `!recordReportedPlace(...)` explicitly stores user-provided coordinates as unverified. Place IDs, personal aliases, home preferences, death bookmarks, observation timestamps, and explicit output-storage relations survive restart. Ambiguous search results must be selected by ID. Persistent travel checks dimension and reports the adapter's actual movement result; reaching an unverified coordinate does not make the place observed. Related storage must have the same dimension. NewAction receives only a limited async `places` SDK (search, inspect, record, verify, travel, farm, relation, and personal alias operations), never the RPC socket or state path. Useful resource locations should be recorded only from the bot's current position or a loaded target block matching the place kind; stale and user-reported coordinates remain visibly unverified until checked.

Run the offline craft, farm, mining, navigation, interaction, cancellation, furnace, management-reconnect, and process-lifecycle fixtures with `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs`. The runner builds disposable fixtures and does not start Minecraft, call an LLM API, or modify shared dependencies. Test-only dependency resolution prefers `node_modules` inside the source/runtime root and falls back to the read-only eval upstream tree in the development checkout. The mining fixture uses real Mineflayer digging, plugin loader, Block, and Tool implementations and checks target air plus this bot's server `playerCollect` event. Farm harvesting, planting, reserve handling, and chest storage, as well as bucket, door, and combat interactions, use mocks; eval's live smoke only invokes the farm skill in a surveyed no-target area. Furnace tests use actual Mineflayer inventory/furnace plugins. Process tests spawn only disposable fixture-owned Node processes and clean them up in `finally`. Shutdown fixtures exercise actual `Agent.shutdown` and `ActionManager` behavior, task and Cooking setup guards, init signal/IPC handling, parent supervisor task-ending and owned-process cleanup, and MindServer hub/PlaceStore drain and close behavior. They distinguish successful task completion (exit code 0), retained abnormal exit codes, owned-process cleanup results, and shutdown-record save failures.

An eval-owned isolated CaseServer smoke on 2026-10-02, using source pin `d549e73` ([eval smoke record](https://github.com/hashtagakiaki/mindcraft-eval#verify-crafting-synchronization)), verified same-connection smelt→craft→equip with a disposable world and direct skill calls (without background mode control): smelt one ingot, fill all 36 storage slots, abort after opening a furnace with confirmed inventory and no residue, then craft a shield and auto-equip it in the offhand. The bot kept the same PID and login, spawned once, did not end, and the Minecraft connection remained open. Other covered cases included tree crafting/recovery, a no-op farm target, and crafting with the tool-break-recovery template. Templates, shared dependencies, and the previous runtime hash remained unchanged, and all three owned client/server processes were cleaned up. This isolated skill smoke does not verify production play, full Agent orchestration, or LLM-driven behavior; offline fixtures and the isolated live smoke describe separate scopes.

### Action cancellation and reconnect behavior

Normal successful work, including smelting and furnace clearing, keeps the current Minecraft connection. A cooperative stop also keeps that connection. `!stop` suppresses automatic resume and goal retries; a later explicit user instruction may start new work after the old action settles. A replacement instruction waits for the prior action to settle before its body can mutate the world.

Timeouts, movement stalls, and rapid repeated failures request a bounded stop and recovery. When the old action settles safely, the bot checks confirmed state and tries one recovery/replan; unchanged repeated failures do not loop indefinitely. At the recovery limit, it pauses and reports the blocker while staying connected. A management-socket disconnect also pauses work; after Socket.IO reconnect, settings and place namespace are checked before registration and login resume, and autonomous/action execution stays gated until a fresh explicit human instruction arrives. Old commands and uncertain RPC mutations are not replayed.

LLM cancellation is a programmatic request cancellation, not a natural-language request for the model to stop. Cancelled or stale responses and staged code cannot execute. The Codex adapter waits for its registered helper/CLI process group to close before removing the request directory; process ownership guarantees apply to groups recorded by the live bot supervisor. An unsupported provider may continue computing remotely, but its stale answer is discarded.

The MindCraft UI's `Last Message` field shows each bot's latest outgoing reply, including replies sent as whispers to the configured allowed players.

Minecraft reconnect is reserved for an already lost connection, an old action/process that cannot be safely stopped or isolated, or an explicit restart initiated by a literal human `!restart` command or the management UI. LLM-generated `!restart` is rejected; recovery prompts are told not to restart. A normal success, cooperative cancellation, recovery attempt, or temporary management-socket loss does not reconnect the bot. A forced stop is reported as a stop failure until the old action or owned process is actually gone; a timeout or race alone is not treated as proof of settlement.

Mining sync corrects affected block-instance material data per bot so Mineflayer, Tool, and pathfinder use consistent pickaxe speeds without changing shared registries. It requires a reachable, current target; waits a bounded time for ground contact where applicable; and treats server block updates as authoritative for break completion. Collection requires both target-block air and a server `playerCollect` event for a tracked expected drop near that block. See [the investigation and implementation record](docs/mining-investigation-2026-09-30.md) for offline and isolated live results.

To publish a source update, make the source change on `autonomy`, run the offline test command, and push the reviewed commit to this fork. Then update the eval manifest to that exact full SHA and run the eval tests and isolated live smoke against the pin. Review and commit/push the eval change after those checks, then prepare a new play bundle. Keep the eval dependency tree read-only; do not reinstall packages as part of a source-only update. Activate a bundle only through the explicitly authorized bot-only cutover, which leaves the Minecraft server, world, and Ollama process running.

### Group operator instructions

In Minecraft public chat, use `@all gather wood` to instruct every connected, in-game bot, or `@Bot2,@Bot3 gather wood` to instruct a group. `@Bot2 @Bot3 ...` and `@Bot2,Bot3 ...` also work; names are case-insensitive and duplicates are removed. Addressing must be at the start, followed by whitespace and the instruction. Unknown names, an explicitly named disconnected bot, or mixing `@all` with names rejects the message. Ordinary individual whispers and the existing single-bot public-chat behavior remain supported. The `only_chat_with` allowlist still applies.

In the UI, click **Select bots** or press **Ctrl** outside an editable field, then click connected bot cards to toggle recipients. Releasing Ctrl keeps selection mode active. Selected cards are highlighted; **Select all connected** selects every currently connected bot. Use any selected bot's existing message input to send to the whole selection. **Done selecting** exits selection mode and clears the selection. Inputs and control buttons do not toggle card selection. Stop/Stay and lifecycle buttons keep their individual-bot scope. An explicit address prefix in a message overrides the selection. Disconnected or removed bots are dropped from the selection. Successful UI sends display the resolved recipient names; errors retain the input. `@all` resolves the connected bots at send time. Explicit selections are validated together before dispatch, so an invalid selection is not partly sent. This is simultaneous dispatch, not synchronized action starts or guaranteed delivery through a later disconnect; management recovery does not replay instructions.

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

The operator UI asks for the operator token in memory. Do not paste it into settings, profiles, shell history, logs, or source files. Agent processes receive distinct, spawn-bound bot tokens over their existing private parent-child IPC channel; reconnects within a spawn keep the token, while stopping or replacing a spawn revokes it. Protected Socket.IO clients must authenticate at connection and management handlers derive the sender from the authenticated identity. An observer can call named `readiness` only and receives no agent status or viewer-port broadcasts. A process signal triggers graceful agent and hub cleanup; after a crash, a stale private session file is unusable with a new hub and must not be copied or reused.

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

Root `settings.js` の `agent_runtime: "codex-session"` と `allow_insecure_coding: true`、profileの明示的な `codex/<model>` で使用する。既定値は `legacy`。`code_model` による判断・実行の役割分離はこの経路では使わない。Codex app-serverのexperimental dynamic toolsを使用するため、対応するCLIが必要（隔離確認のCLIは0.159.1）。モデルとreasoning effortの一致を確認し、fallbackは拒否する。reasoning effortはprofile model objectの `params.reasoning_effort`、既定は `medium`。

1つのoperator requestを1つのthreadで扱い、`minecraft_execute` で複数skillをまとめたJavaScriptを既存Coder/SES/lintとActionManagerへ渡す。SDK実行開始時にmodel turnだけをinterruptし、実行がsettleした結果を同じthreadの次turnに一度渡す。実行中にLLMをpollしない。thread内では複数回推論する。vision有効時の画像解釈と長期memory要約は既存の補助model経路を使う。

`codex_session` の既定値は、`stall_timeout_ms: 30000`、`action_timeout_ms: 120000`、`output_limit: 16000`、`max_search_radius: 64`、`task_budget_ms: 300000`、`max_operations: 32`、`max_turns: 40`。task budgetの経過時間はmodel待ち・再試行・operation待ちを含み、operation数は受理した実行要求、turn数はこのthreadのturn数を数える。先に達した上限は停止を要求し、実operationのsettlementを代替しない。通常actionでは位置の0.5 block以上の変化か在庫の変化で停滞timerを更新する。navigation phase中はnative monitorも生の位置変化でなくowned callの未訪問route node到達を進捗として使うため、無応答は既定30秒でstopする。`goToGoal` はさらに既定90秒の有限stall期限を保ち、同じnodeの再到達やpath再計算だけでは時計を更新しない。120秒のaction hard timeoutはそのまま働く。同期のblock検索はこのruntimeに限り指定半径を超えるとerrorを返す。任意の同期codeや協調停止しない操作をtimerで強制停止できる保証はない。既存10秒stop watchdogと親process回収が最終境界となる。

Codex app-serverから受信した確定済み `agentMessage` は、Codex turnが終わるのを待たず、MindServer operator UIのBot output logへ時刻・bot名・本文付きで追記する。ページ接続時は保存済み `bots/<bot>/histories/codex-*.jsonl` から確定済み回答を読み込み、旧bundleに残る履歴も含めて直近200件を表示する。履歴APIは回答本文とtask失敗だけを返し、内部推論や実行traceは返さない。ログ本体はサーバーに残るCodex task traceを使い、ブラウザーlocalStorageには保存しない。保護モードのobserver接続には配信しない。

返却結果には位置、在庫、耐久度、health/food、部分output、error、停止理由を含める。executor成功はskillのboolean結果と別fieldで返す。skill call ID/parent ID、task ID、確認できた事実と未確認部分をoperation resultへ載せる。navigation/smeltingの有限waitは同じskill callへphase、理由、timeout、outcomeを記録する。公開SDK呼出しとその未await子処理はsettleまで所有するが、raw bot/plugin操作全体の停止や回収は保証しない。4,232文字のoutputは既定で省略しない。16,000文字を超えるoutputは明示して先頭/末尾を残す。実行codeと判断・結果は `bots/<name>/histories/codex-<uuid>.jsonl` に保存する。task terminalは受理task IDで絞り込み、reported/unknown、終了理由、operation settlement、保存結果を別々に記録する。shared bot rulesは判断再開ごとに読み直す。現在のvision設定を古いmemoryより優先する。Stop、新しい人間の指示、management切断、shutdownは旧threadと操作を取り消し、旧結果による再開を拒否する。native task中は旧recovery actorを並行起動しない。既存literal commandも使用できる。

確認eventはserver由来の観測を根拠にする。chest transferは前後のfull `window_items` snapshotがstatistics fence内で揃い、containerとplayer inventoryの差分が一致した量だけを記録する。Mineflayerのoptimistic slot表示だけ、片側差分、またはsnapshot欠落はunknownとして在庫操作gateを維持する。legacy command/historyには同じsettled operation resultから状態と確認事実を短く投影する。domain `false` や `returned_true` は依頼全体の達成確認を意味しない。

native Codexでは最終文章と生成時刻を要約処理より先にcheckpointし、route完了時刻とtask terminalを分けて記録する。turnは既存の `memory.json` 形式で保存してから自然言語要約をsingle-flightで裏処理する。新しい指示や停止で古い要約結果を無効化し、保留turnは保持する。既存memoryの読込形式とlegacy `History.add()` の待機動作を保ち、task JSONLから自動再開しない。JSONL保存失敗はmemory保存成否と分離し、保存済みと報告しない。[D10記録](docs/long-summary-checkpoint-stage4-20261005.md)。

OllamaのHTTP/model失敗は通常回答文字列にせず失敗として返し、`params.request_timeout_ms`（既定120000ms）と実fetch cancellation signalを適用する。会話差替え、vision、memory要約、codingの既存owner signalを使い、要約epoch invalidationは現在の要約requestもcancelする。usageはproviderが返した数値だけをrequest開始時のpurpose/task/action scopeへ記録し、欠測値は省略する。Codex legacy visionもowned CLI cancellationを共有する。[D11記録](docs/model-request-ownership-stage4-20261005.md)。

Offline fixtureは `node tests/codex_session.test.cjs`（上記Node20）で実行し、通常suiteにも含まれる。fake app-serverと所有helperでpause/resume、高速完了、部分失敗、停滞、停止/差替え/管理切断/shutdownの結果破棄、本体message入口を確認する。実ゲーム結果はbenchmark repoの記録を参照。manual playのsource pinや稼働botはこの追加で自動更新されない。
