import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fail } from '../common/result.js';
import { parseSkillMdContent, validateSkillMd } from '../harness/skill/skill-md.js';

export interface UploadedSkillFile {
  originalFilename: string | null;
  buffer: Buffer;
}

export interface SkillDocVO {
  name: string;
  description?: string | null;
  folderPath: string;
  filePath?: string;
}

export interface SkillDocDetailVO {
  name: string;
  description?: string | null;
  body?: string | null;
  folderPath: string;
  filePath: string;
}

export type SkillResult<T> = { code: number; message: string; data?: T };

export class UserSkillService {
  constructor(private readonly userSkillsDir: string) {}

  listUserSkills(userId: number): SkillDocVO[] {
    const userDir = this.getUserSkillsDir(userId);
    if (!existsSync(userDir) || !statSync(userDir).isDirectory()) {
      return [];
    }
    const voList: SkillDocVO[] = [];
    try {
      for (const name of readdirSync(userDir)) {
        const entry = join(userDir, name);
        if (!statSync(entry).isDirectory()) continue;
        const skillMd = join(entry, 'SKILL.md');
        if (!existsSync(skillMd) || !statSync(skillMd).isFile()) continue;
        try {
          const doc = parseSkillMdContent(readFileSync(skillMd, 'utf8'));
          if (doc != null && doc.name != null) {
            voList.push({
              name: doc.name,
              description: doc.description,
              folderPath: resolve(entry),
            });
          }
        } catch (e) {
          console.warn(`Failed to parse user skill at ${entry}: ${(e as Error).message}`);
        }
      }
    } catch (e) {
      console.warn(`Failed to scan user skills directory ${userDir}: ${(e as Error).message}`);
    }
    return voList;
  }

  getUserSkill(userId: number, name: string): SkillResult<SkillDocDetailVO> {
    const skillFolder = join(this.getUserSkillsDir(userId), name);
    const skillMd = join(skillFolder, 'SKILL.md');
    if (!existsSync(skillMd) || !statSync(skillMd).isFile()) {
      return fail(404, `Skill not found: ${name}`);
    }
    try {
      const doc = parseSkillMdContent(readFileSync(skillMd, 'utf8'));
      if (doc == null || doc.name == null) {
        return fail(404, `Skill not found: ${name}`);
      }
      return {
        code: 0,
        message: 'success',
        data: {
          name: doc.name,
          description: doc.description,
          body: doc.body,
          folderPath: resolve(skillFolder),
          filePath: resolve(skillMd),
        },
      };
    } catch (e) {
      return fail(500, `Failed to read skill: ${(e as Error).message}`);
    }
  }

  uploadUserSkill(userId: number, files: UploadedSkillFile[] | null | undefined): SkillResult<string[]> {
    if (files == null || files.length === 0) {
      return fail(400, 'No files provided');
    }
    const userDir = this.getUserSkillsDir(userId);
    try {
      mkdirSync(userDir, { recursive: true });
    } catch (e) {
      return fail(500, `Failed to create user skills directory: ${(e as Error).message}`);
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
    if (grouped.size === 0) {
      return fail(400, 'No valid skill folders found. Each skill must be in a subdirectory.');
    }

    for (const [skillName, group] of grouped) {
      const hasSkillMd = group.some((f) => relativeAfterSkill(f.originalFilename) === 'SKILL.md');
      if (!hasSkillMd) {
        return fail(400, `Skill '${skillName}' is missing SKILL.md file`);
      }
      const skillMdFile = group.find((f) => relativeAfterSkill(f.originalFilename) === 'SKILL.md');
      if (skillMdFile != null) {
        const content = skillMdFile.buffer.toString('utf8');
        const validationError = validateSkillMd(content, skillName);
        if (validationError != null) {
          return fail(400, validationError);
        }
      }
    }

    const importedNames: string[] = [];
    for (const [skillName, group] of grouped) {
      const existingFolder = join(userDir, skillName);
      if (existsSync(existingFolder) && statSync(existingFolder).isDirectory()) {
        try {
          rmSync(existingFolder, { recursive: true, force: true });
          console.info(`Overwriting existing user skill: ${skillName}`);
        } catch (e) {
          return fail(500, `Failed to overwrite skill: ${(e as Error).message}`);
        }
      }
      for (const file of group) {
        const relativePath = relativeAfterSkill(file.originalFilename);
        if (relativePath.length === 0 || relativePath.includes('/.')) continue;
        const targetFile = join(userDir, skillName, relativePath);
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
    console.info(`User ${userId} uploaded ${importedNames.length} skills: ${importedNames}`);
    return { code: 0, message: 'success', data: importedNames };
  }

  deleteUserSkill(userId: number, name: string): SkillResult<null> {
    const skillFolder = join(this.getUserSkillsDir(userId), name);
    if (!existsSync(skillFolder) || !statSync(skillFolder).isDirectory()) {
      return fail(404, `Skill not found: ${name}`);
    }
    try {
      rmSync(skillFolder, { recursive: true, force: true });
    } catch (e) {
      console.error(`Failed to delete user skill folder ${skillFolder}: ${(e as Error).message}`);
      return fail(500, `Failed to delete skill: ${(e as Error).message}`);
    }
    console.info(`User ${userId} deleted skill: ${name}`);
    return { code: 0, message: 'success' };
  }

  getUserSkillsDir(userId: number): string {
    return resolve(this.userSkillsDir, String(userId));
  }
}

function relativeAfterSkill(originalName: string | null | undefined): string {
  if (originalName == null) return '';
  const relativePath = originalName.replace(/\\/g, '/');
  const slashIdx = relativePath.indexOf('/');
  return slashIdx > 0 ? relativePath.slice(slashIdx + 1) : '';
}
