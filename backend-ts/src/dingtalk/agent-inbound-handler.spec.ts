import { describe, expect, it, vi } from 'vitest';
import { AgentDingtalkInboundHandler, contextFromQueue, NEW_SESSION_CONFIRM_TEXT } from './agent-inbound-handler.js';
import type { DingtalkInboundContext } from './types.js';

function context(overrides: Partial<DingtalkInboundContext> = {}): DingtalkInboundContext {
  return {
    accountId: '3', chatType: 'p2p', conversationId: 'cid-1', messageId: 'm1', senderUserid: 'staff',
    senderUnionId: null, senderName: '张三', msgtype: 'text', text: '你好', downloadCodes: [], fileName: null,
    quotedText: null, isInAtList: true, maoUserId: 9, ...overrides,
  };
}

function handler(options: Partial<ConstructorParameters<typeof AgentDingtalkInboundHandler>[0]> = {}) {
  const execute = vi.fn(async () => undefined);
  const saveUserMessage = vi.fn(async (_sessionId: number, _content: unknown) => 11);
  const getOrCreateSession = vi.fn(async () => ({ id: 20, workspace: '/ws', executionUserId: 9 }));
  const createSession = vi.fn(async () => ({ id: 21 }));
  const findActiveSession = vi.fn(async () => ({ id: 20 }));
  const built = new AgentDingtalkInboundHandler({
    sessionService: {
      getOrCreateSession,
      saveUserMessage,
      getLatestAssistantReply: async () => '回复',
      updatePhase: async () => undefined,
      getPhase: async () => 'IDLE',
      ...(options.sessionService ?? {}),
    },
    harnessService: { prepareMessage: () => 'evt', execute, ...(options.harnessService ?? {}) },
    listenerFactory: async () => ({ } as never),
    p2pSessionControl: {
      findActiveSession,
      createSession,
      ...(options.p2pSessionControl ?? {}),
    },
    onReply: vi.fn(async () => undefined),
    createCancelFlag: () => ({ get: () => false, set: () => undefined }),
    ...options,
  });
  return { handler: built, execute, saveUserMessage, getOrCreateSession, createSession, findActiveSession };
}

describe('AgentDingtalkInboundHandler sessions', () => {
  it('switches the private pointer when --- arrives and the chat is idle', async () => {
    const settleCancel = vi.fn();
    const createSession = vi.fn(async () => ({ id: 30 }));
    const reply = vi.fn(async () => undefined);
    const { handler: inbound, execute } = handler({
      p2pSessionControl: { findActiveSession: async () => null, createSession },
      settleCancel,
      onReply: reply,
    });
    await inbound.onMessage(context({ text: '---' }));
    expect(createSession).toHaveBeenCalled();
    expect(settleCancel).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledWith(expect.anything(), NEW_SESSION_CONFIRM_TEXT, 30);
  });

  it('cancels the running private task before opening a new session', async () => {
    const order: string[] = [];
    const flag = { value: false, get: () => flag.value, set: (v: boolean) => { flag.value = v; } };
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { handler: inbound } = handler({
      createCancelFlag: () => flag,
      harnessService: {
        prepareMessage: () => 'evt',
        execute: async () => { started(); await gate; },
      },
      settleCancel: async () => { order.push(`cancel:${flag.value}`); },
      p2pSessionControl: {
        findActiveSession: async () => ({ id: 20 }),
        createSession: async () => { order.push('create'); return { id: 31 }; },
      },
    });
    const running = inbound.onMessage(context({ text: '你好', messageId: 'run' }));
    await startedPromise;
    await inbound.onMessage(context({ text: '---', messageId: 'dash' }));
    expect(order).toEqual(['cancel:true', 'create']);
    release();
    await running;
  });

  it('treats --- in a group as ordinary text', async () => {
    const { handler: inbound, execute, getOrCreateSession, createSession } = handler();
    await inbound.onMessage(context({ chatType: 'group', text: '---', isInAtList: true }));
    expect(createSession).not.toHaveBeenCalled();
    expect(getOrCreateSession).toHaveBeenCalled();
    expect(execute).toHaveBeenCalled();
  });

  it('does not change the active session when the message quotes another one', async () => {
    const { handler: inbound, getOrCreateSession, createSession, execute, saveUserMessage } = handler();
    await inbound.onMessage(context({ text: '继续', quotedText: '更早的一句' }));
    expect(createSession).not.toHaveBeenCalled();
    expect(getOrCreateSession).toHaveBeenCalledTimes(1);
    const saved = saveUserMessage;
    expect(String(saved.mock.calls[0][1])).toContain('【引用的消息】');
    expect(String(saved.mock.calls[0][1])).toContain('更早的一句');
    expect(execute).toHaveBeenCalled();
  });

  it('stores a private file without executing, then runs the following text', async () => {
    const { handler: inbound, execute, saveUserMessage } = handler({
      downloadMedia: async () => ({ images: [], imagePaths: [], filePaths: ['/ws/a.pdf'], errors: [] }),
    });
    await inbound.onMessage(context({ msgtype: 'file', text: '', fileName: 'a.pdf', messageId: 'file-1' }));
    expect(execute).not.toHaveBeenCalled();
    expect(String(saveUserMessage.mock.calls[0][1])).toContain('@{/ws/a.pdf}@');
    await inbound.onMessage(context({ text: '看这个文件', messageId: 'text-2' }));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('appends saved-image path hint as workspace-relative path', async () => {
    const { handler: inbound, saveUserMessage } = handler({
      downloadMedia: async () => ({
        images: ['data:image/jpeg;base64,AAA'],
        imagePaths: ['/ws/chat-files/2026-10-13/dingtalk-image-msg_1.jpg'],
        filePaths: [],
        errors: [],
      }),
    });
    await inbound.onMessage(context({ msgtype: 'picture', text: '', messageId: 'img-1' }));
    const parts = saveUserMessage.mock.calls[0][1] as Array<{ type: string; text?: string }>;
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toBe('图片已保存到会话工作区：chat-files/2026-10-13/dingtalk-image-msg_1.jpg');
  });
});

describe('AgentDingtalkInboundHandler retry identity', () => {
  it('重试以持久化运行身份续跑（技术方案 2026-11-04 §5.2）', async () => {
    const { handler: inbound, execute } = handler({
      sessionService: {
        getPhase: async () => 'FAILED',
        cleanupIncompleteTail: async () => 0,
        updatePhase: async () => undefined,
        getMessages: async () => [],
        getLatestAssistantReply: async () => '回复',
        getLastRuntimeUserId: async () => 67,
      },
    });
    const result = await inbound.retryExecution(20, async () => ({ update: async () => undefined }) as never);
    expect(result).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalledWith(20, null, expect.anything(), expect.anything(), 67);
    });
  });
});

describe('AgentDingtalkInboundHandler 平台队列接力（0.0.434）', () => {
  function makeQueue() {
    return {
      enqueue: vi.fn(async () => ({ id: 1, rankNo: 1 })),
      setOutTrackId: vi.fn(async () => undefined),
      claimNext: vi.fn(async () => null),
      complete: vi.fn(async () => undefined),
      hasPending: vi.fn(async () => false),
    };
  }

  it('钉钉队列排空且会话空闲时接力消费平台排队消息', async () => {
    const queueService = makeQueue();
    const onQueuesDrained = vi.fn();
    const { handler: inbound } = handler({ queueService: queueService as never, onQueuesDrained });
    await inbound.drainNextIfPending(20);
    await vi.waitFor(() => expect(onQueuesDrained).toHaveBeenCalledWith(20));
    expect(queueService.claimNext).toHaveBeenCalled();
  });

  it('WS 侧占用会话时不领取队列、不接力', async () => {
    const queueService = makeQueue();
    const onQueuesDrained = vi.fn();
    const { handler: inbound } = handler({
      queueService: queueService as never,
      onQueuesDrained,
      isSessionExecuting: () => true,
    });
    await inbound.drainNextIfPending(20);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(queueService.claimNext).not.toHaveBeenCalled();
    expect(onQueuesDrained).not.toHaveBeenCalled();
  });

  it('WS 侧占用会话时新消息入队而非直接执行', async () => {
    const queueService = makeQueue();
    const { handler: inbound, execute } = handler({
      queueService: queueService as never,
      isSessionExecuting: () => true,
    });
    await inbound.onMessage(context({ text: '你好', maoUserId: 9 }));
    expect(queueService.enqueue).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('AgentDingtalkInboundHandler 终态回复', () => {
  function progressSpy(updateFails: boolean) {
    const updates: Array<{ status: string }> = [];
    return {
      updates,
      createProgressCard: vi.fn(async () => ({
        update: async (status: string) => {
          updates.push({ status });
          // listener 的 safeUpdate 会吞掉这里的异常并把结果折算成 false，
          // 与生产里卡片更新失败（网络/模板）的路径一致。
          if (updateFails) throw new Error('卡片更新失败');
        },
      })),
    };
  }

  it('卡片终态更新成功时不再另发一条消息：结果由卡片呈现', async () => {
    const card = progressSpy(false);
    const reply = vi.fn(async () => undefined);
    const { handler: inbound } = handler({ createProgressCard: card.createProgressCard as never, onReply: reply });

    await inbound.onMessage(context({ text: '你好' }));

    expect(card.updates.map((item) => item.status)).toContain('COMPLETED');
    expect(reply).not.toHaveBeenCalled();
  });

  it('卡片终态更新失败时回落文本回复，避免用户两边都收不到', async () => {
    const card = progressSpy(true);
    const reply = vi.fn(async () => undefined);
    const { handler: inbound } = handler({ createProgressCard: card.createProgressCard as never, onReply: reply });

    await inbound.onMessage(context({ text: '你好' }));

    expect(reply).toHaveBeenCalledWith(expect.anything(), '回复', expect.anything());
  });

  it('没有进度卡时仍按原样发文本回复', async () => {
    const reply = vi.fn(async () => undefined);
    const { handler: inbound } = handler({ onReply: reply });

    await inbound.onMessage(context({ text: '你好' }));

    expect(reply).toHaveBeenCalledWith(expect.anything(), '回复', expect.anything());
  });
});

describe('AgentDingtalkInboundHandler 队列上下文透传（一卡到底，批次 29 提案 5 同族技术方案）', () => {
  it('contextFromQueue 把队列行 outTrackId 透传为 progressCardOutTrackId，maoUserId 取行值', async () => {
    const row = {
      id: 7, botId: 3, sessionId: 20, messageId: 'm1', outTrackId: 'card-out-1',
      senderUserid: 'staff', maoUserId: 42, rankNo: 1,
    } as never;
    const payload = { context: { accountId: '3', chatType: 'p2p', conversationId: 'cid-1', messageId: 'm1', senderUserid: 'staff', senderUnionId: null, senderName: '张三', msgtype: 'text', text: '你好', fileName: null, quotedText: null } } as never;
    const ctx = contextFromQueue(payload, row);

    expect(ctx.progressCardOutTrackId).toBe('card-out-1');
    expect(ctx.maoUserId).toBe(42);
    expect(ctx.text).toBe('你好');
  });

  it('队列行无 outTrackId 时透传 null（升级分支自然走新建路径）', async () => {
    const row = {
      id: 7, botId: 3, sessionId: 20, messageId: 'm1', outTrackId: null,
      senderUserid: 'staff', maoUserId: null, rankNo: 1,
    } as never;
    const payload = { context: { accountId: '3', chatType: 'p2p', conversationId: 'cid-1', messageId: 'm1', senderUserid: 'staff', senderUnionId: null, senderName: '张三', msgtype: 'text', text: '你好', fileName: null, quotedText: null } } as never;
    const ctx = contextFromQueue(payload, row);

    expect(ctx.progressCardOutTrackId).toBeNull();
  });
});

describe('AgentDingtalkInboundHandler 渠道控制命令（2026-11-22 技术方案）', () => {
  interface Brief { id: number; title: string | null; phase: string | null; updatedAt: string | null; }

  function makeCommandHandler(overrides: {
    control?: Record<string, unknown>;
    stopRunning?: (sessionId: number) => Promise<boolean>;
    listChannelSessions?: (userId: number, limit: number) => Promise<Brief[]>;
    settleCancel?: (sessionId: number) => Promise<void>;
    queueService?: Record<string, unknown>;
  } = {}) {
    const execute = vi.fn(async () => undefined);
    const saveUserMessage = vi.fn(async () => 11);
    const getOrCreateSession = vi.fn(async () => ({ id: 20, workspace: '/ws', executionUserId: 9 }));
    const onReply = vi.fn(async () => undefined);
    const built = new AgentDingtalkInboundHandler({
      sessionService: {
        getOrCreateSession,
        saveUserMessage,
        getLatestAssistantReply: async () => '回复',
      },
      harnessService: { prepareMessage: () => 'evt', execute },
      listenerFactory: async () => ({}) as never,
      p2pSessionControl: {
        findActiveSession: vi.fn(async () => ({ id: 20 })),
        createSession: vi.fn(async () => ({ id: 21 })),
        ...(overrides.control ?? {}),
      } as never,
      stopRunning: overrides.stopRunning,
      listChannelSessions: overrides.listChannelSessions,
      ...(overrides.settleCancel != null ? { settleCancel: overrides.settleCancel } : {}),
      ...(overrides.queueService != null ? { queueService: overrides.queueService as never } : {}),
      onReply,
    });
    return { handler: built, execute, saveUserMessage, getOrCreateSession, onReply };
  }

  function replyTexts(onReply: ReturnType<typeof vi.fn>): string[] {
    return onReply.mock.calls.map((call: unknown[]) => String(call[1]));
  }

  it('p2p /new 与 --- 同路径：abandon 序列 + createSession + 拦截', async () => {
    const settleCancel = vi.fn(async () => undefined);
    const createSession = vi.fn(async () => ({ id: 21 }));
    const onReply = vi.fn(async () => undefined);
    const { handler, execute, saveUserMessage } = makeCommandHandler({
      control: { findActiveSession: vi.fn(async () => ({ id: 20 })), createSession },
    });
    // settleCancel 经 options 传入需要重建；为断言 abandon 序列单独构造。
    const built = new AgentDingtalkInboundHandler({
      sessionService: { getOrCreateSession: vi.fn(), saveUserMessage: vi.fn(async () => 11), getLatestAssistantReply: async () => 'r' },
      harnessService: { prepareMessage: () => 'evt', execute } as never,
      p2pSessionControl: { findActiveSession: vi.fn(async () => ({ id: 20 })), createSession } as never,
      settleCancel,
      onReply,
    });
    await built.onMessage(context({ text: '/new' }));
    expect(settleCancel).toHaveBeenCalledWith(20);
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(saveUserMessage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(onReply).toHaveBeenCalledWith(expect.anything(), '已开启新会话，后续消息将在新的上下文中处理。', 21);
    void handler;
  });

  it('p2p /stop 忙：置取消并回复已停止；不落库不执行', async () => {
    const stopRunning = vi.fn(async () => true);
    const { handler, execute, saveUserMessage, onReply } = makeCommandHandler({ stopRunning });
    await handler.onMessage(context({ text: '/stop' }));
    expect(stopRunning).toHaveBeenCalledWith(20);
    expect(saveUserMessage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(replyTexts(onReply)).toContain('已停止当前任务。');
  });

  it('p2p /stop 空闲：无绑定会话不调 stopRunning；端口 false 同文案', async () => {
    const stopRunning = vi.fn(async () => false);
    const control = { findActiveSession: vi.fn(async () => null) };
    const { handler, onReply } = makeCommandHandler({ control, stopRunning });
    await handler.onMessage(context({ text: '/stop' }));
    expect(stopRunning).not.toHaveBeenCalled();
    expect(replyTexts(onReply)).toContain('当前没有进行中的任务。');
    const second = makeCommandHandler({ stopRunning });
    await second.handler.onMessage(context({ text: '/stop' }));
    expect(replyTexts(second.onReply)).toContain('当前没有进行中的任务。');
  });

  it('p2p /tasks：查询本人简报并渲染列表', async () => {
    const listChannelSessions = vi.fn(async () => [
      { id: 31, title: '查天气', phase: 'RUNNING', updatedAt: '2026-11-22 11:30:00' },
    ]);
    const { handler, onReply, saveUserMessage, execute } = makeCommandHandler({ listChannelSessions });
    await handler.onMessage(context({ text: '/tasks', maoUserId: 9 }));
    expect(listChannelSessions).toHaveBeenCalledWith(9, 5);
    expect(saveUserMessage).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    const text = replyTexts(onReply).join('\n');
    expect(text).toContain('1. 查天气（进行中）');
    expect(text).toContain('回复 /tasks <序号> 切换，如 /tasks 2');
  });

  it('p2p /tasks 2：归属拒绝（switch 返回 null）回退列表且不收尾旧会话；成功切换按 abandon 序列收尾旧会话', async () => {
    const briefs = [
      { id: 31, title: '甲', phase: null, updatedAt: null },
      { id: 32, title: '乙', phase: null, updatedAt: null },
    ];
    const switchSession = vi.fn(async () => null);
    const onReply = vi.fn(async () => undefined);
    const settleCancel = vi.fn(async () => undefined);
    const rejected = makeCommandHandler({
      control: { findActiveSession: vi.fn(async () => ({ id: 31 })), switchSession },
      listChannelSessions: vi.fn(async () => briefs),
      settleCancel,
    });
    await rejected.handler.onMessage(context({ text: '/tasks 2' }));
    expect(switchSession).toHaveBeenCalledWith('3', expect.anything(), 32);
    expect(replyTexts(rejected.onReply).some((t) => t.includes('乙'))).toBe(true);
    // 归属拒绝：旧会话保持原状，不收尾。
    expect(settleCancel).not.toHaveBeenCalled();

    const switchOk = vi.fn(async () => ({ id: 32 }));
    const settleOk = vi.fn(async () => undefined);
    const queue = { claimNext: vi.fn(async () => null), complete: vi.fn(async () => undefined) };
    const accepted = makeCommandHandler({
      control: { findActiveSession: vi.fn(async () => ({ id: 31 })), switchSession: switchOk },
      listChannelSessions: vi.fn(async () => briefs),
      settleCancel: settleOk,
      queueService: queue,
    });
    await accepted.handler.onMessage(context({ text: '/tasks 2' }));
    // D5/R3：切换成功后按 `---` 既有 abandon 序列收尾旧会话（取消→补写终态→清队列）。
    expect(settleOk).toHaveBeenCalledWith(31);
    expect(queue.claimNext).toHaveBeenCalledWith(31);
    expect(replyTexts(accepted.onReply)).toContain('已切换到「乙」，后续消息将以该会话上下文为准。');
  });

  it('p2p /tasks 2 目标即当前：回复已在当前会话，不切换', async () => {
    const switchSession = vi.fn(async () => ({ id: 32 }));
    const { handler, onReply } = makeCommandHandler({
      control: { findActiveSession: vi.fn(async () => ({ id: 32 })), switchSession },
      listChannelSessions: vi.fn(async () => [
        { id: 31, title: '甲', phase: null, updatedAt: null },
        { id: 32, title: '乙', phase: null, updatedAt: null },
      ]),
    });
    await handler.onMessage(context({ text: '/tasks 2' }));
    expect(switchSession).not.toHaveBeenCalled();
    expect(replyTexts(onReply)).toContain('已在当前会话。');
  });

  it('p2p /help：命令一览；/stop /tasks 带其他文字不命中走原链路', async () => {
    const { handler, onReply, saveUserMessage, execute } = makeCommandHandler({});
    await handler.onMessage(context({ text: '/help' }));
    expect(replyTexts(onReply).some((t) => t.includes('/tasks <序号> 切换到对应任务'))).toBe(true);

    const normal = makeCommandHandler({});
    await normal.handler.onMessage(context({ text: '/tasks 帮我查天气' }));
    expect(normal.saveUserMessage).toHaveBeenCalledTimes(1);
    expect(normal.execute).toHaveBeenCalledTimes(1);
  });

  it('群 /stop：有群会话行 → 停止并回复；无行 → 本群还没有会话', async () => {
    const stopRunning = vi.fn(async () => true);
    const groupStop = makeCommandHandler({
      control: { findActiveSession: vi.fn(async () => ({ id: 45 })) },
      stopRunning,
    });
    await groupStop.handler.onMessage(context({ chatType: 'group', text: '/stop' }));
    expect(stopRunning).toHaveBeenCalledWith(45);
    expect(replyTexts(groupStop.onReply)).toContain('已停止当前任务。');

    const emptyStop = makeCommandHandler({
      control: { findActiveSession: vi.fn(async () => null) },
      stopRunning,
    });
    await emptyStop.handler.onMessage(context({ chatType: 'group', text: '/stop' }));
    expect(replyTexts(emptyStop.onReply)).toContain('本群还没有会话。');
  });

  it('群 /help：群命令一览（不含 /new /tasks）；群命令埠缺失回暂不支持', async () => {
    const groupHelp = makeCommandHandler({});
    await groupHelp.handler.onMessage(context({ chatType: 'group', text: '/help' }));
    const texts = replyTexts(groupHelp.onReply);
    expect(texts.some((t) => t.includes('群内任意成员可停止群任务'))).toBe(true);
    expect(texts.some((t) => t.includes('/tasks'))).toBe(false);

    const portless = makeCommandHandler({});
    await portless.handler.onMessage(context({ chatType: 'group', text: '/stop' }));
    expect(replyTexts(portless.onReply)).toContain('此命令暂不支持。');
  });
});
