import type { SessionActivity } from './types.js';
import type { SessionActivityRepository } from './activity.repository.js';

const MAX_TARGET_LENGTH = 2048;
const MAX_SUMMARY_LENGTH = 512;

export class ActivityService {
  constructor(private readonly repo: SessionActivityRepository) {}

  record(sessionId: number, type: string, target: string | null, summary: string | null): Promise<SessionActivity>;
  record(
    sessionId: number,
    type: string,
    target: string | null,
    summary: string | null,
    detailJson: string | null,
    status: string | null,
    durationMs: number | null,
  ): Promise<SessionActivity>;
  async record(
    sessionId: number,
    type: string,
    target: string | null,
    summary: string | null,
    detailJson: string | null = null,
    status: string | null = null,
    durationMs: number | null = null,
  ): Promise<SessionActivity> {
    const activity: SessionActivity = {
      sessionId,
      type,
      target: truncate(target, MAX_TARGET_LENGTH),
      summary: truncate(summary, MAX_SUMMARY_LENGTH),
      detailJson,
      status: status ?? 'SUCCESS',
      durationMs,
    };
    await this.repo.insert(activity);
    return activity;
  }

  listBySession(sessionId: number, limit = 50): Promise<SessionActivity[]> {
    return this.repo.listBySession(sessionId, limit);
  }
}

function truncate(s: string | null | undefined, max: number): string | null {
  if (s == null) {
    return null;
  }
  return s.length <= max ? s : s.slice(0, max);
}
