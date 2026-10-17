# 代码逻辑 BUG 审查（2026-10-17）

- 仓库：`/opt/mao-data/workspace/2/projects/mao`
- 基线：`facab2fa`（工作区起始 `git status` 为空）
- 方法：主审阅读调用链 + 分区并行探针；6 条均已在本地真实运行测试复现，测试含同文件对照组，排除「测试写法导致假失败」。
- 复现口径：本文档更新时**逐条重跑**了未包裹 `it.fails` 的临时副本（`sed 's/it.fails(/it(/'` 生成 `zz-verify-*`，跑完即删），确认每条断言在真实产品代码上失败；不是只看 `it.fails` 的绿色结果。
- 测试固化方式：审查时失败断言放在 `it.fails(...)` 中以便纳入日常套件仍为绿色；用户确认修复后已全部转回普通 `it`，作为回归用例长期保留。文中保留修复前的真实失败输出作为证据。
- 审查阶段未修改产品代码；用户确认后已完成 6 项修复（见文末「修复记录」）。未提交、未推送、未部署。

## 结论

| 编号 | 严重度 | 位置 | 一句话 |
| --- | --- | --- | --- |
| BUG-2 | 高 | `backend-ts/src/harness/tool/impl/edit-file-tool.ts:71-74`、`agent-cli/src/local/tools/files.ts:416-418` | `read_file` 把 CRLF 归一成 LF 展示，`edit_file` 却按保留 CRLF 的原文匹配，CRLF 文件的多行编辑必然失败 |
| BUG-1 | 中 | `backend-ts/src/session/run-trace.service.ts:374`、`desktop/src/utils/trace-display.ts:66-67`、`desktop/src/components/center/RunTracePanel.vue:437,441,445` | 运行轨迹把「已包含缓存」的 `promptTokens` 再与缓存分项相加，token 总量与「贵」阈值双重虚高 |
| BUG-3 | 中 | `backend-ts/src/weixin/voice-text-sanitizer.ts:12,67` | 语音清洗无条件删除所有 `_`，把 `user_id` 读成 `userid` |
| BUG-4 | 中 | `desktop/src/composables/useMarkdown.ts:34-36,95-102` | link renderer 只放行 http(s)，工作区相对链接与 `mailto:` 被剥成纯文本，文件内跳转失效 |
| BUG-5 | 中 | `desktop/src/composables/useInboxSystemNotify.ts:29-51` | 系统通知 kind 白名单漏 `WEIXIN_REPLY_WINDOW_CLOSED` / `DAILY_DIGEST`，窗口失焦时这两类条目不弹通知 |
| BUG-6 | 低 | `desktop/src/stores/session/list.ts:606-620,226-238` | 删除已归档会话时扣错计数桶：活跃分组 total 被减，归档分组 total 不减 |

排序说明：本轮按「实际危害 × 可修复性」重排，BUG-2 从原第 2 位提到首位——它是唯一会**让 Agent 的核心编辑能力在特定工作区里完全退化**的缺陷（CRLF 仓库里多行 patch 100% 失败），且修法明确、边界清晰。

复跑全部固化用例：

```bash
cd backend-ts && npx vitest run \
  src/harness/tool/impl/edit-crlf.bugcheck.spec.ts \
  src/weixin/voice-sanitizer.bugcheck.spec.ts
# Test Files 2 passed (2) / Tests 5 passed (5)

cd desktop && npx vitest run \
  src/utils/trace-token.bugcheck.test.ts \
  src/composables/markdown-link-href.bugcheck.test.ts \
  src/composables/inbox-notify-kind.bugcheck.test.ts \
  src/stores/delete-archived.bugcheck.test.ts
# Test Files 4 passed (4) / Tests 12 passed (12)
```

复跑记录（2026-10-17 更新时，`it.fails` 包裹态与临时 unwrap 态均实测）：

```text
包裹态 backend-ts: Test Files 2 passed (2) / Tests 4 passed (4)
包裹态 desktop   : Test Files 4 passed (4) / Tests 4 passed | 7 expected fail (11)
unwrap 态 backend-ts: Tests 2 failed | 2 passed (4)
unwrap 态 desktop   : Tests 7 failed | 4 passed (11)
```

unwrap 态共 9 条断言失败，与 6 个 bugcheck 文件中记录的缺陷断言一一对应，全部复现。

---

## BUG-2【高】CRLF 文件无法按 `read_file` 展示的文本做多行 `edit_file`

### 位置

- `backend-ts/src/harness/tool/impl/read-file-tool.ts:143-149`（`splitLines` 统一 `\r\n|\r|\n`）
- `backend-ts/src/harness/tool/impl/edit-file-tool.ts:71-74`（`stripBom` 后仍保留 CRLF，直接精确匹配）
- `backend-ts/src/harness/tool/impl/edit-file-match.ts:29-31`（`findOccurrenceStarts` 按原文字节匹配）
- LOCAL 同源：`agent-cli/src/local/tools/files.ts:416-418`

### 代码事实

`read_file` 通过 `splitLines` 把 CRLF/CR 全部归一成 LF，模型看到的正文是 LF：

```ts
const lines = raw.split(/\r\n|\r|\n/);
```

`edit_file` 只做 `stripBom(raw)`（仅去 BOM），CRLF 原样保留；`oldString` 来自模型看到的 LF 文本，`findOccurrenceStarts(content, oldString)` 因此匹配不到。

### 触发条件

工作区存在 CRLF 文件（Windows 检出、`.gitattributes eol=crlf`），模型先 `read_file` 再按看到的多行片段调 `edit_file`。单行 `old_string` 不含换行，所以既有测试只覆盖单行时未暴露。

### 期望 vs 实际

- 期望：`old_string: "alpha\nbeta"` 匹配磁盘上的 `alpha\r\nbeta`，替换成功且写回仍为 CRLF。
- 实际：`{"success":false,"error":"文件中未找到 old_string"}`，文件不变。CLOUD 与 LOCAL 行为一致地失败。

### 测试与真实失败输出

测试：`backend-ts/src/harness/tool/impl/edit-crlf.bugcheck.spec.ts`

```bash
cd backend-ts
npx vitest run src/harness/tool/impl/edit-crlf.bugcheck.spec.ts
```

未包裹 `it.fails` 时的失败输出（本次更新时实测）：

```text
FAIL  src/harness/tool/impl/edit-crlf.bugcheck.spec.ts > read_file → edit_file 行尾契约 > BUG：CRLF 文件按 read_file 展示的 LF 文本做多行替换应成功（实际失败）
AssertionError: edit failed: 文件中未找到 old_string: expected false to be true // Object.is equality

Test Files  1 failed (1)
     Tests  1 failed | 1 passed (2)
```

### 对照组

同文件 LF 文件：`read_file` 返回 `alpha\nbeta\ngamma`，同样的 `old_string` 替换 `success=true`，证明工具链、沙箱与测试构造均正常，失败只由 CRLF 触发。

### 影响

Windows 检出/CRLF 仓库里，Agent 的编辑能力退化为只能单行替换；多行 patch 全部失败，模型往往反复重试或改成整文件覆写，带来行尾翻转与误改风险。这是本轮唯一「让核心功能在特定环境下整体失效」的缺陷，因此排在首位。

### 修复方向

匹配前把 `content`、`oldString`、`newString` 统一为 LF，匹配成功后再按 `detectEol(raw)` 的 `applyEol` 写回；不要只改 `read_file` 一侧。LOCAL 的 `agent-cli/src/local/tools/files.ts` 同步处理。仓库已有 `file-eol.ts` 的 `detectEol`/`applyEol`/`stripBom`，CLI 侧 `files.ts:215-227` 也有同语义实现，改造成本低。

### 查重说明

`2026-09-17-logic-bug-review-01.md` 的 BUG-5 修的是「写回时保留 CRLF/BOM」，`2026-09-02-code-review-02.md` 记录的是 CLI `splitLines` 语义不一致；两者都没有覆盖「read 归一、edit 不归一」造成的多行匹配失败。

---

## BUG-1【中】运行轨迹 token 总量重复计入缓存 token

### 位置

- `backend-ts/src/session/run-trace.service.ts:374`
- `desktop/src/utils/trace-display.ts:66-67`
- `desktop/src/components/center/RunTracePanel.vue:437,441,445`

### 代码事实

统一 `ChatUsage.promptTokens` 的语义是**总输入**，缓存命中/写入只是它的分项：

- OpenAI 的 `prompt_tokens` 本身包含 `prompt_tokens_details.cached_tokens`；
- Anthropic 适配器 `backend-ts/src/harness/llm/anthropic-llm-adapter.ts:1011` 明确计算
  `promptTokens = input_tokens + cache_creation + cache_read`；
- 同文件注释（`:1003`）写明「OpenAI 口径的 prompt_tokens 本就是全量输入，cachedTokens 是其子集」。

但有四处把四类 token 当作互斥项相加：

```ts
// run-trace.service.ts:374
expensive: promptTokens + completionTokens + cachedTokens + cacheCreationTokens >= query.expensiveTokens

// trace-display.ts:66-67
summary.tokens +=
  run.totals.promptTokens + run.totals.completionTokens + run.totals.cachedTokens + run.totals.cacheCreationTokens
```

`RunTracePanel.vue:437/441/445` 的 `tokenTotal`、`tokenTotalOfRound`、`tokenTotalOfSide` 同式。

### 触发条件

任一 `llm_call` 有缓存命中（`cached_tokens > 0`，长会话/重复系统提示词时普遍存在），打开运行轨迹面板或查看会话汇总。

### 期望 vs 实际

- 期望：`prompt=1000, completion=100, cached=800` → `1100`。
- 实际：`1900`，缓存部分被算两次；缓存命中率越高，虚高越严重。
- 连带影响：「贵 ≥ N tokens」徽标按虚高值判定，阈值约提前一倍触发；会话总览 token 与后端 `llm_call.total_tokens`、管理后台用量口径不一致。

### 测试与真实失败输出

测试：`desktop/src/utils/trace-token.bugcheck.test.ts`

```bash
cd desktop
npx vitest run src/utils/trace-token.bugcheck.test.ts
```

未包裹 `it.fails` 时的失败输出（本次更新时实测）：

```text
FAIL  src/utils/trace-token.bugcheck.test.ts > summarizeRuns token 总量 > BUG：缓存命中 token 已含在 promptTokens 内，不应再加一次
AssertionError: expected 1900 to be 1100 // Object.is equality

Test Files  1 failed (1)
     Tests  1 failed | 1 passed (2)
```

### 对照组

同文件「无缓存时 prompt 100 + completion 20 = 120」通过，证明汇总函数本身与构造数据正确，差异只来自缓存分项被重复相加。

### 影响

桌面运行轨迹/会话汇总展示的 token 数偏高；「贵」徽标误报；与后端用量、管理后台报表对不上，用户无法用轨迹核对成本。注意 `trace-export.ts` 的 CSV 导出是逐列原值输出、不求和，因此导出数据本身正确，问题只在汇总与徽标两处。

### 修复方向

- 总量统一为 `promptTokens + completionTokens`；`cachedTokens` / `cacheCreationTokens` 只作分项展示，不再进入求和。
- 后端 `expensive` 同改；同步修正 `desktop/src/utils/trace-display.test.ts:168` 中把 `165` 写成期望的旧断言（该断言固化了错误口径）。

### 查重说明

`docs/code-review/2026-10-09-run-trace-review-02.md:162` 曾把「贵看四类 token 之和」记录为预期行为，但没有核对适配器的 `promptTokens` 语义。本轮依据 `anthropic-llm-adapter.ts:1003-1011` 与 OpenAI 官方字段定义证明该口径错误，属于对既有结论的纠正，不是重复报告。

---

## BUG-3【中】微信语音文本清洗把 snake_case 标识符的下划线当 Markdown 强调删除

### 位置

- `backend-ts/src/weixin/voice-text-sanitizer.ts:12`：`const EMPHASIS = /[*_]/g`
- `backend-ts/src/weixin/voice-text-sanitizer.ts:67`：`cleaned = cleaned.replace(EMPHASIS, '')`

### 代码事实

清洗器先删除成对强调 `**` / `__` / `~~`（`STRONG`），随后又用一个「删除所有 `*` 和 `_`」的兜底正则。后一步不理解词边界，也不要求成对，导致标识符里的单个下划线被吞掉。

### 触发条件

用户或模型回复中出现任意 snake_case 标识符：`user_id`、`session_id`、`cache_creation_tokens`、字段名、变量名等，经微信语音播报清洗。

生产链路：`WeixinVoiceSynthesisService`（`voice-synthesis.service.ts:39,53`）在合成前调用 `toSpeechText`；该服务只在用户开启语音回复（`WeixinBotConfig.voiceReply`，默认 `false`）且有可用 audio 模型时工作，因此命中面小于其他条，但一旦开启，技术类回复几乎必然带标识符。

### 期望 vs 实际

- 输入：`请修改 user_id 字段`
- 期望：`请修改 user_id 字段。`（标识符可被完整读出）
- 实际：`请修改 userid 字段。`

### 测试与真实失败输出

测试：`backend-ts/src/weixin/voice-sanitizer.bugcheck.spec.ts`

```bash
cd backend-ts
npx vitest run src/weixin/voice-sanitizer.bugcheck.spec.ts
```

未包裹 `it.fails` 时的失败输出（本次更新时实测）：

```text
FAIL  src/weixin/voice-sanitizer.bugcheck.spec.ts > 微信语音文本清洗：Markdown 强调符 vs 标识符下划线 > BUG：snake_case 标识符中的单下划线不是 Markdown 强调，必须保留
AssertionError: expected '请修改 userid 字段。' to contain 'user_id'

Test Files  1 failed (1)
     Tests  1 failed | 1 passed (2)
```

### 对照组

同文件 `这是 **重要** 内容` → `这是 重要 内容。` 通过，证明成对强调符仍被正确移除，失败不是「清洗器整体不工作」。

### 影响

技术内容在语音通道被篡改：字段名/变量名少下划线后可能指向另一个真实标识符（如 `user_id` vs `userid`），听者按错误名称操作；对以语音接收任务结果的用户属于信息失真。

### 修复方向

删除 `EMPHASIS` 的无条件替换，只移除成对强调（`__...__`、`_..._`，且两侧满足词边界）；`*` 同理保留数学/通配语义。补 `user_id`、`__init__`、`a_b_c` 与 `_斜体_` 的回归。注意现有 `voice-text-sanitizer.spec.ts:78-80` 的 `boldItalicAndHtmlStripped` 用 `这是**重点**和*强调*` 锁死「单星号被移除」，修 `*` 分支时需同步调整该用例的期望。

### 查重说明

`docs/code-review/` 未见语音文本清洗相关条目；本轮候选也检查了微信长文本按 UTF-16 码元切字节的旧问题（`2026-10-10` 系列已作为低概率取舍记录），本条是独立的正则语义缺陷。

---

## BUG-4【中】Markdown link renderer 剥掉相对链接与 `mailto:`，工作区文件间跳转失效

### 位置

- `desktop/src/composables/useMarkdown.ts:34-36`：`isSafeHref` 只允许 `^https?://`
- `desktop/src/composables/useMarkdown.ts:95-102`：非 http(s) 直接 `return inner`，不生成 `<a>`

### 代码事实

`FileViewer.vue:50,119-141` 用 `MarkdownContent` 渲染工作区 Markdown；容器上的 `handleMarkdownClick` 从 `<a href>` 取链接，经 `resolveMarkdownLink` 解析相对路径后打开同工作区文件。`resolveMarkdownLink`（`desktop/src/utils/markdown-link.ts:27-56`）专门实现了 `./`、`../`、绝对路径与 `file://`；`isExternalMarkdownLink`（同文件 `:57-59`）与 `EXTERNAL_PROTOCOL_RE`（`:62`）都把 `mailto:` 明确当外链，交给 `ensureExternalLinkDelegation`（`utils/externalLink.ts:31`）走系统能力。

但 renderer 的 `isSafeHref` 只放行 http(s)，相对路径和 `mailto:` 都走 `return inner`，DOM 里根本没有锚点，点击事件无从触发。

### 触发条件

在中心区打开任意 Markdown 文件，文中含工作区相对链接（`[另一篇](./other.md)`、`[上级](../README.md)`）或邮件链接（`[邮件](mailto:a@b.com)`），点击链接。

### 期望 vs 实际

- 期望：渲染出 `<a href="./other.md">`，点击后由 `FileViewer` 打开 `other.md`；`mailto:` 由 `isExternalMarkdownLink` / 外链委托交给系统。
- 实际：`<p>另一篇</p>`、`<p>邮件</p>`，没有 `<a>`，点击无任何反应。

### 测试与真实失败输出

测试：`desktop/src/composables/markdown-link-href.bugcheck.test.ts`

```bash
cd desktop
npx vitest run src/composables/markdown-link-href.bugcheck.test.ts
```

未包裹 `it.fails` 时的失败输出（本次更新时实测）：

```text
FAIL  ... > BUG：工作区相对链接应保留 href，否则 FileViewer 点击无反应
AssertionError: expected '<p>另一篇</p>\n' to contain 'href="./other.md"'

FAIL  ... > BUG：mailto 应保留 href（isExternalMarkdownLink 明确把它当外链）
AssertionError: expected '<p>邮件</p>\n' to contain 'href="mailto:a@b.com"'

Test Files  1 failed (1)
     Tests  2 failed | 1 passed (3)
```

### 对照组

同文件 `[官网](https://example.com/a)` 保留 `href="https://example.com/a"` 并通过，证明 marked 配置、renderer 调用与测试构造正常，失败只发生在非 http(s) 分支。

### 影响

工作区 Markdown 文档之间的相对链接全部失效，`FileViewer` 的 `handleMarkdownClick`/`resolveMarkdownLink` 成了死代码；邮件链接也不可点。用户只能手动在文件树里找目标文件。

### 修复方向

把安全判定从「只允许 http(s)」改为「拒绝危险协议」：显式拦截 `javascript:`、`data:`、`vbscript:` 等，允许无 scheme 的相对/绝对路径与 `mailto:`；仍对 href 做 HTML 转义。为 `./`、`../`、`#anchor`、`mailto:`、`javascript:` 各补一条 renderer 测试。

安全性依据：`useMarkdown.ts:132-134` 的 `renderMarkdown` 出口统一过 `DOMPurify.sanitize`，其默认 `IS_ALLOWED_URI` 白名单已排除 `javascript:`/`data:` 等危险协议（dompurify `purify.cjs.js:325`），所以放开 renderer 层的协议白名单不会绕过消毒层。

### 查重说明

`2026-09-30-frontend-review-01.md:330` 只确认了 `isSafeHref` 参与 XSS 防线，没有检查它是否过度拦截；`2026-10-12-answer-citations-review-round1.md` 讨论的是引用打开路径复用 `isSafeHref`，与 Markdown link renderer 无关。

---

## BUG-5【中】系统通知 kind 白名单漏 `WEIXIN_REPLY_WINDOW_CLOSED` / `DAILY_DIGEST`

### 位置

- `desktop/src/composables/useInboxSystemNotify.ts:29-51`（`isInboxKindEnabled` 的 switch）
- 使用点：`desktop/src/composables/useInboxSystemNotify.ts:125`

### 代码事实

后端 `backend-ts/src/inbox/inbox.service.ts:503-532` 对这两个 kind 明确返回 `true`：

```ts
case 'WEIXIN_REPLY_WINDOW_CLOSED':
  // 无偏好开关：微信 24 小时窗口已关导致回复送达失败，属运维级事件，始终通知属主
  return true;
case 'DAILY_DIGEST':
  // 无收件箱 kind 偏好开关：总开关是 user_digest_preference.enabled
  return true;
```

桌面 `isInboxKindEnabled` 只列了 6 个有偏好开关的 kind 和 4 个固定 `true` 的 kind，上述两个 kind 落到 `default: false`。两端共享 `@mao/contracts` 的封闭 `InboxKind` 联合（`shared/contracts/src/inbox.ts:7-20`），枚举本身无分歧，分歧在桌面这份 switch 漏同步。

### 触发条件

Electron 窗口失焦/隐藏时，后端写入 `WEIXIN_REPLY_WINDOW_CLOSED`（定时任务回复超过微信 24 小时窗口）或 `DAILY_DIGEST`（每日摘要）收件箱条目；WS 推送触发 `notifyInboxSystemUpdate`。

### 期望 vs 实际

- 期望：与后端一致，这两类条目仍弹系统通知。
- 实际：`eligible` 过滤把它们剔除，不弹通知；站内收件箱条目和未读徽标仍正常。用户离开电脑时收不到「微信回复没送达」和日报提醒。

### 测试与真实失败输出

测试：`desktop/src/composables/inbox-notify-kind.bugcheck.test.ts`

```bash
cd desktop
npx vitest run src/composables/inbox-notify-kind.bugcheck.test.ts
```

未包裹 `it.fails` 时的失败输出（本次更新时实测）：

```text
FAIL  ... > BUG：微信 24h 窗口关闭属运维级事件，后端始终通知，桌面也应始终允许
AssertionError: expected false to be true // Object.is equality

FAIL  ... > BUG：每日摘要不受收件箱 kind 偏好门控，桌面也应始终允许
AssertionError: expected false to be true // Object.is equality

Test Files  1 failed (1)
     Tests  2 failed | 1 passed (3)
```

### 对照组

同文件 `TASK_COMPLETED` 在 `taskCompletedEnabled=false` 时返回 `false`、置 `true` 时返回 `true`，证明 switch 的偏好分支与测试数据正常。

### 影响

两类「错过就补不回来」的提醒在桌面端静默丢失：微信窗口关闭后回复永远不会自动送达，日报也不会重发；用户只能主动打开收件箱才能发现。站内数据不受影响，仅系统通知通道缺失。

### 修复方向

在 switch 中补 `case 'WEIXIN_REPLY_WINDOW_CLOSED':` 与 `case 'DAILY_DIGEST': return true`，与后端 `isKindEnabled` 保持同一枚举口径；更稳的做法是让两端共享 `ALWAYS_NOTIFY_KINDS` 集合，并用 `Record<InboxKind, ...>` 吃编译期穷尽。

### 查重说明

`2026-10-11-core-logic-bug-review-01.md` 的 BUG-2 修的是收件箱 store 的 `KNOWN_INBOX_KINDS`（条目可见性），不是系统通知的 kind 开关；`2026-10-04-task-inbox-review-03.md` 修的是通知 diff 基线，也未覆盖这两个 kind。本条是同一枚举在第三个消费点的漏同步。

---

## BUG-6【低】删除已归档会话时扣错分组计数桶

### 位置

- `desktop/src/stores/session/list.ts:606-620`（`deleteSession` 无条件 `bumpGroupMetaForSession(existing, -1)`）
- `desktop/src/stores/session/list.ts:226-238`（`bumpGroupMetaForSession` 只写 `groupMeta`，从不写 `archivedGroupMeta`）

### 代码事实

`deleteSession` 不区分会话当前 `status`：

```ts
if (existing) {
  bumpGroupMetaForSession(existing, -1)
}
```

而 `bumpGroupMetaForSession` 只更新活跃区 `groupMeta`。归档区计数只在 `fetchArchivedSessions`（`:361-381`）整体重建时写入；`archiveSession` 走的是「从活跃 -1，再静默刷新归档」的正确路径（`:292-320`，删除路径没有对应分支）。

### 触发条件

某分组同时存在活跃会话与已归档会话（例如同一 Agent 下既有进行中任务、也有已归档任务），在任务栏「已归档」区删除一条归档会话。

### 期望 vs 实际

- 期望：活跃区 `total` 不变；`archivedGroupMeta` 对应分组 `total - 1`，归档区徽标立即少 1。
- 实际：活跃区 `total` 被减 1（可减到 0，出现「有会话但计数为 0」）；归档区 `total` 保持原值（删完徽标仍是旧数字）。

### 测试与真实失败输出

测试：`desktop/src/stores/delete-archived.bugcheck.test.ts`

```bash
cd desktop
npx vitest run src/stores/delete-archived.bugcheck.test.ts
```

未包裹 `it.fails` 时的失败输出（本次更新时实测）：

```text
FAIL  ... > BUG：删除归档会话不应扣减活跃分组 total
AssertionError: expected +0 to be 1 // Object.is equality

FAIL  ... > BUG：删除归档会话应扣减归档分组 total（归档徽标数据源）
AssertionError: expected 2 to be 1 // Object.is equality

Test Files  1 failed (1)
     Tests  2 failed | 1 passed (3)
```

### 对照组

同文件删除前断言「活跃分组 1、归档分组 2」通过，证明 mock 的分组数据、`fetchSessions` / `fetchArchivedSessions` 装配与计数语义正确，差异只出现在删除路径。

### 影响

两个后果，均限当前会话内可见：

1. 归档区徽标（`TaskIndexPanel.vue:277-281` → `TaskArchivedSection.vue:13`）不减少，删完仍是旧数字；
2. 活跃分组 `total` 被少算，展开分组时 `canExpandGroup`（`:1051-1055`）用的是 `getGroupMeta(key)?.hasMore` 与本地列表长度，不直接读 `total`，因此**不影响**「加载更多」按钮的出现，但 `total` 本身与列表不一致。

两条都是状态一致性问题，不阻断删除本身，且重新 `fetchSessions` / `fetchArchivedSessions` 后会自愈，故定为低。

### 修复方向

`deleteSession` 按 `existing.status === 'ARCHIVED'` 分支：归档会话更新 `archivedGroupMeta`（同一 `cloudGroupKey`），活跃会话更新 `groupMeta`；或抽一个 `bumpGroupMeta(session, delta, bucket)` 统一处理。

### 查重说明

`docs/code-review/` 中与 `deleteSession` 相关的历史条目集中在后端级联清理、错误吞掉、运行态 Map 清理与重复点击；没有归档/活跃计数桶的记录。

---

## 已评估、未计入的候选

| 候选 | 结论 |
| --- | --- |
| `toMessageVO` 把纯文本 JSON 数组 `[1,2,3]` 解析成多模态并清空 `content`（`session-vo.ts:361-377`） | 真实可复现，但触发条件与 `2026-08-30-logic-bug-review-01.md` H-3、`2026-08-07-code-review-01/02.md` 的「合法 JSON 数组误判」同根因；正确修法是抽统一的 `isMultimodalContentParts` 判定，本轮不重复计入，建议后续按 H-3 残留一并修。 |
| 匿名分享链接过期后 `create` 仍返回旧链接（`session-share.service.ts:92-93`） | 行为可复现，但注释明确「已有未撤销行则原样返回」是幂等设计；是否算缺陷取决于产品是否接受「过期后需先撤销」的操作路径，存在设计争议，未计入。 |
| strict `PathSandbox` 祖先目录符号链接逃逸（`path-sandbox.ts:76-83`） | 安全边界问题，已由同轮并行调查确认可复现；与「功能逻辑 BUG」口径不同，且容器隔离系列文档需要单独的安全评审格式，未混入本文。 |
| `resolveMarkdownLink('docs/a.md','file:///home/u/x.md')` → `docs/home/u/x.md` | Unix `file:///` 绝对路径被当成相对路径；实测确认该错误输出。触发形态少见（工作区 Markdown 很少写 `file:///`），且与 BUG-4 同一函数、可随 BUG-4 一并修，未单列。 |
| 管理后台 `phaseLabel` 缺 `CANCELLING`，显示英文枚举（`admin/src/utils/labels.ts:8-16`） | 纯展示文案缺失，且 CANCELLING 展示口径已在桌面/后端系列中反复处理；价值低，未计入。 |
| `agent-cli` KeyDecoder 把 CSI `11~`–`19~` 误判为 Home（`keydecode.ts:174-177`） | `startsWith('1')` 前缀匹配过宽，F1–F8 会让光标跳到行首；影响低且只在 TUI 功能键场景，未计入。 |
| 定时任务 SKIP 策略落库 101 条，超过 `MAX_MISSED_PERSIST=100` | 环形缓冲保留 `maxPersist+1` 是为 RUN_ONCE 补跑点；SKIP 路径全量落库产生 off-by-one，影响很小，未计入。 |
| `formatTokens(999_999)` → `1000.00k` 而非 `1.00M` | 纯展示进位瑕疵，未计入。 |
| `open_web_page` 未复用 SSRF 校验、跟随重定向可访问内网 | 安全缺陷而非功能逻辑；需单独的安全评审与容器隔离前提确认，未计入。 |
| 会话列表 `title LIKE '%keyword%'` 未转义 `%`/`_` | 可能被视为「允许通配」的设计，假阳性风险中等，未计入。 |
| `shell` 工具 `keep_session` 只认严格 `true`，模型传 `"true"` 失效 | 低危健壮性问题；与其他工具 `asBool` 口径不一致，但触发依赖模型输出类型，未计入。 |

---

## 测试文件与复跑命令

| BUG | 测试文件 | 未修复时 |
| --- | --- | --- |
| BUG-1 | `desktop/src/utils/trace-token.bugcheck.test.ts` | 1 failed / 1 passed |
| BUG-2 | `backend-ts/src/harness/tool/impl/edit-crlf.bugcheck.spec.ts` | 1 failed / 1 passed |
| BUG-3 | `backend-ts/src/weixin/voice-sanitizer.bugcheck.spec.ts` | 1 failed / 1 passed |
| BUG-4 | `desktop/src/composables/markdown-link-href.bugcheck.test.ts` | 2 failed / 1 passed |
| BUG-5 | `desktop/src/composables/inbox-notify-kind.bugcheck.test.ts` | 2 failed / 1 passed |
| BUG-6 | `desktop/src/stores/delete-archived.bugcheck.test.ts` | 2 failed / 1 passed |

```bash
cd /opt/mao-data/workspace/2/projects/mao/backend-ts
npx vitest run src/harness/tool/impl/edit-crlf.bugcheck.spec.ts src/weixin/voice-sanitizer.bugcheck.spec.ts

cd /opt/mao-data/workspace/2/projects/mao/desktop
npx vitest run \
  src/utils/trace-token.bugcheck.test.ts \
  src/composables/markdown-link-href.bugcheck.test.ts \
  src/composables/inbox-notify-kind.bugcheck.test.ts \
  src/stores/delete-archived.bugcheck.test.ts
```

修复后（普通 `it`）的回归结果：

```text
backend-ts: Test Files 2 passed (2) / Tests 5 passed (5)
desktop:    Test Files 4 passed (4) / Tests 12 passed (12)
```

## 修复记录（2026-10-17）

用户确认后已完成全部 6 项修复，测试由 `it.fails` 转回普通断言：

| BUG | 修复点 | 回归测试 |
| --- | --- | --- |
| BUG-1 | `run-trace.service.ts`、`trace-display.ts`、`RunTracePanel.vue` 改为 `promptTokens + completionTokens`；同步修正旧测试中固化错误口径的 `165` / `2,140` 断言 | `trace-token.bugcheck.test.ts`、`run-trace.service.spec.ts`、`run-trace-panel-session.test.ts` |
| BUG-2 | 新增 `toLf`，CLOUD `edit_file` 与 LOCAL `handleEditFile` 匹配前统一 LF，写回仍 `applyEol` 保留 CRLF/BOM | `edit-crlf.bugcheck.spec.ts`、`agent-cli/test/local-files.spec.ts` |
| BUG-3 | 语音清洗改为成对强调正则，保留 snake_case / dunder 标识符 | `voice-sanitizer.bugcheck.spec.ts`、`voice-text-sanitizer.spec.ts` |
| BUG-4 | `isSafeHref` 放行相对路径与 `mailto:`，继续拒绝 `javascript:`/`data:` 等显式协议 | `markdown-link-href.bugcheck.test.ts`、`useMarkdown.citations.test.ts` |
| BUG-5 | 系统通知 kind 白名单补齐 `WEIXIN_REPLY_WINDOW_CLOSED`、`DAILY_DIGEST` | `inbox-notify-kind.bugcheck.test.ts`、`useInboxSystemNotify.test.ts` |
| BUG-6 | 分组计数按会话状态写入活跃/归档桶 | `delete-archived.bugcheck.test.ts`、`session.test.ts` |

验证结果：

```text
backend-ts:  Test Files 344 passed | 1 skipped / Tests 4109 passed | 14 skipped
desktop:     Test Files 73 passed / Tests 647 passed
agent-cli:   Test Files 41 passed / Tests 519 passed

backend-ts npm run build     通过
desktop    npm run build     通过
agent-cli  npm run build     通过
```

## 变更与边界

- 产品代码修复：`run-trace.service.ts`、`trace-display.ts`、`RunTracePanel.vue`、`edit-file-tool.ts`、`file-eol.ts`、`voice-text-sanitizer.ts`、`useMarkdown.ts`、`useInboxSystemNotify.ts`、`stores/session/list.ts`、`agent-cli/src/local/tools/files.ts`。
- 同步修正固化错误口径的旧测试：`trace-display.test.ts`、`run-trace.service.spec.ts`、`run-trace-panel-session.test.ts`；新增 6 个 `*.bugcheck.*` 回归文件与 LOCAL CRLF 多行用例。
- 已写入 `CHANGELOG.md` 顶部 `0.0.304 (2026-10-17)`。
- 未提交、未推送、未部署。
