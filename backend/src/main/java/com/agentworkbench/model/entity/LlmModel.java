package com.agentworkbench.model.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

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

    /** 模型上下文窗口大小（token），用于压缩触发判定 */
    private Integer contextWindowTokens;

    private Integer status;

    /** 是否支持视觉/图片输入 */
    private Integer supportsVision;

    /** 是否默认模型：0=否 1=是 */
    private Integer isDefault;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
