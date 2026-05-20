package com.agentworkbench.agent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("agent_skill")
public class AgentSkill {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long agentId;

    private Long skillId;

    private String config;
}
