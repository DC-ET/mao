# 逻辑 BUG 审查合并报告（2026-08-24）

- **日期**：2026-08-24
- **项目**：mao（backend-ts / admin / desktop / android / agent-cli）
- **来源**：对照以下三份审查文档逐条核对当前源码，去重后只保留真实存在的问题：
  - `docs/code-review/logic-bugs-review-round2.md`
  - `docs/code-review/logic-bugs-review-round3.md`
  - `docs/code-review/code_review_202608241114.md`
- **方法**：每条都回溯文件、行号、上下游调用链与触发条件。源码对不上、无法坐实、或原报告已标明属产品取舍 / 单节点部署约束的条目丢弃。
- **本轮范围**：只出文档，不改代码。
- **严重度**：P0 = 权限旁路或核心能力在常见路径上直接出错；高 = 特定条件下功能错误 / 数据丢失 / 状态错绑；中 = 边界或降级路径行为错误。

共确认 **38 个逻辑 BUG**（P0×3、高×25、中×10）。重复项已合并为一条。

---

## 结论摘要

| 编号 | 严重度 | 模块 | 一句话描述 | 来源 |
|------|--------|------|-----------|------|
| BUG-01 | P0 | backend / auth | LDAP 登录不校验账号禁用，禁用用户仍可拿 token | round2-01 |
| BUG-02 | P0 | backend / permission | `PUT /v1/users/:id/roles` 只校验登录，任意用户可提权为 ADMIN | round3-01 |
| BUG-03 | P0 | backend / admin-session | `requireAdmin` 未 `await`，普通用户可读全站会话 | round3-13 / 1114-1 |
| BUG-04 | 高 | backend / model+agent | 模型与 Agent 写接口未校验 `*:write`，模型 VO 明文返回 API Key | round3-02 |
| BUG-05 | 高 | backend / file | `project-list` 用 `startsWith` 做路径边界，可跨用户读项目文件 | round3-03 |
| BUG-06 | 高 | backend / file | `workspace-read` 跟随符号链接，可读工作区外文件 | round3-08 |
| BUG-07 | 高 | backend / schedule | 定时任务在等会话锁期间被删除后仍会执行一次 | round2-02 |
| BUG-08 | 高 | backend / schedule | 等锁期间被暂停后仍计入 `fireCount`，并可能误标 `finished` | round2-03 |
| BUG-09 | 高 | backend / schedule×队列 | 队列 500ms 占位窗内定时任务只看 DB phase，同一会话会双跑 | 1114-8 |
| BUG-10 | 高 | backend / file | Git 写操作锁存在 TOCTOU，并发 commit/pull/push 可同时执行 | round2-04 |
| BUG-11 | 高 | backend / weixin | 监控循环退出时无条件删 Map，且长轮询无法被 abort 打断 | round2-05 |
| BUG-12 | 高 | backend / weixin | `send_wechat_image/file` 固定取 `tokens[0]`，多联系人时发错人 | round3-07 |
| BUG-13 | 高 | backend / notification | `resolveWebSocket` 无条件覆盖终态，可导致 Webhook 重复投递 | round2-06 |
| BUG-14 | 高 | backend / session | `insert_message` 先删队列再落库，失败时消息永久丢失 | round3-04 |
| BUG-15 | 高 | backend / session | `edit_and_resend` 先截断历史，后续失败不回滚也不执行 | 1114-4 |
| BUG-16 | 高 | backend / session | REST `PATCH .../messages/:id` 不校验「最后一条 USER」，可截断后续对话 | round3-16 |
| BUG-17 | 高 | backend / session | 线程池拒绝后：插队永久停消费、边路会话 claim 泄漏 | 1114-7 |
| BUG-18 | 高 | backend / harness | `wait_subagents` 传入 `cancelFlag=null`，用户取消最长阻塞 30 分钟 | round3-05 |
| BUG-19 | 高 | backend / harness | LOCAL 边路 / 子代理执行前不同步 skill，技能文件按新 sessionId 寻址必然缺失 | round3-06 |
| BUG-20 | 高 | backend / harness | `persistToolRound` 把仍在跑的 BACKGROUND/FOLLOWUP 误标 `DELIVERED` | round3-14 / 1114-2 |
| BUG-21 | 高 | backend / harness | 后台任务结果注入后未丢弃 `preparedRequest`，本轮模型看不到输出 | round2-08 / 1114-3 |
| BUG-22 | 高 | backend / harness | 改 system prompt / tools / 摘要后未清空 `preparedRequest`，首轮用错上下文 | round3-15 |
| BUG-23 | 高 | agent-cli | `LocalExecutor` 忽略 `sendReliable` 返回值，本地副作用已发生但服务端收不到结果 | round2-07 |
| BUG-24 | 高 | agent-cli | WS `error` 不结束 `waitUntilSettled`，REPL/`-p` 永久挂起 | round3-17 |
| BUG-25 | 高 | desktop | `TaskView.loadSession` 无请求代际保护，旧响应可覆盖新会话 | round2-11 |
| BUG-26 | 高 | desktop | `side_session_created` 无关联 ID，多占位 Tab 会绑错会话 | round2-12 |
| BUG-27 | 高 | desktop | 后台会话完成误关前台 `sending`；失败 `pop` 可能删错气泡 | round3-09 |
| BUG-28 | 高 | desktop | 主会话乐观助手未登记流式 ID，流式事件再插一条空气泡 | 1114-5 |
| BUG-29 | 高 | desktop | 入队判定漏掉 `RESUMING`/`CANCELLING`，恢复/取消窗口误走新发送 | 1114-6 |
| BUG-30 | 中 | backend / harness | `grep_search` JS 回退用 basename 匹配 glob，带目录前缀的模式结果为空 | round3-10 |
| BUG-31 | 中 | backend / harness | `grep_search` JS 回退不跳过 `node_modules`/`.git`，与 glob/rg 不一致 | 1114-10 |
| BUG-32 | 中 | backend / harness | 子代理 `WAITING_APPROVAL` 时仍可追问，同一会话叠两个 AgentLoop | round3-11 |
| BUG-33 | 中 | backend / harness | 后台任务 30 分钟清理不区分会话、不取消底层 promise | round3-12 |
| BUG-34 | 中 | backend / shell | 过期 shell 清理不维护 `conversationSessions`，配额虚高后无法新建 | round3-18 / 1114-9 |
| BUG-35 | 中 | agent-cli | `grep_search` 用冒号切分 `rg` 输出，Windows 路径下匹配被静默丢弃 | round2-09 |
| BUG-36 | 中 | agent-cli | `read_file` 负 `offset` 时用 `Number(...) \|\| 0`，与后端钳制口径不一致 | round2-10 |
| BUG-37 | 中 | backend / user | `PUT /v1/users/:id` 设 `status=0` 不走 `assertCanDisableUser` | round3 附录 |
| BUG-38 | 中 | backend / statistics | `/v1/statistics/*`、`/v1/analytics/*` 仅 `requireUserId`，普通用户可读全站运营数据 | round3 附录 |

---

## 一、P0

### BUG-01【P0 · 安全/鉴权】LDAP 登录完全不校验账号禁用状态

- **来源**：round2 BUG-01
- **位置**：`backend-ts/src/auth/ldap-auth.service.ts` 第 46–74 行
- **对照**：本地登录 `backend-ts/src/auth/auth.service.ts` 第 34–35、50–51 行检查 `status === 0`；飞书登录 `feishu-auth.service.ts` 有 `ensureUserEnabled`。

LDAP 在 `findByUsername` 命中已有用户后，只更新 `displayName`/`email`/`lastLoginAt` 并直接发 JWT，没有任何 `status` 判断。三种登录方式里只有这一处遗漏。

- **触发**：管理员把用户 `status` 置 0 后，该账号若仍存在于 LDAP，仍可用 LDAP 用户名密码登录并拿到 token。
- **为何错误**：禁用后任何登录方式都应被拒绝。
- **修复方向**：已有用户分支在 `updateById` 前补 `status === 0` 则抛 `ACCOUNT_DISABLED`。

---

### BUG-02【P0 · 安全/提权】任意登录用户可通过角色 API 提权为 ADMIN

- **来源**：round3 BUG-01
- **位置**：`backend-ts/src/permission/permission.routes.ts` 第 15–47 行
- **对照**：`user.routes.ts` 走 `requirePermission(..., 'user:write')`；`user.service.ts` 改角色前调用 `assertCanChangeRoles`。

全局 JWT hook 只保证已登录。`PUT /v1/users/:id/roles` 直接 `assignRoles`，没有管理员校验，也不会走「不能卸掉最后一个 ADMIN」保护。同文件的 `POST /v1/roles`、`PUT /v1/roles/:id/permissions` 同源。

- **触发**：普通用户携带自己的 token 调用 `PUT /api/v1/users/{自己的id}/roles`，body `{"roleIds":[1]}`。
- **为何错误**：预期只有管理员能改角色；实际任意登录用户可把自己或他人提权为 ADMIN，也可把唯一管理员降权。
- **修复方向**：角色/权限写接口加 `requireAdmin` 或 `requirePermission(..., 'user:write')`；改角色走 `userService.updateUser` 以触发 `assertCanChangeRoles`。

---

### BUG-03【P0 · 安全/越权】管理会话 API 的 `requireAdmin` 未 `await`，校验完全不生效

- **来源**：round3 BUG-13、1114 BUG-1（同一缺陷）
- **位置**：`backend-ts/src/session/admin-session.routes.ts` 第 18 行、第 45–101 行
- **对照**：`admin.routes.ts` 正确 `await requireAdmin(...)`；`requireAdmin` 本身是 `async`（`http-error.ts` 第 35–43 行）。

```18:18:backend-ts/src/session/admin-session.routes.ts
  const requireAdminUser = (request: Parameters<typeof requireAdmin>[1]) => requireAdmin(permissionService, request);
```

handler 里写的是 `requireAdminUser(request)` 而不是 `await requireAdminUser(request)`。拒绝变成未处理的 Promise rejection，拦不住后面的 `listSessionsForAdmin` / 消息查询。这是第一轮「admin 接口只校验登录」修复的回归。

- **触发**：普通用户持有效 JWT 调用 `GET /api/v1/admin/sessions` 或 `GET /api/v1/admin/sessions/{id}/messages`。
- **为何错误**：预期 403；实际返回 code=0 的全站会话列表与他人聊天记录。
- **修复方向**：所有调用改为 `await requireAdminUser(request)`；补「非 admin JWT 必须 403」路由测试。

---

## 二、高优先级

### BUG-04【高 · 越权】模型与 Agent 写接口未校验写权限，模型 VO 明文返回 API Key

- **来源**：round3 BUG-02
- **位置**：
  - `backend-ts/src/model/model.routes.ts` 第 30–124 行（整文件无 `requireUserId` / `requirePermission`；`toVO` 原样返回 `apiKey`）
  - `backend-ts/src/agent/agent.routes.ts` 第 70–114 行（写接口仅 `requireUserId`）
  - `backend-ts/src/agent/agent.service.ts` 第 17–18 行（`listAgents` 忽略传入的 `userId`）

JWT hook 会拦匿名请求，因此这些接口对「任意已登录用户」开放。`V001` 已定义 `model:write` / `agent:write`，普通角色只有 `*:read`。

- **触发**：普通用户 `POST /api/v1/models` 写入密钥，或 `GET /v1/models` 读出管理员配置的 API Key；`DELETE /api/v1/agents/{默认Agent id}` 删掉全平台默认 Agent。
- **修复方向**：写操作加 `requirePermission(..., 'model:write' / 'agent:write')`；列表/详情对非管理员脱敏 `apiKey`。

---

### BUG-05【高 · 越权】`project-list` 用 `startsWith` 做路径边界，可跨用户读项目文件

- **来源**：round3 BUG-03
- **位置**：`backend-ts/src/file/file.routes.ts` 第 232–248 行
- **对照**：`path-sandbox.ts` 的 `isUnder()` 使用 `path.relative`，不会被数字前缀误匹配。

`projectKey` 未做 slug 校验。`resolve(userRoot, 'projects', '../../10/projects/secret')` 会规范化到另一用户目录；随后 `'…/workspace/10/projects/secret'.startsWith('…/workspace/1')` 为 true。用户 ID 为另一用户 ID 的前缀时即可穿越。

- **修复方向**：改用 `isUnder(projectPath, userRoot)`；并对 `projectKey` 拒绝 `..` 与路径分隔符。

---

### BUG-06【高 · 路径逃逸】`workspace-read` 跟随符号链接可读工作区外文件

- **来源**：round3 BUG-08
- **位置**：`backend-ts/src/file/workspace-browse.service.ts` 第 215–227 行
- **对照**：同文件 `downloadFile` 第 122–126 行用 `lstatSync` 拒绝符号链接，并调用 `assertRealPathInWorkspace`。

`resolvePath` 只保证逻辑路径落在工作区内。`statSync` / `readFileSync` 会跟随 symlink。`readImageFile` 同样没有 realpath 校验。

- **触发**：工作区内存在 `leak.txt -> /etc/passwd`，调用 `workspace-read?path=leak.txt` 读出目标内容。
- **修复方向**：`readFile` / `readImageFile` 读取前调用 `assertRealPathInWorkspace`，或 `lstat` 拒绝 symlink。

---

### BUG-07【高 · 功能错误】定时任务被删除后仍可能执行一次

- **来源**：round2 BUG-02
- **位置**：`backend-ts/src/schedule/scheduled-task.service.ts` 第 184–208 行

`selectById` 过滤软删，删除后返回 `null`。拿到锁后只在 `latest != null` 时刷新 `task.status`；`latest == null` 时完全不处理，继续用内存里过期的 `ACTIVE` 去执行。

- **触发**：任务到期推进 `nextFireTime` 后进入 `withSessionLock` 排队；排队期间用户删除任务。
- **修复方向**：`latest == null` 视为已删除，立即 `return`。

---

### BUG-08【高 · 数据不一致】任务在等待锁期间被暂停后，仍计入本次触发次数

- **来源**：round2 BUG-03
- **位置**：同函数第 206–208 行与 `finally` 第 249–257 行

拿到锁后读到 `PAUSED` 会 `return` 跳过真正执行，但 `finally` 无条件递增 `fireCount`、写 `lastFireTime`。`nextFireTime` 已在排队前推进，造成「该跑的没跑，不该计数的却计了数」。

- **修复方向**：`finally` 仅在真正进入执行分支时计数；跳过分支绕开计数副作用。

---

### BUG-09【高 · 双跑】队列自动消费 500ms 占位窗与定时任务互斥失败

- **来源**：1114 BUG-8
- **位置**：
  - 队列占位后延迟 500ms：`streaming-ws-handler.ts` 第 856–891 行
  - 定时任务只看 DB phase：`scheduled-task.service.ts` 第 214–230 行
  - `executePersistedUserPrompt` 对已有 claim 是「没有才 add」，然后直接 `runExecution`：`streaming-ws-handler.ts` 第 396–425 行

上一轮结束后 `autoConsumeQueue` 先 `executionClaims.add`、出队、写 USER 消息，再 `setTimeout(500)` 才真正执行。这 500ms 内 phase 仍是 IDLE。到期的定时任务读到非 RUNNING，直接 `updatePhase(RUNNING)` 再写一条 USER 并 `liveExecution`；发现 claim 已在，仍然启动 `runExecution`。两边用会话锁串行，不会并行改同一把锁，但会连续跑两轮 Agent。

- **修复方向**：定时任务 `liveExecution` 前检查 `executionClaims`（占用则改为 enqueue）；或取消 500ms 窗口。互斥应以 claim 为准。

---

### BUG-10【高 · 并发竞态】Git 写操作锁存在 TOCTOU，无法真正串行化

- **来源**：round2 BUG-04
- **位置**：`backend-ts/src/file/git-write-operation.service.ts` 第 76 行、第 257–260 行、第 110–113 行

`locks` 是进程内 `Map<string, boolean>`。`locked()` 先 `await resolveRepository(...)`（文件系统 I/O），再 `get`/`set`。两个请求可在 await 之后同时看到锁为空。`refreshRemoteStatus` 走另一套锁存取，与 `locked()` 互不知晓。

- **修复方向**：换成基于 Promise 链的互斥（类似 `withSessionLock`），同一 repo 严格串行。

---

### BUG-11【高 · 并发竞态】微信监控循环退出时误删新监控句柄，且长轮询无法被真正中断

- **来源**：round2 BUG-05
- **位置**：`backend-ts/src/weixin/monitor.service.ts` 第 76–83、85–132、134–175 行

`getUpdates` 只传 `timeoutMs`，没有把 `AbortSignal` 传给 HTTP 请求，`stopMonitor()` 的 `abort()` 不能立刻打断长轮询。循环退出时无条件 `this.activeMonitors.delete(accountId)`，不校验是否仍是自己创建的 handle。解绑后立刻重新绑定，旧循环退出会删掉新 handle。

- **修复方向**：① `getUpdates` 把 `signal` 传给 HTTP 客户端；② 退出时只删除仍属于本循环的条目。

---

### BUG-12【高 · 发错人】微信媒体工具固定取 `tokens[0]`，多联系人时发给错误用户

- **来源**：round3 BUG-07
- **位置**：`backend-ts/src/weixin/media-tool-support.ts` 第 27–39 行；`wechat-tool-bridge.ts` 上传同样用 `tokens[0]`；`context-token.repository.ts` 的 `findByAccountId` 无 `ORDER BY`。

`resolveTarget` 完全忽略 `sessionId`，只按 Mao 用户找到 Bot 账号，再取该账号下任意一条 context_token。同一 Bot 被 A、B 两人聊过就会有两条 token，顺序取决于 MySQL 返回顺序。

- **修复方向**：会话或 runtime 保存当前 `fromUserId`；按 `(accountId, session 关联的 wxUserId)` 取 token。

---

### BUG-13【高 · 重复投递】Webhook 任务通知 `resolveWebSocket` 覆盖已成功终态

- **来源**：round2 BUG-06
- **位置**：`backend-ts/src/notification/task/delivery.service.ts` 第 92–104 行

`resolveWebSocket` 的 `updateById` 无条件覆盖 status。调度器 `claim` 已用 CAS。`task-terminal.service.ts` 通过 `sendWithResult(...).then(...)` 再丢进 `notificationExecutor`，执行时机不确定。WS 未连接时迟到的 `resolveWebSocket(delivery, false)` 可把已 `SUCCEEDED` 的记录改回 `PENDING`，调度器再投一次。

- **修复方向**：条件更新 `WHERE id=? AND status='WAITING_WS'`（或当前等价的 `WAITING_WS` 状态值）。

---

### BUG-14【高 · 数据丢失】队列「立即执行」先删后写，失败时消息永久消失

- **来源**：round3 BUG-04
- **位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts` 第 760–812 行
- **对照**：同文件 `autoConsumeQueue` 第 893–898 行在提交失败时 `enqueueHead` 回补。

`handleInsertMessage` 在 `saveMessage` / `handleSendMessage` 之前就把队列项 `delete` 掉。`catch` 只清标志位，不回补队列。

- **修复方向**：先 `saveMessage` 成功再 `delete`；或 `catch` 里 `enqueueHead` 回补并 `sendQueueUpdated`。

---

### BUG-15【高 · 数据丢失】`edit_and_resend` 先截断后续消息，失败路径不回滚也不执行

- **来源**：1114 BUG-4
- **位置**：`backend-ts/src/session/ws/streaming-ws-handler.ts` 第 458–476 行

`editMessageAndTruncate` 会逻辑删除该用户消息之后的全部助手/工具轮。截断发生在执行占位与 LOCAL 连通性检查之前。之后仍可能命中 `executionClaims`、LOCAL 未连接、或 `submitExecution` 被线程池拒绝。历史已删，新执行没有发生。

- **修复方向**：先做 claim / LOCAL 连通性检查再截断；或失败时恢复 `deleted` 标记。

---

### BUG-16【高 · 数据丢失】REST 编辑消息不校验「最后一条」，可截断整段历史

- **来源**：round3 BUG-16
- **位置**：`backend-ts/src/session/session.routes.ts` 第 380–388 行；`session.service.ts` 第 880–898 行
- **对照**：WS `edit_and_resend` 用 `getLastUserMessage` 拒绝非末条。

`editMessageAndTruncate` 只校验 `role === 'USER'`、会话归属和压缩边界，然后 `logicalDeleteAfter`。没有「必须是最后一条 USER」检查。

- **触发**：会话消息 id=10（USER）、11（ASSISTANT）、12（USER）。调用 `PATCH /api/v1/sessions/{sid}/messages/10`。
- **修复方向**：REST 路径对齐 WS：先 `getLastUserMessage`，id 不匹配则拒绝。

---

### BUG-17【高 · 状态泄漏】线程池拒绝后：插队永久停消费、边路会话 claim 泄漏

- **来源**：1114 BUG-7
- **位置**：`streaming-ws-handler.ts` 第 767–812 行（插队）、第 588–594 行（边路）；拒绝是同步抛错：`agent-executor.ts` 第 53 行

1. `insert_message` 在提交前把 session 加入 `suppressAutoConsumeSend`，清除只在已提交任务的 `finally`。提交失败则内层永不跑，之后 `autoConsumeQueue` 开头直接 return，队列积压到进程重启。
2. `handleCreateSideSession` 在 `executionClaims.add` 之后直接 `agentExecutor` 且无 try/catch。拒绝后 claim 永久残留，对该 side 会话后续发送一直 `session_already_running`。

同文件 `submitExecution` 和 `autoConsumeQueue` 已经按这个坑做了回滚，这两处漏了。

- **修复方向**：`agentExecutor` 外包 try/catch，拒绝时删除 `suppressAutoConsumeSend` / `executionClaims`。边路创建复用 `submitExecution`。

---

### BUG-18【高 · 取消无效】`wait_subagents` 阻塞期间无法响应用户取消

- **来源**：round3 BUG-05
- **位置**：`backend-ts/src/harness/tool/impl/background-subagent-tools.ts` 第 187 行
- **对照**：`agent-loop.ts` 把 `cancelFlag` 传给 `waitForAll`；`waitForAll` 每轮轮询 `cancelFlag?.get()`。

工具层硬编码传入 `null`，默认超时 30 分钟。WS `cancel` 已设置会话 cancelFlag，但该工具调用感知不到。

- **修复方向**：从 `AgentLoop` / `ToolCallContext` 取当前会话 cancelFlag 传入 `waitForAll`。

---

### BUG-19【高 · 功能缺失】LOCAL 边路任务与子代理执行前不同步 skill

- **来源**：round3 BUG-06
- **位置**：
  - 边路只 `syncMcpServersToClient`：`streaming-ws-handler.ts` 第 600–608 行
  - 主会话有 skill sync：同文件第 347–355 行
  - 子代理 `runVisible` 无 sync：`subagent-visibility-service.ts`
  - 技能路径按 sessionId 隔离：`runtime-data-resolver.ts` 第 44–46 行

`syncSkillsToClient` 把技能包下发到桌面 `~/.mao/runtime/{sessionId}/skills/`。边路/子代理使用新的 sessionId，系统提示里的路径指向 `{childSessionId}`，但从未对该 ID 发 `skill_sync_required`。

- **触发**：LOCAL 桌面模式创建边路任务，或 `delegate` / `spawn_subagent`。Agent 按系统提示 `read_file` 读技能文件，文件不存在。
- **修复方向**：抽取 `ensureLocalSkillsSynced`，在边路与子代理 LOCAL 入口调用；失败则与主会话一样 `finishFailedSession`。

---

### BUG-20【高 · 状态机】`persistToolRound` 把仍在跑的后台子代理误标 `DELIVERED`

- **来源**：round3 BUG-14、1114 BUG-2（同一缺陷）
- **位置**：`backend-ts/src/harness/core/harness-service.ts` 第 222–239 行

父轮工具消息落库时，凡 `parent_tool_call_id` 匹配且仍为 `PENDING` 的 execution 一律标 `DELIVERED`。这对同步 `DELEGATE` 正确。`spawn_subagent` / followup 是立刻返回 ack，execution 仍 `RUNNING`。spawn 工具轮一持久化：

1. `listRecoveryCandidates` 只认 `PENDING` → 崩溃后后台子代理不会进入恢复；
2. `deliver()` 遇到已 `DELIVERED` 直接 `SKIPPED` → 父会话完成通知永不写入。

- **修复方向**：UPDATE 增加 `AND invocation_type = 'DELEGATE'`（或排除 `BACKGROUND`/`FOLLOWUP`）。

---

### BUG-21【高 · 结果延迟】后台任务（非子代理）结果注入后未丢弃 `preparedRequest`

- **来源**：round2 BUG-08、1114 BUG-3（同一缺陷；1114 补充了 `buildContext` 每次执行都会预构建，不必依赖 mid-loop 压缩也能命中）
- **位置**：`backend-ts/src/harness/core/agent-loop.ts` 第 153–180 行

`bgSubagentResults` 分支有 `context.preparedRequest = null`；紧邻的 `bgResults`（`BackgroundTaskManager`，如 async shell）分支缺少同样处理。`buildContext` 出口必写 `preparedRequest`。

- **触发**：后台 shell 完成后的下一轮父会话执行（常见）；或同一次循环里 mid-loop 压缩后再消费到后台结果。本轮请求仍使用不含 `<后台任务结果>` 的旧快照。
- **修复方向**：`bgResults` 分支同样清空 `preparedRequest`；更稳妥的是任何 `addSystemMessage` 之后统一失效。

---

### BUG-22【高 · 上下文错误】改 system prompt / tools / 摘要后未丢弃 `preparedRequest`

- **来源**：round3 BUG-15（与 BUG-21 同类机制，但是**构建后改上下文**，不是结果注入）
- **位置**：
  - `buildContext` 设置缓存：`harness-service.ts` 第 385–403 行
  - 子代理事后改 prompt/tools：`background-subagent-manager.ts` 第 717–733 行
  - 边路追加摘要：`executeSideFirstMessage` 第 510–520 行

`buildContext` 末尾已经 `preparedRequest = buildRequest(...)`，快照了父 Agent 的 system 与全量 tools。随后改 `systemPrompt`、过滤 tools、追加主任务摘要都不会失效缓存。`AgentLoop` 首轮优先用缓存。内置 `researcher`/`reviewer`/`coder` 均带 `systemPromptOverride` 或 `excludedToolNames`。

- **触发**：`spawn_subagent`/`delegate`（reviewer 首轮仍看到 `write_file`）；或创建 Side Task 且 `inheritContext=true`（首轮看不到 `<主任务背景摘要>`）。
- **修复方向**：凡在 `buildRequest` 之后改 `systemPrompt`、`tools`、`messages`，统一 `context.preparedRequest = null`。

---

### BUG-23【高 · 可靠性】`LocalExecutor` 忽略 `sendReliable` 失败

- **来源**：round2 BUG-07
- **位置**：`agent-cli/src/local/executor.ts` 全部 `sendReliable` 调用点均未检查返回值；定义于 `agent-cli/src/ws/ws-client.ts` 第 154–171 行

工具（如 `shell`、`write_file`）已在本机执行完毕后，WS 处于断线重连窗口，`sendReliable` 尝试重连仍失败返回 `false`。结果被彻底丢弃，服务端会话卡在等待该工具结果。

- **修复方向**：返回 `false` 时把关键回执暂存到本地队列，下次重连后补发；或至少在 stderr 打印明确告警。

---

### BUG-24【高 · 永久挂起】agent-cli 收到 WS `error` 不结束等待

- **来源**：round3 BUG-17
- **位置**：`agent-cli/src/session/session-runner.ts` 第 565–567 行
- **对照**：desktop `useStreamWS.ts` 收到 `error` 会把会话标 `FAILED` 并 reject pending。

`runPrompt` → `waitUntilSettled` 只在 `session_status` 终态或超时解除。`error` 分支只 `emit`，不置 `terminal`、不 `flushWaiters`。服务端部分失败路径（LOCAL 未连接、线程池拒绝）只推 `error`、不推 `session_status`。

- **触发**：`mao-agent -p ...` 或 REPL 发消息时，服务端只下发 `error`。无 `--max-duration` 时无限等待。
- **修复方向**：`case 'error'` 设 `terminal = { phase: 'FAILED' }` 并 `flushWaiters`。

---

### BUG-25【高 · 前端竞态】`TaskView.loadSession` 无请求代际保护

- **来源**：round2 BUG-11
- **位置**：`desktop/src/views/task/TaskView.vue` 第 792–836 行
- **对照**：`useGitRepos.ts` / `useGitStatus.ts` 已有 `requestSeq` 防护。

`loadSession` 在 `await api.get` 返回之后，直接把响应写入模块级共享 ref（`agentId`、`executionMode`、`workspace` 等），全程没有判断 `sid` 是否仍是当前选中会话。快速切换 A→B→C 时，A 的慢响应可覆盖 C 的状态，文件树/Git 面板/权限提示显示错误会话。

> 附：`desktop/src/composables/useFileBrowser.ts` 第 10–28 行 `loadRoot()` 同类问题——CLOUD 模式快速切换会话会重建 provider，慢响应的旧会话目录列表可能覆盖新会话文件树。根因相同，不单独立项。

- **修复方向**：入口 `const seq = ++loadSeq`，返回后 `if (seq !== loadSeq) return`。

---

### BUG-26【高 · 状态错绑】`side_session_created` 缺少关联 ID，多个占位 Tab 时绑定错误

- **来源**：round2 BUG-12
- **位置**：
  - 事件派发：`desktop/src/composables/useStreamWS.ts` 第 763–776 行
  - Tab 绑定：`TaskView.vue` 第 428–437 行
  - 面板侧：`SideChatPanel.vue` 第 543–557 行

事件只带 `parentSessionId`、`sideSessionId`、`title`，没有任何请求发起方关联 ID。`TaskView.handleSideSessionCreated` 找第一个 `sideSessionId <= 0` 的 Tab 就绑定；`SideChatPanel` 只判断「自己是否还没有真实 id」就认领。

- **触发**：连续新建两个及以上占位 Tab，在非第一个占位 Tab 里首次发送。真正发消息的 Tab 仍显示占位，另一个从未发送的 Tab 被绑上真实会话 id。
- **修复方向**：前端生成 `clientRequestId` 随请求下发，事件原样带回；按 ID 精确匹配。临时缓解：限制同一时间只允许一个未确认的占位 Tab。

---

### BUG-27【高 · 状态错绑】后台会话完成误关前台 `sending`；发送失败可能删掉当前会话气泡

- **来源**：round3 BUG-09；1114 附录第 4 条为同一 `pop` 问题
- **位置**：`desktop/src/composables/useChat.ts` 第 151、444–452、987–1002 行

`pendingCallbacks` 按 sessionId 分桶，但完成回调写的是组件级单槽 `sending`。打开 RUNNING 的会话 A，再切到 RUNNING 的会话 B，A 先 COMPLETED 时 B 的停止按钮会消失。

`catch` 里的 `messages` 是当前激活会话的列表。会话 A 发送过程中切到 B，A 失败会 `pop` 掉 B 最后一条空 assistant。

- **修复方向**：完成/失败回调内仅当 `sessionId.value === sessionIdVal` 时才改 `sending`；`pop` 改为 `sessionStore.getMessages(sid)` 定位删除。

---

### BUG-28【高 · 双气泡】主会话乐观助手未登记流式 ID，流式事件再插一条空气泡

- **来源**：1114 BUG-5
- **位置**：`useChat.ts` 第 403–410、588–595 行；复用条件：`stores/session.ts` 第 1120–1146 行
- **对照**：边路 `SideChatPanel` 使用 `ensureStreamingAssistantMessage`。

发送/「编辑并重发」先插入空 assistant，但 `addAssistantMessage` **不**写入 `streamingAssistantMessageIds`。首个 `content_delta` / `thinking_delta` / `tool_call_start` 走 `ensureStreamingAssistantMessage`：末条已是 assistant，ID 未登记 → 再 append 一条。这是默认发送路径。

- **修复方向**：主会话与边路统一调用 `ensureStreamingAssistantMessage`，删除这两处 `addAssistantMessage`。

---

### BUG-29【高 · 入队门闩】主会话入队判定漏掉 `RESUMING`/`CANCELLING`

- **来源**：1114 BUG-6
- **位置**：`useChat.ts` 第 867–877 行
- **对照**：同文件恢复判定含 `RESUMING`（第 146–148 行）；UI `agentRunning` 含四态（`ChatPanel.vue` 第 344–347 行）；边路 `ACTIVE_PHASES` 已对齐四态。

`ChatPanel.handleSend` 用 `isActive` 决定入队还是新发。`isActive` 只认 `RUNNING` / `WAITING_APPROVAL`。恢复/重试会推 `RESUMING`，取消过程为 `CANCELLING`。UI 转圈按四态显示「正在跑」，发送逻辑却当成空闲走新发送。

- **修复方向**：`isActive` 与 `ACTIVE_PHASES` 使用同一集合。

---

## 三、中等问题

### BUG-30【中 · 静默失败】`grep_search` JS 回退用文件名匹配 glob

- **来源**：round3 BUG-10
- **位置**：`backend-ts/src/harness/tool/impl/grep-search-tool.ts` 第 177–191 行

`globToFileRe` 编译 `src/**/*.ts` 成 `^src/.*.*/.*\.ts$`，`collectFiles` 对 `readdirSync` 的 basename（`foo.ts`）测试永远失败。有 `rg` 时不受影响；`rg` 不在 PATH 时静默退回这条路径，带目录前缀的 glob 得到空结果。

- **修复方向**：对相对路径做 glob 匹配，而不是 basename。

---

### BUG-31【中 · 行为不一致】`grep_search` JS 回退不忽略依赖目录

- **来源**：1114 BUG-10
- **位置**：同文件 `collectFiles` 第 182–192 行
- **对照**：`glob-search-tool.ts` 已用 `IGNORED_DIRS`（`node_modules`、`.git`、`dist` 等）对齐 rg 默认忽略。

无 `rg` 时全树遍历，工作区稍大就会扫进依赖树，匹配被噪音淹没、易触达截断。

- **修复方向**：`collectFiles` 复用 glob 的 `IGNORED_DIRS`。

---

### BUG-32【中 · 状态机】子代理处于 `WAITING_APPROVAL` 时仍可发起追问

- **来源**：round3 BUG-11
- **位置**：`subagent-invocation.service.ts` 第 87–90 行；`delegate-tool.ts` 第 306–308 行

LOCAL 危险工具审批时，子代理会话会 `enterWaitingApproval`。此时第一个 AgentLoop 仍阻塞在审批 Future 上，phase 却已不是 `RUNNING`。`delegate_followup` 只拒绝 `RUNNING`，放行后强行把 phase 改回 `RUNNING` 并启动第二次执行。

- **修复方向**：拒绝集合补上 `WAITING_APPROVAL`、`CANCELLING`；追问前若该会话仍有未决审批则直接返回错误。

---

### BUG-33【中 · 结果丢失】后台任务 30 分钟清理不区分会话、不取消底层 promise

- **来源**：round3 BUG-12
- **位置**：`backend-ts/src/harness/core/background-task-manager.ts` 第 37–61 行

已完成分支会跳过其他会话；abandoned 分支没有 `sessionId` 判断。任意会话的 AgentLoop 调用 `consumeCompletedResults` 时，都会把**所有会话**里超过 30 分钟仍未完成的任务从 Map 里删掉。`entry.cancelled = true` 之后没有任何代码读取该标志，底层 promise 继续跑完，结果无处投递。

- **修复方向**：abandoned 分支加上 `sessionId !== entry.sessionId` 跳过；删除前向 Agent 注入超时错误。

---

### BUG-34【中 · 配额泄漏】过期 shell 清理不维护 `conversationSessions`

- **来源**：round3 BUG-18、1114 BUG-9（同一缺陷）
- **位置**：`backend-ts/src/harness/shell/shell-session-manager.ts` 第 315–326 行
- **对照**：`removeSession` 第 392–400 行会从 `conversationSessions` 删除 ID。

定时清理只从 `sessions` Map 删除并 `close()`，不走 `removeSession`。幽灵 ID 留在 `conversationSessions` 里，之后 `getOrCreate` 仍认为已达 `maxSessionsPerConversation`。

- **修复方向**：`cleanupExpiredSessions` 改为调用 `removeSession`。

---

### BUG-35【中 · 平台不一致】`grep_search` 本地实现用冒号切分 `rg` 输出

- **来源**：round2 BUG-09
- **位置**：`agent-cli/src/local/tools/search.ts` 第 176–187 行
- **对照**：后端已改用 `rg --json`。

Windows LOCAL 模式 `rg` 输出 `C:\project\foo.ts:10:const x = 1`。`indexOf(':')` 命中 `C:`，`lineNum` 解析失败，匹配被静默丢弃。`rg --context` 的上下文行用 `-` 分隔，同样无法解析。

> 附：同文件 `ignore_case` 用 `Boolean(args.ignore_case)`（第 228 行），字符串 `"false"`/`"0"` 会被误判为 `true`。建议与本条一并改为复用 `asBool`。

- **修复方向**：与后端一致改用 `rg --json`。

---

### BUG-36【中 · 行为不一致】`read_file` 负 `offset` 时行为与后端不一致

- **来源**：round2 BUG-10
- **位置**：`agent-cli/src/local/tools/files.ts` 第 101–103 行；对照后端 `read-file-tool.ts` 第 65 行 `Math.max(0, asInt(...))`

`Number(-1) || 0` 的结果是 `-1`，`Array.prototype.slice(-1, end)` 从倒数第 1 个元素开始截取，只返回最后一行，而不是从第 0 行开始。

- **修复方向**：`const start = Math.max(0, Number(args.offset ?? 0) || 0)`。

---

### BUG-37【中 · 末位管理员保护可绕过】`PUT /v1/users/:id` 设 `status=0` 不走 `assertCanDisableUser`

- **来源**：round3 附录（已核实为真实缺陷；原报告因调用方已有 `user:write`、影响面小于 BUG-02/BUG-03 而未单列，本轮按「存在即保留」收入）
- **位置**：`backend-ts/src/user/user.service.ts` 第 73–76 行；路由 `user.routes.ts` 第 79–90 行
- **对照**：专用接口 `updateUserStatus` 第 84–88 行会调用 `assertCanDisableUser`。

管理员可通过 `PUT /v1/users/:id` 的 `status=0` 绕过末位管理员保护，把最后一个 ADMIN 禁用。

- **修复方向**：`updateUser` 在 `status === 0` 时同样调用 `assertCanDisableUser`。

---

### BUG-38【中 · 越权】统计与分析接口仅校验登录

- **来源**：round3 附录（与 BUG-04 同类，原报告未单列）
- **位置**：`backend-ts/src/statistics/statistics.routes.ts`、`backend-ts/src/analytics/analytics.routes.ts` 均只 `requireUserId`
- **对照**：admin 侧 `/v1/admin/analytics/*` 已 `await requireAdmin`。

普通登录用户可调用 `/v1/statistics/*`、`/v1/analytics/*` 读取全站运营数据。

- **修复方向**：加 `requireAdmin` 或对应 `*:read` 权限校验。

---

## 四、已核实但并入正文条目的相关问题

以下与正文同源或触发面较窄，不另编号，修复对应条目时可一并处理：

1. **入队不改写文件引用路径**（`useChat.ts` 第 880–893 行）：直发会把 `@{rel}@` 编成绝对路径，`enqueueMessage` 跳过。Agent 运行中带文件引用入队时，服务端拿到相对路径，工具读文件失败。与 BUG-29 同文件。
2. **`restoreSession` 用错会话的 phase**（`useChat.ts` 第 1016–1021 行）：`fetchMessages` 回调里用 `sessionStore.activeSession?.phase` 决定是否给**旧 sid** 补流式占位。快速 A→B 切换时，空闲会话被插占位、进行中会话漏补。与 BUG-25 / BUG-28 同类竞态。
3. **子代理 `toolCallCount` 双计**（`subagent-result-collector.ts` 第 27–30 行 + `agent-loop.ts` 第 241–246 行）：流式 early `onToolCallStart` 与 `onComplete` 再刷一次是约定（`agent-loop.spec.ts` 断言每个 tool 调 2 次，WS 监听器按 id 去重）。collector 每次 `++`，落库 `totalToolCalls` / 返回给父代理的 `tool_calls` 约为真实次数的 2 倍。
4. **`newSession`/`cleanup` 会 `clearPendingApprovals` 并自动 deny 全部 LOCAL 审批**（`useChat.ts` 第 928、1042 行）：切到「新任务」时会误拒其他会话挂起的审批。切已有会话走 `restoreSession` 不会触发。
5. **边路 `SideChatPanel.handleChatSend` 无 `await connect()`**：`createSideSession` 走 `send()`，WS 未 OPEN 时静默丢包（`useStreamWS.ts` 第 304–309、434–456 行）。主会话 `useChat` 有 connect。
6. **`waitForLocalNoDeadline` 名称为「无截止」实际硬编码 60s**（`subagent-execution-recovery.service.ts` 第 154–164 行）：后端重启后用户若晚于 60s 打开桌面，LOCAL 后台子代理恢复会失败。建议复用同步 delegate 的 `timeoutSeconds`（默认 3600s）。

---

## 五、丢弃项（源码无法坐实，或原报告已排除）

| 原出处 | 条目 | 丢弃原因 |
|--------|------|---------|
| round2 附录 | Android `AppUpdatePlugin` 下载失败在子线程 `call.reject` | 未能用实机/单测证明 Capacitor `PluginCall` 会因此悬挂 |
| round3 附录 | Android `downloadToFile` 仅以 `tmp.length() > 0` 视为成功 | 缺少实机验证；与上条同文件，不计入正文 |
| round2 / round3 附录 | 多实例下定时任务 / `BackgroundTaskManager` / `inFlight` 为进程内状态 | 当前单节点部署（`/opt/mao`）不会触发 |
| round2 附录 | admin 列表删除末页最后一条后分页页码未回退 | 纯 UI 体验，不影响数据正确性 |
| round3 附录 | agent-cli `resolveWorkspacePath` 对绝对路径不做工作区约束 | LOCAL 模式在用户本机执行，属产品设定而非逻辑 BUG |
| round3 附录 | admin 定时任务 `GET /all` 列全员，但 `PUT/DELETE` 要求 `task.userId === 当前用户` | 产品契约不一致，需先明确「管理员旁路」还是「列表按 owner 过滤」 |

三份原文中的编号条目（round2 的 12 条、round3 的 18 条、1114 的 10 条）经源码核对**全部真实存在**，无「编号条目被证伪」的情况。1114 与 round2/round3 的重复项已合并为 BUG-03、BUG-20、BUG-21、BUG-27、BUG-34。

---

## 修复建议优先级

1. **立刻**：BUG-03（一行 `await`，权限旁路）、BUG-02（角色提权）、BUG-01（LDAP 禁用绕过）。
2. **本迭代**：BUG-04 / BUG-05 / BUG-06（越权与路径逃逸）、BUG-20（子代理崩溃恢复形同虚设）、BUG-28（主会话每次发送都双气泡）、BUG-21 / BUG-22（`preparedRequest` 过期）、BUG-14 / BUG-15 / BUG-16（消息丢失与历史截断）。
3. **随后**：其余高优先级状态机 / 竞态 / 可靠性问题，以及中等问题。
