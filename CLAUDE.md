# CLAUDE.md

每次对话注入系统提示，保持极简；细节读链出文档/源码，勿在此扩写。
搭建/环境/部署：README.md、DEPLOY.md。产品/使用问答：skills/mao-cli/SKILL.md。细案：docs/plan/（technical-design.md、android-app-technical-design.md）。初版：重构不考虑存量数据与兼容。

## 部署坑
线上目录是 `/opt/mao`，不是会话工作区 `/opt/mao-data/workspace/...`（两套 git 检出）。改代码：工作区提交并推 origin/main。部署/线上 git：一律在 `/opt/mao` 跑 pull、scripts/deploy-{admin,desktop}.sh、构建、restart-backend.sh。勿混用。双域名合并为单域名：`docs/guides/single-domain-nginx-migration.md`。

## CHANGELOG
根 CHANGELOG.md 唯一发版说明。用户/运维可见改动须同任务写入顶部 `## x.y.z (日期)`（无则新建）；内部重构/单测/注释/无行为依赖升级可不记。打包/发版/OTA 前先写完。
每次功能变更除补 CHANGELOG 外，还须同任务同步更新对应文档（README.md、DEPLOY.md 等；历史设计与 review 文档除外），并保持 mao-cli（skills/mao-cli/）同步更新。
小节：backend-ts→后端；admin→管理后台；desktop 共用 UI→前端（桌面 / Web / 安卓）；desktop/electron→桌面 Electron；android/android/app→安卓原生；agent-cli→终端 CLI（mao-agent）；skills/mao-cli→终端 CLI（mao-cli）。
`./scripts/changelog-extract.sh {version|body 0.0.x --section 后端|ota-text 0.0.x|sync-desktop}`。desktop/package.json 版本用 sync-desktop，勿手改。

## 命令
后端：`cd backend-ts && npm run {build|test|start:dev}`（tsc / Vitest / tsx）。
部署：`bash scripts/deploy-{admin,desktop}.sh`（`--dry-run` 预览；rsync --delete，无需重启）。Electron 包：`cd desktop && npm run dist`（用户自行跑）。
安卓壳：`cd android && bash build-apk.sh`（`--dry-run` 不发布；`--version 0.0.x`）。
mao-agent：`cd agent-cli && npm ci && npm run build && npm test`；`bash scripts/agent-cli-e2e.sh`；`npm link`。
CI：backend-ts build+test、admin/desktop build、agent-cli build+test；不跑 Playwright。

## 架构
五端：backend-ts（NestJS+Fastify :9080 `/api/v1/`，`Result<T>` code=0）+ admin + desktop（Electron/Web）+ android（Capacitor 远程加载 https://mao.etarch.cn，仅 CLOUD）+ agent-cli（mao-agent）。生产单域：桌面 `/`、管理后台 `/admin/`、API `/api/`、上传 `/uploads/`；desktop 路由勿占用这些前缀。
领域：`src/<domain>/*.{routes,service,repository,spec}.ts`。引擎 `backend-ts/src/harness/`：AgentLoop、PromptEngine、ContextManager/CompactionService、ToolDispatcher→ToolRegistry（内置 `harness/tool/impl/`）、LlmAdapter、LocalToolExecutor（WS 委托桌面）、HarnessService、delegate/、skill/。CLOUD 服务端执行 / LOCAL Electron 执行。WS `/api/ws/stream` StreamingWsHandler。拦截器 Audit+Permission，`/v1/**` 排除 auth/ws。DB：MySQL8 + Flyway `backend-ts/db/migration/`，TS 启动执行（FLYWAY_ENABLED）。
admin：router `admin/src/router/index.ts`，视图 `views/`。desktop：useStreamWS、useChat、stores/auth|agent|session、electron/{main,preload}.cjs。Side Task：HarnessService + StreamingWsHandler + useCenterTabs/CenterTabBar。

## 规范
后端 TS Node22+ Nest11 Fastify；表列 snake_case，BIGINT 自增，created_at/updated_at。
前端 Vue3 `<script setup>`，Pinia `defineStore`，严格 TS，无 ESLint/Prettier，靠 vue-tsc。
安卓 Java 在 `android/android/app/`；专用 UI/路由/OTA 写 desktop 并用 `android-capacitor` / `Capacitor.isNativePlatform()` 守卫，勿影响 Web/Electron。不做 LOCAL、工具审批、系统推送、移动端布局重构、上架商店、改后端/admin。keystore 严禁入 git（`MAO_KEYSTORE_*` 或 `/opt/mao/keystore/keystore-credentials.env`）。前端发版=部署 desktop/dist（刷新/`version.json`）；仅原生壳变更才 `build-apk.sh`。

## 改哪
REST `backend-ts/src/<domain>/`；迁移 `backend-ts/db/migration/V0xx__*.sql`；内置工具 `harness/tool/impl/`；技能 `harness/skill/`（外部默认 `/opt/mao/data/skills`）；循环 `harness/core/`；流 StreamingWsHandler + useStreamWS；权限 `@RequirePermission`；admin 页 views+router；desktop UI components/views；安卓壳 MainActivity.java、capacitor.config.json；OTA AppUpdatePlugin.java + useVersionCheck.ts；mao-agent `agent-cli/`；mao-cli `skills/mao-cli/`。

## 测试
`cd backend-ts && npm test`；`cd agent-cli && npm test`；根 `npm test` Playwright（`tests/playwright.config.ts`，`tests/{admin,desktop}.spec.ts`，勿依赖固定用例数）。E2E：admin 用 `login()`（admin/admin123）；桌面未认证弹登录；主题用 `page.addInitScript` 设 localStorage（Vite 下 `evaluate` 不可靠）；断言 `toContainText`/`toBeVisible`；分页默认第一页。
