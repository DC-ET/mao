import { describe, expect, it } from 'vitest';
import { deliverScheduledDingtalkReply } from './scheduled-result.js';

const TARGET = { chatType: 'p2p' as const, robotCode: 'robot-1', userId: 'staff-1' };

function okCard() {
  return { ok: true, status: 200, text: async () => JSON.stringify({ result: { deliverResults: [{ success: true }] } }) };
}

function okMarkdown() {
  return { ok: true, status: 200, text: async () => JSON.stringify({ processQueryKey: 'ok' }) };
}

describe('deliverScheduledDingtalkReply', () => {
  it('没有进度卡模板时发 markdown 到原私聊', async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      bodies.push(String(init?.body));
      return okMarkdown();
    }) as unknown as typeof fetch;
    await deliverScheduledDingtalkReply({
      fetchImpl,
      token: async () => 'token',
      target: TARGET,
      text: '日报已生成',
      sessionId: 11,
      templateId: null,
      senderUserid: 'staff-1',
      replyMaxLength: 2000,
    });
    expect(urls).toEqual(['https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend']);
    const body = JSON.parse(bodies[0] ?? '{}') as { userIds?: string[]; msgParam?: string };
    expect(body.userIds).toEqual(['staff-1']);
    expect(JSON.parse(body.msgParam ?? '{}').text).toContain('日报已生成');
  });

  it('配了模板时投一张处理完成卡，不发 markdown', async () => {
    const urls: string[] = [];
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return okCard();
    }) as unknown as typeof fetch;
    await deliverScheduledDingtalkReply({
      fetchImpl,
      token: async () => 'token',
      target: TARGET,
      text: '日报已生成',
      sessionId: 11,
      templateId: 'tpl.schema',
      sessionUrl: 'https://mao.example/tasks/11',
      senderUserid: 'staff-1',
      replyMaxLength: 2000,
    });
    expect(urls).toEqual(['https://api.dingtalk.com/v1.0/card/instances/createAndDeliver']);
    expect(sent.cardTemplateId).toBe('tpl.schema');
    expect(sent.openSpaceId).toBe('dtv1.card//IM_ROBOT.staff-1');
    const params = (sent.cardData as { cardParamMap: Record<string, string> }).cardParamMap;
    expect(params.status).toBe('completed');
    expect(params.canCancel).toBe('false');
    expect(params.canRetry).toBe('false');
    expect(params.body).toContain('处理完成');
    expect(params.body).toContain('日报已生成');
    expect(params.sessionUrl).toBe('https://mao.example/tasks/11');
  });

  it('卡片投放失败时改发 markdown', async () => {
    const urls: string[] = [];
    const bodies: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      urls.push(url);
      bodies.push(String(init?.body));
      if (url.includes('/card/')) {
        return { ok: false, status: 400, text: async () => 'template unpublished' };
      }
      return okMarkdown();
    }) as unknown as typeof fetch;
    await deliverScheduledDingtalkReply({
      fetchImpl,
      token: async () => 'token',
      target: { chatType: 'group', robotCode: 'robot-1', conversationId: 'cid-1' },
      text: '群日报',
      sessionId: 12,
      templateId: 'tpl.schema',
      senderUserid: '',
      replyMaxLength: 2000,
    });
    expect(urls[0]).toContain('/card/instances/createAndDeliver');
    expect(urls[1]).toBe('https://api.dingtalk.com/v1.0/robot/groupMessages/send');
    const body = JSON.parse(bodies[1] ?? '{}') as { openConversationId?: string; msgParam?: string };
    expect(body.openConversationId).toBe('cid-1');
    expect(JSON.parse(body.msgParam ?? '{}').text).toContain('群日报');
  });

  it('markdown 发送失败向外抛出', async () => {
    const fetchImpl = (async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: 'robot disabled' }) })) as unknown as typeof fetch;
    await expect(deliverScheduledDingtalkReply({
      fetchImpl,
      token: async () => 'token',
      target: TARGET,
      text: '日报',
      sessionId: 11,
      templateId: null,
      senderUserid: 'staff-1',
      replyMaxLength: 2000,
    })).rejects.toThrow(/robot disabled/);
  });
});
