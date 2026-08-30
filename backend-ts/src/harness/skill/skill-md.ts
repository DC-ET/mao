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

export function parseSkillMdContent(content: string): SkillDocument | null {
  if (!content.startsWith('---')) {
    return null;
  }
  const secondDelimiter = content.indexOf('---', 3);
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
  const secondDelimiter = content.indexOf('---', 3);
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
