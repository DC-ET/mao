import { randomUUID } from 'node:crypto';
import type { StreamingWsRegistry, WsSocket } from '../session/ws/streaming-ws-registry.js';

export interface PendingPageToolRequest {
  requestId: string | null;
  future: Promise<string>;
}

export interface PageToolCompletion {
  success: boolean;
  result?: unknown;
  error?: { code?: string; message?: string; elementId?: string };
  snapshotId?: string;
  pageVersion?: string;
}

interface PendingEntry {
  requestId: string;
  sessionId: number;
  /** 发起时绑定的页面连接：只有该连接的回包才能完成请求。 */
  connectionId: string;
  tool: string;
  args: unknown;
  resolve: (value: string) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

export const PAGE_TOOL_TIMEOUT_MS = 30_000;
export const DEFAULT_PAGE_TOOL_TIMEOUT_SECONDS = 180;

/** 配置项以「秒」为单位（app-config），注册表以毫秒计时；在此统一换算，避免单位错配。 */
export function resolveEmbedPageToolTimeoutMs(seconds: number | null | undefined): number {
  const value = typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds
    : DEFAULT_PAGE_TOOL_TIMEOUT_SECONDS;
  return Math.round(value * 1000);
}

/**
 * Embed 页面工具桥：服务端 Agent 工具 → 浏览器 SDK → 结果回传。
 *
 * 与 LOCAL 工具完全隔离：
 * - 独立的 pending 池，不复用 LocalToolSessionRegistry；
 * - 请求只发往该 agent 会话绑定的那个 embed 连接（按连接隔离，不按用户广播）；
 * - 回包必须来自发起请求的连接，且 requestId 未完成过；
 * - 同一会话的页面请求串行派发：前一个完成后才下发下一个，超时从「实际下发」开始计时，
 *   避免并发工具调用排队等待用户逐次确认时耗尽后端超时（动作已执行但结果被丢弃）。
 */
export class EmbedPageToolRegistry {
  private readonly pending = new Map<number, Map<string, PendingEntry>>();
  private readonly queues = new Map<number, PendingEntry[]>();

  constructor(
    private readonly registry: StreamingWsRegistry,
    private readonly timeoutMs: number = PAGE_TOOL_TIMEOUT_MS,
  ) {}

  isEmbedSession(sessionId: number): boolean {
    return this.registry.isEmbedSession(sessionId);
  }

  hasBoundConnection(sessionId: number): boolean {
    return this.registry.getEmbedSessionConnection(sessionId) != null;
  }

  async request(sessionId: number, tool: string, args: unknown): Promise<PendingPageToolRequest> {
    if (!this.registry.isEmbedSession(sessionId)) {
      return errorResult('embed_session_required', '当前会话不是嵌入式页面会话，无法执行页面操作');
    }
    const connection = this.registry.getEmbedSessionConnection(sessionId);
    if (!connection) {
      return errorResult('embed_client_not_connected', '页面连接已断开，请确认浏览器页面仍在打开状态');
    }
    const requestId = randomUUID();
    let resolve!: (value: string) => void;
    const future = new Promise<string>((r) => { resolve = r; });
    const entry: PendingEntry = {
      requestId, sessionId, connectionId: connection.id, tool, args, resolve, timer: null,
    };
    const inFlight = this.pending.get(sessionId);
    if (inFlight && inFlight.size > 0) {
      let queue = this.queues.get(sessionId);
      if (!queue) { queue = []; this.queues.set(sessionId, queue); }
      queue.push(entry);
    } else {
      this.dispatch(entry);
    }
    return { requestId, future };
  }

  /**
   * SDK 回包入口。只有发起请求时绑定的连接、且 requestId 仍在等待中时才会被接受。
   * 返回是否消费了该回包。
   */
  complete(sessionId: number, requestId: string, connection: WsSocket, completion: PageToolCompletion): boolean {
    const entry = this.pending.get(sessionId)?.get(requestId);
    if (!entry || entry.connectionId !== connection.id) return false;
    const payload: Record<string, unknown> = { success: completion.success === true };
    if (completion.result !== undefined) payload.result = completion.result;
    if (completion.error != null) payload.error = completion.error;
    if (completion.snapshotId !== undefined) payload.snapshotId = completion.snapshotId;
    if (completion.pageVersion !== undefined) payload.pageVersion = completion.pageVersion;
    this.settle(entry, JSON.stringify(payload));
    return true;
  }

  /** 会话取消/页面断线/服务关闭：立即以错误结束所有等待中与排队中的请求。 */
  failSession(sessionId: number, message: string, code = 'task_cancelled'): void {
    const payload = JSON.stringify({ success: false, error: { code, message } });
    const inFlight = this.pending.get(sessionId);
    const queued = this.queues.get(sessionId);
    this.pending.delete(sessionId);
    this.queues.delete(sessionId);
    for (const entry of inFlight?.values() ?? []) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(payload);
    }
    for (const entry of queued ?? []) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.resolve(payload);
    }
  }

  pendingCount(sessionId?: number): number {
    const countOf = (id: number): number => (this.pending.get(id)?.size ?? 0) + (this.queues.get(id)?.length ?? 0);
    if (sessionId != null) return countOf(sessionId);
    let total = 0;
    for (const id of new Set([...this.pending.keys(), ...this.queues.keys()])) total += countOf(id);
    return total;
  }

  private dispatch(entry: PendingEntry): void {
    const connection = this.registry.getEmbedSessionConnection(entry.sessionId);
    if (!connection) {
      entry.resolve(JSON.stringify({
        success: false,
        error: { code: 'embed_client_not_connected', message: '页面连接不可用，页面操作未下发' },
      }));
      this.drain(entry.sessionId);
      return;
    }
    entry.connectionId = connection.id;
    let map = this.pending.get(entry.sessionId);
    if (!map) { map = new Map(); this.pending.set(entry.sessionId, map); }
    map.set(entry.requestId, entry);
    entry.timer = setTimeout(() => {
      this.settle(entry, JSON.stringify({
        success: false,
        error: { code: 'page_tool_timeout', message: `页面操作超时（${Math.round(this.timeoutMs / 1000)} 秒未返回）` },
      }));
    }, this.timeoutMs);
    entry.timer.unref?.();
    let delivered = false;
    try {
      delivered = this.registry.sendPageToolRequest(entry.sessionId, entry.requestId, entry.tool, entry.args);
    } catch {
      delivered = false;
    }
    if (!delivered) {
      this.settle(entry, JSON.stringify({
        success: false,
        error: { code: 'embed_client_not_connected', message: '页面连接不可用，页面操作未下发' },
      }));
    }
  }

  private settle(entry: PendingEntry, value: string): void {
    const map = this.pending.get(entry.sessionId);
    if (!map?.has(entry.requestId)) return;
    map.delete(entry.requestId);
    if (map.size === 0) this.pending.delete(entry.sessionId);
    if (entry.timer) clearTimeout(entry.timer);
    entry.resolve(value);
    this.drain(entry.sessionId);
  }

  private drain(sessionId: number): void {
    if ((this.pending.get(sessionId)?.size ?? 0) > 0) return;
    const queue = this.queues.get(sessionId);
    const next = queue?.shift();
    if (!next) {
      if (queue) this.queues.delete(sessionId);
      return;
    }
    if (queue && queue.length === 0) this.queues.delete(sessionId);
    this.dispatch(next);
  }
}

function errorResult(code: string, message: string): PendingPageToolRequest {
  return { requestId: null, future: Promise.resolve(JSON.stringify({ success: false, error: { code, message } })) };
}
