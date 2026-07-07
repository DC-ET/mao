package cn.etarch.mao.common.result;

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
    LOGIN_FAILED(1005, "用户名或密码错误"),
    ACCOUNT_DISABLED(1006, "账号已被禁用"),

    // 参数校验错误 2001-2999
    PARAM_INVALID(2001, "参数校验失败"),
    PARAM_MISSING(2002, "缺少必要参数"),

    // 业务逻辑错误 3001-3999
    AGENT_NOT_FOUND(3001, "Agent 不存在"),
    SESSION_NOT_FOUND(3002, "会话不存在"),
    MODEL_NOT_FOUND(3003, "模型配置不存在"),
    MODEL_IS_DEFAULT(3006, "不能删除默认模型，请先修改默认模型"),
    SKILL_NOT_FOUND(3004, "Skill 不存在"),
    AGENT_ACCESS_DENIED(3005, "无权访问该 Agent"),
    LLM_CALL_FAILED(3007, "LLM 调用失败"),
    LLM_TIMEOUT(3008, "LLM 调用超时"),
    SKILL_NAME_DUPLICATE(3010, "Skill 名称已存在"),
    COMMAND_NOT_FOUND(3011, "指令不存在"),
    COMMAND_NAME_DUPLICATE(3012, "指令名称已存在"),
    COMMAND_NAME_INVALID(3013, "指令名称只能包含字母、数字、中文、下划线和连字符"),
    COMMAND_SYSTEM_READONLY(3020, "系统预置指令不可编辑或删除"),
    USER_NOT_FOUND(3014, "用户不存在"),
    USERNAME_DUPLICATE(3015, "用户名已存在"),
    CANNOT_DISABLE_SELF(3016, "不能禁用当前登录用户"),
    CANNOT_REMOVE_LAST_ADMIN(3017, "不能移除最后一个管理员"),
    USER_PASSWORD_MANAGED_BY_LDAP(3018, "LDAP 用户密码由目录服务管理"),
    PASSWORD_INVALID(3019, "密码格式不符合要求"),
    GIT_CREDENTIAL_NOT_FOUND(3021, "Git 凭证不存在"),
    GIT_CREDENTIAL_DOMAIN_DUPLICATE(3022, "该域名的凭证已存在"),

    // 服务端内部错误 5001-5999
    INTERNAL_ERROR(5001, "服务内部错误"),
    DATABASE_ERROR(5002, "数据库错误"),
    FILE_UPLOAD_ERROR(5004, "文件上传失败"),
    GIT_CLONE_FAILED(5005, "Git 仓库克隆失败");

    private final int code;
    private final String message;
}
