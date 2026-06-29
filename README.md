# Mao

企业级 AI Agent 管理与协作平台，为企业提供统一的 AI Agent 管理环境，支持细粒度权限控制、完整审计追踪和灵活的 Agent 配置。

## 核心特性

- **统一管理** -- 在一个平台上集中管理企业所有 AI Agent
- **权限控制** -- 基于 RBAC 的细粒度权限体系，支持按角色、部门、用户控制 Agent 可见性
- **审计追踪** -- 所有 API 调用经过后端代理，完整记录操作日志
- **Agent 运行引擎** -- 内置 Think-Act-Observe 循环引擎，支持 LLM 调用、工具调度和上下文管理
- **可扩展技能系统** -- 7 个内置技能 + 外部 MCP 工具服务器支持
- **Agent Hub** -- Agent 发现、安装、评分与评论的内部市场
- **SSE 流式对话** -- 实时流式 Agent 响应，支持消息持久化与 Token 用量追踪
- **双端架构** -- 管理后台 + Electron 桌面客户端，满足不同使用场景

## 技术栈

### 后端

| 组件 | 技术 |
|------|------|
| 语言 | Java 17 |
| 框架 | Spring Boot 3.5.14 |
| ORM | MyBatis-Plus 3.5.6 |
| 数据库 | MySQL 8.x |
| 缓存 | Redis 7.x |
| 认证 | Spring Security + JWT |
| 认证方式 | 本地密码 / LDAP / 飞书 SSO |
| HTTP 客户端 | OkHttp 4.12.0 (SSE 流式) |
| 对象存储 | Aliyun OSS |
| API 文档 | SpringDoc OpenAPI 2.8.6 |
| 构建工具 | Maven |

### 前端 (管理后台 & 桌面端共享)

| 组件 | 技术 |
|------|------|
| 框架 | Vue 3.5 + TypeScript |
| 构建工具 | Vite 8.x |
| UI 组件库 | Element Plus 2.14 |
| 状态管理 | Pinia 3.x |
| 桌面端 | Electron 28 |

## 项目结构

```
mao/
├── backend/                    # Java Spring Boot 后端服务
│   ├── src/main/java/com/agentworkbench/
│   │   ├── agent/              # Agent 管理
│   │   ├── auth/               # 认证 (JWT / LDAP / 飞书)
│   │   ├── harness/            # Agent 运行引擎核心
│   │   │   ├── core/           # AgentLoop, PromptEngine, ContextManager
│   │   │   ├── llm/            # LLM 适配器 (OpenAI 兼容协议)
│   │   │   ├── mcp/            # MCP 协议客户端
│   │   │   └── skill/          # 技能接口 + 7 个内置技能
│   │   ├── hub/                # Agent Hub
│   │   ├── permission/         # RBAC 权限体系
│   │   ├── session/            # 会话与消息管理
│   │   ├── audit/              # 审计日志
│   │   └── ...                 # 其他模块
│   └── src/main/resources/
│       ├── application.yml     # 配置文件
│       └── db/migration/       # 数据库迁移脚本 (24 张表)
│
├── admin/                      # Vue 3 管理后台 (端口 5200)
│   └── src/views/
│       ├── dashboard/          # 仪表盘
│       ├── agent/              # Agent 管理
│       ├── model/              # 模型管理
│       ├── user/               # 用户管理
│       ├── skill/              # 技能管理
│       ├── hub/                # Hub 管理
│       ├── apikey/             # API Key 管理
│       ├── audit/              # 审计日志
│       └── system/             # 系统配置
│
├── desktop/                    # Electron 桌面客户端 (端口 5201)
│   ├── electron/main.cjs       # Electron 主进程
│   └── src/views/
│       ├── workbench/          # 工作台 (Agent 列表)
│       ├── chat/               # 对话界面 (SSE 流式)
│       ├── hub/                # Agent Hub
│       ├── agent-create/       # 创建 Agent
│       └── settings/           # 设置
│
└── docs/                       # 项目文档
    ├── requirement.md          # 需求文档
    ├── technical-design.md     # 技术设计文档
    ├── phase-1-mvp.md          # 第一阶段 MVP
    ├── phase-2-agent-capability.md
    ├── phase-3-enterprise.md
    └── phase-4-platform.md
```

## 快速开始

### 环境要求

- JDK 17+
- Maven 3.8+
- Node.js 18+
- MySQL 8.x
- Redis 7.x

### 后端

```bash
cd backend
mvn clean install
mvn spring-boot:run
```

服务启动后运行在 `http://localhost:9080`，API 文档地址：`http://localhost:9080/swagger-ui.html`

### 管理后台

```bash
cd admin
npm install
npm run dev
```

访问 `http://localhost:5200`

### 桌面客户端

```bash
cd desktop
npm install
npm run dev           # 浏览器预览模式
npm run dev:electron  # Electron 桌面应用模式
```

### 打包桌面客户端

```bash
cd desktop
npm run dist          # 构建并打包成 dmg 安装包
```

打包产物位于 `desktop/release/` 目录：
- `mac-arm64/Mao.app` - macOS 应用
- `Mao-0.0.0-arm64.dmg` - macOS 安装镜像

### 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 系统管理员 |

## 环境配置

前端项目支持通过环境变量配置 API 地址，区分开发和生产环境。

### 管理后台 (admin/)

| 文件 | 用途 | API 地址 |
|------|------|----------|
| `.env.development` | 本地开发 | `/api/v1` (vite proxy) |
| `.env.production` | 生产环境 | `/api/v1` (Nginx 代理) |

### 桌面端 (desktop/)

| 文件 | 用途 | API 地址 |
|------|------|----------|
| `.env.development` | 本地开发 | `http://localhost:9080/api/v1` |
| `.env.production` | 生产环境 | `https://mao.etarch.cn/api/v1` |

环境变量：
- `VITE_API_BASE_URL` - API 基础地址
- `VITE_WS_BASE_URL` - WebSocket 地址（可选，不设置时从 API 地址自动转换）

本地覆盖：创建 `.env.local` 文件（已被 gitignore）。

## 生产部署

详细部署指南请参考 [DEPLOY.md](DEPLOY.md)。

### 部署架构

| 组件 | 部署方式 | 域名 |
|------|---------|------|
| Java 后端 | jar + systemd | - |
| 管理后台 | Nginx 静态文件 | maoadmin.etarch.cn |
| 桌面端 web | Nginx 静态文件 | mao.etarch.cn |

### 快速部署

```bash
# 1. 后端打包
cd backend && mvn clean package -DskipTests

# 2. 前端打包
cd admin && npm run build
cd desktop && npm run build

# 3. 上传到服务器并启动
# 详见 DEPLOY.md
```

## API 文档

后端启动后访问 Swagger UI：`http://localhost:9080/swagger-ui.html`

主要 API 前缀：`/api/v1/`

| 模块 | 路径前缀 | 说明 |
|------|---------|------|
| 认证 | `/api/v1/auth` | 登录、注册、Token 刷新 |
| 用户 | `/api/v1/users` | 用户管理 |
| Agent | `/api/v1/agents` | Agent 配置管理 |
| 会话 | `/api/v1/sessions` | 对话会话管理 |
| 模型 | `/api/v1/models` | LLM 模型配置 |
| 技能 | `/api/v1/skills` | 技能管理 |
| Hub | `/api/v1/hub` | Agent Hub |
