import Fastify from 'fastify';
import multipart from '@fastify/multipart';
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
import type { WorkspaceWriteService } from './workspace-write.service.js';
import type { WorkspaceOverviewService } from './workspace-overview.service.js';
import { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { join } from 'node:path';
import { useTmpDir } from '../testing/tmp-dir.js';

describe('file routes', () => {
  it('listsWorkspaceAndGitJsonEndpoints', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _r, done) => {
      const header = (req.headers['x-test-user'] ?? '7') as string;
      req.userId = Number(header) || 7;
      done();
    });
    const session = { id: 1, userId: 7, workspace: '/tmp/ws', agentId: 9 };
    const fileService = {
      listFiles: vi.fn(async () => [
        { id: 1, originalName: 'a.txt', storedName: 'x.txt', filePath: '/tmp/x.txt', fileSize: 1, uploaderId: 7, sessionId: 1 },
      ]),
      listWorkspaceFiles: vi.fn(() => [{ path: 'a.txt', name: 'a.txt', size: 1 }]),
      getFile: vi.fn(async () => null),
      deleteFile: vi.fn(),
      uploadFile: vi.fn(async () => ({
        id: 1, originalName: 'a.txt', storedName: 'x.txt', filePath: '/tmp/x.txt', fileSize: 1, sessionId: 1,
      })),
      uploadIncomingFile: vi.fn(async (bytes: Buffer, originalName: string, mime: string, userId: number, sessionId: number, incomingDir: string) => {
        const storedName = 'stored-' + originalName;
        mkdirSync(incomingDir, { recursive: true });
        const filePath = join(incomingDir, storedName);
        writeFileSync(filePath, bytes);
        return {
          id: 2, originalName, storedName, filePath, fileSize: bytes.length, mimeType: mime, sessionId,
        };
      }),
    } as unknown as FileService;
    const sessionService = { getSession: vi.fn(async () => session) } as unknown as SessionService;
    const workspaceBrowseService = {
      listDirectory: vi.fn(() => ({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })),
      searchFiles: vi.fn(() => ({ entries: [{ name: 'a.txt', path: 'a.txt', isDirectory: false, size: 1, isSymlink: false }], truncated: false })),
      readFile: vi.fn(async () => ({ content: 'hi', total_lines: 1 })),
      readPdfFile: vi.fn(() => ({ path: join(root, 'preview.pdf'), fileName: 'preview.pdf', size: 4 })),
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
      generateCommitMessage: vi.fn(async () => ({ title: 'feat: x', message: 'feat: x\n\n- y' })),
      recordLocalActivity: vi.fn(),
    } as unknown as GitWriteOperationService;
    const gitCommitMessageService = {
      generate: vi.fn(async () => ({ title: 'feat: x', message: 'feat: x\n\n- y' })),
    } as unknown as GitCommitMessageService;
    const root = useTmpDir('mao-files-');
    mkdirSync(join(root, '7', 'projects', 'demo'), { recursive: true });
    writeFileSync(join(root, 'preview.pdf'), '%PDF');
    const runtimeDir = useTmpDir('mao-runtime-');
    const pathSandbox = { getWorkspaceRoot: () => root } as PathSandbox;
    const runtimeDataResolver = new RuntimeDataResolver(runtimeDir, join(root, 'home'));
    registerFileRoutes(app, {
      fileService, sessionService, workspaceBrowseService, workspaceGitService,
      gitCommitMessageService, gitWriteOperationService, pathSandbox, getUploadBaseUrl: async () => '',
      workspaceWriteService: {
        mkdir: vi.fn(), write: vi.fn(), rename: vi.fn(), move: vi.fn(), delete: vi.fn(), copy: vi.fn(), upload: vi.fn(),
      } as unknown as WorkspaceWriteService,
      runtimeDataResolver,
      experienceDirForAgent: (agentId: number) => `/share/agent-experience/${agentId}`,
      localFileFetchService: { fetch: vi.fn() },
    });
    const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body);
    const post = async (url: string, payload: object) => JSON.parse((await app.inject({ method: 'POST', url, payload })).body);
    const fileListVo = await get('/v1/files');
    expect(fileListVo.code).toBe(0);
    expect(Array.isArray(fileListVo.data)).toBe(true);
    expect(fileListVo.data[0]?.originalName).toBe('a.txt');
    expect((await get('/v1/files/workspace-list?sessionId=1')).data.files).toHaveLength(1);
    expect((await get('/v1/files/workspace-directory?sessionId=1')).code).toBe(0);
    expect(vi.mocked(workspaceBrowseService.listDirectory).mock.calls[0]?.[2]).toBe('/share/agent-experience/9');
    expect((await get('/v1/files/workspace-search?sessionId=1&pattern=a')).code).toBe(0);
    expect((await get('/v1/files/workspace-search?sessionId=1&pattern=a')).data.entries[0].name).toBe('a.txt');
    expect((await get('/v1/files/workspace-search?sessionId=1')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-read?sessionId=1&path=a.txt')).data.content).toBe('hi');
    expect((await get('/v1/files/workspace-git-repos?sessionId=1')).data.isRootGit).toBe(false);
    expect((await get('/v1/files/workspace-git-status?sessionId=1')).data.isGit).toBe(false);
    expect((await get('/v1/files/workspace-git-diff?sessionId=1&path=a')).data.path).toBe('a');
    expect((await post('/v1/files/workspace-git-refresh', { sessionId: 1 })).data.isGit).toBe(true);
    expect((await post('/v1/files/workspace-git-commit', { sessionId: 1 })).data.success).toBe(true);
    // 两步提交（中央 Tab）：传入用户消息直接提交 + 只生成接口
    expect((await post('/v1/files/workspace-git-commit', { sessionId: 1, message: 'wip 随手一改' })).data.success).toBe(true);
    expect(vi.mocked(gitWriteOperationService.commit).mock.calls[1][2]).toBe('wip 随手一改');
    expect((await post('/v1/files/workspace-git-commit-message', { sessionId: 1 })).data.title).toBe('feat: x');
    expect((await post('/v1/files/workspace-git-pull', { sessionId: 1 })).data.success).toBe(true);
    expect((await post('/v1/files/workspace-git-push', { sessionId: 1 })).data.success).toBe(true);
    expect((await post('/v1/files/git-commit-message', { sessionId: 1, changes: { files: [], diffBytes: 0 } })).data.title).toBe('feat: x');
    expect((await post('/v1/files/workspace-git-activity', { sessionId: 1, result: { operation: 'commit', success: true } })).code).toBe(0);
    expect((await get('/v1/files/project-list?projectKey=demo')).data.files).toHaveLength(1);

    // project 只读端点族（新建态无会话浏览）：happy path
    expect((await get('/v1/files/project-directory?projectKey=demo')).code).toBe(0);
    expect((await get('/v1/files/project-directory?projectKey=demo')).data.entries[0].name).toBe('a.txt');
    expect((await get('/v1/files/project-read?projectKey=demo&path=a.txt')).data.content).toBe('hi');
    expect((await get('/v1/files/project-search?projectKey=demo&pattern=a')).data.entries[0].name).toBe('a.txt');
    const previewRes = await app.inject({ method: 'GET', url: '/v1/files/project-preview?projectKey=demo&path=preview.pdf' });
    expect(previewRes.statusCode).toBe(200);

    // project 只读端点族：参数与越权防护
    expect((await get('/v1/files/project-directory')).code).not.toBe(0);
    expect((await get('/v1/files/project-directory?projectKey=..')).code).not.toBe(0);
    expect((await get('/v1/files/project-directory?projectKey=projects')).code).not.toBe(0);
    expect((await get('/v1/files/project-search?projectKey=demo')).code).not.toBe(0);
    expect((await get('/v1/files/project-read?projectKey=demo')).code).not.toBe(0);
    expect((await get('/v1/files/project-preview?projectKey=demo')).code).not.toBe(0);
    // 项目目录不存在（新项目名）：空列表而非错误
    expect((await get('/v1/files/project-directory?projectKey=ghost')).data.entries).toEqual([]);
    expect((await get('/v1/files/project-search?projectKey=ghost&pattern=a')).data.entries).toEqual([]);
    // 跨用户不泄漏：demo 位于用户 7 根下，用户 8 看到的是「不存在」
    const foreign = await app.inject({
      method: 'GET', url: '/v1/files/project-directory?projectKey=demo', headers: { 'x-test-user': '8' },
    });
    expect(JSON.parse(foreign.body).data.entries).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/v1/files/99/download' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: '/v1/files/99' })).statusCode).toBe(200);

    // upload-incoming：文件需落到会话 runtime incoming 目录，并返回 absolutePath
    const incomingDir = runtimeDataResolver.resolveIncomingDir(7, 1);
    const uploadRes = await app.inject({
      method: 'POST',
      url: '/v1/files/upload-incoming',
      payload: (() => {
        const form = new FormData();
        form.append('sessionId', '1');
        form.append('file', new Blob([Buffer.from('hello incoming')], { type: 'text/plain' }), 'note.txt');
        return form;
      })(),
    });
    const uploadBody = JSON.parse(uploadRes.body);
    expect(uploadBody.code).toBe(0);
    expect(uploadBody.data.absolutePath.startsWith(incomingDir)).toBe(true);
    expect(existsSync(uploadBody.data.absolutePath)).toBe(true);
    expect(readFileSync(uploadBody.data.absolutePath, 'utf8')).toBe('hello incoming');

    // 无 sessionId 时拒绝
    const noSession = await app.inject({
      method: 'POST',
      url: '/v1/files/upload-incoming',
      payload: (() => {
        const form = new FormData();
        form.append('file', new Blob([Buffer.from('x')], { type: 'text/plain' }), 'a.txt');
        return form;
      })(),
    });
    expect(JSON.parse(noSession.body).code).not.toBe(0);

    // 属主校验：他人访问文件下载/删除被拒
    vi.mocked(fileService.getFile).mockResolvedValue({
      id: 1, originalName: 'a.txt', storedName: 'x.txt', filePath: '/tmp/x.txt', fileSize: 1, uploaderId: 7, sessionId: 1,
    } as never);
    const foreignDownload = await app.inject({ method: 'GET', url: '/v1/files/1/download', headers: { 'x-test-user': '99' } });
    expect(JSON.parse(foreignDownload.body).code).not.toBe(0);
    const foreignDelete = await app.inject({ method: 'DELETE', url: '/v1/files/1', headers: { 'x-test-user': '99' } });
    expect(JSON.parse(foreignDelete.body).code).not.toBe(0);

    // 属主本人访问放行
    const ownerDelete = await app.inject({ method: 'DELETE', url: '/v1/files/1' });
    expect(JSON.parse(ownerDelete.body).code).toBe(0);

    await app.close();
  });

  it('multi zip downloads guard ownership and stream zip bytes', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _r, done) => {
      const header = (req.headers['x-test-user'] ?? '7') as string;
      req.userId = Number(header) || 7;
      done();
    });
    const root = useTmpDir('mao-multi-zip-');
    const workspace = join(root, 'ws');
    mkdirSync(workspace, { recursive: true });
    const session = { id: 1, userId: 7, workspace, agentId: 9 };
    const sessionService = { getSession: vi.fn(async () => session) } as unknown as SessionService;
    // 22 字节空 zip（仅 EOCD），断言响应字节原样透传
    const zipBytes = Buffer.alloc(22);
    zipBytes.write('PK\x05\x06', 0, 'binary');
    const workspaceBrowseService = {
      zipEntries: vi.fn(async (_ws: string, paths: string[]) => {
        const zipPath = join(root, `out-${paths.length}.zip`);
        writeFileSync(zipPath, zipBytes);
        return { zipPath, size: zipBytes.length, fileName: 'ws-20261114-1530.zip' };
      }),
    } as unknown as WorkspaceBrowseService;
    const owned = join(root, '7', 'projects', 'demo');
    mkdirSync(owned, { recursive: true });
    const workspaceOverviewService = {
      resolveManagedPath: vi.fn(async (_userId: number, raw: string) => (raw === owned ? { path: owned } : { error: '目录不存在' })),
    } as unknown as WorkspaceOverviewService;
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService,
      workspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as GitWriteOperationService,
      workspaceWriteService: {} as WorkspaceWriteService,
      pathSandbox: {} as PathSandbox,
      workspaceOverviewService,
      runtimeDataResolver: new RuntimeDataResolver(useTmpDir('mao-multi-rt-'), join(root, 'home')),
    });

    // workspace 家族：正常请求返回 zip 字节 + Content-Disposition 文件名
    const ok = await app.inject({
      method: 'POST', url: '/v1/files/workspace-download-multi-zip',
      payload: { sessionId: 1, paths: ['a.txt', 'docs'] },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('application/zip');
    expect(ok.headers['content-disposition']).toContain('ws-20261114-1530.zip');
    expect(ok.rawPayload).toEqual(zipBytes);
    expect(vi.mocked(workspaceBrowseService.zipEntries).mock.calls[0]?.[0]).toBe(workspace);
    expect(vi.mocked(workspaceBrowseService.zipEntries).mock.calls[0]?.[1]).toEqual(['a.txt', 'docs']);

    // paths 缺失 / 非数组 → 拒绝；他人会话 → 拒绝
    const noPaths = await app.inject({ method: 'POST', url: '/v1/files/workspace-download-multi-zip', payload: { sessionId: 1 } });
    expect(JSON.parse(noPaths.body).code).not.toBe(0);
    const strPaths = await app.inject({ method: 'POST', url: '/v1/files/workspace-download-multi-zip', payload: { sessionId: 1, paths: 'a.txt' } });
    expect(JSON.parse(strPaths.body).code).not.toBe(0);
    const foreign = await app.inject({
      method: 'POST', url: '/v1/files/workspace-download-multi-zip',
      payload: { sessionId: 1, paths: ['a.txt'] }, headers: { 'x-test-user': '99' },
    });
    expect(JSON.parse(foreign.body).code).not.toBe(0);

    // owned 家族：正常请求返回 zip 字节；非受管 root → 拒绝
    const ownedOk = await app.inject({
      method: 'POST', url: '/v1/files/owned-download-multi-zip',
      payload: { root: owned, paths: ['a.txt'] },
    });
    expect(ownedOk.statusCode).toBe(200);
    expect(ownedOk.rawPayload).toEqual(zipBytes);
    expect(vi.mocked(workspaceBrowseService.zipEntries).mock.calls[1]?.[0]).toBe(owned);
    const badRoot = await app.inject({
      method: 'POST', url: '/v1/files/owned-download-multi-zip',
      payload: { root: '/elsewhere', paths: ['a.txt'] },
    });
    expect(JSON.parse(badRoot.body).code).not.toBe(0);

    await app.close();
  });

  it('rejects local sessions and workspace upload traversal', async () => {
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs');
    const { join: jn } = await import('node:path');
    const { PathSandbox: Sandbox } = await import('../harness/safety/path-sandbox.js');
    const { WorkspaceWriteService: WriteService } = await import('./workspace-write.service.js');
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const root = useTmpDir('mao-route-write-');
    const workspace = jn(root, 'ws');
    mk(workspace, { recursive: true });
    wf(jn(workspace, 'keep.txt'), 'keep');
    const sessions = new Map<number, { id: number; userId: number; workspace: string; executionMode: string }>([
      [1, { id: 1, userId: 7, workspace, executionMode: 'CLOUD' }],
      [2, { id: 2, userId: 7, workspace, executionMode: 'LOCAL' }],
    ]);
    const sessionService = { getSession: vi.fn(async (id: number) => sessions.get(id)) } as unknown as SessionService;
    const recorded: unknown[] = [];
    const write = new WriteService(new Sandbox(root), { record: vi.fn(async (...args: unknown[]) => { recorded.push(args); return {}; }) } as never);
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService,
      workspaceBrowseService: {} as WorkspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as GitWriteOperationService,
      workspaceWriteService: write,
      pathSandbox: new Sandbox(root),
      runtimeDataResolver: new RuntimeDataResolver(useTmpDir('mao-route-rt-'), jn(root, 'home')),
    });
    const local = await app.inject({ method: 'POST', url: '/v1/files/workspace-mkdir', payload: { sessionId: 2, path: 'a' } });
    expect(JSON.parse(local.body).message).toContain('本地模式不支持');
    const escaped = await app.inject({
      method: 'POST',
      url: '/v1/files/workspace-upload',
      payload: (() => {
        const form = new FormData();
        form.append('sessionId', '1');
        form.append('dir', '.');
        form.append('relativePath', '../keep.txt');
        form.append('file', new Blob([Buffer.from('pwn')], { type: 'text/plain' }), 'keep.txt');
        return form;
      })(),
    });
    expect(JSON.parse(escaped.body).code).toBe(2001);
    const { readFileSync: rf } = await import('node:fs');
    expect(rf(jn(workspace, 'keep.txt'), 'utf8')).toBe('keep');
    expect(recorded).toHaveLength(0);
    await app.close();
  });

  it('workspacePath mkdir writes that owned directory and rejects paths outside the user root', async () => {
    const { mkdirSync: mk, existsSync: ex } = await import('node:fs');
    const { join: jn } = await import('node:path');
    const { PathSandbox: Sandbox } = await import('../harness/safety/path-sandbox.js');
    const { WorkspaceWriteService: WriteService } = await import('./workspace-write.service.js');
    const { WorkspaceOverviewService } = await import('./workspace-overview.service.js');
    const app = Fastify();
    app.setErrorHandler(handleError);
    await app.register(multipart);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const root = useTmpDir('mao-owned-write-');
    const owned = jn(root, '7', 'proj');
    mk(owned, { recursive: true });
    const overview = new WorkspaceOverviewService(new Sandbox(root), {
      aggregateWorkspaceUsage: async () => new Map(),
      listActiveWorkspaceReferences: async () => [],
    } as never);
    const write = new WriteService(new Sandbox(root), { record: vi.fn(async () => ({})) } as never);
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService: { getSession: vi.fn() } as unknown as SessionService,
      workspaceBrowseService: {} as WorkspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as GitWriteOperationService,
      workspaceWriteService: write,
      workspaceOverviewService: overview,
      pathSandbox: new Sandbox(root),
    });
    const ok = await app.inject({
      method: 'POST',
      url: '/v1/files/workspace-mkdir',
      payload: { workspacePath: owned, path: 'nested' },
    });
    expect(JSON.parse(ok.body).code).toBe(0);
    expect(ex(jn(owned, 'nested'))).toBe(true);
    const denied = await app.inject({
      method: 'POST',
      url: '/v1/files/workspace-mkdir',
      payload: { workspacePath: '/etc', path: 'x' },
    });
    expect(JSON.parse(denied.body).code).not.toBe(0);
    expect(ex('/etc/x')).toBe(false);
    await app.close();
  });

  it('gitManagerEndpointsRejectLocalSessionsAndMissingParams', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const sessions = new Map<number, { id: number; userId: number; workspace: string; executionMode: string }>([
      [1, { id: 1, userId: 7, workspace: '/tmp/ws-cloud', executionMode: 'CLOUD' }],
      [2, { id: 2, userId: 7, workspace: '/tmp/ws-local', executionMode: 'LOCAL' }],
    ]);
    const sessionService = { getSession: vi.fn(async (id: number) => sessions.get(id)) } as unknown as SessionService;
    const workspaceGitService = {
      getLog: vi.fn(async () => [{ hash: 'h', shortHash: 'h', title: 't', author: 'a', date: 'd' }]),
      getCommitFiles: vi.fn(async () => ({ hash: 'h', files: [] })),
      getCommitFileDiff: vi.fn(async () => ({ path: 'a', changeType: 'MODIFIED', beforeContent: '', afterContent: '' })),
      getBranches: vi.fn(async () => [{ name: 'main', isCurrent: true, isRemote: false }]),
      getStashes: vi.fn(async () => [{ ref: 'stash@{0}', message: 'm', date: 'd' }]),
      getRemotes: vi.fn(async () => [{ name: 'origin', fetchUrl: 'u', pushUrl: 'u' }]),
      compareBranches: vi.fn(async () => ({ base: 'main', target: 'feature', aheadCount: 1, behindCount: 0, files: [] })),
      compareBranchFileDiff: vi.fn(async () => ({ path: 'a', changeType: 'MODIFIED', beforeContent: '', afterContent: '' })),
    } as unknown as WorkspaceGitService;
    const gitWriteOperationService = {
      fetchRemote: vi.fn(async () => ({ success: true, operation: 'fetch', message: '远端已更新' })),
      switchBranch: vi.fn(async () => ({ success: true, operation: 'switch', branch: 'main' })),
      stashOp: vi.fn(async () => ({ success: true, operation: 'stash', message: '已应用 stash@{0}' })),
    } as unknown as GitWriteOperationService;
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService,
      workspaceBrowseService: {} as WorkspaceBrowseService,
      workspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService,
      workspaceWriteService: {} as WorkspaceWriteService,
      pathSandbox: { getWorkspaceRoot: () => '/tmp' } as PathSandbox,
      runtimeDataResolver: new RuntimeDataResolver(useTmpDir('mao-route-gitmgr-'), '/tmp/home'),
    });
    const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body);
    const post = async (url: string, payload: object) => JSON.parse((await app.inject({ method: 'POST', url, payload })).body);

    // 新端点族只服务 CLOUD：LOCAL 会话一律拒绝（LOCAL 走 Electron IPC）
    for (const url of [
      '/v1/files/workspace-git-log?sessionId=2',
      '/v1/files/workspace-git-commit?sessionId=2&hash=abc1234',
      '/v1/files/workspace-git-commit-file-diff?sessionId=2&hash=abc1234&path=a',
      '/v1/files/workspace-git-branches?sessionId=2',
      '/v1/files/workspace-git-stashes?sessionId=2',
      '/v1/files/workspace-git-remotes?sessionId=2',
      '/v1/files/workspace-git-branch-compare?sessionId=2&base=main&target=feature',
      '/v1/files/workspace-git-branch-compare-file-diff?sessionId=2&base=main&target=feature&path=a',
    ]) {
      const body = await get(url);
      expect(body.code).not.toBe(0);
      expect(body.message).toContain('本地模式不支持');
    }
    for (const [url, payload] of [
      ['/v1/files/workspace-git-fetch', { sessionId: 2 }],
      ['/v1/files/workspace-git-switch-branch', { sessionId: 2, branch: 'main' }],
      ['/v1/files/workspace-git-stash', { sessionId: 2, action: 'apply', ref: 'stash@{0}' }],
      ['/v1/files/workspace-git-commit-message', { sessionId: 2 }],
    ] as const) {
      const body = await post(url, payload);
      expect(body.code).not.toBe(0);
      expect(body.message).toContain('本地模式不支持');
    }

    // 缺 sessionId / 缺必填参数
    expect((await get('/v1/files/workspace-git-log')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-commit?sessionId=1')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-commit-file-diff?sessionId=1&hash=abc1234')).code).not.toBe(0);
    // 分支对比：base / target / path 逐个必填
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1&base=main')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1&target=feature')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&target=feature')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&path=a')).code).not.toBe(0);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&target=feature&path=a')).code).not.toBe(0);
    expect((await post('/v1/files/workspace-git-switch-branch', { sessionId: 1 })).code).not.toBe(0);
    expect((await post('/v1/files/workspace-git-stash', { sessionId: 1, action: 'apply' })).code).not.toBe(0);
    expect((await post('/v1/files/workspace-git-stash', { sessionId: 1, ref: 'stash@{0}' })).code).not.toBe(0);

    // happy path：CLOUD 会话透传分页 / 哈希 / 分支 / stash 参数
    expect((await get('/v1/files/workspace-git-log?sessionId=1&limit=20&offset=10')).data[0].hash).toBe('h');
    expect(vi.mocked(workspaceGitService.getLog).mock.calls[0][2]).toEqual({ limit: 20, offset: 10, path: undefined });
    expect((await get('/v1/files/workspace-git-commit?sessionId=1&hash=abc1234')).data.hash).toBe('h');
    expect((await get('/v1/files/workspace-git-commit-file-diff?sessionId=1&hash=abc1234&path=a.txt')).data.path).toBe('a');
    // 改名提交：oldPath 作为可选查询参数透传（before 取自父提交的旧路径）
    expect((await get('/v1/files/workspace-git-commit-file-diff?sessionId=1&hash=abc1234&path=b.txt&oldPath=a.txt')).data.path).toBe('a');
    expect(vi.mocked(workspaceGitService.getCommitFileDiff).mock.calls.at(-1)).toEqual([expect.anything(), undefined, 'abc1234', 'b.txt', 'a.txt']);
    expect((await get('/v1/files/workspace-git-branches?sessionId=1')).data[0].name).toBe('main');
    // 分支对比：base / target / repoPath 透传（repoPath 只接受一级子目录名，服务内部校验）
    expect((await get('/v1/files/workspace-git-branch-compare?sessionId=1&base=main&target=feature&repoPath=demo')).data.aheadCount).toBe(1);
    expect(vi.mocked(workspaceGitService.compareBranches).mock.calls.at(-1)).toEqual([expect.anything(), 'demo', 'main', 'feature']);
    // 单文件 diff：path 必填、oldPath 可选（rename 行传旧路径，before 取 base 侧旧路径）
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&target=feature&path=b.txt')).data.path).toBe('a');
    expect(vi.mocked(workspaceGitService.compareBranchFileDiff).mock.calls.at(-1)).toEqual([expect.anything(), undefined, 'main', 'feature', 'b.txt', undefined]);
    expect((await get('/v1/files/workspace-git-branch-compare-file-diff?sessionId=1&base=main&target=feature&path=b.txt&oldPath=a.txt')).code).toBe(0);
    expect(vi.mocked(workspaceGitService.compareBranchFileDiff).mock.calls.at(-1)).toEqual([expect.anything(), undefined, 'main', 'feature', 'b.txt', 'a.txt']);
    expect((await get('/v1/files/workspace-git-stashes?sessionId=1')).data[0].ref).toBe('stash@{0}');
    expect((await get('/v1/files/workspace-git-remotes?sessionId=1')).data[0].name).toBe('origin');
    expect((await post('/v1/files/workspace-git-fetch', { sessionId: 1 })).data.message).toBe('远端已更新');
    expect((await post('/v1/files/workspace-git-switch-branch', { sessionId: 1, branch: 'main', create: true })).data.branch).toBe('main');
    expect(vi.mocked(gitWriteOperationService.switchBranch).mock.calls[0][3]).toBe(true);
    expect((await post('/v1/files/workspace-git-stash', { sessionId: 1, action: 'pop', ref: 'stash@{0}' })).data.message).toBe('已应用 stash@{0}');

    await app.close();
  });

  // 方案 2026-11-18：workspace-download 的 LOCAL 分流——按需委托执行端，绝不直读服务器文件系统
  it('servesLocalWorkspaceDownloadViaDelegation', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const localSession = { id: 2, userId: 7, workspace: 'D:\proj', agentId: 9, executionMode: 'LOCAL' };
    const sessionService = { getSession: vi.fn(async () => localSession) } as unknown as SessionService;
    const downloadFile = vi.fn();
    const workspaceBrowseService = { downloadFile } as unknown as WorkspaceBrowseService;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const localFileFetchService = {
      fetch: vi.fn(async () => ({ ok: true as const, bytes: pngBytes, fileName: 'shot.png', mime: 'image/png' })),
    };
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService,
      workspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as import('./git-write-operation.service.js').GitWriteOperationService,
      workspaceWriteService: {} as WorkspaceWriteService,
      workspaceOverviewService: {} as import('./workspace-overview.service.js').WorkspaceOverviewService,
      localFileFetchService,
      pathSandbox: { getWorkspaceRoot: () => '/tmp/ws' } as PathSandbox,
    });

    // 成功：字节 + mime + attachment，且绝不触碰服务器文件系统（downloadFile 不得被调用）
    const okRes = await app.inject({ method: 'GET', url: '/v1/files/workspace-download?sessionId=2&path=screenshots/x.png' });
    expect(okRes.statusCode).toBe(200);
    expect(okRes.rawPayload).toEqual(pngBytes); // inject 的 body 按 UTF-8 解码，字节比对用 rawPayload
    expect(okRes.headers['content-type']).toContain('image/png');
    expect(String(okRes.headers['content-disposition'])).toContain('shot.png');
    expect(localFileFetchService.fetch).toHaveBeenCalledWith(2, 7, 'screenshots/x.png', 'D:\proj');
    expect(downloadFile).not.toHaveBeenCalled();

    // 委托失败：HTTP 200 + 错误信封（code≠0），文案透传
    localFileFetchService.fetch.mockResolvedValueOnce({ ok: false as const, error: '本地执行端未连接，无法读取本地文件' });
    const errRes = await app.inject({ method: 'GET', url: '/v1/files/workspace-download?sessionId=2&path=x.png' });
    expect(errRes.statusCode).toBe(200);
    const errVo = JSON.parse(errRes.body) as { code: number; message: string };
    expect(errVo.code).not.toBe(0);
    expect(errVo.message).toBe('本地执行端未连接，无法读取本地文件');
    expect(downloadFile).not.toHaveBeenCalled();

    // 非白名单路径在服务内拒绝（路由只透传）
    localFileFetchService.fetch.mockResolvedValueOnce({ ok: false as const, error: '图片路径不合法' });
    const badRes = await app.inject({ method: 'GET', url: '/v1/files/workspace-download?sessionId=2&path=..%2Fa.png' });
    expect(JSON.parse(badRes.body).code).not.toBe(0);
    expect(downloadFile).not.toHaveBeenCalled();

    // 同级 workspace 端点族对 LOCAL 一律拒绝（requireCloudWorkspace）：LOCAL workspace 服务端不校验，
    // 直读服务器路径是目录读取缺口，整族关闭（评审 P1-1）
    for (const url of [
      '/v1/files/workspace-list?sessionId=2',
      '/v1/files/workspace-directory?sessionId=2',
      '/v1/files/workspace-search?sessionId=2&pattern=a',
      '/v1/files/workspace-read?sessionId=2&path=a.txt',
      '/v1/files/workspace-preview?sessionId=2&path=a.pdf',
      '/v1/files/workspace-download-zip?sessionId=2&path=dir',
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(JSON.parse(res.body).code).not.toBe(0);
      expect(JSON.parse(res.body).message).toBe('本地模式不支持服务端文件管理');
    }
    const zipRes = await app.inject({ method: 'POST', url: '/v1/files/workspace-download-multi-zip', payload: { sessionId: 2, paths: ['a'] } });
    expect(JSON.parse(zipRes.body).message).toBe('本地模式不支持服务端文件管理');
    expect(downloadFile).not.toHaveBeenCalled();

    await app.close();
  });

  // CLOUD 会话走原路径回归（方案 §8-1）
  it('servesCloudWorkspaceDownloadViaServerPath', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 7;
      done();
    });
    const cloudSession = { id: 3, userId: 7, workspace: '/tmp/ws-cloud', agentId: 9, executionMode: 'CLOUD' };
    const sessionService = { getSession: vi.fn(async () => cloudSession) } as unknown as SessionService;
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const downloadFile = vi.fn(() => ({ path: '/tmp/ws-cloud/x.png', fileName: 'x.png', size: pngBytes.length }));
    const workspaceBrowseService = { downloadFile } as unknown as WorkspaceBrowseService;
    const localFileFetchService = { fetch: vi.fn() };
    registerFileRoutes(app, {
      fileService: {} as FileService,
      sessionService,
      workspaceBrowseService,
      workspaceGitService: {} as WorkspaceGitService,
      gitCommitMessageService: {} as GitCommitMessageService,
      gitWriteOperationService: {} as import('./git-write-operation.service.js').GitWriteOperationService,
      workspaceWriteService: {} as WorkspaceWriteService,
      workspaceOverviewService: {} as import('./workspace-overview.service.js').WorkspaceOverviewService,
      localFileFetchService,
      pathSandbox: { getWorkspaceRoot: () => '/tmp/ws' } as PathSandbox,
    });
    // sendFile 从磁盘流式读取：放一个真实文件
    mkdirSync('/tmp/ws-cloud', { recursive: true });
    writeFileSync('/tmp/ws-cloud/x.png', pngBytes);
    const res = await app.inject({ method: 'GET', url: '/v1/files/workspace-download?sessionId=3&path=x.png' });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload).toEqual(pngBytes);
    expect(downloadFile).toHaveBeenCalledTimes(1);
    expect(localFileFetchService.fetch).not.toHaveBeenCalled();

    await app.close();
  });
});
