/**
 * 按绝对路径串行化文件读-改-写，避免并行工具调用对同一文件
 * 各自 readFileSync 旧内容后先后 writeFileSync 互相覆盖。
 *
 * 用户文件管理在同一把锁上查询在途写入：入队即登记，目录操作按祖先/子孙前缀冲突，
 * 并在删除目录期间拦住新的 write_file / edit_file。
 */
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import path from 'node:path';

const pathLocks = new Map<string, Promise<void>>();
/** 同一路径可有多把锁排队；释放时按计数减，避免前一把的 finally 把后一把提前摘掉。 */
const inFlight = new Map<string, number>();
const heldDirs = new Set<string>();
const dirWaiters: Array<() => void> = [];

export class FileWriteConflict extends Error {
  readonly paths: string[];

  constructor(paths: string[]) {
    super(paths.join('；'));
    this.name = 'FileWriteConflict';
    this.paths = paths;
  }
}

export function normalizeLockPath(filePath: string): string {
  const resolved = path.resolve(filePath);
  const root = path.parse(resolved).root;
  if (resolved === root) return resolved;
  return resolved.replace(/[/\\]+$/, '');
}

function isUnderPath(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function variantsOf(filePath: string): string[] {
  const logical = normalizeLockPath(filePath);
  const out = [logical];
  const real = resolveAlias(logical);
  if (real && real !== logical) out.push(real);
  return out;
}

/** 锁和冲突判断用的同一条路径：尽量展开符号链接链，文件还不存在时也展开父级链接。 */
export function canonicalLockPath(filePath: string): string {
  const logical = normalizeLockPath(filePath);
  return resolveAlias(logical) ?? logical;
}

/** realpath；目标已删或尚未创建时，顺着现存符号链接链展开，避免别名对不上目录锁。 */
function resolveAlias(abs: string): string | null {
  try {
    return normalizeLockPath(realpathSync(abs));
  } catch {
    // 整段还不存在，或符号链接已经指向被删掉的目录
  }
  const missing: string[] = [];
  let current = abs;
  while (true) {
    try {
      lstatSync(current);
      break;
    } catch {
      const parent = dirnameOf(current);
      if (parent === current) return null;
      missing.push(basenameOf(current));
      current = parent;
    }
  }
  let base = current;
  const seen = new Set<string>();
  for (let hop = 0; hop < 32; hop++) {
    let linked = false;
    try {
      if (!lstatSync(base).isSymbolicLink()) break;
      if (seen.has(base)) return null;
      seen.add(base);
      const link = readlinkSync(base);
      base = normalizeLockPath(path.isAbsolute(link) ? link : path.join(path.dirname(base), link));
      linked = true;
    } catch {
      // 链接目标已经被删掉：保留 readlink 得到的路径，后面再拼上缺失的文件名
      break;
    }
    if (!linked) break;
  }
  try {
    if (lstatSync(base).isSymbolicLink()) {
      // 链没有展开完，但目标目录还在删除中；不再往下跟
    } else {
      base = normalizeLockPath(realpathSync(base));
    }
  } catch {
    // 目录已经不在，仍用链接里的路径和目录锁对前缀
  }
  return missing.reverse().reduce((p, seg) => path.join(p, seg), base);
}

function dirnameOf(p: string): string {
  return path.dirname(p);
}

function basenameOf(p: string): string {
  return path.basename(p);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

/** 与在途文件或持有中的目录锁相等、或互为祖先/子孙。 */
export function conflictingWritePaths(candidates: string[]): string[] {
  const needles = unique(candidates.flatMap(variantsOf));
  const hits: string[] = [];
  for (const live of [...inFlight.keys(), ...heldDirs]) {
    const liveKeys = variantsOf(live);
    const hit = liveKeys.some((liveKey) => needles.some((needle) => isUnderPath(liveKey, needle) || isUnderPath(needle, liveKey)));
    if (hit) hits.push(live);
  }
  return unique(hits);
}

export function isFileWriteInFlight(filePath: string): boolean {
  return conflictingWritePaths([filePath]).length > 0;
}

function notifyDirWaiters(): void {
  const waiters = dirWaiters.splice(0);
  for (const waiter of waiters) waiter();
}

function addInFlight(key: string): void {
  inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
}

function removeInFlight(key: string): void {
  const next = (inFlight.get(key) ?? 1) - 1;
  if (next <= 0) inFlight.delete(key);
  else inFlight.set(key, next);
}

function ancestorHeld(key: string): boolean {
  const fileKeys = variantsOf(key);
  for (const dir of heldDirs) {
    for (const dirKey of variantsOf(dir)) {
      for (const fileKey of fileKeys) {
        if (isUnderPath(dirKey, fileKey)) return true;
      }
    }
  }
  return false;
}

function waitAncestors(key: string): Promise<void> {
  if (!ancestorHeld(key)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    // 登记和再查都在同步段里，避免目录锁刚好在 await 前释放导致永远等不到通知
    if (!ancestorHeld(key)) {
      resolve();
      return;
    }
    dirWaiters.push(resolve);
  });
}

async function acquirePath<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = pathLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  const chained = prev.then(() => current, () => current);
  pathLocks.set(key, chained);
  try {
    await prev;
    while (ancestorHeld(key)) {
      await waitAncestors(key);
    }
    return await fn();
  } finally {
    release();
    if (pathLocks.get(key) === chained) {
      pathLocks.delete(key);
    }
  }
}

export async function withFileLock<T>(filePath: string, fn: () => T | Promise<T>): Promise<T> {
  const logical = normalizeLockPath(filePath);
  const key = canonicalLockPath(filePath);
  addInFlight(logical);
  try {
    return await acquirePath(key, () => Promise.resolve(fn()));
  } finally {
    removeInFlight(logical);
  }
}

async function nestLocks<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
  if (keys.length === 0) return fn();
  const [head, ...rest] = keys;
  return acquirePath(head, () => nestLocks(rest, fn));
}

/**
 * 用户文件写：冲突检查与在途登记在同一次同步段完成，再按路径字典序排队。
 * force 只跳过冲突，仍然入队，避免和已经在写的 Agent 交错覆盖。
 */
export async function withUserFileLocks<T>(filePaths: string[], force: boolean, fn: () => Promise<T>): Promise<T> {
  const logicals = unique(filePaths.map(normalizeLockPath));
  const keys = unique(logicals.map(canonicalLockPath)).sort();
  if (!force) {
    const conflict = conflictingWritePaths(logicals);
    if (conflict.length > 0) throw new FileWriteConflict(conflict);
  }
  for (const logical of logicals) addInFlight(logical);
  try {
    return await nestLocks(keys, fn);
  } finally {
    for (const logical of logicals) removeInFlight(logical);
  }
}

export interface DirectoryHold {
  release(): void;
}

/**
 * 目录删除/改名/移动：同步检查并登记前缀。
 * 之后 withFileLock 若发现祖先目录被持有，会等到 release。
 */
export function holdDirectories(dirPaths: string[], force: boolean): DirectoryHold {
  const keys = unique(dirPaths.flatMap(variantsOf));
  if (!force) {
    const conflict = conflictingWritePaths(keys);
    if (conflict.length > 0) throw new FileWriteConflict(conflict);
  }
  for (const key of keys) heldDirs.add(key);
  return {
    release() {
      for (const key of keys) heldDirs.delete(key);
      notifyDirWaiters();
    },
  };
}
