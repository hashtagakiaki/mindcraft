# PLAN

Goal: vision SDKの誤引数を視線変更前に拒否し、operator taskへ修正可能な失敗結果を返す。正しいcallは現在のSDKで動き、Minecraftからの切断理由はNBT/JSONの内容を読める文字列で表示する。

## Acceptance criteria and verification

- `vision.lookAtPosition(bot,75,73,-292)`、NaN/Infinity、文字列、欠落座標を`bot.lookAt`/camera/networkへ到達させない。失敗結果には`vision.lookAtPosition(x,y,z)`の正しい使い方を含める。
- 正しい3座標のcall、chat command経由のcall、lookAtPlayerの`at`/`with`と従来の省略`at`動作、vision disabled時の返答を維持する。
- 実Coder/SES/ActionManagerで、誤呼び出しのoperationが`success=false`かつ`settled`で終了し、同じtask/接続で正しいcallを続行できる。不正rotation packetとkickは0。
- 実測NBT `{type:'compound',value:{translate:{type:'string',value:'multiplayer.disconnect.invalid_player_movement'}}}`を`Invalid move player packet received`として表示できる。JSON/plain textと既存の理由分類も保つ。
- sourceのNode 20 offline suite、関連fixture、隔離runtimeの実サーバー確認を成功させ、full diffとtask-only staged diffを確認する。

## Constraints

- source ownerはこのrepoの`autonomy` branch。既存の未コミット`skills.js`、`modes.js`、`tests/recovery_replanning.test.cjs`、`tests/run-tests.cjs`を保持する。tests/run-testsへの登録は既存の編集を読み、今回の項目だけを加える。
- 2026-10-06の「適用して」によりsource修正と既存手順によるbot-only切替を実施する。server/world/Ollamaを維持し、4bot readiness/UI失敗時は旧bundleへ戻す。
- shared node_modulesはread-only。install/ci、live server/world/Ollama/UI/botの操作は通常の実装検証で行わない。実Minecraft確認は既存templateのCaseServer copy、loopback 25569/25570で行う。
- 現行の`vision` SDKのbotなしsignatureを維持し、余分なbot引数を黙って捨てる互換処理は作らない。Minecraftのmovement validationも維持する。

## Evidence

- [詳細調査と実測](../mindcraft-tools/docs/login-guard-invalid-rotation-20261006.md)。稼働source `04c52e7d3b4607e014589e0d90fdc8710aca9b4c`のCoder/interpreter/SDK docs/kick parserと隔離exportはSHA-256一致。
- 稼働記録の4回すべてで`vision.lookAtPosition(bot,...)`を実行している。Coder wrapperは先頭3引数だけ渡すので、botがX座標となる。
- 実サーバー再現: 有限な位置からNaNのyaw/pitchを持つ`look`を送信し、`invalid_player_movement`でkick。camera capture前に発生した。
- 隔離入力検証試作では誤callが失敗結果にsettleし、同じtaskで正しいcallが成功。不正packet/kickとも0。
- 現行parserはtyped NBTの`value.translate`をobjectのまま表示している。既存`prismarine-chat` 1.13.0のdecoderによる表示修正は実NBTと互換ケース計14確認で成功した。
- 試作差分: [candidate.patch](../mindcraft-tools/results/login-guard-20261006/candidate.patch)。設計例と実測の証拠であり、開発sourceには未適用。

## Next actions

- [x] `src/agent/vision/vision_interpreter.js`でenabled経路の座標をnumber/Number.isFiniteで検証し、bot.lookAtより前でrejectする。lookAtPlayerのname/direction検証と省略時atを保つ。SDK wrapper・chat commandの両callerに同じ検証を適用する。
- [x] `src/agent/library/sdk_capabilities.js`のvision説明へsignature/型/使用例を追記する。docsの先頭method名を変えず、SkillLibrary検索・Coderの既知method判定を保つ。
- [x] `src/agent/connection_handler.js`で既存`prismarine-chat`のdecoderを利用して理由を表示する。`handleDisconnection`と`agent.js`のcallerからbot.versionを渡し、decode失敗時はJSON/stringのfallbackを使う。既存分類・fatal属性を保つ。package.jsonにインストール済みversionをdirect dependencyとして明示する。
- [x] 固定fixtureをsourceへ追加する。実Coder/SESからの誤callがlookAt/captureに触れずsettleし、正しいcallを続けられることを確認する。実NBT/JSON/plain textのparser確認と既存分類確認も含める。READMEにSDKの正しいcall例と検証範囲を記す。
- [ ] Node 20 offline suiteと関連fixtureを実行する。exportした候補で今回と同じ隔離再現を行い、不正rotation packet/kick 0、正常call完了、template hash不変、owned processのcleanupを確認する。
- [ ] task変更のみをown originへcommit/pushする。live切替を明示依頼された場合は、テスト済みfull SHAの新bundleをprepareし、既存applyのbot-only readiness/rollback手順を使う。4bot readiness/UI応答に失敗した場合は旧bundleを復元する。server/world/Ollamaは切替対象外。

## Deferred work

renderer.dispose時のcancelAnimationFrame警告は今回のNaN送信後のcleanupで観測した別問題。今回の入力/表示修正から切り離し、正常shutdownでも再現する場合に別調査する。raw bot/pluginアクセス全般の入力検証やMineflayer共有依存の改造は、この原因の修正には不要。
