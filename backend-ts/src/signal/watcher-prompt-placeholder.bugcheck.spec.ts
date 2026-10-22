import { describe, expect, it } from 'vitest';
import { renderWatcherPrompt } from './watcher.logic.js';

/**
 * 存在性证明：模板渲染只能替换模板自身的占位符，不能改写被注入的 {diff} 内容。
 *
 * renderWatcherPrompt 先替换 {diff}、再替换 {url}/{name}，导致目标网页正文里
 * 原样出现的 `{url}` / `{name}` 被二次替换。用户看到的 diff 与真实响应不一致，
 * 恶意页面还可以借此把自己正文里的字面量替换成探针 URL。
 */
describe('renderWatcherPrompt 占位符单遍替换', () => {
  it('diff 内容里的 {url} 字面量必须保留', () => {
    const rendered = renderWatcherPrompt('地址：{url}\n变化：{diff}', {
      url: 'https://example.com/probe',
      name: '价格监控',
      diff: '页面正文写了 {url} 这个占位符',
    });
    expect(rendered).toContain('页面正文写了 {url} 这个占位符');
  });

  it('diff 内容里的 {name} 字面量必须保留', () => {
    const rendered = renderWatcherPrompt('名称：{name}\n变化：{diff}', {
      url: 'https://example.com/probe',
      name: '价格监控',
      diff: '标题是 {name}',
    });
    expect(rendered).toContain('标题是 {name}');
  });

  it('对照：模板自身的 {url}/{name}/{diff} 正常替换', () => {
    expect(renderWatcherPrompt('{name}@{url}: {diff}', {
      url: 'https://example.com', name: '监控', diff: 'ok',
    })).toBe('监控@https://example.com: ok');
  });
});
