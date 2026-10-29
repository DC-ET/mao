import { describe, expect, it } from 'vitest';
import { ToolResultSummarizer } from './tool-result-summarizer.js';

/**
 * dump_user_messages 结果摘要（AGENTS.md：新增内置工具须补成功/失败/缺参三态回归）。
 * 成功态按「实际写出的文件数」摘要，失败条目不冒充成功。
 */
describe('dump_user_messages result summary', () => {
  const args = (recentCount?: number) => JSON.stringify(recentCount == null ? {} : { recentCount });

  it('success counts the files actually written', () => {
    const result = JSON.stringify({
      files: [
        { messageId: 42, path: '/runtime/7/9/userMessages/user-message-42.txt', bytes: 120 },
        { messageId: 43, path: '/runtime/7/9/userMessages/user-message-43.txt', bytes: 98 },
      ],
      count: 2,
      message: '已导出 2 条用户消息为文件。',
    });
    expect(ToolResultSummarizer.summarize('dump_user_messages', args(2), result)).toBe('导出 2 条用户消息为文件');
  });

  it('partial failure does not count the failed entries as success', () => {
    const result = JSON.stringify({
      files: [
        { messageId: 11, error: 'Local client is not connected.' },
        { messageId: 12, path: '/home/u/.mao/attachments/host/9/user-message-12.txt', bytes: 5 },
      ],
      count: 2,
      message: '已导出 1 条用户消息为文件。其中 1 条写入失败。',
    });
    expect(ToolResultSummarizer.summarize('dump_user_messages', args(2), result)).toBe('导出 1 条用户消息为文件（1 条失败）');
  });

  it('failure shows the error and missing parameters degrade to a label', () => {
    expect(ToolResultSummarizer.summarize('dump_user_messages', args(1), JSON.stringify({ error: '本会话暂无用户消息' })))
      .toBe('导出用户消息 (失败: 本会话暂无用户消息)');
    expect(ToolResultSummarizer.summarize('dump_user_messages', args(1), null)).toBe('导出用户消息 (最近 1 条)');
    expect(ToolResultSummarizer.summarize('dump_user_messages', null, 'not-json')).toBe('导出用户消息');
    expect(ToolResultSummarizer.summarize('dump_user_messages', args(3), JSON.stringify({ files: [], count: 0 })))
      .toBe('导出用户消息 (最近 3 条)');
  });
});
