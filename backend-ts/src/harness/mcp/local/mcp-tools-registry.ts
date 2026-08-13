import { harnessLog } from '../../log.js';
import type { McpToolRef } from '../entity/mcp-server.js';

export class McpToolsRegistry {
  private readonly sessionTools = new Map<number, McpToolRef[]>();

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

  clear(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    this.sessionTools.delete(sessionId);
  }
}
