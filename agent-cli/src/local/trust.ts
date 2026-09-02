import fs from 'node:fs';
import path from 'node:path';
import { loadUserConfig, saveUserConfig } from '../config/config-store';
import { isUnder, realpathBoundary } from './sandbox';

export function listTrustedWorkspaces(): string[] {
  return (loadUserConfig().trustedWorkspaces ?? []).map((p) => path.resolve(p));
}

/**
 * 信任判定在 realpath 之后做：工作区内的软链目录指向外部时，
 * 纯字符串前缀比较会把外部目录也算成已信任。
 */
export function isWorkspaceTrusted(workspace: string | undefined): boolean {
  if (!workspace) return false;
  const resolved = realpathBoundary(workspace);
  return listTrustedWorkspaces().some((trusted) => isUnder(resolved, realpathBoundary(trusted)));
}

export function addTrustedWorkspace(workspace: string): void {
  const resolved = realpathBoundary(workspace);
  const current = listTrustedWorkspaces();
  if (current.some((trusted) => realpathBoundary(trusted) === resolved)) return;
  saveUserConfig({ trustedWorkspaces: [...current, resolved] });
}

export function workspaceExists(workspace: string): boolean {
  try {
    return fs.statSync(path.resolve(workspace)).isDirectory();
  } catch {
    return false;
  }
}
