import { describe, expect, it } from 'vitest';
import { userMessagePreviewOf } from './user-message-preview.js';

describe('userMessagePreviewOf', () => {
  it('returns plain text as-is', () => {
    expect(userMessagePreviewOf('帮我看下登录页')).toBe('帮我看下登录页');
  });

  it('joins text parts of a multimodal message and marks images', () => {
    const content = JSON.stringify([
      { type: 'text', text: '这张图有问题' },
      { type: 'image_url', image_url: { url: 'https://a/b.png' } },
    ]);
    expect(userMessagePreviewOf(content)).toBe('这张图有问题\n[图片]×1');
  });

  it('accepts an already-parsed parts array', () => {
    expect(userMessagePreviewOf([{ type: 'text', text: 'ok' }])).toBe('ok');
  });

  it('keeps bracket-leading plain text that is not valid JSON', () => {
    expect(userMessagePreviewOf('[系统提示：本消息由定时任务触发]')).toBe('[系统提示：本消息由定时任务触发]');
  });

  it('strips the scheduled-task trigger envelope and keeps the task body', () => {
    const wrapped = '[系统提示：本消息由定时任务「每日 GMV 汇总」按 cron 计划自动触发，当前时间 2026-09-25 09:00:32。\n请直接执行下面分隔线之后的任务内容本身；除非用户在任务内容中明确要求，不要创建、修改、暂停或删除任何定时任务，也不要重新调度自己。\n---\n汇总昨天的 GMV 并发给我';
    expect(userMessagePreviewOf(wrapped)).toBe('汇总昨天的 GMV 并发给我');
    // 也覆盖多模态（ContentPart JSON）落库形态。
    expect(userMessagePreviewOf(JSON.stringify([{ type: 'text', text: wrapped }]))).toBe('汇总昨天的 GMV 并发给我');
  });

  it('trims surrounding whitespace', () => {
    expect(userMessagePreviewOf('  帮我看看  \n')).toBe('帮我看看');
  });

  it('degrades to empty string for unsupported content', () => {
    expect(userMessagePreviewOf(null)).toBe('');
    expect(userMessagePreviewOf(undefined)).toBe('');
    expect(userMessagePreviewOf(42)).toBe('');
  });
});
