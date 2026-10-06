# 边路任务 fork（任意深度）代码复审报告 · Round 2

- 日期：2026-10-06
- 复审对象：修复 commit `c5ae30ee`（相对第 1 轮 `0cfef917`），并对整体 diff `73a83b66..HEAD` 做快速复核
- 第 1 轮报告：docs/code-review/round-1-report.md
- 验证方式：/tmp/mao-verify/ 下 4 个新验证 spec（13 个用例）全部实际运行通过；仓库现有测试基线保持全绿（backend-ts session/approval 20 文件 320 用例、desktop stores/session + useStreamWS 2 文件 49 用例）。未修改仓库任何源码 / 测试文件。

## 结论：4 个修复项验证结论

| # | 第 1 轮问题 | 结论 | 一句话 |
|---|---|---|---|
| 1 | promote 子树搁浅（重大） | **fixed** | 事务内 `reparentChildrenTo` 真实落库重挂，子树（含隔代）在新根可达、旧根清除；归档子/已删子的边界行为经专项用例确认无害 |
| 2 | 深层任务自动标题丢失（一般） | **fixed** | `findSideTaskRootKey` 按 id 反查根键命中缓存与 Tab；缓存未加载时回退直接父（无害 no-op）；多缓存瞬态歧义无用户可见影响 |
| 3 | 占位来源缺省残留（一般） | **fixed（主流程）** | 回退主会话时 meta 被正确清除、模型/权限回退主会话口径；但发现一个残留竞态（见下，新问题 #1） |
| 4 | 删除后孤儿残留 / 信号断链（一般） | **fixed** | DELETE 后 `publishAtRoot(直接父)` 驱动根重算信号（端到端验证根键信号发出），前端删除/提升成功后 `refreshSideTasks(根键)` 剔除孤儿；删主会话场景经真实 publisher 验证为无害 no-op |

**新问题：1 个（一般）** —— 修复 3 的清除分支可被"在途补拉响应"晚到覆盖（竞态窗口 = 一次 HTTP 往返，详见下文）。

---

## 一、修复项逐项验证

### 修复 1：promote 子树跟随 —— fixed

**修复内容**：`session.repository.ts:275-280` 新增 `reparentChildrenTo(oldParentId, newParentId)`（`UPDATE session SET parent_session_id = ? WHERE parent_session_id = ? AND deleted = 0`）；`session.service.ts:671` 在 promote 事务内、`logicalDelete` 之前调用 `reparentChildrenTo(sideSessionId, targetId)`；前端 `TaskView.vue:646-649` 提升成功后对旧根 `refreshSideTasks`。

**验证**（/tmp/mao-verify/fix1-promote.spec.ts，2 用例通过）：
- 用会真实落库的 mock（execute 语义作用于 fixture），走完整 `promoteSideTaskToMainSession(20, 7)`，再用**真实的** `SessionRepository.listDescendantSideTasksByRoots` 对提升后 DB 形态跑 BFS：
  - 直接子 30 重挂到新主会话 99，孙子 33 经 30 间接可达 → BFS 从根 99 命中 `[30, 33]`；旧根 10 的结果为空；
  - 已删子（deleted=1）不被重挂（保持指向旧 id，本就不可见，无影响）；
  - 归档 SIDE_TASK 子被一并重挂到新根，但 BFS 按 `status <> 'ARCHIVED'` 跳过，依旧不可见（符合"归档子树隐藏"设计）；
  - 归档 SUBAGENT 子：前置校验只拦未归档 SUBAGENT → 归档 SUBAGENT 放行且被重挂到新主会话，但子代理列表查询同样带 `status <> 'ARCHIVED'`，不可见、不发信号——第二个用例确认此边界无害。
- 前端 `refreshSideTasks(parentSessionId)`（TaskView.vue:648）按固定旧根键刷新，配合 `router.push` 到新任务触发的 loadSession 递归拉取，旧/新两端缓存均收敛。

### 修复 2：深层任务自动标题 —— fixed

**修复内容**：`sideTask.ts:169-175` 新增 `findSideTaskRootKey(sideSessionId)`（按 id 全缓存反查键，经 store `...sideTask` 展开暴露）；`useStreamWS.ts:617-621` 标题事件分支改为 `findSideTaskRootKey(sid) ?? String(data.parentSessionId)`。

**验证**（/tmp/mao-verify/fix2-title.spec.ts，4 用例通过）：
- 深层任务（父=20、根=1）：反查根键 '1' → `updateSideTaskTitle('1', 30, ...)` 命中递归缓存，标题从「任务」更新为自动标题；`openSideTaskTabFor('1', 30, ...)` 预置的 Tab 走同一根键路径；
- 缓存未加载（任务不在任何缓存）：回退直接父 id，等价旧行为，深层场景为无害 no-op，不抛错；
- 一级边路回归：反查键即根键，行为与旧版一致；
- **多缓存命中歧义（重点核查项）**：构造 promote 后旧根 '1' 缓存未刷新、新根 '99' 缓存已载入同 id 任务的瞬态——`findSideTaskRootKey` 按 Map 插入序返回先载入的旧根键，标题写进即将被 `handlePromoteSideTask` 的 `refreshSideTasks('1')` 清除的旧缓存；新根侧标题由提升后 loadSession 的服务端递归拉取兜底。结论：瞬态、无用户可见影响，不构成 bug。

### 修复 3：占位来源缺省清除 —— fixed（主流程；残留竞态见新问题 #1）

**修复内容**：`SideChatPanel.vue:218-233` watch 重构——已转正（`sideSessionId > 0`）直接 return；`id` 为空时清空 `sourceSessionMeta` / `fetchedSourceMetaId`。

**验证**（/tmp/mao-verify/fix3-placeholder.spec.ts，3 用例通过）：
- 主流程：边路来源 20（meta={7, READ_WRITE}）→ 回退 undefined → meta 清空，`currentModelId` 回退主会话模型 1、权限回退 READ_ONLY——第 1 轮 Bug 3 的触发序列不再复现；
- 已转正真实会话：跳过 fetch 与 clear，不影响已建会话；
- 竞态反例：见下文新问题 #1。

### 修复 4：删除后的树信号与列表收敛 —— fixed

**修复内容**：`session.routes.ts:272-277`——DELETE 捕获删除前的 `target`，删除后 `publishAtRoot(target.parentSessionId ?? target.id!)`；`TaskView.vue:617-622` 删除成功后 `refreshSideTasks(根键)`；确认文案改为如实描述"仅删除自身、下层任务从树中移除显示（数据保留）"。

**验证**（/tmp/mao-verify/fix4-delete-signal.spec.ts，4 用例通过）：
- 路由层（注入 mock publisher）：删深层边路（父=20）→ `publishAtRoot(20)`；删一级边路（父=10）→ `publishAtRoot(10)`（与旧口径等价）；均不误走 `publish`；
- 端到端（真实 `SessionTreeSignalPublisher` + 断言型 mapper）：删除深层任务 30 后，沿 20→10 解析到根 10，在根上发出唯一 `session_tree_status`（treeRunning/treeUnread 重算，30 已从聚合剔除）→ 前端 `updateSessionTreeSignals` + `refreshSideTasks(根)` 链路成立；
- **删主会话场景（重点核查项）**：`?? target.id!` 使删除 NORMAL 会话时以自身 id 调 `publishAtRoot`，但行已删除、`selectById` 返回 null → 解析断链静默不发——经真实 publisher 验证**不产生任何信号**（与修复前"删除不发信号"行为一致，无副作用）。同理，删除父已删除的孤儿任务也不发信号（同一断链语义），符合"孤儿无消费场景"设计。

---

## 二、新发现的问题

### 新问题 #1（一般）：清除分支可被在途补拉响应晚到覆盖，来源缺省仍可能残留

- **位置**：`desktop/src/components/chat/SideChatPanel.vue:203-216`（`fetchSourceSessionMeta` 无 post-await 守卫）与 `:226-233`（watch 清除分支）
- **问题描述**：`fetchSourceSessionMeta` 在 `await api.get` 返回后无条件写 `sourceSessionMeta`。若"来源回退主会话"的清除发生在补拉响应返回之前（fetch 挂起期间来源被覆写为 undefined），迟到的响应会把上一次边路来源的 modelId / permissionLevel 重新填回 meta——精确恢复第 1 轮 Bug 3 的症状（发送时显式传值、后端传值优先，新任务静默继承无关边路会话的模型/权限）。这是修复 3 的一个未闭合缝隙，不是新链路。
- **触发场景**：在边路来源占位上触发补拉后、HTTP 响应到达前（一次网络往返的窗口内），用户经"切回主会话 chat Tab → 再点 + 边路任务"把占位来源覆写回主会话并直接发送。窗口极窄（亚秒级），但慢网络下真实存在。
- **验证方式与证据**：/tmp/mao-verify/fix3-placeholder.spec.ts 第 3 用例——用可控 resolve 的挂起响应复现：清除分支执行后 meta 为 null；`lateResolve({modelId:7, permissionLevel:'READ_WRITE'})` 到达后 meta 重新变为来源边路的值，`currentModelId===7`、权限缺省 `'READ_WRITE'`。
- **建议修复方向**：`fetchSourceSessionMeta` 在 `await` 返回后加守卫——`if (fetchedSourceMetaId.value !== sourceId) return`（清除分支已把 `fetchedSourceMetaId` 置 null，迟到响应即被丢弃）；或给 fetch 加自增 token 比对。
- **严重级别**：一般（竞态窗口极窄、后果与第 1 轮 Bug 3 相同但需要精确时序）。

---

## 三、整体 diff（73a83b66..HEAD）快速复核结论

修复 commit 之外未发现第 1 轮遗漏的新问题；第 1 轮"已核查无问题"清单在 HEAD 上复检仍然成立（BFS 防环/孤儿/归档/深度上限、publishEpoch 并发语义、enrichSessions 按根分组、搜索根解析深度边界与孤儿剔除、`?recursive=1` 缺省口径、updateSideTask* 按 id 逻辑、handleSideSessionCreated 缓存键与占位匹配、SideChatPanel 创建链路事件过滤）。本次额外复核过的修复引入面：

- `reparentChildrenTo` 的 WHERE 带删除过滤、调用顺序（重挂先于逻辑删除）、对消息/file_change/compaction 无影响（只改 parent 指针）；
- `findSideTaskRootKey` O(n) 扫描无性能顾虑（缓存键数量 = 用户树数）；多缓存命中歧义为瞬态（见修复 2 验证）；
- DELETE 路由对删主会话 / 删孤儿场景均为无害 no-op（见修复 4 验证）；
- 前端删除/提升后的 `refreshSideTasks` 用发起时固定的父会话键（await 前捕获），切换会话不会写错缓存；失败路径（confirm 取消 / api 异常）提前 return，不会误刷新；
- `session.service.spec.ts` 的 txDb 外提重构语义等价（txMessageId 每事务复位）。

## 附：本轮验证产物

- /tmp/mao-verify/fix1-promote.spec.ts（backend，2 用例）
- /tmp/mao-verify/fix2-title.spec.ts（desktop，4 用例）
- /tmp/mao-verify/fix3-placeholder.spec.ts（desktop，3 用例）
- /tmp/mao-verify/fix4-delete-signal.spec.ts（backend，4 用例）
- 第 1 轮产物归档于 /tmp/mao-verify/round1/（其中 promote-subtree.spec 断言"无重挂语句"，在修复后 HEAD 上预期失败，仅作历史证据保留）
- 复跑命令：`cd backend-ts && npx vitest run --config /tmp/mao-verify/backend.vitest.config.ts`；`cd desktop && npx vitest run --config /tmp/mao-verify/desktop.vitest.config.ts`（当前 13/13 通过）
