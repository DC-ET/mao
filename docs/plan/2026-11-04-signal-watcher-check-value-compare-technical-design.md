# 信号哨兵轮询记录值人读化技术方案（`changed` 行展示「旧值 → 新值」）

- 状态：已确认（待实施）
- 日期：2026-11-04
- 评审：2026-11-04 技术评审通过（需求可行）。原方案有 1 处致命缺口（旧值无落点）与若干不完善点，已按本次评审修订后定稿；改动集中在 §1.3 / D1 / D5 / §4 / §5.2 / §5.4~5.8 / §6~§8
- 需求来源：[提案：哨兵「变化」点进去只看到哈希 —— 轮询记录的值的对比](../proposals/2026-11-04-signal-watcher-check-value-compare.md)（待评审；本方案为评审前技术细化，范围与提案目标一致）
- 上游：第二十二批「只把后端早已写好的字段翻到展示层」第三件
- 规模：小（后端两列新增 + 写入点改造 + 桌面/admin 展示；桌面/admin 各约 0.5 人日；两条新迁移，无回填）
- 关联：`backend-ts/src/signal/types.ts`、`backend-ts/src/signal/watcher.logic.ts`、`backend-ts/src/signal/watcher.routes.ts`、`backend-ts/src/signal/watcher.service.ts`、`desktop/src/views/settings/SignalWatchersView.vue`、`admin/src/views/signal/SignalWatcherListView.vue`

## 1. 需求背景

### 1.1 现状（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 轮询记录存储 | ✅ `signal_watcher_check` 有 `value_hash` / `changed` / `http_status` / `triggered_session_id` / `error` / `warning` / `duration_ms`；watcher 行有 `last_value_hash` / `last_value_snippet` / `last_checked_at` / `last_changed_at` | `backend-ts/src/signal/types.ts:19-55`（`SignalWatcherCheck` / `SignalWatcher`）、`V148` 迁移 |
| 值侧旧值片段的真实使用者 | ✅ `lastValueSnippet` 注释写明「供 `{diff}` 旧值侧使用」；`buildDiff` 输出「旧值：…\n新值：…」（各截 500 字）；触发会话的 prompt 已含两边 | `types.ts:27-28`、 `watcher.logic.ts:117-127` |
| 后端 checks 端点 | ✅ `GET /v1/signal-watchers/:id/checks`(`:118-123`，桌面)/`GET /admin/signal-watchers/:id/checks`(admin) 已回 `error` / `valueHash`；桌面 `SignalWatcherCheckView` 含 `error/valueHash/changed` | `watcher.routes.ts:118-123`、`desktop/src/api/index.ts:1066-1075` |
| 桌面 checks 抽屉 | ❌ 「详情」列只显示 `error \|\| valueHash.slice(0,12)`，无旧值/新值的人读展示 | `SignalWatchersView.vue:218-228` |
| 管理后台 checks Tab | ❌ 同「详情」列同状：`error \|\| valueHash?.slice(0,12)` | `SignalWatcherListView.vue:170-176` |
| 哨兵列表卡 | ❌ 未透出 `lastValueSnippet`：桌面 `SignalWatcherView` 无该字段，admin `WatcherDetail` 只在「详情接口」有 `lastValueHash`（含义：该字段不出现在列表行 `WatcherRow`），两边都读不到「上次变化的值」 | `desktop/src/api/index.ts:1040-1064`、`SignalWatcherListView.vue:200-229` |

### 1.2 要解决的问题

1. **「变化」只是一个徽标**：用户点进 checks 表只看到「变化 1 行」，判断「这个变化是否值得去处理」必须再点进触发会话读 prompt——而 trigger 会话的 prompt 已经机构了值的对比，只是展示层不给对照。
2. **失败只看一行 error**：哨兵检查失败时只给 `error` 一句话，没有「上一次正常值是多少、这次错在这儿」的关系——用户分不清是接口挂了还是接口值本身坏了。

### 1.3 关键事实（设计建立在其上）

- `lastValueSnippet` 的写入点在 watcher 行上（`signal.service` 的 `markChecked({ lastValueSnippet: newText })`），且在触发会话的 prompt 里以 `buildDiff({ oldText: watcher.lastValueSnippet ?? '' })` 使用（`watcher.service.ts:486-488`）。它是**单值**、随轮询覆盖，没有历史。
- `buildDiff` 的三模式文案（`watcher.logic.ts:118-127`）：
  - `HASH`：`[响应体前 500 字] 旧：{oldSnippet}\n新：{newSnippet}`；
  - `JSON_FIELD`：`[字段 {jsonPath}] 旧值：{old}\n新值：{new}`；
  - `STATUS_CODE`：`[HTTP 状态码] {old} → {new}`。
  展示层复刻同一文案族的口径。
- `valueTextForDiff`（`watcher.logic.ts:139-150`）：HASH 取响应体、`JSON_FIELD` 取字段值、`STATUS_CODE` 取状态码——这是判定值 → diff 文本的统一转换，本方案复用此口径，展示层不另造口径。
- 本次要展示的「旧值 → 新值」中，**旧值没有任何现成落点**：`watcher.lastValueSnippet` 是单值、每轮成功轮询都被 `markChecked` 覆盖成最新值（`watcher.service.ts:442/454/529/546`），读取时拿到的是「当前最新值」而不是某一历史行的旧值。旧值只在 `runCheck` 进程内可得——即函数开头 `findById` 读到的那份快照（`watcher.service.ts:372`，也正是与 `lastValueHash` 比对用的同一份）。因此旧值必须与新值同时落进 check 行，见 §4.1 / §5.2。
- 新值即本轮的值——后端在 checks 端点里尚未独立回出新值，见 §4 的端点扩展。
- 哨兵判定模式是封闭枚举 `SignalCompareMode`（`SIGNAL_COMPARE_MODES`），在槽位展示里按「是否 VALUE 模式（HASH/JSON_FIELD）」三分栏处理，`STATUS_CODE` 走一句话格式（见 §5）。

## 2. 需求描述

### 2.1 要做的

1. **后端**：checks 端点回出每行 `oldValueSnippet` / `newValueSnippet`（上次值 / 本次值片段）——后端在 `watcher.service.ts` 判定值算出的同一点，把对照用的旧值（`runCheck` 开头那份 watcher 快照的 `lastValueSnippet`）与本轮的 `newText`（`valueTextForDiff` 口径）一并写入 `signal_watcher_check` 行；checks 读端点透出。
2. **桌面 checks 抽屉「详情」列**：`changed === 1` 显示「旧值 → 新值」；`error` 行优先展示 error 文本 + 失败弱强调色（其中「触发失败」行附新旧值对，见 §5.5）；未变行显示新值。文案口径与 `buildDiff` 一致（按模式区分）。
3. **admin checks Tab「详情」列**：与桌面同列名、同文案格式；列宽仿现有「详情」列。
4. **哨兵列表卡一句「上次变化」**：桌面 `SignalWatchersView` + admin `SignalWatcherListView` 的哨兵列表行旁，给「上次变化：旧值 → 新值」一条人读展示（数据取 watcher 行新增透出的 `lastChangeOldSnippet` / `lastChangeNewSnippet`，见 D5）。

### 2.2 明确不做的

- **不改哨兵探针的判定逻辑**：`HASH` / `JSON_FIELD` / `STATUS_CODE` 三模式的比对方式（`valueTextForDiff` / `computeValue` 的判定逻辑）不动；「是否触发」的进出决策不动。
- **不改 `{diff}` 模板占位语义**：后端触发 prompt 的占位符替换与文案不变（`buildDiff` 函数本身不改）。
- **不做历史 diff 行级 diff**：不生成行级 diff（`buildDiff` 已明确「不做行级 diff」）；展示层只给「旧值 → 新值」两值并列，不做 AST/JSON 行 diff。
- **不新增触发器关联**：不做「变化→点到会话」的跳转——结果徽标再展示。
- **不改哨兵列表卡的其他列与桌面/admin 其他页面**。
- **不回填历史行**：上线前的 check 行新旧两值均为 NULL，不做任何回填（旧行的旧值在数据模型里从未落库，不可恢复）；列表卡对从未变化的哨兵不渲染该句。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 后端新旧值持久化 | checks 行新增两列 `old_value_snippet` / `new_value_snippet`（均 `VARCHAR(1024) NULL`，同一新迁移；存 `truncate(text, DIFF_SNIPPET_MAX_CHARS)` 即 500 字，与 `buildDiff` 的单侧片段字面一致），在判定值算出的同一点一并写入 | checks 行当前无新旧值字段，回读端无法透出。**旧值不能取 watcher 行的 `lastValueSnippet`**——它每轮被覆盖成最新值，读取时与「新值」是同一个字符串，「旧值 → 新值」会退化成「B → B」；旧值只在 `runCheck` 进程内（`watcher.service.ts:372` 那份快照）可得，必须与本轮新值同时落库。两列同迁移，不新增表 |
| D2 | 不新增 HTTP 端点、不新开任务收件箱 kind | 复用 `GET /v1/signal-watchers/:id/checks` 与 admin checks 端点；属主/`signal:read` 门不变 | 提案不变闸门；展示层读到字段即用。 |
| D3 | 文案口径 | 与 `buildDiff` 三模式完全一致：`HASH`：`[响应体前 N 字] 旧：…\n新：…`（或折行内单行版）、`JSON_FIELD`：`[字段 {jsonPath}] 旧值：…\n新值：…`、`STATUS_CODE`：`[HTTP 状态码] {old} → {new}` | 展示层与触发会话内容字面一致，用户对照心智一致。 |
| D4 | 桌面 `lastValueSnippet` 透出 | 桌面 `SignalWatcherView` 补 `lastValueSnippet: string \| null`，由 watchers 读端点透出（后端 watcher 行已有该字段，改 `WatcherService.toView` 而非 routes）。它的用途是失败行的「上次正常值」（失败不覆盖它）；列表卡的「旧 → 新」不用它，用 D5 的两列 | 失败行的动机（§1.2.2「分不清是接口挂了还是值坏了」）只有它能回答。admin 列表与桌面列表行都要补这三字段（§5.4 / §5.8 要用），不能再是「只补 WatcherDetail」 |
| D5 | 列表卡数据源 | 列表卡要的是「上次那次变化的旧值 → 新值」，该数对只存在于 check 行。watcher 行新增 `last_change_old_snippet` / `last_change_new_snippet` 两列，变化触发成功时与 `markChecked` 同写；列表端点直接透出，零额外查询、口径精确 | watchers 列表端点只回 watcher 行、不回 check 行，原方案「取 `lastValueSnippet` 与最近一次变化行 `newValueSnippet`」在列表接口上拿不到后者；让前端对每个哨兵再拉一次 checks 第一页是 N+1 请求，否决。watcher 表一行一哨兵，两列成本可忽略，且滚动清理只作用于 check 表（90 天），watcher 行不受影响 |

## 4. 数据契约

### 4.1 数据库

| 迁移 | 字段 | 说明 |
|---|---|---|
| `V183__signal_watcher_check_add_value_snippets.sql`（新；当前最新迁移为 V182，顺延取 V183） | `signal_watcher_check.old_value_snippet VARCHAR(1024) NULL` | 本次判定所对照的上次值片段：取 `runCheck` 开头读到、并与 `lastValueHash` 比对的**同一份** watcher 快照的 `lastValueSnippet`（首轮建基线时为 NULL）。不能改用触发前复读的 `fresh.lastValueSnippet`（`watcher.service.ts:473`）——探针在途期间用户可能编辑判定字段，复读值与「是否变化」的判定基准已不一致 |
| 同上 | `signal_watcher_check.new_value_snippet VARCHAR(1024) NULL` | 本轮判定值的可读片段，与 `buildDiff` 的 `newSnippet` 同值（`truncate(newText, 500)`）；探针失败 / 判定值计算失败的行为 NULL |
| `V184__signal_watcher_add_last_change_snippets.sql`（新） | `signal_watcher.last_change_old_snippet` / `last_change_new_snippet VARCHAR(1024) NULL` | 上次变化的新旧值对，供列表卡一句「上次变化：旧 → 新」；变化触发成功时与 `markChecked` 同写，基线重置 / 重新启用时清空 |

四个新列均存 `truncate(text, DIFF_SNIPPET_MAX_CHARS)`（500 字，含「…（已截断）」标记），与触发会话 prompt 里 `buildDiff` 展示给 Agent 的片段字面一致；列宽取 1024 只为与 `last_value_snippet` 对齐留余量，不是存储口径。

### 4.2 接口

| 端点 | 变更 |
|---|---|
| `GET /v1/signal-watchers/:id/checks`、`GET /admin/signal-watchers/:id/checks` | 响应行新增 `oldValueSnippet` / `newValueSnippet: string \| null`（`valueTextForDiff` 口径，失败行的 snippet 为 null）。两端都是 `SELECT *` + 行原样回传（`signal.repository.ts:263-273`、`watcher.routes.ts:118-124`、`signal-admin.routes.ts:89-95`），加列即透出，无需改 SQL |
| 哨兵 watchers 读端点（桌面 `/v1/signal-watchers`、admin `/v1/admin/signal-watchers`） | 响应行新增 `lastValueSnippet` / `lastChangeOldSnippet` / `lastChangeNewSnippet: string \| null`。桌面走 `WatcherService.toView`；admin 列表是 `signal-admin.routes.ts:57-72` 的 `records` 手工映射，必须显式补这三项（admin 详情端点 spread `view`，自动获得） |

## 5. 实现步骤

| # | 动作 | 位置 |
|---|---|---|
| 5.1 | 新增迁移 `V0xx`：`signal_watcher_check` 加 `new_value_snippet VARCHAR(1024) NULL` | `backend-ts/db/migration/V0xx__signal_watcher_check_add_new_value_snippet.sql` |
| 5.2 | 写入：判定值算出的同一点（现 `updateHash(checkId, valueHash)`，`watcher.service.ts:436`）把 repo 方法扩为 `updateValue(id, { valueHash, oldValueSnippet, newValueSnippet })`，一次 UPDATE 带走三列。**不写在 `markChanged` / `markChecked` 收尾处**——那两条路径只在「变化 / 触发」时走，未变行与首轮建基线的行拿不到片段（§5.5 要求未变行也显示新值）。旧值取 `watcher.lastValueSnippet ?? null`（372 行那份快照），新值取 `newText`，两侧都过 `truncate(·, 500)`；变化触发成功路径（527 行 `markChecked`）另把该数对传给 watcher 行的 `last_change_*` 两列 | `backend-ts/src/signal/watcher.service.ts`（`runCheck` 436 行 + 变化收尾处）、`backend-ts/src/signal/signal.repository.ts`（`updateHash` → `updateValue`、`markChecked` 增补两列入参） |
| 5.3 | 透出：两个 checks 读端点的行 VO 新增 `oldValueSnippet` / `newValueSnippet` | `backend-ts/src/signal/watcher.routes.ts:118-123` + admin 读端点；`SignalWatcherCheck` 类型补两个字段；前端镜像类型 `SignalWatcherCheckView`（`desktop/src/api/index.ts:1066-1076`）与 admin `CheckRow`（`SignalWatcherListView.vue:229-239`）同步补，否则 UI 层读不到、`vue-tsc` 直接报错 |
| 5.4 | watcher 读端点透出：桌面 `/v1/signal-watchers` 与 admin `/v1/admin/signal-watchers` 响应行新增 `lastValueSnippet` / `lastChangeOldSnippet` / `lastChangeNewSnippet` | 桌面：改 `watcher.service.ts` 的 `toView`（840-865），`watcher.routes.ts` 无需动（原样回传 service 结果）；admin：`signal-admin.routes.ts:57-72` 的 `records` 手工映射显式加三项。前端类型：`desktop/src/api/index.ts:1040-1064` 的 `SignalWatcherView`、admin `SignalWatcherListView.vue:200-215` 的 `WatcherRow`（列表卡要用，必须补——只补 `WatcherDetail` 会与 §5.8 矛盾） |
| 5.5 | 桌面 checks 抽屉「详情」列：`changed === 1` 显示「旧值 → 新值」（口径与 `buildDiff` 一致，按模式三分栏）；`error` 行优先展示 error 文本 + 失败弱强调色，其中「触发失败」行（`error` 非空且 `changed === 1`，`watcher.service.ts:543`）在 error 下附一行新旧值对——该行值是好的、坏的只是触发；未变行显示新值；两列为 NULL（上线前历史行）回落 `—` | `desktop/src/views/settings/SignalWatchersView.vue:190-250` |
| 5.6 | admin checks Tab「详情」列同列名、同文案格式；`CheckRow` 补两个 snippet 字段 | `admin/src/views/signal/SignalWatcherListView.vue:169-176` |
| 5.7 | 必修的存量缺陷：`MysqlSignalWatcherRepository.update`（`signal.repository.ts:92-114`）的字段映射漏了 `lastValueSnippet`，`WatcherService.update` 基线重置（`:238-245`）与 `setStatus` 重新启用（`:271-277`）里的 `patch.lastValueSnippet = null` 被静默丢弃。补映射 + 回归测试 | `backend-ts/src/signal/signal.repository.ts` + `signal.repository.spec.ts`。不补的后果：改完判定字段后 `last_value_hash` 已清、片段仍是旧目标的文本，下次轮询一变化，触发 prompt 的 `{diff}` 旧值侧就是错的；列表卡也会显示一个与当前目标无关的「上次变化值」 |
| 5.8 | 哨兵列表卡一句：桌面 `SignalWatchersView` 哨兵卡的 `lastChangedAt` 旁、admin 列表行同口径，展示「上次变化：{lastChangeOldSnippet} → {lastChangeNewSnippet}」（按 `compareMode` 三分栏文案，与抽屉一致）；两者为 NULL（从未变化 / 已重置基线）时整句不渲染 | `desktop/src/views/settings/SignalWatchersView.vue:64-71` / `admin/src/views/signal/SignalWatcherListView.vue:62-64`；数据源见 D5，两端前端类型都要补三字段（见 5.4） |
| 5.9 | 用户手册同步：`skills/mao-cli/reference/signal-watcher.md` 的「轮询记录字段」表补两列 + 列表卡一句的说明 | — |

### 文案口径（与 `buildDiff` 一致）

- `HASH`：`[响应体前 500 字] 旧：{old}\n新：{new}`（展示层折单行时序记）
- `JSON_FIELD`：`[字段 {jsonPath}] 旧值：{old}\n新值：{new}`
- `STATUS_CODE`：`[HTTP 状态码] {old} → {new}`
- 同一口径将出现在三处：后端 `buildDiff`（触发 prompt）、桌面抽屉、admin Tab。建议把格式化函数放到 `shared/contracts/src/signal.ts`（桌面与 admin 均已从 `@mao/contracts` 引入哨兵枚举），两端共用一份，避免各自实现后文案漂移；后端 prompt 侧继续用 `buildDiff` 原文，不改其输出。

## 6. 落地清单

| # | 动作 |
|---|---|
| 6.1 | 新迁移 V183：`signal_watcher_check` 加 `old_value_snippet` / `new_value_snippet VARCHAR(1024) NULL`；新迁移 V184：`signal_watcher` 加 `last_change_old_snippet` / `last_change_new_snippet VARCHAR(1024) NULL`（当前最新 V182，顺延取 V183 / V184） |
| 6.2 | `signal.repository.ts`：`updateHash` 扩为 `updateValue(id, { valueHash, oldValueSnippet, newValueSnippet })`；`markChecked` 增补 `lastChangeOldSnippet` / `lastChangeNewSnippet` 可选入参；**补 `update()` 里遗漏的 `lastValueSnippet` 字段映射（存量缺陷，见 5.7）** |
| 6.3 | `watcher.service.ts`：`runCheck` 在 436 行判定值算出点同写 check 行两列；变化触发成功路径把新旧值对传给 `markChecked`；`toView` 透出三字段 |
| 6.4 | checks 两端点（桌面 + admin）行 VO 新增 `oldValueSnippet` / `newValueSnippet`；后端 `SignalWatcherCheck` 与两端前端镜像类型补 |
| 6.5 | watchers 两端点（桌面 + admin）行 VO 新增 `lastValueSnippet` / `lastChangeOldSnippet` / `lastChangeNewSnippet`；桌面 `SignalWatcherView`、admin `WatcherRow` + `CheckRow` 类型补 |
| 6.6 | 桌面 checks 抽屉「详情」列人读化（含「触发失败」行的第三态） |
| 6.7 | admin checks Tab「详情」列同口径人读化 |
| 6.8 | 桌面/admin 哨兵列表卡「上次变化：旧 → 新」一句；文案函数抽到 `shared/contracts/src/signal.ts` 两端共用 |
| 6.9 | 用户手册同步 `skills/mao-cli/reference/signal-watcher.md`（轮询记录字段表补两列 + 列表卡说明） |
| 6.10 | CHANGELOG（用户可见：轮询记录与列表卡可读化） |
| 6.11 | 提案 `docs/proposals/2026-11-04-signal-watcher-check-value-compare.md` §5 的「数据库迁移：无（零迁移）」已被本方案修订，需在提案上标注，避免后续有人拿提案当依据按零迁移实施 |

## 7. 测试要点

1. **后端（单测）**：`changed=1` 的行回出 `oldValueSnippet` / `newValueSnippet` 均非空，且 `oldValueSnippet` 等于上一轮的值、`newValueSnippet` 与 `buildDiff` 的 `newSnippet` 字面一致（`truncate(·, 500)`）；未变行与首轮建基线的行 `newValueSnippet` 非空、`oldValueSnippet` 为 NULL；探针失败 / 判定失败行两者为 NULL；「触发失败」行 `error` 非空且两列非空。
2. **旧值来源正确性**：旧值必须取自 `runCheck` 开头那份与 `lastValueHash` 比对的同一快照。构造「探针在途期间用户编辑判定字段」用例，旧值侧不得变成编辑后的值（即不能改用 473 行复读的 `fresh`）。
3. **桌面抽屉**：`changed=1` 显示「旧值 → 新值」；`error` 行继续展示 error 文本 + 失败弱强调色，其中 `changed === 1` 的 error 行附新旧值对；未变行显示新值；两列为 NULL（上线前历史行）时回落 `—`。
4. **admin checks Tab**：同列名、同文案格式；字段为 NULL 时显示 `—`；其他列不受影响。
5. **列表卡「上次变化」**：桌面 + admin 两边都显示一句；取值来自 watcher 行的 `lastChangeOldSnippet` / `lastChangeNewSnippet`；从未变化 / 基线重置 / 重新启用后为 NULL 时整句不渲染；哨兵暂停后两句仍在（暂停不清片段）。
6. **回归**：特性差异在于「回出新字段」，判定逻辑（HASH/JSON_FIELD/STATUS_CODE）不改，`{diff}` 占位不变；`lastValueSnippet` 的写入语义不变。**`repo.update` 补 `lastValueSnippet` 映射后，基线重置 / 重新启用必须真的把片段清空**（现有 spec 对此零覆盖，是本次补的回归）；`markChecked` 新入参缺省时行为不变（未变 / 建基线路径不写 `last_change_*`）。
7. **前端类型**：`SignalWatcherCheckView` / `SignalWatcherView` / `WatcherRow` / `CheckRow` 补齐后，desktop 与 admin 各跑一次 `npm run build`（`vue-tsc -b && vite build`）确认通过。

## 8. 风险与对策

| 风险 | 对策 |
|---|---|
| `new_value_snippet` 长度不受控把行撑高 | 存 `truncate(·, 500)`（与 prompt 同口径）+ 展示 `show-overflow-tooltip` + 行宽 140~240px 之间，文字色调不变（同提案风险表） |
| 敏感值在列表透出到非属主 | 字段已属主端点内回读（admin 按 `signal:read`、desktop 按本人 watcher），与现有 `valueHash` 同 Exposure，门不变 |
| **暴露面升级（本次新增）**：`lastValueSnippet` 此前只服务于后端 `{diff}`，任何 VO 都没回过；透出到 watchers 列表端点等于把「最新响应体片段」（HASH 模式即响应体原文，可能含 token）从「只有哈希」升级为「明文片段」 | 属主 / `signal:read` 门不变，不构成越权；但这是暴露面升级而非「原样不动」，需在评审时明确接受。若要收敛，可只透 `lastChangeOldSnippet` / `lastChangeNewSnippet`（同样是明文）——二者都绕不开，故接受并写入 CHANGELOG 说明 |
| 上线前的历史 check 行两列为 NULL | 抽屉回落 `—`（与现状 `valueHash.slice` 一致）；列表卡两句为 NULL 时整句不渲染。**不做回填**——旧行的旧值在数据模型里从未落库，不可恢复 |
| 三处文案（后端 prompt / 桌面 / admin）各写一份导致漂移 | 格式化函数抽到 `shared/contracts/src/signal.ts` 两端共用，见 §5 文案口径 |
