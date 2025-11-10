import { DeviceId } from "./Property";
import { Logger } from "./Logger";

interface PropertyRequest {
  id: DeviceId;
  propertyName: string;
}

/**
 * デバイスごとにシリアライズされたグローバルプロパティリクエストキュー
 * 非ブロッキングなリクエスト投入とバックグラウンド処理を実装
 */
export class PropertyRequestQueue {
  private queues: Map<string, PropertyRequest[]> = new Map();
  private processing: Set<string> = new Set();
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private readonly pollInterval: number;
  private readonly executor: (id: DeviceId, propertyName: string) => Promise<void>;

  /**
   * @param executor プロパティリクエストを実行する関数（通常はEchoNetLiteController.requestDeviceProperty）
   * @param pollInterval キューをチェックする間隔（ミリ秒、デフォルト: 100ms）
   */
  constructor(
    executor: (id: DeviceId, propertyName: string) => Promise<void>,
    pollInterval: number = 100
  ) {
    this.executor = executor;
    this.pollInterval = pollInterval;
  }

  /**
   * プロパティリクエストをキューに追加（非ブロッキング）
   * リクエストはデバイスIPアドレスごとにグループ化されてシリアライズされる
   * 同じデバイス（IP+EOJ）の同じプロパティのリクエストが既にキューにある場合はスキップ
   */
  public enqueue(id: DeviceId, propertyName: string): void {
    const deviceKey = id.ip;

    if (!this.queues.has(deviceKey)) {
      this.queues.set(deviceKey, []);
    }

    const queue = this.queues.get(deviceKey)!;

    // 重複チェック: 同じeojと同じpropertyNameのリクエストが既に存在するか
    const isDuplicate = queue.some(req =>
      req.id.eoj === id.eoj &&
      req.propertyName === propertyName
    );

    if (isDuplicate) {
      Logger.debug("[PropertyRequestQueue]", `Skipped duplicate request for ${deviceKey} (eoj: ${id.eoj}), property: ${propertyName}`);
      return;
    }

    queue.push({ id, propertyName });

    Logger.debug("[PropertyRequestQueue]", `Enqueued request for ${deviceKey} (eoj: ${id.eoj}), property: ${propertyName}, queue length: ${queue.length}`);
  }

  /**
   * バックグラウンドキュー処理を開始
   */
  public start(): void {
    if (this.isRunning) {
      Logger.warn("[PropertyRequestQueue]", "Queue already running");
      return;
    }

    this.isRunning = true;
    this.intervalId = setInterval(() => {
      this.processQueues();
    }, this.pollInterval);

    Logger.info("[PropertyRequestQueue]", `Started with poll interval: ${this.pollInterval}ms`);
  }

  /**
   * バックグラウンドキュー処理を停止し、すべてのキューをクリア
   */
  public stop(): void {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;

    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    this.queues.clear();
    this.processing.clear();

    Logger.info("[PropertyRequestQueue]", "Stopped");
  }

  /**
   * 監視用の現在のキュー状態を取得
   */
  public getStatus(): { totalQueued: number; devicesProcessing: number } {
    let totalQueued = 0;
    for (const queue of this.queues.values()) {
      totalQueued += queue.length;
    }

    return {
      totalQueued,
      devicesProcessing: this.processing.size
    };
  }

  /**
   * すべてのデバイスのキューを処理
   * デバイスごとに同時に1つのリクエストのみを処理（シリアライゼーション）
   */
  private async processQueues(): Promise<void> {
    for (const [deviceKey, queue] of this.queues.entries()) {
      // このデバイスが既に処理中の場合はスキップ
      if (this.processing.has(deviceKey)) {
        continue;
      }

      // キューが空の場合はスキップ
      if (queue.length === 0) {
        continue;
      }

      // デバイスを処理中としてマーク
      this.processing.add(deviceKey);

      // キューから次のリクエストを取得
      const request = queue.shift()!;

      // リクエストを非同期で処理
      this.processRequest(deviceKey, request).finally(() => {
        this.processing.delete(deviceKey);
      });
    }

    // 空のキューをクリーンアップ
    for (const [deviceKey, queue] of this.queues.entries()) {
      if (queue.length === 0 && !this.processing.has(deviceKey)) {
        this.queues.delete(deviceKey);
      }
    }
  }

  /**
   * 単一のプロパティリクエストを処理
   */
  private async processRequest(deviceKey: string, request: PropertyRequest): Promise<void> {
    try {
      Logger.debug("[PropertyRequestQueue]", `Processing request for ${deviceKey}, property: ${request.propertyName}`);
      await this.executor(request.id, request.propertyName);
      Logger.debug("[PropertyRequestQueue]", `Completed request for ${deviceKey}, property: ${request.propertyName}`);
    } catch (error) {
      Logger.error("[PropertyRequestQueue]", `Failed to process request for ${deviceKey}, property: ${request.propertyName}`, { error: String(error) });
    }
  }
}
