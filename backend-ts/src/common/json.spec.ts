import { describe, expect, it } from 'vitest';
import { formatDateTime, mpPage, omitNull, toJacksonJson } from './json.js';

describe('json', () => {
  it('omits null fields like Jackson NON_NULL', () => {
    const json = toJacksonJson({ a: 1, b: null, c: undefined, d: 'ok' });
    expect(JSON.parse(json)).toEqual({ a: 1, d: 'ok' });
  });

  it('formats dates in Asia/Shanghai', () => {
    const date = new Date('2026-08-13T05:00:00.000Z');
    expect(formatDateTime(date)).toBe('2026-08-13 13:00:00');
  });

  it('serializes MyBatis-Plus page shape', () => {
    const page = mpPage([{ id: 1 }], 1, 1, 20);
    expect(page.records).toHaveLength(1);
    expect(page.total).toBe(1);
    expect(page.size).toBe(20);
    expect(page.current).toBe(1);
    expect(page.pages).toBe(1);
    expect(page.orders).toEqual([]);
    expect(page.optimizeCountSql).toBe(true);
    expect(omitNull({ id: 1, name: null })).toEqual({ id: 1 });
  });
});
