import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeishuCardProgressListener, countCompletedAgentRounds } from './card-progress-listener.js';

describe('FeishuCardProgressListener', () => {
  it('updates one round with content and tool summary, then completes', async () => {
    const updates: Array<{ status: string; round: number; content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (status, round, content, tools) => { updates.push({ status, round, content, tools }); },
    });
    listener.onRoundStart(1);
    listener.onContentDelta('摘要');
    listener.onToolCallStart({ id: 'tool-1', function: { name: 'read_file', arguments: '{}' } });
    listener.onToolCallResult('tool-1', '读取成功');
    listener.onRoundEnd(1);
    await listener.complete('最终答案');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual([
      { status: 'RUNNING', round: 1, content: '正在思考…', tools: [] },
      { status: 'RUNNING', round: 1, content: '摘要', tools: ['read_file：执行中…'] },
      { status: 'RUNNING', round: 1, content: '摘要', tools: ['read_file：读取 文件'] },
      { status: 'COMPLETED', round: 1, content: '最终答案', tools: [] },
    ]);
  });

  it('pushes a thinking placeholder when a round starts before any content arrives', async () => {
    // 首次思考期间卡片不能停在首卡「任务已接收，正在准备执行。」：轮次一开始就推思考态。
    const updates: Array<{ status: string; round: number; content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (status, round, content, tools) => { updates.push({ status, round, content, tools }); },
    });
    listener.onRoundStart(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates).toEqual([{ status: 'RUNNING', round: 1, content: '正在思考…', tools: [] }]);
  });

  it('keeps tool results matched when results arrive out of order', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({ update: async (_status, _round, _content, tools) => { updates.push(tools); } });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'a', function: { name: 'first', arguments: '{}' } });
    listener.onToolCallResult('a', 'first result');
    listener.onToolCallStart({ id: 'b', function: { name: 'second', arguments: '{}' } });
    listener.onToolCallResult('b', 'second result');
    listener.onMessageEnd({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual([]);
    expect(updates[1]).toEqual(['first：执行中…']);
    expect(updates[updates.length - 1]).toEqual(['first：first', 'second：执行中…']);
  });

  it('shows the shell command while the tool is still running', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"npm test"}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[1]).toEqual(['shell：`npm test`（执行中）']);
  });

  it('refreshes the card when streamed shell arguments become parseable', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":' } });
    listener.onToolCallArgsDelta('sh', '{"command":"pwd && ls"}');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[1]).toEqual(['shell：执行中…']);
    expect(updates[updates.length - 1]).toEqual(['shell：`pwd && ls`（执行中）']);
  });

  it('truncates a long running shell command and keeps write_stdin readable', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    const longCommand = `echo ${'a'.repeat(260)}`;
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'long', function: { name: 'shell', arguments: JSON.stringify({ command: longCommand }) } });
    listener.onToolCallStart({ id: 'stdin', function: { name: 'shell', arguments: '{"action":"write_stdin","input":"hello world"}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[1][0]).toBe(`shell：\`${longCommand.slice(0, 240)}…\`（执行中）`);
    expect(updates[updates.length - 1]).toEqual([
      `shell：\`${longCommand.slice(0, 240)}…\`（执行中）`,
      'shell：写入 stdin: hello world（执行中）',
    ]);
  });

  it('replaces the running shell command with the result summary', async () => {
    const updates: string[][] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, _content, tools) => { updates.push(tools); },
    });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    listener.onToolCallResult('sh', '{"exit_code":0,"output":"/tmp"}');
    listener.onRoundEnd(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[1]).toEqual(['shell：`pwd`（执行中）']);
    expect(updates[updates.length - 1]).toEqual(['shell：执行 pwd']);
  });

  it('swallows card update failures', async () => {
    const listener = new FeishuCardProgressListener({ update: async () => { throw new Error('offline'); } });
    listener.onMessageEnd({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    await expect(listener.complete('done')).resolves.toBe(false);
  });

  it('serializes updates and reports cancellation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const updates: string[] = [];
    const listener = new FeishuCardProgressListener({
      update: async (status) => { await gate; updates.push(status); },
    });
    listener.onRoundStart(1);
    listener.onMessageEnd({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    listener.onRoundEnd(1);
    const cancelled = listener.cancel();
    release();
    await cancelled;
    // 轮开始（思考态）与轮结束各推一次 RUNNING，取消后为终态。
    expect(updates).toEqual(['RUNNING', 'RUNNING', 'CANCELLED']);
  });

  it('keeps markdown breaks when newlines arrive as their own deltas', async () => {
    const updates: string[] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, content) => { updates.push(content); },
    });
    listener.onRoundStart(1);
    listener.onContentDelta('先给结论。');
    listener.onContentDelta('\n\n');
    listener.onToolCallStart({ id: 'ask', function: { name: 'ask_user_questions', arguments: '{}' } });
    listener.onContentDelta('## 一、根因\n');
    listener.onContentDelta('\n');
    listener.onContentDelta('1. 提示词压过只读。');
    listener.onRoundEnd(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[updates.length - 1]).toBe('先给结论。\n\n## 一、根因\n\n1. 提示词压过只读。');
  });

  it('offsets recovered loop rounds so the card continues from prior history', async () => {
    const updates: Array<{ round: number; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, round, _content, tools) => { updates.push({ round, tools }); },
    }, 78);
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    listener.onToolCallResult('sh', '{"exit_code":0,"output":"/tmp"}');
    listener.onRoundEnd(1);
    await listener.complete('done');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    // 恢复续跑时首个更新同样是思考态，轮次直接衔接到 79。
    expect(updates[0]).toEqual({ round: 79, tools: [] });
    expect(updates[1]).toEqual({ round: 79, tools: ['shell：`pwd`（执行中）'] });
    expect(updates[updates.length - 2]).toEqual({ round: 79, tools: ['shell：执行 pwd'] });
    expect(updates[updates.length - 1]).toEqual({ round: 79, tools: [] });
  });

  it('keeps the previous round content when a round emits only tool calls', async () => {
    // Agent 把登录链接写在 content 里，再跳到下一轮 shell 轮询登录状态：纯工具轮若不兜底，
    // 用户看不到链接，任务看起来卡住。
    const updates: Array<{ round: number; content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, round, content, tools) => { updates.push({ round, content, tools }); },
    });
    listener.onRoundStart(1);
    listener.onContentDelta('请先登录：https://ecp.example.com/auth/abc');
    listener.onRoundEnd(1);
    listener.onRoundStart(2);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pmo login --status"}' } });
    listener.onToolCallResult('sh', '{"exit_code":0,"output":"pending"}');
    listener.onRoundEnd(2);
    // 第三轮仍然只有工具调用，正文继续沿用最近一条。
    listener.onRoundStart(3);
    listener.onToolCallStart({ id: 'sh2', function: { name: 'shell', arguments: '{"command":"pmo login --status"}' } });
    listener.onToolCallResult('sh2', '{"exit_code":0,"output":"pending"}');
    listener.onRoundEnd(3);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual({ round: 1, content: '正在思考…', tools: [] });
    expect(updates[1]).toEqual({ round: 1, content: '请先登录：https://ecp.example.com/auth/abc', tools: [] });
    // 第 2、3 轮都是纯工具轮，正文沿用最近一条（轮首思考态与收尾各刷一次）。
    expect(updates.filter((u) => u.round === 2)).toEqual([
      { round: 2, content: '请先登录：https://ecp.example.com/auth/abc', tools: [] },
      { round: 2, content: '请先登录：https://ecp.example.com/auth/abc', tools: ['shell：`pmo login --status`（执行中）'] },
      { round: 2, content: '请先登录：https://ecp.example.com/auth/abc', tools: ['shell：执行 pmo login --status'] },
    ]);
    expect(updates[updates.length - 1]).toEqual({
      round: 3, content: '请先登录：https://ecp.example.com/auth/abc', tools: ['shell：执行 pmo login --status'],
    });
  });

  it('replaces the carried content once a later round emits its own', async () => {
    const updates: string[] = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, content) => { updates.push(content); },
    });
    listener.onRoundStart(1);
    listener.onContentDelta('第一轮的说明');
    listener.onRoundEnd(1);
    // 纯工具轮沿用上一轮。
    listener.onRoundStart(2);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[updates.length - 1]).toBe('第一轮的说明');
    // 新轮有新正文时替换兜底。
    listener.onRoundStart(3);
    listener.onContentDelta('第二轮的新说明');
    listener.onToolCallStart({ id: 'sh2', function: { name: 'shell', arguments: '{}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[updates.length - 1]).toBe('第二轮的新说明');
    // 再一个纯工具轮沿用新的那条，不再回到更早的。
    listener.onRoundEnd(3);
    listener.onRoundStart(4);
    listener.onToolCallStart({ id: 'sh3', function: { name: 'shell', arguments: '{}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[updates.length - 1]).toBe('第二轮的新说明');
  });

  it('strips citation markers from streamed card content (channels render no source area)', async () => {
    const updates: Array<{ content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, content, tools) => { updates.push({ content, tools }); },
    });
    listener.onRoundStart(1);
    listener.onContentDelta('截止时间是 11 月 30 日[^1^]，详见通知[^2^]。');
    listener.onToolCallStart({ id: 't1', function: { name: 'web_search', arguments: '{}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[updates.length - 1].content).toBe('截止时间是 11 月 30 日，详见通知。');
  });

  it('strips citation markers from the terminal complete() payload too', async () => {
    // 终态卡片与流式卡片同口径：正常路径入参已剥过，这里兜住崩溃恢复等其他调用方
    const updates: Array<{ content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, content, tools) => { updates.push({ content, tools }); },
    });
    await listener.complete('截止时间是 11 月 30 日[^1^]，详见通知[^2^]。');
    expect(updates[updates.length - 1].content).toBe('截止时间是 11 月 30 日，详见通知。');
  });

  it('forwards the terminal messageId to update so the snapshot binds to the card own reply', async () => {
    // 点踩归属口径：终态正文对应的消息 id 必须在 complete 时回传，
    // 否则终态正文为空时快照会绑到更早的 ASSISTANT 消息上
    const calls: Array<{ status: string; messageId?: number }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (status, _round, _content, _tools, messageId) => { calls.push({ status, messageId }); },
    });
    await listener.complete('最终答案', 42);
    await listener.complete('最终答案');
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(calls).toEqual([
      { status: 'COMPLETED', messageId: 42 },
      { status: 'COMPLETED', messageId: undefined },
    ]);
  });

  it('has nothing to carry when the first round emits no content', async () => {
    const updates: Array<{ content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener({
      update: async (_status, _round, content, tools) => { updates.push({ content, tools }); },
    });
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(updates[0]).toEqual({ content: '正在思考…', tools: [] });
    expect(updates[1]).toEqual({ content: '', tools: ['shell：`pwd`（执行中）'] });
  });
});

describe('FeishuCardProgressListener 在途工具耗时', () => {
  /**
   * 假定时器 + 手动时钟双轨：interval 由 advanceTimersByTimeAsync 驱动，
   * 耗时由 clock 变量驱动，二者互不依赖——推一拍、拨一次表，断言完全确定。
   */
  function makeListener(tickMs: number) {
    let clock = 1_000_000;
    const updates: Array<{ status: string; round: number; content: string; tools: string[] }> = [];
    const listener = new FeishuCardProgressListener(
      { update: async (status, round, content, tools) => { updates.push({ status, round, content, tools }); } },
      0, tickMs, () => clock,
    );
    return { listener, updates, advanceClock: (ms: number) => { clock += ms; } };
  }

  afterEach(() => { vi.useRealTimers(); });

  it('工具在跑时按 tick 间隔重推带耗时的卡片，亚秒事件推送不带后缀', async () => {
    const { listener, updates, advanceClock } = makeListener(20);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"npm test"}' } });
    await vi.advanceTimersByTimeAsync(0);
    // 工具刚开始的事件推送：elapsed 0 < 1s，不显示（与桌面端 0.0.465 口径一致）
    expect(updates[updates.length - 1].tools).toEqual(['shell：`npm test`（执行中）']);
    advanceClock(3000);
    await vi.advanceTimersByTimeAsync(20);
    expect(updates[updates.length - 1].tools).toEqual(['shell：`npm test`（执行中 · 3 秒）']);
    advanceClock(3000);
    await vi.advanceTimersByTimeAsync(20);
    expect(updates[updates.length - 1].tools).toEqual(['shell：`npm test`（执行中 · 6 秒）']);
  });

  it('并行工具各自计时', async () => {
    const { listener, updates, advanceClock } = makeListener(20);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'a', function: { name: 'shell', arguments: '{"command":"slow"}' } });
    advanceClock(3000);
    listener.onToolCallStart({ id: 'b', function: { name: 'read_file', arguments: '{}' } });
    await vi.advanceTimersByTimeAsync(0);
    // b 刚起表（亚秒不显示），a 已跑 3 秒
    expect(updates[updates.length - 1].tools).toEqual([
      'shell：`slow`（执行中 · 3 秒）',
      'read_file：执行中…',
    ]);
    advanceClock(3000);
    await vi.advanceTimersByTimeAsync(20);
    expect(updates[updates.length - 1].tools).toEqual([
      'shell：`slow`（执行中 · 6 秒）',
      'read_file：执行中…（3 秒）',
    ]);
  });

  it('工具结束后停止周期刷新，时间推进不再产生推送且摘要行不带耗时', async () => {
    const { listener, updates, advanceClock } = makeListener(20);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    await vi.advanceTimersByTimeAsync(20);
    const countAfterTick = updates.length;
    listener.onToolCallResult('sh', '{"exit_code":0,"output":"/tmp"}');
    listener.onRoundEnd(1);
    advanceClock(60_000);
    await vi.advanceTimersByTimeAsync(100); // 多拍
    // 只有轮末一次推送；摘要行不带耗时（耗时是执行中专属语义）
    expect(updates.length).toBe(countAfterTick + 1);
    expect(updates[updates.length - 1]).toMatchObject({ status: 'RUNNING', tools: ['shell：执行 pwd'] });
  });

  it('complete 与 cancel 后不再有周期推送', async () => {
    for (const finish of ['complete', 'cancel'] as const) {
      const { listener, updates, advanceClock } = makeListener(20);
      vi.useFakeTimers();
      listener.onRoundStart(1);
      listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
      await vi.advanceTimersByTimeAsync(20);
      const count = updates.length;
      if (finish === 'complete') await listener.complete('done');
      else await listener.cancel();
      advanceClock(30_000);
      await vi.advanceTimersByTimeAsync(100);
      expect(updates.length).toBe(count + 1);
      expect(updates[updates.length - 1].status).toBe(finish === 'complete' ? 'COMPLETED' : 'CANCELLED');
    }
  });

  it('fail 终态卡不展示执行中耗时，之后时间推进无推送', async () => {
    const { listener, updates, advanceClock } = makeListener(20);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"npm test"}' } });
    await vi.advanceTimersByTimeAsync(0);
    advanceClock(10_000); // 工具已跑 10 秒才失败
    await listener.fail('炸了');
    const countAtFail = updates.length;
    advanceClock(30_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(updates.length).toBe(countAtFail);
    expect(updates[countAtFail - 1]).toMatchObject({ status: 'FAILED', tools: ['shell：`npm test`（执行中）'] });
  });

  it('onError 置终局标志，之后时间推进无推送', async () => {
    const { listener, updates, advanceClock } = makeListener(20);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    await vi.advanceTimersByTimeAsync(20);
    const count = updates.length;
    listener.onError(new Error('boom'));
    await vi.advanceTimersByTimeAsync(0);
    expect(updates[count]).toMatchObject({ status: 'FAILED' });
    advanceClock(30_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(updates.length).toBe(count + 1);
  });

  it('无工具运行时不挂定时器，推进时间无额外推送', async () => {
    const { listener, updates } = makeListener(20);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onContentDelta('思考中');
    await vi.advanceTimersByTimeAsync(200);
    expect(updates).toHaveLength(1);
    expect(updates[0].tools).toEqual([]);
  });

  it('结果先于开始到达的乱序兜底不产生推送，也不让 ticker 复活', async () => {
    const { listener, updates, advanceClock } = makeListener(20);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'a', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    await vi.advanceTimersByTimeAsync(20);
    const count = updates.length;
    // 未知 id 的结果先到：乱序兜底 entry 无起表时刻；随后 a 结束 → 最后一个在途结束，停 tick
    listener.onToolCallResult('ghost', '幽灵结果');
    listener.onToolCallResult('a', '{"exit_code":0,"output":"/tmp"}');
    advanceClock(30_000);
    await vi.advanceTimersByTimeAsync(100);
    expect(updates.length).toBe(count);
  });

  it('tickMs=0 关闭周期刷新（仅事件推送）', async () => {
    const { listener, updates, advanceClock } = makeListener(0);
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    advanceClock(60_000);
    await vi.advanceTimersByTimeAsync(200);
    expect(updates).toHaveLength(2); // 轮首 + 工具开始，无 tick 推送
  });

  it('更新失败不影响后续 tick（safeUpdate 吞错，串行链继续）', async () => {
    let calls = 0;
    const listener = new FeishuCardProgressListener(
      { update: async () => { calls++; throw new Error('offline'); } },
      0, 20, () => 1_000_000,
    );
    vi.useFakeTimers();
    listener.onRoundStart(1);
    listener.onToolCallStart({ id: 'sh', function: { name: 'shell', arguments: '{"command":"pwd"}' } });
    await vi.advanceTimersByTimeAsync(80); // 4 拍
    // 轮首 1 + 工具开始 1 + tick 多次：失败不断链
    expect(calls).toBeGreaterThanOrEqual(5);
  });
});

describe('countCompletedAgentRounds', () => {
  it('counts assistant messages after the last user turn', () => {
    expect(countCompletedAgentRounds(null)).toBe(0);
    expect(countCompletedAgentRounds([])).toBe(0);
    expect(countCompletedAgentRounds([
      { role: 'USER' }, { role: 'ASSISTANT' }, { role: 'TOOL' }, { role: 'ASSISTANT' },
    ])).toBe(2);
    expect(countCompletedAgentRounds([
      { role: 'USER' }, { role: 'ASSISTANT' },
      { role: 'USER' }, { role: 'ASSISTANT' }, { role: 'ASSISTANT' }, { role: 'ASSISTANT' },
    ])).toBe(3);
    expect(countCompletedAgentRounds([{ role: 'SYSTEM' }, { role: 'ASSISTANT' }])).toBe(1);
  });
});