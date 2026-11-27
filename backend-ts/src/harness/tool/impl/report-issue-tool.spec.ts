import { describe, expect, it, vi } from 'vitest';
import { ReportIssueTool, type AgentReportSink } from './report-issue-tool.js';

function makeTool(sink?: Partial<AgentReportSink>) {
  const report = vi.fn(sink?.report ?? (async () => ({ ok: true as const, duplicate: false })));
  return { tool: new ReportIssueTool({ ...sink, report } as AgentReportSink), report };
}

describe('ReportIssueTool', () => {
  it('成功上报：返回 {received:true, duplicate:false} 并把会话上下文注入 sink', async () => {
    const { tool, report } = makeTool();
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ category: 'tool_defect', title: 'shell 循环失败', severity: 'high', detail: '复现路径…' }),
      11, 7, null, 3,
    ));
    expect(result).toEqual({ received: true, duplicate: false });
    expect(report).toHaveBeenCalledWith({
      sessionId: 11, userId: 7, agentId: 3,
      category: 'tool_defect', title: 'shell 循环失败', severity: 'high', detail: '复现路径…',
    });
  });

  it('去重命中：返回 duplicate=true', async () => {
    const { tool } = makeTool({ report: async () => ({ ok: true as const, duplicate: true }) });
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ category: 'other', title: '重复问题' }), 1, 1, null, null,
    ));
    expect(result).toEqual({ received: true, duplicate: true });
  });

  it('参数非法（service 判 category/title 等）：返回错误 JSON 让模型修正，不抛异常', async () => {
    const { tool } = makeTool({ report: async () => ({ ok: false as const, error: '无效的 category: xxx' }) });
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ category: 'xxx', title: 't' }), 1, 1, null, null,
    ));
    expect(result.error).toContain('无效的 category');
    expect(result.error_code).toBe('invalid_arguments');
    expect(result.received).toBeUndefined();
  });

  it('arguments 不是 JSON 对象：返回错误 JSON', async () => {
    const { tool, report } = makeTool();
    const result = JSON.parse(await tool.execute('not json', 1, 1, null, null));
    expect(result.error_code).toBe('invalid_arguments');
    expect(report).not.toHaveBeenCalled();
  });

  it('sink 抛异常：吞掉并返回错误 JSON（上报失败不炸用户任务）', async () => {
    const { tool } = makeTool({ report: async () => { throw new Error('db down'); } });
    const result = JSON.parse(await tool.execute(
      JSON.stringify({ category: 'self_bug', title: 't' }), 1, 1, null, null,
    ));
    expect(result.error).toBe('db down');
    expect(result.error_code).toBe('report_failed');
  });

  it('结果形状确定：无随机 id / 时间戳（no-progress 归一化无需登记）', async () => {
    const { tool } = makeTool();
    const args = JSON.stringify({ category: 'other', title: '同上' });
    const a = await tool.execute(args, 1, 1, null, null);
    const b = await tool.execute(args, 1, 1, null, null);
    expect(a).toBe(b);
    expect(Object.keys(JSON.parse(a)).sort()).toEqual(['duplicate', 'received']);
  });
});
