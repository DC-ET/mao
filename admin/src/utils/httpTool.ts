/**
 * 自定义 HTTP 工具请求头规则（与 backend-ts/src/http-tool/types.ts 保持一致）。
 * 后端按「键名启发式」决定加密，前端只做同口径的只读展示，避免出现无效开关。
 */

/** 敏感请求头键名判定（大小写不敏感子串）：token/secret/key/authorization/cookie。 */
export const SENSITIVE_HEADER_RE = /token|secret|key|authorization|cookie/i

/** 与后端 HEADER_VALUE_MASK 一致：敏感请求头回显掩码。 */
export const HEADER_VALUE_MASK = '******'

export function isSensitiveHeaderKey(key: string): boolean {
  return SENSITIVE_HEADER_RE.test(key)
}
