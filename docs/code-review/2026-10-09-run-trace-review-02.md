# 任务运行轨迹透视 · 第二轮代码审查（修复后复审）

- **日期**：2026-10-09
- **分支**：`feature/run-trace`，工作区 `/Users/yangjiayi/AiProjects/mao/.worktrees/run-trace`
- **审查对象**：`git diff main..HEAD`（`34529916` 特性提交 + `666a2cf9` 修复提交）
- **审查口径**：与第一轮相同——只审功能逻辑、不改代码、每个 bug 附可运行探针、不过度苛刻。
- **前情**：第一轮 3 个 bug（`docs/code-review/2026-10-09-run-trace-review-01.md`）已在 `666a2cf9` 修复。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-4 | 中 | desktop `RunTracePanel` | 轨迹 Tab 的 KeepAlive `:key` 恒为 `'trace'`（不含会话维度），而面板唯一的自动加载入口是 `onMounted`；在会话 A 打开过轨迹后切到会话 B 再打开轨迹，KeepAlive 复用同一实例（只触发 `onActivated`），B 的轨迹永远不加载，界面显示误导性的「暂无轨迹」，必须手动点刷新 |

**第一轮 3 个 bug 的修复均正确，且未引入新的功能问题**（逐项核查见「三项修复核查」）。

另有 1 个流程性提醒（非本特性 bug）：HEAD 落后 main 一个提交，`main..HEAD` 的 diff 夹带了该提交的反向改动，合并前需先合入 main，否则会误删他人功能（详见文末）。

---

## BUG-4【中】跨会话打开轨迹 Tab 不加载数据

### 位置

- `desktop/src/components/center/RunTracePanel.vue:340-343`——唯一的自动加载入口：

  ```ts
  onMounted(() => {
    // KeepAlive 逐出后重挂载 / 首次打开同一条路径：按当前会话重拉
    void loadFirstPage()
  })
  ```

  全文没有 `watch(() => props.sessionId, …)`，也没有 `onActivated`（已用探针静态核对）。其余加载入口全是用户主动行为：`applyThresholds` / `reload`（刷新按钮）/ `loadMore` / `fetchAllPages`（导出），以及执行终止时的 `refetchLoadedPages`。
- `desktop/src/components/center/CenterTabContainer.vue:31-35`——key 是会话无关的常量：

  ```vue
  <RunTracePanel
    v-else-if="activeTab?.type === 'trace'"
    :key="activeTabId"
    :session-id="props.sessionId"
  />
  ```

  `useCenterTabs.openTraceTab()`（`desktop/src/composables/useCenterTabs.ts:320`）为**每个会话**建一个 `id: 'trace'` 的单例 Tab，因此任何会话的轨迹 Tab 的 `activeTabId` 都是 `'trace'`，KeepAlive 缓存键相同。
- 对照组（说明这是本面板独有的疏漏）：
  - `ChatPanel.vue:389` 同样是无 key、被 KeepAlive 跨会话复用的实例，但它有 `watch(() => sessionStore.activeSessionId, restoreForActiveSession)` 负责重载；
  - `FileViewer` / `SideChatPanel` / `SubagentChatPanel` 的 `:key` 都带实体维度（文件路径 / `side:{realId}` / `subagent:{childSessionId}`），换实体即重挂载。

### 触发链

1. 会话 A 打开「轨迹」Tab → `RunTracePanel` 挂载，`loadFirstPage()` 拉 A 的数据进 store；
2. 用户切到会话 B（`/tasks/A` → `/tasks/B`，`router-view` 无 key，`TaskView` 实例复用；`useCenterTabs.currentSessionId` 变为 B，B 的激活 Tab 是 chat）→ 轨迹 v-if 为 false，`RunTracePanel` 被 `<KeepAlive :max="20">` 缓存（键 `'trace'`）；
3. 用户在 B 上点「轨迹」→ `openTraceTab()` → 渲染出的 vnode key 仍是 `'trace'` → **KeepAlive 命中缓存，复用同一实例**（触发 `onActivated`，不触发 `onMounted`）；
4. `sessionId` prop 变成 B，但没有任何加载入口响应这个变化 → `sessionStore.getTraceRuns('B')` 查不到数据（store 里只有 A 的）→ 面板走 `runs.length === 0 && unattributed == null` 分支，显示「暂无轨迹」，且 `loading` 为 false，连加载态都不显示；
5. 用户必须手动点「刷新」才能看到 B 的轨迹。切回 A 反而正常（store 里仍留着 A 的数据），所以问题只在「每个会话第一次打开轨迹 Tab」时出现。

### 影响

跨任务排障正是本特性的核心场景（看完一个任务的轨迹接着看下一个）。第二及以后的任务轨迹不可见，且空态文案「暂无轨迹」会让人误以为该任务没有轨迹数据。不影响已落库数据，手动刷新可恢复；严重度定「中」而非「高」是因为可一键恢复、且不影响其他端与其他功能。

### 验证测试（探针，跑完即删）

文件：`desktop/src/__probe2_trace_session.test.ts`（与第一轮一致，临时文件、不提交、不改产品源码）。两个用例：

- **探针 1（静态契约）**：断言 `RunTracePanel.vue` 只有 `onMounted` 入口、不存在 `watch(() => props.sessionId)` 与 `onActivated`，且 `CenterTabContainer.vue` 给轨迹面板的 key 是 `activeTabId`。
- **探针 2（运行时语义）**：用 `vue` 的 `createRenderer` 复刻 `CenterTabContainer` 的结构（v-if/v-else-if 链 + 轨迹面板 `:key="activeTabId"` + `<KeepAlive :max="20">`），把会话从 A 切到 B 再打开轨迹 Tab，记录 mount / activated / prop 事件序列。

探针源码（节选，完整见下）：

```ts
const TracePanel = defineComponent({
  props: { sessionId: { type: String, default: '' } },
  setup(props) {
    events.push(`mount:${props.sessionId}`)                 // 镜像 RunTracePanel：只有 onMounted 拉数
    onActivated(() => events.push(`activated:${props.sessionId}`))
    watch(() => props.sessionId, (sid) => events.push(`prop:${sid}`))
    return () => h('div', `trace:${props.sessionId}`)
  },
})
// 容器与 CenterTabContainer 相同：轨迹分支 :key="activeTabId"
// 会话 A 打开轨迹 → sessionId='B' + activeTabId='chat' → 再 activeTabId='trace'
expect(events).toEqual(['mount:A', 'activated:A', 'prop:B', 'activated:B'])
```

**实测输出**（2/2 通过，事件序列即证据：`prop:B` 之后只有 `activated:B`，没有 `mount:B`）：

```
 RUN  v4.1.10 /Users/yangjiayi/AiProjects/mao/.worktrees/run-trace/desktop
 ✓ src/__probe2_trace_session.test.ts (2 tests) 12ms
 Test Files  1 passed (1)
      Tests  2 passed (2)
```

复跑：

```bash
cd desktop && npx vitest run src/__probe2_trace_session.test.ts
```

### 修改方向（供参考，未改代码）

任选其一即可，与仓库既有做法对齐：

1. 容器给轨迹面板的 key 加会话维度：`:key="`trace:${props.sessionId}`"`（与 FileViewer / SideChatPanel / SubagentChatPanel 一致）；
2. 或面板内加 `watch(() => props.sessionId, () => { void loadFirstPage() })`（与 ChatPanel 的 `activeSessionId` watch 一致）；
3. 或加 `onActivated(() => { if (runs.value.length === 0) void loadFirstPage() })`（兜底，顺带覆盖 KeepAlive 逐出重挂载之外的激活路径）。

建议同时把「切会话后 `expandedRuns` / `loadedPages` 未重置」一起处理（runId 全局唯一，暂不会串数据，但 `loadedPages` 会带着 A 的页数去重拉 B）。

---

## 三项修复核查（是否引入新问题）

### 修复 1：`markLastMessageFinished` 跳过 USER 消息

- 代码：`backend-ts/src/session/session.service.ts:1146-1153`，`last.role !== 'USER'` 才写 `updated_at`。
- **桌面「任务结束时刻」取数路径核查**（本轮重点）：
  - 桌面轮次时长的终点是 `useMessageRounds.ts:64-65` 的 `reply || steps[steps.length - 1]`，取 `updatedAt || createdAt`；而 `reply`/`steps` 全部来自 `g.assistantMsgs`（`:106-123`），**永远是非 USER 消息**，因此跳过 USER 不影响该展示。
  - 取消命中工具阶段时该轮 `assistantMsgs` 为空 → `stepCount === 0` → `durationText` 直接留空，本来就不展示时长。
  - 后端侧 `message.updated_at` 的读者只有 `run-trace.service.ts:94/186`（编辑切点）；写入方只有 `editMessageAndTruncate`（`session.service.ts:1102`，真编辑）与 `markLastMessageFinished`（现已跳过 USER）。飞书 `replaceMessageContent` 的裸 `UPDATE … SET content` 不碰 `updated_at`。
- 唯一行为变化：终态时若最后一条是更早 run 的助手消息，其 `updated_at` 仍会被刷新——这是修复前就有的存量行为，桌面只把它当「那一轮的结束时刻」，run 轨迹读模型不读助手消息的 `updated_at`，无新问题。
- 回归测试已落库且通过：`backend-ts/src/session/session-extra.spec.ts`（跳过 USER / 照旧刷新 ASSISTANT / 无消息不动）、`backend-ts/src/session/run-trace.service.spec.ts`「keeps a cancelled run in the current segment when the anchor USER message was never edited」。

### 修复 2：管理后台发 `scope` 而不是 `runTraceScope`

- 代码：`admin/src/views/analytics/AnalyticsView.vue:305` `query.scope = runTraceDimension.value`；`types.ts` 的 `AnalyticsQuery.scope`、`useAnalyticsPeriod.ts:48` 的 `periodKey` 同步改名。
- **URL 分享 / 刷新还原核查**（本轮重点）：
  - URL 参数名仍是 `rtScope`，未动：`syncUrl()`（`:324` 计算、`:354-356` 写/删）与 route watch（`:444` 监听、`:454-476` 还原）保持原样，分享链接与刷新还原链路不变；
  - `runTraceDimension` 初值仍取 `route.query.rtScope === 'user' ? 'user' : 'agent'`（`:176`）；
  - 缓存键 `periodKey` 已纳入 `scene`/`scope`（换口径或换维度必然 miss），且 `handleRunTraceDimensionChange` 仍显式 `invalidateAnalytics('run-trace')`，双保险；
  - 后端 `admin.routes.ts:127` 读 `q.scope`，非 `'user'` 一律回落 `'agent'`，不透传任意字符串；mao-cli `analytics run-trace --scope agent|user` 同名同值，契约两端一致。
- 新 spec 通过：`backend-ts/src/admin/admin.routes.spec.ts`（scene/scope 透传、回落、`analytics:read` 403）、`backend-ts/src/admin/admin-analytics.service.spec.ts`（维度名补全、失败率按比例排序、limit 截断、SQL 形状）。
- 小观察（不算 bug，提请确认是否有意为之）：离开「运行轨迹」Tab 时 `syncUrl` 会删掉 `rtScope`，route watch 随即将本地维度重置为 Agent，因此维度选择不跨 Tab 保留；同机制的 `modelId`（模型 Tab）在离开 Tab 时同样从 URL 删除，但 watch 里 `modelChanged && nextTab === 'models'` 的条件使本地值被保留——两者的保留策略不一致。

### 修复 3：`/trace` 的 `limit` 下限钳到 1

- 代码：`backend-ts/src/session/session.routes.ts:518` `clamp(queryOptInt(request, 'limit') ?? 5, 1, 50)`；`clamp` 对非有限值回落 `min`、`Math.floor` 取整。
- 新 spec 通过：`limit=50` / 缺省 / `0` / `-5` / 越权 403。
- 附带核查：`limit` 被钳到 ≥1 后，「有用户消息但本页被裁空」与「会话没有任何用户消息」两种分支不会混淆（`run-trace.service.ts:86-88` 与 `:99-104`），`run-trace.service.spec.ts` 的「treats everything as unattributed when the session has no user message」用例确认后者仍正确。

---

## 测试基线（修复后复跑，全部通过）

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| backend-ts | `npm test` | 264 files / 3146 tests 通过，1 file / 13 tests skipped，exit 0 |
| desktop | `npm run test:unit` | 33 files / 341 tests 通过，exit 0 |
| admin | `npx vue-tsc -b` + `npm run build` | 均 exit 0（仅存量 chunk 体积告警） |

日志：`/tmp/review2-backend.log`、`/tmp/review2-desktop.log`、`/tmp/review2-admin-tsc.log`、`/tmp/review2-admin-build.log`。

---

## 附录 B：已核查无问题的点（节选，第一轮清单的复核与扩展）

- **run 归属主干**：`selectUserStarts` 的 `id < beforeRunId` 排他边界、`limit + 1` 判 `hasMore` 后丢弃、`selectUserStamps` 一条查询复用（时间窗上界 / 编辑切点 / 未归属边界），翻页不重不漏。
- **工具归属**：`tool_call_id → 现存消息 → run`（即使 `created_at` 落窗外）、同秒多候选进 `unplacedTools` 不猜、`toolSuccess/toolError` 不重复计数、编辑前的助手消息已被截断故工具恒归当前段。
- **墙钟与成本**：`max(end) − min(start)`、无 duration 不参与、负值归零；旁路调用进合计、任一行未配价则 run 成本为 null；慢/贵用 `>=` 且贵看四类 token 之和。
- **编辑切点**：只有 `editMessageAndTruncate`（`session.service.ts:1102`）会写 USER 的 `updated_at`；`markLastMessageFinished` 修复后不再污染；V029「仅用户消息编辑时填充」的约定恢复成立。
- **阈值与导出**：路由 clamp（1000–3600000 / 1000–10000000）、桌面 localStorage 读写容错、CSV 六位小数成本 / BOM / CRLF / 双引号转义 / 已中断写「已中断」/ 未归属 `runId` 空串，与 admin `LlmCallView` 导出口径一致；JSON 结构与接口一致。
- **WS 事件**：`round_start`/`round_end` 进 `STREAM_EVENT_TYPES`、`send()` 统一带 `executionId`、桌面 store 按 `${sessionId}|${executionId}` 隔离临时态、终态 `clearLiveState(sessionId)` 清全部键；`activity` 事件新增 `duration_ms` 为增量字段，不影响旧前端；`detail_json` 冗余 `toolCallId`/`approvalMark` 后，审批标记「先读工具消息 metadata、再回落活动 detail」的优先级有 spec 覆盖。
- **admin 聚合 SQL**：`ROW_NUMBER() OVER (PARTITION BY …)`、`scene` 过滤、贵榜 `cost_micros IS NOT NULL`、未关联维度不进榜、失败率按比例排序与截断、占位名；`goSessions` 的 `userId`/`agentId` 与 `SessionListView` 的 query 解析对得上。
- **桌面 tab**：`openTraceTab` 每会话单例、`restoreTraceTab` 先建 tab 再还原、`closeOtherTabs` 保留轨迹 tab、KeepAlive `:max="20"` 逐出后重挂载会重拉；刷新还原链路（第一轮探针 4/4）仍成立。
- **权限**：`/trace` 走 `requireSessionOwner`（越权非 0）、admin 新路由走 `analytics:read`；`/trace` 未挂进分享快照组装。
- **性能面**：`selectBySessionAll` 整表拉取在注释中声明为 P1 可接受；`session_activity` 的心跳只更新 `session.last_activity_at`、不插活动行，不会污染轨迹统计。

---

## 附录 C：流程性提醒（非本特性 bug，合并前需处理）

`git log --oneline main..HEAD` 显示 HEAD 基于 `717e6a86`，而 main 已多出 `1f8e2f6c`。因此 `main..HEAD` 的 diff 里夹带了该提交的反向改动，看起来像本特性「删除」了这些代码：

- `harness/core/agent-loop.ts` 的 `provisionalToolCallIds`（首片无 id 时的占位 id 逻辑）
- `harness/core/compaction-service.ts` / `context-manager.ts` / `session-compaction-orchestrator.ts` 的「触发阈值跟会话主模型走、压缩模型窗口只做溢出保护」双窗口逻辑
- `desktop/src/stores/session/messages.ts` 的队列消息 id 字符串归一化

这些都不是运行轨迹特性的改动，只是分支落后于 main。合并前先 `git merge main`（或 rebase）再出 diff，可避免误删与合并冲突；本报告的功能结论以 `git diff 717e6a86..HEAD`（特性真实差异）为准。
