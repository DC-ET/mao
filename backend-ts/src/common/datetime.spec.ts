import { describe, expect, it, vi, afterEach } from 'vitest';
import { javaLocalDateTimeString, nowSql, nowSqlMs } from './datetime.js';

describe('nowSql / nowSqlMs', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('nowSql keeps second precision for legacy DATETIME columns', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 13, 45, 57, 123));
    expect(nowSql()).toBe('2026-10-09 13:45:57');
  });

  it('nowSqlMs emits exactly three fractional digits', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 13, 45, 57, 123));
    expect(nowSqlMs()).toBe('2026-10-09 13:45:57.123');
  });

  it('nowSqlMs zero-pads sub-100ms values', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 9, 13, 45, 57, 7));
    expect(nowSqlMs()).toBe('2026-10-09 13:45:57.007');
  });

  it('nowSqlMs matches the nowSql prefix so both write the same instant', () => {
    const ms = nowSqlMs();
    expect(ms.startsWith(`${nowSql()}.`)).toBe(true);
  });
});

describe('javaLocalDateTimeString with millisecond inputs', () => {
  it('keeps fractional seconds from DATETIME(3) strings', () => {
    expect(javaLocalDateTimeString('2026-10-09 13:45:57.123')).toBe('2026-10-09T13:45:57.123');
  });

  it('drops trailing zeros the way Java LocalDateTime.toString does', () => {
    expect(javaLocalDateTimeString('2026-10-09 13:45:57.100')).toBe('2026-10-09T13:45:57.1');
    expect(javaLocalDateTimeString('2026-10-09 13:45:57.000')).toBe('2026-10-09T13:45:57');
  });

  it('still parses legacy second-precision rows unchanged', () => {
    expect(javaLocalDateTimeString('2026-10-09 13:45:57')).toBe('2026-10-09T13:45:57');
  });

  it('keeps the seconds field when only the fraction is present (Java parity)', () => {
    expect(javaLocalDateTimeString('2026-10-09 13:45:00.000')).toBe('2026-10-09T13:45:00');
  });

  it('omits seconds entirely when they are zero and there is no fraction (Java parity)', () => {
    expect(javaLocalDateTimeString('2026-10-09 13:45:00')).toBe('2026-10-09T13:45');
  });
});
