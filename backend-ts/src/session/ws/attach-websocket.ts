import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { StreamingWsHandler } from './streaming-ws-handler.js';
import type { WsSocket } from './streaming-ws-registry.js';
import { WS_OPEN } from './streaming-ws-registry.js';
import type { TerminalSocket, TerminalWsHandler } from '../../harness/terminal/terminal-ws-handler.js';
import type { TerminalHostHandler } from '../../harness/terminal/terminal-host-handler.js';
import { HOST_FRAME_MAX_BYTES } from '../../harness/terminal/local-terminal-relay.js';
import { resolveIp } from '../../audit/audit.interceptor.js';

export interface AttachWebSocketDeps {
  handler: StreamingWsHandler;
  idleTimeoutMs?: number;
  terminalHandler: TerminalWsHandler;
  terminalIdleTimeoutMs?: number;
  /** 终端主机通道（技术方案 2026-11-18 §4.5）：Electron 主进程 / mao-agent 的 PTY 连接。 */
  terminalHostHandler?: TerminalHostHandler;
  terminalHostIdleTimeoutMs?: number;
}

export async function attachWebSocket(app: FastifyInstance, deps: AttachWebSocketDeps): Promise<void> {
  await app.register(websocket, {
    options: {
      maxPayload: 1024 * 1024,
    },
  });
  const idleTimeoutMs = deps.idleTimeoutMs ?? 90_000;
  const terminalIdleTimeoutMs = deps.terminalIdleTimeoutMs ?? 90_000;
  const terminalHostIdleTimeoutMs = deps.terminalHostIdleTimeoutMs ?? 90_000;

  app.get('/ws/stream', { websocket: true }, (socket) => {
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
    socket.on('message', (raw: Buffer | string) => {
      lastActivity = Date.now();
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      // 处理顺序由 handler 内部按连接串行保证（首帧 auth 含异步查库），这里不 await 以免阻塞收包
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

  // 云端终端通道：必须与 /ws/stream 同 scope 且在 register(websocket) 之后声明
  // （@fastify/websocket 是 fastify-plugin 包装，二次 register 会 FST_ERR_DEC_ALREADY_PRESENT）。
  app.get('/ws/terminal', { websocket: true }, (socket, request) => {
    const ip = resolveIp(request.headers as Record<string, string | string[] | undefined>, request.ip) ?? null;
    const wrapped: TerminalSocket = {
      id: `term-ws-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      get readyState() { return socket.readyState === socket.OPEN ? WS_OPEN : socket.readyState; },
      get bufferedAmount() { return socket.bufferedAmount ?? 0; },
      ip,
      send(data: string) { socket.send(data); },
      close(code?: number, reason?: string) { socket.close(code, reason); },
    };
    let lastActivity = Date.now();
    const idleTimer = setInterval(() => {
      if (Date.now() - lastActivity > terminalIdleTimeoutMs) {
        socket.close(1001, 'idle timeout');
      }
    }, 15_000);
    socket.on('message', (raw: Buffer | string) => {
      lastActivity = Date.now();
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      void deps.terminalHandler.handleTextMessage(wrapped, text);
    });
    socket.on('close', () => {
      clearInterval(idleTimer);
      deps.terminalHandler.afterConnectionClosed(wrapped);
    });
    socket.on('error', () => {
      clearInterval(idleTimer);
      deps.terminalHandler.handleTransportError(wrapped);
    });
    socket.on('pong', () => { lastActivity = Date.now(); });
  });

  // 终端主机通道：PTY 跑在绑定设备的 Electron 主进程 / mao-agent 进程上，服务器只登记转发。
  // 与另外两条路由同 scope；空闲 90 秒（主机每 10 秒 ping 刷新）。
  if (deps.terminalHostHandler != null) {
    const hostHandler = deps.terminalHostHandler;
    app.get('/ws/terminal-host', { websocket: true }, (socket) => {
      const wrapped: TerminalSocket = {
        id: `term-host-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        get readyState() { return socket.readyState === socket.OPEN ? WS_OPEN : socket.readyState; },
        get bufferedAmount() { return socket.bufferedAmount ?? 0; },
        send(data: string) { socket.send(data); },
        close(code?: number, reason?: string) { socket.close(code, reason); },
      };
      let lastActivity = Date.now();
      const idleTimer = setInterval(() => {
        if (Date.now() - lastActivity > terminalHostIdleTimeoutMs) {
          socket.close(1001, 'idle timeout');
        }
      }, 15_000);
      socket.on('message', (raw: Buffer | string) => {
        lastActivity = Date.now();
        // 单帧上限 256KB（低于本路由 1MB 传输上限）：超限直接按主机断开处理（§4.5），
        // 避免一个异常帧拆掉连接后状态不清
        const size = typeof raw === 'string' ? Buffer.byteLength(raw, 'utf8') : raw.length;
        if (size > HOST_FRAME_MAX_BYTES) {
          socket.close(1009, 'frame too large');
          return;
        }
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        void hostHandler.handleTextMessage(wrapped, text);
      });
      socket.on('close', () => {
        clearInterval(idleTimer);
        hostHandler.afterConnectionClosed(wrapped);
      });
      socket.on('error', () => {
        clearInterval(idleTimer);
        hostHandler.handleTransportError(wrapped);
      });
      socket.on('pong', () => { lastActivity = Date.now(); });
    });
  }
}
