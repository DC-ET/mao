import { computed, ref } from 'vue'
import type { ChatMessage, TodoItem, ContextWindowInfo, CompactionEvent, QueueMessage, FileChange, PendingQuestion } from '../../types/chat'
import { appendTextDelta, appendThinkingDelta as appendThinkingDeltaUtil, appendToolCallStart as appendToolCallStartUtil, discardAbortedStreamTail } from '../../utils/chatMessage'
import { nowDateTime } from '../../utils/datetime'
import type { TaskPhase } from './types'
import type { LlmRetryInfo } from './types'

/**
 * 会话运行态缓存：消息、todo、活动、上下文窗口、压缩、流式、审批、队列、文件变更、待回答、执行错误。
 * 按领域拆出，由 session store 主文件组装并导出。
 */
export function createMessageRuntimeModule(ctx: {
  getActiveSessionId: () => string | null
  syncSideTaskPendingCount: (sessionId: string, field: 'pendingApprovalCount' | 'pendingQuestionCount', count: number) => void
}) {
  const { getActiveSessionId, syncSideTaskPendingCount } = ctx

  // Multi-session message cache — keyed by sessionId
  const sessionMessages = ref<Map<string, ChatMessage[]>>(new Map())
  const sessionTodos = ref<Map<string, TodoItem[]>>(new Map())
  const sessionActivities = ref<Map<string, any[]>>(new Map())
  const sessionContextWindow = ref<Map<string, ContextWindowInfo>>(new Map())
  const sessionCompactionEvents = ref<Map<string, CompactionEvent[]>>(new Map())
  const sessionCompacting = ref<Map<string, boolean>>(new Map())
  const sessionThinking = ref<Map<string, boolean>>(new Map())
  const sessionStreaming = ref<Map<string, boolean>>(new Map())
  const streamingAssistantMessageIds = new Map<string, string>()
  const sessionLlmRetry = ref<Map<string, LlmRetryInfo>>(new Map())
  const sessionPendingApprovals = ref<Map<string, number>>(new Map())
  const sessionQueueMessages = ref<Map<string, QueueMessage[]>>(new Map())
  const sessionFileChanges = ref<Map<string, FileChange[]>>(new Map())
  const sessionPendingQuestions = ref<Map<string, PendingQuestion[]>>(new Map())
  const sessionExecutionErrors = ref<Map<string, string>>(new Map())
  const sessionMessageHasMore = ref<Map<string, boolean>>(new Map())
  const sessionMessageLoadingOlder = ref<Map<string, boolean>>(new Map())
  const sessionMessageNextBeforeId = ref<Map<string, string | null>>(new Map())
  // Phase cache for sessions not in the main list (e.g. side tasks)
  const sessionPhases = ref<Map<string, TaskPhase>>(new Map())

  const activeMessages = computed(() =>
    sessionMessages.value.get(getActiveSessionId() ?? '') ?? []
  )

  const activeTodos = computed(() =>
    sessionTodos.value.get(getActiveSessionId() ?? '') ?? []
  )

  const activeActivities = computed(() =>
    sessionActivities.value.get(getActiveSessionId() ?? '') ?? []
  )

  const activeContextWindow = computed(() =>
    sessionContextWindow.value.get(getActiveSessionId() ?? '') ?? null
  )

  const activeCompactionEvents = computed(() =>
    sessionCompactionEvents.value.get(getActiveSessionId() ?? '') ?? []
  )

  const activeCompacting = computed(() =>
    sessionCompacting.value.get(getActiveSessionId() ?? '') ?? false
  )

  const activeThinking = computed(() =>
    sessionThinking.value.get(getActiveSessionId() ?? '') ?? false
  )

  const activeStreaming = computed(() =>
    sessionStreaming.value.get(getActiveSessionId() ?? '') ?? false
  )

  const activeLlmRetry = computed(() =>
    sessionLlmRetry.value.get(getActiveSessionId() ?? '') ?? null
  )

  const activeQueueMessages = computed(() =>
    sessionQueueMessages.value.get(getActiveSessionId() ?? '') ?? []
  )

  const activeFileChanges = computed(() =>
    sessionFileChanges.value.get(getActiveSessionId() ?? '') ?? []
  )

  const activePendingQuestions = computed(() =>
    sessionPendingQuestions.value.get(getActiveSessionId() ?? '') ?? []
  )

  const activeExecutionError = computed(() =>
    sessionExecutionErrors.value.get(getActiveSessionId() ?? '') ?? null
  )

  const activeMessageHasMore = computed(() =>
    sessionMessageHasMore.value.get(getActiveSessionId() ?? '') ?? false
  )

  const activeMessageLoadingOlder = computed(() =>
    sessionMessageLoadingOlder.value.get(getActiveSessionId() ?? '') ?? false
  )

  const activeMessageNextBeforeId = computed(() =>
    sessionMessageNextBeforeId.value.get(getActiveSessionId() ?? '') ?? null
  )

  // --- Message cache actions ---

  function setMessages(sessionId: string, messages: ChatMessage[]) {
    const sid = String(sessionId)
    streamingAssistantMessageIds.delete(sid)
    sessionMessages.value.set(sid, messages)
  }

  /**
   * REST 历史覆盖缓存时，保留缓存里「REST 未覆盖」的消息。
   * REST 默认带 roundLimit（只回最近 N 轮，hasMore=true 表示还有更早的历史），
   * 而本地缓存可能已通过分页加载了更多轮次。此时若直接用 REST 结果整体替换，
   * 已加载的更早轮次会被丢弃，消息区内容塌陷、滚动位置被浏览器钳制，
   * 表现为发送消息后对话区跳到顶部且不再自动跟随。
   *
   * 保留规则（从尾部向前）：
   *  - 队列自动消费刚写入的用户消息（还没出现在 REST 响应里）
   *  - 正在流式输出的助手气泡
   *  - 被 REST 回显替换掉的乐观用户消息（按内容匹配，不重复上屏）
   * 遇到第一条 REST 已有的消息就停：其后是 REST 覆盖范围，交由 REST 结果。
   */
  function applyFetchedMessages(
    sessionId: string,
    messages: ChatMessage[],
    options?: { preserveStreamingAssistant?: boolean },
  ) {
    const sid = String(sessionId)
    const local = sessionMessages.value.get(sid) ?? []
    const localIds = new Set(local.map(m => String(m.id)))
    const fetchedIds = new Set(messages.map(m => String(m.id)))
    const newlyFetchedUsers = messages.filter(m => m.role === 'user' && !localIds.has(String(m.id)))
    // 本地已加载、但 REST 本次未返回的更早轮次：保留在头部。
    // REST 默认带 roundLimit（只回最近 N 轮，hasMore=true 表示还有更早历史），
    // 本地可能已通过分页加载更多轮次；此处只保留「第一条 REST 已有消息」之前的本地消息，
    // 之后的本地消息属于尾部（队列消费 / 流式气泡 / 待替换乐观消息），交给下方逻辑处理。
    let firstFetchedIndex = -1
    for (let i = 0; i < local.length; i++) {
      if (fetchedIds.has(String(local[i].id))) { firstFetchedIndex = i; break }
    }
    // 仅剔除「乐观用户消息被 REST 回显替换」；内容相同不足以判定同一条，
    // 否则分页加载过的重复指令历史会被静默删掉。与 tail 分支保持同一判定。
    const earlier = firstFetchedIndex > 0
      ? local.slice(0, firstFetchedIndex).filter(m => !(m.role === 'user'
        && isOptimisticUserId(String(m.id))
        && newlyFetchedUsers.some(fetched =>
          fetched.content === m.content
          && JSON.stringify(fetched.images ?? []) === JSON.stringify(m.images ?? []))))
      : []
    const tail: ChatMessage[] = []
    for (let i = local.length - 1; i >= 0; i--) {
      const message = local[i]
      if (fetchedIds.has(String(message.id))) break
      const isStreamingAssistant = message.role === 'assistant'
        && streamingAssistantMessageIds.get(sid) === String(message.id)
      const isReplacedOptimisticUser = message.role === 'user'
        && isOptimisticUserId(String(message.id))
        && newlyFetchedUsers.some(fetched => fetched.content === message.content
          && JSON.stringify(fetched.images ?? []) === JSON.stringify(message.images ?? []))
      if (!isReplacedOptimisticUser
        && (message.role !== 'assistant' || (options?.preserveStreamingAssistant && isStreamingAssistant))) {
        tail.unshift(message)
      }
    }
    const prevStreamingId = streamingAssistantMessageIds.get(sid)
    const merged = [...earlier, ...messages, ...tail]
    sessionMessages.value.set(sid, merged.length > 0 ? merged : messages)
    if (prevStreamingId && tail.some(m => String(m.id) === prevStreamingId)) {
      streamingAssistantMessageIds.set(sid, prevStreamingId)
    } else {
      streamingAssistantMessageIds.delete(sid)
    }
  }

  function prependMessages(sessionId: string, messages: ChatMessage[]) {
    const sid = String(sessionId)
    const existing = sessionMessages.value.get(sid) ?? []
    const existingIds = new Set(existing.map(m => String(m.id)))
    const older = messages.filter(m => !existingIds.has(String(m.id)))
    sessionMessages.value.set(sid, [...older, ...existing])
  }

  function setMessagePageState(sessionId: string, hasMore: boolean, nextBeforeId: string | null) {
    const sid = String(sessionId)
    sessionMessageHasMore.value.set(sid, hasMore)
    sessionMessageNextBeforeId.value.set(sid, nextBeforeId)
  }

  function setLoadingOlderMessages(sessionId: string, loading: boolean) {
    sessionMessageLoadingOlder.value.set(String(sessionId), loading)
  }

  function getMessageHasMore(sessionId: string): boolean {
    return sessionMessageHasMore.value.get(String(sessionId)) ?? false
  }

  function getMessageLoadingOlder(sessionId: string): boolean {
    return sessionMessageLoadingOlder.value.get(String(sessionId)) ?? false
  }

  function getMessageNextBeforeId(sessionId: string): string | null {
    return sessionMessageNextBeforeId.value.get(String(sessionId)) ?? null
  }

  function clearMessagePageState(sessionId: string) {
    const sid = String(sessionId)
    sessionMessageHasMore.value.delete(sid)
    sessionMessageLoadingOlder.value.delete(sid)
    sessionMessageNextBeforeId.value.delete(sid)
  }

  function addUserMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    const msgId = String(msg.id)
    if (list.some(m => String(m.id) === msgId)) return
    sessionMessages.value.set(sid, [...list, msg])
  }

  function addAssistantMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list, msg])
  }

  /**
   * 插入非流式的助手消息（后台子代理完成通知等由服务端直接落库的消息）。
   *
   * 与 addAssistantMessage 的区别：若尾部正是本轮正在流式输出的 tracked 气泡，
   * 新消息必须插到它【之前】。否则 append 到尾部后，下一个 content_delta 会让
   * ensureStreamingAssistantMessage 认不出尾部是自己的气泡而新建一个空占位，
   * 把同一轮回复劈成「历史一段 + 新起一段」，时间线与回合分组都会错乱。
   *
   * 这正是后台子代理在主会话执行中完成时的真实时序：通知插入时主线还在流式输出。
   */
  function insertPersistedAssistantMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    const liveId = streamingAssistantMessageIds.get(sid)
    const streamTailIndex = list.length - 1
    const hasStreamTail = liveId != null
      && streamTailIndex >= 0
      && String(list[streamTailIndex].id) === liveId
    if (hasStreamTail) {
      const next = [...list]
      next.splice(streamTailIndex, 0, msg)
      sessionMessages.value.set(sid, next)
      return
    }
    sessionMessages.value.set(sid, [...list, msg])
  }

  function ensureStreamingAssistantMessage(sessionId: string): ChatMessage {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    const lastMsg = list[list.length - 1]
    if (lastMsg?.role === 'assistant' && streamingAssistantMessageIds.get(sid) === String(lastMsg.id)) {
      if (!lastMsg.toolCalls) lastMsg.toolCalls = []
      if (!lastMsg.segments) lastMsg.segments = []
      return lastMsg
    }

    const msg: ChatMessage = {
      id: `msg_${Date.now()}_assistant`,
      role: 'assistant',
      content: '',
      createdAt: nowDateTime(),
      toolCalls: [],
      segments: []
    }
    streamingAssistantMessageIds.set(sid, String(msg.id))
    sessionMessages.value.set(sid, [...list, msg])
    return msg
  }

  /**
   * fetchMessages 用 REST 历史覆盖缓存后，把覆盖前仍在 running 的工具调用合并回去，
   * 避免切换进行中任务时丢失工具右侧转圈状态。
   */
  function getMessages(sessionId: string): ChatMessage[] {
    return sessionMessages.value.get(String(sessionId)) ?? []
  }

  /** 发送失败回滚：移除尾部空 assistant 占位气泡（无内容且无工具调用），并清理其流式登记。 */
  function removeTrailingEmptyAssistant(sessionId: string) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg?.role !== 'assistant' || lastMsg.content || (lastMsg.toolCalls?.length)) return
    list.pop()
    if (streamingAssistantMessageIds.get(sid) === String(lastMsg.id)) {
      streamingAssistantMessageIds.delete(sid)
    }
  }

  /**
   * 发送失败回滚：移除最后一条乐观插入的用户消息（本地 id，无服务端 id）。
   * 与 removeTrailingEmptyAssistant 配对调用，避免失败后留下幽灵气泡。
   */
  function removeLastUserMessage(sessionId: string) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid)
    if (!list || list.length === 0) return
    const lastMsg = list[list.length - 1]
    if (lastMsg?.role !== 'user') return
    const id = String(lastMsg.id)
    // 仅回滚本地乐观消息（msg_/side_user_ 前缀）；已落库消息由 fetchSession 覆盖
    if (!id.startsWith('msg_') && !id.startsWith('side_user_')) return
    list.pop()
  }

  // 流式期间数组引用替换节流：delta 高频到达时避免每字符 O(n) 复制整条消息数组。
  // 元素本身深层响应式，原地修改即时生效；引用替换仅服务于以数组身份为依赖的 watcher（150ms 节流）。
  const pendingArrayNotifyTimers = new Map<string, ReturnType<typeof setTimeout>>()
  function notifyMessagesUpdate(sid: string) {
    if (pendingArrayNotifyTimers.has(sid)) return
    pendingArrayNotifyTimers.set(sid, setTimeout(() => {
      pendingArrayNotifyTimers.delete(sid)
      const list = sessionMessages.value.get(sid)
      if (list) sessionMessages.value.set(sid, [...list])
    }, 150))
  }

  function appendDelta(sessionId: string, delta: string) {
    const sid = String(sessionId)
    sessionStreaming.value.set(sid, true)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    appendTextDelta(lastMsg, delta)
    notifyMessagesUpdate(sid)
  }

  function appendThinkingDelta(sessionId: string, delta: string) {
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    appendThinkingDeltaUtil(lastMsg, delta)
    notifyMessagesUpdate(sid)
  }

  function resetStreamingAssistantMessage(sessionId: string) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    const lastMsg = list[list.length - 1]
    if (lastMsg?.role !== 'assistant'
        || streamingAssistantMessageIds.get(sid) !== String(lastMsg.id)) return
    discardAbortedStreamTail(lastMsg)
    sessionStreaming.value.set(sid, false)
    sessionThinking.value.set(sid, true)
    sessionMessages.value.set(sid, [...list])
  }

  const TASK_TOOL_NAMES = new Set(['task_create', 'task_update', 'task_delete', 'task_list'])
  const filteredToolCallIds = new Set<string>()

  function appendToolCallStart(sessionId: string, data: { tool_call_id: string; tool_name: string; arguments?: string }) {
    if (TASK_TOOL_NAMES.has(data.tool_name)) {
      filteredToolCallIds.add(data.tool_call_id)
      // 跳过 task 工具，但在末尾 text 段追加换行，保证后续文本不与前文粘连
      const sid = String(sessionId)
      const lastMsg = ensureStreamingAssistantMessage(sid)
      const list = sessionMessages.value.get(sid) ?? []
      if (lastMsg.segments?.length) {
        const lastSeg = lastMsg.segments[lastMsg.segments.length - 1]
        if (lastSeg.type === 'text') {
          lastSeg.content += '\n\n'
          sessionMessages.value.set(sid, [...list])
        }
      }
      return
    }
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    let input: Record<string, unknown> | undefined
    if (data.arguments) {
      try { input = JSON.parse(data.arguments) } catch { /* ignore */ }
    }
    appendToolCallStartUtil(lastMsg, {
      id: data.tool_call_id,
      name: data.tool_name,
      input,
      status: 'running',
      isExpanded: false,
      argsStreaming: true,
      argumentsText: data.arguments || ''
    })
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list])
  }

  function updateToolCallResult(sessionId: string, data: {
    tool_call_id: string
    tool_name?: string
    result: string
    status?: string
    summary?: string
    preview?: { media_type?: string; mime?: string; data_uri?: string }
    approval_mark?: { mode: 'llm' | 'jev'; approved: boolean; reason: string }
    result_truncated?: boolean
  }) {
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    if (!lastMsg.toolCalls) lastMsg.toolCalls = []
    let call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
    if (!call) {
      // tool_call_start 被跳过（如 task 工具），不创建新的 tool call
      if (filteredToolCallIds.has(data.tool_call_id)) {
        filteredToolCallIds.delete(data.tool_call_id)
        return
      }
      call = {
        id: data.tool_call_id,
        name: data.tool_name || 'tool',
        status: 'running',
        isExpanded: false,
        argsStreaming: false
      }
      lastMsg.toolCalls.push(call)
      if (!lastMsg.segments) lastMsg.segments = []
      lastMsg.segments.push({ type: 'tool', callId: data.tool_call_id })
    }
    if (data.tool_name && (!call.name || call.name === 'tool')) call.name = data.tool_name
    call.result = data.result
    call.status = (data.status as any) || 'success'
    call.isExpanded = false
    call.argsStreaming = false
    if (data.summary) call.summary = data.summary
    if (data.preview) call.preview = data.preview
    if (data.approval_mark) call.approvalMark = data.approval_mark
    if (data.result_truncated) call.resultTruncated = true
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list])
  }

  function updateToolCallArgs(sessionId: string, data: { tool_call_id: string; arguments: string }) {
    const sid = String(sessionId)
    const lastMsg = ensureStreamingAssistantMessage(sid)
    if (!lastMsg.toolCalls) lastMsg.toolCalls = []
    const call = lastMsg.toolCalls.find(c => c.id === data.tool_call_id)
    if (call) {
      call.argumentsText = data.arguments
      try { call.input = JSON.parse(data.arguments) } catch { call.input = {} }
      notifyMessagesUpdate(sid)
    }
  }

  function finishInterruptedStreamingMessage(sessionId: string, reason = '已被新的纠偏中断') {
    const sid = String(sessionId)
    const liveId = streamingAssistantMessageIds.get(sid)
    if (!liveId) return
    const list = sessionMessages.value.get(sid) ?? []
    const msg = list.find(m => String(m.id) === liveId)
    if (msg?.toolCalls?.length) {
      for (const call of msg.toolCalls) {
        if (call.status === 'running' || call.status === 'pending') {
          call.status = 'error'
          call.argsStreaming = false
          call.summary = call.summary || reason
          call.result = call.result || reason
        }
      }
      sessionMessages.value.set(sid, [...list])
    }
    streamingAssistantMessageIds.delete(sid)
    sessionStreaming.value.set(sid, false)
    sessionThinking.value.set(sid, false)
  }

  function markMessageComplete(sessionId: string, _data: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }) {
    const sid = String(sessionId)
    streamingAssistantMessageIds.delete(sid)
    sessionStreaming.value.set(sid, false)
    sessionThinking.value.set(sid, false)
    // Message end — the full assistant message is now persisted server-side
    // Refresh will pick it up via fetchMessages
  }

  function clearMessages(sessionId: string) {
    const sid = String(sessionId)
    streamingAssistantMessageIds.delete(sid)
    sessionMessages.value.delete(sid)
  }

  /**
   * 截断指定消息之后的所有消息
   */
  function truncateMessagesAfter(sessionId: string, messageId: string) {
    const messages = sessionMessages.value.get(String(sessionId))
    if (!messages) return

    const targetIndex = messages.findIndex(m => String(m.id) === String(messageId))
    if (targetIndex === -1) return

    // 保留目标消息及其之前的消息
    sessionMessages.value.set(String(sessionId), messages.slice(0, targetIndex + 1))
  }

  /**
   * 更新指定消息的内容
   */
  function updateMessageContent(
    sessionId: string,
    messageId: string,
    newContent: string,
    images?: string[]
  ) {
    const messages = sessionMessages.value.get(String(sessionId))
    if (!messages) return

    const message = messages.find(m => String(m.id) === String(messageId))
    if (message) {
      message.content = newContent
      if (images !== undefined) {
        message.images = images
      }
      message.updatedAt = new Date().toISOString()
      // 触发响应式更新
      sessionMessages.value.set(String(sessionId), [...messages])
    }
  }

  const OPTIMISTIC_USER_ID_PREFIXES = ['msg_', 'side_user_', 'subagent-user-']

  /** 乐观插入（尚未落库）的用户消息 ID 判定：user_message_saved 替换 / fetch 合并去重共用。 */
  function isOptimisticUserId(id: string): boolean {
    return OPTIMISTIC_USER_ID_PREFIXES.some(prefix => id.startsWith(prefix))
  }

  /**
   * 追加消息到会话
   */
  function appendMessage(sessionId: string, msg: ChatMessage) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid) ?? []
    sessionMessages.value.set(sid, [...list, msg])
  }

  /**
   * 更新最后一条指定角色消息的 ID（用于将临时 ID 替换为数据库真实 ID）
   */
  function updateLastMessageId(sessionId: string, role: 'user' | 'assistant', realId: string) {
    const sid = String(sessionId)
    const list = sessionMessages.value.get(sid)
    if (!list) return

    // 从后往前找最后一条指定角色的乐观消息（临时 ID），替换为数据库真实 ID
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === role && isOptimisticUserId(String(list[i].id))) {
        list[i].id = realId
        sessionMessages.value.set(sid, [...list])
        return
      }
    }
  }

  // --- Todo cache actions ---

  function setTodos(sessionId: string, todos: TodoItem[]) {
    sessionTodos.value.set(String(sessionId), todos)
  }

  function getTodos(sessionId: string): TodoItem[] {
    return sessionTodos.value.get(String(sessionId)) ?? []
  }

  function clearTodos(sessionId: string) {
    sessionTodos.value.set(String(sessionId), [])
  }

  // --- Activity cache actions ---

  function addActivity(sessionId: string, activity: any) {
    const sid = String(sessionId)
    const list = sessionActivities.value.get(sid) ?? []
    list.push(activity)
    if (list.length > 100) list.splice(0, list.length - 100)
    sessionActivities.value.set(sid, list)
  }

  function setContextWindow(sessionId: string, info: ContextWindowInfo) {
    sessionContextWindow.value.set(String(sessionId), info)
  }

  function getContextWindow(sessionId: string): ContextWindowInfo | null {
    return sessionContextWindow.value.get(String(sessionId)) ?? null
  }

  function setCompactionEvents(sessionId: string, events: CompactionEvent[]) {
    sessionCompactionEvents.value.set(String(sessionId), events)
  }

  function addCompactionEvent(sessionId: string, event: CompactionEvent) {
    const sid = String(sessionId)
    const list = sessionCompactionEvents.value.get(sid) ?? []
    if (list.some(e => e.id === event.id)) return
    sessionCompactionEvents.value.set(sid, [...list, event])
  }

  function setCompacting(sessionId: string, compacting: boolean) {
    sessionCompacting.value.set(String(sessionId), compacting)
  }

  function setThinking(sessionId: string, thinking: boolean) {
    sessionThinking.value.set(String(sessionId), thinking)
  }

  function setStreaming(sessionId: string, streaming: boolean) {
    sessionStreaming.value.set(String(sessionId), streaming)
  }

  function setLlmRetry(sessionId: string, info: LlmRetryInfo) {
    sessionLlmRetry.value.set(String(sessionId), info)
  }

  function clearLlmRetry(sessionId: string) {
    sessionLlmRetry.value.delete(String(sessionId))
  }

  function clearAllLlmRetry() {
    sessionLlmRetry.value = new Map()
  }

  function getLlmRetry(sessionId: string): LlmRetryInfo | null {
    return sessionLlmRetry.value.get(String(sessionId)) ?? null
  }

  function isSessionCompacting(sessionId: string): boolean {
    return sessionCompacting.value.get(String(sessionId)) ?? false
  }

  function isSessionThinking(sessionId: string): boolean {
    return sessionThinking.value.get(String(sessionId)) ?? false
  }

  function isSessionStreaming(sessionId: string): boolean {
    return sessionStreaming.value.get(String(sessionId)) ?? false
  }

  // --- Pending approval tracking ---

  function incrementPendingApproval(sessionId: string) {
    const sid = String(sessionId)
    const current = sessionPendingApprovals.value.get(sid) ?? 0
    sessionPendingApprovals.value.set(sid, current + 1)
    syncSideTaskPendingCount(sid, 'pendingApprovalCount', current + 1)
  }

  function decrementPendingApproval(sessionId: string) {
    const sid = String(sessionId)
    const current = sessionPendingApprovals.value.get(sid) ?? 0
    if (current === 0) return
    const next = current - 1
    if (next > 0) {
      sessionPendingApprovals.value.set(sid, next)
    } else {
      sessionPendingApprovals.value.delete(sid)
    }
    syncSideTaskPendingCount(sid, 'pendingApprovalCount', next)
  }

  // --- Queue message actions ---

  function setQueueMessages(sessionId: string, queue: QueueMessage[]) {
    // REST 返回数字 id，WS queue_updated 返回字符串。拖拽用 dataset（永远是字符串）做严格相等，
    // 数字 id 会匹配失败并静默不发 reorder。灌入时统一成字符串。
    const normalized = (queue ?? []).map((item) => ({
      ...item,
      id: item.id == null ? '' : String(item.id),
      sessionId: item.sessionId == null ? String(sessionId) : String(item.sessionId),
    }))
    sessionQueueMessages.value.set(String(sessionId), normalized)
  }

  function getQueueMessages(sessionId: string): QueueMessage[] {
    return sessionQueueMessages.value.get(String(sessionId)) ?? []
  }

  function clearQueueMessages(sessionId: string) {
    sessionQueueMessages.value.delete(String(sessionId))
  }

  function appendFileChange(sessionId: string, change: FileChange) {
    const key = String(sessionId)
    const changes = sessionFileChanges.value.get(key) || []
    const existing = changes.find(c => c.path === change.path)
    if (existing) {
      existing.linesAdded += change.linesAdded
      existing.linesDeleted += change.linesDeleted
      if (change.type === 'CREATED') existing.type = 'CREATED'
      mergeFileChangeDiff(existing, change)
    } else {
      changes.push({ ...change })
    }
    sessionFileChanges.value.set(key, [...changes])
  }

  function mergeFileChangeDiff(target: FileChange, incoming: FileChange) {
    if (!incoming.diffMode) return
    if (!target.diffMode) {
      target.diffMode = incoming.diffMode
      target.beforeContent = incoming.beforeContent
      target.afterContent = incoming.afterContent
      target.patchContent = incoming.patchContent
      target.patchTruncated = incoming.patchTruncated
      target.diffUnavailableReason = incoming.diffUnavailableReason
      return
    }

    if (target.diffMode === 'SNAPSHOT' && incoming.diffMode === 'SNAPSHOT') {
      target.afterContent = incoming.afterContent
      target.patchTruncated = Boolean(target.patchTruncated || incoming.patchTruncated)
      return
    }

    if (target.diffMode === 'PATCH' || incoming.diffMode === 'PATCH') {
      target.diffMode = 'PATCH'
      target.patchContent = [target.patchContent, incoming.patchContent].filter(Boolean).join('\n')
      target.beforeContent = undefined
      target.afterContent = undefined
      target.patchTruncated = Boolean(target.patchTruncated || incoming.patchTruncated)
      return
    }

    if (incoming.diffMode === 'UNSUPPORTED') {
      target.diffMode = 'UNSUPPORTED'
      target.diffUnavailableReason = incoming.diffUnavailableReason
    }
  }

  function setFileChanges(sessionId: string, changes: FileChange[]) {
    sessionFileChanges.value.set(String(sessionId), changes)
  }

  function getFileChanges(sessionId: string): FileChange[] {
    return sessionFileChanges.value.get(String(sessionId)) ?? []
  }

  function clearFileChanges(sessionId: string) {
    sessionFileChanges.value.delete(String(sessionId))
  }

  // --- Pending questions actions ---

  function appendAskQuestion(sessionId: string, question: PendingQuestion) {
    const sid = String(sessionId)
    const list = sessionPendingQuestions.value.get(sid) ?? []
    // Avoid duplicates
    if (!list.some(q => q.requestId === question.requestId)) {
      list.push(question)
      sessionPendingQuestions.value.set(sid, [...list])
      syncSideTaskPendingCount(sid, 'pendingQuestionCount', list.length)
    }
  }

  function removeAskQuestion(sessionId: string, requestId: string) {
    const sid = String(sessionId)
    const list = sessionPendingQuestions.value.get(sid)
    if (!list) return
    const next = list.filter(q => q.requestId !== requestId)
    sessionPendingQuestions.value.set(sid, next)
    // 仅在客户端确实追踪该会话的提问时才回写计数，避免迟到的取消事件误清仍待回答的 VO 计数
    syncSideTaskPendingCount(sid, 'pendingQuestionCount', next.length)
  }

  function clearAskQuestions(sessionId: string) {
    sessionPendingQuestions.value.delete(String(sessionId))
    syncSideTaskPendingCount(String(sessionId), 'pendingQuestionCount', 0)
  }

  function setExecutionError(sessionId: string, message: string) {
    const sid = String(sessionId)
    const next = new Map(sessionExecutionErrors.value)
    next.set(sid, message)
    sessionExecutionErrors.value = next
  }

  function clearExecutionError(sessionId: string) {
    const sid = String(sessionId)
    if (!sessionExecutionErrors.value.has(sid)) return
    const next = new Map(sessionExecutionErrors.value)
    next.delete(sid)
    sessionExecutionErrors.value = next
  }

  function getExecutionError(sessionId: string): string | null {
    return sessionExecutionErrors.value.get(String(sessionId)) ?? null
  }

  /** 集中清理单个会话的全部运行态缓存（响应式 Map + 流式占位等普通容器）。 */
  function purgeSessionRuntime(sid: string) {
    sessionMessages.value.delete(sid)
    sessionTodos.value.delete(sid)
    sessionActivities.value.delete(sid)
    sessionContextWindow.value.delete(sid)
    sessionCompactionEvents.value.delete(sid)
    sessionQueueMessages.value.delete(sid)
    sessionFileChanges.value.delete(sid)
    clearMessagePageState(sid)
    sessionCompacting.value.delete(sid)
    sessionThinking.value.delete(sid)
    sessionStreaming.value.delete(sid)
    sessionLlmRetry.value.delete(sid)
    sessionPendingApprovals.value.delete(sid)
    sessionPendingQuestions.value.delete(sid)
    sessionExecutionErrors.value.delete(sid)
    sessionPhases.value.delete(sid)
    streamingAssistantMessageIds.delete(sid)
  }

  function reset() {
    sessionMessages.value = new Map()
    sessionTodos.value = new Map()
    sessionActivities.value = new Map()
    sessionContextWindow.value = new Map()
    sessionCompactionEvents.value = new Map()
    sessionCompacting.value = new Map()
    sessionThinking.value = new Map()
    sessionStreaming.value = new Map()
    sessionLlmRetry.value = new Map()
    sessionPendingApprovals.value = new Map()
    sessionFileChanges.value = new Map()
    sessionQueueMessages.value = new Map()
    sessionPendingQuestions.value = new Map()
    sessionExecutionErrors.value = new Map()
    sessionMessageHasMore.value = new Map()
    sessionMessageLoadingOlder.value = new Map()
    sessionMessageNextBeforeId.value = new Map()
    sessionPhases.value = new Map()
    streamingAssistantMessageIds.clear()
    filteredToolCallIds.clear()
  }

  return {
    // state
    sessionMessages,
    sessionTodos,
    sessionActivities,
    sessionContextWindow,
    sessionCompactionEvents,
    sessionCompacting,
    sessionThinking,
    sessionStreaming,
    streamingAssistantMessageIds,
    sessionLlmRetry,
    sessionPendingApprovals,
    sessionQueueMessages,
    sessionFileChanges,
    sessionPendingQuestions,
    sessionExecutionErrors,
    sessionMessageHasMore,
    sessionMessageLoadingOlder,
    sessionMessageNextBeforeId,
    sessionPhases,
    // computed
    activeMessages,
    activeTodos,
    activeActivities,
    activeContextWindow,
    activeCompactionEvents,
    activeCompacting,
    activeThinking,
    activeStreaming,
    activeLlmRetry,
    activeQueueMessages,
    activeFileChanges,
    activePendingQuestions,
    activeExecutionError,
    activeMessageHasMore,
    activeMessageLoadingOlder,
    activeMessageNextBeforeId,
    // actions
    setMessages,
    applyFetchedMessages,
    prependMessages,
    setMessagePageState,
    setLoadingOlderMessages,
    getMessageHasMore,
    getMessageLoadingOlder,
    getMessageNextBeforeId,
    clearMessagePageState,
    addUserMessage,
    addAssistantMessage,
    insertPersistedAssistantMessage,
    ensureStreamingAssistantMessage,
    getMessages,
    removeTrailingEmptyAssistant,
    removeLastUserMessage,
    appendDelta,
    appendThinkingDelta,
    resetStreamingAssistantMessage,
    appendToolCallStart,
    updateToolCallArgs,
    updateToolCallResult,
    finishInterruptedStreamingMessage,
    markMessageComplete,
    clearMessages,
    truncateMessagesAfter,
    updateMessageContent,
    isOptimisticUserId,
    appendMessage,
    updateLastMessageId,
    setTodos,
    getTodos,
    clearTodos,
    addActivity,
    setContextWindow,
    getContextWindow,
    setCompactionEvents,
    addCompactionEvent,
    getCompactionEvents: (sessionId: string) =>
      sessionCompactionEvents.value.get(String(sessionId)) ?? [],
    setCompacting,
    setThinking,
    setStreaming,
    setLlmRetry,
    clearLlmRetry,
    clearAllLlmRetry,
    getLlmRetry,
    isSessionCompacting,
    isSessionThinking,
    isSessionStreaming,
    incrementPendingApproval,
    decrementPendingApproval,
    setQueueMessages,
    getQueueMessages,
    clearQueueMessages,
    appendFileChange,
    setFileChanges,
    getFileChanges,
    clearFileChanges,
    appendAskQuestion,
    removeAskQuestion,
    clearAskQuestions,
    setExecutionError,
    clearExecutionError,
    getExecutionError,
    purgeSessionRuntime,
    reset,
  }
}
