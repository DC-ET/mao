# 飞书入站排队 Web 可见性（一期）代码审查 · round2 复查

- 日期：2026-11-25
- 复查对象：round1 报告 4 项 P2 的修复（`docs/code-review/2026-11/2026-11-25-feishu-inbound-queue-web-visibility-review-round1.md`）
- 复查方式：只读走查修复后的代码 + 实跑 spec（`inbound-queue-view` / `inbound-queue.service` / `session.routes.inbound-queue` / `feishu-cards.queue` 共 50 例；desktop `queue-view` / `chat-a11y` / `chat-shared-actions` / `chatSessionActions` 共 39 例，全绿）+ `vue-tsc -b`（desktop，0 错）+ 用项目自带 `tsx` 直接调用 `buildQueueViewColumns` / `parseQueuePayloadSummary` 复现真实入队形态（下文「实证」均为实跑输出）。**未改任何产品代码**，仅新增本报告。
- **结论：R1-P2-2 / R1-P2-3 / R1-P2-4 已闭合；R1-P2-1 未闭合（主路径仍失效，P1）；另发现 2 项 P2（1 项为本轮新引入的文案缺陷）。**

## 1. 复核结论表

| round1 项 | 结论 | 说明 |
|---|---|---|
| R1-P2-1 `fileCount` | ❌ **未闭合（P1）** | 只补了 `fromParts.text`（`ContentPart[]` 形态），**未统计 message 为 string 的形态**；而「文字 + 文件（无图片）」正是 `composeContent` 返回 string 的主路径，`fileCount` 仍为 0。另引入「两处相加」的重复计数口径 |
| R1-P2-2 折叠 | ✅ 已修复（1 处小文案，P2） | 飞书组折叠预览 + `hiddenInboundCount` 提示生效，「展开」按钮不再是死按钮；本地折叠文案改为只算本地。仅 `localCount === 1` 且合计 > 5 时出现「还有 0 条」 |
| R1-P2-3 状态清理 | ✅ 已修复 | `purgeSessionRuntime()` 三处 delete、`reset()` 三处 `new Map()` 均到位，与既有 key 同批处理 |
| R1-P2-4 回退口径 | ✅ 主诉求已修复（1 处残留，P2） | p2p 前缀不再误剥、p2p 简单引用能取到用户正文、`ContentPart[]` 剥段标记、`[空消息]` 与「无法解析」已区分；仅 p2p **多段落引用**仍切错 |

## 2. 问题详情

### R2-P1-1（P1，round1 R1-P2-1 未闭合）`fileCount` 在主路径仍为 0，且引入重复计数口径

**文件与位置**：`backend-ts/src/feishu/inbound-queue-view.ts:101-115`（关键行 `:114` `fileCount: countFileRefs(fromParts.text) + countFileRefs(rawText)`）
**关联测试缺口**：`backend-ts/src/feishu/inbound-queue-view.spec.ts:62-67` 只覆盖 `message` 为 `ContentPart[]` 的形态

**问题**：`composeContent()`（`agent-inbound-handler.ts:1239-1266`）的返回值有两种形态：

- `media.images.length === 0` → **返回 string**（`body`，文件引用 `@{path}@` 直接拼在这个字符串末尾）——这是「文字 + 文件、无图片」的主路径（`isInboundAttachmentOnly` 只拦纯文件消息，带正文的 post 会正常入队）；
- 有图片 → 返回 `ContentPart[]`，引用在 text part 里。

本轮修复只从 `fromParts.text`（仅 `ContentPart[]` 时非空）+ `context.text`（原始正文，永远不含 `composeContent` 追加的引用）两处统计，**唯独漏掉 message 为 string 的主路径**。

**实证**（`tsx` 调真实函数）：

```
A 文字+文件(string)   summary="看下这个文件" fileCount=0  (期望 1)   ← 主路径仍失效
B 文字+图片+文件(parts) summary="看图"      fileCount=1  (期望 1)   ← 仅此形态生效
C 原文含 @{}@ + parts                    fileCount=3  (真实文件数 2) ← 两处相加导致重复计数
D 纯文字                                 fileCount=0  (期望 0)     ✓
F 存量行 string 回退                       fileCount=1  (期望 1)     ✓（本轮 parse 分支已对）
```

A 的输入即 `buildMessage` 的真实产物（`composePromptText` + `composeContent` 拼进引用后的字符串），说明修复对该形态无效；新单测用的是 `ContentPart[]`，恰好绕开了出错形态，因此「绿但未修好」。

**影响**：会话忙时「正文 + 附件」入队的消息，web 面板仍不显示 `[N 个文件]`；用户无法判断附件是否随消息排队。另 `fileCount` 在「消息含图片且正文/引用里也有 `@{}` 引用」时会**多算**（C 实测 3 vs 真实 2）：`fromParts.text` 由 `composePromptText(context)` 生成，本身就包含 `context.text`；引用段（`quoted-injection` 对超长引用会写 `@{path}@`）也会被算成本消息的附件。

**修复建议**：只保留单一事实源——**构造后的 message 文本**，并复用本轮新增的 `stripPromptSections()`（追加的附件引用在用户正文之后，剥段后仍在）：

```ts
const composedText = typeof message === 'string' ? message : fromParts.text;
...
fileCount: countFileRefs(stripPromptSections(composedText, context.chatType === 'group')),
```

这样同时解决：string 主路径漏算（A）、两处相加重复计数（C）、引用段/群上下文里他人文件的误计。**测试必须补 string 形态**（例如 `buildQueueViewColumns(ctx({ text: '看下这个文件' }), '【用户消息】\n杨佳毅：看下这个文件\n@{/p/a.pdf}@')` 断言 `fileCount === 1`），现有 `ContentPart[]` 用例保留。

---

### R2-P2-1（P2，本轮新引入）本地组折叠行在只有 1 条时显示「还有 0 条」

**文件与位置**：`desktop/src/components/chat/QueuePanel.vue:99`（`<span class="queue-more">还有 {{ localCount - 1 }} 条</span>`，所在 `v-else` 分支条件为 `:21` 的 `v-if="expanded || visibleCount <= 5"`）

**问题**：折叠分支的进入条件是「两组合计 > 5 且未展开」，与 `localCount` 无关。因此 `localCount === 1 && inboundMessages.length >= 5`（例：web 发 1 条 + 飞书排队 5 条，合计 6）时，本地组只显示首条并渲染「还有 0 条」。round1 此处是 `visibleCount - 1`（数字偏大但非零），本轮改成 `localCount - 1` 后新增了「还有 0 条」这一无意义文案。

**影响**：纯文案/观感，不涉数据；`localCount >= 1`（在 `v-if="localCount > 0"` 内）保证不会出现负数。

**修复建议**：`v-if="localCount > 1"` 包住该行（或 `还有 {{ localCount - 1 }} 条` 改 `localCount > 1 ? ... : ''`）。顺带建议：本地组折叠阈值仍取两组合计，`localCount=2 + 飞书=4` 时本地也会被折叠成 1 行（需点「展开」才能编辑/删除第 2 条），是否按组分阈值由产品决定，非阻塞。

---

### R2-P2-2（P2，R1-P2-4 的残留场景）p2p「多段落引用」仍把引用末段当摘要

**文件与位置**：`backend-ts/src/feishu/inbound-queue-view.ts:88-93`（`const sep = rest.indexOf('\n\n')`）

**问题**：p2p 分支用「引用段标记后的第一个空行」定位用户正文。引用正文本身含空行（多段落引用很常见，`capReplyQuote` 只截长度、不改段落）时，切点落在引用内部。

**实证**：

```
payload.message = '【引用的消息】\n第一段\n\n第二段\n\n我的回复'（chatType=p2p）
parseQueuePayloadSummary(...).summary = "第二段 我的回复"   (期望「我的回复」)
```

对照：群聊「多段落正文 + 引用」已实测正确（`'【群内最近消息】…\n\n【引用的消息】…\n\n【用户消息】\n杨佳毅：第一段\n\n第二段\n\n第三段'` → `第一段 第二段 第三段`），本轮复核要求中的该点无问题。

**影响**：仅影响 V210 之前入队的存量行（`summary IS NULL` 回退）、且仅 p2p + 多段落引用；表现为摘要开头混入引用尾段，不涉顺序/权限/取消。

**修复建议**：payload 的 `context` 已存 `quotedContext`（`types.ts:128`），可直接用其长度精确定位：

```ts
const quoted = (context.quotedContext ?? '').trim();
const bodyStart = QUOTED_SECTION_MARKER.length + quoted.length + 2; // + '\n\n'
```

若不想依赖该字段，则退化为「取最后一个 `\n\n` 之后」（对多段落正文会切丢正文，不如前者），或对 p2p 保留整段不做切分。补一条「引用正文含空行」的用例（现 `extracts the user body after the quoted section in p2p` 用的是单段落引用，测不出该问题）。

## 3. 回归核验（无问题的部分）

- **R1-P2-2 折叠逻辑**：`visibleInboundMessages`（`QueuePanel.vue:210-213`）在 `expanded || visibleCount <= 5` 时全展示、否则 `slice(0, 3)`；`hiddenInboundCount`（`:214`）随之归零，`expanded` 切换后提示与列表同步消失/出现；`hiddenInboundCount > 0` 只可能在 `visibleCount > 5 && !expanded` 成立时出现，而该条件正是顶部「展开」按钮的显示条件（`:5`），不再有死按钮。飞书组预览不参与本地 `VueDraggable`，不影响拖拽下标；本地为空时折叠分支仍被 `v-if="localCount > 0"` 包住，不会索引 `queueView[0]`（不崩）。
- **R1-P2-3**：`messages.ts:1050-1052` 三个 `delete` 与 `:1085-1087` 三个 `new Map()` 均与既有 key 同批，`reset()`（`stores/auth.ts:75` 登出路径）也会清空。
- **R1-P2-4**：p2p `结论：可以上线` 不再被剥前缀；`ContentPart[]` 走 `stripPromptSections` 后摘要为 `看图`；合法空正文 → `[空消息]`、非法 JSON → `[无法解析的排队消息]`；群聊多段落正文 + 引用实测完整保留。`[空消息]` 使新行 `summary` 恒非空，`resolveItem` 的「summary != null 即不再读 payload」分支更稳定；全仓无 `summary === null` 依赖被破坏（grep 过 `summary)toBeNull` / `summary == null` 均无相关消费方），既有 spec 无断言受影响。
- **无残留引用**：`queueGroupsCollapsedText` 已从 `queue-view.ts` 与其单测移除，全仓 grep 无任何引用（`vue-tsc -b` 0 错佐证）。
- **测试基线**：backend 4 个 spec 50 例全绿（`inbound-queue-view` 27 例，较 round1 +5）；desktop `queue-view` 9 例、`chat-a11y` 7 例、`chat-shared-actions` 3 例、`chatSessionActions` 20 例全绿。

## 4. 残余风险

- R2-P1-1 的修复若只改 `fileCount` 而不补 string 形态用例，容易再次「测试绿但主路径失效」；建议按上文 repro 用例先行转红再修。
- p2p 多段落引用的定位歧义在存量行上无法完全消除，只能靠 `quotedContext` 长度或产品确认降级文案；存量行消费完后问题自然消失。
- 本轮仍未做真实飞书环境端到端（卡片 PATCH、WS 实投递、蓝绿丢帧收敛仅静态 + 单测核对）。
- 本次只读复查，未执行任何修复。
