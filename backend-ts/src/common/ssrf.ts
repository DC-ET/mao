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
    const [a, b] = parts;
    const ip = ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return true; // 私网
    if (a === 127) return true; // 环回
    if (a === 169 && b === 254) return true; // 链路本地
    if (ip >= 0x0A000000 && ip <= 0x0AFFFFFF) return true;
    if (ip <= 0x00FFFFFF || ip >= 0xFFFFFFFF - 0xFF) return true; // 0.x 与 255.x
    if (a >= 224) return true; // 组播/保留
    return false;
  }
  if (hostname.includes(':')) return true; // IPv6：保守拒绝字面量
  if (hostname.endsWith('.local') || hostname.endsWith('.internal')) return true;
  return false;
}
