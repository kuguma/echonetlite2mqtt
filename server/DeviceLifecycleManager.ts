import { Device } from "./Property";
import { DeviceStore } from "./DeviceStore";
import { Logger } from "./Logger";

/**
 * デバイスの死活状態を管理し、birth/deadイベントを発火するクラス
 *
 * 責任:
 * - デバイス単位のbirth/deadイベントの管理と発火
 * - ノードプロファイルの場合は配下デバイスへの伝播
 * - デバイス状態の追跡と重複発火の抑制
 *
 * トリガー側（PropertySyncManager、propertyChangedなど）は
 * このクラスのメソッドを呼ぶだけでよい。
 * トリガー側はデバイスの状態を勘案せずイベントを呼んでも良い。
 * 状態が変わらない場合の発火抑制はこのクラスが担当する。
 */

/*
=== シナリオとプログラムフロー ===

【シナリオ1: ディスカバリ完了 → birth発火】
  1. EchoNetLiteRawController: collectDeviceDetails() でプロパティ収集完了
  2. EchoNetLiteRawController: discoveryComplete = true, fireDeviceDetected()
  3. EchoNetLiteController: deviceDetected ハンドラ → fireDeviceDetected(device)
  4. index.ts: addDeviceDetectedEvent ハンドラ
     → deviceLifecycleManager.markDeviceAsAlive(device)
  5. DeviceLifecycleManager: 状態を alive に変更、birthリスナー発火
  6. MqttController: publishDeviceAvailability(device.id, true)

【シナリオ2: 切断 → propertySyncManager が DEAD 検知 → dead発火】
  1. PropertySyncManager: プロパティ取得を試みるが連続失敗
  2. PropertySyncManager: markAsFailed() でバックオフ増加、timeoutCount増加
  3. PropertySyncManager: timeoutCount >= 10 かつ backoff最大 → dead=true
  4. PropertySyncManager: ノードプロファイルのoperatingStatusがDEADなら
     → fireNodeDeadEvent(ip) → lifecycleManager.markNodeAsDeadByIp(ip)
  5. DeviceLifecycleManager: ノードプロファイルと配下デバイス全てにdead発火
  6. MqttController: publishDeviceAvailability(device.id, false)

【シナリオ3: デバイス復活 → GET成功 or INF受信 → birth発火】
  3-A. GET成功パターン:
    1. PropertySyncManager: 設定された間隔経過後にDEADプロパティのリトライ
    2. EchoNetLiteController: requestDeviceProperty() でGET成功
    3. EchoNetLiteController: firePropertyChangedEvent() 発火
    4. → デバイス復活トリガー → lifecycleManager.markDeviceAsAlive(device)
    5. DeviceLifecycleManager: 状態がdead→aliveに変化 → birthリスナー発火
    6. MqttController: publishDeviceAvailability(device.id, true)

  3-B. INF受信パターン:
    1. EchoNetLiteRawController: INFパケット受信
    2. EchoNetLiteRawController: updatePropertiesFromInf() でプロパティ更新
    3. EchoNetLiteRawController: firePropertyChanged() 発火
    4. → デバイス復活トリガー → lifecycleManager.markDeviceAsAlive(device)
    5. DeviceLifecycleManager: 状態がdead→aliveに変化 → birthリスナー発火
    6. MqttController: publishDeviceAvailability(device.id, true)

【補足: 重複発火抑制】
  - トリガー側は毎回markDeviceAsAlive/Deadを呼んでよい
  - DeviceLifecycleManagerが内部状態を追跡し、状態変化時のみリスナーを発火
  - 例: 既にaliveのデバイスにmarkDeviceAsAliveを呼んでもbirthリスナーは発火しない
*/

export class DeviceLifecycleManager {
  private deviceStore: DeviceStore;

  // デバイスごとの生存状態を追跡（key: internalId）
  // true = alive, false = dead, undefined = 未知（初回birth時にtrueになる）
  private deviceAliveStates: Map<string, boolean> = new Map();

  // birth イベント（デバイス誕生/復活）
  private deviceBirthListeners: ((device: Device) => void)[] = [];

  // dead イベント（デバイス死亡）
  private deviceDeadListeners: ((device: Device) => void)[] = [];

  constructor(deviceStore: DeviceStore) {
    this.deviceStore = deviceStore;
  }

  // ========== イベントリスナー登録 ==========

  addDeviceBirthEvent(listener: (device: Device) => void): void {
    this.deviceBirthListeners.push(listener);
  }

  addDeviceDeadEvent(listener: (device: Device) => void): void {
    this.deviceDeadListeners.push(listener);
  }

  // ========== イベント発火（内部用） ==========

  private fireDeviceBirth(device: Device): void {
    Logger.info("[Lifecycle]", `Device birth: ${device.name} (${device.ip} ${device.eoj})`);
    this.deviceBirthListeners.forEach(listener => listener(device));
  }

  private fireDeviceDead(device: Device): void {
    Logger.info("[Lifecycle]", `Device dead: ${device.name} (${device.ip} ${device.eoj})`);
    this.deviceDeadListeners.forEach(listener => listener(device));
  }

  // ========== トリガーから呼ばれるメソッド ==========

  /**
   * デバイスが生存状態になったことをマーク
   * 死亡の場合とは非対称で、ノードプロファイルの場合も特別扱いはしない。
   *
   * 重複発火抑制: 既にalive状態のデバイスには発火しない
   */
  markDeviceAsAlive(device: Device): void {
    const currentState = this.deviceAliveStates.get(device.internalId);

    // 既にaliveなら何もしない
    if (currentState === true) {
      Logger.debug("[Lifecycle]", `Device already alive, skipping birth: ${device.name} (${device.ip} ${device.eoj})`);
      return;
    }

    // 状態を更新してイベント発火
    this.deviceAliveStates.set(device.internalId, true);
    this.fireDeviceBirth(device);
  }

  /**
   * デバイスが死亡状態になったことをマーク
   * ノードプロファイルの場合は配下デバイスも死亡とする
   *
   * 重複発火抑制: 既にdead状態のデバイスには発火しない
   */
  markDeviceAsDead(device: Device): void {
    const currentState = this.deviceAliveStates.get(device.internalId);

    // 既にdeadなら何もしない
    if (currentState === false) {
      Logger.debug("[Lifecycle]", `Device already dead, skipping dead event: ${device.name} (${device.ip} ${device.eoj})`);
      return;
    }

    // 状態を更新してイベント発火
    this.deviceAliveStates.set(device.internalId, false);
    this.fireDeviceDead(device);

    // ノードプロファイルの場合、配下デバイスも死亡とする
    if (this.isNodeProfile(device.eoj)) {
      const childDevices = this.getChildDevices(device.ip, device.eoj);
      for (const child of childDevices) {
        this.markDeviceAsDead(child); // 再帰的に呼び出し（重複抑制が効く）
      }
    }
  }

  /**
   * IPアドレスを指定してノード全体を死亡状態にする
   * （ノードプロファイルが見つからない場合でも配下デバイス全てを死亡とする）
   */
  markNodeAsDeadByIp(ip: string): void {
    const devicesInNode = this.deviceStore.getAll().filter(d => d.ip === ip);

    // ノードプロファイルを先に処理（あれば）
    const nodeProfile = devicesInNode.find(d => this.isNodeProfile(d.eoj));
    if (nodeProfile) {
      this.markDeviceAsDead(nodeProfile);
    } else {
      // ノードプロファイルがない場合は全デバイスを個別に処理
      for (const device of devicesInNode) {
        this.markDeviceAsDead(device);
      }
    }
  }

  // ========== 状態取得（デバッグ・WebUI用） ==========

  /**
   * デバイスの現在の生存状態を取得
   * @returns true=alive, false=dead, undefined=未知
   */
  getDeviceState(internalId: string): boolean | undefined {
    return this.deviceAliveStates.get(internalId);
  }

  /**
   * 全デバイスの状態を取得（デバッグ用）
   */
  getAllStates(): Map<string, boolean> {
    return new Map(this.deviceAliveStates);
  }

  // ========== ヘルパーメソッド ==========

  /**
   * EOJがノードプロファイル（0x0EF0xx）かどうかを判定
   */
  private isNodeProfile(eoj: string): boolean {
    return eoj.toLowerCase().startsWith("0ef0");
  }

  /**
   * 指定IPの配下デバイス（ノードプロファイル以外）を取得
   */
  private getChildDevices(ip: string, nodeProfileEoj: string): Device[] {
    return this.deviceStore.getAll().filter(d =>
      d.ip === ip && d.eoj !== nodeProfileEoj
    );
  }
}
