import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteFileProxyService, REMOTE_FILE_UNBOUND_MESSAGE } from './remote-file-proxy.service.js';
import type { Session } from '../session/types.js';

function localSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 11,
    userId: 7,
    executionMode: 'LOCAL',
    workspace: '/Users/yang/proj',
    targetDeviceId: 'dev-mac-1',
    targetDeviceName: 'Yang 的 MacBook Pro',
  } as Session;
}

function delivered(socketId = 'ws-electron') {
  return { status: 'delivered' as const, socket: { id: socketId } };
}

/** execute 内先 await resolveTarget：让出一个微任务，投递才会发生（断言时机） */
async function flush(): Promise<void> {
  await Promise.resolve();
}

function firstRequestId(wsRegistry: { sendToFileCapableDevice: ReturnType<typeof vi.fn> }, callIndex = 0): string {
  const event = wsRegistry.sendToFileCapableDevice.mock.calls[callIndex][2] as { data: { requestId: string } };
  return event.data.requestId;
}

describe('RemoteFileProxyService', () => {
  let wsRegistry: {
    sendToFileCapableDevice: ReturnType<typeof vi.fn>;
  };
  let localToolSessions: { resolveTarget: ReturnType<typeof vi.fn> };
  let proxy: RemoteFileProxyService;

  beforeEach(() => {
    wsRegistry = {
      sendToFileCapableDevice: vi.fn(() => delivered()),
    };
    localToolSessions = { resolveTarget: vi.fn(async () => ({ userId: 7, deviceId: 'dev-mac-1' })) };
    proxy = new RemoteFileProxyService(wsRegistry as never, localToolSessions);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('正常往返：定向投递 + complete 归一化 list 结果（mtime→mtimeMs、补 workspaceRoot）', async () => {
    const executePromise = proxy.execute(localSession(), 'list', { dir: 'src' });
    await flush();
    expect(wsRegistry.sendToFileCapableDevice).toHaveBeenCalledWith(7, 'dev-mac-1', expect.objectContaining({
      type: 'file_op_request',
      sessionId: 11,
      data: expect.objectContaining({ op: 'list', params: { dir: 'src' }, workspace: '/Users/yang/proj' }),
    }));
    const requestId = firstRequestId(wsRegistry);
    proxy.complete(requestId, true, {
      entries: [{ name: 'a.ts', path: 'src/a.ts', isDirectory: false, size: 3, isSymlink: false, mtime: 1729999999999 }],
      truncated: false,
    });
    const result = await executePromise as { entries: Array<Record<string, unknown>>; truncated: boolean; workspaceRoot: string };
    expect(result.workspaceRoot).toBe('/Users/yang/proj');
    expect(result.truncated).toBe(false);
    expect(result.entries[0].mtimeMs).toBe(1729999999999);
    expect(result.entries[0]).not.toHaveProperty('mtime');
    expect(proxy.pendingSize()).toBe(0);
  });

  it('files op：设备端数组包一层 { files }，与 CLOUD workspace-list DTO 同形', async () => {
    const executePromise = proxy.execute(localSession(), 'files', { filter: 'txt', limit: 20 });
    await flush();
    const requestId = firstRequestId(wsRegistry);
    proxy.complete(requestId, true, [{ path: 'a.txt', name: 'a.txt', size: 1 }]);
    await expect(executePromise).resolves.toEqual({ files: [{ path: 'a.txt', name: 'a.txt', size: 1 }] });
  });

  it('read op：设备端形状与 CLOUD FileContentDTO 一致，原样透传', async () => {
    const executePromise = proxy.execute(localSession(), 'read', { path: 'a.txt', offset: 0, limit: 100 });
    await flush();
    const requestId = firstRequestId(wsRegistry);
    proxy.complete(requestId, true, { content: 'hi', total_lines: 1 });
    await expect(executePromise).resolves.toEqual({ content: 'hi', total_lines: 1 });
  });

  it('未绑定会话：拒绝并引导登记，不投递', async () => {
    localToolSessions.resolveTarget.mockResolvedValue({ userId: 7, deviceId: null });
    await expect(proxy.execute(localSession({ targetDeviceId: null }), 'list', {}))
      .rejects.toThrow(REMOTE_FILE_UNBOUND_MESSAGE);
    expect(wsRegistry.sendToFileCapableDevice).not.toHaveBeenCalled();
  });

  it('绑定设备离线（无任何可写连接）：拒绝并携带设备名快照文案', async () => {
    // 离线判定收敛在 sendToFileCapableDevice 的全存活连接扫描（比单执行连接槽口径宽，
    // 执行连接半死但同设备其它 electron 连接存活时仍可投递，避免瞬态假离线）
    wsRegistry.sendToFileCapableDevice.mockReturnValue({ status: 'offline' });
    await expect(proxy.execute(localSession(), 'list', {}))
      .rejects.toThrow('执行端设备「Yang 的 MacBook Pro」已离线，无法浏览本地文件');
  });

  it('设备仅有 CLI 连接（cliOnly）：回 D11 专用文案，不空等超时', async () => {
    wsRegistry.sendToFileCapableDevice.mockReturnValue({ status: 'cliOnly' });
    await expect(proxy.execute(localSession(), 'list', {}))
      .rejects.toThrow('该任务由终端 CLI（mao-agent）执行，当前版本暂不支持远程浏览本地文件，请升级 mao-agent 后重试');
  });

  it('连接均显式声明但无 file_op（noCapable）：回版本过旧文案', async () => {
    wsRegistry.sendToFileCapableDevice.mockReturnValue({ status: 'noCapable' });
    await expect(proxy.execute(localSession(), 'list', {}))
      .rejects.toThrow('执行端客户端不支持远程浏览本地文件，请升级桌面客户端或 mao-agent 后重试');
  });

  it('投递零成功（offline）：立即回离线文案，不进 pending', async () => {
    wsRegistry.sendToFileCapableDevice.mockReturnValue({ status: 'offline' });
    await expect(proxy.execute(localSession(), 'list', {}))
      .rejects.toThrow('已离线');
    expect(proxy.pendingSize()).toBe(0);
  });

  it('设备端报错（ok=false）：reject 携带设备端中文错误', async () => {
    const executePromise = proxy.execute(localSession(), 'read', { path: 'a.txt' });
    await flush();
    const requestId = firstRequestId(wsRegistry);
    proxy.complete(requestId, false, '文件不存在');
    await expect(executePromise).rejects.toThrow('文件不存在');
  });

  it('list 15s / search 30s 超时：reject 中文文案并清理 pending', async () => {
    vi.useFakeTimers();
    const listPromise = proxy.execute(localSession(), 'list', {});
    await flush();
    vi.advanceTimersByTime(15_000);
    await expect(listPromise).rejects.toThrow('执行端设备响应超时（15 秒）');
    expect(proxy.pendingSize()).toBe(0);

    const searchPromise = proxy.execute(localSession(), 'search', { pattern: 'a' });
    await flush();
    vi.advanceTimersByTime(15_000);
    expect(proxy.pendingSize()).toBe(1);
    vi.advanceTimersByTime(15_000);
    await expect(searchPromise).rejects.toThrow('执行端设备响应超时（30 秒）');
    expect(proxy.pendingSize()).toBe(0);
  });

  it('failAllForSocket 只失败该连接的请求，同设备其它连接上的在途请求不受影响', async () => {
    // socket 同一性与生产一致：注册表投递返回的就是那个连接实例，断线清理按实例匹配
    const socket1 = { id: 'ws-electron' };
    const socket2 = { id: 'ws-electron-2' };
    wsRegistry.sendToFileCapableDevice.mockReturnValue({ status: 'delivered', socket: socket1 });
    const first = proxy.execute(localSession(), 'list', { dir: 'a' });
    await flush();
    const requestIdFirst = firstRequestId(wsRegistry);
    wsRegistry.sendToFileCapableDevice.mockReturnValue({ status: 'delivered', socket: socket2 });
    const second = proxy.execute(localSession(), 'read', { path: 'b.txt' });
    await flush();
    proxy.failAllForSocket(socket1);
    await expect(first).rejects.toThrow('执行端设备连接已断开');
    expect(proxy.pendingSize()).toBe(1);
    const requestIdSecond = firstRequestId(wsRegistry, 1);
    proxy.complete(requestIdSecond, true, { content: 'b', total_lines: 1 });
    await expect(second).resolves.toEqual({ content: 'b', total_lines: 1 });
    expect(proxy.pendingSize()).toBe(0);
    expect(requestIdFirst).not.toBe(requestIdSecond);
  });

  it('迟到的重复回包不影响已完成的请求（complete 幂等）', async () => {
    const executePromise = proxy.execute(localSession(), 'list', {});
    await flush();
    const requestId = firstRequestId(wsRegistry);
    proxy.complete(requestId, true, { entries: [], truncated: false });
    await expect(executePromise).resolves.toEqual({ entries: [], truncated: false, workspaceRoot: '/Users/yang/proj' });
    // 迟到的失败回包：pending 已清理，静默忽略，不影响已 resolve 的结果
    proxy.complete(requestId, false, '文件不存在');
    await expect(executePromise).resolves.toEqual({ entries: [], truncated: false, workspaceRoot: '/Users/yang/proj' });
  });
});
