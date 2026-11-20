# 标准模式组内排序纳入「任务树活跃」技术方案

- 状态：已评审并实施（2026-11-16；决策经用户确认：D1 单档、D2 待回答同档纳入）
- 日期：2026-11-16
- 关联方案：
  - [../2026-08/2026-08-09-task-archive-and-focus-mode-technical-design.md](../2026-08/2026-08-09-task-archive-and-focus-mode-technical-design.md)（归档 / 聚焦模式与 tree\* 聚合信号总设计；本方案把其「任务树聚合」口径补齐到**标准模式组内排序**，聚焦模式自身规则零改动）

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 主任务 | 侧栏列表行对应的会话（不含 SIDE_TASK / SUBAGENT 来源），即任务树树根 |
| 边路任务 | 主任务派生的子会话（`getSideTasks(parentId)`，`stores/session/types.ts:103-123` `SideTaskItem`） |
| 任务树 | 主任务 + 其全部后代边路任务 |
| `tree*` 聚合信号 | 服务端下发的整树聚合字段：`treeRunning` / `treeFailed` / `treePendingApprovalCount` / `treePendingQuestionCount` / `treeUnread`（`session-vo.ts:717-743` `fillTreeSignals`） |
| 任务树活跃 | 本方案定义的排序第一档：主任务自身或边路任务处于活跃相位，或整树有待审批 / 待回答（§5.1） |
| 标准模式 | 侧栏默认的分组列表（`TaskSessionGroupList`）；聚焦模式为铃铛切换的平铺优先级列表（`TaskFocusList`），本方案不改 |

## 1. 问题与证据

### 1.1 现状：组内排序只认主任务自身相位

标准模式组内排序在 `TaskIndexPanel.vue:1013-1021`，三级比较：

1. `session.running`（主任务自身）优先；
2. `updatedAt`（缺省 `createdAt`）倒序；
3. id 倒序。

其中 `running` 只由**主任务自己的 phase** 推导：`ACTIVE_PHASES.has(phase)`（`stores/session/list.ts:290, 641`，`ACTIVE_PHASES = {RUNNING, RESUMING, WAITING_APPROVAL, CANCELLING}`，`types.ts:8`）。边路任务既不进 `running`，也不进 `updatedAt`（后端只在该会话自身插入消息时刷新 `updatedAt`，`session.service.ts:1185-1188`）。

### 1.2 后果

- 主任务自身已 `COMPLETED`、但边路任务在跑 / 有待审批时，该行停在按自身 `updatedAt` 的位置（通常沉底），**不会因为边路活动被顶上来**；
- 边路状态只体现在行内展示：圆点颜色（`TaskIndexPanel.vue:1050-1060` `effectivePhaseClass` 会看边路待审批 / 失败 / 运行中）与行尾转圈（`TaskSessionGroupList.vue:148` `session.running || session.treeRunning || hasActiveSideTask(...)`）。用户要判断「哪条在等我」，仍需逐行扫圆点；
- 与聚焦模式口径分裂：聚焦排序 `focusPriority`（`utils/focusSort.ts:24-31`）已把 `treeRunning` / `treeFailed` / `treePending*`（含边路）纳入优先级 0/1/2 档，标准模式没有。

### 1.3 数据已具备，无需后端改动

- `tree*` 字段已随标准分组列表下发：`enrichSessions` → `applySessionListSignals`（`session.routes.ts:199-206`），侧栏首屏 `/sessions/groups` 与「展开更多」都走这条增强链路；
- 实时性已有通道：WS `session_tree_status` 事件经 `updateSessionTreeSignals`（`stores/session/list.ts:301-321`）更新**会话实体**的 `tree*` 字段，而 `sessions` 投影是实体之上的只读 computed（`list.ts:51-55`）——标准模式与聚焦模式共享同一实体源，树信号到达即两种模式都可见；
- 前端现成的三源并集判定函数：`hasActiveSideTask` / `hasPendingApproval` / `hasPendingQuestion`（`TaskIndexPanel.vue:1030-1038, 1237-1261`）= 服务端聚合（`tree*` / 边路 VO 计数）+ 实时 Map（`sessionPendingApprovals` / `sessionPendingQuestions`）+ 边路任务缓存，正是圆点 / 转圈 / tooltip 的现行口径。

**结论：纯 desktop 前端改动即可，零后端 / 零契约 / 零迁移。**

## 2. 目标与非目标

**目标（本期全部交付）**

1. 标准模式组内排序第一档从「主任务自身运行中」扩容为「任务树活跃」（自身 + 边路：活跃相位或待审批 / 待回答）；
2. 判定口径与现有圆点 / 转圈**完全同源**（复用同一批函数，不重算），避免「排序说空闲、圆点说在跑」的分裂；
3. 实时生效：WS 树信号 / 边路事件到达实体后即时重排，无需手动刷新；
4. 纯前端改动，零后端 / 契约 / 迁移；既有「自身 running 优先 + `updatedAt` 倒序」行为不回退（自身 running 是任务树活跃的子集，第一档严格扩容）。

**非目标**：见 §9 不做清单。

## 3. 方案总览

| 层 | 改动 |
|---|---|
| desktop `TaskIndexPanel.vue` | `groupedSessions` 组内 comparator 第一档由 `a.running` 换成「任务树活跃」预计算集合；一次预计算，comparator 内只做 Set 查询 |
| desktop `utils/`（新增） | 纯排序函数 `sortSessionsInGroup(sessions, treeActiveIds)`：档位 → `updatedAt/createdAt` DESC → id DESC，供单测 |
| desktop 测试 | `task-panel-logic.test.ts` 补纯排序用例；`task-index-panel-interaction.test.ts`（jsdom 挂载）补端到端用例（§6） |
| 后端 / 契约 / DB | **零改动**（§1.3） |
| 文档 / changelog | 随实施任务新增碎片（§10） |

不改动：聚焦模式排序、已归档区排序、组间顺序（`sortGroups` 自定义 + 固定 key 规则）、右侧边路列表（`SubagentList` / `SideTaskList`）自身排序、`onGroupNewTask` 之外的分组操作。

## 4. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 单档「任务树活跃」，不復刻聚焦模式四档（待审批 > 失败 > 运行中 > 未读） | 述求是「顶上来」，单档最小且可预期；同档内维持 `updatedAt` desc 的既有手感。若后续要「待审批压过运行中」，按 §5.2 的档位函数扩一个常量即可，不改结构 |
| D2 | 待回答与待审批同档纳入 | 两者都阻塞任务树，且圆点已同权展示（`hasPendingApproval` / `hasPendingQuestion` 都置顶替换圆点）；只升审批不升提问会造成口径分裂 |
| D3 | 判定复用面板内 `hasActiveSideTask` / `hasPendingApproval` / `hasPendingQuestion`，不在 util 重算 | 这三个函数已是「服务端 tree 聚合 + 实时 Map + 边路缓存」三源并集的现行口径，圆点 / 转圈 / 分组 tooltip 都用它；另写一份必然漂移。util 只承载纯排序 |
| D4 | `treeRunning === false` 时不信边路缓存里的活跃相位 | 服务端明确判定整树无活跃相位；与 `hasActiveSideTask`（`TaskIndexPanel.vue:1030-1034`）、`effectivePhaseClass`（`1055-1058`）现有守卫同口径。`WAITING_APPROVAL` 本身属活跃相位，`treeRunning=false` 与待审批自相矛盾，故该守卫不会误抑制待审批 / 待回答（后端 `fillTreeSignals` 结构上保证） |
| D5 | 预计算活跃 id 集合（一次 O(n)），comparator 内只做 Set 查询 | comparator 执行 O(n log n) 次，谓词含 Map 查询与边路遍历；组内已加载窗口 ≤ 5（默认）/ 展开 +20，总量小，但预计算仍是最直白的形式 |
| D6 | 顺手修正 `onGroupNewTask` 的 `sessions[0]` 兜底 | 该函数注释假设「组内已按 updatedAt desc」（`TaskIndexPanel.vue:939`），提升后 `sessions[0]` 可能是活跃但陈旧的会话；兜底改为显式取组内 `updatedAt` 最大者，避免新建任务继承到陈旧会话的模型 / 工作区 |

## 5. 详细设计

### 5.1 判定口径（面板内，D3）

```ts
/** 任务树活跃：主任务自身或边路任务处于活跃相位，或整树有待审批 / 待回答。
 *  与圆点 / 转圈同源：服务端 tree* 聚合 + 实时 Map + 边路缓存三源并集。 */
function isTreeActive(session: Session): boolean {
  if (session.running) return true                                   // 主任务自身活跃（原第一档，保持）
  if (session.treeRunning === true) return true                      // 服务端聚合：树内有活跃相位
  if (session.treeRunning !== false && hasActiveSideTask(session.id)) return true  // 边路缓存兜底；服务端已否定则不信（D4）
  return hasPendingApproval(session.id) || hasPendingQuestion(session.id)          // 待审批 / 待回答（D2）
}
```

与现行展示口径的对应关系（零漂移保证）：

| 展示 | 现行函数 | `isTreeActive` 覆盖 |
|---|---|---|
| 圆点 `running`（`effectivePhaseClass`） | `session.running \|\| treeRunning \|\| 边路活跃` | 同左 |
| 圆点 `waiting`（有待审批 / 待回答） | `hasPendingApproval \|\| hasPendingQuestion` | 同左 |
| 行尾转圈 | `session.running \|\| treeRunning \|\| hasActiveSideTask` | 同左 |

### 5.2 组内排序（comparator + util）

`TaskIndexPanel.vue` `groupedSessions` 内：

```ts
// 一次预计算：整棵标准列表的任务树活跃集合（D5）
const treeActiveIds = new Set<string>()
for (const s of sessions) {
  if (isTreeActive(s)) treeActiveIds.add(String(s.id))
}
// ...各分组内：
sessions: sortSessionsInGroup(groupSessions, treeActiveIds)
```

新增 `desktop/src/utils/taskGroupSort.ts`（纯函数，无 store 依赖）：

```ts
import type { Session } from '../stores/session'

/** 组内排序：任务树活跃（自身 / 边路）优先 → updatedAt(缺省 createdAt) DESC → id DESC。
 *  活跃集合由调用方按 §5.1 口径预计算后传入，comparator 内只做 Set 查询。 */
export function sortSessionsInGroup(
  sessions: readonly Session[],
  treeActiveIds: ReadonlySet<string>,
): Session[] {
  return [...sessions].sort((a, b) => {
    const aa = treeActiveIds.has(String(a.id))
    const ba = treeActiveIds.has(String(b.id))
    if (aa !== ba) return aa ? -1 : 1
    const tb = new Date(b.updatedAt || b.createdAt || 0).getTime()
    const ta = new Date(a.updatedAt || a.createdAt || 0).getTime()
    if (tb !== ta) return tb - ta
    // updated_at 相同时按 id 倒序，避免批量更新导致按创建正序排列（原注释保留）
    return Number(b.id) - Number(a.id)
  })
}
```

档位扩展点（D1 备选）：若后续要「待审批 / 待回答压过运行中」，把入参从 `ReadonlySet<string>` 换成一档位 `Map<string, number>`（0=待处理、1=活跃），comparator 先比档位——结构不变。

### 5.3 实时性链路

```
边路任务启动 / 审批到达（WS session_tree_status 或边路事件）
  → updateSessionTreeSignals(parentId, signals)     list.ts:301-321（写实体 tree*）
  → sessions 投影（实体只读 computed）               list.ts:51-55
  → groupedSessions computed 重算（§5.2）
  → 组内行序即时更新
```

边路缓存路径（`getSideTasks`）作为断线期兜底：重连后 side-tasks 端点刷新进缓存，`hasActiveSideTask` 生效；两条路径都与圆点 / 转圈同一时刻生效，不会出现「圆点在转但排序没动」的中间态差异超过展示本身。

### 5.4 `onGroupNewTask` 兜底修正（D6）

`TaskIndexPanel.vue:938-947` 现值：

```ts
const last = group.sessions[0] // already sorted by updatedAt desc
```

改为：

```ts
// 组内首行不再保证是「最近更新」（任务树活跃优先，§5.2）：显式取 updatedAt 最大者
const last = group.sessions.reduce((m, s) =>
  new Date(s.updatedAt || s.createdAt || 0).getTime() > new Date(m.updatedAt || m.createdAt || 0).getTime() ? s : m
)
```

（`activeInGroup` 优先的逻辑不变；该 reduce 只影响「当前会话不在本组」时的兜底来源。）

### 5.5 不改动清单

| 位置 | 说明 |
|---|---|
| `stores/session/*` | 零改动：`tree*` 归一化（`list.ts:306-318`）、实时 Map、边路缓存均现成 |
| `backend-ts` | 零改动：分组分页序仍是自身相位优先（`session.service.ts:381-385`），前端重排已加载窗口即可（限制见 §8.1） |
| `shared/contracts` | 零改动：无新字段 |
| 聚焦模式 / 归档区 / 右侧边路列表 | 零改动 |
| 组间顺序 | 零改动：`sortGroups` 自定义优先 + 固定 key 规则（`TaskIndexPanel.vue:997-1008`）不变 |

## 6. 测试计划

| 文件 | 用例 |
|---|---|
| `utils/taskGroupSort.test.ts`（新增） | ① 活跃集合非空时活跃行全部在前（与 `updatedAt` 无关）；② 同档按 `updatedAt` DESC；③ `updatedAt` 缺失回落 `createdAt`；④ 相同时间按 id DESC；⑤ 两侧均不活跃时 = 原排序（回归）；⑥ 空集合 / 空输入；⑦ 不改入参数组（纯函数） |
| `task-index-panel-interaction.test.ts`（挂载，补） | ① 父 `COMPLETED` + 边路 `RUNNING` → 排到同组另一条无活跃的 `COMPLETED` 之前；② 父 `COMPLETED` + `treeRunning=true`（无本地边路缓存）→ 提升（服务端口径）；③ 边路 `WAITING_APPROVAL` / `treePendingApprovalCount>0` → 提升；④ 边路 `pendingQuestionCount>0` → 提升（D2）；⑤ `treeRunning===false` + 陈旧边路缓存 `RUNNING` → **不**提升（D4）；⑥ 自身 `RUNNING` 的提升不回退（与 ⑤ 对照）；⑦ `onGroupNewTask` 兜底取组内最近更新（D6，mock emit 断言 payload 的 agentId/modelId 来自最新行） |
| 回归 | `cd desktop && npm run test:unit` 全量通过；`cd desktop && npm run build`（`vue-tsc -b && vite build`）通过 |

## 7. 交付顺序

单批、纯 desktop：

1. `utils/taskGroupSort.ts` + 单测；
2. `TaskIndexPanel.vue`（§5.1 / §5.2 / §5.4）+ 挂载用例；
3. 验证：`npm run test:unit` → `npm run build`；
4. changelog 碎片 `changelog/unreleased/2026-11-16-standard-mode-tree-active-sort.md`，**前端（桌面 / Web / 安卓）** 小节：任务栏标准模式组内排序把「边路任务在跑 / 待审批 / 待回答」的主任务一并顶到最前（原仅主任务自身运行中优先）；
5. 部署 = 合并后 `bash scripts/deploy-desktop.sh`（前端发版 = 部署 desktop/dist，无 Electron 原生变更，不需要 `build-apk.sh`）。

## 8. 风险与边界分析

### 8.1 已加载窗口限制（最重要）

组内首屏只加载前 5 条（`previewLimit: DEFAULT_GROUP_PREVIEW=5`，`stores/session/types.ts:154`），「展开更多」每次 +20；而后端分页序仍是**自身相位**优先（`session.service.ts:381-385`）。因此：

- 提升只重排**已加载窗口**内的行；
- 若组内自身活跃的行已占满前 5 条，一个边路活跃的父任务可能排在窗口外，用户要「展开更多」才看到。自身活跃的行不受此限（后端本就排最前），这是本方案与现状的不对称处；
- 根因是后端分页序不含 tree 信号（需要聚合 join / 宽表，成本高），本方案不碰（§9.3）。窗口小的组（绝大多数）无感知。

### 8.2 排序抖动

边路任务起停会使父行在「活跃档 / 非活跃档」之间跳动。与聚焦模式既有抖动同源；单档 + 同档 `updatedAt` desc 把跳动限制为「进档 / 出档」一次位移，不会同级内反复插队。

### 8.3 实时窗口

边路启动到树信号 / 边路缓存到位之间存在不提升的间隙，与圆点 / 转圈的显示窗口一致（同一批数据源），不引入新的不一致。

### 8.4 性能

`groupedSessions` 每次重算多一次 O(n) 预计算（n = 标准列表已加载总数，含各分组合计）；谓词内 `getSideTasks` 为缓存数组遍历。量级（数十~数百）可忽略；不做 memo 化。

### 8.5 兼容性

自身 `running` ⊂ 任务树活跃，第一档是严格扩容：原有「自身运行中优先」的行仍然在最前（同档内仍按 `updatedAt` desc），无行为回退；仅新增「边路活跃」的行进入第一档。

## 9. 不做清单

1. **未读升档**：聚焦模式有未读档（priority 3），标准模式不加——未读不应抢活跃档位，且青色圆点已足够（`TaskSessionGroupList.vue:149`）；
2. **失败（`treeFailed`）升档**：边路 / 主任务失败由红点示警（`effectivePhaseClass`），父任务多已终态，维持按 `updatedAt` 沉底；如后续要，按 §5.2 档位扩展点自然加入；
3. **后端分页序纳入 tree 信号**（§8.1 根因）：需聚合排序或额外查询，成本与回归面大，另立项评估；
4. **组间顺序按组内活跃度浮动**：组序是用户可拖拽的自定义顺序 + 固定规则，不因组内状态浮动；
5. **聚焦模式 / 归档区 / 右侧边路列表排序联动**：各自规则已成熟，本期不动。

## 10. 文档同步（随实施任务同批）

| 文档 | 改动 |
|---|---|
| `changelog/unreleased/2026-11-16-standard-mode-tree-active-sort.md` | 新增，**前端（桌面 / Web / 安卓）** 小节（只写 `###` 小节和条目，不写版本号） |
| `README.md` / `DEPLOY.md` | 无涉及，不改 |
| `skills/mao-cli/` | 无涉及（终端 CLI 不含任务栏排序），不改 |
| 历史方案 | 2026-08-09 等历史文档不改（历史设计豁免）；本方案是对其聚焦排序口径在标准模式的补齐，不回改原文 |
