# 代码审查报告：同机设备身份统一 + LOCAL 执行端可达性快速失败（未提交改动）

- 审查对象：当前 git 工作区未提交改动（15 个改动文件，约 517 行新增），对应 CHANGELOG `0.0.455` 的「修复 mao-agent 建的本地任务在桌面端对话必报『技能同步失败』」
- 审查范围：`backend-ts`、`desktop`、`agent-cli` 的功能逻辑（文档 / CHANGELOG / skills 变更按约定不审查）
- 审查方式：逐文件读代码 + 全量单测基线对比 + 临时探针 spec 复现（已删除，代码见下文）
- 结论日期：2026-11-06（2026-11-06 修复后复查，见 §5）

## 1. 总体结论

**核心改造方向正确且大部分实现可靠，但有 1 个需要修复的功能缺陷（P1）与 1 个收尾遗漏（P2）**：0 个阻塞项，1 个重要项，1 个次要项。

- 「桌面端与 mao-agent 共用同一份 `~/.mao/agent-cli/device.json`」的设备身份统一、`sendToDeviceFamily` 的设备族广播、设备离线时立即失败而非空等 60s——这三条主路径逻辑自洽，配套单测也覆盖到位；
- 但新增的**「绑定设备离线时由入站连接接管并重绑定」路径是无效的**：接管调用的是 `claimTargetDevice`，而该方法的 SQL 只在 `target_device_id IS NULL` 时生效——已绑定的会话永远写不进去，接管后 `setTargetForSession` 写回的仍是旧设备 ID，技能 / MCP 同步继续投给已离线的连接，依旧 60s 超时。**接管这条路径要么去掉、要么改成真正的强制重绑定**；
- 崩溃恢复的「执行端不可达 → 直接判 FAILED」提前返回路径绕过了 `runRecovery` 的 `finally`，导致 `onExecutionFinished` 收尾回调（定时任务运行记录收敛、IM 通道接力）不执行，与同终态的异常 FAILED 路径行为不一致。

## 2. 问题列表

### 重要（P1，建议合并前修复）

#### 2.1 「接管重绑定」是无效路径：`claimTargetDevice` 写不回已绑定的会话

**位置**

- `backend-ts/src/session/ws/streaming-ws-handler.ts:2644-2661`（`prepareLocalTarget` 接管分支，问题根因）
- 依赖的方法：`backend-ts/src/session/session.service.ts:214-226`（`claimTargetDevice`）
- SQL 语义：`backend-ts/src/session/session.repository.ts:322-329`

**问题描述**

本轮新增的接管分支逻辑是：

```ts
if (boundDeviceId != null) {
  const boundOnline = this.deps.registry.hasDeviceConnection(userId, boundDeviceId);
  const inboundDevice = socket != null ? this.deps.registry.getDeviceInfo(socket) : null;
  if (boundOnline || inboundDevice == null) {
    /* 沿用旧绑定 */ ... return { deviceId: boundDeviceId, deviceName };
  }
  // 接管
  const claimed = await this.deps.sessionService.claimTargetDevice(sessionId, inboundDevice.id, inboundDevice.name);
  const deviceId = claimed?.targetDeviceId ?? inboundDevice.id;   // ← 读回的仍是旧设备
  ...
  this.deps.localToolSessionRegistry.setTargetForSession(sessionId, userId, deviceId);
  return { deviceId, deviceName };
}
```

意图是「绑定设备离线时，把会话改绑到入站的本地连接」。但 `claimTargetDevice` 的定位是**惰性认领**（`session.service.ts:219-221` 注释明确写「仅在 target_device_id 为空时写入」），其 SQL 是：

```sql
UPDATE `session` SET target_device_id = ?, target_device_name = ?
WHERE id = ? AND target_device_id IS NULL AND deleted = 0
```

对于已绑定 `cli-device` 的会话，这条 UPDATE 匹配 0 行 → `claimTargetDevice` 读回 DB 现值 `cli-device` → 接管分支把 `cli-device` 又 `setTargetForSession` 写回内存 → **接管完全没有发生**。

这正是本轮声称修复的线上 session 2297 场景：CLI 退出后桌面端接管。接管不生效意味着：

1. `resolveTarget(sessionId).deviceId` 仍是 `cli-device`（离线）；
2. `syncSkillsToClient` 的 `targetDeviceId` = `cli-device`；
3. `sendToDeviceFamily(userId, 'cli-device', ...)` 找到 0 条存活连接（这正是 `deviceExecutors` 被清理后的状态）；
4. 但因为 `hasLocalClientConnection(userId)` 在函数入口已通过（桌面端连接是 `electron`，算 local capable），所以走到的是「投递 0 目标 → 立即返回失败文案」这条新路径——**文案虽然从「60 秒未回报」变成了「没有可用的本地执行端连接」，但会话依然失败**，用户重试多少次都一样。

**影响**

- 功能层面：接管路径形同虚设，「CLI 退出后桌面端接管」这个卖点不成立；用户看到的仍是失败，只是文案不同。这是本次改造引入的功能缺口（改造前该场景同样失败，但改造承诺修复而未修复）。
- 用户可见副作用：`LocalTargetBanner` 继续显示「该任务在 Mac CLI 上执行」（因为 DB 里的 `targetDeviceId` 仍是旧值），与用户实际在桌面端操作的现实矛盾。
- 不影响其它路径：设备在线时的正常定向投递、未绑定会话的广播回退、`sendToDeviceFamily` 本身都正常。

**复现（已实测）**

临时探针 `backend-ts/src/session/ws/__review-bug-1-takeover.spec.ts`（验证后已删除）用**真实** `SessionService` + **真实** `StreamingWsRegistry` + **真实** `StreamingWsHandler`：

```ts
function makeSessionService(deviceId: string) {
  const rows = new Map<number, Session>();
  rows.set(11, { id: 11, userId: 7, agentId: 5, executionMode: 'LOCAL', phase: 'IDLE',
                 targetDeviceId: deviceId, targetDeviceName: 'Mac CLI', ... } as Session);
  const sessionRepo = {
    // 忠实复刻 session.repository.ts:324-328 的 SQL 语义
    claimTargetDevice: vi.fn(async (id: number, deviceId: string) => {
      const row = rows.get(id)!;
      if (row.targetDeviceId != null && row.targetDeviceId !== '') return 0;  // IS NULL 不成立
      row.targetDeviceId = deviceId; return 1;
    }),
    findById: vi.fn(async (id: number) => rows.get(id) ?? null),
  };
  const service = new SessionService(sessionRepo as never, {} as never, ... );
  return { service, ... };
}
```

| 用例 | 断言 | 结果 |
|---|---|---|
| 真实 `SessionService.claimTargetDevice(11, 'shared-device', 'Mac Desktop')` | 期望接管成功 → `shared-device` | **实际** `{ targetDeviceId: 'cli-device', targetDeviceName: 'Mac CLI' }`（affectedRows=0，读回旧值） |
| 端到端：桌面端（`shared-device` 在线、`cli-device` 已断开）发送消息 | `setTargetForSession` 应收到 `(11, 7, 'shared-device')` | **实际**收到 `(11, 7, 'cli-device')`（diff: `- "shared-device"` / `+ "cli-device"`） |

桌面端横幅的连带影响也用 `LocalTargetBanner` 真实组件渲染验证过：接管失败时仍渲染 `local-target-banner info` + 「该任务在 Mac CLI 上执行」（接管成功时因 `currentDeviceId === targetDeviceId` 应完全不渲染）。

**修复方向（供参考，未实施）**

二选一：

1. 给 `SessionService` / `SessionRepository` 增加**强制重绑定**方法（去掉 `target_device_id IS NULL` 条件，或加 `force` 参数），接管分支改调它；注意 `LocalToolSessionRegistry.setTargetForSession` 的「不可改绑」约束也要相应放开（`local-tool-session-registry.ts:38-53`：非空新值与已绑非空值冲突时会保留旧值并打 warn）；
2. 直接删掉接管分支（保留注释里描述的 1/3/4/5/6 原始路径），承认「绑定设备离线 = 必须去原设备或手动改绑」，把复杂度降下来。考虑到本次已通过共享 device.json + `sendToDeviceFamily` 覆盖了主要场景，方案 2 的复杂度最低、语义最诚实。

### 次要（P2，建议顺手修）

#### 2.2 崩溃恢复 fail-fast 路径跳过 `onExecutionFinished` 收尾

**位置**

- `backend-ts/src/harness/core/crash-recovery-runner.ts:380-395`（新增的提前返回分支）
- 对照：`crash-recovery-runner.ts:458-468`（`runRecovery` 的 `finally` 收尾）

**问题描述**

新增的执行端可达性预检在 `runRecovery` 主体之前 `return`：

```ts
if (session.executionMode === 'LOCAL') {
  const connected = await this.isLocalTargetReachable(sessionId);
  if (!connected) {
    await this.taskTerminalService.finishExecution(sessionId, userId, 'FAILED', randomUUID(), reason);
    this.notifyClient(userId, sessionId, 'FAILED');
    return;   // ← 直接返回，不经过下面 try/finally 的收尾
  }
}
```

而 `onExecutionFinished` 是在 `runRecovery` 主体的 `finally` 里调用的（`app-lifecycle.ts:150-166` 装配的回调负责 `reconcileRunsForSession` 定时任务运行记录收敛、`autoConsumeQueue`、飞书 / 钉钉 `onCrashFinished` 队列接力）。

同为 FAILED 终态，**异常路径会收尾、正常成功路径会收尾，唯独新增的这条 fail-fast 路径不收尾**。

**影响**

- 定时任务触发的 LOCAL 会话在设备离线时被崩溃恢复判 FAILED，`scheduled_task_run` 记录停留在 RUNNING（`reconcileRunsForSession` 不被调用），管理后台的「最近执行」状态与重试计数不准；
- 飞书 / 钉钉入站队列的接力消费（`drainNextIfPending` / `onCrashFinished`）不触发，队列可能滞留。

**复现（已实测）**

临时探针 `backend-ts/src/harness/core/__review-bug-2-recovery-callback.spec.ts`（验证后已删除），2 个用例均通过：

| 用例 | 断言 | 结果 |
|---|---|---|
| 设备离线 fail-fast（`isConnected → false`） | `finishExecution(21, 42, 'FAILED', ...)` 已调用 ✓；`onExecutionFinished` **未被调用** | 符合预期复现 |
| 对照：恢复执行本身抛异常（`execute` reject） | `onExecutionFinished` 以 `(22, 42, 'FAILED')` 被调用 ✓ | 证明同终态下异常路径会收尾，fail-fast 路径是遗漏 |

**修复方向（供参考，未实施）**

把 fail-fast 分支挪进 `try` 主体（或抽成一个私有方法并在两处都调用 `onExecutionFinished`），让 FAILED 终态统一走 `finally` 收尾。注意 `terminalPhase` 需显式置 `'FAILED'`。

## 3. 已核对无误的部分

1. **共享设备文件语义**：`desktopPrefs.cjs:137-159` 的 `ensureDesktopDeviceId` 优先复用共享文件、回落桌面偏好、把回落值同步进共享文件，三条分支与注释一致；`readSharedDeviceId` 对损坏 / 非法 ID 一律返回 null 并回退，不会抛错阻断启动；tmp+rename 原子写与 0600/0700 权限与 `agent-cli/src/local/device-identity.ts` 一致。单测 202 项通过（`node --test 'electron/*.test.cjs'`）。
2. **`sendToDeviceFamily` 的实现**：按 `connectionDevice`（而非 `deviceExecutors`）遍历同 deviceId 的全部存活连接，仅 `WS_OPEN` + `isConnectionAuthorized` 才投递；不投给浏览器 / 无设备身份连接；`delivered` 去重；`JSON.stringify` 失败与 `send` 抛错分别计入 failureCount / 返回零投递。与 `sendToDevice` 的单连接口径分工清晰。
3. **未绑定会话的广播回退**：`syncSkillsToClient` / `syncMcpServersToClient` 的 `else` 分支把 `delivery` 置成 `{targetCount:1, successCount:1}` 跳过「零投递快速失败」，保持改造前的广播行为，逻辑正确（`sendToLocalClients` 走异步增量队列，无法同步拿到投递结果）。
4. **`device-info.ts` 去掉 Promise 缓存**：改为每次调用新 Promise。原缓存的注释声称「deviceId 机器级稳定，运行期不会变化」，但本轮把桌面端 deviceId 绑到了共享文件——CLI 先启动写文件 / 桌面端后启动时会读到不同值，缓存会导致同进程内不一致。改成不缓存是正确方向；代价是每次 IPC 往返，调用点（`useStreamWS` 重连、`createSession`、`useCurrentDevice`）频率都很低，可接受。
5. **`agent-cli/src/commands/chat.ts` 与 `ws/ws-client.ts` 的改动是纯格式 / 变量提取**：`localWorkspace` 上移到 `WsClient` 构造前（构造内联了 `getDevice` 前的取值，无行为变化）、auth 帧对象字面量换行——均无语义影响。`getDevice?.() ?? resolveDeviceIdentity()` 的优先级（注入优先、默认读共享文件）正确。
6. **崩溃恢复预检的异常兜底**：`isLocalTargetReachable` 内部 try/catch 后 `return true`（检查失败不阻断恢复），CLOUD 会话完全不做检查，均有对应单测。

## 5. 修复后复查（2026-11-06）

**结论：§2.1（P1）与 §2.2（P2）均已修复并验证关闭；本轮未发现新的 P1 / P2，改为「0 阻塞 / 0 重要」。**

### 5.1 §2.1 修复方式核对（P1 关闭）

`backend-ts/src/session/ws/streaming-ws-handler.ts:2625-2700`：接管分支**整体删除**，`prepareLocalTarget` 恢复为「已绑定 → 刷新登记并返回绑定值」的单一路径，与我建议的方案 2 一致：

- 文档注释同步改写：路径编号从 6 条回到 5 条，并显式写明「绑定建立后不可改绑：DB 的 `claimTargetDevice` 只在 `target_device_id IS NULL` 时生效，内存注册表同样保留旧值；原设备离线时由『同机另一端接手响应』解决——桌面端与 mao-agent 共用同一份 `~/.mao/agent-cli/device.json`，同步 / 工具帧按 deviceId 投给该设备下所有存活连接，因此不需要把会话改绑到另一台机器」。注释与实现现在一致，且准确解释了「为什么不需要接管」。
- `hasDeviceConnection` 的调用点从 `prepareLocalTarget` 移除；可达性判定交给投递方（`streaming-ws-handler.ts:452` 与 `:1243` 的 `hasDeviceConnection`、`LocalToolSessionRegistry.isConnected`），职责划分比原先更清晰。
- 连带收益：原 §5.2「接管后 `session.targetDeviceName` 快照不一致」的遗留风险随之消失。

### 5.2 §2.2 修复方式核对（P2 关闭）

`backend-ts/src/harness/core/crash-recovery-runner.ts:384-395`：预检分支从 `try` 之前**挪进 `try` 主体**，且 `executionId = randomUUID()` 的生成点保持在 `try` 之前不变，因此：

- `return` 时 `finally` 必然执行，`terminalPhase` 已是 `'FAILED'`（初值），`onExecutionFinished(sessionId, userId, 'FAILED')` 正常触发——定时任务运行记录收敛（`reconcileRunsForSession`）与 IM 队列接力恢复；
- `finishExecution` 收到的是与其它终态路径**同一个 `executionId`**（不再是原先 fail-fast 分支里临时 `randomUUID()` 的第二个 ID），口径统一；
- 新增注释明确写了「放在 try 内：这条 FAILED 终态也必须走下面的 finally 收尾……与异常 / 成功路径口径一致」，防止后人再挪出去。

### 5.3 复验探针实测（本轮）

临时探针（验证后已删除，`git status` 无残留）：

| 探针 | 用例 | 结果 |
|---|---|---|
| `src/session/ws/__review-bug-1-recheck.spec.ts` | 真实 `SessionService.claimTargetDevice` 仍读回旧值（语义未变） | 通过 |
| 同上 | 端到端：绑定设备离线时 `setTargetForSession(11, 7, 'cli-device')`，且 `claimTargetDevice` **不再被调用** | 通过（接管路径已不存在，不会写错值） |
| `src/harness/core/__review-bug-2-recheck.spec.ts` | 设备离线 fail-fast：`finishExecution(21,42,'FAILED',uuid,'本地执行端未连接…')` + `onExecutionFinished(21,42,'FAILED')` | 通过 |
| 同上 | `executionId` 为合法 UUID 且透传给 `finishExecution` | 通过 |
| 同上 | 设备在线 → `execute` 被调用 + `onExecutionFinished(…,'COMPLETED')` | 通过 |
| 同上 | CLOUD 会话不做预检，收尾照常 | 通过 |

### 5.4 测试与文档同步

- `crash-recovery-runner.spec.ts` 的预检用例补了 `expect(onExecutionFinished).toHaveBeenCalledWith(21, 42, 'FAILED')` 断言（回归护栏，防止 `finally` 收尾再次被绕过）；
- `streaming-ws-handler.spec.ts` 的设备族用例把原「接管路径」描述改为「绑定不可改绑，但桌面端与 mao-agent 共用同一 deviceId，同步帧仍按 deviceId 投给该设备下所有存活连接」，与实现口径一致；
- CHANGELOG 0.0.455 后端小节删除了「绑定设备已离线时，入站的本地连接可接管并重绑定会话」这条已不存在的描述，并给崩溃恢复条目补上「该 FAILED 终态与异常 / 成功路径同口径走收尾回调」——文档与行为一致。

## 6. 测试与构建记录（第一轮，修复前）

- `cd backend-ts && npx vitest run src/harness/core/crash-recovery-runner.spec.ts src/session/ws/streaming-ws-registry.spec.ts src/session/ws/streaming-ws-handler.spec.ts`：**162 passed**（改动直接相关的三个 spec 全绿）
- `cd backend-ts && npm test`：**5568 passed / 5 failed**。5 个失败均为**既有环境依赖**，与本轮改动无关——已用 `git stash` 移除本轮 4 个源码文件后复跑同样失败加以确认：
  - `src/file/workspace-browse.service.spec.ts` / `src/file/workspace-write.service.spec.ts` / `src/harness/experience/experience-mount.service.spec.ts`（经验库符号链接相关）
  - `src/harness/container/runtime-agent.spec.ts`（`listen EINVAL: runtime.sock`）
  - `src/harness/terminal/terminal-manager.spec.ts`（本机 `process.env.MAO_BASE_URL` 被继承）
- `cd desktop && node --test 'electron/*.test.cjs'`：**201 passed / 1 skipped**
- `cd desktop && npx vitest run src/components/chat/LocalTargetBanner.test.ts`：通过（用于验证 §2.1 的横幅连带影响）
- 复现探针：`backend-ts/src/session/ws/__review-bug-1-takeover.spec.ts`、`backend-ts/src/harness/core/__review-bug-2-recovery-callback.spec.ts`，验证后已删除；`git status` 中无残留（工作区仅剩本次原有改动）。
- 未执行 `vue-tsc -b` 全量构建：`desktop/src/utils/device-info.ts` 的改动是纯 TS 函数体重写（`normalizeDeviceInfo` 提取），类型面未变；如需可补跑 `cd desktop && npm run build`。

## 7. 测试与构建记录（第二轮，修复后复验）

- 复验探针：见 §5.3，6 用例全部通过后已删除
- `cd backend-ts && npx vitest run src/harness/core/crash-recovery-runner.spec.ts src/session/ws/streaming-ws-registry.spec.ts src/session/ws/streaming-ws-handler.spec.ts`：通过（spec 内新增断言随改动同步生效）
- `cd backend-ts && npm test`：**5568 passed / 5 failed**——与修复前完全一致，5 个失败仍为 §6 列出的既有环境依赖，**无新增失败**
- `cd desktop && node --test 'electron/*.test.cjs'`：**201 passed / 1 skipped**
- `cd desktop && npx vitest run src/components/chat/LocalTargetBanner.test.ts src/composables/useStreamWS.device-auth.test.ts`：**8 passed**
- 仍未执行 `vue-tsc -b` 全量构建（`desktop` 侧本轮无新改动，`device-info.ts` 维持修复前形态）

## 8. 遗留风险（不阻塞，未计入 bug）

1. **`sendToDeviceFamily` 会让两条连接都收到技能同步请求**：设计意图是「谁在线谁接手」，但如果同机两端**都**存活且都执行同步（都会下载技能包、都回 `skill_sync_done`），服务端 `handleSkillSyncDone` 按 `syncId` 匹配、先到者 resolve，后到者落在 `else` 分支只打 warn——功能无碍，但存在双份下载的带宽/磁盘开销。未复现（需要真实双端），不列为 bug。
2. **绑定设备离线 = 必须回到原设备或重开会话**：§2.1 采用「删掉接管分支」修复后，语义变成「绑定即终局」。若用户永久弃用了原机器（换电脑 / 重装 CLI 导致 `device.json` 变化），该会话在本机永远无法执行，只能新建会话。这是可接受的产品取舍（原接管逻辑本就无效），但值得在用户文档里写一句。
3. **共享设备文件的并发写**：桌面端与 CLI 都用 `${file}.${pid}.tmp` + rename，不同 pid 不会互踩；但两端同时首次启动时可能各生成一个 ID 后互相覆盖，最终以最后一次 rename 为准——同机两端在极短时间内可能短暂不一致，随后任一端重连即收敛。窗口极小，不列为 bug。
