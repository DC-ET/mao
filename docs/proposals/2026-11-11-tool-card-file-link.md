# 提案：工具卡文件路径联动中心 Tab —— 聊天里点一下，文件在查看器打开

> Agent 的产出大量以「文件路径」形态出现在工具卡里：read_file / write_file / edit_file 的目标路径、grep_search / glob_search 的命中文件、shell 输出里打印的路径。这些路径今天一律是**纯文本**（`ToolCallCard.vue:143/:178` 的 `<pre>` 结果区、`ToolShellView.vue:9` 的命令行），用户想看文件全貌要自己抄路径 → 切到工作区文件管理 → 逐级点开。而中心 Tab 的文件查看器入口 API 是现成的——`useCenterTabs.ts:264` `openFileTab(filePath, title, workspaceRoot?)`——只是聊天侧组件**零接线**（grep `chat/*.vue` 无一处引用 `useCenterTabs`）。文件树右键菜单的「添加到聊天」已经打通了「文件 → 聊天」方向（工作区文件直管，批次 5），本提案补完反方向：**聊天 → 文件查看**。

- 状态：待评审（2026-11-11，批次 29）
- 日期：2026-11-11
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（约 1 人日；**零后端、零迁移**，纯 desktop 前端增量）
- 关联：`desktop/src/components/chat/ToolCallCard.vue`、`desktop/src/components/chat/ToolShellView.vue`、`desktop/src/components/chat/ToolFileContent.vue`、`desktop/src/composables/useCenterTabs.ts`（`openFileTab` :264 既有）、`desktop/src/components/center/FileViewer.vue`

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 工具结果里的路径 | 纯文本 `<pre><code>`，不可点击 | `ToolCallCard.vue:143/:178` |
| shell 卡的命令行 | 纯文本展示（输出有复制按钮，命令本身没有） | `ToolShellView.vue:9`（cmd-text）、`:17-19`（copy-btn 只绑输出） |
| 中心 Tab 打开文件 | API 成熟（含 workspaceRoot 归一、占位键兜底） | `useCenterTabs.ts:264` `openFileTab`、`:228` 占位键说明 |
| 聊天侧对中心 Tab 的引用 | 零 | `grep useCenterTabs chat/*.vue` 无命中 |
| 反向联动先例 | 文件树右键「添加到聊天」已落地（方向相反） | 工作区文件直管（批次 5 已落地） |

与已否决项的边界：批次 20 否决的是「Markdown 导出 + 会话内查找」；批次 26 否决的是会话级「图片快览 gallery」；本提案是**单点路径的查看联动**，不涉导出、不涉批量浏览，三者正交。

## 2. 目标 / 非目标

**目标**

1. **P1 可点击路径识别**：`read_file` / `write_file` / `edit_file` 工具卡的路径字段（结构化输入已有，非文本猜测）渲染为可点击链接；`grep_search` / `glob_search` 命中列表的文件路径行同样可点。
2. **P1 点击行为**：调 `openFileTab(filePath, fileName, workspaceRoot)` 在中心 Tab 打开对应查看器（文本 / diff / 图片 / 归档等分发已有）；**中心 Tab 已打开该文件时聚焦既有 Tab**（`useCenterTabs` 既有去重语义，不重复开）。
3. **P2 shell 卡「复制命令」**：`ToolShellView` 命令行旁加复制按钮（复用既有 `copyText` 反馈样式），输出复制按钮不动。
4. 可点击路径的视觉：与正文同色系 + 悬停主题色下划线，遵守 0.0.471 的焦点可见规范（`focus-visible` 轮廓）。
5. 安卓壳共用 UI：点击行为在 Web/安卓同样生效（openFileTab 中心 Tab 与桌面共用）。

**非目标**

- 不做自由文本里的路径猜测（shell 输出正文里的路径保持纯文本——误点率与转义成本都不划算，结构化字段已够覆盖高频场景）。
- 不做「在终端打开 / 右键菜单」（消息上下文菜单批次 25 已否决）。
- 不改 `useCenterTabs` 既有 API 与 Tab 去重语义；不改任何工具执行逻辑。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 消息级上下文菜单（批次 25 否决） | 不引入右键菜单；是既有工具卡字段的**内联链接化**，无菜单无溢出收敛 |
| 会话图片快览（批次 26 否决） | 不做会话级 gallery；单文件 Tab 打开复用既有查看器 |
| 会话导出 / 会话内查找（批次 20 否决） | 不涉导出与检索 |
| 文件树「添加到聊天」（已落地） | 互补的另一半方向；不改动该入口 |

## 4. 方案设计

- **路径来源**：只取结构化字段——`ToolCallCard` 已把输入解析为对象（`parseResultNode` / 输入 props），`read_file`/`write_file`/`edit_file` 的 `path`、grep/glob 的命中数组在富视图组件里现成（`ToolFileContent` / `ToolGrepView` / `ToolGlobView`）；不解析 `<pre>` 自由文本。
- **接线**：新增 `utils/openWorkspaceFile.ts`——`openWorkspaceFile(path, workspaceRoot)` 内部调 `useCenterTabs().openFileTab`；富视图组件注入回调 prop（`onOpenFile`）由 ChatPanel 绑定，避免工具卡直接耦合 store（与 `registerChatInput` 注入同风格）。新建态（无 workspaceRoot）时按钮不渲染。
- **shell 复制命令**：`ToolShellView` 命令行 `cmd-text` 旁加图标按钮（aria-label="复制命令"），复用 `copyText`。
- **样式**：链接态沿用 `--aw-primary` 与既有 `focus-visible` 体系，零新增色值。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | 新增 `utils/openWorkspaceFile.ts`；`ToolCallCard.vue`（富视图回调透传 + 链接渲染）；`ToolShellView.vue`（复制命令按钮）；`ToolFileContent` / `ToolGrepView` / `ToolGlobView`（路径链接化）；`ChatPanel.vue`（onOpenFile 绑定）；测试新增 |
| backend-ts / admin / android / agent-cli | **无**（安卓壳共用 UI，点击行为可用） |
| 数据库迁移 | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 路径不在工作区内（agent 引用了外部路径） | `openFileTab` 对越界路径按 FileViewer 既有沙箱行为处理；链接态不做额外判断（点击即走既有通道，不在 UI 层重复校验） |
| 中心 Tab 被占满 / 新建态 | `useCenterTabs` 占位键兜底既有；新建态不渲染链接（§4） |
| 大量命中行渲染为链接影响 diff 性能 | 仅 grep/glob 富视图的文件名列链接化（每行一个 `<button>`），正文内容不动；`grepSearchFindsMatches` 的行级文本保持纯文本 |
| 误点扩散（复制路径 vs 打开） | 打开是唯一动作；复制路径仍走既有输出复制按钮 |

## 7. 测试要点

1. read_file / write_file / edit_file 卡路径点击 → `openFileTab` 收到正确三元组；二次点击同文件聚焦既有 Tab（不开新 Tab）。
2. grep/glob 命中列表点击 → 对应文件打开；正文行不受影响。
3. 新建态（workspaceRoot 空）不渲染链接；shell 卡复制命令点击 → 剪贴板内容 = 命令原文。
4. 源码级断言：`chat/*.vue` 对 `useCenterTabs` 的引用只经 `openWorkspaceFile` 单点（不散落）。
5. 键盘：链接 Tab 可聚焦、Enter 触发、focus-visible 轮廓可见（0.0.471 同款）。

## 8. 决策记录

待评审确认：

1. **read_file / write_file 卡的路径与「内容预览」重复**：内容已在卡内展示（`ToolFileContent`），打开查看器看的是「全貌 + 上下文」——保留两个入口还是仅 grep/glob 链接化？P1 全量链接化，评审可收窄。
2. **edit_file 链接打开的是当前文件态**（diff 视图入口另有 GitChangeList）：是否需要直达 diff？P1 不做，GitChangeList 已覆盖。
3. **shell 输出正文是否链接化**：P1 不做（§2 非目标），评审若认为高频可后补（转义与误点评估）。
