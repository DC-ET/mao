import { describe, expect, it, vi } from 'vitest';
import type { HostStatusVo } from '@mao/contracts';
import { CPU_SAMPLE_GAP_MS, HostStatusService, hostDiskProbes, type HostIo } from './host-status.service.js';

const DF_ROOT = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/root 1000 250 700 25% /
`;
const DF_DATA = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/data 2000 1000 900 50% /data
`;

function io(overrides: Partial<HostIo> = {}): HostIo {
  return {
    hostname: () => 'mao-box',
    platform: () => 'linux',
    uptimeSeconds: () => 90,
    now: () => 1_000,
    sleep: async () => {},
    cpuTimes: () => ({ idle: 50, total: 100 }),
    cpuCount: () => 8,
    loadavg: () => [0.5, 0.4, 0.3],
    readMeminfo: () => 'MemTotal: 2000 kB\nMemAvailable: 500 kB\nSwapTotal: 0 kB\n',
    osMemory: () => ({ totalBytes: 999, freeBytes: 1 }),
    pathExists: () => true,
    df: async () => DF_ROOT,
    dfInodes: async () => null,
    readProcStat: () => null,
    readDiskstats: () => null,
    processUptimeSeconds: () => 42,
    processMemory: () => ({ rssBytes: 100, heapUsedBytes: 40, heapTotalBytes: 80 }),
    eventLoopDelayMs: () => 1.5,
    fileDescriptors: () => ({ open: 10, limit: 1024 }),
    listContainers: async () => [],
    probeDocker: async () => ({ ok: true }),
    dockerSystemDf: async () => null,
    ...overrides,
  };
}

describe('HostStatusService.snapshot', () => {
  it('首次采样会等待一个间隔，内存优先用 /proc', async () => {
    let reads = 0;
    const sleep = vi.fn(async () => {});
    const service = new HostStatusService(io({
      sleep,
      cpuTimes: () => {
        reads += 1;
        return reads === 1 ? { idle: 80, total: 100 } : { idle: 90, total: 200 };
      },
    }), [{ label: '系统盘', path: '/' }]);

    const vo = await service.snapshot();

    expect(sleep).toHaveBeenCalledWith(CPU_SAMPLE_GAP_MS);
    expect(vo.cpu).toMatchObject({ cores: 8, usagePercent: 90, load1: 0.5, load5: 0.4, load15: 0.3 });
    expect(vo.memorySource).toBe('proc');
    expect(vo.memory).toMatchObject({
      totalBytes: 2000 * 1024,
      availableBytes: 500 * 1024,
      usedBytes: 1500 * 1024,
      usagePercent: 75,
      swapTotalBytes: null,
    });
    expect(vo.disks).toHaveLength(1);
    expect(vo.containers).toMatchObject({ available: true, total: 0 });
    expect(vo).toMatchObject<Partial<HostStatusVo>>({ hostname: 'mao-box', platform: 'linux', uptimeSeconds: 90 });
  });

  it('间隔未到时复用上一次利用率，不再睡眠', async () => {
    let now = 0;
    const sleep = vi.fn(async () => { now += CPU_SAMPLE_GAP_MS; });
    let reads = 0;
    const service = new HostStatusService(io({
      now: () => now,
      sleep,
      cpuTimes: () => {
        reads += 1;
        return { idle: reads * 10, total: reads * 100 };
      },
    }), []);

    const first = await service.snapshot();
    const second = await service.snapshot();

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(reads).toBe(2);
    expect(second.cpu.usagePercent).toBe(first.cpu.usagePercent);
  });

  it('/proc 不可用时退回 os 内存，交换区为空', async () => {
    const service = new HostStatusService(io({
      readMeminfo: () => null,
      osMemory: () => ({ totalBytes: 1000, freeBytes: 400 }),
    }), []);
    const vo = await service.snapshot();
    expect(vo.memorySource).toBe('os');
    expect(vo.memory).toMatchObject({ totalBytes: 1000, availableBytes: 400, usedBytes: 600, swapTotalBytes: null });
  });

  it('同一挂载点只留系统盘，不存在的路径不调用 df', async () => {
    const df = vi.fn(async (target: string) => (target === '/' ? DF_ROOT : DF_DATA));
    const service = new HostStatusService(io({
      pathExists: (target) => target !== '/var/lib/docker',
      df,
    }), [
      { label: '系统盘', path: '/' },
      { label: '工作区', path: '/data/workspace' },
      { label: '上传目录', path: '/data/uploads' },
      { label: 'Docker 数据', path: '/var/lib/docker' },
    ]);

    const vo = await service.snapshot();

    expect(df.mock.calls.map((call) => call[0])).toEqual(['/', '/data/workspace', '/data/uploads']);
    expect(vo.disks.map((disk) => disk.label)).toEqual(['系统盘', '工作区']);
  });

  it('Docker 不可用时不读容器列表，也不查镜像占用', async () => {
    const listContainers = vi.fn(async () => [{ state: 'running' as const, tracked: true, busy: false }]);
    const dockerSystemDf = vi.fn(async () => '');
    const service = new HostStatusService(io({
      probeDocker: async () => ({ ok: false, reason: '本机未安装 Docker' }),
      listContainers,
      dockerSystemDf,
    }), []);
    const vo = await service.snapshot();
    expect(listContainers).not.toHaveBeenCalled();
    expect(dockerSystemDf).not.toHaveBeenCalled();
    expect(vo.containers).toMatchObject({ available: false, reason: '本机未安装 Docker', total: 0, running: 0 });
    expect(vo.dockerDisk).toMatchObject({ available: false, reason: '本机未安装 Docker', imagesBytes: null });
  });

  it('容器列表失败时降级，其它指标仍在', async () => {
    const service = new HostStatusService(io({
      listContainers: async () => { throw new Error('docker ps failed'); },
    }), []);
    const vo = await service.snapshot();
    expect(vo.containers).toMatchObject({ available: false, reason: '读取容器列表失败' });
    expect(vo.cpu.cores).toBe(8);
  });

  it('Docker 可用时汇总容器', async () => {
    const service = new HostStatusService(io({
      listContainers: async () => [
        { state: 'running', tracked: true, busy: true },
        { state: 'stopped', tracked: false, busy: false },
      ],
    }), []);
    const vo = await service.snapshot();
    expect(vo.containers).toMatchObject({ available: true, running: 1, stopped: 1, untracked: 1, busy: 1, total: 2 });
  });

  it('附上进程、inode，以及间隔内的 iowait 和磁盘读写', async () => {
    let now = 0;
    let step = 0;
    const service = new HostStatusService(io({
      now: () => now,
      sleep: async () => { now += 1000; },
      dfInodes: async () => `Filesystem Inodes IUsed IFree IUse% Mounted on
/dev/root 1000 400 600 40% /
`,
      readProcStat: () => (step === 0
        ? 'cpu  100 0 100 700 100 0 0 0\ncpu0 1 0 1 1 1 0 0 0\n'
        : 'cpu  200 0 200 1400 200 0 0 0\n'),
      readDiskstats: () => {
        const text = step === 0
          ? ' 8 0 sda 0 0 2000 0 0 0 800 0\n 8 1 sda1 0 0 99999 0 0 0 99999 0\n'
          : ' 8 0 sda 0 0 4000 0 0 0 1800 0\n 8 1 sda1 0 0 99999 0 0 0 99999 0\n';
        step += 1;
        return text;
      },
      dockerSystemDf: async () => 'Images\t1.5GB\t500MB (33%)\nLocal Volumes\t100kB\t0B (0%)\nBuild Cache\t2MB\t2MB\n',
    }), [{ label: '系统盘', path: '/' }]);

    const vo = await service.snapshot();

    expect(vo.cpu.iowaitPercent).toBe(10);
    expect(vo.diskIo).toEqual({ readBytesPerSec: 2000 * 512, writeBytesPerSec: 1000 * 512 });
    expect(vo.disks[0]).toMatchObject({ inodeTotal: 1000, inodeUsed: 400, inodeUsagePercent: 40 });
    expect(vo.process).toMatchObject({ uptimeSeconds: 42, rssBytes: 100, heapUsedBytes: 40, eventLoopDelayMs: 1.5, openFds: 10, fdLimit: 1024 });
    expect(vo.dockerDisk).toMatchObject({
      available: true,
      imagesBytes: 1_500_000_000,
      imagesReclaimableBytes: 500_000_000,
      volumesBytes: 100_000,
      buildCacheBytes: 2_000_000,
    });
  });
});

describe('HostStatusService.trend', () => {
  it('只采样 CPU 和内存，不读磁盘也不查 Docker', async () => {
    const df = vi.fn(async () => DF_ROOT);
    const probeDocker = vi.fn(async () => ({ ok: true as const }));
    const service = new HostStatusService(io({ df, probeDocker }), [{ label: '系统盘', path: '/' }]);

    const sample = await service.trend();

    expect(df).not.toHaveBeenCalled();
    expect(probeDocker).not.toHaveBeenCalled();
    expect(sample.sampledAt).toBe(1_000);
    expect(sample.memorySource).toBe('proc');
    expect(sample.memory.usagePercent).toBe(75);
    expect(sample.cpu).toMatchObject({ cores: 8, usagePercent: null, load1: 0.5 });
  });
});

// 磁盘探针路径按部署主机（Linux）语义断言：Windows 上 path.resolve 产出盘符反斜杠路径，
// 属于运行平台的合理行为，用例仅在 POSIX 平台跑。
describe.skipIf(process.platform === 'win32')('hostDiskProbes', () => {
  it('系统盘在前，数据目录按配置解析，Docker 数据用默认路径', () => {
    const probes = hostDiskProbes({
      workspaceRoot: 'workspace',
      uploadDir: '/opt/mao-data/uploads',
      runtimeDir: '/opt/mao-data/runtime',
      userHomeDir: '/opt/mao-data/users',
    });
    expect(probes.map((probe) => probe.label)).toEqual(['系统盘', '工作区', '上传目录', '运行时目录', '用户目录', 'Docker 数据']);
    expect(probes[0]!.path).toBe('/');
    expect(probes[1]!.path.endsWith('/workspace')).toBe(true);
    expect(probes[5]!.path).toBe('/var/lib/docker');
  });
});
