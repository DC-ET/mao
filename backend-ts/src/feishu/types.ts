export interface FeishuBot {
  id?: number;
  appKey: string;
  name: string;
  appId: string;
  appSecret: string;
  agentId?: number | null;
  modelId?: number | null;
  enabled?: number;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface FeishuBotView extends Omit<FeishuBot, 'appSecret'> { appSecretConfigured: boolean; }
export interface FeishuBotRepository {
  list(): Promise<FeishuBot[]>; findById(id: number): Promise<FeishuBot | null>; findByAppKey(appKey: string): Promise<FeishuBot | null>;
  create(bot: FeishuBot): Promise<number>; update(bot: FeishuBot): Promise<void>; softDelete(id: number): Promise<void>;
}

import type { AgentEventListener } from '../harness/core/agent-event-listener.js';
export type FeishuChatType = 'p2p' | 'group' | 'unknown';
export interface FeishuEventHeader { eventId?: string; eventType?: string; createTime?: string; tenantKey?: string; appId?: string; token?: string; }
export interface FeishuNormalizedMessage { eventId: string | null; messageId: string | null; parentId?: string | null; rootId?: string | null; chatId: string | null; chatType: FeishuChatType; senderId: string | null; senderUnionId: string | null; senderName?: string; maoUserId?: number; senderType: string | null; messageType: string; imageKey?: string | null; fileKey?: string | null; fileName?: string | null; text: string; mentions: string[]; isBotMentioned: boolean; content: unknown; rawEvent: unknown; header?: FeishuEventHeader; progressCardMessageId?: string | null; }
export interface FeishuInboundContext extends FeishuNormalizedMessage {
  accountId: string;
  /** Group messages are annotated before reaching the agent handler. */
  groupContext?: string;
  senderLabel?: string;
  /** 被引用/回复消息的内容预取（引用是任务意图核心，直接注入而非懒加载）。 */
  quotedContext?: string;
}
export interface FeishuReply { text?: string | null; }
export interface FeishuInboundHandler { authorizeDirectMessage(accountId: string, senderId: string, text: string): boolean; onMessage(context: FeishuInboundContext): Promise<FeishuReply | null>; }
export interface FeishuHarnessService { prepareMessage(sessionId: number, content: unknown): Promise<string> | string; execute(sessionId: number, eventId: string | null, listener: AgentEventListener, cancelFlag: CancelFlag, executionUserId?: number | null): Promise<void>; }
export interface CancelFlag { get(): boolean; set(value: boolean): void; }

/** 飞书入站队列行（DB 映射，字段名 camelCase 与 toCamel 对齐）。 */
export interface FeishuInboundQueueRow {
  id: number;
  botId: number;
  sessionId: number;
  messageId: string;
  cardMessageId: string | null;
  senderOpenId: string;
  maoUserId: number | null;
  rankNo: number;
  status: string;
  payload: string;
  createdAt?: string;
  updatedAt?: string;
}

/** 排队消息 payload 中存储的上下文子集（省略 rawEvent/content 等大字段）。 */
export interface FeishuQueueStoredContext {
  accountId: string;
  chatType: FeishuChatType;
  chatId: string | null;
  senderId: string | null;
  senderUnionId: string | null;
  senderName?: string;
  maoUserId?: number;
  messageId: string | null;
  senderLabel?: string;
  groupContext?: string;
  quotedContext?: string;
}

/** 排队消息 payload 结构。 */
export interface FeishuQueuePayload {
  message: unknown;
  context: FeishuQueueStoredContext;
  botId: number;
}

/** 卡片按钮回调动作值。 */
export interface FeishuCardActionValue {
  kind: 'feishu_queue';
  queueId: number;
  act: 'run' | 'cancel';
}

/** 飞书卡片按钮回调事件（SDK RawCardActionEvent 精简版）。 */
export interface FeishuCardActionEvent {
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  token?: string;
  operator?: { open_id?: string; user_id?: string; union_id?: string; name?: string };
  action?: { value?: unknown; tag?: string };
}

/** 卡片动作处理结果（返回给 SDK 作为回调响应）。 */
export interface FeishuCardActionResponse {
  toast?: { type: 'success' | 'info' | 'error' | 'warning'; content: string };
}

/** handler 用于执行队列消费的最小端口。 */
export interface FeishuTaskQueuePort {
  enqueue(params: { sessionId: number; botId: number; messageId: string; senderOpenId: string; maoUserId: number | null; payload: string }): Promise<number>;
  setCardMessageId(id: number, cardMessageId: string): Promise<void>;
  claimNext(sessionId: number): Promise<FeishuInboundQueueRow | null>;
  complete(id: number): Promise<void>;
  hasPending(sessionId: number): Promise<boolean>;
}

/** 卡片动作处理器端口（card-action.service 使用）。 */
export interface FeishuCardActionPort {
  findByCardMessageId(cardMessageId: string): Promise<FeishuInboundQueueRow | null>;
  jumpToFront(id: number): Promise<boolean>;
  cancel(id: number): Promise<'CANCELLED' | 'ALREADY_STARTED' | 'NOT_FOUND'>;
}
