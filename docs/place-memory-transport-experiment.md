# Place memory transport experiment

実施日: 2026-10-01

## 対象と制約

隔離したNode process内で、既存依存のSocket.IOとSESを使ったfixtureを実行した。実依存は `mindcraft-eval/runtime/upstream/node_modules` をread-onlyで参照し、Socket.IO / Socket.IO client は `4.8.4`、SESは `1.15.0`。Nodeはプロジェクト指示に記載のNode 20 binaryを使用。serverは `127.0.0.1` のport 0で待受け、4 client以外には接続していない。40973/8098、MindServer本体、bot、Minecraft worldは起動・操作していない。credentials、install、依存変更はない。

実験コマンドの形:

```sh
PLACE_TRANSPORT_TMP=$(mktemp -d /tmp/mindcraft-place-memory-transport.XXXXXX)
/home/akito/.cache/mindcraft-play/node-npm-cache/_npx/337e068089ca04e3/node_modules/node-linux-x64/bin/node "$PLACE_TRANSPORT_TMP/probe.mjs"
python3 -c 'import shutil,sys;shutil.rmtree(sys.argv[1])' "$PLACE_TRANSPORT_TMP"
test ! -e "$PLACE_TRANSPORT_TMP"
```

probeと出力は作成したtask専用temp directory内に限り、全ての実行後に削除した。raw output:

```text
{"clients":4,"ackRevisions":[3,4,2,1],"queryResults":[4,4,4,4],"saveFailure":{"ok":false,"error":"injected persistence failure","revision":4},"recoveredRevision":5,"reloadedRevision":5,"failedItemPersisted":false,"sesFacade":{"id":"place-id","relation":"output_storage","revision":2},"deadline":"rpc timeout"}
cleanup: PASS
```

確認できたこと:

- 同じloopback Socket.IO serverにつないだ4 clientが、同一writer queueに並行更新を送り、重複revisionなしでackを受けた。更新順序自体はclient index順を保証しない。4 client全てがrevision 4 / 4 placeの同じ照会結果を得た。
- 保存関数を意図的に失敗させた更新は `{ok:false, revision:4}` となり、現在状態に反映されなかった。次の更新は成功し、JSONを改めて読み込んでもrevision 5で失敗itemは含まれなかった。fixtureはwrite-temp→renameを使用。
- SES Compartmentに `places` facadeだけをendowmentし、Compartment内async codeから `remember`、relation設定、queryを順に呼べた。ID、`output_storage` relation、revisionが返った。未解決Promiseのdeadlineはhost側の`Promise.race`で `rpc timeout` として観測できた。
- 独立した切分けprobeではserver接続、client接続、event handler、ack、closeの各地点が到達した。Socket.IOを4 clientに増やした際も全4接続とackが記録された。
- probe、socket、状態fixtureは終了時に解放・削除し、専用tmp directoryの不存在を確認した。Socket.IO version確認、SES timerの初回確認も含む一時試行物は残していない。

## 現行sourceの観察

- `src/mindcraft/mindserver.js` は親プロセスにSocket.IO serverを一つ作り、agent用socketと各種UI/API eventを処理する。現状 `place:*` RPC eventはない。`createMindServer()` がHTTP serverを返すため、その`close` lifecycleへwriter lockのreleaseを関連づけられる。
- `src/agent/mindserver_proxy.js` はagentごとのNode processにあるsingleton client socket。timeout付きackの既存例はsettings requestの5秒timeout。場所RPCのclient transportはここへ集約可能。
- `src/agent/coder.js` のSES endowmentは現在 `skills`, `log`, `world`, `Vec3`。place service objectだけを `places` として追加できる。probeではAPIを広く渡さずともawait可能だった。RPC timeoutはSESへtimerを追加せずhost proxyで実装する。
- `!rememberHere` / `!goToRememberedPlace` / `!savedPlaces` はそれぞれ `actions.js` / `queries.js` から同期 `MemoryBank` を呼ぶ。`agent.js` の死亡位置callerも同期書込み。永続ackを成功条件にするにはこれら全callerをasyncにし、memory bankの同期形だけを局所変更する対応では不足。
- `agent_process.js` からagentは別Node processとして起動され、直接のNode IPC channelはない。Socket.IO hubがshared stateのRPC境界に合う。

## 契約案と制限

sourceは `place_state_dir/worlds/<world_id>.json` のようなworld別台帳を使う。eval準備側が作る `place_state_dir/world.json` の `{"world_id":"<uuid>"}` とsettingsの `place_world_id` をscopeの正本として扱う。world ID変更後も旧台帳を保持し、設定値と台帳内world IDが違えば誤読・上書きを拒否する。別worldの同名locationは別fileに属する。

MindServer内のPlaceStoreだけが台帳を書き、変更はPromise直列化、revision検査、同directoryの一時fileからrename、rename成功後ackの順にする。保存失敗時はmemory上のcurrent stateも差し替えない。破損台帳は原本を保持して起動/読込errorにする。同一state dirの複数MindServerを避けるため、writer lockはexclusive create (`open(..., 'wx')`) で取得し、親serverのcloseでreleaseする。既存lockは自動削除・奪取せず二重writerを拒否するのが簡明。crash後のstale lock回収手順は実装taskで別途決めてdocumentする。

RPC最小案:

- `queryPlaces({text, kind, purpose, dimension, existence, limit, agentName})`
- `getPlace(placeId)`
- `rememberPlace(placeInput)`
- `setRelation({fromPlaceId, relation: 'output_storage', toPlaceId, expectedRevision})`

要求payloadからstate pathやworld IDを指定させず、hubに登録されたagent settingsからscopeを決める。replyは `{ok, value, revision, error}` を基本とし、Socket.IO acknowledgement callback自体にhost側timeoutを置く。PlaceStoreに座標/種別/source/dimensionなどのschema validationを入れ、有限数の座標だけ受け付ける。person-specific home/bookmarkはworld shared placesと分けてagent preferenceへ保存する。source実装の正確なschema/APIは依存taskで決める。

## 観察ではない仮説・未検証

- Socket.IOとSESの使用可能性は確認したが、既存の実 `mindserver.js` へRPCを組み込んで4 agent process間に使ったわけではない。
- fs renameによる単一writer fixtureは確認したが、OS crash durability、directory fsync、複数process lockのstale回収、台帳破損時のsource起動挙動は未検証。
- session中のbookmark (`MemoryBank`) と新しい永続place storeの移行、rename、death/homeの個人scopeは未実装・未検証。
- farm→storage relationを作業の観測結果で記録する処理、遠方未ロードchestの確認手順も未実装・未検証。

## 検証結果

- 4-client、単一queue、save failure/recovery/reload、SES async facade、host deadlineを確認。
- temp rootが削除され存在しないことを `test ! -e "$PLACE_TRANSPORT_TMP"` で確認。
- `git diff --check` は本記録を作成する直前の状態で成功。最終のdiff checkもtask完了前に再実行する。
