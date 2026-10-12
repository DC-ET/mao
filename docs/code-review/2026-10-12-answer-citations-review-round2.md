# 回复引用溯源（answer-citations）未提交改动代码审查 — Round 2

- **日期**：2026-10-12
- **工作区**：`/Users/yangjiayi/AiProjects/mao/.worktrees/answer-citations`（分支 `feat/answer-citations`），审查对象仍为 `git status` 中的全部功能逻辑改动（文档类改动：CHANGELOG / README / skills 文档按要求忽略）。
- **背景**：Round 1 报告的 5 个 bug（BUG-1 ~ BUG-5）已全部修复，本轮为复审。
- **方法**：逐行复核 5 个修复的实现与 marked v18.0.4 真实源码语义（`node_modules/marked/lib/marked.esm.js`）；复核全部新增/变更测试是否存在恒真断言；对时序修复做全触发路径审计（`session_status` 终态发送方逐一枚举）；对仍消费「原始 ASSISTANT 正文」的出口做全量扫描并补探针实跑验证。探针用完即删，**未删除 node_modules 内任何包**（桌面 vitest 需要的 `desktop/node_modules/jsdom` 符号链接保留）。
- **基线健康度**：探针删除后复跑相关 spec —— `backend-ts` 4 个 citation 相关 spec（`task-terminal.service` / `citation-markers` / `message-citations` / `card-progress-listener`）**80 passed**；`desktop` 4 个相关 spec（`useMarkdown.citations` / `MessageBubble.citations` / `citationMarkers` / `chatMessage`）**35 passed**。用户实跑全量：backend 292 files / 3637 tests、desktop 58 files / 503 tests 全绿，`vue-tsc -b --force` + `vite build` 通过；`desktop/electron/*.test.cjs` 2 例为主工作区同样失败的环境问题，不计回归。
- **结论**：**5 个修复全部真正解决，无新回归；新测试未发现恒真断言；时序修复在全部触发路径成立。** 但新发现 **2 个 bug（BUG-A / BUG-B，均为中危）**：本次新增的 `[^n^]` 标记会从两条**未纳入本次 diff 的渠道出口**原样泄漏给终端用户（崩溃恢复的飞书/钉钉终态卡片、定时任务的微信/飞书结果推送）。两者均已用探针实跑复现。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-A | 中 | backend/crash-recovery + feishu card | 崩溃恢复续跑成功后，`CrashRecoveryRunner.latestAssistantReply()` 取**未剥离**的 ASSISTANT 原文喂给 `extra.complete()`，`FeishuCardProgressListener.complete()` 也不剥（只有 `displayContent()` 剥）→ 飞书/钉钉终态卡片正文露出 `[^1^]` |
| BUG-B | 中 | backend/schedule | 定时任务完成后 `sendWeixinReplyIfApplicable()` / `sendFeishuReplyIfApplicable()` 各自内联取最后一条 ASSISTANT **原文**推送（含 webhook 降级路径），未走 `channelAssistantReply` → 微信消息与飞书结果卡片露出 `[^1^]` |

次要观察 6 条（不构成 bug，见文末）：含用户点名问的 `mergeCitationsMetadata` 非对象 JSON 缺口的处置建议。

---

## 一、五个修复的复核结论（全部成立）

### BUG-1【已修复】renderer 方法改用 `parseInline.call(this, ...)`

`desktop/src/composables/useMarkdown.ts:47-50`：

```ts
function parseInline(this: unknown, tokens: unknown[]): string {
  const self = this as { parser?: { parseInline(t: unknown[]): string } }
  return self.parser!.parseInline(tokens)
}
```

对照 marked v18.0.4 源码（`marked.esm.js`，`Renderer` 类）：

```js
text(e){return "tokens" in e && e.tokens ? this.parser.parseInline(e.tokens) : "escaped" in e && e.escaped ? e.text : O(e.text)}
```

renderer 方法在 marked 内部以 `Renderer` 实例为 `this` 调用，`parse` 前 marked 会把 `parser` 挂到该实例上——修复后的写法与 marked 默认 renderer 完全同源，`Marked` 实例自身没有 `parser.parseInline` 的问题已消除。**带子 token 的 text（紧凑列表/有序列表/任务列表/嵌套列表）恢复走 `parseInline`，嵌套加粗/链接/标记均能正常渲染。**

一个比 marked 默认更稳的细节：默认是 `"tokens" in e && e.tokens`（空数组 `[]` 在 JS 中为 truthy，会走到 `parseInline([])` 把正文吞成空串），修复版用 `token.tokens.length > 0` 前置判断，空数组时回落到转义+标记替换，正文不丢。

### BUG-2【已修复】新增 `escapeText`，与 marked 默认实体感知转义逐字节一致

`desktop/src/composables/useMarkdown.ts:24-27`。与 marked v18.0.4 内置常量对照：

| | 正则 | 映射表 |
| --- | --- | --- |
| marked `escapeReplaceNoEncode` | `/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g` | `{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}` |
| 修复版 `escapeText` | `/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g` | `ESCAPE_MAP` 同上 |

**正则与映射表均逐字节相同**，即 `text` renderer 的转义语义与 marked 默认 `O(e.text)` 完全一致，`&amp;` / `&copy;` / `&#39;` 等既有实体不再被二次转义，裸 `< > & " '` 仍被转义。

职责划分也正确：`escapeHtml`（全量转义）只保留给 `html` renderer、链接 `href`、代码块头部语言名——这些位置确实需要全量转义。

### BUG-3【已修复】`openCitation` 改走 `openExternalUrl`

`desktop/src/components/chat/MessageBubble.vue:500-501` + `import { openExternalUrl } from '../../utils/capacitor'`（:271）。Round 1 探针已验证 `openExternalUrl` 在 Capacitor 原生环境下到达 `OpenUrl` 插件（`window.open` 不到）。修复正确。

### BUG-4【已修复】`buildCitations` 内联 `await`，位于全部终态 WS 事件之前

`backend-ts/src/session/task-terminal.service.ts`，`finishExecution` 内的实际顺序：

```
:104  getSession / 终态幂等短路
:107  updateRuntimeStatus
:112  updatePhase(sessionId, phase)
:115  registry.clearSessionExecution
:116  markLastMessageFinished
:118  getSession（取 ownerId）
:127  await this.buildCitations(session, phase)   ← citations 落库点
:138  prepareDelivery
:140-153  session_list_update / session_status(终态) / delivery 解析
:158  recordInbox / dispatchOutboundEvent / settleBudgetWarn
:162  treeSignalPublisher.publish(AtRoot)
:168  dispatchMemoryExtraction（仍在最后，fire-and-forget 不变）
```

`buildCitations`（:176-186）仅 `COMPLETED` 构建、`builder == null || sessionId == null` 短路、try-catch 全吞并 `console.warn`——失败只表现为「这轮没有来源区」，不影响任务完成事件链。**不筛 `sessionType`** 的取舍正确：主会话 / 边路 / 子代理各自独立构建、天然隔离（子代理的 citations 只挂子会话消息，不会串到父会话）。

### BUG-5【已修复】链接 renderer 在 `token.tokens` 非空时走 `parseInline`

`desktop/src/composables/useMarkdown.ts:84-96`。链接文本内的 `[^n^]` 现在能到达 `text` renderer 转成上标；`token.tokens` 为空时回落 `escapeHtml(token.text)`，与 marked 默认 `link` 的行为一致。危险协议（`javascript:` 等）降级为纯文本的分支保留，且降级后链接文本内的标记照常处理。

---

## 二、新测试质量复核（未发现恒真断言）

逐例核对了「若修复被回退，该用例是否必然失败」：

### backend-ts

| 文件 | 用例 | 是否真锁住行为 |
| --- | --- | --- |
| `task-terminal.service.spec.ts` | COMPLETED 主会话构建一次且带 sessionId | 是（旧代码不传 citationRegistry / 不调用即失败） |
| | FAILED / CANCELLED 不构建 | 是 |
| | SIDE_TASK / SUBAGENT 同样构建 | 是 |
| | `buildForSession` 异步 reject 被吞、`finishExecution` 正常 resolve | 是（旧 fire-and-forget 下 reject 会变成 unhandled rejection，断言形态也不同） |
| | `buildForSession` 同步抛错被吞 | 是 |
| | **时序**：`buildForSession` 延时 5ms，断言 `order.indexOf('citation:build') < order.indexOf('ws:session_status')` | 是，且是本轮最有价值的用例——旧 fire-and-forget 写法下 `session_status` 必先入队，该断言必失败 |
| `util/citation-markers.spec.ts` | strip / extract 边界（跳号、乱序、重复、脚注语法不匹配、越界如实返回） | 是 |
| | `channelAssistantReply` 6 例：null/undefined 回落、TOOL/USER 不抢占、`content: null` → `''` | 是（三处渠道入口共用函数的回归网） |
| `session/message-citations.spec.ts` | registry 构建、白名单过滤、去重、`mergeCitationsMetadata` 保留既有键 | 是 |
| `feishu/card-progress-listener.spec.ts` | 流式卡片 `displayContent()` 剥离标记 | 是 |

### desktop

`useMarkdown.citations.test.ts` 10 例（node 环境直测 marked 层，文件头已说明为何不跑 DOMPurify 全链路）：

| 用例 | 回退到修复前是否失败 |
| --- | --- |
| 紧凑/有序/任务/嵌套列表正常渲染 | 是（旧代码 `marked.parser.parseInline` 直接 TypeError） |
| 列表项内 `[^n^]` 转上标 | 是 |
| HTML 实体不二次转义（`&amp;amp;` / `&amp;copy;` 负向断言） | 是（旧 `escapeHtml` 必双转义） |
| 裸 `< > &` 仍被转义 | 是（防止「实体感知」被实现成「放过所有 `&`」的双向断言，非恒真） |
| 无 citeMap 时剥掉且 `toBe('<p>结论。</p>')` 精确相等 | 是 |
| 越界/未映射剥掉、命中仍转上标（精确相等） | 是 |
| 链接文本内标记转上标 | 是（BUG-5 回归） |
| 链接在标记外时链接不受影响 | 是 |
| `javascript:` 降级且其中标记照常处理 | 是 |
| 行内代码/代码块内标记保持字面量 | 是 |

`MessageBubble.citations.test.ts` / `citationMarkers.test.ts` / `chatMessage.test.ts`（`extractCitationsFromMetadata` 的形态校验、排序去重）同为真断言。

### 覆盖盲区（不阻塞，记录备查）

1. 桌面 vitest 为 `environment: 'node'`，`renderMarkdown` 依赖 `document`/DOMPurify，**「marked → DOMPurify 消毒」全链路没有自动化覆盖**；`sup` + `class` + `data-cite` 能否穿过 DOMPurify 目前只有手工验证。作者已在测试文件头注明此限制。若想补，可在该 spec 加 `// @vitest-environment jsdom`（本机已具备 jsdom 依赖条件）。
2. 时序用例只断言「citations 早于 `session_status`」，未断言「citations 是 `order[0]`」。实际 `session_list_update` 也在其后，语义已覆盖；属可加强项而非缺陷。
3. `desktop/electron/*.test.cjs` 2 例失败为主工作区同样失败的环境问题，与本次改动无关。

---

## 三、时序修复在所有触发路径的成立性

审计方式：枚举全部 `wsEvent('session_status', ...)` 发送方，确认终态 phase 只可能从一处发出。

| 发送方 | 发出的 phase | 是否在 citations 之后 |
| --- | --- | --- |
| `session/task-terminal.service.ts:141`（`finishExecution` 内） | COMPLETED / FAILED / CANCELLED（终态） | —— 即 citations 落库点本身，:127 早于 :141 |
| `harness/core/crash-recovery-runner.ts:457`（`notifyClient`） | 仅 RUNNING（终态走 `finishExecution`） | 不涉终态 |
| `harness/approval/approval-registry.ts:83` | WAITING_APPROVAL / RUNNING | 不涉终态 |
| `harness/delegate/subagent-visibility-service.ts:141,161` | RUNNING；:161 仅在 `finishExecution` **自身抛异常**的兜底里补发终态 | 见下 |
| `dingtalk/agent-inbound-handler.ts:562`、`feishu/agent-inbound-handler.ts:837`、`weixin/agent-inbound-handler.ts:188`、`session/ws/streaming-ws-handler.ts:696,1120,1273,1334` | RUNNING / RESUMING / CANCELLING | 不涉终态 |

触发源 → 终态收敛点逐条核对（**全部收敛于 `finishExecution`，时序均成立**）：

| 触发源 | 代码位置 | 收敛点 |
| --- | --- | --- |
| 桌面 WS 手动发送 / 停止 | `streaming-ws-handler.ts` | `finishExecution` |
| 定时任务（SCHEDULED） | `schedule/scheduled-task.service.ts:721-723`（无 liveExecution 的兜底路径显式传 `'SCHEDULED'`） | `finishExecution` |
| 定时任务（liveExecution 路径） | `finishExecution` 由 TaskTerminal 侧触发 | `finishExecution` |
| 飞书入站（含队列接力、重试） | `feishu/agent-inbound-handler.ts` → `onExecutionFinished` | `finishExecution` |
| 钉钉入站（含队列接力、重试） | `dingtalk/agent-inbound-handler.ts` → `onExecutionFinished` | `finishExecution` |
| 微信入站 | `weixin/agent-inbound-handler.ts:211` | `finishExecution` |
| 开放接口（openapi） | `openapi/open-run.service.ts:166`（兜底路径） | `finishExecution` |
| 崩溃恢复续跑 | `crash-recovery-runner.ts:413-416`（COMPLETED / CANCELLED）、:435-437（FAILED） | `finishExecution` |
| 子代理（可见） | `subagent-visibility-service.ts:131` `finishSubagent` | `finishExecution` |
| 边路 Side Task（含深层） | `finishExecution` 内 `treeSignalPublisher.publishAtRoot` | `finishExecution` |

唯一「绕过」点是 `subagent-visibility-service.ts:139-146`：`finishExecution` 自身抛异常时，兜底 `updatePhase` + 直接发 `session_status`。此时 DB 已故障，citations 本就写不进去，该兜底不让用户卡在「执行中」是正确取舍，**不构成缺陷**。

**附带确认**：`markLastMessageFinished`（:116）早于 citations 落库（:127）无副作用——桌面端对消息列表的重拉由终态事件触发，citations 的 `UPDATE message SET metadata` 只改 metadata 列（`session.repository.ts:759-762` 专用 `updateMetadata`，不会全字段覆写 content），重拉读到的一定是含 citations 的版本。

---

## 四、新发现 bug（均已探针实跑复现，探针已删除）

两条 bug 的共同根因：本次改动把 `[^n^]` 标记写进了**落库的 ASSISTANT 正文**，并改造了已知的渠道出口（create-app / dingtalk runtime / weixin handler 的 `getLatestAssistantReply`、飞书卡 `displayContent()`），但有两条消费 ASSISTANT 正文的出口在**未纳入本次 diff 的文件**里，仍按原文发出。

### BUG-A【中】崩溃恢复续跑成功后，飞书/钉钉终态卡片露出 `[^n^]`

**位置**

- `backend-ts/src/harness/core/crash-recovery-runner.ts:418`

```ts
try { await extra?.complete?.(await this.latestAssistantReply(sessionId)); } catch (e) { ... }
```

- `backend-ts/src/harness/core/crash-recovery-runner.ts:462-471`：`latestAssistantReply()` 直接取最后一条 ASSISTANT 的 `extractVisibleText(content)`，**不调用 `stripCitationMarkers`**。
- `backend-ts/src/feishu/card-progress-listener.ts:95-98`：`complete(finalContent)` 直接 `updateTerminal('COMPLETED', …, trimCardText(finalContent), [])`，**不剥离**（同文件 `displayContent():120-123` 才剥，注释亦自证「渠道卡片不渲染来源区，[^n^] 标记在此统一剥掉」——但终态 `complete` 路径漏了）。
- 装配：`create-app.ts:2896-2901` 的 `createExtraListeners` 对飞书/钉钉会话返回 `FeishuCardProgressListener`，崩溃恢复续跑即经此更新卡片。

**影响**：飞书/钉钉会话在进程崩溃（蓝绿发布 / 重启）后续跑成功时，用户收到的「已完成」终态卡片正文里出现 `截止 11 月 30 日[^1^]，详见通知[^2^]。` 这类没渲染干净的标记字样。正常运行路径不受影响（走 `getLatestAssistantReply` → `channelAssistantReply`，已剥）。

**探针实跑（`zz-recovery-cite-probe.spec.ts`，已删除）**

```
R1 complete calls = [["截止 11 月 30 日[^1^]，详见通知[^2^]。"]]      ← 崩溃恢复把含标记的原文交给 extra.complete
R2 card content = ["截止 11 月 30 日[^1^]，详见通知[^2^]。"]          ← FeishuCardProgressListener.complete 本身也不剥
```

**修复方向（二选一，建议 a）**

a. `card-progress-listener.ts` 的 `complete()` 内对入参 `stripCitationMarkers` 后再 `trimCardText`（与 `displayContent()` 同口径，单点收口，所有调用方受益）。
b. `crash-recovery-runner.ts` 的 `latestAssistantReply()` 复用 `channelAssistantReply(messages, '任务已完成。')`（与该文件已有的兜底文案对齐）。

### BUG-B【中】定时任务结果推送到微信/飞书时露出 `[^n^]`

**位置**

- `backend-ts/src/schedule/scheduled-task.service.ts:932-980` `sendWeixinReplyIfApplicable()`：:944-950 内联循环取最后一条 ASSISTANT 的 `content` 原文，:970 `weixinSendService.sendText(...)`、:973/:978 `pushWeixinWebhookFallback(userId, reply)`（钉钉/飞书 webhook 降级）发的都是**未剥离**的原文。
- `backend-ts/src/schedule/scheduled-task.service.ts:1019-1038` `sendFeishuReplyIfApplicable()`：同样内联取原文，交给 `feishuResultPusher` → `create-app.ts:2092-2118` 的 `buildFeishuProgressCard('COMPLETED', …, text, …)`。
- 调用点：`scheduled-task.service.ts:727-728`（任务完成后）。

**影响**：定时任务（含微信 24h 窗口关闭后的 webhook 降级推送）推给用户的最终回复里出现 `[^1^]` / `[^2^]` 字样。定时任务是「用户长时间不在场」的异步场景，泄漏比实时会话更显眼。

**探针实跑（`zz-sched-cite-probe.spec.ts`，已删除）**

```
S1 sendText calls = [["acc","wx1","截止 11 月 30 日[^1^]，详见通知[^2^]。"]]   ← 微信 sendText 收到未剥离原文
S2 pushed = [{"sessionId":12,"text":"截止 11 月 30 日[^1^]，详见通知[^2^]。"}]  ← 飞书结果卡片 pusher 收到未剥离原文
S3 => 截止 11 月 30 日，详见通知。                                            ← 对照：同源内容经 channelAssistantReply 会被正确剥离
```

（S3 为对照组，证明工具函数本身无误，问题只在两处内联实现没复用它。）

**修复方向**：两处都改调 `channelAssistantReply(messages, '抱歉，暂时无法生成回复。')`（与 create-app / dingtalk runtime / weixin handler 完全同口径，兜底文案也与微信入口一致）。注意 `sendWeixinReplyIfApplicable` 的 `reply` 在 catch 里还要用于 webhook 降级，改造时保持「reply 提升到 try 外」的现有结构即可。

---

## 五、次要观察（均不构成 bug，未改；含用户点名项）

1. **`mergeCitationsMetadata` 遇非对象 JSON 丢键 —— 结论：现状已安全，不建议改。** `backend-ts/src/session/message-citations.ts:26-36` 的 `parseJson` 已把「非对象 / 数组 / null」一律返回 `null`，因此 `mergeCitationsMetadata`（:104-112）遇到非对象 JSON 时行为是「丢弃既有键、只写 citations」，**不会抛 TypeError、也不会产出 `{"0":1,"citations":…}` 这类污染结构**；citations 仍能正常落库。而 ASSISTANT 行的 metadata 实际只由本方代码写（null 或对象，如钉钉队列 id）。也就是说这条「防御缺口」的最坏结果与最好结果一致，加类型收窄没有实际收益。若 purely 为了可读性，最多在 `mergeCitationsMetadata` 上补一行注释说明「非对象 JSON 一律视为无既有键」，不必加分支。
2. **`buildForSession` 的查询次序可优化**（`message-citations.ts:123-126`）：先 `getRawMessages()` 全量拉会话消息，**之后**才 `extractCitationMarkers(finalMessage.content)` 判断有没有标记。绝大多数已完成会话没有标记，却都付了一次全量消息查询。建议把标记提取提前到 `getRawMessages` 之前做早退，长会话收益明显。纯性能，非正确性问题。
3. **registry 范围与提示词「本轮」口径在续跑场景下可能不一致**（设计期既有口径，非本次回归）：registry 取「最后一条 USER 消息之后」的全部 TOOL 消息，而 `prompt-engine.ts` 的 `CITATION_CONTRACT` 要求模型「只引用本轮工具获取的来源」。单条 USER 消息触发多轮工具循环时两者一致；但**崩溃恢复续跑**（`harnessService.execute(sessionId, null, …)`，不新增 USER 消息）时，registry 会把崩溃前那轮的来源也算进编号，模型按提示只引用续跑轮来源就会编号偏移。触发条件苛刻（崩溃 + 联网引用 + 恢复后继续引用），且已有白名单校验兜底不会挂错站，记录备查即可。
4. **点踩经验提炼会把含标记的原文喂给 LLM**（`feedback/feedback.service.ts:382` `loadAssistantText` → `experience-draft.service.ts` 的起草提示词）。用户不可见，但 `[^n^]` 会进 LLM 上下文、可能被复述进提炼出的经验条目。建议在 `loadAssistantText` 后顺手 `stripCitationMarkers`，一行了事。
5. **后台子代理 `recentOutput` 含标记**（`harness/delegate/background-subagent-manager.ts:432-451`）：仅经 `check_subagent` 工具结果回给主代理 LLM；`ToolResultSummarizer.summarizeCheckSubagent`（`session/util/tool-result-summarizer.ts:589-603`）不展示该字段，桌面端无露出面。可不动。
6. **内联 await 的代价**：`finishExecution` 终态路径多几次索引查询（仅 COMPLETED、且仅在有标记时才写库；无标记时一次 `findLastAssistantMessage` + 一次 `getRawMessages` 后早退）。相对「首屏静默丢来源区且不自愈」的代价，这个取舍正确，调用点注释也已写清。配合观察 2 的早退优化可进一步降耗。

---

## 六、工作区状态

- 探针 `backend-ts/src/schedule/zz-sched-cite-probe.spec.ts`、`backend-ts/src/harness/core/zz-recovery-cite-probe.spec.ts` **已删除**；`git status` 恢复为原始改动集 + 本报告文件，无其它残留。
- **未删除 node_modules 内任何包**。桌面侧 jsdom 只是 `@vitest/browser` 的可选 peer（`desktop/package-lock.json` 中标为 optional、本就未安装），本次审查全程没有安装/删除桌面依赖；`backend-ts/node_modules/jsdom` 保持 Round 1 后用户重装后的原状。
- 探针删除后复跑：backend 4 个 citation 相关 spec 80 passed；desktop 4 个相关 spec 35 passed。
