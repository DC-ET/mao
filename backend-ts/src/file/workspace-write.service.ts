import { lstatSync, realpathSync } from 'node:fs';
import { lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import {
  IllegalArgumentException,
  isUnder,
  PathSandbox,
  SecurityException,
} from '../harness/safety/path-sandbox.js';
import {
  canonicalLockPath,
  FileWriteConflict,
  holdDirectories,
  withUserFileLocks,
} from '../harness/tool/impl/file-write-lock.js';
import type { ActivityService } from '../session/activity.service.js';

export const MAX_WRITE_CONTENT_BYTES = 10 * 1024 * 1024;
export const MAX_COPY_ENTRIES = 10_000;
export const MAX_COPY_BYTES = 2 * 1024 * 1024 * 1024;

/** 测试可下调；请求路径上按这个对象读取，避免复制上限写死在闭包里。 */
export const copyLimits = { entries: MAX_COPY_ENTRIES, bytes: MAX_COPY_BYTES };

const OP_LABEL: Record<string, string> = {
  mkdir: '新建目录',
  write: '新建文件',
  rename: '重命名',
  move: '移动',
  delete: '删除',
  copy: '复制',
  upload: '上传',
};

export interface WriteOptions {
  force?: boolean;
  overwrite?: boolean;
}

export interface UploadPart {
  relativePath: string;
  bytes: Buffer;
}

interface ResolvedPath {
  abs: string;
  rel: string;
  real: string;
}

export class WorkspaceWriteService {
  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly activityService: ActivityService,
  ) {}

  async mkdir(sessionId: number, workspace: string, userPath: string, opts?: WriteOptions): Promise<{ path: string }> {
    const target = this.resolveWritable(userPath, workspace);
    await this.withDir(workspace, [target.abs], opts?.force, async () => {
      await this.assertAbsent(target, 'mkdir');
      await mkdir(target.abs, { recursive: true });
      await this.record(sessionId, target.rel, 'mkdir', opts?.force);
    });
    return { path: target.rel };
  }

  async write(sessionId: number, workspace: string, userPath: string, content: string | null | undefined, opts?: WriteOptions): Promise<{ path: string }> {
    const text = content ?? '';
    if (text.includes('\0')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件内容不能包含空字节');
    }
    if (Buffer.byteLength(text, 'utf8') > MAX_WRITE_CONTENT_BYTES) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '文件内容超过 10MB');
    }
    const target = this.resolveWritable(userPath, workspace);
    await this.withFiles(workspace, [target.abs], opts?.force, async () => {
      await this.assertCanCreateFile(target, opts?.overwrite === true);
      await this.writeTextAtomic(target.abs, text);
      await this.record(sessionId, target.rel, 'write', opts?.force);
    });
    return { path: target.rel };
  }

  async rename(sessionId: number, workspace: string, userPath: string, newName: string, opts?: WriteOptions): Promise<{ path: string }> {
    assertBaseName(newName);
    const source = this.resolveWritable(userPath, workspace, true);
    this.assertNotRoot(workspace, source);
    const destAbs = join(dirname(source.abs), newName);
    const dest = this.resolveWritable(destAbs, workspace);
    const sourceStat = await this.requireExisting(source);
    const run = sourceStat.isDirectory && !sourceStat.isSymbolicLink
      ? (fn: () => Promise<void>) => this.withDir(workspace, [source.abs, dest.abs], opts?.force, fn)
      : (fn: () => Promise<void>) => this.withFiles(workspace, [source.abs, dest.abs], opts?.force, fn);
    await run(async () => {
      if (source.rel !== dest.rel) {
        await this.assertAbsent(dest, 'rename');
      }
      await this.assertParentDirectory(dest.abs);
      if (source.abs !== dest.abs) {
        await rename(source.abs, dest.abs);
      }
      await this.record(sessionId, `${source.rel} → ${dest.rel}`, 'rename', opts?.force);
    });
    return { path: dest.rel };
  }

  async move(sessionId: number, workspace: string, from: string, to: string, opts?: WriteOptions): Promise<{ path: string }> {
    const placed = await this.place(workspace, from, to, 'move');
    const run = placed.sourceIsDirectory
      ? (fn: () => Promise<void>) => this.withDir(workspace, [placed.source.abs, placed.dest.abs], opts?.force, fn)
      : (fn: () => Promise<void>) => this.withFiles(workspace, [placed.source.abs, placed.dest.abs], opts?.force, fn);
    await run(async () => {
      await this.assertAbsent(placed.dest, 'move');
      await this.assertParentDirectory(placed.dest.abs);
      await rename(placed.source.abs, placed.dest.abs);
      await this.record(sessionId, `${placed.source.rel} → ${placed.dest.rel}`, 'move', opts?.force);
    });
    return { path: placed.dest.rel };
  }

  async delete(sessionId: number, workspace: string, userPath: string, opts?: WriteOptions): Promise<{ path: string }> {
    const target = this.resolveWritable(userPath, workspace, true);
    this.assertNotRoot(workspace, target);
    const stat = await this.requireExisting(target);
    const run = stat.isDirectory && !stat.isSymbolicLink
      ? (fn: () => Promise<void>) => this.withDir(workspace, [target.abs], opts?.force, fn)
      : (fn: () => Promise<void>) => this.withFiles(workspace, [target.abs], opts?.force, fn);
    await run(async () => {
      if (stat.isSymbolicLink || !stat.isDirectory) {
        await rm(target.abs, { recursive: false, force: false });
      } else {
        await rm(target.abs, { recursive: true, force: false });
      }
      await this.record(sessionId, target.rel, 'delete', opts?.force);
    });
    return { path: target.rel };
  }

  async copy(sessionId: number, workspace: string, from: string, to: string, opts?: WriteOptions): Promise<{ path: string }> {
    const placed = await this.place(workspace, from, to, 'copy');
    const run = placed.sourceIsDirectory
      ? (fn: () => Promise<void>) => this.withDir(workspace, [placed.source.abs, placed.dest.abs], opts?.force, fn)
      : (fn: () => Promise<void>) => this.withFiles(workspace, [placed.source.abs, placed.dest.abs], opts?.force, fn);
    await run(async () => {
      await this.assertCopyTarget(placed.dest, placed.sourceIsDirectory, opts?.overwrite === true);
      await this.assertParentDirectory(placed.dest.abs);
      await this.copyTree(placed.source.abs, placed.dest.abs, placed.sourceIsDirectory, opts?.overwrite === true);
      await this.record(sessionId, `${placed.source.rel} → ${placed.dest.rel}`, 'copy', opts?.force);
    });
    return { path: placed.dest.rel };
  }

  async upload(
    sessionId: number,
    workspace: string,
    dir: string,
    files: UploadPart[],
    opts?: WriteOptions,
  ): Promise<{ path: string }> {
    if (files.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const directory = this.resolveWritable(dir == null || dir.trim() === '' ? '.' : dir, workspace);
    const dirStat = await this.statExact(directory);
    if (dirStat?.isSymbolicLink) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不能上传到符号链接');
    }
    if (dirStat && !dirStat.isDirectory) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '上传目标不是目录');
    }
    const planned = files.map((file) => {
      const rel = joinRelative(directory.rel, file.relativePath);
      const target = this.resolveWritable(rel, workspace);
      return { target, bytes: file.bytes };
    });
    const canonicals = planned.map((item) => canonicalLockPath(item.target.abs));
    if (!opts?.overwrite) {
      const seen = new Set<string>();
      for (const key of canonicals) {
        if (seen.has(key)) {
          throw new BusinessException(ErrorCode.WORKSPACE_TARGET_EXISTS, '目标已存在');
        }
        seen.add(key);
      }
    }
    for (let i = 0; i < canonicals.length; i++) {
      for (let j = i + 1; j < canonicals.length; j++) {
        const left = canonicals[i];
        const right = canonicals[j];
        if (left !== right && (right.startsWith(left + sep) || left.startsWith(right + sep))) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, '上传路径互相冲突');
        }
      }
    }
    await this.withFiles(workspace, planned.map((item) => item.target.abs), opts?.force, async () => {
      if (!dirStat) {
        await mkdir(directory.abs, { recursive: true });
      }
      for (const item of planned) {
        await this.assertCanCreateFile(item.target, opts?.overwrite === true);
      }
      for (const item of planned) {
        await mkdir(dirname(item.target.abs), { recursive: true });
        await this.writeBytesAtomic(item.target.abs, item.bytes);
      }
      await this.record(sessionId, directory.rel === '.' ? '.' : directory.rel, 'upload', opts?.force);
    });
    return { path: directory.rel === '.' ? '.' : directory.rel };
  }

  private async withFiles(workspace: string, paths: string[], force: boolean | undefined, fn: () => Promise<void>): Promise<void> {
    try {
      await withUserFileLocks(paths, force === true, fn);
    } catch (e) {
      this.rethrowConflict(workspace, e);
    }
  }

  private async withDir(workspace: string, paths: string[], force: boolean | undefined, fn: () => Promise<void>): Promise<void> {
    let hold: { release(): void } | null = null;
    try {
      hold = holdDirectories(paths, force === true);
    } catch (e) {
      this.rethrowConflict(workspace, e);
    }
    try {
      await fn();
    } finally {
      hold?.release();
    }
  }

  private async assertParentDirectory(destAbs: string): Promise<void> {
    const parent = dirname(destAbs);
    const stat = await statExactAt(parent, null);
    if (stat?.isDirectory) return;
    if (stat?.isSymbolicLink) {
      try {
        const realStat = await lstat(realpathSync(parent));
        if (realStat.isDirectory()) return;
      } catch {
        // 断掉的符号链接不能当目录用
      }
    }
    throw new BusinessException(ErrorCode.PARAM_INVALID, '目标目录不存在');
  }

  private rethrowConflict(workspace: string, e: unknown): never {
    if (e instanceof FileWriteConflict) {
      const shown = e.paths.map((p) => this.displayPath(workspace, p));
      throw new BusinessException(ErrorCode.WORKSPACE_WRITE_CONFLICT, `Agent 正在写入：${shown.join('；')}`);
    }
    throw e;
  }

  private displayPath(workspace: string, abs: string): string {
    const rel = relative(resolve(workspace), abs);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return abs;
    return rel.split(sep).join('/');
  }

  private resolveWritable(userPath: string, workspace: string, keepSymlinkLeaf = false): ResolvedPath {
    const workspaceAbs = resolve(workspace);
    let workspaceReal: string;
    try {
      workspaceReal = realpathSync(workspaceAbs);
    } catch {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '工作区不存在');
    }
    let abs: string;
    try {
      abs = this.pathSandbox.resolve(userPath, workspace);
    } catch (e) {
      if (e instanceof SecurityException) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
      }
      if (e instanceof IllegalArgumentException) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, e.message);
      }
      throw e;
    }
    if (!isUnder(abs, workspaceAbs)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const real = realJoined(abs, keepSymlinkLeaf);
    if (!isUnder(real, workspaceReal)) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '路径访问被拒绝');
    }
    const relRaw = relative(workspaceAbs, abs);
    const rel = relRaw === '' ? '.' : relRaw.split(sep).join('/');
    return { abs, rel, real };
  }

  private assertNotRoot(workspace: string, target: ResolvedPath): void {
    if (target.rel === '.' || target.real === realpathSync(resolve(workspace))) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不能操作工作区根目录');
    }
  }

  private async requireExisting(target: ResolvedPath): Promise<EntryStat> {
    const stat = await this.statExact(target);
    if (!stat) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '路径不存在');
    }
    return stat;
  }

  private async assertAbsent(target: ResolvedPath, op: 'mkdir' | 'rename' | 'move'): Promise<void> {
    const stat = await this.statExact(target);
    if (!stat) return;
    if (stat.isSymbolicLink) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目标是符号链接');
    }
    throw new BusinessException(ErrorCode.WORKSPACE_TARGET_EXISTS, existsMessage(op));
  }

  private async assertCanCreateFile(target: ResolvedPath, overwrite: boolean): Promise<void> {
    const parentStat = await statExactAt(dirname(target.abs), null);
    if (parentStat && !parentStat.isDirectory) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '父路径不是目录');
    }
    const stat = await this.statExact(target);
    if (!stat) return;
    if (stat.isSymbolicLink) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目标是符号链接');
    }
    if (stat.isDirectory) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '不能用文件覆盖目录');
    }
    if (!overwrite) {
      throw new BusinessException(ErrorCode.WORKSPACE_TARGET_EXISTS, '目标已存在');
    }
  }

  private async assertCopyTarget(target: ResolvedPath, sourceIsDirectory: boolean, overwrite: boolean): Promise<void> {
    const stat = await this.statExact(target);
    if (!stat) return;
    if (stat.isSymbolicLink) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目标是符号链接');
    }
    if (stat.isDirectory !== sourceIsDirectory) {
      throw new BusinessException(
        ErrorCode.PARAM_INVALID,
        sourceIsDirectory ? '不能用目录覆盖文件' : '不能用文件覆盖目录',
      );
    }
    if (sourceIsDirectory || !overwrite) {
      throw new BusinessException(ErrorCode.WORKSPACE_TARGET_EXISTS, '目标已存在');
    }
  }

  private async statExact(target: ResolvedPath): Promise<EntryStat | null> {
    return statExactAt(dirname(target.abs), basename(target.abs));
  }

  private async place(workspace: string, from: string, to: string, op: 'move' | 'copy'): Promise<{
    source: ResolvedPath;
    dest: ResolvedPath;
    sourceIsDirectory: boolean;
  }> {
    const source = this.resolveWritable(from, workspace, true);
    this.assertNotRoot(workspace, source);
    const sourceStat = await this.requireExisting(source);
    let dest = this.resolveWritable(to, workspace);
    const destStat = await this.statExact(dest);
    if (destStat?.isSymbolicLink) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目标是符号链接');
    }
    if (destStat?.isDirectory) {
      dest = this.resolveWritable(join(dest.abs, basename(source.abs)), workspace);
    }
    const sourceKey = canonicalLockPath(source.abs);
    const destKey = canonicalLockPath(dest.abs);
    if (source.rel === dest.rel || sourceKey === destKey) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, op === 'move' ? '不能移动到自身' : '不能复制到自身');
    }
    if (sourceStat.isDirectory && !sourceStat.isSymbolicLink && (isUnder(dest.abs, source.abs) || isUnder(destKey, sourceKey))) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, op === 'move' ? '不能移进自己' : '不能复制到自身内部');
    }
    const parentStat = await statExactAt(dirname(dest.abs), null);
    if (parentStat && !parentStat.isDirectory && !parentStat.isSymbolicLink) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '目标父路径不是目录');
    }
    return { source, dest, sourceIsDirectory: sourceStat.isDirectory && !sourceStat.isSymbolicLink };
  }

  private async copyTree(from: string, to: string, sourceIsDirectory: boolean, overwrite: boolean): Promise<void> {
    const measured = await measureTree(from);
    if (measured.entries > copyLimits.entries || measured.bytes > copyLimits.bytes) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '复制内容过大，请改走下载-上传');
    }
    if (!sourceIsDirectory) {
      await this.copyFileAtomic(from, to, overwrite);
      return;
    }
    try {
      await copyDirectory(from, to);
    } catch (e) {
      await rm(to, { recursive: true, force: true }).catch(() => undefined);
      throw e;
    }
  }

  private async copyFileAtomic(from: string, to: string, overwrite: boolean): Promise<void> {
    const lst = await lstat(from);
    if (lst.isSymbolicLink()) {
      if (overwrite) await rm(to, { force: true }).catch(() => undefined);
      await symlink(await readlink(from), to);
      return;
    }
    const bytes = await readFile(from);
    if (!overwrite) {
      const existing = await statExactAt(dirname(to), basename(to));
      if (existing) {
        throw new BusinessException(ErrorCode.WORKSPACE_TARGET_EXISTS, '目标已存在');
      }
    }
    await this.writeBytesAtomic(to, bytes);
  }

  private async writeTextAtomic(filePath: string, text: string): Promise<void> {
    await this.writeBytesAtomic(filePath, Buffer.from(text, 'utf8'));
  }

  private async writeBytesAtomic(filePath: string, bytes: Buffer): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = join(dirname(filePath), `.mao-write-${randomUUID()}`);
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, filePath);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }

  private async record(sessionId: number, target: string, op: string, force: boolean | undefined): Promise<void> {
    const detail: { actor: 'user'; op: string; force?: true } = { actor: 'user', op };
    if (force) detail.force = true;
    await this.activityService.record(
      sessionId,
      'file_user_write',
      target,
      `用户${OP_LABEL[op] ?? op}`,
      JSON.stringify(detail),
      'SUCCESS',
      null,
    );
  }
}

interface EntryStat {
  isDirectory: boolean;
  isSymbolicLink: boolean;
}

async function statExactAt(parent: string, name: string | null): Promise<EntryStat | null> {
  if (name == null) {
    try {
      const lst = await lstat(parent);
      return { isDirectory: lst.isDirectory(), isSymbolicLink: lst.isSymbolicLink() };
    } catch {
      return null;
    }
  }
  let names: string[];
  try {
    names = await readdir(parent);
  } catch {
    return null;
  }
  if (!names.includes(name)) return null;
  const lst = await lstat(join(parent, name));
  return { isDirectory: lst.isDirectory(), isSymbolicLink: lst.isSymbolicLink() };
}

function realJoined(abs: string, keepSymlinkLeaf: boolean): string {
  const missing: string[] = [];
  let current = abs;
  if (keepSymlinkLeaf) {
    try {
      if (lstatSync(abs).isSymbolicLink()) {
        missing.push(basename(abs));
        current = dirname(abs);
      }
    } catch {
      // 叶子还不存在，按普通路径找最深的已存在父目录
    }
  }
  while (true) {
    let exists = false;
    try {
      lstatSync(current);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) break;
    const parent = dirname(current);
    if (parent === current) break;
    missing.push(basename(current));
    current = parent;
  }
  let real = current;
  try {
    real = realpathSync(current);
  } catch {
    real = current;
  }
  return missing.reverse().reduce((p, seg) => join(p, seg), real);
}

function assertBaseName(name: string): void {
  if (typeof name !== 'string' || name.length === 0 || name !== name.trim()) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '名称不合法');
  }
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\0')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '名称不合法');
  }
}

function existsMessage(op: 'mkdir' | 'rename' | 'move'): string {
  if (op === 'mkdir') return '目录已存在';
  if (op === 'rename') return '目标已存在';
  return '目标已存在';
}

export function joinRelative(dir: string, relativePath: string): string {
  if (typeof relativePath !== 'string' || relativePath.includes('\0')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '非法相对路径');
  }
  if (relativePath.startsWith('/') || relativePath.startsWith('\\') || /^[A-Za-z]:[\\/]/.test(relativePath)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '非法相对路径');
  }
  const parts = relativePath.split(/[/\\]/).filter((seg) => seg.length > 0 && seg !== '.');
  if (parts.some((seg) => seg === '..')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '非法相对路径');
  }
  const base = !dir || dir === '.' ? [] : dir.split(/[/\\]/).filter((seg) => seg.length > 0 && seg !== '.');
  if (base.some((seg) => seg === '..')) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '非法相对路径');
  }
  return [...base, ...parts].join('/');
}

async function measureTree(root: string): Promise<{ entries: number; bytes: number }> {
  let entries = 0;
  let bytes = 0;
  async function walk(p: string): Promise<void> {
    const lst = await lstat(p);
    entries += 1;
    if (lst.isSymbolicLink()) {
      bytes += lst.size;
      return;
    }
    if (lst.isDirectory()) {
      const names = await readdir(p);
      for (const name of names) {
        await walk(join(p, name));
      }
      return;
    }
    bytes += lst.size;
  }
  await walk(root);
  return { entries, bytes };
}

async function copyDirectory(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  const names = await readdir(from);
  for (const name of names) {
    const src = join(from, name);
    const dest = join(to, name);
    const lst = await lstat(src);
    if (lst.isSymbolicLink()) {
      const link = await readlink(src);
      await symlink(link, dest);
      continue;
    }
    if (lst.isDirectory()) {
      await copyDirectory(src, dest);
      continue;
    }
      const bytes = await readFile(src);
    const tmp = join(dirname(dest), `.mao-write-${randomUUID()}`);
    try {
      await writeFile(tmp, bytes);
      await rename(tmp, dest);
    } catch (e) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw e;
    }
  }
}
