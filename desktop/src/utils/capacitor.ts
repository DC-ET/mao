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
 * 三端统一外链打开：Electron IPC / 安卓 OpenUrl 插件（App·Browser 兜底）/
 * Web window.open。避免非 Electron 环境点击外链静默无响应。
 * 返回是否成功打开（window.open 被拦截时 false）。
 */
export async function openExternalUrl(url: string): Promise<boolean> {
  const electronApi = (window as any).electronAPI
  if (electronApi?.openExternal) {
    await electronApi.openExternal(url)
    return true
  }
  if (isAndroidCapacitor()) {
    const plugins = (window as any).Capacitor?.Plugins
    try {
      // 优先自研 OpenUrl 插件（ACTION_VIEW 直开系统浏览器/对应 App）；
      // 本壳未安装 @capacitor/app 与 @capacitor/browser，下方两个官方分支只是防御
      if (plugins?.OpenUrl?.openUrl) {
        await plugins.OpenUrl.openUrl({ url })
        return true
      }
      if (plugins?.App?.openUrl) {
        await plugins.App.openUrl({ url })
        return true
      }
      if (plugins?.Browser?.open) {
        await plugins.Browser.open({ url })
        return true
      }
    } catch {
      // 插件不可用时落到 window.open 兜底
    }
  }
  return !!window.open(url, '_blank', 'noopener')
}
