package cn.etarch.mao.usage.mapper;

import cn.etarch.mao.usage.entity.LlmUsage;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;
import org.apache.ibatis.annotations.Param;
import org.apache.ibatis.annotations.Select;

import java.util.Map;

@Mapper
public interface LlmUsageMapper extends BaseMapper<LlmUsage> {
    @Select("SELECT COALESCE(SUM(prompt_tokens), 0) AS promptTokens, " +
            "COALESCE(SUM(completion_tokens), 0) AS completionTokens, " +
            "COALESCE(SUM(total_tokens), 0) AS totalTokens, COUNT(*) AS callCount " +
            "FROM llm_usage WHERE model_id = #{modelId}")
    Map<String, Object> sumByModelId(@Param("modelId") Long modelId);
}
