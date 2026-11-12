# 消息编辑态唤起指令/技能/文件面板 — 技术方案

> 源自 2026-11-12 对话评估：编辑态已能把 `#{name}#`/`${name}$`/`@{path}@` 渲染为标签 chip，但无法在用 `/` 唤起指令/技能面板、`@` 唤起文件列表。零后端改动、零迁移、零 WS 协议改动；改动面集中在「ChatInput 面板逻辑抽共享 composable」与「MessageEditEditor 挂载面板」两处，确认出口 payload 与现状逐字节一致。
> 基线设计：[2026-11-11-message-edit-quick-command-tags-technical-design.md](2026-11-11-message-edit-quick-command-tags-technical-design.md)（编辑态 chip 双向转换，本方案改写其 §3 决策 3 / §9 中「面板一期不做」的结论）、[2026-06-05-feature-edit-user-message.md](2026-06-05-feature-edit-user-message.md)（编辑重发主流程）。

## 1. 需求背景

1. **编辑态现状**：`MessageBubble.vue:71-118` 编辑分支挂 `MessageEditEditor.vue`（108 行最小 tiptap 编辑器），`#{name}#`/`${name}$`/`@{path}@` 渲染为原子 chip，确认出口 `getText({ blockSeparator: '\n' })` 还原标记（2026-11-11 方案，commit `cf4aea84`）。该方案 §3 决策 3 / §9 明确「面板与 input rule 一期不做」——编辑态只能沿用原消息里已有的 chip，**无法新增**指令/技能/文件引用。
2. **主输入框的完整面板能力**（ChatInput.vue，行号为 2026-11-12 复核）：
   - 模板挂载：`QuickCommandPanel` :45-53、`FileReferencePanel` :54-64；
   - 面板状态：:310-335（`panelSkills` 合并本地未上传技能 :316-320）；
   - 数据加载：`ensureCommandsLoaded` :429-440、`ensureLocalSkillsLoaded` :442-457；
   - 触发检测：`detectSlashTrigger` :871-909（`/` 与 `、`）、`detectAutoComplete` :920-989（裸词前缀）、`detectAtTrigger` :993-1032（`@`，含 300ms 防抖 :1027-1030）；
   - 选中插入：`handleCommandSelect` :461-487、`handleFileReferenceSelect` :498-519（均为直接构造 ProseMirror 事务，删触发符→插节点→插尾随空格→光标后移）；
   - 文件拉取：`fetchWorkspaceFiles` :538-581（乱序序号保护 :536，LOCAL 走 `electronAPI.listWorkspaceFiles`，CLOUD 走 `/files/workspace-list`）；
   - 键盘导航：`handleKeyDown` :725-805（面板开时 ↑↓/Enter/Esc 分层，Enter 的「确认选中 vs 发送」由 `userNavigatedPanel` 决定 :775-786）；
   - 驱动点：`onUpdate` :807-812 依次跑三个检测。
3. **缺口**：
   - 上述逻辑全部内联在 ChatInput 的 setup 闭包里（约 450 行），MessageEditEditor 无法调用；
   - 两个面板组件是 `position:absolute; bottom:100%`（`QuickCommandPanel.vue:146-159`、`FileReferencePanel.vue:150-162`），依赖宿主 `position:relative`；MessageEditEditor 的 `.message-edit-editor-wrap`（MessageEditEditor.vue:90-103）没有定位，且位于 `.messages` 滚动容器（`ChatPanel.vue:1039-1044` `overflow-y:auto`）内——**短会话（被编辑消息贴近容器上沿）时向上弹出的面板会被裁掉**，这是 ChatInput（面板宿主在滚动容器之外）不存在的定位问题。
4. **结论：可行。** 所需能力全部已在主输入框生产验证；本方案不新建任何解析/检测/序列化能力，只做「面板逻辑抽 composable 共享」+「编辑态挂载接线」+「面板定位翻转适配」。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 编辑态输入 `/` 弹出指令+技能面板：可过滤、↑↓ 导航、Enter 确认插入 chip、Esc 关闭 | 必做 |
| 2 | 编辑态输入 `@` 弹出文件面板：可过滤（防抖）、↑↓/Enter 选中插入文件 chip、Esc 关闭 | 必做 |
| 3 | 键盘语义分层：面板开时 Enter=确认选中、Esc=关面板、↑↓=导航；面板关时 Enter=换行、Ctrl/Cmd+Enter=确认、Esc=取消编辑 | 必做 |
| 4 | 主输入框行为逐字节不变（纯重构，零行为变化） | 必做 |
| 5 | 图片缩略可标记移除、IME 组合态守卫、确认按钮 disabled 口径保持现状 | 回归 |
| 6 | 裸词前缀自动补全、`、` 触发符、拖拽文件进编辑器生成引用 | 不做（§9） |

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 共享载体 | 新建 composable `desktop/src/composables/useEditorTagPanels.ts`，ChatInput 与 MessageEditEditor 共用 | 检测/插入/加载/键盘逻辑单一来源，避免双份漂移（editor-tags.ts 抽取先例）；两个面板组件本就只服务输入场景 |
| 两端差异参数化 | `slashTriggers`（ChatInput `['/','、']`；编辑态 `['/']`）、`autoComplete`（ChatInput `true`；编辑态 `false`）、`onEnter`/`onEscape` 回落、`anchorEl`（翻转测量锚点） | 差异全部收敛为入参，composable 内不出现「当前是不是编辑态」分支 |
| 编辑态 Enter 语义 | 面板开时 Enter **恒确认选中**（不传 `onEnter`） | 编辑态没有「发送」概念；显式 `/` 唤起即明确意图，与 ChatInput `detectSlashTrigger` 置 `userNavigatedPanel=true`（:907）同口径 |
| 面板定位 | 面板组件加 `placement: 'top'｜'bottom'`；宿主测量「编辑器上沿 → 最近滚动祖先上沿」距离 < 328px（320 max-height + 8px 边距）时翻转向下；composable 在面板打开后 `nextTick` 计算 | 短会话场景向上弹出必被 `.messages` 裁掉；`teleport + fixed` 需补滚动监听且丢失「面板跟随锚点」特性，否决 |
| ChatInput 定位 | 不传 `anchorEl` → `placement` 恒 `'top'` | 主输入框宿主在滚动容器外，无裁剪问题；主链路零行为变化 |
| 确认出口 | 不变：MessageEditEditor 继续 emit `getText({ blockSeparator: '\n' })`（:67-70） | chip 的 `renderText` 还原标记，载荷与 textarea 时代逐字节一致；后端/WS/乐观截断/失败回滚零改动 |
| 是否嵌整个 ChatInput | 不嵌 | 同 2026-11-11 §3 决策 2 |
| 是否接 input rule | 不接 | 主输入框也没有（2026-11-11 §3 决策 3）；手动敲入的标记保持纯文本，发送后仍按标记被后端解析，语义不受影响 |

## 4. 实现步骤

### 4.1 新增 `desktop/src/composables/useEditorTagPanels.ts`

从 ChatInput.vue **原样搬迁**（行为不变，行号为搬迁前位置）：

| 搬迁内容 | 源行号 |
|---|---|
| 面板状态 refs + `panelSkills` computed | :310-335 |
| `dismissedWord` / `currentFilterWord` / `userNavigatedPanel` | :914-918 |
| `ensureCommandsLoaded` / `ensureLocalSkillsLoaded` | :429-457 |
| `handleCommandSelect` / `closePanel` | :461-494 |
| `handleFileReferenceSelect` / `closeFilePanel` | :498-530 |
| `fetchFilesSeq` + `fetchWorkspaceFiles` | :536-581 |
| `detectSlashTrigger` / `detectAutoComplete` / `detectAtTrigger` | :871-1032 |

接口：

```ts
export interface EditorTagPanelContext {
  executionMode: 'CLOUD' | 'LOCAL'
  /** LOCAL Electron 列文件需要；CLOUD 后端按 sessionId 推导（file.routes.ts:174），无需前端传 */
  workspace?: string
  sessionId?: string | null
}

export function useEditorTagPanels(opts: {
  editorRef: Ref<Editor | undefined>
  getContext: () => EditorTagPanelContext
  /** 触发符集合，默认 ['/','、']；编辑态传 ['/'] */
  slashTriggers?: string[]
  /** 裸词前缀自动补全，默认 false；仅 ChatInput 传 true */
  autoComplete?: boolean
  /** 面板关闭时 Enter 的行为：ChatInput 传 handleSend；编辑态不传（换行） */
  onEnter?: () => void
  /** 面板关闭时 Esc 的行为：编辑态传取消编辑；ChatInput 不传 */
  onEscape?: () => void
  /** 翻转测量锚点：编辑态传 wrap 元素；不传则 placement 恒 'top' */
  anchorEl?: () => HTMLElement | null
})
```

返回值（供模板绑定与两个调用方的 `editorProps`）：`commandPanelVisible / commandPanelFilter / commandPanelPlacement / panelSkills / quickCommands`、`filePanelVisible / filePanelFilter / filePanelLoading / workspaceFiles / fileListError / filePanelPlacement`、`quickCommandPanelRef / fileReferencePanelRef`、`handleEditorKeyDown(view, event): boolean`（消费掉返回 true）、`handleEditorUpdate(): void`、`closeAll(): void`。

内部差异点（仅此三处，其余逐字节照搬）：

1. `detectSlashTrigger`：触发符从 `opts.slashTriggers` 取，对每个符 `lastIndexOf` 后取最大下标（替换 :878-880 硬编码的两个符）；
2. `detectAutoComplete`：函数首行 `if (!opts.autoComplete) return`；
3. `handleKeyDown`：两段面板处理照搬（含 IME 守卫与 `preventDefault`）；Enter 分支 `!userNavigatedPanel` 时 `closePanel(); opts.onEnter?.()`（`autoComplete=false` 时该分支不可达——显式触发必置 `userNavigatedPanel=true`）；两段都不消费时末尾 `opts.onEscape?.()` 仅由编辑态传入。

**附带修复（记录）**：`dismissedWord / currentFilterWord / userNavigatedPanel` 在 ChatInput 是模块级 `let`（:914-918），而主会话与各边路任务的 ChatInput 同时挂载（SideChatPanel.vue:332-334 注释实证）——三个变量跨实例共享，存在「一个输入框里 Esc 关闭的词抑制另一个输入框自动补全」的串扰。抽成 composable 局部变量后自然变为实例级，修复该潜在问题。

### 4.2 两个面板组件小改

`QuickCommandPanel.vue` / `FileReferencePanel.vue`：

1. 新增 prop `placement?: 'top' | 'bottom'`（默认 `'top'`）；根节点 class 增补 `is-placement-bottom`，CSS：`.is-placement-bottom { bottom: auto; top: 100%; margin-bottom: 0; margin-top: 4px; }`；
2. `FileReferencePanel.measureAvailableHeight`（:79-87）仅在 `placement === 'top'` 时测量——向下弹出时面板高度与上方可用空间无关，按 :89-98 的 watch 首端加条件；
3. `scrollToSelected`（QuickCommandPanel.vue:132-140、FileReferencePanel.vue:135-143）的 `document.querySelector('.quick-command-panel')` / `'.file-reference-panel'` 改为各自 `rootRef` 查询——编辑面板与主输入框面板同时挂载时会串台滚错元素（既有 bug，本方案修复）。

### 4.3 新增 `desktop/src/utils/panel-placement.ts`

- `findScrollParent(el)`：向上遍历，取最近一个 `overflow-y` 为 `auto`/`scroll` 的祖先（`.messages` 即此类）；
- `pickPanelPlacement(anchor: HTMLElement, budget = 328): 'top' | 'bottom'`：`anchorRect.top - (scrollRect?.top ?? 8) < budget ? 'bottom' : 'top'`（无滚动祖先时按视口上沿 8px 兜底）。
- 单测见 §7。

### 4.4 修改 `ChatInput.vue`

- 删除 §4.1 表中的全部内联实现，改 `const panels = useEditorTagPanels({ editorRef: editor, getContext: () => ({ executionMode: props.executionMode, workspace: props.workspace, sessionId: sessionStore.activeSessionId }) })`（不传 `slashTriggers`/`anchorEl`，`autoComplete` 传 `true`，`onEnter` 传 `handleSend`）；
- 模板 :45-64：两个面板的 props 改绑 `panels.*`，并绑 `:placement="panels.commandPanelPlacement"` / `filePanelPlacement`；
- `editorProps.handleKeyDown` :725：删除两段面板处理，函数首行改 `if (panels.handleEditorKeyDown(view, event)) return true`，其后保留 Enter-to-send 段（:796-804，含 `isTouchDevice` 与 IME 口径不变）；
- `onUpdate` :807-812：三检测合一为 `panels.handleEditorUpdate()`（内部仍按 slash → at → autoComplete 顺序）；
- `watch(() => props.disabled)` :1340-1346：`closePanel/closeFilePanel` → `panels.closeAll()`；
- `onBeforeUnmount` :1504-1506 的防抖清理移入 composable 的 `closeAll`（组件卸载时同样调用，逻辑归一）；
- 其余（handleSend / 草稿 / 粘贴 / 附件 / 引用）零改动；`defineExpose` 不变。

### 4.5 修改 `MessageEditEditor.vue`

- props 增 `sessionId?: string`（MessageBubble 传入，见 §4.6）；
- 挂载：

```ts
const panels = useEditorTagPanels({
  editorRef: editor,
  getContext: () => {
    const s = props.sessionId ? sessionStore.getSessionEntity(props.sessionId) : null
    return { executionMode: s?.executionMode ?? 'CLOUD', workspace: s?.workspace, sessionId: props.sessionId }
  },
  slashTriggers: ['/'],
  autoComplete: false,
  onEscape: () => emit('cancel'),
  anchorEl: () => wrapRef.value,
})
```

- 模板：`div.message-edit-editor-wrap` 内、`EditorContent` 之前挂 `QuickCommandPanel` 与 `FileReferencePanel`（props 绑 `panels.*`，事件绑 composable 暴露的选择处理）；`@mousedown.prevent` 两组件自带，点击选中不抢编辑器焦点；
- `.message-edit-editor-wrap` 增补 `position: relative`（既有视觉属性不动）；
- `editorProps.handleKeyDown`（:54-65）：首行插 `if (panels.handleEditorKeyDown(view, event)) return true`，其余 IME 守卫 / Esc / Ctrl|Meta+Enter 照旧；
- `onUpdate`（:67-70）：mirror emit 之后调 `panels.handleEditorUpdate()`；
- `onBeforeUnmount`（:81）：`editor.destroy()` 前 `panels.closeAll()`。

### 4.6 修改 `MessageBubble.vue`

- :73-78 `MessageEditEditor` 增 `:session-id="sessionId"`（prop 声明在 :359，默认值 :375）；其余不动。

### 4.7 已知行为（记录，不额外处理）

1. 面板打开期间滚动消息容器：面板 absolute 锚定编辑器随内容移动，符合 popover 预期；
2. 向下翻转时会遮住编辑器下方的缩略图/按钮区（瞬态，选中或 Esc 即恢复）；
3. 安卓 WebView 软键盘输入 `/`、`@` 需切符号页，可达性一般，面板点选可用；2026-11-11 记录的「安卓 Ctrl/Cmd+Enter 不触发确认」限制不变。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 新增 | desktop/src/composables/useEditorTagPanels.ts | §4.1 搬迁 + 参数化 |
| 新增 | desktop/src/composables/useEditorTagPanels.test.ts | §7 单测 |
| 新增 | desktop/src/utils/panel-placement.ts | findScrollParent / pickPanelPlacement |
| 新增 | desktop/src/utils/panel-placement.test.ts | 定位选择单测 |
| 修改 | desktop/src/components/chat/ChatInput.vue | 内联实现 → composable（§4.4） |
| 修改 | desktop/src/components/chat/MessageEditEditor.vue | 挂面板 + 键盘分层 + wrap 定位（§4.5） |
| 修改 | desktop/src/components/chat/MessageBubble.vue | 传 sessionId（§4.6） |
| 修改 | desktop/src/components/chat/QuickCommandPanel.vue | placement + scrollToSelected ref |
| 修改 | desktop/src/components/chat/FileReferencePanel.vue | placement + scrollToSelected ref + 测量条件 |
| 修改 | desktop/src/components/chat/message-edit-tags.test.ts | 补编辑态面板模板断言 |
| 文档 | docs/plan/2026-11-11-message-edit-quick-command-tags-technical-design.md | §3 决策 3 / §9「一期不做面板」改写为二期落地，链回本方案 |
| CHANGELOG | changelog/unreleased/2026-11-12-message-edit-panels.md | 「前端（桌面 / Web / 安卓）」小节，格式见该目录 README |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| ChatInput 重构回归（全应用最高频编辑器，且面板逻辑**当前无任何自动化覆盖**） | composable 单测先行，把现有行为逐条锁定（触发规则与边界 / Enter 两义 / dismissedWord 记忆 / 防抖与乱序 / 插入事务），再动 ChatInput；**分两步落地**：先切换 ChatInput 并独立验证（构建 + 单测 + 手测主链路），再接 MessageEditEditor |
| 短会话面板被 `.messages` 裁掉 | placement 翻转 + 对最近滚动祖先测量（§4.3）；手测覆盖「新会话第一条消息即编辑」场景 |
| 两面板同开时滚错元素 | scrollToSelected 改各自 rootRef（§4.2-3） |
| 编辑态 Enter/Esc 双语义冲突 | 分层：面板段优先消费，面板全关才回落换行 / Ctrl+Enter 确认 / Esc 取消（§4.5） |
| 中文正文 `、`、裸词误弹面板 | 编辑态 `slashTriggers=['/']` + `autoComplete=false`（§4.1） |
| 会话实体缺失（边路 / 子代理会话未加载进 store） | 文件拉取走既有降级（`fileListError` 可见 + 重试，ChatInput.vue:572-576）；指令面板数据来自全局 `/quick-commands`，不受影响 |
| 两端面板行为漂移 | 同一 composable 同一 `handleEditorKeyDown`，天然一致；无第二份实现 |
| 翻转后下方空间不足（容器比面板矮的极端场景） | 已知限制：面板 max-height 320px，`.messages` 通常远高于此；真出现时用户可 Esc 后改用主输入框，记入 §4.7 |

## 7. 测试要点

### 7.1 `useEditorTagPanels.test.ts`（jsdom + 真实 tiptap Editor，参照 `paste-insert.test.ts` 的 `makeEditor`）

- **`/` 触发**：`/` 开面板且 filter 为空；`/ta` filter 累积、`slashRange` 覆盖触发符到光标；行首 / 空白后触发；`a/b`（前字符非空白）不触发；触发符后出现空格关面板；`、` 仅在 `slashTriggers` 含它时触发（编辑态配置下不触发）。
- **`@` 触发**：filter 词正确；连续输入 300ms 防抖只发一次；乱序保护（先发的慢响应不覆盖后发的快结果，mock `api`/`electronAPI` 延时返回）；LOCAL Electron 走 `listWorkspaceFiles(workspace,…)`、CLOUD 走 `/files/workspace-list`（带 sessionId）；拉取失败置 `fileListError`。
- **选中插入**：`handleCommandSelect` 后 doc 含 `quickCommand` 节点（commandType/commandName 正确）、`getText` 还原 `#{name}#`/`${name}$`、尾随空格与光标位置；`handleFileReferenceSelect` 后 `getText` 还原 `@{path}@`。
- **键盘分层**：面板开时 ↑↓ 导航、Enter 确认选中、Esc 关面板（均消费返回 true）；面板关时 Enter 回落 `onEnter`（不传则不消费）、Esc 回落 `onEscape`；IME 组合态（`isComposing`/keyCode 229）Enter 放行。
- **自动补全**（`autoComplete=true` 配置）：词前缀匹配开面板；Esc 后同词不弹、词变恢复（dismissedWord）；URL / 邮箱 / 含 `/ . @ : \` 的词不触发；词长 < 2 关闭。
- **closeAll**：防抖定时器清理、面板状态与 range 复位。

### 7.2 `panel-placement.test.ts`

- 锚点贴近滚动祖先上沿（< 328px）→ `'bottom'`；充足 → `'top'`；无滚动祖先 → 按视口兜底；嵌套多层时取最近滚动祖先。

### 7.3 `message-edit-tags.test.ts` 增补（SFC AST，沿用现有手法）

- 编辑态容器（`role === 'user' && isEditing`）内挂 `QuickCommandPanel` 与 `FileReferencePanel`，且 `placement` 有绑定；
- `MessageEditEditor.vue` 源码级：`handleKeyDown` 中 `panels.handleEditorKeyDown` 先于 IME/Esc/Ctrl+Enter 段；`.message-edit-editor-wrap` 样式含 `position: relative`；
- MessageBubble 向 MessageEditEditor 传 `session-id`。

### 7.4 回归与构建

- 既有用例全绿：`editor-tags.test.ts`、`message-edit-tags.test.ts` 原用例、`chat-a11y.test.ts`（断言 `handleSend`/`focusInput`，与面板无关）、`paste-insert.test.ts`；
- `cd desktop && npm run build`（`vue-tsc -b`，根 tsconfig 为 references 结构，勿用 `--noEmit` 单文件模式替代）；
- 手测三形态（桌面 Electron / Web / 安卓壳）：主输入框 `/`、`@`、自动补全、Enter 发送语义无变化；编辑态 `/`、`@` 全流程；短会话编辑（面板翻转）；图片移除 / Esc / Ctrl+Enter 回归。

## 8. 决策记录

1. **抽 composable 共享，不复制**：面板规则单一来源，避免双份漂移（editor-tags.ts 先例）；两端差异全部参数化，composable 内无调用方判断分支。
2. **编辑态只接 `/` 与 `@`**：`、` 是中文高频标点、裸词自动补全在「改已有文本」场景是惊吓而非帮助；用户诉求也是 `/` 与 `@`。
3. **翻转而非 teleport**：absolute 锚定让面板天然跟随滚动容器，无需补监听；teleport + fixed 丢失该特性且两组件定位逻辑重写。
4. **ChatInput 不传 anchorEl**：主输入框定位行为零变化，把回归面压到最小。
5. **附带修复实例级状态**：模块级 `dismissedWord/userNavigatedPanel` 在多输入框并存时串扰（SideChatPanel.vue:332-334 实证），随抽取消除。
6. **payload 不变是硬约束**：确认出口仍 `getText`，chip `renderText` 还原标记——后端、WS、乐观截断、失败回滚全部零改动，这是本方案能把回归面压到最小的根本原因。

## 9. 明确不做的（汇总）

- 编辑态裸词自动补全、`、` 触发符、input rule（手动敲标记不变 chip，与主输入框一致）；
- 拖拽文件进编辑态生成引用（ChatInput `handleRefDrop` 不接）；
- 标签重命名或排序、指令/技能内容 tooltip（同 2026-11-11 §9）；
- teleport 全身定位、滚动时重定位；
- 后端接口 / 字段 / WS 协议任何改动；数据库迁移；
- 队列撤回回填链路逻辑改动（仅共享 composable 搬迁来源变化，行为不变）。
