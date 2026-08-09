package cn.etarch.mao.session.mapper;

import cn.etarch.mao.session.entity.Message;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

@Mapper
public interface MessageMapper extends BaseMapper<Message> {

    @Select("SELECT s.agent_id AS agentId, COALESCE(SUM(m.token_count), 0) AS totalTokens, COUNT(*) AS messageCount " +
            "FROM message m JOIN session s ON m.session_id = s.id " +
            "WHERE m.deleted = 0 AND s.deleted = 0 " +
            "GROUP BY s.agent_id")
    List<Map<String, Object>> selectTokenStatsGroupByAgent();

    @Select("SELECT DATE(created_at) AS day, COUNT(*) AS count " +
            "FROM message WHERE created_at >= #{start} AND deleted = 0 GROUP BY DATE(created_at)")
    List<Map<String, Object>> selectMessageCountsByDay(@Param("start") LocalDateTime start);

    @Select("SELECT s.user_id AS userId, COUNT(m.id) AS messageCount " +
            "FROM message m JOIN session s ON m.session_id = s.id " +
            "WHERE m.deleted = 0 AND s.deleted = 0 " +
            "GROUP BY s.user_id")
    List<Map<String, Object>> selectMessageCountsByUser();

    @Select("SELECT model_id AS modelId, COUNT(*) AS messageCount, COALESCE(SUM(token_count), 0) AS totalTokens " +
            "FROM message WHERE model_id IS NOT NULL AND deleted = 0 GROUP BY model_id")
    List<Map<String, Object>> selectMessageCountsByModel();

    @Select("SELECT COALESCE(SUM(token_count), 0) FROM message WHERE model_id = #{modelId} AND deleted = 0")
    Long selectTokenCountByModel(@Param("modelId") Long modelId);

    @Select("SELECT a.id AS agentId, a.name AS agentName, " +
            "COUNT(DISTINCT s.id) AS sessionCount, COUNT(m.id) AS messageCount, " +
            "COALESCE(SUM(m.token_count), 0) AS totalTokens " +
            "FROM agent a " +
            "LEFT JOIN session s ON s.agent_id = a.id AND s.deleted = 0 " +
            "LEFT JOIN message m ON m.session_id = s.id AND m.deleted = 0 " +
            "WHERE a.deleted = 0 " +
            "GROUP BY a.id, a.name " +
            "ORDER BY sessionCount DESC, messageCount DESC " +
            "LIMIT 20")
    List<Map<String, Object>> selectAgentUsageStats();

    @Select("SELECT * FROM message " +
            "WHERE session_id = #{sessionId} AND deleted = 0 AND id > #{afterMessageId} " +
            "ORDER BY id ASC")
    List<Message> selectMessagesAfterId(@Param("sessionId") Long sessionId,
                                        @Param("afterMessageId") Long afterMessageId);

    @Select("SELECT * FROM message " +
            "WHERE id = #{messageId} AND session_id = #{sessionId} AND deleted = 0")
    Message selectValidBoundaryMessage(@Param("sessionId") Long sessionId,
                                       @Param("messageId") Long messageId);

    @Select("SELECT COALESCE(MAX(id), 0) FROM message " +
            "WHERE session_id = #{sessionId} AND deleted = 0")
    long selectMaxMessageId(@Param("sessionId") Long sessionId);

    /**
     * 按候选会话批量取回每个会话前几条命中 user 消息（供会话搜索的二次纯文本校验与 snippet 生成）。
     * 窗口函数每会话至多取 5 条（id ASC），避免全局 LIMIT 截断；Service 层按第一条文本命中即止。
     * 若只取第一条，会话最早的命中消息为多模态假命中（关键词在图片 URL/JSON 字段）时会误剔真实命中会话。
     * LIKE 特殊字符已由 Service 转义。
     */
    @Select({
            "<script>",
            "SELECT t.sessionId AS sessionId, t.id AS id, t.content AS content",
            "FROM (",
            "  SELECT m.session_id AS sessionId, m.id AS id, m.content AS content,",
            "         ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.id ASC) AS rn",
            "  FROM message m",
            "  WHERE m.deleted = 0 AND m.role = 'USER'",
            "    AND m.session_id IN",
            "    <foreach collection='sessionIds' item='sid' open='(' separator=',' close=')'>#{sid}</foreach>",
            "    AND m.content LIKE CONCAT('%', #{escapedKeyword}, '%') ESCAPE '\\\\'",
            ") t",
            "WHERE t.rn &lt;= 5",
            "ORDER BY t.id ASC",
            "</script>"
    })
    List<Message> selectMessagesForSearch(@Param("sessionIds") List<Long> sessionIds,
                                          @Param("escapedKeyword") String escapedKeyword);
}
