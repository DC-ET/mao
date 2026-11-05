import { existsSync, readdirSync, rmSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
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

/**
 * 共享目录路径解析（共享目录方案 §4.1 误配防护）：空值或相对路径若被 resolve 静默
 * 按 cwd 解析，容器模式下 assertSafe 的 owningRoot 校验对 share 条目恒真通过
 * （shareDir 自身即登记根），唯一兜底的父目录防护又依赖 cwd 与 distDir 的相对
 * 布局——误配时整个后端工作树（含 .env 密钥）会被 ro 挂进所有用户容器。
 * 启动即拒：必须在 resolve 之前校验原始值，否则相对路径已被静默转绝对。
 */
export function resolveShareDir(raw: string): string {
  const expanded = expandHome(raw);
  if (!expanded || !isAbsolute(expanded)) {
    throw new Error(`MAO_SHARE_DIR must be a non-empty absolute path, got '${raw}'`);
  }
  return resolve(expanded);
}

export function parseSqlTimeMs(value: string | null | undefined): number | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(value.includes('T') ? value : value.replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

export function runtimeSessionCleanup(runtimeRoot: string): (userId: number, sessionId: number) => void {
  return (userId: number, sessionId: number): void => {
    // 归属者目录无条件回收（即使根目录枚举失败也不影响）。
    const cleaned = new Set<string>([resolve(runtimeRoot, String(userId), String(sessionId))]);
    try {
      // 群聊会话的运行期产物按「运行身份」分别落盘（技术方案 2026-11-04 §5.2/§5.9）：
      // dump_user_messages / open_web_page 缓存 / 技能软链等都在 {runtimeRoot}/{发言者}/{sid} 下，
      // 删除会话时不能只回收归属者目录，否则每个发言者都会留下永不回收的残留。
      // sessionId 全局唯一，按 {runtimeRoot}/*/{sid} 扫描删除（删除是低频操作，可接受一次枚举）。
      // 严格只认纯数字一级目录（用户 id 形态）：runtimeRoot 下还有 channels 等非用户目录，
      // channel 目录名恰为 userId——若全量扫描，sessionId == 某 userId 时会误删该用户
      // 的容器通道目录（socket/.token），打挂其 docker 运行面（评审 P0，2026-11-04）。
      for (const entry of readdirSync(runtimeRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
        cleaned.add(resolve(runtimeRoot, entry.name, String(sessionId)));
      }
    } catch (e) {
      console.error(`Failed to enumerate runtime dirs for session ${sessionId}`, e);
    }
    try {
      for (const sessionDir of cleaned) {
        if (!existsSync(sessionDir)) continue;
        try {
          rmSync(sessionDir, { recursive: true, force: true });
        } catch (e) {
          // 单个目录 EBUSY/EACCES 不应跳过其余发言者目录（残留可下次再清，但不能漏清）。
          console.error(`Failed to clean runtime dir ${sessionDir} for session ${sessionId}`, e);
        }
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

// ========== 平台队列接力 ==========

export interface PlatformQueueRelayDeps {
  sessionService: { getSession(sessionId: number): Promise<{ userId?: number | null } | null> };
  /** WS 侧排队消息消费入口（streaming-ws-handler 的 autoConsumeQueue）。 */
  wsHandler: { autoConsumeQueue(sessionId: number, userId: number, options?: { relayToIm?: boolean }): Promise<void> };
}

/**
 * IM （飞书/钉钉/微信）执行收尾、入站队列排空且会话空闲后的接力消费：
 * 按会话归属者消费 message_queue（定时任务/Webhook/插队）——否则「定时任务在会话忙时入队、
 * 之后该会话只有 IM 通道执行」的消息会永远停在 QUEUED（管理后台显示「排队中」）。
 * relayToIm=false 防止「IM 链 → 平台链 → IM 链」互相无限传递。失败静默留日志，不外抛。
 */
export function createPlatformQueueRelay(deps: PlatformQueueRelayDeps): (sessionId: number) => void {
  const { sessionService, wsHandler } = deps;
  return (sessionId: number): void => {
    void (async () => {
      const session = await sessionService.getSession(sessionId).catch(() => null);
      if (session?.userId == null) return;
      await wsHandler.autoConsumeQueue(sessionId, session.userId, { relayToIm: false });
    })().catch((error: unknown) => {
      console.warn(`IM 队列排空后接力消费平台队列失败, sessionId=${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
    });
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
