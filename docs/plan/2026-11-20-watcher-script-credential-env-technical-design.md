# 信号哨兵脚本探针凭据环境变量注入技术方案（2026-11-20）

## 1. 背景与决策变更

信号哨兵 Shell 脚本探针自 V189 起（2026-11-10 方案）按白名单注入 `PATH / TZ / HOME / MAO_WATCHER_ID / MAO_WATCHER_NAME`，且明确「凭据占位符机制不扩展到脚本（非目标）」。实践中脚本要执行 git 操作（clone/pull 私有仓库）或调用平台 API 时拿不到凭据，只能自行从工作区文件读取明文 token，比平台注入更不安全。

**决策变更（2026-11-20）**：脚本探针执行时与 agent 的 CLOUD Shell 工具（`shell-session-tool` 注入链）**完整对齐**注入凭据环境变量。历史方案文档（2026-11-10 两篇）不改，以本文为准。

## 2. 注入面（与 agent shell 同语义）

| 变量 | 来源 | 失败语义 |
|---|---|---|
| `MAO_TOKEN` | `credentialResolver.resolve(userId,'MAO_TOKEN')`：现签短效 shell JWT（同 shell `injectMaoToken` 链） | 跳过 + warn |
| `ECP_TOKEN` | 同 resolver（**只读** ECP injector，无 AccessOne 文件副作用，§5.1.4 约束不变） | 跳过 + warn |
| `GIT_TOKEN_<域名>` | `gitTokenResolver.resolveForAgent(userId, watcher.agentId)`：用户凭据 ∩ Agent 允许域 + 系统默认兜底 + fail-closed（同 shell `configureGitCredentials` 语义） | 跳过 + warn |
| `GIT_ASKPASS` + `GIT_TERMINAL_PROMPT=0` | gitTokens 非空时写 askpass 脚本（模板下沉 `common/git-askpass.ts`），git 对 https 远端免密 | 写失败降级为无 askpass |
| `MAO_BASE_URL` | `settingService.getSiteBaseUrl()` | 跳过 + warn |
| `LARKSUITE_CLI_USER_ACCESS_TOKEN` / `LARKSUITE_CLI_APP_ID` | `larkUatInjector.injectForUser(userId)` | 跳过 + warn |
| 三级环境变量 | `envVariableService.resolveForSession(userId, 哨兵脚本项目根)`（system < user < 脚本项目层） | 跳过 + warn；保留键双保险过滤 |

不变项：基础白名单；「绝不继承后端进程全量 env」（R6）；单项失败跳过不阻断探针（D2/D3 口径）；每次探针现取（探针进程一次性，spawn 时构建 ≈ shell 的每命令前刷新）。

## 3. Host 模式实现

- `watcher.service.ts`：`scriptProbeEnv` → `buildScriptProbeEnv`，返回 `{ env, credentials }`；新增四个**全部可选** deps（`gitTokenProvider / envVarsProvider / larkUatProvider / baseUrlProvider`），缺省时 env 与旧版逐键一致，单测零改动。
- MAO_TOKEN / ECP_TOKEN 复用既有 `credentialResolver`（生产装配只读 ECP 实例）。
- askpass 落属主运行时 HOME：`{userHomeRoot}/{userId}/git-askpass.sh`，0700，每次探针前重写；与会话级落点互不干扰。
- 装配 `app-openapi-services.ts`：gitTokenProvider = `gitTokenResolver.resolveForAgent`（create-app L499 同一实例）、envVarsProvider = `envVariableService.resolveForSession`、lark/baseUrl 走既有 injector 与 settingService。

## 4. 容器模式实现

- 协议帧 `script_probe` 新增可选 `credentials: ScriptProbeFrameCredentials`（gitTokens / maoToken / ecpToken / maoBaseUrl / larkUat / envVars）。安全模型与 `tool_call` 帧的 `RuntimeEnvelope` 同构：宿主每次现取、只在请求内存活、容器不落盘不写镜像。
- 兼容性：旧容器忽略未知字段 → 无凭据降级运行（不会失败）；容器运行时闭包随 backend 部署经 runtimeBuild drift 自动升级，并存窗口极短。
- 容器侧 `script-probe-dispatch.ts` `buildChildEnv` 白名单合并：`GIT_TOKEN_*` 变量名映射用下沉的 `gitTokenEnvKey`（容器不得 import git 域服务）；envVars 再过一道 `isReservedEnvKey` 双保险，用户自配变量覆盖不了 PATH/HOME/凭据等身份键；askpass 由容器自写 `/tmp/askpass-{uid}/watcher-askpass.sh`（shell-session-manager 容器模式落 /tmp 同款先例）。
- ASKPASS 模板与 `gitTokenEnvKey` 下沉 `common/git-askpass.ts`（零依赖 leaf），`git-write-operation.service.ts` re-export 保持既有引用不变。

## 5. 测试

- `watcher.service.spec.ts` 新增「SCRIPT 哨兵凭据 env 注入」6 例：全量注入 + askpass 权限/内容、三级变量保留键过滤、单项失败跳过不阻断、未装配 providers 与旧版一致、空 gitTokens 不写 askpass、Docker 模式 credentials 透传。
- `container-script-probe.spec.ts`：credentials 原样进帧 + env 白名单不吸收凭据键 + 缺省为 null。
- `script-probe-dispatch.spec.ts`：帧凭据真实 bash 执行可见（含 askpass 落 /tmp/askpass-7、0700）、envVars 保留键丢弃、credentials 缺省（旧宿主帧）无凭据照常执行。
