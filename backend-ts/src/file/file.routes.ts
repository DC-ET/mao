import { createReadStream, existsSync, statSync, unlinkSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { resolve, sep, isAbsolute, relative } from 'node:path';
import { lookup as mimeLookup } from 'mime-types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/multipart';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { requireUserId, sendJson, sendOk } from '../common/http-error.js';
import { bodyOf, pathId, queryOptInt, queryOptStr } from '../common/request.js';
import { fail } from '../common/result.js';
import { javaLocalDateTimeString } from '../common/datetime.js';
import { experienceDirForSession } from '../harness/experience/experience-mount-path.js';
import { isUnder, type PathSandbox } from '../harness/safety/path-sandbox.js';
import { CloudWorkspaceResolver } from '../harness/safety/cloud-workspace-resolver.js';
import type { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import type { Session } from '../session/types.js';
import type { SessionService } from '../session/session.service.js';
import type { FileEntity, FileService } from './file.service.js';
import type { SendFileEntity, SendFileDownloadTarget, SendFileService } from './send-file.service.js';
import type { SendDownloadTicketService } from './send-download-ticket.service.js';
import type { WorkspaceBrowseService } from './workspace-browse.service.js';
import type { WorkspaceGitService } from './workspace-git.service.js';
import type { GitCommitMessageService } from './git-commit-message.service.js';
import type { GitWriteOperationService, LocalGitActivity } from './git-write-operation.service.js';
import type { WorkspaceWriteService } from './workspace-write.service.js';
import type { WorkspaceOverviewService } from './workspace-overview.service.js';
import { hasImageFileExtension, type LocalFileFetchOutcome } from '../harness/local/local-file-fetch.service.js';
import type { RemoteFileOp, RemoteFileProxyService } from './remote-file-proxy.service.js';

export interface FileRouteDeps {
  fileService: FileService;
  sessionService: Pick<SessionService, 'getSession'>;
  workspaceBrowseService: WorkspaceBrowseService;
  workspaceGitService: WorkspaceGitService;
  gitCommitMessageService: GitCommitMessageService;
  gitWriteOperationService: GitWriteOperationService;
  workspaceWriteService: WorkspaceWriteService;
  workspaceOverviewService: WorkspaceOverviewService;
  /** LOCAL 正文图片按需委托读取（方案 2026-11-18）：workspace-download 的 LOCAL 分流走它，绝不直读服务器文件系统。 */
  localFileFetchService: {
    fetch(sessionId: number, userId: number, relativePath: string, workspace: string | null | undefined): Promise<LocalFileFetchOutcome>;
  };
  pathSandbox: PathSandbox;
  /** 发送附件快照（技术方案 2026-11-24 D3）：本地 / 云代读在实现里，路由只做鉴权与响应头。 */
  sendFileService: SendFileService;
  /** 快照下载的短时票据（2026-11-25 R6）：1GB 下载直接导航，不把 JWT 放进 URL。 */
  sendDownloadTickets: SendDownloadTicketService;
  /**
   * LOCAL 会话文件浏览的 WS 代理（技术方案 2026-11-17）：未注入时 LOCAL browse 直接报
   * 服务不可用，绝不回落 WorkspaceBrowseService——LOCAL 的 workspace 是设备上的绝对路径，
   * 服务端 FS 恰好存在同路径目录时会返回错误机器的数据。
   */
  remoteFileProxyService?: RemoteFileProxyService;
  getUploadBaseUrl?: () => Promise<string | null>;
  runtimeDataResolver?: RuntimeDataResolver;
  /** 当前会话 Agent 的经验库目录。不提供时「团队经验」仍按越界拒绝。 */
  experienceDirForAgent?: (agentId: number) => string;
}

export function registerFileRoutes(app: FastifyInstance, deps: FileRouteDeps): void {
  const {
    fileService, sessionService, workspaceBrowseService, workspaceGitService,
    gitCommitMessageService, gitWriteOperationService, workspaceWriteService, workspaceOverviewService,
    localFileFetchService, pathSandbox,
  } = deps;

  function requireCloudWorkspace(session: Session): string {
    if (session.executionMode === 'LOCAL') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '本地模式不支持服务端文件管理');
    }
    return session.workspace!;
  }

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

  function experienceDirOf(session: Session): string | undefined {
    return experienceDirForSession(session, deps.experienceDirForAgent);
  }

  /**
   * LOCAL 会话读类 browse 端点（list / read / search / files）经 WS 代理到绑定执行端设备。
   * 归一化（mtime→mtimeMs、补 workspaceRoot）收敛在 proxy service 单点。
   */
  async function browseViaProxy(session: Session, op: RemoteFileOp, params: Record<string, unknown>): Promise<unknown> {
    const proxy = deps.remoteFileProxyService;
    if (proxy == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '本地文件远程浏览服务不可用');
    }
    return proxy.execute(session, op, params);
  }

  /**
   * LOCAL 会话二进制类端点（preview / download / zip）的明确拒绝：必须非 2xx——
   * preview/download 前端走 fetch 且仅在 !resp.ok 时读错误 JSON，BusinessException 经
   * handleError 默认映射 HTTP 200 + code 信封会被 resp.ok 放行、把 JSON 当 blob 渲染失败
   * （技术方案 2026-11-17 §4.1）。
   */
  function rejectLocalBinaryBrowse(reply: FastifyReply, message: string): FastifyReply {
    return sendJson(reply, 400, fail(ErrorCode.PARAM_INVALID.code, message));
  }

  /**
   * 写操作的工作区：有 workspacePath 时落到总览「受管」目录（文件管理页签，
   * 含受管机器人通道工作区），否则落到会话工作区。两者都给时以 workspacePath 为准，
   * 避免页签写到当前会话。
   */
  async function requireWriteWorkspace(
    userId: number,
    sessionId: number | null | undefined,
    workspacePath: string | null | undefined,
  ): Promise<{ sessionId: number; workspace: string }> {
    if (workspacePath != null && workspacePath.trim().length > 0) {
      const resolved = await workspaceOverviewService.resolveManagedPath(userId, workspacePath);
      if ('error' in resolved) {
        throw new BusinessException(ErrorCode.PARAM_INVALID, resolved.message);
      }
      return { sessionId: 0, workspace: resolved.path };
    }
    if (sessionId == null || !Number.isFinite(sessionId)) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const session = await requireOwnedSession(userId, sessionId);
    return { sessionId: session.id!, workspace: requireCloudWorkspace(session) };
  }

  /**
   * 总览行打开的文件管理：root 必须是受管目录——本人根下的一级 / projects 子目录，
   * 或受管机器人通道工作区（本人私聊 / 参与过的群，技术方案 2026-11-02）。
   */
  async function resolveOwnedWorkspace(userId: number, raw: string | null | undefined): Promise<string> {
    if (raw == null || raw.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const resolved = await workspaceOverviewService.resolveManagedPath(userId, raw);
    if ('error' in resolved) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, resolved.message);
    }
    return resolved.path;
  }

  /**
   * 新增 Git 管理端点（log/commit/branches/stashes/remotes/fetch/switch/stash）的会话守卫：
   * 归属校验 + 拒绝 LOCAL 会话——LOCAL 走 Electron IPC provider，服务端拒绝只是防未来误调。
   * 注意既有 git 端点（status/commit/pull/push 等）没有这层防御，此处是新增的防御层。
   */
  async function requireOwnedCloudGitSession(userId: number, sessionId: number): Promise<Session> {
    const session = await requireOwnedSession(userId, sessionId);
    if (session.executionMode === 'LOCAL') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '本地模式不支持服务端 Git 管理');
    }
    return session;
  }

  async function toVO(file: FileEntity) {
    const baseUrl = deps.getUploadBaseUrl != null ? await deps.getUploadBaseUrl() : null;
    const isIncoming = file.filePath != null && file.filePath.indexOf(`${sep}incoming${sep}`) >= 0;
    // incoming 文件位于 runtime 目录而非静态 uploads 目录，静态 url 不可达，改用下载端点
    if (isIncoming) {
      return {
        id: file.id,
        originalName: file.originalName,
        fileSize: file.fileSize,
        mimeType: file.mimeType,
        sessionId: file.sessionId,
        createdAt: javaLocalDateTimeString(file.createdAt),
        url: `/v1/files/${file.id}/download`,
      };
    }
    // 2026-11-24 D7：新上传落 `{uploadDir}/{userId}/{uuid}.ext`，存量仍在根上。
    // URL 按 filePath 相对 uploadDir 拼出，两种形态都正确；仍保留 baseUrl 前缀
    // （upload.baseUrl 与 storageMode 无关，本地模式也可能配了它）。
    // 解析不出相对路径（理论上是库里的历史脏数据）时回落 storedName，与旧行为一致。
    const rel = uploadsRelativePath(file, fileService.getUploadDir());
    const urlPath = rel != null ? `/uploads/${rel}` : `/uploads/${file.storedName}`;
    return {
      id: file.id,
      originalName: file.originalName,
      fileSize: file.fileSize,
      mimeType: file.mimeType,
      sessionId: file.sessionId,
      createdAt: javaLocalDateTimeString(file.createdAt),
      url: baseUrl != null && baseUrl.length > 0 ? `${baseUrl}${urlPath}` : urlPath,
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
    return sendOk(reply, { ...(await toVO(entity)), absolutePath: absPath });
  });

  app.post('/v1/files/upload', async (request, reply) => {
    const userId = requireUserId(request);
    const { file, sessionId } = await readUpload(request);
    const entity = await fileService.uploadFile(file.buffer, file.filename, file.mimetype, userId, sessionId);
    return sendOk(reply, await toVO(entity));
  });

  app.get('/v1/files/workspace-list', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = requireQueryLong(request, 'sessionId');
    const session = await requireOwnedSession(userId, sessionId);
    if (session.executionMode === 'LOCAL') {
      // 移动端 @ 文件引用面板真实调用本端点（技术方案 2026-11-17 §1.2-#4）：
      // LOCAL 分流到执行端设备，杜绝读到服务端同路径的错误数据
      return sendOk(reply, await browseViaProxy(session, 'files', {
        filter: queryOptStr(request, 'filter'), limit: queryOptInt(request, 'limit') ?? 20,
      }));
    }
    const files = fileService.listWorkspaceFiles(
      requireCloudWorkspace(session), queryOptStr(request, 'filter'), queryOptInt(request, 'limit') ?? 20,
    );
    return sendOk(reply, { files });
  });

  app.get('/v1/files/workspace-directory', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    if (session.executionMode === 'LOCAL') {
      return sendOk(reply, await browseViaProxy(session, 'list', { dir: queryOptStr(request, 'dir') }));
    }
    return sendOk(reply, workspaceBrowseService.listDirectory(
      requireCloudWorkspace(session), queryOptStr(request, 'dir'), experienceDirOf(session),
    ));
  });

  app.get('/v1/files/workspace-search', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const pattern = queryOptStr(request, 'pattern');
    if (pattern == null || pattern.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    if (pattern.length > 100) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索关键词过长');
    }
    if (session.executionMode === 'LOCAL') {
      return sendOk(reply, await browseViaProxy(session, 'search', {
        pattern, limit: queryOptInt(request, 'limit') ?? 100,
      }));
    }
    return sendOk(reply, workspaceBrowseService.searchFiles(
      requireCloudWorkspace(session), pattern, queryOptInt(request, 'limit') ?? 100, experienceDirOf(session),
    ));
  });

  app.get('/v1/files/workspace-read', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    if (session.executionMode === 'LOCAL') {
      return sendOk(reply, await browseViaProxy(session, 'read', {
        path, offset: queryOptInt(request, 'offset') ?? 0, limit: queryOptInt(request, 'limit') ?? 5000,
      }));
    }
    return sendOk(reply, await workspaceBrowseService.readFile(
      requireCloudWorkspace(session), path, queryOptInt(request, 'offset') ?? 0, queryOptInt(request, 'limit') ?? 5000,
      experienceDirOf(session),
    ));
  });

  app.get('/v1/files/workspace-download', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    // LOCAL 分流（方案 2026-11-18）：按需委托绑定执行端读取工作区图片，服务端不落盘不存库。
    // LOCAL 会话的 workspace 服务端创建时不校验，直读服务器路径是一个目录读取缺口——
    // 本端点改走委托，读类端点由 2026-11-17 方案分流到设备代理、二进制类明确拒绝，缺口整族关闭。
    // 失败必须非 2xx（2026-11-17 §4.1）：前端 fetch 仅在 !resp.ok 时读错误 JSON；
    // 图片 <img> 对 400 同样触发 error 事件回退 📎 占位，两种消费方都成立。
    if (session.executionMode === 'LOCAL') {
      // 图片白名单外不进委托（双端同表口径）：zip / xlsx 等 readFileBytes 消费方拿到
      // 2026-11-17 的「暂不支持远程下载」而非「仅支持图片」，语义更准。
      if (!hasImageFileExtension(path)) {
        return rejectLocalBinaryBrowse(reply, '本地任务暂不支持远程下载文件，请在桌面客户端查看');
      }
      const outcome = await localFileFetchService.fetch(session.id!, userId, path, session.workspace);
      if (!outcome.ok) return rejectLocalBinaryBrowse(reply, outcome.error);
      return sendBuffer(reply, outcome.bytes, outcome.fileName, outcome.mime);
    }
    const result = workspaceBrowseService.downloadFile(session.workspace!, path, experienceDirOf(session));
    const mediaType = mimeLookup(result.path) || 'application/octet-stream';
    return sendFile(reply, result.path, result.fileName, mediaType, result.size, 'attachment');
  });

  app.get('/v1/files/workspace-preview', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    if (session.executionMode === 'LOCAL') {
      return rejectLocalBinaryBrowse(reply, '本地任务暂不支持远程预览文件，请在桌面客户端查看');
    }
    const result = workspaceBrowseService.readPdfFile(session.workspace!, path, experienceDirOf(session));
    return sendFile(reply, result.path, result.fileName, 'application/pdf', result.size, 'inline');
  });

  app.get('/v1/files/workspace-download-zip', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedSession(userId, requireQueryLong(request, 'sessionId'));
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    if (session.executionMode === 'LOCAL') {
      // 设备端无 zip 原语（list-directory 只逐条列举），明确拒绝（§2.2）
      return rejectLocalBinaryBrowse(reply, '本地任务暂不支持远程打包下载，请在桌面客户端查看');
    }
    const result = await workspaceBrowseService.zipDirectory(session.workspace!, path, experienceDirOf(session));
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

  app.post('/v1/files/workspace-download-multi-zip', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; paths?: string[] }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    if (!Array.isArray(body.paths)) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    if (session.executionMode === 'LOCAL') {
      return rejectLocalBinaryBrowse(reply, '本地任务暂不支持远程打包下载，请在桌面客户端查看');
    }
    const result = await workspaceBrowseService.zipEntries(session.workspace!, body.paths, experienceDirOf(session));
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
    const body = bodyOf<{ sessionId?: number; repoPath?: string; message?: string }>(request);
    const session = await requireOwnedSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.commit(session, body.repoPath, body.message));
  });

  // 两步提交（中央 Tab）第一步：只生成提交信息。CLOUD 专用——LOCAL 走 Electron 侧组装 + /files/git-commit-message
  app.post('/v1/files/workspace-git-commit-message', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string }>(request);
    const session = await requireOwnedCloudGitSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.generateCommitMessage(session, body.repoPath));
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

  app.get('/v1/files/workspace-git-log', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    return sendOk(reply, await workspaceGitService.getLog(session.workspace!, queryOptStr(request, 'repoPath'), {
      limit: queryOptInt(request, 'limit'),
      offset: queryOptInt(request, 'offset'),
      path: queryOptStr(request, 'path'),
      keyword: queryOptStr(request, 'keyword'),
      allBranches: ['true', '1'].includes(queryOptStr(request, 'allBranches') ?? ''),
    }));
  });

  app.get('/v1/files/workspace-git-commit', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    const hash = queryOptStr(request, 'hash');
    if (hash == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    return sendOk(reply, await workspaceGitService.getCommitFiles(session.workspace!, queryOptStr(request, 'repoPath'), hash));
  });

  app.get('/v1/files/workspace-git-commit-file-diff', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    const hash = queryOptStr(request, 'hash');
    if (hash == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    return sendOk(reply, await workspaceGitService.getCommitFileDiff(session.workspace!, queryOptStr(request, 'repoPath'), hash, path, queryOptStr(request, 'oldPath')));
  });

  app.get('/v1/files/workspace-git-branches', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    return sendOk(reply, await workspaceGitService.getBranches(session.workspace!, queryOptStr(request, 'repoPath')));
  });

  app.get('/v1/files/workspace-git-stashes', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    return sendOk(reply, await workspaceGitService.getStashes(session.workspace!, queryOptStr(request, 'repoPath')));
  });

  app.get('/v1/files/workspace-git-remotes', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    return sendOk(reply, await workspaceGitService.getRemotes(session.workspace!, queryOptStr(request, 'repoPath')));
  });

  app.get('/v1/files/workspace-git-branch-compare', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    const base = queryOptStr(request, 'base');
    if (base == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const target = queryOptStr(request, 'target');
    if (target == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    return sendOk(reply, await workspaceGitService.compareBranches(session.workspace!, queryOptStr(request, 'repoPath'), base, target));
  });

  app.get('/v1/files/workspace-git-branch-compare-file-diff', async (request, reply) => {
    const userId = requireUserId(request);
    const session = await requireOwnedCloudGitSession(userId, requireQueryLong(request, 'sessionId'));
    const base = queryOptStr(request, 'base');
    if (base == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const target = queryOptStr(request, 'target');
    if (target == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    return sendOk(reply, await workspaceGitService.compareBranchFileDiff(
      session.workspace!, queryOptStr(request, 'repoPath'), base, target, path, queryOptStr(request, 'oldPath'),
    ));
  });

  app.post('/v1/files/workspace-git-fetch', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string }>(request);
    const session = await requireOwnedCloudGitSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.fetchRemote(session, body.repoPath));
  });

  app.post('/v1/files/workspace-git-switch-branch', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string; branch?: string; create?: boolean }>(request);
    const session = await requireOwnedCloudGitSession(userId, body.sessionId!);
    if (body.branch == null || body.branch.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    return sendOk(reply, await gitWriteOperationService.switchBranch(session, body.repoPath, body.branch, body.create === true));
  });

  app.post('/v1/files/workspace-git-stash', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string; action?: string; ref?: string }>(request);
    const session = await requireOwnedCloudGitSession(userId, body.sessionId!);
    if (body.action == null || body.ref == null) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    return sendOk(reply, await gitWriteOperationService.stashOp(session, body.repoPath, body.action, body.ref));
  });

  // 撤销未提交改动：paths 省略 / null = 全部（须带 expectedDigest），数组 = 只撤这些文件
  app.post('/v1/files/workspace-git-discard', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; repoPath?: string; paths?: unknown; expectedDigest?: unknown }>(request);
    const session = await requireOwnedCloudGitSession(userId, body.sessionId!);
    return sendOk(reply, await gitWriteOperationService.discard(session, body.repoPath, body.paths ?? null, body.expectedDigest));
  });

  app.post('/v1/files/workspace-mkdir', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; workspacePath?: string; path?: string; force?: boolean }>(request);
    const target = await requireWriteWorkspace(userId, body.sessionId, body.workspacePath);
    const data = await workspaceWriteService.mkdir(target.sessionId, target.workspace, body.path ?? '', { force: body.force });
    return sendOk(reply, data);
  });

  app.post('/v1/files/workspace-write', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; workspacePath?: string; path?: string; content?: string; overwrite?: boolean; force?: boolean }>(request);
    const target = await requireWriteWorkspace(userId, body.sessionId, body.workspacePath);
    const data = await workspaceWriteService.write(
      target.sessionId, target.workspace, body.path ?? '', body.content, { overwrite: body.overwrite, force: body.force },
    );
    return sendOk(reply, data);
  });

  app.post('/v1/files/workspace-rename', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; workspacePath?: string; path?: string; newName?: string; force?: boolean }>(request);
    const target = await requireWriteWorkspace(userId, body.sessionId, body.workspacePath);
    const data = await workspaceWriteService.rename(
      target.sessionId, target.workspace, body.path ?? '', body.newName ?? '', { force: body.force },
    );
    return sendOk(reply, data);
  });

  app.post('/v1/files/workspace-move', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; workspacePath?: string; from?: string; to?: string; force?: boolean }>(request);
    const target = await requireWriteWorkspace(userId, body.sessionId, body.workspacePath);
    const data = await workspaceWriteService.move(
      target.sessionId, target.workspace, body.from ?? '', body.to ?? '', { force: body.force },
    );
    return sendOk(reply, data);
  });

  app.delete('/v1/files/workspace-delete', async (request, reply) => {
    const userId = requireUserId(request);
    const workspacePath = queryOptStr(request, 'workspacePath');
    const sessionId = workspacePath ? null : requireQueryLong(request, 'sessionId');
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const target = await requireWriteWorkspace(userId, sessionId, workspacePath);
    const force = queryOptStr(request, 'force') === 'true';
    const data = await workspaceWriteService.delete(target.sessionId, target.workspace, path, { force });
    return sendOk(reply, data);
  });

  // ─── 工作区总览与生命周期（技术方案 2026-10-29）：登录态即可，无会话上下文 ───

  app.get('/v1/files/workspace-overview', async (request, reply) => {
    const userId = requireUserId(request);
    const { entries, error } = await workspaceOverviewService.listOverview(userId);
    return sendOk(reply, { entries, error });
  });

  // 删除确认弹层取活跃引用清单（D4③：失败信封无 data 字段，409 无法携带结构化清单，
  // 故清单由弹层打开时预先拉取）。受管口径校验：群工作区删不掉（DELETE 侧 shared 拒绝），
  // 但其引用清单仍可按参与关系查看
  app.get('/v1/files/workspace-overview/references', async (request, reply) => {
    const userId = requireUserId(request);
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const resolved = await workspaceOverviewService.resolveManagedPath(userId, path);
    if ('error' in resolved) {
      sendJson(reply, 200, fail(400, resolved.message));
      return;
    }
    const references = await workspaceOverviewService.listActiveReferences(userId, resolved.path);
    return sendOk(reply, references);
  });

  app.post('/v1/files/workspace-overview/refresh', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ path?: string | null }>(request);
    await workspaceOverviewService.refresh(userId, body.path ?? null);
    return sendOk(reply);
  });

  app.delete('/v1/files/workspace-overview', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ path?: string | null }>(request);
    if (body.path == null || body.path.length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const resolved = workspaceOverviewService.resolveDeletablePath(userId, body.path);
    if ('error' in resolved) {
      sendJson(reply, 200, fail(400, resolved.message));
      return;
    }
    // 活跃相位会话引用拒绝删除（D4③）；清单已由弹层展示，这里只带原因
    const references = await workspaceOverviewService.listActiveReferences(userId, resolved.path);
    if (references.length > 0) {
      sendJson(reply, 200, fail(409, '存在进行中的会话引用，无法删除'));
      return;
    }
    await workspaceOverviewService.deleteWorkspace(userId, resolved.path);
    return sendOk(reply);
  });

  app.post('/v1/files/workspace-copy', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ sessionId?: number; workspacePath?: string; from?: string; to?: string; overwrite?: boolean; force?: boolean }>(request);
    const target = await requireWriteWorkspace(userId, body.sessionId, body.workspacePath);
    const data = await workspaceWriteService.copy(
      target.sessionId, target.workspace, body.from ?? '', body.to ?? '', { overwrite: body.overwrite, force: body.force },
    );
    return sendOk(reply, data);
  });

  app.post('/v1/files/workspace-upload', async (request, reply) => {
    const userId = requireUserId(request);
    const upload = await readWorkspaceUpload(request);
    const target = await requireWriteWorkspace(userId, upload.sessionId, upload.workspacePath);
    const data = await workspaceWriteService.upload(
      target.sessionId, target.workspace, upload.dir, upload.files, { overwrite: upload.overwrite, force: upload.force },
    );
    return sendOk(reply, data);
  });

  app.get('/v1/files/project-list', async (request, reply) => {
    const userId = requireUserId(request);
    const projectKey = queryOptStr(request, 'projectKey');
    if (projectKey == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const slug = CloudWorkspaceResolver.normalizeAndValidate(projectKey);
    const userRoot = resolve(pathSandbox.getWorkspaceRoot(), String(userId));
    const projectPath = resolve(userRoot, 'projects', slug);
    if (!isUnder(projectPath, userRoot)) {
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

  /**
   * 新建态（会话未创建）按 projectKey 解析当前用户的云端项目工作区。
   * 与 project-list 同一套口径：slug 合法性 + 用户根钳制，userId 只信 token。
   */
  function resolveUserProjectWorkspace(userId: number, projectKey: string | null | undefined): string {
    if (projectKey == null) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const slug = CloudWorkspaceResolver.normalizeAndValidate(projectKey);
    return CloudWorkspaceResolver.resolveProjectWorkspace(pathSandbox, userId, slug);
  }

  /** 项目目录尚不存在（新项目名 / 临时区）时按空内容处理，与 project-list 空目录口径一致 */
  function isExistingDirectory(path: string): boolean {
    return existsSync(path) && statSync(path).isDirectory();
  }

  app.get('/v1/files/project-directory', async (request, reply) => {
    const userId = requireUserId(request);
    const projectPath = resolveUserProjectWorkspace(userId, queryOptStr(request, 'projectKey'));
    if (!isExistingDirectory(projectPath)) {
      return sendOk(reply, { entries: [], truncated: false });
    }
    return sendOk(reply, workspaceBrowseService.listDirectory(projectPath, queryOptStr(request, 'dir')));
  });

  app.get('/v1/files/project-read', async (request, reply) => {
    const userId = requireUserId(request);
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const projectPath = resolveUserProjectWorkspace(userId, queryOptStr(request, 'projectKey'));
    return sendOk(reply, await workspaceBrowseService.readFile(
      projectPath, path, queryOptInt(request, 'offset') ?? 0, queryOptInt(request, 'limit') ?? 5000,
    ));
  });

  app.get('/v1/files/project-search', async (request, reply) => {
    const userId = requireUserId(request);
    const pattern = queryOptStr(request, 'pattern');
    if (pattern == null || pattern.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    if (pattern.length > 100) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索关键词过长');
    }
    const projectPath = resolveUserProjectWorkspace(userId, queryOptStr(request, 'projectKey'));
    if (!isExistingDirectory(projectPath)) {
      return sendOk(reply, { entries: [], truncated: false });
    }
    return sendOk(reply, workspaceBrowseService.searchFiles(projectPath, pattern, queryOptInt(request, 'limit') ?? 100));
  });

  app.get('/v1/files/project-preview', async (request, reply) => {
    const userId = requireUserId(request);
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const projectPath = resolveUserProjectWorkspace(userId, queryOptStr(request, 'projectKey'));
    const result = workspaceBrowseService.readPdfFile(projectPath, path);
    return sendFile(reply, result.path, result.fileName, 'application/pdf', result.size, 'inline');
  });

  // 工作区总览「文件管理」：按本人根下的目录浏览，不依赖当前会话。
  app.get('/v1/files/owned-directory', async (request, reply) => {
    const userId = requireUserId(request);
    const root = await resolveOwnedWorkspace(userId, queryOptStr(request, 'root'));
    return sendOk(reply, workspaceBrowseService.listDirectory(root, queryOptStr(request, 'dir')));
  });

  app.get('/v1/files/owned-read', async (request, reply) => {
    const userId = requireUserId(request);
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const root = await resolveOwnedWorkspace(userId, queryOptStr(request, 'root'));
    return sendOk(reply, await workspaceBrowseService.readFile(
      root, path, queryOptInt(request, 'offset') ?? 0, queryOptInt(request, 'limit') ?? 5000,
    ));
  });

  app.get('/v1/files/owned-search', async (request, reply) => {
    const userId = requireUserId(request);
    const pattern = queryOptStr(request, 'pattern');
    if (pattern == null || pattern.trim().length === 0) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    if (pattern.length > 100) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '搜索关键词过长');
    }
    const root = await resolveOwnedWorkspace(userId, queryOptStr(request, 'root'));
    return sendOk(reply, workspaceBrowseService.searchFiles(root, pattern, queryOptInt(request, 'limit') ?? 100));
  });

  app.get('/v1/files/owned-download', async (request, reply) => {
    const userId = requireUserId(request);
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const root = await resolveOwnedWorkspace(userId, queryOptStr(request, 'root'));
    const result = workspaceBrowseService.downloadFile(root, path);
    const mediaType = mimeLookup(result.path) || 'application/octet-stream';
    return sendFile(reply, result.path, result.fileName, mediaType, result.size, 'attachment');
  });

  app.get('/v1/files/owned-preview', async (request, reply) => {
    const userId = requireUserId(request);
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const root = await resolveOwnedWorkspace(userId, queryOptStr(request, 'root'));
    const result = workspaceBrowseService.readPdfFile(root, path);
    return sendFile(reply, result.path, result.fileName, 'application/pdf', result.size, 'inline');
  });

  app.get('/v1/files/owned-download-zip', async (request, reply) => {
    const userId = requireUserId(request);
    const path = queryOptStr(request, 'path');
    if (path == null) throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    const root = await resolveOwnedWorkspace(userId, queryOptStr(request, 'root'));
    const result = await workspaceBrowseService.zipDirectory(root, path);
    const stream = createReadStream(result.zipPath);
    const cleanup = () => {
      try { unlinkSync(result.zipPath); } catch { /* 临时 zip 已不在 */ }
    };
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    reply
      .header('Content-Disposition', contentDisposition('attachment', result.fileName))
      .type('application/zip')
      .header('Content-Length', String(result.size));
    return reply.send(stream);
  });

  app.post('/v1/files/owned-download-multi-zip', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf<{ root?: string; paths?: string[] }>(request);
    const root = await resolveOwnedWorkspace(userId, body.root);
    if (!Array.isArray(body.paths)) {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
    }
    const result = await workspaceBrowseService.zipEntries(root, body.paths);
    const stream = createReadStream(result.zipPath);
    const cleanup = () => {
      try { unlinkSync(result.zipPath); } catch { /* 临时 zip 已不在 */ }
    };
    stream.on('close', cleanup);
    stream.on('error', cleanup);
    reply
      .header('Content-Disposition', contentDisposition('attachment', result.fileName))
      .type('application/zip')
      .header('Content-Length', String(result.size));
    return reply.send(stream);
  });

  app.get('/v1/files', async (request, reply) => {
    const userId = requireUserId(request);
    const sessionId = queryOptInt(request, 'sessionId') ?? null;
    const files = await fileService.listFiles(userId, sessionId);
    return sendOk(reply, await Promise.all(files.map((f) => toVO(f))));
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

  /**
   * 发送快照下载票据（技术方案 2026-11-25-send-file-1gb R6）：
   * 属主鉴权后签发绑定 `文件 id + userId` 的无状态 HMAC 票据，有效期 12 小时
   * （Range 续传会重用同一个 URL，短票据续传必失败）。不入库、不落盘。
   */
  app.post('/v1/files/send-download-ticket', async (request, reply) => {
    const userId = requireUserId(request);
    const body = bodyOf(request) as { id?: unknown } | null;
    const id = typeof body?.id === 'string' ? body.id.trim() : '';
    if (id === '') {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数: id');
    }
    const row = await deps.sendFileService.findById(id);
    if (row == null || !(await canReadSendFile(row, userId, sessionService))) {
      return sendJson(reply, 404, fail(ErrorCode.PARAM_INVALID.code, '附件不存在'));
    }
    const issued = deps.sendDownloadTickets.issue(id, userId);
    return sendOk(reply, { ticket: issued.ticket, expiresAt: issued.expiresAt });
  });

  /**
   * 发送附件快照下载（技术方案 2026-11-24-send-file-snapshot D3/D5；2026-11-25 R6/R7）。
   *
   * 消息里只记快照 id，不记磁盘路径、不记云厂商 URL、不记 token；本地读 sendDir，
   * 云模式由服务端签 GET 后代读，浏览器不接触云地址。
   *
   * 鉴权二选一：`ticket`（短时票据，绑定文件 + 用户）或既有 JWT
   * （`Authorization` 头或 query `token`，`<img>` 带不了请求头；query 通道的
   * `mao_` API Token 由 jwt-hook 统一拒绝）。票据无效时回落 JWT 口径。
   *
   * 授权口径：属主本人，**或**发送时所在会话的归属人（二轮评审 §9.3 口径 A）——
   * 群聊里非归属成员发言时运行身份是发言者，少了后半条会话归属人自己会打不开。
   * 不设「仅会话归属人」：会话删除后附件仍属于属主本人，授权自动退回仅属主。
   * 行不存在与不属于你一律 404，不区分。
   *
   * `Range`（R7）：1GB 原生下载断线后可续传。本地 `createReadStream({start,end})`
   * 回 206；云把 Range 透传预签名 GET，原样转发 206 / Content-Range。
   */
  app.get('/v1/files/send-download', async (request, reply) => {
    const id = queryOptStr(request, 'id')?.trim();
    if (id == null || id === '') {
      throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数: id');
    }
    const ticket = queryOptStr(request, 'ticket')?.trim() ?? '';
    const claims = ticket !== '' ? deps.sendDownloadTickets.verify(ticket) : null;
    const userId = claims != null && claims.fileId === id ? claims.userId : requireUserId(request);
    const row = await deps.sendFileService.findById(id);
    if (row == null || !(await canReadSendFile(row, userId, sessionService))) {
      return reply.status(404).send();
    }
    const rangeHeader = normalizeRangeHeader(request.headers.range);
    const target = await deps.sendFileService.openDownload(row, rangeHeader);
    if (!target.ok) {
      // 云代读的 416 要按协议回 416：映射成 404 会让下载器判定文件不存在、续传无法重启
      if (target.status === 416) {
        return reply
          .status(416)
          .header('Content-Range', target.contentRange ?? `bytes */${row.bytes}`)
          .header('Accept-Ranges', 'bytes')
          .send();
      }
      return sendJson(reply, 404, fail(ErrorCode.PARAM_INVALID.code, target.error));
    }
    // 图片 inline 供卡片与灯箱直接显示；其余一律 attachment。`.bin` 的 mime 是
    // octet-stream，天然落在 attachment 分支，不做内联。
    const kind = SEND_FILE_INLINE_MIMES.has(row.mime) ? 'inline' : 'attachment';
    reply
      .header('Content-Disposition', contentDisposition(kind, row.filename))
      .type(row.mime)
      .header('X-Content-Type-Options', 'nosniff')
      // 快照不可变；private 是因为内容是属主鉴权数据，不得进共享缓存
      .header('Cache-Control', 'private, max-age=604800, immutable')
      .header('Accept-Ranges', 'bytes');
    if ('localPath' in target) {
      if (rangeHeader != null) {
        const range = parseByteRange(rangeHeader, target.size);
        if (range === 'invalid') {
          return reply
            .status(416)
            .header('Content-Range', `bytes */${target.size}`)
            .send();
        }
        if (range != null) {
          return reply
            .status(206)
            .header('Content-Range', `bytes ${range.start}-${range.end}/${target.size}`)
            .header('Content-Length', String(range.end - range.start + 1))
            .send(createReadStream(target.localPath, { start: range.start, end: range.end }));
        }
      }
      reply.header('Content-Length', String(target.size));
      return reply.send(createReadStream(target.localPath));
    }
    const cloud = target as Exclude<SendFileDownloadTarget, { ok: false } | { localPath: string }>;
    if (cloud.status === 206) reply.status(206);
    if (cloud.contentRange != null) reply.header('Content-Range', cloud.contentRange);
    if (cloud.size != null) reply.header('Content-Length', String(cloud.size));
    return reply.send(cloud.stream);
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

/** 快照下载允许 inline 的 mime：与落盘时的字节嗅探同表（send_file.mime 就是嗅探结果）。 */
const SEND_FILE_INLINE_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']);

/**
 * Range 头收口（R7）：只支持单段，且必须是规范形态。
 * - 多段（`bytes=0-99,200-299`）忽略并回整份 200：云代读会返回 multipart/byteranges，
 *   而路由按文件 mime 覆写 Content-Type 且不带 boundary，客户端拿到的是坏文件；
 *   本地分支同样忽略多段，两边口径一致。
 * - 畸形单段（`bytes=abc`）同样忽略：原样透传给云可能被上游判 400，最后被映射成 404。
 */
function normalizeRangeHeader(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!/^bytes=\d*-\d*$/.test(value) || value === 'bytes=-') return null;
  return value;
}

/**
 * 单段 `Range` 解析（R7）：只认 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`。
 * 返回 null = 头不可解析（按整份响应，RFC 允许忽略）；'invalid' = 范围越界（回 416）。
 * 多段 Range 不支持：快照下载是单文件直传，多段（multipart/byteranges）没有浏览器场景。
 */
function parseByteRange(header: string, size: number): { start: number; end: number } | 'invalid' | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (match == null) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;
  if (size <= 0) return 'invalid';
  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  if (!Number.isSafeInteger(start) || start >= size) return 'invalid';
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (!Number.isSafeInteger(end) || end < start) return 'invalid';
  return { start, end };
}

/**
 * `file_path` 相对上传根目录的 POSIX 相对路径（2026-11-24 D7）：新上传是
 * `{userId}/{uuid}.ext`，存量根目录文件是 `{uuid}.ext`，两种都靠这一段拼 URL。
 * 跑出上传根（跨根脏数据）或为空时返回 null，由调用方回落 `storedName` 旧口径。
 */
function uploadsRelativePath(file: FileEntity, uploadDir: string): string | null {
  if (file.filePath == null || file.filePath === '') return null;
  const rel = relative(resolve(uploadDir), resolve(file.filePath));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return rel.split(sep).join('/');
}

/**
 * 快照下载授权（二轮评审 §9.3 口径 A）：属主本人，或发送时所在会话的归属人。
 * 会话不存在 / 查询异常一律按不满足处理（回落仅属主），不把内部错误暴露成 500。
 */
async function canReadSendFile(
  row: SendFileEntity,
  userId: number,
  sessionService: Pick<SessionService, 'getSession'>,
): Promise<boolean> {
  if (row.userId === userId) return true;
  if (row.sessionId == null) return false;
  try {
    const session = await sessionService.getSession(row.sessionId);
    return session != null && session.userId === userId;
  } catch {
    return false;
  }
}

function requireQueryLong(request: FastifyRequest, name: string): number {
  const n = Number((request.query as Record<string, unknown> | undefined)?.[name]);
  if (!Number.isFinite(n)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `${name} 无效`);
  }
  return n;
}

/**
 * Content-Disposition 双轨文件名：`filename`（ASCII 兜底，老 IE / 部分下载器用）+
 * `filename*`（RFC 5987，现代浏览器优先）。兜底段必须同时转义 `"` 与 `\`——
 * 反斜杠是可打印 ASCII、能活过第一道过滤，出现「abc\」时 `filename="abc\"` 的
 * 引号被吃掉，整个 quoted-string 不闭合。2026-11-24 起 `send_file` 的 filename
 * 是模型可控输入，这条从「理论缺陷」变成「可稳定触达」。
 */
export function contentDisposition(kind: 'attachment' | 'inline', fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7E]/g, '_').replace(/[\\"]/g, '\\$&');
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

/** sendFile 的内存 Buffer 变体：LOCAL 正文图片委托读取的结果不经磁盘，直接回给请求方。 */
function sendBuffer(
  reply: FastifyReply,
  buffer: Buffer,
  fileName: string,
  contentType: string,
): FastifyReply {
  reply
    .header('Content-Disposition', contentDisposition('attachment', fileName))
    .type(contentType)
    .header('Content-Length', String(buffer.length));
  return reply.send(buffer);
}

async function readWorkspaceUpload(request: FastifyRequest): Promise<{
  sessionId: number | null;
  workspacePath: string | null;
  dir: string;
  overwrite: boolean;
  force: boolean;
  files: { relativePath: string; bytes: Buffer }[];
}> {
  const parts = request.parts();
  let sessionId: number | null = null;
  let workspacePath: string | null = null;
  let dir = '.';
  let overwrite = false;
  let force = false;
  const relativePaths: string[] = [];
  const files: { relativePath: string; bytes: Buffer }[] = [];
  for await (const part of parts) {
    if (part.type === 'file') {
      const bytes = await part.toBuffer();
      if (part.fieldname !== 'file') continue;
      const relativePath = relativePaths.length > files.length ? relativePaths[files.length] : part.filename;
      files.push({ relativePath, bytes });
    } else if (part.fieldname === 'sessionId' && part.value != null && String(part.value).length > 0) {
      const n = Number(part.value);
      sessionId = Number.isFinite(n) ? n : null;
    } else if (part.fieldname === 'workspacePath' && part.value != null && String(part.value).length > 0) {
      workspacePath = String(part.value);
    } else if (part.fieldname === 'dir' && part.value != null) {
      const text = String(part.value);
      dir = text.length > 0 ? text : '.';
    } else if (part.fieldname === 'relativePath' && part.value != null) {
      relativePaths.push(String(part.value));
    } else if (part.fieldname === 'overwrite') {
      overwrite = String(part.value) === 'true';
    } else if (part.fieldname === 'force') {
      force = String(part.value) === 'true';
    }
  }
  if (sessionId == null && (workspacePath == null || workspacePath.length === 0)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '缺少必要参数: sessionId');
  }
  if (files.length === 0) {
    throw new BusinessException(ErrorCode.PARAM_MISSING, '缺少必要参数');
  }
  return { sessionId, workspacePath, dir, overwrite, force, files };
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
