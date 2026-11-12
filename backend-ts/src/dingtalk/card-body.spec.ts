import { describe, expect, it } from 'vitest';
import { cardCallbackResponse, formatDingtalkDuration, progressCardParams, queueCardParams } from './card-body.js';

describe('progressCardParams', () => {
  it('完成态拼出「状态行 + 正文 + 工具列表」，与飞书卡片同构', () => {
    const params = progressCardParams({
      status: 'completed', round: 3, elapsedMs: 44_000, detail: '凡是需要登录的网页操作都适合。',
      tools: ['shell：df -h', '读取 文件：/etc/os-release'], sessionId: 2319, senderUserid: '02610521142223',
    });

    expect(params.body).toBe(
      '**状态：处理完成** · 共 3 轮 · 耗时 44 秒\n\n'
      + '凡是需要登录的网页操作都适合。\n\n'
      + '**本轮工具**\n- shell：df -h\n- 读取 文件：/etc/os-release',
    );
    expect(params.title).toBe('处理完成');
    expect(params.status).toBe('completed');
  });

  it('执行中不带耗时，只带轮次', () => {
    const params = progressCardParams({
      status: 'running', round: 2, detail: '正在查磁盘。', sessionId: 1, senderUserid: 'u',
    });

    expect(params.body).toBe('**状态：正在处理** · 第 2 轮\n\n正在查磁盘。');
    expect(params.title).toBe('正在处理');
  });

  it('没有正文时只保留状态行，不留下空段', () => {
    const params = progressCardParams({ status: 'running', round: 0, sessionId: 1, senderUserid: 'u' });

    expect(params.body).toBe('**状态：正在处理**');
  });

  it('正文超过 6000 字时截断，与飞书进度卡正文上限一致', () => {
    const params = progressCardParams({
      status: 'completed', round: 1, detail: 'x'.repeat(8000), sessionId: 1, senderUserid: 'u',
    });

    expect(params.body.length).toBe(6000);
    expect(params.body.startsWith('**状态：处理完成** · 共 1 轮')).toBe(true);
  });

  it('标题与状态变量随终态切换，供模板控制按钮可见性', () => {
    const base = { round: 1, sessionId: 1, senderUserid: 'u' };
    expect(progressCardParams({ ...base, status: 'failed', detail: 'boom' }).status).toBe('failed');
    expect(progressCardParams({ ...base, status: 'cancelled' }).title).toBe('任务已取消');
  });

  // 按钮可见性回归：钉钉卡片平台只把「boolean 变量 + isTrue」渲染成可用条件，
  // 字符串 isEqual 比较导入后会被抹成空条件（@triple{'' , 'visible', 'gone'} 恒假），
  // 导致「取消任务」按钮在 running 态也不显示。
  it('按钮可见性走 canCancel/canRetry boolean 变量，与状态严格对应', () => {
    const base = { round: 1, sessionId: 1, senderUserid: 'u' };
    expect(progressCardParams({ ...base, status: 'running' })).toMatchObject({ canCancel: 'true', canRetry: 'false' });
    expect(progressCardParams({ ...base, status: 'failed', detail: 'boom' })).toMatchObject({ canCancel: 'false', canRetry: 'true' });
    expect(progressCardParams({ ...base, status: 'completed', detail: 'ok' })).toMatchObject({ canCancel: 'false', canRetry: 'false' });
    expect(progressCardParams({ ...base, status: 'cancelled' })).toMatchObject({ canCancel: 'false', canRetry: 'false' });
  });

  // 合并模板（V192）下三按钮可见性变量全部显式下发：进度卡永远不该显示插队按钮。
  it('canRun 恒为 false（合并模板要求三 boolean 全量下发）', () => {
    const base = { round: 1, sessionId: 1, senderUserid: 'u' };
    for (const status of ['running', 'failed', 'completed', 'cancelled'] as const) {
      expect(progressCardParams({ ...base, status })).toMatchObject({ canRun: 'false' });
    }
  });

  // 点踩 + 会话详情（批次 29 提案 5 同族补充）：仅完成态显示点踩，会话详情非排队态恒显示。
  it('canFeedback 仅完成态开启；dislikeText 随 disliked 翻转；canOpenSession 恒 true', () => {
    const base = { round: 1, sessionId: 1, senderUserid: 'u' };
    const completed = progressCardParams({ ...base, status: 'completed', detail: 'ok' });
    expect(completed).toMatchObject({ canFeedback: 'true', canOpenSession: 'true', dislikeText: '👎 不满意' });

    expect(progressCardParams({ ...base, status: 'running' })).toMatchObject({ canFeedback: 'false' });
    expect(progressCardParams({ ...base, status: 'failed' })).toMatchObject({ canFeedback: 'false' });

    const disliked = progressCardParams({ ...base, status: 'completed', disliked: true });
    expect(disliked.dislikeText).toBe('👎 已点踩 · 再点取消');
  });
});

describe('queueCardParams', () => {
  it('排队态拼 body（状态行 + 消息摘要），canRun 开、其余 boolean 关', () => {
    const params = queueCardParams({ status: 'queued', preview: '帮我看看磁盘', queueId: 12, senderUserid: 'u' });

    expect(params).toEqual({
      title: '排队中',
      body: '**状态：排队中**\n\n帮我看看磁盘',
      status: 'queued',
      queueId: '12',
      senderUserid: 'u',
      canRun: 'true',
      canCancel: 'false',
      canRetry: 'false',
      canFeedback: 'false',
      canOpenSession: 'false',
      dislikeText: '👎 不满意',
      sessionUrl: '',
    });
  });

  it('带 rankNo 时 body 含队列位次行', () => {
    const params = queueCardParams({ status: 'queued', preview: '摘要', queueId: 12, senderUserid: 'u', rankNo: 2 });
    expect(params.body).toBe('**状态：排队中**\n\n当前排在第 2 位\n\n摘要');
  });

  it('排队态下发会话详情/点踩的关闭值与占位文案（合并模板全量下发原则）', () => {
    const params = queueCardParams({ status: 'queued', preview: 'x', queueId: 1, senderUserid: 'u' });
    expect(params).toMatchObject({
      canFeedback: 'false', canOpenSession: 'false',
      dislikeText: '👎 不满意', sessionUrl: '',
    });
  });

  it('插队/取消终态：canRun 关、无位次行，摘要 80 字截断', () => {
    const started = queueCardParams({ status: 'started', preview: 'x'.repeat(100), queueId: 3, senderUserid: 'u' });
    expect(started.body).toBe(`**状态：已开始处理**\n\n${'x'.repeat(80)}`);
    expect(started).toMatchObject({ canRun: 'false', canCancel: 'false', canRetry: 'false' });

    const cancelled = queueCardParams({ status: 'cancelled', preview: 'y', queueId: 3, senderUserid: 'u', rankNo: 4 });
    expect(cancelled.body).toBe('**状态：已取消**\n\ny');
    expect(cancelled).toMatchObject({ canRun: 'false', canCancel: 'false', canRetry: 'false' });
  });
});

describe('cardCallbackResponse', () => {
  it('成功回包带 requestOk=true，失败回包只把 requestOk 置 false', () => {
    const ok = cardCallbackResponse({ status: 'cancelled', body: 'x' });
    expect(ok.cardUpdateOptions).toEqual({ updateCardDataByKey: true, updatePrivateDataByKey: false });
    expect((ok.cardData as { cardParamMap: Record<string, string> }).cardParamMap).toEqual({
      status: 'cancelled', body: 'x', requestOk: 'true',
    });

    const failed = cardCallbackResponse(null, '该任务已结束');
    expect(failed.cardUpdateOptions).toEqual({ updateCardDataByKey: true, updatePrivateDataByKey: true });
    expect((failed.cardData as { cardParamMap: Record<string, string> }).cardParamMap).toEqual({ requestOk: 'false' });
    expect(failed.userPrivateData).toEqual({ cardParamMap: { tips: '该任务已结束' } });
  });
});

describe('formatDingtalkDuration', () => {
  it('按整分整时省略零头', () => {
    expect(formatDingtalkDuration(44_000)).toBe('44 秒');
    expect(formatDingtalkDuration(120_000)).toBe('2 分');
    expect(formatDingtalkDuration(506_000)).toBe('8 分 26 秒');
    expect(formatDingtalkDuration(3_600_000)).toBe('1 小时');
    expect(formatDingtalkDuration(3_720_000)).toBe('1 小时 2 分');
  });
});
