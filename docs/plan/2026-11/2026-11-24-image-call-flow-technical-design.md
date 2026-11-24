# 图片生成 / 改图调用记入「调用流水」技术方案

- 状态：待实现（结论已定稿，等排期）
- 日期：2026-11-24
- 评审：2026-11-24 杨佳毅确认四条口径——①图片生成 / 处理**暂时固定 0 成本计价**（`cost_micros = 0`，非 NULL）；②agentId 经工具执行链**透传**获取（图片调用必属某个会话任务，会话必有归属 Agent）；③④⑤按推荐方案处理（scene 合并为单一 `image_generation`、模型维度聚合按 `model_type` 分组、run trace 零结构改动）；⑥不做公告、不处理历史跳涨（当前仅一人关注该数据，且未设置任何费用预算）。
- 一句话：`generate_image` / `edit_image` 每次调用（成功与失败）在 `llm_call` 记一行——`scene = image_generation`、成本固定 0、token 按上游 usage 归一；`agentId` 经 `ToolInvocation → dispatcher → callTool → executeWithUser` 透传，归因完整。
- 关联代码（撰写时已核实，均为当前工作区 `main`，`94d34f6c`）：
  - 工具实现：`backend-ts/src/harness/tool/impl/generate-image-tool.ts`（`executeWithUser` 入口 `:166`，成功返回 `:206`，失败 catch `:207`）、`edit-image-tool.ts`（同构，`:171`/`:244`/`:245`）
  - 图片 API 客户端：`backend-ts/src/harness/tool/image-api-client.ts`（usage 原样透传 `:372-374`，未做任何归一）
  - 流水唯一写入方：`backend-ts/src/usage/llm-call.service.ts:238`（`record`）；唯一调用方是 `usage/recording-llm-adapter.ts:99,159` 与 `recording-llm-chat-client.ts:33`——图片工具直连 `image-api-client`，完全不经过
  - 场景事实源：`backend-ts/src/usage/llm-call-context.ts:12-25`（`LLM_CALL_SCENES`，无 image 成员）；契约 `shared/contracts/src/usage.ts:16-28`（`LlmCallScene`）
  - 汉化表：`desktop/src/utils/llmCallLabels.ts`、`admin/src/utils/llmCallLabels.ts`（`Record<LlmCallScene, string>` 穷尽）
  - 预算 SUM（无 scene 过滤）：`backend-ts/src/budget/budget.repository.ts:123-130`
  - run trace 归属：`backend-ts/src/session/run-trace-record.service.ts:116`（`findCall` 只认 `scene === 'agent'`）、`session/run-trace.service.ts:240,256`（非 agent scene 已分流 `sideCalls`）
  - 工具执行链：`backend-ts/src/harness/tool/tool.ts:34-101`（`execute` 重载与 `callTool`）、`harness/tool/tool-dispatcher.ts:314-320`（SERVER_ONLY 分支，`:72` 确认两图片工具在内，`routeAgentId` 已在作用域）
  - 装配：`harness/tool/tool-registry.ts:190-191`（两工具构造位）、`app-harness-engine.ts:196`（`createDefaultToolRegistry`）、`create-app.ts:440`（`llmCallService` 构造，早于 `:938` 的 harness 装配，作用域内可取）
  - 模型维度聚合：`backend-ts/src/usage/llm-call.repository.ts:302-318`（`aggregateByModel`）；契约行 `shared/contracts/src/usage.ts:78,139`；消费端 `admin/src/views/user/components/UserUsageTab.vue`、`admin/src/views/analytics/tabs/SessionTab.vue`、`desktop/src/components/usage/UsageOverviewTab.vue`
- 关联方案：[用量成本与预算](./2026-10-06-usage-cost-budget-technical-design.md)（计价口径与「低估比没账危险」的决策 15）、[运行轨迹](./2026-10-09-run-trace-technical-design.md)（轨迹归属口径 D3）。

## 1. 现状与问题

今天的图片调用是一次**完全的统计盲区**：

- `generate_image` / `edit_image` 在 `executeWithUser` 里直连 `image-api-client.ts`（fetch 图片模型的 `/images/generations`、`/images/edits`），不经过 `LlmAdapter`，因此不经过 `RecordingLlmAdapter` / `RecordingLlmChatClient`——而它们是 `llm_call` 的唯一写入方。工具注释原话：「工具执行不在 LlmCallContext 内」。
- `LLM_CALL_SCENES` 与契约 `LlmCallScene` 均无图片场景，`llm_call.scene` 的注释枚举里也没有。
- 上游返回的 usage 只在工具结果 JSON 里透传（`generate-image-tool.ts:94`），会话内可见，不落任何表：成本核算、token 统计、失败率、慢调用审计全部看不到图片花费。
- 工具执行签名 `executeWithUser(args, sessionId, userId, workspace)`（`tool.ts:62`）没有 agentId；`record()` 又从 `LlmCallContext` 取 user/session/agent/scene（`llm-call.service.ts:249-256`），直接补记会得到 `agent_id = NULL` 的行，Agent 维度预算与统计照旧漏。
- `llm_call` 的成本模型是纯 token 计价（`cost-micros.ts`），而图片 API 的 usage 是异构原始对象；后台图片模型也没有价格录入入口（`ModelFormDialog.vue:138` 价格 tab 仅 `isTextType`）。若不显式处理，图片行会因「有 token 无价格」得到 `cost_micros = NULL`，被 `SUM` 忽略——预算闸门静默穿透，正是 `cost-micros.ts:34-39` 警告的「低估的账目比没有账目更危险」。

本次把图片调用接进流水，同时按评审口径 ① 固定 0 成本，绕开整个计价缺口。

## 2. 目标与非目标

### 2.1 目标

1. `generate_image` / `edit_image` 每次调用在 `llm_call` 记一行：**成功与失败都记**，`scene = image_generation`。
2. 归因完整：`user_id` / `session_id` / `agent_id` 按现有口径取值（agentId 经执行链透传，见 D5）。
3. token 入列：上游 usage 归一为 `prompt_tokens` / `completion_tokens` / `total_tokens`，无 usage 时全 0 但仍记行。
4. 成本固定 `cost_micros = 0`（显式 0，不是 NULL）：已知零价，SUM 计入但不改变总额，不触发价格解析与兜底缓存。
5. 展示闭环：调用流水明细 / 筛选 / 场景饼图 / 用户用量 / 导出 CSV 出现「图片生成」；run trace 落入既有「旁路调用」分组，**零结构改动**。
6. 未注入记录器时（精简单测 / 其他装配）工具行为与今天完全一致。

### 2.2 非目标

- **不做图片 token 分项计价**（`price_image_input`、`CostPrice` 第五分项、价格 tab 对 image 放开）——评审口径 ① 固定 0 成本；完整计价作为后续项（§10.1），届时只改适配器一行，埋点与行结构不变。
- 不拆 `image_generate` / `image_edit` 两个 scene（D2）。
- 不改 `llm_call` 表结构：不加列、不加索引、不加约束；`V113` 注释里的枚举清单顺带更新（纯注释）。
- 不改预算闸门 SQL、不改 `llm_usage` 表口径（admin 分析页的日趋势读 `llm_usage`，其唯一写入方是 git-commit 场景，与图片无关）。
- 不改 run trace 归属算法（现状已按 scene 分流，图片行天然进「旁路调用」）。
- 不做 mao-cli / 管理后台新页面、不发 OTA（纯后端 + 两个汉化表一行）。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 落点 | 记 `llm_call`，不另建 `image_call` 表 | 预算闸门、用量统计、run trace、导出全部读 `llm_call`；另建表等于把这些再接一遍，且预算盲区依旧 |
| D2 | scene | 新增单一成员 `image_generation`，generate/edit 合一 | 与 `voice_synthesis` 粒度对齐；具体工具名在流水参数与轨迹工具记录里可区分；少一半文案与筛选项。想拆家随时加成员，`Record` 穷尽会逼着补文案 |
| D3 | 成本 | 显式传 `costMicros: 0`，绕过 `resolveCostMicros` 兜底 | 0 = 已知零价（SUM 计入、总额不变）；NULL = 未知（SUM 忽略、闸门盲区）。我们语义上属于前者，绝不能落到后者 |
| D4 | token | 归一上游 usage：`input_tokens→prompt`、`output_tokens→completion`、`total` 缺失时相加 | token 型预算与用量统计从此含图片；不做 image/text 输入拆分——没有价格消费方，拆了也没处花 |
| D5 | agentId | 执行链透传：`dispatchFullOutcome` 的 `routeAgentId`（ToolInvocation.agentId 轮快照，缺省按 sessionId 查库）→ `callTool` → `execute` → `executeWithUser` | 不新增按 session 反查的代码；`routeAgentId` 与容器路由同源，本来就是「这个工具调用属于哪个 Agent」的权威值 |
| D6 | 失败也记 | `success = 0` + `error_message`（`toImageApiError` 已脱敏） | 失败同样耗时长、占配额；审计与排障需要看到失败率 |
| D7 | 记录器注入 | 窄接口端口 `ImageCallRecorder` + 可选依赖，未注入即零行为 | 与 `ImageModelLookup` 同模式；精简单测 / e2e 装配不必接 `LlmCallService` |
| D8 | 异常隔离 | 记录失败只 warn，绝不影响工具返回 | `LlmCallService.record` 内部已 catch DB 异常；适配器再包一层 try/catch 双保险 |
| D9 | 一次调用一行 | 不按 `n` 张图拆行 | usage 是整次调用的；拆行会重复计 token 与耗时 |
| D10 | 模型名快照 | `provider_model_id` 记别名归一后的 `cfg.model`（flare/sunburst 已解析） | 否则流水显示的和真实上游模型不一致，排障时对不上账单 |

## 4. 记录口径

每行字段与取值：

| 字段 | 取值 | 说明 |
|---|---|---|
| `scene` | `image_generation` | 新成员；run trace 据此分流「旁路调用」 |
| `user_id` | 工具入参 `userId` | 与 dispatcher 的运行身份口径一致（`runtimeToolUserId`） |
| `session_id` | 工具入参 `sessionId` | 后台子代理 / 定时任务等无会话场景为 NULL——与 compaction 等旁路调用同样处理，只在流水明细可见，不进会话轨迹窗口 |
| `agent_id` | 透传的 `routeAgentId` | 轮快照，缺省时 dispatcher 已按 sessionId 查库兜底；仍缺则 NULL，聚合归入「未归属」组（现有 NULL 口径） |
| `model_id` / `model_name` / `provider` | 图片模型行快照 | `model_type = image` 的 `llm_model` 行 |
| `provider_model_id` | `cfg.model` | 别名归一后的上游模型名（D10） |
| `protocol` | `model.apiProtocol` | 可能为 NULL → 展示「未知」，可接受 |
| `prompt_tokens` / `completion_tokens` / `total_tokens` | 归一值；无 usage 全 0 | D4 |
| `cached_tokens` / `cache_creation_tokens` | 0 | 图片 API 无缓存概念 |
| `cost_micros` | **0** | D3，显式零价 |
| `stream` / `first_token_ms` / `retry_count` | 0 / NULL / 0 | 非流式、无适配器重试 |
| `duration_ms` | `executeWithUser` 入口计时到记录点 | 含上游 HTTP、图片下载、落盘——「图片调用很慢」从此可观测 |
| `system_prompt` / `tools_json` | NULL | 非 chat 调用，无请求构成 |
| `success` / `error_message` | 1 / NULL 或 0 / 脱敏摘要 | D6 |

一行示例（概念形态）：

```text
scene=image_generation  user_id=7  session_id=1024  agent_id=3
model_name=GPT image 2  provider_model_id=gpt-image-2.5-sunburst
prompt_tokens=1840  completion_tokens=4096  total_tokens=5936
cost_micros=0  success=1  duration_ms=8231  stream=0
```

两个需要知悉的副作用：

- **token 型预算**（`limitType = TOKENS`）的 `SUM(total_tokens)` 从此包含图片 token。当前无任何预算配置，无影响；将来设 TOKENS 预算时需知悉口径已含图片。
- 成本型预算不受影响（0 值行计入 SUM 但不改变总额）。

## 5. 数据模型

**无迁移。** `llm_call.scene` 是 `VARCHAR(64)` 无 CHECK 约束（`V113__llm_call.sql:11`），新场景值直接可写；顺带把该行注释里的枚举清单补上 `image_generation`（纯注释更新，不动结构，不占迁移号）。不加索引：现有 `idx_llm_call_scene_created` 已覆盖场景筛选。

不引入 `price_image_input` 等价格列的原因见 D3：固定 0 成本下没有价格消费方；后续做计价时再按当时最大迁移号顺延。

## 6. 后端

### 6.1 契约与场景（三处同改，AGENTS.md 强制）

1. `shared/contracts/src/usage.ts:16-28`：`LlmCallScene` 加 `| 'image_generation'`。
2. `backend-ts/src/usage/llm-call-context.ts:12-25`：`LLM_CALL_SCENES` 加 `IMAGE_GENERATION: 'image_generation'`——与契约的一致性由文件末尾 `_AssertExhaustive` 编译期守住。
3. `desktop/src/utils/llmCallLabels.ts` 与 `admin/src/utils/llmCallLabels.ts`：`SCENE_LABELS` 加 `image_generation: '图片生成'`——`Record<LlmCallScene, string>` 穷尽强制，漏改任一端 `vue-tsc` 即报错。筛选下拉 `LLM_CALL_SCENE_OPTIONS` 从汉化表派生，无需手改。

### 6.2 usage 归一（`harness/tool/image-api-client.ts`）

新增纯函数（与文件内其他解析helper同风格，导出供单测与工具使用）：

```ts
export function normalizeImageUsage(raw: unknown): ChatUsage | null
```

- 入参非对象 → `null`（仍记行，tokens 全 0）。
- 只认 OpenAI 形态 snake_case：`input_tokens` / `output_tokens` / `total_tokens`；逐项 `Number.isFinite` 校验，非法或缺省归 0。
- `total_tokens` 缺失时按 `input + output` 推导。
- **不做** image/text 输入拆分，不碰 `PromptTokensDetails`（无价格消费方，见 D4）。
- 工具结果 JSON 里的 `usage` 保持今天的原样透传（`generate-image-tool.ts:94` 行为不变），归一只服务于落库。

单测用例：完整 gpt-image usage；只有 `total_tokens`；空对象 `{}`；`null`；字符串脏值；`input_tokens` 为字符串数字（归 0 还是接受？——定案：只接受 number，字符串归 0，防脏值）。

### 6.3 记录器端口与适配器

端口定义放在 `generate-image-tool.ts`（与 `ImageModelLookup` 同款模式，`edit-image-tool.ts` 已有 import 关系）：

```ts
export interface ImageCallRecorder {
  record(input: {
    model: LlmModel;              // 图片模型行快照（id / name / provider / apiProtocol）
    resolvedModelName: string;    // 归一后的上游模型名（cfg.model）
    usage: ChatUsage | null;
    success: boolean;
    errorMessage?: string | null;
    durationMs: number;
    userId: number | null;
    sessionId: number | null;
    agentId: number | null;
  }): Promise<void>;
}
```

适配器（新文件 `backend-ts/src/usage/image-call-recorder.ts`）：

```ts
export function createImageCallRecorder(llmCallService: LlmCallService): ImageCallRecorder
```

- 在 `LlmCallContext.runAsync({ scene: 'image_generation', userId, sessionId, agentId }, ...)` 内调 `llmCallService.record({ modelConfig: { id, name, provider, apiProtocol, modelId: resolvedModelName }, stream: false, usage, success, errorMessage, durationMs, costMicros: 0 })`。
- scene 与零成本由适配器统一决定，端口入参不带这两个字段——将来接计价只改适配器（§10.1）。
- 整个 `record` 包 try/catch，异常只 `harnessLog('warn', ...)`，不外抛（D8）。

### 6.4 工具埋点（两工具同款）

构造器末位加可选参数 `recorder: ImageCallRecorder | null = null`（现有 5 个位置参数与全部既有单测的调用形态不变）。

`executeWithUser` 内：

- 入口 `const started = Date.now()`。
- 成功路径：`materializeImageApiResult` 之后、`return` 之前，`await this.recorder?.record({ model, resolvedModelName: cfg.model, usage: normalizeImageUsage(result.usage), success: true, durationMs: Date.now() - started, userId, sessionId, agentId })`。
- 失败 catch：`err.message`（`toImageApiError` 已做 apiKey 脱敏）同样记一行 `success: false`。
- `recorder == null` 时 `?.` 短路，零开销零行为变化（D7）。

注意 `userId` 用 `executeWithUser` 的入参（群聊场景即执行身份，与 dispatcher 传给工具的 `runtimeToolUserId` 同源）；`agentId` 用 6.5 透传来的第 5 参。

### 6.5 agentId 透传（`tool.ts` + `tool-dispatcher.ts`）

`harness/tool/tool.ts`（沿用文件内「arity 递减链」既有风格，纯增量）：

- `callTool(tool, argumentsJson, sessionId?, userId?, workspace?, agentId?)` 加第 5 参。
- `execute` 加 5 参重载（`:34-60` 的重载组末尾追加），路由到 `executeWithUser(argumentsJson, sessionId, userId, workspace, agentId)`。
- `executeWithUser(argumentsJson, sessionId, userId, workspace, agentId?)` 基类签名加可选第 5 参；基类实现忽略该参继续向下链（`executeWithSession` 等不变）。子类按需覆盖 5 参版本，只覆盖 4 参的现有工具不受影响（TS 方法参数少者兼容）。

`harness/tool/tool-dispatcher.ts`：

- `:320` SERVER_ONLY 分支（两图片工具所在，`:72`）的 `callTool(tool, argumentsJson, sessionId, runtimeToolUserId, workspace)` 追加第 5 参 `routeAgentId`——**必须**。
- `:451` 通用分支同款透传 `routeAgentId`——一次改齐，未来工具免再 plumbing。
- `:263` `dispatchCloud` 无会话上下文（sessionId 恒 undefined），不传。

`routeAgentId` 是 `dispatchFullOutcome` 的入参，语义为「ToolInvocation.agentId 按轮快照；缺省时按 sessionId 查库兜底」（参数注释原文），直接复用，不新增任何查询。

### 6.6 装配

1. `harness/tool/tool-registry.ts`：`DefaultToolRegistryDeps` 加 `imageCallRecorder?: ImageCallRecorder | null`；`:190-191` 两构造各追加传位。
2. `app-harness-engine.ts`：`HarnessEngineDeps` 加 `llmCallService?: LlmCallService | null`；`createDefaultToolRegistry({...})` 里加 `imageCallRecorder: deps.llmCallService ? createImageCallRecorder(deps.llmCallService) : null`。
3. `create-app.ts:938` `assembleHarnessEngine({...})` 传 `llmCallService`（`:440` 已构造，作用域内）。
4. 装配影响面：e2e 的后端经 `src/main.ts` → `create-app` 真实启动（`tests/global-setup.ts:138-142`），记录自动开启；只有各单测里的精简 registry 不传该依赖 → 行为与今天完全一致。

## 7. 前端

### 7.1 汉化（唯一必须项）

两端 `llmCallLabels.ts` 各一行 `image_generation: '图片生成'`（6.1）。以下展示面自动生效，无需其他改动：

- 调用流水明细列表、场景筛选下拉、场景饼图（`LlmCallView.vue`，`llmCallSceneLabel`）；
- 桌面「我的用量」与 admin 用户用量抽屉的场景分布；
- 导出 CSV 的 scene 列；
- run trace：图片行落入 `sideCalls`（`run-trace.service.ts:256`），展示为「旁路调用」一条，复用场景文案；`findCall` 只认 agent scene（`run-trace-record.service.ts:116`），工具记录不会错挂到图片行——**零改动**。

### 7.2 模型维度按类型分组（消除榜单污染）

图片模型的 token 量级与文本模型不可比（图片输入 token 天然巨大），混排会扭曲「模型 token 榜单」：

1. 契约 `shared/contracts/src/usage.ts:78` `LlmCallModelAggRow` 加 `modelType?: string | null`。
2. `llm-call.repository.ts:302-318` `aggregateByModel`：`LEFT JOIN llm_model m ON m.id = llm_call.model_id`，select `m.model_type AS modelType`（LEFT JOIN：模型行已删也能展示，type 为 NULL 归「未知」）。
3. 消费端按 `modelType` 分组渲染：`admin/src/views/user/components/UserUsageTab.vue`、`admin/src/views/analytics/tabs/SessionTab.vue`、`desktop/src/components/usage/UsageOverviewTab.vue`——三处各加一个类型图例 / 分组表头（text / audio / image → 文本 / 语音 / 图片，复用 `model_type` 既有中文档位）。

## 8. 测试

按 AGENTS.md「新增 LLM 调用场景三处同改 + 回归测试」要求：

1. `image-api-client` 相关 spec（或新 `image-usage.spec.ts`）：`normalizeImageUsage` 全用例（6.2 列名清单）。
2. `generate-image-tool.spec.ts` / `edit-image-tool.spec.ts`：
   - 成功：recorder 被调一次；参数含 `resolvedModelName = cfg.model`（别名场景）、归一后 usage、`success: true`、`durationMs > 0`、`agentId` 等于透传值；
   - 失败（上游 5xx、无可用模型两种路径）：`success: false` 且 `errorMessage` 非空、不含 apiKey；
   - 上游无 usage：`usage: null` 仍记行；
   - recorder 未注入（现有用例即覆盖）：行为不变。
3. `image-call-recorder` 适配器 spec（mock `LlmCallService`）：scene / user / session / agent 透传正确、`costMicros === 0`、`stream === false`；`record` 抛异常时只 warn 不外抛。
4. `llm-call-context.spec.ts`：穷尽断言自动覆盖新成员；如该 spec 枚举成员则补 `IMAGE_GENERATION`。
5. 后端全量：`cd backend-ts && npm test`（落盘日志后 grep 摘要）。
6. 前端构建验证：desktop / admin 各跑 `npm run build`（汉化表漏项会在此暴露，不依赖 `npx vue-tsc --noEmit`）。
7. 手工验收（本地或测试环境）：后台配好 image 模型 → 桌面发一句话让 Agent 生成 / 改图 → 管理后台调用流水出现 `scene=图片生成`、`cost=0`、`agent_id` 为该会话 Agent、`duration_ms` 为秒级；再触发一次失败（临时停用模型）确认失败行可读。

## 9. 发布物

1. 代码（§6、§7）。
2. 碎片 `changelog/unreleased/2026-11-24-image-call-flow.md`（随功能落地时新增，只写小节不写版本号）：

```markdown
### 后端

- **图片生成 / 改图调用记入调用流水**：`generate_image` / `edit_image` 每次调用（含失败）在调用流水记录一行，含模型、token、耗时与归属 Agent；成本暂按 0 计价。

### 前端（桌面 / Web / 安卓）

- **「我的用量」新增「图片生成」场景**：场景分布与筛选中可见图片生成 / 改图的花费构成。

### 管理后台

- **调用流水新增「图片生成」场景**：明细、筛选与场景饼图支持按图片生成 / 改图查看；模型维度用量按模型类型（文本 / 语音 / 图片）分组展示。
```

3. 文档同步：无需改 README / DEPLOY / skills（均不涉及场景枚举）；本方案即细案存档。

## 10. 后续项（不在本期）

1. **图片 token 分项计价**：`llm_model` 加 `price_image_input`（按当时最大迁移号顺延，当前为 `V208`）→ `CostPrice` / `computeCostMicros` 加第五分项 → `PromptTokensDetails` 加 `imageTokens` → `ModelFormDialog.vue:138` 价格 tab 对 image 放开（只渲染输入 / 图片输入 / 输出三项）→ 模型解析链（`deps.ts:345`、`chat-request.ts:162`）带新价。届时 `image-call-recorder.ts` 删掉 `costMicros: 0` 改走解析即可，埋点与行结构不变。前置条件：运维把 image 模型价格配齐，否则回到「有 token 无价 → NULL → 预算盲区」。
2. scene 拆分 `image_generate` / `image_edit`（若审计确需按工具分）。
3. run trace 旁路调用的耗时统计剔除图片秒级行（观察真实分布后再决定，避免过早优化）。
4. §7.2 若评审认为当前一人关注可缩范围，可整体移至后续项——核心记录（§6）不依赖它。
