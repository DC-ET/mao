import fs from 'node:fs';
import path from 'node:path';
import { expandHome, resolveRuntimeDir } from './paths';

/**
 * 路径沙箱：语义对齐后端 harness/safety/path-sandbox.ts（path.relative 判越界）。
 * 允许根为「本地工作区」+「本会话 runtime 目录」，服务端下发的任何路径都必须落在其中。
 */
export class PathEscapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapeError';
  }
}

export function isUnder(resolved: string, root: string): boolean {
  const rel = path.relative(root, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 取最深的已存在祖先做 realpath，再把不存在的尾部拼回。
 * 目的是在越界判定前展开 symlink：工作区内的软链目录指向外部时不能算在沙箱内。
 */
export function realpathBoundary(target: string): string {
  const resolved = path.resolve(target);
  const missing: string[] = [];
  let current = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return missing.length === 0 ? real : path.join(real, ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return resolved;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function sandboxRoots(workspace: string, sessionId: number): string[] {
  return [realpathBoundary(workspace), realpathBoundary(resolveRuntimeDir(sessionId))];
}

/**
 * 把工具参数里的路径解析为绝对路径，越界抛 PathEscapeError。
 * 返回值保持用户输入的软链形态（未 realpath），仅用其 realpath 做边界判定。
 */
export function resolveSandboxPath(filePath: string, workspace: string | undefined, sessionId: number): string {
  if (!filePath || filePath.trim() === '') throw new PathEscapeError('路径不能为空');
  if (!workspace) throw new PathEscapeError(`拒绝访问 ${filePath}：本次会话没有本地工作区，无法确定沙箱根目录`);
  const expanded = expandHome(filePath);
  const base = path.resolve(workspace);
  const candidate = path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
  const real = realpathBoundary(candidate);
  for (const root of sandboxRoots(base, sessionId)) {
    if (isUnder(real, root)) return candidate;
  }
  throw new PathEscapeError(`拒绝访问工作区外路径：${filePath}（工作区 ${base}）`);
}

/** 服务端下发的 workspace 只有等于本地工作区或位于其内部时才可接受。 */
export function isWorkspaceWithin(candidate: string, localWorkspace: string): boolean {
  return isUnder(realpathBoundary(candidate), realpathBoundary(localWorkspace));
}

/** 读写编辑一律不跟随软链：目标本身是 symlink 时直接拒绝。 */
export function assertNotSymlink(resolvedPath: string, displayPath: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedPath);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) {
    throw new PathEscapeError(`拒绝操作符号链接：${displayPath}`);
  }
}
