package cn.etarch.mao.harness.mcp.preference.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * 用户级 MCP 服务器启用偏好。
 * 用户在客户端设置页可单独停用/启用某台 MCP 服务器（仅影响本人会话）；
 * 无记录 = 未单独配置，跟随管理后台全局启用状态。
 */
@Data
@TableName("user_mcp_preference")
public class UserMcpPreference {

    @TableId(type = IdType.AUTO)
    private Long id;

    private Long userId;

    private Long serverId;

    /** 用户级启用状态：0=停用 1=启用 */
    private Integer enabled;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
