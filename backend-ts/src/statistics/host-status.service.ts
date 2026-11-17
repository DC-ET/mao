/**
 * 后端所在机器的当前资源快照。
 * CPU 首次请求内等 200ms 取一个初值；之后按两次调用的间隔做差值（页面 15s 轮询即这 15s 的平均利用率）。
 * 磁盘用 df，同一挂载点只保留先出现的那一项（系统盘优先于数据目录）。
 * Docker 不可用时容器区标记原因，CPU / 内存 / 硬盘照常返回。
 */
import { execFile } from 'node:child_process';
import { accessSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { resolve } from 'node:path';
import type { HostDiskSnapshot, HostMemorySnapshot, HostStatusVo } from '@mao/contracts';
import {
  cpuTimesFromCpus,
  cpuUsagePercent,
  dockerProbeFailure,
  emptyContainers,
  parseDf,
  parseMeminfo,
  selectDisks,
  summarizeContainers,
  toMemorySnapshot,
  type CpuTimes,
  type HostContainerRow,
} from './host-metrics.js';

export const CPU_SAMPLE_GAP_MS = 200;

export interface HostDiskProbe {
  label: string;
  path: string;
}

export interface HostIo {
  hostname(): string;
  platform(): string;
  uptimeSeconds(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
  cpuTimes(): CpuTimes;
  cpuCount(): number;
  loadavg(): readonly number[];
  /** 读不到 /proc/meminfo 时返回 null。 */
  readMeminfo(): string | null;
  osMemory(): { totalBytes: number; freeBytes: number };
  pathExists(target: string): boolean;
  /** df 失败返回 null，不抛。 */
  df(target: string): Promise<string | null>;
  listContainers(): Promise<HostContainerRow[]>;
  probeDocker(): Promise<{ ok: true } | { ok: false; reason: string }>;
}

export function hostDiskProbes(input: {
  workspaceRoot: string;
  uploadDir: string;
  runtimeDir: string;
  userHomeDir: string;
}): HostDiskProbe[] {
  return [
    { label: '系统盘', path: '/' },
    { label: '工作区', path: resolve(input.workspaceRoot) },
    { label: '上传目录', path: resolve(input.uploadDir) },
    { label: '运行时目录', path: resolve(input.runtimeDir) },
    { label: '用户目录', path: resolve(input.userHomeDir) },
    { label: 'Docker 数据', path: '/var/lib/docker' },
  ];
}

function execText(
  command: string,
  args: string[],
  timeout: number,
): Promise<{ ok: true; stdout: string } | { ok: false; error: NodeJS.ErrnoException }> {
  return new Promise((resolvePromise) => {
    execFile(command, args, { timeout, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) resolvePromise({ ok: false, error: error as NodeJS.ErrnoException });
      else resolvePromise({ ok: true, stdout: String(stdout) });
    });
  });
}

export function createHostIo(listContainers: () => Promise<HostContainerRow[]>): HostIo {
  return {
    hostname: () => os.hostname(),
    platform: () => os.platform(),
    uptimeSeconds: () => os.uptime(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
    cpuTimes: () => cpuTimesFromCpus(os.cpus()),
    cpuCount: () => os.cpus().length,
    loadavg: () => os.loadavg(),
    readMeminfo: () => {
      try {
        return readFileSync('/proc/meminfo', 'utf8');
      } catch {
        return null;
      }
    },
    osMemory: () => ({ totalBytes: os.totalmem(), freeBytes: os.freemem() }),
    pathExists: (target) => {
      try {
        accessSync(target);
        return true;
      } catch {
        return false;
      }
    },
    async df(target) {
      const result = await execText('df', ['-P', '-k', target], 5_000);
      return result.ok ? result.stdout : null;
    },
    listContainers,
    async probeDocker() {
      const result = await execText('docker', ['version', '--format', '{{.Server.Version}}'], 3_000);
      if (!result.ok) return { ok: false, reason: dockerProbeFailure(result.error) };
      if (!result.stdout.trim()) return { ok: false, reason: '无法连接 Docker' };
      return { ok: true };
    },
  };
}

export class HostStatusService {
  private lastCpu: { times: CpuTimes; at: number; percent: number | null } | null = null;
  private cpuTask: Promise<{ percent: number | null; cores: number }> | null = null;

  constructor(
    private readonly io: HostIo,
    private readonly disks: readonly HostDiskProbe[],
  ) {}

  async snapshot(): Promise<HostStatusVo> {
    const [cpu, disks, containers] = await Promise.all([
      this.sampleCpu(),
      this.readDisks(),
      this.readContainers(),
    ]);
    const memory = this.readMemory();
    const load = this.io.loadavg();
    return {
      hostname: this.io.hostname(),
      platform: this.io.platform(),
      uptimeSeconds: Math.max(0, Math.floor(this.io.uptimeSeconds())),
      sampledAt: this.io.now(),
      memorySource: memory.source,
      cpu: {
        cores: cpu.cores,
        usagePercent: cpu.percent,
        load1: load[0] ?? 0,
        load5: load[1] ?? 0,
        load15: load[2] ?? 0,
      },
      memory: memory.memory,
      disks,
      containers,
    };
  }

  private sampleCpu(): Promise<{ percent: number | null; cores: number }> {
    if (this.cpuTask) return this.cpuTask;
    const task = this.sampleCpuOnce();
    this.cpuTask = task;
    void task.finally(() => {
      if (this.cpuTask === task) this.cpuTask = null;
    });
    return task;
  }

  private async sampleCpuOnce(): Promise<{ percent: number | null; cores: number }> {
    const cores = this.io.cpuCount();
    const at = this.io.now();
    const prev = this.lastCpu;
    if (prev != null && at - prev.at < CPU_SAMPLE_GAP_MS) return { percent: prev.percent, cores };
    const times = this.io.cpuTimes();
    if (prev == null) {
      await this.io.sleep(CPU_SAMPLE_GAP_MS);
      const next = this.io.cpuTimes();
      const percent = cpuUsagePercent(times, next);
      this.lastCpu = { times: next, at: this.io.now(), percent };
      return { percent, cores };
    }
    const percent = cpuUsagePercent(prev.times, times);
    this.lastCpu = { times, at, percent };
    return { percent, cores };
  }

  private readMemory(): { source: 'proc' | 'os'; memory: HostMemorySnapshot } {
    const text = this.io.readMeminfo();
    const parsed = text != null ? parseMeminfo(text) : null;
    if (parsed) {
      return {
        source: 'proc',
        memory: toMemorySnapshot(parsed.totalBytes, parsed.availableBytes, parsed.swapTotalBytes, parsed.swapUsedBytes),
      };
    }
    const osMem = this.io.osMemory();
    return {
      source: 'os',
      memory: toMemorySnapshot(osMem.totalBytes, osMem.freeBytes, null, null),
    };
  }

  private async readDisks(): Promise<HostDiskSnapshot[]> {
    const seen = new Set<string>();
    const probes: HostDiskProbe[] = [];
    for (const disk of this.disks) {
      if (!disk.path || seen.has(disk.path)) continue;
      seen.add(disk.path);
      probes.push(disk);
    }
    const samples = await Promise.all(probes.map(async (disk) => {
      if (!this.io.pathExists(disk.path)) return { label: disk.label, path: disk.path, parsed: null };
      const text = await this.io.df(disk.path);
      return { label: disk.label, path: disk.path, parsed: text ? parseDf(text) : null };
    }));
    return selectDisks(samples);
  }

  private async readContainers() {
    const probe = await this.io.probeDocker();
    if (!probe.ok) return emptyContainers(probe.reason);
    try {
      return summarizeContainers(await this.io.listContainers());
    } catch {
      return emptyContainers('读取容器列表失败');
    }
  }
}
