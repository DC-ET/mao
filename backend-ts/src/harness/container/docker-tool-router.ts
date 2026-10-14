import { harnessLog } from '../log.js';
import { newFrameId } from './runtime-channel-protocol.js';
import type { RuntimeChannelServer } from './runtime-channel-server.js';
import type { ContainerRegistry } from './container-registry.js';
import type { SessionEnvelopeBuilder } from './session-envelope-builder.js';

/** docker 模式下必须进容器执行的工具（技术方案 §5.7.1）。mcp__* 前缀另行匹配。 */
export const DOCKER_ONLY_TOOLS = new Set(['shell', 'read_file', 'write_file', 'edit_file', 'glob_search', 'grep_search']);
export const MCP_TOOL_PREFIX = 'mcp__';

export function isDockerOnlyTool(toolName: string): boolean {
  return DOCKER_ONLY_TOOLS.has(toolName) || toolName.startsWith(MCP_TOOL_PREFIX);
}

export interface UserRuntimeModeLookup {
  /** 用户级覆盖：'docker' / 'host' / null（跟随全局）。 */
  runtimeModeOf(userId: number): Promise<'docker' | 'host' | null>;
}

export interface DockerDispatchContext {
  userId: number;
  sessionId: number | null;
  workspace: string | null;
}

/** 工具结果回传与容器请求超时：shell exec 默认 yield 300s、async 后台任务续等可达数分钟，取 30 分钟兜底。 */
const TOOL_CALL_TIMEOUT_MS = 30 * 60_000;

/**
 * DockerToolRouter（技术方案 §3.2 / §5.7.1）：docker 模式唯一的派发分支。
 * ensureRunning → envelope → RuntimeChannelServer.request。
 * host 模式下 ToolDispatcher 不经过本类，代码路径零变化。
 */
export class DockerToolRouter {
  constructor(
    private readonly deps: {
      containerRegistry: ContainerRegistry;
      channelServer: RuntimeChannelServer;
      envelopeBuilder: SessionEnvelopeBuilder;
      runtimeModeLookup: UserRuntimeModeLookup;
      /** 全局 MAO_CLOUD_RUNTIME。 */
      globalMode: () => 'host' | 'docker';
    },
  ) {}

  /** 用户是否走容器：用户级字段优先，空跟随全局。 */
  async enabledFor(userId: number): Promise<boolean> {
    if (this.deps.globalMode() !== 'docker') {
      // 全局 host 时仍允许用户级显式开启 docker（部署级灰度 + 精细覆盖）
      return (await this.deps.runtimeModeLookup.runtimeModeOf(userId)) === 'docker';
    }
    return (await this.deps.runtimeModeLookup.runtimeModeOf(userId)) !== 'host';
  }

  /** ensureRunning + 通道就绪（终端 pty / read_bytes / MCP 等非工具链路复用）。 */
  async ensureReady(userId: number): Promise<void> {
    await this.deps.containerRegistry.ensureRunning(userId);
  }

  async dispatch(toolName: string, argumentsJson: string, ctx: DockerDispatchContext): Promise<string> {
    const started = Date.now();
    const entry = await this.deps.containerRegistry.ensureRunning(ctx.userId);
    const envelope = await this.deps.envelopeBuilder.build({
      userId: ctx.userId, sessionId: ctx.sessionId, workspace: ctx.workspace,
    });
    const connection = this.deps.channelServer.getConnection(ctx.userId);
    if (!connection) {
      throw new Error(`用户运行时容器未就绪（channel 未连接），请稍后重试: userId=${ctx.userId}`);
    }
    const id = newFrameId('tool');
    const response = await connection.request({
      v: 1, type: 'tool_call', id, tool: toolName, args: argumentsJson, envelope,
    }, TOOL_CALL_TIMEOUT_MS);
    entry.lastUsedAtMs = Date.now();
    if (response.type !== 'tool_result') {
      throw new Error(`容器返回了意外的响应类型: ${response.type}`);
    }
    if (!response.ok) {
      // 容器内执行失败：错误文本按工具结果口径回传（与 host 模式工具报错一致），不抛异常
      harnessLog('warn', `[docker-router] tool failed in container: user=${ctx.userId}, tool=${toolName}, error=${response.error ?? 'unknown'}`);
      return JSON.stringify({ error: response.error ?? '容器内工具执行失败' });
    }
    harnessLog('debug', `[docker-router] tool executed in container: user=${ctx.userId}, tool=${toolName}, durationMs=${Date.now() - started}`);
    return response.result ?? '';
  }

  /** 外部发送工具的容器读字节链路（§5.8）。用户不走容器时返回 null。 */
  async readBytes(input: { userId: number; sessionId: number | null; workspace: string | null; path: string; maxBytes: number }): Promise<Buffer | null> {
    if (!(await this.enabledFor(input.userId))) return null;
    const entry = await this.deps.containerRegistry.ensureRunning(input.userId);
    const envelope = await this.deps.envelopeBuilder.build({
      userId: input.userId, sessionId: input.sessionId, workspace: input.workspace,
    });
    const connection = this.deps.channelServer.getConnection(input.userId);
    if (!connection) throw new Error(`用户运行时容器未就绪（channel 未连接）: userId=${input.userId}`);
    const id = newFrameId('bytes');
    const response = await connection.request({
      v: 1, type: 'read_bytes', id, path: input.path, maxBytes: input.maxBytes, envelope,
    }, 120_000);
    entry.lastUsedAtMs = Date.now();
    if (response.type !== 'read_bytes_result') {
      throw new Error(`容器返回了意外的响应类型: ${response.type}`);
    }
    if (!response.ok || !response.base64) {
      throw new Error(response.error ?? '容器内文件读取失败');
    }
    return Buffer.from(response.base64, 'base64');
  }

  /** MCP stdio 在容器内的 connect（§5.10）。返回 listTools 的工具引用列表。 */
  async mcpConnect(input: {
    userId: number; sessionId: number; server: { id: number; name: string; serverType: string; command?: string | null; argsJson?: string | null; url?: string | null };
    env: Record<string, string>;
  }): Promise<McpToolRefLike[]> {
    await this.deps.containerRegistry.ensureRunning(input.userId);
    const envelope = await this.deps.envelopeBuilder.build({ userId: input.userId, sessionId: input.sessionId, workspace: null });
    const connection = this.deps.channelServer.getConnection(input.userId);
    if (!connection) throw new Error(`用户运行时容器未就绪（channel 未连接）: userId=${input.userId}`);
    const id = newFrameId('mcpconn');
    const response = await connection.request({
      v: 1, type: 'mcp_connect', id, sessionId: input.sessionId, server: input.server, env: input.env, envelope,
    }, 120_000);
    if (response.type !== 'mcp_result') {
      throw new Error(`容器返回了意外的响应类型: ${response.type}`);
    }
    if (!response.ok) throw new Error(response.error ?? '容器内 MCP 连接失败');
    return (response.payload as McpToolRefLike[]) ?? [];
  }

  async mcpCall(input: { userId: number; sessionId: number; serverId: number; toolName: string; argumentsJson: string }): Promise<string> {
    await this.deps.containerRegistry.ensureRunning(input.userId);
    const connection = this.deps.channelServer.getConnection(input.userId);
    if (!connection) throw new Error(`用户运行时容器未就绪（channel 未连接）: userId=${input.userId}`);
    const id = newFrameId('mcpcall');
    const response = await connection.request({
      v: 1, type: 'mcp_call', id, sessionId: input.sessionId, serverId: input.serverId, toolName: input.toolName, argumentsJson: input.argumentsJson,
    }, 10 * 60_000);
    if (response.type !== 'mcp_result') {
      throw new Error(`容器返回了意外的响应类型: ${response.type}`);
    }
    if (!response.ok) return JSON.stringify({ error: response.error ?? '容器内 MCP 调用失败' });
    return response.payload as string;
  }

  async mcpCloseSession(input: { userId: number; sessionId: number }): Promise<void> {
    const connection = this.deps.channelServer.getConnection(input.userId);
    if (!connection) return;
    const id = newFrameId('mcpclose');
    await connection.request({
      v: 1, type: 'mcp_close_session', id, sessionId: input.sessionId,
    }, 30_000).catch(() => undefined);
  }
}

/** 与 McpToolRef 同构的跨通道传输形状（避免 harness 反向依赖 mcp 实体类型）。 */
export interface McpToolRefLike {
  serverId: number;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  fullToolName: string;
}
