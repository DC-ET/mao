import { promises as dns } from 'node:dns';

/**
 * SSRF 防护：拒绝指向私网/环回/链路本地/组播/保留地址段的主机名。
 * 单一来源（原 weixin/qr-login.service.ts 内私有实现，信号哨兵探针校验复用同一口径）。
 * 覆盖 IPv4 字面量全部 RFC1918/环回/链路本地/0.x/255.x/组播保留段，以及
 * localhost / .localhost / IPv6 字面量 / .local / .internal。
 */
export function isPrivateOrReservedHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  // IPv4 / IPv6 字面量
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname);
  if (v4) {
    const parts = hostname.split('.').map(Number);
    return isPrivateOrReservedIpv4(parts[0]!, parts[1]!, parts[2]!, parts[3]!);
  }
  if (hostname.includes(':')) return true; // IPv6：保守拒绝字面量
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}

function isPrivateOrReservedIpv4(a: number, b: number, c: number, d: number): boolean {
  const ip = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true; // 私网
  if (a === 127) return true; // 环回
  if (a === 169 && b === 254) return true; // 链路本地
  if (ip >= 0x0A000000 && ip <= 0x0AFFFFFF) return true;
  if (ip <= 0x00FFFFFF || ip >= 0xFFFFFFFF - 0xFF) return true; // 0.x 与 255.x
  if (a >= 224) return true; // 组播/保留
  return false;
}

/** IPv4 字面量 → uint32；非法（含 IPv6 / 越界段）返回 null。 */
export function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    nums.push(n);
  }
  return (((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0);
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const lower = ip.replace(/^\[|\]$/g, '').toLowerCase();
  if (lower === '::' || lower === '::1') return true; // 未指定 / 环回
  // IPv4-mapped（::ffff:a.b.c.d）按内嵌 IPv4 判定
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4 = ipv4ToUint32(mapped[1]!);
    if (v4 == null) return true;
    const a = (v4 >>> 24) & 0xff, b = (v4 >>> 16) & 0xff, c = (v4 >>> 8) & 0xff, d = v4 & 0xff;
    return isPrivateOrReservedIpv4(a, b, c, d);
  }
  // 链路本地 fe80::/10（fe80~febf 前缀）、ULA fc00::/7（fc/fd）、组播 ff00::/8
  if (/^fe[89ab]/.test(lower)) return true;
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('ff')) return true;
  return false;
}

/**
 * IP 级私网/保留判定（执行内核对解析结果使用；主机名级判定仍是
 * isPrivateOrReservedHostname，两者互补：主机名判字面量、IP 判解析结果）。
 */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v4 = ipv4ToUint32(ip);
  if (v4 != null) {
    return isPrivateOrReservedIpv4((v4 >>> 24) & 0xff, (v4 >>> 16) & 0xff, (v4 >>> 8) & 0xff, v4 & 0xff);
  }
  return isPrivateOrReservedIpv6(ip);
}

/** 环回 127.0.0.0/8（IPv4）或 ::1（IPv6）——任何形态下永拒，不放行。 */
export function isLoopbackIp(ip: string): boolean {
  const v4 = ipv4ToUint32(ip);
  if (v4 != null) return (v4 >>> 24) === 127;
  return ip.replace(/^\[|\]$/g, '').toLowerCase() === '::1';
}

/** 云元数据端点 IP（169.254.169.254）——任何形态下永拒，不放行。 */
export function isCloudMetadataIp(ip: string): boolean {
  return ip.trim() === '169.254.169.254';
}

/** 云元数据端点主机名（含常见云厂商别名；字面量 IP 由 isCloudMetadataIp 覆盖）。 */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === '169.254.169.254'
    || host === 'metadata.google.internal'
    || host === 'metadata.goog';
}

/** CIDR 字面量合法性：IPv4 + 可选 /0~32 前缀（裸 IPv4 合法，按 /32 处理）。 */
export function isValidCidr(value: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d{1,2}))?$/.exec(value.trim());
  if (match == null) return false;
  for (let i = 1; i <= 4; i++) {
    if (Number(match[i]) > 255) return false;
  }
  const prefix = match[5] == null ? 32 : Number(match[5]);
  return Number.isInteger(prefix) && prefix >= 0 && prefix <= 32;
}

/** 系统设置里的 CIDR JSON 数组 → 合法 CIDR 列表（非法输入整体按空数组处理，失败即拒绝）。 */
export function parseCidrList(raw: string | null | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const result: string[] = [];
  for (const item of parsed) {
    if (typeof item !== 'string') continue;
    const value = item.trim();
    if (!isValidCidr(value)) continue;
    result.push(value.includes('/') ? value : `${value}/32`);
  }
  return result;
}

/** IPv4 前缀 → 掩码（uint32）。 */
function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : prefix === 32 ? 0xFFFFFFFF : (~((1 << (32 - prefix)) - 1)) >>> 0;
}

/** IPv4 是否落在 CIDR 内（CIDR 非法 / 非 IPv4 返回 false）。 */
export function ipv4InCidr(ip: string, cidr: string): boolean {
  const [range, prefixRaw] = cidr.split('/');
  const ipValue = ipv4ToUint32(ip);
  const rangeValue = ipv4ToUint32((range ?? '').trim());
  if (ipValue == null || rangeValue == null) return false;
  const prefix = prefixRaw == null || prefixRaw === '' ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  return (ipValue & prefixMask(prefix)) === (rangeValue & prefixMask(prefix));
}

/**
 * 已解析 IP 列表是否「全部」命中 CIDR 放行名单。
 * 必须全命中而非任一命中：主机名可能解析出多个地址，fetch 实际连哪个由运行时
 * 择优决定，只放行命中项会让请求落到管理员未批准的网段（设计 §5.5 判定口径）。
 */
export function areIpsInCidrAllowlist(ips: readonly string[], cidrs: readonly string[]): boolean {
  if (cidrs.length === 0 || ips.length === 0) return false;
  for (const ip of ips) {
    if (!cidrs.some((cidr) => ipv4InCidr(ip, cidr))) return false;
  }
  return true;
}

/** 执行内核永不放行的网段（环回 + 云元数据）：放行名单不得与它们相交。 */
const HARD_DENY_NETS: readonly { net: number; prefix: number }[] = [
  { net: ipv4ToUint32('127.0.0.0')!, prefix: 8 },
  { net: ipv4ToUint32('169.254.169.254')!, prefix: 32 },
];

/** 两个 CIDR 是否相交（CIDR 之间只可能嵌套或不相交，双向包含即判相交）。 */
function cidrIntersects(aNet: number, aPrefix: number, bNet: number, bPrefix: number): boolean {
  return (aNet & prefixMask(bPrefix)) === (bNet & prefixMask(bPrefix))
    || (bNet & prefixMask(aPrefix)) === (aNet & prefixMask(aPrefix));
}

/**
 * CIDR 是否与硬拒网段相交（含被硬拒网段包含，如 127.0.0.1/32、169.254.0.0/16）。
 * 供放行名单保存前校验，避免「配了但静默无效」；执行内核另有硬拒兜底。
 */
export function cidrOverlapsHardDeniedNet(cidr: string): boolean {
  const [range, prefixRaw] = cidr.split('/');
  const net = ipv4ToUint32((range ?? '').trim());
  if (net == null) return false;
  const prefix = prefixRaw == null || prefixRaw === '' ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  return HARD_DENY_NETS.some((deny) => cidrIntersects(net, prefix, deny.net, deny.prefix));
}

/** 主机名解析为 IP 列表（字面量直接返回；DNS 失败返回空数组——调用方按拒绝处理）。 */
export async function resolveHostIps(hostname: string): Promise<string[]> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  if (ipv4ToUint32(bare) != null) return [bare];
  if (bare.includes(':')) return [bare]; // IPv6 字面量：交由 IP 级判定保守拒绝
  try {
    const records = await dns.lookup(bare, { all: true });
    return records.map((record) => record.address);
  } catch {
    return [];
  }
}

/** 主机名是否命中 CIDR 放行名单（先解析再判定；解析失败 / 空名单 / 任一 IP 未命中均为 false）。 */
export async function isHostInCidrAllowlist(hostname: string, cidrs: readonly string[]): Promise<boolean> {
  if (cidrs.length === 0) return false;
  const ips = await resolveHostIps(hostname);
  return areIpsInCidrAllowlist(ips, cidrs);
}
