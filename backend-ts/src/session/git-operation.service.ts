import { spawn } from 'node:child_process';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { ASKPASS, envVarNameForDomain } from '../file/git-write-operation.service.js';
import type { GitCredentialLookup } from './types.js';
import { GitCloneErrorFormatter } from './util/git-clone-error-formatter.js';
import { GitUrlParser } from './util/git-url-parser.js';

const CLONE_TIMEOUT_SECONDS = 120;

export interface GitCloneResult {
  success: boolean;
  error: string | null;
}

/** 提供按「用户 / 会话」落地的 GIT_ASKPASS 脚本路径。 */
export interface GitAskpassPathResolver {
  resolveGitAskpassScript(userId: number, sessionId: number): string;
}

export class GitOperationService {
  constructor(
    private readonly gitCredentialService: GitCredentialLookup,
    private readonly runtimeResolver: GitAskpassPathResolver,
  ) {}

  /**
   * 克隆仓库。凭证一律经 GIT_ASKPASS + GIT_TOKEN_<域名> 环境变量提供，
   * 绝不拼进 clone URL —— 带凭证的 URL 会被 git 原样写进工作区 .git/config，
   * 且随日志/上下文外泄。
   */
  async clone(
    url: string,
    branch: string | null | undefined,
    targetDir: string,
    userId: number | null,
    sessionId: number | null,
  ): Promise<GitCloneResult> {
    GitUrlParser.validate(url);

    const command = ['git', 'clone', '--depth', '1'];
    if (branch != null && branch.trim().length > 0) {
      command.push('--branch', branch);
    }
    command.push(url, targetDir);

    const branchLabel = branch != null && branch.trim().length > 0 ? branch : 'default';
    console.info(`Starting git clone: ${url} → ${targetDir} (branch: ${branchLabel})`);

    try {
      const env = await this.credentialEnv(userId, sessionId);
      const { exitCode, output } = await runProcess(command, CLONE_TIMEOUT_SECONDS * 1000, env);
      if (exitCode === null) {
        console.warn(`Git clone timeout for ${url} after ${CLONE_TIMEOUT_SECONDS}s`);
        return failed(GitCloneErrorFormatter.toUserMessage(`Git clone timeout (>${CLONE_TIMEOUT_SECONDS}s)`));
      }
      if (exitCode === 0) {
        console.info(`Git clone succeeded: ${url} → ${targetDir}`);
        return { success: true, error: null };
      }
      const tail = extractTail(output, 500);
      console.warn(`Git clone failed for ${url}: exit=${exitCode}, output=${tail}`);
      return failed(GitCloneErrorFormatter.toUserMessage(`Git clone failed: ${tail}`));
    } catch (e) {
      if ((e as Error).message === 'interrupted') {
        return failed(GitCloneErrorFormatter.toUserMessage('Git clone interrupted'));
      }
      console.error(`Git clone IO error for ${url}: ${(e as Error).message}`);
      return failed(GitCloneErrorFormatter.toUserMessage(`Git clone error: ${(e as Error).message}`));
    }
  }

  /** 只注入 GIT_ASKPASS 与各域名的 GIT_TOKEN_<域名>，URL 保持无凭证。 */
  private async credentialEnv(userId: number | null, sessionId: number | null): Promise<NodeJS.ProcessEnv> {
    const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    if (userId == null) {
      return env;
    }
    const tokens = await this.gitCredentialService.getTokenMapByUser(userId);
    const entries = Object.entries(tokens ?? {});
    if (entries.length === 0) {
      return env;
    }
    const script = this.runtimeResolver.resolveGitAskpassScript(userId, sessionId ?? 0);
    mkdirSync(dirname(script), { recursive: true });
    writeFileSync(script, ASKPASS, 'utf8');
    try {
      chmodSync(script, 0o700);
    } catch {
      // non-posix
    }
    env.GIT_ASKPASS = script;
    for (const [domain, token] of entries) {
      env[envVarNameForDomain(domain)] = token;
    }
    return env;
  }
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

function runProcess(
  command: string[],
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
): Promise<{ exitCode: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], env });
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
