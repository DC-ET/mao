# 会话压缩新增「请求体体积」触发 + 图片体积治理 技术方案

- 状态：基础方案，待评审后实施
- 日期：2026-10-22
- 事故来源：会话 1396（王胡云 / 「VTN APP 首页改版方向」）连续 5 次 `LLM API returned 413`，会话被置为 `FAILED`
- 范围：后端 harness 的压缩触发、压缩请求构造、图片注入与图片编码；管理后台新增 1 个压缩配置项。**不改** WS 事件协议、不改数据库表结构（P2 可选）
- 关联代码（当前工作区 `mao/`，2026-10-22）：
  - `backend-ts/src/harness/core/compaction-config.ts`（压缩阈值）
  - `backend-ts/src/harness/core/compaction-service.ts`（触发判定、压缩请求派生、结果校验）
  - `backend-ts/src/harness/core/session-compaction-orchestrator.ts`（三个触发入口的统一编排）
  - `backend-ts/src/harness/core/harness-service.ts:498-522`（request_start 触发）
  - `backend-ts/src/harness/core/agent-loop.ts:520-545`（mid_loop 触发）、`:590-614`（manual 触发）
  - `backend-ts/src/harness/core/token-estimator.ts`（现有 token 估算口径）
  - `backend-ts/src/harness/core/active-context-calculator.ts`（锚点增量口径）
  - `backend-ts/src/harness/core/tool-media-injector.ts`（历史图片注入，无预算）
  - `backend-ts/src/harness/tool/tool-image-result-processor.ts`（图片结果落 metadata）
  - `backend-ts/src/harness/tool/prompt-image-resizer.ts`（尺寸规整，无字节目标）
  - `backend-ts/src/harness/tool/impl/read-file-tool.ts`（`readImage` 产出 data URI）
  - `backend-ts/src/harness/tool/impl/page-tools.ts`（`page_screenshot` 产出 data URI）
  - `backend-ts/src/harness/llm/openai-llm-adapter.ts:480-580`（请求体序列化与图片预处理）
  - `backend-ts/src/settings/settings.service.ts` / `types.ts`（`harness.compaction.*` 配置）
  - `admin/src/views/settings/components/IntegrationConfigPanel.vue:326-332`（配置项表单）

## 1. 背景

### 1.1 事故数据

| 指标 | 数值 |
|---|---|
| 会话 | 1396，模型 `deepseek-v4.1-flash（official）`（provider `newapi`，`baseUrl=https://new-api.acg.team/v1`） |
| 上下文 token | 最后一次成功调用 `prompt_tokens = 180,594`（窗口 512k，远未触达 0.8×512k≈41 万） |
| 历史图片 | 54 张工具图片（`read_file` / `page_screenshot`），`message.metadata` 合计 **47.65 MiB** |
| 最后成功 | 18:32:51，请求体约 **49.76 MB** |
| 首次 413 | 18:32:55，Agent 又读了一张 461KB 截图，请求体约 **50.39 MB** |
| 失败次数 | 18:32:55 / 18:33:19 / 18:33:35 / 18:38:01 / 18:39:21 共 5 次，全部 413，每次 3–4.7s（上传完请求体后被打回） |
| 上游边界 | 50MB（同一请求体在 49.76MB 时通过、50.39MB 时被拒；new-api 自身 `MAX_REQUEST_BODY_MB` 默认 128，实测 60MB 空载请求可通过，说明限制在 new-api 背后的上游通道） |

### 1.2 根因

1. **每轮请求都重放全部历史图片**：`ToolMediaInjector.inject()` 把 `context.toolAttachments` 里所有历史工具图片的 base64 data URI 原样塞进请求，没有张数/字节预算。
2. **图片几乎不压缩**：`PromptImageResizer` 只在「长边 > 2048px 或 patches > 2500」时才重编码，1800×1200、1160×2048 这类合规尺寸的 PNG 截图原样保留（单张最大 2.7MB）；适配器 `resizeDataUri` 复用同一判据，同样放行。
3. **压缩只看 token**：`CompactionConfig.triggerRatio = 0.8`，本会话 180k / 512k，永远不会触发；而 `TokenEstimator` 对图片只按 **1000 tokens/张** 估算（54 张 ≈ 5.4 万），图片的「字节成本」完全不参与决策。
4. **压缩请求自己也超限**：`CompactionService.deriveRequest()` 直接复制 `normalRequest`（已注入全部图片）再加一条指令，压缩请求同样是 50MB，即使强制手动整理也会 413。

### 1.3 现有机制覆盖情况

| 机制 | 位置 | 能否覆盖 |
|---|---|---|
| token 阈值压缩 | `compaction-service.ts` + `compactSession` | 否，图片按 1000 token/张，体积先行触顶 |
| mid-loop 压缩 | `agent-loop.ts:520-545` | 否，同一 token 判据 |
| 手动整理 | `agent-loop.ts:590-614` | 否，压缩请求带全部图片，同样 413 |
| 图片尺寸规整 | `prompt-image-resizer.ts` | 部分，只处理超大尺寸，PNG 不重编码 |
| 413 重试 | `openai-llm-adapter.ts` | 否，413 不在可重试状态白名单，直接终态失败 |

## 2. 目标与非目标

### 2.1 目标

1. **新增请求体体积触发**：请求体估算体积超过阈值（默认 40 MiB）时触发会话压缩，与现有 token 阈值是「或」关系。
2. **压缩请求自身可控**：压缩请求剥离历史图片，保证「因体积触发压缩」时压缩请求一定能发出去（不能出现「要压缩但压缩请求也超限」的死锁）。
3. **图片进入请求的体积可控**：
   - 写入侧压缩：工具产出图片时按尺寸 + 字节目标重编码，落库的 data URI 即为压缩后版本；
   - 注入侧预算：历史图片回放有张数与总字节上限，超出部分以文字占位；
   - 适配器兜底：单图字节超限时重编码，覆盖存量脏数据。
4. **确定性**：同一历史在同一配置下每次构建出的图片字节完全一致，不因压缩引入额外的前缀缓存抖动。
5. **可观测**：上下文详情能看到「本次请求体积」，压缩日志/事件能看到触发原因（token / payload / manual）。
6. **不改变正常会话行为**：未达阈值的会话零额外请求、零额外 token。

### 2.2 非目标

- 不按供应商/渠道维护「硬上限表」，也不做请求体预检拒绝（未知上游限制太多）。
- 不改动 `TokenEstimator` 的图片 token 估算口径（本次只补字节维度）。
- 不改压缩摘要的模型、提示词与语义契约。
- 不压缩用户上传的原始文件（`chat-files/` 落盘文件保持原样），只压缩「发给模型的副本」。
- 不改桌面/移动端交互；管理后台只加一个数字配置项。
- P0 不做 413 自动降级重试（列为 P2）。

## 3. 方案总览

```
构建请求 (PromptEngine.buildRequest)
   │  注入历史图片（ToolMediaInjector，新增预算：最近 N 张 / 总字节上限）
   ▼
估算体积 (RequestSizeEstimator：消息 + 图片 data URI + 工具定义)
   │
   ├─ token ≥ 窗口×0.8 ─┐
   └─ 体积 ≥ 40MiB ─────┴─► 触发压缩
                              │
                              ├─ 压缩请求：剥离历史图片（保留最近 2 张 / ≤2MB）
                              ├─ 生成交接摘要 → 推进压缩边界（整窗重置）
                              └─ 重建请求 → 体积回到基线
   ▼
序列化 (adapter.buildRequestBody)
   └─ 单图兜底：尺寸超限 或 字节超限 → 重编码（WebP/JPEG）
```

三层防线各管一段：

| 层 | 位置 | 作用 | 生效时机 |
|---|---|---|---|
| L1 写入侧压缩 | `read_file` / `page_screenshot` → `PromptImageResizer.compressForStore` | 新图片从源头变小（单图 ≤ 400KB） | 工具产出时，一次 |
| L2 注入侧预算 | `ToolMediaInjector` | 历史图片回放总量受控（≤12MB / ≤8 张） | 每次构建请求 |
| L3 适配器兜底 | `openai-llm-adapter.resizeDataUri` | 存量/异常大图强制重编码（单图 ≤1.5MB） | 每次发送 |

压缩触发是「总量兜底」，三层图片治理是「把总量压下来」，二者配合：正常情况下体积永远到不了 40MB；到 40MB 说明历史文本或图片异常增长，压缩一次性重置窗口。反过来，L1/L2 上线后单靠图片很难再把请求推到 40MB，该阈值主要兜住「文本/工具输出本身膨胀」和存量脏数据。

## 4. 请求体体积指标

### 4.1 定义

`requestBytes` = 最终 `ChatRequest` 序列化为 HTTP body 后的字节数（UTF-8），口径与适配器 `harness/llm/json.ts` 的 `serializeChatRequest` 一致：`messages` + `tools` + 顶层参数（`model` / `stream` / `reasoning` / `prompt_cache_key` 等）。

采用**估算**而不是真实 `JSON.stringify`：50MB 级别字符串每次构建都序列化会带来 100ms 级开销与同量级临时内存，而阈值判断只需要 ±3% 精度。

### 4.2 新增 `RequestSizeEstimator`（`harness/core/request-size.ts`）

```ts
export class RequestSizeEstimator {
  /** 估算整个请求的 wire bytes（UTF-8）。 */
  estimate(request: ChatRequest): number;

  estimateMessages(messages: ChatMessage[]): number;
}
```

逐项口径：

| 组成 | 估算方式 | 说明 |
|---|---|---|
| `role` / `toolCallId` | `Buffer.byteLength` | 小字段，直接精确算 |
| `content: string` | `Buffer.byteLength` | 文本，含中文（3 bytes/字） |
| `content: ContentPart[]` | 文本 `byteLength` + `image_url.url.length` | data URI 为纯 ASCII base64，`length` 即字节数，避免扫描 50MB |
| `toolCalls` | `arguments.length + id.length + 常量` | 参数是 JSON 字符串，直接取长度 |
| `reasoningContent` | `Buffer.byteLength` | 历史 thinking 会随请求回传 |
| `tools` | `Buffer.byteLength(JSON.stringify(tool.parameters))` | 工具定义在一次执行内不变，按数组引用缓存（`WeakMap`） |
| 顶层参数 | 常量（≤ 1KB） | 可忽略，仍计入 |

- **精度**：JSON 转义会让文本里的 `"` `\` `\n` 膨胀（最多 2×），但这类字符占比很低；base64 不需要转义。估算值再乘 **1.02 安全系数**，文档与日志里统一按「估算值」表述。
- **性能**：229 条消息 + 54 个 data URI 的会话，一次估算 < 2ms（字符串 `length` 为 O(1)，只有文本走 `byteLength`）。
- **复用**：`estimateMessages` 同时用于「广告位」展示（manifest）与压缩判定，避免两套口径。

### 4.3 与 token 口径的关系

- token 判定继续用 `ActiveContextCalculator`（锚点 + 增量），保证既有行为不变。
- 体积判定**总是对完整请求估算**，不做锚点增量：图片注入发生在 `buildRequest` 阶段，锚点里没有「体积」概念，增量法反而容易低估。
- 两个指标只用于「是否触发压缩」，不参与 UI 的 token 水位展示（体积单独展示，见 §9）。

## 5. 触发规则

### 5.1 配置

`CompactionConfig` 新增：

```ts
export class CompactionConfig {
  ...
  /** 请求体体积触发阈值（字节）；0 表示关闭体积触发。默认 40 MiB。 */
  triggerPayloadBytes = 40 * 1024 * 1024;
}
```

对应系统设置项 `harness.compaction.triggerPayloadBytes`（NUMBER，默认 `41943040`），管理后台「集成配置 → 会话压缩」新增一行「请求体体积阈值（MB）」，前端换算成 MB 展示（默认 40）。

> 用 MiB 而不是十进制 MB：与上游 Nginx / 网关的 `m` 单位对齐，40 MiB 相对 50MB 上限留约 21% 余量。

### 5.2 判定函数

```ts
export type CompactionTriggerReason = 'tokens' | 'payload' | 'both' | 'manual';

CompactionConfig.shouldTrigger(params: {
  tokens: number;
  payloadBytes: number;
  triggerWindowTokens: number;
  config: CompactionConfig;
}): CompactionTriggerReason | null;
```

规则：

```
tokensHit  = tokens >= floor(triggerWindowTokens * config.triggerRatio)
payloadHit = config.triggerPayloadBytes > 0 && payloadBytes >= config.triggerPayloadBytes
if (tokensHit && payloadHit) return 'both'
if (tokensHit) return 'tokens'
if (payloadHit) return 'payload'
return null
```

`force=true`（手动整理）绕过判定，保持现有语义。返回值 `manual` 仅供事件/日志标注，`shouldTrigger` 本身不会返回它。

### 5.3 三个调用点

| 入口 | 现状 | 改造 |
|---|---|---|
| `harness-service.buildContext`（request_start） | 先算 `activeTokensHint` 再调 `compact`，判定在 `compactSession` 内部 | 额外传入 `payloadBytes = this.requestSizeEstimator.estimate(normalRequest)` |
| `agent-loop.ts:529-537`（mid_loop） | 调用前先判 `nextRequestTokens >= window*ratio` | 改为 `CompactionConfig.shouldTrigger(...)`，命中才调 `compact`；传入 `nextRequestTokens` 与 `nextRequestBytes` |
| `agent-loop.ts:590-614`（manual） | `force=true` | 不变，仅补传 `payloadBytes` 用于日志与事件 |

`compactSession` 签名扩一个可选参数（保持向后兼容，老调用方不传即按 token 判定）：

```ts
async compactSession(
  sessionId, expectedOldBoundary, messages, snapshotMessageIds,
  normalRequest, modelConfig, config, listener, cancelFlag,
  activeTokensHint?: number | null,
  force = false,
  sessionModelConfig?: LlmModelConfig | null,
  payloadBytes?: number | null,   // 新增
): Promise<SessionCompactionResult | null>
```

### 5.4 防抖与死循环

- **同一执行内只压缩一次体积触发**：`AgentExecutionContext` 新增 `payloadCompactionDone: boolean`。mid-loop 若本轮已因体积压缩过一次，后续轮次不再触发（图片预算会兜住单轮增长）。
- **压缩后仍超限则不再重试**：压缩完成后重新 `estimate`，若仍 ≥ 阈值，记录 `warn` 日志并跳过，避免「压缩 → 仍超 → 再压缩」的空转。正常路径下整窗重置后体积会降到 MB 级，不会触发。
- **与 token 触发共用阈值语义**：不新增冷却时间，避免用户感知到「明明没超却不压缩」。

### 5.5 为什么不改成「按百分比」

不同上游的 body 上限差异很大（50MB / 32MB / 128MB），且与模型窗口无关（512k 模型也可能落在 50MB 通道上）。用固定字节阈值 + 可配置，比「窗口百分比」更贴近真实约束。

## 6. 压缩请求自身的体积治理（关键）

### 6.1 问题

`CompactionService.deriveRequest()` 目前：

```ts
const messages = source.messages ? [...source.messages] : [];
messages.push({ role: 'user', content: appendedUserContent });
return { ...source, messages, stream: true };
```

`source` 是已注入图片的 `normalRequest`，54 张图 48MB → 压缩请求同样 48MB → 因体积触发的压缩会先撞 413。

### 6.2 设计

新增 `stripImagesForCompaction(request, opts)`，在 `deriveRequest` 内执行：

```ts
interface CompactionImageBudget {
  /** 保留最近几张图片，默认 2（交接摘要基本只需要最近视觉上下文）。 */
  keepRecentImages: number;
  /** 保留图片的总字节上限，默认 2 MiB。 */
  maxBytes: number;
}
```

处理规则：

1. 遍历 `messages`，把 `content` 数组中的 `image_url` part 替换为 `{ type: 'text', text: '[历史图片已省略]' }`；
2. `ToolMediaInjector` 注入的「合成 user 消息」（内容为 `SYNTHETIC_ATTACHMENT_PROMPT` + 单张图片）整条删除，避免留下无意义文本；
3. 从**最新往旧**累计，最近 `keepRecentImages` 张且总字节 ≤ `maxBytes` 的图片保留，其余按 1、2 处理；
4. 被省略的图片在交接指令里追加一行说明：`历史图片已省略（原文件仍在工作区，可重新读取）`，避免摘要模型误判「没有图片信息」。

### 6.3 二次保护

构造完压缩请求后再估算一次：

```
if (estimate(compactionRequest) >= config.triggerPayloadBytes * 0.8) {
  // 极端场景：保留的 2 张图仍然太大 / 文本本身过大 → 全部剥离图片
  stripAllImages(compactionRequest);
}
if (estimate(compactionRequest) >= config.triggerPayloadBytes) {
  throw new CompactionContextOverflowException(...);  // 复用现有异常，走既有降级
}
```

现有 `compactionRequestTokens >= overflowWindow` 的 token 溢出保护保持不变；体积保护与其并列。

### 6.4 效果

以会话 1396 为例：压缩请求从 ~50MB 降到「文本 ~0.4MB + 最近 2 张图 ≤2MB」≈ **2.4MB**，稳定可发。

## 7. 图片体积治理

**结论：可以做，而且应该做，但压缩点要选在「工具产出图片时」（写入侧），而不是每次请求时。** 理由：① 只压一次，落库即压缩后字节，后续每轮构建零额外 CPU；② 输出确定，不引入新的前缀缓存抖动；③ 同时降低 DB 体积与 RPC 带宽。请求侧（注入预算、适配器兜底）只负责「预算」与「存量脏数据」，不承担常规压缩。

### 7.1 L1 写入侧压缩（主方案）

#### 7.1.1 新增能力

`PromptImageResizer` 增加：

```ts
export const STORE_MAX_DIMENSION = 1600;      // 长边上限（默认）
export const STORE_MAX_BYTES = 400 * 1024;    // 单图字节目标
export const STORE_WEBP_QUALITY = 80;

compressForStore(input: Buffer, mimeHint?: string | null, opts?: {
  maxDimension?: number;
  maxBytes?: number;
}): Promise<PromptImageResult>
```

算法：

1. 尺寸规整：长边 ≤ `maxDimension`，且 patches（`ceil(w/32)*ceil(h/32)`）≤ 2500（沿用现有常量，保证模型侧可接受）；
2. 编码选择：
   - 有 alpha 的 PNG/WebP → **WebP q80**（截图文字优于 JPEG）；
   - 无 alpha 的 PNG/JPEG → **JPEG q80**（体积更小）；
   - 其他（GIF 等）→ PNG；
3. 若编码后 > `maxBytes`：先降质量（80 → 70 → 60），仍超则按 0.85 比例缩尺寸重试，最多 3 轮；
4. 仍超 `maxBytes` 时接受实际结果并记 `warn`（不阻断工具）；
5. **小图不放大、不重编码**：原图已满足「≤ 800px 且 ≤ 120KB」时直接返回原字节，避免无意义的有损转换。

`PromptImageResult` 增加 `sourceBytes`（原图字节）与 `compressed: boolean`，用于工具返回文案与日志。

#### 7.1.2 接入点

| 工具 | 现状 | 改造 |
|---|---|---|
| `read_file`（`readImage`） | `PromptImageResizer.resizeForPrompt`（只限尺寸） | 改调 `compressForStore`；返回文案里的 `size_bytes` / 尺寸按压缩后口径（现有代码已是压缩后口径，语义不变） |
| `page_screenshot`（`PageScreenshotTool`） | 直接把客户端 data URI 塞进结果 | 解码 data URI → `compressForStore` → 重新编码返回；失败时回退原图并 `warn` |
| 其他图片类工具 | `ToolImageResultProcessor` 只做透传 | 不改，`compressForStore` 已在上游覆盖 |

> 写入侧压缩是**一次性**的：落库的 `message.metadata.attachments[].data_uri` 就是压缩后的字节，历史回放与请求构建不再重复编码，前缀缓存天然稳定。

#### 7.1.3 收益估算（会话 1396 实测数据）

| 策略 | 54 张图合计 | 请求体 |
|---|---|---|
| 现状 | 47.65 MiB | ~50MB（413） |
| 单图 ≤400KB | ≤21.6MB | ~22MB |
| 单图 ≤250KB | ≤13.5MB | ~14MB |
| 单图 ≤400KB + 注入预算 12MB | ≤12MB | ~12.5MB |

### 7.2 L2 注入侧预算

`ToolMediaInjector.inject()` 增加预算（构造参数或模块常量）：

```ts
const DEFAULT_BUDGET = {
  maxImages: 8,                    // 最多回放最近 8 张
  maxBytes: 12 * 1024 * 1024,      // 总字节上限 12 MiB
};
```

规则：

- 从**最新消息往旧**遍历，累计 `dataUri.length`，达到任一上限后停止注入；
- 被跳过的图片**不生成任何消息**（工具结果文本里已有文件名、尺寸，模型知道读过图）；
- 同一历史每次构建结果一致（纯函数），新增图片可能淘汰一张旧图，导致前缀缓存失效一次 —— 这是「可发」换「缓存命中」的必要取舍，且只在超大图会话发生；
- `maxImages` / `maxBytes` 走 `CompactionConfig` 同级的 harness 配置常量即可，P0 不做成管理后台配置项。

### 7.3 L3 适配器兜底

`openai-llm-adapter.resizeDataUri()` / `downloadAndEncode()` 目前只调 `tryResizeForPrompt`（尺寸判据）。改为：

```ts
// 尺寸超限 或 单图字节 > PROMPT_IMAGE_MAX_BYTES（默认 1.5 MiB）时重编码
PromptImageResizer.tryCompressForPrompt(bytes, mimeHint, { maxBytes: 1.5 * 1024 * 1024 })
```

- 覆盖存量数据（例如本次事故里 2.7MB 的 PNG）与第三方 URL 图片；
- 为避免每轮重复解码，增加进程内 LRU：`key = sha256(dataUri)`，`value = 压缩后 dataUri`，容量按字节限制（默认 64MB）；命中直接替换。
- Anthropic / Responses 两个适配器复用同一 helper（`resizeDataUri` 逻辑目前各自实现，需抽到 `prompt-image-resizer` 旁的公共函数）。

### 7.4 为什么不只在适配器压

- 适配器压缩只影响「本次请求」，DB 里仍是 48MB，每轮都要重新解码 50MB → CPU 抖动；
- 前缀缓存：适配器结果确定，但如果实现里带随机（不同质量档位选择），缓存会抖；写入侧只压一次，字节永久固定；
- 真正要修的是「历史无限重放」这个结构性原因，不是单点打补丁。

## 8. 配置项与默认值

| 键 | 类型 | 默认 | 生效 | 说明 |
|---|---|---|---|---|
| `harness.compaction.triggerPayloadBytes` | number | `41943040`（40 MiB） | 冷启动构建（与现有 compaction 配置一致，改后需重启） | 0 = 关闭体积触发 |
| `harness.compaction.triggerRatio` | number | `0.8` | 同上 | 既有，token 触发 |
| `harness.compaction.enabled` | boolean | `true` | 同上 | 既有，关闭后自动压缩不生效（手动仍可用） |
| 图片注入预算 | 常量 | `8 张 / 12 MiB` | 代码常量 | P0 不做后台配置 |
| 写入侧压缩目标 | 常量 | `1600px / 400KB / q80` | 代码常量 | 后续可通过 Agent 级配置覆盖 |
| 适配器单图上限 | 常量 | `1.5 MiB` | 代码常量 | 兜底 |

> 注意：`harness.compaction.enabled=false` 时体积触发同样关闭（与 token 触发口径一致）；此时仍由 L2 注入预算 + L3 适配器兜底保证请求体不随图片无限增长，只是不会主动摘要在途历史。

新增设置项需要同步：
- `settings/settings.service.ts`：`HARNESS_COMPACTION_TRIGGER_PAYLOAD_BYTES_KEY = 'harness.compaction.triggerPayloadBytes'`，读取时 `optPositiveInt(..., 40 * 1024 * 1024)`；
- `settings/types.ts`：`HarnessTuningSettings.compaction.triggerPayloadBytes`；
- 构建 `CompactionConfig` 的地方（`app-*` 装配、`harness-service.resolveCompactionConfig` 的 Agent 级 merge）补字段；
- `admin/src/views/settings/SystemSettingsView.vue:258` 与 `IntegrationConfigPanel.vue:326-332` 增加键与表单项（单位 MB，存字节）。

## 9. 可观测

### 9.1 上下文详情（前端已有抽屉）

`ContextManifest` 增加：

```ts
export interface ContextManifest {
  ...
  /** 本次请求估算体积（字节），与压缩判定同源。 */
  requestBytes?: number;
  /** 体积上限（0 表示关闭）。 */
  payloadLimitBytes?: number;
}
```

- 随现有 `context_window` 事件的 `manifest` 字段下发，**不改 WS 协议**；
- `trimContextManifest` 的体积上限 8KB 不变（新增两个数字字段可忽略）；
- 首屏/刷新后回放走 `session.context_manifest_json`，同样生效；
- 前端展示：上下文抽屉顶部「请求体积 12.3 MB / 40 MB」，超过 80% 时标黄。

### 9.2 日志

- 触发：`Session compaction triggered reason=payload bytes=50331648 threshold=41943040 sessionId=1396`
- 跳过（已达上限但本轮已压过）：`Session compaction skipped: payload still above threshold after compaction sessionId=...`
- 图片压缩：`Image compressed tool=read_file path=... 461KB -> 182KB (1600x1067 webp q80)`
- 注入预算：`Tool media injection budget hit: injected 8/54 images (11.2MB/47.6MB)`

### 9.3 压缩事件（P2）

`session_compaction_event` 增加 `trigger_reason`（varchar 16）与 `payload_bytes_before/after`（bigint），迁移 `V167__compaction_payload_reason.sql`。P0 先只写日志，不动表结构。

## 10. 存量数据与兼容

1. **存量会话**（如 1396，DB 里 47.6MB 图片）不改数据：L2 预算 + L3 兜底保证下次请求可发；下一次因体积触发压缩后，旧图片随边界推进自然离开活动窗口。
2. **已完成的一次性修数据**：本次事故已通过 `JSON_REMOVE(metadata, '$.attachments[0].data_uri')` 剥离最早 44 张图（备份见 `/data/mao-data/backup/session-1396-metadata-20261022-200227.json.gz`），属于临时处置，方案落地后不再需要人工介入。
3. **JSONL 导出 / 压缩归档**：`message-jsonl.ts` 本就把 data URI 替换为占位符，压缩后的 data URI 行为不变。
4. **历史消息中的图片预览**：桌面端工具卡片缩略图读的是 metadata 的 data URI，压缩后会更小（可接受）；原文件仍可通过工作区文件浏览器查看。
5. **无视觉能力的模型**：`ToolMediaInjector` 已有 `supportsVision` 短路，本次改造不改变该分支。

## 11. 风险与取舍

| 风险 | 影响 | 对策 |
|---|---|---|
| 压缩触发导致上下文被摘要化 | 长会话细节丢失 | 默认 40MB 远高于正常会话（绝大多数 < 5MB），只在异常膨胀时触发；阈值可配 |
| 压缩请求剥离图片导致摘要漏掉视觉细节 | 交接摘要可能少一段画面描述 | 保留最近 2 张图；交接指令显式说明「图片已省略、原文件可重读」；摘要以文字结论为主 |
| 图片有损压缩影响模型识别 | 截图文字可能看不清 | 长边 1600px + q80 WebP 对 1080P 截图实测可读；保留原文件路径，模型可 `read_file` 重看；先灰度观察 413/识别失败率 |
| 注入预算淘汰旧图导致前缀缓存失效 | 超大图会话成本上升 | 只在 >12MB 时发生；写入侧压缩后大部分会话不会触达 |
| 适配器每次压缩增加 CPU | 首字延迟 | LRU 缓存 + 只在超限时压缩 |
| 估算误差导致误判 | 提前/延后压缩 | 1.02 安全系数 + 40MiB 阈值对 50MB 上限留 20% 余量 |
| 压缩后仍超限 | 会话再次卡死 | §5.4 防死循环 + §6.3 二次剥离 + P2 的 413 自愈 |
| 图片压缩改变既有单测快照 | CI 红 | 更新 `file-tools` / `image-support` 相关断言，新增确定性用例 |

## 12. 测试计划

### 12.1 单元测试

- `request-size.spec.ts`：空请求、纯文本（中英混排）、含 54 张 data URI、含工具定义；与 `JSON.stringify` 真实值的误差 ≤ 5%。
- `compaction-config.spec.ts`：`shouldTrigger` 四象限（tokens / payload / both / none）+ `triggerPayloadBytes=0` 关闭。
- `compaction-service.spec.ts`：
  - 体积触发时压缩被调用；
  - 压缩请求剥离历史图片（保留最近 2 张 / ≤2MB），合成附件消息被删除；
  - 压缩请求体积 ≥ 0.8×阈值时全剥离；
  - `force=true` 绕过判定。
- `tool-media-injector.spec.ts`：张数预算、字节预算、由新到旧、被跳过图片不产生消息、同一输入两次结果一致。
- `prompt-image-resizer.spec.ts`：`compressForStore` 的字节目标、alpha 处理、小图不重编码、同输入同输出（确定性）。
- `file-tools.spec.ts`（`read_file` 读图）/ `page-tools.spec.ts`（`page_screenshot`）：返回的 `data_uri` 为压缩后字节，`size_bytes` 口径正确。

### 12.2 集成 / 回归

- 构造 60 张 1MB 图片的会话 → 第 N 轮请求体积 ≥ 40MB → 触发压缩 → 下一次请求 < 5MB。
- 模拟上游 413（本地 mock server）→ 校验日志、会话不再二次撞线（P2 自愈另测）。
- 回归：普通会话（< 1MB）不产生任何压缩调用与额外 LLM 请求（用 spy 断言 `compact` 未被调用）。

### 12.3 手工验证

- 复现会话 1396 形态：连续 `read_file` 读取 20 张 2K 截图，观察请求体积曲线（日志 + 上下文抽屉）、压缩触发点、压缩后继续对话。
- 视觉可用性：同一张 UI 截图，压缩前后让模型描述页面元素，对比准确率。

## 13. 上线与回滚

- 全部为后端改动，走现有流程：工作区改代码 → push `origin/main` → `/data/deploy-mao.sh --backend-only`（蓝绿重启）。
- 配置项默认值即开启；如需临时关闭体积触发：后台把 `harness.compaction.triggerPayloadBytes` 设为 0 并重启后端。
- 图片压缩如需回退：代码级开关（`HARNESS_IMAGE_COMPRESS=off` 环境变量）保留一个版本，确认稳定后删除。
- 回滚不影响已压缩的历史数据（只是图片小一点），不需要数据订正。

## 14. 分期实施

| 阶段 | 内容 | 价值 | 预估 |
|---|---|---|---|
| P0 | §4 估算器、§5 体积触发、§6 压缩请求剥图、§7.2 注入预算 | 彻底消除「一撞 50MB 就卡死」；会话 1396 这类场景自愈 | 1.5–2 天 |
| P1 | §7.1 写入侧压缩、§7.3 适配器兜底 + LRU、§9 manifest 展示 | 把请求体积长期压到 10–20MB，降低带宽与首字延迟 | 1–1.5 天 |
| P2 | 413 自愈（剥离历史图片重试一次）、压缩事件记录 reason/bytes、管理后台展示 | 对未知上游限制兜底；可观测性 | 1 天 |

P0 与 P1 可以合并发布；P2 视观察结果决定。

## 15. 待确认问题

1. **阈值单位**：方案按 40 MiB（41,943,040 字节）。若希望按十进制 40MB（40,000,000）实现，请明确，二者差 5%。
2. **图片压缩档位**：默认长边 1600px / 单图 400KB / WebP q80。若更看重识别精度，可改为 2048px / 800KB（体积约翻倍）。
3. **是否保留最近图片**：压缩请求默认保留最近 2 张（≤2MB）。若希望压缩请求完全不带图（最省），可改 `keepRecentImages=0`。
4. **是否需要在压缩前提示用户**：体积触发是自动行为，默认静默（与现有 token 触发一致）。
5. **配置项粒度**：P0 用全局设置；若不同 Agent/模型需要不同阈值，再考虑 Agent 级 `compaction.triggerPayloadBytes` 覆盖（现有 `resolveCompactionConfig` 已支持 Agent 级合并）。


