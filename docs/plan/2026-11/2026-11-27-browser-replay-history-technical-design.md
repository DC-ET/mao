# 浏览器录制历史（跨会话入口 + 回放）技术方案

- 日期：2026-11-27
- 状态：**已评审（2026-11-27 对照代码核对，补充见 §13），待排期实施**（本文档只定方案，不含代码改动）
- 一句话：在**管理后台**新增全局跨用户的「浏览器回放」列表，在**桌面/Web/安卓客户端设置页**新增本人的「浏览器回放」列表；两处都复用现有 runtime 目录里的 `replay/` 录制文件与帧级播放器，不新增存储、不新增数据库表（MVP）。
- 关联：
  - `docs/plan/2026-11/2026-11-22-browser-live-replay-technical-design.md`（V202 录制 + 单会话回看，已落地）
  - `docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md`（直播/画中画基础，已落地）
  - 未发布修复 `changelog/unreleased/2026-11-27-browser-live-record-host.md`（host 模式录制开关下发；**本方案的前置条件**，否则不会有任何录制文件）
  - 未发布修复 `changelog/unreleased/2026-11-27-browser-live-refresh-resync.md`（刷新后直播状态重放；与本方案无直接依赖，但同属直播体验收敛）
- 决策记录（2026-11-27 评审确认）：
  1. 管理端做**全局跨用户列表**；
  2. 客户端**包含 LOCAL 录制**（Electron 本机读取，Web/安卓仅 CLOUD）；
  3. 管理端**复用 `session:read` 权限**，不新增权限码。

## 0. 现状与问题

### 0.1 已有能力

| 环节 | 现状 | 代码位置 |
|---|---|---|
| 录制 | sidecar 采集侧按 `MAO_BROWSER_LIVE_RECORD=1` 落盘：`<runtime>/<uid>/<sid>/.mao-browser/replay/<liveId>/{manifest.json,timeline.ndjson,f<seq>.jpg}` | `skills/bundled/browser-use/scripts/browser-live-host.mjs`、`skills/bundled/browser-use/scripts/browser-live-recorder.mjs` |
| 存储定位 | runtime 根默认 `/opt/mao-data/runtime`（`MAO_RUNTIME_DIR`）；LOCAL 为 `~/.mao/runtime/<hostKey>/<sid>` | `backend-ts/src/config/app-config.ts:254`、`desktop/electron/localRuntimePaths.cjs:11-15` |
| 回放读取（单会话） | CLOUD：Owner API；LOCAL：Electron 主进程 fs 直读 IPC | `backend-ts/src/browser-replay/browser-replay.routes.ts`、`browser-replay.service.ts`、`desktop/electron/browserLive.cjs` |
| 前端播放 | 直播 Tab 内「历史回放」：场次列表 + 时间轴 / 倍速 / 逐帧 | `desktop/src/components/browser/BrowserLiveReplay.vue`、`desktop/src/utils/replayPlayer.ts` |
| 清理 | `RuntimeCleanupScheduler` 按 `browserReplayTtlDays` 扫盘删除；会话删除级联删除 | `backend-ts/src/harness/runtime/runtime-cleanup-scheduler.ts:134-138` |

### 0.2 缺口

1. **没有跨会话入口**：现有回放只能从「某个会话 → 输入框上方『浏览器』状态条 → 直播 Tab → 历史回放」进入；用户想找“上周某次浏览器操作”必须记得会话并逐个翻。
2. **管理后台完全没有回放入口**：只有「系统设置 → 浏览器直播」的录制开关与保留天数；管理员无法核查某条录制内容（合规/排障诉求）。
3. **管理端没有跨用户读取能力**：现有回放 API 全部是 owner 校验（`session.userId !== userId → FORBIDDEN`），管理员调用会被拒。
4. **LOCAL 录制天然不可跨端**：写在用户设备 `~/.mao/runtime`，服务端看不到；只能在执行设备上读。

### 0.3 不可回避的约束

- **敏感数据**：回放含登录态页面（后台、令牌、邮箱等），管理端跨用户查看属于高敏行为，必须留痕（复用 `session:read` 是本次评审确认的取舍，见 §3 D1）。
- **数据即文件**：V202 明确“runtime 目录即数据源，零 DB 迁移”；本方案保持该口径，不引入第二份元数据。
- **清理是异步的**：TTL 清理按清理周期删除目录；列表读到“即将过期”的场次属正常现象，播放帧缺失按已有 404 兜底。

## 1. 目标与非目标

### 1.1 目标

- 管理后台新增 `/browser-replays`：跨用户列出全部 CLOUD 录制，支持按用户/Agent/时间/会话标题筛选，点开即可播放。
- 客户端设置页新增 `/settings/browser-replays`：列出本人全部录制（Electron 含 LOCAL，Web/安卓含 CLOUD），点开即可播放。
- 复用现有录制文件、回放帧接口与播放组件；不改变录制协议、不改变清理策略。
- 两个入口都带“未正常结束 / 已截断 / 敏感信息”提示与空态引导。

### 1.2 非目标

- 不做 LOCAL 录制上传/回传服务端（管理端只能看 CLOUD；未来若要统一治理是独立数据上报方案）。
- 不做缩略图、导出、分享、按帧内容检索、按页面 URL 搜索（可作为后续增强）。
- 不做 DB 索引表与历史回填（MVP；演进条件见 §12）。
- 不做“开启录制后补录历史”或修改已录制场次。

## 2. 总体方案

```
┌─────────────────────────────┐        ┌─────────────────────────────┐
│ 管理后台 /browser-replays    │        │ 客户端 设置 → 浏览器回放      │
│ 全局跨用户（CLOUD）          │        │ 本人（CLOUD + 本机 LOCAL）    │
└──────────────┬──────────────┘        └──────────────┬──────────────┘
               │ GET /v1/admin/browser-replays        │ GET /v1/browser-live/replays（CLOUD）
               │ + timeline / frames（admin 版）       │ + Electron IPC replayListAll（LOCAL）
               ▼                                      ▼
      ┌──────────────────────────────────────────────────────────┐
      │ BrowserReplayCatalogService（新增，只读聚合）              │
      │  - DB 缩候选会话（admin）/ 直接扫本人目录（owner）          │
      │  - 扫 <runtime>/**/.mao-browser/replay/L*/manifest.json    │
      │  - liveId=L<ms> 先按时间窗过滤，再读 manifest              │
      │  - 30s 结果缓存 + 异步并发扫描 + 候选上限                  │
      └──────────────────────────────────────────────────────────┘
               │
               ▼
      BrowserReplayService（现有）：replayRootFor / resolveLiveDir / manifest / timeline / frame
```

播放链路沿用现有实现：

| 场景 | 列表 | 播放（timeline / frames） |
|---|---|---|
| 客户端 CLOUD | 新 `GET /v1/browser-live/replays` | 现有 `GET /v1/sessions/:sid/browser-live/replays/:liveId/(timeline|frames/:seq)` |
| 客户端 LOCAL（仅 Electron） | 新 IPC `browser-live-replay-list-all` | 现有 IPC `replayTimeline` / `replayFrame` |
| 管理后台 CLOUD | 新 `GET /v1/admin/browser-replays` | 新 `GET /v1/admin/browser-replays/:sessionId/:liveId/(timeline|frames/:seq)` |

## 3. 决策点

### D1 管理端：全局跨用户列表，复用 `session:read`

- 路由挂 `/v1/admin/browser-replays`，与 `admin-session.routes.ts` / `admin-session-files.routes.ts` 同口径：`requireRequestPermission(permissionService, request, 'session:read')`。
- 理由：管理员已有跨用户会话查看能力（`/v1/admin/sessions/:id`、工作区文件只读浏览均只要求 `session:read`）；回放是会话内容的延伸，单独造权限码会增加角色配置成本。评审确认接受该粒度。
- 风险与补偿：
  - `/v1/admin/**` 的所有请求已被全局审计拦截器覆盖（`audit.interceptor.ts` 的 `AUDITED_PREFIXES` 包含 `/v1/admin`），管理员打开列表/回放会留 READ 痕迹；
  - 管理端页面顶部固定提示“录制可能包含登录态敏感信息，访问会被审计”；
  - 逐帧 GET 会刷爆审计日志，需要按路径豁免（见 D5）。
- 备选（未采纳）：新增 `session:replay:read` 权限码 + `V214` 迁移，粒度更细但需要额外角色配置与默认授予。

### D2 客户端：包含 LOCAL 录制（Electron 本机扫描）

- Electron：设置页同时展示服务端 CLOUD 列表 + 本机 `~/.mao/runtime/<hostKey>/*/.mao-browser/replay` 扫描结果；播放走现有本地 IPC。
- Web / 安卓：只展示服务端 CLOUD 列表（与现有单会话回放一致：LOCAL 数据不在服务端）。
- 理由：LOCAL 用户占桌面端多数；若设置页只看得到 CLOUD，本机录制的用户会误判功能失效（正是上一轮“开启录制但找不到结果”的同类体验问题）。
- 代价：需要新增 Electron 主进程 IPC（`main.cjs`/`preload.cjs` 变更），**必须重出桌面安装包**（`cd desktop && npm run dist`），不能只发 `desktop/dist`。

### D3 数据源：MVP 不建索引表，扫盘 + 缓存

- 沿用 V202 的“文件系统即存储”，不新增 `browser_replay` 表。
- 扫描顺序：
  1. **先缩候选会话**：管理端用 DB 查询（用户/Agent/会话标题/活跃时间窗，`execution_mode='CLOUD'`，最多 5000 个 session）；客户端直接读 `<runtime>/<uid>/*`（本人会话数量可控）。
  2. **再按 liveId 时间戳过滤**：`liveId = L<startedAt 毫秒>`，时间窗外的目录不读 manifest。
  3. 只对候选目录读 `manifest.json`，组装摘要。
- 结果缓存 30s（可按 `refresh=1` 绕过，便于管理员立即看到新录制）。
- 演进条件：单实例候选会话 > 2 万，或列表 p95 > 500ms，再评估 DB 索引（§12）。

### D4 播放器复用

- 客户端设置页**直接复用** `desktop/src/components/browser/BrowserLiveReplay.vue`（弹窗内渲染），并给它增加可选 prop `initialLiveId?: string`：列表加载完成后自动打开指定场次，避免用户点两次。
  - 用 wrapper `provide('executionMode', ref(item.executionMode))`，CLOUD/LOCAL provider 自动分流（`desktop/src/composables/browserReplayProvider.ts`，注意不在 `components/browser/` 下）；另需按行传入**必填 prop `sessionId`** 并加 `:key`，否则 watch 重置会与自动打开竞争（详见 §6.4）。
- 管理后台不能跨应用复用 SFC，新增轻量播放器 `admin/src/components/browser/BrowserReplayPlayer.vue`：
  - canvas + 时间轴 + 播放/暂停 + 逐帧 + 倍速；数据仅走 admin timeline/frames API。
  - 时间轴几何、倍速推进等纯函数（`replayPlayer.ts` 4 个函数，仅类型依赖 `@mao/contracts`）建议从 `desktop/src/utils/replayPlayer.ts` 下沉到共享位置（可选，见 §11）；**注意 `shared/contracts` 是纯类型包（`exports` 仅 `types`），不能承载运行时代码**，需新建共享运行模块；若不下沉，管理端复制一份并标注来源，避免两端逻辑分叉。
- 不做 iframe/embed 复用桌面页面：admin 与 desktop 是独立构建，跨应用加载会引入部署耦合。

### D5 审计：列表/Timeline 留痕，逐帧请求豁免

- `/v1/admin/**` 默认全量审计；一次回放播放会请求几十到几百个 `frames/:seq`，不能逐帧写审计。
- 改造 `backend-ts/src/audit/audit.interceptor.ts`：
  - 新增只读豁免正则 `^/v1/admin/browser-replays/\d+/L\d+/frames/\d+$`（仅帧请求）；
  - `browser-replays` 列表与 `timeline` 请求照常审计（一次播放留一条打开痕迹）。
- 客户端 owner 接口不审计（现有 `/v1/sessions/...` 读接口同样不审计）。

## 4. 后端设计

### 4.1 契约（`shared/contracts/src/browser-replay.ts`）

```ts
/** 跨会话列表项（owner / admin 共用；admin 独有字段可选）。 */
export interface BrowserReplayListItem {
  sessionId: number;
  liveId: string;
  executionMode: 'CLOUD' | 'LOCAL';
  sessionTitle: string | null;
  agentId: number | null;
  agentName: string | null;
  userId?: number;        // admin
  username?: string;      // admin
  startedAt: number;      // epoch ms
  endedAt: number | null;
  durationMs: number | null;
  frameCount: number;
  approxBytes: number;
  truncated: boolean;
  pageUrl: string;        // manifest.urls[0] ?? ''
}

export interface BrowserReplayListResult {
  records: BrowserReplayListItem[];
  total: number;
  page: number;
  size: number;
  /** 候选会话超过上限被截断：提示调用方缩小筛选范围。 */
  truncatedCandidates?: boolean;
}
```

### 4.2 接口

**客户端（owner，登录即可）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/browser-live/replays?range=1D\|3D\|7D\|30D\|90D\|ALL&dateFrom=&dateTo=&page=&size=&refresh=1` | 本人跨会话录制列表；`range/dateFrom/dateTo` 复用 `resolveActivityWindow` 的日期解析口径（Asia/Shanghai 日历日；默认 30D，注意后端常量默认是 7D，需调用方显式传 30D），后端再把窗口转换为 epoch ms 与 manifest 比较；`size` 默认 20、上限 200。服务端 runtime 根下只可能存在 CLOUD 录制，列表项 `executionMode` 恒为 `CLOUD`（字段保留供客户端与 LOCAL 合并）。窗口字符串→epoch ms 的转换依赖进程时区钉死的 `Asia/Shanghai`（`config/process-timezone.ts` 在入口设 `process.env.TZ`），实现时按同一口径转换，勿依赖宿主机时区 |
| GET | `/v1/sessions/:sid/browser-live/replays/:liveId/timeline` | 现有，不变 |
| GET | `/v1/sessions/:sid/browser-live/replays/:liveId/frames/:seq` | 现有，不变 |

**管理后台（`session:read`）**

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/admin/browser-replays?userId=&agentId=&sessionId=&keyword=&range=&dateFrom=&dateTo=&page=&size=&refresh=1` | 全局列表；默认 7D，`range` 同 owner 预设集；`keyword` 仅匹配**会话标题**（不做消息全文检索，避免复用会话列表的慢查询）；`sessionId` 供会话详情页直达；`size` 上限 200 |
| GET | `/v1/admin/browser-replays/:sessionId/:liveId/timeline` | 由 `sessionId` 反查 `session.userId` 后读对应 runtime 目录；`liveId` 继续走 `L\d+` 白名单 + containment。**LOCAL 会话一律拒绝**（服务端无其 runtime 目录）：仿 `admin-session-files.routes.ts` 的 `requireBrowsableSession`——`getSession` 后 `executionMode !== 'CLOUD'` 即 `PARAM_INVALID`(400)（实现与范本一致；评审补充：此处 400 而非 404，404 只用于「目录/场次不存在」） |
| GET | `/v1/admin/browser-replays/:sessionId/:liveId/frames/:seq` | 同上；`Cache-Control: private, max-age=86400`（与 owner 帧接口一致，帧不可变） |

### 4.3 服务分层

新增 `backend-ts/src/browser-replay/browser-replay-catalog.service.ts`：

```ts
class BrowserReplayCatalogService {
  listForUser(userId, filters, page, size): Promise<BrowserReplayListResult>
  listForAdmin(filters, page, size): Promise<BrowserReplayListResult>
}
```

依赖：

- `RuntimeDataResolver`：`resolveSessionRuntimeDir(uid, sid)` / 拼 runtimeRoot。
- `BrowserReplayService`：复用 `replayRootFor`、`resolveLiveDir`、manifest 解析（把 `readManifest` 提升为可复用方法或导出独立函数，避免两套解析）。
- `SessionService`：`getSession`（owner 播放鉴权已有）、新增 `getSessionsByIds(ids)`（薄封装 `sessionRepo.selectByIds`，用于列表页补标题/Agent）；管理端另需一个只取候选 ID 的查询。
- `UserLookup` / `AgentLookup`：管理端批量补 username / agentName。注意 `batchLoadUsers/batchLoadAgents` 是 `admin-session.routes.ts` 内的**文件级闭包、不可导入**，直接用 `userLookup.findByIds` / `agentLookup.findByIds`（或提取为共享 helper），勿照抄改名造第二份。

**管理端候选查询**（新增 repository 方法，如 `selectReplayCandidateSessions(filter, limit=5000)`）：

```sql
SELECT id, user_id, agent_id, title, last_activity_at
FROM session
WHERE deleted = 0
  AND execution_mode = 'CLOUD'
  [AND id = ?] [AND user_id = ?] [AND agent_id = ?]
  [AND title LIKE ?]
  AND last_activity_at >= ? AND last_activity_at < ?
ORDER BY last_activity_at DESC, id DESC
LIMIT 5000
```

- 索引口径：`session` 表有 `idx_session_last_activity (last_activity_at, id)`（V188），时间窗 + 排序可走该索引；`execution_mode` **无索引**，仅作回表后的过滤条件。默认 7D 窗口扫描量可控；`range=ALL` 退化为按索引全序深扫，靠 `truncatedCandidates` 提示兜底（§8）。
- 用 `last_activity_at` 时间窗作为“可能有该时间窗内录制”的**超集**：浏览器操作必然发生在会话活跃期内；后续仍以 manifest `startedAt` 精确过滤。
- 超出上限：返回 `truncatedCandidates=true`，前端提示缩小时间范围/用户范围（不静默截断）。

**扫描算法**（owner / admin 共用）：

1. 解析时间窗为 `[fromMs, toExclusiveMs)`（复用 `resolveActivityWindow` 的日历日规则，转 epoch ms）。
2. 对每个候选会话目录：
   - `readdir(<runtime>/<uid>/<sid>/.mao-browser/replay)`；不存在跳过。
   - 仅对 `L\d+` 且 `Number(liveId.slice(1)) ∈ 时间窗` 的目录读 `manifest.json`。
   - 容错：非法 liveId / 坏 JSON / `manifest.liveId !== 目录名` 跳过；`startedAt` 再校验一次时间窗。
3. 汇总为 `BrowserReplayListItem`，按 `startedAt desc, liveId desc` 排序。
4. 分页；只对当前页 sessionId 批量补会话/Agent/用户元数据（管理端还要 username）；CLOUD catalog 中会话缺失（已删除/孤儿目录）直接跳过该行（LOCAL 侧例外，见 §4.6）。
5. 结果写缓存（30s，key 含筛选条件与时间窗；`refresh=1` 跳过读写）。

实现纪律：

- 用 `fs.promises` + 并发上限（建议 32）扫描，避免同步 readdir 阻塞事件循环。
- 单次请求的 manifest 读取数量设硬上限（如 2000），超限返回候选截断标记。
- 目录名/会话 id 均为数字白名单；不接受前端传路径。
- owner 侧不设候选会话上限：manifest 读取已被 liveId 时间窗预过滤把关，readdir 成本低；若实测本人会话达万级出现首屏变慢，再与 admin 共用同一截断标记。
- 窗口（`'YYYY-MM-DD HH:MM:SS'`，Asia/Shanghai）转 epoch ms 依赖进程时区（`config/process-timezone.ts` 入口固定 `process.env.TZ='Asia/Shanghai'`），勿按宿主机时区解析。

### 4.4 路由装配

- `backend-ts/src/browser-replay/browser-replay.routes.ts`：追加 owner 列表路由（`requireUserId` 取 uid）。
- 新增 `backend-ts/src/browser-replay/browser-replay-admin.routes.ts`：`session:read` + 3 个路由；注册在 `app-routes.ts` 的 `api` 作用域（与现有 replay 路由同一处装配）。
- `BrowserReplayRouteDeps` 扩充：`sessionService.getSessionsByIds`、`catalogService`（admin 路由再注入 `permissionService`、`userLookup`、`agentLookup`）。
- 不改现有 owner 的 timeline/frames 路由；管理端播放权限在 admin 路由内单独校验。

### 4.5 权限与审计

- 权限：复用 `session:read`，**无迁移**。管理端菜单/路由的 `meta.permission` 也用 `session:read`。
- 审计：
  - `/v1/admin/browser-replays`（列表）与 `.../timeline` 由全局拦截器记录 READ；
  - `.../frames/:seq` 通过 D5 的正则豁免，避免一次播放刷几百条；
  - 不额外手写审计（保持与 `admin-session-files.routes.ts` 一致）。

### 4.6 清理与一致性

- 录制删除仍由 `RuntimeCleanupScheduler` 按 `harness.cleanup.browserReplayTtlDays` 执行；列表本身就是“扫磁盘当前有什么”，天然与清理一致，无需同步删除索引。
- TTL=0 时仅随会话删除级联清理（现状不变）。
- 会话软删但 runtime 清理失败留下的孤儿目录：列表元数据查询不到会话 → 跳过（管理端）；客户端 LOCAL 孤儿目录允许展示为“会话已删除”（数据仍可播）。

## 5. 管理后台设计

### 5.1 路由与菜单

- `admin/src/router/index.ts` 新增：
  ```ts
  { path: 'browser-replays', name: 'BrowserReplays',
    component: () => import('../views/session/BrowserReplayListView.vue'),
    meta: { title: '浏览器回放', keepAlive: true, permission: 'session:read' } }
  ```
- `admin/src/utils/menuNav.ts` 「运行」组新增：
  ```ts
  { index: '/browser-replays', label: '浏览器回放', icon: VideoCamera, permission: 'session:read' }
  ```
- 复用 `GET /v1/admin/sessions/options/users|agents` 作为筛选下拉（已支持 `session:read`）。

### 5.2 列表页（`admin/src/views/session/BrowserReplayListView.vue`）

- 筛选区：用户、Agent、时间范围（默认 7 天，预设 1/7/30/全部 + 自定义日期）、会话标题关键词。
- 表格列：开始时间、用户、Agent、会话标题（点击跳 `/sessions/:id`）、时长、帧数、体积、状态（未正常结束 / 已截断）、操作（查看回放）。
- 顶部固定提示：「回放可能包含登录态敏感信息，访问会记录审计；LOCAL 会话的录制保存在用户设备上，管理端不可见」。
- 空态：说明开启路径（系统设置 → 浏览器直播 → 启用操作录制）与保留天数（`harness.cleanup.browserReplayTtlDays`）。
- 错误态：列表接口失败展示重试按钮；候选截断展示提示条（建议缩小范围）。
- 分页：服务端分页，默认 20/页（UI 可选 20/50/100）。

### 5.3 播放抽屉（`admin/src/components/browser/BrowserReplayPlayer.vue`）

- 打开即拉 `timeline`；canvas 绘制 `frames/:seq`；时间轴点击/拖拽定位、播放/暂停、逐帧、倍速（1/2/4x）。
- **帧接口返回裸 JPEG 而非 `Result<T>` 信封**：admin 的 axios 响应拦截器只对 `responseType: 'blob'` 原样透传（`admin/src/api/index.ts` 的二进制直通分支），`arraybuffer` 会被当信封校验 `data.code !== 0` 误拒——必须 `responseType: 'blob'` 并手动捕获 404——范本 `desktop/src/api/index.ts` 的 `fetchBrowserReplayFrame`；后端 404 是空 body（`reply.status(404).send()`），不是信封错误码，客户端须按 HTTP 状态处理（评审补充：初版写 `arraybuffer` 有误，已按拦截器实际分支改正）。
- 失败兜底：timeline 404 → “回放已被清理或不存在”；单帧 404 → 占位提示（沿用现有文案）。
- 组件遵循 admin 惯例用 Element Plus（`el-button`/`el-card`/`el-icon`），勿照搬桌面端裸 `<button>` + 手写 CSS；图标按钮带 aria-label/title。
- 可选增强（不在 MVP 必做）：显示 `pageUrl`、当前帧时间、复制 `sessionId/liveId` 便于排障。

### 5.4 会话详情页的第二入口（可选）

- `SessionDetailView.vue` 顶部操作区增加「浏览器回放」按钮：跳转 `/browser-replays?sessionId=<id>`（筛选参数），方便管理员从会话上下文直接定位录制。
- 注意**两处插入点**：桌面 `el-page-header` 的 `#extra` 插槽（L8-13）与移动端 `.mobile-page-actions`（L20-27），只改桌面端移动端不可见。
- `?sessionId=` 深链需要路由 query 兜住：仿 `SessionListView.vue` 的 `appliedQuery` 快照比对 + query 变化重查（L427/L453/L752），否则从会话详情跳转后筛选不生效。

## 6. 客户端设置页设计

### 6.1 路由与菜单

- `desktop/src/router/index.ts` 设置子路由新增：
  ```ts
  { path: 'browser-replays', name: 'BrowserReplays',
    component: () => import('../views/settings/BrowserReplaysView.vue') }
  ```
  命名跟随桌面既有惯例：设置子路由名取路径段 PascalCase、**无 `Settings` 前缀**（如 `ScheduledTasks`/`OpenApi`/`SignalWatchers`）；`BrowserReplays` 与现有路由名无冲突（已核对）。
- `desktop/src/views/settings/SettingsView.vue` 侧栏「定时任务」与「开放接口」之间新增「浏览器回放」。

### 6.2 页面（`desktop/src/views/settings/BrowserReplaysView.vue`）

- 数据源合并：
  - CLOUD：新 `GET /v1/browser-live/replays`（服务端已分页；页面按时间范围取 `size=200` 上限，若 `total > 200` 提示缩小时间范围；与 LOCAL 合并后做客户端分页，默认 20/页）。
  - LOCAL（仅 Electron）：并发调用 IPC `browser-live-replay-list-all({ from, to })`，返回本机全部场次摘要（单次上限 2000 场）。
  - 合并去重键：`sessionId + liveId + executionMode`；按 `startedAt desc` 排序。
- 会话标题/Agent：
  - CLOUD 项由后端返回；
  - LOCAL 项按去重后的 sessionId 调 `GET /v1/sessions/:id` 补齐（view 内 Map 缓存 + 并发上限 5）；取不到时显示「会话 #id（已删除）」。
- 筛选：时间范围（默认 30 天）、模式（全部 / CLOUD / LOCAL；非 Electron 只显示全部+CLOUD）、关键词（会话标题）。
- 行操作：「播放」打开弹窗；「打开会话」跳 `/tasks/:sessionId`。
- 平台差异：
  - Web/安卓：无 LOCAL 数据，模式筛选不含 LOCAL；
  - Electron：包含 LOCAL；页面提示“本机录制只在这台设备可见”。
- 空态：说明录制开关位置；若无 CLOUD 但可能有 LOCAL，分别提示。

### 6.3 Electron IPC

- `desktop/electron/localRuntimePaths.cjs` 新增 `resolveLocalRuntimeRoot()`：`~/.mao/runtime/<getServerHostKey()>`（只扫当前服务器 hostKey，避免跨服务器 sessionId 撞号）。须加在 `createLocalRuntimePaths` factory 返回值里、由 `main.cjs:130-134` 同款注入 `browserLive.cjs`——hostKey 随服务器切换动态变化，不能静态导出常量。
- `desktop/electron/browserLive.cjs` 新增：
  ```ts
  ipcMain.handle('browser-live-replay-list-all', (_e, payload) => replayListAll(payload?.from, payload?.to))
  ```
  - 只接受 `from/to` 数字时间窗；扫描 `resolveLocalRuntimeRoot()/*/.mao-browser/replay/L*`；
  - 会话目录必须为数字、liveId 必须匹配 `L\d+`；单次最多返回 2000 场；
  - 复用现有 `readManifestSafe` / timeline 读取口径；`manifest.sessionId` 落盘是**字符串**（host 侧 `String(args.session)`，而契约类型是 `number`、后端读取端也不校验类型），与目录名比较时按字符串比对，不一致的跳过；
  - 返回 `{ sessionId, liveId, startedAt, endedAt, durationMs, frameCount, approxBytes, truncated, pageUrl }[]`。
- `desktop/electron/preload.cjs` 的 `browserLive` 增加 `replayListAll(from, to)`；`desktop/src/types/electron.d.ts` 同步类型。
- 安全：renderer 不传路径，只传时间窗；扫描根固定在本机 runtime；无任意目录枚举能力。

### 6.4 播放弹窗

- 复用 `BrowserLiveReplay.vue`；新增 prop `initialLiveId?: string`：
  - `loadList()` 完成后在 `summaries` 中匹配 `liveId`，命中即 `open(item)`；
  - 未命中（已被清理）停留在列表并提示。
- **`sessionId` 是该组件必填 prop**（`BrowserLiveReplay.vue:90`，`number | null`）：wrapper 须按行 `:session-id` 传入并加 `:key="sessionId + ':' + liveId"`——组件 `watch([sessionId, provider])` 变化即 `backToList()` 重置到列表态（L118-121），自动打开逻辑必须随每个 item 重新武装，否则与重置竞争。
- `provide('executionMode', ref(item.executionMode))` 维持 D4 口径（组件 `inject` 缺省 `CLOUD`，L92；provider 是 computed，mode 变化会重建并触发上述 watch）。
- 弹窗宽度建议 ≥ 720px；移动端（安卓）用全屏抽屉。
- 退出弹窗即 `pause()` 并断开 `pendingImage`（组件 `onBeforeUnmount` 现有行为，L345-348；**并无显式 canvas 释放/清空**，表述勿夸大）。

## 7. 安全与隐私

| 项 | 措施 |
|---|---|
| 归属 | owner 列表/播放严格 `session.userId` 校验（现有）；admin 由 `sessionId` 反查 owner，禁止前端传 uid 拼路径 |
| 权限 | admin 复用 `session:read`（评审确认）；菜单/路由/接口三处一致 |
| 审计 | admin 列表与 timeline 留 READ；逐帧豁免防刷屏（D5） |
| 路径穿越 | `L\d+` 白名单 + `path.resolve` containment（现有）；LOCAL IPC 根目录固定 |
| 敏感内容 | admin 页面顶部提示；不提供批量下载/导出，降低扩散面 |
| 越权枚举 | 客户端只能读到本人目录；admin 至少需要 `session:read` |
| 数据生命周期 | 沿用 TTL 清理与会话级联删除；本方案不复制录制内容 |

## 8. 性能与容量

- 候选收敛：管理端先 DB 过滤（用户/Agent/标题/活跃时间窗），客户端只扫本人目录。
- liveId 时间戳预过滤：不读时间窗外 manifest。
- 异步扫描 + 并发 32；单请求 manifest 上限 2000；候选会话上限 5000。
- 30s 结果缓存（`refresh=1` 绕过）；缓存条目上限 50，超限按 LRU 淘汰。
- 典型量级估算：7 天窗口内使用过浏览器的会话通常为个位数到几十个；manifest 读取 < 100 次，列表请求应在 50ms 量级。极端情况下返回截断标记而不是拖死接口。
- 帧接口维持现状（单帧 JPEG ≤512KB，`Cache-Control: private`），播放端有 50 帧缓存与预取。

## 9. 测试计划

### 后端

- `browser-replay-catalog.service.spec.ts`（临时 runtime 目录）：
  - 时间窗过滤（liveId 时间戳 + manifest startedAt 双重校验）；
  - 分页/排序；未结算场（endedAt=null）、截断场；
  - 孤儿会话跳过；非法 liveId/坏 JSON 容错；
  - 候选上限截断标记；缓存命中与 `refresh=1`；
  - 管理端筛选（userId/agentId/title/时间）。
- `browser-replay-admin.routes.spec.ts`：无 `session:read` → 403；有权限 → 200；帧/ timeline 路径穿越拒绝；不属于该会话的 liveId 404。
- `audit.interceptor.spec.ts`：frames 路径豁免；list/timeline 仍审计。
- owner 列表路由：只返回本人会话、跨用户不可见。

### 桌面

- `desktop/electron/browserLiveReplay.test.cjs`（回放用例既存于此，勿新建 `browserLive.test.cjs`）：`replayListAll` 扫描临时目录（数字会话、`L*` 白名单、时间窗、上限、坏 manifest 容错、`manifest.sessionId` 字符串比对）。
- `BrowserReplaysView` 合并逻辑单测：CLOUD + LOCAL 排序/去重/模式筛选；LOCAL 标题补齐失败回退。
- `BrowserLiveReplay` 的 `initialLiveId`：命中自动打开、未命中停留列表。
- Electron API 类型检查由 `npm run build` 覆盖。

### 管理端

- 列表纯函数单测：状态徽标/时长/体积格式化、筛选参数序列化。
- 播放器组件冒烟（mock API）：timeline 加载、帧 404 占位、播放/暂停切换。
- `admin npm run build`、`npm test`。

### E2E（可选）

- 在 E2E runtime 目录种一个假回放（manifest + timeline + 2 帧），客户端设置页可见并能打开；
- 管理端用 admin 登录，`/browser-replays` 能看到该场（需 CLOUD 会话记录与权限）。

## 10. 发布与回滚

- 后端：部署 + 重启（`restart-backend.sh`）；无 DB 迁移。
- 管理后台：`bash scripts/deploy-admin.sh`。
- 客户端：
  - P0（仅 CLOUD 列表）随 `desktop/dist` 发布；
  - P1（LOCAL 扫描）改了 `main.cjs`/`preload.cjs`，**必须重出桌面安装包**（`cd desktop && npm run dist`）。
- 变更留痕（AGENTS.md 强制）：本功能为用户/运维可见改动，同任务新增 `changelog/unreleased/2026-11-27-browser-replay-history.md`——只写 `###` 小节（`### 管理后台`、`### 前端（桌面 / Web / 安卓）`、`### 后端`），不写版本号；并同步更新 `DEPLOY.md` 的 V202 回放行（补两个新入口与 LOCAL 可见范围）、`README.md`、`skills/mao-cli` 相关说明。
- **碎片冲突**：未发布碎片 `changelog/unreleased/2026-11-27-browser-live-record-host.md` 中「管理后台不提供回放查看器，回放按会话归属仅本人客户端可看」与本方案直接矛盾，落地时须同批改写该句。
- 回滚：前端入口下线即可；后端新增只读接口不影响现有链路；录制文件与清理策略不变，无数据迁移/回滚成本。

## 11. 工作量与分期

| 阶段 | 内容 | 预估 |
|---|---|---|
| P0 | 契约 + catalog 服务 + owner/admin 列表接口 + 审计豁免 + 管理端页面/播放器 + 客户端设置页（先 CLOUD） | 4–5 人日 |
| P1 | Electron `replayListAll` IPC + 客户端 LOCAL 合并 + `initialLiveId` | 1.5–2 人日 |
| P2（可选） | `replayPlayer` 纯逻辑下沉共享、列表缩略图、管理端从会话详情跳转、导出 | 2–3 人日 |

建议按 P0 → P1 交付；P0 完成后 CLOUD 用户即可用两个入口，P1 补齐 LOCAL。

## 12. 风险与后续演进

| 风险 | 影响 | 缓解 |
|---|---|---|
| 扫盘在超大规模下变慢 | 管理端列表首屏变慢 | DB 候选上限 + 时间窗默认 7 天 + 30s 缓存；超过阈值演进 DB 索引 |
| `session:read` 粒度过粗 | 有会话查看权的管理员都能看回放 | 评审已确认；页面提示 + 审计留痕；后续可平滑新增 `session:replay:read` 并把 admin 路由切换过去 |
| LOCAL 数据不可见 | 管理端无法核查本机录制 | 页面明确提示；未来如需要，另立“录制上报”方案 |
| 清理与列表竞争 | 播放时帧 404 | 播放器已有占位；列表不缓存帧 |
| 管理端审计量大 | 审计表膨胀 | 只豁免 frames；list/timeline 一次一条；必要时对 frames 采样审计 |

**演进到 DB 索引的条件与做法**（预留）：

- 条件：候选会话 > 2 万或列表 p95 > 500ms，或需要按页面 URL/时长的复杂检索。
- 做法：新增 `browser_replay` 表（session_id/user_id/live_id/started_at/ended_at/frame_count/…）；sidecar 在 `stopped` 时随帧上报摘要（或由 `RuntimeCleanupScheduler` 扫描 upsert）；catalog 先读表、缺失时回退扫盘；清理时同步删行。届时本方案的接口与前端无需改动。

## 13. 评审补充（2026-11-27，对照代码核对后并入）

**核对结论：方案可行，以下为核对代码后补充/更正的实现要点（正文相应位置已改）。**

已核对为**准确**的关键前提（实现时可放心引用）：

- 落盘布局 `<runtimeRoot>/<uid>/<sid>/.mao-browser/replay/<liveId>/{manifest.json,timeline.ndjson,f<seq>.jpg}`（`browser-live-recorder.mjs:56`、`browser-replay.service.ts:18-20`）；LOCAL 为 `~/.mao/runtime/<hostKey>/<sid>`、无 uid 段（`localRuntimePaths.cjs:11-16`）。
- manifest 字段 `{version, liveId, sessionId, startedAt, endedAt, frameCount, durationMs, approxBytes, cliSessions, urls, truncated}`；**manifest 每帧原子重写**（recorder L180），未结算场的 `frameCount/approxBytes/urls` 仍实时，仅 `durationMs` 为 null（列表时长列对未结算场展示「未结束」即可，无需读 timeline 兜底）；零帧场次 finalize 时整目录删除，列表不会出现空场。
- `resolveActivityWindow` 为后端导出函数（`session/message-search.ts:283`），预设 `1D/3D/7D/30D/90D/ALL`、常量默认 `7D`；admin 前端有对应的 `activityRangeParams`（`admin/src/utils/sessionActivityRange.ts`）。
- `session:read` 已种子化（V038），菜单/路由/接口三处复用无迁移；`/v1/admin/sessions/options/users|agents` 存在且 `session:read` 在准入集合内。
- 审计：`AUDITED_PREFIXES` 含 `/v1/admin`（`audit.interceptor.ts:14`），GET 也记 READ；路径在 `app-hooks.ts:141` 已去 query，D5 正则可按无 query 匹配；`resolveObjectType` 会得到 `admin.browser-replays`、`objectId` 取到 sessionId（审计可定位到会话）。现有豁免机制是精确/前缀匹配（`AUDITED_READ_EXCLUDES` 仅对非写方法生效），正则豁免是**新机制**，实现时注意别破坏既有两条。
- 清理：TTL 默认 7 天（钳制 0–365，非法回退 7）、只扫 `L\d+` 一级目录按 mtime、活跃会话跳过；TTL=0 仅停按天清理；会话删除经 `runtimeSessionCleanup`（`app-utils.ts:119-149`）级联删 runtime 目录（含 group-chat 的 `<runtimeRoot>/*/<sid>`）。**admin 列表默认 7D 窗口与 TTL 默认 7 天吻合**，默认视图即可覆盖全部在保留期内的录制。
- 现有 owner 回放路由仅 `/v1/sessions/:sid/browser-live/replays*` 三个，`/v1/browser-live/...` 命名空间无冲突、自动继承 JWT 保护；404 均为空 body。
- `selectByIds` 已存在且排除软删会话（`session.repository.ts:676`）；`getSessionsByIds`  wrapper 确需新增。
- 桌面播放器无 route/store/WS 依赖，设置页弹窗复用安全；`replayPlayer.ts` 4 个纯函数仅类型依赖契约。
- Electron 侧 `readManifestSafe`/`readTimelineSafe`、`L\d+` 白名单 + containment 均已存在可复用；`replayListAll` 通道与 `resolveLocalRuntimeRoot` 确需新增。
- admin 无既有播放器可复用（`components/` 是平的，唯一 canvas 在 PdfViewer），新增 `components/browser/BrowserReplayPlayer.vue` 为该目录第一个子目录；端口时按 Element Plus 惯例重写控件。

补充进正文的更正点（详见各处行内说明）：owner 列表 `executionMode` 恒 CLOUD 与时区转换口径（§4.2）；admin timeline/frames 拒绝 LOCAL 会话（§4.2）；`batchLoadUsers/batchLoadAgents` 不可导入（§4.3）；候选查询索引口径与 owner 不设上限的理由（§4.3）；admin 帧请求须 `responseType: 'arraybuffer'` + 手动捕 404（§5.3）；会话详情按钮双插入点与 query Hydration（§5.4）；桌面路由命名 `BrowserReplays`（§6.1）；`resolveLocalRuntimeRoot` 走 factory 注入（§6.3）；`manifest.sessionId` 字符串比对（§6.3）；`sessionId` 必填 prop + `:key` 与 canvas 释放表述（§6.4、D4）；`replayPlayer` 下沉不能进 `shared/contracts`（D4）；测试文件名（§9）；changelog 碎片、冲突碎片改写与文档同步（§10）。