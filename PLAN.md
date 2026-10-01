# PLAN

Goal: After this change, botが拠点・畑・チェスト・林・村・鉱山などの場所を用途と確認履歴付きで保存し、再起動やruntime bundle切替後も、4体で情報を共有して目的に合う場所を再利用できる。

Acceptance criteria:
- ユーザーの「ここを拠点として覚えて」「この畑の収穫物はこのチェストへ」で、観測座標または明示された座標と関係を保存できる。
- 名前・用途から現在のworld/dimensionの場所を検索でき、会話モデルとnewActionの両方が同じplace IDを使える。
- 畑をモデルが選択した後、実行器が畑のoutput_storage参照を解決し、対象畑と対象チェストを既存farm skillへ渡す。未登録の場合は候補調査と下記選択規則を使う。
- botが保管先を選んで収納を確認した場合に関係を保存する。明示された関係を自動観測で上書きしない。
- bot子プロセス再起動、親プロセス再起動、load_memory=falseの通常起動でも保存済み場所を復元する。
- 同じworldの新bundleは同じ場所台帳を使用する。別world namespaceでは場所・関係・個人設定を混ぜない。
- 4体の同時更新が欠落せず、別botの登録を検索できる。個人のhomeとlast_death_positionは他botの個人設定を上書きしない。
- dimension不一致の移動を拒否する。対象消失、未ロード、到達失敗を区別し、移動成功だけで対象の存在や作業成功を報告しない。
- !rememberHere(name)、!goToRememberedPlace(name)、!savedPlacesの既存引数と用途を保つ。通常の座標指定farm skill呼出しも保つ。
- 稼働40973/8098、4bot、world、Ollamaを設計・開発検証で操作しない。実装完了と実際のactivationは区別する。

Constraints:
- 今回は設計のみ。変更はこのPLAN.mdだけ。実装・deploy・bot切替・world操作を行わない。
- source ownerはhashtagakiaki/mindcraft、branch autonomy。own originだけへcommit/pushする。eval変更はhashtagakiaki/mindcraft-evalの別commitで管理する。
- upstream、共有node_modules、credentials、ユーザーworldはread-only。場所台帳・会話・runtime生成物はGitに含めない。
- 既存Socket.IO、Node標準fs/crypto、既存移動・farm skillを再利用する。新DB、HTTPサービス、依存パッケージは追加しない。
- 調整値（検索件数、候補距離、確認猶予、通信timeout）は名前付き定数または設定にする。
- README/SPECは挙動・使用方法変更時に更新し、設定パス・禁止事項が変わる実装commitではAGENTSも更新する。

Out of scope:
- 全地形マッピング、厳密なポリゴン、経路キャッシュ、ポータル網、自動dimension移動。
- チェスト内容の常時同期、全資源の網羅登録、常時巡回、作業予約やbot間の分担scheduler。
- 過去の会話要約から座標を推測して自動移行すること。RAMだけにある現行bookmarkの復旧保証。
- システム設定・production・Minecraft server設定の変更。既存world/template内への識別ファイル配置。

Context:
- 読取時点のsource HEADとeval manifest pinはfcd10572400bdb027b9091a035553653c0c95d07。source worktreeはclean、branch autonomy、own origin git@github.com:hashtagakiaki/mindcraft.git。既存PLANなし。稼働runtimeは未調査。
- actions.js:161/171、queries.js:223にrememberHere/goToRememberedPlace/savedPlacesがある。memory_bank.js:6のname→[x,y,z]はRAM内。getJson/loadJsonのcallerは見つからず、history.js:82/100の保存復元にも台帳はない。
- mindserver.js:58/102/110は既存Socket.IO hub、settingsのack、agent socket関連付け。mindserver_proxy.jsにclient/timeout例がある。agent_process.js:23のspawnにはNode IPC channelがない。
- coder.js:185のSES endowmentsはskills/log/world/Vec3。prompter.js:152/159/166はcommand docs/skill docs/会話要約。場所APIのnewAction露出とdocs接続が必要。
- skills.js:2393のfarm skillはstartPosition/chestPositionを受け取る。2489では明示チェストをblockAtしてから移動する。agent.js:479の死亡地点も台帳caller。
- eval prepare_mindcraft_play.py:260/270/282はbundle settings/load_memory=false/固有bundle生成。start_mindcraft_play.sh:69はrun_dir/serverをserver境界にする。apply_mindcraft_play.py:63はmemory.jsonだけをコピーする。
- 既存設定・調査したlauncherに永続world UUIDは見つからない。host:portはsave同一性を保証しない。dimensionは既存bot.game.dimensionを利用できる。以上はコード観察であり新機能の実測ではない。

Experiments and open questions:
- 既存Socket.IO ack方式で単一writerの更新と4クライアント照会が成立するか、SESへ渡すasync facadeで同じIDを解決できるか → Wave 1 Task 1の隔離fixtureで確認。稼働UIには接続しない。
- bundle外のstate rootと明示world namespaceを準備設定へ渡す契約がload_memoryやcwdに依存しないか → Wave 1 Task 2の一時run/config fixtureで確認。prepare scriptの本番実行・activationはしない。
- dimension表現は現行vanilla 1.21.1を優先し、入力時にminecraft: prefixを正規化する。custom dimensionは識別子を保持し、判定不能なら移動を拒否する。次waveのfixtureで境界を確認する。
- farm収納成功は現在のstored件数だけに依存せず、対象containerとserver由来のinventory/container更新を確認する設計。既存depositの確認範囲と遠方チェストのfixture結果から最小修正を次waveで確定する。

Approach:

## 1. 台帳の正本とscope
MindServer内にPlaceStoreを一つ置き、botは既存Socket.IO経由で照会・更新する。子プロセスがJSONを直接書かない。小さな台帳はNode標準fsのJSONで十分で、更新を直列化し、一時ファイル→rename後にackを返す。保存失敗では成功を返さず、直前の状態を維持する。破損時は原本を保存してエラーとし、空台帳で上書きしない。revisionを持ち、古いrevisionでの関係上書きは競合として再照会する。
place_state_dir（絶対path）とplace_world_id（明示namespace）はlauncher settingsが正本。settings.jsの既定値とpublic/settings_spec.jsonをそろえ、親が登録したagent settingsからscopeを確定する。LLM/RPC payloadからstate pathや別worldを任意指定させない。同一state dirには一つのMindServerだけが書く契約とし、二重起動はlockで拒否する。lock方式はTask 1で決める。
playでは既存run_dirを運用上のsave境界とし、run_dir/place-state/をbundle外のstate rootとする。place_world_idはそのstate rootの小さなmetadataに一度割り当てたUUID。server/worldは書き換えない。同じrunのbundle準備は同じrootとIDをsettingsへ渡す。別のsaveを同じrunに交換する場合はnamespaceを更新する明示操作が必要で、worldが変わったことをprotocolから自動検出できるとは保証しない。path/seed/host:portを恒久的world IDと推測しない。
汎用source利用ではoperatorが両設定を指定する。未設定なら既存bookmarkはsession内で利用できるが永続/shared記録機能は無効で、その状態を照会に表示する。evalの使い捨てcaseは独自state root/IDを使いplayと共有しない。place stateの読込みはload_memoryから独立して、親store開始時に行う。runtime切替・rollbackも同じschemaのstoreを使い、feature以前のruntimeに戻す場合は台帳を削除せず未使用で保持する。
設定は親起動/agent registration時に有効になる。UIからstate dir/world IDを個別botだけ変更して分裂させない。変更には親を再起動する運用とし、実際のplay activationは別途明示依頼で行う。
## 2. 最小データ契約
JSON rootはschemaVersion/worldId/revision/places/relations/agentPreferencesを持つ。placeは以下を持つ。
- id: 安定ID。renameしてもrelation参照を壊さない。
- name/aliases、kind、purposes: 人間の呼称、base/farm/storage/forest/village/mine等の種別、wheat/food_storage/oak_log等の用途。タグの巨大辞書を作らない。
- dimension、position: 対象blockまたは代表地点。必要な場合だけapproachPositionとradiusを追加する。MVPは点と概略半径まで。
- source: user または observed、reportedBy、recordedAt。ユーザー指定とbot直接観測を区別する。
- existence: unverified/observed/missing、lastVerifiedAt、availability（必要時だけdepleted等）。到達の成否は別のlastVisit結果に持つ。
場所の事実はworld内共有。agentPreferences[botName].homePlaceIdと個人bookmark/death地点はbotごと。既存rememberHereの名前はまず本人のbookmark aliasとして解決し、共有の同名場所が複数あるときは一意IDで区別する。同じ名前だけで別の畑を上書きしない。自動観測の重複統合は同じdimension・kind・対象位置が一致する場合を優先し、遠くの同種場所をまとめない。
relationはMVPでoutput_storageのみ。fromPlaceId→toPlaceId、source、recordedBy、confirmedAt、revisionを持つ。関係を追加する前に双方のworld/dimension/typeを確認する。異なるdimension間の作業関係はMVPでは使わない。ユーザーの明示関係をbotの近場選択で変更しない。
## 3. 記録と検索
明示指示では観測できた対象、ユーザー座標、現在位置をそれぞれ区別して登録する。「ここ」でチェストblockを指定したならblock座標を保存し、rememberHereは従来通り立ち位置を保存する。ユーザー情報だけの対象はunverifiedとする。
自動登録は有用な作業の成功時と重要な直接観測に絞る。全block/全移動を保存しない。LLMの説明だけでobservedや収納成功にせず、観測・実行結果から更新する。林・鉱山では代表地点と資源タグを記録し、採取成功が継続在庫を保証しないことを扱う。
検索は名前/alias、kind/purpose、現在scope、距離、確認状態で行い、件数を制限する。vector DBは不要。promptには利用方法と現在選択中のplace ID/関連数件だけを載せ、全台帳を毎回入れない。会話側の検索結果はnewActionへ引き継ぐが、実行直前に再解決する。
畑選択は、明示名/ID → 現在のtaskで選択済み → botがいるconnected plot → 同じ用途の利用可能候補の順。単に「近い」だけで用途の異なる畑を選ばない。汎用採取で互換候補なら近い確認済み候補を選べる。ユーザーが特定の畑を指していて複数候補に解釈できる場合だけ確認する。
保管先は、明示された関係 → 同じ作業の確認済み選択 → 用途とscopeに適合する候補、の順。適合候補が一つ、または明示された共有保管規則で互換なら選択してよい。用途不明のチェストしかない、個人用・別用途と競合する、指定チェストが消失した場合は確認する。指定関係を黙って別チェストに付け替えない。未登録候補への収納が確認されたらobserved関係を保存し、失敗・収穫ゼロ・収納ゼロでは関係を推測登録しない。
## 4. command・newAction・skillの接続
既存3commandのsyntaxを保つ。rememberHereは現在dimension付きで本人bookmarkを保存し、保存ack後に成功を返す。goToRememberedPlaceは本人alias優先でplaceを解決しdimensionを確認して移動する。savedPlacesは従来の一覧を返す。内部MemoryBankの全caller（死亡位置を含む）は保存のasync成否を扱うよう移行する。旧name→arrayのsessionデータは現world/dimensionが確定している場合だけ明示的に変換する。
新しいcommand候補はfindPlaces(query)、inspectPlace(id)、rememberPlace(name, kind, purpose)、setPlaceRelation(fromId, relation, toId)。最終の引数形式は既存command parserに合わせて実装waveで確定する。観測targetの登録とユーザー報告は検証層で区別する。
newActionにはplacesという制限付きfacadeをSES endowmentとして渡す。query/get/rememberObserved/setOutputStorage/goTo等だけを公開し、fs/socket/settingsの生オブジェクトを渡さない。会話commandとfacadeは同じclient/serviceを呼ぶ。lintTemplate、code docs、関連skill docs、会話/coding promptの両方を更新する。
畑作業はplaces.tendFarm(bot, farmId, options)のような薄いdomain adapterで行う。LLMはfarmIdと目的を選び、adapterはstoreからoutput_storageを再解決してstartPosition/chestPositionを作る。モデルに記憶した座標やrelationを再入力させない。adapterが既存tendNearbyFarmを呼び、確認できた作業結果から台帳を更新する。
遠方の未ロードチェストは「ない」と即判定せず、指定座標へ移動してchunkを読み込んだ後に対象blockを確認する。既存farm skillの明示chestPosition分岐をこの順序へ調整するのが第一候補。畑の選択と耕地確認は既存connected plot探索を再利用する。storage確認を強める必要がある場合も既存deposit処理の最小変更とし、別のfarm実装を増やさない。
## 5. 利用時の確認と失敗
実行直前にscopeと最新relationを再照会する。relation revisionが変わった場合は古い保管先へ続行せず再解決する。対象positionとapproachPositionを区別し、チェスト内部/水源へ立つ移動を要求しない。場所への到着と作業対象確認を別結果にする。
読み込まれた現地で対象が消えているならmissing。未ロード/nullや移動不能では存在情報を消さない。資源の枯渇と畑の未成熟、空チェストとチェスト消失も区別する。確認時刻を更新し、古い記録は再確認候補とするが時間だけで削除しない。
失敗後は状態を報告して用途に合う別候補/周辺探索を使う。明示関係の欠落では収穫物を保持して確認し、無断で捨てたり別用途チェストへ入れたりしない。RPC timeout/保存失敗は保存済みと報告しない。作業成功と台帳更新失敗が別々に起きた場合は、作業済み内容を再実行せず記録更新だけを回復する。

Failure modes checked:
- 既存bookmarkとの重複/会話要約での消失 → command/MemoryBank/historyを確認し、既存APIと独立台帳を使う。
- 同時JSON更新/bundle切替で消失/別save混入 → hubとlauncherを確認し、単一writer・bundle外state・明示namespaceにする。
- 遠いチェストが未ロードで消失扱い/newActionが台帳を使えない → farm分岐とSESを確認し、移動後確認とfacadeを接続する。
- 個人home/deathや同名場所が上書き/live検証の誤操作 → callerを確認し個人scopeを分離、offline temp fixtureのみ使う。

Full verification:
- sourceで `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node tests/run-tests.cjs` を実行し、従来回帰と場所/関係/失敗fixtureを確認する。
- evalで `python3 -m unittest discover -s tests -v` を実行し、prepare-only設定、namespace、bundle間状態保持、pin/exportの回帰を確認する。
- 隔離4clientで登録→用途検索→relation登録→別client検索→親再起動→同じID復元を確認する。load_memory=falseと別namespace、revision競合、保存失敗も確認する。
- farm fixtureで正しいplot/chest選択、遠方unloaded→到着後確認、明示関係優先、部分収納/収納失敗/収穫ゼロ時の記録、missingとunloadedの区別を確認する。
- source pinをown originへpush後、eval manifest更新と隔離export検証を行う。実play activationは別途依頼時のみ。offline合格はlive gameplay成功の保証として記載しない。
- 各repoで `git diff --check` とfull diff review。credential/state/runtimeをstageしない。

## Wave 1

- [ ] Task 1: 既存hubとSESから使う場所操作契約を隔離fixtureで確定する。
  Writes:
  - docs/place-memory-transport-experiment.md
  - "$PLACE_TRANSPORT_TMP/probe.mjs" と同directory内の実験fixture/state（実験後削除）
  Reads:
  - src/mindcraft/mindserver.js
  - src/agent/mindserver_proxy.js
  - src/agent/coder.js
  - src/agent/memory_bank.js
  - src/agent/library/lockdown.js
  - bots/lintTemplate.js
  - tests/run-tests.cjs
  - ../mindcraft-eval/runtime/upstream/node_modules（read-only Socket.IO/SES）
  Change:
  - `PLACE_TRANSPORT_TMP=$(mktemp -d /tmp/mindcraft-place-memory-transport.XXXXXX)` で専用directoryを作り、`$PLACE_TRANSPORT_TMP/probe.mjs` を保存する。同じshellで作成・実行・cleanupする。
  - 一時directoryに既存依存をread-onlyで使うsocket/SES probeを置く。loopback port 0で4client、単一writer、ack、revision、save失敗と再読込を確認する。Minecraft/既存MindServerを起動しない。
  - async facadeがSES内から同じplace ID/relationを取得できること、期限付き失敗が伝わることを確認する。lock/releaseの方法と既存command callerのasync移行範囲を記録する。
  - 一時probeは削除する。成功したprobeをfeature実装としてsourceへ持ち込まない。
  Verify:
  - `/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node "$PLACE_TRANSPORT_TMP/probe.mjs"`。終了時にsocket/lock/temp filesが解放されたことを確認する。
  - 成否にかかわらず `rm -rf "$PLACE_TRANSPORT_TMP"` を実行し、`test ! -e "$PLACE_TRANSPORT_TMP"` でcleanupを確認する。
  - `git diff --check`、実験記録のcommand/result/cleanup/未検証範囲をreviewする。
  Expected:
  - 4client更新が欠落せず、保存後ack/再起動復元が成立する。SESのplace facadeはfs等を追加公開せず動作する。失敗した点は次waveの変更理由と再実験条件を明記する。
  Commit:
  - `docs: record place memory transport contract experiments`（own source originのみ）

- [ ] Task 2: world namespaceとbundle外stateの準備契約を隔離fixtureで確定する。
  Writes:
  - ../mindcraft-eval/docs/place-memory-runtime-experiment.md
  - "$PLACE_RUNTIME_TMP/probe.py" と同directory内の実験run/config（実験後削除）
  Reads:
  - ../mindcraft-eval/AGENTS.md
  - ../mindcraft-eval/README.md
  - ../mindcraft-eval/scripts/prepare_mindcraft_play.py
  - ../mindcraft-eval/scripts/apply_mindcraft_play.py
  - ../mindcraft-eval/scripts/start_mindcraft_play.sh
  - ../mindcraft-eval/tests/test_play_runtime.py
  - settings.js
  - src/mindcraft/public/settings_spec.json
  Change:
  - `PLACE_RUNTIME_TMP=$(mktemp -d /tmp/mindcraft-place-memory-runtime.XXXXXX)` で専用directoryを作り、`$PLACE_RUNTIME_TMP/probe.py` を保存する。同じshellで作成・実行・cleanupする。
  - 一時runと偽settings/bundle fixtureでstate path/IDの契約を確認する。既存live run/server/worldを参照しない。
  - 同一runの二bundleが同じroot/ID、別run/namespaceが独立、load_memory=falseでも場所状態を利用できる契約を記録する。
  - run_dir/place-state metadataがnamespaceの正本であること、save交換時の明示namespace更新、UI変更scopeと親起動でのactivation、旧runtime rollback時の保持を記載する。
  - 実験用のファイルを削除し、運用scriptはこのtaskでは編集しない。
  Verify:
  - `python3 "$PLACE_RUNTIME_TMP/probe.py"`。生成値とbundle間の同一/分離をassertし、live接続がないことを確認する。
  - 成否にかかわらず `rm -rf "$PLACE_RUNTIME_TMP"` を実行し、`test ! -e "$PLACE_RUNTIME_TMP"` でcleanupを確認する。
  - eval repoで `git diff --check`、設定契約と実験記録をreviewする。
  Expected:
  - cwd/bundle ID/load_memoryに依存しないstate scopeが具体化し、準備とactivationの境界が明確になる。実worldを自動識別したとの主張を含めない。
  Commit:
  - `docs: record place memory runtime namespace contract`（own eval originのみ）

## Deferred work

- Wave 1の契約確定後、sourceにschema/PlaceStore、単一writer/保存/namespace、clientと設定を実装する。独立fixtureで4bot共有、再起動、競合、破損保持を確認する。
- store/clientに依存して既存bookmark command/死亡位置callerを移行し、新しい検索/登録/関係command、SES facade、lint、会話/coding docsを接続する。同名・個人home・dimensionの回帰を追加する。
- 上記に依存してfarm→output_storage adapterと必要最小限の収納/遠方チェスト処理を実装する。既存座標APIを維持し、実際の収納確認からだけ自動関係を保存する。観測成功時の汎用登録は同じAPIを使う。
- sourceテスト/own origin push後、eval manifestをそのfull SHAへ更新し、prepare設定にrun単位のstate root/world IDを接続する。namespaceの明示更新手順、bundle切替・rollback、load_memory独立性をofflineで確認する。
- 挙動/使用法変更に合わせsource/evalのREADMEとAGENTSを更新し、必要ならSPECを作る。各wave実行前にWritesが重ならないtaskへ再分割し、Verify/Expected/Commitを具体化する。
- 最終offline/export確認後にPLANを実装結果へ照合する。稼働4botへのactivationはユーザーが別途依頼したときに既存apply手順で行う。

## Plan updates

- 2026-10-01: 抽象設計を正式設計へ更新。場所bookmark自体は既存で、永続化・用途検索・共有・実行時再確認が不足しているというコード観察に基づく。
- 2026-10-01: ユーザー方針として、畑選択はモデル、選択済み畑の保管先参照解決はコードに置く。汎用場所台帳と最小output_storage関係を採用。
- 2026-10-01: 設計時には実験を実行していない。未解決の技術契約は次のWave 1に置き、実装やlive確認済みと扱わない。
