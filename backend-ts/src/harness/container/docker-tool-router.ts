import { harnessLog } from '../log.js';
import { newFrameId } from './runtime-channel-protocol.js';
import type { RuntimeChannelServer } from './runtime-channel-server.js';
import type { ContainerRegistry } from './container-registry.js';
import type { SessionEnvelopeBuilder } from './session-envelope-builder.js';

/**
 * docker 模式下必须进容器执行的工具（技术方案 §5.7.1）。
 *
 * 注意 `mcp__*` 不在本清单内：MCP 工具经 ToolDispatcher 的 sessionTools 命中，
 * 其连接与 callTool 由 RoutingMcpClientManager 路由到 DockerToolRouter 的
 * mcpConnect/mcpCall（§5.10），容器内 ContainerMcpBridge spawn stdio 子进程。
 * 若把 `mcp__*` 并进本清单，它会被当成普通 tool_call 帧发进容器，而容器执行器
 * 只注册文件/shell 工具，MCP 调用必然失败。
 */
export const DOCKER_ONLY_TOOLS = new Set(['shell', 'read_file', 'write_file', 'edit_file', 'glob_search', 'grep_search']);

export function isDockerOnlyTool(toolName: string): boolean {
  return DOCKER_ONLY_TOOLS.has(toolName);
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
 * enabledFor 判定的短 TTL 缓存（§5.7.1「host 模式零变化」）：host 模式下每个
 * docker-only 工具调用都要判定一次，不缓存则每次多一次 userRepo 查库。用户改
 * runtime_mode 后最多一个 TTL 生效；全局模式进缓存 key，切换立即反映。
 */
const RUNTIME_MODE_CACHE_TTL_MS = 5_000;

/**
 * DockerToolRouter（技术方案 §3.2 / §5.7.1）：docker 模式唯一的派发分支。
 * ensureRunning → envelope → RuntimeChannelServer.request。
 * host 模式下 ToolDispatcher 不经过本类，代码路径零变化。
 */
export class DockerToolRouter {
  private readonly modeCache = new Map<string, { value: boolean; atMs: number }>();

  constructor(
    private readonly deps: {
      containerRegistry: ContainerRegistry;
      channelServer: RuntimeChannelServer;
      envelopeBuilder: SessionEnvelopeBuilder;
      runtimeModeLookup: UserRuntimeModeLookup;
      /** 全局模式解析（system_setting.runtime.mode → MAO_CLOUD_RUNTIME 回落，见 RuntimeModeResolver）。 */
      globalMode: () => Promise<'host' | 'docker'>;
    },
  ) {}

  /** 用户是否走容器：用户级字段优先，空跟随全局。 */
  async enabledFor(userId: number): Promise<boolean> {
    // globalMode 内部有短 TTL 缓存；后台切换后 resolver.invalidate() 立即反映到缓存 key
    const global = await this.deps.globalMode();
    const cacheKey = `${global}:${userId}`;
    const now = Date.now();
    const cached = this.modeCache.get(cacheKey);
    if (cached && now - cached.atMs < RUNTIME_MODE_CACHE_TTL_MS) return cached.value;
    const override = await this.deps.runtimeModeLookup.runtimeModeOf(userId);
    const value = global === 'docker' ? override !== 'host' : override === 'docker';
    this.modeCache.set(cacheKey, { value, atMs: now });
    return value;
  }

  /** ensureRunning + 通道就绪（终端 pty / read_bytes / MCP 等非工具链路复用）。 */
  async ensureReady(userId: number, workspace?: string | null): Promise<void> {
    await this.deps.containerRegistry.ensureRunning(userId, workspace);
  }

  async dispatch(toolName: string, argumentsJson: string, ctx: DockerDispatchContext): Promise<string> {
    const started = Date.now();
    // requiredWorkspace：通道会话工作区越出每用户根，未挂载时容器需重建后才能真正执行
    const entry = await this.deps.containerRegistry.ensureRunning(ctx.userId, ctx.workspace);
    entry.lastUsedAtMs = Date.now();
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
    const entry = await this.deps.containerRegistry.ensureRunning(input.userId, input.workspace);
    entry.lastUsedAtMs = Date.now();
    const envelope = await this.deps.envelopeBuilder.build({
      userId: input.userId, sessionId: input.sessionId, workspace: input.workspace,
    });
    const connection = this.deps.channelServer.getConnection(input.userId);
    if (!connection) throw new Error(`用户运行时容器未就绪（channel 未连接）: userId=${input.userId}`);
    const id = newFrameId('bytes');
    const response = await connection.request({
      v: 1, type: 'read_bytes', id, path: input.path, maxBytes: input.maxBytes, envelope,
    }, 120_000);
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
    const entry = await this.deps.containerRegistry.ensureRunning(input.userId);
    entry.lastUsedAtMs = Date.now();
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
    const entry = await this.deps.containerRegistry.ensureRunning(input.userId);
    entry.lastUsedAtMs = Date.now();
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
  /** 只读注解：工作集 `[只读]` 标记与审批免审依赖它跨通道透传。 */
  annotations?: { readOnlyHint?: boolean } | null;
}
