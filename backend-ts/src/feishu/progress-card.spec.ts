import { describe, expect, it } from 'vitest';
import { buildFeishuProgressCard, feishuSessionDetailUrl, formatFeishuDuration } from './progress-card.js';

type CardElement = {
  tag?: string;
  name?: string;
  content?: string;
  required?: boolean;
  form_action_type?: string;
  text?: { content?: string };
  value?: Record<string, unknown>;
  elements?: CardElement[];
  options?: Array<{ text?: { content?: string }; value?: string }>;
  placeholder?: { content?: string };
  behaviors?: Array<{ type?: string; value?: Record<string, unknown>; default_url?: string }>;
  columns?: Array<{ elements: Array<{ tag?: string; value?: Record<string, unknown>; behaviors?: Array<{ type: string; default_url?: string }>; text?: { content?: string } }> }>;
};

function elementsOf(card: Record<string, unknown>): CardElement[] {
  return (card.body as { elements: CardElement[] }).elements;
}

function statusLineOf(card: Record<string, unknown>): string {
  return elementsOf(card)[0].content ?? '';
}

function cancelButtonValue(card: Record<string, unknown>): Record<string, unknown> | null {
  return progressActionValues(card).find((value) => value.act === 'cancel') ?? null;
}

function retryButtonValue(card: Record<string, unknown>): Record<string, unknown> | null {
  return progressActionValues(card).find((value) => value.act === 'retry') ?? null;
}

function progressActionValues(card: Record<string, unknown>): Array<Record<string, unknown>> {
  return elementsOf(card)
    .flatMap((element) => element.columns?.flatMap((column) => column.elements) ?? [])
    .map((element) => element.value)
    .filter((value): value is Record<string, unknown> => value != null && value.kind === 'feishu_progress');
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
    expect(card.header).toBeUndefined();
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

  it('终态不带取消按钮（随卡片重写自动消失）', () => {
    expect(cancelButtonValue(buildFeishuProgressCard('COMPLETED', 1, '', [], cancelAction, 1000))).toBeNull();
    expect(cancelButtonValue(buildFeishuProgressCard('CANCELLED', 1, '', [], cancelAction, 1000))).toBeNull();
    expect(cancelButtonValue(buildFeishuProgressCard('FAILED', 1, '', [], { ...cancelAction, botId: 1 }, 1000))).toBeNull();
  });
});

describe('飞书进度卡片「重试」按钮', () => {
  const action = { sessionId: 7, sender: 'ou_sender', botId: 3 };

  it('失败卡带重试按钮，绑定会话与发送者', () => {
    const value = retryButtonValue(buildFeishuProgressCard('FAILED', 1, 'LLM API returned 500', [], action, 1000));
    expect(value).toEqual({ kind: 'feishu_progress', act: 'retry', sessionId: 7, sender: 'ou_sender' });
  });

  it('缺少 botId 或 sender 时不渲染重试按钮', () => {
    expect(retryButtonValue(buildFeishuProgressCard('FAILED', 1, 'err', [], { sessionId: 7, sender: 'ou_sender' }, 1000))).toBeNull();
    expect(retryButtonValue(buildFeishuProgressCard('FAILED', 1, 'err', [], { sessionId: 7, sender: '', botId: 3 }, 1000))).toBeNull();
  });

  it('成功/取消终态不带重试按钮', () => {
    expect(retryButtonValue(buildFeishuProgressCard('COMPLETED', 1, 'ok', [], action, 1000))).toBeNull();
    expect(retryButtonValue(buildFeishuProgressCard('CANCELLED', 1, 'stop', [], action, 1000))).toBeNull();
    expect(retryButtonValue(buildFeishuProgressCard('RUNNING', 1, '', [], action))).toBeNull();
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

describe('飞书进度卡片提问表单', () => {
  const cancelAction = { sessionId: 7, sender: 'ou_sender' };
  const singleAsk = {
    sessionId: 7,
    requestId: 'req-single',
    senderOpenId: 'ou_sender',
    questions: [{
      question: '选哪个？',
      header: '方案',
      multiSelect: false,
      options: [
        { label: '甲', description: '说明甲' },
        { label: '乙', description: '说明乙' },
      ],
    }],
  };
  const multiAsk = {
    sessionId: 7,
    requestId: 'req-multi',
    senderOpenId: 'ou_sender',
    questions: [{
      question: '要哪些？',
      header: '范围',
      multiSelect: true,
      options: [
        { label: 'A', description: '说明A' },
        { label: 'B', description: '说明B' },
      ],
    }],
  };

  function formsOf(card: Record<string, unknown>): CardElement[] {
    return elementsOf(card).filter((element) => element.tag === 'form');
  }

  it('执行中同时放一组单选和一组多选，提交在 form 内、取消在 form 外', () => {
    const card = buildFeishuProgressCard(
      'RUNNING', 2, '正文', ['ask_user_questions：向用户提问（执行中）', 'read_file：执行中…'], cancelAction, undefined, 'https://mao.example.com/tasks/7',
      [singleAsk, multiAsk],
    );
    expect(card.header).toEqual({ template: 'orange', title: { tag: 'plain_text', content: '等待你的回复' } });
    expect(statusLineOf(card)).toBe('**状态：等待你的回复** · 第 2 轮');
    expect(JSON.stringify(card)).toContain('下面有 2 道题');
    expect(JSON.stringify(card)).toContain('不用在卡片下面再发一条消息');
    expect(JSON.stringify(card)).not.toContain('ask_user_questions');
    expect(JSON.stringify(card)).toContain('read_file：执行中…');
    const forms = formsOf(card);
    expect(forms.map((form) => form.name)).toEqual(['ask_0', 'ask_1']);
    const tags = elementsOf(card).map((element) => element.tag);
    const toolIndex = elementsOf(card).findIndex((element) => element.content?.includes('本轮工具'));
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(toolIndex).toBeLessThan(tags.indexOf('form'));
    expect(tags.lastIndexOf('form')).toBeLessThan(tags.indexOf('column_set'));

    const singleSelect = forms[0].elements?.find((element) => element.tag === 'select_static');
    const multiSelect = forms[1].elements?.find((element) => element.tag === 'multi_select_static');
    expect(singleSelect?.required).toBeUndefined();
    expect(multiSelect?.required).toBeUndefined();
    expect(singleSelect?.options?.map((option) => option.value)).toEqual(['0', '1']);
    expect(singleSelect?.options?.map((option) => option.text?.content)).toEqual(['甲', '乙']);
    expect(JSON.stringify(singleSelect?.options)).not.toContain('说明甲');
    expect(forms[0].elements?.find((element) => element.tag === 'markdown')?.content).toContain('**方案**');
    expect(forms[0].elements?.find((element) => element.tag === 'markdown')?.content).toContain('选哪个？');
    expect(forms[0].elements?.find((element) => element.tag === 'markdown')?.content).toContain('甲：说明甲');
    const singleInput = forms[0].elements?.find((element) => element.tag === 'input');
    expect(singleInput?.required).toBeUndefined();
    expect(singleInput?.placeholder?.content).toBe('其他（可选）');
    expect(singleSelect?.name).toBe('q0_0');
    expect(singleInput?.name).toBe('c0_0');
    expect(multiSelect?.name).toBe('q1_0');
    expect(forms[1].elements?.find((element) => element.tag === 'input')?.name).toBe('c1_0');

    const names = forms.flatMap((form) => form.elements ?? [])
      .map((element) => element.name)
      .filter((name): name is string => name != null && name !== '');
    expect(new Set(names).size).toBe(names.length);

    const submit = forms[0].elements?.find((element) => element.tag === 'button');
    expect(submit?.text?.content).toBe('提交答案');
    expect(submit?.name).toBe('submit_0');
    expect(forms[1].elements?.find((element) => element.tag === 'button')?.name).toBe('submit_1');
    expect(submit?.form_action_type).toBe('submit');
    expect(submit?.value).toEqual({
      kind: 'feishu_ask', act: 'submit', sessionId: 7, requestId: 'req-single', sender: 'ou_sender',
    });
    expect(submit?.behaviors?.[0]?.value).toEqual(submit?.value);
    expect(forms[1].elements?.find((element) => element.tag === 'button')?.behaviors?.[0]?.value).toEqual(
      expect.objectContaining({ requestId: 'req-multi' }),
    );
    expect(forms.flatMap((form) => form.elements ?? []).some((element) => element.tag === 'button' && JSON.stringify(element).includes('feishu_progress'))).toBe(false);
    expect(cancelButtonValue(card)).toEqual({ kind: 'feishu_progress', act: 'cancel', sessionId: 7, sender: 'ou_sender' });
    expect(sessionDetailButtons(card)).toEqual([{ label: '会话详情', url: 'https://mao.example.com/tasks/7' }]);
  });

  it('完成、失败、取消都不渲染表单', () => {
    for (const status of ['COMPLETED', 'FAILED', 'CANCELLED'] as const) {
      const card = buildFeishuProgressCard(status, 1, '结束', [], cancelAction, 1000, undefined, [singleAsk, multiAsk]);
      expect(formsOf(card)).toEqual([]);
      expect(JSON.stringify(card)).not.toContain('req-single');
      expect(JSON.stringify(card)).not.toContain('req-multi');
    }
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
