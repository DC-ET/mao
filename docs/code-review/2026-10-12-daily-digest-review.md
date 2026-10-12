# 每日运营摘要（Daily Digest）代码审查报告

- 日期：2026-10-12
- 工作区：`/Users/yangjiayi/AiProjects/mao/.worktrees/daily-digest`（分支 `feat/daily-digest`）
- 审查对象：`git diff 2e85554d c60657fc`（commit `c60657fc`，父 `2e85554d`）
- 对照基准：`docs/plan/2026-10-12-daily-digest-technical-design.md`
- 基线：后端全量 294 文件 / 3645 用例绿（未改动任何被审查功能代码与既有 spec；仅新增审查探针）

## 结论摘要

- 确认 **1 个功能逻辑 bug**（已用失败探针证明）：`renderDigestLine` 在「哨兵板块仅有停用、无触发」时浓缩一行为空。
- **1 个待确认观察**（未用失败单测证明，需产品决策）：决策 11「默认开」对从未改过设置的用户不生效（无偏好行 → 永不调度）。

---

## Bug 1（中）：哨兵 disabled-only 时收件箱浓缩一行为空

- **位置**：`backend-ts/src/digest/service.ts:237`
- **问题描述**：`renderDigestLine` 对 watchers 板块的渲染门控是 `data.watchers.triggered > 0`：
  ```ts
  if (data.watchers != null && data.watchers.triggered > 0) parts.push(`哨兵触发 ${data.watchers.triggered}`);
  ```
  但 `aggregate` 判定 watchers 板块非空的条件是 `triggered > 0 || disabled.length > 0`（`service.ts:100`）。两处门控不对称：当昨天唯一的运营事实是「哨兵被连续失败自动停用」（`WATCHER_DISABLED`，`triggered=0`、`disabled` 非空）时，watchers 板块非 null（摘要非安静日、正常投递），但浓缩一行**不输出任何哨兵片段**。若此时其余五板块全空，整行 `parts` 为空 → `renderDigestLine` 返回空串。
- **影响面**：
  - 收件箱条目 `content` 为空串（`processUser` 里 `content: clip(line, CONTENT_MAX)` → `''`），列表层 `<p v-if="item.content">` 不渲染，用户只看到标题、看不到任何摘要文字，必须点开详情对话框才能发现「哨兵已停用」。
  - 试发（send-now）返回的 `line` 为空串，桌面 toast 回退到通用文案「昨日摘要已写入收件箱」，丢失浓缩统计。
  - 出站 `text`（`renderDigestMarkdown`，`service.ts:258-260`）**不受影响**——它对 `watchers != null` always 渲染「触发 0 次」+「已自动停用：xxx」。故缺陷仅限收件箱一行的呈现。
- **触发场景**：用户的一个信号哨兵因目标不可达连续失败被自动停用（产生 `WATCHER_DISABLED` 通知），且该窗口内无任何 `changed=1` 触发；同时昨天没有任务成败、定时任务执行、审批挂起、成本、开放接口调用。这是最该被日报提醒的运维信号之一，却在列表层被完全隐藏。
- **探针测试**：`backend-ts/src/digest/zz-review-probe.spec.ts`（2 个用例均失败）
  - 失败输出摘要：
    ```
    AssertionError: expected '' not to be '' // Object.is equality
    ```
    两个断言（`renderDigestLine(...)` 与 `processUser` 写入条目的 `content`）均得到空串 `''`，与「应含哨兵信息」的期望相悖。
- **建议修复方向**（不动手）：让浓缩行对「有数据的板块」都产出片段，与 `aggregate` 的非空判定对齐。例如在 `renderDigestLine` 中，当 `data.watchers != null` 时除 `哨兵触发 ${triggered}`（triggered>0 时）外，追加 `哨兵停用 ${data.watchers.disabled.length}`（disabled 非空时）。修复后应为本场景补一条既有 spec 断言（一行非空且含哨兵信息），并保留现有 `triggered>0` 用例。

---

## 观察 1（待产品确认，非失败单测证明）：决策 11「默认开」对无偏好行用户不生效

- **位置**：`backend-ts/src/digest/repository.ts:27-33`（`listEnabledUsers` 仅 `WHERE enabled=1`）、`backend-ts/src/digest/service.ts:195`（`upsertPreference` 唯一写入口，仅 PATCH 触发）、`backend-ts/db/migration/V150__user_digest_preference.sql`（无回填）。
- **问题描述**：调度器只遍历 `user_digest_preference` 中 `enabled=1` 的行；而该行**只有用户显式 PATCH 设置后才会被 `upsertPreference` 创建**。既没有 V150 回填，也没有注册/上线时的 bootstrap 建行。因此：
  - 新注册用户、升级后的存量用户只要从未打开并改动过摘要设置，就没有偏好行 → 永远不进调度 → 永远收不到日报。
  - 但桌面设置页 GET 回落默认值（`enabled=true`），UI 显示功能「已开启」——默认开是假象。
- **与既有模式的分歧**：决策 11 明确「对齐收件箱多数 kind 默认开的模式」。收件箱的通知是**事件驱动 + `isKindEnabled` 读时默认**（无行也默认开，见 `inbox.service.ts:503`），所以新用户无偏好行也能收到通知；而摘要是**调度驱动 + 靠行存在**，「读时默认」在调度入口不适用。二者模式不同，导致默认开落空。
- **证据**（静态，非失败单测）：`grep` 确认除 `service.savePreferences`→`upsertPreference`（仅 PATCH）外无任何 `INSERT INTO user_digest_preference`；V150 仅建表无回填；无注册/bootstrap 钩子建行。此缺陷是「缺失建行/回填」而非被审查代码里的逻辑错误，故难以用单测「跑失败」证明，需产品决策。
- **建议修复方向**（不动手，二选一或组合）：
  1. 加 bootstrap/回填：为所有存量用户与每个新注册用户插入一条默认（`enabled=1, push_time='09:30', outbound_enabled=1`）的 `user_digest_preference` 行；
  2. 或改调度入口为「遍历所有用户 + 读时默认 enabled」，对齐收件箱 `isKindEnabled` 的默认开口子。

---

## 审查探针文件清单

- `backend-ts/src/digest/zz-review-probe.spec.ts`（证明 Bug 1；修复后可删）

## 已覆盖且未发现问题的审查面

- 窗口半开区间 `[start, end)` 与 Asia/Shanghai 昨天口径（`service.ts` 的 `aggregate`、`common/json.ts` 的 `addDaysYmd`/`shanghaiYmd`/`formatDateTime`，含跨月/跨年推算）。
- 六板块聚合 SQL：归属 JOIN、`GROUP BY`、字段映射（TASK_COMPLETED/FAILED、COMPLETED/FAILED、rejected）、mysql2 字符串强转、审批挂起无窗口、成本 NULL 行剔除合计仅计 unpriced、Top3 与 micros=0 不进 Top、agent 名回填与「未关联 Agent」回落。
- 调度器：`hm < pushTime` 字符串比较、`last_digest_date === 昨天` 防重、停机跨天补发、单用户异常隔离、`stopped` 语义。
- 试发（force）：跳过 enabled 门控与推送时间、不写 `last_digest_date`、安静日返回 QUIET、同日覆盖（`insertOrUpdateByDedupKey` 打回未读）。
- `markProcessed` 单调不回退；`getPreferencesView` 三态（PENDING/SENT/QUIET）。
- 出站 `dispatchDigest`：双格式 payload、fire-and-forget 不抛、结构对齐 `dispatchTaskTerminal`、无订阅静默跳过。
- 路由：登录态、`pushTime` 非法值（`25:00`/`9:5`/空/非字符串）走 `PARAM_INVALID`（HTTP 200 + code≠0）、增量合并不落库、send-now 不推进标记。
- 暂停/停兵标题前缀剥离标记与真实写入点一致（`定时任务已自动暂停：` / `信号哨兵已自动停用：`）。
- 桌面：`digest-payload.ts` 防御性解析（已测）、`KNOWN_INBOX_KINDS` 含 `DAILY_DIGEST`（已测）、`InboxDrawer` 点击分支（摘要开对话框、其余走 `session_id`、均先标记已读）、`DigestDetailDialog` 六板块渲染与行内跳转、`NotificationSettingsView` 增量 PATCH/回滚/无订阅禁用/三态状态行、`UsageBell` 跨组件打开用量抽屉。

> 说明：桌面 `.vue` 组件无单测基建（vitest 为 node 环境、仅 `*.test.ts`、无 `@vue/test-utils`），故桌面仅能审查纯逻辑（`digest-payload.ts`/store/api），组件交互以上述通读为准。
