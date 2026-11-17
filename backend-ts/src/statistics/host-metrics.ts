/**
 * 主机快照的纯计算：CPU 差值、/proc/meminfo、df 输出、磁盘去重、容器计数。
 * 不读操作系统，方便单测注入文本。
 */
import type { HostContainerSnapshot, HostDiskSnapshot, HostMemorySnapshot } from '@mao/contracts';

export interface CpuTimes {
  idle: number;
  total: number;
}

export interface OsCpuTimes {
  user: number;
  nice: number;
  sys: number;
  idle: number;
  irq: number;
}

export function cpuTimesFromCpus(cpus: ReadonlyArray<{ times: OsCpuTimes }>): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** 相邻两次累计时间的利用率（0–100，一位小数）。计数器回绕或没有前进时返回 null。 */
export function cpuUsagePercent(prev: CpuTimes, next: CpuTimes): number | null {
  const total = next.total - prev.total;
  const idle = next.idle - prev.idle;
  if (!(total > 0) || !Number.isFinite(idle)) return null;
  return usagePercent(total - idle, total);
}

export function usagePercent(used: number, total: number): number {
  if (!(total > 0) || !Number.isFinite(used)) return 0;
  const pct = (used / total) * 100;
  return round1(Math.min(100, Math.max(0, pct)));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

export interface ParsedMemory {
  totalBytes: number;
  availableBytes: number;
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
}

/**
 * 解析 /proc/meminfo。优先 MemAvailable；缺失时用 MemFree + Buffers + Cached 里能读到的项。
 * 读不到 MemTotal 或任何可用量时返回 null，调用方改走 os 模块。
 */
export function parseMeminfo(text: string): ParsedMemory | null {
  const values = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^([A-Za-z]+):\s+(\d+)\s+kB\b/.exec(line.trim());
    if (!match) continue;
    values.set(match[1], Number(match[2]) * 1024);
  }
  const total = values.get('MemTotal');
  if (total == null || !(total > 0)) return null;
  const available = values.get('MemAvailable') ?? sumPresent([
    values.get('MemFree'),
    values.get('Buffers'),
    values.get('Cached'),
  ]);
  if (available == null) return null;
  const swapTotal = values.get('SwapTotal') ?? 0;
  const swapFree = values.get('SwapFree') ?? 0;
  const swap = swapTotal > 0
    ? { swapTotalBytes: swapTotal, swapUsedBytes: Math.max(0, swapTotal - swapFree) }
    : { swapTotalBytes: null, swapUsedBytes: null };
  return {
    totalBytes: total,
    availableBytes: Math.min(total, Math.max(0, available)),
    ...swap,
  };
}

function sumPresent(parts: Array<number | undefined>): number | null {
  const present = parts.filter((part): part is number => part != null);
  if (present.length === 0) return null;
  return present.reduce((sum, part) => sum + part, 0);
}

export function toMemorySnapshot(
  totalBytes: number,
  availableBytes: number,
  swapTotalBytes: number | null,
  swapUsedBytes: number | null,
): HostMemorySnapshot {
  const total = Math.max(0, totalBytes);
  const available = Math.min(total, Math.max(0, availableBytes));
  const used = total - available;
  return {
    totalBytes: total,
    availableBytes: available,
    usedBytes: used,
    usagePercent: usagePercent(used, total),
    swapTotalBytes,
    swapUsedBytes,
  };
}

export interface ParsedDisk {
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  /** df 的 Capacity 列。不用 used/total：APFS 的总块数含共享容器，那样会把快满的盘算成几乎空的。 */
  usagePercent: number;
}

/** 解析 `df -P -k` 的最后一行。块大小按 1024 字节计。挂载点可以含空格。 */
export function parseDf(output: string): ParsedDisk | null {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  const parts = lines[lines.length - 1]!.split(/\s+/);
  if (parts.length < 6) return null;
  const blocks = Number(parts[1]);
  const used = Number(parts[2]);
  const available = Number(parts[3]);
  const capacity = /^(\d+(?:\.\d+)?)%$/.exec(parts[4] ?? '');
  if (![blocks, used, available].every((n) => Number.isFinite(n) && n >= 0) || !capacity) return null;
  return {
    mount: parts.slice(5).join(' '),
    totalBytes: blocks * 1024,
    usedBytes: used * 1024,
    availableBytes: available * 1024,
    usagePercent: round1(Math.min(100, Math.max(0, Number(capacity[1])))),
  };
}

export function selectDisks(
  samples: ReadonlyArray<{ label: string; path: string; parsed: ParsedDisk | null }>,
): HostDiskSnapshot[] {
  const seen = new Set<string>();
  const disks: HostDiskSnapshot[] = [];
  for (const sample of samples) {
    if (!sample.parsed || seen.has(sample.parsed.mount)) continue;
    seen.add(sample.parsed.mount);
    disks.push({
      label: sample.label,
      path: sample.path,
      mount: sample.parsed.mount,
      totalBytes: sample.parsed.totalBytes,
      usedBytes: sample.parsed.usedBytes,
      availableBytes: sample.parsed.availableBytes,
      usagePercent: sample.parsed.usagePercent,
    });
  }
  return disks;
}

export interface HostContainerRow {
  state: 'running' | 'stopped';
  tracked: boolean;
  busy: boolean;
}

export function summarizeContainers(rows: readonly HostContainerRow[]): HostContainerSnapshot {
  let running = 0;
  let stopped = 0;
  let untracked = 0;
  let busy = 0;
  for (const row of rows) {
    if (row.state === 'running') running += 1;
    else stopped += 1;
    if (!row.tracked) untracked += 1;
    if (row.busy) busy += 1;
  }
  return {
    available: true,
    reason: null,
    running,
    stopped,
    untracked,
    busy,
    total: rows.length,
  };
}

export function emptyContainers(reason: string): HostContainerSnapshot {
  return {
    available: false,
    reason,
    running: 0,
    stopped: 0,
    untracked: 0,
    busy: 0,
    total: 0,
  };
}

export function dockerProbeFailure(err: { code?: string }): string {
  return err.code === 'ENOENT' ? '本机未安装 Docker' : '无法连接 Docker';
}
