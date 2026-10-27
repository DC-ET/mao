import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import type { SessionService } from './session/session.service.js';
import type { MessageQueueService } from './session/message-queue.service.js';
import type { TaskTerminalService } from './session/task-terminal.service.js';
import type { MysqlAgentRepository } from './agent/agent.repository.js';
import type { StreamingWsHandler } from './session/ws/streaming-ws-handler.js';
import type { BudgetService } from './budget/budget.service.js';
import type { ApiTokenService } from './openapi/api-token.service.js';
import type { InboxService } from './inbox/inbox.service.js';
import type { SystemSettingService } from './settings/settings.service.js';
import type { FixedWindowRateLimiter } from './openapi/rate-limiter.js';
import type { WebhookSecretCipher } from './notification/task/webhook-secret-cipher.js';
import type { OutboundSubscriptionService } from './openapi/outbound-subscription.service.js';
import type { HarnessService } from './harness/core/harness-service.js';
import { createAgentExecutor } from './harness/core/agent-executor.js';

import { OpenRunService, type OpenRunDeps } from './openapi/open-run.service.js';
import { OpenApiCallLogRepository } from './openapi/open-api-call-log.repository.js';
import { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';
import { OpenApiCallLogCleanup } from './openapi/open-api-call-log.cleanup.js';
import { MysqlWebhookTriggerRepository } from './openapi/openapi.repository.js';
import { WebhookTriggerService, type WebhookTriggerDeps } from './openapi/webhook-trigger.service.js';
import { SignalSecretCipher } from './signal/signal-cipher.js';
import { MysqlSignalWatcherRepository, MysqlSignalCheckRepository } from './signal/signal.repository.js';
import { WatcherService } from './signal/watcher.service.js';
import { WatcherScheduler } from './signal/watcher-scheduler.js';
import { SignalCheckCleanup } from './signal/signal-check-cleanup.js';
import { DigestRepository } from './digest/repository.js';
import { DigestService } from './digest/service.js';
import { DigestScheduler } from './digest/scheduler.js';
import { budgetBlockMessage, createScheduledLiveExecution } from './session/ws/streaming-ws-handler.js';

export interface OpenApiServicesDeps {
  db: Db;
  cfg: AppConfig;
  sessionService: SessionService;
  messageQueueService: MessageQueueService;
  taskTerminal: TaskTerminalService;
  agentRepo: MysqlAgentRepository;
  wsHandler: StreamingWsHandler;
  budgetService: BudgetService;
  apiTokenService: ApiTokenService;
  inboxService: InboxService;
  settingService: SystemSettingService;
  openApiRateLimiter: FixedWindowRateLimiter;
  notifCipher: WebhookSecretCipher;
  outboundSubscriptionService: OutboundSubscriptionService;
  holder: { harness?: HarnessService };
  agentExecutor: ReturnType<typeof createAgentExecutor>;
  openCallLogHolder: { current: OpenApiCallLogService | null };
  openTriggerSettle: { current: ((triggerId: number, status: 'COMPLETED' | 'FAILED' | 'CANCELLED') => Promise<void>) | null };
  openCallSettle: { current: ((callLogId: number, phase: 'COMPLETED' | 'FAILED' | 'CANCELLED', queueWaitMs: number | null, messageId: number | null) => Promise<void>) | null };
}

export interface OpenApiServicesResult {
  openRunService: OpenRunService;
  callLogService: OpenApiCallLogService;
  callLogCleanup: OpenApiCallLogCleanup;
  webhookTriggerService: WebhookTriggerService;
  watcherService: WatcherService;
  watcherScheduler: WatcherScheduler;
  signalCheckCleanup: SignalCheckCleanup;
  digestService: DigestService;
  digestScheduler: DigestScheduler;
  signalWatcherRepo: MysqlSignalWatcherRepository;
}

export function assembleOpenApiServices(deps: OpenApiServicesDeps): OpenApiServicesResult {
  const { db, cfg, sessionService, messageQueueService, taskTerminal, agentRepo, wsHandler, budgetService, apiTokenService, inboxService, settingService, openApiRateLimiter, notifCipher, outboundSubscriptionService, holder, agentExecutor, openCallLogHolder, openTriggerSettle, openCallSettle } = deps;

  const openRunService = new OpenRunService({
    sessionService: sessionService as unknown as OpenRunDeps['sessionService'],
    messageQueueService,
    harnessService: { executeFromEvent: (sessionId, executionId, listener) => holder.harness!.executeFromEvent(sessionId, executionId, listener as never) },
    taskTerminalService: taskTerminal,
    agentLookup: { findById: (id: number) => agentRepo.findById(id) },
    isSessionBusy: (sessionId) => wsHandler.hasExecutionClaim(sessionId),
    budgetCheck: async (target) => {
      const block = await budgetService.checkAdmission(target);
      return block == null ? null : { message: budgetBlockMessage(block) };
    },
    liveExecution: createScheduledLiveExecution(wsHandler),
  });
  const callLogService = new OpenApiCallLogService({
    repo: new OpenApiCallLogRepository(db),
    tokens: apiTokenService,
    inbox: inboxService,
    openRun: openRunService,
  });
  openCallLogHolder.current = callLogService;
  openCallSettle.current = (callLogId, phase, queueWaitMs, messageId) => callLogService.settleQueued(callLogId, phase, queueWaitMs, messageId);
  apiTokenService.setOutcomePolicy({
    enabled: () => settingService.isOpenApiTokenAutoDisableEnabled(),
    threshold: () => settingService.getOpenApiTokenAutoDisableThreshold(),
    notifyDisabled: (input) => inboxService.recordTokenDisabled(input),
  });
  const callLogCleanup = new OpenApiCallLogCleanup(
    new OpenApiCallLogRepository(db),
    () => settingService.getOpenApiCallLogRetentionDays(),
  );
  const webhookTriggerService = new WebhookTriggerService({
    triggerRepo: new MysqlWebhookTriggerRepository(db),
    sessionService: sessionService as unknown as WebhookTriggerDeps['sessionService'],
    agentLookup: { findById: (id: number) => agentRepo.findById(id) },
    cipher: notifCipher,
    openRun: openRunService,
    rateLimiter: openApiRateLimiter,
    disableNotifier: {
      notifyTriggerDisabled: async (input) => {
        await inboxService.recordTriggerDisabled(input);
      },
    },
    callLog: callLogService,
  });
  openTriggerSettle.current = (triggerId, status) => webhookTriggerService.handleQueueSettled(triggerId, status);

  const signalCipher = new SignalSecretCipher(cfg.app.signal.secretKey);
  const signalWatcherRepo = new MysqlSignalWatcherRepository(db);
  const signalCheckRepo = new MysqlSignalCheckRepository(db);
  const watcherService = new WatcherService({
    watcherRepo: signalWatcherRepo,
    checkRepo: signalCheckRepo,
    cipher: signalCipher,
    openRun: openRunService,
    // 复用指针有效性预检（技术方案 2026-10-27 §3.2.3）
    getSession: (id) => sessionService.getSession(id),
    disableNotifier: {
      notifyWatcherDisabled: async (input) => {
        await inboxService.recordWatcherDisabled(input);
      },
    },
  });
  const watcherScheduler = new WatcherScheduler({
    watcherRepo: signalWatcherRepo,
    runCheck: (id) => watcherService.runCheck(id),
    execute: (fn) => agentExecutor.submit(fn),
  });
  watcherScheduler.start();
  const signalCheckCleanup = new SignalCheckCleanup(
    signalCheckRepo,
    () => settingService.getSignalCheckRetentionDays(),
  );
  signalCheckCleanup.start();

  const digestRepo = new DigestRepository(db);
  const digestService = new DigestService({
    repo: digestRepo,
    inbox: {
      writeDigestEntry: (input) => inboxService.writeDigestEntry(input),
      hasDigestEntry: (userId, dedupTail) => inboxService.hasDigestEntry(userId, dedupTail),
    },
    outbound: {
      dispatchDigest: (input) => outboundSubscriptionService.dispatchDigest(input),
    },
  });
  const digestScheduler = new DigestScheduler({
    listEnabledUsers: () => digestRepo.listEnabledUsers(),
    processUser: (userId) => digestService.processUser(userId),
  });
  digestScheduler.start();

  return {
    openRunService, callLogService, callLogCleanup, webhookTriggerService,
    watcherService, watcherScheduler, signalCheckCleanup, digestService, digestScheduler,
    signalWatcherRepo,
  };
}
