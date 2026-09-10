import { ref } from 'vue';
import type {
  WsAskUserQuestionAnswer,
  WsAskUserQuestionsResultFrame,
  WsCancelFrame,
  WsEmbedOutboundFrame,
  WsPageToolResultFrame,
  WsServerEvent,
  WsSendMessageFrame,
} from '@mao/contracts';
import {
  DEFAULT_WS_SILENCE_TIMEOUT_MS,
  HEARTBEAT_INTERVAL_MS,
  resolveWsUrl,
} from '../types';

export interface WsClientHooks {
  beforeSend?: () => Promise<void>;
  identity?: () => string | null;
  /** token 供给（连接与重连时取最新） */
  getToken: () => Promise<string>;
  /** Expiry of the exact credential returned for the initial auth frame. */
  getExpiresAt?: (token: string) => number;
  /** 认证通过（收到 connected 帧）后的回调：断线重连后的会话对账在此进行 */
  onAuthenticated: (isReconnect: boolean) => void;
  /** 认证失败（token 无效） */
  onAuthFailed: () => void;
  /** 连接断开（socket close）：UI 需要据此显示断线态 */
  onDisconnected: () => void;
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
  /** socket 已 OPEN（未必已鉴权） */
  readonly connected = ref(false);
  /** 已收到服务端 connected 帧：业务帧此时才真正可用，UI 的"在线"应以此为准 */
  readonly authenticated = ref(false);
  private socket: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  /** 在途 connect 的 reject 句柄：disconnect 打断时同步 settle，避免等待方悬挂 */
  private pendingReject: ((err: Error) => void) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelayMs = 1_000;
  private lastServerMessageAt = 0;
  private intentionalClose = false;
  /** 订阅意图：跨连接存活，每次鉴权成功后据此恢复 */
  private readonly subscribedSessionIds = new Set<number>();
  /** 当前 socket 上已实际发出 subscribe 的会话：防止同一连接重复订阅（服务端会重放快照） */
  private readonly liveSubscriptions = new Set<number>();
  private authenticatedOnce = false;
  private authToken: string | null = null;
  private authExpiresAt = Infinity;
  private refresh: { requestId: string; token: string; promise: Promise<void>; resolve: () => void;
    reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> | null } | null = null;

  /** Online renewal never replays business frames. Confirmation retries keep the same requestId. */
  refreshAuth(token: string, expiresAt: number): Promise<void> {
    if (!this.authenticated.value || !this.socket) {
      this.authExpiresAt = expiresAt;
      return Promise.resolve();
    }
    if (this.refresh?.token === token) return this.refresh.promise;
    if (this.authToken === token) return Promise.resolve();
    this.clearRefresh(new Error('WebSocket authentication superseded'));
    const socket = this.socket;
    const requestId = crypto.randomUUID();
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
    const pending = { requestId, token, promise, resolve, reject, timer: null as ReturnType<typeof setTimeout> | null };
    this.refresh = pending;
    let attempts = 0;
    const send = () => {
      if (this.refresh !== pending) return;
      if (socket !== this.socket || socket.readyState !== WebSocket.OPEN || attempts >= 3 || Date.now() >= this.authExpiresAt) {
        this.clearRefresh(new Error('WebSocket authentication confirmation timeout'));
        this.authenticated.value = false;
        socket.close();
        return;
      }
      attempts++;
      socket.send(JSON.stringify({ type: 'auth_refresh', requestId, token }));
      pending.timer = setTimeout(send, Math.min(5_000, Math.max(1, this.authExpiresAt - Date.now())));
    };
    send();
    return promise;
  }

  private clearRefresh(error?: Error) {
    const pending = this.refresh;
    if (!pending) return;
    this.refresh = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

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
    // new WebSocket 可能同步抛错（非法 URL、CSP 拦截）：转成 rejected promise，
    // 否则 boot()/sendReliable() 的调用方会收到同步异常而非可控失败
    let socket: WebSocket;
    try {
      socket = new WebSocket(resolveWsUrl(this.serverUrl));
    } catch (err) {
      this.connected.value = false;
      this.authenticated.value = false;
      return Promise.reject(err instanceof Error ? err : new Error('WebSocket 构造失败'));
    }
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
            if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
              reject(new Error('WebSocket connection cancelled'));
              return;
            }
            this.authToken = token;
            this.authExpiresAt = this.hooks.getExpiresAt?.(token) ?? Infinity;
            // 鉴权首帧：必须先于任何业务帧
            socket.send(JSON.stringify({ type: 'auth', token, client: 'embed' }));
            this.startHeartbeat();
            this.connectPromise = null;
            resolve();
          },
          (err) => {
            this.connectPromise = null;
            clearTimeout(timeout);
            const error = err instanceof Error ? err : new Error('getToken failed');
            // 先 settle 再关闭：close 触发的 onclose 会用 'WebSocket closed' 抢先 reject，
            // 掩盖真实失败原因（宿主 token 端点错误），使 UI 提示不可诊断
            reject(error);
            // 未鉴权的 socket 必须关闭：否则它停在 OPEN，下次 connect() 直接 resolve，
            // 业务帧发到未鉴权连接会被服务端 close(1003)
            this.closeSocket(socket);
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
        if (msg.type === 'auth_refreshed') {
          const frame = msg as unknown as { requestId: string; expiresAt: number };
          if (this.refresh?.requestId === frame.requestId && Number.isFinite(frame.expiresAt) && frame.expiresAt > Date.now()) {
            this.authToken = this.refresh.token;
            this.authExpiresAt = frame.expiresAt;
            this.clearRefresh();
          }
          return;
        }
        if (msg.type === 'connected') {
          this.authenticated.value = true;
          const isReconnect = this.authenticatedOnce;
          this.authenticatedOnce = true;
          // 服务端订阅不跨连接存活：每次鉴权成功后按意图集合重建（本连接内幂等）
          this.restoreSubscriptions();
          this.hooks.onAuthenticated(isReconnect);
          // 继续转发：controller 依赖该帧做会话级恢复
          this.hooks.onEvent(msg);
          return;
        }
        this.hooks.onEvent(msg);
      };

      socket.onclose = (event) => {
        if (event.target !== this.socket) return;
        clearTimeout(timeout);
        this.clearRefresh(new Error('WebSocket closed'));
        this.connected.value = false;
        this.authenticated.value = false;
        this.liveSubscriptions.clear();
        this.stopHeartbeat();
        // 清引用：后续 connect() 不会误判复用已关闭的 socket
        if (this.socket === socket) this.socket = null;
        if (this.connectPromise) {
          this.connectPromise = null;
        }
        this.hooks.onDisconnected();
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

  private closeSocket(socket: WebSocket) {
    try {
      socket.close();
    } catch {
      /* ignore */
    }
    if (this.socket === socket) this.socket = null;
    this.connected.value = false;
    this.authenticated.value = false;
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
        // 构造即抛（非法 URL / CSP）时没有 onclose 兜底，需在此继续排程
        this.scheduleReconnect();
      });
    }, this.reconnectDelayMs);
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
  }

  disconnect(preserveSession = false) {
    this.intentionalClose = true;
    this.clearRefresh(new Error('WebSocket connection cancelled'));
    this.authToken = null;
    this.authExpiresAt = Infinity;
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
    this.authenticated.value = false;
    if (!preserveSession) {
      this.authenticatedOnce = false;
      this.subscribedSessionIds.clear();
    }
    this.connectPromise = null;
    this.liveSubscriptions.clear();
  }

  /**
   * 声明订阅意图。socket 尚未鉴权时不发帧：服务端订阅本就不跨连接存活，
   * 鉴权成功后由 restoreSubscriptions 统一补发（避免"立刻发一次 + 鉴权后再发一次"导致快照重放两遍）。
   */
  subscribe(sessionId: number): void {
    this.subscribedSessionIds.add(sessionId);
    if (!this.authenticated.value || this.liveSubscriptions.has(sessionId)) return;
    if (this.sendNow({ type: 'subscribe', sessionId })) {
      this.liveSubscriptions.add(sessionId);
    }
  }

  unsubscribe(sessionId: number): void {
    if (!this.subscribedSessionIds.delete(sessionId)) return;
    this.liveSubscriptions.delete(sessionId);
    // socket 不在时无需补发：服务端订阅随连接销毁，重连时也不会恢复该会话
    this.sendNow({ type: 'unsubscribe', sessionId });
  }

  trackedSessionIds(): number[] {
    return Array.from(this.subscribedSessionIds);
  }

  private restoreSubscriptions(): void {
    this.liveSubscriptions.clear();
    for (const sid of this.subscribedSessionIds) {
      if (this.sendNow({ type: 'subscribe', sessionId: sid })) {
        this.liveSubscriptions.add(sid);
      }
    }
  }

  sendMessage(sessionId: number, content: string, eventId: string, images?: string[]): Promise<boolean> {
    const frame: WsSendMessageFrame = {
      type: 'send_message',
      sessionId,
      data: { content, eventId, ...(images && images.length > 0 ? { images } : {}) },
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
    answers: WsAskUserQuestionAnswer[],
  ): Promise<boolean> {
    const frame: WsAskUserQuestionsResultFrame = {
      type: 'ask_user_questions_result',
      sessionId,
      data: { requestId, answers },
    };
    return this.sendReliable(frame);
  }

  sendPageToolResult(sessionId: number, requestId: string, data: WsPageToolResultFrame['data']): Promise<boolean> {
    return this.sendReliable({ type: 'page_tool_result', sessionId, requestId, data });
  }


  private async sendReliable(frame: WsEmbedOutboundFrame): Promise<boolean> {
    const identity = this.hooks.identity?.();
    try {
      if (this.hooks.beforeSend) {
        await this.hooks.beforeSend();
        if (identity !== this.hooks.identity?.()) return false;
        if (this.refresh) await this.refresh.promise;
      }
      if (this.sendNow(frame)) return true;
      await this.connect();
      if (identity !== this.hooks.identity?.()) return false;
      return this.sendNow(frame);
    } catch { return false; }
  }

  private sendNow(frame: WsEmbedOutboundFrame): boolean {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(frame));
      return true;
    }
    return false;
  }
}
