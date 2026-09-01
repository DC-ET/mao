import { describe, expect, it, vi, afterEach } from 'vitest';
import { AgentWeixinInboundHandler, type AgentWeixinInboundHandlerDeps } from './agent-inbound-handler.js';
import type { WeixinInboundMessageContext } from './types.js';
import { AtomicBoolean } from '../harness/atomic-boolean.js';

describe('AgentWeixinInboundHandler cancel replace', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('newerMessageCancelsPreviousAndOnlyLatestReplies', async () => {
    const firstFlag = new AtomicBoolean(false);
    const secondFlag = new AtomicBoolean(false);
    const flags = [firstFlag, secondFlag];
    let flagIdx = 0;
    let firstStarted!: () => void;
    const firstStartedP = new Promise<void>((r) => { firstStarted = r; });
    let allowFirst!: () => void;
    const allowFirstP = new Promise<void>((r) => { allowFirst = r; });

    const harnessService = {
      prepareMessage: vi.fn(async () => 'exec-1'),
      execute: vi.fn(async (_sid: number, _eid: string | null, _l: unknown, flag: AtomicBoolean) => {
        if (flag === firstFlag) {
          firstStarted();
          await allowFirstP;
          return;
        }
      }),
    };
    const sessionService = {
      saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
      updatePhase: vi.fn(),
      getMessages: vi.fn(async () => [{ role: 'ASSISTANT', content: 'latest-reply' }]),
      cleanupIncompleteTail: vi.fn(async () => 0),
      updateContextTokens: vi.fn(),
    };
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService,
      sessionService,
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: { registerCancelFlag: vi.fn(() => flags[Math.min(flagIdx++, flags.length - 1)]) },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);

    const first = handler.onMessage({ accountId: 'acc-1', body: 'msg-1' } as WeixinInboundMessageContext);
    await firstStartedP;
    const second = handler.onMessage({ accountId: 'acc-1', body: 'msg-2' } as WeixinInboundMessageContext);
    await vi.waitFor(() => {
      expect(firstFlag.get()).toBe(true);
    });
    allowFirst();
    const firstReply = await first;
    const secondReply = await second;
    expect(firstReply).toBeNull();
    expect(secondReply?.text).toBe('latest-reply');
    handler.shutdown();
  });

  it('shutdownSkipsPendingMessageAndRollbacksOrphanUserMessage', async () => {
    const sessionService = {
      saveMessage: vi.fn(async () => ({ id: 10, content: 'msg' })),
      updatePhase: vi.fn(),
      getMessages: vi.fn(async () => []),
      cleanupIncompleteTail: vi.fn(async () => 0),
      updateContextTokens: vi.fn(),
      deleteMessageById: vi.fn(async () => {}),
    };
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1 })) },
      harnessService: { prepareMessage: vi.fn(async () => 'exec-1'), execute: vi.fn(async () => {}) },
      sessionService,
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: { registerCancelFlag: vi.fn(() => new AtomicBoolean(false)) },
      shellSessionManager: { closeByConversation: vi.fn() },
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
    } as unknown as AgentWeixinInboundHandlerDeps);
    // 停机后到达的消息不会被执行：走跳过分支，需回滚本轮孤立 USER 消息并 resolve null。
    handler.shutdown();
    const reply = await handler.onMessage({ accountId: 'acc-1', body: 'msg-1' } as WeixinInboundMessageContext);
    expect(reply).toBeNull();
    expect(sessionService.deleteMessageById).toHaveBeenCalledWith(100, 10);
    expect(sessionService.updatePhase).not.toHaveBeenCalled();
    handler.shutdown();
  });
});

describe('AgentWeixinInboundHandler file error', () => {
  function prepare(extra: Partial<AgentWeixinInboundHandlerDeps> = {}) {
    const sessionService = {
      saveMessage: vi.fn(async () => ({ id: 1 })),
      updatePhase: vi.fn(),
      getMessages: vi.fn(async () => []),
      cleanupIncompleteTail: vi.fn(async () => 0),
      updateContextTokens: vi.fn(),
    };
    const harnessService = {
      prepareMessage: vi.fn(async () => 'exec-1'),
      execute: vi.fn(async () => {}),
    };
    const shellSessionManager = { closeByConversation: vi.fn() };
    const handler = new AgentWeixinInboundHandler({
      weixinSessionService: { getOrCreateWeixinSession: vi.fn(async () => ({ id: 100, userId: 1, workspace: '/ws' })) },
      harnessService,
      sessionService,
      accountRepository: { findByAccountId: vi.fn(async () => ({ userId: 1 })) },
      agentLoop: { registerCancelFlag: vi.fn(() => new AtomicBoolean(false)) },
      shellSessionManager,
      registry: { send: vi.fn() },
      taskTerminalService: { finishExecution: vi.fn() },
      activityService: { record: vi.fn(async () => ({ id: 1 })) },
      activityHeartbeat: { touch: vi.fn() },
      sessionTodoMapper: { deleteBySessionId: vi.fn(), selectBySessionId: vi.fn(async () => []) },
      modelService: { getModel: vi.fn(async () => ({ supportsVision: 0 })) },
      weixinFileStorageService: { saveFile: vi.fn() },
      ...extra,
    } as unknown as AgentWeixinInboundHandlerDeps);
    return { handler, harnessService, shellSessionManager };
  }

  it('allFilesDownloadFailed_withoutOtherContent_repliesErrorWithoutTriggeringAgent', async () => {
    const { handler, harnessService } = prepare();
    const reply = await handler.onMessage({
      accountId: 'acc-1', fromUserId: 'wx-1', body: '', fileDownloadErrors: ['broken.pdf'],
    });
    expect(reply?.text).toContain('文件接收失败');
    expect(reply?.text).toContain('broken.pdf');
    expect(harnessService.prepareMessage).not.toHaveBeenCalled();
    handler.shutdown();
  });

  it('fileFailure_cancelsInFlightExecution', async () => {
    const { handler, shellSessionManager } = prepare();
    await handler.onMessage({
      accountId: 'acc-1', fromUserId: 'wx-1', body: '', fileDownloadErrors: ['broken.pdf'],
    });
    expect(shellSessionManager.closeByConversation).toHaveBeenCalledWith(100);
    handler.shutdown();
  });

  it('allFilesDownloadFailed_withText_continuesProcessingText', async () => {
    const { handler, harnessService } = prepare();
    const reply = await handler.onMessage({
      accountId: 'acc-1', fromUserId: 'wx-1', body: '帮我分析这个', fileDownloadErrors: ['broken.pdf'],
    });
    expect(harnessService.prepareMessage).toHaveBeenCalled();
    expect(reply).not.toBeNull();
    expect(reply?.text ?? '').not.toContain('文件接收失败');
    handler.shutdown();
  });
});
