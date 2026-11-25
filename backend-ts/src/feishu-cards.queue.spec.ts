import { describe, expect, it } from 'vitest';
import { buildFeishuQueueCard } from './feishu-cards.js';
import type { FeishuInboundContext } from './feishu/types.js';

function context(overrides: Partial<FeishuInboundContext> = {}): FeishuInboundContext {
  return {
    eventId: null, messageId: 'om_1', chatId: 'oc_1', chatType: 'group', senderId: 'ou_1',
    senderUnionId: 'un_1', senderName: '杨佳毅', senderType: 'user', messageType: 'text',
    text: '发布生产环境', mentions: [], isBotMentioned: true, content: {}, rawEvent: {},
    accountId: '2', senderLabel: '杨佳毅',
    ...overrides,
  } as FeishuInboundContext;
}

/** 卡片正文是 JSON 2.0 elements，拼起来做文本断言即可。 */
function cardText(card: Record<string, unknown>): string {
  const body = card.body as { elements?: Array<{ content?: string }> } | undefined;
  return (body?.elements ?? []).map((el) => el.content ?? '').join('\n');
}

function hasButton(card: Record<string, unknown>, label: string): boolean {
  return JSON.stringify(card).includes(`"content":"${label}"`);
}

describe('buildFeishuQueueCard', () => {
  it('uses the 飞书队列 position copy', () => {
    const card = buildFeishuQueueCard(context(), 9, 3);
    expect(cardText(card)).toContain('已进入飞书队列（第 3 位）');
    expect(hasButton(card, '立即发送')).toBe(true);
    expect(hasButton(card, '取消排队')).toBe(true);
  });

  it('appends the local queue hint only when M > 0', () => {
    expect(cardText(buildFeishuQueueCard(context(), 9, 1, 2))).toContain('另有 2 条本地排队消息将在其后执行');
    expect(cardText(buildFeishuQueueCard(context(), 9, 1, 0))).not.toContain('另有');
    expect(cardText(buildFeishuQueueCard(context(), 9, 1))).not.toContain('另有');
  });

  it('shows sender only for group chats', () => {
    expect(cardText(buildFeishuQueueCard(context(), 9, 1))).toContain('杨佳毅：发布生产环境');
    expect(cardText(buildFeishuQueueCard(context({ chatType: 'p2p' }), 9, 1))).not.toContain('杨佳毅：');
  });
});
