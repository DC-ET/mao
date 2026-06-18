export type ParsedSegment =
  | { type: 'text'; content: string }
  | { type: 'skill'; name: string }
  | { type: 'command'; name: string }
  | { type: 'file'; filePath: string }

const SKILL_PATTERN = /\$\{([^}]+)\}\$/g
const COMMAND_PATTERN = /#\{([^}]+)\}#/g
const FILE_PATTERN = /@\{([^}]+)\}@/g

/**
 * Parse message content into segments, detecting skill and command markers.
 */
export function parseQuickCommandSegments(content: string): ParsedSegment[] {
  if (!content) return [{ type: 'text', content: '' }]

  const segments: ParsedSegment[] = []
  let lastIndex = 0

  // Collect all matches with their positions
  const matches: Array<{ start: number; end: number; type: string; value: string }> = []

  let match: RegExpExecArray | null

  SKILL_PATTERN.lastIndex = 0
  while ((match = SKILL_PATTERN.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, type: 'skill', value: match[1] })
  }

  COMMAND_PATTERN.lastIndex = 0
  while ((match = COMMAND_PATTERN.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, type: 'command', value: match[1] })
  }

  FILE_PATTERN.lastIndex = 0
  while ((match = FILE_PATTERN.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, type: 'file', value: match[1] })
  }

  // Sort by position
  matches.sort((a, b) => a.start - b.start)

  for (const m of matches) {
    if (m.start > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, m.start) })
    }
    if (m.type === 'file') {
      segments.push({ type: 'file', filePath: m.value })
    } else {
      segments.push({ type: m.type as 'skill' | 'command', name: m.value })
    }
    lastIndex = m.end
  }

  if (lastIndex < content.length) {
    segments.push({ type: 'text', content: content.slice(lastIndex) })
  }

  if (segments.length === 0) {
    segments.push({ type: 'text', content })
  }

  return segments
}
