import type { FeishuNormalizedMessage } from './feishu/types.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import type { MysqlFeishuMessageRepository } from './feishu/message.repository.js';
import type { EcpAuthService } from './auth/ecp-auth.service.js';
import type { MysqlEcpSessionRepository } from './auth/ecp-session.repository.js';
import { senderName } from './feishu/message.service.js';
import { hasUsableEcpSession } from './auth/ecp-session.repository.js';
import { senderUnionIdOf } from './feishu/ecp-inbound-gate.js';

export interface AuthorizeSenderDeps {
  feishuBinding: MysqlFeishuBindingRepository;
  feishuMessageRepository: MysqlFeishuMessageRepository;
  ecpAuth: EcpAuthService;
  ecpSessionRepo: MysqlEcpSessionRepository;
}

export function createAuthorizeSenderHelper(deps: AuthorizeSenderDeps) {
  const { feishuBinding, feishuMessageRepository, ecpAuth, ecpSessionRepo } = deps;

  return async (accountId: string, event: FeishuNormalizedMessage): Promise<boolean> => {
    const unionId = senderUnionIdOf(event);
    if (unionId == null) return false;
    const userId = await feishuBinding.findUserIdByUnionId(unionId);
    if (userId == null) return false;
    if (await ecpAuth.isEnabled() && !(await hasUsableEcpSession(ecpSessionRepo, userId))) return false;
    if (event.chatType === 'group') {
      if (event.chatId == null) return false;
      await feishuMessageRepository.addGroupMember(String(accountId), event.chatId, userId, event.senderId!, senderName(event));
      return true;
    }
    return true;
  };
}
