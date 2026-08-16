---
name: mao-user-cli
description: 用户端（桌面端）非对话操作能力：JWT 登录、Agent/模型/会话元数据、定时任务、微信 Bot 绑定、个人 Skill 与指令、附件与工作区/Git 只读诊断、OSS STS、Git 凭证与偏好；不覆盖消息发送、队列写操作与 WebSocket Agent 运行。
---

# mao-user-cli

面向 Mao 桌面端用户 API 的命令行工具与 Agent 执行指南。用于完成**非对话**配置与运维操作。本 CLI 与本 Skill 同目录内置；Agent 应直接调用，CLI 未就绪时自行安装，不要让用户手动安装。

## 何时使用

- 需要登录用户端并缓存 JWT
- 需要创建/管理 LOCAL 或 CLOUD 会话元数据（标题、置顶、收藏、归档、权限级别）
- 需要管理个人 Skill、快捷指令、附件、工作区文件、工作区 Git 状态/差异、OSS STS、Git 凭证、任务面板/任务通知/微信语音回复偏好
- 需要下载 LOCAL 模式技能同步包（zip）
- 需要查询/维护定时任务，或绑定/解绑微信 Bot

## 何时不要使用

- **不要**用本 CLI 发送对话、写入/重排/插入消息队列、或连接 WebSocket 跑 Agent
- 不要用本 CLI 做管理后台专属运维（用户/角色/系统设置/审计等）——那是管理端能力
- 不要在未登录且未提供 `--token` / `MAO_TOKEN` 时调用需鉴权接口

## 安装与就绪（Agent 执行，勿让用户安装）

本 CLI 与本 Skill 同目录内置。调用前若 `mao-user` / `mao-user-cli` 不可用，**由 Agent 自行安装**，禁止让用户手动安装或中断任务去询问。

```bash
# 在本 Skill 目录下执行
npm install . -g
```

推荐流程：先直接调用 CLI → 若 `command not found` 则执行上述安装 → 安装后立即重试原命令。全局安装因权限失败时，可用 `node bin/mao-user-cli.js ...` 从本目录直接运行。

### 版本不匹配自愈（重装 CLI）

CLI 已存在但行为与本文档不符时，通常是全局安装的是**旧版本**（可能来自其他会话目录），**由 Agent 重新安装并重试原命令**，禁止让用户手动处理。典型信号：

- 执行 SKILL.md 中存在的命令却报 `未知模块` / `未知子命令`（如 `pref weixin`、`quick-command` 等较新命令）
- 参数、输出格式与 reference 文档描述不一致
- 错误文案与本文档说明不符（如 401 无场景化指引，说明是旧版 CLI）

```bash
# 在本 Skill 目录下执行，强制覆盖全局链接
npm install . -g
which mao-user   # 确认指向本 Skill 目录的 bin，而不是其他 runtime 会话目录
```

重装后立即重试原命令。若 `which` 仍指向旧路径（链接未被覆盖），直接用 `node bin/mao-user-cli.js ...` 从本目录运行兜底。

要求：Node.js >= 18。零 npm 运行时依赖。命令名：`mao-user` 或 `mao-user-cli`。

## 鉴权与 baseUrl

- 默认 baseUrl：`https://mao.etarch.cn/api/v1`
- 覆盖方式：`--base-url` 或环境变量 `MAO_USER_BASE_URL`（仅本 CLI 的 API 地址）
- 鉴权：`Authorization: Bearer <accessToken>`
- Token 来源优先级：`--token` > `MAO_TOKEN` > `~/.mao/auth.json`（与 mao-admin-cli 共用）
- Refresh：`MAO_REFRESH_TOKEN` 或缓存中的 `refreshToken`
- 缓存结构：`{ accessToken, refreshToken, expiresIn, user, savedAt }`（只存 JWT，不存密码）

### 云端 / 微信通道自动免登录

Agent 在**云端工作区**或**微信通道**通过 `shell` 工具执行本 CLI 时，后端已按当前会话用户自动签发短效 `MAO_TOKEN` 并注入环境变量（`export MAO_TOKEN=...`），**无需执行 `auth login`**，直接调用即可。每次 `shell` 的 `exec` / `write_stdin` 前都会刷新注入，持久会话无需手动刷新。

- 判断是否已注入：`echo ${MAO_TOKEN:+injected}` 或 `mao-user auth whoami`
- 若返回 401 / 未登录：优先确认 `MAO_TOKEN` 是否注入；未注入属于 shell 环境异常（可重开会话），不要盲目执行 `auth login`
- 仅**本地终端 / 手动操作**等无注入场景才需要 `auth login`

## 全局选项

| 选项 | 说明 |
|------|------|
| `--base-url` | API 根地址 |
| `--token` | 临时 JWT |
| `--json` | JSON 输出 |
| `--raw` | 输出完整 `{code,message,data,timestamp}` |
| `--timeout-ms` | 超时毫秒，默认 30000 |
| `-h` / `--help` | 帮助 |

成功时服务端 `code===0`；CLI 默认打印 `data`。

## 命令选择总规则

1. 先 `auth login`（或飞书流程）拿到 token
2. 需要会话时先 `agent list` + `model list-active`，再 `session create`
3. 只改会话元数据用 `session update|pin|favorite|archive|mark-read`
4. 个人能力用 `skill` / `command` / `quick-command`
5. 文件、工作区 Git 与 OSS 用 `file` / `oss` / `upload-config`
6. CLOUD git 克隆前配置 `git` 凭证
7. 定时任务与微信 Bot 用 `scheduled-task` / `weixin`
8. LOCAL 同步技能用 `skill sync-package`

## 模块索引

按需阅读 `reference/` 下对应文档（参数说明自包含，勿查源码）：

| 需求 | 文档 |
|------|------|
| 登录 / 飞书 / 当前用户 | [reference/auth.md](reference/auth.md) |
| Agent 与经验 | [reference/agent.md](reference/agent.md) |
| 模型查询 | [reference/model.md](reference/model.md) |
| 会话元数据 | [reference/session.md](reference/session.md) |
| 会话待办 | [reference/todo.md](reference/todo.md) |
| 定时任务 | [reference/scheduled-task.md](reference/scheduled-task.md) |
| 个人 Skill / 同步包 | [reference/skill.md](reference/skill.md) |
| 个人指令 | [reference/command.md](reference/command.md) |
| 附件与工作区 | [reference/file.md](reference/file.md) |
| OSS / 上传配置 | [reference/oss.md](reference/oss.md) |
| 任务面板/任务通知/微信语音回复偏好 | [reference/pref.md](reference/pref.md) |
| Git 凭证 | [reference/git.md](reference/git.md) |
| 内置工具查询 | [reference/tool.md](reference/tool.md) |
| 微信 Bot 绑定 | [reference/weixin.md](reference/weixin.md) |

业务流程总览见 [business_process.md](business_process.md)。

## 错误处理

- 缺少必填参数：CLI 直接报错退出
- HTTP 非 2xx 或业务 `code!==0`：打印错误并以非零码退出
- 未登录（HTTP 401）：CLI 会输出场景化指引——云端/微信场景先确认 `MAO_TOKEN` 是否注入（`echo ${MAO_TOKEN:+injected}`），必要时重开 shell 会话；本地终端执行 `auth login` 或 `auth refresh`
- 网络错误：CLI 会附带底层原因（连接拒绝 / 超时 / DNS），据此判断是 baseUrl 配错还是网络不可达
- 业务错误：提示可用 `--raw` 查看完整响应
- 二进制接口（下载 / sync-package）：以文件是否写出判断成功
