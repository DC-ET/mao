import { BusinessException } from '../../common/business-exception.js';
import { ErrorCode } from '../../common/error-code.js';
import path from 'node:path';
import type { PathSandbox } from './path-sandbox.js';

const SLUG_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const RESERVED = new Set(['projects', 'sessions']);

export const CloudWorkspaceResolver = {
  normalizeAndValidate(raw: string | null | undefined): string {
    if (raw == null || raw.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '项目名称不能为空');
    }
    const slug = raw.trim();
    if (slug === '.' || slug === '..') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '项目名称非法');
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        '项目名称仅允许字母、数字、下划线和连字符，长度 1-64，且必须以字母或数字开头',
      );
    }
    if (RESERVED.has(slug.toLowerCase())) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '项目名称不能使用保留字: ' + slug);
    }
    return slug;
  },

  assertUnderUserSandbox(sandbox: PathSandbox, userId: number, workspace: string): void {
    const expectedPrefix = path.resolve(sandbox.getWorkspaceRoot(), String(userId));
    const resolved = path.resolve(workspace);
    const rel = path.relative(expectedPrefix, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '工作区路径非法');
    }
  },

  resolveProjectWorkspace(sandbox: PathSandbox, userId: number, slug: string): string {
    const p = path.join(sandbox.getWorkspaceRoot(), String(userId), 'projects', slug);
    this.assertUnderUserSandbox(sandbox, userId, p);
    return p;
  },
};
