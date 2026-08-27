import { describe, expect, it, vi } from 'vitest';
import { fetchFeishuMessageDetail } from './message-detail.js';
import type * as Lark from '@larksuiteoapi/node-sdk';

function makeClient(items: unknown[]): Lark.Client {
  return { request: vi.fn(async () => ({ code: 0, data: { items } })) } as never;
}

async function fetchDetail(message: Record<string, unknown>) {
  return fetchFeishuMessageDetail(makeClient([{ message_id: 'om_card', ...message }]), 'om_card');
}

describe('fetchFeishuMessageDetail 卡片文本提取', () => {
  it('requests original card JSON to avoid Feishu client-upgrade fallback text', async () => {
    const client = makeClient([{ message_id: 'om_card', msg_type: 'interactive', body: { content: JSON.stringify({ elements: [{ tag: 'markdown', content: '真实卡片内容' }] }) } }]);
    await fetchFeishuMessageDetail(client, 'om_card');
    expect((client.request as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(expect.objectContaining({
      params: { card_msg_content_type: 'user_card_content' },
    }));
  });

  it('extracts text from schema 2.0 card (header.title + body.elements markdown)', async () => {
    const card = {
      schema: '2.0',
      config: { update_multi: true },
      header: { template: 'blue', title: { tag: 'plain_text', content: 'Mao Agent' } },
      body: {
        direction: 'vertical',
        elements: [
          { tag: 'markdown', content: '**状态：处理完成** · 第 2 轮' },
          { tag: 'markdown', content: '任务已完成，文件保存在 /tmp/a.zip' },
          { tag: 'img', img_key: 'img_v3_x' },
        ],
      },
    };
    const detail = await fetchDetail({ msg_type: 'interactive', body: { content: JSON.stringify(card) } });
    expect(detail?.msgType).toBe('interactive');
    expect(detail?.text).toContain('Mao Agent');
    expect(detail?.text).toContain('状态：处理完成');
    expect(detail?.text).toContain('文件保存在 /tmp/a.zip');
  });

  it('extracts text from classic card (div/lark_md, markdown, note)', async () => {
    const card = {
      config: { wide_screen_mode: true },
      header: { title: { tag: 'plain_text', content: '告警通知' } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: '服务 [api-gateway](https://example.com) 出现 5xx' } },
        { tag: 'markdown', content: '请及时处理' },
        { tag: 'hr' },
        { tag: 'note', elements: [{ tag: 'plain_text', content: '来自监控平台' }] },
      ],
    };
    const detail = await fetchDetail({ msg_type: 'interactive', body: { content: JSON.stringify(card) } });
    expect(detail?.text).toContain('告警通知');
    expect(detail?.text).toContain('服务 apigateway 出现 5xx');
    expect(detail?.text).toContain('请及时处理');
    expect(detail?.text).toContain('来自监控平台');
  });

  it('falls back to placeholder when card has no text elements', async () => {
    const card = { elements: [{ tag: 'img', img_key: 'img_v3_x' }, { tag: 'hr' }] };
    const detail = await fetchDetail({ msg_type: 'interactive', body: { content: JSON.stringify(card) } });
    expect(detail?.text).toBe('[卡片消息]');
  });
});
