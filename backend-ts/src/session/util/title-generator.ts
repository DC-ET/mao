const MAX_TITLE_LENGTH = 50;
const SKILL_PATTERN = /\$\{([^}]+)\}\$/g;
const COMMAND_PATTERN = /#\{([^}]+)\}#/g;
const FILE_REFERENCE_PATTERN = /@\{[^}]+\}@/g;

export function preprocessForTitle(text: string | null | undefined, commandContentMap: Map<string, string> | Record<string, string> | null): string | null | undefined {
  if (text == null || text.trim().length === 0) {
    return text;
  }

  let result = text;
  const trimmed = result.trim();
  const sole = /^\$\{([^}]+)\}\$/.exec(trimmed);
  if (sole && sole[0] === trimmed) {
    return `/${sole[1]}`;
  }

  result = result.replace(SKILL_PATTERN, '');
  result = result.replace(FILE_REFERENCE_PATTERN, '');
  result = stripSelectionQuoteArtifacts(result);

  const map = toMap(commandContentMap);
  if (map.size > 0) {
    result = result.replace(COMMAND_PATTERN, (full, name: string) => map.get(name) ?? full);
  }

  return result.trim();
}

export function generate(userMessage: string | null | undefined): string | null {
  if (userMessage == null || userMessage.trim().length === 0) {
    return null;
  }
  return truncate(userMessage.trim(), MAX_TITLE_LENGTH);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

const RANGE_COLON_LINE = /^\s*第 \d+(?:-\d+)? 行：\s*$/;
const RANGE_OMITTED_LINE = /^\s*第 \d+(?:-\d+)? 行（片段过长未内联，请按行号读取）\s*$/;
const OPENING_FENCE = /^(```+|~~~+)([^\s`]*)\s*$/;

/**
 * 只去掉文件行区间引用带进来的行号行和紧跟的那一段围栏，再去掉开头的回复引用。
 * 用户自己写的代码块留在标题素材里。
 */
function stripSelectionQuoteArtifacts(text: string): string {
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!RANGE_COLON_LINE.test(line) && !RANGE_OMITTED_LINE.test(line)) {
      kept.push(line);
      continue;
    }
    if (RANGE_COLON_LINE.test(line) && i + 1 < lines.length) {
      const open = openingFence(lines[i + 1]);
      const close = open ? findClosingFence(lines, i + 2, open) : -1;
      // 只有找到合围栏才整段剥掉。找不到（畸形引用，或用户自己写了「第 N 行：」
      // 后接未闭合代码块）时只丢行号行本身——把后面全部吞掉会让用户的真实问题
      // 从标题素材里消失，标题永久停在占位标题（前端对未闭合围栏同样不吸收）。
      if (close >= 0) {
        i = close;
        continue;
      }
    }
  }
  let start = 0;
  while (start < kept.length && (kept[start].trim() === '' || kept[start].startsWith('>'))) start++;
  return kept.slice(start).join('\n');
}

function findClosingFence(lines: string[], from: number, open: { char: string; len: number }): number {
  for (let i = from; i < lines.length; i++) {
    if (isClosingFence(lines[i], open)) return i;
  }
  return -1;
}

function openingFence(line: string): { char: string; len: number } | null {
  const matched = OPENING_FENCE.exec(line);
  if (!matched) return null;
  return { char: matched[1][0], len: matched[1].length };
}

function isClosingFence(line: string, open: { char: string; len: number }): boolean {
  if (line.length < open.len) return false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] !== open.char) return false;
  }
  return true;
}

function toMap(src: Map<string, string> | Record<string, string> | null | undefined): Map<string, string> {
  if (!src) {
    return new Map();
  }
  if (src instanceof Map) {
    return src;
  }
  return new Map(Object.entries(src));
}

export const TitleGenerator = { preprocessForTitle, generate };
