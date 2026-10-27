/* eslint-disable @typescript-eslint/no-explicit-any */
import type { AppConfig } from './config/app-config.js';
import type { JwtService } from './crypto/jwt.service.js';
import type { SessionService } from './session/session.service.js';
import type { MessageQueueService } from './session/message-queue.service.js';
import type { TaskTerminalService } from './session/task-terminal.service.js';
import type { ActivityService } from './session/activity.service.js';
import type { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import type { SessionTodoMapper } from './harness/todo/session-todo.mapper.js';
import type { ScheduledTaskService } from './schedule/scheduled-task.service.js';
import type { BudgetService, BudgetBlock } from './budget/budget.service.js';
import type { ApprovalRuleService } from './approval-rule/approval-rule.service.js';
import type { StreamingWsRegistry } from './session/ws/streaming-ws-registry.js';
import type { EmbedPageToolRegistry } from './harness/embed-page-tool-registry.js';
import type { LocalToolSessionRegistry } from './harness/local/local-tool-session-registry.js';
import type { AskUserQuestionsRegistry } from './harness/tool/ask-user-questions-registry.js';
import type { SessionTreeSignalPublisher } from './harness/approval/session-tree-signal-publisher.js';
import type { ApprovalRegistry } from './harness/approval/approval-registry.js';
import type { BackgroundSubagentManager } from './harness/delegate/background-subagent-manager.js';
import type { ShellSessionManager } from './harness/shell/shell-session-manager.js';
import type { SkillSyncService } from './harness/skill/skill-sync-service.js';
import type { LocalSkillRegistry } from './harness/skill/local-skill-registry.js';
import type { LocalAgentsMdRegistry } from './harness/core/local-agents-md-registry.js';
import type { McpSyncService } from './harness/mcp/local/mcp-sync-service.js';
import type { McpClientManager } from './harness/mcp/mcp-client-manager.js';
import type { MysqlAgentRepository } from './agent/agent.repository.js';
import type { MysqlLlmModelRepository } from './model/model.repository.js';
import type { MysqlUserRepository } from './user/user.repository.js';
import type { SessionTitleService } from './session/session-title.service.js';
import type { HarnessService } from './harness/core/harness-service.js';
import type { AgentLoop } from './harness/core/agent-loop.js';
import type { CompactionSignalBus } from './harness/core/compaction-signal-bus.js';
import type { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';
import { createAgentExecutor } from './harness/core/agent-executor.js';

import { StreamingWsHandler, createScheduledLiveExecution, budgetBlockMessage } from './session/ws/streaming-ws-handler.js';

export interface WsHandlerDeps {
  cfg: AppConfig;
  jwt: JwtService;
  wsRegistry: StreamingWsRegistry;
  sessionTitleService: SessionTitleService;
  harnessService: HarnessService;
  agentLoop: AgentLoop;
  compactionSignalBus: CompactionSignalBus;
  sessionService: SessionService;
  taskTerminal: TaskTerminalService;
  messageQueueService: MessageQueueService;
  embedPageToolRegistry: EmbedPageToolRegistry;
  localToolSessions: LocalToolSessionRegistry;
  askUserQuestionsRegistry: AskUserQuestionsRegistry;
  treeSignalPublisher: SessionTreeSignalPublisher;
  approvalRegistry: ApprovalRegistry;
  approvalRuleService: ApprovalRuleService;
  /** 用户对本地审批表态后抑制升级提醒。未注入时不外推。 */
  approvalEscalationSuppressor?: {
    suppressByRequest(sessionId: number, requestId: string): Promise<void>;
  } | null;
  activityService: ActivityService;
  activityHeartbeat: SessionActivityHeartbeat;
  todoMapper: SessionTodoMapper;
  backgroundSubagentManager: BackgroundSubagentManager;
  shellManager: ShellSessionManager;
  skillSync: SkillSyncService;
  localSkills: LocalSkillRegistry;
  localAgentsMd: LocalAgentsMdRegistry;
  mcpSync: McpSyncService;
  routingMcpClient: McpClientManager;
  agentRepo: MysqlAgentRepository;
  modelRepo: MysqlLlmModelRepository;
  userRepo: MysqlUserRepository;
  agentExecutor: ReturnType<typeof createAgentExecutor>;
  budgetService: BudgetService;
  scheduledService: ScheduledTaskService;
  openTriggerSettle: { current: ((triggerId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>) | null };
  openCallSettle: { current: ((callLogId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', queueWaitMs: number | null, messageId: number | null) => Promise<void>) | null };
}

export function assembleWsHandler(deps: WsHandlerDeps): StreamingWsHandler {
  const {
    cfg, jwt, wsRegistry, sessionTitleService, harnessService, agentLoop, compactionSignalBus, sessionService, taskTerminal,
    messageQueueService, embedPageToolRegistry, localToolSessions, askUserQuestionsRegistry,
    treeSignalPublisher, approvalRegistry, approvalRuleService, approvalEscalationSuppressor, activityService,
    activityHeartbeat, todoMapper, backgroundSubagentManager, shellManager,
    skillSync, localSkills, localAgentsMd, mcpSync, routingMcpClient,
    agentRepo, modelRepo, userRepo, agentExecutor, budgetService, scheduledService,
    openTriggerSettle, openCallSettle,
  } = deps;

  const wsHandler = new StreamingWsHandler({
    registry: wsRegistry,
    titleService: sessionTitleService,
    harnessService,
    sessionService,
    taskTerminalService: taskTerminal,
    messageQueueService,
    embedPageToolRegistry,
    localToolSessionRegistry: localToolSessions,
    askUserQuestionsRegistry,
    treeSignalPublisher,
    approvalRegistry,
    approvalRuleService,
    approvalEscalationSuppressor,
    activityService,
    activityHeartbeat,
    sessionTodoMapper: todoMapper,
    agentLoop,
    compactionSignalBus,
    backgroundSubagentManager,
    shellSessionManager: shellManager,
    skillSyncService: skillSync,
    localSkillRegistry: localSkills,
    localAgentsMdRegistry: localAgentsMd,
    mcpSyncService: mcpSync,
    mcpClientManager: routingMcpClient,
    agentMapper: { selectById: (id: number) => agentRepo.findById(id) },
    llmModelMapper: {
      selectById: (id: number) => modelRepo.findById(id),
      selectDefault: () => modelRepo.findDefault(),
    },
    jwtService: jwt,
    // 账号状态检查（BUG-C3）：WS 首帧 auth 与连接内换发都与 REST preHandler 同一口径——
    // 停用/已删除账号的 token 不得建立或续期连接。WS 连接鉴权每连接仅一次，无需负缓存。
    accountStatusChecker: async (userId: number) => {
      let user: Awaited<ReturnType<typeof userRepo.findById>>;
      try {
        user = await userRepo.findById(userId);
      } catch {
        return true; // 查询异常不误伤：放行本次，下次再判
      }
      // findById 带 notDeleted()：null = 账号不存在/已删除，与刷新 token 口径一致（拒）
      if (user == null) return false;
      return !(user.status != null && user.status === 0);
    },
    agentExecutor: (fn: () => Promise<void>) => agentExecutor.submit(fn),
    mcpSyncTimeoutSeconds: cfg.app.mcp.syncTimeoutSeconds,
    budgetGate: {
      checkAdmission: async (target: { userId: number | null; agentId: number | null }) => {
        const block = await budgetService.checkAdmission(target);
        return block == null ? null : {
          budgetId: block.budgetId,
          scope: block.scope,
          spend: block.spend,
          limitValue: block.limitValue,
          limitType: block.limitType,
        };
      },
      noticeQueueBlocked: (block: BudgetBlock, notifyUserId: number | null) => budgetService.noticeQueueBlocked(block, notifyUserId),
    },
    onScheduledTaskQueueConsumed: async (taskId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => {
      await scheduledService.settleQueuedExecution(taskId, status);
    },
    onOpenTriggerQueueConsumed: async (triggerId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => {
      await openTriggerSettle.current?.(triggerId, status);
    },
    onOpenApiCallQueueSettled: async (callLogId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', queueWaitMs: number | null, messageId: number | null) => {
      await openCallSettle.current?.(callLogId, phase, queueWaitMs, messageId);
    },
  } as never);

  scheduledService.setLiveExecution(createScheduledLiveExecution(wsHandler));
  scheduledService.setSessionBusyCheck((sessionId) => wsHandler.hasExecutionClaim(sessionId));
  scheduledService.setBudgetCheck(async (target) => {
    const block = await budgetService.checkAdmission(target);
    return block == null ? null : { message: budgetBlockMessage(block) };
  });

  return wsHandler;
}
