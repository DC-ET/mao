import { describe, expect, it } from 'vitest';
import { createAndDeliverCard } from './card-client.js';

function stubFetch(response: { status: number; body: string }): typeof fetch {
  return (async () => ({ ok: response.status >= 200 && response.status < 300, status: response.status, text: async () => response.body })) as unknown as typeof fetch;
}

const BASE = {
  chatType: 'p2p' as const,
  senderUserid: '02610521142223',
  conversationId: '',
  templateId: 'df3e8e18-8cda-429e-89e1-b8d9f5f011f4.schema',
  cardParamMap: { title: '正在处理' },
};

describe('createAndDeliverCard', () => {
  it('私聊同时传场域模型与投放模型，二者缺一钉钉都不投放', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: { deliverResults: [{ success: true }] } }) };
    }) as unknown as typeof fetch;

    await createAndDeliverCard(fetchImpl, 'token', BASE);

    expect(sent.imRobotOpenSpaceModel).toEqual({ supportForward: false });
    expect(sent.imRobotOpenDeliverModel).toEqual({ spaceType: 'IM_ROBOT' });
    expect(sent.openSpaceId).toBe('dtv1.card//IM_ROBOT.02610521142223');
    const params = (sent.cardData as { cardParamMap: Record<string, string> }).cardParamMap;
    expect(JSON.parse(params.sys_full_json_obj ?? '')).toEqual({ config: { autoLayout: true } });
    expect(params.title).toBe('正在处理');
  });

  it('已有 sys_full_json_obj 时只补 config.autoLayout，不丢掉其它字段', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: { deliverResults: [{ success: true }] } }) };
    }) as unknown as typeof fetch;

    await createAndDeliverCard(fetchImpl, 'token', {
      ...BASE,
      cardParamMap: {
        title: '正在处理',
        sys_full_json_obj: JSON.stringify({ config: { enableForward: false }, extra: 1 }),
      },
    });

    const params = (sent.cardData as { cardParamMap: Record<string, string> }).cardParamMap;
    expect(JSON.parse(params.sys_full_json_obj ?? '')).toEqual({
      config: { enableForward: false, autoLayout: true },
      extra: 1,
    });
  });

  it('群聊投放带上机器人编码，否则钉钉报 chatbot not exist', async () => {
    let sent: Record<string, unknown> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200, text: async () => JSON.stringify({ result: { deliverResults: [{ success: true }] } }) };
    }) as unknown as typeof fetch;

    await createAndDeliverCard(fetchImpl, 'token', {
      ...BASE, chatType: 'group', conversationId: 'cidabc', robotCode: 'dingieqeqgcwexiigzhm',
    });

    expect(sent.imGroupOpenSpaceModel).toEqual({ supportForward: false });
    expect(sent.imGroupOpenDeliverModel).toEqual({ robotCode: 'dingieqeqgcwexiigzhm' });
    expect(sent.openSpaceId).toBe('dtv1.card//IM_GROUP.cidabc');
  });

  it('HTTP 200 但场域投放失败时抛错：静默放过会让用户看不到任何卡片', async () => {
    const fetchImpl = stubFetch({ status: 200, body: JSON.stringify({ result: { deliverResults: [{ success: false, errorMsg: 'chatbot not exist' }] } }) });

    await expect(createAndDeliverCard(fetchImpl, 'token', { ...BASE, chatType: 'group', robotCode: 'bad-code' }))
      .rejects.toThrow(/chatbot not exist/);
  });

  it('HTTP 非 2xx 直接抛错', async () => {
    const fetchImpl = stubFetch({ status: 400, body: '{"code":"param.templateUnpublished"}' });

    await expect(createAndDeliverCard(fetchImpl, 'token', BASE)).rejects.toThrow(/param.templateUnpublished/);
  });
});
