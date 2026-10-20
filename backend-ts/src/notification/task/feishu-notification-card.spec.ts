import { describe, expect, it } from 'vitest';
import {
  buildTaskNotificationCard,
  buildTaskNotificationText,
  buildWeixinFallbackCard,
  WEIXIN_FALLBACK_HEADER,
  NOTIFICATION_USER_MESSAGE_MAX_CHARS,
} from './feishu-notification-card.js';

function cardText(card: Record<string, unknown>): string {
  return JSON.stringify(card);
}

/** 卡片 2.0 结构取正文元素。 */
function elementsOf(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return (card.body as { elements: Array<Record<string, unknown>> }).elements;
}

/** 在正文元素里找内容包含 needle 的 markdown 元素。 */
function markdownElementWith(card: Record<string, unknown>, needle: string): Record<string, unknown> | undefined {
  return elementsOf(card).find((element) => element.tag === 'markdown' && String(element.content).includes(needle));
}

describe('buildTaskNotificationCard', () => {
  it('renders title status user message and session detail button', () => {
    const card = buildTaskNotificationCard({
      phase: 'COMPLETED',
      title: '技能指令入口迁移',
      userMessage: '把技能指令入口迁到新目录',
      sessionDetailUrl: 'https://mao.example.com/tasks/7',
      now: new Date('2026-09-25T09:13:20+08:00'),
    });
    expect(card.schema).toBe('2.0');
    expect(card.header).toEqual({
      template: 'green',
      title: { tag: 'plain_text', content: 'Mao 任务完成通知' },
    });
    expect(markdownElementWith(card, '技能指令入口迁移')).toBeDefined();
    expect(markdownElementWith(card, '已完成')).toBeDefined();
    expect(markdownElementWith(card, '把技能指令入口迁到新目录')).toBeDefined();
    // 时间戳在 note 脚注（plain_text）里，不在正文 markdown 元素中
    expect(cardText(card)).toContain('2026-09-25 09:13:20');
    // 2.0 已移除 action 交互模块：按钮入 elements（column_set）+ behaviors.open_url 跳转。
    const text = cardText(card);
    expect(text).toContain('会话详情');
    expect(text).toContain('https://mao.example.com/tasks/7');
    expect(text).toContain('"tag":"column_set"');
    expect(text).toContain('"type":"open_url"');
    expect(text).not.toContain('"tag":"action"');
    // 不得退回 div>lark_md：那是 Markdown 表格不渲染的根因
    expect(text).not.toContain('lark_md');
  });

  it('truncates an over-long user message', () => {
    const long = 'x'.repeat(NOTIFICATION_USER_MESSAGE_MAX_CHARS + 50);
    const card = buildTaskNotificationCard({ phase: 'COMPLETED', title: '任务', userMessage: long });
    const text = cardText(card);
    expect(text).not.toContain('x'.repeat(NOTIFICATION_USER_MESSAGE_MAX_CHARS + 1));
    expect(text).toContain('…');
  });

  it('omits the user message section and button when absent', () => {
    const card = buildTaskNotificationCard({ phase: 'COMPLETED', title: '任务' });
    const text = cardText(card);
    expect(text).not.toContain('用户消息');
    expect(text).not.toContain('会话详情');
    expect(text).not.toContain('"tag":"column_set"');
  });

  it('marks failures with a red header and the failure reason', () => {
    const card = buildTaskNotificationCard({
      phase: 'FAILED', title: '插件平台匹配问题', failureReason: '上游 502',
    });
    expect((card.header as { template: string }).template).toBe('red');
    expect(markdownElementWith(card, '执行失败')).toBeDefined();
    expect(markdownElementWith(card, '上游 502')).toBeDefined();
  });

  it('marks pending questions with an orange header and answering hint', () => {
    const card = buildTaskNotificationCard({ phase: 'ASK_USER', title: '精简 Termix 界面' });
    expect((card.header as { template: string }).template).toBe('orange');
    expect((card.header as { title: { content: string } }).title.content).toBe('Mao 提问通知');
    expect(markdownElementWith(card, '精简 Termix 界面')).toBeDefined();
    expect(markdownElementWith(card, '请到会话页面作答')).toBeDefined();
  });

  it('renders a markdown table in the user message section', () => {
    // 2.0 + 顶层 markdown 元素的核心收益：正文含表格时正常渲染，不再吐出管道符。
    const card = buildTaskNotificationCard({
      phase: 'COMPLETED', title: '申购日报', userMessage: '| 名称 | 申菱转债 |\n| --- | --- |\n| 申购价 | 100 元/张 |',
    });
    expect(card.schema).toBe('2.0');
    expect(markdownElementWith(card, '申菱转债')).toBeDefined();
    expect(cardText(card)).not.toContain('lark_md');
  });
});

describe('buildWeixinFallbackCard', () => {
  it('renders reply body with a warning header and no action button', () => {
    const card = buildWeixinFallbackCard({
      reply: 'ET，早呀～今天的申购情况查好了：\n新股：有 1 只',
      now: new Date('2026-10-19T10:00:00+08:00'),
    });
    expect(card.header).toEqual({
      template: 'orange',
      title: { tag: 'plain_text', content: WEIXIN_FALLBACK_HEADER },
    });
    const text = cardText(card);
    // 主体是回复原文，不是任务标题/状态
    expect(text).toContain('今天的申购情况查好了');
    expect(text).toContain('无法送达微信');
    expect(text).toContain('2026-10-19 10:00:00');
    // 降级推送没有会话深链可点：不应出现按钮
    expect(text).not.toContain('"tag":"action"');
  });

  it('uses card 2.0 schema with top-level markdown element so md tables render', () => {
    // 回归：曾用 1.0 的 div>lark_md（文本格式 tag，只支持加粗/斜体/链接），
    // Markdown 表格被原样吐出管道符。必须与飞书会话进度卡同口径：
    // schema 2.0 + 顶层 tag:'markdown' 元素。
    const card = buildWeixinFallbackCard({ reply: '| 名称 | 天元重工 |\n| --- | --- |\n| 申购价 | 4.48 元/股 |' });
    expect(card.schema).toBe('2.0');
    const elements = (card.body as { elements: Array<Record<string, unknown>> }).elements;
    const body = elements.find((element) => element.tag === 'markdown' && String(element.content).includes('天元重工'));
    expect(body).toBeDefined();
    // 不得退回 div>lark_md：那是表格不渲染的根因
    expect(cardText(card)).not.toContain('lark_md');
  });

  it('keeps markdown structure of the reply intact', () => {
    const card = buildWeixinFallbackCard({ reply: '**新股：有 1 只**\n| 项目 | 信息 |' });
    expect(cardText(card)).toContain('"tag":"markdown"');
  });

  it('empty reply still yields a valid card skeleton', () => {
    const card = buildWeixinFallbackCard({ reply: '' });
    expect(cardText(card)).toContain('无法送达微信');
  });
});

describe('buildTaskNotificationText', () => {
  it('keeps the legacy plain-text wording for all three phases', () => {
    const completed = buildTaskNotificationText({
      phase: 'COMPLETED', title: '任务A', userMessage: '不该出现在文本里', now: new Date('2026-09-25T09:13:20+08:00'),
    });
    expect(completed).toBe('Mao 任务完成通知\n任务：任务A\n结果：已完成\n时间：2026-09-25 09:13:20');
    expect(completed).not.toContain('不该出现在文本里');

    const failed = buildTaskNotificationText({
      phase: 'FAILED', title: '任务B', failureReason: '超时', now: new Date('2026-09-25T09:13:20+08:00'),
    });
    expect(failed).toBe('Mao 任务失败通知\n任务：任务B\n结果：执行失败\n时间：2026-09-25 09:13:20\n原因：超时');

    const ask = buildTaskNotificationText({
      phase: 'ASK_USER', title: '任务C', now: new Date('2026-09-25T09:13:20+08:00'),
    });
    expect(ask).toContain('Mao 提问通知');
    expect(ask).toContain('正在等待回答');
  });
});
