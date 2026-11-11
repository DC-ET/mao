# 工具卡文件路径联动中心 Tab 技术方案：read/write/edit 路径行与 shell 复制命令

> 对应提案：[docs/proposals/2026-11-11-tool-card-file-link.md](../proposals/2026-11-11-tool-card-file-link.md)（批次 29）。零后端、零迁移，改动面收敛在 desktop 的 `ToolCallCard.vue` 与 `ToolShellView.vue` 两个文件，纯前端增量。

## 1. 需求背景

Agent 的产出大量以「文件路径」形态出现在工具卡里。中心 Tab 文件查看器的入口 API 是现成的——`useCenterTabs.ts:264` `openFileTab(filePath, title, workspaceRoot?)`，且**聊天侧的部分接线已经落地**（提案写作时的「零接线」现状已过时，以下为 2026-11-11 复核后的真实现状）：

| 场景 | 现状 | 代码证据（2026-11-11 复核） |
|---|---|---|
| glob/grep/open_web_page 结果的文件名 | **已可点击**，点击后 `openFileTab` 打开中心 Tab | `ToolCallCard.vue:296-308` `handleOpenToolFile`（含 workspaceRoot 透传与 canOpen 守卫）、`ToolGrepView.vue:13`、`ToolGlobView.vue:15` `emit('open-file')` |
| `read_file` / `write_file` / `edit_file` 卡的路径 | **不可点击**——路径只出现在卡头 summary 文本（后端 summarizer 产物）里，正文区（diff 块 / 文件内容块）没有路径行 | `ToolCallCard.vue:51-74` 三个富视图分支均无路径渲染 |
| shell 卡的命令行 | 命令本身无复制入口（右上角复制按钮只绑输出） | `ToolShellView.vue:15-22`（copy-btn 只 `copy(output \|\| error)`） |
| 打开守卫 | CLOUD 需有活跃会话、LOCAL 需有 workspace，越界路径交给 FileViewer 既有沙箱 | `ToolCallCard.vue:300-307` |

即：本方案要补的是**三个文件工具卡的路径行**与**shell 复制命令**两个缺口，不是从零建联动。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 展开 `read_file` / `write_file` / `edit_file` 工具卡 | 正文顶部出现文件路径行（mono 字体、链接色），点击后在中心 Tab 打开该文件；已打开同文件时聚焦既有 Tab（`openFileTab` 既有去重语义） |
| 2 | 新建态（无 workspace）或无活跃会话时展开同一批卡片 | 路径行**不渲染**（与既有 `handleOpenToolFile` 的 canOpen 守卫同口径） |
| 3 | `read_file` 失败（error）时展开卡片 | 路径行照常渲染——文件可能仍存在，用户需要打开核对 |
| 4 | shell 卡执行完成 | 命令行末尾出现「复制命令」按钮，点击后剪贴板内容 = 命令原文；输出复制按钮行为不变 |

**要做**：上述四条。

**不做**（评审已拍板 + 既有边界）：

- shell 输出正文里的自由文本路径链接化——不做，仅结构化字段（路径行 / grep/glob 既有链接）。
- edit_file 路径行直达 diff 视图——不做，点击打开查看器当前文件态，diff 入口由既有 GitChangeList 覆盖。
- 右键菜单、复制路径入口——不做，打开是路径行的唯一动作。
- glob/grep/open_web_page 的链接行为改动——不做，已落地部分零改动。

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 接线方式 | **不新增 `utils/openWorkspaceFile.ts` 中转层**，路径行直接复用 `ToolCallCard` 既有的 `handleOpenToolFile`（:298-308）与 `openFileTab` 引用（:296） | 提案原方案的注入回调是为「零接线」现状设计的；现在卡内已有同语义、同守卫、同 workspaceRoot 口径的现成通道，再加一层中转只会造成两套调用路径。提案 §7-4 的「单点引用」断言由「三个视图都在 ToolCallCard 内渲染」天然满足 |
| 路径行渲染位置 | **ToolCallCard 模板里 `richView` 分支顶部加一个共用路径行**（`v-if` 只对 fileView / writeView / editDiffView 三态成立），不在三个视图组件里各写一份 | 三态共享同一 DOM 结构与样式；glob/grep/webpage 各有自己的文件列表链接，不加路径行 |
| edit_file 的路径来源 | `editDiffView` computed（:418-428）补 `path: textOf(input.path \|\| input.file_path)`，与 fileView（:482）/ writeView（:511）的取值口径一致 | diff 视图当前不含路径；入参必有 path，无结果依赖 |
| 路径行元素 | 原生 `<button>`（非 `<a>`）；**不加 aria-label**——可见文本即路径本身（可访问名 = 可见文本），title 悬停显示完整路径 | 无真实 href（打开动作是应用内路由），button 才有正确键盘语义；仓库规范（AGENTS.md）仅对无可见文本的图标按钮强制 aria-label/title，文本按钮以可见文本为名——加 `aria-label="打开文件"` 反而把可访问名里的路径信息覆盖掉 |
| 守卫复用 | 把 `handleOpenToolFile` 里的 canOpen 判定（:302-305）抽成 computed `canOpenToolFile`，渲染与点击共用 | 渲染态与点击态必须同口径，避免「渲染了但点了没反应」；抽 computed 后 handleOpenToolFile 改用它 |
| 复制命令按钮位置 | `cmd-line` 行内末尾（flex 自然跟随命令文本），不与右上角输出复制按钮叠放；显隐与既有 copy-btn 同款（`.tool-shell:hover` 显现） | 输出复制按钮已绝对定位于容器右上角，再放一个同位按钮会叠；行内末端不占额外行 |
| 样式 | 路径行 mono 字体 + `--aw-primary` 链接色 + 悬停下划线，**单行省略**（超长路径由 title 兜底全文）；`:focus-visible` 时 `outline: 2px solid var(--aw-primary)` | 零新增色值，走既有 `--aw-*` 令牌；键盘可达沿用 0.0.471 的 focus-visible 惯例（如 `RunTracePanel.vue:1200`） |

## 4. 实现步骤

### 4.1 `ToolCallCard.vue`：共用路径行

1. `editDiffView` computed 补 `path` 字段（取 `input.path || input.file_path`，string）。
2. 新增 computed（守卫 computed 先声明，路径行 computed 引用它）：

   ```ts
   const canOpenToolFile = computed(() => {
     const session = sessionStore.activeSession
     if (!session) return false
     return session.executionMode === 'CLOUD' ? !!sessionStore.activeSessionId : !!session.workspace
   })

   /** 三个文件工具富视图的路径行：path 非空 + 打开守卫通过才渲染（与 handleOpenToolFile 同口径）。 */
   const fileToolPathRow = computed(() => {
     const view = editDiffView.value ?? fileView.value ?? writeView.value
     if (!view?.path) return null
     if (!canOpenToolFile.value) return null
     return view.path
   })
   ```

   `handleOpenToolFile`（:298-308）改用 `canOpenToolFile`，删除函数体内的重复判定（行为等价；函数体保留 `if (!path) return` 早退）。
3. 模板 `<template v-if="richView">` 内、三态视图分支之前加：

   ```html
   <button v-if="fileToolPathRow" class="tool-path-row" :title="fileToolPathRow" @click="handleOpenToolFile(fileToolPathRow)">
     {{ fileToolPathRow }}
   </button>
   ```

   注意 `editDiffView ?? fileView ?? writeView` 的顺序无所谓——三个 computed 互斥（按 toolCall.name 分支），任一命中即取到。
4. 样式追加（scoped）：`.tool-path-row`（mono、`--aw-primary`、text-align left、`min-width: 0`、`white-space: nowrap`、`overflow: hidden`、`text-overflow: ellipsis` 单行省略、悬停下划线、`:focus-visible` outline）。

### 4.2 `ToolShellView.vue`：复制命令按钮

1. `cmd-line` 内、`cmd-text` 之后加：

   ```html
   <button v-if="command" class="cmd-copy-btn" title="复制命令" aria-label="复制命令" @click="copy(command)">
     <el-icon :size="12"><CopyDocument /></el-icon>
   </button>
   ```

   `copy` 复用组件既有函数（:41-45），复制对象从 `output || error` 改为按按钮区分——命令按钮传 `command`，输出按钮保持 `output || error`，两个按钮互不改动。
2. 样式：`.cmd-copy-btn`（flex-shrink: 0、约 20px 见方、与既有 copy-btn 同配色令牌与悬停显隐）；**追加 `.cmd-copy-btn:focus-visible { opacity: 1 }`**——悬停显隐按钮（默认 opacity 0）键盘聚焦时必须可见，0.0.471 先例 `style.css:798` mermaid-expand-btn 同款。

### 4.3 测试

1. `ToolCallCard.test.ts` 追加：
   - makeReadCall / makeEditCall / makeWriteCall（新增工厂）三种卡片渲染 `.tool-path-row` 且文本 = 输入 path；
   - **点击实体链路**（评审补充：实测 `ToolCallCard.test.ts` 62 个用例中没有任何 glob/grep/web_page 链接的点击断言——唯一相关是 web_page「点击不抛错」且显式注明无 activeSession 静默返回，不存在可依赖的旧口径，必须新增实体用例）——用 store 既有 action 播种会话（`sessionStore.upsertSessionEntity({ id, workspace, executionMode: 'CLOUD', … })`（`list.ts:282/:885` 已导出）+ `setActiveSession(id)`（`:898`）），点击路径行后以另一 `useCenterTabs` 实例读 `sessionTabsMap`（模块级单例、多实例共享，`useCenterTabs.ts:128/:151` 证实），断言 file Tab 的 `filePath / title / workspaceRoot` 三元组正确；
   - 无活跃会话（或 LOCAL 无 workspace）→ `canOpenToolFile` false → **路径行不渲染**（渲染守卫先行，不存在「渲染了点了没反应」的形态；web_page 链接的「恒渲染 + handler 静默返回」是另一种刻意不同的既有模式，其用例不动）；
   - `input.path` 缺失（畸形输入）→ 路径行不渲染；read_file error 态 → 路径行照常渲染。
2. `ToolShellView.test.ts` 追加：复制命令按钮渲染（aria-label="复制命令"）、点击后 mock 的 `copyText` 收到 `command` 原文、输出复制按钮收到的仍是 `output || error`。

### 4.4 CHANGELOG 与文档

- 根 `CHANGELOG.md` 前端（桌面 / Web）小节记一条（版本随发版批次）。
- 提案文档状态挪「已立项」由本批次台账维护统一处理（见提案 README）。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 修改 | desktop/src/components/chat/ToolCallCard.vue | editDiffView 补 path；fileToolPathRow / canOpenToolFile computed；路径行模板与样式；handleOpenToolFile 改用 computed |
| 修改 | desktop/src/components/chat/ToolShellView.vue | 复制命令按钮 + 样式 |
| 修改 | desktop/src/components/chat/ToolCallCard.test.ts | 路径行渲染 / 守卫 / 点击用例 |
| 修改 | desktop/src/components/chat/ToolShellView.test.ts | 复制命令按钮用例 |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面 / Web）小节 |
| backend-ts / admin / android / agent-cli | — | **无改动**（安卓壳共用 UI，路径行与复制按钮可用） |
| 数据库迁移 | — | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 路径行与 glob/grep 既有链接行为分叉（双口径） | 点击与渲染共用 `handleOpenToolFile` / `canOpenToolFile` 单点，grep/glob 链接也走同一函数，天然同口径 |
| 越界路径（agent 引用工作区外文件） | 不在 UI 层加判断，沿用既有 FileViewer 沙箱行为（与 glob/grep 既有链接同水位） |
| 三个视图 computed 互斥假设被后续改动破坏 | `fileToolPathRow` 用 `??` 链取第一个带 path 的视图；若未来新增文件类工具，在该链上追加即可，样式与守卫零改动 |
| 复制命令按钮遮挡长命令换行 | 行内 flex 布局，按钮 `flex-shrink: 0` 固定宽度，命令文本 `min-width: 0` 换行不受影响 |
| 触屏设备悬停显隐不可达 | 与既有 copy-btn 同款问题，不在本方案扩大范围；桌面端为主要场景，安卓壳上按钮随 hover 状态显现（触摸首触即 hover） |

## 7. 测试要点

1. read_file / write_file / edit_file 卡路径行渲染，文本 = 输入路径；点击后走 `handleOpenToolFile` 同一入口（glob/grep 既有链接回归不破）。
2. 同文件二次点击聚焦既有 Tab（`openFileTab` 去重既有，用 `useCenterTabs.test.ts` 已覆盖的语义做基线，不重复实现）。
3. 新建态（无 workspace / 无活跃会话）路径行不渲染；read_file 失败态（error 结果）路径行照常渲染。
4. shell 卡复制命令：剪贴板内容 = 命令原文；输出复制按钮内容不变（`ToolShellView.test.ts` 既有用例全绿）。
5. 键盘：路径行与复制命令按钮 Tab 可聚焦、Enter 触发、`:focus-visible` 轮廓可见；复制命令按钮聚焦时从 opacity 0 恢复可见。
6. 构建：`npm run build`（desktop）绿。

## 8. 决策记录

1. 接线不做新的中转层：`handleOpenToolFile` 既有通道直接复用（§3 首行决策，提案原文的 `openWorkspaceFile.ts` 方案作废）。
2. 路径行只在三个文件工具富视图出现；glob/grep/open_web_page 已有链接不动。
3. edit_file 打开的是查看器当前文件态，不直达 diff（评审拍板）。
4. shell 输出正文不做路径链接化（评审拍板）。
5. 失败态（error）卡片路径行照常渲染：读/写失败时用户最需要打开文件核对，路径行不能跟着内容块一起消失。
6. 不可开态存在两种刻意不同的形态：路径行（本方案新增 affordance）**守卫先行不渲染**；web_page 全文链接是既有行为**恒渲染 + handler 静默返回**。两者互不统一——新增面按「不给无效可点击」收口，既有面零改动。

## 9. 评审修订记录（2026-11-12）

1. 修正测试口径：原稿「无会话态点击为空操作」不成立（守卫先行时行不渲染）；「点击链路由既有口径覆盖」经实测不存在，改为播种会话 + `sessionTabsMap` 单例断言的实体用例（§4.3-1）。
2. 消除样式自相矛盾：§3「省略号」与 §4.1「word-break: break-all（换行）」二选一，统一为单行省略 + title 兜底（§3/§4.1）。
3. 补键盘可见性：悬停显隐的 `.cmd-copy-btn` 补 `:focus-visible { opacity: 1 }`（§4.2/§7-5）。
4. 路径行不加 `aria-label="打开文件"`：可见文本（路径）即可访问名，加 aria-label 反而覆盖掉路径信息（§3/§4.1）。

## 10. 明确不做的（汇总）

- shell 输出正文自由文本路径链接化；路径行右键菜单 / 复制路径入口。
- edit_file 直达 diff 视图；`useCenterTabs` API 与 Tab 去重语义改动。
- glob/grep/open_web_page 既有链接行为与样式的任何改动。
- 越界路径的 UI 层校验（沿用 FileViewer 沙箱）。
- 后端、admin、agent-cli、数据库迁移的任何改动。
