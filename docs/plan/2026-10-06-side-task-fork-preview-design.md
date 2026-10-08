# 边路任务 Fork 预演（发出前预览将复制的历史消息）

- 日期：2026-10-06
- 状态：已实施（与需求方确认后实现，代码在 0.0.238）
- 前置阅读：`docs/plan/2026-09-29-side-task-fork-from-round-technical-design.md`（按轮分叉）、`docs/plan/2026-10-06-side-session-fork-design.md`（从边路 fork 任意深度）
- 涉及端：backend-ts（新增只读接口）、desktop（共用 UI）
- 不涉及：admin、安卓原生壳、Electron 主进程、agent-cli、mao-cli、DB

---

## 1. 需求背景

用户原话：「选择 fork 的时候能不能在上面对话框里面预览一下 fork 的对话消息？可以先不保存，但是先预览原始会话的消息记录。因为理论上我这个会话创建的时候，从原始会话拷贝消息渲染出来的结果是一样的。」

现状是「盲fork」：在新建边路任务的占位 Tab 里选「Fork 主会话 / Fork 来源会话」，界面只有一行单选，看不到任何历史；必须把第一条消息发出去、等后端把消息复制完、再靠 `fetchMessages()` 从 REST 拉回来，才知道这条支线到底继承了哪些上下文。想换个切点重来就得先发一条废消息，已创建的会话还留在边路任务列表里。

用户明确点出了验收口径：**预览渲染结果 = 真实 fork 后从原始会话拷贝消息渲染出来的结果**。因此预览不是"示意"，而是与真正落库的 fork 同一套取数口径。

## 2. 需求描述

### 2.1 要做

1. **占位 Tab 选中 Fork 即预览**：未发送首条消息的边路 Tab 里，选中「Fork 主会话 / Fork 来源会话」后，消息区立即展示来源会话的历史消息（含按轮分叉的切点语义），顶部有提示条说明"仅为预览，发出首条消息后才会真正保存"。
2. **取数口径与真实 fork 完全同源**：切点 = 被点击那一轮的助手最终回复；无切点 = 全量。渲染复用主会话同款轮次折叠（`ChatRoundList`）。
3. **可翻页**：轮次分页参数（默认最近 5 轮、滚到顶部加载更早）与 `/sessions/:id/messages` 一致。
4. **切点可改**：从每条助手回复的 fork 按钮重新选切点，或切换回不继承 / 摘要，预览立即跟随。
5. **不落任何会话缓存**：预览只存在组件本地 ref，不写 `sessionStore`；会话转正、切回其他模式、Tab 卸载时清空。

### 2.2 明确不做

| 不做项 | 说明 |
| --- | --- |
| 不预演「摘要」模式 | 摘要要等后端 LLM 生成，且不进消息表；界面沿用空态文案 |
| 不预览 file_change / compaction 之外的状态 | 待办、点踩等本来就与 fork 一起不复制（既有决策），预览同步不展示 |
| 不做编辑 / 点踩 | 预览是只读展示；fork 按钮保留（与真实 fork 会话一致，可换个切点再分叉） |
| 不做 REST / WS 创建入口 | 创建仍只走 WS `create_side_session`，预览接口纯只读 |
| 不动 DB | 无迁移，无 schema 变更 |
| 不改真实 fork 落库逻辑 | `forkParentMessages` 零改动 |

## 3. 关键决策

**决策 1：新增只读 REST 接口 `/v1/sessions/:id/fork-preview`，而不是前端复用 `/messages`。**

复刻一遍 fork 的取数口径更可靠：切点是"那一轮的助手最终回复"，而 `/messages` 的 `beforeMessageId` 是**排他**上界，直接把切点当 `beforeMessageId` 传会把来源那一整轮（用户消息 + 助手回复）漏掉——预览会比真实结果少一轮，正是本需求要消灭的偏差。所以后端用含上界的两个查询（`selectUserStartsThrough` / `selectRangeThrough`）单独实现，返回 VO 与 `/messages` 逐字段对齐（`messages` / `hasMore` / `nextBeforeMessageId` / `compactionEvents`），前端可零转换复用同一套渲染与翻页。

- 被否 A：前端本地截断已加载的主会话消息。主会话缓存默认只带最近 5 轮，深层轮次要再翻页，且边路发起的 fork 来源是边路会话（另一套缓存），不可靠。
- 被否 B：`/messages` 加 `cutMessageId` 参数。与 `beforeMessageId` 语义重叠且边界不同（含 vs 排他），一个接口两种边界后续必踩。

**决策 2：翻页上界取「翻页游标」与「切点」的较小值。**

向上翻页时 `beforeMessageId`（排他）与切点（含）同时存在：若只用游标，用户可能翻到切点之后的内容，看到比真实 fork 更多的东西。取最小值后两侧都安全，且与"预览 ⊆ 真实 fork"的不变式一致。

**决策 3：压缩事件只回传切点之前的。**

与落库侧 `forkParentMessages` 的既有决策同源：切点落在压缩边界之前时整体不复制压缩状态。预览若仍渲染那些标记，用户会以为边路会话里"前面是摘要"，与实际不符。因此路由层过滤 `boundaryMsgId <= 切点`。

**决策 4：预览数据只活在前端本地 ref，不写 `sessionStore`。**

占位 Tab 的真实 sessionId 尚未分配。写进 store 会在三条路径上出问题：会话转正时 `props.sideSessionId` 的 watch 把占位缓存整体搬到新 id（预览消息会与后端 fork 回来的消息混在一起，靠 id 去重也依赖时序）；Tab 复用时上一次入口的残留会和本次预览抢镜；卸载清理按 `placeholderCacheKey` 清，和预览生命周期不一致。本地 ref 由 composable 自己管，`clear()` 在 `enabled` 转假 / 会话转正 / unmount 时统一调用。

**决策 5：占位 Tab 的继承方式单选在预览态必须保留可见。**

原 `v-if` 是 `!hasRealSession && displayMessages.length === 0`。预览一出消息这个条件就假，用户看完预览想改回"不继承"却找不到单选，被锁死在 fork 上。改为 `|| forkPreviewSelected`（预览态同样展示）。这条是 e2e 跑出来的真实缺陷，不是预防性设计。

**决策 6：`sending` 期间不让预览继续显示。**

首条消息发出后，乐观用户气泡与流式 assistant 占位都写在 store 的占位缓存里；此时若仍显示预览，用户看不到自己刚发出去的那条消息和正在生成的回复。因此 `forkPreviewSelected` 排除 `sending`。发送被拒时 `sending` 复位、乐观消息回滚，自然回到预览。

## 4. 实现要点

### 后端

- `session.repository.ts`：新增 `selectUserStartsThrough`（含切点的用户消息起点，支持翻页游标）与 `selectRangeThrough`（含切点的取数范围）。二者与既有 `selectUserStarts` / `selectRange` 的唯一差别就是边界含等号。
- `session.service.ts`：`getForkPreview(sessionId, cutMessageId, roundLimit, beforeMessageId)` 复刻 `getMessagesByRounds` 的轮次分页结构，只在边界处切换查询实现。
- `session.routes.ts`：`GET /v1/sessions/:id/fork-preview`，登录用户 + `requireSessionOwner` 归属校验；`forkFromMessageId` 非正整数返回 `PARAM_INVALID`，不属于本会话返回 `MESSAGE_NOT_FOUND`（不静默退化成全量）；`compactionEvents` 按切点过滤。

### 前端

- `composables/useForkPreview.ts`：请求 / 翻页 / 清理 + 代次守卫（切点或来源在途变化时丢弃迟到响应）。`watch(enabled, ..., { immediate: true })`——fork 图标入口会直接新建已带 fork 预置的 Tab，非 immediate 的 watch 永不触发。
- `components/chat/SideChatPanel.vue`：`displayMessages` / `compactionEvents` / `sideMessageHasMore` / `sideMessageLoadingOlder` / `loadOlderMessages` 五处数据源按"真实会话 → 预览 → 占位缓存"分流；消息区加预览提示条与 loading；继承单选条件放开；`props.sideSessionId` 转正 watch 里 `forkPreview.clear()`。

### 测试

- 后端：`session.routes.spec.ts` 4 条（切点口径 / 无切点 / 翻页游标透传 / 非法切点拒绝 + 压缩标记过滤），`session-extra.spec.ts` 服务层切点分支与翻页上界，`session.repository.spec.ts` 新 SQL 覆盖。
- 前端：`useForkPreview.test.ts` 6 条（按条件拉取 / 无来源不发请求 / 切点切换不串响应 / 翻页前插 / 失败回落空态 / 切模式与会话转正清空）。
- e2e：`tests/desktop-side-fork.spec.ts` 新增「选中 Fork 时占位 Tab 预览将复制过来的历史消息」（提示条、消息上屏、切回不继承即消失），并给 mock 补 `/fork-preview` 路由。

## 5. 风险

- **长会话首屏体积**：与真实 fork 后首屏一致（默认最近 5 轮），无新增风险；用户翻页才拉更多。
- **来源会话在发送后被删**：预览失败（404）只表现为回到空态，不影响发送链路（后端创建时仍会校验），符合"预览是辅助、不阻断"的定位。
- **预览与真实 fork 的时刻差**：与既有 fork 语义一致——复制发生在发送那一刻而非点击那一刻；用户在来源会话继续推进后再发，拿到的是更新的历史。这是既有设计，不是本方案引入。
