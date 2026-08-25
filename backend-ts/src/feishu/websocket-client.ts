import type { FeishuWebSocket, FeishuWebSocketFactory } from './types.js';

export interface FeishuWebSocketRuntime {
  connect(): FeishuWebSocket;
  disconnect(): void;
  isConnected(): boolean;
}

export function createFeishuWebSocketRuntime(endpoint: string, factory: FeishuWebSocketFactory): FeishuWebSocketRuntime {
  let socket: FeishuWebSocket | null = null;
  return {
    connect() { if (socket == null) socket = factory(endpoint); return socket; },
    disconnect() { socket?.close(1000, 'shutdown'); socket = null; },
    isConnected() { return socket != null; },
  };
}

export function createWsWebSocketFactory(WebSocketImpl: new (url: string) => FeishuWebSocket): FeishuWebSocketFactory {
  return (endpoint) => new WebSocketImpl(endpoint);
}
