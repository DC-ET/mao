import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { mimeFromPath, readImage } from './tools/files';

/**
 * LOCAL 会话文件树远程代理的设备端执行器——CLI 版（技术方案 2026-11-18 §4.2）。
 * 服务端把 file_op_request 定向投给执行端设备的连接；CLI 在这里用 node fs 实现四个只读 op
 * 并组装 file_op_result 回帧，DTO 逐字段镜像桌面端（desktop/electron/main.cjs 的
 * list-directory / local-read-file / list-workspace-files 与 renderer 的 searchLocalWorkspace），
 * 服务端归一化（remote-file-proxy.service.ts）对两端共用、零改动。
 *
 * 信任收窄不在本模块：request.workspace 已由 executor 层 resolveWorkspace 收窄到本地信任根
 * （与 tool_execute 同款不变量），这里只做 containment——path.resolve 后必须等于工作区或
 * 位于其内（镜像 main.cjs:2272 口径），防 `..` 与绝对路径越界。
 *
 * 与桌面已知的两处口径差异（评审 2026-11-18 记录，勿按「逐字段镜像」误判）：
 * - search 无「每目录 500 条」上限（桌面经 listDirectory 间接继承并忽略 truncated）、
 *   结果 path 恒为 `/` 分隔（桌面继承 path.relative，Windows 为 `\`）；
 * - 图片读取复用 files.ts readImage（同步 fs、≤5MB，daemon 上毫秒级阻塞已接受）；
 *   >5MB 图片回 readImage 的错误文案（桌面同分支也是文本错误帧）。
 */

export type LocalFileOp = 'list' | 'read' | 'search' | 'files';

export interface FileOpRequest {
  requestId: string;
  op: LocalFileOp;
  params: Record<string, unknown>;
  workspace: string;
}

export interface FileOpResultFrame {
  type: 'file_op_result';
  sessionId: number;
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

/** CLI 在 auth 帧声明的能力（ws-client.ts 引用）。 */
export const FILE_OP_CAPABILITIES = ['file_op'];

/** 回帧字节上限：与 desktop/src/utils/local-file-op.ts 的 FILE_OP_MAX_FRAME_BYTES 同值（D8）。 */
export const FILE_OP_MAX_FRAME_BYTES = 700 * 1024;

/** 与桌面 list-directory 同款上限：按 readdir 原始条目数（排序前）判定 truncated。 */
const MAX_LIST_ENTRIES = 500;
/** search 仅排除这两个目录（与桌面 searchLocalWorkspace 同款；勿混用 files op 的 IGNORED_DIRS）。 */
const SEARCH_EXCLUDED_DIRS = new Set(['.git', 'node_modules']);
const SEARCH_MAX_DIRS = 500;
const SEARCH_MAX_DEPTH = 10;
/** files op 跳过的目录（与 main.cjs:2215 IGNORED_DIRS 十二目录同款）。 */
const IGNORED_DIRS = new Set(['node_modules', '__pycache__', '.git', 'target', 'dist', 'build', '.next', '.nuxt', '.venv', 'venv', '.idea', '.vscode']);

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** path.resolve 归一 + containment：返回绝对路径或 null（越界 / 非法输入）。 */
function resolveContained(workspace: string, relative: unknown): string | null {
  if (typeof relative !== 'string' || relative.length === 0) return null;
  const base = path.resolve(workspace);
  const resolved = path.resolve(workspace, relative);
  if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  return null;
}

async function listDirectory(workspace: string, abs: string): Promise<Record<string, unknown>> {
  let dirents;
  try {
    dirents = await fsp.readdir(abs, { withFileTypes: true });
  } catch (e) {
    // 与桌面 existsSync/readdirSync 分层口径一致：ENOENT 报不存在，权限等错误原样透传
    const code = (e as { code?: unknown }).code;
    return { error: code === 'ENOENT' ? 'Directory does not exist' : e instanceof Error ? e.message : String(e) };
  }
  const truncated = dirents.length > MAX_LIST_ENTRIES;
  const entries: Array<Record<string, unknown>> = [];
  for (const entry of dirents) {
    if (entries.length >= MAX_LIST_ENTRIES) break;
    const fullPath = path.join(abs, entry.name);
    let isSymlink = false;
    let size = 0;
    let mtime = 0;
    try {
      const st = await fsp.lstat(fullPath);
      isSymlink = st.isSymbolicLink();
      size = st.size;
      mtime = st.mtimeMs;
    } catch {
      continue;
    }
    entries.push({
      name: entry.name,
      path: path.relative(workspace, fullPath),
      isDirectory: entry.isDirectory() && !isSymlink,
      size,
      mtime,
      isSymlink,
    });
  }
  // 与桌面同款：目录优先、名称排序
  entries.sort((a, b) => ((b.isDirectory as number) - (a.isDirectory as number)) || (a.name as string).localeCompare(b.name as string));
  return { entries, truncated };
}

async function readFileOp(
  workspace: string,
  originalPath: string,
  offset: number,
  limit: number,
): Promise<Record<string, unknown>> {
  // 图片：扩展名命中 + 魔数校验（复用 files.ts readImage；终端版不缩放，5MB 上限同值）
  if (mimeFromPath(originalPath)) {
    return readImage(path.resolve(workspace, originalPath), originalPath);
  }
  if (originalPath.toLowerCase().endsWith('.pdf')) {
    // 与桌面 local-read-file 同款：整文件字节 base64，大文件由 700KB 回帧预检兜底
    const buffer = await fsp.readFile(path.resolve(workspace, originalPath));
    return {
      content: `PDF 文件：${originalPath}`,
      total_lines: 0,
      media_type: 'pdf',
      mime: 'application/pdf',
      data_uri: `data:application/pdf;base64,${buffer.toString('base64')}`,
    };
  }
  const content = await fsp.readFile(path.resolve(workspace, originalPath), 'utf8');
  const lines = content.split('\n');
  const totalLines = lines.length;
  const start = offset || 0;
  const end = limit ? Math.min(start + limit, totalLines) : totalLines;
  return { content: lines.slice(start, end).join('\n'), total_lines: totalLines };
}

async function searchWorkspace(workspace: string, pattern: string, limit?: number): Promise<Record<string, unknown>> {
  const lower = pattern.toLowerCase();
  const maxResults = Math.max(1, Math.min(limit ?? 100, 200));
  const entries: Array<Record<string, unknown>> = [];
  let truncated = false;
  let scanned = 0;
  const queue: { abs: string; rel: string; depth: number }[] = [{ abs: workspace, rel: '', depth: 0 }];
  while (queue.length > 0) {
    if (entries.length >= maxResults || scanned >= SEARCH_MAX_DIRS) {
      truncated = true;
      break;
    }
    const cur = queue.shift()!;
    scanned++;
    let dirents;
    try {
      dirents = await fsp.readdir(cur.abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      if (entries.length >= maxResults) {
        truncated = true;
        break;
      }
      const rel = cur.rel ? `${cur.rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.isSymbolicLink() || SEARCH_EXCLUDED_DIRS.has(entry.name)) continue;
        if (cur.depth >= SEARCH_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        queue.push({ abs: path.join(cur.abs, entry.name), rel, depth: cur.depth + 1 });
        continue;
      }
      if (!entry.name.toLowerCase().includes(lower)) continue;
      try {
        const st = await fsp.lstat(path.join(cur.abs, entry.name));
        entries.push({ name: entry.name, path: rel, isDirectory: false, size: st.size, mtime: st.mtimeMs, isSymlink: st.isSymbolicLink() });
      } catch {
        continue;
      }
    }
  }
  return { entries, truncated };
}

async function listWorkspaceFiles(
  workspace: string,
  filter?: string,
  limit = 20,
): Promise<Array<Record<string, unknown>>> {
  const results: Array<Record<string, unknown>> = [];
  const lowerFilter = filter?.toLowerCase();
  // 与桌面 walkDir 同款：收集上限在遍历中生效（results 满即早退），mtime 排序只作用于已收集集合
  const walk = async (dir: string, relativeBase: string): Promise<void> => {
    if (results.length >= limit) return;
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const sorted = [...dirents].sort((a, b) =>
      a.isDirectory() !== b.isDirectory() ? (a.isDirectory() ? 1 : -1) : a.name.localeCompare(b.name));
    for (const entry of sorted) {
      if (results.length >= limit) return;
      if (entry.name.startsWith('.')) continue;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const relPath = relativeBase ? `${relativeBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), relPath);
        continue;
      }
      try {
        const st = await fsp.stat(path.join(dir, entry.name));
        if (!lowerFilter || entry.name.toLowerCase().includes(lowerFilter) || relPath.toLowerCase().includes(lowerFilter)) {
          results.push({ path: relPath, name: entry.name, size: st.size, mtime: st.mtimeMs });
        }
      } catch {
        continue;
      }
    }
  };
  await walk(workspace, '');
  results.sort((a, b) => (b.mtime as number) - (a.mtime as number));
  return results.map(({ mtime: _mtime, ...rest }) => rest);
}

async function runOp(request: FileOpRequest): Promise<unknown> {
  const { op, params, workspace } = request;
  if (!workspace || typeof workspace !== 'string') {
    throw new Error('缺少工作区路径');
  }
  switch (op) {
    case 'list': {
      const abs = resolveContained(workspace, params.dir !== undefined ? params.dir : '.');
      if (abs == null) throw new Error('路径越出工作区范围');
      return await listDirectory(workspace, abs);
    }
    case 'read': {
      const abs = resolveContained(workspace, params.path);
      if (abs == null) throw new Error('路径越出工作区范围');
      return await readFileOp(
        workspace,
        abs,
        typeof params.offset === 'number' ? params.offset : 0,
        typeof params.limit === 'number' ? params.limit : 5000,
      );
    }
    case 'search': {
      if (typeof params.pattern !== 'string' || params.pattern.trim().length === 0) {
        throw new Error('缺少搜索关键词');
      }
      return await searchWorkspace(workspace, params.pattern, typeof params.limit === 'number' ? params.limit : 100);
    }
    case 'files': {
      // 镜像桌面 maxResults = limit || 20：0 / 负数回落 20（服务端 ?limit=0 会原样下发）
      const filesLimit = typeof params.limit === 'number' && params.limit > 0 ? params.limit : 20;
      return await listWorkspaceFiles(workspace, asOptionalString(params.filter), filesLimit);
    }
    default:
      throw new Error(`不支持的文件操作类型: ${String(op)}`);
  }
}

/**
 * 执行一次文件代理请求并组装回帧。永不抛错：任何失败（越界 / IPC 报错 / 结果超尺寸）
 * 都收敛为 ok=false 的中文错误帧，由服务端透传给发起端展示。设备端原语返回
 * `{ error }`（如「Directory does not exist」）时同样收敛为失败帧。
 */
export async function executeFileOp(sessionId: number, request: FileOpRequest): Promise<FileOpResultFrame> {
  const base = { type: 'file_op_result' as const, sessionId, requestId: request.requestId };
  try {
    let data: unknown;
    try {
      data = await runOp(request);
    } catch (e) {
      return { ...base, ok: false, error: e instanceof Error ? e.message : '文件操作执行失败' };
    }
    if (data != null && typeof data === 'object' && typeof (data as { error?: unknown }).error === 'string') {
      return { ...base, ok: false, error: (data as { error: string }).error };
    }
    const frame: FileOpResultFrame = { ...base, ok: true, data };
    // 最终整帧 UTF-8 字节预检（D8）：不能用字符串 length——那是 UTF-16 数，中文 3 字节/字符会系统性低估
    if (Buffer.byteLength(JSON.stringify(frame), 'utf8') > FILE_OP_MAX_FRAME_BYTES) {
      return { ...base, ok: false, error: '文件过大，移动端暂不支持查看该文件' };
    }
    return frame;
  } catch (e) {
    return { ...base, ok: false, error: e instanceof Error ? e.message : '文件操作执行失败' };
  }
}
