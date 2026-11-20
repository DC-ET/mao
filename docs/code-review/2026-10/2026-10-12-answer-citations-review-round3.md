# 回复引用溯源（answer-citations）未提交改动代码审查 — Round 3

- **日期**：2026-10-12
- **工作区**：`/Users/yangjiayi/AiProjects/mao/.worktrees/answer-citations`（分支 `feat/answer-citations`）。只审功能逻辑，忽略文档类改动。
- **背景**：Round 2 的 BUG-A（崩溃恢复渠道卡片露 `[^n^]`）/ BUG-B（定时任务渠道推送露 `[^n^]`）已按报告方向修复，另顺带处理了两条次要观察（`buildForSession` 查询早退、点踩经验喂 LLM 前剥标）。本轮为复审。
- **方法**：① 逐行复核 4 处修复与 4 个新测试；② 对 4 个新测试做**变异测试**（逐条把修复回退，验证对应用例是否失败、是否只失败那一条）；③ 对 `buildForSession` 早退重排做行为等价性证明；④ 全库扫描 `[^n^]` / `stripCitationMarkers` / `channelAssistantReply` / ASSISTANT 正文消费面，找出所有「不渲染来源区却原样露出标记」的出口，对可疑出口补探针实跑。探针用完即删，**未动 node_modules**。
- **基线健康度**：探针删除后复跑相关 spec —— `crash-recovery-runner` 29 passed、`card-progress-listener` 16 passed、`scheduled-task.service` 43 passed、`message-citations` 20 passed、`citation-markers` 18 passed、`feedback.spec` + `experience-draft.service` 54 passed；`tsc -p tsconfig.build.json`（= `npm run build`）通过。用户实跑全量：292 files / 3641 tests 全绿、desktop 58 files / 503 tests 全绿。
- **结论**：**BUG-A / BUG-B 修复正确、无新回归；4 个新测试全部非恒真（变异测试逐条验证）；早退重排行为完全等价。** 但全库扫描又发现 **3 个同根因的新泄漏点**：搜索命中片段（桌面 + 管理后台，中）、复制消息（低）、管理后台会话详情渲染（低）。三者均已探针实跑复现，探针已删除。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-C | 中 | backend/session 搜索 + desktop/admin 展示 | 会话搜索的「命中消息片段」不过滤 `[^n^]`：桌面 `SessionSearchPopover` 与管理后台会话列表把 ASSISTANT 片段当**纯文本**渲染，关键词命中带标记的回复时，片段里原样出现 `截止 11 月 30 日[^1^]，详见通知[^2^]。` |
| BUG-D | 低 | desktop/MessageBubble | 复制消息只走 `stripInternalMarkers`（剥 `${skill}$`/`#{cmd}#`/`@{file}@`），不剥 `[^n^]` → 用户复制回复，剪贴板里带上标记字样 |
| BUG-E | 低 | admin/会话详情 | admin 自己的 `useMarkdown`（`admin/src/views/session/composables/useMarkdown.ts`）没有任何 citation 处理，marked 把 `[^1^]` 当普通文本 → 运维在会话详情里看到原样标记 |

次要观察 4 条见文末（含早退优化缺测试锁定、记忆抽取入参仍带标记等）。

---

## 一、BUG-A / BUG-B 修复复核（均真正解决，无新回归）

### BUG-A 修复（双保险，两层都正确）

1. `harness/core/crash-recovery-runner.ts:466-473`：`latestAssistantReply()` 在返回前 `stripCitationMarkers(text)`，与正常终态的 `getLatestAssistantReply`（`channelAssistantReply`）同口径。该方法全类仅一处调用（:419 `extra?.complete(...)`），改动影响面封闭。
2. `feishu/card-progress-listener.ts:95-100`：`complete(finalContent)` 改为 `trimCardText(stripCitationMarkers(finalContent))`，与 `displayContent()`（:120-124）同口径。

**「双剥是否影响正常路径」——不影响，三点论证**：

- `stripCitationMarkers` 对不含标记的文本是恒等变换（`text.replace(regex, '')`，无匹配即原样返回），正常路径入参（`getLatestAssistantReply` 产物）已剥过，二次剥离是幂等 no-op。
- 4 个 `cardListener.complete(text)` 调用方（`dingtalk/agent-inbound-handler.ts:304,347`、`feishu/agent-inbound-handler.ts:287,661`）的 `text` 全部来自 `getLatestAssistantReply`，本就已剥。
- 顺序变化（先剥后截断）只会让「有标记时可见正文变长」（标记不占 `CARD_TEXT_MAX` 额度），是期望行为；`trimCardText` 的入参类型仍是 `string`，`stripCitationMarkers(null)` 会返回 `null` 再进 `trimCardText` 抛错——但**旧代码同样会抛**（`trimCardText(null)`），失败模式一致，非回归。

### BUG-B 修复（两处都正确）

`scheduled-task.service.ts:947`（微信，`reply` 仍提升在 try 外，catch 里的 webhook 降级路径结构未动）与 `:1023`（飞书 pusher）都改为 `channelAssistantReply(messages, '抱歉，暂时无法生成回复。')`。类型上 `Message[]` 满足 `ChannelReplyMessage` 结构（`build` 已过）。

**兜底文案在两条定时任务路径是否合适 —— 结论：合适，可保留现状。** 三点评估：

1. **口径一致**：与微信入口（`weixin/agent-inbound-handler.ts:503`）、飞书/钉钉入口（`create-app.ts:1906`、`dingtalk/runtime.ts:242`）用的是同一个 helper、同一句兜底，定时任务与交互式入口对「取不到回复」的用户可见表述统一。
2. **行为有细微变化但无害**：旧代码在「会话里没有任何 ASSISTANT 行」时 `reply` 保持 null → `if (!reply) return` 静默跳过；新代码会推一条「抱歉，暂时无法生成回复。」。该分支在 COMPLETED 成功路径下几乎不可达——`harness-service.ts:143-149` 的 `persistFinalAssistant` 对无工具调用的轮次**无条件落库** ASSISTANT 行（content 为空也落），而两个推送调用点（:727-729）只在成功路径执行、FAILED/CANCELLED 已在 :700-710 早退。真出现「无 ASSISTANT 行却 COMPLETED」时，推一条歉意也优于静默。
3. 空 content 的 ASSISTANT 行行为未变：新旧都得到 `''` → `!reply` → 跳过。

### 顺带处理的两条次要观察（均正确）

- `message-citations.ts:126-128`：标记提取提前到 `getRawMessages()` 之前，无标记直接早退。见第三节等价性证明。
- `feedback.service.ts:383`：`truncateStoredText(stripCitationMarkers(message ?? ''), …)`。`stripCitationMarkers('')` 返回 `''`，`truncateStoredText` 对空串与 null 的处理一致（`extractStoredText` → `truncate`），无行为变化；该文本只喂经验提炼 LLM，用户不可见。

---

## 二、4 个新测试全部非恒真（变异测试逐条验证）

方法：把对应修复**逐条回退**（一次只回退一条），跑整个 spec 文件，观察失败用例。

| 变异（回退的修复） | 结果 | 结论 |
| --- | --- | --- |
| `card-progress-listener.ts` `complete()` 去掉 `stripCitationMarkers` | `Tests 1 failed \| 15 passed`，失败用例正是 `strips citation markers from the terminal complete() payload too` | 真锁住 |
| `crash-recovery-runner.ts` `latestAssistantReply` 去掉剥标 | `Tests 1 failed \| 28 passed`，失败用例正是 `successfulRecoveryStripsCitationMarkersBeforeNotifyingExtraComplete` | 真锁住 |
| `scheduled-task.service.ts` 微信处回退为内联循环 | `Tests 1 failed \| 42 passed`，失败用例正是 `微信回复：剥离 [^n^] 引用标记后再发送` | 真锁住 |
| `scheduled-task.service.ts` 飞书处回退为内联循环 | `Tests 1 failed \| 42 passed`，失败用例正是 `飞书结果回流：剥离 [^n^] 引用标记后再推送` | 真锁住 |

四条变异都只失败「该修复对应的那一条」，无连带失败——即断言精确锁定了行为，不是顺带通过的宽断言。另外两条设计优点：

- **两层修复各自独立被锁**：只回退 crash-recovery 层时，卡片层的兜底仍会让内容干净，但 crash-recovery 用例断言的是「`complete` 收到的入参已剥」，所以照样失败——双保险没有互相掩盖。
- 微信用例复用既有 `executeTask` 全流程骨架（`agentExecutor` 捕获 + `await ran`），且**没有**注入 `weixinInboundRepository`（`isWeixinInboundWindowOpen` 在 repo 为 null 时返回 true），与既有两个微信用例同构，不是为过测试而裁剪的假路径。

变异后已用备份逐字节还原，`git diff` 与修复后状态完全一致（见第七节）。

---

## 三、早退重排后 `buildForSession` 行为完全等价

改动：`extractCitationMarkers(finalMessage.content)` 从「建完 registry 之后」提到「`getRawMessages()` 之前」，无标记直接 return。

**等价性证明**：

1. `extractCitationMarkers` 是纯函数（新建正则 + `matchAll`，无副作用、无 IO），同一入参 `finalMessage.content` 在同一位置（`findLastAssistantMessage` 之后、任何 DB 写之前）求值，结果与旧顺序逐字节相同。
2. 有标记时：后续流程（`getRawMessages` → `lastUserId` → `buildToolNameIndex` → registry → `citedNs` 白名单 → `updateMessageMetadata`）一行未动，输入相同 → 输出相同。
3. 无标记时：旧顺序照建 registry 后 `citedNs.length === 0` 也 return，**可观察行为（不写 metadata）完全相同**；唯一差异是少发一次 `getRawMessages` 全量查询——这正是优化目的。
4. 唯一的次要差异：旧顺序下 `getRawMessages` 抛 DB 错误会被 `TaskTerminalService.buildCitations` 的 try-catch 记一条 `console.warn`；新顺序在该分支不再查询、也不再报警。citations 两种顺序下都不会写，属于**减少失败面**，非回归。

实证：`message-citations.spec.ts` 20 个用例（含 `无任何标记时不写库`、`最终回复不存在或正文为空时不写库`、registry 边界/去重/截断/轮次范围）全绿。

**一个测试缺口（不阻塞）**：早退优化本身没有被测试锁定——现有 `无任何标记时不写库` 只断言「不写 metadata」，不断言「没调 `getRawMessages`」。若有人把顺序改回去，全部测试依旧通过。建议后续在该用例补一句 `expect(h.sessionService.getRawMessages).not.toHaveBeenCalled()`（一行，即可锁住优化）。

---

## 四、新发现 3 个泄漏点（均已探针实跑复现，探针已删除）

全库扫描结论：所有「把 ASSISTANT 正文送到不渲染来源区的出口」中，Round 2/3 已修 7 处（create-app / dingtalk runtime / weixin 入口、crash-recovery、飞书卡 `displayContent` + `complete`、定时任务微信 + 飞书、点踩经验），**漏下 3 处**，全部同根因：`[^n^]` 是本次新写进落库正文的语法，而这些消费方在改造时未被覆盖。

### BUG-C【中】会话搜索的命中消息片段原样露出 `[^n^]`

**位置与链路**

- 桌面消息搜索：`backend-ts/src/session/session.service.ts:800-815`（`executeMessageSearch` → `extractVisibleText(hit.content)` → `buildSnippet(...)` → `hits[].snippet`）→ 桌面 `desktop/src/components/search/SessionSearchPopover.vue:91-96` 以**纯文本**渲染（`{{ part.text }}` + 关键词 `<mark>` 高亮）。
- 管理后台会话列表：`session.service.ts:487-503`（`loadAdminMatchSnippets` → `selectFirstMatchingMessages` → 同样的 `extractVisibleText` + `buildSnippet`）→ `admin/src/views/session/SessionListView.vue:69` 与 `:120-122` 以纯文本渲染（`命中消息：{{ row.matchSnippet }}`）。
- `buildSnippet`（`session/message-search.ts:211-235`）是纯切片函数，不剥标记；两条链路都没有过 `stripCitationMarkers`。

**影响**：用户在桌面搜索任意关键词，只要命中一条带引用的回复，结果片段里就出现 `截止 11 月 30 日[^1^]，详见通知[^2^]。`；管理后台会话列表同理。搜索是高频入口，观感上就是「没渲染干净的模板变量」。

**探针实跑（`zz-search-cite-probe.spec.ts`，已删除；复用 `session.service.spec.ts` 的 `hit/prime` 同构 stub）**

```
S1 snippet = "截止时间是 11 月 30 日[^1^]，详见通知[^2^]。"   ← 桌面 searchMessages，ASSISTANT 命中
S2 snippet = "截止时间是 11 月 30 日[^1^]，详见通知[^2^]。"   ← 管理后台 listSessionsForAdmin
S3 => 截止时间是 11 月 30 日，详见通知。                      ← 对照组：stripCitationMarkers 本身无误
```

**修复方向**：两条链路在 `buildSnippet` 之前对 `text` 做 `stripCitationMarkers`（后端单点改 `loadAdminMatchSnippets` 与 `executeMessageSearch` 的取文本处；或提一个小 helper `snippetTextOf(content)` 两处共用）。

### BUG-D【低】复制消息把 `[^n^]` 一起复制走

**位置**：`desktop/src/components/chat/MessageBubble.vue:683-691` `copyMessage()` 取文本逻辑为 `stripInternalMarkers(props.message.content ?? '').trim()`。`stripInternalMarkers`（`desktop/src/utils/internalMarkers.ts`）只处理 `${skill}$` / `#{cmd}#` / `@{file}@` 三种既有内部标记，不认 `[^n^]`。

**影响**：用户点复制拿到的回复文本里带 `[^1^]`，粘贴到外部就是垃圾字样。与 `stripInternalMarkers` 存在的理由（内部标记语法不该进剪贴板）完全同性质，属于本次新语法漏改。

**探针实跑（`zz-copy-cite-probe.test.ts`，已删除）**

```
D1 copied = "截止时间是 11 月 30 日[^1^]，详见通知[^2^]。"   ← stripInternalMarkers 不剥 [^n^]
D2 copyMessage body = async function copyMessage() { … stripInternalMarkers(props.message.content … }（无 stripCitationMarkers / citationMarkers 引用）
D3 => 截止时间是 11 月 30 日，详见通知。                      ← 对照组
```

**修复方向**：复制出口补一层 `stripCitationMarkers`（`copyMessage` 内 `stripCitationMarkers(stripInternalMarkers(content))`，或把 `[^n^]` 并进 `stripInternalMarkers`——后者更单点，但会改变该函数语义，需评估其它调用方 `ChatRoundList.vue:261` 只处理 USER 消息、不受影响）。

### BUG-E【低】管理后台会话详情把 `[^n^]` 当普通文本渲染

**位置**：`admin/src/views/session/composables/useMarkdown.ts` 是 admin 自己的 marked 封装（与桌面 `useMarkdown.ts` 是两份独立实现），**没有任何 citation 处理**（无 `renderCitationMarkers` / `stripCitationMarkers` / `citeMap`）；`admin/src/views/session/components/MessageGroup.vue:41`（过程文本）与 `:53`（`finalReplyHtml = renderMarkdown(finalReply.content)`）用 `v-html` 渲染。

**实证**：用 admin 自己的依赖（marked 18.0.5）直接渲染：

```
marked 输出 = "<p>截止时间是 11 月 30 日[^1^]，详见通知[^2^]。</p>\n"
含原样 [^1^] = true
```

即 admin 侧 marked 把标记当字面文本，运维在会话详情里会看到 `截止 11 月 30 日[^1^]，详见通知[^2^]。`。

**影响评估**：admin 是内部运维视图、不展示来源区，按 BUG-A/B 同款口径（不渲染来源区的出口一律剥标）应剥；严重度评为低是因为只有运维人员可见、且不影响业务数据。**若认为 admin 不在本需求范围，可明确记录为「已知不处理」**，但建议至少在 CHANGELOG / 需求文档里记一笔。

**修复方向**（二选一）：a. admin `renderMarkdown` 增加 `citeMap` 支持并渲染上标（与桌面对齐，工作量较大）；b. admin `renderMarkdown` 渲染前 `stripCitationMarkers`（一行，与渠道同口径）。推荐 b。

---

## 五、次要观察（均不构成 bug，未改）

1. **早退优化没有测试锁定**：见第三节末尾。建议补 `expect(getRawMessages).not.toHaveBeenCalled()`。
2. **记忆抽取入参仍带标记**：`session.repository.ts:749` `selectLastAssistantMessage` 取的最后一条 ASSISTANT 正文（含 `[^n^]`）会进记忆抽取的 LLM 提示词（`memory-extraction.service.ts`）。与已修的点踩经验（观察 4）同性质，但产出是 LLM 生成、不可见，概率性污染；要收口可在抽取服务取文本处剥一层。
3. **后台子代理完成通知的折叠摘要理论上可露标记**：`backgroundNotice.ts` 的 `noticeExcerpt` 是纯文本折叠摘要，但只有 **FAILED/CANCELLED** 通知会在主会话展开（`MessageBubble.vue:24-38`），其正文是失败原因/取消说明，实际不含标记；COMPLETED 通知正文不在主会话渲染（只进子会话，走 markdown）。判定为不可达，记录备查。
4. **`channelAssistantReply` 对多模态 content 不解析**：若 ASSISTANT 行 content 是 JSON 数组（实践中 ASSISTANT 落库都是纯文本，多模态只在 USER 行），剥标后仍是原 JSON 串。新旧行为一致，非回归。

---

## 六、全库 `[^n^]` 出口扫描总表

| 出口 | 渲染/发送方式 | 状态 |
| --- | --- | --- |
| 桌面消息气泡（`MarkdownContent` + `citeMap`） | markdown，标记 → 上标 | ✅ 设计内 |
| 桌面消息气泡（无 citations 兜底） | markdown，标记被剥 | ✅ 设计内 |
| 桌面行内代码/代码块 | 不经 text renderer，保持字面量 | ✅ 设计内 |
| 飞书/钉钉/微信交互入口（`getLatestAssistantReply` ×3） | `channelAssistantReply` 剥标 | ✅ Round 1 |
| 崩溃恢复渠道卡片（`latestAssistantReply`） | 剥标 | ✅ BUG-A 本轮修 |
| 飞书进度卡流式正文（`displayContent`） | 剥标 | ✅ Round 1 |
| 飞书进度卡终态（`complete()`） | 剥标 | ✅ BUG-A 本轮修 |
| 定时任务微信 + webhook 降级 | `channelAssistantReply` 剥标 | ✅ BUG-B 本轮修 |
| 定时任务飞书结果卡 | `channelAssistantReply` 剥标 | ✅ BUG-B 本轮修 |
| 点踩经验提炼入参 | `stripCitationMarkers` | ✅ 本轮顺手修 |
| 桌面消息搜索片段 | **纯文本，未剥** | ❌ BUG-C |
| 管理后台会话列表片段 | **纯文本，未剥** | ❌ BUG-C |
| 桌面复制消息 | **纯文本，未剥** | ❌ BUG-D |
| 管理后台会话详情 | **marked 无 citation 处理** | ❌ BUG-E |
| 收件箱通知 / 系统通知 | 只用标题与失败原因，不含回复正文 | ✅ 无泄漏 |
| 开放接口 webhook（`outbound-subscription`） | payload 只含 sessionId/phase/title | ✅ 无泄漏 |
| 会话标题 / 摘要 | 标题取自飞书群名或首条 USER 消息，非 ASSISTANT 正文 | ✅ 无泄漏 |
| 子代理结果回传 / 后台子代理进度 / 边路上下文摘要 / 记忆抽取 | 喂 LLM，用户不可见 | ✅ 无泄漏（观察 2 备查） |
| WS 流式增量（`WsStreamingEventListener`） | 桌面端 markdown 渲染 | ✅ 设计内 |

---

## 七、工作区状态

- 探针 `backend-ts/src/session/zz-search-cite-probe.spec.ts`、`desktop/src/components/chat/zz-copy-cite-probe.test.ts` **已删除**；变异测试用的 4 个临时回退均已从备份逐字节还原（`git diff` 与修复后状态一致，`npm run build` 通过）。
- **未动 node_modules**（本轮未安装/删除任何包；BUG-E 的 marked 验证直接用 admin 现有依赖跑 `node --input-type=module`，未产生文件）。
- `git status` 与进入本轮时一致：原始改动集 + 三份 round 报告，无其它残留。
