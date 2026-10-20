/**
 * 自定义 HTTP 工具内网放行清单（tools.http.privateAllowlist）的格式校验。
 * 口径与后端 settings.service.validateValue 的 HTTP_TOOL_PRIVATE_ALLOWLIST_KEY 分支一致：
 * CIDR JSON 数组；与环回（127.0.0.0/8）/ 云元数据（169.254.169.254）网段相交的项
 * 在执行内核永拒，保存前即拒（后端同款校验，避免「配了但不生效」）。
 */

const CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(\/(\d{1,2}))?$/

export function isValidCidr(value: string): boolean {
  const matched = CIDR_RE.exec(value.trim())
  if (!matched) return false
  const octets = [matched[1], matched[2], matched[3], matched[4]].map(Number)
  if (octets.some((octet) => octet > 255)) return false
  const prefix = matched[6] == null ? 32 : Number(matched[6])
  return prefix <= 32
}

function ipv4ToUint32(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = ((value << 8) | octet) >>> 0
  }
  return value
}

function prefixMask(prefix: number): number {
  return prefix === 0 ? 0 : prefix === 32 ? 0xFFFFFFFF : (~((1 << (32 - prefix)) - 1)) >>> 0
}

/** 执行内核永不放行的网段（环回 + 云元数据）。 */
const HARD_DENY_NETS: { net: number; prefix: number }[] = [
  { net: ipv4ToUint32('127.0.0.0')!, prefix: 8 },
  { net: ipv4ToUint32('169.254.169.254')!, prefix: 32 },
]

/** CIDR 是否与硬拒网段相交（含互相包含，如 127.0.0.1、169.254.0.0/16、0.0.0.0/0）。 */
export function cidrOverlapsHardDeniedNet(value: string): boolean {
  const [range, prefixRaw] = value.trim().split('/')
  const net = ipv4ToUint32((range ?? '').trim())
  if (net == null) return false
  const prefix = prefixRaw == null || prefixRaw === '' ? 32 : Number(prefixRaw)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false
  return HARD_DENY_NETS.some((deny) =>
    (net & prefixMask(deny.prefix)) === (deny.net & prefixMask(deny.prefix))
    || (deny.net & prefixMask(prefix)) === (net & prefixMask(prefix)),
  )
}

/**
 * 放行清单校验：空串合法（=一律按私网拒绝）；非 JSON / 非数组 / 任一非 CIDR /
 * 与硬拒网段相交，返回可读错误文案。
 */
export function cidrAllowlistError(raw: string | undefined | null): string {
  const text = (raw ?? '').trim()
  if (text === '') return ''
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return '需为 JSON 数组，如 ["10.0.0.0/8"]'
  }
  if (!Array.isArray(parsed)) return '需为 CIDR JSON 数组，如 ["10.0.0.0/8","192.168.1.0/24"]'
  const invalid = parsed.find((item) => typeof item !== 'string' || !isValidCidr(item))
  if (invalid !== undefined) return `存在无效 CIDR：${String(invalid).slice(0, 32)}`
  const hardDenied = parsed.find((item) => typeof item === 'string' && cidrOverlapsHardDeniedNet(item))
  if (hardDenied !== undefined) {
    return `不允许放行环回（127.0.0.0/8）或云元数据（169.254.169.254）网段：${String(hardDenied).slice(0, 32)}`
  }
  return ''
}
