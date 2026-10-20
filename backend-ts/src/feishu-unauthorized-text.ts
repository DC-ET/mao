import type { FeishuNormalizedMessage } from './feishu/types.js';
import type { EcpAuthService } from './auth/ecp-auth.service.js';
import { feishuUnauthorizedFallbackText, feishuUnauthorizedGuide } from './feishu/ecp-inbound-gate.js';

export interface UnauthorizedTextDeps {
  ecpAuth: EcpAuthService;
}

export function createUnauthorizedTextHelper(deps: UnauthorizedTextDeps) {
  const { ecpAuth } = deps;

  return async (_accountId: string, event: FeishuNormalizedMessage): Promise<string> => {
    const ecpEnabled = await ecpAuth.isEnabled();
    return feishuUnauthorizedFallbackText(feishuUnauthorizedGuide(ecpEnabled, event.chatType));
  };
}
