import { SessionService } from './session.service.js';
import type { StreamingWsHandler } from './ws/streaming-ws-handler.js';

export class StaleSessionSweepScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly sessionService: SessionService,
    private readonly streamingWsHandler: StreamingWsHandler,
  ) {}

  start(): void {
    this.timer = setInterval(() => {
      void this.sweepStaleRunningSessions();
    }, 60_000);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async sweepStaleRunningSessions(): Promise<void> {
    const stale = await this.sessionService.findStaleRunningSessions();
    if (stale.length === 0) return;
    console.warn(
      `Sweeping ${stale.length} stale sessions to FAILED (no activity for ${SessionService.getStaleMinutes()}min)`,
    );
    for (const session of stale) {
      try {
        this.streamingWsHandler.terminateStaleSession(session.id!, session.userId ?? null);
      } catch (e) {
        console.error(`Failed to terminate stale session ${session.id}`, e);
      }
    }
  }
}
