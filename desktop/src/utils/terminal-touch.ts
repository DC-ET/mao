/**
 * 触屏终端判定：安卓 / iOS Capacitor 壳与手机、平板浏览器为 true；Electron 与桌面浏览器为 false。
 *
 * 与 terminal-ime-guard 的安装判定同源，避免两处各写一份后漂移。判定顺序固定为
 * Capacitor → Electron → (pointer: coarse)：原生壳内不依赖 pointer 媒体查询，
 * Electron 优先排除（触屏笔记本上 Electron 仍按桌面处理）。
 */
export function isTouchTerminal(): boolean {
  if (typeof window === 'undefined') return false
  try {
    // @ts-ignore Capacitor 7 运行时注入
    if (window.Capacitor?.isNativePlatform?.()) return true
  } catch {
    // 读取失败按非原生壳处理
  }
  if ((window as any).electronAPI) return false
  return window.matchMedia?.('(pointer: coarse)').matches === true
}