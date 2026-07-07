[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<h1 align="center">Mao</h1>

<p align="center">
  <img src="docs/logo.png" alt="Mao Logo" width="96" />
</p>


Mao 面向希望把 AI Agent 纳入正式 IT 体系的企业。许多团队已经在用各类智能体工具，但配置分散、权限难管、调用难以追溯——Mao 想解决的就是这件事：提供一个可私有化部署的统一工作台，让 Agent、模型、用户与审计集中在一处管理。

平台内置完整的 Agent 运行引擎，支持流式对话、工具调用、技能扩展与上下文压缩；既可由服务端执行工具，也可通过 Electron 桌面端在本地运行，兼顾安全边界与开发效率。数据与模型密钥留在企业自己的环境里，不依赖第三方托管。

> **开源说明**：本项目采用 [MIT 许可证](LICENSE)，仅提供源码与自部署文档，不提供官方托管服务。LLM 需在管理后台自行配置 API Key；桌面端提供 Electron 源码，需自行构建。当前界面语言为中文。

## 客户端预览

<p align="center">
  <img src="docs/client.png" alt="Mao 桌面客户端页面样图" width="960" />
</p>

## 核心特性

- **统一管理** — 集中管理企业内所有 AI Agent 配置与可见性
- **权限控制** — 基于 RBAC 的细粒度权限体系
- **审计追踪** — API 调用与操作日志完整记录
- **Agent 运行引擎** — 内置 Think-Act-Observe 循环，支持 LLM 流式调用、工具调度与上下文压缩
- **双执行模式** — CLOUD（服务端执行工具）与 LOCAL（委托桌面端 Electron 执行）
- **可扩展技能** — 内置技能 + 外部 MCP 工具服务器
- **WebSocket 流式对话** — 实时双向通信，支持消息持久化与 Token 用量追踪
- **双端架构** — 管理后台 + Electron 桌面客户端

## 技术栈

### 后端

| 组件 | 技术 |
|------|------|
| 语言 | Java 17 |
| 框架 | Spring Boot 3.5.14 |
| ORM | MyBatis-Plus 3.5.6 |
| 数据库 | MySQL 8.x |
| 认证 | Spring Security + JWT |
| 认证方式 | 本地密码 / LDAP（可选）/ 飞书 SSO（可选） |
| LLM 通信 | OkHttp + OpenAI 兼容协议（SSE 拉流） |
| 客户端通信 | WebSocket（`/api/ws/stream`） |
| 对象存储 | 本地文件系统 / 阿里云 OSS（可选） |
| API 文档 | SpringDoc OpenAPI 2.8.6 |
| 构建工具 | Maven |

### 前端（管理后台 & 桌面端）

| 组件 | 技术 |
|------|------|
| 框架 | Vue 3.5 + TypeScript |
| 构建工具 | Vite 8.x |
| UI 组件库 | Element Plus 2.14 |
| 状态管理 | Pinia 3.x |
| 桌面端 | Electron 28 |

## 快速开始

### 环境要求

- JDK 17+
- Maven 3.8+
- Node.js 18+
- MySQL 8.x

### 1. 初始化数据库与配置

```bash
# 创建数据库
mysql -e "CREATE DATABASE mao CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"

# 复制配置模板并编辑
cp backend/src/main/resources/application-example.yml \
   backend/src/main/resources/application-local.yml
```

编辑 `application-local.yml`，至少配置 MySQL。生产环境请设置环境变量 `JWT_SECRET`。

确保 `application.yml` 中 `spring.profiles.active` 指向你的本地 profile（通常为 `local`）。

### 2. 启动后端

```bash
cd backend
mvn clean install
mvn spring-boot:run
```

服务地址：`http://localhost:9080`  
Swagger UI：`http://localhost:9080/api/swagger-ui.html`  
Flyway 会在首次启动时自动建表并写入初始数据。

### 3. 配置 LLM 模型

使用默认账号登录管理后台，进入「模型管理」，添加或编辑模型并填入你自己的 API Key。迁移脚本会插入占位模型 `deepseek-v4-flash`（`sk-xxxxxxxxxxxx`），**必须替换为真实密钥后才能对话**。

### 4. 启动管理后台

```bash
cd admin
npm install
npm run dev
```

访问 `http://localhost:5200`

### 5. 启动桌面客户端

```bash
cd desktop
npm install
npm run dev           # 浏览器预览
npm run dev:electron  # Electron 模式（LOCAL 工具执行）
```

### 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 系统管理员 |

> 生产环境部署后请立即修改默认密码。详见 [SECURITY.md](SECURITY.md)。

## 环境变量

### 后端（常用）

| 变量 | 说明 |
|------|------|
| `JWT_SECRET` | JWT 签名密钥（生产必设） |
| `WORKSPACE_ROOT` | Agent 工作区根目录，默认 `/opt/mao/data/workspace` |
| `SKILLS_DIR` | 技能目录，默认 `/opt/mao/data/skills` |
| `FILE_UPLOAD_DIR` | 上传文件目录 |
| `UPLOAD_STORAGE_MODE` | `local` 或 `oss` |
| `UPLOAD_BASE_URL` | 本地存储模式下的公网访问前缀 |
| `TAVILY_API_KEY` | Tavily 搜索（可选） |
| `LDAP_ENABLED` / `LDAP_URL` 等 | LDAP 认证（可选，`LDAP_ENABLED` 默认 `false`） |
| `FEISHU_ENABLED` / `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_REDIRECT_URI` | 飞书 OAuth（可选，`FEISHU_ENABLED` 默认 `false`），`FEISHU_REDIRECT_URI` 必须是后端公网回调地址，如 `https://your-domain/api/v1/auth/feishu/callback` |
| `OSS_*` | 阿里云 OSS（可选） |

完整配置项请参考 [application-example.yml](backend/src/main/resources/application-example.yml)。

### 前端

| 变量 | 说明 |
|------|------|
| `VITE_API_BASE_URL` | API 基础地址 |
| `VITE_WS_BASE_URL` | WebSocket 地址（可选，默认从 API 地址推导） |

**管理后台**（`admin/`）

| 文件 | 用途 |
|------|------|
| `.env.development` | 本地开发，`/api/v1`（Vite 代理到 9080） |
| `.env.production` | 生产构建，`/api/v1`（由 Nginx 反代） |

**桌面端**（`desktop/`）

| 文件 | 用途 |
|------|------|
| `.env.development` | 本地开发，`http://localhost:9080/api/v1` |
| `.env.production` | 生产构建，改为你的部署域名，如 `https://mao.example.com/api/v1` |

本地覆盖：创建 `.env.local`（已被 gitignore）。

## 生产部署

详细步骤见 [DEPLOY.md](DEPLOY.md)。

```bash
# 后端打包
cd backend && mvn clean package -DskipTests
# 产物：backend/target/mao-server.jar

# 前端打包
cd admin && npm run build
cd desktop && npm run build
```

### 部署架构（示例）

| 组件 | 部署方式 | 说明 |
|------|---------|------|
| Java 后端 | jar + systemd | 端口 9080 |
| 管理后台 | Nginx 静态文件 | 如 `mao-admin.example.com` |
| 桌面端 Web | Nginx 静态文件 | 如 `mao.example.com` |
| MySQL | 自建或云服务 | 内网访问 |

### Electron 桌面端

仓库仅提供 Electron **源码**，不包含官方签名安装包。如需桌面端，请自行：

```bash
cd desktop
# 先修改 .env.production 中的 API 地址为你的部署域名
npm run build
npm run dist   # 本地打包，需自行处理代码签名与分发
```

## API 文档

后端启动后访问：`http://localhost:9080/api/swagger-ui.html`

主要 API 前缀：`/api/v1/`

| 模块 | 路径前缀 | 说明 |
|------|---------|------|
| 认证 | `/api/v1/auth` | 登录、Token 刷新 |
| 用户 | `/api/v1/users` | 用户管理 |
| Agent | `/api/v1/agents` | Agent 配置 |
| 会话 | `/api/v1/sessions` | 对话会话 |
| 模型 | `/api/v1/models` | LLM 模型配置 |
| 技能 | `/api/v1/skills` | 技能管理 |
| 快捷指令 | `/api/v1/quick-commands` | 快捷指令列表 |

WebSocket 端点：`/api/ws/stream`

## 测试

```bash
# 需先启动 backend、admin、desktop
npm test              # 全部 41 个用例
npm run test:admin    # 管理后台 29 个
npm run test:desktop  # 桌面端 12 个
```

## 文档

| 文档 | 说明 |
|------|------|
| [DEPLOY.md](DEPLOY.md) | 生产部署指南 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献指南 |
| [SECURITY.md](SECURITY.md) | 安全策略 |
| [docs/requirement.md](docs/requirement.md) | 需求说明 |
| [docs/technical-design.md](docs/technical-design.md) | 技术设计 |
| [CLAUDE.md](CLAUDE.md) | 开发指引（AI 辅助编码用） |

## 许可证

[MIT License](LICENSE) — Copyright (c) 2026 Mao Contributors
