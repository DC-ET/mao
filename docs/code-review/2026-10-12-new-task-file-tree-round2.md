# 新建会话文件树提前可见（feat/new-task-file-tree）代码审查 — Round 2

- **日期**：2026-10-12
- **分支 / 提交**：`feat/new-task-file-tree`，`61858fbb`（后端 project 只读端点族）+ `602421fb`（前端新建态文件树提前可见）+ `7e0911c6`（Round 1 修复），基线 `main`
- **范围**：仅功能逻辑。`docs/`、`CHANGELOG.md`、`skills/`、`desktop/package*.json`（版本号）不审查。
- **技术方案**：`docs/plan/2026-10-12-new-task-file-tree-technical-design.md`
- **方法**：通读 `7e0911c6` 全量 diff + 沿调用链核对（`getSessionState` 占位键 → `openFileTab`/`notifyTabsChanged` → `CenterTabContainer`/`ChatPanel` 渲染链 → `enterNewTaskMode`/`loadSession`/`createSession` 的会话 id 迁移）；重点专项核对「占位键 / 模块级单例在多组件、刷新、登出场景下的状态残留」。每个候选 bug 均以可运行测试或确定性代码路径推演验证。测试探针为临时文件，验证后已删除，未改动任何产品代码（`git status` 干净）。
- **基线健康度（实测）**：
  - `desktop`：`npx vitest run` → 56 files / 488 tests 全绿（含 `7e0911c6` 新增 3 例新建态回归）；`npm run build`（`vue-tsc -b && vite build`）通过。
  - `backend-ts`：`7e0911c6` 零后端改动；`npx vitest run src/file` → 6 files / 65 tests 全绿（含 `61858fbb` 新增 4 端点用例，代码自 Round 1 后未变更）。
- **结论**：确认 **1 个 bug**（中，占位键方案引入，Round 1 未覆盖）；另有 1 条疑似 / 建议（低危、当前不可达的潜伏项）。Round 1 的 BUG-1 / S-1 / S-2 已修复，S-3 / S-4 按方案约定未改（S-4 经复核无反例，见附录 A.5）。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-2 | 中 | desktop/useCenterTabs（占位键方案引入） | 占位键 `__new_task__` 的状态在「新建态 → 会话落地 → 再进新建态」之间原样复用，重进新建态时复活上次新建态留下的文件页签并保持激活：中央区停在陈旧 `FileViewer`、新建态居中 Composer 被顶掉；若两次新建态选了不同工作区，还会用新 provider 读旧路径报错 |
| S-5 | 低（潜伏，当前不可达） | desktop/useCenterTabs | `getSessionState('')` 显式传空串仍回落不到占位键（`'' ?? x` 不触发兜底），`openTraceTab` 无 `stateKeySid` 时在新建态依旧写丢；目前所有调用方都有前置守卫，属防御性一致性缺口 |

---

## BUG-2【中】占位键状态跨「新建态 ↔ 会话」复用，重进新建态复活陈旧文件页签、顶掉居中 Composer

### 位置

- 根因（`7e0911c6` 引入）：
  - `desktop/src/composables/useCenterTabs.ts:20`（`sessionTabsMap` 模块级单例，占位条目**没有任何清除路径**）
  - `desktop/src/composables/useCenterTabs.ts:194-202`（`getSessionState` 对空 key 回落固定占位键）
- 复活链路（既有代码，被占位键方案激活）：
  - `desktop/src/views/task/TaskView.vue:839`（`enterNewTaskMode` 内 `setActiveSession(null)`）或 `:1128`（离开真实会话的路由 watcher 内 `setActiveSession(null)`）
  - → `TaskView.vue:226` `activeSessionIdRef` 为 `''` → `useCenterTabs.ts:181-186` watch 同步 `currentSessionId = ''` → `getSessionState()` 命中 `__new_task__`
- 用户可见后果：
  - `desktop/src/components/center/CenterTabContainer.vue:4`（`<ChatPanel v-if="activeTabId === 'chat'" />`，否则走 `v-else-if` 的 `FileViewer`）
  - `desktop/src/components/chat/ChatPanel.vue:308`（`showCenterComposer = isNewTaskMode && !historyLoading`，Composer 在 ChatPanel 内）→ ChatPanel 不挂载则 Composer 消失

### 代码事实

```ts
// useCenterTabs.ts:194-202（7e0911c6 后）
function getSessionState(sid?: string): SessionTabState {
  const key = sid ?? (currentSessionId.value || NEW_TASK_TABS_KEY)
  let state = sessionTabsMap.value.get(key)
  if (!state) { state = { tabs: [], activeTabId: 'chat' }; sessionTabsMap.value.set(key, state) }
  return state
}
```

占位状态写入 `sessionTabsMap` 后**只增不删**：全仓对 `sessionTabsMap` 的清除只有 `resetCenterTabs()`（登出 / 401，`stores/auth.ts:75-76`）与 `removeSessionTabsFor(sid)`（删会话，只按真实 sid）。`enterNewTaskMode` / 路由 watcher 都不清它。于是同一进程内，所有「无会话态」共用同一份 `tabs` + `activeTabId`：

```ts
// useCenterTabs.ts:204-216（tabs / activeTabId 均取自 getSessionState()）
const tabs = computed<Tab[]>(() => { const state = getSessionState(); return [CHAT_TAB, ...state.tabs] })
const activeTabId = computed({ get: () => getSessionState().activeTabId || 'chat', ... })
```

`7e0911c6` 自带的第 3 例回归只覆盖了单向「会话落地后占位让位」（`sessionId` 从 `''` → `'42'` 时回 chat），**没有覆盖反向**（`'42'` → `''`）。

### 触发条件（两条等价路径）

1. **首发消息后重进新建态**：新建态从文件树打开文件（`FileTreeNode` → `FileTree.vue:705` → `TaskInspector.vue:731` → `TaskView.vue:536` `openFileTab`）→ 发首条消息，`useChat.ts:424` `setActiveSession(sessionData.id)` 落地 → 之后任意入口重进新建态（左栏「新建任务」/ `/task/new` 路由）。
2. **切换会话后重进新建态**：新建态打开文件 → 点左栏任一会话（`loadSession`，`TaskView.vue:906`）→ 再点「新建任务」。

更短的变体（不离开新建态）：新建态打开文件后**直接改工作区选择**（LOCAL 换目录 / CLOUD 换项目）→ 页签仍在且保持激活，`FileViewer.vue:266` 的 `watch(() => [props.filePath, props.provider])` 会用**新 workspace 的 provider 读旧工作区的路径**。

### 期望与实际

- **期望**：进入新建态 = 一张干净的工作台：中央区是居中 Composer（`showCenterComposer`），右侧文件树对应当前选中的工作区；占位状态随「离开新建态」作废（方案注释自称「会话落地后 currentSessionId 切到真实 id 即让位」——只说明了让位，没说明复活）。
- **实际**：重进新建态后 `activeTabId` 是上次的 `file:<旧路径>`：
  - Tab 条（`CenterTabBar`，`tabs.length > 1` 即渲染）多出一个上次新建态的文件页签；
  - 中央区渲染 `FileViewer` 而非 `ChatPanel`，**新建态唯一输入框（居中 Composer）不渲染**，用户看不到打字入口，须手动点「主会话」Tab 才能恢复；
  - 若两次新建态选了不同工作区，该页签用新 provider 读旧路径 → 报错视图（`FileViewer` `state='error'`），用户看到的是与当前工作区无关的错内容。
- **影响面**：LOCAL 与 CLOUD 双模式均可达；「打开文件」正是本需求的主推功能（方案 §8 手测清单），走到「预览完再回来新建」非常顺滑，故可达性高。数据不丢、可自行恢复，故定级「中」而非「中高」。

### 验证（实测）

临时探针 `desktop/src/composables/tmp-round2-probes.test.ts`（已删除），仿 `useCenterTabs.test.ts` 的 mock 式，完整还原路径 1 的会话 id 迁移：

```ts
const sessionId = ref<string | null>('')        // 新建态
const tabs = useCenterTabs(sessionId)
await nextTick()
tabs.openFileTab('/ws/a.ts', 'a.ts')            // 新建态预览文件
await nextTick()
expect(tabs.activeTabId.value).toBe('file:/ws/a.ts')   // ✓ 修复后新建态可开文件

sessionId.value = '42'                          // 首发建会话，activeSessionId 落地
await nextTick()
expect(tabs.activeTabId.value).toBe('chat')     // ✓ 占位让位（7e0911c6 回归已覆盖）

sessionId.value = ''                            // 用户再次点击「新建任务」
await nextTick()
// 实测输出：
//   PROBE A tabs:   [{"id":"chat","type":"chat"},{"id":"file:/ws/a.ts","type":"file"}]
//   PROBE A active: file:/ws/a.ts
expect(tabs.activeTabId.value).toBe('chat')     // ← 实测失败：复活了上次新建态的文件页签
```

`npx vitest run src/composables/tmp-round2-probes.test.ts` → PROBE A failed（`expected 'file:/ws/a.ts' to be 'chat'`），输出即上。对照组 PROBE C（`useCenterTabs` 双实例共享占位状态，多组件读写一致）通过，说明这是单例状态的**生命周期**问题而非**可见性**问题。

渲染后果为确定性代码路径：`activeTabId !== 'chat'` → `CenterTabContainer.vue:4` 的 `v-if` 不成立 → 落到 `:5-10` 的 `FileViewer` → `ChatPanel.vue:308` 的 `showCenterComposer` 所在组件整体不挂载。

### 修复方向（不在本报告实施）

任选其一，均无需改产品行为语义：

1. **进入新建态时作废占位状态**（推荐）：在 `useCenterTabs` 导出 `resetNewTaskTabs()`（内部 `sessionTabsMap.value.delete(NEW_TASK_TABS_KEY)` + 替换 Map 引用），由 `TaskView.enterNewTaskMode` 在首个 await 前调用——与 S-1 的「同步复位」同一时机，语义一致。
2. **按工作区隔离占位键**：`getSessionState` 的兜底 key 拼上当前 `workspace`/`projectKey`（如 `__new_task__:<key>`），换工作区即换状态；改动面稍大且需处理 key 拼接的时机。
3. **只复位激活态**：进入新建态时把占位 `activeTabId` 强制回 `'chat'`（页签保留但不激活）。最小改动，但 Tab 条仍留陈旧页签，且切工作区后的报错页签仍在。

修复后应补回归：「新建态开文件 → 会话落地 → 再进新建态，`activeTabId` 为 `chat` 且 `tabs` 不含 file」（现有 3 例回归均只覆盖单向让位）。

---

## S-5【低，潜伏】`getSessionState('')` 显式空串仍拿不到占位键

`7e0911c6` 的兜底写作 `sid ?? (currentSessionId.value || NEW_TASK_TABS_KEY)`：`??` 只在 `sid` 为 `null`/`undefined` 时触发，**显式传 `''` 不会兜底**，`key` 就是 `''`，仍旧走改前的一次性对象路径（写入丢失）。

```ts
// useCenterTabs.ts:333-336 openTraceTab
const key = opts?.stateKeySid ?? currentSessionId.value   // 新建态 = ''
const state = getSessionState(key)                        // getSessionState('') → key '' → 一次性对象
```

实测（同一探针 PROBE B）：新建态调 `openTraceTab()` 后 `tabs` 仅 `[chat]`，轨迹 Tab 不出现；随后 `openFileTab` 正常落占位键——证明 `''` 键写入确实被丢弃。

- **当前不可达**：`openTraceTab` 的唯一调用方 `TaskView.handleOpenTrace`（`:597-605`）有 `if (!key) return` 前置守卫，`TaskInspector.vue:492` 的 `showTraceEntry = !!props.sessionId` 也保证入口不出现；`restoreActiveTab` / `restoreSideTaskTabs` / `restoreSubagentTabs` / `restoreTraceTab` 均以 `if (!sid) return` 开头。
- **为何仍记一条**：注释写明「两者皆空（新建态）回落占位键」，实现只覆盖了 `undefined` 一支；后续任何新入口若显式传 `''`（例如从 `activeSessionIdRef.value` 取值传入），会静默复现 Round 1 BUG-1 的「打开无反应」且无任何报错。建议把兜底改成 `sid || currentSessionId.value || NEW_TASK_TABS_KEY`（注意这会改变「显式传空串」的语义，需确认无调用方依赖「传空串=一次性对象」的旧行为——目前没有）。

---

## 附录 A：核对后确认不构成 bug 的要点

### A.1 Round 1 问题修复复核

1. **BUG-1 已修**：`getSessionState` 占位键回落使 `openFileTab` 落到稳定状态；`7e0911c6` 补的 3 例回归（无 sessionId 开文件落稳定状态 / 不写 localStorage / 会话落地后让位）实测通过，且 `npx vitest run` 全量 488 例无回归。
2. **S-1 已修**：`enterNewTaskMode`（`TaskView.vue:806-807`）在首个 await 前按 `earlyMode` 同步复位 `newTaskWorkspace` / `newTaskCloudProjectKey`，回写 watch 窗口内拿到的是复位值而非上一草案残留。
3. **S-2 已加防御性兜底**：`FileTree.vue` 根目录新建输入框两处渲染均补 `canWrite` 门控（只读态不可达），属收窄渲染、无行为回归。
4. **S-3 未改**：按「不改 WorkspaceBrowseService」的方案约定保持原样（既有行为，非本次引入，详见 Round 1 报告 S-3）。
5. **S-4 未改，且经复核无反例**（详见 A.5）。

### A.2 「提前复位」无回归

`resolveNewTaskDefaults`（`TaskView.vue`）只读 `defaults` 与 `agentStore`，**不读** `newTaskWorkspace` / `newTaskCloudProjectKey`，提前复位不会清掉它要消费的值。对无默认值调用方（`enterNewTaskMode()` 无参）：改前 `newTaskWorkspace` 在 await 后才被置为 `resolved.workspace || ''`（即 `''`），改后立即置 `''`——终态一致，仅时机提前。瞬时窗口内 `newTaskWorkspaceMode` 可能仍是 `'git'` 而 `cloudProjectKey` 已空，但该字段本来也要等 await 后才复位（`:820`），且 `resolveNewTaskDefaults` 在常见路径（defaults 带 agentId 或 agents 已加载）不 await，无渲染窗口。不构成问题。

### A.3 模块级单例残留专项（本轮重点关注）

| 场景 | 结论 | 依据 |
| --- | --- | --- |
| 多组件（TaskView + FileViewer 各持一个 `useCenterTabs` 实例） | 无残留、读写一致 | 双实例共享同一模块级 `sessionTabsMap` 与 `currentSessionId`；实测 PROBE C：实例 A `openFileTab` 后实例 B 的 `tabs` 立即含该 file 页签 |
| 刷新（F5 / 冷启动） | 无跨刷新残留 | `recordActiveTabFor:128` 对占位键直接 return，`notifyTabsChanged:107-114` 对空 sid 跳过落盘——占位键永不写 localStorage（`7e0911c6` 回归 2 实测 `mao:center-active-tab:` 键为空）；刷新后内存态丢失、回 chat。副作用是新建态开的文件页签刷新即消失，属方案声明的「只在本进程生命周期内有效」，非 bug |
| 登出 / 401 强制下线 | 无跨账号残留 | `stores/auth.ts:75-76` `clearLocalSession` → `resetCenterTabs()` 清空整表（含占位键）并复位 `currentSessionId` |
| 删除会话 | 不波及占位键 | `removeSessionTabsFor` 只按真实 sid 删除；占位键不含用户维度且不落盘，无跨账号 ID 碰撞风险（与 `side_task` / 审批队列那类按 sid 记账的模块级状态不同） |
| 同进程内「新建态 → 会话 → 新建态」 | **有残留 = BUG-2** | 占位条目无清除路径，`sessionTabsMap` 只增不删 |

即：本轮重点问的「多组件 / 刷新 / 登出」三个方向均干净，唯一的残留面正是 BUG-2（同进程内的状态复用）。

### A.4 其余既有链路无回归

- `useWorkspaceFileProvider` 四格分支序、`TaskInspector.showFileTreeTab` 放行条件、`canDownload` / `canCopyAbsolute` 显隐、`FileTree` 右键菜单（`7e0911c6` 只对 `canWrite` 门控做收窄）：Round 1 已逐条核对，本轮 diff 未触及，无变化。
- 「添加到聊天」无会话态可用性、`syncChatState` 写归属、两个关键时序（真实会话↔新建态、新建态首发→真实会话）：Round 1 已核；`7e0911c6` 的提前复位只影响写入门时间，不改变写归属（watch 仍是 `newTask*` 的唯一写者），无新竞态。

### A.5 S-4 无反例（回应「若你认为此判断有问题请具体指出反例」）

复核后**认同「不改」的判断，未找到反例**。理由：

1. **空目录是真实预览而非假象**：`initializeCloudWorkspace`（`backend-ts/src/session/session.service.ts`）在会话落库时确实以 `resolveProjectWorkspace(<root>, uid, slug)` 创建 `<root>/<uid>/projects/<key>` 并作为该会话工作区——新建态看到的「空目录」就是发送后即将使用的同一目录（同一解析函数、同一钳制），预览与服务端行为一致。
2. **飞书群 / 通道类 key 同样会落成真实目录**：这类会话的 `projectKey`（如 `oc_xxx` / `feishu-xxx-private-xxx`）能通过 `normalizeAndValidate`（字符集合法、非保留字），发送时同样走 `initializeCloudWorkspace` 建出 `<root>/<uid>/projects/oc_xxx`——所以「恒显空目录」并不是「永远不存在的目录」，而是「发送后才被创建的目录」的真实提前预览。
3. **隐藏 Tab 反而引入新的不一致**：若按 Round 1 S-4 建议对非项目型 key 隐藏文件 Tab，用户会看到「发送前没有文件 Tab、发送后（同一会话）突然出现」的跳变；且「发送后出现的那棵树」与「发送前本可预览的那棵树」是同一棵，隐藏让预览能力白白丢失。
4. 代价仅是「一个当前为空的树」这一展示噪音，且用户手输新项目名时（D5）本就是同一口径，行为自洽。

综上：S-4 维持不改是合理的；已把该取舍写入方案 5.6 亦足够。

### A.6 后端未受本轮修复影响

`7e0911c6` 的后端改动为零（`git show --stat` 实证）；`61858fbb` 的 4 个 project-* 端点与 spec 自 Round 1 后无变更，本轮复跑 `npx vitest run src/file` → 6 files / 65 tests 全绿，Round 1 已实测其参数校验 / 越权 / spec 断言有效。

---

## 附录 B：复现用探针（验证后已删除，未留在仓库）

- `desktop/src/composables/tmp-round2-probes.test.ts`：
  - PROBE A：BUG-2 证据（`''` → `'42'` → `''` 后 `activeTabId` 复活为 `file:/ws/a.ts`，`tabs` 含陈旧 file 页签）。
  - PROBE B：S-5 证据（新建态 `openTraceTab()` 后 `tabs` 仅 `[chat]`，写入被 `''` 键丢弃）。
  - PROBE C：反证（双实例共享占位状态，排除可见性问题）。

文件在跑出上述输出后删除；`git status` 干净，产品代码零改动。全量回归：`desktop` 56 files / 488 tests 全绿，`npm run build` 通过。
