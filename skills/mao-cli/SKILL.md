---
name: mao-cli
description: Mao 产品知识库与代理入口：项目说明、安装部署配置、管理后台/桌面/Electron/安卓/mao-agent 全端手册与排障，以及统一 REST CLI（原 mao-user-cli + mao-admin-cli）。不覆盖消息发送与 WebSocket Agent 运行。
---

# mao-cli

Mao 的**产品文档唯一正文**（可独立分发）+ **REST 操作 CLI**。Agent 应先读本页路由，再打开对应 `reference/*.md`；需要调 API 时用本目录内置 CLI。

## 知识库路由

| 用户问题 | 阅读 |
|----------|------|
| 这是什么 / Git / 架构 / 核心功能 / 与 Codex 对比 | [reference/project.md](reference/project.md) |
| 本地开发：克隆、MySQL、启动三端 | [reference/install.md](reference/install.md) |
| 生产自托管：服务器、Nginx、HTTPS、升级、运维 | [reference/deploy.md](reference/deploy.md) |
| 双域名合并为单域名 / 改 Nginx | 仓库 [docs/guides/single-domain-nginx-migration.md](../../docs/guides/single-domain-nginx-migration.md) |
| 环境变量、数据目录、默认账号、认证方式 | [reference/config.md](reference/config.md) |
| 管理后台怎么用 | [reference/admin.md](reference/admin.md) |
| 桌面 Web 端（任务、工作区、通知、微信等） | [reference/desktop.md](reference/desktop.md) |
| 飞书机器人通道（绑定 / 群聊@机器人 / 多机器人配置） | [reference/feishu-bot.md](reference/feishu-bot.md) |
| Electron LOCAL、工具审批、打包与自动更新 | [reference/electron.md](reference/electron.md) |
| 安卓壳、远程前端、APK OTA | [reference/android.md](reference/android.md) |
| 终端对话客户端 mao-agent | [reference/mao-agent.md](reference/mao-agent.md) |
| 部署/登录/LOCAL/Git/通知等 FAQ | [reference/troubleshooting.md](reference/troubleshooting.md) |
| 首次部署、管理员上线、日常任务 + CLI | [business_process.md](business_process.md) |

**发版记录**：完整 `CHANGELOG` 在 Mao 源码仓库根目录；独立分发包以发行说明为准。

## REST CLI 何时使用

- 登录并缓存 JWT；查询/配置用户、角色、Agent、模型、Skill、会话元数据、文件诊断、定时任务、微信、MCP、审计等
- 脚本或 Agent 流程中以 JSON 消费上述 API

## REST CLI 何时不要使用

- **不要**发送对话、写入消息队列、连接 WebSocket 跑 Agent → 用 `mao-agent`（见 [reference/mao-agent.md](reference/mao-agent.md)）
- 未登录且未提供 `--token` / `MAO_TOKEN` 时不要调需鉴权接口
- 用户端与管理端同一 JWT；管理接口成败取决于账号权限

## 尚未覆盖的 REST 能力（明确不做 / 待补）

- 对话消息发送、消息队列写操作、WebSocket 流式会话
- `/v1/statistics/*` 用量统计（管理后台 UI 可用）
- 会话 `search` / `messages` 全文检索（管理端 UI 可用）
- 工作区 Git 写操作（commit/push 等，CLI 仅只读诊断）

## 安装与就绪（Agent 执行，勿让用户安装）

本 CLI 与本 Skill 同目录内置。`mao` / `mao-cli` 不可用时 **Agent 自行安装**：

```bash
npm install . -g   # 在本 Skill 目录执行
```

推荐：先调用 CLI → `command not found` 则安装 → 立即重试。权限失败时用 `node bin/mao-cli.js ...`。

要求 Node.js ≥ 18。命令名：`mao` / `mao-cli`。兼容别名：`mao-user`、`mao-user-cli`、`mao-admin`、`mao-admin-cli`。

## 鉴权与 baseUrl

| 项 | 说明 |
|----|------|
| 默认 baseUrl | `https://mao.etarch.cn/api/v1` |
| 环境变量 | `MAO_BASE_URL`（优先）；兼容 `MAO_USER_BASE_URL`、`MAO_ADMIN_BASE_URL` |
| 全局选项 | `--base-url`、`--token`、`--json`、`--raw`、`--timeout-ms`、`-h/--help` |
| Token | `--token` > `MAO_TOKEN` > `~/.mao/auth.json` |
| 缓存文件 | `~/.mao/auth.json`（只存 JWT，不存密码） |

```bash
mao auth login --username <用户名> --password <密码>
```

云端/微信 shell 中后端会注入 `MAO_TOKEN`，无需 `auth login`。见 [reference/auth.md](reference/auth.md)。

`model create/update` 的 `--base-url` 表示**模型服务商 API**，服务端地址请用 `MAO_BASE_URL`。

## 统一响应约定

后端 `{ code, message, data, timestamp }`，`code === 0` 成功。`--json` / `--raw`；失败 stderr + exit 1；401 有场景化指引。

## 命令选择总规则

1. 401 → 云端/微信先查 `MAO_TOKEN`；本地终端再 `auth login` / `auth refresh`
2. 按模块读 `reference/*.md` 查参数
3. 用户会话 → `session`；全站检索 → `admin-session`
4. 个人技能 → `skill`；全局技能 → `skill-docs`
5. 先 `agent list` + `model list-active`，再 `session create`
6. `mao-admin session` / `skill` 自动映射到 `admin-session` / `skill-docs`
7. 跨模块流程 → [business_process.md](business_process.md)

## REST 模块文档索引

| 需求 | 阅读 |
|------|------|
| 登录 / 飞书 / 当前用户 | [reference/auth.md](reference/auth.md) |
| 用户 CRUD | [reference/user.md](reference/user.md) |
| 角色、权限点 | [reference/role.md](reference/role.md) |
| Agent 与经验 | [reference/agent.md](reference/agent.md) |
| 模型查询与管理端配置 | [reference/model.md](reference/model.md) |
| MCP 全局/用户级配置与偏好 | [reference/mcp.md](reference/mcp.md) |
| 当前用户会话元数据 | [reference/session.md](reference/session.md) |
| 管理端会话检索 | [reference/admin-session.md](reference/admin-session.md) |
| 会话待办 | [reference/todo.md](reference/todo.md) |
| 定时任务 | [reference/scheduled-task.md](reference/scheduled-task.md) |
| 个人 Skill | [reference/skill.md](reference/skill.md) |
| 全局 Skill 文档 | [reference/skill-docs.md](reference/skill-docs.md) |
| 个人指令 | [reference/command.md](reference/command.md) |
| 附件与工作区 | [reference/file.md](reference/file.md) |
| OSS / 上传配置 | [reference/oss.md](reference/oss.md) |
| 任务面板/通知偏好 | [reference/pref.md](reference/pref.md) |
| Git 凭证 | [reference/git.md](reference/git.md) |
| 内置工具查询 | [reference/tool.md](reference/tool.md) |
| 微信 Bot | [reference/weixin.md](reference/weixin.md) |
| 运行监控 | [reference/runtime.md](reference/runtime.md) |
| 分析汇总 | [reference/analytics.md](reference/analytics.md) |
| 审计日志 | [reference/audit.md](reference/audit.md) |
| 系统设置 | [reference/settings.md](reference/settings.md) |
