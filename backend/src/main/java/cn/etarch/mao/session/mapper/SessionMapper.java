package cn.etarch.mao.session.mapper;

import cn.etarch.mao.session.entity.Session;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@Mapper
public interface SessionMapper extends BaseMapper<Session> {

    @Select("SELECT DATE(created_at) AS day, COUNT(*) AS count " +
            "FROM session WHERE created_at >= #{start} AND deleted = 0 GROUP BY DATE(created_at)")
    List<Map<String, Object>> selectSessionCountsByDay(@Param("start") LocalDateTime start);

    @Select("SELECT COALESCE(phase, 'IDLE') AS phase, COUNT(*) AS count " +
            "FROM session WHERE deleted = 0 GROUP BY COALESCE(phase, 'IDLE')")
    List<Map<String, Object>> selectPhaseCounts();

    @Select("SELECT user_id AS userId, COUNT(*) AS sessionCount " +
            "FROM session WHERE deleted = 0 GROUP BY user_id")
    List<Map<String, Object>> selectSessionCountsByUser();

    @Select("SELECT model_id AS modelId, COUNT(*) AS sessionCount " +
            "FROM session WHERE model_id IS NOT NULL AND deleted = 0 GROUP BY model_id")
    List<Map<String, Object>> selectSessionCountsByModel();

    @Select("SELECT id FROM session WHERE id = #{sessionId} AND deleted = 0 FOR UPDATE")
    Long lockActiveSessionById(@Param("sessionId") Long sessionId);

    /**
     * 按用户消息内容搜索会话候选（主会话 + 边路会话，排除子代理/归档/孤儿边路）。
     * 仅第一层粗筛：message.content LIKE 命中（含多模态 JSON 原文），
     * 由 Service 层做纯文本二次校验剔除假命中。LIKE 特殊字符已由 Service 转义。
     */
    @Select({
            "<script>",
            "SELECT DISTINCT s.id, s.title, s.session_type, s.parent_session_id, s.phase, s.updated_at, s.agent_id",
            "FROM session s",
            "JOIN message m ON m.session_id = s.id AND m.deleted = 0",
            "WHERE s.user_id = #{userId} AND s.deleted = 0",
            "  AND s.session_type IN ('NORMAL', 'SIDE_TASK')",
            "  AND s.status = 'ACTIVE'",
            "  AND m.role = 'USER'",
            "  AND m.content LIKE CONCAT('%', #{escapedKeyword}, '%') ESCAPE '\\\\'",
            "  AND (",
            "    s.session_type = 'NORMAL'",
            "    OR EXISTS (",
            "      SELECT 1 FROM session p",
            "      WHERE p.id = s.parent_session_id",
            "        AND p.user_id = s.user_id",
            "        AND p.deleted = 0",
            "        AND p.status = 'ACTIVE'",
            "        AND p.session_type = 'NORMAL'",
            "    )",
            "  )",
            "ORDER BY s.updated_at DESC, s.id DESC",
            "LIMIT 20",
            "</script>"
    })
    List<Session> selectMessageSearchCandidates(@Param("userId") Long userId,
                                                @Param("escapedKeyword") String escapedKeyword);
}
