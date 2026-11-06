# 提案：工具卡片「看得懂」的最后一公里 —— 图片生成看得见图、失败不再伪装成功

> 0.0.442 起到 0.0.449，桌面端已把 8 个工具的调用卡片从原始 JSON 改造成富视图（edit_file / shell / read_file / write_file / glob_search / grep_search / web_search / open_web_page，统一骨架 `ToolCallCard.vue` 的 per-tool view model）。同一件事还剩最后一公里，四个断点每天都在发生：
> 1. **让 Agent 画了张图，工具卡片里只有一串 `image_url` JSON，看不到图本身**：图片生成结果 `{images:[{image_url,image_path,size_bytes,source,mime}],model,size,prompt}` **没有顶层 `media_type`/`data_uri`**（`generate-image-tool.ts:78-84`，`edit_image` 同源），而桌面端图片预览的唯一入口恰好要求顶层字段——`ToolImageResultProcessor.isImageResult`（`tool-image-result-processor.ts:65-68`）→ WS `preview` → `ToolCallCard.vue` 的 `imagePreviewUrl`。对照 `read_file` 读图（`read-file-tool.ts:130-140`）与 `page_screenshot`（`page-tools.ts:170-180`）都带顶层字段所以能预览，**偏偏图片生成不能**。
> 2. **工具失败了，折叠卡片却长得像成功**：`web_search` 失败（`{error}`）时 `summarizeWebSearch` 不检查 `error` 键、`total_results` 缺失 → 卡片头显示「搜索 xxx (0 条结果)」（`tool-result-summarizer.ts:401-407`）；`open_web_page` 失败（`{error,url}`）连 URL 都不显示，只剩光秃秃「打开网页」四个字（`:413-415`）；`shell` 的 errorJson 类失败（命令被拒 / 切目录失败 / 会话不存在，`shell-session-tool.ts` 共 19 处 `return errorJson(...)`，`:165,170,195,208,212,311,320` 等）经 `errorJson`（`json.ts:61`）产出 `{error}`、**不带 `exit_code`** → 回落 `-1` 显示「执行 xxx (exit -1)」（`:261-263`）；MCP / 图片 / 微信 / 飞书 / 钉钉**已经判出失败、却统一只显示「(失败)」不带原因**（`:437`、`:449`、`:461`、`:472`、`:540`、`:558`、`:592`、`:600`）；定时任务 4 个 summarizer 更是连 `error` 键都不看（`:496`、`:507`、`:522`、`:530`）。而同一文件 89 行的 `failureSuffix` 早就在给 file/search 五类工具带 40 字原因（`:279,307,327,340,351`）、`summarizeHttpCall` 也早已是正确的 `(失败: 原因)` 范本（`:622`）——**同一份文件里三档失败可读性并存**。
> 3. **回看会话时，当时选了什么选项、子代理跑到哪了，都是一坨带转义的 JSON**：`ask_user_questions` 结果 `{answers:[{question,selectedLabels,customInput}]}`（`ask-user-questions-tool.ts:61` output schema）没有富视图，`QuestionPanel` 只覆盖「等待回复」态（`ChatPanel.vue:156`），回答落库后回到工具卡片就是原始 JSON；`check_subagent` 结果 `{background_subagents: BackgroundProgress[]}`（`background-subagent-tools.ts:155`，条目含 `taskId/agentType/status/totalRounds/totalToolCalls/totalPromptTokens/totalCompletionTokens/recentOutput`，`background-subagent-manager.ts:39-49`）同样只有 JSON。
> 4. **后台子代理执行期间，卡片长时间显示「查看后台子代理 · 参数加载中...」，其实参数早已到位**：`getToolInputPreview` 的 switch（`toolDisplay.ts:67-153`）没有 `check_subagent`/`cancel_subagent`/`subagent_followup`（入参只有 `task_id`）、`create/update/delete_scheduled_task`（入参 `name`）、`send_wechat_image`/`send_wechat_file`（入参 `file_name`）的 case，通用回落（`:154-183`）也不认这些键 → 预览为空。`delegate` 类工具当年专门修过这个毛病（`:172-181` 注释：「否则 inputPreview 恒为空，卡片在子代理执行期间一直显示『参数加载中...』」），但同族的这几个漏修了。另：MCP 审批堆叠时标题全是通用的「操作待审批」——`ApprovalStack` 的 `titleMap` 只有 shell/write_file/edit_file 三项（`ApprovalStack.vue:90-94`），而 MCP 审批下发的 `toolName` 是 `mcp:${serverName}`（`electron/main.cjs:2476`），恰好不在表里。

- 状态：待评审
- 日期：2026-11-06
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 两项约 1.5 人日；P2 四项约 2 人日；**零数据库迁移**，90% 纯桌面端，后端只改 `tool-result-summarizer.ts` 的**摘要文案**、不碰任何判定逻辑）
- 关联：`desktop/src/components/chat/ToolCallCard.vue`、`desktop/src/utils/toolDisplay.ts`、`desktop/src/components/chat/ApprovalStack.vue`、`backend-ts/src/session/util/tool-result-summarizer.ts`、`backend-ts/src/harness/tool/impl/{generate-image-tool,edit-image-tool,ask-user-questions-tool,background-subagent-tools}.ts`

## 1. 背景与现状

### 1.1 现状逐项核对（代码可查）

| 场景 | 现状 | 代码证据 |
|---|---|---|
| `generate_image` / `edit_image` 结果 | `{images:[{image_url,image_path,size_bytes,source,mime}],model,size,prompt}`，无顶层 `media_type`/`data_uri`；桌面端 `imagePreviewUrl` 只在顶层有 `media_type==='image'` 时才非空 → 图片生成永远走原始 JSON 分支 | `generate-image-tool.ts:78-84`、`edit-image-tool.ts:233`、`tool-image-result-processor.ts:65-68`、`ToolCallCard.vue`（`imagePreviewUrl` computed） |
| `web_search` / `open_web_page` 失败摘要 | 两个 summarizer 均不检查 `error`；失败时分别显示「(0 条结果)」和只剩工具名 | `tool-result-summarizer.ts:401-407`、`:413-415` |
| `shell` 失败摘要 | `exit_code` 缺失回落 `-1`；`write_stdin` 分支（`:240-251`）连 `error` 都不看 | `tool-result-summarizer.ts:261-263`、`shell-session-tool.ts:195,208,311,320` |
| 图片 / 微信 / 钉钉 / 飞书 / MCP 失败摘要 | 已判失败但统一只显示「(失败)」，无原因（对照：`summarizeHttpCall` 已是 `(失败: 原因)` 正确范本） | `tool-result-summarizer.ts:437`、`:449`、`:461`、`:472`、`:540`、`:558`、`:592`、`:600` vs `:622` |
| 定时任务 4 个 summarizer | 失败时只显示工具名，无任何失败标识 | `tool-result-summarizer.ts:496`、`:507`、`:522`、`:530` |
| `ask_user_questions` 已回答 | 无富视图，原始 JSON；`QuestionPanel` 只覆盖等待态 | `ToolCallCard.vue:584-585`（view model 清单无此项）、`ChatPanel.vue:156` |
| `check_subagent` 进度 | 无富视图，原始 JSON | `background-subagent-tools.ts:155`、`background-subagent-manager.ts:39-49` |
| 输入预览缺口 | `subagent_followup`/`check_subagent`/`cancel_subagent`/`*_scheduled_task(s)`/`send_wechat_image`/`send_wechat_file` 无 case，`argsStreaming` 期显示「参数加载中...」 | `toolDisplay.ts:67-183`、`ToolCallCard.vue:323-327` |
| MCP 审批堆叠标题 | `titleMap` 仅三项，MCP 回落「操作待审批」 | `ApprovalStack.vue:90-94`、`electron/main.cjs:2476` |

### 1.2 为什么这件事性价比极高

- **骨架已经跑通**：8 个工具的 view model 模式（computed 返回 null 即回退原始 JSON）是现成的，新增视图是「抄同一条路」，不引入新架构。
- **失败原因是后端早已写好的字段**：`error` 键就在结果 JSON 里，`failureSuffix` 函数已在同文件被 5 处调用、`summarizeHttpCall` 等 3 处已有「(失败: 原因)」正确写法——剩下 15 处照抄这两个既有范本即可，**不新增任何后端能力、不改任何判定**。
- **图片预览不走服务端**：`image_url` 已是可直接加载的静态地址（`toStaticUploadBase` 拼的 `/uploads/...`），前端 `el-image` 直接可用，不需要新增接口、不需要 base64 传输。

## 2. 目标 / 非目标

**目标**

1. **P1 图片生成看得见图**：`ToolCallCard` 新增 `imageGenView` computed——取 `node.images[]`，渲染 prompt 头行 + 图片网格（`el-image`，点击可放大预览，复用 read_file 图片预览同款 `preview-src-list`），每张图带 `size_bytes` 可读化与 `mime` 角标；`model`/`size` 进底栏摘要。空 `images` 数组时回落原始 JSON。`generate_image` 与 `edit_image` 共用。
2. **P1 失败不再伪装成功**：`tool-result-summarizer.ts` 共 36 个 summarizer，失败可读性分三档——**已带 40 字原因的 3 个**（`summarizeHttpCall`/`summarizeHttpDescribe`/`summarizeDumpUserMessages`，`:622`、`:657`、`:422`）、**只显示「(失败)」不带原因的 8 个**（图片×2、微信×2、钉钉、飞书、MCP×2，`:437`、`:449`、`:461`、`:472`、`:540`、`:558`、`:592`、`:600`）、**压根不检查 `error` 键的 7 个**（`summarizeShell` 的 exec 与 write_stdin 两处、`summarizeWebSearch`、`summarizeOpenWebPage`、定时任务 4 个，`:236`、`:401`、`:409`、`:496`、`:507`、`:522`、`:530`）。后两档共 15 处统一接上 `failureSuffix`（`:89`，file/search 五类工具早在用，`:279,307,327,340,351`）。**只改文案，不改任何成功/失败判定**。
3. **P2 `ask_user_questions` 问答回放**：新增 view model，渲染「问题 → 选中标签（chip）→ 自定义输入」的问答对列表；多项选择展示全部选中标签，与 `QuestionPanel` 的选项样式同口径，回看时一眼知道当时选了什么。
4. **P2 `check_subagent` 进度列表**：新增 view model，把 `background_subagents[]` 渲染为子代理状态行——`agentType` + `status` 徽标（复用现有状态色）+ `轮数/工具数/token` + `recentOutput` 折叠区；`wait_subagents` 的 `results` 数组顺带同款渲染。
5. **P2 输入预览补全**：`toolDisplay.ts` 补 6~7 个 case（`task_id` → `任务 #N`；定时任务 `name`；`send_wechat_*` 的 `file_name`/`image`），消掉「参数加载中...」假象。
6. **P2 MCP 审批堆叠标题**：`ApprovalStack` 的 `titleMap` 增加 `mcp:` 前缀解析（或直接透传 `server.tool`），堆叠卡片能看出在等哪个 MCP 工具。

**非目标**

- **不做 `no-progress-notice` 的图片工具归一化**：图片结果带 `randomUUID()` 文件名（`generate-image-tool.ts:74`）导致 `resultDigest` 每轮不同、重复生成永远不触发止损（`no-progress-notice.ts:98-102`、`VOLATILE_RESULT_KEYS` 缺 `image_url`/`image_path`）。这是**真 bug**，但它改的是 guard 核心判定口径、影响「无进展中止」语义，风险等级与本提案其余部分不同量级，**另立专项**（需同步改运行时 guard 与历史重放两端 + 补/改 spec）。
- 不做 admin 端工具富视图（另一套设计系统，移植 8 个视图工程量大，列为长期项）。
- 不给 Agent 新增任何内置工具，不碰 `ToolRegistry`。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话内查找 / Markdown 导出（2026-11-02 否决） | 不新增任何检索入口，只改善**已加载在眼前**的工具卡片可读性。 |
| 第二十二批「只把后端早已写好的字段翻到展示层」（2/3 被驳回） | 本提案主体不是「翻字段」：P1 两项是**用户被完全堵住的能力缺口**（画了图看不到图、失败看成成功），新增的是视图与文案口径，不是加一列展示。 |
| 平台扩张类（执行节点 / 用户自建 Agent / MCP Server 输出，2026-10-25 否决） | 零新增执行面，全部落在既有工具的结果展示层。 |

## 4. 方案设计

### 4.1 `imageGenView`（P1）

- `ToolCallCard.vue` 新增 computed：`name === 'generate_image' || name === 'edit_image'` 时解析 `node.images`（要求为非空数组，否则返回 null 走回退），返回 `{ prompt, model, size, items: [{url, bytes, mime}] }`。
- 模板分支放在 `webPageView` 之后：prompt 头行（`--aw-primary` 之外的墨色，与查询行同口径）+ 图片网格（`display:grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))`，`el-image` 带 `preview-src-list` 全图列表）+ 底栏摘要 `N 张图 · model · size`。
- `size_bytes` 用现有 `formatFileSize` 口径（`tool-result-summarizer.ts` 已有同款实现，前端 `toolDisplay.ts` 或本视图内本地实现一个即可）。
- **不改后端**：`image_url` 已是静态可加载地址；图片下载/放大走浏览器原生能力。

### 4.2 失败摘要统一（P1）

分两类处理，共 15 处：

- **A 类：压根不检查 `error` 的 7 处**（`summarizeShell` exec / write_stdin 两处、`summarizeWebSearch`、`summarizeOpenWebPage`、定时任务 4 个 summarizer）——开头补 `const failure = failureSuffix(node); if (failure) return \`${label}${failure}\``，与 `summarizeReadFile` 等五处**逐字同构**。
  - `shell` 特例：`exit_code` 缺失且 `error` 存在时走 `failureSuffix`，不再输出 `(exit -1)`；`exit_code` 存在但非 0 时维持现有 `(exit N)`。
  - `web_search` 特例：失败时不再走 `total_results` 缺失 → `0` 的路径输出「(0 条结果)」。
  - 定时任务 4 个同理（当前失败时只显示工具名，无任何失败标识）。
- **B 类：已判失败但只输出「(失败)」的 8 处**（图片×2、微信×2、钉钉、飞书、MCP×2）——把裸 `(失败)` 换成 `(失败: ${truncate(String(node.error), 40)})`，与 `summarizeHttpCall:622` 的既有写法同口径（该函数已经是正确范本，B 类照抄即可）。
- 纯文案改动，所有函数的**成功路径输出逐字节不变**（现有 spec 全量保留，只加失败用例）。

### 4.3 `askUserView` / `subagentProgressView`（P2）

- `askUserView`：问答对列表，问题一行、选中标签 chip 行（多选全展示）、`customInput` 存在时以引用块样式展示；复用 `QuestionPanel` 的 chip 样式变量。
- `subagentProgressView`：每条子代理一行——`agentType`（等宽）+ `status` 徽标 + `#taskId` + `N 轮 / M 次工具 / token 数`；`recentOutput` 默认折叠为一行省略，点击展开（复用 `ToolShellView` 的折叠交互口径）。

### 4.4 输入预览与审批标题（P2）

- `toolDisplay.ts` 的 `getToolInputPreview` switch 补 case，每例 1~3 行；通用回落不动。
- `ApprovalStack.vue` 的 `titleMap` 查不到时，若 `toolName` 以 `mcp:` 开头则取冒号后文本作为标题（即 `server.tool`），其余维持「操作待审批」。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `ToolCallCard.vue`（`imageGenView` / `askUserView` / `subagentProgressView` 三个 computed + 三个模板分支 + 少量样式）；`toolDisplay.ts`（6~7 个 case）；`ApprovalStack.vue`（`mcp:` 标题解析，约 3 行） |
| backend-ts | `tool-result-summarizer.ts`（15 处失败摘要补原因，纯文案）+ 对应 spec 补失败用例 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 图片网格在长会话里一次渲染多张大图，拖慢滚动 | 图片用 `lazy` 加载 + 固定缩略图尺寸（`object-fit: contain`，最大高 160px）；单次 `images[]` 上限由后端已有约束控制，前端再截断到前 9 张并提示「共 N 张」 |
| 改 summarizer 文案影响既有 spec 与下游消费 | 成功路径逐字节不变（只加失败分支）；`tool-result-summarizer.spec.ts` 全量回归 + 为 15 处各补 1 条失败用例 |
| `image_url` 在 LOCAL / 反向代理下不可达 | 结果里同时有 `image_path`；预览失败时 `el-image` 的 error 槽降级为「点击查看路径」+ 复制路径按钮，不白屏 |
| 三个新 view model 增加 `ToolCallCard` 体积 | 与现有 8 个同模式；`richView` 链尾追加，不影响既有分支优先级 |
| 审批标题解析 `mcp:` 前缀与未来命名变化耦合 | 只做「前缀命中则用后半段」，未命中维持原文案；加一条单测锁住 `mcp:server.tool` → `server.tool` |

## 7. 测试要点

1. `imageGenView`：正常 `images[]` 渲染网格与摘要；空数组 / 缺 `images` 键回落原始 JSON；`size_bytes` 可读化正确。
2. 15 处失败摘要：各补 1 条 `{error:'...'}` 失败用例，断言摘要含原因前 40 字；A 类 7 处另断言不再出现「(0 条结果)」/「(exit -1)」；成功用例断言输出与改前逐字节一致。
3. `summarizeShell`：`{error}` 无 `exit_code` → 不含 `exit -1` 且含 error；`{exit_code:2}` → 仍为 `(exit 2)`。
4. `askUserView`：多选标签全展示；`customInput` 存在与缺失两种形态。
5. `subagentProgressView`：`status`/轮数/token 渲染；`recentOutput` 折叠与展开。
6. `getToolInputPreview`：6 个工具各 1 例，断言不再返回空串。
7. `ApprovalStack`：`mcp:server.tool` 标题解析；未知工具仍回落「操作待审批」。

## 8. 决策记录

待评审确认：

1. **图片网格单次上限取 9 张（3×3）是否合适**，还是取 6 张（2×3）更保守？超出部分显示「共 N 张，其余略」。
2. **`check_subagent` 的 `recentOutput` 默认折叠还是默认展开**？折叠更省空间但多看一步；后台子代理是低频查看场景，倾向折叠。
3. **`wait_subagents` 的 `results` 数组是否同款渲染**（它可能是完成态的完整结果，形态与 `BackgroundProgress` 不同），还是本轮只做 `check_subagent`？
