# 表面への到達判定とバッチ継続 — 2026-10-09

## 原因と変更

[2026-10-08の表面操作](surface-interaction-20261008.md)は中心が遮蔽されていても、届く面・縁を選んで破壊できる実装だった。接近は表面まで4.5以内を判定する一方、`mining_sync`にはMineflayerの中心距離5.1以内の判定と、表面距離5.1の別設定が残っていた。[SDK安全移管の整地試行](https://github.com/hashtagakiaki/mindcraft-eval/blob/main/docs/sdk-owned-safety-20261009.md)の距離外7件は、この食い違いに一致する。例としてoperation19の記録位置では、対象中心まで5.2031、最寄り表面まで4.4190だった。

`mining_sync`が公開する`bot.canDigBlock`、掘削前、照準後、開始packet直前の判定を、既存の`resolveBlockInteraction`へそろえた。接近と同じ表面距離4.5を使い、中心距離・中心の可視性は条件に戻さない。diggableでないblock、未知/未ロード、遮蔽、距離外は拒否し、着地待ち・道具・取消・target/state再確認・serverによるair確認を保持する。`forceLook:"ignore"`は現在の視線を引き続き検査する。

この修正は`mining_sync`を導入したbot全体に適用され、SDKだけでなくplugin/legacyの公開`canDigBlock`も表面判定になる。以前の中心距離許容内でも、表面が4.5より遠い場合は拒否する。SDK説明を更新し、scope hashにより旧説明のthread契約は更新される。共有dependencyは変更しない。

細分化に関係した指示は一回限りのoperator messageではなく、bundleの`src/process/codex/AGENTS.md`だった。安全移管時に弱めた「小バッチが終わっただけでモデルへ戻らない」を常設規則へ復元した。候補をbatch単位で検索し、有限の外側loopで次batchを続け、到達可能な区画を進める。時計・逐次false確認・破壊直後の重複確認は追加しない。hostは失敗・取消・45秒のSDK境界を管理し、batchの大きさと生成loopはモデルが選ぶ。

## 検証

- 前回の7件の相対位置を、既存`block_interaction.test.cjs`へ追加。実際のBlock形状・WorldSync ray・Mineflayer digging pluginを使い、修正前に`Block out of digging range`を再現した。修正後は7件とも接近ready・canDig true・追加移動0・開始packet1・fixtureのserver air確認で成功する。
- 旧中心判定なら許容するが表面が4.55離れた対象を拒否する。既存の中心遮蔽・面中心遮蔽・縁のみ可視・slab/fence・草・未知ray・target/state変化・照準後遮蔽・取消・現在視線のfixturesを維持する。
- 既存Coder/SES/ActionManagerで、時計/false wrapperなしの有限外側loopが20回のmock操作を8/8/4の複数batchで同一実行内に続け、観測が0/8/16/20になることを確認した。新規sessionで常設継続規則がAGENTS snapshotへ配置され、再開時の更新を読む既存fixtureも成功した。

task-only snapshotのNode20 `tests/run-tests.cjs`はexit 0。全suite後、追加した継続fixtureの専用windowを前scenarioの5msから明示1000msへ固定し、`tests/codex_session.test.cjs`を再確認してexit 0。製品の45秒設定は変更していない。その他の製品・fixture bytesは全suiteを通したsnapshotと一致する。未コミットの場所登録・skills・test runner変更は保持し、候補とcommitへ含めない。

## 範囲

正本は`results/surface-admission-20261009/`。変更前エラー、変更後fixture、task-only source snapshot、offline logs、既存変更の保存確認を保持する。有限samplingが任意の極小の隙間を必ず発見する保証は追加していない。

その後、65ac392を同じ20×20課題で[再測定](https://github.com/hashtagakiaki/mindcraft-eval/blob/main/docs/surface-admission-remeasurement-20261009.md)し、400/400・保護0・追加指示0で合格した。旧中心距離エラーは7→0、総時間は13分42秒→12分20秒。一方、operationは100→136、コード量は増えた。道具・作業順も異なる単発比較であり、SDK修正だけの速度効果や再現性は推定しない。実ゲームの正本はeval側の`results/surface-admission-20261009/`。manual play反映は未実施。
