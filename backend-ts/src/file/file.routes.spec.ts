import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { handleError } from '../common/http-error.js';
import { registerFileRoutes } from './file.routes.js';
import type { FileService } from './file.service.js';
import type { WorkspaceBrowseService } from './workspace-browse.service.js';
import type { WorkspaceGitService } from './workspace-git.service.js';
import type { GitCommitMessageService } from './git-commit-message.service.js';
import type { GitWriteOperationService } from './git-write-operation.service.js';
import type { SessionService } from '../session/session.service.js';
import type { PathSandbox } from '../harness/safety/path-sandbox.js';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdirSync } from 'node:fs';

describe('file routes', () => {
  it('listsWorkspaceAndGitJsonEndpoints', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { req.userId = 7; done(); });
    const session = { id: 1, userId: 7, workspace: '/tmp/ws' };
    const fileService = {
      listFiles: vi.fn(async () => []),
      listWorkspaceFiles: vi.fn(() => [{ path: 'a.txt', name: 'a.txt', size: 1 }]),
      getFile: vi.fn(async () => null),
      deleteFile: vi.fn(),
      uploadFile: vi.fn(async () => ({
        id: 1, originalName: 'a.txt', storedName: 'x.txt', filePath: '/tmp/x.txt', fileSize: 1, sessionId: 1,
      })),
    } as unknown as FileService;
    const sessionService = { getSession: vi.fn(async () => session) } as unknown as SessionService;
    const workspaceBrowseService = {
      listDirectory: vi.fn(() => ({ entries: [], truncated: false })),
      readFile: vi.fn(async () => ({ content: 'hi', total_lines: 1 })),
    } as unknown as WorkspaceBrowseService;
    const workspaceGitService = {
      listRepos: vi.fn(async () => ({ isRootGit: false, repos: [] })),
      getStatus: vi.fn(async () => ({ isGit: false })),
      getFileDiff: vi.fn(async () => ({ path: 'a', changeType: 'MODIFIED', beforeContent: '', afterContent: '' })),
    } as unknown as WorkspaceGitService;
    const gitWriteOperationService = {
      refreshRemoteStatus: vi.fn(async () => ({ isGit: true })),
      commit: vi.fn(async () => ({ success: true, operation: 'commit' })),
      pull: vi.fn(async () => ({ success: true, operation: 'pull' })),
      push: vi.fn(async () => ({ success: true, operation: 'push' })),
      recordLocalActivity: vi.fn(),
    } as unknown as GitWriteOperationService;
    const gitCommitMessageService = {
      generate: vi.fn(async () => ({ title: 'feat: x', message: 'feat: x\n\n- y' })),
    } as unknown as GitCommitMessageService;
    const root = await mkdtemp(join(tmpdir(), 'mao-files-'));
    mkdirSync(join(root, '7', 'projects', 'demo'), { recursive: true });
    const pathSandbox = { getWorkspaceRoot: () => root } as PathSandbox;
    registerFileRoutes(app, {
      fileService, sessionService, workspaceBrowseService, workspaceGitService,
      gitCommitMessageService, gitWriteOperationService, pathSandbox, uploadBaseUrl: '',
    });
    const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body);
    const post = async (url: string, payload: object) => JSON.parse((await app.inject({ method: 'POST', url, payload })).body);
    expect((await get('/v1/files')).code).toBe(0);
    expect((await get('/v1/files/workspace-list?sessionId=1')).data.files).toHaveLength(1);
    expect((await get('/v1/files/workspace-directory?sessionId=1')).code).toBe(0);
    expect((await get('/v1/files/workspace-read?sessionId=1&path=a.txt')).data.content).toBe('hi');
    expect((await get('/v1/files/workspace-git-repos?sessionId=1')).data.isRootGit).toBe(false);
    expect((await get('/v1/files/workspace-git-status?sessionId=1')).data.isGit).toBe(false);
    expect((await get('/v1/files/workspace-git-diff?sessionId=1&path=a')).data.path).toBe('a');
    expect((await post('/v1/files/workspace-git-refresh', { sessionId: 1 })).data.isGit).toBe(true);
    expect((await post('/v1/files/workspace-git-commit', { sessionId: 1 })).data.success).toBe(true);
    expect((await post('/v1/files/workspace-git-pull', { sessionId: 1 })).data.success).toBe(true);
    expect((await post('/v1/files/workspace-git-push', { sessionId: 1 })).data.success).toBe(true);
    expect((await post('/v1/files/git-commit-message', { sessionId: 1, changes: { files: [], diffBytes: 0 } })).data.title).toBe('feat: x');
    expect((await post('/v1/files/workspace-git-activity', { sessionId: 1, result: { operation: 'commit', success: true } })).code).toBe(0);
    expect((await get('/v1/files/project-list?projectKey=demo')).data.files).toHaveLength(1);
    expect((await app.inject({ method: 'GET', url: '/v1/files/99/download' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/v1/files/99' })).statusCode).toBe(200);
    await app.close();
  });
});
