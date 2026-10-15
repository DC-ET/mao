import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerRegistry, type DockerCli } from './container-registry.js';
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
        depsDir: join(base, 'deps'), tmpfsSizeMb: 64, startTimeoutMs: 1000,
      },
    },
    workspaceRoot: join(base, 'workspace'),
    userHomeDir: join(base, 'users'),
    runtimeDir: join(base, 'runtime'),
    userSkillsDir: join(base, 'userskills'),
    skillsDir: join(base, 'skills'),
    // 宿主机先 listen 再 docker run（BUG-2 回归）：listen/token 回调先于 run 发生
    ensureChannelListening: async (userId) => {
      listenings.push(userId);
      log.push(`listen ${userId}`);
      return join(base, 'channels', String(userId), 'runtime.sock');
    },
    issueChannelToken: (userId) => { tokens.push(userId); log.push(`token ${userId}`); return 'tok-' + userId; },
    waitSocketReady: async (userId) => { waits.push(userId); },
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

describe('container registry', () => {
  it('createsContainerWithResourceLimitsAndMounts', async () => {
    const base = useTmpDir('mao-registry-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry, waits, listenings, tokens } = makeRegistry(base, log);
    const entry = await registry.ensureRunning(7);
    expect(entry.state).toBe('running');
    expect(entry.containerName).toBe('mao-user-7');
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
    // 容器 agent 硬依赖 env：userId / token / 四个 roots（BUG-3 回归）
    expect(runArgs).toContain('-e MAO_CONTAINER_USER_ID=7');
    expect(runArgs).toContain('-e MAO_CHANNEL_TOKEN=tok-7');
    expect(runArgs).toContain(`-e MAO_WORKSPACE_ROOT=${join(base, 'workspace')}`);
    expect(runArgs).toContain(`-e MAO_RUNTIME_DIR=${join(base, 'runtime')}`);
    expect(runArgs).toContain(`-e MAO_USER_HOME_DIR=${join(base, 'users')}`);
    expect(runArgs).toContain(`-e MAO_USER_SKILLS_DIR=${join(base, 'userskills')}`);
    // socket 路径由 ensureChannelListening 返回（唯一真相）
    expect(runArgs).toContain(`--socket ${join(base, 'channels', '7', 'runtime.sock')}`);
    // 不暴露端口
    expect(runArgs).not.toContain('-p ');
    expect(runArgs).not.toContain('--publish');
    // 只挂本用户目录
    expect(runArgs).toContain('/users/7:');
    expect(runArgs).not.toContain('/users/8:');
    // dist 只读
    expect(runArgs).toContain(':ro');
    // 并发复用：running 状态直接复用，不再创建第二个容器
    const again = await registry.ensureRunning(7);
    expect(again.containerName).toBe(entry.containerName);
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(1);
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
      waitSocketReady: async (userId) => {
        waits.push(userId);
        if (!ready) throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
      },
    });
    await expect(registry.ensureRunning(7)).rejects.toThrow(/容器运行时通道连接超时/);
    expect(registry.getEntry(7)).toBeUndefined();
    // 半成品容器被清理
    expect(log.some((line) => line.startsWith('rm -f mao-user-7'))).toBe(true);
    // 第二次：socket 已能就绪 → 重新 docker run 并成功
    ready = true;
    const entry = await registry.ensureRunning(7);
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
    const first = await registry.ensureRunning(7);
    // 模拟外部停止
    (registry.getEntry(7) as { state: string }).state = 'stopped';
    const second = await registry.ensureRunning(7);
    expect(second.containerName).toBe(first.containerName);
    expect(log.some((line) => line.startsWith('start mao-user-7'))).toBe(true);
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(1);
  });

  it('rebuildsWhenConnectionDead', async () => {
    const base = useTmpDir('mao-registry-3-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry } = makeRegistry(base, log);
    await registry.ensureRunning(7);
    registry.markConnectionDead(7);
    await registry.ensureRunning(7);
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
    const entry = await registry.ensureRunning(7);
    entry.lastUsedAtMs = Date.now() - 100 * 60_000; // 远超 idle
    // 容器内有活跃 shell：§5.3.1 idle 不推进，不 stop
    registry.reportRuntimeStatus(7, { shellSessions: 2, pendingTasks: 0, attachedTerminals: 0 });
    await registry.reapExpired();
    expect(log.some((line) => line.startsWith('stop -t 10 mao-user-7'))).toBe(false);
    // 容器内状态归零后 idle 推进 → stop（不 rm）
    registry.reportRuntimeStatus(7, { shellSessions: 0, pendingTasks: 0, attachedTerminals: 0 });
    await registry.reapExpired();
    expect(log.some((line) => line.startsWith('stop -t 10 mao-user-7'))).toBe(true);
    expect(log.some((line) => line.startsWith('rm '))).toBe(false);
    expect(registry.getEntry(7)?.state).toBe('stopped');
    // idle 回收后 ensureRunning 走 start 复用
    log.length = 0;
    await registry.ensureRunning(7);
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
      waitSocketReady: async (userId) => {
        waits.push(userId);
        if (!ready) throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
      },
    });
    await registry.ensureRunning(7);
    // idle 回收 → stopped，下次 ensureRunning 走 dockerStart 重启路径
    registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired();
    expect(registry.getEntry(7)?.state).toBe('stopped');

    ready = false; // 重启：start 成功但容器内 agent 永不连接
    log.length = 0;
    await expect(registry.ensureRunning(7)).rejects.toThrow(/容器运行时通道连接超时/);
    // 毒化条目被清理（旧行为：残留 state=running，后续 ensureRunning 直接复用、永不重试）
    expect(registry.getEntry(7)).toBeUndefined();
    expect(log.some((line) => line.startsWith('rm -f mao-user-7'))).toBe(true);
    // 根因恢复后：完整 docker run 重建（自愈），不再无限复用死条目
    ready = true;
    log.length = 0;
    const entry = await registry.ensureRunning(7);
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
      sessionWorkspacesOf: async (userId) => {
        seenByLookup.push(userId);
        return [feishuWs, dingtalkWs, join(base, 'workspace', '7', 'web-session')];
      },
    });
    await registry.ensureRunning(7);
    const runArgs = log.find((line) => line.startsWith('run -d'))!;
    expect(runArgs).toContain(`${feishuWs}:${feishuWs}:rw`);
    expect(runArgs).toContain(`${dingtalkWs}:${dingtalkWs}:rw`);
    // web 会话工作区在每用户根内，不重复附加挂载
    expect(runArgs).not.toContain(`${join(base, 'workspace', '7', 'web-session')}:`);
    expect(seenByLookup).toEqual([7]);
    // 条目记录挂载集合，供后续 isMounted 判定
    const entry = registry.getEntry(7)!;
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
    await registry.ensureRunning(7, join(base, 'workspace', '7', 'web-session'));
    expect(log.filter((line) => line.startsWith('run -d')).length).toBe(1);
    expect(registry.getEntry(7)!.mountedPaths.has(groupWs)).toBe(false);

    // 新通道会话的首个工具调用：工作区未挂载 → 重建（rm + run），新容器带该挂载
    const entry = await registry.ensureRunning(7, groupWs);
    expect(entry.state).toBe('running');
    expect(entry.mountedPaths.has(groupWs)).toBe(true);
    const runs = log.filter((line) => line.startsWith('run -d'));
    expect(runs.length).toBe(2);
    expect(runs[1]).toContain(`${groupWs}:${groupWs}:rw`);
    // 重建后同工作区复用，不再反复重建
    log.length = 0;
    await registry.ensureRunning(7, groupWs);
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
    await registry.ensureRunning(7, join(base, 'workspace', '7', 'projects', 'demo'));
    log.length = 0;
    await registry.ensureRunning(7, join(base, 'workspace', '7', 'other-session'));
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
    await expect(registry.ensureRunning(7, bogus)).rejects.toThrow(/不在容器可挂载范围内/);
    // 容器本体健康（该用户其他会话可用），但该会话工作区永远不可见
    expect(registry.getEntry(7)?.state).toBe('running');
    // 再次调用同样明确失败，不产生额外 docker 动作
    log.length = 0;
    await expect(registry.ensureRunning(7, bogus)).rejects.toThrow(/不在容器可挂载范围内/);
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
          depsDir: join(base, 'deps'), tmpfsSizeMb: 64, startTimeoutMs: 1000,
        },
      },
      workspaceRoot: join(base, 'workspace'),
      userHomeDir: join(base, 'users'),
      runtimeDir: join(base, 'runtime'),
      userSkillsDir: join(base, 'userskills'),
      skillsDir: join(base, 'skills'),
      ensureChannelListening: async () => join(base, 'channels', '7', 'runtime.sock'),
      issueChannelToken: () => 'tok-7',
      waitSocketReady: async () => undefined,
      // 回收通知执行期间，并发发生 recycle（用户新建了飞书群会话）
      requestShutdown: async () => {
        if (!noticed) {
          noticed = true;
          await registry!.ensureRunning(7, feishuWs);
        }
        return true;
      },
    }, fakeDocker(log));

    await registry.ensureRunning(7);
    registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000; // 远超 idle
    await registry.reapExpired();
    // 新容器就绪且未被误伤：最后一次 run -d（重建）之后不得再出现 stop
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastStop = log.map((l) => l.startsWith('stop -t 10')).lastIndexOf(true);
    expect(lastRun).toBeGreaterThanOrEqual(0);
    expect(lastStop).toBeLessThan(lastRun);
    expect(registry.getEntry(7)?.state).toBe('running');
    expect(registry.getEntry(7)?.mountedPaths.has(feishuWs)).toBe(true);
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

    await registry.ensureRunning(7);
    registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped

    log.length = 0;
    const [a, b] = await Promise.all([registry.ensureRunning(7, wsA), registry.ensureRunning(7, wsB)]);
    // recycle 原地更新条目：两个调用方拿到的是同一条目（句柄不错位）
    expect(a).toBe(b);
    expect(registry.getEntry(7)).toBe(a);
    // 在册条目的挂载集合与真实容器一致
    expect(registry.getEntry(7)!.mountedPaths.has(wsA)).toBe(true);
    expect(registry.getEntry(7)!.mountedPaths.has(wsB)).toBe(true);
    // 串行化：每次 run -d 之前都有对应的 rm -f，没有"同名冲突被吞掉"的第二次 run -d，
    // 也没有对同一容器的双重 stop
    expect(dockerOps(log)).toEqual(['rm -f', 'run -d', 'stop -t', 'rm -f', 'run -d']);
    // 两个工作区都已在册：后续调用不触发任何重建
    log.length = 0;
    await registry.ensureRunning(7, wsA);
    await registry.ensureRunning(7, wsB);
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
    const [a, b] = await Promise.all([registry.ensureRunning(7, wsA), registry.ensureRunning(7, wsB)]);
    expect(a).toBe(b);
    expect(registry.getEntry(7)).toBe(a);
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
          await registry!.ensureRunning(7, wsB);
          throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
        }
      },
      sessionWorkspacesOf: async () => [],
    });
    registry = reg;

    await registry.ensureRunning(7);
    registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped
    phase = 1;

    log.length = 0;
    await expect(registry.ensureRunning(7)).rejects.toThrow(/连接超时/);
    // 并发 recycle 建好的新容器与在册条目都存活，wsB 已挂载
    expect(registry.getEntry(7)?.state).toBe('running');
    expect(registry.getEntry(7)?.mountedPaths.has(wsB)).toBe(true);
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

    await registry.ensureRunning(7);
    registry.markConnectionDead(7);
    log.length = 0;
    const entry = await registry.ensureRunning(7);
    expect(entry.state).toBe('running');
    expect(registry.getEntry(7)).toBe(entry);
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

    await registry.ensureRunning(7);
    registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped（容器 exited，仍被注册表跟踪）
    expect(registry.getEntry(7)?.state).toBe('stopped');

    startFails = true; // 容器已被 GC 清掉
    log.length = 0;
    await expect(registry.ensureRunning(7)).rejects.toThrow(/No such container/);
    expect(registry.getEntry(7)).toBeUndefined();
    // 自愈：下次 ensureRunning 走完整 docker run 重建（新容器带新 agent）
    startFails = false;
    log.length = 0;
    const entry = await registry.ensureRunning(7);
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
          await registry!.ensureRunning(7, wsB);
          throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
        }
      },
    });
    registry = reg;

    await registry.ensureRunning(7);
    registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
    await registry.reapExpired(); // → stopped
    phase = 1;

    log.length = 0;
    await expect(registry.ensureRunning(7, wsA)).rejects.toThrow(/连接超时/);
    // 重入 recycle 建好的新容器与在册条目都存活，wsB 已挂载
    expect(registry.getEntry(7)?.state).toBe('running');
    expect(registry.getEntry(7)?.mountedPaths.has(wsB)).toBe(true);
    // 最后一次 rm -f 不得落在最后一次 run -d 之后
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
    expect(lastRm).toBeLessThan(lastRun);
  });
});
