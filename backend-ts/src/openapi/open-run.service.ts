import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Message, Session } from '../domain/types.js';
import type { TaskNotifySource } from '../session/task-terminal.service.js';
import { withSessionLock } from '../schedule/scheduled-task.service.js';
import { isActivePhase } from '../session/session-vo.js';
import type { MessageQueueSource } from '../session/types.js';

/** 开放触发支持的消息长度上限（技术方案 §5.3）。 */
export const OPEN_RUN_MESSAGE_MAX_LENGTH = 32000;

/** 与 ScheduledTaskService.executeTask 同构的精简执行依赖（决策 2：不重构 schedule 域）。 */
export interface OpenRunDeps {
  sessionService: {
    getSession(id: number): Promise<Session | null>;
    updatePhase(sessionId: number, phase: string): Promise<void>;
    saveMessage(sessionId: number, role: string, content: unknown, a: null, b: null, c: null, d: number, e: null): Promise<Message>;
    createSession(userId: number, agentId: number, title: string | null | undefined, executionMode: string | null | undefined): Promise<Session>;
  };
  messageQueueService: {
    enqueue(sessionId: number, userId: number, content: string, images: string | null, scheduledTaskId?: number | null, source?: MessageQueueSource | null, openTriggerId?: number | null): Promise<unknown>;
  };
  harnessService: {
    executeFromEvent(sessionId: number, executionId: string, listener: unknown): Promise<void>;
  };
  taskTerminalService: {
    finishExecution(sessionId: number, userId: number, phase: string, executionId: string, reason?: string, notifySource?: TaskNotifySource): Promise<void>;
  };
  agentLookup: {
    findById(id: number): Promise<{ id?: number; name?: string | null; enabled?: number | null } | null>;
  };
  /** WS handler 在途执行判定（hasExecutionClaim），与 schedule 域同源注入。 */
  isSessionBusy: (sessionId: number) => boolean;
  /** 注入的 live WS 执行路径（createScheduledLiveExecution）；null 时走 no-op listener 兜底。 */
  liveExecution: ((session: Session, userId: number, executionId: string, savedMessage: Message, startedAt?: number, scheduledTaskId?: number | null, source?: 'SCHEDULED' | 'WEBHOOK' | 'API' | null) => Promise<void>) | null;
}

export interface OpenRunInput {
  userId: number;
  agentId: number;
  message: string;
  /** 给定则复用该会话（归属/主会话/云端校验），否则每次新建会话。 */
  sessionId?: number | null;
  source: Extract<TaskNotifySource, 'API' | 'WEBHOOK'>;
  /** WEBHOOK 来源时的触发器绑定（busy 入队后由消费侧回写失败计数）。 */
  triggerId?: number | null;
}

export interface OpenRunResult {
  sessionId: number;
  messageId: number | null;
  queued: boolean;
  /**
   * 直跑路径的真实终态（回读会话 phase；FAILED/CANCELLED 不得标 COMPLETED）。
   * queued=true 时为占位值——该执行尚未发生，真实终态由队列消费侧回写，此处无人消费。
   */
  terminalPhase: 'COMPLETED' | 'FAILED' | 'CANCELLED';
}

function noopListener(): Record<string, () => void> {
  return { onContentDelta() {}, onToolCallStart() {}, onToolCallResult() {}, onMessageEnd() {}, onError() {} };
}

/**
 * 开放接口统一触发执行流：API Token（P1）与入站 Webhook 触发器（P2）共用。
 * 与 ScheduledTaskService.executeTask 精简同构——无 cron 档期推进/在飞守卫/IM 回流，
 * 会话锁复用 schedule 域导出的 withSessionLock（决策 16）。
 */
export class OpenRunService {
  constructor(private readonly deps: OpenRunDeps) {}

  async run(input: OpenRunInput): Promise<OpenRunResult> {
    const message = input.message ?? '';
    const trimmed = message.trim();
    if (trimmed.length === 0 || message.length > OPEN_RUN_MESSAGE_MAX_LENGTH) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, `message 需为 1~${OPEN_RUN_MESSAGE_MAX_LENGTH} 字`);
    }
    const agent = await this.deps.agentLookup.findById(input.agentId);
    if (agent == null || agent.id == null) {
      throw new BusinessException(ErrorCode.AGENT_NOT_FOUND);
    }
    if (agent.enabled === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该 Agent 已停用，无法触发');
    }

    let session: Session;
    if (input.sessionId != null) {
      const loaded = await this.deps.sessionService.getSession(input.sessionId);
      // 归属不匹配与不存在统一按不存在处理：不向机器身份泄露会话存在性
      if (loaded == null || loaded.userId !== input.userId) {
        throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      }
      if (loaded.sessionType === 'SUBAGENT' || loaded.sessionType === 'SIDE_TASK') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '开放触发仅支持主会话');
      }
      if (loaded.executionMode === 'LOCAL') {
        // 决策 13：LOCAL 依赖桌面在线，机器触发场景失败只会累积触发器自动停用计数
        throw new BusinessException(ErrorCode.PARAM_INVALID, '开放触发仅支持云端执行会话');
      }
      session = loaded;
    } else {
      // 显式 CLOUD（不依赖 createSession 默认值）；权限档位/工作区留空走默认
      session = await this.deps.sessionService.createSession(input.userId, agent.id, null, 'CLOUD');
    }
    const sessionId = session.id;
    if (sessionId == null) {
      throw new BusinessException(ErrorCode.INTERNAL_ERROR, '会话创建失败');
    }

    return withSessionLock(sessionId, async () => {
      // 锁内重读：排队期间会话可能被并发改相位/删除
      const latest = await this.deps.sessionService.getSession(sessionId);
      if (latest == null) {
        throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
      }
      const busy = this.deps.isSessionBusy(sessionId) || isActivePhase(latest.phase);
      if (busy) {
        // 忙则排队：落 source_type + open_trigger_id 两列（类比 scheduledTaskId 回写绑定）
        await this.deps.messageQueueService.enqueue(sessionId, input.userId, message, null, null, input.source, input.triggerId ?? null);
        return { sessionId, messageId: null, queued: true, terminalPhase: 'COMPLETED' as const };
      }

      const executionId = randomUUID();
      const startedAt = Date.now();
      await this.deps.sessionService.updatePhase(sessionId, 'RUNNING');
      let savedMessage: Message;
      try {
        savedMessage = await this.deps.sessionService.saveMessage(sessionId, 'USER', message, null, null, null, 0, null);
      } catch (e) {
        await this.deps.sessionService.updatePhase(sessionId, 'IDLE').catch(() => undefined);
        throw e;
      }

      let terminalPhase: 'COMPLETED' | 'FAILED' | 'CANCELLED';
      if (this.deps.liveExecution != null) {
        // liveExecution（runExecution）内部吞掉失败/取消并落终态后正常返回，
        // 必须回读会话真实终态（照抄 executeTask 的回读逻辑）
        await this.deps.liveExecution(session, input.userId, executionId, savedMessage, startedAt, null, input.source);
        const after = await this.deps.sessionService.getSession(sessionId);
        const actual = after?.phase;
        terminalPhase = actual === 'FAILED' || actual === 'CANCELLED' ? actual : 'COMPLETED';
      } else {
        // 兜底路径（测试/装配缺失）：显式落 COMPLETED 终态并带来源
        await this.deps.harnessService.executeFromEvent(sessionId, executionId, noopListener());
        await this.deps.taskTerminalService.finishExecution(sessionId, input.userId, 'COMPLETED', executionId, undefined, input.source);
        terminalPhase = 'COMPLETED';
      }
      return { sessionId, messageId: savedMessage.id ?? null, queued: false, terminalPhase };
    });
  }
}
