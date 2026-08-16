import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import { CloudWorkspaceResolver } from '../../harness/safety/cloud-workspace-resolver.js';

export function validate(url: string | null | undefined): void {
  if (url == null || url.trim().length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git URL 不能为空');
  }
  const trimmed = url.trim();
  if (trimmed.startsWith('git@')) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      '不支持 SSH 地址，请使用 HTTPS 格式，如 https://git.example.com/xx/xxx.git',
    );
  }
  if (trimmed.startsWith('http://')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '不支持 HTTP 明文地址，请使用 HTTPS');
  }
  if (!trimmed.startsWith('https://')) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      '不支持的协议，仅支持 HTTPS，示例: https://github.com/user/repo.git',
    );
  }
  if (!/^https:\/\/[^\s/]+(\/[^\s]+)+/.test(trimmed)) {
    throw new BusinessException(
      ErrorCode.PARAM_INVALID,
      'Git URL 格式无效，示例: https://github.com/user/repo.git',
    );
  }
}

export function extractSlug(url: string): string {
  validate(url);
  let path: string | null;
  try {
    path = new URL(url.trim()).pathname;
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git URL 格式无效');
  }
  if (path == null || path.trim().length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '无法从 Git URL 提取仓库名');
  }
  if (path.startsWith('/')) {
    path = path.slice(1);
  }
  if (path.endsWith('.git')) {
    path = path.slice(0, -4);
  }
  const lastSlash = path.lastIndexOf('/');
  const name = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  if (name.trim().length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '无法从 Git URL 提取仓库名');
  }
  return CloudWorkspaceResolver.normalizeAndValidate(name);
}

export function extractHost(url: string): string {
  validate(url);
  try {
    const host = new URL(url.trim()).hostname;
    if (!host) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git URL 格式无效');
    }
    return host;
  } catch (e) {
    if (e instanceof BusinessException) {
      throw e;
    }
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git URL 格式无效');
  }
}

export const GitUrlParser = { validate, extractSlug, extractHost };
