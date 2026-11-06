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

/**
 * 凭据占位符白名单（2026-11-06 技术方案 §5.1.1）：请求头值支持 `{{MAO_TOKEN}}` / `{{ECP_TOKEN}}`。
 * 落库的是占位符本身（随 headersJson 整体加密，不含任何明文 token），探针执行时由后端
 * 替换为当时有效 token（解析失败跳过整个头，D2）。
 */
export const CREDENTIAL_PLACEHOLDERS = ['MAO_TOKEN', 'ECP_TOKEN'] as const;
export type CredentialPlaceholderKind = (typeof CREDENTIAL_PLACEHOLDERS)[number];

/**
 * 白名单占位符匹配（非全局正则）。带 `g` 的模块级正则有 lastIndex 状态，
 * `.test()` / `.exec()` 跨调用复用会漏匹配（方案 §8.1），需要全量匹配时在调用点新建全局字面量。
 */
const WHITELISTED_PLACEHOLDER_RE = /\{\{(MAO_TOKEN|ECP_TOKEN)\}\}/;

/** 值含 `{{...}}` 形态且内部不是白名单名 → true（D4：静默放过会让占位符字面量发往目标服务）。 */
export function containsUnsupportedPlaceholder(value: string): boolean {
  // 正向扫全部 `{{...}}` 候选再逐一比对白名单：反过来只扫白名单会漏掉 `{{EVIL}}`（§8.1）。
  const candidates = value.match(/\{\{[^{}]*\}\}/g);
  if (candidates == null) return false;
  return candidates.some((candidate) => !WHITELISTED_PLACEHOLDER_RE.test(candidate));
}

/** 值是否含白名单占位符（执行态短路与 resolver 缺省告警的触发条件，D6）。 */
export function containsCredentialPlaceholder(value: string): boolean {
  return WHITELISTED_PLACEHOLDER_RE.test(value);
}

/**
 * 值是否「只由白名单占位符组成」（D5 打码例外判据）：剥掉全部白名单占位符后为空串。
 * 判据不能写成「值里含占位符」——那会让 `Bearer sk-real {{MAO_TOKEN}}`（真实 token 与
 * 占位符混存）一并不打码，把明文泄露到回显里；混合形态剥完非空 → 仍打码。
 */
export function isPlaceholderOnlyValue(value: string): boolean {
  return value.replace(/\{\{(?:MAO_TOKEN|ECP_TOKEN)\}\}/g, '') === '';
}

/**
 * 替换值里的全部白名单占位符（执行态，方案 §5.1.2）。校验层与替换层共用同一正则口径（§8.2）：
 * 用 String.replace 函数式单遍替换（单遍、不递归、无 lastIndex 问题），同一 kind 出现多次
 * 只 resolve 一次（D8：MAO_TOKEN 每次调用都重新签发，去重避免一个值里两处 token 不一致）。
 * 任一 kind 解析失败 → 整值返回 null，调用方丢弃整个头（D2：把 `Bearer {{MAO_TOKEN}}`
 * 字面量发出去毫无意义，还会污染判定值）。
 */
export function replaceCredentialPlaceholders(
  value: string,
  resolve: (kind: CredentialPlaceholderKind) => string | null,
): string | null {
  let failed = false;
  const cache = new Map<CredentialPlaceholderKind, string>();
  const result = value.replace(/\{\{(MAO_TOKEN|ECP_TOKEN)\}\}/g, (match, kind: CredentialPlaceholderKind) => {
    let resolved = cache.get(kind);
    if (resolved === undefined) {
      const token = resolve(kind);
      if (token == null || token === '') {
        failed = true;
        return match;
      }
      resolved = token;
      cache.set(kind, resolved);
    }
    return resolved;
  });
  return failed ? null : result;
}

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
export function assertProbeHeaders(headers: Record<string, string>, legacyValues?: ReadonlySet<string>): Record<string, string> {
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
    // D4（2026-11-06 方案）：值里出现 `{{...}}` 且不是白名单占位符直接拒绝——
    // 静默放行会让占位符字面量发往目标服务，用户还以为注入生效了。
    // legacyValues：库内已存的旧字面量（本功能上线前 assertProbeHeaders 允许任意
    // 无 CRLF 值落库）随编辑回传 / 复制继承时豁免，否则存量哨兵将无法再编辑、改名、
    // 复制（review round 1）；只拦「新填写」的值，执行态对未识别形态本就原样直发。
    if (containsUnsupportedPlaceholder(value) && !legacyValues?.has(value)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头 ${key} 含不支持的占位符（仅支持 {{MAO_TOKEN}} / {{ECP_TOKEN}}）`);
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
    // D5（2026-11-06 方案）：值只由白名单凭据占位符组成时不打码——占位符不含明文密文，
    // 打码反而让用户回显时看不到自己配了什么而误删重配；混合形态（Bearer {{MAO_TOKEN}}）
    // 剥完非空 → 仍打码（isPlaceholderOnlyValue 的判据已防真实 token 混存泄露）。
    result[key] = isSensitiveProbeHeader(key) && !isPlaceholderOnlyValue(value) ? SECRET_MASK : value;
  }
  return result;
}
