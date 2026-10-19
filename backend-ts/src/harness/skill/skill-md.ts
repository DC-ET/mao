import { parse as parseYaml } from 'yaml';

export interface SkillDocument {
  name: string;
  description?: string | null;
  body?: string | null;
  filePath?: string | null;
  folderPath?: string | null;
}

/** 技能名必须是安全 slug：字母/数字开头，仅含字母/数字/-/_，最长 64。同时用作同步目标目录名，非法值会引发路径穿越。 */
export function isValidSkillName(name: string): boolean {
  return /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name);
}

/**
 * 定位 YAML frontmatter 结束定界符（开栏之后第二个独立成行、trim 后恰为 `---` 的行）的起始下标；找不到返回 -1。
 *
 * 结束符必须按行锚定：frontmatter 值里可能出现 `---`（YAML 合法——`---` 只在行首才是文档分隔符，
 * 如 `description: 处理步骤 --- 详细说明`）。裸 `indexOf('---')` 会把它误当作定界符，导致 description
 * 被静默截断、body 被污染，或把引号值切在中途判成「非法 YAML」而拒掉合法技能文件。
 */
function findFrontmatterEnd(content: string): number {
  const lines = content.split('\n');
  let offset = 0;
  let seenOpening = false;
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1; // +1 补回被 split 吃掉的 '\n'
    if (line.trim() !== '---') continue;
    if (!seenOpening) {
      seenOpening = true; // 第一个 `---` 行是开栏（content.startsWith('---') 已由调用方保证）
      continue;
    }
    return start;
  }
  return -1;
}

export function parseSkillMdContent(content: string): SkillDocument | null {
  if (!content.startsWith('---')) {
    return null;
  }
  const secondDelimiter = findFrontmatterEnd(content);
  if (secondDelimiter === -1) {
    return null;
  }
  const frontmatter = content.slice(3, secondDelimiter).trim();
  const body = content.slice(secondDelimiter + 3).trim();
  let metadata: Record<string, unknown> | null;
  try {
    metadata = parseYaml(frontmatter) as Record<string, unknown> | null;
  } catch {
    return null;
  }
  if (metadata == null) {
    return null;
  }
  const name = metadata.name != null ? String(metadata.name) : null;
  if (!name) {
    return null;
  }
  return {
    name,
    description: metadata.description != null ? String(metadata.description) : '',
    body,
  };
}

export function validateSkillMd(content: string, expectedName: string): string | null {
  if (!content.startsWith('---')) {
    return `SKILL.md for skill '${expectedName}' must start with YAML frontmatter (---)`;
  }
  const secondDelimiter = findFrontmatterEnd(content);
  if (secondDelimiter === -1) {
    return `SKILL.md for skill '${expectedName}' has unclosed YAML frontmatter`;
  }
  const frontmatter = content.slice(3, secondDelimiter).trim();
  let metadata: Record<string, unknown> | null;
  try {
    metadata = parseYaml(frontmatter) as Record<string, unknown> | null;
  } catch (e) {
    return `SKILL.md for skill '${expectedName}' has invalid YAML frontmatter: ${(e as Error).message}`;
  }
  if (metadata == null) {
    return `SKILL.md for skill '${expectedName}' has empty frontmatter`;
  }
  if (metadata.name == null || String(metadata.name).trim().length === 0) {
    return `SKILL.md for skill '${expectedName}' is missing required field: name`;
  }
  const skillName = String(metadata.name).trim();
  if (!isValidSkillName(skillName)) {
    return `SKILL.md for skill '${expectedName}' has invalid name '${skillName}': name must match ^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$`;
  }
  if (metadata.description == null || String(metadata.description).trim().length === 0) {
    return `SKILL.md for skill '${expectedName}' is missing required field: description`;
  }
  return null;
}
