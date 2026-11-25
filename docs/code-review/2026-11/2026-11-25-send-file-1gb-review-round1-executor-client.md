# 代码审查报告：send_file 1GB · 执行端 / 容器协议 / 桌面客户端（round 1）

- 审查日期：2026-11-25
- 审查对象：仓库 `mao`（分支 `main`）**未提交改动**中「容器协议 + LOCAL 执行端 + 桌面端 + agent-cli」部分
- 正确性基准：`docs/plan/2026-11/2026-11-25-send-file-1gb-technical-design.md`（§9 R1–R10 已定稿）
- 排除：后端快照 / 存储 / HTTP 路由（另一子代理负责）；`shared/contracts/src/agent.ts` 等另一并发需求的改动
- 审查范围（逐文件精读）：`runtime-channel-protocol.ts`、`container-tool-executor.ts`、`runtime-agent.ts`、`runtime-channel-server.ts`、`docker-tool-router.ts`、`read-bytes-bridge.ts`、`local-tool-session-registry.ts`、`delivery-fetch.service.ts`、`streaming-ws-handler.ts`、`desktop/electron/{localDeliveryStream,localWorkspaceRead,localFileIpc,preload,main}.cjs`、`desktop/src/utils/delivery-fetch.ts`、`desktop/src/composables/{useStreamWS,workspace-file-provider,useCenterTabs}.ts`、`desktop/src/components/center/CenterTabContainer.vue`、`desktop/src/components/chat/ChatDeliveryBar.vue`、`desktop/src/views/task/TaskView.vue`、`desktop/src/types/{electron.d,file-browser}.ts`、`agent-cli/src/local/{file-fetch,executor}.ts`、`agent-cli/src/commands/local.ts`、`agent-cli/src/session/session-runner.ts`（另为核对调用链读了 `harness/streaming/windowed-pull-stream.ts`、`tool/impl/send-file-bytes.ts`、`send-media-tool.ts` 的相关片段，未对其自身问题立项）
- 已执行校验：`backend-ts` `tsc -p tsconfig.build.json --noEmit` 通过、5 个相关 spec 171 用例通过；`agent-cli` `npm run typecheck` **失败 1 处**、2 个相关 spec 18 用例通过；`desktop` `vue-tsc -b` 通过、`vitest` 相关 2 文件 49 用例通过、`node --test electron/*.test.cjs` 29 通过 / 1 skip

## 1. 总体结论

**不可合并：P0 × 1、P1 × 1、P2 × 11。**

主路径（三端帧字段、容器 / 执行端句柄生命周期、512KB × 8 窗口拉取、末端短读与 size/mtime 校验、sha256 比对、桌面三条下载分支、预览 20MB 拦截、agent-cli daemon/REPL 双路由、工作区信任收窄）经核对**实现正确**，未发现会导致数据错写或永久挂起的缺陷。两个必须处理的问题是：agent-cli 的 CI 类型检查被新增测试代码打红（确定性复现），以及「未绑定设备（广播）」会话在多执行端场景下 read/digest 回包被非归属设备毒化——这是相对旧协议的功能回归。

| 项 | 结论 | 证据 |
|---|---|---|
| 协议三端一致（`read_bytes_range` / `read_bytes_close` / `delivery_read`） | 正确，字段名/类型对齐；旧帧 `read_bytes` / `delivery_fetch` 两端实现已删净，无残留引用 | 三处逐字段比对；`grep read_bytes_result\|'read_bytes'\|delivery_fetch` 仅命中 changelog/docs/一处 spec 标题 |
| 句柄生命周期（容器 / 桌面 / CLI） | 正确：close 幂等、60s 空闲 sweep 有 `clearInterval` + `unref`、socket 断开清句柄、digest 后仍可 close | 三端 `close*` 实现 + sweep 实现 |
| 窗口拉取正确性 | 正确：在途 ≤ 8、末端短读按失败处理、无静默吞错（但超时文案不可读，见 P2-5） | `windowed-pull-stream.ts`、`docker-tool-router.ts:148-168`、`delivery-fetch.service.ts:169-196` |
| per-user 4 路在途计数 | 不会永久泄漏：所有返回路径均 `releaseStream`，工具侧 `finally` 一定 `close` | `delivery-fetch.service.ts:112-218`、`send-media-tool.ts:940-944` |
| 桌面下载 / 预览 | 正确：快照走票据、`downloadFile` 不被 20MB 预览上限误拦、三条分支文件名均由 `Content-Disposition` 提供 | `workspace-file-provider.ts:809-860, 866-886`、`file.routes.ts:930-940` |
| 未绑定会话 + 多执行端 | **错误**：只有 open 做了「成功优先」，read/digest 仍先到先得，失败设备可让整次发送失败 | 见 P1-1 |
| agent-cli CI | **失败**：新增测试闭包触发 TS18048 | 见 P0-1（`npm run typecheck` 实测） |

## 2. 问题列表

### 2.1 P0（阻断）

#### P0-1 `agent-cli/test/local-daemon.spec.ts:155` 新增测试代码让 `npm run typecheck` 失败（CI 红）

- **问题**：新增的 `const deliveryFrames = () => server.received ...` 在闭包里访问 `server`，TS 无法保留函数体外的非空收窄，报
  `test/local-daemon.spec.ts(155,36): error TS18048: 'server' is possibly 'undefined'.`
  同文件其它访问点都写成 `server!.received` 或 `server!.send`，只有这一处漏了。
- **影响**：`agent-cli/package.json` 的 `typecheck` 脚本失败，`.github/workflows/ci.yml:181`（`Typecheck agent-cli tests`）必然红，直接阻断合并。已本地实测复现（`npx tsc --noEmit -p tsconfig.test.json` 唯一报错）。
- **修复建议**：`const srv = server!` 后再写闭包，或把该行改为 `server!.received`（与同文件其余写法一致）。改完重跑 `cd agent-cli && npm run typecheck`。

### 2.2 P1（应修）

#### P1-1 未绑定设备的 LOCAL 会话在多执行端在线时，read/digest 回包可能被「没打开成功的执行端」抢先结算，导致整次发送失败

- **涉及位置**：
  - `backend-ts/src/harness/local/delivery-fetch.service.ts:226-238`：`handleResult` 只对 **open** 帧做「失败只记录、等成功」，非 open 帧一律 `completeToolRequest(...)` 先到先得；
  - `delivery-fetch.service.ts:173-196`：每个 read 帧 `raceTimeout(readPending.future, …)`，第一帧回包即定胜负（digest 同理 `:198-207`）；
  - `backend-ts/src/session/ws/streaming-ws-handler.ts:1478-1490`：改造后不再把 `session.id` 传给 service（参数改名 `_session`）。旧实现 `handleChunk(..., session.id)` 用 `sourceSocketId` **锁定首片来源连接、异源分片丢弃**（见 `git show HEAD:backend-ts/src/harness/local/delivery-fetch.service.ts`），该保护随改造丢失；
  - `backend-ts/src/harness/local/local-tool-session-registry.ts:302-310, 321`：未绑定设备时用 `sendToLocalClients`（`LOCAL_CAPABLE_CLIENTS = {electron, cli}` 全部连接），read/digest/close 都是广播；
  - 执行端对「没有该 streamId」的 read/digest 会显式回错：`desktop/src/utils/delivery-fetch.ts:99-102, 128-131`、`agent-cli/src/local/executor.ts:347-350, 369-372`（`ok:false, error:'读取流已关闭或不存在'`）。
- **复现路径**：同一用户同时在线两台执行端（典型：桌面客户端 + `mao-agent` daemon，二者 `LOCAL_CAPABLE_CLIENTS` 都命中）且会话未绑定设备（`target_device_id` 为空，走广播），文件只在其中一端的 workspace 里：
  1. `open` 广播 → A 成功、B 回 `ok:false`（如「工作区越界 / 文件不存在」）；`handleResult` 的 open「成功优先」逻辑让 A 的 `ok:true` 获胜，`openStream` 正常返回；
  2. 随后每个 `read`/`digest` 也广播 → **B 不需要读盘，回包通常比 A 的 512KB 读盘快**，B 的 `ok:false` 先到即被 `completeToolRequest` 结算；
  3. `parseResultFrame` 得到 `ok:false` → 抛错 → 窗口流失败 → 工具返回「读取流已关闭或不存在」。
  即使两端都能打开，若两端文件不同（不同 workspace 下的同名路径），分片可能交替来自 A/B，最终以「文件在发送期间被修改」或「文件校验失败」收场（sha256 兜底不会写脏数据，但功能失败且文案误导）。
- **影响**：未绑定设备的 LOCAL 会话在「桌面 + CLI / 两台机器」同时在线时，`send_file` / `send_image` **任意大小**都可能失败（新协议对所有大小生效）。旧协议（推送 + 首片锁定来源）不存在该问题，属功能回归；本次评审关注点也把「同一 streamId 是否会被多个执行端交错」列为必查项。
- **修复建议**：把 open 的胜出方固定下来——`streaming-ws-handler.handleDeliveryReadResult` 重新把 `session.id` 传回 service；`handleResult` 在 open 成功时记录 `streamId → socketId`（及 `requestId → socketId` 的响应归属），后续 read/digest/close 通过 `registry.sendToConnection/sendToDevice` 定向到同一连接；仅在定向连接失效时才回落广播。次选（吞吐会变差，不推荐）是对 read/digest 也做「失败不立即结算」，但每片都要等满一个宽限窗口。

### 2.3 P2（建议）

#### P2-1 `delivery-fetch.service.ts:157-162` open 通过但 size 越界/非法时不给执行端发 close

- 问题：`Number.isSafeInteger(opened.size)` 失败或 `opened.size > maxBytes` 直接 `return`，此时执行端**已经打开了句柄**（且服务端已 `releaseStream` 掉自己的计数）。
- 影响：执行端句柄与 `deliveryHandles`/`openIds` 表项滞留到 60s 空闲回收（超限文件每次尝试都会留一个 fd）。不是永久泄漏，但超限是高频失败路径。
- 建议：这两个分支补 `this.registry.sendDeliveryClose(sessionId, streamId)`（与 `:163-165` 一致）。

#### P2-2 `delivery-fetch.service.ts:86, 125-127, 163-165` 在途上限命中时复用「执行端不在线或版本过旧」文案

- 问题：`trackStream` 因 `DELIVERY_FETCH_MAX_INFLIGHT_PER_USER = 4` 返回 false 时，`error` 使用 `OFFLINE_ERROR`。
- 影响：用户/模型看到「执行端不在线或版本过旧」，实际是「本用户已有 4 路发送在途」，会误导去重装客户端或重试。
- 建议：单列文案（如「当前有多个文件正在发送，请稍后重试」）。

#### P2-3 `delivery-fetch.service.ts:181-185, 201-205` 单片/digest 超时抛 `Error('timeout')`，最终直接进工具结果

- 问题：`raceTimeout`（`:293-303`）超时 `reject(new Error('timeout'))`，窗口流原样抛出，`send-media-tool` 的 `errorJson(e.message)` 把英文 `timeout` 呈现给用户；docker 侧同理是 `容器读取超时 (timeout after 60000ms)`（`runtime-channel-protocol.ts` PendingRegistry 文案）。
- 影响：这是 1GB 传输最可能的失败形态，文案不含「执行端/网络/如何重试」信息。
- 建议：在 service 内把超时映射为「执行端读取超时，请重试」/「容器读取超时，请重试」。

#### P2-4 `delivery-fetch.service.ts:149-152` 定向 open 走 failFast 拒绝时未 `dropToolRequest`

- 问题：只有 10s 超时的 `onTimeout` 会 `dropToolRequest`；定向投递被 `failFast` 快速拒绝（执行端明确回错，最常见）时只删 `openWaits`，`registry.pendingRequests` 里的表项留到断线/会话结束。
- 影响：小对象滞留（每个失败 open 一条），会话长期存活时会累积；不影响功能。
- 建议：`catch` 分支补 `this.registry.dropToolRequest(sessionId, requestId)`。

#### P2-5 `delivery-fetch.service.ts:241-259` open 回包只校验 `size`，不校验 `mtimeMs`

- 问题：`mtimeMs` 缺失时 `parseOpenFrame` 返回 `NaN`，后续每片比较 `frame.mtimeMs !== mtimeMs` 恒真。
- 影响：一旦执行端回包缺该字段（版本不匹配 / 手写回包），所有分片都报「文件在发送期间被修改，请重试」，与真实原因无关。当前两端都会带该字段，属防御性缺口。
- 建议：open 时一并要求 `Number.isFinite(mtimeMs)`，不满足按 OFFLINE_ERROR 收敛。

#### P2-6 `docker-tool-router.ts:138-141` 旧容器/旧 runtime-agent 收到 `read_bytes_range` 只会等满 60s 超时，未给「版本过旧」文案

- 问题：首帧用 `READ_RANGE_TIMEOUT_MS = 60_000`（`docker-tool-router.ts:47`）；旧 agent 的 `handleMessage` 对未知帧只 `console.warn`（`runtime-agent.ts` default 分支），宿主机 60s 后抛 `... (timeout after 60000ms)`。
- 影响：与设计 R2「切换瞬间已在运行的旧容器要能报版本错误，而不是 120 秒后超时」不一致（虽容器 buildId 漂移会自动重启，但 `skipped-draining` / `deferred-busy` 时仍会命中）。用户看到一条无语义超时。
- 建议：首帧 open 用 10s 短超时并把超时映射为「容器内执行端版本过旧，请重建容器后重试」；read 帧保持 60s。

#### P2-7 `runtime-agent.ts:208-214` 迟到 close 会无条件关闭新连接的读取句柄

- 问题：socket `close` 回调里无条件 `this.executor.closeReadStreams()`，紧接着才做 `if (this.socket === socket)` 的身份判断。同一处注释本身就说明「旧连接晚到的 close」是真实场景（容器重建 / 重连时新旧 socket 短暂共存）。
- 影响：旧 socket 迟到 close 时，会把新连接上刚打开的 `readRanges` 一起关掉，新连接的区间请求报「读取流已关闭或不存在」。窗口很窄（仅重连竞态），但属于新引入的串扰面。
- 建议：改为 `if (this.socket === socket) { this.executor.closeReadStreams(); this.socket = null }`，或仅在 `this.socket == null` 时清理。

#### P2-8 `read-bytes-bridge.ts:134-151` `readBytes` 整份变体已无调用方，且读完不关句柄

- 问题：全仓已无 `sendBytesSupport.readBytes(...)` 调用点（`SendBytesSupport.readBytes` 只剩接口声明 + 该实现），而实现正常读完后不 `close`（`createWindowedReadStream` 正常结束不触发 `onClose`）。
- 影响：当前是死代码；若将来复用，每次调用会在容器里留一个 fd 到 60s 空闲回收。
- 建议：删除该重写（接口默认由 openStream 汇聚）或在 `for await` 的 `finally` 里 `close`。

#### P2-9 `desktop/src/utils/delivery-fetch.ts:120-126` read 回包发送失败时只删映射、不关主进程句柄

- 问题：`if (!sent) openIds.delete(streamId)`，`localDeliveryClose` 未调用；`open` 回包本身丢失时同理。
- 影响：主进程句柄滞留到 60s sweep（有界），渲染层映射表也会残留 `streamId → openId` 条目直到页面重载。
- 建议：`if (!sent) { await deps.close({ openId }).catch(() => {}); openIds.delete(streamId) }`。

#### P2-10 digest 超时余量与 1GB 不匹配

- 位置：`delivery-fetch.service.ts:201`、`docker-tool-router.ts:47` 都用单片 60s 覆盖**整份** sha256。
- 影响：1GB 顺序读需 ≥17MB/s 才能压线通过；机械盘 / 网络盘 / 同时有其他 IO 时可能超时，且失败文案是 `timeout`（见 P2-3）。digest 期间 `lastUsedAt` 只在结束时更新，若单次 digest 超过 60s，执行端侧 60s 空闲回收还有可能在哈希中途关掉 fd。
- 建议：digest 单列更长超时（如 300s），并在哈希循环里分段刷新 `lastUsedAt`。

#### P2-11 `desktop/electron/localWorkspaceRead.test.cjs:11` 仍解构已删除的 `readDeliveryWorkspaceBytes`

- 问题：`localWorkspaceRead.cjs` 的导出已删除该函数（本次改动），测试文件仍 `const { …, readDeliveryWorkspaceBytes } = require('./localWorkspaceRead.cjs')`，取到 `undefined`（当前未被调用，所以测试仍绿）。
- 影响：遗留引用，后续有人照此调用会直接 TypeError；也让「函数是否还存在」的判断失真。
- 建议：删掉该解构项。

## 3. 按审查重点的已核对结论（无问题项）

1. **协议一致性**：`read_bytes_range` 的 `streamId/offset/length/path?/maxBytes?/envelope?/digest?`、`read_bytes_range_result` 的 `data/size/mtimeMs/sha256/error`、`read_bytes_close` 的 `streamId`，在 `runtime-channel-protocol.ts`、`docker-tool-router.ts`、`runtime-agent.ts`、`container-tool-executor.ts` 四处完全一致；`delivery_read` 的 `action/streamId/offset/length/path/workspace/maxBytes` 与两侧执行端解析一致，回包 `ok/data/size/mtimeMs/sha256/error` 与 `streaming-ws-handler` → `handleResult` 一致。旧帧 `read_bytes` / `read_bytes_result` / `delivery_fetch` / `delivery_fetch_result` / `localDeliveryReadFile` / `readDeliveryWorkspaceBytes` 的**实现**均已删净（仅 changelog/docs 与一处 spec 标题保留历史名）。
2. **offset/length 越界与末尾短读**：三端都做 `want = min(length, size - offset)` + `Number.isSafeInteger` + 单片 512KB 上限；窗口流对 `chunk.length !== expected` 直接按「读取中断」失败，不会把短读当正常 EOF。
3. **句柄生命周期**：容器 / 桌面主进程 / CLI 三处的 sweep 都是相邻两次使用 >60s 关闭、30s 扫描、`unref()`，`closeAll*` 里 `clearInterval`；`close` 三端都先删表再 close 且吞 ENOENT，天然幂等；`digest` 不关闭句柄（成功后仍可 `close`），与调用方 `send-media-tool` 的 `finally { await opened.close?.() }` 顺序吻合。
4. **pending / per-user 在途**：`dropToolRequest` 覆盖 open 超时与 read/digest 超时；`failAllForSocket/Device/User/Session` 覆盖断线；`releaseStream` 幂等且每条返回路径都调用，4 路上限不会把用户永久锁死（仅文案问题，P2-2）。
5. **桌面下载三条分支**：Electron `webContents.downloadURL(ticketUrl)`、Web `<a>` 点击、安卓/微信 `openExternalUrl` 都指向带票 `send-download`，文件名由服务端 `Content-Disposition`（`contentDisposition('attachment'|'inline', row.filename)`）提供，三条分支都能拿到原名；票据换发失败会 `{ok:false,error}` 并由 `ElMessage.error` 提示，非静默。20MB 预览上限只作用于 `readFile/previewFile/readFileBytes`，`downloadFile` 不受影响，不会误拦「下载」。
6. **agent-cli 路由与信任收窄**：`DAEMON_ROUTED_EVENTS` 与 `session-runner.acceptEvent` 都已从 `delivery_fetch` 切到 `delivery_read`（daemon 与 REPL 均可达）；`onDeliveryRead` 的 open 先过 `resolveWorkspace`（越界直接回 `ok:false`），再走 `resolveDeliveryWorkspacePath`（realpath containment + 拒绝目标符号链接 + 拒绝相对路径反斜杠/NUL），与桌面端同构，未放宽信任边界；`shutdown()` → `closeDeliveryHandles()` 关闭全部句柄。
7. **版本兼容**：旧桌面 / 旧 `mao-agent` 不认识 `delivery_read` → 静默不回 → 服务端 `DELIVERY_OPEN_TIMEOUT_MS = 10s` 收敛为「执行端不在线或版本过旧，无法读取本机文件」，与设计一致（未静默挂死）；旧容器的差异见 P2-6。

## 4. 未覆盖 / 仍存风险

- 未做真机验证：Electron `downloadURL` 落盘文件名、Web 端 1GB 原生下载、Nginx `send-download` 关闭缓冲（部署配置与代读路由属另一子代理范围）。
- 未跑全量回归（仅跑了本次改动相关的 backend 5 个 spec / agent-cli 2 个 spec / desktop 相关组件与 electron 测试）。
- 蓝绿发布期间「旧后端实例 + 新容器（新 dist）」的 `read_bytes` 断链在设计里被明确接受（不做兼容），此处仅记为运维窗口风险，不作为缺陷。
