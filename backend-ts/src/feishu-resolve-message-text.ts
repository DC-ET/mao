import * as Lark from '@larksuiteoapi/node-sdk';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';

export interface ResolveMessageTextDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
}

export function createResolveMessageTextHelper(deps: ResolveMessageTextDeps) {
  const { getFeishuClient } = deps;

  return async (accountId: string, messageId: string): Promise<string | null> => {
    const client = await getFeishuClient(Number(accountId));
    if (client == null) return null;
    const detail = await fetchFeishuMessageDetail(client, messageId);
    return detail?.text ?? null;
  };
}
