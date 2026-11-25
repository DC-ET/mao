import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerFileRoutes } from './file.routes.js';
import { SendDownloadTicketService } from './send-download-ticket.service.js';
import type { SendFileEntity, SendFileService } from './send-file.service.js';
import type { FileService } from './file.service.js';
import type { SessionService } from '../session/session.service.js';
import type { WorkspaceBrowseService } from './workspace-browse.service.js';
import type { WorkspaceGitService } from './workspace-git.service.js';
import type { GitCommitMessageService } from './git-commit-message.service.js';
import type { GitWriteOperationService } from './git-write-operation.service.js';
import type { WorkspaceWriteService } from './workspace-write.service.js';
import type { WorkspaceOverviewService } from './workspace-overview.service.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import { useTmpDir } from '../testing/tmp-dir.js';

/**
 * 快照下载（2026-11-25 send_file 1GB R6/R7）：票据换发、票据下载、无效票据回落 JWT、Range 206。
 */
describe('send-download ticket & range', () => {
  async function build(options: { ownerId?: number; sessionOwner?: number | null } = {}) {
    const dir = useTmpDir('mao-send-download-');
    mkdirSync(join(dir, '7'), { recursive: true });
    const bytes = Buffer.from('0123456789abcdef');
    writeFileSync(join(dir, '7', 'file.bin'), bytes);
    const row: SendFileEntity = {
      id: 'file-1', userId: options.ownerId ?? 7, sessionId: 11,
      filename: 'file.bin', mime: 'application/octet-stream', bytes: bytes.length,
      storage: 'local', objectKey: '7/file.bin',
    };
    const sendFileService = {
      findById: vi.fn(async (id: string) => (id === row.id ? row : null)),
      openDownload: vi.fn(async () => ({ ok: true as const, localPath: join(dir, '7', 'file.bin'), size: bytes.length })),
    } as unknown as SendFileService;
    const sessionService = {
      getSession: vi.fn(async () => (options.sessionOwner == null ? null : { id: 11, userId: options.sessionOwner })),
    };
    const tickets = new SendDownloadTicketService('test-secret', 24 * 60 * 60 * 1000);
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _reply, done) => {
      const header = String(req.headers['x-test-user'] ?? '7');
      if (header !== 'none') req.userId = Number(header) || 7;
      done();
    });
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService: sessionService as unknown as SessionService,
      workspaceBrowseService: {} as WorkspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as GitWriteOperationService,
      workspaceWriteService: {} as WorkspaceWriteService,
      workspaceOverviewService: {} as WorkspaceOverviewService,
      localFileFetchService: { fetch: vi.fn() },
      pathSandbox: { getWorkspaceRoot: () => dir } as PathSandbox,
      sendFileService,
      sendDownloadTickets: tickets,
    });
    return { app, tickets, bytes, row };
  }

  it('POST ticket：属主换票据；GET 凭票据下载（无 JWT）', async () => {
    const { app, bytes } = await build();
    const issued = await app.inject({ method: 'POST', url: '/v1/files/send-download-ticket', payload: { id: 'file-1' } });
    expect(issued.statusCode).toBe(200);
    const body = JSON.parse(issued.body) as { code: number; data: { ticket: string; expiresAt: number } };
    expect(body.code).toBe(0);
    expect(body.data.ticket).toContain('.');
    expect(body.data.expiresAt).toBeGreaterThan(Date.now());

    const downloaded = await app.inject({
      method: 'GET',
      url: `/v1/files/send-download?id=file-1&ticket=${encodeURIComponent(body.data.ticket)}`,
      headers: { 'x-test-user': 'none' },
    });
    expect(downloaded.statusCode).toBe(200);
    expect(downloaded.rawPayload.equals(bytes)).toBe(true);
    expect(downloaded.headers['accept-ranges']).toBe('bytes');
  });

  it('无效票据且无 JWT → 401；票据指向别的文件 → 不认可', async () => {
    const { app } = await build();
    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/files/send-download?id=file-1&ticket=bad.ticket',
      headers: { 'x-test-user': 'none' },
    });
    expect(invalid.statusCode).toBe(401);

    const other = await app.inject({
      method: 'GET',
      url: '/v1/files/send-download?id=other&ticket=bad.ticket',
      headers: { 'x-test-user': 'none' },
    });
    expect(other.statusCode).toBe(401);
  });

  it('非属主 / 会话归属人不符：换票据 404；合法 JWT 下载也 404', async () => {
    const { app } = await build({ ownerId: 9, sessionOwner: 8 });
    const issued = await app.inject({
      method: 'POST', url: '/v1/files/send-download-ticket', payload: { id: 'file-1' }, headers: { 'x-test-user': '7' },
    });
    expect(issued.statusCode).toBe(404);
    const downloaded = await app.inject({ method: 'GET', url: '/v1/files/send-download?id=file-1', headers: { 'x-test-user': '7' } });
    expect(downloaded.statusCode).toBe(404);
  });

  it('会话归属人可换票据（群聊非归属成员发言的兜底口径）', async () => {
    const { app } = await build({ ownerId: 9, sessionOwner: 7 });
    const issued = await app.inject({
      method: 'POST', url: '/v1/files/send-download-ticket', payload: { id: 'file-1' }, headers: { 'x-test-user': '7' },
    });
    expect(issued.statusCode).toBe(200);
  });

  it('Range：本地文件返回 206 + Content-Range；越界 416', async () => {
    const { app, tickets } = await build();
    const { ticket } = tickets.issue('file-1', 7);
    const partial = await app.inject({
      method: 'GET',
      url: `/v1/files/send-download?id=file-1&ticket=${encodeURIComponent(ticket)}`,
      headers: { 'x-test-user': 'none', range: 'bytes=4-7' },
    });
    expect(partial.statusCode).toBe(206);
    expect(partial.headers['content-range']).toBe('bytes 4-7/16');
    expect(partial.headers['content-length']).toBe('4');
    expect(partial.rawPayload.toString()).toBe('4567');

    const suffix = await app.inject({
      method: 'GET',
      url: `/v1/files/send-download?id=file-1&ticket=${encodeURIComponent(ticket)}`,
      headers: { 'x-test-user': 'none', range: 'bytes=-4' },
    });
    expect(suffix.statusCode).toBe(206);
    expect(suffix.rawPayload.toString()).toBe('cdef');

    const invalid = await app.inject({
      method: 'GET',
      url: `/v1/files/send-download?id=file-1&ticket=${encodeURIComponent(ticket)}`,
      headers: { 'x-test-user': 'none', range: 'bytes=99-100' },
    });
    expect(invalid.statusCode).toBe(416);
    expect(invalid.headers['content-range']).toBe('bytes */16');
  });
});
