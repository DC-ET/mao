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

const BASH_FALLBACK_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin'];

/** LOCAL shell 工具固定 spawn bash（vendor/localShell.cjs），因此这里解析的就是实际执行体。 */
export function findBash(): string | null {
  const exeName = process.platform === 'win32' ? 'bash.exe' : 'bash';
  const fromPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...fromPath, ...BASH_FALLBACK_DIRS]) {
    const candidate = path.join(dir, exeName);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // 继续找下一个候选
    }
  }
  return null;
}

export function requireBash(): string {
  const bash = findBash();
  if (!bash) {
    throw new Error('LOCAL shell 工具需要 bash，但当前 PATH 与常见安装目录中都没找到可执行的 bash，请先安装 bash 后重试');
  }
  return bash;
}

export function detectShell(): string {
  return findBash() ?? 'bash（未找到，LOCAL shell 工具不可用）';
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
