package com.agentworkbench.command.mapper;

import com.agentworkbench.command.entity.UserCommand;
import com.baomidou.mybatisplus.core.mapper.BaseMapper;
import org.apache.ibatis.annotations.Mapper;

@Mapper
public interface UserCommandMapper extends BaseMapper<UserCommand> {
}
