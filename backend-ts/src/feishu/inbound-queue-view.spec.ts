import { describe, expect, it, vi } from 'vitest';
import { BusinessException } from '../common/business-exception.js';
import {
  buildQueueViewColumns,
  canCancelQueueItem,
  createFeishuInboundQueueView,
  createRunningChannelResolver,
  parseQueuePayloadSummary,
  toInboundQueueItemVO,
} from './inbound-queue-view.js';
import type { FeishuInboundContext, FeishuInboundQueueListItem, FeishuInboundQueueRow } from './types.js';

function context(overrides: Partial<FeishuInboundContext> = {}): FeishuInboundContext {
  return {
    eventId: null, messageId: 'om_1', chatId: 'oc_1', chatType: 'group', senderId: 'ou_1',
    senderUnionId: 'un_1', senderName: '杨佳毅', senderType: 'user', messageType: 'text',
    text: '', mentions: [], isBotMentioned: false, content: {}, rawEvent: {},
    accountId: '2', senderLabel: '杨佳毅',
    ...overrides,
  } as FeishuInboundContext;
}

function listRow(overrides: Partial<FeishuInboundQueueListItem> = {}): FeishuInboundQueueListItem {
  return {
    id: 1, botId: 1, sessionId: 7, messageId: 'om_1', cardMessageId: 'om_card_1',
    senderOpenId: 'ou_1', maoUserId: 42, rankNo: 1, status: 'QUEUED',
    summary: '发布生产环境', senderLabel: '杨佳毅', imageCount: 0, fileCount: 0,
    createdAt: '2026-11-25 14:07:49',
    ...overrides,
  };
}

function fullRow(overrides: Partial<FeishuInboundQueueRow> = {}): FeishuInboundQueueRow {
  return {
    id: 1, botId: 1, sessionId: 7, messageId: 'om_1', cardMessageId: null,
    senderOpenId: 'ou_1', maoUserId: 42, rankNo: 1, status: 'QUEUED', payload: '{}',
    ...overrides,
  };
}

describe('buildQueueViewColumns', () => {
  it('takes context.text and collapses whitespace, keeps group sender', () => {
    const cols = buildQueueViewColumns(context({ text: '  第一行\n\n第二行  ' }), '【用户消息】\n杨佳毅：第一行\n\n第二行');
    expect(cols.summary).toBe('第一行 第二行');
    expect(cols.senderLabel).toBe('杨佳毅');
    expect(cols.imageCount).toBe(0);
    expect(cols.fileCount).toBe(0);
  });

  it('omits sender label in p2p chats', () => {
    const cols = buildQueueViewColumns(context({ chatType: 'p2p', text: '你好' }), '你好');
    expect(cols.senderLabel).toBeNull();
  });

  it('counts image parts and falls back to [图片] when text is empty', () => {
    const message = [{ type: 'text', text: '' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,x' } }];
    const cols = buildQueueViewColumns(context({ text: '' }), message);
    expect(cols.imageCount).toBe(1);
    expect(cols.summary).toBe('[图片]');
  });

  it('counts file references from the built message (composeContent puts them there)', () => {
    // context.text 是用户原文，文件引用由 composeContent 拼进 message 的 text part
    const message = [{ type: 'text', text: '【用户消息】\n杨佳毅：看下 @{/tmp/a.pdf}@ 和 @{/tmp/b.pdf}@' }];
    const cols = buildQueueViewColumns(context({ text: '看下这两个' }), message);
    expect(cols.fileCount).toBe(2);
  });

  it('counts file references for the string message path (no images)', () => {
    // composeContent 无图片时返回 string，文件引用拼在字符串末尾——这是「正文 + 文件」的主路径
    const message = '【用户消息】\n杨佳毅：看下这个文件\n@{/tmp/a.pdf}@';
    const cols = buildQueueViewColumns(context({ text: '看下这个文件' }), message);
    expect(cols.fileCount).toBe(1);
  });

  it('does not double count when both context.text and message contain references', () => {
    // 单一事实源：即使原文里也写了同样的引用写法，也不与 message 叠加
    const message = [{ type: 'text', text: '【用户消息】\n杨佳毅：看 @{/tmp/a.pdf}@' }];
    const cols = buildQueueViewColumns(context({ text: '看 @{/tmp/a.pdf}@' }), message);
    expect(cols.fileCount).toBe(1);
  });

  it('falls back to [空消息] for empty bodies', () => {
    const cols = buildQueueViewColumns(context({ text: '' }), '');
    expect(cols.summary).toBe('[空消息]');
  });

  it('truncates to 60 chars and appends ellipsis', () => {
    const long = 'x'.repeat(80);
    const cols = buildQueueViewColumns(context({ text: long }), long);
    expect(cols.summary).toBe(`${'x'.repeat(60)}…`);
  });
});

describe('parseQueuePayloadSummary', () => {
  it('keeps all remaining paragraphs after stripping the group prefix', () => {
    const payload = JSON.stringify({
      message: '【群内最近消息】\nA：你好\n\n【用户消息】\n杨佳毅：第一段\n\n第二段',
      context: { chatType: 'group', senderLabel: '杨佳毅' },
    });
    const parsed = parseQueuePayloadSummary(payload);
    // 按 \n\n 分段取最后一段会丢内容：这里断言剥前缀后保留剩余全部正文
    expect(parsed.summary).toBe('第一段 第二段');
    expect(parsed.senderLabel).toBe('杨佳毅');
  });

  it('parses content parts and image count', () => {
    const payload = JSON.stringify({
      message: [{ type: 'text', text: '看图' }, { type: 'image_url', imageUrl: { url: 'data:image/png;base64,x' } }],
      context: { chatType: 'p2p' },
    });
    const parsed = parseQueuePayloadSummary(payload);
    expect(parsed.summary).toBe('看图');
    expect(parsed.imageCount).toBe(1);
    expect(parsed.senderLabel).toBeNull();
  });

  it('falls back to a placeholder for invalid payloads', () => {
    expect(parseQueuePayloadSummary('not-json').summary).toBe('[无法解析的排队消息]');
  });

  it('does not strip a p2p colon prefix (only group chats have sender prefix)', () => {
    const payload = JSON.stringify({ message: '结论：可以上线', context: { chatType: 'p2p' } });
    expect(parseQueuePayloadSummary(payload).summary).toBe('结论：可以上线');
  });

  it('extracts the user body after the quoted section in p2p', () => {
    const payload = JSON.stringify({
      message: '【引用的消息】\n上一句\n\n我的回复',
      context: { chatType: 'p2p' },
    });
    expect(parseQueuePayloadSummary(payload).summary).toBe('我的回复');
  });

  it('ignores file references inside the p2p quoted section (only the body counts)', () => {
    const quotedContext = '旧文件 @{/tmp/old.pdf}@';
    const payload = JSON.stringify({
      message: `【引用的消息】\n${quotedContext}\n\n我的附件 @{/tmp/new.pdf}@`,
      context: { chatType: 'p2p', quotedContext },
    });
    const parsed = parseQueuePayloadSummary(payload);
    expect(parsed.summary).toBe('我的附件 @{/tmp/new.pdf}@');
    expect(parsed.fileCount).toBe(1);
  });

  it('locates the p2p quoted section by quotedContext when the quote has multiple paragraphs', () => {
    const quotedContext = '第一段引用\n\n第二段引用';
    const payload = JSON.stringify({
      message: `【引用的消息】\n${quotedContext}\n\n我的回复`,
      context: { chatType: 'p2p', quotedContext },
    });
    expect(parseQueuePayloadSummary(payload).summary).toBe('我的回复');
  });

  it('strips the group prefix for content part payloads', () => {
    const payload = JSON.stringify({
      message: [{ type: 'text', text: '【用户消息】\n杨佳毅：看图' }, { type: 'image_url', imageUrl: { url: 'x' } }],
      context: { chatType: 'group', senderLabel: '杨佳毅' },
    });
    const parsed = parseQueuePayloadSummary(payload);
    expect(parsed.summary).toBe('看图');
    expect(parsed.imageCount).toBe(1);
  });

  it('uses [空消息] for a legitimately empty body instead of 无法解析', () => {
    const payload = JSON.stringify({ message: '', context: { chatType: 'p2p' } });
    expect(parseQueuePayloadSummary(payload).summary).toBe('[空消息]');
  });
});

describe('canCancelQueueItem / toInboundQueueItemVO', () => {
  it('allows owner when sender is unbound, and self always', () => {
    expect(canCancelQueueItem(null, 42)).toBe(true);
    expect(canCancelQueueItem(42, 42)).toBe(true);
    expect(canCancelQueueItem(43, 42)).toBe(false);
  });

  it('maps position and id into the VO', () => {
    const vo = toInboundQueueItemVO(
      99,
      { summary: '摘要', senderLabel: '杨佳毅', imageCount: 1, fileCount: 2, createdAt: '2026-11-25 14:07:49' },
      3,
      true,
    );
    expect(vo).toEqual({
      id: '99', senderLabel: '杨佳毅', summary: '摘要', imageCount: 1, fileCount: 2,
      createdAt: '2026-11-25 14:07:49', queuePosition: 3, cancelable: true,
    });
  });
});

describe('createRunningChannelResolver', () => {
  const resolver = createRunningChannelResolver({
    hasFeishuRunning: (id) => id === 1,
    hasLocalClaim: (id) => id === 2,
  });

  it('reports feishu / local / null by claim source', () => {
    expect(resolver(1)).toBe('feishu');
    expect(resolver(2)).toBe('local');
    expect(resolver(3)).toBeNull();
  });

  it('returns null for terminal phases regardless of stale busy sets', () => {
    expect(resolver(1, 'COMPLETED')).toBeNull();
    expect(resolver(1, 'FAILED')).toBeNull();
    expect(resolver(2, 'CANCELLED')).toBeNull();
    expect(resolver(1, 'RUNNING')).toBe('feishu');
  });
});

describe('createFeishuInboundQueueView', () => {
  function makeView(overrides: {
    rows?: FeishuInboundQueueListItem[];
    findById?: (id: number) => Promise<FeishuInboundQueueRow | null>;
    cancel?: (id: number) => Promise<'CANCELLED' | 'ALREADY_STARTED' | 'NOT_FOUND'>;
    patchQueueCard?: (botId: number, cardMessageId: string, card: Record<string, unknown>) => Promise<void>;
    renderCancelledCard?: () => Record<string, unknown> | null;
  } = {}) {
    const repo = {
      listQueuedBySession: vi.fn(async () => overrides.rows ?? [listRow()]),
      findById: vi.fn(overrides.findById ?? (async () => fullRow())),
    };
    const queue = { cancel: vi.fn(overrides.cancel ?? (async () => 'CANCELLED' as const)) };
    const patchQueueCard = vi.fn(overrides.patchQueueCard ?? (async () => undefined));
    const view = createFeishuInboundQueueView({
      repo,
      queue,
      resolveRunningChannel: (sessionId, phase) => (phase === 'FAILED' ? null : sessionId === 7 ? 'feishu' : null),
      renderCancelledCard: overrides.renderCancelledCard ?? (() => ({ schema: '2.0', body: { elements: [] } })),
      patchQueueCard,
    });
    return { view, repo, queue, patchQueueCard };
  }

  it('lists queued rows with positions and cancelable flags', async () => {
    const { view } = makeView({
      rows: [
        listRow({ id: 1, maoUserId: 42 }),
        listRow({ id: 2, maoUserId: null, summary: '第二条' }),
      ],
    });
    const payload = await view.list({ id: 7, userId: 42, phase: 'RUNNING' }, 42);
    expect(payload.runningChannel).toBe('feishu');
    expect(payload.lastRunFailed).toBe(false);
    expect(payload.items.map((i) => [i.id, i.queuePosition, i.cancelable])).toEqual([['1', 1, true], ['2', 2, true]]);
  });

  it('marks items from other senders as not cancelable', async () => {
    const { view } = makeView({ rows: [listRow({ maoUserId: 99 })] });
    const payload = await view.list({ id: 7, userId: 42 }, 42);
    expect(payload.items[0]!.cancelable).toBe(false);
  });

  it('sets lastRunFailed from session phase', async () => {
    const { view } = makeView();
    const payload = await view.list({ id: 7, userId: 42, phase: 'FAILED' }, 42);
    expect(payload.runningChannel).toBeNull();
    expect(payload.lastRunFailed).toBe(true);
  });

  it('falls back to payload parsing for legacy rows without summary column', async () => {
    const { view } = makeView({
      rows: [listRow({ summary: null, senderLabel: null, imageCount: 0, fileCount: 0 })],
      findById: async () => fullRow({
        payload: JSON.stringify({ message: '【用户消息】\n杨佳毅：老数据消息', context: { chatType: 'group', senderLabel: '杨佳毅' } }),
      }),
    });
    const payload = await view.list({ id: 7, userId: 42 }, 42);
    expect(payload.items[0]!.summary).toBe('老数据消息');
    expect(payload.items[0]!.senderLabel).toBe('杨佳毅');
  });

  it('returns NOT_FOUND for missing or foreign rows', async () => {
    const missing = makeView({ findById: async () => null });
    expect(await missing.view.cancel({ id: 7 }, 1, 42)).toBe('NOT_FOUND');

    const foreign = makeView({ findById: async () => fullRow({ sessionId: 8 }) });
    expect(await foreign.view.cancel({ id: 7 }, 1, 42)).toBe('NOT_FOUND');
  });

  it('rejects cancelling another sender message', async () => {
    const { view, queue } = makeView({ findById: async () => fullRow({ maoUserId: 99 }) });
    await expect(view.cancel({ id: 7 }, 1, 42)).rejects.toBeInstanceOf(BusinessException);
    expect(queue.cancel).not.toHaveBeenCalled();
  });

  it('patches the Feishu card after a successful cancel', async () => {
    const { view, patchQueueCard } = makeView({ findById: async () => fullRow({ cardMessageId: 'om_card_1' }) });
    expect(await view.cancel({ id: 7 }, 1, 42)).toBe('CANCELLED');
    expect(patchQueueCard).toHaveBeenCalledWith(1, 'om_card_1', expect.any(Object));
  });

  it('skips the PATCH when the card message id is missing', async () => {
    const { view, patchQueueCard } = makeView({ findById: async () => fullRow({ cardMessageId: null }) });
    expect(await view.cancel({ id: 7 }, 1, 42)).toBe('CANCELLED');
    expect(patchQueueCard).not.toHaveBeenCalled();
  });

  it('swallows PATCH failures (row already deleted, panel converged)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { view } = makeView({
      findById: async () => fullRow({ cardMessageId: 'om_card_1' }),
      patchQueueCard: async () => { throw new Error('patch failed'); },
    });
    await expect(view.cancel({ id: 7 }, 1, 42)).resolves.toBe('CANCELLED');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('does not patch when cancel loses the race', async () => {
    const { view, patchQueueCard } = makeView({ cancel: async () => 'ALREADY_STARTED' });
    expect(await view.cancel({ id: 7 }, 1, 42)).toBe('ALREADY_STARTED');
    expect(patchQueueCard).not.toHaveBeenCalled();
  });
});
