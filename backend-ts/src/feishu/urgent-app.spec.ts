import { describe, expect, it, vi } from 'vitest';
import type { FeishuPendingAsk } from './ask-form-store.js';
import { createFeishuAskUrgentGate, urgentFeishuAppMessage, type FeishuUrgentAppClient } from './urgent-app.js';

function ask(requestId: string, senderOpenId = 'ou_sender'): FeishuPendingAsk {
  return { sessionId: 1, requestId, questions: [], senderOpenId };
}

function client(urgentApp: FeishuUrgentAppClient['im']['v1']['message']['urgentApp']): FeishuUrgentAppClient {
  return { im: { v1: { message: { urgentApp } } } };
}

describe('urgentFeishuAppMessage', () => {
  it('只把这条进度卡加急给原发送者', async () => {
    const urgentApp = vi.fn(async () => ({ code: 0, data: { invalid_user_id_list: [] } }));
    await urgentFeishuAppMessage(client(urgentApp), 'om_card', 'ou_sender');
    expect(urgentApp).toHaveBeenCalledWith({
      path: { message_id: 'om_card' },
      params: { user_id_type: 'open_id' },
      data: { user_id_list: ['ou_sender'] },
    });
  });

  it('接口失败或目标无效时抛错', async () => {
    const denied = vi.fn(async () => ({ code: 230052, msg: 'no permission' }));
    await expect(urgentFeishuAppMessage(client(denied), 'om_card', 'ou_sender')).rejects.toThrow('code=230052');
    const invalid = vi.fn(async () => ({ code: 0, data: { invalid_user_id_list: ['ou_sender'] } }));
    await expect(urgentFeishuAppMessage(client(invalid), 'om_card', 'ou_sender')).rejects.toThrow('目标无效');
  });
});

describe('createFeishuAskUrgentGate', () => {
  it('同一轮只加急一次，列表清空后下一轮再加急', () => {
    const urgent = vi.fn();
    const gate = createFeishuAskUrgentGate(urgent);
    gate([ask('req-1')]);
    gate([ask('req-1'), ask('req-2')]);
    expect(urgent).toHaveBeenCalledTimes(1);
    expect(urgent).toHaveBeenCalledWith('ou_sender');
    gate([]);
    gate([ask('req-3')]);
    expect(urgent).toHaveBeenCalledTimes(2);
  });

  it('没有发送者时不加急，之后出现发送者仍会加急', () => {
    const urgent = vi.fn();
    const gate = createFeishuAskUrgentGate(urgent);
    gate([ask('req-1', '   ')]);
    expect(urgent).not.toHaveBeenCalled();
    gate([ask('req-1')]);
    expect(urgent).toHaveBeenCalledOnce();
  });
});
