# 选区引用追问技术方案

> 状态：可行，已确认（D1–D13，待实施）
> 日期：2026-10-27
> 上游提案：[docs/proposals/2026-10-27-selection-quote.md](../proposals/2026-10-27-selection-quote.md)（P3 终端选区引用已驳回；P2 按「标记外附行号 + 片段」）
> 覆盖端：desktop；标题预处理一处在 backend-ts；admin / contracts / agent-cli / 安卓原生壳零改动
> 迁移：无（不占号）
>
> 2026-10-27 可行性评审：需求与方案主体可行。D10 的结论不变，比较信号改为 §5.4 的修订号。D11–D13 是评审补上的缺口。

在助手回复里选中一段，或在文件预览 / Diff 里选中若干行，引用进当前输入框再追问。发出去的仍是普通用户消息文本：回复引用是开头的 Markdown 引用块，文件引用保持现有 `@{路径}@` 标记，行号和片段写在标记外面。

---

## 0. 决策记录

2026-10-27 评审确认：

| # | 决策 | 结论 |
|---|---|---|
| D1 | 原 P3 终端选区引用 | **驳回**。`TerminalPanel.vue` 不改。终端使用率不作为本方案的前置数据 |
| D2 | 文件行号放哪 | **标记外**。序列化仍是 `@{路径}@`，后面接「第 N-M 行」和可选代码块。不改成 `@{path#L120-145}@`，现有解析正则一行不动 |
| D3 | 片段上限 | **200 行或 8KB（UTF-8 字节），先到先停**。超出只留行号，不内联片段。常量集中，不进设置 |
| D4 | 回复引用上限 | **单条 2000 字**（JavaScript 字符串长度）。超出截断，并在引用块末行写 `…（已截断）` |
| D5 | 编辑已发送的消息 | **编辑框里是序列化后的纯文本**，不把引用还原成引用条或文件标签。不写反向解析器 |
| D6 | 安卓 | **只保留回复操作栏的「引用」**。不做选区浮钮，不注册文件 / Diff 的「引用到对话」。判定用现成 `isAndroidCapacitor()` |
| D7 | 后端 | **只改标题预处理**。提示词、飞书引用注入、全文检索、反馈预览都不改 |
| D8 | 空选区 | 浮钮只在选区非空时出现。文件 / Diff 右键在选区为空时引用光标所在的一整行 |
| D9 | Diff 范围 | **只做 SNAPSHOT 的修改后一侧**。PATCH、原始一侧、Markdown 渲染态、CSV / 表格 / 压缩包 / PDF / 图片 / 音视频都不提供入口 |
| D10 | 过期提示 | 引用捕获之后，同一路径又出现新的文件变更，输入框标签加「内容可能已变化」。发给模型的文本不含这句提示。信号是 §5.4 的修订号，不是变更条数 |
| D11 | Git Diff | **不提供引用**。Tab id 前缀是 `git-diff:`。多仓库时路径被加上仓库前缀，不是工作区里能直接读的文件 |
| D12 | 发出去之后怎么显示 | 存储、复制、编辑重发仍是全文。气泡、待发送队列、轮次摘要、分叉标签把开头的回复引用折成一行，不把 `> ` 铺开 |
| D13 | 标题剥哪些围栏 | **只剥文件行区间自带的那一段围栏**。用户自己写的代码块留在标题素材里 |

---

## 1. 背景与目标

今天 `@` 文件只有路径。模型要自己在整份文件里找用户说的「那段」。从回复里复制出来的文字没有「这是哪一条回复的哪一段」。文件预览和 Diff 能选中、能复制，没有「引用到对话」。

目标：

1. 助手回复里选中文字，选区上方出现「引用」。点击后输入框上方多一条可删除的引用。整条回复的操作栏也有「引用」，引用这条回复里用户能看见的正文。
2. 文本预览和工具变更 Diff（修改后一侧）里选中行，右键和选区浮钮都能「引用到对话」。输入框里是一枚 `文件名:120-145` 标签。发送时标记格式不变，行号和片段跟在标记后面，模型直接看到片段，不必先读整文件。Git Diff 不提供这个入口。
3. 引用条和带行号的文件标签随现有草稿走，切换会话不丢、不串。

不做：

- 终端选区引用。Git Diff 也不引用。
- 改 `@{路径}@` 的语法，或改任何一处现有解析正则。
- 跨会话引用、图片区域框选、改系统提示词、改飞书「引用回复」注入。
- 把已发送消息编辑回引用条。
- 新接口、新表、新契约类型。

---

## 2. 现状代码事实（实施前已核对）

行号为 2026-10-27 工作区读到的位置，实施时以符号为准，行号会漂。

### 2.1 提案里三处和代码对不上的地方

实施按本节，不按提案原文的类名和文件名。

| 提案写法 | 代码事实 |
|---|---|
| 选区落在 `.markdown-content` | 没有这个类。助手正文是 `MarkdownContent`，`body-class="assistant-text markdown-body"`（`MessageBubble.vue` 约 96–102、112–118 行） |
| 复用 `workspace-file-provider.ts` 的 mtime，和「打开预览的时间」比 | provider 的 `mtime` 只出现在目录条目上，预览打开时不记 mtime。`FileViewer` 的 300ms 重载看的是 `matchingChangeCount`（约 154–160、384–395 行），而 `appendFileChange` 对同一 `path` 是原地合并，条数对同一路径字符串不会再增加。同文件第二次修改时，这个 watch **不会**重载。本方案要改这个触发条件，见 §5.4 |
| 六处解析点含「飞书入站」 | 飞书入站是**写入** `@{路径}@`（`quoted-injection.ts`、`merge-forward.ts`），不解析桌面用户打出来的引用。真正按 `/@\{([^}]+)\}@/` 取出花括号内路径的调用点见 §2.3 |

### 2.2 输入与展示

| 事项 | 现状 | 位置 |
|---|---|---|
| 文件标签节点 | 原子 inline 节点，唯一属性 `filePath`。`renderText` 输出 `@{${filePath}}@`，标签只显示文件名 | `tiptap/FileReferenceNode.ts` |
| 编辑器能力 | `StarterKit` 关掉了 `blockquote`、列表、代码。粘贴普通文字（含从回复复制的内容）变成纯段落，不会变成引用块 | `ChatInput.vue` 约 524–541 行 |
| 发送取文本 | `editor.getText({ blockSeparator: '\n' })`。原子节点走 `renderText`，其中的换行会进消息正文 | `ChatInput.vue` `handleSend` 约 1094 行 |
| 发送后路径 | `resolveFileRefPaths` 把标记内的相对路径拼成工作区绝对路径；已是绝对路径（含 Windows 盘符）的不动。乐观气泡和实际发送用同一份文本 | `useChat.ts` `resolveFileRefPaths` |
| 能否发送 | `canSend` 要求编辑器有文字或有待发附件。只有引用、输入框为空时今天发不出去 | `ChatInput.vue` `canSend` 约 284 行 |
| 草稿 | Pinia 内存，不落 localStorage。`DraftEntry` 是 `html + text + files`。`html` 来自 `getHTML()`，自定义节点属性只要写进 `parseHTML` / `renderHTML` 就能随草稿往返。空草稿（无文字、无附件、html 为空壳）会删条目 | `stores/draft.ts`；`ChatInput.vue` `buildCurrentDraft` 约 724 行 |
| 「添加到聊天」路由 | `TaskView.handleAddFileToChat`：当前 Tab 的输入框有注册就插入；文件 / Diff Tab 没有输入框，切回主会话 `chat` 再插入。主会话 key 是 `'chat'`，边路是 tabId（如 `side:123`）。KeepAlive 下多个 `ChatInput` 同时挂载，不能用单例注册 | `TaskView.vue` 约 298–330 行 |
| 插入实现 | `insertFileReference` 在光标处插入节点，并在节点后加一个空格 | `ChatInput.vue` 约 1212–1227 行 |
| 用户气泡 | 不走 Markdown。`parseQuickCommandSegments` 把 `@{路径}@` 切成 file 段，其余是纯文本。`FileReferenceTag` 只显示文件名，悬停才是完整路径 | `quick-command-parser.ts`；`FileReferenceTag.vue` |
| 助手操作栏 | 复制、点踩、Fork、分享。流式输出中整条栏不渲染（`!isAssistantRunning`） | `MessageBubble.vue` 约 167 行 |
| 编辑重发 | 用户消息编辑态是 `<textarea>`，内容是 `userVisibleText(message.content)`，确认后整段重发。不经过 TipTap | `MessageBubble.vue` 约 68–86、347–362 行 |

### 2.3 标记的解析点（正则都不改）

下列调用点都用「花括号里整段是路径」的语义。行号和片段必须写在 `}``@` 之后，解析点才会继续只拿到路径。

| 调用点 | 行为 |
|---|---|
| `useChat.ts` `FILE_REF_PATTERN` | 相对路径改写成绝对路径 |
| `quick-command-parser.ts` `FILE_PATTERN` | 切出 file 段，`filePath` = 花括号内原文 |
| `internalMarkers.ts` `stripInternalMarkers` | 展示 / 复制时把标记换成路径本身 |
| `ChatInput.vue` 粘贴与 `markedTextToEditorHtml` | 把标记还原成**只有 filePath** 的节点。带行号的消息被粘贴或撤回回填时，标记变成普通文件标签，行号和片段留在周围纯文本里。这是 D5 的同一取舍，不在这里补行号属性 |
| `title-generator.ts` | 标题前删掉整个标记。本方案在这一函数里**额外**删片段和开头引用块，正则本身不变（§7） |
| `feedback.service.ts` `buildPreview` | 标记换成路径，再压空白、截断。点踩预览可能以片段开头。接受，不改 |
| `prompt-engine.ts` `FILE_REF_PATTERN` | 送给模型之前把标记换成裸路径。模型最终看到的是「绝对路径 + 第 N-M 行 + 代码块」，不是带花括号的标记。系统提示里关于 `@{绝对路径}@` 的句子不改：片段还在，路径也还在；片段被省略时，模型仍能按这个路径和行号自己读 |
| `sdk/embed/src/ui/userContent.ts` | 嵌入页展示时同样把标记换成路径。嵌入页不增加引用入口；桌面发出的历史消息在嵌入页会显示路径加后面的纯文本。接受 |

全文索引建在 `message.content` 上。片段会进索引，用户能搜到自己引用过的代码。不改索引、不改查询。

### 2.4 预览与 Diff

| 事项 | 现状 | 位置 |
|---|---|---|
| 文本预览编辑器 | `useMonacoViewer` 只读，`contextmenu: true`。创建后不把 editor 交还给调用方，外部无法 `addAction` | `useMonacoViewer.ts` |
| 何时有编辑器 | `state === 'ready' && showSource`。Markdown 默认是渲染态，没有 Monaco。CSV / zip / xlsx / docx / 媒体 / PDF / 图片不走这个编辑器 | `FileViewer.vue` `monacoEnabled` |
| 文本从哪来 | `readFile`，上限 5000 行 / 512KB，截断会标 `truncated`。编辑器里的行号就是文件里已加载前缀的行号 | `FileViewer.vue` `loadFile` |
| Diff | `SNAPSHOT` 用 `createDiffEditor`，左右各一个 model，语言来自 `monacoLangFromExtension(change.path)`。`PATCH` 是一块 `diff` 语言的普通编辑器，行号不是文件行号。从变更面板打开时，`path` 被改写成 `displayPath`（工作区相对路径），原始 `change.path` 不再留在 Tab 上 | `FileDiffViewer.vue` 约 129–170 行；`FileChangePanel.vue` `handleFileClick` |
| 语言 id | `monacoLangFromExtension`，未知扩展名是 `plaintext` | `utils/monaco-lang.ts` |
| 文件变更列表 | `sessionStore.activeFileChanges` 只取**当前激活会话**，激活会话一直是主会话，边路 / 子代理的变更在各自 sessionId 下。`appendFileChange` 按 `path` 字符串合并，不追加。上拉历史会把同路径的旧变更再 prepend 进来，条数会在没有新编辑时变大。预览用 `change.path === filePath` 做比较，事件里的 `path` 是模型传入的 `filePathArg`，不一定是绝对路径 | `stores/session/messages.ts` `appendFileChange`；`useChat.ts` `loadOlderMessages`；`edit-file-tool.ts` 的 `file_change.path` |
| Diff Tab | `openDiffTab` 存的是 `{ ...change }` 快照，之后的 `appendFileChange` 不会改这份拷贝。工具变更的 Tab id 前缀是 `diff:`，Git 变更是 `git-diff:` | `useCenterTabs.ts` `openDiffTab`；`TaskView.vue` `handleOpenGitDiff` |
| 执行中的输入框 | `loading` 表示正在运行，占位符是「消息将进入队列」，输入框**仍可编辑**。`disabled` 默认 false，`ChatPanel` 不传。`insertFileReference` 只在 `disabled` 时返回 | `ChatInput.vue` 约 341、1212 行 |

### 2.5 安卓

`isAndroidCapacitor()`（`utils/capacitor.ts`）在 Web 和 Electron 上为 false，只在安卓壳为 true。壳远程加载同一份 desktop，没有单独的引用 UI 工程。文件预览在安卓上仍可能打开，但本方案不在那里放 P2 入口（D6）。

---

## 3. 序列化契约

新增 `desktop/src/utils/selection-quote.ts`，纯函数，不碰 Vue。UI 只调用这里，避免输入框、气泡、标题三处各写一套格式。

常量：

```ts
export const REPLY_QUOTE_MAX_CHARS = 2000
export const FILE_QUOTE_MAX_LINES = 200
export const FILE_QUOTE_MAX_BYTES = 8 * 1024
```

### 3.1 回复引用

```ts
export interface ReplyQuote {
  id: string
  text: string
  truncated: boolean
}

export function capReplyQuote(text: string): { text: string; truncated: boolean }
export function serializeReplyQuotes(quotes: ReplyQuote[]): string
```

`capReplyQuote`：去掉首尾空行，内部空行保留。长度按 `string.length`。超限时截到 2000 字以内的最后一个换行（没有换行就硬切），`truncated = true`。

`serializeReplyQuotes`：每条引用的每一行加 `> ` 前缀（空行写成 `>`）。`truncated` 时再追加一行 `> …（已截断）`。多条之间用一个空行隔开，这样 Markdown 不会把它们并成一块。结果末尾再加一个空行，和用户自己的输入分开。没有引用时返回 `''`。

示例（两条，第二条被截断）：

```text
> 第一段
> 第二行

> 只剩开头
> …（已截断）

日期要按自然周算
```

### 3.2 文件行区间

```ts
export interface FileRangeQuote {
  filePath: string
  lineStart: number
  lineEnd: number
  /** 未超限时的片段；超限时为 null */
  snippet: string | null
  /** monaco 语言 id；plaintext 或空则围栏不写语言 */
  languageId: string
}

export function measureSnippet(text: string): { lines: number; bytes: number }
export function serializeFileRange(quote: FileRangeQuote): string
export function fenceLanguage(languageId: string): string
```

`measureSnippet`：行数按 `\n` 切分（末尾没有多余空行）；字节用 `TextEncoder` 的 UTF-8 长度。

`serializeFileRange` 两种形态，标记本身与今天逐字节相同：

未超限，单行：

```text
@{src/report.py}@ 第 120 行：
```python
line
```
```

未超限，多行：`第 120-145 行：`，围栏语言来自 `fenceLanguage`。`plaintext` 和空字符串都不写语言标记，围栏只有三个反引号。

超限（`snippet == null`）：

```text
@{src/report.py}@ 第 120-400 行（片段过长未内联，请按行号读取）
```

没有围栏，也不写「第 N 行：」那种冒号形态，两种形态靠这句话区分，折叠展示才能识别（§6.3）。

围栏长度：片段里若某行的反引号不少于围栏，把围栏加到「最长反引号行 + 1」，避免片段里的 ` ``` ` 把围栏提前关掉。闭合围栏单独占一行。

`serializeFileRange` 的返回值就是节点的 `renderText`。无行号的节点不走这个函数，`renderText` 仍是 `@{${filePath}}@`，与现在逐字节一致。

### 3.3 从选区取片段

编辑器选区使用起止行号，**取整行**，不取列范围。空选区用光标行，`lineStart == lineEnd`。

行内容用 model 的 `getLineContent`，行之间用 `\n` 连接，不追加结尾空行。然后 `measureSnippet`。行数大于 200 或字节数大于 8192，`snippet = null`，行号仍是用户选的起止行（不是截到 200 行的窗口）。

捕获时同时记下 `capturedChangeCount`：§5.4 的修订号。文件预览记点击时的值，Diff 记 Tab 打开时的值。这是数字属性，不是一段 mtime，也不是变更条数。

---

## 4. 回复引用（原 P1）

### 4.1 选区浮钮

只在 `!isAndroidCapacitor()` 且该气泡不在流式输出中时启用。

`MessageBubble` 在自己的 `.markdown-body` 上听 `pointerup`。同时满足才显示浮钮：

- `window.getSelection()` 非空、未折叠。
- 选区的 anchor 与 focus 都在**这一条**气泡的**同一个** `.markdown-body` 里。一条回复可以有多段正文，中间隔着工具卡片。跨段、跨气泡、跨到工具卡片 / 思考块 / 来源区的选区不显示。
- 选出来的纯文本（§4.2）非空。

浮钮 `position: fixed`，放在选区 `getBoundingClientRect()` 的上沿，避免挡住选区。按钮的 `mousedown` 要 `preventDefault`，否则点按钮会先清掉选区。引用文本在 `pointerup` 时就存进组件状态，点击时用这份快照，不再读选区。

鼠标选区走 `pointerup`。键盘选区（Shift+方向键）不会产生 `pointerup`，同一套判断在气泡上的 `keyup` 再走一次，否则键盘只能用操作栏引用整条。

不拦截 `copy`、不 `preventDefault` `pointerup`。Esc、选区折叠、点到浮钮以外、消息列表滚动、窗口 `resize`，都把浮钮收起。滚动不会让选区折叠，固定定位的按钮会停在旧坐标上。

浮钮文案：「引用」。

### 4.2 选区纯文本

不用 `selection.toString()` 作为最终结果。KaTeX 的 DOM 里 `.katex-html` 与 `.katex-mathml` 各有一份文本，`toString()` 会把公式读两遍。

用 `Range` 遍历文本节点：

- 跳过 `.katex-mathml`、`.code-copy-btn`、`.code-block-header`、按钮控件。代码块头上的语言名和「复制」不是正文。
- 块级元素（`p`、`div`、`li`、`pre`、`h1`–`h4`、`tr`、`blockquote`）在边界补换行。
- `td` / `th` 在边界补 ` | `，否则同一行的单元格会粘成一个词。行与行之间仍靠 `tr` 的换行。
- 把 `\u00a0` 换成普通空格，去掉每行行尾空格，去掉首尾空行。

这是用户看见的文字，不是 Markdown 源码。代码块引用到的是代码文本，没有围栏；列表引用到的是条目文本。公式只留 `.katex-html` 里的可读文本。任务是「针对这段追问」，模型需要的是这段内容，不是把渲染结果还原成源码。

### 4.3 操作栏「引用」

操作栏现有按钮旁加「引用」，桌面和安卓都显示。流式输出中操作栏本来就不渲染，因此不会引用半条回复。

正文取当前气泡里所有 `type === 'text'` 的 `renderSegments`，用 `\n\n` 接起来。没有 segments 时用 `message.content`。不包含思考块、工具调用、来源区、文件变更面板。再走 `capReplyQuote`。

点选区浮钮或操作栏，都 `emit('quote', text)`。父组件（`ChatRoundList` 已有向 `TaskView` 上传事件的路径）把文本交给 §6.1 的当前输入框。输入框自己 `capReplyQuote`，父组件只传原文，避免两处各截一次。

### 4.4 引用条

`ChatInput` 增加 `replyQuotes: ReplyQuote[]`。渲染在编辑器上方、待发附件列表附近，样式对齐 `ChatPendingFileList`：一条一行，左侧截断的引用摘要（约 80 字），右侧移除。顺序就是发送顺序。同一条回复多次引用允许多条，不合并。

`id` 用 `crypto.randomUUID()`。只在内存草稿里用来做列表 key。

---

## 5. 文件与 Diff 行区间（原 P2）

### 5.1 编辑器把实例交出来

`useMonacoViewer` 增加可选回调 `onEditor(editor | null)`：创建成功后传入实例，`disposeEditor` 时传入 `null`。`enabled` 从 false 再变 true 会新建实例，回调再走一次。主题切换、`setValue` 不重复回调。

`FileViewer` 只在 `!isAndroidCapacitor()` 时注册动作。Markdown 渲染态没有编辑器，自然没有入口；用户要引用得先切到源码。非文本预览不注册。

### 5.2 右键与浮钮

在编辑器上，**只在创建实例时注册一次**。`FileDiffViewer.syncViewer` 会反复 `setModel`，编辑器对象还是同一个；每次 sync 都 `addAction` 会在右键菜单里叠出多条「引用到对话」。

```ts
editor.addAction({
  id: 'mao.quote-to-chat',
  label: '引用到对话',
  contextMenuGroupId: 'navigation',
  run: (ed) => { /* 读选区或光标行，见 §3.3 */ },
})
```

选区非空时，在编辑器容器里放一个绝对定位的「引用到对话」按钮，位置用 `getScrolledVisiblePosition` 跟选区末行。编辑器滚动时更新位置；选区折叠、编辑器失焦到容器外、或内容被重载时隐藏。按钮 `mousedown` `preventDefault`，理由同 §4.1。按钮挂在容器上、盖住 Monaco 的层，避免被编辑器自身的 `overflow` 裁掉。

空选区不显示浮钮。右键动作在选区为空时取光标行（D8）。

### 5.3 Diff

仅 `mode === 'SNAPSHOT'`、Tab id 以 `diff:` 开头（不是 `git-diff:`）、且 `!isAndroidCapacitor()`。`CenterTabContainer` 把这个判断传给 `FileDiffViewer`（它自己拿不到 Tab id）。动作加在 `diffEditor.getModifiedEditor()` 上，片段来自 modified model。原始一侧不加动作：那是改之前的内容，和「这个文件的这几行」不是同一件事。

`PATCH` 模式不加动作。行号是 diff 文本的行号，写进「第 N 行」会让模型去读文件的错误位置。

Markdown diff 的渲染态没有 Monaco，与文件预览相同，不提供入口。Git Diff 是 `SNAPSHOT`，但按 D11 排除。

Diff Tab 是打开时的快照。引用读的是屏幕上这一版，不在点击时重读磁盘：重读会把用户没看见的新内容配上旧行号。打开或再次点开变更时，把当时的修订号（§5.4）记在 Tab 上。插入节点时，文件预览用**点击时**的修订号（预览已经跟着重载，内容就是这一版）；Diff 用 **Tab 上记下的修订号**（快照没有跟着变）。当前修订号已经更大时，标签插入后就是「内容可能已变化」。

### 5.4 路径与过期

插入节点时 `filePath` 用预览当前的 `filePath`，或 Diff Tab 上的 `change.path`（从变更面板打开时已是 `displayPath`）。不在插入时自行拼绝对路径。发送时仍只由 `resolveFileRefPaths` 改写标记内部。

过期不看条数。同一路径字符串会被 `appendFileChange` 合并，条数不加；上拉历史又会把旧变更 prepend 进来，条数在没有新编辑时变大。两条都会让条数比较漏报或误报。`activeFileChanges` 也看不到边路和子代理改的同一批文件。

改为工作区级修订号：

- store 里放 `Map<workspaceKey, Map<relPath, number>>`。只有 `appendFileChange` 这条实时路径 +1（合并同样 +1，新路径从 1 起）。`setFileChanges`、上拉历史都不动它。
- 键的工作区：`useStreamWS` 的 `file_change` 分支按事件 `sessionId` 解析。先 `getSessionEntity`，实体上有 `workspace` 就用。没有实体，或实体没有 `workspace`，则 `findSideTaskRootKey` 取根会话的 `workspace`；再没有则在子代理缓存里找到父会话，父会话若是边路再找到根。找不到工作区就不递增（漏报，不用原始 path 去撞另一个工作区的同名相对路径）。
- 相对路径用 `toRelativeWorkspacePath(workspace, path)`。事件里的 `path` 常是相对路径，预览和 Diff 上可能是绝对路径或 `displayPath`，不归一会永远对不上。
- 节点属性仍叫 `capturedChangeCount`，存的是捕获时的修订号，不是条数。
- `ChatInput` 用自己的 `workspace` prop 归一节点路径，读这张表。当前修订号大于 `capturedChangeCount` 时 `stale = '1'`，否则把 `stale` 写成 `null`（不要写 `'0'`，标签只认 `'1'`）。`renderText` 不输出提示句（D10）。别的文件的修订号不看。

`FileViewer` 的重载改看这个修订号变大，不再看 `matchingChangeCount`。同文件第二次修改也会重载，下一次引用拿到的是新内容和新的修订号。重载沿用现有 300ms 去抖；去抖期间浮钮按 §5.2 隐藏。陈旧只发生在「已经放进输入框、文件随后又被改了」，以及 §5.3 里 Diff 快照本来就落后于当前修订号的情况。

### 5.5 节点属性

`FileReferenceNode.addAttributes` 增加：

| 属性 | HTML | 缺省 | 说明 |
|---|---|---|---|
| `lineStart` | `data-line-start` | null | 1-based。null 表示普通 `@` 文件 |
| `lineEnd` | `data-line-end` | null | 单行时等于 lineStart |
| `snippet` | `data-snippet` | null | 见下方编码 |
| `languageId` | `data-language-id` | null | |
| `capturedChangeCount` | `data-captured-change-count` | null | §5.4 的修订号。`parseHTML` 用 `Number`，不是整数就当 null |
| `stale` | `data-stale` | null | 只认 `'1'`。过期写 `'1'`，恢复写 `null`。只影响标签，不影响 `renderText` |

`snippet` 进 HTML 属性前 `encodeURIComponent`，`parseHTML` 时 `decodeURIComponent`。片段里的换行和引号不能直接放进属性，否则 `getHTML()` / 草稿恢复会截断。无行号的旧节点没有这些属性，`parseHTML` 得到 null，`renderText` 走原路径。

`renderHTML` 的可见文字：

- 无行号：文件名（与现在一致）
- 单行：`文件名:120`
- 多行：`文件名:120-145`
- `stale === '1'`：再接 ` · 内容可能已变化`

文件名按 `/` 和 `\` 两头切。现有节点只 `split('/')`，Windows 路径或带反斜杠的 `filePathArg` 会把整段路径显示出来。

`insertFileReference` 的参数从 `string` 扩成 `{ filePath, lineStart?, lineEnd?, snippet?, languageId?, capturedChangeCount? }`。不传行号时行为与现在一致，包括节点后的那个空格。文件树、变更面板的「添加到聊天」继续传纯路径，不带行号。

带行号时，`renderText` 已经以换行结束，节点后仍保留一个空格，方便光标继续打字。发送结果里，用户的字在围栏闭合之后。

`ChatInputHandle` 增加 `insertFileRangeQuote(quote: FileRangeQuote & { capturedChangeCount: number })`。`TaskView` 用与 `handleAddFileToChat` 相同的 Tab 路由转发，并 `provide` 出去。文件页签没有输入框时仍然回到主会话，和今天「添加到聊天」一致，不另记「上次所在的边路任务」。

---

## 6. 输入框、草稿、发送、气泡

### 6.1 当前输入框

`registerChatInput` 的 handle 在 `insertFileReference` 之外增加：

- `addReplyQuote(text: string)`
- `insertFileRangeQuote(...)`

`TaskView` 提供 `quoteReplyToChat` / `quoteFileRangeToChat`，路由规则复制 `handleAddFileToChat`（先当前 Tab，没有输入框再激活 `chat`）。回复浮钮和操作栏走前者；`FileViewer` / `FileDiffViewer` 走后者。组件通过 inject 调用，不新开事件总线。

输入框 `disabled` 时，两个方法直接返回，不堆进一个发不出去的草稿。与今天 `insertFileReference` 只在 `disabled` 时返回的行为一致。正在运行（`loading`）时输入框仍可编辑，消息进队列，引用也要能加进去，不要把 `loading` 当成 `disabled`。

### 6.2 发送

`handleSend` 在 `getText` 之后：

```ts
const body = editor.value.getText({ blockSeparator: '\n' }).trim()
const quoted = serializeReplyQuotes(replyQuotes.value)
const text = `${quoted}${body}`.trim()
```

今天函数里还有一道 `if (!text && 没有附件) return`，用的是拼接前的编辑器文本。只引用、不打字时会在这里被丢掉。这道判断改用拼接后的 `text`。

`canSend` 和 `hasDraft` 把「有回复引用」算作有内容：只有引用、没有打字、没有附件，也可以发送。

发送成功后的 `clearInput` 同时清空 `replyQuotes`。失败保留，和现有「等保存确认再清空」一致。

`resolveFileRefPaths` 仍只改写标记内部。引用块和行号文本不经过它。

### 6.3 用户气泡把片段折进标签

存储和模型看到的是完整文本。气泡如果把片段当普通文本铺开，一条引用会变成一整屏代码。

`parseQuickCommandSegments` 不改。`MessageBubble` 在它的结果上再跑 `absorbFileRangeSuffix(segments)`（放在 `selection-quote.ts`）：

- file 段后面的 text 段若以 ` 第 N 行：` 或 ` 第 N-M 行：` 加一对围栏开头，把这段从 text 段里吃掉，给 file 段加上 `lineStart` / `lineEnd`。围栏按 §3.2 的可变长度闭合。
- 或以 ` 第 N-M 行（片段过长未内联，请按行号读取）` 开头（单行同理，`N-M` 写成单个 `N`），吃掉这一句，不期待围栏。
- 吃不干净的剩余文本留在 text 段。对不上的原文原样显示。

`FileReferenceTag` 增加可选 `lineStart` / `lineEnd`。有行号时主文案为 `文件名:120` 或 `文件名:120-145`，悬停仍是完整路径。不在气泡里展开片段。复制按钮继续复制 `userText` 全文，片段还在剪贴板里。

编辑重发打开的 textarea 是全文（D5），用户能看到并改掉片段。改乱之后若不再匹配 §3.2，气泡就不再折叠，这是预期。

回复引用同样不在气泡里铺开（D12）。用户气泡不渲染 Markdown，`> ` 会以原文出现在折叠预览的前 10 行里，用户自己的问题被挤到「展开全部」下面。`QueuePanel` 用同一套 `parseQuickCommandSegments`，不折叠的话队列里也是整段引用。

`selection-quote.ts` 增加 `splitLeadingReplyQuotes(text)`：从开头吃掉连续的引用行（空行或行首是 `>`），遇到第一行既不是空行也不以 `>` 开头就停。返回引用摘要用的纯文本，和剩下的正文。`MessageBubble` 与 `QueuePanel` 先拆这一层：引用折成和输入框一样的一行摘要（约 80 字，多条各一行），剩下的正文再走 `parseQuickCommandSegments` 和 `absorbFileRangeSuffix`。`isUserLong` 按剩下的正文算，不要把引用块算进 160 字 / 10 行。

轮次目录（`toRoundDirectoryRows`，前 16 字）和分叉标签（`forkLabelOf`，前 12 字）走 `userAskExcerpt`：先 `userVisibleText`，再去掉开头回复引用，再 `stripInternalMarkers`，再按 `absorbFileRangeSuffix` 的规则去掉紧跟路径的行号和围栏。剩下为空则用「引用」。两处现在都是 `stripInternalMarkers(userVisibleText(...))`，`MessageBubble.imageUrl.test.ts` 锁了这个表达式，实施时一起改。

用户自己的正文若以 `>` 开头，会连着被吃进引用摘要和标题剥离。接受，不另做转义。

### 6.4 草稿

`DraftEntry` 增加 `quotes?: ReplyQuote[]`。旧草稿没有这个字段，恢复时当成 `[]`。

`isEmptyDraft`：`quotes` 非空则不是空草稿，即使 html 和 text 都空。否则「只点了引用就切走」会把引用丢掉。

`buildCurrentDraft` / `restoreDraft` 读写 `quotes`。文件行区间不进这个数组，它在编辑器 HTML 里。`saveDraft` 的触发点（输入、切换、卸载）不变；引用条增删时要额外 `saveDraft` 一次，因为编辑器 `onUpdate` 不会因引用条变化而触发。

`clearDraft` 的调用点已经会清掉整个条目，不用单独清 quotes。

---

## 7. 标题预处理（唯一后端改动）

`preprocessForTitle`（`backend-ts/src/session/util/title-generator.ts`）在现有三步之后、快捷指令展开之前，增加下面的剥离。标记正则不动。

只处理文件行区间带进来的那一段，不扫全文围栏（D13）。用户消息里自己写的代码块今天会进标题素材，剥离全部围栏会把「帮我解释」加一块代码变成一句空话，也会把只含代码块的消息预处理成空串、从此不生成标题。

按行扫描，可以重复，直到没有下一处：

1. 找到一行，整行匹配下面之一（允许行首空白）：
   - `第 \d+ 行：`
   - `第 \d+-\d+ 行：`
   - `第 \d+ 行（片段过长未内联，请按行号读取）`
   - `第 \d+-\d+ 行（片段过长未内联，请按行号读取）`
2. 删掉这一行。
3. 若下一行匹配 `^(```+|~~~+)` 且后面只有可选的语言标记，从这一行删到同样或更长的闭合围栏行（含两端）。没有闭合就删到文末。只删紧跟在行号行后面的这一段，后面用户自己的围栏不动。不用一个正则硬吃，避免片段里的反引号让非贪婪匹配停早。

然后删掉开头连续的引用前缀：一行是空行，或以 `>` 开头，就去掉。遇到第一行既不是空行也不以 `>` 开头就停。用户自己写在中间的 `>` 不动。开头若以 `>` 起笔，会连着被去掉，与 §6.3 的展示层同一取舍。

这三步放在快捷指令展开之前。行号行和它后面的围栏先去掉，展开就不会作用在片段上。

展开并 `trim` 之后若变成空串，维持今天的行为：`generateAndApply` 看到空预处理结果就返回，不调用标题模型（有图片时仍用图片标题）。只引用、不写问题的第一条消息不会抢一个「第 120 行」这样的标题。

`session-title.service.ts` 的调用顺序不用改。它已经把预处理结果同时交给模型标题和 `TitleGenerator.generate` 降级。

反馈预览、全文检索、提示词都不做同样的剥离。

---

## 8. 改动清单

| 文件 | 改动 |
|---|---|
| `desktop/src/utils/selection-quote.ts` | 新文件。上限、截断、两种序列化、围栏、片段计量、气泡折叠、开头回复引用拆分、轮次摘要用的提问摘录 |
| `desktop/src/utils/selection-quote.test.ts` | 纯函数单测，node 环境 |
| `desktop/src/components/chat/tiptap/FileReferenceNode.ts` | 行号等属性；有行号才走新 `renderText`；文件名按 `/` 与 `\` 切 |
| `desktop/src/components/chat/ChatInput.vue` | 引用条、handle 两个新方法、`canSend` / 发送拼接（含拼接前的空文本早退）、草稿、过期标记回写。过期只看 `disabled`，不看 `loading` |
| `desktop/src/stores/draft.ts` | `quotes?` 与空草稿判定 |
| `desktop/src/components/chat/MessageBubble.vue` | 选区浮钮、操作栏「引用」、片段折叠、回复引用折成一行 |
| `desktop/src/components/chat/QueuePanel.vue` | 与气泡同一套折叠，队列里不铺开引用和片段 |
| `desktop/src/components/chat/FileReferenceTag.vue` | 可选行号文案 |
| `desktop/src/components/chat/ChatRoundList.vue` | 把 `quote` 事件向上传；分叉标签先去掉开头引用和行号片段 |
| `desktop/src/composables/useMessageRounds.ts` | 轮次目录摘要同口径 |
| `desktop/src/views/task/TaskView.vue` | handle 类型与转发，和 `handleAddFileToChat` 同一路由 |
| `desktop/src/composables/useMonacoViewer.ts` | `onEditor` 回调 |
| `desktop/src/components/center/FileViewer.vue` | 非安卓注册动作与浮钮；重载改看修订号 |
| `desktop/src/components/center/FileDiffViewer.vue` | 工具变更的 SNAPSHOT、修改后一侧、非安卓；打开时的修订号 |
| `desktop/src/components/center/CenterTabContainer.vue` | 只给 `diff:` Tab 打开引用，`git-diff:` 不传 |
| `desktop/src/composables/useCenterTabs.ts` | `openDiffTab` 把当时的修订号记在 Tab 上 |
| `desktop/src/stores/session/messages.ts` | `appendFileChange` 递增修订号；`setFileChanges` 不动它 |
| `desktop/src/composables/useStreamWS.ts` | `file_change` 分支解析工作区，供修订号的键使用 |
| `backend-ts/src/session/util/title-generator.ts` | §7：只剥行号行和紧跟的围栏，再剥开头引用 |
| `backend-ts/src/session/session-title.service.spec.ts` 或 `title-generator` 旁的单测 | 行号行与紧跟围栏、开头引用被剥掉；用户自己的围栏还在；无行号标记仍只删标记 |
| `skills/mao-cli/reference/desktop.md` | 「快捷命令与文件引用」补一段用法 |

不改：`TerminalPanel.vue`、提示词、`prompt-engine.ts` 正则、`useChat.ts`、`quick-command-parser.ts`、`internalMarkers.ts`、`feedback.service.ts`、飞书入站、embed sdk、admin、contracts、迁移、安卓 Java。

子代理面板没有输入框。在那里点「引用」会落到主会话，与「添加到聊天」相同。

实施时 CHANGELOG 记在前端小节；标题预处理对用户的影响是「引用不再占满会话标题，用户自己的代码块仍参与标题」，同一条里带一句即可，不必单独开后端小节，除非发版说明习惯把任何 backend-ts 改动都放进后端小节——按仓库 CHANGELOG 的现有分节，这一处放进后端小节一句话。

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| 浮钮和系统复制菜单抢选区 | 浮钮在 `pointerup` 之后出现，不阻止 `copy`。点按钮时 `mousedown` `preventDefault`，引用文本用 pointerup 时的快照 |
| 片段含 `@{...}@`、`#{name}#`、`${name}$` | 现有解析会把它们当成文件引用或快捷指令（路径改写、提示词展开、气泡多一枚标签）。命中已注册命令时，模型看到的是命令正文，不是片段源码。不为此改正则，也不往片段里插零宽字符（模型会把零宽字符写进补丁）。代码里真出现这串标记的情况很少，接受 |
| 片段含围栏 | §3.2 按最长反引号行加长围栏 |
| 用户消息变长，标题变成代码 | §7 只剥引用带进来的行号和围栏。全文检索会索引片段，这是可搜索性，不是缺陷 |
| 引用的是截断预览的前 5000 行 | 行号与已加载内容一致，不额外写「预览已截断」。用户选不到没加载的行 |
| 旧 Diff 的行号不是当前文件的行号 | Diff 是快照。200 行 / 8KB 以内片段还在，模型不依赖行号。超限只剩行号，模型会去读当前文件，可能读错。不在引用时重读磁盘。Tab 上的修订号已经落后时，标签标「内容可能已变化」 |
| 编辑重发时引用是一大段纯文本 | D5，明确不做还原 |
| 安卓长按与系统菜单冲突 | D6，安卓没有选区浮钮 |
| 文件页签上引用，插进了主会话而不是边路 | 与「添加到聊天」同一路由，实施时不要单独给引用做「记忆上一个边路 Tab」。过期修订号按工作区记，边路和子代理改同一文件也会让主会话里的标签变陈旧 |
| 草稿 HTML 里的片段 | `encodeURIComponent` 进属性。单条最多 8KB，Pinia 内存草稿，不写 localStorage |
| Monaco 把浮钮裁掉 | 浮钮挂在容器上并盖住编辑器层，不放进会被 `overflow` 裁切的内部节点 |

---

## 10. 测试要点

`selection-quote.test.ts`：

1. 无行号不在这个文件里测节点；节点测试见下。`serializeFileRange` 单行、多行、`plaintext` 无语言、超限句式、片段内含三个反引号时围栏变长。
2. `serializeReplyQuotes`：多行、空行、多条之间有空行、截断标记在引用内部、空列表得到 `''`。
3. `capReplyQuote`：恰好 2000 不截；2001 且中间有换行时从换行处截；无换行硬切。
4. `absorbFileRangeSuffix`：标准片段被吃掉并带上行号；超限句式被吃掉；对不上的文本原样留下；标记与片段之间若被用户改过一个字则不折叠。
5. `splitLeadingReplyQuotes`：开头两条引用被拆开，中间的空行不把它们并进正文；正文里的 `>` 保留。`userAskExcerpt`：引用加行号片段之后只留下用户的问题；什么都不剩时是「引用」。

`FileReferenceNode` 现有测试或新增：

6. 不带新属性时 `renderText` 与 `@{path}@` 逐字节相同，`renderHTML` 仍只显示文件名。
7. 带行号时 `renderText` 等于 `serializeFileRange`；`stale: '1'` 不出现在 `renderText` 里，只出现在可见标签。`stale` 为 `null` 时标签没有「内容可能已变化」。
8. `getHTML()` 再 `parseHTML` 往返后，片段里的换行、引号、`&` 还在。`data-captured-change-count` 读回来仍是数字。

解析回归（不必改那些文件的实现，补一条用例锁住行为）：

9. `resolveFileRefPaths('@{src/a.py}@ 第 1-2 行：\n```py\nx\n```', workspace)` 只把 `src/a.py` 变成绝对路径，行号和围栏原样。
10. `parseQuickCommandSegments` 对上面的字符串只产生一个 file 段，`filePath` 不含 `第`。
11. `stripInternalMarkers` 只去掉花括号标记。

标题：

12. `@{a.py}@ 第 10-12 行：` 加围栏加「请改这里」→ 预处理结果是「请改这里」（指令展开前）。
13. 开头 `> 引用\n\n问题` → 「问题」。
14. 只有引用、没有问题 → 空串。
15. 无行号的 `@{secret.ts}@` 仍被整段删除，和现有 `session-title.service.spec.ts` 的用例一致。
16. 同一条消息里，行号围栏后面还有用户自己的代码块和「请改这里」：用户的围栏保留在预处理结果里，行号那一段不保留。

修订号（store 单测，不必起 Monaco）：

17. 同一 `path` 连续两次 `appendFileChange`，数组长度仍是 1，修订号是 1 然后 2。
18. `setFileChanges` 换掉列表、或按上拉历史的方式把同路径旧变更 prepend 进来，修订号不变。
19. 另一个工作区的同名相对路径不增加这一边的修订号。找不到工作区的事件不递增。

草稿与发送可以用现有 ChatInput 单测风格做最小断言；若组件测试成本高，至少锁住 `isEmptyDraft`：仅有 `quotes` 时不删除条目。桌面端没有可靠的 Monaco 交互单测环境，右键和浮钮走手动冒烟：

- 回复里跨段落选中（含列表、代码块、公式），发送后消息以 `> ` 开头，公式不重复两遍。气泡和待发送队列里引用是一行摘要，问题正文在摘要下面；复制出来仍是全文。轮次目录的前 16 字是问题，不是 `>`。
- 源码预览选中多行，标签是 `文件名:起-止`，发送后标记外有行号和片段；不带行号的「添加到聊天」与现在一致。
- 选区超过 200 行，消息里没有围栏，只有「片段过长未内联」。
- 同一文件被改第二次（变更列表里仍然只有一条），预览会重载；已经放进输入框的标签出现「内容可能已变化」，已发送的文本里没有这句。上拉更早的历史不会把这个标签点亮。
- Diff 打开之后文件又被改过，再从这份 Diff 引用，标签立刻是「内容可能已变化」。Git Diff 的右键没有「引用到对话」。
- 切到另一会话再回来，引用条和行号标签还在；另一会话的输入框是空的。
- 运行中仍可引用，发出去的消息进队列，队列里是折叠后的一行。
- 安卓壳：回复操作栏有「引用」，选中文字不出现浮钮；文件预览右键没有「引用到对话」。

---

## 11. 文档

实施时同步：

- CHANGELOG：前端写「回复选区引用、文件与 Diff 行区间引用」；后端写「会话标题不再被引用片段占满，用户自己的代码块仍参与标题」。
- `skills/mao-cli/reference/desktop.md`「快捷命令与文件引用」：回复里选中文字或点操作栏「引用」；文件预览源码和 Diff 修改后一侧选中行后「引用到对话」；标签形如 `report.py:120-145`；片段过长时只带行号；终端不能这样引用。

不改 README.md / DEPLOY.md（没有新的部署或配置）。
