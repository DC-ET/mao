import { reactive, ref } from 'vue';
import type { WsTaskPhase, WsServerEvent } from '@mao/contracts';
import type { ChatMessage, PendingQuestion, ToolCallItem } from '../types';
import { stripContextPrefix } from '../context/collector';

const TERMINAL_PHASES: WsTaskPhase[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'];
// 对齐 desktop：session_status / session_snapshot 不经 executionId 门禁
// （RUNNING 事件必须能穿透 cancel 抑制，否则无法恢复新一轮事件流）
// session_already_running 刻意不入门禁：它是"发送被拒"的即时反馈，
// 若被 cancel 抑制吞掉，用户点了发送却完全无提示。
const STREAM_EVENT_TYPES = new Set([
  'content_delta',
  'tool_call_start',
  'tool_call_args_delta',
  'tool_call_result',
  'thinking_start',
  'thinking_end',
  'thinking_delta',
  'message_end',
  'llm_waiting',
  'llm_retry',
  'llm_stream_reset',
  'error',
]);

function extractImagePreview(source: unknown): string | undefined {
  if (source == null) return undefined;
  let node: unknown = source;
  if (typeof source === 'string') {
    const trimmed = source.trim();
    if (trimmed.startsWith('data:image/')) return trimmed;
    try { node = JSON.parse(trimmed); } catch { return undefined; }
  }
  if (node == null || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  const direct = obj.data_uri ?? obj.dataUri;
  if (typeof direct === 'string' && direct.startsWith('data:image/')) return direct;
  const preview = obj.preview;
  if (preview && typeof preview === 'object') {
    const uri = (preview as Record<string, unknown>).data_uri ?? (preview as Record<string, unknown>).dataUri;
    if (typeof uri === 'string' && uri.startsWith('data:image/')) return uri;
  }
  const attachments = obj.attachments;
  if (Array.isArray(attachments) && attachments[0] && typeof attachments[0] === 'object') {
    const uri = (attachments[0] as Record<string, unknown>).data_uri;
    if (typeof uri === 'string' && uri.startsWith('data:image/')) return uri;
  }
  return undefined;
}

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** 取消息的服务端 id：历史 `h_<id>`、落库确认后的 `s_<id>`；纯客户端消息返回 null */
function serverKey(id: string): string | null {
  const m = /^[hs]_(.+)$/.exec(id);
  return m ? m[1] : null;
}

/**
 * 本地用户气泡只显示用户输入，服务端存的是带上下文前缀的完整内容，
 * 因此同一条消息的两种形态优先用 stripContextPrefix 还原后全等比较。
 * endsWith 仅作兜底且要求左边界为分隔符/标头，避免短句（如 "OK"）被
 * "BOOK"、"请确认OK" 等历史消息误命中而丢弃未落库的本地气泡。
 */
function sameMessageText(fetched: string, local: string): boolean {
  if (fetched === local) return true;
  const stripped = stripContextPrefix(fetched);
  if (stripped === local) return true;
  if (local.length === 0 || !fetched.endsWith(local)) return false;
  // 左边界必须是换行（PREFIX_SEPARATOR 以 \n 结尾）；空格边界过松，
  // 会让 "... BOOK OK" 与本地 "OK" 误命中
  const left = fetched.charCodeAt(fetched.length - local.length - 1);
  return left === 0x0a /* \n */;
}

/** 服务端每个工具轮次落一条无正文 ASSISTANT；回显时应并入前一条以 tool-group 收尾的气泡。 */
function isToolOnlyAssistant(m: ChatMessage): boolean {
  return m.role === 'assistant'
    && !m.content.trim()
    && !m.thinking.trim()
    && m.toolCalls.length > 0;
}

function endsWithToolGroup(m: ChatMessage): boolean {
  return m.segments[m.segments.length - 1]?.type === 'tool-group';
}

/**
 * 合并相邻纯工具 assistant 消息（对齐 desktop mergeAdjacentToolMessages）：
 * 多轮「只调工具、无正文」的历史回显会变成一叠「1 个工具调用」，应折成一组。
 * 流式气泡不参与吸收，避免重连对账时改写在途气泡对象。
 */
export function mergeAdjacentToolOnly(messages: ChatMessage[]): ChatMessage[] {
  const result: ChatMessage[] = [];
  for (const m of messages) {
    if (m.streaming) {
      result.push(m);
      continue;
    }
    const prev = result[result.length - 1];
    if (
      isToolOnlyAssistant(m)
      && prev
      && !prev.streaming
      && prev.role === 'assistant'
      && endsWithToolGroup(prev)
    ) {
      const existingIds = new Set(prev.toolCalls.map((t) => t.toolCallId));
      const added = m.toolCalls.filter((t) => !existingIds.has(t.toolCallId));
      prev.toolCalls.push(...added);
      const lastSeg = prev.segments[prev.segments.length - 1];
      if (lastSeg?.type === 'tool-group') lastSeg.toolCalls.push(...added);
      continue;
    }
    result.push(m);
  }
  return result;
}

/**
 * REST 历史与本地消息流合并：以历史为准，保留历史里还没有的本地尾部消息。
 * 必须保留的是「服务端尚未落库」的部分——当前流式 assistant 气泡（含其工具卡）与
 * 刚发出、还没落库确认的用户气泡。整体替换会把它们连同 subscribe 重放的工具卡一起擦掉，
 * 使后续 delta 从中途新建气泡（回答掐头、工具卡按 id 失配）。对齐 desktop applyFetchedMessages。
 */
export function mergeHistory(history: ChatMessage[], local: ChatMessage[]): ChatMessage[] {
  const fetchedKeys = new Set<string>();
  for (const m of history) {
    const k = serverKey(m.id);
    if (k != null) fetchedKeys.add(k);
  }
  // 本地最后一条「历史里也有」的消息：它之前的内容历史已完整覆盖，只需处理其后的尾部
  let localBoundary = -1;
  local.forEach((m, i) => {
    const k = serverKey(m.id);
    if (k != null && fetchedKeys.has(k)) localBoundary = i;
  });

  // 历史里最后一条「本地已知」的消息：其后的历史消息才可能与本地客户端 id 气泡是同一条。
  // 不设这个边界，历史中文本相同的旧消息会把刚发出的新消息误判为已落库而丢弃。
  const localKeys = new Set<string>();
  for (const m of local) {
    const k = serverKey(m.id);
    if (k != null) localKeys.add(k);
  }
  let historyBoundary = -1;
  history.forEach((m, i) => {
    const k = serverKey(m.id);
    if (k != null && localKeys.has(k)) historyBoundary = i;
  });
  const candidates = history.slice(historyBoundary + 1);
  const matched = new Set<number>();

  const tail: ChatMessage[] = [];
  for (let i = local.length - 1; i > localBoundary; i--) {
    const m = local[i];
    // 流式气泡未落库，REST 取不到，必须原样保留（含 reactive 引用，后续 delta 才能续写）
    if (m.streaming) {
      tail.unshift(m);
      continue;
    }
    // 空的已收口 assistant 气泡没有信息量，合并时丢弃（避免历史后面挂一个空泡）
    if (m.role === 'assistant' && !m.content && !m.thinking && m.toolCalls.length === 0) continue;
    // 已在本次历史中出现（客户端 id 与服务端 id 不同）：丢弃本地副本，避免重复上屏。
    // 从后往前配对并标记已用，避免多条同文本消息共同命中同一条历史记录。
    let hit = -1;
    for (let j = candidates.length - 1; j >= 0; j--) {
      if (matched.has(j)) continue;
      const f = candidates[j];
      if (f.role === m.role && sameMessageText(f.content, m.content)) {
        hit = j;
        break;
      }
    }
    if (hit >= 0) {
      matched.add(hit);
      continue;
    }
    tail.unshift(m);
  }
  if (tail.length === 0) return mergeAdjacentToolOnly(history);
  // 客户端一轮执行只有一个 assistant 气泡（message_end 整轮只发一次），而服务端每个工具轮次
  // 结束就落一条 ASSISTANT 行：执行中途重连拉到的这些中间行与保留的本地气泡内容重复
  // （本地是全轮拼接、历史是单轮片段，等值/后缀比对都命中不了）。
  // 仅当本轮用户消息已在历史中（tail 里没有未落库的用户消息）才敢按「历史最后一条 user 之后」
  // 判定为本轮范围，避免把上一轮的回答误剪。
  const localRound = tail.find((m) => m.role === 'assistant' && (m.content !== '' || m.toolCalls.length > 0));
  if (!localRound || tail.some((m) => m.role === 'user')) return mergeAdjacentToolOnly([...history, ...tail]);
  let lastUserIdx = -1;
  history.forEach((m, i) => {
    if (m.role === 'user') lastUserIdx = i;
  });
  const pruned = history.filter((m, i) => {
    if (i <= lastUserIdx || m.role !== 'assistant') return true;
    // 纯工具轮次也可能已在本地流中，必须按调用 id 对账，不能因正文为空重复上屏。
    if (m.toolCalls.length > 0) {
      const covered = m.toolCalls.every((tc) => localRound.toolCalls.some((local) => local.toolCallId === tc.toolCallId));
      if (!covered) return true;
      return !localRound.content.includes(m.content) || !localRound.thinking.includes(m.thinking);
    }
    const text = m.content.trim();
    // 无正文的行不参与剪裁（其信息在 thinking 里，`includes('')` 恒真会误删）
    if (text === '') return true;
    // 已被本地气泡渲染的文本不再重复上屏（本地气泡带工具卡，信息量更全）
    return !localRound.content.includes(text);
  });
  return mergeAdjacentToolOnly([...pruned, ...tail]);
}

/**
 * 会话运行时状态：消息聚合、工具卡片状态机、executionId 去重、cancel 抑制。
 * 行为对齐 desktop session store 的关键语义（见 useStreamWS routeEvent）。
 */
export class ChatStore {
  readonly messages = ref<ChatMessage[]>([]);
  readonly phase = ref<WsTaskPhase | null>(null);
  readonly sessionError = ref<string | null>(null);
  readonly llmRetryText = ref<string | null>(null);
  readonly unread = ref(0);

  readonly pendingQuestion = ref<PendingQuestion | null>(null);

  /** 当前订阅的会话（单会话模型） */
  private activeSessionId: number | null = null;
  private activeExecutionId: string | null = null;
  /** cancel 后抑制所有流事件，直到下一个 RUNNING 带新 executionId */
  private suppressStreamEvents = false;
  private cancelledExecutionId: string | null = null;
  /** 历史消息已加载标记（防重复拉取） */
  private historyLoaded = false;

  bindSession(sessionId: number) {
    this.activeSessionId = sessionId;
  }

  sessionId(): number | null {
    return this.activeSessionId;
  }

  /** 页面截图在本地完成后立刻挂到对应工具卡，不依赖服务端再回传大图。 */
  attachImageToRunningTool(toolName: string, dataUri: string): void {
    if (!dataUri.startsWith('data:image/')) return;
    for (let i = this.messages.value.length - 1; i >= 0; i--) {
      const m = this.messages.value[i];
      if (m.role !== 'assistant') continue;
      for (let j = m.toolCalls.length - 1; j >= 0; j--) {
        const tc = m.toolCalls[j];
        if (tc.toolName !== toolName) continue;
        if (tc.status === 'running' || !tc.imagePreview) {
          tc.imagePreview = dataUri;
          return;
        }
      }
      return;
    }
  }

  /** 展开浮窗/重连时调用：加载或补齐历史 */
  async ensureHistory(load: (sessionId: number) => Promise<ChatMessage[]>) {
    if (!this.activeSessionId || this.historyLoaded) return;
    const sid = this.activeSessionId;
    const history = await load(sid);
    if (this.activeSessionId !== sid) return;
    // 流式途中展开过则合并：历史在前，本地未落库的尾部消息保留在后
    this.messages.value = mergeHistory(history, this.messages.value);
    this.historyLoaded = true;
  }

  /**
   * 强制重拉历史并与本地消息流合并。
   * 用于重连后对账：断线期间服务端产出的内容不会补推，只能靠 REST 重取。
   * 与 ensureHistory 的区别仅在于忽略 historyLoaded（重连必须重新对账）。
   */
  async reloadHistory(load: (sessionId: number) => Promise<ChatMessage[]>) {
    const sid = this.activeSessionId;
    if (!sid) return;
    const history = await load(sid);
    // 会话在等待期间被切换（新对话）则丢弃本次结果，避免把旧会话历史写进新会话
    if (this.activeSessionId !== sid) return;
    // 不整体替换：subscribe 重放先于 REST 返回，覆盖会擦掉本轮流式气泡与工具卡
    this.messages.value = mergeHistory(history, this.messages.value);
    this.historyLoaded = true;
  }

  /** 是否存在未落库确认的本地用户气泡（重连对账判断落库结果用） */
  hasLocalUserMessage(localId: string): boolean {
    return this.messages.value.some((m) => m.id === localId);
  }

  /** 新建会话后调用：新会话必然无历史，无需再走 REST */
  markHistoryLoaded() {
    this.historyLoaded = true;
  }

  reset() {
    this.activeSessionId = null;
    this.activeExecutionId = null;
    this.suppressStreamEvents = false;
    this.cancelledExecutionId = null;
    this.historyLoaded = false;
    this.messages.value = [];
    this.phase.value = null;
    this.sessionError.value = null;
    this.llmRetryText.value = null;
    this.pendingQuestion.value = null;
  }

  // ─── 事件路由 ───

  handleEvent(msg: WsServerEvent) {
    const sid = msg.sessionId;
    if (sid != null && sid !== this.activeSessionId) return;
    const type = msg.type;
    if (sid != null && STREAM_EVENT_TYPES.has(type) && this.isStale(sid, msg.data)) return;
    const data = (msg.data ?? {}) as Record<string, unknown>;

    switch (type) {
      case 'content_delta':
        this.clearLlmRetry();
        this.appendText('text', String(data.delta ?? ''));
        break;
      case 'thinking_start':
        this.clearLlmRetry();
        this.phase.value = 'RUNNING';
        this.ensureStreamingAssistant().streaming = true;
        break;
      case 'thinking_delta':
        this.clearLlmRetry();
        this.appendText('thinking', String(data.delta ?? ''));
        break;
      case 'thinking_end':
        this.clearLlmRetry();
        break;
      case 'tool_call_start': {
        this.clearLlmRetry();
        const msg0 = this.ensureStreamingAssistant();
        const toolCallId = String(data.tool_call_id ?? genId('tc'));
        // 幂等：服务端每次 subscribe 都会重放 active tool_call_start（且按 userId 广播给
        // 该用户全部 socket），无去重会生成重复卡片。对齐 desktop 的"按 id 先查后更"。
        const existing = msg0.toolCalls.find((t) => t.toolCallId === toolCallId);
        const toolName = String(data.tool_name ?? '');
        // arguments 是累积快照（见 tool_call_args_delta 注释）；start 帧常只带首个分片甚至为空
        const argsText = data.arguments != null ? String(data.arguments) : '';
        if (existing) {
          if (toolName) {
            existing.toolName = toolName;
            existing.displayName = toolName;
          }
          // 重放帧的 arguments 可能比已累积的更短（服务端重放的是当时快照）：不回退已有内容
          if (argsText && argsText.length >= existing.argsText.length) existing.argsText = argsText;
          break;
        }
        const tc: ToolCallItem = reactive({
          toolCallId,
          toolName,
          displayName: toolName,
          argsText,
          status: 'running',
          resultText: '',
          imagePreview: undefined,
        });
        this.appendTool(msg0, tc);
        break;
      }
      case 'tool_call_args_delta': {
        // 后端字段：{tool_call_id, arguments}。
        // 注意：arguments 是**累积后的全量快照**，不是增量片段
        // （agent-loop.applyToolCallDelta 已做字符串累加，下发的是 merged.function.arguments），
        // 因此必须覆盖赋值；写成 += 会渲染成重复拼接的乱码。
        const tc = this.findToolCall(data);
        if (tc) tc.argsText = String(data.arguments ?? '');
        break;
      }
      case 'tool_call_result': {
        // 后端字段：{tool_call_id, result, status:'success'|'error', summary?}
        const tc = this.findToolCall(data);
        if (tc) {
          tc.status = data.status === 'error' ? 'error' : 'done';
          tc.resultText = String(data.summary ?? data.result ?? '');
          const preview = extractImagePreview(data.preview) ?? extractImagePreview(data);
          if (preview) tc.imagePreview = preview;
          break;
        }
        // 未见过对应 start（如订阅晚于该工具执行完成）：补一张已完成卡片，避免结果静默丢失
        const toolName = data.tool_name != null ? String(data.tool_name) : '';
        if (!toolName) break;
        this.appendTool(this.ensureStreamingAssistant(),
          reactive({
            toolCallId: data.tool_call_id != null ? String(data.tool_call_id) : genId('tc'),
            toolName,
            displayName: toolName,
            argsText: '',
            status: data.status === 'error' ? 'error' : 'done',
            resultText: String(data.summary ?? data.result ?? ''),
            imagePreview: extractImagePreview(data.preview) ?? extractImagePreview(data),
          }) as ToolCallItem,
        );
        break;
      }
      case 'session_status': {
        const phase = data.phase as WsTaskPhase | undefined;
        if (!phase) break;
        if (phase === 'RUNNING' && typeof data.executionId === 'string') {
          this.activeExecutionId = data.executionId;
          this.suppressStreamEvents = false;
          this.cancelledExecutionId = null;
        }
        // 本地已乐观收口（markCancelled 清空 activeExecutionId）后服务端补发的
        // CANCELLING 属 stale，不能把 UI 打回执行中（对齐 desktop useStreamWS）
        if (phase === 'CANCELLING' && !this.activeExecutionId) break;
        this.phase.value = phase;
        if (TERMINAL_PHASES.includes(phase)) {
          if (phase === 'CANCELLED' || phase === 'FAILED') {
            this.finishInterrupted(phase === 'CANCELLED' ? '执行已被中止' : '执行失败中断');
          }
          if (phase !== 'IDLE') this.clearActiveExecution();
          this.llmRetryText.value = null;
          this.pendingQuestion.value = null;
        }
        break;
      }
      case 'session_snapshot': {
        // subscribe 回放：断线期间错过的终态在此对账
        const phase = data.phase as WsTaskPhase | undefined;
        if (!phase) break;
        if (typeof data.executionId === 'string') {
          this.activeExecutionId = data.executionId;
          this.suppressStreamEvents = false;
          this.cancelledExecutionId = null;
        }
        this.phase.value = phase;
        if (TERMINAL_PHASES.includes(phase)) {
          // 与 session_status 终态一致：断线期间错过 result 事件的工具必须就地终结，
          // 否则卡片永久转圈、流式光标永久闪烁
          if (phase === 'CANCELLED' || phase === 'FAILED') {
            this.finishInterrupted(phase === 'CANCELLED' ? '执行已被中止' : '执行失败中断');
          } else {
            this.closeStreamingBubble();
          }
          if (phase !== 'IDLE') this.clearActiveExecution();
          this.llmRetryText.value = null;
          this.pendingQuestion.value = null;
        }
        break;
      }
      case 'message_end': {
        this.clearLlmRetry();
        const m = this.lastAssistant();
        if (m) {
          m.streaming = false;
        }
        break;
      }
      case 'user_message_saved':
        // 落库确认由 controller 处理（换 id / 外部渠道补插 / 解锁输入）
        break;
      case 'error':
        this.executionError(String(data.message ?? 'Agent 执行异常'));
        break;
      case 'llm_waiting':
        // 对齐桌面端：response_headers / stream_data 是内部诊断，不对嵌入页用户展示。
        break;
      case 'llm_retry':
        this.llmRetryText.value = `LLM 重试中（${String(data.reason ?? '')} 第 ${String(data.attempt ?? 0)}/${String(data.maxRetries ?? 0)} 次）`;
        if (data.statusCode != null) {
          this.llmRetryText.value += ` HTTP ${String(data.statusCode)}`;
        }
        break;
      case 'llm_stream_reset': {
        // 丢掉当前这趟未完成的生成；已结束的工具轮次留在同一条流式气泡里。
        // 守卫 streaming：reset 早于本轮气泡创建时不得误擦历史消息。
        const m = this.lastAssistant();
        if (m?.streaming) this.discardAbortedStreamTail(m);
        break;
      }
      case 'session_already_running':
        this.sessionError.value = String(data.message ?? '该任务仍在运行');
        break;
      default:
        break;
    }
  }

  /** 用户主动发送后立即上屏；返回本地消息 id 供发送失败时回滚 */
  appendLocalUserMessage(content: string, quotedSelection?: string | null, images?: string[]): string {
    const id = genId('u');
    const quote = quotedSelection?.trim() || undefined;
    this.messages.value.push({
      id,
      role: 'user',
      content,
      thinking: '',
      streaming: false,
      error: false,
      segments: [],
      toolCalls: [],
      quotedSelection: quote,
      ...(images && images.length > 0 ? { images } : {}),
    });
    this.ensureStreamingAssistant();
    return id;
  }

  /**
   * 发送失败回滚：移除乐观 user 气泡与其后新建的空 assistant 气泡。
   * 不回滚已有内容的 assistant 气泡（服务端已开始响应则不属于失败场景）。
   */
  rollbackLocalUserMessage(localId: string) {
    const list = this.messages.value;
    const idx = list.findIndex((m) => m.id === localId);
    if (idx < 0) return;
    const tail = list.slice(idx + 1);
    const hasRealContent = tail.some(
      (m) => m.role === 'assistant' && (m.content !== '' || m.thinking !== '' || m.toolCalls.length > 0),
    );
    if (hasRealContent) {
      // 服务端已产出内容：只收口流式态，不删除消息
      this.closeStreamingBubble();
      return;
    }
    this.messages.value = list.slice(0, idx);
  }

  /**
   * 落库确认超时：仅收口没有任何产出的流式气泡，不删除用户消息。
   * 超时不等于发送失败（`user_message_saved` 不参与 subscribe 重放，断线丢帧后永远补不回来），
   * 删除已落库并正在执行的消息会造成"没有提问的回答"。对齐 desktop sendMessageAndWaitForSave
   * 的语义：超时只是"未确认"，不回滚已上屏内容。
   */
  markSendUnconfirmed(localId: string) {
    const list = this.messages.value;
    const idx = list.findIndex((m) => m.id === localId);
    if (idx < 0) return;
    const tail = list.slice(idx + 1);
    const hasRealContent = tail.some(
      (m) => m.role === 'assistant' && (m.content !== '' || m.thinking !== '' || m.toolCalls.length > 0),
    );
    // 已有产出说明服务端确实在执行：保持流式态，等真实事件收口
    if (!hasRealContent) this.closeStreamingBubble();
  }

  /** 外部渠道（微信/定时任务）产生的用户消息补插上屏 */
  appendRemoteUserMessage(content: string) {
    if (!content) return;
    this.messages.value.push({
      id: genId('r'),
      role: 'user',
      content,
      thinking: '',
      streaming: false,
      error: false,
      segments: [],
      toolCalls: [],
    });
  }

  /** 落库确认：把乐观气泡的客户端 id 替换为服务端消息 id（避免后续历史合并撞车） */
  confirmLocalUserMessage(localId: string, messageId: string) {
    const m = this.messages.value.find((x) => x.id === localId);
    if (m) m.id = `s_${messageId}`;
  }

  clearLlmRetry() {
    if (this.llmRetryText.value != null) this.llmRetryText.value = null;
  }

  /** 收口当前流式气泡（不改工具卡状态） */
  private closeStreamingBubble() {
    const m = this.lastAssistant();
    if (m?.streaming) m.streaming = false;
  }

  /**
   * 终态收尾：把本轮 executionId 转存为 cancelledExecutionId，
   * 使旧轮次迟到事件（含 subscribe 重放）仍被 isStale 拦住（对齐 desktop clearActiveExecution）。
   */
  private clearActiveExecution() {
    if (this.activeExecutionId) this.cancelledExecutionId = this.activeExecutionId;
    this.activeExecutionId = null;
  }

  private executionError(message: string) {
    this.sessionError.value = message;
    const m = this.lastAssistant();
    if (m && m.streaming) {
      m.streaming = false;
      m.error = true;
    }
    this.phase.value = 'FAILED';
  }

  /** 终态就地终结 running 工具与流式气泡（desktop finishInterruptedStreamingMessage 语义） */
  private finishInterrupted(reason: string) {
    const m = this.lastAssistant();
    if (m) {
      if (m.streaming && !m.content) {
        m.content = `_${reason}_`;
        m.segments.push({ type: 'text', content: m.content });
      }
      m.streaming = false;
      for (const tc of m.toolCalls) {
        if (tc.status === 'running') tc.status = 'error';
      }
    }
    // 注意：此处不得解除 suppressStreamEvents。终态事件不过 executionId 门禁，
    // 若在此解抑制会把 stop() 刚建立的抑制拆掉。解抑制的唯一时机是新 executionId 的 RUNNING。
  }

  private isStale(_sessionId: number, data: unknown): boolean {
    const d = (data ?? {}) as Record<string, unknown>;
    if (this.suppressStreamEvents) return true;
    const eventExecId = typeof d.executionId === 'string' ? d.executionId : null;
    if (!this.activeExecutionId) {
      if (this.cancelledExecutionId && eventExecId === this.cancelledExecutionId) return true;
      return false;
    }
    if (!eventExecId) return false;
    return eventExecId !== this.activeExecutionId;
  }

  markCancelled() {
    if (this.activeExecutionId) {
      this.cancelledExecutionId = this.activeExecutionId;
    }
    this.suppressStreamEvents = true;
    this.activeExecutionId = null;
    this.llmRetryText.value = null;
    this.pendingQuestion.value = null;
    // 对齐 desktop：主动中止后流式气泡就地收口，避免转圈残留
    const m = this.lastAssistant();
    if (m?.streaming) {
      m.streaming = false;
      for (const tc of m.toolCalls) {
        if (tc.status === 'running') tc.status = 'error';
      }
    }
  }

  private lastAssistant(): ChatMessage | undefined {
    const list = this.messages.value;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].role === 'assistant') return list[i];
    }
    return undefined;
  }

  private ensureStreamingAssistant(): ChatMessage {
    const m = this.lastAssistant();
    if (m && m.streaming) return m;
    const created: ChatMessage = reactive({
      id: genId('a'),
      role: 'assistant',
      content: '',
      thinking: '',
      streaming: true,
      error: false,
      segments: [],
      toolCalls: [],
    });
    // 上一条流式气泡若还挂着 streaming，就地收口
    if (m) m.streaming = false;
    this.messages.value.push(created);
    return created;
  }

  private appendText(type: 'text' | 'thinking', delta: string) {
    if (!delta) return;
    const m = this.ensureStreamingAssistant();
    if (type === 'text') m.content += delta;
    else m.thinking += delta;
    const last = m.segments[m.segments.length - 1];
    if (last?.type === type) last.content += delta;
    else m.segments.push({ type, content: delta });
  }

  private appendTool(m: ChatMessage, tc: ToolCallItem) {
    m.toolCalls.push(tc);
    const last = m.segments[m.segments.length - 1];
    if (last?.type === 'tool-group') last.toolCalls.push(tc);
    else m.segments.push({ type: 'tool-group', toolCalls: [tc] });
  }

  /** 与 desktop discardAbortedStreamTail 对齐：只丢未完成尾巴，保留已完成工具轮次。 */
  private discardAbortedStreamTail(m: ChatMessage) {
    const completed = m.toolCalls.filter((tc) => tc.status === 'done' || tc.status === 'error');
    if (completed.length === 0) {
      m.content = '';
      m.thinking = '';
      m.segments = [];
      m.toolCalls.splice(0, m.toolCalls.length);
      return;
    }
    m.toolCalls.splice(0, m.toolCalls.length, ...completed);
    const completedIds = new Set(completed.map((tc) => tc.toolCallId));
    const kept: ChatMessage['segments'] = [];
    for (const seg of m.segments) {
      if (seg.type !== 'tool-group') {
        kept.push(seg);
        continue;
      }
      const tools = seg.toolCalls.filter((tc) => completedIds.has(tc.toolCallId));
      if (tools.length > 0) kept.push({ type: 'tool-group', toolCalls: tools });
    }
    let lastToolIdx = -1;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].type === 'tool-group') lastToolIdx = i;
    }
    m.segments = lastToolIdx >= 0 ? kept.slice(0, lastToolIdx + 1) : [];
    let content = '';
    let thinking = '';
    for (const seg of m.segments) {
      if (seg.type === 'text') content += seg.content;
      else if (seg.type === 'thinking') thinking += seg.content;
    }
    m.content = content;
    m.thinking = thinking;
  }

  private findToolCall(data: Record<string, unknown>): ToolCallItem | undefined {
    const id = data.tool_call_id != null ? String(data.tool_call_id) : null;
    const m = this.lastAssistant();
    if (!m || id == null) return undefined;
    // 严格按 id 匹配（对齐 desktop）：回退到"最后一张卡"会把结果贴到错误的工具上
    return m.toolCalls.find((t) => t.toolCallId === id);
  }

  markRead() {
    this.unread.value = 0;
  }
}
