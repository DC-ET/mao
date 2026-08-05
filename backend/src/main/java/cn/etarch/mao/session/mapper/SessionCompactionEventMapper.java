package cn.etarch.mao.session.mapper;

import cn.etarch.mao.session.entity.SessionCompactionEvent;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Delete;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.List;

@Mapper
public interface SessionCompactionEventMapper extends BaseMapper<SessionCompactionEvent> {

    @Select("SELECT * FROM session_compaction_event WHERE session_id = #{sessionId} ORDER BY boundary_msg_id ASC, id ASC")
    List<SessionCompactionEvent> selectBySessionId(@Param("sessionId") Long sessionId);

    @Delete("DELETE FROM session_compaction_event WHERE session_id = #{sessionId}")
    int deleteBySessionId(@Param("sessionId") Long sessionId);
}
