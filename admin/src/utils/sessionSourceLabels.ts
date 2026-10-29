import type { SessionSource } from '@mao/contracts'

/**
 * 会话来源中文名。键类型是契约联合 `SessionSource`，**漏一项编译期即失败**——
 * 与后端 `SESSION_SOURCE_VALUES` 逐值一致（技术方案 2026-10-29 §4.2-2）。
 * desktop 的 `src/utils/sessionSourceLabels.ts` 保持同一份文案。
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

/** el-tag 色调：与列表页既有 tag 体系一致（web 用 info 灰、不做强调色）。 */
export const SESSION_SOURCE_TAG_TYPES: Record<SessionSource, 'primary' | 'success' | 'warning' | 'danger' | 'info'> = {
  web: 'info',
  embed: 'warning',
  feishu: 'primary',
  dingtalk: 'success',
  weixin: 'primary',
  signal: 'danger',
  openapi: 'success',
}

/** 来源筛选下拉选项，顺序与契约声明一致（从汉化表派生）。 */
export const SESSION_SOURCE_OPTIONS: ReadonlyArray<{ value: SessionSource; label: string }> =
  Object.entries(SESSION_SOURCE_LABELS).map(([value, label]) => ({ value: value as SessionSource, label }))

/** 未知 code（含历史脏值）回落原文，不吞掉信息。 */
export function sessionSourceLabel(source?: string | null): string {
  if (!source) return SESSION_SOURCE_LABELS.web
  return SESSION_SOURCE_LABELS[source as SessionSource] ?? source
}

export function sessionSourceTagType(source?: string | null): 'primary' | 'success' | 'warning' | 'danger' | 'info' {
  return SESSION_SOURCE_TAG_TYPES[(source ?? 'web') as SessionSource] ?? 'info'
}
