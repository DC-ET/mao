import type { Message, SessionCompaction } from './types.js';
import type { MessageRepository, SessionRepository } from './session.repository.js';
import type { SessionCompactionRepository } from './session-compaction.repository.js';

export class DuplicateKeyError extends Error {
  constructor(message = 'Duplicate key') {
    super(message);
    this.name = 'DuplicateKeyError';
  }
}

export class SessionCompactionService {
  constructor(
    private readonly compactionRepo: SessionCompactionRepository,
    private readonly messageRepo: MessageRepository,
    private readonly sessionRepo: SessionRepository,
  ) {}

  findBySessionId(sessionId: number): Promise<SessionCompaction | null> {
    return this.compactionRepo.selectBySessionId(sessionId);
  }

  async loadValidated(sessionId: number): Promise<SessionCompaction | null> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const record = await this.findBySessionId(sessionId);
      if (record == null) {
        return null;
      }
      const boundary = this.boundaryOf(record);
      const hasSummary = record.summaryText != null && record.summaryText.trim().length > 0;
      const valid = boundary === 0
        ? !hasSummary
        : hasSummary && (await this.messageRepo.selectValidBoundaryMessage(sessionId, boundary)) != null;
      if (valid) {
        return record;
      }
      console.warn(
        `Invalid session compaction boundary: sessionId=${sessionId}, compactionId=${record.id}, boundary=${boundary}; deleting record`,
      );
      if (record.id != null && (await this.compactionRepo.deleteIfBoundaryMatches(record.id, sessionId, boundary)) > 0) {
        return null;
      }
    }
    console.warn(`Session compaction boundary changed repeatedly during validation: sessionId=${sessionId}`);
    return null;
  }

  async persist(
    sessionId: number,
    expectedRecord: SessionCompaction | null,
    expectedOldBoundary: number,
    newBoundary: number,
    boundaryContentSnapshot: string,
    summaryText: string,
    inputTokens: number,
    outputTokens: number,
    compactModel: string | null,
  ): Promise<boolean> {
    if (newBoundary <= expectedOldBoundary) {
      throw new Error('Compaction boundary must advance');
    }
    if ((await this.sessionRepo.lockActiveSessionById(sessionId)) == null) {
      return false;
    }
    const currentBoundaryMessage: Message | null = await this.messageRepo.selectValidBoundaryMessage(sessionId, newBoundary);
    if (summaryText == null || summaryText.trim().length === 0 || currentBoundaryMessage == null) {
      return false;
    }
    if (currentBoundaryMessage.content !== boundaryContentSnapshot) {
      console.info(`Session compaction candidate changed before persistence: sessionId=${sessionId}, candidateBoundary=${newBoundary}`);
      return false;
    }

    if (expectedRecord != null) {
      if (expectedRecord.id == null) {
        return false;
      }
      return (await this.compactionRepo.updateWithBoundaryCas(
        expectedRecord.id, sessionId, expectedOldBoundary, newBoundary, summaryText,
        inputTokens, outputTokens, compactModel,
      )) === 1;
    }

    const record: SessionCompaction = {
      sessionId,
      summaryText,
      lastCompactedMsgId: newBoundary,
      compactCount: 1,
      inputTokens,
      outputTokens,
      compactModel,
    };
    try {
      return (await this.compactionRepo.insert(record)) >= 1;
    } catch (e) {
      if (isDuplicateKey(e) || e instanceof DuplicateKeyError) {
        console.info(`Session compaction insert conflict: sessionId=${sessionId}, candidateBoundary=${newBoundary}`);
        return false;
      }
      throw e;
    }
  }

  deleteBySessionId(sessionId: number): Promise<number> {
    return this.compactionRepo.deleteBySessionId(sessionId);
  }

  boundaryOf(record: SessionCompaction | null | undefined): number {
    return record == null || record.lastCompactedMsgId == null ? 0 : Number(record.lastCompactedMsgId);
  }
}

function isDuplicateKey(e: unknown): boolean {
  return typeof e === 'object' && e != null && 'code' in e && (e as { code?: string }).code === 'ER_DUP_ENTRY';
}
