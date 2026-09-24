import type { FeishuPendingAsk } from './ask-form-store.js';

/** 只依赖应用内加急这一处，避免测试和调用方绑整份 Lark Client。 */
export interface FeishuUrgentAppClient {
  im: {
    v1: {
      message: {
        urgentApp: (payload: {
          data: { user_id_list: string[] };
          params: { user_id_type: 'open_id' };
          path: { message_id: string };
        }) => Promise<{
          code?: number;
          msg?: string;
          data?: { invalid_user_id_list?: string[] };
        }>;
      };
    };
  };
}

/**
 * 把指定消息应用内加急给一个用户。只通知 user_id_list 里的人，话题订阅者不会跟着收到。
 * 非 0 或目标无效时抛错，由调用方决定是否吞掉。
 */
export async function urgentFeishuAppMessage(
  client: FeishuUrgentAppClient,
  messageId: string,
  openId: string,
): Promise<void> {
  const response = await client.im.v1.message.urgentApp({
    path: { message_id: messageId },
    params: { user_id_type: 'open_id' },
    data: { user_id_list: [openId] },
  });
  if (Number(response.code ?? 0) !== 0) {
    throw new Error(`飞书应用内加急失败: code=${response.code ?? 'unknown'}, msg=${response.msg ?? 'no message'}`);
  }
  const invalid = response.data?.invalid_user_id_list ?? [];
  if (invalid.length > 0) {
    throw new Error(`飞书应用内加急目标无效: ${invalid.join(',')}`);
  }
}

/**
 * 同一轮提问只加急一次。进度卡上的待回答列表从空变成非空时触发；
 * 列表清空（提交、超时、终态）后复位，下一轮提问可以再加急。
 * 加急失败不在这里重试，避免每次进度刷新都打接口。
 */
export function createFeishuAskUrgentGate(urgent: (senderOpenId: string) => void): (asks: FeishuPendingAsk[]) => void {
  let sent = false;
  return (asks) => {
    if (asks.length === 0) {
      sent = false;
      return;
    }
    if (sent) return;
    const senderOpenId = asks[0]?.senderOpenId.trim() ?? '';
    if (senderOpenId === '') return;
    sent = true;
    urgent(senderOpenId);
  };
}
