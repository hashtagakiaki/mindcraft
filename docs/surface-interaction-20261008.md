# Surface interaction and single-tree approach — 2026-10-08

## Change

`block_interaction.js` resolves an eye ray to a reachable target surface using installed world raycasting and block shapes. Face centers are tried first, followed by bounded interior/edge samples (at most 192 rays). Navigation goals, explicit block/chest interaction and tree work use this resolver. Center visibility is no longer an admission requirement. Unloaded cells on a ray are unknown, not transparent air. A missed sample is reported as an aim not found, not proof that no tiny surface sliver exists.

`world.inspectBlockAt` preserves legacy `visible` and center `interactionDistance`, and adds `interaction` with status, aim, intersection face, hit distance and reason. SDK interactions use reach 4.5 measured to the hit. The mining wrapper keeps native `canDigBlock` admission, tool speed, landing, look deadline, cancellation and authoritative server-air confirmation. It passes the selected face to native digging and redirects its aim to the selected point, with fresh state/ray checks before the start packet. Ignored-look calls must already point at the target. Explicit chest activation passes the same face/cursor and redirects native center-looking without replacing its inventory/window implementation.

`fellTree` first harvests currently reachable selected logs, then approaches a work target instead of the fixed east neighbor. When necessary it approaches/removes only selected logs or matching natural leaves within the selected tree bounds. It checks surface visibility before clearing a center-ray obstruction. Pillar bases retain exact positioning and the existing tracked cleanup/drop contracts. NoPath diagnostics distinguish an observed ray obstruction from an unknown path obstruction.

## Evidence

The play task `71d5364e-e4d4-437e-8138-c8b3a9b8491b` called `fellTree` four times: two material shortages and two immediate NoPath failures before log/pillar changes. Later individual operations recovered logs. The fixed east goal and the disagreement between the face goal and center-based guards were identified in source and isolated offline probes. The original probe's `canSeeBlock:false` alone was not proof of physical center occlusion: that dependency also limits its ray by distance to the block corner. The following live fixtures separately verify that the full center ray first hits stone.

On 2026-10-08 JST, direct owned SDK operations ran against a vanilla 1.21.1 CaseServer copy of the existing read-only `oak-grove` template, at `127.0.0.1:25569`. No model, play bundle or play process was used. Trusted setup modified only this disposable copy.

| Fixture | Observed result |
| --- | --- |
| Target spruce `(0,101,0)`, stone `(-2,101,-1)`, feet `(-2.9,100,-2.9)` | Center ray hit stone, legacy visible false, northern face center reachable at distance 4.4704. Approach ready, break true, native dig face 2, server verified air. |
| Same target/stone, feet `(-2.9,100,-2.1)` | Center ray hit stone and all facing face centers missed. Surface aim `(0.95,101.5,0)`, northern face 2. Approach ready, break true, native dig start/finish and server verified air. |
| Chest `(0,101,0)` with the same edge-only view | Chest's actual shape point `(0.89375,101.4375,0.0625)` was used as the activation cursor, face 2. Observed the specified chest and closed it; no current window remained. |
| Five-log natural oak, east neighbor occupied by two stone blocks | One fellTree call: complete, logsBroken = logsCollected = 5, zero remaining logs/pillars, grounded. Server inventory oak_log 5/dirt 64. Stone, neighboring spruce and crop fixture unchanged. |

Evidence is retained locally in `results/face-interaction-20261008/all-20261008T213951/verification.json`, `client.log` and `all-run.log`. The record includes server-console checks, template hashes, source file hashes and cleanup. The template hash was unchanged; client/server stopped, world copy was deleted, and port 25569 was released. An earlier probe run failed because the verifier measured a direction's length after mutable normalization; that verifier was corrected before these successful observations.

Live exports used these worktree SHA-256 values (not Git commits):

| Source | SHA-256 |
| --- | --- |
| block_interaction.js | `a4809cc6bd2131ac843323735bdd334006a290fdc50123bb5113654b871b4a5e` |
| mining_sync.js | `84b880a46837a072b7ac31694bd9feb3ba64a9e8a51f3ba1c14e77e40881d446` |
| skills.js | `c4b80a229840237f9f87e5d838d0f561a98a8797c0b24835cea8ba62c95d3393` |
| world.js | `9382c65435d64048a1cad652de9c82edd38694ebb52ea3644b05ae875a7ac0af` |

After export, SDK JSDoc was updated and generic approach's scaffold item list was explicitly emptied. The resolver also retained native's center fallback for shapeless plants when the eye is inside their loaded cell; short grass and the upper half of tall grass were verified offline. These live fixtures use shaped blocks, were already ready without navigation, and tree work already used its restricted movement set. These later changes do not invalidate the observed paths. Worktree exports also contain the unrelated, preserved viewChest edit; it is not part of this change's commit.

## Verification scope

Node 20 offline fixtures use actual shapes/world rays, real pathfinder AStar and native digging with an in-memory protocol peer. Coverage includes true center occlusion, face-center occlusion, slab/fence shapes, unloaded ray cells, no-route/full occlusion, range, actual position after navigation, target/state changes, look cancellation and ignored-look crosshair checks. The tree fixture additionally uses a nine-log east-blocked tree with tracked pillar placement/removal/pickups and soil return, center-occluded leaf preservation, bounded leaf opening and zero mutations against an unowned stone shell. Existing branch, cleanup and cancellation coverage is retained.

The live tree is a five-log case; taller-tree pillar behavior is covered by the offline regression and the earlier [tree-felling verification](tree-felling-20261007.md). This record does not claim that arbitrary thin gaps are exhaustively detected, all natural trees are supported, or manual play has been updated.

The required Node 20 `tests/run-tests.cjs` suite passed, including the new surface fixture and existing SDK, container, mining, farm, lifecycle and cancellation fixtures. `node --check main.js` and `git diff --check` also passed. The full offline output is retained locally in `results/face-interaction-20261008/offline-suite.log`.
