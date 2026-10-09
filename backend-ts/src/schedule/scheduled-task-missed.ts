import { Cron } from 'croner';

/** 单个任务最多落下的错过行（不含 RUN_ONCE 要补跑的那一点）。 */
export const MAX_MISSED_PERSIST = 100;
/** 单任务逐点遍历上限。超过后改用二分定位最后一个触发点。 */
export const MAX_MISSED_WALK = 20_000;

export interface MissedPoints {
  /** 环形缓冲里保留的触发点，时间升序，最后一项是 latest（若有）。 */
  points: Date[];
  /** 窗口内最后一个 `< now` 的触发点。没有错过则为 null。 */
  latest: Date | null;
  /** 因落库上限或遍历上限没有逐条保留的更早触发点数量。 */
  truncated: number;
}

/**
 * 从 `from`（含）走到 `now`（不含）之间的 cron 触发点。
 * 补跑目标始终是 latest，不会停在第 N 个旧点上。
 */
export function collectMissedPoints(
  cron: Cron,
  from: Date,
  now: Date,
  opts?: { maxPersist?: number; maxWalk?: number },
): MissedPoints {
  const maxPersist = opts?.maxPersist ?? MAX_MISSED_PERSIST;
  const maxWalk = opts?.maxWalk ?? MAX_MISSED_WALK;
  const buf: Date[] = [];
  let truncated = 0;
  let t: Date | null = from;
  let walked = 0;
  while (t != null && t.getTime() < now.getTime() && walked < maxWalk) {
    buf.push(t);
    if (buf.length > maxPersist + 1) {
      buf.shift();
      truncated += 1;
    }
    const next = cron.nextRun(t);
    if (next == null || next.getTime() <= t.getTime()) {
      t = null;
      break;
    }
    t = next;
    walked += 1;
  }
  let latest = buf.length > 0 ? buf[buf.length - 1]! : null;
  if (walked >= maxWalk && t != null && t.getTime() < now.getTime()) {
    const found = latestFireBefore(cron, t, now);
    if (found != null && (latest == null || found.getTime() > latest.getTime())) {
      buf.push(found);
      if (buf.length > maxPersist + 1) {
        buf.shift();
        truncated += 1;
      }
      latest = found;
      truncated = Math.max(truncated, 1);
    }
  }
  return { points: buf, latest, truncated };
}

/**
 * 找 `[lower, now)` 内最后一个触发点。`lower` 本身若仍早于 now，可作为候选。
 * croner 没有「给定日期的上一次」，用 nextRun 二分。
 */
export function latestFireBefore(cron: Cron, lower: Date, now: Date): Date | null {
  let answer: Date | null = lower.getTime() < now.getTime() ? lower : null;
  let low = lower.getTime();
  let high = now.getTime();
  let guard = 0;
  while (high - low > 1000 && guard < 80) {
    guard += 1;
    const midMs = Math.floor((low + high) / 2);
    const mid = new Date(midMs);
    const atMid = cron.nextRun(new Date(midMs - 1000));
    const midIsFire = atMid != null
      && Math.abs(atMid.getTime() - midMs) < 1000
      && atMid.getTime() < now.getTime()
      && atMid.getTime() >= lower.getTime();
    if (midIsFire && atMid != null) {
      answer = atMid;
      low = atMid.getTime();
      continue;
    }
    const nxt = cron.nextRun(mid);
    if (nxt != null && nxt.getTime() < now.getTime() && nxt.getTime() >= lower.getTime()) {
      answer = nxt;
      low = nxt.getTime();
    } else {
      high = midMs;
    }
  }
  return answer;
}
