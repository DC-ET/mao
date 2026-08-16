import { chmodSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import type { ActivityService } from '../session/activity.service.js';
import type { GitCredentialLookup, Session } from '../session/types.js';
import {
  GitCommitMessageService,
  MAX_DIFF_BYTES,
  type CommitFile,
  type CommitGenerationInput,
} from './git-commit-message.service.js';
import type { GitChangedFileDTO, GitStatusDTO, WorkspaceGitService } from './workspace-git.service.js';

const TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;
const SENSITIVE_NAME = /(^|\/)(\.env($|\.)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?$)|(\.(pem|key|p12|pfx)$)|((^|\/)[^/]*(credential|credentials|secret|secrets|token)[^/]*$)/i;
const CREDENTIAL_URL = /(https?:\/\/)([^/@\s]+@)/gi;

export const ASKPASS = `#!/bin/bash
PROMPT="$1"
if echo "$PROMPT" | grep -qi 'username'; then
  echo "oauth2"
  exit 0
fi
URL=$(echo "$PROMPT" | sed -n "s/.*'https:\\/\\/\\([^']*\\)'.*/\\1/p")
if [ -z "$URL" ]; then
  URL=$(echo "$PROMPT" | sed -n "s/.*'http:\\/\\/\\([^']*\\)'.*/\\1/p")
fi
if [ -z "$URL" ]; then
  exit 1
fi
HOST="\${URL##*@}"
HOST="\${HOST%%/*}"
VARNAME="GIT_TOKEN_$(echo "$HOST" | tr '.-' '__')"
VALUE="\${!VARNAME}"
if [ -n "$VALUE" ]; then
  echo "$VALUE"
fi
`;

export interface GitOperationResult {
  success: boolean;
  operation: string;
  message?: string;
  error?: string;
  branch?: string | null;
  commitHash?: string;
  commitTitle?: string;
  stashRef?: string;
  conflict?: boolean;
}

export interface LocalGitActivity {
  operation: string;
  repoPath?: string;
  success: boolean;
  branch?: string;
  commitHash?: string;
  commitTitle?: string;
  stashRef?: string;
  conflict?: boolean;
  durationMs?: number;
  error?: string;
}

export function envVarNameForDomain(domain: string): string {
  return `GIT_TOKEN_${domain.replace(/\./g, '_').replace(/-/g, '_')}`;
}

export class GitWriteOperationService {
  private readonly locks = new Map<string, boolean>();

  constructor(
    private readonly workspaceGitService: WorkspaceGitService,
    private readonly commitMessageService: GitCommitMessageService,
    private readonly credentialService: GitCredentialLookup,
    private readonly runtimeDataResolver: RuntimeDataResolver,
    private readonly activityService: ActivityService,
  ) {}

  async commit(session: Session, repoPath?: string | null): Promise<GitOperationResult> {
    return this.locked(session, repoPath, 'commit', async (repo) => {
      const changes = await this.workspaceGitService.changedFiles(repo);
      if (changes.size === 0) throw new BusinessException(ErrorCode.PARAM_INVALID, '没有待提交的变更');
      const generated = await this.commitMessageService.generate(session, await this.buildCommitInput(repo, changes));
      const add = await this.run(repo, ['add', '-A'], {});
      requireSuccess(add, '暂存变更失败');
      const args: string[] = [];
      const hasName = (await this.run(repo, ['config', '--get', 'user.name'], {})).success;
      const hasEmail = (await this.run(repo, ['config', '--get', 'user.email'], {})).success;
      if (!hasName) { args.push('-c', 'user.name=Mao Agent'); }
      if (!hasEmail) { args.push('-c', 'user.email=mao@etarch.cn'); }
      args.push('commit', '--no-verify', '-m', generated.message);
      const commit = await this.run(repo, args, {});
      requireSuccess(commit, '提交失败');
      const hash = requireOutput(await this.run(repo, ['rev-parse', '--short', 'HEAD'], {}), '读取提交哈希失败');
      const branch = await this.branch(repo);
      const result = successResult('commit', branch, `提交成功 ${hash}：${generated.title}`);
      result.commitHash = hash;
      result.commitTitle = generated.title;
      return result;
    });
  }

  async refreshRemoteStatus(session: Session, repoPath?: string | null): Promise<GitStatusDTO> {
    const repo = await this.resolveRepository(session, repoPath);
    if (this.locks.get(repo)) throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git 操作进行中');
    this.locks.set(repo, true);
    try {
      const state = await this.remoteState(repo);
      const remote = await this.selectRefreshRemote(repo, state);
      if (remote == null) {
        const status = await this.workspaceGitService.getStatus(session.workspace!, repoPath);
        status.remoteStatusAvailable = false;
        status.remoteStatusError = state.remotes.length === 0
          ? '仓库未配置远端'
          : '存在多个远端且没有 origin，无法确认远端状态';
        return status;
      }
      const fetch = await this.run(repo, ['fetch', '--prune', remote], await this.credentialEnv(session));
      const status = await this.workspaceGitService.getStatus(session.workspace!, repoPath);
      if (fetch.success) {
        status.remoteStatusAvailable = true;
        status.remoteStatusError = undefined;
        status.hasCommitsToPush = await this.hasCommitsToPush(repo, status, remote);
      } else {
        status.remoteStatusAvailable = false;
        status.remoteStatusError = classify(fetch, '远端状态刷新失败');
      }
      return status;
    } finally {
      this.locks.set(repo, false);
    }
  }

  async pull(session: Session, repoPath?: string | null): Promise<GitOperationResult> {
    return this.locked(session, repoPath, 'pull', async (repo) => {
      const state = await this.remoteState(repo);
      this.requirePullPushState(state);
      const operationId = randomUUID();
      let stashOid: string | null = null;
      let stashRef: string | null = null;
      if (await this.hasChanges(repo)) {
        const stash = await this.run(repo, ['stash', 'push', '--include-untracked', '-m', `mao-auto-pull-${operationId}`], {});
        requireSuccess(stash, '自动 stash 创建失败');
        stashOid = requireOutput(await this.run(repo, ['rev-parse', 'stash@{0}'], {}), '读取 stash 失败');
        stashRef = await this.findStashRef(repo, stashOid);
      }
      const pull = await this.run(repo, ['pull', '--no-edit'], await this.credentialEnv(session));
      const pullConflict = await this.hasConflicts(repo);
      const mergeInProgress = (await this.run(repo, ['rev-parse', '--verify', '-q', 'MERGE_HEAD'], {})).success;
      if (!pull.success) {
        if (pullConflict || mergeInProgress) {
          throw new GitOperationException(`拉取进入未完成合并状态，已保留合并现场和 ${safeStash(stashRef, stashOid)}`, true, stashRef, pull);
        }
        if (stashOid != null) await this.restoreStash(repo, stashOid, stashRef);
        throw new GitOperationException(classify(pull, '拉取失败'), false, null, pull);
      }
      if (stashOid != null) await this.restoreStash(repo, stashOid, stashRef);
      return successResult('pull', state.branch, pull.output.includes('Already up to date') ? '已是最新状态' : '当前分支已更新');
    });
  }

  async push(session: Session, repoPath?: string | null): Promise<GitOperationResult> {
    return this.locked(session, repoPath, 'push', async (repo) => {
      const state = await this.remoteState(repo);
      this.requirePullPushState(state);
      let args: string[];
      if (state.upstream != null) {
        args = ['push'];
      } else {
        let remote: string;
        if (state.remotes.includes('origin')) remote = 'origin';
        else if (state.remotes.length === 1) remote = state.remotes[0];
        else throw new BusinessException(ErrorCode.PARAM_INVALID, '存在多个远端且没有 origin，请先配置 upstream');
        args = ['push', '--set-upstream', remote, state.branch ?? ''];
      }
      const push = await this.run(repo, args, await this.credentialEnv(session));
      if (!push.success) throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(push, '推送失败'));
      return successResult('push', state.branch, '当前分支已推送');
    });
  }

  async recordLocalActivity(session: Session, request: LocalGitActivity | null): Promise<void> {
    if (request == null || !['commit', 'pull', 'push'].includes(request.operation)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git 操作类型无效');
    }
    const type = `GIT_${request.operation.toUpperCase()}`;
    const detail: Record<string, unknown> = {
      repoPath: limited(request.repoPath, 256),
      branch: limited(request.branch, 256),
      commitHash: limited(request.commitHash, 64),
      commitTitle: limited(request.commitTitle, 512),
      stashRef: limited(request.stashRef, 128),
      conflict: request.conflict === true,
      error: sanitize(request.error),
    };
    await this.record(session.id!, type, request.repoPath ?? null, request.success, request.durationMs ?? null, detail);
  }

  async buildCommitInput(repo: string, changes: Map<string, GitChangedFileDTO>): Promise<CommitGenerationInput> {
    const files: CommitFile[] = [];
    const eligible: Array<{ file: CommitFile; diff: string }> = [];
    for (const changed of changes.values()) {
      const file: CommitFile = {
        path: changed.path,
        changeType: changed.changeType,
        insertions: changed.insertions,
        deletions: changed.deletions,
        binary: changed.binary === true,
        sensitive: isSensitive(changed.path) || isSensitive(changed.oldPath ?? null),
      };
      files.push(file);
      if (!file.binary && !file.sensitive) {
        eligible.push({ file, diff: await this.readDiff(repo, changed) });
      }
    }
    const quota = eligible.length === 0 ? 0 : Math.floor(MAX_DIFF_BYTES / eligible.length);
    let bytes = 0;
    let truncated = false;
    for (const raw of eligible) {
      const source = Buffer.from(raw.diff, 'utf8');
      const allowance = Math.min(quota, MAX_DIFF_BYTES - bytes);
      const value = utf8Prefix(source, allowance);
      raw.file.diff = value;
      const used = Buffer.byteLength(value, 'utf8');
      bytes += used;
      if (used < source.length) {
        raw.file.truncated = true;
        truncated = true;
      }
    }
    return { files, diffBytes: bytes, truncated };
  }

  private async readDiff(repo: string, file: GitChangedFileDTO): Promise<string> {
    if (file.untracked === true) {
      const path = resolve(repo, file.path);
      if (!path.startsWith(resolve(repo)) || !existsSync(path) || !statSync(path).isFile()) return '';
      try {
        const bytes = readFileSync(path).subarray(0, MAX_DIFF_BYTES + 1);
        return `--- /dev/null\n+++ b/${file.path}\n${bytes.toString('utf8')}`;
      } catch {
        return '';
      }
    }
    let result = await this.run(repo, ['diff', 'HEAD', '--', file.path], {});
    if (!result.success) result = await this.run(repo, ['diff', '--cached', '--', file.path], {});
    return result.success ? result.output : '';
  }

  private async locked(session: Session, repoPath: string | null | undefined, operation: string, action: (repo: string) => Promise<GitOperationResult>): Promise<GitOperationResult> {
    const repo = await this.resolveRepository(session, repoPath);
    if (this.locks.get(repo)) throw new BusinessException(ErrorCode.PARAM_INVALID, 'Git 操作进行中');
    this.locks.set(repo, true);
    const started = Date.now();
    try {
      const result = await action(repo);
      await this.recordOperation(session, repoPath, result, started);
      return result;
    } catch (e) {
      if (e instanceof GitOperationException) {
        const result = failedResult(operation, e.message);
        result.conflict = e.conflict;
        result.stashRef = e.stashRef ?? undefined;
        await this.recordOperation(session, repoPath, result, started);
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, e.message);
      }
      if (e instanceof BusinessException) {
        const result = failedResult(operation, sanitize(e.message) ?? e.message);
        await this.recordOperation(session, repoPath, result, started);
        throw e;
      }
      throw e;
    } finally {
      this.locks.set(repo, false);
    }
  }

  private async restoreStash(repo: string, oid: string, stashRef: string | null): Promise<void> {
    const apply = await this.run(repo, ['stash', 'apply', '--index', oid], {});
    if (!apply.success || await this.hasConflicts(repo)) {
      throw new GitOperationException(`stash 恢复产生冲突或失败，已保留 ${safeStash(stashRef, oid)}`, true, stashRef, apply);
    }
    const currentRef = await this.findStashRef(repo, oid);
    if (currentRef != null) {
      const drop = await this.run(repo, ['stash', 'drop', currentRef], {});
      requireSuccess(drop, `stash 已恢复但清理失败，请手动删除 ${currentRef}`);
    }
  }

  private async resolveRepository(session: Session, repoPath?: string | null): Promise<string> {
    try {
      return realpathSync(await this.workspaceGitService.resolveRepository(session.workspace!, repoPath));
    } catch (e) {
      if (e instanceof BusinessException) throw e;
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '仓库路径解析失败');
    }
  }

  private async selectRefreshRemote(repo: string, state: RemoteState): Promise<string | null> {
    if (state.upstream != null) {
      const upstreamRemote = output(await this.run(repo, ['config', '--get', `branch.${state.branch}.remote`], {}));
      if (upstreamRemote != null && state.remotes.includes(upstreamRemote)) return upstreamRemote;
    }
    if (state.remotes.includes('origin')) return 'origin';
    return state.remotes.length === 1 ? state.remotes[0] : null;
  }

  private async remoteState(repo: string): Promise<RemoteState> {
    const branch = output(await this.run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], {}));
    const detached = branch === 'HEAD' && !(await this.run(repo, ['symbolic-ref', '-q', 'HEAD'], {})).success;
    const remoteOutput = output(await this.run(repo, ['remote'], {}));
    const remotes = remoteOutput == null || remoteOutput.trim().length === 0
      ? []
      : remoteOutput.split('\n').map((s) => s.trim()).filter((s) => s.length > 0).sort();
    const upstream = output(await this.run(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], {}));
    return { branch, detached, remotes, upstream };
  }

  private async hasCommitsToPush(repo: string, status: GitStatusDTO, remote: string): Promise<boolean> {
    if (!status.hasHead) return false;
    if (status.upstream != null) return status.aheadCount != null && status.aheadCount > 0;
    const branch = status.branch;
    if (branch == null || branch.trim().length === 0) return false;
    const remoteBranch = await this.run(repo, ['rev-parse', '--verify', '-q', `refs/remotes/${remote}/${branch}`], {});
    if (!remoteBranch.success) return true;
    const counts = await this.run(repo, ['rev-list', '--left-right', '--count', `HEAD...refs/remotes/${remote}/${branch}`], {});
    if (!counts.success) return false;
    const parts = counts.output.trim().split(/\s+/);
    return parts.length === 2 && Number.parseInt(parts[0], 10) > 0;
  }

  private requirePullPushState(state: RemoteState): void {
    if (state.detached) throw new BusinessException(ErrorCode.PARAM_INVALID, 'detached HEAD，请先切换分支');
    if (state.remotes.length === 0) throw new BusinessException(ErrorCode.PARAM_INVALID, '仓库未配置远端');
  }

  private async credentialEnv(session: Session): Promise<Record<string, string>> {
    const tokens = await this.credentialService.getTokenMapByUser(session.userId);
    const env: Record<string, string> = { GIT_TERMINAL_PROMPT: '0' };
    if (Object.keys(tokens).length === 0) return env;
    try {
      const script = this.runtimeDataResolver.resolveGitAskpassScript(session.userId, session.id!);
      mkdirSync(dirname(script), { recursive: true });
      writeFileSync(script, ASKPASS, 'utf8');
      try {
        chmodSync(script, 0o700);
      } catch {
        // non-posix
      }
      env.GIT_ASKPASS = script;
      for (const [domain, token] of Object.entries(tokens)) {
        env[envVarNameForDomain(domain)] = token;
      }
      return env;
    } catch {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, 'Git 凭证环境初始化失败');
    }
  }

  private run(repo: string, args: string[], extraEnv: Record<string, string>): Promise<GitResult> {
    return new Promise((resolveP) => {
      const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
        cwd: repo,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: Buffer[] = [];
      let size = 0;
      const onData = (buf: Buffer) => {
        if (size >= MAX_OUTPUT_BYTES) return;
        const allowed = Math.min(buf.length, MAX_OUTPUT_BYTES - size);
        chunks.push(buf.subarray(0, allowed));
        size += allowed;
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveP({ exitCode: 124, output: 'Git 子进程 60 秒超时', success: false });
      }, TIMEOUT_SECONDS * 1000);
      child.on('error', () => {
        clearTimeout(timer);
        resolveP({ exitCode: 127, output: 'Git 子进程执行失败', success: false });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const output = Buffer.concat(chunks).toString('utf8');
        resolveP({ exitCode: code ?? 1, output, success: code === 0 });
      });
    });
  }

  private async hasChanges(repo: string): Promise<boolean> {
    const status = output(await this.run(repo, ['status', '--porcelain', '--untracked-files=all'], {}));
    return status != null && status.trim().length > 0;
  }

  private async hasConflicts(repo: string): Promise<boolean> {
    const out = output(await this.run(repo, ['diff', '--name-only', '--diff-filter=U'], {}));
    return out != null && out.trim().length > 0;
  }

  private async branch(repo: string): Promise<string | null> {
    return output(await this.run(repo, ['rev-parse', '--abbrev-ref', 'HEAD'], {}));
  }

  private async findStashRef(repo: string, oid: string): Promise<string | null> {
    const list = output(await this.run(repo, ['stash', 'list', '--format=%H %gd'], {}));
    if (list == null) return null;
    for (const line of list.split('\n')) {
      if (line.startsWith(`${oid} `)) return line.slice(oid.length + 1).trim();
    }
    return null;
  }

  private async recordOperation(session: Session, repoPath: string | null | undefined, result: GitOperationResult, started: number): Promise<void> {
    const detail: Record<string, unknown> = {
      repoPath: repoPath ?? '',
      operation: result.operation,
      branch: result.branch,
      commitHash: result.commitHash,
      commitTitle: result.commitTitle,
      stashRef: result.stashRef,
      conflict: result.conflict === true,
      error: sanitize(result.error),
    };
    await this.record(session.id!, `GIT_${result.operation.toUpperCase()}`, repoPath ?? null, result.success, Date.now() - started, detail);
  }

  private async record(sessionId: number, type: string, target: string | null, success: boolean, duration: number | null, detail: Record<string, unknown>): Promise<void> {
    try {
      await this.activityService.record(
        sessionId, type, limited(target, 256), success ? 'Git 操作成功' : 'Git 操作失败',
        JSON.stringify(detail), success ? 'SUCCESS' : 'ERROR', duration,
      );
    } catch (e) {
      console.warn(`Failed to record Git activity for session ${sessionId}: ${(e as Error).message}`);
    }
  }
}

interface GitResult { exitCode: number; output: string; success: boolean }
interface RemoteState { branch: string | null; detached: boolean; remotes: string[]; upstream: string | null }

class GitOperationException extends Error {
  constructor(message: string, readonly conflict: boolean, readonly stashRef: string | null, result: GitResult) {
    super(message + (result.output.trim().length === 0 ? '' : `：${sanitize(result.output)}`));
    this.name = 'GitOperationException';
  }
}

export function isSensitive(path: string | null | undefined): boolean {
  return path != null && SENSITIVE_NAME.test(path.replace(/\\/g, '/'));
}

function utf8Prefix(source: Buffer, max: number): string {
  let end = Math.min(source.length, Math.max(max, 0));
  while (end > 0 && (source[end - 1] & 0xc0) === 0x80) end--;
  return source.subarray(0, end).toString('utf8');
}

function output(result: GitResult): string | null {
  return result.success ? result.output.trim() : null;
}

function requireOutput(result: GitResult, message: string): string {
  requireSuccess(result, message);
  return result.output.trim();
}

function requireSuccess(result: GitResult, message: string): void {
  if (!result.success) throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(result, message));
}

function classify(result: GitResult, fallback: string): string {
  const lower = result.output.toLowerCase();
  if (result.exitCode === 124) return 'Git 子进程 60 秒超时';
  if (lower.includes('index.lock')) return 'Git index lock 被其他进程占用';
  if (lower.includes('authentication failed') || lower.includes('could not read username') || lower.includes('permission denied')) {
    return 'Git 认证失败或凭证缺失';
  }
  if (lower.includes('non-fast-forward') || lower.includes('fetch first')) return '推送被拒绝（non-fast-forward），请先拉取处理';
  if (lower.includes('could not resolve host') || lower.includes('unable to access') || lower.includes('timed out')) {
    return '远端不可达或网络超时';
  }
  return fallback + (result.output.trim().length === 0 ? '' : `：${sanitize(result.output)}`);
}

function sanitize(value: string | null | undefined): string | null {
  if (value == null) return null;
  const clean = value.replace(CREDENTIAL_URL, '$1***@').replace(/(token|password|authorization)[=: ]+[^\s]+/gi, '$1=***').trim();
  return limited(clean, MAX_ERROR_LENGTH);
}

function limited(value: string | null | undefined, max: number): string | null {
  if (value == null) return null;
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function safeStash(ref: string | null, oid: string | null): string {
  if (ref != null) return ref;
  return oid != null ? `stash ${limited(oid, 12)}` : '当前本地变更';
}

function successResult(operation: string, branch: string | null | undefined, message: string): GitOperationResult {
  return { success: true, operation, branch, message };
}

function failedResult(operation: string, error: string): GitOperationResult {
  return { success: false, operation, error };
}
