import type { WsClientType } from '@mao/contracts'

/**
 * WS 客户端类型中文名。键类型是契约联合 `WsClientType`（shared/contracts/src/ws.ts），
 * **漏一项编译期即失败**——与 llmCallLabels.ts 同一机制（Record 穷尽吃联合扩张）。
 */
const WS_CLIENT_TYPE_LABELS: Record<WsClientType, string> = {
  electron: '桌面客户端',
  android: '安卓 App',
  cli: '终端 CLI',
  browser: '浏览器 (Web)',
  embed: '页面嵌入'
}

export function wsClientTypeLabel(clientType?: string | null): string {
  if (!clientType) return '未知'
  return WS_CLIENT_TYPE_LABELS[clientType as WsClientType] ?? clientType
}
