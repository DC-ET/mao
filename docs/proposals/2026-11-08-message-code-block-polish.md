# 提案：消息代码块折叠与换行 —— 长代码不再把对话撑成无尽页

> Agent 的回复里经常整段整段地输出代码、日志、配置——今天这些代码块在消息里**全部完整展开渲染**：一段 500 行的脚本把对话撑出十几屏，翻看「这段代码后面还说了什么」要滚很久；超长行又要横向滚。对比之下，文件查看器已有换行切换（`FileViewer.vue:99` 换行按钮 + `aw-file-word-wrap` 偏好持久化），工具卡片有折叠体系，唯独**消息正文里的代码块**没有任何折叠 / 换行能力（`MarkdownContent.vue` 是 `v-html` 字符串渲染，`:1-3`，无任何块级后处理）。

- 状态：已立项（2026-11-08；技术方案：[docs/plan/2026-11-08-message-code-block-polish-technical-design.md](../plan/2026-11-08-message-code-block-polish-technical-design.md)）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（约 1-1.5 人日；**零数据库迁移、零后端改动**，复用既有事后 DOM 增强架构）
- 关联：`desktop/src/components/common/MarkdownContent.vue`、`desktop/src/composables/useMarkdown.ts`、`desktop/src/utils/mermaid-renderer.ts`（事后增强范本）、`desktop/src/components/chat/MessageBubble.vue`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 消息代码块渲染 | `renderMarkdown` 异步整段渲染（含 Monaco 高亮）→ `v-html` | `MarkdownContent.vue:1-3,24` |
| 块级折叠 / 换行 | **无**：代码块全量展开，长行横向溢出 | `MarkdownContent.vue` 无任何 pre/code 后处理 |
| 事后 DOM 增强先例 | Mermaid 渲染即「渲染后遍历 DOM 插入图 + 代际守卫」 | `utils/mermaid-renderer.ts` + `MarkdownContent.vue:44-48` |
| 换行偏好先例 | 文件查看器换行开关 + localStorage `aw-file-word-wrap` | `FileViewer.vue:99,193-200` |
| 宿主隔离需求 | `MarkdownContent` 有 7 处宿主（trace / 文件预览 / 技能页等） | 全仓 `MarkdownContent` 引用清单 |

## 2. 目标 / 非目标

**目标**

1. **P1 长代码块折叠（仅聊天消息宿主生效）**：渲染后遍历代码块，超过 **30 行**的块默认折叠为「首 8 行 + 渐隐遮罩 +『展开全部 N 行』按钮」；点击展开 / 再点收起；行数徽标常显。诚实口径：折叠是**视觉折叠**（max-height 裁剪），DOM 与高亮照常生成——收益是滚动长度与可读性，不省渲染成本（Monaco 高亮管线不动）。
2. **P1 展开状态会话内记忆**：同一次会话渲染中用户展开过的块保持展开（内存 Set，按块内容哈希），重渲染（流式结束 / 主题切换重渲）不把已展开的折回去。
3. **P2 代码块换行切换**：折叠外壳块头加「换行」开关，切换 `white-space: pre-wrap` ↔ 水平滚动；偏好 localStorage 记忆（键 `aw-code-word-wrap`，对齐 `aw-file-word-wrap` 惯例），全局生效于聊天消息代码块。
4. **P1 宿主隔离**：`MarkdownContent` 加可选 prop `codeBlockEnhance?: boolean`（缺省 false）——仅 `MessageBubble` / `SideChatPanel` 传 true；trace 抽屉、文件预览、技能页等 6 处宿主渲染行为**逐像素不变**。

**非目标**

- 不做代码块行号（Monaco 高亮输出结构不归本提案改）。
- 不做语法无关的性能优化（虚拟化 / 懒高亮——现渲染代际守卫体系已保证不卡主链路，另行评估）。
- 不改 `renderMarkdown` / Monaco 高亮管线本身；不改工具卡片（有自己折叠体系）、文件查看器（已有换行）。
- 不做块内搜索（2026-11-02 已否决会话内查找，不搭车）。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 会话内查找 / Markdown 导出（2026-11-02 否决） | 不做检索 / 导出，是块级显示形态控制。 |
| 结构化回复卡片（批次 9 否决） | 不改渲染协议，纯 DOM 后处理。 |
| 回复渲染完整度（批次 16 已落地） | Mermaid / KaTeX / 表格不动，本提案只加代码块外壳。 |
| 键盘焦点与命中区（批次 23 已落地） | 折叠按钮为真实 `<button>` 带 aria-label（`aria-expanded`），沿既有 a11y 规范，不重复该提案工作。 |

## 4. 方案设计

- 新增 `utils/code-block-collapse.ts`：`enhanceCodeBlocks(root: HTMLElement, state: { expanded: Set<string>, wrap: boolean })`——遍历 `pre` 元素，按代码文本哈希判断：≤30 行原样；>30 行包折叠外壳（原 `pre` 原封不动内嵌，仅外层裁剪）+ 块头（语言名如有 / 行数 / 换行开关 / 展开钮）。事件走 root 上**事件委托**（v-html 内容非 Vue 编译，与 mermaid-renderer 同思路）。
- 接线：`MarkdownContent.vue` 渲染完成回调（`:44-48` 的 nextTick 块）在 `props.codeBlockEnhance` 为真时于 `insertMermaidDiagrams` 之后调用 enhancer；代际守卫沿用 `renderGen`（过期帧跳过增强，与既有闪回防护同机制）。
- 流式兼容：流式进行中（`streaming=true`）不折叠（块还在增长，折叠态反复抖动），流结束的最终渲染才折叠——与 Mermaid 的 streaming 跳过口径（`MarkdownContent.vue:14-15` 注释）完全一致。
- 换行开关：块头按钮切全局偏好 → root 上按 class 切 `white-space`，localStorage 写穿（`FileViewer.vue:195-200` 同款写法）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `utils/code-block-collapse.ts`；`MarkdownContent.vue`（新 prop + 接线，缺省行为不变）；`MessageBubble.vue` / `SideChatPanel.vue`（传 prop）；测试新增 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳共用 UI（折叠 / 展开为点按交互，触屏天然可用） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 后处理破坏既有样式 / Mermaid 占位 | 只包裹 `pre` 不改内部结构；enhancer 在 Mermaid 插入后执行且跳过 Mermaid 容器；计算样式 diff 验收（批次 23 手法） |
| 流式期间块内容变化导致哈希失配 | 流式不折叠（设计节明确），最终渲染一次成型；展开记忆哈希按最终内容 |
| 同内容多块共享展开态（哈希相同） | 可接受（同内容块展开联动反而符合直觉）；如需逐块独立改用 index+内容双键，实施时定 |
| 6 处宿主行为回归 | prop 缺省 false，仅聊天传 true；源码级断言「宿主传参清单」，逐宿主手工过一遍渲染 |
| 折叠按钮破坏复制 / 选区 | 块头独立于 `pre`，代码区选择 / 复制行为不变（外壳不拦截事件，仅按钮自身响应） |
| 高亮慢导致的折叠态跳动 | 代际守卫沿用；折叠壳在渲染完成回调内一次性成型，无中间态 |

## 7. 测试要点

1. 500 行代码块默认折叠为 8 行 + 徽标「500 行」；展开 / 收起往复正常；≤30 行块外观与改前逐像素一致。
2. 展开过的块在主题切换重渲染后仍展开；新消息块默认折叠。
3. 流式输出中不出现折叠抖动；流结束最终形态正确。
4. 换行开关：超长行 pre-wrap / 水平滚动两态正确；偏好刷新后沿用；文件查看器自身换行偏好（`aw-file-word-wrap`）不受影响。
5. trace 抽屉 / 文件预览 / 技能页 / OpenApi 页代码块渲染与改前一致（宿主隔离回归）。
6. 代码块内复制 / 划选不受折叠壳影响；折叠按钮 `aria-expanded` 正确、`aria-label` 存在。
7. Mermaid 块不被折叠壳包裹（跳过验证）；源码级断言：prop 缺省 false、宿主传参清单、localStorage 键名。

## 8. 决策记录

待评审确认：

1. **折叠阈值**：30 行（P1 取此）——太低碎、太高失去意义；文件查看器类文件不受影响，可独立调。
2. **折叠首屏行数**：8 行（P1 取此）——足够识别块内容。
3. **换行开关粒度**：全局偏好（P1 取此，省状态）还是逐块——倾向全局，与文件查看器口径一致。
