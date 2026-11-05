import { isElectronClient } from './platform'
import type { DesktopDeviceInfo } from '../types/desktop'

let deviceInfoPromise: Promise<DesktopDeviceInfo | null> | null = null

/**
 * 本机设备身份（技术方案 2026-11-05 §4.2）：仅 Electron 有值，主进程 IPC 取一次并缓存
 * （deviceId 机器级稳定，运行期不会变化）。浏览器 / 非桌面壳返回 null，
 * auth 帧不带 device、建 LOCAL 会话也不绑定设备——保持旧广播行为。
 */
export function getLocalDeviceInfo(): Promise<DesktopDeviceInfo | null> {
  if (!isElectronClient()) return Promise.resolve(null)
  if (deviceInfoPromise) return deviceInfoPromise
  const api = typeof window !== 'undefined' ? (window as any).electronAPI : null
  deviceInfoPromise = Promise.resolve()
    .then(() => api?.getDeviceInfo?.())
    .then((info: Partial<DesktopDeviceInfo> | null | undefined): DesktopDeviceInfo | null => {
      if (!info || typeof info.id !== 'string' || info.id.trim() === '') return null
      return {
        id: info.id.trim(),
        name: typeof info.name === 'string' ? info.name : '',
        platform: typeof info.platform === 'string' ? info.platform : '',
      }
    })
    .catch(() => null)
  return deviceInfoPromise
}
