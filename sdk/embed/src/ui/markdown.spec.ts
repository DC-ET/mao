import { describe, expect, it } from 'vitest';
import { hardenExternalLinks, renderMarkdown } from './markdown';

/**
 * 只覆盖本模块自己的行为（链接改写、空值、marked 选项）。
 * 注意：DOMPurify 在 happy-dom 下会丢弃部分块级标签（p/pre/table），属环境差异，
 * 真实浏览器渲染与 XSS 防护已在 Chromium 中验证，这里不断言消毒结果。
 */
describe('renderMarkdown', () => {
  it('外链自动加 target=_blank 与 rel=noopener', () => {
    const html = renderMarkdown('[Mao](https://mao.example.com)');
    expect(html).toContain('href="https://mao.example.com"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('锚点链接留在当前页', () => {
    const html = renderMarkdown('[锚点](#section)');
    expect(html).toContain('href="#section"');
    expect(html).not.toContain('target="_blank"');
  });

  it('空内容返回空串', () => {
    expect(renderMarkdown('')).toBe('');
  });

  it('breaks 选项生效：单换行渲染为 <br>', () => {
    expect(renderMarkdown('第一行\n第二行')).toContain('<br>');
  });

  it('hardenExternalLinks 只改写非锚点链接', () => {
    const root = document.createElement('div');
    root.innerHTML = '<a href="https://a.com">a</a><a href="#b">b</a><a>c</a>';
    hardenExternalLinks(root);
    const links = [...root.querySelectorAll('a')];
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[1].getAttribute('target')).toBeNull();
    expect(links[2].getAttribute('target')).toBeNull();
  });

  it('strips markdown images with invented attachment:// urls', () => {
    const html = renderMarkdown('当前页面截图如下：\n\n![当前页面截图](attachment://page-screenshot.png)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('attachment://');
    expect(html).toContain('当前页面截图如下');
  });
});
