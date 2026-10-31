import { createHash } from 'node:crypto';
import { ipv4ToUint32, isCloudMetadataIp, isLoopbackIp } from './ssrf.js';

/**
 * 容器 /etc/hosts 注入（Docker 模式）的解析、校验与合并（单一来源）。
 * 消费方：
 * - settings.service#validateValue：保存前校验后台自定义规则（CONTAINER_EXTRA_HOSTS_KEY）；
 * - ContainerHostsResolver：运行时读取宿主机 /etc/hosts 与自定义规则，合并为注入条目。
 * 技术方案：docs/plan/2026-10-31-container-hosts-injection.md
 */
export interface ContainerHostsEntry {
  host: string;
  ip: string;
  source: 'hosts-file' | 'custom';
}

/** 系统设置 key（V176 迁移插入，editable=1）。 */
export const CONTAINER_INHERIT_HOST_HOSTS_KEY = 'runtime.container.inheritHostHosts';
export const CONTAINER_EXTRA_HOSTS_KEY = 'runtime.container.extraHosts';

/** 自定义规则数量上限。 */
export const CONTAINER_EXTRA_HOSTS_MAX = 50;
/** 自定义规则 JSON 序列化体积上限（字符）。 */
export const CONTAINER_EXTRA_HOSTS_MAX_BYTES = 8 * 1024;
/** 宿主机 /etc/hosts 继承条目数量上限（防异常文件）。 */
export const HOST_FILE_ENTRIES_LIMIT = 100;

/** 容器内置/无意义的 hosts 名：自定义规则与宿主文件继承都跳过，避免覆盖容器自身语义。 */
const RESERVED_HOSTS = new Set([
  'localhost',
  'localhost.localdomain',
  'broadcast',
  'broadcasthost',
  'ip6-localhost',
  'ip6-loopback',
  'ip6-allnodes',
  'ip6-allrouters',
  'ip6-mcastprefix',
  'ip6-localnet',
]);

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/**
 * 主机名归一化：trim → 小写 → 去尾点；非法（空/超长/非法分段）返回 null。
 * 允许任意段数（含内部短别名如 `mysql`），不做"必须含点"的强制。
 */
export function normalizeHostName(raw: string): string | null {
  let host = raw.trim().toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) return null;
  const labels = host.split('.');
  for (const label of labels) {
    if (label.length === 0 || label.length > 63 || !HOST_LABEL.test(label)) return null;
  }
  return host;
}

/** 是否容器内置保留名（localhost 系列等）。 */
export function isReservedContainerHost(host: string): boolean {
  return RESERVED_HOSTS.has(host);
}

/**
 * 注入 IP 的硬性拦截（环回 / 云元数据 / 0.x / 组播与保留段）：
 * true = 永不允许作为 --add-host 目标。宿主文件过滤与后台规则校验共用同一口径。
 */
export function isBlockedContainerHostIp(ip: string): boolean {
  const trimmed = ip.trim();
  if (ipv4ToUint32(trimmed) == null) return true; // 非合法 IPv4（含 IPv6）一律拦截
  if (isLoopbackIp(trimmed)) return true; // 127.0.0.0/8
  if (isCloudMetadataIp(trimmed)) return true; // 云元数据端点
  const first = Number(trimmed.split('.')[0]);
  if (first === 0) return true; // 0.0.0.0/8
  if (first >= 224) return true; // 224.0.0.0/4（组播）与 240.0.0.0/4（保留）
  return false;
}

/** 单个自定义条目的校验：合法返回 null，否则返回错误描述。 */
export function validateCustomHostEntry(host: string, ip: string): string | null {
  const normalizedHost = normalizeHostName(host);
  if (normalizedHost == null) return `域名不合法：${host || '(空)'}`;
  if (isReservedContainerHost(normalizedHost)) return `不允许配置保留域名：${normalizedHost}`;
  const trimmedIp = ip.trim();
  if (ipv4ToUint32(trimmedIp) == null) return `IP 必须是合法的 IPv4 地址（暂不支持 IPv6）：${ip || '(空)'}`;
  if (isBlockedContainerHostIp(trimmedIp)) return `IP 不允许指向环回/云元数据/保留段：${trimmedIp}`;
  return null;
}

export type ExtraHostsParseResult =
  | { ok: true; entries: Array<{ host: string; ip: string }> }
  | { ok: false; errors: string[] };

/**
 * 解析自定义规则设置值（JSON 数组字符串）：
 * - 非 JSON / 非数组 / 条目非法 / 数量超限 / 重复 host → ok:false + errors（保存前校验与运行时消费共用）；
 * - host 归一化（小写、去尾点），ip 原样 trim。
 */
export function parseExtraHostsValue(raw: string | null | undefined): ExtraHostsParseResult {
  const text = (raw ?? '').trim();
  if (text === '' || text === '[]') return { ok: true, entries: [] };
  if (text.length > CONTAINER_EXTRA_HOSTS_MAX_BYTES) {
    return { ok: false, errors: [`规则体积超限（>${CONTAINER_EXTRA_HOSTS_MAX_BYTES} 字符）`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['必须是 JSON 数组，如 [{"host":"a.example.com","ip":"10.0.0.1"}]'] };
  }
  if (!Array.isArray(parsed)) {
    return { ok: false, errors: ['必须是 JSON 数组，如 [{"host":"a.example.com","ip":"10.0.0.1"}]'] };
  }
  if (parsed.length > CONTAINER_EXTRA_HOSTS_MAX) {
    return { ok: false, errors: [`规则条数超限（最多 ${CONTAINER_EXTRA_HOSTS_MAX} 条）`] };
  }
  const entries: Array<{ host: string; ip: string }> = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  parsed.forEach((item, index) => {
    const record = item as { host?: unknown; ip?: unknown } | null;
    if (record == null || typeof record !== 'object' || Array.isArray(record)) {
      errors.push(`第 ${index + 1} 条必须是 { host, ip } 对象`);
      return;
    }
    const hostRaw = typeof record.host === 'string' ? record.host : '';
    const ipRaw = typeof record.ip === 'string' ? record.ip : '';
    const error = validateCustomHostEntry(hostRaw, ipRaw);
    if (error != null) {
      errors.push(`第 ${index + 1} 条：${error}`);
      return;
    }
    const host = normalizeHostName(hostRaw)!;
    if (seen.has(host)) {
      errors.push(`域名重复：${host}`);
      return;
    }
    seen.add(host);
    entries.push({ host, ip: ipRaw.trim() });
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, entries };
}

/**
 * 解析宿主机 /etc/hosts 内容 → 可注入条目：
 * - 忽略空行与 `#` 注释；行格式 `IP host1 [host2 ...]`；
 * - 仅保留合法 IPv4 行（IPv6 行跳过）与合法主机名（归一化后）；
 * - 跳过环回/元数据/保留段 IP 与内置保留名；同 host 取首次出现（hosts 首条生效语义）；
 * - 条目数超过 limit 时截断（truncated=true）。
 */
export function parseHostHostsFile(content: string, limit = HOST_FILE_ENTRIES_LIMIT): {
  entries: Array<{ host: string; ip: string }>;
  truncated: boolean;
} {
  const collected: Array<{ host: string; ip: string }> = [];
  const seen = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const ip = parts[0]!.trim();
    if (isBlockedContainerHostIp(ip)) continue;
    for (const rawHost of parts.slice(1)) {
      const host = normalizeHostName(rawHost);
      if (host == null || isReservedContainerHost(host)) continue;
      if (seen.has(host)) continue;
      seen.add(host);
      collected.push({ host, ip });
    }
  }
  // 恰好等于上限不算截断：只有确实丢掉了条目才标记（避免误导性 warn）
  return { entries: collected.slice(0, limit), truncated: collected.length > limit };
}

/**
 * 合并宿主继承与自定义规则（host 唯一）：
 * - inheritEnabled=false 时忽略宿主条目；
 * - 自定义规则覆盖同名宿主条目；
 * - 结果按 host 字典序排序（保证指纹稳定）。
 */
export function mergeContainerHosts(
  hostFileEntries: ReadonlyArray<{ host: string; ip: string }>,
  customEntries: ReadonlyArray<{ host: string; ip: string }>,
  inheritEnabled: boolean,
): ContainerHostsEntry[] {
  const map = new Map<string, ContainerHostsEntry>();
  if (inheritEnabled) {
    for (const entry of hostFileEntries) {
      if (!map.has(entry.host)) map.set(entry.host, { host: entry.host, ip: entry.ip, source: 'hosts-file' });
    }
  }
  for (const entry of customEntries) {
    map.set(entry.host, { host: entry.host, ip: entry.ip, source: 'custom' });
  }
  return [...map.values()].sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0));
}

/** 注入条目指纹（sha1，稳定序列化）：docker run 时固化，漂移触发容器重建。 */
export function containerHostsFingerprint(entries: ReadonlyArray<{ host: string; ip: string }>): string {
  return createHash('sha1').update(entries.map((entry) => `${entry.host}=${entry.ip}`).join('\n'), 'utf8').digest('hex');
}

/** 空条目集合的指纹（用于"旧条目无指纹且当前期望为空 → 不重建"判定）。 */
export const EMPTY_CONTAINER_HOSTS_FINGERPRINT = containerHostsFingerprint([]);
