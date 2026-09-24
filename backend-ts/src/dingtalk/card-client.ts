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
  if (target.chatType === 'group') {
    body.imGroupOpenSpaceModel = { supportForward: false };
  } else {
    body.imRobotOpenSpaceModel = { supportForward: false };
  }
  const response = await fetchImpl(CREATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(body),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`钉钉卡片投放失败: ${raw.slice(0, 300)}`);
  return outTrackId;
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
