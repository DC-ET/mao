import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { isPrivateOrReservedHostname } from '../common/ssrf.js';

/**
 * 哨兵探针 URL 与请求头校验（docs/plan/2026-10-11-signal-watcher-technical-design.md §5.4）。
 * URL 协议 http/https 均可（决策 3），主机名复用 common/ssrf.ts 的私网/环回判定；
 * 请求头禁覆盖 hop-by-hop 与 Host，防走私与探测偏移。
 */

/** 禁止用户覆盖的请求头（大小写不敏感）。 */
const FORBIDDEN_HEADERS = new Set(['host', 'content-length', 'transfer-encoding', 'connection']);

/** 请求头键数量上限。 */
export const MAX_PROBE_HEADERS = 20;

/** 请求头名命中即视为敏感（大小写不敏感、含子串即命中），回显时打码。 */
const SENSITIVE_HEADER_PATTERNS = ['authorization', 'cookie', 'x-api-key', 'token', 'secret', 'password'];

export const SECRET_MASK = '******';

/** 校验探针 URL 并返回规范化字符串；不合法抛 PARAM_INVALID。 */
export function assertProbeUrl(raw: string): string {
  if (raw == null || raw.trim() === '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不能为空');
  }
  let parsed: URL;
  try {
    parsed = new URL(raw.trim());
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不合法');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 仅支持 http/https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不允许内嵌凭据');
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrReservedHostname(host)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不允许指向私网/环回/链路本地地址');
  }
  return parsed.toString();
}

/** 请求头键值是否允许覆盖（Host/Content-Length 等禁覆盖）。 */
export function isForbiddenProbeHeader(name: string): boolean {
  return FORBIDDEN_HEADERS.has(name.trim().toLowerCase());
}

/** 校验请求头键值对；不合法抛 PARAM_INVALID。返回trim 后的新对象。 */
export function assertProbeHeaders(headers: Record<string, string>): Record<string, string> {
  const entries = Object.entries(headers ?? {});
  if (entries.length > MAX_PROBE_HEADERS) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头最多 ${MAX_PROBE_HEADERS} 个`);
  }
  const result: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    // 先按原样校验再 trim：trim 会吃掉首尾的 \r\n，放行后再 trim 就绕过了注入检查。
    // 键名 trim 后为空的（如 '   '）也要拒：空 header 名会让 node:http 抛
    // ERR_INVALID_HTTP_TOKEN，错误信息指不到真正原因，哨兵会连败到自动停用。
    if (rawKey.trim() === '' || rawKey.includes(':') || /[\r\n]/.test(rawKey)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '请求头名称不合法');
    }
    const key = rawKey.trim();
    const value = typeof rawValue === 'string' ? rawValue : String(rawValue ?? '');
    if (/[\r\n]/.test(value)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头 ${key} 的值包含非法字符`);
    }
    if (isForbiddenProbeHeader(key)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头 ${key} 不允许覆盖`);
    }
    result[key] = value;
  }
  return result;
}

/** 请求头名是否敏感（回显打码判定）。 */
export function isSensitiveProbeHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return SENSITIVE_HEADER_PATTERNS.some((p) => lower.includes(p));
}

/** 敏感值打码后的请求头（回显用）。 */
export function maskProbeHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    result[key] = isSensitiveProbeHeader(key) ? SECRET_MASK : value;
  }
  return result;
}
