import { randomUUID } from 'node:crypto';
import { BusinessException } from '../common/business-exception.js';
import { ErrorCode } from '../common/error-code.js';
import type { Session } from '../session/types.js';
import { wsEvent } from '../session/ws/ws-event.js';
import type { StreamingWsRegistry } from '../session/ws/streaming-ws-registry.js';
import type { LocalToolSessionRegistry } from '../harness/local/local-tool-session-registry.js';

/** LOCAL 会话文件浏览的远程操作集合（技术方案 2026-11-17 §4.1）。bytes op P2 引入。 */
export type RemoteFileOp = 'list' | 'read' | 'search' | 'files';

interface PendingFileOp {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  /** 请求实际下发到的连接：断线 failAllForSocket 只失败该连接的请求（连接交接不误杀）。 */
  socket: { id: string } | null;
  timer: ReturnType<typeof setTimeout>;
}

/** 超时档位（D9）：search 的设备端 BFS 有界但大目录可能秒级，单独放宽。 */
const OP_TIMEOUT_MS: Record<RemoteFileOp, number> = { list: 15_000, read: 15_000, files: 15_000, search: 30_000 };

/** 未绑定会话的拒绝文案（对齐 2026-11-05 D15 文案体系）：不广播猜测执行端（D4）。 */
export const REMOTE_FILE_UNBOUND_MESSAGE = '该本地任务未登记执行端设备，请在桌面客户端打开一次完成登记';

export interface RemoteFileProxyDeps {
  wsRegistry: StreamingWsRegistry;
  localToolSessions: Pick<LocalToolSessionRegistry, 'resolveTarget'>;
}

/**
 * LOCAL 会话文件树远程代理（技术方案 2026-11-17）：
 * 浏览器 / 移动端对 LOCAL 会话的文件浏览请求经 WS 定向转发给会话绑定的执行端设备，
 * 设备端 renderer 复用既有 preload 文件原语执行后回传。请求-响应 + 超时 + 断线清理，
 * 机制镜像 LocalToolSessionRegistry 的工具委托，但走独立事件（file_op_request / file_op_result），
 * 不带审批语义、不进 ToolRegistry。
 */
export class RemoteFileProxyService {
  private readonly pending = new Map<string, PendingFileOp>();

  constructor(
    private readonly wsRegistry: StreamingWsRegistry,
    private readonly localToolSessions: Pick<LocalToolSessionRegistry, 'resolveTarget'>,
  ) {}

  /**
   * 代理一次文件浏览操作：解析会话绑定设备 → client-type 感知定向投递（D11）→ 等待回包
   * （D9 超时）→ 按 op 归一化为 CLOUD browse 端点的 DTO 形状（§4.1-5）。全部拒绝路径
   * 抛 BusinessException（中文文案，axios 拦截器可直接展示）。
   * 离线判定收敛在 sendToFileCapableDevice 的全存活连接扫描：不先用 hasDeviceConnection
   * （单执行连接槽口径）做预检——执行连接半死但同设备其它 electron 连接存活时会被误判离线。
   */
  async execute(session: Session, op: RemoteFileOp, params: Record<string, unknown>): Promise<unknown> {
    const target = await this.localToolSessions.resolveTarget(session.id ?? null);
    if (target == null || target.deviceId == null) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, REMOTE_FILE_UNBOUND_MESSAGE);
    }
    const deviceName = session.targetDeviceName ?? target.deviceId;
    const requestId = randomUUID();
    const event = wsEvent('file_op_request', session.id ?? null, {
      requestId,
      op,
      params,
      workspace: session.workspace,
    });
    const dispatch = this.wsRegistry.sendToFileCapableDevice(target.userId, target.deviceId, event);
    if (dispatch.status === 'cliOnly') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '该任务由终端 CLI（mao-agent）执行，暂不支持远程浏览本地文件');
    }
    if (dispatch.status !== 'delivered') {
      // 设备无任何可写连接（离线 / 刚断开）：立即回错，不空等超时（镜像 local-tool-session-registry 的处理）
      throw new BusinessException(ErrorCode.PARAM_INVALID, `执行端设备「${deviceName}」已离线，无法浏览本地文件`);
    }
    const timeoutMs = OP_TIMEOUT_MS[op];
    const data = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new BusinessException(ErrorCode.PARAM_INVALID, `执行端设备响应超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve, reject, socket: dispatch.socket, timer });
    });
    return this.normalizeResult(op, data, session);
  }

  /** 设备端回包入口（ws-handler 的 file_op_result 转发）：ok=false 时 data 为中文错误串。 */
  complete(requestId: string, ok: boolean, data: unknown): void {
    const entry = this.pending.get(requestId);
    if (entry == null) return;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    if (ok) {
      entry.resolve(data);
      return;
    }
    const message = typeof data === 'string' && data.trim().length > 0 ? data : '执行端设备处理文件请求失败';
    entry.reject(new BusinessException(ErrorCode.PARAM_INVALID, message));
  }

  /** 连接断开清理：只失败实际下发到该连接的请求（镜像 failAllForSocket 口径）。 */
  failAllForSocket(socket: { id: string } | null | undefined): void {
    if (socket == null) return;
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.socket !== socket) continue;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.reject(new BusinessException(ErrorCode.PARAM_INVALID, '执行端设备连接已断开，请稍后重试'));
    }
  }

  /** 当前在途请求数（spec 断言用）。 */
  pendingSize(): number {
    return this.pending.size;
  }

  /**
   * 结果归一化（§4.1-5）：设备端 list-directory 条目时间字段是 mtime（epoch ms），
   * CLOUD DTO 是 mtimeMs；目录 / 搜索结果统一补 workspaceRoot（前端 getAbsolutePath 依赖）。
   * files（listWorkspaceFiles）返回数组与 CLOUD DTO 完全同形，仅包一层 { files }；
   * read（localReadFile）形状与 CLOUD FileContentDTO 一致，原样透传。
   */
  private normalizeResult(op: RemoteFileOp, data: unknown, session: Session): unknown {
    if (op === 'list' || op === 'search') {
      const raw = data as { entries?: unknown; truncated?: boolean } | null;
      const entries = Array.isArray(raw?.entries)
        ? (raw!.entries as Array<Record<string, unknown>>).map((entry) => {
          const { mtime, ...rest } = entry;
          return typeof mtime === 'number' ? { ...rest, mtimeMs: mtime } : entry;
        })
        : [];
      return { entries, truncated: raw?.truncated === true, workspaceRoot: session.workspace };
    }
    if (op === 'files') {
      return { files: Array.isArray(data) ? data : [] };
    }
    return data;
  }
}
