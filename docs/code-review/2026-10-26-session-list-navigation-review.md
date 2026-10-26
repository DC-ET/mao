# 会话列表与长会话导航 —— 代码审查报告（0.0.351）

> 审查对象：`feat/session-list-navigation` 分支两个提交
> - `b412de36` refactor(backend): 移除会话收藏与置顶（V173）与两 CLI 同步拆除
> - `d2a26e12` feat(desktop): 会话列表与长会话导航（标题过滤/批量归档/轮次目录/只看回复）
>
> 基线：`main` = `75a87ede`。审查命令：`git diff main..HEAD`。
> 技术方案：`docs/plan/2026-10-26-session-list-navigation-technical-design.md`（§9 风险 C1–C15 / §11 评审补充仅作线索，结论以代码与测试为准）。
> 方法：只读代码 + 为每个疑似 bug 编写 `.reviewverify.test.ts` 复现（跑失败才计入）；未修改任何 src 产品代码、未 commit。

## 结论摘要

| # | 严重度 | 问题 | 复现 |
|---|---|---|---|
| 1 | 中 | 过滤切换与在飞的「展开更多」响应无顺序护栏：旧 keyword 的分页结果并入新过滤列表，组元数据被覆盖 | 已复现（失败） |
| 2 | 低 | `archiveSessions` 把归档区静默刷新的失败冒到调用方：无 toast、不退出选择态、unhandled rejection | 已复现（失败） |
| 3 | 低 | 多选模式下右键「删除」走进死路：行内确认按钮宿主被 `!selecting` 隐藏，无任何可见反馈 | 已复现（失败） |

另：已用测试验证为**正确**的面（见文末「已验证无问题的面」）——后端 pin/favorite 拆除、listKeyword 三条 fetch 路径与 WS 重连接口、archiveSessions 的 targets 过滤/锁语义/计数/投影迁移、bumpGroupMetaForSession 的 loadedDelta（C5）、reset 清理、过滤防抖/清空/Esc/Enter、多选行点击与运行中禁用、批量归档确认流、RoundDirectory 浮层开闭与定位、replyOnly 各渲染分支（含 §11.2-6a/b 两条边缘）、scrollToTop 的 programmatic 记账。

---

## Bug 1：过滤切换与在飞的「展开更多」响应竞态，旧 keyword 结果污染新过滤列表

**位置**

- `desktop/src/stores/session/list.ts:173-226`（`loadMoreInGroup`，缺请求代次护栏）
- 关键行：`:197`（`const existingIds = new Set(standardSessionIds.value)`）、`:207`（`standardSessionIds.value = [...standardSessionIds.value, ...appendedIds]`）、`:211-218`（`groupMeta` 被本响应整体覆盖，`loadedCount: offset + items.length`）

**问题描述**

`fetchSessions` / `fetchArchivedSessions` / `fetchFocusSessions` 都有 `seq` 代次护栏（`fetchSessionsSeq` 等），迟到响应直接丢弃；唯独 `loadMoreInGroup` 只有 `loadingMoreGroups` 并发锁、没有代次护栏。本次新增的标题过滤让 `fetchSessions()` 变成高频动作（每次防抖 300ms 一次），于是出现下面这条链：

1. 用户点「展开更多」，`loadMoreInGroup` 发出请求（在飞）；
2. 用户改过滤词 → `applyFilter` → `setListKeyword('b')` → `fetchSessions()` 先把分组预览换成只匹配 `'b'` 的结果（`standardSessionIds` / `groupMeta` 全部重建）；
3. 旧 keyword `'a'` 的「展开更多」响应此刻到达：`appended` 直接追加进**已被替换过**的 `standardSessionIds`，并用旧分页口径（`offset + items.length`）整体覆盖该组的 `loadedCount` / `total` / `hasMore`。

后果有两层：
- 不匹配当前 keyword 的会话出现在过滤结果里（用户看到「过滤失效」）；
- 组元数据回到旧 keyword 的口径（`loadedCount` 偏大），后续「展开更多」的 offset 以此为基准，会把匹配新 keyword 的会话整段跳过（漏条）。

需要说明的是：`loadMoreInGroup` 缺代次护栏是既有问题（手动刷新 / 恢复归档同样能触发），但本次过滤功能把它从「需要手动刷新恰好撞上」变成「改个过滤词就能撞上」，且 300ms 防抖意味着只要服务端该分页请求慢于 300ms（远端 / 负载高时常见）就成立，故按本次需求引入的可达缺陷计入。

**复现测试**

路径：`desktop/src/stores/session-list-reviewverify.test.ts`
用例：`REVIEWVERIFY: 过滤竞态——在飞的 loadMoreInGroup 结果并入新过滤列表 > 旧 keyword 的分页响应到达时，把不匹配新 keyword 的会话并入标准投影`

运行：`cd desktop && npx vitest run src/stores/session-list-reviewverify.test.ts`

失败输出：

```
 FAIL  src/stores/session-list-reviewverify.test.ts > REVIEWVERIFY: 过滤竞态——在飞的 loadMoreInGroup 结果并入新过滤列表 > 旧 keyword 的分页响应到达时，把不匹配新 keyword 的会话并入标准投影
AssertionError: expected [ '3', '5', '6' ] to deeply equal [ '3' ]

- Expected
+ Received

  [
    "3",
+   "5",
+   "6",
  ]

 ❯ src/stores/session-list-reviewverify.test.ts:87:38
```

（同用例还断言了组元数据应保持新过滤视图的 `{total: 1, loadedCount: 1}`；实测被旧响应覆盖为 `{total: 4, loadedCount: 4, hasMore: false}`——因第一个断言先失败即止，未在失败输出中体现，值为临时打开该断言后实测所得。）

**影响面 / 严重度**

- 影响：标准模式分组列表。过滤生效后列表混入不匹配项、组计数与「展开更多」分页错乱；需要再改一次过滤词或手动刷新才能自愈（`fetchSessions` 会重建）。
- 触发条件：改过滤词时正好有该组的「展开更多」请求在飞（请求耗时 > 300ms 防抖窗口时概率显著上升）。
- 严重度：**中**（结果错误 + 分页漏条，但可自愈、不写坏服务端数据）。
- 建议方向：给 `loadMoreInGroup` 加与三个 fetch 一致的代次护栏（如 `loadMoreSeq`，或请求发起时记下当前 `listKeyword`，响应回来时比对不一致即丢弃）。

---

## Bug 2：`archiveSessions` 把归档区静默刷新的失败冒到调用方，批量归档「成功但无反馈、退不出选择态」

**位置**

- `desktop/src/stores/session/list.ts:375-382`，关键行 `:380`：`if (archivedLoaded.value) await fetchArchivedSessions(true)`
- 调用方：`desktop/src/components/task/TaskIndexPanel.vue:392-415`（`confirmBatchArchive`）

**问题描述**

`archiveSessions` 逐条归档的失败被 `catch {}` 吞掉（「失败保留原位」原则），但循环之后的归档区静默刷新 `await fetchArchivedSessions(true)` **没有任何错误处理**，而 `fetchArchivedSessions` 自身只有 `try/finally`、没有 `catch`。于是归档区刷新一旦失败（网络抖动等）：

- 异常从 `archiveSessions` 冒出 → `confirmBatchArchive` 的 `await sessionStore.archiveSessions(ids)` 抛出；
- `finally` 只把 `batchArchiving` 置回 false，其后三条 `ElMessage` 提示与 `exitSelectMode()` **全部不执行**；
- `@click="confirmBatchArchive"` 未 `void` 包裹 → unhandled rejection。

用户视角：点了「归档」、也确认了，界面没有任何 toast、底部操作条和勾选态原样不动——而归档其实已成功（本地投影在刷新前已完成迁移，服务端也已落库），用户会以为失败并重点一次，造成重复归档。对照：单条 `archiveSession` 对同一失败是整体 `try/catch` 吞掉的（`list.ts:318-341`），两条路径语义不一致。

**复现测试**

路径：`desktop/src/stores/session-list-reviewverify.test.ts`
用例：`REVIEWVERIFY: 批量归档——归档区静默刷新失败时抛出 > 归档成功后归档区刷新失败：archiveSessions 抛出（调用方退出选择态/提示全部落空）`

运行：`cd desktop && npx vitest run src/stores/session-list-reviewverify.test.ts`

失败输出：

```
 FAIL  src/stores/session-list-reviewverify.test.ts > REVIEWVERIFY: 批量归档——归档区静默刷新失败时抛出 > 归档成功后归档区刷新失败：archiveSessions 抛出（调用方退出选择态/提示全部落空）
AssertionError: expected Error: network down to be null

- Expected:
null

+ Received:
Error {
  "message": "network down",
}

 ❯ src/stores/session-list-reviewverify.test.ts:122:20
```

（用例中断言 `archiveSessions` 不应抛出；若按「与单条同口径」修复，则该断言转绿。）

**影响面 / 严重度**

- 影响：标准模式批量归档。仅错误路径触发；归档数据本身正确（本地投影 + 服务端均已迁移），丢的是 toast 提示、选择态退出与异常冒泡。
- 严重度：**低**（需归档区刷新恰好失败；后果是误导性「无反馈」与可能的重复点击）。
- 建议方向：把归档区刷新包进 `try/catch`（静默失败即可，归档结果以本地投影为准），或在 `confirmBatchArchive` 内对 `archiveSessions` 的异常补一条错误提示并仍执行 `exitSelectMode()`。

---

## Bug 3：多选模式下右键「删除」走进死路——行内确认宿主被隐藏，无任何可见反馈

**位置**

- `desktop/src/components/task/TaskSessionGroupList.vue:143`：`<div v-if="showItemActions && !selecting" class="session-item-actions">`（本次为选择态新增 `&& !selecting`）
- `desktop/src/components/task/TaskIndexPanel.vue:543-553`（`menuDelete`）：面板宽度 ≥200px（`showItemActions` 为真）时走 `confirmingDeleteId.value = id` 的行内确认分支

**问题描述**

行内「确认删除 / 取消」按钮**只**存在于 `.session-item-actions` 内，而该容器在选择态被整体隐藏。但右键菜单本身在选择态仍可打开（`@contextmenu.prevent` 未门控），且菜单里只有「归档」被按 C13/C14 禁用，「删除」仍是可点的。于是在选择态（面板 ≥200px，桌面常见形态）右键 → 删除：

- `menuDelete()` 把 `confirmingDeleteId` 置为该会话 id；
- 没有任何可见 UI 承接这个状态（行内按钮被 `!selecting` 隐藏），既无确认入口、也无取消入口；
- 用户看不到任何反馈，只能退出选择态（Esc / 取消）后，行内确认按钮才「延迟出现」，删除才能继续完成。

即：一个看起来可用的菜单项，在选择态下静默失效。对照组（`selecting=false`）同一 `confirmingDeleteId` 有可见的确认/取消按钮，证明差异由本次新增的 `&& !selecting` 引入。

**复现测试**

路径：`desktop/src/components/task/select-mode-delete-deadend.reviewverify.test.ts`
用例：`REVIEWVERIFY: 选择模式下右键删除无可见确认宿主 > selecting=true 时 menuDelete 写入的 confirmingDeleteId 也应有可见宿主`（对照组：`selecting=false 时 confirmingDeleteId 有可见的确认/取消按钮`，通过）

运行：`cd desktop && npx vitest run src/components/task/select-mode-delete-deadend.reviewverify.test.ts`

失败输出：

```
 FAIL  src/components/task/select-mode-delete-deadend.reviewverify.test.ts > REVIEWVERIFY: 选择模式下右键删除无可见确认宿主 > selecting=true 时 menuDelete 写入的 confirmingDeleteId 也应有可见宿主
AssertionError: expected '<!--[--><div class="session-group" dr…' to contain '确认删除'

Expected: "确认删除"
Received: "<!--[--><div class="session-group" draggable="true">…<div data-session-id="1" class="active confirming-delete session-item"><div class="session-item-main"><input type="checkbox" class="session-select-checkbox" title=""><span class="session-title">任务一</span></div><div class="session-item-meta">…</div><!----></div>…"

 ❯ src/components/task/select-mode-delete-deadend.reviewverify.test.ts:109:18
```

（渲染输出可见该行 `class="active confirming-delete session-item"` 已带上确认态样式，但 `.session-item-actions` 整块不渲染——`<!---->` 占位，确认/取消按钮无处可点。）

**影响面 / 严重度**

- 影响：标准模式多选态下的右键删除。可恢复（退出选择态后确认按钮出现），但过程中无任何反馈，用户会反复右键重试。
- 严重度：**低**（交互死路，不丢数据）。
- 建议方向：选择态下把右键「删除」也置灰（与「归档」同口径），或让 `menuDelete` 在选择态改走 `deleteSessionViaDialog` 弹窗路径。

---

## 已验证无问题的面（测试通过，未计入 bug）

以下均编写了复现/对照测试并跑绿（同一批 `.reviewverify.test.ts` 文件，共 27 条通过）：

- **后端 pin/favorite 拆除自洽**：`V173` 为最新迁移、两列自 `V001` 创建后无迁移触碰；`listSessions` / `listSessionsByGroup` 两处 ORDER BY 与 `compareSessions` 均已去 pin 且统一「活跃相位 > 更新时间 > id」（`ACTIVE_PHASE_SQL_LIST` 含 CANCELLING）；`baseSessionListQuery` 三条入口（groups / 分页 / 全量）都透出 keyword；全仓（backend / admin / desktop / agent-cli / mao-cli）无 `isPinned` / `is_favorite` 残留；`backend-ts` / `admin` / `agent-cli` build + 单测、`desktop` `vue-tsc -b --force` 全绿。
- **listKeyword 单一状态源**：空串不传参数、三条 fetch 路径统一带 keyword、归档区不参与过滤、`reset` 清空（作者既有单测覆盖，本review 复跑通过）。
- **archiveSessions**：四相位跳过并计数、部分失败成功者迁移/失败者留原位、组计数与 loadedCount 逐条扣减（C5）、归档区只静默刷新一次、聚焦投影同步移除、锁跳过者计数口径；补充验证了跨两组分别扣减、批量归档后「展开更多」offset 不漏条不重条（C5 端到端）。
- **过滤交互**（jsdom 真实挂载 TaskIndexPanel + 真实 TaskSessionGroupList）：300ms 防抖后 `setListKeyword` + `fetchSessions`、清空一键还原、Esc 只收起输入行且不重新请求、Enter 立即生效并取消挂起防抖、聚焦模式走 `fetchFocusSessions`、非选择态行点击 = 打开会话。
- **多选交互**：进入选择态渲染底部操作条、Esc 退出、聚焦模式无多选入口、行点击 = 勾选/取消、运行中（RUNNING）行复选框禁用且点行不选中、批量归档确认后 `archiveSessions(['1','2'])` + toast「已归档 2 个，1 个跳过」+ 退出选择态、取消确认框不发起归档且选择态保留。
- **轮次目录**：点把手开浮层、点行 `emit('locate', 'u2')` 并收起、Esc 收起、点外部收起、把手自身 toggle 不误触外部关闭、有历史轮才渲染把手、执行中只剩一轮不渲染把手、目录行数据取自 `historyRounds`（空闲含最后一轮、执行中不含）。
- **只看回复**（SSR 渲染 ChatRoundList / MessageBubble）：`replyOnly=true` 时折叠摘要行（「已执行 N 个步骤」）与对话主干保留、工具卡片整段隐藏（含最终回复内嵌 toolCalls 的 §11.2-6b 边缘）、无步骤轮的思考块随 `hideThinking || replyOnly` 隐藏（§11.2-6a）；`activeRound` 不参与过滤。
- **回到顶部**：`scrollToTop` 的 programmatic 记账不误触上滑分页、回顶后停止跟随、内容塌陷不误判上滑（作者既有单测覆盖，本review 复跑通过）。

## 本次审查创建的测试文件（供清理）

均为 `.reviewverify.test.ts` 后缀的新文件，未改动任何 src 产品代码、未 `git add` / commit：

- `desktop/src/stores/session-list-reviewverify.test.ts`
- `desktop/src/components/task/select-mode-delete-deadend.reviewverify.test.ts`
- `desktop/src/components/task/task-index-panel-filter.reviewverify.test.ts`
- `desktop/src/components/chat/chat-nav-reviewverify.test.ts`
- `desktop/src/components/chat/round-directory-interaction.reviewverify.test.ts`

一次性复跑（3 失败 = 上述 3 个 bug，其余通过）：

```
cd desktop && npx vitest run \
  src/stores/session-list-reviewverify.test.ts \
  src/components/task/select-mode-delete-deadend.reviewverify.test.ts \
  src/components/task/task-index-panel-filter.reviewverify.test.ts \
  src/components/chat/chat-nav-reviewverify.test.ts \
  src/components/chat/round-directory-interaction.reviewverify.test.ts
```
