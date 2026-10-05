# D13: bounded state polling and camera lifecycle

## State polling

The MindServer state listener now runs one poll at a time and schedules the next poll only after the current one completes. Each bot acknowledgement has a named 750ms deadline. “Fresh” means the current connection returned a state object before that deadline; it does not mean every world field is known or guarantee that each field was freshly observed. A missing or invalid acknowledgement leaves that bot's last known state marked stale, or unknown when no state has ever arrived; it does not delay updates for other bots. Freshness includes the observation timestamp, and the UI labels current, stale, or unknown state while retaining the last known fields for context.

Each state callback is accepted only while both its `AgentConnection` object and socket are still current. Removing the last listener stops the timer and invalidates callbacks already in flight; late results are discarded. The listener cadence remains one second after a completed poll, rather than overlapping timer ticks.

## Camera capture

`Camera.ready` resolves after the world view initializes and rejects on initialization failure. Captures wait for readiness, allow only one active capture, retain the existing 800×512 render size, and stop buffering a JPEG above the named 2 MiB cap. A canceled or closed capture cannot write a screenshot after a late world-view update or stream result.

Camera close removes the WorldView's bot listeners and disposes the existing renderer once owned capture work settles. These cleanup calls match the installed read-only dependency APIs `WorldView.removeListenersFromBot(bot)` and `THREE.WebGLRenderer.dispose()`. Agent shutdown gives camera work a bounded 500ms drain opportunity and reports `{closed, drained}` separately; if an underlying world update does not settle in that window, shutdown continues and the camera does not claim it drained. A synchronous renderer call itself cannot be interrupted by a timer; cancellation checks reject late results after synchronous work returns. No new renderer worker or process was introduced.

## Offline evidence and limits

- `tests/state_poller.test.cjs` covers a bot missing its acknowledgement while another bot updates, stale/unknown state, current-connection replacement, and listener stop invalidating a late callback.
- `tests/camera_lifecycle.test.cjs` uses fake viewer/world-view/renderer/stream dependencies to cover capture before readiness, readiness failure, concurrent capture rejection, mid-capture cancellation, byte-limit enforcement, and bounded close/drain with late-result discard.
- `tests/agent_shutdown.test.cjs` verifies Agent calls camera close and preserves `drained: false` without blocking shutdown indefinitely.
- Final Node 20 `tests/run-tests.cjs` completed with exit code `0`; output is `/tmp/mindcraft-stage4-d13-source-final.log`, and `/tmp/mindcraft-stage4-d13-source-final.exit` contains `0`. All changed JavaScript files passed `node --check`; `git diff --check` passed.

These fixtures establish lifecycle and payload bounds only. They do not measure rendering cost, prove screenshot visual correctness, or benchmark live polling latency. No renderer workerization or live Minecraft capture was performed.
