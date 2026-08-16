import type { SessionCompactionEvent } from './types.js';
import type { SessionCompactionEventRepository } from './session-compaction.repository.js';

export class SessionCompactionEventService {
  constructor(private readonly repo: SessionCompactionEventRepository) {}

  async record(
    sessionId: number,
    triggerMode: string,
    prevBoundaryMsgId: number,
    boundaryMsgId: number,
    compactedMessageCount: number,
    promptTokens: number | null,
    cachedTokens: number | null,
    completionTokens: number | null,
    summaryTokens: number,
    savedTokens: number,
    durationMs: number,
    compactModel: string | null,
  ): Promise<SessionCompactionEvent> {
    const event: SessionCompactionEvent = {
      sessionId,
      triggerMode,
      prevBoundaryMsgId,
      boundaryMsgId,
      compactedMessageCount,
      promptTokens,
      cachedTokens,
      completionTokens,
      summaryTokens,
      savedTokens,
      durationMs,
      compactModel,
    };
    await this.repo.insert(event);
    return event;
  }

  listBySessionId(sessionId: number): Promise<SessionCompactionEvent[]> {
    return this.repo.selectBySessionId(sessionId);
  }

  deleteBySessionId(sessionId: number): Promise<number> {
    return this.repo.deleteBySessionId(sessionId);
  }
}
