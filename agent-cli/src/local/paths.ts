import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RUNTIME_DIR } from '../config/config-store';

export function expandHome(filePath: string): string {
  if (!filePath) return filePath;
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/')) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

export function resolveRuntimeDir(sessionId: number): string {
  return path.join(RUNTIME_DIR, String(sessionId));
}

export function resolveSkillsDir(sessionId: number): string {
  return path.join(resolveRuntimeDir(sessionId), 'skills');
}

export function resolveShellOutputDir(sessionId: number): string {
  return path.join(resolveRuntimeDir(sessionId), 'shellOutput');
}

export function formatRuntimeDisplay(sessionId: number, ...segments: string[]): string {
  return ['~/.mao/agent-cli/runtime', String(sessionId), ...segments].join('/');
}

export function isUnderRuntime(absolutePath: string, sessionId: number): boolean {
  const runtimeDir = path.resolve(resolveRuntimeDir(sessionId));
  const resolved = path.resolve(absolutePath);
  return resolved === runtimeDir || resolved.startsWith(runtimeDir + path.sep);
}

export function resolveWorkspacePath(filePath: string, workspace: string | undefined, sessionId: number): string {
  const expanded = expandHome(filePath);
  if (path.isAbsolute(expanded)) {
    if (isUnderRuntime(expanded, sessionId)) return expanded;
    return expanded;
  }
  if (!workspace) return expanded;
  return path.join(workspace, expanded);
}

export function detectShell(): string {
  return process.env.SHELL || process.env.ComSpec || (process.platform === 'win32' ? 'cmd.exe' : '/bin/bash');
}

export function buildOsVersion(): string {
  if (process.platform === 'win32') return `${os.version()} ${os.release()}`;
  return `${os.type()} ${os.release()}`;
}

export function isGitWorkspace(workspace: string | undefined): boolean {
  if (!workspace) return false;
  let current = path.resolve(workspace);
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(path.join(current, '.git'))) return true;
    current = path.dirname(current);
  }
  return false;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}
