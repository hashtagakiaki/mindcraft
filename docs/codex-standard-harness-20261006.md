# Codex standard harness migration — 2026-10-06

Native Minecraft tasks reuse the Codex app-server mechanisms for SDK discovery, tool-response waiting, conversation persistence/compaction and image input. Minecraft retains the existing Coder/SES/linter, ActionManager, cancellation, budgets, rule refresh, authenticated peer routing and observed-state/diagnostic boundaries.

| Concern | Previous native behavior | Result |
|---|---|---|
| SDK context | Full SDK embedded in each task's base instructions | Existing docs registered as deferred `minecraft_sdk` documentation tools; standard tool_search/code mode discovers them |
| Operation wait | Running acknowledgement, turn interrupt, completed result in a new turn | Actual settled result returned to the pending dynamic tool call |
| Conversation | Ephemeral thread per request; old local conversation injected again | Scoped persistent thread resumed across requests; only new local context is sent |
| Memory | Auxiliary model summarizes native local turns | Codex owns native compaction; local UI/seed turns remain bounded and archived |
| Vision | Auxiliary vision model produces text | JPEG returned directly as `inputImage`; attachment metadata in SDK text |
| Messages | All agent messages joined as final output | Commentary streamed; final response excludes commentary |

The current SDK has 74 documentation entries / 32,415 characters, including the new native image contract. Those entries are no longer embedded in base instructions. They are registered with the CLI; this host-to-CLI payload size is not the model's always-visible context size. No new search index, embedding selector or memory/vision model was introduced. Input token/latency savings have not been benchmarked.

## Compatibility evidence

Disposable app-server probes used the installed CLI **0.160.1**, explicit `gpt-6-luna` and medium effort. They executed no Minecraft commands and touched no live bots, server/world or Ollama. Probe-owned stored threads were deleted and CLI processes reaped afterward.

Initial deferred discovery appeared unavailable despite provider `namespaceTools: true` and model `supports_search_tool: true`. Installed-version source and model metadata established that `tool_mode: code_mode_only` places search behind `functions.exec`. The original Minecraft instruction prohibited that entry point. Permitting native code mode for discovery resolved documentation calls. A process-local CLI override `code_mode.direct_only_tool_namespaces=["functions"]` exposes `minecraft_execute` directly so its images need no intermediate code-mode forwarding. Global Codex configuration was not changed.

The final probe used the implemented **CodexSession and SDK documentation adapter**, with the owned CLI helper:

- The model discovered/read `vision.captureProbe` documentation. The required argument `OPQ_57` existed only in that deferred document and appeared in executed code.
- Each execution received its actual tool response without a turn interrupt. A synthetic green-square JPEG was returned through `inputImage`; the model reported green and marker `HARNESS_826`.
- After closing the first CLI, a new session resumed the stored thread. Explicit standard `thread/compact/start` completed; the next no-tools answer retained the marker and green color.
- The image probe made three disposable execution calls. This checks transport/interpretation, not optimal call count or Minecraft task success.

The standard automatic compaction mechanism is retained; the probe explicitly invoked it to verify the endpoint and retained history. It did not force a naturally full context window. Deferred SDK specs are restored with a saved thread, so bot/world/model/effort/SDK/vision scope mismatches start fresh. Missing Codex rollouts fail explicitly rather than replaying game work. `load_memory: false` prevents loading the pointer on bot restart; requests within one running bot may still share its newly created thread.

## Regression checks and boundaries

The required Node20 offline suite, syntax check and whitespace check cover the final source. Native fixtures verify pending-result waiting, commentary/final separation, fast completion, partial failure, shared rules after every SDK result, queued-call admission closing on rule-read failure, cancellation/actual drain, peer authentication, task budgets, thread save/reload/scope/reset, and new recipient/behavior context without full history reinjection. Native images use the real interpreter/Coder/ActionManager boundary with a fixture camera: no helper vision call, current-owner admission, four-image/2 MiB bounds, partial images on failure and metadata-only host traces. Existing legacy memory/vision and process ownership checks remain in the suite.

The camera fixture now uses the existing dependency resolver rather than assuming one checkout location. The repository's read-only dependencies were not installed or modified. During this task, source `4ae8dfd` advanced on the same fork; its accepted-goal retention, recovery instructions and placement correction were incorporated. The accepted request is repeated in standard tool results, preserving that recovery behavior.

These checks do not verify rendered Minecraft image quality or play success rates. The older [goal-recovery live results](native-goal-recovery-20261006.md) tested their recorded implementation, not this transport change. No manual-play pin, bundle or running service was changed. Goals and operator steering are outside this migration.

Official implementation references: [app-server protocol](https://learn.chatgpt.com/docs/app-server), [native deferred-tool guide](https://developers.openai.com/api/docs/guides/tools-tool-search), and installed-version [tool registry](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/tools/spec_plan.rs) / [dynamic tool response wait](https://github.com/openai/codex/blob/rust-v0.160.1/codex-rs/core/src/tools/handlers/dynamic.rs).
