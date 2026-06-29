# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 当前项目处于初版开发阶段，重构代码时无需考虑存量数据与向后兼容。

企业级 AI Agent 管理与协作平台。三端架构：Java 后端 + Vue 管理后台 + Electron 桌面客户端。

## 常用命令

```bash
# 后端 — 构建并启动
cd backend && mvn clean install && mvn spring-boot:run

# 后端 — 仅编译检查（跳过测试）
cd backend && mvn compile

# 管理后台 — 开发服务器 (端口 5200，代理 /api → localhost:9080)
cd admin && npm run dev

# 管理后台 — 类型检查 + 构建
cd admin && npm run build

# 桌面端 — 浏览器预览 (端口 5201)
cd desktop && npm run dev

# 桌面端 — Electron 模式
cd desktop && npm run dev:electron

# 桌面端 — 类型检查 + 构建
cd desktop && npm run build

# 桌面端 — 打包 DMG
cd desktop && npm run dist

# 全部服务启停（通过 scripts/ 目录的 shell 脚本）
./scripts/start-all.sh
./scripts/stop-all.sh
./scripts/restart-all.sh
```

当前无测试套件。后端 `pom.xml` 包含 `spring-boot-starter-test` 但未编写测试。

## 架构概览

### 后端 (Spring Boot 3.5 + Java 17)

端口 9080，上下文路径 `/api`，API 前缀 `/api/v1/`。使用 Lombok + MyBatis-Plus。

**核心引擎 — harness/ 包**：实现 Think-Act-Observe 循环的 Agent 运行时。
- `AgentLoop` — 主循环：构建 prompt → 调用 LLM（流式）→ 执行工具调用 → 循环
- `PromptEngine` — 从上下文构建 ChatRequest
- `ContextManager` — 消息历史与上下文压缩（token 感知）
- `CompactionService` — 上下文窗口管理，可配置触发比例与保留轮次
- `ToolDispatcher` → `ToolRegistry` — 工具路由，7 个内置工具（Shell/ReadFile/WriteFile/EditFile/GlobSearch/GrepSearch/TaskCRUD）。工具纯内存注册，无 DB 持久化
- `LlmAdapter` / `OpenAiLlmAdapter` — LLM 通信抽象层，兼容 OpenAI 协议，OkHttp SSE 流式
- `LocalToolExecutor` — 将工具请求通过 WebSocket 发送给 Electron 客户端执行

**双执行模式**：CLOUD（服务端执行工具）和 LOCAL（委托给桌面端 Electron 执行）。

**WebSocket 流式通信**：`/ws/stream` 端点，`StreamingWsHandler` 处理双向通信。事件类型：content_delta、tool_call_start/result、session_status、context_window、compaction_start/end、thinking_start/end、skill_sync_required、tool_execute。

**模块分层**：每个领域模块遵循 entity → mapper → service → controller 模式。

**拦截器链**：`AuditInterceptor`（API 调用日志）+ `PermissionInterceptor`（RBAC `@RequirePermission` 注解），应用于 `/v1/**`（排除 `/v1/auth/**` 和 `/ws/**`）。

**统一响应**：`Result<T>` 包装器，code=0 表示成功。

### 前端 (Vue 3 + TypeScript + Pinia + Element Plus)

**管理后台 (admin/)**：后台管理界面，视图包括 dashboard、agent、model、user、skill、audit、auth。

**桌面端 (desktop/)**：Electron 28 桌面客户端，核心组件：
- `useStreamWS` — 单例 WebSocket 连接，自动重连 + 心跳 + 事件路由 + Electron IPC 桥接
- `useChat` — 聊天编排：会话创建、消息发送、图片上传（Aliyun OSS）、工具审批队列
- Pinia stores：`auth`、`agent`（代理列表/选择）、`session`（多会话消息缓存，按 sessionId 的 Map）
- Electron main (`main.cjs`)：本地工具执行、工具审批流、shell 会话管理、技能同步
- Preload bridge (`preload.cjs`)：通过 contextBridge 暴露 `electronAPI`

### 数据库

MySQL 8，Flyway 迁移脚本在 `backend/src/main/resources/db/migration/`（24 个迁移）。

## 代码规范

**后端**：
- Java 17 + Lombok（`@Data`、`@Slf4j`、`@RequiredArgsConstructor`）
- MyBatis-Plus：下划线转驼峰，逻辑删除（`deleted` 字段），实体扫描 `com.agentworkbench.**.entity`
- snake_case 表名/列名，BIGINT 自增主键，`created_at`/`updated_at` 时间戳

**前端**：
- Vue 3 Composition API + `<script setup>`
- Pinia stores 使用 Composition API 函数语法（`defineStore` with `() => {}`）
- TypeScript 严格模式（`noUnusedLocals`、`noUnusedParameters`、`erasableSyntaxOnly`）
- 无 ESLint/Prettier 配置，类型检查通过 `vue-tsc`

## 日志路径

```
/data/logs/mao/backend.out    # 后端日志
/data/logs/mao/desktop.out    # 桌面端日志
```

## 注意事项

- Swagger UI：`/swagger-ui.html`
- 默认管理员账号：admin / admin123
- JWT Secret 通过环境变量 `JWT_SECRET` 配置
- 技能目录：`/data/workbench/skills`（外部文件系统）
- Agent 工作区：`/data/workbench/workspace`
- 设计文档在 `docs/` 目录，包含需求、技术设计、各阶段规划
