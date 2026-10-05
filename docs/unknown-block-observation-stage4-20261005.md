# D08: unknown block observations

## Change and evidence

`world.getBlockAtPosition` previously converted Mineflayer `bot.blockAt(...) === null` into `{ name: 'air' }`. That erased the distinction between an empty loaded block and an unloaded position. The helper now preserves `null`; surrounding-block output says `unknown`, and `getFirstBlockAboveHead` stops at an unknown gap instead of searching past it and claiming a farther block.

Full-state responses and Codex native observation snapshots carry an `observationScope` with `observedAt`, `dimension`, `worldConnectionGeneration`, and separately named management connection/readiness/server fields. This code has no authoritative Minecraft world-connection generation. `worldConnectionGeneration` therefore remains `null`; the MindServer socket generation is not relabeled as a world generation. Full-state is only returned while management is ready, and Codex snapshots mark readiness explicitly. The operation context's `connectionGeneration` keeps its existing meaning and remains null where no source value is available.

The affected block-changing helpers now stop before their target mutation when the target observation is null: `breakBlockAt`, `placeBlock`, and `digDown` return `false` and record an uncertainty on the owning SDK call when one exists. `digDown` no longer treats an unloaded target as the bottom of the world. Placement also refuses when no known support block exists and support candidates include unknown blocks. This is a guard for these observed-null cases, not a claim that every raw bot/plugin action is tracked or that all multi-step skills are side-effect-free on uncertainty.

The existing place verification path compares dimensions and re-reads the current target with `bot.blockAt`; unloaded targets reject verification. Mining's `freshTargetBlock` similarly rechecks the current target immediately before digging. These local checks are retained; no saved snapshot is passed into world mutation APIs. Mineflayer's physics plugin also returns early when the current block lookup is null (unloaded chunk). No separate Minecraft generation counter or full-world snapshot was introduced.

## Offline checks

- `tests/world_observation.test.cjs`: preserves null, distinguishes known air, stops above-head scanning at unknown, and checks full-state scope labels.
- `tests/run-tests.cjs --interaction-confirmation-only`: actual SDK helpers reject null break/place/dig targets before `dig`, `placeBlock`, or creative inventory mutation and record three same-operation uncertainties.
- `tests/codex_session.test.cjs`: native observation carries dimension/time, leaves world generation null, and reports disconnected management readiness without a server generation.
- `tests/agent_shutdown.test.cjs`: Agent fixture imports the shared observation-scope helper.

These are offline fixtures; they do not establish behavior across every plugin/raw bot access or a live server. The final required source suite (`tests/run-tests.cjs`) exited 0; its output and explicit exit marker are `/tmp/mindcraft-stage4-d08-source-final.log` and `/tmp/mindcraft-stage4-d08-source-final.exit`.
