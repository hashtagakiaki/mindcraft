# native Codex context修正 — 2026-10-06

手動playのsource `a4788ec75630ea8a13aa1a0e3a143ae4d6c3d7a1` と、2026-10-06 15:25:55–15:26:26 JSTの新規Bot2 taskを基準に修正した。旧play履歴の事例を新バンドルの実行結果として扱っていない。[新規task採取レポート](../../play/observations/context-sample-20261006T152536-Bot2/REPORT.md)に生入力・tool呼出し・rolloutの所在がある。

## 実装した挙動

- CLI 0.160.1の正しいキー `features.code_mode.direct_only_tool_namespaces=["functions"]` と `--strict-config` を使用する。旧キーはstrict起動でunknown fieldになった。正しいキーでも `tools.tool_search` は存在しなかった。
- code modeで `minecraft_sdk__` の必要な名前だけを最大3件表示し、選んだ既存documentation toolを呼ぶ。複数説明は同じexecで取得できる。SDK indexや補助modelは追加していない。
- `minecraft_execute` はcode modeの外で直接呼ぶ。code modeの `tools.minecraft_execute` は未定義。実行結果の画像はnativeのimage contentとして届く。観察結果は `log` に出すよう固定指示を補った。
- bot専用CLIのApps/plugins/multi-agent/skill searchを無効化し、skill catalogのtoken上限を1に設定した。`skip_host_skill_discovery` 単独では一覧を除けず、最終実装には採用していない。ユーザーのglobal config、認証ファイルは変更していない。
- native履歴の既知のshutdown通知だけをモデル入力から除く。raw sequenceの未送信部分を先に選び、filterによるcursorずれを防ぐ。旧memoryの生通知は維持する。新通知は既存archiveに保管し、archive失敗時はmemoryへ残す。会話trimもarchive成功後に行う。
- 初回/tool resultに本人名、task ID、受理済み依頼、実接続に応じたplace memory/native peer能力、host残予算を渡す。在庫は種類別合計、道具/装備は個々の残り耐久を表示する。完全な観測と実行結果はhost trace/診断へ残す。
- resultの空の補助fieldと重複した一般説明を省く。executor/domain結果、失敗、部分変更、確認範囲、scope/時刻、settlementは保つ。最新shared rulesは各判断で本文を再読込し、読込失敗時の中断を維持する。
- context protocol 3で旧contract threadは一度新規化する。以後は同scopeのthreadを通常再開する。

## 隔離CLI確認と残る内容

installed CLI 0.160.1、gpt-6-luna / medium、実装したCodexSessionとowned helperで確認した。ゲームexecutorはsyntheticで、Minecraftへ接続していない。証拠は `../../mindcraft-tools/results/context-implementation-20261006/` に保存した。

説明だけにある必須引数を取得してsynthetic executorへ渡せた。新規と再開後の未使用methodで確認し、検索TypeErrorや説明一覧のdumpはなかった。direct toolの画像内の4文字と長方形の色を正しく報告し、再開後にも保持した。再開直後の一試行ではモデルがexec不在と述べたが、未使用文書を必ず読む対照taskでは実際にexecと説明toolを呼べた。モデルの不在申告だけをtool可否の証拠にしていない。

最終設定の実rolloutではskill一覧は空、recommended plugins案内も消えた。code modeのregistry確認ではSDK以外は `clock__curr_time` と `image_gen__imagegen` の2件だった。これらは固定bot指示で使用を禁止するが、完全にtoolをMinecraftだけにしたとは報告しない。

標準loader由来の `/home/akito/.codex/AGENTS.md` と一時cwdのbot AGENTSは、実 `instructionSources` の両方に残る。multi-agent説明文、skill機構やpermissionsの枠も残る。global AGENTSの完全分離は後続課題で、今回達成していない。workspace loaderや既存認証を置換する独自機構は作っていない。

## 比較と検証範囲

比較の生データと指標は同results directoryの `comparison.json` に記録した。採取したBot2の依頼と旧memoryを隔離コピーし、sourceのruntime/History/SDK文書、実CodexSessionを使用した。位置・在庫・ロード済みair/チェスト0件は同じsynthetic観測に固定した。Coder/SES/action settlementそのものは既存offline fixtureで検証する。

予備比較ではsynthetic側の近傍API不足が余計な失敗を発生させた。そのデータも保持し、最後は両sourceへ同じ読み取りAPIを用意した。初回/各推論input、cached input、説明出力文字数、tool数、経過時間を記録し、累積input token数とcontextサイズを区別する。各条件は少数の試行で、所要時間・総token・play成功率の改善保証には使わない。

最後の同条件各1回では両方とも位置・在庫・耐久・チェスト0件を報告し、操作は各1回だった。

| 指標 | 旧source | 修正後 |
|---|---:|---:|
| host初回入力文字数 | 5,688 | 2,693 |
| 初回入力内shutdown通知 | 9 | 0 |
| 初回推論input tokens | 15,217 | 12,662 |
| 最終推論input tokens | 27,511 | 15,808 |
| 説明関連tool output文字数（dump含む） | 48,772 | 3,914 |
| 広い説明dump | 2 | 0 |
| model tool呼出し | 3 | 7 |
| SDK説明tool読込 | 0 | 3 |
| host decisions | 2 | 5 |
| 累積input / cached input tokens | 92,971 / 62,720 | 111,328 / 76,288 |
| 経過時間 | 21.8秒 | 34.3秒 |

入力と説明dumpは減ったが、必要な名前の探索・説明取得の往復が増えたため、この比較では累積tokenと時間は改善しなかった。モデル内部の名前探索はhost decisionには数えず、説明tool応答は数える。速度改善を達成したとは報告しない。

Node20の既定offline suite、`node --check main.js`、`git diff --check`を実行した。新しいfixtureはshutdownの投影・保存失敗時の保持・raw cursor、在庫/耐久、false/部分変更/診断の保持、host予算、legacy/protected/disconnectedの能力を確認する。既存fixtureのrules更新、pending結果、画像、停止/差替え/drain、永続thread/旧memory互換も保持した。

最初の全suiteは既存 `agent_process.test.cjs:431` のrestart時間窓でgeneration 5対期待3になった。単独再実行と全suite再実行は通過した。このtaskでprocess supervisorの実装や時間窓testを変更していない。

手動playのpin、稼働bundle、4bot、Minecraft server/world、Ollamaは変更していない。2.242ブロックの位置変化も原因未確定で、今回は自動modeを変更していない。

設定仕様の参考: [公式config reference](https://learn.chatgpt.com/docs/config-file/config-reference)、[標準AGENTS読込](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。効果の判定には上記installed-versionの実rolloutを使用した。
