import { describe, expect, it } from 'vitest';
import { CompactionSignalBus } from './compaction-signal-bus.js';

describe('CompactionSignalBus', () => {
  it('signal 幂等：重复置位不叠加，consume 只命中一次', () => {
    const bus = new CompactionSignalBus();
    bus.signal(7);
    bus.signal(7);
    expect(bus.has(7)).toBe(true);
    expect(bus.consume(7)).toBe(true);
    expect(bus.has(7)).toBe(false);
    expect(bus.consume(7)).toBe(false);
  });

  it('无信号时 consume 返回 false 且不抛错', () => {
    const bus = new CompactionSignalBus();
    expect(bus.has(1)).toBe(false);
    expect(bus.consume(1)).toBe(false);
  });

  it('clear 丢弃陈旧信号：置位后 clear，consume 落空', () => {
    const bus = new CompactionSignalBus();
    bus.signal(3);
    bus.clear(3);
    expect(bus.has(3)).toBe(false);
    expect(bus.consume(3)).toBe(false);
  });

  it('信号按会话隔离，互不影响', () => {
    const bus = new CompactionSignalBus();
    bus.signal(10);
    bus.signal(11);
    expect(bus.consume(10)).toBe(true);
    expect(bus.has(10)).toBe(false);
    expect(bus.has(11)).toBe(true);
  });
});
