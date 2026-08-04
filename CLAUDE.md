# CLAUDE.md

面向 AI Agent 的仓库开发指引。首次搭建、环境变量、生产部署见 [README.md](README.md) 与 [DEPLOY.md](DEPLOY.md)。

> 当前项目处于初版开发阶段，重构代码时无需考虑存量数据与向后兼容。

## ⚠️ 重要禁令

- **Agent 严禁擅自重启服务器上的 Mao 后端服务**（包括但不限于执行 `./scripts/restart-all.sh`、`./scripts/stop-all.sh` + 启动命令、`mvn spring-boot:run`、kill 后端进程等）。后端服务的重启必须由用户自己完成，Agent 不得代劳。
- 尤其注意：**在修复一个问题后，不要习惯性地自动重启后端服务**，这是明令禁止的。修复完成后只需告知用户需要重启后端即可，重启动作交给用户执行。

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

# 安卓 APP（Capacitor 壳，复用 desktop 前端；仅 CLOUD 模式）
cd android && bash build-apk.sh              # 一键：构建前端 → cap sync → assembleRelease → 发布
cd android && bash build-apk.sh --dry-run    # 仅构建不发布
cd android && bash build-apk.sh --version 0.0.x  # 手动指定 versionName

# 一键启停
./scripts/start-all.sh | ./scripts/stop-all.sh | ./scripts/restart-all.sh

# E2E（需 backend + admin + desktop 均已启动）
npm test | npm run test:admin | npm run test:desktop | npm run test:debug
```

CI（`.github/workflows/ci.yml`）仅做后端 `mvn compile` 与前端 build，不跑单测和 Playwright。

## 架构概览

四端：Java 后端 + Vue 管理后台 (`admin/`) + Electron/Web 桌面端 (`desktop/`) + 安卓 APP (`android/`，Capacitor WebView 壳)。

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

### 安卓 APP（`android/`）

基于 **Capacitor 7** WebView 壳打包 `desktop/` Vue 前端为 APK；包名 `cn.etarch.mao.app`；**仅 CLOUD 模式**（无 `electronAPI` → 自动禁用 LOCAL）。后端零改动。设计文档：`docs/android-app-technical-design.md`。

**目录结构**：

| 路径 | 职责 |
|------|------|
| `android/capacitor.config.json` | appId / webDir（`../desktop/dist`）/ `adjustMarginsForEdgeToEdge` |
| `android/build-apk.sh` | 一键构建与发布脚本 |
| `android/CHANGELOG.md` | 发版说明；`versionName` 取首条 `##`；changelog 写入 OTA 清单 |
| `android/android/` | Capacitor 生成的原生 Gradle 工程 |
| `android/android/app/.../MainActivity.java` | BridgeActivity：Splash、系统栏、WebView 无缓存、注入 `android-capacitor` |
| `android/android/app/.../AppUpdatePlugin.java` | 自研 OTA 插件：`getVersionCode` / `downloadAndInstall` |

**与 desktop 前端的衔接**（改安卓相关行为时常动这些文件）：

| 文件 | 职责 |
|------|------|
| `desktop/src/main.ts` | 检测 Capacitor 后给 `<html>` 加 `android-capacitor` |
| `desktop/src/router/index.ts` | 原生环境用 **hash 路由**（避免 `--base=./` 下深路径刷新 404） |
| `desktop/src/composables/useVersionCheck.ts` | 拉 `android-latest.json`、强制/普通更新、调 `AppUpdate` 插件 |
| `desktop/src/style.css` / `TopNav.vue` | `html.android-capacitor` 顶栏紧凑布局与安全区 |

**构建链路**（`build-apk.sh`）：

1. `desktop`：`vue-tsc` + `vite build --base=./`（不改 `vite.config.ts` 的 Web/Nginx `base:'/'`）
2. `npx cap copy/update android` 同步 Web 资产
3. `gradlew assembleRelease`（`-PMAO_VERSION_CODE` / `-PMAO_VERSION_NAME`）
4. 发布到 `/root/soft/mao/data/uploads/releases/`：`mao-android-<name>-<code>.apk` + `android-latest.json`

**环境与签名**：

- JDK 21（`JAVA_HOME` 默认 `/usr/lib/jvm/java-21-openjdk-amd64`）、`ANDROID_HOME`（默认 `/opt/android-sdk`）、minSdk 24 / targetSdk 35
- 签名凭据：环境变量 `MAO_KEYSTORE_*`，或 `/root/soft/mao/keystore/keystore-credentials.env`；**keystore / 凭据严禁入 git**
- 发版前先更新 `android/CHANGELOG.md` 顶部版本条目（versionCode 由脚本按已发布 APK 自增）

**明确不做**：LOCAL 能力、工具审批、系统推送、移动端布局重构、上架应用商店、改后端/admin。

## 代码规范

**后端**：Java 17 + Lombok（`@Data`、`@Slf4j`、`@RequiredArgsConstructor`）；MyBatis-Plus 下划线转驼峰、逻辑删除（`deleted`）；表名/列名 snake_case，BIGINT 自增主键，`created_at`/`updated_at`。

**前端**：Vue 3 Composition API + `<script setup>`；Pinia 用函数式 `defineStore`；TypeScript 严格模式；无 ESLint/Prettier，类型检查靠 `vue-tsc`；改动Electron 壳代码时记得更新package.json的version，默认每次小版本号加1。

**安卓**：原生 Java 在 `android/android/app/`；发版改 `android/CHANGELOG.md` 后跑 `build-apk.sh`；安卓专用 UI/路由/OTA 逻辑写在 `desktop/` 并用 `android-capacitor` / `Capacitor.isNativePlatform()` 守卫，勿影响 Web/Electron。

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
| 安卓壳 / 系统栏 / WebView | `android/android/app/.../MainActivity.java`、`capacitor.config.json` |
| 安卓 OTA 原生下载安装 | `AppUpdatePlugin.java` + `desktop/.../useVersionCheck.ts` |
| 安卓发版 | 更新 `android/CHANGELOG.md` → `cd android && bash build-apk.sh` |

设计文档索引见 `docs/technical-design.md`、`docs/android-app-technical-design.md` 及 `docs/` 下各专题文档。

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
