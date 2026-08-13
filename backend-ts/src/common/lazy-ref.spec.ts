import { describe, expect, it } from 'vitest';
import { lazyRef } from './lazy-ref.js';

describe('lazyRef', () => {
  it('resolvesAfterHolderIsFilledAndBindsMethods', async () => {
    const holder: { svc?: { label: string; buildContext(id: number): Promise<string> } } = {};
    const proxy = lazyRef(() => holder.svc!);
    holder.svc = {
      label: 'ok',
      async buildContext(this: { label: string }, id: number) {
        return `${this.label}:${id}`;
      },
    };
    await expect(proxy.buildContext(9)).resolves.toBe('ok:9');
  });

  it('throwsWhenStillUninitialized', () => {
    const holder: { svc?: { buildContext: () => void } } = {};
    const proxy = lazyRef(() => holder.svc!);
    expect(() => proxy.buildContext()).toThrow(/not initialized/);
  });
});
