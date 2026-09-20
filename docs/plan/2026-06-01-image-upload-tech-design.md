# Agent 任务图片上传技术方案

> 状态：方案设计阶段，暂不进入开发

## 1. 背景与目标

当前 Agent 任务的用户消息仅支持纯文本，前端虽然有文件选择入口（ChatInput 的 "+" 按钮），但上传的文件仅作为附件元数据展示，不会传递给 LLM。本次需求：**支持用户在发送任务时附带图片，图片通过 LLM 视觉能力被 Agent 理解和处理**。

图片存储采用阿里云 OSS，前端通过 STS 临时凭证直传 OSS（不经过后端代理，节省服务器带宽）。

## 2. 现状分析

### 2.1 消息链路（当前）

```
用户输入 → ChatInput.emit('send', text, files[])
         → useChat.sendMessage(text, files)
           → uploadFiles(files)          // POST /v1/files/upload 存到本地磁盘
           → wsSendMessage(sid, text)    // WS 只发纯文本，图片不参与
         → StreamingWsHandler.handleSendMessage()
           → sessionService.saveMessage()  // content = 纯文本
         → HarnessService.execute()
           → buildContext() 加载历史消息
           → PromptEngine.buildRequest()   // ChatRequest.Message.content = String
           → OpenAiLlmAdapter.stream()     // 序列化为 {"role":"user","content":"纯文本"}
```

### 2.2 关键断点

| 层级 | 当前状态 | 需要改动 |
|------|---------|---------|
| DB `message.content` | MEDIUMTEXT 纯文本 | 支持 JSON content parts 或新增列 |
| `ChatRequest.Message.content` | `String` | 改为 `Object`（兼容 String 和 List） |
| `PromptEngine` | 透传纯文本 content | 透传多模态 content |
| `OpenAiLlmAdapter` | 序列化 content 为 string | 序列化为 string 或 content_parts 数组 |
| `HarnessService.buildContext()` | 从 DB 读取纯文本 | 读取多模态结构并还原 |
| 前端 `useChat.uploadFiles()` | 上传到后端本地磁盘 | 改为 OSS 直传 |
| 前端 `MessageBubble` | 展示文件名 tag | 渲染图片预览 |
| 前端 WS `send_message` | 只发 text | 携带图片 OSS URL 列表 |

## 3. 整体方案设计

### 3.1 上传方案：STS 直传 OSS

```
┌──────────┐   ①请求STS凭证    ┌──────────┐
│  前端     │ ──────────────→  │  后端     │
│  Vue3    │ ←──────────────  │  Spring   │
│          │   ②返回临时凭证   │  Boot    │
│          │                   │          │
│          │   ③直传图片       ┌──────────┐
│          │ ──────────────→  │ 阿里云OSS │
│          │ ←──────────────  │          │
│          │   ④返回OSS URL   │          │
└──────────┘                   └──────────┘
```

- **步骤 ①②**：前端调用后端 `POST /api/v1/oss/sts-token`，后端通过 RAM AssumeRole 生成 STS 临时凭证（AccessKeyId / AccessKeySecret / SecurityToken / Expiration）
- **步骤 ③④**：前端使用阿里云 OSS JS SDK（`ali-oss`）+ STS 凭证直传图片到 OSS Bucket
- **步骤 ⑤**：前端拿到 OSS URL 后，随 WS `send_message` 一起发送

### 3.2 消息内容格式：OpenAI 兼容的 Content Parts

采用 OpenAI Vision API 的 content parts 格式，与现有纯文本向后兼容：

```json
// 纯文本消息（现有）
{ "role": "user", "content": "请分析这张图片" }

// 带图片消息（新增）
{
  "role": "user",
  "content": [
    { "type": "text", "text": "请分析这张图片" },
    { "type": "image_url", "image_url": { "url": "https://etfs.oss-cn-hangzhou.aliyuncs.com/session/123/abc.jpg" } }
  ]
}
```

这种格式被 OpenAI / Claude / 通义千问 / DeepSeek 等主流模型兼容。

### 3.3 数据流全景

```
前端选图 → 获取STS凭证 → 直传OSS → 拿到URL
                                    ↓
                            WS send_message 携带:
                            { content: "文本", images: ["oss_url_1", ...] }
                                    ↓
                            后端 StreamingWsHandler
                                    ↓
                            saveMessage() 存入DB:
                            content = JSON([{type:"text",...},{type:"image_url",...}])
                                    ↓
                            HarnessService.buildContext()
                            读取DB → 还原 ChatRequest.Message
                                    ↓
                            PromptEngine.buildRequest()
                            透传 content parts
                                    ↓
                            OpenAiLlmAdapter.stream()
                            序列化为 OpenAI 格式发给 LLM
```

## 4. 详细设计

### 4.1 后端：OSS STS 模块

#### 4.1.1 新增 `OssProperties` 配置类

```java
@Data
@Component
@ConfigurationProperties(prefix = "oss")
public class OssProperties {
    private String region = "oss-cn-hangzhou";
    private String accessKeyId = "xxxxxxx";
    private String accessKeySecret = "xxxxxxx";
    private String bucket = "etfs";
    private int maxKeys = 100;

    private Sts sts = new Sts();
    private Cdn cdn = new Cdn();

    @Data
    public static class Sts {
        private String regionId = "cn-hangzhou";
        private String endpoint = "sts.cn-hangzhou.aliyuncs.com";
        private String accessKeyId = "xxxxxxx";
        private String accessKeySecret = "xxxxxxx";
        private String roleArn = "acs:ram::xxxxxxx:role/ramosstest";
        private String roleSessionName = "OssSession";  // 运行时覆盖为 "User_{userId}"
        private long expire = 3600;
        private DataSize maxSize = DataSize.ofMegabytes(20);  // STS policy 单文件上限 20MB
    }

    @Data
    public static class Cdn {
        private String domain;  // CDN 域名，为空时使用 OSS 默认域名
    }
}
```

#### 4.1.2 新增 STS 服务

```java
@Service
public class OssStsService {
    // AssumeRole 生成临时凭证
    // roleSessionName = "User_{userId}"（便于审计追踪）
    // 限制 policy: 只允许 putObject，限定 bucket 和路径前缀
    // 路径前缀: /session/{sessionId}/
    // 单文件大小限制: 20MB
    public StsTokenVO generateStsToken(Long userId, Long sessionId);
}
```

#### 4.1.3 新增 STS 接口

```
POST /api/v1/oss/sts-token
Body: { "sessionId": 123 }
Response: {
  "accessKeyId": "...",
  "accessKeySecret": "...",
  "securityToken": "...",
  "expiration": "2026-06-01T12:00:00Z",
  "bucket": "etfs",
  "region": "oss-cn-hangzhou",
  "uploadDir": "session/123/"
}
```

#### 4.1.4 Maven 依赖

```xml
<!-- 阿里云 STS SDK -->
<dependency>
    <groupId>com.aliyun</groupId>
    <artifactId>aliyun-java-sdk-sts</artifactId>
    <version>3.1.1</version>
</dependency>
<dependency>
    <groupId>com.aliyun</groupId>
    <artifactId>aliyun-java-sdk-core</artifactId>
    <version>4.6.4</version>
</dependency>
```

### 4.2 后端：消息多模态改造

#### 4.2.1 `ChatRequest.Message.content` 类型改造

```java
@Data
@Builder
@JsonIgnoreProperties(ignoreUnknown = true)
public static class Message {
    private String role;
    private Object content;  // String 或 List<ContentPart>
    private String name;
    @JsonProperty("tool_call_id")
    private String toolCallId;
    @JsonProperty("tool_calls")
    private List<ToolCall> toolCalls;
}

// 新增 ContentPart 抽象
@Data
@Builder
public static class ContentPart {
    private String type;  // "text" 或 "image_url"
    private String text;  // type=text 时
    @JsonProperty("image_url")
    private ImageUrl imageUrl;  // type=image_url 时
}

@Data
@Builder
public static class ImageUrl {
    private String url;
}
```

**序列化兼容性**：当 `content` 是 `String` 时 Jackson 序列化为 JSON string，当是 `List` 时序列化为 JSON array。无需额外适配。

#### 4.2.2 DB 存储方案：直接存 JSON 到 `message.content`

```sql
-- 现有纯文本
content = "请分析这张图片"

-- 多模态
content = '[{"type":"text","text":"请分析这张图片"},{"type":"image_url","image_url":{"url":"https://..."}}]'
```

无需改表结构，MEDIUMTEXT 天然支持 JSON。`HarnessService.buildContext()` 读取时，先尝试 JSON 解析为 `List<ContentPart>`，失败则视为纯文本字符串。

不采用新增列方案，避免不必要的表结构变更。

#### 4.2.3 `HarnessService.buildContext()` 改造

```java
// 原来
var msgBuilder = ChatRequest.Message.builder()
    .role(msg.getRole().toLowerCase())
    .content(msg.getContent());

// 改造后
Object parsedContent = parseContent(msg.getContent());
var msgBuilder = ChatRequest.Message.builder()
    .role(msg.getRole().toLowerCase())
    .content(parsedContent);

// 解析逻辑
private Object parseContent(String raw) {
    if (raw == null) return null;
    raw = raw.trim();
    if (raw.startsWith("[")) {
        try {
            return objectMapper.readValue(raw, new TypeReference<List<ChatRequest.ContentPart>>() {});
        } catch (Exception e) {
            return raw;  // fallback to plain text
        }
    }
    return raw;
}
```

#### 4.2.4 `SessionService.saveMessage()` 改造

新增重载方法，支持保存多模态 content：

```java
public Message saveMessage(Long sessionId, String role, Object content,
                            String toolCallId, String toolCalls,
                            Integer tokenCount, Long modelId) {
    Message message = new Message();
    // ...
    if (content instanceof String str) {
        message.setContent(str);
    } else {
        message.setContent(objectMapper.writeValueAsString(content));
    }
    // ...
}
```

#### 4.2.5 `AgentExecutionContext` 改造

```java
// 新增多模态消息添加方法
public void addUserMessage(List<ChatRequest.ContentPart> parts) {
    messages.add(ChatRequest.Message.builder()
            .role("user")
            .content(parts)
            .build());
}
```

#### 4.2.6 `OpenAiLlmAdapter.buildRequest()` 改造

```java
// 原来
body.put("messages", request.getMessages());

// 不需要改动！Jackson 会自动将 Message.content (Object)
// 序列化为 string 或 array。
// 但需要确保 messages 的 content 字段在序列化时正确输出。
// 已有的 @JsonIgnoreProperties(ignoreUnknown = true) 足够。
```

实际上 `buildRequest()` 把 `request.getMessages()` 直接放入 HashMap 然后 Jackson 序列化，`content` 是 `Object` 类型，Jackson 会根据实际类型（String / List）输出正确的 JSON。**此层无需改动**。

### 4.3 后端：WebSocket 消息扩展

#### 4.3.1 `send_message` 协议扩展

```json
// 现有
{ "type": "send_message", "sessionId": 123,
  "data": { "content": "请分析", "eventId": "uuid" } }

// 扩展
{ "type": "send_message", "sessionId": 123,
  "data": { "content": "请分析", "eventId": "uuid",
            "images": ["https://etfs.oss-cn-hangzhou.aliyuncs.com/session/123/abc.jpg"] } }
```

#### 4.3.2 `StreamingWsHandler.handleSendMessage()` 改造

```java
String content = data.get("content").asText();
List<String> images = new ArrayList<>();
if (data.has("images") && data.get("images").isArray()) {
    for (JsonNode img : data.get("images")) {
        images.add(img.asText());
    }
}

// 非 vision 模型 + 有图片 → 报错中断
if (!images.isEmpty()) {
    Agent agent = agentMapper.selectById(session.getAgentId());
    LlmModel model = llmModelMapper.selectById(agent.getModelId());
    if (!model.isSupportsVision()) {  // 需在 LlmModel 实体新增 supportsVision 字段
        registry.send(userId, WsEvent.of("error", sessionId,
            Map.of("message", "当前模型不支持图片输入，请切换支持视觉的模型")));
        return;
    }
}

// 前端限制最多 10 张图片
if (images.size() > 10) {
    registry.send(userId, WsEvent.of("error", sessionId,
        Map.of("message", "单条消息最多支持 10 张图片")));
    return;
}

// 构建多模态 content
Object messageContent;
if (images.isEmpty()) {
    messageContent = content;
} else {
    List<ChatRequest.ContentPart> parts = new ArrayList<>();
    if (content != null && !content.isBlank()) {
        parts.add(ChatRequest.ContentPart.builder().type("text").text(content).build());
    }
    for (String imageUrl : images) {
        parts.add(ChatRequest.ContentPart.builder()
            .type("image_url")
            .imageUrl(ChatRequest.ImageUrl.builder().url(imageUrl).build())
            .build());
    }
    messageContent = parts;
}

// 保存到 DB
sessionService.saveMessage(sessionId, "USER", messageContent, null, null, 0, null);

// 传递给 HarnessService（需要同步改造 prepareMessage）
harnessService.prepareMessage(sessionId, messageContent);
```

#### 4.3.3 `HarnessService.prepareMessage()` 改造

```java
// 原来
public String prepareMessage(Long sessionId, String userContent) {
    String eventId = UUID.randomUUID().toString();
    eventContentStore.put(eventId, userContent);
    return eventId;
}

// 改造：cache value 改为 Object
private final Cache<String, Object> eventContentStore = ...;

public String prepareMessage(Long sessionId, Object userContent) {
    String eventId = UUID.randomUUID().toString();
    eventContentStore.put(eventId, userContent);
    return eventId;
}
```

### 4.4 前端改造

#### 4.4.1 新增 OSS 上传工具

```typescript
// desktop/src/utils/ossUpload.ts
import OSS from 'ali-oss'

interface StsToken {
  accessKeyId: string
  accessKeySecret: string
  securityToken: string
  bucket: string
  region: string
  uploadDir: string
  expiration: string
}

export async function uploadToOss(
  file: File,
  stsToken: StsToken
): Promise<string> {
  const client = new OSS({
    region: stsToken.region,
    accessKeyId: stsToken.accessKeyId,
    accessKeySecret: stsToken.accessKeySecret,
    stsToken: stsToken.securityToken,
    bucket: stsToken.bucket,
  })

  const key = `${stsToken.uploadDir}${Date.now()}_${file.name}`
  const result = await client.put(key, file)
  return result.url
}
```

新增 npm 依赖：`ali-oss`

#### 4.4.2 `useChat.ts` 改造

```typescript
// uploadFiles 改为 uploadImages，返回 OSS URL 列表
async function uploadImages(files: File[]): Promise<string[]> {
  // 1. 获取 STS 凭证
  const { data: stsToken } = await api.post('/oss/sts-token', {
    sessionId: sessionId.value
  })

  // 2. 逐个上传到 OSS
  const urls: string[] = []
  for (const file of files) {
    try {
      const url = await uploadToOss(file, stsToken)
      urls.push(url)
    } catch {
      ElMessage.error(`图片 ${file.name} 上传失败`)
    }
  }
  return urls
}

// sendMessage 改造
async function sendMessage(text: string, files?: File[]) {
  // ...
  const imageUrls = await uploadImages(files || [])

  // 构建 displayContent（用于本地展示）
  let displayContent = text
  if (imageUrls.length > 0) {
    displayContent += imageUrls.map(url => `\n[图片: ${url}]`).join('')
  }

  // WS 发送时携带 images
  wsSendMessage(sid, text || '', eventId, imageUrls)

  // 本地消息存储携带 images
  sessionStore.addUserMessage(sid, {
    id: `msg_${Date.now()}_user`,
    role: 'user',
    content: text,
    createdAt: new Date().toLocaleString(),
    images: imageUrls  // 新增
  })
}
```

#### 4.4.3 `useStreamWS.ts` 改造

```typescript
// sendMessage 扩展 images 参数
function sendMessage(sessionId: string, content: string, eventId: string, images?: string[]) {
  ws.value?.send(JSON.stringify({
    type: 'send_message',
    sessionId,
    data: { content, eventId, images: images || [] }
  }))
}
```

#### 4.4.4 `ChatInput.vue` 改造

```typescript
// 文件选择增加图片类型过滤 + 数量限制
function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files) {
    for (const file of Array.from(input.files)) {
      // 限制最多 10 张图片
      if (pendingFiles.value.length >= 10) {
        ElMessage.warning('最多上传 10 张图片')
        break
      }
      // 限制单图 10MB
      if (file.size > 10 * 1024 * 1024) {
        ElMessage.warning(`图片 ${file.name} 超过 10MB 限制`)
        continue
      }
      // 图片预览
      if (file.type.startsWith('image/')) {
        file.previewUrl = URL.createObjectURL(file)
      }
      pendingFiles.value.push(file)
    }
  }
  input.value = ''
}

// 文件 chips 增加图片缩略图
// <img v-if="file.previewUrl" :src="file.previewUrl" class="file-preview" />
```

#### 4.4.5 `MessageBubble.vue` 改造

```typescript
// ChatMessage 类型扩展
interface ChatMessage {
  // ...existing
  images?: string[]  // OSS 图片 URL 列表
}

// 用户消息渲染：图片以缩略图展示
// <div v-if="message.images?.length" class="message-images">
//   <img v-for="url in message.images" :key="url" :src="url"
//        class="message-image" @click="previewImage(url)" />
// </div>
```

#### 4.4.6 `chatMessage.ts` 改造

`mapApiMessagesToChat()` 需要从 API 返回的消息中解析多模态 content：

```typescript
// API 返回的 content 可能是 string 或 ContentPart[]
const rawContent = m.content
let textContent = ''
let imageUrls: string[] = []

if (typeof rawContent === 'string') {
  textContent = rawContent
} else if (Array.isArray(rawContent)) {
  for (const part of rawContent) {
    if (part.type === 'text') textContent += part.text
    if (part.type === 'image_url') imageUrls.push(part.image_url?.url)
  }
}
```

### 4.5 后端：消息 API 返回改造

`GET /v1/sessions/{id}/messages` 返回的 `MessageVO` 需要携带图片信息：

```java
// SessionController 中的 toVO 方法改造
// 当 content 是 JSON array 时，解析出 text 和 images
@Data
public static class MessageVO {
    private Long id;
    private String role;
    private String content;      // 纯文本部分
    private List<String> images; // 图片 URL 列表
    private String toolCallId;
    private String toolCalls;
    private Integer tokenCount;
    private Long modelId;
    private String metadata;
    private String createdAt;
}
```

## 5. OSS Bucket 配置要求

### 5.1 CORS 配置

前端直传 OSS 需要 Bucket 开启 CORS：

```xml
<CORSRule>
  <AllowedOrigin>*</AllowedOrigin>
  <AllowedMethod>PUT</AllowedMethod>
  <AllowedMethod>POST</AllowedMethod>
  <AllowedHeader>*</AllowedHeader>
  <MaxAgeSeconds>3600</MaxAgeSeconds>
</CORSRule>
```

### 5.2 Bucket 权限

- 图片上传后需要 LLM 能通过 URL 访问 → Bucket 需要**公共读**权限
- 或者使用 CDN 域名 + 防盗链（推荐生产方案）

### 5.3 路径规划

```
etfs/
  └── session/
      └── {sessionId}/
          ├── 1717200000_screenshot.png
          └── 1717200001_photo.jpg
```

## 6. 已确认决策

| # | 问题 | 决策 |
|---|------|------|
| 6.1 | 图片传给 LLM 的方式 | **URL 方式**。模型支持 vision，URL 与 Base64 均可，优先用 URL（节省 token 和后端带宽）。需确保 OSS Bucket 公共读或 LLM 服务可访问。 |
| 6.2 | 图片大小与格式限制 | 前端限制单图 10MB，后端 STS policy 限制单文件 20MB。格式暂不限制，由 LLM 侧兜底。 |
| 6.3 | 图片 Token 消耗 | 初版不在前端做 token 提示，后续可加。 |
| 6.4 | 多图支持 | **单条消息最多 10 张图片**。前端硬限制，后端 STS policy 不限数量。 |
| 6.5 | 历史消息中的图片 | OSS 图片不过期，长期保留。后续如需清理，走离线脚本。 |
| 6.6 | 非 Vision 模型的处理 | **后端报错，任务中断**。在 `StreamingWsHandler.handleSendMessage()` 中检测 Agent 绑定的模型是否支持 vision，不支持时返回 error 事件，前端弹出提示。 |
| 6.7 | STS 凭证安全 | `roleSessionName` 改为 `"User_{userId}"`，STS policy 限制 putObject + 指定 bucket/路径前缀。 |
| 6.8 | 图片压缩与处理 | 初版不做压缩。后续可利用 OSS 图片处理服务（`?x-oss-process=image/resize,w_1024`）在 LLM 请求时动态缩放。 |
| 6.9 | 现有文件上传系统 | **仅任务图片走 OSS，现有本地文件上传系统不动**。不做存量数据迁移。 |

## 7. 改动范围总结

| 文件/模块 | 改动类型 | 说明 |
|-----------|---------|------|
| `pom.xml` | 修改 | 新增阿里云 STS SDK 依赖 |
| `application.yml` | 修改 | 新增 `oss.*` 配置 |
| **新增** `OssProperties.java` | 新增 | OSS 配置属性类 |
| **新增** `OssStsService.java` | 新增 | STS 临时凭证生成 |
| **新增** `OssController.java` | 新增 | `POST /v1/oss/sts-token` 接口 |
| `ChatRequest.java` | 修改 | `Message.content` 改为 `Object`，新增 `ContentPart` / `ImageUrl` |
| `AgentExecutionContext.java` | 修改 | 新增 `addUserMessage(List<ContentPart>)` |
| `HarnessService.java` | 修改 | `prepareMessage()` 参数改为 `Object`，`buildContext()` 解析多模态 content |
| `SessionService.java` | 修改 | `saveMessage()` 支持 `Object content` |
| `StreamingWsHandler.java` | 修改 | `handleSendMessage()` 解析 images 参数、校验 vision 模型、构建多模态 content |
| `LlmModel.java` | 修改 | 新增 `supportsVision` 字段 |
| `SessionController.java` | 修改 | `MessageVO` 增加 `images` 字段 |
| **新增** `ossUpload.ts` | 新增 | OSS 直传工具函数 |
| `useChat.ts` | 修改 | `uploadFiles` → `uploadImages`，WS 消息携带 images |
| `useStreamWS.ts` | 修改 | `sendMessage()` 增加 images 参数 |
| `ChatInput.vue` | 修改 | 图片预览缩略图、10 张/10MB 限制 |
| `MessageBubble.vue` | 修改 | 消息中渲染图片缩略图 |
| `chat.ts` | 修改 | `ChatMessage` 增加 `images` 字段 |
| `chatMessage.ts` | 修改 | `mapApiMessagesToChat()` 解析多模态 content |
| **新增** `V021__message_image_support.sql` | 新增 | `llm_model` 表新增 `supports_vision` 列 |
| `package.json` | 修改 | 新增 `ali-oss` npm 依赖 |

## 8. 开发阶段建议

| 阶段 | 内容 | 预估工时 |
|------|------|---------|
| P1 | OSS STS 模块（后端配置 + STS 接口 + 前端直传） | 1d |
| P2 | 消息多模态改造（ChatRequest + 存储 + 上下文构建 + LlmModel.supportsVision） | 1.5d |
| P3 | WebSocket 协议扩展 + vision 模型校验 + 消息发送链路打通 | 0.5d |
| P4 | 前端消息展示（图片缩略图 + 预览）+ 10 张/10MB 限制 | 0.5d |
| P5 | 联调测试 + 边界处理（非 vision 模型报错中断） | 1d |
| **合计** | | **~4.5d** |
