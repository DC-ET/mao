# 最近两天提交代码审查（2026-10-22 ~ 2026-10-23）

- **审查日期**：2026-10-23
- **git 范围**：`7d7fa014^..6c8e5ed6`（含当天早上合并的 0.0.336）
- **改动规模**：145 个 ts/vue/java 文件，+9030 / −875
- **审查方式**：主代理逐文件通读 + 4 个并行 reviewer 子代理分方向深挖（后端体积压缩 / 后端图片 URL 注入与轨迹记录 / 前端桌面端 / 轨迹下钻前后端）
- **防误报约定**：**每一个写入本文档的 bug 都附有可执行的验证测试**；测试以「应有的正确行为」为断言，当前实现下失败即缺陷证据。没有测试支撑的疑点一律进入「已排除」章节，不列为 bug。
- **前置审查**：`2026-10-22-payload-budget-review-01..05`、`2026-10-22-chat-image-url-injection-round-1/2`、`2026-10-22-run-trace-deep-dive-round1/2/3` 已闭环的问题不重复报告。

---

## 一、结论

**10 个缺陷已全部修复并提交（0.0.337），全部 bugcheck 测试转绿，backend-ts / desktop 全量测试零失败。**

> 审查当时（修复前）的结论是「不建议按现状合并」：确认 **10 个真实缺陷**（2 高 / 6 中 / 2 低），其中 2 个是「核心功能在生产数据上恒不工作」级别的方向性错误。
>
> **修复状态（2026-10-23，随 0.0.337 一并提交）**：下表「修复状态」列全部为 ✅；每个 bug 的「实际修复」小节记录了落地改动位置。原始「建议修复」内容保留在其后，便于对照决策与最终实现的差异。

| 编号 | 级别 | 一句话 | 验证测试 | 修复状态 |
|---|---|---|---|---|
| **BUG-1** | 高 | `compressForStore` 早返回分支未与原图比较，低质量大图被放大 1.89~2.35 倍写回 | `prompt-image-resizer-store.bugcheck.spec.ts` | ✅ 已修复 |
| **BUG-2** | 高 | 轨迹下钻配对窗口方向反了：工具记录恒看不到 llm_call、轮次工具清单恒为空 | `run-trace-call-window-direction.bugcheck.spec.ts` | ✅ 已修复 |
| **BUG-3** | 中 | `inWindow` 闭区间 + `endMs` 恒等于 `created_at`，同刻时钟下把下一轮工具算进本轮 | `run-trace-round-window.bugcheck.spec.ts` | ✅ 已修复 |
| **BUG-4** | 中 | `findRoundTools` 全会话扫描并全量 `JSON.parse`，抽屉开销随会话规模线性增长 | 同上 | ✅ 已修复 |
| **BUG-5** | 中 | 注入行剥离正则 `\S+$` 不容忍行尾空白，编辑往返后注入行翻倍并落库 | `image-url-annotation-trailing-space.bugcheck.spec.ts` | ✅ 已修复 |
| **BUG-6** | 中 | 时间条带节点 key 在 `toolCallId` 为 null 时重复，DOM id 唯一性与定位均被破坏 | `trace-display-keyuniqueness.bugcheck.test.ts` | ✅ 已修复 |
| **BUG-7** | 中 | 详情抽屉 `absolute` 定位链上无定位祖先，遮罩铺满整个视口 | `run-trace-drawer-containing-block.bugcheck.test.ts` | ✅ 已修复 |
| **BUG-8** | 中 | `page_screenshot` 压缩路径重建对象，静默丢弃上游 outcome 的非白名单字段 | `page-screenshot-fields.bugcheck.spec.ts` | ✅ 已修复 |
| **BUG-9** | 低 | tooltip 在色条间快速移动时 300ms 内显示旧节点内容 | `run-trace-band-tooltip.bugcheck.test.ts` | ✅ 已修复 |
| **BUG-10** | 低 | `traceRecords` 缓存无容量上限、`clearTrace` 不释放 records，敏感正文驻留窗口过长 | `trace-records-cache.bugcheck.test.ts` | ✅ 已修复 |

> BUG-2 与 BUG-3 同源（`run-trace-record.service.ts` 的时间窗口径），但表现与触发条件不同，分列两条。
>
> 前端桌面端方向（`useChatScroll` / `chatSessionActions` / `useChatQueue` / session store / `SideChatPanel` / `TaskInspector`）经通读与实测**未发现可触发功能缺陷的 bug**，两条轻微项因「无法构造必然失败的时序」未列为 bug，记在第三章第 4、5 条。

---

## 二、BUG 详情

### BUG-1（高）`compressForStore` 把低质量大图压得比原图更大

**位置**：`backend-ts/src/harness/tool/prompt-image-resizer.ts:185-187`（早返回分支），对照 `:209-215`（循环末尾的保护）

```ts
const normalized = await this.resizeForPrompt(input, mimeHint);
if (normalized.bytes.length <= thresholdBytes) {
  return normalized;          // ← 只与阈值比，未与 input.length 比
}
```

**根因**：函数末尾有「压不小就别压大」的保护（`if (best.bytes.length >= input.length) return 原图`），早返回分支没有。`resizeForPrompt` 走 `encodeSpecFor` 的 JPEG q85 / PNG 分支，对已是低质量编码的图，q85 重编码必然变大；产物若仍在 1.5MB 阈值内就命中早返回被原样写回。

**与本次改动的耦合**：`0637344e` 把阈值从 500KB 提到 1.5MB。旧阈值下这类规整产物（391KB~568KB）**不会**早返回，会继续走有损循环并被末尾保护拦下——即该缺陷在区间起点不可达，是本次阈值调整新暴露的。

**触发场景**：`read_file` 读低质量大图、`page_screenshot`、IM 入站压缩三条写侧路径。低质量 JPEG（手机端省流量模式）常见。

**影响量化**（测试实测，2048×2048 平滑渐变图——q85 重编码对平滑内容放大最明显）：

| 原图 quality | 原图字节 | `compressForStore` 返回 | 放大倍数 |
|---|---|---|---|
| q=5 | 25,574 | 48,220 | **1.89×** |
| q=10 | 26,127 | 58,523 | 2.24× |
| q=15 | 26,609 | 62,620 | 2.35× |
| q=20 | 27,140 | 62,232 | 2.29× |

另一类输入（2048×2048 高细节噪声图，`computeTargetSize` 因 patch 预算把尺寸压到 1600×1600）同样复现：q=20 原图 182,503 → 391,387（2.14×）、q=30 → 1.75×、q=40 → 1.42×、q=50 → 1.18×，q=60 起转为缩小。

变大的 data URI 落库后永久存在于 `message.metadata` 与每轮请求里，同时抬高 `RequestSizeEstimator` 估算值，使体积压缩触发比预期更频繁。

**验证测试**：`backend-ts/src/harness/tool/prompt-image-resizer-store.bugcheck.spec.ts`
- `BUG H1：低质量大图经 compressForStore 被放大（写侧体积反升）` — `expected 48220 to be less than or equal to 25574`
- `BUG H1 影响量化：放大倍数随原图质量降低而上升`

**✅ 实际修复（0.0.337）**：`backend-ts/src/harness/tool/prompt-image-resizer.ts` 两处补上「≤ 原图」的同口径比较——

- 早返回分支：`if (normalized.bytes.length <= thresholdBytes && normalized.bytes.length <= input.length)`；
- 有损循环返回：`if (encoded.bytes.length <= targetBytes && encoded.bytes.length < input.length)`。

规整产物小于阈值但大于原图时不再早返回，继续在有损循环里找更小解，循环也失败才由函数末尾既有的「压不小就别压大」保护回落原图。测试文件里的 `BUG H1 影响量化` 用例已改名为 `BUG H1 修复后：写侧产物一律不大于原图`，断言改为 `Math.max(...ratios)).toBeLessThanOrEqual(1)`（6/6 通过）。

**建议修复**：早返回补同口径比较——规整产物 ≤ 阈值 **且** ≤ 原图才采用，否则继续在有损循环里找更小解，循环也失败才回落原图。需与「仅因尺寸超限的图仍保持 PNG 无损」的既有约定对齐。

---

### BUG-2（高）轨迹下钻配对窗口方向反了，核心功能恒不工作

**位置**：`backend-ts/src/session/run-trace-record.service.ts:66-73`（`findCall`）、`:81-115`（`findRoundTools` / `inWindow`）

**根因**：`llm_call.created_at` 是**调用结束时刻**（`V142__millisecond_created_at.sql` 注释明确），`message.created_at` 是**消息落库时刻**。生产落库时序可由代码完整推出：

1. `agent-loop.ts:382-390`：`LlmCallContext.runAsync(...)` 包住 `llmAdapter.stream(...)`；`RecordingLlmAdapter.stream` 的 `finally` 在流 resolve 后**立即** `record(...)` 落 `llm_call` 行；
2. 之后才进入 `executeToolCalls(...)`，再由 `persistToolRound`（`harness-service.ts:215-232`）在同一个事务里插 ASSISTANT + TOOL 消息。

即 `C = llm_call.created_at < A = 助手消息.created_at < T`，**C 恒早于 A**。

而 `findCall` 的窗口是 `[A, T)`（`selectBySessionWindow` 是 `created_at >= startAt AND created_at < endAt`）——本轮的 `llm_call` 落在窗口起点之外，**恒返回 null**。同一方向性错误也打在 `findRoundTools` 上：`inWindow` 的 `endMs` 恒等于 `C`，本轮助手消息 `A > C` 恒被排除。

**同仓库的正确参照**：`run-trace.service.ts:280` 的 `notAfter(entry.call.createdAt, message.createdAt)`（`:672-675` 定义 `a <= b`）方向是正确的，V142 注释描述的正是 `C ≤ A` 这个事实。本 bug 的根因是 `run-trace-record.service.ts` 没有沿用这个已验证正确的方向。

**触发场景**：点任意工具行下钻「计时与元信息」tab → 恒显示「未配对到模型调用记录」；点任意轮次行下钻 →「本轮工具」清单恒为空。**不是偶发，是每一次都发生。**

**为什么既有单测测不出来**：`run-trace-record.service.spec.ts:85-95` 的 fixture 把 `A` 设得远早于 `C`（`A=10:00:00.000`、`T=10:00:04.300`、`C=10:00:04.200`），与生产时序正好相反。测试数据自洽但与生产不符，掩盖了方向错误。

**验证测试**：`backend-ts/src/session/run-trace-call-window-direction.bugcheck.spec.ts`
- `BUG-3：生产时序 C < A < T 下，本轮 llm_call 落在窗口外，配对恒为 null` — `expected null not to be null`
- `BUG-3：同一方向性错误让 findRoundTools 把本轮助手消息排除在外` — `expected [] to include 'call_this'`
- `既有 fixture 口径（A 远早于 C）能命中——这正是它掩盖方向错误的原因`（通过，作为对照证据）

**✅ 实际修复（0.0.337）**：`backend-ts/src/session/run-trace-record.service.ts` + `session.repository.ts` 一并改掉了三个缺陷（BUG-2 / BUG-3 / BUG-4 同源，落地为一次重构）：

- `findCall(sessionId, endAtExclusive)` 只传**上界**，下界刻意开放（`selectBySessionWindow(sessionId, null, endAtExclusive)`）——本轮 `llm_call` 落在原窗口起点之外的问题由此消除，`endAtExclusive == null` 时返回 null（无上界就不猜）。
- `findRoundTools` 重写：先 `selectBySessionWindow(sessionId, null, null)` 取全会话调用序列，`findIndex` 定位本轮，取 `calls[index + 1]` 作为上界（下一轮 `llm_call.created_at`），再 `selectAssistantToolCalls(sessionId, next?.createdAt ?? null)`。时间窗下推 SQL，不再全量 `JSON.parse` 全会话消息（BUG-4）。
- `selectAssistantToolCalls` 新增第二参 `upperCreatedAtExclusive?: string | null`，非 null 时 SQL 加 `AND created_at < ?`（`DATETIME(3)` 字典序 = 时间序，半开区间与 `selectBySessionWindow` 口径一致）。
- 删除了不再使用的 `inWindow` 闭区间函数与 `estimatedStartMs` import，文件头注释更新为新口径。

`run-trace-record.service.spec.ts` 有两个 fixture 因语义变化被改造（不是回归）：`assistantToolCalls` 改为生产时序（`C < A < T`），`calls` 补了一条窗外调用用于验证上界过滤。

**建议修复**：`findCall` 窗口起点改为不设下界，或用 `llm_call.created_at − durationMs`；更稳的是按「该 tool_call 之前最近的 agent 调用」用 id 区间关联，而不是纯时间窗（`buildRun` 里已有 `anchor.id` / `upperId` 的现成口径）。`findRoundTools` 的 `endMs` 放宽到下一轮 `llm_call.created_at`，或改用助手消息 id 区间。**必须同步补一条时序正确的回归用例**（`C < A < T`），否则修完仍测不出来。

---

### BUG-3（中）`inWindow` 闭区间把下一轮工具算进本轮

**位置**：`backend-ts/src/session/run-trace-record.service.ts:96-121`（`findRoundTools` / `inWindow`）

**根因**：`endMs = estimatedStartMs(createdAt, durationMs) + durationMs`，而 `estimatedStartMs = createdAt − durationMs`，两者相减恰好抵消 → **`endMs` 恒等于 `llm_call.created_at`**。`inWindow` 用闭区间 `at >= startMs && at <= endMs`。

**同刻可达性**：`message.created_at` 与 `llm_call.created_at` 都由 MySQL `CURRENT_TIMESTAMP(3)` 生成（`common/datetime.ts:53-61` 注释确认「created_at 两列都由服务端 CURRENT_TIMESTAMP(3) 生成，应用不传值」），同一时钟源。工具轮耗时 <1ms 时两行同刻落库完全可达；历史秒级行（V142 迁移把存量补成 `.000`）与时钟回拨也会造成同刻。

**影响**：比「混入」更严重——实测本轮清单里**只剩下一轮的工具**，本轮自己的工具反被排除（因为本轮的 `A > C`，见 BUG-2）。「本轮工具（N）」的 N 与链接都指向错误的轮次。

**口径不一致**：同一 service 内 `selectBySessionWindow` 用半开 `[start, end)`，`inWindow` 用闭区间，两种窗口语义并存。

**验证测试**：`backend-ts/src/session/run-trace-round-window.bugcheck.spec.ts`
- `M-3b：下一轮助手消息与 llm_call 同刻落库时被算进本轮` — `expected [ 'call_next' ] to deeply equal [ 'call_this' ]`
- `M-3b：窗口内稍早于结束时刻的下一轮工具同样被闭区间吃进` — 同上
- 两条正确性基线通过（窗口内工具正确列出、时钟缺失退化为全会话清单）

**✅ 实际修复（0.0.337）**：与 BUG-2 同批落地——闭区间 `inWindow` 被整体删除，归属改为「下一轮 `llm_call.created_at` 之前」的 SQL 半开窗（`created_at < ?`）。同刻落库的下一轮消息因严格小于上界而不再被吃进本轮，口径与 `selectBySessionWindow` 统一。详见 BUG-2 的「实际修复」。

**建议修复**：上界改排他（`at < endMs`）与 `selectBySessionWindow` 对齐；更稳的做法是按助手消息 id 区间归属。与 BUG-2 一并处理。

---

### BUG-4（中）`findRoundTools` 全会话扫描并全量 `JSON.parse`

**位置**：`backend-ts/src/session/run-trace-record.service.ts:87`（`selectAssistantToolCalls(sessionId)`）、`session.repository.ts:692-697`（无时间窗、无 id 上界）

**根因**：`findRoundTools` 拉取全会话助手消息，对**每一条**的 `toolCalls` 做 `JSON.parse` 后再逐条 `inWindow` 过滤。缓存只在同一 `recordKey` 重复打开时生效；用户点开轮次 1 再点轮次 2，两次都是不同的 `call:N` key，各自全量扫一遍。

**影响量化**（测试实测，5000 条助手消息 × 6 个调用/条）：单次 `buildCallRecord` 约 **42.8ms** 纯 `JSON.parse`，且**用户每点开一次轮次详情抽屉就要付一遍**，随会话规模线性恶化。

**验证测试**：`backend-ts/src/session/run-trace-round-window.bugcheck.spec.ts`
- `M-3a：全会话助手消息的 tool_calls 都被 JSON.parse（无时间窗 / id 上界）`（通过，作为「无窗口参数」的结构证据）

**✅ 实际修复（0.0.337）**：与 BUG-2 / BUG-3 同批落地——`selectAssistantToolCalls` 增加 `upperCreatedAtExclusive` 参数，时间窗下推 SQL；`findRoundTools` 不再拉全会话助手消息再逐条 `JSON.parse`，只取「上一轮之后、下一轮之前」的窗口。详见 BUG-2 的「实际修复」。

**建议修复**：把时间窗下推到 SQL（给 `selectAssistantToolCalls` 增加可选的 epoch ms 区间或 `created_at` 区间参数），或至少按 id 上界裁剪。

---

### BUG-5（中）注入行剥离正则不容忍行尾空白，编辑往返后翻倍

**位置**：`backend-ts/src/session/util/image-url-annotation.ts:12`（`IMAGE_URL_LINE_PATTERN = /^\[图片 \d+\] \S+$/gm`）、`:22`（`appendImageUrlLines` 的幂等依赖）；`desktop/src/utils/imageUrlAnnotation.ts:14` 前端同格式复刻；编辑入口 `session.service.ts:1601` `buildEditContent`

**根因**：`\S+$` 要求整行以非空白字符结尾。`m` 标志下 `$` 匹配「行终结符之前的位置」，而 `\S` 排不掉 `\r`、`\t`、空格——行尾带任一空白字符时整行不匹配，`stripImageUrlLines` 返回原文，`appendImageUrlLines` 再追加一份。

**触发路径（前端用户操作可达，不需要任何渠道配合）**：`MessageBubble.vue:344/350` 把含注入行的落库原文塞进 `<textarea>`，用户对行尾敲空格或粘贴带入 → `confirmEdit` 原样回传 → 后端剥不掉 → 落库翻倍。另一条路径是正文带 `\r`（CRLF）时注入行以 `...png\r` 形态落库。

**影响量化**（测试实测）：`buildUserContentParts` 产出的落库文本里注入行出现 **2 份**；CRLF 场景 `strip` 后残留 `'上文\r\n\r\n\r'`。翻倍的行会进入 LLM 上下文与气泡展示。

**验证测试**：`backend-ts/src/session/util/image-url-annotation-trailing-space.bugcheck.spec.ts`（4 个失败用例 + 2 个通过的基线）
- `BUG-4：行尾带空格的注入行剥不掉，编辑往返后翻倍`
- `BUG-4：CRLF 结尾的注入行剥不掉且残留 \r`
- `BUG-4：appendImageUrlLines 对带行尾空格的正文失去幂等性`
- `BUG-4：buildUserContentParts 落库文本出现两份注入行` — `expected 2 to be 1`

**✅ 实际修复（0.0.337）**：**前后端两处同步修改**（这是本次修复的硬约束，两侧口径分叉正是 round-2 BUG-2 的根因模式）：

- `backend-ts/src/session/util/image-url-annotation.ts`：正则改为 `/^\[图片 \d+\] \S+[ \t\r]*$/gm`（行尾容忍空格 / 制表 / `\r`，`[ \t\r]*` 不含 `\n` 以免跨行吞掉后续正文）；`stripImageUrlLines` 的尾随收敛改为 `/[\r\n]+$/`。
- `desktop/src/utils/imageUrlAnnotation.ts`：逐字节同步上述两处。

`image-url-annotation-trailing-space.bugcheck.spec.ts` 6/6 通过，既有 `image-url-annotation.spec.ts`（14 例）与前端 `imageUrlAnnotation.test.ts`（4 例）无回归——「行内仍有空格的正文不匹配」的基线用例依旧通过。

**建议修复**：正则放宽为 `\S+\s*$`（或 `[^\r\n]+$`），`stripImageUrlLines` 的尾随收敛同时处理 `\r`（`/[\r\n]+$/`）。**前后端两处实现必须同步改**，否则前端 `isOptimisticEchoOf` 的剥离口径会与后端 VO 口径再次分叉（那正是 round-2 BUG-2 的根因模式）。改完补行尾空格 / CRLF 两条往返幂等回归。

---

### BUG-6（中）时间条带节点 key 在 `toolCallId` 为 null 时重复

**位置**：`desktop/src/utils/trace-display.ts:189`（`toolNode` 的 `key: \`tool:${segmentKind}:${tool.toolCallId ?? tool.name}\``）、`desktop/src/components/center/RunTracePanel.vue:174`（`toolAnchorKey` 同口径）、`:150/:170`（两个 `:id="rowAnchorId(...)"`）、`RunTraceTimeBand.vue:16`（`v-for :key`）

**根因**：BUG C/F 的修复给 key 补了「段维度」与「runId 维度」，但没处理 `toolCallId` 本身为 `null` 时的退化。`activityToToolVO`（`backend-ts/src/session/run-trace.service.ts:444-455`）对没有 `toolCallId` 的活动产出 `toolCallId: null`，`name = activity.summary`。这类行真实存在且有多个生产来源：`workspace-write.service.ts:443-451`（用户手动文件写入）、`git-write-operation.service.ts:443-452`（Git 操作）。

**后果**（三条同时发生）：
1. `v-for :key` 出现重复 key → Vue 渲染错乱（控制台告警 + 补丁算法可能复用错误 DOM 节点）；
2. 两个 `tool-row` 的 `:id` 完全相同 → HTML id 唯一性被破坏；
3. `locateNode` 的 `document.getElementById` 按文档序返回**第一个**匹配 → 点击条带上第二条色条，滚动定位与 1.2s 高亮落在**第一条**行上。

**实现内部不自洽的证据**：行渲染层的 `:key` 用 `toolKey(tool)`（`toolCallId | target | name`，`RunTracePanel.vue:505-507`），说明行层已预见到这个维度，只有条带节点 key 与锚点 key 漏了同样的维度。

**验证测试**：`desktop/src/utils/trace-display-keyuniqueness.bugcheck.test.ts`
- `H-1：toolCallId 为 null 的同类未挂轮工具产生重复 key` — `expected 1 to be 2`
- `H-1：toolCallId 为 null 的同类轮内工具同样重复（git 操作连续两次）` — `expected 2 to be 3`
- `行渲染层的 :key（toolKey）能区分这两条，条带 key 与锚点 key 却撞了`（通过，作为不自洽的对照证据）
- 1 条正确性基线通过（跨段 key 唯一）

**✅ 实际修复（0.0.337）**：把区分维度做成单一口径并让两处共用，彻底消除「条带 key 与行锚点 key 分叉」这类问题：

- `desktop/src/utils/trace-display.ts`：新增导出 `toolAnchorKey(tool)` = `${toolCallId ?? ''}|${target ?? ''}|${tool.name}`（与行渲染 `:key` 同口径），`toolNode` 的 key 改为 `tool:${段}:${toolAnchorKey(tool)}|${段内序号}`。段内序号由 `runTimeNodes` 统一递增（先 `unplacedTools` 再 `rounds.tools`），三元组仍相同时也保证唯一。
- `desktop/src/components/center/RunTracePanel.vue`：`toolKey()` 改为委托 `toolAnchorKey`（import 时别名 `toolAnchorKeyOf`，避免与本地 3 参版同名遮蔽造成无限递归——这一点在修复过程中被既有测试真实抓到）；`toolAnchorKey(segmentKind, tool, ordinal)` 改为 `${段}:${toolAnchorKeyOf(tool)}|${ordinal}`，两个 `v-for` 都带 `(tool, toolIndex)` 传入序号，与 `runTimeNodes` 的 `toolOrdinal` 严格同步。
- `locateNode` 的 `indexOf(':')` 切分无需改动：key 里的 `|` 不是冒号，`target` 含冒号的情况原本就已兼容。

`trace-display-keyuniqueness.bugcheck.test.ts` 4/4 通过；既有 `trace-display.test.ts`、`run-trace-panel-session.test.ts` 中 4 处断言旧 key 字面量的用例已按新口径更新（`tool:before_edit:call_unplaced` → `tool:before_edit:call_unplaced|a.txt|glob|0` 等）。

**建议修复**：让工具节点 key 带上区分维度——复用 `toolKey` 的口径（`toolCallId | target | name`），或给 `TimeBandNode` 增加稳定的 `rowId` 字段由面板侧生成，`toolAnchorKey` 与 `toolNode.key` 都用它。注意 `locateNode` 的 `indexOf(':')` 切分要同步适配（现有写法只切第一个冒号，已兼容 `target` 含冒号的情况）。

---

### BUG-7（中）详情抽屉 `absolute` 定位链上无定位祖先，遮罩铺满整个视口

**位置**：`desktop/src/components/center/RunTraceRecordDrawer.vue:184-189`（`.record-drawer-layer { position: absolute; inset: 0; z-index: 20 }`）

**根因**：`position: absolute` 的包含块是**最近的 `position != static` 的祖先**的 padding box。逐层核查祖先链：

| 元素 | 样式位置 | 是否定位祖先 |
|---|---|---|
| `.record-drawer-layer` | `RunTraceRecordDrawer.vue:184` | —（absolute 自身） |
| `.run-trace-panel` | `RunTracePanel.vue:640-646` | 否（无 position） |
| `.center-tab-container` | `CenterTabContainer.vue:87-93` | 否 |
| `.task-container` | `TaskView.vue:1223-1230` | 否 |
| `.task-layout` | `TaskView.vue:1217-1221` | 否 |

整条链没有任何定位祖先 → 包含块回落到**初始包含块（视口）**。

**后果**：
- 遮罩 `.record-drawer-mask { inset: 0 }` 覆盖**整个视口**：左侧会话列表、顶部导航、右侧边栏、底部终端面板全部被半透明黑遮住且不可点击。抽屉开着时无法切换会话、无法看右侧上下文，与「排障视图」的诉求相反。
- 抽屉 `.record-drawer { right: 0 }` 的右边缘对齐**视口右边**，视觉上像从屏幕右侧滑入的全屏侧栏，而不是「面板内的抽屉」。
- 与组件注释、技术方案 §5.6「覆盖面板内容区，不盖面板外」的意图直接矛盾。

**触发场景**：在轨迹 Tab 里点任一行「详情」按钮，100% 触发。

**验证测试**：`desktop/src/components/center/run-trace-drawer-containing-block.bugcheck.test.ts`
- `M-1：抽屉自身是 absolute，但祖先链上没有任何定位祖先` — 断言「至少有一个定位祖先」失败（positioned 列表为空）

> 说明：desktop 的 vitest 是 node 环境、无布局引擎，无法实测 `getBoundingClientRect`，因此按「祖先链样式」静态验证。这是 CSS 包含块语义的确定性推论，不是近似。

**✅ 实际修复（0.0.337）**：`desktop/src/components/center/RunTracePanel.vue` 的 `.run-trace-panel` 加 `position: relative`（并注明原因：抽屉层需要定位祖先做包含块）。`run-trace-drawer-containing-block.bugcheck.test.ts` 1/1 通过。

> 附带修掉测试自身的一个工具 bug：该测试的 `isPositioned()` 正则写错了转义层级（`\\${escaped}` 多了一层反斜杠，`\\.` 匹配字面反斜杠），导致对任何选择器都返回 false——不修的话即使生产代码改对，这条断言仍然失败。修正为 `${escaped}\\s*\\{([^}]*)\\}`。

**建议修复**：给 `.run-trace-panel` 加 `position: relative`（最小改动，让包含块落在面板上，正好符合设计意图）。修完补一条断言：抽屉遮罩的 `getBoundingClientRect()` 不大于面板的。

---

### BUG-8（中）`page_screenshot` 压缩路径重建对象，静默丢弃上游字段

**位置**：`backend-ts/src/harness/tool/impl/page-tools.ts:146-154`

```ts
const compressed = await compressScreenshot(dataUri, mime);
return toJson({
  media_type: 'image', mime: ..., path: 'page-screenshot.png',
  data_uri: ..., width: ..., height: ..., masked: shot.masked === true,
});   // ← 新建对象只含 7 个键，outcome 层其它字段全丢
```

**根因**：`toJson({...})` 重建对象而非 `{ ...shot, data_uri: ... }` 展开。对照 `sdk/embed/src/page/engine.ts:298-303`：`handleScreenshot` 返回 `{ success, result: shot, pageVersion }`，`handleSingle` 还带 `snapshotId` / `pageVersion`。这些是上游 SDK 的产出，后端重建对象时一并丢掉，且无任何日志。

**影响**：桌面端 / SDK 后续在 `result` 或 `outcome` 上加字段（`viewport`、`deviceScaleFactor`、`pageVersion`…）会被静默吞掉，模型与前端都看不到；排障时缺少页面版本信息。

**验证测试**：`backend-ts/src/harness/tool/impl/page-screenshot-fields.bugcheck.spec.ts`
- `M-4：压缩路径重建对象，丢弃 outcome 层的 pageVersion 等字段` — `expected undefined to be 42`
- `M-4：result 内非白名单字段同样被丢弃` — `expected undefined to be 2`
- 2 条正确性基线通过（7 个白名单字段完整透传、失败结果原样返回）

**✅ 实际修复（0.0.337）**：`backend-ts/src/harness/tool/impl/page-tools.ts` 两处：

1. `parseOutcome` 原先用 `{ success, result, error }` 白名单重建对象——**这才是丢字段的真正根因**（outcome 层的 `pageVersion` 在解析阶段就没了，后续怎么合并都救不回来）。改为保留全部顶层字段，用 `extra` 带出非判定字段。
2. `PageScreenshotTool.executePageTool` 改为扁平透传：`{ ...outcome.extra, ...shotFields, media_type, mime, path, data_uri, width, height, masked }`。剔除两项：原始 `dataUri`（已被压缩后的 `data_uri` 取代，双份 base64 会让请求体无谓翻倍）与已平铺的 `outcome.result`。

没有改成文档建议的 `toJson({ ...shot, ... })` 嵌套形态：下游 `tool-image-result-processor.ts` 读的是**顶层** `data_uri` / `media_type`（扁平契约，图片附件与预览都从那里取），嵌套到 `result` 下会直接破坏视觉通道——这一点由既有 `page-tools.spec.ts` 的 `wraps screenshots as image tool results for vision models` 用例当场抓住。

`page-screenshot-fields.bugcheck.spec.ts` 4/4 通过，既有 `page-tools.spec.ts` 7/7 无回归。

**建议修复**：改为 `toJson({ ...shot, media_type: 'image', mime, path, data_uri, width, height, masked })`，让上游新增字段默认透传；若确有需要屏蔽的键，显式列出并注释原因。

---

### BUG-9（低）tooltip 在色条间快速移动时显示旧节点内容

**位置**：`desktop/src/components/center/RunTraceTimeBand.vue:127-150`（`showTip` / `hideTip`）、`:10`（`@mouseleave="hideTip"` 只挂在 `<svg>` 根）

**根因**：`showTip` 只 `clearTimeout` 旧定时器，**不会立即清 `tip.value`**；`hideTip` 只绑定在 `<svg>` 的 `mouseleave`，色条之间移动不触发。从 rect A（tooltip 已弹出）快速移到 rect B 时，A 的 tooltip 继续显示 300ms，然后才被 B 的内容替换。

**影响**：纯展示层的瞬时内容错配，300ms 后自愈，不影响数据正确性与定位。密集色条的泳道里横向划过多个色条时可感知。

**验证测试**：`desktop/src/components/center/run-trace-band-tooltip.bugcheck.test.ts`
- `L-4：从已弹出的色条移到另一条时，300ms 内仍显示旧节点内容` — `expected true to be false`
- 1 条正确性基线通过（mouseleave 后 tooltip 立即消失）

**✅ 实际修复（0.0.337）**：`desktop/src/components/center/RunTraceTimeBand.vue` 两处：

- `showTip` 进函数即 `tip.value = null`（在 `clearTimeout` 之后、起新定时器之前），新 tooltip 从空状态开始 300ms 延迟，切换色条时旧内容立即撤下。
- 顺手带上 L-1：新增 `onUnmounted`，卸载时 `clearTimeout(tipTimer)` 并清 `tip.value`，避免 run 收起后回调写入已销毁组件的 ref。

`run-trace-band-tooltip.bugcheck.test.ts` 2/2 通过。

**建议修复**：`showTip` 进函数即 `tip.value = null`，让新 tooltip 从空状态开始延迟。顺手可加 `onUnmounted(() => { if (tipTimer != null) window.clearTimeout(tipTimer) })`（L-1：300ms 内 run 被收起时定时器不清；实测回调照跑但不抛错、无功能错误，属无害泄漏）。

---

### BUG-10（低）`traceRecords` 缓存无容量上限，工具正文无界常驻

**位置**：`desktop/src/stores/session/trace.ts:60`（定义）、`:133-140`（`setTraceRecord` 只 `bucket.set`）、`:111-121`（`clearTrace` 不碰 records）

**根因**：缓存是 `Map<sessionId, Map<key, TraceLoadedRecord>>`，`setTraceRecord` 没有任何容量限制、LRU 淘汰或大小估算。清理只有两条路径：`clearTraceRecords(sessionId)`（删会话 / 登出）与 `reset()`（登出）。而 `clearTrace(sessionId)`（切会话 / 清轨迹语义）虽是导出成员，**全仓库无人调用**，也不清理 `traceRecords`。

**增长模式（重要限定，避免夸大）**：缓存的 key 是 `tool:${toolCallId}` / `call:${llmCallId}`（`RunTraceRecordDrawer.vue` 的 `recordKey`），**每个工具 / 轮次只对应一个 key**，重复点开同一条不会新增条目。因此累积速度不是「点开次数」，而是「本会话出现过的不同工具 / 轮次数 × 用户点开过的比例」。

**影响**：长会话（数百次工具调用）里用户逐个点开详情后，几百 KB 到几十 MB 的工具正文字符串常驻内存，且用户切 Tab 再切回来、KeepAlive 保留面板实例，缓存都不会释放。抽屉正文是用户明确期望「随会话删除而消失」的敏感数据（密钥、路径、代码），长时间不释放扩大了泄露窗口。定级为**低**：单次增长有上界（等于会话的工具总数），不会无限膨胀，主要问题是「缺少与 `clearTrace` 联动的释放点」和敏感数据驻留窗口。

**验证测试**：`desktop/src/stores/session/trace-records-cache.bugcheck.test.ts`
- `M-2：同一会话连续写入任意数量的记录都不淘汰（无上限）` — 600 条全部常驻
- `M-2：clearTrace（切会话 / 清轨迹）应一并释放 records 正文` — 清轨迹后 records 仍在
- 1 条正确性基线通过（删会话时 records 随会话清掉、不跨会话残留）

**✅ 实际修复（0.0.337）**：`desktop/src/stores/session/trace.ts` 两处：

- 新增模块级常量 `TRACE_RECORDS_CAP = 200`，`setTraceRecord` 写入后 `while (bucket.size > TRACE_RECORDS_CAP)` 按插入序淘汰最旧（Map 保持插入序，重写同 key 不改变既有位置）。选插入序而非 LRU：记录详情是「点开才拉、短期内可能反复看」的数据，LRU 的收益不足以换取复杂度。
- `clearTrace(sessionId)` 增加 `traceRecords.value.delete(sid)`——切会话 / 清轨迹时一并释放正文，与 `traceRuns` 等状态的清理口径对齐。

`trace-records-cache.bugcheck.test.ts` 3/3 通过，既有 `src/stores/session/**` 68 例无回归。

**建议修复**：给每个 `sessionId` 桶加条数上限（如 200 条，超出按插入序淘汰最旧），或在 `clearTrace(sessionId)` 时一并清 records。

---

## 三、已验证无问题的疑点（防误报证据）

以下疑点都写了测试，**全部通过**——它们是「已验证无问题」的证据，不是缺陷。保留这些测试是为了防止后续改动 reintroduce。

### 后端

| 测试文件 | 覆盖内容 |
|---|---|
| `backend-ts/src/harness/tool/prompt-image-resizer-store.bugcheck.spec.ts`（基线 4 例） | `compressForStore` 对极小高质量 JPEG 保留原图、不可压缩大 PNG 不返回更大结果、尊重 1.2MB 目标、尺寸规整不放大 33×33 小图 |
| `backend-ts/src/harness/tool/store-compression-invariants.bugcheck.spec.ts`（7 例） | `STORE_TARGET_BYTES(1258291) < STORE_COMPRESS_THRESHOLD_BYTES(1572864)` 不变量、5MB 门限内大图可压到目标、`compressDataUriForStore` 对非图片 / 畸形 URI 原样返回（含 `undefined` 入参不抛） |
| `backend-ts/src/harness/core/request-size-accuracy.bugcheck.spec.ts`（8 例） | 估算器对控制字符、多字节边界、工具 JSON、camel/snake 混排、循环引用 `parameters` 的精度与健壮性 |
| `backend-ts/src/harness/core/payload-quota-accounting.bugcheck.spec.ts`（5 例） | request_start 与 mid-loop 两处阈值口径一致、边界 `>=` 一致、payload 名额只消耗一次、token 触发不占用 payload 名额 |
| `backend-ts/src/session/run-window-estimate.bugcheck.spec.ts`（12 例） | `estimatedStartMs` 的 null/NaN/负数时钟钳制、java 本地时间格式、`wallClockMs` 空集与不可解析行跳过 |
| `backend-ts/src/common/concurrency-failure.bugcheck.spec.ts`（4 例） | `mapWithConcurrency` 错误传播、批次中断、索引对齐、worker 不泄漏 |
| `backend-ts/src/harness/llm/remote-image-cache.bugcheck.spec.ts`（10 例） | 见下方专述 |

### 前端

`desktop/src/utils/trace-display-keyuniqueness.bugcheck.test.ts` 与各 bugcheck 文件内的「正确性基线」用例。

### 重点排除的两个误报

**1. `RemoteImageCache` 304 复用不刷新 `storedAt`（误报）**

疑点：`fetchAndEncode` 的 `res.status === 304 && stale != null` 分支调用 `put(...)`，怀疑条件请求随工具轮数线性增长。

实测否定：`put()` 内部 `storedAt: this.now()` **确实刷新了**。构造轮间隔 600ms（< TTL 1000ms）的场景，5 次 resolve → 3 次网络请求（t=1200 的 304 把 `storedAt` 刷到 1200，t=1800 命中缓存）。此前观察到的「11 次请求」是因为测试把轮间隔设成 1001ms > TTL 1000ms——等于模拟真实间隔超过 1 小时，那时每轮重新协商正是 TTL 的设计语义。

`remote-image-cache.bugcheck.spec.ts` 现有 10 例全部通过，其中：
- `refreshes storedAt after a 304 so revalidation does not repeat every call` — 断言 3 次（首拉 + t=1200 的 304 + t=2400 的 304），证明刷新生效
- `轮间隔超过 TTL 时每轮一次条件请求属预期设计（非缺陷）` — 明确记录这是设计行为

**2. 零宽空格正文 + 图片导致乐观消息重复上屏（误报）**

疑点：`useStreamWS.ts:875` 的空串兜底依赖 JS `trim()`，而 `trim()` 不清除零宽空格 `\u200B`，怀疑失配后重复上屏。

实测否定：主判定是 `stripImageUrlLines(lastUser.content) === stripImageUrlLines(content)`（两侧都剥离注入行后比对）。零宽空格场景下乐观消息是 `'\u200B'`、广播内容也是 `'\u200B'`，**两侧相等，主判定直接命中**，根本不走空串兜底。纯空格场景（`'   '`）同理。该兜底只是补充路径，其自身条件写得不严谨，但不构成缺陷。

**3. 图片 URL 注入的「尾随换行导致重复上屏」（误报，前序会话已排除）**

`stripImageUrlLines` 结尾统一 `replace(/\n+$/, '')`，前端 `isOptimisticEchoOf`（`desktop/src/stores/session/messages.ts:667`）与 `useStreamWS.ts:878` 都是两侧对称剥离，尾随换行被两边同时吃掉，比对仍相等。

**4. `useChatScroll` 孙级尺寸变化不触发贴底（轻微项，未列为 bug）**

疑点：`useChatScroll.ts:309-314` 的 `observeTargets` 只 `resizeObserver.observe(child)` 遍历 `el.children` 一层，`MutationObserver` 也只挂 `childList: true`。孙级及更深（`ThinkingBlock` 展开、`ToolCallCard` 结果区、`MarkdownContent` 异步高亮后的 `pre` 高度）尺寸变化而父级根 div 尺寸不变时，`scheduleFollow()` 不被调用。

未列为 bug 的理由：**无法构造出必然失败的时序**，且有两条现实缓解——(a) `MarkdownContent.vue:33-36` 渲染完成后派发 `mao:markdown-rendered`，`ChatPanel.vue:539` / `SubagentChatPanel.vue:304` / `SideChatPanel.vue:687` 三个面板都监听并调 `handleMarkdownRendered()` → `scheduleFollow()`，覆盖最主要的 markdown / 代码高亮场景；(b) `MessageBubble` 是流式气泡的直接子元素，其内部增高几乎都会同帧传导到该根 div 尺寸。按「无测试支撑不进 bug 清单」的约定，仅作为后续维护提示记录：若要彻底收口，可给 `MutationObserver` 加 `subtree: true`，或在注释里如实写明「孙级尺寸变化依赖 `mao:markdown-rendered` 兜底」。

**5. `handleScroll` 的 `programmatic` 复位依赖 rAF（轻微项，未列为 bug）**

`writeBottom` / `scrollToBottom` 置 `programmatic = true` 后用 `requestAnimationFrame` 复位（`useChatScroll.ts:86-104`、`:126-145`）。若浏览器在同一帧内同步派发 `scroll` 事件，该事件会被 `:238-240` 的守卫挡掉。实测确认无功能异常——被挡掉的 scroll 只是少做一次判定，`syncBaseline` 已把基准写成程序写入后的值，后续 scroll 与尺寸变化仍走正常路径；`useChatScroll.test.ts` 的 `frameSettled()` 注释也记录了「scrollToBottom 内部串了两个 rAF」这一既有约定。属实现细节的固有取舍，无需改动。

---

## 四、验证测试清单与运行方式

### 新增测试文件（本次审查的交付物，共 11 个）

后端（`backend-ts/`）：

```
src/harness/tool/prompt-image-resizer-store.bugcheck.spec.ts          # BUG-1 + 基线
src/harness/tool/store-compression-invariants.bugcheck.spec.ts        # 基线
src/harness/tool/impl/page-screenshot-fields.bugcheck.spec.ts         # BUG-8 + 基线
src/harness/llm/remote-image-cache.bugcheck.spec.ts                   # 基线（误报排除）
src/harness/core/request-size-accuracy.bugcheck.spec.ts               # 基线
src/harness/core/payload-quota-accounting.bugcheck.spec.ts            # 基线
src/session/run-trace-call-window-direction.bugcheck.spec.ts          # BUG-2 + 基线
src/session/run-trace-round-window.bugcheck.spec.ts                   # BUG-3 + BUG-4 + 基线
src/session/run-window-estimate.bugcheck.spec.ts                      # 基线
src/session/util/image-url-annotation-trailing-space.bugcheck.spec.ts # BUG-5 + 基线
src/common/concurrency-failure.bugcheck.spec.ts                       # 基线
```

前端（`desktop/`）：

```
src/utils/trace-display-keyuniqueness.bugcheck.test.ts                # BUG-6 + 基线
src/components/center/run-trace-drawer-containing-block.bugcheck.test.ts  # BUG-7
src/components/center/run-trace-band-tooltip.bugcheck.test.ts         # BUG-9 + 基线
src/stores/session/trace-records-cache.bugcheck.test.ts               # BUG-10 + 基线
```

全部 15 个新测试文件均通过 `tsc --noEmit`（`backend-ts`）/ 类型检查（`desktop` 由 `vitest` 的 esbuild 转译 + `vue-tsc` 构建把关），未引入新的类型错误。

### 运行结果

**修复前（缺陷证据）**：

```
cd backend-ts && npm test
→ Test Files  5 failed | 402 passed | 1 skipped (408)
→ Tests  11 failed | 4813 passed | 14 skipped (4838)
```

```
cd desktop && npx vitest run
→ Test Files  4 failed | 85 passed (89)
→ Tests  6 failed | 793 passed (799)
```

所有失败都集中在上述 5 个后端 / 4 个前端 bugcheck 文件，且失败断言全部是「应有的正确行为」——即缺陷证据。

**修复后（0.0.337，全部转绿）**：

```
cd backend-ts && npm test
→ Test Files  407 passed | 1 skipped (408)
→ Tests  4826 passed | 14 skipped (4840)
```

```
cd desktop && npx vitest run
→ Test Files  89 passed (89)
→ Tests  799 passed (799)
```

另跑通：`cd backend-ts && npm run build`（tsc）、`cd desktop && npm run build`（vue-tsc + vite）。

单个文件运行：`cd backend-ts && npx vitest run <spec路径>`；`cd desktop && npx vitest run <路径>`。

---

## 五、修复优先级建议

> 以下为**审查当时**的优先级判断（修复前的决策输入）。实际执行按 P0 → P1 → P2 → P3 顺序全部完成，落地顺序为 BUG-1 → BUG-2/3/4（同源合批）→ BUG-5 → BUG-8 → BUG-6 → BUG-7 → BUG-9（含 L-1）→ BUG-10，全部随 0.0.337 提交。

| 优先级 | 项 | 理由 |
|---|---|---|
| **P0** | BUG-2 | 唯一「核心功能在生产数据上恒不工作」的方向性错误；同时会误导后续所有基于抽屉的排障。修复必须同步补 `C < A < T` 的回归用例 |
| **P0** | BUG-1 | 可复现的写侧体积反升（1.2~2.1 倍），与本次阈值调整直接因果相关，且变大的 data URI 会永久落库 |
| **P1** | BUG-3 | 与 BUG-2 同源，一并处理（上界改排他 / 改 id 区间） |
| **P1** | BUG-5 | 编辑往返翻倍会污染 LLM 上下文与气泡展示；前后端两处正则必须同步改 |
| **P1** | BUG-6 | 静默破坏核心交互（点击色条定位指错行 + Vue 重复 key），修复面小 |
| **P2** | BUG-7 | 一行 CSS（`.run-trace-panel { position: relative }`）即可回到设计意图 |
| **P2** | BUG-8 | 上游字段静默丢丢弃，改为展开传参 |
| **P2** | BUG-4 | 时间窗下推 SQL，大会话点抽屉有明显延迟 |
| **P3** | BUG-10 | 加容量上限（可顺手在 `clearTrace` 里一并清） |
| **P3** | BUG-9 | 一行（`showTip` 开头 `tip.value = null`），建议与 L-1 的 `onUnmounted` 同批带上 |

### 跨 bug 的共性根因

三个缺陷（BUG-2 / BUG-3 / BUG-5）表面落在「读模型时间窗」「归属窗口闭区间」「剥离正则」三处，根因模式相同：**单测 fixture 与生产时序 / 生产数据形态不一致，导致方向性错误被测试掩盖**。修复时请优先核对 fixture 是否真实反映生产，而不是只让新代码通过旧 fixture。
