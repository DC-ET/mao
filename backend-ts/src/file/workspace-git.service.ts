import { spawn } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { isUnder, PathSandbox, SecurityException } from '../harness/safety/path-sandbox.js';

const GIT_TIMEOUT_SECONDS = 10;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_DIFF_LINES = 5000;
const MAX_DIFF_BYTES = 512 * 1024;
const REPO_SCAN_CONCURRENCY = 8;

export const EXCLUDED_REPO_DIRS = new Set([
  '.nvm', '.pyenv', '.rbenv', '.nodenv', '.jenv', '.tfenv', '.sdkman',
  '.oh-my-zsh', '.zprezto', '.zim', '.zinit', '.antigen', '.fzf',
]);

export interface GitRepoSummaryDTO {
  name: string;
  path: string;
  branch?: string | null;
  changedFileCount?: number;
  insertions?: number;
  deletions?: number;
  unavailable?: boolean;
}

export interface GitReposDTO {
  isRootGit: boolean;
  repos: GitRepoSummaryDTO[];
}

export interface GitChangedFileDTO {
  path: string;
  oldPath?: string | null;
  changeType: string;
  untracked?: boolean;
  insertions: number;
  deletions: number;
  binary?: boolean;
}

export interface GitStatusDTO {
  isGit: boolean;
  repoRoot?: string | null;
  branch?: string | null;
  remotes?: string[];
  hasRemote?: boolean;
  detachedHead?: boolean;
  hasHead?: boolean;
  upstream?: string | null;
  aheadCount?: number | null;
  behindCount?: number | null;
  hasCommitsToPush?: boolean | null;
  remoteStatusAvailable?: boolean;
  remoteStatusError?: string | null;
  insertions?: number;
  deletions?: number;
  changedFileCount?: number;
  files?: GitChangedFileDTO[];
  error?: string | null;
}

export interface GitFileDiffDTO {
  path: string;
  changeType: string;
  beforeContent: string;
  afterContent: string;
  truncated?: boolean;
  binary?: boolean;
  unavailableReason?: string | null;
}

export interface GitLogEntryDTO {
  hash: string;
  shortHash: string;
  title: string;
  author: string;
  /** ISO 8601（git %aI） */
  date: string;
  /** 原始 %D refs 装饰串；无装饰时缺省 */
  refs?: string;
}

export interface GitBranchInfoDTO {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream?: string | null;
  ahead?: number | null;
  behind?: number | null;
  lastCommitHash?: string | null;
  lastCommitTitle?: string | null;
}

export interface GitStashEntryDTO {
  ref: string;
  message: string;
  /** ISO 8601（git %aI） */
  date: string;
}

export interface GitRemoteInfoDTO {
  name: string;
  /** 已脱敏（user:token@ → ***@） */
  fetchUrl: string;
  pushUrl: string;
}

export interface GitCommitFilesDTO {
  hash: string;
  files: GitChangedFileDTO[];
}

/**
 * 分支对比结果：两点 `<base>...<target>`（三点语义，merge-base 起点）的变更文件清单
 * + 目标分支相对基准的领先/落后提交数。
 */
export interface GitBranchCompareDTO {
  base: string;
  target: string;
  /** 目标分支独有的提交数（rev-list --left-right --count <base>...<target> 的 right 段） */
  aheadCount: number;
  /** 基准分支独有的提交数（同命令 left 段；等价于 rev-list --count <target>..<base>） */
  behindCount: number;
  files: GitChangedFileDTO[];
}

/** 远端 URL 脱敏（与 git-write-operation.service.ts 共用同一条正则，双侧导出一份）。 */
const CREDENTIAL_URL = /(https?:\/\/)([^/@\s]+@)/gi;

export function sanitizeCredentialUrl(url: string | null | undefined): string {
  if (url == null) return '';
  return url.replace(CREDENTIAL_URL, '$1***@');
}

/** 提交历史 hash 入参格式：7-64 位十六进制（短哈希或全哈希均可）。 */
const COMMIT_HASH_PATTERN = /^[0-9a-f]{7,64}$/;

/**
 * 分支对比的分支 / ref 名合法性（git check-ref-format 子集）。
 * 字符类首字符排除 `-`：参数数组不过 shell，但 `-` 开头仍会被 git 当选项（option 注入），
 * 故严于 git-write-operation.service.ts 的 BRANCH_NAME_PATTERN（`^[A-Za-z0-9._/-]+$`，
 * `-` 位于字符类尾部是字面量、首字符并不拒绝 `-`，实测 `-x` 能通过其校验）。
 * 只读侧不依赖写服务的导出面，此处独立定义、勿照抄写侧的宽松正则；
 * `-x` 经 porcelain 无法创建，收紧不误伤任何真实分支。
 */
const BRANCH_REF_PATTERN = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/**
 * 分支 / ref 名是否合法：字符类 + check-ref-format 的结构性规则
 * （禁 `..` / `@{` / `//`、首尾 `/`、结尾 `.`、组件首 `.`、组件尾 `.lock`、长度 1..200、不为 `@`）。
 */
export function isValidBranchRefName(name: string): boolean {
  if (name.length < 1 || name.length > 200) return false;
  if (!BRANCH_REF_PATTERN.test(name)) return false;
  if (name === '@') return false;
  if (name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.startsWith('/') || name.endsWith('/') || name.endsWith('.')) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

const LOG_FORMAT = '%H%x00%h%x00%s%x00%an%x00%aI%x00%D';
const LOG_DEFAULT_LIMIT = 50;
const LOG_MAX_LIMIT = 200;

export class WorkspaceGitService {
  constructor(private readonly pathSandbox: PathSandbox) {}

  async listRepos(sessionWorkspace: string): Promise<GitReposDTO> {
    const workspace = realPath(this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace));
    const repoRootStr = await this.runGitOk(workspace, ['rev-parse', '--show-toplevel']);
    if (repoRootStr != null) {
      return { isRootGit: true, repos: [] };
    }
    const repoDirs: string[] = [];
    if (existsSync(workspace) && statSync(workspace).isDirectory()) {
      try {
        for (const name of readdirSync(workspace)) {
          if (EXCLUDED_REPO_DIRS.has(name)) continue;
          const dir = join(workspace, name);
          try {
            if (statSync(dir).isDirectory() && existsSync(join(dir, '.git'))) {
              repoDirs.push(dir);
            }
          } catch {
            // skip
          }
        }
      } catch (e) {
        console.warn(`Failed to list git repos under workspace ${workspace}: ${(e as Error).message}`);
      }
    }
    const repos: GitRepoSummaryDTO[] = [];
    for (let i = 0; i < repoDirs.length; i += REPO_SCAN_CONCURRENCY) {
      const batch = repoDirs.slice(i, i + REPO_SCAN_CONCURRENCY);
      const results = await Promise.all(batch.map((dir) => this.summarizeRepo(dir)));
      for (const r of results) {
        if (r) repos.push(r);
      }
    }
    repos.sort((a, b) => a.name.localeCompare(b.name));
    return { isRootGit: false, repos };
  }

  async getStatus(sessionWorkspace: string, repoPath?: string | null): Promise<GitStatusDTO> {
    const workspace = realPath(this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace));
    const repoDir = this.resolveRepoDir(workspace, repoPath);
    const dto: GitStatusDTO = { isGit: false };
    const repoRootStr = await this.runGitOk(repoDir, ['rev-parse', '--show-toplevel']);
    if (repoRootStr == null) {
      return dto;
    }
    const repoRoot = resolve(repoRootStr.trim());
    dto.isGit = true;
    dto.repoRoot = repoRoot;
    let branch = await this.runGitOk(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (branch == null) {
      const symbolic = await this.runGitOk(repoRoot, ['symbolic-ref', '--short', 'HEAD']);
      branch = symbolic != null ? symbolic.trim() : null;
    }
    const normalizedBranch = branch != null ? branch.trim() : null;
    const detached = normalizedBranch === 'HEAD' && (await this.runGitOk(repoRoot, ['symbolic-ref', '-q', 'HEAD'])) == null;
    dto.branch = normalizedBranch;
    dto.detachedHead = detached;
    dto.hasHead = (await this.runGitOk(repoRoot, ['rev-parse', '--verify', 'HEAD'])) != null;
    dto.remoteStatusAvailable = false;
    const remoteOutput = await this.runGitOk(repoRoot, ['remote']);
    const remotes = remoteOutput == null || remoteOutput.trim().length === 0
      ? []
      : remoteOutput.split('\n').map((s) => s.trim()).filter((s) => s.length > 0).sort();
    dto.remotes = remotes;
    dto.hasRemote = remotes.length > 0;
    if (!detached) {
      const upstream = await this.runGitOk(repoRoot, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
      dto.upstream = upstream != null ? upstream.trim() : null;
    }
    await this.populateAheadBehind(repoRoot, dto);
    const files = await this.collectChangedFiles(repoRoot);
    let insertions = 0;
    let deletions = 0;
    for (const file of files.values()) {
      insertions += Math.max(0, file.insertions);
      deletions += Math.max(0, file.deletions);
    }
    dto.insertions = insertions;
    dto.deletions = deletions;
    dto.changedFileCount = files.size;
    dto.files = [...files.values()];
    return dto;
  }

  async populateAheadBehind(repoRoot: string, dto: GitStatusDTO): Promise<void> {
    if (!dto.hasHead || dto.upstream == null) {
      dto.aheadCount = null;
      dto.behindCount = null;
      return;
    }
    const counts = await this.runGitOk(repoRoot, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    if (counts == null) {
      dto.aheadCount = null;
      dto.behindCount = null;
      return;
    }
    const parts = counts.trim().split(/\s+/);
    if (parts.length !== 2) {
      dto.aheadCount = null;
      dto.behindCount = null;
      return;
    }
    dto.aheadCount = parseIntSafe(parts[0]);
    dto.behindCount = parseIntSafe(parts[1]);
  }

  async getFileDiff(sessionWorkspace: string, repoPath: string | null | undefined, relativePath: string | null | undefined): Promise<GitFileDiffDTO> {
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.split('/').some((p) => p === '..')) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const workspace = realPath(this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace));
    const repoDir = this.resolveRepoDir(workspace, repoPath);
    const repoRootStr = await this.runGitOk(repoDir, ['rev-parse', '--show-toplevel']);
    if (repoRootStr == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '当前工作区不是 Git 仓库');
    }
    const repoRoot = resolve(repoRootStr.trim());
    let absolute: string;
    try {
      absolute = resolve(repoRoot, normalized);
    } catch {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    if (!isUnder(absolute, repoRoot)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    try {
      this.pathSandbox.resolve(absolute, workspace);
    } catch (e) {
      if (e instanceof SecurityException) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
      }
      throw e;
    }
    const files = await this.collectChangedFiles(repoRoot);
    let meta = files.get(normalized);
    if (meta == null) {
      meta = {
        path: normalized,
        changeType: await this.inferChangeType(repoRoot, normalized, absolute),
        insertions: 0,
        deletions: 0,
      };
    }
    const diff: GitFileDiffDTO = { path: normalized, changeType: meta.changeType, beforeContent: '', afterContent: '' };
    let before = await this.showHeadContent(repoRoot, meta.oldPath ?? normalized);
    let after = '';
    const afterMissing = !existsSync(absolute) || !statSync(absolute).isFile();
    if (!afterMissing) {
      const afterRead = readTextLimited(absolute);
      if (afterRead.binary) {
        diff.binary = true;
        diff.unavailableReason = '二进制文件，无法预览';
        return diff;
      }
      after = afterRead.content;
      if (afterRead.truncated) diff.truncated = true;
    }
    if (before != null && isBinaryString(before)) {
      diff.binary = true;
      diff.unavailableReason = '二进制文件，无法预览';
      return diff;
    }
    if (before == null) before = '';
    const beforeTrunc = truncateText(before);
    const afterTrunc = truncateText(after);
    diff.beforeContent = beforeTrunc.content;
    diff.afterContent = afterTrunc.content;
    if (beforeTrunc.truncated || afterTrunc.truncated || diff.truncated) {
      diff.truncated = true;
    }
    return diff;
  }

  async resolveRepository(sessionWorkspace: string, repoPath?: string | null): Promise<string> {
    const workspace = realPath(this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace));
    const repoDir = this.resolveRepoDir(workspace, repoPath);
    const repoRoot = await this.runGitOk(repoDir, ['rev-parse', '--show-toplevel']);
    if (repoRoot == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '当前工作区不是 Git 仓库');
    }
    const root = resolve(repoRoot.trim());
    if (!isUnderReal(root, workspace)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    return root;
  }

  /**
   * 提交历史（分页）。空仓库（无 HEAD）git log 失败，返回 [] 不报错。
   * limit 钳制 [1,200] 默认 50；offset ≥ 0；path 可选（按文件过滤，本期前端未用）。
   */
  async getLog(
    sessionWorkspace: string,
    repoPath?: string | null,
    opts?: { limit?: number; offset?: number; path?: string | null },
  ): Promise<GitLogEntryDTO[]> {
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const limit = clampInt(opts?.limit, LOG_DEFAULT_LIMIT, 1, LOG_MAX_LIMIT);
    const offset = clampInt(opts?.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const args = ['log', `--format=${LOG_FORMAT}`, '-n', String(limit), '--skip', String(offset)];
    const pathFilter = opts?.path?.trim();
    if (pathFilter) args.push('--', pathFilter);
    const out = await this.runGitOk(repoRoot, args);
    if (out == null || out.trim().length === 0) return [];
    const entries: GitLogEntryDTO[] = [];
    for (const line of out.split('\n')) {
      if (line.length === 0) continue;
      const entry = parseLogLine(line);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  /**
   * 单次提交的文件变更清单。merge 提交必须带 --first-parent：
   * 默认 git show 对 merge 输出 combined diff，干净合并的文件清单为空。
   * hash 格式合法但 git 中不存在（或非 commit 对象）时 runGitOk 返回 null，
   * 映射 PARAM_INVALID——不可返空列表（空列表与空提交无法区分）。
   */
  async getCommitFiles(sessionWorkspace: string, repoPath: string | null | undefined, hash: string): Promise<GitCommitFilesDTO> {
    const normalizedHash = (hash ?? '').trim().toLowerCase();
    if (!COMMIT_HASH_PATTERN.test(normalizedHash)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '提交不存在');
    }
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const nameStatus = await this.runGitOk(repoRoot, ['show', '--first-parent', '--name-status', '--format=', normalizedHash]);
    const numstat = await this.runGitOk(repoRoot, ['show', '--first-parent', '--numstat', '--format=', normalizedHash]);
    if (nameStatus == null && numstat == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '提交不存在');
    }
    const files = new Map<string, GitChangedFileDTO>();
    if (nameStatus != null && nameStatus.trim().length > 0) {
      for (let line of nameStatus.split('\n')) {
        line = line.trim();
        if (line.length === 0) continue;
        const file = parseNameStatusLine(line);
        if (file) files.set(file.path, file);
      }
    }
    if (numstat != null && numstat.trim().length > 0) {
      for (let line of numstat.split('\n')) {
        line = line.trim();
        if (line.length === 0) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const path = numstatNewPath(parts[parts.length - 1]);
        const file = files.get(path);
        if (!file) continue;
        if (parts[0] === '-' || parts[1] === '-') {
          file.binary = true;
          file.insertions = 0;
          file.deletions = 0;
        } else {
          file.insertions = parseIntSafe(parts[0]);
          file.deletions = parseIntSafe(parts[1]);
        }
      }
    }
    return { hash: normalizedHash, files: [...files.values()] };
  }

  /**
   * 单提交单文件 diff：before = `git show <hash>^:<oldPath ?? path>`，after = `git show <hash>:<path>`，
   * 均取自 git 对象、不读工作区。改名提交必须传 oldPath（文件清单 R 行的旧路径）——
   * 新路径在父提交中不存在，不传会把 before 判空、changeType 退化成 CREATED。
   * 该提交中新增的文件 before 为空（根提交同理），删除的文件 after 为空
   * （show 对不存在对象返回非零退出，按空内容处理）。
   */
  async getCommitFileDiff(
    sessionWorkspace: string,
    repoPath: string | null | undefined,
    hash: string,
    relativePath: string | null | undefined,
    oldPath?: string | null,
  ): Promise<GitFileDiffDTO> {
    const normalizedHash = (hash ?? '').trim().toLowerCase();
    if (!COMMIT_HASH_PATTERN.test(normalizedHash)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '提交不存在');
    }
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.split('/').some((p) => p === '..')) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const beforePath = oldPath == null || oldPath.trim().length === 0
      ? normalized
      : oldPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (beforePath.split('/').some((p) => p === '..')) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const absolute = resolve(repoRoot, normalized);
    if (!isUnder(absolute, repoRoot)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const beforeRaw = await this.runGitOk(repoRoot, ['show', `${normalizedHash}^:${beforePath}`]);
    const afterRaw = await this.runGitOk(repoRoot, ['show', `${normalizedHash}:${normalized}`]);
    const changeType = beforeRaw == null && afterRaw != null
      ? 'CREATED'
      : beforeRaw != null && afterRaw == null
        ? 'DELETED'
        : beforePath !== normalized ? 'RENAMED' : 'MODIFIED';
    const diff: GitFileDiffDTO = { path: normalized, changeType, beforeContent: '', afterContent: '' };
    if (beforeRaw != null && isBinaryString(beforeRaw)) {
      diff.binary = true;
      diff.unavailableReason = '二进制文件，无法预览';
      return diff;
    }
    if (afterRaw != null && isBinaryString(afterRaw)) {
      diff.binary = true;
      diff.unavailableReason = '二进制文件，无法预览';
      return diff;
    }
    const beforeTrunc = truncateText(beforeRaw ?? '');
    const afterTrunc = truncateText(afterRaw ?? '');
    diff.beforeContent = beforeTrunc.content;
    diff.afterContent = afterTrunc.content;
    if (beforeTrunc.truncated || afterTrunc.truncated) diff.truncated = true;
    return diff;
  }

  /**
   * 分支对比（三点 `<base>...<target>`）：目标分支相对基准独有的变更文件清单
   * + 目标分支领先/落后提交数。语义同 GitHub PR——只列目标侧独有的变更，
   * 基准侧独有的提交不计入差异。base/target 由用户自选（本地 / 远端分支均可）。
   * 分支名先解析成提交 sha（显式 `refs/heads/` → `refs/remotes/` 两段式，见 resolveBranchSha），
   * 后续命令一律用 sha：裸 ref 名会走 git 的 refname 解析顺序，而 refs/tags/ 优先于 refs/heads/——
   * 仓库里存在与分支同名的 tag 时，用户在下拉里选的是分支、实际比对的却是 tag（静默错误）。
   * 先解析 ref 再跑 diff：`git diff A...B` 无差异时输出为空且退出码 0，
   * 与「ref 不存在」必须可区分（顺序不可颠倒，也不可用 diff 退出码推断 ref 存在性）。
   * merge-base 用模块导出的 runGitRaw 读退出码——runGitOk 把一切非零退出统一折成 null，
   * 无法区分「无共同祖先（exitCode 1）」与超时 124 / spawn 失败 127 / 无效 ref 128，
   * 而实测无共同祖先场景 rev-list 仍成功，故该判定必须前移到 merge-base 的退出码上。
   */
  async compareBranches(
    sessionWorkspace: string,
    repoPath: string | null | undefined,
    base: string,
    target: string,
  ): Promise<GitBranchCompareDTO> {
    const baseRef = (base ?? '').trim();
    const targetRef = (target ?? '').trim();
    if (!isValidBranchRefName(baseRef) || !isValidBranchRefName(targetRef)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '分支不存在');
    }
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const [baseSha, targetSha] = await Promise.all([
      this.resolveBranchSha(repoRoot, baseRef),
      this.resolveBranchSha(repoRoot, targetRef),
    ]);
    const mergeBase = await runGitRaw(repoRoot, ['merge-base', baseSha, targetSha], GIT_TIMEOUT_SECONDS * 1000);
    if (mergeBase.exitCode === 1) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '两个分支没有共同祖先，无法对比');
    }
    if (mergeBase.exitCode !== 0 || firstObjectId(mergeBase.stdout) == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '对比失败，请重试');
    }
    const counts = await this.runGitOk(repoRoot, ['rev-list', '--left-right', '--count', `${baseSha}...${targetSha}`]);
    if (counts == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '对比失败，请重试');
    }
    // 只认最后一行纯数字计数：runGitRaw 把 stderr 并入 stdout，criss-cross 历史的
    // `warning: ... multiple merge bases, using <sha>` 会混在首行，按首个空白字段切分
    // 会把 warning 的单词当成计数
    const countsLine = counts
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^\d+\s+\d+$/.test(line))
      .pop();
    if (countsLine == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '对比失败，请重试');
    }
    // left = 基准独有（目标落后数）、right = 目标独有（目标领先数）
    const [behindRaw, aheadRaw] = countsLine.split(/\s+/);
    const [numstat, nameStatus] = await Promise.all([
      this.runGitOk(repoRoot, ['diff', '--numstat', `${baseSha}...${targetSha}`]),
      this.runGitOk(repoRoot, ['diff', '--name-status', `${baseSha}...${targetSha}`]),
    ]);
    // 空串是合法结果（两个分支无差异，target 落后于 base 时同样为空），只有执行失败才报错
    if (numstat == null || nameStatus == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '对比失败，请重试');
    }
    const files = new Map<string, GitChangedFileDTO>();
    if (nameStatus.trim().length > 0) {
      for (let line of nameStatus.split('\n')) {
        line = line.trim();
        if (line.length === 0) continue;
        const file = parseNameStatusLine(line);
        if (file) files.set(file.path, file);
      }
    }
    if (numstat.trim().length > 0) {
      for (let line of numstat.split('\n')) {
        line = line.trim();
        if (line.length === 0) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const path = numstatNewPath(parts[parts.length - 1]);
        const file = files.get(path);
        if (!file) continue;
        if (parts[0] === '-' || parts[1] === '-') {
          file.binary = true;
          file.insertions = 0;
          file.deletions = 0;
        } else {
          file.insertions = parseIntSafe(parts[0]);
          file.deletions = parseIntSafe(parts[1]);
        }
      }
    }
    return {
      base: baseRef,
      target: targetRef,
      aheadCount: parseIntSafe(aheadRaw ?? ''),
      behindCount: parseIntSafe(behindRaw ?? ''),
      files: [...files.values()],
    };
  }

  /**
   * 分支对比单文件 diff（三点语义下的双 ref show）：
   * before = `git show <merge-base>:<oldPath ?? path>`，after = `git show <target>:<path>`，
   * 均取自 git 对象、不读工作区。两个分支先按显式 ref 路径解析成 sha（见 resolveBranchSha），
   * show 的对象端都用 sha——同名 tag 不会遮蔽分支，也不会把 ambiguity warning 混进内容首行。
   * before 端取 merge-base 而非 base 本身（否则退化成
   * 「base tip → target tip」两点 diff，把基准分支独有的改动显示成删除，与三点清单自相矛盾）；
   * rename 必须传 oldPath（清单 R 行的旧路径）——oldPath 即 merge-base 树中的旧路径、必然存在，
   * 不传会把改名显示成「整份新增」。对象不存在不是错误：merge-base 中不存在 → before 空（CREATED）、
   * target 中不存在 → after 空（DELETED）。返回的 path 恒为新路径。
   */
  async compareBranchFileDiff(
    sessionWorkspace: string,
    repoPath: string | null | undefined,
    base: string,
    target: string,
    relativePath: string | null | undefined,
    oldPath?: string | null,
  ): Promise<GitFileDiffDTO> {
    const baseRef = (base ?? '').trim();
    const targetRef = (target ?? '').trim();
    if (!isValidBranchRefName(baseRef) || !isValidBranchRefName(targetRef)) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '分支不存在');
    }
    if (relativePath == null || relativePath.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件路径不能为空');
    }
    const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (normalized.split('/').some((p) => p === '..')) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const beforePath = oldPath == null || oldPath.trim().length === 0
      ? normalized
      : oldPath.replace(/\\/g, '/').replace(/^\.\//, '');
    if (beforePath.split('/').some((p) => p === '..')) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const absolute = resolve(repoRoot, normalized);
    if (!isUnder(absolute, repoRoot)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const [baseSha, targetSha] = await Promise.all([
      this.resolveBranchSha(repoRoot, baseRef),
      this.resolveBranchSha(repoRoot, targetRef),
    ]);
    const mergeBase = await runGitRaw(repoRoot, ['merge-base', baseSha, targetSha], GIT_TIMEOUT_SECONDS * 1000);
    if (mergeBase.exitCode === 1) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '两个分支没有共同祖先，无法对比');
    }
    const mergeBaseHash = firstObjectId(mergeBase.stdout);
    if (mergeBase.exitCode !== 0 || mergeBaseHash == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '对比失败，请重试');
    }
    const beforeRaw = await this.runGitOk(repoRoot, ['show', `${mergeBaseHash}:${beforePath}`]);
    const afterRaw = await this.runGitOk(repoRoot, ['show', `${targetSha}:${normalized}`]);
    const changeType = beforeRaw == null && afterRaw != null
      ? 'CREATED'
      : beforeRaw != null && afterRaw == null
        ? 'DELETED'
        : beforePath !== normalized ? 'RENAMED' : 'MODIFIED';
    const diff: GitFileDiffDTO = { path: normalized, changeType, beforeContent: '', afterContent: '' };
    if (beforeRaw != null && isBinaryString(beforeRaw)) {
      diff.binary = true;
      diff.unavailableReason = '二进制文件，无法预览';
      return diff;
    }
    if (afterRaw != null && isBinaryString(afterRaw)) {
      diff.binary = true;
      diff.unavailableReason = '二进制文件，无法预览';
      return diff;
    }
    const beforeTrunc = truncateText(beforeRaw ?? '');
    const afterTrunc = truncateText(afterRaw ?? '');
    diff.beforeContent = beforeTrunc.content;
    diff.afterContent = afterTrunc.content;
    if (beforeTrunc.truncated || afterTrunc.truncated) diff.truncated = true;
    return diff;
  }

  /**
   * 分支列表：本地（git branch -vv，含 upstream 与 ahead/behind 方括号解析）
   * + 远端（git branch -r -vv，其 upstream 列为空、不解析 ahead/behind）。
   * 空仓库（未出生 HEAD）下 `git branch -vv` 没有任何输出，用 symbolic-ref 补一条
   * 「即将出生的当前分支」，让分支视图不空白；lastCommitHash 留空。
   */
  async getBranches(sessionWorkspace: string, repoPath?: string | null): Promise<GitBranchInfoDTO[]> {
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const [localOut, remoteOut, headOut, unbornOut] = await Promise.all([
      this.runGitOk(repoRoot, ['branch', '-vv']),
      this.runGitOk(repoRoot, ['branch', '-r', '-vv']),
      this.runGitOk(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']),
      this.runGitOk(repoRoot, ['symbolic-ref', '--short', 'HEAD']),
    ]);
    const currentBranch = headOut != null ? headOut.trim() : '';
    const branches: GitBranchInfoDTO[] = [];
    for (const line of (localOut ?? '').split('\n')) {
      const parsed = parseBranchVvLine(line);
      // detached 行形如 '* (HEAD detached at <hash>) <subject>'，不是分支，跳过
      if (!parsed || parsed.name.startsWith('(')) continue;
      branches.push({
        name: parsed.name,
        isCurrent: parsed.isCurrent || (currentBranch.length > 0 && currentBranch === parsed.name),
        isRemote: false,
        upstream: parsed.upstream ?? null,
        ahead: parsed.ahead ?? null,
        behind: parsed.behind ?? null,
        lastCommitHash: parsed.lastCommitHash ?? null,
        lastCommitTitle: parsed.lastCommitTitle ?? null,
      });
    }
    if (branches.length === 0 && unbornOut != null) {
      const unborn = unbornOut.trim();
      if (unborn.length > 0) {
        branches.push({
          name: unborn,
          isCurrent: true,
          isRemote: false,
          upstream: null,
          ahead: null,
          behind: null,
          lastCommitHash: null,
          lastCommitTitle: null,
        });
      }
    }
    for (const line of (remoteOut ?? '').split('\n')) {
      // 跳过 origin/HEAD -> origin/main 符号行
      if (line.includes('->')) continue;
      const parsed = parseBranchVvLine(line);
      if (!parsed || parsed.name.startsWith('(')) continue;
      branches.push({
        name: parsed.name,
        isCurrent: false,
        isRemote: true,
        upstream: null,
        ahead: null,
        behind: null,
        lastCommitHash: parsed.lastCommitHash ?? null,
        lastCommitTitle: parsed.lastCommitTitle ?? null,
      });
    }
    return branches;
  }

  /** stash 列表（%gd 索引 / %gs 消息 / %aI 时间）。 */
  async getStashes(sessionWorkspace: string, repoPath?: string | null): Promise<GitStashEntryDTO[]> {
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const out = await this.runGitOk(repoRoot, ['stash', 'list', '--format=%gd%x00%gs%x00%aI']);
    if (out == null || out.trim().length === 0) return [];
    const entries: GitStashEntryDTO[] = [];
    for (const line of out.split('\n')) {
      if (line.length === 0) continue;
      const parts = line.split('\0');
      const ref = (parts[0] ?? '').trim();
      if (ref.length === 0) continue;
      entries.push({ ref, message: parts[1] ?? '', date: (parts[2] ?? '').trim() });
    }
    return entries;
  }

  /** 远端列表（fetch/push URL 合并为一条，URL 过 CREDENTIAL_URL 脱敏）。 */
  async getRemotes(sessionWorkspace: string, repoPath?: string | null): Promise<GitRemoteInfoDTO[]> {
    const repoRoot = await this.resolveRepoRoot(sessionWorkspace, repoPath);
    const out = await this.runGitOk(repoRoot, ['remote', '-v']);
    if (out == null || out.trim().length === 0) return [];
    const merged = new Map<string, { fetch?: string; push?: string }>();
    for (const line of out.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
      if (!match) continue;
      const [, name, url, kind] = match;
      const entry = merged.get(name) ?? {};
      if (kind === 'fetch') entry.fetch = url;
      else entry.push = url;
      merged.set(name, entry);
    }
    const remotes: GitRemoteInfoDTO[] = [];
    for (const [name, urls] of merged) {
      remotes.push({
        name,
        fetchUrl: sanitizeCredentialUrl(urls.fetch ?? urls.push ?? ''),
        pushUrl: sanitizeCredentialUrl(urls.push ?? urls.fetch ?? ''),
      });
    }
    return remotes;
  }

  /**
   * 只读方法的仓库根解析。与 resolveRepository（写路径）同样校验 workspace 包含关系：
   * rev-parse --show-toplevel 可能跳出工作区（工作区本身位于某个 git 仓库内部时），
   * 不校验会让这些方法作用到外层仓库、getCommitFileDiff 读到工作区之外的受控文件内容。
   */
  private async resolveRepoRoot(sessionWorkspace: string, repoPath?: string | null): Promise<string> {
    const workspace = realPath(this.pathSandbox.getEffectiveWorkspaceRoot(sessionWorkspace));
    const repoDir = this.resolveRepoDir(workspace, repoPath);
    const repoRootStr = await this.runGitOk(repoDir, ['rev-parse', '--show-toplevel']);
    if (repoRootStr == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '当前工作区不是 Git 仓库');
    }
    const root = resolve(repoRootStr.trim());
    if (!isUnderReal(root, workspace)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    return root;
  }

  /**
   * 分支名 → 提交对象 id 的显式解析（两段式：本地分支 → 远端跟踪分支）。
   * 必须带 `refs/heads/` / `refs/remotes/` 前缀：裸名会走 git 的 refname 解析顺序，
   * 而 refs/tags/ 优先于 refs/heads/（实测同名时裸名解析到 tag 且 stderr 打
   * `warning: refname 'x' is ambiguous.`）——用户在下拉里选的是分支、实际比对的却是
   * 同名 tag 指向的对象，属静默错误；显式 ref 路径把语义钉死在分支上。
   * verify 成功却取不到对象 id 属异常（正常输出即 40/64 位 sha），一并按「分支不存在」处理。
   */
  private async resolveBranchSha(repoRoot: string, name: string): Promise<string> {
    for (const prefix of ['refs/heads/', 'refs/remotes/']) {
      const resolved = await this.runGitOk(repoRoot, ['rev-parse', '--verify', `${prefix}${name}`]);
      if (resolved == null) continue;
      const sha = firstObjectId(resolved);
      if (sha != null) return sha;
    }
    throw new BusinessException(ErrorCode.PARAM_INVALID, '分支不存在');
  }

  changedFiles(repoRoot: string): Promise<Map<string, GitChangedFileDTO>> {
    return this.collectChangedFiles(repoRoot);
  }

  private resolveRepoDir(workspace: string, repoPath?: string | null): string {
    if (repoPath == null || repoPath.trim().length === 0) {
      return workspace;
    }
    const normalized = repoPath.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
    if (normalized.length === 0 || normalized === '.' || normalized.includes('/') || normalized.split('/').some((p) => p === '..')) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    let repoDir: string;
    try {
      repoDir = resolve(workspace, normalized);
    } catch {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    if (!isUnder(repoDir, workspace) || !existsSync(repoDir) || !statSync(repoDir).isDirectory()) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    try {
      this.pathSandbox.resolve(repoDir, workspace);
    } catch (e) {
      if (e instanceof SecurityException) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
      }
      throw e;
    }
    return repoDir;
  }

  private async summarizeRepo(repoDir: string): Promise<GitRepoSummaryDTO> {
    try {
      const result = await runGitRaw(repoDir, ['status', '--porcelain=v2', '--branch', '-M', '--untracked-files=all'], GIT_TIMEOUT_SECONDS * 1000);
      if (result.timedOut || result.exitCode !== 0) {
        return unavailableRepo(repoDir);
      }
      let branch: string | undefined;
      let count = 0;
      const untrackedPaths: string[] = [];
      for (const line of result.stdout.split('\n')) {
        if (line.length === 0) continue;
        if (line.charAt(0) === '#') {
          if (line.startsWith('# branch.head ')) {
            const name = line.slice('# branch.head '.length).trim();
            branch = name === '(detached)' ? 'HEAD' : name;
          }
          continue;
        }
        count++;
        if (line.startsWith('? ')) untrackedPaths.push(line.slice(2));
      }
      const dto: GitRepoSummaryDTO = {
        name: basename(repoDir),
        path: basename(repoDir),
        branch,
        changedFileCount: count,
      };
      if (count > 0) {
        const lineStats = await this.collectRepoLineStats(repoDir, untrackedPaths);
        dto.insertions = lineStats[0];
        dto.deletions = lineStats[1];
      }
      return dto;
    } catch (e) {
      console.warn(`Failed to summarize git repo ${repoDir}: ${(e as Error).message}`);
      return unavailableRepo(repoDir);
    }
  }

  private async collectRepoLineStats(repoDir: string, untrackedPaths: string[]): Promise<[number, number]> {
    let insertions = 0;
    let deletions = 0;
    let numstat = await this.runGitOk(repoDir, ['diff', '--numstat', 'HEAD']);
    if (numstat == null && (await this.runGitOk(repoDir, ['rev-parse', '--verify', 'HEAD'])) == null) {
      numstat = await this.runGitOk(repoDir, ['diff', '--numstat', '--cached']);
    }
    if (numstat != null) {
      for (const line of numstat.split('\n')) {
        const parts = line.split('\t');
        if (parts.length < 3 || parts[0] === '-' || parts[1] === '-') continue;
        insertions += parseIntSafe(parts[0]);
        deletions += parseIntSafe(parts[1]);
      }
    }
    for (const relativePath of untrackedPaths) {
      const file = resolve(repoDir, relativePath);
      if (!isUnder(file, repoDir) || !existsSync(file) || !statSync(file).isFile()) continue;
      const read = readTextLimited(file);
      if (!read.binary) insertions += countLines(read.content);
    }
    return [insertions, deletions];
  }

  private async collectChangedFiles(repoRoot: string): Promise<Map<string, GitChangedFileDTO>> {
    const files = new Map<string, GitChangedFileDTO>();
    let nameStatus = await this.runGitOk(repoRoot, ['diff', '--name-status', 'HEAD']);
    if (nameStatus == null && (await this.runGitOk(repoRoot, ['rev-parse', '--verify', 'HEAD'])) == null) {
      nameStatus = await this.runGitOk(repoRoot, ['diff', '--name-status', '--cached']);
    }
    if (nameStatus != null && nameStatus.trim().length > 0) {
      for (let line of nameStatus.split('\n')) {
        line = line.trim();
        if (line.length === 0) continue;
        const file = parseNameStatusLine(line);
        if (file) files.set(file.path, file);
      }
    }
    let numstat = await this.runGitOk(repoRoot, ['diff', '--numstat', 'HEAD']);
    if (numstat == null && (await this.runGitOk(repoRoot, ['rev-parse', '--verify', 'HEAD'])) == null) {
      numstat = await this.runGitOk(repoRoot, ['diff', '--numstat', '--cached']);
    }
    if (numstat != null && numstat.trim().length > 0) {
      for (let line of numstat.split('\n')) {
        line = line.trim();
        if (line.length === 0) continue;
        const parts = line.split('\t');
        if (parts.length < 3) continue;
        const path = numstatNewPath(parts[parts.length - 1]);
        const file = files.get(path);
        if (!file) continue;
        if (parts[0] === '-' || parts[1] === '-') {
          file.binary = true;
          file.insertions = 0;
          file.deletions = 0;
        } else {
          file.insertions = parseIntSafe(parts[0]);
          file.deletions = parseIntSafe(parts[1]);
        }
      }
    }
    const untracked = await this.runGitOk(repoRoot, ['ls-files', '--others', '--exclude-standard']);
    if (untracked != null && untracked.trim().length > 0) {
      for (const line of untracked.split('\n')) {
        const path = line.trim().replace(/\\/g, '/');
        if (path.length === 0 || files.has(path)) continue;
        const file: GitChangedFileDTO = { path, changeType: 'CREATED', untracked: true, insertions: 0, deletions: 0 };
        const abs = resolve(repoRoot, path);
        if (existsSync(abs) && statSync(abs).isFile()) {
          const read = readTextLimited(abs);
          if (read.binary) {
            file.binary = true;
          } else {
            file.insertions = countLines(read.content);
          }
        }
        files.set(path, file);
      }
    }
    return files;
  }

  private async inferChangeType(repoRoot: string, path: string, absolute: string): Promise<string> {
    const inHead = (await this.showHeadContent(repoRoot, path)) != null;
    const inWorktree = existsSync(absolute) && statSync(absolute).isFile();
    if (!inHead && inWorktree) return 'CREATED';
    if (inHead && !inWorktree) return 'DELETED';
    return 'MODIFIED';
  }

  private async showHeadContent(repoRoot: string, path: string | null | undefined): Promise<string | null> {
    if (path == null || path.trim().length === 0) return null;
    const result = await runGitRaw(repoRoot, ['show', `HEAD:${path}`], GIT_TIMEOUT_SECONDS * 1000);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }

  private async runGitOk(cwd: string, args: string[]): Promise<string | null> {
    const result = await runGitRaw(cwd, args, GIT_TIMEOUT_SECONDS * 1000);
    if (result.exitCode !== 0) return null;
    return result.stdout;
  }
}

function unavailableRepo(repoDir: string): GitRepoSummaryDTO {
  return { name: basename(repoDir), path: basename(repoDir), unavailable: true };
}

/**
 * numstat 路径字段还原成完整新路径，与 name-status 的键对齐。
 * git 对检测到的改名不输出完整新路径，而是紧凑形态：
 * - 无共同前后缀：`old => new`（简单形态）
 * - 有共同前缀（或有共同后缀）：`prefix/{old => new}suffix`（花括号紧凑形态，实测同目录改名即此形态）
 * name-status 的 R 行始终输出完整 old/new 两个路径，因此这里必须把紧凑形态还原，
 * 否则键匹配不上，改名文件的 insertions/deletions 被静默丢弃（恒显示 +0/-0）。
 */
function numstatNewPath(raw: string): string {
  const path = raw.replace(/\\/g, '/').trim();
  const arrow = path.lastIndexOf(' => ');
  if (arrow < 0) return path;
  const braceStart = path.lastIndexOf('{', arrow);
  const braceEnd = braceStart >= 0 ? path.indexOf('}', arrow) : -1;
  if (braceStart >= 0 && braceEnd > arrow) {
    // 花括号紧凑形态：新路径 = 公共前缀 + 括号内新名 + 公共后缀
    return path.slice(0, braceStart) + path.slice(arrow + 4, braceEnd) + path.slice(braceEnd + 1);
  }
  return path.slice(arrow + 4).trim();
}

function parseNameStatusLine(line: string): GitChangedFileDTO | null {
  const parts = line.split('\t');
  if (parts.length < 2) return null;
  const status = parts[0].trim();
  const code = status.length === 0 ? '?' : status.charAt(0);
  const file: GitChangedFileDTO = { path: '', changeType: 'MODIFIED', insertions: 0, deletions: 0 };
  switch (code) {
    case 'A':
      file.changeType = 'CREATED';
      file.path = parts[1].replace(/\\/g, '/');
      break;
    case 'M':
      file.changeType = 'MODIFIED';
      file.path = parts[1].replace(/\\/g, '/');
      break;
    case 'D':
      file.changeType = 'DELETED';
      file.path = parts[1].replace(/\\/g, '/');
      break;
    case 'R':
      if (parts.length < 3) return null;
      file.changeType = 'RENAMED';
      file.oldPath = parts[1].replace(/\\/g, '/');
      file.path = parts[2].replace(/\\/g, '/');
      break;
    case 'C':
      if (parts.length < 3) return null;
      file.changeType = 'COPIED';
      file.oldPath = parts[1].replace(/\\/g, '/');
      file.path = parts[2].replace(/\\/g, '/');
      break;
    default:
      file.changeType = 'MODIFIED';
      file.path = parts[parts.length - 1].replace(/\\/g, '/');
  }
  return file;
}

/** 解析 `git log --format=%H%x00%h%x00%s%x00%an%x00%aI%x00%D` 的一行（NUL 分隔字段）。 */
function parseLogLine(line: string): GitLogEntryDTO | null {
  const parts = line.split('\0');
  if (parts.length < 6) return null;
  const [hash, shortHash, title, author, date, refs] = parts;
  if (hash.trim().length === 0) return null;
  const entry: GitLogEntryDTO = {
    hash: hash.trim(),
    shortHash: shortHash.trim(),
    title,
    author: author.trim(),
    date: date.trim(),
  };
  if (refs.trim().length > 0) entry.refs = refs;
  return entry;
}

/**
 * 解析 `git branch -vv` 一行：
 * `* main abc1234 [origin/main: ahead 1, behind 2] subject`
 * `  main abc1234 [origin/main] subject` / `  main abc1234 subject`（无 upstream）
 * detached 行 `* (HEAD detached at abc1234) def5678 subject` 的 name 以 '(' 开头，由调用方跳过。
 * 空仓库未出生分支无 hash（`* main`），lastCommitHash 留空。
 */
function parseBranchVvLine(line: string): {
  name: string;
  isCurrent: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  lastCommitHash?: string;
  lastCommitTitle?: string;
} | null {
  if (line.trim().length === 0) return null;
  const isCurrent = line.startsWith('*');
  let rest = line.replace(/^\*?\s+/, '');
  const nameMatch = /^(\S+)\s*(.*)$/.exec(rest);
  if (!nameMatch) return null;
  const name = nameMatch[1];
  rest = nameMatch[2];
  const hashMatch = /^([0-9a-f]{7,64})\s*(.*)$/.exec(rest);
  let lastCommitHash: string | undefined;
  if (hashMatch) {
    lastCommitHash = hashMatch[1];
    rest = hashMatch[2];
  }
  let upstream: string | undefined;
  let ahead: number | undefined;
  let behind: number | undefined;
  const bracketMatch = /^\[([^\]]*)\]\s*(.*)$/.exec(rest);
  if (bracketMatch) {
    const inside = bracketMatch[1];
    rest = bracketMatch[2];
    const colonIdx = inside.indexOf(':');
    const upstreamPart = (colonIdx >= 0 ? inside.slice(0, colonIdx) : inside).trim();
    // 'gone' 是方括号内的跟踪态（upstream 在远端已被 prune），upstream 名本身仍展示
    // （与 git branch -vv 输出一致）；ahead/behind 只在明确给出时解析，gone 时自然留空
    if (upstreamPart.length > 0 && upstreamPart !== 'gone') upstream = upstreamPart;
    if (colonIdx >= 0) {
      const aheadMatch = /ahead (\d+)/.exec(inside);
      const behindMatch = /behind (\d+)/.exec(inside);
      if (aheadMatch) ahead = parseIntSafe(aheadMatch[1]);
      if (behindMatch) behind = parseIntSafe(behindMatch[1]);
    }
  }
  const lastCommitTitle = rest.trim().length > 0 ? rest.trim() : undefined;
  return { name, isCurrent, upstream, ahead, behind, lastCommitHash, lastCommitTitle };
}

function clampInt(value: number | undefined | null, fallback: number, min: number, max: number): number {
  const n = value == null ? fallback : Math.floor(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function readTextLimited(file: string): { content: string; truncated: boolean; binary: boolean } {
  try {
    const size = statSync(file).size;
    const buf = Buffer.alloc(Math.min(size, MAX_DIFF_BYTES + 1));
    const fh = openSync(file, 'r');
    try {
      const n = readSync(fh, buf, 0, buf.length, 0);
      const bytes = buf.subarray(0, n);
      for (const b of bytes) {
        if (b === 0) return { content: '', truncated: false, binary: true };
      }
      const content = bytes.toString('utf8');
      const trunc = truncateText(content);
      return { content: trunc.content, truncated: trunc.truncated || size > bytes.length, binary: false };
    } finally {
      closeSync(fh);
    }
  } catch (e) {
    console.warn(`Failed to read file for git diff: ${file}`, e);
    return { content: '', truncated: false, binary: true };
  }
}

function truncateText(content: string | null): { content: string; truncated: boolean } {
  if (content == null) return { content: '', truncated: false };
  let truncated = false;
  const rawLines = content.split('\n');
  if (rawLines.length > MAX_DIFF_LINES) {
    content = rawLines.slice(0, MAX_DIFF_LINES).join('\n');
    truncated = true;
  }
  const bytes = Buffer.from(content, 'utf8');
  if (bytes.length > MAX_DIFF_BYTES) {
    let end = MAX_DIFF_BYTES;
    while (end > 0 && (bytes[end - 1] & 0xc0) === 0x80) end--;
    content = bytes.subarray(0, end).toString('utf8');
    truncated = true;
  }
  return { content, truncated };
}

function isBinaryString(content: string): boolean {
  return content.includes('\0');
}

function countLines(content: string): number {
  if (content == null || content.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < content.length; i++) {
    if (content.charAt(i) === '\n') lines++;
  }
  if (content.endsWith('\n') && lines > 1) lines--;
  return Math.max(lines, 1);
}

function parseIntSafe(s: string): number {
  const n = Number.parseInt(s.trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 从 runGitRaw 的输出里取出对象 id。runGitRaw 把 stdout+stderr 合并进同一流，
 * 故输出可能带前置警告行：criss-cross 历史（多个最佳共同祖先）下 `git diff A...B`
 * 会打 `warning: ... multiple merge bases, using <sha>`，`git merge-base` 也可能多行输出。
 * 只认第一行形如对象 id 的内容（40 位 SHA-1 / 64 位 SHA-256），其余（警告、空行）跳过。
 */
export function firstObjectId(output: string): string | null {
  for (const line of output.split('\n')) {
    const candidate = line.trim();
    if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(candidate)) return candidate;
  }
  return null;
}

function realPath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function isUnderReal(resolved: string, root: string): boolean {
  return isUnder(realPath(resolved), realPath(root));
}

export interface GitRawResult {
  exitCode: number;
  stdout: string;
  timedOut: boolean;
}

export function runGitRaw(cwd: string, args: string[], timeoutMs: number): Promise<GitRawResult> {
  return new Promise((resolveP) => {
    const child = spawn('git', ['-c', 'core.quotepath=false', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const onData = (buf: Buffer) => {
      if (size >= MAX_STDOUT_BYTES) return;
      const allowed = Math.min(buf.length, MAX_STDOUT_BYTES - size);
      chunks.push(buf.subarray(0, allowed));
      size += allowed;
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolveP({ exitCode: 124, stdout: '', timedOut: true });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolveP({ exitCode: 127, stdout: e.message ?? '', timedOut: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveP({ exitCode: code ?? 1, stdout: Buffer.concat(chunks).toString('utf8'), timedOut: false });
    });
  });
}
