# PLAN.md レビュー

レビュー日: 2026-11-06（JST）

- 対象: `PLAN.md`「移動処理の再設計」
- 照合した実装: `autonomy` / `00f1fe60e9221b6f1a9e69cd8aacb831b11db624`
- 対象PLANのSHA-256: `bce20fa160db15255472137f4003e3da487d2579492b53bcb6ab71387c23edaa`

## 判定

**実装前に計画の修正が必要。** 経路方針・実行器・危険脱出の共通化と、浅い水で過剰な復旧探索を始めない方向は妥当。ただし、継続追従と保護区画の公開契約に矛盾があり、新しい脱出探索の成立条件にも未確定部分がある。指摘はP1が2件、P2が3件。

## 指摘

### 1. [P1] 継続追従を「到着で終了・全体180秒」の実行器へそのまま移せない

**対象:** PLAN 21〜24行、37行。

計画は静的目的地・追従・戦闘・退避を同じ実行器へ集約し、終了を `goal.isEnd`、全体上限を180秒としている。一方、`followPlayer` の公開契約は「中断まで追従」であり、既に近くにいる場合も監視を続け、相手が再び離れれば移動する。単純な置換では最初の接近で終了するか、正常な追従を180秒で打ち切る。

さらに現在の追従・戦闘・退避は `goToGoal` を経由せず、動的goalやPVP pluginが直接pathfinderを操作する。これらをそのまま残すと、新しい `navigate` 内の危険監視が適用されない。

**修正案:** 1つの実行器を維持しつつ、単発到着と継続追従の終了条件、goal更新、時間予算の適用単位を明記する。PVPを含めた移動goalの所有者を決める。既存fixtureで「追従範囲内で待機→相手が移動→追従再開→取消」と、その途中の危険脱出を確認する条件を加える。

**根拠:** [native_sdk.js](src/agent/library/native_sdk.js#L124)、[followPlayer](src/agent/library/skills.js#L4914)、[戦闘のPVP起動](src/agent/library/skills.js#L1280)、[戦闘のgoal更新](src/agent/library/skills.js#L1306)、[退避のgoal更新](src/agent/library/skills.js#L5078)。

### 2. [P1] 危険脱出時の保護区画無視が、公開契約維持と矛盾する

**対象:** PLAN 25行、37行。

`escapeHazard` の「保護範囲より生存を優先する」は、現行の `places.protectArea` が明記する「危険脱出を含め経路の掘削・足場設置を禁止する」という契約を変更する。一般的な地形保全方針を緩めることと、利用者が明示的に登録した保護区画を無視することは、現行APIでは別の扱いである。計画の「native SDKの公開契約を保つ」と両立していない。

**修正案:** 公開契約維持を採るなら、通常の編集制限を緩める脱出中も明示的な保護区画は維持する。保護区画の意味自体を変える意図なら、それを仕様変更として明示し、`protectArea` の遅延文書・既存fixture・通常経路への復帰条件まで変更範囲に含める。計画中の矛盾を残したまま実装側の推測に委ねない。

**根拠:** [protectAreaの公開契約](src/agent/library/native_sdk.js#L194)、[探索側の拒否](src/vendor/mineflayer-pathfinder/lib/movements.js#L275)、[実行側の拒否](src/agent/library/navigation_policy.js#L304)。

### 3. [P2] `partial` を移動区間の確定と扱う前に、探索継続と空経路を定義する

**対象:** PLAN 23行、25行。

既存A*の `partial` は、1回の計算時間を使い切ったことを表し、進める端点が得られたことを保証しない。返却経路はheuristicが最良のノードまでであり、開始位置からheuristicが改善しなければ空になる。脱出先を座標指定せず条件だけで判定する新goalでは、heuristicの定義が必要になる。例えば `heuristic=0` で正しく探索しても、途中の `partial` は空経路になる。

この状態で探索を破棄して最初から再探索すると、到達可能でも同じ範囲だけを繰り返し探索して失敗し得る。計画には、新goalのheuristic、空のpartial、同じA*状態を継続する条件がない。

**修正案:** 時間分割によるpartialと実際に移動する区間の確定を区別する。空のpartialでは同じ探索を継続し、event loopへ戻して浮上入力・取消を処理する。探索予算切れと探索完了による経路なしも区別する。既存generatorを再利用できる。

**根拠:** [AStar.compute](src/vendor/mineflayer-pathfinder/lib/astar.js#L68)、[bestNode更新](src/vendor/mineflayer-pathfinder/lib/astar.js#L113)、[getPathFromTo](src/vendor/mineflayer-pathfinder/index.js#L82)。後述の小実験で、空のpartialから同じ探索を継続すると成功することを確認した。

### 4. [P2] 脱出探索の「半径32」は距離制限として実装方法を指定する

**対象:** PLAN 25行。

既存pathfinderの `searchRadius` は空間的な半径ではなく、`開始時heuristic + searchRadius` のコスト上限である。新しい脱出探索にそのまま32を渡すと、数ブロック以内でも掘削コストで候補を除外する。現実装はこの問題を避けるため、採掘可能な探索には `searchRadius=-1` を渡している。

**修正案:** 半径32をノード座標の制限として扱い、掘削コストと分離することを計画に明記する。既存fixtureに、短距離だが掘削コストが32を超える脱出経路を含める。上限到達を `route_not_found` と誤分類しない。

**根拠:** [A*のmaxCost](src/vendor/mineflayer-pathfinder/lib/astar.js#L52)、[コストによる枝刈り](src/vendor/mineflayer-pathfinder/lib/astar.js#L96)、[既存pathSearchCostCap](src/agent/library/skills.js#L3516)。後述の小実験でも2ノードの経路がコスト制限だけで `noPath` になることを確認した。

### 5. [P2] 足場未確認後の再探索を、受入条件と外側の結果処理まで含める

**対象:** PLAN 26行、31〜37行。

未確認の足場設置後に続行する変更は、主要な改善点として挙げられているが、受入条件に対応するケースがない。現状は実行中のdig/place/equipゲートだけでなく、外側の `runWithNavigationPolicy` も `unconfirmedScaffolds` が残れば終了時に例外を投げる。内側のpathをresetするだけでは、再探索で目的地へ着いてもSDK呼び出し全体は失敗する。

**修正案:** 未確認という試行履歴と、現在も操作を止める未解決状態の扱いを定義し、外側の結果処理まで変更対象に含める。既存fixtureで少なくとも「1回未確認→観測から再探索→到着時の結果」と「同じマスで失敗を反復→無進捗で終了」を確認する。取消時には再探索や次の編集を始めないことも、該当fixtureの条件に含める。未確認の編集を確認済みと報告してはならない。

**根拠:** [終了時の例外](src/agent/library/navigation_policy.js#L247)、[装備・掘削のゲート](src/agent/library/navigation_policy.js#L289)、[設置のゲート](src/agent/library/navigation_policy.js#L317)。

## 確認した範囲と限界

- PLAN、開発指示、READMEの移動関連契約、SDK、skills、modes、navigation policy、pathfinder fork、関連fixtureを静的に照合した。
- 既存Node 20から実際の `lib/astar.js` を読み込み、使い捨ての3ノード・2辺のグラフで以下を確認した。実Minecraftの地形・物理を再現した検証ではない。

| 確認 | 結果 |
|---|---|
| 1辺コスト23、2辺、`heuristic=0`、`searchRadius=32` | `noPath` |
| 同じグラフ、`searchRadius=-1` | `success`、経路長2 |
| `heuristic=0`、1ms単位で分割する探索の初回 | `partial`、経路長0 |
| 同じ探索インスタンスを継続 | `success`、経路長2 |

- PLANに記載されたbot死亡記録・失敗回数は再集計していない。新設計が実地形で脱出できることも未検証であり、上記の実験で証明したとは扱わない。
- この作業はレビュー文書の追加のみ。PLANと実装は変更せず、offline suite・隔離server・manual playへの反映は実行していない。
