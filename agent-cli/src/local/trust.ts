import fs from 'node:fs';
import path from 'node:path';
import { loadUserConfig, saveUserConfig } from '../config/config-store';

export function listTrustedWorkspaces(): string[] {
  return (loadUserConfig().trustedWorkspaces ?? []).map((p) => path.resolve(p));
}

export function isWorkspaceTrusted(workspace: string | undefined): boolean {
  if (!workspace) return false;
  const resolved = path.resolve(workspace);
  return listTrustedWorkspaces().some((trusted) => resolved === trusted || resolved.startsWith(trusted + path.sep));
}

export function addTrustedWorkspace(workspace: string): void {
  const resolved = path.resolve(workspace);
  const current = listTrustedWorkspaces();
  if (current.includes(resolved)) return;
  saveUserConfig({ trustedWorkspaces: [...current, resolved] });
}

export function workspaceExists(workspace: string): boolean {
  try {
    return fs.statSync(path.resolve(workspace)).isDirectory();
  } catch {
    return false;
  }
}
