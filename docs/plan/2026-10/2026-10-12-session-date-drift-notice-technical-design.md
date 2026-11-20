# 会话日期锚定与跨天提示技术方案（系统提示日期不再跨天失效）

- 状态：待实施（2026-10-12 缓存专项评审项 e 的重做方案；本方案取代评审中「把日期节后置 / 移出 system」的原始建议，改为「日期锚定 + 跨天显式提示」。**提示覆盖范围已由需求方确认，见 §11**）
- 日期：2026-10-12
- 姊妹方案：[2026-10-12-prompt-prefix-cache-optimization-technical-design.md](2026-10-12-prompt-prefix-cache-optimization-technical-design.md)（评审 a/b/c/d/f/g；本方案的指纹观测项与其 §4.3 共用，可作为本方案的验收手段）
- 一句话：**系统提示里的日期从「今天」改成「本会话首条用户消息那天」，此后永不重算；真实日期推进由用户消息前端的 `<date-change>` 标签承载。**

## 1. 需求背景

### 1.1 现状代码事实（实施前已核对）

- `harness/core/harness-service.ts:294`：每次 `buildContext`（即每个用户轮次）执行 `context.currentTimestamp = shanghaiYmd();` —— 取的是**服务器当天**。
- `harness/core/prompt-engine.ts:283`：`current-date` 节被插在系统提示第 5 节（人格 → 经验 → 记忆 → 环境 → **当前日期** → 工具指引 → …），`harness/core/prompt-engine.ts:419` 渲染为 `当前日期：\`2026-10-12\`（星期一）`，并带一句「如需精确到时分秒的时间，请使用 shell 执行 `date`」。
- 系统提示是 `messages[0]`（`prompt-engine.ts:143-144`）。因此日期一变，system 及其之后**全部内容**（工具定义之前的段、全量历史）都失去前缀缓存。
- 时间戳可得性：`message.created_at` 随历史装载可读（`Message.createdAt`，`harness/deps.ts:41`）；DB 连接声明 `timezone: '+08:00'` + `dateStrings: true`（`db/db.ts:104/111`），**读出来就是 `'YYYY-MM-DD HH:mm:ss'` 字符串**；写入端用 `nowSql()`（`common/datetime.ts:49`，服务器本地墙钟）。
- 现成的取消息能力：`session/session.repository.ts:667` `selectUserStamps()`（全量 USER 的 id + created_at）、`:742` `selectLastUserMessage()`；`SessionService.getLastUserMessage`（`session.service.ts:1466`）。`harness/deps.ts:168` 已暴露给 harness。
- 历史装配此刻**不带时间戳**：`core/persisted-chat-message.ts` 只有 `messageId / persistedContentSnapshot / chatMessage`；`core/session-history-loader.ts:75` `toChatMessage()` 丢弃 `createdAt`。
- 系统提示注入机制：`core/agent-execution-context.ts:58` `addSystemMessage()` 用 **user role + `<system-notice>` 包裹 + 尾部追加**；`core/compaction-service.ts:13` `isRealUserMessage()` **把以 `<system-notice>` 开头（或以 `## 会话任务交接` 开头）的 user 消息判为非真实用户消息**，该判定被压缩边界补位（`compaction-service.ts:295`）、历史重建（`session-history-loader.ts:67/72`）、审批上下文快照（`tool/approval-context-snapshot.ts:19`）依赖。新标签必须避开这个前缀语义。
- `ChatMessage` 已有「Mao 内部字段、不参与协议序列化」的先例：`ToolCall.summary`（`llm/json.ts:50` 注释）与 `ToolCall.reasoning`（`llm/chat-request.ts`，仅 Responses 用）。三个适配器都按显式字段白名单序列化（`llm/json.ts:54`、`anthropic-llm-adapter.ts:783`、`responses-llm-adapter.ts:857`），新增内部字段不会外泄。
- 用户消息在**执行前**已落库：`session/ws/streaming-ws-handler.ts:589`（`saveMessage`）→ `:722` `executeFromEvent`，`:779` 的 `executePersistedUserPrompt` 直接用 `savedMessage`。所以 `buildContext` 时最新一条用户消息已在历史里。
- `AgentExecutionContext.addUserMessage()`（`agent-execution-context.ts:54`）目前**无任何调用方**，即上下文里的用户消息全部来自 DB，天然带时间戳。

### 1.2 问题机理与影响面

跨天后该会话的第一条消息会触发：`currentTimestamp` 变化 → `current-date` 节文本变化 → system 变化 → 该轮从 system 段起缓存全失效，且**此刻历史最长**，重写成本最高（按缓存写入价 1.25×~2× 计一次全量输入）。

两个必要的限定，避免夸大：

- **一天一次**，不是一轮一次：新日期一旦稳定，之后各轮重新命中。
- 只在**连续多天活跃的同一会话**上真实发生（定时任务会话、渠道会话、每天续用的长会话）。TTL 5 分钟的缓存对「隔天再打开」的会话本来就已过期，那种场景不受影响。

真正的代价不在 token，而在**可解释性**：它是「缓存命中率断崖」里最难猜的一类，因为触发原因（日期）与表现（system 变了）之间隔着一天。

## 2. 需求描述

### 2.1 要做的

1. **日期锚定**：系统提示 `current-date` 节的日期，取**本会话首条用户消息**（未软删、`id` 最小）的日期；此后同一会话内永不重算。
2. **跨天提示**：当某条用户消息的日期 ≠ **上一条用户消息**的日期时，在该用户消息正文**最前面**插入一个日期变更提示标签（形如 `<date-change>系统提示：…</date-change>`），让 Agent 感知真实日期已推进。
3. **零副作用**：提示只在发给模型的内容里出现——不落库、不改桌面/CLI 展示、不改压缩边界判定、不破坏「主请求是压缩请求严格前缀」的既有不变量。
4. **提示词契约同步**：`current-date` 节的文案改为「会话开始日期」语义，并解释 `<date-change>` 标签的优先级。

### 2.2 不做的

- **不做**运行中途（单轮执行内）跨零点的检测：跨天只由「下一条用户消息」承载。长任务跑过午夜不重算、也不打标签（下一轮才会知道）。
- **不做** assistant / tool 消息的日期标注。
- **不改**非 harness 场景的日期取用（标题生成、群聊摘要、git 提交信息、记忆抽取等各自的 system prompt 与 `shanghaiYmd()` 用法保持原样）。
- **不做**首条用户消息被编辑/删除后的锚点持久化补偿：锚点每轮从 DB 推导，天然自愈（下一轮换到新的首条消息日期，允许一次性缓存失效）。
- **不做**DB 迁移、不新增列、不加权限码、不动契约、不动 admin。
- **不做**`<system-notice>` 复用：新标签必须是独立标记，理由见 §1.1。
- **不做**时区口径统一（服务器本地墙钟 vs `Asia/Shanghai` 的历史遗留），只在风险节记录现状与规避写法。

## 3. 技术选型

### 3.1 锚点来源：查 DB 首条用户消息 vs 新增持久化列 vs `session.created_at`

选**查 DB**。理由：

- 零 DDL、零回填，且对会话复制 / 分叉（`source_session_id`）、导入、子代理会话天然正确（它们各自是独立 sessionId 的完整历史）。
- 挂在 `SessionService` 上一个薄方法即可，与既有 `getLastUserMessage`（每次执行一查）同构，成本可接受（`session_id` 上有索引）。
- 需要额外信息时（首条被删、无用户消息）用 `shanghaiYmd()` 兜底，与现状一致。

### 3.2 日期字符串的产生方式：`createdAt.slice(0,10)` vs `shanghaiYmd(new Date(createdAt))`

选 **`slice(0,10)`**。理由：`created_at` 是「写入端墙钟」的字符串（`nowSql()` 写、`dateStrings: true` 读），直接截取与写入端同一口径；若走 `new Date(...)` 再按 `Asia/Shanghai` 格式化，会在「服务器时区 ≠ +08:00」的机器上产生二次偏移（而服务器时区恰好也是 `nowSql()` 的口径），两个日期口径打架。同一份写入数据只做一次字符串截取，是最不容易错的做法。

### 3.3 标签形态：`<date-change>` vs 复用 `<system-notice>`

选 **`<date-change>`**（独立标签）。理由：`isRealUserMessage()` 把 `<system-notice>` 前缀判为非真实用户消息，而日期变更要挂在**真实用户消息**上——复用会让压缩边界补位与「最新真实用户消息」判定误判。

顺带设计上更干净的一点：标签只在 `PromptEngine` 对副本渲染，**从未进入 DB 与 `PersistedChatMessage.chatMessage`**，所以边界判定、压缩归档、导出、UI 全部接触不到它（§5.5）。

### 3.4 注入时机：请求构建时对副本注入 vs 落库时写入

选**请求构建时注入副本**（M-13 同款式）。理由：

- 落库写法会污染用户可见内容（桌面/CLI 会显示这段系统话术）、污染导出与分享，且用户编辑该消息时还要考虑标签是否重复添加。
- 副本注入的确定性由「输入只依赖 DB 的 `created_at`」保证，因此每轮重建结果逐字节相同 → 不破坏前缀稳定性；这是本方案能成立的关键前提（§5.8 给论证）。

### 3.5 字段命名：复用 `currentTimestamp` vs 新增语义化字段

选**改名为 `sessionBaseYmd`（或 `sessionStartYmd`）**，同时保留「服务器今天」的取用能力（见 §5.4 的兜底）。理由：全仓仅 3 处读写（`agent-execution-context.ts:37`、`harness-service.ts:294`、`prompt-engine.ts:420/422/423`），改名成本极低；留着 `currentTimestamp` 这个名字，下一个读代码的人还会以为它是「今天」。

## 4. 数据模型

无 DDL、无新增列。新增两个只读查询（`session/session.repository.ts`）：

```sql
-- selectFirstUserStamp(sessionId)：会话锚点
SELECT id, created_at AS createdAt FROM `message`
 WHERE session_id = ? AND role = 'USER' AND deleted = 0
 ORDER BY id ASC LIMIT 1;

-- selectPreviousUserStamp(sessionId, beforeId)：某条用户消息之前最近的一条用户消息
SELECT id, created_at AS createdAt FROM `message`
 WHERE session_id = ? AND role = 'USER' AND deleted = 0 AND id < ?
 ORDER BY id DESC LIMIT 1;
```

两条都返回 `Pick<Message,'id'|'createdAt'>`，与既有 `selectUserStamps()`（`:667`）同形，复用 `notDeleted()` 口径。
`SessionService` 暴露两个薄方法 `getFirstUserStamp(sessionId)` / `getPreviousUserStamp(sessionId, beforeId)`，并按 `harness/deps.ts:168` 的既有形态可选挂到 harness deps 上（`getLastUserMessage?` 已是可选方法，保持一致可选，缺省时不注入标签，功能降级为「只锚定不提示」）。

## 5. 详细设计

### 5.1 锚点解析（`harness-service.buildContext`，约 `:294`）

```
1) getFirstUserStamp(sessionId)?.createdAt → ymd = createdAt.slice(0,10)   // 主路径
2) 无用户消息 → shanghaiYmd()                                             // 与现状一致
context.sessionBaseYmd = ymd
```

- 每次执行重新解析，不做进程内缓存：首条消息被软删 / 会话分叉后能自愈。
- 无用户消息的会话（信号、定时任务首轮、空会话）行为与现状完全相同，不引入回归。
- 一处改名：`AgentExecutionContext.currentTimestamp` → `sessionBaseYmd`，注释写明「本会话首条用户消息日期，跨天不重算」。

### 5.2 时间戳随历史下发（`session-history-loader.ts`）

- `ChatMessage` 新增内部字段 `senderYmd?: string`，注释声明：**仅用于提示词渲染，禁止写入任何协议请求体**（与 `ToolCall.summary` 同一约定）。
- `toChatMessage()`（`:75`）：`if (message.createdAt) msg.senderYmd = String(message.createdAt).slice(0, 10);`
- 压缩边界前的参照：`applyHistory()`（`:39`）里，若加载窗口内存在用户消息，取窗口内**第一条**用户消息的 id，调 `getPreviousUserStamp(sessionId, thatId)`，把结果 ymd 放到 `context.previousUserYmdBefore`（跨过边界的「上一条用户消息」）。窗口内无用户消息时该字段为 null。
- 幂等注意：`applyHistory` 会重建 `context.messages`，`loadHistoryAfterBoundary` 每次从 DB 重新读 → 同一消息重复 apply 不会叠加任何东西（标签不在这里注入）。

### 5.3 提示词侧纯函数 `applyDateChangeNotices`（新文件 `harness/core/session-date-notice.ts`）

```
applyDateChangeNotices(messages: ChatMessage[], baseYmd: string, previousUserYmdBefore: string | null): void
```

规则（对传入的**副本数组**原地生效，调用方保证是副本）：

1. 维护 `previousYmd`，初值 = `previousUserYmdBefore ?? baseYmd`。
2. 顺序扫描；只处理 `role === 'user'` 且 `senderYmd` 非空的元素：
   - `senderYmd !== previousYmd` → 在该消息正文**最前面**插入标签文本；然后 `previousYmd = senderYmd`；
   - 相等 → 不发标签，`previousYmd` 不变。
3. 无 `senderYmd` 的 user 消息（当前不可达，防御性保留）既不参与比较也不更新 `previousYmd`。
4. 内容形态与**副本安全**（`buildRequest` 的副本是 `history.map((m) => ({ ...m }))`，浅拷贝 —— 嵌套的 content 数组与原对象共享引用，直接改会污染 `context.messages`）：
   - 字符串 content → 替换消息对象：`messages[i] = { ...msg, content: tag + '\n\n' + 原文 }`（必须保留 `senderYmd` 等其余字段；既有 marker 展开处 `prompt-engine.ts:223` 有同样的丢字段写法，一并修，见下）；
   - 数组 content（多模态）→ 重建数组：`messages[i] = { ...msg, content: [{ type: 'text', text: tag }, ...原数组] }`，**禁止原地 unshift**；原 image part 顺序不变。

标签文本（单行、尽量短，中文与系统提示一致）：

```
<date-change>系统提示：当前日期已变更为 2026-10-13（星期二）。这是系统注入的提示，不是用户说的话；需要精确到时分秒请用 shell 执行 date。</date-change>
```

**接入点**（`harness/core/prompt-engine.ts:139` `buildRequest`）：

```
const historyCopy = history.map((m) => ({ ...m }));          // :149 现有
await this.replaceQuickCommandMarkers(historyCopy, context); // :150 现有（必须基于 DB 原文展开）
applyDateChangeNotices(historyCopy, context.sessionBaseYmd,
                      context.previousUserYmdBefore ?? null); // 新增，紧随其后
...toolMediaInjector.inject(...)                             // :152 现有
...MessageHistoryNormalizer.normalizeChatMessages(...)       // :155 现有（保留对象身份，标签不被改写）
```

放在标记展开**之后**：`$skill$` / `#{command}#` 的展开语义必须基于 DB 原文（否则标签前缀会进入展开输入，未来一旦有人在标签里写 marker 就会互相干扰）。放在媒体注入与归一化**之前**：注入的新消息（图片 user 消息）本就不带 `senderYmd`，归一化只做 tool 组重排、保留对象身份，两者都不受标签影响。

**同任务必须一并修的一个既有隐患**：`replaceQuickCommandMarkers` 在展开时是 `messages[i] = { role: 'user', content: replaced }`（`prompt-engine.ts:223`），**只保留 role/content，会丢掉 `senderYmd`**。若含 marker 的用户消息恰好是跨天的那一条，标签就会漏发。改为 `messages[i] = { ...msg, content: replaced }` 即可（行为等价、只多保字段），并补一条「带 marker 且跨天的用户消息仍能拿到标签」的测试。这也是本方案不采用「在 `applyHistory` 阶段注入标签内容」的原因之一：那会让标签进入后续所有副本与展开逻辑的输入面，而把「数据（时间戳）随消息走、展示（标签）在构建时算」分开，故障面最小。

### 5.4 系统提示文案调整（`prompt-engine.ts:419` `currentDateHint`）

改造后文案（要点，非最终措辞）：

```
## 当前日期

当前日期：`2026-10-12`（星期一）
本节日期是本会话首条用户消息的日期，会话内固定不变。若你的用户消息前出现 <date-change> 标签，说明真实日期已经推进，以标签内日期为准。如需精确到时分秒的时间，请使用 shell 执行 `date` 命令获取。
```

- 保留 `allowShellClock` 分支（嵌入页面会话不提示 shell）。
- `formatChineseWeekday` 复用不变（签名已是 ymd）。
- **部署影响**：文案变化本身会让所有在跑会话的系统提示变化 → 一次性全量重写缓存。属可接受的一次性成本，写入 CHANGELOG 说明。

### 5.5 与压缩 / 边界逻辑的交互（逐项核对）

| 接触点 | 是否受影响 | 依据 |
|---|---|---|
| `isRealUserMessage`（压缩边界补位、最新真实用户消息） | **不受影响** | 标签只存在于请求副本；DB 原文与 `PersistedChatMessage.chatMessage` 无标签。即便在副本里，标签也不以 `<system-notice>` / `## 会话任务交接` 开头 |
| 压缩请求（`deriveRequest`） | 自动继承标签 | 压缩请求由主请求复制，标签随消息一起进入；尾指令仍是最后一条。`compaction-service.spec.ts:143` 的严格前缀断言不受影响（它比较的是「主请求 messages」与「派生请求前缀」） |
| 压缩归档 / 导出 / 分享 / run 轨迹 / 全量检索 | 不受影响 | 全部读 DB 原文 |
| `persistedContentSnapshot`（压缩边界快照） | 不受影响 | 快照取自 `PersistedChatMessage.persistedContentSnapshot`，在装载阶段生成、不含标签 |
| `activeContextCalculator`（活跃 token 估算） | 不受影响 | 它算 `context.messages`（无标签），与既有「展开后才进 manifest」的差异同源；水位口径由 `lastPromptTokens`（真实 usage）兜底 |
| manifest（上下文构成） | 标签 token 计入「会话消息」节 | manifest 读 `normalized`（即最终请求），符合「所见即所发」原则 |

**开放问题（低风险）**：压缩指令要求「用户目标与关键原话只来自真实用户消息」，标签文本理论上可能被摘要抄进交接正文。标签自带「系统提示…不是用户说的话」字样，且压缩指令已声明系统注入不算用户原话；先用抽样验证，若确有污染，再给压缩指令补一句「`<date-change>` 标签是系统注入，不得写入交接正文」（一行改动，记在实施步骤的可选末项）。

### 5.6 manifest 与前端

- 系统提示词节文案不变（仍是「系统提示词」聚合节）。
- 标签 token 自动计入「会话消息」节，无前端改动。
- 桌面/CLI 显示的消息内容来自 DB 与 WS 事件，不含标签 → **零 UI 改动**。

### 5.7 LOCAL / 子代理 / 渠道会话

全部按各自的 `sessionId` 独立锚定，无需特判：

- LOCAL：用户消息同样落库，`senderYmd` 同源。
- 子代理 / 侧任务会话：独立 sessionId，独立锚点；首条消息即其创建时的用户消息。
- 渠道（微信/飞书/钉钉）：用户消息以 USER role 落库，逻辑一致。
- 定时任务 / 信号会话：复用同一会话跨天时正是本方案的主要受益场景。

### 5.8 确定性与前缀稳定性论证

`applyDateChangeNotices` 的输出只依赖三样东西：消息顺序、各 user 消息的 `senderYmd`（DB 不可变）、`baseYmd` / `previousUserYmdBefore`（DB 推导）。同一批 DB 数据在任意轮次重建都会产出逐字节相同的结果。因此：

1. 第 N 轮的请求与第 N+1 轮请求共享前缀（新增消息append 在尾部）；
2. 压缩请求 = 主请求 + 尾指令（标签已在前缀内，不影响该性质）；
3. 跨天不再改动任何已有字节：`current-date` 节恒定，新日期只以**新增文本**出现在最新一条用户消息里——而它本来就是一个新的尾部增量。

（第 3 条是本方案相对「把日期移出 system」方案的额外好处：后者虽然也能保住 system，但需要把日期塞进尾部注入，等于每轮都改动尾部结构；本方案零结构改动。）

## 6. 实施步骤

1. **查询与装载**：`session.repository.ts` 两个查询 → `session.service.ts` 两个薄方法 → `harness/deps.ts` 可选挂载 → `session-history-loader.ts` 写 `senderYmd` 与 `previousUserYmdBefore`。
2. **锚点**：`AgentExecutionContext` 字段改名 + `harness-service.ts:294` 改为锚点解析。
3. **渲染**：新文件 `harness/core/session-date-notice.ts` + `prompt-engine.ts` 接线（插入点见 §5.3）。
4. **文案**：§5.4 的系统提示改写。
5. **测试**：§7 全部要点（先写纯函数与装载的单测，再补请求级不变量测试）。
6. **文档与 CHANGELOG**：CHANGELOG 顶部新增小节（后端）——「会话系统提示日期改为锚定首条用户消息，跨天由用户消息前的 `<date-change>` 提示承载（可见行为：跨天不再整段重算缓存）」；`skills/mao-cli/` 不涉及（无 CLI 用法变化）。
7. **（可选末项）**：压缩指令补一句标签豁免（§5.5 开放问题）。

## 7. 测试要点

**查询与装载**
- `selectFirstUserStamp` / `selectPreviousUserStamp` 的 SQL 片段与参数断言（`role='USER'`、`deleted=0`、`id < ?`、`LIMIT 1`、排序方向）。
- `toChatMessage` 从 `createdAt` 产出 `senderYmd`；`createdAt` 缺失时不产出该字段。
- 压缩边界场景：窗口内第一条用户消息的 `previousUserYmdBefore` 等于边界前最后一条用户消息的日期（跨边界比较正确）；窗口内无用户消息时为 null。

**锚点**
- 有首条用户消息 → 锚点 = 该消息 `created_at` 的日期（与 `shanghaiYmd()` 无关，可注入假时钟验证）。
- 无用户消息 → 回落 `shanghaiYmd()`。
- 首条用户消息被软删 → 下轮锚点切换到新的首条消息（自愈）。

**纯函数（`applyDateChangeNotices`）**
- 同一天多条 → 不插入任何标签。
- 跨一天 → 仅第一条新日期消息带标签，其后同日消息不带。
- 跨多天（间隔 3 天）→ 只有一次标签，内容是新的日期。
- 首条消息与锚点同日 → 不带标签；首条消息晚于锚点（锚点来自更早的已删消息）→ 按 §5.3 规则比较。
- 多模态（数组 content）→ 头部多一个 text part，image part 顺序不变，且原 `context.messages` 的数组未被改动（浅拷贝陷阱回归测试）。
- 无 `senderYmd` 的消息被跳过且不污染 `previousYmd` 链。
- 含快捷命令 marker（`$skill$` / `#{cmd}#`）且跨天的用户消息：展开后仍带标签、且 `replaceQuickCommandMarkers` 不再丢字段。

**请求级不变量**
- 同一上下文连续两次 `buildRequest`：`messages` / `tools` 逐字节相等（含标签渲染结果）。
- 追加一条同日用户消息后再 build：前缀逐字节不变。
- 跨天追加消息后再 build：**除尾部新增部分外**，前缀逐字节不变（与改造前对比：改造前 system 段即变化）——这是本方案的核心验收断言。
- 压缩请求仍是主请求的严格前缀（既有 `compaction-service.spec.ts:143` 保持绿）。

**不泄露 / 不落库**
- 三个协议的序列化体（chat-completions / anthropic / responses）都不包含 `senderYmd` 或 `<date-change>`（后者在正常同日对话中本就不该出现）。
- `saveMessage` 落库内容与 `PersistedChatMessage.persistedContentSnapshot` 均无标签。

**判定不受影响**
- 带标签的请求副本中，最后一条真实用户消息仍被 `isRealUserMessage` 判为真；`prependSessionSummary` 的补位行为不变。

## 8. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 服务器墙钟口径与显示口径不一致 | 部署机时区 ≠ +08:00（`nowSql()` 用本地墙钟，`shanghaiYmd()` 用 Asia/Shanghai） | 锚点一律按 `createdAt.slice(0,10)`（与写入端同口径），不引入二次偏移；在风险节记录该遗留问题，统一时区列为后续独立事项 |
| 老会话锚点很旧（首条消息可能几个月前） | 长期复用的定时任务 / 渠道会话 | 属预期：标签承载真实日期；系统提示文案已说明「以标签为准，精确时间用 shell」 |
| 跨天提示被模型当成用户指令 | 标签措辞不够强 | 文案固定包含「这是系统注入的提示，不是用户说的话」；保留 `allowShellClock` 提示作为精确时间的正路 |
| 单轮执行内跨零点无感知 | 长任务跑过午夜 | 明确非目标；下一轮用户消息会补上标签 |
| 标签被压缩摘要抄进交接正文 | 摘要模型未遵守「只来自真实用户消息」 | §5.5 开放问题：抽样验证，必要时补一句压缩指令豁免（一行） |
| 文案改动导致的全局缓存重写 | 部署当次 | 一次性成本，CHANGELOG 说明；与 §5.8 的长期收益相比可接受 |
| 依赖未挂载（deps 缺方法） | 精简装配场景 | 两个方法均可选：缺失时只锚定、不提示，功能降级且不报错 |

## 9. 落地清单

**backend-ts（新增）**
- `src/harness/core/session-date-notice.ts`（纯函数 + 标签文案常量）
- 对应单测 `src/harness/core/session-date-notice.spec.ts`

**backend-ts（修改）**
- `src/session/session.repository.ts`（两个查询）
- `src/session/session.service.ts`（两个薄方法）
- `src/harness/deps.ts`（`SessionService` 可选方法声明）
- `src/harness/core/session-history-loader.ts`（`senderYmd` / `previousUserYmdBefore`）
- `src/harness/core/agent-execution-context.ts`（字段改名 + 新增 `previousUserYmdBefore`）
- `src/harness/core/harness-service.ts:294`（锚点解析）
- `src/harness/core/prompt-engine.ts`（接入纯函数 + `currentDateHint` 文案 + **`replaceQuickCommandMarkers` 改为展开保字段** `messages[i] = { ...msg, content: replaced }`）
- `src/harness/llm/chat-request.ts`（`ChatMessage.senderYmd` 内部字段声明）

**测试**
- `harness/core/prompt-engine.spec.ts`（锚点文案、跨天前缀不变、标签渲染）
- `session/session-extra.spec.ts` 或 `session.repository` 对应 spec（两个查询）
- `harness/core/session-history-loader` 相关既有 spec（`senderYmd` 装载、跨边界参照）
- 三个适配器 spec 各补一条「序列化体不含 `senderYmd`」

**不改**：desktop / admin / android / agent-cli / shared 契约 / `db/migration`（零 DDL）/ 非 harness 场景的日期取用。

## 10. 验收口径

1. **锚定**：会话首条消息在 10-12 23:50，次日 08:00 再发消息 → 系统提示 `当前日期` 仍是 `2026-10-12`（星期一）；该条用户消息正文最前面出现 `<date-change>…2026-10-13（星期二）…</date-change>`。
2. **不再整段失效**：同上场景，配合姊妹方案的指纹观测日志，该轮**不出现** `changedSections=[current-date]`；`llm_call` 中该会话该轮 `cached_tokens` 保持在该会话的常态水平（对照修复前同场景：system 变化 → 命中归零、全量重写一次）。
3. **同日稳定**：同一会话一天内连续多轮，标签不出现，system 与历史前缀逐字节不变。
4. **用户可见面无变化**：桌面 / CLI 中该用户消息文本与时间戳保持 DB 原样，导出、分享、检索结果不含标签。
5. **边界逻辑无回归**：跨天消息所在的会话仍可正常触发压缩（`isRealUserMessage` 判定与压缩边界推进不受影响），压缩事件正常返回。
6. **兜底**：无用户消息的会话（信号 / 空会话）请求内容与改造前一致。
7. **不退化**：backend-ts 全量 `npm test` 全绿；改造后「同一天内」任一上下文的请求体与改造前逐字节一致（只有跨天场景产生新增字节）。

## 11. 已确认决策（2026-10-12 需求方确认）

| 决策点 | 结论 | 对应章节 |
|---|---|---|
| 提示覆盖范围 | **仅用户消息上的 `<date-change>` 标签**；不做单轮执行内跨零点检测（长任务跑过午夜不感知，下一轮用户消息补上） | §2.1、§2.2 |
| 标签时间精度 | **只带日期（含星期）**，不带时分；精确时间仍引导模型用 `shell date` 获取 | §5.3、§5.4 |

未单独提出异议、按方案默认执行的两点，如需变更在实施前告知即可：

- **压缩指令豁免**：先按 §5.5 的开放问题处理——不改压缩指令文案，抽样验证摘要是否把标签文本抄进交接正文；确有污染再补一行豁免（已列入实施步骤第 7 项）。
- **锚点无用户消息时的兜底**：回落 `shanghaiYmd()`（与现状完全一致，不引入回归）。
