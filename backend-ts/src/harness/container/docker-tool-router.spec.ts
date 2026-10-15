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
});
