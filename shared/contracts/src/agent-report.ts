/**
 * Agent 静默问题上报（report_issue）契约（前后端共用，admin 消费）。
 *
 * 事实源是后端 `backend-ts/src/agent-report/agent-report.repository.ts` 的
 * `AGENT_REPORT_CATEGORIES` / `AGENT_REPORT_SEVERITIES` / `AGENT_REPORT_STATUSES`
 * （含 `as const satisfies` 约束）。admin 汉化表用 `Record<联合, string>` 吃编译期穷尽。
 */

/** 上报类别：系统/沙箱漏洞、平台自身 Bug、内置工具缺陷、技能缺陷、疑似恶意用户指令、其他。 */
export type AgentReportCategory =
  | 'system_vulnerability'
  | 'self_bug'
  | 'tool_defect'
  | 'skill_defect'
  | 'malicious_instruction'
  | 'other';

/** 严重级别：模型自评的建议值，管理员处置时可改判（V1 仅展示与筛选）。 */
export type AgentReportSeverity = 'low' | 'medium' | 'high' | 'critical';

/**
 * 处置状态机：OPEN 是唯一入口态；OPEN → ACKNOWLEDGED / RESOLVED / DISMISSED；
 * ACKNOWLEDGED → RESOLVED / DISMISSED；RESOLVED / DISMISSED 为终态（不可再流转）。
 */
export type AgentReportStatus = 'OPEN' | 'ACKNOWLEDGED' | 'RESOLVED' | 'DISMISSED';
