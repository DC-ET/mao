import type { SessionSource } from '@mao/contracts'

/**
 * 会话来源中文名。键类型是契约联合 `SessionSource`，**漏一项编译期即失败**——
 * 与后端 `SESSION_SOURCE_VALUES` 逐值一致（技术方案 2026-10-29 §4.3）。
 * admin 的 `src/utils/sessionSourceLabels.ts` 保持同一份文案。
 */
export const SESSION_SOURCE_LABELS: Record<SessionSource, string> = {
  web: 'Web',
  embed: '浮窗 Embed',
  feishu: '飞书',
  dingtalk: '钉钉',
  weixin: '微信',
  signal: '信号哨兵',
  openapi: '开放接口',
}

export function sessionSourceLabel(source?: string | null): string {
  if (!source) return SESSION_SOURCE_LABELS.web
  return SESSION_SOURCE_LABELS[source as SessionSource] ?? source
}
