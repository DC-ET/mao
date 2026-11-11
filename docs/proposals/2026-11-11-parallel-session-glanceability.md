# 提案：多会话并行状态可见性 —— 标题态与任务栏提醒

> 多会话并行是 0.0.473（多 Agent 容器隔离）、批次 25（边路任务）之后的**常态用法**：用户往往同时跑 2-3 个会话，然后切去别的窗口干活。问题是「**哪个会话出事了 / 在等我**」在今天只有三个观察点——左栏列表的 phase 文字、飞书 / 钉钉进度卡、以及碰巧切回来看一眼。侧栏不可见时（最小化、在别的桌面、中心 Tab 开着文件查看器），**等待审批**这种最需要即时裁决的状态没有任何主动可见性——审批超时后升级飞书卡片是唯一的兜底（tool-dispatcher 既有链路）。而判断状态所需的全部数据（`sessionStore` 的 `phase`、`budget_blocked` 事件先例）都在前端现成，本提案是纯展示层的可见性补完：**浏览器标题态 + Electron 任务栏提醒**两档，全部可开关。（原方案含中心 Tab 状态角标，评审砍掉——左栏 phase 已覆盖同位置信息，见 §8。）

- 状态：已立项（2026-11-11，批次 29）
- 日期：2026-11-11
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小-中（约 1.5-2 人日；**零后端、零迁移**；Electron main 进程仅一处只读转发）
- 关联：`desktop/src/stores/session/`（phase 事实源）、`desktop/src/composables/useStreamWS.ts`（`budget_blocked` 事件先例）、`desktop/electron/main.cjs`（flashFrame / 标题转发）、`desktop/src/composables/useChatScroll.ts`（活跃 Tab 判定参照）

## 1. 背景与现状

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 侧栏 phase 展示 | 已有（状态类名 + 忙碌/失败归组） | `TaskIndexPanel.vue:99/:145` `effectivePhaseClass`、`:645` ACTIVE_PHASES |
| 浏览器标签页标题 | 静态站名，不随会话状态变化 | `document.title` 无状态写入 |
| 任务栏提醒 | 无（Electron flashFrame / setBadgeCount 未使用） | `electron/main.cjs` grep 零命中 |
| 状态事实源 | `sessionStore` 的 `phase`（RUNNING / RESUMING / WAITING_APPROVAL / CANCELLING / FAILED / COMPLETED）现成 | `TaskIndexPanel.vue:645` 同款判定 |
| 主动事件先例 | `budget_blocked` 已走「WS 帧 → CustomEvent → UI 消费」链路 | `useStreamWS.ts`、`budget-block-banner.test.ts` 契约 |

与已否决项的边界：批次 21 否决的是「跨任务审批收件箱」（收拢未决审批的抽屉）；本提案不收拢、不建新面板，是**既有状态在既有界面位置的可见性**（标题 / 任务栏）。批次 27 否决的是流式渲染平滑（渲染性能）——不涉渲染。

## 2. 目标 / 非目标

**目标**

1. **P1 浏览器标题态**：多会话并行时 `document.title` 加状态前缀——`❗ 等待审批 · Mao`（最高优先）/ `▶ 运行中 · Mao` / `✗ 有会话失败 · Mao`；Web 多标签用户的跨窗口感知。Electron 窗口标题同步受益。
2. **P1 等待审批的任务栏提醒（仅 Electron）**：等待审批出现时 `flashFrame`（任务栏图标闪烁）+ 可选系统通知；切回窗口即停。**设置开关**（默认开，可关——免打扰口径）。
3. **P2 运行完成通知（可选开关，默认关）**：会话进入 COMPLETED / FAILED 时可选系统通知——默认关（完成不紧急，避免打扰；等待审批默认开因为它是阻断性状态）。
4. 安卓壳：标题态共用生效；系统通知 / 任务栏为 Electron 专属（安卓按平台守卫跳过）。

> 已砍：**中心 Tab 状态角标**（原 P1，评审 2026-11-11 决定不做）——左栏列表 phase 已在同一产品面覆盖状态感知，角标为增量重复；需要时另行立项。

**非目标**

- 不做安卓原生推送（产品边界明确排除）。
- 不做声音提示、通知中心收口（收件箱批次 1 已覆盖任务消息）。
- 不做跨任务审批抽屉（批次 21 已否决）——状态可见性不改变审批的操作路径（仍在会话内卡片裁决）。
- 不做侧栏排序 / 置顶改动（批次 16 已定稿）——侧栏行为零变化。
- 不做逐轮进度百分比（数据源不存在，不虚构）。
- 零后端、零迁移。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 跨任务审批收件箱（批次 21 否决） | 不收拢、不抽屉、不新增操作面；只是「哪里有审批」的可见性 |
| 安卓原生推送（产品边界） | 桌面 Electron 通知 + Web 标题态；安卓仅标题态（共用），无原生推送 |
| 流式渲染平滑（批次 27 否决） | 不碰渲染性能；标题态是轻量状态订阅（phase 变更驱动的低频更新） |

## 4. 方案设计

- **状态聚合器**：`stores/session/` 既有 phase 上派生 `parallelStatus` computed——返回最高优先状态（等待审批 > 失败 > 运行中 > 完成），与 `ACTIVE_PHASES` / `FAILED` 判定同口径（`TaskIndexPanel.vue:645` 常量收编共享）。
- **标题态**：watch 聚合状态 → `document.title` 前缀写入；Electron 走既有窗口标题同步（无 IPC 需求——窗口标题随 document.title 自动跟随）。
- **任务栏提醒**：等待审批出现 → 经既有 `electronAPI` 通道转发 `flash` 事件 → `main.cjs` 调 `win.flashFrame(true)`；窗口 focus 事件 → `flashFrame(false)` 停止。系统通知（P2）用 Electron `Notification` API，点击 → 聚焦窗口并路由到该会话（路由参数既有）。
- **设置开关**：`设置 → 通用`（或外观组）新增「等待审批时闪烁任务栏」「会话完成通知」两项；键走外观偏好同族 localStorage（跨设备不同步可接受）。

## 5. 改动面

| 端 | 改动 |
|---|---|
| desktop | `stores/session/`（parallelStatus 聚合）；`document.title` watch；`electron/main.cjs` + preload（flash/notify 只读转发）；设置项两枚开关；测试新增 |
| backend-ts / admin / agent-cli | **无** |
| android | 标题态共用生效；通知 / 任务栏按 `Capacitor.isNativePlatform()` 守卫跳过 |
| 数据库迁移 | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 通知 / 闪烁打扰（多会话高频轮转时轰炸） | ①分级：等待审批默认开（阻断性）、完成通知默认关；②切回窗口即停闪；③设置开关可全关；④同一状态不重复提醒（状态沿触发） |
| document.title 与既有标题逻辑冲突 | 全仓 grep `document.title` 确认现状（预计无动态写入）；统一收口到一个 watcher，避免多写者竞态 |
| phase 高频翻转导致标题抖动 | 状态沿触发（沿进入/退出才更新）；聚合状态未变不写 `document.title` |
| Electron / Web 双端行为分叉 | Web 无 flashFrame（守卫降级为标题态即可）；标题态双端一致 |
| 后台窗口的审批被误以为已处理 | 标题态前缀在窗口失焦时保留（`document.title` 不随焦点清除），直到用户裁决 |

## 7. 测试要点

1. 会话进入 WAITING_APPROVAL：`document.title` 变 `❗`、Electron 任务栏闪烁；裁决后全部复位。
2. 运行中 → COMPLETED：可选通知仅在开关开启时出现；FAILED 通知文案区分。
3. 开关关闭：闪烁与通知全部不触发（标题态保留——零成本信息）。
4. 多会话并行：标题态取最高优先状态、互不串扰；状态沿触发（无重复闪烁）。
5. 回归：审批链路（升级飞书卡片 / 规则 / 多端广播）零变化；侧栏 phase 展示零变化。
6. 安卓壳：标题态可用；flashFrame / Notification 被守卫跳过（无报错）。

## 8. 决策记录

已拍板（2026-11-11，评审确认）：

1. **中心 Tab 状态角标（原 P1）：不做**——左栏 phase 已覆盖同位置状态感知，角标属增量重复；本提案范围收窄为标题态 + 任务栏提醒（§2 已标注）。
2. **等待审批提醒默认开 / 完成通知默认关**：维持紧急度分层——等待审批（阻断性）闪烁/通知默认开，完成通知默认关。
3. **桌面系统通知（P2）：保留**——`Notification` 随分级默认走（等待审批默认开、完成默认关），设置可全关。
4. **失败会话的提醒强度**：随完成通知走（默认关），失败靠标题态 `✗` 前缀感知；不并入闪烁档。
