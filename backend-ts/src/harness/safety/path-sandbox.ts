import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';

export class PathSandbox {
  private readonly workspaceRoot: string;
  private readonly allowedRoots = new Set<string>();

  constructor(workspaceRoot: string) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    try {
      mkdirSync(this.workspaceRoot, { recursive: true });
    } catch {
      // ignore
    }
  }

  /** 允许解析到显式登记的额外根（如会话 runtime incoming 目录），须位于该根之下。 */
  addAllowedRoot(root: string): void {
    this.allowedRoots.add(path.resolve(root));
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
    return path.isAbsolute(userPath) ? path.resolve(userPath) : path.resolve(root, userPath);
  }

  private isUnderAllowedRoot(resolved: string): boolean {
    for (const allowed of this.allowedRoots) {
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
