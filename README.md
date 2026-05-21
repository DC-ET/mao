# Agent Workbench

企业级 AI Agent 管理与协作平台，为企业提供统一的 AI Agent 管理环境，支持细粒度权限控制、完整审计追踪和灵活的 Agent 配置。

## 核心特性

- **统一管理** -- 在一个平台上集中管理企业所有 AI Agent
- **权限控制** -- 基于 RBAC 的细粒度权限体系，支持按角色、部门、用户控制 Agent 可见性
- **审计追踪** -- 所有 API 调用经过后端代理，完整记录操作日志
- **Agent 运行引擎** -- 内置 Think-Act-Observe 循环引擎，支持 LLM 调用、工具调度和上下文管理
- **可扩展技能系统** -- 7 个内置技能 + 外部 MCP 工具服务器支持
- **Agent Hub** -- Agent 发现、安装、评分与评论的内部市场
- **SSE 流式对话** -- 实时流式 Agent 响应，支持消息持久化与 Token 用量追踪

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
| HTTP 客户端 | OkHttp 4.12.0 (SSE 流式) |
| 对象存储 | MinIO (S3 兼容) |
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
agent-workbench-mimo/
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

### 默认账号

| 用户名 | 密码 | 角色 |
|--------|------|------|
| admin | admin123 | 系统管理员 |

## 内置技能

| 技能 | 说明 |
|------|------|
| BashSkill | 执行 Shell 命令 |
| ReadFileSkill | 读取文件 |
| WriteFileSkill | 写入文件 |
| EditFileSkill | 编辑文件 |
| HttpRequestSkill | 发起 HTTP 请求 |
| TodoSkill | 任务管理 |
| SubagentSkill | 委托子 Agent |

## 开发阶段

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 1 - MVP | 核心对话、Agent 管理、用户认证 | 已完成 |
| Phase 2 - Agent 能力 | 技能系统、MCP 协议、上下文管理 | 已完成 |
| Phase 3 - 企业特性 | RBAC 权限、审计日志、LDAP 集成 | 已完成 |
| Phase 4 - 平台特性 | Agent Hub、仪表盘、API Key、通知系统 | 已完成 |

## 许可证

MIT
