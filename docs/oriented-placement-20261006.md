# Oriented placement — 2026-10-06

Implementation owner: `src/agent/library/block_placement.js`, called through the tracked public `skills.placeBlock` and `!placeBlockFacing`. Usage and supported options are in [README](../README.md#placement-with-a-requested-orientation).

## Inputs and boundaries

- Minecraft Java 1.21.1, survival, actual Mineflayer 4.39.0 and pathfinder 2.4.5; the documented Node executable reports 20.20.2.
- Disposable CaseServer copies of the existing eval `fixtures/worlds/oak-grove` template. Game/RCON listeners are loopback 25569/25570. Setup commands, inventory provisioning and arena changes affect only the owned copy.
- Development source is based on `d3a4cf83a4ad4c545c37d09d1645b49db6e5b939` plus this change. Candidate runtimes export the source and link the existing dependency tree read-only. Unrelated uncommitted chest-navigation changes are excluded from the runtime candidate and commit.
- The manual server, world, four bots, UI, Ollama and source pins are outside this verification. No LLM requests or management activation are needed for the direct skill smoke.

## Confirmed placement rules

Direct plugin experiments observe server block updates and full `getProperties()` states. They establish these operation mappings:

| Family | Mapping |
|---|---|
| Furnace / chest / repeater / comparator | Horizontal block facing is opposite bot look |
| Stairs / door / bed | Horizontal facing equals bot look |
| Observer | All six facing values equal bot look |
| Piston / dispenser / dropper | All six facing values are opposite bot look; above/below player positions did not override transmitted look |
| Logs | Axis equals the clicked face's axis |
| Stairs / slabs | Side click below/above the midpoint selects bottom/top; support top selects bottom, support underside selects top |
| Wall torch / ladder | Facing is opposite target-to-support direction; inventory torch becomes wall_torch |
| Lever / button | Floor/ceiling facing equals horizontal look; wall facing is determined by the support, independently of look |
| Door / bed | Door upper half is +Y; bed head is in the facing direction. Both parts must be observed |

Sneak is required when clicking an interactive support such as a chest or furnace. Sneaking changes eye height to 1.27 and prevents adjacent chests from automatically joining when the floor is clicked. Chest joining/type is not a requested property.

The local ignored experiment records are under `../../mindcraft-tools/results/placement-rules-confirmed-20261006/` and the initial/extra folders named in its `SUMMARY.md`. Initial RCON checks using `execute if block ... run say` produced empty replies; those replies do **not** prove an independent match. Initial rule evidence is the Mineflayer server observation. Final skill verification uses standalone `execute if block` with explicit pass/fail responses, including a known false control.

## Dependency behavior handled by the implementation

- Pathfinder's horizontal `facing` argument is reversed relative to the vector towards the clicked point. The adapter translates this without changing the public block-state meaning.
- Mineflayer `lookAt` may resolve when yaw has converged while pitch transmission is still in progress. Placement temporarily observes the existing physics writer's `look` / `position_look` packets and waits for both angles. A small ordinary look change establishes a fresh packet if the first call is already looking at the point. The original writer is restored afterward; no custom placement or look packet is generated.
- Pathfinder's `half` filter incorrectly discards a floor support's top face for bottom placement. The helper applies that filter only to side clicks and keeps eligible vertical faces.
- Pathfinder evaluates placement nodes with a standing eye height of 1.6. The helper searches with the measured sneak eye height and checks the actual eye height before sending.
- A path node's cell centre differs from a bot standing at its edge. The helper checks the real position for the current cell and pathfinder's current-cell +Y arrival shortcut; this prevents an invalid face being accepted as an already reached goal.

## Offline verification

Node 20 `tests/run-tests.cjs` completes with exit code 0. After the last arrival-condition adjustment, `tests/block_placement.test.cjs` also completes with exit code 0. The focused fixture covers public options, registry normalization, occupied/no-op targets, unknown observations, strict supports, floor/side candidates, sneak height, off-centre arrival, immediate/delayed updates, a plugin error after confirmation, transmission timeout, cancellation and pending-plugin settlement, setting restoration, cheat partial placement, legacy string calls, literal commands, always-selected documentation, and the actual SES/lint path.

The full suite required two existing fixture setup repairs: `place_store` and `management_auth` now copy the already imported `bot_output_history.js`. No management behavior was changed. Local logs are `../results/oriented-placement/offline-suite-final.log` and `offline-focused-final.log`. Syntax and whitespace checks pass.

## Final isolated skill verification

The final direct public-skill matrix passes **82/82 cases** and **92/92 full block-state RCON checks**. Standalone `execute if block` responds `Test passed` for matching states and `Test failed` for an intentionally wrong state; empty replies fail the check. The final helper hash matches the development helper. A naming-only extraction of the unchanged 0.01-radian look refresh value is recorded separately in the source provenance.

The matrix covers furnace/chest/stairs in all four horizontal directions, three log axes, stair/slab halves, wall torch/ladder in four directions, lever/button wall/floor/ceiling, repeater/comparator, door/bed in all four directions and both parts, and observer/piston/dispenser/dropper in all six directions. It also covers an occupied wrong-facing block without replacement, an existing matching no-op, a missing explicitly requested support, legacy crafting-table/furnace/torch calls, and cheat furnace/door/bed placements. Off-centre top-stair and downward-observer cases pass after actual navigation with the corrected arrival predicate.

Normal successful placements send one placement packet each. No-op/refused cases send none and preserve inventory. Sneak settings are restored. One bed case initially observed a delayed client inventory count; a single-case probe confirmed the server inventory and subsequent client observation both contain seven beds after starting with eight.

Local ignored evidence is under `../../mindcraft-tools/results/placement-skill-final-20261006/`: `skill-results.json`, `summary.json`, `source.json`, and `cleanup.json`. The inventory probe is in `placement-skill-inventory-probe-20261006/inventory-probe.json`. Owned clients and servers stop, disposable world copies are removed, and the source template hashes remain identical. Generated RCON credentials are scrubbed after shutdown.

These checks exercise actual public skills and pathfinding with a fixture mode controller, plus offline command/SES integration. They do not measure LLM instruction interpretation, orchestration of four live bots, or gameplay on other Minecraft versions. Existing play bundles and pins are unchanged.
