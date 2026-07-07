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
            "GROUP BY s.agent_id")
    List<Map<String, Object>> selectTokenStatsGroupByAgent();

    @Select("SELECT DATE(created_at) AS day, COUNT(*) AS count " +
            "FROM message WHERE created_at >= #{start} GROUP BY DATE(created_at)")
    List<Map<String, Object>> selectMessageCountsByDay(@Param("start") LocalDateTime start);

    @Select("SELECT s.user_id AS userId, COUNT(m.id) AS messageCount " +
            "FROM message m JOIN session s ON m.session_id = s.id " +
            "GROUP BY s.user_id")
    List<Map<String, Object>> selectMessageCountsByUser();

    @Select("SELECT model_id AS modelId, COUNT(*) AS messageCount " +
            "FROM message WHERE model_id IS NOT NULL GROUP BY model_id")
    List<Map<String, Object>> selectMessageCountsByModel();

    @Select("SELECT a.id AS agentId, a.name AS agentName, " +
            "COUNT(DISTINCT s.id) AS sessionCount, COUNT(m.id) AS messageCount, " +
            "COALESCE(SUM(m.token_count), 0) AS totalTokens " +
            "FROM agent a " +
            "LEFT JOIN session s ON s.agent_id = a.id " +
            "LEFT JOIN message m ON m.session_id = s.id " +
            "GROUP BY a.id, a.name " +
            "ORDER BY sessionCount DESC, messageCount DESC " +
            "LIMIT 20")
    List<Map<String, Object>> selectAgentUsageStats();
}
