/** 信号哨兵行类型（V148 `signal_watcher`，列名 camelCase 由 Db 层转换）。 */
export interface SignalWatcher {
  id?: number;
  userId: number;
  agentId: number;
  name: string;
  url: string;
  method: string;
  /** 请求头 JSON 的密文（整体 AES-GCM 加密）。 */
  headersJson: string | null;
  /** POST 体密文（整体 AES-GCM 加密）。 */
  body: string | null;
  intervalMinutes: number;
  compareMode: SignalCompareMode;
  jsonPath: string | null;
  promptTemplate: string;
  status: SignalWatcherStatus;
  /** 上次判定值哈希；NULL=待建基线。 */
  lastValueHash: string | null;
  /** 上次判定内容片段（截断），供 {diff} 旧值侧使用。 */
  lastValueSnippet: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  consecutiveFailures: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 哨兵轮询记录行类型（V148 `signal_watcher_check`）。 */
export interface SignalWatcherCheck {
  id?: number;
  watcherId: number;
  checkedAt?: string | null;
  httpStatus: number | null;
  valueHash: string | null;
  changed: number;
  triggeredSessionId: number | null;
  error: string | null;
  durationMs: number | null;
  /** 非失败告警：TRIGGER_RATE_LIMITED=触发频次超限。 */
  warning: string | null;
}

/** 变化判定模式（决策 14：三种）。 */
export type SignalCompareMode = 'HASH' | 'JSON_FIELD' | 'STATUS_CODE';

/** 哨兵状态：ACTIVE 轮询中 / PAUSED 用户暂停 / DISABLED 连续失败自动停用。 */
export type SignalWatcherStatus = 'ACTIVE' | 'PAUSED' | 'DISABLED';

export const SIGNAL_COMPARE_MODES: readonly SignalCompareMode[] = ['HASH', 'JSON_FIELD', 'STATUS_CODE'];

export function isSignalCompareMode(value: unknown): value is SignalCompareMode {
  return typeof value === 'string' && (SIGNAL_COMPARE_MODES as readonly string[]).includes(value);
}

export const SIGNAL_WATCHER_STATUSES: readonly SignalWatcherStatus[] = ['ACTIVE', 'PAUSED', 'DISABLED'];

export function isSignalWatcherStatus(value: unknown): value is SignalWatcherStatus {
  return typeof value === 'string' && (SIGNAL_WATCHER_STATUSES as readonly string[]).includes(value);
}

/** 非失败告警码：触发频次超限（决策 7——照常触发，仅标记）。 */
export const WATCHER_WARNING_TRIGGER_RATE_LIMITED = 'TRIGGER_RATE_LIMITED';

/** 探针方法白名单。 */
export const SIGNAL_PROBE_METHODS: readonly string[] = ['GET', 'POST'];
