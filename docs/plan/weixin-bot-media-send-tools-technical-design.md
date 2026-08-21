# 微信通道媒体发送工具 技术方案

> 版本：v1.0（2026-08-01）
> 状态：待评审（评审通过前不改动任何代码）
> 关联文档：`docs/weixin-bot-channel-integration-guide.md`、`docs/weixin-bot-integration-technical-design.md`

---

## 1. 需求背景

当前微信通道（iLink Bot）的任务对话中，Agent 回复微信用户只有两种出站形式：

1. **纯文本**：`WeixinSendService.sendText` 发送 `text_item`（type=1）；
2. **语音**：系统自动将 Agent 的文本回复 TTS 合成后以 **MP3 文件**形式发送（`WeixinVoiceReplyService`，因腾讯侧 `voice_item` 语音条未稳定开放，故走 `file_item` 通道）。

Agent 无法主动向微信用户发送**图片**或**任意类型文件**。用户期望：

- 在系统内置工具中新增"向微信用户发送图片""向微信用户发送文件"两个能力；
- 这两个工具**仅在微信通道对话会话中**对 Agent 可见、可调用，其他客户端（管理后台、桌面端）的会话不提供；
- 发送方式参照 iLink 协议（与现有语音文件发送同一套 `getuploadurl → AES-128-ECB → CDN 上传 → sendmessage` 链路）；
- 定时任务若绑定微信 Bot 会话执行，也应具备向微信用户发送媒体的能力。

## 2. 需求描述

### 2.1 目标（要做）

| # | 事项 | 说明 |
|---|------|------|
| 1 | 新增内置工具 `send_wechat_image` | 向微信用户发送一张图片（≤20MB，PNG/JPG/JPEG/GIF/WebP） |
| 2 | 新增内置工具 `send_wechat_file` | 向微信用户发送一个文件（≤100MB，类型不限） |
| 3 | 渠道限定 | 两个工具仅在 `projectKey = "weixin-bot"` 的会话中注入；其他渠道会话既不进 LLM 工具 schema，也在执行层被拦截 |
| 4 | 媒体来源 | 工具支持**本地文件路径**（绝对路径或会话工作区相对路径）与 **http(s) URL**（服务端下载后发送）两种来源 |
| 5 | 发送行为 | Agent 调用即发送，无需人工审批；失败返回结构化错误 JSON，由 Agent 自行处置 |
| 6 | 定时任务覆盖 | 绑定微信 Bot 会话的定时任务在 Agent 执行过程中可直接调用这两个工具（同一条注入链路天然覆盖） |
| 7 | 行为提示 | 在微信会话的 system prompt 中注入两个工具的触发时机与使用约束，提高调用准确性 |
| 8 | 单元测试 | 为两个工具的参数解析、大小校验、文件名推断等纯逻辑分支补充单测 |

### 2.2 明确不做

| # | 事项 | 原因 |
|---|------|------|
| 1 | 视频（`video_item`）出站发送 | 需求未提及；协议虽支持但需缩略图等附加字段，复杂度高，单独立项 |
| 2 | 语音条（`voice_item`）出站发送 | 腾讯侧未稳定开放，维持现状（MP3 文件形式） |
| 3 | 图片缩略图（`thumb_media`）上传 | 腾讯官方实现默认 `no_need_thumb=true`，仅发主图即可 |
| 4 | GIF 转静态 / 图片转码 | 仅做格式白名单校验，原样上传；GIF 显示效果以微信端实测为准 |
| 5 | 前端改动（admin / desktop） | 工具为纯服务端能力，无需前端配合 |
| 6 | 数据库变更 | 无新表、无迁移脚本 |
| 7 | 发送前人工审批 | 微信会话为 CLOUD + FULL 权限，与现有文本/语音回复一致的即时发送策略 |
| 8 | 文本 + 媒体合并单条消息 | 协议建议一条请求只发一个 item；媒体由工具发送，说明文字走正常文本回复 |
| 9 | 多 wxUserId 路由 | 沿用既有约定：按 accountId 取 context_token 表中第一个 wxUserId |
| 10 | 修改 `sendWeixinReplyIfApplicable` | 定时任务最终文本投递逻辑保持不变，仅新增 Agent 执行期工具调用能力 |

## 3. 现状分析

### 3.1 可复用的既有组件

| 组件 | 位置 | 现状 | 复用方式 |
|------|------|------|----------|
| `WeixinMediaUploadService` | `weixin/service/WeixinMediaUploadService.java` | 已实现 `getuploadurl → AES-128-ECB(PKCS7) → CDN upload` 完整链路；`uploadMedia` 私有方法按 `media_type` 分发；已支持 FILE=3、VOICE=4 | 新增 `MEDIA_TYPE_IMAGE=1` 与 `uploadImage`；`uploadAudioFile` 重构为通用的 `uploadFile` |
| `WeixinSendService` | `weixin/service/WeixinSendService.java` | 已有 `sendText`、`sendFile`（`file_item` type=4，含 media/md5/len）、`sendVoice`、通用 `sendMessage`（context_token 解析、成功判定） | 新增 `sendImage`（`image_item` type=2，media + mid_size）；`sendFile` 直接复用 |
| `WeixinAccountRepository` | `weixin/service/` | `findByUserId(userId)` 取绑定账号、`findByAccountId(accountId)` 取账号实体（含 payload_json 凭据） | 收件人解析 |
| `ContextTokenRepository` | `weixin/service/` | `findByAccountId` 取 wxUserId 列表、`getLatestToken(accountId, wxUserId)` 取最新 context_token | 收件人解析与会话锚点 |
| `WeixinSessionService` | `weixin/service/WeixinSessionService.java` | `PROJECT_KEY = "weixin-bot"`；微信会话创建为 CLOUD + FULL | 渠道判定常量 |
| `ToolRegistry` | `harness/tool/ToolRegistry.java` | 构造器自动注册所有 `Tool` Spring Bean | 新工具打 `@Component` 即自动注册 |
| `ImageFileSupport` | `harness/tool/ImageFileSupport.java` | 已有图片格式工具：`mimeFromPath`（扩展名）、`detectMimeFromBytes`（文件头魔数） | 图片白名单校验，无需引入新依赖 |
| `Tool` 接口 | `harness/tool/Tool.java` | 四级 execute 重载（arguments → +workspace → +sessionId → +userId），需注意回退链避免 StackOverflowError | 新工具实现第 4 级，其余逐级回退 |

### 3.2 关键缺口

1. `WeixinMediaUploadService` 缺少 `media_type=1`（IMAGE）上传能力；
2. `WeixinSendService` 缺少 `image_item`（type=2）消息构造与发送；
3. 没有任何"微信媒体发送"工具暴露给 Agent；
4. 工具可用性没有按渠道（projectKey）过滤的机制——当前 `HarnessService` 第 309 行对所有会话一律 `context.setTools(toolRegistry.getAllTools())`；
5. system prompt 中无微信媒体工具的触发时机指引。

### 3.3 已确认的 iLink 出站媒体协议（联网调研结论）

参考腾讯官方 `@tencent-weixin/openclaw-weixin` 及社区协议规范（`epiral/weixin-bot` 的 `protocol-spec.md`），出站媒体统一走：

```
getuploadurl（申请上传参数）
  → AES-128-ECB + PKCS7 本地加密
  → POST CDN /c2c/upload（响应头 x-encrypted-param = CDNMedia.encrypt_query_param）
  → sendmessage（item_list 携带 CDNMedia 引用）
```

**getuploadurl 请求（图片，media_type=1）**：

```json
{
  "filekey": "7cc7ad1d6aaf4c32b23dc4f8c40ec0cf",
  "media_type": 1,
  "to_user_id": "o9cq800kum_4g8Py8Qw5G0a@im.wechat",
  "rawsize": 248731,
  "rawfilemd5": "9c4d5c0b21f7f5c77c2b12f05f1b8df8",
  "filesize": 248736,
  "no_need_thumb": true,
  "aeskey": "00112233445566778899aabbccddeeff",
  "base_info": { "channel_version": "mao-server-1.0" }
}
```

- `media_type`：1=IMAGE、2=VIDEO、3=FILE、4=VOICE（与现有常量一致）；
- `filesize = ceil((rawsize + 1) / 16) * 16`（PKCS7 填充后密文长度，现有 `uploadMedia` 中 `(rawsize / 16 + 1) * 16` 与此等价）；
- 响应取 `upload_full_url`（回退 `upload_param` + CDN base 拼接），现有代码已处理。

**sendmessage 图片消息（image_item，type=2）**：

```json
{
  "type": 2,
  "image_item": {
    "media": {
      "encrypt_query_param": "AAFFc8c2PXQ5mKPw7rbcH7S1EA=",
      "aes_key": "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
      "encrypt_type": 1
    },
    "mid_size": 248736
  }
}
```

- `aes_key` 使用协议格式 B：`base64(hex string)`，现有 `CdnMedia.aesKey` 已按此生成，直接复用；
- `mid_size` = 主图密文长度，即 `CdnMedia.size()`；
- 官方发送实现仅带 `media` + `mid_size`，不带 `thumb_media`。

**sendmessage 文件消息（file_item，type=4）**（现有 `sendFile` 已实现，此处仅为完整对照）：

```json
{
  "type": 4,
  "file_item": {
    "media": {
      "encrypt_query_param": "AALk1J1Rljnmdk6PMx1PZ0h4mA=",
      "aes_key": "MDAxMTIyMzM0NDU1NjY3Nzg4OTlhYWJiY2NkZGVlZmY=",
      "encrypt_type": 1
    },
    "file_name": "报价单-2026Q1.pdf",
    "md5": "9d2a7b9c3e2f1d41c7d5b3a1a7e1c6f0",
    "len": "542188"
  }
}
```

## 4. 总体设计

### 4.1 架构示意

```
微信用户 ──消息──▶ WeixinMonitor(长轮询) ──▶ InboundProcessor ──▶ AgentWeixinInboundHandler
                                                                    │
                                                                    ▼
                                                         HarnessService.execute()
                                                          │ 按 projectKey 注入工具集
                                                          ▼
                                              AgentLoop（LLM 工具调用循环）
                                                          │ 调用
                                                          ▼
                                     ┌─────────────┴──────────────┐
                                     ▼                            ▼
                          SendWechatImageTool           SendWechatFileTool
                          （implements Tool,           （implements Tool,
                            WeixinChannelTool）           WeixinChannelTool）
                                     │                            │
                                     └─────────┬──────────────────┘
                                               ▼
                                   WeixinMediaToolSupport
                              （resolveTarget / loadBytes / errorJson）
                                               ▼
                        WeixinMediaUploadService（uploadImage / uploadFile）
                                               ▼
                              WeixinSendService（sendImage / sendFile）
                                               ▼
                        iLink sendmessage（context_token + CDNMedia）
```

### 4.2 渠道限定（核心机制）

- 定义空标记接口 `WeixinChannelTool`（位于 `harness/tool/` 包），两个微信媒体工具实现它；
- `HarnessService` 第 309 行 `context.setTools(...)` 处过滤：`projectKey != "weixin-bot"` 时移除所有 `WeixinChannelTool` 实例；
- 该过滤**同时**作用于两处：
  1. **schema 层**：`PromptEngine.buildToolDefinitions` 只遍历 `context.getTools()`，非微信会话的 LLM 看不到这两个工具；
  2. **执行层**：`AgentLoop` 的 `isToolAllowed` 基于 `context.getTools()` 拦截，非微信会话即使模型伪造工具名也会被拒绝执行；
- `ToolDispatcher.SERVER_ONLY_TOOLS` 增加两个工具名，确保即使未来出现 LOCAL 模式的微信会话，工具也只在服务端执行（依赖服务端账号凭据与 CDN 链路）。

### 4.3 收件人解析（与定时任务一致）

```
userId ──WeixinAccountRepository.findByUserId──▶ account（accountId + payload_json 凭据）
        ──ContextTokenRepository.findByAccountId──▶ 第一个 wxUserId
        ──ContextTokenRepository.getLatestToken(accountId, wxUserId)──▶ context_token
```

任一步骤缺失即返回结构化错误（见 6.4），不抛异常。

## 5. 技术选型

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 工具形态 | 两个独立工具 `send_wechat_image` / `send_wechat_file` | 图片与文件的协议字段、大小限制、校验规则差异大；独立工具的 JSON Schema 各自简单，LLM 传参不易出错 |
| 协议链路 | 复用现有 `WeixinMediaUploadService` 的 getuploadurl → AES-128-ECB → CDN 上传 | 与语音文件发送同一套已上线链路，风险最小；仅需新增 `media_type=1` 与 `image_item` 构造 |
| 媒体来源 | 本地路径 + http(s) URL 双支持 | 覆盖 generate_image 产物（image_path）、工作区文件、网络资源三类主要场景 |
| 图片校验 | 复用 `ImageFileSupport`（扩展名 + 文件头魔数白名单），不做转码 | 零新依赖；白名单：PNG/JPG/JPEG/GIF/WebP |
| 大小限制 | 图片 ≤ 20MB；文件 ≤ 100MB | 微信侧实测图片上限约 20MB；文件走 CDN 对 100MB 内支持良好 |
| 审批 | 即时发送，无需人工审批 | 与现有文本/语音回复策略一致；错误回传 Agent 自行处置 |
| 定时任务 | 复用同一工具注入机制，零额外逻辑 | 定时任务同样走 `HarnessService.executeFromEvent` 的 Agent 循环，会话 projectKey 为 weixin-bot 时工具天然可用 |

## 6. 详细设计

### 6.1 新文件清单

| 文件 | 职责 |
|------|------|
| `backend/src/main/java/cn/etarch/mao/harness/tool/WeixinChannelTool.java` | 空标记接口：标识"仅微信通道可用"的工具 |
| `backend/src/main/java/cn/etarch/mao/harness/tool/impl/SendWechatImageTool.java` | 发送图片工具（`@Component`，implements `Tool, WeixinChannelTool`） |
| `backend/src/main/java/cn/etarch/mao/harness/tool/impl/SendWechatFileTool.java` | 发送文件工具（`@Component`，implements `Tool, WeixinChannelTool`） |
| `backend/src/main/java/cn/etarch/mao/weixin/service/WeixinMediaToolSupport.java` | 两个工具共享的服务端支撑：收件人解析、媒体字节装载（本地读/URL 下载）、错误 JSON 构造（`@Component`） |

### 6.2 修改文件清单

| 文件 | 改动 |
|------|------|
| `backend/src/main/java/cn/etarch/mao/weixin/service/WeixinMediaUploadService.java` | 新增常量 `MEDIA_TYPE_IMAGE = 1`；新增 `uploadImage(...)`；`uploadAudioFile` 重构为 `uploadFile(...)`（media_type=3，语义通用）；上传客户端 `readTimeout` 由 60s 提升至 180s（支撑 100MB 大文件） |
| `backend/src/main/java/cn/etarch/mao/weixin/service/WeixinSendService.java` | 新增 `sendImage(accountId, toUserId, CdnMedia)` |
| `backend/src/main/java/cn/etarch/mao/weixin/service/WeixinVoiceReplyService.java` | `uploadAudioFile` 调用点同步改为 `uploadFile`（仅改名） |
| `backend/src/main/java/cn/etarch/mao/harness/core/HarnessService.java` | 第 309 行工具集注入处按 `projectKey` 过滤 `WeixinChannelTool` |
| `backend/src/main/java/cn/etarch/mao/harness/tool/ToolDispatcher.java` | `SERVER_ONLY_TOOLS` 增加 `send_wechat_image`、`send_wechat_file` |
| `backend/src/main/java/cn/etarch/mao/harness/core/PromptEngine.java` | 新增 `appendWeixinMediaToolHints(sb, context)` 并在 buildSystemPrompt 中调用（复用既有 `WEIXIN_PROJECT_KEY` 常量） |
| `docs/weixin-bot-channel-integration-guide.md` | 补充"出站图片/文件发送"章节（协议与实现说明） |

### 6.3 工具接口契约

#### 6.3.1 send_wechat_image

- **名称**：`send_wechat_image`
- **描述**：向微信用户发送一张图片（仅微信通道会话可用）。支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) URL；仅支持 PNG/JPG/JPEG/GIF/WebP，大小不超过 20MB。发送成功后微信用户会收到该图片。
- **输入 Schema**：

```json
{
  "type": "object",
  "properties": {
    "image": {
      "type": "string",
      "description": "要发送的图片：本地文件路径（绝对路径或工作区相对路径），或 http(s) 图片 URL"
    }
  },
  "required": ["image"]
}
```

- **执行流程**：
  1. 解析 `image` 参数，为空返回错误；
  2. `WeixinMediaToolSupport.resolveTarget(userId)` 解析 account + wxUserId（任一缺失返回对应错误）；
  3. `loadBytes(image, workspace, 20MB)` 装载字节（路径读取或 URL 下载，超限中断并报错）；
  4. 图片格式校验：`ImageFileSupport.detectMimeFromBytes` 优先、`mimeFromPath` 兜底，不在白名单返回错误；
  5. `weixinMediaUploadService.uploadImage(account, wxUserId, bytes)` 上传；
  6. `weixinSendService.sendImage(account.getAccountId(), wxUserId, cdnMedia)` 发送；
  7. 成功返回结果 JSON，失败返回错误 JSON。

#### 6.3.2 send_wechat_file

- **名称**：`send_wechat_file`
- **描述**：向微信用户发送一个文件（仅微信通道会话可用）。支持本地文件路径（绝对路径或会话工作区相对路径）或 http(s) URL；大小不超过 100MB；可用 `file_name` 指定微信端显示的文件名（默认取 URL 最后一段或本地文件名）。
- **输入 Schema**：

```json
{
  "type": "object",
  "properties": {
    "file": {
      "type": "string",
      "description": "要发送的文件：本地文件路径（绝对路径或工作区相对路径），或 http(s) 下载 URL"
    },
    "file_name": {
      "type": "string",
      "description": "微信端显示的文件名（可选，默认取 URL 最后一段或本地文件名）"
    }
  },
  "required": ["file"]
}
```

- **执行流程**：与图片工具一致，仅差异为：大小上限 100MB；不做格式校验；`file_name` 推断顺序为参数 > URL 尾段 > 本地文件名 > `file-<时间戳>.<ext>`；上传走 `uploadFile`（media_type=3），发送走既有 `sendFile`。

#### 6.3.3 返回格式

成功（图片）：

```json
{
  "success": true,
  "media_type": "image",
  "size_bytes": 248731,
  "sent_to": "o9cq800kum_4g8Py8Qw5G0a@im.wechat"
}
```

成功（文件）：`media_type: "file"`，额外包含 `file_name`。

失败（统一结构）：

```json
{ "error": "具体失败原因" }
```

### 6.4 WeixinMediaToolSupport 设计

```java
@Component
public class WeixinMediaToolSupport {

    public record WechatTarget(WeixinChannelAccount account, String wxUserId) {}

    /** 解析收件人：userId → 绑定账号 + 第一个 wxUserId */
    public Optional<WechatTarget> resolveTarget(Long userId);

    /** 装载媒体字节：path（绝对或 workspace 相对）或 http(s) URL；超过 maxBytes 抛异常 */
    public byte[] loadBytes(String pathOrUrl, String workspace, long maxBytes);

    /** 构造统一错误 JSON */
    public String errorJson(String message);
}
```

- `resolveTarget`：`userId` 为 null、账号未绑定、无 context_token 记录三种情况返回 empty，由调用方转成对应错误文案；
- `loadBytes`：仅允许 `http`/`https` scheme；下载时流式读取并在超过 `maxBytes` 时中断；本地路径优先按绝对路径读取，非绝对路径以 `workspace` 为基准解析；
- 媒体字节全程在内存处理，不落临时盘（图片 ≤20MB、文件 ≤100MB 内存可承受）。

### 6.5 微信服务扩展

`WeixinMediaUploadService`：

```java
private static final int MEDIA_TYPE_IMAGE = 1;

/** 上传图片密文（media_type=IMAGE） */
public Optional<CdnMedia> uploadImage(WeixinChannelAccount account, String toUserId, byte[] plaintext);

/** 上传文件密文（media_type=FILE），替代原 uploadAudioFile */
public Optional<CdnMedia> uploadFile(WeixinChannelAccount account, String toUserId, byte[] plaintext);
```

`WeixinSendService`：

```java
/**
 * 发送图片消息（image_item，type=2）。
 * @param media 上传后拿到的 CDN 媒体引用（size 为密文长度，即 mid_size）
 */
public boolean sendImage(String accountId, String toUserId, WeixinMediaUploadService.CdnMedia media);
```

`sendImage` 构造：

```json
{
  "type": 2,
  "image_item": {
    "media": {
      "encrypt_query_param": "...",
      "aes_key": "...",
      "encrypt_type": 1
    },
    "mid_size": 248736
  }
}
```

其中 `mid_size` 取 `media.size()`（密文长度），复用 `sendMessage` 的 context_token 解析与成功判定逻辑。

### 6.6 渠道限定实现

`HarnessService`（第 309 行附近）：

```java
// 微信通道工具仅在 weixin-bot 会话中提供
List<Tool> sessionTools = new ArrayList<>(toolRegistry.getAllTools());
if (!WeixinSessionService.PROJECT_KEY.equals(session.getProjectKey())) {
    sessionTools.removeIf(t -> t instanceof WeixinChannelTool);
}
context.setTools(sessionTools);
```

`ToolDispatcher`：

```java
private static final Set<String> SERVER_ONLY_TOOLS = Set.of(
        "task_create", "task_update", "task_list", "task_delete", "delegate",
        "web_search", "open_web_page", "generate_image",
        "send_wechat_image", "send_wechat_file");
```

### 6.7 Prompt 行为提示

`PromptEngine` 新增：

```java
private void appendWeixinMediaToolHints(StringBuilder sb, AgentExecutionContext context) {
    boolean hasWeixinMediaTool = context.getTools().stream()
            .anyMatch(t -> WEIXIN_MEDIA_TOOL_NAMES.contains(t.getName())); // {send_wechat_image, send_wechat_file}
    if (!hasWeixinMediaTool) return;
    sb.append("""
            ## 微信媒体发送

            - 当前会话为微信通道。用户请求"把这张图/照片发给我""生成一张图发我"时，使用 send_wechat_image；请求"发一份文件/PDF/报告"时使用 send_wechat_file。
            - 工具只负责发送媒体本身；文字说明通过正常回复给出。
            - 工具返回 {"error": ...} 时，如实向用户说明原因（如账号未绑定、需要先给机器人发一条消息建立会话、文件超限等），不要重复调用。
            """);
}
```

在 `buildSystemPrompt` 中与 `appendToolBehaviorHints` 并列调用。工具描述与提示均明确"仅微信通道可用"，降低 Agent 误用概率。

### 6.8 定时任务覆盖

`ScheduledTaskService.executeTask` 通过 `harnessService.executeFromEvent(sessionId, ...)` 在任务会话上运行 Agent 循环。只要该会话的 `projectKey = "weixin-bot"`（用户在创建定时任务时选择微信 Bot 会话），工具集注入与 `sendWeixinReplyIfApplicable` 的判定条件一致，Agent 在任务执行过程中即可直接调用两个工具发送媒体。**无需**为定时任务新增任何解析或投递逻辑；最终文本投递逻辑保持不变。

## 7. 实现步骤（落地清单）

按依赖顺序排列，每一步完成即编译验证（`cd backend && mvn compile`）。

| 步骤 | 内容 | 验收 |
|------|------|------|
| 1 | `WeixinMediaUploadService`：新增 `MEDIA_TYPE_IMAGE`、`uploadImage`；`uploadAudioFile` 重构为 `uploadFile`；readTimeout 60s→180s | 编译通过；`WeixinVoiceReplyService` 调用点同步更新 |
| 2 | `WeixinSendService`：新增 `sendImage` | 编译通过；`mid_size` 取 `media.size()` |
| 3 | 新增 `WeixinMediaToolSupport`（resolveTarget / loadBytes / errorJson） | 编译通过；URL 下载限流中断逻辑就绪 |
| 4 | 新增 `WeixinChannelTool` 标记接口 + `SendWechatImageTool` + `SendWechatFileTool` | `ToolRegistry` 启动日志出现两个新工具名 |
| 5 | `HarnessService` 按 projectKey 过滤 `WeixinChannelTool` | 非微信会话工具列表不含两个新工具 |
| 6 | `ToolDispatcher.SERVER_ONLY_TOOLS` 增加两个工具名 | 编译通过 |
| 7 | `PromptEngine` 新增 `appendWeixinMediaToolHints` | 微信会话 system prompt 出现"微信媒体发送"小节 |
| 8 | 单元测试：两工具的入参解析、大小上限、图片白名单校验、`file_name` 推断分支 | `cd backend && mvn test` 通过 |
| 9 | 更新 `docs/weixin-bot-channel-integration-guide.md` 出站媒体章节 | 文档补充完成 |
| 10 | 手工联调（见第 8 节） | 微信端实测通过 |

> 注意：按仓库约束，Agent 不执行后端服务重启；联调前由用户自行重启后端。

## 8. 测试与验证方案

### 8.1 单元测试

| 用例 | 断言 |
|------|------|
| `SendWechatImageTool` 缺 `image` 参数 | 返回 `{"error": ...}` |
| `SendWechatImageTool` 图片超 20MB | 返回超限错误 |
| `SendWechatImageTool` 非白名单扩展名/魔数 | 返回格式错误 |
| `SendWechatFileTool` 缺 `file` 参数 | 返回 `{"error": ...}` |
| `SendWechatFileTool` 文件超 100MB | 返回超限错误 |
| `SendWechatFileTool` `file_name` 推断（参数 > URL 尾段 > 本地文件名） | 结果正确 |
| `resolveTarget` 三态（正常 / 未绑定 / 无 wxUserId） | 正确返回或 empty |
| `loadBytes` URL scheme 非 http/https | 拒绝 |

### 8.2 手工联调（微信端实测）

1. 微信会话内：用户发"把工作区里 xxx.png 发给我"→ Agent 调 `send_wechat_image` → 微信收到图片；
2. 微信会话内：用户发"生成一张日落图发我"→ Agent 依次调 `generate_image` + `send_wechat_image(image_path=...)` → 微信收到生成图；
3. 微信会话内：用户发"把这份报告 PDF 发我"→ Agent 调 `send_wechat_file` → 微信收到文件且文件名正确；
4. URL 来源：Agent 从网络下载图片/文件发送 → 成功；
5. 边界：未绑定账号 / 无 context_token（用户从未发消息）/ 超限 / 非法图片格式 → Agent 收到错误并如实告知用户；
6. 非微信通道：桌面端会话确认 LLM 工具列表不含 `send_wechat_*`，模型伪造调用被拦截；
7. 定时任务：创建绑定微信 Bot 会话的定时任务，prompt 要求生成图片并发送 → 微信收到图片，最终文本照常投递；
8. GIF：发送 GIF 图片，确认微信端显示行为（若异常则记录，纳入后续"GIF 转静态"单独立项）。

## 9. 风险与注意事项

| 风险 | 说明 | 应对 |
|------|------|------|
| `context_token` 过期 | 用户长时间未与 Bot 互动后，token 失效，`sendmessage` 失败 | 工具返回错误"请用户先在微信给机器人发一条消息建立会话"；不重试 |
| 100MB 文件上传超时 | CDN 上传 readTimeout 60s 对 100MB 偏紧 | 上传客户端 readTimeout 提升至 180s（步骤 1 已含） |
| GIF 显示兼容 | 未做转码，微信端对 GIF 的显示未经实测 | 联调用例 8 覆盖；异常则记录为后续独立项 |
| 非微信会话伪造调用 | 模型可能在非微信会话编造工具名 | `isToolAllowed` 执行层拦截兜底（方案已含） |
| 媒体字节占用内存 | 100MB 上限在内存中处理 | 单次工具调用生命周期内持有，调用结束即释放，可接受 |
| execute 回退链 | `Tool` 接口默认实现互相调用曾导致 StackOverflowError | 新工具实现 4 参 execute，其余重载逐级回退到 4 参，不新增默认实现调用关系 |

## 10. 决策记录

| 决策点 | 结论 |
|--------|------|
| 工具形态 | 两个独立工具（send_wechat_image / send_wechat_file） |
| 媒体来源 | 本地路径（绝对/工作区相对）+ http(s) URL 双支持 |
| 大小限制 | 图片 ≤ 20MB；文件 ≤ 100MB |
| 发送与审批 | 即时发送、无需审批；失败返回结构化错误 JSON |
| 图片格式 | 白名单校验（PNG/JPG/JPEG/GIF/WebP）、不转码 |
| 范围边界 | 对话工具 + 定时任务媒体发送（同链路天然覆盖）；视频/语音条/缩略图/转码不做 |
