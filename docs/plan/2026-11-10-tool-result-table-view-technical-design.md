# 工具结果表格化视图技术方案：列表类结果一键转表格

> 对应提案：[docs/proposals/2026-11-10-tool-result-table-view.md](../proposals/2026-11-10-tool-result-table-view.md)（批次 28）。零后端改动、零迁移、零新依赖；改动面收敛在 ToolCallCard 的原文结果区一个分支，默认态（原文）与现状逐字节一致。

## 1. 需求背景

工具卡的结果正文一律以纯文本呈现：`ToolCallCard.vue:133` 与 `:168` 两处 `<pre class="result-content"><code>{{ displayResultText }}</code></pre>`（4000 字符截断由 `displayResultText` computed :704-709 处理）。`richView` 链（:625-628）已为 edit/shell/file/write/glob/grep/web_search/web_page/image/ask_user/check_subagent 十一类结果提供了专用视图，**但「列表形 JSON 结果」没有视图**，典型如 `task_list` / `list_scheduled_tasks` / `list_signal_watchers` / `dump_user_messages`，以及自定义 HTTP 工具与 MCP 工具返回的任意 JSON 数组——用户只能在几十行 JSON 里数条目、对字段。

表格渲染资产已存在且零依赖可复用：`components/center/TableGrid.vue`（props 就是 `rows: string[][]`，:44-48，首行按表头渲染，自带数值列右对齐启发式与 200 行虚拟滚动阈值）。批次 23「工具卡片『看得懂』」（0.0.468）解决的是工具名与参数预览，结果正文的呈现是空白。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | `task_list` 返回 20 条任务 JSON | 卡片出现「表格/原文」切换，默认原文；切表格后行列与 JSON 一一对应，可切回原文且逐字节一致 |
| 2 | 自定义 HTTP 工具返回 `{ records: [...] }` 包裹的数组 | 同样可转表格（识别单一数组字段的包裹对象） |
| 3 | 结果是嵌套结构 / 超过规模上限 / 根本不是 JSON | 不出现切换按钮，保持原文（不猜、不截断展示） |
| 4 | 表格态核对数据 | 「复制为 CSV」按钮，RFC 4180 转义，粘贴进 Excel 行列同构 |

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 表格渲染 | **复用 `center/TableGrid.vue`，零修改引入**；若确需容器样式差异，以新增可选 props 实现（先验证默认样式够用） | `rows: string[][]` 与本方案产物同构；自带表头/数值列/虚拟滚动，重造即浪费 |
| 判定入口 | 新增纯函数 `utils/tool-result-table.ts` 的 `tryParseTable(resultText: string): string[][] \| null` | 与 `parseResultNode`（:208-216）并列的结果解析，但它要的是数组形；抽独立纯函数便于穷举单测 |
| 接受形态 | ① 顶层 `JSON.parse` 为数组且元素全为「扁平键值对象」（值仅 string/number/boolean/null）；② 顶层为对象且恰有一个数组字段、其余字段全为标量，取该数组按 ① 判定（包裹键候选：`records`/`items`/`results`/`data`/`list`/`rows`） | 覆盖 list 族工具与自定义工具两大来源；嵌套值会让表格语义失真，整表拒绝而非部分渲染 |
| 形态外细节 | 键集合取全部元素键的并集（保持首次出现顺序），缺失单元格填 `''`；值一律 `String()`（boolean/null 保留字面量） | 稀疏字段（如可选配置项）不丢列 |
| 规模上限 | 行（含表头）≤ 201、列 ≤ 30、`resultText.length ≤ 1_000_000`；任一超限返回 null | `TableGrid` 的虚拟滚动阈值也是 200 行（`ROW_HEIGHT/VIRTUAL_THRESHOLD` :48-50），口径对齐；防大结果 JSON.parse 阻塞渲染 |
| 切换态记忆 | localStorage `aw-tool-result-view.<toolName>` = `'table' \| 'text'`，缺省 `'text'`（=现状）；新函数集放 `utils/tool-result-table.ts`（读写 try/catch 包裹） | 与外观偏好同族的设备本地口径；按工具名而非按卡片实例，重复调用同一工具不反复切 |
| 复制 CSV | 纯函数 `toCsv(rows: string[]): string`：字段含 `,` `"` `\n` 时双引号包裹 + 引号翻倍，`\r\n` 行结尾 | RFC 4180 标准转义；无第三方依赖 |
| 快速预判 | `tryParseTable` 先做 `trimmed.startsWith('[')` 或 `trimmed.startsWith('{')` 探测，非 JSON 形态零解析成本 | 结果正文多为纯文本（shell 输出等），99% 的卡片走不进 `JSON.parse` |

## 4. 实现步骤

### 4.1 新增 `src/utils/tool-result-table.ts`

- `tryParseTable(resultText: string): string[][] | null`：长度/首字符预判 → `JSON.parse`（失败 null）→ 形态判定（§3）→ 提取键并集与行列 → 规模上限 → 返回 rows；全程无副作用。
- `toCsv(rows: string[][]): string`（RFC 4180）。
- `getToolResultView(toolName: string): 'text' | 'table'` / `setToolResultView(toolName, view)`（localStorage try/catch）。

### 4.2 修改 `ToolCallCard.vue`

1. 新 computed `tableView`：`richView` 为 null 且未进入图片分支（`imagePreviewUrl` 为空，:670-684）时对 `props.toolCall.result` 调 `tryParseTable`，否则 null。放在 `richView`（:625）与 `displayResultText`（:704）之间，二者优先级不变——专用视图命中时本分支整体不渲染（外层 `v-if="!richView"` :155 已保证）。
2. 原文结果区（:155-168）头部加切换行：`tableView` 非空时渲染「表格 / 原文」两态图标按钮（`el-segmented` 或两枚 icon button，均带 aria-label 与 title，文案与行为一致——遵守仓库图标按钮无障碍约定）；点击写 `setToolResultView`。
3. 表格分支：`view === 'table' && tableView` 时以 `<div class="tool-result-table">` 包裹渲染 `<TableGrid :rows="tableView" />`，容器 `max-height: 360px; overflow: auto`（对齐卡片内既有滚动观感）；旁置「复制为 CSV」按钮（复用既有复制反馈样式），原文 `<pre>` 在该态 `v-show=false` 保留 DOM（切回零重渲染，且保证「逐字节一致」是同一份 `displayResultText`）。
4. import 面只增不改：`TableGrid`、三个新工具函数。

### 4.3 样式

`ToolCallCard.vue` scoped style 新增 `.tool-result-table`（容器高度/边框沿用 `.result-content` 的既有配色变量，不新增色值）；`TableGrid` 自身样式原样生效。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 新增 | src/utils/tool-result-table.ts | tryParseTable / toCsv / 视图偏好读写 |
| 新增 | src/utils/tool-result-table.test.ts | 单测（≥ 14 例，见 §7） |
| 修改 | src/components/chat/ToolCallCard.vue | tableView computed、切换行、表格分支、CSV 复制 |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面/Web）小节 |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 默认态被改变 | 切换按钮仅在 `tryParseTable` 命中时出现，且默认视图 = `'text'`；E2E 工具卡既有断言为门 |
| JSON.parse 阻塞 | 三重护栏：1MB 长度上限、首字符预判、200×30 规模上限；`computed` 随结果缓存，同一结果只解析一次 |
| TableGrid 复用引入样式串扰 | TableGrid 样式 scoped 于其组件内；容器仅做高度约束；中心 Tab 既有用例回归兜底 |
| 偏好键随工具名膨胀 | 单键 ≤ 数十字节、按工具数上限有限（工具目录收敛），不做清理机制 |
| `{records: …}` 包裹误判 | 白名单六个键名且要求「唯一数组字段 + 其余全标量」，歧义形态一律 null（宁可原文不可错表） |

## 7. 测试要点

`tool-result-table.test.ts`（纯函数）：

1. 扁平对象数组 → 行列正确、键序 = 首元素键序、缺失键填 `''`、number/boolean/null 字面量化。
2. `{records:[...]}` / `{items:[...]}` 包裹 → 同上；包裹对象带额外标量字段（如 `total: 3`）→ 仍命中；带第二个数组字段 → null。
3. 嵌套值（对象/数组元素）→ null；空数组 `[]` → null（无表可渲染）；`JSON.parse` 失败 → null；非 JSON 开头（shell 输出）→ null 且零解析。
4. 规模：201 行 / 31 列 / 1MB 文本 → null；恰好上限 → 通过。
5. `toCsv`：逗号 / 引号 / 换行 / 三者混合转义；正常字段原样。

组件（ToolCallCard 既有测试文件追加）：

6. 假 `task_list` 结果（3 条）→ 按钮出现、默认原文；切表格后 TableGrid 行数 = 4（含表头）、内容断言；切回原文文本与初始一致。
7. 偏好持久化：设 table 后重挂载默认表格；`setToolResultView` 只影响该工具名。
8. `richView` 命中的卡片（如 shell）不出现切换按钮。

## 8. 决策记录

1. 表格判定从严：只接「扁平记录列表」，嵌套与歧义形态一律保持原文——宁可少一个按钮，不可给错表。
2. 规模上限 200×30 与 TableGrid 虚拟滚动阈值对齐；超限即原文，不做分页/滚动加载。
3. 切换偏好按工具名（非按卡片/会话），localStorage 设备本地口径，不进用户配置后端。
4. 原文 `<pre>` 保留 DOM 仅 `v-show` 隐藏，保证切回零重渲染与「逐字节一致」由同一数据源天然成立。
5. 复用 TableGrid 不改其内部；容器样式走既有结果区配色变量，零新增色值。

## 9. 明确不做的（汇总）

- JSON 树形查看器、排序/筛选/分页、列宽拖拽（中心 Tab 已覆盖重表格需求）。
- 工具后端返回结构改动、`toolDisplay.ts` 摘要口径改动、`VOLATILE_RESULT_KEYS` 触碰。
- 服务端表格化（MCP/自定义工具结果一律前端解析）。
- PDF/图片类结果的表格化（不在 JSON 形态内）。
