import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from './streaming-ws-registry.js';
import { wsEvent } from './ws-event.js';

function mockSocket(id: string, sendImpl?: (data: string) => void): WsSocket {
  return {
    id,
    readyState: WS_OPEN,
    send: sendImpl ?? vi.fn(),
    close: vi.fn(),
  };
}

describe('StreamingWsRegistry', () => {
  let registry: StreamingWsRegistry;

  beforeEach(() => {
    registry = new StreamingWsRegistry(10);
  });

  afterEach(() => {
    registry.shutdown();
  });

  it('reportsNoDeliveryWithoutConnections', async () => {
    const result = await registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    expect(result.successCount).toBe(0);
    expect(result.targetCount).toBe(0);
  });

  it('reportsSuccessWhenAnyOpenConnectionAcceptsMessage', async () => {
    const session = mockSocket('ws-1');
    registry.register(session, 1, 'electron');
    const result = await registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    expect(result.successCount).toBe(1);
  });

  it('tracks the current session execution id until cleared', () => {
    expect(registry.getSessionExecution(10)).toBeUndefined();
    registry.setSessionExecution(10, 'exec-1');
    expect(registry.getSessionExecution(10)).toBe('exec-1');
    registry.setSessionExecution(10, 'exec-2');
    expect(registry.getSessionExecution(10)).toBe('exec-2');
    registry.clearSessionExecution(10);
    expect(registry.getSessionExecution(10)).toBeUndefined();
  });

  it('snapshots active tool calls until completion', () => {
    registry.trackActiveToolCall(10, 'exec-1', 'call-1', 'shell', '{"command":"npm test"}');
    registry.updateActiveToolCallArguments(10, 'call-1', '{"command":"npm run test"}');

    expect(registry.getActiveToolCalls(10)).toEqual([expect.objectContaining({
      tool_call_id: 'call-1',
      arguments: '{"command":"npm run test"}',
      executionId: 'exec-1',
    })]);

    registry.completeActiveToolCall(10, 'call-1');
    expect(registry.getActiveToolCalls(10)).toEqual([]);
  });

  it('records started_at on first sighting and keeps it across argument updates', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      registry.trackActiveToolCall(10, 'exec-1', 'call-1', 'shell', '{"command":"np');
      vi.setSystemTime(1_002_000);
      // 参数增量对同一 id 再次到达：起表时刻不重置——订阅重放据此算已耗时
      registry.trackActiveToolCall(10, 'exec-1', 'call-1', 'shell', '{"command":"npm test"}');

      expect(registry.getActiveToolCalls(10)).toEqual([expect.objectContaining({ started_at: 1_000_000 })]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('sendToDeviceFamily reaches every connection sharing the device id', () => {
    // 回归（线上 session 2297）：桌面端与 mao-agent 共用 ~/.mao/agent-cli/device.json，
    // 同机两端是同一个 deviceId 但是两条独立 WS 连接。mao-agent 退出后它的连接可能
    // 仍在（半死空壳：活着但没有该会话上下文，收到请求也不回报）。只按 deviceExecutors
    // 里那一条投递就会空等到超时，因此同 deviceId 的存活连接全部纳入，桌面端可直接接手。
    const cliSend = vi.fn();
    const desktopSend = vi.fn();
    const cli = mockSocket('ws-cli', cliSend);
    const desktop = mockSocket('ws-desktop', desktopSend);
    registry.register(cli, 5, 'cli', undefined, true, { id: 'shared-device', name: 'Mac', platform: 'darwin' });
    registry.register(desktop, 5, 'electron', undefined, true, { id: 'shared-device', name: 'Mac', platform: 'darwin' });

    const result = registry.sendToDeviceFamily(5, 'shared-device', wsEvent('skill_sync_required', 10, { syncId: 's-1' }));

    expect(result.targetCount).toBe(2);
    expect(result.successCount).toBe(2);
    expect(cliSend).toHaveBeenCalled();
    expect(desktopSend).toHaveBeenCalled();
  });

  it('sendToDeviceFamily skips connections of another device and reports zero delivery when the device is offline', () => {
    // 另一台机器（Mac + Windows 各开一个桌面端）不会收到：否则它会在本地落一份用不了的
    // 技能副本，还可能抢先回报让服务端误判同步完成。
    const macSend = vi.fn();
    const otherSend = vi.fn();
    const mac = mockSocket('ws-mac', macSend);
    const other = mockSocket('ws-other', otherSend);
    registry.register(mac, 8, 'cli', undefined, true, { id: 'dev-mac', name: 'Mac', platform: 'darwin' });
    registry.register(other, 8, 'electron', undefined, true, { id: 'dev-other', name: 'Other', platform: 'linux' });

    const scoped = registry.sendToDeviceFamily(8, 'dev-mac', wsEvent('skill_sync_required', 10, {}));
    expect(scoped.targetCount).toBe(1);
    expect(macSend).toHaveBeenCalled();
    expect(otherSend).not.toHaveBeenCalled();

    // 设备整机离线：没有可投递连接，调用方据此快速失败而不等 60s 超时
    const offline = registry.sendToDeviceFamily(8, 'dev-absent', wsEvent('skill_sync_required', 10, {}));
    expect(offline.targetCount).toBe(0);
    expect(offline.successCount).toBe(0);

    // 浏览器 / 无设备身份的连接不参与设备族投递
    const browserSend = vi.fn();
    registry.register(mockSocket('ws-browser', browserSend), 8, 'browser');
    const browserOnly = registry.sendToDeviceFamily(8, 'dev-browser', wsEvent('skill_sync_required', 10, {}));
    expect(browserOnly.targetCount).toBe(0);
    expect(browserSend).not.toHaveBeenCalled();
  });

  it('sendToDeviceFamily reports zero delivery when the only connection is not writable', () => {
    const browserSend = vi.fn();
    const browser = mockSocket('ws-browser', browserSend);
    registry.register(browser, 6, 'browser');

    const empty = registry.sendToDeviceFamily(6, 'dev-1', wsEvent('skill_sync_required', 10, {}));
    expect(empty.targetCount).toBe(0);
    expect(empty.successCount).toBe(0);
    expect(browserSend).not.toHaveBeenCalled();

    // 写失败的连接计入 failureCount，供调用方区分「没目标」与「送了但没送达」
    const broken = mockSocket('ws-broken', () => { throw new Error('closed'); });
    registry.register(broken, 6, 'cli', undefined, true, { id: 'dev-broken', name: 'X', platform: 'linux' });
    const failed = registry.sendToDeviceFamily(6, 'dev-broken', wsEvent('skill_sync_required', 10, {}));
    expect(failed.targetCount).toBe(1);
    expect(failed.successCount).toBe(0);
    expect(failed.failureCount).toBe(1);
  });

  it('reportsFailureWhenAllWritesFail', async () => {
    const session = mockSocket('ws-2', () => { throw new Error('closed'); });
    registry.register(session, 1, 'electron');
    const result = await registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'FAILED' }));
    expect(result.failureCount).toBe(1);
    expect(result.successCount).toBe(0);
  });

  it('treats cli as a distinct client type and a local executor', async () => {
    const send = vi.fn();
    const session = mockSocket('ws-cli', send);
    registry.register(session, 3, 'cli');
    expect(registry.hasLocalClientConnection(3)).toBe(true);
    registry.sendToLocalClients(3, wsEvent('tool_execute', 10, { requestId: 'r' }));
    expect(send).toHaveBeenCalled();
    const delivered = await registry.sendWithResult(3, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    expect(delivered.successCount).toBe(1);
  });

  it('does not treat browser as a local executor', async () => {
    const send = vi.fn();
    const session = mockSocket('ws-browser', send);
    registry.register(session, 4, 'browser');
    expect(registry.hasLocalClientConnection(4)).toBe(false);
    registry.sendToLocalClients(4, wsEvent('tool_execute', 10, { requestId: 'r' }));
    expect(send).not.toHaveBeenCalled();
  });

  it('delivers terminal frames even when the delta queue is saturated', async () => {
    const session = mockSocket('ws-full');
    registry.register(session, 9, 'electron');
    // 塞满普通队列（capacity=10）：此后增量帧应被丢弃
    for (let i = 0; i < 20; i++) {
      registry.send(9, wsEvent('content_delta', 10, { delta: `chunk-${i}` }));
    }
    const sent = (session.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => JSON.parse(String(c[0])).type);
    expect(sent).not.toContain('chunk-19');
    expect(registry.getOutboundQueueSize()).toBeLessThanOrEqual(10);

    // 终态帧仍须送达：客户端等待方靠它收敛执行态
    registry.send(9, wsEvent('session_status', 10, { phase: 'COMPLETED' }));
    const after = (session.send as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((c) => JSON.parse(String(c[0])).type);
    expect(after).toContain('session_status');
    expect(after[after.length - 1]).toBe('session_status');

    const result = await registry.sendWithResult(9, wsEvent('message_end', 10, {}));
    expect(result.successCount).toBe(1);
  });

  it('resolves pending tracked events on shutdown instead of hanging', async () => {
    let resolved: unknown = null;
    const pending = registry.sendWithResult(1, wsEvent('session_status', 10, { phase: 'COMPLETED' })).then((r) => { resolved = r; });
    registry.shutdown();
    await pending;
    expect(resolved).toEqual({ targetCount: 0, successCount: 0, failureCount: 0 });
  });

  describe('页面操作能力声明（pageEnabled）', () => {
    it('缺省注册按开启：绑定 embed 会话后 isEmbedPageSession 为 true', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed');
      registry.bindEmbedSession(10, socket);
      expect(registry.getPageEnabled(socket)).toBe(true);
      expect(registry.isEmbedPageSession(10)).toBe(true);
    });

    it('pageEnabled=false 注册：isEmbedPageSession 为 false，但 isEmbedSession 仍为 true', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed', undefined, false);
      registry.bindEmbedSession(10, socket);
      expect(registry.getPageEnabled(socket)).toBe(false);
      // 连接仍是 embed 会话（用于事件投递），只是页面能力关闭
      expect(registry.isEmbedSession(10)).toBe(true);
      expect(registry.isEmbedPageSession(10)).toBe(false);
    });

    it('连接非 OPEN 时一律收敛为 false（即使声明过开启）', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed');
      registry.bindEmbedSession(10, socket);
      socket.readyState = 2; // CLOSING
      expect(registry.isEmbedPageSession(10)).toBe(false);
    });

    it('未注册连接按开启缺省：getPageEnabled 返回 true', () => {
      expect(registry.getPageEnabled(mockSocket('ws-unknown'))).toBe(true);
    });

    it('unregister 后能力声明随连接清理，isEmbedPageSession 回落 false', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed');
      registry.bindEmbedSession(10, socket);
      expect(registry.isEmbedPageSession(10)).toBe(true);
      registry.unregister(socket);
      expect(registry.isEmbedPageSession(10)).toBe(false);
      expect(registry.getPageEnabled(socket)).toBe(true);
    });

    it('重连重新声明：同一 socket 再次 register 覆盖上次的 pageEnabled', () => {
      const socket = mockSocket('ws-1');
      registry.register(socket, 1, 'embed', undefined, false);
      registry.bindEmbedSession(10, socket);
      expect(registry.isEmbedPageSession(10)).toBe(false);
      // 重连后宿主改为开启：auth 首帧重新声明
      registry.register(socket, 1, 'embed', undefined, true);
      expect(registry.getPageEnabled(socket)).toBe(true);
      expect(registry.isEmbedPageSession(10)).toBe(true);
    });
  });

  it('registersDeviceIdentityAndRoutesToTheLatestConnectionPerDevice', () => {
    const first = mockSocket('ws-1');
    const second = mockSocket('ws-2');
    registry.register(first, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    expect(registry.getDeviceId(first)).toBe('dev-a');
    expect(registry.getDeviceInfo(first)).toEqual({ id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    expect(registry.getDevice(7, 'dev-a')).toEqual({ id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    expect(registry.getOnlineDeviceIds(7)).toEqual(['dev-a']);

    // 同 deviceId 覆盖为最新连接：只向新连接投递，避免同机多窗口重复执行
    registry.register(second, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac A', platform: 'darwin' });
    const result = registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, { requestId: 'r1' }));
    expect(result).toMatchObject({ targetCount: 1, successCount: 1 });
    expect(first.send).not.toHaveBeenCalled();
    expect(second.send).toHaveBeenCalled();

    // 旧连接断开不清掉新连接；新连接断开后设备才离线
    registry.unregister(first);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    registry.unregister(second);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
    expect(registry.getOnlineDeviceIds(7)).toEqual([]);
  });

  it('doesNotRegisterDeviceForNonLocalClientsAndReturnsEmptyDelivery', () => {
    const browser = mockSocket('ws-browser');
    registry.register(browser, 7, 'browser', undefined, true, { id: 'dev-fake', name: 'x', platform: 'linux' });
    expect(registry.getDeviceId(browser)).toBeNull();
    expect(registry.hasDeviceConnection(7, 'dev-fake')).toBe(false);
    const missing = registry.sendToDevice(7, 'dev-none', wsEvent('tool_execute', 10, {}));
    expect(missing).toEqual({ targetCount: 0, successCount: 0, failureCount: 0 });
  });

  it('replacesDeviceMappingWhenSameSocketReauthsWithNewDevice', () => {
    const socket = mockSocket('ws-1');
    registry.register(socket, 7, 'electron', undefined, true, { id: 'dev-a', name: 'A', platform: 'darwin' });
    registry.register(socket, 7, 'electron', undefined, true, { id: 'dev-b', name: 'B', platform: 'darwin' });
    expect(registry.getDeviceId(socket)).toBe('dev-b');
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
    expect(registry.hasDeviceConnection(7, 'dev-b')).toBe(true);
  });

  // 同机多窗口 / 多个 CLI 进程共用同一 deviceId（技术方案 2026-11-05 D4）：
  // 执行连接断开必须回落另一条存活连接，否则设备被整体误判离线（定向投递 / 在线态 / failAllForDevice 全失真）。
  it('fallsBackToRemainingConnectionWhenExecutorDisconnects', () => {
    const first = mockSocket('ws-1');
    const second = mockSocket('ws-2');
    registry.register(first, 7, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });
    registry.register(second, 7, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });
    expect(registry.getDeviceExecutorSocket(7, 'dev-a')).toBe(second);

    registry.unregister(second);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    expect(registry.getDeviceExecutorSocket(7, 'dev-a')).toBe(first);
    expect(registry.getOnlineDeviceIds(7)).toEqual(['dev-a']);
    const result = registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, { requestId: 'r1' }));
    expect(result).toMatchObject({ targetCount: 1, successCount: 1 });
    expect(first.send).toHaveBeenCalled();

    // 设备最后一条连接也断开后才算离线
    registry.unregister(first);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
    expect(registry.getOnlineDeviceIds(7)).toEqual([]);
  });

  it('keepsNewerExecutorWhenStaleSameDeviceConnectionCloses', () => {
    const first = mockSocket('ws-1');
    const second = mockSocket('ws-2');
    registry.register(first, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac', platform: 'darwin' });
    registry.register(second, 7, 'electron', undefined, true, { id: 'dev-a', name: 'Mac', platform: 'darwin' });
    // 旧连接（非执行连接）断开：不得回落到它，执行连接仍是 second
    registry.unregister(first);
    expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
    registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, {}));
    expect(second.send).toHaveBeenCalled();
  });

  // 线上事故回归（2026-11-10 会话 2316）：执行连接还在 deviceExecutors 里但已不可写
  // （半死空壳），tool_execute 只按这一条投就会进黑洞。此时须回落到同 deviceId 的
  // 另一条存活连接（桌面端），让请求真正有人接手；零投递则由调用方立即判通道失效。
  it('sendToDevice falls back to another live connection of the same device', () => {
    const dead = mockSocket('ws-dead');
    dead.readyState = 3; // CLOSED：仍在 deviceExecutors，但已不可写
    const live = mockSocket('ws-live');
    registry.register(dead, 7, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });
    registry.register(live, 7, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });
    // 后注册的 live 成为执行连接，dead 作为同设备另一条连接留存
    registry.releaseDevice(7, 'dev-a', live);

    const result = registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, { requestId: 'r1' }));
    expect(result).toMatchObject({ targetCount: 1, successCount: 1 });
    expect(dead.send).not.toHaveBeenCalled();
    expect(live.send).toHaveBeenCalled();
  });

  it('sendToDevice reports zero delivery when no same-device connection is writable', () => {
    const dead = mockSocket('ws-dead');
    dead.readyState = 3;
    registry.register(dead, 7, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });
    registry.releaseDevice(7, 'dev-a', dead);
    const result = registry.sendToDevice(7, 'dev-a', wsEvent('tool_execute', 10, { requestId: 'r1' }));
    expect(result).toEqual({ targetCount: 0, successCount: 0, failureCount: 0 });
    expect(dead.send).not.toHaveBeenCalled();
  });
});

describe('StreamingWsRegistry listConnections（管理后台在线设备页）', () => {
  let registry: StreamingWsRegistry;

  beforeEach(() => {
    registry = new StreamingWsRegistry(10);
  });

  afterEach(() => {
    registry.shutdown();
  });

  it('returnsFullSnapshotFieldsForLocalClientWithDevice', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_760_000_000_000);
      registry.register(
        mockSocket('ws-1'),
        7,
        'electron',
        { userId: 7, authSource: 'company_sso', expiresAt: 1_760_100_000_000 },
        true,
        { id: 'dev-a', name: 'Mac', platform: 'darwin' },
      );

      expect(registry.listConnections()).toEqual([{
        wsSessionId: 'ws-1',
        userId: 7,
        clientType: 'electron',
        connectedAt: 1_760_000_000_000,
        authExpiresAt: 1_760_100_000_000,
        authSource: 'company_sso',
        device: { id: 'dev-a', name: 'Mac', platform: 'darwin' },
      }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('browserConnectionKeepsJwtExpiryWithoutAuthSource', () => {
    registry.register(mockSocket('ws-1'), 3, 'browser', { userId: 3, expiresAt: 1_760_100_000_000 });
    const snap = registry.listConnections();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({ clientType: 'browser', authExpiresAt: 1_760_100_000_000, authSource: null, device: null });
  });

  it('unregisterRemovesConnectionFromSnapshot', () => {
    const session = mockSocket('ws-1');
    registry.register(session, 1, 'cli', undefined, true, { id: 'dev-a', name: 'Host', platform: 'linux' });
    expect(registry.listConnections()).toHaveLength(1);
    registry.unregister(session);
    expect(registry.listConnections()).toEqual([]);
  });

  it('reRegisterRefreshesConnectedAtForSameSocket', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const session = mockSocket('ws-1');
      registry.register(session, 1, 'electron');
      expect(registry.listConnections()[0].connectedAt).toBe(1_000_000);
      // 同 socket 重新 auth（token 换发后重注册）：connectedAt 以最后一次为准
      vi.setSystemTime(1_500_000);
      registry.register(session, 1, 'electron', { userId: 1, expiresAt: 9_999_999 });
      expect(registry.listConnections()[0]).toMatchObject({ connectedAt: 1_500_000, authExpiresAt: 9_999_999 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('sameDeviceMultiWindowConnectionsAllAppear', () => {
    // 列表页要看到同设备的多条连接（多窗口/多进程），去重口径交给聚合层
    registry.register(mockSocket('ws-1'), 5, 'electron', undefined, true, { id: 'dev-a', name: 'Mac', platform: 'darwin' });
    registry.register(mockSocket('ws-2'), 5, 'electron', undefined, true, { id: 'dev-a', name: 'Mac', platform: 'darwin' });
    registry.register(mockSocket('ws-3'), 5, 'cli', undefined, true, { id: 'dev-a', name: 'Mac', platform: 'darwin' });
    const snaps = registry.listConnections();
    expect(snaps).toHaveLength(3);
    expect(new Set(snaps.map((s) => s.wsSessionId))).toEqual(new Set(['ws-1', 'ws-2', 'ws-3']));
    expect(snaps.every((s) => s.device?.id === 'dev-a')).toBe(true);
  });

  it('browserAndroidEmbedConnectionsReportNoDevice', () => {
    registry.register(mockSocket('ws-1'), 1, 'browser');
    registry.register(mockSocket('ws-2'), 1, 'android');
    registry.register(mockSocket('ws-3'), 1, 'embed');
    const snaps = registry.listConnections();
    expect(snaps.map((s) => s.clientType)).toEqual(['browser', 'android', 'embed']);
    expect(snaps.every((s) => s.device === null)).toBe(true);
  });

  it('expiredSsoConnectionStillAppearsWithoutBeingClosed', () => {
    // 读路径纯只读：过期连接由既有惰性关闭机制（下一帧收发）兜底，快照不触发 close
    const socket = mockSocket('ws-1');
    registry.register(socket, 2, 'browser', { userId: 2, authSource: 'company_sso', expiresAt: 1 });
    const snaps = registry.listConnections();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ authExpiresAt: 1, authSource: 'company_sso' });
    expect(socket.close).not.toHaveBeenCalled();
  });
});
