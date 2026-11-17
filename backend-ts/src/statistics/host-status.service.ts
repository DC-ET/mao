/**
 * 后端所在机器的当前资源快照。
 * CPU 首次请求内等 200ms 取一个初值；之后按两次调用的间隔做差值（页面折线每秒一个点，即这一秒的平均利用率）。
 * 磁盘用 df，同一挂载点只保留先出现的那一项（系统盘优先于数据目录）。
 * Docker 不可用时容器区标记原因，CPU / 内存 / 硬盘照常返回。
 */
import { execFile } from 'node:child_process';
import { accessSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { resolve } from 'node:path';
import type { HostCpuSnapshot, HostDiskSnapshot, HostDockerDiskSnapshot, HostMemorySnapshot, HostProcessSnapshot, HostStatusVo, HostTrendSample } from '@mao/contracts';
import {
  cpuTimesFromCpus,
  cpuUsagePercent,
  diskIoRates,
  dockerDiskFromParsed,
  dockerProbeFailure,
  emptyContainers,
  emptyDockerDisk,
  iowaitPercent,
  parseDf,
  parseDfInodes,
  parseDiskstats,
  parseDockerSystemDf,
  parseFdLimit,
  parseMeminfo,
  parseProcStat,
  selectDisks,
  summarizeContainers,
  toMemorySnapshot,
  type CpuTimes,
  type DiskIoCounters,
  type HostContainerRow,
  type ProcStatTimes,
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
  /** inode 的 df。失败返回 null。 */
  dfInodes(target: string): Promise<string | null>;
  /** 读不到 /proc/stat 时返回 null。 */
  readProcStat(): string | null;
  /** 读不到 /proc/diskstats 时返回 null。 */
  readDiskstats(): string | null;
  processUptimeSeconds(): number;
  processMemory(): { rssBytes: number; heapUsedBytes: number; heapTotalBytes: number };
  /** 还没有采样时返回 null。 */
  eventLoopDelayMs(): number | null;
  fileDescriptors(): { open: number | null; limit: number | null };
  listContainers(): Promise<HostContainerRow[]>;
  probeDocker(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** `docker system df` 失败返回 null。 */
  dockerSystemDf(): Promise<string | null>;
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

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function countFds(dir: string): number | null {
  try {
    // readdir 自己占一个 fd，减掉，避免把这次读取算进占用。
    return Math.max(0, readdirSync(dir).length - 1);
  } catch {
    return null;
  }
}

export function createHostIo(listContainers: () => Promise<HostContainerRow[]>): HostIo {
  const loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  return {
    hostname: () => os.hostname(),
    platform: () => os.platform(),
    uptimeSeconds: () => os.uptime(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((done) => { setTimeout(done, ms); }),
    cpuTimes: () => cpuTimesFromCpus(os.cpus()),
    cpuCount: () => os.cpus().length,
    loadavg: () => os.loadavg(),
    readMeminfo: () => readText('/proc/meminfo'),
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
    async dfInodes(target) {
      const result = await execText('df', ['-P', '-i', target], 5_000);
      return result.ok ? result.stdout : null;
    },
    readProcStat: () => readText('/proc/stat'),
    readDiskstats: () => readText('/proc/diskstats'),
    processUptimeSeconds: () => process.uptime(),
    processMemory: () => {
      const usage = process.memoryUsage();
      return { rssBytes: usage.rss, heapUsedBytes: usage.heapUsed, heapTotalBytes: usage.heapTotal };
    },
    eventLoopDelayMs: () => {
      if (loopDelay.count < 1) return null;
      const ms = loopDelay.mean / 1e6;
      loopDelay.reset();
      return Number.isFinite(ms) ? Math.round(ms * 10) / 10 : null;
    },
    fileDescriptors: () => {
      const open = countFds('/proc/self/fd') ?? countFds('/dev/fd');
      const limits = readText('/proc/self/limits');
      return { open, limit: limits != null ? parseFdLimit(limits) : null };
    },
    listContainers,
    async probeDocker() {
      const result = await execText('docker', ['version', '--format', '{{.Server.Version}}'], 3_000);
      if (!result.ok) return { ok: false, reason: dockerProbeFailure(result.error) };
      if (!result.stdout.trim()) return { ok: false, reason: '无法连接 Docker' };
      return { ok: true };
    },
    async dockerSystemDf() {
      const result = await execText('docker', ['system', 'df', '--format', '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'], 8_000);
      return result.ok ? result.stdout : null;
    },
  };
}

interface RateSample {
  times: CpuTimes;
  at: number;
  percent: number | null;
  iowaitPercent: number | null;
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
  proc: ProcStatTimes | null;
  disk: DiskIoCounters | null;
}

interface RateReading {
  percent: number | null;
  cores: number;
  iowaitPercent: number | null;
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
}

export class HostStatusService {
  private lastRate: RateSample | null = null;
  private rateTask: Promise<RateReading> | null = null;

  constructor(
    private readonly io: HostIo,
    private readonly disks: readonly HostDiskProbe[],
  ) {}

  async snapshot(): Promise<HostStatusVo> {
    const [rates, disks, docker] = await Promise.all([
      this.sampleRates(),
      this.readDisks(),
      this.readDocker(),
    ]);
    const memory = this.readMemory();
    return {
      hostname: this.io.hostname(),
      platform: this.io.platform(),
      uptimeSeconds: Math.max(0, Math.floor(this.io.uptimeSeconds())),
      sampledAt: this.io.now(),
      memorySource: memory.source,
      cpu: this.cpuSnapshot(rates),
      memory: memory.memory,
      disks,
      diskIo: { readBytesPerSec: rates.readBytesPerSec, writeBytesPerSec: rates.writeBytesPerSec },
      process: this.readProcess(),
      containers: docker.containers,
      dockerDisk: docker.disk,
    };
  }

  /** CPU 与内存的一个点。不读磁盘、不查 Docker，供页面每秒采样。 */
  async trend(): Promise<HostTrendSample> {
    const rates = await this.sampleRates();
    const memory = this.readMemory();
    return {
      sampledAt: this.io.now(),
      memorySource: memory.source,
      cpu: this.cpuSnapshot(rates),
      memory: memory.memory,
    };
  }

  private cpuSnapshot(rates: RateReading): HostCpuSnapshot {
    const load = this.io.loadavg();
    return {
      cores: rates.cores,
      usagePercent: rates.percent,
      iowaitPercent: rates.iowaitPercent,
      load1: load[0] ?? 0,
      load5: load[1] ?? 0,
      load15: load[2] ?? 0,
    };
  }

  private sampleRates(): Promise<RateReading> {
    if (this.rateTask) return this.rateTask;
    const task = this.sampleRatesOnce();
    this.rateTask = task;
    void task.finally(() => {
      if (this.rateTask === task) this.rateTask = null;
    });
    return task;
  }

  private readRatePoint(): { times: CpuTimes; at: number; proc: ProcStatTimes | null; disk: DiskIoCounters | null } {
    const procText = this.io.readProcStat();
    const diskText = this.io.readDiskstats();
    return {
      times: this.io.cpuTimes(),
      at: this.io.now(),
      proc: procText != null ? parseProcStat(procText) : null,
      disk: diskText != null ? parseDiskstats(diskText) : null,
    };
  }

  private async sampleRatesOnce(): Promise<RateReading> {
    const cores = this.io.cpuCount();
    const at = this.io.now();
    const prev = this.lastRate;
    if (prev != null && at - prev.at < CPU_SAMPLE_GAP_MS) {
      return {
        percent: prev.percent,
        cores,
        iowaitPercent: prev.iowaitPercent,
        readBytesPerSec: prev.readBytesPerSec,
        writeBytesPerSec: prev.writeBytesPerSec,
      };
    }
    const first = this.readRatePoint();
    if (prev == null) {
      await this.io.sleep(CPU_SAMPLE_GAP_MS);
      const next = this.readRatePoint();
      const rates = this.ratesBetween(first, next);
      this.lastRate = { times: next.times, at: next.at, proc: next.proc, disk: next.disk, percent: rates.percent, ...rates.io };
      return { percent: rates.percent, cores, ...rates.io };
    }
    const rates = this.ratesBetween(
      { times: prev.times, at: prev.at, proc: prev.proc, disk: prev.disk },
      first,
    );
    this.lastRate = { times: first.times, at: first.at, proc: first.proc, disk: first.disk, percent: rates.percent, ...rates.io };
    return { percent: rates.percent, cores, ...rates.io };
  }

  private ratesBetween(
    prev: { times: CpuTimes; at: number; proc: ProcStatTimes | null; disk: DiskIoCounters | null },
    next: { times: CpuTimes; at: number; proc: ProcStatTimes | null; disk: DiskIoCounters | null },
  ): { percent: number | null; io: Pick<RateSample, 'iowaitPercent' | 'readBytesPerSec' | 'writeBytesPerSec'> } {
    const disk = prev.disk && next.disk ? diskIoRates(prev.disk, next.disk, next.at - prev.at) : null;
    return {
      percent: cpuUsagePercent(prev.times, next.times),
      io: {
        iowaitPercent: prev.proc && next.proc ? iowaitPercent(prev.proc, next.proc) : null,
        readBytesPerSec: disk?.readBytesPerSec ?? null,
        writeBytesPerSec: disk?.writeBytesPerSec ?? null,
      },
    };
  }

  private readProcess(): HostProcessSnapshot {
    const memory = this.io.processMemory();
    const fds = this.io.fileDescriptors();
    return {
      uptimeSeconds: Math.max(0, Math.floor(this.io.processUptimeSeconds())),
      rssBytes: memory.rssBytes,
      heapUsedBytes: memory.heapUsedBytes,
      heapTotalBytes: memory.heapTotalBytes,
      eventLoopDelayMs: this.io.eventLoopDelayMs(),
      openFds: fds.open,
      fdLimit: fds.limit,
    };
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
      if (!this.io.pathExists(disk.path)) return { label: disk.label, path: disk.path, parsed: null, inodes: null };
      const [text, inodeText] = await Promise.all([this.io.df(disk.path), this.io.dfInodes(disk.path)]);
      return {
        label: disk.label,
        path: disk.path,
        parsed: text ? parseDf(text) : null,
        inodes: inodeText ? parseDfInodes(inodeText) : null,
      };
    }));
    return selectDisks(samples);
  }

  private async readDocker(): Promise<{ containers: HostStatusVo['containers']; disk: HostDockerDiskSnapshot }> {
    const probe = await this.io.probeDocker();
    if (!probe.ok) {
      return { containers: emptyContainers(probe.reason), disk: emptyDockerDisk(probe.reason) };
    }
    const [containers, disk] = await Promise.all([this.readContainerCounts(), this.readDockerDisk()]);
    return { containers, disk };
  }

  private async readContainerCounts() {
    try {
      return summarizeContainers(await this.io.listContainers());
    } catch {
      return emptyContainers('读取容器列表失败');
    }
  }

  private async readDockerDisk(): Promise<HostDockerDiskSnapshot> {
    try {
      const text = await this.io.dockerSystemDf();
      if (text == null) return emptyDockerDisk('读取 Docker 磁盘占用失败');
      return dockerDiskFromParsed(parseDockerSystemDf(text));
    } catch {
      return emptyDockerDisk('读取 Docker 磁盘占用失败');
    }
  }
}
