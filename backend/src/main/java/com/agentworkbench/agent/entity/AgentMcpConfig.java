package com.agentworkbench.agent.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

@Data
@TableName("agent_mcp_config")
public class AgentMcpConfig {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long agentId;

    private String serverUrl;

    private String transport;

    private String config;

    private Integer status;
}
