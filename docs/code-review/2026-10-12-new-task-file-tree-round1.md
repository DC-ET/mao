# 新建会话文件树提前可见（feat/new-task-file-tree）代码审查 — Round 1

- **日期**：2026-10-12
- **分支 / 提交**：`feat/new-task-file-tree`，`61858fbb`（后端 project 只读端点族）+ `602421fb`（前端新建态文件树提前可见），基线 `main`
- **范围**：仅功能逻辑。`docs/`、`CHANGELOG.md`、`skills/`、`desktop/package*.json`（版本号）不审查。
- **技术方案**：`docs/plan/2026-10-12-new-task-file-tree-technical-design.md`
- **方法**：通读全部改动 + 沿调用链核对（provider 工厂 → TaskView 状态归属 → TaskInspector/FileTree → useCenterTabs/FileViewer/ChatInput → 后端端点与 session 落库）；每个候选 bug 均以可运行测试或确定性代码路径推演验证。测试探针为临时文件，验证后已删除，未改动任何产品代码（工作区当前干净）。
- **基线健康度（实测）**：
  - `backend-ts`：`npx vitest run src/file` → 6 files / 65 tests 全绿（含新增 4 端点用例）。
  - `desktop`：`npx vitest run` → 56 files / 485 tests 全绿；`npm run build`（vue-tsc + vite）通过。
- **结论**：确认 **1 个 bug**（中高，双模式「打开文件」完全不可用）；另有 4 条疑似 / 建议（低危，多为既有行为被本需求放大或瞬时竞态窗口）。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 中高 | desktop/useCenterTabs（被本需求激活） | 新建态（无会话）单击文件调 `openFileTab`，但 `useCenterTabs.getSessionState()` 在无 sessionId 时返回一次性对象，tab 被静默丢弃——「双击/单击打开文件（中央 Tab）」在 LOCAL 与 CLOUD 新建态均无任何反应 |
| S-1 | 低 | desktop/TaskView | 离开真实会话进入新建态的瞬间，`isNewTaskMode` 先于 `enterNewTaskMode` 落值为真，watch 用残留 `projectKey`（独立 CLOUD 会话即会话 id）建 project provider，文件树会闪现一次错误/空内容 |
| S-2 | 低 | desktop/FileTree | 只读态文件树顶部仍渲染「名称」内联新建输入框（无 `canWrite` 门），新建态回车会发起 sessionId=0 的写请求并弹错 |
| S-3 | 低（既有） | backend/workspace-browse | `WorkspaceBrowseService.resolvePath` 用 `resolveLenient`，相对 `../` 与绝对路径可逃逸工作区；新 project-* 端点原样继承（与 workspace-* 口径一致，非本次引入） |
| S-4 | 低 | desktop/TaskInspector | 飞书群 / 独立会话等非项目 slug 的 projectKey 进入新建态时，`showFileTreeTab` 放行但项目目录必不存在，文件树恒显「空目录」 |

---

## BUG-1【中高】新建态打开文件无效：`openFileTab` 在无 sessionId 时被静默丢弃

### 位置

- 触发链（均为既有代码，本需求使其在新建态可达）：
  - `desktop/src/components/file-browser/FileTreeNode.vue:170-181`（`handleClick`，非目录节点 `emit('open-file')`）
  - `desktop/src/components/file-browser/FileTree.vue:705-711`（`handleOpenFile` → `emit('open-file')`）
  - `desktop/src/components/task/TaskInspector.vue:731-733`（透传）
  - `desktop/src/views/task/TaskView.vue:536-538`（`handleOpenFile` → `openFileTab`）
- 根因（未改动文件，本需求的打开文件链路依赖它）：
  - `desktop/src/composables/useCenterTabs.ts:184-193`（`getSessionState`）

### 代码事实

```ts
// useCenterTabs.ts:184-193
function getSessionState(sid?: string): SessionTabState {
  const key = sid ?? currentSessionId.value
  if (!key) return { tabs: [], activeTabId: 'chat' }   // ← 空 key 返回一次性对象，不写入 sessionTabsMap
  let state = sessionTabsMap.value.get(key)
  ...
}
```

新建态下 `enterNewTaskMode` 调 `sessionStore.setActiveSession(null)`（`TaskView.vue:835`），`activeSessionIdRef`（`TaskView.vue:226`）为 `''`，`useCenterTabs` 的 `currentSessionId` 同步为 `''`。于是：

```ts
// useCenterTabs.ts:217-234 openFileTab
const state = getSessionState()      // 一次性空对象
state.tabs.push(newTab)              // 写进一次性对象，随即丢失
state.activeTabId = id
notifyTabsChanged()                  // sid 为 ''，既不落盘也不建 '' 键
```

而 `tabs` / `activeTabId` 两个 computed（`:195-205`）再次调用 `getSessionState()` 拿到**新的**空对象，恒为 `[CHAT_TAB]` / `'chat'`。

### 触发条件

新建态右侧「文件」Tab 已放行后（LOCAL 选了本地目录，或 CLOUD 选了云端项目），单击 / 双击任意文件节点。

### 期望与实际

- **期望**（技术方案 §2.1 目标 1/2、§5.5、§8 手测清单「双击打开（中央 Tab）」）：中央区出现文件页签，`FileViewer` 经 project/local provider 的 `readFile/previewFile` 读取并展示内容；CLOUD 的 PDF 预览同样走此链路。
- **实际**：无任何反应。`tabs` 恒为 `[CHAT_TAB]`，`CenterTabBar`（`TaskView.vue:14` `v-if="tabs.length > 1"`）不渲染，中央区停留在聊天 / 居中 Composer，无报错无提示。
- **影响面**：LOCAL 与 CLOUD 双模式的「打开文件 / PDF 预览」全部不可用；「添加到聊天」「复制相对/绝对路径」「在 Finder 中打开」「目录展开/筛选/搜索」不受影响（已逐条核对可用）。
- **为何此前未暴露**：main 上新建态文件树不可见（`showFileTreeTab` 两条件皆假），`openFileTab` 在无会话态不可达；本需求把树提前后该路径被激活。

### 验证（实测）

临时探针 `desktop/src/composables/tmp-newtask-tabs.test.ts`（已删除），仿 `useCenterTabs.test.ts` 的 mock 式：

```ts
const sessionId = ref<string | null>('')          // 新建态：无 activeSessionId
const tabs = useCenterTabs(sessionId)
await nextTick()
tabs.openFileTab('src/a.txt', 'a.txt')
await nextTick()
// 实测输出：TABS: [{"id":"chat","type":"chat","title":"主会话"}]  ACTIVE: chat
expect(tabs.tabs.value.some(t => t.type === 'file')).toBe(true)      // ← 实测失败（expected false to be true）
expect(tabs.activeTabId.value).toBe('file:src/a.txt')                // ← 实测失败（'chat'）
```

`npx vitest run src/composables/tmp-newtask-tabs.test.ts` → 1 failed，输出即上。对照组：同一文件把 `ref('')` 换成 `ref('42')`（真实会话）后 openFileTab 正常（既有 `useCenterTabs.test.ts` 的 file tab 用例即此形态，全绿）。

### 修复方向（不在本报告实施）

给无会话态一个稳定的 tab state key，例如 `getSessionState` 对空 key 回落固定占位键（`'__new_task__'`），或 TaskView 向 `useCenterTabs` 传入合成 key；同时 `recordActiveTabFor`/`notifyTabsChanged` 已对空 sid 做了跳过，无需额外改动。修复后应补「新建态 openFileTab 后 tabs 含 file 页签」的回归用例（现有 `useCenterTabs.test.ts` 全部用 `SESSION_ID`，无覆盖）。

---

## S-1【低】进入新建态的瞬时窗口用残留 projectKey 建树，闪现错误/空内容

`isNewTaskMode = !sessionIdParam && !initialLoading`（`TaskView.vue:124`）。从真实会话离开时（路由 watcher `TaskView.vue:1123-1128`），`sessionIdParam` 先清空、`initialLoading` 已是 false，`isNewTaskMode` 立即为真；而 `enterNewTaskMode` 要等 `await resolveNewTaskDefaults(...)`（`:808`，无 agentId 时还会 `fetchAgents`）才写 `newTaskCloudProjectKey`。窗口内 watch（`:159-168`）用**残留** `projectKey` 回写：

- 上一个会话是独立 CLOUD 会话时，`loadSession` 写入的 `projectKey = data.projectKey` 即会话 id（`session.service.ts:224-227`：`autoPath = <root>/<uid>/<sessionId>`，`deriveProjectKey` 取尾段）。`showFileTreeTab` 因 `projectKey` 非空而放行，project provider 解析 `<root>/<uid>/projects/<会话id>` 必不存在 → 树闪一次「空目录」，随后 `enterNewTaskMode` 纠正为 `''`、Tab 消失。
- 若上一个新建态选过项目 A、本次路由默认项目 B，窗口内显示 A 的内容后切到 B。

期望：窗口内不显示文件树（或显示加载态）。实际：瞬时错误/过期内容，自愈。严重度低（窗口通常 <1 个 HTTP 往返），但与方案「切换即同步、不闪旧内容」（§2.1 目标 4）的表述有偏差。可在 watch 回调里对「`newTask*` 尚未被本次进入新建态初始化」加 generation 标记，或让路由 watcher 在离开会话时先把 `projectKey` 置空。

---

## S-2【低】只读态文件树顶部仍可唤起「新建」输入框

`FileTree.vue:97-106`（树非空时）与 `:79-88`（空目录时）渲染 `root-create` 输入框，**没有 `canWrite` 门控**；回车走 `commitDraft`（`:381-411`）→ `writeWorkspaceFile(numericSessionId, ...)`，新建态 `numericSessionId = 0`，请求打到 `/v1/files/workspace-write`（sessionId=0）→ `requireOwnedSession` 失败弹错。

- 触发条件：新建态（LOCAL/CLOUD 只读树）在顶部「名称」输入框打字并回车。
- 期望：只读态不出现创建入口（方案 D6「新建态只读树」）。
- 实际：出现入口，提交后报错。
- 说明：该输入框在 main 的真实 LOCAL 会话（`canWrite` 同为 false）就存在，属既有行为；本需求把它带进了新建态。属打磨项，不影响核心链路。建议模板层加 `v-if="canWrite"`。

---

## S-3【低，既有行为被新端点继承】`WorkspaceBrowseService` 允许 `../` 与绝对路径逃逸工作区

`workspace-browse.service.ts:406-416` 的 `resolvePath` 用 `pathSandbox.resolveLenient`，而 `resolveLenient`（`path-sandbox.ts:47-56`）不做 `isUnder` 钳制：相对路径 `path.resolve(root, userPath)`（`../` 会被 normalize），绝对路径直达。实测（临时探针，已删除）：

```
LIST ../..            => ["projects"]        // 列到了工作区父级
READ ../../../secret.txt => "TOP-SECRET"     // 读到工作区外文件
READ <abs>            => "TOP-SECRET"
```

- 与既有 `workspace-*` 端点口径**完全一致**（方案明确「不改 WorkspaceBrowseService」），非本次引入；本次 4 个 project-* 端点原样继承。
- 差异仅在于可达面：project-* 只需合法 `projectKey`（无需会话）。任意已登录用户本就可用自己的会话走 `workspace-read?path=<abs>` 达到同样效果，故未扩大实质攻击面。
- 建议（后续，非本需求必须）：在 `WorkspaceBrowseService.resolvePath` 改走 `resolve`（带 `isUnder` 校验）或对相对路径额外钳制，可一并收敛 workspace-* 与 project-*。

---

## S-4【低】非项目 slug 的 projectKey 进入新建态，文件树恒显「空目录」

`lastViewedSession` 恢复路径（`TaskView.vue:1133-1138`）与显式路由都会把上一个会话的 `cloudProjectKeyForNewTask(data)` 写进 `newTaskCloudProjectKey`。对飞书群会话，`projectKey` 是会话标识（如 `oc_c8757d032af2`，见 `cloud-project.test.ts:158-168`），能通过 `normalizeAndValidate`（字符集合法）但 `<root>/<uid>/projects/oc_...` 不存在 → 新建态「文件」Tab 放行且恒显「空目录」。

- 期望：非项目型工作区不显示文件 Tab（与「临时区不显示」一致）。
- 实际：显示一个永远为空的树。
- 与 D5「不存在项目返空列表」不冲突（那是用户手输新项目名的少数路径），但这里是「从不可能是项目的 key 自动带入」，属展示噪音。可在 `showFileTreeTab` 或 watch 回写时过滤（如要求 projectKey 与已选项目列表命中，或复用 `cloudProjectKeyForNewTask` 的判定）。

---

## 附录 A：核对后确认不构成 bug 的要点

1. **后端 4 端点参数校验 / 错误路径与 workspace-* 一致**：`pattern` 空 / >100 校验、`path` 缺失 PARAM_MISSING、`offset/limit` 默认 0/5000 均逐字对齐；不存在项目返 `{entries: [], truncated: false}`（D5）已实现并与 `project-list` 空目录口径一致。仅 `project-read/search/preview` 先校验 `path/pattern` 再解析 projectKey（workspace-* 先校验会话），缺参时报错码不同，纯 cosmetic。
2. **越权防护**：`resolveUserProjectWorkspace` 走 `normalizeAndValidate`（拒 `..`、保留字 `projects/sessions`、非法字符 / 超长）+ `resolveProjectWorkspace` 内 `assertUnderUserSandbox` 钳制在 `<root>/<userId>` 内；userId 只取 token。spec 覆盖缺参 / `..` / `projects` / 不存在项目 / 跨用户（`x-test-user: 8` 看用户 7 的 demo 返空）——断言真实有效（实测通过）。
3. **spec 覆盖度**：happy path（directory/read/search/preview 200）+ 参数 + 越权均覆盖；未覆盖 offset/limit 透参与 preview 响应体，属测试深度而非正确性问题。
4. **provider 分支序**：四格（CLOUD+sessionId / CLOUD+projectKey / LOCAL+workspace / 全空）与方案表一致，单测实测通过；「CLOUD 无会话但 workspace 有值」由 local 改 null 是方案声明的修正（原行为把服务端路径当本地路径读，本就是错的）。真实会话两条路径恒等。
5. **CLOUD 真实会话行为恒等**：`showFileTreeTab` 在真实会话下 `sessionId` 恒非空（含边路 / 子代理视图，`inspectorSessionId` 对占位边路 Tab 回落主会话 id），放行条件不改变结果；`canDownload`（真实会话 cloud provider 有 `downloadFile`）与 `canCopyAbsolute`（真实会话 `workspace` 非空）显隐与改动前一致；`gitProvider` 仍要求 sessionId，新建态为 null，Git Tab 不会误出。
6. **syncChatState 守卫**：新建态 ChatPanel 上报的是 useChat 占位空串，守卫后只有 watch 一个写者；首发建会话后 `isNewTaskMode` 转假、`loadSession` 与 ChatPanel 上报同源同值，无双写抢；从真实会话进新建态时 ChatPanel 的 `newSession()` 复位也被守卫挡住，不会擦掉用户刚选的工作区。
7. **两个关键时序**：① 真实会话 → 新建态：watch 在 `isNewTaskMode` 置真瞬间用残留值写一次（见 S-1），随后 `enterNewTaskMode` / `lastViewedSession` 恢复纠正，无持久错值；② 新建态首发 → 真实会话：`createSession` 后 `activeSessionIdRef` 先落地（provider 切 cloud），`router.replace` 与 `loadSession` 随后纠正 `workspace/projectKey`，`syncChatState` 在路由未更新的窗口被守卫跳过但由 `loadSession` 补写，无残留旧值。
8. **添加到聊天（无会话态可用）**：`FileTree.handleAddToChat` → `TaskInspector` → `TaskView.handleAddFileToChat`（`:212-223`）取 `activeTabId='chat'` → 新建态居中 Composer 的 ChatInput 以 `registerKey:'chat'` 注册（`ChatInput.vue:210/1200`），`insertFileReference` 未被 `disabled` 拦截（ChatPanel 不传 disabled）；`@{rel}@` 发送时 `resolveFileRefPaths` 用建会话后的 `workspace`（= 同一 `resolveProjectWorkspace` 结果）转绝对路径，与文件树同根，引用可达。
9. **中央 Tab 文件管理器（10-12 方案）不受影响**：本分支未合入管理器入口；`createProjectProvider` 为其预留但无调用点。
10. **无新增内置工具 / LLM 场景 / 契约枚举 / DDL / 依赖**：`tool-result-summarizer.ts`、`toolDisplay.ts`、`usage.ts` 等无需同改；`useWorkspaceFileProvider` 仅 TaskView 一个调用点（grep 实测），签名改动无漏网；`desktop npm run build`（vue-tsc）通过。
11. **临时区 / git 克隆模式**：`newTaskCloudProjectKey` 被清空 → `projectKey` 空 → provider null → Tab 不显示，符合 D5/非目标。
12. **刷新恢复**：`?newTask=1&cloudProjectKey=...` 走 `enterNewTaskMode(getRouteNewTaskDefaults())` → watch 回写 → 树重现（代码路径核对）。

## 附录 B：复现用探针（验证后已删除，未留在仓库）

- `desktop/src/composables/tmp-newtask-tabs.test.ts`：BUG-1 证据（无 sessionId 时 `openFileTab` 后 tabs 仅含 chat）。
- `backend-ts/src/file/tmp-traversal.test.ts`：S-3 证据（`listDirectory(ws,'../..')` 列到父级、`readFile(ws,'../../../secret.txt')` 读到工作区外文件）。

两文件均在跑出上述输出后删除；`git status` 干净，产品代码零改动。
