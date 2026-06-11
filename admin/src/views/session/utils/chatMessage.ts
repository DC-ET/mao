import {
  normalizeMessageRole,
  type ChatMessage,
  type MessageSegment,
  type ToolCall
} from '../types/chat'

export function parseToolArguments(raw: unknown): Record<string, unknown> | undefined {
  if (raw == null || raw === '') return undefined
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

export function normalizeApiToolCall(
  tc: Record<string, unknown>,
  overrides?: Partial<ToolCall>
): ToolCall {
  const fn = tc.function as { name?: string; arguments?: unknown } | undefined
  if (fn) {
    return {
      id: String(tc.id ?? overrides?.id ?? ''),
      name: String(fn.name ?? ''),
      input: parseToolArguments(fn.arguments),
      result: overrides?.result,
      summary: (tc.summary as string | undefined) ?? overrides?.summary,
      status: overrides?.status ?? 'success',
      isExpanded: false
    }
  }

  return {
    id: String(tc.id ?? ''),
    name: String(tc.name ?? ''),
    input: (tc.input as Record<string, unknown> | undefined) ?? parseToolArguments(tc.arguments),
    result: (tc.result as string | undefined) ?? overrides?.result,
    summary: (tc.summary as string | undefined) ?? overrides?.summary,
    status: (tc.status as ToolCall['status']) ?? overrides?.status ?? 'success',
    isExpanded: false
  }
}

const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_delete', 'task_list'])

export function normalizeToolCallsList(raw: unknown): ToolCall[] {
  if (!raw) return []
  let list: unknown[] = []
  if (typeof raw === 'string') {
    try {
      list = JSON.parse(raw) as unknown[]
    } catch {
      return []
    }
  } else if (Array.isArray(raw)) {
    list = raw
  } else {
    return []
  }
  return list
    .filter((item): item is Record<string, unknown> => item != null && typeof item === 'object')
    .map(tc => normalizeApiToolCall(tc))
}

function filterTaskTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter(tc => !TASK_TOOL_NAMES.has(tc.name))
}

export function buildSegmentsFromContentAndTools(
  content: string,
  toolCalls: ToolCall[]
): MessageSegment[] {
  const segments: MessageSegment[] = []
  if (content?.trim()) {
    segments.push({ type: 'text', content })
  }
  for (const tc of toolCalls) {
    if (tc.id) {
      segments.push({ type: 'tool', callId: tc.id })
    }
  }
  return segments
}

export function mapApiMessagesToChat(raw: Array<Record<string, unknown>>): ChatMessage[] {
  const result: ChatMessage[] = []
  const pendingToolResults: Array<{ toolCallId: string; content: string }> = []

  for (const m of raw) {
    const roleRaw = String(m.role ?? 'assistant').toLowerCase()

    if (roleRaw === 'tool' || roleRaw === 'function') {
      const toolCallId = m.toolCallId != null ? String(m.toolCallId) : ''
      const content = String(m.content ?? '')
      let matched = false
      for (let j = result.length - 1; j >= 0; j--) {
        const prev = result[j]
        if (prev.role !== 'assistant' || !prev.toolCalls?.length) continue
        const call = prev.toolCalls.find(c => c.id === toolCallId)
        if (call) {
          call.result = content
          call.status = inferToolStatus(content)
          matched = true
          break
        }
      }
      if (!matched) {
        pendingToolResults.push({ toolCallId, content })
      }
      continue
    }

    const role = normalizeMessageRole(String(m.role ?? 'assistant'))
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue
    }

    const rawContent = m.content
    let content = ''
    let images: string[] = []
    if (typeof rawContent === 'string') {
      content = rawContent
    } else if (Array.isArray(rawContent)) {
      for (const part of rawContent) {
        if (part.type === 'text') content += part.text || ''
        if (part.type === 'image_url' && part.image_url?.url) images.push(part.image_url.url)
      }
    } else {
      content = String(rawContent ?? '')
    }

    if (m.images && Array.isArray(m.images)) {
      images = m.images as string[]
    }

    const toolCalls = filterTaskTools(normalizeToolCallsList(m.toolCalls))

    if (role === 'assistant' && !content.trim() && toolCalls.length === 0) continue

    const thinkingContent = m.thinkingContent ? String(m.thinkingContent) : undefined
    const segments = buildSegmentsFromContentAndTools(content, toolCalls)
    if (thinkingContent) {
      segments.unshift({ type: 'thinking', content: thinkingContent })
    }

    // Attach fileChanges if present on the raw message
    const fileChanges = m.fileChanges as ChatMessage['fileChanges']

    result.push({
      id: String(m.id ?? `msg_${result.length}`),
      role,
      content,
      thinkingContent: thinkingContent || undefined,
      createdAt: String(m.createdAt ?? ''),
      updatedAt: m.updatedAt ? String(m.updatedAt) : undefined,
      images: images.length > 0 ? images : undefined,
      toolCalls,
      segments,
      fileChanges: fileChanges && fileChanges.length > 0 ? fileChanges : undefined
    })
  }

  // Second pass: match pending tool results
  if (pendingToolResults.length > 0) {
    for (const { toolCallId, content } of pendingToolResults) {
      for (const msg of result) {
        if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue
        const call = msg.toolCalls.find(c => c.id === toolCallId)
        if (call) {
          call.result = content
          call.status = inferToolStatus(content)
          break
        }
      }
    }
  }

  return result
}

function inferToolStatus(result: string): ToolCall['status'] {
  const text = result || ''
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object') {
      if (obj.error) return 'error'
      if (typeof obj.exit_code === 'number' && obj.exit_code !== 0) return 'error'
    }
  } catch {
    // Not JSON
  }
  if (text.startsWith('Tool execution failed')) return 'error'
  return 'success'
}
