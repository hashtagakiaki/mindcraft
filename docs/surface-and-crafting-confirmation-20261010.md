# 地表復帰と作業台操作の確認 — 2026-10-10

## 原因と修正

稼働ログでは、地上復帰中に内側の移動が`false`でも`goToSurface`が`true`を返す組み合わせを37回確認した。旧実装は現在位置のx/z列で最高の非airブロックを探し、到着結果や足元の支持・頭上空間を確認していなかった。

`goToSurface`はdimensionの高さ範囲内で、近傍6ブロックの読み込み済み列から安全な立位候補を探す。支持床は一ブロック全体を覆う衝突形状があり、脚と頭は衝突形状のない安全なblockであることを要求する。候補には隣接して高さ差が1以内の立位列が必要で、到着後も実位置、支持床、脚・頭の空間、`onGround`、接続した隣接面を再確認する。これにより、縦穴一列の底を地表として扱わない。高さだけで降下を禁じず、既存の経路探索が接続した低い地表へ到達する場合は許容する。native navigationの採掘・設置制限を保ち、必要な通路は明示的なSDK操作で作る。

作業台を使う`craftRecipe`は、距離だけを見て移動後に作業台を開く経路を持っていた。23:57の作業台open timeoutで接続が`poisonedBots`へ登録された。00:02のチェスト操作は新しい5秒statistics fence timeoutではなく、約4msで`poisonedBots`によってsnapshotを拒否された。その拒否を受けたチェスト処理が`inventoryUnconfirmed`を立て、後続5操作がgateされた。修正後は選択した作業台へ`approachBlock`し、interactionが`ready`であることと、対象がまだ読み込み済みの作業台であることを確認してからだけ開く。blocked/unknown/対象変更ではfalseを返して窓を開かない。真の同期不確定時の保護と取消契約は維持し、2×2レシピ経路は変えない。

## 実測と検証

修正前の隔離CaseServerでは、作業台へのpath search timeout後もcrafting windowのopenを試み、`crafting window open timed out`となった。次のoak log 2個のチェスト預け入れはconfirmed quantityがunknownとなり、`inventoryUnconfirmed`が立った。同じ接続の次のクラフトも同期gateにより拒否された。記録は[`mindcraft-tools/results/dragon-fix-20261010/craft/baseline.json`](../../mindcraft-tools/results/dragon-fix-20261010/craft/baseline.json)に保存されている。

修正後のstone-pickaxe実測では、作業台へのinteraction approachがblockedとなってfalseを返し、`inventoryUnconfirmed`は立たなかった。同じ接続でoak log 2個をチェストへ正確に預けた後、隔離fixtureのtrusted setupで作業台の遮蔽を解いてbotを移動し、stone pickaxeのクラフトを成功させた。独立したobserverでもstone pickaxe 1個、チェストNBTでもoak log 2個を確認した。PID・loginは同じで、spawnは1回、connection endは0回だった。さらに、別の同一接続試験ではblockedな作業台でstone pickaxe作成をfalseで止め、チェストへのoak log 2個の預け入れを確定した後、console介入なしで2×2 stickレシピを成功させた。プレイヤー側数量は2から6となり、cobblestone 3個は維持された。詳細は[`craft/fixed.json`](../../mindcraft-tools/results/dragon-fix-20261010/craft/fixed.json)と[`craft/followup.json`](../../mindcraft-tools/results/dragon-fix-20261010/craft/followup.json)を参照。

`tests/run-tests.cjs --interaction-confirmation-only`は、ready/blocked/unknown/変更された作業台、取消、2×2経路を確認する。`tests/surface_navigation.test.cjs`は地表候補、通行失敗、取消、縦穴だけの候補除外、隣接する高低差のある地表、到着後の立位確認を確認する。task-only exportのNode 20 aggregate suiteはsurface geometry最終調整前に全fixtureが通過し、その後の最終geometry更新ではsurface fixtureと`skills.js`構文確認を再実行して通過した。最初のGoals live runでは縦穴底を地表と誤認する可能性が見つかったため、そのrunは成功根拠にせず、隣接する立位面の確認を追加して再実行した。

最終Goals runは26 thread turns・25 accepted operationsで`status: complete`となった。`goToSurface`が近傍に接続した安全面を見つけられなかった後、botは明示SDK操作で石を掘り、出口を横へ作って実際に通過した。11地点の掘削後blockはすべてairだった。最終位置は`(-245.50, 70, -110.47)`、足元支持はy=69のgrass block、脚・頭はair、`onGround: true`。元のroofより低い連続草地へ出たため、高さ上限で候補を除外せず、隣接面の接続で判定する必要も確認できた。記録は[`surface/live-result.json`](../../mindcraft-tools/results/dragon-fix-20261010/surface/live-result.json)と[`surface/live-goal-connected-final.log`](../../mindcraft-tools/results/dragon-fix-20261010/surface/live-goal-connected-final.log)にある。隔離実測は読み込み済みの近傍地形に限られ、すべての地形やルートの到達性を保証するものではない。

この実測は既存world templateの隔離コピーだけを使い、manual play、共有dependency、稼働中server/worldを変更していない。記録は[`dragon-fix-20261010`](../../mindcraft-tools/results/dragon-fix-20261010/)配下にあり、実行時刻・server/client log、template hash、cleanup結果を含む。
