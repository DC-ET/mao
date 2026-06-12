export type ParsedSegment =
  | { type: 'text'; content: string }
  | { type: 'skill'; name: string }
  | { type: 'command'; name: string }

const SKILL_PATTERN = /\$\{([^}]+)\}\$/g
const COMMAND_PATTERN = /#\{([^}]+)\}#/g

/**
 * Parse message content into segments, detecting skill and command markers.
 */
export function parseQuickCommandSegments(content: string): ParsedSegment[] {
  if (!content) return [{ type: 'text', content: '' }]

  const segments: ParsedSegment[] = []
  let lastIndex = 0

  // Collect all matches with their positions
  const matches: Array<{ start: number; end: number; type: 'skill' | 'command'; name: string }> = []

  let match: RegExpExecArray | null

  SKILL_PATTERN.lastIndex = 0
  while ((match = SKILL_PATTERN.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, type: 'skill', name: match[1] })
  }

  COMMAND_PATTERN.lastIndex = 0
  while ((match = COMMAND_PATTERN.exec(content)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length, type: 'command', name: match[1] })
  }

  // Sort by position
  matches.sort((a, b) => a.start - b.start)

  for (const m of matches) {
    if (m.start > lastIndex) {
      segments.push({ type: 'text', content: content.slice(lastIndex, m.start) })
    }
    segments.push({ type: m.type, name: m.name })
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
