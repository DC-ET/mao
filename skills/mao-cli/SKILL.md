---
name: mao-cli
description: 统一的 Mao REST CLI（原 mao-user-cli + mao-admin-cli）：JWT 登录、用户端会话/技能/文件/偏好，以及管理端用户角色、模型配置、全局 Skill、会话监控、分析与审计。不覆盖消息发送与 WebSocket Agent 运行。
---

# mao-cli

面向 Agent 的 Mao REST 操作指南。合并了原 `mao-user-cli` 与 `mao-admin-cli`。本 CLI 与本 Skill 同目录内置；Agent 应直接调用，CLI 未就绪时自行安装，不要让用户手动安装。

## 何时使用

- 需要登录并缓存 JWT
- 需要创建/管理 LOCAL 或 CLOUD 会话元数据、个人 Skill、快捷指令、附件、工作区、OSS、Git 凭证、定时任务、微信 Bot
- 需要管理用户、角色、LLM 模型、全局 Skill、系统设置
- 需要查看管理端会话、运行态、分析汇总或审计日志
- 需要在脚本或 Agent 流程中以 JSON 方式消费上述 API

## 何时不要使用

- **不要**用本 CLI 发送对话、写入/重排/插入消息队列、或连接 WebSocket 跑 Agent——那是 `mao-agent`
- 不要在未登录且未提供 `--token` / `MAO_TOKEN` 时调用需鉴权接口
- 用户端与管理端走同一套 JWT；管理类接口是否成功取决于账号权限，不取决于从哪边登录

## 安装与就绪（Agent 执行，勿让用户安装）

本 CLI 与本 Skill 同目录内置。调用前若 `mao` / `mao-cli` 不可用，**由 Agent 自行安装**，禁止让用户手动安装或中断任务去询问。

```bash
# 在本 Skill 目录下执行
npm install . -g
```

推荐流程：先直接调用 CLI → 若 `command not found` 则执行上述安装 → 安装后立即重试原命令。全局安装因权限失败时，可用 `node bin/mao-cli.js ...` 从本目录直接运行。

### 版本不匹配自愈（重装 CLI）

CLI 已存在但行为与本文档不符时（仍只有 `mao-user` / `mao-admin`、缺少 `admin-session` / `skill-docs` 等），**由 Agent 重新安装并重试原命令**，禁止让用户手动处理。

```bash
# 在本 Skill 目录下执行，强制覆盖全局链接
npm install . -g
which mao   # 确认指向本 Skill 目录的 bin
```

重装后立即重试原命令。若 `which` 仍指向旧路径，直接用 `node bin/mao-cli.js ...` 从本目录运行兜底。

要求：Node.js >= 18。零 npm 运行时依赖。命令名：`mao` 或 `mao-cli`。兼容别名：`mao-user`、`mao-user-cli`、`mao-admin`、`mao-admin-cli`。

## 鉴权与 baseUrl

| 项 | 说明 |
|----|------|
| 默认 baseUrl | `https://mao.etarch.cn/api/v1` |
| 环境变量 | `MAO_BASE_URL`（优先）；兼容旧名 `MAO_USER_BASE_URL`、`MAO_ADMIN_BASE_URL` |
| 全局选项 | `--base-url`、`--token`、`--json`、`--raw`、`--timeout-ms`、`-h/--help` |
| 鉴权头 | `Authorization: Bearer <accessToken>` |
| Token 来源 | `--token` > `MAO_TOKEN` > `~/.mao/auth.json` |
| Token 缓存 | `~/.mao/auth.json`，结构 `{ accessToken, refreshToken, expiresIn, user, savedAt }`。只存 JWT，不存密码。 |

用户端与管理端是同一后端、同一 JWT。账号有对应权限即可调管理接口。

首次使用先登录：

```bash
mao auth login --username <用户名> --password <密码>
```

成功后自动写入缓存。`auth refresh` 使用缓存的 `refreshToken`；`auth logout` 调用服务端并清除本地缓存。

### 云端 / 微信通道自动免登录

Agent 在**云端工作区**或**微信通道**通过 `shell` 工具执行本 CLI 时，后端已按当前会话用户自动签发短效 `MAO_TOKEN` 并注入环境变量，**无需执行 `auth login`**。每次 `shell` 的 `exec` / `write_stdin` 前都会刷新注入。

- 判断是否已注入：`echo ${MAO_TOKEN:+injected}` 或 `mao auth whoami`
- 若返回 401 / 未登录：优先确认 `MAO_TOKEN` 是否注入；未注入属于 shell 环境异常（可重开会话），不要盲目执行 `auth login`
- 仅**本地终端 / 手动操作**等无注入场景才需要 `auth login`

**注意**：`model create/update` 的 `--base-url` 表示模型服务商 API 地址。此时请用 `MAO_BASE_URL` 指定服务端地址，避免与全局 `--base-url` 冲突。

## 统一响应约定

后端返回 `{ code, message, data, timestamp }`。`code === 0` 为成功。

- 默认：stdout 打印 `data`
- `--raw`：打印完整 Result
- `--json`：以 JSON 打印 `data`
- 失败：stderr 打印 `message`，进程 exitCode=1
- 未登录（HTTP 401）：CLI 会输出场景化指引（云端/微信先确认 `MAO_TOKEN` 注入；本地执行 `auth login`/`auth refresh`）
- 业务错误（`code!==0`）：提示可用 `--raw` 查看完整响应
- 二进制接口（下载 / sync-package）：以文件是否写出判断成功

## 命令选择总规则

1. 未登录或 401 → 云端/微信场景先确认 `MAO_TOKEN` 是否注入；仅本地/手动终端执行 `auth login`，必要时 `auth refresh`
2. 按业务域选模块，再读对应 `reference/*.md` 查参数
3. 用户自己的会话用 `session`；管理员检索全站会话用 `admin-session`
4. 个人技能用 `skill`；全局技能目录用 `skill-docs`
5. 需要会话时先 `agent list` + `model list-active`，再 `session create`
6. 逗号分隔数组参数（如 `--role-ids 1,2`）会自动拆分为数组
7. 以旧命令 `mao-admin session` / `mao-admin skill` 调用时，会自动映射到 `admin-session` / `skill-docs`
8. 跨模块流程见 [business_process.md](business_process.md)

## 模块文档索引

| 需求 | 阅读 |
|------|------|
| 登录 / 飞书 / 当前用户 | [reference/auth.md](reference/auth.md) |
| 用户 CRUD、重置密码、分配角色 | [reference/user.md](reference/user.md) |
| 角色、权限点 | [reference/role.md](reference/role.md) |
| Agent 与经验 | [reference/agent.md](reference/agent.md) |
| 模型查询与管理端配置 | [reference/model.md](reference/model.md) |
| 当前用户会话元数据 | [reference/session.md](reference/session.md) |
| 管理端会话检索 | [reference/admin-session.md](reference/admin-session.md) |
| 会话待办 | [reference/todo.md](reference/todo.md) |
| 定时任务 | [reference/scheduled-task.md](reference/scheduled-task.md) |
| 个人 Skill / 同步包 | [reference/skill.md](reference/skill.md) |
| 全局 Skill 文档 | [reference/skill-docs.md](reference/skill-docs.md) |
| 个人指令 | [reference/command.md](reference/command.md) |
| 附件与工作区 | [reference/file.md](reference/file.md) |
| OSS / 上传配置 | [reference/oss.md](reference/oss.md) |
| 任务面板/任务通知/微信语音回复偏好 | [reference/pref.md](reference/pref.md) |
| Git 凭证 | [reference/git.md](reference/git.md) |
| 内置工具查询 | [reference/tool.md](reference/tool.md) |
| 微信 Bot 绑定 | [reference/weixin.md](reference/weixin.md) |
| 运行监控 | [reference/runtime.md](reference/runtime.md) |
| 分析汇总 | [reference/analytics.md](reference/analytics.md) |
| 审计日志 | [reference/audit.md](reference/audit.md) |
| 系统设置 | [reference/settings.md](reference/settings.md) |
| 端到端业务流程 | [business_process.md](business_process.md) |

横跨多模块时：先应用本页全局规则，再分别打开相关 reference 文档。
