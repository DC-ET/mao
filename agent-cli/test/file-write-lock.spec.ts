import { describe, expect, it } from 'vitest';
import { withFileLock } from '../src/local/tools/file-write-lock';

describe('withFileLock', () => {
  it('serializes overlapping read-modify-write on the same path', async () => {
    let value = 0;
    await Promise.all([
      withFileLock('same.txt', async () => {
        const snapshot = value;
        await new Promise((r) => setTimeout(r, 30));
        value = snapshot + 1;
      }),
      withFileLock('same.txt', async () => {
        const snapshot = value;
        await new Promise((r) => setTimeout(r, 30));
        value = snapshot + 1;
      }),
    ]);
    expect(value).toBe(2);
  });

  it('does not serialize different paths', async () => {
    const order: string[] = [];
    let releaseA!: () => void;
    const holdA = new Promise<void>((r) => { releaseA = r; });
    const a = withFileLock('a.txt', async () => {
      order.push('a-start');
      await holdA;
      order.push('a-end');
    });
    await Promise.resolve();
    const b = withFileLock('b.txt', async () => {
      order.push('b');
    });
    await b;
    releaseA();
    await a;
    expect(order).toEqual(['a-start', 'b', 'a-end']);
  });
});
