# PLAN

Goal: native botの生成コードを、対象の選択・順序・有限loopとskill呼び出しを中心とする短いコードにし、各操作の失敗停止・取消・時間区切り・移動時の非編集をSDK/実行基盤で保証する。

## Acceptance criteria and verification

- nativeの操作skillがfalse/例外を返したら、そのoperationでは後続SDK操作を開始しない。生成コードが戻り値を無視・catch・await省略しても失敗が結果に残り、途中までの変更を保持する。観測のfalse/空配列は操作失敗と混同しない。既存legacy/chat署名・false設定は維持する。
- nativeの通常移動とskill内の暗黙移動を、既存Movementsの掘削・設置禁止で行う。経路がなければ失敗としてモデルに返し、許可された明示編集で回復する。SDKは自然言語から作業範囲を自動認可しない。範囲・対象と依頼全体の達成判断はモデルが担当する。
- 45,000msをSDK境界でのsoft yieldとして実行基盤が管理する。開始済みskillはsettleを待ち、次の呼び出しを始めず正常な部分結果として返す。生成コードの時計・8編集カウンター・破壊成功の重複確認は不要とする。取消/600秒hard deadline/stall/task budgetとowned promise drainを維持する。busy loop/raw bot/plugin操作は保証外として記載する。
- 破壊/設置/転送等の既存server確認を再利用し、SDK説明・bot指示と実際の失敗契約を一致させる。対象再検索は候補不足・移動・失敗・batch境界で行い、毎編集全3,600blockの走査を要求しない。最終の依頼全範囲確認を維持する。
- 既存native SDK/Coder/SES/ActionManager fixturesで、短いskill loop、部分成功後のfalse/error、catch後の追加操作拒否、unawaited failure、soft yield、Stop/置換/disconnect/shutdown、sync観測維持を確認する。対象navigation fixtureで非編集Movementsを確認し、task-only Node20全suiteを通す。
- push済みsourceをfresh CODEX_HOME/task/worldの隔離20×20整地で検証し、独立400/400・保護0・追加指示0を達成する。9b3a06fの試行（82operation/898.345秒/コード59,212字）とコード量・重複処理・時間内訳を比較し、改善と未改善を区別する。生成コードに時計・逐次false確認・破壊直後の再確認が必要ないことをtraceで確認する。
- template不変、world/server assets/所有process回収とport解放を確認。結果とテストを短い報告に残し、成功sourceのみeval pinへ採用する。

## Constraints

- source所有はmindcraft/autonomy/hashtagakiaki origin。eval所有はmindcraft-eval。既存skills.js・bot AGENTSの場所登録・test runnerとevalの8ファイルの未コミット変更を保存し、今回の候補とcommitへ混ぜない。shared dependencies/template/jarはread-only、npm install/ci禁止。
- 実ゲームは既存CaseServerのrun-copy、loopback25569/25570のみ。grader・課題文・初期在庫・profile/model/Goalsは維持する。結果配下CODEX_HOMEへauth/configのみsymlinkし、sessionを隔離する。管理credentialはモデルへ渡さない。
- 稼働play/source pin/server/world/UI/Ollama/memoryは変更しない。manual反映は別の明示依頼で行う。不合格/中断時はeval pinを保存した9b3a06fへ復元する。
- 新しい整地executor/監督モデル/依存/serviceを追加しない。既存native entry guard・ownership・SDKとMovementsを再利用する。保護範囲の自動推測や全methodの意味の一律上書きを避け、structured resultはmethodの契約に沿って扱う。

## Evidence and open decisions

- [前回試行](../mindcraft-eval/docs/compound-loop-20261009.md): 400/400・保護0、179→82operation、995.248→898.345秒。コード総量58,785→59,212字、平均328→722字。個別の操作SDK以外のoperation時間4.26→59.59秒。operation25の1,358字codeは毎編集全3,600block走査と接近/破壊/再確認を重ねていた。
- breakBlockAtは内部で対象・接近・道具・変化を検査し、mining_syncはlocal推定airを抑えserver blockUpdateによる完了を待つ。既存配置/転送確認も再利用できる。
- Coder.guardSdkは取消/settlementを検査するが、false停止は任意設定でnative既定も続行可能。operation_contextは未await子promiseをsettleまで所有する。新しいnative guardで失敗をlatchし、終了時にも検査する。
- goToGoalは既定Movementsでdestructive fallbackがあり、approachBlockはcanDig/canPlaceOn/足場を禁止したmovementOverrideを使う。native operationの移動policyを既存contextに載せ、暗黙移動にも適用する。
- SDK schema/docs変更はscope hashへ入りthread契約を更新する。hard期限とsoft yieldを分け、yieldはfailureとして再試行回数に数えない。特殊なtree/farm結果は既存status/確認数量を維持し、意味を確認してからfailure条件を定義する。

## Next actions

- [x] native entry guardと移動policyを実装し、既存fixture・bot指示・SDK説明・README/AGENTSを更新する。task-only snapshotで重点fixtureと全suiteを確認しowned originへpushする。
- [ ] 同じcase/graderの隔離整地を実行し、保護・部分結果・コード量・時間を評価する。不合格は条件を緩めず原因を修正し、pinを復元する。
- [ ] 成功候補をeval pinへ採用し報告をcommit/push、全diffと既存変更の保存を確認。完了後PLANを削除する。
