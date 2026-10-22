# 聊天图片 URL 注入技术方案

> 状态：已与需求方达成共识，待评审
> 适用代码库：`backend-ts/`（NestJS + Fastify + TypeScript），前端零改动
> 文档日期：2026-10-22

## 1. 需求背景

用户在输入框粘贴图片发送后，Agent 只能通过多模态视觉通道「看到」图片内容，**无法获取文件本体**。典型失败场景：用户发送建筑图纸并说「帮我转成 CAD 格式」，Agent 想找文件却报「上传目录没找到」——因为图片文件既不在会话工作区、也不在 PathSandbox 允许根内，模型上下文里更没有任何可用的文件地址。

根因是两段设计叠加的结果：

1. **URL 到不了模型手里**。消息中的图片以 `{type:'image_url', image_url:{url}}` part 存储；LlmAdapter 在发请求前会下载图片并**原地把 URL 替换为 base64 data URI**（`openai-llm-adapter.ts:539-556` + `setImageUrl` L805-812；Anthropic 适配器只认 data URI）。只有下载失败时才保留原 URL。即正常路径下模型看到的是 base64 数据块，不是可寻址的 URL。
2. **文件本体对工具链不可见**。图片落在后端扁平目录 `./uploads/{uuid}.png`（local 模式）或 OSS（OSS 模式浏览器直传、服务端不落盘），不在会话工作区、不在沙箱允许根，Agent 的 shell / 文件工具都摸不到。

对照：非图片文件走的是另一套成熟机制——`/files/upload-incoming` 落 `runtime/{userId}/{sessionId}/incoming/`，消息文本带 `@{绝对路径}@` 引用，`prompt-engine.ts:609-622` 有专门的「用户上传的文件」提示节，沙箱已放行 runtime 根。图片缺的正是「把位置告诉 Agent」这一步。

本次目标（需求方已确认）：**把图片 URL 以文本形式注入用户消息**，Agent 需要文件本体时用 shell（curl/wget/python3，运行时容器镜像已内置，见 `Dockerfile.runtime:22-23`）自行下载到工作区。不加系统提示词指引——当前 LLM 足以自行理解 URL 的用途。

## 2. 需求描述（做什么 / 不做什么）

### 2.1 在范围内（本期要做）

| # | 事项 | 说明 |
|---|------|------|
| R1 | 图片 URL 注入用户消息文本 | 组装消息 content parts 时，把图片 URL 以 `[图片 N] <url>` 行追加到文本 part 尾部；序号与图片 part 顺序一一对应 |
| R2 | 单一实现收口 | 新增共享模块承载「剥离既有注入行 + 追加新注入行」，`contentParts` 与 `buildEditContent` 两处 parts 组装逻辑统一走它，消除重复实现 |
| R3 | 覆盖全部消息组装路径 | `send_message`、`edit_and_resend`、边路会话首问、队列插队消费、队列自动消费、`editMessageAndTruncate` 共 6 个组装点全部生效 |
| R4 | 幂等 | 编辑重发时若回传的正文已含注入行（前端编辑框按存储文本回填），先剥离再追加，不得重复堆积 |
| R5 | 纯图片消息也注入 | 无正文仅图片时，生成只含注入行的文本 part（当前实现会完全不建文本 part） |
| R6 | 会话标题剥离 URL 行 | 标题生成读取文本 parts 前剥离注入行，避免 URL 污染标题 |
| R7 | 回归测试 | 新增注入模块单测（幂等 / 空正文 / 序号对应 / 非匹配行不误删），扩展 contentParts、WS handler、session.service、title service 既有用例 |

### 2.2 不在范围内（本期明确不做）

| # | 事项 | 说明 |
|---|------|------|
| N1 | 不加系统提示词指引 | 不在 `prompt-engine.ts` 新增「图片 URL 可用 shell 下载」提示节。信任模型自行判断；实测发现模型经常忽略再补 |
| N2 | 不做服务端物化 | 不把图片下载/复制到 incoming 目录、不加沙箱允许根、不动 `path-sandbox.ts` 与 `create-app.ts` |
| N3 | 前端零改动 | 气泡、编辑框、历史回显照旧；URL 行作为正文自然展示，不做隐藏/美化 |
| N4 | 不做相对 URL 补全 | local 模式未配 `upload.baseUrl` 时消息存的是相对路径 `/uploads/xxx.png`，注入的 URL 无法 curl。本期仅文档化该依赖并给出上线前核验步骤；服务端补全（有 `file.routes.ts` 的 `getUploadBaseUrl` 先例）作为可选加固，需要时再排 |
| N5 | 不新增下载工具 | 不封装 `download_file` 内置工具。作为兜底升级路径预留，shell 方案实测不稳再做 |
| N6 | 不动非视觉模型占位符逻辑 | `replaceImagesWithPlaceholder` 维持现状 |
| N7 | 不做存量消息处理 | 改造前存储的消息没有 URL 行，继续走原视觉通道，无迁移 |

### 2.3 用户侧使用流程（目标体验）

1. 用户粘贴图片并附一句「帮我转成 CAD」发送；
2. 消息落库：文本 part = 用户正文 + `[图片 1] <url>` 行，图片 part 不变（视觉通道零回归）；
3. Agent 首轮照常「看图」理解需求；当任务需要文件本体（格式转换、像素处理）时，自行用 shell 把 URL 下载到工作区（如 `curl -o drawing.png <url>`），再按本地路径用文件工具/脚本处理；
4. 历史消息重放、编辑重发、队列消费场景下 URL 行始终存在且不重复。

## 3. 现状梳理（存量实现）

### 3.1 图片上传与消息链路

- **前端**：`ChatInput.vue` 粘贴 → `useChat.ts` `uploadChatImages()` → `imageUpload.ts` 双分支——local 模式 `POST /files/upload` 落 `./uploads/{uuid}.png` 返回 `/uploads/{storedName}`（配了 `upload.baseUrl` 则为绝对地址）；OSS 模式 `POST /oss/sts-token` 后浏览器直传，返回公网绝对 URL。WS `send_message` 携带 `data.images: string[]`。
- **后端**：`streaming-ws-handler.ts` 收 `images` → 视觉模型校验（`supportsVision !== 1` 拒绝、≤10 张）→ `contentParts(content, images)` 组装 parts → `sessionService.saveMessage()` 存 `message.content`（MEDIUMTEXT JSON）。
- **上下文重建**：`session-history-loader.ts` `parseContent()` 把 JSON parts 数组原样还原为多模态 content，随 `buildContext()` 进入 LLM 请求。
- **视觉通道**：适配器下载图片转 base64（成功即替换 URL，失败保留原 URL）。

### 3.2 消息 parts 组装的 6 个落点（本期全部收口）

| # | 位置 | 场景 |
|---|------|------|
| 1 | `streaming-ws-handler.ts:590` | `send_message` 手动发送 |
| 2 | `streaming-ws-handler.ts:909` | `edit_and_resend` 编辑重发 |
| 3 | `streaming-ws-handler.ts:1092` | 边路会话（Side Task）首问 |
| 4 | `streaming-ws-handler.ts:1662` | 队列插队消费 |
| 5 | `streaming-ws-handler.ts:1870` | 队列自动消费 |
| 6 | `session.service.ts:1600` `buildEditContent()` | `editMessageAndTruncate()` 落库（与 #2 同流程，独立实现，需一并收口） |

其中 #4/#5 的 `content` 来自队列行（原始用户正文，无注入行），注入发生在消费落库时；消费后调用 `handleSendMessage` 带 `autoSavedMessageId` 跳过二次落库，不会重复注入。

### 3.3 编辑回填链路（幂等需求的由来）

前端 `MessageBubble.vue:344-355` 编辑态用 `props.message.content`（API 返回的拼接文本，含注入行）回填 textarea；`useChat.ts:669` 保留原消息图片后经 `edit_and_resend` 回传。服务端若不剥离，编辑一次就多出一套 URL 行。

### 3.4 标题生成链路

`session-title.service.ts:251-259` `extractText()` 拼接文本 parts 生成标题输入。注入行带入会让标题出现 URL 片段，需剥离。

### 3.5 执行环境

CLOUD 宿主模式即后端服务器；容器模式镜像 `node:22-bookworm-slim` 明确安装 `curl` 与 `python3`/`python3-pip`（`Dockerfile.runtime:19-24`）。shell 下载的可行性无环境障碍。

## 4. 技术决策（已确认）

| 决策点 | 结论 |
|--------|------|
| 注入位置 | 消息**文本 part 尾部**（存储即注入）。历史重放、压缩摘要、导出天然继承；不选 prompt 构建期注入（需扫描全部消息 parts，改动更大且与存储态不一致） |
| 注入格式 | 每图一行 `[图片 N] <url>`，与正文之间空一行；N 从 1 起，与图片 parts 顺序对应 |
| 空正文纯图片 | 生成只含注入行的文本 part（必须，否则纯图消息没有 URL 通道） |
| 幂等方式 | strip-then-append：行首锚定的整行正则剥离既有注入行后再追加 |
| 代码组织 | 新增 `session/util/image-url-annotation.ts` 导出 `stripImageUrlLines` / `appendImageUrlLines` / `buildUserContentParts`；`contentParts` 与 `buildEditContent` 改为委托，消除 #6 的重复实现 |
| 提示词 | 不加（需求方决策，信任模型） |
| 标题 | `extractText` 剥离注入行 |
| 前端 | 零改动 |
| URL 形态 | 原样使用消息里的 URL（与视觉通道同源）；local 模式依赖 `upload.baseUrl` 已配置为绝对地址，上线前核验 |

## 5. 详细设计

### 5.1 新增注入模块 `backend-ts/src/session/util/image-url-annotation.ts`

```ts
/** 注入行前缀。对用户可见（气泡/导出），保持可读；序号与图片 parts 顺序对应。 */
const IMAGE_URL_LINE_PREFIX = '[图片 ';
/** 既有注入行：行首锚定 + 整行锚定，只剥自己生成的格式，不碰用户正文。 */
const IMAGE_URL_LINE_PATTERN = /^\[图片 \d+\] \S+$/gm;

/** 剥离全部注入行，并收敛行尾多余空行（剥离后正文以单个换行结尾或为空）。 */
export function stripImageUrlLines(text: string): string;

/** 先剥离再追加：编辑重发回传已含注入行的正文时结果不变（幂等）。 */
export function appendImageUrlLines(text: string, images: readonly string[]): string;

/** 统一的用户消息 parts 组装：文本 part 带注入行 + 图片 parts。 */
export function buildUserContentParts(text: string, images: readonly string[]): ContentPart[];
```

行为规格：

- `appendImageUrlLines('帮我转成CAD', ['https://a.png'])` → `'帮我转成CAD\n\n[图片 1] https://a.png'`；
- `appendImageUrlLines('', ['https://a.png','https://b.png'])` → `'[图片 1] https://a.png\n[图片 2] https://b.png'`（无前导空行）；
- `appendImageUrlLines('上文\n\n[图片 1] https://a.png', ['https://a.png'])` → 与首次注入结果完全一致（幂等）；
- `images` 为空时原样返回 `text`（纯文本消息零变化）；
- `stripImageUrlLines` 不匹配普通正文行（如用户手打 `[图片 1]` 后接非 URL 内容不会被误删——正则要求 `\S+` 且无空格，URL 形态才匹配；碰撞概率与格式可读性之间取平衡，风险登记入 §7）。

### 5.2 `ws-streaming-event-listener.ts` `contentParts` 改造（L383-392）

```ts
// 改造后：委托统一实现，行为 = 原 parts 组装 + URL 注入
export function contentParts(text: string, images: string[]): ContentPart[] {
  return buildUserContentParts(text, images);
}
```

函数签名与导出位置不变，`streaming-ws-handler.ts` 的 5 个调用点（§3.2 #1-#5）零改动即全部获得注入能力。

### 5.3 `session.service.ts` `buildEditContent` 改造（L1600-1613）

```ts
function buildEditContent(text: string | null, images: string[] | null): string | null {
  if (images == null || images.length === 0) return text;
  try {
    return JSON.stringify(buildUserContentParts(text ?? '', images));
  } catch {
    return text;
  }
}
```

删除本地重复的 parts 拼接；幂等由共享模块保证（编辑回传的正文含旧注入行 → 先剥离再追加）。

### 5.4 标题服务剥离（`session-title.service.ts` L251-259）

`extractText()` 对每个文本 part 先过 `stripImageUrlLines` 再拼接：

```ts
return content
  .filter((item) => item.type === 'text' && item.text != null)
  .map((item) => stripImageUrlLines(String(item.text)))
  .filter((t) => t.trim() !== '')
  .join('\n');
```

### 5.5 落库内容示例

发送「这个图片能帮我转成CAD格式的文件？」+ 1 张图（local 模式、baseUrl 已配）：

```json
[
  {"type":"text","text":"这个图片能帮我转成CAD格式的文件？\n\n[图片 1] https://mao.etarch.cn/uploads/3f2a….png"},
  {"type":"image_url","image_url":{"url":"https://mao.etarch.cn/uploads/3f2a….png"}}
]
```

发给 LLM 时：文本 part 原样进入 messages（URL 可见、可 curl）；图片 part 被适配器替换为 base64 data URI（视觉通道不变）。模型在同一消息里既「看到图」又「拿到地址」。

### 5.6 边界与兼容性

| 场景 | 行为 |
|------|------|
| 纯文本消息（无图） | 完全不走注入分支，`content` 与现状逐字节一致 |
| 纯图片消息（无正文） | 新增只含注入行的文本 part；`isMultimodalContentParts` 判定不受影响（text part 合法） |
| 编辑重发（图片不变） | 剥离旧行 + 追加相同 URL，结果与编辑前一致；前端回填文本与落库文本一致 |
| 编辑时用户手改正文 | 只影响非注入行；注入行按当前 images 重建 |
| 队列消息 | 队列行存原始正文；消费落库时注入一次；`autoSavedMessageId` 防二次落库 |
| 边路会话 / fork | 走同一 `contentParts`，自动覆盖 |
| `user_message_saved` 广播 | `userMessagePayloadOf` 提取的 content 含注入行；发送端本地乐观消息仍是原始正文（刷新后一致），纯展示差异 |
| 历史消息（改造前） | 无 URL 行，视觉通道原样工作，无回归 |
| 非视觉模型 | 维持占位符替换，不扩展 |
| OSS 模式 | URL 为公网绝对地址，curl 直接可用 |
| local 模式未配 baseUrl | 注入的是相对路径，curl 不可用——上线前核验配置（§7） |

## 6. 实现步骤（Checklist）

### 后端（backend-ts）

- [ ] 新增 `src/session/util/image-url-annotation.ts`（`stripImageUrlLines` / `appendImageUrlLines` / `buildUserContentParts`）
- [ ] `src/session/ws/ws-streaming-event-listener.ts`：`contentParts` 委托 `buildUserContentParts`
- [ ] `src/session/session.service.ts`：`buildEditContent` 委托 `buildUserContentParts`，删本地拼接
- [ ] `src/session/session-title.service.ts`：`extractText` 剥离注入行
- [ ] 新增 `image-url-annotation.spec.ts`：追加 / 剥离 / 幂等往返 / 空正文 / 多图序号 / 非匹配行保留 / 无 images 零变化
- [ ] 扩展 `ws-streaming-event-listener.spec.ts`：contentParts 注入行；纯图消息生成文本 part
- [ ] 扩展 `streaming-ws-handler.spec.ts`：send_message 落库文本含注入行；edit_and_resend 幂等（回传已含注入行的 content，落库不重复）
- [ ] 扩展 `session.service.spec.ts`：`editMessageAndTruncate` 带图 + 预注入正文不重复
- [ ] 扩展 `session-title.service.spec.ts`（如有标题文本提取用例）：URL 行不进标题
- [ ] `cd backend-ts && npm run build && npm test` 全绿
- [ ] `CHANGELOG.md` 顶部版本 `### 后端` 记录（用户可见的 Agent 行为变化）
- [ ] 上线前核验 local 模式部署的 `upload.baseUrl` 为绝对地址（`GET /api/v1/upload/config`，或确认 storageMode=oss）；未配置则本期仅 OSS/已配 baseUrl 环境生效，或启动 N4 可选加固

### 本期不改动（明确核对）

- `harness/` 下全部文件（适配器、prompt-engine、path-sandbox、container 挂载）
- `create-app.ts`、`Dockerfile.runtime`
- `desktop/`、`admin/`、`android/`、`agent-cli/`

## 7. 风险与注意事项

| 风险 | 说明 | 缓解 |
|------|------|------|
| local 模式相对 URL | 未配 `upload.baseUrl` 时注入的是 `/uploads/xxx.png`，模型 curl 不到（且现状视觉通道的 adapter fetch 同样失败） | 上线前核验配置（步骤清单末项）；可选加固：注入时用 settings 的 `getUploadBaseUrl`（`file.routes.ts:33` 同款依赖）补全为绝对 URL |
| 模型不下载 | 不加提示词，是否 curl 由模型自行判断，存在概率性失败 | 任务明确（要字节）时模型可靠；URL 行与图片同消息、序号对应，降低误判；兜底升级路径：`fetchBytesWithLimits`（`fetch-bytes.ts`，已带双超时与大小上限）包 `download_file` 工具，实测不稳再排 |
| 注入行格式碰撞 | 用户正文恰好出现 `[图片 N] <无空格串>` 形态的行，编辑时会被剥离 | 行首锚定 + 序号 + URL 形态三重约束，碰撞面极小；接受该残余风险 |
| URL 行露出到 UI/导出 | 气泡、会话导出、分享、admin 消息查看会显示 URL 行 | 标题已剥离；气泡展示 URL 属信息正向；前端美化（显示态隐藏）不在本期 |
| 发送端与远端显示不一致 | 发送端乐观消息是原始正文，`user_message_saved` 广播的 content 含注入行 | 纯展示差异，刷新/重进会话即一致；不接受客户端改动的前提下可接受 |
| OSS Bucket 非公共读 | curl 得 403 | 非本期新增风险——浏览器渲染与视觉通道现状已依赖公共读 |
| LOCAL 模式 | 文件工具在桌面执行，curl 需从用户机器访问该 URL | 公网部署天然覆盖；内网部署需确认桌面可访问（登记为已知限制） |

## 8. 验收标准

1. 粘贴图片 + 正文发送后，DB `message.content` 文本 part 尾部含 `[图片 N] <url>` 行（N 与图片 parts 顺序对应），图片 parts 与现状一致。
2. 纯图片（无正文）消息同样生成含 URL 行的文本 part。
3. 编辑重发该消息：落库文本中 URL 行恰好一套（幂等），前端编辑框回填内容与落库内容一致。
4. 队列消息（入队 → 执行/插队/自动消费）落库后 URL 行存在且仅一套。
5. 边路会话首问带图时同样注入。
6. 会话标题生成结果不含 URL。
7. 纯文本消息、无图编辑、历史消息加载零变化（既有用例全绿）。
8. `cd backend-ts && npm run build && npm test` 通过。
9. 人工冒烟（CLOUD 会话）：发图 + 「转成 PNG」，Agent 能自行 shell 下载并用本地路径完成转换；local 模式部署额外确认注入的 URL 为绝对地址。
