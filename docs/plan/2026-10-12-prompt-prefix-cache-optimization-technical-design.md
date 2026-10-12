# 提示词前缀缓存加固与可观测技术方案（评审 a/b/c/d/f/g 六项）

- 状态：待实施（2026-10-12 缓存专项评审结论；本方案覆盖评审项 a、b、c、d、f、g。评审项 e（系统提示「当前日期」跨天失效）语义较重，拆到独立方案 [2026-10-12-session-date-drift-notice-technical-design.md](2026-10-12-session-date-drift-notice-technical-design.md)；评审项 h（非 harness 场景复用固定 system prompt 时也可加键）本轮不做，列入后续项。**需求方已确认三项取舍与实施顺序，见 §10**）
- 日期：2026-10-12
- 能力底座：[2026-08-13-session-handoff-compaction-technical-design.md](2026-08-13-session-handoff-compaction-technical-design.md)（压缩请求严格前缀 + cachedTokens 观测）、0.0.2xx 的 Responses 协议 `prompt_cache_key` 修复（CHANGELOG「修复 OpenAI Responses 协议模型前缀缓存命中率随机的问题」）
- 定位：**本次不动前缀结构本身**，只补「协议层各显其能」与「失效可归因」两件事。前者的收益是直接的（Anthropic 协议当前缓存收益为 0、默认协议丢失粘性路由），后者是把缓存从黑盒变成可运维对象。

## 1. 需求背景

### 1.1 现状代码事实（实施前已核对）

**前缀纪律已经是硬不变量，且已有测试守护：**

- `harness/core/prompt-engine.ts:139`：`buildRequest` 组装 `[system, ...history]`，system 是单条 `messages[0]`，本轮新增内容一律追加到尾部。
- `harness/core/compaction-service.ts:164` `deriveRequest()`：压缩请求 = 正常主请求 + 尾部一条 `<system-notice>` 指令，system / tools / 全量历史原样复用 → 主请求是压缩请求的严格前缀。
- `harness/core/compaction-service.spec.ts:143`：`derivesStrictPrefixWithoutMutatingNormalRequestAndUsesStream` 断言前缀逐项相等、`tools` 引用相同、`promptCacheKey` 保留。这是全仓唯一一处对前缀不变量的回归测试。
- `harness/core/agent-execution-context.ts:58` `addSystemMessage()`：`<system-notice>` 用 user role 承载、推到尾部队列；`harness/core/session-history-loader.ts:51`：历史重建时临时消息**重新贴回尾部**。
- `harness/core/prompt-engine.ts:145`（M-13）：快捷命令 / 技能标记展开只作用于本次请求的副本、绝不写回 `context.messages`，否则同一用户消息每轮渲染漂移、历史和缓存同时报废。

**协议层现状（本次主要改动面）：**

| api_protocol | 适配器 | 缓存相关现状 |
|---|---|---|
| `''` / `openai-compatible`（默认） | `harness/llm/openai-llm-adapter.ts` + `harness/llm/json.ts:79` | `serializeChatRequest` 白名单序列化，**不发** `prompt_cache_key`；仅依赖上游自动前缀缓存 |
| `openai-responses` | `harness/llm/responses-llm-adapter.ts:823` | 已发 `prompt_cache_key`（值由 `prompt-engine.ts:173` 统一产出） |
| `anthropic` | `harness/llm/anthropic-llm-adapter.ts:541` | `body.system` 是普通字符串、`tools` 是普通数组，**全仓无任何 `cache_control`**；命中与否取决于网关是否自行注入（`docs/code-review/2026-08-28-code-review-02.md:18` 已记录该现象） |

协议路由：`harness/llm/llm-adapter-facade.ts:11`（未注册协议回落默认适配器）。

**观测与计费链路已就绪（本次只复用、不扩建）：**

- `ChatUsage.promptTokensDetails.cachedTokens` / `cacheCreationTokens`（`harness/llm/chat-request.ts:84-86`），三家适配器均已归一。
- `usage/llm-call.repository.ts:19`：`cache_creation_tokens` 落库；`usage/cost-micros.ts`：四价成本（非缓存输入 / 缓存读 / 缓存写 / 输出）。
- admin 用量分析、桌面「我的用量」已有缓存命中率视图；压缩事件单独返回 `cachedTokens`。

**两个会自毁前缀的隐性抖动源：**

- 长期记忆注入：`memory/memory.repository.ts:90/99` 用 `ORDER BY updated_at DESC, id DESC` 取最新 8/12 条，记忆块排系统提示第 3 节——任何一条记忆被 touch（用户编辑、别的会话结束触发抽取）都会重排该块，打掉 system 之后的一切。
- MCP 工具数组：`harness/core/harness-service.ts:349` 每轮 `connectForCloud()` 重连，`harness/mcp/local/mcp-sync-service.ts:65` 逐个 server 连接、单个失败只记 warning 且该 server 的工具本轮消失 → `tools` 变化 → 该轮及恢复后一轮全部 miss。对照 LOCAL：`session/ws/streaming-ws-handler.ts:1959` 由桌面 `mcp_tools_report` 上报进 `McpToolsRegistry` 快照，**天然稳定**——CLOUD 与 LOCAL 在这件事上是两种语义。

**运行参数后台化已有先例：** `db/migration/V097__settings_harness_tuning.sql` + `settings/settings-bootstrap.ts`（`system_setting`，category=运行参数，启动时读取、改后重启生效）。

### 1.2 六项问题定位

| 项 | 问题 | 影响 | 优先级 |
|---|---|---|---|
| a | Anthropic 协议无缓存断点 | 该协议全部会话缓存收益为 0（或全靠网关注入） | P0 |
| b | 默认协议（chat-completions）丢失 `prompt_cache_key` | 多上游网关下同会话命中率靠概率（Responses 侧实测「无 key 连发 4 次仅 1 次命中」） | P0 |
| c | 命中率可观但失效不可归因 | 缓存回归只能靠猜，无法定位是哪一节变了 | P1 |
| d | 记忆注入排序随 `updated_at` 抖动 | 一次无关的记忆 touch → 整条前缀（system + 全量历史）失效 | P1 |
| f | MCP 工具数组每轮重连、抖动即换 | 工具位于缓存层级最前，抖动代价最大（该轮 + 恢复轮双 miss） | P1 |
| g | 前缀不变量只有一处测试守护 | 「就加一行日期 / 重排一下」类改动可静默打掉全局命中率 | P1 |

## 2. 需求描述

### 2.1 要做的

1. **a**：Anthropic 协议启用自动缓存断点（请求体顶层 `cache_control`），并把缓存 TTL 做成可配置项（默认 5 分钟；长会话可切 1 小时）。
2. **b**：chat-completions 请求体透传 `prompt_cache_key`，并带**自动降级**：网关若因该字段报 400，立即去字段重试并按下游记忆，后续请求不再发。
3. **c**：新增前缀指纹观测：每次 `buildRequest` 计算「系统提示逐节 hash + 工具定义 hash」，与本会话上一次比对，变化时打结构化 warn，点名是哪几节变了。
4. **d**：长期记忆**选择口径不变**（仍取最新 N 条），但**注入顺序稳定化**（按 id 升序），使「记忆被 touch」不再重排整块。
5. **f**：CLOUD MCP 工具集改为**会话快照语义**（与 LOCAL 对齐）：快照按 `(serverName, toolName)` 排序落库到内存 registry；某 server 连接失败时沿用上次成功快照的工具，并在尾部 `<system-notice>` 说明该 server 当前不可用。
6. **g**：把「请求前缀逐字节稳定」补成常规回归测试：同一上下文连续两次 `buildRequest`、追加一条消息后再 `buildRequest`，两次断言字节级前缀不变与 tools 不变；断言载体复用 c 的指纹函数，失败信息直接点名变化项。

### 2.2 不做的

- **不做**评审项 e（系统提示日期跨天失效）——独立文档承接。
- **不做**评审项 h（标题生成 / git 提交信息 / 群聊摘要 / 经验起草 / 记忆抽取等非 harness 场景的固定 system prompt 加键）：这些场景走 `model/llm-chat.client.ts:20` 自己的 body builder，与本次改动面无交集；等 a/b 的收益被 `llm_call` 数据确认后再评估。
- **不做**前缀结构改造：不搬动系统提示分节、不新增缓存断点位置调优、不做「把易变内容移出 system」的重排（属 e 的邻域，且会一次性打掉全部在跑会话的缓存）。
- **不做**跨会话 / 跨用户前缀共享（system 里含 session 级技能路径，天然不可共享）。
- **不做**缓存命中率告警通道（邮件 / 收件箱）：本轮只到日志。
- **不做**网关侧配置变更、不承诺命中率数字（沿用 08-13 方案的验收边界：保证请求前缀 + 提供观测）。
- **不做**指纹落库 / 新增 WS 事件 / 改 manifest 展示。

## 3. 技术选型

### 3.1（a）Anthropic 断点形态：顶层自动断点 vs 逐块显式断点

选**顶层自动断点**（`cache_control: {"type":"ephemeral"}` 放在请求体顶层）。理由：

- 自动模式把断点固定在「最后一个可缓存块」并随对话增长自动前移，正是多轮 agent loop 的目标形态；显式逐块断点需要在每轮重新计算「最后一条消息」的位置（还要处理 tool_result 合并、图片注入的 block 结构），是我们自己维护一份易错的缓存策略。
- 顶层字段是官方 2026 的新形态，语义上等价于「整段请求自动缓存」；不认该字段的网关则退化为现状（无缓存），不会更差。
- 逐块显式断点留作后续增强（例如确认某渠道只支持块级时），不在本轮。

TTL：默认 5 分钟（官方默认），可配 1 小时。长会话的典型断点场景是人工审批、`ask_user_questions` 等待、长工具执行——这些间隔经常超过 5 分钟，会导致下一轮整段重写（写入价 1.25×）；1 小时写入价 2× 但读价仍是 0.1×，对「一次会话几十轮」的工作负载更划算。做成开关而不是默认开，先按渠道验证。

### 3.2（b）`prompt_cache_key` 下发策略：无条件 / 能力开关 / 发后自动降级

选**发后自动降级**。理由：

- 无条件发送的风险不对称：默认协议是所有存量模型的协议，一个严格网关因未知字段 400，影响面是全站 LLM 调用；而漏发的代价只是「没有变好」。
- 加一个 DB 能力开关的成本不低（`llm_model` 加列 + `model.service.createModel` 已是 16 个位置参数 + admin 表单 + 契约 VO），而「网关是否认这个字段」本质是运行时事实，不是配置事实——运行时探测比人工配置更准。
- 降级必须**进程内按「baseUrl|modelId」记忆**：一次 400 之后该模型后续请求不再发，避免每次调用都多花一个失败请求。

### 3.3（c）指纹存储：进程内存 vs 落库

选**进程内存**（有上限的 Map，仅诊断用）。理由：指纹只在「同一会话相邻两次请求」的比较中有意义；重启后第一次请求重新登记即可，不需要跨进程/跨实例一致性。代价是多实例部署时同一会话落到不同实例会各记一份（顶多多一次「首次登记」，不产生错误结论）。

### 3.4（d）记忆排序：改排序 vs 改选择口径

选**只改注入顺序，不改选择口径**。理由：选择口径「最新 N 条」是内容治理语义（`memory/memory.service.ts:216` 注释与 D7 上限），改掉会改变用户看到的记忆集合；而排序稳定性是纯收益。实现上用子查询先按 `updated_at DESC` 截断、再按 `id ASC` 输出。

### 3.5（f）MCP 工具：快照 vs 只排序 vs 不动作

选**会话快照**。理由：

- 只排序解决不了「数量变化」，而数量变化才是抖动的主因。
- 快照与 LOCAL 语义对齐后，行为可预期：工具集只在**服务端配置变化**（用户改 MCP 配置、新会话开始）时变化，不在连接抖动时变化。
- 代价是「断言了实际连不上的工具」，用尾部 notice + 工具调用返回明确错误来兜底（写进非目标与风险）。

### 3.6（g）测试载体：直接比较 JSON vs 复用指纹函数

选**复用 c 的指纹函数**作为断言载体。理由：失败信息直接给出「哪一节变了」，比 `expect(a).toEqual(b)` 的巨型 diff 可读；同时保证指纹函数自身被测试覆盖（它若算错，测试会误报，也能立刻暴露）。

## 4. 详细设计

### 4.1（a）Anthropic 自动缓存断点

**改动点**：`harness/llm/anthropic-llm-adapter.ts:541` `buildRequestBody()` 组装的 `body` 上，按开关追加顶层字段：

```
body.cache_control = { type: 'ephemeral' }                      // 默认
body.cache_control = { type: 'ephemeral', ttl: '1h' }           // 长 TTL 开关
```

**开关来源**：`system_setting` 新增两条（V152 迁移，category=运行参数，`editable=1`），对齐 V097 先例：

| setting_key | 默认 | 说明 |
|---|---|---|
| `harness.llm.anthropicAutoCache` | 空（=启用） | Anthropic 协议自动缓存断点开关（重启后端生效） |
| `harness.llm.anthropicCacheTtl` | 空（=5m） | 取值 `5m` / `1h`（重启后端生效） |

启动装配处（`create-app.ts` 构建 `LlmAdapterFacade` 的地方）读取并注入 adapter 构造参数；`system_setting` 取不到时用代码默认值（与 V097 的「value 为 NULL 表示从未设置」约定一致）。

**与计量的联动**：无需新代码。Anthropic 的 `cache_read_input_tokens` / `cache_creation_input_tokens` 已被 `mapAnthropicUsage` 归一、已按 `price_cache_read` / `price_cache_write` 计价落库 —— 开关一开，`llm_call` 里立刻能看到 cache 读写两列从 0 变成真实值。

**降级**：与 4.2 共用降级器，feature 取 `'cache_control'`。该适配器有对称结构可直接挂：`isRetryableStatus()` 分支在 `:89`/`:166`，非 2xx 分支在 `:103`/`:182`（均已 `readErrorBody()` 拿到错误体），在其后、`throw` 之前插入判定。

### 4.2（b）chat-completions 透传 `prompt_cache_key` + 自动降级

**序列化**：`harness/llm/json.ts:79` `serializeChatRequest` 末尾追加：

```ts
if (request.promptCacheKey != null && request.promptCacheKey !== '') {
  body.prompt_cache_key = request.promptCacheKey;
}
```

值与 Responses 侧同一来源（`harness/core/prompt-engine.ts:173`，`mao-session-{sessionId}`），**零新增管道**；压缩请求经 `deriveRequest` 已继承该键，行为一致。

**自动降级（新文件 `harness/llm/prompt-cache-key-support.ts`）**：

```
type Key = `${baseUrl}|${modelId}`
type Feature = 'prompt_cache_key' | 'cache_control'   // (b) 与 (a) 共用一套机制
unsupported: Map<Key, Set<Feature>>                   // 进程内，进程重启即重置
isSupported(config, feature): boolean
markUnsupported(config, feature, detail): void        // 打 warn 日志 + 置位
shouldDegrade(status, errorBody, feature): boolean
```

判据（保守，宁可漏判不可误判）：HTTP 400 且错误体文本中出现 `prompt_cache_key`（或同时出现 unknown/unexpected/unrecognized + `cache` 字样）。命中后：

1. `markUnsupported()`（一次 warn 日志，含 baseUrl、modelId、错误体片段）；
2. 重建 payload（去掉 `prompt_cache_key`）并 `continue` 重试；
3. 不占用限流重试额度：400 走的是「非可重试状态」分支（`isRetryableStatus()` 为 false），既有的 `attempt > rateLimitMaxRetries` 判定只在该分支内，语义天然不受影响；
4. **不会死循环**：`unsupported` 集合单调，同一模型降级一次后 payload 再也不会带该字段，`shouldDegrade` 不会再命中。

**接入点**（`harness/llm/openai-llm-adapter.ts`，两条路径对称）：

- payload 构造处（`chat()` L80 一带、`stream()` L145 一带）：`if (!isSupported(config, 'prompt_cache_key')) { /* 构造时不带 key */ }`；
- 非 2xx 分支：`chat()` 的 `awaited.status < 200 || >= 300`（L103 一带）与 `stream()` 的对应分支，都已调用 `readErrorBody(awaited.body)` 拿到错误体文本，在其后、`throw` 之前插入 `shouldDegrade()` 判定；
- 流式路径若错误在 SSE 事件内（HTTP 已是 200），不适用降级（此时请求已被接受，字段是被忽略/理解的），维持现状。

**同一机制服务（a）**：Anthropic adapter 的 400 处理复用 `shouldDegrade()` 时把特征字段换成 `cache_control`。

### 4.3（c）前缀指纹观测

**新文件** `harness/core/prompt-prefix-monitor.ts`：

```
interface PrefixSnapshot {
  systemSections: Record<string, string>;  // key → sha256(text)
  toolsHash: string;                       // sha256(JSON.stringify(toolDefinitions))
  messageCount: number;                    // 仅计数，用于日志上下文
  at: number;
}
observe(sessionId, sections, tools): void   // 比对 + 打点 + 覆盖快照
reset(sessionId): void
```

- hash 用 `node:crypto` 的 `createHash('sha256')`，逐节 hash 而非整串 hash（整串变化时无法归因到节）。
- 变化时 `harnessLog('warn', ...)`，内容形如：`prefix changed session=123 changedSections=[memories,skills] toolsChanged=true messages=48`。首次登记只 `info` 一次。
- 容量：Map 上限 512 会话，超出按插入序淘汰（LRU 简易实现即可），避免长跑进程泄漏。
- **接入点**：`harness/core/prompt-engine.ts:178` 组装 manifest 的同一处（此时 `sections` 与 `request.tools` 都在手，且是「所见即所发」口径）；只在 `context.sessionId != null` 时调用。
- **不做**：不落库、不推 WS、不进 manifest、不新增配置。
- **与 e 项联动**：日期锚定落地后，`current-date` 节正常情况不再出现在 `changedSections` 里；若仍频繁出现，说明锚定实现有 bug——这条日志同时成为 e 的验收手段。

### 4.4（d）长期记忆注入顺序稳定化

**改动点**：`memory/memory.repository.ts:90` / `:99` 两条注入查询：

```sql
-- listActiveUser（示例，listActiveProject 同形）
SELECT * FROM (
  SELECT * FROM `memory_item`
   WHERE user_id = ? AND scope = 'USER' AND status = 'ACTIVE'
   ORDER BY updated_at DESC, id DESC LIMIT ?
) t ORDER BY t.id ASC
```

- 选择口径完全不变（仍是最新 8 / 12 条），只把输出顺序改为 `id ASC`。
- `memory.service.ts:216` `listForInjection()` 不改（USER 段在前、PROJECT 段在后的分组顺序保持）。
- 更新 `memory/memory.repository.spec.ts` 既有断言（`:24` 现断言 `ORDER BY updated_at DESC, id DESC`），改为断言「内层截断 + 外层 id 升序」两个片段都在。
- 顺带核对 `prompt-engine.ts:261` 的记忆块渲染顺序（按 `context.memories` 数组顺序，无需改）。

**收益量化**：一条记忆被 touch 时，修复前是「整块重排 → system 变化 → system 之后 0 命中」；修复后该块文本不变（内容变了才变），命中率不受影响。

### 4.5（f）CLOUD MCP 工具集会话快照

**现状**：`harness/core/harness-service.ts:349` 每轮 `connectForCloud()`；`harness/mcp/local/mcp-sync-service.ts:65` 现场连接、失败即丢。

**目标形态**（与 LOCAL 的 `McpToolsRegistry` 同构）：

1. `McpToolsRegistry` 增设 cloud 维度（推荐新 Map `cloudSnapshot: Map<sessionId, McpToolRef[]>`，与桌面上报的 LOCAL 工具分开存，避免互相覆盖）。
2. `McpSyncService.connectForCloud()` 语义改为：
   - 连接成功 → 更新快照（按 `(serverName, toolName)` 排序后存储，保证跨轮字节一致）；
   - 某 server 连接失败 → **沿用上次成功快照中该 server 的工具**（快照里记录 `staleServers`），继续走既有的 `warnings` 通道 → `harness-service.ts:410` 已有的尾部 `<system-notice>` 提示（改为「该 server 当前不可用，相关工具调用可能失败」）；
   - 无快照（会话首轮）且连接失败 → 维持现状（该 server 的工具本轮不出现），因为此时没有「上次成功」可用。
3. 清理时机：会话执行结束（`agent-loop.ts` finally 已有 `mcpClientManager.closeSession(sessionId)`）+ 会话删除路径（对齐 `streaming-ws-handler.ts:2003` 一带既有 `clearSession` 调用）。

**工具数组稳定性论证**：快照内容只依赖「服务端 MCP 配置 + 各 server 声明的工具列表」，两者在同一会话内不变 → `tools` 数组逐字节稳定 → 缓存前缀（tools 段）不再因连接抖动变化。

**取舍**：断言的工具可能实际不可用。缓解：尾部 notice 明确告知模型；工具调用失败会返回工具自身的错误（模型能纠正）。这条取舍写进验收口径（「宁可工具调用报错，不可让整轮缓存失效」）。

### 4.6（g）前缀稳定性守卫测试

在 `harness/core/prompt-engine.spec.ts` 新增（命名沿用该文件既有风格）：

1. `sameContextBuildsByteIdenticalRequest`：同一 `AgentExecutionContext` 连续两次 `buildRequest`，断言 `JSON.stringify(messages)`、`JSON.stringify(tools)` 全等。
2. `appendingUserMessageKeepsPreviousPrefix`：追加一条 user 消息后再 build，断言新请求的 `messages.slice(0, old.length)` 与旧请求逐字节相等、`tools` 相等。
3. `prefixMonitorReportsChangedSection`（配合 c）：改 `memories` 后再次 build，断言 monitor 报出 `changedSections=['memories']`；不改任何输入的两次 build 不产生告警。
4. `serializedBodyDoesNotContainInternalFields`：chat-completions 序列化后断言体内不出现内部字段（本项为日期方案的 `senderYmd` 预留，见另一文档 §5.2）。

测试要点是**不依赖 mock 的时序**：取 `llmAdapter.stream` 捕获的 payload 或直接对 `buildRequest` 返回值断言均可（沿用 `compaction-service.spec.ts:143` 的既有做法）。

## 5. 实施步骤

| 阶段 | 内容 | 依赖 |
|---|---|---|
| P0-1 | b：`json.ts` 透传 + 降级器 + 单测（降级器纯单测：判据表驱动） | 无 |
| P0-2 | a：adapter 顶层字段 + V152 两条设置 + 启动装配 + 单测（有/无开关两态、ttl 取值） | 复用 b 的降级器 |
| P0-3 | 观察窗：用 `llm_call` 的 `cached_tokens` / `cache_creation_tokens` 按协议分组看前后差异，确认收益后再进 P1 | P0-1、P0-2 部署 |
| P1-1 | c：指纹 monitor + 接入 buildRequest + 单测 | 无 |
| P1-2 | d：两条查询 + spec 更新 | 无 |
| P1-3 | f：registry 快照 + connectForCloud 语义 + 清理路径 + 单测（抖动场景：首轮成功 → 次轮失败 → 断言 tools 不变且 notice 出现） | 无 |
| P1-4 | g：四条守卫测试 | c 的函数 |

落地后按 AGENTS.md 同步：CHANGELOG 顶部新增小节（后端）——a/b 是用户可见的成本行为变化，f 是用户可见的工具可用性提示变化；`skills/mao-cli/` 不涉及（无 CLI 用法变化）。

## 6. 测试要点

**降级器（b/a）**
- 400 + 错误体含 `prompt_cache_key` → 判为需降级；403 / 429 / 500 → 不降级；400 + 无关字段 → 不降级。
- 降级后同模型后续请求不再带该字段；不同 `baseUrl` 或不同 `modelId` 不受影响（键隔离）。
- 降级重试不消耗 `rateLimitMaxRetries`。

**Anthropic 适配器（a）**
- 开关关闭 → 体内无 `cache_control`（与改造前逐字节一致，保证可回退）。
- 开关开启 → 体内顶层 `cache_control.type === 'ephemeral'`；ttl 配置为 `1h` 时带 `ttl: '1h'`；非法取值回落 5m。
- usage 归一不受影响（既有 spec 全绿）。

**记忆排序（d）**
- SQL 片段断言：内层 `ORDER BY updated_at DESC, id DESC LIMIT`、外层 `ORDER BY t.id ASC`。
- 行为测试：同一组记忆在 `updated_at` 被打乱（mock 行顺序变化）时，`listForInjection` 输出顺序一致。

**MCP 快照（f）**
- 首轮连接成功 → 第二轮某 server 连接失败 → `tools` 数组逐字节不变 + warning notice 出现（模型可见）。
- 首轮就失败 → 该 server 工具不出现（维持现状）。
- 快照排序稳定：两次不同连接顺序得到同一 `tools` 数组。
- 会话清理：`clearSession` 后快照为空，新会话重新连接。

**前缀守卫（g）**：见 §4.6。

## 7. 风险与对策

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 网关拒绝顶层 `cache_control` | 阿里云等 OpenAI 兼容网关转 Anthropic 时字段校验严格 | 复用降级器；开关默认启用但有 `system_setting` 可全局关闭 |
| 1h TTL 成本反噬 | 会话长时间不活跃但偶发使用 | 默认 5m；1h 仅在验证过的渠道开；成本走势看 `llm_call` 的 `cost_micros` |
| `prompt_cache_key` 引发全站 400 | 严格网关对未知字段报错 | 降级器 + 「首次 warn 后不再发」；上线后 24h 内关注 400 率 |
| 快照断言了坏工具 | MCP server 挂掉后模型仍能看见工具 | 尾部 notice + 工具自身报错；若实测干扰明显，可退化为「只对失败的 server 摘除，但把工具顺序固定」的过渡形态 |
| 记忆排序改动影响既有测试/用户观感 | 注入顺序变化（最新一条不再排第一） | 属提示词内容变化，仅一次性影响在跑会话的缓存；在 CHANGELOG 注明 |
| 指纹 Map 泄漏 | 长跑进程 + 大量会话 | Map 上限 512 + 插入序淘汰 |
| 指纹误报（噪声告警） | 会话内合法变化（用户编辑 AGENTS.md、新增记忆、切模型） | 日志级别 warn 且带 `changedSections`，运维可按节过滤；这些变化本身就是「预期内的一次失效」 |

## 8. 落地清单

**backend-ts（新增）**
- `src/harness/llm/prompt-cache-key-support.ts`（降级器，纯逻辑）
- `src/harness/core/prompt-prefix-monitor.ts`（指纹观测）
- `db/migration/V152__settings_prompt_cache.sql`（两条 `system_setting`）

**backend-ts（修改）**
- `src/harness/llm/json.ts`（`serializeChatRequest` 透传 `prompt_cache_key`）
- `src/harness/llm/openai-llm-adapter.ts`（payload 构造问询支持位 + 400 降级分支，两条路径）
- `src/harness/llm/anthropic-llm-adapter.ts`（顶层 `cache_control` + 开关 + 降级）
- `src/harness/core/prompt-engine.ts`（接入 monitor）
- `src/memory/memory.repository.ts`（两条注入查询排序）
- `src/harness/mcp/local/mcp-tools-registry.ts`、`src/harness/mcp/local/mcp-sync-service.ts`、`src/harness/core/harness-service.ts`（cloud 快照语义）
- `src/create-app.ts`（读取 settings 注入 adapter）

**测试**
- `harness/llm/prompt-cache-key-support.spec.ts`（新）
- `harness/core/prompt-prefix-monitor.spec.ts`（新）
- `harness/core/prompt-engine.spec.ts`（g 的四条）
- `harness/llm/openai-llm-adapter.spec.ts`、`anthropic-llm-adapter.spec.ts`（开关两态 + 降级）
- `memory/memory.repository.spec.ts`（SQL 片段）
- `harness/mcp/local/mcp-sync-service.spec.ts`、`mcp-tools-registry.spec.ts`（快照抖动）

**不改**：desktop / admin / android / agent-cli / shared 契约（本轮无跨端新字段）；`model/llm-chat.client.ts`（非 harness 场景）。

## 9. 验收口径

1. **a 生效**：配置 Anthropic 协议模型，同一会话连续对话，`llm_call` 中 `cache_creation_tokens > 0`（首轮）且 `cached_tokens > 0`（后续轮）。修复前该协议两列恒为 0（除非网关自行注入）。
2. **b 生效**：openai-compatible 协议 + 多上游网关，同一会话连续多轮，`cached_tokens / prompt_tokens` 命中率显著高于改造前的同条件基线；且未出现新增的 400 失败（`llm_call` 的失败率不上升）。
3. **c 可用**：任一在跑会话命中率骤降时，日志中能查到 `prefix changed` 行并点名变化节；人为改 AGENTS.md 可复现该行。
4. **d 生效**：在同一会话内 touch 一条已注入的记忆（例如另一会话触发抽取），该会话下一轮的 `cached_tokens` 不塌陷；内容真变时（编辑记忆正文）允许塌陷一次。
5. **f 生效**：人为让某 MCP server 在第二轮连接失败，`tools` 数组与失败前逐字节一致，且模型看到「该 server 当前不可用」的尾部提示。
6. **g 生效**：CI 中 g 的四条测试常绿；后续任何人把易变内容塞进 system 前缀或让工具顺序不稳定，测试立刻失败。
7. **不退化**：backend-ts 全量 `npm test` 全绿；改造前后「同一上下文 + 同一工具集」的单轮请求体的 system/tools 部分逐字节一致（除 a 主动新增的字段）。

## 10. 已确认决策（2026-10-12 需求方确认）

| 决策点 | 结论 | 对应章节 |
|---|---|---|
| 默认协议是否全体发送 `prompt_cache_key` | **全体发送 + 400 自动降级**（不设白名单、不加 per-model 开关） | §3.2、§4.2 |
| MCP server 连接失败时 CLOUD 工具集行为 | **沿用上次快照工具 + 尾部提示**（缓存优先；模型可能看见连不上的工具，由 notice 与工具自身报错纠正） | §3.5、§4.5 |
| 本轮实施顺序 | **P0：b → a → 观察窗 → P1：c/d/f/g**（先改协议拿收益，用 `llm_call` 数据决定 P1 优先级） | §5 |

两点仍按方案默认执行、未单独提出异议，如需变更在实施前告知即可：

- **a 的默认开关态**：Anthropic 自动缓存断点默认**启用**，配 `system_setting` 全局关闭开关 + 400 自动降级兜底（§4.1）；长 TTL（1h）默认**不开**，需手工置 `harness.llm.anthropicCacheTtl=1h`。
- **g 落地形态**：四条守卫测试进 `prompt-engine.spec.ts` 常规用例，暂不写入 `AGENTS.md` 规范区（若希望成为跨人员硬约束，可在实施时一并加一行）。
