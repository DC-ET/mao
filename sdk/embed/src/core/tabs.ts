/**
 * 多 tab 竞态协调（设计文档 4.5）：
 * 同一浏览器多页签同时初始化时，通过 BroadcastChannel 先到先得宣告 sessionId 所有权。
 * localStorage 本身有跨 tab 一致性，这里主要避免“两个 tab 同时读到空记录然后各自新建”的窗口期竞态。
 */
const CHANNEL_NAME = 'mao-embed';

export interface SessionClaimMessage {
  kind: 'session-claim';
  agentId: number;
  sessionId: number;
  nonce: string;
}

export interface SessionInquiryMessage {
  kind: 'session-inquiry';
  agentId: number;
  nonce: string;
}

export interface SessionReplyMessage {
  kind: 'session-reply';
  agentId: number;
  sessionId: number;
  nonce: string;
}

export type TabsMessage = SessionClaimMessage | SessionInquiryMessage | SessionReplyMessage;

export class TabsCoordinator {
  private channel: BroadcastChannel | null = null;
  private readonly replyWaiters = new Map<string, (msg: SessionReplyMessage) => void>();

  private ensureChannel(): BroadcastChannel | null {
    if (this.channel) return this.channel;
    if (typeof BroadcastChannel === 'undefined') return null;
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event: MessageEvent<TabsMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      if (msg.kind === 'session-reply') {
        const waiter = this.replyWaiters.get(msg.nonce);
        if (waiter) {
          this.replyWaiters.delete(msg.nonce);
          waiter(msg);
        }
      }
    };
    return this.channel;
  }

  /** 宣告本 tab 对 (agentId, sessionId) 的所有权 */
  claim(agentId: number, sessionId: number) {
    const ch = this.ensureChannel();
    if (!ch) return;
    ch.postMessage({ kind: 'session-claim', agentId, sessionId, nonce: newNonce() } satisfies SessionClaimMessage);
  }

  /**
   * 初始化时询问其他 tab 是否已有会话。
   * 返回 null 表示窗口期内无响应（无其他 tab 或其他 tab 也未建会话）。
   */
  async inquire(agentId: number, waitMs = 300): Promise<number | null> {
    const ch = this.ensureChannel();
    if (!ch) return null;
    const nonce = newNonce();
    const reply = new Promise<SessionReplyMessage | null>((resolve) => {
      this.replyWaiters.set(nonce, resolve);
      setTimeout(() => {
        if (this.replyWaiters.has(nonce)) {
          this.replyWaiters.delete(nonce);
          resolve(null);
        }
      }, waitMs);
    });
    ch.postMessage({ kind: 'session-inquiry', agentId, nonce } satisfies SessionInquiryMessage);
    const resp = await reply;
    return resp?.sessionId ?? null;
  }

  close() {
    this.channel?.close();
    this.channel = null;
    this.replyWaiters.clear();
  }
}

function newNonce(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
