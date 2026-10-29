# 长文本用户消息「文件化」能力 · 技术方案

> 状态：已与需求方对齐，待评审
> 适用代码库：`backend-ts/`（NestJS + Fastify + TypeScript）、`desktop/`（Vue 3 + TipTap + Electron/Web）+ `android/`（Capacitor 壳复用 desktop 前端）
> 文档日期：2026-10-29

## 1. 需求背景

用户在输入框粘贴大批量精确数据（典型场景：1000+ 个用户 ID，形如 `14084181,14084183,…`），要求 Agent 基于这批 ID 执行任务。当前实现下这类任务**大概率失败**，根因有四层：

1. **LLM 复述长数字列表不可靠**。要把 ID 交给工具处理，Agent 必须在自己的输出里复述这批 ID（写文件、shell 循环、逐个查询）。8-9 位长数字串是模型生成的高频出错区，漏位/错位/hallucinate 都会让结果失真。而项目里**不存在「大块数据旁路通道」**——纯文本粘贴这条路从第一步就绕不开复述。
2. **压缩机制会静默摧毁精确数据**。`compaction-service.ts` 的 handoff 指令要求把历史压成 ≤12000 token 摘要，1000 个 ID 被概括后必然退化成「14084181–14084253 等连续 ID」这类丢精度的形式。压缩一旦触发（40MiB payload 或 80% token 水位），后续所有轮次都在错误输入上工作。
3. **无进展止损会误杀批量任务**。`no-progress-notice.ts` 的阈值是第 5/10 轮提醒、**连续第 15 轮签名相同直接 `NoProgressLoopException` 中止执行**。分批处理 ID 时参数模式高度相似（连续几轮 `read_file` 相邻区间 / `grep` 同一模式），极易被判为「无进展」而 FAILED。
4. **上下文全量重放，成本随轮数放大**。`prompt-engine.ts` 的 `buildRequest` 只做浅拷贝与 marker 展开，无任何裁剪；那条长用户消息从第一轮起就在 `messages[1]`，每轮请求都完整重发，上下文单调增长直至触发压缩。

本方案用「**把长文本变成文件**」一次性解开 1 和 2：文件可被 `read_file` 分页读、`grep_search` 精确筛、shell 脚本批处理，全程不需要 LLM 复述数据。

### 与现有能力的关系

| 已有能力 | 现状 | 本方案定位 |
|---|---|---|
| 上传任意文件 → `@{绝对路径}@` 引用（2026-08-20 方案） | 用户手动选文件，路径进消息正文 | **复用其全部链路**，第 1 点只是把「粘贴的长文本」自动变成这类文件 |
| `open_web_page` 截断后落盘全文 + `full_content_file` | 网页正文超长时给 Agent 文件路径回读 | **沿用同一模式**（落盘 + 返回路径 + 提示回读），第 2 点把它推广到用户消息 |
| 会话压缩归档 `compaction-*.jsonl` | 压缩时把原始消息落档供回读 | 目录并列、语义区分，不混用 |

## 2. 需求描述（做什么 / 不做什么）

### 2.1 在范围内（本次要做）

| # | 事项 | 说明 |
|---|------|------|
| R1 | 粘贴超长文本自动转附件 | 输入框粘贴纯文本超过阈值（默认 2000 字符）时，阻止插入编辑器，改为生成一个 `.txt` 附件进入待发列表 |
| R2 | 附件 chip 可见、输入框不留说明 | 粘贴后输入框保持原状（不插入文本、不写任何提示语），仅在输入框下方待发附件区多出一个 chip |
| R3 | 发送链路零改动 | 转出的附件复用现有 `uploadPendingFiles`（CLOUD）/ `copyLocalPendingFiles`（LOCAL），最终消息形态为「用户指令 + `@{绝对路径}@`」 |
| R4 | 新增内置工具 `dump_user_messages` | 把本会话最近 N 条用户消息的**原文**落成文件，返回文件绝对路径数组 |
| R5 | `recentCount` 参数 | 默认 1（最近一条）；传 N 则对最近 N 条用户消息分别生成 N 个文件并返回 N 个路径 |
| R6 | 每条消息独立文件 | 文件名 `user-message-{messageId}.txt`，以消息 id 为主键，重复调用幂等覆盖 |
| R7 | CLOUD 落盘位置 | `runtime/{userId}/{sessionId}/userMessages/`，与 `webPages/`、`compaction/`、`incoming/` 并列 |
| R8 | LOCAL 落盘位置 | 经 WS 委托桌面端新工具 `write_local_text_file` 写入 `~/.mao/attachments/{host}/{sessionId}/`，与第 1 点附件同目录 |
| R9 | 上下文保持原样 | 工具**不**从上下文移除原始长消息，只是额外提供一份可精确处理的文件副本；由 Agent 自行决定读取/检索/复制/脚本处理 |
| R10 | 工具三处同步 | `tool-result-summarizer`（结果摘要）、`desktop/src/utils/toolDisplay.ts`（中文名与参数预览）、`no-progress-notice.ts`（结果归一化）按仓库规范同改 |
| R11 | 桌面端 `write_local_text_file` | `executeToolByName` 新增 case，复用 `chatAttachment.cjs` 的路径解析与重名规避 |

### 2.2 不在范围内（本次明确不做）

| # | 事项 |
|---|
| N1 | 不改无进展止损阈值。第 3 层根因（误杀批量任务）独立评估，不混入本次改动 |
| N2 | 不做「从上下文移除长消息」的机制。工具只提供副本，不动历史窗口 |
| N3 | 不为第 1 点做上传进度/失败重试 UI，沿用现有待发附件 chip 的既有行为 |
| N4 | 不做 Android 专属适配。安卓壳复用 desktop 前端，`Capacitor.isNativePlatform()` 守卫下自动继承 |
| N5 | 不为 `dump_user_messages` 增加消息内容检索/过滤参数（如按关键词筛选），只按最近 N 条取 |
| N6 | 不提供消息删除后的文件清理策略，沿用会话删除级联清理 runtime 的既有机制 |

### 2.3 用户侧使用流程

**场景 A：粘贴超长 ID 列表（第 1 点）**

1. 用户从 Excel/外部系统复制 1000+ 个 ID，粘进输入框；
2. 输入框**不出现**那一大段文本，下方待发附件区多出一个 `pasted-text-1.txt` chip；
3. 用户补一句指令「基于这些 ID 逐个查询用户状态并汇总」；
4. 发送后消息正文 = 指令 + `@{绝对路径}@`；
5. Agent 用 `read_file` 分页 / `grep_search` / shell 脚本精确处理，全程不复述 ID。

**场景 B：其他渠道的长消息兜底（第 2 点）**

1. 消息未经桌面粘贴（手动输入、飞书/钉钉入站、定时任务），或粘贴长度未达阈值；
2. Agent 发现上下文里有一条超长用户消息，调用 `dump_user_messages`；
3. 工具返回 `["/abs/path/user-message-1042.txt"]`；
4. Agent 用文件工具链精确处理该文件。

## 3. 现状梳理（存量实现）

### 3.1 待发附件链路（第 1 点的落点）

- **前端输入区**：`desktop/src/components/chat/ChatInput.vue`
  - `handlePaste`（约 `:566`）：`editorProps.handlePaste`。当前分支顺序为「图片 → `item.kind==='file'` → 图文混排保留 `text/plain` → marker 语法转换（`@{...}@` / `${...}$` / `#{...}#`）→ 交还 TipTap 默认粘贴」。
  - `pendingFiles`：待发非图片文件列表，已在输入框下方渲染为附件 chip（含删除）。
  - `addPendingFile(file)`：把 `File` 推入待发列表并做数量校验（≤10）。
- **发送链路**：`desktop/src/composables/useChat.ts`
  - `prepareAndSendMessage`（约 `:420`）：`ensureSession` 之后按模式分流——
    - CLOUD：`uploadPendingFiles(text, files, sid)`（`utils/chatFileUpload.ts`）逐个 `POST /v1/files/upload-incoming`，把返回的 `absolutePath` 拼成 `@{path}@` 追加到消息末尾；
    - LOCAL + Electron：`copyLocalPendingFiles(text, files, sid)`（`utils/chatLocalAttach.ts`）调 `electronAPI.localCopyAttachment`，拷贝到 `~/.mao/attachments/{host}/{sid}/` 后拼引用。
  - `guardUploadsBeforeSend`：上传/拷贝失败时按既有规则决定是否阻断发送。
- **关键约束**：两条链路都**需要 sessionId**（文件要落到会话自己的目录），而 sessionId 在点发送、`ensureSession` 之后才确定。因此第 1 点采用「**粘贴时只攥在内存（`File` 对象），发送时才落盘**」，不为粘贴单独造暂存区。代价是发送前刷新页面会丢失该附件，对「刚粘贴的一大段文本」可接受。

### 3.2 本地附件落盘（LOCAL 复用）

- `desktop/electron/chatAttachment.cjs`
  - `resolveAttachmentTarget(homeDir, hostKey, sessionId, name)`：解析 `~/.mao/attachments/{host}/{sid}/{name}`，含 `sanitizeAttachmentName`（basename 化、剥控制字符、Windows 保留名加前缀、超长截断 ≤100）与 `path.relative` 出界断言。
  - `uniqueName(dir, name)`：`stem-1.ext` 确定性递增避重名。
  - `copyLocalAttachmentAsync(params)`：异步拷贝（不阻塞主进程事件循环），校验逻辑与同步版一致（lstat 不跟符号链接、拒空文件、拒超限）。
- `desktop/electron/main.cjs`
  - `ipcMain.handle('local-copy-attachment')`（约 `:1400`）：`homeDir=os.homedir()`、`hostKey=getServerHostKey()` 由主进程推导，渲染层无法指定。
  - `executeToolByName(toolName, ...)`（约 `:2378`）：LOCAL 工具执行入口 switch，现有 case 为 `shell` / `read_file` / `write_file` / `edit_file` / `glob_search` / `grep_search`，default 走 MCP 解析。
  - `ipcMain.handle('tool-execute')`（约 `:2428`）：WS 委托入口，把 `toolName + args` 转给 `executeToolByName`，结果 `JSON.stringify` 回传。

### 3.3 服务端工具与 LOCAL 委托

- `backend-ts/src/harness/tool/tool-dispatcher.ts`
  - `SERVER_ONLY_TOOLS`（约 `:69`）：`task_*`、`*_scheduled_task`、`spawn_subagent` 系、`web_search`、`open_web_page`、`generate_image`、`edit_image`、微信/飞书/钉钉媒体、`mcp_describe`、`http_describe`、`http_call`——**两种模式下都在服务端执行**，不进 LOCAL 委托分支。
  - `dispatchInvocation` 的 `executionMode === 'LOCAL'` 分支（约 `:283`）：非 SERVER_ONLY 工具走 `localToolExecutor.execute(sessionId, toolName, args, workspace, needApproval, dangerReason, approvalHint)`。
- `backend-ts/src/harness/local/local-tool-executor.ts`
  - `execute(...)`（约 `:43`）：校验桌面端在线 → `sessionRegistry.sendToolRequest(...)` → 按需走审批登记 → 等待桌面端回包，返回字符串结果。
  - 未连接时返回 `{error:'Local client is not connected...'}`，不抛异常。
- `backend-ts/src/harness/tool/tool-registry.ts`
  - 工具清单（约 `:140-180`）：`new WebSearchTool(deps.webSearch)`、`new OpenWebPageTool(deps.webPage, deps.runtimeDataResolver, localModeProbe)` 等同列注册。
  - `OpenWebPageTool` 的 `localModeProbe` 是现成范例：`sessionMapper.selectById(sessionId)` → `session?.executionMode === 'LOCAL'`。
- `backend-ts/src/harness/runtime/runtime-data-resolver.ts`
  - 已有 `resolveIncomingDir` / `resolveWebPageCacheDir` / `resolveCompactionDir` / `resolveShellOutputDir` / `resolveSkillsDir`，均基于 `resolveSessionRuntimeDir(userId, sessionId) = runtime/{userId}/{sessionId}`。

### 3.4 路径沙箱

- `backend-ts/src/harness/safety/path-sandbox.ts`：`resolve()` 只放行「会话工作区根 / `workspaceRoot`」与 `addAllowedRoot()` 登记的根。
- `backend-ts/src/create-app.ts:457-463`：已 `pathSandbox.addAllowedRoot(runtimeRoot)` 与 `addAllowedRoot(shareDir)`。
- **结论**：`runtime/{uid}/{sid}/userMessages/` 在 runtime 允许根之下，Agent 的 `read_file` / `grep_search` / shell 无需额外放行即可访问。LOCAL 的 `~/.mao/attachments/...` 由桌面端自己解析，不受服务端沙箱约束。

### 3.5 消息读取（第 2 点的数据源）

- `backend-ts/src/session/session.service.ts`
  - `getMessagesAfterId(sessionId, afterMessageId)`：取边界后全部消息。
  - `getLastUserMessage(sessionId)`：取最后一条用户消息（`session-history-loader.ts:78` 已用于压缩后回填）。
- `backend-ts/src/harness/core/session-history-loader.ts`
  - `toChatMessage(message)`：DB 行 → `ChatMessage`，含 `parseContent`（多模态 parts 判定）、`senderYmd`、`toolCalls`、`reasoningContent`。
- **注意**：发给模型的 `ChatMessage` **不含消息 id**（`chat-request.ts:59` 只有 `role/content/name/toolCallId/toolCalls/audio/reasoningContent/senderYmd`）。这是第 2 点只能用「最近 N 条」定位、不能按 id 指定的根本原因。
- `backend-ts/src/harness/core/compaction-service.ts:44` 的 `isRealUserMessage(message)`：排除压缩摘要模板与 `<system-notice>` 注入，可直接复用作「真实用户消息」判定。

### 3.6 截断落盘的可复用范例

- `backend-ts/src/harness/tool/impl/open-web-page-tool.ts`
  - `writeFullContent(userId, sessionId, url, title, fullContent)`（约 `:161`）：`localModeProbe` 判 LOCAL → 直接不落盘；否则 `mkdirSync(resolveWebPageCacheDir(...))` + `writeFileSync`，文件名 `${urlSlug(url)}.md`，头部带 `source/title/full_length` 注释，返回绝对路径。
  - 返回 JSON 约定（约 `:149-150`）：`truncated=true` 时给 `full_content_file` + `message`（提示用 `read_file` 分页 / `grep_search` 回读，**不要重新抓取**）。

## 4. 技术决策（已确认）

| 决策点 | 结论 |
|---|---|
| 第 1 点触发时机 | **粘贴时**判断长度并转 `File`（非发送时），保证用户立刻看到附件 chip |
| 第 1 点阈值 | 2000 字符，抽成常量便于调整 |
| 第 1 点输入框表现 | 静默转换：不插入文本、不留说明文字，仅靠下方附件 chip 体现 |
| 第 1 点落盘时机 | 发送时复用现有 `uploadPendingFiles` / `copyLocalPendingFiles`（需要 sessionId） |
| 粘贴内容存储 | 仅存内存（`File` 对象），不做服务端/本机暂存区；刷新丢失可接受 |
| 第 2 点工具名 | `dump_user_messages` |
| 第 2 点参数 | 仅 `recentCount`（integer，默认 1，上限 10） |
| 第 2 点消息定位 | 按「最近 N 条真实用户消息」取，**不**按 messageId（模型拿不到 id） |
| 第 2 点文件名 | `user-message-{messageId}.txt`，id 主键、纯数字免 sanitize、重复调用幂等覆盖 |
| 第 2 点多消息形态 | 每条消息一个独立文件（非合并单文件），便于 Agent 按需处理单条 |
| 第 2 点 CLOUD 落点 | `runtime/{userId}/{sessionId}/userMessages/` |
| 第 2 点 LOCAL 落点 | `~/.mao/attachments/{host}/{sessionId}/user-message-{id}.txt`（复用 `resolveAttachmentTarget`） |
| 第 2 点 LOCAL 实现路径 | 服务端读 DB → 经 `LocalToolExecutor` 委托桌面端新工具 `write_local_text_file` 写盘 → 回传本机绝对路径 |
| 第 2 点执行模式归属 | 进 `SERVER_ONLY_TOOLS`（两种模式下服务端都是入口：读消息 + 决定落点） |
| 第 2 点上下文语义 | **不移除**原始长消息，工具只提供文件副本 |
| 第 2 点工具提示 | `getToolPrompt()` 明确：优先用文件工具链（`read_file` 分页 / `grep_search` / shell）处理，**不要在回复或工具参数里复述原文** |

## 5. 技术选型

| 组件 | 选型 | 理由 |
|---|---|---|
| 第 1 点文本转文件 | `new File([text], name, { type: 'text/plain' })` | 浏览器原生，直接进现有 `pendingFiles` 数组，无需新数据结构 |
| 第 1 点附件命名 | `pasted-text-{n}.txt`，n 为本次会话内自增序号 | 用户可识别来源；与手动选文件区分 |
| 第 2 点消息读取 | `SessionService` 扩展「按会话取最近 N 条真实用户消息」 | 复用 `isRealUserMessage` 口径，与压缩/历史加载一致 |
| 第 2 点 CLOUD 写盘 | `mkdirSync` + `writeFileSync`，同 `open_web_page` | 消息文本量级 KB～百 KB，同步写无性能问题 |
| 第 2 点 LOCAL 委托 | `LocalToolExecutor.execute` + 桌面端 `executeToolByName` 新 case | 完全复用现有 WS 委托通道，含在线校验与错误回传 |
| 第 2 点 LOCAL 落点解析 | `chatAttachment.cjs` 的 `resolveAttachmentTarget` + `uniqueName` | 已有 sanitize / 重名 / 出界断言，不重造 |
| 第 2 点 LOCAL 写入函数 | `chatAttachment.cjs` 新增 `writeLocalTextFileAsync` | 与 `copyLocalAttachmentAsync` 同构（校验 + 异步写 + 统一错误形态） |
| 工具结果形态 | `{ files: [{messageId, path, bytes}], count }`，与 `open_web_page` 的 `full_content_file` 提示风格一致 | Agent 一看就懂怎么用 |
| 提示词 | 工具 `getToolPrompt()` + 返回 JSON 的 `message` 字段双通道 | 工具不在工具集时（老 Agent 配置）不产生副作用 |

## 6. 实现步骤

### 6.1 后端：消息查询能力

1. **`session.service.ts`**：新增 `getRecentUserMessages(sessionId, limit): Promise<Message[]>`——倒序取 `role='USER'` 且通过 `isRealUserMessage` 判定的消息，翻转为正序返回，最多 `limit` 条。SQL 层按 `id DESC LIMIT n` 取后在内存过滤（真实用户消息判定含内容前缀规则，放内存更稳妥）。

### 6.2 后端：`dump_user_messages` 工具

2. **`runtime-data-resolver.ts`**：新增 `resolveUserMessagesDir(userId, sessionId)` → `runtime/{userId}/{sessionId}/userMessages`。
3. **新增 `harness/tool/impl/dump-user-messages-tool.ts`**：
   - 构造依赖：`sessionService`（读消息）、`runtimeDataResolver`（CLOUD 落点）、`localToolExecutor`（LOCAL 委托）、`sessionMapper`（判执行模式）。
   - `getName()` = `dump_user_messages`；`getInputSchema()` 仅 `recentCount`（integer，默认 1，描述写明上限 10）；`getOutputSchema()` 给 `files: [{messageId, path, bytes}]` + `count`。
   - `execute` 流程：
     1. `asIntStrict(args.recentCount, 1)`，`clamp(1, 10)`；
     2. `sessionId == null` → `errorJson('缺少会话上下文，无法定位用户消息')`；
     3. `getRecentUserMessages(sessionId, recentCount)`；空 → `errorJson('本会话暂无用户消息')`；
     4. `sessionMapper.selectById(sessionId)` 判 `executionMode`；
     5. **CLOUD**：`mkdirSync(resolveUserMessagesDir(userId, sessionId), {recursive:true})`，逐条 `writeFileSync(dir/user-message-{id}.txt, content)`；`userId == null` → 报错（CLOUD 必须有 userId 才能定位 runtime）；
     6. **LOCAL**：逐条调 `localToolExecutor.execute(sessionId, 'write_local_text_file', JSON.stringify({ fileName, content }), null, false, null)`；解析回传 JSON 取 `path`；未连接/失败 → 该条记 `error`，其余继续；
     7. 返回 `{ files, count, message }`，`message` 提示用 `read_file`（offset/limit 分页）/ `grep_search` / shell 处理，**不要在回复或工具参数中复述文件原文**。
   - `getToolPrompt()`：说明定位方式（最近 N 条、默认最后一条）、文件内容为**用户消息原文**、以及「精确数据必须走文件工具链、不得复述」的硬约束。
4. **`tool-registry.ts`**：注册 `new DumpUserMessagesTool(deps.sessionService, deps.runtimeDataResolver, deps.localToolExecutor, deps.sessionMapper)`；同时在 `tool-dispatcher.ts` 的 `SERVER_ONLY_TOOLS` 加入 `dump_user_messages`。

### 6.3 桌面端：`write_local_text_file`

5. **`chatAttachment.cjs`**：新增 `writeLocalTextFileAsync({ fileName, content, sessionId, homeDir, hostKey })`：
   - 复用 `resolveAttachmentTarget(homeDir, hostKey, sessionId, fileName)` + `uniqueName(dir, name)` 得最终路径；
   - 大小校验（`effectiveMaxSizeMb` 硬封顶，与拷贝同口径）；
   - `fsImpl.promises.writeFile(finalPath, content, 'utf8')`；
   - 返回 `{ ok: true, absolutePath }` 或 `{ ok: false, error }`，异常不抛出。
6. **`main.cjs`**：`executeToolByName` 新增 `case 'write_local_text_file'` → 调 `chatAttachment.writeLocalTextFileAsync({ fileName, content, sessionId, homeDir: os.homedir(), hostKey: getServerHostKey() })`；`ipcMain.handle('local-write-text-file')` 同步暴露给渲染层（备用，非必须）。
7. **`preload.cjs`**：暴露 `localWriteTextFile`（与 `localCopyAttachment` 并列）。

### 6.4 前端：粘贴超长文本转附件

8. **`ChatInput.vue`** `handlePaste`：
   - 在「marker 语法转换」分支**之前**插入长度判断：取 `text/plain`，`text.length >= PASTE_TEXT_FILE_THRESHOLD`（常量 2000）→ `event.preventDefault()` + `addPendingFile(new File([text], `pasted-text-${nextPasteSeq.value}.txt`, { type: 'text/plain' }))` + `return true`；
   - 顺序保证：先判长度再判 marker 语法——超长文本即使含 `@{...}@` 也整体转文件（含 marker 的长文本更应走文件通道）；
   - 图文混排分支（`handledFile`）保持现状不变；
   - `pendingFiles` 数量上限（10）沿用现有校验与提示。
9. **`SideChatPanel.vue`**：边路任务输入框复用同一 `ChatInput` 组件，自动继承；无需单独改。

### 6.5 工具三处同步（仓库规范）

10. **`backend-ts/src/session/util/tool-result-summarizer.ts`**：新增 `summarizeDumpUserMessages(argumentsJson, result)`——取 `recentCount` 与 `files.length`，输出形如「导出 3 条用户消息为文件」。
11. **`desktop/src/utils/toolDisplay.ts`**：新增 `dump_user_messages` 的中文名（「导出用户消息」）与参数预览（`recentCount`）。
12. **`backend-ts/src/harness/core/no-progress-notice.ts`**：工具结果含文件路径，需评估是否加入按工具归一化——结论：路径由 `messageId` 决定、同会话同消息幂等不变，**不属于易变字段**，不加 `VOLATILE_RESULT_KEYS`；但需补一条用例固化该结论。

### 6.6 文档与测试

13. `CHANGELOG.md` 顶部补条目（`desktop 共用 UI` + `backend-ts` 两节）。
14. `README.md` / `DEPLOY.md` 如涉及用户可见行为，同步更新；`skills/mao-cli/SKILL.md` 若描述工具集需同步。
15. 后端单测：`dump-user-messages-tool.spec.ts`（成功/失败/参数缺失/`recentCount` 边界 1 与 10 与越界 clamp/空消息/`sessionId` 为 null/CLOUD 落盘路径正确/LOCAL 委托参数与回传解析/未连接降级）；`session.service` 的 `getRecentUserMessages` 用例（真实用户消息过滤、顺序、limit）。
16. 前端单测：`ChatInput` 粘贴转附件（超阈值转 File、未超阈值走原逻辑、含 marker 的长文本仍转文件、数量上限）；`chatLocalAttach.test.ts` 补充（若第 1 点改动影响其入参形态）。
17. Electron 单测：`chatAttachment.test.cjs` 补 `writeLocalTextFileAsync`（成功落盘/同名规避/会话非法/超限/写失败不抛）。
18. 构建验证：`cd backend-ts && npm run build && npm test`；`cd desktop && npm run build`；`cd desktop && npm test`（Vitest，若存在）。

## 7. 落地清单（Checklist）

### 后端（backend-ts）

- [ ] `SessionService.getRecentUserMessages(sessionId, limit)` 新增
- [ ] `RuntimeDataResolver.resolveUserMessagesDir()` 新增
- [ ] `harness/tool/impl/dump-user-messages-tool.ts` 新增
- [ ] `tool-registry.ts` 注册 `DumpUserMessagesTool`
- [ ] `tool-dispatcher.ts` 的 `SERVER_ONLY_TOOLS` 加入 `dump_user_messages`
- [ ] `session/util/tool-result-summarizer.ts` 补结果摘要
- [ ] `harness/core/no-progress-notice.ts` 补「路径非易变字段」用例
- [ ] 单测：工具 + 服务方法

### 桌面 Electron（desktop/electron）

- [ ] `chatAttachment.cjs` 新增 `writeLocalTextFileAsync`
- [ ] `main.cjs` `executeToolByName` 新增 `write_local_text_file` case
- [ ] `main.cjs` 新增 `local-write-text-file` IPC（备用）
- [ ] `preload.cjs` 暴露 `localWriteTextFile`
- [ ] `chatAttachment.test.cjs` 补用例

### 前端（desktop/src）

- [ ] `ChatInput.vue` `handlePaste` 长度判断 + 转 `File`
- [ ] `utils/toolDisplay.ts` 补 `dump_user_messages` 中文名与参数预览
- [ ] `ChatInput` 粘贴相关单测

### 文档

- [ ] `CHANGELOG.md` 顶部条目
- [ ] `README.md` / `DEPLOY.md` 同步（如涉及）

## 8. 风险与限制

| 项 | 说明 |
|---|---|
| 第 1 点刷新丢失 | 粘贴的附件仅存内存，发送前刷新/崩溃会丢。属可接受代价（用户可重新粘贴） |
| 第 1 点 10 个附件上限 | 连续粘贴多段长文本会触发现有 `pendingFiles` 上限提示，沿用既有行为不扩额 |
| 第 2 点无法按 id 定位 | 模型拿不到 messageId，只能「最近 N 条」。若用户要处理更早的长消息，需先把它变成最近一条（追问/编辑重发） |
| 第 2 点 LOCAL 依赖桌面端在线 | 桌面端未连接时该工具返回错误（`LocalToolExecutor` 既有行为），Agent 应如实告知用户 |
| 第 2 点文件不自动清理 | 复用会话删除级联清理；长时间会话可能累积多个 `user-message-*.txt`（文本量级小，可接受） |
| 未解决无进展误杀 | 第 3 层根因（`NO_PROGRESS_ABORT_AT=15` 对批量任务误杀）本次不改，建议后续独立评估：对「参数不同、结果不同但结构相似」的分批轮次放宽判定 |
| 未解决上下文膨胀 | 第 2 点只提供副本，不移除原始长消息；长会话的请求体积问题仍由既有压缩机制兜底 |
