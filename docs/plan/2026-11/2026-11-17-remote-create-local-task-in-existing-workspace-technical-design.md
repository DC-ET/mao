# 浏览器端在已有本地工作区新建本地任务技术方案（远程创建，执行端沿用工作区绑定设备）

- 状态：已定案并落地（2026-11-18 开发完成；§3 决策随实现定案）
- 评审记录：2026-11-17 完成评审，结论「**可行**」（创建与执行链路均已被 2026-11-05 落地能力覆盖，主体确为「一个聚合端点 + 前端拦截收窄 + 一个工作区下拉」）。本版已按评审逐条核实代码并补齐（各处标注「**评审补充**」）：浏览器拦截守卫实为 5 处（漏了 `ChatInput.handleModeChange`）；聚合 SQL 补 `deleted = 0` 软删过滤与 embed/signal 来源排除；fastify 路由顺序已确认静态段优先、无冲突；「设备离线预检」修正为仅已有会话生效（新建首发由服务端兜底）；代表会话陈旧绑定下桌面端接管的结论与自愈路径已写明；`createSession` 维持既有位置形参风格。评审遗留的唯一定夺项「openapi 来源是否排除出聚合」已拍板（2026-11-18）：**不排除**，理由与落点见 §4.1-1。
- 日期：2026-11-17
- 关联方案：
  - [2026-11-05-local-task-device-delegation-technical-design.md](./2026-11-05-local-task-device-delegation-technical-design.md)（**前置依赖**：设备身份、创建即绑定、定向委托、惰性认领、浏览器接管已有 LOCAL 会话，全部已落地；本方案只放开「浏览器新建」这一条边界）
  - [2026-11-03-session-source-client-form-technical-design.md](./2026-11-03-session-source-client-form-technical-design.md)（来源词表 `web / android / desktop / cli`，本方案不改）
- 能力底座（撰写时已存在的实现，全部复用、不重写）：
  - 创建接口已无来源限制：`POST /v1/sessions` 接受任意客户端传 `executionMode: 'LOCAL'` + `workspace` + `targetDeviceId / targetDeviceName + platform / shell / osVersion / isGit`，无 Electron 校验（`backend-ts/src/session/session.routes.ts:210-229`，`normalizeTargetDeviceId / normalizeTargetDeviceName` 在 `:113-133` 做白名单与长度校验——字符集 `/^[A-Za-z0-9_-]+$/` 与长度 ≤64 分两步，等价 `{1,64}`）；**「浏览器不能新建本地任务」目前纯粹是前端拦截**
  - 创建落库即绑定：`session.service.ts` 的 `createSession` 对 LOCAL 落 `target_device_id / target_device_name`（`:146-154`），创建后无改写路径（`backend-ts/src/session/session.service.ts:114-220`）
  - 无设备身份客户端创建 LOCAL 会话的全链路已被边路任务验证：`handleCreateSideSession` 从浏览器创建 LOCAL 边路会话（继承 `executionMode / workspace / targetDeviceId / platform / shellPath / osVersion`，`:1416-1428`）→ `prepareLocalTarget` 定向（`:1380`）→ `sendToolRequest` 定向委托 → 审批 / 流式回传（`backend-ts/src/session/ws/streaming-ws-handler.ts:1358` 起）
  - 浏览器接管已有 LOCAL 会话的对话 / 审批切级 / 离线预检均已落地：发送前 `targetDeviceOnline === false` 前端拦截（`desktop/src/components/chat/ChatInput.vue:879-882`，仅已有会话生效）、服务端设备级 `isConnected` + `resolveTarget` 带库表兜底（`backend-ts/src/harness/local/local-tool-session-registry.ts:110-117/140-156`）
  - 会话 VO 已带设备字段：`enrichSessions` 是唯一装配点，输出 `targetDeviceId / targetDeviceName / targetDeviceOnline / executorClientType`（`backend-ts/src/session/session.routes.ts:174-208`，在线态 / 执行端类型注入在 `:180-197`；依赖回调 `hasDeviceConnection / getExecutorClientType` 由 `create-app.ts:990-996` 注入）
  - 前端设备工具已就绪：`getLocalDeviceInfo()`（Electron 专用，浏览器返回 null，`desktop/src/utils/device-info.ts:12-22`）、store 创建 payload 的 LOCAL 分支（`desktop/src/stores/session/list.ts:540-550`）
- 本方案定位：**不新增执行模式、不改绑定语义**。LOCAL 的口径仍是「执行端 = 会话创建时绑定的设备」。本方案只做一件事：让浏览器（Web / 安卓 WebView）能在**服务端已知**的本地工作区（该用户名下已有 LOCAL 会话的 workspace）新建 LOCAL 会话，执行端设备**沿用该工作区代表会话的绑定**，环境快照（platform / shell / osVersion / isGit）随绑定一并沿用。**仍然不做**远程新建本地工作区（在设备上挑选 / 创建新目录）、不做设备选择器、不做改绑。

## 0. 名词约定

沿用 [2026-11-05 方案 §0](./2026-11-05-local-task-device-delegation-technical-design.md)。新增两个：

| 名词 | 含义 |
|---|---|
| 已有本地工作区 | 该用户名下存在 ≥1 条 LOCAL 主会话（`session_type='NORMAL'`、未软删 `deleted=0`、**不含 `embed` / `signal` 来源**——前端分组口径把这两类归独立分组，见 `desktop/src/utils/cloud-project.ts:131-139`）的 `workspace` 路径；服务端可从 `session` 表聚合得出 |
| 代表会话 | 某工作区下**最近一条 `target_device_id` 非空**的 LOCAL 主会话（无绑定则取最近一条；`updated_at` 并列时以 `id DESC` 定序保证确定性）；其设备绑定与环境快照作为该工作区新建会话的沿用来源 |

## 1. 需求背景

### 1.1 现状

| 设施 | 现状 | 证据 |
|---|---|---|
| 浏览器创建拦截 | 纯前端 **5 处守卫 + 3 处 UI 禁用**：① `useChat.prepareAndSendMessage` 对「LOCAL 且浏览器且新建态」直接报错；② `ChatInput.handleSend` 同口径拦截；③ `ChatInput.handleModeChange` 禁止浏览器切 LOCAL（docked radio `@change` / centered `WorkspaceChip` / 移动 `ChatMobileConfigRow` 三处共用同一回调）；④ `WorkspaceChip.switchMode` 禁止浏览器切 LOCAL；⑤ `WorkspaceConfigFields.selectWorkspace` 在浏览器点击弹警告（按钮本身未禁用）。UI 禁用：`ChatNewTaskConfigBar` radio、`WorkspaceChip` popover 与抽屉两处 LOCAL 按钮 | `useChat.ts:393-399`、`ChatInput.vue:871-876/929-935`、`WorkspaceChip.vue:38/95/206-214`、`WorkspaceConfigFields.vue:109-117`、`ChatNewTaskConfigBar.vue:17` |
| 新建配置 UI | docked 布局 `ChatNewTaskConfigBar`：LOCAL radio `:disabled="!isElectronClient"`（浏览器永不可选）；LOCAL 工作区入口是「点击选目录」（Electron `selectDirectory`） | `ChatNewTaskConfigBar.vue:17`、`:38-49` |
| CLOUD 侧参照 | CLOUD 新建已有「现有工作区」下拉：`GET /v1/sessions/cloud-projects` 服务端列目录 + overview 富化；本方案的 LOCAL 工作区下拉与之对称 | `session.routes.ts:231-253`、`ChatNewTaskConfigBar.vue:57-80` |
| 总览复用链路 | 任务索引面板按会话分组（LOCAL 组 key 为 `LOCAL:<workspace>`），「用于新任务」带 `executionMode / workspace / reuseWorkspace` 预填；浏览器点 LOCAL 组的复用同样会在发送时撞上前端拦截 | `TaskIndexPanel.vue:252/957-965`、`TaskView.vue:414-421/1214-1315`、`utils/cloud-project.ts:122-129` |
| 服务端创建 | 无任何来源限制与在线硬校验（创建时不校验设备在线，发送时才校验）——浏览器带设备字段直连 API 即可建成定向 LOCAL 会话 | `session.routes.ts:210-229`、`session.service.ts:146-154` |
| 边路任务先例 | 浏览器可对 LOCAL 主会话新建边路任务并对话，工具定向委托给绑定设备执行——「浏览器创建 LOCAL 会话」在边路场景已是既成事实 | `streaming-ws-handler.ts:1358-1458` |
| **评审补充**：服务端发送兜底 | 绑定设备离线时前端预检只拦「已有会话」；新建 LOCAL 的首发由服务端硬校验兜底：`isConnected` 设备级失败 → 错误帧 `LOCAL_CLIENT_OFFLINE_MESSAGE`；工具下发投递落空 → `LOCAL_CLIENT_OFFLINE_TOOL_ERROR` | `streaming-ws-handler.ts:79/853-861`、`local-tool-session-registry.ts:11/171-177` |
| 安卓 | Capacitor 远程加载同一 web dist，无原生 LOCAL 相关守卫；随 web 行为自动变化 | AGENTS.md 架构节 |

### 1.2 问题

1. **产品口径自相矛盾**：浏览器可以接管已有 LOCAL 会话对话（2026-11-05 落地）、可以对 LOCAL 会话新建边路任务，却不能在同一工作区新建主任务——用户必须在桌面端新建后再回浏览器操作，割裂。
2. **总览复用链路在浏览器是死路**：任务索引面板的 LOCAL 组「用于新任务」在浏览器预填了 `mode=LOCAL + workspace`，发送时才被拦截报错，入口不拦、出口拦截。
3. **绑定信息其实齐备**：工作区下已有会话自带 `target_device_id / target_device_name / platform`，「以该工作区绑定设备为准」的数据不需要任何新采集通道，只差一个聚合出口。

### 1.3 机会（可行性结论）

1. **创建链路零后端改动即通**：`POST /v1/sessions` 已接受 LOCAL + workspace + 设备字段 + 环境字段；浏览器显式回显设备即建成定向会话，服务端创建逻辑一字不改。
2. **执行链路已被边路任务验证**：无设备身份客户端创建的 LOCAL 会话（绑定来自沿用而非本机），后续的定向委托、审批、流式、离线清理全部是已落地能力。
3. **主体改动是「一个聚合端点 + 前端拦截的口径调整 + 一个工作区下拉」**，与 2026-10-29 的 CLOUD「现有工作区」下拉形态对称，UI 心智可复用。

## 2. 需求描述

### 2.1 要做的

1. **P1 本地工作区聚合端点**：`GET /v1/sessions/local-workspaces`，按该用户 LOCAL 主会话聚合出工作区条目（路径、代表会话的设备绑定与环境快照、会话数、最近活跃、在线态、执行端类型），供新建下拉与预填解析共用。
2. **P1 浏览器新建入口放开（仅限已有本地工作区）**：
   - 新建配置区（docked `ChatNewTaskConfigBar` / centered `WorkspaceChip` + `WorkspaceConfigFields` 抽屉）：浏览器在**存在本地工作区条目**时可选「本地模式」，工作区选择是**下拉列表**（条目 = 工作区名 + 设备名 + 在线态）；「选择本地目录」按钮仍仅 Electron。
   - `useChat` / `ChatInput` 的发送拦截从「浏览器 + LOCAL + 新建态」收窄为「浏览器 + LOCAL + 新建态 + **未选定已有工作区**」；模式切换守卫（`WorkspaceChip.switchMode`、`ChatInput.handleModeChange`，见 §1.1 ③④）从「浏览器一律拦」收窄为「无本地工作区条目时才拦」。
   - 总览 LOCAL 组「用于新任务」预填链路在浏览器打通（发送时按工作区解析设备沿用）。
3. **P1 设备与环境沿用**：浏览器创建 LOCAL 会话时，显式回显所选工作区条目的 `targetDeviceId / targetDeviceName` 与 `platform / shell / osVersion / isGit`；Electron 创建路径不变（继续绑定本机，显式值优先语义天然区分两端）。
4. **P1 未绑定工作区的兜底**：工作区无任何绑定会话（纯历史遗留）→ 新会话创建为未绑定，首次发送走既有惰性认领 ②/③（唯一在线设备 + 平台一致才认领），口径与 2026-11-05 D15 完全一致。
5. **P1 能力边界沿用**：浏览器在新建的 LOCAL 会话内与「接管已有 LOCAL 会话」完全同权：非图片附件禁用（`ChatInput.vue:472-474/709-711` 既有拦截按 `executionMode==='LOCAL'` 生效，自动覆盖）、本地技能 / AGENTS.md 注入为空（`collectLocalUnsyncedSkills` / `collectAgentsMdContent` 非 Electron 返回空，`useChat.ts:516-517`）、文件树 / 终端 / Git 面板维持桌面端专属。
6. **P1 模式默认回落**：浏览器进入新建态时若默认模式为 LOCAL 但本地工作区列表为空 → 静默回落 CLOUD（避免死路），与 CLOUD 侧「无 cloud projects 不抢 existing 默认」同风格。
7. **文档同步**：CHANGELOG unreleased 碎片、`skills/mao-cli/` 的 Web 端本地任务能力说明。

### 2.2 不做的（本期明确排除）

- **不做远程新建本地工作区**：不在设备上浏览 / 创建目录，不出现设备端文件系统代理；下拉只列服务端已知（该用户有 LOCAL 会话）的工作区（用户已定）。
- **不做设备选择器 / 改绑**：设备绑定沿用工作区代表会话，不提供「换个设备执行」；沿用「创建即绑定、不可改绑」（2026-11-05 既定）。
- **不做服务端创建侧新校验**：不为浏览器创建路径增加「workspace 必须在列表中」之类的硬校验（LOCAL 信任模型与 2026-11-05 一致：伪造设备只会发送失败，无跨用户面）；列表下拉是唯一的产品入口。
- **不动 Electron 创建路径**：桌面端仍「选目录 + 绑定本机」，不带下拉（下拉对桌面端无增益且改动面变大）。
- **不动边路任务 / 子代理 / 惰性认领 / 技能 MCP 同步**：全部沿用。
- **不做总览改版**：任务索引面板的 LOCAL 分组展示不变，仅其复用链路被动打通。
- **不做附件远程化 / 本地技能设备快照 / 文件树终端远程代理**：仍是 2026-11-05 §9 的 P2 议题。

## 3. 技术选型（待评审确认后定案）

| # | 决策点 | 拟定 | 落选项与理由 |
|---|---|---|---|
| D1 | 模式语义 | 保持 LOCAL / CLOUD 两值；功能名「已有本地工作区新建本地任务」 | 与 2026-11-05 D1 同源：不新增模式，LOCAL 口径已收敛为「执行端 = 创建时绑定设备」，浏览器创建只是**绑定值的来源**从「本机」变为「工作区沿用」 |
| D2 | 设备沿用来源 | 服务端聚合：工作区代表会话（最近一条 `target_device_id` 非空的 LOCAL 主会话）的绑定；无绑定代表 → 新会话落 NULL → 惰性认领 ②/③ | 「绑定的设备以该工作区下已有会话所绑定的设备为准」的确定性实现；优先取绑定会话防止旧未绑定行掩盖真实绑定；代表会话同时提供 platform 等环境快照（同一路径在同一设备上，绑定与环境同源，不会错配）。**评审补充（反例与桌面端接管结论）**：① 用户换机后旧代表仍是陈旧设备 → 新会话定向到离线设备，属可接受启发式（下拉副标题显示设备名、创建前可见；桌面端新建一条即成为新代表，下拉自愈，详见 §6）；② 换到的设备 B 上同路径的未绑定会话**不会被代表选法改写**（认领只补 NULL 且仅在那些会话自身被发送时触发 ①）；③ 桌面端打开浏览器新建的会话**不做特殊处理**——绑定值非 NULL 永不触发认领改写，同机桌面 / CLI 共用 deviceId（`device-info.ts:9-10`、`prepareLocalTarget` 注释 `streaming-ws-handler.ts:2801-2804`）所以本机接管天然命中，陈旧设备的恢复路径与 2026-11-05 孤立绑定口径一致（重建 / 新建一条），不为它破坏「不可改绑」与 D15 并发语义 |
| D3 | 创建契约 | **复用 `POST /v1/sessions`，后端创建逻辑零改动**；浏览器回显设备与环境字段（显式值优先，Electron 语义不变） | 备选「服务端派生 + 请求开关」被否：需要在 `createSession` 加第二绑定来源分支与新契约字段；而回显方案复用既有字段与既有「显式值优先」语义，桌面端行为零变化。信任模型与 2026-11-05 相同：浏览器自报设备只能填本人 WS 注册过的 deviceId（否则 `sendToDevice` 落空），无跨用户面 |
| D4 | 工作区列表出口 | 新增 `GET /v1/sessions/local-workspaces`（对齐 `cloud-projects` 形态），服务端聚合 + 注入在线态 | 会话列表分页导致前端聚合不全；下拉需要在线态与代表会话快照，必须服务端算；一次 GROUP BY + 窗口函数出全量，无分页 |
| D5 | 前端入口形态 | 浏览器：LOCAL radio 在「有本地工作区条目」时可选；工作区选择为下拉（名称 + 设备 + 在线点）；Electron：现状不变 | 与 CLOUD「现有工作区」下拉同构，心智一致；radio 的 disabled 从「非 Electron」改为「非 Electron 且无条目」，总览预填 / 分组复用链路自动打通 |
| D6 | 发送时设备解析 | `useChat` 统一解析：① 本地工作区端点条目 → ② 会话实体回退（store 内同 workspace 且 `targetDeviceId` 非空的最近会话）→ ③ 都无则未绑定创建 | ① 覆盖下拉链路；② 覆盖端点请求失败但总览预填带路径的场景；③ 是「纯未绑定历史」的诚实兜底（不猜设备，交给惰性认领），仅在端点与会话实体都无数据时触达。**评审补充**：② 的前提成立——前端 `Session` 类型确带 `targetDeviceId`（`desktop/src/stores/session/types.ts:57-63`），实体来自 `sessionEntities` Map（`stores/session/list.ts:42`），列表 / 详情拉取时已 upsert |
| D7 | 环境快照沿用 | `platform / shell / osVersion / isGit` 随代表会话沿用，经既有 `environmentInfo` 形参进 payload | 这四个字段已随 POST 直通落库（`session.routes.ts:222-223` → `session.service.ts:165-167`）；`platform` 是惰性认领 ② 平台一致性校验与错误文案的输入（2026-11-05 §4.1-8，`isDevicePlatformCompatible` 在 `streaming-ws-handler.ts:2856-2860`），沿用值保证未绑定兜底路径的认领判定正确 |
| D8 | 模式默认回落 | 浏览器 + 默认 LOCAL + 本地工作区列表为空 → 静默回落 CLOUD | LOCAL 预填 + 空下拉是死路；与 `enterNewTaskMode` 既有的「有 cloud projects 才默认 existing」同风格，无 toast 打扰 |
| D9 | 安卓 | 零原生改动：Capacitor 远程加载同一 dist，自动获得同能力；安卓仅是消息入口，执行端仍是被沿用设备 | 与现状「安卓可接管 LOCAL 会话对话」一致；无 `Capacitor.isNativePlatform()` 分叉点 |
| D10 | 路径分组口径 | 按存储原样字符串精确分组，不做大小写 / 分隔符归一 | Windows 大小写混写是边缘脏数据；归一需要平台判断且可能合并两个真实不同目录，v1 不做（记入 §9 开放问题） |

## 4. 实现步骤

### 4.1 后端（backend-ts）

1. **仓库层聚合查询**（`backend-ts/src/session/session.repository.ts`）
   - 新增 `listLocalWorkspaceSummaries(userId: number): Promise<LocalWorkspaceSummaryRow[]>`，单条 SQL（MySQL 8 窗口函数）。**评审补充**：仓库层为手写 SQL 模板字面量风格，`ROW_NUMBER() OVER` 在本文件已有先例（`:1234/1272/1337/1360` 的消息去重查询），按 workspace 聚合的直接范本是 `aggregateWorkspaceUsage`（`:694-716`，工作区总览）：
     - 聚合层：`WHERE user_id = ? AND execution_mode = 'LOCAL' AND session_type = 'NORMAL' AND workspace IS NOT NULL AND workspace <> '' AND deleted = 0 AND source NOT IN ('embed', 'signal')`，`GROUP BY workspace`，产出 `session_count / active_sessions（status<>'ARCHIVED'）/ archived_sessions / last_active_at（MAX(updated_at)）`。**评审补充**：`deleted = 0` 必须带——全表统一软删约定（`notDeleted()`），漏掉会让已删除会话的绑定进代表选法与计数（范本 `aggregateWorkspaceUsage` 即带此条件）；`source NOT IN ('embed','signal')` 对齐前端分组口径（embed 归 `EMBED:` 分组、signal 归哨兵分组，`utils/cloud-project.ts:131-139`），避免系统 / SDK 会话的工作区混进新建下拉。**评审定案（2026-11-18 拍板）**：`NOT IN` **不扩至 `openapi`**——openapi 创建的 LOCAL 会话同为本人设备绑定，出现在下拉里语义正确，与 web/cli 来源同等对待；排除 embed/signal 的依据是「前端分组口径」，openapi 无此口径差异。
     - 代表层：同 WHERE，`ROW_NUMBER() OVER (PARTITION BY workspace ORDER BY (target_device_id IS NULL) ASC, updated_at DESC, id DESC)` 取 rn=1，产出 `target_device_id / target_device_name / platform / shell_path / os_version / is_git`。**评审补充**：末位加 `id DESC` 兜底同 `updated_at` 并列时的确定性（两台设备同秒绑定时仍取固定一条）。
     - 两层 `JOIN workspace` 后 `ORDER BY last_active_at DESC`。
   - 归档会话计入条目（目录仍有效、可继续建任务），代表会话不限 status（绑定不随归档失效）。
2. **路由端点**（`backend-ts/src/session/session.routes.ts`，紧邻 `GET /v1/sessions/cloud-projects`）
   - `GET /v1/sessions/local-workspaces`：`requireUserId` → repo 查询 → 映射 VO 条目（`name` 为路径尾段，服务端算好，兼容 `\` 与 `/`）→ 逐条注入 `targetDeviceOnline`（有绑定 → `deps.hasDeviceConnection(userId, deviceId)`；未绑定 → null）与 `executorClientType`（同 `enrichSessions` 的口径 `:180-197`），复用既有两个依赖回调（`SessionRouteDeps` `:73-78` 已声明、`create-app.ts:990-996` 已注入），**不引入 WS registry 依赖**。
   - 无数据返回 `[]`；不做分页（用户级 LOCAL 工作区数量小）。
   - **评审补充（路由顺序结论：无冲突）**：`GET /v1/sessions/:id` 与本端点同为三段路径，存在结构上的同层竞争，但 fastify 5 内置路由器 find-my-way 的匹配优先级是「静态段恒先于参数段，与注册顺序无关」（find-my-way README：*static routes are always inserted before parametric and wildcard*；匹配优先级列表 static > parametric）。本文件既有同层先例：`cloud-projects / groups / search / dashboard` 四个静态段与 `:id` 共存（`session.routes.ts:231/255/278/298` vs `:357`）。仍沿惯例把新端点注册在 `:id` 之前（紧邻 cloud-projects），并补一条「local-workspaces 返回聚合条目而非按 id 查会话」的防回归用例（防未来路由器行为变化 / 注册顺序被调整）。
3. **创建链路**：零改动。`POST /v1/sessions` 既有字段已覆盖浏览器回显（`normalizeTargetDeviceId`：字符集白名单 `/^[A-Za-z0-9_-]+$/` + 长度 ≤64 两步校验、name 去首尾空白 ≤128，定义在 `session.routes.ts:113-133`、POST 内调用在 `:218-219`）；`assertOwnedSessionWorkspace` 对 LOCAL 跳过路径归属校验（`session.routes.ts:730`：非 CLOUD 一律 return），信任模型不变。

### 4.2 契约与类型

- 不涉及 `@mao/contracts` 枚举（无新联合类型；`targetDeviceOnline` 是 `boolean | null`，与 2026-11-05 §4.2 同口径不入契约）。
- 新类型落点：后端 `session.routes.ts` 内联响应结构（或 `session/types.ts`，实现时择一）；前端 `desktop/src/stores/session/types.ts` 新增 `LocalWorkspaceSummary` 接口（与 `CloudProject` 同层）。

### 4.3 桌面端（desktop，Electron 与浏览器同 dist）

1. **store**（`desktop/src/stores/session/list.ts` + `types.ts`）
   - 新增 `localWorkspaces` state 与 `fetchLocalWorkspaces()`（对齐 `fetchCloudProjects` `:584-591`，失败静默回 `[]`）。
   - `createSession` 增可选末参 `browserLocalTarget?: { deviceId: string; deviceName: string } | null`：LOCAL 分支优先用显式值，缺省仍走 `getLocalDeviceInfo()`（Electron 原路径不动）；浏览器无设备文件，`getLocalDeviceInfo()` 本就返回 null（`device-info.ts:13`）。**评审补充（签名风格结论）**：`createSession` 现有 10 个位置形参（`list.ts:515-526`），本次**维持位置形参风格追加第 11 个可选形参**，不改 options 对象——生产调用点只有 `useChat.ts:451` 一处，但既有单测全部按位传参（`session-cloud-workspace.test.ts:34-105`、`session.test.ts:735+`），改对象签名会破坏全部既有用例且与团队现状风格不符；形参继续增长若成为负担，属后续独立重构。
2. **发送守卫收窄**（`desktop/src/composables/useChat.ts`、`desktop/src/components/chat/ChatInput.vue`）
   - `useChat.ts:395`：拦截条件 `executionMode === 'LOCAL' && !isElectron && !sessionId.value` 收窄为追加 `&& !workspace.value`；文案改为「请先选择一个已有本地工作区（浏览器只能复用桌面端已创建过的目录）」。
   - `ChatInput.vue:871`：同步收窄为 `props.executionMode === 'LOCAL' && !isElectronClient && props.isNewTask && !props.workspace`，文案同上。
   - **评审补充（第三处守卫，原方案遗漏）**：`ChatInput.handleModeChange`（`ChatInput.vue:929-935`，`mode === 'LOCAL' && !isElectronClient` 即弹警告）同样要收窄为「无本地工作区条目时才拦」——它被三处共用：docked `ChatNewTaskConfigBar` 的 radio `@change`（`ChatNewTaskConfigBar.vue:10` 经 `ChatInput.vue:26` 注入）、centered `WorkspaceChip` 的 `@update:execution-mode`（`ChatInputToolbar.vue:31`）、移动 `ChatMobileConfigRow`（`ChatInput.vue:150`）。漏改则浏览器即使解禁 radio / chip，一切到 LOCAL 也会被弹回，新建入口形同虚设。
   - 既有设备离线预检（`ChatInput.vue:879-882`）不动。**评审补充（口径修正）**：该预检要求 `!props.isNewTask`，且 `ChatPanel.vue:208-209` 在新建态显式传 `targetDeviceOnline: null`——所以**浏览器新建 LOCAL 的首发不会触发前端设备名预检**，而是由服务端硬校验兜底（绑定设备不可达 → 错误帧「本地执行端未连接，请确保桌面客户端正在运行」，`streaming-ws-handler.ts:79/:853-861`）；建会话成功后切出新建态，VO 带 `targetDeviceOnline`，从第二条消息起前端预检生效。「创建前感知离线」由下拉条目的在线点承担（§4.3-4）。§7-12 手工预期按此修正。
3. **发送时解析与创建**（`useChat.prepareAndSendMessage` 创建分支）
   - 新增纯函数 `resolveBrowserLocalTarget(workspace, localWorkspaces, sessionEntities)`（落 `utils/` 便于单测）：按 D6 顺序解析，产出 `{ deviceId, deviceName, environmentInfo: { platform, shell, osVersion, isGit } } | null`；浏览器 LOCAL 创建时将其传给 `store.createSession`（`environmentInfo` 走既有形参，设备走新增形参）。
   - 解析产物为 null（纯未绑定历史）→ 不带设备创建（未绑定），后续交惰性认领。
   - **评审补充（embed 会话不影响）**：② 的会话实体回退按「同 workspace + `targetDeviceId` 非空」精确匹配，embed 来源会话即使混在 `sessionEntities` 里（`GET /v1/sessions` 主列表不过滤 source，`session.service.ts:433-452`），只要路径相同、绑定非空，回退结果也仍是用户本人设备的合法绑定；且 embed 会话在前端归 `EMBED:` 独立分组（`utils/cloud-project.ts:132-134`），不会进入 LOCAL 组预填链路。端点侧已在 SQL 排除（§4.1-1），双侧一致。
   - Electron 分支（选目录、`getEnvironmentInfo`、绑定本机）一字不动。
4. **新建配置 UI**
   - `ChatNewTaskConfigBar.vue`：LOCAL radio `:disabled="!isElectronClient && localWorkspaces.length === 0"`（`:17`），tooltip 按端分叉（`:16` 现文案「需要桌面应用保持连接」对浏览器不再准确，浏览器文案说明「在已有本地工作区新建，需对应设备在线」）；LOCAL 工作区分支（`:38-49`）：Electron 保留「点击选目录」，浏览器渲染 `el-select`（条目：目录名，副标题：设备名 · 在线/离线，同 `:57-80` 的 `cloud-project-option` 结构）。
   - `WorkspaceChip.vue`（centered 布局）：`switchMode` 的浏览器 LOCAL 拦截（`:206-214`）从无条件改为「无本地工作区条目时才拦」，文案同步。**评审补充**：LOCAL 按钮的禁用点有**两处**——popover（`:38`，带 title `:39`）与移动端抽屉（`:95`，无 title），两处都要改成「非 Electron 且无条目」；两处按钮均带可见文本「本地」，不属 AGENTS.md「图标按钮必须带 aria-label / title」的强制场景，抽屉按钮可顺带补 title 与 popover 对齐（可选）。
   - `WorkspaceConfigFields.vue`（新建配置抽屉）：LOCAL 段（`:57-66`）浏览器渲染同款下拉，Electron 保留 `selectWorkspace` 按钮；「浏览器端不能选择本地目录」警告仅 Electron 缺 API 时出现（现状 `:109-117`）。
   - **评审补充（移动端抽屉形态）**：抽屉与 popover 复用同一套组件——`WorkspaceChip` 的 `isMobile` 分支渲染 `el-drawer`（`:78-117`），内嵌同一 `WorkspaceConfigFields`（`:is-mobile="true"`，放大触屏控件尺寸 `:84/:88`）；移动视口下该 chip 由 `ChatMobileConfigRow` 渲染（`ChatMobileConfigRow.vue:3-29`），无独立实现。因此上面两条改动自动覆盖移动端抽屉，无需单独分支；`WorkspaceChip.switchMode` / `ChatInput.handleModeChange` 的收窄同样同时覆盖抽屉内切换。
5. **TaskView 接线**（`desktop/src/views/task/TaskView.vue`）
   - `enterNewTaskMode`（`:1239-1315`）：与 `fetchCloudProjects` 并行 `fetchLocalWorkspaces()`，按 D8 回落（浏览器 + 默认 LOCAL + 列表空 → CLOUD）；浏览器选中下拉条目时写入 `newTaskWorkspace`（发送时由 useChat 解析设备，不在 TaskView 单独暂存设备字段）。
   - **评审补充（默认 LOCAL 的另一条来源）**：除 `enterNewTaskMode` 的 defaults / resolved 路径外，`lastViewedSession` 分支（`:1641-1656`）也会把默认模式置为上次会话的 LOCAL 并预填其 workspace——该分支**自带 workspace**，守卫收窄后天然放行、D6 可解析（上一条 LOCAL 会话本身就会成为端点条目 / store 实体），不会死路，**不需要 D8 回落**；D8 只需覆盖 `enterNewTaskMode` 的解析结果（`:1272-1297`）。
   - 总览「用于新任务」LOCAL 组预填链路不改代码，被动打通（预填 workspace 在发送时走 §4.3-3 解析）。
6. **既有测试同步**：`useChat.test.ts:522/538` 的拦截断言按新条件改写（无工作区拦截 / 有工作区放行并带设备回显）。

### 4.4 安卓（android）

- 零改动：远程加载 web dist，自动获得能力；不涉及 `MainActivity.java`、OTA、`capacitor.config.json`。

### 4.5 终端 CLI（agent-cli）

- 零改动：CLI 创建 LOCAL 仍绑定本机（2026-11-05 D13/D14 口径）。

### 4.6 数据库迁移

- **无迁移**：不新增列、不新增表；`session` 表既有列足够聚合。当前最新迁移为 V196，本方案不占用新号。

## 5. 落地清单

| 端 / 文档 | 项 |
|---|---|
| backend-ts | `session/session.repository.ts`（`listLocalWorkspaceSummaries`）、`session/session.routes.ts`（`GET /v1/sessions/local-workspaces` + 响应映射 + 在线态注入）、响应类型落点（`session/types.ts` 或内联） |
| contracts | 无变更 |
| desktop | `stores/session/types.ts`（`LocalWorkspaceSummary`）、`stores/session/list.ts`（state + `fetchLocalWorkspaces` + `createSession` 增参）、`utils/`（`resolveBrowserLocalTarget` 纯函数）、`composables/useChat.ts`（守卫收窄 + 浏览器创建传参）、`components/chat/ChatInput.vue`（守卫收窄 + **评审补充**：`handleModeChange` 收窄）、`components/chat/ChatNewTaskConfigBar.vue`（radio 条件 + tooltip 分叉 + 浏览器下拉）、`components/chat/WorkspaceChip.vue`（switchMode 口径 + **评审补充**：popover / 抽屉两处按钮禁用条件与抽屉按钮 title）、`components/chat/WorkspaceConfigFields.vue`（LOCAL 段下拉）、`views/task/TaskView.vue`（fetch + 默认回落 + props 接线）、`useChat.test.ts` 等既有用例同步 |
| android / agent-cli | 无改动 |
| 迁移 | 无 |
| 测试 | 见 §7 |
| 文档 | `changelog/unreleased/2026-11-17-web-create-local-task-in-existing-workspace.md`（后端 + 前端（桌面 / Web）小节）；`skills/mao-cli/reference/desktop.md` 的 Web 端本地任务段落 |

## 6. 风险与回归护栏

| 风险 | 护栏 |
|---|---|
| 同一路径先后绑过两台设备（换机重装） | 代表会话取「最近绑定」，下拉与新会话都指向最新设备；旧设备的历史会话仍按各自绑定执行（会话级绑定互不影响）。下拉副标题展示设备名，用户可见执行端 |
| **评审补充**：代表绑定陈旧（设备身份变化——换机、清理 userData / `~/.mao/`，旧 deviceId 永久失配），浏览器新建的任务全部定向到已消失的设备 | 与 2026-11-05 孤立绑定同一口径：会话显示离线、发送报「本地执行端未连接」。**不为桌面端接管做特殊处理**（结论见 D2）：同机桌面 / CLI 共用 deviceId（`device-info.ts:9-10`）本机接管天然命中；改绑会破坏「创建即绑定、不可改绑」与惰性认领的条件更新语义。**自愈路径**：用户在目标机器的桌面端对该工作区新建一条 LOCAL 任务（绑定当前设备、成为新代表），后续浏览器新建即沿用新设备；CHANGELOG / tooltip 写明「下拉显示的设备即执行端」 |
| **评审补充**：用户换到设备 B 后，B 上同路径的未绑定历史会话与「代表沿用」的交互 | 互不改写：B 端未绑定会话只在 B 端实际发送时被惰性认领 ① 改写为 B（条件更新只补 NULL、只影响那些会话自身）；浏览器新建的会话落代表的显式值（非 NULL），永远不会被认领覆盖。用户想让浏览器新任务落到 B：在 B 桌面端新建一条即可（同上自愈路径） |
| 孤立绑定（设备身份丢失 / 换机后旧 deviceId 永久离线） | 沿用 2026-11-05 已明示口径：会话显示离线、无法发送，恢复路径为桌面端重建会话；下拉条目对该设备显示离线点，用户创建前即可感知 |
| 列表陈旧（拉取后、创建前工作区绑定被桌面端改写——如桌面重新认领） | 绑定写路径本就只有「创建落值 / 惰性认领补 NULL」，无改绑；窗口内的陈旧值仍是本人设备，发送时服务端 `isConnected` 设备级权威校验兜底 |
| 浏览器伪造 / 误传 deviceId | 只能填该用户 WS 注册过的设备才可送达；伪造值 → `sendToDevice` 落空 → 发送报「本地执行端未连接」，无跨用户读写面（与 2026-11-05 信任模型一致，不新增校验） |
| 纯未绑定历史工作区被浏览器新建 | 走 D6-③ 未绑定创建 + 惰性认领 ②/③；多台在线时发送被拒并提示登记，与既有历史会话体验一致 |
| 浏览器误以为可以任选目录 | 「选择本地目录」按钮保留 Electron-only（`WorkspaceConfigFields` / `ChatInput` 既有警告不动）；下拉仅列服务端已知工作区；CHANGELOG 与 tooltip 写清边界 |
| 附件 / 本地技能能力缺失被误认为 bug | 新会话与「接管已有 LOCAL 会话」完全同权：非图片附件既有拦截按 `executionMode==='LOCAL'` 自动覆盖新会话；tooltip / 文档写明 |
| LOCAL 预填 + 空列表死路 | D8 静默回落 CLOUD；`WorkspaceChip` 浏览器切 LOCAL 仅在有条目时放行 |
| 聚合查询性能 | 用户级 LOCAL 会话量小（单用户单条 SQL）；`user_id` 等值过滤走既有索引；如线上变慢再议覆盖索引，不预先加 |
| 发布顺序 | 后端先上（新端点就绪），再 `deploy-desktop.sh`；顺序颠倒时新前端请求 404 → `fetchLocalWorkspaces` 静默回 `[]` → radio 禁用，回到现状，无坏状态 |

## 7. 测试要点

**后端（`cd backend-ts && npm test`）**

1. `session.routes.spec.ts` 新增 local-workspaces 端点用例：多工作区聚合与排序（按最近活跃）；代表会话优先取绑定行（绑定旧行 vs 未绑定新行 → 取绑定）；无绑定工作区设备字段为 null；`session_type='SIDE_TASK'/'SUBAGENT'` 与 CLOUD 会话不混入；`workspace IS NULL` 行不混入；`targetDeviceOnline` 三态（绑定在线 true / 绑定离线 false / 未绑定 null）；`executorClientType` 回填；未登录 401。**评审补充**：路由顺序防回归用例——`GET /v1/sessions/local-workspaces` 命中聚合端点而非落入 `:id`（静态段优先于参数段，见 §4.1-2）。
2. `session.repository.spec.ts`：`listLocalWorkspaceSummaries` 的 SQL 行为（真实内存库或既有测试基建）：归档会话计数口径、`active_sessions`/`archived_sessions`、`last_active_at`、路径精确分组（大小写不归一）。**评审补充**：软删（`deleted=1`）会话不参与计数与代表选法；`source='embed'/'signal'` 会话不混入；代表层 `updated_at` 并列时 `id DESC` 确定性（两次执行结果一致）。
3. 创建回归（既有用例不回退）：POST 带 `targetDeviceId + platform + shell` 建 LOCAL 落库（既有）；CLOUD 忽略设备字段（既有）。

**前端（desktop 单测 + build）**

4. `resolveBrowserLocalTarget`：端点条目命中；端点未命中回落会话实体（取最近绑定）；全无 → null；环境快照透传。
5. `useChat`：浏览器 + LOCAL + 新建 + 无 workspace → 拦截（新文案）；+ 有 workspace → 放行且 `createSession` 收到 `browserLocalTarget` 与 `environmentInfo`；Electron 路径 payload 与改动前一致（回归）。
6. `ChatInput`：`isNewTask + LOCAL + 浏览器 + 无 workspace` 拦截；有 workspace 放行；已有会话（非新建）不受影响（既有断言）。**评审补充**：`handleModeChange` 浏览器两分支——有本地工作区条目时切 LOCAL 放行、无条目时拦截（文案与 WorkspaceChip.switchMode 一致）。
7. 配置 UI：浏览器有/无条目时 radio 可用性；下拉条目渲染（设备名 + 在线态）；Electron 仍渲染目录按钮；`WorkspaceChip.switchMode` 浏览器两条分支。
8. `TaskView`：默认 LOCAL + 浏览器 + 空列表回落 CLOUD；有条目不回落；总览 LOCAL 组预填在浏览器发送不再被拦（集成于 useChat 用例）。
9. `cd desktop && npm run build`（vue-tsc 强校验）。

**手工联调（必须）**

10. 桌面端建 LOCAL 任务于 `D:\proj` → 浏览器新建 → 本地模式下拉出现 `proj · 设备名 · 在线` → 选中发送 → 工具在桌面端执行、审批卡按会话等级弹出、流式回传。
11. 安卓 APP 同链路验证（WebView 内新建 + 对话 + 目标机执行）。
12. 目标设备离线时：下拉条目显示离线 → 仍可创建 → **评审补充（预期修正）**：新建首发不走前端设备名预检（该预检仅已有会话生效，`ChatInput.vue:879` 要求 `!isNewTask`、`ChatPanel.vue:208-209` 新建态传 null），被服务端兜底错误帧「本地执行端未连接，请确保桌面客户端正在运行」拦截；建会话成功后从第二条消息起前端按 `targetDeviceOnline` 以设备名提示；设备上线后发送成功。
13. 纯未绑定历史工作区：浏览器新建 → 唯一在线同平台设备 → 首发认领定向；多台在线 → 被拒提示登记。
14. 桌面端创建路径回归：选目录 → 绑定本机 → 与改动前一致；总览「用于新任务」两条链路（CLOUD / LOCAL）桌面端无变化。
15. **评审补充**：桌面端打开浏览器新建的会话——同机（桌面 / CLI 共用 deviceId）打开 → 定向本机正常执行；异机打开 → 定向到原绑定设备（原设备在线则在原设备执行、本机只看流；原设备离线则报「本地执行端未连接」）。
16. 浏览器新建的 LOCAL 会话内：非图片附件被拦、图片可用、审批等级可切（与接管已有会话一致）。

## 8. 发布与文档

1. **发布顺序**：先部署 backend-ts（新端点），再 `bash scripts/deploy-desktop.sh`（web/Electron/安卓共用 dist）；无需发 mao-agent，无需迁移，无需重启特殊步骤（随部署既有流程）。
2. **CHANGELOG**：`changelog/unreleased/2026-11-17-web-create-local-task-in-existing-workspace.md`——后端：新增本地工作区聚合端点；前端（桌面 / Web）：浏览器与安卓可在已有本地工作区新建本地任务（执行端沿用工作区绑定设备；不支持远程挑选 / 新建本地目录；设备离线时创建后需等设备上线再发送）。
3. **mao-cli 文档**：`skills/mao-cli/reference/desktop.md` Web 端本地任务段落补「可新建（仅限已有工作区）」口径。
4. **回滚**：代码回滚即可，无数据副作用（新会话就是普通 LOCAL 会话行）。

## 9. 开放问题（不阻塞主链路）

1. **远程新建本地工作区**：需要设备端目录浏览 / 创建的 WS 代理，工作量级显著更大，独立方案（用户已明确排除）。
2. **同路径大小写归一**（Windows `D:\Proj` vs `d:\proj`）：脏数据边缘，若实际出现再做归一展示。
3. **本地工作区进总览**：任务索引面板 LOCAL 分组与服务端聚合条目合并为统一「工作区视图」（含大小 / 在线态富化），P2。
4. **Electron 复用下拉**：桌面端新建时也可从「已有本地工作区」下拉选（替代每次选目录），体验增强，P2。
