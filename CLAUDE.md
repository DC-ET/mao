# CLAUDE.md

面向 AI Agent 的仓库开发指引。首次搭建、环境变量、生产部署见 [README.md](README.md) 与 [DEPLOY.md](DEPLOY.md)。

> 当前项目处于初版开发阶段，重构代码时无需考虑存量数据与向后兼容。

## ⚠️ 部署目录（极易踩坑）

- **服务器上真实部署目录是 `/opt/mao`，不是会话工作区 `/opt/mao-data/workspace/...`**。当前会话的「工作目录」是一个云端隔离/临时目录，二者是**不同的 git 检出**。
- 涉及**真实环境部署**的操作（`git pull`、`scripts/deploy-desktop.sh`、`scripts/deploy-admin.sh`、`npm run build` 产物落地、`restart-backend.sh` 等）**一律在 `/opt/mao` 下执行**，绝不能误用会话工作区路径。
- 涉及**真实环境 git** 的同步（pull/status/log）也必须指向 `/opt/mao`；会话工作区里的 git 提交/推送只负责「产出代码并推到远端」，之后需回到 `/opt/mao` 拉取并构建部署。
- 判断「改代码」还是「改部署」时，先确认：改代码在会话工作区（提交 + 推送到 `origin/main`）；改/部署线上环境在 `/opt/mao`（`git pull` + 构建）。二者不要混用。

## 发版与 CHANGELOG

根目录 [`CHANGELOG.md`](CHANGELOG.md) 是**项目级唯一发版说明**。改动 `backend-ts/`、`admin/`、`desktop/`、`android/` 且**对用户或运维可见**时，Agent 应在同一任务中更新 CHANGELOG（勿留到发版时才补）。

| 改动目录 | 写入小节 |
|---------|---------|
| `backend-ts/` | `### 后端` |
| `admin/` | `### 管理后台` |
| `desktop/`（Web / 共用 UI） | `### 前端（桌面 / Web / 安卓）` |
| `desktop/electron/`（壳、LOCAL、自动更新） | `### 桌面 Electron` |
| `android/android/app/`（Capacitor 壳、OTA 原生） | `### 安卓原生` |
| `agent-cli/` | `### 终端 CLI（mao-agent）` |
| `skills/mao-cli/` | `### 终端 CLI（mao-cli）` |
| `skills/mao-cli/` | `### 终端 CLI（mao-cli）` |

**写法**：
- 在文件顶部当前版本的 `## x.y.z (日期)` 下追加条目；尚无该版本则新建一节。
- 新版本推荐用 `###` 分节；纯内部重构、单测、注释、无行为变化的依赖升级**可不记**。
- 用户要求「打包 / 发版 / OTA」时：先确认 CHANGELOG 已写好，再执行 `build-apk.sh` 或 `changelog-extract.sh sync-desktop`。

```bash
./scripts/changelog-extract.sh version
./scripts/changelog-extract.sh body 0.0.15 --section 后端
./scripts/changelog-extract.sh ota-text 0.0.15   # 安卓 OTA：前端 + 安卓原生
./scripts/changelog-extract.sh sync-desktop        # 同步 desktop/package.json 版本号
```

## 常用命令

```bash
# 后端（TypeScript，backend-ts/）
cd backend-ts && npm run build        # 编译检查（tsc）
cd backend-ts && npm test             # 单元测试（Vitest，backend-ts/src/）
cd backend-ts && npm run start:dev    # 开发模式（tsx 热重载）
cd backend-ts && npm run build        # 打包（backend-ts/dist/）

# 管理后台
bash scripts/deploy-admin.sh # 构建并部署（rsync --delete 自动清理历史构建文件），无需重启服务
bash scripts/deploy-admin.sh --dry-run # 仅预览将同步/删除哪些文件

# 桌面端
bash scripts/deploy-desktop.sh # 构建并部署（rsync --delete 自动清理历史构建文件），无需重启服务
bash scripts/deploy-desktop.sh --dry-run # 仅预览将同步/删除哪些文件
cd desktop && npm run dist # 由用户自行运行打包 electron 程序

# 安卓 APP（Capacitor 壳，复用 desktop 前端；仅 CLOUD 模式）
cd android && bash build-apk.sh              # 一键：构建前端 → cap sync → assembleRelease → 发布
cd android && bash build-apk.sh --dry-run    # 仅构建不发布
cd android && bash build-apk.sh --version 0.0.x  # 手动指定 versionName

# 终端 CLI（mao-agent）
curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash
cd agent-cli && npm ci && npm run build && npm test
bash scripts/agent-cli-e2e.sh   # 离线单测 + 可选真实后端验收（需 MAO_AGENT_E2E_USER/PASS）
cd agent-cli && npm link        # 开发时安装 mao-agent 命令
```

CI（`.github/workflows/ci.yml`）执行 backend-ts 的 `npm run build` 与 `npm test`，admin / desktop 前端 build，以及 `agent-cli` 的 `npm ci && npm run build && npm test`，不跑 Playwright。

## 架构概览

五端：TypeScript 后端（NestJS + Fastify）+ Vue 管理后台 (`admin/`) + Electron/Web 桌面端 (`desktop/`) + 安卓 APP (`android/`，Capacitor WebView 壳) + 终端 Agent CLI (`agent-cli/`，`mao-agent` 命令)。

### 后端

端口 9080，API 前缀 `/api/v1/`，统一响应 `Result<T>`（`code=0` 成功）。领域模块遵循 `routes → service → repository`。

**核心引擎 `harness/`**（Think-Act-Observe 循环，`backend-ts/src/harness/`）：

| 组件 | 职责 |
|------|------|
| `AgentLoop` | 主循环：构建 prompt → LLM 流式调用 → 工具执行 → 循环 |
| `PromptEngine` | 上下文 → `ChatRequest` |
| `ContextManager` / `CompactionService` | 消息历史与 token 感知压缩 |
| `ToolDispatcher` → `ToolRegistry` | 工具路由；内置工具在 `harness/tool/impl/` |
| `LlmAdapter` / `OpenAiLlmAdapter` | OpenAI 兼容协议，SSE 拉流 |
| `LocalToolExecutor` | LOCAL 模式：经 WebSocket 委托桌面端执行 |
| `HarnessService` | 会话级 Agent 运行编排 |
| `DelegateTool` + `harness/delegate/` | Subagent 委托执行 |
| `harness/skill/` | 技能加载与同步 |

**双执行模式**：`CLOUD`（服务端执行工具）/ `LOCAL`（桌面端 Electron 执行）。

**WebSocket** `/api/ws/stream`：`StreamingWsHandler` 处理双向流。常见事件：`content_delta`、`tool_call_start/result`、`session_status`、`context_window`、`compaction_start/end`、`thinking_start/end`、`skill_sync_required`、`tool_execute`。

**拦截器**：`AuditInterceptor` + `PermissionInterceptor`，作用于 `/v1/**`（排除 `/v1/auth/**` 和 `/ws/**`）。

**数据库**：MySQL 8 + Flyway。迁移脚本在 `backend-ts/db/migration/`。**启动时由 TypeScript 后端执行迁移**（`FLYWAY_ENABLED`，默认 true）。

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

基于 **Capacitor 7** WebView 壳；生产环境**远程加载** `https://mao.etarch.cn`（与 Electron 一致），前端改动部署 Web 后刷新即可。包名 `cn.etarch.mao.app`；**仅 CLOUD 模式**（无 `electronAPI` → 自动禁用 LOCAL）。设计文档：`docs/android-app-technical-design.md`。

**目录结构**：

| 路径 | 职责 |
|------|------|
| `android/capacitor.config.json` | appId / `web-stub` / `server.url`（远程 SPA）/ `adjustMarginsForEdgeToEdge` |
| `android/web-stub/` | Capacitor 占位页（启动后跳转远程，不打包 desktop 前端） |
| `android/build-apk.sh` | 原生壳构建与 APK OTA 发布 |
| `CHANGELOG.md` | 项目发版说明；APK `versionName` 取首条 `##`；OTA 文案取 `### 安卓原生` |
| `android/android/` | Capacitor 生成的原生 Gradle 工程 |
| `android/android/app/.../MainActivity.java` | BridgeActivity：Splash、系统栏、WebView、注入 `android-capacitor` |
| `android/android/app/.../AppUpdatePlugin.java` | 自研 OTA 插件：`getVersionCode` / `downloadAndInstall` |

**与 desktop 前端的衔接**（改安卓相关行为时常动这些文件）：

| 文件 | 职责 |
|------|------|
| `desktop/src/main.ts` | 检测 Capacitor 后给 `<html>` 加 `android-capacitor` |
| `desktop/src/router/index.ts` | 远程加载用 History 路由；仅旧版内嵌包（localhost）用 hash |
| `desktop/src/composables/useVersionCheck.ts` | `version.json` 页面刷新 + `android-latest.json` 原生壳 OTA |
| `desktop/src/style.css` / `TopNav.vue` | `html.android-capacitor` 顶栏紧凑布局与安全区 |

**构建链路**（`build-apk.sh`，仅原生壳变更时需要）：

1. `npx cap copy/update android`（同步 `web-stub` 与 `capacitor.config.json`）
2. `gradlew assembleRelease`（`-PMAO_VERSION_CODE` / `-PMAO_VERSION_NAME`）
3. 发布到 `/opt/mao-data/uploads/releases/`：`mao-android-<name>-<code>.apk` + `android-latest.json`

**前端发版**：与 Web/Electron 相同——`desktop` 构建部署到 Nginx，安卓用户顶栏刷新或等 `version.json` 提示即可。

**环境与签名**：

- JDK 21（`JAVA_HOME` 默认 `/usr/lib/jvm/java-21-openjdk-amd64`）、`ANDROID_HOME`（默认 `/opt/android-sdk`）、minSdk 24 / targetSdk 35
- 签名凭据：环境变量 `MAO_KEYSTORE_*`，或 `/opt/mao/keystore/keystore-credentials.env`；**keystore / 凭据严禁入 git**
- 发版前先更新根目录 `CHANGELOG.md` 顶部版本条目（versionCode 由脚本按已发布 APK 自增）

**明确不做**：LOCAL 能力、工具审批、系统推送、移动端布局重构、上架应用商店、改后端/admin。

## 代码规范

**后端**：TypeScript（Node.js 22+）；NestJS 11 + Fastify，模块按领域组织（`src/<domain>/` 下 `*.routes.ts` / `*.service.ts` / `*.repository.ts` / `*.spec.ts`）；表名/列名 snake_case，BIGINT 自增主键，`created_at`/`updated_at`；用户可见 API / 行为改动记入 `CHANGELOG.md` 的 `### 后端`。

**前端**：Vue 3 Composition API + `<script setup>`；Pinia 用函数式 `defineStore`；TypeScript 严格模式；无 ESLint/Prettier，类型检查靠 `vue-tsc`；用户可见改动记入 `CHANGELOG.md` 对应小节；`desktop/package.json` 版本由 `scripts/changelog-extract.sh sync-desktop` 从 CHANGELOG 同步，勿手改。

**安卓**：原生 Java 在 `android/android/app/`；发版改根 `CHANGELOG.md` 后跑 `build-apk.sh`；安卓专用 UI/路由/OTA 逻辑写在 `desktop/` 并用 `android-capacitor` / `Capacitor.isNativePlatform()` 守卫，勿影响 Web/Electron。

## 常见改动入口

| 目标 | 位置 |
|------|------|
| 发版说明 | 根 `CHANGELOG.md` + `scripts/changelog-extract.sh` |
| 新增 REST API | `backend-ts/src/<domain>/` 下的 `*.routes.ts` / `*.service.ts` / `*.repository.ts` |
| 数据库变更 | `backend-ts/db/migration/V0xx__*.sql`（TS 启动时执行） |
| 新增内置工具 | `backend-ts/src/harness/tool/impl/` 实现 `Tool` 接口并注册 |
| 技能扩展 | `backend-ts/src/harness/skill/`；外部目录默认 `/opt/mao/data/skills` |
| Agent 运行逻辑 | `backend-ts/src/harness/core/`（`AgentLoop`、`HarnessService`） |
| 流式通信 | 后端 `session/ws/StreamingWsHandler`；前端 `useStreamWS` |
| 权限控制 | `@RequirePermission`（`permission/` 模块） |
| 管理后台页面 | `admin/src/views/` + `admin/src/router/index.ts` |
| 桌面端 UI | `desktop/src/components/`、`desktop/src/views/` |
| 安卓壳 / 系统栏 / WebView | `android/android/app/.../MainActivity.java`、`capacitor.config.json` |
| 安卓 OTA 原生下载安装 | `AppUpdatePlugin.java` + `desktop/.../useVersionCheck.ts` |
| 安卓发版（仅原生壳） | 更新根 `CHANGELOG.md` 的 `### 安卓原生` → `cd android && bash build-apk.sh` |
| 安卓前端更新 | 与 Web 相同：部署 `desktop/dist` → 用户刷新 / `version.json` 提示 |
| 终端 CLI（mao-agent） | `agent-cli/`；发版说明写入 `### 终端 CLI（mao-agent）` |
| 终端 REST CLI（mao-cli） | `skills/mao-cli/`；发版说明写入 `### 终端 CLI（mao-cli）` |
| 终端 REST CLI（mao-cli） | `skills/mao-cli/`；发版说明写入 `### 终端 CLI（mao-cli）` |

设计文档索引见 `docs/technical-design.md`、`docs/android-app-technical-design.md` 及 `docs/` 下各专题文档。

## 测试

| 类型 | 命令 | 说明 |
|------|------|------|
| 后端单测 | `cd backend-ts && npm test` | Vitest，用例在 `backend-ts/src/`（`*.spec.ts`） |
| 终端 CLI 单测 | `cd agent-cli && npm test` | Vitest，用例在 `agent-cli/test/` |
| 前端 E2E | 根目录 `npm test` | Playwright，配置 `tests/playwright.config.ts` |
| 用例源码 | `tests/admin.spec.ts`、`tests/desktop.spec.ts` | 以文件为准，勿依赖固定用例数 |

**E2E 注意**：
- 管理后台用 `login()` 辅助函数（`admin` / `admin123`）
- 桌面端未认证时会弹登录框；主题测试须 `page.addInitScript()` 设 localStorage（Vite dev 下 `page.evaluate()` 不可靠）
- 断言优先 `toContainText` / `toBeVisible`，避免脆弱硬编码
- 分页接口默认返回第一页
