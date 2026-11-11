import { describe, expect, it, vi } from 'vitest';
import { AgentDingtalkInboundHandler, NEW_SESSION_CONFIRM_TEXT } from './agent-inbound-handler.js';
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
      enqueue: vi.fn(async () => 1),
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
