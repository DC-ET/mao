import { describe, expect, it, vi } from 'vitest';
import { AgentFeishuInboundHandler } from './agent-inbound-handler.js';
import type { CancelFlag, FeishuInboundContext, FeishuNormalizedMessage } from './types.js';

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

describe('AgentFeishuInboundHandler', () => {
  it('passes the triggering Mao user to the harness without changing session ownership', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7, executionUserId: 42 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'assistant text'),
    };
    const harness = { prepareMessage: vi.fn(() => 'exec-1'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    await handler.onMessage(makeContext());
    expect(harness.execute).toHaveBeenCalledWith(7, 'exec-1', expect.anything(), expect.anything(), 42);
  });

  it('formats group history without redundant wrapper text', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'assistant text'),
    };
    const harness = { prepareMessage: vi.fn(() => 'exec-1'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    await handler.onMessage(makeContext({ groupContext: '[09:36] 张三：在吗', senderLabel: '李四' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '[09:36] 张三：在吗\n李四：hello');
  });

  it('executes agent and returns latest assistant reply', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'assistant text'),
    };
    const harness = {
      prepareMessage: vi.fn(() => 'exec-1'),
      execute: vi.fn(async () => undefined),
    };
    const listenerFactory = vi.fn(async () => ({ onEvent: () => undefined }));
    const onExecutionFinished = vi.fn(async () => undefined);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      listenerFactory,
      onExecutionFinished,
    });
    const reply = await handler.onMessage(makeContext());
    expect(reply).toEqual({ text: 'assistant text' });
    // 群聊首条消息（无历史上下文）也必须带发送人前缀，否则 Agent 不知道发送者。
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '未知用户：hello');
    expect(harness.execute).toHaveBeenCalledWith(7, 'exec-1', expect.anything(), expect.anything(), null);
    expect(onExecutionFinished).toHaveBeenCalledWith(7, expect.anything(), 'exec-1', true);
  });

  it('prepends group context to the user message', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    };
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    await handler.onMessage(makeContext({ groupContext: '[张三] 讨论1', senderLabel: '李四' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, '[张三] 讨论1\n李四：hello');
  });

  it('cancels the previous generation when a new message arrives', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    };
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => {
        await firstGate;
      }),
    };
    const flags: CancelFlag[] = [];
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => { const flag = makeFlag(); flags.push(flag); return flag; },
      releaseCancelFlag: vi.fn(),
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    const first = handler.onMessage(makeContext());
    // 等待第一条进入 execute
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 新消息到达后，第一代的 flag 被置位（代际取消）；新 flag 尚未注册（锁内注册）
    expect(flags.length).toBe(1);
    expect(flags[0].get()).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);
    // 第二代在上一代结束后才注册 flag，且不被上一代的取消传播污染
    expect(flags.length).toBe(2);
    expect(flags[1].get()).toBe(false);
  });

  it('serializes executions on the same session', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    };
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async (sessionId: number) => {
        order.push(`start-${order.length}`);
        if (order.length === 1) await firstGate;
        order.push(`end-${order.length - 1}`);
      }),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    const first = handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = handler.onMessage(makeContext());
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseFirst();
    await Promise.all([first, second]);
    // 第二条必须等第一条结束：end-0 先于第二条的 start
    const end0 = order.indexOf('end-0');
    const secondStart = order.findIndex((entry) => entry.startsWith('start-') && entry !== 'start-0');
    expect(end0).toBeGreaterThan(-1);
    expect(secondStart).toBeGreaterThan(end0);
  });

  it('resets session phase to RUNNING before execution', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
      updatePhase: vi.fn(async () => undefined),
    };
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    await handler.onMessage(makeContext());
    expect(sessionService.updatePhase).toHaveBeenCalledWith(7, 'RUNNING');
  });

  it('suppresses stale reply when 3+ messages burst in (generation guard)', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
      cleanupIncompleteTail: vi.fn(async () => 0),
    };
    const order: string[] = [];
    const gates: Array<() => void> = [];
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => {
        order.push(`start-${order.length}`);
        await new Promise<void>((resolve) => gates.push(resolve));
      }),
    };
    const onReply = vi.fn(async () => undefined);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      listenerFactory: async () => ({ onEvent: () => undefined }),
      onReply,
    });
    const first = handler.onMessage(makeContext({ text: 'm1' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = handler.onMessage(makeContext({ text: 'm2' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const third = handler.onMessage(makeContext({ text: 'm3' }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 只有 m1（已进入 execute）与 m3（锁内代际校验后执行）会真正执行 Agent，共 2 次 execute
    for (let released = 0; released < 2; released++) {
      while (gates.length <= released) await new Promise((resolve) => setTimeout(resolve, 5));
      gates[released]();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await Promise.all([first, second, third]);
    // 中间代际 m2 在锁内被 generation 前置校验拦截：只有最新消息 m3 执行 Agent 并收到回复
    expect(harness.execute).toHaveBeenCalledTimes(2);
    expect(onReply).toHaveBeenCalledTimes(1);
    expect(onReply).toHaveBeenCalledWith(expect.objectContaining({ text: 'm3' }), 'r');
  });

  it('cleans up incomplete tail when cancelled', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
      updatePhase: vi.fn(async () => undefined),
      cleanupIncompleteTail: vi.fn(async () => 1),
    };
    const flag = makeFlag();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { flag.set(true); }),
    };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => flag,
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    const reply = await handler.onMessage(makeContext());
    expect(reply).toBeNull();
    expect(sessionService.cleanupIncompleteTail).toHaveBeenCalledWith(7);
  });

  it('releases cancel flag when execution completes', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    };
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const releaseCancelFlag = vi.fn();
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: makeFlag,
      releaseCancelFlag,
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    await handler.onMessage(makeContext());
    expect(releaseCancelFlag).toHaveBeenCalledWith(7);
  });

  it('returns null and reports failure when cancelled mid-execution', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7 })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    };
    const flag = makeFlag();
    const harness = {
      prepareMessage: vi.fn(() => 'e'),
      execute: vi.fn(async () => { flag.set(true); }),
    };
    const onExecutionFinished = vi.fn(async () => undefined);
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      createCancelFlag: () => flag,
      listenerFactory: async () => ({ onEvent: () => undefined }),
      onExecutionFinished,
    });
    const reply = await handler.onMessage(makeContext());
    expect(reply).toBeNull();
    expect(onExecutionFinished).toHaveBeenCalledWith(7, expect.anything(), 'e', false);
  });

  it('saves message with image content parts when media downloaded', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7, workspace: '/ws' })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    };
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async () => ({ images: ['data:image/jpeg;base64,AAA'], filePaths: [], errors: [] }),
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    await handler.onMessage(makeContext({ messageType: 'image', imageKey: 'img_1', text: '[图片]' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, [
      { type: 'text', text: '未知用户：[图片]' },
      { type: 'image_url', imageUrl: { url: 'data:image/jpeg;base64,AAA' } },
    ]);
  });

  it('appends file path references and download errors to the message', async () => {
    const sessionService = {
      getOrCreateSession: vi.fn(async () => ({ id: 7, workspace: '/ws' })),
      saveUserMessage: vi.fn(async () => undefined),
      getLatestAssistantReply: vi.fn(async () => 'r'),
    };
    const harness = { prepareMessage: vi.fn(() => 'e'), execute: vi.fn(async () => undefined) };
    const handler = new AgentFeishuInboundHandler({
      sessionService,
      harnessService: harness as never,
      downloadMedia: async () => ({
        images: [],
        filePaths: ['/ws/a.pdf'],
        errors: ['b.pdf（接收失败）'],
      }),
      listenerFactory: async () => ({ onEvent: () => undefined }),
    });
    await handler.onMessage(makeContext({ messageType: 'file', fileKey: 'file_1', fileName: 'a.pdf', text: '[文件:a.pdf]' }));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, expect.stringContaining('@{/ws/a.pdf}@'));
    expect(sessionService.saveUserMessage).toHaveBeenCalledWith(7, expect.stringContaining('[以下文件接收失败：b.pdf（接收失败）]'));
  });
});
