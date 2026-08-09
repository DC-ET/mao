package cn.etarch.mao.usage.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("llm_usage")
public class LlmUsage {
    @TableId(type = IdType.AUTO)
    private Long id;
    private Long userId;
    private Long sessionId;
    private Long modelId;
    private String scene;
    private Integer promptTokens;
    private Integer completionTokens;
    private Integer totalTokens;
    private Integer success;
    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;
}
