# MindCraft autonomy fork — Codex Project Instructions

## リポジトリとsource基点

- 個人リポジトリ `hashtagakiaki/mindcraft`。変更・pushは所有する `autonomy` branchだけで行う。
- `origin` は自分のfork、`upstream` は `https://github.com/mindcraft-bots/mindcraft.git`。upstreamはread-onlyで、pushしない。
- branchはupstream stable commit `b36eaf7e61b3f6bd031fdb531812b2e3c42b6c73` が基点。skill移管に合わせてupstream `develop`へ切り替えたり、依存を更新したりしない。
- upstreamの履歴と `LICENSE` を保持する。upstream checkout、`.git`、untracked fileをこのrepoへコピーしない。

## 検証済みコマンド

| Purpose | Command |
|---|---|
| Offline craft/farm/mining regression tests | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs` |
| Place store/RPC focused fixtures | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/place_store.test.cjs` and `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/place_rpc.test.cjs` |
| Syntax check | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node --check main.js` |
| Whitespace check | `git diff --check` |
| Worktree status | `git status --short` |

`tests/run-tests.cjs` は一時fixtureへsourceとminimum mockを用意し、Minecraft serverやshared dependenciesを変更せずcraft protocol、farm workflow、採掘同期を検証する。採掘fixtureはread-onlyの `mindcraft-eval/runtime/upstream/node_modules` から実dig/loader/Block/Tool実装も読み込み、target airと対象dropのserver `playerCollect`確認を検証する。`npm test` は未設定。共有依存に対して `npm install`、`npm ci`、package postinstallを実行しない。既存の `mindcraft-eval/runtime/upstream/node_modules` はread-only dependency inputとして扱う。

## パスと実行境界

| Role | Path |
|---|---|
| Personal source checkout | `/home/akito/workspace/project/minecraft-autonomy/mindcraft/` |
| Read-only upstream/dependency input | `/home/akito/workspace/project/minecraft-autonomy/mindcraft-eval/runtime/upstream/` |
| Evaluation and case templates | `/home/akito/workspace/project/minecraft-autonomy/mindcraft-eval/` |

- `mindcraft-eval/runtime/upstream/codex-oauth.json` を読まない、コピーしない、stage/logに含めない。keys、`.env`、profiles、bot logs、conversations、memory、worlds、server jars、runtime modules、生成resultを追加しない。
- PlaceStoreはroot `settings.js` の `place_state_dir` と `place_world_id` だけをscope正本として使う。絶対pathとUUIDを両方設定するか、両方nullにする。片方だけの設定は起動後のRPCで明示errorになる。これらはstartup-onlyで、個別agent/UI設定からscopeを指定しない。place stateは `load_memory` と独立し、worldごとに `place_state_dir/worlds/<place_world_id>.json` へ保存する。
- 同一state rootには一つのMindServerだけが書く。通常のSIGINT/SIGTERMとUI shutdownではhub停止時にlockを解放する。crash後に `.place-store.lock` が残ったら、PIDと実行中MindServerを確認してwriterが存在しない場合に限り手動削除する。writerがいる間にlockを削除しない。
- ユーザー作成のworld template/saveはread-only。live確認は既存CaseServer copyだけで行い、templateを生成・編集しない。
- smokeや通常検証では稼働中play server `40973`、UI `8098`、tmux session、4体のbotを操作しない。ユーザーが明示承認したbot-only切替に限り親Node・4bot・UIの停止/起動を許可する。Minecraft server/worldとOllamaは切替対象外。test目的でplay起動scriptを実行しない。
- 隔離Minecraft live確認はCaseServerのloopback `25569` / `25570`だけを使う。`25566`は禁止。productionやsystem serviceを変更しない。
- craft同期helper、`craftRecipe` wrapper、farm skillはこのforkの通常sourceとして管理する。eval/play runtimeはmanifestのfull SHAからexportし、play overlaysはeval側で適用する。manifest更新前にforkのcommitをown originへpushし、eval側で検証する。
- `autonomy`でsourceを編集し、上記Node 20 offline suiteを通してからown originへcommit/pushする。eval側はそのfull SHAをmanifestへpinし、read-only dependency treeを使って再検証した後に新bundleを準備する。

## 完了条件

- 既存挙動を保ってsourceと意味のある回帰テストをこのforkへ移す。
- 記載したcheckを実行してfull diffを確認し、credentialと生成runtime dataをGitへ含めない。
- `autonomy`上の `origin` だけへcommit/pushし、他repoがpinする前にremote commit SHAを確認する。
