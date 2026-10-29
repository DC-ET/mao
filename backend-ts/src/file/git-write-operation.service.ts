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
  type CommitMessage,
} from './git-commit-message.service.js';
import type { GitChangedFileDTO, GitStatusDTO, WorkspaceGitService } from './workspace-git.service.js';
import { sanitizeCredentialUrl } from './workspace-git.service.js';

const TIMEOUT_SECONDS = 60;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_LENGTH = 500;
/** 用户提交信息长度上限，与 Electron 侧 gitOperations.cjs 同口径（64KB）。 */
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;
const SENSITIVE_NAME = /(^|\/)(\.env($|\.)|id_(rsa|dsa|ecdsa|ed25519)(\..*)?$)|(\.(pem|key|p12|pfx)$)|((^|\/)[^/]*(credential|credentials|secret|secrets|token)[^/]*$)/i;
/** 分支名合法性（git check-ref-format 子集）：禁空白 ~^:?*[\]、'..'、'@{'、首尾 '/'、'//'、结尾 '.'、组件首 '.'、组件尾 '.lock' */
const BRANCH_NAME_PATTERN = /^[A-Za-z0-9._/-]+$/;
const STASH_REF_PATTERN = /^stash@\{\d+\}$/;
const STASH_ACTIONS = ['apply', 'pop', 'drop'];
/** LOCAL 活动记录白名单：与 GitWriteOperationService 的写操作一一对应 */
const LOCAL_ACTIVITY_OPERATIONS = ['commit', 'pull', 'push', 'fetch', 'switch', 'stash'];

/** git 子进程超时（毫秒）。MAO_TEST_GIT_TIMEOUT_MS 仅供测试缩短挂起类用例的等待时间（小于 1s 视为无效）。 */
function gitTimeoutMs(): number {
  const override = Number(process.env.MAO_TEST_GIT_TIMEOUT_MS);
  return Number.isFinite(override) && override >= 1000 ? override : TIMEOUT_SECONDS * 1000;
}

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
  private readonly locks = new Map<string, Promise<void>>();

  constructor(
    private readonly workspaceGitService: WorkspaceGitService,
    private readonly commitMessageService: GitCommitMessageService,
    private readonly credentialService: GitCredentialLookup,
    private readonly runtimeDataResolver: RuntimeDataResolver,
    private readonly activityService: ActivityService,
  ) {}

  /**
   * 提交。传入 message 时直接用它（中央 Tab 两步提交的第二步，用户可在输入框编辑）；
   * 不传走后端 LLM 生成（侧边栏一步提交的既有口径）。
   */
  async commit(session: Session, repoPath?: string | null, message?: string | null): Promise<GitOperationResult> {
    return this.locked(session, repoPath, 'commit', async (repo) => {
      const changes = await this.workspaceGitService.changedFiles(repo);
      if (changes.size === 0) throw new BusinessException(ErrorCode.PARAM_INVALID, '没有待提交的变更');
      let commitMessage: { normalized: string; title: string };
      if (typeof message === 'string') {
        commitMessage = validateCommitMessage(message);
      } else {
        const generated = await this.commitMessageService.generate(session, await this.buildCommitInput(repo, changes));
        commitMessage = { normalized: generated.message, title: generated.title };
      }
      const add = await this.run(repo, ['add', '-A'], {});
      requireSuccess(add, '暂存变更失败');
      const args: string[] = [];
      const hasName = (await this.run(repo, ['config', '--get', 'user.name'], {})).success;
      const hasEmail = (await this.run(repo, ['config', '--get', 'user.email'], {})).success;
      if (!hasName) { args.push('-c', 'user.name=Mao Agent'); }
      if (!hasEmail) { args.push('-c', 'user.email=mao@etarch.cn'); }
      // 整条消息作为单个 -m：拆成多个 -m 时 git 会用空行拼接，会改写用户原文
      args.push('commit', '--no-verify', '-m', commitMessage.normalized);
      const commit = await this.run(repo, args, {});
      requireSuccess(commit, '提交失败');
      const hash = requireOutput(await this.run(repo, ['rev-parse', '--short', 'HEAD'], {}), '读取提交哈希失败');
      const branch = await this.branch(repo);
      const result = successResult('commit', branch, `提交成功 ${hash}：${commitMessage.title}`);
      result.commitHash = hash;
      result.commitTitle = commitMessage.title;
      return result;
    });
  }

  /**
   * 两步提交第一步（中央 Tab）：只生成提交信息，不做任何写操作。
   * LOCAL 走 Electron 侧 buildCommitInput + /files/git-commit-message，CLOUD 在此服务端组装。
   * 持仓库锁防止生成期间并发提交使消息过期；无变更时与 commit() 同口径报错。
   */
  async generateCommitMessage(session: Session, repoPath?: string | null): Promise<CommitMessage> {
    const repo = await this.resolveRepository(session, repoPath);
    return this.withRepoLock(repo, async () => {
      const changes = await this.workspaceGitService.changedFiles(repo);
      if (changes.size === 0) throw new BusinessException(ErrorCode.PARAM_INVALID, '没有待提交的变更');
      return this.commitMessageService.generate(session, await this.buildCommitInput(repo, changes));
    });
  }

  async refreshRemoteStatus(session: Session, repoPath?: string | null): Promise<GitStatusDTO> {
    const repo = await this.resolveRepository(session, repoPath);
    return this.withRepoLock(repo, async () => {
      const state = await this.remoteState(repo);
      if (state.remotes.length === 0) {
        const status = await this.workspaceGitService.getStatus(session.workspace!, repoPath);
        status.remoteStatusAvailable = false;
        status.remoteStatusError = '仓库未配置远端';
        return status;
      }
      const env = await this.credentialEnv(session);
      const failures = await this.fetchAllRemotes(repo, state.remotes, env);
      const status = await this.workspaceGitService.getStatus(session.workspace!, repoPath);
      if (failures.length === 0) {
        status.remoteStatusAvailable = true;
        status.remoteStatusError = undefined;
      } else if (failures.length < state.remotes.length) {
        status.remoteStatusAvailable = true;
        status.remoteStatusError = `部分远端获取失败：${failures.map((f) => f.remote).join('、')}（其余远端已更新）`;
      } else {
        status.remoteStatusAvailable = false;
        status.remoteStatusError = failures.length === 1
          ? classify(failures[0].result, '获取远端更新失败')
          : `全部远端获取失败：${failures.map((f) => f.remote).join('、')}`;
        return status;
      }
      // 参照远端只用于「无 upstream 时」判断是否有提交要推（推送入口的禁用依据）
      const referenceRemote = await this.selectRefreshRemote(repo, state);
      status.hasCommitsToPush = referenceRemote == null
        ? false
        : await this.hasCommitsToPush(repo, status, referenceRemote);
      return status;
    });
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

  /**
   * 显式获取远端更新（并行执行逐远端 fetch --prune，不动工作区）。
   * 每个远端一个独立子进程并行执行：单个远端挂起不会阻断其余远端，总等待以单个远端的
   * 超时为上界；失败天然归属到具体远端（无需解析输出）；
   * 部分失败按成功提示，全部失败才报错；无 remote 时报「仓库未配置远端」
   * （与 refreshRemoteStatus 的无 remote 分支同语义）。
   */
  async fetchRemote(session: Session, repoPath?: string | null): Promise<GitOperationResult> {
    return this.locked(session, repoPath, 'fetch', async (repo) => {
      const state = await this.remoteState(repo);
      if (state.remotes.length === 0) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '仓库未配置远端');
      }
      const env = await this.credentialEnv(session);
      const failures = await this.fetchAllRemotes(repo, state.remotes, env);
      if (failures.length === state.remotes.length) {
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, failures.length === 1
          ? classify(failures[0].result, '获取远端更新失败')
          : `全部远端获取失败：${failures.map((f) => f.remote).join('、')}`);
      }
      if (failures.length > 0) {
        return successResult('fetch', state.branch, `部分远端已更新（${failures.map((f) => f.remote).join('、')} 获取失败）`);
      }
      return successResult('fetch', state.branch, '远端已更新');
    });
  }

  /**
   * 切换分支（自动 stash + 切换后恢复，与 pull 的 stash 生命周期同构）。
   * 守卫只查 detached HEAD，不要求配置 remote——无远端的纯本地仓库也应可切分支
   * （requirePullPushState 同时查 detached 与 remote 两项，直接复用会误拒）。
   * 目标形如 <remote>/<branch> 或 create=true 时建跟踪分支：
   * git switch -c <local> --track <remote>/<remote-branch>（不依赖 DWIM）。
   */
  async switchBranch(session: Session, repoPath: string | null | undefined, branch: string, create?: boolean): Promise<GitOperationResult> {
    return this.locked(session, repoPath, 'switch', async (repo) => {
      const state = await this.remoteState(repo);
      if (state.detached) throw new BusinessException(ErrorCode.PARAM_INVALID, 'detached HEAD，请先切换分支');
      const target = resolveSwitchTarget(branch, create === true, state.remotes);
      const operationId = randomUUID();
      let stashOid: string | null = null;
      let stashRef: string | null = null;
      if (await this.hasChanges(repo)) {
        const stash = await this.run(repo, ['stash', 'push', '--include-untracked', '-m', `mao-auto-switch-${operationId}`], {});
        requireSuccess(stash, '自动 stash 创建失败');
        stashOid = requireOutput(await this.run(repo, ['rev-parse', 'stash@{0}'], {}), '读取 stash 失败');
        stashRef = await this.findStashRef(repo, stashOid);
      }
      const switched = await this.run(repo, target.args, {});
      if (!switched.success) {
        // 切换失败：先恢复 stash 保留现场（恢复冲突异常优先抛出，消息含 stash 引用，同 pull 口径）
        if (stashOid != null) await this.restoreStash(repo, stashOid, stashRef);
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(switched, '切换分支失败'));
      }
      if (stashOid != null) await this.restoreStash(repo, stashOid, stashRef);
      return successResult('switch', target.localBranch, `已切换到分支 ${target.localBranch}`);
    });
  }

  /**
   * stash 操作（apply / pop / drop，白名单枚举）。
   * apply/pop 后检测冲突：有冲突返回 success:false + conflict:true 并保留现场（不自动 reset）。
   */
  async stashOp(session: Session, repoPath: string | null | undefined, action: string, ref: string): Promise<GitOperationResult> {
    return this.locked(session, repoPath, 'stash', async (repo) => {
      if (!STASH_ACTIONS.includes(action)) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'stash 操作类型无效');
      }
      if (!STASH_REF_PATTERN.test(ref ?? '')) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, 'stash 引用无效');
      }
      let args: string[];
      if (action === 'apply') args = ['stash', 'apply', '--index', ref];
      else if (action === 'pop') args = ['stash', 'pop', '--index', ref];
      else args = ['stash', 'drop', ref];
      const result = await this.run(repo, args, {});
      // apply/pop 冲突时 git 退出码为 1（预期内）：先判冲突走专用契约，再判真失败。
      // 顺序反了会让冲突永远落进裸 git 错误分支，conflict 标记与「已保留现场」引导丢失
      // （与 pull 冲突遗留的 mao-auto-pull-* stash 处理场景直接相关）。
      if (action !== 'drop' && await this.hasConflicts(repo)) {
        const failed = failedResult('stash', `stash ${action === 'apply' ? '应用' : '弹出'}产生冲突，已保留现场，请手动处理（${ref}）`);
        failed.conflict = true;
        failed.stashRef = ref;
        return failed;
      }
      if (!result.success) {
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, classify(result, `stash ${action} 失败`));
      }
      const label = action === 'apply' ? '已应用' : action === 'pop' ? '已弹出' : '已丢弃';
      const success = successResult('stash', await this.branch(repo), `${label} ${ref}`);
      success.stashRef = ref;
      return success;
    });
  }

  async recordLocalActivity(session: Session, request: LocalGitActivity | null): Promise<void> {
    if (request == null || !LOCAL_ACTIVITY_OPERATIONS.includes(request.operation)) {
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
    const started = Date.now();
    return this.withRepoLock(repo, async () => {
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
      }
    });
  }

  private async withRepoLock<T>(repo: string, action: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(repo) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = previous.then(() => current, () => current);
    this.locks.set(repo, chained);
    try {
      await previous;
      return await action();
    } finally {
      release();
      if (this.locks.get(repo) === chained) this.locks.delete(repo);
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

  /**
   * 并行 fetch 全部远端：每个远端一个独立子进程、各自 60s 超时；返回失败项（保持传入 remotes 的顺序），
   * 供 refreshRemoteStatus / fetchRemote 共用。任意多个远端挂起时总等待以单个远端的超时为上界
   * （串行会叠成 N×60s 并全程占住仓库锁）；单个远端挂起/失败不影响其余远端，
   * 失败/超时天然归属到具体远端，无需解析 git 的输出文本。
   */
  private async fetchAllRemotes(repo: string, remotes: string[], env: Record<string, string>): Promise<Array<{ remote: string; result: GitResult }>> {
    const results = await Promise.all(remotes.map(async (remote) => ({
      remote,
      result: await this.run(repo, ['fetch', '--prune', remote], env),
    })));
    return results.filter((entry) => !entry.result.success);
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
      const timeoutMs = gitTimeoutMs();
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolveP({ exitCode: 124, output: `Git 子进程 ${Math.round(timeoutMs / 1000)} 秒超时`, success: false });
      }, timeoutMs);
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

/**
 * 用户提供的提交信息校验（与 Electron 侧 validateCommitMessage 同口径）：
 * 只查非空 / 长度 / 非法字符，不限定格式——中央 Tab 输入框允许自由编写。
 */
export function validateCommitMessage(message: unknown): { normalized: string; title: string } {
  if (typeof message !== 'string' || message.trim().length === 0) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '提交信息不能为空');
  }
  if (Buffer.byteLength(message, 'utf8') > MAX_COMMIT_MESSAGE_BYTES) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '提交信息过长');
  }
  if (message.includes('\0')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '提交信息包含非法字符');
  }
  const normalized = message.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  return { normalized, title: normalized.split('\n')[0] };
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
  if (result.exitCode === 124) return result.output.trim() || `Git 子进程 ${Math.round(gitTimeoutMs() / 1000)} 秒超时`;
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
  const clean = sanitizeCredentialUrl(value).replace(/(token|password|authorization)[=: ]+[^\s]+/gi, '$1=***').trim();
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

/**
 * 解析切换分支目标：
 * - 纯本地分支名 → git switch <branch>；
 * - 形如 <remote>/<branch>（前缀是已配置 remote）或 create=true → git switch -c <local> --track <remote>/<branch>。
 * 分支名合法性走 git check-ref-format 子集（与前端 utils/git-manager.ts 的 isValidBranchName 同规则）。
 */
export function resolveSwitchTarget(branch: string, create: boolean, remotes: string[]): { args: string[]; localBranch: string } {
  const name = (branch ?? '').trim();
  // 字符类已排除空白 ~^:?*[\] 等；下面是 check-ref-format 的结构性规则
  const valid = name.length > 0
    && name.length <= 200
    && BRANCH_NAME_PATTERN.test(name)
    && !name.includes('..')
    && !name.includes('@{')
    && name !== '@'
    && !name.startsWith('/')
    && !name.endsWith('/')
    && !name.includes('//')
    && !name.endsWith('.')
    && name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
  if (!valid) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '分支名无效');
  }
  const slashIdx = name.indexOf('/');
  const remotePrefix = slashIdx > 0 ? name.slice(0, slashIdx) : '';
  const isRemoteRef = remotePrefix.length > 0 && remotes.includes(remotePrefix);
  if (create || isRemoteRef) {
    if (!isRemoteRef) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '仅支持从远端分支创建跟踪分支');
    }
    const local = name.slice(slashIdx + 1);
    return { args: ['switch', '-c', local, '--track', name], localBranch: local };
  }
  return { args: ['switch', name], localBranch: name };
}
