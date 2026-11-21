import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';
import type { PathSandbox } from '../safety/path-sandbox.js';
import { parseSkillMdContent, type SkillDocument } from './skill-md.js';

export class SkillLoader {
  private readonly cache = new Map<string, SkillDocument>();
  private cacheTimestamp = 0;
  /** 内置技能（随仓库发版、只读）。目录身份 = frontmatter 名；可变根同名条目在 refreshCache 中被丢弃。 */
  private readonly builtinSkills: SkillDocument[];

  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly skillsDir: string,
    private readonly cacheSeconds = 300,
    builtinSkills: SkillDocument[] = [],
  ) {
    this.builtinSkills = builtinSkills;
    this.ensureDirectory(this.getSkillsDir());
  }

  getCatalogWithPaths(filterNames: string[] | null): string | null {
    const skills = this.loadSkills();
    if (skills.size === 0) return null;
    let sb = '';
    for (const doc of skills.values()) {
      if (filterNames && filterNames.length > 0 && !filterNames.includes(doc.name)) continue;
      sb += `- **${doc.name}**: ${doc.description ?? ''}`;
      sb += `\n  Folder: \`${doc.folderPath}\``;
      sb += `\n  File: \`${doc.filePath}\`\n`;
    }
    return sb.trim();
  }

  getAllDocuments(): SkillDocument[] {
    return [...this.loadSkills().values()];
  }

  getAllNames(): string[] {
    return [...this.loadSkills().keys()];
  }

  hasSkill(name: string): boolean {
    return this.loadSkills().has(name);
  }

  /** 该名当前是否由内置技能占用（可变根同名条目会被丢弃，不会改变判定）。 */
  isBuiltin(name: string): boolean {
    return this.loadSkills().get(name)?.builtin === true;
  }

  getSkillFolder(name: string): string | null {
    const doc = this.loadSkills().get(name);
    return doc?.folderPath ?? null;
  }

  getSkillsDir(): string {
    return path.resolve(this.skillsDir);
  }

  invalidateCache(): void {
    this.cache.clear();
    this.cacheTimestamp = 0;
  }

  private loadSkills(): Map<string, SkillDocument> {
    if (!this.isCacheExpired()) return this.cache;
    this.refreshCache();
    return this.cache;
  }

  private isCacheExpired(): boolean {
    return Date.now() - this.cacheTimestamp > this.cacheSeconds * 1000;
  }

  private refreshCache(): void {
    const newSkills = new Map<string, SkillDocument>();
    // 1) 内置技能在前（方案 §5）：folderPath 指向仓库源目录，与扫到的技能目录一样进沙箱白名单
    for (const doc of this.builtinSkills) {
      if (doc.folderPath) this.pathSandbox.addAllowedRoot(doc.folderPath);
      newSkills.set(doc.name, doc);
    }
    // 同名冲突判重不看 folderPath 是否存在：catalog 产出的内置项必带 folderPath，
    // 但若将来有调用方传了残缺文档，也不能让可变根同名项静默顶掉内置身份
    const builtinFolders = new Map(this.builtinSkills.map((d) => [d.name, d.folderPath] as const));
    const builtinConflictWarned = new Set<string>();
    // 2) 可变根：frontmatter 名撞内置 → 丢弃并告警（同一轮刷新同一名字只打一次）
    const root = this.getSkillsDir();
    if (!this.ensureDirectory(root)) {
      this.cache.clear();
      for (const [k, v] of newSkills) this.cache.set(k, v);
      this.cacheTimestamp = Date.now();
      return;
    }
    let entries: string[] = [];
    try {
      entries = readdirSync(root);
    } catch (e) {
      harnessLog('warn', `Failed to scan skills directory ${root}: ${(e as Error).message}`);
    }
    for (const name of entries) {
      const entry = path.join(root, name);
      try {
        if (!statSync(entry).isDirectory()) continue;
        const skillMd = path.join(entry, 'SKILL.md');
        if (!statSync(skillMd).isFile()) continue;
        const doc = this.parseSkillFolder(entry, skillMd);
        if (!doc?.name) continue;
        if (builtinFolders.has(doc.name)) {
          if (!builtinConflictWarned.has(doc.name)) {
            builtinConflictWarned.add(doc.name);
            harnessLog('warn', `[skill-loader] mutable-root skill '${doc.name}' at ${entry} conflicts with builtin skill at ${builtinFolders.get(doc.name) ?? '(unknown)'}, ignored (builtin wins)`);
          }
          continue;
        }
        // 3) 可变根内部沿用今天的规则：后扫到的同名覆盖先扫到的
        newSkills.set(doc.name, doc);
        this.pathSandbox.addAllowedRoot(entry);
      } catch (e) {
        harnessLog('warn', `Failed to parse skill at ${entry}: ${(e as Error).message}`);
      }
    }
    this.cache.clear();
    for (const [k, v] of newSkills) this.cache.set(k, v);
    this.cacheTimestamp = Date.now();
    const builtinCount = this.builtinSkills.length;
    harnessLog('info', `SkillLoader refreshed: ${this.cache.size} skills loaded from ${root}${builtinCount > 0 ? ` (including ${builtinCount} builtin)` : ''}`);
  }

  private ensureDirectory(root: string): boolean {
    try {
      mkdirSync(root, { recursive: true });
      return true;
    } catch (e) {
      harnessLog('warn', `Failed to create skills directory ${root}: ${(e as Error).message}`);
      return false;
    }
  }

  private parseSkillFolder(folder: string, skillMd: string): SkillDocument | null {
    const content = readFileSync(skillMd, 'utf8');
    const doc = parseSkillMdContent(content);
    if (!doc) {
      harnessLog('warn', `Skill file ${skillMd} does not start with YAML frontmatter or is invalid`);
      return null;
    }
    doc.filePath = path.resolve(skillMd);
    doc.folderPath = path.resolve(folder);
    return doc;
  }
}
