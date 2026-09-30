# 採掘時間と採掘失敗の調査（2026-09-30）

## 結論

鉄鉱石などの採掘時間の誤計算と、サーバーで壊れていないブロックを完了扱いする処理を確認した。経路探索のタイムアウトも再現した。調査のみで、実装・依存・稼働bundleの変更は行っていない。

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

既存raw-iron templateの隔離コピー、loopback 25569での再現:

- `GoalLookAtBlock`へのgotoが戻った後、botの実座標は約`(-49.434,72,-50.357)`、対象は`(-50,67,-51)`。
- 目の位置からブロック中心まで6.152ブロック、`bot.canDigBlock(block)`はfalse。それでもdigは開始した。
- 開始0 ms、終了パケット4550 ms、`diggingCompleted`4551 ms。botの観測はairになった。
- サーバーconsoleの`execute if block ... minecraft:iron_ore`で鉱石の残存を確認。サーバー在庫も石ツルハシ1本のまま。
- 同じコピーの1段上の鉱石`(-50,68,-51)`は、materialだけを一時変更した呼び出しで終了パケット1175 ms、サーバーのair更新1226 ms、consoleでもairを確認した。下の鉱石は残った。

後者は別の高さの対象なので、前者との比較を「同条件で修正後に採掘成功」とは扱わない。また、raw ironが在庫に入らなかったことだけで破壊失敗とは判定せず、サーバーのブロック状態を確認した。

gotoが実位置と食い違う詳細な経緯は未特定。確認できたのは、gotoの終了だけを採掘可能の根拠にできず、現在の実位置では届かない採掘が成功扱いされること。

## 3. 経路探索の失敗

隔離コピーで近い鉱石へのgotoが複数回`Timeout: Took to long to decide path to goal!`を返した。稼働playの過去Bot3履歴にも鉄採掘時の同じエラーがある。鉱石検索は周囲64ブロックの対象を見つけるが、露出・到達可能を保証しない。これは採掘速度の誤計算とは別の失敗。

## 検証範囲と記録

- 実際の依存コードで速度計算とTool選択を実行した。
- `mindcraft-eval`の既存CaseServer / CaseSessionを使い、raw-iron templateをコピーして隔離検証した。template・共有依存・server jarは変更していない。専用serverは終了済み。
- 私用の再現スクリプト・パケット時刻・console確認はevalのignored `results/mining-investigation/20260930/`内。`probe-authoritative.log`がサーバー状態を確認したrun。生成ログや会話をこのrepoへ追加しない。
- ユーザーの許可で稼働Bot3へ診断を指示したが、LLM生成コードのAPI誤用と中断のため有効な比較は取れなかった。採掘自体は実行され、最後の状態確認ではraw ironが15→16個、位置が約`(32.5,59,-299.3)`になっていた。長い結果のwhisper送信で`disconnect.spam`を受け自動再接続した。最後に4botすべてIdleとUI接続を確認した。この試行を採掘時間の比較や破壊失敗の証拠とはしない。
- 既存craft/farm offline suiteは成功。採掘の実装を修正したという意味ではない。

## 最小の修正方針（未実装）

1. botごとの採掘速度データを補正し、dig・tool選択・pathfinderが同じ正しい速度を使う。共有node_modulesの編集や依存全体の更新を回避する。
2. goto後の実位置で距離・視線・対象の現在状態を確認し、サーバーの破壊確認後に成功とする。collectではアイテム取得も区別して検証する。
3. 到達不能の対象は同じ試行中に除外し、別の候補を選ぶ。近傍検索で見つかったことを到達可能と解釈しない。

修正の検証では、同じ条件の鉄鉱石について開始・終了・サーバーair更新・回収を記録し、距離外の対象で成功扱いしないことも確認する必要がある。
