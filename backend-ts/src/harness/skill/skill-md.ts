import { parse as parseYaml } from 'yaml';

export interface SkillDocument {
  name: string;
  description?: string | null;
  body?: string | null;
  filePath?: string | null;
  folderPath?: string | null;
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
  if (metadata.description == null || String(metadata.description).trim().length === 0) {
    return `SKILL.md for skill '${expectedName}' is missing required field: description`;
  }
  return null;
}
