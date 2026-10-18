import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { isReservedEnvKey } from '../common/sensitive-env.js';

/** 变量名格式：POSIX 合法标识符，最长 128。 */
export const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
export const MAX_ENV_VALUE_LENGTH = 2048;
export const MAX_ENV_VARS_PER_SCOPE = 50;
export const MAX_ENV_NOTE_LENGTH = 256;

/**
 * 保留键/格式校验（写入与合并两处共用，§7.5 双保险的第一道）。
 * 抛 BusinessException，便于路由直接透出 PARAM_INVALID。
 */
export function assertConfiguredEnvKey(key: string | null | undefined): string {
  const normalized = (key ?? '').trim();
  if (normalized === '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '变量名不能为空');
  }
  if (!ENV_KEY_PATTERN.test(normalized)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '变量名须以字母或下划线开头，仅含字母/数字/下划线，最长 128 字符');
  }
  if (isReservedEnvKey(normalized)) {
    throw new BusinessException(ErrorCode.ENV_VARIABLE_KEY_RESERVED, `${normalized} 为平台保留变量，不允许配置`);
  }
  return normalized;
}
