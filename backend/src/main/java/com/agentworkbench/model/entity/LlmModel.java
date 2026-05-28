package com.agentworkbench.model.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.math.BigDecimal;
import java.time.LocalDateTime;

@Data
@TableName("llm_model")
public class LlmModel {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String provider;

    private String baseUrl;

    private String apiKey;

    private String modelId;

    private Integer maxTokens;

    /** 模型上下文窗口大小（token），用于压缩触发判定 */
    private Integer contextWindowTokens;

    private BigDecimal temperatureMax;

    private Integer status;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
