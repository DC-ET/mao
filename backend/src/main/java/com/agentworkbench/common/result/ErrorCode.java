package com.agentworkbench.common.result;

import lombok.Getter;
import lombok.AllArgsConstructor;

@Getter
@AllArgsConstructor
public enum ErrorCode {

    // 认证/授权错误 1001-1999
    UNAUTHORIZED(1001, "未登录或登录已过期"),
    FORBIDDEN(1002, "无权限访问"),
    TOKEN_EXPIRED(1003, "Token 已过期"),
    TOKEN_INVALID(1004, "Token 无效"),
    LOGIN_FAILED(1005, "登录失败"),
    ACCOUNT_DISABLED(1006, "账号已被禁用"),

    // 参数校验错误 2001-2999
    PARAM_INVALID(2001, "参数校验失败"),
    PARAM_MISSING(2002, "缺少必要参数"),

    // 业务逻辑错误 3001-3999
    AGENT_NOT_FOUND(3001, "Agent 不存在"),
    SESSION_NOT_FOUND(3002, "会话不存在"),
    MODEL_NOT_FOUND(3003, "模型配置不存在"),
    SKILL_NOT_FOUND(3004, "Skill 不存在"),
    AGENT_ACCESS_DENIED(3005, "无权访问该 Agent"),
    HUB_ALREADY_INSTALLED(3006, "已安装该 Agent"),
    LLM_CALL_FAILED(3007, "LLM 调用失败"),
    LLM_TIMEOUT(3008, "LLM 调用超时"),
    MCP_CONNECT_FAILED(3009, "MCP Server 连接失败"),

    // 服务端内部错误 5001-5999
    INTERNAL_ERROR(5001, "服务内部错误"),
    DATABASE_ERROR(5002, "数据库错误"),
    REDIS_ERROR(5003, "缓存服务错误"),
    FILE_UPLOAD_ERROR(5004, "文件上传失败");

    private final int code;
    private final String message;
}
