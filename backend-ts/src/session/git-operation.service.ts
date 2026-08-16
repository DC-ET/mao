import { spawn } from 'node:child_process';
import type { GitCredentialLookup } from './types.js';
import { GitCloneErrorFormatter } from './util/git-clone-error-formatter.js';
import { GitUrlParser } from './util/git-url-parser.js';

const CLONE_TIMEOUT_SECONDS = 120;

export interface GitCloneResult {
  success: boolean;
  error: string | null;
}

export class GitOperationService {
  constructor(private readonly gitCredentialService: GitCredentialLookup) {}

  async clone(url: string, branch: string | null | undefined, targetDir: string, userId: number | null): Promise<GitCloneResult> {
    GitUrlParser.validate(url);
    const effectiveUrl = userId != null ? await this.injectUserToken(url, userId) : url;

    const command = ['git', 'clone', '--depth', '1'];
    if (branch != null && branch.trim().length > 0) {
      command.push('--branch', branch);
    }
    command.push(effectiveUrl, targetDir);

    console.info(`Starting git clone: ${maskToken(effectiveUrl)} → ${targetDir} (branch: ${branch && branch.trim() ? branch : 'default'})`);

    try {
      const { exitCode, output } = await runProcess(command, CLONE_TIMEOUT_SECONDS * 1000);
      if (exitCode === null) {
        console.warn(`Git clone timeout for ${maskToken(effectiveUrl)} after ${CLONE_TIMEOUT_SECONDS}s`);
        return failed(GitCloneErrorFormatter.toUserMessage(`Git clone timeout (>${CLONE_TIMEOUT_SECONDS}s)`));
      }
      if (exitCode === 0) {
        console.info(`Git clone succeeded: ${maskToken(effectiveUrl)} → ${targetDir}`);
        return { success: true, error: null };
      }
      const tail = extractTail(output, 500);
      console.warn(`Git clone failed for ${maskToken(effectiveUrl)}: exit=${exitCode}, output=${tail}`);
      return failed(GitCloneErrorFormatter.toUserMessage(`Git clone failed: ${tail}`));
    } catch (e) {
      if ((e as Error).message === 'interrupted') {
        return failed(GitCloneErrorFormatter.toUserMessage('Git clone interrupted'));
      }
      console.error(`Git clone IO error for ${maskToken(effectiveUrl)}: ${(e as Error).message}`);
      return failed(GitCloneErrorFormatter.toUserMessage(`Git clone error: ${(e as Error).message}`));
    }
  }

  private async injectUserToken(url: string, userId: number): Promise<string> {
    const tokenMap = await this.gitCredentialService.getTokenMapByUser(userId);
    if (Object.keys(tokenMap).length === 0) {
      return url;
    }
    const host = GitUrlParser.extractHost(url);
    const token = tokenMap[host];
    if (token == null || token.trim().length === 0) {
      return url;
    }
    return injectHttpsToken(url, token);
  }
}

export function injectHttpsToken(url: string, token: string): string {
  if (!url.startsWith('https://')) {
    return url;
  }
  const remainder = url.slice('https://'.length);
  const slashIdx = remainder.indexOf('/');
  const atIdx = remainder.indexOf('@');
  if (atIdx >= 0 && (slashIdx < 0 || atIdx < slashIdx)) {
    return url;
  }
  const encodedToken = encodeURIComponent(token).replace(/\+/g, '%20');
  return `https://oauth2:${encodedToken}@${remainder}`;
}

export function maskToken(url: string | null | undefined): string {
  if (url == null) {
    return '';
  }
  return url.replace(/https:\/\/oauth2:[^@]+@/g, 'https://oauth2:***@');
}

function failed(error: string): GitCloneResult {
  return { success: false, error };
}

function extractTail(output: string, maxLen: number): string {
  if (!output || output.trim().length === 0) return '';
  const trimmed = output.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return `...${trimmed.slice(trimmed.length - maxLen)}`;
}

function runProcess(command: string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const onData = (buf: Buffer) => {
      output += buf.toString();
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ exitCode: null, output });
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output });
    });
  });
}

export const GitCloneResult = {
  ok: (): GitCloneResult => ({ success: true, error: null }),
  failed,
};
