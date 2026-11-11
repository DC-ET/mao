import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RuntimeChannelServer, type RuntimeStatus } from './runtime-channel-server.js';
import { alignContainerTimeZone, alignPasswdHome, RuntimeAgent } from './runtime-agent.js';
import { ContainerMcpBridge } from './container-mcp-bridge.js';
import { PathSandbox } from '../safety/path-sandbox.js';
import type { ContainerPty, ContainerPtyFactory } from './pty-hub.js';
import type { RuntimeEnvelope } from './runtime-channel-protocol.js';
import { useTmpDir, useTmpDirOutsideRepo } from '../../testing/tmp-dir.js';

/**
 * 容器内 runtime agent 的通道行为回归（round-01 BUG-1 / BUG-6 / BUG-7）：
 * 用真实 RuntimeChannelServer + 真实 RuntimeAgent 打通 Unix socket，
 * 断言连接稳定性、pty_open ack、mcp_connect envelope 透传。
 */
const ROOT_ENV_KEYS = ['MAO_WORKSPACE_ROOT', 'MAO_RUNTIME_DIR', 'MAO_USER_HOME_DIR', 'MAO_USER_SKILLS_DIR', 'MAO_SKILL_VIEWS_DIR', 'MAO_SHARE_DIR', 'MAO_CONTAINER_USER_ID', 'MAO_DEPS_DIR'];

function envelopeOf(workspace: string): RuntimeEnvelope {
  return {
    userId: 7,
    sessionId: 11,
    workspace,
    home: '/tmp',
    runtimeDir: '/tmp/rt',
    gitTokens: { 'github.com': 'ghp_probe' },
    maoToken: 'eyJ-probe',
    maoBaseUrl: 'https://mao.example.com',
    ecpToken: 'ecp-probe',
    larkUat: null,
    depsEnv: { NPM_CONFIG_PREFIX: '/deps/7/npm' },
    envVars: {},
  };
}

// 通道走 Unix domain socket（AF_UNIX 文件路径）：Windows 上 listen 报 EACCES，
// 本 describe 全部为 Linux/容器部署语义
const describePosix = process.platform === 'win32' ? describe.skip : describe
describePosix('runtime agent channel behavior', () => {
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

  async function startAgent(
    base: string,
    statuses: RuntimeStatus[],
    ptyFactory?: ContainerPtyFactory,
    agentBuild?: string | null,
    hellos?: Array<{ build: string | null }>,
  ) {
    // Unix socket 路径上限 108 字节（sun_path）：仓库内夹具根已 63 字节，再拼
    // channels/<uid>/runtime.sock 会超限导致 listen EINVAL。channelDir 与路径沙箱
    // 夹具（workspace/runtime/users/...）互不依赖，单独放系统临时目录。
    // useTmpDirOutsideRepo 已 mkdtemp 建好目录，无需再 mkdirSync。
    const channelDir = useTmpDirOutsideRepo('mao-agent-chan-');
    server = new RuntimeChannelServer({
      channelDir,
      tokenOf: () => 'probe-token',
      onRuntimeStatus: (_userId, _agentId, status) => statuses.push(status),
      ...(hellos ? { onAgentHello: (_userId, _agentId, info) => hellos.push(info) } : {}),
    });
    process.env.MAO_WORKSPACE_ROOT = join(base, 'workspace');
    process.env.MAO_RUNTIME_DIR = join(base, 'runtime');
    process.env.MAO_USER_HOME_DIR = join(base, 'users');
    process.env.MAO_USER_SKILLS_DIR = join(base, 'userskills');
    process.env.MAO_SHARE_DIR = join(base, 'share');
    const socketPath = await server.ensureListening(7, 5);
    agent = new RuntimeAgent(socketPath, 'probe-token', 7, 5, ptyFactory, agentBuild ?? null);
    void agent.run();
    await vi.waitFor(() => expect(server!.getConnection(7, 5)).not.toBeNull(), { timeout: 5000 });
    return server!.getConnection(7, 5)!;
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
    expect(server!.getConnection(7, 5)).toBe(conn);

    // 就绪后立即补报一次 runtime_status（idle 忙等保护不等下一个 10s 周期）
    expect(statuses.length).toBeGreaterThanOrEqual(1);
    expect(statuses[0]).toEqual({ shellSessions: 0, pendingTasks: 0, attachedTerminals: 0, scriptProbes: 0 });
  });

  it('runsScriptProbeAndReportsBusyWhileItRuns', async () => {
    const base = useTmpDir('mao-agent-probe-');
    const scriptDir = join(base, 'workspace', '7', 'projects');
    mkdirSync(scriptDir, { recursive: true });
    const scriptPath = join(scriptDir, 'check.sh');
    writeFileSync(scriptPath, 'printf "ok:%s" "$MAO_WATCHER_ID"\n');
    process.env.MAO_CONTAINER_USER_ID = '7';
    const statuses: RuntimeStatus[] = [];
    const conn = await startAgent(base, statuses);
    const response = await conn.request({
      v: 1, type: 'script_probe', id: 'probe-1',
      scriptPath,
      timeoutSeconds: 10,
      env: { MAO_WATCHER_ID: '42', MAO_WATCHER_NAME: '磁盘' },
      deps: null,
    }, 10_000);
    expect(response.type).toBe('script_probe_result');
    if (response.type !== 'script_probe_result') return;
    expect(response.failureClass).toBe('script');
    expect(response.ok).toBe(true);
    expect(response.exitCode).toBe(0);
    expect(Buffer.from(response.stdoutBase64 ?? '', 'base64').toString('utf8')).toBe('ok:42');
    expect(statuses.some((status) => (status.scriptProbes ?? 0) >= 1)).toBe(true);
    expect(statuses[statuses.length - 1]?.scriptProbes).toBe(0);
  });

  it('reportsRuntimeBuildIdInHello', async () => {
    // V178 回归：容器内代码版本上报——agent 读 manifest（此处注入），hello 携带 build，
    // 宿主机 onAgentHello 收到原值（ContainerRegistry 据此做漂移判定）
    const base = useTmpDir('mao-agent-build-');
    mkdirSync(join(base, 'workspace', '7'), { recursive: true });
    const statuses: RuntimeStatus[] = [];
    const hellos: Array<{ build: string | null }> = [];
    await startAgent(base, statuses, undefined, 'build-abc123', hellos);
    expect(hellos[0]).toEqual({ build: 'build-abc123' });
  });

  it('reportsNullBuildWhenAgentHasNoManifest', async () => {
    // 旧 agent / manifest 缺失：hello 不带 build → 宿主收到 null（unknown 按漂移处理，one-shot 自愈）
    const base = useTmpDir('mao-agent-build-none-');
    mkdirSync(join(base, 'workspace', '7'), { recursive: true });
    const statuses: RuntimeStatus[] = [];
    const hellos: Array<{ build: string | null }> = [];
    await startAgent(base, statuses, undefined, null, hellos);
    expect(hellos[0]).toEqual({ build: null });
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

  it('defaultsShareDirWhenEnvUnset', () => {
    // 共享目录方案 §4.3：MAO_SHARE_DIR 未设置时 resolveRoots 回落默认值
    // /opt/mao-data/share，并经 ContainerToolExecutor 登记为沙箱允许根。
    // 用 addAllowedRoot 探针断言接线（不触碰真实文件系统）
    const base = useTmpDir('mao-agent-share-default-');
    // 其余 root env 指向临时目录：PathSandbox 构造器会 mkdirSync workspaceRoot，
    // 不重定向的话在 /opt 可写的机器（root 身份 CI）上会留下真实 /opt/mao-data
    // 目录（round-02 review 观察 1）
    process.env.MAO_WORKSPACE_ROOT = join(base, 'workspace');
    process.env.MAO_RUNTIME_DIR = join(base, 'runtime');
    process.env.MAO_USER_HOME_DIR = join(base, 'users');
    process.env.MAO_USER_SKILLS_DIR = join(base, 'userskills');
    delete process.env.MAO_SHARE_DIR;
    const registered: string[] = [];
    const spy = vi.spyOn(PathSandbox.prototype, 'addAllowedRoot')
      .mockImplementation((root: string) => { registered.push(root); });
    const agent = new RuntimeAgent('/tmp/mao-probe.sock', 'probe-token', 7, 5);
    try {
      // 2026-11-09 形态 C：share 按 Agent 收窄——登记本 Agent 两条子路径，不再登记 share 根
      // 默认根常量为 POSIX（容器内恒 Linux）：宿主测试机上 join 镜像其派生形态
      expect(registered).toContain(join('/opt/mao-data/share', 'agent-experience', '5'));
      expect(registered).toContain(join('/opt/mao-data/share', 'agents', '5'));
      expect(registered).not.toContain(resolve('/opt/mao-data/share'));
    } finally {
      agent.dispose();
      spy.mockRestore();
    }
  });

  it('defaultsSkillViewsDirWhenEnvUnset', () => {
    // 技术方案 2026-11-03 §4.5：会话技能以符号链接指向用户级技能视图
    // （{runtimeDir}/{u}/{s}/skills/{name} -> {skillViewsDir}/{u}/{name}），容器内文件工具
    // 必须把 {skillViewsDir}/{u} 登记为允许根，否则 strict 的符号链接逃逸检测会把读
    // SKILL.md 判成越界。此处用 addAllowedRoot 探针断言接线（不触碰真实文件系统）
    const base = useTmpDir('mao-agent-skills-default-');
    process.env.MAO_WORKSPACE_ROOT = join(base, 'workspace');
    process.env.MAO_RUNTIME_DIR = join(base, 'runtime');
    process.env.MAO_USER_HOME_DIR = join(base, 'users');
    process.env.MAO_USER_SKILLS_DIR = join(base, 'userskills');
    delete process.env.MAO_SKILL_VIEWS_DIR;
    const registered: string[] = [];
    const spy = vi.spyOn(PathSandbox.prototype, 'addAllowedRoot')
      .mockImplementation((root: string) => { registered.push(root); });
    const agent = new RuntimeAgent('/tmp/mao-probe-skills.sock', 'probe-token', 7, 5);
    try {
      // 2026-11-07：MAO_SKILL_VIEWS_DIR 注入值即当前 (user, agent) 视图目录，允许根 = 该值本身
      expect(registered).toContain('/opt/mao-data/skill-views');
      expect(registered).not.toContain('/opt/mao-data/skill-views/7');
    } finally {
      agent.dispose();
      spy.mockRestore();
    }
  });
});

describe('alignPasswdHome（容器 HOME 对齐）', () => {
  it('alignsRootHomeAndIsIdempotent', () => {
    const base = useTmpDir('mao-passwd-');
    const file = join(base, 'passwd');
    writeFileSync(
      file,
      'root:x:0:0:root:/root:/bin/bash\n'
      + 'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\n',
    );
    expect(alignPasswdHome(file, '/opt/mao-data/users/7')).toBe(true);
    const updated = readFileSync(file, 'utf8');
    expect(updated).toContain('root:x:0:0:root:/opt/mao-data/users/7:/bin/bash');
    // 非 root 行不受影响
    expect(updated).toContain('daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin');
    // 幂等：已对齐时不再改动
    expect(alignPasswdHome(file, '/opt/mao-data/users/7')).toBe(false);
  });

  it('keepsMalformedLinesAndReturnsFalseWithoutRoot', () => {
    const base = useTmpDir('mao-passwd-edge-');
    const file = join(base, 'passwd');
    // 无 root 行 + 畸形行（字段数 < 7）+ 空行：内容原样保留、返回 false
    const original = 'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nbroken\n\n';
    writeFileSync(file, original);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(alignPasswdHome(file, '/opt/mao-data/users/7')).toBe(false);
      expect(readFileSync(file, 'utf8')).toBe(original);
    } finally {
      warn.mockRestore();
    }
  });

  it('preservesMissingTrailingNewline', () => {
    const base = useTmpDir('mao-passwd-nonl-');
    const file = join(base, 'passwd');
    writeFileSync(file, 'root:x:0:0:root:/root:/bin/bash');
    expect(alignPasswdHome(file, '/opt/mao-data/users/7')).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('root:x:0:0:root:/opt/mao-data/users/7:/bin/bash');
  });
});

describe('alignContainerTimeZone（容器时区对齐）', () => {
  it('relinksLocaltimeAndWritesTimezoneIdempotently', () => {
    const base = useTmpDir('mao-tz-');
    const zoneinfoDir = join(base, 'zoneinfo');
    const zoneinfoPath = join(zoneinfoDir, 'Asia', 'Shanghai');
    mkdirSync(join(zoneinfoDir, 'Asia'), { recursive: true });
    writeFileSync(zoneinfoPath, 'TZif-fake');
    const localtimePath = join(base, 'localtime');
    const timezonePath = join(base, 'timezone');
    writeFileSync(timezonePath, 'Etc/UTC\n');
    const options = { localtimePath, timezonePath, zoneinfoDir };

    expect(alignContainerTimeZone(options)).toBe(true);
    expect(readlinkSync(localtimePath)).toBe(zoneinfoPath);
    expect(readFileSync(timezonePath, 'utf8')).toBe('Asia/Shanghai\n');
    // 幂等：已对齐时不重复改写
    expect(alignContainerTimeZone(options)).toBe(false);
  });

  it('replacesPlainFileLocaltimeWithSymlink', () => {
    const base = useTmpDir('mao-tz-file-');
    const zoneinfoDir = join(base, 'zoneinfo');
    const zoneinfoPath = join(zoneinfoDir, 'Asia', 'Shanghai');
    mkdirSync(join(zoneinfoDir, 'Asia'), { recursive: true });
    writeFileSync(zoneinfoPath, 'TZif-fake');
    // 镜像 / 人工放置的普通文件 localtime：需替换为指向 zoneinfo 的符号链接
    const localtimePath = join(base, 'localtime');
    writeFileSync(localtimePath, 'Etc/UTC');
    const timezonePath = join(base, 'timezone');

    expect(alignContainerTimeZone({ localtimePath, timezonePath, zoneinfoDir })).toBe(true);
    expect(lstatSync(localtimePath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(localtimePath)).toBe(zoneinfoPath);
    // /etc/timezone 缺失时按需创建
    expect(readFileSync(timezonePath, 'utf8')).toBe('Asia/Shanghai\n');
  });

  it('skipsWhenZoneinfoMissing', () => {
    const base = useTmpDir('mao-tz-missing-');
    const localtimePath = join(base, 'localtime');
    const timezonePath = join(base, 'timezone');
    writeFileSync(timezonePath, 'Etc/UTC\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(alignContainerTimeZone({ localtimePath, timezonePath, zoneinfoDir: join(base, 'zoneinfo') })).toBe(false);
      // 任何文件都不被改动
      expect(existsSync(localtimePath)).toBe(false);
      expect(readFileSync(timezonePath, 'utf8')).toBe('Etc/UTC\n');
    } finally {
      warn.mockRestore();
    }
  });
});
