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

/**
 * 飞书「一次发送多个文件」的消息形态：msg_type=post，文件挂在 content 顶层 `files` 数组
 * （与普通富文本的 content 元素不同）。是单文件消息（msg_type=file + 顶层 file_key）的多文件版本。
 */
export interface FeishuPostFileItem { fileKey: string; fileName: string | null; }

export interface FeishuNormalizedMessage { eventId: string | null; messageId: string | null; parentId?: string | null; rootId?: string | null; /** 话题 ID (omt_xxx)；非话题消息为 null。话题内回复的 parent_id 恒指向话题根，≠ 用户主动引用。 */ threadId?: string | null; chatId: string | null; chatType: FeishuChatType; senderId: string | null; senderUnionId: string | null; senderName?: string; maoUserId?: number; senderType: string | null; messageType: string; imageKey?: string | null; /** post 富文本内嵌图片 key（image 消息也含单元素数组）；imageKey 为首个，兼容群媒体单值落库。 */ imageKeys?: string[] | null; fileKey?: string | null; fileName?: string | null; /** post 多文件消息的内嵌文件（一次发多个文件）；单文件消息为 null/空。 */ postFiles?: FeishuPostFileItem[] | null; text: string; mentions: string[]; /** 命中本机器人的 @ 提及展示名（与 isBotMentioned 同源判定）；群 `/new` 指令识别用，is_at_me 兜底命中时为空。 */ botMentionNames?: string[]; isBotMentioned: boolean; content: unknown; rawEvent: unknown; header?: FeishuEventHeader; progressCardMessageId?: string | null; }
export interface FeishuInboundContext extends FeishuNormalizedMessage {
  accountId: string;
  /** Group messages are annotated before reaching the agent handler. */
  groupContext?: string;
  senderLabel?: string;
  /** 被引用/回复消息的内容预取（引用是任务意图核心，直接注入而非懒加载）。 */
  quotedContext?: string;
  /** 群 `/new` 指令路径：buildGroupContext 当时的活跃会话（跨发送者窗口并发时，onMessage 执行前指针可能被拨走，用钉住值不读新指针）。 */
  pinnedSessionId?: number;
  /** 与 pinnedSessionId 同一次读出的群行工作区。 */
  pinnedWorkspace?: string | null;
  /** 群 `/new` 指令路径：processor 已执行 createGroupSession 的结果。null=已尝试但失败（handler 回失败文案，不再重试）；undefined=处理器未处理（handler 自己调）。 */
  groupSessionSwitch?: { sessionId: number; created: boolean } | null;
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
  /** 面板展示列（V210 新增；存量行为 null/0，读取时按 payload 回退计算）。 */
  summary?: string | null;
  senderLabel?: string | null;
  imageCount?: number | null;
  fileCount?: number | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * 面板用的队列行（V210 之后）：显式列查询的结果，不含 MEDIUMTEXT payload。
 * 与 FeishuInboundQueueRow 分开定义，避免把 payload 改为可选后污染认领/重建路径。
 */
export type FeishuInboundQueueListItem = Omit<FeishuInboundQueueRow, 'payload' | 'updatedAt'>;

/** 当前会话执行来源：飞书 / 本地（WS 及钉钉微信等非本会话通道）/ 无执行在跑。 */
export type RunningChannel = 'feishu' | 'local' | null;

/** web 端 QueuePanel 展示的飞书排队项。 */
export interface FeishuInboundQueueItemVO {
  id: string;
  senderLabel: string;
  summary: string;
  imageCount: number;
  fileCount: number;
  createdAt: string | null;
  /** 飞书队列内位次，1 起（按 rank 排序后的序号，不直接暴露 rank_no）。 */
  queuePosition: number;
  /** 当前查看者能否取消（本人或发送者未绑定 mao 账号时由 owner 放行）。 */
  cancelable: boolean;
}

/** 取消排队的业务结果（HTTP 统一 200 + result，见技术方案 4.1.7）。 */
export type FeishuInboundQueueCancelResult = 'CANCELLED' | 'ALREADY_STARTED' | 'NOT_FOUND';

/** 路由层依赖的只读视图 + 受控取消端口（不暴露飞书域内部实现）。 */
export interface FeishuInboundQueueViewPort {
  list(session: { id: number; userId?: number | null; phase?: string | null }, viewerUserId: number): Promise<{
    runningChannel: RunningChannel;
    lastRunFailed: boolean;
    items: FeishuInboundQueueItemVO[];
  }>;
  cancel(
    session: { id: number; userId?: number | null },
    queueId: number,
    userId: number,
  ): Promise<FeishuInboundQueueCancelResult>;
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
  /** 话题 ID（排队重建时需保留，否则话题消息出队后丢失路由信息）。 */
  threadId?: string | null;
  parentId?: string | null;
  rootId?: string | null;
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
export type FeishuCardActionValue = FeishuQueueCardActionValue | FeishuProgressCardActionValue | FeishuAskCardActionValue | FeishuEcpAuthCardActionValue;

/** 排队卡片按钮动作值。 */
export interface FeishuQueueCardActionValue {
  kind: 'feishu_queue';
  queueId: number;
  act: 'run' | 'cancel';
}

/** 进度卡按钮动作值（sender 为触发任务的原消息发送者 open_id，用于点击鉴权）。 */
export interface FeishuProgressCardActionValue {
  kind: 'feishu_progress';
  act: 'cancel' | 'retry' | 'dislike';
  sessionId: number;
  sender: string;
}

/** 进度卡提问表单的提交按钮。requestId 放在 value 里，不放进飞书组件 name。 */
export interface FeishuAskCardActionValue {
  kind: 'feishu_ask';
  act: 'submit';
  sessionId: number;
  sender: string;
  requestId: string;
}

/**
 * ECP 绑定引导卡「重新获取链接」按钮。sender 为收到卡片的原发送者 open_id，
 * 用于限制只有本人能换链接（换出来的链接仍绑定到该发送者的飞书身份）。
 */
export interface FeishuEcpAuthCardActionValue {
  kind: 'feishu_ecp_auth';
  act: 'renew';
  sender: string;
}

/** 飞书卡片按钮回调事件（SDK RawCardActionEvent 精简版）。 */
export interface FeishuCardActionEvent {
  context?: { open_message_id?: string; open_chat_id?: string };
  open_message_id?: string;
  open_chat_id?: string;
  token?: string;
  operator?: { open_id?: string; user_id?: string; union_id?: string; name?: string };
  action?: { value?: unknown; tag?: string; name?: string; form_value?: unknown };
}

/** 卡片动作处理结果（返回给 SDK 作为回调响应）。 */
export interface FeishuCardActionResponse {
  toast?: { type: 'success' | 'info' | 'error' | 'warning'; content: string };
  /**
   * 必须随回调返回新卡片，否则飞书客户端会把交互态还原为点击前内容。
   * `type: 'raw'` + JSON 2.0 `data` 与排队/进度卡 schema 对齐。
   */
  card?: { type: 'raw'; data: Record<string, unknown> };
}

/** handler 用于执行队列消费的最小端口。 */
export interface FeishuTaskQueuePort {
  enqueue(params: {
    sessionId: number;
    botId: number;
    messageId: string;
    senderOpenId: string;
    maoUserId: number | null;
    payload: string;
    /** 面板展示列（V210）：入队时一次算好，读取时不再解析 payload。 */
    summary?: string | null;
    senderLabel?: string | null;
    imageCount?: number;
    fileCount?: number;
  }): Promise<number>;
  setCardMessageId(id: number, cardMessageId: string): Promise<void>;
  claimNext(sessionId: number): Promise<FeishuInboundQueueRow | null>;
  /** 执行收尾删行；sessionId 由调用方透传，用于队列变化通知（缺省时回退单查）。 */
  complete(id: number, sessionId?: number): Promise<void>;
  hasPending(sessionId: number): Promise<boolean>;
}

/** 卡片动作处理器端口（card-action.service 使用）。 */
export interface FeishuCardActionPort {
  findByCardMessageId(cardMessageId: string): Promise<FeishuInboundQueueRow | null>;
  jumpToFront(id: number): Promise<boolean>;
  cancel(id: number): Promise<'CANCELLED' | 'ALREADY_STARTED' | 'NOT_FOUND'>;
}
