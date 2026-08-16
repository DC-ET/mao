import { mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { harnessLog } from '../log.js';
import type { PathSandbox } from '../safety/path-sandbox.js';
import { parseSkillMdContent, type SkillDocument } from './skill-md.js';

export class SkillLoader {
  private readonly cache = new Map<string, SkillDocument>();
  private cacheTimestamp = 0;

  constructor(
    private readonly pathSandbox: PathSandbox,
    private readonly skillsDir: string,
    private readonly cacheSeconds = 300,
  ) {
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
    const root = this.getSkillsDir();
    if (!this.ensureDirectory(root)) {
      this.cache.clear();
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
        if (doc?.name) {
          newSkills.set(doc.name, doc);
          this.pathSandbox.addAllowedRoot(entry);
        }
      } catch (e) {
        harnessLog('warn', `Failed to parse skill at ${entry}: ${(e as Error).message}`);
      }
    }
    this.cache.clear();
    for (const [k, v] of newSkills) this.cache.set(k, v);
    this.cacheTimestamp = Date.now();
    harnessLog('info', `SkillLoader refreshed: ${this.cache.size} skills loaded from ${root}`);
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
