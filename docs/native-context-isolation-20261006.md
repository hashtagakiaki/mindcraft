# native bot contextのglobal/multi-agent分離 — 2026-10-06

source `c02dc0237f98de4d99a506578bc9226f7702feaf` の[前回修正](native-context-revision-20261006.md)に残ったグローバル開発AGENTSとmulti-agent指示を除いた。installed CLI 0.160.1の隔離app-serverで確認し、稼働playのpinやbotを変更していない。

この文書はsource `b80e1771c70b2a29e1e6aafd11ea11621177d292` の記録。SDK method名一覧の追加と探索方法の変更は[後続のSDK比較](native-sdk-catalog-20261006.md)に記録する。

## 実装と配送範囲

`CodexSession` が専用cwd内に0700の一時 `CODEX_HOME` を作る。元の `CODEX_HOME`（未指定なら `~/.codex`）から `auth.json`、`config.toml`、`sessions/` だけをsymlinkで参照する。グローバルAGENTS、AGENTS.override、skills、plugins directoryは共有しない。グローバル設定・AGENTSを編集せず、認証内容を読出し・複製しない。file認証をprocess限定の `cli_auth_credentials_store="file"` で利用する。keyringだけの認証はこの経路の対象外。

認証の通常writeはsymlink先へ届き、保存rolloutは元のsessions directoryに残る。終了時は既存owned helperのprocess回収後に専用cwd/homeを削除する。file backendの書込共有と、一時home削除後の再開をoffline fixtureで確認した。期限切れOAuthの実refreshは今回の実測範囲に含めない。

bot固定指示は従来の `src/process/codex/AGENTS.md` をcwdへ配置し、標準workspace loaderで読む。baseInstructionsやdeveloperInstructionsを独自置換せず、既定workspace access、遅延SDK、画像tool result、read-only sandbox、shell無効、Minecraft以外のtool拒否を維持する。

multi-agentは従来の `features.multi_agent=false` に加え `agents.enabled=false` を設定する。後者で実rolloutの `<multi_agent_role>` と `<multi_agent_mode>` が消えた。context protocolを4へ更新し、旧指示が保存されたthreadは一度新規化する。以後は通常のscope付き再開を使う。

## 判断した実験

証拠は `../../mindcraft-tools/results/context-isolation-20261006/` に保存した。設定受理だけでなく実rolloutの本文とinstructionSourcesで判定した。

- `agents.enabled=false` はstrict-config受理後に説明文も消えた。
- `user_instructions=""` はstrict-configでunknown fieldになった。
- `project_doc_max_bytes=0` はproject側AGENTSだけを止め、global AGENTSを残した。
- `environments=[]` でもglobal AGENTSは残った。標準workspace accessを外すため採用しない。
- `instructions=""` でもglobal AGENTSは残った。baseの置換は目的に含めない。
- bundled bwrapのprocess内ファイルmaskはuid map Permission deniedで使えなかった。
- 専用CODEX_HOMEではinstructionSourcesがcwdのbot AGENTS一件になり、global AGENTSとmulti-agent本文が消えた。標準baseは18,037文字のまま、bot本文は一度だけ入った。

## context内訳

実runtime/History/SDK/owned helperと同じ採取済み依頼・memoryを使用した。executorはsyntheticでMinecraftへ接続していない。before/afterは同じfixtureのsession配送とprotocolだけを変えた各1回の試行。文字数はrolloutの初回に見えるbaseとdeveloper/user textの合計で、tool schemaやprotocolのtokenを含む完全な内訳ではない。本文は文書の文字数、wrapperは残差で分類した。

| 内容 | 分離前 | 分離後 |
|---|---:|---:|
| 標準base | 18,037 | 18,037 |
| グローバル開発AGENTS | 6,236 | 0 |
| bot固定指示 | 5,406 | 5,406 |
| skill機構・permissions等 | 1,757 | 1,757 |
| multi-agent説明 | 2,702 | 0 |
| AGENTS wrapper・環境枠 | 552 | 530 |
| runtime初回入力 | 2,692 | 2,691 |
| visible text合計 | 37,382 | 28,421 |
| 初回推論input tokens | 12,661 | 9,493 |

二つの本文で8,938文字を除き、初回input tokensは約25%減った。runtimeの1文字差は可変値によるもの。標準baseとskill機構・permissionsは残る。SDK以外のnative registry entriesも完全に除去したとは扱わない。

beforeはチェスト0件まで報告した。afterは位置・在庫・耐久を報告したが、未存在の `world.findBlocks` を使用しチェスト検索を未確認と報告した。host task終了は両方successだったが、afterの依頼全体の達成とは区別する。所要時間はbefore 67.0秒、after 163.0秒で改善していない。初回contextの削減を示す比較であり、実ゲームの成功率・速度・累積tokenの改善保証には使わない。

## 検証

新規と再開の実CLI taskで、SDK説明にだけある必須引数を読み、synthetic executorで検証した。画像内の `K7R2` と緑色を報告し、再開後も保持できた。新規/再開ともbot AGENTSだけを読んだ。データは `final-image-resume.json` と対応rolloutに保存する。

Node20のnative fixtureと既定offline suite、`node --check main.js`、`git diff --check`を通した。fixtureはglobal指示を置いた元homeとの分離、共有する三つのpath、file認証更新、専用home削除後のthread再開、再開時のbot指示更新を確認する。既存のSDK/tool待機・画像・停止・rules・scope確認を維持した。

設定仕様の参考は[公式config reference](https://learn.chatgpt.com/docs/config-file/config-reference)と[AGENTS読込](https://learn.chatgpt.com/docs/agent-configuration/agents-md)。今回の効果はinstalled-versionの実rolloutを証拠とする。
