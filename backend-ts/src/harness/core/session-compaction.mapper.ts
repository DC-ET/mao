/** Exact SQL copied from SessionCompactionMapper.java — keep MyBatis placeholders. */
export const SELECT_BY_SESSION_ID =
  'SELECT * FROM session_compaction WHERE session_id = #{sessionId}';

export const UPDATE_WITH_BOUNDARY_CAS =
  'UPDATE session_compaction SET ' +
  'summary_text = #{summaryText}, last_compacted_msg_id = #{newBoundary}, ' +
  'compact_count = COALESCE(compact_count, 0) + 1, ' +
  'input_tokens = COALESCE(input_tokens, 0) + #{inputTokens}, ' +
  'output_tokens = COALESCE(output_tokens, 0) + #{outputTokens}, ' +
  'compact_model = #{compactModel}, updated_at = CURRENT_TIMESTAMP ' +
  'WHERE id = #{expectedRecordId} AND session_id = #{sessionId} ' +
  'AND COALESCE(last_compacted_msg_id, 0) = #{expectedOldBoundary} ' +
  'AND #{newBoundary} > #{expectedOldBoundary} ' +
  'AND EXISTS (SELECT 1 FROM message m WHERE m.id = #{newBoundary} ' +
  'AND m.session_id = #{sessionId} AND m.deleted = 0)';

export const DELETE_BY_SESSION_ID =
  'DELETE FROM session_compaction WHERE session_id = #{sessionId}';

export const DELETE_IF_BOUNDARY_MATCHES =
  'DELETE FROM session_compaction ' +
  'WHERE id = #{recordId} AND session_id = #{sessionId} ' +
  'AND COALESCE(last_compacted_msg_id, 0) = #{boundary}';

/** Executable MySQL form of UPDATE_WITH_BOUNDARY_CAS. */
export const UPDATE_WITH_BOUNDARY_CAS_MYSQL =
  'UPDATE session_compaction SET ' +
  'summary_text = ?, last_compacted_msg_id = ?, ' +
  'compact_count = COALESCE(compact_count, 0) + 1, ' +
  'input_tokens = COALESCE(input_tokens, 0) + ?, ' +
  'output_tokens = COALESCE(output_tokens, 0) + ?, ' +
  'compact_model = ?, updated_at = CURRENT_TIMESTAMP ' +
  'WHERE id = ? AND session_id = ? ' +
  'AND COALESCE(last_compacted_msg_id, 0) = ? ' +
  'AND ? > ? ' +
  'AND EXISTS (SELECT 1 FROM message m WHERE m.id = ? ' +
  'AND m.session_id = ? AND m.deleted = 0)';

export const DELETE_IF_BOUNDARY_MATCHES_MYSQL =
  'DELETE FROM session_compaction ' +
  'WHERE id = ? AND session_id = ? ' +
  'AND COALESCE(last_compacted_msg_id, 0) = ?';

import type { Db } from '../../db/db.js';
import type { SessionCompaction } from '../deps.js';

export class SessionCompactionMapper {
  constructor(private readonly db: Db) {}

  selectBySessionId(sessionId: number): Promise<SessionCompaction | null> {
    return this.db.queryOne<SessionCompaction>(
      'SELECT * FROM session_compaction WHERE session_id = ?',
      [sessionId],
    );
  }

  async updateWithBoundaryCas(params: {
    expectedRecordId: number;
    sessionId: number;
    expectedOldBoundary: number;
    newBoundary: number;
    summaryText: string;
    inputTokens: number;
    outputTokens: number;
    compactModel: string | null;
  }): Promise<number> {
    const result = await this.db.execute(UPDATE_WITH_BOUNDARY_CAS_MYSQL, [
      params.summaryText,
      params.newBoundary,
      params.inputTokens,
      params.outputTokens,
      params.compactModel,
      params.expectedRecordId,
      params.sessionId,
      params.expectedOldBoundary,
      params.newBoundary,
      params.expectedOldBoundary,
      params.newBoundary,
      params.sessionId,
    ]);
    return result.affectedRows;
  }

  async deleteBySessionId(sessionId: number): Promise<number> {
    const result = await this.db.execute('DELETE FROM session_compaction WHERE session_id = ?', [sessionId]);
    return result.affectedRows;
  }

  async deleteIfBoundaryMatches(recordId: number, sessionId: number, boundary: number): Promise<number> {
    const result = await this.db.execute(DELETE_IF_BOUNDARY_MATCHES_MYSQL, [recordId, sessionId, boundary]);
    return result.affectedRows;
  }

  async insert(record: SessionCompaction): Promise<number> {
    return this.db.insert('session_compaction', {
      sessionId: record.sessionId,
      summaryText: record.summaryText,
      lastCompactedMsgId: record.lastCompactedMsgId,
      compactCount: record.compactCount,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      compactModel: record.compactModel,
    });
  }
}
