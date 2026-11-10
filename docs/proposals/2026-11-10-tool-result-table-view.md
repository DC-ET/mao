# 提案：工具结果表格化视图 —— 列表类结果一键转表格

- 状态：已立项（2026-11-10，技术方案：[docs/plan/2026-11-10-tool-result-table-view-technical-design.md](../plan/2026-11-10-tool-result-table-view-technical-design.md)）
- 提案总览见 [docs/proposals/README.md](README.md)
- 关联：`desktop/src/components/chat/ToolCallCard.vue`、`desktop/src/components/center/TableGrid.vue`、`desktop/src/utils/toolDisplay.ts`

> 一批 Agent 工具的产出天然是「表」：任务清单、定时任务列表、哨兵列表、文件搜索命中——但它们在工具卡里一律以 JSON 原文呈现。用户要在几十行 JSON 里数条目、对字段、核对状态，眼睛做的是本该机器做的事。表格渲染能力其实已经在仓库里（文件中心 Tab 的 TableGrid / SpreadsheetView / CsvTableView 一整套），只是没有接到工具卡上。

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 工具结果渲染 | 一律纯文本 `<pre><code>`，JSON 数组/对象不解析 | `ToolCallCard.vue:133`、`:168`（`<pre class="result-content"><code>{{ displayResultText }}</code></pre>`） |
| 典型的表格形结果 | `task_list` / `list_scheduled_tasks` / `list_signal_watchers` / `glob_search` / `grep_search` 等返回 JSON 文本，字段齐整但逐行读 JSON 极费力 | `TOOL_DISPLAY_NAMES`（`toolDisplay.ts:1-40`）所列 list/search 族工具 |
| 仓库内表格渲染资产 | 文件中心已有一整套：`TableGrid`（props 就是 `rows: string[][]`，:45-47）、`SpreadsheetView`、`CsvTableView` | `components/center/TableGrid.vue` |
| 富视图先例 | 工具卡已有 `richView` 分流（图片类结果走专用视图，如 `ToolImageGenView.vue`） | `ToolCallCard.vue:155`（`v-if="(toolCall.result || imagePreviewUrl) && !richView"`） |
| 既有治理 | 批次 23「工具卡片『看得懂』」解决的是**名字与参数预览**（toolDisplay），结果**正文**的呈现未覆盖 | `2026-11-06-tool-card-completeness.md`（已落地 0.0.468） |

## 2. 目标 / 非目标

**目标**

1. 工具结果为「表格形」时，卡片头部出现「表格 / 原文」切换（**默认原文 = 现状逐字节不变**，切换偏好按工具名记忆于 localStorage）。
2. 表格形判定：结果文本成功 `JSON.parse` 且为对象数组（或含单一数组字段的对象，如 `{ records: [...] }`），元素为扁平键值对象；行列规模设硬上限（≤ 200 行 × ≤ 30 列）超出即保持原文，不猜、不截断展示。
3. 渲染直接复用 `center/TableGrid.vue`（`rows: string[][]`，首行表头语义一致），单元格值经 `String()` 归一，不引入新格式化逻辑。
4. 表格态附「复制为 CSV」按钮（RFC 4180 引号转义，纯前端拼装），与现有复制行为并存。

**非目标**

- 不做 JSON 树形查看器（对象嵌套结构保持原文呈现；只接管「扁平记录列表」这一种形态）。
- 不改任何工具的后端返回结构、不改 `toolDisplay.ts` 的摘要口径、不动 `VOLATILE_RESULT_KEYS`。
- 不做排序 / 筛选 / 分页交互（首版就是「看得清」，中心 Tab 的完整表格体验已覆盖重需求）。
- 不自动展开：工具卡默认折叠行为不变。

## 3. 方案概要

- 新增 `utils/tool-result-table.ts`：`tryParseTable(resultText): string[][] | null`（含规模上限与扁平度校验），配单测覆盖 JSON 数组、`{records:[]}` 包裹、嵌套对象拒绝、超限拒绝。
- `ToolCallCard.vue` 在既有 `richView` 分流旁新增表格分支：`richView`（图片等专用视图）优先级不变；表格切换按钮只在 `tryParseTable` 命中时出现。
- 按工具名记忆切换态（localStorage `aw-tool-result-view.<toolName>`），与会话偏好同族的设备本地口径。

## 4. 回归风险与隔离

- 默认态零变化：不命中不显示按钮、命中也默认原文；E2E 现有断言（含工具卡用例）全部为门。
- `TableGrid` 是文件中心已在用的既有组件，复用不改其内部；若需 props 微调，以新增可选 props 方式，中心 Tab 用例回归兜底。
- 解析失败 / 超限一律回落原文，永不吞结果正文；复制原文按钮保持可用。
- 后端、契约、工具实现零触碰。

## 5. 验收标准

- `task_list` / `list_scheduled_tasks` / `list_signal_watchers` 返回 20 条记录时，切表格后行列与 JSON 一一对应；切回原文逐字节一致。
- 嵌套 JSON（含对象数组字段）不出现表格按钮；200 行以上不出现。
- CSV 复制粘贴进 Excel 为 5×3 同构表格；引号 / 逗号 / 换行字段正确转义。
- 偏好按工具名记忆：`list_scheduled_tasks` 选表格，其他工具默认仍是原文。
- `npm run build` + 全量单测绿；`tryParseTable` 单测 ≥ 10 例。
