# 技术方案：read_file 支持图片读取

## 1. 需求背景

当前 `read_file` 工具按**文本文件**处理：后端用 `Files.lines()` 按行读取，桌面端 LOCAL 模式用 `fs.readFileSync(path, 'utf-8')`。当 Agent 读取 `.png`、`.jpg` 等工作区图片时，会得到乱码或读取失败，无法让支持视觉的模型「看见」图片内容。

项目已具备多模态对话能力：用户可在聊天中附加 OSS 图片 URL，后端组装为 `ChatRequest.ContentPart`（`image_url`）发送给 LLM；`LlmModel.supportsVision` 字段与发送前校验也已存在。缺口在于 **Agent 通过工具读取的图片无法进入模型上下文**。

OpenAI-compatible 协议的 `role: "tool"` 消息**只能承载字符串**，不能夹带图片。因此采用「搬运」策略——工具结果保留纯文本，图片从工具结果中抽离，作为紧随其后的 **synthetic user message** 注入 LLM 上下文。

## 2. 需求描述

### 2.1 要做什么

| 编号 | 需求 |
|------|------|
| R1 | 扩展 `read_file`，当目标文件为图片时，读取二进制并返回结构化结果（含 MIME、尺寸信息、base64 data URI） |
| R2 | 工具结果发给 LLM 时，遵循策略：tool 消息仅保留文本摘要；图片以 synthetic user message（`image_url` part）插入上下文 |
| R3 | 当前模型 `supportsVision = 0` 时，不注入图片，在 tool 文本结果中返回明确错误，引导 Agent 告知用户切换视觉模型 |
| R4 | CLOUD 与 LOCAL 双模式行为一致（同一 JSON 契约） |
| R5 | 会话持久化与重载后，历史中的图片附件仍可被重新注入 LLM 上下文 |
| R6 | 前端工具卡片对图片读取结果展示缩略图预览（不展示完整 base64） |
| R7 | 更新 `ToolResultSummarizer`、token 估算、单元测试 |

### 2.2 不做什么

| 编号 | 范围外 |
|------|--------|
| N1 | **不**新增独立 `read_image` 工具，统一在 `read_file` 内按扩展名/MIME 分流 |
| N2 | **不**支持 PDF、SVG、HEIC、视频等非位图格式（v1 仅常见位图） |
| N3 | **不**把 base64 图片塞进 `role: "tool"` 的 `content` 字段发给 LLM |
| N4 | **不**对非视觉模型做 OCR/图片描述降级（仅返回错误文本） |
| N5 | **不**将工具读取的图片上传 OSS（v1 用 metadata 存 data URI；压缩时剥离载荷） |
| N6 | **不**对图片应用 `offset` / `limit` 行号参数（图片读取忽略这两个参数） |
| N7 | **不**改动用户手动附加图片的发送流程（已有能力保持不变） |

### 2.3 支持的图片格式

| 扩展名 | MIME |
|--------|------|
| `.png` | `image/png` |
| `.jpg` / `.jpeg` | `image/jpeg` |
| `.gif` | `image/gif` |
| `.webp` | `image/webp` |

通过扩展名映射 MIME；读取后用文件头魔数做二次校验，防止扩展名伪装。

### 2.4 限制

| 项 | 值 | 说明 |
|----|-----|------|
| 单张图片最大体积 | **5 MB** | 超出返回错误 JSON，不读取 |
| 单次 read_file | **1 张图** | 一个 path 对应一个文件，天然满足 |
| synthetic 注入 | 每次工具调用最多 1 张图 | 与 read_file 语义一致 |

## 3. 现状与差距分析

### 3.1 相关代码

| 模块 | 文件 | 现状 |
|------|------|------|
| 工具实现 | `ReadFileTool.java` | 仅文本行读取 |
| LOCAL 执行 | `desktop/electron/main.cjs` → `handleLocalReadFile` | `utf-8` 读取 |
| 工具循环 | `AgentLoop.java` | `addToolResult(id, sanitizedResult)`，content 为字符串 |
| Prompt 构建 | `PromptEngine.java` | 直接拼接 history，无附件搬运 |
| LLM 适配 | `OpenAiLlmAdapter.java` | 已支持 user 消息 `image_url`，HTTP URL 转 base64 |
| 消息模型 | `ChatRequest.Message.content` | `String` 或 `List<ContentPart>` |
| 视觉校验 | `StreamingWsHandler` | 仅校验**用户发送**的图片，工具路径未覆盖 |
| 模型配置 | `LlmModelConfig` | **无** `supportsVision` 字段 |
| 消息持久化 | `Message.metadata` | 已有 JSON 字段，当前未用于工具附件 |
| 前端展示 | `ToolCallCard.vue` | 工具结果以纯文本 `<pre>` 展示 |

### 3.2 核心矛盾

OpenAI Chat Completions 协议要求：

```json
{ "role": "tool", "tool_call_id": "...", "content": "string" }
```

`content` 只能是字符串。因此图片**不能**直接作为 tool result 发给模型，必须在 Prompt 构建阶段转换为 user 侧的 `image_url` part。

## 4. 技术选型

### 4.1 方案对比

| 方案 | 描述 | 结论 |
|------|------|------|
| A. 扩展 read_file + synthetic user message | 工具返回结构化 JSON；Prompt 层抽离图片注入 user 消息 |  |
| B. 新增 read_image 工具 | 独立工具，语义清晰 | **不采用**（用户明确要求扩展 read_file） |
| C. base64 写入 tool content | 直接把 data URI 放进 tool 字符串 | **不采用**（协议不兼容，模型无法理解） |
| D. 图片上传 OSS 后存 URL | 与用户附图一致，DB 更小 | **v1 不采用**（引入异步上传与清理，复杂度高） |

### 4.2 选定架构：「工具载荷 + Prompt 搬运」

```mermaid
sequenceDiagram
    participant Agent
    participant ReadFile as read_file
    participant Loop as AgentLoop
    participant Meta as Message.metadata
    participant Injector as ToolMediaInjector
    participant LLM

    Agent->>ReadFile: path=screenshot.png
    ReadFile-->>Loop: JSON(content, mime, data_uri, ...)
    Loop->>Loop: strip data_uri → sanitized tool text
    Loop->>Meta: 持久化 TOOL 文本 + metadata.attachments
    Loop->>Injector: 内存 messages 含附件元数据
  Note over Injector: 下一轮 Prompt 构建前
    Injector->>Injector: 检查 supportsVision
    alt 支持视觉
        Injector->>LLM: tool: "图片读取成功..."
        Injector->>LLM: user: [text + image_url]
    else 不支持视觉
        Injector->>LLM: tool: "...模型不支持图片输入..."
    end
```

**关键设计决策：**

1. **工具层**返回完整 JSON（含 `data_uri`），供 WS 推送预览与运行时注入。
2. **持久化层** TOOL 消息的 `content` 仅存**剥离后**的文本 JSON；`data_uri` 写入 `Message.metadata.attachments`。
3. **Prompt 层**新增 `ToolMediaInjector`，在 `PromptEngine.buildRequest()` 内、消息入 LLM 前执行搬运。
4. **synthetic user 消息不写入 DB**，仅存在于单次 LLM 请求的内存 messages 中（避免聊天区出现伪造用户消息）。重载历史时由 metadata 重新注入。

## 5. 详细设计

### 5.1 read_file 工具输出契约

#### 文本文件（保持不变）

```json
{
  "content": "line1\nline2",
  "total_lines": 2
}
```

#### 图片文件（新增）

```json
{
  "content": "图片读取成功：docs/screenshot.png (image/png, 245 KB, 1920×1080)",
  "total_lines": 0,
  "media_type": "image",
  "mime": "image/png",
  "path": "docs/screenshot.png",
  "width": 1920,
  "height": 1080,
  "size_bytes": 250880,
  "data_uri": "data:image/png;base64,..."
}
```

#### 错误（新增场景）

```json
{
  "content": "错误：文件过大（6.2 MB），图片读取上限为 5 MB：large.png",
  "total_lines": 0
}
```

```json
{
  "content": "错误：不支持的图片格式：photo.bmp",
  "total_lines": 0
}
```

**字段约定：**

- `data_uri`：仅出现在工具**原始返回值**与 `Message.metadata` 中，**不**写入 TOOL 消息的 `content` 列。
- `content`：始终为人类/模型可读的文本摘要，作为 tool role 的 `content` 发给 LLM。
- `media_type`：固定为 `"image"`，供前端与注入器识别。

### 5.2 ReadFileTool（CLOUD）改造

**文件**：`backend/src/main/java/cn/etarch/mao/harness/tool/impl/ReadFileTool.java`

**新增逻辑**（在 `Files.isRegularFile` 校验之后）：

1. 根据路径扩展名判断是否图片；是则走 `readImage()` 分支。
2. `readImage()`：
   - `Files.size()` 检查 ≤ 5 MB
   - `Files.readAllBytes()` 读取
   - 魔数校验 MIME
   - 用 `ImageIO` 读取宽高（失败则宽高字段省略，不阻断）
   - `Base64.getEncoder()` 构造 `data_uri`
   - 返回图片 JSON
3. 非图片文件走现有文本逻辑。

**工具描述更新**：

```
读取文件内容。支持文本文件（可按行 offset/limit）和图片文件（png/jpg/gif/webp）。
参数：path（必填）、offset（可选，文本专用）、limit（可选，文本专用）。
```

**新增依赖**：`javax.imageio.ImageIO`（JDK 内置，无需新 Maven 依赖）。

### 5.3 handleLocalReadFile（LOCAL）改造

**文件**：`desktop/electron/main.cjs`

与后端保持同一 JSON 契约：

1. 扩展名判断 → 图片分支
2. `fs.readFileSync(resolvedPath)` 读二进制（不用 utf-8）
3. `Buffer.byteLength` 检查大小
4. 简单魔数判断 MIME
5. 可选：用原生模块或跳过宽高（v1 可只返回 size_bytes）
6. `buffer.toString('base64')` 构造 data_uri

### 5.4 ToolMediaInjector（新增）

**文件**：`backend/src/main/java/cn/etarch/mao/harness/core/ToolMediaInjector.java`

**职责**：将内存中的 `List<ChatRequest.Message>` 转换为 LLM 可消费的序列。

**常量**：

```java
static final String SYNTHETIC_ATTACHMENT_PROMPT = "Attached media from tool result:";
```

**算法**：

```
输入: messages, supportsVision
输出: 新 messages 列表（不可原地修改，避免污染 context）

for each message in messages:
  if role != "tool":
    append message
    continue

  attachment = lookupAttachment(message)  // 从并行 metadata 映射或 message 扩展字段
  if attachment == null || !isImageMime(attachment.mime):
    append message  // content 已是纯文本
    continue

  append message  // tool 文本摘要

  if !supportsVision:
    // 不注入图片；tool content 在 AgentLoop 阶段已含错误提示
    continue

  append synthetic user message:
    parts = [
      { type: "text", text: SYNTHETIC_ATTACHMENT_PROMPT },
      { type: "image_url", image_url: { url: attachment.data_uri } }
    ]
```

**调用位置**：`PromptEngine.buildRequest()` 在 `messages.addAll(history)` 之后、`return ChatRequest` 之前：

```java
messages = toolMediaInjector.inject(messages, context.getModelConfig());
```

### 5.5 AgentLoop 改造

**文件**：`backend/src/main/java/cn/etarch/mao/harness/core/AgentLoop.java`

在 `executeToolCalls` 中，对 `read_file` 结果增加后处理：

```
rawResult = dispatchTool(...)
parsed = parseToolResult(rawResult)

if parsed.hasImageAttachment():
    if !supportsVision(context):
        sanitized = parsed.withContent(visionErrorText(parsed.path))
        attachment = null
    else:
        sanitized = parsed.stripDataUri()      // content 保留摘要 JSON
        attachment = parsed.toAttachment()

    context.addToolResult(tc.getId(), sanitized)
    context.registerToolAttachment(tc.getId(), attachment)  // 内存映射
    persistMetadata = attachment

else:
    sanitized = sanitizeToolResult(rawResult)
    context.addToolResult(tc.getId(), sanitized)
```

**`AgentExecutionContext` 新增**：

```java
// toolCallId → ToolAttachment（mime, dataUri, path）
private Map<String, ToolAttachment> pendingToolAttachments = new LinkedHashMap<>();
```

注入器从 context 或持久化 metadata 读取附件。

### 5.6 持久化

**TOOL 消息 content**（DB `message.content`）：

```json
{"content":"图片读取成功：a.png (image/png, 12 KB)","total_lines":0,"media_type":"image","mime":"image/png","path":"a.png","size_bytes":12345}
```

**TOOL 消息 metadata**（DB `message.metadata`）：

```json
{
  "attachments": [
    {
      "mime": "image/png",
      "path": "a.png",
      "data_uri": "data:image/png;base64,..."
    }
  ]
}
```

**HarnessService.buildContext()** 加载历史时：

1. 解析 `Message.metadata.attachments`
2. 按 `toolCallId` 注册到 context 的 attachment 映射（或在 Injector 内按消息顺序关联）

**HarnessService persistence callback** 扩展：

```java
void onSaveToolMessage(String toolCallId, String content, String metadataJson);
```

`AgentLoop.MessagePersistenceCallback` 增加 metadata 参数；`HarnessService` 写入 `Message.metadata`。

### 5.7 LlmModelConfig 扩展

**文件**：`LlmModelConfig.java`、`HarnessService.buildContext()`

新增字段：

```java
private Boolean supportsVision;
```

构建 context 时从 `LlmModel.getSupportsVision()` 填入（`1` → `true`）。

视觉不可用时的 tool 文本（写入 `content`）：

```
错误：无法读取图片（当前模型不支持图片输入）。请告知用户切换到支持视觉的模型后重试。文件：docs/screenshot.png
```

### 5.8 PromptEngine / MessageHistoryNormalizer

- `PromptEngine`：调用 `ToolMediaInjector`；`normalizeChatMessages` 在注入**之前**执行（保证 tool 紧跟 assistant）。
- **注入后的 synthetic user 消息不参与** `MessageHistoryNormalizer` 的 DB 重载流程（仅请求级临时消息）。

### 5.9 CompactionService 适配

**文件**：`CompactionService.java`

压缩旧 TOOL 消息时：

1. 剥离 `metadata.attachments[].data_uri`，保留 `path` + `mime` 摘要
2. 在压缩摘要 prompt 中，图片类 tool 结果按文本处理（不包含二进制）

避免压缩批次把大量 base64 发给摘要模型。

### 5.10 TokenEstimator 适配

**文件**：`TokenEstimator.java`

对 `image_url` part 增加粗算：

```java
// OpenAI 经验公式：低细节约 85 + 170×tiles；v1 用保守固定值
private static final int IMAGE_TOKEN_ESTIMATE = 1000;
```

在 `estimateMessage` 中，若 content 为 `List<ContentPart>` 且含 `image_url`，在文本 token 基础上加 `IMAGE_TOKEN_ESTIMATE × 图片数`。

### 5.11 ToolResultSummarizer

**文件**：`ToolResultSummarizer.java`

`summarizeReadFile` 识别 `media_type == "image"`：

```
读取 screenshot.png (图片, 1920×1080)
```

### 5.12 WebSocket / 前端

#### 后端 WS 事件

`tool_call_result` payload 在图片场景增加字段（完整 `data_uri` 可截断后推送）：

```json
{
  "toolCallId": "call_xxx",
  "result": "{...stripped json...}",
  "preview": {
    "media_type": "image",
    "mime": "image/png",
    "data_uri": "data:image/png;base64,..."
  }
}
```

#### 桌面端

**文件**：`desktop/src/components/chat/ToolCallCard.vue`

- 解析 `toolCall.preview` 或 result JSON 中的 `media_type`
- 图片场景：展示 `<img>` 缩略图 + 文本摘要，隐藏 base64 `<pre>`
- `useStreamWS.ts` / `sessionStore`：透传 `preview` 字段

#### 管理后台

**文件**：`admin/src/views/session/components/MessageItem.vue`

- 工具结果含图片时，assistant 消息区的 tool 卡片同样展示缩略图（只读）

### 5.13 活动流 / 日志

`ActivityTypeMapper` 对 `read_file` 图片仍映射为 `READ`，`target` 为文件路径。日志中**禁止**打印完整 `data_uri`（仅记录 path、mime、size）。

## 6. 实现步骤

### Phase 1：工具层（可独立验证）

1. 新增 `ImageFileSupport` 工具类（扩展名映射、魔数检测、大小/format 校验）—— `backend/.../harness/tool/ImageFileSupport.java`
2. 改造 `ReadFileTool` 图片分支 + 单元测试
3. 改造 `handleLocalReadFile` + 手动验证 LOCAL 模式

### Phase 2：上下文搬运（核心）

4. 新增 `ToolAttachment` 值对象 + `ToolMediaInjector`
5. 扩展 `LlmModelConfig.supportsVision`、`AgentExecutionContext` 附件映射
6. 改造 `AgentLoop.executeToolCalls`：剥离 data_uri、视觉检查、注册附件
7. 改造 `PromptEngine.buildRequest`：调用注入器
8. 单元测试：注入顺序、非视觉降级、多 tool 交错

### Phase 3：持久化与重载

9. 扩展 `MessagePersistenceCallback` / `HarnessService` 写 metadata
10. `HarnessService.buildContext` 加载 metadata → 附件映射
11. 集成测试：会话重载后再次调用 LLM，图片仍注入

### Phase 4：周边与前端

12. `CompactionService` 剥离旧附件载荷
13. `TokenEstimator` 图片 token 粗算
14. `ToolResultSummarizer` 图片摘要
15. WS `tool_call_result` 增加 `preview`
16. 桌面端 + 管理后台 ToolCall 卡片缩略图

### Phase 5：测试与文档

17. `ReadFileToolTest`：各格式、超大文件、伪装扩展名、非图片不受影响
18. `ToolMediaInjectorTest`：合成消息结构断言
19. `OpenAiLlmAdapterTest`：注入后请求体含 `image_url`
20. 更新 `CLAUDE.md` 工具说明（如需要）

## 7. 落地清单

| # | 文件 | 操作 | 说明 |
|---|------|------|------|
| 1 | `harness/tool/ImageFileSupport.java` | 新增 | 扩展名/MIME/魔数/大小校验 |
| 2 | `harness/tool/impl/ReadFileTool.java` | 修改 | 图片读取分支 |
| 3 | `harness/core/ToolAttachment.java` | 新增 | 附件值对象 |
| 4 | `harness/core/ToolMediaInjector.java` | 新增 | synthetic user 注入 |
| 5 | `harness/core/AgentExecutionContext.java` | 修改 | 附件映射 |
| 6 | `harness/core/AgentLoop.java` | 修改 | 结果剥离、视觉检查 |
| 7 | `harness/core/PromptEngine.java` | 修改 | 调用注入器 |
| 8 | `harness/core/HarnessService.java` | 修改 | supportsVision、metadata 读写 |
| 9 | `harness/llm/LlmModelConfig.java` | 修改 | `supportsVision` 字段 |
| 10 | `harness/core/CompactionService.java` | 修改 | 压缩时剥离 data_uri |
| 11 | `harness/core/TokenEstimator.java` | 修改 | 图片 token 估算 |
| 12 | `session/util/ToolResultSummarizer.java` | 修改 | 图片摘要文案 |
| 13 | `session/ws/WsStreamingEventListener.java` | 修改 | preview 字段 |
| 14 | `desktop/electron/main.cjs` | 修改 | `handleLocalReadFile` 图片分支 |
| 15 | `desktop/src/components/chat/ToolCallCard.vue` | 修改 | 缩略图预览 |
| 16 | `desktop/src/stores/session.ts` | 修改 | 透传 preview |
| 17 | `admin/.../MessageItem.vue` 或 tool 组件 | 修改 | 缩略图预览 |
| 18 | `test/.../ReadFileToolTest.java` | 修改 | 图片用例 |
| 19 | `test/.../ToolMediaInjectorTest.java` | 新增 | 注入逻辑测试 |
| 20 | `test/.../AgentLoopTest.java` | 修改 | 附件剥离断言 |

**不需要改动**：`ToolRegistry`、`ToolDispatcher`、`LocalToolExecutor` 路由逻辑（仍调用 `read_file` 名称）。

## 8. 测试计划

| 场景 | 预期 |
|------|------|
| CLOUD 读取 `test.png` | 返回含 data_uri 的 JSON；下一轮 LLM 请求含 tool 文本 + synthetic user image |
| LOCAL 读取 `photo.jpg` | 与 CLOUD 相同契约 |
| 读取 `doc.txt` | 行为与现网一致 |
| 文件 6 MB | 返回错误 JSON，不注入图片 |
| `.bmp` 文件 | 返回不支持格式错误 |
| 扩展名 `.png` 内容为文本 | 魔数校验失败，返回错误 |
| 模型 `supportsVision=0` | tool 含错误提示，无 synthetic user image |
| 会话中断后重载 | metadata 中附件被重新注入 |
| 压缩旧历史 | data_uri 被剥离，不影响摘要生成 |
| 前端 tool 卡片 | 显示缩略图，不显示 base64 全文 |

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| base64 膨胀 DB / 内存 | TOOL content 剥离；metadata 仅存近期附件；压缩时清除 |
| 上下文 token 激增 | 5 MB 上限 + token 粗算 + 现有 compaction |
| synthetic user 消息干扰对话语义 | 不持久化为 USER 消息；固定前缀 `Attached media from tool result:` |
| LOCAL/CLOUD 行为不一致 | 统一 JSON 契约 + 双端测试 |
| 模型误标 supportsVision | 依赖管理后台配置；发送前仅做本地校验，无法保证提供商实际支持 |

## 10. 后续演进（v2，本次不做）

- 工具读取图片上传 OSS，metadata 只存 URL（与用户附图统一）
- 支持 PDF 首屏渲染图注入
- 按模型提供商细分「tool result 内嵌媒体」能力（若未来接入原生 Anthropic 等）
