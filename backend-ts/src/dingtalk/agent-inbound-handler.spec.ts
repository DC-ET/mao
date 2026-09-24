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
});
