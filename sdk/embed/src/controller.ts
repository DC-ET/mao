import { createApp, reactive, watch, type App as VueApp } from 'vue';
import type { MaoChatEvent, MaoChatInitOptions, PendingQuestion } from './types';
import { resolveApiBase, resolveAssetUrl } from './types';
import RootApp from './ui/RootApp.vue';
import styleText from './ui/style.css?inline';
import { WsClient } from './core/ws-client';
import { ChatStore } from './core/store';
import { SessionManager } from './core/session-manager';
import { RestClient, AuthError } from './core/rest-client';
import {
  DEFAULT_MAX_ATTACHMENT_MB, fetchMaxAttachmentMb, uploadAttachments, type PendingAttachment,
} from './core/attachment';
import { TokenProvider, AUTH_MESSAGES, tokenSubject } from './core/token-provider';
import { TabsCoordinator } from './core/tabs';
import { ContextCollector, PREFIX_SEPARATOR, extractQuotedSelection, stripContextPrefix } from './context/collector';
import { SelectionTracker } from './context/selection';
import type { ChatMessage, MessageSegment, ToolCallItem } from './types';
import type { PageActionLogEntry, PageAuthorizationLevel, PageConfirmRequest, PageHighlightTarget } from './page';
import { PageEngine, isPageToolName } from './page';
import type {
  EmbedMessageVO,
  EmbedSessionVO,
  AgentVO,
  WsAskUserQuestionAnswer,
  WsPageToolResultData,
  WsTaskPhase,
  WsServerEvent,
} from '@mao/contracts';

/** /sessions/:id/messages 实际使用 session-vo.ts 的 MessageVO，工具字段是 JSON 字符串。 */
interface HistoryMessageVO extends EmbedMessageVO {
  images?: string[];
  toolCalls?: string | null;
  toolCallId?: string | null;
  metadata?: string | null;
}

interface HistoryToolCall {
  id: string;
  function: { name: string; arguments?: string | null };
}

function extractHistoryImagePreview(metadata: string | null | undefined): string | undefined {
  if (!metadata) return undefined;
  try {
    const root = JSON.parse(metadata) as { attachments?: Array<{ data_uri?: string }> };
    const uri = root.attachments?.[0]?.data_uri;
    return typeof uri === 'string' && uri.startsWith('data:image/') ? uri : undefined;
  } catch {
    return undefined;
  }
}

/** 传给 RootApp 的响应式 UI 状态（reactive 深层，RootApp 内直接引用字段） */
export interface UiState {
  /** Remount the panel only on account changes, clearing its private input draft. */
  identityVersion: number;
  launcherVisible: boolean;
  panelOpen: boolean;
  /** 已鉴权可用（socket OPEN 且收到 connected 帧） */
  connected: boolean;
  phase: WsTaskPhase | null;
  unread: number;
  sessionTitle: string;
  agentAvatarUrl: string | null;
  /** Agent 推荐问题（新会话空白态展示），boot 时随 Agent 详情拉取 */
  suggestedQuestions: string[];
  sessionError: string | null;
  llmRetryText: string | null;
  messages: ChatMessage[];
  pendingQuestion: PendingQuestion | null;
  /** 追问已提交、等待服务端 ask_user_questions_cancelled 期间禁止重复提交 */
  questionSubmitting: boolean;
  quotedSelection: string | null;
  position: 'right' | 'left';
  /** 后台配置的单文件附件大小上限（MB） */
  attachmentMaxMb: number;
  /** 页面操作授权级别（默认 per_action） */
  pageAuthorization: PageAuthorizationLevel;
  /** 当前是否有正在进行的页面任务 */
  pageTaskActive: boolean;
  /** per_action 下等待用户确认的页面动作 */
  pageConfirm: PageConfirmRequest | null;
  /** 页面动作日志（最近若干条） */
  pageLogs: PageActionLogEntry[];
  /** 当前高亮的页面目标元素 */
  pageHighlight: PageHighlightTarget | null;
  /** 历史会话列表面板是否展开（覆盖在消息区上） */
  historyOpen: boolean;
  /** 历史列表条目（当前 agent、SDK 创建的会话） */
  historyItems: EmbedSessionListItem[];
  /** 历史列表加载中 */
  historyLoading: boolean;
  /** 历史列表触底自动翻页：是否还有下一页 */
  historyHasMore: boolean;
  /** 历史列表加载失败文案（重试入口用） */
  historyError: string | null;
  /** 当前活跃会话 id：历史列表高亮用 */
  activeSessionId: number | null;
}

/** 历史列表条目：与 EmbedSessionVO 字段子集对齐 */
export interface EmbedSessionListItem {
  id: number;
  title: string | null;
  updatedAt: string | null;
  phase: WsTaskPhase | null;
}

export function createUiState(options: MaoChatInitOptions): UiState {
  return reactive({
    identityVersion: 0,
    launcherVisible: options.launcher?.visible !== false,
    panelOpen: false,
    connected: false,
    phase: null,
    unread: 0,
    sessionTitle: FALLBACK_PANEL_TITLE,
    agentAvatarUrl: null,
    suggestedQuestions: [],
    sessionError: null,
    llmRetryText: null,
    messages: [],
    pendingQuestion: null,
    questionSubmitting: false,
    quotedSelection: null,
    position: options.position ?? 'right',
    attachmentMaxMb: DEFAULT_MAX_ATTACHMENT_MB,
    pageAuthorization: options.page?.initialLevel ?? 'per_action',
    pageTaskActive: false,
    pageConfirm: null,
    pageLogs: [],
    pageHighlight: null,
    historyOpen: false,
    historyItems: [],
    historyLoading: false,
    historyHasMore: false,
    historyError: null,
    activeSessionId: null,
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
    onToggleHistory: () => getController()?.toggleHistory(),
    onSelectHistory: (id: number) => void getController()?.selectHistory(id),
    onLoadMoreHistory: () => void getController()?.loadMoreHistory(),
    onSend: (content: string, attachments: PendingAttachment[]) => void getController()?.send(content, attachments),
    onStop: () => void getController()?.stop(),
    onAnswer: (requestId: string, answers: WsAskUserQuestionAnswer[]) =>
      void getController()?.answer(requestId, answers),
    onClearSelection: () => getController()?.clearSelection(),
    onRetry: () => getController()?.retry(),
    onSetPageAuthorization: (level: PageAuthorizationLevel) => getController()?.applyUserPageAuthorization(level),
    onResolvePageConfirm: (id: string, approved: boolean) => getController()?.resolvePageConfirm(id, approved),
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

/** 浮窗标题在 Agent 名称尚未加载或为空时的占位 */
const FALLBACK_PANEL_TITLE = 'Mao 助手';

function displayAgentName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  return trimmed || null;
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
  /** 页面能力引擎：快照 / 动作 / 授权 / 截图，与 controller 共用同一页面实例 */
  readonly pageEngine: PageEngine;
  private destroyed = false;
  private booted = false;
  private identity: string | null = null;
  private identityVersion = 0;
  /** 会话切换序号：在途切换被更新的切换/新对话/身份变化接管时，旧流程静默作废 */
  private switchSeq = 0;
  /** 历史列表请求序号：丢弃过期响应（重开面板使在途翻页响应作废） */
  private historyReqSeq = 0;
  private readonly anonymousScope = crypto.randomUUID();
  private scope = () => JSON.stringify([resolveApiBase(this.options.serverUrl), this.identity ?? this.anonymousScope]);
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
  /** 管理后台配置的 Agent 名称；浮窗标题用这个，不跟会话自动标题走 */
  private agentDisplayName: string | null = null;
  /** 页面工具 requestId 幂等：已处理过的请求重发缓存结果，处理中的重复请求直接忽略 */
  private readonly pageToolResults = new Map<string, WsPageToolResultData>();
  private readonly pageToolInFlight = new Set<string>();

  constructor(
    public readonly options: MaoChatInitOptions,
    public readonly ui: UiState,
    private readonly emitEvent: (e: MaoChatEvent) => void,
    private readonly cleanupFn: () => void,
    /** SDK 的 Shadow DOM 宿主：用于排除浮窗内部的文本选中 */
    host: HTMLElement | null = null,
  ) {
    setController(this);
    this.tokens = options.auth ? new TokenProvider(options.auth.getSsoToken, {
      apiBase: resolveApiBase(options.serverUrl),
      checkUrl: options.auth.checkUrl,
      onUpdate: (update) => {
        const changed = this.setIdentity(update.userId);
        if (!changed) void this.ws.refreshAuth(update.token, update.expiresAt).catch(() => {
          if (!this.destroyed) {
            this.store.sessionError.value = '连接认证更新未确认，请重试';
            this.emitEvent({ type: 'auth', status: 'service_unavailable', message: '连接认证更新未确认，请重试' });
          }
        });
      },
      onStatus: (status) => {
        const message = AUTH_MESSAGES[status];
        this.emitEvent({ type: 'auth', status, message, ...(this.identity ? { userId: Number(this.identity) } : {}) });
        this.ui.sessionError = message || null;
        this.store.sessionError.value = message || null;
        if (status !== 'authenticated' && status !== 'service_unavailable') this.ws.disconnect(true);
        if (status === 'authenticated') this.resumeAuthenticatedPanel();
      },
    }) : new TokenProvider(async () => {
      const token = await options.getToken();
      this.setIdentity(tokenSubject(token));
      return token;
    });
    this.rest = new RestClient(resolveApiBase(options.serverUrl), () => this.tokens.get(), (token, final) => {
      if (final && options.auth) this.tokens.rejectAuthentication(token);
      else this.tokens.invalidate(token);
    }, () => this.identity);
    this.ws = new WsClient(options.serverUrl, {
      getToken: () => this.tokens.get(),
      getExpiresAt: (token) => this.tokens.getExpiresAt(token),
      beforeSend: options.auth ? async () => { await this.tokens.get(); } : undefined,
      identity: () => this.identity,
      onAuthenticated: (isReconnect) => this.onAuthenticated(isReconnect),
      onAuthFailed: () => {
        if (options.auth) {
          // A rejected/expired Mao access token is not proof that the host SSO has expired.
          this.tokens.invalidate();
          void this.tokens.get().catch(() => {});
          return;
        }
        this.tokens.invalidate();
        this.ui.sessionError = AUTH_ERROR_TEXT;
        this.store.sessionError.value = AUTH_ERROR_TEXT;
      },
      onDisconnected: () => {
        // 断线时 LLM 等待/重试提示不再有效来源，避免永久挂着
        this.store.clearLlmRetry();
        // 落库确认帧不参与 subscribe 重放：断线期间暂停计时，重连后走 REST 对账
        this.pauseSaveTimeouts();
        // 页面工具 pending 已被服务端在断线时失败：本地中止在途动作/批量并拒绝等待中的确认，
        // 避免用户断线后批准或重连后新旧请求并发执行 DOM 动作（重复提交）。
        if (this.pageEngine) this.pageEngine.abortInFlight();
      },
      onEvent: (event) => this.onWsEvent(event),
    });
    this.sessions = new SessionManager({ rest: this.rest, agentId: options.agentId, scope: this.scope });
    this.tabs = new TabsCoordinator(options.agentId, () => this.sessions.readStoredSessionId(), this.scope);
    this.contextCollector = new ContextCollector(options.context);
    this.selectionTracker = new SelectionTracker((sel) => {
      this.ui.quotedSelection = sel;
    }, host);
    this.pageEngine = new PageEngine({
      host,
      serverUrl: options.serverUrl,
      agentId: options.agentId,
      identity: () => this.identity,
      currentSessionId: () => this.store.sessionId(),
      screenshotRenderer: options.page?.screenshotRenderer,
      onAuthorizationChange: (level) => {
        this.ui.pageAuthorization = level;
        // 不在此清空 pageConfirm：授权层会在升级（自动放行）或撤销/结束（拒绝）时通过
        // onConfirmRequest(null) 统一收口；降级到 per_action 时等待中的确认卡片应继续可见。
      },
      onConfirmRequest: (request) => {
        this.ui.pageConfirm = request;
      },
      onLog: (entry) => {
        this.ui.pageLogs = [...this.ui.pageLogs, entry].slice(-20);
      },
      onHighlight: (target) => {
        this.ui.pageHighlight = target;
      },
      onTaskStateChange: (active) => {
        this.ui.pageTaskActive = active;
      },
    });
    if (options.page?.initialLevel) this.pageEngine.setInitialLevel(options.page.initialLevel);
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
      // 任务终态：task 授权随任务结束失效，页面任务标记清除
      if (v === 'COMPLETED' || v === 'FAILED' || v === 'CANCELLED') this.pageEngine.endTask();
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

  /** Resume initialization/reconnection after background exchange success, once its flight settles. */
  private resumeAuthenticatedPanel() {
    queueMicrotask(() => {
      if (this.destroyed || !this.ui.panelOpen) return;
      void this.tokens.get().then(async () => {
        if (this.destroyed || !this.ui.panelOpen) return;
        if (!this.booted) await this.boot();
        else if (this.store.sessionId() != null && !this.ws.connected.value) await this.ws.connect();
      }).catch(() => {});
    });
  }

  private setIdentity(user: string | null): boolean {
    if (this.destroyed || this.identity === user) return false;
    const changed = this.identity !== null;
    this.identity = user;
    // 身份就绪/切换后立刻按真实身份同步页面授权（持久化 full 才能反映到浮窗）
    if (this.pageEngine) this.pageEngine.authorization.syncIdentity();
    if (!changed) return false;
    this.identityVersion++;
    this.ui.identityVersion++;
    this.ws.disconnect();
    this.tabs.close();
    this.clearPendingSaves();
    this.submittedQuestionIds.clear();
    this.store.reset();
    this.store.markRead();
    this.ui.messages = [];
    this.ui.pendingQuestion = null;
    this.ui.questionSubmitting = false;
    this.ui.quotedSelection = null;
    this.selectionTracker?.dismiss(this.selectionTracker.peek());
    this.contextCollector.restoreHash(null);
    this.agentDisplayName = null;
    this.applyPanelTitle();
    this.ui.agentAvatarUrl = null;
    this.ui.suggestedQuestions = [];
    // 身份切换：取消页面任务并清空页面授权/日志，避免跨身份继承
    this.pageEngine.cancel();
    this.ui.pageLogs = [];
    this.ui.pageConfirm = null;
    this.ui.pageHighlight = null;
    this.ui.pageTaskActive = false;
    // 历史面板状态一并清空：避免新账号看到上一账号的会话列表与高亮
    this.ui.historyOpen = false;
    this.ui.historyItems = [];
    this.ui.historyLoading = false;
    this.ui.historyHasMore = false;
    this.ui.historyError = null;
    this.ui.activeSessionId = null;
    this.booted = false;
    // Run after the single-flight token acquisition settles; never reuse old session requests.
    if (this.ui.panelOpen) this.resumeAuthenticatedPanel();
    return true;
  }

  private applyPanelTitle() {
    this.ui.sessionTitle = this.agentDisplayName ?? FALLBACK_PANEL_TITLE;
  }

  /** 附件大小上限：后台集成配置变更后，下次 boot/重试即可生效 */
  private async loadAttachmentLimit(): Promise<void> {
    const maxMb = await fetchMaxAttachmentMb(this.rest);
    if (this.destroyed) return;
    this.ui.attachmentMaxMb = maxMb;
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
          const preview = extractHistoryImagePreview(m.metadata);
          if (preview) tool.imagePreview = preview;
        }
        continue;
      }
      roundTools = new Map();
      if (m.role !== 'USER' && m.role !== 'ASSISTANT') continue;
      // 上下文剥离必须先于 segments 构建，两个表示都只能含用户输入。
      const raw = m.content ?? '';
      const quotedSelection = m.role === 'USER' ? extractQuotedSelection(raw) : undefined;
      const content = m.role === 'USER' ? stripContextPrefix(raw) : raw;
      const thinking = m.thinkingContent ?? '';
      // 用户消息的图片附件随 content 一起落库（服务端返回 images），历史回显必须一起还原
      const images = m.role === 'USER' && Array.isArray(m.images)
        ? m.images.map((url) => resolveAssetUrl(String(url), this.options.serverUrl))
        : [];
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
        quotedSelection,
        ...(images.length > 0 ? { images } : {}),
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
    const version = this.identityVersion;
    const stale = () => this.destroyed || version !== this.identityVersion;
    this.ui.sessionError = null;
    this.store.sessionError.value = null;
    try {
      const [agent] = await Promise.all([
        this.rest.request<AgentVO>('GET', `/agents/${this.options.agentId}`),
        // 附件上限用于输入区即时校验；拉取失败保持默认值，不阻断 boot
        this.loadAttachmentLimit(),
      ]);
      if (stale()) return;
      // SDK 嵌在第三方页面：上传路径必须指向 Mao 服务，不能落到宿主域名。
      this.ui.agentAvatarUrl = agent.avatarUrl
        ? new URL(agent.avatarUrl, resolveApiBase(this.options.serverUrl)).href
        : null;
      this.agentDisplayName = displayAgentName(agent.name);
      this.applyPanelTitle();
      // 推荐问题随详情一次拉取；为空或接口未返回时保持空数组（空白态不渲染该区块）
      this.ui.suggestedQuestions = (agent.suggestedQuestions ?? [])
        .map((q) => (q.content ?? '').trim())
        .filter((content) => content.length > 0);
      // 多 tab 竞态：先问其他 tab 是否已有会话
      const claimed = await this.tabs.inquire();
      if (stale()) return;
      if (claimed != null) {
        this.sessions.writeStoredSessionId(claimed);
      }
      const session = await this.sessions.resolveSession();
      if (stale()) return;
      // 存量常驻会话（source=web）惰性补标 embed：失败静默，列表缺它不影响聊天
      void this.sessions.markSourceEmbed(session);
      this.tabs.claim(session.id);
      this.bindSession(session.id);
      // 历史先于 WS subscribe 拉取：避免流事件先到导致 messages 非空而跳过历史补齐
      await this.store.ensureHistory(this.fetchHistory);
      if (stale()) return;
      // subscribe 只登记意图，真正发帧由 WsClient 在鉴权成功后统一执行（不会双发）
      this.ws.subscribe(session.id);
      await this.ws.connect();
    } catch (err) {
      if (stale()) return;
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
      case 'session_title_updated':
        // 浮窗标题固定为 Agent 名称，会话自动标题只用于 desktop 列表
        return;
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
        // 发送被服务端拒绝：乐观气泡必须立即回滚（不能等 60s 落库超时）。
        // 归属校验：泄漏的订阅事件不得回滚当前会话的在途气泡
        if (msg.sessionId === this.store.sessionId()) this.rollbackAllPendingSaves();
        break;
      }
      case 'page_tool_request': {
        // 页面工具请求不进入聊天消息流；由 PageEngine 在浏览器本地执行后经 page_tool_result 回传。
        // 归属校验：只执行当前订阅会话的页面动作，防止切换期间旧会话的工具操纵宿主页
        if (msg.sessionId != null && msg.sessionId !== this.store.sessionId()) return;
        void this.handlePageToolRequest(msg);
        return;
      }
      case 'page_tool_cancel': {
        // 该会话的页面执行端已被其他标签页/连接接管：中止在途动作，避免与新连接重复执行 DOM 副作用
        if (msg.sessionId == null || msg.sessionId === this.store.sessionId()) this.pageEngine.abortInFlight();
        return;
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
    if (this.options.auth) {
      this.resumeAuthenticatedPanel();
    } else void this.boot();
  }

  close() {
    this.ui.panelOpen = false;
  }

  toggle() {
    if (this.ui.panelOpen) this.close();
    else this.open();
  }

  async newSession() {
    const version = this.identityVersion;
    const seq = ++this.switchSeq;
    const stale = () => this.destroyed || version !== this.identityVersion || seq !== this.switchSeq;
    try {
      const previous = this.store.sessionId();
      const session = await this.sessions.startNewSession();
      // 在途期间发生了另一次切换/新对话/身份变化：本次结果作废，不覆盖新状态
      if (stale()) return;
      // 旧会话退订：否则服务端继续推送其事件（仅靠 store 的 sessionId 过滤兜底）
      if (previous != null && previous !== session.id) this.ws.unsubscribe(previous);
      this.tabs.claim(session.id);
      this.clearPendingSaves();
      this.submittedQuestionIds.clear();
      // 新会话：页面任务与 task 授权立即失效，页面日志清空
      this.pageEngine.cancel();
      this.ui.pageLogs = [];
      this.ui.pageConfirm = null;
      this.store.reset();
      this.bindSession(session.id);
      this.applyPanelTitle();
      this.ui.phase = null;
      this.ui.sessionError = null;
      this.ui.questionSubmitting = false;
      // 新会话没有历史，直接置已加载，避免重连对账把空历史反复重拉
      this.store.markHistoryLoaded();
      this.ws.subscribe(session.id);
      // 历史面板开着时从面板入口新建：收起面板，高亮随 bindSession 更新
      this.ui.historyOpen = false;
    } catch (err) {
      // 已作废（新切换接管/身份变化）：错误文案不写到新身份的横幅上
      if (stale()) return;
      const message = err instanceof Error ? err.message : '创建会话失败';
      this.ui.sessionError = isConnectionError(err) ? CONNECT_ERROR_TEXT : message;
      this.store.sessionError.value = this.ui.sessionError;
    }
  }

  /** 绑定会话并同步 UI 状态（历史列表高亮用） */
  private bindSession(id: number | undefined): void {
    if (id == null) return;
    this.store.bindSession(id);
    this.ui.activeSessionId = id;
  }

  /**
   * 历史列表：切换会话。
   * 旧会话进行中的任务在服务端继续跑完不中断；切换期间的事件不再接收，
   * 切回时靠 REST 历史重拉 + session_snapshot 对账还原。
   * 失败（目标不可达/历史拉取失败）则回退到原会话：退订已订阅的目标会话、
   * 恢复原会话绑定与订阅，不产生半切换状态。
   */
  async selectHistory(id: number): Promise<void> {
    if (this.store.sessionId() === id) {
      this.ui.historyOpen = false;
      return;
    }
    const version = this.identityVersion;
    const seq = ++this.switchSeq;
    // 在途期间被更新的切换接管或身份变化：本次静默作废，不回退、不报错
    const stale = () => this.destroyed || version !== this.identityVersion || seq !== this.switchSeq;
    const previous = this.store.sessionId();
    let subscribedTarget = false;
    try {
      // 目标会话可达性校验（已删除/无权 → 3002/1002/403）
      const session = await this.rest.request<EmbedSessionVO>('GET', `/sessions/${id}`);
      if (stale()) return;
      // 退订旧会话：切换期间旧会话事件不再进入本地
      if (previous != null) this.ws.unsubscribe(previous);
      this.clearPendingSaves();
      this.submittedQuestionIds.clear();
      this.pageEngine.cancel();
      this.ui.pageLogs = [];
      this.ui.pageConfirm = null;
      this.store.reset();
      this.bindSession(session.id);
      this.sessions.adoptSession(session);
      this.tabs.claim(session.id);
      this.applyPanelTitle();
      this.ui.phase = session.phase ?? null;
      this.ui.sessionError = null;
      this.ui.questionSubmitting = false;
      this.ui.pendingQuestion = null;
      this.store.pendingQuestion.value = null;
      // 订阅登记在前（重放快照先于 REST 返回也不丢），历史由 reloadHistory 合并
      this.ws.subscribe(session.id);
      subscribedTarget = true;
      await this.store.reloadHistory(this.fetchHistory);
      if (stale()) return;
      this.ui.historyOpen = false;
    } catch (err) {
      // 已被更新切换接管或身份已变：既不回退也不提示（新流程负责后续状态）
      if (stale()) return;
      // 失败回退：先退订已订阅的目标会话（否则泄漏的订阅在重连后仍会恢复）
      if (subscribedTarget) this.ws.unsubscribe(id);
      if (previous != null && this.store.sessionId() !== previous) {
        this.store.reset();
        this.bindSession(previous);
        // 常驻指针与页签声明一并回退：刷新后浮窗仍恢复到回退会话
        this.sessions.adoptSession({ id: previous } as EmbedSessionVO);
        this.tabs.claim(previous);
        this.ws.subscribe(previous);
        await this.store.reloadHistory(this.fetchHistory).catch(() => undefined);
      }
      const message = err instanceof Error ? err.message : '切换会话失败';
      this.ui.historyError = isConnectionError(err) ? CONNECT_ERROR_TEXT : message;
      this.emitEvent({ type: 'error', message: `切换会话失败: ${message}` });
    }
  }

  /** 展开/收起历史列表面板；展开时总是重新拉第一页（新请求使在途旧响应过期） */
  toggleHistory(): void {
    this.ui.historyOpen = !this.ui.historyOpen;
    if (this.ui.historyOpen) void this.loadHistoryPage(0);
  }

  /** 触底加载下一页 */
  loadMoreHistory(): void {
    if (!this.ui.historyHasMore || this.ui.historyLoading) return;
    void this.loadHistoryPage(this.ui.historyItems.length);
  }

  private async loadHistoryPage(offset: number): Promise<void> {
    const seq = ++this.historyReqSeq;
    this.ui.historyLoading = true;
    this.ui.historyError = null;
    try {
      const page = await this.sessions.listSessions(offset);
      // 过期响应丢弃：重新打开面板（offset=0）或更新的翻页请求已发出
      if (seq !== this.historyReqSeq) return;
      const items: EmbedSessionListItem[] = page.items.map((s) => ({
        id: s.id,
        title: s.title ?? null,
        updatedAt: s.updatedAt ?? null,
        phase: s.phase ?? null,
      }));
      if (offset === 0) {
        this.ui.historyItems = items;
      } else {
        // updated_at 排序下当前会话上浮会造成翻页重复：按 id 去重
        const seen = new Set(this.ui.historyItems.map((i) => i.id));
        this.ui.historyItems = [...this.ui.historyItems, ...items.filter((i) => !seen.has(i.id))];
      }
      this.ui.historyHasMore = page.hasMore;
    } catch (err) {
      if (seq !== this.historyReqSeq) return;
      const message = err instanceof Error ? err.message : '加载历史会话失败';
      this.ui.historyError = isConnectionError(err) ? CONNECT_ERROR_TEXT : message;
      if (offset === 0) this.ui.historyItems = [];
    } finally {
      if (seq === this.historyReqSeq) this.ui.historyLoading = false;
    }
  }

  setContext(ctx: Record<string, unknown>) {
    this.contextCollector.setOverride(ctx);
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.pageEngine.destroy();
    this.tokens.destroy();
    this.store.reset();
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

  async send(content: string, attachments: PendingAttachment[] = []) {
    // 新消息代表新一轮任务：清掉上一轮 stop() 留下的取消阻断态。
    this.pageEngine.prepareNewTask();
    const version = this.identityVersion;
    if (this.options.auth) {
      try { await this.tokens.get(); } catch { return; }
      if (this.destroyed || version !== this.identityVersion) return;
    }
    if (this.store.sessionId() == null) {
      await this.boot();
      if (this.store.sessionId() == null) return;
    }
    const sid = this.store.sessionId()!;
    // 附件先上传（图片→images，文件→@{绝对路径}@ 引用）：上传失败就不消费选中引用、不上屏
    const images: string[] = [];
    let failedAttachments: string[] = [];
    if (attachments.length > 0) {
      const uploaded = await uploadAttachments({
        attachments,
        client: this.rest,
        sessionId: sid,
        resolveAssetUrl: (url) => resolveAssetUrl(url, this.options.serverUrl),
      });
      if (this.destroyed || version !== this.identityVersion) return;
      images.push(...uploaded.images);
      if (uploaded.refs.length > 0) {
        content = content ? `${content}\n${uploaded.refs.join(' ')}` : uploaded.refs.join(' ');
      }
      failedAttachments = uploaded.failed;
      // 全部失败且无正文：不发空消息，否则用户以为附件已送达（提示见下）
      if (!content.trim() && images.length === 0) {
        this.reportAttachmentFailure(failedAttachments);
        return;
      }
    }
    // 引用文本以 UI 显示为准（clearSelection 后必须真的不带），
    // 为空时再读一次实时选区兜住 200ms debounce 窗口内的新选中（dismiss 状态由 tracker 守住）
    const selection = this.ui.quotedSelection ?? this.selectionTracker?.peek() ?? null;
    const contextHash = this.contextCollector.snapshotHash();
    const prefix = await this.contextCollector.buildPrefix(selection);
    if (this.destroyed || version !== this.identityVersion) return;
    // 选中文本已随本条消息发出：一次性标记为已消费（用户重新选中同一段仍可再次引用）
    if (selection) this.selectionTracker?.consume(selection);
    this.ui.quotedSelection = null;
    const full = prefix ? `${prefix}${PREFIX_SEPARATOR}${content}` : content;
    const quote = prefix ? extractQuotedSelection(full) : null;
    const localId = this.store.appendLocalUserMessage(content, quote, images);
    this.ui.sessionError = null;
    this.store.sessionError.value = null;
    // 部分附件失败：成功的照常发出，失败项在横幅里点名（不静默吞掉）
    if (failedAttachments.length > 0) this.reportAttachmentFailure(failedAttachments);
    const eventId = `ev_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const ok = await this.ws.sendMessage(sid, full, eventId, images);
    if (this.destroyed || version !== this.identityVersion) return;
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

  /** 附件上传失败：横幅提示 + 宿主埋点；成功上传的附件不受影响 */
  private reportAttachmentFailure(failed: string[]) {
    if (failed.length === 0) return;
    const message = `附件上传失败：${failed.join('、')}`;
    this.ui.sessionError = message;
    this.store.sessionError.value = message;
    this.emitEvent({ type: 'error', message });
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
    // 用户停止：先取消本地页面任务与等待中的确认，再通知服务端
    this.pageEngine.cancel();
    this.ui.pageConfirm = null;
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
    if (sid == null || this.submittedQuestionIds.has(requestId)) return;
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

  // ─── 页面操作（SDK 公共 API 与 UI 共用同一 PageEngine） ───

  setPageAuthorization(level: PageAuthorizationLevel): void {
    // 宿主公开 API：full 降级（用户需在浮窗内显式授权）
    this.pageEngine.setHostLevel(level, this.store.sessionId());
  }

  /** 浮窗内用户点击授权级别：允许授予并持久化 full。 */
  applyUserPageAuthorization(level: PageAuthorizationLevel): void {
    this.pageEngine.setLevel(level, this.store.sessionId());
  }

  resolvePageConfirm(id: string, approved: boolean): void {
    this.pageEngine.resolveConfirmation(id, approved);
  }

  /** 后端 page_tool_request → 本地执行 → page_tool_result 回传。requestId 幂等。 */
  private async handlePageToolRequest(msg: WsServerEvent): Promise<void> {
    const data = msg.data as { requestId?: string; tool?: string; arguments?: Record<string, unknown> } | undefined;
    const sessionId = msg.sessionId;
    const requestId = data?.requestId;
    const tool = data?.tool;
    if (!requestId || !tool || sessionId == null || !isPageToolName(tool)) return;
    const cached = this.pageToolResults.get(requestId);
    if (cached) {
      await this.ws.sendPageToolResult(sessionId, requestId, cached);
      return;
    }
    if (this.pageToolInFlight.has(requestId)) return;
    // 用户已停止任务：拒绝停止后到达的页面请求，避免动作在取消后仍被执行。
    if (this.pageEngine.isCancelled) {
      await this.ws.sendPageToolResult(sessionId, requestId, {
        success: false, error: { code: 'task_cancelled', message: '页面任务已取消' },
      });
      return;
    }
    this.pageToolInFlight.add(requestId);
    let result: WsPageToolResultData;
    try {
      const outcome = await this.pageEngine.handleRequest(tool, data?.arguments ?? {}, sessionId);
      result = {
        success: outcome.success,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
        ...(outcome.error ? { error: outcome.error } : {}),
        ...(outcome.snapshotId ? { snapshotId: outcome.snapshotId } : {}),
        ...(outcome.pageVersion ? { pageVersion: outcome.pageVersion } : {}),
      };
    } catch (e) {
      result = { success: false, error: { code: 'internal_error', message: e instanceof Error ? e.message : String(e) } };
    } finally {
      this.pageToolInFlight.delete(requestId);
    }
    // 截图结果含 dataUri（可能数百 KB）：超过阈值只保留轻量摘要，避免缓存常驻大内存。
    const serialized = JSON.stringify(result);
    this.pageToolResults.set(requestId, serialized.length <= 64_000 ? result : { success: result.success, error: result.error });
    if (this.pageToolResults.size > 50) {
      const oldest = this.pageToolResults.keys().next().value;
      if (oldest != null) this.pageToolResults.delete(oldest);
    }
    if (tool === 'page_screenshot' && result.success) {
      const shot = result.result as { dataUri?: string } | undefined;
      if (typeof shot?.dataUri === 'string') this.store.attachImageToRunningTool('page_screenshot', shot.dataUri);
    }
    await this.ws.sendPageToolResult(sessionId, requestId, result);
  }

  retry() {
    if (this.options.auth) {
      this.tokens.resume();
      void this.tokens.get().then(async () => {
        if (!this.booted) await this.boot();
        else await this.ws.connect();
      }).catch(() => {});
      return;
    }
    this.store.sessionError.value = null;
    this.ui.sessionError = null;
    // 运行中（session_already_running 提示）无需重新 boot；IDLE 且已 boot 过也无需
    if (!this.booted) void this.boot();
  }
}
