import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { isUnder } from '../safety/path-sandbox.js';
import { EXPERIENCE_MOUNT_NAME } from './experience-index.service.js';

/** 文件管理试图改团队经验库时的拒绝文案。 */
export const EXPERIENCE_READONLY_MESSAGE = '团队经验库只读，不能在文件管理中修改';

/**
 * 相对路径归一后是否落在工作区根的「团队经验」上（含挂载点自身）。
 * 绝对路径、`..` 越出工作区的路径不算：那些仍走原来的越界拒绝。
 */
export function isExperienceMountRelative(userPath: string): boolean {
  if (userPath == null) return false;
  const normalized = userPath.replace(/\\/g, '/').trim();
  if (normalized === '' || normalized.startsWith('/') || normalized.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(normalized)) return false;
  const parts: string[] = [];
  for (const raw of normalized.split('/')) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      if (parts.length === 0) return false;
      parts.pop();
      continue;
    }
    parts.push(raw);
  }
  return parts[0] === EXPERIENCE_MOUNT_NAME;
}

/**
 * 工作区根上的「团队经验」是符号链接，且真实目录落在给定的 Agent 经验库内。
 * 链接被换成别的目标、或只是同名真实目录时返回 false。
 */
export function experienceMountPointsAt(workspace: string, experienceDir: string): boolean {
  const linkPath = path.join(path.resolve(workspace), EXPERIENCE_MOUNT_NAME);
  try {
    if (!lstatSync(linkPath).isSymbolicLink()) return false;
    const real = realpathSync(linkPath);
    let root = path.resolve(experienceDir);
    try {
      root = realpathSync(experienceDir);
    } catch {
      // 库目录尚未创建时退回词法路径
    }
    return isUnder(real, root);
  } catch {
    return false;
  }
}

/** 有会话 Agent 时解析其经验库目录；没有 Agent 或不提供解析器则不放行。 */
export function experienceDirForSession(
  session: { agentId?: number | null },
  dirForAgent: ((agentId: number) => string) | undefined,
): string | undefined {
  if (dirForAgent == null || session.agentId == null) return undefined;
  const id = Number(session.agentId);
  if (!Number.isInteger(id) || id <= 0) return undefined;
  return dirForAgent(id);
}
