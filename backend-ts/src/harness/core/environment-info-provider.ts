import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { hasText } from '../../common/case.js';
import type { Session } from '../deps.js';

const execFileAsync = promisify(execFile);

export interface EnvironmentInfo {
  isGit?: boolean | null;
  platform?: string | null;
  shell?: string | null;
  osVersion?: string | null;
}

export class EnvironmentInfoProvider {
  async detect(workspace: string | null | undefined): Promise<EnvironmentInfo> {
    return {
      isGit: this.isGitWorkspace(workspace),
      platform: this.normalizePlatform(os.platform()),
      shell: this.resolveShell(),
      osVersion: await this.buildOsVersion(),
    };
  }

  async fromSessionOrDetect(session: Session): Promise<EnvironmentInfo> {
    if (session.executionMode?.toUpperCase() === 'LOCAL') {
      return {
        isGit: session.isGit === true || session.isGit === 1,
        platform: session.platform,
        shell: session.shellPath,
        osVersion: session.osVersion,
      };
    }
    const detected = await this.detect(session.workspace);
    return {
      isGit: session.isGit != null ? (session.isGit === true || session.isGit === 1) : detected.isGit,
      platform: hasText(session.platform) ? session.platform : detected.platform,
      shell: hasText(session.shellPath) ? session.shellPath : detected.shell,
      osVersion: hasText(session.osVersion) ? session.osVersion : detected.osVersion,
    };
  }

  private isGitWorkspace(workspace: string | null | undefined): boolean {
    if (!hasText(workspace)) return false;
    let current: string | null = path.resolve(workspace!);
    while (current) {
      if (existsSync(path.join(current, '.git'))) return true;
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    return false;
  }

  private normalizePlatform(osName: string): string {
    const normalized = (osName ?? '').toLowerCase();
    if (normalized.includes('mac') || normalized.includes('darwin')) return 'darwin';
    if (normalized.includes('win')) return 'win32';
    return 'linux';
  }

  private resolveShell(): string {
    const comspec = process.env.COMSPEC;
    if (hasText(comspec)) return comspec!;
    return this.normalizePlatform(os.platform()) === 'win32' ? 'cmd.exe' : 'bash';
  }

  private async buildOsVersion(): Promise<string> {
    const platform = this.normalizePlatform(os.platform());
    const osName = os.type();
    const osVersion = os.release();
    if (platform === 'darwin' || platform === 'linux') {
      const uname = await this.readUnameSr();
      if (hasText(uname)) return uname!;
    }
    if (platform === 'darwin') return 'Darwin ' + osVersion;
    if (platform === 'linux') return 'Linux ' + osVersion;
    return osName + ' ' + osVersion;
  }

  private async readUnameSr(): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('uname', ['-sr'], { timeout: 2000 });
      return stdout.trim().split('\n')[0] ?? null;
    } catch {
      return null;
    }
  }
}
