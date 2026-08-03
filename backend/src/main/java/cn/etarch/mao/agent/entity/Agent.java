package cn.etarch.mao.agent.entity;

import com.baomidou.mybatisplus.annotation.*;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@TableName("agent")
public class Agent {

    @TableId(type = IdType.AUTO)
    private Long id;

    private String name;

    private String description;

    private String systemPrompt;

    private Long creatorId;

    private String configJson;

    /** 该 Agent 可用的 Skill 知识文档名称列表（JSON 数组），为空则加载全部 */
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private String skillNames;

    /** 该 Agent 启用的 MCP 服务器 ID 列表（JSON 数组），为空表示不启用 MCP */
    @TableField(updateStrategy = FieldStrategy.ALWAYS)
    private String mcpServerIds;

    /** 是否默认 Agent：0=否 1=是 */
    private Integer isDefault;

    /** Logical deletion flag: 0=normal, 1=deleted */
    @TableLogic
    private Integer deleted;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
