import { describe, expect, it, vi } from 'vitest';
import { FeishuMessageService } from './message.service.js';
import type { FeishuInboundContext, FeishuNormalizedMessage } from './types.js';

function makeContext(overrides: Partial<FeishuInboundContext> = {}): FeishuInboundContext {
  return {
    eventId: 'evt1', messageId: 'om_1', chatId: 'oc_group', chatType: 'group',
    senderId: 'ou_user', senderUnionId: 'on_user', senderType: 'user', messageType: 'text',
    text: 'hello', mentions: [], isBotMentioned: true, content: {}, rawEvent: {},
    accountId: '1', ...overrides,
  };
}

describe('FeishuMessageService', () => {
  function makeRepo(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      findGroupConversation: vi.fn(async () => ({ id: 1, appId: '1', chatId: 'oc_group', sessionId: 9, ownerUserId: 3, lastContextLogId: 0 })),
      findConversationBySessionId: vi.fn(),
      findMediaByMessageId: vi.fn(),
      saveConversation: vi.fn(),
      claimInboundMessage: vi.fn(),
      releaseInboundMessage: vi.fn(),
      completeInboundMessage: vi.fn(),
      appendGroupMessage: vi.fn(),
      updateGroupContextWatermark: vi.fn(async () => undefined),
      updateGroupContextSummary: vi.fn(async () => undefined),
      listGroupMessages: vi.fn(async () => []),
      listOverflowGroupMessages: vi.fn(async () => []),
      addGroupMember: vi.fn(),
      ...overrides,
    };
  }

  it('builds group context excluding the triggering message itself', async () => {
    const repository = makeRepo({
      listGroupMessages: vi.fn(async () => [
        { id: 1, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_old', content: '昨天讨论' },
        { id: 2, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_b', senderName: '王五', isMention: true, messageId: 'om_previous_mention', content: '机器人之前的问题' },
        { id: 3, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_user', senderName: '李四', isMention: true, messageId: 'om_1', content: 'hello' },
      ]),
    });
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 20, 120);
    const group = await service.buildGroupContext('1', makeContext());
    expect(group.prompt).toContain('昨天讨论');
    expect(group.prompt).not.toContain('机器人之前的问题');
    expect(group.prompt).not.toContain('hello');
    expect(group.messages.map((m) => m.messageId)).toEqual(['om_old']);
    // 注入后水位线推进到当前最大 log id，避免下轮重复注入。
    expect(repository.updateGroupContextWatermark).toHaveBeenCalledWith('1', 'oc_group', 3);
  });

  it('only injects messages newer than the watermark (incremental context)', async () => {
    const repository = makeRepo({
      findGroupConversation: vi.fn(async () => ({ id: 1, appId: '1', chatId: 'oc_group', sessionId: 9, ownerUserId: 3, lastContextLogId: 2 })),
      listGroupMessages: vi.fn(async () => [
        { id: 2, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_injected', content: '上一轮已注入' },
        { id: 3, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_new', content: '新增讨论', createdAt: '2026-08-26 13:18:00' },
      ]),
    });
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 20, 120);
    const group = await service.buildGroupContext('1', makeContext({ messageId: 'om_trigger' }));
    expect(group.prompt).toBe('[2026-08-26 13:18] 张三：新增讨论');
    expect(repository.updateGroupContextWatermark).toHaveBeenCalledWith('1', 'oc_group', 3);
  });

  it('records group message with media type and file key', async () => {
    const repository = { appendGroupMessage: vi.fn(async () => 5) };
    const service = new FeishuMessageService(repository as never, {} as never, 20, 120);
    const id = await service.recordGroupMessage('1', makeContext({
      messageType: 'file', fileKey: 'file_9', fileName: 'a.pdf', text: '[文件:a.pdf]',
    }), true);
    expect(id).toBe(5);
    expect(repository.appendGroupMessage).toHaveBeenCalledWith(expect.objectContaining({
      appId: '1', chatId: 'oc_group', senderOpenId: 'ou_user', isMention: true,
      msgType: 'file', fileKey: 'file_9', fileName: 'a.pdf', content: '[文件:a.pdf]',
    }));
  });

  it('creates conversation under lock on first group message', async () => {
    const repository = makeRepo({
      findGroupConversation: vi.fn(async () => null),
      saveConversation: vi.fn(async (c: unknown) => ({ id: 1, ...c })),
      appendGroupMessage: vi.fn(),
    });
    const sessionFactory = { create: vi.fn(async () => ({ sessionId: 9, ownerUserId: 3, workspace: '/ws' })) };
    const service = new FeishuMessageService(repository as never, sessionFactory as never, 20, 120);
    const conv = await service.getOrCreateGroup('1', makeContext());
    expect(conv.sessionId).toBe(9);
    expect(sessionFactory.create).toHaveBeenCalledOnce();
    expect(repository.saveConversation).toHaveBeenCalledWith(expect.objectContaining({ appId: '1', chatId: 'oc_group', sessionId: 9, ownerUserId: 3 }));
  });

  it('creates p2p conversation keyed by prefixed identity with owner isolation', async () => {
    const repository = makeRepo({
      findGroupConversation: vi.fn(async (appId: string, chatId: string, userId?: number) => {
        expect(appId).toBe('1');
        // 身份形态在建会话时确定并编码进前缀：优先 union，缺失回退 open。
        expect(chatId).toBe('p2p:union:on_user');
        expect(userId).toBe(3);
        return null;
      }),
      saveConversation: vi.fn(async (c: unknown) => ({ id: 2, ...c })),
    });
    const sessionFactory = { create: vi.fn(async () => ({ sessionId: 10, ownerUserId: 3 })) };
    const service = new FeishuMessageService(repository as never, sessionFactory as never, 20, 120);
    const conv = await service.getOrCreateP2p('1', makeContext({ chatType: 'p2p' }), 3);
    expect(conv.id).toBe(2);
  });

  it('falls back to open_id prefix when the event carries no union id', async () => {
    const repository = makeRepo({
      findGroupConversation: vi.fn(async (_appId: string, chatId: string) => {
        expect(chatId).toBe('p2p:open:ou_user');
        return { id: 4, appId: '1', chatId, sessionId: 11, ownerUserId: 5 };
      }),
    });
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 20, 120);
    const conv = await service.getOrCreateP2p('1', makeContext({ chatType: 'p2p', senderUnionId: null }));
    expect(conv.id).toBe(4);
  });

  it('throws when group message lacks chat or sender', async () => {
    const service = new FeishuMessageService({} as never, {} as never, 20, 120);
    await expect(service.recordGroupMessage('1', makeContext({ chatId: null }), false)).rejects.toThrow();
    await expect(service.recordGroupMessage('1', makeContext({ senderId: null }), false)).rejects.toThrow();
  });

  it('summarizes overflow messages and prepends the summary to the prompt', async () => {
    const repository = makeRepo({
      findGroupConversation: vi.fn(async () => ({ id: 1, appId: '1', chatId: 'oc_group', sessionId: 9, ownerUserId: 3, lastContextLogId: 0 })),
      listGroupMessages: vi.fn(async () => [
        { id: 101, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_recent', content: '最近讨论', createdAt: '2026-08-26 13:18:00' },
      ]),
      listOverflowGroupMessages: vi.fn(async () => [
        { id: 50, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_overflow', content: '更早的讨论', createdAt: '2026-08-25 09:00:00' },
      ]),
    });
    const summarize = vi.fn(async () => '此前讨论了部署方案，决定周五上线。');
    const summarizer = { summarize } as never;
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 20, 120, summarizer, 100);
    const group = await service.buildGroupContext('1', makeContext({ messageId: 'om_trigger' }));
    // 溢出查询以最近窗口最小 id 为上界，且不受时间窗限制。
    expect(repository.listOverflowGroupMessages).toHaveBeenCalledWith('1', 'oc_group', 0, 101, 100);
    expect(summarize).toHaveBeenCalledWith(expect.stringContaining('[2026-08-25 09:00] 张三：更早的讨论'), 9);
    expect(group.prompt).toBe(
      '[更早历史消息摘要]\n此前讨论了部署方案，决定周五上线。\n[2026-08-26 13:18] 张三：最近讨论',
    );
    expect(repository.updateGroupContextSummary).toHaveBeenCalledWith('1', 'oc_group', '此前讨论了部署方案，决定周五上线。', 50);
    // 水位线仍推进到最近窗口最大 id，摘要后的溢出消息下轮不再重复处理。
    expect(repository.updateGroupContextWatermark).toHaveBeenCalledWith('1', 'oc_group', 101);
  });

  it('reuses the cached overflow summary when it already covers the overflow range', async () => {
    const repository = makeRepo({
      findGroupConversation: vi.fn(async () => ({
        id: 1, appId: '1', chatId: 'oc_group', sessionId: 9, ownerUserId: 3, lastContextLogId: 0,
        contextSummary: '缓存摘要', contextSummaryLogId: 50,
      })),
      listGroupMessages: vi.fn(async () => [
        { id: 101, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_recent', content: '最近讨论', createdAt: '2026-08-26 13:18:00' },
      ]),
      listOverflowGroupMessages: vi.fn(async () => [
        { id: 50, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_overflow', content: '更早的讨论', createdAt: '2026-08-25 09:00:00' },
      ]),
    });
    const summarize = vi.fn();
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 20, 120, { summarize } as never, 100);
    const group = await service.buildGroupContext('1', makeContext({ messageId: 'om_trigger' }));
    expect(group.prompt).toBe('[更早历史消息摘要]\n缓存摘要\n[2026-08-26 13:18] 张三：最近讨论');
    expect(summarize).not.toHaveBeenCalled();
    expect(repository.updateGroupContextSummary).not.toHaveBeenCalled();
  });

  it('skips the summary injection when summarization fails', async () => {
    const repository = makeRepo({
      findGroupConversation: vi.fn(async () => ({ id: 1, appId: '1', chatId: 'oc_group', sessionId: 9, ownerUserId: 3, lastContextLogId: 0 })),
      listGroupMessages: vi.fn(async () => [
        { id: 101, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_recent', content: '最近讨论', createdAt: '2026-08-26 13:18:00' },
      ]),
      listOverflowGroupMessages: vi.fn(async () => [
        { id: 50, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_overflow', content: '更早的讨论', createdAt: '2026-08-25 09:00:00' },
      ]),
    });
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 20, 120, { summarize: vi.fn(async () => null) } as never, 100);
    const group = await service.buildGroupContext('1', makeContext({ messageId: 'om_trigger' }));
    expect(group.prompt).toBe('[2026-08-26 13:18] 张三：最近讨论');
    expect(repository.updateGroupContextSummary).not.toHaveBeenCalled();
    expect(repository.updateGroupContextWatermark).toHaveBeenCalledWith('1', 'oc_group', 101);
  });

  it('does not query overflow or call the summarizer when none is configured', async () => {
    const repository = makeRepo({
      listGroupMessages: vi.fn(async () => [
        { id: 101, appId: '1', chatId: 'oc_group', senderOpenId: 'ou_a', senderName: '张三', isMention: false, messageId: 'om_recent', content: '最近讨论', createdAt: '2026-08-26 13:18:00' },
      ]),
    });
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 20, 120);
    const group = await service.buildGroupContext('1', makeContext({ messageId: 'om_trigger' }));
    expect(group.prompt).toBe('[2026-08-26 13:18] 张三：最近讨论');
    expect(repository.listOverflowGroupMessages).not.toHaveBeenCalled();
  });
});
