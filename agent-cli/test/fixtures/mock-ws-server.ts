import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';

export interface MockWsServer {
  url: string;
  httpBase: string;
  port: number;
  received: unknown[];
  clients: Set<WebSocket>;
  send(obj: unknown): void;
  drop(): void;
  close(): Promise<void>;
}

export async function startMockWsServer(): Promise<MockWsServer> {
  const http = createServer();
  const wss = new WebSocketServer({ server: http, path: '/ws/stream' });
  const received: unknown[] = [];
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('message', (raw) => {
      try {
        received.push(JSON.parse(raw.toString('utf8')));
      } catch {
        received.push(raw.toString('utf8'));
      }
    });
    ws.on('close', () => clients.delete(ws));
    ws.send(JSON.stringify({ type: 'connected', sessionId: null, data: { userId: 1 } }));
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as AddressInfo).port;

  return {
    url: `ws://127.0.0.1:${port}/ws/stream`,
    httpBase: `http://127.0.0.1:${port}`,
    port,
    received,
    clients,
    send(obj: unknown) {
      const json = JSON.stringify(obj);
      for (const c of clients) {
        if (c.readyState === c.OPEN) c.send(json);
      }
    },
    drop() {
      for (const c of [...clients]) {
        c.close();
      }
    },
    async close() {
      for (const c of [...clients]) {
        try { c.close(); } catch { /* ignore */ }
      }
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve, reject) => http.close((err) => (err ? reject(err) : resolve())));
    },
  };
}
