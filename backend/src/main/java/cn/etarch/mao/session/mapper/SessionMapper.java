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
}
