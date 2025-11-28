import { Device } from "./Property";
import { DeviceStore } from "./DeviceStore";
import { Logger } from "./Logger";

/**
 * デバイスの死活状態を管理し、birth/deadイベントを発火するクラス
 *
 * 責任:
 * - デバイス単位のbirth/deadイベントの管理と発火
 * - ノードプロファイルの場合は配下デバイスへの伝播
 *
 * トリガー側（PropertySyncManager、propertyChangedなど）は
 * このクラスのメソッドを呼ぶだけでよい
 */
export class DeviceLifecycleManager {
  private deviceStore: DeviceStore;

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
   * ノードプロファイルの場合は配下デバイスも生存とする
   */
  markDeviceAsAlive(device: Device): void {
    this.fireDeviceBirth(device);

    // ノードプロファイルの場合、配下デバイスも生存とする
    if (this.isNodeProfile(device.eoj)) {
      const childDevices = this.getChildDevices(device.ip, device.eoj);
      for (const child of childDevices) {
        this.fireDeviceBirth(child);
      }
    }
  }

  /**
   * デバイスが死亡状態になったことをマーク
   * ノードプロファイルの場合は配下デバイスも死亡とする
   */
  markDeviceAsDead(device: Device): void {
    this.fireDeviceDead(device);

    // ノードプロファイルの場合、配下デバイスも死亡とする
    if (this.isNodeProfile(device.eoj)) {
      const childDevices = this.getChildDevices(device.ip, device.eoj);
      for (const child of childDevices) {
        this.fireDeviceDead(child);
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
        this.fireDeviceDead(device);
      }
    }
  }

  /**
   * IPアドレスを指定してノード全体を生存状態にする
   */
  markNodeAsAliveByIp(ip: string): void {
    const devicesInNode = this.deviceStore.getAll().filter(d => d.ip === ip);

    // ノードプロファイルを先に処理（あれば）
    const nodeProfile = devicesInNode.find(d => this.isNodeProfile(d.eoj));
    if (nodeProfile) {
      this.markDeviceAsAlive(nodeProfile);
    } else {
      // ノードプロファイルがない場合は全デバイスを個別に処理
      for (const device of devicesInNode) {
        this.fireDeviceBirth(device);
      }
    }
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
