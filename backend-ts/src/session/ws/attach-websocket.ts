import type { FastifyInstance, FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import type { StreamingWsHandler } from './streaming-ws-handler.js';
import type { WsSocket } from './streaming-ws-registry.js';
import { WS_OPEN } from './streaming-ws-registry.js';

export interface AttachWebSocketDeps {
  handler: StreamingWsHandler;
  idleTimeoutMs?: number;
}

export async function attachWebSocket(app: FastifyInstance, deps: AttachWebSocketDeps): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
    },
  });
  const idleTimeoutMs = deps.idleTimeoutMs ?? 90_000;

  app.get('/ws/stream', { websocket: true }, (socket, request: FastifyRequest) => {
    const query = request.query as Record<string, string>;
    const wrapped: WsSocket = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      get readyState() { return socket.readyState === socket.OPEN ? WS_OPEN : socket.readyState; },
      send(data: string) { socket.send(data); },
      close(code?: number, reason?: string) { socket.close(code, reason); },
    };
    let lastActivity = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > idleTimeoutMs) {
        socket.close(1001, 'idle timeout');
      }
    }, 15_000);
    void deps.handler.afterConnectionEstablished(wrapped, query);
    socket.on('message', (raw: Buffer | string) => {
      lastActivity = Date.now();
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      void deps.handler.handleTextMessage(wrapped, text);
    });
    socket.on('close', () => {
      clearInterval(idleTimer);
      deps.handler.afterConnectionClosed(wrapped);
    });
    socket.on('error', () => {
      clearInterval(idleTimer);
      deps.handler.handleTransportError(wrapped);
    });
    socket.on('pong', () => { lastActivity = Date.now(); });
  });
}
