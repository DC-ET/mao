import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceBrowseService } from '../file/workspace-browse.service.js';
import { registerAdminSessionFilesRoutes } from './admin-session-files.routes.js';
import type { SessionService } from './session.service.js';
import { useTmpDir } from '../testing/tmp-dir.js';

/** 1x1 PNG（sharp 可解析宽高） */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('admin session files routes', () => {
  it('serves workspace read-only endpoints without ownership check', async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    // 请求身份默认 42：会话属主是 7，验证 admin 不做出属主校验（D1）
    app.addHook('preHandler', (req, _r, done) => {
      const header = (req.headers['x-test-user'] ?? '42') as string;
      req.userId = Number(header) || 42;
      done();
    });

    const root = useTmpDir('mao-admin-files-');
    const workspace = join(root, 'ws');
    mkdirSync(join(workspace, 'notes'), { recursive: true });
    mkdirSync(join(workspace, 'many'), { recursive: true });
    writeFileSync(join(workspace, 'README.md'), 'hello\nworld');
    writeFileSync(join(workspace, 'notes', 'deep.txt'), 'deep');
    writeFileSync(join(workspace, 'pic.png'), PNG_1X1);
    writeFileSync(join(workspace, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02, 0xff]));
    writeFileSync(join(workspace, 'preview.pdf'), '%PDF-1.4\n%EOF');
    for (let i = 0; i < 105; i++) {
      writeFileSync(join(workspace, 'many', `f${String(i).padStart(3, '0')}.txt`), `x${i}`);
    }

    const sessions = new Map<number, { id: number; userId: number; workspace: string | null; executionMode: string }>([
      [1, { id: 1, userId: 7, workspace, executionMode: 'CLOUD' }],
      [2, { id: 2, userId: 7, workspace, executionMode: 'LOCAL' }],
      [3, { id: 3, userId: 7, workspace: null, executionMode: 'CLOUD' }],
    ]);
    const sessionService = {
      getSession: vi.fn(async (id: number) => {
        const session = sessions.get(id);
        if (session == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
        return session;
      }),
    } as unknown as Pick<SessionService, 'getSession'>;
    let allowed = true;
    const permissionService = { hasPermission: vi.fn(async () => allowed) };

    const workspaceBrowseService = new WorkspaceBrowseService(new PathSandbox(root));
    registerAdminSessionFilesRoutes(app, { sessionService, workspaceBrowseService, permissionService });

    const get = async (url: string) => JSON.parse((await app.inject({ method: 'GET', url })).body);

    // 鉴权：无 session:read → 403（handleError 归一为 code 1002）
    allowed = false;
    const denied = await app.inject({ method: 'GET', url: '/v1/admin/sessions/1/files/directory' });
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).code).toBe(1002);
    allowed = true;

    // 会话不存在 / 无工作区 / LOCAL 会话
    expect((await get('/v1/admin/sessions/999/files/directory')).code).toBe(ErrorCode.SESSION_NOT_FOUND.code);
    expect((await get('/v1/admin/sessions/3/files/directory')).message).toContain('会话未配置工作区');
    const local = await get('/v1/admin/sessions/2/files/directory');
    expect(local.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(local.message).toContain('本地执行会话');

    // directory：根目录（目录优先）、子目录、不存在目录、越界
    const rootListing = await get('/v1/admin/sessions/1/files/directory');
    expect(rootListing.code).toBe(0);
    expect(rootListing.data.entries.map((e: { name: string }) => e.name)).toEqual(['many', 'notes', 'bin.dat', 'pic.png', 'preview.pdf', 'README.md']);
    expect(rootListing.data.entries.find((e: { name: string }) => e.name === 'notes').isDirectory).toBe(true);
    expect(rootListing.data.entries.find((e: { name: string }) => e.name === 'README.md').mtimeMs).toBeGreaterThan(0);
    expect(rootListing.data.truncated).toBe(false);
    const sub = await get('/v1/admin/sessions/1/files/directory?dir=notes');
    expect(sub.data.entries.map((e: { name: string }) => e.name)).toEqual(['deep.txt']);
    expect((await get('/v1/admin/sessions/1/files/directory?dir=ghost')).message).toContain('目录不存在');
    const escaped = await get('/v1/admin/sessions/1/files/directory?dir=../..');
    expect(escaped.code).toBe(ErrorCode.FORBIDDEN.code);
    expect(escaped.message).toContain('路径访问被拒绝');

    // search：命中、空 pattern 拒绝、limit 夹取到 100
    const hit = await get('/v1/admin/sessions/1/files/search?pattern=read');
    expect(hit.data.entries.map((e: { path: string }) => e.path)).toEqual(['README.md']);
    expect((await get('/v1/admin/sessions/1/files/search')).code).not.toBe(0);
    expect((await get('/v1/admin/sessions/1/files/search?pattern=' + 'x'.repeat(101))).code).not.toBe(0);
    const clamped = await get('/v1/admin/sessions/1/files/search?pattern=f&limit=500');
    expect(clamped.data.entries).toHaveLength(100);
    expect(clamped.data.truncated).toBe(true);

    // read：文本、图片、二进制、缺参、越界
    const text = await get('/v1/admin/sessions/1/files/read?path=README.md');
    expect(text.data.content).toBe('hello\nworld');
    expect(text.data.total_lines).toBe(2);
    const image = await get('/v1/admin/sessions/1/files/read?path=pic.png');
    expect(image.data.media_type).toBe('image');
    expect(image.data.mime).toBe('image/png');
    expect(image.data.data_uri.startsWith('data:image/png;base64,')).toBe(true);
    expect(image.data.content).toContain('pic.png');
    const binary = await get('/v1/admin/sessions/1/files/read?path=bin.dat');
    expect(binary.code).toBe(ErrorCode.PARAM_INVALID.code);
    expect(binary.message).toContain('二进制文件');
    expect((await get('/v1/admin/sessions/1/files/read')).code).not.toBe(0);
    expect((await get('/v1/admin/sessions/1/files/read?path=../outside.txt')).code).toBe(ErrorCode.FORBIDDEN.code);

    // preview：PDF inline；非 PDF 拒绝；缺参拒绝
    const pdf = await app.inject({ method: 'GET', url: '/v1/admin/sessions/1/files/preview?path=preview.pdf' });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.headers['content-disposition']).toContain('inline');
    expect((await get('/v1/admin/sessions/1/files/preview?path=README.md')).message).toContain('仅支持预览 .pdf');
    expect((await get('/v1/admin/sessions/1/files/preview')).code).not.toBe(0);

    // download：attachment 流；越界拒绝
    const dl = await app.inject({ method: 'GET', url: '/v1/admin/sessions/1/files/download?path=README.md' });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toContain('attachment');
    expect(dl.body).toBe('hello\nworld');
    expect((await get('/v1/admin/sessions/1/files/download?path=../outside.txt')).code).toBe(ErrorCode.FORBIDDEN.code);
    expect((await get('/v1/admin/sessions/1/files/download')).code).not.toBe(0);

    // download-zip：path 缺省 = 整个工作区；子目录；流后临时文件清理
    const zipSpy = vi.spyOn(workspaceBrowseService, 'zipDirectory');
    const zipAll = await app.inject({ method: 'GET', url: '/v1/admin/sessions/1/files/download-zip' });
    expect(zipAll.statusCode).toBe(200);
    expect(zipAll.headers['content-type']).toContain('application/zip');
    expect(zipAll.headers['content-disposition']).toContain('attachment');
    expect(Buffer.from(zipAll.rawPayload).subarray(0, 2).toString('latin1')).toBe('PK');
    const zipAllPath = (await zipSpy.mock.results[0].value).zipPath as string;
    expect(zipAllPath.startsWith(tmpdir())).toBe(true);
    const zipSub = await app.inject({ method: 'GET', url: '/v1/admin/sessions/1/files/download-zip?path=notes' });
    expect(zipSub.statusCode).toBe(200);
    expect(Buffer.from(zipSub.rawPayload).subarray(0, 2).toString('latin1')).toBe('PK');
    // 流关闭后临时 zip 应被清理（file.routes.ts 同款 close/error 双钩子）
    await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(zipAllPath)).toBe(false);

    // 属主是他人时正常返回（D1：不做出属主校验，x-test-user 默认 42 ≠ session.userId 7）
    expect((await get('/v1/admin/sessions/1/files/directory')).code).toBe(0);

    await app.close();
  });
});
