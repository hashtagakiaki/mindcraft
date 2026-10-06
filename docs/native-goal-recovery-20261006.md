# Native goal recovery verification — 2026-10-06

## Problem and change

The latest manual-play tasks ended with unmet goals while still below native task budgets. The completed operation results and SDK documentation reached the next model turn. The wood task stopped after interaction failures despite removable leaf cover; the chest task observed incompatible facing/single states, attempted another break and reported counts from before that mutation. These traces establish the missing continuation and verification, but do not uniquely identify the model's internal reason for stopping.

Native instructions now require deriving observable goal conditions, distinguishing a failed method from an impossible task, checking a supported cause, changing the failing conditions with existing SDK calls, and observing the entire goal after the last mutation. They carry forward short edit/check and recovery-continuation principles that the legacy coding profile already supplied. Each settled-operation input also repeats the accepted operator request. No task-specific planner, automatic obstruction removal or host-side goal validator was added; model reports and existing budgets retain their usual lifecycle.

An actual repair exposed a separate SDK defect: oriented placement always crouched, including when clicking an ordinary floor. After matching the neighboring chest's facing, that crouch still left the new chest single. Placement now reuses `Movements.interactableBlocks` to crouch for interactive supports, and otherwise prefers standing. Crouching remains available when required by face geometry; the original posture is restored under the existing operation ownership guard.

## Isolated actual execution

The harness exported source HEAD `2e0d9cf1a48ed1f914310476d348b62be2cf42ab`, overlaid only the changed native runtime and placement helper, and used the existing read-only dependencies. CaseServer copied the trusted `oak-grove` template to disposable worlds on loopback 25569/25570. Evaluator-only console setup created the fixtures and supplied an iron axe; the model received only the requested outcome and existing SDK documentation. It used the real native session, Coder/SES, ActionManager and Mineflayer skills. Background modes and vision were disabled. CLI 0.160.1 negotiated `gpt-6-luna`, medium effort.

| Fixture | Observed action and result | Native budget use |
|---|---|---|
| Two adjacent chests at fixed coordinates, south/single and west/single; request a double chest while preserving positions and floor | Observe facing mismatch, break one chest, encounter missing inventory, move to collect the drop, place with `{facing:'south'}`, then inspect both halves and floor. Final saved states: south/right and south/left. | 9 operations, 10 turns, 76.8 seconds |
| Three specified oak logs enclosed in persistent leaves; removal of necessary leaves explicitly authorized | Observe invisible targets and blocked approach, change approach, remove leaves, continue breaking logs from another height, then `pickupNearbyItems` and inspect all three target coordinates and inventory. Saved target states: air; server inventory: 3 oak logs. | 28 operations, 29 turns, 145.9 seconds |

Both tasks reported completion after their final mutation and target checks. The stopped disposable world saves independently confirmed the target states and all 90 stone floor blocks in each fixture. The first policy-only chest run selected oriented repair but failed at the 32-operation cap because unconditional crouching kept the chests single; that failed run was retained as evidence for the SDK correction.

Local evidence and disposable scripts are retained outside this source repository in [`repair-validation`](../../mindcraft-tools/results/task-incomplete-20261006/repair-validation/): `chest-policy-only-result.json`, `chest-revised-result.json`, `wood-revised-result.json`, `saved-state-verification.json`, per-task native traces and test logs. The preceding investigation is in [`DEEP_DIVE.md`](../../mindcraft-tools/results/task-incomplete-20261006/DEEP_DIVE.md). Generated runtime/world/log data is not committed.

## Regression checks and limits

The Node20 offline suite covers native lifecycle/cancellation/budgets/rules, accepted-goal retention when later history changes, ordinary versus interactive placement posture and restoration of an existing crouch. It also retains the existing placement geometry and confirmation checks.

These are one successful actual run per final fixture, with simplified terrain and fresh task threads. They do not measure a success rate, replay the original private reasoning state, verify vision quality, or guarantee all future tasks complete. The prompt change's independent contribution was not separated from model variability. The wood run still used many approaches, so navigation efficiency is not established. This source change does not activate a new manual-play bundle or modify the running bots/world.
