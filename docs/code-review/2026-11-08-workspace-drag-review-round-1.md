# 工作区文件跨面板拖拽 代码审查报告（第 1 轮）

- 日期：2026-11-08
- 审查对象：worktree `/Users/yangjiayi/AiProjects/mao/.worktrees/workspace-drag`，分支 `feat/workspace-drag-into-chat`，commit `4c5fa317`（`git diff main..HEAD` 全量待审改动）
- 技术方案：`docs/plan/2026-11-07-workspace-drag-into-chat-technical-design.md`
- 方法：逐文件静态审查 + 每个疑点用探针验证（desktop vitest 探针复用 `useCenterTabs.test.ts` 既有环境；拖拽行为用 Playwright 1.61.1 headless Chromium + CDP `Input.dispatchDragEvent` 驱动真实事件序列，页面逐字复刻组件 handler）。临时探针文件已全部删除，除本报告外未改动/未新增任何仓库文件。

## 结论

发现 **2 个确认 bug**（1 个功能正确性、1 个 UI 状态机），均经探针验证真实存在。方案的其余决策点（双 MIME 单一写入点、capture 拦截时机、目录忽略 D4、FileManagerPanel 零改动、`effectAllowed='copyMove'` 放宽等）实现与方案一致，未发现其他问题（详见文末「已排查并排除的项」）。

---

## Bug 1（中危 · 功能正确性）：从「非当前会话工作区」的文件管理页签拖文件到中心 Tab 栏，丢失 workspaceRoot，打开错误文件的预览

### 涉及位置

- `desktop/src/utils/workspaceDrag.ts:12-19`：`setWorkspaceDragPayload` 载荷只有 `{path, isDirectory}`，`path` 是**相对拖拽源管理器根**的路径，不含来源根信息。
- `desktop/src/views/task/TaskView.vue:384-386`：`handleWorkspaceFileDrop` → `openFileTab(p, p.split('/').pop() || p)`，未传第三参 `workspaceRoot`。
- `desktop/src/composables/useCenterTabs.ts:264-283`：`openFileTab(filePath, title, workspaceRoot?)` 不传 root 时新 Tab 的 `workspaceRoot` 为空。

### 错误链路（源码推演）

1. 会话视图中心区「工作区总览」页签 → 对**另一个**工作区 W2 点「文件管理」，打开 `fm:` 页签：`openWorkspaceFileManagerTab`（`useCenterTabs.ts:430-450`）创建的 Tab 带 `workspaceRoot: W2`，面板 provider 为 W2 根（`CenterTabContainer.vue:128-137` 的 `createOwnedWorkspaceProvider`）。
2. 从该管理器网格/列表拖一个文件：载荷 path 是**相对 W2** 的路径（如 `src/app.ts`）。
3. 落到中心 Tab 栏：`CenterTabBar.vue:142-146` `onBarDrop` → `emit('workspace-file-drop', paths)` → `TaskView.vue:384-386` `openFileTab(p, title)`，不带 root → 新 file Tab `workspaceRoot === undefined`。
4. 展示该 Tab 时 `CenterTabContainer.vue:128-131` `activeProvider`：`if (!root) return props.fileProvider` → 回落**当前会话工作区**的 provider；`FileViewer` 用该 provider 拉内容（`FileViewer.vue:299` `previewFile(props.filePath)`、`:372` `readFile(props.filePath)`）。
5. 结果：预览页签按**会话工作区**解析 `src/app.ts` —— W2 ≠ 会话工作区时显示的是**另一个同名文件**的内容；会话工作区无该相对路径时则加载失败。用户看到的是「错文件」，且无任何提示。

### 预期 vs 实际

- 预期：拖哪个工作区的文件，就打开哪个工作区里那个文件的预览（与页签内**点开文件**的既有行为一致——`CenterTabContainer.vue:145-147` `onOpenFile` 会把 `activeTab.workspaceRoot` 一并 emit，`TaskView.vue:768` 原样传给 `openFileTab`）。
- 实际：新拖拽落点创建的页签不带 root，一律按会话工作区解析。

### 佐证：这是本次改动破坏的既有约束

同一面板的「加入聊天」链路有显式守卫：`CenterTabContainer.vue:140-143` `affectsCurrentSession` —— 「总览打开的目录不是当前会话工作区时，不要改当前会话的文件树和已打开文件」，跨根直接 return。说明「跨根载荷不能落会话侧」是项目既知约束；本次新增的两个落点（Tab 栏 / 输入框）均未做对应处理。

### 可达性

- 文件管理页签激活时 Tab 栏可见（`TaskView.vue:24` `v-if="tabs.length > 1"`，总览页签 + 管理页签 ≥ 2 即满足），拖拽全程不需要切换页签。
- 聊天输入框落点不受此 bug 影响：输入框仅在 chat Tab 激活时渲染（`CenterTabContainer.vue:4`），此时可见拖源只有会话级文件树（TaskInspector 侧栏），路径与解析根一致。

### 验证证据（vitest 探针，复用 `useCenterTabs.test.ts` 的 mock/localStorage 环境，跑完已删）

```
✓ review probe: 跨根管理器拖拽 → Tab 栏落点丢 workspaceRoot
  1) openWorkspaceFileManagerTab 标记 workspaceRoot，而 handleWorkspaceFileDrop
     落点创建的 file Tab 没有 workspaceRoot
     managerTab.workspaceRoot === '/other/root'   ✓（既有管理页签带根）
     fileTab（openFileTab('src/app.ts','app.ts') 创建）.workspaceRoot === undefined ✓（新落点丢根）
  Test Files 1 passed (1)   Tests 1 passed (1)
```

配合上面的源码链（`activeProvider` 回落 + `FileViewer` 经 provider 取内容）即完整成立。

---

## Bug 2（低危 · UI 状态机）：Tab 栏拖拽高亮「经子元素离开」后卡死，`.is-drag-over` 虚线框长期挂在 Tab 栏上

### 涉及位置

- `desktop/src/components/center/CenterTabBar.vue:127-136` `onBarDragOver`：mao 载荷悬停时 `barDragOver.value = true`（dragover 会从子元素 tab-item 冒泡到栏上，常态置位）。
- `desktop/src/components/center/CenterTabBar.vue:138-140` `onBarDragLeave`：仅 `e.target === e.currentTarget` 才复位。

### 触发路径（用户操作序列）

1. 拖工作区文件到中心 Tab 栏，指针悬在任意 **tab-item**（子元素）上 → 虚线高亮出现。
2. 不松手，直接把指针移出 Tab 栏（改拖到聊天输入框 / 中央区 / 按 Esc 取消）→ 松手。
3. Tab 栏的虚线高亮**不清除**，一直挂着；直到下一次任意拖拽悬停 Tab 栏（mao 载荷置 true、非 mao 置 false）才可能被覆写。

### 预期 vs 实际

- 预期：拖拽离开 Tab 栏/拖拽结束后，高亮随之消失。
- 实际：从子元素移出时，浏览器派发的 `dragleave` target 是该子元素（冒泡到栏），`e.target !== e.currentTarget` → 不复位；此后 Tab 栏收不到任何事件——`drop` 发生在别的元素、`dragend` 只派发到拖拽源元素（组件未监听）→ `barDragOver` 恒为 true。
- 可达性：`.center-tab-bar` 是无 padding 的 flex 容器（`CenterTabBar.vue:198-206`），子元素几乎覆盖整栏，「从子元素移出」是离开 Tab 栏的常态路径，非常规边缘。
- 溯源说明：该写法照抄自 `ChatInput.vue:1127-1133` `handleDragLeave`（既有代码，本次未改动，其在 OS 文件拖拽下同样存在卡住态，属既有行为不在此报）；但 Tab 栏这套高亮状态机是本次新增，构成新引入的用户可见缺陷。

### 验证证据（真实 Chromium，Playwright 1.61.1 headless + CDP `Input.dispatchDragEvent` 驱动 dragEnter/dragOver/drop；页面逐字复刻组件的三个 handler、`hasWorkspaceDragPayload` 与 `is-drag-over` 类切换；探针页与脚本在 /tmp，未入仓库）

```
scene1：dragOver 子元素 → 直接 dragOver 移出栏 → drop 在栏外
  afterDragOverChild       barStuck = true   （dragover target=tab-item，payload 命中 → 高亮）
  afterLeaveViaChild       barStuck = true   （dragleave target=tab-item → NOT reset）
  afterDropOutside         barStuck = true   （拖拽已在别处结束，高亮仍挂着 → 卡死）

scene2（对照）：经栏自身区域进入 → 移出 → drop 在栏外
  overBarPadding             barStuck = true
  afterLeaveViaBarPadding    barStuck = false  （dragleave target=bar → reset，正常）
  afterDropOutside           barStuck = false

页面事件日志：
  dragleave target=tab-item  -> NOT reset
  dragleave target=bar       -> reset
  （drop 之后栏上再无任何事件）
```

---

## 已排查并排除的项（本轮核实过、确认不是 bug，供后续轮次参考）

1. **dragover protected mode 与 drop 读数据的分离**：`hasWorkspaceDragPayload`（查 types）用于 dragover、`parseWorkspaceDrag`（读数据）用于 drop，是有意为之，实现正确。方案步骤 5 伪代码在 dragover 里调 `parseWorkspaceDrag` 实际不可行（protected mode 下 getData 恒空串），实现改用 types 判定是对方案的必要修正，且 ChatInput/CenterTabBar 两处落点均如此。
2. **`FileManagerPanel.vue` 零改动**：diff 确认未动，内部移动 / 归组 / 剪贴板 / 上传全部现状；`dropEffect='move'` 两处原样存在（源码级测试锁死）。
3. **TaskIndexPanel / TaskSessionGroupList 会话行拖拽**：未触碰，且其载荷只有 `text/plain`（`TaskIndexPanel.vue:1266-1267`），不含 mao MIME，不会被新落点误判为工作区文件。
4. **目录语义 D4**：目录在两个落点一律忽略——`fileEntriesOf` 过滤、纯目录载荷在输入框被吞（preventDefault + 无动作无提示）、Tab 栏 paths 为空不 emit，均符合方案；dragover 阶段无法区分目录（protected mode）导致的高亮/光标「误报」是方案接受的形态。
5. **FileTreeNode 多选拖拽中目录按文件处理**（`isDirectory` 只对被拖节点生效）：方案步骤 4 与 D4 保守方向明确接受。
6. **`effectAllowed='copyMove'` 对面板内部移动光标的影响**：Grid/List 文件夹行（`:152-153/:164-165`）与面板 body（`onBodyDragOver`）均显式 `dropEffect='move'` 不受影响；**FileTreeNode.onDragOver 只 preventDefault、不设 dropEffect**，实测 Chromium（headless 1.61.1，CDP 驱动，`dragOperationsMask` 16=move / 17=copyMove）在 copyMove 且未设 dropEffect 时默认解析仍为 **move**（`dropEffect-after-dispatch=move`），树内移动光标与改前一致，无回归。
7. **OS 文件 / 编辑器内文本拖入输入框不被 capture 吞掉**：`parseWorkspaceDrag` 空载荷早退放行，bubble `handleDropFiles` 上传链路照常；`stopPropagation`（capture 阶段、祖先元素上）会终止整个派发，ProseMirror 与 bubble handler 均收不到 mao 载荷的 drop，符合方案 D3 意图。
8. **`saveDraft(props.draftKey)` 时序**：`buildCurrentDraft` 直接从 TipTap 实例取 `getHTML()`，循环插入后的内容能完整落草稿；纯目录载荷不落草稿（无插入）符合方案。
9. **新建态（无会话）拖到 Tab 栏**：新建态 tabs 只有 chat 一个，Tab 栏不渲染（`tabs.length > 1`），落点不可达。
10. **`openFileTab` 无 root 的去重**：与 `FileDiffViewer.vue:255/278` 既有调用形态一致，本身不是问题（问题只在 Bug 1 所述的跨根来源）。

---

## 复核记录

- 探针临时文件（`desktop/src/utils/review-probe-crossroot.test.ts`、/tmp 下 drag-probe 页面与脚本）均已删除；`git status` 干净，本报告是唯一新增文件。
- 提交内 `desktop/src/utils/workspaceDrag.test.ts` 全量通过（17/17）。
