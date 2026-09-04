import { ref } from 'vue';
import type {
  WsAskUserQuestionsResultFrame,
  WsCancelFrame,
  WsEmbedOutboundFrame,
  WsSendMessageFrame,
  WsServerEvent,
  WsSubscribeFrame,
} from '@mao/contracts';
import {
  DEFAULT_WS_SILENCE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  resolveWsUrl,
} from '../types';

export interface WsClientHooks {
  /** token 供给（连接与重连时取最新） */
  getToken: () => Promise<string>;
  /** 认证通过后的回调：重订阅会话在此进行 */
  onAuthenticated: () => void;
  /** 认证失败（token 无效） */
  onAuthFailed: () => void;
  /** 业务事件入口 */
  onEvent: (event: WsServerEvent) => void;
}

const CONNECT_TIMEOUT_MS = 15_000;

/**
 * embed 版 WS 客户端：从 desktop useStreamWS 裁剪。
 * 必须继承的行为：首帧 auth、心跳与静默判定、指数退避重连、发送失败时重连兜底。
 * executionId 去重与 cancel 抑制在 store 层实现（本层只负责连接与帧收发）。
 */
export class WsClient {
  readonly connected = ref(false);
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  /** 在途 connect 的 reject 句柄：disconnect 打断时同步 settle，避免等待方悬挂 */
  private pendingReject: ((err: Error) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelayMs = 1_000;
  private lastServerMessageAt = 0;
  private intentionalClose = false;
  /** 会话订阅集合，重连后 re-subscribe 用 */
  private readonly subscribedSessionIds = new Set<number>();
  private readonly pendingSends: WsEmbedOutboundFrame[] = [];

  constructor(private readonly serverUrl: string, private readonly hooks: WsClientHooks) {}

  /** 幂等连接；已连接或连接中直接复用。首连超时/失败抛错由调用方决定兜底 */
  connect(): Promise<void> {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    if (this.connectPromise) {
      // 归属校验：connectPromise 只在仍属于存活 socket 时复用
      if (this.socket && this.socket.readyState <= WebSocket.OPEN) return this.connectPromise;
      this.connectPromise = null;
    }

    this.intentionalClose = false;
    const socket = new WebSocket(resolveWsUrl(this.serverUrl));
    this.socket = socket;

    this.connectPromise = new Promise<void>((resolve, reject) => {
      this.pendingReject = (err) => {
        this.pendingReject = null;
        reject(err);
      };
      const timeout = setTimeout(() => {
        try {
          socket.close();
        } catch {
          /* ignore */
        }
      }, CONNECT_TIMEOUT_MS);

      socket.onopen = () => {
        if (socket !== this.socket) return;
        clearTimeout(timeout);
        this.connected.value = true;
        this.reconnectDelayMs = 1_000;
        this.lastServerMessageAt = Date.now();
        this.pendingReject = null;
        void this.hooks.getToken().then(
          (token) => {
            // 鉴权首帧：必须先于任何业务帧
            socket.send(JSON.stringify({ type: 'auth', token, client: 'embed' }));
            this.startHeartbeat();
            this.connectPromise = null;
            resolve();
          },
          (err) => {
            this.connectPromise = null;
            clearTimeout(timeout);
            reject(err instanceof Error ? err : new Error('getToken failed'));
          },
        );
      };

      socket.onmessage = (event) => {
        if (event.target !== this.socket) return;
        this.lastServerMessageAt = Date.now();
        let msg: WsServerEvent;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }
        if (msg.type === 'connected') {
          this.hooks.onAuthenticated();
          // 继续转发：controller 依赖该帧置 ui.connected（否则输入框永久禁用）
          this.hooks.onEvent(msg);
          return;
        }
        this.hooks.onEvent(msg);
      };

      socket.onclose = (event) => {
        if (event.target !== this.socket) return;
        clearTimeout(timeout);
        this.connected.value = false;
        this.stopHeartbeat();
        // 清引用：后续 connect() 不会误判复用已关闭的 socket
        if (this.socket === socket) this.socket = null;
        if (this.connectPromise) {
          this.connectPromise = null;
        }
        // 服务端对无效 token 的处理是 close(1003)（见 streaming-ws-handler），据此触发重取 token
        if (event.code === 1003) {
          this.hooks.onAuthFailed();
        }
        // 无条件 settle：intentionalClose（disconnect）打断在途 connect 时等待方也不能悬挂
        reject(new Error('WebSocket closed'));
        if (!this.intentionalClose) {
          this.scheduleReconnect();
        }
      };

      socket.onerror = () => {
        /* onclose 随后触发，统一处理 */
      };
    });

    return this.connectPromise;
  }

  private startHeartbeat() {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (this.socket?.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastServerMessageAt > DEFAULT_WS_SILENCE_TIMEOUT_MS) {
        this.socket.close();
        return;
      }
      this.socket.send(JSON.stringify({ type: 'ping' }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.intentionalClose) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        /* 重连失败由下一次 onclose 继续排程 */
      });
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  disconnect() {
    this.intentionalClose = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopHeartbeat();
    // 在途 connect 的等待方必须被同步 settle（对齐 desktop pendingSettle 语义），
    // 因为 disconnect 置 socket=null 后异步 onclose 的归属校验会早退、无法到达 reject
    this.pendingReject?.(new Error('WebSocket connection cancelled'));
    this.pendingReject = null;
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.connected.value = false;
    this.connectPromise = null;
    this.subscribedSessionIds.clear();
    this.pendingSends.length = 0;
  }

  /** 认证成功后回调：重连后恢复订阅 */
  resubscribe(sessionIds: Iterable<number>) {
    for (const sid of sessionIds) {
      this.subscribedSessionIds.add(sid);
      this.sendNow({ type: 'subscribe', sessionId: sid });
    }
  }

  subscribe(sessionId: number): void {
    if (this.subscribedSessionIds.has(sessionId)) return;
    this.subscribedSessionIds.add(sessionId);
    const frame: WsSubscribeFrame = { type: 'subscribe', sessionId };
    this.sendOrQueue(frame);
  }

  unsubscribe(sessionId: number): void {
    if (!this.subscribedSessionIds.delete(sessionId)) return;
    this.sendOrQueue({ type: 'unsubscribe', sessionId });
  }

  trackedSessionIds(): number[] {
    return Array.from(this.subscribedSessionIds);
  }

  sendMessage(sessionId: number, content: string, eventId: string): Promise<boolean> {
    const frame: WsSendMessageFrame = {
      type: 'send_message',
      sessionId,
      data: { content, eventId },
    };
    return this.sendReliable(frame);
  }

  cancel(sessionId: number): Promise<boolean> {
    const frame: WsCancelFrame = { type: 'cancel', sessionId };
    return this.sendReliable(frame);
  }

  sendAskUserQuestionsResult(
    sessionId: number,
    requestId: string,
    answers: unknown[],
  ): Promise<boolean> {
    const frame: WsAskUserQuestionsResultFrame = {
      type: 'ask_user_questions_result',
      sessionId,
      data: { requestId, answers },
    };
    return this.sendReliable(frame);
  }

  /** 关键帧：连接不在则尝试重连后补发，重连失败返回 false */
  private sendReliable(frame: WsEmbedOutboundFrame): Promise<boolean> {
    if (this.sendNow(frame)) return Promise.resolve(true);
    return this.connect()
      .then(() => this.sendNow(frame))
      .catch(() => false);
  }

  private sendOrQueue(frame: WsEmbedOutboundFrame) {
    if (this.sendNow(frame)) return;
    this.pendingSends.push(frame);
  }

  private sendNow(frame: WsEmbedOutboundFrame): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }
}
