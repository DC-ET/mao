# 回复引用溯源（Answer Citations）技术方案

> 状态：待评审（9 项用户决策已确认，见 §10）
> 日期：2026-10-12
> 上游提案：[docs/proposals/2026-10-12-answer-citations.md](../proposals/2026-10-12-answer-citations.md)
> 覆盖端：后端 backend-ts、桌面端 desktop。契约 shared/contracts、管理后台 admin、数据库迁移均**不改**。

---

## 1. 需求背景

Agent 说「根据最新公告，截止时间是 11 月 30 日」时，用户没有任何办法验证这句话的来源——是 `web_search` 搜到的第 3 条结果、`open_web_page` 抓的页面原文，还是模型自己编的。工具结果里明明带着 URL，但最终回复是纯 markdown 文本，来源信息在消息渲染时被完全丢弃。私有化部署的用户把回答转给同事 / 客户前，只能复制一句话去手动搜索比对。

本方案落地「回复引用溯源」：系统提示词约定模型用 `[^n^]` 行内标记外部信息来源；每轮任务完成时，后端从本轮 `web_search` / `open_web_page` 的工具结果构建 URL 白名单（registry），对标记做白名单校验——**对不上的标记一律剥掉，模型编造的 URL 到不了用户眼前**；校验通过的引用随最终回复消息落库，桌面 / Web / 安卓三端与只读分享页在消息末尾渲染可点击的「来源」区。

相邻边界：不是 RAG / 知识库（不做语料检索，只把本轮已拿到的 URL 结构化呈现）；不是 Evals（不评估引用准确率指标）；不是运行轨迹（轨迹向过去看、供排障，引用嵌在回复里、面向读者）。

### 1.1 现状代码事实（实施前已核对）

| 事项 | 现状 | 本方案的用法 |
|---|---|---|
| `message` 表结构 | `V001__init_schema.sql:162`，已有 `metadata` JSON 列（注释「扩展元数据」，当前承载 TOOL 消息的 attachments / approvalMark / resultTruncated） | citations 写入**最终 ASSISTANT 消息**的 `metadata.citations`，**零迁移**（决策 5） |
| metadata 落库 / 更新 | `session.repository.ts:492` `insert(message)` 与 `updateById(message)` 均已含 `metadata` 字段；`Message` 类型有 `metadata` | 最终回复落库时 metadata 为 null，本方案用读-改-写方式 UPDATE，不依赖 insert 时写入 |
| MessageVO 透传 | `session-vo.ts:98`（接口声明）与 `:323`（映射）均含 `metadata: message.metadata` | 桌面端与分享页天然拿到 citations，无需改 VO |
| JSONL 导出 | `session-export.service.ts` → `message-jsonl.ts:41` `sanitizeMetadata(metadata)` 保留非 base64 图片键 | citations 随导出天然保留，零改动（P2 只做验证） |
| 只读分享快照 | `session-share.service.ts` 的 `ShareViewPayload.messages` 就是 `MessageVO[]`；桌面 `views/share/ShareView.vue:11` 直接复用 `ChatRoundList` | 分享页与主会话同一渲染组件，来源区自动生效（决策 8） |
| 最终回复落库 | `harness-service.ts:153` `persistFinalAssistant`（ASSISTANT、无 tool_calls、`metadata: null`，返回插入 id） | 不在此处写 citations：persistence callback 拿不到「本轮全部工具结果」（§1.2 修正 5） |
| 相位收敛点 | `task-terminal.service.ts:79` `finishExecution(phase)`；`:136-149` 依次调 `recordInbox` / `dispatchOutboundEvent` / `settleBudgetWarn` / `dispatchMemoryExtraction`（后者 `:278` 仅 COMPLETED，void 调用不 await） | citation registry 构建挂 `finishExecution` 的 COMPLETED 分支，与 `dispatchMemoryExtraction` 并列，void + try-catch（决策 4） |
| `finishExecution` 调用方 | `create-app.ts:2079`（WS 直跑/排队统一入口）、`schedule/scheduled-task.service.ts:721/742`、`openapi/open-run.service.ts:166`、`dingtalk/runtime.ts:315`、`create-app.ts:1872`（CANCELLED） | 所有入口共用同一收敛点，主会话 / 边路 / 子代理 / 定时 / 开放 API 触发全部覆盖 |
| 最后一条助手消息查询 | `session.repository.ts:749` `selectLastAssistantMessage(sessionId)`：role=ASSISTANT、content 非空、按 id DESC LIMIT 1（记忆抽取同款） | 直接复用，作为 citations 的挂载消息行 |
| `web_search` 结果格式 | `harness/tool/impl/web-search-tool.ts:88` `toJson({ query, results: [{title, url, content}], total_results })`；失败 `errorJson(msg)` 即 `{error}` | registry 解析 `results[]` 的 title/url；含 `error` 顶层键的视为失败，跳过 |
| `open_web_page` 结果格式 | `harness/tool/impl/open-web-page-tool.ts:130` `toJson({ url, title, content, content_length, truncated, ... })`；失败 `errorJson(msg, url)` 即 `{error, url}` | 以存在字符串 `content` 判定成功；失败形态只有 `{error, url}`，不进 registry |
| 工具名常量 | `harness/tool/tool-dispatcher.ts:59` `SERVER_ONLY_TOOLS` 含 `'web_search'`、`'open_web_page'`；工具 `getName()` 返回同名蛇形 | 白名单按这两个工具名过滤 |
| 系统提示分节 | `harness/core/prompt-engine.ts:236` `buildSystemPromptSections` 返回 `PromptSection[]`（key/label/text）；`:101` `INJECTED_SECTION_KEYS` 只列注入型分节，固有文案聚合为「系统提示词」单节进 manifest | 新增 `citation-contract` 固有分节，不进 `INJECTED_SECTION_KEYS`，manifest 结构零变化 |
| 提示词不变量测试 | `prompt-engine.spec.ts:443`「system sections join equals the system message content」：断言 `toContain` 各节原文 + manifest keys 等于 `['experiences','memories','system-prompt','tool-definitions','messages']`，**非 golden 全文** | 加分节不破坏该不变量；keys 列表不变（新节聚合进 system-prompt） |
| 桌面 markdown 渲染 | `desktop/src/composables/useMarkdown.ts`：marked 实例 + 自定义 `renderer.text/html/code/link` + `DOMPurify.sanitize(result, { ADD_ATTR: ['target'] })` | 在 `renderer.text` 内把 `[^n^]` 替换为 `<sup class="cite-ref">`；code/codespan/link 不经 text renderer，代码块内标记不受影响；`sup` 与 `class` 在 DOMPurify 默认白名单内 |
| 桌面消息 metadata 解析范式 | `desktop/src/utils/chatMessage.ts` 的 `extractToolPreviewFromMetadata` / `extractApprovalMarkFromMetadata` / `extractResultTruncatedFromMetadata`：string 则 JSON.parse、try-catch、按键提取 | 新增同款 `extractCitationsFromMetadata`，返回 `Citation[]` |
| `ChatMessage` 类型 | `desktop/src/types/chat.ts:69` 已有 `metadata?: Record<string, unknown>` | 无需改类型；注意 VO 侧是 JSON **string**，解析走 `extractCitationsFromMetadata` 的 string 分支 |
| 渠道最终文本入口 | `create-app.ts:1898` `getLatestAssistantReply` lambda（飞书 `agent-inbound-handler.ts:286/660`、钉钉 `agent-inbound-handler.ts:303/346` 共用）；`weixin/agent-inbound-handler.ts:213` 内部同款方法；`feishu/card-progress-listener.ts:42` `onContentDelta` 累积 + `:94` `complete(finalContent)` | 渠道剥离去这三个入口（§5.6） |
| 出站事件 payload | `task-terminal.service.ts:243` `dispatchOutboundEvent` → `dispatchTaskTerminal({ userId, sessionId, phase, executionId, title, failureReason, source })`，**不含回复正文** | 出站订阅无需剥离 |
| 导出格式 | 项目只有 JSONL 导出（`session-export.service.ts`），**没有 Markdown 导出** | 提案 P2 的「Markdown 导出带来源」不存在对应功能，取消（§1.2 修正 8） |

### 1.2 上游提案的修正（本方案对提案的实质变更）

1. **V150 新列取消，改 metadata JSON，零迁移**（决策 5）：提案 §3.1 的 `ALTER TABLE message ADD citations_json` 作废。metadata 列已在 insert/update、VO、JSONL 导出、分享快照四条链路天然透传，新列反而要在三处各加映射。
2. **用户级开关取消**（决策 6）：提案 §3.5 的「设置 → 通用总开关」不做。引用契约是几十 token 的固有提示词、来源区仅在有 citations 时出现，无骚扰面；不为零成本行为加管理面。历史消息的 citations 保留即保留，无开关可关。
3. **registry 来源收紧**（决策 1）：只收 `web_search` / `open_web_page` 两个工具结果中的 URL；其他工具（图片生成、文件、MCP）的 URL 与用户消息里粘贴的 URL 都不进白名单。
4. **编号权在系统**（决策 2）：模型只插 `[^n^]`，n 即 registry 序号（registry[0] ↔ `[^1^]``）。校验规则极简：`n ∈ [1, registry.length]` 保留，否则剥；模型跳号 / 重复 / 乱序均被容忍或清洗，后端不做重编号。
5. **挂载点从「最终回复落库时」改为 TASK_COMPLETED 相位**（决策 4）：`persistFinalAssistant` 的 persistence callback 只能看到当前轮的 `toolResults`，拿不到整轮任务的全部工具结果；改挂 `finishExecution` 的 COMPLETED 分支，届时全部消息已落库，按消息边界圈定范围即可。
6. **标记原文保留 + 共享剥离函数**（决策 7）：content 里的 `[^n^]` 不动（JSONL 导出离线可读、metadata 另有结构化数据）；桌面渲染层转换、渠道发送前用同一个 `stripCitationMarkers()` 剥掉。
7. **分享页渲染来源区**（决策 8）：`ShareView.vue` 复用 `ChatRoundList`，随主会话一起生效。
8. **「Markdown 导出带来源」取消**：项目不存在 Markdown 导出，JSONL 导出已随 metadata 天然携带 citations。
9. **P3 管理后台引用覆盖率统计不做**（决策 9）：交付范围为 P1（registry 校验 + 契约 + 三端渲染 + 渠道剥离 + 分享页）+ P2（导出 / 快照验证）。

---

## 2. 需求描述

### 2.1 要做的

1. **提示词契约**：`prompt-engine.ts` 新增固有分节「引用规范」——模型从 `web_search` / `open_web_page` 获取外部信息并在回复中引用时，在句末插入 `[^n^]`；n 从 1 开始，按该来源在本轮中首次被引用的顺序编号，对应当轮工具结果返回来源的顺序；没有来源支撑的说法不得插标记；只引用本轮工具获取的来源，不得引用对话历史里更早轮次的来源；不得编造或改写 URL。分节位置在「工具指引」之后。同时在 `web-search-tool.ts` / `open-web-page-tool.ts` 的 description 末尾各加一句强化（「引用本工具结果时使用 `[^n^]` 标记」）。
2. **本轮范围圈定**：以「最后一条 USER 消息的 id」为下界，取该会话中 id 更大的全部 TOOL 消息为本轮工具结果；同时扫描这些消息之前的 ASSISTANT 消息的 `tool_calls`，建立 `toolCallId → 工具名` 映射，只保留映射为 `web_search` / `open_web_page` 的 TOOL 消息。
3. **registry 构建**：对命中的 TOOL 消息解析 content JSON：`web_search` 取 `results[].{title,url}`；`open_web_page` 取 `{url,title}`（以存在字符串 `content` 判定成功，`{error,url}` 失败形态跳过）。按 url 去重、保序（按消息顺序），上限 **20 条**，超出部分截断（服务端记 debug 日志，不打扰用户）。
4. **标记解析与白名单校验**：扫描最终回复文本中的 `[^n^]`：n 在 `[1, registry.length]` 且 registry[n-1] 存在 → 保留；其余（含伪造 URL 场景——伪造 URL 进不了 registry，标记自然被剥）一律从**展示与 citations 数据**中剔除。content 原文不动。
5. **citations 落库**：向最终 ASSISTANT 消息（`selectLastAssistantMessage`）的 `metadata` 写入 `citations` 数组——**只含被引用条目**，每条 `{ n, url, title }`，n 保留 registry 原序号、不重编号，数组顺序即 registry 顺序。读-改-写合并（不覆盖 metadata 的其他键）。无任何标记被保留时不写（保持 metadata 原值）。
6. **挂载与容错**：registry 构建挂在 `finishExecution` 的 COMPLETED 分支，与 `dispatchMemoryExtraction` 并列：void 调用、内部 try-catch，失败只记 warn 日志，不影响收敛主链路、不影响收件箱 / 预算 / 出站 / 记忆。不按 sessionType 过滤——主会话、边路任务、子代理会话各自独立构建、天然隔离。
7. **三端渲染**：`renderer.text` 把 `[^n^]` 转成 `<sup class="cite-ref" data-n="n">`，上标文案 = 该 n 在 citations 数组中的位置 +1（展示序号 1..k 紧凑连续；registry 序号与展示序号的差异只有内部可见）；点击上标平滑滚动到本条消息的来源区并高亮对应条目（事件委托，对齐 `ensureExternalLinkDelegation` 范式）。`MessageBubble.vue` 在正文后渲染折叠「来源 N」区：条目 = 展示序号 + 标题（超 60 字截断，无标题显示域名 + 路径）+ 域名徽标；点击经 `openExternal` 外跳（复用 `isSafeHref` 仅 http/https）。
8. **分享页**：`ShareView` 经 `ChatRoundList` 自动获得同款来源区，无独立改动。
9. **渠道剥离**：新增共享 `stripCitationMarkers(text)`，在渠道最终文本出口与流式卡片累积处调用，飞书 / 钉钉 / 微信三渠道的最终回复不出现 `[^n^]` 字样。
10. **P2 验证**：JSONL 导出行含 `metadata.citations` 且 sanitize 不破坏；分享快照往返后引用不丢。

### 2.2 不做的

| 项 | 说明 |
|---|---|
| 用户级 / Agent 级 / 单会话级开关 | 契约与渲染常开，无设置项、无偏好列（决策 6） |
| `message.citations_json` 新列（V150） | 改走 metadata JSON，零迁移（决策 5） |
| 非联网工具的 URL 来源 | 图片生成、文件操作、MCP 等工具的 URL 不进 registry（决策 1） |
| 用户消息里粘贴的 URL | 用户自带来源不需要模型引用校验，不进 registry（决策 1） |
| 引用内容的语义核对 | 不判断「这句话是否真的支持该结论」，只保证 URL 真实出现在本轮工具结果中 |
| 链接健康巡检 | 不定期 HEAD 探测源站存活；哨兵已是通用探针设施但不复用做引用巡检 |
| 跨轮次引用 | 契约明确只引用本轮来源；模型引用更早轮次的来源时标记被剥（内容仍保留） |
| 渠道消息渲染来源区 | 飞书 / 钉钉 / 微信 / Embed 只发纯文本，标记剥离（决策 7） |
| Markdown 导出 | 项目不存在该功能；JSONL 导出天然携带 citations |
| 管理后台引用覆盖率统计 | P3 整体不做（决策 9） |
| Agent 级「强制引用」开关 | 随 P3 一起不做 |
| registry 上限可配 | 固定 20，不做系统设置项 |
| 记忆携带引用 | 记忆抽取只读 message content，citations 在 metadata 中，天然不进入记忆；不做额外联动 |
| `shared/contracts` 改动 | citations 是消息 metadata 的展示层结构，不进跨端契约（桌面端自解析） |
| 管理后台改动 | 无统计页、无新权限码 |

---

## 3. 技术选型

| 决策点 | 选型 | 理由 |
|---|---|---|
| 持久化载体 | 最终 ASSISTANT 消息的 `metadata.citations`（JSON） | 零迁移；insert/update、VO、JSONL 导出、分享快照四链路已透传 metadata；与 attachments / approvalMark 同通道 |
| registry 构建时机 | `finishExecution` COMPLETED 分支，void + try-catch | 与记忆抽取 / 预算结算并列在同一收敛点，全部消息已落库；失败隔离不阻断主链路； persistence callback 拿不到全轮工具结果，故不选落库时同步构建 |
| 本轮范围圈定 | 最后一条 USER 消息 id 之后的所有 TOOL 消息 + 其前的 ASSISTANT tool_calls 映射 | 消息 id 单调递增，无需 execution_id；压缩 / 分叉不改变「USER 之后」的语义 |
| 工具结果成功判定 | `web_search`：解析出 `results` 数组；`open_web_page`：存在字符串 `content` | 两工具的失败形态分别是 `{error}` 与 `{error,url}`，按成功形态的存在性判定最稳 |
| 编号权 | 系统（registry 序号），模型只插标记 | 后端校验规则极简（范围检查），模型跳号 / 乱序被容忍；模型自编号会把错乱处理逻辑全压给后端 |
| citations 数组口径 | 只含被引用条目；n 保留 registry 原序号；展示序号 = 数组下标 +1 | 后端零重编号；来源区只列真正被引用的（提案原文要求）；前端一次 find 完成标记→条目映射 |
| 标记 → 上标转换 | marked `renderer.text` 内正则替换 + DOMPurify 消毒 | code / codespan / link 不经 text renderer，代码块内标记天然不受影响；流式期间半个标记匹配不到完整模式不替换，完整后自然显示 |
| 上标点击滚动 | 事件委托 + `scrollIntoView` + 高亮 class | 对齐 `ensureExternalLinkDelegation` / `ensureCodeCopyDelegation` 既有范式，不逐节点绑事件 |
| 渠道剥离位置 | `getLatestAssistantReply` 两个实现（`create-app.ts:1898` lambda、`weixin/agent-inbound-handler.ts:213`）+ 飞书卡片 `displayContent()` | 前者覆盖飞书 / 钉钉的最终文本与 reply 兜底；后者覆盖流式进度卡片；出站事件 payload 不含正文，无需处理 |
| 共享函数位置 | 后端 `session/util/citation-markers.ts`；桌面 `desktop/src/utils/citationMarkers.ts` 各一份 | 标记语法是纯展示层约定；`shared/contracts` 按约定只导纯类型，不放运行时常量与函数 |

---

## 4. 数据模型

**零迁移。** `message.metadata`（JSON 列）新增一个顶层键，结构与既有键（attachments / approvalMark / resultTruncated）并列：

```jsonc
// 最终 ASSISTANT 消息的 metadata（示例：registry 5 条，引用了第 1、3 条）
{
  "citations": [
    { "n": 1, "url": "https://example.com/notice", "title": "关于调整申报截止时间的通知" },
    { "n": 3, "url": "https://gov.example.cn/policy/2026", "title": "2026 年度申报指南" }
  ]
}
```

- `n`：registry 序号（1 起），与正文 `[^n^]` 对应；数组只含被引用条目，顺序 = registry 顺序。
- `url` / `title`：来自工具结果原文；title 缺失时为空串（前端回落域名 + 路径）。
- 无被引用标记时不写该键，metadata 保持原值（最终回复消息当前为 null）。
- 上限：数组长度 ≤ 20（registry 上限）。
- 兼容：老消息无该键，前端 `extractCitationsFromMetadata` 返回空数组，不渲染来源区。

---

## 5. 实现设计

### 5.1 共享标记工具 `session/util/citation-markers.ts`（后端）

```ts
const CITATION_MARKER = /\[\^(\d+)\^\]/g;

/** 剥掉全部 [^n^] 标记（渠道发送前调用；剥后不留双空格——标记紧贴句末时后面通常紧跟标点或换行，直接删字符即可） */
export function stripCitationMarkers(text: string): string;

/** 按出现顺序提取全部标记的 n（含越界的，越界由调用方过滤） */
export function extractCitationMarkers(text: string): number[];
```

- 正则全局、lastIndex 每次调用前重置（模块级正则复用必须 `g` 配手动重置或每次新建——实现取每次 `new RegExp` 或 `String.prototype.matchAll`，避免共享 lastIndex 竞态）。
- 单测覆盖：无标记、单个、连续多个（`[^1^][^2^]`）、乱序（`[^2^]` 先于 `[^1^]`）、越界（`[^9^]`）、非数字（`[^a^]` 不匹配）、代码块内的标记（strip 会剥——渠道侧代码块里的 `[^1^]` 也被剥，可接受：那是模型行文，不是真引用）、空串。

### 5.2 registry 构建与校验 `session/message-citations.ts`（后端，新文件）

```
buildAndStoreCitations(sessionId, finalAssistantMessageId, updater):
  1. lastUserId = 最后一条 USER 消息 id（repository 增 selectLastUserMessageId 或复用现有查询）
  2. rows = 该会话 id > lastUserId 的全部消息（ASSISTANT + TOOL，按 id ASC）
  3. toolNames = 从 ASSISTANT 行解析 tool_calls JSON → Map<toolCallId, function.name>
  4. registry = []
     for TOOL 行（tool_call_id 命中 web_search / open_web_page）:
       obj = JSON.parse(content)（失败跳过）
       web_search:    obj.results[] → push {url, title}（url 为空跳过）
       open_web_page: typeof obj.content === 'string' → push {url: obj.url, title: obj.title}
     按 url 去重保序，截断 20
  5. markers = extractCitationMarkers(最终回复 content)
     cited = markers.filter(n => n >= 1 && n <= registry.length).map(n => registry[n-1])
     去重（同一 n 多次出现只算一次）、按 n 升序
  6. cited 为空 → 不写，返回
  7. metadata = 读最终消息 metadata → parse → merge { citations: cited.map(c => ({n, url, title})) } → UPDATE message SET metadata=? WHERE id=?
```

- 依赖：`session.repository.ts` 增两个小查询（`selectLastUserMessageId`、`selectMessagesAfterId`）或复用现有 `listBySession` 在内存过滤——轮次消息量小（几十条），**取后者**：复用 `listBySession(sessionId)` 现成方法，零新查询，内存过滤更简单。
- 依赖：`selectLastAssistantMessage`（现成）定位最终回复行。
- `message-citations.spec.ts`：registry 构建（两工具混合、去重保序、上限截断、失败形态跳过、非 JSON 跳过）、标记校验（越界剥、乱序容忍、重复引用去重）、metadata 合并（不覆盖既有键、空 cited 不写）。

### 5.3 TASK_COMPLETED 挂载 `task-terminal.service.ts`

- 新增私有方法 `dispatchCitationRegistry(session, phase)`，紧挨 `dispatchMemoryExtraction`（`:278`）之后定义与调用：
  - `if (phase !== 'COMPLETED') return;`
  - `if (session.id == null) return;`
  - void 调用（不 await），方法内 try-catch：`console.warn('[citations] failed to build registry: sessionId=..., error=...')`。
- 与 `dispatchMemoryExtraction` 的差别：不筛 sessionType（子代理 / 边路会话同样构建，各自隔离）。
- 装配：构造注入 `SessionService`（已注入，记忆抽取同款依赖）。

### 5.4 提示词契约 `prompt-engine.ts`

- 文件顶部常量区新增 `CITATION_CONTRACT`（固有文案，约 150 字）：

  ```
  ## 引用规范

  当你使用 web_search 或 open_web_page 获取外部信息并在回复中引用时，必须在被支撑的句末插入 [^n^] 标记：n 从 1 开始，按该来源在本轮首次被引用的顺序编号，对应工具结果返回来源的顺序。没有来源支撑的说法不得添加标记；只引用本轮工具获取的来源，不得引用更早轮次或对话历史中的来源；不得编造或改写来源地址。
  ```

- `buildSystemPromptSections` 中 `tools-usage` 分节之后 `sections.push({ key: 'citation-contract', label: '引用规范', text: CITATION_CONTRACT })`。
- **不**加入 `INJECTED_SECTION_KEYS`（固有文案，manifest 聚合进「系统提示词」单节，上下文透视无结构变化；`prompt-engine.spec.ts:466` 的 keys 断言不变）。
- 工具描述强化：`web-search-tool.ts` / `open-web-page-tool.ts` 的 `getDescription()` 末尾追加「引用本工具结果时使用 `[^n^]` 标记（编号规则见系统提示词引用规范）。」——注意 `prompt-engine.spec.ts` 对 tools 列表只断言 name，description 变动不破坏既有用例。

### 5.5 桌面端渲染 `desktop`

1. **`utils/citationMarkers.ts`**（新文件）：`CITATION_MARKER` 正则 + `stripCitationMarkers`（导出用）+ `renderCitationMarkers(html)`（把 `[^n^]` 替换为 `<sup class="cite-ref" data-n="n">[k]</sup>`，k 由调用方给的映射决定）。
2. **`composables/useMarkdown.ts`**：`renderer.text({ text })` 内调用转换。展示序号需要 citations 数组——renderer 是实例级共享的（`markedCache` 按主题缓存），不能把 per-message 状态存在实例上。做法：text renderer 输出 `<sup class="cite-ref" data-n="n">[n]</sup>`（先保留 registry 序号），渲染完成后由调用方（MessageBubble）对容器做一次 DOM 后处理，把 `[n]` 文案改写为展示序号并绑 data 属性；或更简单——**renderer 只负责把标记变成带 `data-n` 的 sup，文案统一为 `[n]`（registry 序号），来源区条目也用同一 n 编号**。评审取舍：展示序号与 registry 序号不一致会让读者困惑（来源区列 2 条而上标出现 [^3^]）。
   - **定稿：上标与来源区统一用展示序号（1..k）**。实现：`MessageBubble` 先 `extractCitationsFromMetadata` 得到 citations（n 升序即展示序），把「registry n → 展示 k」映射随消息传入渲染——renderer 实例不存状态，改为 `renderMarkdown(text, isDark, citeMap?)` 可选参数，text renderer 内经闭包捕获 citeMap 做替换；无 citeMap 时退化为剥标记（纯文本）。`renderInlineMarkdown` 同样加可选参数。
3. **`utils/chatMessage.ts`**：新增 `extractCitationsFromMetadata(metadata: unknown): Citation[]`——string 则 JSON.parse、try-catch、取 `citations` 数组、逐条校验 `n` 为正整数、`url` 为 http/https 字符串、`title` 为字符串（缺失回落 ''）；非法条目跳过。`Citation` 类型定义在 `desktop/src/types/chat.ts`（`{ n: number; url: string; title: string }`）。
4. **`components/chat/MessageBubble.vue`**：computed `citations`；模板在正文渲染块之后、文件变更面板之前追加来源区（`v-if="citations.length > 0 && role === 'assistant'"`）：
   - 折叠头「来源 N」（N = citations.length），默认展开（引用是信任构件，折叠会增加验证成本；仅当 N ≥ 4 时默认折叠）。
   - 条目：`[k] 标题（截断 60）+ 域名徽标`，点击 `openExternal(url)`。
   - 上标点击：事件委托 `@click` 于消息根节点，匹配 `.cite-ref` → 找到来源区对应条目 `scrollIntoView({ behavior: 'smooth', block: 'nearest' })` + 加 `cite-flash` class（对齐既有的 `locateFlashId` 高亮范式），1.6s 后移除。
   - 深色模式：来源区样式走既有 CSS 变量，不写死颜色。
5. **回归面**：`ChatRoundList.test.ts`（现成组件测试）补用例：有 / 无 citations 两种消息的渲染；分享页 `ShareView` 复用同一组件自动覆盖。

### 5.6 渠道剥离

- `create-app.ts:1898` `getLatestAssistantReply` lambda：返回前 `stripCitationMarkers(text)`（覆盖飞书 / 钉钉的 `complete()` 与 reply 兜底两条路径）。
- `weixin/agent-inbound-handler.ts:213` 内部 `getLatestAssistantReply(messages)`：同款剥离。
- `feishu/card-progress-listener.ts`：`displayContent()` 返回前剥离（覆盖 `onContentDelta` 流式累积后的一切卡片刷新：`onToolCallStart` / `onRoundEnd` / `queue`）。`complete(finalContent)` 的 finalContent 来自 `getLatestAssistantReply`（已剥），无需重复。
- 钉钉进度卡片：`dingtalk/agent-inbound-handler.ts:303/346` 的 text 同样来自已剥的 `getLatestAssistantReply`；若存在独立的流式累积 listener，按飞书同款处理（实施时确认）。

### 5.7 导出与分享（P2，验证为主）

- JSONL：`message-jsonl.ts:41` 已随行导出 metadata；`sanitizeMetadata` 只替换 base64 图片 data-uri，不动 citations 键。**零改动**，补一条导出用例断言 citations 在。
- 分享：`ShareView` → `ChatRoundList` → `MessageBubble` 全链路复用，来源区自动生效；补分享页渲染用例。
- 分享快照的「消息水位冻结」语义不受影响：citations 是消息行的 metadata，水位之后的引用变化不产生新消息行。

---

## 6. 实现步骤

1. **后端工具层**：`session/util/citation-markers.ts` + 单测（正则边界、lastIndex 安全）。
2. **后端构建层**：`session/message-citations.ts` + 单测（registry 解析、去重保序、上限、失败形态、标记校验、metadata 合并）。
3. **挂载**：`task-terminal.service.ts` 加 `dispatchCitationRegistry`（COMPLETED、void、try-catch）；`task-terminal.service.spec.ts` 补：COMPLETED 触发构建、FAILED 不触发、构建抛错不收敛失败。
4. **提示词**：`prompt-engine.ts` 加分节 + 两工具 description 强化；`prompt-engine.spec.ts` 既有不变量全绿 + 补一条「系统消息含引用规范原文」。
5. **桌面工具层**：`utils/citationMarkers.ts`、`utils/chatMessage.ts` 的 `extractCitationsFromMetadata`、`types/chat.ts` 的 `Citation` + 各自单测。
6. **桌面渲染层**：`useMarkdown.ts` 的 citeMap 参数与 text renderer；`MessageBubble.vue` 来源区 + 上标点击 delegated 高亮；`ChatRoundList.test.ts` 补用例。
7. **渠道剥离**：`create-app.ts` lambda、weixin handler、feishu card listener 三处 + 各自的既有 spec 补「输出无 [^n^]」。
8. **P2 验证**：JSONL 导出用例、分享页用例。
9. **构建验证**：`cd backend-ts && npm run build && npm test`；`cd desktop && npm run build`（AGENTS.md：vue-tsc -b，勿用 npx vue-tsc --noEmit）。
10. **文档**：CHANGELOG（新版本条目，前端 + 后端小节）、README 核心能力表「工具与扩展」或「Harness 引擎」行补一句、USER_GUIDE 桌面手册、mao-cli reference（desktop.md / project.md 二选一或都补）。

---

## 7. 落地清单

### 后端 backend-ts

| 文件 | 改动 |
|---|---|
| `src/session/util/citation-markers.ts` | **新建**：`stripCitationMarkers` / `extractCitationMarkers` |
| `src/session/util/citation-markers.spec.ts` | **新建**：单测 |
| `src/session/message-citations.ts` | **新建**：registry 构建 + 标记校验 + metadata 合并 |
| `src/session/message-citations.spec.ts` | **新建**：单测 |
| `src/session/task-terminal.service.ts` | 加 `dispatchCitationRegistry` 私有方法并在 `finishExecution` COMPLETED 分支调用 |
| `src/session/task-terminal.service.spec.ts` | 补挂载用例（触发 / 不触发 / 容错） |
| `src/harness/core/prompt-engine.ts` | 加 `CITATION_CONTRACT` 常量与 `citation-contract` 分节（tools-usage 之后） |
| `src/harness/core/prompt-engine.spec.ts` | 既有不变量回归 + 补「系统消息含引用规范」 |
| `src/harness/tool/impl/web-search-tool.ts` | `getDescription()` 末尾加引用强化句 |
| `src/harness/tool/impl/open-web-page-tool.ts` | `getDescription()` 末尾加引用强化句 |
| `src/create-app.ts` | `getLatestAssistantReply` lambda（`:1898`）返回前剥离 |
| `src/weixin/agent-inbound-handler.ts` | 内部 `getLatestAssistantReply`（`:213`）剥离 |
| `src/feishu/card-progress-listener.ts` | `displayContent()` 剥离 |
| `src/session/message-jsonl.ts` / `session-export.service.ts` | **不改**（P2 仅补导出验证用例） |
| `db/migration/` | **无新迁移** |

### 桌面端 desktop

| 文件 | 改动 |
|---|---|
| `src/utils/citationMarkers.ts` | **新建**：正则 + `renderCitationMarkers` + `stripCitationMarkers`（导出路径备用） |
| `src/utils/chatMessage.ts` | 加 `extractCitationsFromMetadata` |
| `src/types/chat.ts` | 加 `Citation` 接口 |
| `src/composables/useMarkdown.ts` | `renderMarkdown` / `renderInlineMarkdown` 加可选 citeMap 参数；`renderer.text` 内转换 |
| `src/components/chat/MessageBubble.vue` | 来源区 + 上标点击委托高亮 + 样式 |
| `src/components/chat/ChatRoundList.test.ts` | 补渲染用例 |
| `src/views/share/ShareView.vue` | **不改**（复用 ChatRoundList 自动生效） |
| 各 spec（chatMessage / citationMarkers / useMarkdown 若有） | 补单测 |

### 不改

- `shared/contracts`：citations 不进跨端契约。
- `admin`：无管理面改动。
- 数据库：零迁移（提案的 V150 作废）。
- `agent-cli`（mao-agent）：终端 REPL 不做来源区渲染；渠道剥离不涉及（CLI 不是渠道）——**CLI 输出会保留 `[^n^]` 原文**，与桌面导出同口径，可接受。

### 文档

- `CHANGELOG.md`：新 `## 0.0.x (日期)` 条目，前端小节（三端来源区 + 上标）+ 后端小节（registry 校验 + 提示词契约 + 渠道剥离）。
- `README.md`：核心能力表补一句（ Harness 引擎行或工具与扩展行：「联网工具结果可溯源：回复内引用标记 + 消息末来源区，白名单校验防伪造 URL」）。
- `USER_GUIDE.md` / `skills/mao-cli/reference/desktop.md`：使用说明一小节。
- `docs/proposals/2026-10-12-answer-citations.md`：状态改「已确认」并链到本方案。
- `docs/proposals/README.md`：提案表格状态更新。

---

## 8. 测试要点

**标记工具（两端各一份）**

- 无标记 / 单标记 / 连续多标记 / 乱序 / 越界 n / 非数字不匹配 / 空串 / 超长文本。
- 模块级正则复用无 lastIndex 竞态（连续两次调用结果一致）。

**registry 构建**

- `web_search` 多结果：title/url 提取、空 url 跳过、`{error}` 失败形态跳过。
- `open_web_page`：成功（有 content）提取；`{error,url}` 跳过；截断形态（truncated=true）仍算成功（content 存在）。
- 混合轮次：两个工具交替、USER 之前的更早轮次工具结果**不**进本轮 registry。
- 去重保序：同一 url 出现两次只取首次；上限 20 截断。
- 非 JSON content、JSON 但结构不符：跳过不抛错。
- 无 TOOL 消息 / 无 USER 消息（异常会话）：registry 空、citations 不写。

**标记校验与落库**

- 全部标记越界 → cited 空 → metadata 不写（保持 null）。
- 部分越界 → 只保留合法的；伪造 URL 场景：模型写出 `[^1^]` 但 registry[0] 是真实搜索 URL 时保留（白名单管 URL 不管措辞）；模型句子里出现不在 registry 的 URL 但没有标记 → 无操作（纯文本展示，不做URL级清洗——**明确不做**：不在正文里扫描并删除未注册 URL，只通过标记机制引导）。
- 重复引用同一 n：cited 去重。
- metadata 合并：最终消息已有其他 metadata 键时合并不覆盖（当前该消息 metadata 恒为 null，合并逻辑仍按通用实现 + 单测锚定）。

**挂载与容错**

- COMPLETED 触发构建并写库；FAILED / CANCELLED 不触发。
- 构建过程抛错：finishExecution 正常返回，收件箱 / 预算 / 出站 / 记忆不受影响（warn 日志）。
- 子代理 / 边路会话：各自构建，registry 不跨会话。
- 各触发入口（WS / 定时 / 开放 API / 钉钉 runtime）均经同一收敛点，行为一致。

**提示词**

- 系统消息含引用规范原文；manifest keys 不变（`['experiences','memories','system-prompt','tool-definitions','messages']`）；「系统提示词」聚合节覆盖新分节原文（既有不变量全绿）。
- 两工具 description 含强化句；tools 列表 name 断言不破坏。

**桌面渲染**

- `[^1^]` → 上标 + 点击滚动高亮；代码块 / 行内代码内的 `[^1^]` **不转换**（renderer.text 不经 code 路径）。
- 流式期间半个标记（`[^1^` 未闭合）不渲染上标，完整后正常。
- citations 为空 / metadata 非法 JSON / 条目字段非法：不渲染来源区、不抛错。
- 展示序号：registry 5 条引用 2、5 → 上标显示 [1] [2]，来源区两条，点击互相对应。
- 外跳：`javascript:` 等非 http(s) URL 在 extract 阶段即被过滤（根本进不了 citations）。
- 深色模式下来源区可读性。

**渠道与导出（P2）**

- 飞书 / 钉钉 / 微信最终回复文本无 `[^n^]`；飞书流式卡片各刷新点无标记。
- JSONL 导出行 `metadata.citations` 存在且结构完整；分享页来源区渲染。

**回归**

- 无 citations 的消息（全部历史消息）：渲染 / 导出 / 分享零变化。
- 记忆抽取不读 metadata，长期记忆无引用残留。
- 运行轨迹、点踩反馈、用量统计口径零变化。

---

## 9. 风险与开放问题

1. **模型不插标记**：小模型可能完全不插或乱插。缓解：白名单校验的硬指标是「伪造 URL 不漏放」（越界即剥）；「引用覆盖率」只作将来观调，本次不做统计（决策 9）。契约文案随 harness 版本可迭代。
2. **标记语法与 markdown 脚注混淆**：模型可能混用标准脚注 `[^1]`。解析器只认 `[^n^]`；标准脚注语法按普通文本展示（现状行为），不在本方案内处理。
3. **跨轮引用被剥的体验断崖**：第二轮引用第一轮的搜索结果，标记会被剥（registry 只含本轮）。缓解：契约明确「只引用本轮来源」；被剥的句子的信息仍在正文。若后续要做跨轮 registry（按会话聚合），需要重新评估 metadata 体积与「哪轮来源」的展示语义——本次不做。
4. **registry 上限截断**：单轮搜索超过 20 个 URL 时尾部被截，对应标记被剥。20 条已覆盖单轮正常引用量；超限记 debug 日志。
5. **正文出现未注册 URL 但不带标记**：本方案只通过标记机制引导，**不扫描正文删除未注册 URL**（那会改写用户可见内容，误伤风险大）。幻觉 URL 若不带标记就仍是纯文本——引用溯源降低但不能完全消除幻觉 URL 的可见性，这是机制的已知边界。
6. **多消息竞态**：TASK_COMPLETED 与消息落库的时序——`finishExecution` 在所有 persistence 回调完成后调用（harness execute 返回后才收敛），最终回复行必已落库；极端异常（落库失败提前收敛）下 `selectLastAssistantMessage` 可能取到更早的 ASSISTANT 行，citations 会挂错消息——表现为该消息多了来源区，无数据损坏。接受（warn 日志可观测）。
7. **分享页快照与后续编辑**：分享按消息水位冻结，citations 随行快照，天然一致；水位后的新轮次不进入快照。
8. **CLI 保留标记原文**：mao-agent 终端输出会显示 `[^n^]`。与 JSONL 导出口径一致（离线可读）；若后续觉得碍眼，可在 CLI 输出层复用同款剥离正则（一行改动，本次不做——CLI 用户是开发者，标记可 toler）。
9. **开放问题（本次未决策）**：是否给桌面端加「点击上标侧边展开网页预览」——不做，外跳已满足验证需求。
10. **开放问题（本次未决策）**：`open_web_page` 的 `full_content_file`（正文超长落盘的文件路径）要不要也进 registry——不进：那是本地文件不是外部来源，文件引用走既有的 FileReference 机制。

---

## 10. 已确认决策摘要

| # | 决策点 | 结论 |
|---|---|---|
| 1 | registry 来源范围 | 仅 `web_search` / `open_web_page` 两个联网工具结果中的 URL；不含其他工具与用户消息 URL |
| 2 | 编号权与语法 | 系统编号权：模型只插 `[^n^]`，n = registry 序号；越界剥、乱序容忍、跳号容忍 |
| 3 | 提示词契约放置 | `prompt-engine` 新增固有分节「引用规范」（tools-usage 之后）+ 两个工具 description 各加一句强化 |
| 4 | 构建挂载点 | `task-terminal.service.ts` 的 `finishExecution` COMPLETED 分支，与 `dispatchMemoryExtraction` 并列，void + try-catch；写最终 ASSISTANT 消息 |
| 5 | 持久化方式 | `message.metadata.citations`（JSON），**零迁移**；提案的 V150 新列作废 |
| 6 | 开关 | 无任何开关（用户级 / Agent 级 / 单会话级均不做） |
| 7 | 标记存留 | content 保留 `[^n^]` 原文；渲染层转换、渠道发送前用共享 `stripCitationMarkers()` 剥离；JSONL 导出保留原文 |
| 8 | 分享页 | 渲染来源区，与主会话一致（ShareView 复用 ChatRoundList 自动生效） |
| 9 | 交付范围 | P1（registry 校验 + 契约 + 三端渲染 + 渠道剥离 + 分享页）+ P2（导出 / 快照验证）；P3 管理后台统计不做 |

以上 9 条决策均于 2026-10-12 逐条与用户确认。
