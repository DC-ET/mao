# 安卓 APP 技术方案（Capacitor 打包）

> 状态：需求已评审，方案已与需求方达成共识
> 关联代码：`desktop/`（Vue 3 前端）、`backend/`（Java 后端）
> 适用范围：本文件描述的是**第一版**安卓 APP 的完整实现范围，做与不做均已明确界定，不包含"可选"项。

## 1. 需求背景

Mao 客户端目前支持两种访问形态：

- **桌面客户端**：Electron 壳（`desktop/electron/`），支持 LOCAL 模式（在用户本机执行终端、git、文件读写等工具）与 CLOUD 模式（工具在服务端执行）；
- **Web 访问**：同一套 Vue 3 前端通过 Nginx 部署（`/root/soft/mao/desktop`），浏览器访问时自动降级为 CLOUD 模式。

现状痛点：移动场景（通勤、外出）下用户只能用手机浏览器访问 Web 端，体验差（无桌面图标、无独立应用、入口不便）。需求方希望产出一个**安卓 APP**，让用户像使用原生应用一样打开 Mao 客户端。

经评估：Electron 官方不支持移动端，无法直接复用 Electron 打包链路；但前端整体为纯 Web 技术栈，具备用 WebView 壳方案打包成安卓 APP 的条件。

## 2. 需求描述

### 2.1 目标

交付一个安卓 APK，内部人员安装后：

1. 以独立应用形态提供与 Web 端一致的**核心聊天闭环**体验；
2. 手机端**仅使用 CLOUD 模式**（工具在服务端执行），不依赖本机能力；
3. 复用现有后端（`https://mao.etarch.cn`）与现有前端代码，后端零改动。

### 2.2 范围界定

#### 要做（第一版交付内容）

| 模块 | 说明 |
|---|---|
| 登录/登出 | 沿用现有认证流程，token 存 localStorage（与 Web 端一致） |
| 会话管理 | 会话列表、创建会话、切换会话、历史消息加载 |
| Agent 选择 | 选择 Agent、切换模型 |
| 聊天与流式输出 | 消息发送、WebSocket 流式接收（content_delta）、消息渲染（Markdown/代码高亮/图片） |
| CLOUD 工具执行 | 工具在服务端执行，结果流式回流展示（running tools、文件变更面板等现有 UI） |
| ask_user_questions | 服务端提问事件在 Web 端已有处理链路，安卓端沿用 |
| Side Task 查看 | 并行子会话的进度与结果展示沿用现有 UI |
| 本地技能列表展示 | 服务端技能目录展示（CLOUD 下可用部分） |
| 版本号展示 | 设置页展示 APP 版本（versionName） |
| APK 构建与签名 | 本机 Android SDK 构建，release keystore 签名，输出可分发的 APK |
| **应用内更新（OTA）** | 启动时 + 设置页手动检查版本；支持强制更新与普通更新；APP 内下载并拉起系统安装器；支持忽略普通版本 |

#### 不做（明确排除）

| 模块 | 排除原因 |
|---|---|
| LOCAL 模式全部能力（终端、git 状态/提交、本地文件读写、本地技能同步、MCP 本地执行、`select-directory` 等） | 安卓沙盒无 node-pty / child_process / 文件系统直读；前端已有降级逻辑会自动禁用 LOCAL 入口 |
| 工具审批弹窗（Electron 原生对话框链路） | CLOUD 模式工具在服务端执行，不产生 `tool_execute` 事件，无审批需求；`WAITING_APPROVAL` 仅 LOCAL 模式存在 |
| 系统推送通知（Agent 任务完成等） | 不在第一版范围（OTA 的下载进度提示除外） |
| 移动端布局重构/适配 | 第一版直接加载现有 UI，靠 viewport 与系统 WebView 适配 |
| PWA / Add to Home Screen 优化 | 已有原生壳，不需要 PWA |
| 上架应用商店（Google Play / 国内商店） | 仅内部分发 |
| 后端代码改动 | CORS 已 `allowedOriginPatterns("*")`，无 UA/设备限制，无需改动 |
| admin 管理后台改造成安卓 APP | 只做客户端（desktop 前端），不做管理后台 |

## 3. 技术选型

### 3.1 方案对比

| 方案 | 结论 |
|---|---|
| Electron 打包安卓 | **不可行**。Electron 官方无移动端支持，无法产出 APK |
| React Native / Flutter 重写 | **不选**。需重写全部 UI，成本极高，且项目前端为 Vue 3 技术栈，无法复用 |
| **Capacitor（WebView 壳）** | **采用**。复用现有 Vue 前端零重构，官方支持 Vite 集成与安卓打包，是"Web 技术栈 → 安卓 APK"的标准路径 |
| 直接分发 PWA | 不选。无独立应用形态、无签名分发、体验弱于 APK |

### 3.2 关键选型明细

| 项 | 选型 | 理由 |
|---|---|---|
| 壳框架 | Capacitor（@capacitor/core + @capacitor/cli + @capacitor/android） | 官方支持安卓，WebView 壳，最小侵入 |
| 安卓工程 | Capacitor 生成的 `android/` 原生工程（Gradle 构建） | 自带 gradle wrapper，无需全局 Gradle |
| 构建环境 | 本机（当前服务器）安装 Android SDK 命令行工具 | 与现有 `deploy_local.sh` 部署风格一致，产物可控 |
| 签名 | 新建 release keystore（keytool 生成），存服务器安全目录，**不入 git** | 保证后续版本可覆盖升级 |
| token 存储 | localStorage（前端 `auth-storage.ts` 非 Electron 分支自动生效） | 与 Web 端行为一致，零代码改动 |
| 包名 | `cn.etarch.mao.app` | 独立于桌面端 `cn.etarch.mao.desktop` |
| minSdk / targetSdk | minSdk 24（Android 7.0）/ targetSdk 34 | 覆盖主流设备，Capacitor 7 默认要求 |
| 版本号 | versionName 沿用桌面端版本节奏（0.0.x），versionCode 每次递增 | 支持同签名覆盖安装 |
| WebSocket | 沿用 `useStreamWS` 自动转换逻辑，`wss://mao.etarch.cn/api/ws/stream` | 生产环境自动生效，零改动 |
| OTA 数据源 | 静态 `android-latest.json` 清单，与 APK 一同发布到 `https://mao.etarch.cn/uploads/releases/`（复用现有 Nginx 静态服务与 electron 发布目录） | 后端/admin 零改动 |
| OTA 下载安装 | 原生 DownloadManager 下载 APK + FileProvider 拉起系统安装器（自研小插件，不依赖社区库） | APP 内完成，不跳浏览器 |
| OTA 策略 | `minVersionCode` 强制更新 / 普通更新；普通更新支持"忽略此版本"（localStorage 记忆） | 覆盖协议变更强升与日常迭代 |
| OTA 更新说明 | `android/CHANGELOG.md` 最近一条记录，构建脚本自动写入清单 JSON | 发版时只改一个文件 |

### 3.3 现状兼容性（代码探索结论）

以下事实决定了"前端零重构"的可行性，均已从当前代码验证：

1. **electronAPI 全量特性检测**：所有 IPC 调用（`auth-storage.ts`、`useStreamWS.ts`、`useChat.ts`、`useTerminal.ts`、`localSkills.ts` 等）均以 `!!window.electronAPI` 守卫。Capacitor WebView 不注入 electronAPI，前端自动走 browser 路径。
2. **LOCAL 模式自动禁用**：`ChatInput.vue` 的 LOCAL radio `:disabled="!isElectronClient"`；`useChat.ts` 对 `executionMode === 'LOCAL' && !isElectron` 直接阻断。安卓端用户无法创建 LOCAL 会话。
3. **认证存储自动回退**：`auth-storage.ts` 非 Electron 环境使用 localStorage，与 Web 端完全一致。
4. **WS 客户端标识**：非 Electron 自动传 `client=browser`，服务端按 browser 客户端处理（CLOUD 工具服务端执行，无 `tool_execute` 下发）。
5. **后端无阻碍**：CORS 全放行；生产地址为 HTTPS，无明文流量问题。

### 3.4 版本与兼容矩阵

| 依赖 | 版本要求 | 当前环境 |
|---|---|---|
| Node.js | ≥ 20 | v24.3.0 ✓ |
| JDK | 17（AGP 8.x 要求） | 17.0.19 ✓ |
| Android SDK | platform 34 + build-tools 34 | 未安装，需安装 |
| Gradle | 由 Capacitor 生成的 wrapper 提供 | 无需全局安装 |
| Capacitor | 7.x | 待安装 |

## 4. 实现步骤

### 4.1 安装 Android SDK（一次性）

1. 下载 Android commandline-tools 到 `/opt/android-sdk/cmdline-tools`；
2. 用 `sdkmanager` 安装：`platform-tools`、`platforms;android-34`、`build-tools;34.0.0`；
3. 配置环境变量 `ANDROID_HOME=/opt/android-sdk`，写入 shell 配置；
4. 接受 SDK licenses（`yes | sdkmanager --licenses`）。

### 4.2 创建 android/ 壳工程

1. 新建 `android/` 目录（与 backend/admin/desktop 平级），初始化 npm 项目；
2. 安装 `@capacitor/core`、`@capacitor/cli`、`@capacitor/android`；
3. `npx cap init`：appName=`Mao`，appId=`cn.etarch.mao.app`；
4. 配置 `capacitor.config.ts`：`webDir: '../desktop/dist'`；
5. `npx cap add android` 生成安卓原生工程（自带 gradle wrapper）。

### 4.3 构建产物衔接

1. 先构建桌面端 Web 产物：`cd desktop && npx vue-tsc -b && npx vite build`；
2. 因 Vite `base: '/'` 在 Capacitor 自定义 scheme 下存在绝对路径边界风险，安卓构建脚本中对 desktop 产物使用 `vite build --base=./`（独立构建，不改动 `vite.config.ts` 的 Web/Nginx 行为）；
3. `npx cap sync android` 同步 Web 产物与插件到安卓工程。

### 4.4 release 签名

1. `keytool -genkeypair` 生成 `mao-release.keystore`，alias 与密码单独记录；
2. keystore 存放于服务器安全目录（如 `/root/soft/mao/keystore/`），**禁止入 git**（加入 `.gitignore`）；
3. 在 `android/` 工程 `gradle.properties` 中通过环境变量注入签名配置（keystore 路径、密码不写入代码库）。

### 4.5 构建 APK

1. 提供一键脚本 `android/build-apk.sh`：构建 desktop（`--base=./`）→ `cap sync` → `gradlew assembleRelease`；
2. 产物 `android/app/build/outputs/apk/release/app-release.apk`；
3. 复制到分发目录（如 `/root/soft/mao/releases/mao-0.0.x.apk`），命名含版本号。

### 4.6 验证与分发

1. 安装测试（真机/模拟器）：登录、创建会话、发送消息、流式输出、CLOUD 工具执行、ask_user_questions、Side Task；
2. 验证 LOCAL 入口不可用（radio 禁用）、token 登录态持久；
3. 通过内部分发渠道（网盘/微信）下发 APK。

### 4.7 应用内更新（OTA）实现

1. 自研 Capacitor 插件 `AppUpdate`（原生侧）：
   - `downloadAndInstall(url)`：DownloadManager 下载 APK，完成后通过 FileProvider 拉起系统安装器；
   - 权限：`REQUEST_INSTALL_PACKAGES`（Android 8+ 未知来源）、写入 Downloads 目录；
   - 下载进度通过插件事件回传前端展示。
2. 前端 OTA 检查模块（`desktop/src/` 新增 composable，非 Electron 且安卓环境生效）：
   - 启动时 + 设置页"检查更新"按钮触发；
   - `fetch(https://mao.etarch.cn/uploads/releases/android-latest.json)`，比对 `versionCode`；
   - `currentVersionCode < minVersionCode` → 强制更新弹窗（不可跳过）；否则普通更新弹窗（可"忽略此版本"/"稍后再说"）；
   - "立即更新" → 调插件下载安装。
3. 发布侧（`android/build-apk.sh` 内）：
   - 构建成功后复制 `app-release.apk` → `releases/mao-android-<versionName>.apk`；
   - 生成 `android-latest.json`（versionCode / versionName / 下载 URL / minVersionCode / changelog / 发布时间），changelog 取 `android/CHANGELOG.md` 最近一条；

## 5. 落地清单

| # | 任务 | 产出 | 状态 |
|---|---|---|---|
| 1 | 安装 Android SDK + 环境变量 + licenses | SDK 就绪 | ✅ 完成 |
| 2 | 创建 `android/` Capacitor 壳工程（webDir 指向 desktop/dist） | android/ 工程 | ✅ 完成 |
| 3 | 安卓构建脚本（build-apk.sh：vite --base=./ + cap sync + assembleRelease） | 脚本 | ✅ 完成 |
| 4 | 生成 release keystore 并配置签名（不入 git） | keystore + 签名配置 | ✅ 完成 |
| 5 | 构建 release APK 并输出到分发目录 | APK | ✅ 完成 |
| 6 | OTA 发布：build-apk.sh 自动发布 APK + android-latest.json 到 releases 目录 | 发布脚本 | ✅ 完成 |
| 7 | OTA 检查：前端启动/手动检查 + 强制/普通弹窗 + 忽略版本 | 前端模块 | ✅ 完成 |
| 8 | OTA 安装：原生 AppUpdate 插件（下载/进度/拉起安装器） | 插件 | ✅ 完成 |
| 9 | 真机验收（登录/聊天/流式/CLOUD 工具/提问/Side Task/登录态持久/OTA 全流程） | 验收报告 | ⏳ 待用户真机验证 |
| 10 | 文档：README 补充安卓构建与 OTA 说明 | README 更新 | ✅ 完成 |

## 6. 风险与注意事项

| 风险 | 影响 | 应对 |
|---|---|---|
| WebView 的 localStorage 持久性依赖系统行为 | 用户清数据/系统清理后需重新登录 | 可接受（与 Web 端一致）；后续如需要可换 Capacitor Preferences |
| 老旧安卓机型 WebView 内核过旧 | 渲染异常 | minSdk 24 + 要求系统 WebView 可升级，覆盖主流机型即可 |
| Vite `base:'/'` 与 Capacitor 加载协议边界 | 资源 404 | 安卓构建统一用 `--base=./`，已写入步骤 |
| 桌面布局在手机上的可用性 | 操作体验一般 | 已确认第一版接受，不做布局适配 |
| keystore 丢失 | 无法覆盖升级 | keystore 与密码在服务器安全目录备份，避免丢失 |
| OTA 下载中断/失败 | 用户停留在旧版 | 下载失败提示重试；强制更新场景不可跳过 |
| 安卓 8+ "未知来源安装" 权限被拒 | 无法安装新包 | 拉系统安装器前引导开启 `REQUEST_INSTALL_PACKAGES` 权限 |
| 清单 JSON 与 APK 版本不一致 | 用户下载到错误版本 | 构建脚本原子发布（先生成校验，再复制 APK 与 JSON），发布后人工抽查 |
| 开发阶段禁止自行重启后端服务 | 影响联调 | 遵循仓库 CLAUDE.md 禁令，重启动作由用户执行 |

## 7. 明确不做事项（防止范围蔓延）

1. 不做 LOCAL 模式（终端/git/本地文件/本地技能/MCP 本地）；
2. 不做工具审批弹窗链路（CLOUD 模式无此流程）；
3. OTA 不做：后台定时检查、系统通知提醒更新（仅启动/手动检查 + 下载进度提示）；
4. 不做系统推送通知；
5. 不做移动端布局重构与触控优化；
6. 不做 PWA；
7. 不上架任何应用商店；
8. 不改动后端代码与 admin 管理后台；
9. 不改动现有 desktop 的 Web/Nginx 构建行为（`vite.config.ts` 保持 `base:'/'`）。
