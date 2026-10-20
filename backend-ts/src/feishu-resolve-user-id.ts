import type { FeishuNormalizedMessage } from './feishu/types.js';
import type { MysqlFeishuBindingRepository } from './feishu/binding.repository.js';
import { senderUnionIdOf } from './feishu/ecp-inbound-gate.js';

export interface ResolveUserIdDeps {
  feishuBinding: MysqlFeishuBindingRepository;
}

export function createResolveUserIdHelper(deps: ResolveUserIdDeps) {
  const { feishuBinding } = deps;

  return async (_accountId: string, event: FeishuNormalizedMessage): Promise<number | null> => {
    const unionId = senderUnionIdOf(event);
    if (unionId == null) return null;
    return (await feishuBinding.findUserIdByUnionId(unionId)) ?? null;
  };
}
