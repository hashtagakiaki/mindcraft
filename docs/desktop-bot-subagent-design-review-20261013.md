# Codex desktopから既存botを呼ぶ設計レビュー

2026-10-13。対象はレビュー前の `PLAN.md`。ユーザーに呼び出し元を確認し、「このチャットのCodex」と確定した。設計とソースの静的レビューであり、稼働botへの依頼・設定変更・動作実験は実施していない。

## 指摘と対応

### [P1] 呼び出し元が異なり、目的の入口がない

旧計画は `communication.delegateTask` をMinecraft botのSDKへ追加する案だった。このチャットのCodexにはそのSDKが公開されないため、実装してもユーザーの目的を満たさない。呼び出し元をdesktop Codexとし、既存botへ仕事を送る外部操作入口を設ける。

標準サブエージェントのcustom agentは新しいCodex sessionの設定であり、既存Minecraft botの接続先を指定する設定は確認できなかった。[公式Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)。既存botを直接使う案では、独立したtask handleを操作する。標準 `agents.spawn_agent` やサブエージェントのUIへ既存botがそのまま登録されるとは約束しない。

### [P1] 同期呼び出しと1件制限では並行作業を阻む

旧計画は完了まで待つSDK呼び出しを1件に制限していた。親botのゲーム操作として待つ場合、既定30秒の停滞期限と10分のaction期限の対象になる（[`codex_runtime.js`](../src/agent/codex_runtime.js#L13)）。長時間の子taskと待機する操作の寿命が一致していない。desktop側でも単一の長いtool呼び出しにすると、別botへの割り当て・進捗確認が難しくなる。

`start_task` は受理後すぐhandleを返し、`wait_tasks` は複数handleを短い有界待機で扱う。異なるbotへの依頼は並行可能とし、制限はbotごとにactive task 1件とする。待機toolのtimeoutはtask中断を意味しない。[公式MCP](https://learn.chatgpt.com/docs/extend/mcp)もtool timeoutを持つため、ゲームtaskのdeadlineとは分離する。

### [P1] protectedへの切替を必須とした根拠が適用先を誤っている

既存native peer inboxがprotected専用であるのは事実だが、desktop Codexが使うのはoperator用の経路である。現在の `send-message` はoperatorとlegacyを許可している（[`mindserver.js`](../src/mindcraft/mindserver.js#L380)）。この入口を土台とする設計ではUIをprotectedへ切り替える必然性がない。

現在のlegacyの信頼境界で使い、protectedの環境では既存operator認証に従う。legacyに認証済みbot identityの保証があるとは記載しない。MCP入口はstdioのローカルprocess候補とし、新しい公開portや常駐serviceを作らない。UI認証の強化は今回の機能と独立した選択事項とする。

### [P1] 既存send-messageの再利用だけでは対象・既存taskを守れない

`send-message` は本文の先頭mentionを解析し、明示targetより本文の宛先を優先する（[`mindserver.js`](../src/mindcraft/mindserver.js#L392)）。Bot2を指定した依頼の本文が `@Bot3 ...` なら、送信先が変わる。さらにoperator intentは既存runtimeを先にcancelし、世代を更新する（[`agent.js`](../src/agent/agent.js#L738)）。hubのidle snapshotだけでは、この間に届いた別の指示との競合を防げない。

新しいtask APIはbot名を専用fieldから確定し、本文をmentionやliteral commandとして解釈しない。受信agent内で、通常operator入力と共有するtask受理境界にidle確認・予約・task ID割当を入れる。単にbridgeやhubだけをlockして通常入力が迂回できる構成は採用しない。busyなら既存taskを取り消す前に拒否する。

### [P1] 取消と切断時の解放条件が不十分

bot名への `!stop` や `stop-agent` を取消として使うと、既にUIの新しい指示へ切り替わったbotの作業を止め得る。旧計画は切断時に予約を解放するとしつつ、取消時はsettlementまで待つとしており、実行状態が不明なケースの扱いが矛盾していた。既存stopは `stopped:false` を返すwatchdog経路を持つ（[`action_manager.js`](../src/agent/action_manager.js#L139)）。

取消はhandleが指すruntimeとtask IDを受信agentで照合して行う。状態は `stopping` と停止確認済みの `cancelled` を分ける。切断や停止確認失敗は `unknown` とし、idle/世代/所有operationのsettlementを照合できるまでbotを予約可能としない。transportの切断だけでゲーム変更をreplayしたり、別taskを停止したりしない。

### [P1] 受付ACK、実行終了、ゲーム上の達成が混ざっている

`getFullState` のaction欄にはidle情報があるが、task IDや結果は含まれない（[`full_state.js`](../src/agent/library/full_state.js#L59)）。`bot-output` もtask ID付きの完了APIではない。対してruntimeは `terminalOutcome` を持ち、操作のcleanup後に `operationSettlement` とともに確定する（[`codex_runtime.js`](../src/agent/codex_runtime.js#L432)）。この確定点を結果の正本にする必要がある。

実行状態、停止確認、最終報告、観測時刻・world scope、保存成否を個別に返す。botが最終報告を出したことは、ゲーム目標の達成証明ではない。親Codexは依頼時に達成条件と作業範囲を渡し、返された証拠と必要な追加観測で判定する。複数botで同じ建築・容器・素材を扱う場合は、親が対象を分ける。自然言語の制約だけでhostが編集境界を強制する保証は加えない。

### [P2] 検証が内部protocolに偏り、利用開始条件が未確定

offline fixtureだけでは、このチャットから入口を発見・呼出しできることや、既存botのCodexがtaskを実行して結果を返すことは証明できない。既存のstage 5記録もmulti-bot gameplayの有益性を未検証としている（[`native-peer-communication-stage5-20261005.md`](native-peer-communication-stage5-20261005.md)）。

入口はCLI＋skillとstdio MCPを比較する。前者は既存shellとruntimeを使い、追加依存やCodex接続設定を避けられる。後者はtask操作を直接toolとして公開できるが、現在のdesktopでの登録・tool timeout・利用可能なMCP実装を隔離確認する必要がある。設計の第一候補はstdio MCPだが、既存tools repoの「新しい依存を追加しない」条件を満たせない場合は同じtask APIを使うCLI＋skillを採用する。入口のための新しい推論modelは不要。

将来の実装では、隔離したdesktop入口での受理→待機→結果取得と、隔離server上の2botへの読み取りtask並行依頼までを最小の実動確認とする。共有worldを変更する協調作業の性能・品質の主張は別実験が必要。

## レビュー後の判断

既存botを独立した実行workerとして再利用する方向は妥当。ただし必要なのは、desktop Codexのための非同期task操作と、bot側のtask単位の受理・結果・取消契約である。新しいbot間委任機能、独自の推論coordinator、常駐scheduler、UI認証方式の変更は今回の目的から要求されない。

指摘を反映した計画は [`../PLAN.md`](../PLAN.md)。入口の隔離確認は実装を依頼された後に行う。現時点では設計のみ。
