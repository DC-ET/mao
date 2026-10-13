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

describe('BackgroundTaskManager shell result normalization', () => {
  /** ShellSessionTool.formatResult 对「已完成、输出被截断」的后台命令产生的原始结果。 */
  function shellResultJson(over: Record<string, unknown>): string {
    return JSON.stringify({
      exit_code: 0,
      session_id: 'sh-1',
      output: 'x'.repeat(500),
      truncated: true,
      completed: true,
      current_workdir: '/work/pkg',
      output_file: '/work/runtime/users/1/sessions/11/sh-1.out',
      ...over,
    });
  }

  // round 1 BUG-6：归一化曾用白名单重建 payload，truncated/output_file/
  // current_workdir/shellExited 全被静默丢掉。注入给模型的摘要必须与同步路径
  // formatResult 同构，否则模型把被裁掉尾段的构建日志当成完整输出，也失去完整
  // 日志的读取入口（工具描述承诺「完整输出始终写入 output_file」）。
  it('keeps truncated / output_file / current_workdir when re-assembling a shell result', async () => {
    const manager = new BackgroundTaskManager();
    manager.submit(11, async () => shellResultJson({}));
    await flush();
    const injected = await manager.consumeCompletedResults(11);
    const text = Object.values(injected)[0]!;
    expect(text).toContain('"truncated": true');
    expect(text).toContain('output_file');
    expect(text).toContain('current_workdir');
  });

  it('keeps shellExited so the model stops awaiting a dead session', async () => {
    const manager = new BackgroundTaskManager();
    manager.submit(11, async () => shellResultJson({
      output: 'bye\n',
      truncated: false,
      message: 'shell 进程已退出，会话已关闭。常驻 bash 里的 exit/exec 会结束整个会话。',
      shellExited: true,
    }));
    await flush();
    const injected = await manager.consumeCompletedResults(11);
    expect(Object.values(injected)[0]).toContain('shellExited');
  });

  it('caps an oversized output while keeping the rest of the payload intact', async () => {
    const manager = new BackgroundTaskManager();
    manager.submit(11, async () => shellResultJson({ output: 'x'.repeat(20000) }));
    await flush();
    const injected = await manager.consumeCompletedResults(11);
    const text = Object.values(injected)[0]!;
    // 整体不得触发外层二次截断（那会拦腰切断 JSON），且截断后的 JSON 仍可解析
    expect(text.length).toBeLessThan(10000);
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(String(parsed.output).endsWith('... [truncated]')).toBe(true);
    expect(parsed.truncated).toBe(true);
    expect(parsed.output_file).toBe('/work/runtime/users/1/sessions/11/sh-1.out');
  });

  it('keeps session_id and the resume hint for an unfinished command', async () => {
    const manager = new BackgroundTaskManager();
    const taskId = manager.submit(1, async () => JSON.stringify({
      exit_code: 0,
      completed: false,
      output: 'x'.repeat(20000),
      session_id: 'sh-1',
      message: '等待超时，命令仍在运行。用 await_async 继续等待。',
    }));
    // awaitResult 主动领取路径同样过归一化
    const res = await manager.awaitResult(taskId, 2000, 1);
    expect(res.status).toBe('done');
    if (res.status !== 'done') return;
    const parsed = JSON.parse(res.result) as Record<string, unknown>;
    // 未结束的命令必须带上 session_id 与续等提示，否则模型无从继续 await_async
    expect(parsed.session_id).toBe('sh-1');
    expect(String(parsed.message)).toContain('await_async');
    expect(parsed.completed).toBe(false);
    expect(String(parsed.output).length).toBeLessThanOrEqual(10000);
  });
});
