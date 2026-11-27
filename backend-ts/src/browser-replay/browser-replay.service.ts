import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ReplayFrameMeta, ReplayManifest, ReplaySummary, ReplayTimeline } from '@mao/contracts';
import type { RuntimeDataResolver } from '../harness/runtime/runtime-data-resolver.js';

/** liveId 形态白名单：sidecar 录制器分配的 `L<毫秒时间戳>`（技术方案 2026-11-22 §4.1）。 */
export const LIVE_ID_PATTERN = /^L\d+$/;

/**
 * manifest.json 解析容错（纯函数，service 与跨会话 catalog 共用，避免两套解析口径）：
 * 坏 JSON / liveId 不符 / startedAt 非数字按"本场不存在"处理。
 */
export function parseReplayManifest(raw: string, liveId: string): ReplayManifest | null {
  try {
    const parsed = JSON.parse(raw) as ReplayManifest;
    if (parsed?.liveId !== liveId || typeof parsed?.startedAt !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 浏览器直播回放读取服务（技术方案 2026-11-22 §4.1）：数据源是会话 runtime 目录下的
 * `.mao-browser/replay/<liveId>/`（sidecar 采集侧录制器写入，runtime 目录即数据源，
 * 与 compaction/webPages 同惯例，无 DB 迁移）。无 repository——文件系统即存储。
 */
export class BrowserReplayService {
  constructor(private readonly runtimeResolver: RuntimeDataResolver) {}

  /** 回放根目录：<runtimeRoot>/<uid>/<sid>/.mao-browser/replay。 */
  replayRootFor(userId: number, sessionId: number): string {
    return path.join(this.runtimeResolver.resolveSessionRuntimeDir(userId, sessionId), '.mao-browser', 'replay');
  }

  /**
   * liveId 白名单 + containment 断言：resolve 后必须仍在回放根内，防目录穿越。
   * root 由 resolver 按 (userId, sessionId) 数字拼出，本身可信；这里防的是 URL 里的 liveId。
   */
  resolveLiveDir(root: string, liveId: string): string | null {
    if (!LIVE_ID_PATTERN.test(liveId)) return null;
    const resolved = path.resolve(root, liveId);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
    return resolved;
  }

  /** 场次列表（manifest 摘要，按 startedAt 倒序）。含 endedAt=null 的未结算场（§4.1）。 */
  listReplays(userId: number, sessionId: number): ReplaySummary[] {
    const root = this.replayRootFor(userId, sessionId);
    let names: string[];
    try {
      names = readdirSync(root);
    } catch {
      return []; // replay 目录不存在 = 该会话从未录制，空列表
    }
    const summaries: ReplaySummary[] = [];
    for (const name of names) {
      if (!LIVE_ID_PATTERN.test(name)) continue;
      const liveDir = this.resolveLiveDir(root, name);
      if (!liveDir) continue;
      const manifest = this.readManifest(liveDir, name);
      if (!manifest) continue;
      summaries.push({
        liveId: manifest.liveId,
        startedAt: manifest.startedAt,
        endedAt: manifest.endedAt ?? null,
        frameCount: manifest.frameCount ?? 0,
        durationMs: manifest.durationMs ?? null,
        approxBytes: manifest.approxBytes ?? 0,
        truncated: manifest.truncated === true,
      });
    }
    summaries.sort((a, b) => b.startedAt - a.startedAt);
    return summaries;
  }

  /** manifest + timeline 全量帧索引；manifest 缺失 / liveId 非法返回 null（404）。 */
  timeline(userId: number, sessionId: number, liveId: string): ReplayTimeline | null {
    const root = this.replayRootFor(userId, sessionId);
    const liveDir = this.resolveLiveDir(root, liveId);
    if (!liveDir) return null;
    const manifest = this.readManifest(liveDir, liveId);
    if (!manifest) return null;
    return { manifest, frames: this.readTimeline(liveDir) };
  }

  /** 读取单帧 JPEG 字节；liveId/seq 非法或文件缺失返回 null。帧写后不可变，读已落盘部分安全。 */
  frameBuffer(userId: number, sessionId: number, liveId: string, seq: number): Buffer | null {
    const root = this.replayRootFor(userId, sessionId);
    const liveDir = this.resolveLiveDir(root, liveId);
    if (!liveDir) return null;
    if (!Number.isSafeInteger(seq) || seq < 0) return null;
    // file 名由整数 seq 拼出，无穿越面；resolve 断言仅为纵深防御
    const file = path.resolve(liveDir, `f${seq}.jpg`);
    if (!file.startsWith(liveDir + path.sep)) return null;
    try {
      if (!statSync(file).isFile()) return null;
      return readFileSync(file);
    } catch {
      return null;
    }
  }

  /** manifest 读取容错：缺文件 / 坏 JSON / liveId 不符按"本场不存在"处理。 */
  private readManifest(liveDir: string, liveId: string): ReplayManifest | null {
    try {
      return parseReplayManifest(readFileSync(path.join(liveDir, 'manifest.json'), 'utf8'), liveId);
    } catch {
      return null;
    }
  }

  /** timeline.ndjson 逐行容错解析：崩溃留下的尾部半行跳过（§3.2）。 */
  private readTimeline(liveDir: string): ReplayFrameMeta[] {
    let raw = '';
    try {
      raw = readFileSync(path.join(liveDir, 'timeline.ndjson'), 'utf8');
    } catch {
      return [];
    }
    const frames: ReplayFrameMeta[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const row = JSON.parse(trimmed) as ReplayFrameMeta;
        if (typeof row?.seq !== 'number' || typeof row?.ts !== 'number' || typeof row?.file !== 'string') continue;
        frames.push(row);
      } catch {
        /* 坏行跳过 */
      }
    }
    return frames;
  }
}
