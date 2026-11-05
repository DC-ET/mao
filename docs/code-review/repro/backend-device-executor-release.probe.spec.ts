/**
 * round2 复现/回归用例（问题 1 修复后）：
 *  1) 同设备多连接：执行连接断开 → 回落存活连接，设备仍在线、仍可定向投递；
 *  2) 执行连接断开且无同设备连接可回落 → 才判离线（failAllForDevice 语义）；
 *  3) 回落后旧执行连接上的在途 pending 语义（观察项，见 docs/code-review round2 报告）。
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

const META = { userId: 7, expiresAt: Date.now() + 60_000 };
const DEVICE = { id: 'dev-x', name: 'Mac X', platform: 'darwin' };

describe('probe(round2): 同一设备多连接下的删连接语义', () => {
  it('执行连接（较新的一条）断开后回落存活连接：设备仍在线且仍可定向投递', () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const first = socket('ws-1');
      const second = socket('ws-2');
      registry.register(first, 7, 'cli', META, true, DEVICE);
      registry.register(second, 7, 'cli', META, true, DEVICE);
      expect(registry.sendToDevice(7, 'dev-x', { type: 'tool_execute', sessionId: 1, data: {} }).successCount).toBe(1);

      registry.unregister(second);
      expect(first.readyState).toBe(WS_OPEN);
      // 期望（round2 修复后）：回落存活连接 → 设备仍在线、投递落到 first
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      expect(registry.getOnlineDeviceIds(7)).toEqual(['dev-x']);
      const delivered = registry.sendToDevice(7, 'dev-x', { type: 'tool_execute', sessionId: 1, data: {} });
      expect(delivered.successCount).toBe(1);
      expect(first.send).toHaveBeenCalled();
    } finally {
      registry.shutdown();
    }
  });

  it('无同设备连接可回落时才判离线（failAllForDevice 语义不变）', async () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const first = socket('ws-1');
      const second = socket('ws-2');
      registry.register(first, 7, 'cli', META, true, DEVICE);
      registry.register(second, 7, 'cli', META, true, DEVICE);

      const localRegistry = new LocalToolSessionRegistry(registry, { selectById: vi.fn(async () => null) } as never);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(pending.requestId).not.toBeNull();
      const failSpy = vi.spyOn(localRegistry, 'failAllForDevice');
      const handler = new StreamingWsHandler({ registry, localToolSessionRegistry: localRegistry } as unknown as WsHandlerDeps);
      const close = (s: WsSocket) => (handler as unknown as { afterConnectionClosed(s: WsSocket): void }).afterConnectionClosed(s);

      // 先断执行连接（second）：仍有 first 可回落 → 不失败 pending
      close(second);
      expect(failSpy).not.toHaveBeenCalled();
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      // 再断最后一条：设备离线 → 失败该设备 pending（既有语义不变）
      close(first);
      expect(failSpy).toHaveBeenCalledWith(7, 'dev-x');
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(false);
      expect(await pending.future).toContain('Device disconnected');
    } finally {
      registry.shutdown();
    }
  });

  it('观察项：执行连接断开但仍有同设备连接时，已下发给旧连接的 pending 不再被失败', async () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const first = socket('ws-1');
      const second = socket('ws-2');
      registry.register(first, 7, 'cli', META, true, DEVICE);
      registry.register(second, 7, 'cli', META, true, DEVICE);

      const localRegistry = new LocalToolSessionRegistry(registry, { selectById: vi.fn(async () => null) } as never);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const pending = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(pending.requestId).not.toBeNull();
      // 本次请求实际下发到 second（执行连接）
      expect((second.send as unknown as { mock: { calls: string[][] } }).mock.calls
        .map((c) => JSON.parse(c[0])).filter((f) => f.type === 'tool_execute')).toHaveLength(1);
      const failSpy = vi.spyOn(localRegistry, 'failAllForDevice');

      const handler = new StreamingWsHandler({ registry, localToolSessionRegistry: localRegistry } as unknown as WsHandlerDeps);
      (handler as unknown as { afterConnectionClosed(s: WsSocket): void }).afterConnectionClosed(second);

      // 现状：设备仍在线 → 不失败 pending；该 pending 只能等 LocalToolExecutor 的 900s 超时
      expect(failSpy).not.toHaveBeenCalled();
      let settled = false;
      void pending.future.then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false);
      // 后续请求改投 first（回落后在线）
      const after = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(after.requestId).not.toBeNull();
      expect((first.send as unknown as { mock: { calls: string[][] } }).mock.calls
        .map((c) => JSON.parse(c[0])).filter((f) => f.type === 'tool_execute')).toHaveLength(1);
    } finally {
      registry.shutdown();
    }
  });
});
