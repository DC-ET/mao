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
    waitSocketReady: async (userId) => { waits.push(userId); },
    requestShutdown: async () => true,
    ...overrides,
  }, fakeDocker(log));
  return { registry, waits };
}

describe('container registry', () => {
  it('createsContainerWithResourceLimitsAndMounts', async () => {
    const base = useTmpDir('mao-registry-');
    for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
      mkdirSync(join(base, d), { recursive: true });
    }
    const log: string[] = [];
    const { registry, waits } = makeRegistry(base, log);
    const entry = await registry.ensureRunning(7);
    expect(entry.state).toBe('running');
    expect(entry.containerName).toBe('mao-user-7');
    expect(waits).toEqual([7]);
    const runArgs = log.find((line) => line.startsWith('run -d'));
    expect(runArgs).toBeDefined();
    expect(runArgs).toContain('--memory 512m');
    expect(runArgs).toContain('--cpus 1');
    expect(runArgs).toContain('--pids-limit 100');
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
