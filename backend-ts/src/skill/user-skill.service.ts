import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fail } from '../common/result.js';
import { parseSkillMdContent, validateSkillMd } from '../harness/skill/skill-md.js';
import { uploadFileMode } from './upload-file-mode.js';

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

export interface AdminUserSkillVO extends SkillDocVO {
  userId: number;
  username?: string | null;
  displayName?: string | null;
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

  listAllUserSkills(): AdminUserSkillVO[] {
    if (!existsSync(this.userSkillsDir) || !statSync(this.userSkillsDir).isDirectory()) {
      return [];
    }
    const result: AdminUserSkillVO[] = [];
    let entries: string[] = [];
    try {
      entries = readdirSync(this.userSkillsDir);
    } catch (e) {
      console.warn(`Failed to scan user skills root ${this.userSkillsDir}: ${(e as Error).message}`);
      return [];
    }
    for (const entry of entries) {
      const userId = Number(entry);
      if (!Number.isInteger(userId) || userId <= 0) continue;
      for (const skill of this.listUserSkills(userId)) {
        result.push({ ...skill, userId });
      }
    }
    return result.sort((a, b) => a.userId - b.userId || a.name.localeCompare(b.name));
  }

  getUserSkill(userId: number, name: string): SkillResult<SkillDocDetailVO> {
    const resolved = this.resolveUserSkillFolder(userId, name);
    if ('code' in resolved) return resolved;
    const skillFolder = resolved.folder;
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
    const grouped = groupSkillFiles(files);
    if (grouped.size === 0) {
      return fail(400, 'No valid skill folders found. Each skill must be in a subdirectory.');
    }
    for (const [skillName, group] of grouped) {
      const validationError = validateSkillGroup(skillName, group);
      if (validationError != null) return fail(400, validationError);
    }

    const userDir = this.getUserSkillsDir(userId);
    try {
      mkdirSync(userDir, { recursive: true });
    } catch (e) {
      return fail(500, `Failed to create user skills directory: ${(e as Error).message}`);
    }

    const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const stageRoot = join(this.userSkillsDir, '.staging', String(userId), token);
    const backupRoot = join(this.userSkillsDir, '.staging', String(userId), `${token}-bak`);
    const importedNames = [...grouped.keys()];
    let committed = false;
    let restoreFailed = false;
    try {
      mkdirSync(stageRoot, { recursive: true });
      for (const [skillName, group] of grouped) {
        writeSkillGroup(join(stageRoot, skillName), group);
      }
      mkdirSync(backupRoot, { recursive: true });
      const swapped: string[] = [];
      try {
        for (const skillName of importedNames) {
          swapStagedSkill(userDir, stageRoot, backupRoot, skillName);
          swapped.push(skillName);
        }
        committed = true;
      } catch (e) {
        const detail = (e as Error).message;
        const previousRestored = restoreSwappedSkills(userDir, backupRoot, swapped);
        restoreFailed = !previousRestored || detail.includes('原技能恢复失败');
        const suffix = restoreFailed ? '。原技能可能未能恢复' : '。原技能未替换';
        console.error(`Failed to replace user skill for ${userId}: ${detail}`);
        return fail(500, `Failed to write file: ${detail}${suffix}`);
      }
    } catch (e) {
      if (committed) throw e;
      console.error(`Failed to stage user skill for ${userId}: ${(e as Error).message}`);
      return fail(500, `Failed to write file: ${(e as Error).message}。原技能未替换`);
    } finally {
      rmSync(stageRoot, { recursive: true, force: true });
      if (committed || !restoreFailed) {
        rmSync(backupRoot, { recursive: true, force: true });
      }
    }
    console.info(`User ${userId} uploaded ${importedNames.length} skills: ${importedNames}`);
    return { code: 0, message: 'success', data: importedNames };
  }

  deleteUserSkill(userId: number, name: string): SkillResult<null> {
    const resolved = this.resolveUserSkillFolder(userId, name);
    if ('code' in resolved) return resolved;
    const skillFolder = resolved.folder;
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

  private resolveUserSkillFolder(userId: number, name: string): SkillResult<never> | { folder: string } {
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..') || name.startsWith('.')) {
      return fail(400, `Invalid skill name: ${name}`);
    }
    const userDir = this.getUserSkillsDir(userId);
    const skillFolder = resolve(userDir, name);
    if (skillFolder !== userDir && !skillFolder.startsWith(userDir + sep)) {
      return fail(400, `Invalid skill name: ${name}`);
    }
    return { folder: skillFolder };
  }
}

function groupSkillFiles(files: UploadedSkillFile[]): Map<string, UploadedSkillFile[]> {
  const grouped = new Map<string, UploadedSkillFile[]>();
  for (const file of files) {
    const originalName = file.originalFilename;
    if (originalName == null || originalName.trim().length === 0) continue;
    const normalized = originalName.replace(/\\/g, '/');
    const slashIdx = normalized.indexOf('/');
    if (slashIdx <= 0) continue;
    const skillName = normalized.slice(0, slashIdx);
    if (skillName.startsWith('.') || skillName === '..' || skillName.includes('\0')) continue;
    const list = grouped.get(skillName) ?? [];
    list.push(file);
    grouped.set(skillName, list);
  }
  return grouped;
}

function validateSkillGroup(skillName: string, group: UploadedSkillFile[]): string | null {
  const hasSkillMd = group.some((file) => relativeAfterSkill(file.originalFilename) === 'SKILL.md');
  if (!hasSkillMd) return `Skill '${skillName}' is missing SKILL.md file`;
  const skillMdFile = group.find((file) => relativeAfterSkill(file.originalFilename) === 'SKILL.md');
  if (skillMdFile == null) return `Skill '${skillName}' is missing SKILL.md file`;
  return validateSkillMd(skillMdFile.buffer.toString('utf8'), skillName);
}

function writeSkillGroup(folder: string, group: UploadedSkillFile[]): void {
  const resolvedFolder = resolve(folder);
  for (const file of group) {
    const relativePath = relativeAfterSkill(file.originalFilename);
    if (relativePath.length === 0 || relativePath.includes('/.')) continue;
    if (relativePath.split('/').some((segment) => segment === '..' || segment.length === 0)) {
      throw new Error(`Invalid path: ${relativePath}`);
    }
    const targetFile = join(folder, relativePath);
    const resolvedTarget = resolve(targetFile);
    if (resolvedTarget !== resolvedFolder && !resolvedTarget.startsWith(resolvedFolder + sep)) {
      throw new Error(`Invalid path: ${relativePath}`);
    }
    mkdirSync(dirname(targetFile), { recursive: true });
    writeFileSync(targetFile, file.buffer, { mode: uploadFileMode(relativePath, file.buffer) });
  }
}

function swapStagedSkill(userDir: string, stageRoot: string, backupRoot: string, skillName: string): void {
  const finalFolder = resolve(userDir, skillName);
  const userRoot = resolve(userDir);
  if (finalFolder !== userRoot && !finalFolder.startsWith(userRoot + sep)) {
    throw new Error(`Invalid skill name: ${skillName}`);
  }
  const stagedFolder = join(stageRoot, skillName);
  const backupFolder = join(backupRoot, skillName);
  let backedUp = false;
  if (existsSync(finalFolder)) {
    renameSync(finalFolder, backupFolder);
    backedUp = true;
    console.info(`Overwriting existing user skill: ${skillName}`);
  }
  try {
    renameSync(stagedFolder, finalFolder);
  } catch (e) {
    if (backedUp) {
      try {
        renameSync(backupFolder, finalFolder);
      } catch (restoreErr) {
        throw new Error(`${(e as Error).message}；原技能恢复失败: ${(restoreErr as Error).message}`);
      }
    }
    throw e;
  }
}

function restoreSwappedSkills(userDir: string, backupRoot: string, swapped: string[]): boolean {
  let ok = true;
  for (const skillName of [...swapped].reverse()) {
    const finalFolder = resolve(userDir, skillName);
    const backupFolder = join(backupRoot, skillName);
    try {
      if (existsSync(finalFolder)) rmSync(finalFolder, { recursive: true, force: true });
      if (existsSync(backupFolder)) renameSync(backupFolder, finalFolder);
    } catch (e) {
      ok = false;
      console.error(`Failed to restore user skill ${skillName}: ${(e as Error).message}`);
    }
  }
  return ok;
}

function relativeAfterSkill(originalName: string | null | undefined): string {
  if (originalName == null) return '';
  const relativePath = originalName.replace(/\\/g, '/');
  const slashIdx = relativePath.indexOf('/');
  return slashIdx > 0 ? relativePath.slice(slashIdx + 1) : '';
}
