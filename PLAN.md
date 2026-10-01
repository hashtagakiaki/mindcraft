# PLAN

Goal: After this change, botはMinecraft接続を維持して作業を中断・観測・再計画でき、再接続は接続が既に失われた場合、停止不能な旧処理を隔離できない場合、またはユーザーの明示操作に限定される。

Acceptance criteria:
- 正常な精錬・炉回収の後にbotを終了しない。精錬→在庫確認→クラフト→装備を同じMinecraft接続で進める。成功した回収量と未精錬品・燃料の残量を確認し、未確認の在庫を成功扱いしない。
- `!stop`は進行中の作業と自動再開を止め、接続を維持する。ユーザーが停止した後に勝手に再計画・再開しない。新しい指示による置換では旧作業の停止確認後に新しい指示を優先する。
- 時間切れ、移動詰まり、短時間の反復は、対象操作を中断して現在位置・在庫・途中成果・失敗理由を確認し、既存の会話/goalへ一度だけ戻して再計画する。状態が変わらない同じ失敗を無制限に再試行せず、回復上限で接続したまま停止して報告する。
- Minecraft操作を行う旧body・pending click・自動resumeが残る間に次の変更操作を開始しない。Promise.raceの敗者が後から変更を行う可能性を残したまま「停止成功」にしない。
- LLM中断はプログラム上のリクエスト取消/CLI子process回収で行う。LLMへ自然言語で停止をお願いする仕組みにしない。取消後の回答・古い会話応答・stage済みコードを実行しない。
- 一時的なMindServer socket切断だけでMinecraftから退出しない。作業を停止し、既存Socket.IO再接続を利用して登録・namespace・状態を確認する。管理接続の復旧後も古い指示や変更RPCを自動再送しない。
- 最終手段の再接続には具体的な理由と停止失敗の証拠を残す。同じbotの旧接続・所有LLM子processの終了確認後に、一つの親経路から一度だけ再起動する。他のbot、Minecraft server/world、Ollamaを巻き込まない。
- UI Stop/Disconnect/Destroy、親shutdown、SIGINT/SIGTERMは停止意図を維持し、自動再起動しない。明示Restart/設定適用/bundle切替は意図的な再接続として維持する。task完了とcode>1による全体終了の意味を保つ。
- 保存・停止・再計画・終了の観測結果を区別する。今回のように、正常作業後の再起動と中断失敗を同じ理由として集計しない。

Constraints:
- 今回は計画の改訂だけ。ユーザーが親による直接PLAN.md執筆を許可したため、親が編集する。feature実装・稼働bot操作・bundle切替は行わない。
- source ownerは`hashtagakiaki/mindcraft`の`autonomy`、運用code ownerは`hashtagakiaki/mindcraft-eval`。各repoのAGENTS.mdを優先し、変更はown originへcommit/pushする。
- canonical運用pathは`../play/config.json`。manual source pinはeval pinと独立する。計画時の稼働pinは`d34d12b1352ebc667b60e6f19a66f5ac05c1ddd9`という過去観測で、実行時には再確認する。
- live play 40973/8098、tmux、world、Ollamaを開発検証で操作しない。依存は`../mindcraft-eval/runtime/upstream/node_modules`をread-only入力として使い、npm install/ciを行わない。credential、会話全文、world、runtimeをGitへ追加しない。
- 新しい汎用task framework、worker全面移行、依存更新を導入しない。既存ActionManager、AbortController、Socket.IO、bot子process、確認済み同期helperを利用する。猶予・回復回数は意味の分かる名前付き定数で管理し、無根拠に待ち時間を延ばさない。
- README/AGENTSは実装後に挙動・検証commandが変わる部分だけ更新する。source push後にeval pinを更新する。manual pin・稼働適用は別の明示的な切替依頼の範囲とする。

Out of scope:
- 過去ログだけから01:07の具体的な待機Promiseを断定すること、採掘/建築戦略の改良、全providerの全面改修、ユーザーworldの生成・変更。
- 同期無限loopや無制限の任意生成コードを協調取消だけで止める保証。応答できないbot子processは親の期限付き終了で隔離する。
- 管理socketが長く戻らないことだけを理由にMinecraftを再接続すること。安全に停止できていれば接続したまま待機・報告する。

Context:
- `src/agent/commands/actions.js:415`の`!smeltItem`は成功すると500ms後にcleanKillする。在庫同期失敗の確認はなく、timerはactionIdに紐付かない。通常skill成功後の意図的再接続はLunaの監査でこの1箇所のみ確認された。
- `src/agent/action_manager.js:29`のstopはinterrupt flagを要求し、executingがfalseになるまで300ms間隔で待ち、10秒後にcleanKillする。action timeoutにも10秒の終了経路がある。中断理由や再計画方針は統合されていない。
- `src/agent/agent.js:235`のrequestInterruptはdig/collectBlock/pathfinder/pvpを停止するが、炉window/slot応答待ちやLLMを取消さない。Coderは生成awaitの前後でflagを確認するだけで、stage/lint後の実行直前にも取消確認が必要。
- `src/models/prompter.js:277`のawaiting_codingはfinallyで戻していない。`src/models/codex.js`は120秒timeoutでCLIへSIGTERMするが、action取消やSIGKILL、子孫process回収を管理しない。
- `src/agent/library/skills.js:308`の精錬には早期return/例外での窓cleanup欠落があり、中断後も回収clickへ進みうる。`:417`のclearNearestFurnaceは成功後も炉窓を閉じない。crafting_syncのprepareは炉窓を拒否する。
- `src/agent/library/crafting_sync.js`には所有lock、確認fence、timeout、poisoned状態がある。炉への再利用はcraft固有前提を調べてから決める。
- `src/agent/modes.js:130`のunstuckはmoveAwayが10秒で終わらないとcleanKillし、例外時timerのfinally cleanupもない。通常のmode終了には既存の再prompt経路がある。
- `src/agent/action_manager.js:75`は高速反復を検知するとresumeを取消し、その後botを終了する。`agent.js`のidleとSelfPrompterが再開に関わるため、停止時にこれらをまとめて制御する必要がある。
- `src/agent/mindserver_proxy.js:41`は管理socket disconnectだけでcleanKillする。初回connect後の再登録・connected復元を管理していない。Socket.IOの既存再接続を使う設計へ変更する。
- `src/process/agent_process.js`はcode!=0、SIGINT以外、起動10秒経過を条件に再起動する。code>1は親全体を終了する。forceRestartには別のexit handlerがあり、stopは終了確認のないSIGINT送信だけ。累積復旧budgetはない。
- `agent.js:545`のcleanKillはhistory.add/save後すぐprocess.exitする。saveの本体は同期writeなので未awaitだけで保存失敗とは断定しないが、addのLLM要約待ち・save例外・後続要約の上書きは終了時に管理されていない。
- 親shutdownは`src/mindcraft/mindcraft.js`とMindServer/PlaceStore lifecycleに分散し、bot停止をawaitせずlock/socket/親を終了する。eval applyもUI port閉鎖を待つだけでは所有process全体の終了を確認できない。

### 既に観測した4件

2026-10-02 JSTのserverログとBot3保存会話を対応付けた結果。会話には継承した過去turnも含まれ、同じ理由の出現回数を切断件数として数えない。

| 切断→再参加 | 保存理由/操作 | 確認結果 |
| --- | --- | --- |
| 00:58:03→00:58:07 | clearFurnace後、Code execution refused stop after 10 seconds | 停止watchdog。待機先とstop呼出元は不明 |
| 01:00:40/41→01:00:44 | raw_iron8精錬成功、Safely restarting to update inventory | 精錬wrapperの直接再起動 |
| 01:06:08→01:06:11 | raw_iron10精錬成功、同じ再起動理由 | 精錬wrapperの直接再起動 |
| 01:07:16→01:07:19 | 炉窓でcraft2回失敗、!stop成功、次の!newAction後にwatchdog | !stop自体は成功。生成待ち/実行待ちは特定不可 |

出典は`../play/mindcraft-server/20260928T142608-cd247f0a/server/logs/latest.log:19-39`と、bundle-2512e9ea84b24efbaae0bdbb8d0b1d82/runtime/bots/Bot3のconversation_2026-10-01T15-59-10-443Z.txt、16-01-43-051Z.txt、16-07-39-971Z.txt、histories/10-2-2026_1-06-33AM.json。private会話はGitへ転記しない。

Experiments and open questions:
- 前のplannerは実ActionManagerを隔離importし、未解決awaitはflag=trueでも10,033ms後にwatchdogとなることを確認した。outer action内から同managerのinner actionをawaitする再入も10,034msで自己待ちとなったが、今回の通常経路には再入の証拠がない。ライブ操作なし、一時fileなし。再現可能な実験はWave1に残す。
- MineflayerのwindowOpen/slot update待ちを接続維持のまま解除できるか。遅いpacketが取消後にclickを進めるか。実pluginを読んだ隔離fixtureで確認する。安全に解除できない場合は、次の変更操作を禁止し、観測/停止を試してなお旧処理を隔離できないときだけ最終終了へ進む。
- 炉close後のinventoryを既存fenceとslot updateで確認できるか。statistics応答だけを「全inventory snapshot」と解釈しない。確認できない場合に成功や無条件再起動へ逃げず、状態未確認として停止・報告する。
- 過去newActionのcodingログは成功後だけ保存され、action-code/0.jsは上書きされている。今後actionId/phaseを生成前から記録し、生成とMinecraft操作の待機先を区別する。
- Codex子孫processのgroup境界、終了確認、親停止を実Node子/孫processで確かめる。共有terminal/Xvfb/server/Ollamaを含むgroupにsignalを送らない。

Approach:
- 回復の順序は「対象actionに停止要求→停止・窓/在庫の確定→結果を返す→必要なら再計画」。通常の失敗はprocess終了に変換しない。接続喪失または期限後も副作用を止められない場合だけ最終終了へ進む。
- 既存actionIdにAbortControllerと停止Promiseを結び、同じactionの複数stopを一つにまとめる。既存resultへ中断理由/途中成果/状態確認結果を最小限追加する。旧timer・古い応答が新actionを変更しないようにする。
- 中断理由を区別する。user stopは自動resume/goalを停止して報告のみ、supersededは新指示優先、timeout/stuck/repetitionは停止確認後に一度再計画、management disconnectedは停止して管理復旧待ち。LLMに同じ操作の無変更再試行を促さない。
- 再計画には現在位置・確認済み在庫・最後の操作/変更・失敗理由だけを既存handleMessage/goalへ渡す。読み取りに追加clickが必要なら停止確認前に行わない。不明なslot/cursor・途中成果は不明と明記し、材料消費済みの操作を盲目的にやり直さない。
- 回復の試行回数・連続失敗は既存goal/actionの範囲で管理する。目的/入力/観測した進捗が変わったときにresetし、無関係な次の指示へ失敗回数を持ち越さない。上限で接続したまま止まり、ユーザーへblockerを報告する。
- Codex request取消はCLI終了とclose確認まで行い、tempdirを回収する。生成中に取消したらコードを実行しない。対応していないproviderは任意の実行を許さず、古い回答を失効させて停止結果を報告する。cancel未対応だけを理由にMinecraft再接続しない。
- 精錬/炉回収は所有windowをtry/finallyで管理し、settle済みの操作だけcleanupする。取消後の無条件takeInput/takeFuelや新clickを避ける。既存skill呼出形式を保ち、通常成功後500ms再起動を削除する。
- unstuckは期限付きの移動回復を行い、失敗を結果として返す。timer/mode.active/pauseはfinallyで戻す。移動していないことだけで精錬待ちや生成待ちを詰まり扱いせず、action phaseと既存保護条件を使う。
- 管理再接続は既存Socket.IO connect/disconnectに一度だけ登録する。復旧時のagent登録/login・place namespace・有効設定を再確認してから停止ゲートを解除する。RPCの自動再送は行わず、namespace変更は同接続のまま拒否・報告する。
- 最終終了は一つのidempotentなshutdown(reason, restartIntent)へ集約する。入口で新actionを拒否し、自動update/生成/要約を止め、保存結果とphaseを小さな構造化記録へ残す。LLM要約を保存の必須条件にしない。pending transfer中に素材回収を追加せず接続終了を一度だけ行う。
- 親はdesired stateを再起動意図の正本にし、stop/restart/exitを一本化する。子との終了通知は既存Socket.IOまたはNode標準IPCのうち、管理socket切断中にも機能する最小方式を実験で選ぶ。event loop自体が不応答なら親の期限付きSIGTERM→SIGKILLを使う。旧所有process終了前の重複spawnを禁止し、連続異常終了には小さなbudget/backoffを設ける。
- 親shutdownは各bot停止完了後にplace storeの書込み待ち・lock解放・socket終了へ進む。明示停止で再起動させない。正常task終了、設定適用、明示restartの既存意味を維持する。

Failure modes checked:
- 停止完了を偽装して遅いclickが新操作を壊す → 未解決Promise実験と取消後write観測を最初の判断条件にする。
- 正常精錬直後の次actionがtimerで終了する → smelt wrapper成功timerを削除対象とする。
- 回復失敗が即退出/無限再計画になる → mode/loop/timeoutを同じ停止結果へ戻し、一度の再計画と上限停止を検証する。
- 明示stop後にidle/goalが勝手に再開する → user stopはresume/goalを抑止する受入条件にする。
- 管理復旧時にplace変更RPC/古い指示が二重実行される → 自動再送禁止、namespace照合、世代の古い応答失効を検証する。
- 保存未awaitだけで喪失と断定する → 同期writeを確認済み。保存失敗/並行要約/終了期限を個別に観測する。
- 同時restartやSIGTERMで二重起動する → 親desired stateと一つの終了Promise、実PID回収で検証する。

Full verification:
- sourceの各実装taskで対象fixtureを実行し、最終に `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs` と `git diff --check`。fixtureは実module/pluginを利用し、成功/中断/遅い応答/未応答/取消後副作用を外部観測する。
- offline一連workflowでsmelt→inventory→craft→equip、user stop、移動詰まり、loop、action timeout、管理socket切断/復旧における接続数/PID/slot変化/後続writeを確認する。正常/協調中断はMinecraft再接続ゼロ、fallbackだけ一回を合否条件にする。
- 子process fixtureで実Node子/孫processをspawnし、正常終了/TERM無視/二重stop/親停止を確認する。finallyで全fixture PID・tempdirを回収し、実Codex APIや稼働Minecraftへ接続しない。
- evalでは `python3 -m unittest discover -s tests -v`、隔離prepare/apply fixtureでsource pin・overlay・旧process回収・rollbackを確認する。各repoのfull diffをレビューしてcommit/pushする。
- 最終的なinventory/炉確認は、既存templateを使う専用CaseServer 25569/25570でserver slot/cursorと次craftを観測する手順をeval側に追加して行う。template未配置ならLIVE_UNVERIFIEDを明記し、代替worldを生成しない。offline結果をlive保証と書かない。
- この計画の実装完了はsource/eval検証まで。manual pin変更とbot-only適用は明示された切替依頼時のみ実施する。

## Wave 1

- [ ] Task 1: 中断・在庫同期・process回収の安全な境界を隔離実験で確定する
  Writes:
  - tests/shutdown_experiments.cjs
  - PLAN.md
  Reads:
  - src/agent/action_manager.js
  - src/agent/library/crafting_sync.js
  - src/models/codex.js
  - src/process/agent_process.js
  - ../mindcraft-eval/runtime/upstream/node_modules/mineflayer/lib/plugins/inventory.js
  - ../mindcraft-eval/runtime/upstream/node_modules/mineflayer/lib/plugins/furnace.js
  Change:
  - 実pluginのwindowOpen/slot update未発火、遅いpacket、disconnectを個別再現する。取消後のPromise settle、後続click、window/cursor確認の可否を記録する。
  - 炉close後のslot更新/既存fenceを試し、未確認在庫と確定済み在庫を区別する最小方法を選ぶ。
  - 既存managerの不応答/再入を再現し、専用Node子/孫processでgroup回収とcloseの差を確認する。全fixture PID/tempdirをfinallyで回収する。
  - 判定結果をPLANへ反映する。安全な取消を証明できない処理をraceだけで正常停止とする方式は採用しない。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/shutdown_experiments.cjs`
  Expected:
  - 接続維持で取消可能な待機先、slot確認手順、取消不能時の隔離条件、所有process回収方式が再現可能な結果として残る。実CLI/API/live操作なし。
  Commit:
  - `test: establish cancellation and inventory confirmation boundaries`

## Wave 2

- [ ] Task 2: 操作単位の停止と再開の契約を作る
  Writes:
  - src/agent/action_manager.js
  - src/agent/agent.js
  - src/agent/self_prompter.js
  - tests/action_manager.test.cjs
  - tests/idle_scheduling.test.cjs
  Reads:
  - src/agent/commands/actions.js
  - src/agent/modes.js
  - Wave1の実験結果
  Change:
  - actionIdごとの取消・停止Promise・phaseを管理し、複数stopと遅いtimerをまとめる。旧bodyのsettle確認と新bodyの開始条件を保つ。
  - user stop/new instruction/timeout/recovery/management lossを区別し、結果に理由・途中成果を保持する。!stop時にresume/自動goalを止め、古いhandleMessage応答も新指示を追い越さない。
  - 時間切れは停止成功なら結果として返す。不応答なら作業を止めて最終終了の入口へ渡し、単なる時間切れだけで退出しない。最終終了入口はWave7で統一するまで既存経路に接続する。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/action_manager.test.cjs`
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/idle_scheduling.test.cjs`
  Expected:
  - 協調中断でcleanKillゼロ、旧bodyと新bodyの変更操作が重ならない。user stop後は停止状態、古いtimerは後続actionを終了しない。
  Commit:
  - `fix: scope cancellation and stop outcomes to each action`

## Wave 3

- [ ] Task 3: 生成待ちを取り消し、古い回答の実行を防ぐ
  Writes:
  - src/agent/coder.js
  - src/models/prompter.js
  - src/models/codex.js
  - tests/generation_cancellation.test.cjs
  Reads:
  - src/agent/action_manager.js
  - src/agent/agent.js
  - Wave1のprocess実験結果
  Change:
  - AbortSignal/世代をcoding requestへ渡し、Codex子processを取消してcloseとtempdir回収を確認する。生成/会話の遅い応答を失効させ、stage/lint後と実行直前にも取消確認する。
  - awaiting_codingとmode.pauseをfinallyで戻す。取消は通常の失敗retryとは区別し、追加生成を始めない。
  - 無関係なmemory/vision requestを一括取消しない。取消未対応providerの遅い回答も実行できないことを確認し、対応範囲を記録する。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/generation_cancellation.test.cjs`
  Expected:
  - 生成中stopでMinecraft退出ゼロ、取消後コード実行ゼロ、所有CLI PIDゼロ。遅い回答/生成例外後も次の正当な生成が動く。
  Commit:
  - `fix: cancel code generation without reconnecting the bot`

## Wave 4

- [ ] Task 4: 炉操作を中断可能にし、精錬後の無条件再接続を削除する
  Writes:
  - src/agent/library/skills.js
  - src/agent/commands/actions.js
  - src/agent/library/crafting_sync.js（Wave1で再利用が適切と確認した場合だけ）
  - tests/furnace_lifecycle.test.cjs
  Reads:
  - src/agent/action_manager.js
  - Wave1の実plugin/在庫確認結果
  Change:
  - smeltItem/clearNearestFurnaceの所有windowをfinallyで閉じ、open/transfer/回収の境界で取消を確認する。取消後に無条件の回収clickを送らない。
  - 実験で確認したslot同期を利用し、回収量とinventoryを確認する。材料不足・部分精錬・確認不能は途中結果/失敗として返し、勝手に同じ投入をやり直さない。
  - 成功後500msのcleanKill timerを削除する。unsafeなpending処理だけ停止契約から最終終了へ渡し、正常成功の在庫更新目的の再接続を残さない。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/furnace_lifecycle.test.cjs`
  Expected:
  - 成功/不足/例外/中断のsettle後に炉窓を残さず、別所有windowは閉じない。smelt→inventory→craftの同接続workflowでrestartゼロ、未確認transferを成功扱いしない。
  Commit:
  - `fix: confirm furnace results and remove successful-smelt restarts`

## Wave 5

- [ ] Task 5: 詰まり・反復・時間切れを停止結果と有限の再計画へ戻す
  Writes:
  - src/agent/modes.js
  - src/agent/action_manager.js
  - src/agent/agent.js
  - src/agent/self_prompter.js
  - tests/recovery_replanning.test.cjs
  Reads:
  - src/agent/library/skills.js
  - src/agent/library/world.js
  Change:
  - unstuckのcleanKill timerを取消可能な回復操作へ置換する。回復失敗/例外/取消後もtimerとmode.activeをfinallyで戻す。生成・精錬待ちを移動詰まりと混同しない。
  - 高速反復はresume/反復loopを止め、理由・現在状態を既存再prompt経路へ一度だけ渡す。時間切れも同じ停止成功経路にまとめる。
  - 連続失敗の回復budgetを設け、上限で接続したまま停止して報告する。user stopには再計画しない。新指示・実際の進捗でbudgetをresetする。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/recovery_replanning.test.cjs`
  Expected:
  - 協調停止できるstuck/loop/timeoutで再接続ゼロ、再promptは一度、失敗上限で停止。旧actionの変更操作や同一失敗の無制限retryが残らない。
  Commit:
  - `fix: replan recoverable actions without restarting agents`

## Wave 6

- [ ] Task 6: 管理socketの喪失をMinecraft接続から切り離す
  Writes:
  - src/agent/mindserver_proxy.js
  - src/agent/agent.js
  - src/mindcraft/mindserver.js
  - tests/management_reconnect.test.cjs
  Reads:
  - src/agent/places.js
  - src/mindcraft/place_rpc.js
  - src/agent/action_manager.js
  Change:
  - disconnect時の即cleanKillを除去し、操作を停止・管理復旧待ちにする。接続喪失で停止できない旧操作だけ最終終了へ送る。
  - Socket.IO標準reconnectの各connect時にconnected/登録/loginを復元し、listenerの重複とbufferされた古い変更要求を防ぐ。
  - namespace/設定/管理世代を再照合し、一致した場合だけ管理ゲートを解除する。RPCは結果不明なら再観測し、変更RPCの自動再送は禁止する。長期喪失時も安全停止を維持する。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/management_reconnect.test.cjs`
  Expected:
  - 一時管理切断・復旧でMinecraft接続/PIDを維持し、listener/agent登録が重複しない。namespace不一致は操作拒否、古いRPC/指示を再実行しない。
  Commit:
  - `fix: recover management connections without reconnecting Minecraft`

## Wave 7

- [ ] Task 7: 停止不能時だけ使う終了経路と親の再起動判断を統一する
  Writes:
  - src/agent/agent.js
  - src/agent/history.js
  - src/process/init_agent.js
  - src/process/agent_process.js
  - src/agent/mindserver_proxy.js
  - src/agent/action_manager.js
  - src/agent/commands/actions.js
  - src/mindcraft/mindcraft.js
  - src/mindcraft/mindserver.js
  - src/mindcraft/place_store.js
  - tests/agent_shutdown.test.cjs
  - tests/agent_process.test.cjs
  - tests/place_store.test.cjs
  Reads:
  - src/models/codex.js
  - Wave1のprocess回収結果
  Change:
  - 未確定旧操作、既に失われたMinecraft接続、明示restart/stopをreasonとrestartIntentで区別し、一つの終了Promiseへ集約する。新actionと自動updateを止め、生成/要約を取消し、LLM要約を経由しない終了記録と最後の保存結果を管理する。
  - owned window cleanupはsettle確認後のみ、Minecraft接続終了は一度。保存失敗/期限切れを記録する。遅い要約が最終保存を上書きしないようにする。
  - 親desired stateと終了確認で再起動判断を一本化し、SIGINT/SIGTERM/Destroy/親shutdownの停止意図を保つ。旧bot/所有CLI回収を待ち、期限超過だけSIGTERM→SIGKILL。応答しないevent loopも親側で期限を監視する。
  - 連続異常終了budget/backoff、code>1の全体終了、親place lock解放の順序を扱う。明示Restart/設定適用では一度だけ再起動する。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/agent_shutdown.test.cjs`
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/agent_process.test.cjs`
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/place_store.test.cjs`
  Expected:
  - 最終手段だけbot単位で一度再接続し、旧PID/CLIが残らない。明示stop/親終了で再起動ゼロ、他bot非干渉、保存失敗が識別可能、最後の書込み完了後にlockを解放する。
  Commit:
  - `fix: make bot restart a bounded last-resort recovery`

## Wave 8

- [ ] Task 8: 全workflowの検証をrunner・eval準備/切替へ組み込む
  Writes:
  - tests/run-tests.cjs
  - README.md
  - AGENTS.md
  - ../mindcraft-eval/scripts/prepare_mindcraft_play.py
  - ../mindcraft-eval/scripts/apply_mindcraft_play.py
  - ../mindcraft-eval/tests/test_play_runtime.py
  - ../mindcraft-eval/tests/test_apply_mindcraft_play.py
  - ../mindcraft-eval/scripts/smoke_crafting.py（炉連続workflowの隔離live確認に必要な部分のみ）
  - ../mindcraft-eval/mindcraft-source.json
  - ../mindcraft-eval/README.md
  - ../mindcraft-eval/AGENTS.md
  Reads:
  - ../mindcraft-eval/scripts/start_mindcraft_play.sh
  - ../play/AGENTS.md
  - 上記全fixtureとsourceの検証結果
  Change:
  - 新fixtureをrunnerへ統合し、中断/再計画/最終再接続条件を使用説明に記載する。full suite/diffを確認しsourceをown originへpushする。
  - source変更でoverlay文字列が外れる箇所を適応し、新たな再接続処理をoverlayで追加しない。既存navigation-stallの遅い処理が停止契約を破らないことも確認する。
  - apply/rollbackは旧親bot/所有CLIの終了を確認してから新bundleを起動する。PID再利用を避ける識別条件を既存private activation recordへ加え、UI port閉鎖だけで回収成功としない。
  - push済みsourceのfull SHAへeval pinを更新し、隔離prepareと必要な隔離live検証を行う。manual source manifest/pointerは変更しない。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs`（mindcraft）
  - `python3 -m unittest discover -s tests -v`（mindcraft-eval）
  - `python3 -m unittest discover -s tests -p 'test_play_runtime.py' -v`（mindcraft-eval。fixtureがtemp runを作成し、prepare-only実commandを実行して回収する）
  - `git diff --check`（両repo）
  Expected:
  - 正常作業/協調中断の再接続ゼロ、fallback/明示操作だけ一回という結果をsourceとexport bundleの両方で確認する。live未検証なら明記し、稼働bot/world/Ollamaを変更しない。
  Commit:
  - mindcraft: `docs: document cancellation and last-resort reconnect behavior`
  - mindcraft-eval: `fix: verify shutdown ownership in prepared play bundles`

## Deferred work

- Wave1の結果で各待機の取消方法とinventory確認方法を具体化し、依存するWave2/4/7の対象path・verificationを更新する。判断が変わっても正常精錬後の無条件再接続を許す方向へ受入条件を弱めない。
- Wave8のsmokeは実装後のCLIに合わせて正確なcommandを記載する。既存templateが不足する場合はLIVE_UNVERIFIEDとし、実稼働で代用しない。
- 検証済みsource/evalのmanual play適用は、ユーザーの明示切替依頼後にpreflight・memory/namespace引継ぎ・4体readiness・rollback確認を行う。今回の計画/実装依頼だけで稼働切替を行わない。

## Plan updates

- 2026-10-02: 先の調査でwatchdog2回と精錬成功後再起動2回を区別。最後の!stop成功と後続newAction失敗を記録した。
- 2026-10-02: Lunaがsource/runtime/eval全体を監査し、通常skill成功後の意図的再接続はsmeltのみと確認した。
- 2026-10-02: ユーザーの「再接続は最終手段」に従い、親が直接全体計画を改訂。接続維持の停止・観測・有限再計画を主目的とし、終了/再接続は停止不能・接続喪失・明示操作に限定した。feature/live変更なし。
