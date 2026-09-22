import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BackgroundTaskManager } from './background-task-manager.js';

const { logs } = vi.hoisted(() => ({ logs: [] as Array<{ level: string; message: string }> }));
vi.mock('../log.js', () => ({
  harnessLog: (level: string, message: string) => { logs.push({ level, message }); },
}));

const warnings = (): string[] => logs.filter((l) => l.level === 'warn').map((l) => l.message);

const MINUTE = 60_000;

/** 让 submit 挂的 then 回调跑完（entry.done 置位）。 */
async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('BackgroundTaskManager', () => {
  beforeEach(() => { logs.length = 0; });

  it('warns about an overdue task only in its own session consume pass', async () => {
    let now = 0;
    const manager = new BackgroundTaskManager(() => now);
    manager.submit(7, () => new Promise<string>(() => { /* 长时构建 */ }));

    now = 31 * MINUTE;
    // 别的会话路过不该替所属会话打这条「仍为你保留待交付」的告警
    await manager.consumeCompletedResults(8);
    await manager.consumeCompletedResults(null);
    expect(warnings()).toEqual([]);

    await manager.consumeCompletedResults(7);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toContain('still running after 30 minutes');
    expect(warnings()[0]).toContain('session=7');

    // 同一任务只告警一次，后续轮次不再重复
    now = 60 * MINUTE;
    await manager.consumeCompletedResults(7);
    expect(warnings()).toHaveLength(1);
  });

  it('keeps a task running past the 30-minute threshold and still delivers its result', async () => {
    let now = 0;
    const manager = new BackgroundTaskManager(() => now);
    let finish!: (value: string) => void;
    const taskId = manager.submit(7, () => new Promise<string>((resolve) => { finish = resolve; }));

    now = 31 * MINUTE;
    expect(await manager.consumeCompletedResults(7)).toEqual({});
    // 超时未完成的任务不得被移出登记表，否则 await_async 会误报「不存在」
    expect(await manager.awaitResult(taskId, 0, 7)).toEqual({ status: 'pending' });

    now = 45 * MINUTE;
    finish(JSON.stringify({ exit_code: 0, completed: true, output: 'build ok' }));
    await flush();
    const consumed = await manager.consumeCompletedResults(7);
    expect(Object.keys(consumed)).toEqual([taskId]);
    expect(consumed[taskId]).toContain('build ok');
  });

  it('delivers a late failure instead of dropping it', async () => {
    let now = 0;
    const manager = new BackgroundTaskManager(() => now);
    let fail!: (e: Error) => void;
    const taskId = manager.submit(7, () => new Promise<string>((_, reject) => { fail = reject; }));

    now = 40 * MINUTE;
    await manager.consumeCompletedResults(7);
    fail(new Error('boom'));
    await flush();
    expect((await manager.consumeCompletedResults(7))[taskId]).toBe('Error: boom');
  });

  it('drops an unfinished task only after the hard expiry', async () => {
    let now = 0;
    const manager = new BackgroundTaskManager(() => now);
    const taskId = manager.submit(7, () => new Promise<string>(() => { /* 永不结束 */ }));

    now = 23 * 60 * MINUTE;
    await manager.consumeCompletedResults(7);
    expect(await manager.awaitResult(taskId, 0, 7)).toEqual({ status: 'pending' });

    // 硬过期回收不限所属会话：会话可能已死、永远不会再来消费
    now = 25 * 60 * MINUTE;
    await manager.consumeCompletedResults(8);
    expect(await manager.awaitResult(taskId, 0, 7)).toEqual({ status: 'not_found' });
    expect(warnings().some((m) => m.includes('hard expiry'))).toBe(true);
  });

  it('reclaims another session finished result after the threshold', async () => {
    let now = 0;
    const manager = new BackgroundTaskManager(() => now);
    const taskId = manager.submit(7, () => 'done');
    await flush();

    // 非所属会话不领取，也不在阈值内回收
    expect(await manager.consumeCompletedResults(8)).toEqual({});
    expect(await manager.awaitResult(taskId, 0, 7)).toEqual({ status: 'done', result: 'done' });
  });

  it('does not hand a task result to another session', async () => {
    const manager = new BackgroundTaskManager();
    const taskId = manager.submit(7, () => 'secret');
    await flush();
    expect(await manager.awaitResult(taskId, 0, 9)).toEqual({ status: 'not_found' });
    expect(await manager.consumeCompletedResults(7)).toEqual({ [taskId]: 'secret' });
  });
});
