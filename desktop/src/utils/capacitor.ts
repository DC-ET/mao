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
