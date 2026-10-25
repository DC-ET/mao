# 回复渲染完整度（Mermaid / KaTeX / 表格增强）技术方案

> 版本：v1.1（2026-10-25）
> 状态：已实施（0.0.350；提案见 [../proposals/2026-10-25-message-rendering.md](../proposals/2026-10-25-message-rendering.md)；第十六批另两件见 [../proposals/README.md](../proposals/README.md)）。实施偏差两处：**决策 5 取备选「自研 tokenizer」**——marked-katex-extension 无法注入自定义定界校验层，价格语境防误判（A6）必须落在定界匹配处，故自研 inline/block 扩展（`utils/math-extension.ts`）+ 官方 katex 渲染；**测试基建新增 devDep `jsdom`**——node 环境跑不了 DOMPurify 全链（§9 H1），消毒锁定用例以 `@vitest-environment jsdom` 单文件开启（`markdown-sanitize.dom.test.ts`）。E2E（FileViewer 种子 md 场景）未随本批落地，按 §9 降级为手动冒烟。

## 0. 待确认决策（评审逐条定）

| # | 决策点 | 推荐 | 备选 |
|---|--------|------|------|
| 1 | mermaid 挂载点 | **marked 层占位 + MarkdownContent DOM 后处理**（§5.1/5.2；与现有管线纯增量组合，占位 div 天然通过 DOMPurify 默认白名单） | 渲染字符串正则替换 `<pre>`（脆弱，依赖 marked 输出形态，否） |
| 2 | 流式期间的图渲染 | **门控不渲染**：流式中的 assistant 消息不触发 mermaid，占位保持代码块形态；流结束后渲染一次 | 每 chunk 渲染 + 缓存回填（仍有闪烁窗口与大图开销，否） |
| 3 | 「查看源码」形态 | 图下方一行折叠条「查看源码」，展开为**保留 data-code 的原代码块**（复制按钮可用） | 不提供（复制源码去别处用的场景真实存在，否） |
| 4 | mermaid 版本 | **11.x**（现行稳定，`securityLevel:'strict'` 语义完整） | 10.x（体积相近无收益） |
| 5 | KaTeX 集成 | **`marked-katex-extension` + 自定义定界符校验**（官方配套、约 2KB；校验层自研防误判） | 自研 inline tokenizer（可控但重造轮子） |
| 6 | 表格源码承载 | **`renderer.table` override 包裹层 + `token.raw` base64**（复制 Markdown 保真）| 纯 DOM 序列化（零 renderer 改动但丢内联格式）；作 raw 不可得时的兜底 |
| 7 | 视口懒渲染 | **P1 不引入 IntersectionObserver**：串行队列 + 缓存已兜住；实测卡顿再加（YAGNI） | 一步到位视口懒渲染 |
| 8 | 占位内是否保留复制按钮 | 保留（占位初始内容即完整原代码块，含 `data-code`；渲染成功才替换为图 + 源码折叠） | 占位为空壳（渲染失败时无降级内容，否） |

## 1. 需求背景

提案（§1-§2）已论证：Agent 高频产出 mermaid / 公式 / 表格，而三端源码零渲染命中，用户只能复制到外部工具。本方案承接提案 §4-§5，细化到文件与函数级，并把「与现有渲染链的每一个冲突点」逐项列出（§6）。

## 2. 现状：渲染链全貌（代码事实，file:line）

### 2.1 marked 管线（`desktop/src/composables/useMarkdown.ts`）

```
renderMarkdown(text, isDark, citeMap)
  1. hooks.preprocess：stripCitationDefinitions（剥 [^n^]: 定义行）      :64-68
  2. walkTokens：code token 整体替换为自定义 <pre class="code-block">
     （复制按钮头 + Monaco colorize + data-code=base64）                 :69-76
  3. renderer.text：[^n^] → 可点击上标；renderer.link：外链 _blank      :91-112
  4. renderer.html：原始 HTML 一律转义为纯文本                          :79-81
  5. DOMPurify.sanitize（默认白名单 + ADD_ATTR:['target']）             :119,157
```

- marked 版本 `^18.0.4`、dompurify `^3.4.14`（desktop/package.json）。
- mermaid 围栏现状：`monacoLangFromFence('mermaid')` 原样返回（`monaco-lang.ts` 未知 lang 直通），colorize 回落，**显示为普通代码块**——即插即改的路径已存在。
- `renderInlineMarkdown`（:160-168）走 parseInline，无代码块，全案不受影响。
- codeCopy 委托是 **document 级 capture**（`codeCopy.ts:62-67`），不绑定具体节点——DOM 替换不影响既有复制按钮。

### 2.2 挂载与流式（`MarkdownContent.vue`）

- v-html（:2）+ `watch [content, isDark, citeMap]`（:25-39）+ `renderGen` 代际守卫（流式高频 + 异步渲染防旧帧覆盖，:21-23）。
- 渲染完成派发 `mao:markdown-rendered` 事件（:34-36）——外层自动滚动依赖它重测量高度。
- 流式路径：store 每 chunk 更新 content → MessageBubble segments 重算 → MarkdownContent watch 每次触发**整串重解析 + v-html 整体替换**。这是全案最重的约束（§6-C）。

### 2.3 消费方矩阵（全走 MarkdownContent 单点）

| 消费方 | 用法 | 图渲染默认 |
|---|---|---|
| MessageBubble（聊天主链） | assistant segments text 段（:95-100）、后台子代理通知（:26-31）、无 segments 回退（:110-116） | 开；流式中的段由 `streaming` prop 门控 |
| ShareView 分享页 | 经 `ChatRoundList`（:44）→ MessageBubble（`ChatRoundList.vue:4,35,62`）同链路 | 开（公开页，消毒链不放宽，§6-F4） |
| RunTraceRecordReply :15 / FileViewer :51 / FileDiffViewer :11 / SkillManager :223 | 直接 MarkdownContent | 开 |

- MessageBubble 已有 `isAssistantRunning`（ThinkingBlock 的 streaming prop 来源，:94）——流式门控数据现成。
- 主题：vueuse `useDark` 写 `data-theme`（`utils/theme.ts`），MarkdownContent 已 watch `isDark`，主题切换天然整串重渲。
- 测试环境：desktop vitest `environment: 'node'`（`vitest.config.ts:7`），DOMPurify/window 全链跑不了——marked 层可测，DOM 插入只能组件/E2E/冒烟（§9）。
- 构建：vite ^8 无 manualChunks 配置，动态 import 自动独立 chunk。

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| mermaid | `mermaid@^11` 动态 import，本地打包 | 决策 4；内网部署禁 CDN 是硬约束 |
| 挂载点 | 三段式：**marked 占位 → DOMPurify（默认白名单不动）→ DOM 后处理渲染** | 决策 1；SVG 不进消毒前字符串（§6-B2 设计红线） |
| KaTeX | `katex` + `marked-katex-extension` + 自研定界符校验 | 决策 5；`trust:false` 固定 |
| 表格 | renderer.table override 包裹 + 工具条 document 级委托（照 codeCopy 模式） | 决策 6；与复制按钮同一交互范式 |
| 渲染调度 | 模块级单例 `mermaid-renderer.ts`：串行队列 + SVG 缓存（上限 100，写入序淘汰）+ 全局自增 id | §6-D；淘汰策略与 `MARKED_CACHE_MAX`（useMarkdown.ts:133）同范式 |

## 4. 总体架构

```
marked.parse
  └─ walkTokens: lang ∈ {mermaid, mmd} 且源码 ≤ 64KB
       → token.text = <div class="mermaid-block" data-mermaid="base64(源码)">
         （初始内容 = 完整原代码块 HTML：复制按钮头 + 纯文本高亮）      ← 天然降级基底
  └─ 其余 token 走现状（colorize / citation / 链接）
DOMPurify.sanitize（不动 SANITIZE_OPTIONS；data-* 默认放行）
MarkdownContent: html.value = next → nextTick
  └─ 后处理（streaming=false 时）：
       扫 root 内 [data-mermaid] → 入模块队列（串行）
         → 缓存命中? 直接回填 SVG
         : mermaid.parse 预检 → mermaid.render(id, src)
             → SVG 二次消毒（svg profile + FORBID foreignObject/script）
             → 原位替换（保留「查看源码」折叠条 + 折叠内原代码块）
             → 补发 mao:markdown-rendered
       任一步失败 → 占位原样保留（代码块），控制台 warn，无 UI 噪音
```

## 5. 详设

### 5.1 占位协议（`useMarkdown.ts` walkTokens mermaid 分支）

```ts
if (isMermaidFence(token.lang)) {          // 'mermaid' | 'mmd'，大小写不敏感
  const source = token.text
  if (source.length > MERMAID_SOURCE_CAP) return fallbackCodeBlock(...)  // 64KB 上限，§6-F2
  token.escaped = true
  token.text = mermaidPlaceholder(source, isDark)  // base64 进 data-mermaid
  return
}
```

- 占位 HTML 结构（初始内容即原代码块，决策 8）：

```html
<div class="mermaid-block" data-mermaid="<base64>">
  <pre class="code-block" data-code="<base64>">…复制按钮头 + 纯文本…</pre>
</div>
```

- 关键点：**base64 在 marked 层同步完成**（`encodeCodeForCopy` 既有函数复用），不给 walkTokens 引入新异步；colorize 跳过（Mermaid 无 Monaco 语言，跳过同时省一次无效调用）。
- 原代码块的 `data-code` 保留——渲染成功后被替换进折叠条内，复制按钮（document 级委托）继续可用（§6-H2）。

### 5.2 DOM 后处理（`MarkdownContent.vue` + 新 `utils/mermaid-renderer.ts`）

- MarkdownContent 模板根加 `ref="root"`；watch 回调在 `html.value = next` 后 `nextTick(scheduleMermaidInsert)`。
- 新增可选 prop `streaming?: boolean`（默认 false）：true 时跳过后处理（占位显示代码块）。MessageBubble 在 segments text 段与回退处传 `:streaming="isAssistantRunning"`；其余消费方不传（历史渲染默认渲染图）。
- `scheduleMermaidInsert(root)`：`root.querySelectorAll('[data-mermaid]')` → 逐个入队。任务闭包捕获元素，**替换前校验 `el.isConnected && dataset.mermaid 未变`**——代替 renderGen 做 DOM 级守卫（组件重渲后旧节点已断链，直接丢弃，§6-C4）。
- 渲染（模块级串行队列）：
  1. 缓存键 = `data-mermaid` 原串 + 主题位，命中直接回填；
  2. `mermaid.initialize({ startOnLoad:false, securityLevel:'strict', flowchart:{ htmlLabels:false }, theme, themeVariables, fontFamily: 与 markdown-body 同族 })`（每次批量渲染前按当前主题初始化，fontFamily 对齐防测量偏差，§6-E2）；
  3. `mermaid.parse(src, { suppressErrors:true })` 失败 → 保留占位；
  4. `mermaid.render(\`m${seq++}\`, src)`——id 全局自增（同屏多实例，§6-D1）；
  5. SVG 过 `DOMPurify.sanitize(svg, SVG_SANITIZE_OPTIONS)`（`USE_PROFILES:{svg:true,svgFilters:true}` + `ADD_TAGS:['style']` 仅此调用生效，保住 mermaid 内嵌样式；`FORBID_TAGS:['foreignObject','script']`；on* 事件默认剥除）；
  6. 构建「图 + 折叠条（查看源码 → 内嵌原 pre）」替换占位，随后派发 `mao:markdown-rendered`（高度变化，滚动重测量，§6-C5）。
- 缓存：`Map<key, svg string>`，上限 100 条写入序淘汰（整体清空式，与 `MARKED_CACHE_MAX` 同范式）。
- 动态 import：`const mermaid = await import('mermaid')`——vite 自动独立 chunk，无图会话零加载（§6-G1）。

### 5.3 KaTeX（P2）

- `createMarked` 内 `marked.use(markedKatex({ throwOnError:false, trust:false, output:'htmlAndMathml', nonStandard:false }))`，**外层包一层定界符校验**：`$` 开定界符右侧非空白、左侧非 `\\`，闭定界符左侧非空白，行内公式内不得出现空行——不满足则按普通文本放行（防「价格 $5 和 $6」误判，§6-A6）。
- 代码块 / 行内 code 天然豁免（不经 text renderer，marked 分词保证）。
- CSS 与字体：`import('katex/dist/katex.min.css')` 与 mermaid 同批动态触发；字体文件 vite 本地打包（woff2 约 60KB×若干，进独立 chunk 资源）。
- 与 citation 共存：math token 是独立 token 类型，不进 text renderer 的 citation 替换；`[^n^]` 出现在公式内按原文展示（模型不会这么写，不处理）。
- DOMPurify 放行验证：KaTeX 产物含 MathML 标签与 inline style——dompurify ^3.4.14 默认 profile 理论放行，**实施时以全链测试锁定**（渲染 `$x^2$` → 断言 `<math>`/`.katex` 存活）；若被剥，仅对本次调用补 `ADD_TAGS` 最小集，不动主链 SANITIZE_OPTIONS。

### 5.4 表格增强（P3）

- `renderer.table` override：`<div class="md-table-wrap" data-table-md="${base64(token.raw)}">` + 默认表格 HTML。`token.raw` 不可得或超 64KB → 回落 `data-table-dom`（仅包裹层，复制走 DOM 序列化）。
- 工具条：`.md-table-wrap` hover 显示右上角「复制 Markdown / 复制 CSV」；新 `utils/tableCopy.ts` 走 **document 级委托**（与 codeCopy 同范式，零 onclick 注入面）。
- CSV 序列化：单元格取 `textContent`，含 `, " \n` 时整格加引号并把 `"` 翻倍；Markdown 复制优先解码 `data-table-md`（保真内联格式），缺失时 DOM 序列化管道表。

### 5.5 主题映射

- mermaid：light → `theme:'default'`，dark → `theme:'dark'`；`themeVariables` 两套常量（背景透明化 `background:'#0000'` 适配气泡底色）。
- 主题切换：MarkdownContent 既有 `watch isDark` 整串重渲 → 占位重建 → 后处理按新主题重新插入（缓存键含主题，两套 SVG 各自命中）。

## 6. 冲突与风险清单（逐项）

> 每项给出代码依据与应对；标 ★ 的为设计红线，违反即产生真冲突。

### A. 与 marked 管线

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| A1 | code 渲染已被 walkTokens 整体接管，mermaid 若走「渲染后正则替换 `<pre>`」会与自定义 `<pre class="code-block">` 结构耦合 | useMarkdown.ts:69-76 | ★占位在 walkTokens 分支内生成（决策 1），与自定义结构零耦合；分支同步返回，不引入新异步竞争 |
| A2 | 模型直接输出 `<div class="mermaid">…` 原始 HTML 不会被渲染 | renderer.html 一律转义（:79-81） | 接受：只支持 fenced 形态。这是既有安全语义非缺陷；prompt 侧无需变更（模型本就惯用围栏） |
| A3 | `stripCitationDefinitions` 会误删 mermaid 源码中形如 `[^1^]: xxx` 的行 | :64-68 已知取舍注释 | 沿用既有取舍（概率极低）；新增一条用例锁定现状，不在本案扩修 |
| A4 | marked v18 的 renderer 签名与旧版差异 | ^18.0.4 已锁 | 本案只动 walkTokens 分支与 renderer.table override，实施时以 v18 签名为准；createMarked 层测试兜底 |
| A5 | `renderInlineMarkdown` 误染 | :160-168 parseInline 无代码块 | 无影响，零改动；加一条「inline 渲染不产占位」断言防回归 |
| A6 | KaTeX 误判正文价格/金额（`$5 和 $6` 成对出现） | §5.3 | 定界符校验层（开闭空白规则 + 禁跨空行）；`throwOnError:false` 时误判回落原文无阅读损失；用例集覆盖典型误判句 |

### B. 与 DOMPurify

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| B1 | `data-mermaid` 属性被消毒剥除则全案失效 | 依赖 ALLOW_DATA_ATTR 默认 true（dompurify ^3.4.14） | 实施时加全链测试锁定（占位过 sanitize 后 data 属性存活）；上游默认若变，显式 `ADD_ATTR` 一行即可，主链其余不动 |
| B2 | ★SVG 混进消毒前的 HTML 字符串：默认 profile 会剥掉大半 SVG 节点，图残缺且诱导后续给主链开白名单 | §4 | 设计红线：SVG 只在 DOM 插入时生成；主链 SANITIZE_OPTIONS 永不改（code review 检查项） |
| B3 | mermaid SVG 内嵌 `<style>` 被二次消毒剥除 → 图无样式 | svg profile 默认可能剥 style | 仅 SVG 二次消毒这一次调用加 `ADD_TAGS:['style']`（§5.2-5）；DOMPurify 对 style 内容自身有过滤，on* / expression 注入面由其承担 + 恶意用例兜底 |
| B4 | KaTeX 的 MathML 标签 / inline style 被剥 | §5.3 | 同 B1 范式：全链测试锁定，必要时本次调用最小 ADD_TAGS |
| B5 | `ADD_ATTR:['target']`（:119）与新占位叠加引入回归 | 主链既有配置 | 不触碰该行；新增选项全部限定在独立的 SVG / KaTeX 消毒调用内 |

### C. 与流式渲染（最重一组）

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| C1 | ★流式每 chunk 整串重解析 + v-html 整体替换，已插入的 SVG 被反复抹掉 | MarkdownContent.vue:25-39 | 缓存键回填：重插 = 字符串赋值 O(1)，不走 mermaid.render |
| C2 | ★每 chunk 触发 mermaid.render：闪烁 + 大图拖慢流式 | 同上 | ★streaming 门控（决策 2）：流式中不渲染图，占位显示代码块（与今天形态一致）；流结束渲染一次 |
| C3 | 未闭合围栏：marked 把「```mermaid 到文本尾」整体视为 code token，源码不完整 | marked 分词语义 | 门控顺带解决（流式中永不渲染）；历史 / 非流式路径不存在未闭合围栏 |
| C4 | 异步 render 慢于下一次 chunk → 结果写回旧节点 | renderGen 只守 html 字符串，不守 DOM 后处理 | 任务闭包替换前校验 `el.isConnected && dataset.mermaid 未变`（§5.2），过期即丢弃 |
| C5 | SVG 替换改变高度 → 外层自动滚动测量失准 | mao:markdown-rendered 事件语义（:32-36） | 替换完成后补发一次该事件（§5.2-6） |
| C6 | 流式结束的触发时序：isAssistantRunning 翻转时 content 可能不再变化，watch 不触发 → 图永不出现 | props 独立 watch | MessageBubble 传 streaming 的同一 prop 在 MarkdownContent 内被 watch（streaming true→false 必触发回调）；实施时补一条「流式结束自动出图」断言 |
| C7 | 边路任务 / 子代理面板同样流式 | SideChatPanel 复用 MessageBubble | 门控 prop 跟随 MessageBubble 单点，各面板自动一致，无面板级改动 |

### D. 多实例与并发

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| D1 | 同屏多 MarkdownContent（消息列表 + 轨迹抽屉 + 文件预览）并发插入 | §2.3 矩阵 | 模块级单例串行队列；render id 全局自增（`m${seq++}`）杜绝 DOM id 冲突 |
| D2 | 同一图多处出现（如被 fork 的会话）重复渲染 | — | 缓存命中直接回填 |
| D3 | `import('mermaid')` 并发调用重复加载 | — | ESM 动态 import 天然单例 promise，无需额外处理 |
| D4 | 打开会话瞬间几十张图排队 → 串行卡顿 | 历史轮默认折叠，实际暴露量小 | 串行 + 缓存已兜底；实测卡顿再上 IntersectionObserver（决策 7 预留） |

### E. 主题

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| E1 | 缓存 SVG 未分主题 → 切换主题回填错色 | watch isDark 重建 | 缓存键含主题位（§5.5） |
| E2 | mermaid 内部测量字体与 markdown-body 字体不一致 → 布局错位 | mermaid 测量机制 | themeVariables.fontFamily 与 markdown-body 同族；冒烟清单含深浅两主题目检 |
| E3 | 系统跟随模式（auto）跨过日夜间切换 | theme.ts media 监听 → isDark ref 变化 | 既有 watch 链自动生效，零额外处理 |

### F. 安全

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| F1 | ★mermaid 是已知 XSS 载体（HTML labels / 事件注入） | — | `securityLevel:'strict'` + `flowchart.htmlLabels:false` + SVG 二次消毒（B3）+ 恶意用例集（§9）；三层独立防线，任一失效仍有下层 |
| F2 | data-mermaid 属性体积（base64 膨胀 1.33×，超长源码进 v-html 字符串） | — | 源码 cap 64KB，超限保留代码块形态（§5.1） |
| F3 | KaTeX 信任扩展（\href / \includegraphics 可外联） | — | `trust:false` 显式声明；maxlength 限制公式长度；恶意用例进测试集 |
| F4 | ShareView 公开页（无鉴权）渲染攻击面 | §2.3 经 ChatRoundList 同链 | 与主聊天同一套消毒链，不因公开页放宽；E2E 冒烟包含分享页含图消息 |
| F5 | 资源走 CDN（内网不可达 + 供应链） | 内网部署约束 | 库与字体全部本地打包；code review 检查项（grep `cdn.jsdelivr/unpkg` 于 diff） |

### G. 兼容与包体

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| G1 | 首屏包体被 mermaid（min 约 1MB）拖累 | vite 无 manualChunks | 动态 import 自动独立 chunk；CI 断言：`vite build` 后主 chunk 不含 mermaid 内部字面量（如 `sequenceDiagram`——注意不能用文件名 grep，import 描述符里会出现 chunk 文件名） |
| G2 | 安卓 WebView 渲染差异（SVG / MathML） | Capacitor 远程加载系统 WebView | SVG / MathML 在现代系统 WebView 成熟；P1/P2 上线前跑安卓冒烟清单（§9），不做代码级分支 |
| G3 | FileViewer 打开大 md（几十张图）卡顿 | FileViewer:51 | 队列 + 缓存兜底；实测卡则给 FileViewer 场景加懒渲染开关（消费方 prop 已预留 streaming 同位） |
| G4 | FileDiffViewer 的 diff 内容混入围栏被当图渲染 | FileDiffViewer:11 | diff 渲染的是 afterContent 纯 markdown，模型/文件里 mermaid 围栏本就该渲染——非冲突；冒烟确认 |

### H. 回归

| # | 冲突 / 风险 | 依据 | 应对 |
|---|---|---|---|
| H1 | node 环境测试跑不了 DOMPurify/window 全链 | vitest.config.ts:7 + useMarkdown.ts:44 注释 | 沿用现有分层：占位 / katex / table 断言在 createMarked 层（node 可测），缓存 / 队列 / CSV 为纯函数单测，DOM 插入走 E2E + 冒烟 |
| H2 | SVG 替换后原代码块复制按钮失效 | codeCopy 委托读 `.code-block` 的 data-code（codeCopy.ts:11-20） | 折叠条内保留完整原 pre（含 data-code），复制继续可用（决策 3/8）；document 级 capture 委托不因 DOM 替换失效（:62-67） |
| H3 | 消费方 props 变更引发类型破坏 | §2.3 | 新 prop 全可选、默认渲染；vue-tsc -b 全量校验（AGENTS.md：禁用 npx vue-tsc --noEmit 假通过口径） |
| H4 | mao:markdown-rendered 事件消费方对「多派发一次」敏感 | — | 派发是幂等测量语义；冒烟覆盖会话恢复滚动到底场景 |

## 7. 改动面

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| 依赖 | desktop/package.json：`mermaid@^11`、`katex`、`marked-katex-extension` | 新增（全部动态 chunk） |
| desktop | `composables/useMarkdown.ts`：walkTokens mermaid 分支 + katex 扩展 + table override | 小~中 |
| desktop | `components/common/MarkdownContent.vue`：root ref + streaming prop + 后处理挂载 | 小 |
| desktop | 新 `utils/mermaid-renderer.ts`（队列/缓存/消毒/插入）、`utils/tableCopy.ts`（委托 + 序列化） | 主要工作量 |
| desktop | `components/chat/MessageBubble.vue`：两处传 `:streaming="isAssistantRunning"` | 极小 |
| 其他端 | 无（ShareView / 安卓经同链自动获得；后端 / admin / agent-cli 零改动） | 零迁移 |

## 8. 分阶段实施

| 阶段 | 内容 | 预估 |
|---|---|---|
| P1 | mermaid 全链（占位 / 队列 / 缓存 / 消毒 / 门控 / 主题 / 折叠）+ CI 包体断言 | 3-4 人日 |
| P2 | KaTeX（定界校验 + 字体打包 + 全链放行验证） | 1-2 人日 |
| P3 | 表格工具条（override + 委托 + CSV） | 1 人日 |

P1 内部顺序：占位 + 降级（无渲染）→ 渲染与缓存 → 门控与主题 → 安全用例收口。每步独立可回归。

## 9. 测试方案

- **marked 层（node 单测）**：mermaid / mmd 围栏产占位且 data-code 保留；超 64KB 回落代码块；A3 用例（源码含 `[^1^]:`）；inline 渲染零占位；KaTeX 合法定界渲染、六类误判句回落原文、code/codespan 豁免；table override 结构与 raw 缺失回落。
- **纯函数**：缓存上限淘汰、CSV 转义（引号 / 换行 / 逗号单元格）、base64 往返、id 自增唯一。
- **全链（E2E / 实施时评估）**：node 环境跑不了 DOMPurify 全链（H1）；优先在 Playwright 补一条 FileViewer 场景——e2e 种子工作区放含 mermaid / 公式 / 表格的 `.md`，断言 `svg` / `.katex` / 工具条出现。种子文件成本可控则必做，否则降为手动冒烟（实施时按 e2e-setup.sh 现状定）。
- **恶意用例集（安全回归，node 层对 mermaid 源码 → 占位；SVG 消毒逻辑以纯函数注入 mock svg 测试）**：labels 内 `<script>` / `<img onerror>` / `javascript:` href / `<foreignObject>` / `<iframe>`；KaTeX `\href` / `\write18`。
- **手动冒烟清单**：Web + Electron + 安卓各过一遍——含图消息渲染与主题切换、流式出图时机、查看源码复制、分享页、文件预览、轨迹回复、深浅主题、低性能机长会话抽查。

## 10. 验收标准

1. 含 mermaid / 公式 / 表格的回复原位渲染，主题一致；失败降级为代码块 + 可复制，无 UI 噪音。
2. 流式输出期间图以代码块形态出现，流结束后自动出图；自动滚动不受影响。
3. 不含三类内容的会话：首屏 chunk 零 mermaid/katex（CI 断言绿）。
4. 恶意用例集全部净化，DOM 无可执行残留。
5. 既有 createMarked 测试、复制按钮、外链、citation 全量回归零破坏。

## 11. CHANGELOG 与文档同步（实施时同任务）

- CHANGELOG「前端（桌面 / Web / 安卓）」节：三阶段各一条。
- `skills/mao-cli/reference/desktop.md`：消息渲染能力清单补三行。
- README「核心能力」表 Harness 行视措辞补「图表 / 公式渲染」半句（可选）。

## 12. 残余风险

| 风险 | 概率 | 缓解 |
|---|---|---|
| mermaid 11 与 Vite 8 打包兼容性问题（worker / ESM 细节） | 低 | P1 首日先做「空项目 spike」验证构建产物，不兼容则退 10.x（决策 4 备选） |
| 深色主题下部分图配色失真需逐类型调参 | 中 | themeVariables 常量表随问题累积；验收含深色目检 |
| 同屏多图场景实测卡顿 | 低 | 决策 7 预留 IntersectionObserver 升级位 |
