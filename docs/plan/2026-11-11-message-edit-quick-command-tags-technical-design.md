# 消息编辑态渲染指令/技能标签 — 技术方案

> 源自 2026-11-10 对话评估（已发送消息重新编辑时裸显 `#{talk}#` 标记问题）。零后端改动、零迁移、零 WS 协议改动；改动面收敛在 desktop 的「编辑器转换函数共享」与「气泡编辑态换载体」两处，确认出口 payload 与现状逐字节一致。
> 基线设计：[2026-06-05-feature-edit-user-message.md](2026-06-05-feature-edit-user-message.md)（编辑重发主流程）、[2026-11-10-rich-paste-annotate-technical-design.md](2026-11-10-rich-paste-annotate-technical-design.md)（粘贴链路同族标记处理）。

## 1. 需求背景

用户消息的快捷命令标记有三种（`desktop/src/utils/quick-command-parser.ts:6-8`）：

| 标记 | 语义 | 展示态渲染 |
|---|---|---|
| `#{name}#` | 指令（command） | `QuickCommandTag`（tag-command，紫） |
| `${name}$` | 技能（skill） | `QuickCommandTag`（tag-skill，蓝） |
| `@{path}@` | 文件引用 | `FileReferenceTag` |

三条链路现状：

1. **展示态已渲染标签**：`MessageBubble.vue:60-63` 用 `parseQuickCommandSegments` 切分，非 text 段渲染为 `QuickCommandTag`/`FileReferenceTag` 组件。
2. **编辑态裸显标记**：`MessageBubble.vue:72-79` 的编辑框是纯 `<textarea>`，`editContent` 由 `userVisibleText(message.content)` 直接填充（`:397`、`:407-414`），用户看到的是 `#{talk}#` 原文——与展示态、与主输入框三重不一致（截图即此状态）。
3. **主输入框已是富编辑器且双向转换闭环**（ChatInput.vue，行号为 2026-11-12 复核）：
   - 标记 → 标签节点：`markedTextToEditorHtml()`（`:1483-1508`，`escapeHtml` :1474）把含标记的纯文本切成 `span[data-quick-command]`/`span[data-file-reference]` HTML；`QuickCommandNode.parseHTML`（`tiptap/QuickCommandNode.ts:48`）与 `FileReferenceNode.parseHTML`（`tiptap/FileReferenceNode.ts:95`）解析为原子节点。
   - 标签 → 标记：两节点均实现 `renderText`（`QuickCommandNode.ts:66-70` 产出 `#{name}#`/`${name}$`；`FileReferenceNode.ts:113-124` 产出 `@{path}@` 或经 `serializeFileRange` 的引用型后缀）；发送走 `editor.getText({ blockSeparator: '\n' })`（`ChatInput.vue:1255` 等多处）。
   - **同一转换已在生产使用**：队列消息撤回回填 `restoreContent()`（`:1510-1517`，`setContent` :1519）就是「拿原始标记文本 → 编辑器里渲染成标签」——队列撤回编辑已经能显示标签，气泡内编辑是唯一裸显标记的编辑入口。
   - **round-trip 机制已核到 tiptap 内核**：`HardBreak.renderText` 返回 `"\n"`（node_modules 实证）；`getText` → `getTextSerializersFromSchema`（core :1928，收集带 `renderText` 的节点生成 `spec.toText`）→ `getTextBetween`（:1889，叶节点走 textSerializer 并停止下钻）——`<br>` 还原 `\n`、两个标签节点还原回标记，走的是同一条机制链。

**结论：可行，且所需基础设施全部存在、已被队列撤回链路验证。** 本方案不新建任何解析/序列化能力，只做「共享函数搬迁」+「气泡编辑态换用最小 tiptap 编辑器」。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 编辑已发送消息时，气泡内编辑框把 `#{talk}#`、`${skill}$`、`@{path}@` 渲染为标签 chip，样式与主输入框（`.editor-tag`）一致 | 必做 |
| 2 | 标签作为原子节点可整块删除（Backspace），其余文本照常增删改 | 必做 |
| 3 | 确认后发出/落库的内容与今天逐字节一致——基准是**今天的 payload = `userVisibleText(content)` 口径**（含 `[图片 N]` 注入行的消息回填时注入行已被剥离，见 §4.4-b），而非原始 content；`confirmEdit`/`editAndResend`/后端零改动 | 必做 |
| 4 | 图片附件编辑能力（缩略可见、可标记移除，`MessageBubble.vue:83-111`）与 Esc 取消、Ctrl/Cmd+Enter 确认、IME 组合态守卫保持现状 | 回归 |
| 5 | 编辑态内通过面板插入新标签 | 二期已落地（见 §3 决策 3 与 2026-11-12 方案）；手动敲入的标记自动变标签（input rule）仍不做 |

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 编辑态载体 | **最小 tiptap 编辑器**：StarterKit 精简（与 `ChatInput.vue:589-603` 同一份 configure）+ `QuickCommandNode` + `FileReferenceNode`，新组件 `MessageEditEditor.vue` | 标记↔节点双向转换已被队列撤回回填验证；textarea 无渲染 chip 的能力；「textarea + 上方预览条」只是半成品，编辑心智仍割裂 |
| 是否嵌整个 ChatInput | **不嵌** | ChatInput ~1500 行，耦合 session store、待发附件、面板、WS、拖拽；整嵌会把巨大的 props/事件面与回归面拖进气泡 |
| 共享转换函数 | `escapeHtml` + `markedTextToEditorHtml` 从 ChatInput 私有函数**原样搬到** `utils/editor-tags.ts`，撤回回填与气泡编辑共用 | 转换规则单一来源，避免双份漂移；与 `markedTextToEditorHtml` 注释声明的「与 handlePaste 的解析规则一致」口径合一 |
| 确认出口 | emit `getText({ blockSeparator: '\n' })` 得到的标记文本，**`confirmEdit(content, images)` 签名与 payload 不变** | `QuickCommandNode.renderText`/`FileReferenceNode.renderText` 保证还原标记；`ChatPanel.vue:678-684` → `useChat.ts:739 editAndResend`（乐观截断、失败回滚、WS `edit_and_resend`）全部零改动 |
| 面板与 input rule | **面板二期已落地**（[2026-11-12-message-edit-quick-command-panels-technical-design.md](./2026-11-12-message-edit-quick-command-panels-technical-design.md)：编辑态 `/` 与 `@` 面板，共享 composable）；input rule 维持不做 | 主输入框也没有 input rule——chips 来自面板选择/粘贴/setContent；手动敲入的 `#{xx}#` 保持纯文本，发送后仍按标记被后端解析，语义不受影响 |
| 样式复用 | 新组件容器挂 `.rich-editor` 类直接复用 `chat-input.css:163-183` 的 ProseMirror 基础样式与 `:193-217` 的 `.editor-tag` 系列；组件内 import 同一 css | `chat-input.css` 全部规则带 `.chat-input-card`/`.rich-editor` 前缀，新容器命中即生效，无全局污染；零新增 CSS 变量 |
| 持久化 | 编辑器内容仅驻内存；入库/发送仍是原始标记文本 | 与主输入框一致（发送前才 `getText`） |

## 4. 实现步骤

### 4.1 新增 `desktop/src/utils/editor-tags.ts`

- 从 `ChatInput.vue` 原样搬入 `escapeHtml`（:1474）与 `markedTextToEditorHtml`（:1483-1508，保留原注释口径：`@{…}@`/`${…}$`/`#{…}#` 三标记，`\n → <br>`，HTML 转义）。
- **正则以现状内联字面量原样迁移，不做常量化、不与 `quick-command-parser.ts` 的常量混用**（评审修正）：parser 的 `SKILL_PATTERN`/`COMMAND_PATTERN`/`FILE_PATTERN` 带 `/g` 标志（有 `lastIndex` 状态，重复 match/split 会漏判），而本函数用的是 split 非捕获组 + `^…$` 锚定的另一组正则——两者语义不同、不可互换，「保持同款」无法成立；常量化是零收益重构且有 lastIndex 风险。
- 纯函数无副作用，供 ChatInput 与 MessageEditEditor 共用。

### 4.2 修改 `ChatInput.vue`

- 删除本地两份私有实现，改为 `import { escapeHtml, markedTextToEditorHtml } from '../../utils/editor-tags'`；`restoreContent`（`:1459`）调用点不变。
- 纯函数搬迁，行为逐字节等价；由 §7 单测锁定。

### 4.3 新增 `desktop/src/components/chat/MessageEditEditor.vue`

- **模板**：外层 `div.message-edit-editor-wrap`（承接 textarea 原有的边框/背景/圆角，`MessageBubble.vue:1672-1688` 的 `.edit-textarea` 样式迁到 wrap 上），内嵌 `<EditorContent class="rich-editor" :editor="editor" />`（ProseMirror 透明无边框由 `.rich-editor` 规则提供）。
- **编辑器实例**（扩展清单与 ChatInput 完全一致，保证渲染与序列化行为同源）：

```ts
const editor = useEditor({
  editable: true,
  extensions: [
    StarterKit.configure({
      heading: false, codeBlock: false, blockquote: false, horizontalRule: false,
      bulletList: false, orderedList: false, listItem: false,
      code: false, bold: false, italic: false, strike: false,
    }),
    QuickCommandNode,
    FileReferenceNode,
  ],
  content: `<p>${markedTextToEditorHtml(props.modelValue)}</p>`,
  onUpdate: ({ editor }) => emit('update:modelValue', editor.getText({ blockSeparator: '\n' })),
})
```

- **接口**：
  - props：`{ modelValue: string }`（MessageBubble 的 `editContent`）。
  - emits：`update:modelValue(text)`、`confirm()`、`cancel()`。
  - `defineExpose({ focus, selectAll })`：`commands.focus('end')` / `commands.selectAll()`，对应 MessageBubble 进入编辑态后的 `focus()+select()`（`:413-414`）。
- **键盘**（评审补充挂载点）：经 `editorProps.handleKeyDown(view, event)` 实现（编辑器实例配置项，`event` 即 KeyboardEvent）——`event.isComposing \|\| event.keyCode === 229` 时 `return false`（放行 IME）；`Escape` → emit cancel + `return true`；`Ctrl|Meta+Enter` → emit confirm + `return true`。不挂 DOM 级 keydown 监听，避免与 ProseMirror 自身按键处理双轨。
- **v-model 时序**：初始内容由 `content` 一次性注入，**初始不回写** `modelValue`；仅 `onUpdate` 回写（作展示态 mirror）。确认出口一律以 `getText` 为准，避免序列化空白差异覆盖用户原文。

### 4.4 修改 `MessageBubble.vue`

- 编辑态模板（`:72-79`）：`<textarea v-model="editContent">` 换成 `<MessageEditEditor v-model="editContent" @confirm="handleConfirm" @cancel="$emit('cancelEdit')" ref="editEditorRef" />`；图片缩略区（`:83-111`）与操作按钮（`:113-120`）不动。
- **新挂载前提（评审补充）**：编辑区在 `v-else-if="role === 'user' && isEditing"` 分支内（:71）——每次进入编辑态 `MessageEditEditor` 全新挂载，`content` 一次性注入天然成立；若未来把该分支改成常驻/`v-show`，必须补「进入编辑态重注入 content」的 watch（现有 `editContent.value = userVisibleText(...)` 回填只覆盖 mirror，不重置编辑器 doc）。
- `watch(() => props.isEditing)`（`:407-414`）：`await nextTick()` 后改调 `editEditorRef.value?.focus()` + `selectAll()`（Expose 提供）。
- `handleConfirm`（`:429-435`）：无需改动——`editContent` 仍是唯一真源，`confirmEdit(editContent.value, remaining)` 的 payload 与 today 相同（编辑器 onUpdate 实时同步）。
- **回填口径（评审补充）**：`editContent` 回填值是 `userVisibleText(message.content)`（`utils/imageUrlAnnotation.ts:42-45`，带 `[图片 N]` 注入行的消息会剥离注入行）——round-trip 恒等的基准就是该回填值；确认出口 `getText` 与之恒等即「payload 与 today 逐字节一致」（§2 故事 3 的判定基准）。
- 样式：`.edit-textarea` 的视觉属性（边框/背景/圆角/过渡）迁至 `.message-edit-editor-wrap`；追加 ProseMirror 内最小高度对齐（wrap min-height 60px）。

### 4.5 引用型文件标记的已知行为（记录，不额外处理）

`serializeFileRange`（`utils/selection-quote.ts:74`）产出形如 `@{path}@ 第 3-5 行：\n```lang\nsnippet\n```\n` 的**多行后缀**。初始化时 split 只命中 `@{path}@` 部分成 chip，后缀留为纯文本；确认时 chip 经 `renderText` 还原为 `@{path}@`，与未动的后缀文本拼接——**只要 chip 不被删除，round-trip 逐字节恒等**。用户主动删掉 chip 会留下孤立后缀文本（与 textarea 时代「删掉半个标记」的后果同性质），一期不接展示态的 `absorbFileRangeSuffix`（`selection-quote.ts:89`）吸收逻辑，记入 §9。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 新增 | desktop/src/utils/editor-tags.ts | `escapeHtml` / `markedTextToEditorHtml` 搬迁（正则保持内联字面量原样，不常量化） |
| 新增 | desktop/src/utils/editor-tags.test.ts | 纯函数单测（见 §7） |
| 新增 | desktop/src/components/chat/MessageEditEditor.vue | 最小编辑态 tiptap 编辑器 |
| 新增 | desktop/src/components/chat/message-edit-tags.test.ts | 真实 tiptap round-trip + MessageBubble 模板断言 |
| 修改 | desktop/src/components/chat/ChatInput.vue | 私有函数改 import（调用点不动） |
| 修改 | desktop/src/components/chat/MessageBubble.vue | textarea → MessageEditEditor 接线 + 样式迁移 |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面/Web）小节，版本随发版批次（打包/发版/OTA 前写完，AGENTS.md 口径） |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| tiptap `getText` 序列化与发送路径口径不一致（块间分隔符、`<br>` 处理） | round-trip 测试用**真实 tiptap Editor** 断言（先例：`paste-insert.test.ts` 的 `makeEditor`）；`HardBreak.renderText` 返回 `"\n"`（已核对 node_modules），多行 `<br>` 可安全还原；发送路径同函数同参数（`ChatInput.vue:1195`） |
| `setContent` 解析 HTML 时对文本段二次误判 | 转换器只对 split 出的**整段**标记产出 `span[data-quick-command]`，其余段 `escapeHtml`；两节点 `parseHTML` 白名单精确（`span[data-quick-command]`/`span[data-file-reference]`），无歧义 |
| v-model 回写覆盖用户原文（空行/尾随空白差异） | 初始不回写；确认出口一律 `getText`（§4.3） |
| ChatInput 搬迁引入回归 | 纯函数搬迁 + `editor-tags.test.ts` 全用例锁定；队列撤回回填链路仅 import 来源变化，既有测试（粘贴/撤回相关）保持全绿 |
| 气泡内编辑器观感与 textarea 不一致 | `.rich-editor` 规则复用、视觉属性迁到 wrap；手测桌面 / Web / 安卓壳（Capacitor 远程加载同一 web UI）三形态 |
| 移动端 contenteditable 输入法兼容 | tiptap + Vue3 已被主输入框长期使用；IME 组合态守卫照搬现有实现 |
| 图片编辑功能回归 | 图片缩略区 DOM 与 `removedImages` 逻辑不动；`MessageBubble.imageUrl.test.ts` 模板断言保持绿 |
| 删 chip 致引用型后缀孤立（§4.5） | 已知行为，一期不处理；后续如接 `absorbFileRangeSuffix` 需同步改确认出口口径 |

## 7. 测试要点

- `editor-tags.test.ts`：三种标记单独/混合/相邻（`#{a}#${b}$@{c}@`）/多行/首尾；HTML 转义（`<>&"` 及标记名内的引号）；无标记文本恒等；空串；`\n → <br>` 映射。
- `message-edit-tags.test.ts`：
  - **真实 tiptap Editor round-trip**（参照 `paste-insert.test.ts`）：`new Editor({ extensions: [StarterKit.configure({...}), QuickCommandNode, FileReferenceNode], content: '<p>' + markedTextToEditorHtml(text) + '</p>' })` → `getText({ blockSeparator: '\n' })` 与**回填输入文本**恒等（含多行、含引用型后缀形态；基准 = `userVisibleText` 口径的回填值，见 §4.4）；`editor.state.doc` 中 quickCommand 节点数 = 标记数。
  - **MessageBubble 模板断言**（沿用 `MessageBubble.imageUrl.test.ts` 的 SFC AST 手法）：编辑态容器（`role === 'user' && isEditing`）引用 `MessageEditEditor` 而非裸 `textarea`；确认按钮 disabled 仍读 `editContent.trim()`。
- 构建：`cd desktop && npm run build`（`vue-tsc -b`，根 tsconfig 为 references 结构，勿用 `--noEmit` 单文件模式替代）。

## 8. 决策记录

1. 编辑态做**真编辑器**，不做「textarea + 预览条」半成品——转换基础设施现成，一步到位。
2. 不嵌整个 ChatInput，用「最小编辑器 + 共享转换函数」收敛边界。
3. 一期不含面板/input rule/指令内容 tooltip：与主输入框现有行为对齐，发送语义不受影响；展示态 `QuickCommandTag` 的 tooltip（`MessageBubble.vue:62` `getCommandContent`）是编辑态后续增强的参照。**面板已于二期落地**（2026-11-12 方案：共享 composable + 编辑态挂载）；input rule 与 tooltip 仍不做。
4. `confirmEdit(content, images)` 签名与 payload 逐字节不变：后端、WS、乐观截断、失败回滚全部零改动——这是本方案能把回归面压到最小的根本原因。
5. 引用型文件后缀的 chip+文本呈现（§4.5）为已知取舍：保 round-trip 恒等优先于后缀视觉吸收。

## 9. 明确不做的（汇总）

- 编辑态内新增标签的 input rule（手动敲标记不变 chip）；裸词自动补全（编辑态惊吓大于帮助，2026-11-12 方案 §9）；指令/技能内容 tooltip；标签重命名或排序。~~编辑态内新增标签的面板~~ → 二期已落地（2026-11-12 方案）。
- 引用型 `@{path}@ 第 x 行：…` 后缀的吸收渲染（`absorbFileRangeSuffix` 接入编辑态）。
- 气泡编辑态的草稿持久化（编辑器内容仅驻内存，不落库）。
- 后端接口/字段/WS 协议任何改动；数据库迁移。
- 队列撤回回填链路的逻辑改动（仅共享函数搬迁，行为不变）。

## 10. 评审修订记录（2026-11-12）

1. **§4.1 正则常量化指令修正（会导致实现错误）**：原稿要求「三个标记正则提为模块级导出常量、与 `quick-command-parser.ts:6-8` 逐字同款」——parser 常量带 `/g` 标志（`lastIndex` 状态，重复 match/split 漏判），与本函数的 split 非捕获组 + `^…$` 锚定正则并非同款、不可互换。改为现状内联字面量原样迁移、不常量化、不混用。§4.1。
2. **round-trip 基准写透**：回填值是 `userVisibleText(message.content)`（注入行剥离口径，`imageUrlAnnotation.ts:42-45`），逐字节一致的基准是今天的 payload（回填值口径）而非原始 content——§2 故事 3、§4.4、§7 同步明确。
3. **键盘挂载点补充**：`editorProps.handleKeyDown`（不挂 DOM 级监听避免双轨），IME 守卫 return false 放行。§4.3。
4. **新挂载前提显式化**：编辑区 `v-else-if` 结构保证每次进入编辑态全新挂载编辑器（content 一次性注入的前提）；改常驻/v-show 时须补重注入 watch。§4.4。
5. **round-trip 机制核到 tiptap 内核**：`HardBreak.renderText` 返回 `"\n"`（node_modules 实证）；`getText` → `getTextSerializersFromSchema`（core:1928，`renderText` → `spec.toText`）→ `getTextBetween`（:1889）——`<br>` 还原 `\n` 与标签还原走同一机制链。§1。
6. **行号引用更新**：`ChatInput.vue` 各函数实测行号（escapeHtml :1474、markedTextToEditorHtml :1483-1508、restoreContent :1510-1517/setContent :1519、发送 getText :1255 等）。§1/§4.1。
7. **落地轮 review 修正（2026-11-12）**：①`editor-tags.ts` 迁移时 commandMatch 正则多写了一个反斜杠（`\#`），已恢复与 ChatInput 原文逐字节一致；②已知限制两则记录：安卓 WebView 下 Ctrl/Cmd+Enter 不触发确认（prosemirror-view 对 keyCode 13 提前短路，触屏场景用确认按钮），编辑器内 Enter = 换行分段（与主输入框 Enter 发送有意不同，多段落经 blockSeparator 还原 `\n`）。
