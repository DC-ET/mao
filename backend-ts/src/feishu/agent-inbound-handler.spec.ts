import { describe, expect, it, vi } from 'vitest';
import { AgentFeishuInboundHandler, isNewSessionCommand } from './agent-inbound-handler.js';
import type { CancelFlag, FeishuInboundContext, FeishuInboundQueueRow, FeishuTaskQueuePort } from './types.js';
import type { AgentEventListener } from '../harness/core/agent-event-listener.js';

function makeContext(overrides: Partial<FeishuInboundContext> = {}): FeishuInboundContext {
  return {
    eventId: 'evt1', messageId: 'om_1', chatId: 'oc_group', chatType: 'group',
    senderId: 'ou_user', senderUnionId: 'on_user', senderType: 'user', messageType: 'text',
    text: 'hello', mentions: [], isBotMentioned: true, content: {}, rawEvent: {},
    accountId: '1', ...overrides,
  };
}

function makeFlag(): CancelFlag {
  const flag = { value: false, get: () => flag.value, set: (v: boolean) => { flag.value = v; } };
  return flag;
}

const listener: AgentEventListener = {
  onContentDelta: () => undefined, onToolCallStart: () => undefined, onToolCallArgsDelta: () => undefined,
  onToolCallResult: () => undefined, onMessageEnd: () => undefined, onError: () => undefined,
  onRoundStart: () => undefined, onRoundEnd: () => undefined,
};

type QueueRow = FeishuInboundQueueRow & { id: number };

function makeSessionService(overrides: Partial<ReturnType<typeof baseSessionService>> = {}) {
  return { ...baseSessionService(), ...overrides };
}
function baseSessionService() {
  return {
    getOrCreateSession: vi.fn(async () => ({ id: 7, executionUserId: 42 })),
    saveUserMessage: vi.fn(async () => undefined),
    getLatestAssistantReply: vi.fn(async () => 'assistant text'),
    updatePhase: vi.fn(async () => undefined),
    cleanupIncompleteTail: vi.fn(async () => 0),
    getPhase: vi.fn(async (): Promise<string | null> => null),
    getMessages: vi.fn(async () => []),
  };
}

function makeQueueService(overrides: Partial<FeishuTaskQueuePort> = {}): FeishuTaskQueuePort & { enqueueRows: QueueRow[] } {
  const enqueueRows: QueueRow[] = [];
  return {
    enqueueRows,
    enqueue: vi.fn(async (params) => { enqueueRows.push({ id: enqueueRows.length + 1, sessionId: params.sessionId, cardMessageId: null, payload: params.payload, status: 'QUEUED', botId: params.botId, messageId: params.messageId, senderOpenId: params.senderOpenId, maoUserId: params.maoUserId, rankNo: enqueueRows.length + 1 }); return enqueueRows.length; }),
    setCardMessageId: vi.fn(async () => undefined),
    claimNext: vi.fn(async () => null),
    complete: vi.fn(async () => undefined),
    hasPending: vi.fn(async () => false),
    ...overrides,
  };
}

describe('AgentFeishuInboundHandler', () => {
  it('broadcasts user_message_saved with content to all connected clients after saving the user message', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'exec-1'), execute: vi.fn(async () => undefined) };
    const registry = { send: vi.fn(), sendToLocalClients: vi.fn() };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      registry: registry as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ text: '飞书提问', maoUserId: 42 }));
    // 群聊消息会包装「【用户消息】\n发送人：文本」上下文（与 LLM 输入一致），断言以内容包含文本为准。
    expect(registry.send).toHaveBeenCalledWith(42, expect.objectContaining({
      type: 'user_message_saved',
      sessionId: 7,
      data: expect.objectContaining({
        source: 'feishu',
        content: expect.stringContaining('飞书提问'),
      }),
    }));
  });

  it('broadcasts RUNNING with the new executionId to the session owner before the harness starts', async () => {
    const sessionService = makeSessionService();
    const order: string[] = [];
    const harness = {
      prepareMessage: vi.fn(() => 'exec-2'),
      execute: vi.fn(async () => { order.push('execute'); }),
    };
    const registry = {
      send: vi.fn((_userId: number, event: { type: string }) => { order.push(event.type); }),
    };
    const resolveStreamUserId = vi.fn(async () => 9);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      registry: registry as never,
      resolveStreamUserId,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ text: '下一轮', maoUserId: 42 }));
    expect(resolveStreamUserId).toHaveBeenCalledWith(7);
    expect(registry.send).toHaveBeenCalledWith(9, {
      type: 'session_status', sessionId: 7, data: { phase: 'RUNNING', executionId: 'exec-2' },
    });
    expect(registry.send).toHaveBeenCalledWith(9, {
      type: 'session_list_update', sessionId: 7, data: { phase: 'RUNNING' },
    });
    expect(order.indexOf('session_status')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('session_status')).toBeLessThan(order.indexOf('execute'));
    expect(order.indexOf('session_list_update')).toBeLessThan(order.indexOf('execute'));
  });

  it('falls back to the triggering user when the session owner cannot be resolved', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'exec-3'), execute: vi.fn(async () => undefined) };
    const registry = { send: vi.fn() };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      registry: registry as never,
      resolveStreamUserId: vi.fn(async () => { throw new Error('db down'); }),
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ text: '回退', maoUserId: 42 }));
    expect(registry.send).toHaveBeenCalledWith(42, expect.objectContaining({
      type: 'session_status',
      data: expect.objectContaining({ phase: 'RUNNING', executionId: 'exec-3' }),
    }));
  });

  it('does not broadcast RUNNING when the harness returns an empty execution id', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => ''), execute: vi.fn(async () => undefined) };
    const registry = { send: vi.fn() };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      registry: registry as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ text: '无执行号' }));
    expect(registry.send).not.toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ type: 'session_status' }));
  });

  it('passes the triggering Mao user to the harness without changing session ownership', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'exec-1'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext());
    expect(harness.execute).toHaveBeenCalledWith(7, 'exec-1', expect.anything(), expect.anything(), 42);
  });

  it('passes sessionId to createProgressCard (progress card cancel button binding)', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'exec-1'), execute: vi.fn(async () => undefined) };
    const createProgressCard = vi.fn(async () => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      createProgressCard,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext());
    expect(createProgressCard).toHaveBeenCalledWith(expect.anything(), 7);
  });

  it('formats group history without redundant wrapper text', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'exec-1'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ groupContext: '[09:36] 张三：在吗', senderLabel: '李四' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '【群内最近消息】\n[09:36] 张三：在吗\n\n【用户消息】\n李四：hello', null);
  });

  it('places quoted context after group history and immediately before the user message', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'exec-1'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({
      groupContext: '[09:36] 张三：在吗',
      senderLabel: '李四',
      quotedContext: '[09:35] 王五：告警内容',
    }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '【群内最近消息】\n[09:36] 张三：在吗\n\n【引用的消息】\n[09:35] 王五：告警内容\n\n【用户消息】\n李四：hello', null);
  });

  it('executes agent and returns latest assistant reply', async () => {
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'exec-1'),
      execute: vi.fn(async () => undefined),
    };
    const listenerFactory = vi.fn(async () => listener);
    const onExecutionFinished = vi.fn(async () => undefined);
    const onReply = vi.fn(async (): Promise<string | null> => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory,
      onExecutionFinished,
      onReply,
    });
    const reply = await handler.onMessage(makeContext());
    expect(reply).toBeNull();
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '【用户消息】\n未知用户：hello', null);
    expect(harness.execute).toHaveBeenCalledWith(7, 'exec-1', expect.anything(), expect.anything(), 42);
    expect(onExecutionFinished).toHaveBeenCalledWith(7, expect.anything(), 'exec-1', 'COMPLETED');
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }), 'assistant text', 7);
  });

  it('prepends group context to the user message', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ groupContext: '[张三] 讨论1', senderLabel: '李四' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '【群内最近消息】\n[张三] 讨论1\n\n【用户消息】\n李四：hello', null);
  });

  it('enqueues the message when the session is busy instead of cancelling', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await firstGate; }),
    };
    const flags: CancelFlag[] = [];
    const queueService = makeQueueService();
    const onReply = vi.fn(async (): Promise<string | null> => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => { const flag = makeFlag(); flags.push(flag); return flag; },
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      queueService,
      onReply,
    });
    const first = handler.onMessage(makeContext({ text: 'm1' }));
    // 等待第一条进入 execute
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = handler.onMessage(makeContext({ text: 'm2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 新消息到达后不应取消第一代（无代际取消），且 m2 应入队
    expect(flags.length).toBe(1);
    expect(flags[0].get()).toBe(false);
    expect(queueService.enqueue).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([first, second]);
  });

  it('interruptAndDrain cancels the running task and then drains the queued message', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionService = makeSessionService();
    const flags: CancelFlag[] = [];
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => {
        if (flags.length === 1) await firstGate;
      }),
    };
    const queuedPayload = JSON.stringify({
      message: 'm2',
      context: { accountId: '1', chatType: 'group', chatId: 'oc_group', senderId: 'ou_user', senderUnionId: 'on_user', messageId: 'om_2', senderLabel: '李四' },
      botId: 1,
    });
    const queueRow = {
      id: 2, botId: 1, sessionId: 7, messageId: 'om_2', cardMessageId: 'cm_2',
      senderOpenId: 'ou_user', maoUserId: null, rankNo: 0, status: 'QUEUED', payload: queuedPayload,
    };
    let claimed = false;
    const queueService = makeQueueService({
      hasPending: vi.fn(async () => !claimed),
      claimNext: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return { ...queueRow, status: 'RUNNING' };
      }),
    });
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => { const flag = makeFlag(); flags.push(flag); return flag; },
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      queueService,
    });
    const first = handler.onMessage(makeContext({ text: 'm1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    handler.interruptAndDrain(7);
    expect(flags[0].get()).toBe(true);
    releaseFirst();
    await first;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(queueService.claimNext).toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it('interruptAndDrain resolves idle RUNNING sessions then drains the queue', async () => {
    const sessionService = makeSessionService();
    const resolveIdleRunning = vi.fn(async () => undefined);
    const onInterruptRunning = vi.fn();
    const queueRow = {
      id: 2, botId: 1, sessionId: 7, messageId: 'om_2', cardMessageId: 'cm_2',
      senderOpenId: 'ou_user', maoUserId: null, rankNo: 0, status: 'QUEUED',
      payload: JSON.stringify({
        message: 'm2',
        context: { accountId: '1', chatType: 'group', chatId: 'oc_group', senderId: 'ou_user', senderUnionId: 'on_user', messageId: 'om_2', senderLabel: '李四' },
        botId: 1,
      }),
    };
    let claimed = false;
    const queueService = makeQueueService({
      hasPending: vi.fn(async () => !claimed),
      claimNext: vi.fn(async () => {
        if (claimed) return null;
        claimed = true;
        return { ...queueRow, status: 'RUNNING' };
      }),
    });
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      queueService,
      onInterruptRunning,
      resolveIdleRunning,
    });
    handler.interruptAndDrain(7);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(onInterruptRunning).toHaveBeenCalledWith(7);
    expect(resolveIdleRunning).toHaveBeenCalledWith(7);
    expect(queueService.claimNext).toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledTimes(1);
  });

  it('serializes executions on the same session via queue instead of concurrent', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => {
        order.push(`start-${order.length}`);
        if (order.length === 1) await firstGate;
        order.push(`end-${order.length - 1}`);
      }),
    };
    // 模拟队列：第 2 条入队，第 1 条结束后 claimNext 返回它并执行。
    const queuedPayload = JSON.stringify({ message: 'm2', context: { accountId: '1', chatType: 'group', chatId: 'oc_group', senderId: 'ou_user', senderUnionId: 'on_user', messageId: 'om_2', senderLabel: '李四' }, botId: 1 });
    let queueClaimed = false;
    const queueService = makeQueueService({
      enqueue: vi.fn(async () => 2),
      claimNext: vi.fn(async () => {
        if (queueClaimed || order.length === 0) return null;
        queueClaimed = true;
        return { id: 2, botId: 1, sessionId: 7, messageId: 'om_2', cardMessageId: null, senderOpenId: 'ou_user', maoUserId: null, rankNo: 2, status: 'RUNNING', payload: queuedPayload };
      }),
      hasPending: vi.fn(async () => true),
    });
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      queueService,
    });
    const first = handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await Promise.all([first, second]);
    // drainNext 为 fire-and-forget，等待其消费队列后执行第 2 条。
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 第 1 条在队列前正常结束，第 2 条经队列回到同一串行执行：end-0 先于第二条 start。
    const end0 = order.indexOf('end-0');
    const secondStart = order.findIndex((entry) => entry.startsWith('start-') && entry !== 'start-0');
    expect(end0).toBeGreaterThan(-1);
    expect(secondStart).toBeGreaterThan(end0);
  });

  it('resets session phase to RUNNING before execution', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext());
    expect(sessionService.updatePhase).toHaveBeenCalledWith(7, 'RUNNING');
  });

  it('cleans up incomplete tail when interrupted and replies next message text', async () => {
    const sessionService = makeSessionService({
      cleanupIncompleteTail: vi.fn(async () => 1),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    });
    const flag = makeFlag();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { }),
    };
    const onReply = vi.fn(async (): Promise<string | null> => null);
    const onExecutionFinished = vi.fn(async () => undefined);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => flag,
      listenerFactory: async () => listener,
      onReply,
      onExecutionFinished,
    });
    const reply = await handler.onMessage(makeContext());
    expect(reply).toBeNull();
    expect(sessionService.cleanupIncompleteTail).not.toHaveBeenCalled();
  });

  it('returns user-cancelled text when cancelled mid-execution', async () => {
    const sessionService = makeSessionService({
      cleanupIncompleteTail: vi.fn(async () => 1),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    });
    const flag = makeFlag();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { flag.set(true); }),
    };
    const onReply = vi.fn(async (): Promise<string | null> => null);
    const onExecutionFinished = vi.fn(async () => undefined);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => flag,
      listenerFactory: async () => listener,
      onReply,
      onExecutionFinished,
    });
    const reply = await handler.onMessage(makeContext());
    expect(reply).toBeNull();
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }), '任务已取消。', 7);
    expect(onExecutionFinished).toHaveBeenCalledWith(7, expect.anything(), 'e', 'CANCELLED');
  });

  it('progress cancel shows 任务已取消 not 被下一条指令中断', async () => {
    const sessionService = makeSessionService({
      cleanupIncompleteTail: vi.fn(async () => 1),
    });
    const flag = makeFlag();
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => { releaseExecute = resolve; });
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await executeGate; }),
    };
    const updates: Array<{ status: string; content: string }> = [];
    const onExecutionFinished = vi.fn(async () => undefined);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => flag,
      releaseCancelFlag: vi.fn(),
      createProgressCard: vi.fn(async () => ({
        update: async (status: string, _round: number, content: string) => {
          updates.push({ status, content });
        },
      })),
      listenerFactory: async () => listener,
      onExecutionFinished,
      onInterruptRunning: vi.fn(),
    });
    const running = handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 模拟进度卡「取消任务」：只 cancel，不 interrupt
    expect(handler.cancel(7)).toBe(true);
    expect(flag.get()).toBe(true);
    releaseExecute();
    await running;
    expect(updates).toContainEqual({ status: 'CANCELLED', content: '任务已取消。' });
    expect(updates.some((u) => u.content.includes('中断'))).toBe(false);
  });

  it('interrupt marks interrupted so next-message wording is used', async () => {
    const sessionService = makeSessionService({
      cleanupIncompleteTail: vi.fn(async () => 1),
    });
    const flag = makeFlag();
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => { releaseExecute = resolve; });
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await executeGate; }),
    };
    const updates: Array<{ status: string; content: string }> = [];
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => flag,
      releaseCancelFlag: vi.fn(),
      createProgressCard: vi.fn(async () => ({
        update: async (status: string, _round: number, content: string) => {
          updates.push({ status, content });
        },
      })),
      listenerFactory: async () => listener,
      onExecutionFinished: async () => undefined,
      onInterruptRunning: vi.fn(),
    });
    const running = handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(handler.interrupt(7)).toBe(true);
    releaseExecute();
    await running;
    expect(updates).toContainEqual({ status: 'CANCELLED', content: '已被下一条指令中断。' });
  });

  it('retryExecution reuses history without saving a new user message', async () => {
    const sessionService = makeSessionService({
      getPhase: vi.fn(async () => 'FAILED'),
      cleanupIncompleteTail: vi.fn(async () => 1),
      updatePhase: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => '重试后的答案'),
    });
    const saveUserMessage = vi.fn(async () => undefined);
    sessionService.saveUserMessage = saveUserMessage;
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => undefined),
    };
    const onExecutionFinished = vi.fn(async () => undefined);
    const updates: Array<{ status: string; content: string }> = [];
    const registry = { send: vi.fn() };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      registry: registry as never,
      resolveStreamUserId: vi.fn(async () => 9),
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      onExecutionFinished,
    });
    const result = await handler.retryExecution(7, async () => ({
      update: async (status: string, _round: number, content: string) => {
        updates.push({ status, content });
      },
    }));
    // 回调只等「起跑」，execute 在后台跑完
    expect(result).toEqual({ ok: true });
    expect(harness.prepareMessage).not.toHaveBeenCalled();
    expect(saveUserMessage).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(onExecutionFinished).toHaveBeenCalledWith(7, expect.anything(), expect.any(String), 'COMPLETED');
    });
    expect(harness.execute).toHaveBeenCalledTimes(1);
    expect(registry.send).toHaveBeenCalledWith(9, expect.objectContaining({
      type: 'session_status',
      sessionId: 7,
      data: expect.objectContaining({ phase: 'RUNNING', executionId: expect.any(String) }),
    }));
    expect(updates).toContainEqual({ status: 'RUNNING', content: '正在重试，请稍候…' });
    expect(updates).toContainEqual({ status: 'COMPLETED', content: '重试后的答案' });
  });

  it('drains the feishu queue after a successful retry', async () => {
    const sessionService = makeSessionService({
      getPhase: vi.fn(async () => 'FAILED'),
      getLatestAssistantReply: vi.fn(async () => '重试后的答案'),
    });
    const claimNext = vi.fn(async () => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) } as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      onExecutionFinished: vi.fn(async () => undefined),
      queueService: makeQueueService({ claimNext }),
    });
    const result = await handler.retryExecution(7, async () => ({ update: async () => undefined }));
    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => expect(claimNext).toHaveBeenCalledWith(7));
  });

  it('retryExecution continues the progress card round from prior assistant messages', async () => {
    const sessionService = makeSessionService({
      getPhase: vi.fn(async () => 'FAILED'),
      getMessages: vi.fn(async () => [
        { role: 'USER' }, { role: 'ASSISTANT' }, { role: 'TOOL' }, { role: 'ASSISTANT' },
      ]),
      getLatestAssistantReply: vi.fn(async () => '重试后的答案'),
    });
    const rounds: number[] = [];
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) } as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      onExecutionFinished: async () => undefined,
    });
    await handler.retryExecution(7, async () => ({
      update: async (_status: string, round: number) => { rounds.push(round); },
    }));
    await vi.waitFor(() => {
      expect(rounds.length).toBeGreaterThan(0);
    });
    expect(rounds[0]).toBe(2);
  });

  it('retryExecution returns ok without waiting for the full execution', async () => {
    const sessionService = makeSessionService({
      getPhase: vi.fn(async () => 'FAILED'),
    });
    let releaseExecute!: () => void;
    const executeGate = new Promise<void>((resolve) => { releaseExecute = resolve; });
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await executeGate; }),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      onExecutionFinished: async () => undefined,
    });
    const result = await handler.retryExecution(7, async () => ({ update: async () => undefined }));
    expect(result).toEqual({ ok: true });
    // 回调不阻塞整次执行；后台 runRetry 会进入 execute 并在 gate 上挂起
    await vi.waitFor(() => {
      expect(harness.execute).toHaveBeenCalledTimes(1);
    });
    expect(handler['busy'].has(7)).toBe(true);
    releaseExecute();
    await vi.waitFor(() => {
      expect(handler['busy'].has(7)).toBe(false);
    });
  });

  it('retryExecution rejects when session is not FAILED', async () => {
    const sessionService = makeSessionService({
      getPhase: vi.fn(async () => 'COMPLETED'),
    });
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    const result = await handler.retryExecution(7, async () => ({ update: async () => undefined }));
    expect(result).toEqual({ ok: false, reason: 'NOT_FAILED' });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('retryExecution reports NO_PROGRESS when card cannot be rebuilt', async () => {
    const sessionService = makeSessionService({
      getPhase: vi.fn(async () => 'FAILED'),
    });
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
    });
    const result = await handler.retryExecution(7, async () => null);
    expect(result).toEqual({ ok: false, reason: 'NO_PROGRESS' });
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it('releases cancel flag when execution completes', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const releaseCancelFlag = vi.fn();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag,
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext());
    expect(releaseCancelFlag).toHaveBeenCalledWith(7);
  });

  it('drains queued message after current execution finishes', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await firstGate; }),
    };
    const queueService = makeQueueService();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      queueService,
    });
    const first = handler.onMessage(makeContext({ text: 'm1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = handler.onMessage(makeContext({ text: 'm2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await Promise.all([first, second]);
    expect(queueService.claimNext).toHaveBeenCalledTimes(1); // 当前未配置队列行，claim 返回 null（已断言）→ 不再执行
  });

  it('saves message with image content parts when media downloaded', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async () => ({ images: ['data:image/jpeg;base64,AAA'], imagePaths: [], filePaths: [], errors: [] }),
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ messageType: 'image', imageKey: 'img_1', text: '[图片]' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, [
      { type: 'text', text: '【用户消息】\n未知用户：[图片]' },
      { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,AAA' } },
    ], null);
  });

  it('appends saved-image path hint to the text part when images persisted', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async () => ({
        images: ['data:image/jpeg;base64,AAA'],
        imagePaths: ['/ws/feishu-chat/1/private-2/chat-files/2026-08-31/feishu-image-om_1.jpg'],
        filePaths: [],
        errors: [],
      }),
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ chatType: 'p2p', messageType: 'image', imageKey: 'img_1', text: '' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, [
      { type: 'text', text: '图片已保存到会话工作区：/ws/feishu-chat/1/private-2/chat-files/2026-08-31/feishu-image-om_1.jpg' },
      { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,AAA' } },
    ], null);
  });

  it('saves inbound file without executing the agent', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const createProgressCard = vi.fn(async () => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async () => ({
        images: [],
        imagePaths: [],
        filePaths: ['/ws/a.pdf'],
        errors: ['b.pdf（接收失败）'],
      }),
      listenerFactory: async () => listener,
      createProgressCard,
    });
    await handler.onMessage(makeContext({ messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, expect.stringContaining('@{/ws/a.pdf}@'), null);
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, expect.stringContaining('[以下文件接收失败：b.pdf（接收失败）]'), null);
    expect(harness.execute).not.toHaveBeenCalled();
    expect(harness.prepareMessage).not.toHaveBeenCalled();
    expect(createProgressCard).not.toHaveBeenCalled();
  });

  it('executes the following text once after ingesting a file', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async (context) => context.messageType === 'file'
        ? { images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] }
        : { images: [], imagePaths: [], filePaths: [], errors: [] },
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]', messageId: 'om_file',
    }));
    await handler.onMessage(makeContext({ text: '请分析这个文件', messageId: 'om_text' }));
    expect(harness.execute).toHaveBeenCalledOnce();
    expect(sessionService.saveUserMessage).toHaveBeenCalledTimes(2);
    expect(sessionService.saveUserMessage).toHaveBeenNthCalledWith(1, 7, expect.stringContaining('@{/ws/a.pdf}@'), null);
    expect(sessionService.saveUserMessage).toHaveBeenNthCalledWith(2, 7, expect.stringContaining('请分析这个文件'), null);
  });

  it('waits for in-flight file ingest before executing a following text', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const order: string[] = [];
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { order.push('execute'); }),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async (context) => {
        if (context.messageType === 'file') {
          order.push('file-download-start');
          await gate;
          order.push('file-download-done');
          return { images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] };
        }
        return { images: [], imagePaths: [], filePaths: [], errors: [] };
      },
      listenerFactory: async () => listener,
    });
    const fileDone = handler.onMessage(makeContext({
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]', messageId: 'om_file',
    }));
    await vi.waitFor(() => expect(order).toContain('file-download-start'));
    const textDone = handler.onMessage(makeContext({ text: '请分析', messageId: 'om_text' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).not.toContain('execute');
    release();
    await Promise.all([fileDone, textDone]);
    expect(order).toEqual(['file-download-start', 'file-download-done', 'execute']);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it('stashes a file received while busy and persists it after the current task without a second execute', async () => {
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await firstGate; }),
    };
    const queueService = makeQueueService();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async (context) => context.messageType === 'file'
        ? { images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] }
        : { images: [], imagePaths: [], filePaths: [], errors: [] },
      listenerFactory: async () => listener,
      createCancelFlag: makeFlag,
      queueService,
    });
    const first = handler.onMessage(makeContext({ text: '长任务', messageId: 'om_1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handler.onMessage(makeContext({
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]', messageId: 'om_file',
    }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.execute).toHaveBeenCalledOnce();
    release();
    await first;
    await vi.waitFor(() => expect(sessionService.saveUserMessage).toHaveBeenCalledTimes(2));
    expect(sessionService.saveUserMessage).toHaveBeenLastCalledWith(7, expect.stringContaining('@{/ws/a.pdf}@'), null);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it('persists a busy-session file under the session lock when queueService is absent', async () => {
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await firstGate; }),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async (context) => context.messageType === 'file'
        ? { images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] }
        : { images: [], imagePaths: [], filePaths: [], errors: [] },
      listenerFactory: async () => listener,
      createCancelFlag: makeFlag,
    });
    const first = handler.onMessage(makeContext({ text: '长任务', messageId: 'om_1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handler.onMessage(makeContext({
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]', messageId: 'om_file',
    }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledTimes(1);
    release();
    await first;
    await vi.waitFor(() => expect(sessionService.saveUserMessage).toHaveBeenCalledTimes(2));
    expect(sessionService.saveUserMessage).toHaveBeenNthCalledWith(1, 7, expect.stringContaining('长任务'), null);
    expect(sessionService.saveUserMessage).toHaveBeenNthCalledWith(2, 7, expect.stringContaining('@{/ws/a.pdf}@'), null);
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it('persists a busy-session file even when the current task fails', async () => {
    let release!: () => void;
    const firstGate = new Promise<void>((resolve) => { release = resolve; });
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { await firstGate; throw new Error('llm down'); }),
    };
    const queueService = makeQueueService();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async (context) => context.messageType === 'file'
        ? { images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] }
        : { images: [], imagePaths: [], filePaths: [], errors: [] },
      listenerFactory: async () => listener,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      onReply: vi.fn(async (): Promise<string | null> => null),
      queueService,
    });
    const first = handler.onMessage(makeContext({ text: '长任务', messageId: 'om_1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await handler.onMessage(makeContext({
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]', messageId: 'om_file',
    }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledTimes(1);
    release();
    await first;
    // FAILED 只应阻止队列接力，暂存附件仍必须落库
    await vi.waitFor(() => expect(sessionService.saveUserMessage).toHaveBeenCalledTimes(2));
    expect(sessionService.saveUserMessage).toHaveBeenLastCalledWith(7, expect.stringContaining('@{/ws/a.pdf}@'), null);
    expect(queueService.claimNext).not.toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  it('does not drain the queue when the direct message execution fails', async () => {
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { throw new Error('llm down'); }),
    };
    const queueService = makeQueueService();
    const onReply = vi.fn(async (): Promise<string | null> => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      queueService,
      onReply,
    });
    await handler.onMessage(makeContext());
    // FAILED 后不应触发队列接力消费
    expect(queueService.claimNext).not.toHaveBeenCalled();
    // 与客户端一致：透传具体 error.message，而非固定安抚文案
    expect(onReply).toHaveBeenCalledWith(expect.anything(), 'llm down', 7);
  });

  it('shows concrete error message on the progress card when execution fails', async () => {
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { throw new Error('LLM API returned 500: upstream timeout'); }),
    };
    const onReply = vi.fn(async (): Promise<string | null> => null);
    const updates: Array<{ status: string; content: string }> = [];
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      createProgressCard: vi.fn(async () => ({
        update: async (status: string, _round: number, content: string) => {
          updates.push({ status, content });
        },
      })),
      listenerFactory: async () => listener,
      onReply,
    });
    await handler.onMessage(makeContext());
    expect(updates).toContainEqual(expect.objectContaining({
      status: 'FAILED',
      content: 'LLM API returned 500: upstream timeout',
    }));
    // 卡片已更新成功，不再重复发文本兜底
    expect(onReply).not.toHaveBeenCalled();
  });

  it('falls back to generic message when error has no message', async () => {
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { throw 'plain-string-error'; }),
    };
    const onReply = vi.fn(async (): Promise<string | null> => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      onReply,
    });
    await handler.onMessage(makeContext());
    expect(onReply).toHaveBeenCalledWith(
      expect.anything(),
      '抱歉，处理您的消息时出现了错误，请稍后再试。',
      7,
    );
  });

  it('stops draining the queue after a queued message fails', async () => {
    const sessionService = makeSessionService();
    let execCount = 0;
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      // 第 1 条（直接执行）成功，第 2 条（排队执行）失败
      execute: vi.fn(async () => {
        execCount += 1;
        if (execCount > 1) throw new Error('llm down on queued msg');
      }),
    };
    const queueRow = {
      id: 2, botId: 1, sessionId: 7, messageId: 'om_2', cardMessageId: null,
      senderOpenId: 'ou_user', maoUserId: null, rankNo: 2, status: 'RUNNING',
      payload: JSON.stringify({
        message: 'm2',
        context: { accountId: '1', chatType: 'group', chatId: 'oc_group', senderId: 'ou_user', senderUnionId: 'on_user', messageId: 'om_2', senderLabel: '李四', maoUserId: 42 },
        botId: 1,
      }),
    };
    let claims = 0;
    const queueService = makeQueueService({
      claimNext: vi.fn(async () => {
        claims += 1;
        return claims === 1 ? queueRow : null;
      }),
      hasPending: vi.fn(async () => true),
    });
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      queueService,
    });
    // 第 1 条直接执行成功，触发 drainNext 消费队列中的第 2 条
    await handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 排队消息失败后不再续接：claim 只发生一次，该失败队列行仍被清理
    expect(claims).toBe(1);
    expect(queueService.complete).toHaveBeenCalledWith(2);
  });

  it('still drains the queue when sending the reply fails after success', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const queueService = makeQueueService();
    // onReply 发送失败不应把执行成功的终态误判为 FAILED
    const onReply = vi.fn(async () => { throw new Error('send failed'); });
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => listener,
      queueService,
      onReply,
    });
    await handler.onMessage(makeContext());
    // drainNext 为 fire-and-forget，等待其异步执行到 claimNext
    await new Promise((resolve) => setTimeout(resolve, 30));
    // 执行成功后即便 onReply 抛错，仍应尝试队列接力消费（claimNext 被调用；队列空则返回 null 停止）
    expect(queueService.claimNext).toHaveBeenCalledTimes(1);
  });
});

function makeP2pControl(overrides: Record<string, unknown> = {}) {
  return {
    findActiveSession: vi.fn(async () => ({ id: 7 })),
    createSession: vi.fn(async () => ({ id: 8 })),
    switchSession: vi.fn(async () => ({ id: 5 })),
    findSessionByMessageId: vi.fn(async () => null),
    recordMessageMapping: vi.fn(async () => undefined),
    finalizeNewSessionTitle: vi.fn(async () => true),
    ...overrides,
  };
}

describe('AgentFeishuInboundHandler p2p multi-session', () => {
  function makeP2pContext(overrides: Partial<FeishuInboundContext> = {}): FeishuInboundContext {
    return makeContext({ chatType: 'p2p', chatId: null, ...overrides });
  }

  it('matches the --- new-session command variants strictly', () => {
    expect(isNewSessionCommand('---')).toBe(true);
    expect(isNewSessionCommand('———')).toBe(true);
    expect(isNewSessionCommand('-----')).toBe(true);
    expect(isNewSessionCommand('  ---  ')).toBe(true);
    expect(isNewSessionCommand('-—-')).toBe(true);
    expect(isNewSessionCommand('--')).toBe(false);
    expect(isNewSessionCommand('--- abc')).toBe(false);
    expect(isNewSessionCommand('')).toBe(false);
    expect(isNewSessionCommand(null)).toBe(false);
  });

  it('creates a new session on --- and intercepts the message', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl();
    const onReply = vi.fn(async () => 'om_confirm');
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
      onReply,
    });
    const reply = await handler.onMessage(makeP2pContext({ text: '---', messageId: 'om_new' }));
    expect(reply).toBeNull();
    expect(control.createSession).toHaveBeenCalledWith('1', expect.objectContaining({ messageId: 'om_new' }));
    // `---` 消息本身不入会话消息流、不触发执行。
    expect(sessionService.saveUserMessage).not.toHaveBeenCalled();
    expect(harness.execute).not.toHaveBeenCalled();
    // `---` 消息归属新会话（IN），确认文案归属新会话（OUT）。
    expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_new', 8, 'IN');
    expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_confirm', 8, 'OUT');
    expect(onReply).toHaveBeenCalledWith(expect.anything(), '已开启新会话，后续消息将在新的上下文中处理。', 8);
  });

  it('replies failure text and still intercepts when session creation fails', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl({ createSession: vi.fn(async () => { throw new Error('db down'); }) });
    const onReply = vi.fn(async () => 'om_err');
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
      onReply,
    });
    await handler.onMessage(makeP2pContext({ text: '---' }));
    expect(harness.execute).not.toHaveBeenCalled();
    expect(onReply).toHaveBeenCalledWith(expect.anything(), '开启新会话失败，请稍后再试。', undefined);
  });

  it('switches session and confirms when the quoted message belongs to another session', async () => {
    const sessionService = makeSessionService({ getOrCreateSession: vi.fn(async () => ({ id: 5, executionUserId: 42 })) });
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl({
      findSessionByMessageId: vi.fn(async () => 5),
      findActiveSession: vi.fn(async () => ({ id: 7 })),
      switchSession: vi.fn(async () => ({ id: 5 })),
    });
    const onReply = vi.fn(async () => 'om_switch');
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
      onReply,
    });
    await handler.onMessage(makeP2pContext({ parentId: 'om_quoted' }));
    expect(control.switchSession).toHaveBeenCalledWith('1', expect.anything(), 5);
    expect(onReply).toHaveBeenCalledWith(expect.anything(), '已切换到该消息所在的会话，后续消息将以该会话上下文为准。', 5);
    // 本条消息继续执行并归属切换后的目标会话。
    expect(harness.execute).toHaveBeenCalledWith(5, 'e', expect.anything(), expect.anything(), 42);
    expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_1', 5, 'IN');
  });

  it('switches back to a quoted assistant session while the new session is running', async () => {
    let activeId = 5;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const queue = makeQueueService();
    const control = makeP2pControl({
      findActiveSession: vi.fn(async () => ({ id: activeId })),
      createSession: vi.fn(async () => { activeId = 8; return { id: activeId }; }),
      findSessionByMessageId: vi.fn(async () => 5),
      switchSession: vi.fn(async (_account, _context, target) => { activeId = target; return { id: target }; }),
    });
    const sessionService = makeSessionService({
      getOrCreateSession: vi.fn(async () => ({ id: activeId, executionUserId: 42 })),
    });
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async (id: number) => { if (id === 8) await gate; }),
    };
    const onReply = vi.fn(async () => 'om_reply');
    const handler = new AgentFeishuInboundHandler({
      sessionService, harnessService: harness as never,
      p2pSessionControl: control as never, queueService: queue,
      listenerFactory: async () => listener, onReply,
    });
    await handler.onMessage(makeP2pContext({ text: '---', messageId: 'om_new' }));
    const running = handler.onMessage(makeP2pContext({ text: '长任务', messageId: 'om_long' }));
    try {
      await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledWith(8, 'e', expect.anything(), expect.anything(), 42));
      await handler.onMessage(makeP2pContext({ parentId: 'om_old_assistant', messageId: 'om_quote' }));
      expect(control.findSessionByMessageId).toHaveBeenCalledWith('1', 'om_old_assistant');
      expect(activeId).toBe(5);
      expect(harness.execute).toHaveBeenCalledWith(5, 'e', expect.anything(), expect.anything(), 42);
      expect(queue.enqueue).not.toHaveBeenCalled();
      expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_quote', 5, 'IN');
      expect(onReply).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('已切换'), 5);
    } finally {
      release();
      await running;
    }
  });

  it('stays silent when the quoted message is not found in the mapping', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl({ findSessionByMessageId: vi.fn(async () => null) });
    const onReply = vi.fn(async () => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
      onReply,
    });
    await handler.onMessage(makeP2pContext({ parentId: 'om_legacy' }));
    expect(control.switchSession).not.toHaveBeenCalled();
    // 未切换：不应有切换确认文案；消息正常执行照常回复。
    expect(onReply).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('已切换'), expect.anything());
    expect(onReply).toHaveBeenCalledWith(expect.anything(), 'assistant text', 7);
    // 保持当前活跃会话执行。
    expect(harness.execute).toHaveBeenCalledWith(7, 'e', expect.anything(), expect.anything(), 42);
    expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_1', 7, 'IN');
  });

  it('stays silent when the quoted message already belongs to the active session', async () => {
    const sessionService = makeSessionService({ getOrCreateSession: vi.fn(async () => ({ id: 5, executionUserId: 42 })) });
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl({
      findSessionByMessageId: vi.fn(async () => 5),
      findActiveSession: vi.fn(async () => ({ id: 5 })),
    });
    const onReply = vi.fn(async () => null);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
      onReply,
    });
    await handler.onMessage(makeP2pContext({ parentId: 'om_same' }));
    expect(control.switchSession).not.toHaveBeenCalled();
    expect(onReply).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('已切换'), expect.anything());
    expect(harness.execute).toHaveBeenCalledWith(5, 'e', expect.anything(), expect.anything(), 42);
  });

  it('records inbound mapping for ordinary p2p messages without control actions', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
    });
    await handler.onMessage(makeP2pContext({ text: '继续这个任务' }));
    expect(control.createSession).not.toHaveBeenCalled();
    expect(control.switchSession).not.toHaveBeenCalled();
    expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_1', 7, 'IN');
    expect(harness.execute).toHaveBeenCalledWith(7, 'e', expect.anything(), expect.anything(), 42);
  });

  it('records outbound mapping when the reply message id is returned', async () => {
    const sessionService = makeSessionService({ getLatestAssistantReply: vi.fn(async () => 'done') });
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl();
    const onReply = vi.fn(async () => 'om_reply');
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
      onReply,
    });
    await handler.onMessage(makeP2pContext());
    expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_reply', 7, 'OUT');
  });

  it('renames a freshly created session from its first following message', async () => {
    const sessionService = makeSessionService({ getOrCreateSession: vi.fn(async () => ({ id: 8, executionUserId: 42 })) });
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
    });
    // `---` 新建 → 下一条消息进入新会话并触发命名（持久化标志驱动，handler 每条消息都尝试）。
    await handler.onMessage(makeP2pContext({ text: '---', messageId: 'om_new' }));
    const longText = '帮我把这份需求文档整理成一份可以直接给开发看的任务拆解清单，越细越好';
    await handler.onMessage(makeP2pContext({ text: longText, messageId: 'om_first' }));
    expect(control.finalizeNewSessionTitle).toHaveBeenCalledWith(8, longText.slice(0, 20));
    // 空文本消息不触发命名。
    await handler.onMessage(makeP2pContext({ text: '', messageId: 'om_empty', messageType: 'image' }));
    expect(control.finalizeNewSessionTitle).toHaveBeenCalledTimes(1);
  });

  it('treats --- in group chat as ordinary text (no session switch)', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
    });
    await handler.onMessage(makeContext({ text: '---' }));
    expect(control.createSession).not.toHaveBeenCalled();
    expect(control.switchSession).not.toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledWith(7, 'e', expect.anything(), expect.anything(), 42);
    expect(control.recordMessageMapping).not.toHaveBeenCalled();
  });

  it('executes a new-session message immediately while the previous session is busy', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionService = makeSessionService({ getOrCreateSession: vi.fn(async () => ({ id: 7, executionUserId: 42 })) });
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async (_sessionId: number, _eventId: string) => {
        // 旧会话(7)执行中阻塞；新会话(8)应可并行执行。
        if (harness.execute.mock.calls[harness.execute.mock.calls.length - 1]?.[0] === 7) await firstGate;
      }),
    };
    const control = makeP2pControl();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
    });
    const first = handler.onMessage(makeP2pContext({ text: '长任务', messageId: 'om_m1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // `---` 新建会话：旧会话忙碌时也立即生效。
    await handler.onMessage(makeP2pContext({ text: '---', messageId: 'om_cmd' }));
    expect(control.createSession).toHaveBeenCalled();
    // 新会话消息：sessionService 返回新会话 8，且旧会话阻塞中仍立即执行。
    sessionService.getOrCreateSession.mockImplementation(async () => ({ id: 8, executionUserId: 42 }));
    await handler.onMessage(makeP2pContext({ text: '新任务', messageId: 'om_m2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.execute).toHaveBeenCalledWith(8, 'e', expect.anything(), expect.anything(), 42);
    releaseFirst();
    await first;
  });

  it('records a p2p file mapping without executing until a following text arrives', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const control = makeP2pControl();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => listener,
      p2pSessionControl: control as never,
      downloadMedia: async () => ({ images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] }),
    });
    await handler.onMessage(makeP2pContext({
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]', messageId: 'om_file',
    }));
    expect(control.recordMessageMapping).toHaveBeenCalledWith('1', 'om_file', 7, 'IN');
    expect(harness.execute).not.toHaveBeenCalled();
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, expect.stringContaining('@{/ws/a.pdf}@'), null);
    await handler.onMessage(makeP2pContext({ text: '请分析', messageId: 'om_text' }));
    expect(harness.execute).toHaveBeenCalledOnce();
  });

  // ─── 话题会话 ────────────────────────────────────────────────────────

  it('routes thread root message to a new thread session', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const threadControl = {
      findSession: vi.fn(async () => null),
      getOrCreateSession: vi.fn(async () => ({ sessionId: 10, rootMessageId: 'om_root', workspace: '/ws/thread', executionUserId: 42 })),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      threadSessionControl: threadControl as never,
    });
    await handler.onMessage(makeContext({ threadId: 'omt_abc', messageId: 'om_root', parentId: null }));
    expect(threadControl.getOrCreateSession).toHaveBeenCalled();
    // 会话 10 被使用，而非默认的群级会话 7。
    expect(harness.execute).toHaveBeenCalledWith(10, 'e', expect.anything(), expect.anything(), 42);
    expect(sessionService.getOrCreateSession).not.toHaveBeenCalled();
  });

  it('routes thread reply to existing thread session', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const threadControl = {
      findSession: vi.fn(async () => ({ sessionId: 10, rootMessageId: 'om_root' })),
      getOrCreateSession: vi.fn(async () => ({ sessionId: 10, rootMessageId: 'om_root', workspace: '/ws/thread', executionUserId: 42 })),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      threadSessionControl: threadControl as never,
    });
    await handler.onMessage(makeContext({ threadId: 'omt_abc', messageId: 'om_reply', parentId: 'om_root', rootId: 'om_root' }));
    expect(harness.execute).toHaveBeenCalledWith(10, 'e', expect.anything(), expect.anything(), 42);
  });

  it('ingests a thread file without executing', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const threadControl = {
      findSession: vi.fn(async () => ({ sessionId: 10, rootMessageId: 'om_root' })),
      getOrCreateSession: vi.fn(async () => ({ sessionId: 10, rootMessageId: 'om_root', workspace: '/ws/thread', executionUserId: 42 })),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      threadSessionControl: threadControl as never,
      downloadMedia: async () => ({ images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] }),
    });
    await handler.onMessage(makeContext({
      threadId: 'omt_abc', messageId: 'om_file', parentId: 'om_root', rootId: 'om_root',
      messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]',
    }));
    expect(harness.execute).not.toHaveBeenCalled();
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(10, expect.stringContaining('@{/ws/a.pdf}@'), null);
  });

  it('falls back to group session when threadSessionControl returns null (error path)', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const threadControl = {
      findSession: vi.fn(async () => null),
      getOrCreateSession: vi.fn(async () => null),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      threadSessionControl: threadControl as never,
    });
    await handler.onMessage(makeContext({ threadId: 'omt_abc', messageId: 'om_reply', parentId: 'om_root', rootId: 'om_root' }));
    // getOrCreateSession 返回 null（异常/降级）→ 走现有群逻辑。
    expect(harness.execute).toHaveBeenCalledWith(7, 'e', expect.anything(), expect.anything(), 42);
  });

  it('falls back to group session when threadSessionControl throws', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const threadControl = {
      findSession: vi.fn(async () => null),
      getOrCreateSession: vi.fn(async () => { throw new Error('db down'); }),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      threadSessionControl: threadControl as never,
    });
    await handler.onMessage(makeContext({ threadId: 'omt_abc' }));
    // 异常降级走现有群逻辑。
    expect(harness.execute).toHaveBeenCalledWith(7, 'e', expect.anything(), expect.anything(), 42);
  });

  it('non-thread group message ignores threadSessionControl entirely', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const threadControl = {
      findSession: vi.fn(async () => ({ sessionId: 10, rootMessageId: 'om_root' })),
      getOrCreateSession: vi.fn(async () => ({ sessionId: 10, rootMessageId: 'om_root' })),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => listener,
      threadSessionControl: threadControl as never,
    });
    await handler.onMessage(makeContext());
    // 无 threadId → 不走话题分支，使用群级会话 7。
    expect(threadControl.getOrCreateSession).not.toHaveBeenCalled();
    expect(harness.execute).toHaveBeenCalledWith(7, 'e', expect.anything(), expect.anything(), 42);
  });
});
