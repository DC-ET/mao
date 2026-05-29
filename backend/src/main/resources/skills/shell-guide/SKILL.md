---
name: shell-guide
description: Shell 会话工具使用指南，支持有状态的多轮操作
---

# Shell 会话工具使用指南

## 概述

`shell` 工具有状态的 Shell 会话，支持：
- **会话持久化**：工作目录在多次调用间保持
- **输出管理**：长输出自动截断预览，完整内容落盘可查

## 基本用法

### 执行普通命令

```json
{
  "action": "exec",
  "command": "ls -la"
}
```

返回示例：
```
exit_code: 0
session_id: sh-123-1699999999
elapsed_ms: 156
current_workdir: /workspace/project
output_lines: 15
---
total 64
drwxr-xr-x  8 user  staff  256 Nov 15 10:30 .
drwxr-xr-x  3 user  staff   96 Nov 15 10:00 ..
...
```

### 复用会话

第一次调用创建会话，后续调用通过 `session_id` 复用：

```json
// 第一次：创建会话并 cd
{"action": "exec", "command": "cd /tmp && mkdir test", "session_id": "s1"}

// 后续：在同一个会话中执行
{"action": "exec", "command": "ls", "session_id": "s1"}
```

### 指定工作目录

```json
{
  "action": "exec",
  "command": "npm install",
  "workdir": "frontend"
}
```

### 写入 stdin

向正在运行的会话发送输入（适用于等待用户输入的命令）：

```json
// 启动一个需要确认的脚本
{"action": "exec", "command": "./deploy.sh", "session_id": "s1"}

// 脚本等待输入 yes
{"action": "write_stdin", "session_id": "s1", "input": "yes\n"}
```

## 会话管理

### 列出活跃会话

```json
{
  "action": "list"
}
```

返回：
```json
{
  "sessions": [
    {
      "session_id": "sh-123-1699999999",
      "current_workdir": "/workspace/project",
      "command_count": 5,
      "created_at": "2024-01-15T10:30:00Z"
    }
  ],
  "count": 1
}
```

### 关闭会话

```json
{
  "action": "close",
  "session_id": "sh-123-1699999999"
}
```

## 输出管理

### 长输出处理

当命令输出超过限制时：
- **预览**：返回尾部 100 行 / 10000 字符
- **落盘**：完整输出写入 `workspace/shellOutput/` 目录
- **查看完整输出**：使用 `read_file` 工具

示例：
```json
// 执行产生大量输出的命令
{"action": "exec", "command": "find / -name '*.log' 2>/dev/null"}

// 返回中包含 output_file 路径
// output_file: shellOutput/sh-123_1.out

// 使用 read_file 查看完整输出
{"action": "read", "path": "shellOutput/sh-123_1.out"}
```

### 调整输出等待时间

对于慢速命令，增加 `yield_time_ms`：

```json
{
  "action": "exec",
  "command": "npm run build",
  "yield_time_ms": 30000
}
```

## 最佳实践

### 多步操作使用同一会话

```json
// 构建项目
{"action": "exec", "command": "cd /workspace/project", "session_id": "build"}
{"action": "exec", "command": "npm install", "session_id": "build"}
{"action": "exec", "command": "npm run build", "session_id": "build"}
```

## 与 BashTool 的区别

| 特性 | bash | shell |
|------|------|-------|
| 状态 | 无状态 | 有状态会话 |
| 输出处理 | 截断丢弃 | 截断 + 落盘 |
| 适用场景 | 单次命令 | 多步操作 |

## 资源限制

- 每个对话最多 5 个活跃会话
- 会话空闲超时：30 分钟
- 会话最大生命周期：2 小时
- 命令最大长度：10000 字符
