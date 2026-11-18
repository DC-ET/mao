import { isElectronClient } from './platform'
import type { DesktopDeviceInfo } from '../types/desktop'

/**
 * 本机设备身份（技术方案 2026-11-05 §4.2）：仅 Electron 有值，主进程 IPC 取一次。
 * 浏览器 / 非桌面壳返回 null，auth 帧不带 device、建 LOCAL 会话也不绑定设备——
 * 保持旧广播行为。
 *
 * 设备 ID 与 mao-agent 共用 `~/.mao/agent-cli/device.json`：同机两端是同一个 deviceId，
 * 服务端把该 deviceId 下的所有存活连接都算作可接手执行端。
 */
export function getLocalDeviceInfo(): Promise<DesktopDeviceInfo | null> {
  if (!isElectronClient()) return Promise.resolve(null)
  const api = typeof window !== 'undefined' ? (window as any).electronAPI : null
  return Promise.resolve()
    .then(() => api?.getDeviceInfo?.())
    .then((info: Partial<DesktopDeviceInfo> | null | undefined): DesktopDeviceInfo | null => {
      if (!info || typeof info.id !== 'string' || info.id.trim() === '') return null
      return normalizeDeviceInfo(info)
    })
    .catch(() => null)
}

/** 本机 deviceId 的进程内缓存（技术方案 2026-11-18 §4.4）：执行端判定要同步拿到，
 *  而底层是异步 IPC。首次取回后常驻缓存（桌面端设备身份跨会话稳定不变）。 */
let cachedDeviceId: string | null | undefined

export async function getLocalDeviceId(): Promise<string | null> {
  if (cachedDeviceId !== undefined) return cachedDeviceId
  const info = await getLocalDeviceInfo()
  cachedDeviceId = info?.id ?? null
  return cachedDeviceId
}

function normalizeDeviceInfo(info: Partial<DesktopDeviceInfo>): DesktopDeviceInfo {
  return {
    id: info.id!.trim(),
    name: typeof info.name === 'string' ? info.name : '',
    platform: typeof info.platform === 'string' ? info.platform : '',
  }
}
