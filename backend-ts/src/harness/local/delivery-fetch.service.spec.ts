import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_FETCH_MAX_INFLIGHT_PER_USER,
  DELIVERY_OPEN_TIMEOUT_MS,
  DELIVERY_READ_TIMEOUT_MS,
  LocalDeliveryFetchService,
} from './delivery-fetch.service.js';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';

/**
 * registry 桩（2026-11-25 R2 拉取协议）：每次读取请求登记一个可手动 settle 的 future，
 * 记录帧载荷；completeToolRequest 按 requestId settle。
 */
interface TestPending {
  requestId: string | null;
  future: Promise<string>;
  payload: Record<string, unknown>;
  /** 第三个入参（定向投递的 socketId）：null = 广播。 */
  socketId: string | null;
}

function makeRegistry(directed = true) {
  const pendings: TestPending[] = [];
  const resolvers = new Map<string, (v: string) => void>();
  const registry = {
    sendDeliveryReadRequest: vi.fn(async (
      _sessionId: number,
      payload: Record<string, unknown>,
      options?: { socketId?: string | null },
    ) => {
      const requestId = `req-${pendings.length}`;
      const future = new Promise<string>((r) => { resolvers.set(requestId, r); });
      pendings.push({ requestId, future, payload: { ...payload }, socketId: options?.socketId ?? null });
      return { requestId, future, resolve: () => undefined, directed };
    }),
    sendDeliveryClose: vi.fn(),
    completeToolRequest: vi.fn((_sessionId: number, requestId: string, result: string) => {
      resolvers.get(requestId)?.(result);
    }),
    dropToolRequest: vi.fn(),
  };
  return { registry, pendings };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

const MAX = 1024 * 1024;

describe('LocalDeliveryFetchService（2026-11-25 R2 服务端窗口拉取）', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('open 回 size / mtimeMs；read 按 offset 拉取，拼接为原字节并关闭句柄', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const bytes = Buffer.from('hello-delivery-read');
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    expect(pendings[0].payload).toMatchObject({
      action: 'open', path: 'a.bin', workspace: '/repo', maxBytes: MAX,
    });
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: bytes.length, mtimeMs: 123 });
    const opened = await opening;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const chunks: Buffer[] = [];
    const collect = (async () => {
      for await (const chunk of opened.stream) chunks.push(chunk as Buffer);
    })();
    await flush();
    const readEntry = pendings.find((p) => p.payload.action === 'read')!;
    expect(readEntry.payload).toMatchObject({ offset: 0, length: bytes.length });
    service.handleResult(10, readEntry.requestId!, {
      ok: true, data: bytes.toString('base64'), size: bytes.length, mtimeMs: 123,
    });
    await collect;
    expect(Buffer.concat(chunks).equals(bytes)).toBe(true);
    // 正常读完不自动关句柄：由调用方在摘要比对后显式 close（R8）
    expect(registry.sendDeliveryClose).not.toHaveBeenCalled();
    opened.close();
    expect(registry.sendDeliveryClose).toHaveBeenCalledWith(10, expect.any(String));
  });

  it('digest：正常读完后向执行端要整份 sha256（R8），再显式 close', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const bytes = Buffer.from('digest-me');
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: bytes.length, mtimeMs: 123 });
    const opened = await opening;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const collect = (async () => {
      for await (const _chunk of opened.stream) { /* drain */ }
    })();
    await flush();
    const readEntry = pendings.find((p) => p.payload.action === 'read')!;
    service.handleResult(10, readEntry.requestId!, {
      ok: true, data: bytes.toString('base64'), size: bytes.length, mtimeMs: 123,
    });
    await collect;
    const digesting = opened.digest();
    await flush();
    const digestEntry = pendings.find((p) => p.payload.action === 'digest')!;
    service.handleResult(10, digestEntry.requestId!, {
      ok: true, sha256: 'deadbeef', size: bytes.length, mtimeMs: 123,
    });
    await expect(digesting).resolves.toBe('deadbeef');
    opened.close();
    expect(registry.sendDeliveryClose).toHaveBeenCalledWith(10, expect.any(String));
  });

  it('open 失败：优先使用执行端的确定错误（文件过大），10 秒内不转「版本过旧」', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'big.bin', '/repo', MAX);
    await flush();
    service.handleResult(10, pendings[0].requestId!, { ok: false, error: '文件过大（2048MB），上限 1024MB' });
    await expect(opening).resolves.toEqual({ ok: false, error: '文件过大（2048MB），上限 1024MB' });
  });

  it('open 失败先到、成功后到：成功仍获胜（用户级广播下多执行端响应）', async () => {
    const { registry, pendings } = makeRegistry(false);
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    service.handleResult(10, pendings[0].requestId!, { ok: false, error: '文件不存在' });
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: 4, mtimeMs: 9 });
    const opened = await opening;
    expect(opened.ok).toBe(true);
    if (opened.ok) opened.stream.destroy();
  });

  it('首帧 10 秒无回包（旧执行端不认识新帧）→ 「执行端不在线或版本过旧」并丢弃 pending', async () => {
    vi.useFakeTimers();
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(DELIVERY_OPEN_TIMEOUT_MS);
    await expect(opening).resolves.toEqual({ ok: false, error: '执行端不在线或版本过旧，无法读取本机文件' });
    expect(registry.dropToolRequest).toHaveBeenCalledWith(10, pendings[0].requestId!);
  });

  it('read 超时 60 秒 / 执行端回错误 / size 变化 → 流失败', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: 8, mtimeMs: 5 });
    const opened = await opening;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    const collect = (async () => {
      for await (const _chunk of opened.stream) { /* drain */ }
    })();
    await flush();
    const readEntry = pendings.find((p) => p.payload.action === 'read')!;
    service.handleResult(10, readEntry.requestId!, {
      ok: true, data: Buffer.alloc(8).toString('base64'), size: 9, mtimeMs: 5,
    });
    await expect(collect).rejects.toThrow('文件在发送期间被修改');
  });

  it('read 回 ok:false → 流失败并透传文案', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: 8, mtimeMs: 5 });
    const opened = await opening;
    if (!opened.ok) return;
    const collect = (async () => {
      for await (const _chunk of opened.stream) { /* drain */ }
    })();
    await flush();
    const readEntry = pendings.find((p) => p.payload.action === 'read')!;
    service.handleResult(10, readEntry.requestId!, { ok: false, error: '读取区间不合法' });
    await expect(collect).rejects.toThrow('读取区间不合法');
  });

  it('executor 声明的 size 超过帧内上限：不建流，直接报「文件过大」', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'a.bin', '/repo', 4);
    await flush();
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: 8, mtimeMs: 5 });
    await expect(opening).resolves.toEqual({ ok: false, error: '文件过大，上限 0MB' });
  });

  it('离线（投递落空 requestId=null）：直接返回 registry 的错误 future', async () => {
    const { registry } = makeRegistry();
    registry.sendDeliveryReadRequest.mockResolvedValue({
      requestId: null,
      future: Promise.resolve(JSON.stringify({ error: '本地执行端未连接' })),
      resolve: () => undefined,
    });
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    await expect(service.openStream(10, 7, 'a.bin', '/repo', MAX))
      .resolves.toEqual({ ok: false, error: '本地执行端未连接' });
  });

  it(`per-user 在途上限 ${DELIVERY_FETCH_MAX_INFLIGHT_PER_USER}：超出的请求不投递直接拒绝`, async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opened: Array<Promise<unknown>> = [];
    for (let i = 0; i < DELIVERY_FETCH_MAX_INFLIGHT_PER_USER; i += 1) {
      opened.push(service.openStream(10 + i, 7, `f${i}.bin`, '/repo', MAX));
    }
    await flush();
    expect(pendings).toHaveLength(DELIVERY_FETCH_MAX_INFLIGHT_PER_USER);
    await expect(service.openStream(99, 7, 'overflow.bin', '/repo', MAX))
      .resolves.toEqual({ ok: false, error: '当前有多个文件正在发送，请稍后重试' });
    // 收尾：让每个 open 都成功并立刻销毁流，释放计数
    for (const entry of pendings) {
      service.handleResult(10, entry.requestId!, { ok: true, size: 0, mtimeMs: 1 });
    }
    for (const p of opened) {
      const result = await p as { ok: boolean; stream?: { destroy(): void } };
      result.stream?.destroy();
    }
  });

  it('未绑定设备的广播会话：open 成功的连接被锁定，后续 read / digest / close 只发给它', async () => {
    const { registry, pendings } = makeRegistry(false); // directed=false = 用户级广播
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const bytes = Buffer.from('lock-source');
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    // 另一台在线执行端（没有这份文件）先回 ok:false：广播下只记录，不结算
    service.handleResult(10, pendings[0].requestId!, { ok: false, error: '文件不存在：a.bin' }, 'socket-b');
    // 正确设备随后成功：它认领这条流
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: bytes.length, mtimeMs: 9 }, 'socket-a');
    const opened = await opening;
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;

    const collect = (async () => {
      for await (const _chunk of opened.stream) { /* drain */ }
    })();
    await flush();
    const readEntry = pendings.find((p) => p.payload.action === 'read')!;
    expect(readEntry.socketId).toBe('socket-a');
    service.handleResult(10, readEntry.requestId!, {
      ok: true, data: bytes.toString('base64'), size: bytes.length, mtimeMs: 9,
    }, 'socket-a');
    await collect;

    const digesting = opened.digest();
    await flush();
    const digestEntry = pendings.find((p) => p.payload.action === 'digest')!;
    expect(digestEntry.socketId).toBe('socket-a');
    service.handleResult(10, digestEntry.requestId!, {
      ok: true, sha256: 'abc', size: bytes.length, mtimeMs: 9,
    }, 'socket-a');
    await digesting;

    opened.close();
    expect(registry.sendDeliveryClose).toHaveBeenCalledWith(10, expect.any(String), 'socket-a');
  });

  it('open 超限 / size 非法：给执行端补发 close，句柄不等到空闲回收', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'big.bin', '/repo', MAX);
    await flush();
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: MAX + 1, mtimeMs: 9 }, 'socket-a');
    await expect(opening).resolves.toEqual({ ok: false, error: '文件过大，上限 1MB' });
    expect(registry.sendDeliveryClose).toHaveBeenCalledWith(10, expect.any(String), 'socket-a');
  });

  it('read 超时：丢弃 pending，避免表项滞留', async () => {
    vi.useFakeTimers();
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry as unknown as LocalToolSessionRegistry);
    const opening = service.openStream(10, 7, 'a.bin', '/repo', MAX);
    await vi.advanceTimersByTimeAsync(0);
    service.handleResult(10, pendings[0].requestId!, { ok: true, size: 8, mtimeMs: 5 });
    const opened = await opening;
    if (!opened.ok) return;
    const collect = (async () => {
      for await (const _chunk of opened.stream) { /* drain */ }
    })();
    // 先挂上 reject 断言，再推进定时器——否则拒绝发生在断言之前会被记为 unhandled
    const assertion = expect(collect).rejects.toThrow('执行端读取超时，请重试');
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DELIVERY_READ_TIMEOUT_MS);
    await assertion;
    expect(registry.dropToolRequest).toHaveBeenCalled();
  });
});
