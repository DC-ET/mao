/**
 * 管理后台统计域 VO（@mao/contracts 的 statistics.ts 模块）。
 *
 * 消费方：backend-ts/src/statistics/、admin/src/views/statistics/。
 * 本模块零运行时，仅类型。
 */
import type { WsClientType } from './ws';

/** 连接自报设备信息（仅 electron / cli 携带；android / browser / embed 为 null）。 */
export interface OnlineDeviceDeviceInfo {
  id: string;
  name: string;
  platform: string;
}

/** 单条在线 WS 连接快照（GET /v1/statistics/online-devices）。 */
export interface OnlineDeviceConnection {
  wsSessionId: string;
  clientType: WsClientType;
  /** 连接建立时间，epoch ms；前端据此计算连接时长 */
  connectedAt: number;
  /** 认证到期时间（JWT exp），epoch ms；连接无认证元数据时为 null */
  authExpiresAt: number | null;
  /** 认证来源；company_sso 有值，本地登录为 null */
  authSource: string | null;
  device: OnlineDeviceDeviceInfo | null;
}

/** GET /v1/statistics/online-devices 响应 data。 */
export interface OnlineDevicesVo {
  /** connections=全量 WS 连接数；users=去重在线用户数；devices=去重设备数（electron/cli 按 (userId, deviceId) 去重 + android 逐条计数，browser/embed 不计入） */
  total: { connections: number; users: number; devices: number };
  /** 按客户端类型分组的连接数（键类型吃 WsClientType 联合扩张，漏类编译期即失败） */
  byClientType: Record<WsClientType, number>;
  users: Array<{
    userId: number;
    username: string;
    displayName: string | null;
    connections: OnlineDeviceConnection[];
  }>;
}

/** CPU 快照（GET /v1/statistics/host）。usagePercent 为相邻两次采样的利用率；首次尚无差值时为 null。 */
export interface HostCpuSnapshot {
  cores: number;
  usagePercent: number | null;
  /** 采样间隔内花在等待磁盘上的时间占比。读不到 /proc/stat 时为 null */
  iowaitPercent: number | null;
  /** 1 / 5 / 15 分钟负载 */
  load1: number;
  load5: number;
  load15: number;
}

/** 内存快照。proc 来源的 available 是 MemAvailable；os 来源是操作系统报告的空闲内存。 */
export interface HostMemorySnapshot {
  totalBytes: number;
  availableBytes: number;
  usedBytes: number;
  /** 0–100，一位小数 */
  usagePercent: number;
  /** 无交换区时为 null */
  swapTotalBytes: number | null;
  swapUsedBytes: number | null;
}

/** 一块已挂载磁盘。同一挂载点只出现一次。 */
export interface HostDiskSnapshot {
  /** 系统盘 / 工作区 / 上传目录 / 运行时目录 / 用户目录 / Docker 数据 */
  label: string;
  /** 采样路径 */
  path: string;
  /** df 报告的挂载点 */
  mount: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
  /** inode 读不到时为 null（部分文件系统不提供） */
  inodeTotal: number | null;
  inodeUsed: number | null;
  inodeUsagePercent: number | null;
}

/** 整机磁盘吞吐（整盘合计，不含分区，避免和整盘重复计算）。读不到 /proc/diskstats 时为 null。 */
export interface HostDiskIoSnapshot {
  readBytesPerSec: number | null;
  writeBytesPerSec: number | null;
}

/** 后端进程自身。文件描述符在非 Linux 上可能为 null。 */
export interface HostProcessSnapshot {
  /** 进程已运行秒数，不是开机时长 */
  uptimeSeconds: number;
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  /** 距上次采样的事件循环平均延迟（毫秒）。还没有采样时为 null */
  eventLoopDelayMs: number | null;
  openFds: number | null;
  /** 软上限。unlimited 或读不到时为 null */
  fdLimit: number | null;
}

/**
 * Docker 镜像 / 卷 / 构建缓存占用的磁盘。
 * available=false 时各字节字段为 null，不表示占用是 0。
 */
export interface HostDockerDiskSnapshot {
  available: boolean;
  reason: string | null;
  imagesBytes: number | null;
  imagesReclaimableBytes: number | null;
  volumesBytes: number | null;
  volumesReclaimableBytes: number | null;
  buildCacheBytes: number | null;
  buildCacheReclaimableBytes: number | null;
}

/**
 * mao 运行时容器计数。
 * running / stopped / untracked / busy 在 available=false 时均为 0，不表示「没有容器」。
 * untracked、busy 是 total 的子集，不是额外的容器。
 */
export interface HostContainerSnapshot {
  available: boolean;
  /** available=false 时的原因；否则为 null */
  reason: string | null;
  running: number;
  stopped: number;
  untracked: number;
  busy: number;
  total: number;
}

/**
 * GET /v1/statistics/host/trend 的一个采样点。
 * 只含 CPU 与内存，给页面折线用；序列不落库，由打开页面的浏览器自己保留。
 */
export interface HostTrendSample {
  /** 采集时刻，epoch ms */
  sampledAt: number;
  memorySource: 'proc' | 'os';
  cpu: HostCpuSnapshot;
  memory: HostMemorySnapshot;
}

/**
 * GET /v1/statistics/host 响应 data。
 * 只描述后端进程所在的这一台机器，不含远程数据库。无历史序列。
 * memorySource=proc 表示读到了 /proc/meminfo，os 表示退回 Node os 模块。
 */
export interface HostStatusVo {
  hostname: string;
  platform: string;
  /** 系统已运行秒数（开机时长，不是后端进程时长） */
  uptimeSeconds: number;
  /** 采集时刻，epoch ms */
  sampledAt: number;
  memorySource: 'proc' | 'os';
  cpu: HostCpuSnapshot;
  memory: HostMemorySnapshot;
  disks: HostDiskSnapshot[];
  /** 整机磁盘读写速率，与上面按挂载点拆开的容量无关 */
  diskIo: HostDiskIoSnapshot;
  process: HostProcessSnapshot;
  containers: HostContainerSnapshot;
  dockerDisk: HostDockerDiskSnapshot;
}
