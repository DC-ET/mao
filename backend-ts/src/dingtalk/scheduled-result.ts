import { progressCardParams } from './card-body.js';
import { createAndDeliverCard } from './card-client.js';
import { sendDingtalkMarkdown, type DingtalkSendTarget } from './send.service.js';

/**
 * 把定时任务的最终回复发回钉钉会话。
 * 配了进度卡模板时投一张终态「处理完成」卡（不写入进度卡映射：那张表表示执行中的卡，
 * 写进去会让崩溃恢复把已完成的通知刷成「正在恢复」）。投放失败改发 markdown，
 * 避免模板未发布时用户完全看不到结果。没有模板时直接发 markdown，与实时会话的文本进度一致。
 */
export async function deliverScheduledDingtalkReply(input: {
  fetchImpl: typeof fetch;
  token: () => Promise<string>;
  target: DingtalkSendTarget;
  text: string;
  sessionId: number;
  templateId: string | null;
  sessionUrl?: string;
  senderUserid: string;
  replyMaxLength: number;
}): Promise<void> {
  if (input.templateId != null) {
    try {
      await createAndDeliverCard(input.fetchImpl, await input.token(), {
        chatType: input.target.chatType,
        senderUserid: input.senderUserid,
        conversationId: input.target.conversationId ?? '',
        templateId: input.templateId,
        robotCode: input.target.robotCode,
        cardParamMap: progressCardParams({
          status: 'completed',
          round: 0,
          detail: input.text,
          sessionUrl: input.sessionUrl,
          sessionId: input.sessionId,
          senderUserid: input.senderUserid,
        }),
      });
      return;
    } catch (error) {
      console.warn(`钉钉定时任务结果卡片投放失败，改发 markdown, sessionId=${input.sessionId}`, error);
    }
  }
  const sent = await sendDingtalkMarkdown(
    { token: input.token, fetchImpl: input.fetchImpl },
    input.target,
    input.text,
    input.replyMaxLength,
  );
  if (!sent.ok) throw new Error(sent.reason);
}
