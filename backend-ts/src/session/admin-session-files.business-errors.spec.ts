import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { handleError } from '../common/http-error.js';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { WorkspaceBrowseService } from '../file/workspace-browse.service.js';
import { registerAdminSessionFilesRoutes } from './admin-session-files.routes.js';
import type { SessionService } from './session.service.js';
import { useTmpDir } from '../testing/tmp-dir.js';

/**
 * 回归测试：平台约定业务错误（PARAM_INVALID / SESSION_NOT_FOUND 等）经 handleError 归一为
 * HTTP 200 + Result JSON（http-error.ts：仅 1001/401→401、1002/403→403，其余一律 200）。
 * admin useWorkspaceFiles.ts 的 fetchBytes 因此必须在 resp.ok 之外识别「无 Content-Disposition
 * 且 content-type 为 JSON → code !== 0」，否则 download/preview/download-zip 的错误体会被当成
 * 文件 blob（修复前：下载落盘内容为错误 JSON 的损坏文件、PDF 预览渲染 JSON、zip 超限无提示）。
 * 本用例用真实 HTTP + 与前端逐行一致的 fetchBytes 逻辑守护该契约。
 */

// ---- 以下三个函数逐行复制自 admin/src/views/session/composables/useWorkspaceFiles.ts ----
function parseDownloadFileName(disposition: string | null): string | undefined {
  if (!disposition) return undefined
  const starMatch = disposition.match(/filename\*=UTF-8''([^;]+)/i)
  if (starMatch) {
    try {
      return decodeURIComponent(starMatch[1].trim())
    } catch {
      return undefined
    }
  }
  const plainMatch = disposition.match(/filename="?([^";]+)"?/i)
  if (plainMatch) return plainMatch[1].trim()
  return undefined
}

async function extractFetchError(resp: Response): Promise<string> {
  try {
    const contentType = resp.headers.get('content-type') || ''
    if (contentType.includes('application/json')) {
      const body = await resp.json()
      if (body?.message) return body.message
    }
  } catch {
    /* 忽略解析失败，回落通用提示 */
  }
  return `请求失败（HTTP ${resp.status}）`
}

async function fetchBytes(url: string): Promise<{ blob?: Blob; fileName?: string; error?: string }> {
  const token = null // Node 环境无 localStorage，与前端无 token 分支等价
  let resp: Response
  try {
    resp = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    })
  } catch (e) {
    return { error: (e as Error)?.message || '网络错误' }
  }
  if (!resp.ok) {
    return { error: await extractFetchError(resp) }
  }
  const disposition = resp.headers.get('content-disposition')
  const contentType = resp.headers.get('content-type') || ''
  if (!disposition && contentType.includes('application/json')) {
    try {
      const body = await resp.json()
      if (body?.code !== undefined && body.code !== 0) {
        return { error: body.message || '请求失败' }
      }
    } catch {
      /* 解析失败回落按文件流处理 */
    }
  }
  return { blob: await resp.blob(), fileName: parseDownloadFileName(disposition) }
}
// ---- 复制结束 ----

describe('admin session files: fetchBytes 必须识别 HTTP200 JSON 错误体', () => {
  it('download / download-zip / preview 的业务错误应 surfaced 为 error，而不是文件 blob', { timeout: 30000 }, async () => {
    const app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => {
      req.userId = 42;
      done();
    });

    const root = useTmpDir('mao-admin-files-bugcheck-');
    const workspace = join(root, 'ws');
    mkdirSync(join(workspace, 'notes'), { recursive: true });
    writeFileSync(join(workspace, 'README.md'), 'hello\nworld');
    writeFileSync(join(workspace, 'notes', 'deep.txt'), 'deep');
    writeFileSync(join(workspace, 'not-a-pdf.pdf'), '这是伪装成 pdf 的文本内容');

    const sessions = new Map<number, { id: number; userId: number; workspace: string | null; executionMode: string }>([
      [1, { id: 1, userId: 7, workspace, executionMode: 'CLOUD' }],
    ]);
    const sessionService = {
      getSession: vi.fn(async (id: number) => {
        const session = sessions.get(id);
        if (session == null) throw new BusinessException(ErrorCode.SESSION_NOT_FOUND);
        return session;
      }),
    } as unknown as Pick<SessionService, 'getSession'>;
    const permissionService = { hasPermission: vi.fn(async () => true) };

    const workspaceBrowseService = new WorkspaceBrowseService(new PathSandbox(root));
    registerAdminSessionFilesRoutes(app, { sessionService, workspaceBrowseService, permissionService });

    await app.listen({ port: 0, host: '127.0.0.1' });
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

    // 1) 单文件下载不存在的文件：后端 PARAM_INVALID(2001)「文件不存在」→ HTTP 200 + JSON
    const dl = await fetchBytes(`${base}/v1/admin/sessions/1/files/download?path=ghost.txt`);
    expect(dl.error).toContain('文件不存在');
    expect(dl.blob).toBeUndefined();

    // 2) 整目录 zip 不存在目录：PARAM_INVALID「目录不存在」
    const zip = await fetchBytes(`${base}/v1/admin/sessions/1/files/download-zip?path=ghost-dir`);
    expect(zip.error).toContain('目录不存在');
    expect(zip.blob).toBeUndefined();

    // 2b) 方案 §5.5 承诺明确报错的「目录过大」：把上限调到 10 字节复现
    workspaceBrowseService.setMaxZipBytes(10);
    const tooLarge = await fetchBytes(`${base}/v1/admin/sessions/1/files/download-zip`);
    expect(tooLarge.error).toContain('目录过大');
    expect(tooLarge.blob).toBeUndefined();
    workspaceBrowseService.setMaxZipBytes(1024 * 1024 * 1024);

    // 3) PDF 预览非 PDF 内容：PARAM_INVALID「不是有效的 PDF」
    const pdf = await fetchBytes(`${base}/v1/admin/sessions/1/files/preview?path=not-a-pdf.pdf`);
    expect(pdf.error).toContain('不是有效的 PDF');
    expect(pdf.blob).toBeUndefined();

    // 4) 对照组：FORBIDDEN(1002) 走真 403，当前实现已能正确识别
    const forbidden = await fetchBytes(`${base}/v1/admin/sessions/1/files/download?path=../outside.txt`);
    expect(forbidden.error).toContain('路径访问被拒绝');

    // 5) 对照组：正常下载确实拿到文件内容
    const ok = await fetchBytes(`${base}/v1/admin/sessions/1/files/download?path=README.md`);
    expect(await ok.blob!.text()).toBe('hello\nworld');
    expect(ok.fileName).toBe('README.md');

    // undici keep-alive 连接会让 app.close() 挂起：先显式断开再关
    (app.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await app.close();
  });
});
