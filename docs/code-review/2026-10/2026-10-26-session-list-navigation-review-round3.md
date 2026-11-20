# 会话列表与长会话导航 —— 第三轮代码审查报告（0.0.351 修复 c00be9fa）

> 审查对象：`git diff 971e8426..c00be9fa`（`c00be9fa` fix(desktop): 修复第二轮代码审查发现的 3 个问题——代次护栏缺口 / 刷新失败误丢分页 / 选择态删除不同步勾选）
> 前两轮报告（**均未改动**）：`2026-10-26-session-list-navigation-review.md`、`2026-10-26-session-list-navigation-review-round2.md`
> 方法：只读代码 + 为每个新疑似 bug 编写 `.reviewverify.test.ts` 复现（跑失败才计入）；未修改任何 src 产品代码、未 `git add` / commit、未跑完整 E2E。

## 结论摘要

三处修复的认定：

| 修复 | 认定 | 依据 |
|---|---|---|
| 1 `standardListEpoch` 改「重建落地时递增」 | **修对了**，第二轮两种时序都覆盖，且未引入新缺口 | 逐时序推演（第一节）+ 两条固化回归跑绿 |
| 2 `deleteSessionViaDialog` 选择态同步勾选集 | **修对了**，无新问题 | 代码核对 + 固化回归跑绿 |
| 3 固化断言 | **均非伪测试**，且压在修复点上 | 第三节逐条核对；第二轮已在修复前代码上实测同场景失败 |

附带发现（**既有问题，非本轮修复引入**，也不属于前两轮已报告问题）：

| # | 严重度 | 问题 | 复现 |
|---|---|---|---|
| 1 | 低 | 代次护栏只覆盖「重建」，不覆盖归档 / 删除 / 新建对 `loadedCount` 的增量修改：在飞分页与归档并发时 offset 整体偏移一条，跳过一条会话、列表出现空洞 | 已复现（失败） |

---

## 一、修复 1：代次改「重建落地时递增」——认定与推演

**位置**：`desktop/src/stores/session/list.ts:171`（`standardListEpoch++`，紧邻 `:172` 的 `standardSessionIds.value = ids` 之前；`:137` 的入口递增已移除）。

把「代次记录点 / 代次变化点」与所有相关时序逐一推演（代次初值 1）：

| # | 时序 | loadMore 记录到的代次 | 终态代次 | 结果 |
|---|---|---|---|---|
| 1 | 第一轮 Bug 1：loadMore 在飞 → 改过滤词触发重建 → 重建落地 → loadMore 到达 | 1 | 2 | 不符 → 整条丢弃 ✓ |
| 2 | 第二轮 Bug 1：静默重建（恢复归档）在飞 → loadMore 发起（此时代次未动）→ 重建落地 → loadMore 到达 | 1 | 2 | 不符 → 整条丢弃 ✓ |
| 3 | 第二轮 Bug 3：loadMore 在飞 → 重建请求**失败**（不落地、代次不动）→ loadMore 到达 | 1 | 1 | 相符 → 正常并入 ✓ |
| 4 | loadMore 响应**先于**重建落地到达（正常并入）→ 随后重建落地把列表重置为预览 | 1 | 2 | 并入是瞬态的，终态由重建决定，正确 ✓ |
| 5 | 两个重建同时在飞（`seq` 护栏使先发者早退、不 bump）→ loadMore 到达 | 1 | 2（后发者落地） | 不符 → 丢弃 ✓ |
| 6 | 重建落地后用户再点「展开更多」 | 2（offset 取新 meta） | 2 | 相符 → 正确分页 ✓ |

两个实现细节保证了没有新的中间态可被观察：

- `standardListEpoch++`（`:171`）与 `standardSessionIds.value = ids` / `groupMeta.value = meta`（`:172-173`）之间**没有 await**，不存在「代次已变而投影未变」的窗口；
- `loadMoreInGroup` 里 `await api.get(...)` 与紧随的代次比对（`:196-200`）之间也**没有 await**，响应处理是同步的，不存在「投影已变而代次未变」的窗口。

因此第二轮指出的两个缺口都被堵上，且没有为此付出新的正确性代价。唯一「多丢一次点击」的情形是时序 4/6 的变体（重建落地后 offset 恰好仍有效），属于可接受的设计口径（与第一轮修复一致）。

## 二、修复 2：选择态删除后同步勾选集——认定

**位置**：`desktop/src/components/task/TaskIndexPanel.vue:689-696`（`deleteSessionViaDialog` 成功后）。

核对点：

- 只有选择态需要同步：非选择态走行内确认，删除后用户若再进选择态，`enterSelectMode` 会重置 `selectedIds`（`:366-369`）；
- `next.delete(String(sessionId))` 与 `toggleSelect` 写入的 `String(session.id)`（`:384`）同型，不会因类型不匹配而删不掉；
- 删的是未勾选的行时是 no-op；删到剩 0 条勾选时底部操作条仍显示「已选 0」，不违反产品语义；
- 与 `applyFilter` 的「过滤结果变化后清空勾选」（`:334-335`）同源，口径一致；
- 未影响行内确认删除路径（对照组测试通过，见第三节）。

## 三、固化断言核对（是否伪测试）

三条固化回归逐条核对，结论：**均非伪测试，且直接压在修复点上**。

1. `desktop/src/stores/session.test.ts`「静默重建在飞期间点『展开更多』：重建落地后旧 offset 的分页响应整条丢弃」
   - `expect(mockGet).toHaveBeenCalledTimes(3)`：保证恢复归档触发的静默重建请求**真的在飞**（防止协程没走到 `api.get` 就让测试「通过」）；
   - `expect(mockGet.mock.calls[3][1]?.params?.offset).toBe(40)`：保证在飞分页用的确是**旧 meta 的 offset**——这正是该 bug 的成因，断言住它就不会退化成「恰好通过」；
   - 终态断言投影 `[1..20]` + 组元数据 `{total:61, loadedCount:20, hasMore:true}`：同时压住「不并入」与「不覆盖元数据」两个修复点。
   - 由红转绿的证据：第二轮已在**修复前**代码上实测同一时序失败（投影 `[1..20, 41..60]`、meta `{total:61, hasMore:false, loadedCount:60}`，见第二轮报告）。
2. `desktop/src/stores/session.test.ts`「重建请求失败（列表未重建）时，在飞的合法『展开更多』不被误丢弃」
   - `await expect(loadMorePromise).resolves.toBe(true)` + 投影追加到 `[1..40]`：压住「失败不 bump 代次」这一修复点；第二轮实测修复前返回 `false`、列表停在 20 条。
3. `desktop/src/components/task/task-index-panel-interaction.test.ts`「选择态弹窗删除成功后同步剔除勾选集」
   - store mock 的 `deleteSession` 会真的把行移出 `sessions`、`archiveSessions` 按实体存在性计 `skipped`（与真实 store 同口径），保证被测链路不是空跑；
   - 断言计数「已选 2」、入参 `['1','3']`、toast「已归档 2 个」：若修复缺失，入参会是 `['1','2','3']`、toast「已归档 2 个，1 个跳过」，三条全红。

另：`RoundDirectory.test.ts` 本轮只改标题与注释（把第二轮指出的「标题略夸」改成准确描述 `@click.stop` 的作用），无语义变化。

复跑：`session.test.ts`（65）+ `task-index-panel-interaction.test.ts`（14）= **79 条通过**。

---

## 四、附带发现（既有问题，非本轮修复引入）

### 附带发现 1：归档 / 删除 / 新建不递增代次——在飞分页与归档并发时 offset 整体偏移，跳过一条会话

**位置**

- `desktop/src/stores/session/list.ts:171`（代次只在重建落地时递增）
- `desktop/src/stores/session/list.ts:257-271`（`bumpGroupMetaForSession` 的 `loadedDelta`：只改组元数据，不动代次）
- `desktop/src/stores/session/list.ts:184-239`（`loadMoreInGroup`：`offset` 在发起时定格）

**问题描述**

C5 的 `loadedDelta` 保证的是「归档**完成之后**再点展开更多」的 offset 正确（第一轮已用「归档已加载窗口内的会话后『展开更多』offset 不漏条不重条（C5 端到端）」验证过顺序场景）。但代次护栏只认「重建」，归档 / 删除 / 新建走的是 `bumpGroupMetaForSession` 增量修改，不 bump 代次。于是：

1. 分组预览 20 条已加载（`loadedCount=20`），用户点「展开更多」，请求在飞（`offset=20` 定格）；
2. 用户在分页 RTT 窗口内又归档了该组已加载窗口内的一条（行内归档按钮 / 右键归档在分页在飞期间仍可点——`loadingMoreGroups` 只禁用组尾的「展开更多」本身，`TaskSessionGroupList.vue:173-174`）：`loadedCount` 20→19、投影移除该条；
3. 分页响应到达：服务端该组此刻也少了一条，`offset=20` 于是落到「第 22 条」起而不是「第 21 条」起——代次未变，护栏放行，整页并入。

后果：**第 21 条被跳过**（列表出现空洞），第 41 条被提前并入，`loadedCount` 被抬成 40 而投影实际 39 条；要手动刷新才能补回。删除会话（`deleteSession` 同样扣 `loadedCount`）与新建会话（`createSession` 头部插入 + `total+1`）是同一条路径的同类触发。

**复现测试**

路径：`desktop/src/stores/session-archive-loadmore-race.reviewverify.test.ts`
用例：`归档与在飞「展开更多」并发：loadedCount 已扣减但 offset 未同步 > 在飞分页期间归档已加载窗口内的一条：第 21 条被整段跳过（列表出现空洞）`

运行：`cd desktop && npx vitest run src/stores/session-archive-loadmore-race.reviewverify.test.ts`

失败输出：

```
 FAIL  src/stores/session-archive-loadmore-race.reviewverify.test.ts > 归档与在飞「展开更多」并发：loadedCount 已扣减但 offset 未同步 > 在飞分页期间归档已加载窗口内的一条：第 21 条被整段跳过（列表出现空洞）
AssertionError: expected [ '1', '2', '3', '4', '6', '7', …(33) ] to deeply equal [ '1', '2', '3', '4', '6', '7', …(33) ]
- Expected
+ Received
-   "21",
+   "41",
 ❯ src/stores/session-archive-loadmore-race.reviewverify.test.ts:91:38
```

（用例断言的不变量是「1..40 中除已归档的 5 之外都必须在列表里」；实测缺 `21`、多 `41`。按「元数据变过就该丢弃」的方向修复同样满足该不变量——列表停在 19 条，用户可再点一次。）

**影响面 / 严重度**

- 影响：标准模式分组列表。一条会话从列表消失（空洞），手动刷新可自愈；不写坏服务端数据。
- 触发条件：点「展开更多」后在同一次分页 RTT 内又归档 / 删除该组一条会话。
- 严重度：**低**。
- 归属说明：**既有问题，非本轮修复引入**——`loadMoreInGroup` / `bumpGroupMetaForSession` 在 `main` 上已存在（`git show main:desktop/src/stores/session/list.ts` 可见），C5 的 `loadedDelta` 是本分支新增但只覆盖了「顺序」场景；代次护栏从入口改到落地也不影响它（归档不触发 `fetchSessions`）。列出来是因为它与本轮修复是同一条「在飞分页响应过期判定」主线的剩余缺口，修复时代价极小。
- 建议方向：把代次递增也挂到 `bumpGroupMetaForSession`（或让 `loadMoreInGroup` 响应回来时复核 `meta !== groupMeta.value.get(key)`），与重建共用同一条丢弃口径。

---

## 五、验证过无问题的面

- **代次护栏与所有 `fetchSessions` 路径的自洽性**：四个调用方（`TaskView.vue:1235` onMounted、`TaskIndexPanel.vue:332` `applyFilter`、`:1276` `refreshSessions`、`list.ts:423` `unarchiveSession`）都会重建标准列表；非 silent 三个在 `loading` 期间列表被遮罩替换、点不到「展开更多」，silent 的恢复归档由时序 2 覆盖；WS 重连只走 `fetchFocusSessions`（`useStreamWS.ts:369`）、批量归档不触发 `fetchSessions`，均不碰标准列表代次。逐时序推演见第一节，无「合法展开更多被误丢」的残留场景（除第二轮已修的刷新失败路径）。
- **修复 2 的边界**：选择态才同步、`String` 同型、未勾选行 no-op、与 `applyFilter` 口径一致、不影响行内确认删除路径。
- **固化断言**：三条新增回归 + `RoundDirectory.test.ts` 标题修订，均非伪测试（第三节）。
- **全量桌面单测**：`cd desktop && npx vitest run` → 105 files / 946 tests 通过（本审查加入复现文件后为 106 files / 947 tests，唯一失败即附带发现 1）。

## 六、本轮创建的验证测试文件（供清理）

均为 `.reviewverify.test.ts` 后缀的新文件，未改动任何 src 产品代码、未 `git add` / commit：

- `desktop/src/stores/session-archive-loadmore-race.reviewverify.test.ts`

复跑（1 失败 = 附带发现 1）：

```
cd desktop && npx vitest run src/stores/session-archive-loadmore-race.reviewverify.test.ts
```

```
 ❯ src/stores/session-archive-loadmore-race.reviewverify.test.ts (1 test | 1 failed)
 Test Files  1 failed (1)
      Tests  1 failed (1)
```
