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
        let path = parts[parts.length - 1].replace(/\\/g, '/');
        if (path.includes(' => ')) {
          path = path.slice(path.lastIndexOf(' => ') + 4).trim();
        }
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
