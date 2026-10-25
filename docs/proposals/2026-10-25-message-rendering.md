# 提案：回复渲染完整度 —— 图表、公式与表格不该以源码形态阅读

> Agent 是结构化内容的高产者：让它「画个部署架构」「推导这个公式」「三个方案对比出表」，得到的是需要自己脑补的 mermaid 源码、LaTeX 源码和一张不能导出的表格。用户的标准动作是复制出去用别的工具渲染——任务闭环断在最后一米。

- 状态：**已实施**（0.0.350，2026-10-25；技术方案见 [docs/plan/2026-10-25-message-rendering-technical-design.md](../plan/2026-10-25-message-rendering-technical-design.md)，实施偏差注记见方案头部）
- 日期：2026-10-25
- 提案总览：见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 约 3-4 人日含安全加固；三阶段合计约 6 人日；纯前端渲染层，零后端零迁移）
- 关联：`desktop/src`（渲染层）；分享页同链路受益

## 1. 背景与现状

### 1.1 渲染栈现状（代码可查）

- `desktop/src/composables/useMarkdown.ts`：marked + DOMPurify 严格消毒；代码块 Monaco colorize 高亮 + 语言标签 + 复制按钮（`utils/codeCopy.ts` 事件委托）；外链自动 `_blank noopener`。
- **全仓源码 grep 无 mermaid / katex 命中**（desktop / admin / backend-ts 均零命中；docs/plan 里出现的 mermaid 是设计文档自用图，不是产品规划）。
- 表格只有基础 CSS（border / padding），无复制、无导出。
- 渲染三端同源：Web / Electron / 安卓（远程加载同一 SPA）+ 公开分享页（ShareView 复用同一 MarkdownContent 链路）。

### 1.2 投入的错位

平台在「结构化阅读」上投入很重：引用溯源（0.0.282）、工具卡片、思考块、文件变更面板、上下文透视、运行轨迹——但正文里模型最高频产出的三类结构化内容（图 / 式 / 表）停在源码形态。模型今天就已经会用 fenced code block 写 mermaid、用 `$...$` 写公式、用 Markdown 表格做对比——不需要任何模型侧或协议侧改动，缺口纯在渲染端。

### 1.3 一个真实场景

用户让 Agent「画一张本次改造的模块依赖图，mermaid」。Agent 老老实实输出了语法正确的 flowchart 代码块。用户盯着源码看了 10 秒，复制到 mermaid.live 看图，再回来继续对话。下一次他直接去用别的工具了——「任务完成」的体验被最后一步的阅读成本拖垮。

## 2. 目标 / 非目标

**目标**

1. **P1 Mermaid**：回复中的 ` ```mermaid ` 代码块原位渲染为 SVG 图，主题跟随浅 / 深色，渲染失败降级回代码块。
2. **P2 KaTeX**：`$...$` 行内公式与 `$$...$$` 块级公式渲染，字体本地打包。
3. **P3 表格增强**：表格悬浮工具条「复制为 Markdown / 复制为 CSV」，粘进 Excel 不串列。
4. 三端一次生效（同源部署）+ 分享页同链路。
5. 不含图 / 式的会话零开销：渲染库动态 import 懒加载，首屏包体零增长。

**非目标**

- 不做 echarts / chart.js 等数据图表库（表格 + mermaid 已覆盖模型常规产出；数据图表属另一议题）。
- 不做任何「模型埋围栏块」的新协议（那是已否决的结构化回复卡片案的范围）。
- 不做 CLI（mao-agent）渲染——TUI 保持代码块形态，与其设计非目标（docs/plan/2026-08-20-mao-agent-cli-technical-design.md 1.3）一致。
- 不做表格排序 / 筛选（会话回复里的表是一次性阅读物，不是数据面板）。
- 不做图表缩放导出 PNG（P1 不含，观察使用后再议）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 结构化回复卡片（2026-10-19 否决） | 那是「封闭集块协议 + 模型埋点 + 服务端校验 + 三端原生渲染」的新协议；本提案零协议、零模型侧改动、零后端，只把 Markdown **既有标准语法**（fenced mermaid / `$math$` / table）渲染完整。模型今天就在产出这些语法。 |
| 界面国际化、语音输入（README 排除） | 不沾边。 |
| 运行轨迹 / 上下文透视（已实施） | 那些是执行侧的阅读工具；本提案是回复正文的阅读工具，不重叠。 |

## 4. 技术方案

### 4.1 渲染后处理管线（不动 useMarkdown 的消毒主链）

- marked 产出 HTML、DOMPurify 消毒之后、插入 DOM 之前，对 `pre > code.language-mermaid` 节点收集队列 → `mermaid.render(id, source)` → 用返回的 SVG 节点原位替换代码块，保留原始源码在「查看源码」折叠里（点开回看 / 复制）。
- 解析失败 / 超时：降级为原代码块 + 行内错误徽标（与现有「输出已截断」徽标同形态），不打断整条消息渲染。
- KaTeX 走 marked 扩展（`marked-katex-extension` 或等价内联实现），在 DOMPurify 之前生成 MathML/HTML 片段，进入同一条消毒链。

### 4.2 安全边界（mermaid 是已知 XSS 载体，必须显式处理）

- `mermaid.initialize({ securityLevel: 'strict' })`：禁 HTML labels、禁 click callback。
- 渲染产出的 SVG 再过一次 DOMPurify（白名单 SVG 标签），双保险。
- 回归测试放入恶意用例：labels 内嵌 `<script>`、`onerror`、`javascript:` href、`<foreignObject>` 注入。
- KaTeX 固定 `trust: false`（默认即 false，显式声明防回归），`\href` 等信任扩展不开启。

### 4.3 性能与包体

- `mermaid`（min 后约 1MB）与 KaTeX 均 dynamic import：首个含图 / 式的消息出现时才加载，此后模块级缓存。
- 资源全部本地打包，**禁 CDN**（自托管内网环境不可达公网 CDN 是硬约束）。
- 长会话渲染上限：首屏视口内最多渲染 N 张（建议 6），视口外占位「图表」块，进入视口或点击后渲染；几百条消息的会话不做一次性全量渲染。
- 主题：mermaid theme variables 接现有主题体系（浅 / 深 / 跟随系统），主题切换时已渲染图重渲染（复用现有主题切换监听）。

### 4.4 表格增强

- 表格容器悬浮工具条（右上角，hover 出现）：复制为 Markdown / 复制为 CSV。CSV 序列化处理引号转义与换行单元格。
- 不改表格 DOM 结构（避免影响 DOMPurify 与既有样式），工具条挂在包裹层。

## 5. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | mermaid 渲染 + 安全加固 + 懒加载 + 主题 + 降级 | 3-4 人日 |
| P2 | KaTeX 公式（含 `$` 转义边界用例） | 1-2 人日 |
| P3 | 表格复制工具条 | 1 人日 |

**改动面**

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| desktop | `useMarkdown.ts` / `MarkdownContent.vue` / 新 `utils/mermaidRender.ts` / `utils/tableCopy.ts` | 主要工作量 |
| 依赖 | `mermaid`、`katex`（含字体）入 desktop dependencies | 动态 chunk |
| 后端 | 无 | 零改动、零迁移 |

分享页（ShareView）与安卓（远程加载）自动获得，无需单独改动；安卓侧补 WebView 冒烟项。

## 6. 风险与开放问题

| 问题 | 风险 | 推荐默认 |
|---|---|---|
| mermaid XSS | 高（已知攻击面） | strict + SVG 二次消毒 + 恶意用例回归测试，P1 不可拆减 |
| 包体增长 | 中 | 动态 import + 仅图会话加载；CI 加「无图路径不引入 mermaid」断言（检查首屏 chunk） |
| 深色主题下图配色失真 | 中 | theme variables 双主题调参入验收清单 |
| `$` 与正文冲突（价格「$5」误判公式） | 低 | 常见防误判规则（`$` 后须非空格、成对闭合）；误判降级为原文，不影响阅读 |
| 长会话渲染卡顿 | 中 | 视口上限 + 占位懒渲染（4.3） |

**待确认决策**

1. 渲染失败时的默认形态：代码块保留（推荐，模型可据此修正）还是静默吞掉——建议保留 + 错误徽标。
2. 「查看源码」折叠是否需要（推荐需要：复制源码去别处用的场景真实存在）。
3. mermaid 版本选型（10.x 体积大但稳；若在意包体可评估 11.x）——实施时定。

## 7. 测试要点

- 安全：恶意 mermaid / KaTeX 用例集（script / onerror / javascript: / foreignObject / \href）全部净化。
- 降级：语法错误 mermaid 回退代码块；非法公式原样展示。
- 转义：`$5 和 $6`、代码块内的 `$`、行内 code 里的 mermaid 围栏不被误渲染。
- 主题：浅 / 深 / 跟随系统三态切换后已渲染图正确换肤。
- 性能：无图会话首屏 chunk 无 mermaid/katex；含 20 张图会话的滚动帧率抽查。
- 端：分享页渲染一致；安卓 WebView 冒烟（渲染、字体、点击「查看源码」）。

## 8. 验收标准

1. 让 Agent 画 mermaid 图 / 写公式 / 出对比表，回复中原位渲染，主题一致，无需复制到外部工具。
2. 渲染失败降级为代码块 + 徽标，消息其余部分不受影响。
3. 表格一键复制 CSV 粘入 Excel 不串列。
4. 不含图 / 式 / 表复制动作的既有会话，加载性能与包体零变化。
5. 恶意构造的 mermaid 消息在 DOM 中无任何可执行残留（测试断言）。
