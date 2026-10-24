/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import type { AppContext } from './create-app.js';
import type { FastifyInstance } from 'fastify';

import { ScheduledTaskScheduler } from './schedule/scheduled-task.service.js';
import { readActiveBackendPort, readDeployLock } from './harness/core/deploy-lock.js';
import { WebhookDeliveryScheduler, DeliverySchedulerDbStore } from './notification/task/delivery.scheduler.js';
import { userMessagePreviewOf } from './notification/task/user-message-preview.js';
import { createSessionDetailUrlResolver } from './feishu/progress-card.js';
import { OutboundDeliveryScheduler } from './openapi/outbound-delivery.scheduler.js';
import { GenericHttpWebhookSender } from './openapi/generic-webhook-sender.js';
import { InboxCleanupScheduler } from './inbox/inbox.cleanup.js';
import { ScheduledTaskRunCleanupScheduler } from './schedule/run-cleanup.js';
import { EcpRenewScheduler } from './auth/ecp-renew.scheduler.js';
import { replayFeishuPendingMessage } from './feishu/pending-replay.js';
import { RuntimeCleanupScheduler } from './harness/runtime/runtime-cleanup-scheduler.js';
import { SubagentExecutionRecoveryService } from './harness/delegate/subagent-execution-recovery.service.js';
import { SubagentRecoveryCoordinator } from './harness/delegate/subagent-recovery-coordinator.js';
import { CrashRecoveryRunner } from './harness/core/crash-recovery-runner.js';
import { FeishuCardProgressListener } from './feishu/card-progress-listener.js';
import { DeployDrainWatcher } from './harness/core/deploy-drain-watcher.js';
import { createShutdownHandler } from './app-shutdown.js';

export interface LifecycleDeps {
  app: FastifyInstance;
  db: Db;
  cfg: AppConfig;
  ctx: AppContext;
  [key: string]: any;
}

export interface LifecycleResult {
  closeApp: () => Promise<void>;
}

export function assembleLifecycle(deps: LifecycleDeps): LifecycleResult {
  const d = deps as any;
  const { app, db, cfg, ctx } = d;

  const scheduler = new ScheduledTaskScheduler(d.scheduledStore, d.scheduledService, () => {
    const active = readActiveBackendPort(cfg.app.harness.runtimeDir);
    if (active != null) return active === cfg.server.port;
    const lock = readDeployLock(cfg.app.harness.runtimeDir);
    if (lock != null && lock.oldPort === cfg.server.port) return false;
    return true;
  });
  scheduler.start();
  const deliveryScheduler = new WebhookDeliveryScheduler(
    new DeliverySchedulerDbStore(db),
    () => d.settingService.getNotificationTuningConfig(),
    d.notifCipher,
    d.senderRegistry,
  );
  const sessionDetailUrl = createSessionDetailUrlResolver({
    getSiteBaseUrl: () => d.settingService.getSiteBaseUrl(),
  });
  deliveryScheduler.setContextProvider({
    latestUserMessage: async (sessionId: number) => {
      const message = await d.sessionService.getLastUserMessage(sessionId);
      return userMessagePreviewOf(message?.content ?? null) || null;
    },
    sessionDetailUrl: async (sessionId: number) => (await sessionDetailUrl(sessionId)) ?? null,
  });
  deliveryScheduler.start();
  const outboundDeliveryScheduler = new OutboundDeliveryScheduler({
    deliveryRepo: d.outboundDeliveryRepo,
    subscriptionRepo: d.outboundSubscriptionRepo,
    cipher: d.notifCipher,
    sender: new GenericHttpWebhookSender(),
    auditRecorder: {
      recordDeliveryFailed: async (input: any) => {
        let userId: number | null = null;
        if (input.subscriptionId != null) {
          const subscription = await d.outboundSubscriptionRepo.findById(input.subscriptionId).catch(() => null);
          userId = subscription?.userId ?? null;
        }
        await d.auditService.record({
          action: 'EXECUTE',
          objectType: 'outbound.subscription',
          objectId: input.subscriptionId == null ? null : String(input.subscriptionId),
          userId,
          username: null,
          method: 'POST',
          path: `/v1/open/subscriptions/${input.subscriptionId}/deliveries`,
          ip: null,
          status: 502,
          success: 0,
          errorMessage: `出站投递终态失败 event=${input.event} url=${input.targetUrl} error=${input.error ?? ''}`,
        }).catch(() => undefined);
      },
    },
    execute: (fn: any) => d.agentExecutor.submit(fn),
  });
  outboundDeliveryScheduler.start();
  const inboxCleanupScheduler = new InboxCleanupScheduler(d.inboxCleanupStore);
  inboxCleanupScheduler.start();
  const scheduledRunCleanup = new ScheduledTaskRunCleanupScheduler(d.scheduledStore);
  scheduledRunCleanup.start();
  d.callLogService.start();
  d.callLogCleanup.start();
  const ecpRenewScheduler = new EcpRenewScheduler(
    d.ecpSessionRepo,
    () => d.settingService.getEcpConfig(),
    undefined,
    (token: string) => d.ecpSessionRepo.encryptToken(token),
  );
  ecpRenewScheduler.start();
  d.weixinMonitor.start();
  d.feishuMonitor.start();
  d.dingtalk.start();
  void d.pendingBindingMessages.listRecoverable().then(async (pending: any[]) => {
    for (const message of pending) {
      if (ctx.pendingBindingProcessor == null) return;
      const claimed = await d.pendingBindingMessages.claim(message.state);
      if (claimed == null) continue;
      try {
        await replayFeishuPendingMessage(ctx.pendingBindingProcessor, claimed);
        await d.pendingBindingMessages.complete(claimed.state);
      } catch (error) {
        await d.pendingBindingMessages.release(claimed.state);
        console.error(`恢复飞书待绑定消息失败, state=${claimed.state}`, error);
      }
    }
  }).catch((error: unknown) => console.error('恢复飞书待绑定消息列表失败', error));
  d.shellManager.startCleanup();
  d.terminalManager.startCleanup();
  const runtimeCleanup = new RuntimeCleanupScheduler(
    cfg.app.harness.runtimeDir,
    cfg.app.harness.cleanup,
    (_userId: number, sessionId: number) => d.wsHandler.hasExecutionClaim(sessionId),
  );
  runtimeCleanup.start();
  const subagentExecutionRecovery = new SubagentExecutionRecoveryService(
    d.subagentMapper, d.sessionMap, d.sessionSvc, d.compactionSvc, d.definitionRegistry,
    (childSession: any, definition: any) => d.backgroundSubagentManager.buildSubContext(childSession, definition),
    d.agentLoop, d.visibility, d.localToolSessions,
  );
  const subagentCoordinator = new SubagentRecoveryCoordinator(
    d.subagentMapper, subagentExecutionRecovery, d.subagentResultDelivery,
    d.sessionMap, d.sessionSvc, d.compactionSvc, d.agentExecutor,
  );
  const crash = new CrashRecoveryRunner(
    d.sessionMap, d.sessionSvc, d.taskTerminal, d.harness, d.agentLoop, d.wsRegistry,
    d.activityService as never, d.activityHeartbeat, d.todoMapper, d.modelRepo as never,
    cfg.app.harness.runtimeDir,
    d.agentExecutor,
    async (sessionId: number, userId: number, phase: string) => {
      await d.scheduledService.reconcileRunsForSession(sessionId, phase).catch((error: unknown) => {
        console.warn(`定时任务运行记录在崩溃恢复后收敛失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      });
      if (phase !== 'FAILED') {
        void d.wsHandler.autoConsumeQueue(sessionId, userId);
        await d.feishuProgressCardRepo.deleteBySessionId(sessionId).catch((error: unknown) => {
          console.warn(`清理飞书进度卡片映射失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
        });
        await d.feishuInboundHandler.drainNextIfPending(sessionId).catch((error: unknown) => {
          console.error(`飞书崩溃恢复后队列接力消费失败, sessionId=${sessionId}`, error);
        });
        await d.dingtalk.onCrashFinished(sessionId, phase).catch((error: unknown) => {
          console.error(`钉钉崩溃恢复后队列接力消费失败, sessionId=${sessionId}`, error);
        });
      }
    },
    subagentCoordinator,
    async (sessionId: number) => {
      const dingtalkRecovered = await d.dingtalk.recoverProgress(sessionId);
      if (dingtalkRecovered != null) return new FeishuCardProgressListener(dingtalkRecovered.progress, dingtalkRecovered.roundOffset);
      const recovered = await d.createFeishuRecoveryProgress(sessionId);
      return recovered == null ? null : new FeishuCardProgressListener(recovered.progress, recovered.roundOffset);
    },
    (sessionId: number) => d.agentLoop.getCancelFlag(sessionId) != null,
    cfg.server.port,
  );
  void crash.run().catch((e: unknown) => console.error('Crash recovery failed', e)).then(async () => {
    await d.dingtalk.hydrate().catch((error: unknown) => console.error('钉钉入站队列启动恢复失败', error));
    const sessionIds = await d.feishuTaskQueue.hydrate();
    for (const sessionId of sessionIds) {
      await d.feishuInboundHandler.drainNextIfPending(sessionId).catch((error: unknown) => {
        console.error(`飞书队列启动恢复消费失败, sessionId=${sessionId}`, error);
      });
    }
  }).catch((error: unknown) => console.error('飞书入站队列启动恢复失败', error));

  crash.startPeriodicSweep();

  const drainWatcher = new DeployDrainWatcher({
    runtimeDir: cfg.app.harness.runtimeDir,
    selfPort: cfg.server.port,
    startedAtSec: Math.floor((Date.now() - process.uptime() * 1000) / 1000),
    shutdown: () => closeApp(),
  });

  const closeApp = createShutdownHandler({
    app, db, cfg, ctx,
    crash, drainWatcher,
    weixinMonitor: d.weixinMonitor, feishuMonitor: d.feishuMonitor, dingtalk: d.dingtalk,
    weixinInboundHandler: d.weixinInboundHandler, feishuInboundProcessor: d.feishuInboundProcessor,
    scheduler, deliveryScheduler, callLogService: d.callLogService, callLogCleanup: d.callLogCleanup,
    watcherScheduler: d.watcherScheduler, signalCheckCleanup: d.signalCheckCleanup, ecpRenewScheduler,
    shellManager: d.shellManager, terminalManager: d.terminalManager,
    ptyChannelHubs: d.ptyChannelHubs, ptyHubGeneration: d.ptyHubGeneration,
    containerRegistry: d.containerRegistry, channelServer: d.channelServer, runtimeCleanup,
    activityHeartbeat: d.activityHeartbeat, wsRegistry: d.wsRegistry,
    agentLoop: d.agentLoop, wsHandler: d.wsHandler, sessionService: d.sessionService,
  });
  drainWatcher.start();

  return { closeApp };
}
