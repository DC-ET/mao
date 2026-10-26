import { describe, expect, it } from 'vitest';
import { escapeHtml, renderEcpChannelCallbackPage } from './ecp-channel-callback-page.js';

describe('renderEcpChannelCallbackPage', () => {
  it('renders the success page with the bound account', () => {
    const html = renderEcpChannelCallbackPage({ kind: 'success', message: '杨佳毅' });
    expect(html).toContain('绑定成功');
    expect(html).toContain('账号：杨佳毅');
    expect(html).toContain('回到飞书');
    expect(html).not.toContain('绑定未完成');
    expect(html).toContain('<meta name="robots" content="noindex" />');
  });

  it('renders the failure page with an escaped upstream message', () => {
    const html = renderEcpChannelCallbackPage({ kind: 'failed', message: '<img src=x onerror=alert(1)>' });
    expect(html).toContain('绑定未完成');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('partial：绑定完成但消息未恢复，不得报「绑定成功」让用户干等，也不否定已生效的绑定', () => {
    const html = renderEcpChannelCallbackPage({
      kind: 'partial',
      message: '绑定链接已过期或被更新的链接替换，刚才那条消息未能恢复。请回到飞书重新发送一条消息。',
    });
    expect(html).toContain('绑定未完全成功');
    expect(html).not.toContain('>绑定成功<');
    // 不能出现成功态的承诺文案
    expect(html).not.toContain('会自动继续处理');
    // 失败态的「重新获取绑定卡片」引导也不适用：绑定已生效，只需重发消息
    expect(html).not.toContain('获取新的绑定卡片');
    expect(html).toContain('请回到飞书重新发送一条消息');
  });

  it('escapes html special characters', () => {
    expect(escapeHtml(`a&b"c'd<e>`)).toBe('a&amp;b&quot;c&#39;d&lt;e&gt;');
  });
});
