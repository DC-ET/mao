# 核心功能逻辑 BUG 审查（2026-09-17，会话 1902）

## 审查基线与边界

- 基线提交：`30d32e9f2fb72b58d71f11b1ce4c675f57c6a24d`。开始审查时 `git status --short` 为空。
- 本报告只审查、记录问题，不修改业务代码、不提交、不部署，也不调用真实模型或外部业务服务。
- **覆盖口径**：已阅读项目规则、架构说明及多端核心调用链；重点精读 Agent 循环、上下文构建、后台子代理、桌面对话与 WebSocket、会话列表、后台角色权限表单，并进行分区审查。**没有逐行完整阅读仓库所有代码、测试、构建产物和第三方依赖，不能将本报告称为“全仓完整阅读完成”或全量质量保证。**
- 收录标准：正常用户操作可触发、能指出确定的错误状态和调用链。排除风格建议、纯推测、安全攻击复现及无法核实的候选。
- 对 `docs/code-review/` 做了相关函数名、现象关键词检索。下面的新路径与历史相近问题在正文区分；这是定向去重，不宣称已逐字读完全部历史报告。
- 严重程度：P1＝核心流程可能挂起或丢失关键结果，优先修复；P2＝在特定交互或数据条件下功能错误。条目置信度均为高；“函数级验证”不等同于真实浏览器或生产环境复现。

## 问题总览

| 编号 | 优先级 | 核心功能 | 逻辑 BUG |
| --- | --- | --- | --- |
| B01 | P1 | 后台子代理重试、结果交付 | 收尾过早释放运行标记，父代理可能提前结束并抑制结果 |
| B02 | P1 | WebSocket 重连、消息发送 | 重连握手失败丢弃未完成 Promise，后续连通也无法恢复原发送 |
| B03 | P2 | 待办与消息队列 | 会话切换后，旧请求把 A 数据写入 B 缓存 |
| B04 | P2 | 历史分页、文件变更 | A 的旧页与 B 的当前文件变更混合，覆盖 A 原记录 |
| B05 | P2 | 聚焦任务列表 | 新建任务未加入已加载的聚焦列表 |
| B06 | P2 | 管理后台权限编辑 | 保存途中继续勾选的修改被响应静默覆盖 |
| B07 | P2 | 子代理正式结果 | 重试结果误用进度预览，超过 2000 字符的结论被截断 |

B01 与 B07 属于同一功能的不同根因；B03 将待办、队列的同构问题合并为一条，不以重复计数凑数量。

## B01 [P1] 子代理重试收尾提前 untrack，父代理可在结果交付前退出

**位置**：`backend-ts/src/harness/delegate/background-subagent-manager.ts:303-337`，尤其 `:308-315`；退出判断 `backend-ts/src/harness/core/agent-loop.ts:363-379`；入口 `backend-ts/src/session/ws/streaming-ws-handler.ts:886`、`:997`。

```ts
// completeRetry
this.untrackRunning(parentSessionId, taskId);
this.runningRefsByTask.delete(taskId);
const execution = await this.deps.subagentExecutionMapper.findById(taskId);
```

**根因**：重试收尾在第一次数据库读取前就释放运行跟踪；此时 `resultsByParent` 尚未写入。AgentLoop 使用 `hasRunning(...) || hasPendingResults(...)` 决定是否继续等待，两者会同时为 false。父代理可正常结束，随后 `completeRetry` 查到父会话为终态，把结果标为 `SUPPRESSED`。

**触发条件与步骤**：
1. 父会话仍在执行；用户对子代理进行一次重试，`beginRetry` 登记运行中。
2. 子代理完成，进入 `completeRetry`，数据库读取或落库存在正常异步等待。
3. 在此窗口父代理结束当前无工具轮，检查不到运行任务或待交付结果，于是退出。
4. 收尾恢复后读到父会话 `COMPLETED`，不投递结果。

**影响**：子代理实际执行成功，父代理却未收到结果，最终回答可能缺少重试得到的关键结论。也可能出现父代理已退出、结果才写入内存但没有消费者的时序。

**验证**：主审直接加载当前源码，模拟仓储并挂起 `findById`。确认数据库记录仍为 `RUNNING` 时，`hasRunning=false`、`hasPendingResults=false` 且 `waitForAll` 返回 completed。将父会话置为正常终态后释放读取，结果变为 `SUPPRESSED`，`consumeResults` 返回空对象。未使用真实数据库或 LLM。

**修复方向**：将运行跟踪的释放放到结果落库、入队或明确抑制之后，并通过 `finally` 保证异常路径清理；确保“运行中”与“结果可消费”之间没有两者皆空的窗口。补充收尾数据库读取延迟与父循环完成交错的回归测试。

**历史区别**：旧报告 `code_review_20260816141320.md` 提到正常子代理完成后父循环只检查 `hasRunning` 的问题；当前循环已增加 `hasPendingResults`，本条是 **重试收尾在入队前提前 untrack** 的独立缺口，现有双检查仍无法覆盖。

## B02 [P1] 自动重连失败遗失 Promise，网络恢复后原发送仍永久等待

**位置**：`desktop/src/composables/useStreamWS.ts:180`、`:288-296`；调用方 `desktop/src/composables/useChat.ts:302`。

```ts
} else if (!intentionalClose) {
  initialConnect = false
  connectPromise = null
  pendingSettle = null
  isReconnecting = false
  scheduleReconnect()
}
```

**根因**：`connect()` 会复用正在连接的 Promise。自动重连握手失败走上述 `onclose` 分支，只清引用、不 reject；下一轮连接创建新的 Promise，不能再结束之前那一个。

**触发条件与步骤**：已连接 WS 断开 → 自动重连处于 CONNECTING → 用户发送消息并 `await connect()` → 本次握手失败触发 onclose → 后续自动重连成功。

**影响**：网络指示已恢复，但原发送流程永远不向下执行，消息未发送；该流程不能正常复位 `sending`。由于引用已被丢弃，之后调用 `disconnect()` 也不能 settle 原 Promise。

**验证**：前端审查分支通过内存转译当前源码、模拟 socket 事件，确认新 socket 已连接，而旧 Promise 仍未 settle；主审复读分支及发送调用方。没有进行真实浏览器网络故障测试。

**修复方向**：每次 socket 关闭时，先结算属于该 socket 的未决连接 Promise，再清理句柄、安排下一次连接；保证一次尝试恰好 settle 一次。回归覆盖“发送复用失败重连 Promise，下一次连接成功”。

**历史区别**：区别于 `code_review_20260901182831.md` 的 TCP 黑洞无 onclose 超时，也区别于主动 disconnect 未清 Promise；这里 onclose 已到达、下一次连接也已成功。

## B03 [P2] 待办与队列慢响应写入切换后的会话

**位置**：`desktop/src/composables/useChat.ts:224-228`、`:805-809`；调用链 `restoreSession():918-919`。

```ts
const { data } = await api.get(`/sessions/${sessionId.value}/todos`)
sessionStore.setTodos(sessionId.value, data || [])
// fetchQueue 同样在 await 后重新读取 sessionId.value
```

**根因**：请求 URL 与结果写入使用两次可变的 `sessionId.value`；异步等待期间会话可能改变。`restoreGeneration` 只保护 restoreSession 自身，未被这两个独立请求的响应写入使用。

**触发**：打开 A 产生请求，在响应前切到 B；B 先完成加载，A 的旧响应随后回来，写入 B 的缓存。

**影响**：B 显示 A 的待办和队列；队列后续交互携带 B 会话 ID 与 A 队列项 ID，造成操作对象错配。此处只报告客户端数据与操作目标错配，不推断后端会允许跨会话操作。

**验证**：审查分支用延迟 API 分别验证 todos、queue 两条路径的 A→B 缓存覆盖；主审复核写入代码。

**修复方向**：请求开始捕获 `sid`，请求与响应始终按该 ID 写入；如需保证同一会话多次刷新顺序，再引入按会话的请求代次。回归覆盖 A、B 响应反序返回。

## B04 [P2] 历史分页混用当前会话文件变更，污染分页目标缓存

**位置**：`desktop/src/composables/useChat.ts:194-210`；`desktop/src/stores/session.ts:308-310`。

```ts
sessionStore.prependMessages(sid, olderMessages)
const existingChanges = sessionStore.activeFileChanges
sessionStore.setFileChanges(sid, [...allChanges, ...existingChanges])
```

**根因**：分页虽捕获目标 `sid`，合并时却读 `activeFileChanges`（依赖当前 activeSessionId），没有按 sid 读取原文件变更。

**触发**：A 上拉历史开始请求 → 切换到 B → A 分页返回。

**影响**：A 缓存变为 `A-old + B-current`，而不是 `A-old + A-current`；B 无文件变更时也会丢掉 A 的近期变更。问题发生在前端缓存，不意味着服务端文件被改动。

**验证**：审查分支延迟响应检查确认上述合并结果，主审确认 activeFileChanges 的 store 定义。

**修复方向**：提供或使用 `getFileChanges(sid)`，分页读取、合并、写入都绑定同一 sid；回归同时覆盖 B 有变更和 B 为空。

## B05 [P2] 新建会话未进入已加载的聚焦列表

**位置**：`desktop/src/stores/session.ts:692-699`；聚焦投影 `:175-200`；对照恢复归档路径 `:563-567`。

```ts
upsertSessionEntity(data)
if (!standardSessionIds.value.includes(String(data.id))) {
  standardSessionIds.value = [String(data.id), ...standardSessionIds.value]
}
bumpGroupMetaForSession(data, 1)
```

**根因**：创建操作更新实体缓存及标准列表，但遗漏 `focusSessionIds`。聚焦列表按独立 ID 集合派生，实体存在不等于列表包含该实体；随后 phase 更新也不补充成员。

**触发**：聚焦模式已完成 `fetchFocusSessions()`，不退出该模式直接新建任务并发送首条消息。

**影响**：任务已创建并运行，聚焦侧栏却没有此任务；重新拉取聚焦列表后才恢复。

**验证**：前端审查分支内存执行确认标准列表包含新会话，已加载聚焦列表仍为空；主审复读创建、phase 更新和聚焦投影实现。

**修复方向**：创建成功时，将符合条件的 ACTIVE 主会话去重加入已加载的聚焦投影，使用现有 computed 排序。可参考 `unarchiveSession()` 对聚焦成员的处理。测试应从已加载聚焦模式创建任务，而不只是检查实体缓存。

## B06 [P2] 保存权限期间的新勾选被旧保存响应覆盖

**位置**：`admin/src/views/permission/RolePermissionView.vue:44`、`:143-147`、`:211-224`。

```ts
await api.put(`/roles/${currentRole.value.id}/permissions`, {
  permissionIds: selectedPermissionIds.value
})
ElMessage.success('权限已保存')
dirtyPermissions.value = false
const id = currentRole.value.id
await fetchAll()
const updated = roles.value.find(r => r.id === id)
if (updated) selectRole(updated)
```

**根因**：保存按钮有 loading，但权限复选框未禁用。请求返回后无条件清除 dirty 状态，并用服务端快照重新选择角色，覆盖等待期间产生的新编辑。

**触发**：勾选 P1 并保存；PUT 在途时继续勾选 P2；第一笔保存完成并重新拉取角色。

**影响**：服务端只保存 P1，界面中的 P2 被覆盖，未保存标记也消失。此处是正常管理操作的编辑丢失，不涉及权限绕过。

**验证**：审查分支模拟延迟保存，确认选择从 `[P1, P2]` 回退为 `[P1]`，`dirtyPermissions=false`；主审复核模板、selectRole 和保存逻辑。

**修复方向**：最小方案是在保存期间禁用权限编辑与角色切换；若产品允许继续编辑，则捕获提交的角色 ID、权限快照及编辑代次，仅在版本未变化时回填和清脏。回归覆盖保存期间继续勾选。

**历史区别**：历史 `frontend-review-20260901.md` 的 A13 是未保存时切换角色丢失修改；本条无需切换角色，是保存期间编辑被在途响应覆盖。

## B07 [P2] 子代理重试正式结果误用 2000 字符进度预览

**位置**：`backend-ts/src/harness/delegate/background-subagent-manager.ts:314-321`、`:329-333`、`:392-404`。

```ts
const resultText = status === 'COMPLETED'
  ? await this.recentOutput(execution.childSessionId ?? null) ?? '(子代理未产生文本输出)'
  : status === 'CANCELLED' ? '后台子代理已取消' : '后台子代理重试执行失败';
// recentOutput
return truncate(content, 2000);
```

**根因**：`recentOutput()` 是进度展示预览函数，固定截断为前 2000 字符加省略号。`completeRetry()` 却把它作为正式 result 写入 execution，并交付给父代理，而非仅用于 UI 预览。

**触发**：用户重试子代理，重试生成超过 2000 字符的最终回答，关键结论位于后部。

**影响**：子会话的原始消息仍可能完整，但 execution 的正式结果与父代理自动收到的结果均已截断；与正常后台执行通过 collector 获取完整结果的语义不一致。不能把“用户可以再读取子会话”当成自动交付正确。

**验证**：主审直接加载当前源码并使用 mock 消息，输入 2126 字符（末尾有明确结论标记），执行 beginRetry → completeRetry → consumeResults。确认数据库 result 与交付 result 都只有 2003 字符，末尾结论消失。

**修复方向**：将进度预览读取与正式结果读取分离；正式结果保留完整内容，按此次执行范围获取相应最终回答。不要拼接被截断的尾部、伪造摘要或以降级掩盖信息丢失。测试断言 execution 与父代理收到的正式结果完整，进度预览仍可有界。

## 验证记录与交付边界

1. 主审运行了直接导入当前源码的隔离检查：两个场景分别确认 B01 的交付窗口和 B07 的正式结果截断。仓储、会话状态均为内存 mock，检查脚本只存放于会话 runtime，不写入项目源码，不作为交付依赖。
2. 主审运行项目现有定向测试：
   ```bash
   cd backend-ts
   npm test -- --coverage.enabled=false src/harness/delegate/background-subagent-manager.spec.ts src/harness/core/agent-loop.spec.ts
   ```
   **结果：2 个测试文件、30 个测试全部通过，退出码 0。** 日志中的模拟 LLM 错误来自错误路径测试，不是真实模型调用。关闭覆盖率仅为定向执行，不代表满足项目全量覆盖率要求。
3. B02—B06 的函数级行为检查由前端审查分支执行并汇报，主审复读所列源码及相关调用方；未将这些检查冒充为完整浏览器 E2E。
4. 未运行全仓测试、全端构建、安卓实机测试、真实数据库并发测试或外部认证联调。现有 30 项测试通过不代表上述 BUG 不存在，它们没有覆盖报告中的交错条件。
5. 最终仅新增本报告，未修复业务代码；不需要为纯审查报告更新 CHANGELOG 或产品手册。文件名包含日期和会话编号，创建前已检查没有同名目标。

## 分区阅读覆盖补充

- **后端主审**：完整读取 agent-loop、prompt-engine、background-subagent-manager、background-task-manager、token-estimator、active-context-calculator、context-manager、subagent-result-collector，并定向核对 retry 的 WS 调用链及现有测试。
- **后端分支**：精读飞书入站处理、消息服务/仓储、队列、卡片、monitor；ECP 认证/续期及相关仓储、普通认证、LDAP、JWT、company-sso；三个模型客户端。未实质精读 oss、schedule 与 session 全部主体。
- **前端分支**：重点覆盖桌面对话、WebSocket、session store、任务列表及管理后台权限表单；不宣称覆盖每个组件。
- **CLI / 安卓分支**：阅读 main、args、config-store、chat、session-runner、REPL、WS、输出 renderer、local executor 主体，以及 MainActivity、AppUpdatePlugin、Manifest 和升级前端调用链。未完整覆盖全部 TUI 组件、CLI 子命令与本地工具，未进行安卓实机验证。
- **SDK / 引擎补充分支**：阅读 SDK WebSocket、session-manager、context collector，重点核对 controller 历史映射/切换/发送、store 合并逻辑和相关 UI；另读上下文加载/压缩协调、技能同步及 WS contracts。
- 收尾阶段返回的其他分区候选未纳入本报告问题计数：本报告固定收录上述 **7 项已完成主审核对的问题**，不再扩张清单。完整逐行审阅全仓这一原始范围尚未实现，不能据此认定未列出的模块没有 BUG。
