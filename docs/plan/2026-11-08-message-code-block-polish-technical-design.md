# 消息代码块折叠与换行技术方案：长代码不再把对话撑成无尽页

- 状态：待实施（2026-11-08 定稿；同日子代理评审收敛，3 P1 + 7 P2 已全部并入本文）
- 日期：2026-11-08
- 需求来源：`docs/proposals/2026-11-08-message-code-block-polish.md`（已立项，含逐项代码证据；本文在其基础上完成定案与四处勘误，见 §3.2）
- 规模：小（新增 1 个工具模块 + `MarkdownContent` 一个可选 prop + `MessageBubble` 两处传参与样式，约 180 行改动 + 测试；**零数据库迁移、零后端改动、零新依赖**）
- 关联：`desktop/src/components/common/MarkdownContent.vue`、`desktop/src/composables/useMarkdown.ts`、`desktop/src/utils/{codeCopy,mermaid-renderer,monaco-colorize}.ts`、`desktop/src/components/chat/MessageBubble.vue`、`desktop/src/views/share/ShareView.vue`（经 ChatRoundList 自动生效）、`skills/mao-cli/reference/desktop.md`

## 1. 需求背景

Agent 回复经常整段输出代码 / 日志 / 配置，消息内的代码块今天**全量展开渲染**：500 行脚本把对话撑出十几屏，翻「代码后面还说了什么」要滚很久，超长行只能横向滚。渲染管线与既有能力：

1. **渲染管线**：`MarkdownContent.vue` 是 `v-html` 字符串渲染（`:1-3`）——`renderMarkdown`（`useMarkdown.ts:168`）异步产出整段 HTML（代码块经 `colorizeCode` 做 Monaco 高亮，注释自述「Monaco 高亮较慢」，`:27` 用 `renderGen` 代际守卫防旧帧闪回）；流式期间跳过 Mermaid 插图（`:16-17`、`:43-45`）。
2. **代码块的既有 DOM 结构**（`useMarkdown.ts:90`，本方案的锚点）：

```html
<pre class="code-block" data-code="&lt;base64 原文&gt;">
  <div class="code-block-header">
    <span class="code-lang">…</span>
    <button class="code-copy-btn" type="button">复制</button>
  </div>
  <code class="monaco-code aw-light|aw-dark">…高亮产物…</code>   <!-- monaco-colorize.ts:11 -->
</pre>
```

   块头（语言 + 复制）与 `data-code` 原文属性已存在；复制走 document 级 capture 委托（`codeCopy.ts:63-68` 幂等注册，按钮不带 onclick，sanitize 白名单零放宽）。
3. **事后 DOM 增强有成熟范式**：Mermaid 即「渲染后遍历 DOM、`isConnected` / 源码校验丢弃过期占位、失败保留代码块形态」（`mermaid-renderer.ts` 头注）；换行偏好的持久化先例在文件查看器（`FileViewer.vue:193-200`，`aw-file-word-wrap`）。
4. **缺口**：块级折叠 / 换行对消息代码块不存在；工具卡片、文件查看器各有自己的折叠与换行，唯独聊天正文没有。

## 2. 需求描述

### 2.1 目标（全部要做）

| # | 优先级 | 目标 | 一句话验收 |
|---|---|---|---|
| 1 | P1 | 长代码块折叠：**仅聊天消息宿主**，超过 **30 行**的块默认折叠为首 8 行 + 渐隐遮罩，块头加「N 行」徽标与「展开全部 / 收起」按钮 | 一段 500 行代码不再撑出十几屏 |
| 2 | P1 | 展开状态记忆：模块级 Set（键 = 内容哈希），重渲染（主题切换 / 流式结束 / 分页重渲）不把用户展开过的块折回去 | 切主题后展开态保持 |
| 3 | P2 | 代码块换行切换：折叠块块头「换行」按钮切 `pre-wrap` ↔ 水平滚动，全局偏好 localStorage（`aw-code-word-wrap`）持久化 | 超长行两种阅读形态可切换且刷新后沿用 |
| 4 | P1 | 宿主隔离：`MarkdownContent` 新 prop `codeBlockEnhance`（缺省 false），仅 `MessageBubble` 两处正文实例开启；其余 6 处宿主渲染逐像素不变 | trace / 文件预览 / 技能页零变化 |
| 5 | P1 | a11y：新按钮 `type="button"` + `aria-label` + 折叠钮 `aria-expanded`（AGENTS.md 图标按钮规范） | 读屏可用 |
| 6 | P1 | 文档同步：CHANGELOG 新版本条目 + `desktop.md:120` 回复渲染段补一句 | 用户可见改动有记录 |

### 2.2 非目标（明确不做）

- 不做代码块行号（不动 Monaco 高亮产物结构）。
- 不做懒高亮 / 虚拟化等性能改造——折叠是**视觉折叠**（max-height 裁剪，DOM 与高亮照常生成），收益是滚动长度与可读性；Monaco 管线与代际守卫体系不动。
- 不改 `renderMarkdown` / `codeCopy` / `mermaid-renderer` / DOMPurify 消毒白名单（新按钮全部在消毒后的 DOM 上生成，无事件属性注入）。
- 不为 ≤30 行的短块提供块头按钮（换行是全局偏好，在任一折叠块头切换即全局生效，见 D4）。
- 不做块内搜索（2026-11-02 已否决会话内查找，不搭车）；展开状态不做 localStorage 持久化（刷新即重置，见 D3）。
- 零后端、零迁移。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 增强架构 | **事后 DOM 增强**：新模块 `utils/codeBlockCollapse.ts`，在 `MarkdownContent` 渲染完成回调（`:44-48` nextTick 块）内、`insertMermaidDiagrams` 之后执行；代际守卫沿用 `renderGen`（过期帧跳过）。不建包裹外壳——直接给 `pre.code-block` 加状态 class、往**既有** `.code-block-header` 插按钮 | 与 mermaid-renderer 同架构（项目已验证两次）；pre 结构零变化，计算样式 diff 面最小 |
| D2 | 行数统计 | 解码 `pre.dataset.code`（`encodeBase64Utf8` 原文，与 `codeCopy.decodeCode` 同口径；两者严格互逆——`base64.ts:7,12`，非 ASCII 安全）按 `\n` 计数，`replace(/\n+$/, '')` 去尾部空行；**阈值 30 行、首屏 8 行定案**；折叠高度 CSS `max-height: calc(8 * 20px + 2 * 12px)`——代码行高是固定 `20px`（`MessageBubble.vue:1128`，非 em 派生），`code.monaco-code` 自带 `padding: 12px`（`:1122`）且全局 border-box（`style.css:377-381`）下 max-height 含 padding，故按「行高 × 8 + 上下 padding」精确推导，实施时 DevTools 实测复核一次 | `data-code` 是精确源文，免 DOM 测量；解码失败（catch）跳过该块不折叠不徽标，与 codeCopy 容错口径一致 |
| D3 | 展开状态记忆 | 模块级 `Set<string>`，键 = `djb2(content) + ':' + content.length`；点击展开加入、收起移除；**点击仅就地更新当前块**，同 hash 孪生块待下一次 DOM 重建随 Set 命中展开（语义自洽，不做点击时的全文档同步）；生命周期 = 应用运行期（刷新重置），**不做 localStorage** | 目标是「重渲染不折回」（主题切换 / 流式结束 / 分页），内存 Set 精确覆盖；持久化反而让「默认折叠」的预期失效 |
| D4 | 换行开关 | 全局偏好：localStorage `aw-code-word-wrap`（`'1'`=换行，缺省水平滚动），读写写法对齐 `FileViewer.vue:195-200`；增强器给宿主内全部非 mermaid `pre.code-block` 加标记 class `code-enhanced`，按偏好加 / 去 `code-wrap-on`；按钮只出现在折叠块块头，点击后对 `document.querySelectorAll('pre.code-block.code-enhanced')` 就地切换 | 换行是阅读习惯不是单块状态，全局一致；`code-enhanced` 标记保证文件查看器 / trace 等其它宿主的同名 `.code-block` **不被波及**（宿主隔离的关键） |
| D5 | 按钮与事件 | 新按钮：`code-toggle-btn`（展开 / 收起，`aria-expanded` + 文案「展开全部 N 行 / 收起」直接切 textContent——持久状态切换，无定时器复位）、`code-wrap-btn`（换行，`aria-pressed` + active 态）；行数徽标 `code-lines-badge` 为 `<span>`；事件走**独立模块级 document capture 委托**（幂等注册，`codeCopy.ts:63-68` 同款），与既有复制 / 外链 / 表格复制三套委托并列 | v-html 内容无 Vue 编译、无 onclick（sanitize 红线），document 委托是项目唯一成熟模式 |
| D6 | 宿主隔离 | `MarkdownContent` 新增可选 prop `codeBlockEnhance?: boolean`（**缺省 false**）；仅 `MessageBubble.vue:131`（segments 正文）与 `:148`（fallback 正文）传 true；`:27` 后台子代理通知摘要**不传**（内容短且已有自己的 `bg-subagent-detail-toggle` 展开机制）；其余 6 处宿主（SkillManager / ToolWebPageView / FileViewer / RunTraceRecordReply / FileDiffViewer / OpenApiView）不传 | 主聊天、边路 / 子代理面板（经 `ChatRoundList` 渲染 `MessageBubble`）、分享页（`ShareView.vue:11,44` → `ChatRoundList` 同链路）一处传参全覆盖；其余 6 处宿主的正文有自己的展示口径，逐像素不变可断言 |
| D7 | 流式 | 增强仅挂在 `!streaming` 分支（与 `insertMermaidDiagrams` 完全同位）：流式期间块还在增长，不做折叠与换行处理；流结束的最终渲染一次成型——streaming 翻转必触发 watch 回调（`MarkdownContent.vue:40-41` C6 注释与实现一致），触发可靠性已核实 | 与 Mermaid 的 streaming 跳过口径（`:16-17` 注释）一致，避免折叠态反复抖动 |
| D8 | Mermaid 边界 | 增强器跳过 `.mermaid-block` 内的 `pre.code-block`（mermaid 占位自身就是该结构，`mermaid-renderer.ts:47-52`）；**超过 `MERMAID_SOURCE_CAP`（64KB）的 mermaid 源码走普通代码块形态**（`useMarkdown.ts:83`），会被正常折叠——这是预期行为（超长 mermaid 源码折叠合理）；mermaid 渲染失败保留占位形态的超长源码块同样永不折叠——预期行为，验收不按 bug 处理 | 图与代码块职责分离；占位内的原代码块保持可复制不受折叠壳干扰 |
| D9 | 样式落点 | 折叠 / 换行样式进 `MessageBubble.vue` scoped `:deep()`（`:1076` `.markdown-body :deep(.code-block)` 既有规则旁）；不进全局 `style.css`。**裁剪层在 `code.monaco-code`**：横向滚动今天由它的 `overflow-x: auto`（`:1125`）承担，`pre` / `.code-block` 本是 `overflow: hidden`（`:1073` / `:1078`）——max-height / overflow 落 code 层既让 white-space 切换生效，折叠态加 overflow hidden 恰好同时压掉横向滚条、展开自然恢复；**不能放 pre 层**（会连块头一起裁掉） | `code-block` 样式本就按宿主分散定义，跟随宿主落点；全局零污染；overflow 层级已按现状核实 |

### 3.2 对提案的四处勘误（随本方案落定）

1. **代码块已有块头**：提案设计「渲染后包折叠外壳 + 新建块头（语言 / 行数 / 换行 / 展开钮）」——实际每个代码块渲染产物自带 `.code-block-header`（语言 + 复制，`useMarkdown.ts:90`）。落定：不建外壳、不重建块头，只在既有块头插入徽标与按钮、给 pre 加状态 class。
2. **行数统计不用 DOM**：提案未指定统计口径；`data-code` 属性携带 base64 原文，解码计数精确且免测量。落定 D2。
3. **事件委托落点**：提案「事件走 root 上事件委托」——复制按钮的实际机制是 **document 级 capture 委托**（`codeCopy.ts`），root 级监听不存在。落定：新按钮建独立模块级 document 委托（同款幂等模式），与既有三套委托并列，不往 MarkdownContent 根上挂监听。
4. **折叠外壳取消**：提案「折叠外壳包裹 pre（原 pre 内嵌）」——直接状态 class + 内容元素 max-height 达成同样效果且结构零变化（D1），降低对既有样式的侵入面。

## 4. 实现步骤

### 步骤 1：`desktop/src/utils/codeBlockCollapse.ts`（新建）

```ts
export const CODE_COLLAPSE_LINES = 30      // 折叠阈值（行）
export const CODE_COLLAPSE_PREVIEW = 8     // 折叠首屏行数
const WRAP_STORAGE_KEY = 'aw-code-word-wrap'

export function codeLineCount(raw: string): number            // 解码后去尾空行计数
export function contentHashKey(raw: string): string           // djb2 + ':' + length
export function isWrapOn(): boolean                           // localStorage 读取
export function setWrapOn(on: boolean): void                  // 写穿 + 全量就地切换

/** 渲染后增强：遍历 root 内 pre.code-block（跳过 .mermaid-block 内的），
 *  全部加 code-enhanced 标记与按偏好的 code-wrap-on；>30 行块插徽标 + 换行钮 + 展开钮，
 *  未在展开 Set 中的加 code-collapse-collapsed。幂等：已处理的块跳过。 */
export function enhanceCodeBlocks(root: HTMLElement): void

/** document 级 capture 委托（幂等注册）：code-toggle-btn 切 Set + class + 文案 + aria-expanded；
 *  code-wrap-btn 写偏好并就地切换全部 code-enhanced 块。 */
export function ensureCodeBlockDelegation(): void
```

要点：`enhanceCodeBlocks` **幂等判据 = `pre.classList.contains('code-enhanced')` 即跳过**（D4 的增强标记复用为跳过标记；v-html 真重建 DOM 时标记随内容消失，天然重新增强——citeMap 变化、streaming 二次翻转等「DOM 未重建但回调再入」的路径靠它防重复插按钮）；只认「既有结构 intact」的块（`data-code` 可解码；失败跳过）；按钮插入用 `insertAdjacentHTML` 到既有 header 内（复制按钮之后），徽标在语言名之后；折叠态 class 挂在 `pre` 上，max-height 规则命中 `pre.code-collapse-collapsed > code.monaco-code`。

### 步骤 2：`MarkdownContent.vue` 接线

1. 新增 prop：`codeBlockEnhance?: boolean`（缺省 `false`，`withDefaults` 补默认值）。
2. 渲染完成回调（`:44-48`）的 `!streaming` 分支内、`insertMermaidDiagrams(root.value)` 之后追加：

```ts
if (props.codeBlockEnhance && root.value) {
  enhanceCodeBlocks(root.value)
  ensureCodeBlockDelegation()
}
```

代际守卫天然覆盖（过期帧在 `:25-27` 已 return，不会走到增强）。缺省路径零变化：不传 prop 的 6 处宿主渲染产物与改前逐字节一致。

### 步骤 3：`MessageBubble.vue` 传参 + 样式

1. `:131` 与 `:148` 两处 `<MarkdownContent>` 加 `code-block-enhance`（`:27` 后台通知摘要不传）。
2. scoped 样式追加（`:1076` 既有规则旁）：

```css
.markdown-body :deep(pre.code-block.code-collapse-collapsed > code.monaco-code) {
  max-height: calc(8 * 20px + 2 * 12px);
  overflow: hidden;
}
.markdown-body :deep(pre.code-block.code-collapse-collapsed) { position: relative; }
.markdown-body :deep(pre.code-block.code-collapse-collapsed::after) {
  content: ''; position: absolute; left: 0; right: 0;
  bottom: 0; height: 3em;
  background: linear-gradient(transparent, var(--aw-surface-code));
  pointer-events: none;
}
.markdown-body :deep(pre.code-block.code-wrap-on code.monaco-code) {
  white-space: pre-wrap;
  word-break: break-all;
}
.markdown-body :deep(.code-lines-badge) { /* 行数徽标：muted 小字号胶囊 */ }
.markdown-body :deep(.code-toggle-btn), .markdown-body :deep(.code-wrap-btn) { /* 24px 见方圆钮，同 .code-copy-btn 口径 */ }
```

渐隐遮罩底色用 `--aw-surface-code`（代码块真实底色——`code.monaco-code` 背景同源，`MessageBubble.vue:1123`；`style.css:29` / `:311` 两主题各有值。**不是**页面底色 `--aw-surface`，用错会出现明显色带），暗色自动跟随。

### 步骤 4：测试 `desktop/src/utils/code-block-collapse.test.ts`（新建）

纯函数（node 环境，仿 `useMarkdown.*.test.ts`）：

- `codeLineCount`：常规 / 尾部空行 / 单行 / 空串。
- `contentHashKey`：同内容同键、异内容异键、长度参与键。
- `isWrapOn` / `setWrapOn`：缺省 false、写读一致（localStorage stub）。

DOM 部分（jsdom，仿 `markdown-sanitize.dom.test.ts`）：

- 构造 `pre.code-block`（含 data-code base64 + 既有 header + `code.monaco-code`）→ `enhanceCodeBlocks`：>30 行块获得徽标（行数正确）+ 两按钮 + 折叠 class；≤30 行块仅 `code-enhanced` / `code-wrap-on`；`.mermaid-block` 内块零变化；`data-code` 损坏块跳过。
- 幂等：二次 enhance 不重复插按钮。
- 委托：点击 toggle → Set 更新 + class / 文案 / `aria-expanded` 切换；点击 wrap → localStorage 写入 + 同文档全部 `code-enhanced` 块 class 切换；非 `code-enhanced` 块（模拟其它宿主）不受影响。

源码级断言（readFileSync，仿 `chat-a11y.test.ts`）：

- `MessageBubble.vue` 恰好两处含 `code-block-enhance`（`:27` 处不含）——按字符串计数，MessageBubble 新增正文实例时需同步维护此断言（注释标明维护点，与 `chat-a11y.test.ts` 同款脆性）；
- `MarkdownContent.vue` prop 缺省 `false`；
- `MarkdownContent.vue` 增强调用位于 `insertMermaidDiagrams` 之后且同一 `!streaming` 分支；
- 其余 6 宿主文件不含 `code-block-enhance`（宿主隔离锁）。

### 步骤 5：文档同步 + 验证 + 提交

1. `CHANGELOG.md` 顶部新增版本条目（版本号取提交时顶部最新版本 +1，预期 `0.0.478`），「前端（桌面 / Web）」节汇总：聊天消息内超过 30 行的代码块默认折叠（块头带行数徽标与展开 / 收起）、代码块换行开关（全局偏好记忆）；明示「分享页随消息正文同步生效，文件预览 / 运行轨迹 / 技能页等其它宿主不变」。
2. `skills/mao-cli/reference/desktop.md:120` 回复渲染段末尾补一句：聊天消息里超过 30 行的代码块默认折叠为首屏几行（块头显示行数，可展开 / 收起，展开态在会话内记住），块头「换行」开关切换长行折行 / 横滚并记住偏好；文件预览、运行轨迹等其它页面的代码块不受影响。
3. 全量验证：`cd desktop && npm run build && npx vitest run`；`cd backend-ts && npm run build && npm test`（零后端改动，确认零回归）。
4. 提交：`feat(desktop): 消息长代码块折叠与换行切换——30 行阈值 / 展开记忆 / 全局换行偏好（<版本>）`，推 origin/main。

## 5. 落地清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `desktop/src/utils/codeBlockCollapse.ts` | 新建：纯函数 + DOM 增强 + document 委托 + 偏好读写 | 1 |
| `desktop/src/components/common/MarkdownContent.vue` | 新 prop `codeBlockEnhance`（缺省 false）+ 渲染回调接线（3 行） | 2 |
| `desktop/src/components/chat/MessageBubble.vue` | 两处传 prop + scoped 折叠 / 换行 / 徽标样式 | 3 |
| `desktop/src/utils/code-block-collapse.test.ts` | 新建：纯函数 + jsdom DOM + 委托 + 源码级断言 | 4 |
| `CHANGELOG.md` | 新版本条目（前端一节） | 5 |
| `skills/mao-cli/reference/desktop.md` | :120 回复渲染段补折叠与换行说明 | 5 |

不动：`useMarkdown.ts`（含 sanitize 选项与 marked 配置）、`codeCopy.ts`、`mermaid-renderer.ts`、`monaco-colorize.ts`、`style.css`、其余 6 处 `MarkdownContent` 宿主（SkillManager / ToolWebPageView / FileViewer / RunTraceRecordReply / FileDiffViewer / OpenApiView）、`SideChatPanel.vue` / `SubagentChatPanel.vue` / 分享页 `ShareView.vue`（经 MessageBubble 自动生效，无代码改动）、后端全部、数据库迁移（零）。

## 6. 风险与对策

| 风险 | 对策 | 
|---|---|
| 后处理破坏既有渲染（复制 / 选区 / Mermaid） | 只插块头按钮 + 加 class，`code` 元素内部零触碰；Mermaid 容器显式跳过（D8）；jsdom 用例锁「占位内块零变化」 |
| 主题切换重渲染把展开块折回 | `isDark` 是既有 watch 触发源（`MarkdownContent.vue:22`），重渲后 enhance 重跑，展开 Set 按 hash 命中即不再折叠（目标 2）；测试覆盖 |
| `max-height: calc(8 * 1.55em)` 与实际行高不齐，首屏行数偏差 | 实施时 DevTools 实测校准一次系数；验收标准是「可见约 8 行」而非逐行精确 |
| 换行开关波及其它宿主的同名 `.code-block` | `code-enhanced` 标记是切换的作用域（D4）；jsdom 用例断言未标记块不受影响；源码级锁宿主清单 |
| djb2 碰撞导致无关块联动展开 | 哈希 + 长度双键，碰撞概率可忽略；后果仅是展开态联动（无数据风险），不做加密哈希 |
| 新按钮与复制按钮的 1.5s 文案复位互相干扰 | 复制只改自身 textContent（`codeCopy.ts:57-60`），互不相干；toggle 文案由 Set 状态驱动而非定时器 |
| 流式期间用户滚动到长块下方 | 流式不折叠（D7），无中间态；流结束折叠时若视口正落在被折叠块内，滚动位置可能跳——可接受（一次性），不做滚动补偿（复杂度高收益低，与 Mermaid 出图同口径） |
| 渐隐遮罩底色与代码块底色不匹配 | 底色用 `--aw-surface-code`（`code.monaco-code` 背景同源变量，`MessageBubble.vue:1123`），两主题各过一遍手工清单 |

## 7. 测试要点

自动：`code-block-collapse.test.ts`（步骤 4 清单）+ desktop 全量 vitest + backend 全量（零回归确认）。

手工验收清单（Web + Electron + 安卓壳）：

1. 含 500 行代码块的消息：默认折叠为首屏约 8 行 + 遮罩 + 徽标「500 行」；展开 / 收起往复正常；折叠态下对可见部分划选 / 复制正常（遮罩 `pointer-events: none` 不拦截）；≤30 行块外观与改前逐像素一致（计算样式 diff）。
2. 展开过的块：切主题（亮 ↔ 暗）重渲染后仍展开；刷新页面后恢复默认折叠。
3. 流式输出长代码：流式期间完整展开不折叠、无抖动；流结束一次成型折叠态。
4. 换行开关：任一折叠块头切换后，会话内全部代码块（含短块长行）立即换行 / 横滚；刷新后偏好沿用；文件查看器自身换行偏好（`aw-file-word-wrap`）互不影响。
5. 宿主隔离：trace 抽屉、文件查看器、技能页、OpenApi 文档、Diff 并排视图的代码块与改前完全一致；分享页（公开分享链接）随消息正文同步折叠 / 换行。
6. 块头四控件并存：语言 / 行数 / 换行 / 展开 / 复制布局不挤不叠；复制功能与「已复制」复位不受影响。
7. Mermaid 图正常渲染且不被折叠；超 64KB 的 mermaid 源码以普通代码块形态折叠（预期行为）。
8. 折叠按钮读屏播报（aria-expanded / aria-label / aria-pressed）；安卓壳触屏点按可用，按钮 24px 命中区沿 0.0.471 口径。

## 8. 决策记录（原提案 §8 三个待评审项 → 定案）

1. **折叠阈值**：30 行。见 D2。
2. **折叠首屏行数**：8 行（CSS max-height 实现加一次实测校准）。见 D2。
3. **换行开关粒度**：全局偏好（localStorage `aw-code-word-wrap`），按钮只放在折叠块块头，短块随全局态生效。见 D4。

## 9. 明确不做的（汇总）

1. 代码块行号、语法高亮管线改造、懒高亮 / 虚拟化。
2. 块内搜索、代码块导出（2026-11-02 否决方向不搭车）。
3. ≤30 行短块的独立块头按钮（换行经全局偏好生效）。
4. 展开状态 localStorage 持久化（刷新重置）。
5. `renderMarkdown` / sanitize 白名单 / `codeCopy` / `mermaid-renderer` 的任何改动。
6. 其余 6 处宿主与后台通知摘要（`MessageBubble.vue:27`）的增强。
7. 折叠导致的滚动位置自动补偿。
8. 后端与数据库改动。
