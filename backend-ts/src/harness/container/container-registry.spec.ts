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

function makeRegistry(base: string, log: string[], overrides: Partial<ConstructorParameters<typeof ContainerRegistry>[0]> = {}) {
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
  }, fakeDocker(log));
  return { registry, waits, listenings, tokens };
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
});
