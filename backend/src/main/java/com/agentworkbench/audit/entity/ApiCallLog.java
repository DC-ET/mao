package com.agentworkbench.audit.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("api_call_log")
public class ApiCallLog {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long sessionId;

    private Long agentId;

    private String endpoint;

    private String method;

    private String requestBody;

    private Integer responseCode;

    private Integer latencyMs;

    private String llmModel;

    private Integer llmTokensIn;

    private Integer llmTokensOut;

    private LocalDateTime createdAt;
}
