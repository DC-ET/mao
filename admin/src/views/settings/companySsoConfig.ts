export const COMPANY_SSO_KEY = 'auth.companySso.config'

export interface CompanySsoConfig {
  enabled: boolean
  allowedDomains: string[]
  allowedOrigins: string[]
  accessTtlSeconds: number
  timeoutMs: number
}

export function defaultCompanySsoConfig(): CompanySsoConfig {
  return { enabled: false, allowedDomains: [], allowedOrigins: [], accessTtlSeconds: 1800, timeoutMs: 3000 }
}

export function splitAllowlist(value: string): string[] {
  return [...new Set(value.split(/[,\r\n]+/).map((item) => item.trim()).filter(Boolean))]
}

function validateDomains(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('allowedDomains 必须为字符串数组')
  }
  return [...new Set(value.map((item: string) => {
    const domain = item.toLowerCase()
    let hostname = ''
    try {
      hostname = new URL(`https://${domain}`).hostname
    } catch { /* 无效 URL 由下方统一报错 */ }
    if (item !== item.trim() || domain.length > 253 || domain.split('.').length < 2 || hostname !== domain || /^[\d.]+$/.test(hostname) || !domain.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error(`allowedDomains 域名无效：${item}；请填写至少两段的纯域名，不含空白、IP、协议、端口、路径或通配符`)
    }
    return domain
  }))]
}

function validateOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('allowedOrigins 必须为字符串数组')
  }
  return [...new Set(value.map((item: string) => {
    if (item === '*') return item
    const wildcard = item.startsWith('https://*.')
    const origin = wildcard ? `https://${item.slice('https://*.'.length)}` : item
    let url: URL
    try {
      url = new URL(origin)
      if (wildcard) validateDomains([url.hostname])
    } catch {
      throw new Error(`allowedOrigins Origin 或子域模式无效：${item}`)
    }
    if (wildcard && url.port === '0') {
      throw new Error('allowedOrigins 子域模式端口必须为 1–65535，默认 HTTPS 端口请省略')
    }
    if (url.protocol !== 'https:' || url.origin !== origin || url.hostname.includes('*')) {
      throw new Error(`allowedOrigins 必须是精确 HTTPS Origin、https://*.example.com 形式的子域模式或 *：${item}；须为规范 Origin，不含路径、尾部斜杠、查询、凭据或片段，子域通配符仅限最左侧 *.`)
    }
    return item
  }))]
}

export function validateCompanySsoConfig(value: unknown): CompanySsoConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('配置必须为 JSON 对象')
  }
  const config = value as Record<string, unknown>
  const fields = new Set(['enabled', 'allowedDomains', 'allowedOrigins', 'accessTtlSeconds', 'timeoutMs'])
  const unknownFields = Object.keys(config).filter((key) => !fields.has(key))
  if (unknownFields.length) throw new Error(`配置包含未知字段：${unknownFields.join('、')}`)
  if (typeof config.enabled !== 'boolean') throw new Error('enabled 必须为 boolean')
  if (typeof config.accessTtlSeconds !== 'number' || !Number.isInteger(config.accessTtlSeconds) || config.accessTtlSeconds < 60 || config.accessTtlSeconds > 3600) {
    throw new Error('accessTtlSeconds 必须为 60–3600 秒的整数')
  }
  if (typeof config.timeoutMs !== 'number' || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 30000) {
    throw new Error('timeoutMs 必须为 1–30000 ms 的整数')
  }
  const allowedDomains = validateDomains(config.allowedDomains)
  const allowedOrigins = validateOrigins(config.allowedOrigins)
  if (config.enabled && (!allowedDomains.length || !allowedOrigins.length)) {
    throw new Error('启用公司 SSO 时 allowedDomains 和 allowedOrigins 白名单均不能为空')
  }
  return {
    enabled: config.enabled,
    allowedDomains,
    allowedOrigins,
    accessTtlSeconds: config.accessTtlSeconds,
    timeoutMs: config.timeoutMs,
  }
}

/** 仅 key 尚不存在时使用默认值；已有值为空、JSON 损坏或缺字段均报错。 */
export function parseCompanySsoConfig(raw: string | null | undefined): CompanySsoConfig {
  if (raw === undefined) return defaultCompanySsoConfig()
  if (raw === null || raw.trim() === '') throw new Error('配置值为空，不是有效的 JSON 对象')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('配置不是有效的 JSON')
  }
  return validateCompanySsoConfig(value)
}
