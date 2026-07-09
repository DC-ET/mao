---
name: mao-user-cli
description: 用户端（桌面端）非对话操作能力：JWT 登录、Agent/模型/会话元数据、个人 Skill 与指令、附件与工作区、OSS STS、Git 凭证与任务面板偏好；不覆盖消息发送、消息历史、队列与 WebSocket Agent 运行。
---

# mao-user-cli

面向 Mao 桌面端用户 API 的命令行工具与 Agent 执行指南。用于完成**非对话**配置与运维操作。本 CLI 与本 Skill 同目录内置；Agent 应直接调用，CLI 未就绪时自行安装，不要让用户手动安装。

## 何时使用

- 需要登录用户端并缓存 JWT
- 需要创建/管理 LOCAL 或 CLOUD 会话元数据（标题、置顶、收藏、归档、权限级别）
- 需要管理个人 Skill、快捷指令、附件、工作区文件、OSS STS、Git 凭证、任务面板偏好
- 需要下载 LOCAL 模式技能同步包（zip）

## 何时不要使用

- **不要**用本 CLI 发送对话、拉取消息历史、操作消息队列、查看 activities、或连接 WebSocket 跑 Agent
- 不要用本 CLI 做管理后台专属运维（用户/角色/系统设置/审计等）——那是管理端能力
- 不要在未登录且未提供 `--token` / `MAO_TOKEN` 时调用需鉴权接口

## 安装与就绪（Agent 执行，勿让用户安装）

本 CLI 与本 Skill 同目录内置。调用前若 `mao-user` / `mao-user-cli` 不可用，**由 Agent 自行安装**，禁止让用户手动安装或中断任务去询问。

```bash
# 在本 Skill 目录下执行
npm install . -g
```

推荐流程：先直接调用 CLI → 若 `command not found` 则执行上述安装 → 安装后立即重试原命令。全局安装因权限失败时，可用 `node bin/mao-user-cli.js ...` 从本目录直接运行。

要求：Node.js >= 18。零 npm 运行时依赖。命令名：`mao-user` 或 `mao-user-cli`。

## 鉴权与 baseUrl

- 默认 baseUrl：`https://mao.etarch.cn/api/v1`
- 覆盖方式：`--base-url` 或环境变量 `MAO_USER_BASE_URL`（仅本 CLI 的 API 地址）
- 鉴权：`Authorization: Bearer <accessToken>`
- Token 来源优先级：`--token` > `MAO_TOKEN` > `~/.mao/auth.json`（与 mao-admin-cli 共用）
- Refresh：`MAO_REFRESH_TOKEN` 或缓存中的 `refreshToken`
- 缓存结构：`{ accessToken, refreshToken, expiresIn, user, savedAt }`（只存 JWT，不存密码）

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
5. 文件与 OSS 用 `file` / `oss` / `upload-config`
6. CLOUD git 克隆前配置 `git` 凭证
7. LOCAL 同步技能用 `skill sync-package`

## 模块索引

按需阅读 `reference/` 下对应文档（参数说明自包含，勿查源码）：

| 需求 | 文档 |
|------|------|
| 登录 / 飞书 / 当前用户 | [reference/auth.md](reference/auth.md) |
| Agent 与经验 | [reference/agent.md](reference/agent.md) |
| 模型查询 | [reference/model.md](reference/model.md) |
| 会话元数据 | [reference/session.md](reference/session.md) |
| 会话待办 | [reference/todo.md](reference/todo.md) |
| 个人 Skill / 同步包 | [reference/skill.md](reference/skill.md) |
| 个人指令 | [reference/command.md](reference/command.md) |
| 附件与工作区 | [reference/file.md](reference/file.md) |
| OSS / 上传配置 | [reference/oss.md](reference/oss.md) |
| 任务面板偏好 | [reference/pref.md](reference/pref.md) |
| Git 凭证 | [reference/git.md](reference/git.md) |
| 内置工具查询 | [reference/tool.md](reference/tool.md) |

业务流程总览见 [business_process.md](business_process.md)。

## 错误处理

- 缺少必填参数：CLI 直接报错退出
- HTTP 非 2xx 或业务 `code!==0`：打印错误并以非零码退出
- 未登录：先执行 `auth login` 或传入 `--token`
- 二进制接口（下载 / sync-package）：以文件是否写出判断成功
