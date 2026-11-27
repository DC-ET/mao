// 浏览器直播回放（录制 + 回看）跨端契约（技术方案 docs/plan/2026-11/2026-11-22-browser-live-replay-technical-design.md §6）。
// 数据源是会话 runtime 目录下的文件（.mao-browser/replay/<liveId>/），由 sidecar 采集侧录制器写入；
// 后端 / Electron 枢纽按目录提供带归属校验的回放读取，本契约描述列表 / 时间轴 / 帧元数据。

/** timeline.ndjson 单行：一帧的索引元数据（file 为该帧 JPEG 文件名，内容经 frames 端点 / IPC 取）。 */
export interface ReplayFrameMeta {
  /** sidecar 进程级帧序号（场内不保证从 1 连续，播放按 timeline 顺序驱动）。 */
  seq: number;
  /** 帧采集时刻（毫秒时间戳，播放倍速按相邻 ts 差推进）。 */
  ts: number;
  pageUrl: string;
  width: number;
  height: number;
  /** JPEG 字节数。 */
  bytes: number;
  file: string;
}

/** manifest.json：单场摘要。endedAt=null 表示崩溃/超时未正常结算的场（读取端以最后一帧 ts 兜底展示）。 */
export interface ReplayManifest {
  version: number;
  liveId: string;
  sessionId: number;
  startedAt: number;
  endedAt: number | null;
  frameCount: number;
  durationMs: number | null;
  approxBytes: number;
  cliSessions: string[];
  urls: string[];
  /** true = 单场体积上限截断或写入故障停录。 */
  truncated: boolean;
}

/** 场次列表项（manifest 的回放相关子集）。 */
export interface ReplaySummary {
  liveId: string;
  startedAt: number;
  endedAt: number | null;
  frameCount: number;
  durationMs: number | null;
  approxBytes: number;
  truncated: boolean;
}

/** GET .../replays/:liveId/timeline 返回体：manifest + 全量帧索引（1fps × 2h 上限，内存安全）。 */
export interface ReplayTimeline {
  manifest: ReplayManifest;
  frames: ReplayFrameMeta[];
}

/**
 * 跨会话回放列表项（owner / admin 共用；admin 独有字段可选）。
 * 技术方案 2026-11-27 §4.1：数据源是扫 runtime 目录里的 manifest，无 DB 索引表。
 */
export interface BrowserReplayListItem {
  sessionId: number;
  liveId: string;
  executionMode: 'CLOUD' | 'LOCAL';
  sessionTitle: string | null;
  agentId: number | null;
  agentName: string | null;
  /** 仅 admin 列表返回。 */
  userId?: number;
  /** 仅 admin 列表返回。 */
  username?: string;
  startedAt: number;
  /** null = 未正常结算的场（崩溃/超时）；列表时长列按「未结束」展示。 */
  endedAt: number | null;
  durationMs: number | null;
  frameCount: number;
  approxBytes: number;
  truncated: boolean;
  /** manifest.urls[0] ?? ''。 */
  pageUrl: string;
}

export interface BrowserReplayListResult {
  records: BrowserReplayListItem[];
  total: number;
  page: number;
  size: number;
  /** 候选会话/manifest 读取超过上限被截断：提示调用方缩小筛选范围。 */
  truncatedCandidates?: boolean;
}
