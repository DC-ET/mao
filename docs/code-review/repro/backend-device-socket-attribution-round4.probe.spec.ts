/**
 * round4 复现/回归用例（问题 5 修复后：按「请求 → 下发连接」精确清理）：
 *  R1 执行连接断开 + 同设备仍有回落后连接 → 该连接收到的请求立即失败，设备保持在线
 *  R2 非执行连接（旧连接）断开 → 不影响执行连接上的 pending
 *  R3 执行连接交接：A 的请求在途 → B 注册为执行连接 → B 断开 → 只失败 B 的请求，A 的请求保留并可完成
 *  R4 交接后 A（旧执行连接）断开 → A 上的请求立即失败；B 上的请求不受影响
 *  R5 failAllForSocket(null/undefined) 为 no-op
 *  R6 同一连接多会话请求全部失败；内部 map 清理干净；随后 completeToolRequest 为 no-op
 *  R7 先完成再断开 → 结果保持原值，不被二次改写
 *  R8 设备完全离线兜底：广播下发（socket=null）后绑定设备，设备离线时由 failAllForDevice 失败
 *  R9 身份语义：同 id 的不同对象不参与匹配（记录实现假设）
 *
 * 运行：cp docs/code-review/repro/backend-device-socket-attribution-round4.probe.spec.ts backend-ts/src/__probe__/
 *       cd backend-ts && ./node_modules/.bin/vitest run src/__probe__/backend-device-socket-attribution-round4.probe.spec.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from '../session/ws/streaming-ws-handler.js';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from '../session/ws/streaming-ws-registry.js';
import { LocalToolSessionRegistry } from '../harness/local/local-tool-session-registry.js';

function socket(id: string): WsSocket {
  return { id, readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
}

function toolFrames(s: WsSocket): Array<Record<string, any>> {
  return (s.send as unknown as { mock: { calls: string[][] } }).mock.calls
    .map((c) => JSON.parse(c[0]))
    .filter((f) => f.type === 'tool_execute');
}

const META = { userId: 7, expiresAt: Date.now() + 60_000 };
const DEVICE = { id: 'dev-x', name: 'Mac X', platform: 'darwin' };

function makeHarness() {
  const registry = new StreamingWsRegistry(1000);
  const localRegistry = new LocalToolSessionRegistry(registry, { selectById: vi.fn(async () => null) } as never);
  const handler = new StreamingWsHandler({ registry, localToolSessionRegistry: localRegistry } as unknown as WsHandlerDeps);
  const close = (s: WsSocket) => (handler as unknown as { afterConnectionClosed(s: WsSocket): void }).afterConnectionClosed(s);
  return { registry, localRegistry, close };
}

function pendingMap(localRegistry: LocalToolSessionRegistry): Map<number, Map<string, { socket: unknown }>> {
  return (localRegistry as unknown as { pendingRequests: Map<number, Map<string, { socket: unknown }>> }).pendingRequests;
}

async function notSettled(future: Promise<string>, ms = 20): Promise<boolean> {
  let settled = false;
  void future.then(() => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  return !settled;
}

describe('probe(round4): 请求 → 下发连接归属', () => {
  it('R1 执行连接断开：其请求立即失败，设备回落仍在线，后续请求投给回落后连接', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const first = socket('ws-1');
      const second = socket('ws-2');
      registry.register(first, 7, 'cli', META, true, DEVICE);
      registry.register(second, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(toolFrames(second)).toHaveLength(1);

      close(second);
      expect(await pending.future).toContain('Device disconnected');
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      const after = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(after.requestId).not.toBeNull();
      expect(toolFrames(first)).toHaveLength(1);
    } finally {
      registry.shutdown();
    }
  });

  it('R2 非执行连接（旧连接）断开：执行连接上的 pending 保留并可完成', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const stale = socket('ws-stale');
      const executor = socket('ws-exec');
      registry.register(stale, 7, 'cli', META, true, DEVICE);
      registry.register(executor, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(toolFrames(executor)).toHaveLength(1);

      close(stale);
      expect(await notSettled(pending.future)).toBe(true);
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      localRegistry.completeToolRequest(11, pending.requestId!, '{"ok":true}');
      expect(await pending.future).toBe('{"ok":true}');
    } finally {
      registry.shutdown();
    }
  });

  it('R3 交接后 B 断开：只失败 B 的请求，A 上在途请求保留并可完成', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      const b = socket('ws-b');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pendingA = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(toolFrames(a)).toHaveLength(1);

      registry.register(b, 7, 'cli', META, true, DEVICE);
      expect(registry.getDeviceExecutorSocket(7, 'dev-x')).toBe(b);
      const pendingB = await localRegistry.sendToolRequest(11, 'shell', '{}', '/w', false, null);
      expect(toolFrames(b)).toHaveLength(1);

      close(b);
      expect(await pendingB.future).toContain('Device disconnected');
      expect(await notSettled(pendingA.future)).toBe(true);
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      localRegistry.completeToolRequest(11, pendingA.requestId!, '{"ok":true}');
      expect(await pendingA.future).toBe('{"ok":true}');
    } finally {
      registry.shutdown();
    }
  });

  it('R4 交接后 A（旧执行连接）断开：A 上请求立即失败，B 上请求保留', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      const b = socket('ws-b');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pendingA = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      registry.register(b, 7, 'cli', META, true, DEVICE);
      const pendingB = await localRegistry.sendToolRequest(11, 'shell', '{}', '/w', false, null);

      close(a);
      expect(await pendingA.future).toContain('Device disconnected');
      expect(await notSettled(pendingB.future)).toBe(true);
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      localRegistry.completeToolRequest(11, pendingB.requestId!, '{"ok":true}');
      expect(await pendingB.future).toBe('{"ok":true}');
    } finally {
      registry.shutdown();
    }
  });

  it('R5 failAllForSocket(null/undefined) 为 no-op', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(() => localRegistry.failAllForSocket(null)).not.toThrow();
      expect(() => localRegistry.failAllForSocket(undefined)).not.toThrow();
      expect(await notSettled(pending.future)).toBe(true);
      close(a);
      expect(await pending.future).toContain('Device disconnected');
    } finally {
      registry.shutdown();
    }
  });

  it('R6 同连接多会话请求全部失败；map 清理干净；随后 complete 为 no-op', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      localRegistry.setTargetForSession(12, 7, 'dev-x');
      const p11 = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      const p12 = await localRegistry.sendToolRequest(12, 'shell', '{}', '/w', false, null);
      expect(pendingMap(localRegistry).size).toBe(2);

      close(a);
      expect(await p11.future).toContain('Device disconnected');
      expect(await p12.future).toContain('Device disconnected');
      // 空闲 map 不得残留
      expect(pendingMap(localRegistry).size).toBe(0);
      // 迟到的结果不得抛错、也不得改写已失败结果
      expect(() => localRegistry.completeToolRequest(11, p11.requestId!, '{"late":true}')).not.toThrow();
      expect(await p11.future).toContain('Device disconnected');
    } finally {
      registry.shutdown();
    }
  });

  it('R7 先完成再断开：结果保持原值', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      localRegistry.completeToolRequest(11, pending.requestId!, '{"ok":true}');
      close(a);
      expect(await pending.future).toBe('{"ok":true}');
      expect(pendingMap(localRegistry).size).toBe(0);
    } finally {
      registry.shutdown();
    }
  });

  it('R8 设备完全离线：广播下发（socket=null）后绑定的 pending 由 failAllForDevice 兜底失败', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      // 先以「未绑定设备」登记 → 请求走用户级广播，socket 归属为 null
      localRegistry.setTargetForSession(11, 7, null);
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(pending.requestId).not.toBeNull();
      expect(pendingMap(localRegistry).get(11)?.values().next().value?.socket).toBeNull();
      // 之后才绑定设备（惰性认领时序）
      localRegistry.setTargetForSession(11, 7, 'dev-x');

      close(a);
      expect(await pending.future).toContain('Device disconnected');
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(false);
    } finally {
      registry.shutdown();
    }
  });

  it('R9 身份语义：同 id 的不同对象不参与匹配（依赖单连接单对象约定）', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      localRegistry.failAllForSocket({ id: 'ws-a', readyState: WS_OPEN, send: vi.fn(), close: vi.fn() });
      expect(await notSettled(pending.future)).toBe(true);
      close(a);
      expect(await pending.future).toContain('Device disconnected');
    } finally {
      registry.shutdown();
    }
  });
});
