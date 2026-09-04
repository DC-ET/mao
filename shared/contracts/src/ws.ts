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
  data: { requestId: string; answers: unknown[] };
}

/** embed 实际发送的帧集合 */
export type WsEmbedOutboundFrame =
  | WsAuthFrame
  | WsPingFrame
  | WsSubscribeFrame
  | WsUnsubscribeFrame
  | WsSendMessageFrame
  | WsCancelFrame
  | WsToolApprovalFrame
  | WsAskUserQuestionsResultFrame;

/** ─────────────────── 服务端 → 客户端 事件 payload ─────────────────── */

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
}

export interface EmbedCreateSessionRequest {
  agentId: number;
  title?: string | null;
}

export interface EmbedMessageVO {
  id: number | string;
  role: 'USER' | 'ASSISTANT' | 'SYSTEM' | string;
  content?: string;
  thinkingContent?: string | null;
  createdAt?: string;
}
