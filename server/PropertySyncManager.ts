import * as fs from "fs";
import { Logger } from "./Logger";
import { Device } from "./Property";
import { DeviceStore } from "./DeviceStore";
import { Mutex } from "async-mutex";

interface SyncRule {
  deviceClass: string;
  properties: string[];
  intervalSec: number;
}

interface SyncConfig {
  syncRules: SyncRule[];
}

type PropertyStatus = 'fresh' | 'needsUpdate';

interface PropertyState {
  status: PropertyStatus;
  lastUpdated: number;
  timeoutCount: number;
  intervalSec: number;
  backoffMultiplier: number;
}

interface UpdateRequest {
  ip: string;
  eoj: string;
  epc: string;
  propertyName: string;
}

export class PropertySyncManager {
  private config?: SyncConfig;
  private readonly propertyStates: Map<string, Map<string, Map<string, PropertyState>>> = new Map();
  private timerHandle?: NodeJS.Timeout;
  private deviceStore?: DeviceStore;
  private requestDevicePropertyFn?: (id: {id:string, ip:string, eoj:string, internalId:string}, propertyName: string, options?: any) => Promise<void>;
  private readonly syncMutex = new Mutex();

  constructor() {
  }

  /**
   * 設定ファイルを読み込む
   */
  public loadConfig(path: string): void {
    try {
      const content = fs.readFileSync(path, "utf-8");
      this.config = JSON.parse(content) as SyncConfig;
      Logger.info("[PropertySync]", `Loaded config from ${path}: ${this.config.syncRules.length} rules`);
    } catch (e) {
      Logger.error("[PropertySync]", `Failed to load config from ${path}`, {exception: e});
      this.config = undefined;
    }
  }

  /**
   * 指定IPのデバイスプロパティをチェックし、更新が必要なリクエストを返す
   */
  public checkAndRequestUpdates(ip: string, deviceStore: DeviceStore): UpdateRequest[] {
    if (!this.config) return [];

    const devices = deviceStore.getAll().filter(d => d.ip === ip);
    if (devices.length === 0) return [];

    const now = Date.now();
    const requests: UpdateRequest[] = [];

    for (const device of devices) {
      const deviceKey = `${ip}:${device.eoj}`;

      for (const propName in device.propertiesValue) {
        const propValue = device.propertiesValue[propName];
        const rule = this.matchRule(device.deviceType, propName);
        if (!rule) continue;

        const state = this.getOrCreateState(ip, device.eoj, propName);
        state.intervalSec = rule.intervalSec; // 更新間隔を設定
        // バックオフ係数を考慮した実効間隔
        const effectiveIntervalSec = rule.intervalSec * state.backoffMultiplier;
        const intervalMs = effectiveIntervalSec * 1000;
        const updatedAt = this.parseUpdatedTimestamp(propValue.updated);

        // 鮮度チェック
        if (now - updatedAt > intervalMs) {
          // 古い場合、リクエストを生成
          const prop = device.properties.find(p => p.name === propName);
          if (!prop) {
            Logger.warn("[PropertySync]", `${deviceKey} ${propName}: Property not found in device.properties`);
            continue;
          }

          Logger.debug("[PropertySync]", `${deviceKey} ${propName}: Stale (age=${Math.floor((now - updatedAt) / 1000)}s, threshold=${effectiveIntervalSec}s, backoff=${state.backoffMultiplier}x)`);
          state.status = 'needsUpdate';

          requests.push({
            ip: device.ip,
            eoj: device.eoj,
            epc: prop.epc,
            propertyName: propName
          });
        } else {
          state.status = 'fresh';
        }
      }
    }

    if (requests.length > 0) {
      Logger.debug("[PropertySync]", `${ip}: Generated ${requests.length} update requests`);
    }

    return requests;
  }

  /**
   * プロパティを最新状態にマーク（値更新成功時に呼ばれる）
   */
  public markAsUpdated(ip: string, eoj: string, propertyName: string): void {
    const state = this.getOrCreateState(ip, eoj, propertyName);
    const hadBackoff = state.backoffMultiplier > 1;
    state.status = 'fresh';
    state.lastUpdated = Date.now();
    state.backoffMultiplier = 1; // 成功時にバックオフをリセット
    state.timeoutCount = 0; // 成功時にタイムアウトカウントをリセット
    if (hadBackoff) {
      Logger.debug("[PropertySync]", `${ip}:${eoj} ${propertyName}: Marked as fresh (backoff reset)`);
    } else {
      Logger.debug("[PropertySync]", `${ip}:${eoj} ${propertyName}: Marked as fresh`);
    }
  }

  /**
   * プロパティ取得失敗時の処理（バックオフを増加）
   */
  public markAsFailed(ip: string, eoj: string, propertyName: string): void {
    const state = this.getOrCreateState(ip, eoj, propertyName);
    // バックオフ係数を増加（最大16倍）
    state.backoffMultiplier = Math.min(state.backoffMultiplier * 2, 16);
    state.timeoutCount++;
    Logger.debug("[PropertySync]", `${ip}:${eoj} ${propertyName}: Failed, backoff increased to ${state.backoffMultiplier}x (timeout count: ${state.timeoutCount})`);
  }

  /**
   * プロパティステートを取得または作成
   */
  private getOrCreateState(ip: string, eoj: string, propertyName: string): PropertyState {
    if (!this.propertyStates.has(ip)) {
      this.propertyStates.set(ip, new Map());
    }
    const ipMap = this.propertyStates.get(ip)!;

    if (!ipMap.has(eoj)) {
      ipMap.set(eoj, new Map());
    }
    const eojMap = ipMap.get(eoj)!;

    if (!eojMap.has(propertyName)) {
      eojMap.set(propertyName, {
        status: 'fresh',
        lastUpdated: Date.now(),
        timeoutCount: 0,
        intervalSec: 0,
        backoffMultiplier: 1
      });
    }

    return eojMap.get(propertyName)!;
  }

  /**
   * UTC文字列をタイムスタンプに変換
   */
  private parseUpdatedTimestamp(updated: string): number {
    try {
      return new Date(updated).getTime();
    } catch {
      return 0;
    }
  }

  /**
   * ルールマッチング
   */
  private matchRule(deviceClass: string, propertyName: string): SyncRule | undefined {
    if (!this.config) return undefined;

    for (const rule of this.config.syncRules) {
      const deviceMatch = rule.deviceClass === "*" || rule.deviceClass === deviceClass;
      if (!deviceMatch) continue;

      for (const ruleProp of rule.properties) {
        if (ruleProp === "*" || ruleProp === propertyName) {
          return rule;
        }
      }
    }

    return undefined;
  }

  /**
   * 同期状態を取得（WebUI表示用）
   */
  public getSyncStatus(): any {
    // 設定が読み込まれていない場合はエラーを返す
    if (!this.config) {
      return { error: "PropertySync config not loaded" };
    }

    const result: any = {};

    this.propertyStates.forEach((ipMap, ip) => {
      ipMap.forEach((eojMap, eoj) => {
        const deviceKey = `${ip}:${eoj}`;
        result[deviceKey] = {};

        eojMap.forEach((state, propertyName) => {
          result[deviceKey][propertyName] = {
            status: state.status,
            intervalSec: state.intervalSec,
            timeoutCount: state.timeoutCount,
            backoffMultiplier: state.backoffMultiplier,
            lastUpdated: state.lastUpdated
          };
        });
      });
    });

    return result;
  }

  /**
   * 同期処理を開始する（タイマーループ）
   */
  public startSync(
    deviceStore: DeviceStore,
    requestDevicePropertyFn: (id: {id:string, ip:string, eoj:string, internalId:string}, propertyName: string, options?: any) => Promise<void>
  ): void {
    this.deviceStore = deviceStore;
    this.requestDevicePropertyFn = requestDevicePropertyFn;

    if (this.timerHandle) {
      Logger.warn("[PropertySync]", "Sync already started");
      return;
    }

    Logger.info("[PropertySync]", "Starting sync timer (1000ms interval)");
    this.timerHandle = setInterval(() => this.processSyncLoop(), 1000);
  }

  /**
   * 同期処理を停止する
   */
  public stopSync(): void {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = undefined;
      Logger.info("[PropertySync]", "Sync timer stopped");
    }
  }

  /**
   * タイマーループで実行される同期処理
   */
  private async processSyncLoop(): Promise<void> {
    // 排他制御：前回の実行が完了していない場合はスキップ
    if (this.syncMutex.isLocked()) {
      Logger.debug("[PropertySync]", "Previous sync still running, skipping this interval");
      return;
    }

    return this.syncMutex.runExclusive(async () => {
      if (!this.config || !this.deviceStore || !this.requestDevicePropertyFn) {
        return;
      }

      // 全デバイスをIPごとにグループ化
      const devicesByIp = new Map<string, any[]>();
      for (const device of this.deviceStore.getAll()) {
        if (!devicesByIp.has(device.ip)) {
          devicesByIp.set(device.ip, []);
        }
        devicesByIp.get(device.ip)!.push(device);
      }

      // IPごとに更新リクエストを生成して実行
      for (const [ip, devices] of devicesByIp) {
        const updateRequests = this.checkAndRequestUpdates(ip, this.deviceStore);

        if (updateRequests.length > 0) {
          Logger.debug("[PropertySync]", `${ip}: Processing ${updateRequests.length} property sync requests`);

          for (const req of updateRequests) {
            // デバイスを検索してDeviceIdを作成
            const device = this.deviceStore.getAll().find(d => d.ip === req.ip && d.eoj === req.eoj);
            if (!device) {
              Logger.warn("[PropertySync]", `${ip}: Device not found for ${req.eoj}`);
              continue;
            }

            const deviceId = {
              id: device.id,
              ip: device.ip,
              eoj: device.eoj,
              internalId: device.internalId
            };

            Logger.debug("[PropertySync]", `${ip}: Requesting sync for ${req.eoj} ${req.propertyName}`);

            try {
              // requestDevicePropertyをbackground優先度で実行
              await this.requestDevicePropertyFn(deviceId, req.propertyName, {
                priority: 'background',
                retryCount: 0,
                retryDelay: 0,
                onSuccess: () => {
                  // 成功時: PropertySyncManagerに成功を通知
                  this.markAsUpdated(req.ip, req.eoj, req.propertyName);
                  Logger.debug("[PropertySync]", `${ip}: Sync success for ${req.eoj} ${req.propertyName}`);
                },
                onFailure: () => {
                  // 失敗時: バックオフを増加
                  this.markAsFailed(req.ip, req.eoj, req.propertyName);
                  Logger.debug("[PropertySync]", `${ip}: Sync failed for ${req.eoj} ${req.propertyName}, backoff increased`);
                }
              });
            } catch (e) {
              // 例外時もバックオフを増加
              this.markAsFailed(req.ip, req.eoj, req.propertyName);
              Logger.warn("[PropertySync]", `${ip}: Sync exception for ${req.eoj} ${req.propertyName}`, {exception: e});
            }
          }
        }
      }
    });
  }
}
