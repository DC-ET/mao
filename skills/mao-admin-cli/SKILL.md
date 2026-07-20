---
name: mao-admin-cli
description: 通过 mao-admin CLI 操作 Mao 管理后台 API，覆盖鉴权、用户角色、Agent、模型、Skill、会话监控、分析与审计。
---

# mao-admin-cli

面向 Agent 的 Mao 管理后台操作指南。本 Skill 与 CLI 同目录内置；Agent 应直接调用，CLI 未就绪时自行安装，不要让用户手动安装。

## 何时使用

- 需要登录管理后台并调用管理端 REST API
- 需要创建/更新用户、角色、Agent、LLM 模型、全局 Skill
- 需要查看会话、运行态、分析汇总或审计日志
- 需要在脚本或 Agent 流程中以 JSON 方式消费管理后台数据

## 何时不适用

- 桌面端用户侧会话聊天、WebSocket 流式对话（非本 CLI 范围）
- 用户个人技能（user-skills）上传（本 CLI 仅覆盖全局 `skill-docs`）
- 需要浏览器 UI 交互的飞书扫码登录（本 CLI 使用用户名密码登录）

## 安装与就绪（Agent 执行，勿让用户安装）

本 CLI 与本 Skill 同目录内置。调用前若 `mao-admin` / `mao-admin-cli` 不可用，**由 Agent 自行安装**，禁止让用户手动安装或中断任务去询问。

```bash
# 在本 Skill 目录下执行
npm install . -g
```

推荐流程：先直接调用 CLI → 若 `command not found` 则执行上述安装 → 安装后立即重试原命令。全局安装因权限失败时，可用 `node bin/mao-admin-cli.js ...` 从本目录直接运行。

要求 Node.js >= 18。零第三方依赖。

## 鉴权与 baseUrl

| 项 | 说明 |
|----|------|
| 默认 baseUrl | `https://maoadmin.etarch.cn/api/v1` |
| 环境变量 | `MAO_ADMIN_BASE_URL`（仅本 CLI 的 API 地址）；`MAO_TOKEN`、`MAO_REFRESH_TOKEN`（与 mao-user-cli 共用） |
| 全局选项 | `--base-url`、`--token`、`--json`、`--raw`、`--timeout-ms`、`-h/--help` |
| 鉴权头 | `Authorization: Bearer <accessToken>` |
| Token 缓存 | `~/.mao/auth.json`（与 mao-user-cli 共用），结构 `{ accessToken, refreshToken, expiresIn, user, savedAt }`。只存 JWT，不存密码。 |

首次使用先登录：

```bash
mao-admin auth login --username <用户名> --password <密码>
```

成功后自动写入缓存。后续命令默认读取缓存 Token。`auth refresh` 使用缓存的 `refreshToken`；`auth logout` 调用服务端并清除本地缓存。

**注意**：`model create/update` 的 `--base-url` 表示模型服务商 API 地址。此时请用 `MAO_ADMIN_BASE_URL` 指定管理后台地址，避免与全局 `--base-url` 冲突。

## 统一响应约定

后端返回 `{ code, message, data, timestamp }`。`code === 0` 为成功。

- 默认：stdout 打印 `data`（JSON）
- `--raw`：打印完整 Result
- 失败：stderr 打印 `message`，进程 exitCode=1

## 命令选择规则

1. 未登录或 401 → 先 `auth login`，必要时 `auth refresh`
2. 按业务域选模块，再读对应 `reference/*.md` 查参数
3. 需要机器可读输出时依赖默认 JSON；排查时加 `--raw`
4. 逗号分隔数组参数（如 `--role-ids 1,2`）会自动拆分为数组
5. 跨模块流程见 [business_process.md](business_process.md)

## 模块文档索引

| 需求 | 阅读 |
|------|------|
| 登录 / 刷新 / 当前用户 | [reference/auth.md](reference/auth.md) |
| 用户 CRUD、重置密码、分配角色 | [reference/user.md](reference/user.md) |
| 角色、权限点 | [reference/role.md](reference/role.md) |
| Agent 与经验 | [reference/agent.md](reference/agent.md) |
| LLM 模型配置与连通性测试 | [reference/model.md](reference/model.md) |
| 全局 Skill 上传/删除 | [reference/skill.md](reference/skill.md) |
| 管理端会话与消息 | [reference/session.md](reference/session.md) |
| 运行监控与陈旧阈值 | [reference/runtime.md](reference/runtime.md) |
| 分析汇总 | [reference/analytics.md](reference/analytics.md) |
| 审计日志 | [reference/audit.md](reference/audit.md) |
| 系统设置 | [reference/settings.md](reference/settings.md) |
| 端到端业务流程 | [business_process.md](business_process.md) |

横跨多模块时：先应用本页全局规则，再分别打开相关 reference 文档。
