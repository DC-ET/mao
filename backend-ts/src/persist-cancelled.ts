import { randomUUID } from 'node:crypto';
import type { SessionService } from './session/session.service.js';
import type { TaskTerminalService } from './session/task-terminal.service.js';
import type { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';

export interface PersistCancelledDeps {
  sessionService: SessionService;
  taskTerminal: TaskTerminalService;
  feishuProgressCardRepo: MysqlFeishuProgressCardRepository;
}

export function createPersistCancelledHelper(deps: PersistCancelledDeps) {
  const { sessionService, taskTerminal, feishuProgressCardRepo } = deps;

  /** 重启后内存无 cancel flag、DB 仍 RUNNING/RESUMING 时，把会话落成 CANCELLED（与桌面端停止同语义）。 */
  return async (sessionId: number): Promise<boolean> => {
    const session = await sessionService.getSession(sessionId).catch(() => null);
    if (session == null) return false;
    if (session.phase !== 'RUNNING' && session.phase !== 'RESUMING') return false;
    await sessionService.cleanupIncompleteTail(sessionId);
    await taskTerminal.finishExecution(sessionId, session.userId, 'CANCELLED', randomUUID());
    try { await feishuProgressCardRepo.deleteBySessionId(sessionId); } catch (error) {
      console.warn(`清理飞书进度卡片映射失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return true;
  };
}
