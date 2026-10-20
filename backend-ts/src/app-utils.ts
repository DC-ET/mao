import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import type { SpawnPtyOptions, PtyLike } from './harness/terminal/remote-terminal.js';
import type { ContainerRegistry } from './harness/container/container-registry.js';
import type { RuntimeChannelServer } from './harness/container/runtime-channel-server.js';
import type { DockerToolRouter } from './harness/container/docker-tool-router.js';
import type { SessionService } from './session/session.service.js';
import type { TaskTerminalService } from './session/task-terminal.service.js';
import type { FeishuInboundQueueRepository } from './feishu/inbound-queue.repository.js';
import type { MysqlFeishuProgressCardRepository } from './feishu/progress-card.repository.js';
import type { AuditLogService } from './audit/audit.service.js';
import { TERMINAL_AUDIT_META, type TerminalAuditRecorder } from './harness/terminal/terminal-manager.js';
import { truncateAuditError } from './audit/audit.interceptor.js';
import { PtyChannelHub } from './harness/container/pty-bridge.js';
import { harnessLog } from './harness/log.js';

// ========== 通用工具 ==========

export function expandHome(v: string): string {
  if (v.startsWith('$HOME')) return v.replace(/^\$HOME/, process.env.HOME ?? '');
  if (v.startsWith('~/')) return resolve(process.env.HOME ?? '', v.slice(2));
  return v;
}

export function parseSqlTimeMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

export function runtimeSessionCleanup(runtimeRoot: string): (userId: number, sessionId: number) => void {
  return (userId: number, sessionId: number): void => {
    try {
      const sessionDir = resolve(runtimeRoot, String(userId), String(sessionId));
      if (existsSync(sessionDir)) {
        rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) {
      console.error(`Failed to clean runtime dir for session ${sessionId}`, e);
    }
  };
}

// ========== 上传静态托管 ==========

const UPLOAD_CACHE_EXCLUDED = /(^|\/)(releases\/[^/]*\.(json|ya?ml)|latest[^/]*\.ya?ml)$/i;

function uploadCacheHeaders(path: string): Record<string, string> {
  if (UPLOAD_CACHE_EXCLUDED.test(path)) return { 'Cache-Control': 'no-cache' };
  return { 'Cache-Control': 'public, max-age=604800' };
}

export async function registerUploadStatic(app: FastifyInstance, uploadDir: string, apiPrefix: string): Promise<void> {
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: '/uploads/',
    decorateReply: false,
    setHeaders: (reply, path) => {
      for (const [k, v] of Object.entries(uploadCacheHeaders(path))) reply.header(k, v);
    },
  });
  await app.register(fastifyStatic, {
    root: uploadDir,
    prefix: `${apiPrefix.replace(/\/$/, '')}/uploads/`,
    decorateReply: false,
    setHeaders: (reply, path) => {
      for (const [k, v] of Object.entries(uploadCacheHeaders(path))) reply.header(k, v);
    },
  });
}

// ========== 终端审计 ==========

export function createTerminalAudit(auditService: AuditLogService): TerminalAuditRecorder {
  return (event, terminal, ctx) => {
    const meta = TERMINAL_AUDIT_META[event];
    void auditService.record({
      action: meta.action,
      objectType: 'terminal',
      objectId: terminal.terminalId,
      method: meta.method,
      path: meta.path(terminal.sessionId, terminal.terminalId),
      userId: terminal.userId,
      username: ctx?.username ?? null,
      ip: ctx?.ip ?? null,
      status: ctx?.errorMessage == null ? 200 : 500,
      success: ctx?.errorMessage == null ? 1 : 0,
      errorMessage: truncateAuditError(ctx?.errorMessage),
    }).catch((e) => console.error('Failed to record terminal audit log', e));
  };
}

// ========== 容器 PTY 工厂 ==========

export interface ContainerPtyFactoryDeps {
  dockerRouter: DockerToolRouter;
  containerRegistry: ContainerRegistry;
  channelServer: RuntimeChannelServer;
  ptyChannelHubs: Map<number, PtyChannelHub>;
  ptyHubGeneration: Map<number, number>;
  nodePtyFactory: (options: SpawnPtyOptions) => Promise<PtyLike> | PtyLike;
}

export function createContainerPtyFactory(deps: ContainerPtyFactoryDeps): (options: SpawnPtyOptions) => Promise<PtyLike> {
  const { dockerRouter, containerRegistry, channelServer, ptyChannelHubs, ptyHubGeneration, nodePtyFactory } = deps;

  return async (options: SpawnPtyOptions): Promise<PtyLike> => {
    const userId = options.userId;
    if (userId != null && await dockerRouter.enabledFor(userId)) {
      const entry = await containerRegistry.ensureRunning(userId, options.cwd);
      const connection = channelServer.getConnection(userId);
      if (!connection) throw new Error(`容器终端通道未就绪: userId=${userId}`);
      let hub = ptyChannelHubs.get(userId);
      if (!hub || ptyHubGeneration.get(userId) !== entry.startedAtMs) {
        hub?.dispose();
        hub = new PtyChannelHub(connection);
        ptyChannelHubs.set(userId, hub);
        ptyHubGeneration.set(userId, entry.startedAtMs);
      } else {
        hub.bindConnection(connection);
      }
      const bridge = await hub.open(userId, options);
      harnessLog('info', `[container] terminal pty opened in container: user=${userId}, pid=${bridge.pid}`);
      return bridge;
    }
    return nodePtyFactory(options);
  };
}

// ========== 取消持久化 ==========

export interface PersistCancelledDeps {
  sessionService: SessionService;
  taskTerminal: TaskTerminalService;
  feishuProgressCardRepo: MysqlFeishuProgressCardRepository;
}

export function createPersistCancelledHelper(deps: PersistCancelledDeps) {
  const { sessionService, taskTerminal, feishuProgressCardRepo } = deps;

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

// ========== 排队位置 ==========

export interface QueuePositionDeps {
  feishuInboundQueueRepo: FeishuInboundQueueRepository;
}

export function createQueuePositionHelper(deps: QueuePositionDeps) {
  const { feishuInboundQueueRepo } = deps;

  return async (sessionId: number): Promise<number> => (await feishuInboundQueueRepo.countPending(sessionId));
}
