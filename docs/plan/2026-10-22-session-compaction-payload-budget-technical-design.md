# 会话压缩新增「请求体体积」触发 + 图片前置压缩 技术方案

- 状态：基础方案（2026-10-22 修订：缓存优先版，待评审后实施）
- 日期：2026-10-22
- 事故来源：会话 1396（王胡云 / 「VTN APP 首页改版方向」）连续 5 次 `LLM API returned 413`，会话被置为 `FAILED`
- 本版修订（按 2026-10-22 评审意见）：
  1. **压缩请求必须命中前缀缓存**：默认不剥图，压缩阈值控制在供应商上限的 80% 以内，保证「压缩请求 = 主请求前缀 + 一条指令」仍在供应商上限内；
  2. **图片只在 >1MB 时压缩**，≤1MB 原样使用，避免无差别有损重编码；
  3. **去掉注入侧总量预算（原 L2）与适配器兜底（原 L3）**：两者都会引入周期性前缀变化或重复编码，收益不及代价；存量数据由体积触发压缩兜底。
- 范围：后端 harness 的压缩触发、压缩请求构造、图片写入侧压缩；模型表新增 1 个可选上限字段；管理后台新增 1 个压缩配置项。**不改** WS 事件协议
- 关联代码（当前工作区 `mao/`，2026-10-22）：
  - `backend-ts/src/harness/core/compaction-config.ts`（压缩阈值）
  - `backend-ts/src/harness/core/compaction-service.ts`（触发判定、压缩请求派生、结果校验）
  - `backend-ts/src/harness/core/session-compaction-orchestrator.ts`（三个触发入口的统一编排）
  - `backend-ts/src/harness/core/harness-service.ts:498-522`（request_start 触发）
  - `backend-ts/src/harness/core/agent-loop.ts:520-545`（mid_loop 触发）、`:590-614`（manual 触发）
  - `backend-ts/src/harness/core/token-estimator.ts`（现有 token 估算口径）
  - `backend-ts/src/harness/core/active-context-calculator.ts`（锚点增量口径）
  - `backend-ts/src/harness/core/prompt-prefix-monitor.ts`（前缀指纹观测，本次复用做验证）
  - `backend-ts/src/harness/tool/prompt-image-resizer.ts`（尺寸规整，无字节目标）
  - `backend-ts/src/harness/tool/impl/read-file-tool.ts`（`readImage` 产出 data URI）
  - `backend-ts/src/harness/tool/impl/page-tools.ts`（`page_screenshot` 产出 data URI）
  - `backend-ts/src/settings/settings.service.ts` / `types.ts`（`harness.compaction.*` 配置）
  - `backend-ts/src/model/*`（模型配置，新增请求体上限字段）
  - `admin/src/views/settings/components/IntegrationConfigPanel.vue:326-332`（压缩配置表单）

## 1. 背景

### 1.1 事故数据

| 指标 | 数值 |
|---|---|
| 会话 | 1396，模型 `deepseek-v4.1-flash（official）`（provider `newapi`，`baseUrl=https://new-api.acg.team/v1`） |
| 上下文 token | 最后一次成功调用 `prompt_tokens = 180,594`（窗口 512k，远未触达 0.9×512k≈46 万） |
| 历史图片 | 54 张工具图片（`read_file` / `page_screenshot`），`message.metadata` 合计 **47.65 MiB** |
| 最后成功 | 18:32:51，请求体约 **49.76 MB** |
| 首次 413 | 18:32:55，Agent 又读了一张 461KB 截图，请求体约 **50.39 MB** |
| 失败次数 | 18:32:55 / 18:33:19 / 18:33:35 / 18:38:01 / 18:39:21 共 5 次，全部 413 |
| 上游边界 | 50MB（49.76MB 通过、50.39MB 被拒；new-api 自身 `MAX_REQUEST_BODY_MB` 默认 128，实测 60MB 空载可通过，限制在 new-api 背后的上游通道） |

### 1.2 根因

1. **每轮请求都重放全部历史图片**：`ToolMediaInjector.inject()` 把 `context.toolAttachments` 里所有历史工具图片的 base64 data URI 原样塞进请求，没有张数/字节预算。
2. **图片几乎不压缩**：`PromptImageResizer` 只在「长边 > 2048px 或 patches > 2500」时才重编码，1800×1200、1160×2048 这类合规尺寸的 PNG 截图原样保留（单张最大 2.7MB）。
3. **压缩只看 token**：线上 `triggerRatio = 0.9`，本会话 180k / 512k，永远不会触发；`TokenEstimator` 对图片只按 **1000 tokens/张** 估算（54 张 ≈ 5.4 万），图片的「字节成本」完全不参与决策。
4. **压缩请求自己也超限**：`CompactionService.deriveRequest()` 直接复制 `normalRequest`（已注入全部图片）再加一条指令，压缩请求同样是 50MB，即使强制手动整理也会 413。

### 1.3 现有机制覆盖情况

| 机制 | 位置 | 能否覆盖 |
|---|---|---|
| token 阈值压缩 | `compaction-service.ts` + `compactSession` | 否，图片按 1000 token/张，体积先行触顶 |
| mid-loop 压缩 | `agent-loop.ts:520-545` | 否，同一 token 判据 |
| 手动整理 | `agent-loop.ts:590-614` | 否，压缩请求带全部图片，同样 413 |
| 图片尺寸规整 | `prompt-image-resizer.ts` | 部分，只处理超大尺寸，PNG 不重编码 |
| 413 重试 | `openai-llm-adapter.ts` | 否，413 不在可重试状态白名单，直接失败 |

## 2. 目标与非目标

### 2.1 目标

1. **新增请求体体积触发**：请求体估算体积超过阈值时触发会话压缩，与 token 阈值是「或」关系。
2. **阈值跟随供应商上限**：触发阈值默认取 `min(全局 40 MiB, 供应商请求体上限 × 0.8)`，保证「压缩请求 = 主请求 + 一条指令」不会超过供应商上限。
3. **压缩请求必须命中前缀缓存**：默认**不剥离历史图片、不裁剪历史消息**，压缩请求与主请求共享完全一致的前缀，只追加一条交接指令。
4. **图片前置压缩**：工具产出图片时，**仅当图片字节 > 1MB** 才做有损压缩（目标 ≤800KB）；≤1MB 原样使用，不做任何重编码。
5. **不影响正常轮次缓存**：未触发压缩的轮次，请求体逐字节与改造前一致。
6. **可观测**：上下文详情能看到本次请求体积；压缩日志能看到触发原因（tokens / payload / both / manual）与实际请求体积。

### 2.2 非目标

- 不做注入侧「最近 N 张 / 总量 X MB」的历史图片裁剪（会周期性改写历史中段，破坏前缀缓存）。
- 不做适配器层逐请求重编码（每轮重复解码大图，且参数变更会造成一次性全量失效）。
- 不按供应商维护硬上限表到代码常量：上限通过模型配置显式声明，缺省用全局阈值。
- 不改动 `TokenEstimator` 的图片 token 估算口径。
- 不改压缩摘要的模型、提示词与语义契约。
- 不压缩用户上传的原始文件（落盘文件保持原样），只压缩「发给模型的副本」。
- P0 不做 413 自动降级重试（列为 P2 可选）。

## 3. 方案总览

```
构建请求 (PromptEngine.buildRequest)
   │  历史图片原样注入（不做张数/总量裁剪 → 前缀稳定）
   ▼
估算体积 (RequestSizeEstimator：消息 + data URI + 工具定义)
   │
   ├─ token ≥ 窗口 × triggerRatio ─┐
   └─ 体积 ≥ 触发阈值 ─────────────┴─► 触发压缩
                                         │
                                         ├─ 压缩请求 = 主请求 + 交接指令
                                         │   （不剥图、不裁剪 → 命中缓存前缀）
                                         ├─ 生成摘要 → 推进边界（整窗重置）
                                         └─ 重建请求 → 体积回到基线
   ▼
发送
```

| 机制 | 位置 | 作用 | 对缓存的影响 |
|---|---|---|---|
| A. 图片前置压缩 | `read_file` / `page_screenshot` → `PromptImageResizer.compressForStore` | >1MB 的图压到 ≤800KB，写入即固定 | 无（写入侧一次性） |
| B. 体积触发压缩 | `harness-service`（request_start）+ `agent-loop`（mid-loop） | 请求体到阈值时整窗重置 | 一次性失效（压缩本身），压缩调用命中前缀 |
| C. 阈值跟随供应商上限 | 模型配置 `maxRequestBodyBytes` | 保证压缩请求发得出去 | 保证压缩请求与主请求同前缀 |

三者关系：A 把新增图片的成本压下来；B 在总量异常时一次性重置；C 保证 B 的执行本身不额外丢缓存。

## 4. 请求体体积指标

### 4.1 定义

`requestBytes` = 最终 `ChatRequest` 序列化为 HTTP body 后的字节数（UTF-8），口径与 `harness/llm/json.ts` 的 `serializeChatRequest` 一致：`messages` + `tools` + 顶层参数（`model` / `stream` / `reasoning` / `prompt_cache_key` 等）。

采用**估算**而不是真实 `JSON.stringify`：50MB 级字符串每次构建都序列化会带来 100ms 级开销与同量级临时内存，阈值判断 ±3% 精度足够。

### 4.2 新增 `RequestSizeEstimator`（`harness/core/request-size.ts`）

```ts
export class RequestSizeEstimator {
  /** 估算整个请求的 wire bytes（UTF-8）。 */
  estimate(request: ChatRequest): number;
  estimateMessages(messages: ChatMessage[]): number;
}
```

| 组成 | 估算方式 | 说明 |
|---|---|---|
| `role` / `toolCallId` | `Buffer.byteLength` | 小字段，直接精确算 |
| `content: string` | `Buffer.byteLength` | 文本，含中文（3 bytes/字） |
| `content: ContentPart[]` | 文本 `byteLength` + `image_url.url.length` | data URI 为纯 ASCII base64，`length` 即字节数 |
| `toolCalls` | `arguments.length + id.length + 常量` | 参数是 JSON 字符串 |
| `reasoningContent` | `Buffer.byteLength` | 历史 thinking 随请求回传 |
| `tools` | `Buffer.byteLength(JSON.stringify(tool.parameters))` | 一次执行内不变，`WeakMap` 缓存 |
| 顶层参数 | 常量（≤1KB） | 计入 |

- **精度**：JSON 转义会让文本里的 `"` `\` `\n` 膨胀，但占比极低；base64 不需要转义。估算值乘 **1.02** 安全系数。
- **性能**：229 条消息 + 54 个 data URI，一次估算 < 2ms（`length` 为 O(1)，只有文本走 `byteLength`）。

### 4.3 与 token 口径的关系

- token 判定继续用 `ActiveContextCalculator`（锚点 + 增量），既有行为不变。
- 体积判定**总是对完整请求估算**，不做锚点增量：图片注入发生在 `buildRequest` 阶段，锚点里没有「体积」概念。
- 两个指标只用于「是否触发压缩」，不参与 token 水位展示（体积在 manifest 里单独展示，见 §10）。

## 5. 触发规则

### 5.1 阈值：全局 + 模型级上限

```ts
export class CompactionConfig {
  ...
  /** 全局请求体体积触发阈值（字节）；0 表示关闭体积触发。默认 40 MiB。 */
  triggerPayloadBytes = 40 * 1024 * 1024;
}

/** 模型级供应商请求体上限（新增字段，0 = 未知）。 */
interface LlmModelConfig {
  maxRequestBodyBytes?: number | null;
}
```

生效阈值：

```
providerLimit = modelConfig.maxRequestBodyBytes ?? 0
if (providerLimit > 0) {
  effectiveTrigger = min(config.triggerPayloadBytes, floor(providerLimit * 0.8))
} else {
  effectiveTrigger = config.triggerPayloadBytes
}
```

- 供应商支持 50MB → 阈值 40MB（正好是 80%）；
- 供应商支持 32MB → 阈值 25.6MB；
- 未配置上限的模型 → 用全局 40 MiB。
- **保证**：`effectiveTrigger + 交接指令（几 KB）< providerLimit`，压缩请求一定发得出去。

> 单位：模型上限在管理后台以 MB 输入，落库按 MiB（×1024×1024）。按 50MB 上限计算，触发阈值 40MiB=41.9MB，相对真实的 50,000,000 字节上限仍留 16% 余量。

### 5.2 判定函数

```ts
export type CompactionTriggerReason = 'tokens' | 'payload' | 'both' | 'manual';

CompactionConfig.shouldTrigger(params: {
  tokens: number;
  payloadBytes: number;
  triggerWindowTokens: number;
  effectiveTriggerBytes: number;
  config: CompactionConfig;
}): CompactionTriggerReason | null;
```

```
tokensHit  = tokens >= floor(triggerWindowTokens * config.triggerRatio)
payloadHit = effectiveTriggerBytes > 0 && payloadBytes >= effectiveTriggerBytes
if (tokensHit && payloadHit) return 'both'
if (tokensHit) return 'tokens'
if (payloadHit) return 'payload'
return null
```

`force=true`（手动整理）绕过判定。

### 5.3 三个调用点

| 入口 | 现状 | 改造 |
|---|---|---|
| `harness-service.buildContext`（request_start） | 先算 `activeTokensHint` 再调 `compact`，判定在 `compactSession` 内部 | 额外传入 `payloadBytes = estimate(normalRequest)` 与 `effectiveTriggerBytes` |
| `agent-loop.ts:529-537`（mid_loop） | 调用前只判 token | 改为 `shouldTrigger(...)`；**体积检查不受 `loopMidwayCompact` 开关限制**（见 5.5） |
| `agent-loop.ts:590-614`（manual） | `force=true` | 仅补传 `payloadBytes` 用于日志与事件 |

`compactSession` 签名扩一个可选参数（向后兼容，旧调用方不传即按 token 判定）：

```ts
async compactSession(
  sessionId, expectedOldBoundary, messages, snapshotMessageIds,
  normalRequest, modelConfig, config, listener, cancelFlag,
  activeTokensHint?: number | null,
  force = false,
  sessionModelConfig?: LlmModelConfig | null,
  payloadBytes?: number | null,          // 新增
  effectiveTriggerBytes?: number | null, // 新增
): Promise<SessionCompactionResult | null>
```

### 5.4 防抖与死循环

- **同一执行内只做一次体积压缩**：`AgentExecutionContext` 新增 `payloadCompactionDone: boolean`，置位后本执行不再因体积触发压缩。
- **压缩后仍超限则不再重试**：压缩完成后重新估算，若仍 ≥ 阈值，记录 `warn` 并跳过。整窗重置后体积通常回到 MB 级，正常路径不会触发。
- **不影响 token 触发**：token 触发的既有语义与频次保持不变。

### 5.5 为什么体积检查必须独立于 `loopMidwayCompact`

`loopMidwayCompact` 控制的是「每轮工具结束后是否检查 token 水位」，默认 true。如果把体积检查挂在同一个开关下，管理员关掉该开关后，一轮内连续读 20 张大图（30MB）就可能直接撞 50MB。

因此：**体积检查在每个工具轮边界无条件执行**（成本仅一次估算），`loopMidwayCompact` 只控制 token 检查。

## 6. 压缩请求与缓存

### 6.1 关键约束：前缀必须与主请求一致

压缩请求 = `normalRequest` 的完整消息列表 + 末尾追加一条交接指令：

```ts
const messages = source.messages ? [...source.messages] : [];
messages.push({ role: 'user', content: appendedUserContent });
return { ...source, messages, stream: true };  // promptCacheKey 随 ...source 保留
```

只要**不改动任何历史消息**，压缩请求与主请求的最长公共前缀就是整段历史，缓存命中到历史末尾，只有末尾指令是新增 token。

### 6.2 为什么默认不剥图

- 体积触发阈值是 `min(40MiB, 供应商上限×0.8)`，压缩请求 = 阈值请求体 + 指令（几 KB），**必然 < 供应商上限**，能发出去；
- 剥图会让压缩请求在「第一张图」处与前缀分叉，导致整段历史缓存失效——这正是要避免的；
- 压缩请求的开销从「整段历史全价」降到「新增消息 + 指令 + 历史的缓存读」，以 180k 历史、2k 新增估算，两者相差约 **30 倍**（0.36 元 vs 0.011 元）。

> 边界：上面的「必然 < 上限」成立的前提是请求体在阈值附近。如果单轮工具结果一次性把体积从阈值抬到上限以上（例如一次返回 20MB 文本），压缩请求仍可能超限——这种情况由 §6.4 的兜底剥图处理，属于配置/极端输入问题，不是常态。

### 6.3 前置条件：压缩模型必须与会话模型一致

线上 `system_setting.compaction.modelId` 为空 → 压缩使用会话主模型（`session.modelId`），与主请求同 `baseUrl`、同 `modelId`，缓存可共享。

**配置约束**（需要写进运维文档/后台提示）：
- 若把 `compaction.modelId` 配成另一个模型（例如便宜的小模型），压缩请求会打到不同模型/不同上游 → **缓存必然不共享**，且摘要质量口径变化；
- 因此「压缩必须命中缓存」的前提是：`compaction.modelId` 留空，或配置为与会话相同的模型。

### 6.4 兜底：只有超限才剥图

构造完压缩请求后再估算一次：

```
if (estimate(compactionRequest) >= providerLimit - SAFETY_MARGIN) {
  // 只会在「阈值配置错误」或「供应商上限填小了」时命中：
  // 剥掉历史图片（牺牲本次缓存）保证压缩动作能执行
  stripImagesForCompaction(compactionRequest);
  log('warn', 'compaction request exceeded provider limit, images stripped (cache miss for this call)');
}
if (estimate(compactionRequest) >= providerLimit) {
  throw new CompactionContextOverflowException(...);  // 复用现有异常，走既有降级
}
```

- 正常路径（阈值 = 80% 上限）永远走不到剥图分支；
- 剥图只在兜底时发生，且日志明确标注本次压缩未命中缓存，便于排查配置问题；
- 现有的 `compactionRequestTokens >= overflowWindow` token 溢出保护保持不变。

### 6.5 缓存命中范围（以会话 1396 为例）

| 场景 | 压缩请求实际计费 |
|---|---|
| request_start 触发 | 上一轮请求前缀全部命中；只对「上一轮结束后新增的消息 + 指令」计全价 |
| mid-loop 触发 | 最近一次主请求前缀（到上一条 assistant 消息）全部命中；只对「本轮工具结果 + 指令」计全价 |

以 180k 历史、新增 2k token 估算：压缩调用从 0.36 元（全量全价）降到约 **0.011 元**（0.007 元历史缓存读 + 0.004 元新增全价，按 2 元/M 全价、0.04 元/M 缓存读）。

## 7. 图片前置压缩

### 7.1 触发规则：只压 >1MB 的图

```ts
export const STORE_COMPRESS_THRESHOLD_BYTES = 1 * 1024 * 1024;  // 1MB（二进制）
export const STORE_TARGET_BYTES = 800 * 1024;                  // 压缩目标 ≤800KB
export const STORE_MAX_DIMENSION = 2048;                       // 长边上限（沿用）
```

判定顺序：

1. 先做**尺寸规整**（既有行为）：长边 > 2048px 或 patches > 2500 时缩放；
2. 若结果字节 **≤ 1MB** → **原样返回，不重编码**（保留 PNG 无损）；
3. 若结果字节 **> 1MB** → 进入压缩：按目标 800KB 迭代（质量 80→70→60，仍超则按 0.85 缩尺寸，最多 3 轮）；
4. 编码选择：带 alpha → WebP q80（截图文字优于 JPEG）；无 alpha → JPEG q80；
5. 仍超 800KB 时接受实际结果并记 `warn`，不阻断工具。

> 说明：「≤1MB 原样返回」指不做有损重编码；尺寸本身超限（>2048px / >2500 patches）仍按既有逻辑缩放，否则模型侧无法接受。

### 7.2 接入点

| 工具 | 现状 | 改造 |
|---|---|---|
| `read_file`（`readImage`） | `PromptImageResizer.resizeForPrompt`（只限尺寸） | 尺寸规整后追加 `compressForStore`（>1MB 才生效） |
| `page_screenshot`（`PageScreenshotTool`） | 直接把客户端 data URI 塞进结果 | 解码 data URI → 同样的两步处理；失败时回退原图并 `warn` |
| 其他图片工具 | `ToolImageResultProcessor` 只做透传 | 不改 |

> 写入侧压缩是**一次性**的：落库的 `message.metadata.attachments[].data_uri` 就是处理后的字节，历史回放与请求构建不再重复编码，前缀天然稳定。

### 7.3 收益实测（会话 1396 原始数据）

| 指标 | 数值 |
|---|---|
| 工具图片总数 | 59 张（54 张事故时 + 5 张恢复后新增） |
| 原始二进制合计 | 38.65 MB（base64 约 51.5MB） |
| >1MB 的图片 | **7 张，合计 9.84 MB** |
| 压到 800KB 后 | 5.6 MB，**省 4.2 MB（约 11%）** |
| 按 1MB 阈值处理后总量 | 约 34.4 MB（base64 约 45.9MB），**仍会触发一次 40MB 压缩** |

结论：1MB 阈值对 PNG 截图类会话的收益约 10%，不能单独把 1396 这类会话压到 40MB 以下；**这正是体积触发压缩存在的原因**——压缩命中缓存，代价可控。若希望显著降低触发频率，可把阈值下调到 500KB（列为待确认项）。

### 7.4 确定性

- 同一输入 + 同一参数 → 输出字节完全一致（sharp/libvips 编码确定）；
- 压缩参数变更（部署）只影响**新读的图**，历史消息不重写 → 不产生中段变化；
- 同一条消息重放时读的是落库后的字节，不重新编码。

## 8. 前缀缓存影响分析

### 8.1 缓存命中条件

主流供应商（OpenAI / DeepSeek / Anthropic）的前缀缓存都是「从第一条消息开始逐 token 完全匹配」：

- 每轮**尾部追加**消息 → 已有前缀继续命中；
- 历史**中段**任何改写 / 删除 / 重排 → 从该位置起全部失效。

现有 `prompt-prefix-monitor.ts` 已按这个口径做逐条消息指纹比对，`tailRewrite` 不算变化、中段变化会告警 `message prefix changed ... divergedAt=N`。

### 8.2 逐项影响

| 方案点 | 是否改动历史中段 | 对缓存的影响 |
|---|---|---|
| 图片前置压缩（>1MB） | 否，写入时固定 | **无**：同一条历史每轮字节一致 |
| 体积触发压缩 | 是（整窗重置） | **一次性失效**，与现有 token 压缩同性质；之后重建前缀 |
| 压缩请求（不剥图） | 否，只在末尾追加指令 | **命中**：前缀与主请求完全一致 |
| 压缩请求兜底剥图 | 是（仅在配置错误时） | 该次压缩调用不命中，日志标注 |
| Manifest 增加 requestBytes | 否（不进请求体） | **无** |

### 8.3 正常轮次零影响

未触发压缩的轮次：请求体只多了「历史图片原样注入」这一既有行为，与改造前逐字节一致（图片压缩只影响新图，且新图在写入时就已固定）。因此多轮对话的缓存命中率不会因为本方案下降。

### 8.4 触发压缩时的失效范围

- 压缩请求本身：命中历史前缀，只付新增 token；
- 压缩后的第一个主请求：历史被摘要替换 → **全量未命中一次**（与现有 token 压缩完全一致，不可避免）；
- 之后的轮次：从新前缀（system + summary + 最后一条用户消息）开始稳定命中。

以 180k 历史、2 元/M 全价计：一次压缩带来的额外成本约 0.36 元（主请求全量）+ 0.004 元（压缩调用增量），且只在 40MB 级会话发生。

### 8.5 验证方法

1. **单元测试**：同一份历史连续两次 `buildRequest`，`serializeChatRequest` 输出字节完全一致；
2. **前缀指纹**：灰度期间观察 `prompt-prefix-monitor` 日志，正常轮次只允许出现 `message prefix tail rewritten` 或没有日志；出现 `message prefix changed ... divergedAt=N` 即回归；
3. **缓存命中率**：对比改造前后 `llm_call.cached_tokens / prompt_tokens` 的分布，正常会话不应下降；
4. **专项用例**：构造 60 张图的会话，确认在 40MB 触发点之前每轮 `divergedAt` 均为空。

## 9. 配置项与默认值

| 键 | 类型 | 默认 | 生效 | 说明 |
|---|---|---|---|---|
| `harness.compaction.triggerPayloadBytes` | number | `41943040`（40 MiB） | 冷启动构建（改后需重启） | 0 = 关闭体积触发 |
| `llm_model.max_request_body_bytes`（新增列） | bigint | `0`（未知） | 模型配置即时生效 | 供应商请求体上限；>0 时触发阈值 = `min(全局, 80%×该值)` |
| `harness.compaction.triggerRatio` | number | `0.8`（线上为 0.9） | 冷启动构建 | 既有 token 触发 |
| `harness.compaction.enabled` | boolean | `true` | 冷启动构建 | 关闭后自动压缩（含体积触发）不生效，手动仍可用 |
| 图片压缩阈值 | 常量 | `1 MiB` | 代码常量 | >1MB 才压 |
| 图片压缩目标 | 常量 | `800 KiB` | 代码常量 | 压到 ≤800KB |
| 图片尺寸上限 | 常量 | `2048px / 2500 patches` | 代码常量 | 沿用现有 |

新增设置项需要同步：
- `settings/settings.service.ts`：新增 key + `optPositiveInt(..., 40 * 1024 * 1024)`；
- `settings/types.ts`：`HarnessTuningSettings.compaction.triggerPayloadBytes`；
- 模型配置：`llm_model` 加列（迁移 `V167__llm_model_max_request_body_bytes.sql`）、`LlmModelConfig` 字段、`model.routes.ts` 的读写与校验（单位 MB）；
- 管理后台：`IntegrationConfigPanel.vue` 增加压缩阈值表单项；模型编辑页增加「请求体上限（MB）」可选输入；
- `harness-service.resolveCompactionConfig` 的 Agent 级合并补字段。

## 10. 可观测

### 10.1 上下文详情

`ContextManifest` 增加两个数字字段（随现有 `context_window` 事件的 manifest 下发，不改 WS 协议）：

```ts
export interface ContextManifest {
  ...
  /** 本次请求估算体积（字节）。 */
  requestBytes?: number;
  /** 生效的体积阈值（0 表示关闭）。 */
  payloadLimitBytes?: number;
}
```

`trimContextManifest` 的 8KB 上限不变；前端在上下文抽屉顶部展示「请求体积 12.3 MB / 40 MB」，超过 80% 标黄。

### 10.2 日志

- 触发：`Session compaction triggered reason=payload bytes=44040192 threshold=41943040 sessionId=1396`
- 阈值来源：`compaction trigger resolved: global=41943040 providerLimit=52428800 effective=41943040`
- 缓存保护兜底：`compaction request exceeded provider limit, images stripped (cache miss for this call)`
- 图片压缩：`Image compressed tool=read_file path=... 2.71MB -> 0.78MB (1792x1408 webp q80)`
- 跳过重压：`Image kept as-is tool=read_file path=... 0.52MB`

### 10.3 压缩事件（P1 可选）

`session_compaction_event` 增加 `trigger_reason`（varchar 16）与 `payload_bytes_before/after`（bigint），迁移 `V168__compaction_payload_reason.sql`。P0 先只写日志。

## 11. 存量数据与兼容

1. **存量会话**（如 1396 的 47.6MB 图片）不改数据：下次请求体积 ≥ 阈值 → 触发一次压缩 → 窗口重置后回落。
2. **已完成的一次性处置**：1396 已通过 `JSON_REMOVE(metadata, '$.attachments[0].data_uri')` 剥离最早 44 张图（备份 `/data/mao-data/backup/session-1396-metadata-20261022-200227.json.gz`），属于临时运维动作，方案落地后不再需要。
3. **JSONL 导出 / 压缩归档**：`message-jsonl.ts` 本就把 data URI 替换为占位符，行为不变。
4. **无视觉能力的模型**：`ToolMediaInjector` 已有 `supportsVision` 短路，不受影响。
5. **压缩模型配置**：`compaction.modelId` 必须留空或与会话模型一致，否则压缩请求不共享缓存（见 §6.3）。

## 12. 风险与取舍

| 风险 | 影响 | 对策 |
|---|---|---|
| 压缩触发导致上下文被摘要化 | 长会话细节丢失 | 默认 40MB 远高于正常会话（绝大多数 < 5MB）；阈值可配 |
| 图片有损压缩影响识别 | 截图文字可能不清 | 只压 >1MB 的图，目标 800KB、长边 2048px；保留原文件路径，模型可 `read_file` 重看；灰度对比识别结果 |
| 供应商上限填错 | 阈值过高 → 413；过低 → 频繁压缩 | 模型配置可随时改；未填时用全局 40MiB；P2 加 413 自愈 |
| 压缩模型被配成别的模型 | 压缩请求吃不到缓存 | 后台提示「留空 = 使用会话模型（可命中缓存）」；日志记录本次压缩使用的模型 |
| 网关把同一模型路由到不同上游 | 压缩请求命中率不稳定 | 不在本项目控制范围；`prompt_cache_key` 已用于 Responses 粘性路由 |
| 1MB 阈值收益有限 | 图片密集会话仍会触发压缩 | 这是预期行为（压缩命中缓存）；如需进一步降低频率可下调阈值至 500KB |

## 13. 测试计划

### 13.1 单元测试

- `request-size.spec.ts`：空请求、中英混排文本、54 张 data URI、工具定义；与 `JSON.stringify` 真实值误差 ≤5%。
- `compaction-config.spec.ts`：`shouldTrigger` 四象限；`effectiveTriggerBytes` 在「未配置上限 / 上限 50MB / 上限 32MB」三种情况下的取值。
- `compaction-service.spec.ts`：
  - 体积触发时压缩被调用；
  - **压缩请求消息列表与 `normalRequest` 完全一致（只在末尾多一条指令）**；
  - 阈值配置错误导致压缩请求超限时，剥图分支生效并打日志；
  - `force=true` 绕过判定。
- `prompt-image-resizer.spec.ts`：
  - ≤1MB 输入原样返回（字节完全一致）；
  - >1MB 输入压到 ≤800KB；
  - alpha 图走 WebP；
  - 同输入两次输出字节一致（确定性）。
- `file-tools.spec.ts` / `page-tools.spec.ts`：`data_uri` 为处理后字节，`size_bytes` 口径正确。

### 13.2 集成 / 回归

- 构造 60 张 1MB 图片的会话 → 请求体积到阈值 → 触发一次压缩 → 压缩请求命中前缀 → 下一次请求 < 5MB。
- 回归：普通会话（<1MB）不产生任何压缩调用（spy 断言 `compact` 未调用）。
- 缓存回归：同一历史连续两次构建请求，序列化字节一致。

### 13.3 手工验证

- 复现 1396 形态：连续读 20 张 2K 截图，观察请求体积曲线、压缩触发点、压缩后继续对话。
- 视觉可用性：同一张 UI 截图，压缩前后让模型描述页面元素，对比准确率。

## 14. 上线与回滚

- 后端改动走现有流程：工作区改代码 → push `origin/main` → `/data/deploy-mao.sh --backend-only`（蓝绿重启）。
- 配置默认即开启；临时关闭体积触发：`harness.compaction.triggerPayloadBytes = 0` 并重启。
- 图片压缩回退：代码级开关（`HARNESS_IMAGE_COMPRESS=off`）保留一个版本，稳定后删除。
- 回滚不影响已压缩的历史数据（只是图片小一点），无需数据订正。

## 15. 分期实施

| 阶段 | 内容 | 价值 | 预估 |
|---|---|---|---|
| P0 | §4 估算器、§5 体积触发 + 模型上限、§6 压缩保缓存、§7 图片前置压缩（>1MB） | 消除 413 卡死；压降低频；正常轮次缓存零影响 | 1.5–2 天 |
| P1 | §10 manifest 展示、压缩事件记录 reason/bytes | 可观测性 | 0.5–1 天 |
| P2 | 413 自愈（剥图重试一次）、按模型灰度阈值 | 对未知上游兜底 | 1 天 |

## 16. 待确认问题

1. **压缩目标字节**：`>1MB 才压` 已确认；目标值暂定 800KB。若希望更激进（如 500KB），可下调，代价是截图文字清晰度。
2. **模型级上限**：新增 `llm_model.max_request_body_bytes`（MB），默认 0 = 未知、用全局 40MiB。是否所有模型都填？建议至少给 50MB 通道的模型填 50。
3. **图片格式**：PNG 截图压缩时默认转 WebP（带 alpha）或 JPEG（无 alpha），是否接受无损转有损？若要求保持 PNG，可改为「仅缩尺寸 + PNG 重编码」，收益会明显下降。
4. **触发阈值是否按模型灰度**：P0 先用全局 + 模型上限，暂不做按模型独立阈值。


