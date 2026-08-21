# 技术方案：非视觉模型自动替换图片为占位文案

## 1. 需求背景

当前系统支持用户在会话中发送图片（通过 OSS 上传），消息以 OpenAI-compatible 多模态格式（`List<ContentPart>`，包含 `image_url` 类型的 part）持久化到数据库。当会话使用的模型 `supportsVision = 0`（不支持图片理解）时，这些包含 `image_url` 的消息会原样发送给 LLM API，导致 API 返回错误（如 400 "model does not support images"），用户无法继续对话。

### 1.1 现有相关能力

| 模块 | 文件 | 现状 |
|------|------|------|
| 模型配置 | `LlmModel.supportsVision` / `LlmModelConfig.supportsVision` | 已有字段，标识模型是否支持视觉输入 |
| 消息模型 | `ChatRequest.Message.content` | 支持 `String`（纯文本）和 `List<ContentPart>`（多模态）两种格式 |
| 消息持久化 | `SessionService.saveMessage()` + `HarnessService.parseContent()` | 多模态消息以 JSON 数组形式存储，加载时解析为 `List<ContentPart>` |
| 工具图片注入 | `ToolMediaInjector.inject()` | 已根据 `supportsVision` 判断是否注入工具产生的 synthetic 图片消息 |
| LLM 请求构建 | `OpenAiLlmAdapter.buildRequest()` | 构建最终请求体，发送前将 HTTP 图片 URL 转为 base64 data URI |
| Prompt 构建 | `PromptEngine.buildRequest()` | 组装 system prompt + 历史消息 + 工具定义 |
| 视觉校验（前端发送） | `StreamingWsHandler` | 用户发送图片时校验模型是否支持视觉 |

### 1.2 核心矛盾

用户消息中的图片（`image_url` 类型的 `ContentPart`）会随着消息历史原封不动地发送给 LLM API。对于不支持视觉的模型，API 会直接拒绝请求。需要在**发送前**将图片内容替换为文本占位文案，确保请求能够正常发送。

## 2. 需求描述

### 2.1 要做什么

| 编号 | 需求 |
|------|------|
| R1 | 在 LLM 请求发送前，根据当前模型的 `supportsVision` 判断是否需要转换图片内容 |
| R2 | 当 `supportsVision = false` 时，将消息 `ContentPart` 中的所有 `image_url` 部分替换为纯文本占位文案「此处用户上传了图片」 |
| R3 | 仅替换图片部分，保留用户原有的文字内容 |
| R4 | 多条图片合并处理：同一消息中的多张图片只产生一个占位文案，不重复追加 |
| R5 | 转换仅在内存中进行，不修改数据库中的原始消息内容 |
| R6 | 转换逻辑放置在 `OpenAiLlmAdapter.buildRequest()` 中，在 `convertImageUrlsToBase64` 之前执行 |

### 2.2 不做什么

| 编号 | 范围外 |
|------|--------|
| N1 | **不**在前端弹 toast 或其他用户提示（用户选择静默处理） |
| N2 | **不**修改数据库存储的消息内容 |
| N3 | **不**处理工具执行产生的图片——`ToolMediaInjector` 已有 `supportsVision` 判断，不支持时不会注入 synthetic 图片消息 |
| N4 | **不**修改 `PromptEngine` 的逻辑 |
| N5 | **不**新增数据库字段或 Flyway 迁移脚本 |
| N6 | **不**修改前端发送图片时的视觉校验逻辑（已有的校验保持不变） |
| N7 | **不**对不同来源的图片使用不同占位文案（统一使用「此处用户上传了图片」） |

## 3. 技术选型

### 3.1 转换位置选择

| 方案 | 位置 | 优点 | 缺点 |
|------|------|------|------|
| A | `PromptEngine.buildRequest()` | 靠近 Prompt 构建逻辑，语义清晰 | `PromptEngine` 职责偏向 business logic，不适合做协议层适配 |
| **B（选定）** | **`OpenAiLlmAdapter.buildRequest()`** | 位于 API 协议边界，是「发送前最后一公里」；与现有的 `convertImageUrlsToBase64` 在同一方法中，逻辑内聚 | - |
| C | `HarnessService.buildContext()` | 在消息加载时处理 | 修改了上下文原始数据，语义不清晰，且影响后续可能的使用场景 |

**选择方案 B**：在 `OpenAiLlmAdapter.buildRequest()` 中，于 `convertImageUrlsToBase64` 之前执行图片占位转换。此位置是 LLM API 协议适配层，符合「根据模型能力调整请求内容」的职责定位。

### 3.2 转换策略

对于每条消息，当 `content` 为 `List<ContentPart>` 时：

- **混合消息（文字 + 图片）**：遍历所有 part，移除 `image_url` 类型的 part，仅在末尾追加一个占位文案「此处用户上传了图片」（不管有几张图，只追加一次）
- **纯图片消息（无文字）**：整条消息的 `content` 替换为纯文本「此处用户上传了图片」

```
// 原始消息（文字 + 2张图）
[
  { type: "text", text: "请帮我看看这张图" },
  { type: "image_url", image_url: { url: "https://..." } },
  { type: "image_url", image_url: { url: "https://..." } }
]

// 转换后
"请帮我看看这张图\n「此处用户上传了图片」"
```

```
// 原始消息（仅图片）
[
  { type: "image_url", image_url: { url: "https://..." } }
]

// 转换后
"「此处用户上传了图片」"
```

### 3.3 不选用的方案

| 方案 | 原因 |
|------|------|
| 在 `PromptEngine` 层转换 | 职责不匹配；`PromptEngine` 不应关心协议适配细节 |
| 在消息加载时转换（DB 层） | 会污染数据库中原始数据，破坏「消息存储与模型能力解耦」的原则 |
| 直接丢弃包含图片的整条消息 | 丢失用户文字输入，体验太差 |
| 每张图片分别追加一个占位文案 | 多张图片时文案重复冗余，不如合并为一个 |

## 4. 实现步骤

### 4.1 后端改动

#### 4.1.1 `OpenAiLlmAdapter.java` — 新增图片占位转换方法

**文件**：`backend/src/main/java/cn/etarch/mao/harness/llm/OpenAiLlmAdapter.java`

**改动点**：在 `buildRequest()` 方法中，`convertImageUrlsToBase64` 调用之前，新增一步：根据 `supportsVision` 决定是否对消息列表做图片占位转换。

新增方法：

```java
/**
 * 当模型不支持视觉输入时，将消息中的 image_url ContentPart 替换为文本占位文案。
 * 混合消息（文字+图片）：保留文字，移除所有 image_url part，末尾追加占位文案。
 * 纯图片消息（无文字）：整条 content 替换为占位文案。
 */
private void replaceImagesWithPlaceholder(List<ChatRequest.Message> messages) {
    if (messages == null) return;
    for (int i = 0; i < messages.size(); i++) {
        ChatRequest.Message msg = messages.get(i);
        if (!(msg.getContent() instanceof List<?> list)) continue;

        List<Object> textParts = new ArrayList<>();
        boolean hasImage = false;

        for (Object part : list) {
            String type = extractPartType(part);
            if ("image_url".equals(type)) {
                hasImage = true;
            } else {
                textParts.add(part);
            }
        }

        if (!hasImage) continue;

        String textContent = buildTextFromParts(textParts);
        if (!textContent.isEmpty()) {
            textContent += "\n「此处用户上传了图片」";
        } else {
            textContent = "「此处用户上传了图片」";
        }

        messages.set(i, ChatRequest.Message.builder()
                .role(msg.getRole())
                .content(textContent)
                .name(msg.getName())
                .toolCallId(msg.getToolCallId())
                .toolCalls(msg.getToolCalls())
                .build());
    }
}

private String extractPartType(Object part) {
    if (part instanceof ChatRequest.ContentPart cp) return cp.getType();
    if (part instanceof Map<?, ?> map) {
        Object type = map.get("type");
        return type instanceof String s ? s : null;
    }
    return null;
}

private String buildTextFromParts(List<Object> textParts) {
    StringBuilder sb = new StringBuilder();
    for (Object part : textParts) {
        String text = extractPartText(part);
        if (text != null) sb.append(text);
    }
    return sb.toString().trim();
}

private String extractPartText(Object part) {
    if (part instanceof ChatRequest.ContentPart cp) return cp.getText();
    if (part instanceof Map<?, ?> map) {
        Object text = map.get("text");
        return text instanceof String s ? s : null;
    }
    return null;
}
```

`buildRequest()` 方法中的调用位置：

```java
private Request buildRequest(ChatRequest request, LlmModelConfig config, boolean stream) {
    try {
        List<ChatRequest.Message> messages = request.getMessages();
        MessageHistoryNormalizer.ensureContentPresent(messages);

        // 新增：模型不支持视觉时，将图片替换为占位文案
        boolean supportsVision = config.getSupportsVision() != null && config.getSupportsVision();
        if (!supportsVision && messages != null) {
            replaceImagesWithPlaceholder(messages);
        }

        // 原有：转换 HTTP 图片 URL 为 base64 data URI
        if (messages != null) {
            for (ChatRequest.Message msg : messages) {
                convertImageUrlsToBase64(msg);
            }
        }

        // ... 后续构建逻辑不变 ...
    }
}
```

**关键设计决策**：
- `replaceImagesWithPlaceholder` 在 `convertImageUrlsToBase64` **之前**执行。因为如果模型不支持视觉，无需下载图片做 base64 转换，直接替换为占位文本即可，节省网络开销。
- 使用 `List<?>` 而非 `List<ChatRequest.ContentPart>` 接收 content，兼容 Jackson 反序列化后可能产生的 `List<Map>` 类型（`ContentPart` 标注了 `@JsonIgnoreProperties(ignoreUnknown = true)`，但通过 `parseContent` 直接反序列化时可能产生 `List<Map>`）。

#### 4.1.2 不涉及的改动

| 模块 | 原因 |
|------|------|
| `PromptEngine` | 已在 ToolMediaInjector 中处理工具图片；用户消息图片在 Adapter 层处理 |
| `HarnessService` | 消息加载与模型能力无关，保持原有逻辑 |
| `ToolMediaInjector` | 已有 `supportsVision` 判断，不支持时不注入图片，逻辑无需改动 |
| `AgentExecutionContext` | 无新增字段需求 |
| `ChatRequest` / `LlmModelConfig` | 模型定义无变化 |

### 4.2 前端改动

**本次不做前端改动**。用户选择静默处理，不弹提示。

### 4.3 测试

#### 4.3.1 单元测试

新增测试类 `OpenAiLlmAdapterTest`（如已存在则追加用例）：

| 用例 | 场景 | 预期结果 |
|------|------|----------|
| 混合消息替换 | `supportsVision=false`，消息含文字 + 2张图片 | content 变为 `"文字内容\n「此处用户上传了图片」"` |
| 纯图片消息替换 | `supportsVision=false`，消息仅含图片无文字 | content 变为 `"「此处用户上传了图片」"` |
| 视觉模型不过滤 | `supportsVision=true`，消息含图片 | content 保持不变（List<ContentPart>） |
| 纯文本消息不变 | `supportsVision=false`，消息为纯文本 String | content 保持不变 |
| null/empty 安全 | `messages=null` 或空列表 | 不抛异常 |

#### 4.3.2 集成测试 / 手工验证

| 场景 | 操作 | 验证点 |
|------|------|--------|
| 非视觉模型 + 用户发送图片 | 切换到不支持视觉的模型，发送图片 | 不报错，模型正常回复，回复中能看到用户文字 + 占位文案 |
| 非视觉模型 + 历史中有图片 | 在视觉模型会话中发送图片后，切换到非视觉模型继续对话 | 历史中的图片被替换为占位文案，对话正常进行 |
| 视觉模型 + 发送图片 | 使用支持视觉的模型发送图片 | 图片正常发送，模型能理解图片内容 |
| 非视觉模型 + 仅发图片无文字 | 发送纯图片无文字 | 消息变为「此处用户上传了图片」，模型正常回复 |

## 5. 数据流示意

```
用户发送消息（含图片）
        │
        ▼
┌─────────────────┐
│  DB: message    │  content = [{"type":"text","text":"帮我看看"},
│  (持久化原始数据) │             {"type":"image_url",...}]
└─────────────────┘
        │
        ▼ 加载历史
┌─────────────────┐
│ HarnessService  │  parseContent() → List<ContentPart>
│ .buildContext() │  原文存入 context.messages
└─────────────────┘
        │
        ▼
┌─────────────────┐
│ PromptEngine    │  ToolMediaInjector: supportsVision=false → 不注入工具图片
│ .buildRequest() │  用户消息图片保持原样传入 ChatRequest
└─────────────────┘
        │
        ▼
┌──────────────────────────────┐
│ OpenAiLlmAdapter             │
│ .buildRequest()              │
│                              │
│ supportsVision == false?     │
│   ├── YES: 跳过图片替换       │──► convertImageUrlsToBase64 (保留)
│   └── NO:                    │
│       replaceImagesWith-     │
│       Placeholder()          │──► content 变为纯文本 + 占位文案
│                              │
│        ▼                     │
│   发送给 LLM API              │
└──────────────────────────────┘
```

## 6. 落地清单

### 6.1 代码改动

| # | 文件 | 改动类型 | 描述 |
|---|------|----------|------|
| 1 | `backend/src/main/java/cn/etarch/mao/harness/llm/OpenAiLlmAdapter.java` | 修改 | 在 `buildRequest()` 方法中新增 `replaceImagesWithPlaceholder()` 调用；新增 `replaceImagesWithPlaceholder()`、`extractPartType()`、`buildTextFromParts()`、`extractPartText()` 四个私有方法 |

### 6.2 测试改动

| # | 文件 | 改动类型 | 描述 |
|---|------|----------|------|
| 2 | `backend/src/test/java/cn/etarch/mao/harness/llm/OpenAiLlmAdapterTest.java` | 新增/追加 | 覆盖 5 个测试场景（见 4.3.1） |

### 6.3 不涉及的改动

| 模块 | 说明 |
|------|------|
| 数据库 / Flyway 迁移 | 无 schema 变更 |
| 前端（admin / desktop） | 无 UI 变更 |
| `PromptEngine` | 不修改 |
| `ToolMediaInjector` | 不修改（已有 supportsVision 判断） |
| `HarnessService` | 不修改 |
| `StreamingWsHandler` | 不修改（已有视觉校验保持不变） |
| 配置文件 | 无新增配置项 |

### 6.4 风险与注意事项

| 风险 | 缓解措施 |
|------|----------|
| Jackson 反序列化 `ContentPart` 后可能是 `List<Map>` 而非 `List<ContentPart>` | `replaceImagesWithPlaceholder` 使用 `List<?>` + 反射式类型判断，兼容两种类型 |
| 转换后消息丢失 `name` / `toolCallId` 等字段 | 重建 Message 时显式拷贝所有字段 |
| 占位文案可能误导模型（模型以为用户确实发了那段文字） | 使用中文书名号「」包裹，明确标识这是系统注入的提示而非用户原文 |

## 7. 参考

- [plan-read-image-tool.md](./plan-read-image-tool.md) — read_file 图片读取工具方案（`ToolMediaInjector` 设计来源）
- [image-upload-tech-design.md](./image-upload-tech-design.md) — 图片上传与多模态消息设计
- `LlmModel` 实体：`backend/src/main/java/cn/etarch/mao/model/entity/LlmModel.java`
- `ChatRequest` 模型：`backend/src/main/java/cn/etarch/mao/harness/llm/ChatRequest.java`
- `OpenAiLlmAdapter`：`backend/src/main/java/cn/etarch/mao/harness/llm/OpenAiLlmAdapter.java`
