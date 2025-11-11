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
  // ディスカバリ時の長めのタイムアウト（応答が遅いデバイスに対応するため5秒に設定）
  private static readonly DISCOVERY_TIMEOUT = 5000;

  private readonly nodes: RawNode[] = [];
  private readonly nodesUpdateMutex = new Mutex();
  private propertySyncManager?: PropertySyncManager;
  private deviceStore?: DeviceStore;

  // IP別のキュー構造
  private readonly ipQueues: Map<string, {
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

  // IP別キューの取得または作成
  private getOrCreateIpQueue(ip: string) {
    let queue = this.ipQueues.get(ip);
    if (!queue) {
      queue = {
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

    // 既に検出済みのデバイスに対してキューループをキックスタート
    const uniqueIps = [...new Set(this.nodes.map(node => node.ip))];
    for (const ip of uniqueIps) {
      const queue = this.getOrCreateIpQueue(ip);
      if (!queue.processing) {
        Logger.info("[PropertySync]", `Kickstarting queue loop for existing device ${ip}`);
        this.processQueueForIp(ip);
      }
    }
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

  // デバイス収集の排他制御（ノードIP別）
  // 同一ノードに対する並行getNewNode呼び出しを防ぎ、デバイスへの並列リクエストを回避
  private async getNewNodeWithLock(node: RawNode): Promise<RawNode> {
    const nodeKey = node.ip;

    // IP別のMutexを取得または作成
    if (!this.deviceCollectionMutexes.has(nodeKey)) {
      this.deviceCollectionMutexes.set(nodeKey, new Mutex());
    }
    const mutex = this.deviceCollectionMutexes.get(nodeKey)!;

    return mutex.runExclusive(async () => {
      Logger.debug("[ECHONETLite][lock]", `Starting device collection for ${nodeKey}`);
      const result = await EchoNetLiteRawController.getNewNode(node);
      Logger.debug("[ECHONETLite][lock]", `Completed device collection for ${nodeKey}`);
      return result;
    });
  }

  constructor() {
    
    EchoNetCommunicator.addReveivedHandler((rinfo, els) => {
      if (els.ESV === ELSV.INF) {
        const ip = rinfo.address;
        const queue = this.getOrCreateIpQueue(ip);
        queue.infQueue.push({
          rinfo: rinfo,
          els: els
        });
        const sendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
        Logger.debug("[ECHONETLite][queue]", `INF queued for ${ip}, infQueue=${queue.infQueue.length}, sendQueue=${sendCount}`);
        if (queue.processing === false) {
          // INFの処理
          this.processQueueForIp(ip); // キュープロセッサ起動
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
   * 同じIP/EOJ/EPCへの同時リクエストは1つに統合される
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
   * 同じIP/EOJ/EPCへの連続リクエストは最新値のみが実行される
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

  private static getProperty = async (ip: string, eoj: string, epc: string): Promise<string | undefined> =>{
    let res: CommandResponse;
    try {
      res = await EchoNetCommunicator.execCommandPromise(ip, '0ef001', eoj, ELSV.GET, epc, "");
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
  private static async collectDeviceDetails(device: RawDevice, nodeIp: string): Promise<void> {
    // GET/SET/INFのプロパティマップを受信する（単一デバイスに対しては直列実行）
    for(const epc of ["9f", "9e", "9d"])
    {
      let res: CommandResponse;
      try
      {
        res = await EchoNetCommunicator.execCommandPromise(nodeIp, "0ef001", device.eoj, ELSV.GET, epc, "", EchoNetLiteRawController.DISCOVERY_TIMEOUT);
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
      const value = await EchoNetLiteRawController.getProperty(nodeIp, device.eoj, epc);
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
        res = await EchoNetCommunicator.execCommandPromise(device.ip, '0ef001', device.eoj, ELSV.GET, "83", "", EchoNetLiteRawController.DISCOVERY_TIMEOUT);
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

  private static async getNewNode(node: RawNode): Promise<RawNode> {
    const result: RawNode = {
      ip: node.ip,
      devices: node.devices.map(_ => ({
        ip: _.ip,
        eoj: _.eoj,
        properties: [],
        noExistsId: false
      }))
    };

    // IPごとに直列処理（おそらく物理的には一つのIPに対して1コントローラだと思われるので）
    for (const device of result.devices) {
      try {
        await EchoNetLiteRawController.collectDeviceDetails(device, result.ip);
      } catch (e) {
        Logger.warn("[ECHONETLite][raw]", `Failed to collect details for device ${device.eoj} on ${result.ip}`, {exception: e});
        // 1つのデバイスが失敗しても他のデバイスの収集は続行
      }
    }

    return result;
  }




  /**
   * INFキューを処理し、デバイス検出とプロパティ値更新を行う（コアループのサブルーチン）
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

      // 新規ノードまたは既存ノードのd5処理
      if ("d5" in inf.els.DETAILs) {
        await this.handleD5Notification(inf, foundNode);
        if (foundNode === undefined) {
          continue; // 新規ノードの場合、プロパティ更新はスキップ
        }
      }

      if (foundNode === undefined) {
        continue; // d5がない新規ノードは無視
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
   */
  private async handleD5Notification(inf: Response, foundNode: RawNode | undefined): Promise<void> {
    const eojList = EchoNetLiteRawController.convertToInstanceList(inf.els.DETAILs["d5"]);

    // 既存ノードの場合、新しいデバイスがあるかチェック
    if (foundNode !== undefined) {
      const hasNewDevices = eojList.some(newEoj =>
        foundNode.devices.find(currentDevice => currentDevice.eoj === newEoj) === undefined
      );
      if (!hasNewDevices) {
        return; // 新しいデバイスがなければスキップ
      }
      Logger.debug("[ECHONETLite][queue]", `${inf.rinfo.address}: Processing INF d5 (device update)`);
    } else {
      Logger.debug("[ECHONETLite][queue]", `${inf.rinfo.address}: Processing INF d5 (new node discovery)`);
    }

    // ノード構造を作成
    const nodeTemp: RawNode = {
      ip: inf.rinfo.address,
      devices: [{
        ip: inf.rinfo.address,
        eoj: "0ef001",
        properties: [],
        noExistsId: false
      }]
    };

    eojList.forEach(eoj => {
      nodeTemp.devices.push({
        ip: inf.rinfo.address,
        eoj: eoj,
        properties: [],
        noExistsId: false
      });
    });

    // 排他制御付きでノード詳細を取得
    const newNode = await this.getNewNodeWithLock(nodeTemp);
    await this.updateOrAddNode(newNode);
    this.fireDeviceDetected(newNode.ip, newNode.devices.map(_=>_.eoj));
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

    // 優先度順に処理：priority → normal → background
    const queues = [
      { queue: queue.prioritySendQueue, name: 'priority' },
      { queue: queue.normalSendQueue, name: 'normal' },
      { queue: queue.backgroundSendQueue, name: 'background' }
    ];

    while (queue.prioritySendQueue.length > 0 || queue.normalSendQueue.length > 0 || queue.backgroundSendQueue.length > 0) {
      let command: CommandWithCallback | undefined;
      let queueName: string = 'no_set'

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

      // GET_RESの場合は値を更新
      if (res !== undefined) {
        this.updatePropertiesFromResponse(res);
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
        command.edt);
    } catch(e) {
      Logger.warn("[ECHONETLite][raw]", `error send command: timeout ${command.ip} ${command.seoj} ${command.deoj} ${command.esv} ${command.epc} ${command.edt}`, {exception:e});
      return undefined;
    }
  }

  /**
   * GET_RESレスポンスからプロパティ値を更新（コアループのサブルーチン）
   */
  private updatePropertiesFromResponse(res: CommandResponse): void {
    res.responses.forEach((response):void => {
      if(response.els.ESV !== ELSV.GET_RES) {
        return;
      }

      const ip  = response.rinfo.address;
      const eoj = response.els.SEOJ;
      const els = response.els;

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
    });
  }

  // これがコアループ/キュープロセッサ。get, set, infは全てここを通る（はず）。
  // ディスカバリ系はこっちを通らないので注意。(ただしd5 = 自ノードインスタンスリスト通知はここを通る)
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
    const initialInfCount = queue.infQueue.length;
    const initialSendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
    Logger.debug("[ECHONETLite][queue]", `${ip}: Start processing (inf=${initialInfCount}, send=${initialSendCount} [p=${queue.prioritySendQueue.length}, n=${queue.normalSendQueue.length}, b=${queue.backgroundSendQueue.length}])`);

    try {
      await this.processInfQueue(ip, queue);
      await this.processSendQueue(ip, queue);
    }
    finally {
      const elapsed = Date.now() - startTime;
      const remainingSendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
      Logger.debug("[ECHONETLite][queue]", `${ip}: Finished processing in ${elapsed}ms (remaining: inf=${queue.infQueue.length}, send=${remainingSendCount})`);
    }

    // 処理完了: 必ずprocessingフラグをリセット
    queue.processing = false;

    const totalSendCount = queue.prioritySendQueue.length + queue.normalSendQueue.length + queue.backgroundSendQueue.length;
    if (queue.infQueue.length > 0 || totalSendCount > 0) {
      // キューにまだアイテムがあればすぐに次の処理をスケジュール
      Logger.debug("[ECHONETLite][queue]", `${ip}: More items in queue (inf=${queue.infQueue.length}, send=${totalSendCount}), scheduling next processing`);
      setTimeout(() => this.processQueueForIp(ip), 1);
    }
    // なければ一度終了し、次に処理を必要とするメソッドが呼ばれたときに起動される。
  }


  public initialize = async (objList:string[], echonetTargetNetwork:string, commandTimeout:number):Promise<void> =>
  {
    await EchoNetCommunicator.initialize(objList, 4, { v4: echonetTargetNetwork, autoGetProperties: false },
      commandTimeout);
  }

  public searchDeviceFromIp = async (ip:string):Promise<void> =>
  {
    const startTime = Date.now();
    Logger.debug("[ECHONETLite][discovery]", `Starting device discovery for ${ip}`);

    let res: CommandResponse;
    try {
      res = await EchoNetCommunicator.execCommandPromise(ip, '0ef001', '0ef001', ELSV.GET, "d6", "", EchoNetLiteRawController.DISCOVERY_TIMEOUT);
    }
    catch (e) {
      Logger.warn("[ECHONETLite][discovery]", `Discovery failed for ${ip}: timeout`, {exception:e});
      return undefined;
    }
    const response = res.matchResponse(_=>_.els.ESV === ELSV.GET_RES && ("d6" in _.els.DETAILs));
    if(response === undefined)
    {
      Logger.warn("[ECHONETLite][discovery]", `Discovery failed for ${ip}: no valid response`, {responses:res.responses, command:res.command});
      return;
    }

    const node: RawNode = {
      ip: response.rinfo.address,
      devices: [
        {
          ip: response.rinfo.address,
          eoj: "0ef001",
          properties: [],
          noExistsId: false
        }
      ]
    };
    const deviceCount = EchoNetLiteRawController.convertToInstanceList(response.els.DETAILs["d6"]).length;
    EchoNetLiteRawController.convertToInstanceList(response.els.DETAILs["d6"]).forEach(eoj => {
      node.devices.push({
        ip: response.rinfo.address,
        eoj: eoj,
        properties: [],
        noExistsId: false
      });
    });

    Logger.debug("[ECHONETLite][discovery]", `Found ${deviceCount} devices on ${ip}, fetching details`);

    // ノードの詳細を取得する（排他制御付き）
    const newNode = await this.getNewNodeWithLock(node);
    await this.updateOrAddNode(newNode);
    this.fireDeviceDetected(newNode.ip, newNode.devices.map(_=>_.eoj));

    const elapsed = Date.now() - startTime;
    Logger.info("[ECHONETLite][discovery]", `Device discovery for ${ip} completed in ${elapsed}ms (${deviceCount} devices)`);
  }

  public searchDevicesInNetwork = async (): Promise<void> =>{

    // ネットワーク内のすべてのノードからd6(自ノードインスタンスリスト)を取得する
    const res = await EchoNetCommunicator.getForTimeoutPromise(
      '224.0.23.0',
      '0ef001',
      '0ef001',
      ELSV.GET,
      "d6",
      "",
      5000);

    Logger.info("[ECHONETLite][discovery]", `Received ${res.responses.length} responses from multicast`);

    // 取得結果から、ノードを作成する
    var nodesTemp = res.responses.map((response): RawNode|undefined => {
      if(response.els.ESV !== ELSV.GET_RES)
      {
        return undefined;
      }
      const result: RawNode = {
        ip: response.rinfo.address,
        devices: [
          {
            ip: response.rinfo.address,
            eoj: "0ef001",
            properties: [],
            noExistsId: false
          }
        ]
      };

      if ("d6" in response.els.DETAILs) {
        EchoNetLiteRawController.convertToInstanceList(response.els.DETAILs["d6"]).forEach(eoj => {
          result.devices.push({
            ip: response.rinfo.address,
            eoj: eoj,
            properties: [],
            noExistsId: false
          });
        });
      }
      return result;
    }).filter(_=>_!==undefined);

    // ノードの詳細を取得する（ノード間は並列処理）
    const startTime = Date.now();
    const nodeIps = nodesTemp.map(n => n?.ip).join(", ");
    Logger.info("[ECHONETLite][discovery]", `Starting parallel node discovery for ${nodesTemp.length} nodes: [${nodeIps}]`);

    const newNodesResults = await Promise.allSettled(
      nodesTemp.map(async (node) => {
        if(node === undefined) {
          throw Error("ありえない");
        }
        const nodeStartTime = Date.now();
        Logger.debug("[ECHONETLite][discovery]", `Starting node detail collection for ${node.ip}`);

        // 排他制御付きでノード詳細を取得
        const newNode = await this.getNewNodeWithLock(node);

        const nodeElapsed = Date.now() - nodeStartTime;
        const deviceCount = newNode.devices.length;
        Logger.info("[ECHONETLite][discovery]", `Node detail collection for ${node.ip} completed in ${nodeElapsed}ms (${deviceCount} devices)`);

        return newNode;
      })
    );

    // 結果を処理（こちらは順次処理で排他制御）
    let successCount = 0;
    let failCount = 0;
    for (const result of newNodesResults) {
      if (result.status === "fulfilled") {
        const newNode = result.value;
        await this.updateOrAddNode(newNode);
        this.fireDeviceDetected(newNode.ip, newNode.devices.map(_=>_.eoj));
        successCount++;
      } else {
        failCount++;
        Logger.warn("[ECHONETLite][discovery]", `Node discovery failed: ${result.reason}`);
      }
    }

    const totalElapsed = Date.now() - startTime;
    Logger.info("[ECHONETLite][discovery]", `Network discovery completed in ${totalElapsed}ms (success=${successCount}, failed=${failCount})`);
  }

  private deviceDetectedListeners:((ip:string, eojList:string[])=>void)[] = [];
  public addDeviceDetectedEvent = (event:(ip:string, eojList:string[])=>void):void =>{
    this.deviceDetectedListeners.push(event);
  }
  private fireDeviceDetected = (ip:string, eojList:string[]):void=>{
    this.deviceDetectedListeners.forEach(_=>_(ip, eojList));

    // PropertySyncが有効な場合、このIPのキューループをキックスタート
    if (this.propertySyncManager && this.deviceStore) {
      const queue = this.getOrCreateIpQueue(ip);
      if (!queue.processing) {
        Logger.info("[PropertySync]", `Kickstarting queue loop for ${ip} after device detection`);
        this.processQueueForIp(ip);
      }
    }
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