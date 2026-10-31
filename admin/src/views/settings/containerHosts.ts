/**
 * 容器域名解析（runtime.container.extraHosts / runtime.container.inheritHostHosts）的格式处理。
 * 校验口径与后端 common/container-hosts.ts 一致：
 * - host：小写字母/数字/`-`/`.` 分段（每段首尾不为 `-`），≤253，禁 localhost 系列保留名；
 * - ip：合法 IPv4，禁 127.0.0.0/8、169.254.169.254、0.0.0.0/8、组播 224/4 与保留 240/4；
 * - 最多 50 条、同 host 不重复。
 */

export interface ContainerHostEntry {
  host: string
  ip: string
}

export const CONTAINER_EXTRA_HOSTS_MAX = 50

const HOST_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/

const RESERVED_HOSTS = new Set([
  'localhost', 'localhost.localdomain', 'broadcast', 'broadcasthost',
  'ip6-localhost', 'ip6-loopback', 'ip6-allnodes', 'ip6-allrouters', 'ip6-mcastprefix', 'ip6-localnet',
])

export function normalizeContainerHost(raw: string): string | null {
  let host = raw.trim().toLowerCase()
  if (host.endsWith('.')) host = host.slice(0, -1)
  if (host.length === 0 || host.length > 253) return null
  for (const label of host.split('.')) {
    if (label.length === 0 || label.length > 63 || !HOST_LABEL.test(label)) return null
  }
  return host
}

function isBlockedContainerHostIp(ip: string): boolean {
  const trimmed = ip.trim()
  // 与后端 common/ssrf.ts 的 isCloudMetadataIp 同口径（含阿里云 100.100.100.200 等）
  if (['169.254.169.254', '100.100.100.200', '169.254.0.23', '169.254.170.2'].includes(trimmed)) return true
  const parts = trimmed.split('.')
  if (parts.length !== 4) return true
  const nums = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  if (nums.some((num) => Number.isNaN(num) || num > 255)) return true
  if (nums[0] === 127) return true
  if (nums[0] === 0) return true
  if (nums[0]! >= 224) return true
  return false
}

/** 单条规则校验：合法返回 null，否则返回错误描述（与后端同口径）。 */
export function containerHostEntryError(host: string, ip: string): string | null {
  const normalized = normalizeContainerHost(host)
  if (normalized == null) return `域名不合法：${host || '(空)'}`
  if (RESERVED_HOSTS.has(normalized)) return `不允许配置保留域名：${normalized}`
  const trimmedIp = ip.trim()
  const parts = trimmedIp.split('.')
  const validV4 = parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  if (!validV4) return `IP 必须是合法的 IPv4 地址（暂不支持 IPv6）：${ip || '(空)'}`
  if (isBlockedContainerHostIp(trimmedIp)) return `IP 不允许指向环回/云元数据/保留段：${trimmedIp}`
  return null
}

/** 解析设置值供面板展示：无法解析时返回 error（保留原始值不丢）。 */
export function parseContainerHostsValue(raw: string | null | undefined): { entries: ContainerHostEntry[]; error: string | null } {
  const text = (raw ?? '').trim()
  if (text === '' || text === '[]') return { entries: [], error: null }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { entries: [], error: '设置值不是合法 JSON' }
  }
  if (!Array.isArray(parsed)) return { entries: [], error: '设置值必须是 JSON 数组' }
  const entries: ContainerHostEntry[] = []
  for (const item of parsed) {
    const record = item as { host?: unknown; ip?: unknown } | null
    const host = typeof record?.host === 'string' ? record.host : ''
    const ip = typeof record?.ip === 'string' ? record.ip : ''
    const normalized = normalizeContainerHost(host)
    if (normalized == null) return { entries, error: `包含不合法域名：${host || '(空)'}` }
    entries.push({ host: normalized, ip: ip.trim() })
  }
  return { entries, error: null }
}

/** 编辑态整表保存前校验（单条 + 重复 + 数量）。返回 null 表示通过。 */
export function containerHostsSaveError(entries: ContainerHostEntry[]): string | null {
  if (entries.length > CONTAINER_EXTRA_HOSTS_MAX) return `规则条数超限（最多 ${CONTAINER_EXTRA_HOSTS_MAX} 条）`
  const seen = new Set<string>()
  for (const [index, entry] of entries.entries()) {
    const error = containerHostEntryError(entry.host, entry.ip)
    if (error != null) return `第 ${index + 1} 条：${error}`
    const normalized = normalizeContainerHost(entry.host)!
    if (seen.has(normalized)) return `域名重复：${normalized}`
    seen.add(normalized)
  }
  return null
}

/** 序列化为设置值（归一化 host、trim ip、按 host 排序）。 */
export function stringifyContainerHosts(entries: ContainerHostEntry[]): string {
  const normalized = entries
    .map((entry) => ({ host: normalizeContainerHost(entry.host)!, ip: entry.ip.trim() }))
    .sort((a, b) => (a.host < b.host ? -1 : a.host > b.host ? 1 : 0))
  return JSON.stringify(normalized)
}
