import { afterEach, describe, expect, it, vi } from 'vitest';
import { DockerToolRouter, isDockerOnlyTool } from './docker-tool-router.js';

/**
 * docker 派发路由回归（round-01 BUG-5 / BUG-12）：
 * mcp__* 不得进 tool_call 容器派发清单；enabledFor 判定按 userId + 全局模式短 TTL
 * 缓存，host 模式下不再每次工具调用都查库。
 */
describe('docker tool router', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('dockerOnlyListCoversFileAndShellToolsButNotMcp', () => {
    // BUG-5 回归：mcp__* 走 RoutingMcpClientManager 的 mcpConnect/mcpCall，
    // 不进 DOCKER_ONLY_TOOLS（容器执行器没有 MCP 工具，进清单即全灭）
    expect(isDockerOnlyTool('shell')).toBe(true);
    expect(isDockerOnlyTool('read_file')).toBe(true);
    expect(isDockerOnlyTool('write_file')).toBe(true);
    expect(isDockerOnlyTool('edit_file')).toBe(true);
    expect(isDockerOnlyTool('glob_search')).toBe(true);
    expect(isDockerOnlyTool('grep_search')).toBe(true);
    expect(isDockerOnlyTool('mcp__filesystem__write_file')).toBe(false);
    expect(isDockerOnlyTool('web_search')).toBe(false);
    expect(isDockerOnlyTool('ask_user_questions')).toBe(false);
  });

  function makeRouter(globalMode: 'host' | 'docker', mode: 'docker' | 'host' | null) {
    const runtimeModeOf = vi.fn(async () => mode);
    const router = new DockerToolRouter({
      containerRegistry: {} as never,
      channelServer: {} as never,
      envelopeBuilder: {} as never,
      runtimeModeLookup: { runtimeModeOf },
      globalMode: () => globalMode,
    });
    return { router, runtimeModeOf };
  }

  it('userOverrideTakesPrecedenceOverGlobalMode', async () => {
    const hostOverride = makeRouter('host', 'docker');
    expect(await hostOverride.router.enabledFor(7)).toBe(true);
    const dockerOverride = makeRouter('docker', 'host');
    expect(await dockerOverride.router.enabledFor(7)).toBe(false);
    const followGlobal = makeRouter('docker', null);
    expect(await followGlobal.router.enabledFor(7)).toBe(true);
    const hostDefault = makeRouter('host', null);
    expect(await hostDefault.router.enabledFor(7)).toBe(false);
  });

  it('cachesRuntimeModeLookupForShortTtl', async () => {
    // BUG-12 回归：TTL 内重复判定只查库一次（host 模式每次工具调用不再多一次 userRepo 查询）
    vi.useFakeTimers();
    const { router, runtimeModeOf } = makeRouter('host', null);
    expect(await router.enabledFor(7)).toBe(false);
    expect(await router.enabledFor(7)).toBe(false);
    expect(await router.enabledFor(7)).toBe(false);
    expect(runtimeModeOf).toHaveBeenCalledTimes(1);
    // TTL 过后重新查库（用户改 runtime_mode 最多一个 TTL 生效）
    vi.advanceTimersByTime(5_001);
    expect(await router.enabledFor(7)).toBe(false);
    expect(runtimeModeOf).toHaveBeenCalledTimes(2);
  });

  it('reflectsGlobalModeSwitchImmediately', async () => {
    // 缓存 key 含全局模式：运维切 MAO_CLOUD_RUNTIME 重启后立即按新模式判定
    vi.useFakeTimers();
    let globalMode: 'host' | 'docker' = 'host';
    const runtimeModeOf = vi.fn(async () => null);
    const router = new DockerToolRouter({
      containerRegistry: {} as never,
      channelServer: {} as never,
      envelopeBuilder: {} as never,
      runtimeModeLookup: { runtimeModeOf },
      globalMode: () => globalMode,
    });
    expect(await router.enabledFor(7)).toBe(false);
    globalMode = 'docker';
    expect(await router.enabledFor(7)).toBe(true);
    expect(runtimeModeOf).toHaveBeenCalledTimes(2);
  });

  it('passesSessionWorkspaceToEnsureRunningOnDispatch', async () => {
    // N-2 回归：dispatch 必须把会话工作区交给 ensureRunning——通道会话工作区越出
    // 每用户根，缺了它容器不会挂载该目录，shell 会以空输出 + 秒退静默失败
    const ensureRunning = vi.fn(async () => ({
      userId: 7, containerName: 'mao-user-7', state: 'running', startedAtMs: 1, lastUsedAtMs: 1,
      inContainer: { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 },
      connectionDead: false, mountedPaths: new Set<string>(), sessionWorkspaces: [],
    }));
    const request = vi.fn(async () => ({ v: 1, type: 'tool_result', id: 'x', ok: true, result: 'done' }));
    const router = new DockerToolRouter({
      containerRegistry: { ensureRunning } as never,
      channelServer: { getConnection: () => ({ request }) } as never,
      envelopeBuilder: { build: async () => ({ userId: 7 }) } as never,
      runtimeModeLookup: { runtimeModeOf: async () => 'docker' },
      globalMode: () => 'docker',
    });
    const result = await router.dispatch('shell', '{"action":"exec","command":"echo hi"}', {
      userId: 7, sessionId: 11, workspace: '/opt/mao-data/workspace/feishu-chat/bot-1/oc_chat',
    });
    expect(result).toBe('done');
    expect(ensureRunning).toHaveBeenCalledWith(7, '/opt/mao-data/workspace/feishu-chat/bot-1/oc_chat');
  });

  it('passesSessionWorkspaceToEnsureRunningOnReadBytes', async () => {
    // N-2 回归：外部发送工具的容器读字节链路同样携带会话工作区
    const ensureRunning = vi.fn(async () => ({
      userId: 7, containerName: 'mao-user-7', state: 'running', startedAtMs: 1, lastUsedAtMs: 1,
      inContainer: { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 },
      connectionDead: false, mountedPaths: new Set<string>(), sessionWorkspaces: [],
    }));
    const request = vi.fn(async () => ({ v: 1, type: 'read_bytes_result', id: 'x', ok: true, base64: Buffer.from('hi').toString('base64') }));
    const router = new DockerToolRouter({
      containerRegistry: { ensureRunning } as never,
      channelServer: { getConnection: () => ({ request }) } as never,
      envelopeBuilder: { build: async () => ({ userId: 7 }) } as never,
      runtimeModeLookup: { runtimeModeOf: async () => 'docker' },
      globalMode: () => 'docker',
    });
    const bytes = await router.readBytes({
      userId: 7, sessionId: 11, workspace: '/opt/mao-data/workspace/dingtalk-chat/bot-1/p2p-7',
      path: 'chat-files/a.png', maxBytes: 1024,
    });
    expect(bytes?.toString()).toBe('hi');
    expect(ensureRunning).toHaveBeenCalledWith(7, '/opt/mao-data/workspace/dingtalk-chat/bot-1/p2p-7');
  });
});
