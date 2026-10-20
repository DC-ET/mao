import type { FeishuInboundContext } from './feishu/types.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';

export interface FeishuUserIdDeps {
  feishuBinding: MysqlFeishuBindingRepository;
}

export function createFeishuUserIdHelper(deps: FeishuUserIdDeps) {
  const { feishuBinding } = deps;

  return async (accountId: string, context: FeishuInboundContext): Promise<number | undefined> => {
    const unionId = context.senderUnionId ?? context.senderId;
    if (unionId == null) return undefined;
    return (await feishuBinding.findUserIdByUnionId(unionId)) ?? undefined;
  };
}
