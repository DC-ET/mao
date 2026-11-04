import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import archiver from 'archiver';
import { harnessLog } from '../log.js';
import type { Agent } from '../deps.js';
import type { PathSandbox } from '../safety/path-sandbox.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import type { SkillLoader } from './skill-loader.js';
import type { SkillViewService } from './skill-view.service.js';
import { isValidSkillName, parseSkillMdContent, type SkillDocument } from './skill-md.js';

export class SkillSyncService {
  private readonly syncState = new Map<string, Map<string, number>>();

  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly pathSandbox: PathSandbox,
    private readonly runtimeDataResolver: RuntimeDataResolver,
    private readonly userSkillsDir: string,
    private readonly skillViewService: SkillViewService,
  ) {}

  async syncToSession(
    agent: Agent,
    runtimeUserId: number | null,
    sessionId: number | null,
  ): Promise<{ failed: string[] }> {
    if (runtimeUserId == null || sessionId == null) {
      harnessLog('warn', 'Cannot sync skills: userId or sessionId is null');
      return { failed: [] };
    }
    const userId = runtimeUserId;
    const failed = new Set<string>();
    const systemNames = this.resolveSkillNames(agent);
    const userSkillFolders = new Map<string, string>();
    for (const [name, doc] of Object.entries(this.loadUserSkillDocs(userId))) {
      if (doc.folderPath) userSkillFolders.set(name, doc.folderPath);
    }
    // 系统技能与用户技能统一进 merged（用户技能同名覆盖系统技能），链接目标分开：
    // 系统技能 → 用户级只读视图（skill-views/{u}/{name}）；用户技能 → userskills/{u}/{name}
    const merged = new Map<string, { folder: string; system: boolean }>();
    for (const name of systemNames) {
      const folder = this.skillLoader.getSkillFolder(name);
      if (folder) merged.set(name, { folder, system: true });
    }
    for (const [k, v] of userSkillFolders) merged.set(k, { folder: v, system: false });
    if (merged.size === 0) return { failed: [] };

    const runtimeDir = this.runtimeDataResolver.resolveSessionRuntimeDir(userId, sessionId);
    const skillsDir = this.runtimeDataResolver.resolveSkillsDir(userId, sessionId);
    this.pathSandbox.addAllowedRoot(runtimeDir);
    mkdirSync(skillsDir, { recursive: true });
    const state = this.getSyncState(agent.id, userId, sessionId);
    const toRemove = new Set(state.keys());
    for (const [skillName, entry] of merged) {
      toRemove.delete(skillName);
      const targetFolder = path.join(skillsDir, skillName);
      try {
        if (!isValidSkillName(skillName)) {
          harnessLog('warn', `Skip syncing skill with unsafe name: ${skillName}`);
          continue;
        }
        assertInside(skillsDir, targetFolder);
        let linkSource = entry.folder;
        if (entry.system) {
          // 系统技能先物化「用户级只读视图」，链接指向视图（路径稳定，源永进不了容器）
          const viewPath = await this.skillViewService.ensureView(userId, skillName, entry.folder);
          if (viewPath == null) {
            // 源已下线：清掉残留链接，避免指向不存在视图的悬空（视图已由 ensureView 清理）；
            // 本轮实际不可读，计入 failed 让调用侧从可用清单剔除（D7：清单与路径一致）。
            removeSkillLink(targetFolder);
            state.delete(skillName);
            failed.add(skillName);
            continue;
          }
          linkSource = viewPath;
        }
        linkSkill(linkSource, targetFolder);
        // 链接指向视图 / 用户技能目录；源更新由下一轮 sync 重建视图后即时可读，
        // state 仅用于追踪本会话已挂载的技能名
        state.set(skillName, 0);
        harnessLog('info', `Linked skill ${skillName} to ${targetFolder}`);
      } catch (e) {
        // 物化失败降级（技术方案 §4.3）：该技能本轮不挂载（删除已有链接）并告警，
        // 避免「指向不存在视图」的悬空；下一轮 sync 会重新尝试
        try {
          removeSkillLink(targetFolder);
        } catch { /* 链接清理失败不影响其余技能 */ }
        state.delete(skillName);
        failed.add(skillName);
        harnessLog('error', `Failed to sync skill ${skillName} to session runtime: ${(e as Error).message}`);
      }
    }
    for (const name of toRemove) {
      try {
        if (!isValidSkillName(name)) continue;
        const target = path.join(skillsDir, name);
        assertInside(skillsDir, target);
        removeSkillLink(target);
      } catch { /* ignore */ }
      state.delete(name);
    }
    return { failed: [...failed] };
  }

  getUserSkillNames(userId: number): string[] {
    return Object.keys(this.loadUserSkillDocs(userId));
  }

  /** Skills previously synced to this session that are no longer on the agent/user. */
  getRemovedSkillNames(agent: Agent | null | undefined, userId: number | null, sessionId: number | null): string[] {
    if (agent == null || sessionId == null) return [];
    const state = userId == null ? undefined : this.syncState.get(`${agent.id}:${userId}:${sessionId}`);
    if (state == null || state.size === 0) return [];
    const current = new Set(this.resolveSkillNames(agent));
    if (userId != null) {
      for (const name of Object.keys(this.loadUserSkillDocs(userId))) current.add(name);
    }
    const removed: string[] = [];
    for (const name of state.keys()) {
      if (!current.has(name)) removed.push(name);
    }
    return removed;
  }

  getUserSkillDocuments(userId: number): SkillDocument[] {
    return Object.values(this.loadUserSkillDocs(userId));
  }

  loadUserSkillDocs(userId: number): Record<string, SkillDocument> {
    const result: Record<string, SkillDocument> = {};
    const root = path.join(this.userSkillsDir, String(userId));
    if (!existsSync(root)) return result;
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch {
      return result;
    }
    for (const name of entries) {
      const folder = path.join(root, name);
      try {
        if (!statSync(folder).isDirectory()) continue;
        const skillMd = path.join(folder, 'SKILL.md');
        if (!existsSync(skillMd) || !statSync(skillMd).isFile()) continue;
        const doc = parseSkillMdContent(readFileSync(skillMd, 'utf8'));
        if (doc?.name && isValidSkillName(doc.name)) {
          doc.filePath = path.resolve(skillMd);
          doc.folderPath = path.resolve(folder);
          result[doc.name] = doc;
        }
      } catch { /* skip */ }
    }
    return result;
  }

  resolveSkillNames(agent: Agent): string[] {
    const raw = agent.skillNames ?? agent.skills;
    if (!raw || raw.trim() === '') return [];
    try {
      const parsed = JSON.parse(raw) as string[];
      return Array.isArray(parsed) ? parsed.filter(isValidSkillName) : [];
    } catch {
      return [];
    }
  }

  private getSyncState(agentId: number | undefined, userId: number, sessionId: number): Map<string, number> {
    const key = `${agentId}:${userId}:${sessionId}`;
    let state = this.syncState.get(key);
    if (!state) {
      state = new Map();
      this.syncState.set(key, state);
    }
    return state;
  }

  async writeSyncZip(agent: Agent, sessionId: number | null, out: Writable, userId: number | null): Promise<void> {
    const systemNames = this.resolveSkillNames(agent);
    const merged = new Map<string, string>();
    for (const name of systemNames) {
      const folder = this.skillLoader.getSkillFolder(name);
      if (folder) merged.set(name, folder);
    }
    if (userId != null) {
      for (const [name, doc] of Object.entries(this.loadUserSkillDocs(userId))) {
        if (doc.folderPath) merged.set(name, doc.folderPath);
      }
    }
    const state = sessionId != null && userId != null
      ? this.getSyncState(agent.id, userId, sessionId)
      : new Map<string, number>();
    const archive = archiver('zip', { zlib: { level: 5 } });
    const done = pipeline(archive, out);
    for (const [skillName, sourceFolder] of merged) {
      state.set(skillName, getLastModified(sourceFolder));
      archive.directory(sourceFolder, skillName);
    }
    const skillList = [...merged.keys()].map((name) => ({ name, version: String(state.get(name) ?? 0) }));
    archive.append(JSON.stringify({ syncedAt: new Date().toISOString(), agentId: agent.id, skills: skillList }, null, 2), {
      name: '.sync-manifest.json',
    });
    await archive.finalize();
    await done;
  }

  async zipSkillsForLocal(agent: Agent, userId: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.on('data', (c: Buffer) => chunks.push(c));
    const names = this.resolveSkillNames(agent);
    const userDocs = this.loadUserSkillDocs(userId);
    const merged = new Map<string, string>();
    for (const name of names) {
      const folder = this.skillLoader.getSkillFolder(name);
      if (folder) merged.set(name, folder);
    }
    for (const [name, doc] of Object.entries(userDocs)) {
      if (doc.folderPath) merged.set(name, doc.folderPath);
    }
    for (const [name, folder] of merged) {
      archive.directory(folder, name);
    }
    await archive.finalize();
    return Buffer.concat(chunks);
  }
}

/** 取整棵目录树的最大 mtime：只改嵌套文件时顶层目录 mtime 不变，仅看顶层会漏掉同步。 */
function getLastModified(folder: string): number {
  try {
    const stat = statSync(folder);
    if (!stat.isDirectory()) return stat.mtimeMs;
    let latest = stat.mtimeMs;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const child = path.join(folder, entry.name);
      const childMtime = entry.isDirectory() ? getLastModified(child) : statSync(child).mtimeMs;
      if (childMtime > latest) latest = childMtime;
    }
    return latest;
  } catch {
    return 0;
  }
}

/**
 * 以符号链接把技能源目录挂到会话 runtime 下。
 * 源目录是持久数据（全局技能 / 用户技能），链接只是引用，因此定时清理删掉 runtime 副本不会影响源，
 * 也不会让已 `npm install . -g` 的 CLI 因源目录消失而失效（npm 会 realpath 到源目录）。
 * 目标已是正确链接时跳过；否则先移除旧的实体目录或错误/悬空链接再重建。
 */
function linkSkill(src: string, dest: string): void {
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  if (existing != null) {
    if (existing.isSymbolicLink() && resolveLinkTarget(dest) === path.resolve(src)) return;
    // 悬空链接必须用 unlinkSync：rmSync 会跟随链接，ENOENT 被 force 吞掉后链接仍在
    if (existing.isSymbolicLink()) unlinkSync(dest);
    else rmSync(dest, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  symlinkSync(path.resolve(src), dest, 'dir');
}

/** 移除技能链接（或历史遗留的实体副本目录）。悬空链接只能 unlink，rmSync 会跟随链接而失败。 */
function removeSkillLink(dest: string): void {
  const existing = lstatSync(dest, { throwIfNoEntry: false });
  if (existing == null) return;
  if (existing.isSymbolicLink()) unlinkSync(dest);
  else rmSync(dest, { recursive: true, force: true });
}

/** 读取链接指向的绝对路径；读取失败（悬空等）时返回 null。 */
function resolveLinkTarget(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), readlinkSync(link));
  } catch {
    return null;
  }
}

/** 断言 target 严格位于 root 之内，防止技能名路径穿越。 */
function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Unsafe skill target path: ${target} (outside ${root})`);
  }
}
