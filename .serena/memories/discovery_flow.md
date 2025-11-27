# ECHONETLite デバイスディスカバリ処理フロー

## 概要

デバイスディスカバリは以下の3つのステップで構成される：
1. **ノード発見**：d5 (自動通知) またはd6 (探索応答) でデバイスの存在を知る
2. **軽量登録**：ノードとデバイスを素早く登録（プロパティ詳細なし）
3. **詳細収集**：非同期でプロパティマップとプロパティ値を収集

## キュー構造

各IP専用のキューが存在し、以下の優先順位で処理される：

```
ipQueues: Map<string, {
  discoveryQueue: Response[];        // 最優先（d5, d6）
  infQueue: Response[];              // 通常INF（プロパティ値更新）
  prioritySendQueue: [...];          // 優先送信（REST/MQTT set）
  normalSendQueue: [...];            // 通常送信（REST/MQTT get）
  backgroundSendQueue: [...];        // バックグラウンド送信（PropertySync）
  processing: boolean;
}>
```

**処理順序**：
```
processQueueForIp(ip)
  ├─ processDiscoveryQueue()     // 最優先
  ├─ processInfQueue()           // 次
  └─ processSendQueue()          // 最後
```

**設計ルール**：
- 同一IP内：直列実行（await）
- 異なるIP間：並列実行（別のprocessQueueForIp）

## d5処理（自動通知）

### d5とは
- プロパティコード：0xD5（ノードインスタンスリストS）
- ESV：0x73 (INF - 通知)
- 用途：デバイスが起動時や状態変化時に自動送信

### 処理フロー

```
[デバイス] --INF d5--> [受信ハンドラ]
                            |
                            v
                    discoveryQueueに追加
                            |
                            v
                  processDiscoveryQueue()
                            |
                            v
                  handleD5Notification()
                            |
                            v
                  handleNodeInstanceList()
                            |
                            ├─ 既存ノード？
                            │   ├─ Yes → 新デバイスのみ追加
                            │   └─ No  → 新規ノード作成
                            |
                            v
                  updateOrAddNode() (mutex保護)
                            |
                            v
                  fireDeviceDetected()
                            |
                            v
              startDeviceCollection() (fire-and-forget)
                            |
                            v
                  runDeviceCollection() (mutex保護)
                            |
                            └─ collectDeviceDetails()
                                  ├─ getPropertyMaps()
                                  └─ 各プロパティ値取得
```

### コード位置

- **受信振り分け**：constructor, lines 103-113
- **キュー処理**：processDiscoveryQueue(), lines 622-647
- **d5ハンドラ**：handleD5Notification(), lines 677-679
- **共通処理**：handleNodeInstanceList(), lines 698-770

## d6処理（探索応答）

### d6とは
- プロパティコード：0xD6（ノードインスタンスリストS）
- ESV：0x72 (GET_RES - 応答)
- 用途：探索要求への応答（マルチキャスト/ユニキャスト）

### マルチキャスト探索

```
[Controller] --sendNow("224.0.23.0")--> [ネットワーク]
                                              |
                    +-------------------------+-------------------------+
                    |                         |                         |
            [デバイスA]                 [デバイスB]                 [デバイスC]
                    |                         |                         |
                    v                         v                         v
              GET_RES d6                GET_RES d6                GET_RES d6
                    |                         |                         |
                    +-------------------------+-------------------------+
                                              |
                                              v
                                      [受信ハンドラ]
                                              |
                    +-------------------------+-------------------------+
                    |                         |                         |
            IP=192.168.1.1            IP=192.168.1.2            IP=192.168.1.3
                    |                         |                         |
                    v                         v                         v
          discoveryQueue[A]          discoveryQueue[B]          discoveryQueue[C]
                    |                         |                         |
                    v                         v                         v
        processQueueForIp(A)      processQueueForIp(B)      processQueueForIp(C)
                    |                         |                         |
              (並列実行)                  (並列実行)                  (並列実行)
```

**特徴**：
- 複数デバイスから同時に応答が返る
- 各IPごとに独立したdiscoveryQueueに振り分けられる
- IP間は自動的に並列処理される

### ユニキャスト探索

```
[Controller] --sendNow("192.168.1.1")--> [特定デバイス]
                                                |
                                                v
                                          GET_RES d6
                                                |
                                                v
                                        [受信ハンドラ]
                                                |
                                                v
                                    discoveryQueue[192.168.1.1]
                                                |
                                                v
                                  processQueueForIp("192.168.1.1")
```

### d6処理フロー

```
[受信ハンドラ] (constructor, lines 127-137)
        |
        v
ESV=GET_RES && SEOJ=0ef001 && d6 in DETAILs?
        |
        ├─ Yes → discoveryQueueに追加
        └─ No  → (他の処理)
        |
        v
processDiscoveryQueue() (lines 622-647)
        |
        v
handleD6Response() (lines 681-683)
        |
        v
handleNodeInstanceList() (lines 698-770)
        |
        ├─ 既存ノード？
        │   ├─ Yes → 新デバイスのみ追加
        │   └─ No  → 新規ノード作成
        |
        v
updateOrAddNode() (mutex保護)
        |
        v
fireDeviceDetected()
        |
        v
startDeviceCollection() (fire-and-forget)
```

### 送信API

- **マルチキャスト**：`searchDevicesInNetwork()` (lines 973-978)
  ```typescript
  EchoNetCommunicator.sendNow('224.0.23.0', '0ef001', '0ef001', ELSV.GET, "d6", "");
  ```

- **ユニキャスト**：`searchDeviceFromIp(ip)` (lines 963-970)
  ```typescript
  EchoNetCommunicator.sendNow(ip, '0ef001', '0ef001', ELSV.GET, "d6", "");
  ```

**注意**：
- `sendNow()`を使用しているため、CommandResponseは作成されない
- 応答は全てキュー経由（discoveryQueue）で処理される
- タイムアウトなし（ノンブロッキング送信のみ）

## 詳細収集フロー

### startDeviceCollection() → runDeviceCollection()

```
startDeviceCollection(ip) (lines 564-566)
        |
        | (fire-and-forget、エラーハンドリングのみ)
        v
runDeviceCollection(ip) (lines 568-613)
        |
        | (mutex保護で排他制御)
        v
devicesToCollect = devices.filter(d => d.properties.length === 0)
        |
        v
for each device in devicesToCollect:
        |
        v
    collectDeviceDetails(device, ip)
        |
        ├─ getPropertyMaps() → 9D, 9E, 9Fプロパティ取得
        ├─ 9Fから取得可能プロパティリスト抽出
        └─ 各プロパティ値を取得（GET要求）
        |
        v
allDevicesHaveProperties?
        |
        ├─ Yes → discoveryComplete = true
        └─ No  → discoveryComplete = false
        |
        v
fireDeviceDetected() (再度通知、今度はId付き)
```

### collectDeviceDetails()の詳細

1. **プロパティマップ取得**：
   ```
   0x9D: ANNOUNCE プロパティマップ（通知）
   0x9E: SET プロパティマップ（設定可能）
   0x9F: GET プロパティマップ（取得可能）
   ```

2. **プロパティ値取得**：
   - 0x9Fのマップから取得可能なプロパティリストを抽出
   - 各プロパティに対してGET要求を送信
   - 応答を待ってプロパティリストに追加

3. **キュー経由の処理**：
   - `collectDeviceDetails()`内のGET要求は`requestGet()`経由
   - `requestGet()` → `execPromise()` → sendQueueに追加
   - 応答はprocessSendQueue() → updatePropertiesFromResponse()で処理

## PropertySyncとの連携

### discoveryComplete フラグ

```typescript
interface RawNode {
  ip: string;
  devices: RawDevice[];
  discoveryComplete: boolean;  // ← 全デバイスの詳細収集が完了したか
}
```

### PropertySyncManagerの条件チェック

```typescript
// PropertySyncManager.checkAndRequestUpdates()
if (rawController) {
  const nodes = rawController.getAllNodes();
  const node = nodes.find(n => n.ip === ip);
  if (node && !node.discoveryComplete) {
    Logger.debug("[PropertySync]", `${ip}: Skipped (discovery not completed yet)`);
    return [];  // PropertySync抑止
  }
}
```

**目的**：
- デバイス詳細収集中はPropertySyncを抑止
- 詳細収集完了後にPropertySyncを開始
- sendQueueの優先順位を保つ（discovery > PropertySync）

## タイミングチャート例

### マルチキャスト探索の場合

```
Time   Controller          Device A (192.168.1.1)    Device B (192.168.1.2)
  |
  0ms   searchDevicesInNetwork()
  |     sendNow("224.0.23.0")
  |     ---------------------->
  |
 10ms                        GET_RES d6 -->
 12ms                                                GET_RES d6 -->
  |
  |     discoveryQueue[A]=1
  |     discoveryQueue[B]=1
  |
  |     processQueueForIp(A)  processQueueForIp(B)  (並列実行)
  |            |                       |
 15ms         v                       v
  |     handleNodeInstanceList   handleNodeInstanceList
  |            |                       |
 20ms         v                       v
  |     updateOrAddNode          updateOrAddNode  (mutex待ち)
  |            |                       |
 25ms         v                       |
  |     startDeviceCollection         |
  |            |                       v
 30ms         |                  startDeviceCollection
  |            |                       |
  |     (fire-and-forget)        (fire-and-forget)
  |            |                       |
  |            +-------+-------+-------+
  |                    |
  |                    v
  |            runDeviceCollection (並列実行)
  |                    |
  |                    v
  |            collectDeviceDetails()
  |                    |
  |            getPropertyMaps(), 各プロパティ取得
  |                    |
100ms                 v
  |            discoveryComplete = true
```

## コードの重要箇所まとめ

### 受信振り分け (Constructor, lines 99-140)
```typescript
// d5を含むINF → discoveryQueue
if (els.ESV === ELSV.INF && "d5" in els.DETAILs) {
  queue.discoveryQueue.push({rinfo, els});
}

// マルチキャストd6応答 → discoveryQueue  
if (els.ESV === ELSV.GET_RES && els.SEOJ === "0ef001" && "d6" in els.DETAILs) {
  queue.discoveryQueue.push({rinfo, els});
}
```

### キュー処理 (processQueueForIp, lines 925-961)
```typescript
await this.processDiscoveryQueue(ip, queue);  // 最優先
await this.processInfQueue(ip, queue);
await this.processSendQueue(ip, queue);
```

### Discovery処理 (processDiscoveryQueue, lines 622-647)
```typescript
// d5処理（同一IP内では直列）
if ("d5" in item.els.DETAILs) {
  await this.handleD5Notification(item, foundNode);
}
// d6処理（同一IP内では直列）
else if ("d6" in item.els.DETAILs) {
  await this.handleD6Response(item, foundNode);
}
```

### 共通処理 (handleNodeInstanceList, lines 698-770)
```typescript
// 既存ノード：新デバイスのみ追加
if (foundNode !== undefined) {
  const newEojList = eojList.filter(newEoj => ...);
  newEojList.forEach(eoj => foundNode.devices.push({...}));
}
// 新規ノード：ノード構造作成
else {
  const nodeTemp = { ip, devices: [...], discoveryComplete: false };
  await this.updateOrAddNode(nodeTemp);
}

// 共通：詳細収集開始（fire-and-forget）
this.startDeviceCollection(ip);
```

### 詳細収集 (startDeviceCollection, lines 564-613)
```typescript
// fire-and-forget（awaitなし）
private startDeviceCollection(ip: string): void {
  this.runDeviceCollection(ip).catch(e => { ... });
}

// 実際の収集処理（mutex保護）
private async runDeviceCollection(ip: string): Promise<void> {
  const mutex = this.getDeviceCollectionMutex(ip);
  await mutex.runExclusive(async () => {
    const devicesToCollect = node.devices.filter(d => d.properties.length === 0);
    for (const device of devicesToCollect) {
      await this.collectDeviceDetails(device, ip);
    }
    node.discoveryComplete = (全デバイスのproperties.length > 0);
  });
}
```

## 設計上の重要ポイント

1. **非ブロッキング設計**：
   - 探索送信：`sendNow()` - タイムアウトなし、即座に戻る
   - 詳細収集：`startDeviceCollection()` - fire-and-forget

2. **軽量登録→詳細収集**：
   - 先にノードとデバイスを素早く登録（properties=[]）
   - 後から非同期でプロパティ詳細を収集
   - WebUIにも早期に表示可能

3. **IP単位の直列化**：
   - 同一デバイスへの並列リクエストを防止
   - mutex保護でノード更新とデバイス収集を排他制御

4. **discoveryCompleteフラグ**：
   - PropertySyncの開始条件
   - デバイス単位ではなくノード（IP）単位で管理

5. **エラー耐性**：
   - 一部デバイスの収集失敗は他に影響しない
   - 収集失敗してもdiscoveryComplete=falseでPropertySyncを抑止
