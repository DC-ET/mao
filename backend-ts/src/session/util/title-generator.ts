const MAX_TITLE_LENGTH = 50;
const SKILL_PATTERN = /\$\{([^}]+)\}\$/g;
const COMMAND_PATTERN = /#\{([^}]+)\}#/g;

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
