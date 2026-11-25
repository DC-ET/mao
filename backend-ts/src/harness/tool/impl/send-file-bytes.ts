import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Readable } from 'node:stream';
import { fetchBytesStreamWithContentType } from './fetch-bytes.js';
import type { PathSandbox } from '../../safety/path-sandbox.js';
import { StrictPathResolver } from '../../safety/strict-path.js';

/**
 * 外部发送工具（微信/飞书/钉钉）本地文件字节读取的统一收口（技术方案 §5.8）。
 *
 * 切分原则：读文件必须与 Agent 工作区同视图（docker 模式下文件可能只存在于容器内，
 * 如 /tmp 中间产物）；平台上传发送留宿主机（appSecret 是组织级共享凭据，不能进容器）。
 *
 * 2026-11-25 send_file 1GB（D2 / R2）：发送快照改走 `openSendBytesStream` 逐段读取，
 * 不再整份进内存；`loadSendFileBytes` 仍为 edit_image 等需要整份字节的调用方保留，
 * 内部同样走同一条流式来源再汇聚。
 */
export interface SendBytesReadInput {
  userId: number | null;
  sessionId: number | null;
  workspace: string | null;
  path: string;
  maxBytes: number;
}

/** 流式来源：size 为源端声明的字节数（http 无 Content-Length 时为 null，边读边计）。 */
export interface SendBytesStream {
  stream: Readable;
  size: number | null;
  contentType: string | null;
  /**
   * 远端整份 sha256（R8 完整性校验）：容器 / LOCAL 执行端提供，宿主机 / http 不提供。
   * 写入完成后与本地计算值比对，不一致即失败。
   */
  digest?: () => Promise<string>;
  /** 释放远端句柄（摘要比对后显式调用；中途失败由流的销毁路径自动收口）。 */
  close?: () => void | Promise<void>;
}

export interface SendBytesSupport {
  /**
   * docker 模式下向容器请求按区间读取文件；当前用户不走容器时返回 null，
   * 调用方降级为宿主机本地读取。用户走容器但读取失败时直接抛错（容器内写入的
   * /tmp 文件宿主机上不存在，静默降级会把「文件不存在」误导为可本地重试）。
   */
  openStream(input: SendBytesReadInput): Promise<SendBytesStream | null>;
  /**
   * 容器读字节的整份变体（edit_image 等小文件调用方）：默认由 openStream 汇聚；
   * 实现可覆盖以避免一次额外的流包装。
   */
  readBytes(input: SendBytesReadInput): Promise<Buffer | null>;
  /** 宿主机本地严格读取的额外允许根（当前用户 runtime/HOME + /tmp）。 */
  extraRoots(userId: number | null): string[];
  /**
   * 跨成员本地路径的宿主侧预检（技术方案 2026-11-04 §5.9 第 3 条）：必须在向容器分发
   * 读取之前调用——docker 用户先命中容器会拿到通用 Path escape，拿不到含 URL 的文案。
   * 命中他人 `runtime/{uid}` / `uploads/{uid}` 时返回可执行文案（uploads 带公开 URL）。
   */
  foreignPathMessage?(src: string, userId: number | null, hint?: string | null): Promise<string | null> | string | null;
}

/**
 * 发送工具本轮的容器键快照（技术方案 2026-11-07 复合容器方案 §5.6/§5.9）：dispatcher 在
 * SERVER_ONLY 分支把按轮快照的 agentId 放进 AsyncLocalStorage，read-bytes-bridge
 * 读取它路由读请求——保证轮中切 Agent 后同一轮的 docker-only 工具与 send 工具
 * 路由到同一容器（禁止在工具调用点现读 session.agentId 的不变量）。
 * 桥侧在快照缺失（host 用户 / 旧调用方）时保留按会话查库兜底。
 */
export const sendToolRoundContext = new AsyncLocalStorage<{ agentId: number }>();

export interface SendBytesCallContext {
  userId: number | null;
  sessionId: number | null;
  workspace: string | null;
  /**
   * 调用方附加的行为提示（如 edit_image 的「改图请重新生成」）：
   * 仅在跨成员路径预检命中时追加到错误文案末尾。
   */
  pathPolicyHint?: string | null;
}

/**
 * 外部发送工具共用的字节来源：URL 直连宿主机下载（与容器无关），
 * 本地路径优先走容器（docker 模式），否则宿主机严格解析后流式打开。
 * `Detailed` 变体额外带响应 content-type（http 来源），供会话副本推导扩展名 / mime。
 */
export interface LoadedSendBytes {
  bytes: Buffer;
  contentType: string | null;
}

export async function loadSendFileBytes(
  src: string,
  pathSandbox: PathSandbox,
  support: SendBytesSupport | null,
  ctx: SendBytesCallContext,
  maxBytes: number,
): Promise<Buffer> {
  return (await loadSendFileBytesDetailed(src, pathSandbox, support, ctx, maxBytes)).bytes;
}

export async function loadSendFileBytesDetailed(
  src: string,
  pathSandbox: PathSandbox,
  support: SendBytesSupport | null,
  ctx: SendBytesCallContext,
  maxBytes: number,
): Promise<LoadedSendBytes> {
  const opened = await openSendBytesStream(src, pathSandbox, support, ctx, maxBytes);
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of opened.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buf.length;
      if (total > maxBytes) {
        opened.stream.destroy();
        throw new Error(`文件过大，上限 ${Math.floor(maxBytes / (1024 * 1024))}MB`);
      }
      chunks.push(buf);
    }
    return { bytes: Buffer.concat(chunks), contentType: opened.contentType };
  } finally {
    // 容器 / 执行端来源整份读完后释放句柄（宿主机与 http 无 close）
    await opened.close?.();
  }
}

/**
 * 打开发送字节的流式来源（2026-11-25 1GB 方案 D2）：http(s) 直接返回带上下限保护的响应流；
 * 本地路径优先容器（docker），容器返回 null 时按宿主机严格解析后 createReadStream。
 */
export async function openSendBytesStream(
  src: string,
  pathSandbox: PathSandbox,
  support: SendBytesSupport | null,
  ctx: SendBytesCallContext,
  maxBytes: number,
): Promise<SendBytesStream> {
  // 跨成员路径预检（§5.9 第 3 条）：必须在容器分发之前——宿主侧才能拼出公开 URL，
  // 且 host/docker 两种模式拿到同一条可执行文案。
  if (support?.foreignPathMessage != null && ctx.userId != null) {
    const message = await support.foreignPathMessage(src, ctx.userId, ctx.pathPolicyHint ?? null);
    if (message != null) throw new Error(message);
  }
  if (src.startsWith('http://') || src.startsWith('https://')) {
    const fetched = await fetchBytesStreamWithContentType(src, maxBytes);
    return { stream: fetched.stream, size: fetched.size, contentType: fetched.contentType };
  }
  if (support) {
    const fromContainer = await support.openStream({ ...ctx, path: src, maxBytes });
    if (fromContainer != null) return fromContainer;
  }
  return openLocalBytesStream(src, pathSandbox, support?.extraRoots(ctx.userId) ?? [], ctx.workspace, maxBytes);
}

/**
 * 宿主机侧没有这份文件：LOCAL 会话据此回退执行端读取（统一发送媒体方案 §6.1）。
 * 其它读取错误（跨成员预检、容器失败、超限、符号链接越界）不回退，避免把安全 / 大小
 * 问题掩盖成执行端超时。
 */
export class SendBytesNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendBytesNotFoundError';
  }
}

/** 宿主机本地读取：严格解析（越界拒绝）+ 大小上限。保留给需要整份字节的调用方。 */
export async function readLocalBytes(
  src: string,
  pathSandbox: PathSandbox,
  extraRoots: string[],
  workspace: string | null,
  maxBytes: number,
): Promise<Buffer> {
  const opened = openLocalBytesStream(src, pathSandbox, extraRoots, workspace, maxBytes);
  const chunks: Buffer[] = [];
  for await (const chunk of opened.stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * 宿主机本地流式读取：严格解析（越界拒绝）+ 普通文件 + 大小上限，返回已知大小与
 * createReadStream。`stat` 与实际读出字节不一致由快照写入侧按「文件在发送期间被修改」处理。
 */
export function openLocalBytesStream(
  src: string,
  pathSandbox: PathSandbox,
  extraRoots: string[],
  workspace: string | null,
  maxBytes: number,
): SendBytesStream {
  const primaryRoot = workspace != null && workspace !== '' ? workspace : pathSandbox.getEffectiveWorkspaceRoot(null);
  const resolved = new StrictPathResolver(primaryRoot, extraRoots).resolve(src);
  if (!existsSync(resolved)) {
    throw new SendBytesNotFoundError('文件不存在：' + src);
  }
  const st = statSync(resolved);
  if (!st.isFile()) {
    throw new Error('文件不存在：' + src);
  }
  if (st.size > maxBytes) {
    throw new Error(`文件过大（${Math.floor(st.size / (1024 * 1024))}MB），上限 ${Math.floor(maxBytes / (1024 * 1024))}MB`);
  }
  return { stream: createReadStream(resolved), size: st.size, contentType: null };
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
