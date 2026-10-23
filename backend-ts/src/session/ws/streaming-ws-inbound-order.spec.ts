import { describe, it, expect, vi } from 'vitest';
import { StreamingWsHandler } from './streaming-ws-handler.js';
import { WS_OPEN, type WsSocket } from './streaming-ws-registry.js';

/**
 * 回归：首帧 auth 的账号状态校验是异步查库，客户端在 onopen 里同一 tick 连发
 * auth + subscribe。鉴权窗口内的后续帧若并发处理，subscribe 会看到「尚未 register」
 * 的连接并被按未认证 1003 关闭，客户端随即进入无限重连（线上重连风暴的根因）。
 */
describe('StreamingWsHandler auth-window serialization', () => {
  function build(accountCheck: () => Promise<boolean>) {
    const userIds = new Map<string, number>();
    const register = vi.fn((socket: WsSocket, userId: number) => { userIds.set(socket.id, userId); });
    const subscribe = vi.fn();
    const send = vi.fn();
    const closeConnection = vi.fn((socket: WsSocket, reason: string) => socket.close(1003, reason));

    const registry = {
      isConnectionAuthorized: () => true,
      getUserId: (socket: WsSocket) => userIds.get(socket.id) ?? null,
      closeConnection,
      register,
      subscribe,
      send,
      sendToConnection: vi.fn(),
      getClientType: () => 'electron',
      getSessionExecution: () => undefined,
    };

    const handler = new StreamingWsHandler({
      registry,
      // 只走 auth 数据帧路径：验签通过，账号状态查询由调用方控制
      jwtService: {
        getAccessTokenMetadata: () => ({ userId: 7, expiresAt: Date.now() + 60_000 }),
        getTokenType: () => 'access',
      },
      accountStatusChecker: accountCheck,
      sessionService: {
        getSession: async () => ({ id: 11, userId: 7, executionMode: 'CLOUD', phase: 'IDLE' }),
      },
    } as unknown as ConstructorParameters<typeof StreamingWsHandler>[0]);

    const socket: WsSocket = { id: 'ws-order', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
    return { handler, socket, register, subscribe, send, closeConnection };
  }

  it('auth 异步校验未完成时 subscribe 排队等待，不被按未认证关闭', async () => {
    let releaseAuth!: () => void;
    const authGate = new Promise<void>((resolve) => { releaseAuth = resolve; });
    const { handler, socket, register, subscribe, closeConnection } = build(async () => {
      await authGate;
      return true;
    });

    const auth = handler.handleTextMessage(socket, JSON.stringify({
      type: 'auth', token: 'token', client: 'electron',
    }));
    // 同一 tick 紧随其后到达的业务帧：入队，不并发执行
    await handler.handleTextMessage(socket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));

    expect(register).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    expect(closeConnection).not.toHaveBeenCalled();

    releaseAuth();
    await auth;

    expect(register).toHaveBeenCalledWith(socket, 7, 'electron', expect.anything(), true);
    expect(subscribe).toHaveBeenCalledWith(7, 11);
    expect(closeConnection).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('鉴权完成后新到达的帧立即处理，不进入排队', async () => {
    const { handler, socket, subscribe, closeConnection } = build(async () => true);

    await handler.handleTextMessage(socket, JSON.stringify({ type: 'auth', token: 'token', client: 'electron' }));
    await handler.handleTextMessage(socket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));

    expect(subscribe).toHaveBeenCalledWith(7, 11);
    expect(closeConnection).not.toHaveBeenCalled();
  });
});
