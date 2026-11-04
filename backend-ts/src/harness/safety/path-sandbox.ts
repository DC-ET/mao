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
  /**
   * 执行身份诊断（技术方案 2026-11-04 §5.9 第 2 条）：容器侧专用。路径越界且命中
   * 「他人运行目录/他人产物目录」时给出专属文案（可被模型正确解释），其余越界保持原样。
   */
  identity?: PathSandboxIdentity | null;
}

export interface PathSandboxIdentity {
  /** 运行目录根（{runtimeDir}）：识别 runtime/{他人 uid}。 */
  runtimeRoot?: string | null;
  /** 图片产物根（{uploadDir}）：识别 uploads/{他人 uid}。 */
  uploadDir?: string | null;
  /** 当前执行身份 userId（容器归属用户）。 */
  userId: number;
}

export class PathSandbox {
  private readonly workspaceRoot: string;
  private readonly allowedRoots = new Set<string>();
  private readonly allowedRealRoots = new Set<string>();
  private readonly strict: boolean;
  private readonly identity: PathSandboxIdentity | null;

  constructor(workspaceRoot: string, options: PathSandboxOptions = {}) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.strict = options.strict === true;
    this.identity = options.identity ?? null;
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

    // 执行身份诊断（技术方案 2026-11-04 §5.9 第 2 条）：他人运行目录/产物目录给专属文案。
    const foreign = this.describeForeignPath(resolved);
    if (foreign != null) {
      harnessLog('warn', `Path escape attempt blocked (foreign member path): ${resolved}`);
      throw new SecurityException(foreign);
    }
    harnessLog('warn', `Path escape attempt blocked: ${userPath} (resolved to ${resolved})`);
    throw new SecurityException('Path escape attempt: ' + userPath);
  }

  /** 命中「他人 runtime/uploads 目录」时的专属文案；非跨成员路径返回 null（保持原文案）。 */
  private describeForeignPath(resolved: string): string | null {
    const identity = this.identity;
    if (identity == null) return null;
    const uid = String(identity.userId);
    const firstSegmentOf = (root: string | null | undefined): string | null => {
      if (root == null || root === '') return null;
      const rel = path.relative(path.resolve(root), resolved);
      if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null;
      return rel.split(path.sep)[0] ?? null;
    };
    const runtimeFirst = firstSegmentOf(identity.runtimeRoot);
    if (runtimeFirst != null && runtimeFirst !== uid) {
      return `该路径属于其他用户的会话运行目录（当前执行身份 ${identity.userId}），本地不可访问: ${resolved}`;
    }
    const uploadFirst = firstSegmentOf(identity.uploadDir);
    if (uploadFirst != null && uploadFirst !== uid) {
      return `该文件属于其他成员的产物目录（当前执行身份 ${identity.userId}），本地不可访问；`
        + `如需转发，请让该成员本人操作，或改用公开 URL 方式: ${resolved}`;
    }
    return null;
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
