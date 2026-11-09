# 调研：信号哨兵支持 Shell 脚本探针

- 状态：调研完成，待评审拍板（2026-11-10）
- 背景需求：信号哨兵目前只支持单个 HTTP 接口探针，复杂哨兵场景（多步采集、聚合判断、本地计算）无法支持。期望支持基于 shell 脚本的哨兵：用户自己编写脚本上传到工作区，或通过对话让 Agent 编写脚本并配置好信号哨兵；运行逻辑与 HTTP 一致——定期执行脚本、检查输出结果、结果变化则触发会话任务。
- 结论先行：**可行，且架构契合度高**。调度、判定、退避、自动停用、触发、记录、清理七条既有链路全部原样复用，新增面收敛为「探针执行器 + 配置字段 + UI 两行 + 契约枚举」。核心待拍板项是执行隔离边界（host 模式 vs 容器）与脚本存储位置。

## 1. 现状：信号哨兵架构摘要（证据清单）

现有实现全部在 `backend-ts/src/signal/`，技术方案见 `docs/plan/2026-10-11-signal-watcher-technical-design.md`。

| 环节 | 现状 | 证据 |
|---|---|---|
| 数据模型 | `signal_watcher`（V148）+ `signal_watcher_check`（V148），V174 触发方式、V184/V185 展示片段 | `signal/types.ts:9-65` |
| 调度 | 全局 30s 扫描 `last_checked_at` 取到期批次 50 条，非每哨兵 timer；到期判定全在 DB 列，重启无需恢复内存态 | `signal/watcher-scheduler.ts:14-16,60-84` |
| 并发 | `dispatching` 防重入 + 每哨兵 `inFlight` Set 单飞；执行提交 `agentExecutor.submit` 线程池 | `watcher-scheduler.ts:29-38,70-84`、`app-openapi-services.ts:153-158` |
| 探针执行 | `executeProbe`（node:http，连接 10s/读 15s 超时，响应体上限 1MB）；**`deps.probe` 已是可注入依赖** | `signal/probe-client.ts:21-34`、`watcher.service.ts:70,436-443` |
| 变化判定 | `computeValueHash`：HASH（整响应体）/ JSON_FIELD（jsonPath 取值）/ STATUS_CODE 三种模式，与 `lastValueHash` 比对 | `signal/watcher.logic.ts`、`types.ts:76` |
| 失败处理 | 连败指数退避（interval × 2^n 上限 ×32）；连续 5 次失败自动 DISABLED + 收件箱通知 | `watcher.service.ts:22-30,626-657` |
| 触发 | 变化 → 渲染 promptTemplate（`{diff}` 带新旧值）→ `openRun.run`（预算闸门 → 新建/复用 CLOUD 会话 → 会话锁/排队 → `source='SIGNAL'` 驱动 Agent 运行）；**LOCAL 会话被 openRun 直接拒绝** | `watcher.service.ts:541-568`、`openapi/open-run.service.ts:143-146,161-186` |
| 凭据 | 请求头/POST 体 AES-GCM 整体加密落库（独立密钥 `APP_SIGNAL_SECRET`）；`{{MAO_TOKEN}}`/`{{ECP_TOKEN}}` 占位符按属主身份现取 | `signal/signal-cipher.ts`、`watcher-credential-resolver.ts:10-121` |
| 记录清理 | 每小时分批删除 90 天前 check 行 | `signal/signal-check-cleanup.ts:9-49` |
| UI | 设置 → 信号哨兵（`SignalWatchersView.vue` + `signal-watcher-form.ts`），列表/新建/编辑/复制/立即测试/启停/轮询记录抽屉 | `desktop/src/views/settings/SignalWatchersView.vue`、`desktop/src/router/index.ts:125-127` |

**HTTP 探针的能力边界**（即本次要补的缺口）：单请求、单响应体判定；无法做多步编排（先登录再取数）、多源聚合（比两个接口的差值）、本地计算（跑一段 jq/python 处理）、依赖本机状态的检查（磁盘剩余、进程存活、文件变更）。

## 2. 需求映射：三个子问题

1. **脚本从哪来**：用户上传到工作区（已有 `POST /v1/files/workspace-upload`，`file/file.routes.ts:539`，写入实现 `workspace-write.service.ts:161`）；或 Agent 通过对话写脚本（harness 的 edit-file / shell 工具经 `PathSandbox` 限定在工作区内写文件，`harness/safety/path-sandbox.ts:53-81`——**能力已存在，零新增**）。
2. **脚本在哪存**：见 §4.1 方案对比。
3. **脚本在哪跑、怎么判定**：后端按哨兵配置定期执行（复用调度器），stdout 作为「响应体」进入既有判定管线，exit code 映射成败。见 §4.2/§5。

## 3. 执行环境的既有事实（可行性核心）

**后端进程执行子进程是普遍既定事实，不是空白领域：**

- 云端会话的 shell 工具**直接在服务端宿主起 bash PTY**：`spawn('bash', ['-c', 'exec 2>&1; exec bash --norc --noprofile'], { detached: true })`，HOME 指向用户运行时目录（0700）、`PathSandbox` 圈定可写根——即 **host 运行模式下「用户代码在服务端跑任意 shell」已是产品既有姿态**（`harness/shell/shell-session-manager.ts:751` 及 `configureUserHome`）。
- 其余先例：git 操作 `spawn`（`file/workspace-git.service.ts`）、ripgrep `spawnSync`（`harness/tool/impl/grep-search-tool.ts:93-101`）、docker CLI `execFile`（`harness/container/container-registry.ts`）、ffmpeg（`weixin/voice-codec.service.ts:24`）。
- **容器运行模式**：管理后台可把运行环境切到 docker 模式（`app-config.ts:297-310`，默认 `host`），此时用户 shell/MCP 在每用户 `mao-runtime` 容器内执行（`Dockerfile.runtime`：node:22-bookworm-slim + bash/git/coreutils/curl/python3 等，容器内 root）。
- 部署形态：裸机 systemd + 蓝绿（`scripts/systemd/mao-backend.service`、`restart.sh`），非容器化；单实例调度器、无分布式锁（`watcher-scheduler.ts:7-10`）。

**对脚本探针的含义**：脚本探针没有引入「服务端执行用户代码」这一新性质——云端 Agent 本来就能跑任意 shell。新增的性质只有两个，需要在方案里正面处理：
1. **无人值守**：Agent 的 shell 在会话里、有用户看着（且运行轨迹可审计）；哨兵脚本按计划自动跑、无人盯着，错误不会立刻被察觉（缓解：连败自动停用 + 收件箱通知的既有链路同样覆盖脚本探针）。
2. **调度面常驻**：脚本跑在 `agentExecutor` 线程池里，与定时任务/哨兵 HTTP 探针共享；失控脚本（死循环、fork 炸弹）会挤占池子——必须有硬超时 + 进程组击杀（`detached: true` + `kill(-pid)`，与 shell-session-manager 同一模式）。

## 4. 方案空间

### 4.1 脚本存储位置

| 方案 | 说明 | 优点 | 缺点 | 判定 |
|---|---|---|---|---|
| A. 工作区路径引用（推荐） | 哨兵只存**路径**，脚本文件放用户工作区（如 `projects/<slug>/sentinels/check-xxx.sh`） | 用户上传与 Agent 代写两条路径天然成立（文件管理器/会话工具都写工作区）；脚本可被 git 版本化（项目工作区）；修改即时生效（下次轮询取新内容）；不落敏感内容到新存储 | 文件被移动/删除 → 探针失败（走既有连败停用兜底，可接受）；路径需做属主校验（见 §6） | **推荐** |
| B. DB 存内容（TEXT，可加密） | 哨兵存脚本全文 | 稳定、不依赖工作区布局 | Agent 无法用既有工具直接编辑（要新开「更新哨兵脚本」工具或 UI 编辑器）；与「上传/对话编写」的诉求错位 | 备选，不推荐首发 |
| C. 桌面端执行（LOCAL） | 脚本在用户桌面跑 | 真正的"本地"哨兵 | 与架构矛盾：哨兵触发链路 CLOUD-only（`open-run.service.ts:143-146` 明确 LOCAL 依赖桌面在线被拒）；桌面不在线哨兵就失效，与「定期可靠执行」目标冲突 | **否决** |
| D. 独立脚本执行器服务 | 单独进程/容器池跑脚本 | 隔离最彻底 | 引入新部署单元，超出本需求体量 | 远期可选 |

**存储根的具体建议**（方案 A 的子决策）：脚本路径必须解析在属主工作区根内（`{workspaceRoot}/{userId}/...`，见 `app-config.ts:257` 与 `session.service.ts:305-310`）。两个可选落点：
- 项目工作区 `projects/{slug}/sentinels/`：文件管理器已可浏览/上传（零新增展示面），git 可版本化，Agent 对话选择该项目工作区即可写脚本——**P1 推荐**；
- 专用目录 `{userId}/sentinels/`：与项目解耦，但文件管理器当前按「会话/项目」组织浏览，需新增展示面——P2 可选。

**执行细节**：以 `bash <脚本路径>` 方式调用（不要求 +x 位——工作区上传链路不承诺保留执行权限）；cwd 设为脚本所在目录；HOME 指向属主运行时目录（复用 `configureUserHome` 模式）。

### 4.2 执行位置（与运行模式联动）

| 运行模式 | 脚本探针执行位置 | 隔离级别 |
|---|---|---|
| host（当前默认） | 后端宿主进程直接 spawn | 与云端 Agent shell 相同（无进程级隔离，有 HOME/PathSandbox 约束） |
| docker 运行模式 | 属主 `mao-runtime` 容器内执行（复用容器执行桥） | 每用户容器隔离 |

**待拍板项 1**：host 模式是否开放脚本探针。两个立场——
- 开放（推荐）：与云端 Agent shell 同级风险，不构成新的安全性质；对已接受 host 模式的部署是一致的行为。
- 仅 docker 模式开放：更保守，但把强需求（脚本哨兵）与运行模式选型捆绑，host 用户（现有生产）拿不到功能。

### 4.3 探针契约设计（与 HTTP 同构）

```ts
// 新增（shared/contracts/src/signal.ts，三处同步：contracts + 后端 types.ts as const satisfies + 前端汉化表 Record）
export type SignalProbeType = 'HTTP' | 'SCRIPT';

// ProbeResult 复用（signal/probe-client.ts:24-33），脚本侧映射：
//   ok          = exit code === 0（非 0 记失败，计连败 → 既有 5 次自动停用兜底）
//   httpStatus  = null（check 行新增 exit_code 列记录退出码，语义不混用）
//   body        = stdout（utf8，进入既有 computeValueHash 判定管线，原样复用 HASH / JSON_FIELD）
//   bodyBytes   = stdout 原始字节（哈希用）
//   error       = stderr 尾部截断（200 字符口径与 safeError 一致）
//   durationMs  = 执行耗时
```

- **判定管线零改动**：`computeValueHash({compareMode, httpStatus, bodyBytes, body, jsonPath})`（`watcher.logic.ts`）直接吃 stdout；STATUS_CODE 模式对脚本语义 = exit code（若保留该模式对脚本可用需在 logic 层分流，或干脆脚本哨兵只暴露 HASH/JSON_FIELD 两模式——**待拍板项 2**，建议后者，语义更干净）。
- **资源护栏**（全部必须有）：硬超时（默认 60s，可配上限 300s，超时 `kill(-pid)` 杀进程组）；stdout 上限 1MB（对齐 HTTP `MAX_BODY_BYTES`，超限截断或判失败——建议判失败，与 HTTP 超限行为一致）；每哨兵单飞（既有 `inFlight` Set 天然覆盖）。
- **环境变量**：注入 `MAO_WATCHER_ID` / `MAO_WATCHER_NAME`（只读标识）；`{{MAO_TOKEN}}`/`{{ECP_TOKEN}}` 凭据占位符解析为**环境变量注入**（复用 `watcher-credential-resolver`，属主身份现取；默认不注入、配置里显式开启——**待拍板项 3**）。
- **入口插桩点**：`runCheck` 在 `watcher.service.ts:436-443` 分流 `probeType`：HTTP 走既有 `executeProbe`，SCRIPT 走新 `script-probe.ts`；`test()`（立即测试，:362-368）同口径分流。`deps.probe` 注入点保持用于单测。

### 4.4 数据模型与迁移（V189 草案）

```sql
ALTER TABLE signal_watcher
  ADD COLUMN probe_type VARCHAR(16) NOT NULL DEFAULT 'HTTP',      -- HTTP | SCRIPT
  ADD COLUMN script_path VARCHAR(512) NULL,                        -- 属主工作区根内相对路径
  ADD COLUMN script_timeout_seconds INT NULL;                      -- NULL=默认 60
ALTER TABLE signal_watcher_check
  ADD COLUMN exit_code INT NULL;                                   -- 仅 SCRIPT 探针记录
```

存量行 `DEFAULT 'HTTP'` 零行为变化；校验规则（`normalizeInput`，`watcher.service.ts:677-748`）：probe_type=SCRIPT 时 script_path 必填、url/method/headers/body 忽略，probe_type=HTTP 时反之——**一行内两种探针字段互斥**，避免双字段语义漂移。

### 4.5 UI 变更面

- `SignalWatchersView.vue` + `signal-watcher-form.ts`：探针类型二选一（HTTP / 脚本）；SCRIPT 态显示脚本路径选择（复用工作区文件选择组件/文件管理器浏览交互）+ 超时时长；「立即测试」回显 stdout 样例与 exit code（测试接口返回结构需加字段）。
- 轮询记录抽屉：httpStatus 列对 SCRIPT 显示 exit code（或「—」+ 新列）。
- 契约同步（AGENTS.md 三处规则）：`shared/contracts/src/signal.ts` 加 `SignalProbeType`；后端 `types.ts` 加 `SIGNAL_PROBE_TYPES as const satisfies`；前端汉化表 `Record<SignalProbeType, string>`（漏改任一端 tsc 即报错，机制自带防漏）。
- admin 端 `signal-admin.routes.ts` 只读展示如有 probeType 呈现，加一列即可。

### 4.6 Agent 自助配置哨兵（对话闭环）

「Agent 写脚本」能力已存在；缺口只在「Agent 配置哨兵本身」。三个选项：

| 选项 | 说明 | 成本 | 判定 |
|---|---|---|---|
| i. 对话写脚本 + 用户表单配置（P1 推荐） | Agent 在会话里写好脚本、给出建议的轮询间隔与判定模式，用户在哨兵表单里选这个文件 | 零新增 | 首发够用 |
| ii. 开放哨兵 REST 的自助调用 | 文档教 Agent 用 shell + `{{MAO_TOKEN}}` 调 `/v1/signal-watchers` | 低，但把内部 API 暴露成约定，且会话内拿属主 token 的路径要专门设计 | 不推荐 |
| iii. 新增内置工具 `signal-watcher-manage`（P2） | harness 内置工具，Agent 可 CRUD 自己名下的哨兵（经 service 层校验，非裸 API） | 中（工具注册 + 结果摘要 + toolDisplay 三处同步 + 测试，AGENTS.md 既有规范） | 二期做，体验最顺 |

选项 iii 落地时注意 AGENTS.md 硬性配套：`tool-result-summarizer.ts` 结果摘要、`desktop/src/utils/toolDisplay.ts` 中文名称与参数预览、成功/失败/缺参回归测试；若结果含随机 id/传输字段，`no-progress-notice.ts` 的 `VOLATILE_RESULT_KEYS` 同步。

## 5. 触发链路：完全复用，零改动

变化判定后的整条链路（`openRun` 预算闸门 → CLOUD 会话 → `source='SIGNAL'` prompt 驱动 → `markTriggered` 回写、REUSE_SESSION 复用指针、4 次/小时触发频次告警）对脚本探针**原样生效**——`promptTemplate` 的 `{diff}` 填 stdout 新旧片段（既有 500 字截断口径，`contracts signal.ts SIGNAL_SNIPPET_MAX_CHARS`）。这正是「运行逻辑与 HTTP 一样」的落地形态。

## 6. 风险与安全分析

| # | 风险 | 分析 | 对策 |
|---|---|---|---|
| R1 | 服务端执行用户任意脚本（RCE 面） | **非新增性质**：host 模式云端 Agent shell 本就任意执行（`shell-session-manager.ts:751`）。差异在无人值守（§3） | docker 运行模式走每用户容器；host 模式维持既有姿态并文档声明；待拍板项 1 |
| R2 | 失控脚本挤占 agentExecutor 线程池，拖慢定时任务/其他哨兵 | 脚本探针与 HTTP 探针同池 | 硬超时 + `detached` 进程组击杀；超时上限 300s；输出上限 1MB；每哨兵单飞 |
| R3 | 路径逃逸 / 越权读他人脚本 | script_path 来自用户输入 | 保存与执行双侧校验：resolve 后必须落在属主工作区根内（复用 `PathSandbox.isUnder`，`path-sandbox.ts:203`）；拒绝软链逃逸（resolve realPath 后再验）；属主校验用哨兵 `userId` 而非会话上下文 |
| R4 | 工作区文件被并发修改/删除 | Agent 或用户可随时改脚本 | 语义上算 feature（改脚本即改哨兵行为）；删除 → 探针失败 → 连败停用 + 收件箱通知兜底；执行时快照读取（先读文件内容再 spawn，避免执行中被截断的竞态） |
| R5 | stdout 含敏感信息直接进 LLM 上下文（{diff} 进 prompt） | HTTP 探针已有同等暴露面（响应体即 diff） | 不新增缓解；文档提示用户脚本内自行脱敏；`{diff}` 500 字截断既有限制爆炸半径 |
| R6 | 凭据经环境变量泄露给脚本（脚本可 echo） | 与 HTTP 头注入口径等价（脚本同样能打印请求头） | 默认不注入，显式开启；env 注入不经 argv（argv 对同机进程可见，env 更收敛）；文档声明 |
| R7 | fork 炸弹 / 资源耗尽 | 脚本可 spawn 子进程 | 进程组击杀覆盖直系树；深层数量攻击在 host 模式下与 Agent shell 同级（ulimit 属系统运维范畴，可写入 DEPLOY.md 建议） |
| R8 | 脚本执行时间抖动影响轮询节奏 | `last_checked_at` 写入时机在执行后，长脚本自动顺延 | 既有退避机制天然覆盖；interval 下限 1 分钟不变 |

## 7. 兼容性与影响面

- 存量哨兵：`probe_type DEFAULT 'HTTP'`，全部行为不变；新增字段可空。
- 跨端契约：`SignalProbeType` 三处同步（contracts / 后端 satisfies / 前端汉化 Record）。
- 不涉及：admin 页（仅只读展示可选）、安卓原生、本地桌面执行链路、数据库外存储。
- 测试面：`script-probe.ts` 单测（临时目录 + 真实 bash：成功/非零退出/超时击杀/输出超限/stderr 截断/路径逃逸拒绝）；`watcher.service` 分流用例（SCRIPT 建基线、变化触发、连败停用）；`normalizeInput` 互斥校验用例；desktop form 组件既有 Playwright 口径补脚本哨兵渲染。

## 8. 工作量估算与分期

| 阶段 | 内容 | 估算 |
|---|---|---|
| P1 最小闭环 | V189 迁移 + `script-probe.ts` 执行器（超时/击杀/上限/env）+ service 分流与校验 + 契约三处 + desktop 表单与展示 + 单测 | 后端 2~3 人日，前端 1~2 人日 |
| P2 体验补全 | 内置工具 `signal-watcher-manage`（Agent 全对话闭环）；专用 `sentinels/` 目录展示面；凭据 env 注入（若 P1 未做） | 1~2 人日 |
| P3 加固 | docker 运行模式的容器内执行桥接；执行审计进 run-trace 视图 | 1~2 人日 |

## 9. 待拍板项汇总

1. **host 运行模式是否开放脚本探针**（推荐开放：与云端 Agent shell 同级风险；备选仅 docker 模式开放）。
2. **SCRIPT 探针的判定模式集合**（推荐只暴露 HASH / JSON_FIELD；STATUS_CODE 的 exit code 映射语义易混，不建议保留）。
3. **凭据环境变量注入是否进 P1**（推荐 P2，先只给 `MAO_WATCHER_ID/NAME`）。
4. **脚本存储根**（推荐 P1 仅项目工作区 `projects/{slug}/`，P2 视需求加专用 `sentinels/` 目录）。

## 10. 结论

基于 shell 脚本的信号哨兵**可行且成本低**：调度/判定/退避/停用/触发/记录/清理七条链路原样复用，新增面是一个约 150 行的 `script-probe.ts` 执行器、一列迁移、一个契约枚举与表单两行；用户上传与 Agent 代写脚本两条来源路径所依赖的工作区写能力均已存在。「服务端执行用户脚本」不是新的安全性质（云端 Agent shell 先例在先），需要正面处理的是无人值守与资源护栏，方案内已给出硬超时、进程组击杀、输出上限、单飞与路径属主校验的完整护栏设计。建议按 §9 待拍板项定案后进入技术方案（`docs/plan/`）编写。
