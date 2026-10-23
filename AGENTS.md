# MindCraft autonomy — Codex Project Instructions

## 所有と入口

- `hashtagakiaki/mindcraft` の `autonomy` branchが開発source。`origin` のみpushし、upstream `mindcraft-bots/mindcraft` はread-only。
- upstream stable base `b36eaf7e61b3f6bd031fdb531812b2e3c42b6c73`、履歴、`LICENSE` を保つ。`develop`へ切替・依存更新・upstream checkoutのコピーをしない。
- 開発者向け入口はこのrepoの [`README.md`](README.md)。bot共通指示の正本は [`src/process/codex/AGENTS.md`](src/process/codex/AGENTS.md) で、開発用root `AGENTS.md` はbot専用Codex cwdへコピーしない。

## よく使う確認

Node 20と既存read-only dependenciesを使う。install/ciやpackage postinstallは禁止。

| 目的 | コマンド |
|---|---|
| 必須offline regression suite | `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs` |
| Diagnostics/ring/capture/navigation fixtures | 同じNodeで `tests/diagnostics_store.test.cjs`, `tests/reach_position.test.cjs`, `tests/codex_session.test.cjs` |
| Shared CLI fast fixtures | `/home/akito/workspace/project/test-manager/bin/codex-test run --scope fast --project mindcraft` |
| 関連fixtureを単独実行 | 同じNodeで `tests/<fixture>.test.cjs` |
| Syntax | 同じNodeで `--check main.js` |
| 差分 | `git diff --check`、`git status --short` |

Runnerはdisposable fixtureを使いMinecraft serverを起動しない。fixtureの依存解決はrepo内 `node_modules` を優先し、`../mindcraft-eval/runtime/upstream/node_modules` をread-only fallbackにする。`npm test` は未設定。suiteの構成と動作契約はREADMEの[検証範囲](README.md#action-cancellation-and-reconnect-behavior)を参照。

## パスと保護境界

- sourceはこのrepo。`../mindcraft-eval/` はbenchmarkとread-only第三者入力、`../mindcraft-tools/` はplay運用code/tests、`../play/` は稼働設定・保存dataのowner。
- OAuth credentials、keys、`.env` は読取・コピーしない。`mindcraft-eval/runtime/upstream/codex-oauth.json` も開かない。既存profiles、bot logs/conversations/memory、worlds、server jars、runtime modules、生成resultsは必要ならread-onlyで調査できるが、Gitへ追加・stageしない。
- `runtime/upstream/` のdependency/jar/EULAとuser world template/saveはread-only。fixture/live smokeでtemplateを生成・変更しない。
- 通常確認では稼働play server `40973`、UI `8098`、tmux、4 bots、Ollamaを操作せず、play起動scriptをtestで実行しない。isolated Minecraft確認はCaseServerのloopback `25569`/`25570`のみ。`25566`は禁止。production/system serviceも変更しない。
- PlaceStore scopeはroot `settings.js` の `place_state_dir` と `place_world_id` に限る。絶対pathとUUIDを両方設定するか両方null。Protected MindServerのsessionはprivate 0700 dir/0600 file、tokenを保存・複製せず、crash後のfileは再利用しない。PlaceStore lockはwriter不在を確認せず削除しない。
- sourceの公開・再検証に必要な詳細（SDK、navigation、placement、session、Goals等）はREADMEの該当節とリンク先docsを参照し、ここでは重複させない。

## 完了条件

- 該当する既存fixtureと必須offline suiteを実行し、full diffとsecret/runtime dataの不在を確認する。
- task差分だけをstageし、`autonomy`からown `origin`へcommit/pushする。upstreamへpushしない。
- evalのsource manifestはpush済みfull SHAだけをpinし、eval側でread-only dependenciesを使って再検証する。手動play pinは別管理。通常の機能追加だけでは自動反映しない。ただし親 `minecraft-autonomy/AGENTS.md` の継続指示が有効な横断作業では、そこに定めた検証後bot-only applyを行い、個別承認条件は適用しない。
- bot指示snapshot、SDK一覧、tool境界、Codex home/session保存、action cancellation、Goalsの契約はbot instruction正本とREADMEに従う。変更時は関連する既存fixtureと隔離確認を更新する。
