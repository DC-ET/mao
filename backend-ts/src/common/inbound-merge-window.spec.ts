import { describe, expect, it, vi } from 'vitest';
import { InboundMergeWindow } from './inbound-merge-window.js';

interface Entry {
  id: string;
  key: string;
  join: boolean;
  seq?: number;
}

function makeWindow(
  onFlush: (batch: Entry[]) => Promise<void>,
  overrides: Partial<{ windowMs: number; seqOf: (e: Entry) => number | undefined }> = {},
): InboundMergeWindow<Entry> {
  return new InboundMergeWindow<Entry>({
    windowMs: 30,
    keyOf: (e) => e.key,
    dedupeKeyOf: (e) => e.id,
    canJoin: (e) => e.join,
    seqOf: overrides.seqOf,
    onFlush,
    ...(overrides.windowMs != null ? { windowMs: overrides.windowMs } : {}),
  });
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('InboundMergeWindow', () => {
  it('窗口期内多条合并为一次 onFlush，顺序为到达顺序', async () => {
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => { calls.push(batch); });
    await window.submit({ id: 'a', key: 'k', join: true });
    await window.submit({ id: 'b', key: 'k', join: true });
    await window.submit({ id: 'c', key: 'k', join: true });
    await wait(80);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('批内按到达序号排序，与 submit 完成顺序无关', async () => {
    const calls: Entry[][] = [];
    // 模拟飞书「转发慢展开、附言先 submit」：submit 顺序 b(seq 2)、a(seq 1)，批内应按 seq 排为 a、b。
    const window = makeWindow(async (batch) => { calls.push(batch); }, { seqOf: (e) => e.seq });
    await window.submit({ id: 'b', key: 'k', join: true, seq: 2 });
    await window.submit({ id: 'a', key: 'k', join: true, seq: 1 });
    await wait(80);
    expect(calls[0].map((e) => e.id)).toEqual(['a', 'b']);
  });

  it('单条消息窗口到点后单次 onFlush', async () => {
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => { calls.push(batch); });
    await window.submit({ id: 'a', key: 'k', join: true });
    await wait(80);
    expect(calls).toEqual([[{ id: 'a', key: 'k', join: true }]]);
  });

  it('windowMs=0 时立即单条触发，无窗口延迟', async () => {
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => { calls.push(batch); }, { windowMs: 0 });
    await window.submit({ id: 'a', key: 'k', join: true });
    await window.submit({ id: 'b', key: 'k', join: true });
    // 两条都同步完成触发（submit 已 await 到 onFlush 返回），无需等待定时器。
    expect(calls).toHaveLength(2);
    expect(calls[0].map((e) => e.id)).toEqual(['a']);
    expect(calls[1].map((e) => e.id)).toEqual(['b']);
  });

  it('豁免消息到达先冲刷在途批次，再单独触发', async () => {
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => { calls.push(batch); });
    await window.submit({ id: 'a', key: 'k', join: true });
    await window.submit({ id: 'img', key: 'k', join: false });
    // 豁免路径同步等到批次 onFlush 返回后才触发自己，此时定时器尚未到点。
    expect(calls).toHaveLength(2);
    expect(calls[0].map((e) => e.id)).toEqual(['a']);
    expect(calls[1].map((e) => e.id)).toEqual(['img']);
    await wait(80);
    expect(calls).toHaveLength(2); // 定时器已被豁免冲刷取消，不重复触发
  });

  it('定时器先到点再到达豁免消息：不重复触发同一批', async () => {
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => { calls.push(batch); });
    await window.submit({ id: 'a', key: 'k', join: true });
    await wait(80); // 定时器到点，冲刷 [a]
    await window.submit({ id: 'img', key: 'k', join: false });
    expect(calls).toHaveLength(2);
    expect(calls[0].map((e) => e.id)).toEqual(['a']);
    expect(calls[1].map((e) => e.id)).toEqual(['img']);
  });

  it('同去重键重复投递被丢弃', async () => {
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => { calls.push(batch); });
    await window.submit({ id: 'a', key: 'k', join: true });
    await window.submit({ id: 'a', key: 'k', join: true });
    await wait(80);
    expect(calls).toHaveLength(1);
    expect(calls[0].map((e) => e.id)).toEqual(['a']);
  });

  it('不同键互不影响', async () => {
    const calls: Array<{ key: string; ids: string[] }> = [];
    const window = makeWindow(async (batch) => {
      calls.push({ key: batch[0].key, ids: batch.map((e) => e.id) });
    });
    await window.submit({ id: 'a', key: 'k1', join: true });
    await window.submit({ id: 'b', key: 'k2', join: true });
    await wait(80);
    expect(calls).toHaveLength(2);
    expect(calls.map((c) => c.ids)).toEqual([['a'], ['b']]);
  });

  it('flushAll 冲刷全部在途窗口', async () => {
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => { calls.push(batch); });
    await window.submit({ id: 'a', key: 'k1', join: true });
    await window.submit({ id: 'b', key: 'k2', join: true });
    await window.flushAll();
    expect(calls).toHaveLength(2);
    await wait(80);
    expect(calls).toHaveLength(2); // 定时器已清，不重复
  });

  it('onFlush 抛错只记日志，键状态复位后可继续服务', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const calls: Entry[][] = [];
    const window = makeWindow(async (batch) => {
      calls.push(batch);
      if (batch[0].id === 'a') throw new Error('boom');
    });
    await expect(window.submit({ id: 'a', key: 'k', join: true })).resolves.toBeUndefined();
    await wait(80);
    expect(calls).toHaveLength(1);
    expect(errorSpy).toHaveBeenCalled();
    // 失败不影响该键后续消息
    await window.submit({ id: 'b', key: 'k', join: true });
    await wait(80);
    expect(calls).toHaveLength(2);
    expect(calls[1].map((e) => e.id)).toEqual(['b']);
    errorSpy.mockRestore();
  });

  it('豁免/禁用路径的 onFlush 异常向上抛（与加窗前的 process 契约一致）', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const window = makeWindow(async () => { throw new Error('boom'); }, { windowMs: 0 });
    await expect(window.submit({ id: 'a', key: 'k', join: true })).rejects.toThrow('boom');
    // 定时器驱动的 flush 无调用方：异常由组件记日志，不产生未处理拒绝
    const windowed = makeWindow(async () => { throw new Error('boom2'); });
    await windowed.submit({ id: 'b', key: 'k', join: true });
    await wait(80);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('豁免消息只等批次 flush 启动，不被在途执行阻塞', async () => {
    const calls: Entry[][] = [];
    let releaseBatch = (): void => undefined;
    const window = makeWindow(async (batch) => {
      calls.push(batch);
      if (batch[0].id === 'a') {
        await new Promise<void>((resolve) => { releaseBatch = resolve; });
      }
    });
    await window.submit({ id: 'a', key: 'k', join: true });
    await window.submit({ id: 'img', key: 'k', join: false });
    // 批次 [a] 的执行一直挂起，豁免消息 [img] 已在其启动后立即触发。
    expect(calls.map((c) => c.map((e) => e.id))).toEqual([['a'], ['img']]);
    releaseBatch();
    await wait(20);
  });

  it('在途 flush 执行期间到达的新消息各自成批，不丢不并', async () => {
    const calls: Entry[][] = [];
    let releaseBatch = (): void => undefined;
    const window = makeWindow(async (batch) => {
      calls.push(batch);
      if (batch[0].id === 'a') {
        await new Promise<void>((resolve) => { releaseBatch = resolve; });
      }
    });
    await window.submit({ id: 'a', key: 'k', join: true });
    await wait(50); // [a] 开始执行并挂起
    await window.submit({ id: 'b', key: 'k', join: true });
    await window.submit({ id: 'c', key: 'k', join: true });
    await wait(80); // [b, c] 成批触发（与 [a] 执行重叠，由各端 handler 串行化）
    expect(calls.map((c) => c.map((e) => e.id))).toEqual([['a'], ['b', 'c']]);
    releaseBatch();
    await wait(20);
  });
});
