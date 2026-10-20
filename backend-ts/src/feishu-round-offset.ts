import { countCompletedAgentRounds } from './feishu/card-progress-listener.js';
import type { SessionService } from './session/session.service.js';

export interface FeishuRoundOffsetDeps {
  sessionService: SessionService;
}

export function createFeishuRoundOffsetHelper(deps: FeishuRoundOffsetDeps) {
  const { sessionService } = deps;

  return async (sessionId: number): Promise<number> => {
    try {
      return countCompletedAgentRounds(await sessionService.getMessages(sessionId));
    } catch {
      return 0;
    }
  };
}
