# native SDK名前一覧の比較 — 2026-10-06

source `b80e1771c70b2a29e1e6aafd11ea11621177d292` の[context分離](native-context-isolation-20261006.md)を基準に、method名の先頭3件ずつの探索を、常時見える名前一覧へ置き換えた。

## 実装

`createSdkDocumentation()` が既存SDK文書のmethod名から一覧を自動生成する。同じMapからnative tool registryと名前一覧を作るため、一覧の手書きや別indexは不要。74メソッドの名前だけで1,487文字、headerを含むcatalogは1,533文字。説明本文・引数・例は引き続きnative registryの `deferLoading: true` と説明toolに保持する。

`CodexSession` は固定templateとcatalogを専用cwdのAGENTSへ一度書き、標準loaderで読む。新規と再開のどちらでも当該SDKの一覧を配置する。初回turn/tool resultごとの重複挿入はしない。名前から説明toolへ直接進めるよう、templateとnamespaceの案内を更新した。context protocol 5で旧探索指示を保存したthreadを一度新規化する。base、global指示分離、native実行、画像、所有helper、規約更新は従来のまま。

## 比較

installed CLI 0.160.1、gpt-6-luna / medium、実runtime/History/SDK/owned helperを使用した。executorはsyntheticでMinecraftへ接続していない。両条件は同じ採取済みBot2の依頼・memory・位置/在庫/チェスト0件のfixtureを使い、今回のsession/catalog/template/protocolの差分だけを変更した。各条件1回。

データは `../../mindcraft-tools/results/sdk-catalog-20261006/` の `comparison.json`、before/afterのresult・task trace・rolloutへ保存した。model tool呼出しにはfunction_callとcustom_tool_callの両方を含める。名前探索はALL_TOOLSの名前を絞るexec呼出し数で、一つのexec内の複数filterを別回数にしない。

| 指標 | 名前探索 | 常時名前一覧 |
|---|---:|---:|
| 初回推論input tokens | 9,487 | 9,847 |
| 最終推論input tokens | 13,990 | 11,895 |
| 初回visible text文字数 | 28,422 | 29,934 |
| 名前探索exec呼出し | 6 | 0 |
| model tool呼出し | 10 | 2 |
| 説明tool読込 | 4 | 0 |
| 選択したregistry説明の取得 | 0 | 1回・4メソッド |
| ゲーム操作 | 1 | 1 |
| 累積input / cached input tokens | 123,034 / 102,912 | 32,791 / 18,944 |
| 所要時間 | 60.0秒 | 19.4秒 |

初回の負担は360 tokens増えたが、この試行では探索の往復がなくなった。名前一覧条件は `world.getPosition`、`world.getInventoryCounts`、`world.getNearestBlocks`、`world.inspectBlockAt` の4メソッドを指定してregistry説明を一度だけ取得し、正しい `getNearestBlocks(bot, ['chest', 'trapped_chest'], 16, 3)` を実行した。説明tool呼出しが0でも、説明を読んでいないわけではない。全SDK説明のdumpはしていない。

両条件とも位置・在庫・耐久とチェスト候補0件を報告し、operation結果はsuccessだった。名前探索条件は近傍ブロック検索を見つけず、相対座標で多数のブロックを読む実装になった。名前一覧条件は既存の近傍検索を選べた。前回の未存在 `world.findBlocks` は今回の一覧条件では使用しなかった。

名前の可視化によって正しい方法を選びやすくなった結果として採用する。小さいsynthetic fixtureの各1回であり、名前一覧だけで常に同じ説明取得経路を選ぶことや、実ゲームの速度・成功率が同じ割合で改善することは保証しない。今回の条件差には案内文の変更も含まれる。短い用途説明の追加は行っていない。

## 検証

最終sourceの実CLIで、新規/再開ともSDK説明だけにある必須引数を読みsynthetic executorへ渡せた。画像の `K7R2` と緑色も新規・再開後とも正しく報告した。global AGENTSとmulti-agent本文はなく、初回の一覧は一度だけ入った。`final-image-resume.json` と対応rolloutが証拠。

offline native fixtureは、名前一覧に説明本文が混入しないこと、registryの説明がdeferredのまま残ること、AGENTSへ一覧が一度だけ配置されること、再開時の一覧復元、未存在methodが説明にないことを確認する。Node20の既定offline suite、`node --check main.js`、`git diff --check`を通した。

稼働playのpin、4bot、Minecraft server/world、Ollamaは変更していない。
