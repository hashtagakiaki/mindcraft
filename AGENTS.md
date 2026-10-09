# MindCraft autonomy fork — Codex Project Instructions

## リポジトリとsource基点

- 個人リポジトリ `hashtagakiaki/mindcraft`。変更・pushは所有する `autonomy` branchだけで行う。
- `origin` は自分のfork、`upstream` は `https://github.com/mindcraft-bots/mindcraft.git`。upstreamはread-onlyで、pushしない。
- branchはupstream stable commit `b36eaf7e61b3f6bd031fdb531812b2e3c42b6c73` が基点。skill移管に合わせてupstream `develop`へ切り替えたり、依存を更新したりしない。
- upstreamの履歴と `LICENSE` を保持する。upstream checkout、`.git`、untracked fileをこのrepoへコピーしない。

## 検証済みコマンド

| Purpose | Command |
|---|---|
| Offline regression suite (Node 20) | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs` |
| Interaction/crafting-table guard fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs --interaction-confirmation-only` |
| Oriented placement API/confirmation/command/SES fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/block_placement.test.cjs` |
| Place agent command/SES fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/place_agent.test.cjs` |
| Place store/RPC focused fixtures | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/place_store.test.cjs` and `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/place_rpc.test.cjs` |
| Vision SDK validation / disconnect reason fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/vision_sdk_validation.test.cjs` |
| Explicit block/chest target SDK fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/targeted_sdk.test.cjs` |
| Single-tree felling / pillar cleanup fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/tree_felling.test.cjs` |
| Surface ray / native digging / interaction goal fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/block_interaction.test.cjs` |
| Native named-object SDK contract fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/native_sdk.test.cjs` |
| Codex native session fixture | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/codex_session.test.cjs` |
| Syntax check | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node --check main.js` |
| Whitespace check | `git diff --check` |
| Worktree status | `git status --short` |

`tests/run-tests.cjs` はdisposable fixtureを実行し、Minecraft serverや共有dependencyを変更しない。fixtureのdependency resolverはsource/runtime root内の `node_modules` を優先し、開発checkoutでは `mindcraft-eval/runtime/upstream/node_modules` をread-only fallbackとして使う。furnace fixtureは実Mineflayer inventory/furnace pluginを使い、generation/process fixtureは一時CLIとfixture所有Node子/孫processだけを起動する。shutdown coverageは実 `Agent.shutdown` / `ActionManager`、taskとCooking setup guard、init signal/IPC、parent supervisorのtask終了codeと所有process回収、MindServer hub / PlaceStoreのdrainとcloseを検証する。正常task endingはexit code 0を維持し、異常codeは保持する。shutdown保存失敗はbot終了やprocess回収と別の結果として記録される。これらはoffline fixtureの範囲であり、READMEの[動作仕様と検証範囲](README.md#action-cancellation-and-reconnect-behavior)を参照。`shutdown_experiments.cjs` はWave1境界実験と現在のaction-identity stop watchdogを区別する。`npm test` は未設定。共有依存に対して `npm install`、`npm ci`、package postinstallを実行しない。既存の `mindcraft-eval/runtime/upstream/node_modules` はread-only dependency inputとして扱い、検証で稼働中server、credentials、play processを操作しない。

## パスと実行境界

- botの基本指示と共通方針の正本は `src/process/codex/AGENTS.md`。Codex sessionが新規開始・thread再開時にbundleの同ファイルを専用cwdへコピーし、生成SDK一覧を追加して標準workspace loaderで読む。独立した規約file・設定key・Prompterによる規約追加は使わない。開発用のrepo root `AGENTS.md` はbotへ渡さない。

| Role | Path |
|---|---|
| Personal source checkout | `/home/akito/workspace/project/minecraft-autonomy/mindcraft/` |
| Read-only upstream/dependency input | `/home/akito/workspace/project/minecraft-autonomy/mindcraft-eval/runtime/upstream/` |
| Evaluation and case templates | `/home/akito/workspace/project/minecraft-autonomy/mindcraft-eval/` |

- `mindcraft-eval/runtime/upstream/codex-oauth.json` を読まない、コピーしない、stage/logに含めない。keys、`.env`、profiles、bot logs、conversations、memory、worlds、server jars、runtime modules、生成resultを追加しない。
- PlaceStoreはroot `settings.js` の `place_state_dir` と `place_world_id` だけをscope正本として使う。絶対pathとUUIDを両方設定するか、両方nullにする。片方だけの設定は起動後のRPCで明示errorになる。これらはstartup-onlyで、個別agent/UI設定からscopeを指定しない。place stateは `load_memory` と独立し、worldごとに `place_state_dir/worlds/<place_world_id>.json` へ保存する。
- Protected MindServerではlauncherがfreshな0700 directory配下のsession pathを渡す。session fileはhubが0600で作成し、hub自身だけがgraceful close時に削除する。tokenをsettings/profile/history/log/sourceへ保存・複製せず、既存session fileを再利用しない。crash後のstale fileは認証に使わず、新しいprivate pathで起動する。
- 同一state rootには一つのMindServerだけが書く。通常のSIGINT/SIGTERMとUI shutdownではhub停止時にlockを解放する。crash後に `.place-store.lock` が残ったら、PIDと実行中MindServerを確認してwriterが存在しない場合に限り手動削除する。writerがいる間にlockを削除しない。
- ユーザー作成のworld template/saveはread-only。live確認は既存CaseServer copyだけで行い、templateを生成・編集しない。
- smokeや通常検証では稼働中play server `40973`、UI `8098`、tmux session、4体のbotを操作しない。ユーザーが明示承認したbot-only切替に限り親Node・4bot・UIの停止/起動を許可する。Minecraft server/worldとOllamaは切替対象外。test目的でplay起動scriptを実行しない。
- 隔離Minecraft live確認はCaseServerのloopback `25569` / `25570`だけを使う。`25566`は禁止。productionやsystem serviceを変更しない。
- craft同期helper、`craftRecipe` wrapper、farm skillはこのforkの通常sourceとして管理する。eval/play runtimeはmanifestのfull SHAからexportし、play overlaysは `../mindcraft-tools/` 側で適用する。manifest更新前にforkのcommitをown originへpushし、eval側で検証する。
- 向き指定は `placeBlock` のoptions objectと `block_placement.js` が所有する。既存文字列 `placeOn` は互換経路。設置規則/private Mineflayer adapterを一か所に保ち、serverで未確認の向きを成功扱いしない。`skills.js` をdisposable fixtureへcopyするときはこのhelperもcopyする。実測範囲はREADMEのplacement verification recordを参照する。
- 表面への照準・interaction goalの判定は `block_interaction.js` を再利用する。中心の可視性を採掘の必須条件に戻さない。`skills.js`、`world.js`、`mining_sync.js` をdisposable fixtureへcopyするときはこのhelperもcopyする。有限samplingの未発見を全面遮蔽の証明にしない。実測は [`docs/surface-interaction-20261008.md`](docs/surface-interaction-20261008.md) を参照。
- 設置時の姿勢は既存 `Movements.interactableBlocks` を使って選び、通常supportで常にスニークさせない。隣接チェストの結合も姿勢で変わる。向きだけの確認をラージチェスト完成と扱わず、両方のtypeを再観察する。汎用回復方針と姿勢の実測は [`docs/native-goal-recovery-20261006.md`](docs/native-goal-recovery-20261006.md) を参照する。
- `autonomy`でsourceを編集し、上記Node 20 offline suiteを通してからown originへcommit/pushする。eval側はそのfull SHAをmanifestへpinし、read-only dependency treeを使って再検証した後に新bundleを準備する。

## 完了条件

- 既存挙動を保ってsourceと意味のある回帰テストをこのforkへ移す。
- 記載したcheckを実行してfull diffを確認し、credentialと生成runtime dataをGitへ含めない。
- `autonomy`上の `origin` だけへcommit/pushし、他repoがpinする前にremote commit SHAを確認する。

- `agent_runtime: "codex-session"` はroot settingsの明示opt-in。標準tool待機・遅延SDK説明・scope付きthread再開・画像入力の仕様とCLI検証範囲は[README](README.md#opt-in-codex-task-session)と[移行記録](docs/codex-standard-harness-20261006.md)を参照する。`src/process/codex_session.js` は既存owned CLI helperの親登録ACKとprocess回収を再利用する。native task中は旧recovery modelを並行起動しない。機能追加だけでmanual play pinを更新・bot切替しない。

- bot指示は起動時にbundleの `src/process/codex/AGENTS.md` のsnapshotへSDK文書から自動生成したmethod名一覧を付け、専用一時cwdへ配置して標準loaderで読む。指示の変更は次のsession開始・再開時に読む。repo rootの開発指示をbotへコピーしない。専用一時CODEX_HOMEでは既存homeのauth.json/config.toml/sessionsだけをsymlink共有し、global AGENTS/skillsを共有しない。file認証を使用し、認証内容を読出し・複製しない。multi-agentの説明文もagents.enabled=falseで止める。能力設定はhostが判断ごとに渡す。標準読込に必要な既定workspace accessを残し、shell無効・read-only sandbox・Minecraft以外のtool拒否は維持する。

- native botは常時見えるSDK method名一覧から選び、必要な説明だけをcode modeで読む。固定templateへmethod一覧や全説明を手書きしない。起動overrideは `features.code_mode.direct_only_tool_namespaces` が正しいキー。変更時はstrict-config・実rollout・新規/再開の説明と画像を隔離確認し、設定受理だけを効果の証拠にしない。context検証は [`docs/native-context-revision-20261006.md`](docs/native-context-revision-20261006.md) と[global/multi-agent分離記録](docs/native-context-isolation-20261006.md)、[SDK一覧の比較記録](docs/native-sdk-catalog-20261006.md)を参照。

- native SDK引数の正本は `src/agent/library/native_sdk.js`。全namespaceをhost bot束縛・名前付きobject1つで公開し、同一定義からdeferred説明/名前一覧/lintを作る。内部/legacy/chatのbot-first署名は保つ。入力errorは副作用前に拒否し、公開field・修正例をoperationとtask diagnosticsへ残す。契約を変更したらscope/protocolと新規・再開の隔離確認も更新する。raw `log(bot, message)` は別の出力helper。
