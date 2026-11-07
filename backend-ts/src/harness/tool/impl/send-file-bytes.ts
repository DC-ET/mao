import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
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
  /**
   * 跨成员本地路径的宿主侧预检（技术方案 2026-11-04 §5.9 第 3 条）：必须在向容器分发
   * `read_bytes` 之前调用——docker 用户先命中容器会拿到通用 Path escape，拿不到含 URL 的文案。
   * 命中他人 `runtime/{uid}` / `uploads/{uid}` 时返回可执行文案（uploads 带公开 URL）。
   */
  foreignPathMessage?(src: string, userId: number | null, hint?: string | null): Promise<string | null> | string | null;
}

/**
 * 发送工具本轮的容器键快照（2026-11-07 复合容器方案 §5.6/§5.9）：dispatcher 在
 * SERVER_ONLY 分支把按轮快照的 agentId 放进 AsyncLocalStorage，read-bytes-bridge
 * 读取它路由 read_bytes——保证轮中切 Agent 后同一轮的 docker-only 工具与 send 工具
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
  // 跨成员路径预检（§5.9 第 3 条）：必须在容器分发之前——宿主侧才能拼出公开 URL，
  // 且 host/docker 两种模式拿到同一条可执行文案。
  if (support?.foreignPathMessage != null && ctx.userId != null) {
    const message = await support.foreignPathMessage(src, ctx.userId, ctx.pathPolicyHint ?? null);
    if (message != null) throw new Error(message);
  }
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
