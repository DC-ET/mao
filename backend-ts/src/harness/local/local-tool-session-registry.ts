import { randomUUID } from 'node:crypto';
import type { Session, SessionMapper, StreamingWsRegistry } from '../deps.js';
import { wsEvent } from '../deps.js';
import { harnessLog } from '../log.js';
import type { ApprovalHint } from '../approval/approval-hint.js';

/**
 * 本地执行端未连接时工具请求的失败回执（JSON error 字段）。该文案进入工具结果、
 * 经 tool-result-summarizer 汇总后展示在工具卡片上，多端用户可见，须中文。
 */
export const LOCAL_CLIENT_OFFLINE_TOOL_ERROR = '本地执行端未连接，请确保桌面客户端正在运行';

/** 本地执行端未连接时文件读取（file_fetch）的失败回执。与工具文案分开，图片下载场景用户可见。 */
export const LOCAL_EXECUTOR_OFFLINE_FILE_ERROR = '本地执行端未连接，无法读取本地文件';
/** 发送字节委托读取的离线文案：旧执行端静默忽略帧与真离线不可区分，合并成一句（§6.2 评审补充）。 */
export const LOCAL_EXECUTOR_OFFLINE_DELIVERY_ERROR = '执行端不在线或版本过旧，无法读取本机文件';

export interface PendingLocalToolRequest {
  requestId: string | null;
  future: Promise<string>;
  resolve: (v: string) => void;
  /**
   * 是否定向投递给绑定设备（true = 该设备的回包具有权威性；false = 用户级广播，
   * 多个执行端都可能响应，错误回包要与成功回包竞争）。
   */
  directed: boolean;
}

/** 会话执行目标：userId + 绑定的执行端设备（deviceId 为 null = 未绑定，走用户级广播回退）。 */
export interface LocalToolTarget {
  userId: number;
  deviceId: string | null;
}

/**
 * LOCAL 会话的委托目标注册表（技术方案 2026-11-05 §4.1-3）。
 * - sessionToUser：会话归属（既有）；
 * - sessionToDevice：会话绑定的执行端设备 id（创建即定、不可改绑；空 = 未绑定）；
 * 两个映射都是进程内缓存，缓存未命中时以 DB 的 session.target_device_id 兜底；
 * 工具下发按绑定设备定向（sendToDevice），未绑定保持用户级广播（sendToLocalClients）。
 */
export class LocalToolSessionRegistry {
  private readonly sessionToUser = new Map<number, number>();
  private readonly sessionToDevice = new Map<number, string | null>();
  private readonly pendingRequests = new Map<number, Map<string, { resolve: (v: string) => void; socket: { id: string } | null }>>();

  constructor(
    private readonly streamingWsRegistry: StreamingWsRegistry,
    private readonly sessionMapper: SessionMapper,
  ) {}

  /** 登记 / 刷新会话的执行目标。同会话重复调用以最新 deviceId 为准（惰性认领后即时生效）。 */
  setTargetForSession(sessionId: number, userId: number, deviceId?: string | null): void {
    const normalized = deviceId != null && deviceId !== '' ? deviceId : null;
    const existing = this.sessionToUser.get(sessionId);
    if (existing != null && existing !== userId) {
      harnessLog('warn', `Session ${sessionId} already registered to user ${existing}, re-registering to user ${userId}`);
      this.failAllPending(sessionId, 'Session re-registered to different user');
    }
    this.sessionToUser.set(sessionId, userId);
    // 不可改绑 / null 不清空：非空新值与已绑非空值冲突时保留既有绑定；
    // null（未绑定 / 刷新登记）不覆盖已绑定值——绑定只能由创建或惰性认领建立。
    const bound = this.sessionToDevice.get(sessionId) ?? null;
    if (bound != null && normalized != null && bound !== normalized) {
      harnessLog('warn', `Session ${sessionId} target device already bound to ${bound}, ignore re-bind to ${normalized}`);
      this.sessionToDevice.set(sessionId, bound);
    } else {
      this.sessionToDevice.set(sessionId, normalized ?? bound ?? null);
    }
  }

  removeSession(sessionId: number): void {
    this.sessionToUser.delete(sessionId);
    this.sessionToDevice.delete(sessionId);
    this.failAllPending(sessionId, 'Session unregistered');
  }

  failAllForUser(userId: number): void {
    const sessions: number[] = [];
    for (const [sid, uid] of this.sessionToUser) {
      if (uid === userId) sessions.push(sid);
    }
    for (const sid of sessions) {
      this.sessionToUser.delete(sid);
      this.sessionToDevice.delete(sid);
      this.failAllPending(sid, 'User disconnected');
    }
  }

  /**
   * 连接断开清理：只失败实际下发到该连接的 pending 请求。
   * 工具请求只投给当时的执行连接——同设备多连接时执行连接可能已交接，
   * 不能按「设备」一把失败（会把仍在旧连接上执行的结果误杀）。
   */
  failAllForSocket(socket: { id: string } | null | undefined): void {
    if (socket == null) return;
    for (const [sessionId, map] of [...this.pendingRequests]) {
      for (const [requestId, entry] of [...map]) {
        // 按连接 id 比较：定向到已认领连接（delivery_read 的 read/digest）时只记了 id，
        // 引用比较会让这些请求漏掉断线失败，白等到 60s / 300s 超时。
        if (entry.socket == null || entry.socket.id !== socket.id) continue;
        map.delete(requestId);
        entry.resolve(JSON.stringify({ error: 'Device disconnected' }));
      }
      if (map.size === 0) this.pendingRequests.delete(sessionId);
    }
  }

  /**
   * 设备断线清理：失败绑定到该设备的全部会话 pending 工具请求。
   * 会话绑定本身保留（设备闪断重连后可继续使用），后续 reachability 由 hasDeviceConnection 判定。
   */
  failAllForDevice(userId: number, deviceId: string): void {
    for (const [sid, uid] of this.sessionToUser) {
      if (uid !== userId) continue;
      if (this.sessionToDevice.get(sid) !== deviceId) continue;
      this.failAllPending(sid, 'Device disconnected');
    }
  }

  /** 会话目标是否可达：绑定设备 → 设备级；未绑定 → 用户级（既有口径）。 */
  async isConnected(sessionId: number | null): Promise<boolean> {
    const target = await this.resolveTarget(sessionId);
    if (target == null) return false;
    if (target.deviceId != null) {
      return this.streamingWsRegistry.hasDeviceConnection(target.userId, target.deviceId);
    }
    return this.streamingWsRegistry.hasLocalClientConnection(target.userId);
  }

  getUserIdForSession(sessionId: number | null): Promise<number | null> {
    return this.resolveUserId(sessionId);
  }

  async resolveUserId(sessionId: number | null): Promise<number | null> {
    if (sessionId == null) return null;
    const cached = this.sessionToUser.get(sessionId);
    if (cached != null) return cached;
    const session = await this.sessionMapper.selectById(sessionId);
    if (!session) return null;
    if (session.userId != null) return session.userId;
    if (session.sessionType === 'SUBAGENT' && session.parentSessionId != null) {
      return this.sessionToUser.get(session.parentSessionId) ?? null;
    }
    return null;
  }

  /**
   * 解析会话的执行目标（缓存优先，DB 兜底）。
   * 缓存命中时设备值以内存为准（认领 / 刷新会即时更新）；未命中时读 session.target_device_id。
   */
  async resolveTarget(sessionId: number | null): Promise<LocalToolTarget | null> {
    if (sessionId == null) return null;
    const cached = this.sessionToUser.get(sessionId);
    if (cached != null) {
      return { userId: cached, deviceId: this.sessionToDevice.get(sessionId) ?? null };
    }
    const session: Session | null = await this.sessionMapper.selectById(sessionId);
    if (!session) return null;
    let userId: number | null = session.userId ?? null;
    if (userId == null && session.sessionType === 'SUBAGENT' && session.parentSessionId != null) {
      userId = this.sessionToUser.get(session.parentSessionId) ?? null;
    }
    if (userId == null) return null;
    const rawDeviceId = session.targetDeviceId;
    const deviceId = rawDeviceId != null && rawDeviceId !== '' ? rawDeviceId : null;
    return { userId, deviceId };
  }

  async sendToolRequest(
    sessionId: number | null,
    toolName: string,
    argumentsJson: string,
    workspace: string | null | undefined,
    needApproval: boolean,
    dangerReason: string | null,
    approvalHint: ApprovalHint | null = null,
  ): Promise<PendingLocalToolRequest> {
    return this.dispatchRequest(
      sessionId,
      'tool_execute',
      LOCAL_CLIENT_OFFLINE_TOOL_ERROR,
      (requestId) => {
        const payload: Record<string, unknown> = {
          requestId,
          toolName,
          arguments: argumentsJson ?? '{}',
          workspace: workspace ?? '',
          needApproval,
        };
        if (dangerReason != null) payload.dangerReason = dangerReason;
        // 「总是允许」hint（V135）：仅增量字段，旧壳忽略未知字段不受影响
        if (approvalHint != null) payload.approvalHint = approvalHint;
        return payload;
      },
    );
  }

  /**
   * LOCAL 正文图片按需读取（方案 2026-11-18）：向绑定执行端下发 `file_fetch` 请求，
   * 复用工具委托的全套簿记（requestId / pendingRequests / 投递落空立即报错 / 断线 failAll）。
   * 结果分片经 `file_fetch_result` 回传，由 LocalFileFetchService 拼装后 completeToolRequest 回填。
   * 与工具调用无关：无审批、无工具卡、不落库。
   */
  async sendFileRequest(
    sessionId: number | null,
    relativePath: string,
    workspace: string | null | undefined,
  ): Promise<PendingLocalToolRequest> {
    return this.dispatchRequest(
      sessionId,
      'file_fetch',
      LOCAL_EXECUTOR_OFFLINE_FILE_ERROR,
      (requestId) => ({ requestId, path: relativePath, workspace: workspace ?? '' }),
    );
  }

  /**
   * LOCAL 发送字节委托读取（技术方案 2026-11-18-unified-send-media §6；
   * 2026-11-25-send-file-1gb R2 改为服务端窗口拉取）：向绑定执行端下发 `delivery_read`
   * 的 open / read / close 帧，复用工具委托的全套簿记（requestId / pendingRequests /
   * 投递落空立即报错 / 断线 failAll）。与工具调用无关：无审批、无工具卡、不落库。
   */
  async sendDeliveryReadRequest(
    sessionId: number,
    payload: {
      action: 'open' | 'read' | 'digest';
      streamId: string;
      path?: string;
      workspace?: string;
      offset?: number;
      length?: number;
      maxBytes?: number;
    },
    options: { socketId?: string | null } = {},
  ): Promise<PendingLocalToolRequest> {
    return this.dispatchRequest(
      sessionId,
      'delivery_read',
      LOCAL_EXECUTOR_OFFLINE_DELIVERY_ERROR,
      (requestId) => ({ requestId, ...payload }),
      options.socketId ?? null,
    );
  }

  /**
   * 关闭帧：不登记 pending（响应无人等待）。
   * 未绑定设备的会话在 open 成功后由某个执行端认领，这里必须定向发给同一条连接，
   * 否则另一台在线设备收到一个它没有的 streamId（无害，但白跑一次磁盘/句柄检查）。
   */
  sendDeliveryClose(sessionId: number, streamId: string, socketId?: string | null): void {
    void this.resolveTarget(sessionId).then((target) => {
      if (target == null) return;
      const event = wsEvent('delivery_read', sessionId, {
        requestId: randomUUID(),
        action: 'close',
        streamId,
      });
      if (socketId != null && socketId !== '') {
        if (this.streamingWsRegistry.sendToLocalSocket?.(target.userId, socketId, event) === true) return;
      }
      if (target.deviceId != null) this.streamingWsRegistry.sendToDevice(target.userId, target.deviceId, event);
      else this.streamingWsRegistry.sendToLocalClients(target.userId, event);
    }).catch(() => undefined);
  }

  /** 丢弃一个已不再等待的 pending 请求（首帧超时 / 调用方放弃）：避免表项滞留到断线。 */
  dropToolRequest(sessionId: number, requestId: string): void {
    this.pendingRequests.get(sessionId)?.delete(requestId);
  }

  /**
   * 工具 / 文件读取委托的公共下发路径：目标解析 → 可达性判定 → requestId 簿记 →
   * 定向（绑定设备）或用户级广播（未绑定）投递 → 投递落空立即回错。
   */
  private async dispatchRequest(
    sessionId: number | null,
    eventType: 'tool_execute' | 'file_fetch' | 'delivery_read',
    offlineError: string,
    buildPayload: (requestId: string) => Record<string, unknown>,
    targetSocketId: string | null = null,
  ): Promise<PendingLocalToolRequest> {
    const target = await this.resolveTarget(sessionId);
    const reachable = target != null && (target.deviceId != null
      ? this.streamingWsRegistry.hasDeviceConnection(target.userId, target.deviceId)
      : this.streamingWsRegistry.hasLocalClientConnection(target.userId));
    if (target == null || !reachable) {
      return {
        requestId: null,
        future: Promise.resolve(JSON.stringify({ error: offlineError })),
        resolve: () => {},
        directed: false,
      };
    }
    const { userId, deviceId } = target;
    const requestId = randomUUID();
    let resolve!: (v: string) => void;
    const future = new Promise<string>((r) => { resolve = r; });
    // 记录请求实际下发到的连接（定向投递时为当前执行连接）：连接断开时只失败它收到的请求；
    // 同设备其它连接上在途的请求不受影响（执行连接可能已交接给新连接，见 failAllForSocket）。
    const dispatchedSocket = targetSocketId != null
      ? { id: targetSocketId }
      : deviceId != null
        ? this.streamingWsRegistry.getDeviceExecutorSocket?.(userId, deviceId) ?? null
        : null;
    if (sessionId != null) {
      let map = this.pendingRequests.get(sessionId);
      if (!map) {
        map = new Map();
        this.pendingRequests.set(sessionId, map);
      }
      map.set(requestId, { resolve, socket: dispatchedSocket });
    }
    const event = wsEvent(eventType, sessionId, buildPayload(requestId));
    let delivered = true;
    if (targetSocketId != null) {
      // 已认领的连接：只发给它。连接已断 = 这次拉取无法继续，调用方按「执行端不在线」收敛。
      const sendToSocket = this.streamingWsRegistry.sendToLocalSocket;
      if (sendToSocket != null) {
        delivered = sendToSocket.call(this.streamingWsRegistry, userId, targetSocketId, event);
      } else {
        // 实现不提供按连接定向（测试桩 / 旧实现）：退回用户级广播，不能误判成执行端离线
        this.streamingWsRegistry.sendToLocalClients(userId, event);
      }
    } else if (deviceId != null) {
      const dispatch = this.streamingWsRegistry.sendToDevice(userId, deviceId, event);
      // 定向投递零成功 = 该设备当前没有任何可写的执行连接（最后一条已半死）。
      // 以往这里静默放行，调用方只看到 isConnected=true 就开等，最终白等到 900s 超时。
      // 立即回错，让模型当轮就看到「本地执行端未连接」并自行重试/说明。
      delivered = dispatch.successCount > 0;
    } else {
      this.streamingWsRegistry.sendToLocalClients(userId, event);
    }
    if (!delivered) {
      if (sessionId != null) this.pendingRequests.get(sessionId)?.delete(requestId);
      harnessLog('warn', `Local dispatch delivered to nobody: type=${eventType}, session=${sessionId}, device=${deviceId}`);
      return {
        requestId: null,
        future: Promise.resolve(JSON.stringify({ error: offlineError })),
        resolve: () => {},
        directed: false,
      };
    }
    return { requestId, future, resolve, directed: deviceId != null };
  }

  completeToolRequest(sessionId: number, requestId: string, result: string): void {
    const map = this.pendingRequests.get(sessionId);
    const entry = map?.get(requestId);
    if (entry) { map!.delete(requestId); entry.resolve(result); }
  }

  completeToolRequestError(sessionId: number, requestId: string, error: string): void {
    const map = this.pendingRequests.get(sessionId);
    const entry = map?.get(requestId);
    if (entry) {
      map!.delete(requestId);
      entry.resolve(JSON.stringify({ error: error.replace(/"/g, "'") }));
    }
  }

  failAllForSession(sessionId: number): void {
    this.failAllPending(sessionId, 'Session aborted');
  }

  private failAllPending(sessionId: number, reason: string): void {
    const map = this.pendingRequests.get(sessionId);
    this.pendingRequests.delete(sessionId);
    if (map) {
      for (const entry of map.values()) {
        entry.resolve(JSON.stringify({ error: reason }));
      }
    }
  }
}
