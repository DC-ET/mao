# 工具结果表格化视图技术方案：列表类结果一键转表格

> 对应提案：[docs/proposals/2026-11-10-tool-result-table-view.md](../proposals/2026-11-10-tool-result-table-view.md)（批次 28）。零后端改动、零迁移、零新依赖；改动面收敛在 ToolCallCard 的原文结果区一个分支，默认态（原文）与现状逐字节一致。
>
> 评审注记（2026-11-11，事实链已逐条核实）：①数据链路可行性成立——工具结果到达 ToolCallCard 时为**完整文本**（实时链路 `agent-loop.ts` 传 rawResult、历史回放落库 content，`tool-result-summarizer` 只产出一行中文摘要不改写结果本体，`no-progress-notice` 只做无进展签名不改写），20 条任务的 `task_list` JSON（4-10KB）可被前端完整解析；②资产可复用成立——`TableGrid` props 同构、`aw-` 偏好键惯例、`el-segmented`（element-plus ^2.14.0，desktop 已有先例）、`ToolCallCard.test.ts`（jsdom）测试范本均在。行号基线：ToolCallCard.vue 共 1044 行（本次核实版本），下文行号以该版本为准。

## 1. 需求背景

工具卡的结果正文一律以纯文本呈现：`ToolCallCard.vue:143` 与 `:178` 两处 `<pre class="result-content"><code>{{ displayResultText }}</code></pre>`（4000 字符截断由 `displayResultText` computed :726-732 处理，只截显示文本；数据本身保持全文，原文态另有「展开完整输出」开关）。`richView` 链（:647-650）已为 edit_file / shell / read_file / write_file / glob_search / grep_search / web_search / open_web_page / generate_image·edit_image / ask_user_questions / check_subagent·wait_subagents 十一类结果提供了专用视图，**但「列表形 JSON 结果」没有视图**，典型如 `task_list` / `list_scheduled_tasks` / `list_signal_watchers` / `dump_user_messages`，以及自定义 HTTP 工具与 MCP 工具返回的任意 JSON 数组——用户只能在几十行 JSON 里数条目、对字段。

表格渲染资产已存在且零依赖可复用：`components/center/TableGrid.vue`（props 就是 `rows: string[][]`，:45-48，首行按表头渲染，自带数值列右对齐启发式与 200 行虚拟滚动阈值）。批次 23「工具卡片『看得懂』」（0.0.468）解决的是工具名与参数预览，结果正文的呈现是空白。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | `task_list` 返回 20 条任务 JSON | 卡片出现「表格/原文」切换，默认原文；切表格后行列与 JSON 一一对应，可切回原文且逐字节一致 |
| 2 | 自定义 HTTP 工具返回 `{ records: [...] }` 包裹的数组 | 同样可转表格（识别唯一数组字段的包裹对象，不限键名） |
| 3 | 结果是嵌套结构 / 超过规模上限 / 根本不是 JSON | 不出现切换按钮，保持原文（不猜、不截断展示） |
| 4 | 表格态核对数据 | 「复制为 CSV」按钮，RFC 4180 转义，粘贴进 Excel 行列同构 |

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 表格渲染 | **复用 `center/TableGrid.vue`，零修改引入**；若确需容器样式差异，以新增可选 props 实现（先验证默认样式够用） | `rows: string[][]` 与本方案产物同构；自带表头/数值列/虚拟滚动，重造即浪费 |
| 判定入口 | 新增纯函数 `utils/tool-result-table.ts` 的 `tryParseTable(resultText: string): string[][] \| null` | 与 `parseResultNode`（:218-226）并列的结果解析，但它要的是数组形；抽独立纯函数便于穷举单测 |
| 接受形态 | ① 顶层 `JSON.parse` 为数组且元素全为「扁平键值对象」（值仅 string/number/boolean/null）；② 顶层为对象且**恰有一个数组字段**、其余字段全为标量 → 取该数组按 ① 判定，**不限键名** | 目标工具的实际数组键是 `todos`（task_list，另有标量兄弟字段 `progress`、可选 `hint`）/ `tasks`（list_scheduled_tasks）/ `watchers`（list_signal_watchers）/ `files`（dump_user_messages）——常见包裹键白名单（records/items/…）反而使方案自己的主场景全部 miss（评审修正，见 §8-1）。放开键名后误判防护仍由两道闸兜住：**唯一数组字段**（多数组字段一律 null）+ **元素全扁平**（嵌套值一律 null），歧义形态宁可原文不可错表 |
| 形态外细节 | 键集合取全部元素键的并集（保持首次出现顺序），缺失单元格填 `''`；值一律 `String()`（boolean/null 保留字面量）；**空数组（含包裹对象内的空数组）→ null**（无表可渲染） | 稀疏字段（如可选配置项）不丢列；空表没有信息量，保持原文 |
| 规模上限 | 行（含表头）≤ 201、列 ≤ 30、`resultText.length ≤ 1_000_000`；任一超限返回 null | `TableGrid` 的虚拟滚动阈值也是 200 行（`ROW_HEIGHT/VIRTUAL_THRESHOLD` :50-52），口径对齐；结果到达前端是全文（见头部评审注记），1MB 上限是对 `JSON.parse` 的真实护栏 |
| 切换态记忆 | localStorage `aw-tool-result-view.<toolName>` = `'table' \| 'text'`，缺省 `'text'`（=现状）；新函数集放 `utils/tool-result-table.ts`（读写 try/catch 包裹） | 与外观偏好同族的设备本地口径（`aw-file-word-wrap` / `aw-diff-inline` / `aw-theme-mode` 等既有键同款）；按工具名而非按卡片实例，重复调用同一工具不反复切 |
| 复制 CSV | 纯函数 `toCsv(rows: string[][]): string`：字段含 `,` `"` `\n` 时双引号包裹 + 引号翻倍，`\r\n` 行结尾 | RFC 4180 标准转义；无第三方依赖 |
| 快速预判 | `tryParseTable` 先做 `trimmed.startsWith('[')` 或 `trimmed.startsWith('{')` 探测，非 JSON 形态零解析成本 | 结果正文多为纯文本（shell 输出等），99% 的卡片走不进 `JSON.parse` |

## 4. 实现步骤

### 4.1 新增 `src/utils/tool-result-table.ts`

- `tryParseTable(resultText: string): string[][] | null`：长度/首字符预判 → `JSON.parse`（失败 null）→ 形态判定（§3：数组或唯一数组字段包裹对象；元素全扁平；空数组 null）→ 提取键并集与行列 → 规模上限 → 返回 rows；全程无副作用。
- `toCsv(rows: string[][]): string`（RFC 4180）。
- `getToolResultView(toolName: string): 'text' | 'table'` / `setToolResultView(toolName, view)`（localStorage try/catch）。

### 4.2 修改 `ToolCallCard.vue`

1. 新 computed `tableView`：`richView`（:647-650）为 null 且未进入图片分支（`imagePreviewUrl` :692-706 为空）时，对 `props.toolCall.result`（**全文**，非 `displayResultText`）调 `tryParseTable`，否则 null。放在 `richView` 与 `fullResultText`（:709-720）/ `displayResultText`（:726-732）之间，二者优先级不变——专用视图命中时本分支整体不渲染（外层 `v-if="(toolCall.result || imagePreviewUrl) && !richView"` :165 已保证）。设计说明：表格态呈现 ≤200 行的**完整数据**（可能多于原文态 4000 字截断的显示量），原文态维持现状截断——这是表格视图的附加价值，不是二者不一致。
2. 原文结果区（:165-188，「输出」label :166 之后）加切换行：`tableView` 非空时渲染「表格 / 原文」两态切换（`el-segmented` 或两枚 icon button，均带 aria-label 与 title，文案与行为一致——遵守仓库图标按钮无障碍约定）；点击写 `setToolResultView`。desktop element-plus ^2.14.0 支持 `el-segmented`（2.7 引入），desktop 侧已有使用先例（`views/settings/NotificationSettingsView.vue`）。
3. 表格分支：`view === 'table' && tableView` 时以 `<div class="tool-result-table">` 包裹渲染 `<TableGrid :rows="tableView" />`，旁置「复制为 CSV」按钮（复用既有复制反馈样式）。**容器高度注意**：TableGrid 的虚拟滚动容器 `.table-grid-scroll` 是 `flex: 1; min-height: 0; overflow: auto`（:116-120）、自测 `clientHeight`，**依赖父级给有界高度**——外层容器以 `max-height: 280px` 封顶 + flex 布局包裹（小表自适应收缩不留大块空白，大表封顶后由 TableGrid 内部虚拟滚动接管；实现评审确认 max-height 下 `flex+min-height:0` 约束链同样成立、`clientHeight` 实测值正确），**不叠外层 overflow**（避免双滚动条）。原文 `<pre>` 在该态 `v-show=false` 保留 DOM（切回零重渲染，且「逐字节一致」由同一份 `displayResultText` 天然成立）。
4. import 面只增不改：`import TableGrid from '../center/TableGrid.vue'`（chat/ 与 center/ 同级）+ 三个新工具函数。（chat/ 目录此前无跨目录组件 import 先例，属首次，评审确认无循环依赖与构建问题。）

### 4.3 样式

`ToolCallCard.vue` scoped style 新增 `.tool-result-table`（容器高度策略见 §4.2-3；边框/配色沿用 `.result-content` 的既有配色变量，不新增色值）；`TableGrid` 自身样式 scoped 于其组件内原样生效。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 新增 | desktop/src/utils/tool-result-table.ts | tryParseTable / toCsv / 视图偏好读写 |
| 新增 | desktop/src/utils/tool-result-table.test.ts | 单测（≥ 14 例，见 §7；纯函数测试范本：`utils/toolRichView.test.ts` / `utils/toolDisplay.test.ts`；命令 `npm run test:unit`） |
| 修改 | desktop/src/components/chat/ToolCallCard.vue | tableView computed、切换行、表格分支、CSV 复制 |
| 修改 | desktop/src/components/chat/ToolCallCard.test.ts | 组件用例追加（既有 jsdom 测试文件，见 §7-6/7/8） |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面/Web）小节 |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 默认态被改变 | 切换按钮仅在 `tryParseTable` 命中时出现，且默认视图 = `'text'`；E2E 工具卡既有断言为门 |
| JSON.parse 阻塞 | 三重护栏：1MB 长度上限、首字符预判、200×30 规模上限；`computed` 随结果缓存，同一结果只解析一次（结果全文可达前端已核实：summarizer 只产出一行摘要不改写结果本体，见头部评审注记） |
| TableGrid 复用引入样式串扰 | TableGrid 样式 scoped 于其组件内；容器仅做高度约束（§4.2-3）；中心 Tab 既有用例回归兜底 |
| TableGrid 虚拟滚动依赖有界高度，普通 block + max-height 父级下内部滚动不生效（双滚动条或窗口塌缩） | 容器以固定高度 + flex 布局包裹（§4.2-3），实现时按其根元素实际布局微调；评审已核实其滚动容器依赖 `flex: 1; min-height: 0` |
| 偏好键随工具名膨胀 | 单键 ≤ 数十字节、按工具数上限有限（工具目录收敛），不做清理机制 |
| 包裹形态误判（放开键名后任意 `{x: [...]}` 都可能命中） | 判定为「唯一数组字段 + 元素全扁平对象」双闸：多数组字段 / 嵌套值 / 空数组一律 null——宁可原文不可错表；目标工具（todos/tasks/watchers/files）与任意自定义/MCP 包裹键按同一规则命中 |

## 7. 测试要点

`desktop/src/utils/tool-result-table.test.ts`（纯函数）：

1. 扁平对象数组 → 行列正确、键序 = 首元素键序、缺失键填 `''`、number/boolean/null 字面量化。
2. 实际目标工具形态逐一命中：`{todos:[…], progress:'…'}`（task_list，含可选 `hint` 标量兄弟字段）/ `{tasks:[…], total:N}`（list_scheduled_tasks）/ `{watchers:[…]}`（list_signal_watchers）/ `{files:[…], count, message}`（dump_user_messages）；任意键名单数组 + 标量兄弟字段（如 `{records:[…], total:3}`）→ 命中；**带第二个数组字段 → null**。
3. 嵌套值（对象/数组元素）→ null；空数组 `[]` → null；包裹对象内数组为空 → null；`JSON.parse` 失败 → null；非 JSON 开头（shell 输出）→ null 且零解析。
4. 规模：201 行 / 31 列 / 1MB 文本 → null；恰好上限 → 通过。
5. `toCsv`：逗号 / 引号 / 换行 / 三者混合转义；正常字段原样。

组件（`desktop/src/components/chat/ToolCallCard.test.ts`，jsdom）：

6. 假 `task_list` 结果（`{todos:[…3 条], progress:'…'}`）→ 按钮出现、默认原文；切表格后 TableGrid 行数 = 4（含表头）、内容断言；切回原文文本与初始一致。
7. 偏好持久化：设 table 后重挂载默认表格；`setToolResultView` 只影响该工具名。
8. `richView` 命中的卡片（如 shell）不出现切换按钮。

## 8. 决策记录

1. 表格判定从严但**不设键名白名单**：只接「扁平记录列表」——顶层唯一数组字段 + 元素全扁平，嵌套与歧义形态一律保持原文。评审修正：初稿的白名单六键（records/items/results/data/list/rows）不包含目标工具的实际数组键（todos/tasks/watchers/files），会使 §2-1 的主用户故事全部不出现按钮；放开键名后误判防护由「唯一性 + 扁平性」两道闸承担，覆盖面与安全性同时成立。
2. 规模上限 200×30 与 TableGrid 虚拟滚动阈值对齐；超限即原文，不做分页/滚动加载。
3. 切换偏好按工具名（非按卡片/会话），localStorage 设备本地口径（`aw-` 前缀族），不进用户配置后端。
4. 原文 `<pre>` 保留 DOM 仅 `v-show` 隐藏，保证切回零重渲染与「逐字节一致」由同一数据源天然成立；解析输入是 `props.toolCall.result` 全文而非 4000 字截断的显示文本。
5. 复用 TableGrid 不改其内部；容器样式走既有结果区配色变量，零新增色值；容器以 max-height 上限 + flex 满足其虚拟滚动对有界高度的依赖。
6. 行号基线：本方案行号以 2026-11-11 核实版本为准（ToolCallCard.vue 1044 行、TableGrid.vue 常量 :50-52）；初稿行号整体偏移 -10~-23，已全部校正。
7. 键序口径：键并集「首次出现顺序」对含纯数字键的记录不严格成立——JS 对象整数型键按数值升序排在字符串键前（`Object.keys` 规范行为），列序可能偏离 JSON 文本序，但全行一致、数据无错位，属装饰性偏差，不做修补。
8. 已知限制（评审确认，接受不改）：①「复制为 CSV」不做公式注入防护——以 `=`/`+`/`-`/`@` 开头的单元格粘贴进 Excel 会按公式执行；朴素防御（前缀 `'`）会破坏 `-1` 等合法负值的数据保真，故保持 RFC 4180 纯转义，作为已知限制记录。②大整数精度：JSON.parse 将超过 Number 安全范围的整数（如雪花 id）静默舍入（原文态是原始文本无损）——当前内置工具 id 均在安全范围内，不触发。

## 9. 明确不做的（汇总）

- JSON 树形查看器、排序/筛选/分页、列宽拖拽（中心 Tab 已覆盖重表格需求）。
- 工具后端返回结构改动、`toolDisplay.ts` 摘要口径改动、`VOLATILE_RESULT_KEYS` 触碰。
- 服务端表格化（MCP/自定义工具结果一律前端解析）。
- PDF/图片类结果的表格化（不在 JSON 形态内）。
