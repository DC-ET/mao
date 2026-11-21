import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fail } from '../common/result.js';
import { parseSkillMdContent } from '../harness/skill/skill-md.js';
import type { SkillLoader } from '../harness/skill/skill-loader.js';
import type { SkillDocDetailVO, SkillDocVO, SkillResult, UploadedSkillFile } from './user-skill.service.js';
import { uploadFileMode } from './upload-file-mode.js';

export class SkillDocService {
  constructor(private readonly skillLoader: SkillLoader) {}

  listSkillDocs(): SkillDocVO[] {
    return this.skillLoader.getAllDocuments().map((doc) => ({
      name: doc.name,
      description: doc.description,
      folderPath: doc.folderPath ?? '',
      filePath: doc.filePath ?? '',
      builtin: doc.builtin === true,
    }));
  }

  getSkillDoc(name: string): SkillResult<SkillDocDetailVO> {
    const doc = this.skillLoader.getAllDocuments().find((d) => d.name === name);
    if (doc == null) {
      return fail(404, `Skill not found: ${name}`);
    }
    return {
      code: 0,
      message: 'success',
      data: {
        name: doc.name,
        description: doc.description,
        body: doc.body,
        folderPath: doc.folderPath ?? '',
        filePath: doc.filePath ?? '',
      },
    };
  }

  uploadSkill(files: UploadedSkillFile[] | null | undefined): SkillResult<string[]> {
    if (files == null || files.length === 0) {
      return fail(400, 'No files provided');
    }
    const grouped = new Map<string, UploadedSkillFile[]>();
    for (const file of files) {
      const originalName = file.originalFilename;
      if (originalName == null || originalName.trim().length === 0) continue;
      const normalized = originalName.replace(/\\/g, '/');
      const slashIdx = normalized.indexOf('/');
      if (slashIdx <= 0) continue;
      const skillName = normalized.slice(0, slashIdx);
      if (skillName.startsWith('.')) continue;
      const list = grouped.get(skillName) ?? [];
      list.push(file);
      grouped.set(skillName, list);
    }
    // 内置技能写保护（方案 D5）：任一组的 SKILL.md frontmatter 名命中内置 → 整请求 409，
    // 一个文件都不写。检查必须先于全部写盘（今天该接口逐组写、本就无原子性，409 分支保证不落盘）。
    // 今天 uploadSkill 完全不解析 SKILL.md，这里按组预扫描 frontmatter，判名口径与
    // user-skill.service.findSystemNameConflicts 一致；组内没有 SKILL.md 的保持今天行为照常写入。
    const builtinConflicts: string[] = [];
    for (const group of grouped.values()) {
      const skillMd = group.find((file) => relativeAfterSkill(file.originalFilename) === 'SKILL.md');
      if (skillMd == null) continue;
      const frontName = parseSkillMdContent(skillMd.buffer.toString('utf8'))?.name?.trim();
      if (frontName != null && this.skillLoader.isBuiltin(frontName) && !builtinConflicts.includes(frontName)) {
        builtinConflicts.push(frontName);
      }
    }
    if (builtinConflicts.length > 0) {
      return fail(409, `与系统技能同名，禁止上传：${builtinConflicts.join('、')}。内置技能随版本发布，不能通过上传覆盖`);
    }
    const skillsDir = this.skillLoader.getSkillsDir();
    try {
      mkdirSync(skillsDir, { recursive: true });
    } catch (e) {
      return fail(500, `Failed to create skills directory: ${(e as Error).message}`);
    }
    const importedNames: string[] = [];
    for (const [skillName, group] of grouped) {
      const skillFolder = resolve(skillsDir, skillName);
      for (const file of group) {
        const relativePath = relativeAfterSkill(file.originalFilename);
        if (relativePath.length === 0 || relativePath.includes('/.')) continue;
        // 与 writeSkillGroup / staged-skill-writer / read-skill-files 同口径的段校验：
        // 仅查 includes('/.') 拦不住位于最前的 `..` 段（如 `myskill/../evil.txt`），
        // join 归一化后会越出技能子目录落盘。
        if (relativePath.split('/').some((segment) => segment === '..' || segment.length === 0)) continue;
        // 解析后路径收口：目标必须落在技能子目录内（双保险，防任何归一化逃逸）。
        const targetFile = join(skillFolder, relativePath);
        const resolvedTarget = resolve(targetFile);
        if (resolvedTarget !== skillFolder && !resolvedTarget.startsWith(skillFolder + sep)) continue;
        try {
          mkdirSync(dirname(targetFile), { recursive: true });
          writeFileSync(targetFile, file.buffer, { mode: uploadFileMode(relativePath, file.buffer) });
        } catch (e) {
          console.error(`Failed to write file ${targetFile}: ${(e as Error).message}`);
          return fail(500, `Failed to write file: ${(e as Error).message}`);
        }
      }
      if (!importedNames.includes(skillName)) {
        importedNames.push(skillName);
      }
    }
    this.skillLoader.invalidateCache();
    console.info(`Uploaded ${importedNames.length} skills: ${importedNames}`);
    return { code: 0, message: 'success', data: importedNames };
  }

  deleteSkill(name: string): SkillResult<null> {
    // 第一道（D5）：内置技能随版本发布，不能在后台删除。路由层的 removeSkillNameFromAll
    // 仅在 code===0 时执行，409 天然不会摘除 Agent 的 skillNames。
    if (this.skillLoader.isBuiltin(name)) {
      return fail(409, '内置技能随版本发布，不能在后台删除');
    }
    const skillFolder = this.skillLoader.getSkillFolder(name);
    if (skillFolder == null) {
      return fail(404, `Skill not found: ${name}`);
    }
    // 第二道：即使名册判断漏了，rmSync 也绝不允许落在可变根（SKILLS_DIR）之外 —— 否则会删掉 git 检出。
    const resolvedFolder = resolve(skillFolder);
    const mutableRoot = this.skillLoader.getSkillsDir();
    if (!resolvedFolder.startsWith(mutableRoot + sep)) {
      console.error(`Refused to delete skill '${name}': folder ${resolvedFolder} is outside mutable skills root ${mutableRoot}`);
      return fail(500, `删除目标不在系统技能目录内，已拒绝：${resolvedFolder}`);
    }
    try {
      if (existsSync(skillFolder) && statSync(skillFolder).isDirectory()) {
        rmSync(skillFolder, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Failed to delete skill folder ${skillFolder}: ${(e as Error).message}`);
      return fail(500, `Failed to delete skill: ${(e as Error).message}`);
    }
    this.skillLoader.invalidateCache();
    console.info(`Deleted skill: ${name}`);
    return { code: 0, message: 'success' };
  }
}

function relativeAfterSkill(originalName: string | null | undefined): string {
  if (originalName == null) return '';
  const relativePath = originalName.replace(/\\/g, '/');
  const slashIdx = relativePath.indexOf('/');
  return slashIdx > 0 ? relativePath.slice(slashIdx + 1) : '';
}
