/**
 * ToolDescriptor：工具的静态描述元数据（来源 / 执行器 / 归属）。
 * 供审批、审计、展示消费；与 Provider 工具格式转换无关（转换由各 LLM Adapter 负责）。
 */
export type ToolSource = 'builtin' | 'mcp';
export type ToolExecutor = 'server' | 'desktop' | 'mcp-server';

export interface ToolDescriptor {
  name: string;
  source: ToolSource;
  executor: ToolExecutor;
  /** source === 'mcp' 时：所属 MCP Server id 与原始工具名（不含命名空间前缀） */
  serverId?: number;
  originalName?: string;
}
