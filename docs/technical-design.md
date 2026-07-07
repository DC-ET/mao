# Agent 工作台 - 技术方案文档

> 版本: v0.3 | 更新时间: 2026-05-20
> 关联文档: [requirement.md](./requirement.md)

> **文档状态（2026-07）**：本文档为早期技术方案，部分模块已变更，请以 [README.md](../README.md) 与源码为准。主要差异：
> - **Hub 模块**已删除（`V017__remove_hub.sql`）
> - 前端流式通道为 **WebSocket**（`StreamingWsHandler`），LLM 内部仍通过 OkHttp SSE 拉流
> - 对象存储支持 **本地文件系统** 与 **阿里云 OSS**
> - Flyway 迁移脚本现为 **46 个**（非文档初稿中的 24 个）
> - 开源协议：**MIT**，仅提供自部署

---

## 1. 技术选型明细

### 1.1 后端技术栈

| 组件 | 选型 | 版本建议 | 选型理由 |
|------|------|---------|---------|
| 语言 | Java | 17+ (LTS) | 虚拟线程支持，企业级生态成熟 |
| 框架 | Spring Boot | 3.x | 自动配置、生态丰富、社区活跃 |
| Web 框架 | **Spring MVC** | - | 团队熟悉，SSE 通过 `SseEmitter` 实现 |
| ORM | MyBatis-Plus | 3.5.x | 灵活的 SQL 控制，适合复杂查询 |
| 认证 | Spring Security | - | LDAP / OAuth2 开箱即用 |
| HTTP 客户端 | OkHttp / Apache HttpClient | - | LLM API 调用，支持 SSE 流式读取 |
| 对象存储 | MinIO (S3 兼容) | - | 私有化部署，S3 协议标准 |
| LLM 客户端 | 自研 OpenAI 协议适配层 | - | 统一协议，流式 SSE 解析 |
| MCP 客户端 | 自研 MCP SDK (Java) | - | MCP 协议规范实现 |
| API 文档 | SpringDoc (OpenAPI 3) | 2.x | 自动生成 API 文档 |
| 工具库 | Hutool / Guava | - | 常用工具方法 |

### 1.2 前端技术栈

| 组件 | 选型 | 版本建议 | 选型理由 |
|------|------|---------|---------|
| 框架 | Vue 3 | 3.4+ | Composition API、更好的 TS 支持 |
| 构建工具 | Vite | 5.x | 快速构建、HMR |
| 状态管理 | Pinia | 2.x | Vue 3 官方推荐，轻量 |
| UI 组件库 | **Element Plus** | 2.x | 企业级 UI 组件丰富，中文文档完善 |
| HTTP 客户端 | Axios | 1.x | 拦截器机制适合 Token 注入 |
| 路由 | Vue Router | 4.x | Vue 3 配套 |
| 国际化 | Vue I18n | 9.x | 多语言支持（可选） |
| Markdown 渲染 | markdown-it | - | Agent 对话内容渲染 |
| 代码高亮 | highlight.js / Shiki | - | 代码块语法高亮 |

### 1.3 桌面客户端技术栈

| 组件 | 选型 | 版本建议 | 选型理由 |
|------|------|---------|---------|
| 框架 | Electron | 30+ | 跨平台成熟方案 |
| 前端 | Vue 3 + Vite | - | 独立工程，与管理后台独立维护 |
| 窗口管理 | electron-window-state | - | 窗口位置/大小记忆 |
| 自动更新 | electron-updater | - | 应用内自动更新 |
| 安全 | contextIsolation + sandbox | - | Electron 安全最佳实践 |
| IPC 通信 | electron IPC + 预加载脚本 | - | 主进程与渲染进程安全通信 |

### 1.4 基础设施

| 组件 | 选型 | 备注 |
|------|------|------|
| 数据库 | MySQL 8.x | 主数据存储 |
| 对象存储 | MinIO | 文件存储（私有化） |
| 反向代理 | Nginx | 负载均衡 + HTTPS 终结 |
| 容器化 | Docker + Docker Compose | 私有化部署 |
| 日志 | SLF4J + Logback | 应用日志，可选接 ELK |

---

## 2. 工程结构

### 2.1 Monorepo 目录规划

```
mao/
├── backend/                        # 后端 Java 服务
│   ├── pom.xml
│   └── src/
│       └── main/
│           ├── java/cn/etarch/mao/
│           │   ├── WorkbenchApplication.java
│           │   ├── config/                 # 配置类
│           │   │   ├── SecurityConfig.java
│           │   │   ├── WebMvcConfig.java
│           │   │   └── LlmConfig.java
│           │   ├── common/                 # 公共模块
│           │   │   ├── result/             # 统一响应
│           │   │   ├── exception/          # 全局异常
│           │   │   ├── constant/           # 常量
│           │   │   └── util/
│           │   ├── auth/                   # 认证模块
│           │   │   ├── controller/
│           │   │   ├── service/
│           │   │   ├── ldap/               # LDAP 集成
│           │   │   └── feishu/             # 飞书 OAuth
│           │   ├── user/                   # 用户模块
│           │   │   ├── controller/
│           │   │   ├── service/
│           │   │   ├── mapper/
│           │   │   └── entity/
│           │   ├── agent/                  # Agent 管理模块
│           │   │   ├── controller/
│           │   │   ├── service/
│           │   │   ├── mapper/
│           │   │   └── entity/
│           │   ├── harness/                # Agent Harness 核心
│           │   │   ├── core/               # 核心引擎
│           │   │   │   ├── AgentLoop.java
│           │   │   │   ├── PromptEngine.java
│           │   │   │   ├── ContextManager.java
│           │   │   │   └── ExecutionPipeline.java
│           │   │   ├── llm/                # LLM 适配层
│           │   │   │   ├── LlmAdapter.java
│           │   │   │   ├── LlmClient.java
│           │   │   │   ├── OpenAiProtocol.java
│           │   │   │   └── model/
│           │   │   ├── skill/              # Skills 体系
│           │   │   │   ├── SkillRegistry.java
│           │   │   │   ├── SkillDispatcher.java
│           │   │   │   ├── SkillExecutor.java
│           │   │   │   └── builtin/        # 内置 Skills
│           │   │   ├── mcp/                # MCP 协议
│           │   │   │   ├── McpClient.java
│           │   │   │   ├── McpServerManager.java
│           │   │   │   └── McpToolAdapter.java
│           │   │   └── safety/             # 安全沙箱
│           │   │       ├── SafetyGuard.java
│           │   │       └── PermissionChecker.java
│           │   ├── session/                # 会话模块
│           │   │   ├── controller/
│           │   │   ├── service/
│           │   │   ├── mapper/
│           │   │   └── entity/
│           │   ├── hub/                    # Hub 模块
│           │   │   ├── controller/
│           │   │   ├── service/
│           │   │   └── entity/
│           │   ├── audit/                  # 审计模块
│           │   │   ├── interceptor/        # 审计拦截器
│           │   │   ├── service/
│           │   │   └── entity/
│           │   └── file/                   # 文件模块
│           │       ├── controller/
│           │       └── service/
│           └── resources/
│               ├── application.yml
│               ├── application-dev.yml
│               └── db/migration/           # 数据库迁移脚本
│
├── admin/                          # 管理后台 (Vue 3)
│   ├── package.json
│   ├── vite.config.ts
│   └── src/
│       ├── main.ts
│       ├── App.vue
│       ├── router/
│       ├── stores/                 # Pinia stores
│       ├── views/
│       │   ├── auth/               # 登录
│       │   ├── user/               # 用户管理
│       │   ├── model/              # 模型管理
│       │   ├── agent/              # Agent 管理
│       │   ├── skill/              # Skills 管理
│       │   ├── hub/                # Hub 管理
│       │   ├── audit/              # 审计日志
│       │   └── system/             # 系统配置
│       ├── components/
│       ├── composables/
│       ├── api/                    # API 接口层
│       └── utils/
│
├── desktop/                        # 桌面客户端 (Electron + Vue 3)
│   ├── package.json
│   ├── electron/
│   │   ├── main.ts                 # Electron 主进程
│   │   ├── preload.ts              # 预加载脚本
│   │   └── ipc/                    # IPC 处理
│   ├── src/                        # Vue 3 渲染进程
│   │   ├── main.ts
│   │   ├── App.vue
│   │   ├── router/
│   │   ├── stores/
│   │   ├── views/
│   │   │   ├── auth/               # 登录
│   │   │   ├── workbench/          # 工作台主页
│   │   │   ├── chat/               # Agent 对话
│   │   │   ├── hub/                # Agent Hub
│   │   │   ├── agent-create/       # 创建 Agent
│   │   │   └── settings/           # 设置
│   │   ├── components/
│   │   │   ├── chat/               # 对话组件
│   │   │   ├── agent/              # Agent 相关组件
│   │   │   └── common/
│   │   ├── composables/
│   │   ├── api/
│   │   └── utils/
│   └── resources/                  # 应用图标等资源
│
├── docker/                         # Docker 部署配置
│   ├── docker-compose.yml
│   ├── backend.Dockerfile
│   ├── admin.Dockerfile
│   └── nginx/
│       └── nginx.conf
│
└── docs/                           # 文档
    ├── requirement.md
    └── technical-design.md
```

---

## 3. 数据库设计

### 3.1 核心表结构

```sql
-- ========== 用户与权限 ==========

CREATE TABLE `user` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `username`        VARCHAR(64) NOT NULL UNIQUE,
    `display_name`    VARCHAR(128) NOT NULL,
    `email`           VARCHAR(128),
    `avatar_url`      VARCHAR(512),
    `auth_type`       VARCHAR(20) NOT NULL COMMENT 'LDAP / FEISHU',
    `password_hash`   VARCHAR(128) COMMENT 'LDAP 用户可为空',
    `feishu_user_id`  VARCHAR(64) COMMENT '飞书用户 ID',
    `department_id`   BIGINT,
    `status`          TINYINT DEFAULT 1 COMMENT '1-启用 0-禁用',
    `last_login_at`   DATETIME,
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `role` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`        VARCHAR(64) NOT NULL UNIQUE COMMENT '角色名称',
    `code`        VARCHAR(64) NOT NULL UNIQUE COMMENT '角色编码',
    `description` VARCHAR(256),
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `user_role` (
    `id`      BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id` BIGINT NOT NULL,
    `role_id` BIGINT NOT NULL,
    UNIQUE KEY `uk_user_role` (`user_id`, `role_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `permission` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`        VARCHAR(128) NOT NULL,
    `code`        VARCHAR(128) NOT NULL UNIQUE COMMENT '权限编码，如 agent:read, agent:write',
    `description` VARCHAR(256),
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `role_permission` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `role_id`       BIGINT NOT NULL,
    `permission_id` BIGINT NOT NULL,
    UNIQUE KEY `uk_role_perm` (`role_id`, `permission_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `department` (
    `id`        BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`      VARCHAR(128) NOT NULL,
    `parent_id` BIGINT DEFAULT 0,
    `sort_order` INT DEFAULT 0,
    `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== AI 模型配置 ==========

CREATE TABLE `llm_model` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`            VARCHAR(128) NOT NULL COMMENT '模型显示名称',
    `provider`        VARCHAR(64) COMMENT '供应商标识',
    `base_url`        VARCHAR(512) NOT NULL COMMENT 'API 地址',
    `api_key`         VARCHAR(512) NOT NULL COMMENT '加密存储的 API Key',
    `model_id`        VARCHAR(128) NOT NULL COMMENT '模型标识，如 gpt-4o',
    `max_tokens`      INT DEFAULT 4096,
    `temperature_max` DECIMAL(3,2) DEFAULT 2.00,
    `status`          TINYINT DEFAULT 1 COMMENT '1-启用 0-禁用',
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== Agent ==========

CREATE TABLE `agent` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`            VARCHAR(128) NOT NULL,
    `description`     TEXT,
    `icon_url`        VARCHAR(512),
    `system_prompt`   TEXT NOT NULL COMMENT '系统提示词（人格设定）',
    `model_id`        BIGINT NOT NULL COMMENT '关联的 LLM 模型',
    `creator_id`      BIGINT NOT NULL COMMENT '创建者用户 ID',
    `type`            VARCHAR(20) NOT NULL COMMENT 'SYSTEM-系统级 PERSONAL-个人',
    `visibility`      VARCHAR(20) DEFAULT 'PRIVATE' COMMENT 'PRIVATE / HUB / SPECIFIC',
    `status`          VARCHAR(20) DEFAULT 'DRAFT' COMMENT 'DRAFT/PUBLISHED/ARCHIVED',
    `token_limit`     INT DEFAULT 0 COMMENT '单次对话 Token 限额，0-不限',
    `max_rounds`      INT DEFAULT 0 COMMENT '单次对话最大轮数，0-不限',
    `config_json`     JSON COMMENT '扩展配置',
    `published_at`    DATETIME COMMENT '发布到 Hub 的时间',
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_tag` (
    `id`       BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id` BIGINT NOT NULL,
    `tag`      VARCHAR(64) NOT NULL,
    INDEX `idx_agent_tag` (`agent_id`, `tag`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_skill` (
    `id`       BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id` BIGINT NOT NULL,
    `skill_id` BIGINT NOT NULL COMMENT '关联 skill 表',
    `config`   JSON COMMENT '该 Agent 对此 Skill 的定制配置',
    UNIQUE KEY `uk_agent_skill` (`agent_id`, `skill_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_mcp_config` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`   BIGINT NOT NULL,
    `server_url` VARCHAR(512) NOT NULL COMMENT 'MCP Server 地址',
    `transport`  VARCHAR(20) DEFAULT 'SSE' COMMENT 'SSE / STDIO',
    `config`     JSON COMMENT '额外配置',
    `status`     TINYINT DEFAULT 1,
    INDEX `idx_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `agent_permission` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`        BIGINT NOT NULL,
    `permission_type` VARCHAR(20) NOT NULL COMMENT 'ROLE / DEPARTMENT / USER',
    `permission_value` BIGINT NOT NULL COMMENT '对应 role_id / department_id / user_id',
    UNIQUE KEY `uk_agent_perm` (`agent_id`, `permission_type`, `permission_value`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== Skills ==========

CREATE TABLE `skill` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `name`        VARCHAR(128) NOT NULL,
    `description` TEXT,
    `type`        VARCHAR(20) NOT NULL COMMENT 'BUILTIN-内置',
    `input_schema`  JSON COMMENT '输入参数 JSON Schema',
    `output_schema` JSON COMMENT '输出参数 JSON Schema',
    `impl_class`  VARCHAR(256) COMMENT '内置 Skill 的 Java 实现类全限定名',
    `creator_id`  BIGINT,
    `status`      VARCHAR(20) DEFAULT 'ACTIVE' COMMENT 'ACTIVE/DISABLED',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== 会话与消息 ==========

CREATE TABLE `session` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`     BIGINT NOT NULL,
    `agent_id`    BIGINT NOT NULL,
    `title`       VARCHAR(256) COMMENT '会话标题，可自动生成',
    `status`      VARCHAR(20) DEFAULT 'ACTIVE' COMMENT 'ACTIVE/ARCHIVED',
    `is_pinned`   TINYINT DEFAULT 0,
    `is_favorite` TINYINT DEFAULT 0,
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_user` (`user_id`),
    INDEX `idx_agent` (`agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `message` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `session_id`    BIGINT NOT NULL,
    `role`          VARCHAR(20) NOT NULL COMMENT 'USER / ASSISTANT / SYSTEM / TOOL',
    `content`       MEDIUMTEXT COMMENT '消息内容',
    `tool_call_id`  VARCHAR(128) COMMENT '工具调用 ID（tool role 消息时使用）',
    `tool_calls`    JSON COMMENT '工具调用列表（assistant 消息中的 function_call）',
    `token_count`   INT DEFAULT 0 COMMENT '本条消息的 Token 消耗',
    `model_id`      BIGINT COMMENT '使用的模型',
    `metadata`      JSON COMMENT '扩展元数据',
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== Hub ==========

CREATE TABLE `hub_installation` (
    `id`         BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`    BIGINT NOT NULL,
    `agent_id`   BIGINT NOT NULL COMMENT 'Hub 中的 Agent',
    `installed_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_user_agent` (`user_id`, `agent_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ========== 审计日志 ==========

CREATE TABLE `audit_log` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT,
    `username`      VARCHAR(64),
    `action`        VARCHAR(64) NOT NULL COMMENT '操作类型',
    `resource_type` VARCHAR(64) COMMENT '资源类型',
    `resource_id`   VARCHAR(64) COMMENT '资源 ID',
    `detail`        JSON COMMENT '操作详情',
    `ip`            VARCHAR(45),
    `user_agent`    VARCHAR(512),
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_user` (`user_id`),
    INDEX `idx_action` (`action`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE `api_call_log` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT,
    `session_id`    BIGINT,
    `agent_id`      BIGINT,
    `endpoint`      VARCHAR(256) NOT NULL,
    `method`        VARCHAR(10),
    `request_body`  MEDIUMTEXT,
    `response_code` INT,
    `latency_ms`    INT,
    `llm_model`     VARCHAR(128),
    `llm_tokens_in` INT DEFAULT 0,
    `llm_tokens_out` INT DEFAULT 0,
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    INDEX `idx_session` (`session_id`),
    INDEX `idx_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

---

## 4. API 设计

### 4.1 API 总览

| 模块 | 方法 | 路径 | 说明 |
|------|------|------|------|
| **认证** | POST | `/api/v1/auth/login` | 统一登录入口 |
| | POST | `/api/v1/auth/feishu/qrcode` | 获取飞书扫码二维码 |
| | POST | `/api/v1/auth/feishu/callback` | 飞书扫码回调 |
| | POST | `/api/v1/auth/refresh` | 刷新 Token |
| | POST | `/api/v1/auth/logout` | 退出登录 |
| **用户** | GET | `/api/v1/users/me` | 获取当前用户信息 |
| | GET | `/api/v1/users` | 用户列表（管理员） |
| | PUT | `/api/v1/users/{id}/status` | 启用/禁用用户 |
| **模型** | GET | `/api/v1/models` | 模型列表 |
| | POST | `/api/v1/models` | 创建模型配置 |
| | PUT | `/api/v1/models/{id}` | 更新模型配置 |
| | POST | `/api/v1/models/{id}/test` | 测试模型连通性 |
| **Agent** | GET | `/api/v1/agents` | 用户可用的 Agent 列表 |
| | GET | `/api/v1/agents/{id}` | Agent 详情 |
| | POST | `/api/v1/agents` | 创建 Agent |
| | PUT | `/api/v1/agents/{id}` | 更新 Agent |
| | DELETE | `/api/v1/agents/{id}` | 删除 Agent |
| | POST | `/api/v1/agents/{id}/publish` | 发布到 Hub |
| **会话** | POST | `/api/v1/sessions` | 创建会话 |
| | GET | `/api/v1/sessions` | 会话列表 |
| | GET | `/api/v1/sessions/{id}` | 会话详情 |
| | DELETE | `/api/v1/sessions/{id}` | 删除会话 |
| | PUT | `/api/v1/sessions/{id}/pin` | 置顶/取消置顶 |
| **对话** | POST | `/api/v1/sessions/{id}/messages` | 发送消息（触发 Agent） |
| | GET | `/api/v1/sessions/{id}/messages` | 历史消息列表 |
| | GET | `/api/v1/sessions/{id}/stream` | SSE 流式输出 |
| **Hub** | GET | `/api/v1/hub/agents` | Hub Agent 列表 |
| | POST | `/api/v1/hub/agents/{id}/install` | 安装 Agent |
| | DELETE | `/api/v1/hub/agents/{id}/install` | 卸载 Agent |
| **Skills** | GET | `/api/v1/skills` | Skills 列表 |
| | POST | `/api/v1/skills` | 创建/上传 Skill |
| | PUT | `/api/v1/skills/{id}` | 更新 Skill |
| **文件** | POST | `/api/v1/files/upload` | 上传文件 |
| | GET | `/api/v1/files/{id}/download` | 下载文件 |
| **审计** | GET | `/api/v1/audit/logs` | 审计日志查询 |
| | GET | `/api/v1/audit/api-logs` | API 调用日志查询 |

### 4.2 统一响应格式

```json
{
  "code": 0,
  "message": "success",
  "data": { ... },
  "timestamp": 1716105600000
}
```

错误码规范：
| 范围 | 含义 |
|------|------|
| 0 | 成功 |
| 1001-1999 | 认证/授权错误 |
| 2001-2999 | 参数校验错误 |
| 3001-3999 | 业务逻辑错误 |
| 5001-5999 | 服务端内部错误 |

### 4.3 SSE 流式输出协议

对话采用 SSE（Server-Sent Events）实现流式输出：

```
GET /api/v1/sessions/{id}/stream
Authorization: Bearer <token>
Accept: text/event-stream

# 事件类型
event: message_start
data: {"message_id": "msg_123", "model": "gpt-4o"}

event: content_delta
data: {"delta": "你好"}

event: content_delta
data: {"delta": "，有什么"}

event: tool_call_start
data: {"tool_call_id": "tc_456", "tool_name": "web_search", "arguments": "{"query":"..."}"}

event: tool_call_result
data: {"tool_call_id": "tc_456", "result": "..."}

event: message_end
data: {"message_id": "msg_123", "usage": {"prompt_tokens": 120, "completion_tokens": 85}}

event: error
data: {"code": 5001, "message": "LLM 调用超时"}
```

---

## 5. 技术难点与解决方案

### 5.1 Agent Harness 核心引擎设计

**难点：** Harness 是整个系统的核心，需要统一处理不同 Agent 的人格、工具、上下文，同时保持可扩展性。

**方案：** 采用 Pipeline + 插件化架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Execution Pipeline                        │
│                                                             │
│  ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐│
│  │  Prompt   │──▶│   LLM    │──▶│ Response │──▶│  Output  ││
│  │  Compose  │   │   Call   │   │  Parse   │   │  Render  ││
│  └──────────┘   └──────────┘   └────┬─────┘   └──────────┘│
│                                     │                       │
│                              ┌──────▼──────┐                │
│                              │ Tool Call?  │                │
│                              └──────┬──────┘                │
│                                Yes  │  No → Output          │
│                                     ▼                       │
│  ┌──────────────────────────────────────────────────────┐  │
│  │                 Tool Dispatch Layer                    │  │
│  │  ┌────────────┐  ┌────────────┐                      │  │
│  │  │   Skill    │  │    MCP     │                      │  │
│  │  │  Executor  │  │   Client   │                      │  │
│  │  └────────────┘  └────────────┘                      │  │
│  └──────────────────────────────────────────────────────┘  │
│                              │                              │
│                              ▼                              │
│                        Result Feedback                      │
│                        (回到 LLM Call)                       │
└─────────────────────────────────────────────────────────────┘
```

**关键设计决策：**

1. **Agent Loop 作为核心循环**：借鉴 Codex/ChatGPT 的 Agent Loop 模式，LLM 输出 → 解析 → 执行工具 → 结果反馈 → 再次 LLM 调用，直到 LLM 返回纯文本结果或达到最大轮次。

2. **统一的 Tool 接口**：所有工具（内置 Skill、MCP 工具）实现统一的 `Tool` 接口：

```java
public interface Tool {
    String getName();
    String getDescription();
    JsonSchema getInputSchema();
    ToolResult execute(JsonObject arguments, ExecutionContext context);
}
```

3. **异步执行 + 流式反馈**：工具执行异步化，执行过程中通过 SSE 实时推送进度给客户端。

### 5.2 LLM 统一协议适配

**难点：** 需要对接不同厂商的 LLM 服务，虽然都声称兼容 OpenAI 协议，但实际上各家有细微差异。

**方案：** 三层适配架构

```
┌───────────────────────────────────────┐
│          LlmAdapter (接口层)           │
│  定义统一的调用接口：chat() / stream()  │
└───────────────┬───────────────────────┘
                │
┌───────────────▼───────────────────────┐
│      OpenAiProtocol (协议层)           │
│  OpenAI 兼容格式的请求/响应构建与解析    │
│  - ChatCompletion 请求构建             │
│  - SSE 流式响应解析                    │
│  - function_call / tool_calls 解析     │
└───────────────┬───────────────────────┘
                │
┌───────────────▼───────────────────────┐
│     ProviderAdapter (供应商适配层)      │
│  处理各厂商的协议差异：                 │
│  - 请求头差异（认证方式）               │
│  - 响应格式微调（字段映射）             │
│  - 特有参数（如 Claude 的 system）      │
└───────────────────────────────────────┘
```

核心类设计：

```java
// 统一适配接口
public interface LlmAdapter {
    ChatResponse chat(ChatRequest request, LlmModelConfig config);
    void stream(ChatRequest request, LlmModelConfig config, StreamCallback callback);
}

// Stream 回调接口
public interface StreamCallback {
    void onChunk(StreamChunk chunk);
    void onComplete(ChatUsage usage);
    void onError(Throwable t);
}

// OpenAI 协议实现（默认，基于 OkHttp）
public class OpenAiLlmAdapter implements LlmAdapter {
    private final OkHttpClient httpClient;

    @Override
    public void stream(ChatRequest request, LlmModelConfig config, StreamCallback callback) {
        RequestBody body = RequestBody.create(
            buildRequestBody(request), MediaType.parse("application/json"));
        Request httpRequest = new Request.Builder()
            .url(config.getBaseUrl() + "/chat/completions")
            .header("Authorization", "Bearer " + config.getApiKey())
            .post(body)
            .build();

        try (Response response = httpClient.newCall(httpRequest).execute()) {
            BufferedSource source = response.body().source();
            while (!source.exhausted()) {
                String line = source.readUtf8Line();
                if (line != null && line.startsWith("data: ")) {
                    StreamChunk chunk = parseStreamChunk(line.substring(6));
                    callback.onChunk(chunk);
                }
            }
            callback.onComplete(extractUsage(response));
        } catch (Exception e) {
            callback.onError(e);
        }
    }
}
```

### 5.3 MCP 协议对接

**难点：** MCP (Model Context Protocol) 是 Anthropic 提出的开放协议，Java 生态缺乏成熟 SDK，需要自研。MCP 支持 SSE 和 STDIO 两种传输方式。

**方案：** 自研轻量 MCP Java Client

```
┌─────────────────────────────────────────┐
│              MCP Client                  │
│                                         │
│  ┌─────────────────────────────────┐    │
│  │      McpServerManager           │    │
│  │  - 服务器连接池管理               │    │
│  │  - 健康检查 / 自动重连            │    │
│  └────────────┬────────────────────┘    │
│               │                          │
│  ┌────────────▼────────────────────┐    │
│  │      Transport Layer            │    │
│  │  ┌──────────┐  ┌──────────┐    │    │
│  │  │  SSE      │  │  STDIO   │    │    │
│  │  │ Transport │  │ Transport│    │    │
│  │  └──────────┘  └──────────┘    │    │
│  └────────────┬────────────────────┘    │
│               │                          │
│  ┌────────────▼────────────────────┐    │
│  │      Protocol Layer             │    │
│  │  - initialize / initialized     │    │
│  │  - tools/list                   │    │
│  │  - tools/call                   │    │
│  │  - resources/list               │    │
│  │  - resources/read               │    │
│  └─────────────────────────────────┘    │
└─────────────────────────────────────────┘
```

**核心流程：**

1. **连接阶段**：Agent 初始化时，根据 `agent_mcp_config` 表中的配置，建立与 MCP Server 的连接
2. **工具发现**：调用 `tools/list` 获取该 MCP Server 提供的所有工具，自动转换为 Harness 内部的 `Tool` 接口
3. **工具调用**：当 LLM 返回 tool_call 且目标工具属于 MCP 时，通过 MCP 协议转发调用
4. **生命周期管理**：连接池管理、心跳检测、断线重连

### 5.4 用户上传 Skills（暂缓）

**当前策略：** MVP 阶段仅支持管理后台注册的**内置 Skills** + **MCP Server 工具**两种来源。用户上传自定义脚本的能力预留设计，Phase 2 再实现。

**预留设计：**
- `skill` 表保留 `type` 字段，未来扩展 `USER_UPLOAD` 类型
- `Tool` 接口设计已考虑动态加载，未来可增加 `ScriptTool` 实现类
- Phase 2 实现时需引入 Docker 沙箱 + 代码审核流程

### 5.5 Agent 对话的流式输出

**难点：** 整个链路（客户端 → 后端 → LLM → 后端 → 客户端）都需要保持流式，任何一环阻塞都会影响体验。

**方案：** 全链路 SSE 流式管道（Spring MVC + SseEmitter）

```
客户端 (Electron)          服务端 (Spring MVC)              LLM API
     │                           │                            │
     │  POST /messages           │                            │
     │ ──────────────────────▶   │                            │
     │                           │  POST /chat/completions    │
     │                           │  (stream: true)            │
     │                           │ ────────────────────────▶  │
     │                           │                            │
     │  GET /stream (SSE)        │  ◀── SSE chunks ────────── │
     │ ──────────────────────▶   │                            │
     │                           │                            │
     │  ◀── content_delta ─────  │  ◀── data: {...} ───────── │
     │  ◀── content_delta ─────  │  ◀── data: {...} ───────── │
     │  ◀── tool_call_start ───  │  ◀── data: {...} ───────── │
     │  ◀── tool_call_result ──  │  (内部执行工具)              │
     │  ◀── content_delta ─────  │  ◀── 第二轮 LLM 调用 ────── │
     │  ◀── message_end ───────  │                            │
     │                           │                            │
```

**技术实现要点：**

1. **后端使用 Spring MVC + `SseEmitter`**：Servlet 异步机制实现 SSE，无需切换到 WebFlux
2. **LLM 调用使用 OkHttp**：通过 `ResponseBody.source()` 逐行读取 SSE 流，回调推送到 `SseEmitter`
3. **客户端使用 EventSource API**：Electron 渲染进程中标准的 SSE 消费方式
4. **Agent Loop 运行在独立线程池**：避免阻塞 Servlet 线程，通过 `SseEmitter` 跨线程推送事件

```java
// 后端核心流式处理
@GetMapping(value = "/api/v1/sessions/{sessionId}/stream",
            produces = MediaType.TEXT_EVENT_STREAM_VALUE)
public SseEmitter stream(@PathVariable Long sessionId,
                         @RequestParam String eventId) {
    SseEmitter emitter = new SseEmitter(5 * 60 * 1000L); // 5 分钟超时

    // 提交到独立线程池执行 Agent Loop
    agentExecutor.submit(() -> {
        try {
            harnessService.execute(sessionId, eventId, new AgentEventListener() {
                @Override
                public void onContentDelta(String delta) {
                    emitter.send(SseEmitter.event()
                        .name("content_delta")
                        .data(Map.of("delta", delta)));
                }
                @Override
                public void onToolCallStart(ToolCall call) {
                    emitter.send(SseEmitter.event()
                        .name("tool_call_start")
                        .data(call));
                }
                @Override
                public void onMessageEnd(Usage usage) {
                    emitter.send(SseEmitter.event()
                        .name("message_end")
                        .data(usage));
                    emitter.complete();
                }
                @Override
                public void onError(Throwable t) {
                    emitter.send(SseEmitter.event()
                        .name("error")
                        .data(Map.of("message", t.getMessage())));
                    emitter.completeWithError(t);
                }
            });
        } catch (Exception e) {
            emitter.completeWithError(e);
        }
    });

    emitter.onTimeout(() -> emitter.complete());
    emitter.onError(e -> log.warn("SSE connection error", e));

    return emitter;
}

// Harness 内部 - 使用 OkHttp 读取 LLM SSE 流
public void execute(Long sessionId, String eventId, AgentEventListener listener) {
    // 1. 加载 Agent 配置 + 构建 Prompt
    // 2. 进入 Agent Loop
    AgentContext context = buildContext(sessionId, eventId);
    while (context.hasNextRound()) {
        // OkHttp 同步请求，逐行读取 SSE
        try (Response response = llmClient.stream(context.buildRequest())) {
            BufferedSource source = response.body().source();
            while (!source.exhausted()) {
                String line = source.readUtf8Line();
                StreamChunk chunk = parseSSE(line);
                switch (chunk.getType()) {
                    case DELTA -> listener.onContentDelta(chunk.getDelta());
                    case TOOL_CALL -> handleToolCall(chunk, context, listener);
                }
            }
        }
        // 如果有工具调用，执行后继续下一轮
        if (context.hasPendingToolCalls()) {
            executeToolCalls(context, listener);
        } else {
            break; // 纯文本回复，结束循环
        }
    }
    listener.onMessageEnd(context.getUsage());
}
```

### 5.6 上下文窗口管理

**难点：** LLM 有 Token 上下文限制，长对话会超出窗口。需要智能管理上下文，保证对话连贯性。

**方案：** 三级上下文策略

```
┌─────────────────────────────────────────────────────┐
│                  Context Manager                     │
│                                                     │
│  Level 1: 系统提示词（固定，始终保留）                 │
│  ┌─────────────────────────────────────────────┐    │
│  │ System Prompt + Agent 人格 + 工具描述         │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  Level 2: 近期对话（滑动窗口，优先保留）               │
│  ┌─────────────────────────────────────────────┐    │
│  │ 最近 N 轮完整对话（user + assistant + tool）   │    │
│  │ N 由 max_context_rounds 配置决定              │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  Level 3: 历史摘要（压缩旧对话）                      │
│  ┌─────────────────────────────────────────────┐    │
│  │ 对超出窗口的旧对话生成摘要，作为 context 注入    │    │
│  │ 摘要可由 LLM 自动生成或规则截断                │    │
│  └─────────────────────────────────────────────┘    │
│                                                     │
│  ┌─────────────────────────────────────────────┐    │
│  │ Token 预算分配：                              │    │
│  │   系统提示词: ~15%                            │    │
│  │   工具描述:   ~10%                            │    │
│  │   历史摘要:   ~10%                            │    │
│  │   近期对话:   ~50%                            │    │
│  │   预留输出:   ~15%                            │    │
│  └─────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘
```

**摘要生成策略：**
- 当对话轮数超过 `max_context_rounds` 时，将最早的对话批次送入 LLM 生成摘要
- 摘要格式：`[对话摘要] 用户询问了XX，助手完成了XX，关键结论：XX`
- 摘要随对话推进持续更新（增量摘要）

### 5.7 并发控制与限流

**难点：** 多用户并发使用 Agent，LLM API 有速率限制，需要合理控制并发。

**方案：** 多级限流 + 线程池控制

```
请求进入
    │
    ▼
┌──────────────┐
│  用户级限流   │  应用内滑动窗口
│  (每用户 QPS) │  例：10 次/分钟
└──────┬───────┘
       ▼
┌──────────────┐
│  Agent 级限流 │  应用内计数器
│  (并发会话数) │  例：同一 Agent 最多 50 并发
└──────┬───────┘
       ▼
┌──────────────┐
│  模型级限流   │  应用内令牌桶
│  (API 调用速率)│  例：60 次/分钟
└──────┬───────┘
       ▼
┌──────────────┐
│  线程池调度   │  ThreadPoolExecutor
│  (并发控制)   │  核心线程 / 最大线程 / 队列
└──────────────┘
```

**实现细节：**
- 用户级限流：应用内滑动窗口计数
- 模型级限流：读取 `llm_model` 配置中的速率限制参数
- 并发控制：Agent 执行提交到专用线程池，通过有界队列 + CallerRunsPolicy 背压
- 客户端体验：线程池满时返回 `event: queue_position` 告知用户排队位置
- 线程池配置建议：核心线程 20，最大线程 100，队列容量 200

### 5.8 Electron 安全与性能

**难点：** Electron 应用需要兼顾安全性和性能，避免常见安全漏洞。

**方案：**

```
┌─────────────────────────────────────────────────────┐
│                Electron 安全架构                      │
│                                                     │
│  ┌──────────────┐        ┌──────────────┐          │
│  │  主进程       │◀─IPC──▶│  渲染进程     │          │
│  │  (Node.js)   │        │  (Vue 3)     │          │
│  │              │        │              │          │
│  │  - 窗口管理   │        │  - UI 渲染    │          │
│  │  - 系统交互   │        │  - 用户交互   │          │
│  │  - 自动更新   │        │  - API 调用   │          │
│  │  - 文件操作   │        │              │          │
│  └──────────────┘        └──────────────┘          │
│                                                     │
│  安全配置：                                          │
│  - contextIsolation: true                           │
│  - nodeIntegration: false                           │
│  - sandbox: true                                    │
│  - preload.ts 白名单暴露 IPC 接口                    │
└─────────────────────────────────────────────────────┘
```

**性能优化：**
- Vue 3 组件懒加载 + 路由懒加载
- 对话列表虚拟滚动（大量消息时）
- Markdown 渲染结果缓存
- 主进程与渲染进程职责分离，避免阻塞 UI

---

## 6. 安全架构

### 6.1 认证流程

```
LDAP 登录:
用户 ──▶ 输入账号密码 ──▶ 后端 ──▶ LDAP Server 验证
                                      │
                              成功 ◀───┘
                                │
                          生成 JWT Token
                                │
                          返回给客户端

飞书扫码登录:
用户 ──▶ 点击飞书登录 ──▶ 后端生成二维码 URL
                              │
用户 ◀── 展示二维码           │
                              │
用户手机扫码 ──▶ 飞书 ──▶ 回调后端 /auth/feishu/callback
                              │
                        验证授权码 ──▶ 获取用户信息
                              │
                        匹配/创建用户 ──▶ 生成 JWT Token
                              │
                        返回给客户端
```

### 6.2 权限模型

```
User ──▶ UserRole ──▶ Role ──▶ RolePermission ──▶ Permission
                                                    │
                                          ┌─────────┼─────────┐
                                          ▼         ▼         ▼
                                     agent:read  agent:write  ...
                                          │
                                          ▼
                              AgentPermission (Agent 级权限)
                                          │
                              ┌───────────┼───────────┐
                              ▼           ▼           ▼
                           ROLE       DEPARTMENT    USER
                        (角色可见)    (部门可见)   (指定用户)
```

**权限校验流程：**
1. API 请求进入 → JWT 解析 → 获取用户 ID
2. 查询用户角色 → 获取权限列表
3. 检查是否有对应 API 的权限编码
4. 如果是 Agent 操作，额外检查 AgentPermission（该用户是否有权访问此 Agent）

### 6.3 数据安全

| 数据类型 | 保护措施 |
|---------|---------|
| 用户密码 | bcrypt 哈希存储 |
| API Key | AES-256 加密存储，仅服务端使用 |
| 对话内容 | 传输加密 (HTTPS) + 存储访问控制 |
| 审计日志 | 仅管理员可查，不可修改/删除 |

---

## 7. 部署架构

### 7.1 私有化部署拓扑

```
┌─────────────────────────────────────────────────────────────┐
│                    企业内网 / 私有云                           │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                    Nginx (反向代理)                     │  │
│  │              HTTPS 终结 + 负载均衡                      │  │
│  └────────────┬──────────────┬──────────────┬────────────┘  │
│               │              │              │               │
│  ┌────────────▼───┐  ┌──────▼──────┐  ┌───▼────────────┐  │
│  │   Backend      │  │   Admin     │  │   MinIO        │  │
│  │   (Spring Boot)│  │   (Vue 3)   │  │   (文件存储)    │  │
│  │   x N 实例     │  │   静态资源   │  │                │  │
│  └────────┬───────┘  └─────────────┘  └────────────────┘  │
│           │                                                 │
│  ┌────────▼──────────────────────────────────────────────┐  │
│  │                    内部网络                             │  │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐               │  │
│  │  │  MySQL   │  │  LDAP   │                            │  │
│  │  │  8.x    │  │ Server  │                            │  │
│  │  └─────────┘  └─────────┘                            │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  外部依赖：                                                  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  LLM API (OpenAI / Claude / 自部署模型)                 │  │
│  │  飞书开放平台 (扫码登录)                                 │  │
│  │  MCP Server (外部工具服务)                               │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 7.2 Docker Compose 编排

```yaml
# docker/docker-compose.yml (简化示意)
version: '3.8'
services:
  nginx:
    image: nginx:alpine
    ports:
      - "443:443"
      - "80:80"
    volumes:
      - ./nginx/nginx.conf:/etc/nginx/nginx.conf
      - ./admin/dist:/usr/share/nginx/html/admin
    depends_on:
      - backend

  backend:
    build:
      context: ../backend
      dockerfile: ../docker/backend.Dockerfile
    environment:
      - SPRING_PROFILES_ACTIVE=prod
      - DB_HOST=mysql
    depends_on:
      - mysql

  mysql:
    image: mysql:8.0
    environment:
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
      MYSQL_DATABASE: workbench
    volumes:
      - mysql_data:/var/lib/mysql
    ports:
      - "3306:3306"

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    ports:
      - "9000:9000"
      - "9001:9001"
    volumes:
      - minio_data:/data

volumes:
  mysql_data:
  minio_data:
```

---

## 8. 关键依赖与风险评估

| 风险项 | 影响 | 等级 | 应对措施 |
|--------|------|------|---------|
| LLM API 稳定性 | 对话功能不可用 | 高 | 多模型备份、降级策略、超时重试 |
| MCP 协议演进 | 需要持续适配 | 中 | 抽象协议层，隔离变化影响 |
| Electron 包体大小 | 用户下载体验 | 低 | asar 打包 + 按需分发 |
| 长对话 Token 超限 | 对话截断 | 中 | 智能上下文管理 + 摘要压缩 |
| 并发压力 | 响应变慢 | 中 | 多级限流 + 线程池背压 + 水平扩展 |

---

## 9. 已确认决策

| 问题 | 决策 |
|------|------|
| Spring WebFlux vs Spring MVC | **Spring MVC** + `SseEmitter` 实现 SSE |
| 消息队列选型 | **暂不引入 MQ**，使用线程池控制并发 |
| 用户上传 Skills | **MVP 跳过**，仅支持内置 Skills + MCP |
| 前端代码共享 | **独立维护**，管理后台与桌面端各自独立 |

> 暂无待讨论问题，可继续补充新需求或进入工程初始化阶段。
