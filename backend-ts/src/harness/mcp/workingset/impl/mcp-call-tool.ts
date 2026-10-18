import { harnessLog } from '../../../log.js';
import { BaseTool } from '../../../tool/tool.js';
import type { SessionMapper } from '../../../deps.js';
import type { McpToolRef } from '../../entity/mcp-server.js';
import { fullToolName } from '../../entity/mcp-server.js';

/** 会话工具清单的最小依赖面（McpToolsRegistry 满足）。 */
export interface McpSessionToolsLookup {
  getSessionTools(sessionId: number): McpToolRef[];
  getCloudSnapshot(sessionId: number): McpToolRef[];
}

/** MCP 执行器最小依赖面（McpClientManager / RoutingMcpClientManager 均满足）。 */
export interface McpToolCaller {
  callTool(sessionId: number | null, serverId: number, toolName: string, argumentsJson: string): Promise<string>;
}

export interface McpCallToolDeps {
  sessionMapper: Pick<SessionMapper, 'selectById'>;
  toolsRegistry: McpSessionToolsLookup;
  clientManager: McpToolCaller;
}

interface ParsedCall {
  server: string;
  tool: string;
  argumentsJson: string;
}

/**
 * `mcp_call(server, tool, arguments)`（技术方案 2026-10-18 §5.4.1）。
 *
 * 职责边界：
 * - 只在 CLOUD 执行（LOCAL 由 ToolDispatcher 的 LOCAL 分支还原成 `mcp__server__tool` 后
 *   委托桌面执行，审批也天然在分支内完成）。工具内部不再调用 LocalToolExecutor——
 *   那会绕开 `shouldRequireApproval` 的审批裁决。
 * - 审批不在这里做：dispatcher 在分发链路内裁决。
 * - server 寻址只在本会话已加载的工具清单内完成，模型无法借名字触达未授权 server。
 */
export class McpCallTool extends BaseTool {
  constructor(private readonly deps: McpCallToolDeps) {
    super();
  }

  getName(): string {
    return 'mcp_call';
  }

  getDescription(): string {
    return '调用 MCP 工作集中的工具。server 与 tool 名称见系统提示「MCP 工作集」；'
      + '参数结构不确定时，先调用 mcp_describe 查询该工具的完整 schema。';
  }

  getInputSchema(): Record<string, unknown> {
    return {
      type: 'object',
      required: ['server', 'tool'],
      properties: {
        server: { type: 'string', description: 'MCP server 名称（见系统提示「MCP 工作集」）' },
        tool: { type: 'string', description: '该 server 暴露的工具名' },
        arguments: {
          type: 'object',
          description: '工具自身的参数对象；结构不确定时先用 mcp_describe 查询',
          default: {},
        },
      },
    };
  }

  getOutputSchema(): Record<string, unknown> {
    return { type: 'object', description: 'MCP 工具执行结果' };
  }

  protected async executeWithSession(
    argumentsJson: string,
    sessionId: number | null,
    _workspace: string | null,
  ): Promise<string> {
    const parsed = parseCallArguments(argumentsJson);
    if ('error' in parsed) return JSON.stringify({ error: parsed.error });
    if (sessionId == null) {
      return JSON.stringify({ error: 'mcp_call 需要会话上下文才能定位 MCP 工具清单' });
    }

    const session = await this.deps.sessionMapper.selectById(sessionId);
    const executionMode = (session?.executionMode ?? 'CLOUD').toUpperCase();
    if (executionMode === 'LOCAL') {
      // 防御：dispatcher 已把 LOCAL 的 mcp_call 还原成全名下发。真走到这里说明调用链异常，
      // 直接报错优于在工具内部以「无审批」方式下发到桌面端。
      harnessLog('warn', `mcp_call reached tool execution in LOCAL session ${sessionId}; dispatcher should restore full tool name`);
      return JSON.stringify({ error: 'LOCAL 会话的 MCP 工具调用必须经工具分发器还原执行，当前调用链异常' });
    }

    const refs = this.deps.toolsRegistry.getCloudSnapshot(sessionId);
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
        availableTools: this.toolsOfServer(refs, parsed.server),
      });
    }
    if (ref.serverId <= 0) {
      return JSON.stringify({ error: `MCP server ${parsed.server} 缺少服务端连接标识，无法调用` });
    }
    harnessLog('info', `mcp_call: session=${sessionId}, server=${parsed.server}, tool=${parsed.tool}`);
    return await this.deps.clientManager.callTool(sessionId, ref.serverId, ref.toolName, parsed.argumentsJson);
  }

  private toolsOfServer(refs: McpToolRef[], serverName: string): string[] {
    return refs
      .filter((item) => item.serverName === serverName)
      .map((item) => item.toolName)
      .sort();
  }
}

/** 解析外壳参数；`arguments` 缺省为 {}，非对象 / 非法 JSON 直接返回错误（不发起调用）。 */
export function parseCallArguments(argumentsJson: string): ParsedCall | { error: string } {
  if (argumentsJson == null || argumentsJson.trim() === '') {
    return { error: 'mcp_call 参数不能为空，至少需要 server 与 tool' };
  }
  let root: unknown;
  try {
    root = JSON.parse(argumentsJson);
  } catch {
    return { error: 'mcp_call 参数不是合法 JSON 对象，请重新生成参数后重试' };
  }
  if (root == null || typeof root !== 'object' || Array.isArray(root)) {
    return { error: 'mcp_call 参数必须是 JSON 对象' };
  }
  const node = root as Record<string, unknown>;
  const server = typeof node.server === 'string' ? node.server.trim() : '';
  const tool = typeof node.tool === 'string' ? node.tool.trim() : '';
  if (server === '' || tool === '') {
    return { error: 'mcp_call 缺少 server 或 tool 参数' };
  }
  const inner = node.arguments;
  if (inner != null && (typeof inner !== 'object' || Array.isArray(inner))) {
    return { error: 'mcp_call 的 arguments 必须是 JSON 对象' };
  }
  const normalizedInner = (inner ?? {}) as Record<string, unknown>;
  return {
    server,
    tool,
    argumentsJson: JSON.stringify(normalizedInner),
  };
}

/** 供摘要 / 展示层复用：从 mcp_call 外壳参数里取 `server.tool`（解析失败返回 null）。 */
export function mcpCallTarget(argumentsJson: string | null | undefined): { server: string; tool: string } | null {
  if (argumentsJson == null) return null;
  try {
    const parsed = JSON.parse(argumentsJson) as Record<string, unknown>;
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const server = typeof parsed.server === 'string' ? parsed.server.trim() : '';
    const tool = typeof parsed.tool === 'string' ? parsed.tool.trim() : '';
    return server !== '' && tool !== '' ? { server, tool } : null;
  } catch {
    return null;
  }
}

/** 全名还原（dispatcher LOCAL 分支使用）：无法还原返回 null。 */
export function restoreMcpFullToolName(argumentsJson: string): string | null {
  const target = mcpCallTarget(argumentsJson);
  return target == null ? null : fullToolName(target.server, target.tool);
}

export interface RestoredMcpCall {
  /** `mcp__{server}__{tool}`，桌面端 executeToolByName 的 mcp__ 分支据此路由。 */
  fullToolName: string;
  /** 拆出的内层工具参数（不含 server / tool 外壳字段）。 */
  argumentsJson: string;
}

/**
 * LOCAL 会话的 mcp_call 还原：返回全名 + 内层参数；解析失败返回 null
 * （dispatcher 据此走「MCP 工具但无法归名」的保守审批分支）。
 */
export function restoreMcpCallForLocal(argumentsJson: string): RestoredMcpCall | null {
  const parsed = parseCallArguments(argumentsJson);
  if ('error' in parsed) return null;
  return {
    fullToolName: fullToolName(parsed.server, parsed.tool),
    argumentsJson: parsed.argumentsJson,
  };
}
