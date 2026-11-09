import type {
  SignalCompareMode,
  SignalProbeType,
  SignalTriggerMode,
  SignalWatcherStatus,
  SignalWatcherWarning,
} from '@mao/contracts';

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
  /** 探针类型（V189）：HTTP=单接口探针，SCRIPT=Shell 脚本探针。 */
  probeType: SignalProbeType;
  /**
   * 脚本路径（仅 SCRIPT）：项目工作区内相对路径 `<slug>/<子路径>`，
   * 解析根为 `{workspaceRoot}/{userId}/projects/`。HTTP 哨兵恒 null。
   */
  scriptPath: string | null;
  /** 脚本超时秒数（仅 SCRIPT；NULL=默认 60）。 */
  scriptTimeoutSeconds: number | null;
  status: SignalWatcherStatus;
  /** 上次判定值哈希；NULL=待建基线。 */
  lastValueHash: string | null;
  /** 上次判定内容片段（截断），供 {diff} 旧值侧使用。 */
  lastValueSnippet: string | null;
  /**
   * 上次那次变化的新旧值对（V184）：列表卡一句「上次变化：旧 → 新」的数据源。
   * 变化触发成功时与 markChecked 同写；基线重置 / 重新启用时清空；暂停不清。
   */
  lastChangeOldSnippet: string | null;
  lastChangeNewSnippet: string | null;
  lastCheckedAt: string | null;
  lastChangedAt: string | null;
  consecutiveFailures: number;
  /** 触发方式（V174）：NEW_SESSION=每次新建，REUSE_SESSION=复用本哨兵自己的会话。 */
  triggerMode: SignalTriggerMode;
  /** REUSE_SESSION 模式当前复用的会话 id（系统维护，NULL=尚未自建）。 */
  reuseSessionId: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

/** 哨兵轮询记录行类型（V148 `signal_watcher_check`）。 */
export interface SignalWatcherCheck {
  id?: number;
  watcherId: number;
  checkedAt?: string | null;
  httpStatus: number | null;
  /** 脚本探针的退出码（V189）；HTTP 探针恒 null。 */
  exitCode: number | null;
  valueHash: string | null;
  /**
   * 本次判定所对照的上次值 / 本次值片段（V185）：取 runCheck 开头那份快照的
   * lastValueSnippet 与本轮 newText，均存 truncate(·, 500)。
   */
  oldValueSnippet: string | null;
  newValueSnippet: string | null;
  changed: number;
  triggeredSessionId: number | null;
  error: string | null;
  durationMs: number | null;
  /** 非失败告警：TRIGGER_RATE_LIMITED=触发频次超限。 */
  warning: string | null;
}

/** 变化判定模式（决策 14：三种）。 */
export type { SignalCompareMode };
export type { SignalProbeType };

/** 哨兵状态：ACTIVE 轮询中 / PAUSED 用户暂停 / DISABLED 连续失败自动停用。 */
export type { SignalWatcherStatus };

/** 触发方式（V174）：每次新建会话 / 复用本哨兵自己的会话。 */
export type { SignalTriggerMode };

export const SIGNAL_COMPARE_MODES = ['HASH', 'JSON_FIELD', 'STATUS_CODE'] as const satisfies readonly SignalCompareMode[];

export function isSignalCompareMode(value: unknown): value is SignalCompareMode {
  return typeof value === 'string' && (SIGNAL_COMPARE_MODES as readonly string[]).includes(value);
}

/** 探针类型（V189）：HTTP / SCRIPT。 */
export const SIGNAL_PROBE_TYPES = ['HTTP', 'SCRIPT'] as const satisfies readonly SignalProbeType[];

export function isSignalProbeType(value: unknown): value is SignalProbeType {
  return typeof value === 'string' && (SIGNAL_PROBE_TYPES as readonly string[]).includes(value);
}

/**
 * SCRIPT 哨兵允许的判定模式：exit code 是成败语义（非 0 = 探针失败计连败），
 * 不是变化判定输入，STATUS_CODE 不对脚本开放（技术方案 §3.1）。
 */
export const SCRIPT_COMPARE_MODES = ['HASH', 'JSON_FIELD'] as const satisfies readonly SignalCompareMode[];

export function isScriptCompareMode(value: unknown): value is SignalCompareMode {
  return typeof value === 'string' && (SCRIPT_COMPARE_MODES as readonly string[]).includes(value);
}

export const SIGNAL_TRIGGER_MODES = ['NEW_SESSION', 'REUSE_SESSION'] as const satisfies readonly SignalTriggerMode[];

export function isSignalTriggerMode(value: unknown): value is SignalTriggerMode {
  return typeof value === 'string' && (SIGNAL_TRIGGER_MODES as readonly string[]).includes(value);
}

export const SIGNAL_WATCHER_STATUSES = ['ACTIVE', 'PAUSED', 'DISABLED'] as const satisfies readonly SignalWatcherStatus[];

export function isSignalWatcherStatus(value: unknown): value is SignalWatcherStatus {
  return typeof value === 'string' && (SIGNAL_WATCHER_STATUSES as readonly string[]).includes(value);
}

/** 非失败告警码：触发频次超限（决策 7——照常触发，仅标记）。 */
export const WATCHER_WARNING_TRIGGER_RATE_LIMITED = 'TRIGGER_RATE_LIMITED' satisfies SignalWatcherWarning;

/** 探针方法白名单。 */
export const SIGNAL_PROBE_METHODS: readonly string[] = ['GET', 'POST'];
