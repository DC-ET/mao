# 管理后台使用

管理后台用于平台治理与配置。默认开发地址 `http://localhost:5200/admin/`；生产与桌面 Web 同一域名，路径为 `https://mao.example.com/admin/`（由部署方配置）。

登录与账号见 [config.md](config.md)。REST 运维可用 `mao` CLI（`user`、`role`、`model`、`skill-docs`、`admin-session`、`audit` 等）。

## 数据概览

查看用户、Agent、会话、调用等统计。概览上的异常会话可点进运行监控；周期报表与 Token 排行见用量分析。

## 模型管理

**使用前必须配置真实模型**。Mao 通过 OpenAI 兼容协议调用 LLM。

| 字段 | 说明 |
|------|------|
| 名称 | 展示名 |
| 供应商 | OpenAI、DeepSeek 等 |
| 模型标识 | API 中的 model ID |
| API 地址 | 兼容接口根，通常 `/v1` 结尾 |
| API Key | 供应商密钥 |
| 上下文窗口 | token 上限 |
| 支持视觉 | 是否接受图片 |
| 默认模型 | 新会话默认 |

注意：初始化占位模型须替换 Key；不支持视觉的模型勿开视觉；保存后可用「测试连接」。

CLI：`mao model list|create|update|delete|set-status|test`（见 [model.md](model.md)）。

## Agent 管理

创建不同职责的智能体（代码、运维、文档等）。

| 字段 | 说明 |
|------|------|
| 名称 / 描述 | 展示与说明 |
| 系统提示词 | 角色、边界、工具原则 |
| 关联 Skills | 留空则默认全部 |
| 标签 | 分类检索 |
| 默认 Agent | 新建任务、微信未指定时使用 |

CLI：`mao agent list|get|create|update` 等（见 [agent.md](agent.md)）。

## Skills 管理

维护平台 Skill 文档目录。为内部规范、排障流程编写独立 Skill；按 Agent 场景关联子集。

CLI 全局目录：`mao skill-docs`（见 [skill-docs.md](skill-docs.md)）。

## 用户管理

新增/编辑用户、禁用、重置密码、分配角色。

CLI：`mao user ...`（见 [user.md](user.md)）。

## 角色权限

RBAC：创建角色、分配权限点、关联用户。普通用户不应有模型密钥、审计等敏感权限。

CLI：`mao role ...`、`mao permission list`（见 [role.md](role.md)）。

## MCP 服务器

管理全局 MCP（stdio / HTTP）：创建、启停、测试连接、查看工具列表。用户可在桌面端配置私有 MCP；会话按 Agent 注入 `mcp__{server}__{tool}`。

CLI：`mao mcp ...`（见 [mcp.md](mcp.md)）。

## 会话管理

查看全站会话：用户、Agent、状态、消息与工具调用。用户反馈异常时从此定位。

CLI：`mao admin-session ...`（见 [admin-session.md](admin-session.md)）。

## 定时任务

查看 Cron、启用/暂停、删除；定位 `QUEUED`（会话忙时排队）与失败记录。

CLI：`mao scheduled-task ...`（创建通常由 Agent 工具完成）。

## 审计日志

追踪登录失败、用户/角色变更、模型与 Agent 配置变更、敏感操作。

CLI：`mao audit ...`（见 [audit.md](audit.md)）。

## 运行监控

后端在线、WebSocket、长时间运行会话、工具失败、通知/微信连续失败等。

CLI：`mao runtime ...`（见 [runtime.md](runtime.md)）。

## 用量分析

模型与 Agent 使用趋势（管理后台 UI；REST 统计 API 暂未纳入 mao-cli）。

## 系统设置

平台级配置，例如：

- `weixin.agentId` / `weixin.modelId`：微信通道 Agent 与模型
- `session.titleModelId`：会话标题生成模型
- `git.commitMessageModelId`：Git 提交信息生成模型

CLI：`mao settings list|set`（见 [settings.md](settings.md)）。

## 管理员上线清单

正式开放前建议完成 [business_process.md](business_process.md) 中的检查项。
