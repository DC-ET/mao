# 代码审查报告：本地任务跨设备委托（round 1）

- 审查日期：2026-11-05
- 审查对象：worktree `.worktrees/local-task-device-delegation`（分支 `feat/local-task-device-delegation`，基线 `main` 5a9b14a1）中**全部未提交改动**（`git status` 的 M + ??），涉及 backend-ts / desktop / agent-cli 三端
- 依据方案：`docs/plan/2026-11-05-local-task-device-delegation-technical-design.md`
- 审查方式：逐文件读 diff + 用真实类（`StreamingWsRegistry` / `LocalToolSessionRegistry` / `StreamingWsHandler`）补写端到端与边界用例做行为验证，未修改任何业务代码

## 1. 总体结论

**可合并**：未发现阻塞项（主链路正确）。共 3 个问题：1 个重要、2 个次要（建议）。

回归基线（本机实测，均通过）：`backend-ts` vitest 全量 456 文件 / 5519 用例；`agent-cli` vitest 全量 54 文件 / 613 用例；`desktop` vitest 141 文件 / 1413 用例（另有 23 个既有测试文件因本机 undici 无法启动 worker，与本次改动无关）；`node --test electron/*.test.cjs` 196 用例（195 通过 + 1 skip）；`backend-ts npm run build`、`desktop npm run build` 通过。

| # | 严重度 | 一句话 | 位置 |
|---|---|---|---|
| 1 | 重要 | 同一 deviceId 存在多条连接时，**执行连接断开会把整个设备判离线**：仍存活的同设备连接不再收到定向投递，且在途工具请求被误杀 | `backend-ts/src/session/ws/streaming-ws-registry.ts:219-231`、`:429-443`、`:389`；`backend-ts/src/session/ws/streaming-ws-handler.ts:430-446` |
| 2 | 建议 | 边路任务面板（`SideChatPanel`）未传目标设备字段：**已绑定设备的本地会话被显示为「未登记执行端」**，浏览器端"设备离线"发送前置拦截在边路面板失效 | `desktop/src/components/chat/SideChatPanel.vue:124-144`（影响 `ChatInputToolbar.vue:58-63,181-193`、`ChatInput.vue:1145`） |
| 3 | 建议 | CLI 设备身份在落盘失败时**不稳定**：同一进程内每次解析都生成新 `deviceId`，重连即变成"新设备"，其绑定的 LOCAL 会话随即不可用 | `agent-cli/src/local/device-identity.ts:26-46,59-65`（由 `src/ws/ws-client.ts:220` 每次连接调用） |

主链路（创建即绑定、定向投递、历史会话惰性认领三档、不可改绑、断线清理、派生继承、技能/MCP 定向、VO 在线态）经真实注册表补测**行为正确**，详见 §3。

## 2. 问题详情

### 问题 1（重要）：同一设备多连接时，执行连接断开会把设备整体判离线

**位置**
- `backend-ts/src/session/ws/streaming-ws-registry.ts:219-231` `releaseDevice()`：仅当 `executors.get(device.id) === session` 时**直接删除**该 device 的执行连接，没有回落到同设备其它存活连接
- `backend-ts/src/session/ws/streaming-ws-registry.ts:436-443` `getOnlineDeviceIds()`、`:429-434` `hasDeviceConnection()`、`:389-413` `sendToDevice()`：三者都只认 `deviceExecutors[userId][deviceId]` 这一条"执行连接"
- `backend-ts/src/session/ws/streaming-ws-handler.ts:438-442` `afterConnectionClosed()`：`unregister` 之后用 `!hasDeviceConnection()` 判断"设备已无连接"，从而调用 `failAllForDevice`

**问题描述**

方案 D4 明确要支持"同一 deviceId 多连接（同机多窗口 / 多实例）"：后注册的连接覆盖为执行连接（`register` 里 `executors.set(device.id, session)`，`:187`）。但 delete 路径没有对称处理：**较新的执行连接断开时，`releaseDevice` 把 `deviceExecutors[userId][deviceId]` 整条删掉，而同设备仍存活的旧连接（`connectionDevice` 里仍登记着 `deviceId`、`readyState` 仍为 OPEN）不会替补**。

结果：设备被判"离线"，且该状态**不会自愈**（存活连接不会重新 register，直到它自己重连）。

**影响（可复现）**

1. `hasDeviceConnection()` → false、`getOnlineDeviceIds()` 不再包含该设备、`sendToDevice()` 投递 0 条。
2. 该设备绑定的 LOCAL 会话 `isConnected()` → false：发送被服务端拒（`Local client is not connected`）；`GET /sessions` 的 `targetDeviceOnline` → false，浏览器端 badge 显示"离线"并在发送前直接拦截。
3. `afterConnectionClosed` 会调用 `failAllForDevice(userId, deviceId)`，把该设备上**正在执行**的工具请求全部失败（`Device disconnected`）——即使实际执行端仍在运行。

真实触发场景：同一台机器上同时跑两个 `mao-agent`（同一个 `~/.mao/agent-cli/device.json` → 同一个 deviceId；两个交互式 CLI 进程是很常见的用法，例如两个目录各开一个终端）。关掉其中一个，另一个的 LOCAL 会话立刻被判离线、在途工具失败。设计里"同机多窗口/多实例"的假设同样命中这条路径。

**复现/验证**

```bash
cp docs/code-review/repro/backend-device-executor-release.probe.spec.ts backend-ts/src/__probe__/
cd backend-ts && ./node_modules/.bin/vitest run src/__probe__/backend-device-executor-release.probe.spec.ts
```

当前结果：2 个用例全部失败（即缺陷成立）。

- 用例 1：注册两条同 device 连接（ws-1、ws-2）→ `unregister(ws-2)`（执行连接）后 `ws-1` 仍 `WS_OPEN`、仍登记该 device，但
  `hasDeviceConnection(7,'dev-x')` = **false**（期望 true）、`getOnlineDeviceIds(7)` = **[]**（期望 `['dev-x']`）、
  `sendToDevice(...).successCount` = **0**（期望 1）。
- 用例 2：会话 11 绑定 `dev-x` 并发起工具请求 → `unregister(ws-2)` 后 `afterConnectionClosed(ws-2)`：
  `failAllForDevice(7,'dev-x')` 被调用、在途请求被 resolve 成 `Device disconnected`；随后的 `sendToolRequest()`
  返回 `requestId = null`（即 "Local client is not connected"，被直接拒绝）。而 `ws-1` 全程 `WS_OPEN`。

**修复建议**

- `deviceExecutors` 改为 `Map<userId, Map<deviceId, Set<WsSocket>>>`（或在 `releaseDevice` 里回扫 `connectionDevice` + `userSessions`）；
  当前离线连接是本设备最后一条时正常删除，否则**提升另一条可用连接**为执行连接。
- `hasDeviceConnection` / `getOnlineDeviceIds` / `sendToDevice` 统一按"该设备任一可用连接"判定，这样
  `afterConnectionClosed` 里的 `!hasDeviceConnection(...) → failAllForDevice` 才真正等价于"设备已无连接"。
- 补测：同设备两条连接 → 断执行连接后仍在线、可投递、在途请求不被失败；两条都断开后才 `failAllForDevice`。

### 问题 2（建议）：边路任务面板未传目标设备字段，已绑定会话显示为「未登记执行端」

**位置**
- `desktop/src/components/chat/SideChatPanel.vue:124-144`：`<ChatInput>` 传了 `:execution-mode="parentExecutionMode"`、`:is-new-task="false"`，但**没有** `target-device-name` / `target-device-online`
- `desktop/src/components/chat/ChatInputToolbar.vue:58-63,181-193`：非 CLOUD 且非新建态就渲染 `.device-badge`，`targetDeviceName` 为空即输出「本地任务 · 未登记执行端」，tooltip 为"该历史本地任务还未登记执行端，请在桌面客户端打开一次完成登记"
- `desktop/src/components/chat/ChatInput.vue:1141-1146`：浏览器端离线发送前置拦截条件依赖 `props.targetDeviceOnline === false`

**问题描述**

主会话面板（`ChatPanel.vue:184-185`）已正确透传两个字段，但边路任务面板漏了。`ChatInput` 的这两个 prop 默认是 `null`，所以在 `SideChatPanel` 里：

- 任何 LOCAL 主会话下的边路任务（`isNewTask=false`、`executionMode=LOCAL`）输入区都恒显示「本地任务 · 未登记执行端」+ 误导性提示，**与"该边路会话已继承父会话绑定"的事实矛盾**（新建边路已在 `handleCreateSideSession` 落 `targetDeviceId/Name`，历史边路同样可能已绑定）。
- `targetDeviceOnline` 恒为 `null` → `ChatInput.handleSend` 的离线拦截永远不会命中：浏览器在边路面板里对已离线绑定设备发送时不会被前置拦住，只能拿到服务端英文兜底报错（与主面板行为不一致）。

**复现/验证**

```bash
cp docs/code-review/repro/desktop-side-panel-device-badge.probe.test.ts desktop/src/components/chat/
cd desktop && npx vitest run src/components/chat/desktop-side-panel-device-badge.probe.test.ts
```

当前结果：3 个用例通过（断言的是"现状即缺陷"），证据：

1. 结构断言：`SideChatPanel.vue` 的 `<ChatInput .../>` 传参里有 `execution-mode`，**没有** `target-device-name` / `target-device-online`；
2. 按该传参 SSR 渲染 `ChatInputToolbar`（`executionMode=LOCAL`、`isNewTask=false`）：badge 文案为「本地任务 · 未登记执行端」，title 含"还未登记执行端"；
3. 对照：传入 `targetDeviceName='Mac A' / targetDeviceOnline=true`（主面板行为）时渲染为含「Mac A」+「在线」，不再出现"未登记执行端"。

**修复建议**

`SideChatPanel` 从当前边路会话实体（`sessionStore.getSessionEntity(sideSessionId)`，其 VO 已含 `targetDeviceName/targetDeviceOnline`）或父会话读取这两个字段并透传给 `<ChatInput>`；`targetDeviceOnline` 缺失时的降级（null 不拦截）保持不变。

### 问题 3（建议）：CLI 设备身份在落盘失败时不稳定（每次解析都生成新 deviceId）

**位置**
- `agent-cli/src/local/device-identity.ts:26-35` `readDeviceId()`：任何失败（含"写盘失败导致文件不存在"）都返回 null
- `agent-cli/src/local/device-identity.ts:59-65` `resolveDeviceIdentity()`：`readDeviceId` 为 null 时**每次** `crypto.randomUUID()` 并尝试写盘，无进程内缓存
- 触发点：`agent-cli/src/ws/ws-client.ts:220` 在**每次连接（含每次重连）**执行 `device: this.opts.getDevice?.() ?? resolveDeviceIdentity()`

**问题描述**

注释与方案都声称设备身份"跨会话、跨进程稳定"，并写明"写盘失败不阻断运行：本次进程使用内存值"。但实现没有内存缓存：当 `~/.mao/agent-cli/device.json` 写不进去（HOME 只读、磁盘满、目录权限异常、`$HOME` 指向不可写路径等）时，**同一进程内两次调用会返回两个不同 id**。由于 WS 重连每次都重新解析，客户端会以"新设备"身份注册：

- 该 CLI 之前创建/绑定的 LOCAL 会话（创建即定、不可改绑）立刻变成"设备离线"，工具全部无法执行，只能重建会话；
- 服务端注册表里同一台机器出现多条 deviceId，在线态/定向投递随之漂移（直到进程重启且仍写不进盘）。

**复现/验证**

```bash
cp docs/code-review/repro/cli-device-identity-stability.probe.spec.ts agent-cli/test/
cd agent-cli && npx vitest run test/cli-device-identity-stability.probe.spec.ts
```

当前结果：可写路径用例通过；不可写路径用例**失败**：

```
× 不可写路径：同一进程内多次解析应保持同一 deviceId（当前实现每次生成新值）
  → expected '0dbeed59-…' to be 'ff133443-…'
```

（用"父路径是普通文件"模拟写盘必然失败：`mkdir/rename` 失败、`readDeviceId` 恒为 null。）

**修复建议**

`resolveDeviceIdentity` 增加按 `file` 路径的模块级缓存（写盘失败时复用内存值），或在 `chat.ts` / `WsClient` 构造时只解析一次并把结果注入（`getDevice`）——后者已有注入口，只需在 CLI 装配处补上。

## 3. 已检查范围与结论（未发现问题）

已逐文件读完的改动（M/??）：`backend-ts` 的 registry / handler / local-tool-session-registry / session.service / session.repository / session.routes / session-vo / types / deps / app-routes / create-app / 三处 delegate（subagent-invocation、subagent-execution-recovery、background-subagent-manager）/ V186；`desktop` 的 desktopPrefs.cjs / main.cjs / preload.cjs / device-info.ts / useStreamWS.ts / useChat.ts / ChatInput.vue / ChatInputToolbar.vue / ChatPanel.vue / chat-input.css / stores（session/list.ts、session/types.ts）/ types；`agent-cli` 的 device-identity.ts / ws-client.ts / chat.ts / rest/types.ts；以及全部新增/改动测试。以下为逐项验证结论，**未发现功能 bug**：

- **注册表设备维度**：`register` 设备的 client 白名单（browser/android 不登记）、同 socket 换 device 释放旧映射、同 device 覆盖为最新执行连接、旧连接 `unregister` 不清掉新连接、`sendToDevice` 只命中目标 socket / 无连接返回全零、`getDevice/getDeviceInfo/getDeviceId/getOnlineDeviceIds` 口径、`isConnectionAuthorized` 过期连接不算在线。
- **auth 帧设备解析**：三字段非空 + 长度上限才生效，非法按旧客户端处理（连接仍可用）。
- **惰性认领三档**：① 发起连接自带设备 → 认领；② 无设备身份的连接 + 唯一在线且平台一致 → 认领；② 平台不符 / 多台 → 返回按 `session.platform` 生成的引导文案并拒绝执行；③ 无任何带 deviceId 连接 → 保持广播；socket 缺失（队列消费 / 定时任务）不认领、只沿用已绑定值。
- **不可改绑**：`claimTargetDevice` 仅 `WHERE target_device_id IS NULL`、冲突时读回现值；`PATCH /v1/sessions/:id` 无该字段；`updateById` 不写这两列。
- **断线清理编排**：`getDeviceId` 在 `unregister` 前取、`failAllForDevice` 只失败该设备绑定会话的 pending、`failAllForUser` 行为未回退（问题 1 是其"执行连接唯一"前提失效后的放大，见 §2）。
- **派生继承**：边路任务（新建）、子代理（新建）、边路提升三处均落库继承；子代理/父会话对象都从 DB 现读，不存在"认领后内存快照仍为 NULL"导致的漏继承。
- **技能 / MCP 同步定向**：有绑定 → `sendToDevice`，无绑定 → `sendToLocalClients`（用真实 handler 补测过两种分支）。
- **会话字段与接口**：`POST /v1/sessions` 校验（长度/字符集/去空白/空值归 null）、CLOUD 忽略、`session` 表 insert 透传、`SELECT *` 的 snake→camel 映射、VO 三字段、`enrichSessions` 注入 `hasDeviceConnection` 后 `targetDeviceOnline` 的 true/false/null 三态。
- **V186 迁移**：文件名/语法/列宽（64/128）与校验白名单一致，存量 NULL 不回填。
- **桌面端**：`desktopPrefs` deviceId（首次生成→落盘→重读稳定、脏值重建、`desktopPrefsSet` 无法改写 deviceId）、`device-info-get` IPC / preload / 类型、Electron auth 帧含 device 且仍是首帧、`list.ts` 建 LOCAL 会话带 `targetDeviceId/Name`、`useChat` 与 `ChatInput` 的"浏览器新建拦 / 已有会话放行"边界、附件与粘贴文案、`ChatPanel` 透传。
- **CLI**：`~/.mao/agent-cli/device.json` 生成/读取/脏值重建、auth 帧上报、`--local` 建会话带绑定、`getDevice` 注入口。

补充：本次用真实注册表做了端到端补测（浏览器在未绑定历史会话上发送 → 认领 → 工具只投递给该设备；两台在线 → 拒绝执行；已绑定 + 绑定设备在线 → 只到绑定设备；已绑定 + 绑定设备离线 → 拒绝发送），4 个用例全部通过，见
`docs/code-review/repro/backend-device-delegation-e2e.probe.spec.ts`；另有 5 个用例覆盖定向投递/断线清理/技能同步方向/边路继承/订阅认领，见 `backend-device-delegation.probe.spec.ts`。

## 4. 仍存风险（方案已声明接受或有明确理由，未计入 bug）

1. **队列消费 / 定时任务 / Webhook 入口不认领**（无 socket）：未绑定的历史 LOCAL 会话在这些入口仍走用户级广播，多台新设备在线时可能出现重复执行（方案 §4.1-8 明确"不得放到执行态入口"，属有意取舍）。
2. **升级前创建的历史边路任务 / 子代理**（`target_device_id = NULL`）不会从父会话补绑：这类会话在浏览器 + 多设备在线时会被拒（"请登记执行端"），或在桌面端发送时按 ① 认领到当时发起的机器（可能与该会话 workspace 所在机器不同）。子代理 followup 只把父设备写进内存、未回写 DB，后端重启后同样退回广播。
3. **`targetDeviceOnline` 是请求时快照**：浏览器停留在页面期间设备"离线→上线"不会自动刷新，前端会持续拦截发送，需刷新页面/重进会话（方案已声明快照语义）。
4. **浏览器接管 LOCAL 会话时本地技能 / AGENTS.md 被清空**（发送帧不带 `localSkills`/`agentsMdContent`，服务端 `report(sessionId, undefined)` 会 delete）：方案 P1 明确降级为空。
5. **同一 `deviceId` 被复制到另一台机器 / 用户手动删除 `desktop-prefs.json`**：旧绑定成为孤立绑定（会话永远离线），方案已声明"重建会话"为恢复路径。

## 5. 复现用例清单

| 文件（`docs/code-review/repro/`） | 对应问题 | 运行方式 | 现状 |
|---|---|---|---|
| `backend-device-executor-release.probe.spec.ts` | 问题 1 | 拷到 `backend-ts/src/__probe__/` → `cd backend-ts && ./node_modules/.bin/vitest run src/__probe__/backend-device-executor-release.probe.spec.ts` | 2 用例失败（缺陷成立） |
| `desktop-side-panel-device-badge.probe.test.ts` | 问题 2 | 拷到 `desktop/src/components/chat/` → `cd desktop && npx vitest run src/components/chat/desktop-side-panel-device-badge.probe.test.ts` | 3 用例通过（断言现状即缺陷） |
| `cli-device-identity-stability.probe.spec.ts` | 问题 3 | 拷到 `agent-cli/test/` → `cd agent-cli && npx vitest run test/cli-device-identity-stability.probe.spec.ts` | 1 通过 / 1 失败（缺陷成立） |
| `backend-device-delegation.probe.spec.ts` | 无缺陷（回归证据） | 拷到 `backend-ts/src/__probe__/` 后同上运行 | 5 通过 |
| `backend-device-delegation-e2e.probe.spec.ts` | 无缺陷（回归证据） | 同上 | 4 通过 |

> 说明：`backend-ts` 的 vitest `include` 为 `src/**/*.spec.ts`、`desktop` 为 `src/**/*.test.ts`、`agent-cli` 为 `test/**/*.spec.ts`，因此复现用例需拷回对应目录再运行；运行结束后删除即可，不影响业务代码。
>
> 全部探针文件已从三端源码目录移出：本 worktree 除 `docs/code-review/` 之外没有新增或修改任何文件（`git status` 可复核，其中 49 个 M + 5 个 ?? 均为本需求自身的改动）。
