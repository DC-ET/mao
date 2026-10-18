import { harnessLog } from '../../log.js';
import type { McpConnectionError, McpToolRef } from '../entity/mcp-server.js';

/**
 * MCP 工具注册表：LOCAL（桌面上报）与 CLOUD（服务端连接快照）两个维度分开存，
 * 避免互相覆盖。两者语义对齐——工具集只在「服务端 MCP 配置变化 / 新会话」时变化，
 * 不在连接抖动时变化，因此 LLM 请求的 tools 数组逐字节稳定（前缀缓存前提，技术方案 §4.5）。
 */
export class McpToolsRegistry {
  private readonly sessionTools = new Map<number, McpToolRef[]>();
  /** 最近一次桌面上报里连接失败的 server（与工具清单同批写入，供工作集标注不可用）。 */
  private readonly connectionErrors = new Map<number, McpConnectionError[]>();
  /** CLOUD 维度快照：会话内最近一次成功连接得到的工具集（按 (serverName, toolName) 排序）。 */
  private readonly cloudSnapshot = new Map<number, McpToolRef[]>();
  /** 会话删除才清快照，故需上限防止长跑进程泄漏（与 prompt-prefix-monitor 同策略）。 */
  private static readonly MAX_SNAPSHOT_SESSIONS = 512;

  report(
    sessionId: number | null | undefined,
    tools: McpToolRef[] | null | undefined,
    connectionErrors: McpConnectionError[] | null | undefined = [],
  ): void {
    if (sessionId == null) return;
    // 失败信息独立于工具清单：全部连接失败时 tools 为空，但错误清单仍要保留给工作集标注。
    if (connectionErrors && connectionErrors.length > 0) {
      this.connectionErrors.set(sessionId, [...connectionErrors]);
    } else {
      this.connectionErrors.delete(sessionId);
    }
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

  /** 最近一次桌面上报的连接失败清单（无则空数组）。 */
  getConnectionErrors(sessionId: number | null | undefined): McpConnectionError[] {
    if (sessionId == null) return [];
    return this.connectionErrors.get(sessionId) ?? [];
  }

  hasTools(sessionId: number | null | undefined): boolean {
    const tools = sessionId != null ? this.sessionTools.get(sessionId) : undefined;
    return tools != null && tools.length > 0;
  }

  /** CLOUD 快照：仅覆盖，不删除——某轮全部 server 连接失败时沿用上次成功快照。 */
  reportCloudSnapshot(sessionId: number | null | undefined, tools: McpToolRef[] | null | undefined): void {
    if (sessionId == null) return;
    if (!tools || tools.length === 0) return;
    // 重新 set 把该键移到插入序末尾，超出上限时淘汰最旧的一个（LRU 简易实现）。
    // 被淘汰会话下次连接时按「首轮无快照」处理（等同该会话首次执行），不产生错误结论。
    this.cloudSnapshot.delete(sessionId);
    this.cloudSnapshot.set(sessionId, [...tools]);
    while (this.cloudSnapshot.size > McpToolsRegistry.MAX_SNAPSHOT_SESSIONS) {
      const oldest = this.cloudSnapshot.keys().next();
      if (oldest.done) break;
      this.cloudSnapshot.delete(oldest.value);
    }
    harnessLog('info', `McpToolsRegistry: recorded CLOUD snapshot of ${tools.length} MCP tools for session ${sessionId}`);
  }

  getCloudSnapshot(sessionId: number | null | undefined): McpToolRef[] {
    if (sessionId == null) return [];
    return this.cloudSnapshot.get(sessionId) ?? [];
  }

  clear(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    this.sessionTools.delete(sessionId);
    this.connectionErrors.delete(sessionId);
    this.cloudSnapshot.delete(sessionId);
  }

  /**
   * 只清 CLOUD 快照（不动桌面上报的 LOCAL 工具）。
   *
   * CLOUD 快照的存活期是「会话级」而非「执行级」：技术方案 §4.5 要求同一会话内
   * 某 server 连接失败时沿用上次成功连接的工具集，而 connectForCloud 每次执行
   * 只在 buildContext 调用一次——若在每次执行结束时清快照，下一轮必然取不到，
   * 「沿用」语义在主路径上直接落空。因此清理只发生在会话删除 / 会话工具重同步路径。
   */
  clearCloudSnapshot(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    this.cloudSnapshot.delete(sessionId);
  }

  /** 只清桌面上报的 LOCAL 工具，保留 CLOUD 快照（存活期见 clearCloudSnapshot）。 */
  clearLocalSession(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    this.sessionTools.delete(sessionId);
    this.connectionErrors.delete(sessionId);
  }
}
