import { describe, expect, it } from 'vitest';
import { buildFeishuProgressCard, feishuSessionDetailUrl, formatFeishuDuration } from './progress-card.js';

type CardElement = {
  tag: string;
  content?: string;
  columns?: Array<{ elements: Array<{ value?: Record<string, unknown>; behaviors?: Array<{ type: string; default_url?: string }>; text?: { content?: string } }> }>;
};

function elementsOf(card: Record<string, unknown>): CardElement[] {
  return (card.body as { elements: CardElement[] }).elements;
}

function statusLineOf(card: Record<string, unknown>): string {
  return elementsOf(card)[0].content ?? '';
}

function cancelButtonValue(card: Record<string, unknown>): Record<string, unknown> | null {
  const columnSet = elementsOf(card).find((element) => element.tag === 'column_set');
  const cancel = columnSet?.columns
    ?.flatMap((column) => column.elements)
    .find((element) => element.value?.kind === 'feishu_progress');
  return cancel?.value ?? null;
}

function sessionDetailButtons(card: Record<string, unknown>): Array<{ label?: string; url?: string }> {
  return elementsOf(card)
    .flatMap((element) => element.columns?.flatMap((column) => column.elements) ?? [])
    .filter((element) => element.tag === 'button' && element.text?.content === '会话详情')
    .map((element) => ({ label: element.text?.content, url: element.behaviors?.[0]?.default_url }));
}

describe('飞书进度卡片状态行', () => {
  it('终态展示「共 n 轮」与耗时', () => {
    const card = buildFeishuProgressCard('COMPLETED', 8, '任务结果', [], undefined, 506_000);
    expect(statusLineOf(card)).toBe('**状态：处理完成** · 共 8 轮 · 耗时 8 分 26 秒');
  });

  it('执行中保持「第 n 轮」且不展示耗时', () => {
    const card = buildFeishuProgressCard('RUNNING', 2, '', [], undefined, 506_000);
    expect(statusLineOf(card)).toBe('**状态：正在处理** · 第 2 轮');
  });

  it('取消与失败终态同样带耗时', () => {
    expect(statusLineOf(buildFeishuProgressCard('CANCELLED', 3, '', [], undefined, 45_000)))
      .toBe('**状态：任务已取消** · 共 3 轮 · 耗时 45 秒');
    expect(statusLineOf(buildFeishuProgressCard('FAILED', 1, '', [], undefined, 61_000)))
      .toBe('**状态：处理失败** · 共 1 轮 · 耗时 1 分 1 秒');
  });

  it('无耗时数据时只展示轮数（如定时任务结果回流卡片）', () => {
    expect(statusLineOf(buildFeishuProgressCard('COMPLETED', 0, '任务结果', []))).toBe('**状态：处理完成**');
    expect(statusLineOf(buildFeishuProgressCard('COMPLETED', 2, '任务结果', []))).toBe('**状态：处理完成** · 共 2 轮');
  });
});

describe('飞书进度卡片「取消任务」按钮', () => {
  const cancelAction = { sessionId: 7, sender: 'ou_sender' };

  it('执行中带按钮、绑定会话与发送者', () => {
    const value = cancelButtonValue(buildFeishuProgressCard('RUNNING', 1, '', [], cancelAction));
    expect(value).toEqual({ kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_sender' });
  });

  it('终态不带按钮（随卡片重写自动消失）', () => {
    expect(cancelButtonValue(buildFeishuProgressCard('COMPLETED', 1, '', [], cancelAction, 1000))).toBeNull();
    expect(cancelButtonValue(buildFeishuProgressCard('CANCELLED', 1, '', [], cancelAction, 1000))).toBeNull();
  });
});

describe('飞书进度卡片「会话详情」按钮', () => {
  const cancelAction = { sessionId: 7, sender: 'ou_sender' };
  const detailUrl = 'https://mao.example.com/tasks/7';

  it('执行中与取消任务并排，open_url 指向网页会话页', () => {
    const card = buildFeishuProgressCard('RUNNING', 1, '', [], cancelAction, undefined, detailUrl);
    expect(cancelButtonValue(card)).not.toBeNull();
    expect(sessionDetailButtons(card)).toEqual([{ label: '会话详情', url: detailUrl }]);
  });

  it('终态仅保留会话详情按钮', () => {
    const card = buildFeishuProgressCard('COMPLETED', 3, '完成', [], cancelAction, 1000, detailUrl);
    expect(cancelButtonValue(card)).toBeNull();
    expect(sessionDetailButtons(card)).toEqual([{ label: '会话详情', url: detailUrl }]);
  });

  it('未提供链接时不渲染按钮区', () => {
    const card = buildFeishuProgressCard('COMPLETED', 1, '完成', []);
    expect(sessionDetailButtons(card)).toEqual([]);
    expect(elementsOf(card).some((element) => element.tag === 'column_set')).toBe(false);
  });
});

describe('feishuSessionDetailUrl', () => {
  it('从回调 URL origin 拼 /tasks/{id}', () => {
    expect(feishuSessionDetailUrl('https://mao.example.com/auth/ecp/feishu-callback', 42))
      .toBe('https://mao.example.com/tasks/42');
  });

  it('已带尾斜杠的站点根同样可用', () => {
    expect(feishuSessionDetailUrl('https://mao.example.com/', 1)).toBe('https://mao.example.com/tasks/1');
  });

  it('空值/非法 URL 返回 undefined', () => {
    expect(feishuSessionDetailUrl('', 1)).toBeUndefined();
    expect(feishuSessionDetailUrl(null, 1)).toBeUndefined();
    expect(feishuSessionDetailUrl('not-a-url', 1)).toBeUndefined();
  });
});

describe('formatFeishuDuration', () => {
  it('按秒/分/时分级展示并省略零头', () => {
    expect(formatFeishuDuration(0)).toBe('0 秒');
    expect(formatFeishuDuration(59_999)).toBe('59 秒');
    expect(formatFeishuDuration(60_000)).toBe('1 分');
    expect(formatFeishuDuration(506_000)).toBe('8 分 26 秒');
    expect(formatFeishuDuration(3_600_000)).toBe('1 小时');
    expect(formatFeishuDuration(3_725_000)).toBe('1 小时 2 分');
  });

  it('负数按 0 秒处理', () => {
    expect(formatFeishuDuration(-5000)).toBe('0 秒');
  });
});
