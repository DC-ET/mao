# 多会话并行状态可见性技术方案：浏览器标题态与任务栏闪烁

> 对应提案：[docs/proposals/2026-11-11-parallel-session-glanceability.md](../proposals/2026-11-11-parallel-session-glanceability.md)（批次 29）。**中心 Tab 状态角标已评审砍掉**（提案 §2 已标注），本方案范围 = 浏览器标题态 + Electron 任务栏闪烁两项，均为零后端、零迁移的纯前端增量（Electron 主进程仅一处只读 IPC 转发）。

## 1. 需求背景（含现状复核修正）

多会话并行是常态用法，「哪个会话在等我」在侧栏不可见时（最小化 / 在别的窗口）没有主动可见性。2026-11-11 复核发现**提案低估了既有通知体系**：收件箱系统通知（`useInboxSystemNotify.ts`）已经覆盖了通知面的大半——本方案的真实剩余面因此收窄。

| 场景 | 现状 | 代码证据 |
|---|---|---|
| **等待审批的系统通知** | **已有**：收件箱 `APPROVAL_PENDING` 类目默认开（`approvalPendingEnabled: true`），窗口非聚焦（`document.hidden \|\| !document.hasFocus()`）时经主进程 `desktop-notify` IPC 弹系统通知，点击跳会话 | `useInboxSystemNotify.ts:13, 37, 57-60`、`main.cjs:1493`（`ipcMain.handle('desktop-notify')`）、`NotificationSettingsView.vue:338`（默认值） |
| **完成 / 失败的系统通知** | **已有**：`TASK_COMPLETED` / `TASK_FAILED` 类目，**默认开**（`taskCompletedEnabled: true`），同一通道同一开关面板 | `useInboxSystemNotify.ts:31-33`、`NotificationSettingsView.vue:336` |
| 通知设置面板 | 「消息通知」设置页已有系统通知总开关 + 分类目开关（含系统通知、任务完成、审批待决等） | `NotificationSettingsView.vue:100-139` |
| **浏览器标签页标题** | **真实缺口**：全仓 `document.title` 写入只有 `LoginView.vue:191`（'Mao'）与 `EcpFeishuCallbackView.vue:21` 两处静态值；`index.html:8` `<title>Mao</title>`。主界面标题不随任何状态变化 | grep 复核 |
| **任务栏闪烁** | **真实缺口**：`main.cjs` 无 `flashFrame` 调用；Electron `BrowserWindow.flashFrame` API 完全未使用 | grep 复核 |
| phase 事实源 | `sessionStore.sessions`（主会话列表投影）+ `getSideTasks(parentId)`（边路任务），`ACTIVE_PHASES = {RUNNING, RESUMING, WAITING_APPROVAL, CANCELLING}` | `stores/session/list.ts:51-54`、`stores/session/types.ts:8`、`TaskIndexPanel.vue:308, 690-698` |
| localStorage 偏好键惯例 | `aw-*` 前缀（`aw-theme-mode`、`aw-accent`、`aw-font-scale`） | `utils/theme.ts:67`、`utils/appearance.ts:34-35` |
| Electron 主进程测试基建 | `mainShell.test.cjs` + `mainShellHarness.cjs`（假 electron 纯 node 驱动真实 main.cjs，`ipcMain.handle` 可 `h.invoke` 直调）；**harness 假 BrowserWindow 尚无 `flashFrame` 与 `focus` 事件**，需小量补桩 | `mainShell.test.cjs:253`（`h.invoke('desktop-notify', …)` 先例） |

**方案因此不新增任何通知通道**：等待审批 / 完成 / 失败的「一次性系统通知」已由收件箱体系承担。本方案补的是收件箱通知没有的两个感知维度——**持续驻留的浏览器标题态**（Web + Electron 都生效）与**持续闪烁的任务栏**（比一次性通知更难错过，且在用户已关通知分类目时仍可用）。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 任一会话（含其边路任务）进入 `WAITING_APPROVAL` | 浏览器 / Electron 窗口标题变为 `❗ 等待审批 · Mao`（最高优先）；Electron 任务栏图标开始闪烁（默认开，可在消息通知页关闭）；切回窗口闪烁停止；裁决后标题与闪烁复位 |
| 2 | 无待审批但有会话 `FAILED`（含边路任务失败） | 标题 `✗ 有会话失败 · Mao`（优先级次于待审批） |
| 3 | 无待审批 / 失败但有会话处于 `ACTIVE_PHASES` | 标题 `▶ 运行中 · Mao` |
| 4 | 全部会话空闲 / 已完成 | 标题回到 `Mao`（无前缀） |
| 5 | Web（非 Electron）用户 | 标题态生效；任务栏闪烁无 electronAPI 整体不启用（无降级分支、无报错） |
| 6 | 用户在消息通知页关闭「等待审批时闪烁任务栏」 | 闪烁不再触发；标题态保留（零成本信息，不受开关控制） |
| 7 | 登出 | 标题复位 `Mao`；闪烁停止 |

**要做**：上述七条。

**不做**：

- 中心 Tab 状态角标——不做（评审砍掉，提案 §2 已标注）。
- 新的第二套完成/失败/审批系统通知——不做：收件箱体系已实现且默认开（§1），新增通道是重复建设。
- 修改既有收件箱通知的默认值与开关——不做：`taskCompletedEnabled` 等默认值是已发版行为，翻转属独立产品决策（§8 决策 3 记录与拍板口径的对账）。
- 声音提示、通知中心收口、逐轮进度百分比——不做（提案非目标维持）。
- 安卓原生推送、移动端布局——不做（产品边界）。
- 后端、admin、agent-cli、数据库迁移——不做。

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 状态聚合 | 新增 `desktop/src/composables/useParallelStatus.ts`：导出**纯函数** `deriveParallelStatus(sessions: Session[], getSideTasks: (id: string) => SideTask[]): ParallelStatus` + 包装 `useParallelStatus()`（内部 `computed` 扫 `sessionStore.sessions`，逐会话并扫 `getSideTasks`） | 纯函数可脱离 pinia 在 node 环境直测；聚合口径与侧栏同源（同一 store API、同一 `ACTIVE_PHASES`） |
| 优先级 | `waiting_approval > failed > running > null`；判定含边路任务（侧栏 `:690-694` 同口径：边路失败计 failed、边路活跃计 running） | 侧栏语义是用户已建立的心智，标题态照抄不发明 |
| 标题写入 | 新增 `useAppStatusIndicators()`（同一 composable 文件）在 `App.vue` setup 调用：`watch(parallelStatus)` → `document.title = titleWithPrefix(status)`；**`authStore.user` 为空时不写**（登录页 / 飞书回调页的静态标题不被抢） | 全局单写者；登出后 sessions 清空 → status null → 标题 `Mao`，与 `LoginView` 写值一致；前缀格式 `❗ 等待审批 · Mao`（空格 + `·` 分隔） |
| 状态沿触发 | flash 用 `watch(parallelStatus, (now, prev))` 比较沿：`prev !== 'waiting_approval' && now === 'waiting_approval'` 才 flash(true)；离开该态才 flash(false)。标题 watch 同样只在值变化时写 | 防高频翻转重复闪烁与重复写 title（提案风险表口径） |
| flash 通道 | preload 新增 `flashFrame(on: boolean) => ipcRenderer.invoke('desktop-flash-frame', on)`；main.cjs 注册 handle 调 `win.flashFrame(on)` 并维护模块级 `flashActive` 标记；`BrowserWindow` 的 `focus` 事件里 `flashActive` 为真时 `flashFrame(false)` 复位 | 主进程统一管理闪烁生命周期（切回窗口即停），渲染层只发沿信号；与 `desktop-notify` 同款 handle 模式 |
| 开关存储 | `localStorage` 键 `aw-approval-flash`（缺省 = 开，`'0'` = 关），读写收进 `utils/approvalFlashPreference.ts`（`isApprovalFlashEnabled()` / `setApprovalFlashEnabled(v)`） | 零后端；`aw-*` 前缀随既有外观偏好族（跨设备不同步可接受，提案已拍板口径） |
| 开关 UI | `NotificationSettingsView.vue`（消息通知页）新增一行「等待审批时闪烁任务栏」开关，仅 `isElectronClient()` 时渲染 | 闪烁是 Electron 专属行为，放通知页与其余提醒开关同位；Web / 安卓不渲染（无此行为） |
| 非 Electron 守卫 | 渲染层 flash 触发前查 `(window as any).electronAPI?.flashFrame`，无则跳过 | 与 `desktopNotifyApi()` 同款守卫惯例（`useInboxSystemNotify.ts:62-65`），无 Web Notification 回退分支 |
| flashFrame 平台差异 | 不做平台分支：Windows 任务栏闪烁直到复位；macOS dock 弹跳数次自停；Linux 视 WM 而定。均无报错 | Electron 原生行为即合理降级，不重复封装 |

## 4. 实现步骤

### 4.1 新增 `desktop/src/composables/useParallelStatus.ts`

```ts
export type ParallelStatus = 'waiting_approval' | 'failed' | 'running' | null

/** 纯函数：主会话 + 边路任务的最高优先状态（侧栏 TaskIndexPanel 同口径）。 */
export function deriveParallelStatus(
  sessions: Session[],
  getSideTasks: (parentId: string) => Array<{ phase: string }>,
): ParallelStatus {
  for (const s of sessions) if (s.phase === 'WAITING_APPROVAL') return 'waiting_approval'
  for (const s of sessions) {
    if (s.status === 'ARCHIVED') continue
    if (s.phase === 'FAILED') return 'failed'
    if (getSideTasks(s.id).some(t => t.phase === 'WAITING_APPROVAL')) return 'waiting_approval'
  }
  // ……（完整实现：两轮扫描——先全部会话查 waiting（主 + 边路），再查 failed（主 + 边路），最后查 ACTIVE_PHASES）
}

export function useParallelStatus(): ComputedRef<ParallelStatus> {
  const sessionStore = useSessionStore()
  return computed(() => deriveParallelStatus(sessionStore.sessions, id => sessionStore.getSideTasks(id)))
}

export function titleWithPrefix(status: ParallelStatus, base = 'Mao'): string {
  const prefix = status === 'waiting_approval' ? '❗ 等待审批 · '
    : status === 'failed' ? '✗ 有会话失败 · '
    : status === 'running' ? '▶ 运行中 · '
    : ''
  return prefix + base
}
```

（实现轮次按「waiting 两轮 → failed 两轮 → running 一轮」保证优先级严格成立；`ARCHIVED` 过滤对齐侧栏 `:308`。）

### 4.2 `useParallelStatus.ts` 内挂 `useAppStatusIndicators()`

- `watch(parallelStatus)`：`authStore.user` 非空时 `document.title = titleWithPrefix(v)`；用户登出（user 清空）时写 `titleWithPrefix(null)` 复位。
- flash 沿 watch（§3）：`now === 'waiting_approval' && prev !== 'waiting_approval'` 且 `isApprovalFlashEnabled()` 且 `electronAPI.flashFrame` 存在 → `flashFrame(true)`；离开态 → `flashFrame(false)`（无条件尝试复位，幂等）。
- `onUnmounted`（App 级实际不卸载，防御性）复位 flash(false)。

### 4.3 `App.vue`

- setup 里调用 `useAppStatusIndicators()`（无模板改动）。

### 4.4 Electron 主进程与 preload

1. `main.cjs`（`desktop-notify` handle 附近追加）：

   ```js
   let flashActive = false
   ipcMain.handle('desktop-flash-frame', (event, on) => {
     const win = mainWindow
     if (!win || win.isDestroyed()) return { ok: false }
     flashActive = !!on
     try { win.flashFrame(flashActive) } catch { /* 平台不支持时静默 */ }
     return { ok: true }
   })
   ```

2. `createWindow()` 内（既有 `win.on(...)` 注册区）追加：`win.on('focus', () => { if (flashActive) { flashActive = false; try { win.flashFrame(false) } catch {} } })`。
3. `preload.cjs`（`desktopNotify` 相邻行）追加：`flashFrame: (on) => ipcRenderer.invoke('desktop-flash-frame', on)`。
4. `mainShellHarness.cjs` 假 BrowserWindow 补两个桩：`flashFrame(on)`（记录调用到 `h.state.flashCalls`）与 `focus` 事件派发（`h.emitWin('focus')` 辅助）。

### 4.5 开关

1. 新增 `desktop/src/utils/approvalFlashPreference.ts`：`isApprovalFlashEnabled(): boolean`（`localStorage.getItem('aw-approval-flash') !== '0'`，非浏览器环境 true）、`setApprovalFlashEnabled(v: boolean)`（v ? removeItem : setItem('0')——缺省语义即开，键不写 '1'）。关闭瞬间若正在闪烁：`setApprovalFlashEnabled(false)` 时若当前 `parallelStatus === 'waiting_approval'` 立即补发 `flashFrame(false)`（开关内不依赖状态源，由 `useAppStatusIndicators` 的开关 watch 兜底）。
2. `NotificationSettingsView.vue`：`v-if="isElectronClient()"` 行 + el-switch 绑定本地 ref（init 读偏好，change 写偏好并即时生效）。

### 4.6 测试

1. `useParallelStatus.test.ts`（node 环境纯函数）：
   - 单会话各 phase（WAITING_APPROVAL / FAILED / RUNNING / RESUMING / CANCELLING / COMPLETED）映射正确；
   - 优先级：waiting 压过 failed 压过 running（无论会话顺序）；
   - 边路任务：side WAITING_APPROVAL → waiting；side FAILED → failed；side 活跃 → running；
   - ARCHIVED 主会话不参与；空列表 → null；
   - `titleWithPrefix` 四态前缀与复位。
2. `approvalFlashPreference.test.ts`：默认开 / '0' 关 / set 往返。
3. `mainShell.test.cjs` 追加：`h.invoke('desktop-flash-frame', true)` → 假窗 `flashCalls` 记录 `[true]`；`h.emitWin('focus')` 后再 invoke false 路径——断言 focus 触发 `flashFrame(false)` 且标记复位（二次 focus 不重复发 false）。
4. 手测矩阵：Electron 多会话并行（另一窗口置前）→ 标题前缀 + 任务栏闪烁 → 切回即停 → 裁决复位；关闭开关后闪烁消失标题保留；Web 浏览器标签页标题态；登出复位。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 新增 | desktop/src/composables/useParallelStatus.ts | deriveParallelStatus / useParallelStatus / titleWithPrefix / useAppStatusIndicators |
| 新增 | desktop/src/utils/approvalFlashPreference.ts | aw-approval-flash 读写 |
| 修改 | desktop/src/App.vue | setup 调 useAppStatusIndicators() |
| 修改 | desktop/electron/main.cjs | desktop-flash-frame handle + flashActive + focus 复位 |
| 修改 | desktop/electron/preload.cjs | flashFrame 桥接 |
| 修改 | desktop/electron/mainShellHarness.cjs | 假窗 flashFrame 桩 + focus 事件派发 |
| 修改 | desktop/electron/mainShell.test.cjs | flash handle 用例 |
| 修改 | desktop/src/views/settings/NotificationSettingsView.vue | 「等待审批时闪烁任务栏」开关（Electron only） |
| 新增 | desktop/src/composables/useParallelStatus.test.ts / desktop/src/utils/approvalFlashPreference.test.ts | 单测 |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面 / Web）小节，版本随发版批次 |
| backend-ts / admin / agent-cli | — | **无改动**（收件箱通知体系原样） |
| android | — | **无改动**：标题态经共用 WebView 自动生效；flash / 通知按 electronAPI 守卫跳过 |
| 数据库迁移 | — | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| phase 高频翻转导致标题抖动 / 重复闪烁 | 状态沿触发（值不变不写 title、沿进入才 flash）；`deriveParallelStatus` 是低频 computed（列表 phase 变更才重算） |
| 与 LoginView / 飞书回调页的标题写入竞态 | `authStore.user` 守卫：未登录不写；两静态页均在无会话态，status 必为 null，即便误写也是 'Mao' 与其语义一致 |
| `document.title` 多写者漂移 | 本方案是唯一动态写者（复核确认现状仅两处静态写）；标题写入收口在 `useAppStatusIndicators` 单点 |
| 通知 / 闪烁打扰 | ①闪烁默认开但仅「等待审批」一态触发（阻断性），完成 / 失败不闪（失败靠标题 ✗ 与既有收件箱通知）；②切回窗口即停（主进程 focus 复位）；③消息通知页开关可关；④状态沿触发不重复 |
| flashFrame 在某平台无效 / 报错 | try/catch 静默 + `{ ok: false }` 返回；非 Electron 无桥接直接跳过（无 web 回退分支） |
| macOS dock 弹跳数秒自停与 focus 复位叠加 | 无害叠加（flashFrame(false) 对已停弹跳是 no-op）；不做平台分支 |
| `getSideTasks` 逐会话调用开销 | 会话量级为个位数十；`computed` 缓存下仅在列表 phase 变更时重扫，可忽略 |
| harness 补桩破坏既有 main 测试 | 桩是纯增量（新方法 + 新事件派发辅助），既有用例不触碰 flashFrame 路径；跑全量 `mainShell.test.cjs` 验证 |

## 7. 测试要点

1. WAITING_APPROVAL：标题 `❗ 等待审批 · Mao`、任务栏闪烁启动；裁决后全部复位；多会话并行时前缀互不串扰（取最高优先）。
2. FAILED / 运行中 / 空闲三态标题正确；失败含边路任务失败；等待审批含边路任务等待。
3. 开关关闭：闪烁不触发、标题保留；开关开启且正在等待审批时打开开关 → 立即闪烁（开关 change 兜底路径）。
4. 切回窗口（focus）闪烁停止；主进程 `flashActive` 标记复位后 focus 不重复发。
5. Web：标题态生效、无 flashFrame 调用无报错；登出标题复位 `Mao`。
6. 回归：收件箱通知（APPROVAL_PENDING / TASK_COMPLETED / TASK_FAILED）行为与默认值零变化（`useInboxSystemNotify` 既有用例全绿）；侧栏 phase 展示零变化。
7. 构建：`npm run build`（desktop）绿 + `node --test desktop/electron/mainShell.test.cjs`（或仓库既有跑法）绿。

## 8. 决策记录

1. **中心 Tab 状态角标：不做**（评审拍板，提案 §2 已标注砍档）——本方案只做标题态 + 任务栏闪烁。
2. **系统通知不新增第二套通道**（对提案拍板「保留分级默认」的对账）：复核发现收件箱体系已实现等待审批 / 完成 / 失败的系统通知（Electron、窗口非聚焦时、分类目开关、默认开、点击跳会话）。本方案的通知职责 = 保持既有体系原样；新增的只有**闪烁**（一次性通知之外的持续注意力）与**标题态**（通知体系没有的 Web 覆盖）。
3. **「完成通知默认关」的拍板不改既有默认值**：`taskCompletedEnabled` 默认开是已发版行为，默认值在后端偏好落库，翻转属独立产品决策且超出本提案「零后端」边界。用户可在消息通知页自行关闭；若确要全局默认翻转，另行单独立项。
4. 闪烁只绑「等待审批」一态（评审拍板的紧急度分层：等待审批默认开、完成默认关 → 落到本方案即只有等待审批会闪），失败不闪，靠标题 ✗ 与既有收件箱通知承担。
5. 标题态不受开关控制（零成本信息常驻）；闪烁受 `aw-approval-flash` 控制（默认开）。
6. 状态聚合含边路任务（与侧栏同口径：边路等待 / 失败计入父会话），复用 `getSideTasks` 与 `ACTIVE_PHASES`，不发明第二套判定。

## 9. 明确不做的（汇总）

- 中心 Tab 状态角标；任何新的系统通知通道；既有收件箱通知默认值与开关面板的改动。
- 声音提示；通知中心收口；跨任务审批抽屉；侧栏排序 / 置顶改动；逐轮进度百分比。
- 安卓原生推送、移动端布局改动；flashFrame 平台分支封装。
- 后端、admin、agent-cli、数据库迁移的任何改动。
