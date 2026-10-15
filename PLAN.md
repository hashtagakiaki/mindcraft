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

---

## 独立計画：日常操作向けの移動SDK（2026-10-15）

Goal: 通常の移動は「環境を保つ」「環境を変えてよい」の2つから選び、目的地だけ渡して使える。他の行動に伴う移動は、そのスキルの目的に合う方針を内部で選ぶ。

Scope: 今回は設計のみ。この節は上記desktop-bot計画と独立している。移動SDKの実装・完了時はこの節だけを進行・除去し、先行計画は残す。

### 公開する通常移動

既存の名前を利用し、次の2つを異なる用途として定義する。`reachPosition` を残す理由は、改変可の移動を選ぶ入口として使うため。

| Native API | 経路の方針 | 成功条件 |
| --- | --- | --- |
| `skills.goToPosition({position})` | 既存ブロックを壊さない。無編集の経路を優先し、必要なら一時足場を使用する | 目的地に到着し、この呼び出しの経路足場がすべて撤去確認済み |
| `skills.reachPosition({position})` | 通行に必要な掘削・足場設置を許可する。足場は残してよい | 目的地に到着し、実行した経路編集が確認済み |

- 両方とも公開引数は必須の `position` だけ。`allowDig`、`allowScaffold`、`scaffold`、`scaffoldBlocks`、`safeWater`、`tolerance`、座標移動の `minDistance` 別名はnative公開契約から外す。距離を保つことが目的の追従・接近スキルの距離引数は維持する。
- 座標は既存の絶対feet位置、到着許容差は既存既定値の1ブロック。足場材は所持中のdirt/cobblestone、既存の安全な落差・液体・未知領域の制限を使う。調整値は内部の名前付き定数で管理する。
- 足場使用の許可は足場材の所持義務ではない。材料なしでも、歩行や許可された掘削だけで到達できれば成功する。必要な足場が作れない経路は選ばない。
- 保全側の撤去は、到着位置を維持し、安全に行える範囲で実施する。目的地でbotを支える柱などを撤去できなければ、到着済みでも非成功。撤去のために新たな掘削を許可しない。
- 改変可の移動では、不要な撤去作業を成功の前提や通常手順にしない。経路外の整地や資源採取を追加しない。
- `reachPositionWithScaffoldCleanup` はnative公開登録・一覧・現行bot向け説明から除き、撤去必須処理を内部で利用する。raw Goal/Movementsを渡す `goToGoal` も内部用にし、nativeの通常操作一覧から除く。
- bot-first / legacy呼び出しの既存引数・boolean等の契約と、既存の内部検証用詳細結果は維持する。nativeの簡略化を理由にlegacy callerまで一括で書き換えない。

### 他のスキルの移動方針

nativeの全対象から `navigation` を除く。代替の `preserveEnvironment` 引数やスキルの保全版・改変版は一律には追加しない。今回の分類では公開overrideは不要と判断する。

| スキル | 内部の経路方針 | 判断理由・作業本体の扱い |
| --- | --- | --- |
| `collectBlock` | 改変可 | 資源を掘って取りに行く行動。対象までの通路の掘削・足場残置を許可する |
| `goToSurface` | 改変可 | 地下から地上に出る行動。既存の安全な地表候補探索・接地・隣接接続の到着判定を維持し、その候補まで掘削・足場設置を許可する |
| `digDown` | 既存の専用処理 | 下方向の掘削自体が目的。既存の掘削・液体・落下制限を保ち、汎用座標移動に置換しない |
| `breakBlockAt`, `approachBlock`, `placeBlock`, `useToolOn`, `useToolOnBlock` | 保全、経路足場なし | 指定した作業対象への操作を行う。接近のために別のブロックを壊したり、足場を残したりしない |
| `fellTree` | 接近経路は保全、経路足場なし | 選定した木の伐採と作業用pillarは、既存の専用処理・撤去完了判定に従う |
| `craftRecipe`, `smeltItem`, `clearNearestFurnace` | 保全、経路足場なし | 設備に近づいて作業する。設備への到達のために周辺を改変しない |
| `inspectChestAt`, `putInChest`, `takeFromChest`, `viewChest` | 保全、経路足場なし | チェスト・倉庫周辺を保つ。選択したチェストと転送確認の契約を維持する |
| `tillAndSow`, `tendNearbyFarm`, `places.tendFarm` | 保全、経路足場なし | 対象の耕作・収穫・植え直しは作業として実施。畑や収納までの経路は改変しない |
| `giveToPlayer`, `goToNearestBlock`, `goToNearestEntity`, `goToPlayer`, `goToBed`, `useDoor`, `activateNearestBlock`, `showVillagerTrades`, `tradeWithVillager` | 保全、経路足場なし | 対象の近くで用事を行う。明示的なドア操作等、各スキルの作業は維持する |
| `pickupNearbyItems` | 保全、経路足場なし | 近傍の回収のために周辺を掘り直さない |
| `followPlayer` | 保全、経路足場なし | 終了時刻のない追従で撤去義務を増やさない |
| `attackNearest`, `attackEntity`, `defendSelf`, `moveAway`, `moveAwayFromEntity`, `avoidEnemies` | 掘削なし、足場設置・残置可 | 戦闘・退避を優先する。対象追跡・離脱のGoalを維持し、必要な足場で段差・隙間を通過できるようにする。撤去は行わない |
| `places.goTo`, `places.goToAlias` | 保全、経路足場なし | 保存場所を訪ねる操作。placeのkindや名前から周辺改変の許可を推測しない |

「保全」は、経路に既存ブロックの破壊や残置を生じさせないという契約。一時足場を必ず使う能力を全スキルへ追加する意味ではない。通常の作業・追従では経路足場なしという単純な実装を使い、有限の座標移動だけ既存の一時足場・撤去処理を利用する。

戦闘・退避では、既存ブロックを掘る余裕がなくても足場を置いて抜ける用途があるため、内部方針を `allowDig:false / scaffold:'leave'` に固定する。通常移動の公開入口は2つとし、スキル内部の方針はその特性に合わせる。この組み合わせのための公開引数や3つ目の移動APIは増やさない。

戦闘・退避は無設置で通れる経路を優先し、短い足場設置で進める経路も候補にする。長い柱積みや撤去を目的に行動を止めない。足場材なしでも移動・戦闘は開始でき、無材・使い切り時は設置不要の経路を探す。設置も装備変更・身体のclearance・server確認の時間を要するため、即時に逃げられるという保証は置かない。確認・取消・安全な落差の制限は維持し、設置後の戦闘継続時には武器の再装備を行う。遮蔽物構築や高所からの攻撃戦術は今回追加しない。

`collectBlock` の改変可は、単一対象の `breakBlockAt` より広い経路変更を許す。`fellTree` は木と作業pillar以外の環境を保つ。この違いは各スキルのdeferred docsに短く明記する。

保全するスキルで道が通れない場合は失敗を返す。必要なら呼び出し側が `reachPosition({position})` で先に移動してから作業する。実際の頻出用途が確認できるまで、個別overrideや新しい組み合わせAPIは増やさない。

### 内部構造と結果

- 既存 `navigation_policy.js` のscope、`navigationMovements`、経路編集のserver確認、pending処理のsettle、足場所有記録を再利用する。native registryでスキルごとの方針を宣言し、実行とdeferred docsに同じ定義を使う。
- 公開native呼び出しの入口で方針scopeを1つ選ぶ。スキル内で呼ぶ通常の接近・Goal helperはscopeを継承する。例えば `collectBlock` 内の移動が、legacy `goToPosition` の既定で改変禁止へ戻らないようにする。作業用の明示的な移動制限は引き続き尊重し、下位helperが権限を勝手に広げない。
- 座標、ブロック表面への接近、追従、離脱、地表候補のGoalは保持する。すべてを一つの座標Goalへ変換しない。方針適用・編集確認・取消の共通部分を共有し、既存の2つの経路追跡実装を大規模に作り直すことは目標にしない。
- 経路の破壊と作業対象への操作の境界を維持する。`collectBlock` pluginの選定work target、伐採pillar、耕作、明示設置等を経路編集として誤って拒否・撤去しない。
- 通常移動のnative結果は `{ok,status,arrivalReached,finalPosition,reason}`。足場一覧や編集履歴は通常返さない。保全側は到着と撤去完了を区別し、撤去不明・未完了を `ok:true` にしない。
- 他のスキルは元のboolean・観測・作業集計を返す。内部scopeを使っただけで `{ok,status,result,arrival,...}` に包まない。ただし未確認編集・経路失敗を作業成功に読み替えず、既存のnative失敗境界で後続呼び出しを止める。
- 保全は成功時の経路変更に関する条件。取消・切断・失敗時の完全原状復帰は保証しない。取消後に撤去を始めず、安全に残した足場等は失敗理由と内部診断へ記録する。world snapshotや永続的な足場台帳は追加しない。

### 確認済みの根拠と未検証事項

2026-10-15のsource HEADは `aa5d9d05ffd4284afdc95f577108d1644383ded3`。以下は現在のコード・保存済み検証報告の読解であり、新仕様の動作検証結果ではない。

- [`native_sdk.js`](src/agent/library/native_sdk.js) は3つの座標移動APIと、35 skills / 3 places操作への一律 `navigation` を登録している。引数の有無で作業結果の形も変わる。
- [`navigation_policy.js`](src/agent/library/navigation_policy.js) は `AsyncLocalStorage` scopeとwork targetの例外を実装済み。`runWithNavigationPolicy` は足場を許可すると、経路で使うかにかかわらず事前に所持材を要求する。
- [`skills.js`](src/agent/library/skills.js) の `reachPositionCore` にも同じ所持材の事前必須化がある。撤去は通常版でも試みる。新方針では入口の材料検査と撤去の実行条件を変更する必要がある。
- `goToSurface` はloaded範囲の安全で接続した地表候補を探している。引数を削るだけでは、地下から掘って出る動作の証明にはならない。
- [`coder.js`](src/agent/coder.js) は3移動メソッドそれぞれの非成功を判定し、native操作開始時には暗黙移動の無編集既定を設定する。新しいスキル方針がその既定と正しく合成されることを確認する必要がある。
- 戦闘は `bot.pvp.attack` によるplugin内追跡と直接の接近処理、退避は `GoalInvert` / 動的 `setGoal` を使う。方針がこの全経路へ届き、足場への持ち替え後に武器へ戻せるかは、今回の読解だけでは未検証。戦闘・退避の足場利用は実装時に確認する。
- [`place_actions.js`](src/agent/place_actions.js) はlegacyのboolean座標移動に依存する。scopeの方針を適用しつつ、visit状態・農作業の集計を保つ。
- [既存地下移動検証](../mindcraft-eval/docs/reachposition-repair-underground-20261014.md) は、2段上りや8段の柱で「到着済みだが足場撤去不能」が実際に起きることを記録している。保全の制約はAPI名だけでは解消しない。
- 既存汎用runner `../mindcraft-eval/scripts/run_direct_movement.py` はbot-first exportを直接呼ぶ。これだけではnativeのスキル別方針の適用は検証できない。native registryのfixtureと、隔離環境で `createNativeSdk` を通す使い捨てactorを組み合わせる。常設runnerの拡張は当初の成果物にしない。

実装時の最初の実験：native `collectBlock` を石壁の先の採取対象に対して呼び、経路掘削・対象破壊・drop回収が確認されるかを隔離worldで確認する。同じ壁越しの `breakBlockAt` / チェスト接近では経路を壊さないことも確認する。これでnative scope、plugin pathing、work targetの境界を区別する。失敗した場合は経路方針の適用箇所を修正し、公開overrideを足して回避しない。

### 受け入れ条件と実装時の検証

1. Native SDK一覧・deferred docs・引数検証に、座標移動2つの `({position})` と各作業スキルの固定方針が一致する。旧 `navigation` / 削除フィールドは副作用前の `SdkArgumentError` になり、hidden compatibility optionとして残さない。
2. 足場材なしの平地では両APIが成功する。石壁で保全側は既存地形を壊さず非成功、改変可側は掘って成功する。段差・柱の保全側は撤去確認まで含め、撤去不能時は `arrivalReached:true` でも非成功。改変可側は必要な足場を残して成功し、撤去のために到着地点を離れない。
3. 上記実験と代表的なチェスト・crafting table・伐採・農作業で、経路方針と作業本体の権限、元の結果形式を確認する。追従は経路編集なし。戦闘・離脱は既存Goalと取消を維持し、掘削せずに必要な足場を設置・残置できる。native入口で足場が必要な短い退避経路を使い、設置確認・離脱条件・既存ブロック未破壊・残置しても成功することを照合する。足場材なしの移動、設置失敗・取消後の後続編集停止、戦闘plugin内への方針適用と武器再装備を関連fixtureで確認する。長い柱積みを始めずに設置不要経路を選べることも確認する。
4. 地上→地下、地下→地下、地下→地上を既存階段・掘削必須の両方で検証する。前者は両API成功、後者は保全側非成功・改変可側成功が期待値。`goToSurface` もnative入口で掘削脱出後の接地・地表接続を確認する。既存の溶岩・不明領域・危険落差の拒否を維持する。
5. 主検証は既存の `tests/native_sdk.test.cjs`、`tests/reach_position.test.cjs` を更新し、変更が及ぶ `block_interaction` / `block_placement` / `tree_felling` / `surface_navigation` / `crafting_sync` / `place_actions` / native実行境界の既存fixtureを使う。既存のserver確認遅延・未確認・取消・所有権の回帰を保持する。
6. 実ゲームはread-only templateの使い捨てcopy、loopback25569/25570のみ。server側の位置と関連領域の変更をSDK結果と照合する。新仕様を通るclean source SHA、spec、観測、期待値を保存し、過去の19条件の結果を新仕様の成功証拠として流用しない。非benchmarkの新結果は `../mindcraft-tools/results/` に保存する。
7. 実装完了時に必須 `tests/run-tests.cjs` とShared Test CLI `run --scope fast --project mindcraft`、全task diffの確認を行う。README・bot指示・SDK説明・失敗判定を同じ公開契約へ更新する。既存のSDK context変更に伴うthread scope更新を確認し、保存historyを削除しない。

### 制約と次の作業

- 今回は設計文書だけを変更し、ゲーム実行・実装・manual pin更新・applyはしない。
- 開始時の別件差分（README、skills.js、bot指示、test runner、surface fixture）を保持する。実装検証時はtask差分と既存差分を分離し、無関係な変更をcommitしない。
- [ ] 2つの座標移動契約とスキル別方針をnative入口へ実装する。足場材の事前必須化を外し、保全側だけに撤去を要求する。既存の編集確認・取消・Goal・作業結果を維持する。
- [ ] 上記のnative/plugin境界実験と代表的な実ゲーム条件を確認し、関連fixture・必須suite・deferred docs・bot指示・diffの整合を検証する。
- [ ] 検証済みtask差分だけをown originへcommit/pushする。親の継続指示に従い、push済みclean sourceをmanual pinへ選んで既存手順でbot-only applyする。apply前に実target・readiness・旧bundleへのrollbackを確認し、server/world・memory/thread・Ollama停止を維持する。失敗時は既存applyのrollbackと元pinへの復帰を行う。
- [ ] 完了した移動SDKのこの節だけをPLANから除去し、先行するdesktop-bot計画は保持する。
