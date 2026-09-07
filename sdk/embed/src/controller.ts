import { createApp, reactive, watch, type App as VueApp } from 'vue';
import type { MaoChatEvent, MaoChatInitOptions, PendingQuestion } from './types';
import { resolveApiBase } from './types';
import RootApp from './ui/RootApp.vue';
import styleText from './ui/style.css?inline';
import { WsClient } from './core/ws-client';
import { ChatStore } from './core/store';
import { SessionManager } from './core/session-manager';
import { RestClient, AuthError } from './core/rest-client';
import { TokenProvider } from './core/token-provider';
import { TabsCoordinator } from './core/tabs';
import { ContextCollector, PREFIX_SEPARATOR, stripContextPrefix } from './context/collector';
import { SelectionTracker } from './context/selection';
import type { ChatMessage, MessageSegment, ToolCallItem } from './types';
import type {
  EmbedMessageVO,
  WsAskUserQuestionAnswer,
  WsTaskPhase,
  WsServerEvent,
} from '@mao/contracts';

/** /sessions/:id/messages 实际使用 session-vo.ts 的 MessageVO，工具字段是 JSON 字符串。 */
interface HistoryMessageVO extends EmbedMessageVO {
  toolCalls?: string | null;
  toolCallId?: string | null;
}

interface HistoryToolCall {
  id: string;
  function: { name: string; arguments?: string | null };
}

/** 传给 RootApp 的响应式 UI 状态（reactive 深层，RootApp 内直接引用字段） */
export interface UiState {
  launcherVisible: boolean;
  panelOpen: boolean;
  /** 已鉴权可用（socket OPEN 且收到 connected 帧） */
  connected: boolean;
  phase: WsTaskPhase | null;
  unread: number;
  sessionTitle: string;
  sessionError: string | null;
  llmRetryText: string | null;
  messages: ChatMessage[];
  pendingQuestion: PendingQuestion | null;
  /** 追问已提交、等待服务端 ask_user_questions_cancelled 期间禁止重复提交 */
  questionSubmitting: boolean;
  quotedSelection: string | null;
  position: 'right' | 'left';
}

export function createUiState(options: MaoChatInitOptions): UiState {
  return reactive({
    launcherVisible: options.launcher?.visible !== false,
    panelOpen: false,
    connected: false,
    phase: null,
    unread: 0,
    sessionTitle: 'Mao 助手',
    sessionError: null,
    llmRetryText: null,
    messages: [],
    pendingQuestion: null,
    questionSubmitting: false,
    quotedSelection: null,
    position: options.position ?? 'right',
  });
}

/** Shadow DOM 挂载：launcher 与 panel 同挂一个 host */
export function mountApp(ui: UiState): { app: VueApp; host: HTMLElement; root: HTMLElement; cleanup: () => void } {
  const host = document.createElement('div');
  host.id = 'mao-chat-embed-host';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = styleText;
  shadow.appendChild(styleEl);

  const mountEl = document.createElement('div');
  mountEl.className = 'mao-root';
  shadow.appendChild(mountEl);
  const app = createApp(RootApp, {
    ui,
    onLauncherClick: () => getController()?.toggle(),
    onClose: () => getController()?.close(),
    onNewSession: () => void getController()?.newSession(),
    onSend: (content: string) => void getController()?.send(content),
    onStop: () => void getController()?.stop(),
    onAnswer: (requestId: string, answers: WsAskUserQuestionAnswer[]) =>
      void getController()?.answer(requestId, answers),
    onClearSelection: () => getController()?.clearSelection(),
    onRetry: () => getController()?.retry(),
  });
  app.mount(mountEl);

  return { app, host, root: mountEl, cleanup: () => { app.unmount(); host.remove(); } };
}

// 模块级单例：RootApp 的 props 回调经 getController() 转发
let controller: EmbedController | null = null;
export function setController(c: EmbedController | null) {
  controller = c;
}
export function getController(): EmbedController | null {
  return controller;
}

/** 鉴权类错误文案：重新鉴权成功后自动清除 */
const AUTH_ERROR_TEXT = '登录凭据已失效，请刷新页面重新登录';
/** 连接类异常文案：不把内部英文错误串暴露给终端用户 */
const CONNECT_ERROR_TEXT = '无法连接到助手服务，请检查网络后重试';
/** 落库确认超时：与 desktop sendMessageAndWaitForSave 一致 */
const SAVE_CONFIRM_TIMEOUT_MS = 60_000;
/** 落库未确认提示：本轮出现任何服务端产出即说明消息已落库，提示自动撤下 */
const SAVE_UNCONFIRMED_TEXT = '发送未确认：服务端未回执，若长时间无响应请重试';
/** 能证明服务端已收到并在处理本会话消息的事件：用于撤下"发送未确认"提示 */
const PROGRESS_EVENT_TYPES = new Set([
  'content_delta',
  'thinking_start',
  'thinking_delta',
  'tool_call_start',
  'tool_call_result',
  'message_end',
  'session_status',
]);

/** 连接类异常判定：WS 构造/关闭类错误统一映射为中文文案 */
function isConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const m = err.message;
  return (
    m.includes('WebSocket') ||
    m.includes('Failed to construct') ||
    m.includes('Invalid URL') ||
    m.includes('Failed to fetch') ||
    m.includes('NetworkError') ||
    m.includes('Load failed')
  );
}

/** 主控制器：串接 ws / store / session / context，直接写 UiState（reactive） */
export class EmbedController {
  private readonly rest: RestClient;
  private readonly tokens: TokenProvider;
  private readonly ws: WsClient;
  readonly store = new ChatStore();
  private readonly sessions: SessionManager;
  private readonly tabs: TabsCoordinator;
  private readonly contextCollector: ContextCollector;
  private selectionTracker: SelectionTracker | null = null;
  private destroyed = false;
  private booted = false;
  /** 等待 user_message_saved 落库确认的本地消息：key 为 eventId */
  private readonly pendingSaves = new Map<
    string,
    {
      localId: string;
      /** 断线期间置 null（暂停计时），重连对账后按需重新武装 */
      timer: ReturnType<typeof setTimeout> | null;
      contextHash: string | null;
      selection: string | null;
    }
  >();
  /** 已提交的追问 requestId：等服务端 cancelled 才移除，期间禁止重复提交 */
  private readonly submittedQuestionIds = new Set<string>();
  /** 落库超时后仍可能迟到的确认：eventId → localId，只用于补做 id 升级，不再计时 */
  private readonly unconfirmedSaves = new Map<string, string>();

  constructor(
    public readonly options: MaoChatInitOptions,
    public readonly ui: UiState,
    private readonly emitEvent: (e: MaoChatEvent) => void,
    private readonly cleanupFn: () => void,
    /** SDK 的 Shadow DOM 宿主：用于排除浮窗内部的文本选中 */
    host: HTMLElement | null = null,
  ) {
    setController(this);
    this.tokens = new TokenProvider(options.getToken);
    this.rest = new RestClient(resolveApiBase(options.serverUrl), () => this.tokens.get(), () =>
      this.tokens.invalidate(),
    );
    this.ws = new WsClient(options.serverUrl, {
      getToken: () => this.tokens.get(),
      onAuthenticated: (isReconnect) => this.onAuthenticated(isReconnect),
      onAuthFailed: () => {
        this.tokens.invalidate();
        this.ui.sessionError = AUTH_ERROR_TEXT;
        this.store.sessionError.value = AUTH_ERROR_TEXT;
      },
      onDisconnected: () => {
        // 断线时 LLM 等待/重试提示不再有效来源，避免永久挂着
        this.store.clearLlmRetry();
        // 落库确认帧不参与 subscribe 重放：断线期间暂停计时，重连后走 REST 对账
        this.pauseSaveTimeouts();
      },
      onEvent: (event) => this.onWsEvent(event),
    });
    this.sessions = new SessionManager({ rest: this.rest, agentId: options.agentId });
    this.tabs = new TabsCoordinator(options.agentId, () => this.sessions.readStoredSessionId());
    this.contextCollector = new ContextCollector(options.context);
    this.selectionTracker = new SelectionTracker((sel) => {
      this.ui.quotedSelection = sel;
    }, host);
    // ws → ui：连接指示灯/输入禁用以"已鉴权"为准（socket OPEN 但未鉴权时业务帧不可用）
    watch(this.ws.authenticated, (v) => {
      this.ui.connected = v;
    });
    // store → ui 投影：消息流/phase/错误/重试提示的唯一真源在 store，
    // reactive ui 由 watch 深度同步（delta 高频但消息量小，可接受）
    watch(
      this.store.messages,
      (v) => {
        this.ui.messages = v;
      },
      { deep: true },
    );
    watch(this.store.phase, (v) => {
      this.ui.phase = v;
      const sid = this.store.sessionId();
      // phase 事件以 store 为准透传给宿主：与 UI 显示的状态严格一致
      // （stale CANCELLING、cancel 抑制等过滤已在 store 内完成）
      if (v != null && sid != null) this.emitEvent({ type: 'phase', phase: v, sessionId: sid });
    });
    watch(this.store.sessionError, (v) => {
      this.ui.sessionError = v;
    });
    watch(this.store.llmRetryText, (v) => {
      this.ui.llmRetryText = v;
    });
    watch(this.store.unread, (v) => {
      this.ui.unread = v;
      this.emitEvent({ type: 'unread', count: v });
    });
    watch(this.store.pendingQuestion, (v) => {
      this.ui.pendingQuestion = v;
      // 卡片被服务端撤销/新一轮追问到来时解锁提交按钮
      if (v == null || !this.submittedQuestionIds.has(v.requestId)) {
        this.ui.questionSubmitting = false;
      }
    });
  }

  /** 历史加载器：boot 首次加载与重连对账共用同一映射逻辑 */
  private fetchHistory = async (sid: number): Promise<ChatMessage[]> => {
    // 后端响应结构：{ messages: EmbedMessageVO[], hasMore, nextBeforeMessageId }
    const page = await this.rest.request<{
      messages: HistoryMessageVO[];
      hasMore?: boolean;
    }>('GET', `/sessions/${sid}/messages`, { query: { roundLimit: 20 } });
    const messages: ChatMessage[] = [];
    // 后端已将 TOOL 行归到所属 ASSISTANT 后；只在当前轮次内按 id 关联，避免跨轮串卡。
    let roundTools = new Map<string, ToolCallItem>();
    for (const m of page.messages ?? []) {
      if (m.role === 'TOOL') {
        const tool = m.toolCallId ? roundTools.get(m.toolCallId) : undefined;
        if (tool) {
          tool.resultText = m.content ?? '';
          // 历史不持久化 WS 的 success/error；done 仅表示已有结果，不推断执行成功。
          tool.status = 'done';
        }
        continue;
      }
      roundTools = new Map();
      if (m.role !== 'USER' && m.role !== 'ASSISTANT') continue;
      // 上下文剥离必须先于 segments 构建，两个表示都只能含用户输入。
      const content = m.role === 'USER' ? stripContextPrefix(m.content ?? '') : m.content ?? '';
      const thinking = m.thinkingContent ?? '';
      const segments: MessageSegment[] = [];
      // 单行仅存聚合字段，没有 delta 顺序。思考→正文是展示约定，不拆分/伪造交错。
      if (thinking) segments.push({ type: 'thinking', content: thinking });
      if (content) segments.push({ type: 'text', content });
      const toolCalls: ToolCallItem[] = [];
      if (m.role === 'ASSISTANT' && m.toolCalls) {
        const calls = JSON.parse(m.toolCalls) as HistoryToolCall[];
        for (const call of calls) {
          const tool: ToolCallItem = {
            toolCallId: call.id,
            toolName: call.function.name,
            displayName: call.function.name,
            argsText: call.function.arguments ?? '',
            // 缺失历史结果不能说明仍在运行，避免已结束的调用永久显示加载态。
            status: 'unknown',
            resultText: '',
          };
          toolCalls.push(tool);
          roundTools.set(tool.toolCallId, tool);
        }
        // 保留持久化调用数组顺序；并行工具完成先后不可从历史推断。
        if (toolCalls.length) segments.push({ type: 'tool-group', toolCalls });
      }
      if (m.role === 'ASSISTANT' && !segments.length) continue;
      messages.push({
        id: `h_${m.id}`,
        role: m.role === 'USER' ? 'user' : 'assistant',
        content,
        thinking,
        segments,
        streaming: false,
        error: false,
        toolCalls,
      });
    }
    return messages;
  };

  /**
   * 鉴权成功：重连场景必须与服务端对账。
   * 订阅由 WsClient 在收到 connected 帧后自动恢复，此处只做会话级恢复。
   */
  private onAuthenticated(isReconnect: boolean) {
    if (this.destroyed) return;
    // 鉴权类错误横幅在重新鉴权成功后自动消失（用户无需手动点重试）
    if (this.ui.sessionError === AUTH_ERROR_TEXT) this.ui.sessionError = null;
    if (this.store.sessionError.value === AUTH_ERROR_TEXT) this.store.sessionError.value = null;
    if (!isReconnect) return;
    // 断线期间服务端产出的内容不会补推，只能靠 REST 重取整段历史
    void this.store
      .reloadHistory(this.fetchHistory)
      .then(() => {
        // 对账在途消息：历史里已有则销账，否则重新武装超时计时
        this.reconcilePendingSaves();
      })
      .catch(() => {
        // 重拉失败不阻断：恢复计时，session_snapshot 仍会把 phase 与残留工具卡对账
        this.reconcilePendingSaves();
      });
  }

  /** 首次展开浮窗时执行：会话恢复/创建 + 懒连接 */
  private async boot() {
    if (this.booted || this.destroyed) return;
    this.booted = true;
    this.ui.sessionError = null;
    this.store.sessionError.value = null;
    try {
      // 多 tab 竞态：先问其他 tab 是否已有会话
      const claimed = await this.tabs.inquire();
      if (claimed != null) {
        this.sessions.writeStoredSessionId(claimed);
      }
      const session = await this.sessions.resolveSession();
      this.tabs.claim(session.id);
      this.store.bindSession(session.id);
      this.ui.sessionTitle = session.title || 'Mao 助手';
      // 历史先于 WS subscribe 拉取：避免流事件先到导致 messages 非空而跳过历史补齐
      await this.store.ensureHistory(this.fetchHistory);
      // subscribe 只登记意图，真正发帧由 WsClient 在鉴权成功后统一执行（不会双发）
      this.ws.subscribe(session.id);
      await this.ws.connect();
    } catch (err) {
      this.booted = false;
      const raw = err instanceof Error ? err.message : '初始化失败';
      if (err instanceof AuthError) {
        this.ui.sessionError = AUTH_ERROR_TEXT;
      } else if (isConnectionError(err)) {
        this.ui.sessionError = CONNECT_ERROR_TEXT;
      } else {
        this.ui.sessionError = raw;
      }
      this.store.sessionError.value = this.ui.sessionError;
      // 宿主埋点拿原始错误，UI 只显示可读文案
      this.emitEvent({ type: 'error', message: raw });
    }
  }

  private onWsEvent(msg: WsServerEvent) {
    if (this.destroyed) return;
    // 服务端有产出 → 消息必然已落库，撤下超时留下的"发送未确认"提示
    if (PROGRESS_EVENT_TYPES.has(msg.type) && msg.sessionId === this.store.sessionId()) {
      this.clearUnconfirmedNotice();
    }
    switch (msg.type) {
      case 'connected':
        // 连接态由 watch(ws.authenticated) 投影，此处无需手写
        return;
      case 'message_end':
        // 收起浮窗时来新消息 → 未读计数（展开时由 open() 清零）
        if (!this.ui.panelOpen && msg.sessionId === this.store.sessionId()) {
          this.store.unread.value++;
        }
        break;
      case 'user_message_saved':
        this.onUserMessageSaved(msg);
        break;
      case 'session_title_updated': {
        const title = (msg.data as { title?: string } | undefined)?.title;
        if (title && msg.sessionId === this.store.sessionId()) this.ui.sessionTitle = title;
        return;
      }
      case 'ask_user_questions': {
        const data = msg.data as { requestId?: string; questions?: unknown[] } | undefined;
        if (data?.requestId) {
          const pq = { requestId: data.requestId, questions: (data.questions ?? []) as never[] };
          this.store.pendingQuestion.value = pq;
          this.ui.pendingQuestion = pq;
          // 服务端重放同一 requestId（subscribe 回放）时保持已提交锁定态
          this.ui.questionSubmitting = this.submittedQuestionIds.has(data.requestId);
        }
        return;
      }
      case 'ask_user_questions_cancelled': {
        const data = msg.data as { requestId?: string } | undefined;
        const pq = this.store.pendingQuestion.value;
        if (data?.requestId) this.submittedQuestionIds.delete(data.requestId);
        if (pq && data?.requestId === pq.requestId) {
          this.store.pendingQuestion.value = null;
          this.ui.pendingQuestion = null;
          this.ui.questionSubmitting = false;
        }
        return;
      }
      case 'session_status': {
        // phase 写入与 stale 过滤交给 store；ui.phase 与宿主 phase 事件由 watch(store.phase) 投影
        // COMPLETED 不清未读：任务完成提示应保留至用户展开浮窗（open→markRead）
        break;
      }
      case 'error': {
        const message = (msg.data as { message?: string } | undefined)?.message ?? 'Agent 执行异常';
        this.emitEvent({ type: 'error', message });
        break;
      }
      case 'session_already_running': {
        // 发送被服务端拒绝：乐观气泡必须立即回滚（不能等 60s 落库超时）
        this.rollbackAllPendingSaves();
        break;
      }
      default:
        break;
    }
    this.store.handleEvent(msg);
  }

  /**
   * 落库确认（desktop useStreamWS user_message_saved 语义）：
   * - 外部渠道（微信/定时任务）的用户消息补插上屏并计未读
   * - 自己发送的消息：把乐观气泡的客户端 id 换成服务端 id，并解除"等落库"超时
   */
  private onUserMessageSaved(msg: WsServerEvent) {
    const data = (msg.data ?? {}) as {
      messageId?: number | string;
      tempEventId?: string;
      source?: string;
      content?: string;
    };
    if (msg.sessionId !== this.store.sessionId()) return;
    const source = data.source;
    if (source === 'weixin' || source === 'scheduled') {
      this.store.appendRemoteUserMessage(typeof data.content === 'string' ? data.content : '');
      // 外部渠道进来的消息才算"新消息"，自己发的不计未读
      if (!this.ui.panelOpen) this.store.unread.value++;
      return;
    }
    const eventId = typeof data.tempEventId === 'string' ? data.tempEventId : '';
    const pending = eventId ? this.pendingSaves.get(eventId) : undefined;
    if (!pending) {
      // 落库确认迟到（60s 计时已到期）：条目已从 pendingSaves 移除，仍需补做 id 升级，
      // 否则该气泡永远停留在客户端 id，后续历史合并只能靠文本比对识别
      const localId = eventId ? this.unconfirmedSaves.get(eventId) : undefined;
      if (localId && data.messageId != null) {
        this.unconfirmedSaves.delete(eventId);
        this.store.confirmLocalUserMessage(localId, String(data.messageId));
        this.clearUnconfirmedNotice();
      }
      return;
    }
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingSaves.delete(eventId);
    if (data.messageId != null) {
      this.store.confirmLocalUserMessage(pending.localId, String(data.messageId));
    }
  }

  // ─── MaoChatInstance ───

  open() {
    this.ui.panelOpen = true;
    // 未读清零唯一入口：展开浮窗（store/ui 单源，watch 投影同步）
    this.store.markRead();
    void this.boot();
  }

  close() {
    this.ui.panelOpen = false;
  }

  toggle() {
    if (this.ui.panelOpen) this.close();
    else this.open();
  }

  async newSession() {
    try {
      const previous = this.store.sessionId();
      const session = await this.sessions.startNewSession();
      // 旧会话退订：否则服务端继续推送其事件（仅靠 store 的 sessionId 过滤兜底）
      if (previous != null && previous !== session.id) this.ws.unsubscribe(previous);
      this.tabs.claim(session.id);
      this.clearPendingSaves();
      this.submittedQuestionIds.clear();
      this.store.reset();
      this.store.bindSession(session.id);
      this.ui.sessionTitle = session.title || 'Mao 助手';
      this.ui.phase = null;
      this.ui.sessionError = null;
      this.ui.questionSubmitting = false;
      // 新会话没有历史，直接置已加载，避免重连对账把空历史反复重拉
      this.store.markHistoryLoaded();
      this.ws.subscribe(session.id);
    } catch (err) {
      const message = err instanceof Error ? err.message : '创建会话失败';
      this.ui.sessionError = isConnectionError(err) ? CONNECT_ERROR_TEXT : message;
      this.store.sessionError.value = this.ui.sessionError;
    }
  }

  setContext(ctx: Record<string, unknown>) {
    this.contextCollector.setOverride(ctx);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.clearPendingSaves();
    this.selectionTracker?.destroy();
    this.selectionTracker = null;
    this.ws.disconnect();
    this.tabs.close();
    this.cleanupFn();
    setController(null);
  }

  private clearPendingSaves() {
    for (const p of this.pendingSaves.values()) {
      if (p.timer) clearTimeout(p.timer);
    }
    this.pendingSaves.clear();
    this.unconfirmedSaves.clear();
  }

  /**
   * 断线时暂停落库确认计时。
   * `user_message_saved` 不参与 subscribe 重放：断线丢掉该帧后计时器必然到期，
   * 会误报未确认。重连后统一改由 REST 历史对账（reconcilePendingSaves）判断。
   */
  private pauseSaveTimeouts() {
    for (const p of this.pendingSaves.values()) {
      if (p.timer) {
        clearTimeout(p.timer);
        p.timer = null;
      }
    }
  }

  /**
   * 重连对账：用重拉后的历史判断在途消息是否已落库。
   * 已落库（本地乐观气泡被 mergeHistory 合并掉）→ 直接销账；
   * 仍在本地 → 服务端很可能没收到，重新武装计时器给一次超时提示的机会。
   */
  private reconcilePendingSaves() {
    for (const [eventId, p] of [...this.pendingSaves.entries()]) {
      if (!this.store.hasLocalUserMessage(p.localId)) {
        if (p.timer) clearTimeout(p.timer);
        this.pendingSaves.delete(eventId);
        continue;
      }
      if (p.timer == null) p.timer = this.armSaveTimeout(eventId);
    }
    // 已超时提示过的消息：若历史证明它已落库，撤下提示并销账
    for (const [eventId, localId] of [...this.unconfirmedSaves.entries()]) {
      if (!this.store.hasLocalUserMessage(localId)) {
        this.unconfirmedSaves.delete(eventId);
        this.clearUnconfirmedNotice();
      }
    }
  }

  /** 服务端明确拒绝发送时回滚全部在途乐观气泡（embed 单会话，同时最多一条在途） */
  private rollbackAllPendingSaves() {
    const pending = [...this.pendingSaves.values()];
    this.clearPendingSaves();
    for (const p of pending) this.rollbackSend(p.localId, p.contextHash, p.selection);
  }

  // ─── UI 事件 ───

  async send(content: string) {
    if (this.store.sessionId() == null) {
      await this.boot();
      if (this.store.sessionId() == null) return;
    }
    const sid = this.store.sessionId()!;
    // 引用文本以 UI 显示为准（clearSelection 后必须真的不带），
    // 为空时再读一次实时选区兜住 200ms debounce 窗口内的新选中（dismiss 状态由 tracker 守住）
    const selection = this.ui.quotedSelection ?? this.selectionTracker?.peek() ?? null;
    const contextHash = this.contextCollector.snapshotHash();
    const prefix = await this.contextCollector.buildPrefix(selection);
    // 选中文本已随本条消息发出：一次性标记为已消费（用户重新选中同一段仍可再次引用）
    if (selection) this.selectionTracker?.consume(selection);
    this.ui.quotedSelection = null;
    const full = prefix ? `${prefix}${PREFIX_SEPARATOR}${content}` : content;
    const localId = this.store.appendLocalUserMessage(content);
    this.ui.sessionError = null;
    this.store.sessionError.value = null;
    const eventId = `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const ok = await this.ws.sendMessage(sid, full, eventId);
    if (!ok) {
      this.rollbackSend(localId, contextHash, selection);
      const message = '发送失败：连接不可用，请稍后重试';
      this.ui.sessionError = message;
      this.store.sessionError.value = message;
      this.emitEvent({ type: 'error', message });
      return;
    }
    // 帧写进 socket ≠ 服务端已落库：超时未收到 user_message_saved 只标记为"未确认"，
    // 不删除消息（服务端可能已落库并在执行，删掉会变成"没有提问的回答"）
    const timer = this.armSaveTimeout(eventId);
    this.pendingSaves.set(eventId, { localId, timer, contextHash, selection });
  }

  /** 落库确认超时定时器：断线时会被清掉，重连对账后按需重新武装 */
  private armSaveTimeout(eventId: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      const p = this.pendingSaves.get(eventId);
      if (!p) return;
      this.pendingSaves.delete(eventId);
      // 计时结束但确认仍可能迟到：留一份映射，迟到的 user_message_saved 仍能把气泡换成服务端 id
      this.unconfirmedSaves.set(eventId, p.localId);
      this.store.markSendUnconfirmed(p.localId);
      this.ui.sessionError = SAVE_UNCONFIRMED_TEXT;
      this.store.sessionError.value = SAVE_UNCONFIRMED_TEXT;
      this.emitEvent({ type: 'error', message: SAVE_UNCONFIRMED_TEXT });
    }, SAVE_CONFIRM_TIMEOUT_MS);
  }

  /** 本轮出现服务端产出即说明消息已落库：撤下"发送未确认"提示（其他错误文案不动） */
  private clearUnconfirmedNotice() {
    if (this.ui.sessionError === SAVE_UNCONFIRMED_TEXT) this.ui.sessionError = null;
    if (this.store.sessionError.value === SAVE_UNCONFIRMED_TEXT) this.store.sessionError.value = null;
  }

  /** 发送失败/超时回滚：气泡、上下文变更基线、选中引用三者一起复原 */
  private rollbackSend(localId: string, contextHash: string | null, selection: string | null) {
    this.store.rollbackLocalUserMessage(localId);
    // 上下文 hash 回滚：否则用户重发时页面上下文不再携带
    this.contextCollector.restoreHash(contextHash);
    if (selection) {
      // 只撤销本次发送的一次性消费，不动用户此前对其他文本的 dismiss 记录
      this.selectionTracker?.unconsume();
      this.ui.quotedSelection = selection;
    }
  }

  async stop() {
    const sid = this.store.sessionId();
    if (sid == null) return;
    // 先 await 成功才抑制：失败时不能让本地进入抑制态（否则服务端续推的内容被吞）
    const ok = await this.ws.cancel(sid);
    if (!ok) {
      const message = '停止失败：连接不可用';
      this.ui.sessionError = message;
      this.store.sessionError.value = message;
      return;
    }
    this.store.markCancelled();
    // 乐观切回发送态，不等服务端 CANCELLED 回包
    this.store.phase.value = 'CANCELLED';
  }

  async answer(requestId: string, answers: WsAskUserQuestionAnswer[]) {
    const sid = this.store.sessionId();
    if (sid == null) return;
    if (this.submittedQuestionIds.has(requestId)) return;
    this.submittedQuestionIds.add(requestId);
    this.ui.questionSubmitting = true;
    const ok = await this.ws.sendAskUserQuestionsResult(sid, requestId, answers);
    if (!ok) {
      // 发送失败：解锁并保留卡片，让用户可重试（答案不能静默丢失）
      this.submittedQuestionIds.delete(requestId);
      this.ui.questionSubmitting = false;
      const message = '提交失败：连接不可用，请重试';
      this.ui.sessionError = message;
      this.store.sessionError.value = message;
      this.emitEvent({ type: 'error', message });
    }
    // 成功也保留卡片，直到服务端 ask_user_questions_cancelled（对齐 desktop）
  }

  clearSelection() {
    // 同时通知 tracker：否则 send() 仍会重新读取 window.getSelection() 拼进引用块
    this.selectionTracker?.dismiss(this.ui.quotedSelection);
    this.ui.quotedSelection = null;
  }

  retry() {
    this.store.sessionError.value = null;
    this.ui.sessionError = null;
    // 运行中（session_already_running 提示）无需重新 boot；IDLE 且已 boot 过也无需
    if (!this.booted) void this.boot();
  }
}
