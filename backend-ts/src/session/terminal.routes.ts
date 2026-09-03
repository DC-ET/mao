import type { FastifyInstance, FastifyRequest } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requirePermission, requireUserId, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, pathParam } from '../common/request.js';
import { resolveIp } from '../audit/audit.interceptor.js';
import { TerminalLimitError, TerminalSpawnError, type TerminalManager } from '../harness/terminal/terminal-manager.js';
import { TERMINAL_USE_PERMISSION } from '../harness/terminal/terminal-ws-handler.js';
import type { Session } from './types.js';

export interface TerminalRouteDeps {
  terminalManager: TerminalManager;
  sessionService: { getSession(id: number): Promise<Session> };
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
  userLookup?: { findById(id: number): Promise<{ username: string } | null> };
}

interface CreateTerminalRequest {
  cols?: number | null;
  rows?: number | null;
}

/**
 * 云端终端 REST：创建 / 列表 / 关闭。
 * 权限不靠拦截器，逐个 handler 显式校验 terminal:use + session 归属（与仓库既有写法一致）。
 */
export function registerTerminalRoutes(app: FastifyInstance, deps: TerminalRouteDeps): void {
  const { terminalManager, sessionService, permissionService } = deps;

  async function requireSessionOwner(userId: number, sessionId: number): Promise<Session> {
    const session = await sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该会话');
    }
    return session;
  }

  async function prepare(request: FastifyRequest): Promise<{ userId: number; sessionId: number; session: Session }> {
    const userId = requireUserId(request);
    await requirePermission(permissionService, userId, TERMINAL_USE_PERMISSION);
    const sessionId = pathId(request, 'sessionId');
    const session = await requireSessionOwner(userId, sessionId);
    return { userId, sessionId, session };
  }

  app.post('/v1/sessions/:sessionId/terminals', async (request, reply) => {
    const { userId, sessionId, session } = await prepare(request);
    if ((session.executionMode ?? 'CLOUD') !== 'CLOUD') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '仅云端任务支持远程终端');
    }
    if (session.workspace == null || session.workspace.trim() === '') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '任务工作区不可用');
    }
    const body = bodyOf<CreateTerminalRequest>(request);
    const username = (await deps.userLookup?.findById(userId))?.username ?? null;
    try {
      const terminal = await terminalManager.create({
        sessionId,
        userId,
        workspace: session.workspace,
        taskName: session.title,
        cols: body.cols ?? null,
        rows: body.rows ?? null,
        ip: resolveIp(request.headers as Record<string, string | string[] | undefined>, request.ip),
        username,
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
    const { sessionId } = await prepare(request);
    return sendOk(reply, terminalManager.list(sessionId));
  });

  app.delete('/v1/sessions/:sessionId/terminals/:terminalId', async (request, reply) => {
    const { userId, sessionId } = await prepare(request);
    const terminalId = pathParam(request, 'terminalId');
    const terminal = terminalManager.get(terminalId);
    // 已不存在视为已关闭（幂等）：归属由 prepare() 的 session owner 校验兜住，
    // 无法删除他人终端（活着的终端走下面的 sessionId/userId 双重校验）
    if (terminal == null) {
      return sendOk(reply, null);
    }
    if (terminal.sessionId !== sessionId || terminal.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权操作该终端');
    }
    terminalManager.close(terminalId, {
      ip: resolveIp(request.headers as Record<string, string | string[] | undefined>, request.ip),
      username: (await deps.userLookup?.findById(userId))?.username ?? null,
    });
    return sendOk(reply, null);
  });
}
