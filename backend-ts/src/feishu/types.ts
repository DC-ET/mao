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
export interface FeishuBotConfig { enabled: boolean; appId: string; appSecret: string; websocketEndpoint?: string; reconnectDelayMs: number; requestTimeoutMs: number; }
export const DEFAULT_FEISHU_BOT_CONFIG: FeishuBotConfig = { enabled: true, appId: '', appSecret: '', reconnectDelayMs: 1_000, requestTimeoutMs: 30_000 };
export interface FeishuEventHeader { eventId?: string; eventType?: string; createTime?: string; tenantKey?: string; appId?: string; token?: string; }
export interface FeishuNormalizedMessage { eventId: string | null; messageId: string | null; chatId: string | null; chatType: FeishuChatType; senderId: string | null; senderUnionId: string | null; senderName?: string; maoUserId?: number; senderType: string | null; messageType: string; imageKey?: string | null; fileKey?: string | null; fileName?: string | null; text: string; mentions: string[]; isBotMentioned: boolean; content: unknown; rawEvent: unknown; header?: FeishuEventHeader; progressCardMessageId?: string | null; }
export interface FeishuInboundContext extends FeishuNormalizedMessage {
  accountId: string;
  /** Group messages are annotated before reaching the agent handler. */
  groupContext?: string;
  senderLabel?: string;
}
export interface FeishuReply { text?: string | null; }
export interface FeishuInboundHandler { authorizeDirectMessage(accountId: string, senderId: string, text: string): boolean; onMessage(context: FeishuInboundContext): Promise<FeishuReply | null>; }
export interface FeishuHarnessService { prepareMessage(sessionId: number, content: unknown): Promise<string> | string; execute(sessionId: number, eventId: string | null, listener: AgentEventListener, cancelFlag: CancelFlag, executionUserId?: number | null): Promise<void>; }
export interface CancelFlag { get(): boolean; set(value: boolean): void; }
export interface FeishuHttpRequest { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; }
export interface FeishuHttpResponse { status: number; headers?: Record<string, string | string[] | undefined>; body: Buffer; }
export interface FeishuHttpClient { request(url: string, options: FeishuHttpRequest): Promise<FeishuHttpResponse>; }
export interface FeishuWebSocket { send(data: string | Uint8Array): void; close(code?: number, reason?: string): void; on(event: 'open' | 'message' | 'error' | 'close', listener: (...args: unknown[]) => void): void; }
export type FeishuWebSocketFactory = (endpoint: string) => FeishuWebSocket;
export interface FeishuOutboundMessage { receiveId: string; receiveIdType: string; msgType?: string; content: unknown; }
