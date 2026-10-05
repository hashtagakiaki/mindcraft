# Navigation progress and bounded waits (D03)

`goToGoal` previously reset its 90-second stall clock only when the goal heuristic improved. That stopped a necessary detour even when Mineflayer's active route was being traversed. A position-only reset would let a bot extend the wait by walking back and forth. The pathfinder exposes `path_update` and `path_reset`; a route event by itself is not progress.

The SDK now treats either a 0.5-or-better improvement in the goal heuristic or first arrival at an unvisited node from the current active path as navigation progress. Revisiting a node and route recalculation alone do not renew the clock. The active route node set is local to that `goToGoal` call and its listeners are removed when the wait settles. The existing `navigation_stall_timeout_ms` / `navigation_check_interval_ms` defaults remain 90 seconds / 5 seconds.

Every owned navigation wait records its phase, reason, start/end time, bounded timeout, outcome, and visited-node count under its SDK call ID. The native ActionManager stall monitor uses that call's route-progress count while the action phase is `navigation`; it still requests the existing 30-second stall stop if no new route node is reached. This avoids replacing the native limit with the source monitor's longer default. Outside navigation, the native position/inventory stall rule is unchanged. The 120-second native action hard timeout and task budget are unchanged.

Smelting keeps its existing 11-second no-output quiet period, which resets when output is observed. The result records `waiting-for-smelting`, the no-output reason, quiet-period deadline, elapsed time, and outcome under the owning skill call. A synthetic output after several polls succeeds; a silent furnace returns false after the quiet period. This does not introduce a total smelting deadline: the existing operation hard timeout remains the overall native bound.

Offline evidence:

- The focused navigation contract fixture covers a necessary detour whose goal heuristic does not improve, a genuinely stalled route, repeated visits to the same nodes with path resets/replans, and unique wait IDs for multiple SDK calls. `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs --navigation-only` passed.
- `node tests/codex_session.test.cjs` passed with a native-stall fixture where an owned route-segment update keeps the action alive and an unresponsive navigation is stopped at the existing 60ms test limit. The production default remains 30 seconds.
- `node tests/furnace_lifecycle.test.cjs` passed with a synthetic 350ms delayed output (several poll intervals) and silent-output cases; it validates waiting/projection and the 11-second quiet bound, not long-duration or repeated multi-output smelting. The 11-second quiet period was not changed.
- Tools capability tests passed for both the previous goal-distance marker and the route-segment implementation using the common named timeout setting. The benchmark/manual pins and live play were not used.
- The final required Node suite passed with exit code `0`; output and the separately saved exit marker are `/tmp/mindcraft-stage4-d03-source-confirmed.log` and `/tmp/mindcraft-stage4-d03-source-confirmed.exit`.

Before this stage, the stage-three required source suite was rerun with the specified Node 20 binary. All fixtures passed and exit code `0` was saved in `/tmp/mindcraft-stage3-source-final.exit`; full output is `/tmp/mindcraft-stage3-source-final.log`.

These fixtures establish detector behavior only. No live gameplay run measured whether detour success or task outcomes improve.
