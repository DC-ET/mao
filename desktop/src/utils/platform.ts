import { isAndroidCapacitor } from './capacitor'

/**
 * 客户端形态检测（与 utils/capacitor.ts 并列）。
 * Electron 预加载脚本注入 window.electronAPI；Web 与安卓 Capacitor 均无此对象。
 */
export function isElectronClient(): boolean {
  return typeof window !== 'undefined' && !!(window as any).electronAPI
}

/**
 * 客户端形态三态（WS 握手 client 词表）。握手与建会话来源共用这一份判定，
 * 避免两处各写一份三元表达式后漂移。
 */
export function clientKind(): 'electron' | 'android' | 'browser' {
  if (isElectronClient()) return 'electron'
  if (isAndroidCapacitor()) return 'android'
  return 'browser'
}

/**
 * 新建会话自报的客户端形态来源（POST /v1/sessions 的 source）：
 * Electron → desktop、安卓 Capacitor → android、其余（浏览器）→ web。
 * 与 backend-ts 的 CLIENT_DECLARABLE_SESSION_SOURCES 白名单对齐。
 */
export function clientSessionSource(): 'desktop' | 'android' | 'web' {
  const kind = clientKind()
  if (kind === 'electron') return 'desktop'
  if (kind === 'android') return 'android'
  return 'web'
}
