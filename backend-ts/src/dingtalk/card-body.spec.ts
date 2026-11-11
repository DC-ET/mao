import { describe, expect, it } from 'vitest';
import { formatDingtalkDuration, progressCardParams, queueCardParams } from './card-body.js';

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

  it('正文超长时截断，避免钉钉 markdown 组件丢内容', () => {
    const params = progressCardParams({
      status: 'completed', round: 1, detail: 'x'.repeat(4000), sessionId: 1, senderUserid: 'u',
    });

    expect(params.body.length).toBeLessThanOrEqual(1500);
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
});

describe('queueCardParams', () => {
  it('排队卡带预览与队列号', () => {
    const params = queueCardParams({ status: 'queued', preview: '帮我看看', queueId: 12, senderUserid: 'u' });

    expect(params).toEqual({ title: '排队中', preview: '帮我看看', status: 'queued', queueId: '12', senderUserid: 'u' });
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
