import { parse as parseYaml } from 'yaml';

/**
 * 经验子文档 frontmatter 的宽松解析（技术方案 2026-10-24 §3.4）。
 *
 * 与技能 SKILL.md 不同：经验 frontmatter 不做强校验——解析失败或字段缺失时
 * 全部回落空值，索引行以文件名兜底。这是刻意的容错：库内容由 Agent 自动沉淀，
 * 少一个字段不该让该条经验从索引里消失。
 */
export interface ExperienceFrontmatter {
  title: string;
  keywords: string;
  summary: string;
  applicable: string;
  lastVerified: string;
}

/** 定位 frontmatter 结束定界符（与 skill-md 同口径：行锚定，值里的 `---` 不误切）。 */
function findFrontmatterEnd(content: string): number {
  const lines = content.split('\n');
  let offset = 0;
  let seenOpening = false;
  for (const line of lines) {
    const start = offset;
    offset += line.length + 1;
    if (line.trim() !== '---') continue;
    if (!seenOpening) {
      if (start !== 0) return -1; // 首行不是开栏：没有 frontmatter
      seenOpening = true;
      continue;
    }
    return start;
  }
  return -1;
}

function asSingleLine(value: unknown): string {
  if (value == null) return '';
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text.replace(/\s*\r?\n\s*/g, ' ').trim();
}

/**
 * 解析经验子文档首部 frontmatter。无 frontmatter / YAML 解析失败 / 非对象 → 全空字段。
 */
export function parseExperienceFrontmatter(content: string): ExperienceFrontmatter {
  const empty: ExperienceFrontmatter = { title: '', keywords: '', summary: '', applicable: '', lastVerified: '' };
  if (!content.startsWith('---')) return empty;
  const end = findFrontmatterEnd(content);
  if (end === -1) return empty;
  const block = content.slice(3, end).trim();
  let metadata: unknown;
  try {
    metadata = parseYaml(block);
  } catch {
    return empty;
  }
  if (metadata == null || typeof metadata !== 'object' || Array.isArray(metadata)) return empty;
  const m = metadata as Record<string, unknown>;
  // last_verified 为规范字段名，lastVerified 容错兼容
  const lastVerified = asSingleLine(m.last_verified ?? m.lastVerified);
  return {
    title: asSingleLine(m.title),
    keywords: asSingleLine(m.keywords),
    summary: asSingleLine(m.summary),
    applicable: asSingleLine(m.applicable),
    lastVerified,
  };
}
