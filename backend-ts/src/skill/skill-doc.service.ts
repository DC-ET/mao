import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fail } from '../common/result.js';
import type { SkillLoader } from '../harness/skill/skill-loader.js';
import type { SkillDocDetailVO, SkillDocVO, SkillResult, UploadedSkillFile } from './user-skill.service.js';

export class SkillDocService {
  constructor(private readonly skillLoader: SkillLoader) {}

  listSkillDocs(): SkillDocVO[] {
    return this.skillLoader.getAllDocuments().map((doc) => ({
      name: doc.name,
      description: doc.description,
      folderPath: doc.folderPath ?? '',
      filePath: doc.filePath ?? '',
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
    const skillsDir = this.skillLoader.getSkillsDir();
    try {
      mkdirSync(skillsDir, { recursive: true });
    } catch (e) {
      return fail(500, `Failed to create skills directory: ${(e as Error).message}`);
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
    const importedNames: string[] = [];
    for (const [skillName, group] of grouped) {
      for (const file of group) {
        const relativePath = relativeAfterSkill(file.originalFilename);
        if (relativePath.length === 0 || relativePath.includes('/.')) continue;
        const targetFile = join(skillsDir, skillName, relativePath);
        try {
          mkdirSync(dirname(targetFile), { recursive: true });
          writeFileSync(targetFile, file.buffer);
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
    const skillFolder = this.skillLoader.getSkillFolder(name);
    if (skillFolder == null) {
      return fail(404, `Skill not found: ${name}`);
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
