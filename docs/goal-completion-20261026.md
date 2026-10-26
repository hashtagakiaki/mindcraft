# Goal完了と基本観測の追加実行削減 — 2026-10-26

## 変更

native taskの初期観測・操作結果に `timeOfDay` を渡す。欠測は `null` で、既存の観測時刻・dimensionと一緒に扱う。bot指示は、現在観測で回答できる場合に同じ事実を取り直さず、依頼全体の達成を確認した同じturnで標準Goalをcompleteにしてから最終回答するよう定める。未達Goalの標準自動続行は維持する。

nativeの生成code lintでは `require-await` だけを解除し、同期SDK照会へのダミーawaitを不要にした。legacyのlint、SDK検証、取消・未await子操作の所有は維持する。

## 観測と隔離確認

修正前のmanual task「今の時間帯は？」は3turn・約35秒だった。2turn目の空の画像確認は有用だったが、3turn目はGoalのcomplete更新と回答の言い直しだけで、約5秒・追加推論2回を使っていた。生成直後と最終routeのUI二重送信自体は追加生成を起動しない。

CLI 0.164.0、稼働profileと同じ `gpt-6-luna` / medium、独立した新規thread、固定した模擬状態で変更前後を各3回確認した。bot専用CodexSession・標準AGENTS loader・全SDK文書一覧・Goalsを使用し、SDKの実行先だけを模擬化した。時刻は6000 tickで、変更前は初期観測に含めず、変更後は含めた。cameraは両版とも利用不可であり、失敗結果に模擬 `bot.time.timeOfDay` の所在を示した。

| 条件 | LLM応答数 | 自動続行数 | SDK実行数 | 経過秒 |
|---|---|---|---|---|
| 変更前・3試行 | 9 / 8 / 9 | 1 / 1 / 1 | 3 / 3 / 2 | 38.6 / 40.3 / 22.8 |
| 最終版・3試行 | 2 / 3 / 2 | 0 / 0 / 0 | 0 / 0 / 0 | 7.3 / 6.6 / 4.8 |

最終版は3回とも正午と回答し、最初の最終回答より前に同じturn内でcompleteになった。SDK文書照会も全て0回。変更前の初回は6000 tickを午前6時と誤読したため、3回全てが同じ品質の正答を得た比較ではない。初期案は1回だけ不要な位置照会があり、現在観測の再利用とtick単位の説明を加えた最終版で取り直した。

入力の合計token（括弧内cached）は、変更前156,859（117,632）/ 137,300（117,376）/ 195,044（169,600）、最終版31,597（15,488）/ 47,366（30,976）/ 31,558（15,488）。出力は変更前888 / 1,050 / 554、最終版80 / 120 / 41。LLM応答数はusageが報告された生成の数で、Codex turn数ではない。cold/warm cacheが異なるため、token比を料金比として扱わない。

別の最終版模擬課題では、最初のcraftが作業台到達エラーで失敗した後、移動・再製作・所持品照会を行い、石のツルハシ1本を確認してcompleteになった。3 SDK実行・約12.6秒。既存offline Goal fixtureでも、activeな未達Goalの自動続行と、同一turnのcomplete後の正常終了を確認した。

結果の正本はGit ignoredの [`results/goal-completion-20261026/`](../results/goal-completion-20261026/) にある `summary.json`、各版の結果JSON、専用 `codex-home/sessions/`。通常の開発sessionsやmanualのmemory/threadへ検証会話を混ぜず、manual worldにはtaskを送っていない。必須offline suiteを含むtest-manager affectedは `20261026T073053Z-130f769d` でpass。

これは基本観測・lint・指示を合わせた模擬確認で、各変更の寄与を分離した比較や実ゲームの成功率ではない。Goal完了更新と、その結果を受けた回答生成は引き続き必要であり、完了処理の推論を全てなくす変更ではない。
