import { describe, expect, it, vi, beforeEach } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from './streaming-ws-handler.js';
import type { Session } from '../../domain/types.js';
import type { WsSocket } from './streaming-ws-registry.js';
import { WS_OPEN } from './streaming-ws-registry.js';
import { JwtService } from '../../crypto/jwt.service.js';

/**
 * 浏览器直播 runner 接入（方案 2026-11-20 v2 §4.2 / D9）：
 * runner_auth 握手校验矩阵、帧转发与限速、停止下行、断开兜底合成 stopped。
 */

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 11, userId: 7, agentId: 5, executionMode: 'CLOUD', phase: 'IDLE',
    permissionLevel: 'READ_ONLY', status: 'ACTIVE',
    ...overrides,
  } as Session;
}

function runnerSocket(id: string): WsSocket {
  return { id, readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
}

function buildHandler(overrides: {
  getSession?: ReturnType<typeof vi.fn>;
} = {}) {
  const getSession = overrides.getSession ?? vi.fn(async () => session());
  const registry = {
    isConnectionAuthorized: vi.fn(() => true),
    getUserId: vi.fn(() => null),
    closeConnection: vi.fn(),
    sendToConnection: vi.fn(),
    sendToClientTypes: vi.fn(),
    send: vi.fn(),
    register: vi.fn(),
    unregister: vi.fn(),
    getDeviceId: vi.fn(() => null),
    getDeviceInfo: vi.fn(() => null),
    failAllForSocket: vi.fn(),
  };
  const deps = {
    registry,
    sessionService: { getSession },
    jwtService: new JwtService('runner-spec-secret', 3_600_000, 86_400_000, 7_200_000),
    taskTerminalService: { finishExecution: vi.fn(async () => undefined) },
  } as unknown as WsHandlerDeps;
  const handler = new StreamingWsHandler(deps);
  return { handler, registry, getSession };
}

async function flushMicrotasks(): Promise<void> {
  // 只冲微任务队列：不碰 setImmediate——fake timers（限速用例）会把它打桩挂起
  await Promise.resolve();
  await Promise.resolve();
}

describe('StreamingWsHandler runner (browser live)', () => {
  let jwt: JwtService;
  beforeEach(() => {
    jwt = new JwtService('runner-spec-secret', 3_600_000, 86_400_000, 7_200_000);
  });

  it('runnerAuthBindsRunnerForOwnedCloudSession', async () => {
    const { handler, registry } = buildHandler();
    const socket = runnerSocket('r1');
    await handler.processTextMessage(socket, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    expect(registry.closeConnection).not.toHaveBeenCalled();
    expect(registry.sendToConnection).toHaveBeenCalledWith(socket, expect.objectContaining({
      type: 'connected', sessionId: 11, data: { runner: true },
    }));
  });

  it('runnerAuthRejectsAccessTokenAndInvalidToken', async () => {
    const { handler, registry } = buildHandler();
    // access token 不能伪装 runner：直播 token 必须是 shell 短效 JWT
    await handler.processTextMessage(runnerSocket('r1'), JSON.stringify({
      type: 'runner_auth', token: jwt.generateToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    expect(registry.closeConnection).toHaveBeenCalledWith(expect.anything(), 'Runner token must be a shell token');

    await handler.processTextMessage(runnerSocket('r2'), JSON.stringify({
      type: 'runner_auth', token: 'not-a-jwt', sessionId: 11,
    }));
    await flushMicrotasks();
    expect(registry.closeConnection).toHaveBeenCalledWith(expect.anything(), 'Invalid runner token');
  });

  it('runnerAuthRejectsForeignSessionAndLocalMode', async () => {
    const foreign = buildHandler({ getSession: vi.fn(async () => session({ userId: 8 })) });
    await foreign.handler.processTextMessage(runnerSocket('r1'), JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    expect(foreign.registry.closeConnection).toHaveBeenCalledWith(expect.anything(), 'Runner session not owned');

    const local = buildHandler({ getSession: vi.fn(async () => session({ executionMode: 'LOCAL' })) });
    await local.handler.processTextMessage(runnerSocket('r2'), JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    expect(local.registry.closeConnection).toHaveBeenCalledWith(expect.anything(), 'Runner only for CLOUD sessions');
  });

  it('runnerAuthReplacementKicksPreviousConnection', async () => {
    const { handler, registry } = buildHandler();
    const first = runnerSocket('r1');
    const second = runnerSocket('r2');
    const token = jwt.generateShellToken(7, 'alice');
    await handler.processTextMessage(first, JSON.stringify({ type: 'runner_auth', token, sessionId: 11 }));
    await flushMicrotasks();
    await handler.processTextMessage(second, JSON.stringify({ type: 'runner_auth', token, sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.closeConnection).toHaveBeenCalledWith(first, 'Replaced by new runner');
    expect(registry.sendToConnection).toHaveBeenLastCalledWith(second, expect.objectContaining({ type: 'connected' }));
  });

  it('forwardsFramesToElectronBrowserAndAndroid', async () => {
    const { handler, registry } = buildHandler();
    const socket = runnerSocket('r1');
    await handler.processTextMessage(socket, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    registry.sendToClientTypes.mockClear();

    await handler.processTextMessage(socket, JSON.stringify({
      type: 'browser_frame', data: { seq: 1, ts: 1, jpeg: 'xx', width: 1280, height: 720 },
    }));
    expect(registry.sendToClientTypes).toHaveBeenCalledWith(
      7, expect.objectContaining({ type: 'browser_frame', sessionId: 11 }),
      expect.objectContaining({ has: expect.any(Function) }),
    );
    const clientTypes = registry.sendToClientTypes.mock.calls[0][2] as Set<string>;
    // 三端观看矩阵：electron（画中画/Tab）+ browser（Web Tab）+ android（WebView 内同构 Web 链路）
    expect(clientTypes.has('electron')).toBe(true);
    expect(clientTypes.has('browser')).toBe(true);
    expect(clientTypes.has('android')).toBe(true);
  });

  it('rateLimitsBrowserFramesPerSession', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { handler, registry } = buildHandler();
      const socket = runnerSocket('r1');
      await handler.processTextMessage(socket, JSON.stringify({
        type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
      }));
      await flushMicrotasks();
      registry.sendToClientTypes.mockClear();

      // 突发 12 帧全过（burst=12），第 13 帧同毫秒内被限速丢弃
      for (let i = 0; i < 12; i++) {
        await handler.processTextMessage(socket, JSON.stringify({
          type: 'browser_frame', data: { seq: i, jpeg: 'x' },
        }));
      }
      expect(registry.sendToClientTypes).toHaveBeenCalledTimes(12);
      await handler.processTextMessage(socket, JSON.stringify({
        type: 'browser_frame', data: { seq: 99, jpeg: 'x' },
      }));
      expect(registry.sendToClientTypes).toHaveBeenCalledTimes(12);
      // 时间推进 250ms（rate 6/s → 补 1.5 个令牌）后恢复
      vi.setSystemTime(1_000_250);
      await handler.processTextMessage(socket, JSON.stringify({
        type: 'browser_frame', data: { seq: 100, jpeg: 'x' },
      }));
      expect(registry.sendToClientTypes).toHaveBeenCalledTimes(13);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disconnectWithoutStoppedSynthesizesRunnerExit', async () => {
    const { handler, registry } = buildHandler();
    const socket = runnerSocket('r1');
    await handler.processTextMessage(socket, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    registry.sendToClientTypes.mockClear();

    handler.afterConnectionClosed(socket);
    expect(registry.sendToClientTypes).toHaveBeenCalledWith(
      7, expect.objectContaining({
        type: 'browser_live_stopped', sessionId: 11, data: { reason: 'runner_exit' },
      }), expect.anything(),
    );
    // 断开后再来的帧不再转发（连接未注册）
    await handler.processTextMessage(socket, JSON.stringify({ type: 'browser_frame', data: { seq: 1 } }));
    expect(registry.sendToClientTypes).toHaveBeenCalledTimes(1);
  });

  it('sidecarStoppedSuppressesSyntheticRunnerExitOnDisconnect', async () => {
    const { handler, registry } = buildHandler();
    const socket = runnerSocket('r1');
    await handler.processTextMessage(socket, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    registry.sendToClientTypes.mockClear();

    await handler.processTextMessage(socket, JSON.stringify({
      type: 'browser_live_stopped', data: { reason: 'browser_exit' },
    }));
    expect(registry.sendToClientTypes).toHaveBeenCalledTimes(1);
    handler.afterConnectionClosed(socket);
    // sidecar 已发过 stopped：断开不再合成 runner_exit，客户端不收重复收窗
    expect(registry.sendToClientTypes).toHaveBeenCalledTimes(1);
  });

  it('userBrowserLiveStopIsForwardedToRunner', async () => {
    const { handler, registry } = buildHandler();
    // 同一 handler 实例：runner 连接（getUserId 为 null）+ 用户连接（auth 后注册）
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
    const runner = runnerSocket('r1');
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();

    const userSocket = runnerSocket('user-1');
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();
    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'browser_live_stop', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToConnection).toHaveBeenCalledWith(runner, { type: 'browser_live_stop', data: { reason: 'user_stop' } });
  });

  it('browserLiveStopWithoutRunnerAnswersStoppedDirectly', async () => {
    const { handler, registry } = buildHandler();
    registry.getUserId.mockReturnValue(7);
    const socket = runnerSocket('user-1');
    await handler.processTextMessage(socket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToClientTypes.mockClear();
    await handler.processTextMessage(socket, JSON.stringify({ type: 'browser_live_stop', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToClientTypes).toHaveBeenCalledWith(
      7, expect.objectContaining({
        type: 'browser_live_stopped', sessionId: 11, data: { reason: 'user_stop' },
      }), expect.anything(),
    );
  });

  it('sessionTerminalNotifiesRunnerStopWithSessionEndReason', async () => {
    const { handler, registry } = buildHandler();
    const socket = runnerSocket('r1');
    await handler.processTextMessage(socket, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();

    // 终态钩子在三个 finisher 中调用；这里直接驱动私有方法验证下行帧形状
    (handler as unknown as { notifyRunnerStop(sessionId: number): void }).notifyRunnerStop(11);
    expect(registry.sendToConnection).toHaveBeenCalledWith(socket, {
      type: 'browser_live_stop', data: { reason: 'session_end' },
    });
  });
});
