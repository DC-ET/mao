import type { FeishuNormalizedMessage, FeishuInboundContext } from './feishu/types.js';
import type { FeishuMessageService } from './feishu/message.service.js';

export interface ThreadSessionDeps {
  feishuMessageService: FeishuMessageService;
}

export function createThreadSessionHelper(deps: ThreadSessionDeps) {
  const { feishuMessageService } = deps;

  return {
    resolveThreadSession: async (accountId: string, event: FeishuNormalizedMessage): Promise<{ sessionId: number } | null> => {
      const result = await feishuMessageService.findThreadSession(String(accountId), event.threadId);
      return result == null ? null : { sessionId: result.sessionId };
    },
    ensureThreadSession: async (accountId: string, context: FeishuInboundContext): Promise<{ sessionId: number } | null> => {
      const result = await feishuMessageService.getOrCreateThreadSession(String(accountId), context);
      return result == null ? null : { sessionId: result.sessionId };
    },
  };
}
