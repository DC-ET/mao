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
import { ContextCollector } from './context/collector';
import { SelectionTracker } from './context/selection';
import type { ChatMessage } from './types';
import type { EmbedMessageVO, WsTaskPhase, WsServerEvent } from '@mao/contracts';

/** 传给 RootApp 的响应式 UI 状态（reactive 深层，RootApp 内直接引用字段） */
export interface UiState {
  launcherVisible: boolean;
  panelOpen: boolean;
  connected: boolean;
  phase: WsTaskPhase | null;
  unread: number;
  sessionTitle: string;
  sessionError: string | null;
  llmRetryText: string | null;
  messages: ChatMessage[];
  pendingQuestion: PendingQuestion | null;
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
    quotedSelection: null,
    position: options.position ?? 'right',
  });
}

/** Shadow DOM 挂载：launcher 与 panel 同挂一个 host */
export function mountApp(ui: UiState): { app: VueApp; host: HTMLElement; cleanup: () => void } {
  const host = document.createElement('div');
  host.id = 'mao-chat-embed-host';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'open' });

  const styleEl = document.createElement('style');
  styleEl.textContent = styleText;
  shadow.appendChild(styleEl);

  const mountEl = document.createElement('div');
  shadow.appendChild(mountEl);

  const app = createApp(RootApp, {
    ui,
    onLauncherClick: () => getController()?.toggle(),
    onClose: () => getController()?.close(),
    onNewSession: () => void getController()?.newSession(),
    onSend: (content: string) => void getController()?.send(content),
    onStop: () => void getController()?.stop(),
    onAnswer: (requestId: string, answers: unknown[]) => void getController()?.answer(requestId, answers),
    onClearSelection: () => getController()?.clearSelection(),
    onRetry: () => getController()?.retry(),
  });
  app.mount(mountEl);

  return { app, host, cleanup: () => { app.unmount(); host.remove(); } };
}

// 模块级单例：RootApp 的 props 回调经 getController() 转发
let controller: EmbedController | null = null;
export function setController(c: EmbedController | null) {
  controller = c;
}
export function getController(): EmbedController | null {
  return controller;
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

  constructor(
    public readonly options: MaoChatInitOptions,
    public readonly ui: UiState,
    private readonly emitEvent: (e: MaoChatEvent) => void,
    private readonly cleanupFn: () => void,
  ) {
    setController(this);
    this.tokens = new TokenProvider(options.getToken);
    this.rest = new RestClient(resolveApiBase(options.serverUrl), () => this.tokens.get(), () =>
      this.tokens.invalidate(),
    );
    this.ws = new WsClient(options.serverUrl, {
      getToken: () => this.tokens.get(),
      onAuthenticated: () => {
        const sid = this.store.sessionId();
        if (sid != null) this.ws.resubscribe([sid]);
      },
      onAuthFailed: () => {
        this.tokens.invalidate();
        this.ui.sessionError = '登录凭据已失效，请刷新页面重新登录';
      },
      onEvent: (event) => this.onWsEvent(event),
    });
    this.sessions = new SessionManager({ rest: this.rest, agentId: options.agentId });
    this.tabs = new TabsCoordinator(options.agentId, () => this.sessions.readStoredSessionId());
    this.contextCollector = new ContextCollector(options.context);
    this.selectionTracker = new SelectionTracker((sel) => {
      this.ui.quotedSelection = sel;
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
    });
    watch(this.store.sessionError, (v) => {
      this.ui.sessionError = v;
    });
    watch(this.store.llmRetryText, (v) => {
      this.ui.llmRetryText = v;
    });
    watch(this.store.unread, (v) => {
      this.ui.unread = v;
    });
    watch(this.store.pendingQuestion, (v) => {
      this.ui.pendingQuestion = v;
    });
  }
  /** 首次展开浮窗时执行：会话恢复/创建 + 懒连接 */
  private async boot() {
    if (this.booted || this.destroyed) return;
    this.booted = true;
    this.ui.sessionError = null;
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
      this.ui.connected = false;
      // 历史先于 WS subscribe 拉取：避免流事件先到导致 messages 非空而跳过历史补齐
      await this.store.ensureHistory(async (sid) => {
        // 后端响应结构：{ messages: EmbedMessageVO[], hasMore, nextBeforeMessageId }
        const page = await this.rest.request<{
          messages: EmbedMessageVO[];
          hasMore?: boolean;
        }>('GET', `/sessions/${sid}/messages`, { query: { roundLimit: 20 } });
        return (page.messages ?? [])
          .filter((m) => m.role === 'USER' || m.role === 'ASSISTANT')
          .map((m) => ({
            id: `h_${m.id}`,
            role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
            content: m.content ?? '',
            thinking: m.thinkingContent ?? '',
            streaming: false,
            error: false,
            toolCalls: [] as never[],
          }));
      });
      // 连接 + 订阅在历史之后，保证首帧事件不抢在历史前渲染
      await this.ws.connect();
      this.ws.subscribe(session.id);
    } catch (err) {
      this.booted = false;
      if (err instanceof AuthError) {
        this.ui.sessionError = '登录凭据已失效，请刷新页面重新登录';
      } else {
        this.ui.sessionError = err instanceof Error ? err.message : '初始化失败';
      }
      this.emitEvent({ type: 'error', message: this.ui.sessionError });
    }
  }

  private onWsEvent(msg: WsServerEvent) {
    if (this.destroyed) return;
    switch (msg.type) {
      case 'connected':
        this.ui.connected = true;
        return;
      case 'message_end':
      case 'user_message_saved':
        // 收起浮窗时来新消息 → 未读计数（展开时由 open() 清零）
        if (!this.ui.panelOpen && msg.sessionId === this.store.sessionId()) {
          this.store.unread.value++;
        }
        break;
      case 'ask_user_questions': {
        const data = msg.data as { requestId?: string; questions?: unknown[] } | undefined;
        if (data?.requestId) {
          const pq = { requestId: data.requestId, questions: (data.questions ?? []) as never[] };
          this.store.pendingQuestion.value = pq;
          this.ui.pendingQuestion = pq;
        }
        return;
      }
      case 'ask_user_questions_cancelled': {
        const data = msg.data as { requestId?: string } | undefined;
        const pq = this.store.pendingQuestion.value;
        if (pq && data?.requestId === pq.requestId) {
          this.store.pendingQuestion.value = null;
          this.ui.pendingQuestion = null;
        }
        return;
      }
      case 'session_status': {
        const phase = (msg.data as { phase?: WsTaskPhase } | undefined)?.phase;
        if (phase) {
          this.ui.phase = phase;
          if (msg.sessionId != null) {
            this.emitEvent({ type: 'phase', phase, sessionId: msg.sessionId });
          }
          if (phase === 'IDLE' || phase === 'COMPLETED') this.ui.unread = 0;
        }
        break;
      }
      case 'error': {
        const message = (msg.data as { message?: string } | undefined)?.message ?? 'Agent 执行异常';
        this.ui.sessionError = message;
        this.emitEvent({ type: 'error', message });
        break;
      }
      default:
        break;
    }
    this.store.handleEvent(msg);
  }

  // ─── MaoChatInstance ───

  open() {
    this.ui.panelOpen = true;
    this.store.markRead();
    this.ui.unread = 0;
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
      const session = await this.sessions.startNewSession();
      this.tabs.claim(session.id);
      this.store.reset();
      this.store.bindSession(session.id);
      this.ui.sessionTitle = session.title || 'Mao 助手';
      this.ui.phase = null;
      this.ui.sessionError = null;
      this.ws.subscribe(session.id);
    } catch (err) {
      this.ui.sessionError = err instanceof Error ? err.message : '创建会话失败';
    }
  }

  setContext(ctx: Record<string, unknown>) {
    this.contextCollector.setOverride(ctx);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.selectionTracker?.destroy();
    this.selectionTracker = null;
    this.ws.disconnect();
    this.tabs.close();
    this.cleanupFn();
    setController(null);
  }

  // ─── UI 事件 ───

  async send(content: string) {
    if (this.store.sessionId() == null) {
      await this.boot();
      if (this.store.sessionId() == null) return;
    }
    const sid = this.store.sessionId()!;
    const selection = this.selectionTracker?.peek() ?? null;
    const prefix = await this.contextCollector.buildPrefix(selection);
    this.ui.quotedSelection = null;
    const full = prefix ? `${prefix}\n\n---\n\n${content}` : content;
    this.store.appendLocalUserMessage(content);
    this.ui.sessionError = null;
    const eventId = `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const ok = await this.ws.sendMessage(sid, full, eventId);
    if (!ok) {
      this.ui.sessionError = '发送失败：连接不可用，请稍后重试';
      this.emitEvent({ type: 'error', message: this.ui.sessionError });
    }
  }

  async stop() {
    const sid = this.store.sessionId();
    if (sid == null) return;
    this.store.markCancelled();
    const ok = await this.ws.cancel(sid);
    if (!ok) this.ui.sessionError = '停止失败：连接不可用';
  }

  async answer(requestId: string, answers: unknown[]) {
    const sid = this.store.sessionId();
    if (sid == null) return;
    this.store.pendingQuestion.value = null;
    this.ui.pendingQuestion = null;
    await this.ws.sendAskUserQuestionsResult(sid, requestId, answers);
  }

  clearSelection() {
    this.ui.quotedSelection = null;
  }

  retry() {
    this.store.sessionError.value = null;
    this.ui.sessionError = null;
    // 运行中（session_already_running 提示）无需重新 boot；IDLE 且已 boot 过也无需
    if (!this.booted) void this.boot();
  }
}
