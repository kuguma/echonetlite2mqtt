import { DeviceId } from "./Property";
import { Logger } from "./Logger";

/**
 * プロパティリクエストのキューアイテム
 */
interface PropertyRequestQueueItem {
  deviceId: DeviceId;
  propertyName: string;
  requestTime: Date;
  retryCount: number;
  execute: () => Promise<void>;
}

/**
 * デバイスごとのキュー
 */
interface DeviceQueue {
  deviceKey: string;
  queue: PropertyRequestQueueItem[];
  isProcessing: boolean;
}

/**
 * プロパティリクエストをキュー化・直列化して処理するコントローラー
 *
 * - グローバルなプロパティリクエストキューを管理
 * - デバイスごと（物理デバイス単位＝IPアドレス単位）にリクエストをシリアライズ
 * - バックグラウンドで定期的にキューを処理
 * - 呼び出し側はレスポンスを待たずにリクエストをpush可能
 */
export class PropertyRequestQueue {
  private deviceQueues: Map<string, DeviceQueue> = new Map();
  private intervalHandle: NodeJS.Timeout | undefined;
  private readonly processIntervalMs: number;
  private readonly maxRetryCount: number;
  private readonly requestTimeoutMs: number;

  constructor(
    processIntervalMs: number = 100,
    maxRetryCount: number = 3,
    requestTimeoutMs: number = 5000
  ) {
    this.processIntervalMs = processIntervalMs;
    this.maxRetryCount = maxRetryCount;
    this.requestTimeoutMs = requestTimeoutMs;
  }

  /**
   * キューコントローラーを開始
   */
  start(): void {
    if (this.intervalHandle !== undefined) {
      return;
    }
    Logger.info("[PropertyRequestQueue]", "Starting queue controller");
    this.intervalHandle = setInterval(() => {
      this.processQueues();
    }, this.processIntervalMs);
  }

  /**
   * キューコントローラーを停止
   */
  stop(): void {
    if (this.intervalHandle !== undefined) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
      Logger.info("[PropertyRequestQueue]", "Stopped queue controller");
    }
  }

  /**
   * デバイスキーを生成（IPアドレスベース）
   */
  private getDeviceKey(deviceId: DeviceId): string {
    return deviceId.ip;
  }

  /**
   * プロパティリクエストをキューに追加
   * 呼び出し側はレスポンスを待たない（非同期）
   */
  enqueue(
    deviceId: DeviceId,
    propertyName: string,
    execute: () => Promise<void>
  ): void {
    const deviceKey = this.getDeviceKey(deviceId);

    // デバイスキューが存在しない場合は作成
    if (!this.deviceQueues.has(deviceKey)) {
      this.deviceQueues.set(deviceKey, {
        deviceKey,
        queue: [],
        isProcessing: false,
      });
    }

    const deviceQueue = this.deviceQueues.get(deviceKey)!;

    // キューに追加
    const queueItem: PropertyRequestQueueItem = {
      deviceId,
      propertyName,
      requestTime: new Date(),
      retryCount: 0,
      execute,
    };

    deviceQueue.queue.push(queueItem);

    Logger.debug(
      "[PropertyRequestQueue]",
      `Enqueued request: ${deviceId.ip} ${deviceId.eoj} ${propertyName} (queue length: ${deviceQueue.queue.length})`
    );
  }

  /**
   * 全デバイスのキューを処理
   */
  private async processQueues(): Promise<void> {
    for (const [deviceKey, deviceQueue] of this.deviceQueues.entries()) {
      if (deviceQueue.isProcessing) {
        continue;
      }

      if (deviceQueue.queue.length === 0) {
        continue;
      }

      // 次のリクエストを取得（先頭）
      const queueItem = deviceQueue.queue[0];

      // 処理中フラグを立てる
      deviceQueue.isProcessing = true;

      // リクエストを実行（非同期）
      this.processRequest(deviceQueue, queueItem).finally(() => {
        deviceQueue.isProcessing = false;
      });
    }
  }

  /**
   * 単一のリクエストを処理
   */
  private async processRequest(
    deviceQueue: DeviceQueue,
    queueItem: PropertyRequestQueueItem
  ): Promise<void> {
    try {
      Logger.debug(
        "[PropertyRequestQueue]",
        `Processing request: ${queueItem.deviceId.ip} ${queueItem.deviceId.eoj} ${queueItem.propertyName} (retry: ${queueItem.retryCount})`
      );

      // タイムアウト付きでリクエストを実行
      await this.executeWithTimeout(queueItem.execute, this.requestTimeoutMs);

      // 成功したのでキューから削除
      deviceQueue.queue.shift();

      Logger.debug(
        "[PropertyRequestQueue]",
        `Request completed: ${queueItem.deviceId.ip} ${queueItem.deviceId.eoj} ${queueItem.propertyName}`
      );
    } catch (error) {
      // エラーが発生した場合
      Logger.warn(
        "[PropertyRequestQueue]",
        `Request failed: ${queueItem.deviceId.ip} ${queueItem.deviceId.eoj} ${queueItem.propertyName} (retry: ${queueItem.retryCount})`,
        error
      );

      // リトライカウントを増やす
      queueItem.retryCount++;

      if (queueItem.retryCount >= this.maxRetryCount) {
        // 最大リトライ回数を超えた場合はキューから削除
        deviceQueue.queue.shift();
        Logger.error(
          "[PropertyRequestQueue]",
          `Request abandoned after ${this.maxRetryCount} retries: ${queueItem.deviceId.ip} ${queueItem.deviceId.eoj} ${queueItem.propertyName}`
        );
      } else {
        // リトライする（キューの先頭に残す）
        Logger.debug(
          "[PropertyRequestQueue]",
          `Request will be retried: ${queueItem.deviceId.ip} ${queueItem.deviceId.eoj} ${queueItem.propertyName}`
        );
      }
    }
  }

  /**
   * タイムアウト付きでPromiseを実行
   */
  private async executeWithTimeout<T>(
    promise: () => Promise<T>,
    timeoutMs: number
  ): Promise<T> {
    return Promise.race([
      promise(),
      new Promise<T>((_, reject) =>
        setTimeout(() => reject(new Error("Request timeout")), timeoutMs)
      ),
    ]);
  }

  /**
   * 内部状態を取得（デバッグ用）
   */
  getInternalStatus(): unknown {
    const status: {
      [key: string]: {
        queueLength: number;
        isProcessing: boolean;
        items: {
          propertyName: string;
          retryCount: number;
          requestTime: string;
        }[];
      };
    } = {};

    for (const [deviceKey, deviceQueue] of this.deviceQueues.entries()) {
      status[deviceKey] = {
        queueLength: deviceQueue.queue.length,
        isProcessing: deviceQueue.isProcessing,
        items: deviceQueue.queue.map((item) => ({
          propertyName: item.propertyName,
          retryCount: item.retryCount,
          requestTime: item.requestTime.toISOString(),
        })),
      };
    }

    return status;
  }
}
