# 开放接口（Open API / Webhook）代码审查 — 第 4 轮

- **日期**：2026-10-05
- **基线**：git 工作区未提交改动，包含第 3 轮 BUG-3 的修复（改动 2 个文件：`backend-ts/src/openapi/openapi.repository.ts` 与 `openapi.repository.spec.ts`）。
- **上轮报告**：`docs/code-review/2026-10-05-open-api-webhook-review-03.md`（BUG-3）。
- **审查方式**：只读审查，**未修改任何源码**，未执行部署。每个疑点先写临时 probe 单测运行验证，跑完即删除（第 4 节 `git status` 复核确认无残留）。

## 1. 总体结论

**无新 bug**。BUG-3 修复成立：`recordOutcome` 改为按 camelCase 键读 `row.consecutiveFailures`，新 spec 的 fake 已与真实 `Db` 的 `toCamelList` 契约对齐，压线起点用例经我独立变异验证**确实能区分 snake_case 访问**（回退成 snake 读法必红）。

本轮重点完成任务 1 的**系统性扫描**：用脚本追踪全仓 349 处 `db.query/queryOne` 调用点的结果消费路径（含命名行类型、`Record<string, unknown>` 类型盲读点、解构、括号访问、mapper 函数五类），**未再发现任何 snake_case 键读 Db 结果的问题**。唯一的两个 snake_case 读取点（dingtalk / feishu 的 progress-card mapper）经确认是本功能未改动的存量代码，且采用 `row.camelCase ?? row.snake_case` 的**双键防御式读法**（camelCase 优先），与 `Db` 契约兼容，不是缺陷。

至此，P2「连续失败 5 次自动停用 + 通知」链路（BUG-1 → BUG-2 → BUG-3）已完整闭环并经 probe 逐段验证。

## 2. 问题列表

无。前三轮的 3 个 bug（BUG-1 直跑不回写、BUG-2 并发丢计数、BUG-3 camelCase 键名）均已修复且本轮复核通过，详见第 3 节。

## 3. 本轮已复核项

### BUG-3 修复

- `openapi.repository.ts:139-149`：类型与读取键均为 `consecutiveFailures`，并补注释「结果键走 Db 层的 camelCase 转换（toCamelList），必须按 consecutiveFailures 读」。与 `db.ts:8-11`（`query` → `toCamelList`）+ `common/case.ts:9-18`（`snakeToCamel`）的契约一致。
- 同文件其余查询（`SELECT *` 的 api_token / webhook_trigger / outbound_subscription / outbound_delivery）本来就按 camelCase 键读，未受影响。
- 与全仓同类查询写法对齐：`feishu/inbound-queue.repository.ts:101`、`dingtalk/inbound-queue.repository.ts:88` 用显式别名 `rank_no AS rankNo`；`feedback/feedback.repository.ts:156` 的 `mapDetailRow` 亦有「行键已被 toCamelList 转为 camelCase」的注释。修复后的 openapi 与这些既有正确写法同构。

### 任务 1：全仓系统性扫描（本轮重点）

用脚本对 `src/**/*.ts`（排除 spec）做四类静态追踪：

1. **查询结果变量的 snake_case 属性访问**：追踪所有 `const x = …query/queryOne` 与 `const { a, b } = …` 的结果变量，扫描 `.snake_case` 访问 → **命中 12 处，全部位于 `dingtalk/progress-card.repository.ts` 与 `feishu/progress-card.repository.ts`**；
2. **命名行类型**：收集 62 个用作查询泛型的命名类型（Agent / Session / WebhookTrigger / MessageQueue / NotificationRow / ApiToken …），逐个检查字段声明 → **无任何 snake_case 字段**；
3. **类型盲读点**：`query<Record<string, unknown>>` 共 8 处（dingtalk/feishu pending-binding、progress-card×4、feedback、flyway）逐一人工核对 → 全部按 camelCase 读（`row.botId`/`row.messageId`/`row.cardMessageId`/`row.eventJson`/`row.messageId`…）；
4. **括号访问与键枚举**：`['snake_key']` 仅 4 处且都是工具入参 schema（`required: ['task_id']`、`required: ['message_id']`），非 Db 结果；无 `Object.keys/entries(row)`。

关于命中 12 处的结论：这两个文件 `git status` 显示**未被本功能修改**（存量代码），且 mapper 的读法是 `row.sessionId ?? row.session_id`——camelCase 优先、snake 兜底。真实 `Db` 一定产出 camelCase 键，故兜底分支不可达但无害，**不计 bug**。真正危险的「只读 snake_case」模式（即 BUG-3）在扫描中已无残留。

顺带确认的两个易混淆点（均非缺陷）：`db/flyway.ts` 用的是自建裸 mysql 连接（`connectFlywayDb`，`flyway.ts:297-317`），不过 `Db` 的 camelCase，因此其 `r.installedRank ?? r.installed_rank` 双键读法是必要的；`create-app.ts` 等处读的 `message_id`/`open_id`/`access_token` 都是**外部 HTTP 响应体**（钉钉/飞书 API），与 Db 无关。

### 任务 2：新 spec 的 fake 与真实 Db 一致性（probe 实测）

- **键形一致**：fake 内部以 snake_case 列名存储、读出前过 `toCamel`（复用 `common/case.ts` 的 `toCamel`，与 `db.ts` 的 `toCamelList` 同一函数），探针实测其 FOR UPDATE 读出的键恰为 `['consecutiveFailures', 'enabled']`——`enabled` 这类无下划线列名保持原名，与真实 `Db` 一致。
- **事务内外一致**：fake 的 `db.queryOne`（autocommit 路径）与 `tx.queryOne`（事务路径）都过 `toCamel`，与真实 `Db`（`transaction` 内是同一 `Db` 实例包住同一连接）一致。
- **数字类型**：`enabled` 为 TINYINT(1)、`consecutive_failures` 为 INT（`V133__open_api.sql`），fake 以 number 存储与返回，符合 mysql2（pool 配置 `supportBigNumbers/bigNumberStrings: false`）的数值行为；且实现侧还有 `Number(...)` 强转兜底。
- **null 处理**：`last_fired_at DATETIME NULL` 初始 null 与写入字符串都不产生 `"null"` 字符串污染（探针验证）。
- **压线用例的鉴别力**（等价变异验证，不改源码）：把「读 snake_case 键」的旧读法复刻进探针、打在同一把新 fake 上，得到 `{consecutiveFailures: 1, disabled: false}` 且库内停在 1——即新 spec 的 `从压线值 4 起单次 FAILED 必须返回 {5,true} 且 enabled=0` 用例**必然转红**，证明该用例非空转、真的在守 camelCase 契约。（声称的 4 转红与我观察到的行为一致。）
- 其余 7 条用例断言均落在返回值与库内行状态上，无双断言或恒真式；`apply` 对 4 参 UPDATE / 2 参 UPDATE / `consecutive_failures = 0` 三条语句分流正确。

### 任务 3：附录候选复审与新疑点证伪

- **限流器 `cleanup()` 无生产调用方**：仍成立。key 为 `token:{id}` / `trigger:{id}`，基数受「每用户 20 token + 20 触发器」硬上限约束（`api-token.service.ts:20`、`webhook-trigger.service.ts:14`），非无界增长；且 `allow()` 在窗口过期时会原地覆盖 `windowStart`。属内存卫生取舍，**不计 bug**。
- **`resolveToken` 死代码**（`jwt-hook.ts:33`）：改造后全仓无调用方，纯卫生问题，无行为影响，**不计 bug**。
- **`sessionId` 未按整数校验**（第 3 轮 probe 已验）：NaN 串 / 小数 / `1e21` / `true` / `{}` 强转后均按「会话不存在」拒绝且不落库，他人会话仍被归属校验挡住。**失败安全，不计 bug**（仅与 `agentId` 的 `Number.isInteger` 口径不一致）。
- **`getSession` 类型窄化**：实现查无行时抛 `SESSION_NOT_FOUND` 而非返回 null，两处调用方的 `== null` 分支不走但抛的是同一错误码，外部行为一致。**无行为分歧，不计 bug**。
- **CLI 无法解除已绑定会话**：前端可解绑，属 CLI 表达力缺口，**非缺陷**。
- **业务异常不计失败**：4xx 级「请求不合法」与「执行失败」语义不同，外部已收到明确错误码，记为**已知取舍**。
- **新疑点 1：停用 → 用户重新启用 → 迟到 settle 的竞态**（probe 实测，5 passed）：连续失败压线停用后，用户 `update(enabled:true)` 会把 `consecutiveFailures` 清零（决策 8）；此后迟到的排队消息 settle 在 `FOR UPDATE` 事务内读到的是**新状态**（0→1），既不会被旧快照带成再次停用，也不会二次通知——第 2 轮修的事务在这里正好保住正确性。
- **新疑点 2：停用期间继续收到合法 webhook**（probe 实测）：验签再对也统一归 404，不累加、不通知；`recordOutcome` 对已停用行只刷 `last_fired_at`，不改写停用态。
- **新疑点 3：通知入参**（probe 实测）：未绑定会话的触发器通知带 `sessionId: null`（`notification.session_id` 在 V131 即为可空，插入路径安全），绑定会话的带真实 sessionId；`failures` 为停用前的最新计数。
- **新疑点 4：锁序**（代码核对，无需 probe）：`withSessionLock`（schedule 域，`scheduled-task.service.ts:204`）由 OpenRunService / 定时任务外层持有，内层才进 ws handler 自己的 `sessionLocks`（`streaming-ws-handler.ts:601`）；两把锁方向一致（schedule 外 → ws 内），且 ws 内不存在反向获取 schedule 锁的路径，无死锁。这也是决策 16 让 OpenRunService 复用 `withSessionLock` 而非自建锁的原因。

## 4. 本轮已运行的验证（只读，未改源码）

- BUG-3 变异等价 probe（snake 读法打新 fake）：**4 passed**（含「压线必红」的反例断言）。
- 附录候选 + 新疑点 probe：**5 passed**（重新启用清零 / 迟到 settle 不误停用 / 停用期间 404 不计数 / 通知 sessionId 两种形态 / 已停用行只刷 last_fired）。
- `cd backend-ts && npx vitest run src/openapi` → **7 files / 51 passed**（含 BUG-3 回归的压线用例）。
- `cd backend-ts && npx vitest run src/openapi src/session src/schedule src/inbox src/db src/auth` → **50 passed + 1 skipped / 693 passed + 13 skipped**（exit 0）。
- `cd backend-ts && npm run build` → exit 0。
- `cd desktop && npx vue-tsc --noEmit` → exit 0，无输出。
- 系统性扫描：349 个查询调用点全部分类核查，结论见第 3 节。
- `git status` 复核：与审查前一致（38 项 = 37 + 本报告），**无 probe 临时文件残留**。

## 附录：仍未关闭的候选（记录备查，均判定不计 bug）

- 限流器 `cleanup()` 无生产调用方（基数受资源上限约束，非无界）。
- `jwt-hook.ts` 的 `resolveToken` 死代码（可顺手清理）。
- 触发器 `sessionId` 数字强转（失败安全，仅校验口径与 `agentId` 不一致）。
- `getSession` 声明 `Session | null` 而实现抛异常（类型窄化，行为一致）。
- CLI `mao open trigger update` 无法解除绑定会话（前端可解绑）。
- 业务异常（Agent 不存在/停用、LOCAL 会话、message 超长）不计失败（4xx 与执行失败语义不同，已知取舍）。
