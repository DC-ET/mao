import { chmodSync, copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { harnessLog } from '../log.js';
import { isValidSkillName } from './skill-md.js';

/**
 * 技能视图（Skill View，技术方案 2026-11-03 §4.2）：把系统技能源按需物化为
 * 「用户级只读副本」，作为容器内技能软链的稳定目标。
 *
 * 目录布局：
 *   {skillViewsDir}/{userId}/{skillName}/             ← 视图（容器内 ro 挂载的根，只含技能）
 *   {skillViewsDir}/.meta/{userId}/{skillName}.json   ← { source, fingerprint, syncedAt }（挂载外，容器不可见）
 *   {skillViewsDir}/.tmp/{userId}/                    ← 物化暂存区（不挂载，容器不可见）
 *
 * 关键语义：
 * - 视图路径稳定：内容更新走「暂存拷贝 + 原子 rename」，`:npm install . -g` 后的
 *   bin 链接经 realpath 指向视图路径，永不悬空；
 * - 源侧技能不存在（已下线）：清理视图与 meta 并返回 null，由调用方降级（删链接）；
 * - 失败（磁盘满 / 拷贝错误）：抛错并保留旧视图，调用方本轮不挂载该技能；
 * - 蓝绿并发（drain 窗口内新旧后端同时物化）：容忍 rename 竞态（ENOENT / ENOTEMPTY），
 *   任何时刻视图只能是完整旧版或完整新版。
 */

/** 视图元数据（.meta/{userId}/{skillName}.json，挂载根之外），指纹短路与溯源用。 */
export interface SkillViewMeta {
  source: string;
  fingerprint: string;
  syncedAt: string;
}

/** 暂存区残留清理阈值：超过 1 小时的 .tmp 条目视为崩溃遗留（技术方案 §4.7）。 */
export const SKILL_VIEW_TMP_MAX_AGE_MS = 3600_000;

export class SkillViewService {
  /** skillViewsDir 解析后的绝对根（宿主机与容器内为同一路径空间）。 */
  readonly skillViewsRoot: string;
  /** 进程内同键串行：同一 {userId}:{skillName} 的并发 ensureView 共享同一次物化。 */
  private readonly inFlight = new Map<string, Promise<string | null>>();

  constructor(skillViewsDir: string) {
    this.skillViewsRoot = path.resolve(skillViewsDir);
    // 启动时清理崩溃遗留的暂存目录（>1h），避免 .tmp 无限增长
    try {
      const removed = cleanupStaleSkillViewTmp(this.skillViewsRoot);
      if (removed > 0) harnessLog('info', `[skill-view] cleaned ${removed} stale tmp entr${removed === 1 ? 'y' : 'ies'} at startup`);
    } catch (e) {
      harnessLog('warn', `[skill-view] startup tmp cleanup failed: ${(e as Error).message}`);
    }
  }

  /**
   * 确保 {views}/{userId}/{skillName} 存在且与源内容一致；返回视图目录路径。
   * - 源不存在：清理视图 + meta，返回 null（调用方降级为移除会话链接）；
   * - 指纹一致且视图存在：短路，不拷贝；
   * - 内容变化：暂存拷贝后原子替换（视图路径不变）；
   * - 拷贝 / 替换失败：抛错（保留旧视图，调用方本轮不挂载该技能）。
   */
  async ensureView(userId: number, skillName: string, sourceFolder: string): Promise<string | null> {
    if (!isValidSkillName(skillName)) {
      throw new Error(`Unsafe skill name for view materialization: ${skillName}`);
    }
    const key = `${userId}:${skillName}`;
    const pending = this.inFlight.get(key);
    if (pending != null) return pending;
    const task = this.ensureViewLocked(userId, skillName, sourceFolder);
    const tracked = task.finally(() => {
      // 只摘除自己：物化期间可能有新调用已替换 map 中的 Promise
      if (this.inFlight.get(key) === tracked) this.inFlight.delete(key);
    });
    this.inFlight.set(key, tracked);
    return tracked;
  }

  private async ensureViewLocked(userId: number, skillName: string, sourceFolder: string): Promise<string | null> {
    const source = path.resolve(sourceFolder);
    const viewDir = this.viewDir(userId, skillName);
    const metaFile = this.metaFile(userId, skillName);

    // 技能根自身是软链（如 skills/ntxbiz-finance-calculate -> /data/ak-scan-repos/...）时
    // dereference 后按目录处理；源不存在 / 不可读 / 非目录 → 视为技能已下线，清理视图
    let sourceReal: string;
    try {
      sourceReal = realpathSync(source);
      if (!statSync(sourceReal).isDirectory()) throw new Error('source is not a directory');
    } catch (e) {
      this.removeView(viewDir, metaFile);
      harnessLog('warn', `[skill-view] user=${userId} skill=${skillName} source unavailable, view removed: ${(e as Error).message}`);
      return null;
    }

    const fingerprint = computeSkillTreeFingerprint(sourceReal);
    const existing = lstatSync(viewDir, { throwIfNoEntry: false });
    if (existing?.isDirectory()) {
      const meta = this.readMeta(metaFile);
      if (meta?.fingerprint === fingerprint) return viewDir;
    }

    this.materialize(userId, skillName, sourceReal, source, viewDir, metaFile, fingerprint);
    return viewDir;
  }

  /**
   * 物化（技术方案 §4.2）：暂存全量拷贝 → 旧视图改名 .old → 暂存 rename 换入 → 清 .old → 写 meta。
   * 两次 rename 之间的窗口为微秒级；换入失败时把 .old 改回，保证「要么旧版、要么新版，不出现空目录」。
   * 蓝绿并发（drain 窗口）：rename 竞态按 §4.2 评审修订容忍——目标已被他人搬走（ENOENT）
   * 与目标已被他人换入（ENOTEMPTY/EEXIST）均按成功继续。
   */
  private materialize(
    userId: number,
    skillName: string,
    sourceReal: string,
    source: string,
    viewDir: string,
    metaFile: string,
    fingerprint: string,
  ): void {
    const userTmpDir = path.join(this.skillViewsRoot, '.tmp', String(userId));
    const stageDir = path.join(userTmpDir, `${skillName}-${process.pid}-${randomBytes(4).toString('hex')}`);
    const oldDir = path.join(userTmpDir, `${skillName}.old-${Date.now()}-${randomBytes(4).toString('hex')}`);
    // 视图父目录与 meta 目录就位（视图自身由换入的暂存目录充当）
    mkdirSync(path.dirname(viewDir), { recursive: true });
    mkdirSync(path.dirname(metaFile), { recursive: true });
    // 1) 全量拷贝到暂存（不暴露给容器）
    rmSync(stageDir, { recursive: true, force: true });
    copySkillTree(sourceReal, stageDir);
    // 2) 旧视图挪走（lstat：视图不应是软链，兼容手工放置的异常形态一并挪走）。
    //    蓝绿并发（评审修订 §4.2 竞态①）：另一实例可能已先搬走 → ENOENT 按「无需搬」继续
    let hadOld = false;
    if (lstatSync(viewDir, { throwIfNoEntry: false }) != null) {
      rmSync(oldDir, { recursive: true, force: true });
      try {
        renameSync(viewDir, oldDir);
        hadOld = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
    }
    // 3) 原子换入：路径不变，既有会话软链与 npm bin 链接继续有效
    //    竞态②命中（他人先换入）时视为「本轮物化未生效」：视图归胜者，meta 也必须保留
    //    胜者的（跳过步骤 5）——若仍写本方指纹，而胜者内容是另一个源状态（如部署 rsync
    //    落在两次拷贝之间），下次 sync 会把胜者的旧内容错误地短路钉死（评审 round-3 I-1）
    let installed = true;
    try {
      renameSync(stageDir, viewDir);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      // 蓝绿并发（评审修订 §4.2 竞态②）：另一实例先换入（目标已存在且非空）→ 视为成功，
      // 丢弃自己的暂存与旧版；内容同源时视图必为完整新版，不同源时由下一轮 sync 自愈
      if ((code === 'ENOTEMPTY' || code === 'EEXIST') && lstatSync(viewDir, { throwIfNoEntry: false }) != null) {
        installed = false;
        harnessLog('warn', `[skill-view] concurrent materialization detected for ${skillName}, keeping the winner's view and meta`);
        rmSync(stageDir, { recursive: true, force: true });
        if (hadOld) {
          try {
            rmSync(oldDir, { recursive: true, force: true });
          } catch (cleanupError) {
            harnessLog('warn', `[skill-view] failed to remove old view ${oldDir}: ${(cleanupError as Error).message}`);
          }
          hadOld = false;
        }
      } else {
        if (hadOld) {
          try {
            renameSync(oldDir, viewDir);
          } catch (rollbackError) {
            harnessLog('error', `[skill-view] rollback failed for ${skillName}: ${(rollbackError as Error).message}`);
          }
        }
        rmSync(stageDir, { recursive: true, force: true });
        throw e;
      }
    }
    // 4) 清旧版本（失败仅告警，留给下次 / .tmp 清理任务）
    if (hadOld) {
      try {
        rmSync(oldDir, { recursive: true, force: true });
      } catch (e) {
        harnessLog('warn', `[skill-view] failed to remove old view ${oldDir}: ${(e as Error).message}`);
      }
    }
    // 5) 写 meta（先写 tmp 再 rename 覆盖）：换入完成后才落盘，避免「meta 新 / 内容旧」的错误短路；
    //    竞态②命中（installed=false）时跳过：meta 必须与视图内容天然配对（保留胜者的 meta）
    if (installed) {
      try {
        const tmpMeta = `${metaFile}.tmp`;
        writeFileSync(tmpMeta, `${JSON.stringify({ source, fingerprint, syncedAt: new Date().toISOString() }, null, 2)}\n`);
        renameSync(tmpMeta, metaFile);
      } catch (e) {
        harnessLog('warn', `[skill-view] meta write failed for ${skillName}: ${(e as Error).message}`);
      }
      harnessLog('info', `[skill-view] materialized user=${userId} skill=${skillName} fingerprint=${fingerprint} -> ${viewDir}`);
    }
  }

  private removeView(viewDir: string, metaFile: string): void {
    try {
      rmSync(viewDir, { recursive: true, force: true });
    } catch (e) {
      harnessLog('warn', `[skill-view] failed to remove view ${viewDir}: ${(e as Error).message}`);
    }
    try {
      rmSync(metaFile, { force: true });
    } catch {
      /* meta 清理失败不影响正确性：下次 ensureView 会重建 */
    }
  }

  private readMeta(metaFile: string): SkillViewMeta | null {
    try {
      const parsed = JSON.parse(readFileSync(metaFile, 'utf8')) as Partial<SkillViewMeta>;
      return typeof parsed?.fingerprint === 'string' ? (parsed as SkillViewMeta) : null;
    } catch {
      return null;
    }
  }

  private viewDir(userId: number, skillName: string): string {
    return path.join(this.skillViewsRoot, String(userId), skillName);
  }

  private metaFile(userId: number, skillName: string): string {
    // 挂载根之外（{views}/{u} 是容器内 ro 挂载的根，视图目录内只允许出现技能）
    return path.join(this.skillViewsRoot, '.meta', String(userId), `${skillName}.json`);
  }
}

/**
 * 源技能树版本指纹（技术方案 §4.2）：`{maxMtimeMs}-{fileCount}-{totalBytes}`。
 * 口径与 SkillSyncService.getLastModified 一致（递归统计，覆盖「改文件 / 增删文件 / rsync 覆盖」），
 * 极端情况（同大小、同 mtime 的内容替换）不识别，可由部署时主动清理视图兜底。
 *
 * 遍历规则与拷贝规则保持一致（.git / 逃逸软链 / 特殊文件不进视图、不计指纹），
 * 保证「指纹一致 ⇔ 视图内容一致」在常规更新下成立。
 */
export function computeSkillTreeFingerprint(root: string): string {
  const state = {
    maxMtimeMs: 0,
    fileCount: 0,
    totalBytes: 0,
    stack: new Set<string>([realpathSync(root)]),
  };
  walkSkillTree(root, realpathSync(root), state);
  return `${Math.floor(state.maxMtimeMs)}-${state.fileCount}-${state.totalBytes}`;
}

interface FingerprintState {
  maxMtimeMs: number;
  fileCount: number;
  totalBytes: number;
  /** 递归栈（realpath）：软链 dereference 时防目录环。 */
  stack: Set<string>;
}

function walkSkillTree(dir: string, skillRootReal: string, state: FingerprintState): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const entryPath = path.join(dir, entry.name);
    let lst;
    try {
      lst = lstatSync(entryPath);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(entryPath);
      } catch {
        continue; // 悬空链接：不进视图、不计指纹
      }
      if (!isInside(real, skillRootReal)) continue; // 逃逸链接：与拷贝规则一致，跳过
      let target;
      try {
        target = statSync(real);
      } catch {
        continue;
      }
      if (target.isDirectory()) {
        if (state.stack.has(real)) continue; // 目录环：跳过
        state.stack.add(real);
        state.maxMtimeMs = Math.max(state.maxMtimeMs, target.mtimeMs);
        walkSkillTree(real, skillRootReal, state);
        state.stack.delete(real);
      } else if (target.isFile()) {
        state.fileCount += 1;
        state.totalBytes += target.size;
        state.maxMtimeMs = Math.max(state.maxMtimeMs, target.mtimeMs);
      }
      continue;
    }
    if (lst.isDirectory()) {
      state.maxMtimeMs = Math.max(state.maxMtimeMs, lst.mtimeMs);
      walkSkillTree(entryPath, skillRootReal, state);
      continue;
    }
    if (lst.isFile()) {
      state.fileCount += 1;
      state.totalBytes += lst.size;
      state.maxMtimeMs = Math.max(state.maxMtimeMs, lst.mtimeMs);
    }
    // socket / fifo / 设备文件：不进视图、不计指纹
  }
}

/**
 * 拷贝技能树（技术方案 §4.2）：
 * - 目录：递归创建，保留权限位（子项完成后 chmod，避免只读目录挡住写入）；
 * - 普通文件：copyFile + chmod(stat.mode)（bin/*.js 等可执行位必须保留）；
 * - 软链：realpath 后仍须位于技能根内，否则跳过并告警（防止把宿主任意文件带进视图）；目标为
 *   目录时按 dereference 递归（带环保护），文件时按内容拷贝；
 * - 其他类型：跳过并告警；
 * - 不排除 node_modules（部分技能 CLI 依赖包内依赖）；.git 排除。
 */
export function copySkillTree(srcRoot: string, destDir: string): void {
  const srcRootReal = realpathSync(srcRoot);
  mkdirSync(destDir, { recursive: true });
  copyDirContents(srcRootReal, destDir, srcRootReal, new Set([srcRootReal]));
  chmodSync(destDir, statSync(srcRootReal).mode & 0o7777);
}

function copyDirContents(srcDir: string, destDir: string, skillRootReal: string, stack: Set<string>): void {
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    let lst;
    try {
      lst = lstatSync(srcPath);
    } catch {
      continue;
    }
    if (lst.isSymbolicLink()) {
      let real: string;
      try {
        real = realpathSync(srcPath);
      } catch {
        harnessLog('warn', `[skill-view] skip dangling symlink: ${srcPath}`);
        continue;
      }
      if (!isInside(real, skillRootReal)) {
        harnessLog('warn', `[skill-view] skip symlink escaping skill root: ${srcPath} -> ${real}`);
        continue;
      }
      let target;
      try {
        target = statSync(real);
      } catch {
        continue;
      }
      if (target.isDirectory()) {
        if (stack.has(real)) {
          harnessLog('warn', `[skill-view] skip symlink cycle: ${srcPath} -> ${real}`);
          continue;
        }
        stack.add(real);
        mkdirSync(destPath, { recursive: true });
        copyDirContents(real, destPath, skillRootReal, stack);
        stack.delete(real);
        chmodSync(destPath, target.mode & 0o7777);
      } else if (target.isFile()) {
        copyFileSync(real, destPath);
        chmodSync(destPath, target.mode & 0o7777);
      } else {
        harnessLog('warn', `[skill-view] skip special target of symlink: ${srcPath}`);
      }
      continue;
    }
    if (lst.isDirectory()) {
      mkdirSync(destPath, { recursive: true });
      copyDirContents(srcPath, destPath, skillRootReal, stack);
      chmodSync(destPath, lst.mode & 0o7777);
      continue;
    }
    if (lst.isFile()) {
      copyFileSync(srcPath, destPath);
      chmodSync(destPath, lst.mode & 0o7777);
      continue;
    }
    harnessLog('warn', `[skill-view] skip special file: ${srcPath}`);
  }
}

/**
 * 清理 .tmp 暂存区中超过 maxAgeMs 的残留条目（技术方案 §4.7）：
 * 物化进程崩溃 / 蓝绿并发后留下的 stage 与 .old 目录由启动与每轮 runtime 清理顺带兜底。
 * 只处理 {skillViewsDir}/.tmp/{数字 userId}/ 下的条目，单项失败不阻塞其余。
 */
export function cleanupStaleSkillViewTmp(skillViewsDir: string, maxAgeMs: number = SKILL_VIEW_TMP_MAX_AGE_MS): number {
  const tmpRoot = path.join(path.resolve(skillViewsDir), '.tmp');
  let removed = 0;
  let userIds: string[];
  try {
    userIds = readdirSync(tmpRoot);
  } catch {
    return 0;
  }
  for (const userId of userIds) {
    if (!/^\d+$/.test(userId)) continue;
    const userTmpDir = path.join(tmpRoot, userId);
    let entries: string[];
    try {
      entries = readdirSync(userTmpDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const target = path.join(userTmpDir, name);
      try {
        if (Date.now() - lstatSync(target).mtimeMs > maxAgeMs) {
          rmSync(target, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        /* 单项失败不阻塞其余条目 */
      }
    }
  }
  return removed;
}

/** target 是否位于 root 之内（含相等）。 */
function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
