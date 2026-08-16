import type { SessionService } from './session.service.js';

const MIN_INTERVAL_MS = 30_000;

/**
 * Throttled heartbeat that refreshes session.last_activity_at during long-running agent work.
 */
export class SessionActivityHeartbeat {
  private readonly lastTouchMs = new Map<number, number>();

  constructor(private readonly sessionService: SessionService) {}

  touch(sessionId: number | null | undefined): void {
    if (sessionId == null) return;
    const now = Date.now();
    const last = this.lastTouchMs.get(sessionId);
    if (last != null && now - last < MIN_INTERVAL_MS) {
      return;
    }
    this.lastTouchMs.set(sessionId, now);
    void this.sessionService.touchLastActivity(sessionId).catch((e) => {
      console.debug(`Failed to touch last_activity_at for session ${sessionId}: ${(e as Error).message}`);
    });
  }

  clear(sessionId: number | null | undefined): void {
    if (sessionId != null) {
      this.lastTouchMs.delete(sessionId);
    }
  }
}
