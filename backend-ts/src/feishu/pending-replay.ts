import type { FeishuNormalizedMessage } from './types.js';
import type { FeishuPendingBindingMessage } from './pending-binding.repository.js';

/** 补投只依赖入站处理器的 process()，窄接口便于单测与解耦。 */
export interface FeishuPendingReplayProcessor {
  process(
    accountId: string,
    event: FeishuNormalizedMessage,
    skipClaim: boolean,
    options?: { bypassWindow?: boolean },
  ): Promise<void>;
}

/**
 * 绑定成功后补投原始消息的统一入口：ECP 绑定完成、飞书 OAuth 绑定完成、启动恢复扫描三处共用。
 * 必须绕开合并窗口——用户等的是这条消息的即时响应，不能被窗口期拖延，
 * 也不能与绑定成功后同一发送者的追问合并成一次触发（进度卡归属的是这条原始消息）。
 */
export async function replayFeishuPendingMessage(
  processor: FeishuPendingReplayProcessor,
  pending: FeishuPendingBindingMessage,
): Promise<void> {
  await processor.process(
    String(pending.appId),
    { ...pending.event, progressCardMessageId: pending.cardMessageId },
    true,
    { bypassWindow: true },
  );
}
