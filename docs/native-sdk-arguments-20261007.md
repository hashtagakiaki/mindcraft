# Native SDK named arguments — 2026-10-07

## Implemented contract

The `codex-session` runtime publishes all 83 existing SDK methods through [`native_sdk.js`](../src/agent/library/native_sdk.js). Each method binds its bot on the host and accepts one named object; methods with no required fields may omit it. The same explicit definitions produce the facade, deferred documentation, method catalog and lint inputs. Internal, legacy generated and chat-command APIs retain their existing signatures and results.

Absolute coordinates use `position`, relative coordinates use `offset`. Transfers require positive item `quantity` or explicit `'all'`; collection uses block `count`, crafting uses recipe-execution `times`. Validation rejects unknown/missing fields, invalid types, nonfinite coordinates, invalid quantities and exclusive options before invoking the underlying function. Cross-realm SES objects are supported. Family-specific placement rules keep their existing domain-failure contract.

`SdkArgumentError` exposes `code: 'INVALID_ARGUMENT'`, `method`, `field`, `expected`, `signature` and a corrected `example`. Action results and bounded task diagnostics retain this information. Earlier valid mutations in compound code are not rolled back. Synchronous observations, operation ownership, cancellation, settlement, false handling and image results remain intact. The native context protocol advances to 6, starting a new thread once for the changed contract; matching new threads resume normally. Raw `log(bot, message)` remains an output helper.

```js
await Promise.resolve();
const position = world.getPosition();
const nearby = world.getNearbyBlockTypes({radius: 12});
const target = world.inspectBlockAt({position: {x: 10, y: 64, z: -3}});
const placesFound = await places.find({text: 'chest'});
log(bot, JSON.stringify({position, nearby, target, placesFound}));
```

## Verification

- Registry fixture: all 83 methods; docs/runtime consistency, two-bot separation, defaults, quantity units, synchronous/promise identity and invalid-input rejection before internal calls.
- Real Coder/SES/ActionManager fixture: saved missing-bot and positional misuse, successful named-object corrections, `places` template binding, structured historical diagnostics and zero movement/look/open/dig/RPC for invalid calls.
- Full Node20 offline suite plus native session, vision and targeted fixtures passed. Legacy/internal/chat behavior, placement, farm, cancellation, drained unawaited calls, communication and image delivery remain covered.
- Isolated real Codex CLI new/resume probe read deferred explanations and called `world.inspectBlockAt({position: ...})` then `vision.lookAtBlock({position: ...})`. Both operations succeeded; both turns correctly identified the supplied image label/color. Sessions were private to the result directory; only auth/config were symlinks.

Local ignored evidence: [source checks](../results/sdk-arguments-20261007/), [CLI verification](../../mindcraft-tools/results/sdk-arguments-20261007/cli-probe/verification.json), [comparison summary](../../mindcraft-tools/results/sdk-arguments-20261007/comparison-summary.json).

## Isolated warehouse comparison

Each version ran three new threads on fresh copies of the existing oak-grove template at loopback 25569. The request was `この建物の内部に、利用できる倉庫を作って。`; model `gpt-6-luna`, effort `medium`, vision disabled, budget 300 seconds / 32 operations / 40 turns. The pre-task room geometry and final inventory (8 chests, 32 oak planks) matched across all six trials. Two early client snapshots preceded the final inventory packet; final preflight inventories were identical.

Before source: `4f46e09c04a6b0f1c9585cea5e3496e3996cfaf5`. After: that archive with a fixed source overlay; all three overlay hash sets matched and are saved in the summary. The overlay also included the pre-existing, uncommitted `viewChest` phase/close cleanup, which is excluded from this implementation commit and activation. This is therefore evidence from the recorded builds, rather than strict attribution of every outcome to the argument change alone.

| Observed result (three trials total) | Before | After |
|---|---:|---:|
| Operations | 16 | 31 |
| Argument errors | 9 | 1 |
| Bot/positional TypeErrors | 8 | 0 |
| Structured argument errors | 0 | 1 |
| Existing require-await lint errors | 0 | 4 |
| Deferred documentation reads | 37 | 23 |
| Usable interior storage verified | 1/3 | 3/3 |

The remaining argument error passed an unsupported `position` field to `world.getSurroundingBlocks`; the response showed its no-input signature and correction, and the task recovered. Before errors included missing/wrong bot arguments and one positional radius misuse. Lint failures were counted separately; synchronous observations remain synchronous and the existing await requirement is unchanged.

Storage outcomes use stopped server NBT plus an independent access audit, including container open/close and an unobstructed entrance; model completion text alone is insufficient. After trials produced 2, 1 and 3 accessible interior chests. The experiment-only NBT observer originally cached by region across a chunk boundary; it was corrected to cache by chunk and every stopped snapshot was recomputed. Native task packet counts exclude the independent audit.

All owned isolated helpers exited and port 25569 was released. Three trials on one fixture do not estimate general play success rates. Manual play activation is recorded separately in [`play/README.md`](../../play/README.md); these isolated trials do not establish live-world gameplay quality.
