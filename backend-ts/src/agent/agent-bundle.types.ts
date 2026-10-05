/**
 * mao-agent-bundle v1（Agent 资产搬运格式，见 docs/guides/agent-bundle-format.md）。
 * bundle 是半可信输入：导入端对所有字段做服务端校验，不信任导出端。
 */

export const BUNDLE_FORMAT = 'mao-agent-bundle';
export const BUNDLE_FORMAT_VERSION = 1;
/** 导出脱敏占位符：env 值全量替换（宁多勿漏），导入落库时置空字符串、键名保留。 */
export const REDACTED_PLACEHOLDER = '$MAO_REDACTED';
/** 导出侧 inline 技能文本总量上限（UTF-8 字节）。bodyLimit 只保护导入侧，导出响应须自行设限。 */
export const MAX_INLINE_BYTES = 10 * 1024 * 1024;
/** 对齐 agent.name 列宽 VARCHAR(128)。 */
export const MAX_AGENT_NAME_LENGTH = 128;

export interface BundleAgent {
  name: string;
  description?: string | null;
  systemPrompt: string;
  /** 原样搬运（当前仅压缩配置覆盖项，无敏感语义）；对象或 null。 */
  configJson?: Record<string, unknown> | null;
}

export interface BundleExperience {
  content: string;
  sortOrder?: number;
  enabled?: boolean;
}

export interface BundleSuggestedQuestion {
  content: string;
  sortOrder?: number;
}

export interface BundleSkill {
  name: string;
  /** inline=文件随 bundle 携带（仅用户技能）；reference=目标实例自行安装。 */
  include: 'inline' | 'reference';
  /** 相对技能目录路径 → UTF-8 文本内容；仅 include=inline 时存在。 */
  files?: Record<string, string>;
  /** inline 读取时的非致命告警（如二进制文件跳过）。 */
  warnings?: string[];
}

export interface BundleMcpDefinition {
  serverType: 'STDIO' | 'HTTP';
  command?: string | null;
  args?: string[] | null;
  url?: string | null;
  /** 导出后值全量为 $MAO_REDACTED；HTTP url 不脱敏（格式文档明示该边界）。 */
  env?: Record<string, string> | null;
}

export interface BundleMcpServer {
  name: string;
  definition: BundleMcpDefinition;
}

export interface AgentBundle {
  format: typeof BUNDLE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  agent: BundleAgent;
  experiences: BundleExperience[];
  suggestedQuestions: BundleSuggestedQuestion[];
  /** skillNames 全量（与是否 inline 无关）。 */
  skills: BundleSkill[];
  mcpServers: BundleMcpServer[];
}

export type BundleSkillAction = 'system-exists' | 'will-import' | 'import-failed' | 'exists-skip' | 'ok' | 'missing';
export type BundleMcpAction = 'will-create-disabled' | 'skip-name-conflict' | 'skip-invalid';

export interface BundleImportSkillEntry {
  name: string;
  include: 'inline' | 'reference';
  action: BundleSkillAction;
  /** 失败/跳过原因。 */
  detail?: string;
}

export interface BundleImportMcpEntry {
  name: string;
  /** 正常取值 STDIO/HTTP；bundle 内非法值原样展示（action=skip-invalid 时）。 */
  serverType: string;
  action: BundleMcpAction;
  /** 完整定义（内网地址等拓扑信息对管理员可见）。 */
  definition: BundleMcpDefinition;
}

/** 预检报告（confirm=false 返回；confirm=true 返回 agentId + 重新计算的报告）。 */
export interface BundleImportReport {
  agentName: string;
  finalName: string;
  nameConflict: boolean;
  /** 全文返回，admin 向导完整展示（恶意提示词的缓解措施）。 */
  systemPrompt: string;
  experiencesCount: number;
  suggestedQuestionsCount: number;
  skills: BundleImportSkillEntry[];
  mcpServers: BundleImportMcpEntry[];
  warnings: string[];
}

export interface BundleImportResult {
  agentId: number;
  report: BundleImportReport;
}
