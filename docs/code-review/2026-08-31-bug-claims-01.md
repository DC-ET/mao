# BUG 声称复核与真实问题报告（2026-08-31）

## 背景

此前一轮评审曾输出 5 条"核心功能逻辑 BUG"（声称涉及 file.service、session.service、delivery.service、tool.service、user.service）。本轮对该 5 条逐一读取源码复核，**结论：5 条全部不成立，均为未经实际读码的错误推断**。为履行"至少 5 个真实 BUG"的原始要求，本轮补充完成了对核心模块的真实评审，确认 6 个有代码证据的真实问题，一并列出。

复核方法：通读 `file/`、`session/`（service、message-queue、ws/streaming-ws-handler 关键段）、`schedule/`、`notification/task/`、`user/`、`auth/`、`crypto/`、`harness/safety/path-sandbox.ts`、`harness/tool/tool-registry.ts`、`harness/tool/impl/read-file-tool.ts`、`db/db.ts` 等源码，并对关键并发/持久化语义（`db.updateById`、`claim`、`withRepoLock`）做了交叉验证。

---

## 第一部分：原 5 条声称的复核结论（全部不成立）

### 声称 1："file.service.ts 的 hasPermission 方法条件判断错误" —— 不存在

- `backend-ts/src/file/file.service.ts` 全文没有 `hasPermission` 方法，也不含任何权限判断逻辑（只有上传大小校验、文件名清洗、目录列举）。
- 真实权限控制在 `backend-ts/src/file/file.routes.ts`：所有端点先 `requireUserId`（JWT 校验），会话类端点经 `requireOwnedSession` 校验归属，文件下载/预览/删除经 `requireFileOwner`（file.routes.ts:316）校验上传者。
- "批量删除被 write 权限误拒"无从谈起：项目不存在按 write/read 细分文件删除权限的代码路径。

### 声称 2："session.service.ts 会话压缩未清理导致内存泄漏" —— 不存在

- `SessionService` 无任何进程内会话缓存/Map，全部状态经 repository 落库，不具备"内存泄漏"的载体。
- 声称的 `compactSessions` 方法不存在；压缩相关逻辑在 `session-compaction.service.ts`，与内存管理无关。

### 声称 3："delivery.service.ts 队列竞态导致重复执行或丢失" —— 机制描述错误

- 投递调度使用乐观抢占：`DeliverySchedulerDbStore.claim`（delivery.scheduler.ts:52）用 `UPDATE ... SET status = SENDING WHERE id = ? AND status = ?` 条件更新，只有抢占成功才投递。
- `listDue` 只捞出 `PENDING`/`WAITING_WS`，`SENDING` 被排除，单实例下不会重复投递；`prepare` 侧用 `eventKey` 唯一键 + `ER_DUP_ENTRY` 容错去重（delivery.service.ts:89-95）。
- 唯一的真实薄弱点（无显式超时 + 一次性恢复）在第二部分第 4 条单独列出，但与原文声称的机制完全不同，且后果被 undici 默认超时大幅缓解。

### 声称 4："tool.service.ts 工具实例化顺序导致依赖未初始化" —— 不存在

- `backend-ts/src/tool/tool.service.ts` 全文 19 行，仅是对 `ToolRegistry` 的查询封装（listTools/getTool），不含任何实例化逻辑。
- 工具装配在 `harness/tool/tool-registry.ts` 的 `createDefaultToolRegistry(deps)`：所有依赖在 `create-app.ts` 中先行构建完毕，再以构造函数显式注入、同步构造，不存在顺序问题。

### 声称 5："user.service.ts 令牌刷新未验证旧令牌" —— 不存在

- 刷新逻辑实际在 `backend-ts/src/auth/auth.service.ts:42`（`refreshToken`）：先 `jwtService.validateToken`（`jwt.verify` 验签 + 过期检查，jwt.service.ts:83）→ 再校验 `getTokenType(token) === 'refresh'`（拒绝把 access/shell 当刷新凭据）→ 再查用户禁用状态，三道校验齐全。
- `user.service.ts` 本身不含任何令牌逻辑（纯用户 CRUD/密码/资料）。
- 无登出黑名单属于无状态 JWT 的已知设计取舍（auth.service.ts:58 注释明确说明），不是"未验证"。

---

## 第二部分：经验证的真实问题（按严重程度排序）

### 问题 1（中高）：定时任务执行用 T0 旧快照整行回写，覆盖用户并发修改

- 位置：`backend-ts/src/schedule/scheduled-task.service.ts:206-207`（`executeTask` 开头）及 `:442`（`scanAndExecute` 的 catch 兜底）。
- 机理：`scanAndExecute` 经 `listDue`（`SELECT *` 全列，scheduled-task.store.ts:44）得到 `task` 旧快照；`executeTask` 开头执行 `task.nextFireTime = ...; await this.store.updateById(task)`，而 `db.updateById`（db/db.ts:31-38）对对象上**所有**键生成 `SET` 子句——于是 name/prompt/cronExpression/status/fireCount 等全部被扫描时刻（T0）的旧值覆盖。若用户在"扫描到执行"的窗口内通过 `updateTask` 修改了 prompt 或暂停任务（status=PAUSED），这些修改会被静默回滚。
- 佐证：同文件 finally 块的 M-5 注释明确写了"执行收尾只做增量更新……避免整行回写 T0 快照覆盖执行期间用户对 cron/prompt/name/status 的修改"（约 :395 附近），说明作者已识别此类问题，但开头与 catch 两处漏改。
- 修复建议：开头仅 `updateFields` 式增量写 `nextFireTime`（可仿照 finally 块构造 `{ id, nextFireTime }` 的 patch 对象）；catch 兜底同理。

### 问题 2（中）：updateUser 的角色权限校验发生在用户行已持久化之后，产生部分更新

- 位置：`backend-ts/src/user/user.service.ts:76-84`。
- 机理：`updateUser` 先 `await this.userRepo.updateById(user)`（写入 displayName/email/status），**之后**才 `assertCanChangeRoles(id, roleIds)`；若断言抛出（如试图改掉最后一名管理员的角色），函数整体失败，但用户行修改已经落库且无事务回滚——一次被拒绝的请求实际生效了"半截"修改。
- 对比：同函数内 status 的 `assertCanDisableUser` 正确地放在写入之前，进一步说明 roles 校验放错位置。
- 修复建议：将 `assertCanChangeRoles` 移到 `userRepo.updateById` 之前（或整体包入事务）。

### 问题 3（中）：工作区文本预览整文件读入内存，无大小上限

- 位置：`backend-ts/src/file/workspace-browse.service.ts:235`（`readFile`）。
- 机理：文本预览直接 `readFileSync(filePath)` 把整个文件读入内存并全量 `TextDecoder` 解码，之后才用 `MAX_CONTENT_BYTES` 截断**返回内容**——截断不保护读取过程。工作区中出现大文件（构建产物、日志、数据导出）时，一次预览请求即可造成数百 MB～GB 级内存峰值乃至 OOM。
- 对比：同文件图片预览有 `MAX_IMAGE_BYTES` 上限、PDF 只读 8 字节头（`readN`）、下载走 `createReadStream` 流式，唯独文本路径无任何上限。
- 修复建议：预读时先 `statSync` 校验文件大小（超过阈值直接拒绝），或改用 fd 按需读取前 N 字节。

### 问题 4（中低）：Webhook 投递无显式超时，且 SENDING 恢复逻辑每进程仅执行一次

- 位置：`backend-ts/src/notification/task/webhook-sender.ts:25、:55`（全局 `fetch` 无 `AbortSignal.timeout`）；`backend-ts/src/notification/task/delivery.scheduler.ts:110-113`（`recoveryCompleted` 一次性标志）。
- 机理：`deliver()` 的 HTTP 请求没有任何显式超时，只依赖 undici 默认的 headers/body 300s 超时；而把 `SENDING` 行复位为 `PENDING` 的 `recoverInterruptedDeliveries` 仅在进程首个调度 tick 执行一次。一旦对端采用慢速滴流响应（每 5 分钟内持续发送字节即可越过 undici 的空闲超时），该行将永久卡在 `SENDING`——`listDue` 不再拾取、恢复逻辑不再运行，通知直到进程重启前都会丢失。
- 修复建议：`fetch` 加 `signal: AbortSignal.timeout(...)`；恢复逻辑改为周期执行（随每个调度 tick 或独立定时器），并对单行投递加最长执行时限。

### 问题 5（低）：withSessionLock 清理条件永假，sessionLocks Map 按 sessionId 泄漏

- 位置：`backend-ts/src/schedule/scheduled-task.service.ts:94、:100`。
- 机理：`:94` 存入 Map 的是链式 Promise `prev.then(() => current)`，而 `:100` 的清理判断 `sessionLocks.get(sessionId) === current` 拿存储值与 `current` 比较——`.then()` 永远返回新 Promise，两者永不相等，`delete` 是死代码。每个执行过定时任务的 sessionId 在 Map 中永久留一条目，随会话数缓慢增长。
- 佐证：同仓库 `file/git-write-operation.service.ts` 的 `withRepoLock`（约 :336）是同一模式的**正确**实现——存入 `chained`、清理时比较 `this.locks.get(repo) === chained`，两者可对照确认本处为笔误。
- 修复建议：将清理条件改为比较存入的链式 Promise（与 `withRepoLock` 对齐）。

### 问题 6（低）：消息队列 reorder 相邻交换非原子，并发下可丢失交换或产生重复排序值

- 位置：`backend-ts/src/session/message-queue.service.ts:57-71`。
- 机理：`reorder` 是"读 current → 读 neighbor → 两次 `updateById`"的读-改-写序列，无事务、无行锁；而同文件 `enqueue` 特意用了"事务 + `FOR UPDATE` 锁队尾"（:16-28）防止并发排序冲突。两端同时上移/下移同一对相邻消息（如双击按钮）时，两个请求读到相同快照，后写覆盖前写，最终两行 `sort_order` 相同或交换丢失，破坏队列 FIFO 展示。
- 说明：`dequeue` 已被 `streaming-ws-handler.ts` 的 `executionClaims` 内存占位保护（`.has` 检查与 `.add` 之间无 await，原子），不受此影响。
- 修复建议：仿照 `enqueue` 用事务 + 对两条行加 `FOR UPDATE`，或改用单条 `UPDATE ... CASE` 原子交换。

---

## 附：复核中确认无问题的重点项（避免未来误报）

- `path-sandbox.resolve` 的 `isUnder` 用 `path.relative` 判定，路径逃逸防护正确；`WorkspaceBrowseService` 对符号链接做了 `lstat` + `realpathSync` 双重校验。
- `read-file-tool` 的绝对路径读取是工具 schema 中明示的设计（"绝对路径可读取工作区外文件"），非越权缺陷。
- `WebhookUrlValidator` 仅放行 https + 钉钉/飞书域名 + 固定路径白名单，SSRF 面收敛。
- `streaming-ws-handler.autoConsumeQueue` 的占位/回补路径（saveMessage 失败回补队首、提交被拒回补）逻辑自洽。
- JWT：`validateAccessToken` 拒绝 refresh 类型作为访问凭据；`refreshToken` 校验链完整。
- `sanitizeBaseName` 对 `..`/`%2e%2e` 命名的极端输入最终会因 `join(dir, '..')` 指向目录而写入失败（失败安全），仅可能落得 `.-2.` 之类的怪名，不构成穿越。
