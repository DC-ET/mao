import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { RuntimeChannelServer, type RuntimeStatus } from './runtime-channel-server.js';
import { RuntimeAgent } from './runtime-agent.js';
import { ContainerMcpBridge } from './container-mcp-bridge.js';
import type { ContainerPty, ContainerPtyFactory } from './pty-hub.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

/**
 * 容器内 runtime agent 的通道行为回归（round-01 BUG-1 / BUG-6 / BUG-7）：
 * 用真实 RuntimeChannelServer + 真实 RuntimeAgent 打通 Unix socket，
 * 断言连接稳定性、pty_open ack、mcp_connect envelope 透传。
 */
const ROOT_ENV_KEYS = ['MAO_WORKSPACE_ROOT', 'MAO_RUNTIME_DIR', 'MAO_USER_HOME_DIR', 'MAO_USER_SKILLS_DIR'];

function envelopeOf(workspace: string): RuntimeEnvelope {
  return {
    userId: 7,
    sessionId: 11,
    workspace,
    home: '/tmp',
    runtimeDir: '/tmp/rt',
    gitTokens: { 'github.com': 'ghp_probe' },
    maoToken: 'eyJ-probe',
    ecpToken: 'ecp-probe',
    larkUat: null,
    depsEnv: { NPM_CONFIG_PREFIX: '/deps/7/npm' },
    envVars: {},
  };
}

describe('runtime agent channel behavior', () => {
  let server: RuntimeChannelServer | null = null;
  let agent: RuntimeAgent | null = null;
  const savedEnv = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of ROOT_ENV_KEYS) savedEnv.set(key, process.env[key]);
  });

  afterEach(async () => {
    agent?.dispose();
    agent = null;
    await server?.stop();
    server = null;
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    savedEnv.clear();
    vi.restoreAllMocks();
  });

  async function startAgent(base: string, statuses: RuntimeStatus[], ptyFactory?: ContainerPtyFactory) {
    const channelDir = join(base, 'channels');
    mkdirSync(channelDir, { recursive: true });
    server = new RuntimeChannelServer({
      channelDir,
      tokenOf: () => 'probe-token',
      onRuntimeStatus: (_userId, status) => statuses.push(status),
    });
    process.env.MAO_WORKSPACE_ROOT = join(base, 'workspace');
    process.env.MAO_RUNTIME_DIR = join(base, 'runtime');
    process.env.MAO_USER_HOME_DIR = join(base, 'users');
    process.env.MAO_USER_SKILLS_DIR = join(base, 'userskills');
    const socketPath = await server.ensureListening(7);
    agent = new RuntimeAgent(socketPath, 'probe-token', 7, ptyFactory);
    void agent.run();
    await vi.waitFor(() => expect(server!.getConnection(7)).not.toBeNull(), { timeout: 5000 });
    return server!.getConnection(7)!;
  }

  it('keepsConnectionStableAndAnswersInFlightToolCalls', async () => {
    // BUG-1 回归：握手完成后连接不得每 ~500ms 自我回收；在途 tool_call 必须拿到 tool_result
    const base = useTmpDir('mao-agent-conn-');
    const userWorkspace = join(base, 'workspace', '7');
    mkdirSync(userWorkspace, { recursive: true });
    const statuses: RuntimeStatus[] = [];
    const conn = await startAgent(base, statuses);

    const response = await conn.request({
      v: 1, type: 'tool_call', id: 'tool-sleep', tool: 'shell',
      args: JSON.stringify({ action: 'exec', command: 'sleep 0.3; echo done', yield_time_ms: 5000 }),
      envelope: envelopeOf(userWorkspace),
    }, 10_000);
    expect(response.type).toBe('tool_result');
    if (response.type !== 'tool_result') return;
    expect(response.ok).toBe(true);
    expect(JSON.parse(response.result ?? '{}').output).toContain('done');

    // 2s 内连接对象不变（旧实现每个 500ms 周期就被换掉）
    await new Promise((resolve) => setTimeout(resolve, 2000));
    expect(server!.getConnection(7)).toBe(conn);

    // 就绪后立即补报一次 runtime_status（idle 忙等保护不等下一个 10s 周期）
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[0]).toEqual({ shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 });
  });

  it('acksPtyOpenWithPid', async () => {
    // BUG-6 回归：pty_open 是请求/响应语义，spawn 成功必须回 pid（宿主机不再干等 20s 超时）
    const base = useTmpDir('mao-agent-pty-');
    const fakePty: ContainerPty = {
      pid: 4242,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(),
      onExit: vi.fn(),
    };
    const statuses: RuntimeStatus[] = [];
    const conn = await startAgent(base, statuses, () => fakePty);

    const ok = await conn.request({
      v: 1, type: 'pty_open', id: 'open-ok', ptyId: 'pty-ok',
      options: { shell: '/bin/bash', args: ['-i'], cwd: '/tmp', cols: 80, rows: 24, env: {} },
    }, 5000);
    expect(ok.type).toBe('pty_open_result');
    if (ok.type !== 'pty_open_result') return;
    expect(ok.ok).toBe(true);
    expect(ok.pid).toBe(4242);
  });

  it('acksPtyOpenFailureFastAndReportsExit', async () => {
    // BUG-6 回归：spawn 失败快速回 ok:false + error，同时按退出码 -1 收尾
    const base = useTmpDir('mao-agent-pty-bad-');
    const failing: ContainerPtyFactory = () => { throw new Error('posix_spawnp failed'); };
    const statuses: RuntimeStatus[] = [];
    const conn = await startAgent(base, statuses, failing);
    const exits: Array<{ ptyId: string; exitCode: number }> = [];
    conn.onPtyExit((ptyId, exitCode) => exits.push({ ptyId, exitCode }));

    const bad = await conn.request({
      v: 1, type: 'pty_open', id: 'open-bad', ptyId: 'pty-bad',
      options: { shell: '/nonexistent-shell-xyz', args: ['-i'], cwd: '/tmp', cols: 80, rows: 24, env: {} },
    }, 5000);
    expect(bad.type).toBe('pty_open_result');
    if (bad.type !== 'pty_open_result') return;
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain('posix_spawnp failed');
    await vi.waitFor(() => expect(exits).toEqual([{ ptyId: 'pty-bad', exitCode: -1 }]), { timeout: 5000 });
  });

  it('passesEnvelopeToMcpConnect', async () => {
    // BUG-7 回归：mcp_connect 必须把 envelope 透传给容器内 MCP 桥（stdio 子进程的用户凭据来源）
    const base = useTmpDir('mao-agent-mcp-');
    const spy = vi.spyOn(ContainerMcpBridge.prototype, 'connectAndListTools').mockResolvedValue([]);
    const statuses: RuntimeStatus[] = [];
    const conn = await startAgent(base, statuses);
    const envelope = envelopeOf(join(base, 'workspace', '7'));

    const response = await conn.request({
      v: 1, type: 'mcp_connect', id: 'mcpconn-1', sessionId: 11,
      server: { id: 3, name: 'fs', serverType: 'stdio', command: 'node', argsJson: '["srv.js"]', url: null },
      env: { PATH: '/usr/bin:/bin' },
      envelope,
    }, 10_000);
    expect(response.type).toBe('mcp_result');

    await vi.waitFor(() => expect(spy).toHaveBeenCalled(), { timeout: 5000 });
    const call = spy.mock.calls[0];
    expect(call[0]).toBe(11);
    expect(call[3]).toEqual(envelope);
  });
});
