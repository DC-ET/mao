import { describe, expect, it, vi } from 'vitest';
import { FeishuActiveProgressRegistry } from './active-progress.js';
import { createFeishuAskMount } from './ask-mount.js';
import { FeishuAskFormStore } from './ask-form-store.js';
import type { FeishuProgressHandle } from './patched-progress.js';

function handle(overrides: Partial<FeishuProgressHandle> = {}): FeishuProgressHandle {
  return {
    isRunning: () => true,
    refresh: vi.fn(async () => undefined),
    renderCurrent: () => ({ schema: '2.0' }),
    ...overrides,
  };
}

describe('createFeishuAskMount', () => {
  it('挂上表单并刷新进度卡', async () => {
    const store = new FeishuAskFormStore();
    const progress = new FeishuActiveProgressRegistry();
    const current = handle();
    progress.bind(7, 'ou_sender', current);
    const mount = createFeishuAskMount(store, progress);
    const questions = [{ question: '选哪个？', multiSelect: false, options: [] }];
    await expect(mount.mount(7, 'req-1', questions)).resolves.toBe(true);
    expect(store.get(7, 'req-1')?.senderOpenId).toBe('ou_sender');
    expect(store.get(7, 'req-1')?.questions).toEqual(questions);
    expect(current.refresh).toHaveBeenCalledOnce();
  });

  it('没有正在执行的进度卡或发送者为空时不写入', async () => {
    const store = new FeishuAskFormStore();
    const progress = new FeishuActiveProgressRegistry();
    const mount = createFeishuAskMount(store, progress);
    await expect(mount.mount(7, 'req-1', [{ question: 'q' }])).resolves.toBe(false);
    expect(store.list(7)).toEqual([]);

    const current = handle();
    progress.bind(7, '', current);
    await expect(mount.mount(7, 'req-1', [{ question: 'q' }])).resolves.toBe(false);
    expect(store.list(7)).toEqual([]);
    expect(current.refresh).not.toHaveBeenCalled();
  });

  it('刷新时进度已结束则撤回刚写入的表单', async () => {
    const store = new FeishuAskFormStore();
    const progress = new FeishuActiveProgressRegistry();
    let checks = 0;
    progress.bind(7, 'ou_sender', handle({
      // 第一次 hasRunning 仍在执行；进入 refresh 时已经终态。
      isRunning: () => ++checks === 1,
    }));
    const mount = createFeishuAskMount(store, progress);
    await expect(mount.mount(7, 'req-1', [{ question: 'q' }])).resolves.toBe(false);
    expect(store.list(7)).toEqual([]);
  });

  it('刷新抛错时保留表单状态并返回 false', async () => {
    const store = new FeishuAskFormStore();
    const progress = new FeishuActiveProgressRegistry();
    progress.bind(7, 'ou_sender', handle({
      refresh: vi.fn(async () => { throw new Error('patch down'); }),
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const mount = createFeishuAskMount(store, progress);
      await expect(mount.mount(7, 'req-1', [{ question: 'q' }])).resolves.toBe(false);
      expect(store.get(7, 'req-1')).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('清除已挂上的提问后刷新；不存在的 requestId 不再刷新', async () => {
    const store = new FeishuAskFormStore();
    const progress = new FeishuActiveProgressRegistry();
    const current = handle();
    progress.bind(7, 'ou_sender', current);
    store.set(7, 'req-1', [{ question: 'q' }], 'ou_sender');
    const mount = createFeishuAskMount(store, progress);
    mount.clearRequest(7, 'req-1');
    expect(store.get(7, 'req-1')).toBeNull();
    expect(current.refresh).toHaveBeenCalledOnce();
    mount.clearRequest(7, 'req-missing');
    expect(current.refresh).toHaveBeenCalledOnce();
  });
});
