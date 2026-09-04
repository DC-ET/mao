import { computed, reactive, ref } from 'vue';
import type { WsTaskPhase, WsServerEvent } from '@mao/contracts';
import type { ChatMessage, PendingQuestion, ToolCallItem } from '../types';

const TERMINAL_PHASES: WsTaskPhase[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'IDLE'];
// 对齐 desktop：session_status / session_snapshot 不经 executionId 门禁
// （RUNNING 事件必须能穿透 cancel 抑制，否则无法恢复新一轮事件流）
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

function genId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 会话运行时状态：消息聚合、工具卡片状态机、executionId 去重、cancel 抑制。
 * 行为对齐 desktop session store 的关键语义（见 useStreamWS routeEvent）。
 */
export class ChatStore {
  readonly messages = ref<ChatMessage[]>([]);
  readonly phase = ref<WsTaskPhase | null>(null);
  readonly connected = ref(false);
  readonly sessionError = ref<string | null>(null);
  readonly llmRetryText = ref<string | null>(null);
  readonly unread = ref(0);
  
  readonly pendingQuestion = ref<PendingQuestion | null>(null);
  readonly busy = computed(() => this.phase.value === 'RUNNING' || this.phase.value === 'RESUMING');

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

  /** 展开浮窗/重连时调用：加载或补齐历史 */
  async ensureHistory(load: (sessionId: number) => Promise<ChatMessage[]>) {
    if (!this.activeSessionId || this.historyLoaded) return;
    const history = await load(this.activeSessionId);
    // 流式途中展开过则保留已有增量，仅补充缺失的前置历史
    if (this.messages.value.length === 0) {
      this.messages.value = history;
    }
    this.historyLoaded = true;
  }

  markHistoryReloaded() {
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
        this.ensureStreamingAssistant().content += String(data.delta ?? '');
        break;
      case 'thinking_start':
        this.phase.value = 'RUNNING';
        this.ensureStreamingAssistant().streaming = true;
        break;
      case 'thinking_delta':
        this.ensureStreamingAssistant().thinking += String(data.delta ?? '');
        break;
      case 'thinking_end':
        break;
      case 'tool_call_start': {
        const msg0 = this.ensureStreamingAssistant();
        const tc: ToolCallItem = reactive({
          toolCallId: String(data.tool_call_id ?? genId('tc')),
          toolName: String(data.tool_name ?? ''),
          displayName: String(data.tool_name ?? ''),
          // 后端 start 帧即携带完整初始 arguments
          argsText: String(data.arguments ?? ''),
          status: 'running',
          resultText: '',
        });
        msg0.toolCalls.push(tc);
        break;
      }
      case 'tool_call_args_delta': {
        // 后端字段：{tool_call_id, arguments}（arguments 为增量文本）
        const tc = this.findToolCall(data);
        if (tc) tc.argsText += String(data.arguments ?? '');
        break;
      }
      case 'tool_call_result': {
        // 后端字段：{tool_call_id, result, status:'success'|'error', summary?}
        const tc = this.findToolCall(data);
        if (tc) {
          tc.status = data.status === 'error' ? 'error' : 'done';
          tc.resultText = String(data.summary ?? data.result ?? '');
        }
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
        this.phase.value = phase;
        if (TERMINAL_PHASES.includes(phase)) {
          if (phase === 'CANCELLED' || phase === 'FAILED') {
            this.finishInterrupted(phase === 'CANCELLED' ? '执行已被中止' : '执行失败中断');
          }
          this.activeExecutionId = phase === 'IDLE' ? this.activeExecutionId : null;
          this.llmRetryText.value = null;
          this.pendingQuestion.value = null;
        }
        break;
      }
      case 'session_snapshot': {
        const phase = data.phase as WsTaskPhase | undefined;
        if (!phase) break;
        if (typeof data.executionId === 'string') this.activeExecutionId = data.executionId;
        this.phase.value = phase;
        if (TERMINAL_PHASES.includes(phase) && phase !== 'IDLE') {
          this.activeExecutionId = null;
        }
        break;
      }
      case 'message_end': {
        const m = this.lastAssistant();
        if (m) {
          m.streaming = false;
        }
        break;
      }
      case 'user_message_saved':
        break;
      case 'error':
        this.executionError(String(data.message ?? 'Agent 执行异常'));
        break;
      case 'llm_waiting':
        this.llmRetryText.value = `LLM 等待中（${String(data.phase ?? '')} ${String(data.elapsedSeconds ?? 0)}s）`;
        break;
      case 'llm_retry':
        this.llmRetryText.value = `LLM 重试中（${String(data.reason ?? '')} 第 ${String(data.attempt ?? 0)}/${String(data.maxRetries ?? 0)} 次）`;
        if (data.statusCode != null) {
          this.llmRetryText.value += ` HTTP ${String(data.statusCode)}`;
        }
        break;
      case 'llm_stream_reset': {
        const m = this.lastAssistant();
        if (m) {
          m.content = '';
          m.thinking = '';
        }
        break;
      }
      case 'session_already_running':
        this.sessionError.value = String(data.message ?? '该任务仍在运行');
        break;
      default:
        break;
    }
  }

  /** 用户主动发送后立即上屏 */
  appendLocalUserMessage(content: string) {
    this.messages.value.push({
      id: genId('u'),
      role: 'user',
      content,
      thinking: '',
      streaming: false,
      error: false,
      toolCalls: [],
    });
    this.ensureStreamingAssistant();
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
      if (m.streaming) m.content = m.content || `_${reason}_`;
      m.streaming = false;
      for (const tc of m.toolCalls) {
        if (tc.status === 'running') tc.status = 'error';
      }
    }
    this.suppressStreamEvents = false;
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
      toolCalls: [],
    });
    // 上一条流式气泡若还挂着 streaming，就地收口
    if (m) m.streaming = false;
    this.messages.value.push(created);
    return created;
  }

  private findToolCall(data: Record<string, unknown>): ToolCallItem | undefined {
    const id = data.tool_call_id != null ? String(data.tool_call_id) : null;
    const m = this.lastAssistant();
    if (!m) return undefined;
    if (id == null) return m.toolCalls[m.toolCalls.length - 1];
    return m.toolCalls.find((t) => t.toolCallId === id);
  }

  markRead() {
    this.unread.value = 0;
  }
}
