package cn.etarch.mao.session.mapper;

import cn.etarch.mao.session.entity.SessionCompaction;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

@Mapper
public interface SessionCompactionMapper extends BaseMapper<SessionCompaction> {

    @Select("SELECT * FROM session_compaction WHERE session_id = #{sessionId}")
    SessionCompaction selectBySessionId(@Param("sessionId") Long sessionId);

    @Update("UPDATE session_compaction SET " +
            "summary_text = #{summaryText}, last_compacted_msg_id = #{newBoundary}, " +
            "compact_count = COALESCE(compact_count, 0) + 1, " +
            "input_tokens = COALESCE(input_tokens, 0) + #{inputTokens}, " +
            "output_tokens = COALESCE(output_tokens, 0) + #{outputTokens}, " +
            "compact_model = #{compactModel}, updated_at = CURRENT_TIMESTAMP " +
            "WHERE id = #{expectedRecordId} AND session_id = #{sessionId} " +
            "AND COALESCE(last_compacted_msg_id, 0) = #{expectedOldBoundary} " +
            "AND #{newBoundary} > #{expectedOldBoundary} " +
            "AND EXISTS (SELECT 1 FROM message m WHERE m.id = #{newBoundary} " +
            "AND m.session_id = #{sessionId} AND m.deleted = 0)")
    int updateWithBoundaryCas(@Param("expectedRecordId") Long expectedRecordId,
                              @Param("sessionId") Long sessionId,
                              @Param("expectedOldBoundary") Long expectedOldBoundary,
                              @Param("newBoundary") Long newBoundary,
                              @Param("summaryText") String summaryText,
                              @Param("inputTokens") long inputTokens,
                              @Param("outputTokens") long outputTokens,
                              @Param("compactModel") String compactModel);

    @Delete("DELETE FROM session_compaction WHERE session_id = #{sessionId}")
    int deleteBySessionId(@Param("sessionId") Long sessionId);

    @Delete("DELETE FROM session_compaction " +
            "WHERE id = #{recordId} AND session_id = #{sessionId} " +
            "AND COALESCE(last_compacted_msg_id, 0) = #{boundary}")
    int deleteIfBoundaryMatches(@Param("recordId") Long recordId,
                                @Param("sessionId") Long sessionId,
                                @Param("boundary") Long boundary);
}
