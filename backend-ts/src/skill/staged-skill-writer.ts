import { existsSync, mkdirSync, rmdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { parseSkillMdContent, validateSkillMd } from '../harness/skill/skill-md.js';
import { uploadFileMode } from './upload-file-mode.js';

export type StagedSkillWriteResult = { ok: true } | { ok: false; error: string };

/**
 * 轻量暂存交换写盘（对齐 UserSkillService 的 stage/swap 模式；SkillDocService.uploadSkill
 * 是直接写入、无暂存回滚，不可照抄）：
 * 先写 `skillsDir/.staging/<token>/<name>`，全部文件落盘后原子 rename 到 `skillsDir/<name>`；
 * 任一步失败清理暂存目录，不污染技能目录、不覆盖已有技能（目标已存在直接失败，由调用方预检排除）。
 * 调用方负责在写入成功后 invalidate 技能加载缓存（SkillLoader.invalidateCache）。
 *
 * @param skillName 技能目录名（同时作为 SKILL.md frontmatter name 的期望值）
 * @param files     相对技能目录路径 → UTF-8 文本内容
 */
export function writeSkillStaged(
  skillsDir: string,
  skillName: string,
  files: Record<string, string>,
): StagedSkillWriteResult {
  if (typeof skillName !== 'string' || skillName.length === 0
    || skillName.startsWith('.') || skillName.includes('/') || skillName.includes('\\')
    || skillName.includes('..') || skillName.includes('\0')) {
    return { ok: false, error: `Invalid skill name: ${skillName}` };
  }
  const skillMd = files['SKILL.md'];
  if (skillMd == null) {
    return { ok: false, error: `Skill '${skillName}' is missing SKILL.md file` };
  }
  const mdError = validateSkillMd(skillMd, skillName);
  if (mdError != null) {
    return { ok: false, error: mdError };
  }
  // SkillLoader 按 frontmatter name 索引技能：目录名（条目名）必须与 frontmatter 一致，否则引用悬空
  const frontName = parseSkillMdContent(skillMd)?.name?.trim();
  if (frontName !== skillName) {
    return { ok: false, error: `SKILL.md frontmatter name（${frontName ?? '缺失'}）与技能目录名（${skillName}）不一致` };
  }

  const root = resolve(skillsDir);
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const stageRoot = join(root, '.staging', token);
  const stagedFolder = join(stageRoot, skillName);
  try {
    mkdirSync(stagedFolder, { recursive: true });
    for (const [rawPath, content] of Object.entries(files)) {
      const relativePath = rawPath.replace(/\\/g, '/');
      // 与上传写入/导出读取规则对称：隐藏路径段（根级 .file、目录/.file）跳过；穿越片段直接拒绝。
      if (relativePath.length === 0 || relativePath.split('/').some((segment) => segment.startsWith('.') && segment !== '.')) continue;
      if (relativePath.split('/').some((segment) => segment === '..' || segment.length === 0)) {
        throw new Error(`Invalid path: ${relativePath}`);
      }
      const targetFile = join(stagedFolder, relativePath);
      const resolvedTarget = resolve(targetFile);
      if (resolvedTarget !== resolve(stagedFolder) && !resolvedTarget.startsWith(resolve(stagedFolder) + sep)) {
        throw new Error(`Invalid path: ${relativePath}`);
      }
      mkdirSync(dirname(targetFile), { recursive: true });
      const buffer = Buffer.from(content, 'utf8');
      writeFileSync(targetFile, buffer, { mode: uploadFileMode(relativePath, buffer) });
    }
    const finalFolder = join(root, skillName);
    const resolvedFinal = resolve(finalFolder);
    if (resolvedFinal !== root && !resolvedFinal.startsWith(root + sep)) {
      return { ok: false, error: `Invalid skill name: ${skillName}` };
    }
    if (existsSync(finalFolder)) {
      return { ok: false, error: `Skill folder already exists: ${skillName}` };
    }
    renameSync(stagedFolder, finalFolder);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  } finally {
    rmSync(stageRoot, { recursive: true, force: true });
    // .staging 父目录若已空则一并清理；rmdirSync 仅成功于空目录，并发导入互不影响
    try {
      rmdirSync(join(root, '.staging'));
    } catch {
      // ignore
    }
  }
}
