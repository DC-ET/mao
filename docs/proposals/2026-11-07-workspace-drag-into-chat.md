# 提案：工作区文件拖进聊天 —— 跨面板拖拽直连

> 文件管理器（`FileManagerPanel`）与聊天输入框（`ChatInput`）隔着一个面板边界，但这条两三厘米的路今天要走四五步：想引用工作区里正看着的那个文件，得切回输入框、敲 `@`、在 `FileReferencePanel` 里再搜一遍文件名、选中。而拖拽的**零件其实都造好了**，只是没接线：
> 1. **文件面板能拖，但载荷出不了自家门**：`FileManagerGrid.vue:141-144` 与 `FileManagerList.vue:153-156` 的 dragstart 只设内部移动用的 `DRAG_PATHS_MIME`，且 `effectAllowed = 'move'`；`FileTreeNode.vue:188-190` 设 `application/x-mao-paths` + `text/plain`。这些载荷的消费者只有文件面板自己的 drop 逻辑（`FileManagerPanel.vue:522`）。
> 2. **聊天输入框只认 OS 文件**：`ChatInput.vue:37-41` 根节点 `@drop.prevent="handleDropFiles"`，处理器（`:1132`）走的是 `dataTransfer.files` 上传链路——从文件面板拖一个工作区文件过来，要么被 `preventDefault` 吃掉毫无反应，要么被 ProseMirror 兜底插成一段裸路径文本（树节点带 `text/plain`），总之都不是「引用文件」的正确语义。实施时以实测为准，两种情况统一在 drop 入口收口。
> 3. **落点 API 全是现成的**：输入框侧 `insertFileReference(filePath)` 已实现且已暴露（`ChatInput.vue:1294`、`:1378` 注册、`:1444` defineExpose），`FileReferenceNode`/Tag 渲染链路完整；中心区侧 `openFileTab(filePath, title)` 也是既有 API（`useCenterTabs.ts:264`）。本提案几乎全是「把已有事件流接到已有函数上」。

- 状态：已落地（2026-11-07，0.0.476；技术方案：[docs/plan/2026-11-07-workspace-drag-into-chat-technical-design.md](../plan/2026-11-07-workspace-drag-into-chat-technical-design.md)）
- 日期：2026-11-07
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小-中（约 1.5-2 人日；**零数据库迁移、零后端改动**；OS 文件拖拽上传等既有路径不动）
- 关联：`desktop/src/components/file-browser/{FileManagerGrid,FileManagerList,FileTreeNode,FileManagerPanel}.vue`、`desktop/src/components/chat/ChatInput.vue`、`desktop/src/components/center/{CenterTabBar,CenterTabContainer}.vue`、`desktop/src/composables/useCenterTabs.ts`

## 1. 背景与现状

### 1.1 现状逐项核对（代码可查）

| 场景 | 现状 | 代码证据 |
|---|---|---|
| OS 文件拖入聊天上传 | 已有，拖拽态样式、pending 列表、上限提示齐全 | `ChatInput.vue:37-41`、`:288`、`:1112-1140` |
| 文件面板内部拖拽（移动/归组） | 已有，私有 MIME + `effectAllowed='move'` | `FileManagerGrid.vue:141-144`、`FileManagerList.vue:153-156`、`FileManagerPanel.vue:522`；树内 `FileTreeNode.vue:188-190` |
| 面板文件 → 聊天引用 | **无**：drop 入口只认 `files`，面板载荷无消费者 | `ChatInput.vue:1132`（`handleDropFiles`）vs `FileManagerGrid.vue:143` |
| 面板文件 → 中心 Tab 打开 | **无**：`openFileTab` 存在但没有拖拽入口 | `useCenterTabs.ts:264` |
| `@` 引用面板 | 已有，浏览选择插入引用节点 | `ChatInput.vue:52-59`、`:480`（`handleFileReferenceSelect`） |
| 输入框拖拽视觉反馈 | 已有 `is-dragging-file` 态 | `ChatInput.vue:37`、`:288` |

### 1.2 为什么这件事性价比高

- **两头的 API 都在**：拖拽起点（dragstart 已设路径载荷）与终点（`insertFileReference`、`openFileTab`）全部现成，缺的只是中间的「识别对方载荷」一段分支逻辑。
- **不引入新语义**：拖成引用 = `@` 面板选文件的同一函数；拖成 Tab = 点击文件的同一打开函数。用户学到的是新手势，不是新概念。
- **回归面天然隔离**：ChatInput 与 FileManagerPanel 不嵌套，drop 事件互不冒泡；OS 文件上传路径只是在前面加一个载荷分支，原逻辑零改动。

## 2. 目标 / 非目标

**目标**

1. **P1 拖文件进输入框 = 插入引用**：`handleDropFiles` 前置分支——dataTransfer 含面板路径载荷（`DRAG_PATHS_MIME` 或 `application/x-mao-paths`，两套 MIME 顺带统一）时，对每条路径调既有 `insertFileReference(path)` 后返回；未命中再走既有 OS 文件上传分支。多选拖拽逐条插入。
2. **P1 拖文件到中心 Tab 栏 = 打开预览**：`CenterTabBar` / Tab 容器接受同款载荷，调既有 `openFileTab(path, name)`；拖拽悬停时目标 Tab 区高亮。
3. **P1 拖拽反馈**：输入框复用既有拖拽态样式扩展一个「引用拖入」视觉态；源面板行保持既有拖拽视觉。
4. **P1 载荷收口**：dragstart 统一补 `text/plain`（= 文件路径），并放宽 `effectAllowed` 为 `copyMove`——聊天区作为 copy 目标才能合法显示拖拽光标（`'move'` 限定下浏览器显示禁止符）；面板内部 drop 仍按 move 处理，语义不变。

**非目标**

- **不做触屏拖拽**：HTML5 DnD 在触屏不可达，安卓壳上该手势天然不出现；`@` 引用面板已是触屏可用路径，不做长按替代交互（这不是移动端布局重构的问题，是手势能力边界）。
- 不做反向拖拽（聊天附件/图片拖到文件面板保存）、不做拖到消息气泡引用、不做跨窗口/跨应用拖拽（OS 文件拖入上传已覆盖）。
- 不动文件面板内部移动/归组的任何行为；不动 OS 文件上传链路。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 移动端布局重构（AGENTS.md 明确不做） | 不改任何断点/布局；触屏上该手势只是不存在，无降级 UI 需求。 |
| 交付物中心（批次 11 否决） | 不登记不可变交付物，引用还是普通 `@` 引用节点。 |
| 任务模板 / Runbook（批次 8 否决） | 拖入引用不生成任何模板/资产。 |
| 会话导出 Markdown 与会话内查找（2026-11-02 否决） | 无检索、无导出语义。 |

## 4. 方案设计

### 4.1 载荷统一（起点侧）

- `FileManagerGrid.vue` / `FileManagerList.vue` dragstart：在既有 `DRAG_PATHS_MIME` 基础上补 `setData('text/plain', paths.join('\n'))`；`effectAllowed` 由 `'move'` 放宽为 `'copyMove'`。
- `FileTreeNode.vue` 已设 `application/x-mao-paths` + `text/plain`，仅同步放宽 `effectAllowed`。
- 消费端提供统一的 `parseWorkspaceDrag(dataTransfer)` 工具（读两种 MIME + `text/plain` 兜底），三处起点不要求载荷完全同形。

### 4.2 输入框落点（终点侧）

- `handleDropFiles` 顶部：`const paths = parseWorkspaceDrag(e.dataTransfer)`，非空则逐条 `insertFileReference(path)`、置拖拽视觉态后 `return`；引用节点渲染、草稿存储、`@{...}@` 解析全部走既有链路，零新逻辑。
- 插入数量上限：引用节点与 pending 附件上限（`MAX_PENDING_ATTACHMENTS`）口径不同，实施时确认引用是否需要上限；P1 先不限，实测多选拖 50+ 文件的插入耗时再定。

### 4.3 中心 Tab 落点（终点侧）

- `CenterTabBar.vue` 加 dragover/drop 处理：`dragover` 时判断载荷并置高亮态（`dropEffect='copy'`），`drop` 时取首条路径调 `openFileTab(path, 文件名)`；非工作区载荷（纯 OS 文件）不响应，维持现状。
- Tab 已满/重复打开的行为复用 `useCenterTabs` 既有去重与关闭记忆，不新增状态。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `FileManagerGrid.vue`、`FileManagerList.vue`、`FileTreeNode.vue`（dragstart 补 `text/plain` + 放宽 effectAllowed，共约 6 行）；新增 `utils/workspaceDrag.ts`（载荷解析）；`ChatInput.vue`（drop 前置分支 + 视觉态）；`CenterTabBar.vue`（drop 打开 Tab + 高亮） |
| backend-ts / admin / android / agent-cli | **无**；安卓壳触屏该手势不可达，无降级面 |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| `effectAllowed='move'` → `'copyMove'` 影响面板内部移动手感 | 内部 drop 目标仍显式设 `dropEffect='move'`，浏览器光标与落库语义均不变；回归用例覆盖「拖文件进目录树移动」。 |
| drop 载荷分支误吞 OS 文件上传 | 分支只认面板 MIME；`parseWorkspaceDrag` 命中即 return，未命中原逻辑逐行不动；用例覆盖 OS 文件、面板文件、两者混合（面板载荷优先）三种拖入。 |
| ProseMirror 对 `text/plain` 的兜底插入与 wrapper `@drop.prevent` 竞争 | 统一在 `handleDropFiles` 入口收口：面板载荷分支 `stopPropagation`；纯文本路径兜底仅在无面板载荷时保持既有行为（实施首日先实测现状，以此为准写用例）。 |
| 拖拽中路由切换 / 面板折叠导致 drop 目标消失 | drop 是一次性事件，目标不存在则浏览器自动取消，无持久状态，无落地动作——天然安全。 |
| 引用不存在的文件（面板数据过期） | `insertFileReference` 只写节点不做存在性校验（与 `@` 面板同口径）；发送时既有文件解析失败链路兜底，本提案不新增校验面。 |

## 7. 测试要点

1. 从网格 / 列表 / 目录树三个起点分别拖文件到输入框：插入 `@` 引用节点（非裸文本）、节点可点击、草稿保存与恢复包含该引用。
2. 多选 3 个文件一次拖入：插入 3 条引用，顺序与选择顺序一致。
3. OS 本地文件拖入：仍走上传分支生成 pending 附件（回归）；混合拖拽（面板文件 + 本地文件）优先面板载荷。
4. 拖文件到中心 Tab 栏：打开对应 `file` Tab，重复拖同文件不产生重复 Tab；Tab 栏其余区域拖拽行为不变。
5. 面板内部移动回归：拖文件进目录树目录、跨目录移动、组拖拽归组全部行为不变。
6. `effectAllowed` 放宽后浏览器拖拽光标在输入框/Tab 栏显示 copy、在面板内部显示 move。
7. 安卓壳触屏：文件列表可正常点击（无拖拽残留态）；无 JS 报错。

## 8. 决策记录

待评审确认：

1. **两套 MIME 是否合并为一套**（`DRAG_PATHS_MIME` vs `application/x-mao-paths`）：倾向消费端统一解析、起点暂不强求合并（少动既有代码），后续清理另起任务。
2. **拖入输入框默认语义**：插入引用（P1 取此）还是「询问：引用 / 打开预览」二选一弹层？倾向直接引用——低摩擦优先，打开预览已有 Tab 栏手势与点击路径。
3. **Tab 栏 drop 是否支持目录**：P1 只支持文件（目录打开无预览语义）；目录拖入忽略还是展开为「打开文件管理器 Tab」，实施时定。
