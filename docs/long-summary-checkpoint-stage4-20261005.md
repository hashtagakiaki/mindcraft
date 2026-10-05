# D10: response checkpoints and memory summaries

## Before

`CodexRuntime` awaited `History.add()` before routing its final text and writing the task's single `finished` event. At the message threshold, `History.add()` removed a chunk from `turns` and awaited the LLM memory summary. If that request did not return, the final response was neither routed nor terminally recorded. A trace append error could also throw out of the terminal writer and hide the in-memory task outcome.

Operation facts already have a synchronous `operation_result` line in the task JSONL. That remains the single task-event record for confirmed and uncertain changes; this update does not copy facts into a second ledger.

## Change

For native Codex sessions, model text and `generatedAt` are synchronously checkpointed as `response_checkpoint` before history persistence or delivery. `History.checkpointAdd()` appends the turn to the existing in-memory history and atomically saves `memory.json`; only after that does it queue any threshold summary. The response is routed next, and `response_reported` records the separate route/report time. The existing single `finished` terminal continues to separate completion, termination, history save result, and operation settlement.

Memory summaries use one shared single-flight drain. The summary receives a turn-chunk snapshot with an epoch. New human intent, Stop/STFU, management pause, task cancellation, and shutdown invalidate the old epoch. Invalidating restores pending chunks to `turns`; saves serialize both pending chunks and current turns, and a stale result cannot replace memory or remove turns. A still-running prompt is not duplicated; queued work can start after it settles. Summary errors remain a diagnostic and do not block the native task terminal.

Legacy `History.add()` still waits for its summary as before. Native Codex input and response checkpoints use the new path so old summaries cannot block acceptance, report routing, or terminal save. Existing `memory.json` fields remain readable through `History.load()`. The per-task JSONL is evidence only and is not used to automatically resume a task after restart.

Task trace append failures are caught and kept separate from `memory.json` save status. A model response may still be routed when JSONL writes fail; the in-memory terminal outcome marks the trace as not persisted. If the `finished` append itself fails, there is no persisted terminal claim, and the single logical terminal outcome remains available on the runtime instance and in its error diagnostic.

## Offline checks

- `tests/agent_shutdown.test.cjs`: a pending summary does not block checkpoint save; pending turns survive invalidation/shutdown and reload through the old memory format; only one summary request runs; late invalidated output is discarded.
- `tests/codex_session.test.cjs`: generated response checkpoint precedes a held route, reported/terminal events follow route completion while summary is unresolved, history save failure remains separate from reporting, JSONL `EISDIR` injection does not suppress routing, and failed checkpoint/terminal appends are not claimed as saved.
- The final required Node 20 source suite (`tests/run-tests.cjs`) exited 0. Output and explicit exit marker: `/tmp/mindcraft-stage4-d10-source-final.log` and `/tmp/mindcraft-stage4-d10-source-final.exit`.
- `tests/idle_scheduling.test.cjs`, `tests/recovery_replanning.test.cjs`, and `tests/management_reconnect.test.cjs` passed after disposable legacy History stubs were aligned with the existing `add()` success boolean (`true`).

These fixtures use temporary directories and fake model/session calls. They do not test live model cancellation or automatically resume task JSONL records.
