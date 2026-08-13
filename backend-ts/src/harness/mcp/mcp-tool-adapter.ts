import type { Tool } from '../tool/tool.js';
import { fullToolName, normalizeMcpInputSchema, type McpToolRef } from './entity/mcp-server.js';
import type { McpClientManager } from './mcp-client-manager.js';

export class McpToolAdapter implements Tool {
  constructor(
    private readonly ref: McpToolRef,
    private readonly clientManager: McpClientManager | null,
  ) {}

  getName(): string {
    return this.ref.fullToolName ?? fullToolName(this.ref.serverName, this.ref.toolName);
  }

  getDescription(): string {
    return this.ref.description;
  }

  getInputSchema(): Record<string, unknown> {
    const raw = this.ref.inputSchema
      ?? (this.ref as { schema?: Record<string, unknown> }).schema
      ?? {};
    return normalizeMcpInputSchema(raw);
  }

  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', description: 'MCP 工具执行结果' };
  }

  execute(argumentsJson: string, a?: unknown, _b?: unknown, _c?: unknown): string | Promise<string> {
    if (!this.clientManager) {
      return '{"error":"MCP 工具在 LOCAL 模式下由桌面端执行，服务端无法直接调用"}';
    }
    const sessionId = typeof a === 'number' ? a : null;
    return this.clientManager.callTool(sessionId, this.ref.serverId, this.ref.toolName, argumentsJson);
  }

  getRef(): McpToolRef {
    return this.ref;
  }
}
