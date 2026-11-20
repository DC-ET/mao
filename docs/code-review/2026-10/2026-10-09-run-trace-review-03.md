# 任务运行轨迹透视 · 第三轮（最终轮）代码审查报告

- 日期：2026-10-09
- 工作区：`/Users/yangjiayi/AiProjects/mao/.worktrees/run-trace`
- 分支：`feature/run-trace`（相对 `main` 三个功能 commit + 一个 merge commit）
- 审查范围：`git diff main...HEAD`（三方差异，不含 main 自身改动），只关注功能逻辑，不含文档变更
- 结论：**无重大 bug**。BUG-4 的两项修复到位且互补，前四轮已修复的 4 个 bug 无回归；本轮发现 1 个**低严重度**边界问题（跨页归属重复），已用测试用例验证，见 §3。

---

## 1. 本轮审查基线

| 项 | 结果 |
| --- | --- |
| backend-ts `npm test` | 264 个文件 / 3154 个用例通过（用户自测，与本轮单独复跑一致） |
| desktop `vitest run` | 34 个文件 / 344 个用例，1 失败：`useChat.test.ts > restoreSession > 待办与队列慢响应写入原会话，不覆盖切换后的会话` |
| 上述 1 个失败归属 | 在 main 检出（`/Users/yangjiayi/AiProjects/mao` @ `1f8e2f6c`）上同样失败，报错一致（`expected [ { id: 'qa', sessionId: 'A' } ] to deeply equal [ { id: 'qa' } ]`），系 main 队列改动自带，与本次需求无关 |
| desktop `vue-tsc` | exit 0 |
| admin `vue-tsc` + `npm run build` | exit 0（第二轮已跑绿，本轮 diff 未触及 admin 新增逻辑） |

本轮单独复跑的相关回归集：`run-trace.service.spec.ts`（24）+ `session.service.spec.ts`（41）+ `admin.routes.spec.ts`（2）= 67 通过；desktop `components/center` + `stores/session` + `views/task` = 46 通过；`run-trace-panel-session.test.ts` 2 通过。

---

## 2. BUG-4 两项修复核查（到位，无新问题）

BUG-4 修复内容：`CenterTabContainer.vue` 的 RunTracePanel key 由 `activeTabId` 改为 `` `trace-${props.sessionId}` ``；`RunTracePanel.vue` 新增 `watch(() => props.sessionId)` 兜底（重置 `loadedPages` 并重拉首页）；新增回归测试 `desktop/src/components/center/run-trace-panel-session.test.ts`。

### 2.1 两项修复各自成立且互补

- 修复 1（key 带会话维度）：轨迹 Tab 每会话同 id（`'trace'`），key 不含会话维度时 KeepAlive 会跨会话复用同一实例（只触发 props 变化 / `onActivated`，不重挂载），界面留着上一个会话的轨迹或显示误导性的「暂无轨迹」。key 改为会话维度后跨会话切换即换缓存实例，属根因修复。
- 修复 2（watch 兜底）：即使将来有人把 key 改回会话无关常量（或其他容器复用同一实例），面板自己也会重拉。属双保险，且 `loadedPages` 一并重置，不会出现「翻到第 3 页后切会话仍停在第 3 页」的错位。
- 两处自动加载入口不冲突：`onMounted` 只在挂载时跑一次，watch 只在 props 变化时跑；key 带维度后跨会话必然重挂载（走 onMounted），同会话内 props 不变，两条路径不会同时触发造成重复拉取。

### 2.2 重点复查项：KeepAlive `:max="20"` 逐出、A→B→A 切换

用三个探针（模块级容器定义，避免在渲染函数内创建组件定义导致 Vue 判为类型变化而误卸载）实测：

1. **会话维度 key + `:max="20"`，A→B→A**：`['/sessions/A/trace', '/sessions/B/trace']` —— 每个会话只拉一次，切回 A 命中缓存走 `onActivated`，不重复拉取、不丢状态（`traceRuns` 按 `sessionId` 分桶存在 store 里，实例缓存与数据桶双维度都对齐）。
2. **去掉 key 修复（扁平 key）+ watch 兜底**：watch 正常补拉第二个会话，证明兜底独立有效。
3. **`:max="1"` 极端逐出**：`['A', 'B', 'A']` —— 第 20 个会话之后早期缓存被 LRU 逐出，切回时重新挂载 + 重拉首页，拿到的是最新数据，无脏数据残留（store 桶内数据仍是该会话的，重拉只是刷新）。

结论：`:max="20"` 的逐出行为不会引入新问题，最坏情况就是多一次首页请求；A→B→A 无重复拉取、无状态丢失。

### 2.3 曾怀疑并已排除的一个新问题

导航到无参 Home 路由时，`TaskView.vue` 的 route watcher 会 `setActiveSession(null)`，`sessionId` 瞬时为空，key 会短瞬变成 `trace-`。因该 watcher 是 pre-flush（先于渲染执行），渲染发生时 `sessionId` 已是稳定值，不会出现「空 key 实例被创建并缓存」的中间态。已通过 2.2 的探针 1/3 佐证（A→B→A 与逐出路径均无多余请求）。

---

## 3. 本轮唯一新发现（低严重度）：迟到活动跨页归属重复

### 3.1 现象

设计文档 §147 / §329 明确：有 `tool_call_id` 的活动「按消息归 run，**不看** activity 的 created_at（异步插入可能晚于下一条用户消息）」。实现里 `declByCallId` / `toolMessageByCallId` 只索引**本页** run 的现存消息（`run-trace.service.ts:120-135`），于是：

> 「归属 run N（在第二页）、但 `created_at` 落进 run X（在第一页）窗口」的迟到活动，在第一页匹配不上任何本页消息 → 掉进按时间窗的兜底分支 → 成为 run X 的 `unplacedTools`；第二页又按消息正确归到 run N。同一行活动在两个页面各出现一次，`toolSuccess` / `toolError` 跨页重复计数。

这与 `run-trace.service.ts:158` 自己的注释「其余情况属于其他页的 run，本页不出现」也相矛盾。

### 3.2 触发条件（决定严重度为低）

需同时满足两点：

1. 活动的 `created_at` ≥ 下一个 run 锚点的 `created_at`（run 窗口是半开区间 `[anchor.created_at, 上界)`，`findRunIndexByTime` 对相等时刻归下一窗）。活动落库是 fire-and-forget：`ws-streaming-event-listener.ts:146` 的 `void this.recordActivity(...)`，`created_at` 由库在提交时赋值（`session_activity.created_at DATETIME DEFAULT CURRENT_TIMESTAMP`，**秒级精度**）。因此只要活动提交落在下一用户消息提交的同一秒或更晚（连接池拥塞、取消执行后队列消息被自动消费等路径），条件即成立——这正是设计所说的「异步插入可能晚于下一条用户消息」。
2. 归属 run 与下一 run 跨页（默认 `limit=5`，第二页需用户手动「加载更多」）。

**同页内不会发生**：归属 run 就在本页时，消息匹配优先命中，与 `created_at` 无关。所以影响面仅限翻页后的旧 run 展示与跨页汇总计数。

### 3.3 测试用例验证（探针，未提交）

探针文件：`backend-ts/src/session/zz-review3-crosspage.spec.ts`（复现后已删除，源码见附录 A）。构造：run N = 用户消息 1（10:00:00）+ 助手消息 2（10:00:05，声明 `tc1`）；run X = 用户消息 5（10:05:00）+ 助手消息 6；活动 1 的 `detail_json.toolCallId = 'tc1'` 但 `created_at = 10:05:07`（迟到插入）。

运行：`cd backend-ts && npx vitest run src/session/zz-review3-crosspage.spec.ts`

实际输出（两个断言均失败，即问题真实存在）：

```
 FAIL  backend-ts/src/session/zz-review3-crosspage.spec.ts > 候选问题：迟到活动跨页重复出现 > 同一行活动在两页各出现一次
AssertionError: expected { p1: [ 'tc1' ], p2: [ 'tc1' ] } to deeply equal { p1: [], p2: [ 'tc1' ] }

 FAIL  backend-ts/src/session/zz-review3-crosspage.spec.ts > 候选问题：迟到活动跨页重复出现 > 跨页重复计数
AssertionError: expected 2 to be 1 // Object.is equality

 Test Files  1 failed (1)
      Tests  2 failed (2)
```

- 断言 1：`p1`（第一页）不应出现 `tc1`，实际出现 → 同一行活动两页各一份。
- 断言 2：两页 `toolSuccess + toolError` 合计应为 1，实际为 2 → 跨页重复计数。

### 3.4 修复方向（仅供参考，未改代码）

不能简单把时间窗兜底限制给「无 tool_call_id 的活动」——设计 §157 规定编辑截断的旧工具（**带** tool_call_id）要走 `created_at < updated_at` 进 `before_edit.unplacedTools`，现有用例「splits before_edit segment by anchor updated_at」依赖该路径。可行方向是把消息匹配索引做成会话级（按本页 run 覆盖的用户消息 id 区间预取 `toolCalls` / `toolCallId` 列，或单独查一次全会话的 `tool_call_id → 用户消息 id` 映射），让消息匹配跨页生效；次选是在时间窗兜底命中时排除「本活动能在全会话索引里对上某条现存消息」的情况。

---

## 4. 前四轮已修复的 4 个 bug 无回归（逐条核对）

| Bug | 修复位置 | 本轮核对结果 |
| --- | --- | --- |
| BUG-1 `markLastMessageFinished` 误写 USER 的 `updated_at` | `session.service.ts:1148-1155`（`if (last != null && last.role !== 'USER')`） | 仍在，merge 带入的 `updateContextTokens` 串行化改动未触及该分支；`session.service.spec.ts` 41 通过 |
| BUG-2 管理后台发 `runTraceScope` 而非 `scope` | `AnalyticsView.vue:305`（`query.scope = runTraceDimension.value`） | 仍在；URL 参数名 `rtScope` 未变，分享链接 / 刷新恢复链完整；`admin.routes.spec.ts` 2 通过 |
| BUG-3 limit 下界钳制 | `session.routes.ts:518`（`clamp(queryOptInt(...) ?? 5, 1, 50)`） | 仍在；`session.routes.spec.ts` 覆盖 |
| BUG-4 轨迹 Tab 跨会话不复用实例 | `CenterTabContainer.vue` key + `RunTracePanel.vue` watch | 见 §2；`run-trace-panel-session.test.ts` 2 通过 |

---

## 5. 附录 A：探针源码（复现 §3，验证后已从工作区删除）

```ts
// backend-ts/src/session/zz-review3-crosspage.spec.ts（节选：fixture 与断言）
const QUERY = { beforeRunId: null, limit: 1, slowMs: 60_000, expensiveTokens: 50_000 };

function fixture() {
  return makeService({
    messages: [
      user(1, '2026-10-09 10:00:00', '第一轮'),                       // run N（旧）
      assistant(2, '2026-10-09 10:00:05', [{ id: 'tc1', name: 'shell' }]),
      user(5, '2026-10-09 10:05:00', '第二轮'),                       // run X（新）
      assistant(6, '2026-10-09 10:05:05', []),
    ],
    calls: [
      call(1, { createdAt: '2026-10-09 10:00:06' }),
      call(2, { id: 2, createdAt: '2026-10-09 10:05:06' }),
    ],
    // 迟到插入：属于 run N 的 tc1，但 created_at 已落进 run X 的窗口
    activities: [activity(1, { detailJson: JSON.stringify({ toolCallId: 'tc1' }), createdAt: '2026-10-09 10:05:07' })],
    events: [],
  });
}

describe('候选问题：迟到活动跨页重复出现', () => {
  it('同一行活动在两页各出现一次（第一页按时间窗兜底、第二页按消息归）', async () => {
    const service = fixture();
    const page1 = await service.buildTrace(1, QUERY);
    const page2 = await service.buildTrace(1, { ...QUERY, beforeRunId: 5 });
    const toolsOf = (page) => page.runs.flatMap((r) => r.segments.flatMap((s) =>
      [...s.rounds.flatMap((x) => x.tools), ...s.unplacedTools])).map((t) => t.toolCallId);
    // 设计 §147 预期：只在 run N（第二页）出现一次，第一页不按 created_at 改挂
    expect({ p1: toolsOf(page1), p2: toolsOf(page2) }).toEqual({ p1: [], p2: ['tc1'] });
  });

  it('跨页重复计数：同一行活动被两个页面的 run 各计一次 toolSuccess', async () => {
    const service = fixture();
    const page1 = await service.buildTrace(1, QUERY);
    const page2 = await service.buildTrace(1, { ...QUERY, beforeRunId: 5 });
    const count = (page) => page.runs.reduce((sum, r) => sum + r.totals.toolSuccess + r.totals.toolError, 0);
    // 两页加起来只应有 1 次工具成败
    expect(count(page1) + count(page2)).toBe(1);
  });
});
```

（`makeService` / `user` / `assistant` / `call` / `activity` 等辅助与 `run-trace.service.spec.ts` 现有夹具同型：mock `MessageRepository` 的 `selectUserStarts` / `selectRange` / `selectUserStamps`、`LlmCallRepository.selectBySessionWindow`、`SessionActivityRepository.selectBySessionAll`、`SessionCompactionEventRepository.selectBySessionId`。）

## 6. 附录 B：最终核查过、确认无问题的要点

- **读模型主干**：run 划分（一条 USER 到下一条 USER）、`scene=agent` 出轮、`tool_call_id` 消息归属优先于 `created_at`、`wallClockMs = max(end) − min(start)`（`start = created_at − duration_ms`）、编辑切点 `updatedAt > createdAt` 切 `before_edit` 段、压缩 marker 按 `boundary_msg_id` 硬归属、`unattributed` 仅第一页且早于首条用户消息——均与设计 §5.2 一致，`run-trace.service.spec.ts` 24 个用例覆盖。
- **分页契约**：`limit+1` 判 `hasMore` 后丢弃多取的一条、`beforeRunId` 翻页、窗口半开且互不相交、`clamp(limit,1,50)`、`clamp(slowMs,1_000,3_600_000)`、`clamp(expensiveTokens,1_000,10_000_000)`（`session.routes.spec.ts` 有上下界与缺省值用例）。
- **归属竞态的其余分支**：取消时工具消息未落库 → 时间窗兜底进同一 run；编辑截断旧工具 → `before_edit.unplacedTools`；同秒多候选不猜（ambiguous）；`claimedCallIds` 防一调用被两组工具占用。
- **admin 侧**：`scope` 仅接受 `user|agent`、URL 参数 `rtScope` 与缓存键、RunTraceTab 维度切换与刷新恢复、分页与 CSV 导出列。
- **desktop 侧**：`traceRuns/hasMore/unattributed/loading` 按 `sessionId` 分桶；临时态按 `${sessionId}|${executionId}` 隔离（崩溃恢复 / 重跑换 executionId 不串画面）；阈值 localStorage 持久化 + 变更重拉首页；终态相位 `refetchLoadedPages` 只重拉已加载页；导出 CSV/JSON；「任务结束时刻」在 USER 跳过后仍由 `g.assistantMsgs` 推导（BUG-1 修复无副作用）。
- **ws-streaming-event-listener**：活动落库冗余 `toolCallId` 与审批标记、`durationMs` 以执行层 meta 为权威、`status` 以 meta 为准且旧路径启发式仅作防御、`round_*` 只下发不落库。
- **CHANGELOG / skills 同步**：0.0.251 条目已合并为一条，`skills/mao-cli` 的 analytics 说明与 reference 同步（非功能逻辑，仅确认无遗漏）。
- **diff 整体**：`git diff main...HEAD` 共 45 文件 / +4915 −36，与第二轮审查范围一致（仅多 BUG-4 修复三处：`CenterTabContainer.vue` +6、`RunTracePanel.vue` watch、新回归测试 +172），第二轮逐项分析结论继续成立。
