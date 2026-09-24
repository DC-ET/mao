import type { AtomicBoolean } from '../harness/atomic-boolean.js';
import type { AgentEventListener } from '../harness/core/agent-event-listener.js';

export interface DingtalkBot {
  id?: number;
  appKey: string;
  name: string;
  clientId: string;
  clientSecret: string;
  robotCode: string;
  agentId?: number | null;
  modelId?: number | null;
  progressCardTemplateId?: string | null;
  queueCardTemplateId?: string | null;
  enabled?: number;
  deleted?: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface DingtalkBotView extends Omit<DingtalkBot, 'clientSecret'> {
  clientSecretConfigured: boolean;
}

export interface DingtalkBotRepository {
  list(): Promise<DingtalkBot[]>;
  findById(id: number): Promise<DingtalkBot | null>;
  findByAppKey(appKey: string): Promise<DingtalkBot | null>;
  create(bot: DingtalkBot): Promise<number>;
  update(bot: DingtalkBot): Promise<void>;
  softDelete(id: number): Promise<void>;
}

export type DingtalkChatType = 'p2p' | 'group';

/** 归一化后的入站消息。不保留加密 senderId。 */
export interface DingtalkNormalizedMessage {
  chatType: DingtalkChatType;
  conversationId: string;
  messageId: string;
  senderUserid: string | null;
  senderUnionId: string | null;
  senderName: string;
  msgtype: string;
  text: string;
  downloadCodes: string[];
  fileName: string | null;
  quotedText: string | null;
  isInAtList: boolean;
}

export interface DingtalkInboundContext extends DingtalkNormalizedMessage {
  accountId: string;
  maoUserId?: number;
  groupContext?: string;
  senderLabel?: string;
}

export interface DingtalkReply { text?: string | null; }

export interface DingtalkInboundHandler {
  onMessage(context: DingtalkInboundContext): Promise<DingtalkReply | null>;
}

export interface CancelFlag { get(): boolean; set(value: boolean): void; }

export interface DingtalkHarnessService {
  prepareMessage(sessionId: number, content: unknown): Promise<string> | string;
  execute(sessionId: number, eventId: string | null, listener: AgentEventListener, cancelFlag?: AtomicBoolean | CancelFlag | null, executionUserId?: number | null): Promise<void>;
}

export interface DingtalkInboundQueueRow {
  id: number;
  botId: number;
  sessionId: number;
  messageId: string;
  outTrackId: string | null;
  senderUserid: string;
  maoUserId: number | null;
  rankNo: number;
  status: string;
  payload: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface DingtalkQueueStoredContext {
  accountId: string;
  chatType: DingtalkChatType;
  conversationId: string;
  senderUserid: string | null;
  senderUnionId: string | null;
  senderName: string;
  maoUserId?: number;
  messageId: string;
  senderLabel?: string;
  groupContext?: string;
  quotedText?: string | null;
  msgtype: string;
  text: string;
  fileName: string | null;
}

export interface DingtalkQueuePayload {
  persisted: unknown;
  forModel: unknown;
  context: DingtalkQueueStoredContext;
  botId: number;
}

export interface DingtalkTaskQueuePort {
  enqueue(params: {
    sessionId: number;
    botId: number;
    messageId: string;
    senderUserid: string;
    maoUserId: number | null;
    payload: string;
  }): Promise<number>;
  setOutTrackId(id: number, outTrackId: string): Promise<void>;
  claimNext(sessionId: number): Promise<DingtalkInboundQueueRow | null>;
  complete(id: number): Promise<void>;
  hasPending(sessionId: number): Promise<boolean>;
}

export interface DingtalkCardActionPort {
  findByOutTrackId(outTrackId: string): Promise<DingtalkInboundQueueRow | null>;
  findById(id: number): Promise<DingtalkInboundQueueRow | null>;
  jumpToFront(id: number): Promise<boolean>;
  cancel(id: number): Promise<'CANCELLED' | 'ALREADY_STARTED' | 'NOT_FOUND'>;
}
