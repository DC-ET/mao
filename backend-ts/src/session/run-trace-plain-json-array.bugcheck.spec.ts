import { describe, expect, it } from 'vitest';
import { RunTraceService, type RunTraceQuery } from './run-trace.service.js';

/**
 * 存在性证明：运行轨迹的用户消息预览不能把普通 JSON 数组文本清空。
 *
 * previewOf 对任何以 `[` 开头的 content 都按多模态分片 JSON 解析并只拼 type=text 的分片；
 * 用户原样发送的 `["a","b"]` / `[1,2,3]` 没有任何分片，预览变成空串。
 * 轨迹列表里这一轮的「用户消息」列因此空白，无法定位是哪一轮。
 */
const QUERY: RunTraceQuery = {
  beforeRunId: null,
  limit: 10,
  slowMs: 30_000,
  expensiveCost: 0.5,
  expensiveCostMicros: 500_000,
};

function serviceFor(content: string): RunTraceService {
  const userMessage = {
    id: 10,
    sessionId: 1,
    role: 'USER',
    content,
    createdAt: '2026-10-21 10:00:00',
    updatedAt: '2026-10-21 10:00:00',
  };
  const messageRepo = {
    selectUserStarts: async () => [userMessage],
    selectUserStamps: async () => [{ id: 10, createdAt: userMessage.createdAt, updatedAt: userMessage.updatedAt }],
    selectRange: async () => [userMessage],
  };
  const llmCallRepo = { selectBySessionWindow: async () => [] };
  const activityRepo = { selectBySessionAll: async () => [] };
  const compactionEventRepo = { selectBySessionId: async () => [] };
  return new RunTraceService(
    messageRepo as never,
    llmCallRepo as never,
    activityRepo as never,
    compactionEventRepo as never,
  );
}

describe('RunTraceService 用户消息预览', () => {
  it('字符串数组文本按原文展示', async () => {
    const page = await serviceFor('["第一轮","第二轮"]').buildTrace(1, QUERY);
    expect(page.runs[0]?.userMessagePreview).toBe('["第一轮","第二轮"]');
  });

  it('数字数组文本按原文展示', async () => {
    const page = await serviceFor('[1,2,3]').buildTrace(1, QUERY);
    expect(page.runs[0]?.userMessagePreview).toBe('[1,2,3]');
  });

  it('对照：真正的多模态数组抽取文本分片', async () => {
    const page = await serviceFor(JSON.stringify([
      { type: 'text', text: '这张图是什么' },
      { type: 'image_url', image_url: { url: 'https://example.com/a.png' } },
    ])).buildTrace(1, QUERY);
    expect(page.runs[0]?.userMessagePreview).toBe('这张图是什么');
  });
});
