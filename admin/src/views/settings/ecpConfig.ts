export const ECP_CONFIG_KEY = 'auth.ecp.config'

export interface EcpConfig {
  enabled: boolean
  appCode: string
  baseUrl: string
  loginVariant: string
  timeoutMs: number
  desktopCallbackUrl: string
  adminCallbackUrl: string
  larkAppId: string
}

export function defaultEcpConfig(): EcpConfig {
  return {
    enabled: false,
    appCode: 'EK0001',
    baseUrl: 'https://ecp.example.com/api/v1',
    loginVariant: 'PARTNER',
    timeoutMs: 10000,
    desktopCallbackUrl: 'https://mao.example.com/auth/ecp/feishu-callback',
    adminCallbackUrl: 'https://mao.example.com/admin/auth/ecp/feishu-callback',
    larkAppId: '',
  }
}

export function validateEcpConfig(value: unknown): EcpConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('配置必须为 JSON 对象')
  }
  const config = value as Record<string, unknown>
  const fields = new Set(['enabled', 'appCode', 'baseUrl', 'loginVariant', 'timeoutMs', 'desktopCallbackUrl', 'adminCallbackUrl', 'larkAppId'])
  const unknownFields = Object.keys(config).filter((key) => !fields.has(key))
  if (unknownFields.length) throw new Error(`配置包含未知字段：${unknownFields.join('、')}`)
  if (typeof config.enabled !== 'boolean') throw new Error('enabled 必须为 boolean')
  if (typeof config.appCode !== 'string' || !config.appCode.trim()) throw new Error('appCode 不能为空')
  if (typeof config.baseUrl !== 'string' || !/^https:\/\//i.test(config.baseUrl)) throw new Error('baseUrl 必须为 HTTPS URL')
  if (typeof config.loginVariant !== 'string' || !config.loginVariant.trim()) throw new Error('loginVariant 不能为空')
  if (typeof config.timeoutMs !== 'number' || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60000) {
    throw new Error('timeoutMs 必须为 1000–60000 ms 的整数')
  }
  if (typeof config.desktopCallbackUrl !== 'string' || !/^https:\/\//i.test(config.desktopCallbackUrl)) {
    throw new Error('desktopCallbackUrl 必须为 HTTPS URL')
  }
  if (typeof config.adminCallbackUrl !== 'string' || !/^https:\/\//i.test(config.adminCallbackUrl)) {
    throw new Error('adminCallbackUrl 必须为 HTTPS URL')
  }
  const larkAppIdRaw = config.larkAppId ?? ''
  if (typeof larkAppIdRaw !== 'string' || larkAppIdRaw.length > 128) {
    throw new Error('larkAppId 必须是不超过 128 字符的字符串')
  }
  return {
    enabled: config.enabled,
    appCode: config.appCode.trim(),
    baseUrl: config.baseUrl.trim().replace(/\/$/, ''),
    loginVariant: config.loginVariant.trim(),
    timeoutMs: config.timeoutMs,
    desktopCallbackUrl: config.desktopCallbackUrl.trim(),
    adminCallbackUrl: config.adminCallbackUrl.trim(),
    larkAppId: larkAppIdRaw.trim(),
  }
}

export function parseEcpConfig(raw: string | null | undefined): EcpConfig {
  if (raw === undefined) return defaultEcpConfig()
  if (raw === null || raw.trim() === '') throw new Error('配置值为空，不是有效的 JSON 对象')
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error('配置不是有效的 JSON')
  }
  return validateEcpConfig(value)
}
