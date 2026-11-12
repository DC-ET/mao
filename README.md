<p align="center">
  <img src="docs/assets/logo.png" alt="Mao" width="80" />
</p>

<h1 align="center">Mao</h1>

<p align="center">
  <strong>团队级 AI Agent 自托管平台</strong><br/>
  一次部署，全员共用。按岗位构建智能体，在任意终端与办公软件中直接工作。
</p>

<p align="center">
  <a href="https://github.com/DC-ET/mao/actions/workflows/ci.yml"><img src="https://github.com/DC-ET/mao/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-black.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  <a href="#快速开始">快速开始</a> ·
  <a href="#多端接入">多端接入</a> ·
  <a href="skills/mao-cli/reference/project.md">架构与特性</a> ·
  <a href="USER_GUIDE.md">文档</a> ·
  <a href="skills/mao-cli/reference/deploy.md">私有化部署</a>
</p>

<p align="center">
  <img src="docs/assets/client.png" alt="Mao 工作台" width="960" />
</p>

---

大多数 Agent 工具是为个人设计的：装在各自电脑上，密钥散落，换台设备或换个人就得从头配起。

**Mao 将 Agent 作为团队基础设施来构建。** 在服务端集中配置模型、工具与岗位智能体，团队成员无需安装运行环境，打开浏览器、手机、终端、飞书、钉钉、微信或内部业务系统即可直接调用。所有会话、操作与成本全量落库，经验随岗位沉淀。

## 为什么用 Mao

- **一次部署，全员共用** — 统一管理模型 API Key、账号与 RBAC 权限。成员开箱即用，对本地电脑零配置要求。
- **按岗位定义智能体** — 为研发、运维、客服、数据分析分别构建智能体，独立绑定系统提示词（支持版本回滚）、[Skill 技能包](skills/mao-cli/reference/skill.md)、[MCP](skills/mao-cli/reference/mcp.md) 与 [HTTP 工具](skills/mao-cli/reference/http-tool.md)。
- **全终端与 IM 原生触达** — 同一批智能体同时接入 Web、桌面端、移动端、CLI、飞书、钉钉、微信及内部网页浮窗。
- **容器级运行隔离** — 支持开启 [Docker 容器运行时](skills/mao-cli/reference/deploy.md#容器隔离运行时v0295)，将云端 Shell、文件读写与进程隔离在独立容器中，严格划分用户与 Agent 的数据边界。
- **岗位级经验沉淀** — 内置[团队经验库](skills/mao-cli/reference/agent.md#团队经验库experience-library00342-起)。智能体在解决复杂问题后自动归档排障路径与领域知识，后续任务先检索再执行，人员流动不带走岗位经验。
- **全量留痕与成本治理** — 完整记录会话轨迹、[模型调用流水](skills/mao-cli/reference/llm-call.md)与[管理审计日志](skills/mao-cli/reference/audit.md)。支持多维度[成本核算](skills/mao-cli/reference/analytics.md)与全局 / 用户 / Agent [月度预算拦截](skills/mao-cli/reference/budget.md)。
- **云端与本机双执行边界** — 日常任务在服务端 `CLOUD` 环境即开即用；需要直接读写本机代码库或执行本地工具链时，可切换至 `LOCAL` 模式（Electron 桌面端或 `mao-agent --local`），配套五档权限控制与高危操作审批。
- **主动触发与系统集成** — 除交互式对话外，支持 [Cron 定时任务](skills/mao-cli/reference/scheduled-task.md)、监听外部接口异动的[信号哨兵](skills/mao-cli/reference/signal-watcher.md)，以及 [Open API 与 Webhook](skills/mao-cli/reference/open-api.md)。

## 多端接入

一套服务端，按场景选择入口：

| 入口 | 适用场景 | 客户端要求 |
|------|----------|------------|
| [Web 工作台](skills/mao-cli/reference/desktop.md) | 日常任务、云端工作区、文件预览编辑、在线终端与 Git | 浏览器 |
| [飞书](skills/mao-cli/reference/feishu-bot.md) / [钉钉](skills/mao-cli/reference/dingtalk-bot.md) / [微信](skills/mao-cli/reference/weixin.md) | 群聊 `@` 协同或私聊交办，支持流式进度卡片 | 免安装 |
| [Embed SDK](skills/mao-cli/reference/embed-sdk.md) | 嵌入内部后台的对话浮窗，可读取与操作宿主页面上下文 | 宿主页面引入一行脚本 |
| [mao-agent CLI](skills/mao-cli/reference/mao-agent.md) | 终端交互式 REPL、CI/CD 流水线集成、本机目录直连 | Node.js CLI |
| [Android](skills/mao-cli/reference/android.md) | 移动办公、审批与任务跟进 | APK（支持应用内 OTA） |
| [Electron 桌面端](skills/mao-cli/reference/electron.md) | 本机文件读写、图形化工具审批、全局快捷键与系统通知 | 桌面客户端 |
| [管理后台](skills/mao-cli/reference/admin.md) | 模型、智能体、权限、经验库、审计、成本与运行环境配置 | 浏览器 |

**内部系统嵌入示例（Embed SDK）：**

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

完整的 SSO 对接、宿主页面工具注册与安全边界说明见 [Embed SDK 文档](skills/mao-cli/reference/embed-sdk.md)。

## 架构概览

<p align="center">
  <img src="docs/assets/mao-architecture-tech.jpeg" alt="Mao Architecture" width="960" />
</p>

生产环境采用单域名分流：工作台 `/`、管理后台 `/admin/`、接口 `/api/`、静态资源 `/uploads/`。内核基于自研 Think-Act-Observe Agent Harness，支持自动上下文压缩、边路任务（Side Task）与后台子代理（`explorer` / `worker` / `reviewer`）并发协作。详见 [项目说明](skills/mao-cli/reference/project.md)。

## 快速开始

### 本地开发

环境要求：Node.js 22+、MySQL 8.x，以及编译 `node-pty` 所需的 C/C++ 工具链。详细步骤见 [安装指南](skills/mao-cli/reference/install.md)。

```bash
git clone https://github.com/DC-ET/mao.git
cd mao
mysql -e "CREATE DATABASE mao CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

cd backend-ts && npm install && npm run start:dev   # API & WS (:9080)
cd admin && npm install && npm run dev              # 管理后台 (:5200/admin/)
cd desktop && npm install && npm run dev            # 工作台 (:5201)
```

如需调试本机目录直连（LOCAL 模式）：`cd desktop && npm run dev:electron`。

### 生产部署

1. 准备 Linux、Node.js 22+、Nginx、MySQL 8（如需容器隔离，另需安装 Docker 并构建 `mao-runtime` 镜像）。
2. 构建 `backend-ts`、`admin`、`desktop`，配置 `backend-ts/.env`。
3. 启动后端服务，配置 Nginx 反向代理与 HTTPS。
4. 访问 `/admin/`（初始账号 `admin` / `admin123`），按顶栏向导完成**修改管理员密码**与**配置模型 API Key**。

完整生产部署、Docker 容器隔离与版本升级流程见 [部署手册](skills/mao-cli/reference/deploy.md)，环境变量说明见 [配置参考](skills/mao-cli/reference/config.md)。

### 运维 CLI（可选）

平台提供 [`mao-cli`](skills/mao-cli/SKILL.md) 用于通过命令行或脚本管理平台资源（用户、智能体、模型、技能、预算、定时任务等）：

```bash
cd skills/mao-cli && npm install . -g
mao auth login --username admin --password '<your-password>'
mao agent list
```

## 文档索引

完整文档内置于 [`skills/mao-cli/`](skills/mao-cli/SKILL.md)，支持作为 Agent Skill 独立分发：

- [架构与特性说明](skills/mao-cli/reference/project.md)（含与 OpenAI Codex 对比）
- [用户手册总览](USER_GUIDE.md) · [首次上线检查清单](skills/mao-cli/business_process.md)
- [本地安装](skills/mao-cli/reference/install.md) · [生产部署](skills/mao-cli/reference/deploy.md) · [环境变量配置](skills/mao-cli/reference/config.md)
- [常见问题与排障](skills/mao-cli/reference/troubleshooting.md) · [版本变更记录](CHANGELOG.md)

## 验证与测试

```bash
cd backend-ts && npm test && npm run build
cd admin && npm run build
cd desktop && npm run build
cd agent-cli && npm test
cd sdk/embed && npm test && npm run build
```

端到端测试（Playwright）：首次运行执行 `bash scripts/e2e-setup.sh` 初始化隔离数据库 `mao_e2e`，随后在根目录执行 `npm test`。

## 参与贡献

欢迎提交 [Issue](https://github.com/DC-ET/mao/issues) 与 Pull Request。提交代码前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请参照 [SECURITY.md](SECURITY.md) 私密报告。

> 说明：本项目采用 MIT 协议开源，仅提供源码与自托管文档，不提供官方 SaaS 托管服务。生产环境部署前请充分评估安全与合规边界。

## 许可证

[MIT License](LICENSE) © 2026 Mao Contributors
