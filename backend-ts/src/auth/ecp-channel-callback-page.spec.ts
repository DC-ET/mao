import { describe, expect, it } from 'vitest';
import { escapeHtml, renderEcpChannelCallbackPage } from './ecp-channel-callback-page.js';

describe('renderEcpChannelCallbackPage', () => {
  it('renders the success page with the bound account', () => {
    const html = renderEcpChannelCallbackPage({ ok: true, message: '杨佳毅' });
    expect(html).toContain('绑定成功');
    expect(html).toContain('账号：杨佳毅');
    expect(html).toContain('回到飞书');
    expect(html).not.toContain('绑定未完成');
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('renders the failure page with an escaped upstream message', () => {
    const html = renderEcpChannelCallbackPage({ ok: false, message: '<img src=x onerror=alert(1)>' });
    expect(html).toContain('绑定未完成');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('escapes html special characters', () => {
    expect(escapeHtml(`a&b"c'd<e>`)).toBe('a&amp;b&quot;c&#39;d&lt;e&gt;');
  });
});
