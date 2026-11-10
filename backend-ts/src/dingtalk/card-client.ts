import { randomUUID } from 'node:crypto';
import type { DingtalkChatType } from './types.js';

const CREATE_URL = 'https://api.dingtalk.com/v1.0/card/instances/createAndDeliver';
const UPDATE_URL = 'https://api.dingtalk.com/v1.0/card/instances';

export interface DingtalkCardDeliverTarget {
  chatType: DingtalkChatType;
  senderUserid: string;
  conversationId: string;
  templateId: string;
  cardParamMap: Record<string, string>;
  /** 群聊投放必填：机器人编码。缺失时钉钉返回 `chatbot not exist`。 */
  robotCode?: string;
}

export async function createAndDeliverCard(
  fetchImpl: typeof fetch,
  token: string,
  target: DingtalkCardDeliverTarget,
  outTrackId = randomUUID().replace(/-/g, ''),
): Promise<string> {
  const openSpaceId = target.chatType === 'group'
    ? `dtv1.card//IM_GROUP.${target.conversationId}`
    : `dtv1.card//IM_ROBOT.${target.senderUserid}`;
  const body: Record<string, unknown> = {
    cardTemplateId: target.templateId,
    outTrackId,
    callbackType: 'STREAM',
    userIdType: 1,
    cardData: { cardParamMap: target.cardParamMap },
    openSpaceId,
  };
  // 场域模型（*OpenSpaceModel）与投放模型（*OpenDeliverModel）必须成对传：
  // 只传前者钉钉报 param.openDeliverModelError，只传后者报 "spaces of card is empty"，
  // 两者齐备才真正进入场域投放（deliverResults.success=true）。
  if (target.chatType === 'group') {
    body.imGroupOpenSpaceModel = { supportForward: false };
    body.imGroupOpenDeliverModel = { robotCode: target.robotCode };
  } else {
    body.imRobotOpenSpaceModel = { supportForward: false };
    body.imRobotOpenDeliverModel = { spaceType: 'IM_ROBOT' };
  }
  const response = await fetchImpl(CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`钉钉卡片投放失败: ${raw.slice(0, 300)}`);
  // HTTP 200 不代表投放成功：场域级失败只体现在 deliverResults 里，静默放过会让用户看不到任何卡片。
  const deliverError = deliverFailureOf(raw);
  if (deliverError != null) throw new Error(`钉钉卡片投放失败: ${deliverError}`);
  return outTrackId;
}

/** 从成功响应体里提取场域级投放失败原因；投放全部成功或响应异常时返回 null。 */
function deliverFailureOf(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw) as { result?: { deliverResults?: Array<{ success?: boolean; errorMsg?: string }> } };
    const failed = parsed.result?.deliverResults?.filter((item) => item.success === false);
    if (failed == null || failed.length === 0) return null;
    return failed.map((item) => item.errorMsg || '未知原因').join('; ');
  } catch {
    // 响应体不是预期 JSON：投放结果无从判断，不阻断既有行为。
    return null;
  }
}

export async function updateCard(
  fetchImpl: typeof fetch,
  token: string,
  outTrackId: string,
  cardParamMap: Record<string, string>,
): Promise<void> {
  const response = await fetchImpl(UPDATE_URL, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({
      outTrackId,
      cardData: { cardParamMap },
      cardUpdateOptions: { updateCardDataByKey: true },
    }),
  });
  if (!response.ok) {
    const raw = await response.text();
    throw new Error(`钉钉卡片更新失败: ${raw.slice(0, 300)}`);
  }
}
