# 评审：工具结果表格化视图技术方案（Round 1）

- 评审对象：docs/plan/2026-11-10-tool-result-table-view-technical-design.md、docs/proposals/2026-11-10-tool-result-table-view.md
- 评审日期：2026-11-10。方案未实现，纯纸面评审 + 代码事实核对 + 判定规则模拟。
- 结论先行：**无【可行性阻塞】级问题**——方案按「唯一数组字段」口径可以实现；但存在 2 个高严重度【设计错误】：①包裹键白名单与全部四个旗舰工具的真实返回形状冲突（按字面实现 = 提案验收标准 1 无法达成）；②自定义 HTTP 工具结果的真实包裹形状使提案用户故事 2 完全不可达。两者动手前必须定案修正。

## 1. 结论

| 类别 | 计数 |
|---|---|
| 可行性阻塞 | 0 |
| 设计错误 | 3（高 2、低 1） |
| 规格缺口 | 3（中 2、低 1） |
| 表述问题 | 2（中 1、低 1） |

最严重的问题：

1. **#1 包裹键白名单漏掉全部旗舰工具**：`task_list`/`list_scheduled_tasks`/`list_signal_watchers`/`dump_user_messages` 的真实包裹键是 `todos`/`tasks`/`watchers`/`files`，全不在白名单 `records/items/results/data/list/rows` 内。按白名单硬门槛实现，提案 §5 验收标准 1（三个内置工具 20 条记录可切表格）无法达成，且与设计自身 §7.6 的组件测试互相矛盾。
2. **#2 自定义 HTTP 工具结果不可达**：`http_call` 的结果恒为 `{status, body:<字符串>, truncated, displayName}`（body 是转义后的响应文本字符串），顶层无数组字段，两种判定口径都 MISS。提案用户故事 2「自定义 HTTP 工具返回 `{records:[...]}` 包裹的数组同样可转表格」与真实结果形状不符。

## 2. 问题表

| # | 位置 | 类别 | 严重度 | 一句话 |
|---|---|---|---|---|
| 1 | 设计 §3 接受形态② / §7.2；提案 §2 故事2、§5 验收1 | 设计错误 | 高 | 包裹键白名单（records/items/results/data/list/rows）与四个旗舰工具的真实包裹键（todos/tasks/watchers/files）全部对不上，且与设计自身的测试计划矛盾 |
| 2 | 设计 §1、§2 故事2；提案 §1、§2 故事2 | 设计错误 | 高 | http_call 结果是 `{status, body:字符串, truncated, displayName}`，body 是转义字符串而非数组，用户故事 2 的「识别单一数组字段的包裹对象」永不命中 |
| 3 | 设计 §4.2.3 | 规格缺口 | 中 | 表格态只说「原文 pre v-show=false」，未定义同 wrapper 内绝对定位的「复制完整输出」按钮与下方「展开完整输出」行的去留，字面实现会残留悬浮按钮 |
| 4 | 设计 §4.2.3 | 规格缺口 | 中 | 容器 `max-height:360px; overflow:auto` 使 TableGrid 的 sticky 表头失效（sticky 锚定内层不滚动的 scroll 容器），与「复用中心 Tab 表格观感」的意图相悖 |
| 5 | 设计 §3 决策、§4.2.2 | 表述问题 | 中 | 「包裹键候选」语义悬置：硬门槛还是仅示例？与问题 1 同根，必须定案一种并写死 |
| 6 | 设计 §4.2.2 | 表述问题 | 低 | 「el-segmented 或两枚 icon button」A-or-B 未定案（ElSegmented 在 element-plus 2.14.0 可用且仓库已有用例，应定一个） |
| 7 | 设计 §3 切换态记忆 | 表述问题 | 低 | 键名 `aw-tool-result-view.<toolName>` 发明第三种风格：仓库静态偏好键是 `aw-*`、动态键统一 `mao:<name>:<id>` 且写侧走 safeSetItem |
| 8 | 设计 §6 风险表；提案 §4 | 设计错误 | 低 | 「E2E 工具卡既有断言为门」「E2E 现有断言（含工具卡用例）」不成立：tests/ 下所有 spec 无任何工具卡断言，实际门是 ToolCallCard.test.ts 单测 |
| 9 | 设计 §3 规模上限 | 规模缺口 | 低 | 「行 ≤201 与 TableGrid 虚拟滚动阈值 200 口径对齐」差一行：virtual 需 bodyRows>200（总行 ≥202），201 总行永不触发虚拟滚动；且 max-height 360px 与既有 200px（.result-content）不符 |
| 10 | 设计 §7 测试要点 | 规模缺口 | 低 | 后端截断（resultTruncated）的 JSON 解析必然失败→无按钮：行为可接受但未声明，建议补一条测试钉死 |

## 3. 逐问题详述

### #1（高）包裹键白名单与真实工具形状全面冲突【设计错误】

**证据（逐个工具读后端实现确认顶层形状）：**

| 工具 | 结果顶层形状 | 证据 | 白名单判定 |
|---|---|---|---|
| `task_list` | `{todos: [...], progress: string, hint?: string}` | backend-ts/src/harness/tool/impl/task-tools.ts:126-133（`result = { todos, progress }`，hint 条件加） | `todos` 不在白名单 → 按硬门槛 MISS |
| `task_create` / `task_update` / `task_delete` | `{todos: [...], message/summary/hint?}` | task-tools.ts:89-93、:226-242、:312 | 同上 MISS |
| `list_scheduled_tasks` | `{tasks: [...], total: number}` | backend-ts/src/harness/tool/impl/scheduled-task-tools.ts:134（`toJson({ tasks, total: tasks.length })`） | `tasks` 不在白名单 → MISS |
| `list_signal_watchers` | `{total: number, watchers: [...]}` | backend-ts/src/harness/tool/impl/signal-watcher-tools.ts:36-54 | `watchers` 不在白名单 → MISS |
| `dump_user_messages` | `{files: [...], count: number, message: string}` | backend-ts/src/harness/tool/impl/dump-user-messages-tool.ts:222（`toJson({ files, count, message })`） | `files` 不在白名单 → MISS |
| `wait_subagents`（非超时） | `{completed, results: [...], timed_out, all_completed}` | backend-ts/src/harness/tool/impl/background-subagent-tools.ts:232-241 | `results` 在白名单 → HIT（唯一命中白名单的内置工具） |
| MCP 工具 | `structuredContent` 原样 stringify，可为裸数组或任意包裹 | backend-ts/src/harness/mcp/mcp-client-manager.ts:290-293 | 裸数组走形态①HIT；包裹键取决于 MCP 服务器，白名单不可控 |

**模拟验证**（/tmp/try-parse-table-sim.mjs，按设计 §3 规则逐字实现两种口径跑真实形状）：

```text
口径 A（白名单硬门槛）：
MISS  task_list / list_scheduled_tasks / list_signal_watchers / dump_user_messages → 全部 null
HIT   wait_subagents 非超时、MCP 裸数组、{records:[...]} 造形

口径 B（唯一数组字段 + 其余全标量，白名单仅注释）：
HIT   task_list(3行×13列) / list_scheduled_tasks(2行×22列) / list_signal_watchers(2行×12列)
HIT   dump_user_messages(2行×3列) / wait_subagents 非超时 / MCP 裸数组
```

**矛盾链**：设计 §2 用户故事 1 要求 `task_list` 20 条可切表格 → 提案 §5 验收标准 1 点名 `task_list`/`list_scheduled_tasks`/`list_signal_watchers` → 白名单不收 `todos`/`tasks`/`watchers` → 按字面实现验收必挂。同时设计 §7.6 的组件测试用「假 task_list 结果（3 条）→ 按钮出现」——按白名单这条测试自身就过不了，说明白名单并非刻意取舍而是笔误级遗漏。

**修复方向**：定案为「唯一数组字段 + 其余字段全为标量」单一规则（口径 B），删除白名单（或把白名单降级为注释性说明）。已核对该规则不会误拒旗舰工具：`{tasks,total}`、`{todos,progress,hint}`、`{total,watchers}`、`{files,count,message}` 均满足「恰一个数组字段 + 其余全标量」；`ScheduledTask`（scheduled-task.service.ts:14-42）、`SessionTodo`（harness/todo/entity/session-todo.ts:1-15）、watcher 映射对象（signal-watcher-tools.ts:39-53）元素全为标量字段，扁平度判定全部通过。

### #2（高）http_call 的 body 是字符串，用户故事 2 不可达【设计错误】

**证据**：

- backend-ts/src/harness/tool/impl/http-api-executor.ts:223：`return { status, body: text, truncated, displayName: tool.displayName };` — 响应体以**字符串**放进 `body`。
- backend-ts/src/harness/tool/impl/http-api-tools.ts:173：`return JSON.stringify(await executor.execute(...));` — 卡片拿到的 result 文本即 `{"status":200,"body":"{\"records\":[...]}","truncated":false,"displayName":"..."}`。
- WS 通路无中间解包：backend-ts/src/session/ws/ws-streaming-event-listener.ts:129-133 只做 stripPrivateDiff + 图片处理，原样下发 `result`。
- 前端 `tryParseTable`（设计 §3）对该形状：顶层对象、数组字段 0 个（`body` 是 string）→ 两种口径都返回 null。

**影响**：提案 §2 用户故事 2「自定义 HTTP 工具返回 `{ records: [...] }` 包裹的数组 → 同样可转表格」按现方案永不成立——`{records:[...]}` 实际嵌在转义的 `body` 字符串里，外面还套着 status/truncated/displayName 三个标量。设计 §1「自定义 HTTP 工具与 MCP 工具返回的任意 JSON 数组」的动机陈述同样失真（MCP 半真：structuredContent 可直达数组；http_call 全假）。

**修复方向**（二选一，须定案写进设计）：①卡片侧按 `toolCall.name === 'http_call'` 特判，先 `JSON.parse(body)` 再走形态判定（前端解析，不违反 §9「服务端表格化不做」）；②明确降级：首版不支持 http_call 结果表格化，从用户故事与动机里删掉自定义 HTTP 工具，避免验收时才发现。

### #3（中）表格态下原文区附属控件的去留未定义【规格缺口】

设计 §4.2.3 只说「原文 `<pre>` 在该态 `v-show=false` 保留 DOM」。但 :167 的 `.code-block-wrapper` 内除 pre 外还有一个**绝对定位**的「复制完整输出」按钮（ToolCallCard.vue:167-171；.copy-btn 为 `position:absolute; top:6px; right:6px`，:893-910）——只对 pre 做 v-show，wrapper 高度塌缩后按钮仍渲染，会残留一个悬浮的复制按钮。另外 wrapper 下方的「展开完整输出」行（:173-177，`isResultTruncated` 时出现）设计也未提及：表格态下它仍然可见，点了只影响被隐藏的 pre，交互语义混乱。

**修复方向**：写明表格态隐藏整个 `.code-block-wrapper`（v-show 上移到 wrapper），并定案「展开完整输出」行在表格态隐藏（表格展示的是完整数据，无需展开入口）；「复制完整输出」与「复制为 CSV」二选一保留也要定案。

### #4（中）外层 overflow:auto 使 TableGrid sticky 表头失效【规格缺口】

**证据**：TableGrid.vue:116-120 `.table-grid-scroll { flex: 1; min-height: 0; overflow: auto; }`、:131-142 `thead th { position: sticky; top: 0; ... }`。`overflow:auto` 使 `.table-grid-scroll` 自身成为 sticky 的锚定 scroll 容器——即便内容不溢出。按设计 §4.2.3 的「容器 max-height:360px; overflow: auto」，滚动发生在外层 wrapper，内层 scroll 容器永不滚动 → 表头不吸附，滚动后列名消失。中心 Tab 里 TableGrid 的父级是定高 flex 容器、由内层滚动，sticky 才成立；两种挂载方式观感不同。

**修复方向**：工具卡容器改为定高 flex（`display:flex; max-height:360px`），不加 overflow，让 `.table-grid-scroll` 自己滚（flex:1/min-height:0 在 flex 父级下即生效，sticky 表头保持）；或明确接受「表头不吸附」并写进设计。

### #5（中）「包裹键候选」语义悬置【表述问题】

设计 §3 接受形态②原文：「顶层为对象且恰有一个数组字段、其余字段全为标量，取该数组按 ① 判定（包裹键候选：`records`/`items`/`results`/`data`/`list`/`rows`）」。「候选」既可读成硬门槛（数组字段键名必须在六个之内）也可读成示例枚举。这是问题 #1 的表述根因：若实现者按硬门槛读，旗舰工具全灭；按示例读，白名单六键毫无约束力、纯误导。仓库文化（设计文档不写模糊表述、不做 A-or-B）要求定案一种。与 #1 一并修复：删白名单、只留「唯一数组字段 + 其余全标量」。

### #6（低）切换控件 A-or-B 未定案【表述问题】

§4.2.2「`el-segmented` 或两枚 icon button」。两者都可行：desktop/package.json element-plus `^2.14.0`（实装 2.14.0），`node_modules/element-plus/es/components/segmented` 存在，且仓库已有用例（desktop/src/views/settings/NotificationSettingsView.vue:23）。应定案一个（两态切换 + a11y 语义，`el-segmented` 更贴合；两枚 icon button 则须各自带 aria-label/title）。

### #7（低）localStorage 键风格与写侧惯例【表述问题】

仓库口径：静态偏好键 `aw-theme-mode`/`aw-accent`/`aw-font-scale`（theme.ts:67、appearance.ts:34-35）、`aw-code-word-wrap`（codeBlockCollapse.ts:21）；**动态键**统一 `mao:<name>:<id>` 冒号风格——`mao:center-active-tab:`（center-active-tab.ts:6）、`mao:closed-side-tasks:`（side-task-tabs.ts:3）。设计提出 `aw-tool-result-view.<toolName>`（aw- 前缀 + 点号 + 动态段）发明了第三种风格。写侧仓库已有统一兜底 `safeSetItem`（utils/safe-storage.ts:6-12，theme/appearance/center-active-tab/side-task-tabs 均走它），设计却说「读写 try/catch 包裹」自造轮子。修复方向：键名定 `mao:tool-result-view:<toolName>`（动态键家族），写侧复用 safeSetItem，读侧 try/catch 有 center-active-tab.ts:22-38 先例可循。

### #8（低）「E2E 工具卡既有断言为门」不成立【设计错误】

设计 §6 风险表「E2E 工具卡既有断言为门」、提案 §4「E2E 现有断言（含工具卡用例）全部为门」。实测 `grep -rn "tool-call-card|ToolCallCard|tool-card|工具卡" tests/*.spec.ts` 零命中——tests/ 目录（desktop.spec.ts 及 desktop-*.spec.ts 全部）没有任何工具卡断言。默认态不变的门实际只有单测 desktop/src/components/chat/ToolCallCard.test.ts（存在，可追加）。修复方向：把风险表里的回归门改为「ToolCallCard.test.ts 既有用例 + 新增用例」，或补一条工具卡 E2E——但按现状表述属于引用了不存在的安全网。

### #9（低）规模上限与 360px 的两处数字对不上【规格缺口】

- 「行（含表头）≤ 201 … TableGrid 的虚拟滚动阈值也是 200 行 … 口径对齐」：TableGrid.vue:72 `virtual = bodyRows.length > 200`，201 总行 = 200 body 行，`200 > 200` 为 false——虚拟滚动永不触发，「对齐」差 1。功能无损（200 行 × 30 列全量渲染无碍），但理由句是错的：要么上限改 ≥202（让虚拟滚动可达），要么如实写「上限刻意压在虚拟阈值内、全量渲染」。
- 容器 `max-height: 360px`（「对齐卡片内既有滚动观感」）：卡片内结果区既有滚动高度是 `.result-content { max-height: 200px }`（ToolCallCard.vue:991-999），chat 组件目录无 360px 出处（最近的是 FileReferencePanel 320px）。360px 是新决策却包装成「对齐既有」，且表格态卡片会比原文态高 80%——要么改 200px 真对齐，要么明写 360px 的选择理由。

### #10（低）后端截断结果的形态未声明【规格缺口】

`toolCall.resultTruncated`（后端在工具实现内截断输出，types/chat.ts:26-27）时 result JSON 常是截断的非法 JSON → `tryParseTable` 返回 null → 无按钮，回退原文。行为正确，但设计 §7 测试要点未覆盖，建议补一条「resultTruncated 的列表结果 → 无按钮、原文展示」钉死口径，防止实现者在截断文本上做部分解析。

## 4. 引用勘误

| 文档位置 | 写的 | 实际 |
|---|---|---|
| 设计 §3 表格渲染行 | TableGrid「props 就是 `rows: string[][]`，:44-48」 | defineProps 块在 :45-48（:44 是空行）；提案写的 :45-47 漏了 :48 的 `}>()` |
| 设计 §3 规模上限行 | `ROW_HEIGHT/VIRTUAL_THRESHOLD` :48-50 | 实际 :50-51（:52 是 OVERSCAN） |
| 设计 §3 复制 CSV 行 | `toCsv(rows: string[]): string` | 与 §4.1 的 `toCsv(rows: string[][]): string` 自相矛盾，后者正确（CSV 是二维行数组） |
| 设计 §4.2.3 | 容器 360px「对齐卡片内既有滚动观感」 | 既有是 `.result-content { max-height: 200px }`（ToolCallCard.vue:997），无 360px 出处 |

核对无误的引用：ToolCallCard.vue:133 与 :168 两处 `<pre class="result-content"><code>{{ displayResultText }}</code></pre>` ✓；:155 `v-if="(toolCall.result || imagePreviewUrl) && !richView"` ✓（提案原文引用一致）；parseResultNode :208-216 且拒绝数组 ✓；imagePreviewUrl :670-684 ✓；displayResultText :704-710、4000 字符截断 ✓；richView 链 :625-628 共 11 个视图（edit/shell/file/write/glob/grep/web_search/web_page/image/ask_user/check_subagent·wait_subagents）✓；showRawIo :664、showFullResult :702 ✓；TableGrid props 仅 rows ✓；toolDisplay.ts:1-40 的 TOOL_DISPLAY_NAMES ✓；批次 23 = CHANGELOG.md:245 的 0.0.468 ✓。

另：提案 §1「典型的表格形结果：`task_list` / `list_scheduled_tasks` / `list_signal_watchers` / `glob_search` / `grep_search` 等」——glob_search/grep_search（及 web_search/open_web_page）已是 richView 专用视图（ToolCallCard.vue:484-509、512-555），表格分支被 `!richView` 排除，永不出现切换按钮；提案把它们列为受益者是事实错误（设计文档 §1 未列它们，无此问题）。

## 5. 已核对无问题的点

1. **图片分支互斥完备**：`imagePreviewUrl` 双源（`toolCall.preview.data_uri` 与 result JSON `media_type==='image' && data_uri`，:670-684）。`{media_type:'image', data_uri:…}` 无数组字段 → `tryParseTable` 按形态②返回 null，两分支天然不重叠；理论上的双命中形态（media_type:'image' + data_uri + 数组字段）被设计规定的「imagePreviewUrl 为空才进表格」门槛挡住。且后端对图片结果本就剥 data_uri 进 preview、result 不含 data_uri（tool-image-result-processor.ts:47-57），真实形状下双命中不存在。互斥条件在实现层面成立。
2. **性能护栏成立**：卡片默认折叠（messages.ts:510/546/556、chatMessage.ts:125/137 全部 `isExpanded:false`），`tool-body` 是 `v-if="isExpanded && ..."`（:36），Vue computed 惰性求值——折叠卡不评估 `tableView`，不存在「几十张卡挂载即全量解析」；`result` 在 tool_call_result 事件一次性赋值（messages.ts:554），非增量流式，无「streaming 期间反复重解析」；1MB 长度上限 + 首字符预判在 JSON.parse 之前，护栏顺序正确。
3. **解析输入正确**：§4.2.1 明确对 `props.toolCall.result`（完整文本）而非 `displayResultText`（4000 截断）解析——超 4000 字符的列表结果仍可出表格，口径自洽。
4. **TableGrid 可复用**：props 仅 `rows: string[][]`（:45-48）；空 `rows` 渲染「无数据」（:37-38），与设计「空数组 → null」双保险一致；表头/数值列启发式/行高 32px 对工具卡尺寸无隐藏依赖（唯 sticky 一条见 #4）；`width:max-content` 宽表由容器横向滚动承接。
5. **形态②无误拒**：四个旗舰工具均为「恰一个数组字段 + 其余全标量」，实体字段全标量（ScheduledTask、SessionTodo、watcher 映射逐一核对）；「第二个数组字段整表拒绝」无真实受害者（wait_subagents 超时形态的 results+background_subagents 双数组本就被 richView 接管，不进表格分支）。
6. **ElSegmented 可用**：element-plus 2.14.0 含 segmented，仓库已在 NotificationSettingsView.vue:23 使用。
7. **测试落点存在**：ToolCallCard.test.ts、TableGrid.test.ts 均存在，§7 的追加计划可行。
8. **切回原文逐字节一致**：同一 `displayResultText` 数据源 + pre 保留 DOM（v-show），成立；「复制完整输出」按钮复制 `fullResultText` 的既有行为不受影响。

## 6. 实际执行的验证清单

1. 通读 docs/plan/2026-11-10-tool-result-table-view-technical-design.md、docs/proposals/2026-11-10-tool-result-table-view.md 全文。
2. 通读 desktop/src/components/chat/ToolCallCard.vue 全文（1025 行，含模板 :1-181、脚本 :183-722、样式 :724-1025），逐行核对设计引用的 :133/:155/:168/:208-216/:625-628/:670-684/:704-710。
3. 通读 desktop/src/components/center/TableGrid.vue 全文（203 行），核对 props、ROW_HEIGHT/VIRTUAL_THRESHOLD、虚拟滚动与 sticky 表头实现。
4. 逐个读后端工具实现核对结果形状：task-tools.ts（task_list/create/update/delete）、scheduled-task-tools.ts（list_scheduled_tasks）、signal-watcher-tools.ts（list_signal_watchers）、dump-user-messages-tool.ts、background-subagent-tools.ts（wait_subagents）、http-api-tools.ts + http-api-executor.ts（http_call）、page-tools.ts（截图形状）；核对实体 ScheduledTask（scheduled-task.service.ts:14-42）、SessionTodo（session-todo.entity）与 watcher 映射的扁平度。
5. 读 backend-ts/src/harness/mcp/mcp-client-manager.ts formatResult（:280-301）确认 MCP structuredContent 原样下发。
6. 读 backend-ts/src/session/ws/ws-streaming-event-listener.ts onToolCallResult（:126-150）确认卡片拿到的 result 无中间变换（仅剥 diff 与图片 data_uri）。
7. node 模拟脚本 /tmp/try-parse-table-sim.mjs：按设计 §3 逐字实现两种判定口径，对 9 个真实/造形输入跑判定（输出见问题 #1）。
8. localStorage 惯例：theme.ts、appearance.ts、codeBlockCollapse.ts、center-active-tab.ts、side-task-tabs.ts、safe-storage.ts、useTaskPanelPrefs.ts。
9. desktop/package.json + node_modules/element-plus 确认 2.14.0 与 segmented 组件存在；grep NotificationSettingsView.vue:23 的 el-segmented 先例。
10. 结果更新路径：stores/session/messages.ts updateToolCallResult（:519-563）、isExpanded 全路径默认 false；chatMessage.ts。
11. `grep tests/*.spec.ts` 工具卡断言（零命中）；ls desktop/src/components/chat/ 确认 ToolCallCard.test.ts 存在。
12. CHANGELOG.md:245 确认 0.0.468 批次 23 引用属实。
