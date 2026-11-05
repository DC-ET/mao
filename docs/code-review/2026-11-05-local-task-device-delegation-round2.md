# 代码审查报告：本地任务跨设备委托（round 2 · 修复复审）

- 复审日期：2026-11-05
- 复审对象：commit `006bba04`（分支 `feat/local-task-device-delegation`，基线 `5a9b14a1`）中针对 round1 三个问题的修复
- 复审方式：对照 `git diff 5a9b14a1..006bba04` 精读修复代码；重跑 round1 的复现用例（按新期望改写）；为修复逻辑补边界用例；三端全量回归 + 构建。未修改任何业务代码。

## 1. 复审结论

**3 个修复均验证通过，无阻塞项、无功能性新 bug。** 发现 1 个由修复引入的低级别行为回退（问题 4，建议修）与 3 个观察项（不阻塞）。

| 项 | 结论 | 证据 |
|---|---|---|
| 修复 1 同设备多连接误判离线 | **正确**（回落逻辑生效、设备不再误判离线、投递/在线态/后续发送全部恢复） | `repro/backend-device-executor-release.probe.spec.ts`（3 用例通过）、`repro/backend-device-fallback-edges.probe.spec.ts`（4 用例通过）、仓库内新增用例 `streaming-ws-registry.spec.ts` 2 条 |
| 修复 2 边路面板设备字段 | **正确**（字段已透传，绑定/离线/未绑定三态渲染正确，来源→主会话优先级与服务端继承语义一致） | `repro/desktop-side-panel-device-badge.probe.test.ts` 5 用例通过 |
| 修复 3 CLI 设备身份稳定性 | **正确**（落盘失败时同进程稳定；缓存按路径隔离，多路径测试互不影响） | `repro/cli-device-identity-stability.probe.spec.ts` 5 用例通过、`test/device-identity.spec.ts` 3 用例通过 |
| 问题 4（新，低） | 回落后旧执行连接上**已下发的 pending 工具请求不再被失败**，只能等 900s 工具超时 | `repro/backend-device-executor-release.probe.spec.ts` 第 3 用例（观察项） |

回归基线：`backend-ts` 456 文件 / 5521 用例通过 + `npm run build` 通过；`desktop` 141 文件 / 1413 用例通过 + `npm run build`（vue-tsc）通过 + `node --test electron/*.test.cjs` 195 通过 / 1 skip（vitest 另有 23 个 undici worker 启动错误，属本机既有环境问题，与本次改动无关）；`agent-cli` 54 文件 / 613 用例通过。

## 2. 修复逐项复核

### 2.1 问题 1（修复正确）

`streaming-ws-registry.ts:219-241` `releaseDevice()`：删除 `connectionDevice` 后，仅当本 socket 正是该设备执行连接时进入回落；回扫 `userSessions` 找同 `deviceId`、`candidate !== session`、`readyState === WS_OPEN`、`isConnectionAuthorized()` 的连接，命中则 `executors.set(device.id, fallback)`，否则才删除设备映射。

复核过的边界（均有用例）：

1. **回落生效**：两条同设备连接断执行连接后 `hasDeviceConnection` = true、`getOnlineDeviceIds` = `['dev-a']`、`sendToDevice` 投递到存活连接恰好一次、`getDevice()` 仍能取到设备信息（认领写设备名快照依赖它）。三条连接时同样只投递一次。
2. **不误提升不可用连接**：`readyState !== OPEN` 与 `isConnectionAuthorized` 为 false 的连接都不参与（过期 SSO 连接会被咨询并触发既有 `closeConnection` 逻辑）。注：即使这两层过滤失效，`hasDeviceConnection`/`getOnlineDeviceIds`/`sendToDevice` 各自仍会再校验一次，**不会造成可观测的功能错误**，属防御性双保险。
3. **只认同设备**：另一设备的连接不会被吞并（`dev-a` 执行连接断开不影响 `dev-b`，投递仍落在 `dev-b`）。
4. **链式回落**：a1/a2 → 断 a2 回落 a1 → 再断 a1 才离线，映射清理干净。
5. **换设备注册**：同一 socket 重新 auth 为新设备时，旧设备回落到它的其它连接，新设备指向本 socket。
6. **既有语义未回退**：最后一条连接断开时 `afterConnectionClosed` 仍调用 `failAllForDevice`（pending 立即失败 `Device disconnected`），`failAllForUser` 分支未变。

### 2.2 问题 2（修复正确）

`SideChatPanel.vue:135-136` 已透传 `target-device-name/-online`；`:299-314` 计算属性优先级为「真实会话 → 会话详情（`sideSessionDevice`，由 `loadSideSessionMeta:621-624` 回填）／占位态 → 来源会话（`sourceSessionMeta:260-261`）→ 主会话」；`:135-136` 与 `:249-262`（来源会话补拉）配套。该优先级与服务端继承语义一致：占位态由来源边路会话创建时，服务端 `handleCreateSideSession` 正是继承**来源会话**的绑定；回退主会话对应 `sourceSessionId` 缺省的情况。

复核结论：

- **不存在"过期设备"展示**：占位态用来源/主会话快照，真实会话用自身会话详情；占位→真实切换时 `loadSideSessionMeta()` 会被调用（`watch(props.sideSessionId)` 第一分支），不会把上一个会话的设备名带过去。
- `watch` 第二分支（真实→真实切换）确实**没有**重新拉取设备（`sideSessionDevice` 会保留旧值），但该分支当前不可达：`useCenterTabs` 里只有「占位→真实」（`updateSideTaskTab`、`openSideTaskTab` 的 `sideSessionId <= 0` 分支）会改写已挂载 tab 的 `sideSessionId`，恢复/重开路径都按同一 id 匹配，不会把已挂载 tab 指向另一个真实会话。属防御性分支，暂不构成 bug；若将来引入 tab 复用，需要在该分支补一次 `loadSideSessionMeta()`。
- 回归：未绑定的历史边路会话仍显示「未登记执行端」；离线设备显示「离线」且命中 `ChatInput.vue:1145` 的浏览器前置拦截；`vue-tsc` 类型检查通过。

### 2.3 问题 3（修复正确）

`agent-cli/src/local/device-identity.ts:60,66-77`：`identityCache`（按落盘路径）在 `resolveDeviceIdentity` 入口命中即返回，未命中才读盘/生成/写盘。

复核结论：

- 落盘失败时同进程内多次解析返回同一 id（round1 的缺陷用例已改为期望"稳定"并通过）。
- **多路径隔离**：不同路径各自生成、各自落盘、互不串味（`a/device.json` 与 `b/device.json` 各自稳定）；键是路径而不是默认文件，测试用临时目录天然隔离，不会把测试 id 泄漏到真实 `~/.mao/agent-cli/device.json`。
- 既有三端测试（`device-identity.spec.ts`、`ws-client.spec.ts`、`agent-cli` 全量）无回归；缓存返回的是同一对象引用，现有调用方（`ws-client.ts:220` 序列化、`chat.ts` 读字段）只读，无被污染风险。

## 3. 问题 4（新发现，低）：回落后旧执行连接上的 pending 不再被失败，最多挂 900s

**位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts:439-443`（`!hasDeviceConnection(...)` 才 `failAllForDevice`）+ `streaming-ws-registry.ts:230-241`（回落存活连接）

**行为**：同一 deviceId 存在两条连接时（多窗口 / 两个 `mao-agent` 进程），执行连接断开后设备被正确保留为在线（修复目标），但 `hasDeviceConnection` 为 true 使 `failAllForDevice` 被跳过——**本次已经下发给那条（已断开）执行连接的待办工具请求不再被失败**（工具请求只会投给执行连接），只能等 `LocalToolExecutor` 的 900s 超时（`Local tool execution timed out after 900 seconds`）。修复前该路径会立即失败（代价是设备被误判离线，即 round1 的问题 1）。

**影响**：多连接场景下，正在执行的 LOCAL 任务在工具调用上挂起约 15 分钟才报错（会话本身可收敛，无脏数据）。触发条件较窄：需要"同设备两条同时在线的连接 + 有在途工具请求 + 较新那条连接先断开"。

**复现**：

```bash
cp docs/code-review/repro/backend-device-executor-release.probe.spec.ts backend-ts/src/__probe__/
cd backend-ts && ./node_modules/.bin/vitest run src/__probe__/backend-device-executor-release.probe.spec.ts
```

第 3 个用例（观察项）通过，即证实：`failAllForDevice` 未被调用、pending 在 20ms 内未 settle（实际要等 900s）、后续请求改投回落连接且工作正常。

**修复建议**：把"是否失败 pending"的判据从"设备是否还有连接"改成"**刚断开的这条连接是否是该设备的执行连接**"（在 `unregister` 前用 `registry.getDeviceId(session)` + 执行连接身份判定，或在 registry 暴露 `isDeviceExecutor(session)`）。理由：工具请求只投递给执行连接（`sendToolRequest → sendToDevice`），所以执行连接断开时该设备所有在途请求都已失去结果来源，应立即失败；而设备是否在线（回落/映射）沿用现状即可。非执行连接（旧连接）断开则不失败任何请求——与现状一致。

## 4. 观察项（不阻塞，供后续顺手处理）

1. **占位→真实切换瞬间**：`hasRealSession` 转真后、`loadSideSessionMeta()` 返回前，`sideSessionDevice` 仍为 null，输入区会短暂显示「未登记执行端」（一次 REST 往返）；若该请求失败则整段会话都显示「未登记执行端」。可让 `sideTargetDeviceName` 在真实会话未回填时继续回退来源/主会话快照，规避闪烁。
2. **CLI 写盘失败后不再补写**：首次解析写盘失败会缓存内存 id；若随后路径变为可写，本进程内不会补写文件，下次启动会生成新 id（该进程创建的 LOCAL 会话随之不可用）。属"写盘失败"场景下的既有降级，若在意可在缓存命中时做一次 best-effort 落盘重试。
3. **边路占位态的离线拦截**：占位 tab 现在用主/来源会话的 `targetDeviceOnline` 快照做浏览器发送前拦截（与主面板一致），快照过期为 false 时会拦住"其实服务端可执行"的建边路操作，需刷新会话解除——与主面板既有快照语义一致，仅记录。

## 5. 复现用例清单（round2 更新后）

| 文件（`docs/code-review/repro/`） | 用途 | 运行方式 | 现状 |
|---|---|---|---|
| `backend-device-executor-release.probe.spec.ts` | 问题 1 修复验证 + 问题 4 观察项 | 拷到 `backend-ts/src/__probe__/` → `./node_modules/.bin/vitest run src/__probe__/backend-device-executor-release.probe.spec.ts` | 3 用例通过 |
| `backend-device-fallback-edges.probe.spec.ts` | 问题 1 边界（三条连接/跨设备/链式/过期鉴权） | 同上（同目录） | 4 用例通过 |
| `desktop-side-panel-device-badge.probe.test.ts` | 问题 2 修复验证 + 三态渲染 + 计算属性优先级 | 拷到 `desktop/src/components/chat/` → `npx vitest run src/components/chat/desktop-side-panel-device-badge.probe.test.ts` | 5 用例通过 |
| `cli-device-identity-stability.probe.spec.ts` | 问题 3 修复验证 + 多路径隔离 + 观察项 2 | 拷到 `agent-cli/test/` → `npx vitest run test/cli-device-identity-stability.probe.spec.ts` | 5 用例通过 |
| `backend-device-delegation.probe.spec.ts`、`backend-device-delegation-e2e.probe.spec.ts` | round1 回归证据（定向投递/认领/技能同步/边路继承等） | 拷到 `backend-ts/src/__probe__/` | 9 用例通过 |

> 探针文件均只放在 `docs/code-review/`（需拷回三端目录才能被 vitest include 收集），运行后删除即可；业务代码未做任何修改（`git status` 仅显示 `docs/code-review/` 下的变更）。
