/**
 * `file_fetch` 委托读取（方案 2026-11-18 §5.3）：服务端把正文图片按需读取请求下发给
 * mao-agent 执行端，这里做信任边界内的路径校验并读字节，回传分片由 executor 编排。
 *
 * 同文件还承载 `delivery_read`（统一发送媒体方案 2026-11-18 §6.2；2026-11-25 send_file 1GB
 * R2 改为服务端窗口拉取）：send_image / send_file 在 LOCAL 会话读不到本机文件时委托执行端
 * **按区间**读取。两者读盘校验同构，差别在：
 * file_fetch 只认相对路径 + 图片白名单 + 10MB；delivery_read 允许 workspace 内绝对路径、
 * 任意扩展名、上限 1GB，且由执行端持有句柄逐片响应。
 *
 * 语义口径与桌面端 localWorkspaceRead.cjs / 服务端 LocalDeliveryFetchService 对齐：
 * - 相对路径、`/` 为唯一分隔符（拒反斜杠 / UNC / 绝对 / `..` / 盘符段）；
 * - 图片扩展名白名单（仅位图，svg 排除）；与 backend-ts 双端各自维护同表，改动须同步；
 * - 拼装后 containment（path.relative 校验，`..` 逃逸产出 `..\\` 前缀即拒）；
 * - 普通文件 + 非符号链接 + 上限。
 * file_fetch 校验失败抛 Error，由 executor 静默吞掉（不回包，对齐 isOutsideTrust 先例）；
 * delivery_read 的错误则显式回包（服务端要区分「文件过大」与「执行端版本过旧」）。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { isWorkspaceWithin } from './sandbox';

/** 单文件字节上限；与 backend-ts LocalFileFetchService.FILE_FETCH_MAX_BYTES 同表。 */
export const FILE_FETCH_MAX_BYTES = 10 * 1024 * 1024;
/** 单片原始字节上限；与 backend-ts FILE_FETCH_CHUNK_BYTES / 桌面端同表，改动须三端同步。 */
export const FILE_FETCH_CHUNK_BYTES = 512 * 1024;
/** 分片总数上限（10MB / 512KB）；与 backend-ts FILE_FETCH_MAX_CHUNKS 同表。 */
export const FILE_FETCH_MAX_CHUNKS = 20;
/** delivery_read 单文件上限（对话页快照上限 1GB）；与 backend-ts SEND_FILE_MAX_BYTES / 桌面端同表。 */
export const DELIVERY_READ_MAX_BYTES = 1024 * 1024 * 1024;
/** delivery_read 单片原始字节上限；与 backend-ts DELIVERY_READ_CHUNK_BYTES / 桌面端同表。 */
export const DELIVERY_READ_CHUNK_BYTES = 512 * 1024;
/** delivery_read 分片总数上限（1GB / 512KB = 2048）；与 backend-ts DELIVERY_FETCH_MAX_CHUNKS 同表。 */
export const DELIVERY_FETCH_MAX_CHUNKS = DELIVERY_READ_MAX_BYTES / DELIVERY_READ_CHUNK_BYTES;
/** 图片扩展名白名单（仅位图；svg 有脚本执行面，排除）。与 backend-ts 同表镜像，改动须双端同步。 */
export const FILE_FETCH_IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif']);

/** 校验并解析 workspace 内的图片路径；非法 / 越界抛 Error（executor 静默吞掉）。 */
export function resolveWorkspaceImagePath(workspace: string, relativePath: string): string {
  if (relativePath.trim() === '') throw new Error('file_fetch: 缺少文件路径');
  if (relativePath.includes('\\')) throw new Error(`file_fetch: 路径含反斜杠，拒绝读取 ${relativePath}`);
  if (relativePath.startsWith('/') || path.isAbsolute(relativePath) || /^[a-zA-Z]:/.test(relativePath)) {
    throw new Error(`file_fetch: 拒绝绝对路径 ${relativePath}`);
  }
  const segments = relativePath.split('/');
  if (segments.some((seg) => seg.length === 0 || seg === '.' || seg === '..' || seg.includes(':'))) {
    throw new Error(`file_fetch: 路径不合法 ${relativePath}`);
  }
  const ext = segments[segments.length - 1].split('.').pop()?.toLowerCase() ?? '';
  if (!FILE_FETCH_IMAGE_EXTENSIONS.has(ext)) {
    throw new Error(`file_fetch: 非图片扩展名，拒绝读取 ${relativePath}`);
  }
  const target = path.resolve(workspace, ...segments);
  if (!isWorkspaceWithin(target, workspace)) {
    throw new Error(`file_fetch: 拼装结果越出工作区，拒绝读取 ${relativePath}`);
  }
  return target;
}

/** 信任边界内读取图片字节：普通文件 + 非符号链接 + 大小上限（对齐桌面 localFileBytes 口径）。 */
export async function readWorkspaceImageBytes(workspace: string, relativePath: string): Promise<Buffer> {
  const target = resolveWorkspaceImagePath(workspace, relativePath);
  const lst = await fs.lstat(target);
  if (!lst.isFile() || lst.isSymbolicLink()) {
    throw new Error(`file_fetch: 不是普通文件或为符号链接，拒绝读取 ${relativePath}`);
  }
  if (lst.size > FILE_FETCH_MAX_BYTES) {
    throw new Error(`file_fetch: 文件过大（${lst.size} bytes），上限 ${FILE_FETCH_MAX_BYTES}`);
  }
  return fs.readFile(target);
}

/** 按单片字节数切分（末片可短）；单片数超过 FILE_FETCH_MAX_CHUNKS 由调用方在 total 层面拒绝。 */
export function chunkBuffer(bytes: Buffer, chunkBytes = FILE_FETCH_CHUNK_BYTES): Buffer[] {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    chunks.push(bytes.subarray(offset, offset + chunkBytes));
  }
  return chunks;
}

/**
 * `delivery_read` 的执行端路径解析（方案 2026-11-18-unified-send-media §6.2）：相对路径，
 * 或「解析后仍在该会话 workspace 内」的绝对路径（send 工具允许 absolute-within-workspace）。
 * containment 是 realpath 口径（`..` / 父级目录 symlink 逃逸靠 realpath 比对拒绝）；
 * 相对路径的反斜杠、NUL、目标本身是符号链接与越界路径一律拒绝。
 *
 * 反斜杠按平台语义放行：相对路径 `/` 为唯一分隔符（拒 `a\\..\\..` 分段走私）；
 * 绝对路径在 Windows 上必然含反斜杠，放行交给后面的 realpath containment 兜底
 * （桌面端 localWorkspaceRead.cjs 同构，改动须双端同步）。
 */
export async function resolveDeliveryWorkspacePath(workspace: string, filePath: string): Promise<string> {
  if (filePath.trim() === '') throw new Error('delivery_read: 缺少文件路径');
  if (!path.isAbsolute(filePath) && filePath.includes('\\')) {
    throw new Error(`delivery_read: 路径含反斜杠，拒绝读取 ${filePath}`);
  }
  if (filePath.includes('\0')) throw new Error('delivery_read: 路径含非法字符，拒绝读取');
  const root = path.resolve(workspace);
  // path.resolve 对绝对 filePath 原样返回，containment 仍由下面的 realpath 比对兜住
  const target = path.resolve(root, filePath);
  // 目标本身是符号链接直接拒绝（realpath 会跟到目标，之后 lstat 就看不出来了）
  const direct = await fs.lstat(target).catch(() => null);
  if (direct == null) throw new Error(`delivery_read: 文件不存在，拒绝读取 ${filePath}`);
  if (direct.isSymbolicLink()) throw new Error(`delivery_read: 不接受符号链接 ${filePath}`);
  const [rootReal, targetReal] = await Promise.all([fs.realpath(root), fs.realpath(target)]);
  const rel = path.relative(rootReal, targetReal);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`delivery_read: 拼装结果越出工作区，拒绝读取 ${filePath}`);
  }
  return targetReal;
}

/** 已打开的发送读取句柄（executor 按 streamId 持有，空闲 60 秒关闭）。 */
export interface DeliveryOpenHandle {
  handle: FileHandle;
  size: number;
  mtimeMs: number;
}

/**
 * 打开发送读取流：路径校验 + 普通文件 / 非符号链接 + 上限。
 * 返回句柄后由 readDeliveryChunk 按 offset 读取，避免 1GB 整份进内存（R2）。
 */
export async function openDeliveryFile(
  workspace: string,
  filePath: string,
  maxBytes = DELIVERY_READ_MAX_BYTES,
): Promise<DeliveryOpenHandle> {
  const limit = Number.isInteger(maxBytes) && maxBytes > 0
    ? Math.min(maxBytes, DELIVERY_READ_MAX_BYTES)
    : DELIVERY_READ_MAX_BYTES;
  const target = await resolveDeliveryWorkspacePath(workspace, filePath);
  const handle = await fs.open(target, 'r');
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Error(`delivery_read: 不是普通文件，拒绝读取 ${filePath}`);
    if (st.size > limit) {
      throw new Error(`delivery_read: 文件过大（${Math.floor(st.size / (1024 * 1024))}MB），上限 ${Math.floor(limit / (1024 * 1024))}MB`);
    }
    return { handle, size: Number(st.size), mtimeMs: Number(st.mtimeMs) };
  } catch (e) {
    await handle.close().catch(() => undefined);
    throw e;
  }
}

/** 按区间读取一片；每次 stat 校验 size / mtime，发送期间被改写即失败。 */
export async function readDeliveryChunk(
  opened: DeliveryOpenHandle,
  offset: number,
  length: number,
): Promise<{ bytes: Buffer; size: number; mtimeMs: number }> {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
    throw new Error('delivery_read: 读取区间不合法');
  }
  if (length > DELIVERY_READ_CHUNK_BYTES) throw new Error('delivery_read: 读取区间超过单片上限');
  const st = await opened.handle.stat();
  if (Number(st.size) !== opened.size || Number(st.mtimeMs) !== opened.mtimeMs) {
    throw new Error('delivery_read: 文件在发送期间被修改，请重试');
  }
  const want = Math.min(length, Math.max(0, opened.size - offset));
  const buffer = Buffer.allocUnsafe(want);
  let filled = 0;
  while (filled < want) {
    const { bytesRead } = await opened.handle.read(buffer, filled, want - filled, offset + filled);
    if (bytesRead <= 0) break;
    filled += bytesRead;
  }
  return { bytes: buffer.subarray(0, filled), size: opened.size, mtimeMs: opened.mtimeMs };
}

/** 整份 sha256（R8）：在已打开的句柄上顺序读取并哈希，前后各 stat 一次；不关闭句柄。 */
export async function digestDeliveryFile(opened: DeliveryOpenHandle, onProgress?: () => void): Promise<string> {
  const before = await opened.handle.stat();
  if (Number(before.size) !== opened.size || Number(before.mtimeMs) !== opened.mtimeMs) {
    throw new Error('delivery_read: 文件在发送期间被修改，请重试');
  }
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(DELIVERY_READ_CHUNK_BYTES);
  let offset = 0;
  while (offset < opened.size) {
    // 哈希期间同样算「在用」：1GB 顺序读可能超过 60 秒空闲回收窗口，被 sweep 关掉会读失败
    onProgress?.();
    const length = Math.min(buffer.length, opened.size - offset);
    const { bytesRead } = await opened.handle.read(buffer, 0, length, offset);
    if (bytesRead <= 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    offset += bytesRead;
  }
  const after = await opened.handle.stat();
  if (Number(after.size) !== opened.size || Number(after.mtimeMs) !== opened.mtimeMs) {
    throw new Error('delivery_read: 文件在发送期间被修改，请重试');
  }
  if (offset !== opened.size) {
    throw new Error(`delivery_read: 读取中断（期望 ${opened.size} 字节，实际 ${offset}）`);
  }
  return hash.digest('hex');
}
