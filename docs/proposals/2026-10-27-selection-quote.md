# 提案：圈一段就能问 —— 回复、文件、Diff、终端的选区引用

> 对话里的追问天然是「针对某一段」的：「这一步为什么这么做」「第 40 到 60 行这个函数改一下」「终端里这段报错是什么意思」。今天桌面端只能整文件 `@` 引用、整条消息复制，用户要么手动复制粘贴再补一句「上面这段」，要么用文字描述位置让 Agent 自己去找。飞书渠道早就支持「引用回复」注入上下文，主对话反而没有。

- 状态：**已确认**（2026-10-27：P3 终端选区引用驳回；P2 用标记外的行号 + 片段，上限 200 行 / 8KB。技术方案见 [../plan/2026-10-27-selection-quote-technical-design.md](../plan/2026-10-27-selection-quote-technical-design.md)，决策 D1–D10）
- 日期：2026-10-27
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（P1 约 1.5 人日、P2 约 2 人日；P3 不做。零迁移；后端仅标题预处理）
- 关联：`desktop/src/components/chat/ChatInput.vue`、`desktop/src/components/chat/tiptap/`、`desktop/src/components/chat/MessageBubble.vue`、`desktop/src/components/center/FileViewer.vue`、`desktop/src/composables/useMonacoViewer.ts`、`desktop/src/components/center/FileDiffViewer.vue`

> 评审结论以技术方案为准。下文 P3、以及「扩展标记为 `@{path#L120-145}@`」保留作提案原文，不再实施。

## 1. 背景与现状

### 1.1 引用粒度只有「整个文件」（代码可查）

| 来源 | 今天能怎么带进对话 | 证据 |
|---|---|---|
| 工作区文件 | 输入框 `@` 选文件，序列化为 `@{path}@`，**只有路径没有行号** | `tiptap/FileReferenceNode.ts:58-60` |
| 助手回复 | 只能整条复制；输入框 `blockquote: false`，粘贴进来也是普通段落 | `MessageBubble.vue:174`、`ChatInput.vue:527` |
| 文件预览（Monaco 只读） | 能选中、能复制，无「引用到对话」 | `useMonacoViewer.ts:40-61` |
| Diff 查看器 | 同上 | `FileDiffViewer.vue` |
| 终端 | 同上 | `TerminalPanel.vue` |
| **飞书渠道** | 用户在飞书里「引用回复」，引用内容自动注入，过长自动落文件并给路径 | `backend-ts/src/feishu/quoted-injection.ts` |

### 1.2 后果

- **整文件引用让模型自己找位置**：用户说「@app.ts 里那个重试逻辑有问题」，模型要先读全文件再猜是哪段，耗 token、可能猜错。
- **复制粘贴丢了来源**：粘贴进来的代码模型不知道出自哪个文件哪几行，改完无法精确落回原位置。
- **回复追问靠描述**：长回复里第 3 条建议想追问，用户只能写「你说的第三点」——当回复被压缩或有多处「第三点」时就会指错。

### 1.3 一个真实场景

Agent 生成了一份 400 行的 `report.py`，用户在文件预览里看到第 120~145 行的日期处理不对。现在的做法：复制这 26 行 → 回到输入框粘贴 → 补一句「这是 report.py 第 120 行开始的那段，日期要按自然周算」。理想做法：在预览里选中 → 点「引用到对话」→ 输入框出现一个 `report.py:120-145` 小标签 → 打字「日期要按自然周算」→ 发送。

## 2. 目标 / 非目标

**目标**

1. **P1 回复引用追问**：在助手回复里选中文字，浮出「引用」按钮；输入框顶部出现引用块（可移除），发送时序列化为 Markdown 引用（`> ...`）置于消息开头。整条消息的操作栏也加「引用」按钮（引用全文，超长截断）。
2. **P2 文件 / Diff 行区间引用**：Monaco 预览与 Diff 查看器中选中行，右键菜单与浮动按钮「引用到对话」；输入框插入带行号的文件标签 `report.py:120-145`。发送时保留既有 `@{path}@` 标记不变，**后接行号与内联片段**（见 4.2），模型不必再读整文件。
3. **P3 终端选区引用**：终端选中输出 → 「引用到对话」，以 ```` ```text ```` 代码块附在消息里，标注「来自终端」。

**非目标**

- 不改 `@{path}@` 标记格式（6 处解析点依赖它：`useChat.ts`、`quick-command-parser.ts`、`internalMarkers.ts`、`title-generator.ts`、`feedback.service.ts`、飞书入站）。
- 不做跨会话引用（引用别的会话的消息）。
- 不做图片区域框选引用。
- 不改后端、不改提示词；引用就是用户消息里的普通文本。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 执行中引导（2026-10-24 否决） | 不改变执行中的语义；引用只发生在用户正常发消息时。 |
| 结构化回复卡片（2026-10-19 否决） | 不引入任何块协议；引用序列化为纯 Markdown 文本。 |
| 会话列表与长会话导航「只看回复」（0.0.358 移除） | 不是导航功能；是输入能力的补齐。 |

## 4. 方案

### 4.1 P1 回复引用

- `MessageBubble`：监听回复正文的 `selectionchange`，选区非空且落在 `.markdown-content` 内时在选区上方浮出小按钮；点击后 emit `quote(text)`。
- `ChatInput`：新增 `quotes: QuoteItem[]` 状态，渲染在编辑器上方（类似 `ChatPendingFileList` 的条状列表），每项可移除；多个引用按顺序拼接。
- 序列化：`> 引用内容逐行加前缀` + 空行 + 用户输入；单个引用上限 2000 字，超出截断并标注「…（已截断）」。
- 草稿：`stores/draft.ts` 一并保存 quotes，切会话不丢。

### 4.2 P2 文件 / Diff 行区间引用

- `useMonacoViewer`：`editor.addAction({ id: 'quote-to-chat', label: '引用到对话', contextMenuGroupId: 'navigation' })`，取 `getSelection()` 的起止行（选区为空时取光标所在行）。Diff 查看器对 modified 侧同样注册。
- 通过既有 CenterTabs 与聊天面板的事件通道把 `{ path, startLine, endLine, snippet }` 送到当前会话的 ChatInput。
- `FileReferenceNode` 扩展可选属性 `lineStart / lineEnd / snippet`，标签显示 `文件名:120-145`。`renderText` 序列化为：

  ````text
  @{/abs/path/report.py}@ 第 120-145 行：
  ```python
  ...片段...
  ```
  ````

  标记本身不变，既有 6 处解析点零改动；行号与片段在标记之外，作为普通文本给模型。
- 片段上限 200 行 / 8KB，超出只给行号不内联（模型可按行号自行读取）。语言标识沿用文件预览已识别的语言。
- 引用来自「已被 Agent 改过的旧版本」时（文件 mtime 晚于打开预览时间），标签加「内容可能已变化」提示——复用文件预览既有的 mtime 检测（`workspace-file-provider.ts`）。

### 4.3 P3 终端选区

- xterm `getSelection()`，右键菜单加「引用到对话」；按 4.1 的 quotes 通道进入输入框，序列化为 ```` ```text ```` 块并前置「终端输出：」。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | MessageBubble 选区浮钮、ChatInput 引用条与序列化、FileReferenceNode 属性扩展、useMonacoViewer / FileDiffViewer / TerminalPanel 菜单项、draft store |
| backend-ts / admin / contracts | 无 |
| android | 随 desktop Web 自然获得 P1（触屏长按选区浮钮需验证）；P2/P3 在安卓不显示入口（无文件预览右键、无终端） |
| mao-cli | 文档 `reference/desktop.md` 补用法 |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 选区浮钮与浏览器原生复制菜单冲突 | 浮钮只在 mouseup 后出现，Esc / 点击空白消失；不拦截复制 |
| 内联片段让用户消息变长，影响标题生成与全文检索 | 标题生成已剥离 `@{}@`；对片段代码块同样剥离（`title-generator.ts` 加一条规则，这是唯一的后端顺手改动，可选） |
| 用户消息里出现大量引用文本，编辑重发时不好改 | 编辑态把引用还原成引用条（解析 `> ` 前缀与带行号的文件标签），P1 先接受「编辑时显示为纯文本」 |
| 安卓长按选区与系统菜单冲突 | P1 在安卓仅保留操作栏「引用」按钮，不做选区浮钮 |

## 7. 测试要点

1. 回复中跨段落选区（含列表、代码块、公式）序列化为合法 Markdown 引用。
2. `FileReferenceNode` 带行号时 `renderText` 输出标记 + 行号 + 片段；不带行号时与现状逐字节一致（回归护栏）。
3. 6 处 `@{}@` 解析点在带行号引用下仍只提取到路径。
4. 片段超 200 行时不内联、只给行号。
5. 草稿保存 / 恢复包含引用条；切会话不串。

## 8. 待确认决策

1. P2 是「标记外附行号 + 片段」（推荐，零解析点改动）还是扩展标记为 `@{path#L120-145}@`（更紧凑，需改 6 处解析）？
2. 片段上限 200 行 / 8KB 是否合适？
3. P3 终端引用是否值得做（终端使用率需要数据支撑）？
