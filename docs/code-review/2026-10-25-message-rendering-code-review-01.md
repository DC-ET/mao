# 代码评审报告：桌面端回复渲染完整度（mermaid / KaTeX / 表格工具条，未提交工作区）

> **第二轮复检（2026-10-25）**：两个问题已修复并复检通过，见文末「三、第二轮复检记录」。当前代码状态：**无重大 bug**。

- 日期：2026-10-25
- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/message-rendering` 的未提交改动（`git status`：修改 `useMarkdown.ts`、`MarkdownContent.vue`、`MessageBubble.vue`、`codeCopy.ts`、`style.css`、`package.json`；新增 `utils/{base64,mermaid-renderer,katex-loader,math-extension,markdown-table,tableCopy}.ts`、`scripts/check-main-chunk.mjs` 及 6 个测试文件）
- 技术方案：`docs/plan/2026-10-25-message-rendering-technical-design.md`（重点对照 §6 冲突清单：B2 SVG 消毒红线、C2/C4/C6 流式门控、A6 定界校验、F1/F3 安全、G1 包体断言）
- 审查维度：功能逻辑正确性、设计约束（§6 红线）落实、安全消毒链、流式竞态、构建链
- 方法：逐文件审阅全部改动与关联实现（marked 18.0.4 Lexer 源码、dompurify 3.4.14、katex 0.19.1、mermaid 11.17.2）；基线 `desktop npx vitest run` 102 文件 897 用例全绿（含本批新增测试）；`npm run build`（vue-tsc -b + vite build + check-main-chunk）通过；对嫌疑缺陷写临时验证 spec 实际运行复现（跑完即删，仓库无残留）。
- 本轮共 **2 个问题**：中 1、低 1。设计红线（B2 SVG 不进消毒前字符串、主链 SANITIZE_OPTIONS 不动、流式门控、G1 包体）均守住；未发现安全类（XSS / 命令执行）缺陷。

---

## 严重度汇总

| # | 端 | 问题 | 类别 | 严重程度 | 位置 |
|---|:---:|------|------|:---:|------|
| 1 | desktop | blockMath 块级定界符惰性闭合可跨行吞并：段落首行「行内 `$$…$$` + 尾随文字」后，同段任意行尾 `$$` 会被当成闭合，把中间全部行（正文、甚至代码围栏）吞进一条红色报错公式 | 渲染正确性 | 中 | `desktop/src/utils/math-extension.ts:60` |
| 2 | desktop | mermaid 占位与「查看源码」折叠内的 `<code>` 缺 `monaco-code` class，代码块无背景/内边距，与同一消息内其他代码块视觉不一致 | 视觉一致性 | 低 | `desktop/src/utils/mermaid-renderer.ts:43-46` |

---

## 一、问题清单

### 1. blockMath 惰性闭合跨行吞并正文与后续公式（desktop，中）

- **位置**：`desktop/src/utils/math-extension.ts:60`（blockMath tokenizer：`/^\$\$([\s\S]+?)\$\$(?:\n|$)/`）。
- **问题描述**：marked 对 block 级扩展是在块循环位置以**剩余全部源码**调用 tokenizer 的（marked 18 `Lexer.blockTokens`：`this.options.extensions?.block?.some(o => (r = o.call({ lexer: this }, e, t)) ? ... : !1)`，其中 `e` 是自当前段落起点起的整个剩余文本）。该正则对闭合 `$$` 的唯一约束是「后随换行或串尾」，**没有排除 inner 中出现 `$$`，也没有要求闭合 `$$` 与开定界符属于同一对**。于是当段落首行是「合法行内 `$$a$$` + 尾随文字」时（该闭合 `$$` 后跟非换行字符，块级正则在此处匹配失败），惰性扫描会一路跳到本段后面**任何一处恰好在行尾/串尾的 `$$`** 上闭合——它可能是下一行独立 display 块的定界符、甚至代码围栏里的一对 `$$`——把中间所有行整体吞成一条公式。技术方案 §5.3/§6-A6 对块级规则的要求是「行首开始、闭合 `$$` 收尾于行尾/行边界」，实现只保证了后者，未保证开/闭定界同属一个块级对；这正是 A6「定界校验层」想防的那类误判，只是表现为「过吞」而非「误渲染」。
- **触发场景**（模型回复里很常见的两种写法）：
  - `$$a$$ 说明文字` 下一行是 `$$b$$`（行内公式带解释 + 独立公式行）；
  - `$$E=mc^2$$ 是质能方程` 下一行是 `$$\nx + y = z\n$$`（行内公式 + 标准 display 块）；
  - 更甚：首行 `$$a$$ 文字` 后跟 ` ``` ` 围栏且围栏内容含行尾 `$$`，围栏开栏行被吞、代码块被摧毁。
- **影响**：两行（或更多）内容合并成**一个** `katex-error` span（`throwOnError:false` 的红色报错文本），`说明文字` 等正文被吸进公式区、后续公式消失、代码块可能被破坏性吞并；KaTeX 报 `Can't use function '$' in math mode`。对照同段无第二个 `$$` 时（如 `$$a$$ 说明文字` 单独成段）渲染完全正常，可证是闭合跳跃所致。
- **建议修复方向**：收紧 blockMath 定界匹配，任选其一：
  1. inner 禁止出现 `$$`：`/^\$\$((?:(?!\$\$)[\s\S])+?)\$\$(?:\n|$)/`——首个行内对的闭合因「后面跟文字」本就不满足行边界，扫描应就此放弃而不是跳到下一个 `$$`；
  2. 要求闭合 `$$` 位于行首（`/(^|\n) *\$\$[\s\S]+?\$\$(?=\n|$)/` 形态按行约束）；
  并补回归用例：`$$a$$ 说明文字\n$$b$$` 应产出「display 公式 a + 段落说明文字 + display 公式 b」三段。
- **已用测试验证**（临时 spec `desktop/src/__tmp-verify-math.test.ts`，5 passed 后删除；marked 18.0.4 实跑）：

  | 输入 | 实际输出（摘录） | 期望 |
  |------|------------------|------|
  | `$$a$$ 说明文字\n$$b$$` | `<span class="katex-error" title="ParseError: … Can't use function '$' …" style="color:#cc0000">a$$ 说明文字\n$$b</span>`（一次匹配吞两行，红字报错） | display 公式 a、段落「说明文字」、display 公式 b |
  | `$$E=mc^2$$ 是质能方程\n$$\nx + y = z\n$$` | 同上红字吞并 + 残段 `<p>x + y = z\n$$</p>`（display 块被毁、裸 `$$` 泄漏） | display 公式 + 说明 + display 公式 |
  | `$$a$$ 文字\n```\n$$\n```\n` | 红字吞并含 ```` ``` ```` 开栏行，后续只剩一个空代码块（`data-code=""`） | 行内公式 + 文字 + 完整代码块 |
  | 对照 `$$a$$ 说明文字`（无后续 `$$` 行） | 正常：`katex-display` + 「说明文字」 | 同左（证明闭合跳跃是必要条件） |
  | 对照 `前文 $$x^2$$ 后文` | 正常行内 display | 同左 |

### 2. mermaid 占位/查看源码内代码块缺 `monaco-code` 表面样式（desktop，低）

- **位置**：`desktop/src/utils/mermaid-renderer.ts:43-46`（`buildMermaidPlaceholder` 产出 `<pre class="code-block" …><code>${escaped}</code></pre>`，`<code>` 无 class）。
- **问题描述**：普通代码块的表面样式（背景 `--aw-surface-code`、12px 内边距、等宽块级排版）由 `colorizeCode` 产出的 `<code class="monaco-code ${theme}">`（`monaco-colorize.ts:11`）承载，各消费方 scoped CSS 只给 `.monaco-code` 定义了背景（如 `MessageBubble.vue:944-953`、`FileViewer.vue`、`FileDiffViewer.vue`、`SkillManager.vue`、`OpenApiView.vue` 同款），`.code-block` 自身与全局样式均无背景，且全局 `pre code { padding: 0; background: none }`（`style.css:576`）会把全局 `code` 的底色重置掉。mermaid 占位初始内容与渲染成功后「查看源码」折叠里复用的是**同一个无 class 的 `pre`**（`fillRendered` 原样搬移 `sourcePre`），因此这两种形态下代码体都是透明底、零内边距的裸文本——与同一条消息里其他语言代码块的观感明显不一致（深色主题下尤甚）。
- **触发场景**：任何含 mermaid 围栏的消息（流式中的占位、渲染失败保底、渲染成功后展开「查看源码」）。
- **影响**：纯视觉，复制按钮/降级语义不受影响。低危。
- **建议修复方向**：占位 `<code>` 补主题 class（`buildMermaidPlaceholder` 在 `createMarked(isDark)` 闭包内可拿到 `isDark`，透传 `monaco-code ${isDark ? 'xxx-dark' : 'xxx-light'}` 同款 class 名）；或给 `.markdown-body .mermaid-block pre.code-block code` 增加一条与 `.monaco-code` 同款的全局兜底样式。
- **已验证**（结构断言 + CSS 核对，无 spec 落库）：
  ```
  placeholder code tag has no class attr: true
  colorizeCode emits: <code class="monaco-code 
  .monaco-code background rule exists: true      （MessageBubble :deep(.monaco-code) background: var(--aw-surface-code)）
  .code-block has own background rule: false
  global pre code resets background: true
  ```

---

## 二、审查过并排除的点（供后续评审去重）

- **设计红线 B2 守住**：SVG 仅在 `fillRendered` 经 DOM API（`figure.innerHTML = safeSvg`）插入；全仓 diff 中主链 `SANITIZE_OPTIONS = { ADD_ATTR: ['target'] }` 未改；SVG 二次消毒是独立配置（`USE_PROFILES svg/svgFilters + ADD_TAGS ['style'] + FORBID ['foreignObject','script']`），恶意 SVG 用例（script/foreignObject/onerror/onclick/img）在 jsdom 全剥、`<style>` 与文本保留（`markdown-sanitize.dom.test.ts` 锁定）。
- **KaTeX 安全**：`trust:false` 下 `\href{javascript:…}{x}` 与 `\write18` 均渲染为红色文本，不产生可点链接、无命令执行（jsdom 全链实测）；`throwOnError:false` + 未知命令回落红色原文是 katex 标准行为。
- **KaTeX 懒加载无漏载**：`MATH_HINT_RE`（`\$\$[\s\S]+?\$\$|\$[^\n$]+?\$`）对 math-extension 三种匹配形态（行内 `$…$`、行内 `$$…$$`、跨行块 `$$\n…\n$$`）逐一核对为超集；preprocess（stripCitationDefinitions 只删整行）不会制造 hint 漏判的公式形态；加载失败每次静默重试、回落原文。
- **A6 价格语境防线有效**（marked 层实测）：`价格 $5 和 $6`、`编号 $2$`、`$ x $`、`$x\ny$` 跨行、`\$x^2$` 转义、codespan/代码围栏内 `$x^2$` 全部保持原文。
- **流式门控（C2/C6/C4）逻辑正确**：`MarkdownContent` watch 源含 `props.streaming`，true→false 翻转必触发整串重渲 + 补插入（content 不变也会触发）；`insertMermaidDiagrams` 任务执行前/后三重过期校验（`isConnected`、`.mermaid-rendered`、`dataset.mermaid` 未变）；串行队列 `queueTail` 链式 + 单图失败 catch 不阻塞后续。**已用 jsdom + vi.mock('mermaid') 实测 6 场景全过**：渲染成功 DOM 结构（figure/details/sourcePre 保留/事件派发 1 次）、同源同主题二次插入缓存命中（render 仅 1 次）、dark/light 分键各自渲染且 initialize 收到正确主题、插入后节点被 v-html 重建断链则任务丢弃、parse 失败占位原样保留、render 抛错后队列继续渲染第二张图。
- **缓存与主题竞态**：缓存键含主题位；`renderOne` 读 `documentElement[data-theme]` 与 `useTheme` 写同一属性（`theme.ts:33`），且 MarkdownContent 的 isDark watch 整串重渲兜底，最坏情况一次错色回填会被下一次重渲纠正。
- **DOMPurify 放行全链实测（jsdom）**：mermaid 占位 `data-mermaid/data-code/复制按钮`、表格 `data-table-md/工具条按钮/对齐 style="text-align:*"`、KaTeX `katex/katex-html/<math>` 结构在主链口径 sanitize 后全部存活。
- **表格链路**：`renderMarkdownTable` 结构/对齐/内联格式（parseInline 走通 `<strong>`、外链 noopener）/64KB 省略 raw 回落均正确；`tableCopy` 委托 jsdom 点击实测——「复制 Markdown」优先解码 `data-table-md` 保真原文、「复制 CSV」从 DOM 抽取并正确转义（`"a,b",b\r\n"say ""hi""",2`）；`rowsToMarkdown` 竖线转义/换行压缩/宽度补齐纯函数正确；与 codeCopy 双委托无冲突（选择器互斥，捕获序无副作用）。
- **G1 包体断言可用**：`npm run build` 全链通过，`check-main-chunk.mjs` 主 chunk（index-*.js）不含 `sequenceDiagram`/`katex-mathml` 字面量；该脚本只检查主 chunk、不误伤动态 chunk；vue-tsc -b 对新增可选 prop `streaming` 全量校验通过。
- **基线回归**：`npx vitest run` 102 文件 897 用例全绿（含本批新增 6 个测试文件）；electron `node --test` 的 2 个存量失败主工作区同样存在，与本需求无关，未计入。
- **base64 编解码**：与既有 `encodeCodeForCopy`/`decodeCode` 完全同口径（`btoa/atob + escape/unescape`），Electron renderer 与 Node 22 均可用；mermaid 占位的 `data-mermaid`/`data-code` 双写一致，解码往返正确（mermaid 测试锁定）。
- **消费方矩阵**：MessageBubble 三处 MarkdownContent 中，segments text 段与无 segments 回退均传 `:streaming="isAssistantRunning"`；后台通知卡片一处不传——该卡片只在后台子代理**完成后**出现，无流式语境，符合设计 §2.3。ShareView/FileViewer/FileDiffViewer/RunTraceRecordReply/SkillManager/OpenApiView 默认渲染，与方案口径一致；RunTrace 在 run 进行中打开时非流式门控属设计既定取舍（未完成源码 parse 失败 → 占位保持代码块，无闪烁）。
- **marked 集成细节**：blockMath 仅在块循环位置（段落起点）被调用、无 `startBlock` 副作用，段中 `$$…$$` 走行内 display 正常；行内扩展在 escape/codespan 之前尝试但 `^\$` 不吞反斜杠（`\$` 由 escape 规则先消费）；codespan 内 `$…$` 因 codespan 先于到达位置被消费而天然豁免；列表项/引用块内数学与表格均正常（blockTokens 对 extensions 无 state.top 限制）。
- **实例缓存**：Marked 实例按主题+citeMap 缓存复用，walkTokens 变更 token 属每 parse 独立状态，无跨消息串扰；`renderInlineMarkdown` 不含 math/mermaid/table 扩展，无占位泄漏。

---

## 三、第二轮复检记录（2026-10-25，两问题修复后）

- **复检范围**：`math-extension.ts`（blockMath 两种有界闭合形态）、`mermaid-renderer.ts`（占位 monaco-code 主题类）、`useMarkdown.ts` 调用点、4 个测试文件的同步更新；并对上轮全部排除面做了增量复核。
- **基线**：`npx vitest run` 102 文件 900 用例全绿（+3 为修复新增回归用例）；`npm run build`（vue-tsc -b + vite build + check-main-chunk）通过；改动文件范围与第一轮一致，无夹带。
- **结论：无重大 bug，无新增问题。**

### R1-1 复检：blockMath 有界闭合（已验证有效，未发现漏网吞并）

修复形态：多行块 `^\$\$[ \t]*\n([\s\S]+?)\n[ \t]*\$\$[ \t]*(?:\n|$)`（`$$` 独占行开/闭）+ 单行块 `^\$\$([^$\n]+?)\$\$[ \t]*(?:\n|$)`（整行仅 `$$x$$`）。关键性质：**闭合必须是一个「仅含 `$$`（±空白）的行」**，第一轮的吞并载体（行内对的 `$$` 后跟尾随文字）不再可能成为闭合点。

临时验证矩阵（15 例，跑完即删；vitest include 锁定 `src/**`，故临时文件放 `desktop/src/` 当轮删除，未入 /tmp 可跑的形态）：

| 形态 | 结果 |
|------|------|
| 第一轮 S2 `$$a$$ 说明文字\n$$b$$` | ✓ 行内 display a + 正文 + display b，无 katex-error、无 `$$` 泄漏（新增回归用例锁定） |
| 第一轮 S1 `$$E=mc^2$$ 是质能方程\n$$\nx+y=z\n$$` | ✓ 行内公式与正文完好；display 块回落原文（见下方已知形态 N4，非回归） |
| 第一轮 S6 `$$a$$ 文字\n```\n$$\n```\n` | ✓ 代码围栏完好（marked 段落遇围栏内建打断），围栏内 `$$` 按 code 内容保留 |
| 两个连续多行块 / 单行块+多行块 / 多行块+「$$x$$ 文字」 | ✓ 各自成块，惰性在首个独占 `$$` 行停住 |
| 多行块 inner 含裸 `$` | ✓ 有界红色报错（garbage-in），块外「后文」不受影响 |
| 畸形闭合行（`$$ 后带文字`） | ✓ 延伸到下一个独占 `$$` 行为止，不会越过最后一个独占行 |
| `$$` 独占行紧跟正文行（无空行） | ✓ 回落原文（既有形态限制，见 N4） |
| 单行块尾随空格 / 前导空格 / 纯数字 `$$2$$` / 空块 / 未闭合 / `$$x$$ $$` | ✓ 与第一轮语义一致，无误判 |
| 行内 / 价格语境既有用例（$5 和 $6、$2$、codespan 等） | ✓ 全部不回归 |

### R1-2 复检：占位 monaco-code 主题类（已验证有效）

- `buildMermaidPlaceholder(source, isDark)` 产出 `<code class="monaco-code aw-light|aw-dark">`，与 `monaco-loader.themeName(isDark)` 的取值逐字一致；`useMarkdown.ts:85` 传入的 `isDark` 来自 `createMarked` 闭包，与主题切换整串重渲链一致。
- 全链实测：`renderMarkdown` → DOMPurify 后类名存活；`fillRendered` 原样搬移同一 `pre`，「查看源码」折叠内样式随之继承；占位与 colorizeCode 产物同构，各消费方（MessageBubble/FileViewer/FileDiffViewer/SkillManager/OpenApiView）的 `.monaco-code` scoped 规则直接命中。

### 复检备注（非 bug，不阻塞）

- **N1（注释陈旧）**：`math-extension.ts:10` 文件头注释仍写「块级 $$...$$：行首开始、闭合 $$ 收尾于行尾/行边界，可跨行」，与新的两种有界形态不符（tokenizer 处的行内注释是对的），建议顺手改掉。
- **N2（字符串重复）**：占位主题类硬编码 `'aw-dark'/'aw-light'`，未复用 `monaco-loader` 的 `themeName()`；有测试锁定当前配对，但两处字面量存在漂移风险，建议改为 import。
- **N3（不变量未强制）**：修复说明称「内容均不含 `$`」，实际仅单行形态用 `[^$\n]` 排除，多行形态 inner 仍允许 `$`（后果仅为有界红色报错，属 garbage-in，无吞并风险）。
- **N4（既有形态限制，非本次回归）**：多行块 `$$\n…\n$$` 不在块循环位置时（即紧跟正文行、无空行分隔）回落原文——blockMath 扩展未定义 `start` 函数，marked 的段落分词不会在 `$$` 行处打断段落；该形态在本功能引入前后均如此，符合「回落原文，无阅读损失」的既定取舍。若将来想支持，给 blockMath 扩展补 `start` 函数即可让 marked 走 startBlock 段落切断机制。
