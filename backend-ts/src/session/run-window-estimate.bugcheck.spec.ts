import { describe, expect, it } from 'vitest';
import { estimatedStartMs, wallClockMs } from './run-window.js';

/**
 * Bugcheck：运行轨迹时间估算（2026-10-22 570f80d1 新增 startedAtMs）。
 *
 * VO 层口径：created_at 是结束时刻，startedAtMs = created_at − durationMs；
 * 任一侧缺失/解析失败必须为 null（不许补 0、不许用 createdAt 冒充）。
 * 前端时间条带与详情抽屉共用这个值，null/NaN/负数都会直接画出色条异常。
 */
describe('estimatedStartMs', () => {
  it('subtracts duration from the end timestamp', () => {
    const end = '2026-10-22T12:00:10.000Z';
    expect(estimatedStartMs(end, 5000)).toBe(Date.parse(end) - 5000);
  });

  it('returns null when either side is missing', () => {
    expect(estimatedStartMs(null, 5000)).toBeNull();
    expect(estimatedStartMs('2026-10-22T12:00:10.000Z', null)).toBeNull();
    expect(estimatedStartMs(null, null)).toBeNull();
    expect(estimatedStartMs(undefined, undefined)).toBeNull();
  });

  it('returns null when the timestamp cannot be parsed', () => {
    expect(estimatedStartMs('not-a-date', 5000)).toBeNull();
    expect(estimatedStartMs('', 5000)).toBeNull();
  });

  it('clamps a negative duration to the end instant instead of going backwards', () => {
    const end = '2026-10-22T12:00:10.000Z';
    expect(estimatedStartMs(end, -5000)).toBe(Date.parse(end));
    expect(estimatedStartMs(end, -1)).toBe(Date.parse(end));
  });

  it('handles a zero duration', () => {
    const end = '2026-10-22T12:00:10.000Z';
    expect(estimatedStartMs(end, 0)).toBe(Date.parse(end));
  });

  it('handles the java local datetime format with a space separator', () => {
    // DB 里是 '2026-10-22 12:00:10'，无时区；Date.parse 按本地时区解释
    const end = '2026-10-22 12:00:10';
    const parsed = estimatedStartMs(end, 2000);
    expect(parsed).not.toBeNull();
    expect(Number.isFinite(parsed!)).toBe(true);
  });

  it('never produces NaN or a negative epoch for realistic rows', () => {
    const rows: Array<[string | null, number | null]> = [
      ['2026-10-22 12:00:10', 100],
      ['2026-10-22 12:00:10', 0],
      ['2026-10-22 12:00:10', null],
      [null, 100],
      ['', 100],
      ['garbage', 100],
      ['2026-10-22 12:00:10', -100],
    ];
    for (const [createdAt, durationMs] of rows) {
      const v = estimatedStartMs(createdAt, durationMs);
      if (v == null) continue;
      expect(Number.isNaN(v)).toBe(false);
      expect(v).toBeGreaterThan(0);
    }
  });
});

describe('wallClockMs', () => {
  it('returns 0 for an empty window', () => {
    expect(wallClockMs([])).toBe(0);
  });

  it('spans from the earliest estimated start to the latest end', () => {
    const points = [
      { createdAt: '2026-10-22T12:00:10.000Z', durationMs: 5000 }, // start 12:00:05
      { createdAt: '2026-10-22T12:00:20.000Z', durationMs: 4000 }, // end 12:00:20
    ];
    expect(wallClockMs(points)).toBe(15_000);
  });

  it('treats a missing duration as an instant point', () => {
    const points = [
      { createdAt: '2026-10-22T12:00:10.000Z', durationMs: null },
      { createdAt: '2026-10-22T12:00:12.000Z', durationMs: null },
    ];
    expect(wallClockMs(points)).toBe(2000);
  });

  it('skips rows with unparseable timestamps', () => {
    const points = [
      { createdAt: 'garbage', durationMs: 100 },
      { createdAt: null, durationMs: 1000 },
    ];
    expect(wallClockMs(points)).toBe(0);
  });

  it('ignores an unparseable row and still measures the valid ones', () => {
    const points = [
      { createdAt: 'garbage', durationMs: 100 },
      { createdAt: '2026-10-22T12:00:10.000Z', durationMs: 1000 },
      { createdAt: null, durationMs: 1000 },
    ];
    // 只有一条有效点：start = 12:00:09，end = 12:00:10，跨度 1000
    expect(wallClockMs(points)).toBe(1000);
  });
});
