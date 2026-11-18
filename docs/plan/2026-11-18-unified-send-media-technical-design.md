# 统一发送图片 / 文件技术方案（send_image / send_file）

- 状态：草案（2026-11-18；§3 决策为拟定口径，评审通过后定案）
- 日期：2026-11-18
- 修订：2026-11-18。会话类型只在创建时绑定外部通道，之后同一条会话会在网页、桌面、安卓和该 IM 里被打开。发送改为「会话记录始终留一份副本，绑定了外部通道再额外推一份」，两侧独立成败。
- 关联方案：
  - [2026-11-18-local-workspace-image-render-technical-design.md](./2026-11-18-local-workspace-image-render-technical-design.md)（互补，不互相替代：那份方案让正文里的工作区相对图片按需渲染，**不落盘**；本方案是模型显式调用「发给当前会话」，字节写入 uploads）
  - [2026-11-07-user-agent-container-isolation-technical-design.md](./2026-11-07-user-agent-container-isolation-technical-design.md)（`SEND_BYTES_TOOLS`、按轮快照的 `agentId`、`loadSendFileBytes` 读容器字节，本方案继续走这条路径）
- 能力底座（撰写时已存在的实现，全部复用、不重写）：
  - 六个通道工具：`SendWechatImageTool` / `SendWechatFileTool`（`backend-ts/src/harness/tool/impl/wechat-tools.ts`）、`SendFeishuImageTool` / `SendFeishuFileTool`（`feishu-tools.ts:239-330`）、`SendDingtalkImageTool` / `SendDingtalkFileTool`（`dingtalk-tools.ts`）。注册点 `tool-registry.ts:187-193`
  - 会话过滤：`HarnessService.filterToolsForSession` 按 `projectKey` / `workspace` 只留本通道的工具（`harness-service.ts:737-750`）。判定函数：`projectKey === WEIXIN_PROJECT_KEY`、`isFeishuChannelSession`（`feishu-channel-tool.ts:13-16`）、`isDingtalkChannelSession`（`dingtalk-channel-tool.ts:10-12`）
  - 收件人解析都只认当前 `sessionId`，工具参数里没有收件人：飞书 `findSessionChannel(sessionId)`（`app-harness-engine.ts:238-246`）；钉钉 `resolveSendTarget` 读该会话的 workspace / projectKey（`dingtalk/runtime.ts:624-641`）；微信 `resolveTarget(userId, sessionId)`，会话未绑对端且账号下有多个联系人时拒绝猜测（`weixin/media-tool-support.ts:31-57`）
  - 读字节：`loadSendFileBytes`（`send-file-bytes.ts:63-78`）。http(s) 走宿主机 `fetchBytesWithLimits`；本地路径走容器 `read_bytes` 或宿主机严格解析。dispatcher 用 `sendToolRoundContext` 注入本轮 `agentId`（`tool-dispatcher.ts:465-480`）
  - 执行分流：只有 `send_wechat_image` / `send_wechat_file` 在 `SERVER_ONLY_TOOLS`（`tool-dispatcher.ts:68-82`）。飞书 / 钉钉四件套在 `SEND_BYTES_TOOLS` 与 `RUNTIME_SCOPED_TOOLS`（`:90-106`），但不在 `SERVER_ONLY_TOOLS`。LOCAL 会话会把后者下发给 Electron（`:327`）
  - 文字回复已经是「记录在会话里，通道再推一份」：助手正文落在 `message` 表，网页 / 桌面 / 安卓打开同一条会话都能读到；飞书、微信、钉钉另有各自的文本推送。图片和文件今天只走通道 API，会话记录里没有字节
  - 子代理：子会话继承父会话的 `projectKey` 与 `workspace`（`subagent-invocation.service.ts:42-44`）。`SUBAGENT_EXCLUDED_TOOLS` 目前只排除 `ask_user_questions` 和两个钉钉发送工具（`background-subagent-manager.ts:27`），微信 / 飞书发送工具会进入子代理
  - 边路任务同样继承父会话 `projectKey` / `workspace`（`streaming-ws-handler.ts:1457-1463`），工具列表走普通 `buildContext`，不做子代理那套排除
  - 对话页：用户图片只在 `role === 'user'` 时画网格（`MessageBubble.vue:44-54`）；助手消息是 Markdown（`:148-157`）。历史轮次把工具步骤折进「已执行 N 个步骤」（`ChatRoundList.vue:23-74`），文件变更面板在折叠区之外（`:75-79`）。轮次切分在 `useMessageRounds.ts`
  - 文生图落盘：`materializeImageApiResult` 写入 `uploads/{userId}/` 并拼出 `/uploads/...` URL（`generate-image-tool.ts:60-80`）。工具提示写死三个旧发送名（`:119`；`edit-image-tool.ts:95`）
  - 微信提示只在工具列表里出现 `send_wechat_*` 时注入（`prompt-engine.ts:839-846`）
  - 展示名三份拷贝：`desktop/src/utils/toolDisplay.ts`、`admin/src/views/session/utils/toolDisplay.ts`、`sdk/embed/src/ui/toolDisplay.ts`。摘要在 `tool-result-summarizer.ts:150-168`
  - WS 入站上限 1MB（`attach-websocket.ts:19`）。mao-agent 出站 900KB 截断的约束见同日正文图片方案 §能力底座
- 本方案定位：把六个通道发送工具收成 `send_image`、`send_file`。每次发送都在会话记录里留一份可打开的附件，网页、桌面、安卓打开这条会话都能看到。创建时绑定了微信、飞书或钉钉的，再用同一份字节额外推到那个通道。用户在对话页看到的是附件，不是被折进步骤区的工具卡。

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 外部通道 | 创建会话时绑上的微信（`WEIXIN_PROJECT_KEY`）、飞书（`isFeishuChannelSession`）或钉钉（`isDingtalkChannelSession`）。没有则这条会话只存在于网页 / 桌面 / 安卓 |
| 会话副本 | 每次 `send_image` / `send_file` 写入 `uploads/{userId}/` 的那一份。任何端渲染这条会话，都从工具结果的 `delivery` 把它画在该轮回复区 |
| 通道推送 | 在会话副本之外，把同一份字节再发给该会话绑定的外部通道。不向用户的其他通道扩散 |
| 执行端 | LOCAL 会话绑定的桌面 Electron 或 mao-agent。读本机文件时向它要字节 |

## 1. 需求背景

### 1.1 现状

| 设施 | 现状 | 证据 |
|---|---|---|
| 六个发送工具 | 同一形状：路径或 http(s) URL 进，当前会话的对端出。参数没有收件人 | `wechat-tools.ts`、`feishu-tools.ts:249-297`、`dingtalk-tools.ts:33-75` |
| 可见性 | 靠工具上的通道标记，在 `filterToolsForSession` 里互相隐藏。桌面 / 网页会话六个都看不到 | `harness-service.ts:737-750` |
| 限制 | 各通道不同，见 §4.2。钉钉文件还有扩展名白名单 | `dingtalk/send.service.ts:6-8` |
| LOCAL 执行 | 微信发送在服务端执行。飞书 / 钉钉发送在 LOCAL 会话会被下发给 Electron，而 Electron 没有这两个工具 | `tool-dispatcher.ts:68-82`、`:327` |
| 子代理 | 继承父会话通道身份。钉钉发送被排除，微信 / 飞书发送没有排除 | `background-subagent-manager.ts:27`、`subagent-invocation.service.ts:42-44` |
| 文字与媒体不对称 | 助手正文在 `message` 表里，换端打开同一条会话看得到；图片和文件只进通道 API，网页打开飞书任务时只有工具卡上的文件名 | 六个工具的成功结果只有 `success`，没有可展示的 URL |
| 桌面 / 网页 | 没有「把这张图 / 这份文件发到当前对话」的工具。`generate_image` 的图在工具卡里（`ToolImageGenView.vue`），步骤折叠后默认看不见 | `ChatRoundList.vue:23-74` |
| 助手消息 | 没有图片网格。`message.files` 的标签只显示名字，不能下载 | `MessageBubble.vue:44-54`、`:191-196` |

### 1.2 问题

1. 模型要记六个名字，提示词还把三个旧名字写进 `generate_image` / `edit_image`。通道一变，工具名就变，实际做的是同一件事。
2. 会话类型只在创建时定性。用户随后会在网页、桌面、安卓和原来的 IM 里打开同一条会话。文字换端看得到，图片和文件只留在创建时的那个通道里，任务页上是一个空洞。
3. 桌面、网页、安卓的用户说「把这张图发给我」时，模型只能把路径写进 Markdown，或停在工具卡里。步骤一折叠，图就看不见。
4. 飞书 / 钉钉发送不在 `SERVER_ONLY_TOOLS`。一旦这类会话以 LOCAL 执行，工具会被派到没有实现的桌面端。

### 1.3 机会

1. 收件人、读字节、通道发送都已经按 `sessionId` 收口。统一工具先读一次字节，会话副本和通道推送共用这份内存，不必读两遍。
2. 工具结果已经随 `tool_call_result` 推到前端，并作为 TOOL 消息落库。会话副本不必新表、不必新 WebSocket 事件，从结果里的 `delivery` 字段抬到回复区即可。飞书任务在网页上打开时，走的就是这一条渲染。
3. 安卓壳远程加载同一套桌面页面，会话副本做进 desktop 后安卓一起得到。安卓没有 LOCAL。

## 2. 需求描述

### 2.1 要做的（P1）

1. 注册 `send_image`、`send_file`，从工具表移除六个旧名字。旧类收成通道策略，供新工具调用，不再单独注册。
2. 每次发送都写会话副本。会话绑定了微信、飞书或钉钉时，再用同一份字节按该通道现有规则额外推送。限制、错误文案、微信「多联系人拒绝猜测」保持现在的行为。两侧独立成败。
3. 两个新工具进入 `SERVER_ONLY_TOOLS`、`SEND_BYTES_TOOLS`、`RUNTIME_SCOPED_TOOLS`。LOCAL 不再把发送下发给 Electron。
4. 子代理工具列表去掉这两个名字。边路任务保留：副本留在边路回复区，继承了外部通道的再额外推送。
5. 副本写成功后，该轮回复区（折叠步骤之外）显示图片或可下载文件。实时与刷新走同一份工具结果。飞书 / 微信 / 钉钉任务在网页上打开时看得到这张图或这个文件。
6. LOCAL 的本地路径：执行端不在线且服务端读不到文件时，返回明确错误。http(s) URL 不依赖执行端。
7. 提示词、三端展示名、结果摘要、`generate_image` / `edit_image` 的工具提示改为新名字。历史消息里的旧工具名继续显示原来的中文。
8. 文档：changelog 碎片、`skills/mao-cli` 里飞书 / 钉钉 / 桌面手册中涉及发送工具的句子。

### 2.2 不做的

- 不保留旧工具名作为可调用别名。模型再调 `send_wechat_image` 等会得到 Unknown tool。
- 不改 `feishu_download_file`。它仍是飞书通道工具。
- 不给发送加审批卡。现有六个工具没有审批，本期保持。
- 不把图片字节写进助手消息的 `content`，也不写进模型上下文。模型只看到短 JSON。
- 不主动上传工作区里所有图片。只有模型调用 `send_image` / `send_file` 才留副本。正文相对路径图片仍按同日「本地任务正文图片」方案按需读取、不落盘。
- 不放宽各通道自己的大小、格式、钉钉扩展名白名单。通道不接受的文件仍不推过去，会话副本可以留下。
- 不把一条会话的文件再推到用户的其他通道。飞书会话不发微信。
- 不支持一次调用发多张图或多个文件。
- 不把子代理的发送改投到父会话。子代理直接没有这两个工具。
- 不做管理端附件网格。管理端继续用工具摘要里的文件名；部分成功时摘要带上原因。
- 不迁移历史 `tool_calls`。

### 2.3 用户看到的结果

飞书会话里 Agent 发送一张图片：

- 飞书聊天收到这张图。
- 网页、桌面或安卓打开这条任务，该轮回复下方有同一张图。
- 图超过飞书 10MB、飞书推送失败时，网页上的图还在。工具结果写明「已放入当前对话，飞书发送失败：…」。
- 飞书已发出、副本没写上时，工具结果写明「已发到飞书，对话页保存失败：…」。网页上没有图。
- 结果里已经有 `delivery`，或 `channelStatus` 为 `sent` 时，模型不再把同一文件发一次。

没有外部通道的桌面 / 网页 / 安卓会话只做副本，不推送。

## 3. 技术选型（待评审确认后定案）

| # | 决策点 | 拟定 | 理由 |
|---|---|---|---|
| D1 | 工具面 | **两个工具。会话副本必做，通道策略按绑定附加** | 备选「一个工具用 `kind=image\|file`」被否：图片和文件的参数、格式校验不同。备选「六个旧工具互斥，桌面另加两个」被否：飞书任务在网页上打开时看不到图 |
| D2 | 推送目标 | **副本始终写。外部通道按 `projectKey` / `workspace` 判定，顺序为微信、钉钉、飞书；没有则为 `chat`，不推送** | 与 `filterToolsForSession` 的判定一致（`harness-service.ts:739-750`）。参数里不接受通道名。不向其他通道扩散 |
| D3 | 执行位置 | **两个工具都放进 `SERVER_ONLY_TOOLS`**，并留在 `SEND_BYTES_TOOLS`、`RUNTIME_SCOPED_TOOLS` | 飞书 / 钉钉今天不在 `SERVER_ONLY_TOOLS`，LOCAL 会误派发（`tool-dispatcher.ts:327`）。读字节仍要按轮快照的 `agentId` 进容器（`:465-480`） |
| D4 | 子代理 | **加入 `SUBAGENT_EXCLUDED_TOOLS`，不改投父会话** | 子会话继承父通道身份（`subagent-invocation.service.ts:42-44`）。若允许发送，微信分支在「账号只有一个联系人」时会真的发到用户微信（`media-tool-support.ts:47-56`）。子代理没有自己的对话页。边路任务是用户正在看的会话，不排除 |
| D5 | 副本的事实来源 | **工具结果里的 `delivery` 对象**。不新写消息列，不新发 WebSocket 事件 | TOOL 消息已经落库，`tool_call_result` 已经推到前端。再写 `metadata.deliveries` 要赶在最终助手消息插入之后合并（`persistFinalAssistant` 现把 metadata 写成 null，`harness-service.ts:227-245`），中止时还会丢。结果 JSON 在工具返回时就在 |
| D6 | 对话页位置 | **从本轮全部工具结果收集 `delivery`，画在最终回复下方、文件变更面板同一层**（折叠区之外） | 只画在工具卡旁边会被 `ChatRoundList` 折进「已执行 N 个步骤」。文件变更已经是这个位置（`ChatRoundList.vue:75-79`）。飞书任务的网页页用的是同一套轮次组件 |
| D7 | 副本落点 | **所有会话都写入 `uploads/{userId}/`，URL 口径与文生图相同** | 网页和安卓要在执行端离线、也不打开飞书的情况下仍能看。复用 `materializeImageApiResult` 的目录与 origin 拼接（`generate-image-tool.ts:69-79`），文件名用新前缀 `send-` |
| D8 | 两侧成败 | **独立。`success` 在至少一侧成功时为 true；`error` 只在有一侧失败时出现** | 飞书超限不应抹掉网页上的图，网页落盘失败也不应假装飞书没发出去。模型靠 `delivery` / `channelStatus` 知道哪一侧已经完成，避免重发 |
| D9 | 副本上限 | **图片 20MB，格式取三通道并集；文件 30MB，不限制扩展名** | 文件 30MB 对齐飞书文件上限，图片 20MB 对齐微信 / 钉钉图片上限。通道合法的载荷都能留在会话里。通道推送仍用自己更严的规则 |
| D10 | LOCAL 读本地路径 | **服务端先走现有 `loadSendFileBytes`；读不到且 `executionMode === 'LOCAL'` 时，向绑定执行端要字节，再落盘并按需推送** | 容器 / 云端工作区已经能读。本机文件只在执行端上。http(s) 不走这条。执行端离线则工具返回错误，不挂起 |
| D11 | LOCAL 传输 | **自带 `delivery_fetch` / `delivery_fetch_result`，512KB 原始字节一片** | 与同日正文图片方案的分片约束相同：序列化后要低于 mao-agent 900KB 截断，也要低于服务端 1MB（`attach-websocket.ts:19`）。不复用尚未落地的 `file_fetch`，避免和「只读图片、不落盘」绑死。那份方案落地后，读字节实现可以合并，本方案的落盘语义不变 |
| D12 | 无进展签名 | **只取 `success`、`channel`、`channelStatus`、`filename`** | `delivery.url` 含随机文件名。签名若带上 URL，同一次发送会被当成有进展。带上 `channelStatus` 后，第一次通道失败、第二次通道成功，算有进展 |
| D13 | 历史展示 | **三端 `toolDisplay` 与摘要保留六个旧名字的中文** | 已落库的 `tool_calls` 不迁移。新调用只产生新名字 |
| D14 | 提示 | **工具描述写「会话里总能看到，绑定的通道再推一份」；系统提示补本通道的额外限制** | 描述若写死某一通道的上限，没有通道的会话会被误导。飞书 10MB、钉钉扩展名这类更严的规则放在通道节 |
| D15 | 安卓 / 嵌入浮窗 | **渲染会话副本，安卓零原生改动** | 页面是同一套 desktop。嵌入浮窗的 `page_*` 过滤不动。会话若同时绑了外部通道，推送仍由服务端做 |

## 4. 工具契约

### 4.1 参数

`send_image`：

| 字段 | 约束 |
|---|---|
| `image` | 必填。工作区相对路径，或允许集内的绝对路径（会话工作区、本人 `uploads/{userId}`、runtime、HOME、`/tmp`），或 http(s) URL |

`send_file`：

| 字段 | 约束 |
|---|---|
| `file` | 必填。来源口径与 `image` 相同 |
| `filename` | 可选。发给对方或展示时用的文件名。空串视为未传，回落到路径 basename，再回落到 `file` |

微信展示预览今天读的是 `file_name`（`desktop/src/utils/toolDisplay.ts:141-144`），飞书 / 钉钉读的是 `filename`。新工具只认 `filename`。旧名字的预览分支保留，供历史记录。

两侧都成功、且没有外部通道：

```json
{
  "success": true,
  "channel": "chat",
  "channelStatus": "skipped",
  "filename": "季度报告.pdf",
  "delivery": { "kind": "file", "url": "https://host/uploads/7/send-….pdf", "mime": "application/pdf", "bytes": 1234 }
}
```

两侧都成功、飞书会话：`channel` 为 `feishu`，`channelStatus` 为 `sent`，同样带 `delivery`。微信、钉钉把 `channel` 换成 `wechat`、`dingtalk`。

副本成功、飞书推送失败：

```json
{
  "success": true,
  "channel": "feishu",
  "channelStatus": "failed",
  "filename": "图.png",
  "delivery": { "kind": "image", "url": "https://host/uploads/7/send-….png", "mime": "image/png", "bytes": 15000000 },
  "error": "已放入当前对话，飞书发送失败：图片超过 10MB 上限"
}
```

副本失败、飞书已发出：没有 `delivery`，`channelStatus` 为 `sent`，`success` 仍为 true，`error` 为「已发到飞书，对话页保存失败：…」。

两侧都失败：`success` 为 false，没有 `delivery`，`channelStatus` 为 `failed`（无外部通道时为 `skipped`），`error` 写明两侧原因。读字节本身失败时还没有两侧，只返回 `{ "error": "…" }`，例如「执行端不在线，无法读取本机文件」。

通道失败时，冒号后面的句子沿用该通道现有文案（格式、超限、未绑定、多联系人拒绝猜测）。「当前会话不是飞书通道会话」这类句子不再出现：没绑定的会话不会去调飞书。

### 4.2 限制

会话副本（所有会话）：

| 种类 | 限制 |
|---|---|
| 图片 | PNG/JPG/JPEG/GIF/WebP/BMP，20MB |
| 文件 | 不限制扩展名，30MB |

通道推送在副本之外另做一遍自己的校验，不放宽：

| 通道 | 图片 | 文件 |
|---|---|---|
| 微信 | PNG/JPG/JPEG/GIF/WebP，20MB。未绑定，或未绑对端且联系人多于一个：推送失败，不猜测 | 20MB |
| 飞书 | 同上格式，10MB。私聊给该用户，群聊进该群 | 30MB |
| 钉钉 | PNG/JPG/JPEG/GIF/BMP，20MB。私聊给该用户，群聊进该群 | 扩展名仅 `xlsx/pdf/zip/rar/doc/docx`，20MB |

副本上限取各通道的最大值：文件 30MB 来自飞书，图片 20MB 来自微信和钉钉。这样通道能收下的文件，会话里也留得下。通道更严的那一档只让推送失败，例如 15MB 的图、WebP 发到钉钉、`.txt` 发到钉钉：网页上有，通道结果是失败。

策略内部继续调用现有的上传与发送函数（微信 CDN、飞书 image_key/file_key、钉钉 media）。不重写协议。

### 4.3 执行顺序

```
session = load(sessionId)          // 不存在 → { error: "当前会话不存在，无法发送" }
bytes   = loadSendFileBytes(...)   // 读失败 → 只有 error，不落盘、不推送
copy    = saveTranscript(bytes)    // 按 §4.2 副本上限；成功则带 delivery
channel = wechat | dingtalk | feishu | chat
push    = channel == chat ? skipped : pushChannel(channel, bytes)
return combine(copy, push)
```

判定函数已有，不另写一套正则。顺序与 `filterToolsForSession` 一致：先微信，再钉钉，再飞书。一条会话最多一个外部通道。

边路任务继承父会话的 `projectKey` / `workspace`（`streaming-ws-handler.ts:1459`）。副本画在边路自己的回复区。父会话是飞书时，边路再额外推到飞书；父会话是桌面任务时，`channelStatus` 为 `skipped`。

### 4.4 子代理

`SUBAGENT_EXCLUDED_TOOLS` 改为 `ask_user_questions`、`send_image`、`send_file`。删掉两个钉钉旧名。`buildSubContext` 与 `buildRetryContext` 都走这一个集合（`background-subagent-manager.ts:1047-1053`、`:1065-1078`），重试路径不会把工具交回来。

过滤发生在 `buildContext` 之后，所以子会话即使继承了微信 `projectKey`、过滤函数本会留下发送工具，这里仍会拿掉。

## 5. 会话副本

### 5.1 落盘

读字节成功之后、通道推送之前或之后都可以写副本，两侧互不等待。实现上先写副本再推送，这样通道失败时 `delivery` 已经确定。

1. 字节已经在内存（`loadSendFileBytes` 或 §6 的执行端回传）。读取上限等于副本上限：图片 20MB，文件 30MB。
2. 副本校验通过后写入 `uploads/{userId}/send-{uuid}{ext}`。`userId` 用运行身份（与 `RUNTIME_SCOPED_TOOLS` 一致）。`userId` 为空时退到平坦 `uploads/`，与文生图相同。
3. URL 用 `toStaticUploadBase` 的 origin + `/uploads/{userId}/文件名`。origin 为空时视为副本失败，`error` 说明对话页没有可打开的地址；通道推送仍照常尝试。
4. 工具结果带上 §4.1 的 `delivery`。不要把 base64 放进结果，避免工具消息和压缩归档膨胀（现有 `admin-message-compact` 会剥 `data_uri`，这里从源头不写）。

副本校验失败（超限、图片格式不在并集里）时不写文件，`delivery` 不出现，通道推送仍用同一份字节按通道自己的规则尝试。通道往往更严，这种情况下两侧通常一起失败。

### 5.2 前端

`useMessageRounds` 在组装一轮时，扫描该轮步骤和最终回复上的工具调用：名字是 `send_image` 或 `send_file`，结果 JSON 能解析且含 `delivery.url`。按调用顺序收成 `round.deliveries`。飞书、微信、钉钉会话在网页上打开时走同一条路径。

渲染放在 `ChatRoundList` 最终回复气泡之后、`FileChangePanel` 之前。进行中的轮次同样收集，`tool_call_result` 一到就出现，不等本轮结束。

- `kind === 'image'`：`el-image`，可预览。与用户消息图片同一交互。
- `kind === 'file'`：链接，文案为 `filename`，`href` 为 `url`。不用现在用户消息上那个只有名字、不能点的 `el-tag`（`MessageBubble.vue:191-196`）。
- 工具卡保留。卡头仍是「发送图片 / 发送文件 + 文件名」。附件是给用户看的，工具卡是过程记录。部分成功时摘要里带 `error`，展开步骤能看到飞书没发出去。
- 分享页使用同一轮次组件时一并带上。不单做分享协议。

管理端会话详情继续显示摘要文本。部分成功时摘要含原因，不新增网格。

### 5.3 无进展判定

`no-progress-notice.ts` 为这两个工具单独取语义字段：`success`、`channel`、`channelStatus`、`filename`。丢掉 `delivery` 和 `error`。同一文件连发两次、两侧结果相同，视为无进展。第一次通道失败、第二次 `channelStatus` 变成 `sent`，视为有进展。

`VOLATILE_RESULT_KEYS` 是全局键，不把 `url` 放进去，避免别的工具的 `url` 被一起剥掉。

### 5.4 摘要

`tool-result-summarizer.ts`：

| 结果 | 摘要 |
|---|---|
| `success === true` 且无 `error` | `发送图片: {filename} (成功)` |
| `success === true` 且有 `error` | `发送图片: {filename} (部分成功: {error})` |
| `success === false` 或只有 `error` | `发送图片: {filename} (失败: {error})` |

`send_file` 把「发送图片」换成「发送文件」。六个旧 `case` 留着，历史记录不变。

## 6. LOCAL 读字节

### 6.1 何时向执行端要

`loadSendFileBytes` 的顺序不变：跨成员预检、http(s) 下载、容器 `read_bytes`、宿主机严格读取。

仅当同时满足时才向执行端要字节：

- 会话 `executionMode === 'LOCAL'`
- 来源不是 http(s)
- 容器与宿主机都没有读到这份文件（容器用户读失败仍按现在的方式抛错，不把「容器里没有」降级成「再去执行端找」）

CLOUD 会话不走 `delivery_fetch`。安卓会话都是 CLOUD。读失败时还没有副本，也还没有通道推送。

### 6.2 帧

与同日正文图片方案的传输约束对齐，消息名分开，避免和「不落盘的图片预览」混用。

| 帧 | 形状 |
|---|---|
| 服务端 → 执行端 `delivery_fetch` | `{ type, sessionId, data: { requestId, path, workspace, maxBytes } }` |
| 执行端 → 服务端 `delivery_fetch_result` | `{ type, sessionId, requestId, seq, total, data }`，`data` 为该片 base64，`seq` 从 1 起 |

常量：每片 512KB 原始字节（base64 后约 699KB，低于 900KB 与 1MB）；单文件上限取副本上限（图片 20MB，文件 30MB），超限在发起拉取前拒绝；总超时 20 秒。投递落空、执行端未连接、超时，工具返回 `{ "error": "执行端不在线，无法读取本机文件" }`，不挂起本轮。

执行端校验：相对路径或「解析后仍在该会话 workspace / 允许根内」的绝对路径、普通文件、非符号链接、不超过 `maxBytes`。失败只打日志，不回错误帧（未绑定会话会广播给该用户的多个执行端，错误帧会抢先毁掉合法分片）。服务端靠超时收口。拼装规则与正文图片方案相同：首片锁定来源连接，异源分片丢掉。

桌面走新 IPC：`workspace + path` 在主进程里拼路径并做 containment，再复用现有 `localFileBytes.cjs` 的普通文件 / 符号链接校验。不复用按绝对路径直通的 `local-read-bytes`。

mao-agent 在 `executor.ts` 增加 `delivery_fetch` 分支，先过现有 `resolveWorkspace` 信任收窄。旧客户端不认识该帧就忽略，服务端超时后返回上面的错误。发布顺序：backend → desktop dist → agent-cli。旧执行端连新后端时，LOCAL 本地路径发送失败并说明原因；http(s) 与 CLOUD 不受影响。

### 6.3 和正文图片方案的边界

| | 正文相对路径图片 | `send_image` / `send_file` |
|---|---|---|
| 谁触发 | 页面渲染 Markdown | 模型显式调用 |
| 字节是否留在服务器 | 否，看完即弃 | 每次发送都留一份在 `uploads/{userId}/` |
| 执行端离线 | 显示 📎 | 工具失败，对话里没有半份附件，通道也不推 |
| 文件类型 | 图片白名单 | 图片或任意文件（受 §4.2 副本上限限制） |

两套帧可以并存。读路径上的 containment 以后可以抽成同一个函数，本期不把两份方案做成互相阻塞的前置。

## 7. 提示词

工具描述（稳定，不写某一通道的数字）：

- `send_image`：把一张图片发到当前会话。网页、桌面、安卓打开这条会话时，图片出现在该轮回复下方。这条会话若绑定了微信、飞书或钉钉，同一张图再发给对应的用户或群。`image` 为本地路径或 http(s) URL。结果含 `error` 时，向用户说明原因。结果里已有 `delivery`，或 `channelStatus` 为 `sent` 的那一侧已经完成，不要把同一张图再发一次。
- `send_file`：同上，对象是文件。`filename` 可选。

系统提示替换现在的「微信媒体发送」节（`prompt-engine.ts:839-846`）。两个新工具在列表里才注入。无外部通道时写「图片和文件出现在这条对话里，文字仍用正常回复」。有外部通道时再补该通道比副本更严的限制，例如飞书图片 10MB、钉钉文件扩展名白名单，并写明不符合时对话里仍能看到、通道不会收到。删掉只认 `send_wechat_*` 的 `WEIXIN_MEDIA_TOOL_NAMES`。

`generate_image`、`edit_image` 的 `getToolPrompt` 里「可交给 send_wechat_image / feishu_send_image / dingtalk_send_image」改为「可把 `image_path` 交给 `send_image`」。

## 8. 实现步骤

### 8.1 后端

1. 新增 `send-media-tool.ts`：`SendImageTool`、`SendFileTool`。构造函数吃现有的微信 / 飞书 / 钉钉 support，以及会话副本落盘函数。`executeWithUser` 按 §4.3：读一次字节，写副本，再按绑定调用通道策略。六个旧类的发送逻辑移进策略，类本身删除，避免两套入口。
2. `tool-registry.ts` 改为注册两个新工具。`feishu_download_file` 不动。
3. `tool-dispatcher.ts`：`SERVER_ONLY_TOOLS`、`SEND_BYTES_TOOLS`、`RUNTIME_SCOPED_TOOLS` 换成新名字。确认 `dispatchWithRoundAgent` 仍包住它们。
4. `filterToolsForSession` 不再按通道标记剔除发送工具（标记随旧类一起消失）。`feishu_download_file` 的飞书标记保留，过滤逻辑保留。
5. `SUBAGENT_EXCLUDED_TOOLS` 按 §4.4 修改。
6. 会话副本落盘与 `delivery` / `channelStatus`。LOCAL 的 `delivery_fetch` 放在 `harness/local/`，复用 `LocalToolSessionRegistry` 的 future / 断线失败，不进审批、不进工具时间线。
7. `prompt-engine.ts`、`generate-image-tool.ts`、`edit-image-tool.ts` 的提示。
8. `tool-result-summarizer.ts` 按 §5.4。六个旧 `case` 留着。
9. `no-progress-notice.ts` 按 §5.3 归一化。

### 8.2 前端

1. `useMessageRounds` 收集 `delivery`。`ChatRoundList` 在最终回复下渲染 `ChatDeliveryBar`（图片网格 + 文件链接）。进行中轮次用同一组件。通道会话与普通会话共用，不按 `projectKey` 分支。
2. `desktop/src/utils/toolDisplay.ts` 增加 `send_image`（「发送图片」，预览 `image`）、`send_file`（「发送文件」，预览 `filename` 否则 `file`）。六个旧分支保留。
3. 桌面 `useStreamWS` 增加 `delivery_fetch`：收帧后走新 IPC，按片回传。
4. `admin` 与 `sdk/embed` 的 `toolDisplay.ts` 同步新名字和旧名字。嵌入页使用 desktop 的对话组件，投递条不用在 sdk 再写一份。管理端不渲染投递条。

### 8.3 mao-agent

`executor.ts` 增加 `delivery_fetch`。信任收窄、containment、分片、失败不回包。旧 CLI 忽略未知帧。

### 8.4 文档

- `changelog/unreleased/2026-11-18-unified-send-media.md`：后端、前端（桌面 / Web / 安卓）、终端 CLI（mao-agent，仅 LOCAL 读字节需要升级）。写明通道会话在网页上也能看到已发送的图片和文件。
- `skills/mao-cli/reference/feishu-bot.md`、`dingtalk-bot.md`：工具名改为 `send_image` / `send_file`。写明会推到该通道，同时留在会话里，网页打开同一任务看得到。
- 桌面手册补一句：对话里可以让 Agent 把图片或文件发到当前回复下方；LOCAL 需要本机执行端在线。

## 9. 测试

后端：

- 飞书会话发图片：副本写入 `uploads/{userId}/`，结果含 `delivery`，并且飞书 `sendImage` 被调用一次。微信、钉钉策略不被调用。微信、钉钉、无通道会话各有对称用例。
- 飞书图片超过 10MB、未超过副本 20MB：`success === true`，有 `delivery`，`channelStatus === "failed"`，`error` 以「已放入当前对话，飞书发送失败：」开头。飞书发送函数不被调用（校验在推送前失败）或被调用后返回原错误，二者择一写死，测试锁定选定的那一种。
- 副本落盘抛错、飞书发送成功：无 `delivery`，`channelStatus === "sent"`，`error` 以「已发到飞书，对话页保存失败：」开头。
- 微信多联系人拒绝猜测：副本仍在，`channelStatus === "failed"`，错误句子与现在一致。钉钉非法扩展名同样：副本在，推送失败。
- 无通道会话：不调用三个通道策略，`channel === "chat"`，`channelStatus === "skipped"`。
- 读字节失败：无 `delivery`，通道策略不被调用。
- LOCAL + 非 `SERVER_ONLY` 的回归：`send_image` 在 LOCAL 会话不进入 `localToolExecutor`。
- 容器用户：`dispatchWithRoundAgent` 把本轮 `agentId` 传进 `readBytes`，不读库里可能已切换的会话 Agent。
- 子代理上下文的工具名不含 `send_image` / `send_file`。边路会话的飞书父会话会推飞书，桌面父会话的边路 `channelStatus` 为 `skipped`。
- 结果里没有 base64。
- 无进展：同一 `filename` + 相同 `channelStatus`、不同 `url` 视为无进展；`channelStatus` 从 `failed` 变为 `sent` 视为有进展。
- 摘要：成功、部分成功、失败、缺参；旧名字的既有用例不删。

前端：

- 飞书会话的一轮里工具步骤被折叠时，`delivery` 仍出现在最终回复下方。
- 图片可预览，文件链接的 href 是 `url`、文字是 `filename`。
- `tool_call_result` 到达后、本轮尚未结束时，投递条已经出现。
- `toolDisplay`：新名字预览；`send_wechat_file` 的历史 `file_name` 预览仍在。

执行端：

- 桌面 containment：workspace 外路径不回包。
- 分片序列化长度低于 1MB。
- 执行端离线时工具错误为「执行端不在线，无法读取本机文件」，不写副本，不推送。CLOUD 会话不发 `delivery_fetch`。

## 10. 发布

backend 先上。此后云端会话的副本和通道推送即可用；旧桌面 dist 能显示工具卡和摘要，但没有回复区的图，LOCAL 本机路径在执行端升级前会失败并给出原因。接着发布 desktop dist（网页、Electron、安卓壳一起）。mao-agent 仅 LOCAL 且文件在本机时需要新版本。

历史会话无迁移。旧工具调用继续显示「发送微信图片」等原中文名。那些历史调用没有 `delivery`，网页上仍然只有工具卡。
