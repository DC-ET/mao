import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, pathParam } from '../common/request.js';
import { resolveIp } from '../audit/audit.interceptor.js';
import { TerminalLimitError, TerminalSpawnError, type TerminalManager } from '../harness/terminal/terminal-manager.js';
import { RelayOpenError, type LocalTerminalRelay } from '../harness/terminal/local-terminal-relay.js';
import { TERMINAL_USE_PERMISSION } from '../harness/terminal/terminal-ws-handler.js';
import type { RemoteTerminalInfo } from '../harness/terminal/remote-terminal.js';
import type { Session } from './types.js';

export interface TerminalRouteDeps {
  terminalManager: TerminalManager;
  /**
   * 本地任务中继终端（技术方案 2026-11-18 §4.3）：LOCAL 会话的 PTY 跑在绑定设备上。
   * 未注入时 LOCAL 创建按「功能未装配」拒绝，行为与改造前一致。
   */
  relay?: LocalTerminalRelay | null;
  sessionService: { getSession(id: number): Promise<Session> };
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  userLookup?: { findById(id: number): Promise<{ username: string } | null> };
}

interface CreateTerminalRequest {
  cols?: number | null;
  rows?: number | null;
}

/**
 * 终端 REST：创建 / 列表 / 关闭。云端与中继共用目录：
 * - CLOUD：服务器 PTY，逐个 handler 显式校验 terminal:use + session 归属（既有写法）。
 * - LOCAL（技术方案 2026-11-18）：PTY 在绑定设备的桌面客户端 / mao-agent 上，
 *   不校验 terminal:use（该权限语义是服务器 shell），校验归属 + 主机在线。
 * 权限不靠拦截器，与仓库既有写法一致。
 */
export function registerTerminalRoutes(app: FastifyInstance, deps: TerminalRouteDeps): void {
  const { terminalManager, sessionService, permissionService } = deps;
  const relaySvc = deps.relay ?? null;

  async function requireSessionOwner(userId: number, sessionId: number): Promise<Session> {
    const session = await sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该会话');
    }
    return session;
  }

  /** 只做登录 + 会话归属；terminal:use 由 CLOUD 分支自行检查，LOCAL 分支不检查（D5）。 */
  async function prepareOwned(
    request: FastifyRequest,
  ): Promise<{ userId: number; sessionId: number; session: Session }> {
    const userId = requireUserId(request);
    const sessionId = pathId(request, 'sessionId');
    const session = await requireSessionOwner(userId, sessionId);
    return { userId, sessionId, session };
  }

  function auditCtx(request: FastifyRequest, username: string | null): { ip: string | null; username: string | null } {
    return {
      ip: resolveIp(request.headers as Record<string, string | string[] | undefined>, request.ip) ?? null,
      username,
    };
  }

  app.post('/v1/sessions/:sessionId/terminals', async (request, reply) => {
    const body = bodyOf<CreateTerminalRequest>(request);
    const { userId, sessionId, session } = await prepareOwned(request);
    const username = (await deps.userLookup?.findById(userId))?.username ?? null;
    const ctx = auditCtx(request, username);

    if ((session.executionMode ?? 'CLOUD') !== 'CLOUD') {
      if ((session.executionMode ?? '') !== 'LOCAL' || relaySvc == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '仅云端任务支持远程终端');
      }
      // LOCAL：中继终端（PTY 在绑定设备上）。cwd 只用服务端保存的 workspace（D10）。
      if (session.workspace == null || session.workspace.trim() === '') {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '任务工作区不可用');
      }
      const deviceId = session.targetDeviceId != null && session.targetDeviceId !== '' ? session.targetDeviceId : null;
      if (deviceId == null) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, '请先在桌面客户端打开一次该任务，完成执行端登记');
      }
      try {
        const terminal = await relaySvc.create({
          sessionId,
          userId,
          deviceId,
          workspace: session.workspace,
          cols: body.cols ?? null,
          rows: body.rows ?? null,
          ...ctx,
        });
        return sendOk(reply, terminal.toInfo());
      } catch (e) {
        if (e instanceof TerminalLimitError) {
          throw new BusinessException(ErrorCode.PARAM_INVALID, e.message);
        }
        if (e instanceof RelayOpenError) {
          // 主机侧细节（路径 / 堆栈）只进服务器日志，观看端拿固定文案（§5）
          throw new BusinessException(ErrorCode.PARAM_INVALID, e.message);
        }
        throw e;
      }
    }

    await requirePermission(deps.permissionService, userId, TERMINAL_USE_PERMISSION);
    if (session.workspace == null || session.workspace.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '任务工作区不可用');
    }
    try {
      const terminal = await terminalManager.create({
        sessionId,
        userId,
        // 容器键第二维（2026-11-07 复合容器方案 §5.7）：终端绑定创建时的容器，不随切 Agent 迁移
        agentId: session.agentId,
        workspace: session.workspace,
        taskName: session.title,
        cols: body.cols ?? null,
        rows: body.rows ?? null,
        ...ctx,
      });
      return sendOk(reply, terminal.toInfo());
    } catch (e) {
      if (e instanceof TerminalLimitError) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, e.message);
      }
      if (e instanceof TerminalSpawnError) {
        throw new BusinessException(ErrorCode.INTERNAL_ERROR, e.message);
      }
      throw e;
    }
  });

  app.get('/v1/sessions/:sessionId/terminals', async (request, reply) => {
    const { userId, sessionId, session } = await prepareOwned(request);
    // D5：LOCAL 的中继终端不校验 terminal:use（否则 D5 的目标用户建得了却列不出）；
    // CLOUD 会话维持原口径（服务器 shell 的列表跟随该权限）。
    if ((session.executionMode ?? 'CLOUD') === 'CLOUD') {
      await requirePermission(deps.permissionService, userId, TERMINAL_USE_PERMISSION);
    }
    // 云端与中继的登记合并返回（同一协议；观看端按 kind 区分标签）
    const list: RemoteTerminalInfo[] = [
      ...terminalManager.list(sessionId),
      ...(relaySvc?.list(sessionId) ?? []),
    ];
    return sendOk(reply, list.sort((a, b) => a.createdAt - b.createdAt));
  });

  app.delete('/v1/sessions/:sessionId/terminals/:terminalId', async (request, reply) => {
    const { userId, sessionId } = await prepareOwned(request);
    const terminalId = pathParam(request, 'terminalId');
    const username = (await deps.userLookup?.findById(userId))?.username ?? null;
    const audit = auditCtx(request, username);
    // 已不存在视为已关闭（幂等）：归属由 prepareOwned() 的 session owner 校验兜住，
    // 无法删除他人终端（活着的终端走 sessionId/userId 双重校验）。
    // 云端终端维持 terminal:use；中继终端只看归属（D5）。
    const cloud = terminalManager.get(terminalId);
    if (cloud != null) {
      await requirePermission(deps.permissionService, userId, TERMINAL_USE_PERMISSION);
      if (cloud.sessionId !== sessionId || cloud.userId !== userId) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该终端');
      }
      terminalManager.close(terminalId, audit);
      return sendOk(reply, null);
    }
    const relayTerminal = relaySvc?.getOwnedByUser(terminalId, userId) ?? null;
    if (relayTerminal != null && relaySvc != null) {
      if (relayTerminal.sessionId !== sessionId) {
        throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该终端');
      }
      relaySvc.close(terminalId, audit);
      return sendOk(reply, null);
    }
    return sendOk(reply, null);
  });
}
