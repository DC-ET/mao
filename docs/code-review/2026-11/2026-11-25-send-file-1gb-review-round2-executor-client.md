# 代码审查报告：send_file 1GB · 执行端 / 容器协议 / 桌面客户端（round 2 复查）

- 复查日期：2026-11-25
- 复查对象：仓库 `mao`（分支 `main`）未提交改动中「容器协议 + LOCAL 执行端 + 桌面端 + agent-cli」部分，针对 round 1 报告 13 项修复的复查
- 基准：`docs/plan/2026-11/2026-11-25-send-file-1gb-technical-design.md`（§9 R1–R10）；round 1 报告 `docs/code-review/2026-11/2026-11-25-send-file-1gb-review-round1-executor-client.md`
- 复查方式：逐条核对 13 项修复 → 重新通读 `delivery-fetch.service.ts` / `local-tool-session-registry.ts` / `docker-tool-router.ts` / `desktop/src/utils/delivery-fetch.ts` 全文 → 复核新增的 `sendToLocalSocket` / `streamSockets` / `targetSocketId` 链路 → 实跑类型检查与相关单测
- 实测结果：
  - `backend-ts` `npx tsc -p tsconfig.build.json`（= CI 的 `npm run build` 前半段）**exit 2，3 个类型错误**；相关 7 个 spec 235 用例通过（vitest 走 esbuild，不查类型，所以测试全绿掩盖了编译失败）。
  - `agent-cli` `npm run typecheck` 通过；`local-delivery-fetch` + `local-daemon` 18 用例通过。
  - `desktop` `vue-tsc -b` 通过；`electron/*.test.cjs` 29 通过 / 1 skip；`src/utils/delivery-fetch.dom.test.ts` 本轮在本沙箱起不了 vitest worker（`undici/lib/interceptor/decompress.js` 的 Node 版本不兼容，与本次改动无关，round 1 也出现过同类环境报错），故该文件未取到本轮结果。

## 1. 总体结论

**不可合并：P0 × 1、P1 × 1、P2 × 3。**

round 1 的 13 项修复中 **12 项修复正确**（含 P0-1、P1-1 的主逻辑、P2-1～P2-9、P2-11），P2-10 只修了桌面端与 agent-cli，容器侧漏了同样的改动。但本轮修复**新引入 1 个 P0**：`delivery-fetch.service.ts` 新增 `sendFrame` 的返回类型引用了未导入的 `PendingLocalToolRequest`，导致 `backend-ts` 编译失败（CI `Build backend-ts` 必红、无法出包）。另有一个 P1：`{socketId}` 锁定路径写的 pending 归属是新建的 `{ id }` 对象，与 `failAllForSocket(session)` 的**对象身份比较**不匹配，断线精确失败对该路径失效。

| 项 | 结论 |
|---|---|
| P0-1 agent-cli typecheck | 已修，`npm run typecheck` 通过 |
| P1-1 广播多执行端毒化 | 主逻辑正确（open 认领 → read/digest/close 定向），但配套的断线精确失败断裂（见 P1-1） |
| P2-1 超限/非法 size 补发 close | 已修（`closeStream` 带锁定 socketId） |
| P2-2 在途上限文案 | 已修（`INFLIGHT_LIMIT_ERROR`） |
| P2-3 read/digest 超时文案 | 已修（中文文案） |
| P2-4 failFast 补 dropToolRequest | 已修 |
| P2-5 mtimeMs 校验 | 已修（`Number.isFinite`，并补 close） |
| P2-6 容器首帧 10s + 版本文案 | 已修 |
| P2-7 runtime-agent 迟到 close | 已修（先判身份） |
| P2-8 read-bytes-bridge 读完不 close | 已修（finally close） |
| P2-9 桌面回包失败关句柄 | 已修（open / read 两处；digest 未覆盖，影响可忽略） |
| P2-10 digest 超时 / 刷新 lastUsedAt | **部分修复**：超时 300s 与桌面 / CLI 的循环内刷新已做，**容器侧 `digestReadRange` 仍只在结束时刷新**（见 P2-2） |
| P2-11 残留解构 | 已修 |

## 2. 问题列表

### 2.1 P0（阻断）

#### P0-1 `backend-ts/src/harness/local/delivery-fetch.service.ts:253` 新增 `sendFrame` 的返回类型未导入，`backend-ts` 编译失败

- **问题**：本轮把 read/digest 的帧下发抽成 `private sendFrame(...): Promise<PendingLocalToolRequest>`，但该文件只 `import type { LocalToolSessionRegistry }`（第 3 行），没有导入 `PendingLocalToolRequest`。因此：
  ```
  src/harness/local/delivery-fetch.service.ts(253,14): error TS2304: Cannot find name 'PendingLocalToolRequest'.
  src/harness/local/delivery-fetch.service.ts(211,40): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string'.
  src/harness/local/delivery-fetch.service.ts(234,38): error TS2345: Argument of type 'unknown' is not assignable to parameter of type 'string'.
  ```
  后两条是第一条的连带：返回类型解析失败 → `sendFrame` 退化为 `any` → `raceTimeout(readPending.future, …)` 的 `T` 推断成 `unknown` → `raw` 是 `unknown`，传给 `parseResultFrame(raw: string)` 报错（`:211`、`:234`）。
- **影响**：`cd backend-ts && npm run build` 直接失败，`.github/workflows/ci.yml:37-39`（`Build backend-ts`）必红，也无法出包部署。本轮报的「backend 6907 tests」是通过的，但 vitest 用 esbuild 只剥类型不做类型检查，所以全绿掩盖了编译失败。
- **修复建议**：`import type { LocalToolSessionRegistry, PendingLocalToolRequest } from './local-tool-session-registry.js';`（接口是导出的）。或删掉 `sendFrame` 的显式返回类型，让 TS 从 `registry.sendDeliveryReadRequest` 推断（推断结果就是 `Promise<PendingLocalToolRequest>`）。改完必须跑 `npx tsc -p tsconfig.build.json` 确认 exit 0。

### 2.2 P1（应修）

#### P1-1 锁定连接的 pending 归属用 `{ id }` 伪对象，`failAllForSocket` 的对象身份比较失效：断线后在途 read/digest 不再立即失败，退化为 60s / 300s 超时

- **位置**：
  - `backend-ts/src/harness/local/local-tool-session-registry.ts:299-303`：`const dispatchedSocket = targetSocketId != null ? { id: targetSocketId } : …`，`:310` 写入 `pendingRequests`；
  - `local-tool-session-registry.ts:99`：`if (entry.socket !== socket) continue;`（**引用比较**）；
  - 调用方 `backend-ts/src/session/ws/streaming-ws-handler.ts:526`：`failAllForSocket(session)` 传的是真实 `WsSocket` 对象。
- **机理**：`dispatchRequest` 的两种定向来源写法不一致——设备定向路径（`getDeviceExecutorSocket`，见 `streaming-ws-registry.ts:645-650`）返回**真实 `WsSocket` 对象**，身份相等，`failAllForSocket` 能精确失败；本轮新增的锁路径每次都 `new` 一个 `{ id }` 包装对象（`:299-303`），`entry.socket !== session` 恒真 → 该 pending 永远不会被 `failAllForSocket` 摘除。
  范围要说清：**绑定设备的会话是回归**（round 1 走 `getDeviceExecutorSocket`，断线能立即失败；本轮 open 成功后统一锁定，也变成伪对象）；**广播会话不是回归**（round 1 该字段就是 `null`，本来就要等超时），但因为 digest 超时从 round 1 的 20s 墙钟拉到 300s，白等时间明显变长。广播会话也不会被 `failAllForDevice` 兜底（`sessionToDevice` 为 null → 跳过），`failAllForUser` 又只在用户**一条本地连接都不剩**时才触发——所以「桌面 + CLI 同时在线」时关掉认领的那一条，在途请求无人失败。
- **影响**：不会永久挂起（read 60s、digest 300s 的 `raceTimeout` 兜底），但：
  1. 设备/连接已经断开时，用户还要盯着「发送中」等 60s（digest 最长 **5 分钟**）才看到失败，文案是「执行端读取超时 / 校验超时」，与真实原因（连接已断）不符；
  2. 这 5 分钟里该路仍占着 per-user 4 路在途中的一个名额；
  3. 与本轮代码注释自己写下的契约「断线清理按「请求 → 下发连接」精确失败」相矛盾，round 1 之前这条链路是好的（设备定向路径用真实 socket 对象）。
- **修复建议**（一行）：`failAllForSocket` 改为按 id 比较——
  `if (entry.socket == null || socket.id == null || entry.socket.id !== socket.id) continue;`
  （对真实 socket 也成立，且不再依赖 `getDeviceExecutorSocket` 的返回是不是同一个对象）。若要保留身份语义，则改成在 `dispatchRequest` 里存真实 socket（需要 registry 暴露 `getLocalSocketById`），成本更高。
- **复现/验证**：`local-tool-session-registry.spec.ts` 目前**没有**覆盖 `sendDeliveryReadRequest(..., { socketId })` + `failAllForSocket` 的组合（round 2 新增用例只覆盖了 service 层的帧定向），建议补一条：锁定 socket 下发 read → `failAllForSocket({id:'socket-a'})` → future 立即 settle 为 `Device disconnected`。

### 2.3 P2（建议）

#### P2-1 `sendToLocalSocket` 是可选方法，缺失时定向路径不是回退广播而是硬判离线

- **位置**：`backend-ts/src/harness/deps.ts:306`（`sendToLocalSocket?`）、`local-tool-session-registry.ts:316`（`delivered = …sendToLocalSocket?.(…) === true`）、`:258`（close 的同样写法）。
- **行为**：若 `StreamingWsRegistry` 的实现（或任何满足该接口的包裹对象/测试桩）没有该方法，可选链返回 `undefined`，`delivered = false` → `dispatchRequest` 返回 `requestId: null` + `future = {error: '执行端不在线或版本过旧'}` → **每一次 read/digest 都会失败**（open 已经成功，用户会看到传到一半报「执行端不在线」）。
- **现状**：生产只有一个实现 `StreamingWsRegistry`（`create-app.ts:808` 直接传入），已提供该方法，所以**当前无线上影响**；属于契约脆弱性而非现网 bug。测试侧确实存在缺方法的桩（`local-tool-session-registry.spec.ts` 的 fake 只有 `hasLocalClientConnection/sendToLocalClients`），只是没有用例走到 `targetSocketId` 分支，所以不会红。
- **建议**：① 把 `deps.ts` 里改成必选（TS 会强制所有实现补齐，是最省事的兜底）；② 或在 `dispatchRequest` 里「方法不存在 → 走原来的定向/广播路径」而不是判离线；③ 补一条 registry 单测覆盖 `targetSocketId`（成功、socket 不存在、socket 未授权三种）。

#### P2-2 容器侧 `digestReadRange` 未在哈希循环内刷新 `lastUsedAt`（P2-10 的残留）

- **位置**：`backend-ts/src/harness/container/container-tool-executor.ts:363-371`（循环内无刷新，只在 `:380` 结束后刷新一次）。
- **对比**：桌面 `desktop/electron/localDeliveryStream.cjs:131-139` 与 CLI `agent-cli/src/local/file-fetch.ts:184-192` 本轮都已在循环内刷新（注释写明「1GB 顺序读可能超过 60 秒空闲回收窗口」）。
- **影响**：宿主机 digest 超时已放宽到 300s，容器侧 60s 空闲回收成了唯一约束：容器里读 1GB 哈希若超过 60s（挂载盘慢 / 并发 IO），`ensureReadRangeCleanup` 会在哈希中途 `closeSync`，`readFromFd` 抛 `EBADF`，最终把 `EBADF: bad file descriptor` 原样回给工具卡片。属于慢盘下的低概率失败，但三端口径应当一致。
- **建议**：在 `digestReadRange` 的 `while` 循环内加 `entry.lastUsedAt = Date.now()`（与另两端同款一行）。

#### P2-3 广播会话两个执行端都 open 成功时，落败端的执行端句柄只能等自己的 60s 空闲回收

- **位置**：`delivery-fetch.service.ts:226-238`（只有首个成功回包被结算）+ `:259-266`（close 只发给锁定 socket）。
- **说明**：广播下两台设备都能打开同一文件时，第二台的 `ok:true` 到达时 `openWaits` 已删除，不会覆盖认领，也不会收到 close（close 定向发给认领连接），其 fd 要等自身 60s sweep。有界（1 个 fd / 60s），不构成泄漏；仅作为行为记录。若要更干净，可在 `handleResult` 的 else 分支对「非认领 socket 的 open 成功回包」补一条定向 close。

## 3. 对四个重点复核问题的直接回答

1. **锁定 socket 后 pending 表项与 `failAllForSocket` 的配对**：**不正确**（P1-1）。锁路径写的是 `{ id }` 新对象，`failAllForSocket` 用 `!==` 比较引用，永远不命中（绑定设备会话原本是好的，属回归；广播会话 round 1 就没有精确失败）。**不会永久挂起**——read 60s、digest 300s 的 `raceTimeout` 会兜底失败并 `dropToolRequest` + 释放并发计数；代价是断线后最长 5 分钟才收敛、文案变成「超时」、期间占一个在途名额。
2. **`streamSockets` 的清理**：**所有终止路径都会清，不会无限增长**。逐条核对：open 失败（`requestId == null` / `catch` / `ok:false`）根本不会写入（只有 `frame.ok === true` 才 `set`）；`size` 非法 / 超限 / 二次 `trackStream` 失败走 `closeStream` → `delete`；正常读完由 `send-media-tool` 的 `finally { opened.close?.() }` 清理；取消 / 流销毁由 `windowed-pull-stream` 的 `finally`→`onClose` 清理；`digest` 不改该表。`openStream` 的唯一调用方是 `send-media-tool.openSource`（`:653`），返回 ok 后一定进 `try/finally`，不存在「拿到流却不 close」的路径。另：超时后迟到的 open 成功回包也不会写（`openWaits` 已删），所以不会产生孤儿条目。
3. **`sendToLocalSocket` 缺失（测试桩/未来实现）时**：**不是回退广播，而是整条拉取被硬判离线**（`requestId: null` + 「执行端不在线或版本过旧」），见 P2-1。生产实现已具备该方法，无现网影响；但建议改为必选接口或显式回退，并补该分支单测。
4. **round 1 未修项的成立情况**：only P2-10 的容器侧残留仍然成立（P2-2），不属于必须修；round 1 的 P0-1、P1-1 与其余 11 条 P2 均已处理或有等价修复。**没有遗留的 P0/P1。**

## 4. 复查中确认无问题的点

- **协议一致性**：`read_bytes_range` / `read_bytes_range_result` / `read_bytes_close` 与 `delivery_read` 各字段本轮未变动，三端仍对齐；`sendToLocalSocket` 只改投递方式，不改帧内容。
- **docker 首帧 10s**：`docker-tool-router.ts:133-146` 用 `READ_OPEN_TIMEOUT_MS` 包住 open，catch 统一映射为「容器内执行端版本过旧，请重建容器后重试（原错误）」；`ensureRunning` 刚刚成功，10s 内不回帧确实只剩「镜像里的 agent 不认识该帧」一种可能，映射合理（每次 read 仍用 60s，digest 用 300s）。
- **runtime-agent 迟到 close**：`runtime-agent.ts:208-218` 先 `if (this.socket === socket)` 再置空并 `closeReadStreams()`，新连接刚打开的句柄不会被旧连接误关。
- **桌面回包失败释放**：`desktop/src/utils/delivery-fetch.ts:108-116, 143-153` 在 `send` 返回 false 时先 `openIds.delete` 再 `deps.close({ openId })`，不再留 60s 句柄；`digest` 分支未做同样处理，但此时连接已不可写、服务端已按超时收敛，句柄由主进程 sweep 兜底，可以不修。
- **read-bytes-bridge**：`finally { await opened.close?.() }` 正常读完也释放；销毁路径会先由 `onClose` 发一次 close，之后 finally 再发一次，容器侧 `closeReadStream` 幂等，无副作用。
- **CLI digest 进度**：`file-fetch.ts:176-200` 增加 `onProgress`，`executor.ts:383` 用它刷新 `lastUsedAt`；`open` 回包仍显式回 `size/mtimeMs`，与 service 的 `Number.isFinite` 校验匹配。
- **桌面 digest 循环刷新**：`localDeliveryStream.cjs:131-139` 已在哈希循环内刷新，300s 宿主机超时窗口内不会被自身 60s sweep 打断。

## 5. 未覆盖 / 仍存风险

- `desktop/src/utils/delivery-fetch.dom.test.ts` 本轮未能执行（沙箱内 vitest worker 起不来，undici 与当前 Node 版本不兼容，属环境问题）；该文件的结论仅来自代码阅读与 `vue-tsc`。
- 未做真机联调：真实 WS 断线（睡眠 / 换网）下 `failAllForSocket` 的实际触发时延、容器重建窗口内的 10s 版本文案、以及 Electron `downloadURL` 落盘文件名仍需联调验证。
- 蓝绿期间「旧后端 + 新容器」的 `read_bytes` 断链按设计不做兼容，仅作为运维窗口风险记录。
