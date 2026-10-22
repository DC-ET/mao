import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';

export interface PathSandboxOptions {
  /**
   * 严格模式（容器内专用，技术方案 §5.5/§5.6）：resolveLenient 退化为与 resolve
   * 同口径（绝对路径只放行允许根内），并对已存在的目标路径补 realpathSync 校验
   * 防符号链接逃逸。宿主机模式保持 false（现状行为零变化）。
   */
  strict?: boolean;
}

export class PathSandbox {
  private readonly workspaceRoot: string;
  private readonly allowedRoots = new Set<string>();
  private readonly allowedRealRoots = new Set<string>();
  private readonly strict: boolean;

  constructor(workspaceRoot: string, options: PathSandboxOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.strict = options.strict === true;
    try {
      mkdirSync(this.workspaceRoot, { recursive: true });
    } catch {
      // ignore
    }
  }

  /** 允许解析到显式登记的额外根（如会话 runtime incoming 目录），须位于该根之下。 */
  addAllowedRoot(root: string): void {
    const resolved = path.resolve(root);
    this.allowedRoots.add(resolved);
    this.allowedRealRoots.add(realPathOrSelf(resolved));
  }

  resolve(userPath: string, sessionWorkspace?: string | null): string {
    if (userPath == null || userPath === '') {
      throw new IllegalArgumentException('Path cannot be empty');
    }
    if (userPath.startsWith('~')) {
      throw new SecurityException('Tilde paths are not supported on server: ' + userPath);
    }

    const root = sessionWorkspace != null && sessionWorkspace !== ''
      ? path.resolve(sessionWorkspace)
      : this.workspaceRoot;

    const resolved = path.isAbsolute(userPath)
      ? path.resolve(userPath)
      : path.resolve(root, userPath);

    if (isUnder(resolved, root) || this.isUnderAllowedRoot(resolved)) {
      return resolved;
    }

    harnessLog('warn', `Path escape attempt blocked: ${userPath} (resolved to ${resolved})`);
    throw new SecurityException('Path escape attempt: ' + userPath);
  }

  resolveLenient(userPath: string, sessionWorkspace?: string | null): string {
    if (userPath == null || userPath === '') {
      throw new IllegalArgumentException('Path cannot be empty');
    }
    if (userPath.startsWith('~')) {
      throw new SecurityException('Tilde paths are not supported on server: ' + userPath);
    }
    const root = this.getEffectiveWorkspaceRoot(sessionWorkspace);
    if (this.strict) {
      // 容器内严格口径：走 resolve（绝对路径只放行允许根内），再补符号链接校验
      const resolved = this.resolve(userPath, sessionWorkspace);
      this.assertNoSymlinkEscape(resolved, root);
      return resolved;
    }
    return path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(root, userPath);
  }

  /**
   * 逐段检查路径上的符号链接：最终节点与中间目录都要校验 realpath 后仍在根内
   * （§5.6：容器内 root + DAC_OVERRIDE 使权限位失效，符号链接是主要逃逸面）。
   * 只 lstat 最终节点会漏掉 `workspace/link -> /outside` 这类父目录逃逸。
   */
  private assertNoSymlinkEscape(resolved: string, root: string): void {
    const bases = [path.resolve(root), ...this.allowedRoots];
    const base = bases
      .filter((candidate) => isUnder(resolved, candidate))
      .sort((a, b) => b.length - a.length)[0];
    if (base == null) return;
    const baseReal = realPathOrSelf(base);
    let current = base;
    for (const segment of path.relative(base, resolved).split(path.sep)) {
      if (segment === '') continue;
      current = path.join(current, segment);
      let st;
      try {
        st = lstatSync(current);
      } catch {
        // 当前段及其后都不存在：词法校验已通过，不存在可逃逸的链接
        return;
      }
      if (!st.isSymbolicLink()) continue;
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        // 悬空链接：目标不存在，后续 fs 操作会自然失败
        continue;
      }
      if (isUnder(real, base) || isUnder(real, baseReal) || this.isUnderAllowedRoot(real)) continue;
      harnessLog('warn', `Symlink escape attempt blocked: ${resolved} -> ${real}`);
      throw new SecurityException('Path escape attempt (symlink): ' + resolved);
    }
  }

  private isUnderAllowedRoot(resolved: string): boolean {
    for (const allowed of this.allowedRoots) {
      if (isUnder(resolved, allowed)) return true;
    }
    for (const allowed of this.allowedRealRoots) {
      if (isUnder(resolved, allowed)) return true;
    }
    return false;
  }

  resolveAsFile(userPath: string): string {
    return this.resolve(userPath);
  }

  getEffectiveWorkspaceRoot(sessionWorkspace?: string | null): string {
    if (sessionWorkspace != null && sessionWorkspace !== '') {
      return path.resolve(sessionWorkspace);
    }
    return this.workspaceRoot;
  }

  getWorkspaceRoot(): string {
    return this.workspaceRoot;
  }
}

export class IllegalArgumentException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IllegalArgumentException';
  }
}

export class SecurityException extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityException';
  }
}

export function isUnder(resolved: string, root: string): boolean {
  const rel = path.relative(root, resolved);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath，路径不存在时回退原值（用于根目录的真实路径比对）。 */
function realPathOrSelf(target: string): string {
  try {
    return realpathSync(target);
  } catch {
    return target;
  }
}
