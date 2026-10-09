# PLAN

Goal: native Codex botが正常な反復作業を1回のコード実行内で継続し、8編集ごとの再観測と失敗時の停止を保ちながら、20×20整地のモデル往復と完了時間を減らす。

## Acceptance criteria and verification

- 既存の`minecraft_execute`で「観測→最大8編集→実際の結果を再観測→次のbatch」を複数回行う。生成コードとtraceに、1回のoperationで8個を超える編集とbatch間の再観測が確認できる。8はtool全体の編集上限ではなく、再確認までの編集上限として扱う。
- false/error、未ロード・予想外の状態、道具/資材不足、確認した進捗の停止では追加編集を止め、変更済みの状態と判断に必要な情報をモデルへ返す。成功したSDK呼び出しだけで完了としない。取り直した対象リストと実際の結果を使い、同じ失敗を無条件に繰り返さない。
- 通常の反復は45秒を初期目安として自主的に区切る。生成コード中のnamed constantと`Date.now()`を使い、次のSDK呼び出し前とbatch境界で期限を確認する。45秒はsoftな目安で、進行中のSDK呼び出しが越えることはある。既存の10分action deadline、stall、task budgets、Stop/置換/disconnect/shutdownの取消・settlementは変更しない。
- 既存Coder/ActionManagerを通した隔離確認で、複数batch、false後の停止、部分成功、時間による自主returnを確認する。既存`tests/codex_session.test.cjs`のStop/置換/取消fixtureとNode20全suiteが成功する。新しい反復形で未検証の中断経路があれば既存fixtureを必要な範囲で補う。
- Goalsあり・gpt-6-luna/medium・同じtemplate/profile/初期在庫・40分上限・immediate-stopで、変更前と候補をfresh task/worldから各1回実行する。候補は独立graderで400/400、保護変更0、人間の追加指示0を達成し、変更前に比べoperation数・操作外時間・総時間がすべて減る。各1回は改善例の確認であり、成功率の証明とは書かない。
- 試験のsource SHA、runner/dependency/template/grader条件、生成コード、時間内訳、失敗と部分成功を記録する。元template不変、実験process回収とport解放を確認する。計測は既存trace/metadataと使い捨て集計で行い、新しいbenchmark基盤を作らない。

## Constraints

- 最初の変更はsourceの`src/process/codex/AGENTS.md`にある反復・再観測・返却方針と、対応するREADME記述に絞る。モデルが通常ループを生成できることを先に確かめる。専用の整地executor、監督モデル、独自の自動再指示、新SDK/依存/serviceを先に加えない。
- bot指示は同じファイルへ統合する。SDKの名前付きobject契約、標準loader、Goalsの継続・停止を維持する。8編集ごとの確認を単純に大きい数へ変更しない。内部の通常観測を別tool呼び出しへ分けず、結果ログはbatch単位の短い進捗/失敗/終了理由にまとめる。
- source所有はこの`mindcraft/`、benchmark所有は`../mindcraft-eval/`。`../mindcraft-tools/PLAN.md`は別件の計画として保持する。親フォルダに共通コードを追加しない。
- sourceの未コミット`skills.js`、bot AGENTSの場所登録方針、`tests/run-tests.cjs`を保存し、今回のstage/候補exportへ混ぜない。evalにも既存のcase削除・cleanup変更があるため保存し、比較2条件に同じrunner/server snapshotを使う。
- sourceは`autonomy`/owned originのみ。候補をNode20で検証しpushしたfull SHAだけをexportする。比較用eval manifestは変更前をbackupし、逐次切り替える。中断/不合格時は元pinを復元し、合格後に候補を正式pinする。
- 実ゲームはCaseServerのrun-copyとloopback25569/25570のみ。共有dependency/jar/EULA/templateはread-only、npm install/ci禁止。実験専用CODEX_HOMEを結果directory配下へ作り、auth/configだけsymlink共有する。sessionはそこへ保存する。
- 今回は計画のみ。実装後の検証にも稼働play/server/world/UI/Ollama、manual pin、namespace・memoryの変更を含めない。play反映は別の明示依頼で既存bot-only applyを使う。

## Evidence and open decisions

### 確認済み

- source基点は`a8877c652d9803a7c5f5c57863fc2af00b95504a`。[整地実測](../mindcraft-eval/docs/goal-continuation-20261009.md)はGoalsあり400/400、791.165秒、156operation、追加指示0、自動続行1。
- [時間分析](../mindcraft-eval/results/goal-continuation-20261009/TIMING_ANALYSIS.md)では操作359.524秒、操作外431.641秒。操作外はモデル生成以外のtool/wrapper/観測待ちも含み、純粋な推論時間とは断定できない。失敗10operation、timeout0。Goalsのturn切替は0.007秒。
- `codex_runtime.js`は`MAX_BLOCK_EDITS_PER_CHECK=8`を能力情報へ渡す。`src/process/codex/AGENTS.md`は小分け編集を要求し、同時に複数skill/loopを1callで使えると書いている。8個で実行を強制終了するカウンターはなく、当該traceの生成コードが`slice(0,8)`の1batchで終了していた。
- `coder.js`はguard済みSDKを既存SESへ渡し、await後の次のSDK呼び出しも取消状態を検査する。`lockdown.js`の`makeCompartment`はDateを提供する。`codex_session.js`は1callの実際のsettled resultを返す。
- 小実験: 上記基点のexportの`makeCompartment`をNode20 `--input-type=module`から読み、20件のmock編集を8件ずつ処理した。正常系は1call・20編集・4観測、false系は2編集後の3回目で停止、2ms目安/5ms待ちの系は1編集後yield。[結果](../mindcraft-eval/results/goal-continuation-20261009/compound-loop-plan-probe.json)。これはSESでのclock/loopの実行確認だけで、Coder/ActionManager、モデルの採用、実Minecraftの証明ではない。

### 実装時に解く不確実性

- **指示の明確化だけでモデルがloopを選ぶか。** 通常の整地依頼は変更せず候補の実ゲームtraceで調べる。複数batch/1operationが出なければ、返却条件と短い汎用loop例を指示内で最小修正して再確認する。採用しない場合や採用しても時間が減らない場合は、code/状態/待ちの証拠から原因を特定して計画を更新する。合格条件を緩めず、汎用executorの追加を自動決定しない。
- **45秒目安で新しい問題が出ないか。** 既存guard経路で取消を確認し、実ゲームでは1operationの時間・SDK呼び出し・出力の切り詰め・停止後の追加編集を調べる。目安超過が遅い1skillによる場合はhard deadlineの失敗と混同しない。同期busy loopは使わず、有限loopとawaitするSDK処理にする。
- **削減が確認回数の省略によるものではないか。** operation内の再観測と進捗/失敗条件、全400列の独立採点を両方確認する。graderはagentへ渡さない。

## Next actions

- [ ] 作業開始時のstatus/diffと比較入力を記録し、今回のsource差分を分離する。bot指示で「8編集ごとの再確認」「正常時のコード内継続」「戻す条件」「45秒目安」を明確化する。新規開始/再開時に標準loaderが変更指示を読むことを既存fixtureで確認する。
- [ ] 既存Coder/ActionManagerの隔離確認とNode20全suiteを通し、READMEへ実際の返却・時間目安・検証範囲を記載する。task差分だけをreviewしowned originへpushする。source docs/コマンドの変更に応じAGENTSも更新する。
- [ ] evalの入力snapshotを固定し、変更前/候補のGoalsあり整地を各1回逐次実行する。既存runner: `python3 scripts/run_mindcraft.py --case cases/terrain-leveling-20x20.json --agent-runtime codex-session --goals --start-port 25569 --node-bin /home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node --results-root results/compound-loop-<date>/<condition>`（cwdはeval、条件別CODEX_HOME/full SHAを事前設定）。改善条件と保護・取消・入力不変を検査し、操作内外の内訳を同じ定義で比較する。
- [ ] 結果をevalの短い報告へ残し、合格ならeval pinを候補へ更新してtask変更だけcommit/pushする。計画を完了条件に照らして終了し、play反映は未実施として報告する。失敗ならmanifestを復元し、原因と次に判別する実験を計画へ反映する。

## Deferred work

- playへのbot-only反映は改善確認後の明示依頼に依存する。実施時は旧bundle/configを保管し、4体とUIのreadinessが揃う前にpointerを更新しない。失敗時は旧bundleを復旧し、Minecraft/world/Ollamaのidentityは維持する。
- 複数seed/反復による信頼性評価、4体協調、採掘・移動SDK自体の改善はこの往復削減の比較結果から必要性を判断する。
