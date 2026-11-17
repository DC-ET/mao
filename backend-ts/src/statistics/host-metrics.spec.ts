import { describe, expect, it } from 'vitest';
import {
  cpuTimesFromCpus,
  cpuUsagePercent,
  diskIoRates,
  dockerProbeFailure,
  iowaitPercent,
  parseDf,
  parseDfInodes,
  parseDiskstats,
  parseDockerSize,
  parseDockerSystemDf,
  parseFdLimit,
  parseMeminfo,
  parseProcStat,
  selectDisks,
  summarizeContainers,
  usagePercent,
} from './host-metrics.js';

const cpu = (idle: number, busy: number) => ({
  times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
});

describe('cpuUsagePercent', () => {
  it('按空闲时间差值计算利用率', () => {
    const prev = cpuTimesFromCpus([cpu(100, 100), cpu(100, 100)]);
    const next = cpuTimesFromCpus([cpu(150, 150), cpu(150, 150)]);
    expect(cpuUsagePercent(prev, next)).toBe(50);
  });

  it('计数器没有前进时返回 null', () => {
    const times = cpuTimesFromCpus([cpu(10, 10)]);
    expect(cpuUsagePercent(times, times)).toBeNull();
  });

  it('空闲超过总时间时钳到 0', () => {
    expect(cpuUsagePercent({ idle: 0, total: 10 }, { idle: 20, total: 20 })).toBe(0);
  });
});

describe('parseMeminfo', () => {
  it('优先 MemAvailable，并换算交换区', () => {
    const parsed = parseMeminfo(`
MemTotal:       2000 kB
MemFree:         100 kB
MemAvailable:    800 kB
Buffers:          50 kB
Cached:          200 kB
SwapTotal:      1000 kB
SwapFree:        250 kB
`);
    expect(parsed).toEqual({
      totalBytes: 2000 * 1024,
      availableBytes: 800 * 1024,
      swapTotalBytes: 1000 * 1024,
      swapUsedBytes: 750 * 1024,
    });
  });

  it('没有 MemAvailable 时退回 MemFree + Buffers + Cached', () => {
    const parsed = parseMeminfo('MemTotal: 1000 kB\nMemFree: 100 kB\nBuffers: 50 kB\nCached: 50 kB\n');
    expect(parsed?.availableBytes).toBe(200 * 1024);
    expect(parsed?.swapTotalBytes).toBeNull();
  });

  it('没有可用量时返回 null', () => {
    expect(parseMeminfo('MemTotal: 1000 kB\n')).toBeNull();
    expect(parseMeminfo('garbage')).toBeNull();
  });
});

describe('parseDf / selectDisks', () => {
  it('解析 df -P -k，挂载点可以含空格', () => {
    const parsed = parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s5 1000 400 500 40% /System/Volumes/Data
`);
    expect(parsed).toEqual({
      mount: '/System/Volumes/Data',
      totalBytes: 1000 * 1024,
      usedBytes: 400 * 1024,
      availableBytes: 500 * 1024,
      usagePercent: 40,
    });
  });

  it('使用率取 Capacity，不用已用除以总块数', () => {
    const parsed = parseDf(`Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/disk3s1s1 1000 100 150 39% /
`);
    expect(parsed?.usagePercent).toBe(39);
  });

  it('坏行返回 null', () => {
    expect(parseDf('Filesystem\nbroken')).toBeNull();
    expect(parseDf('')).toBeNull();
  });

  it('同一挂载点只保留先出现的项', () => {
    const root = parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 1000 250 700 25% /\n');
    const data = parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/data 2000 1000 900 50% /data\n');
    const disks = selectDisks([
      { label: '系统盘', path: '/', parsed: root },
      { label: '工作区', path: '/data/workspace', parsed: data },
      { label: '上传目录', path: '/data/uploads', parsed: data },
      { label: '缺失', path: '/missing', parsed: null },
    ]);
    expect(disks.map((disk) => disk.label)).toEqual(['系统盘', '工作区']);
    expect(disks[0]).toMatchObject({ mount: '/', usagePercent: 25 });
    expect(disks[1]).toMatchObject({ mount: '/data', path: '/data/workspace', usagePercent: 50 });
  });
});

describe('summarizeContainers', () => {
  it('运行中、已停止、未在册、有任务分开计，未在册和有任务是子集', () => {
    const summary = summarizeContainers([
      { state: 'running', tracked: true, busy: true },
      { state: 'running', tracked: true, busy: false },
      { state: 'stopped', tracked: false, busy: false },
    ]);
    expect(summary).toMatchObject({
      available: true,
      reason: null,
      running: 2,
      stopped: 1,
      untracked: 1,
      busy: 1,
      total: 3,
    });
  });
});

describe('inode、iowait、磁盘读写、Docker 占用', () => {
  it('Linux 与 macOS 的 df -i 都能取出 inode 使用率', () => {
    const linux = parseDfInodes(`Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/sda1 1000 250 750 25% /data
`);
    expect(linux).toMatchObject({ mount: '/data', total: 1000, used: 250, usagePercent: 25 });

    const mac = parseDfInodes(`Filesystem 512-blocks Used Available Capacity iused ifree %iused Mounted on
/dev/disk3s1s1 965595304 24686304 40265616 39% 458732 201328080 12% /System/Volumes/Data
`);
    expect(mac).toMatchObject({
      mount: '/System/Volumes/Data',
      used: 458732,
      total: 458732 + 201328080,
      usagePercent: 12,
    });
  });

  it('iowait 用聚合 cpu 行，磁盘读写跳过分区', () => {
    const prev = parseProcStat('cpu  100 0 100 700 100 0 0 0\ncpu0 9 9 9 9 9 0 0 0\n');
    const next = parseProcStat('cpu  200 0 200 1400 200 0 0 0\n');
    expect(prev && next && iowaitPercent(prev, next)).toBe(10);

    const before = parseDiskstats(' 8 0 sda 0 0 100 0 0 0 50 0\n 8 1 sda1 0 0 999 0 0 0 999 0\n');
    const after = parseDiskstats(' 8 0 sda 0 0 200 0 0 0 50 0\n 8 1 sda1 0 0 999 0 0 0 999 0\n');
    expect(diskIoRates(before, after, 1000)).toEqual({ readBytesPerSec: 100 * 512, writeBytesPerSec: 0 });
  });

  it('解析 Docker 容量，认不出类型时不算成功', () => {
    expect(parseDockerSize('1.5GB')).toBe(1_500_000_000);
    expect(parseDockerSize('500MB (33%)')).toBe(500_000_000);
    expect(parseDockerSize('0B')).toBe(0);
    const parsed = parseDockerSystemDf('Images\t2kB\t1kB (50%)\nContainers\t9B\t0B\n');
    expect(parsed.recognized).toBe(true);
    expect(parsed.imagesBytes).toBe(2000);
    expect(parseDockerSystemDf('Containers\t9B\t0B\n').recognized).toBe(false);
  });

  it('文件描述符软上限', () => {
    const text = 'Max open files            1024                 1048576              files\n';
    expect(parseFdLimit(text)).toBe(1024);
    expect(parseFdLimit('Max open files            unlimited            unlimited            files\n')).toBeNull();
  });
});

describe('usagePercent / dockerProbeFailure', () => {
  it('总量为 0 时利用率是 0', () => {
    expect(usagePercent(1, 0)).toBe(0);
  });

  it('找不到 docker 与连不上分开表述', () => {
    expect(dockerProbeFailure({ code: 'ENOENT' })).toBe('本机未安装 Docker');
    expect(dockerProbeFailure({ code: 'ETIMEDOUT' })).toBe('无法连接 Docker');
  });
});
