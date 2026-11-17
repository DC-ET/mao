/**
 * 主机快照的纯计算：CPU 差值、/proc/meminfo、df 输出、磁盘去重、容器计数。
 * 不读操作系统，方便单测注入文本。
 */
import type { HostContainerSnapshot, HostDiskSnapshot, HostDockerDiskSnapshot, HostMemorySnapshot } from '@mao/contracts';

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

export interface ParsedInodes {
  mount: string;
  total: number | null;
  used: number | null;
  usagePercent: number | null;
}

/**
 * 解析 `df -P -i`。
 * Linux 用 Inodes/IUse% 列；macOS 在容量列后面追加 iused/ifree/%iused，两套都认。
 */
export function parseDfInodes(output: string): ParsedInodes | null {
  const lines = output.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length < 2) return null;
  const header = lines[0]!;
  const parts = lines[lines.length - 1]!.split(/\s+/);
  if (/%iused/i.test(header)) {
    if (parts.length < 9) return null;
    const used = parseCount(parts[5]);
    const free = parseCount(parts[6]);
    return {
      mount: parts.slice(8).join(' '),
      used,
      total: used != null && free != null ? used + free : null,
      usagePercent: parsePct(parts[7]),
    };
  }
  if (/\bInodes\b/.test(header) || /IUse%/.test(header)) {
    if (parts.length < 6) return null;
    return {
      mount: parts.slice(5).join(' '),
      total: parseCount(parts[1]),
      used: parseCount(parts[2]),
      usagePercent: parsePct(parts[4]),
    };
  }
  return null;
}

function parseCount(raw: string | undefined): number | null {
  if (raw == null || raw === '-') return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function parsePct(raw: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(raw ?? '');
  if (!match) return null;
  return round1(Math.min(100, Math.max(0, Number(match[1]))));
}

export function selectDisks(
  samples: ReadonlyArray<{ label: string; path: string; parsed: ParsedDisk | null; inodes?: ParsedInodes | null }>,
): HostDiskSnapshot[] {
  const seen = new Set<string>();
  const disks: HostDiskSnapshot[] = [];
  for (const sample of samples) {
    if (!sample.parsed || seen.has(sample.parsed.mount)) continue;
    seen.add(sample.parsed.mount);
    const inodes = sample.inodes ?? null;
    disks.push({
      label: sample.label,
      path: sample.path,
      mount: sample.parsed.mount,
      totalBytes: sample.parsed.totalBytes,
      usedBytes: sample.parsed.usedBytes,
      availableBytes: sample.parsed.availableBytes,
      usagePercent: sample.parsed.usagePercent,
      inodeTotal: inodes?.total ?? null,
      inodeUsed: inodes?.used ?? null,
      inodeUsagePercent: inodes?.usagePercent ?? null,
    });
  }
  return disks;
}

export interface ProcStatTimes {
  iowait: number;
  total: number;
}

/** 聚合行 `cpu `（不含 cpu0）。guest 已含在 user 里，不重复加。 */
export function parseProcStat(text: string): ProcStatTimes | null {
  const line = text.split('\n').find((item) => /^cpu\s+/.test(item));
  if (!line) return null;
  const parts = line.trim().split(/\s+/).slice(1).map(Number);
  if (parts.length < 5 || parts.some((value) => !Number.isFinite(value))) return null;
  const user = parts[0] ?? 0;
  const nice = parts[1] ?? 0;
  const system = parts[2] ?? 0;
  const idle = parts[3] ?? 0;
  const iowait = parts[4] ?? 0;
  const irq = parts[5] ?? 0;
  const softirq = parts[6] ?? 0;
  const steal = parts[7] ?? 0;
  return { iowait, total: user + nice + system + idle + iowait + irq + softirq + steal };
}

export function iowaitPercent(prev: ProcStatTimes, next: ProcStatTimes): number | null {
  const total = next.total - prev.total;
  const wait = next.iowait - prev.iowait;
  if (!(total > 0) || !Number.isFinite(wait)) return null;
  return usagePercent(wait, total);
}

export interface DiskIoCounters {
  sectorsRead: number;
  sectorsWritten: number;
}

/** 只加整盘（sda、nvme0n1），不加 sda1 / nvme0n1p1，避免和整盘重复。扇区按 512 字节。 */
const WHOLE_DISK = /^(?:sd[a-z]+|vd[a-z]+|xvd[a-z]+|hd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/;

export function parseDiskstats(text: string): DiskIoCounters {
  let sectorsRead = 0;
  let sectorsWritten = 0;
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10 || !WHOLE_DISK.test(parts[2] ?? '')) continue;
    const read = Number(parts[5]);
    const written = Number(parts[9]);
    if (Number.isFinite(read)) sectorsRead += read;
    if (Number.isFinite(written)) sectorsWritten += written;
  }
  return { sectorsRead, sectorsWritten };
}

export function diskIoRates(
  prev: DiskIoCounters,
  next: DiskIoCounters,
  elapsedMs: number,
): { readBytesPerSec: number; writeBytesPerSec: number } | null {
  if (!(elapsedMs > 0)) return null;
  const seconds = elapsedMs / 1000;
  return {
    readBytesPerSec: Math.round(Math.max(0, next.sectorsRead - prev.sectorsRead) * 512 / seconds),
    writeBytesPerSec: Math.round(Math.max(0, next.sectorsWritten - prev.sectorsWritten) * 512 / seconds),
  };
}

const DOCKER_SIZE_SCALE: Record<string, number> = {
  B: 1,
  kB: 1000,
  KB: 1000,
  MB: 1000 ** 2,
  GB: 1000 ** 3,
  TB: 1000 ** 4,
  KiB: 1024,
  MiB: 1024 ** 2,
  GiB: 1024 ** 3,
  TiB: 1024 ** 4,
};

/** Docker `units.HumanSize`：`1.5kB`、`2GB`，可回收列可能带 ` (20%)`。 */
export function parseDockerSize(raw: string): number | null {
  const text = raw.trim().replace(/\s*\([^)]*\)\s*$/, '').replace(/\s/g, '');
  if (!text) return null;
  const match = /^([\d.]+)([a-zA-Z]+)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  const scale = DOCKER_SIZE_SCALE[match[2] ?? ''];
  if (!Number.isFinite(value) || scale == null) return null;
  return Math.round(value * scale);
}

export interface ParsedDockerDisk {
  recognized: boolean;
  imagesBytes: number | null;
  imagesReclaimableBytes: number | null;
  volumesBytes: number | null;
  volumesReclaimableBytes: number | null;
  buildCacheBytes: number | null;
  buildCacheReclaimableBytes: number | null;
}

/** `docker system df --format '{{.Type}}\t{{.Size}}\t{{.Reclaimable}}'`。 */
export function parseDockerSystemDf(text: string): ParsedDockerDisk {
  const parsed: ParsedDockerDisk = {
    recognized: false,
    imagesBytes: null,
    imagesReclaimableBytes: null,
    volumesBytes: null,
    volumesReclaimableBytes: null,
    buildCacheBytes: null,
    buildCacheReclaimableBytes: null,
  };
  for (const line of text.split('\n')) {
    const [typeRaw, sizeRaw, reclaimRaw] = line.trim().split('\t');
    if (!typeRaw || sizeRaw == null) continue;
    const size = parseDockerSize(sizeRaw);
    if (size == null) continue;
    const reclaim = reclaimRaw != null ? parseDockerSize(reclaimRaw) : null;
    const type = typeRaw.toLowerCase();
    if (type === 'images') {
      parsed.imagesBytes = size;
      parsed.imagesReclaimableBytes = reclaim;
      parsed.recognized = true;
    } else if (type === 'local volumes' || type === 'volumes') {
      parsed.volumesBytes = size;
      parsed.volumesReclaimableBytes = reclaim;
      parsed.recognized = true;
    } else if (type === 'build cache') {
      parsed.buildCacheBytes = size;
      parsed.buildCacheReclaimableBytes = reclaim;
      parsed.recognized = true;
    }
  }
  return parsed;
}

/** `/proc/self/limits` 里 Max open files 的软上限。unlimited 视为读不到。 */
export function parseFdLimit(text: string): number | null {
  for (const line of text.split('\n')) {
    if (!line.startsWith('Max open files')) continue;
    const soft = line.trim().split(/\s+/)[3];
    if (soft == null || soft === 'unlimited') return null;
    const value = Number(soft);
    return Number.isFinite(value) && value > 0 ? value : null;
  }
  return null;
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

export function emptyDockerDisk(reason: string): HostDockerDiskSnapshot {
  return {
    available: false,
    reason,
    imagesBytes: null,
    imagesReclaimableBytes: null,
    volumesBytes: null,
    volumesReclaimableBytes: null,
    buildCacheBytes: null,
    buildCacheReclaimableBytes: null,
  };
}

export function dockerDiskFromParsed(parsed: ParsedDockerDisk): HostDockerDiskSnapshot {
  if (!parsed.recognized) return emptyDockerDisk('读取 Docker 磁盘占用失败');
  return {
    available: true,
    reason: null,
    imagesBytes: parsed.imagesBytes,
    imagesReclaimableBytes: parsed.imagesReclaimableBytes,
    volumesBytes: parsed.volumesBytes,
    volumesReclaimableBytes: parsed.volumesReclaimableBytes,
    buildCacheBytes: parsed.buildCacheBytes,
    buildCacheReclaimableBytes: parsed.buildCacheReclaimableBytes,
  };
}
