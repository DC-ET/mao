# 会话列表与长会话导航 —— 第二轮代码审查报告（0.0.351 修复 971e8426）

> 审查对象：`git diff d2a26e12..971e8426`（`971e8426` fix(desktop): 修复代码审查发现的 3 个问题——分页竞态护栏 / 归档刷新冒泡 / 选择态删除死路）
> 第一轮报告：`docs/code-review/2026-10-26-session-list-navigation-review.md`（**未改动**，本轮为独立新文件）
> 方法：只读代码 + 为每个新疑似 bug 编写 `.reviewverify.test.ts` 复现（跑失败才计入）；未修改任何 src 产品代码、未 `git add` / commit、未跑完整 E2E。

## 结论摘要

三个修复的认定：

| 修复 | 认定 | 说明 |
|---|---|---|
| 1 `standardListEpoch` 代次护栏 | **对目标竞态有效，但护栏有单向缺口** | 第一轮实测修复前 `['3','5','6']`；固化测试断言 `['3']` + 组元数据 `{total:1, loadedCount:1}`，确由红转绿。但代次在 `fetchSessions` **入口**递增，覆盖不到「代次先变、loadMore 后发起、重建后落地」的时序 → 新 Bug 1 |
| 2 `archiveSessions` 归档区刷新 try/catch | **有效，未吞掉不该吞的** | `fetchArchivedSessions` 内部只有 `api.get` 拒绝会抛；`archiveSessions` 的返回值完全由 PUT 结果推导，与归档区刷新无关 |
| 3 `menuDelete` 选择态走确认弹窗 | **对原死路有效，但删除后勾选集不同步** | 弹窗路径本身可走通（对照测试通过）；`deleteSessionViaDialog` 成功后不剔除 `selectedIds` → 新 Bug 2 |

新发现问题：

| # | 严重度 | 问题 | 复现 |
|---|---|---|---|
| 1 | 中 | `standardListEpoch` 只护栏「发起后再重建」：静默重建在飞期间点「展开更多」，旧 offset 的分页响应仍并入新列表，第 21–40 条整段丢失且 `hasMore` 被置 false 无法再分页 | 已复现（失败） |
| 2 | 低 | 选择态右键删除（弹窗路径）成功后 `selectedIds` 残留：底部计数虚高，批量归档把已删除会话计为「跳过」，toast 口径错误 | 已复现（失败） |
| 3 | 低 | `fetchSessions` 请求**失败**也递增代次：在飞的合法「展开更多」被误丢弃，点击静默无效、无任何反馈 | 已复现（失败） |

新固化的 3 个测试文件（`RoundDirectory.test.ts` / `ChatRoundList.replyOnly.test.ts` / `task-index-panel-interaction.test.ts`）：**均非伪测试**（逐文件论证见第三节）；`session.test.ts` 新增的 4 条固化回归同样非伪测试（第一轮已在修复前代码上实测同样场景失败）。

---

## 一、三个修复的有效性认定

### 修复 1：`standardListEpoch`（`desktop/src/stores/session/list.ts:133` / `:137` / `:193` / `:200`）

有效部分：护栏确实压在第一轮 Bug 1 的修复点上——`loadMoreInGroup` 在请求发起时记下代次（`:193`），响应回来时不一致就 `return false`（`:200`），整条不并入、不覆盖组元数据。第一轮我在**修复前**的代码上用同一时序实测得到 `standardSessionIds = ['3','5','6']`、组元数据被旧响应覆盖为 `{total:4, loadedCount:4}`；固化测试用相同时序断言 `['3']` + `{total:1, loadedCount:1}`，说明断言随修复由红转绿，不是「恰好通过」。

但护栏是**单向**的，只回答「我发起之后有没有发生过重建」，回答不了「我发起之前刚发生过一次重建、它落在我之后」。这就是新 Bug 1（详见第二节）。另外代次递增与请求成败无关，引出新 Bug 3。

### 修复 2：归档区静默刷新 try/catch（`list.ts:393-401`）

有效，且吞的范围恰当：

- `fetchArchivedSessions` 自身只有 `try/finally`，会往外抛的只有 `api.get` 的拒绝（其余语句是纯赋值，`archivedLoading` 由 `finally` 复位）；
- `archiveSessions` 的返回值 `{ archived: succeeded.length, skipped }` 完全由循环内的 PUT 结果推导，**不依赖**归档区刷新结果，所以吞掉刷新失败不会让调用方（`confirmBatchArchive`）拿到错误计数或错误 toast；
- 与单条 `archiveSession` 的差异（单条是被外层 `catch` 吞、注释写「API 失败：本地不动」而投影其实已迁移）只是注释略失真，无功能影响——两条路径最终状态一致（投影已迁移、归档区列表滞后到下次刷新）。

### 修复 3：`menuDelete` 选择态走确认弹窗（`TaskIndexPanel.vue:550-553`）

有效：选择态 / 窄面板下 `confirmingDeleteId` 没有可见宿主（`.session-item-actions` 被 `showItemActions && !selecting` 门控，`TaskSessionGroupList.vue:143`），改走 `deleteSessionViaDialog` 后删除可以真正完成，第一轮的死路（静默失效、无反馈）已消除，对照组（非选择态仍走行内确认）也保住了。

遗留：弹窗路径成功后不同步勾选集 → 新 Bug 2。

---

## 二、新发现问题

### Bug 1：`standardListEpoch` 护栏缺口——静默重建在飞期间点「展开更多」，旧 offset 分页仍并入新列表

**位置**

- `desktop/src/stores/session/list.ts:133`（`let standardListEpoch = 0`）
- `:137`（`standardListEpoch++`，在 `api.get('/sessions/groups')` **之前**）
- `:190`（`const offset = meta?.loadedCount ?? 0`，读的是发起时刻的旧 meta）
- `:193` / `:200`（代次记录点与比对点）

**问题描述**

护栏只丢弃「发起**之后**发生过重建」的响应。但代次在 `fetchSessions` 入口（请求发出前）就递增，于是存在它覆盖不到的时序：

1. 用户在该分组已经展开过：`loadedCount = 40`（预览 20 + 一页 20）；
2. 用户在已归档区点某条的「恢复」→ `unarchiveSession` → PUT 成功 → `fetchSessions(true)` **静默**重建。`silent=true` 使 `loading` 保持 `false`，`TaskSessionGroupList` 不挂遮罩（`TaskSessionGroupList.vue:2` 的 `v-if="loading"` 不成立），分组列表与「展开更多」按钮在重建请求在飞的整个 RTT 窗口内**始终可点**；
3. 用户在该窗口内点「展开更多」：`offset` 取自旧 meta（40），`epoch` 取到的是**已经递增过的新代次**；
4. 重建先落地：`standardSessionIds` 重置为 20 条预览、该组 `loadedCount` 重置为 20；
5. 分页响应后到：`epoch === standardListEpoch` → 护栏放行 → 服务端第 41–60 条被追加到只有 20 条的新列表尾部，并用 `loadedCount = 40 + 20 = 60`、`total`、`hasMore = false` 覆盖组元数据。

后果：第 21–40 条从列表里彻底消失；`hasMore` 已被这个过期响应置为 `false`，不手动刷新就再也分页不回来；组 `loadedCount=60` 与投影实际 40 条不一致。与第一轮 Bug 1 同类（漏条 + 元数据错乱），只是时序从「重建后在飞」变成「重建前发起、重建后落地」。

可达性说明（为什么只有这一条路径）：四个 `fetchSessions` 调用方里，`TaskView.vue:1235`（onMounted）、`TaskIndexPanel.vue:332`（`applyFilter`）、`:1276`（`refreshSessions`）都是**非 silent**，`loading=true` 期间整个分组列表被 loading 遮罩替换，用户点不到「展开更多」；`list.ts:423`（`unarchiveSession`）是唯一的 silent 重建。WS 重连只走 `fetchFocusSessions`（`useStreamWS.ts:369`），不碰标准列表代次；批量归档失败也不触发 `fetchSessions`。因此触发条件是「点恢复」与「点展开更多」两个点击落在同一次 `/sessions/groups` 的 RTT 窗口内（远端 / 负载高时窗口为几十到几百毫秒）。

**复现测试**

路径：`desktop/src/stores/session-epoch-gap.reviewverify.test.ts`
用例：`standardListEpoch 护栏：代次在 loadMore 发起前就已递增的场景 > 静默重建在飞时点「展开更多」：旧 offset 的分页响应仍并入新列表（21-40 整段丢失）`

运行：`cd desktop && npx vitest run src/stores/session-epoch-gap.reviewverify.test.ts`

失败输出：

```
 FAIL  src/stores/session-epoch-gap.reviewverify.test.ts > standardListEpoch 护栏：代次在 loadMore 发起前就已递增的场景 > 静默重建在飞时点「展开更多」：旧 offset 的分页响应仍并入新列表（21-40 整段丢失）
AssertionError: expected [ '1', '2', '3', '4', '5', '6', …(34) ] to deeply equal [ '1', '2', '3', '4', '5', '6', …(14) ]
- Expected
+ Received
@@ -17,6 +17,26 @@
    "16",
    "17",
    "18",
    "19",
    "20",
+   "41",
+   "42",
…
+   "59",
+   "60",
  ]
 ❯ src/stores/session-epoch-gap.reviewverify.test.ts:103:38
```

即实测投影为 `[1..20, 41..60]`（40 条，第 21–40 条缺失）；同用例临时打开组元数据断言后实测 `{"label":"临时工作区","total":61,"hasMore":false,"loadedCount":60}`（`loadedCount=60` 对 40 条投影，`hasMore` 已被过期响应置 false）。

**影响面 / 严重度**

- 影响：标准模式分组列表。已展开过的分组 + 恢复归档并发点击时，一段会话从列表消失且无法通过分页找回（需手动刷新）。
- 触发条件：恢复归档与展开更多两个点击落在同一次静默重建的 RTT 窗口内。
- 严重度：**中**（结果错误 + 分页漏条不自愈，但不写坏服务端数据、刷新可自愈）。
- 建议方向：护栏除了代次，再比对请求发起时的组元数据对象（`meta !== groupMeta.value.get(key)` 即丢弃）；或在 `fetchSessions` 入口登记「重建在飞」标志，`loadMoreInGroup` 见到在飞直接放弃本次点击。

---

### Bug 2：选择态右键删除（弹窗路径）成功后 `selectedIds` 不同步剔除

**位置**

- `desktop/src/components/task/TaskIndexPanel.vue:543-555`（`menuDelete`，选择态走 `deleteSessionViaDialog`）
- `:673-698`（`deleteSessionViaDialog`：成功后只清理 Tab 与跳转，不碰 `selectedIds`）
- `:362-390`（`selectedIds` / `toggleSelect`）：全文件只有 `applyFilter`(`:335`)、`enterSelectMode`(`:368`)、`exitSelectMode`(`:373`)、`toggleSelect`(`:389`) 四个写入点，删除路径不在其中

**问题描述**

修复 3 让选择态右键删除能真正完成，但删除成功后勾选集没有同步：

- 底部计数虚高：3 条里删掉 1 条，界面上只剩 2 行，计数仍显示「已选 3」；
- 再点底部「归档」：`confirmBatchArchive` 把已删除的 id 一起传给 `store.archiveSessions`，store 的 targets 过滤按实体存在性把它计入 `skipped` → toast「已归档 2 个，**1 个跳过**」。这个「跳过」既不是运行中、也不是已归档，用户无法理解它从哪来。

对照：`applyFilter` 就有「过滤结果变化后清空，避免归档看不见的会话」的处理（`:334-335`），说明这一类同步是有意维护的，只是删除路径漏了。另外只有选择态右键删除这一条路会踩到——非选择态走行内确认，用户要再进选择态才会批量操作，而 `enterSelectMode` 会重置 `selectedIds`。

**复现测试**

路径：`desktop/src/components/task/select-mode-delete-selection.reviewverify.test.ts`
用例：`选择态右键删除（确认弹窗路径）与勾选态的同步 > 删除已勾选的行后 selectedIds 不同步剔除：计数虚高、批量归档把已删除会话计为跳过`

运行：`cd desktop && npx vitest run src/components/task/select-mode-delete-selection.reviewverify.test.ts`

失败输出：

```
 FAIL  src/components/task/select-mode-delete-selection.reviewverify.test.ts > 选择态右键删除（确认弹窗路径）与勾选态的同步 > 删除已勾选的行后 selectedIds 不同步剔除：计数虚高、批量归档把已删除会话计为跳过
AssertionError: expected '已选 3' to contain '已选 2'

Expected: "已选 2"
Received: "已选 3"

 ❯ src/components/task/select-mode-delete-selection.reviewverify.test.ts:188:51
```

同用例临时打开后续断言后实测：删除后计数仍为 `已选 3`；点「归档」时 `archiveSessions` 入参为 `["1","2","3"]`（含已删除的 "2"），toast 为 `已归档 2 个，1 个跳过`。

**影响面 / 严重度**

- 影响：标准模式多选态下的右键删除。删除与归档数据本身都正确，错的是计数与 toast 口径（误导性「跳过」）。
- 严重度：**低**（不丢数据，退出选择态即自愈）。
- 建议方向：`deleteSessionViaDialog` 成功后从 `selectedIds` 移除该 id（清空后可直接退出选择态）。

---

### Bug 3：`fetchSessions` 失败也递增代次——在飞的合法「展开更多」被误丢弃且无反馈

**位置**

- `desktop/src/stores/session/list.ts:137`（`standardListEpoch++` 在请求发出前，与请求成败无关；失败路径 `finally` 只重置 `loading`）

**问题描述**

「展开更多」在飞时用户点刷新，刷新请求失败（`refreshSessions` 用 `Promise.allSettled` 收口，只 toast 失败）：列表与 `groupMeta` 原样未动，但在飞的分页响应回来时代次已不匹配 → 整条丢弃。用户那一次「展开更多」点击静默无效——`showMore`（`TaskIndexPanel.vue:1252-1264`）在 `loadMoreInGroup` 返回 `false` 后只按当前已加载条数重算 `expandedCounts`（无可视变化），按钮也因 `hasMore` 仍为 true 而留在原处，没有任何提示，用户只会以为自己没点中，再点一次才生效。

**复现测试**

路径：`desktop/src/stores/session-epoch-gap.reviewverify.test.ts`
用例：`standardListEpoch 护栏：代次在 loadMore 发起前就已递增的场景 > 重建请求失败（代次已递增但列表未重建）时，在飞的合法「展开更多」被误丢弃`

运行：`cd desktop && npx vitest run src/stores/session-epoch-gap.reviewverify.test.ts`

失败输出：

```
 FAIL  src/stores/session-epoch-gap.reviewverify.test.ts > standardListEpoch 护栏：代次在 loadMore 发起前就已递增的场景 > 重建请求失败（代次已递增但列表未重建）时，在飞的合法「展开更多」被误丢弃
AssertionError: expected [ '1', '2', '3', '4', '5', '6', …(14) ] to deeply equal [ '1', '2', '3', '4', '5', '6', …(34) ]
- Expected
+ Received
@@ -17,26 +17,6 @@
    "16",
…
    "20",
-   "21",
…
-   "40",
  ]
```

（同用例中 `await expect(loadMorePromise).resolves.toBe(false)` 通过，即 store 明确报告了「丢弃」；列表停在 20 条，未追加本应有效的第 21–40 条。）

**影响面 / 严重度**

- 影响：标准模式分组列表。仅错误路径（刷新失败）叠加在飞分页时触发；后果是一次无效点击，无数据错误。
- 严重度：**低**。列出供修复代次护栏时一并考虑（如代次改在重建响应成功落地时递增，或同时保留「重建在飞」标志并在 `showMore` 里对丢弃给出反馈）。

---

## 三、新固化测试文件的伪测试排查

逐个文件核对「断言是否可能为假 / 被测逻辑是否空跑」：

1. **`desktop/src/components/chat/RoundDirectory.test.ts`**（4 例，jsdom 真实挂载）
   断言全部是 DOM 状态迁移与 emit 参数：把手存在、浮层从无到有、行数 `= 2`、`onLocate` 收到 `'u2'`、定位后浮层消失、Esc / 外部点击后浮层消失、二次点把手 toggle 收起——每一条都可能失败。组件与依赖（`useMessageRounds` / `toRoundDirectoryRows`）都是真实代码，没有桩掉被测对象。**非伪测试**。
   小瑕：第 4 例标题写「点把手自身（在 rootEl 内）不触发外部关闭」，实际保护来自把手上的 `@click.stop`（`RoundDirectory.vue:14`），document 处理器里的 `rootEl.contains` 守卫（`:79`）是第二道防线，该例并未单独验证后者。属标题略夸，不影响断言有效性。

2. **`desktop/src/components/chat/ChatRoundList.replyOnly.test.ts`**（8 例，SSR 渲染）
   断言都指向具体渲染产物：「已执行 2 个步骤」摘要行、`id="msg-u1"` / `id="msg-a2"`、`tool-call-group` 的有无，且 `replyOnly` true/false **成对出现**——对照组证明「隐藏」类断言不是因为本来就渲染不出来；`MessageBubble.hideToolCalls` 同样一开一关。`toRoundDirectoryRows(historyRounds)` 一例直接对 composable 输出做等值断言（`['帮我重构登录流程', '把单元测试也补上']`）。**非伪测试**。

3. **`desktop/src/components/task/task-index-panel-interaction.test.ts`**（13 例，jsdom 真实挂载）
   `TaskSessionGroupList` / `TaskContextMenu` 用真实组件，只 mock 重子组件（聚焦列表 / 归档区 / 分享弹窗）、element-plus 消息组件与 store；被测的行点击、复选框禁用、右键菜单禁用态、删除路径都走真实渲染。断言覆盖：防抖时序（300ms 前不请求、到点请求一次、清空立即再请求一次）、Esc 只收输入行不重新请求、Enter 取消挂起防抖、聚焦模式分流 `fetchFocusSessions`、选择态进入 / Esc 退出 / 聚焦模式无入口、行点击 = 勾选与取消、RUNNING 行复选框 `disabled` 且点行不选中、批量归档入参 `['1','2']` 与 toast 文案、取消确认不发起归档且选择态保留、选择态右键「归档」禁用（class + title）、以及两个删除路径（选择态 → `messageBoxConfirm` 调用 1 次且无内联按钮；非选择态 → 内联 `.action-confirm` 且不弹窗）。最后两组互为对照，直接压在修复 3 的改动点上。**非伪测试**。

补充：`session.test.ts` 新增的 4 条固化回归（过滤竞态护栏、归档区刷新失败不冒泡、多组分别扣减、C5 端到端 offset）也不是伪测试——store 模块真实执行，断言都是具体值；且第一轮已在**修复前**代码上实测过同场景失败（`['3','5','6']`、`Error: network down` 抛出），证明这些断言随修复由红转绿。

---

## 四、验证过无问题的面

- **修复 2 的吞异常范围**：`fetchArchivedSessions` 只会因 `api.get` 拒绝而抛，`archivedLoading` 由 `finally` 复位；`archiveSessions` 返回值不依赖归档区刷新，调用方 toast 与退出选择态不受影响（固化回归覆盖）。
- **代次护栏不会误丢合法「展开更多」的正常场景**：四个 `fetchSessions` 调用方都会重建标准列表并把 `loadedCount` 重置为预览长度，在飞分页的 offset 一律过期，丢弃是正确口径；WS 重连只刷聚焦（`useStreamWS.ts:369`）；批量归档（含失败）不触发 `fetchSessions`。唯一「误丢」场景是 Bug 3 的刷新失败路径。
- **修复 3 未回归既有路径**：非选择态仍走行内确认（对照组测试通过）、窄面板路径不变；`showItemActions` 由真变假时 `confirmingDeleteId` / 编辑态被 watch 清掉（`TaskIndexPanel.vue:902-908`），不会留下不可见确认态；选择态右键「归档」仍按 C13/C14 禁用并带「多选模式」提示，与删除走弹窗不冲突。
- **新固化测试与桌面既有单测复跑通过**：`session.test.ts`（63）+ `RoundDirectory.test.ts`（4）+ `ChatRoundList.replyOnly.test.ts`（8）+ `task-index-panel-interaction.test.ts`（13）= **88 条全部通过**。

## 五、本轮创建的验证测试文件（供清理）

均为 `.reviewverify.test.ts` 后缀的新文件，未改动任何 src 产品代码、未 `git add` / commit：

- `desktop/src/stores/session-epoch-gap.reviewverify.test.ts`（Bug 1 + Bug 3 两条复现）
- `desktop/src/components/task/select-mode-delete-selection.reviewverify.test.ts`（Bug 2 复现）

一次性复跑（3 失败 = 上述 3 个 bug）：

```
cd desktop && npx vitest run \
  src/stores/session-epoch-gap.reviewverify.test.ts \
  src/components/task/select-mode-delete-selection.reviewverify.test.ts
```

```
 ❯ src/stores/session-epoch-gap.reviewverify.test.ts (2 tests | 2 failed)
 ❯ src/components/task/select-mode-delete-selection.reviewverify.test.ts (1 test | 1 failed)

 Test Files  2 failed (2)
      Tests  3 failed (3)
```
