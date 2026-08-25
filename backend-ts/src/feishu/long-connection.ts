import { normalizeFeishuEvent } from './event-normalizer.js';
import type { FeishuNormalizedMessage, FeishuWebSocketFactory } from './types.js';
import { createFeishuWebSocketRuntime, type FeishuWebSocketRuntime } from './websocket-client.js';

export interface FeishuLongConnectionOptions {
  endpoint: string;
  websocketFactory: FeishuWebSocketFactory;
  onEvent: (event: FeishuNormalizedMessage) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export class FeishuLongConnection {
  private readonly runtime: FeishuWebSocketRuntime;
  constructor(private readonly options: FeishuLongConnectionOptions) {
    this.runtime = createFeishuWebSocketRuntime(options.endpoint, options.websocketFactory);
  }

  start(): void {
    const socket = this.runtime.connect();
    socket.on('message', (data: unknown) => { void this.handleMessage(data); });
    socket.on('error', (error: unknown) => this.options.onError?.(error));
  }

  stop(): void { this.runtime.disconnect(); }
  isConnected(): boolean { return this.runtime.isConnected(); }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      const raw = typeof data === 'string' || data instanceof Uint8Array ? JSON.parse(Buffer.from(data).toString('utf8')) : data;
      const event = normalizeFeishuEvent(raw);
      if (event != null) await this.options.onEvent(event);
    } catch (error) { this.options.onError?.(error); }
  }
}
