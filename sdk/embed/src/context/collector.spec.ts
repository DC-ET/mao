import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ContextCollector, hashString, stableStringify, truncateByBytes, utf8ByteLength } from './collector';

// node 环境无 window/document：stub 最小面
describe('ContextCollector', () => {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;

  beforeEach(() => {
    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://host/path?x=1' },
      localStorage: {
        getItem: () => null,
        setItem: () => undefined,
        removeItem: () => undefined,
      },
    };
    (globalThis as Record<string, unknown>).document = { title: '订单详情' };
  });

  afterEach(() => {
    (globalThis as Record<string, unknown>).window = originalWindow;
    (globalThis as Record<string, unknown>).document = originalDocument;
  });

  it('首次返回前缀，context 未变时第二次返回 null（无选中）', async () => {
    const c = new ContextCollector(() => ({ orderId: '1' }));
    const first = await c.buildPrefix(null);
    expect(first).toContain('[页面上下文]');
    expect(first).toContain('url: https://host/path?x=1');
    expect(first).toContain('orderId');
    const second = await c.buildPrefix(null);
    expect(second).toBeNull();
  });

  it('context 变化后重新拼装', async () => {
    let orderId = '1';
    const c = new ContextCollector(() => ({ orderId }));
    await c.buildPrefix(null);
    orderId = '2';
    const second = await c.buildPrefix(null);
    expect(second).toContain('"orderId":"2"');
  });

  it('选中文本每次都拼入', async () => {
    const c = new ContextCollector(() => ({ a: 1 }));
    await c.buildPrefix(null);
    const withSel = await c.buildPrefix('这段很重要');
    expect(withSel).toContain('[用户选中文本]');
    expect(withSel).toContain('这段很重要');
  });

  it('键序不同不影响 hash', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(hashString(stableStringify({ b: 1, a: 2 }))).toBe(hashString(stableStringify({ a: 2, b: 1 })));
  });

  it('超限 context 被标记截断', async () => {
    const big = { blob: 'x'.repeat(20_000) };
    const c = new ContextCollector(() => big);
    const prefix = await c.buildPrefix(null);
    expect(prefix).toContain('已截断');
    // 前缀整体不超过 8KB + 标头余量
    expect(utf8ByteLength(prefix ?? '')).toBeLessThan(8 * 1024 + 1024);
  });

  it('setOverride 命令式覆盖优先', async () => {
    const c = new ContextCollector(() => ({ from: 'supplier' }));
    c.setOverride({ from: 'override' });
    const prefix = await c.buildPrefix(null);
    expect(prefix).toContain('"from":"override"');
  });

  it('supplier 抛错不阻断', async () => {
    const c = new ContextCollector(() => {
      throw new Error('host bug');
    });
    const prefix = await c.buildPrefix(null);
    expect(prefix).toContain('url: https://host/path?x=1');
  });

  it('truncateByBytes 不切多字节字符', () => {
    const s = '中文'.repeat(100);
    const t = truncateByBytes(s, 10);
    expect(utf8ByteLength(t)).toBeLessThanOrEqual(10);
    // 10 字节最多容纳 3 个 3 字节汉字
    expect(t).toBe('中文中');
    expect(truncateByBytes('abc', 10)).toBe('abc');
  });

  it('url 变化即使 data 不变也重新注入（SPA 路由切换）', async () => {
    const c = new ContextCollector(() => ({ orderId: '1' }));
    const first = await c.buildPrefix(null);
    expect(first).toContain('url: https://host/path?x=1');
    // data 完全不变，只有 url 变
    (globalThis as Record<string, unknown>).window = {
      location: { href: 'https://host/other?x=2' },
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    };
    const second = await c.buildPrefix(null);
    expect(second).toContain('url: https://host/other?x=2');
  });

  it('title 变化也重新注入', async () => {
    const c = new ContextCollector(() => ({ orderId: '1' }));
    await c.buildPrefix(null);
    (globalThis as Record<string, unknown>).document = { title: '新标题' };
    const second = await c.buildPrefix(null);
    expect(second).toContain('title: 新标题');
  });

  it('上下文与选中文本同时超限时总前缀仍不超过 8KB', async () => {
    const c = new ContextCollector(() => ({ blob: 'x'.repeat(20_000) }));
    const prefix = await c.buildPrefix('选中'.repeat(5_000));
    expect(prefix).toContain('[页面上下文]');
    expect(prefix).toContain('[用户选中文本]');
    expect(utf8ByteLength(prefix ?? '')).toBeLessThanOrEqual(8 * 1024);
  });

  it('restoreHash 回滚变更基线后重发仍携带上下文', async () => {
    const c = new ContextCollector(() => ({ orderId: '1' }));
    const before = c.snapshotHash();
    const first = await c.buildPrefix(null);
    expect(first).toContain('[页面上下文]');
    // 发送失败：回滚基线
    c.restoreHash(before);
    const retry = await c.buildPrefix(null);
    expect(retry).toContain('[页面上下文]');
  });
});
