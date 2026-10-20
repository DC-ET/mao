import * as Lark from '@larksuiteoapi/node-sdk';
import type { FeishuNormalizedMessage } from './feishu/types.js';
import type { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import { buildQuotedInjection } from './feishu/quoted-injection.js';
import { resolveFeishuQuotedText } from './feishu/merge-forward.js';
import { fetchFeishuMessageDetail } from './feishu/message-detail.js';
import { formatGroupTime } from './feishu/message.service.js';

export interface ResolveQuotedMessageDeps {
  getFeishuClient: (botId: number) => Promise<Lark.Client | null>;
  feishuMessageRepository: MysqlFeishuMessageRepository;
  resolveQuotedWorkspace: (accountId: string, event: FeishuNormalizedMessage) => Promise<string | null>;
  expandMergeForward: (accountId: string, messageId: string, workspace: string | null) => Promise<string | null>;
}

export function createResolveQuotedMessageHelper(deps: ResolveQuotedMessageDeps) {
  const { getFeishuClient, feishuMessageRepository, resolveQuotedWorkspace, expandMergeForward } = deps;

  return async (accountId: string, event: FeishuNormalizedMessage): Promise<string | null> => {
    if (event.parentId == null) return null;
    const persist = async (raw: string): Promise<string> => {
      return buildQuotedInjection(raw, { parentMessageId: event.parentId!, workspace: await resolveQuotedWorkspace(accountId, event) });
    };
    const fromLog = event.chatId != null
      ? await feishuMessageRepository.findGroupMessageByMessageId(String(accountId), event.chatId, event.parentId)
      : null;
    return resolveFeishuQuotedText({
      log: fromLog == null ? null : {
        msgType: fromLog.msgType,
        content: fromLog.content,
        line: `[${formatGroupTime(fromLog.createdAt)}] ${fromLog.senderName}：${fromLog.content ?? ''}`,
      },
      fetchDetail: async () => {
        const client = await getFeishuClient(Number(accountId));
        if (client == null) return null;
        const detail = await fetchFeishuMessageDetail(client, event.parentId!);
        return detail == null ? null : { msgType: detail.msgType, text: detail.text };
      },
      expand: (workspace) => expandMergeForward(accountId, event.parentId!, workspace),
      resolveWorkspace: () => resolveQuotedWorkspace(accountId, event),
      persist,
    });
  };
}
