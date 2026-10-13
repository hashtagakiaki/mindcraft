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
