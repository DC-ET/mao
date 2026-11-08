# 工作区文件拖进聊天技术方案：跨面板拖拽直连

- 状态：待实施（2026-11-07 定稿）
- 日期：2026-11-07
- 需求来源：`docs/proposals/2026-11-07-workspace-drag-into-chat.md`（已立项，含逐项代码证据；本文在其基础上完成定案与四处勘误，见 §3.2）
- 规模：小-中（新增 1 个工具模块 + 三处 dragstart 收口 + 两个落点接线，约 150 行改动 + 纯函数与源码级测试；**零数据库迁移、零后端改动、零新依赖**）
- 关联：`desktop/src/utils/file-manager.ts`、`desktop/src/components/file-browser/{FileManagerGrid,FileManagerList,FileTreeNode}.vue`、`desktop/src/components/chat/ChatInput.vue`、`desktop/src/components/center/CenterTabBar.vue`、`desktop/src/views/task/TaskView.vue`、`desktop/src/composables/useCenterTabs.ts`、`skills/mao-cli/reference/desktop.md`

## 1. 需求背景

文件管理器与聊天输入框隔着一个面板边界，引用一个正看着的文件要绕四五步；而拖拽的零件全部现成，只缺中间一段「识别对方载荷」的接线：

1. **引用工作区文件的现状路径**：切回输入框 → 敲 `@` → 在 `FileReferencePanel` 里再搜一遍文件名 → 选中（`ChatInput.vue:52-59`、`:480`）。文件管理器里明明看着它。
2. **文件面板能拖，但载荷出不了自家门**：三处 dragstart 都写同一路径载荷——`FileManagerGrid.vue:140-146`、`FileManagerList.vue:152-158` 用 `DRAG_PATHS_MIME`（`utils/file-manager.ts:7`，值 `application/x-mao-paths`），`FileTreeNode.vue:186-191` 硬编码同一字符串并额外带 `text/plain`；`effectAllowed` 全部锁 `'move'`。消费端只有文件面板自己的移动逻辑（`FileManagerPanel.vue:522-547`）。
3. **聊天输入框只认 OS 文件**：wrapper 根节点 `@drop.prevent="handleDropFiles"`（`ChatInput.vue:37-41`），处理器（`:1132-1146`）只走 `dataTransfer.files` 上传链路——面板文件拖进来被吞，什么都不发生；树节点的 `text/plain` 载荷还可能被 ProseMirror 兜底插成一段裸路径文本（wrapper 是编辑器祖先，bubble 阶段的 `preventDefault` 拦不住编辑器内已处理的 drop）。
4. **两个落点 API 现成**：输入框侧 `insertFileReference(filePath)`（`ChatInput.vue:1294`，内部 `insertFileNode`（:1332）带 `props.disabled` 早退与 `ed.commands.focus()`，插入 `fileReference` 节点 + 尾随空格并移光标）；中心区侧 `openFileTab(filePath, title, workspaceRoot?)`（`useCenterTabs.ts:264-283`，同路径去重 + version 递增强制重挂载 + 激活）。Tab 栏宿主是 `TaskView.vue:24`（`openFileTab` 已在 `:380` 解构），文件树宿主是 `TaskInspector.vue`。

## 2. 需求描述

### 2.1 目标（全部要做）

| # | 优先级 | 目标 | 一句话验收 |
|---|---|---|---|
| 1 | P1 | 新建 `utils/workspaceDrag.ts`：载荷写入 / 解析 / 文件过滤三个纯函数，双 MIME 单一写入点 | 面板内部移动与跨面板落点读同一份载荷 |
| 2 | P1 | 三处 dragstart 收口（Grid / List / TreeNode）：写入 entries + paths 双载荷、`effectAllowed` 放宽 `'copyMove'`、TreeNode 硬编码改 import 常量 | 拖拽光标在聊天区显示 copy、在面板内仍显示 move |
| 3 | P1 | ChatInput capture 阶段拦截：文件 → 逐条插 `@` 引用节点，目录忽略，纯目录载荷吞掉不动作；插完显式 `saveDraft` | 从文件面板拖文件进输入框即成可点引用节点 |
| 4 | P1 | CenterTabBar 拖拽高亮 + `workspace-file-drop` 事件；TaskView 接 `openFileTab(path, 文件名)` | 拖文件到 Tab 栏即开预览 Tab，重复拖不产生重复 Tab |
| 5 | P1 | 测试（纯函数 + 源码级断言）+ CHANGELOG + `desktop.md` 文件管理段补跨面板拖拽说明 | 回归有锁、用户可见改动有记录 |

### 2.2 非目标（明确不做）

- **不做触屏拖拽**：HTML5 DnD 在触屏不触发，安卓壳上该手势天然不存在；`@` 引用面板已是触屏可用路径，不做长按替代交互。
- **目录在两个落点一律忽略**（输入框不插引用、Tab 栏不开页签；理由见 D4）。
- 不做反向拖拽（聊天附件 / 图片拖到文件面板）、不做拖到消息气泡、不做跨窗口 / 跨应用拖拽（OS 文件拖入上传已覆盖）。
- **不补 `text/plain` 载荷**（Grid / List 不加；TreeNode 既有 `text/plain` 不动；理由见 D3）。
- 不设引用插入数量上限：引用是轻量节点不是附件，不占 `MAX_PENDING_ATTACHMENTS` 口径，发送链路的文件解析与失败提示兜底。
- `FileManagerPanel.vue` **零改动**：内部移动 / 归组逻辑与其显式 `dropEffect='move'`（:493、:536）一概不动。
- 零后端、零迁移；`TaskIndexPanel` / `TaskSessionGroupList` 的会话行拖拽（另一套拖拽体系）不动。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 载荷格式 | **双 MIME、单一写入点**：新增 `application/x-mao-entries`（JSON `[{path, isDirectory}]`）给跨面板落点用；同时保留写 `DRAG_PATHS_MIME`（字符串数组，`FileManagerPanel` 内部移动既有消费不变）。三处 dragstart 统一调 `setWorkspaceDragPayload(e, entries)` | 落点需要区分文件 / 目录，字符串数组表达不了；保留旧 MIME 让面板内部零改动，新旧消费者各读所需 |
| D2 | `effectAllowed` | 三处 dragstart 由 `'move'` 放宽为 **`'copyMove'`**；面板内部目标已显式设 `dropEffect='move'`（`FileManagerPanel.vue:493`、`:536`、folder-dragover），落库语义与光标均不变 | `effectAllowed='move'` 限定下浏览器对 copy 目标显示禁止光标——不放宽则聊天区永远显示「不可拖入」 |
| D3 | ChatInput 拦截时机 | **capture 阶段**：wrapper（:37-41）加 `@dragover.capture` 与 `@drop.capture`。capture 自外向内先于 ProseMirror 在编辑器内注册的 handler：mao 载荷 → `preventDefault` + `stopPropagation` + 插引用；非 mao 载荷 → 放行（OS 文件继续走 bubble 的 `handleDropFiles`，`text/plain` 维持浏览器默认） | bubble 阶段的 `@drop.prevent`（现状）拦不住编辑器内已发生的 ProseMirror 兜底插文本；capture 是唯一能先于编辑器处理的时机，且顺带修复树节点拖入插裸路径的既有瑕疵 |
| D4 | 目录语义 | **目录在两个落点一律忽略**：输入框过滤掉 `isDirectory` 条目（纯目录载荷整包吞掉、无动作无提示）；Tab 栏只认文件 | 目录没有引用 / 预览语义，文件管理器内部已有完整目录交互（双击进入、拖拽移动）；不引入「目录拖成什么」的新概念。`isDirectory` 来自拖拽起点可见列表的 path→isDirectory 映射，未命中按文件处理（保守方向：多误插一个引用可删，误吞一个文件则功能失效） |
| D5 | Tab 栏接线 | **CenterTabBar 处理拖拽事件并 `emit('workspace-file-drop', paths)`，宿主 TaskView（:24）调 `openFileTab(path, path 最后一段)`**（:380 已解构）；Tab 栏自身不 import `useCenterTabs` | CenterTabBar 现状是纯展示组件（props + emit，`:1-60`），保持其契约；去重 / 激活 / version 递增由 `openFileTab`（`useCenterTabs.ts:264-283`）内建，落点侧零新状态 |
| D6 | 草稿持久化 | drop 插入完成后**显式调一次 `saveDraft(props.draftKey)`**（对齐 `addReplyQuote` :1309 的落草稿方式） | TipTap `onUpdate`（:778-784）只更新文本与触发检测、不落草稿；`insertFileReference` 自身也不落——不补这行草稿会丢 |

### 3.2 对提案的四处勘误（随本方案落定）

1. **MIME 并非两套**：提案称 Grid/List 用 `DRAG_PATHS_MIME`、TreeNode 用 `application/x-mao-paths` 是两套载荷——实际是**同一个值**（`file-manager.ts:7` 定义，TreeNode 硬编码同一字符串）。收口动作 = TreeNode 改 import 常量 + 三处共用写入函数，不是「合并两套 MIME」。
2. **「起点补 `text/plain`」不做**：两个落点都读 MIME 载荷，`text/plain` 无消费需求；补了反而扩大 ProseMirror 兜底插裸文本的面（D3 拦截之后，TreeNode 既有 `text/plain` 已成无害冗余，保留不动）。
3. **「实施首日实测 ProseMirror 行为再定」取消**：capture 拦截在机制上先于编辑器内 handler（D3），不依赖对现状行为的实测赌注，直接定案。
4. **引用数量上限**：提案「P1 先不限、实测再定」→ 定案**不设上限**（§2.2），不做「实测再定」的悬挂项。

## 4. 实现步骤

### 步骤 1：`desktop/src/utils/workspaceDrag.ts`（新建）

```ts
import { DRAG_PATHS_MIME } from './file-manager'

export const WORKSPACE_ENTRIES_MIME = 'application/x-mao-entries'
export interface WorkspaceDragEntry { path: string; isDirectory: boolean }

/** 三处 dragstart 的唯一写入点：entries（跨面板落点）+ paths（面板内部移动既有消费）双载荷。 */
export function setWorkspaceDragPayload(e: DragEvent, entries: WorkspaceDragEntry[]): void {
  if (!e.dataTransfer) return
  e.dataTransfer.setData(WORKSPACE_ENTRIES_MIME, JSON.stringify(entries))
  e.dataTransfer.setData(DRAG_PATHS_MIME, JSON.stringify(entries.map((it) => it.path)))
  e.dataTransfer.effectAllowed = 'copyMove'
}

/** 跨面板落点统一入口：entries 优先，回退旧 paths 载荷（按文件处理）；坏 JSON / 空返回 []。 */
export function parseWorkspaceDrag(dt: DataTransfer | null): WorkspaceDragEntry[]

/** 过滤掉目录；输入框与 Tab 栏落点都用它。 */
export function fileEntriesOf(entries: WorkspaceDragEntry[]): WorkspaceDragEntry[]
```

`parseWorkspaceDrag` 实现：先 `getData(WORKSPACE_ENTRIES_MIME)`，非空则 `JSON.parse` + 校验数组元素形状（`path` 非空字符串、`isDirectory` 布尔）；为空回退 `parseDragPaths(getData(DRAG_PATHS_MIME))`（复用 `file-manager.ts:112` 既有解析）映射为 `{ path, isDirectory: false }`。

### 步骤 2：`FileManagerGrid.vue` dragstart 收口

`onDragstart`（:140-146）：`effectiveDragSources(entry.path, props.selectedPaths)` 得到 sources 后，用组件已有条目列表（`props` 数据源）建 `Map<path, isDirectory>`，映射为 entries，调 `setWorkspaceDragPayload(e, entries)`；删除原两行 `setData` + `effectAllowed = 'move'`。`canDragEntry`（:135-138，目录可拖、符号链接目录不可拖）不动。

### 步骤 3：`FileManagerList.vue` dragstart 收口

`onDragstart`（:152-158）同步骤 2。

### 步骤 4：`FileTreeNode.vue` dragstart 收口

:186-191：硬编码 `'application/x-mao-paths'` 改为经 `setWorkspaceDragPayload` 写入（entries = `[{ path: <paths 内各路径>, isDirectory: props.node.isDirectory }]`）；既有 `text/plain` 行保留原位不动；`effectAllowed` 由 helper 统一为 `'copyMove'`。

### 步骤 5：`ChatInput.vue` capture 拦截

1. wrapper（:37-41）追加：`@dragover.capture="handleRefDragOver"`、`@drop.capture="handleRefDrop"`（既有 bubble 的 `@dragover.prevent` / `@drop.prevent` 等四行不动）。
2. 新增两个函数（放在既有 Drag & drop 区块 :1112 附近）：

```ts
function handleRefDragOver(e: DragEvent) {
  if (props.disabled) return
  const entries = parseWorkspaceDrag(e.dataTransfer)
  if (entries.length === 0 || fileEntriesOf(entries).length === 0) return
  e.dataTransfer && (e.dataTransfer.dropEffect = 'copy')
  draggingFile.value = true   // 复用既有 is-dragging-file 高亮，不新增视觉态
}

function handleRefDrop(e: DragEvent) {
  if (props.disabled) return
  const entries = parseWorkspaceDrag(e.dataTransfer)
  if (entries.length === 0) return            // 非 mao 载荷：放行走 OS 文件上传 / 浏览器默认
  e.preventDefault()
  e.stopPropagation()
  draggingFile.value = false
  const files = fileEntriesOf(entries)        // 目录一律忽略（D4）
  for (const it of files) insertFileReference(it.path)
  if (files.length > 0) saveDraft(props.draftKey)
}
```

3. `handleDropFiles`（:1132-1146）与上传链路零改动；`insertFileReference`（:1294）自身零改动（其 `props.disabled` 早退与 `ed.commands.focus()` 已内建）。

### 步骤 6：`CenterTabBar.vue` 拖拽落点

1. 根节点（:2 `<div ref="barEl" class="center-tab-bar">`）追加：`:class="{ 'is-drag-over': barDragOver }"`、`@dragover.prevent="onBarDragOver"`、`@dragleave="onBarDragLeave"`、`@drop.prevent="onBarDrop"`。
2. script：

```ts
const emit = defineEmits<{ /* 既有 activate/close 等 */ 'workspace-file-drop': [paths: string[]] }>()
const barDragOver = ref(false)
function droppablePaths(e: DragEvent): string[] {
  const files = fileEntriesOf(parseWorkspaceDrag(e.dataTransfer))
  return files.map((it) => it.path)
}
function onBarDragOver(e: DragEvent) {
  const paths = droppablePaths(e)
  barDragOver.value = paths.length > 0
  if (paths.length > 0) e.dataTransfer && (e.dataTransfer.dropEffect = 'copy')
}
function onBarDragLeave(e: DragEvent) { if (e.target === e.currentTarget) barDragOver.value = false }
function onBarDrop(e: DragEvent) {
  barDragOver.value = false
  const paths = droppablePaths(e)
  if (paths.length > 0) emit('workspace-file-drop', paths)   // 目录已被过滤（D4）
}
```

3. scoped 样式：`.center-tab-bar.is-drag-over { outline: 2px dashed var(--aw-primary, #409eff); outline-offset: -2px; }`。

### 步骤 7：`TaskView.vue` 接线

:24 `<CenterTabBar …>` 追加 `@workspace-file-drop="handleWorkspaceFileDrop"`；script 新增：

```ts
function handleWorkspaceFileDrop(paths: string[]) {
  for (const p of paths) openFileTab(p, p.split('/').pop() || p)
}
```

`openFileTab` 已在 :380 解构；去重 / 激活 / version 递增由其内建，落点侧零新状态。

### 步骤 8：测试 + 文档同步 + 验证 + 提交

1. 新建 `desktop/src/utils/workspaceDrag.test.ts`：
   - 纯函数：`setWorkspaceDragPayload` 写入双 MIME 且 `effectAllowed='copyMove'`（DataTransfer 用 stub 对象）；`parseWorkspaceDrag` 的 entries 优先 / 旧 paths 回退 / 坏 JSON / 空入参 / 形状校验五分支；`fileEntriesOf` 目录过滤。
   - 源码级（readFileSync，仿 `chat-a11y.test.ts`）：`ChatInput.vue` 含 `@drop.capture` 与 `@dragover.capture`、`handleRefDrop` 内 `preventDefault` + `stopPropagation` 先于插入、`saveDraft(props.draftKey)` 在循环后；`FileManagerGrid.vue` / `FileManagerList.vue` / `FileTreeNode.vue` 均调 `setWorkspaceDragPayload` 且不再出现 `effectAllowed = 'move'`；`FileTreeNode.vue` 不再硬编码 `'application/x-mao-paths'` 字符串；`CenterTabBar.vue` 含 `workspace-file-drop` emit 与 `is-drag-over`；`TaskView.vue` 含 `@workspace-file-drop=`；`FileManagerPanel.vue` 的 `dropEffect = 'move'` 两处原样存在（防误改内部移动）。
2. `CHANGELOG.md` 顶部新版本条目（前端一节）：工作区文件可拖进聊天成 `@` 引用、拖到中心 Tab 栏开预览。
3. `skills/mao-cli/reference/desktop.md:150` 文件管理页签段的拖拽描述后补一句：文件管理器 / 文件树的文件可拖进聊天输入框直接成为 `@` 引用（目录除外），拖到中心 Tab 栏直接打开预览页签。
4. 验证：`cd desktop && npm run build && npx vitest run`；`cd backend-ts && npm run build && npm test`（零后端改动，确认零回归）。
5. 提交：`feat(desktop): 工作区文件跨面板拖拽——拖进聊天成 @ 引用、拖到 Tab 栏开预览（<版本>）`，推 origin/main。

## 5. 落地清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `desktop/src/utils/workspaceDrag.ts` | 新建：双 MIME 写入 / 解析 / 文件过滤 | 1 |
| `desktop/src/components/file-browser/FileManagerGrid.vue` | `onDragstart` 改调 helper（约 -3 +3 行） | 2 |
| `desktop/src/components/file-browser/FileManagerList.vue` | 同上 | 3 |
| `desktop/src/components/file-browser/FileTreeNode.vue` | 同上 + 硬编码 MIME 改 import | 4 |
| `desktop/src/components/chat/ChatInput.vue` | wrapper 两个 capture 事件 + `handleRefDragOver` / `handleRefDrop` | 5 |
| `desktop/src/components/center/CenterTabBar.vue` | 根节点拖拽三事件 + 高亮态 + emit + 样式 | 6 |
| `desktop/src/views/task/TaskView.vue` | `@workspace-file-drop` 接线 + `handleWorkspaceFileDrop` | 7 |
| `desktop/src/utils/workspaceDrag.test.ts` | 新建：纯函数 + 源码级回归断言 | 8 |
| `CHANGELOG.md` | 新版本条目（前端一节） | 8 |
| `skills/mao-cli/reference/desktop.md` | :150 处补跨面板拖拽说明 | 8 |

不动：`backend-ts` 全部、数据库迁移（零）、`FileManagerPanel.vue`（**零改动**，含 `dropEffect='move'` 与移动 / 归组逻辑）、`ChatInput` 的 OS 文件上传链路与 `handleDropFiles`、`insertFileReference` / `insertFileNode`、`useCenterTabs.ts`、`TaskIndexPanel` / `TaskSessionGroupList` 会话拖拽、`TaskInspector.vue`（文件树宿主，仅 dragstart 收口受益，无代码改动）、`MAX_PENDING_ATTACHMENTS` 口径、安卓专项代码。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `effectAllowed='move' → 'copyMove'` 影响面板内部移动手感 | 内部目标显式 `dropEffect='move'`（`FileManagerPanel.vue:493,536` 既有）覆盖光标显示，落库语义不变；源码级断言锁这两行不被改；手工清单回归「拖文件进目录树 / 跨目录移动」 |
| capture 拦截误吞 OS 文件拖放 | `handleRefDrop` 只在 `parseWorkspaceDrag` 命中时 `preventDefault` + `stopPropagation`，空载荷原样放行；用例覆盖 OS 文件 / 面板文件 / 混合三种拖入 |
| 起点列表查不到的路径导致 `isDirectory` 误判为文件 | 保守方向已论证（D4）：目录被当文件最多插一个可删的引用；文件被当目录则功能失效。起点映射用组件已有数据源，跨页选中场景由 `effectiveDragSources`（既有）限定在当前可见多选内 |
| 多文件拖入插入顺序 / 焦点跳动 | 逐条 `insertFileReference`，每条内部 `ed.commands.focus()` 幂等；插入位置为当前光标，顺序与载荷数组一致；纯函数与手工清单各验一次 |
| 拖拽中面板折叠 / 路由切换导致 drop 目标消失 | drop 是一次性事件，目标不存在浏览器自动取消；无持久状态、无落地动作 |
| Tab 栏 drop 与 Tab 点击 / 右键菜单冲突 | 拖拽事件与 click / contextmenu 是不同事件类型，互不触发；`barDragOver` 仅在拖拽期间为真，`dragleave` 以 `e.target === e.currentTarget` 防子元素闪烁（与 ChatInput `handleDragLeave` 同款判断） |
| 安卓壳触屏出现残留拖拽态 | HTML5 DnD 触屏不触发，`barDragOver` / `draggingFile` 不会被置位；`draggingFile` 在 drop 与 dragleave 均有复位，无残留路径 |

## 7. 测试要点

自动：`workspaceDrag.test.ts`（步骤 8 清单）+ desktop 全量 vitest + backend 全量（零回归确认）。

手工验收清单（桌面 Electron + Web，安卓壳过第 8 条）：

1. 从文件管理器网格 / 列表 / 文件树三个起点分别拖文件到输入框：插入 `@` 引用节点（非裸文本）、节点可点、尾随空格与光标位置正确。
2. 多选 3 个文件一次拖入：插入 3 条引用，顺序与选择一致；插完后切换会话再回来，草稿恢复包含这 3 条引用。
3. 拖目录到输入框：无插入、无报错；目录 + 文件混合拖入：只有文件成引用。
4. OS 本地文件拖入输入框：仍走上传分支生成待发附件（回归）；混合拖入（面板文件 + 本地文件）面板载荷优先。
5. 拖文件到中心 Tab 栏：Tab 栏虚线高亮、松手打开对应预览 Tab；重复拖同文件激活既有 Tab 不重复；Tab 栏其余区域（Tab 按钮 / 关闭钮）拖拽行为不变。
6. 面板内部移动回归：拖文件进目录树目录、跨目录移动、拖进文件夹高亮 move 光标，全部行为与改前一致。
7. 光标语义：文件拖到输入框 / Tab 栏显示 copy，拖到面板内部目标显示 move，拖到无关区域显示禁止。
8. 安卓壳触屏：文件列表点击、长按菜单正常（无拖拽残留态），控制台无 DnD 相关报错。

## 8. 决策记录（原提案 §8 三个待评审项 → 定案）

1. **两套 MIME 是否合并**：勘误后不存在「两套」——同一值两种写法；收口为 import 常量 + 单一写入函数，新增 entries MIME 承载 isDirectory。见 D1。
2. **拖入输入框默认语义**：直接插入引用，不做「引用 / 打开预览」二选一弹层（低摩擦优先；打开预览已有 Tab 栏手势与点击路径）。见 §2.1 目标 3。
3. **Tab 栏 drop 是否支持目录**：不支持，目录在两个落点一律忽略。见 D4。

## 9. 明确不做的（汇总）

1. 触屏 / 安卓壳拖拽手势及其任何降级 UI（`@` 面板是触屏路径）。
2. 目录的跨面板落点（输入框、Tab 栏均忽略）。
3. 反向拖拽（聊天 → 文件面板）、拖到消息气泡、跨窗口 / 跨应用拖拽。
4. Grid / List 补 `text/plain`（TreeNode 既有保留不动，不扩大）。
5. 引用插入数量上限（不占附件口径）。
6. `FileManagerPanel.vue` 任何改动（内部移动、归组、剪贴板、上传全部现状）。
7. `useCenterTabs.ts` / 后端 / 数据库改动；`TaskIndexPanel` 会话行拖拽体系变更。
8. 会话内查找、检索类能力（2026-11-02 已否决方向，本方案不搭车）。
