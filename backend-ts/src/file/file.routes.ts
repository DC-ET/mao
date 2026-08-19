import { createReadStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { lookup as mimeLookup } from 'mime-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/multipart';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryOptInt, queryOptStr } from '../common/request.js';
import { fail } from '../common/result.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import type { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import type { Session } from '../session/types.js';
import type { SessionService } from '../session/session.service.js';
import type { FileEntity, FileService } from './file.service.js';
import type { WorkspaceBrowseService } from './workspace-browse.service.js';
import type { WorkspaceGitService } from './workspace-git.service.js';
import type { GitCommitMessageService } from './git-commit-message.service.js';
import type { GitWriteOperationService, LocalGitActivity } from './git-write-operation.service.js';

export interface FileRouteDeps {
  fileService: FileService;
  sessionService: Pick<SessionService, 'getSession'>;
  workspaceBrowseService: WorkspaceBrowseService;
  workspaceGitService: WorkspaceGitService;
  gitCommitMessageService: GitCommitMessageService;
  gitWriteOperationService: GitWriteOperationService;
  pathSandbox: PathSandbox;
  uploadBaseUrl?: string | null;
  runtimeDataResolver?: RuntimeDataResolver;
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const {
    fileService, sessionService, workspaceBrowseService, workspaceGitService,
    gitCommitMessageService, gitWriteOperationService, pathSandbox,
  } = deps;

  async function requireOwnedSession(userId: number, sessionId: number): Promise<Session> {
    const session = await sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权访问该会话');
    }
    if (session.workspace == null || session.workspace.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '会话未配置工作区');
    }
    return session;
  }

  function toVO(file: FileEntity) {
    const baseUrl = deps.uploadBaseUrl;
    const isIncoming = file.filePath != null && file.filePath.indexOf(`${sep}incoming${sep}`) >= 0;
    // incoming 文件位于 runtime 目录而非静态 uploads 目录，静态 url 不可达，改用下载端点
    const url = isIncoming
      ? `/v1/files/${file.id}/download`
      : (baseUrl != null && baseUrl.length > 0
        ? `${baseUrl}/uploads/${file.storedName}`
        : `/uploads/${file.storedName}`);
    return {
      id: file.id,
      originalName: file.originalName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      sessionId: file.sessionId,
      createdAt: javaLocalDateTimeString(file.createdAt),
      url,
    };
  }

  app.post('/v1/files/upload-incoming', async (request, reply) => {
    const userId = requireUserId(request);
    const { file, sessionId } = await readUpload(request);
    if (sessionId == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '缺少必要参数: sessionId');
    }
    const session = await sessionService.getSession(sessionId);
    if (session.userId !== userId) {
      throw new BusinessException(ErrorCode.FORBIDDEN, '无权访问该会话');
    }
    if (session.executionMode === 'LOCAL') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '本地模式不支持服务端文件上传');
    }
    const runtimeResolver = deps.runtimeDataResolver;
    if (runtimeResolver == null) {
      throw new BusinessException(5000, 'runtime 文件服务不可用');
    }
    const incomingDir = runtimeResolver.resolveIncomingDir(userId, sessionId);
    const entity = await fileService.uploadIncomingFile(
      file.buffer, file.filename, file.mimetype, userId, sessionId, incomingDir,
    );
    const absPath = resolve(incomingDir, entity.storedName);
    return sendOk(reply, { ...toVO(entity), absolutePath: absPath });
  });

  app.post('/v1/files/upload', async (request, reply) => {
    const userId = requireUserId(request);
    const { file, sessionId } = await readUpload(request);
    const entity = await fileService.uploadFile(file.buffer, file.filename, file.mimetype, userId, sessionId);
    return sendOk(reply, toVO(entity));
  });

  app.get('/v1/files/workspace-list', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = requireQueryLong(request, 'sessionId');
    const session = await requireOwnedSession(userId, sessionId);
    const files = fileService.listWorkspaceFiles(
      session.workspace!, queryOptStr(request, 'filter'), queryOptInt(request, 'limit') ?? 20,
    );
    return sendOk(reply, { files });
  });

  app.get('/v1/files/workspace-directory', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    return sendOk(reply, workspaceBrowseService.listDirectory(session.workspace!, queryOptStr(request, 'dir')));
  });

  app.get('/v1/files/workspace-read', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    return sendOk(reply, await workspaceBrowseService.readFile(
      session.workspace!, path, queryOptInt(request, 'offset') ?? 0, queryOptInt(request, 'limit') ?? 5000,
    ));
  });

  app.get('/v1/files/workspace-download', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const result = workspaceBrowseService.downloadFile(session.workspace!, path);
    const mediaType = mimeLookup(result.path) || 'application/octet-stream';
    return sendFile(reply, result.path, result.fileName, mediaType, result.size, 'attachment');
  });

  app.get('/v1/files/workspace-preview', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const result = workspaceBrowseService.readPdfFile(session.workspace!, path);
    return sendFile(reply, result.path, result.fileName, 'application/pdf', result.size, 'inline');
  });

  app.get('/v1/files/workspace-download-zip', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const result = await workspaceBrowseService.zipDirectory(session.workspace!, path);
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

  app.get('/v1/files/workspace-git-repos', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    return sendOk(reply, await workspaceGitService.listRepos(session.workspace!));
  });

  app.get('/v1/files/workspace-git-status', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    return sendOk(reply, await workspaceGitService.getStatus(session.workspace!, queryOptStr(request, 'repoPath')));
  });

  app.get('/v1/files/workspace-git-diff', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    return sendOk(reply, await workspaceGitService.getFileDiff(session.workspace!, queryOptStr(request, 'repoPath'), path));
  });

  app.post('/v1/files/workspace-git-refresh', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.refreshRemoteStatus(session, body.repoPath));
  });

  app.post('/v1/files/workspace-git-commit', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.commit(session, body.repoPath));
  });

  app.post('/v1/files/workspace-git-pull', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.pull(session, body.repoPath));
  });

  app.post('/v1/files/workspace-git-push', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.push(session, body.repoPath));
  });

  app.post('/v1/files/git-commit-message', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; changes?: Parameters<GitCommitMessageService['generate']>[1] }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    return sendOk(reply, await gitCommitMessageService.generate(session, body.changes!));
  });

  app.post('/v1/files/workspace-git-activity', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; result?: LocalGitActivity }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    await gitWriteOperationService.recordLocalActivity(session, body.result ?? null);
    return sendOk(reply);
  });

  app.get('/v1/files/project-list', async (request, reply) => {
    const userId = requireUserId(request);
    const projectKey = queryOptStr(request, 'projectKey');
    if (projectKey == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const userRoot = resolve(pathSandbox.getWorkspaceRoot(), String(userId));
    const projectPath = resolve(userRoot, 'projects', projectKey);
    if (!projectPath.startsWith(userRoot)) {
      return sendJson(reply, 200, fail(403, '无权访问该项目'));
    }
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      return sendOk(reply, { files: [] });
    }
    const files = fileService.listWorkspaceFiles(
      projectPath, queryOptStr(request, 'filter'), queryOptInt(request, 'limit') ?? 20,
    );
    return sendOk(reply, { files });
  });

  app.get('/v1/files', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = queryOptInt(request, 'sessionId') ?? null;
    const files = await fileService.listFiles(userId, sessionId);
    return sendOk(reply, files.map(toVO));
  });

  app.get('/v1/files/:id/download', async (request, reply) => {
    const userId = requireUserId(request);
    const file = await fileService.getFile(pathId(request));
    if (file == null) {
      return reply.status(404).send();
    }
    requireFileOwner(file, userId);
    const filePath = await fileService.getFilePath(file.id!);
    return sendFile(reply, filePath, file.originalName, file.mimeType ?? 'application/octet-stream', file.fileSize, 'attachment');
  });

  app.get('/v1/files/:id/preview', async (request, reply) => {
    const userId = requireUserId(request);
    const file = await fileService.getFile(pathId(request));
    if (file == null) {
      return reply.status(404).send();
    }
    requireFileOwner(file, userId);
    const filePath = await fileService.getFilePath(file.id!);
    return sendFile(reply, filePath, file.originalName, file.mimeType ?? 'application/octet-stream', file.fileSize, 'inline');
  });

  app.delete('/v1/files/:id', async (request, reply) => {
    const userId = requireUserId(request);
    const file = await fileService.getFile(pathId(request));
    if (file != null) {
      requireFileOwner(file, userId);
    }
    await fileService.deleteFile(pathId(request));
    return sendOk(reply);
  });
}

/** 校验文件归属：仅允许上传者本人访问（下载/预览/删除）。 */
function requireFileOwner(file: FileEntity, userId: number): void {
  if (file.uploaderId != null && file.uploaderId !== userId) {
    throw new BusinessException(ErrorCode.FORBIDDEN, '无权访问该文件');
  }
}

function requireQueryLong(request: FastifyRequest, name: string): number {
  const n = Number((request.query as Record<string, unknown> | undefined)?.[name]);
  if (!Number.isFinite(n)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 无效`);
  }
  return n;
}

function contentDisposition(kind: 'attachment' | 'inline', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '\\"');
  const encoded = encodeURIComponent(fileName);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function sendFile(
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

async function readUpload(request: FastifyRequest): Promise<{
  file: { filename: string; buffer: Buffer; mimetype: string | null };
  sessionId: number | null;
}> {
  const parts = request.parts();
  let file: { filename: string; buffer: Buffer; mimetype: string | null } | null = null;
  let sessionId: number | null = null;
  for await (const part of parts) {
    if (part.type === 'file') {
      if (part.fieldname === 'file' || file == null) {
        file = {
          filename: part.filename,
          buffer: await part.toBuffer(),
          mimetype: part.mimetype ?? null,
        };
      } else {
        await part.toBuffer();
      }
    } else if (part.fieldname === 'sessionId' && part.value != null && String(part.value).length > 0) {
      const n = Number(part.value);
      sessionId = Number.isFinite(n) ? n : null;
    }
  }
  if (file == null) {
    throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
  }
  return { file, sessionId };
}
