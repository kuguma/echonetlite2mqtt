import { DeviceDetailsType, eldata,rinfo } from "echonet-lite";
import { Command, CommandResponse, Response, ELSV, EchoNetCommunicator, RawDataSet } from "./EchoNetCommunicator";
import { Logger } from "./Logger";
import { Mutex } from "async-mutex";
import { PropertySyncManager } from "./PropertySyncManager";
import { DeviceStore } from "./DeviceStore";


export type QueuePriority = 'priority' | 'normal' | 'background';

export interface CommandWithCallback extends Command
{
  callback: ((res: CommandResponse) => void) | undefined;
  priority?: QueuePriority;
  onSuccess?: () => void;
  onFailure?: () => void;
}

export class EchoNetLiteRawController {
  private readonly nodes: RawNode[] = [];
  private readonly nodesUpdateMutex = new Mutex();
  private propertySyncManager?: PropertySyncManager;
  private deviceStore?: DeviceStore;

  // デバイス探索設定
  private knownDeviceIpList: string[] = [];
  private enableMulticastSearch: boolean = false;

  // 定期探索機能
  private periodicSearchIntervalSec?: number;
  private periodicSearchTimer?: NodeJS.Timeout;

  // IP別のキュー構造
  private readonly ipQueues: Map<string, {
    discoveryQueue: Response[];            // デバイス探索専用（d5, d6）
    infQueue: Response[];
    prioritySendQueue: CommandWithCallback[];  // 最優先（REST/MQTT set用）
    normalSendQueue: CommandWithCallback[];    // 通常（REST/MQTT get用）
    backgroundSendQueue: CommandWithCallback[]; // バックグラウンド（sync get用）
    processing: boolean;
  }> = new Map();

  // 重複排除用のデータ構造
  // IP別の保留中リクエストキー（GET用）
  private readonly pendingGets: Map<string, Set<string>> = new Map();
  // IP別の保留中SETリクエスト（requestKey → {最新値、Promise}）
  private readonly pendingSets: Map<string, Map<string, {edt: string, promise: Promise<CommandResponse>}>> = new Map();

  // デバイス収集の排他制御（ノードIP別）
  // 同一ノードに対する並行getNewNode呼び出しを防ぎ、デバイス保護を維持
  private readonly deviceCollectionMutexes: Map<string, Mutex> = new Map();

  // デバイス収集ミューテックスの取得または作成
  private getDeviceCollectionMutex(ip: string): Mutex {
    let mutex = this.deviceCollectionMutexes.get(ip);
    if (!mutex) {
      mutex = new Mutex();
      this.deviceCollectionMutexes.set(ip, mutex);
    }
    return mutex;
  }

  // IP別キューの取得または作成
  private getOrCreateIpQueue(ip: string) {
    let queue = this.ipQueues.get(ip);
    if (!queue) {
      queue = {
        discoveryQueue: [],
        infQueue: [],
        prioritySendQueue: [],
        normalSendQueue: [],
        backgroundSendQueue: [],
        processing: false
      };
      this.ipQueues.set(ip, queue);
    }
    return queue;
  }

  /**
   * PropertySyncManagerを設定（index.tsから呼ばれる）
   */
  public setPropertySyncManager(manager: PropertySyncManager, deviceStore: DeviceStore): void {
    this.propertySyncManager = manager;
    this.deviceStore = deviceStore;
    Logger.info("[PropertySync]", "PropertySyncManager registered with RawController");
  }

  public getPropertySyncManager(): PropertySyncManager | undefined {
    return this.propertySyncManager;
  }

  // ノード更新の排他制御
  private async updateOrAddNode(newNode: RawNode): Promise<void> {
    return this.nodesUpdateMutex.runExclusive(() => {
      const currentIndex = this.nodes.findIndex(_ => _.ip === newNode.ip);
      if (currentIndex === -1) {
        this.nodes.push(newNode);
      } else {
        this.nodes[currentIndex] = newNode;
      }
    });
  }

  constructor() {

    EchoNetCommunicator.addReveivedHandler((rinfo, els) => {
      const ip = rinfo.address;
      const queue = this.getOrCreateIpQueue(ip);

      // d5を含むINF → discoveryQueue
      if (els.ESV === ELSV.INF && "d5" in els.DETAILs) {
        queue.discoveryQueue.push({
          rinfo: rinfo,
          els: els
        });
        Logger.debug("[ECHONETLite][queue]", `INF d5 queued for ${ip}, discoveryQueue=${queue.discoveryQueue.length}`);
        if (queue.processing === false) {
          this.processQueueForIp(ip);
        }
      }
      // d5を含まない通常のINF → infQueue
      else if (els.ESV === ELSV.INF) {
        queue.infQueue.push({
          rinfo: rinfo,
          els: els
        });
        const sendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
        Logger.debug("[ECHONETLite][queue]", `INF queued for ${ip}, infQueue=${queue.infQueue.length}, sendQueue=${sendCount}`);
        if (queue.processing === false) {
          this.processQueueForIp(ip);
        }
      }

      // マルチキャストd6応答（GET_RES）→ discoveryQueue
      if (els.ESV === ELSV.GET_RES && els.SEOJ === "0ef001" && "d6" in els.DETAILs) {
        queue.discoveryQueue.push({
          rinfo: rinfo,
          els: els
        });
        Logger.debug("[ECHONETLite][queue]", `GET_RES d6 queued for ${ip}, discoveryQueue=${queue.discoveryQueue.length}`);
        if (queue.processing === false) {
          this.processQueueForIp(ip);
        }
      }

      this.fireReceived(rinfo, els);
    });

  }

  public getAllNodes = (): RawNode[] =>{
    return this.nodes;
  }

  /**
   * GETリクエストを発行（重複排除あり）
   * 同じIP/EOJ/EPCへのリクエストが既にあった場合、新しいものは握りつぶす（onSuccess/onFailureは呼ばれない）
   * 握りつぶすよりは例外&理由通知の方が理想的だが、今のところはたまたま困るケースが無いのでこれでもなんとかなっているという状況のはず。
   * 呼び出し元が違う、みたいなケースをかんがえるとしっかり対処してあげる必要はある。TODO
   */
  public requestGet = async (
    ip: string,
    seoj: string,
    deoj: string,
    epc: string,
    options?: {
      priority?: QueuePriority;
      onSuccess?: () => void;
      onFailure?: () => void;
    }
  ): Promise<CommandResponse> => {
    const requestKey = `GET:${deoj}:${epc}`;

    // IP別の保留中GETリクエストセットを取得または作成
    if (!this.pendingGets.has(ip)) {
      this.pendingGets.set(ip, new Set());
    }
    const pending = this.pendingGets.get(ip)!;

    // 重複チェック
    if (pending.has(requestKey)) {
      Logger.debug("[ECHONETLite][dedup]", `Duplicate GET request skipped: ${ip} ${deoj} ${epc}`);
      // 空のレスポンスを返す（既に処理中のリクエストがあるため）
      return new CommandResponse({
        ip,
        seoj,
        deoj,
        esv: ELSV.GET,
        epc,
        edt: "",
        tid: ""
      });
    }

    // リクエストを保留中としてマーク
    pending.add(requestKey);
    Logger.debug("[ECHONETLite][dedup]", `GET request started: ${ip} ${deoj} ${epc}`);

    try {
      const result = await this.execPromise({
        ip,
        seoj,
        deoj,
        esv: ELSV.GET,
        epc,
        edt: "",
        tid: ""
      }, options?.priority || 'normal', options?.onSuccess, options?.onFailure);
      Logger.debug("[ECHONETLite][dedup]", `GET request completed: ${ip} ${deoj} ${epc}`);
      return result;
    } finally {
      // 完了後、保留中マークを削除（クリーンアップ）
      pending.delete(requestKey);
      if (pending.size === 0) {
        this.pendingGets.delete(ip);
      }
    }
  }

  /**
   * SETリクエストを発行（重複排除あり）
   * 同じIP/EOJ/EPCが既にあった場合、新しいものは握りつぶし、古いものの値を最新値で上書きする
   * 重複時のonSuccess/onFailureの対処は考えるのが面倒なので上流のAPIからは外している。呼び出し主体が違う場合は面倒なことになるはず。TODO
   */
  public requestSet = async (
    ip: string,
    seoj: string,
    deoj: string,
    epc: string,
    edt: string,
    options?: {
      priority?: QueuePriority;
      onSuccess?: () => void;
      onFailure?: () => void;
    }
  ): Promise<CommandResponse> => {
    const requestKey = `SET:${deoj}:${epc}`;

    // IP別の保留中SETリクエストマップを取得または作成
    if (!this.pendingSets.has(ip)) {
      this.pendingSets.set(ip, new Map());
    }
    const pending = this.pendingSets.get(ip)!;

    // 重複チェック
    if (pending.has(requestKey)) {
      // 既に同じSETが保留中 → 最新値で上書き
      const existingRequest = pending.get(requestKey)!;
      existingRequest.edt = edt;
      Logger.debug("[ECHONETLite][dedup]", `SET request updated with new value: ${ip} ${deoj} ${epc} = ${edt}`);
      return existingRequest.promise;
    }

    // 新規SETリクエスト
    Logger.debug("[ECHONETLite][dedup]", `SET request started: ${ip} ${deoj} ${epc} = ${edt}`);

    // 実行用のデータ構造を作成
    const request = {
      edt,
      promise: null as unknown as Promise<CommandResponse>
    };

    // Promiseを作成して保存
    request.promise = (async () => {
      try {
        // 実行直前の最新値を取得（他のリクエストで上書きされている可能性がある）
        const latestEdt = request.edt;
        Logger.debug("[ECHONETLite][dedup]", `SET request executing: ${ip} ${deoj} ${epc} = ${latestEdt}`);

        const result = await this.execPromise({
          ip,
          seoj,
          deoj,
          esv: ELSV.SETC,
          epc,
          edt: latestEdt,
          tid: ""
        }, options?.priority || 'priority', options?.onSuccess, options?.onFailure);  // SETはデフォルトで最優先
        Logger.debug("[ECHONETLite][dedup]", `SET request completed: ${ip} ${deoj} ${epc}`);
        return result;
      } finally {
        // 完了後、保留中マークを削除（クリーンアップ）
        pending.delete(requestKey);
        if (pending.size === 0) {
          this.pendingSets.delete(ip);
        }
      }
    })();

    pending.set(requestKey, request);
    return request.promise;
  }

  public execPromise = (
    command:Command,
    priority: QueuePriority = 'normal',
    onSuccess?: () => void,
    onFailure?: () => void
  ):Promise<CommandResponse> =>
  {
    return new Promise<CommandResponse>((resolve, reject)=>{
      const ip = command.ip;
      const queue = this.getOrCreateIpQueue(ip);
      const commandWithCallback: CommandWithCallback = {
        callback: (res)=>{ resolve(res); },
        priority,
        onSuccess,
        onFailure,
        ...command
      };

      // 優先度に応じてキューに追加
      if (priority === 'priority') {
        queue.prioritySendQueue.push(commandWithCallback);
      } else if (priority === 'background') {
        queue.backgroundSendQueue.push(commandWithCallback);
      } else {
        queue.normalSendQueue.push(commandWithCallback);
      }

      Logger.debug("[ECHONETLite][queue]", `Command queued for ${ip} (priority=${priority}), infQueue=${queue.infQueue.length}, priority=${queue.prioritySendQueue.length}, normal=${queue.normalSendQueue.length}, background=${queue.backgroundSendQueue.length}`);
      if (queue.processing === false) {
        this.processQueueForIp(ip); // キュープロセッサ起動
      }
    });
  }

  private static convertToInstanceList(data: string): string[] {
    const result: string[] = [];
    for (let i = 2; i < data.length; i += 6) {
      const eoj = data.substring(i, i + 6);
      result.push(eoj);
    }
    return result;
  }

  public static convertToPropertyList(rawData:string): string[] | undefined
  {
    if(rawData.length < 2)
    {
      return undefined;
    }
    const result:string[] = [];
    for(let i=2;i<rawData.length;i+=2)
    {
      const epc = rawData.substring(i, i+2).toLowerCase();
      if(epc.match(/[0-9a-f]{2}/) === null)
      {
        return undefined;
      }
      result.push(epc);
    }
    return result;
  }

  private findProperty = (ip: string, eoj: string, epc: string): RawDeviceProperty | undefined  =>{
    const node = this.nodes.find(_ => _.ip === ip);
    if (node === undefined) {
      return undefined;
    }
    const device = node.devices.find(_ => _.eoj === eoj);
    if (device === undefined) {
      return undefined;
    }
    const property = device.properties.find(_ => _.epc === epc);
    if (property === undefined) {
      return undefined;
    }
    return property;
  }

  private async getProperty(ip: string, eoj: string, epc: string): Promise<string | undefined> {
    let res: CommandResponse;
    try {
      res = await this.execPromise({
        ip: ip,
        seoj: '0ef001',
        deoj: eoj,
        esv: ELSV.GET,
        epc: epc,
        edt: "",
        tid: ""
      }, 'priority');
    }
    catch (e) {
      Logger.warn("[ECHONETLite][raw]", `error getProperty: timeout ${ip} ${eoj} ${epc}`, {exception:e});
      return undefined;
    }
    const response = res.matchResponse(_=>_.els.ESV === ELSV.GET_RES && (epc in _.els.DETAILs));
    if(response === undefined)
    {
      Logger.warn("[ECHONETLite][raw]", `error getProperty: ${ip} ${eoj} ${epc}`, {responses:res.responses, command:res.command});
      return undefined;
    }

    return response.els.DETAILs[epc];
  }

  // 単一デバイスの詳細情報を収集（内部は直列処理でデバイス保護）
  private async collectDeviceDetails(device: RawDevice, nodeIp: string): Promise<void> {
    // GET/SET/INFのプロパティマップを受信する（単一デバイスに対しては直列実行）
    for(const epc of ["9f", "9e", "9d"])
    {
      let res: CommandResponse;
      try
      {
        res = await this.execPromise({
          ip: nodeIp,
          seoj: "0ef001",
          deoj: device.eoj,
          esv: ELSV.GET,
          epc: epc,
          edt: "",
          tid: ""
        }, 'priority');
      }
      catch(e)
      {
        Logger.warn("[ECHONETLite][raw]", `error collectDeviceDetails: get ${epc}: exception from ${nodeIp},${device.eoj} err=${(e as Error).message}`, {exception:e});
        continue;
      }
      const response = res.matchResponse(_=>_.els.ESV === ELSV.GET_RES && (epc in _.els.DETAILs));
      if(response === undefined)
      {
        Logger.warn("[ECHONETLite][raw]", `error collectDeviceDetails: get ${epc} from ${nodeIp},${device.eoj}`, {responses:res.responses, command:res.command});
        continue;
      }

      const edt = response.els.DETAILs;
      const data = edt[epc];
      const propertyList = EchoNetLiteRawController.convertToPropertyList(data);
      if(propertyList === undefined)
      {
        Logger.warn("[ECHONETLite][raw]", `error collectDeviceDetails: get ${epc}: invalid receive data ${nodeIp},${device.eoj} ${JSON.stringify(edt)}`, {responses:res.responses, command:res.command});
        continue;
      }
      for(const propertyMapEpc of propertyList)
      {
        let matchProperty = device.properties.find(_ => _.epc === propertyMapEpc);
        if (matchProperty === undefined) {
          matchProperty = {
            ip: nodeIp,
            eoj: device.eoj,
            epc: propertyMapEpc,
            value: "",
            operation: {
              get: false,
              set: false,
              inf: false
            }
          };
          device.properties.push(matchProperty);
        }
        if(epc === "9f"){
          matchProperty.operation.get = true;
        }
        if(epc === "9e"){
          matchProperty.operation.set = true;
        }
        if(epc === "9d"){
          matchProperty.operation.inf = true;
        }
      }

      // 受信したデータをプロパティとして格納する
      for (const epc in edt) {
        let matchProperty = device.properties.find(_ => _.epc === epc);
        if (matchProperty === undefined) {
          matchProperty = {
            ip: nodeIp,
            eoj: device.eoj,
            epc: epc,
            value: "",
            operation: {
              get: false,
              set: false,
              inf: false
            }
          };
          device.properties.push(matchProperty);
        }

        matchProperty.value = edt[epc];
      }
    }

    // 取得していないgetプロパティを取得する
    const epcList = device.properties.filter(_ => _.operation.get).filter(_ => _.value === "").map(_ => _.epc);
    for (const epc of epcList) {
      const value = await this.getProperty(nodeIp, device.eoj, epc);
      if (value === undefined) {
        continue;
      }
      const matchProperty = device.properties.find(_ => _.epc === epc);
      if (matchProperty === undefined) {
        throw Error("ありえない");
      }
      matchProperty.value = value;
    }

    // 83 (識別番号)を取得していないのなら取得する
    // 本来、9f (getプロパティリスト)にないなら取得する必要はないのだが、過去バージョンでは9fに関わらずgetしていたので
    // 互換性のために取得する。
    // なお、9fに無くても、要求すると83を取得できるデバイスもある。
    const idProperty = device.properties.find(_ => _.epc === "83");
    if (idProperty === undefined) {
      let res: CommandResponse;
      try {
        res = await this.execPromise({
          ip: device.ip,
          seoj: '0ef001',
          deoj: device.eoj,
          esv: ELSV.GET,
          epc: "83",
          edt: "",
          tid: ""
        }, 'priority');
      }
      catch (e) {
        device.noExistsId = true;
        return;
      }

      const response = res.matchResponse(_=>_.els.ESV === ELSV.GET_RES && ("83" in _.els.DETAILs));

      if(response === undefined)
      {
        device.noExistsId = true;
      }
      else
      {
        const data = response.els.DETAILs;
        let matchProperty = device.properties.find(_ => _.epc === "83");
        if (matchProperty === undefined) {
          matchProperty = {
            ip: nodeIp,
            eoj: device.eoj,
            epc: "83",
            value: "",
            operation: {
              get: false,
              set: false,
              inf: false
            }
          };
          device.properties.push(matchProperty);
        }
        matchProperty.value = data["83"];
      }
    }
  }

  /**
   * デバイス詳細収集を非同期で開始（Fire-and-Forget）
   * INF/d6応答処理後にawaitせずに呼び出すことで、キュー処理をブロックしない
   */
  private startDeviceCollection(ip: string): void {
    // 非同期処理を開始するが、awaitしない（fire-and-forget）
    this.runDeviceCollection(ip).catch(e => {
      Logger.error("[ECHONETLite][discovery]", `Device collection failed for ${ip}`, {exception: e});
    });
  }

  /**
   * デバイス詳細収集の実処理（非同期、排他制御付き）
   * プロパティが空のデバイスのみを収集対象とする
   */
  private async runDeviceCollection(ip: string): Promise<void> {
    // Mutexで排他制御
    const mutex = this.getDeviceCollectionMutex(ip);

    await mutex.runExclusive(async () => {
      const node = this.nodes.find(n => n.ip === ip);
      if (!node) {
        Logger.warn("[ECHONETLite][discovery]", `${ip}: Node not found for collection`);
        return;
      }

      // プロパティが空のデバイスのみを収集対象とする（新しいデバイスのみ）
      const devicesToCollect = node.devices.filter(device => device.properties.length === 0);

      if (devicesToCollect.length === 0) {
        Logger.debug("[ECHONETLite][discovery]", `${ip}: No devices to collect (all devices already have properties)`);
        return;
      }

      Logger.info("[ECHONETLite][discovery]", `${ip}: Starting device collection for ${devicesToCollect.length} devices`);

      // 各デバイスの詳細を収集（ここではawaitを使える）
      let successCount = 0;
      for (const device of devicesToCollect) {
        try {
          await this.collectDeviceDetails(device, ip);
          // プロパティが追加されたか確認
          if (device.properties.length > 0) {
            successCount++;
            Logger.debug("[ECHONETLite][discovery]", `${ip}: Collected ${device.properties.length} properties for device ${device.eoj}`);
          } else {
            Logger.warn("[ECHONETLite][discovery]", `${ip}: No properties collected for device ${device.eoj}`);
          }
        } catch (e) {
          Logger.warn("[ECHONETLite][discovery]", `${ip}: Failed to collect details for device ${device.eoj}`, {exception: e});
          // 1つのデバイスが失敗しても他のデバイスの収集は続行
        }
      }

      // 収集完了をマーク（全デバイスがプロパティを持っている場合のみ）
      const allDevicesHaveProperties = node.devices.every(device => device.properties.length > 0);
      const devicesWithoutProperties = node.devices.filter(device => device.properties.length === 0);

      if (allDevicesHaveProperties) {
        node.discoveryComplete = true;
        Logger.info("[ECHONETLite][discovery]", `${ip}: Device collection completed (${successCount}/${devicesToCollect.length} devices), PropertySync enabled`);
      } else {
        Logger.warn("[ECHONETLite][discovery]", `${ip}: Device collection incomplete (${successCount}/${devicesToCollect.length} succeeded), ${devicesWithoutProperties.length} devices without properties: ${devicesWithoutProperties.map(d => d.eoj).join(", ")}`);
      }

      // デバイス詳細が揃ったので、改めてデバイス検出を通知
      this.fireDeviceDetected(node.ip, node.devices.map(_=>_.eoj));
    });
  }

  /**
   * Discoveryキューを処理し、デバイス探索・登録を行う（コアループのサブルーチン）
   * d5 (INF), d6 (GET_RES) の両方を処理
   *
   * 設計ルール: 同一IP内では直列実行、異なるIP間は並列実行（別のprocessQueueForIp）
   */
  private async processDiscoveryQueue(ip: string, queue: ReturnType<typeof this.getOrCreateIpQueue>): Promise<number> {
    let discoveryProcessed = 0;
    while (queue.discoveryQueue.length > 0) {
      const item = queue.discoveryQueue.shift();
      if (item === undefined) {
        throw Error("ありえない");
      }
      discoveryProcessed++;

      const foundNode = this.nodes.find(_ => _.ip === item.rinfo.address);

      // d5処理（同一IP内では直列）
      if ("d5" in item.els.DETAILs) {
        await this.handleD5Notification(item, foundNode);
      }
      // d6処理（同一IP内では直列）
      else if ("d6" in item.els.DETAILs) {
        await this.handleD6Response(item, foundNode);
      }
    }

    if(discoveryProcessed > 0) {
      Logger.debug("[ECHONETLite][queue]", `${ip}: Processed ${discoveryProcessed} discovery items`);
    }
    return discoveryProcessed;
  }

  /**
   * INFキューを処理し、プロパティ値更新を行う（コアループのサブルーチン）
   * d5はdiscoveryQueueで処理されるため、ここでは通常のINFのみを処理
   */
  private async processInfQueue(ip: string, queue: ReturnType<typeof this.getOrCreateIpQueue>): Promise<number> {
    let infProcessed = 0;
    while (queue.infQueue.length > 0) {
      const inf = queue.infQueue.shift();
      if (inf === undefined) {
        throw Error("ありえない");
      }
      infProcessed++;

      const foundNode = this.nodes.find(_ => _.ip === inf.rinfo.address);

      if (foundNode === undefined) {
        continue; // 未登録ノードからのINFは無視
      }

      // プロパティ値更新処理
      await this.updatePropertiesFromInf(inf, foundNode);
    }

    if(infProcessed > 0) {
      Logger.debug("[ECHONETLite][queue]", `${ip}: Processed ${infProcessed} INF items`);
    }
    return infProcessed;
  }

  /**
   * d5(自ノードインスタンスリスト通知)を処理
   * ノンブロッキング：ノード登録のみ行い、詳細収集は非同期で開始
   */
  private async handleD5Notification(inf: Response, foundNode: RawNode | undefined): Promise<void> {
    await this.handleNodeInstanceList(inf, foundNode, "d5", "INF d5");
  }

  /**
   * d6(自ノードインスタンスリスト)応答を処理（GET_RES）
   * ノンブロッキング：ノード登録のみ行い、詳細収集は非同期で開始
   */
  private async handleD6Response(response: Response, foundNode: RawNode | undefined): Promise<void> {
    await this.handleNodeInstanceList(response, foundNode, "d6", "GET_RES d6");
  }

  /**
   * ノードインスタンスリスト（d5/d6）の共通処理
   * ノンブロッキング：ノード登録のみ行い、詳細収集は非同期で開始
   */
  private async handleNodeInstanceList(
    response: Response,
    foundNode: RawNode | undefined,
    propertyCode: "d5" | "d6",
    logLabel: string
  ): Promise<void> {
    const eojList = EchoNetLiteRawController.convertToInstanceList(response.els.DETAILs[propertyCode]);

    // 既存ノードの場合、新しいデバイスがあるかチェック
    if (foundNode !== undefined) {
      const newEojList = eojList.filter(newEoj =>
        foundNode.devices.find(currentDevice => currentDevice.eoj === newEoj) === undefined
      );

      if (newEojList.length === 0) {
        return; // 新しいデバイスがなければスキップ
      }

      Logger.info("[ECHONETLite][discovery]", `${response.rinfo.address}: Processing ${logLabel} (device update, ${newEojList.length} new devices)`);

      // 既存ノードに新しいデバイスを追加（既存デバイスは保持）
      newEojList.forEach(eoj => {
        foundNode.devices.push({
          ip: response.rinfo.address,
          eoj: eoj,
          properties: [],
          noExistsId: false
        });
      });

      // 新しいデバイスが追加されたため、探索未完了状態に戻す
      foundNode.discoveryComplete = false;

      // 新しいデバイスを通知（軽量な状態で）
      this.fireDeviceDetected(foundNode.ip, foundNode.devices.map(_=>_.eoj));

      // 新しいデバイスのみ収集対象（プロパティが空）
      this.startDeviceCollection(response.rinfo.address);

      Logger.info("[ECHONETLite][discovery]", `${response.rinfo.address}: New devices added, starting collection for new devices only`);
      return;
    }

    // 新規ノードの場合
    Logger.info("[ECHONETLite][discovery]", `${response.rinfo.address}: Processing ${logLabel} (new node discovery)`);

    // ノード構造を軽量に作成（詳細は後で収集）
    const nodeTemp: RawNode = {
      ip: response.rinfo.address,
      devices: [{
        ip: response.rinfo.address,
        eoj: "0ef001",
        properties: [],
        noExistsId: false
      }],
      discoveryComplete: false
    };

    eojList.forEach(eoj => {
      nodeTemp.devices.push({
        ip: response.rinfo.address,
        eoj: eoj,
        properties: [],
        noExistsId: false
      });
    });

    // ノードを登録（軽量、詳細なし）
    await this.updateOrAddNode(nodeTemp);
    this.fireDeviceDetected(nodeTemp.ip, nodeTemp.devices.map(_=>_.eoj));

    // デバイス詳細収集を非同期で開始（awaitしない！）
    this.startDeviceCollection(nodeTemp.ip);

    Logger.info("[ECHONETLite][discovery]", `${response.rinfo.address}: Node registered, starting device collection in background`);
  }

  /**
   * INFメッセージからプロパティ値を更新
   */
  private async updatePropertiesFromInf(inf: Response, foundNode: RawNode): Promise<void> {
    const foundDevice = foundNode.devices.find(_ => _.eoj === inf.els.SEOJ);
    if (foundDevice === undefined) {
      return; // 存在しないデバイスは無視
    }

    for (const epc in inf.els.DETAILs) {
      const foundProperty = foundDevice.properties.find(_ => _.epc === epc);
      if (foundProperty === undefined) {
        continue; // 存在しないプロパティは無視
      }

      const oldValue = foundProperty.value;
      foundProperty.value = inf.els.DETAILs[epc];

      // イベントを発火
      this.firePropertyChanged(
        foundProperty.ip,
        foundProperty.eoj,
        foundProperty.epc,
        oldValue,
        foundProperty.value);
    }
  }

  /**
   * sendQueueを処理し、コマンドを送信してレスポンスを処理
   */
  private async processSendQueue(ip: string, queue: ReturnType<typeof this.getOrCreateIpQueue>): Promise<number> {
    let sendProcessed = 0;

    while (queue.prioritySendQueue.length > 0 || queue.normalSendQueue.length > 0 || queue.backgroundSendQueue.length > 0) {
      let command: CommandWithCallback | undefined;
      let queueName: string = 'no_set';

      // 優先度順に1つのコマンドを取得
      if (queue.prioritySendQueue.length > 0) {
        command = queue.prioritySendQueue.shift();
        queueName = 'priority';
      } else if (queue.normalSendQueue.length > 0) {
        command = queue.normalSendQueue.shift();
        queueName = 'normal';
      } else if (queue.backgroundSendQueue.length > 0) {
        command = queue.backgroundSendQueue.shift();
        queueName = 'background';
      }

      if (command === undefined) {
        throw Error("ありえない");
      }

      sendProcessed++;
      Logger.debug("[ECHONETLite][queue]", `${ip}: Sending command (${queueName}) ${command.seoj}->${command.deoj} ESV=${command.esv} EPC=${command.epc}`);

      // コマンド送信
      const res = await this.sendCommand(command);

      // GET_RESの場合は値を更新（d6応答のデバイス探索処理を含む）
      if (res !== undefined) {
        await this.updatePropertiesFromResponse(res);
      }

      // 成功/失敗ハンドラを実行
      if (res !== undefined && command.onSuccess) {
        command.onSuccess();
      } else if (res === undefined && command.onFailure) {
        command.onFailure();
      }

      // コールバック実行
      if(command.callback !== undefined) {
        command.callback(res !== undefined ? res : new CommandResponse(command));
      }
    }

    if(sendProcessed > 0) {
      Logger.debug("[ECHONETLite][queue]", `${ip}: Processed ${sendProcessed} command items`);
    }
    return sendProcessed;
  }

  /**
   * コマンドを送信（タイムアウト処理込み）
   */
  private async sendCommand(command: CommandWithCallback): Promise<CommandResponse | undefined> {
    try {
      return await EchoNetCommunicator.execCommandPromise(
        command.ip,
        command.seoj,
        command.deoj,
        command.esv,
        command.epc,
        command.edt,
        undefined); // デフォルトタイムアウトを使用
    } catch(e) {
      Logger.warn("[ECHONETLite][raw]", `error send command: timeout ${command.ip} ${command.seoj} ${command.deoj} ${command.esv} ${command.epc} ${command.edt}`, {exception:e});
      return undefined;
    }
  }

  /**
   * GET_RESレスポンスからプロパティ値を更新（コアループのサブルーチン）
   */
  private async updatePropertiesFromResponse(res: CommandResponse): Promise<void> {
    for (const response of res.responses) {
      if(response.els.ESV !== ELSV.GET_RES) {
        continue;
      }

      const ip  = response.rinfo.address;
      const eoj = response.els.SEOJ;
      const els = response.els;

      // d6（自ノードインスタンスリスト）応答の場合、デバイス探索処理
      if (eoj === "0ef001" && "d6" in els.DETAILs) {
        const foundNode = this.nodes.find(_ => _.ip === ip);
        await this.handleD6Response(response, foundNode);
        continue; // d6処理後は通常のプロパティ更新はスキップ
      }

      // 通常のプロパティ更新処理
      for(const epc in els.DETAILs) {
        const newValue = els.DETAILs[epc];
        const matchProperty = this.findProperty(ip, eoj, epc);
        if (matchProperty === undefined) {
          continue;
        }

        const oldValue = matchProperty.value;
        matchProperty.value = newValue;

        // イベントを発火
        this.firePropertyChanged(
          matchProperty.ip,
          matchProperty.eoj,
          matchProperty.epc,
          oldValue,
          matchProperty.value);
      }
    }
  }

  // これがコアループ/キュープロセッサ。get, set, infは全てここを通る（はず）。
  // デバイス探索の要求送信は直接送信だが、応答（d6 GET_RES、d5 INF）はここを通る。
  // デバイス（IP）ごとに単一のキューを使って処理を直列化している。これにより、同一デバイスに対しては並列リクエストが発生しないように制御している。
  // 一方、このキューはデバイスごとに存在するため、異なるデバイスに対しては並列にリクエストが発生する。
  private processQueueForIp = async (ip: string):Promise<void> =>{
    const queue = this.getOrCreateIpQueue(ip);

    if (queue.processing) {
      Logger.debug("[ECHONETLite][queue]", `${ip}: Already processing, skipped`);
      return;
    }
    queue.processing = true;

    const startTime = Date.now();
    const initialDiscoveryCount = queue.discoveryQueue.length;
    const initialInfCount = queue.infQueue.length;
    const initialSendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
    Logger.debug("[ECHONETLite][queue]", `${ip}: Start processing (discovery=${initialDiscoveryCount}, inf=${initialInfCount}, send=${initialSendCount} [p=${queue.prioritySendQueue.length}, n=${queue.normalSendQueue.length}, b=${queue.backgroundSendQueue.length}])`);

    try {
      await this.processDiscoveryQueue(ip, queue);
      await this.processInfQueue(ip, queue);
      await this.processSendQueue(ip, queue);
    }
    finally {
      const elapsed = Date.now() - startTime;
      const remainingSendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
      Logger.debug("[ECHONETLite][queue]", `${ip}: Finished processing in ${elapsed}ms (remaining: discovery=${queue.discoveryQueue.length}, inf=${queue.infQueue.length}, send=${remainingSendCount})`);
    }

    // 処理完了: 必ずprocessingフラグをリセット
    queue.processing = false;

    const totalSendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
    if (queue.discoveryQueue.length > 0 || queue.infQueue.length > 0 || totalSendCount > 0) {
      // キューにまだアイテムがあればすぐに次の処理をスケジュール
      Logger.debug("[ECHONETLite][queue]", `${ip}: More items in queue (discovery=${queue.discoveryQueue.length}, inf=${queue.infQueue.length}, send=${totalSendCount}), scheduling next processing`);
      setTimeout(() => this.processQueueForIp(ip), 1);
    }
    // なければ一度終了し、次に処理を必要とするメソッドが呼ばれたときに起動される。
  }


  public initialize = async (
    objList:string[],
    echonetTargetNetwork:string,
    commandTimeout:number,
    knownDeviceIpList: string[] = [],
    enableMulticastSearch: boolean = false
  ):Promise<void> =>
  {
    this.knownDeviceIpList = knownDeviceIpList;
    this.enableMulticastSearch = enableMulticastSearch;

    await EchoNetCommunicator.initialize(objList, 4, { v4: echonetTargetNetwork, autoGetProperties: false },
      commandTimeout);
  }

  public searchDeviceFromIp = (ip: string): void => {
    // ユニキャスト送信のみ（ノンブロッキング）
    // d6応答はGET_RESとしてキュー経由で処理される
    Logger.info("[ECHONETLite][discovery]", `Sending unicast discovery request to ${ip} (non-blocking)`);
    EchoNetCommunicator.sendNow(ip, '0ef001', '0ef001', ELSV.GET, "d6", "");
  }

  public searchDevicesInNetwork = (): void => {
    // マルチキャスト送信のみ（ノンブロッキング）
    // d6応答はGET_RESとしてキュー経由で処理される
    Logger.info("[ECHONETLite][discovery]", "Sending multicast discovery request (non-blocking)");
    EchoNetCommunicator.sendNow('224.0.23.0', '0ef001', '0ef001', ELSV.GET, "d6", "");
  }

  /**
   * デバイス探索を実行（マルチキャスト + 指定IPへのユニキャスト）
   * 起動時と定期探索の両方から呼び出される共通メソッド
   */
  public executeDeviceSearch(): void {
    Logger.debug("[ECHONETLite][discovery]", "Executing device search");

    // 1. 指定IPへのユニキャスト探索
    if (this.knownDeviceIpList.length > 0) {
      Logger.info("[ECHONETLite][discovery]", `Sending unicast discovery to ${this.knownDeviceIpList.length} specified IPs`);
      this.knownDeviceIpList.forEach(ip => {
        this.searchDeviceFromIp(ip);
      });
    }

    // 2. マルチキャスト探索（有効な場合のみ）
    if (this.enableMulticastSearch) {
      Logger.info("[ECHONETLite][discovery]", "Sending multicast discovery request");
      this.searchDevicesInNetwork();
    }
  }

  /**
   * 定期探索の間隔を設定し、機能を有効化/無効化する
   * @param intervalSec 探索間隔（秒）。undefinedの場合は機能を無効化
   */
  public setPeriodicSearchInterval(intervalSec?: number): void {
    this.periodicSearchIntervalSec = intervalSec;

    if (intervalSec !== undefined && intervalSec > 0) {
      this.startPeriodicSearch();
    } else {
      this.stopPeriodicSearch();
    }
  }

  /**
   * 定期探索を開始する
   */
  private startPeriodicSearch(): void {
    if (this.periodicSearchTimer) {
      Logger.warn("[ECHONETLite][periodic-search]", "Periodic search already running");
      return;
    }

    if (!this.periodicSearchIntervalSec || this.periodicSearchIntervalSec <= 0) {
      Logger.warn("[ECHONETLite][periodic-search]", "Invalid interval, periodic search not started");
      return;
    }

    const intervalMs = this.periodicSearchIntervalSec * 1000;
    Logger.info("[ECHONETLite][periodic-search]", `Starting periodic device search (interval: ${this.periodicSearchIntervalSec}s)`);

    // 即座に1回実行
    this.executeDeviceSearch();

    // 定期実行を開始
    this.periodicSearchTimer = setInterval(() => {
      this.executeDeviceSearch();
    }, intervalMs);
  }

  /**
   * 定期探索を停止する
   */
  private stopPeriodicSearch(): void {
    if (this.periodicSearchTimer) {
      clearInterval(this.periodicSearchTimer);
      this.periodicSearchTimer = undefined;
      Logger.info("[ECHONETLite][periodic-search]", "Periodic device search stopped");
    }
  }

  private deviceDetectedListeners:((ip:string, eojList:string[])=>void)[] = [];
  public addDeviceDetectedEvent = (event:(ip:string, eojList:string[])=>void):void =>{
    this.deviceDetectedListeners.push(event);
  }
  private fireDeviceDetected = (ip:string, eojList:string[]):void=>{
    this.deviceDetectedListeners.forEach(_=>_(ip, eojList));
  }

  readonly propertyChangedHandlers:((ip:string, eoj:string, epc:string, oldValue:string, newValue:string) => void)[] = [];
  public addPropertyChangedHandler = (event:(ip:string, eoj:string, epc:string, oldValue:string, newValue:string) => void):void =>
  {
    this.propertyChangedHandlers.push(event);
  }
  public firePropertyChanged = (ip:string, eoj:string, epc:string, oldValue:string, newValue:string):void =>
  {
    this.propertyChangedHandlers.forEach(_=>_(ip, eoj, epc, oldValue, newValue));
  }


  readonly reveivedHandlers:((rinfo: rinfo, els: eldata) => void)[] = [];
  public addReveivedHandler = (event:(rinfo: rinfo, els: eldata) => void):void =>
  {
    this.reveivedHandlers.push(event);
  }
  public fireReceived = (rinfo: rinfo, els: eldata):void =>
  {
    this.reveivedHandlers.forEach(_=>_(rinfo, els));
  }


  public getSendQueueLength = ():number=>
  {
    return EchoNetCommunicator.getSendQueueLength();
  }

  public replySetDetail = (rinfo: rinfo, els: eldata, dev_details:DeviceDetailsType):Promise<void> =>
  {
    return EchoNetCommunicator.replySetDetail(rinfo, els, dev_details);
  }
  public replyGetDetail = (rinfo: rinfo, els: eldata, dev_details:DeviceDetailsType):Promise<void> =>
  {
    return EchoNetCommunicator.replyGetDetail(rinfo, els, dev_details);
  }

  public updateidentifierFromMacAddress = (base:number[]):number[] =>
  {
    return EchoNetCommunicator.updateidentifierFromMacAddress(base);
  }

  public getInternalStatus = ():unknown =>
  {
    return {
      elData:EchoNetCommunicator.getFacilities(),
      nodes:this.nodes
    };
  }

  public getDeduplicationStatus = ():unknown =>
  {
    let totalPendingGets = 0;
    let totalPendingSets = 0;

    for (const pending of this.pendingGets.values()) {
      totalPendingGets += pending.size;
    }

    for (const pending of this.pendingSets.values()) {
      totalPendingSets += pending.size;
    }

    return {
      pendingGetRequests: totalPendingGets,
      pendingSetRequests: totalPendingSets,
      ipCount: Math.max(this.pendingGets.size, this.pendingSets.size)
    };
  }

  public getRawDataSet = ():RawDataSet =>
  {
    return new RawDataSetforNodes(this.nodes);
  }
}

class RawDataSetforNodes implements RawDataSet
{
  private readonly nodes:RawNode[] = [];
  constructor(nodes:RawNode[])
  {
    this.nodes = nodes;
  }
  public existsDevice = (ip: string, eoj: string):boolean =>
  {
    const node = this.nodes.find(_=>_.ip === ip);
    if(node === undefined)
    {
      return false;
    }
    const device = node.devices.find(_=>_.eoj === eoj);
    if(device === undefined)
    {
      return false;
    }
    return true;
  }
  public existsData = (ip: string, eoj: string, epc: string):boolean =>
  {
    const node = this.nodes.find(_=>_.ip === ip);
    if(node === undefined)
    {
      return false;
    }
    const device = node.devices.find(_=>_.eoj === eoj);
    if(device === undefined)
    {
      return false;
    }
    const property = device.properties.find(_=>_.epc === epc);
    if(property === undefined)
    {
      return false;
    }
    return true;
  }
  public getIpList = ():string[] =>
  {
    return this.nodes.map(_=>_.ip);
  }

  public getEojList = (ip: string):string[] =>
  {
    const node = this.nodes.find(_=>_.ip === ip);
    if(node === undefined)
    {
      return [];
    }
    return node.devices.map(_=>_.eoj);
  }

  public getRawData = (ip: string, eoj: string, epc: string):string | undefined =>
  {
    const node = this.nodes.find(_=>_.ip === ip);
    if(node === undefined)
    {
      return undefined;
    }
    const device = node.devices.find(_=>_.eoj === eoj);
    if(device === undefined)
    {
      return undefined;
    }
    const property = device.properties.find(_=>_.epc === epc);
    if(property === undefined)
    {
      return undefined;
    }
    return property.value;
  }


}

export interface RawNode
{
  ip:string;
  devices:RawDevice[];
  discoveryComplete:boolean; // true: デバイス探索完了、PropertySync対象
}
interface RawDevice
{
  ip:string;
  eoj:string;
  properties:RawDeviceProperty[];
  noExistsId:boolean;
}
export interface RawDeviceProperty
{
  ip:string;
  eoj:string;
  epc:string;
  value:string;
  operation:{
    get:boolean;
    set:boolean;
    inf:boolean;
  }
}