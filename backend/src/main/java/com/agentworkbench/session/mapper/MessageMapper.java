package com.agentworkbench.session.mapper;

import com.agentworkbench.session.entity.Message;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Select;

import java.util.List;
import java.util.Map;

@Mapper
public interface MessageMapper extends BaseMapper<Message> {

    @Select("SELECT s.agent_id AS agentId, COALESCE(SUM(m.token_count), 0) AS totalTokens, COUNT(*) AS messageCount " +
            "FROM message m JOIN session s ON m.session_id = s.id " +
            "GROUP BY s.agent_id")
    List<Map<String, Object>> selectTokenStatsGroupByAgent();
}
