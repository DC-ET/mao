# 提案：流式渲染平滑 —— 长消息打字不再全量重渲，渲染产物逐字节不变

> Agent 写码是 Mao 最高频的场景，而它恰好踩在渲染链路最重的一段：`content_delta` 每到达一次，**整条已累积的回复**就完整重算一遍——marked 全文重新解析（`composables/useMarkdown.ts:183`），其中**每个代码 token 重新走一遍 Monaco `colorize`**（`useMarkdown.ts:77-88` walkTokens → `utils/monaco-colorize.ts:8-9`），连已经流完的段落也反复上色，还要在每次调用里切一次全局 Monaco 主题（`monaco-colorize.ts:6`）。链路上游（`useStreamWS.ts` / `stores/session/messages.ts`）没有任何节流，Vue watch 的 pre-flush 只能合并同一 tick 的增量，跨 tick 的 delta 仍逐帧全量重算。具体断点：
> 1. **工作量随流式进度二次增长**：一条带 N 个代码块的长回复，流式期间同一块代码被上色 O(N × 帧数) 次，Monaco worker 常驻高占用——Electron 弱机上表现为打字掉帧、输入框打字卡顿、风扇起飞。
> 2. **已完成的渲染成果被反复丢弃**：`renderMarkdown` 无任何结果缓存（`useMarkdown.ts:158-163` 的 `markedCache` 只缓存 marked 实例，不缓存产物）；但代码块的 colorize 输入（code + lang + isDark）在流式期间绝大多数帧完全没变。
> 3. **滚动跟随已经打磨完（0.0.471 体系 + `useChatScroll.ts:90-101` 的上滑容忍与补位），卡顿成了跟随体验的最后短板**：跟随逻辑判断的是滚动位置，内容重算导致的 DOM 全量重建与高度抖动它救不了。

- 状态：已否决（2026-11-08。见 [README](README.md) 台账）
- 日期：2026-11-08
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：P1 约 1.5-2 人日；**零数据库迁移、零后端改动**，改动收敛在 2 个文件，渲染产物对同输入逐字节不变
- 关联：`desktop/src/composables/useMarkdown.ts`、`desktop/src/utils/monaco-colorize.ts`、`desktop/src/components/common/MarkdownContent.vue`、`desktop/src/composables/useStreamWS.ts`（仅读，不改）、`desktop/src/components/chat/MessageBubble.vue`（仅读，不改）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 流式触发链 | `content_delta` → messages store 追加 → MessageBubble 传 `:streaming` → MarkdownContent watch 全量重渲 | `useStreamWS.ts:725`、`MessageBubble.vue:135,153`、`MarkdownContent.vue:35-38` |
| 上游节流 | 无（无 throttle / debounce / rAF） | grep useStreamWS.ts + stores/session/messages.ts 零命中 |
| 代码高亮 | 每个代码 token 每次渲染都 `colorize`，且每次调用先 `monaco.editor.setTheme` | `useMarkdown.ts:77-88`、`monaco-colorize.ts:5-11` |
| 结果缓存 | 无：`markedCache` 只缓存 marked 实例（key = isDark+citeMap），产物不缓存 | `useMarkdown.ts:158-163` |
| 既有保护 | 渲染代际守卫防旧帧闪回；流式跳过 Mermaid / 代码增强；异步 renderMarkdown | `MarkdownContent.vue:30-40,44-59`（C2/C6/D7 注释） |
| 滚动跟随 | 已打磨：上滑容忍、内容暴涨补位、回到最新 | `useChatScroll.ts:6-10,90-101`（本次不动） |

## 2. 目标 / 非目标

**目标**

1. **P1 高亮结果缓存（收益最大、风险最小的一步）**：`colorizeCode` 加模块级 LRU 缓存，键 `isDark | lang | code 全文`，容量约 200；命中直接返回缓存的 HTML。colorize 对同输入是确定性的（`monaco.editor.colorize` 纯函数式输出），缓存不改变任何产物。顺带把每调用一次的 `monaco.editor.setTheme` 改为仅在主题变化时调用（幂等调用省略，产物不变）。文件查看器等其它 colorize 调用方自动受益。
2. **P1 流式渲染合帧**：`MarkdownContent` 在 `props.streaming === true` 期间的渲染触发改为 rAF 对齐 + 最小间隔节流（倾向 80-100ms）：增量先累积，到期统一渲染一帧；`streaming` 翻转 false 时立即同步渲染终态帧（既有 watch 已监听 `streaming`，C6 分支保留），**保证尾字必达**。非流式宿主（运行轨迹 / 文件预览 / 技能页）是一次性渲染，路径完全不变。
3. **P1 输出不变性硬约束**：对同一份文本与 citeMap，`renderMarkdown` 产物逐字节不变——本提案只改变「何时算、重复算多少」，不改解析器、不改 DOM 结构、不改任何事件的语义（`mao:markdown-rendered` 仍每帧派发）。

**非目标**

- **不做增量 DOM patch**：v-html 整帧替换保留——增量 diff 的复杂度与回归面（引用上标、Mermaid 占位、折叠增强都挂在整帧重建假设上）不成比例，整帧替换 + 合帧已够平滑。
- 不做虚拟滚动、不改历史轮折叠口径（`ChatRoundList` 既有 limit 已控 DOM 规模）。
- 不动 `useChatScroll` 跟随逻辑与 `useStreamWS` 协议；不改 store 数据结构（内容仍是全量字符串追加）。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 回复渲染完整度（批次 16 已落地） | 那次补 Mermaid / KaTeX / 表格的**功能**；本提案只动渲染**时机与重复量**，功能面零变化 |
| 消息代码块折叠与换行（批次 26 已立项） | 互补：折叠是 DOM 增强挂在渲染完成后（`enhanceCodeBlocks`），本提案不碰增强逻辑 |
| 运行轨迹深钻二阶段（批次 24 否决） | 无关：轨迹渲染走非流式路径，本次不改 |
| 会话内查找（2026-11-02 否决） | 不新增检索能力 |

## 4. 方案设计

- **缓存落在 `monaco-colorize.ts`**（而非 useMarkdown）：所有调用方共享；键含 `isDark`（亮暗主题切换天然失效）；`lang` 未识别时按 `resolveLanguageId` 解析后的 languageId 入键（`monaco-colorize.ts:12-15` 逻辑不变）；LRU 用 Map 重插实现（Vue 项目无新增依赖）。流式期间「已完成段落」键稳定 → 命中，真正重算的只有正在打字的最后一块。
- **合帧落在 `MarkdownContent.vue` watch 内部**：新增模块级 `streamFlushAt` 时间戳；`streaming && content 变化` 时若距上次渲染 < 间隔则记录 pending 并排 rAF/timeout 尾随帧，否则立即渲染。初始渲染（`immediate: true`）、非流式渲染、`streaming→false` 终态渲染三条路径均不节流。代际守卫（`renderGen`）原样保留——节流只是减少触发，不改变过期帧丢弃语义。
- **参数暴露为常量**：最小间隔 80ms 起步（决策记录），不进设置页——渲染节奏不是用户偏好。
- **事件语义不变**：`mao:markdown-rendered` 每次实际渲染仍派发（外层自动滚动依赖它，`useChatScroll` 补位逻辑照常工作）；合帧后派发频率随渲染频率下降，这正是收益本身。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `utils/monaco-colorize.ts`（缓存 + setTheme 幂等）、`components/common/MarkdownContent.vue`（流式合帧）、新增两者单测 |
| backend-ts / admin / android / agent-cli | **无**；安卓壳共用 UI 自动受益（移动端 WebView 更是重灾区） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 合帧后打字观感「一跳一跳」 | 80-100ms 间隔高于人眼对连续性的感知阈值；实机对比（改前 / 改后录屏）；间隔收敛为常量便于回调 |
| 尾字丢失（最后一帧被节流吞掉） | `streaming→false` 分支同步渲染终态 + 专项测试：模拟 N 个 delta 后断言 DOM 含最后一个 delta 的文本 |
| 缓存内存膨胀（长代码块多） | LRU 容量 200 + 仅缓存 colorize 产物（HTML 字符串）；键含全文，超长块（>10KB）不入缓存直接算 |
| 主题切换瞬间出现旧亮色块 | 键含 isDark，切换即失效重算；`isDark` watch 既有路径（`MarkdownContent.vue:35`）不变 |
| 与 Mermaid 占位 / 代码增强的时序耦合 | 这些增强只在 `!streaming` 帧执行（既有 C6/D7 约定），合帧不改变该时序；回归测试锁定流式结束后的补渲染行为 |

## 7. 测试要点

1. 输出不变性：同输入（含代码块 / 引用标记 / 表格）`renderMarkdown` 快照逐字节一致（改前生成基线，改后比对）。
2. 缓存行为：同一代码块第二次渲染不再调用 `monaco.editor.colorize`（spy 计数）；isDark 或 lang 变化后正确失效；容量上限后旧键淘汰。
3. 合帧节律：模拟 1 秒 60 个 delta，实际渲染次数 ≤ 13 次（80ms）；delta 停止后 100ms 内出终态帧且内容完整（尾字断言）。
4. 非流式宿主回归：运行轨迹 / 文件预览渲染次数与时机与改前一致（一次性渲染，无节流路径）。
5. `streaming→false` 补渲染仍触发 Mermaid / 代码增强（批次 16 / 26 既有行为回归）；代际守卫旧帧闪回回归用例保住。
6. 实机体验：Electron 弱网长回复（带 3+ 代码块）流式期间 Activity Monitor CPU 对比；安卓壳 WebView 同场景点验。

## 8. 决策记录

待评审确认：

1. **最小间隔取值**：80ms（倾向，≈12fps 渲染节律，delta 密度下观感连贯）vs 100ms vs 50ms。倾向 80ms，实机可调。
2. **缓存是否覆盖非流式调用方**（文件查看器 / 轨迹）：倾向覆盖（纯 perf，键含 isDark 无失效歧义）。
3. **LRU 容量与超长块阈值**：200 条 / 10KB（倾向），实施时按内存画像微调。
