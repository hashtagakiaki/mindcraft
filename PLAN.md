# PLAN

Goal: After this change, 中断要求が生成待ち・炉操作中でも期限内に完了するか、同じbotの旧操作が続かないことを確認して終了し、理由と保存結果を残して必要な場合だけ一度再起動する。

Acceptance criteria:
- 協調停止が成功した場合は接続を維持し、停止完了前に次のactionを開始しない。停止中に受け付けた新actionやidle/resumeは終了する旧actionを追い越さない。
- 不応答時はbot子process単位で終了し、旧Minecraft接続と所有するLLM子processが終了したことを確認してから親が再起動する。親の終了・UI stop/destroy・SIGINT/SIGTERMでは自動再起動を抑止する。
- 保存完了、保存失敗、期限切れを区別する。LLM要約を終了の必須条件にしない。終了記録にはreason、actionId/label、phase、経過時間、window/cursor有無、保存結果、子process回収結果、再起動意図を残す。
- 炉窓は成功・早期return・例外・中断の全経路で所有権に応じて閉じる。未確認clickの結果を成功扱いせず、次のcraftへ曖昧な状態を引き継がない。
- ワールド内の素材を一律に回収する終了処理を入れない。追加clickで状態を悪化させる可能性がある場合は操作を止めて切断し、再接続後に在庫・炉を再観測する。
- 4bot全体、Minecraft server/world、Ollamaへの影響を避け、正常精錬の在庫整合と既存のplace state保存を維持する。

Constraints:
- 計画作成だけを依頼された。現時点でfeature実装・稼働bot操作・bundle更新・deploymentを行わない。
- sourceはown forkのautonomy、originはhashtagakiaki/mindcraft。共有node_modulesはread-only。credential、world、会話全文、runtime生成物をGitへ含めない。
- runtime pinはd34d12b1352ebc667b60e6f19a66f5ac05c1ddd9、調査時source HEADは20d08dd。play/config.jsonがpath正本。実装後のplay適用は別の明示的許可を必要とする。
- 新しい依存やworker隔離への全面移行は避け、既存のbot子processとsupervisorを利用する。猶予・上限は名前付き定数とし、現在の10秒を無根拠に延ばす対処をしない。

Out of scope:
- 実world変更、稼働playでの再現、全LLM providerの一括改修、Mineflayer依存更新、採掘/建築戦略の変更。
- 任意生成コード内の同期無限loopを協調flagだけで止める保証。これは親process側のwatchdogで終了させる。

Context:
- `src/agent/action_manager.js:29` のstopは300msごとにrequestInterruptを呼び、executingがfalseになるまで待ち、10秒後にcleanKillする。`_executeAction:94` は旧bodyのsettleを待ってから新bodyを開始する。`_startTimeout:178` はactionIdでwatchdogをscopeするがstopのタイマはactionIdを保持しない。複数stopや後続actionを同じexecuting flagで追う問題が残る。
- `src/agent/agent.js:235` のrequestInterruptはflagとdig/collectBlock/pathfinder/pvpだけを停止する。炉window、LLM、Promise全般は取消さない。collectBlock.cancelTask等の返す非同期処理も待たない。
- `src/agent/coder.js:42` はpromptCodingの前後にflagを確認するため、awaitが返らない間は停止できない。`coder.js:165` の生成コードへのflag挿入もawaitの内部や同期loopを止めない。`src/models/prompter.js:277` はsendRequest完了後にcodingログを書き、awaiting_codingをfinallyで戻していない。
- `src/models/codex.js:55` はCLI子processをspawn、120秒後にSIGTERMするが、action中断のsignalを受け取らず、SIGKILL escalationや所有process treeの回収確認がない。agentのprocess.exitで孫processが回収される保証はない。
- `src/agent/agent.js:545` のcleanKillはhistory.add/save後すぐprocess.exit(1)。`src/agent/history.js:90` のsaveはasync宣言でもwriteFileSyncで書くので、未awaitだけを理由に保存失敗と断定しない。ただしaddが閾値に達するとLLM要約待ちが発生し、save例外はrejected Promiseとなり、どちらもcleanKillで完了/失敗を管理しない。chat送信もflush完了は確認しない。
- `src/process/agent_process.js:37` はcode != 0かつSIGINT以外のexitを再起動対象にする。SIGTERMは意図的停止でも再起動しうる。forceRestartには常設exit handlerと別のonce handlerがあり、signal/停止方式変更時に二重startの危険がある。stopはSIGINT送信のみで終了待ち/escalationがない。起動10秒以内の失敗抑止はあるが、毎回startで基準時刻を初期化し、累積再起動budgetはない。
- `src/mindcraft/mindserver.js:254` / `src/mindcraft/place_store.js:510` は親停止時にbot stopを呼ぶがawaitせず、place storeとsocketを閉じて親exitする。`src/mindcraft/mindcraft.js:104` にも別の2秒exit経路がある。`src/agent/mindserver_proxy.js:62` のUI restartはcleanKillへ直接入る。
- `src/agent/library/skills.js:308-390` smeltItemはopen/transfer/回収をawaitする。割込みは精錬loopの末尾だけで、例外/早期return時の窓cleanupがない。`skills.js:417-435` clearNearestFurnaceは成功しても炉窓を閉じない。
- `src/agent/library/crafting_sync.js:230` はfurnaceをcraft準備で拒否する。craft専用の所有lock・statistics fence・timeout・poisonedBotsが既にある。これを無条件に炉へ適用できるとは限らない。
- read-only依存 `../mindcraft-eval/runtime/upstream/node_modules/mineflayer/lib/plugins/inventory.js:405` openBlockはwindowOpen待ち、`:679` putAwayはslot update待ち。furnace.take*はputAwayへ入る。現在の1.21系clickWindowがすべてtransaction timeoutを持つという説明は誤り。windowOpen/slot updateがstop flagで解除されるコードはない。
- eval overlay `../mindcraft-eval/scripts/prepare_mindcraft_play.py:193` はgenerated skillsのfalseを例外化するだけで、ActionManager.runActionを再入させない。通常skillsからのrunAction呼出も見つからない。再入deadlockを今回の原因とは扱わない。
- `../mindcraft-eval/scripts/apply_mindcraft_play.py:186` はtmux C-c→UI port閉鎖待ち→session削除。UI port閉鎖だけではbotとLLM子process全体の回収完了を確認できない。

### 観測ログと前回答の訂正

serverの時刻はJST、conversation filenameはUTC。会話ファイルは継承した過去turnsも含むため、同じ理由が複数ファイルに現れてもexit件数として数えない。

| server exit → rejoin (2026-10-02 JST) | 対応する保存理由とaction | 判定 |
| --- | --- | --- |
| 00:58:03 → 00:58:07 | conversation_2026-10-01T15-59-10-443Z.txt:352-356、clearFurnace → Code execution refused stop after 10 seconds | watchdog。待機中だった具体的Promise/stop呼出元は不明 |
| 01:00:40/41 → 01:00:44 | conversation_2026-10-01T16-01-43-051Z.txt:356-364、raw_iron8成功 → Safely restarting to update inventory | smelt wrapperの直接再起動 |
| 01:06:08 → 01:06:11 | histories/10-2-2026_1-06-33AM.json:32-44、raw_iron10成功 → Safely restarting to update inventory | smelt wrapperの直接再起動 |
| 01:07:16 → 01:07:19 | conversation_2026-10-01T16-07-39-971Z.txt:339-375、炉windowでcraft2回失敗、!stop成功、次の!newAction後にwatchdog | 最後の!stop自体は成功。後続newAction停止のwatchdog |

ログroot: `../play/mindcraft-bot/mindcraft-bundles/bundle-2512e9ea84b24efbaae0bdbb8d0b1d82/runtime/bots/Bot3/`。server根拠: `../play/mindcraft-server/20260928T142608-cd247f0a/server/logs/latest.log:19-39`。

「4回とも中断失敗」は訂正する。2回は正常精錬後の既存wrapper再起動、2回がstop watchdog。継承会話内のoak_log→charcoal成功restartはこの4件に追加対応付けしない。

Experiments and open questions:
- H1: 未解決awaitはflagだけでは止まらない → Node20 `--input-type=module` から実action_manager.jsをdata URL import、actionFnを手動releaseするPromise、30ms後にstop。cleanKillだけ記録に置換 → 10,033msでwatchdog、10.2秒後にreleaseするとinterrupt=trueでbodyが戻った。確認したのは実managerの停止限界で、今回の待機先の特定ではない。
- H2: 同じmanagerへouter bodyからinner runActionをawaitすると自己待ちになる → 同じ隔離processでouter→innerを実行 → 10,034msでwatchdog、inner未開始、outer.executing=true。再入は避ける設計とする。ただし今回この経路を通った証拠はない。
- 上記commandはlive接続・LLM呼出・file書込みなし。10.2秒で記録後process終了、残存試作fileなし。実験の再現はWave1 task1でcommand化し、実装後の同じ境界を検証する。
- 01:07のnewActionが生成待ちか実行待ちかは特定不可。該当時刻のcodingログは残らず、action-code/0.jsは後続採掘コードに上書きされている。成功後ログ保存という実装から生成待ちは候補になるが、ログ欠如だけでは確定しない。新しいphase記録で今後区別する。
- clearFurnaceの未解決awaitはopenBlock/windowOpenかtake*/slot updateが候補。現存会話に内部phase記録がなく確定不可。再入より先に実Mineflayer pluginのevent待ちを隔離再現する。
- signal/timeout raceをPromise.raceだけで解決扱いしない。raceの敗者が遅れてclickを送るか、disconnectでsettleするかを実pluginで確認する。安全な取消境界がなければ新actionを禁止したまま子process終了へ進む。
- 通常smelt後restartは現在の在庫更新回避策。既存craft fenceを炉close後inventoryへ適用してserver-confirmed snapshotを得られるか、fake client packet実験→必要なら隔離CaseServerで検証する。確認できるまでは再起動を残して統一終了経路へ移す。同期実装を保守する費用と、確実な再接続の費用を比較し採否を記録する。

Approach:
- 最小の三段階を採用する。1) actionを一度だけcancelしてsettleを期限付きで待つ、2) settleしない場合はadmissionを閉じたbot子processで終了cleanup、3) 親が期限超過を検知してSIGTERM→SIGKILL。旧bodyを単に「完了」にして同接続で次へ進めない。
- stopをactionIdに束縛した一つのPromiseにまとめ、遅れたtimerが後続actionを殺さないようにする。cancel時にresume/idle発火と新command実行を制御し、生成・実行・停止・終了phaseを更新する。ActionManagerのtransition chain内から同managerへのbody待ちを作らない。
- Coder→Prompter→CodexへactionのAbortSignalを渡す。取消/エラー後はfinallyでawaiting_codingを戻す。stage/lint後と実行直前にも同actionIdと取消を確認し、取消後の遅い回答を実行しない。他providerが取消不能ならgenerationを完了扱いせず終了fallbackを使う。
- 一つのidempotentなagent shutdown(reason, restartIntent)へcleanKill/UI restart/connection end/SIGINT/SIGTERMを集約する。終了入口でadmissionとautonomous updateを閉じ、LLM child cancellationを開始し、actionのsettleを期限内で待つ。終了記録はLLM要約を通さず別の小さな構造化記録として書き、保存は成功/失敗をawaitして扱う。
- 安全にsettle済みで所有windowが残った場合だけcloseを試みる。処理中clickが未確定なら回収clickを追加しない。bot.quit/endは一度だけ行いendを期限付きで待ち、disconnect callbackによるshutdown再入は同Promiseへ戻す。自主exitは必要なcleanup完了後にexitCodeを設定、未解決handlesは期限後の明示exit/親escalationで処理する。
- Codex adapterはspawn handleを所有して取消時にSIGTERM、期限後SIGKILL、close確認、tempdir削除を順に行う。LinuxでCLIが孫を作る場合はbot単位に所有するprocess groupまたは個別LLM groupを使う。既存processを巻き込まないgroup境界はWave1で確認し、credential/path/env値を記録しない。
- 親supervisorはdesired state（running/stopped/restarting）を唯一の再起動判断にし、stop/forceRestart/exit callbackを一本化する。親shuttingDown時は再起動禁止。restartは旧processのcloseと所有group終了を確認してから一度だけ行う。短時間失敗抑止を維持し、連続失敗には小さな回数上限/backoffを置く。
- 親のUI shutdown/SIGINT/SIGTERMもbot停止をawaitした後でplace store lockを解放する。PlaceStore lifecycleのbeforeCloseをasync callbackとしてawaitするのが最小候補。agentが最後のplace RPCを使うか、入口でRPC受付を止めるかは終了時の必要書込みを確認して決める。
- 通常精錬成功後500msの無所有timerは再起動要求の統一経路へ移し、新actionを途中で殺さない。同期で置換可能と検証された場合だけ削除する。

Failure modes checked:
- !stop成功と後続newAction失敗の混同 → 個別turnとserverログを照合して訂正。
- 炉画面残留 → clearNearestFurnace成功ログ、次craftのminecraft:furnace拒否、関数末尾close欠落が一致。
- 生成コードの再入deadlock → 実manager隔離再現、通常skills経路のrg調査では該当呼出なし。原因の断定を避けた。
- 保存未awaitだから常に喪失 → history.saveの同期writeを確認して除外。要約/失敗検知は未管理。
- 強制exitでworld内items喪失と断定 → serverで切断前後の接続は観測できるが、各slot/cursorのauthoritative状態未観測。喪失したという主張をしない。
- 親UI port閉鎖を全process終了と扱う → eval applyの判定範囲を確認。後続のprocess ownership検証が必要。

Full verification:
- source実装後: `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs`、同Nodeで新しい停止・process ownership fixtures、`git diff --check`。
- fixtureでは既存manager/adapter/pluginを読み、実childをspawnして取消/正常exit/TERM無視/二重stop/再入/遅い回答を検証する。実CLI/API/稼働Minecraftへ接続しない。PID/接続/保存結果という外部観測で合否を判定する。
- Mineflayer窓状態の最終確認は必要に応じてevalの専用CaseServer 25569/25570で行い、templateをread-onlyのまま扱う。server在庫、炉slot、cursor、window切替、次craft成功を照合する。worldがなければLIVE_UNVERIFIEDとし代替worldを作らない。
- eval変更後: `python3 -m unittest discover -s tests -v`。play overlayのsource pin exportと停止process回収を隔離runで確認する。source push前にmanifestを更新しない。
- 実稼働へは別途明示許可後にbot-only apply。今回の計画作成では上記feature検証/切替は未実行。

## Wave 1

- [ ] Task 1: 未解決event待ちと子process境界を隔離実験で確定する
  Writes:
  - tests/shutdown_experiments.cjs
  - PLAN.md
  Reads:
  - src/agent/action_manager.js
  - src/models/codex.js
  - src/process/agent_process.js
  - ../mindcraft-eval/runtime/upstream/node_modules/mineflayer/lib/plugins/inventory.js
  - ../mindcraft-eval/runtime/upstream/node_modules/mineflayer/lib/plugins/furnace.js
  Change:
  - 一時fixtureに実module/pluginを読み、windowOpen未発火とputAway slot update未発火を個別再現する。flag取消・disconnect・遅いpacketのそれぞれでPromise settleと追加writeを記録する。
  - 実Node子/孫processを専用groupでspawnし、正常終了・SIGTERM無視・親の強制終了を試す。group回収とclose eventの差を観測する。実Codex/Ollama/playは使わず、全fixture PIDをfinallyで回収する。
  - 前述10秒manager実験を再現し、同actionIdへの停止統合/再入拒否の必要性を確定する。phaseと取消契約、group方式、終了budgetを結果からPLANへ反映する。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/shutdown_experiments.cjs`
  Expected:
  - 各event待ちの解除条件、取消後追加writeの有無、孫process回収条件をJSONで出力する。安全な同接続再開を証明できなければprocess終了fallbackを選ぶ。fixture PID/一時directoryが残らない。
  Commit:
  - `test: investigate action cancellation and process ownership`

- [ ] Task 2: 炉窓の所有とcleanupを整える
  Writes:
  - src/agent/library/skills.js
  - tests/furnace_lifecycle.test.cjs
  - tests/run-tests.cjs
  Reads:
  - src/agent/library/crafting_sync.js
  - src/agent/commands/actions.js
  - ../mindcraft-eval/runtime/upstream/node_modules/mineflayer/lib/plugins/furnace.js
  Change:
  - smeltItem/clearNearestFurnaceの所有windowをtry/finallyで管理し、同じwindowが残る場合だけcloseする。clear成功・素材不足・異なるinput・例外の経路を含める。
  - 割込み確認をopen/transferの境界へ追加する。未確認transfer中の取消は追加回収clickをしない。ここで未解決Promiseをraceだけで打ち切って次actionを許可しない。
  - 窓close失敗は成功結果に変換しない。cleanup例外で元の操作例外を消さず、接続が既に閉じた場合は二重closeを避ける。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/furnace_lifecycle.test.cjs`
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs`
  Expected:
  - furnace成功/失敗/中断後にowned windowが残らず次craftの準備へ進める。別windowを勝手に閉じず、pending transferの結果を成功扱いしない。
  Commit:
  - `fix: close owned furnace windows on every settled path`

## Deferred work

- Wave1 task1後: ActionManagerの同actionId停止Promise、phase/admission、Coder/Prompter/CodexのAbortSignalと子process回収を実装する。主対象はaction_manager.js、coder.js、models/prompter.js、models/codex.jsと対応fixtures。provider差異は支持providerの停止契約へ明記する。
- 上記取消契約後: agentの統一shutdownと小さな非LLM終了記録、memory atomic保存/失敗扱い、init_agentのsignal handler、commands/actions・mindserver_proxyの終了呼出を移す。LLM要約の並行更新は取消/凍結し、最後の保存を上書きさせない。documented検証suiteに意味のある失敗/遅延caseを組み込む。
- agent shutdown契約後: AgentProcess desired state・watchdog/escalation・唯一の再起動経路、mindcraft/mindserver/PlaceStoreのawaited親shutdownを実装する。code>1のtask終了意味を維持し、終了reasonをexit codeだけへ無理に詰め込まない。shared lock解放はbot終了確認後とする。
- 窓cleanupと終了契約後: smelt後restartを既存同期helperで置換できるか実験する。fenceがcraft専用前提に依存する/コストが高い場合は再起動を維持し統一shutdownへ移す。採否にかかわらず遅延timerのscopeを解消する。
- source検証/push後: eval applyでUI portに加え旧bot/process group終了を確認、overlay前提を照合し、pinから隔離bundle検証する。evalは別repoのAGENTSに従い別commit/push。README/AGENTSは使用方法・検証commandが変わる部分だけ更新する。稼働切替は計画実装の自動完了条件に含めず、明示許可時だけ行う。

## Plan updates

- 2026-10-02: server exit4件を会話履歴と照合し、watchdog2件/精錬wrapper2件へ訂正。最後の!stop成功を確認し後続newActionのphaseは不明とした。
- 2026-10-02: 実ActionManager隔離実験で未解決awaitと再入の10秒watchdogを確認。再入は候補機構として記録し、今回の原因とは断定しない。feature変更なし、稼働サービス操作なし。
