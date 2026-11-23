/**
 * Mao WS 流协议类型（@mao/contracts 的 ws.ts 模块）。
 *
 * 消费方：desktop/src/composables/useStreamWS.ts、sdk/embed。
 * 本模块零运行时，仅类型。帧结构以 backend-ts/src/session/ws/streaming-ws-handler.ts 为权威，
 * 修改任何类型前先确认 desktop 与 sdk/embed 两端的序列化行为一致。
 */

/** 客户端类型：服务端 normalizeClient 归一化后的取值 */
export type WsClientType = 'electron' | 'android' | 'cli' | 'browser' | 'embed';

/** ─────────────────── 客户端 → 服务端 帧 ─────────────────── */

/** 连接后首帧，必须是新连接的第一条消息 */
export interface WsAuthFrame {
  type: 'auth';
  token: string;
  client: WsClientType;
  /**
   * 客户端自报版本（管理后台在线设备页展示）。
   * 桌面是已安装的壳版本，安卓是 APK versionName，浏览器是当前页面构建版本，
   * CLI 是 mao-agent 包版本，页面嵌入是 SDK 版本。缺省表示旧客户端未上报。
   */
  clientVersion?: string;
  /**
   * 写/操作类页面能力声明；缺省 false（新 SDK 显式发送，旧版 SDK 不发送该字段按 true 兼容）。
   * 只约束写/操作类 page_* 工具（见 contracts/page.ts）；读类工具不受此开关控制，始终提供。
   */
  pageEnabled?: boolean;
}

export interface WsAuthRefreshFrame {
  type: 'auth_refresh';
  requestId: string;
  token: string;
}

/** Top-level fields, not a business-event data envelope. Epoch milliseconds. */
export interface WsAuthRefreshedFrame {
  type: 'auth_refreshed';
  requestId: string;
  expiresAt: number;
}

export interface WsPingFrame {
  type: 'ping';
}

export interface WsSubscribeFrame {
  type: 'subscribe';
  sessionId: number;
}

export interface WsUnsubscribeFrame {
  type: 'unsubscribe';
  sessionId: number;
}

export interface WsSendMessageData {
  content: string;
  eventId: string;
  images?: string[];
  modelId?: number;
  /** LOCAL 模式：客户端本地技能报告（embed 不使用，类型保留对齐） */
  localSkills?: Array<{ name: string; description: string; folderName: string }>;
  agentsMdContent?: string;
}

export interface WsSendMessageFrame {
  type: 'send_message';
  sessionId: number;
  data: WsSendMessageData;
}

export interface WsCancelFrame {
  type: 'cancel';
  sessionId: number;
}

export interface WsToolApprovalFrame {
  type: 'tool_approval';
  sessionId: number;
  requestId: string;
  approved: boolean;
}

export interface WsAskUserQuestionsResultFrame {
  type: 'ask_user_questions_result';
  sessionId: number;
  data: { requestId: string; answers: WsAskUserQuestionAnswer[] };
}

/** 页面工具名：后端 Agent 可请求、SDK 在浏览器本地执行的受控能力。 */
export type PageToolName =
  | 'page_inspect'
  | 'page_screenshot'
  | 'page_scroll'
  | 'page_focus'
  | 'page_fill'
  | 'page_select'
  | 'page_check'
  | 'page_uncheck'
  | 'page_click'
  | 'page_keyboard'
  | 'page_wait'
  | 'page_observe'
  | 'page_actions';

/** 页面工具错误码：SDK 回传、后端工具原样透传给模型。 */
export type PageToolErrorCode =
  | 'authorization_required'
  | 'authorization_denied'
  | 'snapshot_expired'
  | 'element_not_available'
  | 'element_changed'
  | 'element_disabled'
  | 'element_readonly'
  | 'element_not_fillable'
  | 'element_not_selectable'
  | 'element_not_checkable'
  | 'value_not_applied'
  | 'not_focusable'
  | 'scroll_failed'
  | 'option_not_found'
  | 'option_disabled'
  | 'unsupported_action'
  | 'unsupported_target'
  | 'cross_origin_frame'
  | 'closed_shadow_root'
  | 'navigation_detected'
  | 'task_cancelled'
  | 'page_operation_disabled'
  | 'screenshot_failed'
  | 'screenshot_too_large'
  | 'invalid_arguments'
  | 'internal_error';

/** 服务端 → SDK：页面工具请求（只发往绑定的那个 embed 连接）。 */
export interface WsPageToolRequestData {
  requestId: string;
  tool: PageToolName;
  arguments: Record<string, unknown>;
}

export interface WsPageToolRequestFrame {
  type: 'page_tool_request';
  sessionId: number;
  data: WsPageToolRequestData;
}

/** SDK → 服务端：页面工具执行结果。 */
export interface WsPageToolError {
  code: PageToolErrorCode | string;
  message: string;
  elementId?: string;
}

export interface WsPageToolResultData {
  success: boolean;
  result?: unknown;
  error?: WsPageToolError;
  snapshotId?: string;
  pageVersion?: string;
}

export interface WsPageToolResultFrame {
  type: 'page_tool_result';
  sessionId: number;
  requestId: string;
  data: WsPageToolResultData;
}

/**
 * 服务端 → SDK：该会话的页面执行端已切换到其他连接（或页面任务被取消），
 * SDK 应立即中止在途页面动作/批量并拒绝等待中的确认，避免与接管方重复执行 DOM 动作。
 */
export interface WsPageToolCancelData {
  reason?: string;
}

export type WsEmbedOutboundFrame =
  | WsAuthFrame
  | WsAuthRefreshFrame
  | WsPingFrame
  | WsSubscribeFrame
  | WsUnsubscribeFrame
  | WsSendMessageFrame
  | WsCancelFrame
  | WsToolApprovalFrame
  | WsAskUserQuestionsResultFrame
  | WsPageToolResultFrame;


export interface WsConnectedData {
  userId: number;
}

export type WsTaskPhase =
  | 'IDLE'
  | 'RUNNING'
  | 'RESUMING'
  | 'WAITING_APPROVAL'
  | 'CANCELLING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface WsSessionStatusData {
  phase: WsTaskPhase;
  executionId?: string;
  unread?: boolean;
  startedAt?: string;
}

export interface WsSessionSnapshotData {
  phase: WsTaskPhase;
  executionId?: string;
}

export interface WsSessionTitleUpdatedData {
  title: string;
  sessionType?: string;
  parentSessionId?: number | null;
}

export interface WsAskUserQuestionOption {
  label: string;
  description?: string;
}

export interface WsAskUserQuestionItem {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: WsAskUserQuestionOption[];
}

/**
 * 追问回答项：形状必须与 ask_user_questions 工具的 outputSchema 一致
 * （backend-ts/src/harness/tool/impl/ask-user-questions-tool.ts getOutputSchema），
 * 否则 LLM 拿不到问题与答案的对应关系。desktop / embed / mao-agent 三端共用。
 */
export interface WsAskUserQuestionAnswer {
  question: string;
  selectedLabels: string[];
  customInput?: string | null;
}

export interface WsAskUserQuestionsData {
  requestId: string;
  questions: WsAskUserQuestionItem[];
  metadata?: Record<string, unknown>;
}

export interface WsAskUserQuestionsCancelledData {
  requestId: string;
}

export interface WsLlmWaitingData {
  phase: string;
  elapsedSeconds?: number;
}

export interface WsLlmRetryData {
  reason?: string;
  statusCode?: number;
  attempt?: number;
  maxRetries?: number;
  delaySeconds?: number;
}

export interface WsErrorData {
  message?: string;
}

/** 服务端 → 客户端 事件信封（data 按 type 判别，宽类型收口在消费端） */
export interface WsServerEvent<T = unknown> {
  type: string;
  sessionId: number | null;
  data?: T;
}

/** ─────────────────── embed 使用的 REST 关键类型 ─────────────────── */

export interface EmbedSessionVO {
  id: number;
  userId?: number;
  agentId?: number | null;
  title?: string | null;
  phase?: WsTaskPhase;
  sessionType?: string;
  executionMode?: string | null;
  workspace?: string | null;
  /** 会话来源：web=桌面/Web 端，embed=Embed SDK 浮窗 */
  source?: string;
  updatedAt?: string | null;
  createdAt?: string | null;
}

export interface EmbedCreateSessionRequest {
  agentId: number;
  title?: string | null;
  source?: 'embed' | 'web';
}

/** Embed SDK 历史会话列表分页（GET /sessions?source=embed&agentId=&offset=&limit=） */
export interface EmbedSessionPage {
  items: EmbedSessionVO[];
  total: number;
  offset: number;
  limit: number;
  hasMore: boolean;
}

export interface EmbedMessageVO {
  id: number | string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | string;
  content?: string;
  thinkingContent?: string | null;
  createdAt?: string;
}

/** ─────────────────── 浏览器直播（browser-use 技能画中画，方案 2026-11-20 v2） ─────────────────── */

/** 直播终止原因；string 兜底给旧 sidecar / 新原因前向兼容。 */
export type BrowserLiveStopReason = 'browser_exit' | 'session_end' | 'user_stop' | 'timeout' | 'runner_exit';

export interface BrowserLiveStartedData {
  width: number;
  height: number;
  pageUrl?: string;
  /** playwright-cli 的命名会话名（-s=xxx），缺省为 default */
  cliSession?: string;
}

export interface BrowserFrameData {
  seq: number;
  /** epoch ms */
  ts: number;
  /** JPEG base64（≤512KB，后端超限丢弃） */
  jpeg: string;
  width: number;
  height: number;
  pageUrl?: string;
  cliSession?: string;
}

export interface BrowserLiveStoppedData {
  reason: BrowserLiveStopReason | string;
  cliSession?: string;
}

/**
 * sidecar（runner）→ 后端：/api/ws/stream 上的独立握手帧。
 * 不占用用户 auth 帧、不进 WsClientType 词表、不注册进用户连接表——
 * runner 是会话作用域的旁路连接（token 为 shell JWT）。
 */
export interface WsRunnerAuthFrame {
  type: 'runner_auth';
  token: string;
  sessionId: number;
}

/** sidecar → 后端：直播事件（browser_frame 走限速后转发）。 */
export interface WsRunnerEventFrame {
  type: 'browser_live_started' | 'browser_frame' | 'browser_live_stopped';
  data: BrowserLiveStartedData | BrowserFrameData | BrowserLiveStoppedData;
}

/** 后端 → runner：用户停止或会话终态。sidecar 收到后 Browser.close 并回 browser_live_stopped。 */
export interface WsRunnerStopFrame {
  type: 'browser_live_stop';
  data: { reason: BrowserLiveStopReason | string };
}

/** 桌面客户端 → 后端：停止浏览器（后端校验属主后转发给该会话的 runner）。 */
export interface WsBrowserLiveStopFrame {
  type: 'browser_live_stop';
  sessionId: number;
}
