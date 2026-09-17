import { hasText } from '../common/case.js';

export const ECP_CONFIG_KEY = 'auth.ecp.config';

export type EcpCallbackTarget = 'desktop' | 'admin';

export interface EcpConfig {
  enabled: boolean;
  appCode: string;
  baseUrl: string;
  loginVariant: string;
  timeoutMs: number;
  desktopCallbackUrl: string;
  adminCallbackUrl: string;
  /** 飞书应用 App ID；非空时 CLOUD shell 注入 lark-cli 凭证。存量配置可缺失。 */
  larkAppId: string;
}

export function defaultEcpConfig(): EcpConfig {
  return {
    enabled: false,
    appCode: 'EK6301',
    baseUrl: 'https://ecp.acg.team/api/v1',
    loginVariant: 'PARTNER',
    timeoutMs: 10000,
    desktopCallbackUrl: 'https://mao.etarch.cn/auth/ecp/feishu-callback',
    adminCallbackUrl: 'https://mao.etarch.cn/admin/auth/ecp/feishu-callback',
    larkAppId: '',
  };
}

function validateHttpsUrl(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^https:\/\//i.test(value)) {
    throw new Error(`${field} 必须是 HTTPS URL`);
  }
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error(`${field} 必须是规范 HTTPS URL，不含查询、片段或凭据`);
  }
  const normalized = `${url.origin}${url.pathname}`.replace(/\/$/, '') || url.origin;
  const input = value.replace(/\/$/, '');
  if (normalized !== input && `${url.origin}${url.pathname}` !== value) {
    throw new Error(`${field} 必须是规范 HTTPS URL`);
  }
  return value;
}

export function validateEcpConfig(value: unknown): EcpConfig {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('配置必须为 JSON 对象');
  }
  const config = value as Record<string, unknown>;
  const fields = new Set(['enabled', 'appCode', 'baseUrl', 'loginVariant', 'timeoutMs', 'desktopCallbackUrl', 'adminCallbackUrl', 'larkAppId']);
  const unknownFields = Object.keys(config).filter((key) => !fields.has(key));
  if (unknownFields.length) throw new Error(`配置包含未知字段：${unknownFields.join('、')}`);
  if (typeof config.enabled !== 'boolean') throw new Error('enabled 必须为 boolean');
  if (typeof config.appCode !== 'string' || !hasText(config.appCode) || config.appCode.length > 64) {
    throw new Error('appCode 不能为空且不超过 64 字符');
  }
  if (typeof config.loginVariant !== 'string' || !hasText(config.loginVariant) || config.loginVariant.length > 32) {
    throw new Error('loginVariant 不能为空且不超过 32 字符');
  }
  if (typeof config.timeoutMs !== 'number' || !Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 60000) {
    throw new Error('timeoutMs 必须为 1000–60000 ms 的整数');
  }
  const larkAppIdRaw = config.larkAppId ?? '';
  if (typeof larkAppIdRaw !== 'string' || larkAppIdRaw.length > 128) {
    throw new Error('larkAppId 必须是不超过 128 字符的字符串');
  }
  const baseUrl = validateHttpsUrl(config.baseUrl, 'baseUrl').replace(/\/$/, '');
  const desktopCallbackUrl = validateHttpsUrl(config.desktopCallbackUrl, 'desktopCallbackUrl');
  const adminCallbackUrl = validateHttpsUrl(config.adminCallbackUrl, 'adminCallbackUrl');
  return {
    enabled: config.enabled,
    appCode: config.appCode.trim(),
    baseUrl,
    loginVariant: config.loginVariant.trim(),
    timeoutMs: config.timeoutMs,
    desktopCallbackUrl,
    adminCallbackUrl,
    larkAppId: larkAppIdRaw.trim(),
  };
}

export function parseEcpConfig(raw: string | null | undefined): EcpConfig {
  if (raw === undefined || raw === null || raw.trim() === '') return defaultEcpConfig();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('配置不是有效的 JSON');
  }
  return validateEcpConfig(value);
}

export function callbackUrlForTarget(config: EcpConfig, target: EcpCallbackTarget): string {
  return target === 'admin' ? config.adminCallbackUrl : config.desktopCallbackUrl;
}
