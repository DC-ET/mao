/**
 * round2 补测：releaseDevice 回落逻辑的边界与副作用
 *  - 三条同设备连接：断执行连接回落到存活连接（不误删设备映射）
 *  - 回落只认同设备，不吞并其它设备连接
 *  - 链式回落：最后一条断开才判离线
 *  - 回落后 getDevice 仍能取到设备信息（认领时写设备名快照依赖它）
 *  - 鉴权过期的同设备连接会被判定不可用（isConnectionAuthorized 被咨询，连接被关闭）
 *
 * 运行：cp docs/code-review/repro/backend-device-fallback-edges.probe.spec.ts backend-ts/src/__probe__/
 *       cd backend-ts && ./node_modules/.bin/vitest run src/__probe__/backend-device-fallback-edges.probe.spec.ts
 */
import { describe, expect, it, vi } from 'vitest';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from '../session/ws/streaming-ws-registry.js';

function socket(id: string, state: number = WS_OPEN): WsSocket {
  return { id, readyState: state, send: vi.fn(), close: vi.fn() };
}

const META = { userId: 7, expiresAt: Date.now() + 60_000 };
const DEV_A = { id: 'dev-a', name: 'Host A', platform: 'linux' };
const DEV_B = { id: 'dev-b', name: 'Host B', platform: 'linux' };

function toolFrames(s: WsSocket): Array<Record<string, unknown>> {
  return (s.send as unknown as { mock: { calls: string[][] } }).mock.calls
    .map((c) => JSON.parse(c[0]))
    .filter((f) => f.type === 'tool_execute');
}

describe('probe(round2): releaseDevice 回落边界', () => {
  it('三条同设备连接：断执行连接后回落到存活连接，投递恰好一次', () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const a1 = socket('ws-a1');
      const a2 = socket('ws-a2');
      const a3 = socket('ws-a3');
      registry.register(a1, 7, 'cli', META, true, DEV_A);
      registry.register(a2, 7, 'cli', META, true, DEV_A);
      registry.register(a3, 7, 'cli', META, true, DEV_A);
      registry.unregister(a3);
      expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
      expect(registry.getOnlineDeviceIds(7)).toEqual(['dev-a']);
      const delivered = registry.sendToDevice(7, 'dev-a', { type: 'tool_execute', sessionId: 1, data: {} });
      expect(delivered.successCount).toBe(1);
      expect(toolFrames(a1).length + toolFrames(a2).length).toBe(1);
      expect(toolFrames(a3).length).toBe(0);
      // 回落后 getDevice 仍可用（prepareLocalTarget 取设备名快照）
      expect(registry.getDevice(7, 'dev-a')).toEqual(DEV_A);
    } finally {
      registry.shutdown();
    }
  });

  it('回落只认同设备，不吞并其它设备连接', () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const a1 = socket('ws-a1');
      const a2 = socket('ws-a2');
      const b1 = socket('ws-b1');
      registry.register(a1, 7, 'cli', META, true, DEV_A);
      registry.register(b1, 7, 'cli', META, true, DEV_B);
      registry.register(a2, 7, 'cli', META, true, DEV_A);
      registry.unregister(a2);
      expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
      expect(registry.hasDeviceConnection(7, 'dev-b')).toBe(true);
      expect(registry.getOnlineDeviceIds(7).sort()).toEqual(['dev-a', 'dev-b']);
      registry.sendToDevice(7, 'dev-b', { type: 'tool_execute', sessionId: 1, data: {} });
      expect(toolFrames(b1)).toHaveLength(1);
      expect(toolFrames(a1)).toHaveLength(0);
    } finally {
      registry.shutdown();
    }
  });

  it('链式回落：逐个断开，最后一条断开才判离线', () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const a1 = socket('ws-a1');
      const a2 = socket('ws-a2');
      registry.register(a1, 7, 'cli', META, true, DEV_A);
      registry.register(a2, 7, 'cli', META, true, DEV_A);
      registry.unregister(a2);
      expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(true);
      registry.unregister(a1);
      expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
      expect(registry.getOnlineDeviceIds(7)).toEqual([]);
      expect(registry.getDevice(7, 'dev-a')).toBeNull();
    } finally {
      registry.shutdown();
    }
  });

  it('鉴权过期的同设备连接不参与可用性（并触发过期关闭）', () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const expired = socket('ws-expired');
      const executor = socket('ws-exec');
      registry.register(expired, 7, 'cli', { userId: 7, authSource: 'company_sso', expiresAt: Date.now() - 1 }, true, DEV_A);
      registry.register(executor, 7, 'cli', META, true, DEV_A);
      registry.unregister(executor);
      expect(registry.hasDeviceConnection(7, 'dev-a')).toBe(false);
      expect(registry.getOnlineDeviceIds(7)).toEqual([]);
      expect(expired.close).toHaveBeenCalled();
    } finally {
      registry.shutdown();
    }
  });
});
