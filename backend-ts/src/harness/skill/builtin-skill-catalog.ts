import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { harnessLog } from '../log.js';
import { isValidSkillName, parseSkillMdContent, type SkillDocument } from './skill-md.js';

/**
 * 内置技能目录（技术方案 2026-11-20）：随仓库发版的只读系统技能，来源两处——
 * 1. `skills/builtin.json` 白名单点名的 `skills/<name>/`（当前只有 mao-cli，文档站 / CLI 共用该目录）；
 * 2. `skills/bundled/` 下含合法 SKILL.md 的**直接子目录**（无第二用途的定制技能，免登记）。
 *
 * 启动语义（方案 D7/D8/D10）：
 * - 找不到仓库技能根、名单不合法、白名单目录缺 SKILL.md、内置技能 frontmatter 重名 → 抛错，进程起不来；
 * - `bundled/` 里没有 SKILL.md 的子目录 → 跳过并告警；`bundled/` 整个缺失 → 视为空集；
 * - 可变根（SKILLS_DIR）与内置根重叠 → 装配处抛错（上传会写进 git 检出）。
 *
 * 校验严格性差异的依据：白名单 / bundled 的 SKILL.md 非法是发版错误，带残缺目录对外服务
 * 会让新部署的系统 Skills 名实不符（与 D7 要修的问题同类）；而 bundled 缺失只代表
 * 「没有这类技能」，不必炸。
 */

export const BUILTIN_LIST_FILENAME = 'builtin.json';
export const BUNDLED_DIR_NAME = 'bundled';

/** 从模块文件向上找 `skills/builtin.json` 的最大层数（src 与 dist 布局均在 5 层内到仓库根）。 */
const MAX_WALK_UP_LEVELS = 8;

export class BuiltinSkillCatalog {
  /**
   * 读取并校验内置技能。`root` 是内置根（仓库的 `skills/` 目录）。
   * 成功返回带 `builtin: true`、绝对 `folderPath` / `filePath` 的技能文档。
   */
  load(root: string): SkillDocument[] {
    const resolvedRoot = path.resolve(root);
    const list = this.readWhitelist(resolvedRoot);
    const byName = new Map<string, SkillDocument>();
    for (const name of list) {
      const doc = this.loadWhitelistSkill(resolvedRoot, name);
      byName.set(doc.name, doc);
    }
    for (const doc of this.loadBundledSkills(resolvedRoot)) {
      if (byName.has(doc.name)) {
        throw new Error(`内置技能 frontmatter 名重复：「${doc.name}」同时来自 ${byName.get(doc.name)?.folderPath} 和 ${doc.folderPath}`);
      }
      byName.set(doc.name, doc);
    }
    const skills = [...byName.values()];
    harnessLog('info', `BuiltinSkillCatalog loaded ${skills.length} builtin skill(s) from ${resolvedRoot}: ${skills.map((s) => s.name).join(', ') || '(none)'}`);
    return skills;
  }

  private readWhitelist(root: string): string[] {
    const listFile = path.join(root, BUILTIN_LIST_FILENAME);
    if (!existsSync(listFile) || !statSync(listFile).isFile()) {
      throw new Error(`内置技能名单缺失：${listFile} 不存在（内置根定位错误或仓库不完整）`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(listFile, 'utf8'));
    } catch (e) {
      throw new Error(`内置技能名单 JSON 损坏：${listFile}: ${(e as Error).message}`);
    }
    const rawSkills = (parsed as { skills?: unknown } | null)?.skills;
    if (!Array.isArray(rawSkills)) {
      throw new Error(`内置技能名单格式错误：${listFile} 缺少字符串数组字段 skills`);
    }
    const names: string[] = [];
    for (const item of rawSkills) {
      if (typeof item !== 'string' || !isValidSkillName(item) || item === BUNDLED_DIR_NAME) {
        throw new Error(`内置技能名单项非法：「${String(item)}」（须为单个合法路径段，且不能是保留名 ${BUNDLED_DIR_NAME}）：${listFile}`);
      }
      if (!names.includes(item)) names.push(item);
    }
    return names;
  }

  private loadWhitelistSkill(root: string, dirName: string): SkillDocument {
    const folder = path.join(root, dirName);
    const skillMd = path.join(folder, 'SKILL.md');
    if (!existsSync(skillMd) || !statSync(skillMd).isFile()) {
      throw new Error(`白名单点名的内置技能缺少 SKILL.md：${skillMd}`);
    }
    return this.parseSkillFolder(folder, skillMd, `白名单内置技能 ${dirName}`);
  }

  private loadBundledSkills(root: string): SkillDocument[] {
    const bundledDir = path.join(root, BUNDLED_DIR_NAME);
    if (!existsSync(bundledDir) || !statSync(bundledDir).isDirectory()) {
      return [];
    }
    let entries: string[];
    try {
      entries = readdirSync(bundledDir);
    } catch (e) {
      throw new Error(`无法扫描内置 bundled 目录 ${bundledDir}: ${(e as Error).message}`);
    }
    const skills: SkillDocument[] = [];
    for (const entry of entries) {
      const folder = path.join(bundledDir, entry);
      let stat;
      try {
        stat = statSync(folder);
      } catch (e) {
        harnessLog('warn', `[builtin-skills] skip unreadable entry ${folder}: ${(e as Error).message}`);
        continue;
      }
      // 直接子目录才算技能；散落的普通文件（如 README.md）静默跳过
      if (!stat.isDirectory()) continue;
      const skillMd = path.join(folder, 'SKILL.md');
      if (!existsSync(skillMd) || !statSync(skillMd).isFile()) {
        harnessLog('warn', `[builtin-skills] skip bundled directory without SKILL.md: ${folder}`);
        continue;
      }
      skills.push(this.parseSkillFolder(folder, skillMd, `bundled 内置技能 ${entry}`));
    }
    return skills;
  }

  private parseSkillFolder(folder: string, skillMd: string, label: string): SkillDocument {
    let doc: SkillDocument | null = null;
    try {
      doc = parseSkillMdContent(readFileSync(skillMd, 'utf8'));
    } catch (e) {
      throw new Error(`${label} 的 SKILL.md 不可读：${skillMd}: ${(e as Error).message}`);
    }
    const frontName = doc?.name ?? null;
    if (doc == null || frontName == null || !isValidSkillName(frontName)) {
      throw new Error(`${label} 的 SKILL.md frontmatter name 缺失或非法：${skillMd}`);
    }
    doc.builtin = true;
    doc.filePath = path.resolve(skillMd);
    doc.folderPath = path.resolve(folder);
    return doc;
  }
}

/**
 * 从本模块文件向上找第一份含 `skills/builtin.json` 的目录，返回该 `skills/` 内置根。
 * 源码（backend-ts/src/...）与编译产物（backend-ts/dist/...）都能定位到仓库根；找不到抛错（方案 D7）。
 */
export function locateBuiltinRoot(moduleUrl: string = import.meta.url): string {
  let current = path.dirname(fileURLToPath(moduleUrl));
  for (let level = 0; level <= MAX_WALK_UP_LEVELS; level++) {
    const candidate = path.join(current, 'skills', BUILTIN_LIST_FILENAME);
    if (existsSync(candidate)) {
      return path.join(current, 'skills');
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error(`未找到内置技能根：从 ${path.dirname(fileURLToPath(moduleUrl))} 向上 ${MAX_WALK_UP_LEVELS} 层内没有发现 skills/${BUILTIN_LIST_FILENAME}（仓库不完整？）`);
}

/**
 * D10：可变根（SKILLS_DIR）与内置根重叠（相同、可变根在内置根内、或内置根在可变根内）→ 抛错。
 * 两个方向都要拦：可变根在内置根内时上传会写进 git 检出；可变根是内置根的祖先时（如
 * SKILLS_DIR=/opt/mao）上传仍可写到 <SKILLS_DIR>/skills/…，删除第二道防线也会误判「在根内」。
 * `builtinRoot` 传内置根目录（…/skills）。
 */
export function assertMutableRootSeparate(mutableRoot: string, builtinRoot: string): void {
  const mutable = path.resolve(mutableRoot);
  const builtin = path.resolve(builtinRoot);
  if (isInsideOrEqual(mutable, builtin) || isInsideOrEqual(builtin, mutable)) {
    throw new Error(
      `SKILLS_DIR（${mutable}）与内置技能根（${builtin}）重叠（相同或互为父子）：上传/删除会写进 git 检出。`
        + ' 请把 SKILLS_DIR 指向数据目录（如 /opt/mao-data/skills），见 skills/mao-cli/reference/deploy.md',
    );
  }
}

/** target 是否位于 root 之内（含相等）。 */
function isInsideOrEqual(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
