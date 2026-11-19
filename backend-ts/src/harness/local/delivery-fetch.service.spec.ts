import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DELIVERY_FETCH_CHUNK_BYTES,
  DELIVERY_FETCH_MAX_INFLIGHT_PER_USER,
  DELIVERY_FETCH_TIMEOUT_SECONDS,
  LocalDeliveryFetchService,
} from './delivery-fetch.service.js';
import type { LocalToolSessionRegistry } from './local-tool-session-registry.js';

/** 可手动 settle 的 pending：模拟 registry 的 PendingLocalToolRequest。 */
interface TestPending {
  requestId: string | null;
  future: Promise<string>;
  resolve: (v: string) => void;
}

function makePending(requestId: string | null): TestPending {
  let resolve!: (v: string) => void;
  const future = new Promise<string>((r) => { resolve = r; });
  return { requestId, future, resolve };
}

/**
 * registry 桩：completeToolRequest(Error) 按真 registry 语义 settle 对应 future，
 * 否则拼装完成后 fetch 的 race 永远等不到结果。
 */
function makeRegistry() {
  const registry = {
    sendDeliveryRequest: vi.fn(),
    completeToolRequest: vi.fn(),
    completeToolRequestError: vi.fn(),
  } as unknown as LocalToolSessionRegistry & Record<string, ReturnType<typeof vi.fn>>;
  const pendings: TestPending[] = [];
  registry.sendDeliveryRequest.mockImplementation(() => {
    const pending = makePending(`req-${pendings.length}`);
    pendings.push(pending);
    return Promise.resolve(pending);
  });
  registry.completeToolRequest.mockImplementation((_sessionId: unknown, requestId: string, result: string) => {
    pendings.find((p) => p.requestId === requestId)?.resolve(result);
  });
  registry.completeToolRequestError.mockImplementation((_sessionId: unknown, requestId: string, error: string) => {
    pendings.find((p) => p.requestId === requestId)?.resolve(JSON.stringify({ error }));
  });
  return { registry, pendings };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const MAX = 1024 * 1024;

function chunkFrame(total: number, seq: number, byteLength: number): { seq: number; total: number; data: string } {
  return { seq, total, data: Buffer.alloc(byteLength, seq).toString('base64') };
}

describe('LocalDeliveryFetchService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('assemblesOrderedChunksAndCompletesRegistryFuture（base64 回填，字节不进工具结果）', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry);

    const outcomePromise = service.fetch(10, 7, 'report.pdf', '/repo', MAX);
    await flush();
    expect(pendings[0].requestId).toBe('req-0');
    expect((service as unknown as { pending: Map<string, unknown> }).pending.has('req-0')).toBe(true);
    service.handleChunk(10, 'req-0', chunkFrame(2, 1, 4), 'ws-1');
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 6), 'ws-1');
    expect(registry.completeToolRequest).toHaveBeenCalledTimes(1);
    const [, , finalJson] = registry.completeToolRequest.mock.calls[0];
    const assembled = Buffer.from((JSON.parse(finalJson as string) as { base64: string }).base64, 'base64');
    expect(assembled).toEqual(Buffer.concat([Buffer.alloc(4, 1), Buffer.alloc(6, 2)]));

    await expect(outcomePromise).resolves.toEqual({ ok: true, bytes: assembled });
    // 完成即删条目（不留缓冲）
    expect((service as unknown as { pending: Map<string, unknown> }).pending.has('req-0')).toBe(false);
  });

  it('重复片 / total 不一致 / seq 越界 / 超片上限 / 超 base64 上限一律丢弃', async () => {
    const { registry } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry);
    const outcome = service.fetch(10, 7, 'a.bin', '/repo', DELIVERY_FETCH_CHUNK_BYTES * 2);
    await flush();

    service.handleChunk(10, 'req-0', chunkFrame(2, 1, 4), 'ws-1');
    service.handleChunk(10, 'req-0', chunkFrame(2, 1, 4), 'ws-1'); // 重复片
    service.handleChunk(10, 'req-0', chunkFrame(3, 2, 4), 'ws-1'); // total 与首片不一致
    service.handleChunk(10, 'req-0', chunkFrame(2, 0, 4), 'ws-1'); // seq 越界
    service.handleChunk(10, 'req-0', chunkFrame(2, 3, 4), 'ws-1'); // seq > total
    service.handleChunk(10, 'req-0', chunkFrame(3, 1, 4), 'ws-1'); // total 超 maxBytes 片数
    service.handleChunk(10, 'req-0', { seq: 1, total: 2, data: 'x'.repeat(900_001) }, 'ws-1'); // base64 超限
    service.handleChunk(10, 'req-0', { seq: 1, total: 2, data: Buffer.alloc(DELIVERY_FETCH_CHUNK_BYTES + 1).toString('base64') }, 'ws-1');
    expect(registry.completeToolRequest).not.toHaveBeenCalled();
    expect(registry.completeToolRequestError).not.toHaveBeenCalled();

    // 合法第 2 片到达后仍能完成（非法片没有污染缓冲）
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 6), 'ws-1');
    await expect(outcome).resolves.toMatchObject({ ok: true });
  });

  it('首片锁定来源连接：异源分片丢弃，同源补片仍能完成', async () => {
    const { registry } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry);
    const outcome = service.fetch(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    service.handleChunk(10, 'req-0', chunkFrame(2, 1, 4), 'ws-1');
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 6), 'ws-2'); // 异源
    expect(registry.completeToolRequest).not.toHaveBeenCalled();
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 6), 'ws-1');
    expect(registry.completeToolRequest).toHaveBeenCalledTimes(1);
    await expect(outcome).resolves.toMatchObject({ ok: true });
  });

  it('会话不匹配的分片丢弃', async () => {
    const { registry } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry);
    const outcome = service.fetch(10, 7, 'a.bin', '/repo', MAX);
    await flush();
    service.handleChunk(11, 'req-0', chunkFrame(1, 1, 4), 'ws-1');
    expect(registry.completeToolRequest).not.toHaveBeenCalled();
    service.handleChunk(10, 'req-0', chunkFrame(1, 1, 4), 'ws-1');
    await expect(outcome).resolves.toMatchObject({ ok: true });
  });

  it('拼装后超过 maxBytes：回错误并收敛 future', async () => {
    const { registry } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry);
    const outcome = service.fetch(10, 7, 'a.bin', '/repo', 6);
    await flush();
    // maxBytes=6 只允许 1 片；单片 8 字节拼装后超限
    service.handleChunk(10, 'req-0', chunkFrame(1, 1, 8), 'ws-1');
    expect(registry.completeToolRequestError).toHaveBeenCalledTimes(1);
    await expect(outcome).resolves.toEqual({ ok: false, error: '文件过大，上限 0MB' });
  });

  it('超时：返回离线口径错误并 completeToolRequestError（执行端静默时由这里收口）', async () => {
    vi.useFakeTimers();
    const { registry, pendings } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry);
    const outcome = service.fetch(10, 7, 'a.bin', '/repo', MAX);
    await Promise.resolve();
    await Promise.resolve();
    expect(pendings).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(DELIVERY_FETCH_TIMEOUT_SECONDS * 1000);
    await expect(outcome).resolves.toEqual({ ok: false, error: '执行端不在线或版本过旧，无法读取本机文件' });
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(10, 'req-0', expect.stringContaining('执行端不在线'));
    expect((service as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });

  it('离线（投递落空 requestId=null）：直接返回 registry 的错误 future', async () => {
    const { registry } = makeRegistry();
    registry.sendDeliveryRequest.mockResolvedValue({
      requestId: null,
      future: Promise.resolve(JSON.stringify({ error: '本地执行端未连接' })),
      resolve: () => {},
    });
    const service = new LocalDeliveryFetchService(registry);
    await expect(service.fetch(10, 7, 'a.bin', '/repo', MAX)).resolves.toEqual({ ok: false, error: '本地执行端未连接' });
    expect(registry.completeToolRequest).not.toHaveBeenCalled();
  });

  it(`per-user 在途上限 ${DELIVERY_FETCH_MAX_INFLIGHT_PER_USER}：超出的请求不投递直接拒绝`, async () => {
    const { registry } = makeRegistry();
    const service = new LocalDeliveryFetchService(registry);
    const running = Array.from({ length: DELIVERY_FETCH_MAX_INFLIGHT_PER_USER }, (_, i) =>
      service.fetch(10 + i, 7, `f${i}.bin`, '/repo', MAX));
    await flush();
    expect(registry.sendDeliveryRequest).toHaveBeenCalledTimes(DELIVERY_FETCH_MAX_INFLIGHT_PER_USER);
    await expect(service.fetch(99, 7, 'overflow.bin', '/repo', MAX)).resolves.toEqual({
      ok: false, error: '执行端不在线或版本过旧，无法读取本机文件',
    });
    // 收尾在途请求，避免留下未 settle 的 promise
    for (let i = 0; i < DELIVERY_FETCH_MAX_INFLIGHT_PER_USER; i++) {
      service.handleChunk(10 + i, `req-${i}`, chunkFrame(1, 1, 2), 'ws-1');
    }
    await Promise.all(running);
  });
});
