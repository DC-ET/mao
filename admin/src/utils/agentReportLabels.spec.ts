import { describe, expect, it } from 'vitest'
import {
  AGENT_REPORT_CATEGORY_OPTIONS,
  AGENT_REPORT_SEVERITY_OPTIONS,
  AGENT_REPORT_STATUS_OPTIONS,
  agentReportCategoryLabel,
  agentReportSeverityLabel,
  agentReportSeverityTagType,
  agentReportStatusLabel,
  agentReportStatusTagType,
} from './agentReportLabels'

// Record<契约联合, string> 的穷尽性由编译期守住（漏一项 tsc 即失败），
// 这里固定快照防文案漂移；未知值回落原文的口径同 llmCallLabels。
describe('agentReportLabels', () => {
  it('类别 / 级别 / 状态汉化快照', () => {
    expect(AGENT_REPORT_CATEGORY_OPTIONS).toEqual([
      { value: 'system_vulnerability', label: '系统漏洞' },
      { value: 'self_bug', label: '平台缺陷' },
      { value: 'tool_defect', label: '工具缺陷' },
      { value: 'skill_defect', label: '技能缺陷' },
      { value: 'malicious_instruction', label: '恶意指令' },
      { value: 'other', label: '其他' },
    ])
    expect(AGENT_REPORT_SEVERITY_OPTIONS.map((o) => `${o.value}:${o.label}`)).toEqual([
      'low:低', 'medium:中', 'high:高', 'critical:严重',
    ])
    expect(AGENT_REPORT_STATUS_OPTIONS.map((o) => `${o.value}:${o.label}`)).toEqual([
      'OPEN:待处理', 'ACKNOWLEDGED:已确认', 'RESOLVED:已解决', 'DISMISSED:已忽略',
    ])
  })

  it('tag 类型映射', () => {
    expect(agentReportStatusTagType('OPEN')).toBe('warning')
    expect(agentReportStatusTagType('RESOLVED')).toBe('success')
    expect(agentReportSeverityTagType('critical')).toBe('danger')
    expect(agentReportSeverityTagType('low')).toBe('info')
  })

  it('未知值 / 空值回落（原文透传不吞信息，空值显示未知）', () => {
    expect(agentReportCategoryLabel('new_category')).toBe('new_category')
    expect(agentReportStatusLabel('WEIRD')).toBe('WEIRD')
    expect(agentReportSeverityLabel(null)).toBe('未知')
    expect(agentReportStatusTagType('WEIRD')).toBe('info')
  })
})
