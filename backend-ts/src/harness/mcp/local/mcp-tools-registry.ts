import { harnessLog } from '../../log.js';
import type { McpToolRef } from '../entity/mcp-server.js';

/**
 * MCP 工具注册表：LOCAL（桌面上报）与 CLOUD（服务端连接快照）两个维度分开存，
 * 避免互相覆盖。两者语义对齐——工具集只在「服务端 MCP 配置变化 / 新会话」时变化，
 * 不在连接抖动时变化，因此 LLM 请求的 tools 数组逐字节稳定（前缀缓存前提，技术方案 §4.5）。
 */
export class McpToolsRegistry {
  private readonly sessionTools = new Map<number, McpToolRef[]>();
  /** CLOUD 维度快照：会话内最近一次成功连接得到的工具集（按 (serverName, toolName) 排序）。 */
  private readonly cloudSnapshot = new Map<number, McpToolRef[]>();

  report(sessionId: number | null | undefined, tools: McpToolRef[] | null | undefined): void {
    if (sessionId == null) return;
    if (!tools || tools.length === 0) {
      this.sessionTools.delete(sessionId);
      return;
    }
    this.sessionTools.set(sessionId, [...tools]);
    harnessLog('info', `McpToolsRegistry: recorded ${tools.length} MCP tools for session ${sessionId}`);
  }

  getSessionTools(sessionId: number | null | undefined): McpToolRef[] {
    if (sessionId == null) return [];
    return this.sessionTools.get(sessionId) ?? [];
  }

  hasTools(sessionId: number | null | undefined): boolean {
    const tools = sessionId != null ? this.sessionTools.get(sessionId) : undefined;
    return tools != null && tools.length > 0;
  }

  /** CLOUD 快照：仅覆盖，不删除——某轮全部 server 连接失败时沿用上次成功快照。 */
  reportCloudSnapshot(sessionId: number | null | undefined, tools: McpToolRef[] | null | undefined): void {
    if (sessionId == null) return;
    if (!tools || tools.length === 0) return;
    this.cloudSnapshot.set(sessionId, [...tools]);
    harnessLog('info', `McpToolsRegistry: recorded CLOUD snapshot of ${tools.length} MCP tools for session ${sessionId}`);
  }

  getCloudSnapshot(sessionId: number | null | undefined): McpToolRef[] {
    if (sessionId == null) return [];
    return this.cloudSnapshot.get(sessionId) ?? [];
  }

  clear(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    this.sessionTools.delete(sessionId);
    this.cloudSnapshot.delete(sessionId);
  }
}
