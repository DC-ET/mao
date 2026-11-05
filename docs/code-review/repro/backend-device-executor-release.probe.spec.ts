/**
 * round3 复现/回归用例（问题 4 修复后）：
 *  T1 执行连接断开 + 同设备仍有可回落连接 → 设备保持在线、投递落到存活连接（round2 修复不回退）
 *  T2 最后一条连接断开 → 才判离线（`hasDeviceConnection` = false）
 *  T3 执行连接断开（即使同设备还有存活连接）→ 该设备 pending 立即失败（round3 修复目标）
 *  T4 非执行连接（同设备旧连接）断开 → pending 保留、可正常完成，设备保持在线
 *  T5 观察项：执行连接交接后，旧执行连接上"仍在执行"的请求会被新执行连接断开时的清理失败
 *
 * 运行：cp docs/code-review/repro/backend-device-executor-release.probe.spec.ts backend-ts/src/__probe__/
 *       cd backend-ts && ./node_modules/.bin/vitest run src/__probe__/backend-device-executor-release.probe.spec.ts
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

describe('probe(round3): 执行连接断开 → pending 立即失败', () => {
  it('T1/T2 回落与离线判定不回退', () => {
    const { registry } = makeHarness();
    try {
      const a1 = socket('ws-a1');
      const a2 = socket('ws-a2');
      registry.register(a1, 7, 'cli', META, true, DEVICE);
      registry.register(a2, 7, 'cli', META, true, DEVICE);
      registry.unregister(a2);
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      expect(registry.getDeviceExecutorSocket(7, 'dev-x')).toBe(a1);
      registry.unregister(a1);
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(false);
    } finally {
      registry.shutdown();
    }
  });

  it('T3 执行连接断开时，即使同设备仍有存活连接，pending 也立即失败且设备保持在线', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const first = socket('ws-1');
      const second = socket('ws-2');
      registry.register(first, 7, 'cli', META, true, DEVICE);
      registry.register(second, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(pending.requestId).not.toBeNull();
      expect(toolFrames(second)).toHaveLength(1); // 请求下发给执行连接 second

      close(second);
      // pending 立即失败（不再等 900s）
      expect(await pending.future).toContain('Device disconnected');
      // 设备仍在线（回落 first），后续请求可用
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      const after = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(after.requestId).not.toBeNull();
      expect(toolFrames(first)).toHaveLength(1);
    } finally {
      registry.shutdown();
    }
  });

  it('T4 非执行连接（同设备旧连接）断开：pending 保留、可正常完成', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const stale = socket('ws-stale');
      const executor = socket('ws-exec');
      registry.register(stale, 7, 'cli', META, true, DEVICE);
      registry.register(executor, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(toolFrames(executor)).toHaveLength(1);

      close(stale); // 旧连接断开：不是执行连接
      let settled = false;
      void pending.future.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      // 执行连接正常回传结果
      localRegistry.completeToolRequest(11, pending.requestId!, '{"ok":true}');
      expect(await pending.future).toBe('{"ok":true}');
    } finally {
      registry.shutdown();
    }
  });

  it('T5 执行连接交接后：新执行连接断开只失败它收到的请求，旧连接上在途请求保留', async () => {
    const { registry, localRegistry, close } = makeHarness();
    try {
      const a = socket('ws-a');
      const b = socket('ws-b');
      registry.register(a, 7, 'cli', META, true, DEVICE);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      // 请求下发给当时的执行连接 a（a 仍在执行中）
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(toolFrames(a)).toHaveLength(1);
      // 新连接 b 注册，成为执行连接（a 仍存活）
      registry.register(b, 7, 'cli', META, true, DEVICE);
      expect(registry.getDeviceExecutorSocket(7, 'dev-x')).toBe(b);
      // 交接后 b 上又下发一条请求
      const pendingB = await localRegistry.sendToolRequest(11, 'shell', '{}', '/w', false, null);
      expect(toolFrames(b)).toHaveLength(1);

      // b 断开：只失败下发到 b 的请求；a 上仍在执行的请求不受影响
      close(b);
      expect(await pendingB.future).toContain('Device disconnected');
      let aSettled = false;
      void pending.future.then(() => { aSettled = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(aSettled).toBe(false);
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      localRegistry.completeToolRequest(11, pending.requestId!, '{\"ok\":true}');
      expect(await pending.future).toBe('{\"ok\":true}');
    } finally {
      registry.shutdown();
    }
  });
});
