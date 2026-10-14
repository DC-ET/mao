import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fetchBytesWithLimits } from './fetch-bytes.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { StrictPathResolver } from '../../safety/strict-path.js';

/**
 * 外部发送工具（微信/飞书/钉钉）本地文件字节读取的统一收口（技术方案 §5.8）。
 *
 * 切分原则：读文件必须与 Agent 工作区同视图（docker 模式下文件可能只存在于容器内，
 * 如 /tmp 中间产物）；平台上传发送留宿主机（appSecret 是组织级共享凭据，不能进容器）。
 */
export interface SendBytesReadInput {
  userId: number | null;
  sessionId: number | null;
  workspace: string | null;
  path: string;
  maxBytes: number;
}

export interface SendBytesSupport {
  /**
   * docker 模式下向容器请求读取本地文件字节；当前用户不走容器时返回 null，
   * 调用方降级为宿主机本地读取。用户走容器但读取失败时直接抛错（容器内写入的
   * /tmp 文件宿主机上不存在，静默降级会把「文件不存在」误导为可本地重试）。
   */
  readBytes(input: SendBytesReadInput): Promise<Buffer | null>;
  /** 宿主机本地严格读取的额外允许根（当前用户 runtime/HOME + /tmp）。 */
  extraRoots(userId: number | null): string[];
}

export interface SendBytesCallContext {
  userId: number | null;
  sessionId: number | null;
  workspace: string | null;
}

/**
 * 外部发送工具共用的 loadBytes：URL 直连宿主机下载（与容器无关），
 * 本地路径优先走容器（docker 模式），否则宿主机严格解析后读取。
 */
export async function loadSendFileBytes(
  src: string,
  pathSandbox: PathSandbox,
  support: SendBytesSupport | null,
  ctx: SendBytesCallContext,
  maxBytes: number,
): Promise<Buffer> {
  if (src.startsWith('http://') || src.startsWith('https://')) {
    return fetchBytesWithLimits(src, maxBytes);
  }
  if (support) {
    const fromContainer = await support.readBytes({ ...ctx, path: src, maxBytes });
    if (fromContainer != null) return fromContainer;
  }
  return readLocalBytes(src, pathSandbox, support?.extraRoots(ctx.userId) ?? [], ctx.workspace, maxBytes);
}

/** 宿主机本地读取：严格解析（越界拒绝）+ 大小上限。 */
export async function readLocalBytes(
  src: string,
  pathSandbox: PathSandbox,
  extraRoots: string[],
  workspace: string | null,
  maxBytes: number,
): Promise<Buffer> {
  const primaryRoot = workspace != null && workspace !== '' ? workspace : pathSandbox.getEffectiveWorkspaceRoot(null);
  const resolved = new StrictPathResolver(primaryRoot, extraRoots).resolve(src);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error('文件不存在：' + src);
  }
  const size = statSync(resolved).size;
  if (size > maxBytes) {
    throw new Error(`文件过大（${Math.floor(size / (1024 * 1024))}MB），上限 ${Math.floor(maxBytes / (1024 * 1024))}MB`);
  }
  return readFile(resolved);
}

/** 同步变体（WeixinMediaToolSupport 等同步读取路径共用）。 */
export function readLocalBytesSync(
  src: string,
  pathSandbox: PathSandbox,
  extraRoots: string[],
  workspace: string | null,
  maxBytes: number,
): Buffer {
  const primaryRoot = workspace != null && workspace !== '' ? workspace : pathSandbox.getEffectiveWorkspaceRoot(null);
  const resolved = new StrictPathResolver(primaryRoot, extraRoots).resolve(src);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error('文件不存在：' + src);
  }
  const size = statSync(resolved).size;
  if (size > maxBytes) {
    throw new Error(`文件过大（${Math.floor(size / (1024 * 1024))}MB），上限 ${Math.floor(maxBytes / (1024 * 1024))}MB`);
  }
  return readFileSync(resolved);
}
