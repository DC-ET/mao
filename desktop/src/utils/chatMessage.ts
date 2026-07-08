import {
  normalizeMessageRole,
  type ChatMessage,
  type FileChange,
  type MessageSegment,
  type ToolCall
} from '../types/chat'

/** 解析工具参数（后端 arguments 为 JSON 字符串） */
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

/** 从 TOOL 消息 metadata 提取图片预览 */
export function extractToolPreviewFromMetadata(metadata: unknown): ToolCall['preview'] | undefined {
  if (metadata == null) return undefined
  try {
    const root = typeof metadata === 'string' ? JSON.parse(metadata) : metadata
    const attachments = (root as { attachments?: unknown[] })?.attachments
    if (!Array.isArray(attachments) || attachments.length === 0) return undefined
    const first = attachments[0] as { mime?: string; data_uri?: string }
    if (!first?.data_uri) return undefined
    return {
      media_type: 'image',
      mime: first.mime,
      data_uri: first.data_uri
    }
  } catch {
    return undefined
  }
}

/** OpenAI / 后端 ToolCall → 前端 UI 结构 */
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
      isExpanded: false,
      argsStreaming: false
    }
  }

  return {
    id: String(tc.id ?? ''),
    name: String(tc.name ?? ''),
    input: (tc.input as Record<string, unknown> | undefined) ?? parseToolArguments(tc.arguments),
    result: (tc.result as string | undefined) ?? overrides?.result,
    summary: (tc.summary as string | undefined) ?? overrides?.summary,
    status: (tc.status as ToolCall['status']) ?? overrides?.status ?? 'success',
    isExpanded: false,
    argsStreaming: false
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

/** 过滤掉 task_* 工具（仅供内部 todo 管理，不展示） */
function filterTaskTools(toolCalls: ToolCall[]): ToolCall[] {
  return toolCalls.filter(tc => !TASK_TOOL_NAMES.has(tc.name))
}

/** 由正文 + 工具列表构建时间线（历史消息每轮一条 assistant） */
export function buildSegmentsFromContentAndTools(
  content: string,
  toolCalls: ToolCall[]
): MessageSegment[] {
  const segments: MessageSegment[] = []
  // 文本在前，与实际流式时序一致（LLM 先输出文本，再输出工具调用）
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

/** 流式追加文本：合并到末尾 text 段或新建 */
export function appendTextDelta(msg: ChatMessage, delta: string) {
  if (!delta) return
  if (!msg.segments) msg.segments = []
  msg.content = (msg.content || '') + delta

  const last = msg.segments[msg.segments.length - 1]
  if (last?.type === 'text') {
    last.content += delta
  } else {
    msg.segments.push({ type: 'text', content: delta })
  }
}

/** 流式思考内容增量：合并到尾部 thinking segment 或新建 */
export function appendThinkingDelta(msg: ChatMessage, delta: string) {
  if (!delta) return
  if (!msg.segments) msg.segments = []
  msg.thinkingContent = (msg.thinkingContent || '') + delta

  const last = msg.segments[msg.segments.length - 1]
  if (last?.type === 'thinking') {
    last.content += delta
  } else {
    msg.segments.push({ type: 'thinking', content: delta })
  }
}

/** 流式工具开始：追加 tool 段（已存在则更新 input） */
export function appendToolCallStart(msg: ChatMessage, call: ToolCall) {
  if (!msg.toolCalls) msg.toolCalls = []
  if (!msg.segments) msg.segments = []
  const existing = msg.toolCalls.find(c => c.id === call.id)
  if (existing) {
    if (call.input) existing.input = call.input
    return
  }
  msg.toolCalls.push(call)
  msg.segments.push({ type: 'tool', callId: call.id })
}

/** 将 API 消息映射为聊天消息，并附加 fileChanges */
export function mapMessagesWithFileChanges(raw: Array<Record<string, unknown>>) {
  const messages = mapApiMessagesToChat(raw)
  const rawById = new Map(raw.map(m => [String(m.id), m]))
  const allChanges: FileChange[] = []
  for (const msg of messages) {
    const rawMsg = rawById.get(msg.id)
    if (rawMsg?.fileChanges && Array.isArray(rawMsg.fileChanges)) {
      const changes = (rawMsg.fileChanges as Array<Record<string, unknown>>).map(fc => ({
        path: String(fc.path),
        type: fc.type as FileChange['type'],
        linesAdded: Number(fc.linesAdded) || 0,
        linesDeleted: Number(fc.linesDeleted) || 0,
        diffMode: fc.diffMode as FileChange['diffMode'],
        beforeContent: fc.beforeContent != null ? String(fc.beforeContent) : undefined,
        afterContent: fc.afterContent != null ? String(fc.afterContent) : undefined,
        patchContent: fc.patchContent != null ? String(fc.patchContent) : undefined,
        patchTruncated: Boolean(fc.patchTruncated),
        diffUnavailableReason: fc.diffUnavailableReason != null ? String(fc.diffUnavailableReason) : undefined,
      }))
      msg.fileChanges = changes
      allChanges.push(...changes)
    }
  }
  return { messages, allChanges }
}

/** 将 API 原始消息列表转为聊天 UI 消息（合并 TOOL 结果、过滤 tool 气泡） */
export function mapApiMessagesToChat(raw: Array<Record<string, unknown>>): ChatMessage[] {
  const result: ChatMessage[] = []
  /** 第一轮未匹配的 TOOL 消息，留到第二轮处理 */
  const pendingToolResults: Array<{ toolCallId: string; content: string; preview?: ToolCall['preview'] }> = []

  for (const m of raw) {
    const roleRaw = String(m.role ?? 'assistant').toLowerCase()

    if (roleRaw === 'tool' || roleRaw === 'function') {
      const toolCallId = m.toolCallId != null ? String(m.toolCallId) : ''
      const content = String(m.content ?? '')
      const preview = extractToolPreviewFromMetadata(m.metadata)
      let matched = false
      for (let j = result.length - 1; j >= 0; j--) {
        const prev = result[j]
        if (prev.role !== 'assistant' || !prev.toolCalls?.length) continue
        const call = prev.toolCalls.find(c => c.id === toolCallId)
        if (call) {
          call.result = content
          call.status = inferToolStatus(content)
          if (preview) call.preview = preview
          matched = true
          break
        }
      }
      if (!matched) {
        pendingToolResults.push({ toolCallId, content, preview })
      }
      continue
    }

    const role = normalizeMessageRole(String(m.role ?? 'assistant'))
    if (role !== 'user' && role !== 'assistant' && role !== 'system') {
      continue
    }

    // Parse content: may be string or ContentPart[] (multimodal)
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

    // Also pick up images from the API response if present
    if (m.images && Array.isArray(m.images)) {
      images = m.images as string[]
    }

    const toolCalls = filterTaskTools(normalizeToolCallsList(m.toolCalls))

    // Skip assistant messages that are empty (e.g. task_* tool-only messages)
    if (role === 'assistant' && !content.trim() && toolCalls.length === 0) continue

    const thinkingContent = m.thinkingContent ? String(m.thinkingContent) : undefined
    const segments = buildSegmentsFromContentAndTools(content, toolCalls)
    if (thinkingContent) {
      segments.unshift({ type: 'thinking', content: thinkingContent })
    }

    result.push({
      id: String(m.id ?? `msg_${Date.now()}_${Math.random()}`),
      role,
      content,
      thinkingContent: thinkingContent || undefined,
      createdAt: String(m.createdAt ?? ''),
      updatedAt: m.updatedAt ? String(m.updatedAt) : undefined,
      images: images.length > 0 ? images : undefined,
      toolCalls,
      segments
    })
  }

  // 第二轮：匹配第一轮因顺序问题未关联的 TOOL 消息
  if (pendingToolResults.length > 0) {
    for (const { toolCallId, content, preview } of pendingToolResults) {
      for (const msg of result) {
        if (msg.role !== 'assistant' || !msg.toolCalls?.length) continue
        const call = msg.toolCalls.find(c => c.id === toolCallId)
        if (call) {
          call.result = content
          call.status = inferToolStatus(content)
          if (preview) call.preview = preview
          break
        }
      }
    }
  }

  return result
}

function inferToolStatus(result: string): ToolCall['status'] {
  const text = result || ''
  // Try JSON-based detection: {"error": ...} or {"exit_code": non-zero}
  try {
    const obj = JSON.parse(text)
    if (obj && typeof obj === 'object') {
      if (obj.error) return 'error'
      if (typeof obj.exit_code === 'number' && obj.exit_code !== 0) return 'error'
    }
  } catch {
    // Not JSON — fall back to plain text heuristic
  }
  if (text.startsWith('Tool execution failed')) return 'error'
  return 'success'
}
