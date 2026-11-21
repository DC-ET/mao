import { describe, expect, it, vi } from 'vitest';
import { createFeishuSessionHelper, createPinnedSessionAdapter } from './feishu-session.js';
import type { FeishuInboundContext } from './feishu/types.js';

function makeContext(overrides: Partial<FeishuInboundContext> = {}): FeishuInboundContext {
  return {
    eventId: 'evt1', messageId: 'om_1', chatId: 'oc_group', chatType: 'group',
    senderId: 'ou_user', senderUnionId: 'on_user', senderType: 'user', messageType: 'text',
    text: 'hello', mentions: [], isBotMentioned: true, content: {}, rawEvent: {},
    accountId: '1', ...overrides,
  };
}

function makeHelper(isAwaiting: boolean, existingTitle = '飞书Bot会话') {
  const updateFields = vi.fn(async () => undefined);
  const helper = createFeishuSessionHelper({
    feishuBots: { findById: vi.fn(async () => null) } as never,
    sessionService: { getSession: vi.fn(async () => ({ id: 7, title: existingTitle })) } as never,
    sessionRepo: { updateFields } as never,
    agentService: {} as never,
    modelService: {} as never,
    getFeishuChatTitle: vi.fn(async () => '项目群'),
    isAwaitingFirstMessageTitle: vi.fn(async () => isAwaiting),
  });
  return { helper, updateFields };
}

describe('ensureFeishuSessionTitle', () => {
  it('writes the group name for default sessions (pending flag absent)', async () => {
    const { helper, updateFields } = makeHelper(false);
    await helper.ensureFeishuSessionTitle(7, 1, makeContext());
    expect(updateFields).toHaveBeenCalledWith(7, { title: '项目群' });
  });

  it('does not overwrite the pending-title flag with the group name (group /new sessions)', async () => {
    // 待命名标志为 1（/new 新建的会话）：首条真正的 @ 会走 LLM 短标题命名，
    // 群名补写抢先覆盖会破坏「标题仍为飞书Bot会话」的门禁、互相覆盖。
    const { helper, updateFields } = makeHelper(true);
    await helper.ensureFeishuSessionTitle(7, 1, makeContext());
    expect(updateFields).not.toHaveBeenCalled();
  });

  it('skips non-default titles and non-group contexts', async () => {
    const { helper, updateFields } = makeHelper(false, '已有标题');
    await helper.ensureFeishuSessionTitle(7, 1, makeContext());
    expect(updateFields).not.toHaveBeenCalled();
    const { helper: p2pHelper, updateFields: p2pUpdate } = makeHelper(false);
    await p2pHelper.ensureFeishuSessionTitle(7, 1, makeContext({ chatType: 'p2p' }));
    expect(p2pUpdate).not.toHaveBeenCalled();
  });
});

describe('createPinnedSessionAdapter', () => {
  const context = {
    eventId: 'evt1', messageId: 'om_1', chatId: 'oc_group', chatType: 'group' as const,
    senderId: 'ou_user', senderUnionId: 'on_user', senderType: 'user', messageType: 'text',
    text: 'hello', mentions: [], isBotMentioned: true, content: {}, rawEvent: {}, accountId: '1',
  };

  function makeDeps() {
    return {
      resolveFeishuUserId: vi.fn(async () => 42),
      applyFeishuBotConfig: vi.fn(async () => undefined),
      ensureFeishuSessionTitle: vi.fn(async () => undefined),
    };
  }

  it('keeps all adapter side effects on the pinned path (R9 regression guard)', async () => {
    const deps = makeDeps();
    const pinnedSession = createPinnedSessionAdapter(deps);
    const session = await pinnedSession('1', context as never, 9, '/ws/group');
    // 三步副作用缺一不可：漏掉机器人热切换/标题补写会让所有非话题群消息静默回归。
    expect(deps.resolveFeishuUserId).toHaveBeenCalledWith('1', context);
    expect(deps.applyFeishuBotConfig).toHaveBeenCalledWith(9, 1);
    expect(deps.ensureFeishuSessionTitle).toHaveBeenCalledWith(9, 1, context);
    // 钉住值与执行身份原样返回：不读新指针，workspace 为 null 时回落 null。
    expect(session).toEqual({ id: 9, workspace: '/ws/group', executionUserId: 42 });
    expect(await createPinnedSessionAdapter(makeDeps())('1', context as never, 9, null)).toEqual({ id: 9, workspace: null, executionUserId: 42 });
  });
});
