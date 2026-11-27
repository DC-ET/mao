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

describe('StreamingWsHandler browser live 协作输入（方案 2026-11-27 §6）', () => {
  let jwt: JwtService;
  beforeEach(() => {
    jwt = new JwtService('runner-spec-secret', 3_600_000, 86_400_000, 7_200_000);
  });

  /** runner + 已鉴权用户连接就绪；返回两枚 socket。 */
  async function setup(handler: ReturnType<typeof buildHandler>['handler']) {
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
    return { runner, userSocket };
  }

  const validBatch = {
    targetId: 'T1',
    events: [
      { type: 'mousePressed', x: 10, y: 20, button: 'left' as const, clickCount: 1, modifiers: 2 },
      { type: 'mouseWheel', x: 10, y: 20, deltaX: 0, deltaY: -120 },
      { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 },
      { type: 'char', text: 'a' },
      { type: 'insertText', text: '你好' },
    ],
  };

  it('属主协作输入原样转发 runner（规整字段，不透传客户端多余字段）', async () => {
    const { handler, registry } = buildHandler();
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
    const { runner, userSocket } = await setup(handler);
    registry.sendToConnection.mockClear();

    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'browser_live_input', sessionId: 11,
      data: { ...validBatch, extraField: 'should-not-relay' },
    }));
    await flushMicrotasks();
    expect(registry.sendToConnection).toHaveBeenCalledWith(runner, {
      type: 'browser_live_input',
      data: { targetId: 'T1', events: validBatch.events },
    });
  });

  it('非属主 / 不存在的会话：静默丢弃，不回错误帧、不转发', async () => {
    const foreign = buildHandler({ getSession: vi.fn(async () => session({ userId: 8 })) });
    foreign.registry.getUserId.mockReturnValue(7);
    const { userSocket } = await setup(foreign.handler);
    foreign.registry.sendToConnection.mockClear();
    foreign.registry.send.mockClear();

    await foreign.handler.processTextMessage(userSocket, JSON.stringify({
      type: 'browser_live_input', sessionId: 11, data: validBatch,
    }));
    await flushMicrotasks();
    // 非属主：无转发、无 error 帧（D9：高频输入静默丢弃，不能每批回错刷屏）
    expect(foreign.registry.sendToConnection).not.toHaveBeenCalled();
    expect(foreign.registry.send).not.toHaveBeenCalled();

    const missing = buildHandler({ getSession: vi.fn(async () => null) });
    missing.registry.getUserId.mockReturnValue(7);
    const { userSocket: missingUser } = await setup(missing.handler);
    await missing.handler.processTextMessage(missingUser, JSON.stringify({
      type: 'browser_live_input', sessionId: 11, data: validBatch,
    }));
    await flushMicrotasks();
    expect(missing.registry.sendToConnection).not.toHaveBeenCalled();
    expect(missing.registry.send).not.toHaveBeenCalled();
  });

  it('属主校验 60s 缓存命中免查库（D9），非法批不触发任何查库/转发', async () => {
    const { handler, registry, getSession } = buildHandler();
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
    const { userSocket } = await setup(handler);

    for (let i = 0; i < 5; i++) {
      await handler.processTextMessage(userSocket, JSON.stringify({
        type: 'browser_live_input', sessionId: 11, data: { targetId: null, events: [{ type: 'mouseMoved', x: 1, y: 2 }] },
      }));
      await flushMicrotasks();
    }
    // 基线 1 次来自 runner_auth 握手：输入侧只查 1 次库，后续 4 批全部命中缓存
    expect(getSession).toHaveBeenCalledTimes(2, '缓存命中后不再查库');

    // 非法批：整批静默丢弃（坐标 NaN / 未知类型 / 空事件 / 超限）
    for (const bad of [
      { events: [{ type: 'mouseMoved', x: NaN, y: 1 }] },
      { events: [{ type: 'teleport', x: 1, y: 1 }] },
      { events: [] },
      { events: Array.from({ length: 33 }, () => ({ type: 'mouseMoved', x: 1, y: 1 })) },
      { targetId: 123, events: [{ type: 'char', text: 'a' }] },
      null,
    ]) {
      await handler.processTextMessage(userSocket, JSON.stringify({
        type: 'browser_live_input', sessionId: 11, data: bad,
      }));
      await flushMicrotasks();
    }
    expect(getSession).toHaveBeenCalledTimes(2, '非法批在属主校验前就被丢弃');
  });

  it('按会话事件数限速（60/s burst 180）：超限批静默丢弃、时间推进恢复', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { handler, registry } = buildHandler();
      registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
      const { userSocket } = await setup(handler);
      registry.sendToConnection.mockClear();

      const batch32 = { targetId: null, events: Array.from({ length: 32 }, (_, i) => ({ type: 'mouseMoved' as const, x: i, y: i })) };
      // burst 180：前 5 批（160 事件）转发；第 6 批需 32 令牌只剩 20 → 整批丢弃
      for (let i = 0; i < 5; i++) {
        await handler.processTextMessage(userSocket, JSON.stringify({ type: 'browser_live_input', sessionId: 11, data: batch32 }));
      }
      await handler.processTextMessage(userSocket, JSON.stringify({ type: 'browser_live_input', sessionId: 11, data: batch32 }));
      await flushMicrotasks();
      expect(registry.sendToConnection).toHaveBeenCalledTimes(5);

      // 时间推进 2s（补 120 令牌）恢复：限速高于客户端自限 50/s，合法速率不丢批（评审 P2-3）
      vi.setSystemTime(1_002_000);
      await handler.processTextMessage(userSocket, JSON.stringify({ type: 'browser_live_input', sessionId: 11, data: batch32 }));
      await flushMicrotasks();
      expect(registry.sendToConnection).toHaveBeenCalledTimes(6);
    } finally {
      vi.useRealTimers();
    }
  });

  it('无 runner 时输入被忽略（会话无浏览器直播）', async () => {
    const { handler, registry } = buildHandler();
    registry.getUserId.mockReturnValue(7);
    const userSocket = runnerSocket('user-1');
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'auth', token: jwt.generateToken(7, 'alice'),
    }));
    await flushMicrotasks();
    registry.sendToConnection.mockClear();

    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'browser_live_input', sessionId: 11, data: validBatch,
    }));
    await flushMicrotasks();
    expect(registry.sendToConnection).not.toHaveBeenCalled();
  });

  it('输入活跃窗口内帧限速放宽 (12,24)，窗口外回落基础 (6,12)（D5）', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { handler, registry } = buildHandler();
      registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
      const { runner, userSocket } = await setup(handler);

      // 先发一帧（消耗基础桶 1 令牌），再发输入 → 激活 5s 提升窗口
      await handler.processTextMessage(runner, JSON.stringify({
        type: 'browser_frame', data: { seq: 0, jpeg: 'x' },
      }));
      await handler.processTextMessage(userSocket, JSON.stringify({
        type: 'browser_live_input', sessionId: 11, data: validBatch,
      }));
      await flushMicrotasks();
      registry.sendToClientTypes.mockClear();

      // 窗口内连发 20 帧全部转发（提升桶 burst 24；基础桶 burst 12 只能过 11）
      for (let i = 1; i <= 20; i++) {
        await handler.processTextMessage(runner, JSON.stringify({
          type: 'browser_frame', data: { seq: i, jpeg: 'x' },
        }));
      }
      expect(registry.sendToClientTypes).toHaveBeenCalledTimes(20);

      // 窗口外（+6s）回落基础桶：同毫秒只能过 12 帧（burst 12）
      vi.setSystemTime(1_006_000);
      registry.sendToClientTypes.mockClear();
      for (let i = 100; i <= 115; i++) {
        await handler.processTextMessage(runner, JSON.stringify({
          type: 'browser_frame', data: { seq: i, jpeg: 'x' },
        }));
      }
      expect(registry.sendToClientTypes).toHaveBeenCalledTimes(12);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runner 断开清理输入限速桶 / 活跃窗口 / 属主缓存（方案 §6 清理口径）', async () => {
    const { handler, registry, getSession } = buildHandler();
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
    const { runner, userSocket } = await setup(handler);

    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'browser_live_input', sessionId: 11, data: validBatch,
    }));
    await flushMicrotasks();
    // 基线 1 次来自 runner_auth：首次输入查库 1 次
    expect(getSession).toHaveBeenCalledTimes(2);

    handler.afterConnectionClosed(runner);

    // 缓存已清：下一次输入重新查库（runner 已断，转发为 no-op，但查库计数回升）
    await handler.processTextMessage(userSocket, JSON.stringify({
      type: 'browser_live_input', sessionId: 11, data: validBatch,
    }));
    await flushMicrotasks();
    expect(getSession).toHaveBeenCalledTimes(3);
  });

  it('属主缓存 60s TTL 过期后重新查库（D9）', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const { handler, registry, getSession } = buildHandler();
      registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));
      const { userSocket } = await setup(handler);

      await handler.processTextMessage(userSocket, JSON.stringify({
        type: 'browser_live_input', sessionId: 11, data: validBatch,
      }));
      await flushMicrotasks();
      expect(getSession).toHaveBeenCalledTimes(2); // runner_auth 1 + 首次输入 1

      // TTL 窗口内（+50s）：命中缓存不再查库
      vi.setSystemTime(1_050_000);
      await handler.processTextMessage(userSocket, JSON.stringify({
        type: 'browser_live_input', sessionId: 11, data: validBatch,
      }));
      await flushMicrotasks();
      expect(getSession).toHaveBeenCalledTimes(2);

      // 越过 60s（+61s）：缓存过期，重新查库
      vi.setSystemTime(1_061_000);
      await handler.processTextMessage(userSocket, JSON.stringify({
        type: 'browser_live_input', sessionId: 11, data: validBatch,
      }));
      await flushMicrotasks();
      expect(getSession).toHaveBeenCalledTimes(3);
      void registry;
    } finally {
      vi.useRealTimers();
    }
  });

  it('subscribe 重放的 started 携带 control 能力标记（刷新后协作入口恢复，评审 P2-1）', async () => {
    const { handler, registry } = buildHandler();
    registry.getUserId.mockImplementation((s: { id: string }) => (s.id.startsWith('r') ? null : 7));

    const runner = runnerSocket('r1');
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'runner_auth', token: jwt.generateShellToken(7, 'alice'), sessionId: 11,
    }));
    await flushMicrotasks();
    await handler.processTextMessage(runner, JSON.stringify({
      type: 'browser_live_started',
      data: { width: 1280, height: 720, pageUrl: 'https://example.com/a', cliSession: 'ui2', control: true },
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
      data: expect.objectContaining({ replay: true, control: true }),
    }));
  });
});
