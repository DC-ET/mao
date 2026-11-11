import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { ContainerRegistry, type DockerCli } from './container-registry.js';
import { containerHostsFingerprint } from '../../common/container-hosts.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function fakeDocker(log: string[]): DockerCli {
  return {
    async run(args) {
      log.push(args.join(' '));
      if (args[0] === 'images') return 'mao-runtime:latest\n';
      if (args[0] === 'version') return '27.0.0\n';
      return 'ok\n';
    },
  };
}

function makeRegistry(
  base: string,
  log: string[],
  overrides: Partial<ConstructorParameters<typeof ContainerRegistry>[0]> = {},
  docker: DockerCli = fakeDocker(log),
) {
  const waits: number[] = [];
  const listenings: number[] = [];
  const tokens: number[] = [];
  const registry = new ContainerRegistry({
    config: {
      mode: 'docker',
      container: {
        idleMinutes: 60, maxLifetimeHours: 72, memoryMb: 512, cpus: 1, pidsLimit: 100,
        image: 'mao-runtime:latest', network: 'bridge',
        channelDir: join(base, 'channels'), distDir: join(base, 'dist'),
        depsDir: join(base, 'deps'), tmpDir: join(base, 'tmp'), tmpRetentionDays: 7, startTimeoutMs: 1000,
      },
    },
    workspaceRoot: join(base, 'workspace'),
    userHomeDir: join(base, 'users'),
    runtimeDir: join(base, 'runtime'),
    userSkillsDir: join(base, 'userskills'),
    skillsDir: join(base, 'skills'),
    skillViewsDir: join(base, 'skill-views'),
    uploadDir: join(base, 'uploads'),
    shareDir: join(base, 'share'),
    // 宿主机先 listen 再 docker run（BUG-2 回归）：listen/token 回调先于 run 发生
    ensureChannelListening: async (userId, _agentId) => {
      listenings.push(userId);
      log.push(`listen ${userId}`);
      return join(base, 'channels', String(userId), 'runtime.sock');
    },
    issueChannelToken: (userId, _agentId) => { tokens.push(userId); log.push(`token ${userId}`); return 'tok-' + userId; },
    waitSocketReady: async (userId, _agentId) => { waits.push(userId); },
    requestShutdown: async () => true,
    ...overrides,
  }, docker);
  return { registry, waits, listenings, tokens };
}

/** 只取 docker 生命周期动作（run -d / rm -f / stop），忽略 listen/token 等宿主机回调。 */
function dockerOps(log: string[]): string[] {
  return log
    .filter((l) => /^(run -d|rm -f|stop -t 10)/.test(l))
    .map((l) => l.split(' ').slice(0, 2).join(' '));
}

/** 写入 dist 的 runtime-build.json（ContainerRegistry 构造时读取；= 本实例加载的代码版本）。 */
function writeRuntimeBuild(base: string, buildId: string): void {
  const dir = join(base, 'dist', 'harness', 'container');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runtime-build.json'), JSON.stringify({ schema: 1, buildId, fileCount: 1 }));
}

/** 建好标准目录的临时 base（多数用例的固定开场）。 */
function makeBase(prefix: string): string {
  const base = useTmpDir(prefix);
  for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
    mkdirSync(join(base, d), { recursive: true });
  }
  return base;
}

describe('container registry', () => {
  it('createsContainerWithResourceLimitsAndMounts', async () => {
    const base = useTmpDir('mao-registry-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry, waits, listenings, tokens } = makeRegistry(base, log);
    const entry = await registry.ensureRunning(7, 5);
    expect(entry.state).toBe('running');
    expect(entry.containerName).toBe('mao-user-7-agent-5');
    expect(waits).toEqual([7]);
    // 宿主机 socket 先 listen、token 先落盘，然后才 docker run（BUG-2/BUG-3 回归）
    expect(listenings).toEqual([7]);
    expect(tokens).toEqual([7]);
    const listenIdx = log.indexOf('listen 7');
    const tokenIdx = log.indexOf('token 7');
    const runIdx = log.findIndex((line) => line.startsWith('run -d'));
    expect(listenIdx).toBeGreaterThanOrEqual(0);
    expect(tokenIdx).toBeGreaterThanOrEqual(0);
    expect(listenIdx).toBeLessThan(runIdx);
    expect(tokenIdx).toBeLessThan(runIdx);
    const runArgs = log.find((line) => line.startsWith('run -d'));
    expect(runArgs).toBeDefined();
    expect(runArgs).toContain('--memory 512m');
    expect(runArgs).toContain('--cpus 1');
    expect(runArgs).toContain('--pids-limit 100');
    // locale 统一 C.UTF-8：容器 shell 的多字节字符语义与宿主机 UTF-8 对齐
    expect(runArgs).toContain('-e LANG=C.UTF-8');
    // 容器 agent 硬依赖 env：userId / token / 四个 roots（BUG-3 回归）
    expect(runArgs).toContain('-e MAO_CONTAINER_USER_ID=7');
    expect(runArgs).toContain('-e MAO_CHANNEL_TOKEN=tok-7');
    expect(runArgs).toContain(`-e MAO_WORKSPACE_ROOT=${join(base, 'workspace')}`);
    expect(runArgs).toContain(`-e MAO_RUNTIME_DIR=${join(base, 'runtime')}`);
    expect(runArgs).toContain(`-e MAO_USER_HOME_DIR=${join(base, 'users')}`);
    expect(runArgs).toContain(`-e MAO_DEPS_DIR=${join(base, 'deps')}`);
    // HOME 对齐用户数据目录：容器内 HOME 与宿主机模式一致，用户级 .npmrc/.m2/.gitconfig 生效
    expect(runArgs).toContain(`-e HOME=${join(base, 'users', '7')}`);
    expect(runArgs).toContain(`-e MAO_USER_SKILLS_DIR=${join(base, 'userskills')}`);
    // 技能视图根：会话技能符号链接的目标根；容器内按用户 ro 挂载（技术方案 2026-11-03）
    expect(runArgs).toContain(`-e MAO_SKILL_VIEWS_DIR=${join(base, 'skill-views', '7', '5')}`);
    expect(runArgs).toContain(`${join(base, 'skill-views', '7', '5')}:${join(base, 'skill-views', '7', '5')}:ro`);
    // 旧平台技能根（全局 rw）不再注入、不再挂载（G1/G2：技能源对容器不可见）
    expect(runArgs).not.toContain('MAO_SKILLS_DIR');
    expect(runArgs).not.toContain(`${join(base, 'skills')}:`);
    // 图片产物上传根（按用户挂 {uploadDir}/{userId}，nginx /uploads/ 静态出口同源）
    expect(runArgs).toContain(`-e MAO_UPLOAD_DIR=${join(base, 'uploads')}`);
    expect(runArgs).toContain(`${join(base, 'uploads', '7')}:${join(base, 'uploads', '7')}:rw`);
    // share 按 Agent 隔离（2026-11-09 形态 C）：env 仍注入 share 根（沙箱/经验索引推导），
    // 挂载改为两条子路径（本 Agent 经验库 + 私有区），整根不再进容器
    expect(runArgs).toContain(`-e MAO_SHARE_DIR=${join(base, 'share')}`);
    expect(runArgs).toContain(`${join(base, 'share', 'agent-experience', '5')}:${join(base, 'share', 'agent-experience', '5')}:rw`);
    expect(runArgs).toContain(`${join(base, 'share', 'agents', '5')}:${join(base, 'share', 'agents', '5')}:rw`);
    expect(runArgs).not.toContain(`${join(base, 'share')}:${join(base, 'share')}:rw`);
    // socket 路径由 ensureChannelListening 返回（唯一真相）
    expect(runArgs).toContain(`--socket ${join(base, 'channels', '7', 'runtime.sock')}`);
    // 不暴露端口
    expect(runArgs).not.toContain('-p ');
    expect(runArgs).not.toContain('--publish');
    // 只挂本用户目录（挂载串两侧均为平台本地路径：分隔符归一后断言容器挂载点，Linux 恒等）
    const normalizedArgs = runArgs!.split(sep).join('/');
    expect(normalizedArgs).toContain('/users/7:');
    expect(normalizedArgs).not.toContain('/users/8:');
    // dist 只读
    expect(runArgs).toContain(':ro');
    // 并发复用：running 状态直接复用，不再创建第二个容器
    const again = await registry.ensureRunning(7, 5);
    expect(again.containerName).toBe(entry.containerName);
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(1);
  });

  it('resolvesRelativeSkillViewsDirInContainerEnv', async () => {
    // round-1 review I-1 回归：skillViewsDir 为相对值时，容器 env 必须注入 resolve 后的绝对路径，
    // 与 planner 的宿主挂载路径同一解析基准——否则容器内（cwd=/）按容器 cwd 解析出的沙箱允许根
    // 与真实挂载点错位，读任何技能文件被判「符号链接逃逸」。
    const base = makeBase('mao-registry-views-rel-');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log, { skillViewsDir: './skill-views' });
    await registry.ensureRunning(7, 5);
    const runArgs = log.find((line) => line.startsWith('run -d'))!;
    const absolute = resolve('./skill-views');
    expect(runArgs).toContain(`-e MAO_SKILL_VIEWS_DIR=${join(absolute, '7', '5')}`);
    // env 与挂载源逐字节一致
    expect(runArgs).toContain(`${join(absolute, '7', '5')}:${join(absolute, '7', '5')}:ro`);
  });

  it('appliesSkillViewsEnvOnFirstRebuildOfLegacyEntry', async () => {
    // 评审修订 §4.4/§7.1：env 不在挂载指纹内，升级后的存量容器靠「挂载指纹变化」重建一次，
    // 新 env（MAO_SKILL_VIEWS_DIR）随之生效；旧 env（MAO_SKILLS_DIR）不再出现
    const base = makeBase('mao-registry-legacy-env-');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    // 模拟旧版本固化的条目（无挂载指纹）：首次复用按漂移处理，自愈重建一次
    delete registry.getEntry(7, 5)!.mountFingerprint;
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);
    const runArgs = log.find((line) => line.startsWith('run -d'))!;
    expect(runArgs).toContain(`-e MAO_SKILL_VIEWS_DIR=${join(base, 'skill-views', '7', '5')}`);
    expect(runArgs).not.toContain('MAO_SKILLS_DIR');
    // 一次性行为：指纹一致后零 docker 动作
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
  });

  it('doesNotPoisonEntryWhenSocketNeverReady', async () => {
    // BUG-4 回归：等待 socket 超时后不得残留 running 条目，第二次 ensureRunning 必须重新创建
    const base = useTmpDir('mao-registry-timeout-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    let ready = false;
    const { registry, waits } = makeRegistry(base, log, {
      waitSocketReady: async (userId, _agentId) => {
        waits.push(userId);
        if (!ready) throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
      },
    });
    await expect(registry.ensureRunning(7, 5)).rejects.toThrow(/容器运行时通道连接超时/);
    expect(registry.getEntry(7, 5)).toBeUndefined();
    // 半成品容器被清理
    expect(log.some((line) => line.startsWith('rm -f mao-user-7'))).toBe(true);
    // 第二次：socket 已能就绪 → 重新 docker run 并成功
    ready = true;
    const entry = await registry.ensureRunning(7, 5);
    expect(entry.state).toBe('running');
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(2);
    expect(waits).toEqual([7, 7]);
  });

  it('reusesStoppedContainerViaStart', async () => {
    const base = useTmpDir('mao-registry-2-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    const first = await registry.ensureRunning(7, 5);
    // 模拟外部停止
    (registry.getEntry(7, 5) as { state: string }).state = 'stopped';
    const second = await registry.ensureRunning(7, 5);
    expect(second.containerName).toBe(first.containerName);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(true);
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(1);
  });

  it('rebuildsStoppedContainerWhenMountPlanDrifts', async () => {
    // 挂载漂移自愈（图片产物按用户隔离方案⑦）：planner 变更前创建的旧条目指纹过期，
    // stopped 分支必须先重建再起——docker start 复用创建时的清单，补不上 uploads 挂载
    const base = useTmpDir('mao-registry-drift-stopped-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    const entry = registry.getEntry(7, 5)!;
    expect(entry.mountFingerprint).toMatch(/^[0-9a-f]{16}$/);
    entry.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped
    // 模拟 planner 升级前固化的旧条目（指纹与当前计划不符）
    entry.mountFingerprint = 'stale-fingerprint';
    log.length = 0;
    const again = await registry.ensureRunning(7, 5);
    expect(again.state).toBe('running');
    expect(again.mountFingerprint).not.toBe('stale-fingerprint');
    // rm -f → run -d：没有多余的 docker start（不会先 start 再立刻重建）
    expect(dockerOps(log)).toEqual(['rm -f', 'run -d']);
    const runArgs = log.find((l) => l.startsWith('run -d'))!;
    expect(runArgs).toContain(`${join(base, 'uploads', '7')}:${join(base, 'uploads', '7')}:rw`);
    // 指纹恢复一致后不再重建
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
  });

  it('recyclesRunningContainerWhenMountPlanDrifts', async () => {
    // 运行中条目同样只认指纹：漂移即回收重建一次，之后稳定复用
    const base = useTmpDir('mao-registry-drift-running-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    registry.getEntry(7, 5)!.mountFingerprint = 'stale-fingerprint';
    log.length = 0;
    const entry = await registry.ensureRunning(7, 5);
    expect(entry.state).toBe('running');
    expect(entry.mountFingerprint).not.toBe('stale-fingerprint');
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);
    // 一次性行为：指纹一致后零 docker 动作
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
  });

  it('rebuildsWhenConnectionDead', async () => {
    const base = useTmpDir('mao-registry-3-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    registry.markConnectionDead(7, 5);
    await registry.ensureRunning(7, 5);
    expect(log.some((line) => line.startsWith('stop -t 10 mao-user-7'))).toBe(true);
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(2);
  });

  it('skipsIdleReapWhileContainerBusy', async () => {
    const base = useTmpDir('mao-registry-4-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    const entry = await registry.ensureRunning(7, 5);
    entry.lastUsedAtMs = Date.now() - 100 * 60_000; // 远超 idle
    // 容器内有活跃 shell：§5.3.1 idle 不推进，不 stop
    registry.reportRuntimeStatus(7, 5, { shellSessions: 2, pendingTasks: 0, attachedTerminals: 0 });
    await registry.reapExpired();
    expect(log.some((line) => line.startsWith('stop -t 10 mao-user-7'))).toBe(false);
    // 容器内状态归零后 idle 推进 → stop（不 rm）
    registry.reportRuntimeStatus(7, 5, { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0, scriptProbes: 1 });
    await registry.reapExpired();
    expect(log.some((line) => line.startsWith('stop -t 10 mao-user-7'))).toBe(false);
    registry.reportRuntimeStatus(7, 5, { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 });
    await registry.reapExpired();
    expect(log.some((line) => line.startsWith('stop -t 10 mao-user-7'))).toBe(true);
    expect(log.some((line) => line.startsWith('rm '))).toBe(false);
    expect(registry.getEntry(7, 5)?.state).toBe('stopped');
    // idle 回收后 ensureRunning 走 start 复用
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(true);
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(0);
  });

  it('doesNotPoisonEntryWhenRestartSocketNeverReady', async () => {
    // N-3 回归：dockerStart（重启路径）等待 socket 超时后同样不得残留毒化 running 条目
    const base = useTmpDir('mao-registry-restart-timeout-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    let ready = true;
    const { registry, waits } = makeRegistry(base, log, {
      waitSocketReady: async (userId, _agentId) => {
        waits.push(userId);
        if (!ready) throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
      },
    });
    await registry.ensureRunning(7, 5);
    // idle 回收 → stopped，下次 ensureRunning 走 dockerStart 重启路径
    registry.getEntry(7, 5)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired();
    expect(registry.getEntry(7, 5)?.state).toBe('stopped');

    ready = false; // 重启：start 成功但容器内 agent 永不连接
    log.length = 0;
    await expect(registry.ensureRunning(7, 5)).rejects.toThrow(/容器运行时通道连接超时/);
    // 毒化条目被清理（旧行为：残留 state=running，后续 ensureRunning 直接复用、永不重试）
    expect(registry.getEntry(7, 5)).toBeUndefined();
    expect(log.some((line) => line.startsWith('rm -f mao-user-7'))).toBe(true);
    // 根因恢复后：完整 docker run 重建（自愈），不再无限复用死条目
    ready = true;
    log.length = 0;
    const entry = await registry.ensureRunning(7, 5);
    expect(entry.state).toBe('running');
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(1);
    expect(waits).toEqual([7, 7, 7]);
  });

  it('mountsChannelSessionWorkspacesReturnedBySessionLookup', async () => {
    // N-2 回归：飞书/钉钉通道会话工作区越出每用户根，创建时随挂载清单进入容器
    const base = useTmpDir('mao-registry-channel-mount-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const feishuWs = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    const dingtalkWs = join(base, 'workspace', 'dingtalk-chat', 'bot-1', 'p2p-7');
    mkdirSync(feishuWs, { recursive: true });
    mkdirSync(dingtalkWs, { recursive: true });
    const log: string[] = [];
    const seenByLookup: number[] = [];
    const { registry } = makeRegistry(base, log, {
      sessionWorkspacesOf: async (userId, _agentId) => {
        seenByLookup.push(userId);
        return [feishuWs, dingtalkWs, join(base, 'workspace', '7', 'web-session')];
      },
    });
    await registry.ensureRunning(7, 5);
    const runArgs = log.find((line) => line.startsWith('run -d'))!;
    expect(runArgs).toContain(`${feishuWs}:${feishuWs}:rw`);
    expect(runArgs).toContain(`${dingtalkWs}:${dingtalkWs}:rw`);
    // web 会话工作区在每用户根内，不重复附加挂载
    expect(runArgs).not.toContain(`${join(base, 'workspace', '7', 'web-session')}:`);
    expect(seenByLookup).toEqual([7]);
    // 条目记录挂载集合，供后续 isMounted 判定
    const entry = registry.getEntry(7, 5)!;
    expect([...entry.mountedPaths]).toContain(feishuWs);
    expect([...entry.sessionWorkspaces]).toEqual([feishuWs, dingtalkWs]);
  });

  it('recyclesRunningContainerToMountNewChannelWorkspace', async () => {
    // N-2 回归：运行中容器的挂载清单已定型，新通道会话工作区只能重建容器后可见
    const base = useTmpDir('mao-registry-recycle-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const groupWs = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    mkdirSync(groupWs, { recursive: true });
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    // 首个会话（web，每用户根内）建容器：不带通道工作区
    await registry.ensureRunning(7, 5, join(base, 'workspace', '7', 'web-session'));
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(1);
    expect(registry.getEntry(7, 5)!.mountedPaths.has(groupWs)).toBe(false);

    // 新通道会话的首个工具调用：工作区未挂载 → 重建（rm + run），新容器带该挂载
    const entry = await registry.ensureRunning(7, 5, groupWs);
    expect(entry.state).toBe('running');
    expect(entry.mountedPaths.has(groupWs)).toBe(true);
    const runs = log.filter((line) => line.startsWith('run -d'));
    expect(runs.length).toBe(2);
    expect(runs[1]).toContain(`${groupWs}:${groupWs}:rw`);
    // 重建后同工作区复用，不再反复重建
    log.length = 0;
    await registry.ensureRunning(7, 5, groupWs);
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(0);
  });

  it('doesNotRecycleForWorkspaceUnderUserRoot', async () => {
    // N-2 对照：每用户根之下的会话工作区（web）命中已挂载集合，不触发重建
    const base = useTmpDir('mao-registry-no-recycle-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5, join(base, 'workspace', '7', 'projects', 'demo'));
    log.length = 0;
    await registry.ensureRunning(7, 5, join(base, 'workspace', '7', 'other-session'));
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(0);
  });

  it('failsClearlyWhenSessionWorkspaceNotMountable', async () => {
    // N-2 兜底：既非每用户根也非通道工作区的会话工作区，明确报错（绝不让"容器内
    // 目录不存在"退化成空输出/会话秒退的静默失败），且不反复重建容器
    const base = useTmpDir('mao-registry-unmountable-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    const bogus = join(base, 'elsewhere', 'x');
    await expect(registry.ensureRunning(7, 5, bogus)).rejects.toThrow(/不在容器可挂载范围内/);
    // 容器本体健康（该用户其他会话可用），但该会话工作区永远不可见
    expect(registry.getEntry(7, 5)?.state).toBe('running');
    // 再次调用同样明确失败，不产生额外 docker 动作
    log.length = 0;
    await expect(registry.ensureRunning(7, 5, bogus)).rejects.toThrow(/不在容器可挂载范围内/);
    expect(log.filter((line) => /^(run -d|rm -f|stop)/.test(line)).length).toBe(0);
  });

  it('doesNotStopReplacementContainerWhenStaleEntryIsReaped', async () => {
    // 竞态防护：idle 回收的 shutdown 通知期间条目被 recycle 替换成新容器时，
    // 旧条目随后的 docker stop 不得按同容器名误伤新容器
    const base = useTmpDir('mao-registry-stale-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const feishuWs = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat');
    mkdirSync(feishuWs, { recursive: true });
    const log: string[] = [];
    let registry: ContainerRegistry | null = null;
    let noticed = false;
    registry = new ContainerRegistry({
      config: {
        mode: 'docker',
        container: {
          idleMinutes: 60, maxLifetimeHours: 72, memoryMb: 512, cpus: 1, pidsLimit: 100,
          image: 'mao-runtime:latest', network: 'bridge',
          channelDir: join(base, 'channels'), distDir: join(base, 'dist'),
          depsDir: join(base, 'deps'), tmpDir: join(base, 'tmp'), tmpRetentionDays: 7, startTimeoutMs: 1000,
        },
      },
      workspaceRoot: join(base, 'workspace'),
      userHomeDir: join(base, 'users'),
      runtimeDir: join(base, 'runtime'),
      userSkillsDir: join(base, 'userskills'),
      skillsDir: join(base, 'skills'),
      skillViewsDir: join(base, 'skill-views'),
      uploadDir: join(base, 'uploads'),
      shareDir: join(base, 'share'),
      ensureChannelListening: async () => join(base, 'channels', '7', 'runtime.sock'),
      issueChannelToken: () => 'tok-7',
      waitSocketReady: async () => undefined,
      // 回收通知执行期间，并发发生 recycle（用户新建了飞书群会话）
      requestShutdown: async () => {
        if (!noticed) {
          noticed = true;
          await registry!.ensureRunning(7, 5, feishuWs);
        }
        return true;
      },
    }, fakeDocker(log));

    await registry.ensureRunning(7, 5);
    registry.getEntry(7, 5)!.lastUsedAtMs = Date.now() - 100 * 60_000; // 远超 idle
    await registry.reapExpired();
    // 新容器就绪且未被误伤：最后一次 run -d（重建）之后不得再出现 stop
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastStop = log.map((l) => l.startsWith('stop -t 10')).lastIndexOf(true);
    expect(lastRun).toBeGreaterThanOrEqual(0);
    expect(lastStop).toBeLessThan(lastRun);
    expect(registry.getEntry(7, 5)?.state).toBe('running');
    expect(registry.getEntry(7, 5)?.mountedPaths.has(feishuWs)).toBe(true);
  });

  it('serializesConcurrentRecyclesAfterIdleReap', async () => {
    // N-4a 回归：idle 回收后两个通道工作区并发 ensureRunning。按用户串行化后不会
    // 双重 stop/rm -f，也不会因同名冲突被静默合并出"挂载集合与真实容器不符"的条目；
    // 最终在册条目同时覆盖两个工作区，后续调用不再重建
    const base = useTmpDir('mao-registry-race-a-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
    const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    const log: string[] = [];
    // sessionWorkspacesOf 返回 []：DB 查询失败的降级形态，两个调用方都判"需要重建"
    const { registry } = makeRegistry(base, log, { sessionWorkspacesOf: async () => [] });

    await registry.ensureRunning(7, 5);
    registry.getEntry(7, 5)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped

    log.length = 0;
    const [a, b] = await Promise.all([registry.ensureRunning(7, 5, wsA), registry.ensureRunning(7, 5, wsB)]);
    // recycle 原地更新条目：两个调用方拿到的是同一条目（句柄不错位）
    expect(a).toBe(b);
    expect(registry.getEntry(7, 5)).toBe(a);
    // 在册条目的挂载集合与真实容器一致
    expect(registry.getEntry(7, 5)!.mountedPaths.has(wsA)).toBe(true);
    expect(registry.getEntry(7, 5)!.mountedPaths.has(wsB)).toBe(true);
    // 串行化：每次 run -d 之前都有对应的 rm -f，没有"同名冲突被吞掉"的第二次 run -d，
    // 也没有对同一容器的双重 stop
    expect(dockerOps(log)).toEqual(['rm -f', 'run -d', 'stop -t', 'rm -f', 'run -d']);
    // 两个工作区都已在册：后续调用不触发任何重建
    log.length = 0;
    await registry.ensureRunning(7, 5, wsA);
    await registry.ensureRunning(7, 5, wsB);
    expect(dockerOps(log)).toEqual([]);
  });

  it('serializesConcurrentCreateForDifferentChannelWorkspaces', async () => {
    // N-4b 回归：容器不存在时两个通道工作区并发首调。串行化后后到者只做一次
    // "保留既有挂载、增量并入新工作区"的 recycle，两个调用方拿到同一条目；
    // 旧行为下先到者会拿到已被 stop + rm -f 的陈旧条目（startedAtMs/mountedPaths 错位）
    const base = useTmpDir('mao-registry-race-b-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
    const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);

    log.length = 0;
    const [a, b] = await Promise.all([registry.ensureRunning(7, 5, wsA), registry.ensureRunning(7, 5, wsB)]);
    expect(a).toBe(b);
    expect(registry.getEntry(7, 5)).toBe(a);
    expect(a.mountedPaths.has(wsA)).toBe(true);
    expect(a.mountedPaths.has(wsB)).toBe(true);
    expect(dockerOps(log)).toEqual(['run -d', 'stop -t', 'rm -f', 'run -d']);
  });

  it('keepsRecycledContainerWhenConcurrentRestartTimesOut', async () => {
    // N-4c 回归：dockerStart 等待 socket 期间并发 recycle 已建好新容器，旧路径超时
    // 失败时的清理不得删掉在册新条目、也不得按同容器名 rm -f 掉新容器
    const base = useTmpDir('mao-registry-dstart-race-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
    mkdirSync(wsB, { recursive: true });
    const log: string[] = [];
    let registry: ContainerRegistry | null = null;
    // 0=初始创建放行；1=重启等待（期间并发 recycle，随后超时）；2=recycle 新建正常就绪
    let phase = 0;
    const { registry: reg } = makeRegistry(base, log, {
      waitSocketReady: async () => {
        if (phase === 0) return;
        if (phase === 1) {
          phase = 2;
          await registry!.ensureRunning(7, 5, wsB);
          throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
        }
      },
      sessionWorkspacesOf: async () => [],
    });
    registry = reg;

    await registry.ensureRunning(7, 5);
    registry.getEntry(7, 5)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped
    phase = 1;

    log.length = 0;
    await expect(registry.ensureRunning(7, 5)).rejects.toThrow(/连接超时/);
    // 并发 recycle 建好的新容器与在册条目都存活，wsB 已挂载
    expect(registry.getEntry(7, 5)?.state).toBe('running');
    expect(registry.getEntry(7, 5)?.mountedPaths.has(wsB)).toBe(true);
    // 最后一次 rm -f 不得落在最后一次 run -d 之后（旧行为会把新容器 rm 掉）
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
    expect(lastRm).toBeLessThan(lastRun);
  });

  it('removesStoppedContainerBeforeRebuildAndRecoversFromNameConflict', async () => {
    // connectionDead 重建必须 rm 掉停止的旧容器再 docker run：容器名固定，不 rm 必然
    // 同名冲突。同名残留（上次进程退出未清理）时清掉后重试，而不是把冲突吞掉、按本次
    // 挂载清单登记一个与真实容器不符的条目
    const base = useTmpDir('mao-registry-conflict-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const inner = fakeDocker(log);
    let runAttempts = 0;
    const { registry } = makeRegistry(base, log, {}, {
      async run(args) {
        if (args[0] === 'run' && args[1] === '-d') {
          runAttempts += 1;
          // 第二次 docker run（connectionDead 重建的首次尝试）撞上同名残留容器
          if (runAttempts === 2) {
            throw new Error('docker run -d failed: Conflict. The container name "/mao-user-7" is already in use');
          }
        }
        return inner.run(args);
      },
    });

    await registry.ensureRunning(7, 5);
    registry.markConnectionDead(7, 5);
    log.length = 0;
    const entry = await registry.ensureRunning(7, 5);
    expect(entry.state).toBe('running');
    expect(registry.getEntry(7, 5)).toBe(entry);
    // stop → rm -f → run -d（撞同名残留，未落日志）→ rm -f → run -d（重试成功）
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'rm -f', 'run -d']);
  });

  it('dropsEntryWhenDockerStartFailsSoNextCallRebuilds', async () => {
    // F-2 回归：idle 回收产生的 exited 容器会被 scripts/container-gc.sh（status=exited）
    // 或 docker container prune 清掉，此后 docker start 报 No such container。条目必须
    // 摘除（与 createAndStart 失败同口径），否则卡在 stopped：该用户每次工具调用都同样
    // 失败、永不重建，只有重启后端才恢复
    const base = useTmpDir('mao-registry-dstart-missing-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const inner = fakeDocker(log);
    let startFails = false;
    const { registry } = makeRegistry(base, log, {}, {
      async run(args) {
        if (args[0] === 'start' && startFails) {
          throw new Error('docker start failed: Error response from daemon: No such container: mao-user-7');
        }
        return inner.run(args);
      },
    });

    await registry.ensureRunning(7, 5);
    registry.getEntry(7, 5)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped（容器 exited，仍被注册表跟踪）
    expect(registry.getEntry(7, 5)?.state).toBe('stopped');

    startFails = true; // 容器已被 GC 清掉
    log.length = 0;
    await expect(registry.ensureRunning(7, 5)).rejects.toThrow(/No such container/);
    expect(registry.getEntry(7, 5)).toBeUndefined();
    // 自愈：下次 ensureRunning 走完整 docker run 重建（新容器带新 agent）
    startFails = false;
    log.length = 0;
    const entry = await registry.ensureRunning(7, 5);
    expect(entry.state).toBe('running');
    expect(log.filter((l) => l.startsWith('run -d')).length).toBe(1);
  });

  it('keepsRecycledContainerWhenOuterCreateFailsAfterReentrantRebuild', async () => {
    // F-1 回归：createAndStart 的失败清理也必须按世代校验。原地更新条目后对象身份恒等，
    // 重入 recycle（withUserLock 的 ALS 重入）建成新容器后，外层失败不能删掉在册新条目、
    // 更不能按容器名 rm -f 把新容器删掉
    const base = useTmpDir('mao-registry-recycle-fail-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
    const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    const log: string[] = [];
    let registry: ContainerRegistry | null = null;
    // 0=初始创建放行；1=recycle 的 createAndStart 等待（期间重入 recycle，随后超时）；2=重入新建放行
    let phase = 0;
    const { registry: reg } = makeRegistry(base, log, {
      sessionWorkspacesOf: async () => [],
      waitSocketReady: async () => {
        if (phase === 0) return;
        if (phase === 1) {
          phase = 2;
          await registry!.ensureRunning(7, 5, wsB);
          throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
        }
      },
    });
    registry = reg;

    await registry.ensureRunning(7, 5);
    registry.getEntry(7, 5)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped
    phase = 1;

    log.length = 0;
    await expect(registry.ensureRunning(7, 5, wsA)).rejects.toThrow(/连接超时/);
    // 重入 recycle 建好的新容器与在册条目都存活，wsB 已挂载
    expect(registry.getEntry(7, 5)?.state).toBe('running');
    expect(registry.getEntry(7, 5)?.mountedPaths.has(wsB)).toBe(true);
    // 最后一次 rm -f 不得落在最后一次 run -d 之后
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
    expect(lastRm).toBeLessThan(lastRun);
  });

  it('keepsReentrantFirstCreateContainerWhenOuterFirstCreateTimesOut', async () => {
    // G-1 回归：首建交错。外层首建等待 socket 期间，重入方（waitSocketReady 回调内再调
    // ensureRunning，ALS 重入）另建并登记了新条目。外层条目从未登记、世代恒为捕获值，
    // 世代校验放行；此时若只按容器名 rm -f，会把重入方刚建好的容器删掉，在册条目被毒化
    // 成"自称 running、容器已不存在"（下次调用才经 markConnectionDead/挂载缺检自愈）
    const base = useTmpDir('mao-registry-firstcreate-race-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
    const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    const log: string[] = [];
    let registry: ContainerRegistry | null = null;
    let reentered = false;
    const { registry: reg } = makeRegistry(base, log, {
      sessionWorkspacesOf: async () => [],
      waitSocketReady: async () => {
        if (reentered) return;
        reentered = true;
        await registry!.ensureRunning(7, 5, wsB); // 首建期间的重入方：另建新条目并登记
        throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
      },
    });
    registry = reg;

    log.length = 0;
    await expect(registry.ensureRunning(7, 5, wsA)).rejects.toThrow(/连接超时/);
    // 重入方建好的新容器与在册条目都存活，wsB 已挂载
    expect(registry.getEntry(7, 5)?.state).toBe('running');
    expect(registry.getEntry(7, 5)?.mountedPaths.has(wsB)).toBe(true);
    // 最后一次 rm -f 不得落在最后一次 run -d 之后（旧行为 rm 掉重入方的新容器）
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
    expect(lastRm).toBeLessThan(lastRun);
  });

  it('precheckRunsDistLoadSmokeAgainstImage', async () => {
    // 切 docker 前的加载冒烟：镜像只带固定依赖集、dist 只挂代码，必须实际加载一次
    // runtime-agent 才能发现「镜像缺 dist 新依赖」
    const base = useTmpDir('mao-registry-precheck-');
    mkdirSync(join(base, 'channels'), { recursive: true });
    mkdirSync(join(base, 'dist'), { recursive: true });
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.precheck();
    const smoke = log.find((l) => l.startsWith('run --rm'));
    expect(smoke).toBeDefined();
    expect(smoke).toContain(`-v ${join(base, 'dist')}:${join(base, 'dist')}:ro`);
    // agent 入口串为 file:// + posix 拼接（host 段是平台路径）：归一后断言关键段
    expect(smoke!.split(sep).join('/')).toContain('/harness/container/runtime-agent.js');
  });

  it('precheckRejectsImageThatCannotLoadDistAgent', async () => {
    // 2026-10-30 事故回归：镜像缺 dist 新增依赖（yaml）时容器内 agent 启动即崩，
    // 只会表现为每用户 15s 连接超时。precheck 必须在切模式时就拒绝并给出重建镜像提示
    const base = useTmpDir('mao-registry-precheck-dep-');
    mkdirSync(join(base, 'channels'), { recursive: true });
    mkdirSync(join(base, 'dist'), { recursive: true });
    const log: string[] = [];
    const docker: DockerCli = {
      async run(args) {
        log.push(args.join(' '));
        if (args[0] === 'version') return '27.0.0\n';
        if (args[0] === 'images') return 'mao-runtime:latest\n';
        if (args[0] === 'run') throw new Error("Cannot find package 'yaml'");
        return 'ok\n';
      },
    };
    const { registry } = makeRegistry(base, log, {}, docker);
    const error = await registry.precheck().then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toContain('无法加载当前 dist 的 runtime-agent');
    expect(error?.message).toContain('build-runtime-image.sh');
  });

  it('injectsContainerHostsEntriesIntoDockerRun', async () => {
    // 容器域名解析注入（V176）：宿主机继承 + 后台自定义规则逐条转 --add-host
    const base = useTmpDir('mao-registry-hosts-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const entries = [
      { host: 'prometheus.acg.team', ip: '10.70.21.57', source: 'hosts-file' as const },
      { host: 'a.internal', ip: '10.0.0.9', source: 'custom' as const },
    ];
    const { registry } = makeRegistry(base, log, { resolveHostsInjection: async () => ({ entries, degraded: false }) });
    await registry.ensureRunning(7, 5);
    const runArgs = log.find((line) => line.startsWith('run -d'))!;
    expect(runArgs).toContain('--add-host prometheus.acg.team:10.70.21.57');
    expect(runArgs).toContain('--add-host a.internal:10.0.0.9');
    expect(registry.getEntry(7, 5)!.hostsFingerprint).toBe(containerHostsFingerprint(entries));
  });

  it('omitsAddHostArgsWhenNoEntries', async () => {
    const base = useTmpDir('mao-registry-hosts-empty-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log, { resolveHostsInjection: async () => ({ entries: [], degraded: false }) });
    await registry.ensureRunning(7, 5);
    const runArgs = log.find((line) => line.startsWith('run -d'))!;
    expect(runArgs).not.toContain('--add-host');
    expect(registry.getEntry(7, 5)!.hostsFingerprint).toBe(containerHostsFingerprint([]));
  });

  it('recreatesContainerWhenHostsInjectionDrifts', async () => {
    // 宿主 hosts / 后台规则变化 → 指纹漂移 → 复用路径主动重建一次（docker start 不会更新 --add-host）
    const base = useTmpDir('mao-registry-hosts-drift-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    let entries = [{ host: 'prometheus.acg.team', ip: '10.70.21.57', source: 'hosts-file' as const }];
    const { registry } = makeRegistry(base, log, { resolveHostsInjection: async () => ({ entries, degraded: false }) });
    await registry.ensureRunning(7, 5);
    entries = [{ host: 'prometheus.acg.team', ip: '192.168.10.10', source: 'custom' as const }];
    log.length = 0;
    const entry = await registry.ensureRunning(7, 5);
    expect(entry.state).toBe('running');
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);
    expect(log.find((line) => line.startsWith('run -d'))).toContain('--add-host prometheus.acg.team:192.168.10.10');
    // 一次性行为：指纹一致后零 docker 动作
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
  });

  it('keepsLegacyEntryWithoutFingerprintWhenNothingToInject', async () => {
    // 升级过渡：旧条目无指纹，但当前期望为空 → 不做无谓重建
    const base = useTmpDir('mao-registry-hosts-legacy-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    delete registry.getEntry(7, 5)!.hostsFingerprint;
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
  });

  it('recreatesLegacyEntryWithoutFingerprintWhenEntriesExpected', async () => {
    // 升级过渡：旧条目无指纹且当前期望非空 → 重建一次让注入生效
    const base = useTmpDir('mao-registry-hosts-legacy-entries-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const entries = [{ host: 'a.internal', ip: '10.0.0.9', source: 'custom' as const }];
    const { registry } = makeRegistry(base, log, { resolveHostsInjection: async () => ({ entries, degraded: false }) });
    await registry.ensureRunning(7, 5);
    delete registry.getEntry(7, 5)!.hostsFingerprint;
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);
    expect(registry.getEntry(7, 5)!.hostsFingerprint).toBe(containerHostsFingerprint(entries));
  });

  it('doesNotRecreateContainerWhenHostsResolutionDegraded', async () => {
    // 瞬时故障（读库/读文件失败）导致解析降级时，不得据降级结果判定漂移，
    // 否则一次 DB 抖动就会把存量容器整机重建（中断 shell/终端/在途任务）
    const base = useTmpDir('mao-registry-hosts-degraded-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    let entries = [{ host: 'a.internal', ip: '10.0.0.9', source: 'custom' as const }];
    let degraded = false;
    const { registry } = makeRegistry(base, log, { resolveHostsInjection: async () => ({ entries, degraded }) });
    await registry.ensureRunning(7, 5);

    // 降级窗口：结果为空但不可信 → 不重建
    degraded = true;
    entries = [];
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);

    // 恢复正常且与原配置一致 → 仍不重建
    degraded = false;
    entries = [{ host: 'a.internal', ip: '10.0.0.9', source: 'custom' as const }];
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);

    // 真实配置变化 → 重建一次
    entries = [{ host: 'a.internal', ip: '10.0.0.10', source: 'custom' as const }];
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);
  });

  it('recycleUserHandlesNoneBusyForcedAndFailure', async () => {
    const base = useTmpDir('mao-registry-recycle-user-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const inner = fakeDocker(log);
    let failNextRun = false;
    const docker: DockerCli = {
      async run(args) {
        if (failNextRun && args[0] === 'run' && args[1] === '-d') {
          failNextRun = false;
          throw new Error('docker run -d failed: no space left on device');
        }
        return inner.run(args);
      },
    };
    const { registry } = makeRegistry(base, log, {}, docker);
    // 无在册容器
    expect((await registry.recycleUser(7)).status).toBe('none');

    await registry.ensureRunning(7, 5);
    registry.reportRuntimeStatus(7, 5, { shellSessions: 1, pendingTasks: 0, attachedTerminals: 0 });
    expect((await registry.recycleUser(7)).status).toBe('skipped-busy');

    log.length = 0;
    const rebuilt = await registry.recycleUser(7, { force: true });
    expect(rebuilt).toEqual({ userId: 7, agentId: null, status: 'rebuilt' });
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);

    // 失败不抛出，返回 failed + 错误摘要
    registry.reportRuntimeStatus(7, 5, { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 });
    failNextRun = true;
    const failed = await registry.recycleUser(7, { force: true });
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('no space left');
  });

  it('runsTwoAgentContainersForTheSameUserIndependently', async () => {
    // 2026-11-07 复合容器方案 §7 生命周期：同用户双 Agent 并存两个容器，互不影响——
    // 切换 Agent 建新容器不杀旧容器；按 (user, agent) 独立回收
    const base = useTmpDir('mao-registry-dual-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    const a = await registry.ensureRunning(7, 5);
    const b = await registry.ensureRunning(7, 6);
    expect(a.containerName).toBe('mao-user-7-agent-5');
    expect(b.containerName).toBe('mao-user-7-agent-6');
    expect(registry.getEntry(7, 5)?.state).toBe('running');
    expect(registry.getEntry(7, 6)?.state).toBe('running');
    // docker run 调用两次（两个容器）
    expect(log.filter((l) => l.startsWith('run -d')).length).toBe(2);

    // 复用（ensureRunning 再次调用不重建）：run 仍只有两次
    await registry.ensureRunning(7, 5);
    await registry.ensureRunning(7, 6);
    expect(log.filter((l) => l.startsWith('run -d')).length).toBe(2);

    // 单容器回收只动自己：recycle (7,5) 后 (7,6) 仍在册且 running
    const recycled = await registry.recycleUser(7, { agentId: 5, force: true });
    expect(recycled).toEqual({ userId: 7, agentId: 5, status: 'rebuilt' });
    expect(registry.getEntry(7, 6)?.state).toBe('running');
    // 整用户回收（缺省 agentId）聚合两个容器
    const all = await registry.recycleUser(7, { force: true });
    expect(all).toEqual({ userId: 7, agentId: null, status: 'rebuilt' });
    // listEntries 按 (userId, agentId) 升序、含 agentId
    const summary = (await registry.listEntries()).map((e) => `${e.userId}/${e.agentId}`);
    expect(summary).toContain('7/5');
    expect(summary).toContain('7/6');
  });

  it('listsRegisteredContainersWithBusyFlag', async () => {
    const base = useTmpDir('mao-registry-list-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    expect(await registry.listEntries()).toEqual([]);
    await registry.ensureRunning(7, 5);
    const [summary] = await registry.listEntries();
    expect(summary).toMatchObject({
      userId: 7, containerName: 'mao-user-7-agent-5', state: 'running', busy: false,
    });
    expect(summary!.startedAtMs).toBeGreaterThan(0);
    registry.reportRuntimeStatus(7, 5, { shellSessions: 0, pendingTasks: 2, attachedTerminals: 0 });
    expect((await registry.listEntries())[0]!.busy).toBe(true);
  });

  // —— 容器内代码版本漂移自动收敛（V178，技术方案 §3.4/§3.5） ——

  it('restartsIdleContainerWhenRuntimeBuildDrifts', async () => {
    const base = makeBase('mao-registry-build-');
    writeRuntimeBuild(base, 'host-1');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    // 容器 agent 上报旧版本 → 空闲时自动重启进程（stop + start，不 rm/run 重建）
    registry.reportAgentHello(7, 5, 'old-1');
    expect((await registry.listEntries())[0]).toMatchObject({
      runtimeBuild: 'old-1', hostRuntimeBuild: 'host-1', pendingUpgrade: true,
    });
    log.length = 0;
    const restarted = await registry.ensureRunning(7, 5);
    expect(restarted.state).toBe('running');
    expect(dockerOps(log)).toEqual(['stop -t']);
    expect(log.filter((line) => line.startsWith('start mao-user-7')).length).toBe(1);
    // 重启后 agent 上报新版本 → 一致，不再动作
    registry.reportAgentHello(7, 5, 'host-1');
    expect((await registry.listEntries())[0]!.pendingUpgrade).toBe(false);
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(false);
  });

  it('defersRuntimeBuildUpgradeWhileBusy', async () => {
    const base = makeBase('mao-registry-build-busy-');
    writeRuntimeBuild(base, 'host-1');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    registry.reportAgentHello(7, 5, 'old-1');
    registry.reportRuntimeStatus(7, 5, { shellSessions: 1, pendingTasks: 0, attachedTerminals: 0 });
    log.length = 0;
    await registry.ensureRunning(7, 5);
    // 忙碌：不打断在跑任务，零 docker 操作
    expect(dockerOps(log)).toEqual([]);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(false);
    // 脚本探针进行中同样不打断
    registry.reportRuntimeStatus(7, 5, { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0, scriptProbes: 1 });
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
    // 解除忙碌 → 下一次调用收敛
    registry.reportRuntimeStatus(7, 5, { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 });
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual(['stop -t']);
    expect(log.filter((line) => line.startsWith('start mao-user-7')).length).toBe(1);
  });

  it('skipsRuntimeBuildUpgradeWhenDisabledOrDraining', async () => {
    const disabledBase = makeBase('mao-registry-build-off-');
    writeRuntimeBuild(disabledBase, 'host-1');
    const disabledLog: string[] = [];
    const disabled = makeRegistry(disabledBase, disabledLog, { autoUpgradeEnabled: async () => false });
    await disabled.registry.ensureRunning(7, 5);
    disabled.registry.reportAgentHello(7, 5, 'old-1');
    disabledLog.length = 0;
    await disabled.registry.ensureRunning(7, 5);
    expect(dockerOps(disabledLog)).toEqual([]);
    expect(disabledLog.some((line) => line.startsWith('start mao-user-7'))).toBe(false);

    const drainingBase = makeBase('mao-registry-build-drain-');
    writeRuntimeBuild(drainingBase, 'host-1');
    const drainingLog: string[] = [];
    const draining = makeRegistry(drainingBase, drainingLog, { isDraining: () => true });
    await draining.registry.ensureRunning(7, 5);
    draining.registry.reportAgentHello(7, 5, 'old-1');
    drainingLog.length = 0;
    await draining.registry.ensureRunning(7, 5);
    expect(dockerOps(drainingLog)).toEqual([]);
    expect(drainingLog.some((line) => line.startsWith('start mao-user-7'))).toBe(false);
  });

  it('attemptsRuntimeBuildUpgradeOnlyOncePerHostBuild', async () => {
    const base = makeBase('mao-registry-build-once-');
    writeRuntimeBuild(base, 'host-1');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    registry.reportAgentHello(7, 5, 'old-1');
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual(['stop -t']);
    // 模拟「重启后仍上报旧版本」（蓝绿过渡：旧实例缓存旧 build）→ 不得重复重启形成风暴
    registry.reportAgentHello(7, 5, 'old-1');
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(false);
  });

  it('startsStoppedContainerWithoutExtraRestartWhenRuntimeBuildDrifts', async () => {
    const base = makeBase('mao-registry-build-stopped-');
    writeRuntimeBuild(base, 'host-1');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    registry.reportAgentHello(7, 5, 'old-1');
    // 模拟 idle 回收后的 stopped 条目：docker start 本身即进程重启，无需额外 stop/restart
    (registry.getEntry(7, 5) as { state: string }).state = 'stopped';
    log.length = 0;
    const again = await registry.ensureRunning(7, 5);
    expect(again.state).toBe('running');
    expect(dockerOps(log)).toEqual([]);
    expect(log.filter((line) => line.startsWith('start mao-user-7')).length).toBe(1);
  });

  it('rebuildsInsteadOfRestartingWhenMountPlanDriftsTogether', async () => {
    const base = makeBase('mao-registry-build-mount-');
    writeRuntimeBuild(base, 'host-1');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    registry.reportAgentHello(7, 5, 'old-1');
    // 挂载漂移优先（能力缺失 > 代码新鲜度）：走重建而非重启
    (registry.getEntry(7, 5) as { mountFingerprint?: string }).mountFingerprint = 'stale-fingerprint';
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(false);
  });

  it('keepsLegacyBehaviorWhenHostManifestMissing', async () => {
    // manifest 缺失（dev / 手工构建）：检查整体关闭，不因 agent 上报值产生任何动作
    const base = makeBase('mao-registry-build-nomanifest-');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7, 5);
    registry.reportAgentHello(7, 5, 'whatever');
    log.length = 0;
    await registry.ensureRunning(7, 5);
    expect(dockerOps(log)).toEqual([]);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(false);
    const summary = (await registry.listEntries())[0]!;
    expect(summary.hostRuntimeBuild).toBeNull();
    expect(summary.pendingUpgrade).toBe(false);
  });

  // —— 管理后台容器管理：纳入 Docker 未在册残留容器（2026-11-10） ——

  /** 构造返回固定 ps 输出的 DockerCli（ps 参数照记日志供断言；其余命令转发 inner）。 */
  function fakePsDocker(log: string[], psOutput: () => string): DockerCli {
    const inner = fakeDocker(log);
    return {
      async run(args) {
        if (args[0] === 'ps') {
          log.push(args.join(' '));
          return psOutput();
        }
        return inner.run(args);
      },
    };
  }

  it('listsTrackedStoppedEntryWithTrackedFlag', async () => {
    // 停止的在册容器照常列出（tracked=true）：idle 回收 stop 不 rm，条目仍在注册表
    const base = makeBase('mao-registry-list-stopped-');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log, {}, fakePsDocker(log, () => ''));
    await registry.ensureRunning(7, 5);
    registry.getEntry(7, 5)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped
    const rows = await registry.listEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      userId: 7, agentId: 5, state: 'stopped', tracked: true, busy: false, ageText: null,
    });
    expect(rows[0]!.startedAtMs).toBeGreaterThan(0);
  });

  it('listsUntrackedDockerLeftovers', async () => {
    // 合并 Docker 残留（不在注册表）：exited/dead → stopped、running → running；
    // 旧命名孤儿（无 agent label）与非数字 label 行跳过；按 (userId, agentId) 排序
    const base = makeBase('mao-registry-list-leftovers-');
    const psOutput = [
      'mao-user-7-agent-5\t7\t5\trunning\tAbout a minute ago',
      'mao-user-7-agent-6\t7\t6\texited\t2 hours ago',
      'mao-user-9-agent-1\t9\t1\tdead\t3 days ago',
      'mao-user-7\t7\t\trunning\t5 days ago', // 旧命名孤儿：container-gc.sh 的辖区
      'junk\tabc\t5\texited\t1 day ago',      // 非数字 label：不可能是本系统容器
      '',
    ].join('\n');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log, {}, fakePsDocker(log, () => psOutput));
    expect(await registry.listEntries()).toEqual([
      {
        userId: 7, agentId: 5, containerName: 'mao-user-7-agent-5', state: 'running',
        tracked: false, busy: false, startedAtMs: 0, lastUsedAtMs: 0,
        runtimeBuild: null, hostRuntimeBuild: null, pendingUpgrade: false, ageText: 'About a minute ago',
      },
      {
        userId: 7, agentId: 6, containerName: 'mao-user-7-agent-6', state: 'stopped',
        tracked: false, busy: false, startedAtMs: 0, lastUsedAtMs: 0,
        runtimeBuild: null, hostRuntimeBuild: null, pendingUpgrade: false, ageText: '2 hours ago',
      },
      {
        userId: 9, agentId: 1, containerName: 'mao-user-9-agent-1', state: 'stopped',
        tracked: false, busy: false, startedAtMs: 0, lastUsedAtMs: 0,
        runtimeBuild: null, hostRuntimeBuild: null, pendingUpgrade: false, ageText: '3 days ago',
      },
    ]);
  });

  it('degradesToTrackedOnlyWhenDockerScanFails', async () => {
    // docker ps 失败：列表降级为仅在册条目（不整体失败）；聚合回收不受影响
    const base = makeBase('mao-registry-list-ps-fail-');
    const log: string[] = [];
    const inner = fakeDocker(log);
    const docker: DockerCli = {
      async run(args) {
        if (args[0] === 'ps') throw new Error('docker ps failed: cannot connect to daemon');
        return inner.run(args);
      },
    };
    const { registry } = makeRegistry(base, log, {}, docker);
    await registry.ensureRunning(7, 5);
    const rows = await registry.listEntries();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ userId: 7, agentId: 5, tracked: true });
    log.length = 0;
    const result = await registry.recycleUser(7, { force: true });
    expect(result.status).toBe('rebuilt');
    expect(dockerOps(log)).toEqual(['stop -t', 'rm -f', 'run -d']);
  });

  it('removesUntrackedLeftoverOnSingleRecycle', async () => {
    // 指定 agentId + 无在册条目：Docker 有残留 → rm -f（removed）；无残留 → none（不 rm）
    const base = makeBase('mao-registry-recycle-leftover-');
    let psResult = 'abc123\n';
    const log: string[] = [];
    const { registry } = makeRegistry(base, log, {}, fakePsDocker(log, () => psResult));
    const removed = await registry.recycleUser(7, { agentId: 5 });
    expect(removed).toEqual({ userId: 7, agentId: 5, status: 'removed' });
    expect(dockerOps(log)).toEqual(['rm -f']);
    // ps 窄过滤（精确名 + 运行时 label 三重匹配，绝不误删外部容器）与 rm 目标名
    const psArgs = log.find((l) => l.startsWith('ps -a'))!;
    expect(psArgs).toContain('--filter name=^/mao-user-7-agent-5$');
    expect(psArgs).toContain('--filter label=mao.runtime=user');
    expect(psArgs).toContain('--filter label=mao.user=7');
    expect(psArgs).toContain('--filter label=mao.agent=5');
    expect(log.some((l) => l.startsWith('rm -f mao-user-7-agent-5'))).toBe(true);

    log.length = 0;
    psResult = '';
    const none = await registry.recycleUser(7, { agentId: 5 });
    expect(none).toEqual({ userId: 7, agentId: 5, status: 'none' });
    expect(dockerOps(log)).toEqual([]);
  });

  it('aggregateRecycleSweepsUntrackedLeftovers', async () => {
    // 整用户回收 = 在册条目（停→rm→重建）∪ Docker 残留（rm）；其他用户容器不动；
    // 聚合优先级：有 rebuilt 即 rebuilt；忙碌在册（skipped-busy）盖过 removed；
    // 只有 removed 时聚合结果为 removed
    const base = makeBase('mao-registry-recycle-sweep-');
    const psOutput = [
      'mao-user-7-agent-5\t7\t5\trunning\tAbout a minute ago',
      'mao-user-7-agent-6\t7\t6\texited\t2 hours ago',
      'mao-user-9-agent-1\t9\t1\texited\t3 days ago',
      '',
    ].join('\n');
    const log: string[] = [];
    const { registry } = makeRegistry(base, log, {}, fakePsDocker(log, () => psOutput));
    await registry.ensureRunning(7, 5);
    log.length = 0;
    const rebuilt = await registry.recycleUser(7, { force: true });
    expect(rebuilt).toEqual({ userId: 7, agentId: null, status: 'rebuilt' });
    expect(log.some((l) => l.startsWith('stop -t 10 mao-user-7-agent-5'))).toBe(true);
    expect(log.some((l) => l.startsWith('rm -f mao-user-7-agent-6'))).toBe(true);
    expect(log.some((l) => l.startsWith('rm -f mao-user-9-agent-1'))).toBe(false);
    expect(dockerOps(log).filter((op) => op === 'rm -f').length).toBe(2); // 在册重建的 rm + 残留 rm

    // 忙碌在册（未强制）盖过 removed
    registry.reportRuntimeStatus(7, 5, { shellSessions: 1, pendingTasks: 0, attachedTerminals: 0 });
    const busy = await registry.recycleUser(7);
    expect(busy.status).toBe('skipped-busy');

    // 无在册条目、只有残留 → removed
    const log2: string[] = [];
    const { registry: reg2 } = makeRegistry(base, log2, {}, fakePsDocker(log2, () => psOutput));
    const onlyRemoved = await reg2.recycleUser(7, { force: true });
    expect(onlyRemoved).toEqual({ userId: 7, agentId: null, status: 'removed' });
    expect(log2.some((l) => l.startsWith('rm -f mao-user-7-agent-6'))).toBe(true);
    expect(log2.some((l) => l.startsWith('rm -f mao-user-9-agent-1'))).toBe(false);
  });
});
