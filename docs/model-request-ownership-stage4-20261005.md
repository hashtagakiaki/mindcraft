# D11: model request ownership

## Observed boundary

The Codex app-server session already has a finite turn/request timeout, forwards cancellation to its owned helper process, waits for child-process cleanup, records provider errors, and records `thread/tokenUsage/updated` on the owning task trace. The legacy Codex CLI follows the same owned-process cleanup for coding. Its vision caller previously omitted the available cancellation option.

Ollama's chat adapter previously caught fetch and HTTP errors, returned `null`, and converted the result into ordinary response text. It accepted no request cancellation or timeout options, although `Prompter.promptCoding()` already passed an action `AbortSignal`. The local Ollama response also contains optional `prompt_eval_count` and `eval_count`, which were discarded.

## Change

Ollama requests now preserve the existing string-success API and throw on network/HTTP/model errors, malformed results, incomplete reasoning output, and request timeout. A timeout is read from the profile's `params.request_timeout_ms`; the default is 120000ms, matching the existing Codex model request bound. This reserved setting is removed from the Ollama generation body. Embedding and chat requests use the same bounded transport. Model/provider failures are not rewritten as ordinary responses.

The existing caller cancellation owners reach the provider request: coding uses its ActionManager context, a replacement conversation aborts the prior conversation request, VisionInterpreter passes its active action context, and History passes the current summary epoch's signal. Invalidating or shutting down a history epoch aborts its actual pending summary request; late output remains rejected by the existing epoch check. The legacy Codex `sendVisionRequest()` now accepts and forwards its optional signal so its verified helper and CLI process group settle before the caller completes.

Ollama vision input now attaches base64 bytes to a string-content message's `images` array after `strictFormat()` has finished merging messages. This follows the [Ollama vision API format](https://docs.ollama.com/capabilities/vision); OpenAI `image_url` parts are no longer sent to `/api/chat`.

When Ollama supplies token counts, the adapter reports only present finite fields through the existing local diagnostic callback, with a request ID, purpose, and action/task identity captured before awaiting the provider. Missing fields stay absent. This is diagnostic metadata, not billing, a new ledger, or a task completion fact. Codex native token usage continues to be stored in the task JSONL by the existing `token_usage` event.

An HTTP refusal from a model without vision support remains a provider error; the adapter does not guess capability from a model name. This fixture demonstrates explicit refusal, not live Ollama vision compatibility.

## Offline evidence

- `tests/ollama_contract.test.cjs`: string success; timeout configuration is not sent as a generation parameter; supplied usage is scoped and absent usage is not replaced with zero; text-plus-base64 vision payload uses `/api/chat`'s `images` array; HTTP refusal rejects; external cancellation aborts the actual fetch; a short profile timeout aborts the fetch and a deliberately late fetch result is discarded.
- `tests/vision_request_ownership.test.cjs`: VisionInterpreter passes the active action cancellation context to the prompt/provider caller.
- `tests/agent_shutdown.test.cjs` and `tests/codex_session.test.cjs`: history invalidation aborts the active summary owner while pending turns and native task response/terminal behavior remain intact.
- `tests/generation_cancellation.test.cjs`: legacy Codex vision cancellation terminates its CLI leader and child and removes the owned temporary directory before settling.
- Final required Node 20 source suite `tests/run-tests.cjs` exited 0; complete output is `/tmp/mindcraft-stage4-d11-source-final.log`, and the explicit exit marker is `/tmp/mindcraft-stage4-d11-source-final.exit` (`0`). Changed source files also passed Node 20 `--check`, and `git diff --check` was clean.

The tests use fake HTTP responses, fake image data, and the existing disposable Codex CLI. They do not call Ollama, a model provider, Minecraft, or a live vision model. Payload shape is verified; vision model compatibility/performance is not. Provider cancellation support is limited to the owners described above; unrelated provider implementations and Ollama response streaming are unchanged.
