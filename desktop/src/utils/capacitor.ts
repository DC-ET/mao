/**
 * Capacitor 平台检测（安卓壳专用，不依赖 @capacitor/core npm 包，直接读运行时注入）。
 * Web / Electron 环境返回 false。
 */
export function isAndroidCapacitor(): boolean {
  try {
    // @ts-ignore Capacitor 7 运行时注入
    return typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.() && window.Capacitor.getPlatform?.() === 'android'
  } catch {
    return false
  }
}

/**
 * 三端统一外链打开：Electron IPC / Capacitor App·Browser 插件 / Web window.open 兜底。
 * 避免非 Electron 环境点击外链静默无响应。
 */
export async function openExternalUrl(url: string): Promise<void> {
  const electronApi = (window as any).electronAPI
  if (electronApi?.openExternal) {
    await electronApi.openExternal(url)
    return
  }
  if (isAndroidCapacitor()) {
    const plugins = (window as any).Capacitor?.Plugins
    try {
      if (plugins?.App?.openUrl) {
        await plugins.App.openUrl({ url })
        return
      }
      if (plugins?.Browser?.open) {
        await plugins.Browser.open({ url })
        return
      }
    } catch {
      // 插件不可用时落到 window.open 兜底
    }
  }
  window.open(url, '_blank', 'noopener')
}
