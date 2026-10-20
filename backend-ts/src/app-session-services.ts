/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Db } from './db/db.js';
import type { SessionService } from './session/session.service.js';
import type { SessionRepository } from './session/session.repository.js';
import type { MessageQueueService } from './session/message-queue.service.js';
import type { MessageRepository } from './session/session.repository.js';
import type { ActivityService } from './session/activity.service.js';
import type { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import type { SessionTodoMapper } from './harness/todo/session-todo.mapper.js';
import type { ScheduledTaskDbStore } from './schedule/scheduled-task.store.js';
import type { TaskNotificationDeliveryService } from './notification/task/delivery.service.js';
import type { MemoryExtractionService } from './memory/memory-extraction.service.js';
import type { MessageCitationService } from './session/message-citations.js';
import type { BudgetService } from './budget/budget.service.js';
import type { InboxService } from './inbox/inbox.service.js';
import type { OutboundSubscriptionService } from './openapi/outbound-subscription.service.js';
import type { WeixinWebhookFallbackService } from './weixin/webhook-fallback.service.js';
import type { WeixinSendService } from './weixin/send.service.js';
import type { WeixinAccountRepository } from './weixin/account.repository.js';
import type { ContextTokenRepository } from './weixin/context-token.repository.js';
import type { StreamingWsRegistry } from './session/ws/streaming-ws-registry.js';
import type { AgentDefinitionRegistry } from './harness/delegate/agent-definition-registry.js';
import type { SubagentExecutionMapper } from './harness/delegate/subagent-execution.mapper.js';
import type { SubagentInvocationService } from './harness/delegate/subagent-invocation.service.js';
import type { LocalToolSessionRegistry } from './harness/local/local-tool-session-registry.js';
import type { FileChangeRepository } from './session/session.repository.js';
import type { MysqlLlmModelRepository } from './model/model.repository.js';
import type { LlmCallRepository } from './usage/llm-call.repository.js';
import type { HarnessService } from './harness/core/harness-service.js';
import type { AgentLoop } from './harness/core/agent-loop.js';
import { createAgentExecutor } from './harness/core/agent-executor.js';

import { TaskTerminalService } from './session/task-terminal.service.js';
import { SubAgentVisibilityService } from './harness/delegate/subagent-visibility-service.js';
import { BackgroundSubagentManager } from './harness/delegate/background-subagent-manager.js';
import { ScheduledTaskService } from './schedule/scheduled-task.service.js';
import { wsEvent } from './session/ws/ws-event.js';
import { lazyRef } from './common/lazy-ref.js';
import { sumCostMicros, wallClockMs } from './session/run-window.js';

export interface SessionServicesDeps {
  db: Db;
  sessionService: SessionService;
  sessionSvc: any;
  sessionMap: any;
  messageRepo: MessageRepository;
  messageQueueService: MessageQueueService;
  activityService: ActivityService;
  activityHeartbeat: SessionActivityHeartbeat;
  todoMapper: SessionTodoMapper;
  modelRepo: MysqlLlmModelRepository;
  llmCallRepo: LlmCallRepository;
  fileChangeRepo: FileChangeRepository;
  wsRegistry: StreamingWsRegistry;
  treeSignalPublisher: any;
  inboxService: InboxService;
  budgetService: BudgetService;
  deliveryService: TaskNotificationDeliveryService;
  memoryExtraction: MemoryExtractionService;
  messageCitationService: MessageCitationService;
  outboundSubscriptionService: OutboundSubscriptionService;
  weixinWebhookFallback: WeixinWebhookFallbackService;
  weixinSend: WeixinSendService;
  weixinAccounts: any;
  weixinTokens: any;
  weixinInboundMessagesRef: { current: any };
  definitionRegistry: AgentDefinitionRegistry;
  subagentMapper: SubagentExecutionMapper;
  subagentInvocation: SubagentInvocationService;
  localToolSessions: LocalToolSessionRegistry;
  scheduledStore: ScheduledTaskDbStore;
  agentExecutor: ReturnType<typeof createAgentExecutor>;
  holder: { harness?: HarnessService; loop?: AgentLoop };
}

export interface SessionServicesResult {
  taskTerminal: TaskTerminalService;
  visibility: SubAgentVisibilityService;
  backgroundSubagentManager: BackgroundSubagentManager;
  scheduledService: ScheduledTaskService;
}

export function assembleSessionServices(deps: SessionServicesDeps): SessionServicesResult {
  const d = deps as any;

  const taskTerminal = new TaskTerminalService(
    d.sessionService, d.wsRegistry, d.deliveryService, d.treeSignalPublisher, (fn: any) => d.agentExecutor.submit(fn),
    d.memoryExtraction, (fn: any) => d.agentExecutor.submit(fn),
    d.inboxService, 'MANUAL',
    { dispatchTaskTerminal: (input: any) => d.outboundSubscriptionService.dispatchTaskTerminal(input) },
    {
      settleWarn: (target: any, notifyUserId: any) => d.budgetService.settleWarn(target, notifyUserId),
    },
    d.messageCitationService,
  );
  const visibility = new SubAgentVisibilityService({
    registry: d.wsRegistry,
    activityService: d.activityService as never,
    activityHeartbeat: d.activityHeartbeat,
    sessionTodoMapper: d.todoMapper,
    sessionService: d.sessionService as never,
    taskTerminalService: taskTerminal,
    llmModelLookup: d.modelRepo,
    harnessService: lazyRef(() => d.holder.harness!),
  });

  const backgroundSubagentManager = new BackgroundSubagentManager({
    definitionRegistry: d.definitionRegistry,
    harnessService: () => d.holder.harness!,
    agentLoop: () => d.holder.loop!,
    sessionMapper: d.sessionMap,
    sessionService: d.sessionSvc,
    subagentExecutionMapper: d.subagentMapper,
    subagentInvocationService: d.subagentInvocation,
    localToolSessionRegistry: d.localToolSessions,
    visibilityService: visibility,
    agentExecutor: d.agentExecutor,
    fileChangeRepo: d.fileChangeRepo as never,
    inboxRecorder: d.inboxService,
    completionNoticeBroadcaster: {
      broadcastCompletionNotice: (userId: any, event: any) => {
        if (userId == null) return;
        d.wsRegistry.send(userId, wsEvent('assistant_message_saved', event.sessionId, event.data));
      },
    },
  });

  const scheduledService = new ScheduledTaskService(
    d.scheduledStore,
    d.sessionService as never,
    d.messageQueueService as never,
    {
      executeFromEvent: (sessionId: any, executionId: any, listener: any) => d.holder.harness!.executeFromEvent(sessionId, executionId, listener as never),
    },
    taskTerminal,
    d.weixinSend,
    d.weixinAccounts as never,
    d.weixinTokens as never,
    (fn: any) => d.agentExecutor.submit(fn),
  );
  scheduledService.setFailureNotifier((input: any) => d.inboxService.recordScheduledTaskPaused(input));
  scheduledService.setWeixinInboundRepository({
    findLatestInboundAt: (accountId: any) => d.weixinInboundMessagesRef.current.findLatestInboundAt(accountId),
  });
  scheduledService.setWeixinWindowNotifier(async (input: any) => {
    await d.inboxService.recordWeixinWindowClosed(input);
  });
  scheduledService.setWeixinWebhookFallback(d.weixinWebhookFallback);
  scheduledService.setRunWindowLoader(async (sessionId: number, messageId: number) => {
    const stamps = await d.messageRepo.selectUserStamps(sessionId);
    const anchor = stamps.find((stamp: any) => stamp.id === messageId);
    if (anchor?.createdAt == null) return { costMicros: null, wallClockMs: 0 };
    const upperId = stamps
      .map((stamp: any) => stamp.id)
      .filter((id: any): id is number => id != null && id > messageId)
      .sort((a: number, b: number) => a - b)[0];
    const upper = upperId == null ? null : (stamps.find((stamp: any) => stamp.id === upperId)?.createdAt ?? null);
    const calls = await d.llmCallRepo.selectBySessionWindow(sessionId, anchor.createdAt, upper);
    return {
      costMicros: sumCostMicros(calls),
      wallClockMs: wallClockMs(calls.map((call: any) => ({ createdAt: call.createdAt ?? null, durationMs: call.durationMs ?? null }))),
    };
  });

  return { taskTerminal, visibility, backgroundSubagentManager, scheduledService };
}
