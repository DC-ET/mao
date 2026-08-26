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
      findP2pConversation: vi.fn(),
      findConversationBySessionId: vi.fn(),
      findMediaByMessageId: vi.fn(),
      saveConversation: vi.fn(),
      claimInboundMessage: vi.fn(),
      releaseInboundMessage: vi.fn(),
      completeInboundMessage: vi.fn(),
      appendGroupMessage: vi.fn(),
      updateGroupContextWatermark: vi.fn(async () => undefined),
      listGroupMessages: vi.fn(async () => []),
      isGroupMember: vi.fn(),
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
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 30, 120);
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
    const service = new FeishuMessageService(repository as never, { create: vi.fn() } as never, 30, 120);
    const group = await service.buildGroupContext('1', makeContext({ messageId: 'om_trigger' }));
    expect(group.prompt).toBe('[2026-08-26 13:18] 张三：新增讨论');
    expect(repository.updateGroupContextWatermark).toHaveBeenCalledWith('1', 'oc_group', 3);
  });

  it('records group message with media type and file key', async () => {
    const repository = { appendGroupMessage: vi.fn(async () => 5) };
    const service = new FeishuMessageService(repository as never, {} as never, 30, 120);
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
      findP2pConversation: vi.fn(async () => null),
      saveConversation: vi.fn(async (c: unknown) => ({ id: 1, ...c })),
      appendGroupMessage: vi.fn(),
    });
    const sessionFactory = { create: vi.fn(async () => ({ sessionId: 9, ownerUserId: 3, workspace: '/ws' })) };
    const service = new FeishuMessageService(repository as never, sessionFactory as never, 30, 120);
    const conv = await service.getOrCreateGroup('1', makeContext());
    expect(conv.sessionId).toBe(9);
    expect(sessionFactory.create).toHaveBeenCalledOnce();
    expect(repository.saveConversation).toHaveBeenCalledWith(expect.objectContaining({ appId: '1', chatId: 'oc_group', sessionId: 9, ownerUserId: 3 }));
  });

  it('creates p2p conversation keyed by union id with owner isolation', async () => {
    const repository = makeRepo({
      findP2pConversation: vi.fn(async (appId: string, userOpenId: string, userId?: number) => {
        expect(userOpenId).toBe('on_user');
        expect(userId).toBe(3);
        return null;
      }),
      findGroupConversation: vi.fn(async () => null),
      saveConversation: vi.fn(async (c: unknown) => ({ id: 2, ...c })),
    });
    const sessionFactory = { create: vi.fn(async () => ({ sessionId: 10, ownerUserId: 3 })) };
    const service = new FeishuMessageService(repository as never, sessionFactory as never, 30, 120);
    const conv = await service.getOrCreateP2p('1', makeContext({ chatType: 'p2p' }), 3);
    expect(conv.id).toBe(2);
    expect(repository.findP2pConversation).toHaveBeenCalledWith('1', 'on_user', 3);
  });

  it('throws when group message lacks chat or sender', async () => {
    const service = new FeishuMessageService({} as never, {} as never, 30, 120);
    await expect(service.recordGroupMessage('1', makeContext({ chatId: null }), false)).rejects.toThrow();
    await expect(service.recordGroupMessage('1', makeContext({ senderId: null }), false)).rejects.toThrow();
  });
});
