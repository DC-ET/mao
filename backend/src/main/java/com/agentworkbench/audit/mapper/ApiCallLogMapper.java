package com.agentworkbench.audit.mapper;

import com.agentworkbench.audit.entity.ApiCallLog;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface ApiCallLogMapper extends BaseMapper<ApiCallLog> {
}
