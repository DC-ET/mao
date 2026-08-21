# 微信入站文件接收与处理技术方案

> 状态：已确认并实现（2026-08-06）
> 日期：2026-08-06
> 关联代码：`backend/.../weixin/`、`backend/.../harness/`

## 1. 需求背景

微信通道会话中，用户给 Agent 发送 PDF 等文件后，Agent 直接忽略且没有任何回复。

排查根因：微信入站链路 `InboundProcessor` 只提取三类消息内容——文本（`type=1`）、图片（`type=2`）、语音识别文本（`type=3`），**文件消息（`type=4`，`file_item`）被完全忽略**。当用户只发送文件、不带文字时，`body` 为空且无图片，直接命中"忽略空消息"分支静默丢弃，Agent 不会执行、也不会回复。

需求目标：微信收到文件后，将文件下载并保存到当前微信会话工作区，再以文件引用形式让 Agent 读取并处理任务。

## 2. 需求描述

1. 微信入站文件消息（`file_item`，`type=4`）不再被忽略。
2. 文件经 CDN 下载 + AES 解密后，保存到微信会话工作区 `weixin-files/YYYY-MM-DD/` 子目录。
3. 保存成功后将文件绝对路径以 `@{绝对路径}@` 标记注入 Agent 的用户消息（复用桌面端文件引用格式）。
4. Agent 收到消息后自主读取文件内容（通过 `read_file`、`shell` 工具等）并完成任务，正常回复微信用户。
5. 文件接收/保存失败、超过大小上限时，向用户回复明确错误提示，而不是静默无回复。

## 3. 现状分析

### 3.1 微信入站链路（`backend/.../weixin/`）

| 组件 | 现状 | 与本需求的关系 |
|------|------|--------------|
| `service/InboundProcessor.java` | 仅识别 `ITEM_TYPE_TEXT=1`、`ITEM_TYPE_IMAGE=2`、语音文本（`type=3`）；无文件类型；纯文件消息落入"忽略空消息"分支直接 return | 需新增 `ITEM_TYPE_FILE=4` 识别与文件下载 |
| `service/WeixinMediaService.java` | `downloadImage` 已实现 CDN 下载（`encrypt_query_param`）+ AES-128-ECB 解密 + 图片压缩，下载与解密逻辑通用 | 复用其下载/解密逻辑新增 `downloadFile` |
| `model/WeixinInboundMessageContext.java` | 含 `body`、`imageDataUris`、`mediaPath` 等字段，无文件字段 | 需新增入站文件列表字段 |
| `handler/AgentWeixinInboundHandler.java` | `buildMessageContent` 将文本/图片转成 `String` 或 `List<ContentPart>`；调用 `sessionService.saveMessage` 保存消息后走 `harnessService` 执行 Agent | 需在保存文件后构造带 `@{路径}@` 标记的消息内容 |
| `config/WeixinBotConfig.java` | 已有 voiceReply、silk 等配置 | 需新增入站文件大小上限配置 |
| `service/WeixinSessionService.java` | 微信会话固定 CLOUD 模式，工作区为 `{workspace-root}/{userId}/weixin-bot`（`projectKey="weixin-bot"`），同一用户多会话共享该目录 | 文件保存目标目录基于 `session.getWorkspace()` |

### 3.2 Agent 侧文件引用机制（已具备，直接复用）

- 桌面端文件引用采用 `@{路径}@` 标记，`PromptEngine.FILE_REF_PATTERN = @\{([^}]+)\}@` 会在构建 prompt 时**原地剥离标记，将纯路径文本传给 LLM**（`PromptEngine.java:172-176`）。
- **限制**：`PromptEngine.replaceQuickCommandMarkers` 仅处理 content 为 `String` 的消息；`List<ContentPart>` 消息中的 text part **不会**被剥离标记。
- 消息展示端（桌面端 `quick-command-parser`）已支持 `@{...}@` 渲染为文件标签，微信会话消息在桌面端打开时可直接展示。

### 3.3 文件读取能力现状

- `read_file` 工具支持文本文件与图片，**不支持 PDF/Office 解析**（`ReadFileTool.java`）。
- 按决策：**本期不新增 PDF 提取工具**，PDF 内容由 Agent 通过 `shell` 工具（如 `pdftotext`、Python 脚本）自主读取，读取方式交给 Agent 自行决策。

### 3.4 出站文件发送（不在本期范围）

`SendWechatFileTool` + `WeixinMediaUploadService.uploadFile` 已实现 Agent 向微信用户发送文件（`media_type=3` FILE）。本期只做入站接收，不改动出站链路。

## 4. 已确认的决策

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 文件类型范围 | **所有文件类型都接收保存**，不做白名单 |
| 2 | 保存位置 | 微信会话工作区下按日期分子目录：`{workspace}/weixin-files/YYYY-MM-DD/` |
| 3 | 同名文件 | **自动追加时间戳后缀重命名**（`xxx_20260806153012.pdf`），保留原始文件名、不覆盖 |
| 4 | PDF/Office 内容读取 | **不新增提取工具**，由 Agent 通过 shell/脚本自主读取（`pdftotext`、Python 等） |
| 5 | Agent 行为引导 | **不修改系统提示/最佳实践**；仅在消息正文注入 `@{绝对路径}@` 标记 |
| 6 | 消息构造格式 | 带文字：`用户文字 + @{绝对路径}@`；纯文件：仅 `@{绝对路径}@`；多文件：多个 `@{路径}@` 拼接 |
| 7 | 文件大小上限 | **100MB**，做成可配置项 `weixin.bot.max-inbound-file-mb`（默认 100），超限拒绝并回复"文件过大" |
| 8 | 是否登记 file 表 | **不登记**，文件仅保存到工作区，不做管理后台文件列表/下载 |
| 9 | 下载/解密失败处理 | 回复明确错误提示（如"文件接收失败，请重试"），不静默忽略 |
| 10 | 文件清理 | **不自动清理**，文件长期保留在工作区 |

## 5. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 文件下载/解密 | 复用 `WeixinMediaService` 现有 CDN 下载 + AES-128-ECB 解密逻辑 | 与图片链路同协议（`encrypt_query_param` + aes_key），零新依赖 |
| 消息引用格式 | `@{绝对路径}@` 标记 | 复用 `PromptEngine.FILE_REF_PATTERN` 剥离逻辑与桌面端渲染，全链路一致 |
| 文件存储 | 服务器文件系统（工作区目录），不使用对象存储 | 文件在工作区内即可被 `read_file`/`shell` 工具直接访问，满足需求 |
| 文件登记 | 不写入 `file` 表 | 决策 #8 |
| PDF 解析 | 不引入解析库（PDFBox 等） | 决策 #4，Agent 自主读取 |
| 大小限制 | 配置项 `weixin.bot.max-inbound-file-mb`（默认 100） | 决策 #7，可调优 |

## 6. 实现步骤

> 改动全部集中在 `backend/`，不涉及前端/安卓/admin。

### 6.1 `WeixinMediaService`：新增 `downloadFile`

文件：`backend/src/main/java/cn/etarch/mao/weixin/service/WeixinMediaService.java`

新增方法 `Optional<DownloadedFile> downloadFile(JsonNode fileItem)`：

1. 从 `file_item.media` 读取 `encrypt_query_param`（缺失则回退 `file_item` 其他可用字段，参照图片逻辑），读取 AES key（复用 `resolveAesKey`，兼容 `aeskey` 与 `aes_key` 两种字段位置）。
2. 调用现有 `downloadCiphertext(encryptQueryParam)` 下载密文，`decryptAes128Ecb` 解密得明文 bytes。
3. 读取 `file_item.file_name` 作为原始文件名（缺失时生成默认名 `file-{uuid}`）。
4. 不做图片压缩/5MB 限制（文件不受图片限制约束）。
5. 返回 `DownloadedFile`（record：`fileName`、`bytes`、`mimeType` 探测值）。

复用现有 `downloadCiphertext`、`resolveAesKey`、`decryptAes128Ecb`，不重复实现协议逻辑。

### 6.2 `WeixinInboundMessageContext`：新增文件字段

文件：`backend/src/main/java/cn/etarch/mao/weixin/model/WeixinInboundMessageContext.java`

新增：

```java
/** 入站文件列表（已下载解密，待保存到工作区） */
@Builder.Default
private List<InboundFile> files = new ArrayList<>();
```

`InboundFile` 定义为 record（`fileName`、`bytes`、`mimeType`），可内嵌或独立文件。

### 6.3 `InboundProcessor`：识别文件消息

文件：`backend/src/main/java/cn/etarch/mao/weixin/service/InboundProcessor.java`

1. 新增常量 `ITEM_TYPE_FILE = 4`。
2. 新增 `downloadFiles(JsonNode message)`：遍历 `item_list`，对 `type=4` 的 item 取 `file_item` 调用 `weixinMediaService.downloadFile`，失败记 warn 并跳过。
3. "空消息"判断改为：`body` 空 && 图片空 && **文件空** 才忽略。
4. 构建 context 时填充 `files` 列表。

### 6.4 新增 `WeixinFileStorageService`：文件保存

新建：`backend/src/main/java/cn/etarch/mao/weixin/service/WeixinFileStorageService.java`

职责：把入站文件字节保存到微信会话工作区。核心方法：

```java
Path saveFile(String workspace, String fileName, byte[] bytes)
```

实现要点：

1. **大小校验**：超过 `weixin.bot.max-inbound-file-mb`（默认 100）时抛业务异常（含明确中文错误信息），由调用方转成用户提示。
2. **目标目录**：`{workspace}/weixin-files/{yyyy-MM-dd}/`，`Files.createDirectories` 创建。
3. **文件名清洗（防路径穿越）**：
   - 取 `Path.of(fileName).getFileName()` 仅保留 basename；
   - 剔除 `\ / : * ? " < > |` 与控制字符；
   - 空结果回退 `file-{uuid}`；长度截断（如 ≤ 120 字符），保留扩展名。
4. **重名处理**：目标文件已存在时，在扩展名前追加 `_yyyyMMddHHmmss`（秒级足够，仍冲突再追加递增序号）。
5. **路径安全**：保存目录基于 `session.getWorkspace()`（后端生成的受控目录），文件名清洗后不存在穿越风险；写入前再次确认最终路径在 `weixin-files` 目录内（可用 `PathSandbox` 或 `path.startsWith` 校验）。
6. 返回保存后的绝对路径。

### 6.5 `AgentWeixinInboundHandler`：构造带文件引用的消息

文件：`backend/src/main/java/cn/etarch/mao/weixin/handler/AgentWeixinInboundHandler.java`

1. `onMessage` 获取 `session` 后，先处理 `context.getFiles()`：
   - 逐个调用 `weixinFileStorageService.saveFile(session.getWorkspace(), ...)`；
   - 保存失败（超限/异常）时，不触发 Agent，直接构造错误回复文本（如 `"文件 {name} 接收失败：超过大小限制（100MB）"` 或 `"文件 {name} 接收失败，请重试"`）返回给微信用户。
2. 改造 `buildMessageContent(context, workspace)`：
   - **有文件**：
     - 文本 = 用户文字（若有）+ 每个文件 `@{绝对路径}@` 拼接；纯文件消息正文仅 `@{路径}@`，不带引导文案（决策 #6）；
     - 若同时有图片，走 `List<ContentPart>`：text part 文本直接放**纯路径文本**（因 `PromptEngine` 不剥离 ContentPart 内的标记，见 3.2；String 场景才使用 `@{...}@` 标记），image parts 照旧。
   - **无文件**：维持现有逻辑（纯文本 String / 图片 ContentPart）。
3. `saveMessage` 保存的 content 与传给 Agent 的 content 保持一致（String 场景含 `@{...}@` 标记，桌面端可渲染文件标签）。
4. 保存失败错误消息同样走 `sessionService.saveMessage`（记录用户侧失败反馈）并直接回复，不进入 Agent 执行。

> 说明：String 场景的 `@{路径}@` 由 `PromptEngine` 在构建 prompt 时剥离为纯路径；ContentPart 场景在构造时即为纯路径文本，两条路径下 LLM 最终看到的都是绝对路径文本，行为一致。

### 6.6 `WeixinBotConfig`：新增大小配置

文件：`backend/src/main/java/cn/etarch/mao/weixin/config/WeixinBotConfig.java`

新增字段 `private int maxInboundFileMb = 100;`（前缀 `weixin.bot` 自动映射为 `weixin.bot.max-inbound-file-mb`），`WeixinFileStorageService` 注入读取。

### 6.7 测试

新增/修改 `backend/src/test/java/cn/etarch/mao/weixin/` 下用例：

| 用例 | 覆盖点 |
|------|--------|
| `WeixinMediaService` 文件下载测试 | `downloadFile` 字段解析（`file_item.media` 缺 `aes_key`/位于 item 级等）、解密复用 |
| `InboundProcessor` 测试 | `type=4` item 识别、空消息判断（仅文件不算空）、文件下载失败跳过 |
| `WeixinFileStorageService` 测试 | 日期子目录、文件名清洗（`../`、非法字符、超长）、同名时间戳重命名、大小超限拒绝 |
| `AgentWeixinInboundHandler` 测试 | 纯文件/文件+文字/多文件/文件+图片的消息构造；保存失败直接回复错误、不触发 Agent |

### 6.8 收尾

- 更新根目录 `CHANGELOG.md` `### 后端` 小节（用户可见行为改动）。
- 更新 `docs/weixin-bot-channel-integration-guide.md` 第 7 节"媒体处理"补充入站文件（file_item）接收说明。
- 后端重启由用户自行执行（按仓库禁令，Agent 不重启服务）。

## 7. 落地清单

### 做（本期实现）

- [x] 微信入站文件消息（`type=4` / `file_item`）识别、下载、AES 解密
- [x] 文件保存到 `{workspace}/weixin-files/YYYY-MM-DD/`（按日期子目录）
- [x] 文件名清洗（防路径穿越）+ 同名追加时间戳重命名
- [x] 100MB 大小上限（可配置 `weixin.bot.max-inbound-file-mb`），超限回复"文件过大"
- [x] 消息以 `@{绝对路径}@` 标记注入 Agent（复用 `PromptEngine` 剥离；ContentPart 场景用纯路径文本）
- [x] 纯文件消息正文 = 仅 `@{路径}@`；文件+文字 = 文字 + `@{路径}@`；多文件/图片混合按 6.5 规则
- [x] 下载/解密/保存失败回复明确错误提示，不再静默忽略
- [x] 单元测试（下载解析、入站识别、文件存储、消息构造）
- [x] 更新 `CHANGELOG.md` 与微信集成指南

### 不做（明确排除）

- [x] 不扩展 `read_file` 支持 PDF/Office 解析，不引入 PDFBox 等解析库；PDF 内容由 Agent 通过 shell/脚本自主读取
- [x] 不修改系统提示/最佳实践经验注入 Agent 行为引导（仅消息内 `@{路径}@` 标记）
- [x] 不登记 `file` 表，不做管理后台文件列表/下载入口
- [x] 不做微信侧"已收到文件"即时提示（仍为 Agent 完整回复一次性下行）
- [x] 不做文件自动清理/生命周期管理（文件长期保留在工作区）
- [x] 不处理视频、语音文件本体等非 `file_item` 媒体（语音仍仅取识别文本，维持现状）
- [x] 不改桌面端/管理后台/安卓；前端消息渲染依赖现有 `@{...}@` 支持，无改动
- [x] 不改动出站文件发送链路（`SendWechatFileTool` 等）

## 8. 验证方式

1. `cd backend && mvn compile` 编译检查。
2. `cd backend && mvn test` 运行相关单测（`weixin` 包用例）。
3. 手动验证（需用户重启后端后执行）：微信向 Agent 发送 PDF → 观察：
   - 服务器工作区出现 `{workspace}/weixin-files/当天日期/{清洗后文件名}.pdf`；
   - Agent 回复内容体现已读取并处理该文件（如总结 PDF 内容）；
   - 发送 >100MB 文件时回复"文件过大"提示。

## 9. 风险与注意事项

1. **入站 `file_item` 字段结构**：协议文档给出的是出站样例，入站字段名（`media.encrypt_query_param` / `aes_key` / `aeskey` 位置）可能略有差异；`resolveAesKey` 已兼容 `aeskey` 与 `aes_key` 两种位置，实现时以真实微信消息为准，必要时调整字段读取。
2. **大文件内存占用**：100MB 文件以 `byte[]` 整体载入内存，CDN 下载 readTimeout 目前 60s，超大/慢速文件可能超时；如实测超时可将 `downloadFile` 的下载超时单独放宽（如 180s，与出站上传一致）。
3. **共享工作区**：同一用户微信会话共用 `{userId}/weixin-bot` 工作区，文件按日期归档可避免长期堆积混乱；跨会话仍可被 Agent 通过路径访问（属预期行为）。
4. **纯文件消息仅路径标记**：LLM 对裸路径的理解依赖模型能力，若实测出现"收到路径但不读取"的情况，后续可考虑在消息文本补充引导文案（本期不做，作为观测项）。
5. **ContentPart 混合场景标记不剥离**：已通过"ContentPart 直接放纯路径文本"规避，注意与 String 场景保持最终 LLM 输入一致性。
