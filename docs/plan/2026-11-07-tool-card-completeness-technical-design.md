# 工具卡片完整化技术方案：图片看得见、失败不伪装、问答与子代理可回放

- 状态：待评审（2026-11-07 整理成稿；原提案三个开放决策已在本文 §8 全部定案，无遗留待定项）
- 日期：2026-11-07
- 需求来源：`docs/proposals/2026-11-06-tool-card-completeness.md`（提案，含逐项代码证据；本文在其基础上完成定案与两处勘误，见 §3.2）
- 上游设计：0.0.442~0.0.449 工具卡片富视图改造（`ToolCallCard.vue` per-tool view model 骨架）
- 规模：小~中（后端 `tool-result-summarizer.ts` 15 个函数的失败文案 + 前端 3 个视图组件 + 2 个工具函数 + 测试；**零数据库迁移**；不改任何工具的成功/失败判定，不新增工具）
- 关联：`desktop/src/components/chat/ToolCallCard.vue`、`desktop/src/utils/toolDisplay.ts`、`desktop/src/components/chat/ApprovalStack.vue`、`desktop/electron/main.cjs`、`backend-ts/src/session/util/tool-result-summarizer.ts`、`backend-ts/src/harness/tool/impl/{generate-image-tool,edit-image-tool,ask-user-questions-tool,background-subagent-tools,scheduled-task-tools}.ts`、`backend-ts/src/harness/delegate/background-subagent-manager.ts`

## 1. 需求背景

0.0.442 起桌面端已把 8 个工具（edit_file / shell / read_file / write_file / glob_search / grep_search / web_search / open_web_page）的调用卡片改造成富视图（view model computed 返回 null 即回退原始 JSON 的统一骨架）。这条路线还剩最后一公里，四个断点每天都在发生：

1. **Agent 画了图，卡片里看不到图**：`generate_image` / `edit_image` 结果是 `{images:[{image_url,image_path,size_bytes,source,mime}],model,size,prompt}`（`generate-image-tool.ts:60-95` `materializeImageApiResult`，`edit_image` 同源复用），没有顶层 `media_type` / `data_uri`；而桌面端图片预览的两个入口都要求顶层字段——WS 侧 `tool-image-result-processor.ts` 的 `isImageResult`（提案 :65-68）与卡片侧 `imagePreviewUrl`（`ToolCallCard.vue:600-614`，要求 `result` 顶层 `media_type==='image' && data_uri`）。对照 `read_file` 读图与 `page_screenshot` 都带顶层字段所以能预览，唯独图片生成走原始 JSON 分支。
2. **工具失败，折叠卡片长得像成功**：`tool-result-summarizer.ts` 全文核对，失败可读性分三档——已带 40 字原因的范本（`failureSuffix` :89-92 被 file/search 五类工具调用；`summarizeHttpCall` :629-631 是 `(失败: 原因)` 正确写法）；只显示裸 `(失败)` 的 8 个函数（图片×2 :443/:455、微信×2 :467/:486、钉钉 :547、飞书 :566、MCP×2 :596/:604）；压根不检查 `error` 键的 7 个函数（`summarizeShell` exec 段 :261-263 `exit_code` 缺失回落 `-1` 显示 `(exit -1)`、write_stdin 段 :240-251 连 `error` 都不看、`summarizeWebSearch` :401-407 失败显示 `(0 条结果)`、`summarizeOpenWebPage` :409-415 失败只剩光秃秃「打开网页」、定时任务 4 个 :496/:507/:522/:530 失败无任何标识）。同一份文件三档失败可读性并存。
3. **回看会话时，问答与子代理进度都是转义 JSON**：`ask_user_questions` 结果 `{answers:[{question,selectedLabels,customInput}]}`（`ask-user-questions-tool.ts:57-74` output schema；`QuestionPanel.vue:238-246` 提交的就是这个形状，`customInput` 空时为 `null`）没有富视图——`QuestionPanel` 只覆盖「等待回复」态，回答落库后回到工具卡片只剩原始 JSON；`check_subagent` 结果 `{background_subagents:[{taskId,childSessionId,agentType,status,totalRounds,totalToolCalls,totalPromptTokens,totalCompletionTokens,recentOutput}]}`（`background-subagent-manager.ts:39-49` `BackgroundProgress`；`background-subagent-tools.ts:153-155`）同样只有 JSON。
4. **执行中卡片显示「参数加载中...」假象 + MCP 审批标题通用化**：`getToolInputPreview` 的 switch（`toolDisplay.ts:67-153`）没有 `check_subagent` / `cancel_subagent` / 定时任务三兄弟 / `send_wechat_image` / `send_wechat_file` 的 case，通用回落（:154-188）也不认 `task_id` / `name` / `image` / `file` 这些键 → 流式期间显示「参数加载中...」。`ApprovalStack` 的 `titleMap` 只有 shell / write_file / edit_file 三项（`ApprovalStack.vue:95-99`），LOCAL 模式 MCP 审批下发的 `toolName` 是 `mcp:<serverName>`（`electron/main.cjs:2513` `requestToolApproval('mcp:' + mcp.serverName, ...)`），恰好不在表里，堆叠卡片全部显示「操作待审批」。

为什么性价比高：富视图骨架现成（新增视图是「抄同一条路」）；失败原因就是结果 JSON 里现成的 `error` 键，15 个函数照抄 `failureSuffix` / `summarizeHttpCall` 两个既有范本，不新增任何后端能力；图片的 `image_url` 已是可直接加载的静态地址（`toStaticUploadBase` 拼的 `{origin}/uploads/...`），前端 `el-image` 直接可用，不需要新接口、不需要 base64。

## 2. 需求描述

### 2.1 目标（全部要做）

| # | 优先级 | 目标 | 一句话验收 |
|---|---|---|---|
| 1 | P1 | `generate_image` / `edit_image` 卡片渲染图片网格（prompt 头行 + 图片缩略 + 点击放大 + 大小/mime 角标 + 底栏摘要），空 `images` / 非数组 / 解析失败回落原始 JSON | 画图后不展开 JSON 也能看到图 |
| 2 | P1 | `tool-result-summarizer.ts` 15 个函数的失败摘要统一接上原因（A 类 7 个函数补 error 检查、B 类 8 个函数把裸 `(失败)` 换成 `(失败: 原因)`），成功路径输出逐字节不变 | 任何工具失败，卡片头都能看出「失败了 + 为什么」 |
| 3 | P2 | `ask_user_questions` 已回答的问答对富视图（问题 → 选中标签 chip → 自定义输入引用块），多选标签全展示 | 回看时一眼知道当时选了什么 |
| 4 | P2 | `check_subagent` / `wait_subagents`(超时分支) 的 `background_subagents[]` 进度行富视图（agentType + status 徽标 + 轮数/工具数/token + recentOutput 折叠区） | 不展开 JSON 能看到每个子代理跑到哪 |
| 5 | P2 | `getToolInputPreview` 补 7 个 case（§3.4 定案清单），消掉这 7 个工具的「参数加载中...」假象 | 流式期卡片头直接显示任务名/任务号/文件名 |
| 6 | P2 | `ApprovalStack` 支持 `mcp:` 前缀标题解析：`mcp:<server>` → 「MCP <server> 待审批」 | MCP 审批堆叠能看出在等哪个 server |

### 2.2 非目标（明确不做，理由见 §9）

- 不做 `no-progress-notice` 的图片结果归一化（`image_url` 随机文件名导致重复生成不触发止损）——真 bug 但改的是 guard 核心判定口径，**另立专项**。
- 不给后端工具结果加顶层 `media_type` / `data_uri`（改了会变更模型可见载荷与 no-progress digest，本方案走纯前端视图）。
- 不做 admin 端工具富视图。
- 不新增/不修改任何内置工具、不碰 `ToolRegistry`、不改探针与审批判定逻辑。
- `wait_subagents` 的 `results[]` 数组不做富渲染（勘误，见 §3.2）。
- `list_scheduled_tasks` / `wait_subagents` 不加输入预览 case（§3.4）。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 图片网格单次渲染上限 | **9 张（3×3）**，超出渲染前 9 张并在网格尾行显示「共 N 张，其余 N-9 张略」；`preview-src-list` 同样只含前 9 张 | 提案 §6 风险对策已按 9 张口径写（长会话滚动性能护栏）；`n` 入参上限 10，9 张覆盖绝大多数单次出图 |
| D2 | `recentOutput` 默认态 | **默认折叠**为单行省略（CSS ellipsis），行尾「展开/收起」文字按钮切换；展开态 `max-height:160px` 滚动 | 后台子代理是低频查看场景（提案 §8.2 倾向折叠）；折叠保住多任务列表的行密度，展开交互与卡片既有 `showRawIo` 按钮口径一致 |
| D3 | `wait_subagents` 的 `results[]` 是否同款渲染 | **不做**。进度行只渲染 `background_subagents[]`（`check_subagent` 无参形态与 `wait_subagents` 超时分支同形状）；`wait_subagents` 只补底栏汇总（`完成 N 个 · 全部完成/已超时`），`results[]` 留在原始 JSON 展开区 | 勘误：`results[]` 条目是每个子代理**自由格式的结果 JSON**（`background-subagent-tools.ts:228-231` 逐条 `JSON.parse(consumeResults)`，形状因任务而异），不是 `BackgroundProgress`，强行套进度行会渲染出垃圾。数据形状见 §3.2 勘误 2 |
| D4 | 图片预览加载策略 | `el-image` `lazy` + 固定缩略高度（`object-fit:contain`，容器高 160px）+ `preview-src-list` 点击放大 + `preview-teleported`（与 read_file 图片预览同款 :148-157） | 长会话滚动性能；浏览器原生放大，无新接口 |
| D5 | `image_url` 加载失败降级 | `el-image` error 槽渲染「图片不可达」+ 路径文本 + 复制路径按钮（用 `image_path`），不白屏 | LOCAL / 反代下 `/uploads/` 静态地址可能不可达；结果里必有 `image_path` 兜底 |
| D6 | 新视图组件化 | 新建 3 个组件 `ToolImageGenView.vue` / `ToolAskUserView.vue` / `ToolSubagentProgressView.vue`（与既有 8 个富视图同模式），`ToolCallCard` 只保留 view model computed 与模板分支 | 既有 8 个视图全部组件化，`ToolCallCard` 已 1000+ 行，不再内联 |
| D7 | 可测性抽取 | 三个 view model 的数据解析/组装抽成纯函数放 `desktop/src/utils/toolRichView.ts`（`parseImageGenItems` / `parseAskUserPairs` / `parseSubagentProgressRows` / `formatImageBytes`），SFC computed 只做接线；配 `toolRichView.test.ts` | 既有 8 个视图无组件挂载测试先例，不为 ToolCallCard 新增挂载测试；纯函数层用 vitest 锁住形状解析与截断口径 |
| D8 | 审批标题实现 | 新建 `desktop/src/utils/approvalTitle.ts` 纯函数 `resolveApprovalTitle(toolName): string`（titleMap 迁入 + `mcp:` 前缀解析），`ApprovalStack` 改为引用；配 `approvalTitle.test.ts` | SFC 内部 const 不可单测；抽纯函数后 `mcp:server` → `MCP server 待审批`、三项静态标题、未知回落「操作待审批」三条断言都能锁住 |
| D9 | 失败摘要实现口径 | A 类在函数解析出 `node` 后、任何成功统计之前插入 `const failure = failureSuffix(node); if (failure) return \`${label}${failure}\`;`（与 `summarizeReadFile` 等五处逐字同构）；B 类把 `return \`${label} (失败)\`` 换成 `const suffix = failureSuffix(node); return suffix ? \`${label}${suffix}\` : \`${label} (失败)\`;` | A 类 error 优先于一切成功统计；B 类兜底保留裸 `(失败)`（钉钉/飞书存在 `success===false` 且无 `error` 键的形态，此时没有原因可给，不能输出空括号） |

### 3.2 对提案的两处勘误（已按源码修正，随本方案落定）

1. **`subagent_followup` 不缺输入预览**：提案 §1.4 把它列进预览缺口，但其入参是 `{child_session_id, task}`（`background-subagent-tools.ts:94-103`），`getToolInputPreview` 通用回落 :179-187 对 `task` 键已生效（delegate 族当年修的就是这条路径）。本轮不为它加 case。
2. **`results[]` 不是进度形状**（见 D3）：提案目标 4 写「`wait_subagents` 的 `results` 数组顺带同款渲染」，源码里 `results[]` 是子代理结果载荷的数组而非 `BackgroundProgress[]`；进度行渲染对象改为 `background_subagents[]`（`wait_subagents` 仅超时分支携带该键，`background-subagent-tools.ts:238-240`）。
3. 附带修正：定时任务工具的 id 入参键是 **`task_id`**（`scheduled-task-tools.ts:149`/`:195`），update/delete 并不要求 `name`（提案写「入参 name」）；预览 case 按 §3.4 的精确键位实现。

### 3.3 失败摘要 15 个函数的精确改动（P1 目标 2 的落地口径）

A 类（补 error 检查，7 个函数 / 8 个输出点位）：

| 函数 | 失败时改前 | 改后（示例） |
|---|---|---|
| `summarizeShell` exec 段 :261-263 | `执行 xxx (exit -1)` | `执行 xxx (失败: 命令被拒绝执行策略)`；插入位置在 `async`/`completed` 判定之前——errorJson 失败不含这两个键，`completed=false` 超时维持 `(未完成/超时)`、`{exit_code:N≠0}` 维持 `(exit N)` 均不变 |
| `summarizeShell` write_stdin 段 :240-251 | `写入 stdin: xxx`（无任何失败标识） | `写入 stdin: xxx (失败: 会话不存在)`；插在 `completed` 判定之前 |
| `summarizeWebSearch` :401-407 | `搜索 xxx (0 条结果)` | `搜索 xxx (失败: 无可用搜索凭据)` |
| `summarizeOpenWebPage` :409-415 | `打开网页` | `打开网页 example.com/xx (失败: 页面加载超时)`（失败行带 args 里的 url，`formatUrl` 截 40） |
| `summarizeCreateScheduledTask` :496-505 | `创建定时任务` | `创建定时任务 xxx (失败: cron 表达式无法解析)`（带 args 里的 name，截 20） |
| `summarizeUpdateScheduledTask` :507-520 | `更新定时任务` | `更新定时任务 (失败: 任务不存在)` |
| `summarizeDeleteScheduledTask` :522-528 | `删除定时任务` | `删除定时任务 (失败: 任务不存在)` |
| `summarizeListScheduledTasks` :530-538 | `查询定时任务` | `查询定时任务 (失败: 无法获取当前用户信息)` |

B 类（裸 `(失败)` → `(失败: 原因)`，8 个函数）：`summarizeGenerateImage` :443、`summarizeEditImage` :455、`summarizeSendWechatImage` :467、`summarizeSendWechatFile` :486、`summarizeDingtalkTool` :547、`summarizeFeishuTool` :566、`summarizeMcpCall` :596、`summarizeMcpDescribe` :604。统一按 D9 的 B 类写法改；图片两函数失败路径顺带带上 prompt（改前是丢 prompt 的 `生成图片 (失败)`，改后 `生成图片: xxx (失败: 原因)`）。成功路径与既有 spec 全量保留。

### 3.4 输入预览 7 个 case 的精确键位（P2 目标 5）

| 工具 | 取值 | 空值回落 |
|---|---|---|
| `check_subagent` | `task_id` → `任务 #N` | 无 `task_id`（列出全部）→ `''` |
| `cancel_subagent` | `task_id` → `任务 #N` | ——（schema required） |
| `create_scheduled_task` | `name` → 截 30 字符 | `''` |
| `update_scheduled_task` | `name` 优先（截 30），否则 `任务 #<task_id>` | `''` |
| `delete_scheduled_task` | `任务 #<task_id>` | `''` |
| `send_wechat_image` | `image` 原值（与 `feishu_send_image`/`dingtalk_send_image` case 同口径） | `''` |
| `send_wechat_file` | `file_name` 优先，否则 `file`（与 `feishu_send_file` case 同口径） | `''` |

不做 case：`list_scheduled_tasks`（空入参，无可展示）、`wait_subagents`（仅 `timeout_seconds`，信息量低）、`subagent_followup`（勘误 1，通用回落已覆盖）。

## 4. 实现步骤

### 步骤 1：后端失败摘要统一（P1 目标 2）

1. 按 §3.3 表改 `backend-ts/src/session/util/tool-result-summarizer.ts`：A 类 7 函数插入 `failureSuffix` 早退（`summarizeShell` 注意 exec/write_stdin 两段与插入优先级），B 类 8 函数换 D9 写法。
2. 新建/并入 `backend-ts/src/session/util/tool-result-summarizer.spec.ts`：15 个函数各 1 条 `{error:'…'}` 失败用例（断言含原因前 40 字）；A 类负断言（不含 `(0 条结果)`、`(exit -1)`）；shell 特例 3 用例（`{error}` 无 exit_code / `{completed:false}` / `{exit_code:2}`）；既有成功用例全量保留（逐字节不变断言）。
3. 验证：`cd backend-ts && npx vitest run src/session/util/tool-result-summarizer.spec.ts`；`npm run build`。

### 步骤 2：前端解析纯函数层（D7）

1. 新建 `desktop/src/utils/toolRichView.ts`：
   - `formatImageBytes(bytes)`：B/KB/MB（`Math.floor` 口径与后端 `formatFileSize` 一致）。
   - `parseImageGenItems(node)`：校验 `node.images` 为非空数组且首项含 string `image_url`，返回 `{prompt, model, size, items:[{url, path, bytesLabel, mimeTag}], hiddenCount}`（items 截前 9，`mimeTag` 取 `image/png` → `PNG`，`size_bytes` 非有限数时不给角标）；不满足返回 null。
   - `parseAskUserPairs(node)`：`answers` 数组逐项取 `{question, labels: selectedLabels ?? [], customInput: customInput ?? ''}`，`question` 非空才收；空数组/null 返回 null。
   - `parseSubagentProgressRows(node)`：接受 `background_subagents` 数组形态与单对象形态（`taskId` 或 `status` 键存在时包成单元素数组），逐项组装 `{taskId, agentType, status, statusKind, stats, recentOutput}`（`statusKind`: RUNNING→running / COMPLETED→ok / FAILED→fail / CANCELLED→muted / 其余→muted；`stats` 由非空字段拼 `N 轮 / M 次工具 / X+Y tok`）。
2. 新建 `desktop/src/utils/toolRichView.test.ts`：三解析函数的正常 / 空 / 形状不符 / 截断（images 12 项 → items 9 + hiddenCount 3）/ 多选标签 / 单对象 check 形态用例。
3. 验证：`npx vitest run src/utils/toolRichView.test.ts`。

### 步骤 3：图片生成视图（P1 目标 1）

1. 新建 `desktop/src/components/chat/ToolImageGenView.vue`：props `{view}`（步骤 2 的返回值）；模板 = prompt 头行（墨色 `--aw-ink`，同 webPageView 查询行口径）+ `display:grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr))` 图片网格（`el-image` `lazy` + `fit="contain"` + `preview-src-list` 全 items + `preview-teleported`，容器高 160px；角标 `bytesLabel · mimeTag`；error 槽按 D5 降级）+ `hiddenCount > 0` 时尾行提示。
2. `ToolCallCard.vue` 接线：新增 `imageGenView` computed（`name === 'generate_image' || name === 'edit_image'` 时 `parseImageGenItems(parseResultNode(result))`）；`richView` / `richSummary` 链尾追加（D6）；模板分支插在 `webPageView` 之后；底栏摘要 `N 张图 · model · size`；`richBadge` 不动（本视图无 exit 徽标）。
3. 确认与既有图片链路无冲突：这两个工具结果无顶层 `media_type`/`data_uri`，`imagePreviewUrl` 恒为空，非富图片块（:146-169）不会渲染；`fileView` 的 `imagePreviewUrl` 互斥判断不受影响。
4. 验证：`cd desktop && npm run build`。

### 步骤 4：问答回放视图（P2 目标 3）

1. 新建 `desktop/src/components/chat/ToolAskUserView.vue`：props `{view}`；每组问答渲染问题一行（`--aw-ink` 13px）+ 选中标签 chip 行（chip 样式对齐 `QuestionPanel.vue:406-414` `question-tag`：`color-mix(primary 10%)` 底 + primary 文字）+ `customInput` 非空时引用块（左侧 2px primary 竖线）。
2. `ToolCallCard.vue` 接线：`askUserView` computed（`name === 'ask_user_questions'` 且 `parseAskUserPairs` 非空）；`richView`/`richSummary` 链尾追加；`richSummary` 给 `N 组问答`。
3. 验证：`npm run build`。

### 步骤 5：子代理进度视图（P2 目标 4）

1. 新建 `desktop/src/components/chat/ToolSubagentProgressView.vue`：props `{view}`；每行 = `#taskId`（等宽）+ `agentType` + status 徽标（running=primary / ok=成功绿 / fail=`--aw-danger` / muted=灰）+ `stats` 行 + `recentOutput` 折叠区（D2：单行 ellipsis + 展开/收起按钮，展开态 160px 滚动，等宽字体）。
2. `ToolCallCard.vue` 接线：`subagentProgressView` computed（`name === 'check_subagent' || name === 'wait_subagents'` 时 `parseSubagentProgressRows`；`wait_subagents` 仅当其 `background_subagents` 键存在——即超时分支——才产出行）；`richView`/`richSummary` 链尾追加；`richSummary`：check 给 `N 个任务`，wait 给 `完成 N 个 · 全部完成/已超时`（取 `completed`/`all_completed`/`timed_out`）。
3. 验证：`npm run build`。

### 步骤 6：输入预览补全（P2 目标 5）

1. `desktop/src/utils/toolDisplay.ts` 的 `getToolInputPreview` switch 按 §3.4 表补 7 个 case（放在 page_* case 之前、mcp/http case 之后；数值键 `task_id` 做 `Number.isInteger(N) && N > 0` 校验）。
2. `desktop/src/utils/toolDisplay.test.ts` 补用例：7 工具各 1 正例 + 缺参/非法类型回落 `''` + `subagent_followup` 通用回落回归（勘误 1 锁死）。
3. 验证：`npx vitest run src/utils/toolDisplay.test.ts`。

### 步骤 7：MCP 审批标题（P2 目标 6）

1. 新建 `desktop/src/utils/approvalTitle.ts`：迁入 `titleMap` 三项 + `resolveApprovalTitle(toolName)`（命中 titleMap 原样返回；`mcp:` 前缀 → `MCP <suffix> 待审批`；其余 → `操作待审批`）。
2. `ApprovalStack.vue`：两处 `titleMap[item.toolName] || '操作待审批'`（:14、:22）改为 `resolveApprovalTitle(item.toolName)`，删除文件内 titleMap。
3. 新建 `desktop/src/utils/approvalTitle.test.ts`：`shell`/`write_file`/`edit_file` 三静态项、`mcp:github` → `MCP github 待审批`、`mcp:` 空后缀 → `操作待审批`、未知工具回落。
4. 验证：`npx vitest run src/utils/approvalTitle.test.ts && npm run build`。

### 步骤 8：CHANGELOG 与全量验证

1. `CHANGELOG.md` 新增 `## 0.0.468 (日期)`：「后端」一条（15 处失败摘要补原因，成功路径不变）+「前端（桌面 / Web）」一条（图片网格视图 / 问答回放 / 子代理进度行 / 输入预览补全 / MCP 审批标题）。
2. 全量验证：`cd backend-ts && npm run build && npm test`（日志落盘后 grep 摘要）；`cd desktop && npm run build && npx vitest run`。
3. 提交：`feat(desktop): 工具卡片完整化——图片可见/失败摘要统一/问答与子代理回放（0.0.468）`，推 origin/main。

## 5. 落地清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `backend-ts/src/session/util/tool-result-summarizer.ts` | 15 个函数失败摘要（§3.3），纯文案 | 1 |
| `backend-ts/src/session/util/tool-result-summarizer.spec.ts` | 新建/并入：15 失败用例 + A 类负断言 + shell 3 特例 | 1 |
| `desktop/src/utils/toolRichView.ts` | 新建：4 个纯函数（D7） | 2 |
| `desktop/src/utils/toolRichView.test.ts` | 新建：解析/截断/形状用例 | 2 |
| `desktop/src/components/chat/ToolImageGenView.vue` | 新建：图片网格视图（D1/D4/D5） | 3 |
| `desktop/src/components/chat/ToolAskUserView.vue` | 新建：问答对回放视图 | 4 |
| `desktop/src/components/chat/ToolSubagentProgressView.vue` | 新建：子代理进度行视图（D2） | 5 |
| `desktop/src/components/chat/ToolCallCard.vue` | 3 个 computed + 3 个模板分支 + richView/richSummary 链尾追加 | 3~5 |
| `desktop/src/utils/toolDisplay.ts` | 7 个预览 case（§3.4） | 6 |
| `desktop/src/utils/toolDisplay.test.ts` | 追加 case 用例 + subagent_followup 回归 | 6 |
| `desktop/src/utils/approvalTitle.ts` | 新建：标题解析纯函数（D8） | 7 |
| `desktop/src/utils/approvalTitle.test.ts` | 新建：4 类断言 | 7 |
| `desktop/src/components/chat/ApprovalStack.vue` | titleMap 迁出，两处引用改为 `resolveApprovalTitle` | 7 |
| `CHANGELOG.md` | 0.0.468 两条（后端 / 前端） | 8 |

不动：`generate-image-tool.ts` / `edit-image-tool.ts` / `ask-user-questions-tool.ts` / `background-subagent-tools.ts` / `scheduled-task-tools.ts`（结果契约零改动）、`tool-image-result-processor.ts`（WS 预览链路零改动）、`no-progress-notice.ts`（另立专项）、admin 端、数据库迁移（零）。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 图片网格拖慢长会话滚动 | D1 上限 9 张 + D4 `lazy`/固定缩略高 |
| 改 summarizer 文案影响下游消费（模型上下文不含摘要——摘要仅落 `tool_calls.summary` 展示列；admin/回放均读同一列，只读不改判定） | 成功路径逐字节不变 + spec 逐字节断言 |
| `image_url` 在 LOCAL/反代下不可达 | D5 error 槽降级 + `image_path` 复制 |
| 三个新视图撑大 `ToolCallCard.vue` | D6 组件化 + 链尾追加不影响既有分支优先级（`richView` 是 `??` 链，新视图工具名与既有八类零交集） |
| `mcp:` 前缀解析与未来命名变化耦合 | 只做前缀命中取后半段；未命中维持「操作待审批」；`approvalTitle.test.ts` 锁行为 |
| `wait_subagents` 超时分支之外无进度行可渲染 | 行为明确：非超时结果只有 `results[]`，卡片保持原始 JSON 展开（D3 已定案，不视为缺陷） |

## 7. 测试要点

自动（见步骤 1/2/6/7 的 spec 清单）：15 个失败摘要用例与负断言、成功路径逐字节、shell 三特例、三个解析函数的正常/空/形状不符/截断、7 个预览 case 正反例、`subagent_followup` 通用回落回归、`resolveApprovalTitle` 四类断言。

手工验收（构建后本地走查）：

1. 让 Agent 画一张图：卡片默认折叠态摘要为「生成图片: xxx (N 张)」，展开看到网格，点击放大、角标大小正确；改 `edit_image` 同验。
2. 构造失败（停用搜索凭据 / 错误 cron / 私网 URL）：卡片头分别为「搜索 xxx (失败: …)」「创建定时任务 xxx (失败: …)」「打开网页 … (失败: …)」，无 `(exit -1)` / `(0 条结果)`。
3. 让 Agent 提问并回答后回看会话：问答卡片显示选中 chip 与自定义输入。
4. 后台子代理运行中 `check_subagent`：进度行显示 RUNNING 徽标与轮数，recentOutput 折叠；完成后再看变 COMPLETED。
5. LOCAL 模式触发一次 MCP 工具审批：堆叠卡标题「MCP <server> 待审批」。

## 8. 决策记录（原提案 §8 三个待评审项 → 定案）

1. **图片上限**：9 张（3×3）。见 D1。
2. **recentOutput 默认态**：折叠。见 D2。
3. **wait_subagents 的 results**：本轮不做富渲染，只做底栏汇总 + 超时分支的 `background_subagents[]` 进度行。见 D3（依据：results 条目是自由格式子代理结果，非进度形状）。

## 9. 明确不做的（汇总）

1. `no-progress-notice` 图片归一化（含 `VOLATILE_RESULT_KEYS` 补 `image_url`/`image_path`）——改 guard 判定口径，另立专项。
2. 后端工具结果契约变更（顶层 `media_type`/`data_uri` 等）——模型可见载荷与 digest 会跟着变，本方案纯前端视图。
3. admin 端富视图移植。
4. 新增/修改内置工具与审批判定逻辑。
5. `wait_subagents` 的 `results[]` 富渲染（D3）。
6. `list_scheduled_tasks` / `wait_subagents` / `subagent_followup` 的输入预览 case（§3.4：前两者无有效信息可展示，后者已有通用回落）。
7. CLOUD 端 `mcp_call` 服务侧审批的标题细分——后端审批载荷的 toolName 未携带具体 server.tool，只换文字不换信息量；待后端把目标写进审批载荷再立项（本方案只处理 LOCAL 链路的 `mcp:<server>` 前缀）。
