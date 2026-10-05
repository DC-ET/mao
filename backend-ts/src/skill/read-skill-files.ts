import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';

export interface ReadSkillFilesResult {
  /** 相对技能目录路径 → UTF-8 文本内容（隐藏路径段跳过）。 */
  files: Record<string, string>;
  /** 非致命告警（如二进制文件跳过）。 */
  warnings: string[];
}

/**
 * 读取技能目录全部文本文件（bundle 导出与技能补装共用）：
 * 隐藏文件/目录跳过（与上传写入规则对称），二进制文件跳过并标注 warning，不中断。
 */
export function readSkillFolderFiles(folderPath: string, skillName: string): ReadSkillFilesResult {
  const dir = resolve(folderPath);
  const files: Record<string, string> = {};
  const warnings: string[] = [];
  const walk = (current: string, relBase: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch (e) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `读取技能目录失败（${skillName}）：${(e as Error).message}`);
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const full = join(current, entry);
      const relPath = relBase === '' ? entry : `${relBase}/${entry}`;
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!stat.isFile()) continue;
      const buffer = readFileSync(full);
      try {
        files[relPath] = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      } catch {
        warnings.push(`binary file skipped: ${relPath}`);
      }
    }
  };
  walk(dir, '');
  return { files, warnings };
}

/** 相对路径含隐藏段（根级 .file 或目录/.file）：与导出读取、上传写入规则对称，不属于技能内容。 */
export function isHiddenRelativePath(rawPath: string): boolean {
  const relativePath = rawPath.replace(/\\/g, '/');
  return relativePath.split('/').some((segment) => segment.startsWith('.') && segment !== '.');
}

/** inline 文件相对路径合法性（与写盘工具同一规则，保证预检报告与实际一致）：拒绝穿越片段。 */
export function skillFilesPathError(files: Record<string, string>): string | null {
  for (const rawPath of Object.keys(files)) {
    const relativePath = rawPath.replace(/\\/g, '/');
    if (relativePath.length === 0) return `Invalid path: ${rawPath}`;
    if (relativePath.split('/').some((segment) => segment === '..' || segment.length === 0)) {
      return `Invalid path: ${relativePath}`;
    }
  }
  return null;
}
