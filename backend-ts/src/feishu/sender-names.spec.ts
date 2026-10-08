import { describe, expect, it, vi } from 'vitest';
import { batchResolveFeishuUserNames } from './sender-names.js';

describe('batchResolveFeishuUserNames', () => {
  it('queries open ids in batches of 50 and maps user_id to name', async () => {
    const batches: string[][] = [];
    const basicBatch = vi.fn(async (req: { data: { user_ids: string[] } }) => {
      batches.push([...req.data.user_ids]);
      return {
        code: 0,
        data: { users: req.data.user_ids.map((id) => ({ user_id: id, name: `姓名${id}` })) },
      };
    });
    const ids = Array.from({ length: 51 }, (_, index) => `ou_${index}`);
    const names = await batchResolveFeishuUserNames(basicBatch, [...ids, ids[0]]);
    expect(batches.map((batch) => batch.length)).toEqual([50, 1]);
    expect(batches[0][0]).toBe('ou_0');
    expect(batches[1]).toEqual(['ou_50']);
    expect(basicBatch).toHaveBeenCalledWith(expect.objectContaining({ params: { user_id_type: 'open_id' } }));
    expect(names.get('ou_0')).toBe('姓名ou_0');
    expect(names.get('ou_50')).toBe('姓名ou_50');
    expect(names.size).toBe(51);
  });

  it('reuses cached names and does not request them again', async () => {
    const cache = new Map<string, string>([['ou_cached', '张三']]);
    const basicBatch = vi.fn(async (req: { data: { user_ids: string[] } }) => ({
      code: 0,
      data: { users: req.data.user_ids.map((id) => ({ user_id: id, name: '李四' })) },
    }));
    const names = await batchResolveFeishuUserNames(basicBatch, ['ou_cached', 'ou_new'], {
      get: (id) => cache.get(id),
      set: (id, name) => { cache.set(id, name); },
    });
    expect(basicBatch).toHaveBeenCalledOnce();
    expect(basicBatch.mock.calls[0][0].data.user_ids).toEqual(['ou_new']);
    expect(names.get('ou_cached')).toBe('张三');
    expect(names.get('ou_new')).toBe('李四');
    expect(cache.get('ou_new')).toBe('李四');
  });

  it('returns the names it already has when a batch fails or the api returns an error code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const thrown = await batchResolveFeishuUserNames(async () => { throw new Error('network'); }, ['ou_a']);
      expect(thrown.size).toBe(0);
      const denied = await batchResolveFeishuUserNames(async () => ({ code: 230027, data: { users: [] } }), ['ou_b']);
      expect(denied.size).toBe(0);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=230027'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('code=unknown'));
    } finally {
      warn.mockRestore();
    }
  });
});
