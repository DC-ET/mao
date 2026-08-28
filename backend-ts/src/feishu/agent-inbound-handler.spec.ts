import { describe, expect, it, vi } from 'vitest';
import { AgentFeishuInboundHandler } from './agent-inbound-handler.js';
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

  it('prepends quoted message context before group history', async () => {
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
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '【引用的消息】\n[09:35] 王五：告警内容\n\n【群内最近消息】\n[09:36] 张三：在吗\n\n【用户消息】\n李四：hello', null);
  });

  it('executes agent and returns latest assistant reply', async () => {
    const sessionService = makeSessionService();
    const harness = {
      prepareMessage: vi.fn(() => 'exec-1'),
      execute: vi.fn(async () => undefined),
    };
    const listenerFactory = vi.fn(async () => listener);
    const onExecutionFinished = vi.fn(async () => undefined);
    const onReply = vi.fn(async () => undefined);
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
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }), 'assistant text');
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
    const onReply = vi.fn(async () => undefined);
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
    const onReply = vi.fn(async () => undefined);
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
    const onReply = vi.fn(async () => undefined);
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
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'hello' }), '任务已取消。');
    expect(onExecutionFinished).toHaveBeenCalledWith(7, expect.anything(), 'e', 'CANCELLED');
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
      downloadMedia: async () => ({ images: ['data:image/jpeg;base64,AAA'], filePaths: [], errors: [] }),
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ messageType: 'image', imageKey: 'img_1', text: '[图片]' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, [
      { type: 'text', text: '【用户消息】\n未知用户：[图片]' },
      { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,AAA' } },
    ], null);
  });

  it('appends file path references and download errors to the message', async () => {
    const sessionService = makeSessionService();
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async () => ({
        images: [],
        filePaths: ['/ws/a.pdf'],
        errors: ['b.pdf（接收失败）'],
      }),
      listenerFactory: async () => listener,
    });
    await handler.onMessage(makeContext({ messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, expect.stringContaining('@{/ws/a.pdf}@'), null);
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, expect.stringContaining('[以下文件接收失败：b.pdf（接收失败）]'), null);
  });
});
