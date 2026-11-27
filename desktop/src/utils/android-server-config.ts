import { isAndroidCapacitor } from './capacitor'

export interface AndroidServerInfo {
  serverBaseUrl: string
  allowHttp: boolean
  shellVersionCode?: number
  shellVersionName?: string
}

interface ServerConfigPlugin {
  get(): Promise<AndroidServerInfo>
  openPicker(): Promise<{ changed: boolean }>
}

/**
 * 安卓壳 `ServerConfig` 插件访问入口。
 *
 * 旧 APK 没有该插件时返回 null，所有入口按能力隐藏；不能只判断 isAndroidCapacitor()，
 * 否则老壳会出现点不动的入口。
 */
export function getAndroidServerConfigPlugin(): ServerConfigPlugin | null {
  if (!isAndroidCapacitor()) return null
  try {
    return (window as any).Capacitor?.Plugins?.ServerConfig ?? null
  } catch {
    return null
  }
}