import { describe, expect, it, vi } from 'vitest';
import { StreamingWsHandler, type WsHandlerDeps } from '../session/ws/streaming-ws-handler.js';
import { StreamingWsRegistry, WS_OPEN, type WsSocket } from '../session/ws/streaming-ws-registry.js';
import { LocalToolSessionRegistry } from '../harness/local/local-tool-session-registry.js';

function socket(id: string): WsSocket {
  return { id, readyState: WS_OPEN, send: vi.fn(), close: vi.fn() };
}

const META = { userId: 7, expiresAt: Date.now() + 60_000 };
const DEVICE = { id: 'dev-x', name: 'Mac X', platform: 'darwin' };

describe('probe: 同一设备多连接（两个 CLI/窗口实例）下的删连接语义', () => {
  it('执行连接（较新的一条）断开后，同设备仍存活的旧连接应继续可用', () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const first = socket('ws-1');
      const second = socket('ws-2');
      registry.register(first, 7, 'cli', META, true, DEVICE);
      registry.register(second, 7, 'cli', META, true, DEVICE);
      expect(registry.sendToDevice(7, 'dev-x', { type: 'tool_execute', sessionId: 1, data: {} }).successCount).toBe(1);

      registry.unregister(second);
      expect(first.readyState).toBe(WS_OPEN);
      // 期望：设备仍在线（旧连接可继续承接定向投递）
      expect(registry.hasDeviceConnection(7, 'dev-x')).toBe(true);
      expect(registry.getOnlineDeviceIds(7)).toEqual(['dev-x']);
      expect(registry.sendToDevice(7, 'dev-x', { type: 'tool_execute', sessionId: 1, data: {} }).successCount).toBe(1);
    } finally {
      registry.shutdown();
    }
  });

  it('后果：旧连接仍在，但断线清理会判死设备、在途与后续工具请求都被拒', async () => {
    const registry = new StreamingWsRegistry(1000);
    try {
      const first = socket('ws-1');
      const second = socket('ws-2');
      registry.register(first, 7, 'cli', META, true, DEVICE);
      registry.register(second, 7, 'cli', META, true, DEVICE);
      const localRegistry = new LocalToolSessionRegistry(registry, { selectById: vi.fn(async () => null) } as never);
      localRegistry.setTargetForSession(11, 7, 'dev-x');
      const failSpy = vi.spyOn(localRegistry, 'failAllForDevice');

      const before = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(before.requestId).not.toBeNull();

      const handler = new StreamingWsHandler({ registry, localToolSessionRegistry: localRegistry } as unknown as WsHandlerDeps);
      (handler as unknown as { afterConnectionClosed(s: WsSocket): void }).afterConnectionClosed(second);

      // 设备其实仍在线（first 仍 OPEN），但清理逻辑已判死 → 在途请求被失败
      expect(failSpy).toHaveBeenCalledWith(7, 'dev-x');
      expect(await before.future).toContain('Device disconnected');

      // 后续工具请求也被拒（返回 requestId=null → Local client is not connected）
      const after = await localRegistry.sendToolRequest(11, 'read_file', '{}', '/w', false, null);
      expect(after.requestId).not.toBeNull();
    } finally {
      registry.shutdown();
    }
  });
});
