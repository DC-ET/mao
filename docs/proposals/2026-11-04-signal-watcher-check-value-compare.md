# 提案：哨兵「变化」点进去只看到哈希 —— 轮询记录的值的对比

> 信号哨兵轮询记录里，「详情」列只展示 `valueHash` 的一小段切片或 `error`。用户想回答「到底变了什么」的问题仍然要去猜：变的是哪个字段、旧值多少、新值多少。要回答「为什么会被触发」，记录里只有一句「变化」——与同批的失败原因透出（`errorSummary`）断点同构：后端早就存了值，只是没有展示。

- 状态：已落地（见 [README](README.md)）
- 日期：2026-11-04
- ⚠️ **§5 的「数据库迁移：无（零迁移）」已由技术方案修订**：旧值无现成落点（`lastValueSnippet` 是单值、每轮被覆盖，读取时与新值是同一个字符串），必须新增两条迁移 `V183__signal_watcher_check_add_value_snippets.sql` / `V184__signal_watcher_add_last_change_snippets.sql`，见 [docs/plan/2026-11-04-signal-watcher-check-value-compare-technical-design.md](../plan/2026-11-04-signal-watcher-check-value-compare-technical-design.md)。后续勿按本提案「零迁移」实施。
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（轮询记录抽屉的「详情」可读化；约 1 人日；零迁移）
- 关联：`backend-ts/src/signal/types.ts`（`SignalWatcherCheck` / `SignalWatcher`）、`desktop/src/views/settings/SignalWatchersView.vue`（checks 抽屉 `SignalWatcherView:190-250`）、`admin/src/views/signal/SignalWatcherListView.vue`（checks Tab `141-180`）

## 1. 背景与现状

### 1.1 已有积木全在，唯独缺「值与值之间」（代码可查）

| 能力 | 现状 | 代码证据 |
|---|---|---|
| 轮询记录存储 | ✅ `signal_watcher_check` 有 `value_hash` / `changed` / `http_status` / `triggered_session_id` / `error` / `warning` / 耗时；watcher 行有 `last_value_hash` / `last_value_snippet` / `last_checked_at` / `last_changed_at` | `types.ts:19-55` |
| 哨兵值片段的真实使用者 | ✅ `lastValueSnippet` 注释写明「供 `{diff}` 旧值侧使用」——触发会话的 prompt 里已经有旧值与新值侧，轮询记录抽屉里却没有 | `types.ts:26-28` |
| 桌面 checks 抽屉 | ❌ 详情列只显示 `error \|\| valueHash.slice(0,12)`，无旧值与失败原因的人读展示 | `SignalWatchersView.vue:218-228` |
| 管理后台 checks Tab | ❌ 同一情况：`checks` 表展示 `checkedAt` / `httpStatus` / `changed` 等，未把片段人读化 | `SignalWatcherListView.vue:141-180` |
| 对照：失败原因透出 | ✅ 本批提案一（`errorSummary` 透出）正是同构手法——「后端早写了、展示层未读」 | — |

### 1.2 真实痛点

1. **「变化」只是一个徽标**：用户点进 checks 表只看到「变化 1 行」，判断「这个变化是否值得去处理」必须再点进触发会话读 prompt——而 trigger 会话的 prompt 已经机构了值的对比，只是展示层不给对照。
2. **失败只看一行 error**：哨兵检查失败时只给 `error` 一句话，没有「上一次正常值是多少、这次错在这儿」的关系——用户分不清是接口挂了还是接口值本身坏了。

## 2. 目标 / 非目标

**目标**

1. **轮询记录「详情」列的 value 可读化**：`changed === 1` 的行，详情列展示「{上次片段} → {本次值哈希对应值}」——值侧取 `{diff}` 本次的新值；`error` 行继续展示 error 文本 + 失败分类弱强调色。桌面 checks 抽屉 + admin checks Tab 同列名口径。
2. **（低成本增项）哨兵列表卡透出上次变化的 {diff}**：在 `SignalWatchersView` 与 admin 列表的 `lastChangedAt` 旁边给一行上次变化的片段人读显示（如「20 → no fall」），方便不打开抽屉就看一眼为什么会变化。

**非目标**

- 不改哨兵探针的判定逻辑（`HASH` / `JSON_FIELD` / `STATUS_CODE` 三模式的比对方式不动）。
- 不改 `{diff}` 模板占位语义（后端已在用）。
- 不新增触发器关联（不做「变化→点到会话」的跳转——结果徽标再展示）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 失败任务重跑（归因与续跑，2026-11-04 已驳回） | 不做归因分型，只是把已有的轮询记录详情人读化。 |
| 信号哨兵对话内配置（2026-10-25 已驳回） | 不新加 watcher 工具组，只做记录展示的最后一公里。 |

## 4. 方案设计

### 4.1 后端（仅确认字段已在 VO）

- **零新查询**：checks API 已回 `error` / `valueHash`，watcher 行已回 `lastValueSnippet` / `lastValueHash`（`signal-admin.routes.ts:68` 刷新了）；仅确认桌面/admin checks VO 的值片段展示不需要新增列。
- 仅在 VO 里 `lastValueSnippet` 同步自后端已在用的 watcher 字段（若桌面 VO 已有则不动）。

### 4.2 桌面 checks 抽屉与 admin checks Tab

- `详情` 列：`changed === 1` 显示「旧值片段 → 新值」；`error` 保留现状；其余未变行显示新值。
- 写法：抽屉表格列用 `show-overflow-tooltip`，长度 140~240px 之间，文字色调不变。

### 4.3 哨兵列表卡一句上次变化

- `SignalWatchersView.vue` / `SignalWatcherListView.vue` 的 `lastChangedAt` 旁边加一句「（上次 20 → no fall）」；数据来自 watcher 行已回的 `lastValueSnippet` 与当前值字段。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | **无改动**（确认 VO 已有；若桌面/admin VO 缺 `lastValueSnippet` 则补一行透出） |
| desktop | `SignalWatchersView.vue` checks 抽屉「详情」列展示格式 + 列表卡一句「上次变化」 |
| admin | `SignalWatcherListView.vue` checks Tab「详情」列同列名口径加「上次变化」一句 |
| skills/mao-cli | 补桌面端说明（轮询记录现在能看到值的变化） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `lastValueSnippet` 长度不受控把行撑高 | `show-overflow-tooltip` + 长度 140~240px 截断 |
| 敏感值在列表透出到非属主 | 字段已属主端点内回读（admin 按权限、desktop 按本人 watcher），不变 |

## 7. 测试要点

1. checks 抽屉：「详情」列在变化/错误/未变三类行分别展示正确格式；行内列宽/Tooltip 无横向撑高。
2. 列表卡「上次变化」一句文案与桌面/admin 同参渲染正确。
3. 回归：判定模式（HASH/JSON_FIELD/STATUS_CODE）不改，触发会话的 `{diff}` 占位不变。

## 8. 待确认决策

1. 「详情」列的文案格式（「旧值 → 新值」点号格式 vs 冒号格式）——与 `{diff}` 占位风格一致即可。
2. 列表卡「上次变化」一句是否只在 admin 雷区展示还是桌面也展示——建议两边都展示（成本低、价值对齐）。
