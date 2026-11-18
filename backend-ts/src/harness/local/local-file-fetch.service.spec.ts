import { Buffer } from 'node:buffer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FILE_FETCH_CHUNK_BYTES,
  FILE_FETCH_MAX_CHUNKS,
  FILE_FETCH_MAX_INFLIGHT_PER_USER,
  LocalFileFetchService,
} from './local-file-fetch.service.js';
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
 * 测试用 registry 桩。completeToolRequest(Error) 按真 registry 语义 settle 对应 future，
 * 否则拼装完成后 fetch 的 race 永远等不到结果。
 */
function makeRegistry() {
  const registry = {
    sendFileRequest: vi.fn(),
    completeToolRequest: vi.fn(),
    completeToolRequestError: vi.fn(),
  } as unknown as LocalToolSessionRegistry & Record<string, ReturnType<typeof vi.fn>>;
  const pendings: TestPending[] = [];
  registry.sendFileRequest.mockImplementation(() => {
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

/** fetch() 在首个 await 处让出：flush 微任务让 entry 完成登记再继续断言。 */
const flush = () => new Promise((r) => setTimeout(r, 0));

/** 构造一个分片帧（seq 从 1 起）。 */
function chunkFrame(total: number, seq: number, byteLength: number): { seq: number; total: number; data: string } {
  return { seq, total, data: Buffer.alloc(byteLength, seq).toString('base64') };
}

describe('LocalFileFetchService', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('assemblesOrderedChunksAndCompletesRegistryFuture', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalFileFetchService(registry);

    const outcomePromise = service.fetch(10, 7, 'screenshots/a.png', '/repo');
    await flush();
    expect(pendings[0].requestId).toBe('req-0');
    expect((service as unknown as { pending: Map<string, unknown> }).pending.has('req-0')).toBe(true);
    service.handleChunk(10, 'req-0', chunkFrame(2, 1, 4));
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 6));
    // 分片到齐即拼装并回填 registry future（不等 fetch 外部 resolve）
    expect(registry.completeToolRequest).toHaveBeenCalledTimes(1);
    const [, , finalJson] = registry.completeToolRequest.mock.calls[0];
    const assembled = Buffer.from((JSON.parse(finalJson as string) as { base64: string }).base64, 'base64');
    expect(assembled).toEqual(Buffer.concat([Buffer.alloc(4, 1), Buffer.alloc(6, 2)]));

    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.fileName).toBe('a.png');
    expect(outcome.mime).toBe('image/png');
    // registry future 只收最终字符串，语义零变化
    expect(await pendings[0].future).toBe(finalJson);
    // fetch 返回后条目必删：迟到分片走 Map 未命中静默丢弃
    expect((service as unknown as { pending: Map<string, unknown> }).pending.has('req-0')).toBe(false);
    service.handleChunk(10, 'req-0', chunkFrame(1, 1, 4));
    expect(registry.completeToolRequest).toHaveBeenCalledTimes(1);
  });

  it('acceptsChunksOutOfOrderAndIgnoresDuplicatesAndMismatchedTotal', async () => {
    const { registry } = makeRegistry();
    const service = new LocalFileFetchService(registry);

    const outcomePromise = service.fetch(10, 7, 'a.png', '/repo');
    await flush();
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 4)); // 乱序：先到第 2 片
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 4)); // 重复片：忽略
    service.handleChunk(10, 'req-0', { seq: 1, total: 3, data: chunkFrame(2, 1, 1).data }); // total 变化：忽略
    service.handleChunk(10, 'req-0', chunkFrame(2, 1, 3));
    expect(registry.completeToolRequest).toHaveBeenCalledTimes(1);
    const finalJson = registry.completeToolRequest.mock.calls[0][2] as string;
    const assembled = Buffer.from((JSON.parse(finalJson) as { base64: string }).base64, 'base64');
    expect(assembled).toEqual(Buffer.concat([Buffer.alloc(3, 1), Buffer.alloc(4, 2)]));
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
  });

  it('ignoresStubFramesMissingDataAndFramesForUnknownRequests', async () => {
    const { registry } = makeRegistry();
    const service = new LocalFileFetchService(registry);

    const outcomePromise = service.fetch(10, 7, 'a.png', '/repo');
    await flush();
    // mao-agent 截断存根帧：无 data → 静默忽略
    service.handleChunk(10, 'req-0', { truncated: true });
    service.handleChunk(10, 'req-0', { seq: 1, total: 1, data: '' }); // 空 data
    service.handleChunk(10, 'req-0', { seq: 1, total: 1 }); // 缺 data
    service.handleChunk(11, 'req-0', chunkFrame(1, 1, 4)); // sessionId 不匹配
    service.handleChunk(10, 'req-unknown', chunkFrame(1, 1, 4)); // 未知 requestId
    service.handleChunk(10, 'req-0', { seq: 0, total: 1, data: 'aGk=' }); // seq 越界
    service.handleChunk(10, 'req-0', { seq: 1, total: 21, data: 'aGk=' }); // total 超上限
    expect(registry.completeToolRequest).not.toHaveBeenCalled();

    service.handleChunk(10, 'req-0', chunkFrame(1, 1, 4));
    expect(registry.completeToolRequest).toHaveBeenCalledTimes(1);
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
  });

  it('acceptsErrorFrameOnlyBeforeAnyChunk', async () => {
    const { registry } = makeRegistry();
    const service = new LocalFileFetchService(registry);

    const outcomePromise = service.fetch(10, 7, 'a.png', '/repo');
    await flush();
    service.handleChunk(10, 'req-0', chunkFrame(1, 1, 4));
    // 已收到分片：error 帧不得误杀合法拼装（异机多执行端竞争护栏）
    service.handleChunk(10, 'req-0', { error: '执行端读盘失败' });
    expect(registry.completeToolRequestError).not.toHaveBeenCalled();
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);

    // 未收到分片时 error 帧可接受：立即失败并收敛 registry future
    const outcomePromise2 = service.fetch(10, 7, 'b.png', '/repo');
    await flush();
    service.handleChunk(10, 'req-1', { error: '执行端读盘失败' });
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(10, 'req-1', '执行端读盘失败');
    const outcome2 = await outcomePromise2;
    expect(outcome2.ok).toBe(false);
    if (!outcome2.ok) expect(outcome2.error).toBe('执行端读盘失败');
  });

  it('rejectsInvalidPathBeforeDispatching', async () => {
    const { registry } = makeRegistry();
    const service = new LocalFileFetchService(registry);
    for (const bad of [
      '', '../a.png', 'a/../b.png', '/abs/a.png', 'C:/a.png', 'a\\b.png', '\\\\host\\share\\a.png',
      'a.txt', 'a.svg', 'a.PNG/', 'dir//a.png', 'dir/./a.png',
    ]) {
      const outcome = await service.fetch(10, 7, bad, '/repo');
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('图片');
    }
    expect(registry.sendFileRequest).not.toHaveBeenCalled();
    // 大小写不敏感白名单 + 合法路径放行（桩 request：已 resolve 的错误 future，避免挂住真实定时器）
    registry.sendFileRequest.mockResolvedValueOnce((() => {
      const resolved = makePending(null);
      resolved.resolve(JSON.stringify({ error: '本地执行端未连接，无法读取本地文件' }));
      return resolved;
    })());
    const outcome = await service.fetch(10, 7, 'imgs/A.PNG', '/repo');
    expect(registry.sendFileRequest).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('本地执行端未连接，无法读取本地文件'); // 离线错误（非校验错误）
  });

  it('enforcesPerUserInFlightSoftCap', async () => {
    const { registry, pendings } = makeRegistry();
    const service = new LocalFileFetchService(registry);
    for (let i = 0; i < FILE_FETCH_MAX_INFLIGHT_PER_USER; i++) {
      void service.fetch(10, 7, `a${i}.png`, '/repo');
    }
    await flush(); // 8 个条目先完成登记，第 9 个同用户请求才会撞上限
    const capped = await service.fetch(10, 7, 'overflow.png', '/repo');
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.error).toContain('请求过多');
    // 其他用户不受影响：未被上限拦截（进入下发路径）
    const callsBefore = registry.sendFileRequest.mock.calls.length;
    void service.fetch(11, 8, 'b.png', '/repo2');
    await flush();
    expect(registry.sendFileRequest.mock.calls.length).toBe(callsBefore + 1);
    // 收尾 settle 全部挂起请求，避免 15s 真实定时器拖住测试进程
    for (const pending of pendings) pending.resolve(JSON.stringify({ base64: Buffer.alloc(0).toString('base64') }));
    await flush();
  });

  it('timesOutAndConvergesRegistryPending', async () => {
    vi.useFakeTimers();
    const { registry, pendings } = makeRegistry();
    const service = new LocalFileFetchService(registry);

    const outcomePromise = service.fetch(10, 7, 'a.png', '/repo');
    const assertion = outcomePromise.then((outcome) => {
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.error).toContain('超时');
      expect(registry.completeToolRequestError).toHaveBeenCalledWith(10, 'req-0', '图片读取超时，请稍后重试');
      expect((service as unknown as { pending: Map<string, unknown> }).pending.has('req-0')).toBe(false);
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    for (const pending of pendings) pending.resolve('{}');
  });

  it('offlineRequestReturnsFileSpecificOfflineError', async () => {
    // 离线路径：requestId=null 且 future 已立即 resolve 错误 JSON（registry.dispatchRequest 语义）
    const { registry } = makeRegistry();
    let offline!: TestPending;
    registry.sendFileRequest.mockImplementationOnce(() => {
      offline = makePending(null);
      offline.resolve(JSON.stringify({ error: '本地执行端未连接，无法读取本地文件' }));
      return Promise.resolve(offline);
    });
    const service = new LocalFileFetchService(registry);
    const outcome = await service.fetch(10, 7, 'a.png', '/repo');
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.error).toBe('本地执行端未连接，无法读取本地文件');
  });

  it('sweepsStaleEntriesAndConvergesTheirFutures', async () => {
    vi.useFakeTimers();
    const { registry, pendings } = makeRegistry();
    const service = new LocalFileFetchService(registry);
    void service.fetch(10, 7, 'a.png', '/repo');
    await vi.advanceTimersByTimeAsync(0);
    // 条目正常由 fetch() finally 必删（超时 15s 收敛）；TTL 清扫只兜异常残留——塞一个孤儿条目模拟
    const map = (service as unknown as { pending: Map<string, { sessionId: number; userId: number; createdAt: number }> }).pending;
    map.set('orphan', {
      sessionId: 10, userId: 7, createdAt: Date.now(), fileName: 'a.png', mime: 'image/png', chunks: [], total: null, received: 0, sourceSocketId: null,
    });
    await vi.advanceTimersByTimeAsync(31_000);
    // 下一次 fetch 触发惰性清扫
    const offline = makePending(null);
    offline.resolve('{}');
    registry.sendFileRequest.mockResolvedValueOnce(offline);
    await service.fetch(10, 7, 'b.png', '/repo');
    expect(registry.completeToolRequestError).toHaveBeenCalledWith(10, 'orphan', '图片读取超时，请稍后重试');
    expect(map.has('orphan')).toBe(false);
    for (const pending of pendings) pending.resolve('{}');
  });

  it('pinsSourceSocketOnFirstChunkAndDropsForeignFrames', async () => {
    const { registry } = makeRegistry();
    const service = new LocalFileFetchService(registry);
    const outcomePromise = service.fetch(10, 7, 'a.png', '/repo');
    await flush();
    service.handleChunk(10, 'req-0', chunkFrame(2, 1, 4), 'ws-a'); // 首片锁定来源 ws-a
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 4), 'ws-b'); // 异源第 2 片：丢弃
    service.handleChunk(10, 'req-0', { error: '另一台机器读盘失败' }, 'ws-b'); // 异源 error 帧也不误杀
    expect(registry.completeToolRequest).not.toHaveBeenCalled();
    service.handleChunk(10, 'req-0', chunkFrame(2, 2, 4), 'ws-a');
    expect(registry.completeToolRequest).toHaveBeenCalledTimes(1);
    const finalJson = registry.completeToolRequest.mock.calls[0][2] as string;
    const assembled = Buffer.from((JSON.parse(finalJson) as { base64: string }).base64, 'base64');
    expect(assembled).toEqual(Buffer.concat([Buffer.alloc(4, 1), Buffer.alloc(4, 2)]));
    const outcome = await outcomePromise;
    expect(outcome.ok).toBe(true);
  });

  it('chunkSizeMatchesPlanConstants', () => {
    // 方案 D3 两条硬约束的物化点：512KB → base64 ≈699KB，
    // 序列化整帧同时 < mao-agent 900KB 截断线（ws-client serializePayload）与服务端 1MB maxPayload
    expect(FILE_FETCH_CHUNK_BYTES).toBe(512 * 1024);
    expect(FILE_FETCH_MAX_CHUNKS).toBe(20);
    const chunkBase64 = Buffer.alloc(FILE_FETCH_CHUNK_BYTES).toString('base64');
    expect(chunkBase64.length).toBeLessThan(900_000);
    expect(chunkBase64.length).toBeLessThan(1_000_000);
  });
});
