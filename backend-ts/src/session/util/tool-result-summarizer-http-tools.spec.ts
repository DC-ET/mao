import { describe, expect, it } from 'vitest';
import { ToolResultSummarizer } from './tool-result-summarizer.js';

/**
 * 自定义 HTTP 工具结果摘要（AGENTS.md：新增内置工具须补成功/失败/缺参三态回归）。
 * http_call 外壳参数是 {tool, arguments}，结果带 displayName / status / body / error。
 */
describe('http_call / http_describe result summary', () => {
  const args = (tool: string, inner: Record<string, unknown> = {}) =>
    JSON.stringify({ tool, arguments: inner });

  it('http_call success shows the display name, HTTP status and argument digest', () => {
    const result = JSON.stringify({ status: 200, body: '{"temp":26}', truncated: false, displayName: '天气查询' });
    expect(ToolResultSummarizer.summarize('http_call', args('weather', { city: '上海' }), result))
      .toBe('调用 天气查询（HTTP 200） city=上海');
  });

  it('http_call falls back to the slug when displayName is absent', () => {
    const result = JSON.stringify({ status: 204, body: '', truncated: false });
    expect(ToolResultSummarizer.summarize('http_call', args('ping'), result))
      .toBe('调用 ping（HTTP 204）');
  });

  it('http_call marks truncated responses', () => {
    const result = JSON.stringify({ status: 200, body: 'x'.repeat(100), truncated: true, displayName: '天气查询' });
    expect(ToolResultSummarizer.summarize('http_call', args('weather'), result))
      .toBe('调用 天气查询（HTTP 200）（响应已截断）');
  });

  it('http_call failure shows the error and no status', () => {
    // 执行内核失败态也带回 displayName（失败同样显示中文名）
    const result = JSON.stringify({ error: '请求被拒绝：目标地址不在允许访问的网段内', displayName: '天气查询' });
    expect(ToolResultSummarizer.summarize('http_call', args('weather'), result))
      .toBe('调用 天气查询 (失败: 请求被拒绝：目标地址不在允许访问的网段内)');
  });

  it('http_call failure without displayName falls back to the slug', () => {
    // 解析层失败（工具不存在/未启用/解密失败）没有中文名可带，回落 slug
    const result = JSON.stringify({ error: '工具不存在或未启用：ghost' });
    expect(ToolResultSummarizer.summarize('http_call', args('ghost'), result))
      .toBe('调用 ghost (失败: 工具不存在或未启用：ghost)');
  });

  it('http_call missing-parameter errors stay readable', () => {
    const result = JSON.stringify({ error: '缺少必填参数 city（城市）', displayName: '天气查询' });
    expect(ToolResultSummarizer.summarize('http_call', args('weather', { unit: 'c' }), result))
      .toBe('调用 天气查询 (失败: 缺少必填参数 city（城市）)');
  });

  it('http_call keeps at most two argument pairs', () => {
    const result = JSON.stringify({ status: 200, body: '{}', truncated: false, displayName: '搜索' });
    expect(ToolResultSummarizer.summarize('http_call', args('search', { q: 'mao', page: 2, size: 20 }), result))
      .toBe('调用 搜索（HTTP 200） q=mao, page=2');
  });

  it('http_describe success counts the parameters', () => {
    const result = JSON.stringify({ name: 'weather', params: [{ name: 'city' }, { name: 'unit' }] });
    expect(ToolResultSummarizer.summarize('http_describe', args('weather'), result))
      .toBe('查询 weather 参数（2 个）');
  });

  it('http_describe failure shows the error', () => {
    const result = JSON.stringify({ error: '工具不存在或未启用：ghost' });
    expect(ToolResultSummarizer.summarize('http_describe', args('ghost'), result))
      .toBe('查询 ghost 参数 (失败: 工具不存在或未启用：ghost)');
  });

  it('malformed results degrade to plain labels without throwing', () => {
    expect(ToolResultSummarizer.summarize('http_call', args('weather'), 'not-json')).toBe('调用 weather');
    expect(ToolResultSummarizer.summarize('http_describe', args('weather'), null)).toBe('查询 weather 参数');
    expect(ToolResultSummarizer.summarize('http_call', null, null)).toBe('调用自定义工具');
    expect(ToolResultSummarizer.summarize('http_describe', null, null)).toBe('查询自定义工具参数');
  });
});
