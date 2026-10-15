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

## SDK全体の再設計 — 2026-10-16（設計のみ）

Goal: native botが日常の目的を直接呼び出し、接近・装備・確認・後始末の実装判断を繰り返さずに作業できる。対象、数量、作業範囲など結果を変える判断だけを呼出側に残す。以下は提案であり、実装済みの契約ではない。上のdesktop-bot計画とは独立して実行する。

### 判断の基準と確認した現状

- 調査基準はHEAD `d1cb986d09e1b0c7c16e928cc2cfcbf59dc0eceb` と既存worktree。変更前からある `README.md`、`src/agent/library/skills.js`、`src/process/codex/AGENTS.md`、`tests/run-tests.cjs`、`tests/surface_navigation.test.cjs` の差分は本計画の実装に取り込まない。
- 正本 [`native_sdk.js`](src/agent/library/native_sdk.js) の実数は83件（skills 43 / world 22 / places 13 / vision 3 / diagnostics 1 / communication 1）。同じ定義から引数検証、facade、deferred docs、名前一覧・lint入力を作る構成を維持する。method数の削減自体は目標にしない。
- 座標移動の `goToPosition({position})` / `reachPosition({position})`、固定経路方針、コンパクトな移動結果は既存の設計として維持する。`navigation`、`allowDig`、cleanup指定、共有の可変modeを公開引数へ戻さない。設備への接近と対象そのものの作業権限は別である。
- [`skills.js`](src/agent/library/skills.js) では `craftRecipe` がレシピ回数を受け取り、要求回数の一部だけ製作できてもtrueを返す。`placeBlock` はorientation指定時だけstrict確認経路を使い、無指定は従来の通常設置経路になる。これは使い勝手・成功契約を見直す根拠であり、今回runtimeで再現した不具合という主張ではない。
- 農作業はnearby側がcountsだけを返し、[`place_actions.js`](src/agent/place_actions.js) 側は進捗があれば `ok:true` と部分保管失敗が同居しうる。saved farmの公開引数には内部で捨てる `startPosition` / `chestPosition` も含まれる。`searchRadius` はconnected plotの開始点探索距離で、連結農地全体の作業半径ではない。保存農地は開始点が固定されるので、この探索引数も対象選択に使わない。
- [`places.js`](src/agent/places.js) のfind/inspect/remember系は整形文字列を返すが、alias解決はobjectを返す。store/RPCは既に構造化recordとtext省略の絞込み検索を扱える。文字列の再解析や新しい永続schemaは不要。
- [`coder.js`](src/agent/coder.js) のnative safetyはquery一覧と一部method名を個別判定する。観測の `false` / `null` はdata、行動の失敗は同一batch停止という既存方針は妥当。ただしfarm等の完了条件は一貫して接続されていない。
- [`codex_runtime.js`](src/agent/codex_runtime.js) は位置、health/food、在庫合算、道具耐久、装備、観測scopeを判断再開ごとに供給済み。自己状態の巨大な新SDKや、毎操作の重複観測は追加しない。既存のconfirmation、operation owner、inventory gateを使い、ログの文言から確認数量を復元しない。

### 公開面の決定（現行83件をすべて対象）

表の名前は現行registryの名前。維持は引数・用途を維持する意味で、内部の接近と完了確認は下の共通契約に従う。内部化・統合はnative面だけに適用し、bot-first内部API、legacy生成コード、chat commandは互換を保つ。

| 対象 | 決定と理由 |
| --- | --- |
| skills.goToPosition / reachPosition | 維持。地形保全と経路編集は意味のある2目的。到着位置とcleanupを含む現行結果を保つ。 |
| skills.goToNearestBlock / goToNearestEntity / goToPlayer / followPlayer | 維持。探索先へ行く・人へ近づく・追従し続ける目的は別。minDistance / radiusは任意の調整として残し、通常例では省略する。設備使用の前処理として要求しない。 |
| skills.moveAway / moveAwayFromEntity / avoidEnemies / defendSelf / attackNearest / attackEntity | 維持。指定対象、最寄り種、周囲の敵を区別する。kill:falseの単発攻撃も残す。現在のEntityを再解決し、装備選択と足場設置後の武器復元を内部責務にする。戦闘経路は掘削・tower不可、bridge足場残置可の既定を保つ。 |
| skills.breakBlockAt / collectBlock / fellTree | 維持。1対象の破壊、指定数の採取、自然木1本の完了は別目的。collectBlock.countはブロック数、excludeは除外座標として残す。fellTreeは選択木と自分の柱の完了を維持し、汎用採取へ吸収しない。 |
| skills.approachBlock | 維持する専門的な接近操作。単独で操作面を確保したい場合に使え、ready/blocked/unknownを返す。破壊・収納等の必須前処理にはせず、それらのskillが内部で必要な接近を行う。 |
| skills.placeBlock | 変更。orientationの有無で成功の根拠が変わらない設置へ統一。facing / axis / half / attachToは意図があるため残す。placeOnはnativeから外し、支持面は内部選択、指定時だけattachToを厳守する。dontCheatは今回は維持し、cheat利用の既存明示設定を変えない。 |
| skills.craftRecipe | nativeは `craftItem({itemName, quantity=1})` へ置換。quantityは今回新たに作る最低アイテム数で、既存在庫の目標数ではない。レシピの整数回数・端数切上げを内部計算し、余剰生成数も返す。内部craftRecipeのtimes契約は保つ。 |
| skills.smeltItem / clearNearestFurnace | 維持。smeltItem.quantityは投入個数を維持し、出力itemNameと確認数量を返す。両者に任意の `furnacePosition` を加え、無指定は既存の最寄り設備選択。精錬と他者の炉内容回収は統合しない。 |
| skills.inspectChestAt / viewChest | `inspectChest({position?})` へ統合。省略時は最寄りを選び、明示時は代替しない。いずれも実際の位置・内容・観測時刻を返して閉じる。boolean＋ログだけの観測はnativeから外す。 |
| skills.putInChest / takeFromChest | 名前・quantity / chestPositionは維持。方向はmethod名で表し、汎用transferのdirection引数を増やさない。確認数量を構造化して返す。省略時の最寄りと明示対象を区別し、変更対象を勝手に切り替えない。 |
| skills.discard / giveToPlayer | 維持。quantityの明示と'all'の現行適用範囲を保つ。giveは地面へ渡す操作であり、相手の取得まで確認したとは扱わない。共有チェスト転送と同じ保証へ水増ししない。 |
| skills.equip / consume / pickupNearbyItems | 維持。consumeのitemName省略は食料自動選択、明示は食料/potion指定。装備品の指定は独立目的として残すが、採掘・戦闘の前に毎回equipさせない。pickupは有限の近傍回収で、全世界のdrop回収ではない。 |
| skills.tillAndSow / tendNearbyFarm / places.tendFarm | 維持して契約を整理。1区画の耕作・播種、近傍農地、保存農地は別目的。nearbyのconnected / radiusは範囲の異なる正当な選択なので残す。saved側は `{farmId, seedReserve?}` だけとし、scope / radius / searchRadius / startPosition / chestPositionの無効・無視される選択を除く。 |
| skills.useDoor / activateNearestBlock / goToBed | 維持。無指定の最寄りを日常既定とする。activateNearestBlockには任意positionを加え、指定したlever等を扱えるようにする。useDoorとbedの目的を汎用useToolへ移さない。 |
| skills.useToolOn / useToolOnBlock | 整理。最寄り種類への `useToolOn({toolName,targetName})` は残す。座標指定の `useToolOnBlock({toolName,position})` は生BlockのVec3を呼出側に保持させず直前に対象を解決する。targetName:'nothing'は `useItem({itemName})` へ分離する。'hand'は素手を明示する意味があるので残す。 |
| skills.showVillagerTrades / tradeWithVillager | 維持。前者は名前を維持して構造化trade一覧を返すqueryに変更する。後者のentityId / 1始まりindex / timesは明示的な取引選択として残す。新しい取引自動選択器は作らない。 |
| skills.digDown / goToSurface | 維持。縦掘り量と地表脱出は異なる目的。未到着・unsafe中断は成功にしない。経路方針を呼出側へ戻さない。 |
| skills.wait / stay / log | 維持。waitは有限の処理待ち、stayは姿勢・modeを維持する行動。外部イベントをpollし続ける用途へ拡張しない。単独stayとGoals完了の既存関係も保持する。logと既存global logの整理は影響に対する便益が小さいため延期。 |
| world.inspectBlockAt / getBlockAtPosition | inspectBlockAtは維持。相対専用の後者だけnative名を `getBlockAtOffset({offset})` に変更し、絶対positionとの取り違えを減らす。Block返却とnullの意味を保つ。 |
| world.getNearestBlocks / getNearestBlocksWhere / getNearestBlock / getNearestFreeSpace | 維持。日常検索と属性predicateによる限定batchの両方を保つ。radius / limitは任意、上限はhostが設定。getNearestFreeSpaceは候補発見であり、設置・立位成功の事前保証とはしない。 |
| world.getNearbyEntities / getNearestEntityWhere / getNearbyPlayers / getNearbyEntityTypes / getNearbyPlayerNames / getNearbyBlockTypes | 維持。対象reference取得と短い種類一覧を用途で選ぶ。文字列名、entity ID、Block座標を巨大な共通target objectへ統合しない。 |
| world.getInventoryCounts / getCraftableItems / getPosition / getSurroundingBlocks / getFirstBlockAboveHead / getBiomeName | 維持。countは合算、craftableは現在の材料・設備での候補、block未ロードはunknown。getCraftableItemsは装備調達や作業完了の保証ではない。 |
| world.getVillagerProfession / isEntityType / isClearPath | 維持する補助query。falseも通常のdata。isClearPathは現条件の経路照会であり、後続actionの保証や必須事前検査にしない。 |
| world.shouldPlaceTorch | nativeでは内部化。これは既存torch modeの実装判断で、日常目的の観測ではない。必要な照明設置はplaceBlockで表す。内部autoLight/legacy利用は保つ。 |
| places.find / inspect / rememberHere / rememberObservedAt / rememberReported | 変更。整形文字列を構造化recordへ変える。find.textは省略可としkind/purposeだけで検索可能にする。現在地点、実物観測、伝聞の信頼差は名前ごと維持し、自動昇格・統合しない。 |
| places.verify / setOutputStorage / setAlias / setHome / resolveAlias / goToAlias / goTo | 維持。stable IDと個人alias/homeを区別する。verifyのmissing/unknownは観測data、記録更新・移動はaction。goToAliasの短い日常導線は残す。place_missing等を自動再登録しない。 |
| vision.lookAtPosition / lookAtBlock / lookAtPlayer | 維持するがnativeのlookAtPositionは指定座標そのものへaimする。隠れたy+2補正はlegacyだけに残す。block中心、任意座標、player/視線合わせの意味を区別し、画像・実aim・時刻を返す。無効/撮影失敗を画像確認済みとしない。 |
| diagnostics.lastTask / communication.sendToBot | 維持。過去診断は現在観測ではなく、peer送信の受付は相手の達成ではない。world/task/認証scopeと既存inbox lifecycleは変更しない。 |

### 変更後の呼び方と結果

```js
// Before: 8本の棒を作るためにレシピ出力数を調べてtimes:2を指定。
// After: requestedQuantity:8、confirmedQuantity:8を受け取る。
const made = await skills.craftItem({itemName:'stick', quantity:8});
// quantity:5なら既存レシピが4本単位のとき8本生成し、その数を返す。

// Before: nearestのviewChestはboolean、座標指定のinspectChestAtはobject。
// After: どちらも同じ観測型。明示対象は最寄りへ代替しない。
const chest = await skills.inspectChest();
await skills.takeFromChest({itemName:'cobblestone', quantity:16, chestPosition:chest.position});

// Before: Block referenceとVec3を保持してuseToolOnBlockへ渡す。
await skills.useToolOnBlock({toolName:'shears', position:{x:10,y:64,z:-3}});
await skills.useItem({itemName:'ender_pearl'}); // 使用入力の完了。着地先は別の確認。

// Before: textを必ず用意し、整形済み文章からplaceIdを読む。
const stores = await places.find({kind:'storage'}); // bounded record[]
const saved = await places.inspect({placeId:stores[0].id}); // place + linked storage
await places.tendFarm({farmId:'farm-1'}); // 保存農地・保存収納が対象を決める。
```

- 単一の設置・破壊・装備等のbooleanは維持する。成功が「指定した単位行動を確認できた」を意味するようにし、全SDKを巨大な共通resultへ包まない。対象変更・未ロード・接近失敗をsuccessへ変換せず、取消後に新たな変更を始めない。
- 製作、精錬、チェスト転送は小さなdomain resultを返す。共通部分は `{ok,status,requestedQuantity,confirmedQuantity,remainingQuantity,reason?}`、必要なitem名・実設備座標だけを追加する。statusはcomplete / partial / blocked / unknown / cancelled。confirmedQuantityの不明はnull、0と区別する。craftItemは最低数量以上の確認でcomplete、転送は要求数量の全量確認でcomplete。レシピ生成の余剰はconfirmedQuantityで分かる。
- 内部の数量・対象選択・完了事実を返せるよう、小さな共通coreまたは内部resultを追加し、既存bot-first関数はそこから従来booleanを投影する。native facadeだけで既存trueを「全量完了」と読み替えない。crafting_syncのserver result/recipe delta、chest transferの両側fenced snapshots、既存furnace確認を再利用する。確認のない道具使用・give等には同等のserver保証を宣言しない。
- 農作業は `{ok,status,harvested,planted,stored,remainingWork,reason?}` と既存の必要なstorage情報を返す。選択した有限plotの作業が済めばcomplete、作業対象がない実在plotはno_workとして正常、残る対象・種不足・到達不能・指定収納失敗はpartial/blocked/unknownで非成功。counts>0だけを完了としない。nearbyはchestPosition指定時だけ保管し、省略時は所持品へ回収する。saved farmは既存のlinked/一意解決storageを使い、曖昧な収納は勝手に選ばない。
- 農作業の確認数は、収穫pickup、播種block state、チェスト転送の既存証拠を使う。現在nearby farmは保管数をdeposit要求量から数える経路があるため、その数をそのままconfirmed扱いしない。指定収納を扱う実装は通常チェスト転送coreへ寄せ、二重の確認方式を作らない。
- native registryにquery/action区分と既存の少数の成功条件を明示し、coder safetyはそれを参照する。queryのfalse/null/unknownは通常data、actionのfalse/ok:false/未完了は同一batchの次のSDKを止め、結果をsdkFailureへ残す。例外はどちらもbatchを止める。catch・未awaitで迂回できないこと、途中の変更を巻き戻さないことを保つ。showVillagerTradesの読取、places.verifyの記録更新はそれぞれ説明で副作用を明記する。
- 一般のuseToolOn等は「使用入力が完了した」結果と、バケツなど既存の確認可能な結果を区別する。少ない引数にするために命中、成長、繁殖等の観測保証を発明しない。対象選択と作業許可はcaller、接近・有効な道具選択・現在対象の再解決・操作後確認はskillが持つ。

### 実装の順序と最小の完了確認

- [ ] **1. registryとbatch境界を揃える。** 83件の分類と変更後signatureをregistryへ反映し、query/action・成功条件をcoderの判定と共有する。`native_sdk.test.cjs` と `codex_session.test.cjs` / `targeted_sdk.test.cjs` で、query false/unknown後は続行可、partial action後はcatch/未awaitでも次の編集0件、部分結果保存、2bot分離を確認する。内部化後も全export公開を要求する現在のworld fixtureは、意図した公開subsetの契約へ更新する。
- [ ] **2. 数量仕事と設備選択を完成させる。** craftItem、精錬、チェスト観測統合・転送の小さな結果を実装する。既存の製作/転送coreを再利用し、recipe単位とitem単位の確認を分ける。`crafting_sync.test.cjs`、`chest_transfer.test.cjs`、`furnace_lifecycle.test.cjs` で棒5個要求→8個確認、材料不足で一部生成、転送不足、snapshot不明、明示設備への非代替とclose/cancelを確認する。必要資材の調達・中間素材の再帰製作は追加しない。
- [ ] **3. 直接対象の行動と農作業を揃える。** native placeBlockの通常経路にもstate確認を適用し、既存strict family以外の通常ブロックまで一律拒否しない。空のorientation objectへ単純差替えすると現在のfamilyOfが制限するため、通常設置の確認を再利用できる形で分ける。`block_placement.test.cjs` / `interaction_confirmation.test.cjs` / `surface_navigation.test.cjs` / `tree_felling.test.cjs` で無orientation設置、occupied対象、支持指定、対象再読込、取消、経路保全を確認する。farm既存fixtureと `place_actions.test.cjs` でno_work、部分収穫、種不足、収納失敗、無視される引数の事前拒否、connected範囲とradius範囲を確認する。
- [ ] **4. 観測と場所記憶の導線を完成させる。** placesの構造化projection、text省略、相対block名、native vision exact aim、trade query、useItem/座標toolを実装する。recordの永続形式は変えず、legacy文字列表示と内部signatureを保つ。`place_agent.test.cjs` / `place_rpc.test.cjs` / `vision_sdk_validation.test.cjs` / `world_observation.test.cjs` と関連target fixtureで結果、引数、unknown、legacy y+2維持を確認する。新しい汎用target/検索frameworkは作らない。
- [ ] **5. native利用まで通して完了する。** READMEのnative例、bot指示、deferred docsを最終契約に更新する。legacy用 `sdk_capabilities.js` / skill_library / chat callersの説明へnative契約を混入させない。現在protocol 9のSDK scopeを一度更新し、`codex_session.test.cjs` で旧threadを再利用せず新threadへ移行、その後同じ契約は再開すること、名前一覧・deferred docs・実API・lintが一致することを確認する。

実装時の最終検証は既定Node20で必須 `tests/run-tests.cjs`、Shared CLI `codex-test run --scope fast --project mindcraft`、full diff/`git diff --check`。単なる全method stub呼出しだけを成果確認にしない。隔離実ゲーム確認は変更のある製作数量、明示チェスト、無orientation設置、農地の部分完了と正しい画像aimの短い1シナリオを既存templateコピー・loopback 25569/25570で行い、server由来数量/blocksと実画像を確認する。変更しない戦闘や世界全体を一律再benchmarkする必要はない。新規CLI discovery probeや小型fixtureだけではゲームの確認強度を保証しない。

### 境界、回復、延期

- 今回は静的設計レビューとPLAN追記だけ。機能実装、test suite、隔離server、live操作、依存install、manual pin/applyは行わない。計画文書だけをcommit/pushする。設計に必要な重大な機構不明は残っておらず、性能やゲーム内達成を今回実測したとは扱わない。
- 実装が依頼されたら、既存の5 dirtyファイルを分離・保持してtask差分だけを検証する。source/interface変更はown originへcommit/push後、親AGENTSの継続指示に従って検証済sourceをbot-only applyする。対象の正本・bundle・readinessをplay手順で確認し、server/world、memory、thread保存内容、Ollama停止状態を保つ。新SDKのscope変更に伴う新thread選択は正常な移行であり、旧履歴を削除しない。
- interface変更は分離したsource commit/bundleを戻して回復できる。実行済みの製作・収納・block編集はsource rollbackで戻らない。曖昧な確認後は既存inventory gateを維持し、再実行せず現在状態を照会する。旧threadへ新signatureを混ぜない。
- 延期: 自動資材調達/再帰製作、汎用建築planner、複数炉並列、保護領域推定、全resultの統一、全名の改名、常設mode、SDKversion並存、観測polling framework、自己状態の重複API。必要な道具や資材を得る上位判断はbot側の短い閉ループに残す。83件の分類からSDK改善を始められ、これらの追加判断は着手の前提ではない。
