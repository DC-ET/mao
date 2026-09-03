/**
 * 客户端形态检测（与 utils/capacitor.ts 并列）。
 * Electron 预加载脚本注入 window.electronAPI；Web 与安卓 Capacitor 均无此对象。
 */
export function isElectronClient(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}
