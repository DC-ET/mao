import { createReadStream, unlinkSync } from 'node:fs';
import { lookup as mimeLookup } from 'mime-types';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { pathId, queryOptInt, queryOptStr } from '../common/request.js';
import { requireRequestPermission, sendOk } from '../common/http-error.js';
import { contentDisposition } from '../file/file.routes.js';
import type { Session } from './types.js';
import type { SessionService } from './session.service.js';
import type { WorkspaceBrowseService } from '../file/workspace-browse.service.js';

export interface AdminSessionFilesRouteDeps {
  sessionService: Pick<SessionService, 'getSession'>;
  workspaceBrowseService: WorkspaceBrowseService;
  permissionService: { hasPermission(userId: number, code: string): Promise<boolean> };
}

/**
 * 管理后台会话工作区只读文件端点（/v1/admin/sessions/:id/files/*）。
 *
 * 与用户侧 /v1/files/workspace-* 的差异只有一处：不做出属主校验（D1）——
 * admin 跨用户查看任意会话是本职，门槛由 session:read 权限码 + 全局审计钩子把守。
 * 会话工作区之外的一切路径仍由 WorkspaceBrowseService 的 StrictPathResolver 收口。
 */
export function registerAdminSessionFilesRoutes(app: FastifyInstance, deps: AdminSessionFilesRouteDeps): void {
  const { sessionService, workspaceBrowseService, permissionService } = deps;
  const requireRead = (request: Parameters<typeof requireRequestPermission>[1]) =>
    requireRequestPermission(permissionService, request, 'session:read');

  /** 会话存在、有工作区且为 CLOUD 才允许浏览；LOCAL 工作区在用户设备上，服务端不可见。 */
  async function requireBrowsableSession(sessionId: number): Promise<Session> {
    const session = await sessionService.getSession(sessionId);
    if (session.workspace == null || session.workspace.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '会话未配置工作区');
    }
    if (session.executionMode === 'LOCAL') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '本地执行会话的工作区在用户设备上，服务端不可浏览');
    }
    return session;
  }

  app.get('/v1/admin/sessions/:id/files/directory', async (request, reply) => {
    await requireRead(request);
    const session = await requireBrowsableSession(pathId(request));
    return sendOk(reply, workspaceBrowseService.listDirectory(session.workspace!, queryOptStr(request, 'dir')));
  });

  app.get('/v1/admin/sessions/:id/files/search', async (request, reply) => {
    await requireRead(request);
    const session = await requireBrowsableSession(pathId(request));
    const pattern = queryOptStr(request, 'pattern');
    if (pattern == null) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    if (pattern.length > 100) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索关键词过长');
    }
    return sendOk(reply, workspaceBrowseService.searchFiles(session.workspace!, pattern, queryOptInt(request, 'limit') ?? 100));
  });

  app.get('/v1/admin/sessions/:id/files/read', async (request, reply) => {
    await requireRead(request);
    const session = await requireBrowsableSession(pathId(request));
    const path = queryOptStr(request, 'path');
    if (path == null) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    return sendOk(reply, await workspaceBrowseService.readFile(
      session.workspace!, path, queryOptInt(request, 'offset') ?? 0, queryOptInt(request, 'limit') ?? 5000,
    ));
  });

  app.get('/v1/admin/sessions/:id/files/preview', async (request, reply) => {
    await requireRead(request);
    const session = await requireBrowsableSession(pathId(request));
    const path = queryOptStr(request, 'path');
    if (path == null) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const result = workspaceBrowseService.readPdfFile(session.workspace!, path);
    return sendFileStream(reply, result.path, result.fileName, 'application/pdf', result.size, 'inline');
  });

  app.get('/v1/admin/sessions/:id/files/download', async (request, reply) => {
    await requireRead(request);
    const session = await requireBrowsableSession(pathId(request));
    const path = queryOptStr(request, 'path');
    if (path == null) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const result = workspaceBrowseService.downloadFile(session.workspace!, path);
    const mediaType = mimeLookup(result.path) || 'application/octet-stream';
    return sendFileStream(reply, result.path, result.fileName, mediaType, result.size, 'attachment');
  });

  app.get('/v1/admin/sessions/:id/files/download-zip', async (request, reply) => {
    await requireRead(request);
    const session = await requireBrowsableSession(pathId(request));
    // path 缺省 = 整个工作区：zipDirectory 的 normalizeRelativeDir 将 null 归一为 '.'
    const result = await workspaceBrowseService.zipDirectory(session.workspace!, queryOptStr(request, 'path'));
    const stream = createReadStream(result.zipPath);
    const cleanup = () => {
      try { unlinkSync(result.zipPath); } catch (e) {
        console.warn(`Failed to delete temp zip after download: ${result.zipPath}`, e);
      }
    };
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    reply
      .header('Content-Disposition', contentDisposition('attachment', result.fileName))
      .type('application/zip')
      .header('Content-Length', String(result.size));
    return reply.send(stream);
  });
}

/** 与用户侧 file.routes.ts 同款的流式下发：Content-Disposition + 类型 + 长度 + 文件流。 */
function sendFileStream(
  reply: FastifyReply,
  filePath: string,
  fileName: string,
  contentType: string,
  size: number,
  kind: 'attachment' | 'inline',
): FastifyReply {
  reply
    .header('Content-Disposition', contentDisposition(kind, fileName))
    .type(contentType)
    .header('Content-Length', String(size));
  return reply.send(createReadStream(filePath));
}
