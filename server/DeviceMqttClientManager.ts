import mqtt from "mqtt";
import { Logger } from "./Logger";

/**
 * デバイスごとのMQTTクライアントを管理し、LWTによる死活通知を実現するクラス
 *
 * 責任:
 * - デバイスごとに専用のMQTTクライアントを作成・管理
 * - 各クライアントにLWT（Last Will and Testament）を設定
 * - デバイスのavailability（online/offline）をpublish
 *
 * LWTの動作:
 * - 各クライアントはavailabilityトピックに"offline"をLWTとして設定
 * - ブリッジが正常動作中: birthで"online"、deadで"offline"を明示的にpublish
 * - ブリッジが異常終了時: MQTTブローカーがLWTを発動し、全デバイスを"offline"にする
 *
 * 使用例:
 * ```
 * const manager = new DeviceMqttClientManager(broker, options, baseTopic);
 * manager.createClientForDevice(deviceId, deviceName); // デバイス検出時
 * manager.publishAvailability(deviceId, deviceName, true);  // alive時
 * manager.publishAvailability(deviceId, deviceName, false); // dead時
 * ```
 */
interface DeviceClientInfo {
  client: mqtt.MqttClient;
  deviceName: string;
}

export class DeviceMqttClientManager {
  private clients: Map<string, DeviceClientInfo> = new Map();
  private readonly mqttBroker: string;
  private readonly mqttBaseOption: mqtt.IClientOptions;
  private readonly baseTopic: string;
  private readonly baseClientId: string;

  constructor(
    mqttBroker: string,
    mqttOption: mqtt.IClientOptions,
    baseTopic: string
  ) {
    this.mqttBroker = mqttBroker;
    this.mqttBaseOption = { ...mqttOption };
    this.baseTopic = baseTopic;
    this.baseClientId = mqttOption.clientId || "echonetlite2mqtt";
  }

  /**
   * ブローカーが設定されているかどうか
   */
  get isConfigured(): boolean {
    return this.mqttBroker !== "";
  }

  /**
   * デバイス用のMQTTクライアントを作成・接続
   * LWTを設定し、接続成功時にonlineをpublish
   *
   * @param deviceId デバイスの内部ID
   * @param deviceName デバイスの表示名（MQTTトピックに使用）
   */
  createClientForDevice(deviceId: string, deviceName: string): void {
    if (!this.isConfigured) {
      Logger.debug("[DeviceMqtt]", "MQTT broker not configured, skipping client creation");
      return;
    }

    if (this.clients.has(deviceId)) {
      Logger.debug("[DeviceMqtt]", `Client already exists for ${deviceName} (${deviceId})`);
      return;
    }

    // LWTトピックはdeviceName（人間が読みやすい名前）ベース
    const willTopic = `${this.baseTopic}/${deviceName}/availability`;

    // クライアントIDはデバイスごとに一意にする
    const clientId = `${this.baseClientId}_dev_${deviceId}`;

    const option: mqtt.IClientOptions = {
      ...this.mqttBaseOption,
      clientId: clientId,
      will: {
        topic: willTopic,
        payload: Buffer.from("offline"),
        qos: 1,
        retain: true
      }
    };

    Logger.info("[DeviceMqtt]", `Creating MQTT client for ${deviceName} (${deviceId}) with LWT on ${willTopic}`);

    const client = mqtt.connect(this.mqttBroker, option);

    client.on("connect", () => {
      Logger.info("[DeviceMqtt]", `Connected for device ${deviceName} (${deviceId})`);
      // 接続成功時にonlineをpublish
      this.publishAvailabilityInternal(client, deviceId, deviceName, true);
    });

    client.on("error", (error) => {
      Logger.warn("[DeviceMqtt]", `Error for device ${deviceName} (${deviceId}): ${error?.toString()}`);
    });

    client.on("close", () => {
      Logger.debug("[DeviceMqtt]", `Connection closed for device ${deviceName} (${deviceId})`);
    });

    client.on("reconnect", () => {
      Logger.debug("[DeviceMqtt]", `Reconnecting for device ${deviceName} (${deviceId})`);
    });

    this.clients.set(deviceId, { client, deviceName });
  }

  /**
   * デバイス用クライアントが存在するかどうか
   */
  hasClient(deviceId: string): boolean {
    return this.clients.has(deviceId);
  }

  /**
   * availabilityをpublish
   * クライアントが存在しない場合は何もしない
   *
   * @param deviceId デバイスの内部ID
   * @param deviceName デバイスの表示名
   * @param isOnline trueならonline、falseならoffline
   */
  publishAvailability(deviceId: string, deviceName: string, isOnline: boolean): void {
    const clientInfo = this.clients.get(deviceId);

    if (!clientInfo) {
      Logger.warn("[DeviceMqtt]", `No client for device ${deviceName} (${deviceId}), cannot publish availability`);
      return;
    }

    const { client } = clientInfo;

    if (!client.connected) {
      Logger.debug("[DeviceMqtt]", `Client not connected for ${deviceName} (${deviceId}), will publish when connected`);
      // 接続されていない場合は接続待ちリスナーを追加
      client.once("connect", () => {
        this.publishAvailabilityInternal(client, deviceId, deviceName, isOnline);
      });
      return;
    }

    this.publishAvailabilityInternal(client, deviceId, deviceName, isOnline);
  }

  /**
   * 内部用: availabilityを実際にpublish
   */
  private publishAvailabilityInternal(
    client: mqtt.MqttClient,
    deviceId: string,
    deviceName: string,
    isOnline: boolean
  ): void {
    const availability = isOnline ? "online" : "offline";
    const nameTopic = `${this.baseTopic}/${deviceName}/availability`;

    client.publish(nameTopic, availability, { retain: true }, (err) => {
      if (err) {
        Logger.warn("[DeviceMqtt]", `Failed to publish availability for ${deviceName}: ${err}`);
      } else {
        Logger.debug("[DeviceMqtt]", `Published ${availability} to ${nameTopic}`);
      }
    });

    // deviceIdがdeviceNameと異なる場合、IDベースのトピックにもpublish
    if (deviceId !== deviceName) {
      const idTopic = `${this.baseTopic}/${deviceId}/availability`;
      client.publish(idTopic, availability, { retain: true }, (err) => {
        if (err) {
          Logger.warn("[DeviceMqtt]", `Failed to publish availability for ${deviceId}: ${err}`);
        }
      });
    }
  }

  /**
   * デバイス用クライアントを破棄
   * 正常終了時は先にofflineをpublishしてから切断
   *
   * @param deviceId デバイスの内部ID
   * @param deviceName デバイスの表示名
   */
  destroyClientForDevice(deviceId: string, deviceName: string): void {
    const clientInfo = this.clients.get(deviceId);
    if (!clientInfo) {
      return;
    }

    const { client } = clientInfo;

    Logger.info("[DeviceMqtt]", `Destroying MQTT client for ${deviceName} (${deviceId})`);

    // 明示的にofflineをpublishしてから切断
    if (client.connected) {
      this.publishAvailabilityInternal(client, deviceId, deviceName, false);
      // publishが完了するのを少し待ってから切断
      setTimeout(() => {
        client.end(false, () => {
          Logger.debug("[DeviceMqtt]", `Client ended for ${deviceName} (${deviceId})`);
        });
      }, 100);
    } else {
      client.end();
    }

    this.clients.delete(deviceId);
  }

  /**
   * 全クライアントを破棄
   * アプリケーション終了時に呼び出す
   * 各デバイスにofflineをpublishしてから切断する
   *
   * @returns publishと切断が完了するPromise
   */
  destroyAll(): Promise<void> {
    Logger.info("[DeviceMqtt]", `Destroying all ${this.clients.size} device MQTT clients`);

    // 各クライアントにofflineをpublishしてから切断
    const promises: Promise<void>[] = [];

    this.clients.forEach((clientInfo, deviceId) => {
      const { client, deviceName } = clientInfo;

      if (client.connected) {
        promises.push(
          new Promise<void>((resolve) => {
            // offlineをpublish
            this.publishAvailabilityInternal(client, deviceId, deviceName, false);
            Logger.debug("[DeviceMqtt]", `Published offline for ${deviceName} (${deviceId})`);

            // publishが完了するのを少し待ってから切断
            setTimeout(() => {
              client.end(false, () => {
                Logger.debug("[DeviceMqtt]", `Client ended for ${deviceName} (${deviceId})`);
                resolve();
              });
            }, 50);
          })
        );
      } else {
        client.end();
      }
    });

    this.clients.clear();

    // 全クライアントの終了を待つ
    return Promise.all(promises)
      .then(() => {
        Logger.info("[DeviceMqtt]", "All device MQTT clients destroyed");
      })
      .catch((err) => {
        Logger.warn("[DeviceMqtt]", `Error during destroyAll: ${err}`);
      });
  }

  /**
   * 接続中のクライアント数を取得
   */
  getConnectedClientCount(): number {
    let count = 0;
    this.clients.forEach((clientInfo) => {
      if (clientInfo.client.connected) {
        count++;
      }
    });
    return count;
  }

  /**
   * 管理中のクライアント数を取得（接続状態問わず）
   */
  getTotalClientCount(): number {
    return this.clients.size;
  }
}
