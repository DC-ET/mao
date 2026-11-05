# 本地任务跨设备委托 · 第三轮审查（round3）

- 审查对象：commit `b85d4793`（`fix(local): 执行连接断开时立即失败其 pending 工具请求（review round2 问题4）`），基线 `006bba04`
- 审查范围：`git diff 006bba04..b85d4793` 全部改动（backend-ts 业务代码 2 个文件 + 4 个 spec/mock），以及 round1/round2 修复的回归
- 审查方式：只读代码审查 + 独立探针（见文末），未改动业务代码

## 一、总体结论

- **round2「问题 4」修复验证通过**：执行连接断开（即使同设备还有可回落连接）→ 该设备 pending 工具请求立即失败；非执行连接断开 → pending 保留；设备在线/离线判定与 round1 回落修复均未回退。
- **无阻塞项**。新增 1 个低严重度边界问题（问题 5，非阻塞，见下），可在后续迭代按「请求→下发连接」归属修正。
- 后端全量测试与构建通过：`vitest run --exclude 'src/__probe__/**'` → **456 passed / 5523 passed（15 skipped）**；`npm run build`（tsc）通过。

## 二、修复正确性验证（问题 4）

改动要点（`git diff 006bba04..b85d4793`）：

- `streaming-ws-registry.ts:446-456` 新增 `isDeviceExecutor(session, deviceId)`：用 `sessionToUser` + `deviceExecutors` 判断「该连接是否仍是该设备当前执行连接」，空 deviceId / 未注册连接返回 false。与 `getUserId`（同样是 `sessionToUser.get(session.id)`）取值一致，无鉴权口径差异。
- `streaming-ws-handler.ts:430-447` `afterConnectionClosed`：在 `unregister` **之前**取 `deviceId` 与 `wasDeviceExecutor`（顺序正确，`unregister`→`releaseDevice` 会把执行连接换成回落后连接，若放在之后判断会恒为 false）；`unregister` 后条件由 `!hasDeviceConnection(...)` 改为 `wasDeviceExecutor`，`failAllForDevice` 不再要求设备已无连接。

探针实测（`docs/code-review/repro/backend-device-executor-release.probe.spec.ts`，4 用例，全部通过）：

| 用例 | 场景 | 期望 | 结果 |
|---|---|---|---|
| T1/T2 | 同设备两条连接，一条断开后回落；最后一条断开才离线 | `hasDeviceConnection` true→false、`isDeviceExecutor` 正确切换 | 通过 |
| T3 | 执行连接断开，同设备仍有存活连接 | pending 立即失败（`Device disconnected` 而非等 900s 超时），设备仍在线，后续请求投递给回落连接 | 通过 |
| T4 | 非执行连接（同设备旧连接）断开 | pending 保留（20ms 内不 settle），结果可正常回填，设备保持在线 | 通过 |

## 三、回归确认（round1 / round2 修复未受影响）

- round1 问题 1（回落后不误判离线）：`releaseDevice` 未改动，T1/T2 与 round2 探针 `backend-device-fallback-edges.probe.spec.ts`（4 用例：链式回落、跨设备隔离、鉴权过期连接不参与可用性等）全部通过。
- round2 的三个修复均未被本次 diff 触及（diff 仅 backend-ts 的 ws registry/handler + spec/docs，无 desktop、无 agent-cli 改动），round2 探针（`desktop-side-panel-device-badge.probe.test.ts`、`cli-device-identity-stability.probe.test.ts`、backend `backend-device-delegation*.probe.spec.ts`）在 round2 已通过且代码未变。
- 集中回归：`vitest run src/__probe__/ src/session/ws/streaming-ws-registry.spec.ts src/session/ws/streaming-ws-handler.spec.ts` → **6 文件 / 138 用例全过**。
- 新增用例本身有效：`failsDeviceToolRequestsWhenExecutorConnectionClosesEvenIfSameDeviceStillOnline` 断言 `failAllForDevice` 被调用且 `failAllForUser` 未调用；`keepsPendingToolRequestsWhenNonExecutorConnectionCloses` 断言两者均未调用；registry spec 补 `isDeviceExecutor` 的前后切换断言，均与实现一致。

## 四、新发现（低严重度，非阻塞）：问题 5 — 执行连接交接后，清理范围超出「本连接」

- 位置：`backend-ts/src/session/ws/streaming-ws-handler.ts:441-446`（配合 `harness/local/local-tool-session-registry.ts:78` 的 `failAllForDevice`）
- 场景（探针 T5，已实测成立）：
  1. 连接 A 为设备 `dev-x` 的执行连接，工具请求 R 已下发给 A，A 正在执行；
  2. 同设备新连接 B 注册，`deviceExecutors` 覆盖为 B（A 仍 `WS_OPEN`、仍持有 R）；
  3. B 断开 → `wasDeviceExecutor(B)=true` → `failAllForDevice(user, dev-x)` 把**该设备全部** pending 失败，包括实际下发在 A 上的 R。
- 影响：R 的真实结果回来时 pending 已被删除、结果被丢弃；模型收到 `Device disconnected`（但设备实际仍在线），可能重试已产生副作用的工具（重复写文件 / 重复执行命令）。触发条件较窄：同设备多连接 + 执行连接交接 + 交接时仍有在途请求 + 新执行连接先断。
- 说明：这是本次修复引入的行为变化——`006bba04` 时条件为 `!hasDeviceConnection`，B 断开后 A 成为回落后连接、设备仍在线，R 不会被失败。
- 建议修复（后续迭代）：给 pending 记录「下发连接」，`sendToDevice` 返回实际发送的 socket（或在 `LocalToolSessionRegistry` 记录 `requestId → socket`），断线时只失败 `dispatchSocket === closingSocket` 的请求；`failAllForDevice` 仅作为「该设备已无任何可用连接」时的兜底。此改动需要跨 `handler`/`registry`/`local-tool-session-registry` 传递 socket，成本中等，可接受为当前设计取舍（已记录，不阻塞合并）。
- 非功能性小瑕疵（不计入问题）：`streaming-ws-handler.spec.ts:2055` 把 `vi.clearAllMocks();` 挤到了 `it(...) => {` 同一行，仅为格式问题，建议顺手恢复换行。

## 五、探针与复现

- 探针：`docs/code-review/repro/backend-device-executor-release.probe.spec.ts`（T1-T5）
- 运行方式：
  ```bash
  cp docs/code-review/repro/backend-device-executor-release.probe.spec.ts backend-ts/src/__probe__/
  cd backend-ts && ./node_modules/.bin/vitest run src/__probe__/backend-device-executor-release.probe.spec.ts
  ```
- 审查结束后 `backend-ts/src/__probe__/` 已删除，三端源码目录无探针残留。
