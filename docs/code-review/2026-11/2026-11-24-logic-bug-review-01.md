# 逻辑 BUG 审查报告（全仓第六轮）

- 日期：2026-11-24
- 审查方式：3 个只读审计代理并行分区扫描（harness 引擎 / 后端调度与通道集成 / desktop 前端）+ 主会话独立审查（backend-ts 领域服务 / admin / agent-cli / 微信与钉钉通道），对全部候选逐条「反证 → 按正确契约写用例 → 普通 `it` 实跑抓真实失败 → 转 `it.fails` 固化」实证。合计 15 个候选，**最终确认 8 个**（分属 8 个独立缺陷点），6 个机制成立但缺离线实锤条件留档「候选未确认」（复核后为 5 个，见下），1 个经核实排除（见「误报记录」）。
- 复核（2026-11-24 当晚，主会话逐条重读源码 + 复跑锚点）：**8 个确认项全部真实存在，无一误报、无一被后续改动修掉**——6 个锚点 spec 原样复跑（backend-ts 24 例 / agent-cli 3 例，全部按 `it.fails` 预期通过 = 主证仍失败、对照组仍通过）。逐条补齐了复核发现（BUG-1 的 `updateAgent` 同型路径顺序正确、BUG-5 修复成本高于同组其它项、BUG-7 定级下调为低、BUG-6 与 5s 退出定时器竞速等，见各节「复核」段）。6 个候选重读代码后**移除 1 个**（长连接退避重置：意图存疑，「达上限后归零重启」可能是故意的循环重启设计，改动有让恢复变更慢的回归风险，修复价值不成立）；其余 5 个代码事实全部属实。误报记录中 desktop `sendMessage` 的排除结论复核仍成立，且不可达性比记录时更强（`handleSend` 现已把非活跃发送改走 `sendMessageAndWaitForSave`）。
- 未修复：两轮（审查 + 复核）都只做审查与实证，**未改任何产品代码**；修复方向逐条给出，除 BUG-5 需前后端协同外均为小改动。
- 实证纪律（沿用 2026-11-13 / 2026-11-22 两轮）：每个确认项先以**普通 `it` 实跑**捕获真实失败输出（下文「验证输出」即为实跑结果，非推断），失败信息逐字摘录；确认后按本轮惯例转 `it.fails` 固化，**套件保持全绿**，修复后转正为普通 it 回归。每个 bug 均配「对照组」用例证明功能本身意图正确、修复手段现成（同库 `clipByCodePoints`、同文件对称兜底、同分支已有守卫），排除「整个模块坏了」类误判。
- 基线：backend-ts `npm run build` 0 错、全量 `npm test` 6804 例中 6777 通过（13 失败全部为本轮新增 bugIt 用例，见下）；agent-cli `npm run build` 0 错、全量 797 例中 795 通过（1 失败为本轮新增 bugIt 用例）；admin 全量 234 例通过（本轮新增的 5 个临时用例在移除前实跑：3 expected fail | 2 passed，全文见附录 A）。
- admin 两条（BUG-4 / BUG-5）的组件级用例依赖 `@vue/test-utils@2`，该依赖不在 `package.json` 中（admin 单测基建只覆盖纯逻辑）。沿用 2026-11-03 轮先例：用例实跑取证后**从仓库移除**、依赖卸载，全文见下方附录 A，复现命令一并给出；其余 6 个 spec 文件（后端 / agent-cli，无额外依赖）已提交为 expected-failure 锚点，2026-11-24 复核轮原样复跑仍然全绿（锚点有效）。

---

## 确认清单（8 个，按严重度排序）

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| BUG-1 | 高 | `backend-ts/src/agent/agent.service.ts:97-100` | 创建 Agent 先清默认旗标再校验模型，校验失败时全库零默认 Agent，会话创建全面中断 |
| BUG-2 | 中 | `backend-ts/src/dingtalk/send.service.ts:23-36` | 回复截断按 UTF-16 码元硬切，切点落在 emoji 代理对中间产出孤立代理，对端渲染乱码 |
| BUG-3 | 中 | `backend-ts/src/harness/core/no-progress-notice.ts:55-64,273-301` | `create_scheduled_task` / `create_signal_watcher` 的随机 id 未按工具归一化，无进展守护对这两类工具永不触发 |
| BUG-4 | 中 | `admin/src/views/feedback/FeedbackView.vue:503-506` | 取消选择不清 el-table 内部选区，再勾选时复活已取消的行，批量忽略误删不可逆 |
| BUG-5 | 中 | `admin/src/views/feedback/FeedbackView.vue:474,484` | 「无 Agent（飞书）」矩阵行下钻时 null 被折叠成 undefined，实际返回全部 Agent 的反馈 |
| BUG-6 | 中 | `agent-cli/src/session/session-runner.ts:406-414` | print 模式 `--if-running=cancel` 分支无条件 `resetRound`，把用户的 Ctrl+C 取消旗标清掉，被取消的消息照样发出 |
| BUG-7 | 低（可达性受限） | `backend-ts/src/harness/core/harness-service.ts:785-796` | agent 级 compaction 覆盖的 `contextWindowTokens` / `maxSummaryTokens` 缺越界兜底，0/负数/NaN 放行 → token 压缩静默关闭 |
| BUG-8 | 低-中 | `backend-ts/src/weixin/webhook-fallback.service.ts:85,90` | 微信降级推送（送不出去时唯一可见渠道）截断同样按码元硬切，同族漏网点 |

---

## 修复记录（2026-11-24 当晚，8/8 已修复并转正）

| # | 修复方式 | 回归锚点 |
|---|---|---|
| BUG-1 | `requireEnabledModel` 前置到 `clearDefaultFlag` 之前（`agent.service.ts`）；`updateAgent` 顺序本就正确，未动 | `zz-bugverify-default-flag.spec.ts` 主证转正 |
| BUG-2 | `limitReply` / `markdownMessage` 两处 `slice` → `clipByCodePoints`（`send.service.ts`） | `zz-bugverify-surrogate.spec.ts` 2 主证转正 |
| BUG-3 | `no-progress-notice.ts` 新增 `SEMANTIC_KEYS_BY_TOOL`（Map，防原型链）白名单：两个工具各一条语义分支，`task_id` 不进全局黑名单；顺手把 send_media/shell 的挑选循环抽成 `pickSemanticKeys` | `zz-bugverify-noprogress-taskid.spec.ts` 3 主证转正；原「机制直证」对照例（断言两摘要不同）已反转为「修复直证」（断言相同） |
| BUG-4 | `clearSelection()` 补 `tableRef.value?.clearSelection()`（`FeedbackView.vue`，tableRef 声明启用） | 无单测（admin 基建只覆盖纯逻辑），靠 `npm run build` 验证；附录 A 用例供修复后贴回 |
| BUG-5 | 前端 `filters.agentIdNull` 标记 + `buildParams` 下发；后端 `feedback.routes.ts` 新增 `parseAgentIdFilter`（`agentIdNull=true` → `null`，具体 agentId 优先） | `feedback.routes.spec.ts` 新增三态用例（标记→null / 具体值优先 / 缺省→undefined） |
| BUG-6 | cancel 分支补 `if (!this.timedOutFlag && !this.cancelledByUserFlag)` 守卫（`session-runner.ts`） | `zz-bugverify-cancel-flag.spec.ts` 主证转正 |
| BUG-7 | `resolveCompactionConfig` 补 `contextWindowTokens` / `maxSummaryTokens` 越界兜底（`Number.isFinite` + `> 0`） | `zz-bugverify-compaction-window.spec.ts` 5 主证转正 |
| BUG-8 | 降级推送两处 `slice` → `clipByCodePoints`（`webhook-fallback.service.ts`） | `zz-bugverify-fallback-surrogate.spec.ts` 2 主证转正 |

**验证基线（修复后）**：backend-ts `npm run build` 0 错、全量 6805 例（6791 通过 / 14 跳过，6 个锚点 spec 的 13 个主证由 expected-failure 转为通过）；agent-cli `npm run build` 0 错、全量 797 例（796 通过 / 1 跳过，锚点主证转正）；admin `npm run build` 0 错。用户可见改动已记 `changelog/unreleased/2026-11-24-logic-bug-review-06-fixes.md`。

---

| # | 严重度 | 位置 | 一句话 |
|---|---|---|---|
| BUG-1 | 高 | `backend-ts/src/agent/agent.service.ts:97-100` | 创建 Agent 先清默认旗标再校验模型，校验失败时全库零默认 Agent，会话创建全面中断 |
| BUG-2 | 中 | `backend-ts/src/dingtalk/send.service.ts:23-36` | 回复截断按 UTF-16 码元硬切，切点落在 emoji 代理对中间产出孤立代理，对端渲染乱码 |
| BUG-3 | 中 | `backend-ts/src/harness/core/no-progress-notice.ts:55-64,273-301` | `create_scheduled_task` / `create_signal_watcher` 的随机 id 未按工具归一化，无进展守护对这两类工具永不触发 |
| BUG-4 | 中 | `admin/src/views/feedback/FeedbackView.vue:503-506` | 取消选择不清 el-table 内部选区，再勾选时复活已取消的行，批量忽略误删不可逆 |
| BUG-5 | 中 | `admin/src/views/feedback/FeedbackView.vue:474,484` | 「无 Agent（飞书）」矩阵行下钻时 null 被折叠成 undefined，实际返回全部 Agent 的反馈 |
| BUG-6 | 中 | `agent-cli/src/session/session-runner.ts:406-414` | print 模式 `--if-running=cancel` 分支无条件 `resetRound`，把用户的 Ctrl+C 取消旗标清掉，被取消的消息照样发出 |
| BUG-7 | 低（可达性受限） | `backend-ts/src/harness/core/harness-service.ts:785-796` | agent 级 compaction 覆盖的 `contextWindowTokens` / `maxSummaryTokens` 缺越界兜底，0/负数/NaN 放行 → token 压缩静默关闭 |
| BUG-8 | 低-中 | `backend-ts/src/weixin/webhook-fallback.service.ts:85,90` | 微信降级推送（送不出去时唯一可见渠道）截断同样按码元硬切，同族漏网点 |

---

## BUG-1（高）createAgent 先清默认旗标再校验默认模型，校验失败即全库零默认 Agent

**文件与位置**：`backend-ts/src/agent/agent.service.ts:97-100`（`clearDefaultFlag` 实现在 `agent.repository.ts:189-191`，无事务）

```ts
    if (isDefault != null && isDefault === 1) {
      await this.agentRepo.clearDefaultFlag();     // 97-99：独立 UPDATE，自动提交
    }
    await this.requireEnabledModel(defaultModelId); // 100：模型缺失/停用 → 抛 PARAM_INVALID
```

**根因**：两步顺序颠倒且不在同一事务。`clearDefaultFlag` 是 `UPDATE agent SET is_default = 0 WHERE is_default = 1 AND deleted = 0`（独立语句、自动提交）；随后 `requireEnabledModel`（`:260-267`）在 `model == null || model.status !== 1` 时抛 `PARAM_INVALID`。新 Agent 尚未 insert，旧默认的旗标却已被清掉 → **全库零默认 Agent**。

**生产接线**：`create-app.ts:435` `new AgentService(agentRepo, experienceService, suggestedQuestionService, modelRepo, …)`，第 4 个参数就是 `modelLookup`，`requireEnabledModel` 真实查 `llm_model` 表。模型被停用/删除后，管理员「新建一个默认 Agent 来顶替」的补救操作本身会失败。

**触发输入**：库里已有默认 Agent（A），管理员创建 Agent B 并勾选「设为默认」，B 的 `defaultModelId` 指向不存在或已停用的模型。

**后果**：创建请求报「默认模型不存在或未启用」（用户以为只是没建成），但默认旗标已被清。此后 `requireDefaultAgent()`（`agent.service.ts:67-73`）对**所有**会话创建抛「未配置默认 Agent，请先在管理后台设置」——平台所有新会话创建中断，且表面上与本次失败操作无关，极难定位；只能人工改库恢复。

**验证输出**（普通 `it` 实跑，`agent/zz-bugverify-default-flag.spec.ts`；状态化假仓库，`clearDefaultFlag` 模拟已提交的 UPDATE）：

```
× isDefault=1 + 默认模型缺失：抛错后旧默认 Agent 必须仍是默认（当前失败=bug）
  → expected +0 to be 1 // Object.is equality
```

**反证**：对照组「isDefault=0 同样抛错且不动旗标」通过（既有用例 `createRejectsMissingOrDisabledModel` 只覆盖 isDefault=0，因此该交互此前无覆盖）；对照组「模型可用时正常交换」通过（created.isDefault=1、旧行 isDefault=0、全库恰 1 个默认）——证明缺陷精确锁定在「isDefault=1 + 校验失败」这一格。

**修复方向**：把 `requireEnabledModel(defaultModelId)` 提到 `clearDefaultFlag()` 之前（最小改动）；或把「清旗标 + insert」包进同一事务。

**复核（2026-11-24）**：存在性确认——`clearDefaultFlag`（97-99）先于 `requireEnabledModel`（100），`requireEnabledModel`（`:260-267`）在 `modelLookup` 非空且模型缺失/停用时抛 `PARAM_INVALID`，生产 wiring（`create-app.ts:435` 第 4 参 = `modelRepo`）使该校验真实生效。补充发现：`updateAgent`（`:182` 校验 → `:201` 清旗标）顺序是正确的，**缺陷仅存在于 createAgent 一条路径**，修复面比初判更小；`agent.service.spec.ts:208` 的 `serviceWithLookup` 说明测试侧早有 modelLookup 注入范式。价值判断：保留——全库零默认 Agent 会中断所有会话创建且表象与本次操作无关，属最高优先。

---

## BUG-2（中）dingtalk 回复截断按 UTF-16 码元硬切，边界 emoji 产出孤立代理

**文件与位置**：`backend-ts/src/dingtalk/send.service.ts:23-36`

```ts
export function limitReply(text: string, maxLength: number): { text: string; truncated: boolean } {
  const limit = Math.max(1, maxLength);
  if (text.length <= limit) return { text, truncated: false };
  const suffix = '…（回复过长已截断）';
  const room = Math.max(0, limit - suffix.length);
  return { text: `${text.slice(0, room)}${suffix}`, truncated: true };  // 码元硬切
}
export function markdownMessage(text, maxLength) {
  const limited = limitReply(text, maxLength).text;
  const first = limited.split(/\r?\n/, 1)[0]?.trim() || 'Mao';
  const title = first.length > 40 ? `${first.slice(0, 40)}…` : first;   // 码元硬切
```

**根因**：`String.prototype.slice` 按 UTF-16 码元计数。切点落在代理对中间（高位代理被保留、低位代理被切掉）时留下孤立代理，进入 `msgParam` JSON 后在对端渲染为 U+FFFD 乱码，极端情况下被下游拒收。

**可达性**：`dingtalk/runtime.ts:172-175` `sendText → sendDingtalkMarkdown(…, text, deps.config.replyMaxLength)`，`replyMaxLength` 默认 2000（`config/app-config.ts:222`）。即所有超长钉钉回复都走这两行。

**同族背景**：2026-11-22 第五轮已用 `common/utf8.ts` 的 `clipByCodePoints` 修过 6 处同类点（card-progress-listener 4 处 + dingtalk/card-body + progress-card），本文件的回复截断路径漏网——`limitReply` 与 `markdownMessage` 两处（`text.slice` 与 `first.slice`）。

**验证输出**（普通 `it` 实跑，`dingtalk/zz-bugverify-surrogate.spec.ts`；输入 `'a'.repeat(39) + '🎉' + 'x'.repeat(200)`，`limitReply(text, 50)` 的 room=40，切点正好落在 🎉 的代理对中间）：

```
× limitReply 截断点落在 emoji 中间时不得留下孤立代理（当前失败=bug）
  → expected { index: 39, code: 'd83c' } to be null
× markdownMessage 的 title/text 不得含孤立代理（当前失败=bug）
  → expected { index: 39, code: 'd83c' } to be null
```

**反证**：对照组「同库 `clipByCodePoints(text, 40)` 无孤立代理」通过——修复手段现成、无需新造轮子；对照组「无 emoji 的截断行为不变（truncated=true、后缀照常）」通过——排除「为了修 bug 会改坏正常截断」的顾虑。

**修复方向**：`text.slice(0, room)` → `clipByCodePoints(text, room)`，`first.slice(0, 40)` → `clipByCodePoints(first, 40)`。

**复核（2026-11-24）**：存在性确认——`send.service.ts:29` 与 `:35` 两处码元硬切原样在；可达性链路复核成立（`runtime.ts:166-175` `sendText → sendDingtalkMarkdown(…, deps.config.replyMaxLength)`，默认 2000，`app-config.ts:222`）；同库 `common/utf8.ts:25` 的 `clipByCodePoints` 现成。价值判断：保留——与第五轮 6 处同族修复同一手法，两行改动收口一个渲染乱码面。

---

## BUG-3（中）无进展守护漏归一化 `create_scheduled_task` / `create_signal_watcher` 的随机 id，streak 永远累加不起来

**文件与位置**：`backend-ts/src/harness/core/no-progress-notice.ts:55-64`（`VOLATILE_RESULT_KEYS`）、`:273-301`（`normalizeResult`）；受害方 `no-progress-guard.ts:79-85`（streak 重置）

```ts
const VOLATILE_RESULT_KEYS = new Set<string>([
  'execution_id', 'request_id', 'trace_id', 'timestamp', 'duration_ms', 'elapsed_ms', 'created_at', 'updated_at',
]);   // ← task_id / watcher_id 不在表内，也没有这两个工具的按工具归一化分支
```

**根因**：结果归一化只有两条按工具白名单分支——`send_image|send_file` 与 `shell`；其余工具走上面这张 8 字段黑名单。而 `create_scheduled_task` 返回 `task_id: task.id`（`tool/impl/scheduled-task-tools.ts:104-105`）、`create_signal_watcher` 返回 `watcher_id: watcher.id`（`tool/impl/signal-watcher-tools.ts:187-189`），都是每次调用全新的 id，既不在黑名单、也无按工具分支 → 模型以相同参数重复创建时每轮签名都不同 → `endRound` 走 else 分支把 `currentStreak` 重置为 1（`no-progress-guard.ts:79-85`）→ 第 5/10 轮 nudge 与第 15 轮 abort（`NO_PROGRESS_NUDGE_AT` / `NO_PROGRESS_ABORT_AT`）**永不触发**。

**这正是 AGENTS.md 明文禁止的形态**：「工具结果含随机 id / 图片附件 / 传输字段时，还必须同步 `no-progress-notice.ts` 的按工具归一化与 `VOLATILE_RESULT_KEYS`（漏补→漏报）」。同文件 52 行注释也要求「新增工具若结果带随机 id，必须逐项确认，优先改用按工具归一化」。`tool-result-summarizer.ts:183-185` 这两个工具的摘要 case 是齐的——三处同步里恰好只漏了 no-progress 这一处。

**触发路径**：模型陷入退化循环，连续多轮以相同参数调 `create_scheduled_task` / `create_signal_watcher`（反复创建同名定时任务/哨兵）。历史回放路径（`scanNoProgressNotices` → `buildRoundCalls` → `normalizeResult`）与运行时同口径，因此重启后重载历史也修不回 streak。

**验证输出**（普通 `it` 实跑，`harness/core/zz-bugverify-noprogress-taskid.spec.ts`；15 轮同参数调用、每轮只换 id）：

```
× create_scheduled_task 仅 task_id 不同的重复调用必须累加 streak（当前失败=bug）
  → expected 1 to be 15 // Object.is equality
× create_signal_watcher 仅 watcher_id 不同的重复调用必须累加 streak（当前失败=bug）
  → expected 1 to be 15 // Object.is equality
× 运行时 guard 同参数重复创建必须在第 15 轮 abort（当前失败=bug）
  → expected false to be true // Object.is equality
```

**反证**：对照组「已按工具归一化的 `send_file`（随机 url 不同）能正常累加到 5」通过——同文件内既有工具的归一化是工作的；对照组「结果确实有语义变化时 streak 必须重置为 1」通过——不是无脑累加；机制直证用例「`resultDigest` 对两个仅 `task_id` 不同的结果给出不同摘要」通过（断言它们不同，即当前漏报机制）。

**修复方向**：优先按文件注释的指引做按工具归一化——为 `create_scheduled_task` / `create_signal_watcher` 各加一条白名单分支（如取 `success/name/cron_expression/interval_minutes/status` 等语义字段，剔除 id）；`task_id` 不进全局黑名单（spawn/check 系工具靠它做语义身份，误删会误杀）。

**复核（2026-11-24）**：存在性确认——`VOLATILE_RESULT_KEYS`（`:55-64`）仍无 `task_id`/`watcher_id`，`normalizeResult`（`:273-301`）仍只有 `send_image|send_file` 与 `shell` 两条按工具分支；`scheduled-task-tools.ts:105` 返回 `task_id: task.id`、`signal-watcher-tools.ts:189` 返回 `watcher_id: watcher.id`（均为自增 id，每次调用必不同）；`tool-result-summarizer.ts:173,183` 两个工具的摘要 case 齐全——AGENTS.md 要求的三处同步确实只漏 no-progress 一处。价值判断：保留——这是 AGENTS.md 明文禁止的形态，且漏报方向是「止损机制对一类退化循环永不触发」；修复是加两条白名单分支，不触碰全局黑名单。

---

## BUG-4（中）取消选择不清 el-table 内部选区，再勾选复活已取消的行，批量忽略误删不可逆

**文件与位置**：`admin/src/views/feedback/FeedbackView.vue:503-506`（配合 `:115` 声明后从未使用的 `ref="tableRef"`）

```ts
function clearSelection() {
  selectedRows.value = []
  selectedIds.value = []
}
```

**根因**：只清组件自己的两个 ref，从不清 el-table 的内部选区。`ref="tableRef"` 在模板里声明了（`:115`），但全文件再无第二处引用（grep 仅 1 次命中），从未调用 `tableRef.clearSelection()`。element-plus 的选区以 store 为权威（`store.isSelected(row)` 驱动复选框勾显），组件 refs 与 store 因此分叉。

**触发步骤**：勾选两条 → 点「取消选择」（批量条收起，但 el-table 内部仍勾着这两条）→ 再点某一条的复选框 → el-table 把该行从内部选区**移除**并回发其余行 → `selection-change` 复活「已取消」的行 → 批量条显示「已选 1 条」，内容却是用户刚取消的那条。

**后果**：用户点「忽略」后 `api.post('/feedback/admin/dismiss', { feedbackIds: [...] })` 提交的是**已取消**的反馈 id；忽略不可恢复（界面文案亦明示「忽略后不可恢复」）。表单搜索/重置路径（`handleSearch` / `handleReset` / `applyMatrixFilter` / `handleMatrixRow`）同样调 `clearSelection()`，同一残留会跨筛选条件串味。

**验证输出**（普通 `it` 实跑，`admin/src/views/feedback/zz-bugverify-feedback.spec.ts`；vitest + `@vue/test-utils@2`（`--no-save`）+ 真实 element-plus + happy-dom，勾选 101/102 → 取消选择 → 只勾 101 → 点忽略）：

```
× 取消选择后再勾选一行，批量忽略必须只提交该行（当前失败=bug）
AssertionError: expected { feedbackIds: [ 102 ] } to deeply equal { feedbackIds: [ 101 ] }
```

**反证**：对照组「未走过取消选择时连续勾选两行，批量忽略提交 `[101, 103]`」通过——组件、接口、el-table 勾选链路本身完全正常，缺陷精确锁定在「取消选择后再勾选」这一格。

**修复方向**：`clearSelection()` 内补 `tableRef.value?.clearSelection()`（el-table 实例方法）。

**复核（2026-11-24）**：存在性确认——`clearSelection`（`:503-506`）仍只清两个本地 ref；`tableRef` 全文件仅 `:115` 一次声明、零处使用；`clearSelection` 的 6 个调用点（搜索/重置/矩阵筛选/矩阵整行/单条忽略后/批量忽略后）都会残留同一份内部选区。价值判断：保留——后果是「忽略后不可恢复」的批量误删，一行修复。

---

## BUG-5（中）「无 Agent（飞书）」矩阵行下钻把 null 折叠成 undefined，实际返回全部 Agent 的反馈

**文件与位置**：`admin/src/views/feedback/FeedbackView.vue:474`（`applyMatrixFilter`）与 `:484`（`handleMatrixRow`），配合 `:397` 的 `buildParams`

```ts
filters.agentId = agentId ?? undefined;          // 474 / 484：null → undefined
...
if (filters.agentId != null) params.agentId = filters.agentId;   // 397：undefined 整体省略
```

**根因**：模板 `:31-32` 会渲染 `row.agentId == null` 的「无 Agent（飞书）」行且可点击；点击后 `agentId` 的 null 语义在两道折叠后彻底丢失，发出的列表请求与「不筛选 Agent」**完全同形**。后端 `feedback.repository.ts:224-228` 其实支持三态（`agentId === null` → `f.agent_id IS NULL`，注释写明「飞书点踩无 Agent」），但 `feedback.routes.ts:50-59` 的 `parseAgentId` 对 `null`/`''`/0/负数一律拒绝或忽略（`:126` `agentId: parseAgentId(query.agentId)`），前端又没有任何「空 Agent」标记参数 → **该筛选能力在 API 层不可达**。

**后果**：用户点「无 Agent（飞书）」（提示文案是「点击单元格筛选该 Agent 的待处理反馈」）后，明细混入全部 Agent 的待处理反馈；随后的批量忽略会把没打算处理的反馈一并不可逆忽略。客服/运营按飞书渠道汇总排查时会得到错误分母。

**验证输出**（普通 `it` 实跑，同上文件；服务端按「正确」语义响应——带显式空 Agent 标记才返回无 Agent 子集）：

```
× 点「无 Agent（飞书）」单元格后列表请求必须能表达空 Agent 约束（当前失败=bug）
  → expected false to be true // Object.is equality
× 点「无 Agent（飞书）」后列表必须只剩无 Agent 行（当前失败=bug：混入其它 Agent）
  → expected [ DOMWrapper{ …(3) }, …(2) ] to have a length of 1 but got 3
```

**反证**：对照组「点普通 Agent 单元格后按该 Agent 过滤（params.agentId=7、明细 2 行）」通过——矩阵下钻对非空 agentId 完全正常，缺陷只在 null 这一格。

**修复方向**：前后端同时补一个可区分的空 Agent 约束（如 `agentIdNull=true`）：`buildParams` 在该标记为真时下发，`parseAgentId` 认得它并传 `null` 给 repository 已有的 `IS NULL` 分支；或退一步不渲染 null 行的下钻入口（但会丢掉飞书渠道的排查能力）。

**复核（2026-11-24）**：存在性确认——`:474`/`:484` 的 `agentId ?? undefined` 与 `:397` 的 `!= null` 省略原样在；模板 `:31-34` 确实渲染可点的「无 Agent（飞书）」行；后端 `feedback.repository.ts:224-228` 三态（`IS NULL`）现成但 `feedback.routes.ts:50-59` 的 `parseAgentId` 拒绝 null，前端又无空 Agent 标记参数 → API 层不可达。价值判断：保留，但**修正成本定位**——这是 8 个确认项里唯一需要前后端协同（routes + buildParams + 列表请求）的修复，不是「同分支漏抄一格」的一行改动；若不想动契约，可降级为「不渲染 null 行下钻入口」的前端单侧修复（丢飞书排查能力，需产品确认）。与 BUG-4 叠加时后果最重（误删不可逆），建议与 BUG-4 同一 PR 修掉。

---

## BUG-6（中）print 模式 `--if-running=cancel` 分支无条件 resetRound，把用户的 Ctrl+C 取消旗标清掉

**文件与位置**：`agent-cli/src/session/session-runner.ts:406-425`（`handleAlreadyActive`）

```ts
      if (this.opts.ifRunning === 'cancel') {
        await this.sendCancel();
        await this.waitUntilSettled(CANCEL_WAIT_MS);
        this.resetRound();          // 414：无条件——把 cancelledByUserFlag 清成 false
        return;
      }
      await this.waitOccupantWithOptionalTimeout();
      if (!this.timedOutFlag && !this.cancelledByUserFlag) {   // 紧邻的 wait 分支有守卫
        this.resetRound();
      }
```

**根因**：`resetRound()`（`:338-354`）第 350 行把 `cancelledByUserFlag = false`。于是 `runPrompt:160` 的 `if (this.cancelledByUserFlag || this.timedOutFlag) return this.buildResult();` 被绕过，流程落到 `:167` 的重试循环 → `sendMessage` 把用户 Ctrl+C 掉的那条消息原样发给服务端。`cancel()`（`:231-234`）由 `chat.ts:226-228` 的 SIGINT 处理器在 print 模式调用（print 模式下 Ctrl+C 不退出进程，只置旗标）。

**触发步骤**：会话已被其它客户端占用 → `mao-agent -p "…" --if-running=cancel` → CLI 向占用者发 cancel 并在 `waitUntilSettled(5000)` 里等其终态 → 用户在此期间按 Ctrl+C → 占用者落终态 → `resetRound` 清旗标 → 消息照发。

**后果**：用户明确取消的输入仍然执行（可能触发写操作/长任务），且 CLI 侧表现为「取消了却还在跑」。同一函数内 wait 分支有守卫、cancel 分支没有，属漏加而非设计。

**验证输出**（普通 `it` 实跑，`agent-cli/test/zz-bugverify-cancel-flag.spec.ts`；FakeWs 驱动，快照 phase=RUNNING/executionId=occ-1，等 cancel 帧发出后调 `runner.cancel()` 再补发占用者终态）：

```
× 取消占用者后用户又按 Ctrl+C：本轮必须结束且不得再发送消息（当前失败=bug）
  → expected [ { type: 'send_message', …(2) } ] to have a length of +0 but got 1
```

**反证**：对照组「无 Ctrl+C 时按既定语义发取消并继续执行自己的消息（1 条 send_message、终态 COMPLETED）」通过；对照组「wait 分支同一时序有守卫，Ctrl+C 后 0 条 send_message」通过——证明对称兜底是既定口径，cancel 分支只是漏抄。

**修复方向**：cancel 分支的 `resetRound()` 加上与 wait 分支相同的守卫：`if (!this.timedOutFlag && !this.cancelledByUserFlag) this.resetRound();`。

**复核（2026-11-24）**：存在性确认——`session-runner.ts:411-415` cancel 分支无条件 `resetRound()`（`:350` 清 `cancelledByUserFlag`）与 `:417-420` wait 分支的守卫原样在；SIGINT 链路复核成立（`commands/chat.ts:226-233` print 模式 `process.on('SIGINT', onSig)` → `runner.cancel()`）。补充时序事实：`CANCEL_WAIT_MS = 5000` 与 chat.ts 里 Ctrl+C 后的 `setTimeout(… process.exit(EXIT.CANCELLED), 5000)` 同长——占用方若在 5 秒内落终态，`resetRound` 清旗标后消息会经 `runPrompt:167-171` 重试循环照发，之后进程才退出；窗口窄但后果（用户已取消的输入照样执行）不可接受。价值判断：保留——与同函数 wait 分支严格对称的一行守卫，属漏抄而非设计。

---

## BUG-7（低，可达性受限）agent 级 compaction 覆盖缺 `contextWindowTokens` / `maxSummaryTokens` 越界兜底

**文件与位置**：`backend-ts/src/harness/core/harness-service.ts:785-796`（`resolveCompactionConfig`）

```ts
      if (compactionNode.contextWindowTokens != null) merged.contextWindowTokens = Number(compactionNode.contextWindowTokens);   // 786：直接信任
      ...
      if (compactionNode.maxSummaryTokens != null) merged.maxSummaryTokens = Number(compactionNode.maxSummaryTokens);           // 790：直接信任
      // agent 级覆盖没有后台表单校验：triggerRatio=0 会让「tokens >= floor(window×0)」恒成立，…
      if (!(merged.triggerRatio > 0 && merged.triggerRatio <= 1)) merged.triggerRatio = this.compactionConfig.triggerRatio;     // 793：有兜底
      if (!Number.isFinite(merged.triggerPayloadBytes) || merged.triggerPayloadBytes < 0) {                                     // 795：有兜底
```

**根因**：紧邻两行专门为 `triggerRatio=0`（恒成立）与 `triggerPayloadBytes` 非法写了「退回全局默认」的兜底，注释还写明原因「agent 级覆盖没有后台表单校验」；但 `contextWindowTokens` / `maxSummaryTokens` 两行直接 `Number(...)` 信任外部值，0 / 负数 / 非数字串（NaN）全部放行——同一类缺口只堵了一半。

**后果**（两条独立通路）：
1. `CompactionConfig.resolveEffectiveContextWindow`（`compaction-config.ts:21-26`）只保护 `modelConfig.contextWindowTokens > 0`，`config.contextWindowTokens` 原样返回 → 进 `shouldTrigger` 的 `triggerWindowTokens > 0` 门（`compaction-config.ts:56-57`）恒 false → **token 维度自动压缩被静默关闭**，只剩 40MiB 体积触发兜底；上下文超出模型真实上限后开始 400 失败。
2. `maxSummaryTokens` 为 NaN 时原样写进 handoff 指令（`compaction-service.ts:391-403`）——「正文控制在约 NaN tokens 以内」。

**可达性说明（定中而非高）**：全局设置侧有校验（`settings/settings.service.ts:547-549` 的 `optPositiveInt`/`optRatio`），缺口精确只在 agent 级覆盖路径；admin 无 agent 级 compaction 表单项，需 API/种子/直改 DB 注入 `configJson.compaction.*`。

**验证输出**（普通 `it` 实跑，`harness/core/zz-bugverify-compaction-window.spec.ts`）：

```
× contextWindowTokens=0 必须退回全局默认（当前失败=bug：返回 0）
  → expected +0 to be 256000 // Object.is equality
× contextWindowTokens 为负数必须退回全局默认（当前失败=bug）
  → expected -1 to be 256000 // Object.is equality
× contextWindowTokens 为非数字串（NaN）必须退回全局默认（当前失败=bug）
  → expected false to be true // Object.is equality
× contextWindowTokens=0 会让 token 维度压缩彻底失效（当前失败=bug：应仍能触发）
  → expected 0 to be greater than 0
× maxSummaryTokens 为 NaN 必须退回全局默认（当前失败=bug：NaN 进 handoff 指令）
  → expected false to be true // Object.is equality
```

**反证**：对照组「合法覆盖值今天已被尊重（128000 / 4000）」通过——解析函数本身在工作；对照组「`triggerRatio=0` 已有兜底」通过——证明同函数内对称兜底就是既定口径，缺的两行只是漏抄。

**修复方向**：把 793-796 的兜底模式复制到两行：`if (!(merged.contextWindowTokens > 0)) merged.contextWindowTokens = this.compactionConfig.contextWindowTokens;`（`Number.isFinite` + `> 0` 一并覆盖 NaN/负数），`maxSummaryTokens` 同理。

**复核（2026-11-24）**：存在性确认——`:786`/`:789` 直接 `Number(...)` 信任外部值、`:793-796` 两条兜底原样在；下游链路复核成立：`compaction-config.ts:21-26` 的 `resolveEffectiveContextWindow` 只保护 `modelConfig` 侧、`config` 侧原样返回，`:56-57` 的 `triggerWindowTokens > 0` 门使其恒 false；`compaction-service.ts:403` 把 `maxSummaryTokens` 原样插值进 handoff 指令（NaN → 「约 NaN tokens」）；全局设置侧确有校验（`settings.service.ts:547-548` 的 `optPositiveInt`/`optRatio`），缺口精确只在 agent 级覆盖。价值判断：**保留但定级下调为低**——admin 无 agent 级 compaction 表单项，只能经 API/种子/直改 DB 注入 `configJson.compaction.*`，当前不可经 UI 触发；属「同函数内对称兜底漏抄两行」的防御性补齐，两行改动、零行为风险，适合随其它修复顺手带上，不值得单独立项。

---

## BUG-8（低-中）微信 webhook 降级推送截断同样按码元硬切（同族漏网第二点）

**文件与位置**：`backend-ts/src/weixin/webhook-fallback.service.ts:85` 与 `:90`

```ts
    const body = text.length > MAX_FALLBACK_TEXT_CHARS
      ? `${text.slice(0, MAX_FALLBACK_TEXT_CHARS)}\n\n（内容过长已截断，完整内容请在 Mao 桌面端/网页端查看）`
      : text;
    const cardBody = text.length > MAX_FALLBACK_CARD_CHARS
      ? `${text.slice(0, MAX_FALLBACK_CARD_CHARS)}\n\n（内容过长已截断，完整内容请在 Mao 桌面端/网页端查看）`
      : text;
```

**根因**：`MAX_FALLBACK_TEXT_CHARS=4000` / `MAX_FALLBACK_CARD_CHARS=3000` 语义是「字符数」，`slice` 按码元计数，切点落在代理对中间即留孤立代理，随 payload 发往钉钉/飞书 webhook，对端渲染 U+FFFD（极端情况拒收）。与 BUG-2 同族，是第五轮收口时漏掉的第二点。

**场景权重**：本文件是「微信回复发不出去时的唯一可见渠道」（ilink 拒收：消息体过大 / 24h 窗口过期 / 网络异常），出问题时用户看不到内容的唯一补救路径也损坏。

**验证输出**（普通 `it` 实跑，`weixin/zz-bugverify-fallback-surrogate.spec.ts`；输入 `报告标题\n` + 2000 个 🎉，让 4000/3000 码元切点落在代理对中间）：

```
× 推送正文切在 emoji 中间时不得留下孤立代理（当前失败=bug）
  → expected { index: 4013, code: 'd83c' } to be null
× 飞书卡片正文切在 emoji 中间时不得留下孤立代理（当前失败=bug）
  → expected [ '报告标题\n🎉🎉🎉…' ] to have a length of +0 but got 1
```

**反证**：对照组「同库 `clipByCodePoints` 对同样输入无孤立代理」通过；对照组「纯 ASCII 超长文本截断行为不变（截断文案照常追加）」通过。

**修复方向**：两处 `text.slice(0, N)` → `clipByCodePoints(text, N)`。

**复核（2026-11-24）**：存在性确认——`:85`/`:90` 两处码元硬切与 `MAX_FALLBACK_TEXT_CHARS=4000` / `MAX_FALLBACK_CARD_CHARS=3000` 原样在。价值判断：保留——本文件是微信回复送不出去时唯一可见渠道，与 BUG-2 同族同手法，一次收口。

---

## 候选未确认（机制成立，缺离线实锤条件，留档不下结论）

> 2026-11-24 复核：原 6 项移除 1 项（长连接退避重置，见下方「复核移除记录」），余 5 项代码事实逐条重读全部属实；第 1 项的跨会话误清场景已可按代码推演证实（见该项「复核」）。

1. **desktop phase watcher 自动挂的等待回调缺会话守卫，会误清其它会话的 sending / startedAt**（`desktop/src/composables/useChat.ts:886-896`）。`pendingCallbacks` 按帧 sessionId 结算（`useStreamWS.ts:993-997`），而 `.then()` 里直接改全局单例 `sending`/`startedAt`；同文件 `runRestoreSession`（`:1050-1062`）对相同形态的回调写了 `sessionId.value !== sessionIdVal` 守卫，说明作者意识到该风险。**未确认点**：需 pinia + WS 帧级组件测试 harness（desktop 无组件测试基建），离线复现成本高；代码事实本身高置信。**复核**：代码事实确认（`:889-896` 无守卫 vs `:1052`/`:1058` 有守卫）；切换会话时 `runRestoreSession:997-999` 只 `unsubscribe` 旧会话、不清 `pendingCallbacks` 旧条目，而后端流式事件不按 subscribe 过滤（同文件 `:1031` 注释），因此「A 在跑 → 切到同样在跑的 B → A 的终态帧解析 A 的陈旧回调 → 清掉 B 的 sending」这条链路在代码上闭合，只剩组件级 harness 缺失无法落离线实锤。修复 = 把 `:1052` 的守卫抄到 `:889`。
2. **飞书/钉钉入站去重表重认领 FAILED 行时 `updated_at` 不刷新**（`dingtalk/message.repository.ts:60-69`、`feishu/message.repository.ts:156-163`）。`ON DUPLICATE KEY UPDATE` 多赋值从左到右求值：第一个赋值把 `status` 改成 `CLAIMED` 后，第二个赋值的条件读到的已是新值，走 `updated_at = updated_at` 自赋值；而两表 `updated_at` 都是 `ON UPDATE CURRENT_TIMESTAMP`，显式自赋值抑制自动刷新 → 「CLAIMED 超 10 分钟才允许重取」的窗口按旧失败时刻起算。**未确认点**：需 MySQL 集成测试（本仓 E2E 库）才能实锤求值顺序；反证是 `weixin/inbound-message.repository.ts:146` 显式写了 `updated_at = CURRENT_TIMESTAMP`，同语义三缺二。**复核**：两处 SQL 原样在，求值顺序与自赋值抑制均为 MySQL 文档化行为，机制成立；修复方向已可确定——**对调两个赋值顺序**（先 `updated_at` 后 `status`）：复核四种行状态（FAILED 新失败 / CLAIMED 超窗 / CLAIMED 未超窗 / DONE）在新顺序下条件判断与 affectedRows（0/1/2）语义均保持正确，且 `updated_at` 赋值时 `status` 仍是旧值。补一次 MySQL 集成测试即可转确认。
3. **后台任务结果归一化末尾兜底可切出非法 JSON**（`harness/core/background-task-manager.ts:189-201`）。转义感知收敛循环 `budget <= 0` break 时，`payload.output` 已被砍成 `'... [truncated]'`；若非 output 字段合计仍超 `MAX_RESULT_LENGTH`，末尾 `text.slice(0, MAX_RESULT_LENGTH)` 会在序列化字符串中间下手，破坏同段注释「保证结果恒为合法 JSON」的承诺。**未确认点**：需构造非 output 字段体积超限的 executor 结果夹具；halving 循环本身正确，可达性偏低。**复核**：代码原样在，契约违背成立；严重度低（executor 结果通常只有 output 会超限），保留观察。
4. **terminal-host 可用性状态机在窄窗口返回误导性状态**（`harness/terminal/terminal-host-handler.ts:318-330`）。活跃主机 socket 已死但 `afterConnectionClosed` 未执行、宽限未起时，`getStatus` 返回 `unsupported`/`upgrade-cli`，用户看到「请升级桌面客户端」而非「执行端设备离线」。**未确认点**：依赖 readyState 未翻转的时序，需 socket 级时序 harness。**复核**：代码原样在（`active.socket.readyState !== OPEN` 即落到客户端类型分支）；窗口窄、后果是文案误导而非功能错误，修复（死 socket 先于类型判断返回离线态）本身无风险，保留低优先。
5. **系统通知「已弹过」集合在开关门禁之前写入，被偏好抑制的通知永久丢失**（`desktop/src/composables/useInboxSystemNotify.ts:153-159`）。`notifiedIds.add` 在 `systemNotifyEnabled` 门禁与 kind 级门禁之前执行，关闭通知期间到达的条目被永久标记，重开开关后不再弹。**未确认点**：需 Electron 通知 + 定时轮询 harness；机制本身高置信、严重度低。**复核**：代码原样在（先 `for (const item of unseen) notifiedIds.add(...)`，后过 `systemNotifyEnabled` 与 kind 门禁）；注意修复不能简单把 add 挪到门禁后——那会让重开开关时积压条目轰炸，需配合「只补最近 N 条」之类的限流，故不列为低成本修复。

---

## 复核移除记录（2026-11-24 复核轮移除，防重复排查）

- **飞书/钉钉长连接退避超过 `maxConsecutiveFailures` 时重置为 1，`reconnectMaxMs` 永不可达**（`feishu/monitor.service.ts:283-291`、`dingtalk/monitor.service.ts:249-254`）。代码事实属实（默认 base=1s / max=30s / maxFail=5 下延迟序列 1,2,4,8,16 后归零重来），但**修复价值不成立**：「达上限后重置」是有意设计的循环重启而非缺陷的可能性高（长时间退避后客户端早已被判死亡，周期性主动重建长连接是常见做法），且改成「永不到顶」会让瞬时故障后的恢复变慢、与飞书/钉钉 SDK 自身重连策略叠加。若要改，应先向作者确认意图，不作为 bug 跟踪。

---

## 误报记录（审计代理候选经核实排除，防重复排查）

- **desktop `sendMessage` 执行后处理写「活跃会话」而非「本次发送的会话」**（`useChat.ts:610-616`，与同文件 `:683-690`、`:830-837` 两处显式文档化的不变量矛盾）。核实结论：**当前不可达，排除**。`sendMessage` 只被 `sendMessageWithQueue` 的非活跃分支调用（`:911`），而 `sendMessageWithQueue` 只被 `ChatPanel.handleSend` 在 `isActive.value` 为真时调用（`ChatPanel.vue:817-818`），两行之间无 await、`isActive` 不可能翻转；`ChatPanel.vue` 也未解构 `sendMessage`。属潜在缺陷而非可触发缺陷，一旦有人调整 `handleSend` 的 `isActive` 判断会立刻变成用户可见 bug。**复核（2026-11-24）**：排除结论仍成立，且不可达性更强——`handleSend` 的非活跃路径现已改走 `sendMessageAndWaitForSave`（`ChatPanel.vue:830-831`），`useChat.sendMessage` 仅存的入口就是 `sendMessageWithQueue` 那个永不为假的分支；仍属潜在缺陷，保持排除。
- **方法学教训 1（孤立代理检测）**：本轮 BUG-8 的卡片断言最初对 `JSON.stringify(card)` 做检测，结果**假通过**——ES2019 起 `JSON.stringify` 会把孤立代理转义成 `\udXXX` 字面量，序列化结果里反而检测不到。必须遍历序列化**前**的原始字符串。这与第五轮「Buffer.length vs string.length」的教训同族：多字节文本审查要先确认检测面。
- **方法学教训 2（element-plus 复选框驱动）**：表格选择列的勾选必须驱动原生 `input` 的 `change` 事件；点 `.el-checkbox` 根节点无效——element-plus 把根节点的 `onClick` 门禁在 `isLabeledByFormItem`（`use-checkbox-event.mjs:28`），表格里不成立。最初用 `trigger('click')` 导致选择完全不生效，一度误以为组件不可驱动。

---

## 验证用例落点（已全部转正为回归用例）

| 文件 | 用例 | 状态 |
|---|---|---|
| `backend-ts/src/agent/zz-bugverify-default-flag.spec.ts` | BUG-1 主证 1 例 + 对照组 2 例（isDefault=0 路径、正常交换） | 主证转正为普通 it |
| `backend-ts/src/dingtalk/zz-bugverify-surrogate.spec.ts` | BUG-2 主证 2 例（limitReply / markdownMessage）+ 对照组 2 例 | 主证转正为普通 it |
| `backend-ts/src/harness/core/zz-bugverify-noprogress-taskid.spec.ts` | BUG-3 主证 3 例（scheduled task / signal watcher / 运行时 guard）+ 对照组 3 例 | 主证转正；原「机制直证」对照例反转为「修复直证」（仅 id 不同的结果摘要必须相同） |
| `backend-ts/src/harness/core/zz-bugverify-compaction-window.spec.ts` | BUG-7 主证 5 例（0/负数/NaN/压缩失效/NaN handoff）+ 对照组 2 例 | 主证转正为普通 it |
| `backend-ts/src/weixin/zz-bugverify-fallback-surrogate.spec.ts` | BUG-8 主证 2 例（text / card）+ 对照组 2 例 | 主证转正为普通 it |
| `agent-cli/test/zz-bugverify-cancel-flag.spec.ts` | BUG-6 主证 1 例 + 对照组 2 例（无 Ctrl+C 正常续跑、wait 分支守卫） | 主证转正为普通 it |
| `backend-ts/src/feedback/feedback.routes.spec.ts` | BUG-5 路由层三态 1 例（标记→null / 具体值优先 / 缺省→undefined） | 修复同轮新增 |
| （已移除，全文见附录 A）`admin/src/views/feedback/zz-bugverify-feedback.spec.ts` | BUG-5 主证 2 例（请求参数 / 展示后果）+ BUG-4 主证 1 例 + 对照组 2 例 | 实跑取证后移除（`@vue/test-utils@2` 不入 package.json）；BUG-4/5 已修复，如需组件级回归可从附录 A 贴回并转正 |

复现方式（改坏修复看真实失败）：把各文件里对应普通 `it` 临时改回断言失败即可 `npx vitest run <file>`。admin 用例需 `npm i --no-save @vue/test-utils@2`（不改 package.json，验证后卸载）。

**基线复核**：backend-ts 全量 6804 例（6777 通过 / 13 失败 = 本轮 13 个主证）、agent-cli 797 例（795 通过 / 1 失败 = 本轮主证）、admin 全量 234 例通过（移除 admin 临时用例后）——**除本轮新增锚点外，存量套件全绿**；`backend-ts` / `agent-cli` `npm run build` 均 0 错。

**锚点复跑（2026-11-24 复核轮）**：6 个 spec 文件原样 `npx vitest run`——backend-ts 5 个文件 24 例、agent-cli 1 个文件 3 例，全部通过（`it.fails` 主证仍按预期失败 + 对照组仍通过），即**全部锚点当前有效，无一被后续提交修掉或漂移**。

## 后续建议

- 8 个确认项已全部修复（见「修复记录」），本节仅保留仍未闭环的事项。
- 「候选未确认」5 项中，第 2 项（claim SQL `updated_at`）只需一次 MySQL 集成测试即可转确认，修复方向已定（对调两个赋值顺序，四种行状态语义复核无误），建议优先补实证；第 1 项（desktop watcher 守卫）修复是抄一行现成守卫（把 `runRestoreSession:1052` 的会话守卫抄到 watcher 回调 `:889`），可随桌面端改动顺手带上。
- 第 3/4/5 项（后台任务截断 / terminal-host 文案 / 系统通知已弹集合）均为低严重度，按需处理；第 5 项注意不能简单把 `notifiedIds.add` 挪到门禁后（重开开关会积压轰炸），需配合限流。

---

## 附录 A：admin 组件级验证用例全文（BUG-4 / BUG-5，实跑后已从仓库移除）

环境与复现：

```bash
cd admin
npm i --no-save @vue/test-utils@2     # 仅装依赖，不改 package.json
# 将下方用例保存为 admin/src/views/feedback/zz-bugverify-feedback.spec.ts
npx vitest run src/views/feedback/zz-bugverify-feedback.spec.ts
# 预期：3 个主证 expected fail（BUG-5 两条 + BUG-4 一条），2 个对照组通过
# 验证完成后：删除该 spec 并 npm uninstall --no-save @vue/test-utils@2
```

实跑输出（`it.fails` 固化后）：

```
 ✓ src/views/feedback/zz-bugverify-feedback.spec.ts (5 tests) 1928ms
     ✓ 点「无 Agent（飞书）」单元格后列表请求必须能表达空 Agent 约束（当前失败=bug）  473ms
     ✓ 点「无 Agent（飞书）」后列表必须只剩无 Agent 行（当前失败=bug：混入其它 Agent）  368ms
     ✓ 对照组：点普通 Agent 单元格后按该 Agent 过滤（既有行为正确）  368ms
     ✓ 取消选择后再勾选一行，批量忽略必须只提交该行（当前失败=bug）  359ms
     ✓ 对照组：未走过取消选择时连续勾选提交两行（既有行为正确）  358ms
 Test Files  1 passed (1)
      Tests  2 passed | 3 expected fail (5)
```

转回普通 `it` 后的真实失败输出见 BUG-4 / BUG-5 两节的「验证输出」。

```ts
/**
 * 临时验证用例（审查用，验证后删除；@vue/test-utils@2 以 --no-save 临时安装，验证后卸载）：
 *
 * Bug A（FeedbackView.vue:474 / :484 → :397）：
 *   矩阵「无 Agent（飞书）」行（row.agentId == null）点击后走
 *   `filters.agentId = agentId ?? undefined`（null 被折叠成 undefined），
 *   buildParams 的 `if (filters.agentId != null)` 再把它整体省略 → 列表请求与「不筛选」
 *   完全同形，点「无 Agent」下钻实际返回全部 Agent 的待处理反馈。
 *   后端 repository 支持 agent_id IS NULL，但 routes 的 parseAgentId 拒绝 null/0/负数，
 *   前端又没有任何「空 Agent」标记 → 该筛选能力在 API 层不可达。
 *   后果：用户以为在看飞书无 Agent 反馈，实际混入全部 Agent 的反馈；随后的批量忽略
 *   会把没打算处理的反馈一并不可逆忽略。
 *
 * Bug B（FeedbackView.vue:503-506）：
 *   clearSelection() 只清组件自己的 selectedRows/selectedIds，从不清 el-table 内部
 *   选区（ref="tableRef" 声明了却从未使用）。取消选择后 el-table 内部仍保留旧勾选，
 *   用户再点某一个复选框时，el-table 把该行从内部选区移除并回发其余行 →
 *   selection-change 复活「已取消」的行进批量忽略。
 *
 * 本用例断言「正确行为」，对当前代码均失败，即 bug 实锤；对照组证明组件本身可正常驱动。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, VueWrapper } from '@vue/test-utils'
import { createRouter, createMemoryHistory, type Router } from 'vue-router'
import ElementPlus from 'element-plus'
import { defineComponent, h } from 'vue'

/** 断言「正确行为」的用例：对当前代码实跑失败（即 bug 实锤），以 it.fails 固化为回归锚点。 */
const bugIt = it.fails

const apiGet = vi.fn()
const apiPost = vi.fn()
vi.mock('../../api', () => ({
  api: {
    get: (...args: unknown[]) => apiGet(...args),
    post: (...args: unknown[]) => apiPost(...args),
    put: vi.fn(), patch: vi.fn(), delete: vi.fn(),
  },
}))
vi.mock('../../stores/auth', () => ({
  useAuthStore: () => ({ hasPermission: () => true }),
}))
// 弹窗自动确认：把「点了忽略」直接推到 api.post，便于断言实际提交的 id 集合
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>()
  return {
    ...actual,
    ElMessage: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
    ElMessageBox: { confirm: vi.fn(async () => 'confirm') },
  }
})

import FeedbackView from './FeedbackView.vue'

const REASON_LABEL = '结果错误'

/** 汇总：两个待处理行——agentId=7 两条、agentId=null（飞书）一条 */
function summaryFixture() {
  return {
    total: 3,
    byReason: [{ reason: 'WRONG_RESULT', label: REASON_LABEL, count: 3 }],
    byDay: [],
    pendingCount: 3,
    pendingMatrix: [
      { agentId: 7, agentName: '客服助手', reason: 'WRONG_RESULT', reasonLabel: REASON_LABEL, count: 2 },
      { agentId: null, agentName: null, reason: 'WRONG_RESULT', reasonLabel: REASON_LABEL, count: 1 },
    ],
  }
}

function detailItem(id: number, agentId: number | null, agentName: string | null) {
  return {
    id,
    messageId: id,
    sessionId: 500 + id,
    userId: 9,
    username: 'u',
    displayName: '用户',
    agentId,
    agentName,
    reason: 'WRONG_RESULT',
    reasonLabel: REASON_LABEL,
    source: 'feishu',
    status: 'PENDING',
    handledByName: null,
    experienceId: null,
    sameGroupCount: 1,
    messageExists: true,
    contentPreview: `内容${id}`,
    createdAt: '2026-11-24T10:00:00',
  }
}

const ALL_ITEMS = [detailItem(101, null, null), detailItem(102, 7, '客服助手'), detailItem(103, 7, '客服助手')]
const NO_AGENT_ITEMS = [detailItem(101, null, null)]

let listParams: Array<Record<string, unknown>> = []

/** 服务端按「正确」语义响应：带显式空 Agent 标记才返回无 Agent 子集 */
function apiGetImpl(url: string, config?: { params?: Record<string, unknown> }) {
  const params = config?.params ?? {}
  if (url === '/agents') return Promise.resolve({ data: [{ id: 7, name: '客服助手' }] })
  if (url === '/feedback/admin/summary') return Promise.resolve({ data: summaryFixture() })
  if (url === '/feedback/admin/list') {
    listParams.push({ ...params })
    if (params.agentIdNull === true || params.agentId === null) {
      return Promise.resolve({ data: { items: NO_AGENT_ITEMS, total: NO_AGENT_ITEMS.length } })
    }
    if (typeof params.agentId === 'number') {
      const items = ALL_ITEMS.filter((row) => row.agentId === params.agentId)
      return Promise.resolve({ data: { items, total: items.length } })
    }
    return Promise.resolve({ data: { items: ALL_ITEMS, total: ALL_ITEMS.length } })
  }
  return Promise.resolve({ data: undefined })
}

function mountView(): VueWrapper {
  const router: Router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'root', component: defineComponent({ render: () => h('div') }) }],
  })
  return mount(FeedbackView, { global: { plugins: [ElementPlus, router] } })
}

function detailTable(wrapper: VueWrapper): VueWrapper {
  const tables = wrapper.findAllComponents({ name: 'ElTable' })
  expect(tables.length).toBeGreaterThanOrEqual(2)
  return tables[tables.length - 1]
}

function detailRows(wrapper: VueWrapper): VueWrapper[] {
  return detailTable(wrapper).findAll('.el-table__row')
}

beforeEach(() => {
  listParams = []
  apiGet.mockReset()
  apiGet.mockImplementation(apiGetImpl)
  apiPost.mockReset()
  apiPost.mockResolvedValue({ data: { dismissed: 1 } })
  window.innerWidth = 1280
  if (typeof window.matchMedia !== 'function') {
    window.matchMedia = (() => ({
      matches: false, media: '', onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia
  }
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('FeedbackView 待处理矩阵「无 Agent」下钻（验证用例）', () => {
  bugIt('点「无 Agent（飞书）」单元格后列表请求必须能表达空 Agent 约束（当前失败=bug）', async () => {
    const wrapper = mountView()
    await flushPromises()

    const matrixTable = wrapper.findAllComponents({ name: 'ElTable' })[0]
    const noAgentCell = matrixTable.findAll('.matrix-cell').find((btn) => btn.text() === '1')
    expect(noAgentCell).toBeTruthy()
    await noAgentCell!.trigger('click')
    await flushPromises()

    const last = listParams[listParams.length - 1]
    // 正确行为：请求必须携带可区分的空 Agent 约束（否则与「全部」无法区分）
    expect(last.agentIdNull === true || last.agentId === null).toBe(true)
    wrapper.unmount()
  })

  bugIt('点「无 Agent（飞书）」后列表必须只剩无 Agent 行（当前失败=bug：混入其它 Agent）', async () => {
    const wrapper = mountView()
    await flushPromises()

    const matrixTable = wrapper.findAllComponents({ name: 'ElTable' })[0]
    const noAgentCell = matrixTable.findAll('.matrix-cell').find((btn) => btn.text() === '1')
    await noAgentCell!.trigger('click')
    await flushPromises()

    // 用户可见后果：点的是「无 Agent」行，明细却出现带 Agent 的行
    const rows = detailRows(wrapper)
    expect(rows).toHaveLength(1)
    expect(rows[0].findAll('td')[5].text()).toBe('-')
    wrapper.unmount()
  })

  it('对照组：点普通 Agent 单元格后按该 Agent 过滤（既有行为正确）', async () => {
    const wrapper = mountView()
    await flushPromises()
    const matrixTable = wrapper.findAllComponents({ name: 'ElTable' })[0]
    const agentCell = matrixTable.findAll('.matrix-cell').find((btn) => btn.text() === '2')
    expect(agentCell).toBeTruthy()
    await agentCell!.trigger('click')
    await flushPromises()

    const last = listParams[listParams.length - 1]
    expect(last.agentId).toBe(7)
    const rows = detailRows(wrapper)
    expect(rows).toHaveLength(2)
    wrapper.unmount()
  })
})

describe('FeedbackView 取消选择后 el-table 内部选区残留（验证用例）', () => {
  bugIt('取消选择后再勾选一行，批量忽略必须只提交该行（当前失败=bug）', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(detailRows(wrapper)).toHaveLength(3)

    // element-plus 表格选择列的勾选走原生 input 的 change 事件（root 的 onClick 有
    // isLabeledByFormItem 门禁，表格里不生效），这里按真实浏览器行为驱动 change
    const boxes = () => detailRows(wrapper).map((row) => row.find('input.el-checkbox__original'))
    await boxes()[0].trigger('change')
    await boxes()[1].trigger('change')
    await flushPromises()
    expect(wrapper.text()).toContain('已选 2 条')

    // 取消选择：批量条应收起
    const cancelBtn = wrapper.findAll('button, a').find((el) => el.text() === '取消选择')
    expect(cancelBtn).toBeTruthy()
    await cancelBtn!.trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('已选')

    // 只勾选第一行（id=101），然后点批量忽略
    await boxes()[0].trigger('change')
    await flushPromises()
    expect(wrapper.text()).toContain('已选 1 条')

    const dismissBtn = wrapper.findAll('button').find((el) => el.text() === '忽略')
    expect(dismissBtn).toBeTruthy()
    await dismissBtn!.trigger('click')
    await flushPromises()

    // 正确行为：提交的就是用户刚勾的这一行
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost.mock.calls[0][1]).toEqual({ feedbackIds: [101] })
    wrapper.unmount()
  })

  it('对照组：未走过取消选择时连续勾选提交两行（既有行为正确）', async () => {
    const wrapper = mountView()
    await flushPromises()
    const boxes = () => detailRows(wrapper).map((row) => row.find('input.el-checkbox__original'))
    await boxes()[0].trigger('change')
    await boxes()[2].trigger('change')
    await flushPromises()
    expect(wrapper.text()).toContain('已选 2 条')
    const dismissBtn = wrapper.findAll('button').find((el) => el.text() === '忽略')
    await dismissBtn!.trigger('click')
    await flushPromises()
    expect(apiPost).toHaveBeenCalledTimes(1)
    expect(apiPost.mock.calls[0][1]).toEqual({ feedbackIds: [101, 103] })
    wrapper.unmount()
  })
})
```
