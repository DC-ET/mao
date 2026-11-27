import type { AgentReportCategory, AgentReportSeverity, AgentReportStatus } from '@mao/contracts'

/**
 * Agent 上报（report_issue）汉化表。键类型是契约联合 `AgentReportCategory` 等，
 * **漏一项编译期即失败**（Record 穷尽，同 llmCallLabels 口径）。
 */

const CATEGORY_LABELS: Record<AgentReportCategory, string> = {
  system_vulnerability: '系统漏洞',
  self_bug: '平台缺陷',
  tool_defect: '工具缺陷',
  skill_defect: '技能缺陷',
  malicious_instruction: '恶意指令',
  other: '其他',
}

const SEVERITY_LABELS: Record<AgentReportSeverity, string> = {
  low: '低',
  medium: '中',
  high: '高',
  critical: '严重',
}

const STATUS_LABELS: Record<AgentReportStatus, string> = {
  OPEN: '待处理',
  ACKNOWLEDGED: '已确认',
  RESOLVED: '已解决',
  DISMISSED: '已忽略',
}

type TagType = 'primary' | 'success' | 'warning' | 'danger' | 'info'

const STATUS_TAG_TYPES: Record<AgentReportStatus, TagType> = {
  OPEN: 'warning',
  ACKNOWLEDGED: 'primary',
  RESOLVED: 'success',
  DISMISSED: 'info',
}

const SEVERITY_TAG_TYPES: Record<AgentReportSeverity, TagType> = {
  low: 'info',
  medium: 'primary',
  high: 'warning',
  critical: 'danger',
}

/** 类别筛选下拉选项（从汉化表派生，顺序与契约声明一致）。 */
export const AGENT_REPORT_CATEGORY_OPTIONS: ReadonlyArray<{ value: AgentReportCategory; label: string }> =
  (Object.entries(CATEGORY_LABELS) as Array<[AgentReportCategory, string]>).map(([value, label]) => ({ value, label }))

export const AGENT_REPORT_SEVERITY_OPTIONS: ReadonlyArray<{ value: AgentReportSeverity; label: string }> =
  (Object.entries(SEVERITY_LABELS) as Array<[AgentReportSeverity, string]>).map(([value, label]) => ({ value, label }))

export const AGENT_REPORT_STATUS_OPTIONS: ReadonlyArray<{ value: AgentReportStatus; label: string }> =
  (Object.entries(STATUS_LABELS) as Array<[AgentReportStatus, string]>).map(([value, label]) => ({ value, label }))

/** 未知值回落原文，不吞掉信息（脏数据/新版本枚举）。 */
export function agentReportCategoryLabel(category?: string | null): string {
  if (!category) return '未知'
  return CATEGORY_LABELS[category as AgentReportCategory] ?? category
}

export function agentReportSeverityLabel(severity?: string | null): string {
  if (!severity) return '未知'
  return SEVERITY_LABELS[severity as AgentReportSeverity] ?? severity
}

export function agentReportStatusLabel(status?: string | null): string {
  if (!status) return '未知'
  return STATUS_LABELS[status as AgentReportStatus] ?? status
}

export function agentReportStatusTagType(status?: string | null): TagType {
  return STATUS_TAG_TYPES[(status ?? '') as AgentReportStatus] ?? 'info'
}

export function agentReportSeverityTagType(severity?: string | null): TagType {
  return SEVERITY_TAG_TYPES[severity as AgentReportSeverity] ?? 'info'
}
