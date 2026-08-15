package cn.etarch.mao.harness.delegate.mapper;

import cn.etarch.mao.harness.delegate.entity.SubagentExecution;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;
import org.apache.ibatis.annotations.Update;

import java.util.List;

@Mapper
public interface SubagentExecutionMapper extends BaseMapper<SubagentExecution> {

    @Select("""
            SELECT * FROM subagent_execution
            WHERE delivery_status = 'PENDING'
              AND status IN ('RUNNING', 'RECOVERING', 'COMPLETED', 'FAILED', 'CANCELLED')
            ORDER BY parent_session_id, id
            """)
    List<SubagentExecution> selectRecoveryCandidates();

    @Select("""
            SELECT * FROM subagent_execution
            WHERE child_session_id = #{childSessionId}
            ORDER BY id ASC LIMIT 1
            """)
    SubagentExecution selectFirstByChildSessionId(Long childSessionId);

    @Select("SELECT * FROM subagent_execution WHERE id = #{id} FOR UPDATE")
    SubagentExecution selectByIdForUpdate(@Param("id") Long id);

    @Update("""
            UPDATE subagent_execution
            SET status = 'RECOVERING', updated_at = NOW()
            WHERE id = #{id} AND delivery_status = 'PENDING'
              AND status IN ('RUNNING', 'RECOVERING')
            """)
    int claimForRecovery(@Param("id") Long id);
}
