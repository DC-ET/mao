import type { FastifyInstance } from 'fastify';
import type { Db } from './db/db.js';
import type { AppConfig } from './config/app-config.js';
import { isDrainingInstance, deployDrainSec, readDeployLock } from './harness/core/deploy-lock.js';
import type { AgentLoop } from './harness/core/agent-loop.js';
import type { StreamingWsHandler } from './session/ws/streaming-ws-handler.js';
import type { StreamingWsRegistry } from './session/ws/streaming-ws-registry.js';
import type { SessionService } from './session/session.service.js';
import type { CrashRecoveryRunner } from './harness/core/crash-recovery-runner.js';
import type { DeployDrainWatcher } from './harness/core/deploy-drain-watcher.js';
import type { ShellSessionManager } from './harness/shell/shell-session-manager.js';
import type { TerminalManager } from './harness/terminal/terminal-manager.js';
import type { RuntimeChannelServer } from './harness/container/runtime-channel-server.js';
import type { ContainerRegistry } from './harness/container/container-registry.js';
import type { PtyChannelHub } from './harness/container/pty-bridge.js';
import type { RuntimeCleanupScheduler } from './harness/runtime/runtime-cleanup-scheduler.js';
import type { SessionActivityHeartbeat } from './session/session-activity-heartbeat.js';
import type { WeixinMonitorService } from './weixin/monitor.service.js';
import type { FeishuMonitorService } from './feishu/monitor.service.js';
import type { FeishuInboundProcessor } from './feishu/inbound-processor.js';
import type { AgentWeixinInboundHandler } from './weixin/agent-inbound-handler.js';
import type { ScheduledTaskScheduler } from './schedule/scheduled-task.service.js';
import type { WebhookDeliveryScheduler } from './notification/task/delivery.scheduler.js';
import type { OpenApiCallLogService } from './openapi/open-api-call-log.service.js';
import type { OpenApiCallLogCleanup } from './openapi/open-api-call-log.cleanup.js';
import type { WatcherScheduler } from './signal/watcher-scheduler.js';
import type { SignalCheckCleanup } from './signal/signal-check-cleanup.js';
import type { EcpRenewScheduler } from './auth/ecp-renew.scheduler.js';

/** 停机时需要优雅关闭的所有组件。 */
export interface ShutdownDeps {
  app: FastifyInstance;
  db: Db;
  cfg: AppConfig;
  ctx: { closing: Promise<void> | null };
  crash: CrashRecoveryRunner;
  drainWatcher: DeployDrainWatcher;
  weixinMonitor: WeixinMonitorService;
  feishuMonitor: FeishuMonitorService;
  dingtalk: { shutdown(): void; flushInbound(): Promise<void> };
  weixinInboundHandler: AgentWeixinInboundHandler;
  feishuInboundProcessor: FeishuInboundProcessor;
  scheduler: ScheduledTaskScheduler;
  deliveryScheduler: WebhookDeliveryScheduler;
  callLogService: OpenApiCallLogService;
  callLogCleanup: OpenApiCallLogCleanup;
  watcherScheduler: WatcherScheduler;
  signalCheckCleanup: SignalCheckCleanup;
  ecpRenewScheduler: EcpRenewScheduler;
  shellManager: ShellSessionManager;
  terminalManager: TerminalManager;
  ptyChannelHubs: Map<number, PtyChannelHub>;
  ptyHubGeneration: Map<number, number>;
  containerRegistry: ContainerRegistry;
  channelServer: RuntimeChannelServer;
  runtimeCleanup: RuntimeCleanupScheduler;
  activityHeartbeat: SessionActivityHeartbeat;
  wsRegistry: StreamingWsRegistry;
  agentLoop: AgentLoop;
  wsHandler: StreamingWsHandler;
  sessionService: SessionService;
}

/**
 * 创建幂等关闭处理器。可能被 drain 监听器与 SIGTERM 路径同时触发。
 */
export function createShutdownHandler(deps: ShutdownDeps): () => Promise<void> {
  const {
    app, db, cfg, ctx, crash, drainWatcher,
    weixinMonitor, feishuMonitor, dingtalk, weixinInboundHandler, feishuInboundProcessor,
    scheduler, deliveryScheduler, callLogService, callLogCleanup,
    watcherScheduler, signalCheckCleanup, ecpRenewScheduler,
    shellManager, terminalManager, ptyChannelHubs, ptyHubGeneration,
    containerRegistry, channelServer, runtimeCleanup, activityHeartbeat, wsRegistry,
    agentLoop, wsHandler, sessionService,
  } = deps;

  const isDrainingForDeploy = (): boolean => isDrainingInstance(cfg.app.harness.runtimeDir, cfg.server.port);

  const listInFlightSessionIds = (): number[] => [
    ...new Set([...agentLoop.listActiveSessionIds(), ...wsHandler.listActiveExecutionSessionIds()]),
  ];

  const settleInFlightExecutions = async (graceMs: number): Promise<void> => {
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (listInFlightSessionIds().length === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    const interrupted = listInFlightSessionIds();
    if (interrupted.length === 0) return;
    console.warn(`停机时仍有 ${interrupted.length} 个执行未收尾，尝试标记 RESUMING: ${interrupted.join(',')}`);
    for (const sessionId of interrupted) {
      try {
        await sessionService.markInterruptedIfActive(sessionId);
      } catch (error) {
        console.error(`标记被中断会话失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const drainGraceMs = (): number => {
    const lock = readDeployLock(cfg.app.harness.runtimeDir);
    const drainWindowMs = deployDrainSec(lock) * 1000;
    return Math.max(3_000, Math.min(40_000, drainWindowMs - 15_000));
  };

  return (): Promise<void> => {
    if (ctx.closing != null) return ctx.closing;
    ctx.closing = (async () => {
      crash.stopPeriodicSweep();
      drainWatcher.stop();
      weixinMonitor.shutdown();
      feishuMonitor.shutdown();
      dingtalk.shutdown();
      weixinInboundHandler.shutdown();
      await feishuInboundProcessor.flushAll();
      await dingtalk.flushInbound();
      await settleInFlightExecutions(isDrainingForDeploy() ? drainGraceMs() : 0);
      scheduler.stop();
      deliveryScheduler.stop();
      callLogService.stop();
      callLogCleanup.stop();
      watcherScheduler.stop();
      signalCheckCleanup.stop();
      ecpRenewScheduler.stop();
      shellManager.stopCleanup();
      terminalManager.stopCleanup();
      terminalManager.closeAll();
      for (const hub of ptyChannelHubs.values()) hub.dispose();
      ptyChannelHubs.clear();
      ptyHubGeneration.clear();
      containerRegistry.stopIdleLoop();
      await containerRegistry.stopAllForShutdown().catch((e) => console.warn(`[container] stopAllForShutdown failed: ${(e as Error).message}`));
      await channelServer.stop();
      runtimeCleanup.stop();
      activityHeartbeat.stopAll();
      wsRegistry.shutdown();
      await app.close();
      await db.close();
    })();
    return ctx.closing;
  };
}
