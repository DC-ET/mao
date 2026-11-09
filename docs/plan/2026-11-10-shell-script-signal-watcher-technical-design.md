# 信号哨兵 Shell 脚本探针技术方案

- 状态：待实施（2026-11-10 定稿）
- 日期：2026-11-10
- 需求来源：调研文档 `docs/research/2026-11-10-shell-script-signal-watcher-research.md`（含全部代码证据）；调研 §9 四个待拍板项已定案，见本文 §8
- 规模：后端约 600 行（迁移 4 列 + `script-probe.ts` 执行器约 150 行 + service 分流/校验 + 2 个内置工具）+ desktop 约 250 行（表单分流 + 路径选择对话框）+ admin 约 30 行 + 契约/测试；**一次数据库迁移（V189）、零新依赖**
- 关联：`backend-ts/src/signal/`、`shared/contracts/src/signal.ts`、`desktop/src/views/settings/SignalWatchersView.vue`、`desktop/src/views/settings/signal-watcher-form.ts`、`admin/src/views/signal/SignalWatcherListView.vue`、`harness/tool/{tool-registry,impl}/`、`USER_GUIDE.md`、`skills/mao-cli/reference/desktop.md`

## 1. 需求背景

信号哨兵（`signal_watcher`，V148）当前只支持单个 HTTP 接口探针：`executeProbe`（node:http）单请求、取响应体、按 HASH / JSON_FIELD / STATUS_CODE 三种模式与上次哈希比对，变化即以 `{diff}` 渲染提示词触发 CLOUD 会话。该模型覆盖不了复杂哨兵场景：多步编排（先登录取 token 再查数据）、多源聚合（对比两个接口的差值）、本地计算（jq / python 处理）、依赖服务器本机状态的检查（磁盘剩余、进程存活、文件变更）。

本批次新增 **Shell 脚本探针**：用户在项目工作区上传脚本，或在会话中让 Agent 编写脚本并配置哨兵；运行逻辑与 HTTP 完全一致——按轮询间隔定期执行脚本，stdout 作为判定值进入既有判定管线，结果变化触发会话任务。

硬约束：**存量 HTTP 哨兵零行为变化**（`probe_type` 默认 `'HTTP'`，所有新列可空）；脚本探针复用调度、判定、退避、自动停用、触发、记录、清理七条既有链路，不改调度器与触发面。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **数据模型**：V189 迁移——`signal_watcher` 加 `probe_type`（`'HTTP' | 'SCRIPT'`，默认 `'HTTP'`）、`script_path`（项目工作区内相对路径）、`script_timeout_seconds`（NULL=默认 60）；`signal_watcher_check` 加 `exit_code`。
2. **脚本执行器 `signal/script-probe.ts`（新建）**：`bash <绝对路径>` 执行、白名单环境变量、硬超时进程组击杀、stdout 1MB 上限、exit code 语义映射为 `ProbeResult`。
3. **service 分流与校验**：`runCheck` / `test` 按 `probeType` 分流；`normalizeInput` 扩展 SCRIPT 分支校验（互斥、路径属主、存在性、大小、超时范围、间隔下限）；`AFFECTS_BASELINE` 加 `probeType`/`scriptPath`。
4. **契约三处同步**：`shared/contracts/src/signal.ts` 加 `SignalProbeType`；后端 `types.ts` 加 `SIGNAL_PROBE_TYPES as const satisfies`；desktop 与 admin 各加 `Record<SignalProbeType, string>` 汉化表。
5. **Agent 内置工具 2 个**：`list_signal_watchers`（列自己名下哨兵）与 `create_signal_watcher`（在会话中创建绑当前 Agent 的哨兵，支持脚本探针），按 `create_scheduled_task` 既有模式注册与接线。
6. **desktop UI**：哨兵表单探针类型二选一（HTTP / Shell 脚本），SCRIPT 态显示脚本路径选择对话框（新建组件）+ 超时秒数，隐藏 URL/方法/请求头/请求体；列表卡显示探针类型与脚本路径；「立即测试」结果展示 exit code 与 stdout 样例。
7. **admin 展示**：`SignalWatcherListView` 加「类型」列，「探测地址」列对脚本哨兵显示脚本路径。
8. **测试与文档**：`script-probe.spec.ts`、service 分流用例、工具用例、toolDisplay/summarizer 同步、Playwright 补充；`USER_GUIDE.md`、`skills/mao-cli/reference/desktop.md`、`CHANGELOG.md`（0.0.494）同步。

### 2.2 非目标（明确不做）

1. **不做凭据环境变量注入**：`{{MAO_TOKEN}}` / `{{ECP_TOKEN}}` 占位符机制不扩展到脚本探针；脚本 env 只注入 `MAO_WATCHER_ID` / `MAO_WATCHER_NAME`。脚本需要凭据时自行从工作区文件读取或访问免凭据目标。将来要支持须新提案（泄露面需要专门设计：脚本可 echo / 落日志）。
2. **不做 docker 运行模式的容器内执行**：脚本探针与 HTTP 探针同为服务端基础设施行为，统一在后端宿主执行，不随运行环境模式（host / docker）分流。docker 运行模式部署的隔离姿态差异在 DEPLOY.md 声明（§6 R1）。
3. **不做脚本内容静态审查/白名单命令过滤**：无法对任意 bash 做可靠静态分析；风险姿态与云端 Agent shell 对齐（见 §6 R1）。
4. **不做 update / delete 内置工具**：哨兵的修改、启停、删除是 UI 职责（表单已有完整编辑能力）；Agent 工具面只开放「列表 + 创建」，避免 Agent 擅自改用户既有哨兵的判定语义。将来要加须新提案。
5. **不做专用 `sentinels/` 目录与展示面**：脚本只允许放在项目工作区（`{workspaceRoot}/{userId}/projects/<slug>/`）内，文件管理器与上传链路全部复用既有能力。
6. **不做 LOCAL / 桌面端执行**：哨兵触发链路 CLOUD-only（`open-run.service.ts:143-146` 拒绝 LOCAL），脚本探针同为服务端执行。
7. **不做 STATUS_CODE 判定模式对脚本的开放**：脚本侧 exit code 是成败语义（非 0 = 探针失败计连败），不是变化判定的输入；SCRIPT 哨兵只允许 HASH / JSON_FIELD。
8. **不做并发执行上限、CPU/内存限额**：每哨兵单飞（既有 `inFlight` Set）+ 硬超时 + 线程池天然排队已覆盖；系统级 ulimit 属运维范畴，写入 DEPLOY.md 建议，不做产品化配额。

## 3. 技术选型与决策

### 3.1 决策表

| 决策点 | 定案 | 理由 / 证据 |
|---|---|---|
| 执行位置 | 后端宿主进程统一 spawn，不随运行环境模式分流 | HTTP 探针本就在后端进程发起（`probe-client.ts`），运行模式只管会话工具执行（`app-config.ts:297-310`）；云端 Agent shell 在 host 模式本就宿主执行（`shell-session-manager.ts:751`），脚本探针不构成新的执行性质 |
| 调用方式 | `spawn('bash', ['<script 绝对路径>'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })` | 不要求 +x 位（工作区上传链路不保留执行权限）；不合并 stderr 进 stdout（判定值只吃 stdout）；stdin 关闭（脚本不可交互读，无人值守语义）；`detached` 独立进程组供超时 `kill(-pid, 'SIGKILL')` 整组回收（与 shell-session-manager 同模式） |
| 执行竞态语义 | 不做内容快照；执行的是 spawn 时刻磁盘上的当前内容 | 脚本属主即用户本人，「当前内容生效」是合理语义；POSIX unlink 语义保证已打开的 fd 不受删除影响；快照经 stdin 注入会让读 stdin 的脚本读到自身源码（陷阱），否决 |
| 环境变量 | 白名单构造全新 env：`PATH`（继承后端进程）、`HOME`（属主运行时目录，复用 `configureUserHome` 模式 0700）、`TZ`、`MAO_WATCHER_ID`、`MAO_WATCHER_NAME` | 不继承后端全量 env——后端进程 env 含 `APP_SIGNAL_SECRET`、DB 密码等，整包下发即泄露 |
| 超时 | 默认 60s；`script_timeout_seconds` 可配 5~300 整数；超时 `kill(-pid,'SIGKILL')` 后判失败，error=`执行超时（${n}s）` | HTTP 探针连接 10s+读 15s 同量级；300s 上限防线程池被长脚本占满 |
| 输出上限 | stdout 累计 ≤1MB，超限杀进程判失败，error=`输出超限`；error 文本统一取 stderr 尾部 200 字符 | 对齐 HTTP `MAX_BODY_BYTES = 1024 * 1024`（`probe-client.ts:19`）与 `safeError` 截断口径（`probe-client.ts:37`） |
| 判定管线 | stdout（utf8）→ 既有 `computeValueHash({ compareMode, httpStatus: null, bodyBytes, body })`，SCRIPT 仅 HASH / JSON_FIELD | 判定、基线、`{diff}` 新旧片段、触发链路零改动；`watcher.logic.ts` 不分流 |
| exit code 语义 | 0=成功（stdout 判定）；非 0=探针失败计连败（走既有退避 + 5 连败自动停用）；超时/信号击杀=失败 | check 行 `exit_code` 列记录实际值；HTTP 侧该列为 NULL |
| 间隔下限 | SCRIPT 哨兵 `intervalMinutes` 下限 5 分钟（HTTP 维持 1 分钟） | 脚本最长 300s，1 分钟间隔会持续重叠（单飞会跳过，但轮询形同虚设）；`WATCHER_MIN_INTERVAL_MINUTES` 不动，SCRIPT 校验分支单独限 5 |
| 脚本存储根 | 仅项目工作区：`script_path` 存**相对路径** `<slug>/<子路径>`，解析根为 `{workspaceRoot}/{userId}/projects/` | 项目工作区生命周期独立于会话（会话回滚/删除会删会话工作区目录，`session.service.ts:319`；项目目录按 (userId, slug) 共享保留，`:274-298`）；文件管理器与上传（`file.routes.ts:539`）已覆盖该目录；Agent 会话绑定项目工作区即可用文件工具写脚本 |
| 路径校验 | 保存与执行双侧：拒绝绝对路径与含 `..` 段；normalize 后 `resolve(projectsRoot, scriptPath)` 与 `realpath` 均必须落在 `projectsRoot` 内（`path-sandbox.ts` `isUnder`）；保存时另校验文件存在、可读、≤256KB | 双侧校验防 TOCTOU：保存后目录被软链替换等；执行侧用 `realpathSync` 后再验 |
| 基线重置 | `AFFECTS_BASELINE` 加 `'probeType'`、`'scriptPath'`；`scriptTimeoutSeconds` 不加 | 超时不影响判定值；`watcher.service.ts:151-152` 既有机制 |
| `{url}` 占位符 | SCRIPT 哨兵的 `{url}` 渲染为脚本路径 | `watcher.logic.ts:143` 渲染处按 probeType 取值；提示词模板不新增占位符（`{name}` `{diff}` 语义不变） |
| 内置工具 | `list_signal_watchers` + `create_signal_watcher` 两个，走 `WatcherService` 既有方法；`agentId` 取当前会话的 Agent、`userId` 取会话属主（`create_scheduled_task` 同模式，`scheduled-task-tools.ts:91-99`） | 复制 scheduled-task 四件套的裁剪版；创建时 SCRIPT 必传 `script_path` 且服务端校验文件已存在，错误信息引导先写脚本 |
| 工具结果 id 处理 | `watcher_id` 是语义身份，**不进** `VOLATILE_RESULT_KEYS`（与 `create_scheduled_task` 的 `task_id` 同判，`no-progress-notice.ts:52` 注释口径） | 非随机 id；按工具归一化无需新增 |
| UI 落点 | 哨兵表单顶部加「探针类型」radio（HTTP 接口 / Shell 脚本），SCRIPT 态切换显示脚本区（路径 + 选择器 + 超时）、隐藏 HTTP 区（URL/方法/请求头/请求体） | 单表单分流，不拆两个对话框；编辑哨兵允许在两种探针间切换（切换即清另一侧字段 + 重置基线，由 `AFFECTS_BASELINE` 覆盖） |
| admin 展示 | `SignalWatcherListView` 加「类型」列（Record 汉化），「探测地址」列 SCRIPT 显示「脚本：`<path>`」，「方法」列 SCRIPT 显示「—」 | 只读列表，零交互新增 |

### 3.2 探针契约映射表（SCRIPT → `ProbeResult` / 既有管线）

| `ProbeResult` 字段 | HTTP 探针 | 脚本探针 |
|---|---|---|
| `ok` | 完整响应 | `exit code === 0` 且未被超时击杀且 stdout 未超限 |
| `httpStatus` | HTTP 状态码 | `null`（check 行记录 `exit_code`） |
| `body` / `bodyBytes` | 响应体 | stdout（utf8 解码 / 原始字节） |
| `error` | `safeError` | stderr 尾部 200 字符；超时=`执行超时（Ns）`；超限=`输出超限`；spawn 失败=`无法启动脚本进程` |
| `durationMs` | 请求耗时 | 进程 wall clock |

check 行落库：`httpStatus=null`、`exitCode=实际值`、`valueHash/oldValueSnippet/newValueSnippet/changed/triggeredSessionId/durationMs/warning` 全部照既有语义。

### 3.3 字段与校验值表（定案）

| 项 | 值 |
|---|---|
| `probe_type` | `'HTTP' \| 'SCRIPT'`，DB `VARCHAR(16) NOT NULL DEFAULT 'HTTP'` |
| `script_path` | DB `VARCHAR(512) NULL`；格式 `<slug>/<相对路径>`，拒绝绝对路径与 `..` 段 |
| `script_timeout_seconds` | DB `INT NULL`；NULL=60；合法 5~300 整数 |
| `signal_watcher_check.exit_code` | DB `INT NULL` |
| SCRIPT 专属校验 | `compareMode ∈ {HASH, JSON_FIELD}`；`intervalMinutes ≥ 5`；脚本文件存在、可读、≤256KB（保存时校验，错误文案「脚本文件不存在：`<slug>/<path>`（请先在工作区上传或让 Agent 编写）」） |
| 字段互斥 | `probe_type='SCRIPT'` 时忽略 url/method/headers/body；`='HTTP'` 时忽略 script_path/script_timeout_seconds（normalizeInput 单侧归空，防双字段语义漂移） |
| 汉化文案 | `Record<SignalProbeType, string>`：`HTTP → 'HTTP 接口'`、`SCRIPT → 'Shell 脚本'` |

## 4. 实现步骤

### 步骤 1：迁移 `backend-ts/db/migration/V189__signal_watcher_script_probe.sql`

```sql
ALTER TABLE signal_watcher
  ADD COLUMN probe_type VARCHAR(16) NOT NULL DEFAULT 'HTTP',
  ADD COLUMN script_path VARCHAR(512) NULL,
  ADD COLUMN script_timeout_seconds INT NULL;
ALTER TABLE signal_watcher_check
  ADD COLUMN exit_code INT NULL;
```

同步 `signal/types.ts` 的 `SignalWatcher` / `SignalWatcherCheck` 接口（`probeType` / `scriptPath` / `scriptTimeoutSeconds` / `exitCode`）与 repository 读写列清单。

### 步骤 2：契约三处同步

1. `shared/contracts/src/signal.ts`：加 `export type SignalProbeType = 'HTTP' | 'SCRIPT';` 与注释（事实源在后端 types.ts）。
2. `backend-ts/src/signal/types.ts`：`export const SIGNAL_PROBE_TYPES = ['HTTP', 'SCRIPT'] as const satisfies readonly SignalProbeType[];` + `isSignalProbeType` 守卫。
3. `desktop/src/views/settings/signal-watcher-form.ts`：`export const PROBE_TYPE_LABELS: Record<SignalProbeType, string> = { HTTP: 'HTTP 接口', SCRIPT: 'Shell 脚本' }`。
4. `admin` 侧哨兵列表页同样 `Record<SignalProbeType, string>` 汉化（漏改任一端 tsc 即报错）。

### 步骤 3：`backend-ts/src/signal/script-probe.ts`（新建，约 150 行）

```ts
export interface ScriptProbeRequest {
  /** 绝对路径（service 侧已完成属主校验与 realpath）。 */
  scriptPath: string;
  timeoutSeconds: number;
  env: Record<string, string>;   // 白名单 env（含 MAO_WATCHER_ID/NAME）
}

export interface ScriptProbeResult {
  ok: boolean;
  exitCode: number | null;       // 信号击杀为 null
  stdout: string | null;         // 成功时 utf8 解码；失败为 null
  stdoutBytes: Buffer | null;
  error: string | null;          // stderr 尾部 200 字符 / 超时 / 超限 / spawn 失败
  durationMs: number;
}

export function executeScriptProbe(req: ScriptProbeRequest): Promise<ScriptProbeResult>
```

- `spawn('bash', [scriptPath], { cwd: dirname(scriptPath), env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })`；cwd 目录不存在按失败返回。
- 双 timer（超时 wall-clock 杀进程组 `process.kill(-pid, 'SIGKILL')`；stdout 累计 1MB 超限同样杀进程组）——结构仿 `probe-client.ts` 的双 timer + 流式上限。
- 非零退出：`ok=false`，error=stderr 尾部 200 字符；`exitCode` 照实。
- stderr 收集上限 8KB（超出即停收，防错误信息本身爆炸）。
- `runCheck` / `test` 侧把 `ScriptProbeResult` 映射为 `ProbeResult`（`httpStatus: null`），不新建平行管线。

### 步骤 4：`watcher.service.ts` 分流与校验

1. `runCheck`（`:410`）：按 `watcher.probeType` 分流——
   - HTTP：现有流程不动（`assertProbeUrl`、凭据占位符解析、`executeProbe`）；
   - SCRIPT：跳过 url/headers/body 逻辑 → `resolveScriptPath(watcher.userId, watcher.scriptPath)`（realpath + isUnder 双验）→ `executeScriptProbe` → 失败走既有 `recordFailure`，成功走既有 `checkRepo.insert` + `computeValueHash` + 变化触发。
2. `test`（`:351`）同口径分流；`WatcherTestResult` 加 `exitCode: number | null`，`sample` 语义对 SCRIPT = stdout 头 500 字。
3. `normalizeInput`（`:677`）扩展：
   - 新入参 `probeType`（缺省 `'HTTP'`）、`scriptPath`、`scriptTimeoutSeconds`；
   - SCRIPT 分支：`compareMode ∈ {HASH, JSON_FIELD}`（否则报「脚本哨兵判定模式仅支持 HASH/JSON_FIELD」）、`scriptPath` 格式校验（非绝对路径、无 `..`）+ 服务层异步补验文件存在/可读/≤256KB、`intervalMinutes ≥ 5`（报「脚本哨兵轮询间隔需为 5~1440 的整数分钟」）、`scriptTimeoutSeconds ∈ [5,300]`、url/method/headers/body 归空；
   - HTTP 分支：`scriptPath`/`scriptTimeoutSeconds` 归空，其余不动。
4. `AFFECTS_BASELINE` 加 `'probeType'`、`'scriptPath'`（`watcher.service.ts:151-152`）。
5. `toView` / admin view 输出 `probeType` / `scriptPath` / `scriptTimeoutSeconds`。
6. 复制（copyFrom）继承：SCRIPT 字段为普通字段照抄（无敏感值），HTTP 敏感值继承逻辑不变。

### 步骤 5：REST 路由与 desktop API 类型

1. `watcher.routes.ts` `toInput` 加 `probeType` / `scriptPath` / `scriptTimeoutSeconds` 三键透传（undefined=未下发，编辑时沿用库值——与 headers 同口径，`:22-26` 注释模式）。
2. `desktop/src/api/index.ts`：`SignalWatcherView`（`:1040`）加 `probeType` / `scriptPath` / `scriptTimeoutSeconds`；`SignalWatcherInput`（`:1100`）加同三键。

### 步骤 6：Agent 内置工具 2 个

新建 `backend-ts/src/harness/tool/impl/signal-watcher-tools.ts`（含 spec）：

1. **`list_signal_watchers`**：无入参；返回自己名下哨兵数组 `[{ watcher_id, name, probe_type, target, interval_minutes, compare_mode, status, last_changed_at, last_change_old, last_change_new }]`（SCRIPT 的 `target`=scriptPath，HTTP=method+url；敏感头不出现）。走 `watcherService.list(userId)`。
2. **`create_signal_watcher`**：入参 `name`（必填）、`probe_type`（必填枚举）、`script_path`（SCRIPT 必填）、`compare_mode`（SCRIPT 必填，枚举 HASH/JSON_FIELD）、`json_path`（JSON_FIELD 必填）、`interval_minutes`（必填）、`prompt_template`（必填，写明 `{name}` `{url}` `{diff}` 占位符）、`timeout_seconds`（SCRIPT 可选）、`url/method/headers/body`（HTTP 必填项）。`agentId`/`userId` 从当前会话解析（`:91-99` 模式）；SCRIPT 创建前服务端校验脚本文件已存在，不存在返回 errorJson 并提示「请先在工作区写入脚本（如用 edit_file）再创建哨兵」。结果 `{ success, watcher_id, name, probe_type, next_check_note: '…将由调度器按间隔自动执行' }`。
3. `getToolPrompt` 写明适用边界（沿用 create_scheduled_task 的护栏文案风格）：仅响应用户直接表达的哨兵配置需求；创建后长期自动运行，禁止在自身任务执行中擅自创建；提示词模板要求自包含。
4. 注册：`tool-registry.ts` Deps 接口加 `signalWatcherService`；`createDefaultToolRegistry` 内加两个实例；装配点 `app-harness-engine.ts:181-184` 同步传入（harness 引擎依赖输入加 `signalWatcherService`，取自与 `app-openapi-services.ts:153-158` 同源的 WatcherService 实例）。
5. AGENTS.md 既有配套：`desktop/src/utils/toolDisplay.ts` 加两条中文名（`list_signal_watchers: '查询信号哨兵'`、`create_signal_watcher: '创建信号哨兵'`）与参数预览 case；`backend-ts/src/session/util/tool-result-summarizer.ts` 加两个结果摘要 case；`no-progress-notice.ts` 不动（语义 id 判定见 §3.1）。

### 步骤 7：desktop UI

1. `signal-watcher-form.ts`：`SignalWatcherForm` 加 `probeType: SignalProbeType`（默认 `'HTTP'`）、`scriptPath: string`、`scriptTimeoutSeconds: number | null`；导出 `PROBE_TYPE_LABELS`；表单提交组装函数按类型互斥出参。
2. 新建 `desktop/src/views/settings/ScriptPathPickerDialog.vue`：el-dialog 内两级选择——项目列表（`GET /v1/files/workspace-overview` 的 projects 子目录，`workspace-overview.service.ts:78-100`）→ 目录内文件树（`GET /v1/files/workspace-list`，`file.routes.ts`）；仅列文件，双击或「选择」回填相对路径 `<slug>/<path>`。数据面全部复用既有 API，不改后端。
3. `SignalWatchersView.vue` 表单区：
   - 顶部「探针类型」`el-radio-group`（`PROBE_TYPE_LABELS`）；
   - HTTP 区（现有 url/method/headers/body 块）`v-if="form.probeType === 'HTTP'"`；
   - SCRIPT 区 `v-else`：脚本路径 el-input（只读回显 + 「选择脚本」按钮打开对话框 + 支持手输，失焦校验格式）+ 超时秒数 el-input-number（5~300，默认 60）+ 判定模式选项只渲染 HASH/JSON_FIELD；
   - 校验提示文案与 §3.3 值表一致。
4. 列表卡：探针类型徽标（`PROBE_TYPE_LABELS`）；SCRIPT 显示脚本路径替代 URL 行。
5. 「立即测试」结果抽屉：SCRIPT 显示 exit code（`test` 返回新增字段）与 stdout 样例（sample 语义已覆盖）。

### 步骤 8：admin 展示

`admin/src/views/signal/SignalWatcherListView.vue`：加「类型」列（`Record<SignalProbeType,string>` 汉化，70px）；「探测地址」列 SCRIPT 渲染「脚本：`<scriptPath>`」；「方法」列 SCRIPT 渲染「—」。admin API 类型同步（admin 侧哨兵接口类型定义文件加三字段）。

### 步骤 9：测试 + 文档同步

1. **`backend-ts/src/signal/script-probe.spec.ts`**（真实 bash，临时目录）：成功（exit 0 + stdout 断言）；非零退出（error 取 stderr 尾部）；超时击杀（`sleep 300` + 1s 超时，断言 ok=false、error 含「执行超时」、进程组被回收）；stdout 超限（>1MB 判失败）；stderr 8KB 上限；env 注入断言（脚本 `printenv MAO_WATCHER_ID`）；cwd 为脚本目录；stdin 关闭（脚本读 stdin 得 EOF）。
2. **service 分流用例**（`watcher.service.spec.ts` 扩展）：SCRIPT 建基线 → 变化触发（`{diff}` 为 stdout 新旧片段）→ 非零退出计连败 → 5 连败自动停用 + 通知；SCRIPT 互斥校验矩阵（STATUS_CODE 拒绝 / interval<5 拒绝 / 路径含 `..` 拒绝 / 绝对路径拒绝 / 文件不存在拒绝 / 大小超限拒绝）；路径 realpath 逃逸（软链指向 projects 外）拒绝；基线重置（改 scriptPath/probeType 后旧哈希清空）；复制继承 SCRIPT 字段。
3. **工具用例**（`signal-watcher-tools.spec.ts`）：list 脱敏（无 headers）；create 成功 / 缺 script_path / 文件不存在 / 未在会话上下文。
4. **注册同步守卫**：toolDisplay / summarizer 新 case 的单测（既有口径）。
5. **Playwright**：admin 列表类型列；desktop 哨兵表单类型切换渲染（HTTP 区隐藏、脚本区出现）。
6. **文档**：`USER_GUIDE.md` 信号哨兵句扩写（脚本探针一句）；`skills/mao-cli/reference/desktop.md` 信号哨兵节扩写（脚本探针用法：上传/让 Agent 写脚本 → 配置；内置工具提及）；`CHANGELOG.md` 顶部新增 `## 0.0.494 (发布日)` → `### 后端` + `### 前端（桌面 / Web）` + `### 管理后台` 三节；`DEPLOY.md` 补脚本探针运维声明（宿主执行姿态 + 建议 ulimit）。

## 5. 落地清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `backend-ts/db/migration/V189__signal_watcher_script_probe.sql` | 4 列迁移 | **新建** |
| `backend-ts/src/signal/script-probe.ts` + `script-probe.spec.ts` | 脚本执行器 + 单测 | **新建** |
| `backend-ts/src/signal/types.ts` | 接口 4 字段 + `SIGNAL_PROBE_TYPES` + 守卫 | 修改 |
| `backend-ts/src/signal/signal.repository.ts` | 读写列清单加 4 列 | 修改 |
| `backend-ts/src/signal/watcher.service.ts` | runCheck/test 分流、normalizeInput SCRIPT 分支、AFFECTS_BASELINE、toView、WatcherTestResult、路径解析校验 | 修改 |
| `backend-ts/src/signal/watcher.service.spec.ts` 等 | 分流与校验用例 | 修改 |
| `backend-ts/src/signal/watcher.routes.ts`（+spec） | `toInput` 三键透传 | 修改 |
| `shared/contracts/src/signal.ts` | `SignalProbeType` | 修改 |
| `backend-ts/src/harness/tool/impl/signal-watcher-tools.ts` + spec | 2 个内置工具 | **新建** |
| `backend-ts/src/harness/tool/tool-registry.ts` | Deps + 注册 2 工具 | 修改 |
| `backend-ts/src/app-harness-engine.ts` | 装配传入 `signalWatcherService` | 修改 |
| `backend-ts/src/session/util/tool-result-summarizer.ts` | 2 个摘要 case | 修改 |
| `desktop/src/utils/toolDisplay.ts` | 2 个中文名 + 参数预览 | 修改 |
| `desktop/src/api/index.ts` | View/Input 类型 3 字段 | 修改 |
| `desktop/src/views/settings/signal-watcher-form.ts` | 表单模型 3 字段 + `PROBE_TYPE_LABELS` + 互斥出参 | 修改 |
| `desktop/src/views/settings/ScriptPathPickerDialog.vue` | 脚本路径选择对话框 | **新建** |
| `desktop/src/views/settings/SignalWatchersView.vue` | 表单分流 + 列表卡 + 测试结果 | 修改 |
| `admin/src/views/signal/SignalWatcherListView.vue`（+admin api 类型） | 类型列 + 地址列渲染 | 修改 |
| `desktop` / `admin` Playwright spec | 表单切换 + admin 列 | 修改 |
| `USER_GUIDE.md`、`skills/mao-cli/reference/desktop.md`、`CHANGELOG.md`、`DEPLOY.md` | 文档同步 | 修改 |
| 调度器 `watcher-scheduler.ts`、判定 `watcher.logic.ts`、触发 `open-run.service.ts`、清理 `signal-check-cleanup.ts`、加密 `signal-cipher.ts` | **零改动** | — |
| `agent-cli/`、`android/`、数据库外存储 | **零改动** | — |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| R1 服务端执行用户任意脚本（RCE 面 + 内网可达） | 非新执行性质：host 模式云端 Agent shell 本就宿主任意执行（`shell-session-manager.ts:751`）；脚本探针绕过 HTTP 探针的 `assertProbeUrl` 内网禁令（`probe-validate.ts`）属已知扩展，DEPLOY.md 声明「脚本哨兵与 Agent shell 同级：可访问服务器可达的全部网络」，docker 运行模式的隔离声明同步写明差异 |
| R2 失控脚本（死循环/fork 炸弹）挤占 `agentExecutor` 线程池，拖慢定时任务 | 硬超时 300s 上限 + `detached` 进程组 SIGKILL（覆盖子进程树）；stdout 1MB 上限；每哨兵单飞（`inFlight`）使慢脚本下轮自动跳过；DEPLOY.md 建议对 mao-backend 服务配 ulimit（nproc） |
| R3 路径逃逸 / 越权读他人脚本 | 保存与执行双侧校验：格式（非绝对路径、无 `..`）→ `resolve` + `realpathSync` 双重 `isUnder(projectsRoot)`（`path-sandbox.ts:203`）；执行按哨兵属主 userId 解析根，不取会话上下文 |
| R4 脚本执行中被替换/删除 | 「当前内容生效」语义（spawn 时刻 fd 已打开，删除不影响本次执行）；文件缺失 → 探针失败 → 既有连败退避 + 自动停用 + 收件箱通知兜底 |
| R5 stdout 敏感信息进入 LLM 上下文（`{diff}`） | 与 HTTP 探针响应体同等暴露面（既有）；500 字片段截断限制爆炸半径；desktop.md 提示脚本内自行脱敏 |
| R6 后端进程 env 泄露（`APP_SIGNAL_SECRET`/DB 密码） | 白名单构造全新 env（PATH/HOME/TZ/MAO_WATCHER_*），绝不继承全量 env（§3.1） |
| R7 长脚本与 1 分钟间隔重叠 | SCRIPT 间隔下限 5 分钟（校验拒绝更小值）+ 单飞跳过双保险 |
| R8 脚本哨兵创建时脚本尚不存在 | 创建时服务端校验文件存在，错误信息引导先用文件工具写脚本；工具 prompt 同步声明 |
| R9 基线漂移（改脚本路径后旧哈希残留） | `AFFECTS_BASELINE` 加 `probeType`/`scriptPath`，编辑即重置基线（既有机制，`watcher.service.ts:151-152`） |

## 7. 测试要点

1. §4 步骤 9 全部单测/Playwright 通过；`cd backend-ts && npm run build` 与 `npm test` 全绿；desktop `npm run build` / `npm run test:unit` 全绿；admin `npm run build` 全绿。
2. 存量零变化基线：不写 `probe_type`（迁移默认 HTTP）的哨兵，创建/编辑/轮询/触发/复制行为与升级前一致（回归既有 watcher 用例零修改通过）。
3. 脚本哨兵端到端：项目工作区上传 `check.sh`（输出 JSON）→ 创建 SCRIPT 哨兵（JSON_FIELD）→ 「立即测试」显示 exit 0 与样例 → 改脚本输出 → 下一轮自动触发会话，`{diff}` 为新旧 stdout → check 行 `exit_code=0`、`httpStatus` 为空。
4. 失败矩阵：脚本非零退出 ×5 → 自动停用 + 收件箱通知；超时脚本 → 单飞期间不叠加；删除脚本文件 → 失败退避。
5. Agent 对话闭环：会话（绑定项目工作区）让 Agent 写脚本 → `create_signal_watcher` 创建 → UI 列表出现且类型为「Shell 脚本」。
6. 权限矩阵：A 用户无法引用 B 用户项目下的脚本（realpath 属主校验拒绝）。
7. admin 列表类型列与地址列渲染正确。

## 8. 决策记录（调研 §9 四个待拍板项 → 定案）

| 调研待拍板项 | 定案 | 理由 |
|---|---|---|
| 1. host 运行模式是否开放脚本探针 | **统一后端宿主执行，不随运行模式分流**；docker 运行模式容器内执行不做（§2.2 第 2 条） | HTTP 探针同为先例：哨兵探针是服务端基础设施行为；避免维护双执行桥；docker 模式的隔离姿态差异以 DEPLOY.md 声明收口 |
| 2. SCRIPT 判定模式集合 | **仅 HASH / JSON_FIELD**；STATUS_CODE 不开放 | exit code 是成败语义非判定输入；避免「exit code 当状态码比对」的语义混淆 |
| 3. 凭据 env 注入是否进本批次 | **不做**（§2.2 第 1 条）；env 仅 `MAO_WATCHER_ID/NAME` | 脚本可自行读工作区凭据文件；env 泄露面（echo/落日志）需专门设计，不捆绑本批次 |
| 4. 脚本存储根 | **仅项目工作区** `projects/<slug>/`；会话工作区与专用 `sentinels/` 目录不做 | 会话工作区随会话删除被清（`session.service.ts:319`）会静默弄坏哨兵；项目工作区生命周期独立、文件管理器/上传/Agent 写入全部现成 |

## 9. 明确不做的（汇总）

1. 凭据环境变量注入（`{{MAO_TOKEN}}`/`{{ECP_TOKEN}}` 不进脚本 env）
2. docker 运行模式的容器内执行（脚本探针一律后端宿主执行）
3. 脚本内容静态审查 / 命令白名单 / 沙箱化
4. `update_signal_watcher` / `delete_signal_watcher` 内置工具
5. 专用 `sentinels/` 存储目录及其展示面
6. LOCAL / 桌面端执行
7. STATUS_CODE 判定模式对脚本开放
8. CPU/内存配额、并发执行上限等产品化资源治理（仅 DEPLOY.md 运维建议）
9. 后端以外任何端的调度/判定逻辑改动（admin 只加只读展示列）
10. 提示词模板新增占位符（`{name}` `{url}` `{diff}` 三占位符不变，SCRIPT 的 `{url}` 渲染脚本路径）
11. mao-cli CLI 的脚本哨兵创建参数（CLI 继续仅支持 HTTP 哨兵——不传 `probe_type` 默认 HTTP 的行为不变；脚本哨兵走桌面表单或 Agent 内置工具 `create_signal_watcher`）
