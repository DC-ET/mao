import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 稳定设备身份（技术方案 2026-11-05 §4.2）：mao-agent 作为 LOCAL 任务的执行端，
 * 需要跨会话、跨进程稳定的 deviceId（后端按设备定向投递工具请求）。
 *
 * 与 config.json 分开落盘（`~/.mao/agent-cli/device.json`）：配置文件会被用户/程序
 * 整体读写，混在一起容易被覆盖；独立性也便于用户删除后重新登记为新设备。
 */
export const DEVICE_FILE = path.join(os.homedir(), '.mao', 'agent-cli', 'device.json');

/** 与后端校验白名单一致：长度 ≤64，仅字母 / 数字 / 下划线 / 连字符（UUID 天然满足）。 */
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface DeviceIdentity {
  id: string;
  /** 主机名，服务端仅用于展示（创建会话时做快照） */
  name: string;
  /** process.platform：darwin / win32 / linux */
  platform: string;
}

function readDeviceId(file: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as { id?: unknown };
    if (typeof raw.id !== 'string') return null;
    const id = raw.id.trim();
    return DEVICE_ID_PATTERN.test(id) ? id : null;
  } catch {
    return null;
  }
}

function writeDeviceId(file: string, id: string): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ id }, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // 写盘失败不阻断运行：本次进程使用内存值，下次启动再尝试补齐
  }
}

/** 设备名快照上限与后端 `target_device_name` 列宽一致（128）。 */
function resolveDeviceName(): string {
  const hostname = os.hostname().trim();
  const name = hostname === '' ? 'mao-agent' : hostname;
  return name.length > 128 ? name.slice(0, 128) : name;
}

/**
 * 进程内缓存（按落盘路径）：`resolveDeviceIdentity` 会被每次 WS 连接（含重连）调用，
 * 写盘失败时也必须复用同一个 id，否则同机每次重连都变成「新设备」，
 * 已绑定的 LOCAL 会话（不可改绑）立即不可用。缓存键用路径，便于测试隔离。
 */
const identityCache = new Map<string, DeviceIdentity>();

/**
 * 读取本机设备身份：deviceId 缺失 / 脏值时本机生成并写回；
 * 名字与平台取当前进程值（node 无自定义命名能力，技术方案明确不做改名）。
 */
export function resolveDeviceIdentity(file: string = DEVICE_FILE): DeviceIdentity {
  const cached = identityCache.get(file);
  if (cached != null) return cached;
  let id = readDeviceId(file);
  if (id == null) {
    id = crypto.randomUUID();
    writeDeviceId(file, id);
  }
  const identity: DeviceIdentity = { id, name: resolveDeviceName(), platform: process.platform };
  identityCache.set(file, identity);
  return identity;
}
