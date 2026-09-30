# 採掘時間と採掘失敗の調査（2026-09-30）

## 結論

鉄鉱石などの採掘時間の誤計算と、サーバーで壊れていないブロックを完了扱いする処理を確認した。追加調査では、通常の採掘スキルが途中のブロックを掘って地下へ到達できること、落下中に固定された採掘待ち時間が`unstuck`判定と衝突することを確認した。調査のみで、実装・依存・稼働bundleの変更は行っていない。

対象はMinecraft Java 1.21.1、稼働source pin `fc53dae41f893cfaaaf6ada9b75a68d95e81255a`、共有依存Mineflayer 4.39.0 / prismarine-block 1.23.0 / minecraft-data 3.117.0 / mineflayer-tool 1.2.0 / mineflayer-collectblock 1.6.0。将来のバージョンの保証ではない。

## 1. 鉱石の速度分類が誤っている

依存の`minecraft-data`で鉄・銅・金・ダイヤ・レッドストーン・ラピス・エメラルド鉱石、黒曜石などのmaterialが`incorrect_for_wooden_tool`になっている。`prismarine-block.digTime()`はこのmaterialで道具の速度倍率を検索するが、石以上のツルハシのIDがなく、速度1へフォールバックする。

水中ではなく接地し、エンチャント・効果がない場合の実際の依存コードによる計算:

| ブロック | 道具 | 現状 | materialだけを`mineable/pickaxe`にした計算 |
|---|---|---:|---:|
| iron_ore | stone_pickaxe | 4550 ms | 1150 ms |
| iron_ore | iron_pickaxe | 4550 ms | 750 ms |
| iron_ore | diamond_pickaxe | 4550 ms | 600 ms |
| deepslate_iron_ore | stone_pickaxe | 6750 ms | 1700 ms |
| deepslate_iron_ore | diamond_pickaxe | 6750 ms | 850 ms |
| obsidian | diamond_pickaxe | 75000 ms | 9400 ms |

これにより、サーバーが計算するひび割れ進捗に比べて、botが採掘終了パケットを送るまでの待ち時間が長くなると説明できる。今回、画面のアニメーションそのものは録画・計測していない。

既存の[Mineflayer patch](../patches/mineflayer+4.33.0.patch)には同じmaterialを書き換える処理があるが、現在使っている4.39.0の`digging.js`にはその処理がない。また、`bot.digTime()`だけを直しても、`block.digTime()`を直接呼ぶtool/pathfinder側は別に確認が必要。

道具選択も速度差を失う。ただし「木と石を持っていると木を選んで鉄採掘を拒否する」という初期仮説は、実際のToolクラスで否定された。木は採取不可の倍率も適用され7500 ms、石は4550 msとなり石が選ばれた。

上流にも同じデータ生成問題の報告がある: [minecraft-data-generator #52](https://github.com/PrismarineJS/minecraft-data-generator/issues/52)、[minecraft-data #1076](https://github.com/PrismarineJS/minecraft-data/issues/1076)、[Mineflayer #3921](https://github.com/PrismarineJS/mineflayer/issues/3921)。今回の判定はローカルにインストールされたコードと実測を根拠にしている。

## 2. 到達できなくてもクライアント側だけで完了する

Mineflayerの`digging.js`は待ち時間後に終了パケットを送った直後、`bot._updateBlockState(block.position, 0)`でローカルのブロックを空気にする。このローカル更新が`diggingCompleted`を発火し、`await bot.dig()`を成功として終了する。サーバーの破壊確認を待たない。

[collectBlock](../src/agent/library/skills.js)はプラグインのcollectが例外なく戻れば成功数を増やす。依存のcollectblockはgoto後に実座標からの到達距離を再確認せず`bot.dig()`を呼び、アイテムが増えたことも必須にしない。したがって破壊も回収も成功したとは限らない。

既存raw-iron templateの隔離コピー、loopback 25569での再現。この初回試験は`Movements.canDig=false`のgotoと直接のdigであり、通常の採掘スキル全体を実行したものではない:

- `GoalLookAtBlock`へのgotoが戻った後、botの実座標は約`(-49.434,72,-50.357)`、対象は`(-50,67,-51)`。
- 目の位置からブロック中心まで6.152ブロック、`bot.canDigBlock(block)`はfalse。それでもdigは開始した。
- 開始0 ms、終了パケット4550 ms、`diggingCompleted`4551 ms。botの観測はairになった。
- サーバーconsoleの`execute if block ... minecraft:iron_ore`で鉱石の残存を確認。サーバー在庫も石ツルハシ1本のまま。
- 同じコピーの1段上の鉱石`(-50,68,-51)`は、materialだけを一時変更した呼び出しで終了パケット1175 ms、サーバーのair更新1226 ms、consoleでもairを確認した。下の鉱石は残った。

後者は別の高さの対象なので、前者との比較を「同条件で修正後に採掘成功」とは扱わない。また、raw ironが在庫に入らなかったことだけで破壊失敗とは判定せず、サーバーのブロック状態を確認した。

追加の依存コード調査で、pathfinder 2.4.5の`lib/goto.js`が`path_update`の空経路を受け取ると、statusより先に成功としてresolveすることを確認した。実際のgoto関数とEventEmitterによる最小再現では、`noPath` / `timeout` / `partial`と空配列の組み合わせがすべて`goal_reached`なしで成功になった。非空経路の`noPath` / `timeout`は例外になる。これは到着前に採掘処理へ進める具体的な不具合。ただし初回試験はpath_updateを記録していなかったため、その試行でどのstatusが成功扱いされたかまでは確定できない。

## 3. 途中のブロックを掘って進めるか（追加調査）

通常の`mineflayer-collectblock`は`Movements.canDig=true`。経路の`toBreak`に障害物を記録し、pathfinderが道具を選んで順番に掘る。初回試験のタイムアウトを「通常設定でも掘って近づけない」証拠として扱ったのは不適切だった。

同じraw-iron templateから毎回新しいコピーを作り、pinned sourceの実際の`skills.collectBlock(bot, 'iron_ore', 1)`で比較した。開始位置は約`(-52.026,72,-58.084)`、初期在庫は石ツルハシ1本、選ばれた鉱石は`(-53,64,-58)`。自動行動モードを動かさず採掘スキルを比較:

| 条件 | 掘った経路上のブロック | 結果 | サーバー在庫のraw iron |
|---|---|---|---:|
| 通常のcanDig=true | 草1、土3、石3 | 約31.13秒でcollect成功、対象はair | 1 |
| collectblockのcanDigだけfalse | なし | 約13.82秒で経路探索timeout、対象はiron_ore | 0 |

したがって、この地形では「間を掘って近づけばよい」は既存実装で成立する。別の対象を選ぶ処理の追加を、この試験から必要とは判断しない。

稼働playの過去Bot3履歴にも鉄採掘時の`Timeout: Took to long to decide path to goal!`は存在する。A*の既定thinkTimeoutは5000 msで、探索時間の上限であり、採掘スキル全体の時間制限とは別。今回、canDig=trueの比較ではそのtimeoutを再現していないため、過去のtimeoutの個別原因は未確定。

## 4. 落下中の採掘開始とunstuckの衝突

通常設定の経路では足元を掘って下へ進み、最後の石を壊して落下し始めた位置`y≈65.922`でgoal_reachedが発火した。その直後に対象鉱石のdigを開始する。

Mineflayerはdig開始時に`!bot.entity.onGround`を使って待ち時間を一度だけ計算する。空中の5倍ペナルティが入って22500 msになり、着地しても再計算しない。速度分類の誤りがなければ石ツルハシの空中計算は5650 ms、接地後は1150 ms。

同じ開始位置・道具・鉱石、毎回新規コピーでの比較:

| 条件 | 鉱石dig開始のonGround | 鉱石の計算／実測待ち時間 | スキル全体 | サーバー結果 |
|---|---|---:|---:|---|
| 通常スキル、自動モードなし | false | 22500 / 22500 ms | 31089 ms | air、raw iron 1 |
| 対象鉱石のdig前だけ接地を待つ | true | 4550 / 4551 ms | 13311 ms | air、raw iron 1 |
| 通常スキル＋既存unstuck判定 | false | 22500 ms予定、20346 msで中断 | 28626 ms | iron_ore、raw iron 0 |

接地待ちは診断ラッパー内で最大10 physics ticksとし、それ以外の速度データや移動設定は変えていない。これは修正方針を検証する実験で、稼働コードへの変更ではない。

unstuck試験はpinned sourceの`initModes`を使い、300 ms周期で実際の判定を動かした。他の自動モードは無効。既存の20秒閾値が採掘中に発火した時点で、mode actionを診断stubへ渡し、digを中断した。脱出移動そのものとLLMの再計画は実行していない。結果は`Digging aborted`、collect=false、サーバーの鉱石残存。発火時にはすでにonGround=trueだった。

稼働playの過去Bot3履歴にも`action:collectBlocks`がunstuckで中断された記録が複数ある。ただしそれぞれの過去試行が落下中の採掘開始だったことまではログから確定できない。

今回実証した失敗の仕組みは、「掘って近づく処理は動くが、落下中に誤った速度データで長い待ち時間が固定され、採掘中の静止をunstuckが停止として扱う」。

## 検証範囲と記録

- 実際の依存コードで速度計算とTool選択を実行した。
- `mindcraft-eval`の既存CaseServer / CaseSessionを使い、raw-iron templateをコピーして隔離検証した。template・共有依存・server jarは変更していない。専用serverは終了済み。
- 私用の再現スクリプト・パケット時刻・console確認はevalのignored `results/mining-investigation/20260930/`内。`probe-authoritative.log`がサーバー状態を確認したrun。生成ログや会話をこのrepoへ追加しない。
- 追加比較はignored `results/mining-investigation/20260930-routing/`内。`routing-live.log`がcanDig比較、`routing-timing.log`が落下・接地・unstuck比較。runtimeはmanifest pinからexportし、共有依存へread-only symlinkを作成した。自動モード・UI・LLMを含む全体起動試験ではない。初回の誤った測定範囲を上の第2・3節で訂正した。
- ユーザーの許可で稼働Bot3へ診断を指示したが、LLM生成コードのAPI誤用と中断のため有効な比較は取れなかった。採掘自体は実行され、最後の状態確認ではraw ironが15→16個、位置が約`(32.5,59,-299.3)`になっていた。長い結果のwhisper送信で`disconnect.spam`を受け自動再接続した。最後に4botすべてIdleとUI接続を確認した。この試行を採掘時間の比較や破壊失敗の証拠とはしない。
- 既存craft/farm offline suiteは成功。採掘の実装を修正したという意味ではない。

## 最小の修正方針（未実装）

1. botごとの採掘速度データを補正し、dig・tool選択・pathfinderが同じ正しい速度を使う。共有node_modulesの編集や依存全体の更新を回避する。
2. gotoの空経路を成功扱いする不具合を是正し、実位置で距離・視線・対象の現在状態を確認する。落下中に到着しても、接地を確認してから採掘時間を決める。
3. サーバーの破壊確認後に成功とし、collectではアイテム取得も区別して検証する。unstuckは進行中の正当な採掘待ちを停止と誤認しないようにする。
4. 途中を掘る既存のcanDig=trueは維持する。到達不能の別候補への切り替えは、実際に経路が作れないケースの原因を確認した後に必要性を判断する。

修正の検証では、同じ条件の鉄鉱石について開始・終了・サーバーair更新・回収を記録し、距離外の対象で成功扱いしないことも確認する必要がある。
