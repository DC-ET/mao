# 超大文件拆分技术方案：TaskIndexPanel / ChatInput / session store

日期：2026-09-30
范围：`desktop/` 前端（桌面 / Web / 安卓共用 UI）
目标文件：

- `desktop/src/components/task/TaskIndexPanel.vue`（2288 行）
- `desktop/src/components/chat/ChatInput.vue`（2097 行）
- `desktop/src/stores/session.ts`（1998 行）

## 1. 需求背景

desktop 端三个核心文件行数均已接近或超过 2000 行，成为维护瓶颈：

- **改动冲突高发**：任务面板、输入框、会话 store 是前端最高频改动区域，单文件过大导致 PR 冲突率高。
- **逻辑定位困难**：如 `TaskIndexPanel.vue` 单文件内同时承载标准/聚焦两种列表模式、分组折叠、分组拖拽排序、分组重命名、会话右键菜单、归档/删除流转等至少 6 个独立关注点。
- **无法针对性测试**：desktop 当前无单元测试基建，`session.test.ts`（718 行、39 个用例）长期无法执行，store 行为失去回归保护。

## 2. 需求描述

将三个超大文件拆分为多个职责单一的小文件，同时严格保证：

1. **不影响现有逻辑**：不改任何表达式、执行顺序、副作用时机。
2. **不丢失任何逻辑分支**：拆分后逐块 diff 核对，每一个 `v-if`、每一个 `watch` 触发条件、每一个 early-return 都可追溯到原文件。
3. **不打乱执行顺序和流程**：生命周期钩子、watch 注册顺序、事件监听挂载/卸载时机与原文件保持一致。

## 3. 明确不做（不做清单）

以下事项本轮**一律不做**，写入不做清单以避免范围蔓延：

| 不做项 | 说明 |
|---|---|
| 不改任何对外 API / 接口 | store 的 `useSessionStore` 导出签名、两个组件的 `props` / `emits` / `expose` 签名一律保持原样，所有调用方零改动 |
| 不重构其他未点名文件 | 不碰 `ChatPanel.vue`、`useChat.ts`、`useStreamWS.ts`、`AgentSelector.vue` 等其他任何文件，即使发现可优化点 |
| 不升级依赖 | 除引入 vitest 测试基建（见 §5.1）外，不新增、不升级任何依赖，不改 `vite.config` / `tsconfig` 等构建配置 |
| 不动后端 / admin / 安卓 | 后端（backend-ts）、管理后台（admin）、安卓原生壳（android/）零改动；拆分对安卓 Capacitor 远程加载透明 |
| 不做逻辑修复 | 拆分过程中发现的疑似 bug 只记录、不顺手修，另开任务处理 |
| 不改 CHANGELOG | 纯内部重构、无用户/运维可见行为变化，按 AGENTS.md 约定不记 CHANGELOG |

## 4. 技术选型

### 4.1 拆分手法：子组件为主 + composable 为辅

针对两个 Vue 大组件：

- **模板中相对独立的 UI 区块拆成子组件**（.vue）：真正同时减少 template 与 script 行数。
- **纯状态/逻辑抽成 composable**（useXxx.ts）：与项目既有 `desktop/src/composables/` 约定一致（参考 `useChatScroll`、`useTaskPanelPrefs` 等）。
- 弃用「只抽 composable」方案：template 行数不变，文件仍然偏长，不达标。
- 弃用「只抽子组件」方案：props/emits 透传链过长，最容易引入逻辑偏差。

### 4.2 store 拆分：单入口 + 领域模块文件

`session.ts` 为 setup 语法的 `defineStore('session', ...)`，对外暴露唯一 `useSessionStore`。采用：

- 对外仍只有一个 `useSessionStore`，所有调用方 `import { useSessionStore } from '../stores/session'` 零改动。
- store 内部按领域拆到 `desktop/src/stores/session/*.ts` 模块文件（每个模块是一个接收上下文的工厂函数，返回该领域的 state 与 action），主文件只做组装与 `return`。
- 弃用「拆成多个独立 store」方案：需要改动全部调用方，违反「不影响现有逻辑」。

### 4.3 验证基建：vitest 单测 + 存量 Playwright E2E

- desktop 引入 `vitest` + `@vue/test-utils`（仅 devDependencies，测试基建，属获批的唯一依赖变动），让存量 `session.test.ts` 可执行，作为 store 拆分的自动化基线。
- 复用根目录既有 Playwright E2E（`tests/desktop.spec.ts`），不为本次拆分另建 E2E 框架。

### 4.4 目录与命名：就近同目录 + 语义化命名

- 子组件与被拆组件同目录：`desktop/src/components/task/`、`desktop/src/components/chat/`。
- composable 统一进 `desktop/src/composables/`。
- store 领域模块进 `desktop/src/stores/session/`。
- 命名语义化，见 §6 各文件拆分表。

## 5. 实现步骤（总流程）

按 **TaskIndexPanel → ChatInput → session store** 的顺序逐个拆分、逐个验证、逐个交付。每个文件走完完整的「基线 → 拆分 → 验证」闭环后才动下一个，保证回滚粒度最小、问题定位最快。

### 5.1 第 0 步：建立验证基线（先于一切拆分）

1. desktop 引入 vitest 基建：`vitest`、`@vue/test-utils`、`jsdom`（devDependencies），新增 `vitest.config.ts`（jsdom 环境 + 路径别名与 vite 对齐）。
2. 跑通存量 `desktop/src/stores/session.test.ts`（39 个用例），确认全绿并固定为 store 拆分基线；若有存量失败用例，原样记录并在拆分后要求结果完全一致（不允许借拆分之机修改用例使其变绿）。
3. 跑通存量 E2E（`tests/desktop.spec.ts`），记录通过基线。
4. 对三个目标文件各做一次完整留档（拆分前快照），供逐块 diff 核对。

### 5.2 第 1 步：拆分 TaskIndexPanel.vue

现状结构：template 1–470 行（标准模式分组列表、聚焦模式平铺列表、历史折叠区、已归档区、右键菜单 Teleport），script 472–1431 行，style 1432–2288 行。

**拆分子组件**（均放 `desktop/src/components/task/`，props/emits 透传保持原语义）：

| 新文件 | 承接内容 |
|---|---|
| `TaskSessionGroupList.vue` | 标准模式分组列表：分组头（图标/重命名输入/折叠箭头/操作按钮）、组内会话项、分组拖拽排序、分页加载更多 |
| `TaskFocusList.vue` | 聚焦模式全量平铺列表（含优先级排序渲染、历史折叠区） |
| `TaskArchivedSection.vue` | 底部已归档区（两种模式共用） |
| `TaskContextMenu.vue` | 会话右键菜单 + 分组头右键菜单（Teleport 到 body） |

**抽出 composable**（放 `desktop/src/composables/`）：

| 新文件 | 承接内容 |
|---|---|
| `useTaskPanelGroups.ts` | 分组折叠状态、分组别名/重命名（`renamingGroupKey`、`startGroupRename`、`confirmGroupRename` 等） |
| `useTaskPanelDragSort.ts` | 分组拖拽排序（`dragIndex`、`onGroupDragStart/Over/Leave/Drop/End`） |
| `useTaskPanelListMode.ts` | 标准/聚焦模式切换、`loadFocus`、`loadArchive`、可见数量分页 |

样式拆分：`TaskIndexPanel.vue` 的 `<style scoped>` 中仅被子组件使用的类随子组件迁出；面板级布局样式留在主文件。样式逐类核对，不改任何选择器与属性值。

**验证**：
- 为新 composable 各补关键路径单测（分组折叠切换、拖拽排序下标计算、模式切换）。
- `vue-tsc` 构建通过。
- 逐块 diff：主文件残留 template/script 与拆分前快照逐段比对，确认零逻辑改动。
- E2E 冒烟补充：任务面板分组折叠/展开、会话右键菜单打开、聚焦/标准模式切换。

### 5.3 第 2 步：拆分 ChatInput.vue

现状结构：template 1–285 行（新任务配置栏、编辑器区、待发送文件列表、底部工具条、移动居中态配置条），script 286–1436 行（tiptap 编辑器、快捷命令面板、@文件引用面板、草稿保存/恢复、待发送文件、拖拽上传、发送/停止/继续），style 1437–2097 行。

**拆分子组件**（均放 `desktop/src/components/chat/`）：

| 新文件 | 承接内容 |
|---|---|
| `ChatNewTaskConfigBar.vue` | docked 布局新任务配置栏（AgentSelector、CLOUD/LOCAL 模式切换、工作区选择、云端工作区 detail） |
| `ChatPendingFileList.vue` | 待发送文件/图片列表（含预览、移除） |
| `ChatInputToolbar.vue` | 底部工具条（附件按钮、居中态 chips、工作区指示器、发送/停止按钮） |
| `ChatMobileConfigRow.vue` | 移动居中态智能体/工作区配置条 |

**抽出 composable**（放 `desktop/src/composables/`）：

| 新文件 | 承接内容 |
|---|---|
| `useQuickCommandPanel.ts` | `/` 快捷命令面板：`ensureCommandsLoaded`、`detectSlashTrigger`、`handleCommandSelect`、`closePanel` 及面板状态 |
| `useFileReferencePanel.ts` | `@` 文件引用面板：`fetchWorkspaceFiles`、`detectAtTrigger`、`handleFileReferenceSelect` 及面板状态 |
| `useChatDraft.ts` | 草稿：`buildCurrentDraft`、`saveDraft`、`restoreDraft`、`watch(props.draftKey)` |
| `usePendingFiles.ts` | 待发送文件：`checkFileSize`、`addPendingImage`、`addPendingFile`、拖拽上传四件套、移除 |

tiptap `useEditor` 初始化及其 `onUpdate` 中的 `detectSlashTrigger` / `detectAutoComplete` / `detectAtTrigger` 调用链**保持在主文件**，仅把 detect 函数本体替换为 composable 导入，注册顺序逐行保持原样。

**验证**：
- 为新 composable 各补关键路径单测（草稿保存/恢复 key 切换、文件大小校验拒绝分支、快捷命令过滤）。
- `vue-tsc` 构建通过；逐块 diff 确认零逻辑改动。
- E2E 冒烟补充：输入文本并发送、`/` 唤起快捷命令面板、新任务配置栏模式切换。

### 5.4 第 3 步：拆分 session store

现状：单文件 setup store，约 100+ 个 state/computed/action，自然领域边界清晰。

**拆出领域模块**（放 `desktop/src/stores/session/`，每个模块导出工厂函数，接收共享 state 引用）：

| 新文件 | 承接内容（以拆分前实际代码为准，逐函数迁移） |
|---|---|
| `types.ts` | `Session`、`SessionRuntimeStatus`、`SideTaskItem`、`SubagentItem`、`SessionGroupMeta`、`LlmRetryInfo` 等 interface 与常量（`ACTIVE_PHASES`、分页常量、`LAST_SESSION_KEY`） |
| `list.ts` | 标准/归档/聚焦三套列表 state 与 `fetchSessions`、`fetchArchivedSessions`、`fetchFocusSessions`、`loadMoreInGroup`、分组 meta、`createSession`、`updateSession`、`archive/unarchiveSession` 等 |
| `messages.ts` | `sessionMessages` / `sessionTodos` / `sessionActivities` / 消息分页（hasMore、loadingOlder、nextBeforeId）及对应 action |
| `stream.ts` | 流式状态：`sessionStreaming`、`sessionThinking`、`streamingAssistantMessageIds`、delta 追加、abort 尾部丢弃 |
| `sideTask.ts` | side task 缓存、增删改、未读、pending 计数 reconcile |
| `subagent.ts` | subagent 缓存与增删改、`delegateToolCallBindings` |
| `misc.ts` | `normalizeId`、`normalizeSession`、`persistLastSession`、`applyRuntimeStatus` 等纯辅助 |

主文件 `session.ts` 保留：`defineStore` 调用、各模块工厂组装、完整 `return { ... }`（导出成员与原文件逐一相同，顺序保持一致）。

**验证**：
- 存量 `session.test.ts` 39 个用例全绿，且结果与第 0 步基线逐项一致。
- `vue-tsc` 构建通过；导出清单 diff（拆分前后 `useSessionStore` 返回键集合必须完全一致）。
- 跑存量 E2E 全套确认无回归。

### 5.5 第 4 步：总验证

1. `cd desktop && npx vue-tsc --noEmit` 与 `npm run build` 全绿。
2. `cd desktop && npx vitest run` 全绿（存量 39 用例 + 新增 composable 用例）。
3. 根目录 Playwright E2E（含本轮新增冒烟用例）全绿。
4. 三个主文件行数复核（`wc -l`），验收达标（见 §7）。

## 6. 拆分约束（防逻辑漂移红线）

1. **纯搬运**：只移动代码与补充 import/export、props/emits 透传，不改任何表达式、条件、顺序、命名。
2. **watch / 生命周期注册顺序不变**：script 中 `watch`、`watchEffect`、`onMounted`、`onUnmounted`、`onBeforeUnmount` 的注册先后关系原样保留；composable 内的 hook 在其被调用的原位展开。
3. **响应式引用不断链**：store 领域模块通过工厂参数共享 ref，禁止在模块边界做 `.value` 快照拷贝。
4. **逐块 diff 核对**：每个文件拆完后，与拆分前快照做「块级映射表」（原行区间 → 新文件:行区间），任何无法映射的代码视为丢失，必须补齐。
5. **导出签名冻结**：拆分前后 `useSessionStore` 返回键集合、组件 `props`/`emits`/`defineExpose` 逐项一致。
6. **样式随组件迁移**：类名、选择器、属性值一律不改；scoped 样式只跟随其 template 节点移动。

## 7. 验收标准（完成定义）

| 项 | 标准 |
|---|---|
| 主文件行数 | `TaskIndexPanel.vue`、`ChatInput.vue`、`session.ts` 各 ≤ 800 行 |
| 拆出文件行数 | 每个新文件 ≤ 约 400 行 |
| 类型检查 | `npx vue-tsc --noEmit` 零错误 |
| 构建 | `cd desktop && npm run build` 成功 |
| 单元测试 | vitest 全绿：存量 `session.test.ts` 39 用例结果与基线一致 + 新增 composable 用例 |
| E2E | 存量 desktop E2E 全绿 + 本轮新增冒烟用例（任务面板分组折叠/右键菜单/模式切换、ChatInput 发送/快捷命令/新任务配置栏） |
| 行为核对 | 每个文件附块级映射表，与原快照逐块对应，无遗漏 |

## 8. 落地清单

### 8.1 基建（第 0 步）

- [ ] desktop 引入 `vitest`、`@vue/test-utils`、`jsdom`（devDependencies）与 `vitest.config.ts`
- [ ] 跑通 `desktop/src/stores/session.test.ts` 并记录基线结果
- [ ] 跑通存量 Playwright E2E 并记录基线
- [ ] 三个目标文件拆分前快照留档

### 8.2 TaskIndexPanel（第 1 步）

- [ ] 拆出 `TaskSessionGroupList.vue`、`TaskFocusList.vue`、`TaskArchivedSection.vue`、`TaskContextMenu.vue`
- [ ] 抽出 `useTaskPanelGroups.ts`、`useTaskPanelDragSort.ts`、`useTaskPanelListMode.ts`
- [ ] 新 composable 关键路径单测
- [ ] vue-tsc + vitest + 逐块 diff 通过
- [ ] E2E 冒烟：分组折叠/展开、右键菜单、聚焦/标准模式切换
- [ ] 主文件 ≤ 800 行复核

### 8.3 ChatInput（第 2 步）

- [ ] 拆出 `ChatNewTaskConfigBar.vue`、`ChatPendingFileList.vue`、`ChatInputToolbar.vue`、`ChatMobileConfigRow.vue`
- [ ] 抽出 `useQuickCommandPanel.ts`、`useFileReferencePanel.ts`、`useChatDraft.ts`、`usePendingFiles.ts`
- [ ] 新 composable 关键路径单测
- [ ] vue-tsc + vitest + 逐块 diff 通过
- [ ] E2E 冒烟：发送消息、`/` 快捷命令、新任务配置栏切换
- [ ] 主文件 ≤ 800 行复核

### 8.4 session store（第 3 步）

- [ ] 拆出 `stores/session/{types,list,messages,stream,sideTask,subagent,misc}.ts`
- [ ] 主文件仅保留 defineStore 组装与完整 return，导出键集合 diff 一致
- [ ] `session.test.ts` 39 用例全绿且与基线一致
- [ ] 主文件 ≤ 800 行复核

### 8.5 总验证（第 4 步）

- [ ] `vue-tsc --noEmit` 与 `npm run build` 全绿
- [ ] `npx vitest run` 全绿
- [ ] 根目录 Playwright E2E 全套全绿
- [ ] 三个主文件行数复核达标，块级映射表齐全

## 9. 风险与应对

| 风险 | 应对 |
|---|---|
| props/emits 透传链长导致模板绑定遗漏 | 子组件拆分后 vue-tsc 全量检查 + 逐块 diff 模板段；E2E 冒烟覆盖核心交互 |
| composable 内 hook 注册顺序漂移 | 红线 §6.2：hook 在调用原位展开，迁移时逐行比对 |
| store 模块边界切断响应式 | 红线 §6.3：共享 ref 传引用，禁止快照拷贝；39 用例基线兜底 |
| 存量 session.test.ts 在 vitest 下有环境性失败 | 第 0 步先跑通并固定基线；属环境问题的用例原样记录，拆分后结果逐项一致 |
| scoped 样式迁移后穿透行为变化 | 样式只跟随 template 节点移动，选择器/属性值零改动；E2E 可见性断言兜底 |

## 10. 决策记录（与需求方共识）

1. 范围节奏：逐个拆分逐个验证（TaskIndexPanel → ChatInput → session store）。
2. 拆分纯度：纯搬运，零逻辑改动。
3. 拆分手法：子组件为主 + composable 为辅；store 单入口 + 领域模块文件。
4. 验证基线：desktop 引入 vitest 跑通 session.test.ts，关键 composable 补单测。
5. E2E：跑存量 + 为核心交互新增关键冒烟。
6. 目录命名：就近同目录 + 语义化命名，composable 进 `desktop/src/composables/`。
7. 验收：主文件 ≤ 800 行，拆出文件 ≤ 400 行，vue-tsc + 单测 + E2E 全绿。
8. 不做清单：见 §3（不改对外接口、不碰其他文件、不升级依赖、不动后端/admin/安卓、不顺手修 bug、不记 CHANGELOG）。
