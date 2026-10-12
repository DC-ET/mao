# 回复引用溯源（answer-citations）未提交改动代码审查 — Round 4

- **日期**：2026-10-12
- **工作区**：`/Users/yangjiayi/AiProjects/mao/.worktrees/answer-citations`（分支 `feat/answer-citations`）。只审功能逻辑，忽略文档类改动。
- **背景**：Round 3 的 BUG-C（搜索片段露 `[^n^]`）/ BUG-D（复制消息露 `[^n^]`）/ BUG-E（admin 会话详情露 `[^n^]`）已修复，另补了「早退优化缺测试锁定」。用户说明这是最后一轮。
- **方法**：① 逐行复核 3 处修复；② 对 3 组新测试做**变异测试**（逐条回退修复，验证对应用例失败且只失败那一条）；③ 针对用户三个专项问题（`snippetSourceText` 是否影响命中、admin 缓存键改用 source 的隐患、`copyMessage` 两层剥标顺序）做代码推演 + 探针实跑；④ 按用户列出的面（JSONL 导出 / 分享快照 / 站内通知 / 出站订阅 payload / Embed SDK）+ 全库 `[^n^]` 消费面再扫一遍。探针用完即删，**未动 node_modules**。
- **基线健康度**：探针删除后复跑 —— backend 8 个相关 spec **228 passed**、desktop 4 个相关 spec **37 passed**；`backend-ts tsc -p tsconfig.build.json`、`desktop vue-tsc -b --force`、`admin vue-tsc -b --force` + `admin npm run build` 全部通过。用户实跑全量：backend 292 files / 3643 tests、desktop 58 files / 505 tests 全绿（中途 `workspace-write.service.spec` 两次偶发失败，单独重跑与第三次全量均通过，属负载时序 flake，与本次改动无关）。
- **结论**：**三个修复都真正解决、无新回归；三组新测试全部非恒真（变异测试逐条验证）；早退优化已被测试锁住。** 全库扫描未发现新的「露出 `[^n^]`」出口。但在专项核查中发现 **1 个低危边角回归（BUG-F）**：`snippetSourceText` 让「关键词本身含 `[^n^]` 字面量」的搜索命中被整条丢弃，且 `total` 与 `items` 计数不一致。触发条件很窄（搜索词里带 `[`/`^` 标记字符），不影响正常搜索。
- **合入建议**：**无重大 bug，可以合入。** BUG-F 属边角体验问题，建议合入前顺手修（一行 fallback，见下）或明确记录为已知限制；若不加修改也不影响本需求主流程正确性。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-F | 低 | backend/session 搜索 | `snippetSourceText` 剥标后，关键词含 `[^n^]` 字面量时 `buildSnippet` 找不到词 → 返回 null → `executeMessageSearch` 里 `if (hits.length === 0) continue` 把整条命中（含整个会话）从 `items` 丢掉，而 `total` 仍按 SQL 命中计数 → 桌面搜索显示「找到 N 个相关会话」却列不出来 |

---

## 一、三个修复的复核（均真正解决，无新回归）

### BUG-C 修复（搜索片段单点收口）

`session.service.ts:887-890` 新增 `snippetSourceText(content)` = `extractVisibleText` 后再 `stripCitationMarkers`；两处调用点（:499 admin `listSessionsForAdmin` → `loadAdminMatchSnippets`，:810 桌面 `searchMessages` → `executeMessageSearch`）都改调它。

**「是否影响搜索命中本身」——不影响 SQL 匹配，但有一个边角回归（BUG-F，见第二节）**：

- 匹配层未动：`selectMatchingSessions` / `countMatchingSessions` / `selectHitMessages` / `selectFirstMatchingMessages` 全部按**原始 content** 做 LIKE / FULLTEXT，`snippetSourceText` 只作用于片段展示文本。会话是否命中、命中条数统计都与修复前一致。
- 正常关键词（不含标记字符）行为完全一致，且**跨标记短语反而更容易命中**（剥标后 `30 日[^1^]，详见` → `30 日，详见`，搜 `30 日，详见` 现在能出片段）——探针 R2/R3 实证。
- 唯一回归：关键词**本身含 `[^n^]` 字面量**时片段建不出来（BUG-F）。

### BUG-D 修复（复制消息两层剥标）

`MessageBubble.vue:685`：`stripCitationMarkers(stripInternalMarkers(props.message.content ?? '')).trim()`。

**两层剥标顺序评估 —— 顺序无关紧要，当前顺序正确**：

- `stripInternalMarkers` 的正则（`\$\{([^}]+)\}\$` / `#\{([^}]+)\}#` / `@\{([^}]+)\}@`）与 `stripCitationMarkers` 的正则（`\[\^(\d+)\^\]`）字符类不相交：前者只可能**产生**或**消除** `${…}` / `#{…}#` / `@{…}@` 片段，不可能凭空生成 `[^n^]`；后者只删除 `[^n^]`，不可能生成 `${…}` 类片段。因此两种顺序结果相同。
- 当前顺序（先内部标记）还有一个好处：若正文里出现 `${[^1^]}$` 这种嵌套，先剥内部标记会把它还原成 `[^1^]`，再被第二层剥掉，不会残留。
- `.trim()` 仍在最外层，行为不变。

### BUG-E 修复（admin 会话详情）

`admin/src/utils/citationMarkers.ts`（新增，正则与后端 `backend-ts/src/session/util/citation-markers.ts`、桌面 `desktop/src/utils/citationMarkers.ts` **逐字节相同**，已用脚本比对确认：三处 `CITATION_MARKER_SOURCE` 均为 `\\[\\^(\\d+)\\^\\]`，函数体同构）；`admin/src/views/session/composables/useMarkdown.ts:65` 起 `renderMarkdown` 先 `stripCitationMarkers(text)` 得 `source`，再用 `source` 走缓存查/存、`marked.parse`、`escapeHtml` 兜底与 20_000 长度上限。

**「缓存键改用 source 是否有隐患」——无隐患，且略优**：

- 缓存键从 raw `text` 改为剥标后 `source`：两段仅标记不同的原文会共享同一 HTML 条目——它们的渲染结果本就该相同（admin 不渲染来源区），属于正确合并；真实内容不同的文本剥标后仍不同，不会串键。
- 长度上限改用 `source.length`：source 只短不长，命中上限的文本变少 → 可缓存条目略增，无正确性影响。
- `if (!text) return ''` 仍判原始入参：纯标记串（如 `[^1^]`）会继续走到 `marked.parse('')` → 空 HTML，与修复前「渲染出 `[^1^]` 字面量」相比是期望行为。
- DOMPurify 白名单、`ADD_ATTR: ['target']`、代码块高亮均未动。

### 早退优化的测试锁定（已补）

`message-citations.spec.ts:162-170`「无任何标记时不写库（且提前早退，不拉全量消息）」新增 `expect(h.getRawMessages).not.toHaveBeenCalled()`。变异测试确认有效（见下）。

---

## 二、新测试全部非恒真（变异测试）

| 变异（回退的修复） | 结果 |
| --- | --- |
| `snippetSourceText` 去掉剥标（只留 `extractVisibleText`） | `Tests 2 failed \| 46 passed`，失败的正是 `messageSearchSnippetsStripCitationMarkers` 与 `admin list match snippets strip citation markers` 两条 |
| `copyMessage` 去掉 `stripCitationMarkers` 外层 | `Tests 1 failed \| 5 passed`，失败的正是 `复制消息时一并剥掉引用标记` |
| `buildForSession` 早退重排改回「先 `getRawMessages` 再提标记」 | `Tests 1 failed \| 19 passed`，失败的正是 `无任何标记时不写库（且提前早退，不拉全量消息）` |

三条变异都只失败「该修复对应的那一条」，无连带失败。变异后均已从备份逐字节还原（`git diff` 与修复后状态一致，三端 build 通过）。

---

## 三、新发现 BUG-F【低】含标记字面量的搜索命中被整条丢弃

### 位置与链路

`session.service.ts:810-818`（`executeMessageSearch`）：

```ts
const text = this.snippetSourceText(hit.content ?? null);
const snippet = buildSnippet(text, keyword, prepared.snippetTerms);
if (snippet == null) continue;      // ← 片段建不出来就丢弃该命中
...
if (hits.length === 0) continue;    // ← 该会话所有命中都被丢 → 整个会话从 items 消失
```

而 `total` 来自 `countMatchingSessions`（SQL 原始 content 匹配，不受剥标影响）→ `total` 仍计该会话。桌面 `SessionSearchPopover` 用 `total` 显示「找到 N 个相关会话」、用 `items` 渲染列表 → **数字与列表不一致**。

触发条件：关键词含 `[^n^]` 字面量（含只搜 `[^1^]`、或粘贴的片段里带标记）。LIKE 模式下 `[`/`^` 是 LIKE 的字面字符（`escapeLike` 只转义 `%`/`_`），FULLTEXT 模式下 `日[^1^]` 会被切词成 `日`+`1` 的短语——两种模式 SQL 都能命中，所以该分支可达。

### 探针实跑（`zz-recall-cite-probe.spec.ts`，已删除）

```
R1 items = [] total = 1                                  ← 搜「日[^1^]」：SQL 命中 1 个会话，items 为空
R2 items = ["截止时间是 11 月 30 日，详见通知。"]          ← 对照：搜「截止时间」正常
R3 items = ["截止时间是 11 月 30 日，详见通知。"]          ← 跨标记短语「30 日，详见」剥标后反而能命中
```

（admin 路径 `loadAdminMatchSnippets` 只是少一行「命中消息」片段，会话本身仍在列表里，影响更小。）

### 修复方向（一行，按推荐排序）

1. **片段源 fallback（推荐）**：片段先用剥标文本建，建不出来（关键词只可能在原始文本里）时回退用未剥标的可见文本建——
   `const snippet = buildSnippet(stripped, …) ?? buildSnippet(rawVisible, …)`。正常关键词仍走剥标文本（BUG-C 修复保持），只有「用户主动搜标记字面量」时才在片段里回显标记，命中不再丢。
2. 若认为「搜标记」不是有效用例：至少把 `total` 与 `items` 口径拉平（按同样规则过滤 total），消除「找到 N 个却列不出」的不一致。
3. 也可明确记录为已知限制（搜索 `[^n^]` 无结果），但不建议放任 total/items 不一致。

---

## 四、全库 `[^n^]` 露出面复查（按用户列出的面 + 全消费面）

| 面 | 结论 |
| --- | --- |
| **JSONL 导出**（`GET /v1/sessions/:id/export/jsonl` → `session-export.service.ts` → `toMessageJsonlLine`） | **非泄漏，设计如此**：导出的是原始数据（`content` 原样 + `metadata.citations` 原样），二者配对自洽；剥标才会丢信息。与 BUG-C/D/E 的「给人看的渲染面」不同类 |
| **分享快照**（`/v1/share/:token`、`/v1/share/public/:token` → `ShareView.vue` → `ChatRoundList` → `MessageBubble` → `MarkdownContent`） | 走桌面 markdown：有 `metadata.citations` 渲染上标、无则剥标，不露原文字样 |
| **站内通知**（`inbox.service.ts` 各 `title`/`content`） | 只用会话标题、失败原因、webhook/API 失败摘要，不含 ASSISTANT 回复正文 |
| **出站订阅 payload**（`outbound-subscription.service.ts` `dispatchTaskTerminal`） | payload 仅 `sessionId/userId/executionId/phase/title/failureReason/source`，无正文 |
| **Embed SDK**（`page_inspect`/`page_observe`/`page_screenshot`/`page_scroll`/`page_focus`，`harness/tool/impl/page-tools.ts`） | 是驱动外部网页的工具，不读取/不回传会话消息内容；无露出面 |
| 桌面消息气泡 / 行内代码 / 代码块 | markdown 渲染层（Round 1-2 已修） |
| 桌面搜索片段 / admin 列表片段 | BUG-C 本轮修 |
| 桌面复制消息 | BUG-D 本轮修 |
| admin 会话详情 | BUG-E 本轮修 |
| 飞书/钉钉/微信入口、崩溃恢复、定时任务、飞书进度卡（流式+终态） | Round 2/3 已修 |
| 点踩经验提炼入参 | Round 3 已修 |
| WS 流式增量、`getMessagesByRounds`（ChatRoundList/SideChatPanel/fork 预览/分享） | 全部经 `MarkdownContent`（桌面唯一 `v-html` 出口，已核） |
| `countCompletedAgentRounds`、子代理结果回传、边路上下文摘要、记忆抽取、后台子代理进度 | 只计数或喂 LLM，用户不可见 |
| 会话标题 / 摘要 | 标题取自飞书群名或首条 USER 消息；`updateSummary` 仅 API 手动设置，非 ASSISTANT 正文派生 |

**结论：除 BUG-F 外，未发现新的 `[^n^]` 露出面。**

---

## 五、admin 补测的可落地方式（回答「是否必须补」）

**结论：不值得为这条正则单独引入测试基础设施，但可以用零新依赖的方式补上。** 理由：admin 的 `stripCitationMarkers` 与后端/桌面两份**逐字节相同**（已脚本验证），而后两者已有 18 + 若干用例覆盖；admin 侧真正的新代码只有「`renderMarkdown` 里先剥标再 parse」这两行接线。

若仍要补（建议顺手做，成本约 10 行）：

- **运行方式（零新依赖，已实测可跑）**：admin 已有一个 `node:test` 遗留 spec（`src/router/chunk-reload.spec.ts`）。本机 Node v22.22.2 默认开启类型剥离，直接
  `cd admin && node --test src/utils/citationMarkers.spec.ts`
 即可运行（我按此方式写了 5 个探针用例实跑通过：剥标、空串恒等、脚注 `[^1]` 不误剥、连续调用无 `lastIndex` 残留、`useMarkdown.ts` 的剥标接线源码断言）。不需要装 vitest，也不需要动 `package.json`。
- **注意边界**：admin 的 `useMarkdown.ts`  import 了 `../../../utils/codeCopy`（**无 `.ts` 扩展名**）和 CSS，`node --test` 无法直接 import 该模块（实测报 `Cannot find module .../utils/codeCopy`）——所以能测的是纯函数 `citationMarkers.ts` + 对 `useMarkdown.ts` 的**源码结构断言**（与 `MessageBubble.citations.test.ts` 同风格，桌面 node 环境也是这么处理的）。
- 若希望将来能跑 admin 的组件/渲染测试，再单独引入 vitest（需改 `admin/package.json` + lockfile），本次不建议。

---

## 六、工作区状态

- 探针 `backend-ts/src/session/zz-recall-cite-probe.spec.ts`、`admin/src/utils/zz-admin-cite-probe.spec.ts` **已删除**；三处变异测试的回退均已从备份逐字节还原。
- **未动 node_modules**（admin 探针用 `node --test` 直跑，未安装任何包）。
- `git status` 与进入本轮时一致：原始改动集 + 四份 round 报告，无其它残留。
- 复跑：backend 8 个相关 spec 228 passed；desktop 4 个相关 spec 37 passed；三端 build（backend tsc / desktop vue-tsc -b --force / admin vue-tsc + vite build）全部通过。

---

# Round 5 追记：BUG-F 修复验证（收尾轮）

- **日期**：2026-10-12
- **对象**：Round 4 发现的 BUG-F（`snippetSourceText` 让「关键词本身含 `[^n^]` 字面量」的搜索命中被整条丢弃、`total` 与 `items` 不一致）的修复。
- **修复内容**（`backend-ts/src/session/session.service.ts`）：新增私有 `searchSnippet(content, keyword, extraTerms?)` = `buildSnippet(剥标文本) ?? buildSnippet(未剥标可见文本)`；两处调用点（桌面 `searchMessages` hit 循环、admin `loadAdminMatchSnippets`）都改调它；`snippetSourceText` 保留未动。admin 路径原来的 `text == null || text.length === 0` 前置判断已移除。
- **结论**：**BUG-F 已真正解决，无新回归、无新露出面。无重大 bug，可以合入。**

## 1. BUG-F 是否真正解决 —— 是（探针实证）

探针 `zz-bugf-probe.spec.ts`（7 例，已删除）：

```
F1 total = 1 items = [["截止时间是 11 月 30 日[^1^]，详见通知[^2^]。"]]   ← 搜「[^1^]」：total/items 一致、命中不丢、片段含标记
F2 snippet = "截止时间是 11 月 30 日，详见通知。"                        ← 普通关键词仍剥标（BUG-C 修复无回归）
F3 snippet = "截止时间是 11 月 30 日，详见通知。"                        ← 多词「截止 [^1^]」：剥标文本能命中普通词，优先走剥标、片段不含标记
F4 snippet = "截止时间是 11 月 30 日[^1^]，详见通知[^2^]。"             ← admin 搜「[^1^]」：带回退
F5 snippet = "截止时间是 11 月 30 日，详见通知。"                        ← admin 普通关键词仍剥标
F6 matchSnippets = {}                                                  ← admin 边角：null / 空串 / 纯标记 content + 普通关键词 → 无片段项
F7 matchSnippets = {"33":"[^1^]"}                                      ← 纯标记 content + 关键词即标记 → 有片段（与 BUG-C 修复前一致）
```

即：`total`/`items` 不一致已消除；回退只在「剥标文本完全找不到词」时触发，普通与多词搜索全部仍走剥标口径。

## 2. 新增测试非恒真（独立变异测试）

把 `searchSnippet` 的回退删掉只留剥标路径 → `Tests 2 failed | 48 passed`，失败的正是 `messageSearchKeepsHitWhenKeywordIsCitationMarkerItself` 与 `admin list match snippet falls back when keyword is citation marker itself` 两条，其余 48 条不受影响。与用户自测结果一致。

## 3. admin 移除前置空判断无行为差异（逐边角核对）

`buildSnippet` 自身对 `null` / 空文本返回 `null`（`text == null → null`；空文本时 `terms` 非空但 `indexOfIgnoreCase` 找不到 → `best < 0 → null`），且 `loadAdminMatchSnippets` 入口已有 `keyword.length === 0` 早退，故：

| content | 旧行为 | 新行为 |
| --- | --- | --- |
| `null` | `extractVisibleText` → null → `continue` | 两条 `buildSnippet` 均 null → 不写条目（F6） |
| `''` / 纯空白 | `text.length === 0` → `continue` | 同上（F6） |
| 纯标记 `'[^1^]'` + 普通关键词 | 剥标后为空 → 旧代码用原始文本也找不到词 → 不写条目 | 同上（F6） |
| 纯标记 + 关键词即标记 | 旧：片段 `[^1^]` | 新：回退产出同样片段（F7） |
| 有标记正文 + 普通关键词 | 旧：片段含标记（= BUG-C） | 新：剥标片段（BUG-C 修复） |

行为完全等价，只是空判断从「调用方前置」挪到「`buildSnippet` 内部」，少一次重复求值。

## 4. 回退路径的露出面可接受（已确认是纯文本渲染）

回退片段里出现的 `[^1^]` 只在「用户主动搜索该字面量」时出现，且两个消费方都是**纯文本插值、不走 markdown / v-html**：

- 桌面 `desktop/src/components/search/SessionSearchPopover.vue:91-95`：`{{ part.text }}`（Vue 自动转义），高亮由 `search-highlight.ts` 的纯字符串切分完成，不解析标记、不产 HTML。
- admin `admin/src/views/session/SessionListView.vue:69,120-122`：`命中消息：{{ row.matchSnippet }}` / `<span>{{ row.matchSnippet }}</span>`，同为纯文本。

因此不会被当成 citation 标记解析、不会渲染成上标、也没有注入面；用户搜什么就回显什么，属预期行为。**不需要在桌面渲染 snippet 的地方额外处理。**

## 5. 其他未收口的面 —— 无

本轮唯一改动文件是 `session.service.ts`（+spec）：`searchSnippet` / `snippetSourceText` 均为私有，只被上述两个搜索路径调用，未引入新消费方。Round 4 的全库扫描结论（JSONL 导出为原始数据导出、分享快照走 markdown、站内通知/出站订阅 payload 无正文、Embed SDK 不碰消息内容、桌面唯一 `v-html` 出口是 `MarkdownContent`）全部仍然成立。

## 6. 工作区状态

- 探针 `backend-ts/src/session/zz-bugf-probe.spec.ts` 已删除；变异测试的回退已从备份逐字节还原（`grep` 复核 `searchSnippet` 两行回退在位）。
- **未动 node_modules。**
- 复跑：`session.service.spec` + `message-citations.spec` + `citation-markers.spec` 88 passed；`tsc -p tsconfig.build.json`（= `npm run build`）通过；`git status` 与进入本轮时一致（原始改动集 + 五份 round 报告）。
- 用户全量回归：backend 292 files / 3645 tests passed、build exit 0。
