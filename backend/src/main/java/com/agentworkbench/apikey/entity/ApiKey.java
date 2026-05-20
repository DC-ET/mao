package com.agentworkbench.apikey.entity;

import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("api_key")
public class ApiKey {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private String name;

    private String apiKey;

    private String permissions;

    private Integer rateLimit;

    private Integer status;

    private LocalDateTime lastUsedAt;

    private LocalDateTime expiresAt;

    private LocalDateTime createdAt;
}
