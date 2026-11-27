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
    subscribe: vi.fn(),
    getClientType: vi.fn(() => 'browser'),
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

  it('subscribeReplaysOngoingLiveStateForReconnectingClients', async () => {
    const { handler, registry } = buildHandler();
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));

    // runner 直播中：started + 一帧（pageUrl 随帧更新，重放取最新地址）
    const runner = runnerSocket('r1');
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_started',
      data: { width: 1280, height: 720, pageUrl: 'https://example.com/a', cliSession: 'ui2' },
    }));
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_frame',
      data: { seq: 1, ts: 1, jpeg: 'Zg==', width: 1280, height: 720, pageUrl: 'https://example.com/b', cliSession: 'ui2' },
    }));

    const userSocket = runnerSocket('user-1');
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();

    // 刷新页面后的 subscribe：重放 started（replay 标记 + 最新 pageUrl），chip / 画中画可恢复
    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToConnection).toHaveBeenCalledWith(userSocket, expect.objectContaining({
      type: 'browser_live_started',
      sessionId: 11,
      data: expect.objectContaining({
        replay: true,
        width: 1280,
        height: 720,
        pageUrl: 'https://example.com/b',
        cliSession: 'ui2',
      }),
    }));

    // stopped 之后不再重放：已结束的直播不能被刷新复活成「直播中」
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_stopped', data: { reason: 'browser_exit' },
    }));
    registry.sendToConnection.mockClear();
    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToConnection).not.toHaveBeenCalled();
  });

  it('frame 的空串 pageUrl / cliSession 也写入重放缓存', async () => {
    const { handler, registry } = buildHandler();
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));

    const runner = runnerSocket('r1');
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_started',
      data: { width: 800, height: 600, pageUrl: 'https://example.com/a', cliSession: 'ui2' },
    }));
    // 帧上报空串（如页面暂无 URL）：缓存要与 started 的落值口径一致，更新为最新空值，
    // 不能因为 falsy 判断继续沿用旧地址
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_frame',
      data: { seq: 1, ts: 1, jpeg: 'Zg==', width: 800, height: 600, pageUrl: '', cliSession: '' },
    }));

    const userSocket = runnerSocket('user-1');
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();

    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToConnection).toHaveBeenCalledWith(userSocket, expect.objectContaining({
      type: 'browser_live_started',
      sessionId: 11,
      data: expect.objectContaining({ replay: true, pageUrl: '', cliSession: '' }),
    }));
  });

  it('notifyRunnerStopKeepsReplayStateUntilStoppedArrives', async () => {
    // 终态收尾只转发 stop：Browser.close 生效（stopped 回执）前浏览器仍在跑，
    // 并发的订阅 / 刷新仍应能重放直播态
    const { handler, registry } = buildHandler({ getSession: vi.fn(async () => session({ phase: 'RUNNING' })) });
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));

    const runner = runnerSocket('r1');
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_started',
      data: { width: 800, height: 600, pageUrl: 'https://example.com/', cliSession: 'ui2' },
    }));

    (handler as unknown as { notifyRunnerStop(sessionId: number): void }).notifyRunnerStop(11);

    const userSocket = runnerSocket('user-1');
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();

    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToConnection).toHaveBeenCalledWith(userSocket, expect.objectContaining({
      type: 'browser_live_started',
      sessionId: 11,
      data: expect.objectContaining({ replay: true, pageUrl: 'https://example.com/' }),
    }));

    // stopped 回执到达后才清理，后续订阅不再重放
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_stopped', data: { reason: 'session_end' },
    }));
    registry.sendToConnection.mockClear();
    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToConnection).not.toHaveBeenCalled();
  });

  it('subscribeReplaySkippedForTerminalSessionEvenIfStateLingers', async () => {
    // stopped 晚到 / 丢失时缓存可能还在：终态会话按相位兜底，不能重放成「直播中」
    let phase = 'RUNNING';
    const getSession = vi.fn(async () => session({ phase }));
    const { handler, registry } = buildHandler({ getSession });
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));

    const runner = runnerSocket('r1');
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_started', data: { width: 800, height: 600, pageUrl: 'https://example.com/' },
    }));

    phase = 'COMPLETED';

    const userSocket = runnerSocket('user-1');
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();

    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await flushMicrotasks();
    expect(registry.sendToConnection).not.toHaveBeenCalled();
  });

  it('subscribeReplaySkipsClientTypesWithoutLiveView', async () => {
    const { handler, registry } = buildHandler();
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
    registry.getClientType.mockReturnValue('cli');

    const runner = runnerSocket('r1');
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_started', data: { width: 800, height: 600, pageUrl: 'https://example.com/' },
    }));

    const userSocket = runnerSocket('user-1');
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();

    await handler.processTextMessage(userSocket, JSON.stringify({ type: 'subscribe', sessionId: 11 }));
    await flushMicrotasks();
    // 终端 CLI 等无直播界面的连接不重放（避免无意义帧与未知事件）
    expect(registry.sendToConnection).not.toHaveBeenCalled();
  });
});
