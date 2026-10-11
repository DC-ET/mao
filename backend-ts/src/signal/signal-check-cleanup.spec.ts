import { describe, expect, it, vi } from 'vitest';
import type { MysqlSignalCheckRepository } from './signal.repository.js';
import { SignalCheckCleanup } from './signal-check-cleanup.js';

describe('SignalCheckCleanup', () => {
  it('deletes rows older than the configured retention', async () => {
    const deleteBatch = vi.fn(async () => 10);
    const cleanup = new SignalCheckCleanup(
      { deleteBatch } as unknown as MysqlSignalCheckRepository,
      async () => 30,
    );
    const removed = await cleanup.cleanupOnce(Date.now());
    expect(removed).toBe(10);
    const [cutoff, limit] = deleteBatch.mock.calls[0]!;
    expect(limit).toBe(5000);
    // cutoff 约 30 天前
    const days = (Date.now() - new Date(cutoff as string).getTime()) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(30);
  });

  it('keeps deleting in batches until a short batch arrives', async () => {
    const deleteBatch = vi.fn()
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(42);
    const cleanup = new SignalCheckCleanup(
      { deleteBatch } as unknown as MysqlSignalCheckRepository,
      async () => 90,
    );
    const removed = await cleanup.cleanupOnce();
    expect(deleteBatch).toHaveBeenCalledTimes(3);
    expect(removed).toBe(10042);
  });

  it('stops after the batch ceiling even if rows remain', async () => {
    const deleteBatch = vi.fn(async () => 5000);
    const cleanup = new SignalCheckCleanup(
      { deleteBatch } as unknown as MysqlSignalCheckRepository,
      async () => 90,
    );
    const removed = await cleanup.cleanupOnce();
    expect(deleteBatch).toHaveBeenCalledTimes(20);
    expect(removed).toBe(100000);
  });

  it('falls back to 90 days for a non-positive retention', async () => {
    const deleteBatch = vi.fn(async () => 0);
    const cleanup = new SignalCheckCleanup(
      { deleteBatch } as unknown as MysqlSignalCheckRepository,
      async () => -5,
    );
    await cleanup.cleanupOnce();
    const cutoff = new Date(deleteBatch.mock.calls[0]![0] as string).getTime();
    const days = (Date.now() - cutoff) / (24 * 60 * 60 * 1000);
    expect(Math.round(days)).toBe(90);
  });

  it('does nothing after stop()', async () => {
    const deleteBatch = vi.fn(async () => 5);
    const cleanup = new SignalCheckCleanup(
      { deleteBatch } as unknown as MysqlSignalCheckRepository,
      async () => 90,
    );
    cleanup.stop();
    expect(await cleanup.cleanupOnce()).toBe(0);
    expect(deleteBatch).not.toHaveBeenCalled();
  });
});
