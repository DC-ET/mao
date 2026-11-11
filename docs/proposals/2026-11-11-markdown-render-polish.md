# 提案：Markdown 渲染补完 —— GFM 任务列表与内联图片点击放大

> Agent 的输出里越来越常见两类 Markdown 结构，聊天渲染层却不认识：①**GFM 任务列表**（`- [ ]` / `- [x]`）——Agent 用 task_list 管理待办时，任务清单文本里全是这种语法，今天渲染成字面 `[ ]` 方括号文本，可读性倒退（渲染层 `useMarkdown.ts` 只挂了 katex 数学扩展，grep 无任何 taskList/footnote 处理，marked 默认不支持 GFM 任务列表）；②**正文里的内联图片**（`![描述](/uploads/7/xxx.png)`）——生成图片、微信收图回显等场景已经大量落在正文里，今天只能看缩在正文里的一张图，想放大要开中心 Tab 或另存。两者都是**纯渲染层**补完：渲染产物只增不改，现有 Markdown 的逐字节输出零变化。

- 状态：已立项（2026-11-11，批次 29）
- 日期：2026-11-11
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（约 1 人日；**零后端、零迁移、零新依赖**——任务列表用 marked 自定义 renderer（约 40 行），图片放大复用 el-image）
- 关联：`desktop/src/composables/useMarkdown.ts`（:54-56 Marked 实例与 mathExtension）、`desktop/src/components/common/MarkdownContent.vue`（v-html 渲染）、`desktop/src/utils/imageUpload.ts`（uploads URL 形态参照）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| GFM 任务列表 | `- [ ]` 渲染为字面文本 `[ ]`，紧贴列表项内容 | `useMarkdown.ts` 无 taskList 处理（grep 零命中）；marked 核心（v14）不含 task list |
| 任务列表的来源 | task_list 工具的清单文本、Agent 写的 plan/README、用户粘贴的待办 | `harness/tool/impl/task-tools.ts`（todos 结构）与技能输出惯例 |
| 内联图片 | `<img>` 以原生尺寸嵌在正文里，无放大交互 | `MarkdownContent.vue` v-html 渲染链，无图片后处理 |
| 图片放大先例 | 工具卡图片结果已有 el-image preview（`preview-src-list`） | `ToolCallCard.vue:167-176`（imagePreviewUrl 分支） |
| 数学/mermaid 扩展先例 | marked 管道挂自定义扩展的成熟模式 | `useMarkdown.ts:56` `mathExtension()`、mermaid 占位（:82 注释） |

与已否决项的边界：批次 26 否决的是**会话级**「图片快览 gallery」（图片密集会话的低频场景）；本提案是**单张内联图片**的点击放大（标准查看器交互，无 gallery 无缩略墙）。批次 28 否决的是**阅读视图**（降噪/问答三档密度）；本提案不碰密度与折叠，是渲染语法支持。

## 2. 目标 / 非目标

**目标**

1. **P1 GFM 任务列表渲染**：`- [ ]` / `- [x]` 列表项渲染为带复选框样式的列表（✓/空框 + 删除线可选——已完成项加 `text-decoration: line-through` 由评审定），纯**只读**展示。
2. **P2 内联图片点击放大**：`MarkdownContent` 渲染的正文 `<img>` 点击后以 el-image preview 全屏查看（复用工具卡同款交互与样式）；不改变图片的加载与布局行为。
3. 渲染产物对**不含这两类语法**的既有消息逐字节不变（扩展只新增分支，不改任何既有 renderer）。
4. 安卓壳共用 UI：任务列表与图片放大在 Web/安卓同样生效。

**非目标**

- 任务列表**不可点击切换**：勾选状态是 Agent 写入工作区文件的事实（task_list 工具 / README），聊天里切换会造成「界面与文件不一致」的假象——只读。
- 不做脚注 / 数学以外的其他 GFM 扩展（需求未出现，不加依赖）。
- 不做会话级图片 gallery（批次 26 已否决）、不做图片下载批量操作。
- 不改 `useMarkdown` 的缓存与流式链路（流式渲染平滑批次 27 已否决，本提案不触碰渲染性能面）。
- 零后端、零迁移、零新依赖。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话阅读视图（批次 28 否决） | 那是阅读密度（降噪/问答三档）；本提案是渲染语法支持，不碰密度、折叠与导航 |
| 会话图片快览（批次 26 否决） | 那是会话级 gallery 缩略墙；本提案是单图点击放大 |
| 流式渲染平滑（批次 27 否决） | 不碰渲染性能与节流；新增分支只对新增语法生效 |
| 结构化回复卡片（批次 9 否决） | 不引入封闭集块协议；是标准 GFM 语法的渲染支持 |

## 4. 方案设计

- **任务列表**：`useMarkdown` 挂自定义 renderer——list item 开头匹配 `^\[([ xX])\] ` 时产出 `<li class="md-task"><span class="md-task-check" aria-hidden="true">…</span><span>内容</span></li>`（aria 按装饰元素处理，任务语义由文本本身承载）；CSS 用既有 `--aw-*` 令牌，零新增色值。仅影响 list token 的渲染分支。
- **内联图片放大**：`MarkdownContent` 在 v-html 后处理（既有 DOM 后处理先例：mermaid-renderer）——把正文 `<img>` 替换为 el-image 或绑定 click → `previewSrcList=[src]`；沿用工具卡 image-preview 的既有样式变量。流式进行中（`:streaming`）不绑定放大（避免半张图的预览），流式结束后生效——与阅读视图提案的「流式锁定」同思路但仅这一处。
- 两个能力各自独立开关点（评审若只要其一可裁剪，互不依赖）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `useMarkdown.ts`（task-list renderer 分支）；`MarkdownContent.vue`（图片点击放大后处理）；样式追加；`useMarkdown` 既有测试追加任务列表用例 |
| backend-ts / admin / android / agent-cli | **无**（安卓壳共用 UI） |
| 数据库迁移 | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 正文里字面 `[ ]`（非列表项）被误渲染 | 只在 list item renderer 分支匹配，段落文本不处理——语法位置收紧 |
| 图片点击放大劫持链接点击（图片同时是链接的情况） | 后处理跳过带父级 `<a>` 的 img（链接行为优先） |
| 流式期间任务列表中途变化抖动 | 任务列表是低频结构（Agent 整段输出）；流式中照常渲染，无额外锁定（与代码块同水位） |
| el-image 在长文重复渲染开销 | 只绑定 click 预览，不替换 DOM 结构为组件（原生 img + 事件委托），开销与现状一致 |

## 7. 测试要点

1. `- [ ]` / `- [x]` / `- [X]` 三态渲染正确；非列表位置的 `[ ]` 字面文本不受影响；既有列表（有序/无序/嵌套）产物逐字节不变。
2. 内联图片点击弹出预览、关闭正常；带 `<a>` 包裹的图片不绑放大；流式进行中不触发。
3. 数学公式 / mermaid / 代码块 / 表格等既有渲染回归零变化（既有 useMarkdown 测试全绿）。
4. 安卓壳：任务列表与图片放大可用。

## 8. 决策记录

已拍板（2026-11-11，评审确认）：

1. **已完成项样式**：**✓ + 灰色 + 删除线**——`- [x]` 渲染为勾选标记 + 灰色文字 + `line-through`，信息量最大。
2. **任务列表是否提示「在聊天里只读」**：**不提示**——勾选框本就无点击态，无误导，不加 title 冗余提示。
3. **图片放大范围**：**仅 `MarkdownContent` 正文**——工具卡图片已有各自预览，不重复绑定。
