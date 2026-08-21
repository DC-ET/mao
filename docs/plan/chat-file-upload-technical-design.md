# 聊天输入区通用文件上传功能 · 技术方案

> 状态：已与需求方对齐，待评审
> 适用代码库：`backend-ts/`（NestJS + Fastify + TypeScript）、`desktop/`（Vue 3 + TipTap + Electron/Web）+ `android/`（Capacitor 壳复用 desktop 前端）
> 文档日期：2026-08-20

## 1. 需求背景

当前聊天输入框的 `+` 按钮仅支持上传图片（`accept="image/*"`），发送时图片以多模态 `image_url` 形式进入 LLM，由模型直接「看图」。用户希望输入区同样支持上传**任意类型的文件**（文档、代码、压缩包、PDF、音视频等），文件上传到服务端 **runtime 临时目录**，并以**文件引用**的方式集成到输入区消息，**由 Agent 自行决定如何结合该文件完成任务**（读取、解析、作为上下文、解压、运行相关命令等）。

核心诉求：文件不必像图片那样强制进入多模态视觉通道，而是作为「工作材料」交给 Agent 工具链，由 Agent 自行读取、加工、产出。

待解决的问题：

- 任意文件目前只能以图片方式上传（`uploads/` 目录 + `file` 表，且前端 `accept` 限定图片）；
- 输入区只能展示图片胶囊，不能展示/引用文件；
- 消息链路（WS 协议、消息内容、Prompt）只能携带图片 URL，无法携带文件引用；
- Agent 工具沙箱（`PathSandbox`）未放行 runtime 目录，工具无法读取上传的临时文件。

## 2. 需求描述（做什么 / 不做什么）

### 2.1 在范围内（本次要做）

| # | 事项 | 说明 |
|---|------|------|
| R1 | 输入区支持上传任意文件 | `+` 按钮由图片限定改为图片/文件统一入口，多选。文件展示为输入区胶囊（含文件图标与名称），并对“与图片上传的差异”做明确区分。 |
| R2 | 文件上传至 runtime 临时目录 | 上传落盘到 `runtime/{userId}/{sessionId}/incoming/`，**会话级隔离**；记录元数据（原文件名、大小、类型、会话归属、URL）。 |
| R3 | 以文件引用文本节点集成到输入区 | 选择文件即**立即上传**，成功后在光标处插入文件引用节点（沿用现有 `fileReference` 节点样式，渲染为 `@{绝对路径}@`），用户可在正文编辑、删除；生成的路径为主 Agent 后续引用文件的依据。 |
| R4 | Agent 通过文件引用读取文件 | 文件绝对路径随消息文本进入 LLM 上下文；**Prompt 明确告知** Agent：上传的文件位于指定路径，需自行判断如何读取、加工、使用（不作为图片多模态）。 |
| R5 | 支持文件拖拽/粘贴上传 | 拖拽文件到输入区、粘贴文件（非图片）均可触发上传并插入引用节点。 |
| R6 | 随会话删除清理 runtime 文件 | 会话删除时级联删除 `runtime/{userId}/{sessionId}/incoming/` 目录。 |
| R7 | 图片上传逻辑保持不动 | 现有图片多模态链路（胶囊 → `images` 字段 → `image_url` parts）完全保留，不回归。 |
| R8 | 主会话 + 边路任务都支持 | `ChatInput.vue`（主会话）与 `SideChatPanel.vue`（边路任务）输入框均支持文件上传与引用。 |

### 2.2 不在范围内（本次明确不做）

| # | 事项 |
|---|------|
| N1 | 不在 LOCAL（本地）模式启用文件上传。LOCAL 模式工具在本机 Electron 执行，天然可访问本机文件，维持现状（本地工作区 + `@` 引用）。 |
| N2 | 不为文件引入新的“附件下载/预览”历史消息能力。文件以 `@{绝对路径}@` 文本节点天然持久化在会话消息里，不做独立附件展示（不在历史消息气泡中渲染可点击附件卡片）。 |
| N3 | 不新建独立 `fileIds` 消息字段。排序后确认采用「仅文本路径」方案。 |
| N4 | 不限制文件类型白/黑名单。**全部文件类型放行**。 |
| N5 | 不限制文件大小与数量。**不做大小/数量上限**（服务端保留 50MB 既有兜底配置，不主动收紧）。 |
| N6 | 图片不改为节点形式。图片仍走 `images` 字段多模态链路。 |
| N7 | 不新增“复制到工作区”能力。临时文件仅存在于 runtime `incoming/`，若 Agent 需要归档/交付，应自行（通过工具）拷贝到工作区。 |
| N8 | 不做定时清理任务。仅随会话删除清理。 |

### 2.3 用户侧使用流程（目标体验）

1. 用户在输入框点击 `+`，选择若干文件（或拖拽/粘贴）；
2. 前端**立即**将文件上传至服务端 runtime `incoming/` 目录，返回文件路径；
3. 上传成功后，在输入框光标处插入文件引用节点（显示文件名，文本为 `@{绝对路径}@`）；
4. 用户可继续补充正文描述，或直接发送；
5. 发送后消息中含文件引用文本，Agent 收到后读取路径对应文件自行处理；
6. 会话删除后，其 runtime `incoming/` 目录被清理。

## 3. 现状梳理（存量实现）

### 3.1 图片上传（现有）

- **前端**
  - `desktop/src/components/chat/ChatInput.vue`：`+` 按钮 `accept="image/*"`；`pendingFiles` 管理待发图片（≤10 张、≤10MB 校验）；发送时 `handleSend` → `emit('send', text, files)`。
  - `desktop/src/composables/useChat.ts`：`sendMessage(text, files)` 调 `uploadChatImages(files)` 上传得到 URL 数组，随后通过 WS `send_message` 的 `images` 字段发送；`uploadChatImages` 内部用 `uploadImages`（`desktop/src/utils/imageUpload.ts`）。
  - `desktop/src/utils/storageMode.ts`：`getUploadConfig()` 拉取 `/upload/config` 判断 `local` / `oss` 存储模式。
  - `desktop/src/utils/ossUpload.ts`：OSS 模式：`normalizeImageForUpload`（补 MIME/扩展名）+ `uploadToOss`。
- **后端**
  - `backend-ts/src/file/file.routes.ts`：`POST /v1/files/upload`（local 模式落盘 + 落库）、`GET /v1/files/workspace-list`、下载/预览等。
  - `backend-ts/src/file/file.service.ts`：`uploadFile()` 写 `uploads/`，`FileEntityRepository` 落 `file` 表，`resolveUploadMime()` 走 `ImageFileSupport`。
  - `backend-ts/src/config/upload.routes.ts`：`GET /v1/upload/config` 返回存储模式。
- **消息链路**
  - `desktop/src/composables/useStreamWS.ts`：`sendMessage()` / `sendEditMessage()` 携带 `data.images`。
  - `backend-ts/src/session/ws/streaming-ws-handler.ts`：`send_message` 事件 → `contentParts(content, images)` 组装 `{type:'text'} + {type:'image_url'}` 多模态 parts → `sessionService.saveMessage()` 持久化。
  - `backend-ts/src/session/ws/ws-streaming-event-listener.ts`：`contentParts()` 拼接文本与图片 parts。
  - `backend-ts/src/harness/llm/`：`OpenAiLlmAdapter` 对 `image_url` part 转 OpenAI 消息格式。

### 3.2 文件引用（现有 `@` 面板）

- `desktop/src/components/chat/tiptap/FileReferenceNode.ts`：inline atom 节点，`renderText` 输出 `@{filePath}@`，`renderHTML` 渲染为 `editor-tag-file` 样式标签。
- `ChatInput.vue` `detectAtTrigger()`：`@` 唤起 `FileReferencePanel`（`/files/workspace-list` 返回会话**工作区**内文件），选中后插入 `fileReference` 节点。
- 说明：现有 `@` 引用的是**会话工作区已有文件**，本方案复用它作为「上传临时文件」的节点载体，但数据源从“工作区文件”扩展为“runtime incoming 上传文件”。

### 3.3 runtime 目录与路径沙箱

- `backend-ts/src/config/app-config.ts`：`harness.runtimeDir` 默认 `/opt/mao-data/runtime`；`RuntimeDataResolver`（`backend-ts/src/harness/runtime/runtime-data-resolver.ts`）提供 `resolveSessionRuntimeDir(userId, sessionId) → runtime/{userId}/{sessionId}`（现有 shellOutput / skills 子目录机制）。
- `backend-ts/src/harness/safety/path-sandbox.ts`：`PathSandbox` 只放行「会话工作区根 / `workspaceRoot`」以及 `addAllowedRoot()` 显式登记根下的路径；runtime 目录**尚未放行**。

## 4. 技术决策（已确认）

| 决策点 | 结论 |
|--------|------|
| 上传存储位置 | 会话级：`runtime/{userId}/{sessionId}/incoming/` |
| 输入区集成形态 | 独立文件引用节点（复用 `fileReference` 节点，文本 `@{path}@`） |
| Agent 获取方式 | 消息中携带文件**绝对路径**文本 + Prompt 说明（由 Agent 自行决定如何读取/加工） |
| 生命周期 | 随会话删除级联清理 `incoming/` 目录 |
| 作用范围 | 仅 CLOUD 模式；LOCAL 维持现状 |
| 覆盖入口 | 主会话 `ChatInput` + 边路任务 `SideChatPanel` |
| 类型安全 | 全部类型放行（不设白/黑名单） |
| 大小/数量限制 | 不设上限（服务端保留 50MB 兜底配置） |
| 消息写入方式 | 仅文本路径（`@{绝对路径}@` 自然持久化，不新增字段） |
| 历史记录展示 | 以文件引用文本天然持久化在会话，无独立附件卡片 |
| 工具访问 | `PathSandbox` 增加 runtime `incoming/` 允许根（放行绝对路径） |
| 入口呈现 | 统一入口（`+` 按钮图片/文件均可选） |
| 上传时机 | 选择即上传（不同于图片的发送时上传） |
| 图片策略 | 图片链路不动，仅新增文件能力 |
| 拖拽/粘贴 | 支持文件拖拽与粘贴上传 |

## 5. 技术选型

| 组件 | 选型 | 理由 |
|------|------|------|
| 文件落盘 | 复用 `file` 表 + `FileService` 扩展 | `file` 表已有元数据/下载/预览/逻辑删除体系，扩展 `incoming` 存储目录即可，复用下载与元数据能力 |
| 上传 API | 新增 `POST /v1/files/upload-incoming`（或扩展现 `/v1/files/upload`） | 与图片 `local` 落盘链路同构；携带 `sessionId` 落到会话级 runtime 目录 |
| 临时目录策略 | `runtime/{userId}/{sessionId}/incoming/` | 与 shellOutput/skills 同级，会话级隔离、随会话清理 |
| 引用节点 | 复用现有 `FileReferenceNode`（Ti PTap inline atom） | 输入区已支持该类节点渲染与被读取（`renderText`→`@{path}@`），无需新节点类型 |
| 编辑器文本序列化 | TipTap `getText()`（renderText） | 节点文本天然进入 `editorContent`，随消息发送，无需额外数据通道 |
| WS 协议 | 沿用 `send_message`（不新增字段） | 文件引用以正文文本形式携带，协议零改动 |
| Prompt 注入 | 在系统/用户 Prompt 或会话上下文说明中追加「上传文件路径」说明 | 告知 Agent 如何解释 `@{绝对路径}@` 引用 |
| 路径安全 | `PathSandbox.addAllowedRoot(runtime{userId}/{sessionId}/incoming)` | 使读文件/Shell/Grep/Glob 等工具可访问上传文件 |
| 前端上传 SDK | 复用 `uploadImages` 的 local/OSS 双分支逻辑的 **local 专用**文件上传函数 | 文件必须落到服务端 runtime（不适用 OSS 直传），新建 `uploadFiles.local` 分支 |
| 清理 | `sessionService.deleteSession` 扩展级联删除 runtime incoming 目录 | 复用会话删除入口 |

> 说明：OSS 模式（`storageMode==='oss'`）下现有图片是前端直接 PUT 到 OSS。**文件上传固定走服务端 local 收件**（POST 到 backend），以确保文件落在 runtime `incoming/` 并可被沙箱读取；OSS 模式与 local 模式对文件统一走此通道。图片保持原有双模式不变。

## 6. 实现步骤

### 6.1 后端：文件上传到 runtime incoming

1. **`RuntimeDataResolver`**：新增 `resolveIncomingDir(userId, sessionId)` 返回 `runtime/{userId}/{sessionId}/incoming`（并 `mkdir -p`）。
2. **`FileService`**：新增 `uploadIncomingFile(bytes, originalName, mimeType, userId, sessionId)`：
   - 复用 `maxSizeMb` 兜底校验（保持 50MB 上限配置，不做额外限制）；
   - 落盘到 `incoming/`，`storedName` 沿用 UUID + 扩展名；
   - 复用 `FileEntityRepository.insert` 落 `file` 表（`sessionId` 记录会话归属），以便元数据/下载/删除统一管理。
3. **`file.routes.ts`**：新增 `POST /v1/files/upload-incoming`（multipart：`file` + `sessionId`）：
   - 校验会话归属（`requireOwnedSession`）；
   - 返回 `{ url, absolutePath, originalName, fileSize, mimeType }`（`absolutePath` 为 runtime 内绝对路径，用于节点文本）。
4. **清理**：`sessionService.deleteSession`（`session.routes.ts` DELETE `/v1/sessions/:id`）中，删除会话后级联删除 `runtime/{userId}/{sessionId}/incoming/`（含其他 runtime 子目录可按需一并清理，本轮只需 incoming）。

### 6.2 后端：路径沙箱放行 runtime

5. **`create-app.ts`**：`pathSandbox.addAllowedRoot(runtimeRoot)`，使工具（读文件、Shell、Grep、Glob、下载预览等）可访问 runtime 下文件；同时保持 `PathSandbox.resolve` 对工作区外的绝对路径仍会拦截（除允许根外）。
6. 核对 `workspace-browse.service.ts` / `workspace-git.service.ts` 对 `session.workspace` 的处理不受 runtime 放行影响（仅新增允许根，不改既有判定）。

### 6.3 后端：Prompt 说明（Agent 如何理解文件引用）

7. **`PromptEngine` / 系统 Prompt**：在系统提示或会话上下文增加段落：
   - 「用户消息中的 `@{绝对路径}@` 标识已上传到服务器 runtime 目录的文件；它不是一个工作区相对路径，请按绝对路径读取。文件类型不定，需在读取时检测（可用读文件/文件信息/Shell 工具）；若内容是图像/PDF/文档，可选择以合适方式分析；最终按用户任务决定如何使用该文件。」
   - 若 `@{path}@` 路径是相对路径（现有 `@` 工作区引用），保持既有行为（相对工作区根）不变，二者通过是否绝对路径区分。

### 6.4 前端：输入区文件上传与节点插入

8. **`ChatInput.vue`**：
   - `+` 按钮：`accept` 去掉 `image/*`（允许全部），title 改为「上传图片或文件」；
   - 新增 `uploadFilesLocal` 处理：选择文件后**立即**调用上传 API（携带当前 `sessionId` / 边路 `registerKey`），成功后：
     - 在光标处插入 `fileReference` 节点（`filePath=absolutePath`）；若编辑器为空则先聚焦到开始处；
     - 失败提示并回滚/移除对应胶囊；
   - `pendingFiles` 分支：图片维持现状（胶囊 + `filePreviewUrls`）；文件在上传成功后直接作为节点进入正文，不长期驻留胶囊（或短暂显示上传中/失败状态）；
   - 拖拽：在输入区（`textarea-area`）绑定 `dragover`/`drop`，`drop` 取出文件数组走同一上传流程；
   - 粘贴：现有 `handlePaste` 仅处理 `image/*`；扩展为非图片文件（`item.kind==='file'`）也走上传流程；文本粘贴逻辑保持不变。
9. **`SideChatPanel.vue`**：同上逻辑抽出为可复用 composable（如 `useFileUpload`），主会话与边路任务共用。

### 6.5 前端：消息发送

10. **`useChat.ts`**：`sendMessage` 的正文文本已由编辑器 `getText()` 携带 `@{绝对路径}@`，无需上传图片流程以外的改动（文件不入 `images` 字段）；确认 `emit('send', text, files)` 的 `files` 参数保持图片 File 数组语义不变。
11. **`MessageBubble.vue`**：验证消息文本中 `@{...}@` 的渲染（如需要可对超长路径做截断展示，非必需）。

### 6.6 构建与测试

12. 后端：`cd backend-ts && npm run build && npm test`；补充 `uploadIncomingFile` 单测（落盘路径、会话归属、越权拒绝、大小兜底）。
13. 前端：`cd desktop && npm run build`（vue-tsc 类型检查）。
14. E2E：`tests/desktop.spec.ts` 增加文件上传 → 节点插入 → 发送 → Agent 读取的冒烟用例（如可行）。

## 7. 落地清单（Checklist）

### 后端（backend-ts）

- [ ] `RuntimeDataResolver.resolveIncomingDir()` 新增（`runtime/{userId}/{sessionId}/incoming`）
- [ ] `FileService.uploadIncomingFile()` 新增（落盘 + 落 `file` 表）
- [ ] `file.routes.ts` 新增 `POST /v1/files/upload-incoming`
- [ ] `sessionService.deleteSession` 级联清理 runtime incoming 目录
- [ ] `create-app.ts` 向 `PathSandbox` 注册 runtime 允许根
- [ ] `PromptEngine` 系统提示补充上传文件引用说明
- [ ] 单测：`uploadIncomingFile` / 越权 / 大小兜底 / 会话删除清理
- [ ] `CHANGELOG.md` `### 后端` 记录

### 前端（desktop）

- [ ] `ChatInput.vue`：`+` 入口放开文件类型 + 文件胶囊展示
- [ ] 文件选择即上传 + 插入 `fileReference` 节点（绝对路径）
- [ ] 拖拽上传（dragover/drop）
- [ ] 粘贴非图片文件上传
- [ ] `SideChatPanel.vue` 同步支持（抽取 `useFileUpload` composable）
- [ ] 消息发送验证：正文携带 `@{绝对路径}@`
- [ ] 前端构建 `vue-tsc / build` 通过
- [ ] `CHANGELOG.md` `### 前端（桌面 / Web / 安卓）` 记录

### 文档

- [ ] 本文档随实现更新为「已实施」状态
- [ ] （如涉及）README / USER_GUIDE 输入区能力说明

## 8. 风险与注意事项

| 风险 | 说明 | 缓解 |
|------|------|------|
| 磁盘占用 | 不设大小/数量上限，大文件持续上传可能占用 runtime 磁盘 | 依赖会话级隔离 + 会话删除清理；可后续增加监控告警（本轮不做定时清理） |
| 沙箱放行范围 | runtime 放行后，若沙箱实现引入漏洞可能越权读取他用户 runtime | 只放行 `runtime/{userId}/{sessionId}/incoming/` 会话级子目录（按会话增加 allow root），不整体放行 runtime 根 |
| 历史消息/压缩 | 历史早于本版本的消息无文件引用说明，Agent 读取时依赖路径判断 | Prompt 说明文件可能不存在时应以工具确认结果为准 |
| 图片回归 | 图片链路改动面 | 明确图片保持现有 `images` 字段链路，文件不走图片通道 |
| 路径解析歧义 | `@{path}@` 既有工作区相对引用与新的绝对路径混用 | 以是否绝对路径区分，Prompt 明确说明两者语义 |
| 边路任务会话 | SideChatPanel 的会话 ID 与主会话不同 | composable 内以 `registerKey`/`sessionId` 传入，做统一封装 |

## 9. 验收标准

1. 输入框 `+` 可上传任意文件（含图片），选择后立即上传至 `runtime/{userId}/{sessionId}/incoming/`，输入区出现文件引用节点（文本 `@{绝对路径}@`）。
2. 拖拽/粘贴文件同样生效。
3. 发送后消息正文包含 `@{绝对路径}@`；Agent 可通过读文件/Shell 等工具读取该文件并完成任务。
4. 图片上传、`@` 工作区引用、历史消息展示均不回归。
5. 删除会话后，对应 runtime `incoming/` 目录被清理。
6. 后端 `npm run build`/`npm test`、前端 `vue-tsc/build` 通过。