import { BusinessException } from './business-exception.js';
import { ErrorCode } from './error-code.js';
import { hasText } from './case.js';

/**
 * Git 服务域名口径（技术方案 2026-11-06 §4.2-1）：
 * user_git_credential.domain 与 agent.git_allowed_domains 两侧共用同一规范化与校验，
 * 保证「用户配置的 token 域」与「Agent 允许域」求交时能精确命中。
 *
 * 保留两条独立错误文案（不得合并）：
 * - 空值 → 「域名不能为空」（normalizeGitDomain）
 * - 格式不符 → 「域名格式无效，示例: github.com」（assertGitDomainValid）
 */
const DOMAIN_PATTERN =
  /^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

/** 规范化：trim + 小写 + 去 http(s):// 前缀 + 去首个 '/' 及其后；空值抛「域名不能为空」。 */
export function normalizeGitDomain(domain: string | null | undefined): string {
  if (!hasText(domain)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '域名不能为空');
  }
  let normalized = domain!.trim().toLowerCase();
  if (normalized.startsWith('https://')) {
    normalized = normalized.slice('https://'.length);
  }
  if (normalized.startsWith('http://')) {
    normalized = normalized.slice('http://'.length);
  }
  const slash = normalized.indexOf('/');
  if (slash >= 0) {
    normalized = normalized.slice(0, slash);
  }
  return normalized;
}

/** 格式校验（应对规范化之后的串调用）；不合法抛「域名格式无效，示例: github.com」。 */
export function assertGitDomainValid(domain: string): void {
  if (!DOMAIN_PATTERN.test(domain)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '域名格式无效，示例: github.com');
  }
}

/** 规范化 + 格式校验：用户凭据创建与 Agent 白名单校验共用。 */
export function normalizeAndValidateGitDomain(domain: string | null | undefined): string {
  const normalized = normalizeGitDomain(domain);
  assertGitDomainValid(normalized);
  return normalized;
}
