import WebSocket from 'ws';
import type { WsEvent } from './event-types';
import {
  WS_CLIENT_TYPE,
  WS_HEARTBEAT_INTERVAL_MS,
  WS_MAX_PAYLOAD_BYTES,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_SILENCE_TIMEOUT_MS,
  WS_TRUNCATE_AT_BYTES,
} from './constants';

export type WsHandler = (evt: WsEvent) => void;

export interface WsClientOptions {
  baseUrl: string;
  getToken: () => Promise<string | null>;
  client?: string;
  /** LOCAL 模式握手带 local=1，服务端才会把 cli 当成工具执行端。 */
  localCapable?: boolean;
  heartbeatIntervalMs?: number;
  silenceTimeoutMs?: number;
  reconnectInitialMs?: number;
  reconnectMaxMs?: number;
  maxPayloadBytes?: number;
  truncateAtBytes?: number;
  WebSocketImpl?: typeof WebSocket;
  debug?: (msg: string, extra?: unknown) => void;
  onReconnect?: () => void;
  onConsecutiveReconnectFailures?: (count: number) => void;
}

function toWsBase(httpBase: string): string {
  return httpBase.replace(/^http/i, 'ws').replace(/\/+$/, '');
}

export function buildStreamUrl(baseUrl: string, token: string, client: string, localCapable?: boolean): string {
  let url = `${toWsBase(baseUrl)}/ws/stream?token=${encodeURIComponent(token)}&client=${encodeURIComponent(client)}`;
  if (localCapable) url += '&local=1';
  return url;
}

export function serializePayload(payload: object, truncateAtBytes: number, maxBytes: number): string {
  let json = JSON.stringify(payload);
  if (Buffer.byteLength(json) <= truncateAtBytes) return json;
  const clone = JSON.parse(json) as Record<string, unknown>;
  const mark = '…[truncated: payload exceeded WS 900KB limit]';
  const keys = ['result', 'content', 'error', 'arguments', 'preview'];
  for (const key of keys) {
    if (typeof clone[key] === 'string') {
      const original = clone[key] as string;
      let lo = 0;
      let hi = original.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi + 1) / 2);
        clone[key] = original.slice(0, mid) + mark;
        json = JSON.stringify(clone);
        if (Buffer.byteLength(json) <= truncateAtBytes) lo = mid;
        else hi = mid - 1;
      }
      clone[key] = original.slice(0, lo) + mark;
      json = JSON.stringify(clone);
      break;
    }
    if (clone.data && typeof clone.data === 'object' && typeof (clone.data as Record<string, unknown>)[key] === 'string') {
      const data = clone.data as Record<string, unknown>;
      data[key] = String(data[key]).slice(0, 1000) + mark;
      json = JSON.stringify(clone);
      break;
    }
  }
  if (Buffer.byteLength(json) > maxBytes) {
    json = JSON.stringify({ type: (clone.type as string) ?? 'unknown', truncated: true, marker: mark });
  }
  return json;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private intentionalClose = false;
  private connectPromise: Promise<void> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private lastServerMessageAt = 0;
  private reconnectDelay: number;
  private consecutiveFailures = 0;
  private readonly subscribed = new Set<number>();
  private readonly handlers: WsHandler[] = [];
  private onReconnectCb?: () => void;
  private readonly heartbeatIntervalMs: number;
  private readonly silenceTimeoutMs: number;
  private readonly reconnectInitialMs: number;
  private readonly reconnectMaxMs: number;
  private readonly truncateAtBytes: number;
  private readonly maxPayloadBytes: number;
  private readonly WSImpl: typeof WebSocket;

  constructor(private readonly opts: WsClientOptions) {
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
    this.silenceTimeoutMs = opts.silenceTimeoutMs ?? WS_SILENCE_TIMEOUT_MS;
    this.reconnectInitialMs = opts.reconnectInitialMs ?? WS_RECONNECT_INITIAL_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? WS_RECONNECT_MAX_MS;
    this.truncateAtBytes = opts.truncateAtBytes ?? WS_TRUNCATE_AT_BYTES;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? WS_MAX_PAYLOAD_BYTES;
    this.reconnectDelay = this.reconnectInitialMs;
    this.WSImpl = opts.WebSocketImpl ?? WebSocket;
    this.onReconnectCb = opts.onReconnect;
  }

  setOnReconnect(fn: () => void): void {
    this.onReconnectCb = fn;
  }

  on(handler: WsHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const i = this.handlers.indexOf(handler);
      if (i >= 0) this.handlers.splice(i, 1);
    };
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === this.WSImpl.OPEN) return;
    if (this.connectPromise) return this.connectPromise;
    this.intentionalClose = false;
    this.connectPromise = this.openOnce();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  subscribe(sessionId: number): void {
    this.subscribed.add(sessionId);
    this.send({ type: 'subscribe', sessionId });
  }

  unsubscribe(sessionId: number): void {
    this.subscribed.delete(sessionId);
    this.send({ type: 'unsubscribe', sessionId });
  }

  send(payload: object): void {
    if (this.ws?.readyState === this.WSImpl.OPEN) {
      const json = serializePayload(payload, this.truncateAtBytes, this.maxPayloadBytes);
      this.opts.debug?.('ws send', payload);
      this.ws.send(json);
    } else {
      this.opts.debug?.('ws send dropped (not open)', payload);
    }
  }

  async sendReliable(payload: object): Promise<boolean> {
    const trySend = (): boolean => {
      if (this.ws?.readyState === this.WSImpl.OPEN) {
        const json = serializePayload(payload, this.truncateAtBytes, this.maxPayloadBytes);
        this.opts.debug?.('ws sendReliable', payload);
        this.ws.send(json);
        return true;
      }
      return false;
    };
    if (trySend()) return true;
    try {
      await this.connect();
    } catch {
      return false;
    }
    return trySend();
  }

  close(): void {
    this.intentionalClose = true;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  get reconnectDelayMs(): number {
    return this.reconnectDelay;
  }

  private async openOnce(): Promise<void> {
    const token = await this.opts.getToken();
    if (!token) throw new Error('No token');
    const client = this.opts.client ?? WS_CLIENT_TYPE;
    const url = buildStreamUrl(this.opts.baseUrl, token, client, this.opts.localCapable);
    this.opts.debug?.(`ws connect ${url.replace(token, '***')}`);

    const wasReconnect = this.consecutiveFailures > 0 || this.ws != null;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // ignore
      }
    }

    await new Promise<void>((resolve, reject) => {
      const ws = new this.WSImpl(url);
      this.ws = ws;
      let settled = false;

      ws.on('open', () => {
        this.reconnectDelay = this.reconnectInitialMs;
        this.consecutiveFailures = 0;
        this.lastServerMessageAt = Date.now();
        this.startHeartbeat();
        for (const sid of this.subscribed) {
          this.send({ type: 'subscribe', sessionId: sid });
        }
        if (wasReconnect) this.onReconnectCb?.();
        settled = true;
        resolve();
      });

      ws.on('message', (raw) => {
        this.lastServerMessageAt = Date.now();
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        let msg: WsEvent;
        try {
          msg = JSON.parse(text) as WsEvent;
        } catch {
          return;
        }
        this.opts.debug?.('ws recv', msg);
        for (const h of this.handlers) {
          try {
            h(msg);
          } catch (e) {
            this.opts.debug?.('ws handler error', e);
          }
        }
      });

      ws.on('close', (code, reason) => {
        this.stopHeartbeat();
        this.opts.debug?.(`ws close ${code} ${reason?.toString() ?? ''}`);
        if (!settled) {
          settled = true;
          reject(new Error(`WebSocket connection failed (${code})`));
          return;
        }
        if (!this.intentionalClose) this.scheduleReconnect();
      });

      ws.on('error', (err) => {
        this.opts.debug?.('ws error', err);
        if (!settled) {
          settled = true;
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      });
    });
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== this.WSImpl.OPEN) return;
      if (Date.now() - this.lastServerMessageAt > this.silenceTimeoutMs) {
        this.opts.debug?.('ws silence timeout, closing to reconnect');
        try {
          this.ws.close();
        } catch {
          // ignore
        }
        return;
      }
      this.send({ type: 'ping' });
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= 5) {
      this.opts.onConsecutiveReconnectFailures?.(this.consecutiveFailures);
    }
    const delay = this.reconnectDelay;
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect().catch(() => {
        this.scheduleReconnect();
      });
    }, delay);
  }
}
