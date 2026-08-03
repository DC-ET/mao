package cn.etarch.mao.harness.mcp.entity;

import com.baomidou.mybatisplus.annotation.FieldFill;
import com.baomidou.mybatisplus.annotation.IdType;
import com.baomidou.mybatisplus.annotation.TableField;
import com.baomidou.mybatisplus.annotation.TableId;
import com.baomidou.mybatisplus.annotation.TableLogic;
import com.baomidou.mybatisplus.annotation.TableName;
import lombok.Data;

import java.time.LocalDateTime;

/**
 * MCP 服务器配置实体。
 * 支持两种连接类型：
 * - STDIO：本地子进程方式（command + args_json）
 * - HTTP：远程 URL（HTTP/SSE）
 */
@Data
@TableName("mcp_server")
public class McpServer {

    public static final String TYPE_STDIO = "STDIO";
    public static final String TYPE_HTTP = "HTTP";

    public static final String STATUS_ENABLED = "ENABLED";
    public static final String STATUS_DISABLED = "DISABLED";

    @TableId(type = IdType.AUTO)
    private Long id;

    /** 归属用户ID：0=全局服务器（管理员维护）；>0=该用户私有服务器 */
    private Long userId;

    /** 服务器唯一标识（小写字母/数字/下划线/中划线），工具名前缀来源 */
    private String name;

    private String description;

    /** STDIO | HTTP */
    private String serverType;

    /** STDIO 启动命令，如 npx */
    private String command;

    /** STDIO 启动参数 JSON 数组 */
    private String argsJson;

    /** HTTP/SSE 服务器 URL */
    private String url;

    /** 环境变量 JSON（整体 AES/GCM 加密存储） */
    private String envJson;

    /** ENABLED | DISABLED */
    private String status;

    /** Logical deletion flag: 0=normal, 1=deleted */
    @TableLogic
    private Integer deleted;

    /** 归属用户名（仅管理列表展示用，非表字段） */
    @TableField(exist = false)
    private String userName;

    @TableField(fill = FieldFill.INSERT)
    private LocalDateTime createdAt;

    @TableField(fill = FieldFill.INSERT_UPDATE)
    private LocalDateTime updatedAt;
}
