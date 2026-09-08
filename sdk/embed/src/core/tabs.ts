/**
 * 多 tab 竞态协调（设计文档 4.5）：
 * 同一浏览器多页签同时初始化时，通过 BroadcastChannel 先到先得宣告 sessionId 所有权。
 * - session-inquiry：新 tab 初始化时询问，持有会话的 tab 应答 session-reply
 * - session-claim：tab 确定会话后宣告（后到 tab 若 inquire 窗口错过，以此为准更新自身记录）
 * localStorage 本身跨 tab 共享；本协调器消除"两 tab 同时读到空记录各自新建"的窗口期竞态。
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
  private readonly replyWaiters = new Map<string, (msg: SessionReplyMessage | null) => void>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(
    private readonly agentId: number,
    /** 本地（localStorage）当前 sessionId，供应答 inquiry */
    private readonly getLocalSessionId: () => number | null,
    private readonly scope: () => string = () => 'isolated',
  ) {}

  private ensureChannel(): BroadcastChannel | null {
    if (this.channel) return this.channel;
    if (typeof BroadcastChannel === 'undefined') return null;
    this.channel = new BroadcastChannel(`${CHANNEL_NAME}_${this.scope()}_${this.agentId}`);
    this.channel.onmessage = (event: MessageEvent<TabsMessage>) => {
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;
      switch (msg.kind) {
        case 'session-inquiry': {
          // 其他 tab 在找会话：本地有则应答
          if (msg.agentId !== this.agentId) return;
          const local = this.getLocalSessionId();
          if (local != null) {
            this.channel?.postMessage({
              kind: 'session-reply',
              agentId: this.agentId,
              sessionId: local,
              nonce: msg.nonce,
            } satisfies SessionReplyMessage);
          }
          return;
        }
        case 'session-reply': {
          const waiter = this.replyWaiters.get(msg.nonce);
          if (waiter) {
            this.replyWaiters.delete(msg.nonce);
            waiter(msg);
          }
          return;
        }
        case 'session-claim':
          // 先到先得宣告：localStorage 已被对方写入，本 tab 无需动作
          return;
      }
    };
    return this.channel;
  }

  /** 宣告本 tab 对 (agentId, sessionId) 的所有权 */
  claim(sessionId: number) {
    const ch = this.ensureChannel();
    if (!ch) return;
    ch.postMessage({
      kind: 'session-claim',
      agentId: this.agentId,
      sessionId,
      nonce: newNonce(),
    } satisfies SessionClaimMessage);
  }

  /**
   * 初始化时询问其他 tab 是否已有会话。
   * 返回 null 表示窗口期内无响应（无其他 tab 或其他 tab 也未建会话）。
   */
  async inquire(waitMs = 300): Promise<number | null> {
    const ch = this.ensureChannel();
    if (!ch) return null;
    const nonce = newNonce();
    const reply = new Promise<SessionReplyMessage | null>((resolve) => {
      this.replyWaiters.set(nonce, resolve);
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (this.replyWaiters.has(nonce)) {
          this.replyWaiters.delete(nonce);
          resolve(null);
        }
      }, waitMs);
      this.timers.add(timer);
    });
    ch.postMessage({ kind: 'session-inquiry', agentId: this.agentId, nonce } satisfies SessionInquiryMessage);
    const resp = await reply;
    return resp?.sessionId ?? null;
  }

  close() {
    this.channel?.close();
    this.channel = null;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const resolve of this.replyWaiters.values()) resolve(null);
    this.replyWaiters.clear();
  }
}

function newNonce(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
