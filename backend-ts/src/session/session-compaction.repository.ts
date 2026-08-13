import type { Db } from '../db/db.js';
import type { SessionCompaction, SessionCompactionEvent } from './types.js';

export class SessionCompactionRepository {
  constructor(private readonly db: Db) {}

  selectBySessionId(sessionId: number): Promise<SessionCompaction | null> {
    return this.db.queryOne<SessionCompaction>(
      `SELECT * FROM session_compaction WHERE session_id = ?`,
      [sessionId],
    );
  }

  async insert(record: SessionCompaction): Promise<number> {
    const id = await this.db.insert('session_compaction', {
      sessionId: record.sessionId,
      summaryText: record.summaryText,
      lastCompactedMsgId: record.lastCompactedMsgId,
      compactCount: record.compactCount ?? 1,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      compactModel: record.compactModel,
    });
    record.id = id;
    return id;
  }

  async updateWithBoundaryCas(
    expectedRecordId: number,
    sessionId: number,
    expectedOldBoundary: number,
    newBoundary: number,
    summaryText: string,
    inputTokens: number,
    outputTokens: number,
    compactModel: string | null,
  ): Promise<number> {
    const result = await this.db.execute(
      `UPDATE session_compaction SET
         summary_text = ?, last_compacted_msg_id = ?,
         compact_count = COALESCE(compact_count, 0) + 1,
         input_tokens = COALESCE(input_tokens, 0) + ?,
         output_tokens = COALESCE(output_tokens, 0) + ?,
         compact_model = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND session_id = ?
         AND COALESCE(last_compacted_msg_id, 0) = ?
         AND ? > ?
         AND EXISTS (SELECT 1 FROM message m WHERE m.id = ? AND m.session_id = ? AND m.deleted = 0)`,
      [
        summaryText, newBoundary, inputTokens, outputTokens, compactModel,
        expectedRecordId, sessionId, expectedOldBoundary, newBoundary, expectedOldBoundary,
        newBoundary, sessionId,
      ],
    );
    return Number(result.affectedRows ?? 0);
  }

  async deleteBySessionId(sessionId: number): Promise<number> {
    const result = await this.db.execute(`DELETE FROM session_compaction WHERE session_id = ?`, [sessionId]);
    return Number(result.affectedRows ?? 0);
  }

  async deleteIfBoundaryMatches(recordId: number, sessionId: number, boundary: number): Promise<number> {
    const result = await this.db.execute(
      `DELETE FROM session_compaction WHERE id = ? AND session_id = ? AND COALESCE(last_compacted_msg_id, 0) = ?`,
      [recordId, sessionId, boundary],
    );
    return Number(result.affectedRows ?? 0);
  }
}

export class SessionCompactionEventRepository {
  constructor(private readonly db: Db) {}

  async insert(event: SessionCompactionEvent): Promise<number> {
    const id = await this.db.insert('session_compaction_event', {
      sessionId: event.sessionId,
      triggerMode: event.triggerMode,
      prevBoundaryMsgId: event.prevBoundaryMsgId,
      boundaryMsgId: event.boundaryMsgId,
      compactedMessageCount: event.compactedMessageCount,
      promptTokens: event.promptTokens,
      cachedTokens: event.cachedTokens,
      completionTokens: event.completionTokens,
      summaryTokens: event.summaryTokens,
      savedTokens: event.savedTokens,
      durationMs: event.durationMs,
      compactModel: event.compactModel,
    });
    event.id = id;
    return id;
  }

  selectBySessionId(sessionId: number): Promise<SessionCompactionEvent[]> {
    return this.db.query<SessionCompactionEvent>(
      `SELECT * FROM session_compaction_event WHERE session_id = ? ORDER BY boundary_msg_id ASC, id ASC`,
      [sessionId],
    );
  }

  async deleteBySessionId(sessionId: number): Promise<number> {
    const result = await this.db.execute(`DELETE FROM session_compaction_event WHERE session_id = ?`, [sessionId]);
    return Number(result.affectedRows ?? 0);
  }
}
