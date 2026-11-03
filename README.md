[![CI](https://github.com/DC-ET/mao/actions/workflows/ci.yml/badge.svg)](https://github.com/DC-ET/mao/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/logo.png" alt="Mao Logo" width="96" />
</p>

<h1 align="center">Mao</h1>

<p align="center">
  <strong>Self-hosted AI Agent runtime for individuals and teams.</strong><br/>
  把能做事的 Agent 放进你自己的环境：双执行边界、RBAC、审计，以及真正的 Think-Act-Observe 引擎。
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="skills/mao-cli/reference/project.md">项目说明</a> ·
  <a href="USER_GUIDE.md">用户手册</a> ·
  <a href="skills/mao-cli/reference/deploy.md">自托管部署</a> ·
  <a href="#参与贡献">参与贡献</a>
</p>

---

> **适用边界**：尚未经过企业级生产环境充分验证。MIT 开源，只提供源码与自部署文档，没有官方 SaaS。LLM 需在管理后台自行配置 API Key；界面目前为中文。

## 它是什么

Mao 不是又一个 ChatGPT 套壳，也不是 Dify / n8n 那样的低代码工作流。它是一套**可私有化部署的 Agent 工作台**：集中管理多个 Agent、模型和权限，用内置 Harness 跑 Think-Act-Observe 循环，让模型真正去读文件、跑命令、搜网页、拆子任务。

三件事构成产品内核：

1. **数据与密钥留在你这边** — 自托管，工作区、会话、模型 Key 不出内网。
2. **执行边界可切换** — **CLOUD** 在服务器工作区干活；**LOCAL** 在本机目录干活，并走权限档位与工具审批。
3. **Agent 是一等公民** — 多 Agent、Skill、MCP、提示词版本、用量与审计；对话只是入口，治理才是平台。

适合：需要私有化、自选模型、服务端与本地工具边界可切换的个人与团队。  
不适合：想要开箱 SaaS、低代码画布，或英文界面。

<p align="center">
  <img src="docs/assets/client.png" alt="Mao 桌面客户端：任务、对话、文件变更与边路任务" width="960" />
</p>

## 核心能力

Mao 围绕「**让 Agent 真正下场干活，同时在团队内可管可控**」构建了四层核心能力：

### 1. 真正的 Agent Harness，而非聊天壳
- **自主执行循环**：内置 Think-Act-Observe 引擎，原生配备 Shell、文件读写、联网搜索（带服务端白名单校验的网页引用溯源）、文生图/改图等工具。
- **多任务并发拆解**：主对话之外可随时拉起**边路任务（Side Task）**，或委派后台**子代理**（`explorer` / `worker` / `reviewer`）并行调研、写码与审查。
- **全链路白盒可观测**：自动上下文压缩与崩溃恢复；随时透视下一轮请求的上下文 Token 构成，或按轮次查看模型耗时、首字延迟、成本与工具调用的[运行轨迹](skills/mao-cli/reference/desktop.md#运行轨迹)。

### 2. 双执行边界：CLOUD ⇄ LOCAL
- **CLOUD（云端工作区）**：打开浏览器、手机或 IM 即可使用。支持工作区文件预览编辑、服务端交互式终端与可视化 [Git 管理器](skills/mao-cli/reference/git.md)；可选开启[每用户 Docker 容器隔离](skills/mao-cli/reference/runtime.md)，确保多租户数据与凭据边界安全。
- **LOCAL（本机直连）**：通过 [Electron 桌面端](skills/mao-cli/reference/electron.md)或 [`mao-agent --local`](skills/mao-cli/reference/mao-agent.md) 直接读写本机目录、调用本地工具链，配备从「只读」到「完全权限」五档控制与高危操作审批。

### 3. 活的记忆与能力组装
- **双层经验沉淀**：既有跨会话自动提取偏好与项目事实的[个人长期记忆](skills/mao-cli/reference/memory.md)，也有按 Agent 跨成员共享、攻克难题后自动归档的[团队经验库](skills/mao-cli/reference/agent.md#团队经验库experience-library00342-起)。
- **按需扩展边界**：每个 Agent 独立绑定提示词（支持版本化与回滚）、[Skill 技能包](skills/mao-cli/reference/skill.md)、全局/个人 [MCP 服务](skills/mao-cli/reference/mcp.md)与[自定义 HTTP 工具](skills/mao-cli/reference/http-tool.md)，配合系统/用户/工作区三级加密环境变量注入运行时。

### 4. 自动化触发与团队治理
- **主动干活与外部联动**：除交互对话外，支持 Cron [定时任务](skills/mao-cli/reference/scheduled-task.md)、监控外部接口异动自动拉起会话的[信号哨兵](skills/mao-cli/reference/signal-watcher.md)，以及供 CI/业务系统调用的[开放 API、入站 Webhook 与出站事件订阅](skills/mao-cli/reference/open-api.md)。任务结果、待审批项与每日运营摘要统一汇入[任务收件箱](skills/mao-cli/reference/inbox.md)。
- **平台级治理**：支持任意 [OpenAI 兼容模型](skills/mao-cli/reference/model.md)；内建本地账号 / LDAP / 飞书登录、RBAC 角色权限、管理操作审计、[调用流水](skills/mao-cli/reference/llm-call.md)、[用量与成本分析](skills/mao-cli/reference/analytics.md)及[月度预算拦截](skills/mao-cli/reference/budget.md)；管理后台还可按部署场景隐藏不用的功能菜单（部署级全局生效，隐藏不影响访问权限）。

> 对比选型：若你需要低代码画布编排或托管 SaaS，建议看 Dify、n8n；若你想对齐 Codex 类 Agent 能力且要求私有化与团队治理，可参考 [与 OpenAI Codex 的对比](skills/mao-cli/reference/project.md#与-openai-codex-对比)。

## 架构

<p align="center">
  <img src="docs/assets/mao-architecture-tech.jpeg" alt="Mao 技术架构：客户端经 REST / WebSocket 进入 NestJS 后端与 Agent Harness，工具在 CLOUD 或 LOCAL 执行边界上落地" width="960" />
</p>

生产环境单域名分流：桌面 `/`、管理后台 `/admin/`、API `/api/`、上传 `/uploads/`。

## 怎么用

```
管理员：配模型与预算 → 组装 Agent（提示词 / Skill / MCP / HTTP 工具） → 开账号与角色权限
用  户：选 Agent → 选 CLOUD 或 LOCAL → 选工作区 → 交办目标（对话 / 定时 / 哨兵 / API）
```

日常就三种核心工作方式：

1. **交互式攻坚**：云端任务在浏览器 / 手机 / IM 直接跑，本地代码库用 Electron 或 `mao-agent --local` 跑；复杂任务随时拆边路任务或交由子代理并行处理。
2. **例行巡检与事件驱动**：用[定时任务](skills/mao-cli/reference/scheduled-task.md)处理日报与巡检，用[信号哨兵](skills/mao-cli/reference/signal-watcher.md)盯住外部接口变化自动触发 Agent；结果通过站内[任务收件箱](skills/mao-cli/reference/inbox.md)或飞书 / 钉钉 / 微信 / 邮件送达。
3. **嵌入业务系统**：通过[开放接口与 Webhook](skills/mao-cli/reference/open-api.md) 把 Agent 编入 CI 或工单流，或用几行代码通过 [Embed SDK](skills/mao-cli/reference/embed-sdk.md) 把可操作宿主页面的助手浮窗嵌进内部后台。

完整功能手册见 [USER_GUIDE.md](USER_GUIDE.md)，首次上线检查清单见 [business_process.md](skills/mao-cli/business_process.md)。

## 快速开始

先把服务跑起来，再打开网页。两条路：

| | 怎么跑 | 跑起来之后打开 |
|---|--------|----------------|
| **本地** | Node.js 22+、MySQL 8、起 backend / admin / desktop | 工作台 `http://localhost:5201` · 管理后台 `http://localhost:5200/admin/` |
| **服务器** | Linux + Nginx + HTTPS，仓库 `/opt/mao`，数据 `/opt/mao-data` | 工作台 `https://your-mao.example.com/` · 管理后台 `https://your-mao.example.com/admin/` |

### 1. 本地运行

需要 Node.js 22+、MySQL 8.x，以及编译 `node-pty` 的 C/C++ 工具链。逐步说明见 [install.md](skills/mao-cli/reference/install.md)。

```bash
git clone https://github.com/DC-ET/mao.git
cd mao
mysql -e "CREATE DATABASE mao CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

cd backend-ts && npm install && npm run start:dev   # :9080
cd admin && npm install && npm run dev              # 管理后台
cd desktop && npm install && npm run dev            # 工作台
```

Electron LOCAL（本机目录与工具审批）：`cd desktop && npm run dev:electron`。

### 2. 服务器部署

1. 准备 Linux、Node 22+、Nginx、MySQL 8，克隆到 `/opt/mao`，创建 `/opt/mao-data`
2. 构建 backend、admin、desktop，写好 `backend-ts/.env`（JWT、数据库、数据目录）
3. 启动后端，配置 Nginx + HTTPS（桌面 `/`、管理后台 `/admin/`、API `/api/`）
4. 登录管理后台，**立刻改掉默认密码**，再配真实模型 Key——顶栏的就绪横幅会逐项提醒这三步，全绿即就绪

完整步骤与升级见 [deploy.md](skills/mao-cli/reference/deploy.md)，环境变量见 [config.md](skills/mao-cli/reference/config.md)。

### 3. 打开网页

| 入口 | 本地 | 服务器 |
|------|------|--------|
| 工作台（对话、任务、工作区） | http://localhost:5201 | `https://your-mao.example.com/` |
| 管理后台（模型、Agent、用户） | http://localhost:5200/admin/ | `https://your-mao.example.com/admin/` |

默认管理员 `admin` / `admin123`（对外暴露后立刻改密）。先到管理后台 **模型管理** 换成真实 API Key，否则无法对话；然后在工作台选 Agent、建任务、描述目标。CLOUD 任务在浏览器里就能跑，用法见 [桌面端手册](skills/mao-cli/reference/desktop.md)。

### REST 运维（可选）

```bash
cd skills/mao-cli && npm install . -g
mao auth login --username admin --password '<your-password>'
mao agent list
```

`mao` 管配置与元数据，不负责对话。日常使用请打开工作台网页。

## 客户端与通道

| 入口 | 用途 |
|------|------|
| [管理后台](skills/mao-cli/reference/admin.md) | 模型、Agent、用户角色、Skill、MCP、审计、用量、预算 |
| [桌面 Web](skills/mao-cli/reference/desktop.md) | 日常任务与对话（CLOUD） |
| [Electron](skills/mao-cli/reference/electron.md) | LOCAL 本机工具、图形审批、LOCAL 附件、托盘 / 系统通知 / 全局快捷键（需自行打包，无官方签名安装包） |
| [安卓](skills/mao-cli/reference/android.md) | Capacitor 壳远程加载 Web，仅 CLOUD |
| [mao-agent](skills/mao-cli/reference/mao-agent.md) | 终端 REPL / CI（`-p`） |
| [飞书机器人](skills/mao-cli/reference/feishu-bot.md) | 私聊或群里 @ 机器人 |
| [钉钉机器人](skills/mao-cli/reference/dingtalk-bot.md) | 私聊或群里 @ 机器人 |
| [微信 Bot](skills/mao-cli/reference/weixin.md) | 扫码绑定后在微信里对话 |
| [Embed SDK](skills/mao-cli/reference/embed-sdk.md) | 内部网页嵌入对话浮窗，可操作当前页面 |

页面嵌入最小例子（把域名换成你的站点）：

```html
<script src="https://mao.example.com/embed/mao-chat.js"></script>
<script>
  MaoChat.init({
    serverUrl: 'https://mao.example.com',
    agentId: 1,
    getToken: () => fetch('/your-backend/embed-token').then(r => r.json()).then(d => d.accessToken),
    context: () => ({ page: location.pathname }),
  });
</script>
```

公司 SSO、页面操作授权与安全边界见 [embed-sdk.md](skills/mao-cli/reference/embed-sdk.md)，不要把 `agentId` 当成权限控制。

## 文档

产品说明的正文在可独立分发的 [`skills/mao-cli/`](skills/mao-cli/SKILL.md)：

| 文档 | 说明 |
|------|------|
| [project.md](skills/mao-cli/reference/project.md) | 定位、架构、特性、与 Codex 对比 |
| [install.md](skills/mao-cli/reference/install.md) / [deploy.md](skills/mao-cli/reference/deploy.md) | 本地开发 / 生产部署 |
| [config.md](skills/mao-cli/reference/config.md) | 环境变量、数据目录、默认账号 |
| [USER_GUIDE.md](USER_GUIDE.md) | 各端使用手册索引 |
| [troubleshooting.md](skills/mao-cli/reference/troubleshooting.md) | 排障 |
| [CHANGELOG.md](CHANGELOG.md) | 发版说明 |
| [docs/plan/2026-05-20-technical-design.md](docs/plan/2026-05-20-technical-design.md) | 早期技术方案（部分已过时，以源码与 mao-cli 为准） |

## 开发

```bash
cd backend-ts && npm test && npm run build
cd admin && npm run build
cd desktop && npm run build
cd agent-cli && npm test
cd sdk/embed && npm test && npm run build
```

根目录 `npm test` 为 Playwright E2E。首次运行前执行 `bash scripts/e2e-setup.sh` 搭建隔离环境（本地 MySQL 建 `mao_e2e` 库 + 迁移 + 种子数据）；之后测试会自动拉起隔离后端(:9180)与 admin/desktop dev server，跑完自动退出，不会触碰线上 9080。贡献方式见 [CONTRIBUTING.md](CONTRIBUTING.md)；AI 辅助开发见 [AGENTS.md](AGENTS.md)。

## 参与贡献

欢迎 Issue 与 PR。开始前请读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- Bug / 功能 — [GitHub Issues](https://github.com/DC-ET/mao/issues)
- 安全漏洞 — [SECURITY.md](SECURITY.md)，请勿公开披露

暂不接受：官方托管 / SaaS 化、界面国际化、官方签名 Electron 包分发。

## 许可证

[MIT License](LICENSE) — Copyright (c) 2026 Mao Contributors
