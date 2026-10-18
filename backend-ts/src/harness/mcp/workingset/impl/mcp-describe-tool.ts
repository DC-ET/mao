import { BaseTool } from '../../../tool/tool.js';
import type { SessionMapper } from '../../../deps.js';
import type { McpToolRef } from '../../entity/mcp-server.js';
import type { McpSessionToolsLookup } from './mcp-call-tool.js';

export interface McpDescribeToolDeps {
  sessionMapper: Pick<SessionMapper, 'selectById'>;
  toolsRegistry: McpSessionToolsLookup;
}

/**
 * `mcp_describe(server, tool)`（技术方案 2026-10-18 §5.4.2）。
 *
 * 只从本会话已缓存的工具清单取 schema：不向 MCP server 二次查询、不新建连接，
 * 因此两种执行模式（CLOUD / LOCAL）都走服务端这条纯本地查询。
 */
export class McpDescribeTool extends BaseTool {
  constructor(private readonly deps: McpDescribeToolDeps) {
    super();
  }

  getName(): string {
    return 'mcp_describe';
  }

  getDescription(): string {
    return '查询 MCP 工作集中某个工具的完整参数 schema。参数结构不确定时先调用本工具，再调用 mcp_call。';
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['server', 'tool'],
      properties: {
        server: { type: 'string', description: 'MCP server 名称' },
        tool: { type: 'string', description: '工具名' },
      },
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      description: '工具描述与参数 schema（server / tool / description / inputSchema）',
    };
  }

  protected async executeWithSession(
    argumentsJson: string,
    sessionId: number | null,
    _workspace: string | null,
  ): Promise<string> {
    const parsed = parseDescribeArguments(argumentsJson);
    if ('error' in parsed) return JSON.stringify({ error: parsed.error });
    if (sessionId == null) {
      return JSON.stringify({ error: 'mcp_describe 需要会话上下文才能定位 MCP 工具清单' });
    }

    const session = await this.deps.sessionMapper.selectById(sessionId);
    const executionMode = (session?.executionMode ?? 'CLOUD').toUpperCase();
    const refs = executionMode === 'LOCAL'
      ? this.deps.toolsRegistry.getSessionTools(sessionId)
      : this.deps.toolsRegistry.getCloudSnapshot(sessionId);
    if (refs.length === 0) {
      return JSON.stringify({
        error: '本会话没有可用的 MCP 工具（工具清单同步失败或该会话未加载 MCP 服务器），请稍后重试或检查 MCP 服务器配置',
      });
    }
    const ref = refs.find((item) => item.serverName === parsed.server && item.toolName === parsed.tool);
    if (ref == null) {
      return JSON.stringify({
        error: `未找到 MCP 工具 ${parsed.server}.${parsed.tool}`,
        availableServers: [...new Set(refs.map((item) => item.serverName))].sort(),
        availableTools: toolsOfServer(refs, parsed.server),
      });
    }
    return JSON.stringify({
      server: ref.serverName,
      tool: ref.toolName,
      description: ref.description,
      inputSchema: ref.inputSchema ?? {},
    });
  }
}

function toolsOfServer(refs: McpToolRef[], serverName: string): string[] {
  return refs
    .filter((item) => item.serverName === serverName)
    .map((item) => item.toolName)
    .sort();
}

export function parseDescribeArguments(argumentsJson: string): { server: string; tool: string } | { error: string } {
  if (argumentsJson == null || argumentsJson.trim() === '') {
    return { error: 'mcp_describe 参数不能为空，至少需要 server 与 tool' };
  }
  let root: unknown;
  try {
    root = JSON.parse(argumentsJson);
  } catch {
    return { error: 'mcp_describe 参数不是合法 JSON 对象，请重新生成参数后重试' };
  }
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    return { error: 'mcp_describe 参数必须是 JSON 对象' };
  }
  const node = root as Record<string, unknown>;
  const server = typeof node.server === 'string' ? node.server.trim() : '';
  const tool = typeof node.tool === 'string' ? node.tool.trim() : '';
  if (server === '' || tool === '') {
    return { error: 'mcp_describe 缺少 server 或 tool 参数' };
  }
  return { server, tool };
}
