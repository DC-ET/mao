import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Writable } from 'node:stream';
import archiver from 'archiver';
import { harnessLog } from '../log.js';
import type { Agent } from '../deps.js';
import type { PathSandbox } from '../safety/path-sandbox.js';
import type { RuntimeDataResolver } from '../runtime/runtime-data-resolver.js';
import type { SkillLoader } from './skill-loader.js';
import { isValidSkillName, parseSkillMdContent, type SkillDocument } from './skill-md.js';

export class SkillSyncService {
  private readonly syncState = new Map<string, Map<string, number>>();

  constructor(
    private readonly skillLoader: SkillLoader,
    private readonly pathSandbox: PathSandbox,
    private readonly runtimeDataResolver: RuntimeDataResolver,
    private readonly userSkillsDir: string,
  ) {}

  async syncToSession(agent: Agent, userId: number | null, sessionId: number | null): Promise<void> {
    if (userId == null || sessionId == null) {
      harnessLog('warn', 'Cannot sync skills: userId or sessionId is null');
      return;
    }
    const systemNames = this.resolveSkillNames(agent);
    const userSkillFolders = new Map<string, string>();
    for (const [name, doc] of Object.entries(this.loadUserSkillDocs(userId))) {
      if (doc.folderPath) userSkillFolders.set(name, doc.folderPath);
    }
    const merged = new Map<string, string>();
    for (const name of systemNames) {
      const folder = this.skillLoader.getSkillFolder(name);
      if (folder) merged.set(name, folder);
    }
    for (const [k, v] of userSkillFolders) merged.set(k, v);
    if (merged.size === 0) return;

    const runtimeDir = this.runtimeDataResolver.resolveSessionRuntimeDir(userId, sessionId);
    const skillsDir = this.runtimeDataResolver.resolveSkillsDir(userId, sessionId);
    this.pathSandbox.addAllowedRoot(runtimeDir);
    mkdirSync(skillsDir, { recursive: true });
    const state = this.getSyncState(agent.id, sessionId);
    const toRemove = new Set(state.keys());
    for (const [skillName, sourceFolder] of merged) {
      toRemove.delete(skillName);
      const sourceModified = getLastModified(sourceFolder);
      const lastSynced = state.get(skillName);
      const targetFolder = path.join(skillsDir, skillName);
      // 源未变化时仍校验目标目录：若已被清理（如定时清理删除），则强制重新同步，避免 agent 读不到技能文件
      if (lastSynced != null && lastSynced >= sourceModified && existsSync(targetFolder)) continue;
      try {
        if (!isValidSkillName(skillName)) {
          harnessLog('warn', `Skip syncing skill with unsafe name: ${skillName}`);
          continue;
        }
        assertInside(skillsDir, targetFolder);
        copyDirectory(sourceFolder, targetFolder);
        state.set(skillName, sourceModified);
        harnessLog('info', `Synced skill ${skillName} to ${targetFolder}`);
      } catch (e) {
        harnessLog('error', `Failed to sync skill ${skillName} to session runtime: ${(e as Error).message}`);
      }
    }
    for (const name of toRemove) {
      try {
        if (!isValidSkillName(name)) continue;
        const target = path.join(skillsDir, name);
        assertInside(skillsDir, target);
        rmSync(target, { recursive: true, force: true });
      } catch { /* ignore */ }
      state.delete(name);
    }
  }

  getUserSkillNames(userId: number): string[] {
    return Object.keys(this.loadUserSkillDocs(userId));
  }

  /** Skills previously synced to this session that are no longer on the agent/user. */
  getRemovedSkillNames(agent: Agent | null | undefined, userId: number | null, sessionId: number | null): string[] {
    if (agent == null || sessionId == null) return [];
    const state = this.syncState.get(`${agent.id}:${sessionId}`);
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

  private getSyncState(agentId: number | undefined, sessionId: number): Map<string, number> {
    const key = `${agentId}:${sessionId}`;
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
    const state = sessionId != null ? this.getSyncState(agent.id, sessionId) : new Map<string, number>();
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

function copyDirectory(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
}

/** 断言 target 严格位于 root 之内，防止技能名路径穿越。 */
function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Unsafe skill target path: ${target} (outside ${root})`);
  }
}
