import { describe, expect, it } from 'vitest';
import {
  buildTaskNotificationCard,
  buildTaskNotificationText,
  NOTIFICATION_USER_MESSAGE_MAX_CHARS,
} from './feishu-notification-card.js';

function cardText(card: Record<string, unknown>): string {
  return JSON.stringify(card);
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
    expect(card.header).toEqual({
      template: 'green',
      title: { tag: 'plain_text', content: 'Mao Agent 任务通知' },
    });
    const text = cardText(card);
    expect(text).toContain('技能指令入口迁移');
    expect(text).toContain('已完成');
    expect(text).toContain('把技能指令入口迁到新目录');
    expect(text).toContain('会话详情');
    expect(text).toContain('https://mao.example.com/tasks/7');
    expect(text).toContain('2026-09-25 09:13:20');
    // 1.0 卡片结构：按钮放在 action 模块里。
    expect(text).toContain('"tag":"action"');
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
    expect(text).not.toContain('"tag":"action"');
  });

  it('marks failures with a red header and the failure reason', () => {
    const card = buildTaskNotificationCard({
      phase: 'FAILED', title: '插件平台匹配问题', failureReason: '上游 502',
    });
    expect((card.header as { template: string }).template).toBe('red');
    const text = cardText(card);
    expect(text).toContain('执行失败');
    expect(text).toContain('上游 502');
  });

  it('marks pending questions with an orange header and answering hint', () => {
    const card = buildTaskNotificationCard({ phase: 'ASK_USER', title: '精简 Termix 界面' });
    expect((card.header as { template: string }).template).toBe('orange');
    const text = cardText(card);
    expect(text).toContain('Mao Agent 提问通知');
    expect(text).toContain('精简 Termix 界面');
    expect(text).toContain('请到会话页面作答');
  });
});

describe('buildTaskNotificationText', () => {
  it('keeps the legacy plain-text wording for all three phases', () => {
    const completed = buildTaskNotificationText({
      phase: 'COMPLETED', title: '任务A', userMessage: '不该出现在文本里', now: new Date('2026-09-25T09:13:20+08:00'),
    });
    expect(completed).toBe('Mao Agent 任务通知\n任务：任务A\n结果：已完成\n时间：2026-09-25 09:13:20');
    expect(completed).not.toContain('不该出现在文本里');

    const failed = buildTaskNotificationText({
      phase: 'FAILED', title: '任务B', failureReason: '超时', now: new Date('2026-09-25T09:13:20+08:00'),
    });
    expect(failed).toBe('Mao Agent 任务通知\n任务：任务B\n结果：执行失败\n时间：2026-09-25 09:13:20\n原因：超时');

    const ask = buildTaskNotificationText({
      phase: 'ASK_USER', title: '任务C', now: new Date('2026-09-25T09:13:20+08:00'),
    });
    expect(ask).toContain('Mao Agent 提问通知');
    expect(ask).toContain('正在等待回答');
  });
});
