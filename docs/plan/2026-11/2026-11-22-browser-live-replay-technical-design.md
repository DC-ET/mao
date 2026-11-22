# 浏览器直播回放（录制 + 回看）技术方案

- 日期：2026-11-22
- 状态：**方案已定稿，未排期实施**；分期见 §9（M1→M4 各期独立可发版）。2026-11-22 可行性评审通过，补充/修正项见 §11。
- 一句话：由直播 sidecar 在采集侧把每场直播的帧序列节流落盘到会话 runtime 目录（CLOUD/LOCAL 同一份代码），后端 / Electron 枢纽按 runtime 目录提供带归属校验的回放 API/IPC，前端在浏览器直播 Tab 内提供"历史场次列表 + 帧级播放器"（时间轴 / 倍速 / 逐帧），使浏览器操作结束后可复盘 agent 的完整操作过程。
- 关联：
  - `docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md`（直播/画中画基础，已落地）
  - `docs/plan/2026-11/2026-11-22-browser-live-side-task-view-technical-design.md`（边路任务直播入口，暂缓）
  - commit `576dcfb2`（直播入口迁至输入框上方）、`7bf470a0`（二次直播修复）
- 决策记录：录制默认策略经评审选定 **管理员后台统一开关**（默认关）；录屏含登录态页面内容，属敏感持久化数据，隐私考量见 §7；清理时效（回放 TTL + 存量 shellOutput/webPages TTL）经评审选定 **后台可调设置**（§3.6）。

## 0. 现状与问题

直播是"只看当下"：直播结束后无法回看任何历史画面。

逐段核实（2026-11-22）：

| 环节 | 现状 | 结论 |
|---|---|---|
| sidecar（事件源） | `browser-live-host.mjs` 磁盘只写 `host.pid`/`host.ready`/`live.json` 三个管理文件；帧只经 emit 推送，不落盘 | 无录制 |
| 后端（CLOUD） | `streaming-ws-handler.ts` 纯转发；帧不进 DB；限流（6fps/突发12）丢弃的帧不落任何地方 | 无录制 |
| Electron 枢纽（LOCAL） | `lastFrames` Map 只存每会话最新一帧，`browser_live_stopped` 即 `delete`；`snapshot()` 仅 `isLive` 时带帧 | 无录制 |
| 前端 store | `sessions[sid].frame` 只保留最新一帧（新帧覆盖）；started 清 frame | 结束后仅存"定格最后一帧" |

结束后的用户可见表现：不刷新页面时 Tab 定格最后一帧 +「已结束」标题；刷新 / 重进后连定格帧都丢失（store 内存态），只剩「等待 Agent 打开浏览器…」占位；同会话再次直播则 started 清帧，上一场彻底不可见。另：browser_live tab 刷新不还原（restore 不重建），打开入口（状态条 chip / pip 双击）均要求任一会话直播中——直播结束 + 刷新后连「进入回放的入口」都不存在（§5.1 必须补可达入口）。

## 1. 总体架构

```
sidecar（browser-live-host.mjs，录制唯一写入点）
  │  Page.startScreencast 帧（变化驱动，≤4fps/页）
  │  ├─ 直播出口（现状不动）：emit → CLOUD WS / LOCAL SSE
  │  └─ 回放出口（新增 tee）：节流 → <runtimeDir>/.mao-browser/replay/<liveId>/
  │        ├─ manifest.json    场摘要（startedAt/endedAt/frameCount/…）
  │        ├─ timeline.ndjson  帧索引（逐行 append：seq/ts/url/w/h/bytes/file）
  │        └─ f<seq>.jpg       帧文件（逐帧独立文件，seek 友好）
  │
  ├─ CLOUD：runtimeDir = 服务器 <MAO_RUNTIME_DIR>/<uid>/<sid>/（sidecar 经 wrapper 按技能目录上跳两级定位，与 .mao-browser 同层）
  │    └─ 回放 API（新增，requireSessionOwner）直接读该目录 → 前端 axios
  └─ LOCAL：runtimeDir = 桌面 ~/.mao/runtime/<hostKey>/<sid>/
       └─ 回放 IPC（新增，Electron hub fs 直读）→ 前端 electronAPI
```

设计要点：

- **录制唯一写入点在 sidecar**：它是唯一始终见得到每帧的进程（后端限流会丢观看帧、枢纽只留最新帧），且 CLOUD/LOCAL 共用同一份脚本——录制逻辑写一次两端生效，不新增传输带宽。
- **runtime 目录即数据源，零 DB 迁移**：与 `compaction/`、`webPages/`、`shellOutput/` 同一惯例；场次列表靠扫 `<replay>/*/manifest.json`，清理靠 mtime。
- **与直播解耦**：录制帧来自 screencast 源头的 tee（emitFrame 处），不受观看侧限流丢帧影响；录制开启时 sidecar 自持一个 consumer 槽，无人观看也持续采帧（§3.3）。注意录制侧另有全局 1fps 节流（§3.4）——回放是实时流的降采样而非超集，对复盘离散操作足够。

## 2. 现状代码链路（设计依据，2026-11-22 核实）

### 2.1 采集端（`skills/bundled/browser-use/scripts/browser-live-host.mjs`）

- `syncScreencast()` L275-287：`Page.startScreencast { format:'jpeg', quality:60, maxWidth:1280, maxHeight:720 }`，硬编码；**按消费者开关**：`consumers > 0` 才 start，归零 `Page.stopScreencast`（L266-295）——无人观看时根本没有帧可录（§3.3 必须解决）。
- 帧节奏（L191-204）：CDP 变化驱动，静止不出帧；逐帧 ack 硬性要求；页面级 `PAGE_MIN_INTERVAL_MS=250`（≤4fps/页，L42-46/L201）；`MAX_FRAME_B64≈512KB` 超限丢帧仍 ack。
- `emitFrame` L298-305：`{ seq: ++seq, ts: Date.now(), jpeg, width, height, pageUrl, cliSession }`；`seq` 进程级计数器；`emitStopped` 已复位 started 闩锁（7bf470a0）——started/stopped 天然是"场"边界，与前端 store 场次粒度一致。
- 生命周期：`MAX_LIFETIME_MS=2h` 硬上限；崩溃恢复保留 `cdp/*.port` 新实例接管（L80-90）。

### 2.2 runtime 目录（录制落位）

- 后端：`runtime-data-resolver.ts:22-24` `resolveSessionRuntimeDir = <runtimeRoot>/<uid>/<sid>`（runtimeRoot 默认 `/opt/mao-data/runtime`，env `MAO_RUNTIME_DIR`）。会话目录下已有 `.mao-browser/`（sidecar 自建，含 `cdp/ config/ logs/ live.json`）、`skills/ shellOutput/ compaction/ webPages/ incoming/`。
- 删除级联（CLOUD）：`app-utils.ts:49-82 runtimeSessionCleanup` 按 `<runtimeRoot>/*/<sid>` 递归删，会话删除时触发——**回放目录放会话 runtime 下免费获得级联清理**。
- 桌面（LOCAL）：`localRuntimePaths.cjs:11-15` `~/.mao/runtime/<hostKey>/<sid>/`；Electron hub 已注入 `resolveSessionRuntimeDir`（main.cjs:126-131），读回放目录零新增路径推导。

### 2.3 后端基建

- **清理调度**：自研 `setInterval` 调度器（非 NestJS），统一在 `app-lifecycle.ts` 启动；模板 `runtime-cleanup-scheduler.ts`（每日、按 mtime 过期删 `shellOutput`/`webPages`，跳过活跃会话）。**现网无任何容量配额/du 审计**——回放的容量约束必须自建（§3.4）。
- **配置**：`system_setting` 表 + `settings.repository.ts` + admin 设置卡（`integrationFieldCatalog.ts`）；env 一次性 bootstrap 导入（`settings-bootstrap.ts`）。
- **鉴权**：函数式守卫 `requireUserId`/`requirePermission`（`common/http-error.ts`）；会话归属校验模式 `session.userId !== userId → FORBIDDEN`（`session.routes.ts:177-183 requireSessionOwner`、`file.routes.ts:863-867 requireFileOwner`）。
- **文件服务**：`/uploads/` 静态挂载（`app-utils.ts:96-113`）**无鉴权**，不适合会话私有的回放帧；带归属校验的参照 `GET /v1/files/:id/preview`（查库 → `requireFileOwner` → inline 流式）。逐帧小文件直接 `reply.type('image/jpeg').send(buffer)` 即可，无需 Range。
- **env 注入链**（录制开关下发）：容器模式 `session-envelope-builder.ts`（构建 envelope：maoToken/maoBaseUrl/sessionId/runtimeDir/envVars，L58-114）→ 容器内消费；LOCAL 桌面 tool-exec 注入（wrapper `browser_cli.mjs:156` 注释证实桌面 shell 会注入 `MAO_BASE_URL/MAO_TOKEN`）。**录制开关与 `MAO_TOKEN`/`MAO_BASE_URL` 同链路注入 `MAO_BROWSER_LIVE_RECORD`**；注意桌面端普通用户无 `settings:read` 权限、不能直读 admin 设置——桌面侧取值经 readiness 下发，见 §3.1。
- 帧转发限流：`ws-rate-limiter.ts` 令牌桶 `WsRateLimiter(6,12)`，`streaming-ws-handler.ts:805` 丢弃即无。录制在 sidecar 侧不受转发限流影响；但录制另有 1fps 节流（§3.4），回放是实时所见流的降采样（非超集）。

### 2.4 前端（`desktop/src`）

- `BrowserLiveView.vue`：canvas + `drawFrame`（L114-136，三重去重：`lastDrawnFrame` 为 base64 内容比较——回放按索引 seek 需绕过，见 §6.3）；`sessionId` prop 可选、缺省跟随 `store.activeSessionId`；头部为直播专属（停止/还原按钮），回放需换控制条。
- Tab 惯例：新增 tab 类型需改 4 文件（`types/file-browser.ts:35` 联合、`useCenterTabs.ts` open 函数、`CenterTabBar.vue:40` 图标、`CenterTabContainer.vue` 分支）；browser_live tab 刷新后不还原（内存 Map）。**本方案不新增 tab 类型**（§6.1）。
- 自绘时间轴参考：`RunTraceTimeBand.vue`（SVG viewBox 泳道 + hover tooltip + click 定位）；无 ElSlider 使用先例（可引入，低风险）。
- 数据通道范式：renderer 拿 bytes → 组件内消费（`MediaPlayer.vue` Blob URL 纪律）；API 层为单文件扁平函数（`api/index.ts`）；LOCAL/CLOUD 双路分流先例：`useWorkspaceFileProvider` 按 executionMode 选路。
- Electron 读本机文件：`local-read-bytes` IPC 绝对路径直通（IPC 在 `localFileIpc.cjs:251-258`，经 `localRuntimePaths.cjs:45-58` resolveWorkspacePath 原样放行），但无任意目录枚举 IPC（list-directory 有 workspace containment，`localFileIpc.cjs:374`）→ 回放走 hub 专用 IPC（§7）。

## 3. 录制（M1：sidecar）

### 3.1 开关：管理员后台统一控制（评审决策）

- `system_setting` 新增键 `browserLive.recordEnabled`（`0/1`，**默认 0 关**；键名对齐既有 dot 分组惯例，总表见 §3.6）：迁移 SQL 种子行 + admin 设置卡（`IntegrationConfigPanel` 同区新增开关项）+ settings 路由复用 `settings:read/write`。
- 下发链路：shell 执行 env 注入 `MAO_BROWSER_LIVE_RECORD=1`（仅开启时注入），两条注入路径：
  - **CLOUD 容器**：`session-envelope-builder.ts` 构建 envelope 时读 `settings.repository` 追加 envVar（与 maoToken/maoBaseUrl 同对象，L58-114）。
  - **LOCAL 桌面**：`settings:read` 是权限码，桌面普通用户**不能**直读 admin 设置——开关值经 `GET /v1/readiness` 下发（仅登录即可读，部署级配置先例 `readiness.routes.ts:13-17`；desktop `stores/readiness.ts` 已消费该接口），desktop `buildShellEnv()`（`main.cjs:202-230`，已注入 `MAO_TOKEN`/`MAO_BASE_URL`/`MAO_BROWSER_LIVE_MODE`）据此追加 `MAO_BROWSER_LIVE_RECORD`。desktop 侧缓存随登录 / readiness 刷新更新（开关低频，容忍滞后）。
- sidecar 启动时读 `process.env.MAO_BROWSER_LIVE_RECORD === '1'` 决定是否进入录制模式；**未注入 = 不录**。开关变更对新会话生效（envelope 是会话级）；对进行中的 sidecar 不热切换（可接受，开关属低频管理操作）。
- 语义：开关只控制"是否录"，不控制"是否直播"——直播本身无开关，关闭录制后行为与现状完全一致。

### 3.2 场目录与文件格式

```
<runtimeDir>/.mao-browser/replay/<liveId>/
  manifest.json   // 场摘要：{ version, liveId, sessionId, startedAt, endedAt?, frameCount,
                  //            durationMs?, approxBytes, cliSessions[], urls[], truncated? }
  timeline.ndjson // 每行一帧：{ seq, ts, pageUrl, width, height, bytes, file:"f<seq>.jpg" }
  f<seq>.jpg      // 原始 JPEG（quality60、≤1280×720，与直播帧同一编码，不再二次压缩）
```

- `liveId = L<startedAt 毫秒时间戳>`（会话内唯一：sidecar 进程内 started 不并发——单进程顺序 emit；崩溃接管场景新进程重新 started，时间戳不同）。
- 逐帧独立文件而非单 blob：seek 只拉需要的帧（回放打开不下载全场）、HTTP/IPC 缓存友好、写路径无需偏移管理。
- `timeline.ndjson` 逐行 append（保持文件句柄、每帧一次 `appendFileSync`——≤4fps 的量级下同步写无压力；崩溃最多丢尾部半行，读取端按 JSON 行容错跳过）。
- `manifest.json`：started 时写初始版（endedAt 置 null），stopped 时补齐结算字段；**未结算的场**（`exitSoon` 本身不发 stopped：`timeout_2h`、`runner_exit`、硬崩溃等路径，sidecar L448/L411 已核实；`no_cdp_ever` 无帧不成场，无影响）：manifest 保持 `endedAt:null`，读取端以最后一帧 ts 兜底显示（§4.1 列表含未结算场）。

### 3.3 采集耦合：录制自持 consumer 槽

- 现状 `consumers > 0` 才 startScreencast。录制开启时，录制器向 `addConsumer()` 注册一个**常驻槽**（随 sidecar 进程存活），保证零观众时画面照采；有真实观众时消费者计数 ≥2，行为不变。
- 与现状的交互：录制关闭时完全不注册（与现状零差异）；`PAGE_MIN_INTERVAL_MS` 限速对录制与直播共用（同一 emit 流），录制帧率上限 = 直播帧率上限 ≤4fps/页。

### 3.4 容量控制（现网无配额基建，必须自建三道闸）

| 闸门 | 默认值 | 机制 |
|---|---|---|
| 录制节流 | **≥1000ms/帧** | 录制 tee 在 `PAGE_MIN_INTERVAL_MS` 限速之后再节流一层：距上一录帧 <1s 的帧只直播不落盘（**全局口径**，跨页共享 1fps，不按页）。复盘 agent 离散操作 1fps 足够；估算 60KB/帧 → **≈216MB/小时上限，实际远低（静止无帧）** |
| 单场上限 | **300MB**（env `MAO_BROWSER_LIVE_RECORD_MAX_MB` 可调） | 累计 bytes 超限时停止本场录制（emit `truncated:true` 进 manifest），直播不受影响 |
| 过期清理 | **TTL 7 天**（设置键 `harness.cleanup.browserReplayTtlDays`，后台可调、改值即生效，§3.6） | 新增清理步骤挂入 `RuntimeCleanupScheduler`（仿其 mtime 模式）：扫 `<runtimeRoot>/*/*/.mao-browser/replay/*`，mtime 超期删整场目录；活跃会话跳过逻辑复用 `hasExecutionClaim` |

- 每用户总配额：v1 不做（TTL + 单场上限已封顶单用户增量 ≈ 300MB/场 × TTL 留存（后台可调，上限 365 天，§3.6）；如需再上 per-user du 配额，另行提案）。
- 会话删除级联（CLOUD）免费覆盖；LOCAL 桌面残留由 TTL 之外的会话删除逻辑兜底（桌面本地 runtime 清理现状即不完整，不因回放劣化，文档不展开）。
- 落地细节：现状 `RuntimeCleanupScheduler` 的 mtime 文件清理**不做**活跃会话跳过（`isSessionActive` 仅作用于 skills 目录清理，`runtime-cleanup-scheduler.ts:36-37/100`）——回放 TTL 步骤需自行接入活跃跳过（注入先例 `app-lifecycle.ts:131-140`，判定复用 `hasExecutionClaim`）；扫描枚举 uid/sid 一级目录沿用 `runtimeSessionCleanup` 的纯数字目录惯例（`app-utils.ts:55-62`），防误删非数字目录。

### 3.5 sidecar 内部结构（新增 Recorder，与直播出口解耦）

- **模块拆分**：录制器独立成 `browser-live-recorder.mjs`（与 host 脚本同目录、同样零依赖）——`browser-live-host.mjs` import 即有副作用（顶部 mkdir、起 SSE server / WS client、fs.watch、退出定时器，L48/L445-451），不可被测试直载；录制器单独成文件才满足 §8 的 node:test 直载，host 脚本 import 使用。
- `Recorder` 接口：`onStarted(meta)` 开场（mkdir + manifest 初始版）、`onFrame(frame)` 节流判定 + 写 `f<seq>.jpg` + append timeline、`onStopped(reason)` 结算 manifest。挂载点：`emitFrame`/`emitStopped` 处同步调用（try/catch 包裹，**录制故障绝不影响直播**——写失败仅记 host.log 并停录本场）。
- 场边界容错：`emitStopped` 可在零帧 / 未 started 时触发（`killBrowserEntry` 对从未出帧的浏览器也发 stopped），`onStopped` 须容忍无进行中场；多 cliSession 下 stopped/started 按全局闩锁切分（与直播前端语义一致）。CLOUD WS 瞬断重连成功会复位闩锁并补发 started（L389-394）——长直播中一次重连会把场一分为二（新场新目录），语义与前端一致，可接受。录制 consumer 槽在进程启动时一次性注册、生命周期=进程，与观看 sink 的 add/remove 互不影响。
- 录制与 `startedEmitted` 闩锁解耦：每场独立目录；`emitStopped` 复位闩锁后下一场自然开新目录（7bf470a0 已保证二次直播有 started）。
- 不改变任何直播语义：emit 出口、ack、限速、cliSession 生命周期全部不动。

### 3.6 清理时效后台化（2026-11-22 评审决策：回放 TTL 与存量 shellOutput/webPages TTL 一并支持后台配置）

设置键总览（键名对齐既有 dot 分组惯例——settings-bootstrap 现有 38 键均为此风格；原 §3.1 提法 `browser_live_record_enabled` 规整为 `browserLive.recordEnabled`）：

| 设置键 | 卡片控件 | 默认 | 语义 |
|---|---|---|---|
| `browserLive.recordEnabled` | switch | 0 | 录制开关（§3.1） |
| `harness.cleanup.browserReplayTtlDays` | number（min 0 / max 365） | 7 | 回放场目录保留天数；**0 = 关闭回放 TTL 清理**（仍随会话删除级联） |
| `harness.cleanup.shellOutputMaxAgeDays` | number（min 0 / max 365） | 7 | shellOutput 与 webPages 清理天数（现状代码即同周期共用一值，v1 不拆键）；**0 = 不清理**（沿用调度器现状 `<=0` 语义） |

- **动态生效机制（关键改造）**：`RuntimeCleanupScheduler` 现状构造注入 `properties` 定格（`app-lifecycle.ts:131`；默认值 `app-config.ts:269`、env 覆盖 `:465`）。改为注入 **TTL resolver**（`resolveTtls(): Promise<{ shellOutputMaxAgeDays, browserReplayTtlDays }>`），每轮 `runCleanupSafely` 开始时现读两个键（一轮一次批量 DB 读，开销可忽略），读取失败回退启动默认值；`intervalMs` 保持启动注入不变。**改值后下一轮清理即生效，无需重启**。
- **env 平滑迁移**：`settings-bootstrap` 追加两条映射（`harness.cleanup.browserReplayTtlDays` ← `MAO_CLEANUP_BROWSER_REPLAY_DAYS`、`harness.cleanup.shellOutputMaxAgeDays` ← 存量 `MAO_CLEANUP_SHELL_MAX_AGE_DAYS`）。**迁移对两个 TTL 键不种值**——种值会使 bootstrap「仅 NULL 时导入」永不触发、存量部署的 env 失效；未设置时读取端取内置默认 7。`browserLive.recordEnabled` 无对应 env、迁移种 '0' 显式默认关。
- **admin 设置卡**：`IntegrationConfigPanel` 新增分组三字段——`IntegrationFieldSpec` 已原生支持 switch / number+min/max/hint（先例 `notify.*`、`harness.compaction.*`），hint 标注「保存后即时生效（下一轮清理现读）」；写入走通用 `PUT /v1/system-settings/batch`（`settings:write`），**零新增路由**。
- **防误配**：admin 卡片 min/max 前端校验 + 后端读取端钳制（非法/负数 → 默认 7，>365 → 365）双保险。

## 4. 回放数据读取

### 4.1 CLOUD API（M2，`backend-ts/src/browser-replay/` 新域）

按域惯例建 `browser-replay.routes.ts` + `browser-replay.service.ts`（无 repository——数据源是文件系统；如需目录扫描复用可提私有函数）：

| 端点 | 返回 | 说明 |
|---|---|---|
| `GET /v1/sessions/:sid/browser-live/replays` | `Result<ReplaySummary[]>` | 扫 `<runtimeDir>/<uid>/<sid>/.mao-browser/replay/*/manifest.json`，按 startedAt 倒序；Summary = manifest 摘要（liveId/startedAt/endedAt/frameCount/durationMs/approxBytes/truncated） |
| `GET /v1/sessions/:sid/browser-live/replays/:liveId/timeline` | `Result<{ manifest, frames: FrameMeta[] }>` | manifest + timeline.ndjson 全量（1fps×2h ≤7200 行，内存安全） |
| `GET /v1/sessions/:sid/browser-live/replays/:liveId/frames/:seq` | `image/jpeg`（inline） | 读 `f<seq>.jpg`；Content-Type + Cache-Control `private, max-age=86400`（帧不可变） |

- 鉴权：每个端点先 `requireUserId`，再校验 session 归属（复用 `requireSessionOwner` 模式）+ `liveId/seq` 严格白名单校验（`/^L\d+$/`、纯数字；路径拼接前防目录穿越——`path.resolve` 后断言在 replay 目录内，仿 `assertInside` 惯例）。
- 契约类型（`ReplaySummary`/`FrameMeta`）下沉 `@mao/contracts`（新增 `browser-replay.ts`），前后端共用。
- 场次列表：**包含 `endedAt:null` 的未结算场**（标注「未结束」，endedAt 以 timeline 最后一帧 ts 兜底——timeline 读取本就全量解析、按行容错）。理由：未结算并非罕见崩溃——`exitSoon` 本身不发 stopped，`timeout_2h`（2h 硬上限）、`runner_exit`（WS 重试 3 次失败退进程）及硬崩溃都直接退出（sidecar L448/L411 已核实）；若只列已结算场，这些场永久不可见，§3.2 的兜底承诺落空。直播进行中的场同样出现（v1 不区分「录制中/中断」，统一展示「未结束」）；`timeline`/`frames` 端点对未结算场照常可用（帧文件写后不可变、manifest 原子 rename，读已落盘部分安全）。

### 4.2 LOCAL IPC（M4，Electron hub）

- `browserLive.cjs`（已持 `resolveSessionRuntimeDir`）新增 IPC：`browser-live-replay-list` / `browser-live-replay-timeline` / `browser-live-replay-frame`，主进程 fs 直读本机 runtime 目录（与现有 `browser-live-get-state` 同注册模式）；preload 暴露 `electronAPI.browserLive.replayList/timeline/frame`。
- 同样的 liveId/seq 白名单 + 路径断言（LOCAL 会话 id 来自 renderer 传入，必须防穿越）。
- 前端分流：按 `executionMode`（CLOUD→axios API；LOCAL→electronAPI）双 provider，仿 `useWorkspaceFileProvider` 模式。

## 5. 回放 UI（M3，复用浏览器直播 Tab）

### 5.1 入口：直播 Tab 内回放模式（不新增 tab 类型）

- `browser_live` Tab（`BrowserLiveView` variant=tab）在**非直播态**（占位层：已结束 / 等待）增加「历史回放」入口按钮 → 列出该会话已结算场次（时间、时长、帧数、截断标记）→ 点选进入回放模式。
- 播放中若该会话重新开始直播：Tab 顶部提示并可一键切回实时（回放模式不自动退出，避免打断复盘；实时帧不写回放 canvas）。
- 画中画（pip）不加回放入口（小窗场景不合适）；Tab 内"还原为画中画"按钮在回放模式下隐藏。

- **刷新 / 重进后的可达性（必须补，否则回放不可达）**：browser_live tab 刷新不还原（`restoreActiveTab` 只在既有 tabs 中查找、不重建）；打开 tab 的仅有两个入口——输入框上方状态条 chip（`ChatPanel.vue:178-188` 与 `SideChatPanel.vue:116-118` 两处，条件 `hasAnyLive` 任一会话直播中）与 pip 双击放大——都要求正在直播。直播结束 + 刷新 / 关 Tab 后，回放 UI 无任何到达路径。补法：chip 条件扩展为「直播中 **或** 当前会话存在回放场次」（会话激活时惰性拉取回放列表、按会话缓存，`browser_live_started/stopped` 事件失效重取；LOCAL 的可达性随 M4 IPC 就绪）；无直播时点击 chip 直接 `openBrowserLiveTab()` 并落在回放列表模式。
- **回放模式锁定会话**：`BrowserLiveView` 缺省跟随 `store.activeSessionId`（`CenterTabContainer` 渲染 tab 时不传 sessionId）——进入回放后锁定该场次所属会话，切会话不漂移，退出回放恢复跟随。

### 5.2 播放器交互

- **时间轴**：自绘 SVG 密度带（参考 `RunTraceTimeBand.vue`）——按帧间隔画泳道密度（活跃段浓、静止段稀），hover 显示时间点 + pageUrl，click/drag 定位；底部数字时间显示。
- **控制条**：播放/暂停、倍速 1x/2x/4x（按帧间 ts 差推进）、上一帧/下一帧步进、跳到开头/结尾。
- **渲染**：复用 canvas + `drawFrame`（Image 异步加载 + pendingImage 单飞防乱序）。两处适配：
  1. `lastDrawnFrame` 是 base64 内容比较——内容相同的相邻帧（如重复点击同位置）会被去重跳过；回放改为**按帧索引驱动**（seek/step 直接指定目标 seq，绘制完成回调用索引对账，索引落后才补画）。
  2. 帧懒加载：按播放头预取前后各 2 帧（`frameCache: Map<seq, jpeg>`，LRU 上限 ~50 帧），倍速播放时靠预取平滑。
- **移动端**：同一组件自适应；时间轴保留、控制条精简（隐藏步进按钮）。

## 6. 契约与类型

- `@mao/contracts/src/browser-replay.ts`（新增）：`ReplaySummary`、`ReplayFrameMeta`、`ReplayTimeline`（manifest + frames）。
- 前端 api 层不内联手写联合（AGENTS 规范）；无跨端枚举新增（reason 复用现有 `STOP_REASON_TEXT` 语义，不进契约）。

## 7. 隐私与安全

- **录屏含登录态页面内容**（邮箱、后台、令牌等）：这是管理员开关默认关的决策依据；admin 设置卡文案需明示"录制内容含页面敏感信息，按 TTL 自动清理"。
- 帧文件权限：sidecar 写文件沿用 runtime 目录默认权限（0o644/目录 0o755，与 `.mao-browser/live.json` 0o600 不同——帧非凭据；如需收紧可 0o600，默认不做）。
- API 归属校验强制（§4.1）；不提供任何"跨会话/跨用户列举回放"的接口；admin 后台 v1 不做回放浏览（避免集中泄露面）。
- 帧不可变（录后不改），Cache-Control private；timeline/manifest 含 URL 明文（pageUrl 同直播现状可见，不额外脱敏；如需脱敏另行提案）。

## 8. 测试与验收

- **M1 sidecar**：node:test 直载录制器（模拟 started/frame/stopped 序列 + 崩溃未结算 + 节流 + 上限截断），临时目录断言文件布局；真机 smoke：CLOUD 跑一场浏览器操作后检查服务器 `.mao-browser/replay/` 结构。
- **M2 API**：Vitest routes/service spec（临时 runtime 目录 + 归属校验用例：他人会话 403、目录穿越 400、`liveId/seq` 白名单）；清理调度 spec（mtime 过期删除、活跃会话跳过、TTL 设置现读：改值下轮生效 / 0 跳过该类清理 / 非法值钳制回退默认）。
- **M3 UI**：store/播放器逻辑单测（时间轴几何、预取、索引驱动绘制）；Playwright 手动验收（真浏览器录制链路难自动化）。
- **手动验收清单**：开 admin 开关 → 会话跑浏览器操作 → 直播中行为与现状一致 → 结束后 Tab「历史回放」出现场次 → 播放/倍速/seek 正常 → 关 admin 开关 → 新会话不产生 replay 目录 → 会话删除后服务器目录级联清空。
- 每期发版走既有流程（backend 部署 / desktop 发版；无安卓原生改动）。

## 9. 分期与改动清单

| 期 | 内容 | 主要文件 |
|---|---|---|
| M1 | sidecar 录制器（拆独立模块，§3.5）+ env 开关消费 + 自持 consumer 槽 + 单场上限 | `skills/bundled/browser-use/scripts/browser-live-host.mjs`、新增同目录 `browser-live-recorder.mjs`；（开关注入）`session-envelope-builder.ts`、`readiness.service.ts`、desktop `main.cjs` buildShellEnv |
| M2 | admin 开关 + 清理时效后台化（迁移种子 + 设置卡）+ CLOUD 回放 API + TTL 清理 | `db/migration/V202__browser_live_replay_and_cleanup_settings.sql`、`settings-bootstrap.ts`、admin `views/settings/components/`、新域 `src/browser-replay/`、`runtime-cleanup-scheduler.ts`（TTL resolver 现读）、`app-lifecycle.ts` |
| M3 | 回放 UI（场次列表 + 播放器 + 时间轴） | `BrowserLiveView.vue`（或拆 `BrowserLiveReplay.vue`）、`api/index.ts`、`@mao/contracts/src/browser-replay.ts` |
| M4 | LOCAL 回放 IPC + 前端双路分流 | `electron/browserLive.cjs`、`electron/main.cjs`、`electron/preload.cjs`、`types/electron.d.ts`、前端 provider |

- M1/M2 之间有依赖（无录制则 API 永远空列表，但可先发不报错）；M3 依赖 M2；M4 独立于 M3 之后。
- 每期各自补 `changelog/unreleased/` 条目（后端 / 前端 / 桌面 Electron 分节）。

## 10. 备选与未采纳项（记录备查）

- **后端 WS 转发处 tee 录制**：放弃——LOCAL 帧不走后端（需桌面 hub 另写一套录制），且后端 tee 内存/IO 压力大于 sidecar 直写；sidecar 单点录制两端统一。
- **帧转视频（ffmpeg/webm）**：放弃——引入重型依赖，CDP screencast 帧流天然适合帧序列；后续若需导出分享可再加转码（另行提案）。
- **对象存储（COS/OBS/OSS）存回放**：放弃——CLOUD 场景服务器本地盘即中心存储（API 直读），对象存储增加成本/延迟；仅当未来需要跨机部署共享存储时再议。
- **DB 表管理场次元数据**：放弃——runtime 目录即数据源（compaction/webPages 同惯例），免迁移、删除级联免费；代价是无法跨会话全局列举回放（可接受，入口在会话内）。

## 11. 评审补充记录（2026-11-22 可行性评审）

结论：需求可行（复盘离散操作 1fps 采样足够、容量三道闸封顶、隐私有开关闸门）；方案可行，引用的代码事实逐条核实基本属实（sidecar 机制、runtime 目录、清理调度器、env 注入链、IPC、迁移编号 V202）。评审发现并已补进正文：

1. **未结算场可见性（§3.2/§4.1，重要）**：原「只列已结算场」使 `timeout_2h` / `runner_exit` / 硬崩溃退出的场（`exitSoon` 不发 stopped，路径常见而非罕见）永久不可见，与 §3.2 兜底承诺矛盾——改为列表含 `endedAt:null` 场、以最后一帧 ts 兜底。
2. **回放入口可达性（§5.1，重要）**：tab 刷新不还原、chip/pip 双击入口均要求直播中——直播结束 + 刷新后回放不可达；补 chip 条件扩展（直播中或当前会话有回放）与回放模式锁定会话。
3. **LOCAL 开关取值通道（§3.1）**：`settings:read` 是权限码，桌面普通用户读不了 admin 设置；改经 `/v1/readiness`（仅登录，已有部署级配置先例）下发，`buildShellEnv` 注入。
4. **录制器可测性（§3.5/§9）**：host 脚本 import 有副作用不可直载测试，录制器拆独立 `browser-live-recorder.mjs`。
5. **表述修正（§1/§2.3）**：「回放 ⊇ 实时所见」不准确——录制侧 1fps 节流后回放是实时流的降采样；准确说法是录制不依赖观看者在线、不受转发限流丢帧影响。
6. **引用与细节修正（§2.4/§3.4/§3.2/§3.5）**：`local-read-bytes` IPC 实际在 `localFileIpc.cjs:251-258`；mtime 清理现状不做活跃跳过（需自行接入）+ 纯数字目录枚举惯例；录制节流为全局口径；补场边界容错（零帧 stopped、WS 重连拆场）。
7. **清理时效后台化（§3.6，2026-11-22 决策）**：回放 TTL 与存量 shellOutput/webPages 清理时效一并提为后台设置（原方案均为 env 启动定格）；`RuntimeCleanupScheduler` 改每轮现读 TTL resolver、env 经 settings-bootstrap 平滑迁移（TTL 键迁移不种值）；顺带将 §3.1 开关键名规整为 dot 分组惯例（`browserLive.recordEnabled`）、决策记录隐私引用 §8→§7。

## 12. 回归测试暴露并修复（2026-11-22 全量回归）

8. **chip 惰性探测的 TDZ 崩整页（§5.1，P0 级，全量回归抓出）**：`showBrowserLiveChip` 与「会话切换 / 直播翻转重探可用性」的 `watch(..., { immediate: true })` 最初写在依赖声明之前——`ChatPanel.vue` 里 `sessionId` 由 `useChat()` 解构产出（在 watch 之后约 40 行），`SideChatPanel.vue` 里 `realSessionId`/`hasRealSession`/`parentExecutionMode` 同理。immediate watch 在 setup 阶段立即求值 → `ReferenceError: Cannot access 'sessionId' before initialization`，Vue app 挂载失败、桌面端整页白屏。**该错误 vue-tsc 与 vite build 均不报**（闭包内前向引用合法、构建不执行代码）、单元测试也全绿，只有真实运行才炸；E2E 里表现为 49 个「登录后 app 壳」用例全挂，而登录页自身用例全过——排查时容易误判为环境 / 资源问题。修法：两块移到 `useChat()` 解构（及 `realSessionId`/`parentExecutionMode` 声明）之后；并新增 `desktop/src/components/chat/browser-live-chip-order.test.ts` 做声明顺序断言（变异验证：改回原顺序即报红）。**教训**：`immediate: true` 的 watch 等于在 setup 顶部执行代码，其依赖必须已声明；这类不变量在 node 环境的桌面 vitest 里只能靠源码顺序断言守住。
