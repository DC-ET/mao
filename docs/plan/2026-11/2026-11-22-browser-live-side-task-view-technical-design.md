# 边路任务查看浏览器直播技术方案

- 日期：2026-11-22
- 状态：**已落地**（2026-11-22 实施，发版说明见 `changelog/unreleased/2026-11-22-browser-live-side-task-view.md`）
- 一句话：给边路任务面板（SideChatPanel）加会话级"浏览器"直播状态条，并把主窗直播 Tab 从"固定绑定主会话"改为"跟随最近活跃直播"，使边路任务发起的浏览器直播在 Web / 安卓端也能看到（现状只有桌面画中画能看）。
- 关联：
  - `docs/plan/2026-11/2026-11-20-browser-live-pip-technical-design.md`（直播/画中画基础，已落地）
  - 直播入口迁至输入框上方状态条：已落地 commit `576dcfb2`（仅主会话 ChatPanel）
  - 同会话二次直播修复：已落地 commit `7bf470a0`（sidecar 闩锁复位 + store 帧序号重置 + Electron LOCAL 重连死路）

## 1. 背景与问题

2026-11-22 入口迁移后，浏览器直播的唯一主动入口是主会话 ChatPanel 输入框上方的"浏览器"状态条（全局语义：任一会话直播中即显示）。排查边路任务场景发现两处缺口：

1. **边路面板无任何入口**：`SideChatPanel.vue` 对 browserLive 零引用——没有状态条，也没有直播视图。
2. **主会话"浏览器直播"Tab 看不到边路直播**：Tab 渲染 `BrowserLiveView` 时固定传主会话 id（`CenterTabContainer.vue:75` ← TaskView `sessionIdForTabs`），而边路会话跑浏览器工具时 WS 事件带的 sessionId 是边路会话 id，store 按边路会话 id 记状态——两边对不上号，Tab 里只显示"等待 Agent 打开浏览器…"或主会话上一场残留。

结果：边路任务发起的直播目前只有桌面 Electron 画中画能看（画中画跟随"最近活跃直播"，不分会话），Web / 安卓端完全无入口。

## 2. 现状代码链路（设计依据）

| 位置 | 现状 |
|---|---|
| `desktop/src/components/chat/ChatPanel.vue` | 输入区 `.side-task-entry` 行内有 `browser-live-chip`（`v-if="browserLiveStore.hasAnyLive"`，全局语义），点击 `openBrowserLive`：Electron → `electronAPI.browserLive.expand()`；Web → `window.dispatchEvent(new CustomEvent('browser-live-expand'))`（TaskView L781 监听 → `openBrowserLiveTab()`） |
| `desktop/src/components/chat/SideChatPanel.vue` | 同款 `.side-task-entry` 行（L110-115）只有"+ 边路任务"按钮；会话 id 为 `realSessionId`（L312：`ref(props.sideSessionId > 0 ? props.sideSessionId : 0)`），`hasRealSession = realSessionId > 0`（L313） |
| `desktop/src/components/center/CenterTabContainer.vue` L71-76 | `activeTab?.type === 'browser_live'` 时渲染 `<BrowserLiveView :key="`browser-live-${props.sessionId}`" :session-id="props.sessionId" />` |
| `desktop/src/components/browser/BrowserLiveView.vue` L71-88 | `sessionId` prop **可选**，缺省回退 `store.activeSessionId`（"缺省跟随最近活跃直播"）；视图全部经 `state` computed 响应式读取，无会话本地状态，不依赖重挂载 |
| `desktop/src/views/PipBrowserLiveView.vue` L3 | 画中画即"`<BrowserLiveView variant="pip" />` 不传 sessionId → 跟随最近活跃直播"，模式已在线上验证 |
| `desktop/src/stores/browserLive.ts` | `activeSessionId` 在 started / 每帧事件时更新为最近直播会话；`stopBrowser()` 缺省也作用于最近活跃会话；`sessions` 按会话 id 分键 |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` L796-813 | 直播事件按**用户**广播（`sendToClientTypes(binding.userId, …)`，L300 客户端类型含 electron / browser / android），**不要求 WS 订阅该会话**——边路 Tab 关掉（unsubscribe）后事件仍持续到达，主 chip 与直播 Tab 不依赖边路面板存活；LOCAL 由 `attachLocalSession(执行会话 id)` 挂（`electron/main.cjs` L1610 / L1640），边路会话 id 同样成立 |

SideChatPanel 渲染于 `CenterTabContainer.vue:21`（side_task Tab），位于 TaskView 之下，`browser-live-expand` 窗口事件监听可达。

## 3. 方案设计

### 3.1 SideChatPanel 加会话级状态条

在输入区 `.side-task-entry` 行内、"+ 边路任务"按钮之前加同款 chip（复用 ChatPanel 已落地的模板与样式模式）：

- **显示条件：该边路会话自己的直播状态**（与主会话 chip 的全局 `hasAnyLive` 不同）：
  `v-if="hasRealSession && browserLiveStore.sessions[String(realSessionId)]?.isLive"`
  （会话未创建 / 未直播时不显示；`sessions` 键不存在时 `?.isLive` 为 undefined，天然隐藏）
- 文案"浏览器" + 绿点脉冲（`live-dot`），`title="点击查看浏览器直播"`
- 点击 `openBrowserLive`：与 ChatPanel 相同逻辑（Electron 收起画中画开 Tab；Web 派发 `browser-live-expand` 事件）
- script 新增 import：`useBrowserLiveStore`（`../../stores/browserLive`）、`isElectronClient`（`../../utils/platform`）
- style：`.browser-live-chip` / `.live-dot` / `@keyframes browser-live-pulse` 三块从 ChatPanel 复制进 SideChatPanel 的 scoped style——该文件本就与 ChatPanel 重复维护 `.side-task-entry` / `.side-task-btn` 样式，沿用既有模式，不抽公共组件

### 3.2 直播 Tab 跟随最近活跃直播

`CenterTabContainer.vue` 的 `<BrowserLiveView>`（L71-76）：

- 去掉 `:session-id="props.sessionId"`，`:key` 简化为固定 `"browser-live"`
- 组件 `sessionId` prop 本就可选，缺省回退 `store.activeSessionId`——与画中画同一机制，零新增逻辑
- 视图内部无会话本地状态，Tab 无需重挂载；`activeSessionId` 随 started / 帧事件自动切换

效果：无论直播来自主会话、边路会话还是子代理会话，Tab 显示最近活跃的一场；标题、停止按钮、结束态都对准当前直播会话（`BrowserLiveView.onStop` 显式停 `numericSessionId`，与画面显示同源，多场并存时停的正是正在看的那场）。

### 3.3 改动后的状态语义矩阵

| 场景 | 主会话 chip（全局 `hasAnyLive`） | 边路 chip（本会话 `isLive`） | 直播 Tab |
|---|---|---|---|
| 主会话直播中 | 显示 | 不显示 | 跟随主会话 |
| 边路直播中 | 显示（承接原顶栏图标语义：任一会话直播即有入口） | 显示（仅该边路面板内） | 跟随边路（最近活跃） |
| 多场同时直播 | 显示 | 各面板按各自会话显示 | 显示最近活跃的一场 |
| 无直播 | 隐藏 | 隐藏 | 显示等待占位 / 上场结束态 |

主会话 chip 保持全局语义的理由：承接已移除的顶栏图标行为（任意会话直播时用户在主视图总有入口），配合 3.2 的 Tab 跟随，点击总能看到当前活跃直播。

## 4. 不改动范围

- 主会话 ChatPanel chip 的显示条件与点击逻辑不动
- `SubagentChatPanel.vue` 不加 chip：子代理会话直播同样按会话 id 入 store，入口由主会话 chip（全局）+ 3.2 Tab 跟随承接——改前 Tab 固定绑主会话，子代理直播同样看不到，本方案顺带修复可见性
- `stores/browserLive.ts`、`useStreamWS.ts`、后端（streaming-ws-handler / 技能 sidecar）均无改动——纯前端 UI 改动
- 边路任务 Tab 结构、`useCenterTabs` 的 `openBrowserLiveTab`（每会话单例）不动

## 5. 边界与取舍

- **多场同时直播**：单个直播 Tab 只能显示最近活跃一场（与画中画同限制）；边路 chip 只反映自己会话，避免误导。若需"多场并存可切换"，另行提案。
- **边路会话未创建**（`hasRealSession` false）：无 chip——会话不存在则不可能有直播。
- **迟到 stopped 覆盖新 started**：store 无 epoch 保护（低概率竞态，事件源顺序由后端关键队列保证），本方案不处理；如复现另行修复。
- **样式重复**：chip 样式在 ChatPanel / SideChatPanel 各一份，与该文件既有 `.side-task-btn` 重复维护模式一致；若后续第三处需要，再抽公共样式。

## 6. 改动清单

| 文件 | 改动 |
|---|---|
| `desktop/src/components/chat/SideChatPanel.vue` | 输入区加 `browser-live-chip`（会话级显示条件）+ `openBrowserLive` + 三块 CSS |
| `desktop/src/components/center/CenterTabContainer.vue` | `<BrowserLiveView>` 去 `:session-id`，key 固定 `"browser-live"` |
| `changelog/unreleased/` | 新增条目（`### 前端（桌面 / Web / 安卓）`） |

## 7. 测试与验收

- `cd desktop && npm run test:unit`（无 store 改动，防回归）+ `npm run build`
- 手动验收：
  1. 边路任务跑浏览器工具 → 边路面板输入框上方出现"浏览器"状态条，点击打开直播 Tab 能看到边路会话画面；
  2. 边路直播期间主会话 chip 同样可见，点击后 Tab 显示边路直播（跟随活跃）；
  3. 边路直播结束 → 边路 chip 消失，Tab 显示结束态与原因；
  4. 主会话直播 → 边路面板无 chip，主会话链路与迁移前行为一致；
  5. 多场同时直播（主会话与边路各一场，或两个边路各一场）→ Tab 显示最近活跃的一场，停止按钮停的正是当前显示那场；各边路面板 chip 按各自会话显示；关闭边路 Tab 后主会话 chip 与直播 Tab 仍持续更新（事件按用户广播，不依赖会话订阅）。
- 纯前端改动，desktop 发版即生效，无后端 / 技能脚本部署要求。
