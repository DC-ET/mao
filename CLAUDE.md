# CLAUDE.md

面向 AI Agent 的仓库开发指引。首次搭建、环境变量、生产部署见 [README.md](README.md) 与 [DEPLOY.md](DEPLOY.md)。

> 当前项目处于初版开发阶段，重构代码时无需考虑存量数据与向后兼容。

## 常用命令

```bash
# 后端
cd backend && mvn compile              # 编译检查
cd backend && mvn test                 # 单元测试（backend/src/test/）
cd backend && mvn spring-boot:run      # 启动（端口 9080，上下文 /api）

# 管理后台（端口 5200，/api 代理到 9080）
cd admin && npm run dev
cd admin && npm run build

# 桌面端（端口 5201；Electron 模式支持 LOCAL 工具执行）
cd desktop && npm run dev
cd desktop && npm run dev:electron
cd desktop && npm run build && npm run dist

# 一键启停
./scripts/start-all.sh | ./scripts/stop-all.sh | ./scripts/restart-all.sh

# E2E（需 backend + admin + desktop 均已启动）
npm test | npm run test:admin | npm run test:desktop | npm run test:debug
```

CI（`.github/workflows/ci.yml`）仅做后端 `mvn compile` 与前端 build，不跑单测和 Playwright。

## 架构概览

三端：Java 后端 + Vue 管理后台 (`admin/`) + Electron 桌面端 (`desktop/`)。

### 后端

端口 9080，API 前缀 `/api/v1/`，统一响应 `Result<T>`（`code=0` 成功）。领域模块遵循 `entity → mapper → service → controller`。

**核心引擎 `harness/`**（Think-Act-Observe 循环）：

| 组件 | 职责 |
|------|------|
| `AgentLoop` | 主循环：构建 prompt → LLM 流式调用 → 工具执行 → 循环 |
| `PromptEngine` | 上下文 → `ChatRequest` |
| `ContextManager` / `CompactionService` | 消息历史与 token 感知压缩 |
| `ToolDispatcher` → `ToolRegistry` | 工具路由；内置工具在 `harness/tool/impl/`，Spring Bean 自动注册 |
| `LlmAdapter` / `OpenAiLlmAdapter` | OpenAI 兼容协议，OkHttp SSE |
| `LocalToolExecutor` | LOCAL 模式：经 WebSocket 委托桌面端执行 |
| `HarnessService` | 会话级 Agent 运行编排 |
| `DelegateTool` + `harness/delegate/` | Subagent 委托执行 |
| `harness/skill/` | 技能加载与同步 |

**双执行模式**：`CLOUD`（服务端执行工具）/ `LOCAL`（桌面端 Electron 执行）。

**WebSocket** `/api/ws/stream`：`StreamingWsHandler` 处理双向流。常见事件：`content_delta`、`tool_call_start/result`、`session_status`、`context_window`、`compaction_start/end`、`thinking_start/end`、`skill_sync_required`、`tool_execute`。

**拦截器**：`AuditInterceptor` + `PermissionInterceptor`（`@RequirePermission`），作用于 `/v1/**`（排除 `/v1/auth/**` 和 `/ws/**`）。

**数据库**：MySQL 8 + Flyway，迁移脚本在 `backend/src/main/resources/db/migration/`。

### 前端

**管理后台**：路由见 `admin/src/router/index.ts`；视图在 `admin/src/views/`。

**桌面端**（核心 composables / Electron）：

| 文件 | 职责 |
|------|------|
| `useStreamWS` | WebSocket 单例：重连、心跳、事件路由、IPC 桥接 |
| `useChat` | 会话创建、消息发送、OSS 图片、工具审批 |
| `stores/auth`、`agent`、`session` | 认证、Agent 选择、多会话消息缓存 |
| `electron/main.cjs` | 本地工具执行、审批流、Shell 会话、技能同步 |
| `electron/preload.cjs` | `electronAPI` 暴露 |

Side Task（并行子会话）涉及后端 `HarnessService` / `StreamingWsHandler` 与桌面端 `useCenterTabs`、`CenterTabBar`。

## 代码规范

**后端**：Java 17 + Lombok（`@Data`、`@Slf4j`、`@RequiredArgsConstructor`）；MyBatis-Plus 下划线转驼峰、逻辑删除（`deleted`）；表名/列名 snake_case，BIGINT 自增主键，`created_at`/`updated_at`。

**前端**：Vue 3 Composition API + `<script setup>`；Pinia 用函数式 `defineStore`；TypeScript 严格模式；无 ESLint/Prettier，类型检查靠 `vue-tsc`；改动Electron 壳代码时记得更新package.json的version，默认每次小版本号加1。

## 常见改动入口

| 目标 | 位置 |
|------|------|
| 新增 REST API | 对应领域包下的 `entity` / `mapper` / `service` / `controller` |
| 数据库变更 | `backend/src/main/resources/db/migration/V0xx__*.sql` |
| 新增内置工具 | `harness/tool/impl/` 实现 `Tool` 接口并标注 `@Component` |
| 技能扩展 | `harness/skill/`；外部目录默认 `/opt/mao/data/skills` |
| Agent 运行逻辑 | `harness/core/`（`AgentLoop`、`HarnessService`） |
| 流式通信 | 后端 `session/ws/StreamingWsHandler`；前端 `useStreamWS` |
| 权限控制 | `@RequirePermission` + `permission/` 模块 |
| 管理后台页面 | `admin/src/views/` + `admin/src/router/index.ts` |
| 桌面端 UI | `desktop/src/components/`、`desktop/src/views/` |

设计文档索引见 `docs/technical-design.md` 及 `docs/` 下各专题文档。

## 测试

| 类型 | 命令 | 说明 |
|------|------|------|
| 后端单测 | `cd backend && mvn test` | 用例在 `backend/src/test/` |
| 前端 E2E | 根目录 `npm test` | Playwright，配置 `tests/playwright.config.ts` |
| 用例源码 | `tests/admin.spec.ts`、`tests/desktop.spec.ts` | 以文件为准，勿依赖固定用例数 |

**E2E 注意**：
- 管理后台用 `login()` 辅助函数（`admin` / `admin123`）
- 桌面端未认证时会弹登录框；主题测试须 `page.addInitScript()` 设 localStorage（Vite dev 下 `page.evaluate()` 不可靠）
- 断言优先 `toContainText` / `toBeVisible`，避免脆弱硬编码
- 分页接口默认返回第一页
