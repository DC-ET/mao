# 开放 API 技术方案：API Token + 入站 Webhook 触发器 + 出站事件订阅

- 状态：技术方案，待实施（2026-10-05 可行性评审后修订：scope 授权模型与 V121 目录解耦、hook 失败统一 404、触发器默认启用等，见决策 4/5 与新增决策 9~14；同日二次评审逐条核对源码后补充：raw body 捕获、source 扩容触点清单补全、会话锁共享、响应码统一 202 等，见决策 15~16 与 §5.2/§5.3/§5.4/§5.6/§8 修订）
- 日期：2026-10-05
- 提案来源：[docs/proposals/2026-10-05-open-api-webhook.md](../proposals/2026-10-05-open-api-webhook.md)
- 前置阅读：schedule 域执行骨架（`scheduled-task.service.ts` executeTask）、消息队列回写机制（`message-queue.service.ts` + `streaming-ws-handler.ts` settleQueuedScheduledBinding）、task-terminal 来源标注（`task-terminal.service.ts`）、审计白名单（`audit.interceptor.ts` shouldAudit）

## 1. 需求背景

外部系统今天找不到 mao 的 Agent：IM 三渠道面向"人"、定时任务由"时间"驱动、embed SDK 绑定"页面"场景。机器到机器的触发缺失——CI 失败分析、监控告警定位、Git 推送写周报都接不进来。

可复用的骨架已齐：schedule 域验证了「会话忙则 `messageQueueService.enqueue` 排队、终态经 `taskTerminalService.finishExecution` 写收件箱」的异步执行模式（source=SCHEDULED 全链路贯通）；消息队列有 `scheduledTaskId` 绑定回写机制（消费侧收敛点 `streaming-ws-handler.ts` settleQueuedScheduledBinding）；权限目录（V121）补全 17 个管理端权限码（另含 V038 起的 session:read）；审计拦截器按前缀白名单覆盖管理资源与 /v1/scheduled-tasks 写操作（`audit.interceptor.ts` shouldAudit），**/v1/open 不在现状白名单内，须随本方案加入**。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **P1**：用户在设置页签发个人 API Token（scope 化、可吊销、90 天过期），以机器身份调用 `POST /v1/open/agents/:agentId/run` 异步触发 Agent。
2. **P2**：入站 Webhook 触发器——每个触发器一个带 HMAC 验签的 URL，外部系统 POST 即触发指定 Agent 跑一轮；结果终态带 WEBHOOK 来源写收件箱；连续失败自动停用。
3. **P3**：出站事件订阅——把任务完成通知泛化为可配置的通用 HTTP 订阅（HMAC 签名 + 重试），外部系统可被回调。

### 2.2 非目标（明确不做）

- 不做对外 SaaS 开放平台 / 第三方开发者生态；不做 OpenAPI 文档站。
- 不做同步对话式 API（同步流式已由 WS `/api/ws/stream` 覆盖；open 触发一律异步，立即返回）。
- 不动 embed SDK 与页面工具链。
- 不做 payload 模板引擎（P2 用 JSON 原文包装；模板化留待真实需求）。
- 不新增 permission 目录条目、不改 admin（全部是用户级功能）。token scope 是 openapi 域自有字典（首期仅 `open:run`），不进 permission 表——不复用 V121 管理码，原因见 §5.2 与决策 4/5。
- 不做限流框架（进程内固定窗口计数，见 §5.7）。

## 3. 范围界定

### 3.1 做什么

| 层 | 内容 |
|---|---|
| backend-ts | 新域 `src/openapi/`（api-token / webhook-trigger / open-run / outbound-subscription 四个 service + 路由）；V133 迁移（4 张表 + `message_queue` 两列）；`task-terminal.service.ts` 与 inbox 的 source 联合类型扩容（+WEBHOOK/API）；`jwt-hook.ts` 公开路径与 token 解析扩展；`audit.interceptor.ts` 白名单加 `/v1/open` |
| desktop | 设置页新增「开放接口」页（三块卡片：API Token / Webhook 触发器 / 出站订阅），router 加子路由 |
| 文档 | README 治理章节与 skills/mao-cli 补开放接口说明 |

### 3.2 不做什么（与"做"同等明确）

- 不重构 schedule 域（executeTask 的在飞守卫/档期推进逻辑 delicate，P1 不触碰；见 §10 决策 2）。
- 不做 token 级用量报表（usage 域按 user 维度自然聚合，够用）。
- 不做 IP 白名单（HMAC 验签已覆盖认证，自托管场景不叠加网络层策略）。
- 不做 Webhook 触发器的同步响应模式（始终 202 异步）。

## 4. 技术选型

零新增依赖。哈希/HMAC 用 `node:crypto`；secret 加密存储复用 `notification/task/webhook-secret-cipher.ts` 同款机制——密钥与钉钉/飞书通知渠道共用（`APP_NOTIFICATION_WEBHOOK_SECRET`，未配置时回落内置默认密钥，功能可用；生产注入随机密钥、轮换同步影响两者），DEPLOY 文档须写明此依赖；拉取/投递用全局 fetch + `AbortSignal.timeout`（对齐 `webhook-sender.ts` 的 10s 显式超时做法）。

## 5. 详细设计

### 5.1 V133 迁移（迁移号顺延，当前 V132；若资产分发方案先行实施则取其后继号）

```sql
CREATE TABLE IF NOT EXISTS `api_token` (
    `id`            BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`       BIGINT NOT NULL,
    `name`          VARCHAR(128) NOT NULL,
    `token_prefix`  VARCHAR(16)  NOT NULL COMMENT '明文前 12 位，列表展示用',
    `token_hash`    CHAR(64)     NOT NULL COMMENT 'sha256(明文)',
    `scopes`        VARCHAR(1024) NOT NULL DEFAULT '[]' COMMENT 'JSON 数组，openapi scope 字典（首期仅 open:run），不进 permission 目录',
    `expires_at`    DATETIME NULL,
    `revoked_at`    DATETIME NULL,
    `last_used_at`  DATETIME NULL,
    `created_at`    DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`    DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_api_token_hash` (`token_hash`),
    KEY `idx_api_token_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='开放 API 个人 Token';

CREATE TABLE IF NOT EXISTS `webhook_trigger` (
    `id`                    BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`               BIGINT NOT NULL,
    `agent_id`              BIGINT NOT NULL,
    `session_id`            BIGINT NULL COMMENT 'NULL=每次新建会话',
    `name`                  VARCHAR(128) NOT NULL,
    `path_token`            CHAR(32) NOT NULL COMMENT 'URL 路径随机段，防枚举',
    `secret_cipher`         TEXT NOT NULL COMMENT 'HMAC key，加密存储',
    `enabled`               TINYINT(1) NOT NULL DEFAULT 1 COMMENT '创建即启用（决策 9）',
    `consecutive_failures`  INT NOT NULL DEFAULT 0,
    `last_fired_at`         DATETIME NULL,
    `created_at`            DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_webhook_trigger_path` (`path_token`),
    KEY `idx_webhook_trigger_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='入站 Webhook 触发器';

ALTER TABLE `message_queue`
    ADD COLUMN `source_type`    VARCHAR(16) NULL DEFAULT NULL COMMENT 'SCHEDULED/WEBHOOK/API，NULL=普通入队',
    ADD COLUMN `open_trigger_id` BIGINT NULL DEFAULT NULL COMMENT 'WEBHOOK 来源时的触发器绑定（类比 scheduledTaskId 回写）';
```

P3 追加（可与上表同批或延后）：

```sql
CREATE TABLE IF NOT EXISTS `outbound_subscription` (
    `id`                   BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`              BIGINT NOT NULL,
    `event`                VARCHAR(32) NOT NULL COMMENT 'task.completed / task.failed / question.pending',
    `target_url`           VARCHAR(1024) NOT NULL,
    `secret_cipher`        TEXT NOT NULL,
    `enabled`              TINYINT(1) NOT NULL DEFAULT 1,
    `created_at`           DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_outbound_sub_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出站事件订阅';

CREATE TABLE IF NOT EXISTS `outbound_delivery` (
    `id`               BIGINT PRIMARY KEY AUTO_INCREMENT,
    `subscription_id`  BIGINT NOT NULL,
    `event`            VARCHAR(32) NOT NULL,
    `payload`          JSON NOT NULL,
    `status`           VARCHAR(16) NOT NULL COMMENT 'PENDING/SENDING/SUCCEEDED/FAILED',
    `attempt_count`    INT NOT NULL DEFAULT 0,
    `next_retry_at`    DATETIME NULL,
    `last_http_status` INT NULL,
    `last_error`       VARCHAR(512) NULL,
    `created_at`       DATETIME DEFAULT CURRENT_TIMESTAMP,
    `sent_at`          DATETIME NULL,
    KEY `idx_outbound_delivery_retry` (`status`, `next_retry_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='出站投递记录（重试调度扫描）';
```

### 5.2 鉴权模型：身份层 + scope 单层授权（P1）

**身份层**——`jwt-hook.ts` 扩展：`authenticateRequest` 按前缀分流，token 带 `mao_` 前缀时走 `ApiTokenService.resolveByToken(plain)`：sha256 后查 `uk_api_token_hash`，命中且未吊销/未过期 → 返回 userId 并把 scopes 挂到 `request.apiTokenScopes`；否则走既有 JWT 路径不变。两条约束：

- **API Token 仅认 `Authorization: Bearer` 头**：`resolveToken` 的 query fallback（`?token=`）只服务既有 JWT 场景，`mao_` 前缀 token 从 query 进入一律拒绝——token 不得进 URL/访问日志。
- **API Token 仅 `/v1/open/**` 路径生效**（实施期补充，2026-10-05 二次评审补录）：命中 token 但请求路径不在开放接口前缀下时，`authenticateRequest` 直接返回 null（401）且不查库。仅靠 `requireJwtIdentity` 挡不住其它域路由——它们只认 `request.userId`，泄露的 `mao_` token 可凭该用户身份调用全部 REST 接口，违背「token 能力 ≤ 触发执行」不变式。前缀常量 `OPEN_API_PATH_PREFIX` 由鉴权层单点强制，新增开放端点天然继承。
- `create-app.ts` preHandler 调用点（:504）同步传入 ApiTokenService（或解析回调）；仅 `mao_` 前缀 token 才触发查库降级，正常 JWT 零额外查询。

**授权层**——scope 单层校验，open 触发路由只走 `requireTokenScope(request, 'open:run')`。**不做角色权限层叠加**（修正原两层方案）：V121 的 `session:write` 是管理端「归档、删除会话」权限、仅系统管理员持有，复用会让普通用户 token 在角色层永远 403，P1 退化为管理员专属；且 webhook 触发路径不经过角色层，两层模型自相矛盾。替代不变式：**token 能力 ≤ 用户交互能力**——交互路径发消息（WS）本无权限码门槛，token 绑定用户本人，能做的只是「对自己的 Agent/会话触发一轮」，无提权面；配合吊销、限流、审计兜底。

**管理接口身份隔离**：token 签发/吊销/列表、触发器 CRUD、订阅 CRUD 仅限 JWT 会话身份——新增 `requireJwtIdentity(request)` 助手（`request.apiTokenScopes != null` 即 401），防止泄露的 token 自我续期/自我克隆。run 端点则天然 token-only（JWT 请求无 `apiTokenScopes`，过不了 `requireTokenScope`）。

**scope 字典**：openapi 域自有常量，首期仅 `open:run`（调 run 端点）；存 `api_token.scopes` JSON 数组，预留后续扩容。明文格式：`mao_` + 48 位随机 base62；落库只存 sha256；`token_prefix` 存前 12 位供列表识别。签发响应一次性返回明文。签发数量上限：每用户 20 个未吊销 token（对齐触发器 20 / 订阅 10 的上限口径）。

### 5.3 P1：REST 触发端点

```
POST /v1/open/agents/:agentId/run        scope: open:run
body: { message: string (1~32000 字), sessionId?: number }
响应 202: { sessionId: number, messageId: number | null, queued: boolean }   （与 P2 hook 统一为异步受理语义，见决策 1 修订）
```

执行流（`OpenRunService.runByApi`，与 `ScheduledTaskService.executeTask` 同构的精简版）：

1. 校验 Agent 存在且 enabled；`sessionId` 给定则校验归属（session.userId === token userId）且 sessionType 为主会话（排除 SUBAGENT/SIDE_TASK），且 executionMode ≠ LOCAL（开放触发仅支持 CLOUD：LOCAL 依赖桌面在线，机器触发场景失败只会累积触发器自动停用计数，见决策 13）；未给定则经 `sessionService` 新建会话（agent 绑定按现有创建路径，**显式传 `executionMode: 'CLOUD'`，不依赖 createSession 默认值**）。
2. `withSessionLock(sessionId)` 内（该函数现为 `scheduled-task.service.ts` 模块私有，须导出或提为共享 util——若 OpenRunService 自建新锁，与 schedule 域互不可见，check-then-act 竞态窗口只剩 busy 双检兜底；WS 路径维持自身锁 + `hasExecutionClaim`/isActivePhase 双检的现状口径不变，见决策 16）：busy（`isSessionBusy` 或 `isActivePhase`）→ `messageQueueService.enqueue(sessionId, userId, message, null)` 后回填该队列行的 `source_type='API'`（enqueue 签名扩展一个可选 source 参数，内部落两列），响应 `queued: true`；空闲 → `updatePhase('RUNNING')` → `saveMessage` → 走与 schedule 相同的双路径：注入的 liveExecution（对齐 WS 流式）或 `harnessService.executeFromEvent`（no-op handlers）+ 显式 `finishExecution(..., 'API')`。
3. 终态后回读会话 phase（FAILED/CANCELLED 不得标 COMPLETED，照抄 executeTask 的回读逻辑），API 触发无任务行，不做额外回写。

收件箱：`taskTerminalService.recordInbox` 的来源标注扩为 `'MANUAL' | 'SCHEDULED' | 'WEBHOOK' | 'API'`（§5.6），桌面 InboxDrawer 来源文案补齐。

### 5.4 P2：入站 Webhook 触发器

**路由**：`POST /v1/open/hooks/:pathToken`——`isPublicPath` 增加 `POST && /v1/open/hooks/` 前缀（跳过 JWT），处理器内自验签；验签通过后 `request.userId = trigger.userId`，让审计拦截器归因到属主——已核实审计在 `onResponse` 钩子读取 `request.userId`（create-app.ts:511），晚于处理器，回填直接生效，无需补写。审计生效前提：`AUDITED_PREFIXES` 增加 `/v1/open`（§3.1），验签失败请求（userId 为空）同样留痕，可作为探测信号。

**验签**（与 P3 出站签名同方案）：

```
X-Mao-Timestamp: Unix 秒
X-Mao-Signature: sha256=<hex(HMAC-SHA256(secret, `${timestamp}.${rawBody}`))>
校验：时间戳容差 ±300 秒；**容差窗口内重放会成功（无 nonce 存储），明确接受**——等价于重复触发一次，受 per-trigger 限流与执行侧预算约束（决策 14）；超窗拒绝。secret 取解密后的 trigger.secret_cipher
```

**raw body 捕获（硬前提）**：验签以请求原始字节为准——仓内无任何 raw body 基础设施（无 addContentTypeParser/preParsing，钉钉入站走 URL 参数签名无先例可抄），Fastify 默认 JSON 解析后对 `request.body` 重新 `JSON.stringify` 不保证还原发送方签名的字节（键序/空白/unicode 转义均可能不同）。实现须在 preParsing 钩子为 hooks 路由捕获原始字节挂到 `request.rawBody`，验签与 payload 包装均以它为准（决策 15）。

**触发流**：trigger 必须存在且 enabled；**不存在、停用、验签失败统一 404 + 固定短语**（不暴露区分；查无触发器时对随机 dummy secret 做一次等长 HMAC 比较，防时序侧信道——path_token 128bit 随机本身已使枚举不现实，此为纵深防御，见决策 10）→ 限流检查 → payload 处理：`JSON.stringify(body)` 超 8000 字符截断，包装为「收到外部 Webhook 事件（触发器：{name}）：\n{payload}」→ 复用 §5.3 第 1~2 步（source_type='WEBHOOK'、open_trigger_id=trigger.id 入队绑定）→ 响应 `202 { sessionId, queued }`。

**失败自动停用**：类比 scheduledTaskId 回写——队列消费侧在既有 `scheduledTaskId` 回写位置增加 `open_trigger_id` 分支：终态 COMPLETED → `consecutive_failures = 0`；FAILED → `+1`；CANCELLED（用户主动停止）不计不清零（决策 11）；达到 5 次 → `enabled = 0` 并经收件箱（QUESTION_PENDING 形态或新增 kind，实施时按 inbox 扩展成本定）通知属主。直接执行路径（未排队）由 OpenRunService 终态回读后做同样计数。消费侧 settle 时触发器可能已被删除或停用：照 `onScheduledTaskQueueConsumed` 对已删任务的容错写法，查无行静默跳过，不得抛错中断消费链。

**管理 API**（JWT 会话身份，`requireJwtIdentity` 守卫——API Token 不可调用，仅本人资源）：

```
GET    /v1/open/triggers                列表（secret 不回显，返回触发器 URL 全文）
POST   /v1/open/triggers                创建（agentId、sessionId?、name），返回明文 secret 一次
PUT    /v1/open/triggers/:id            改名/换绑 agent/启用停用（启用/停用即重置 consecutive_failures）
DELETE /v1/open/triggers/:id
POST   /v1/open/triggers/:id/rotate-secret   轮换 secret（返回新明文一次）
```

约束：每用户上限 20 个；创建即默认启用（决策 9——创建流程只展示一次 secret，默认停用会让忘启用的用户得到无提示的全 404，而未启用前 URL+secret 未外发、默认启用无暴露面）；未绑定会话的触发器限流降档（§5.7，控制「每次新建会话」的膨胀面）；secret 32 字节随机，加密落库；URL 形态 `{baseUrl}/api/v1/open/hooks/{pathToken}`。

### 5.5 P3：出站事件订阅

**事件与载荷**：`task.completed` / `task.failed` / `question.pending`。前两个挂 `taskTerminalService` 现有通知分发点（与飞书卡片通知同一入口，按订阅表分发而非仅渠道偏好）；`question.pending` 挂 ask_user 提问落点——注意 ask_user 派发点是工具层直调 `inbox.recordQuestionPending`（inbox.service.ts），无 taskTerminal 那样的单一收口，订阅分发需在工具层另接，与「停用通知形态」同列为实施时定夺项。载荷：

```json
{ "event": "task.completed", "sessionId": 1, "userId": 2, "executionId": "...",
  "phase": "COMPLETED", "title": "...", "failureReason": null, "sentAt": "..." }
```

**投递**：新 `GenericHttpWebhookSender` 实现 `WebhookSender` 同款接口形态（10s 超时、FetchLike 可注入测试）；HMAC 签名头同 §5.4 + `X-Mao-Event`；复用 `outbound_delivery` 表 + 周期扫描调度（对齐 `notification/task/delivery.scheduler.ts` 的重试模型）：指数退避 3 次（1min/5min/25min），终态 FAILED 落审计。目标 URL 校验复用 `WebhookUrlValidator` 的通用化版本（仅 https、禁 userinfo，放开域名白名单——白名单是钉钉/飞书渠道专属逻辑）；放开后 target_url 可指向内网 https 地址，SSRF 信任模型与取舍见 §8。

**管理 API**：`GET/POST/DELETE /v1/open/subscriptions`（本人资源，每用户上限 10 个）。

### 5.6 source 联合类型扩容（触点清单）

`'MANUAL' | 'SCHEDULED'` → 增加 `'WEBHOOK' | 'API'`：

- `session/task-terminal.service.ts`：4 处签名（types/构造器/finishExecution/recordInbox）。
- `inbox` 域：`recordTaskTerminal` 的 source 透传与展示文案（前端 InboxDrawer 条目来源标签补两档）。
- `message_queue.source_type`：`enqueue` 与 `enqueueHead` **两条入队路径均落列**（漏 `enqueueHead` 会让消费早退回补队首的消息丢失 source/open_trigger_id 绑定——参照 `streaming-ws-handler.ts` requeueIfClaimed 对 scheduledTaskId 的保留）；消费侧透传给 finishExecution（现按 scheduledTaskId 推断 SCHEDULED 的位置改为按列值）。
- `shared/contracts/src/inbox.ts` 的 `InboxSource` 联合类型（:15，前后端共用 contracts 包，不扩会两端编译报错）。
- `scheduled-task.service.ts` 的 `ScheduleTaskTerminalService` 接口（:124，同样声明 `'MANUAL' | 'SCHEDULED'`）与 `ScheduledLiveExecution` 类型（:75）。
- `streaming-ws-handler.ts` 内部窄接口（:88-89 的 enqueue/enqueueHead 签名）与 source 透传签名链：现状按 `scheduledTaskId != null` 推导布尔 scheduled（runExecution 的 `boundLiveScheduledTaskId`），改为按列值需动 `executePersistedUserPrompt → runExecution → finish*Session` 一整条链的参数传递。

### 5.7 限流（P1/P2 共用）

进程内固定窗口：`Map<key, {windowStart, count}>`，key = tokenId 或 triggerId；默认 60 次/分钟（token）、30 次/分钟（绑定会话的 trigger）、10 次/分钟（未绑定会话的 trigger——每次新建会话，收紧膨胀面），超限返回 429 + Retry-After。重启清零可接受（防滥用而非精确计量）；实现为 `src/openapi/rate-limiter.ts` 纯类可单测。

### 5.8 前端落点（desktop）

设置页新增 `OpenApiView.vue`（router `/settings/open-api`），三块卡片：

- **API Token**：签发表单（名称 + scope 勾选；scope 字典是 openapi 域自有常量——不存在 `/v1/permissions/catalog` 接口，也不可取 `/v1/permissions`（需 role:read，普通用户 403），首期仅 `open:run`）→ 明文一次性弹层 → 列表（prefix/名字/scopes/最后使用/过期/吊销按钮）。
- **Webhook 触发器**：列表 + 创建（选 Agent、可选绑定会话）→ URL + secret 一次性展示（带复制）→ 启停/轮换/删除；显示 consecutive_failures 与停用原因。
- **出站订阅**（P3）：事件多选 + URL + secret 一次性展示 + 最近投递状态。

## 6. 实施步骤

### P1：API Token + REST 触发

1. V133（api_token 表 + message_queue 两列）；`ApiTokenService`（签发/解析/吊销/限流）。
2. `jwt-hook.ts` 身份层扩展（`mao_` 仅 Bearer + ApiTokenService 注入调用点）+ `requireTokenScope` / `requireJwtIdentity` 助手；`audit.interceptor.ts` 白名单加 `/v1/open`。
3. `OpenRunService`（§5.3 双路径执行）+ 路由；source 联合类型扩容（§5.6）。
4. desktop OpenApiView 第一块卡片；mao-cli `auth token` 文档补节。

### P2：入站 Webhook 触发器

1. webhook_trigger 表（enabled 默认 1）；`WebhookTriggerService`（CRUD/验签/rotate）+ 公开路径 + preParsing rawBody 捕获 + HMAC 验签（统一 404 + dummy-secret 等时比较）。
2. 队列消费侧 `open_trigger_id` 回写 + 连续失败停用 + 通知。
3. desktop 第二块卡片；管理 API 审计验证。

### P3：出站事件订阅

1. outbound_subscription / outbound_delivery 表；订阅 CRUD。
2. taskTerminal / ask_user 分发点接入 + GenericHttpWebhookSender + 重试调度（ask_user 挂点实施时定夺，见 §5.5）。
3. desktop 第三块卡片。

## 7. 测试方案（全部 Vitest，不新增 Playwright）

- **Token**：sha256 落库无明文；过期/吊销即时失效（resolve 返回 null）；scope 不含 open:run 时 403；JWT 请求调 run 端点 403（无 apiTokenScopes）；`mao_` token 走 query 参数被拒（仅 Bearer）；携带 `mao_` token 调 token/触发器/订阅管理接口 401（requireJwtIdentity）；限流窗口计数与 429；每用户签发达上限（20）后拒绝。
- **OpenRun**：新会话（executionMode 显式 CLOUD）/ 指定会话归属校验 / SUBAGENT 拒绝 / LOCAL 会话拒绝；busy 入队（queued=true + source_type 落列）与空闲直跑双路径；enqueueHead 回补保留 source_type/open_trigger_id；终态回读 FAILED 不标 COMPLETED；收件箱来源 API。
- **Webhook**：验签正确；签名错/时间戳超容差/不存在/停用统一 404；容差窗口内重放成功（明确接受的预期行为，限流兜底）；payload 截断；连续失败 5 次自动停用 + 通知；COMPLETED 重置计数、FAILED +1、CANCELLED 不变；rotate 后旧 secret 失效；创建即 enabled；raw body 字节一致性（发送方 body 带空格/键序差异时按原始字节验签通过，固化决策 15）；消费 settle 时触发器已删除则静默跳过。
- **Outbound**：载荷与签名格式；重试退避序列与终态；订阅禁用不投递；URL 校验（https 强制、userinfo 拒绝）。
- **回归**：普通 JWT 登录链路不受 token 扩展影响；schedule 域既有测试全绿（source 扩容为加宽联合类型，SCHEDULED 行为不变）。

## 8. 风险与对策

- **token 泄露即预算泄露**（最高风险）：scope 最小化（仅 open:run）+ 90 天默认过期 + 吊销即时生效 + 限流 + 审计留痕（/v1/open 入白名单）+ 管理接口 JWT-only（防自我续期/克隆）+ 仅 Bearer 不进 URL + 每用户签发上限 20；签发明文只显示一次。
- **重放攻击**：HMAC + ±300s 时间窗；窗口内重放可成功（无 nonce），按可接受风险处理——等价于重复触发一次，受限流与执行预算约束，超窗拒绝（决策 14）；pathToken 随机 32 位防枚举；不存在/停用/验签失败统一 404 短语 + dummy-secret 等时比较（决策 10）。
- **触发风暴**：每用户触发器数量上限 + per-trigger 限流 + 连续失败自动停用 + 会话级预算沿用（执行侧本就有上限，触发侧只管准入）；未绑定会话的触发器限流降档至 10 次/分钟，控制「每次新建会话」的膨胀面。
- **出站订阅 SSRF**（二次评审补充）：放开域名白名单后 target_url 可指向内网 https 地址（云元数据、内部管理面）。信任模型：自托管单租户、仅已认证用户可配置，与「不做 IP 白名单」同一前提（§3.2），首期接受；如需收紧，投递前解析域名并拒绝私网/链路本地段。
- **secret 密钥依赖**（二次评审补充）：触发器/订阅 secret 加密与钉钉/飞书通知渠道共用 `APP_NOTIFICATION_WEBHOOK_SECRET`（未配置时回落内置默认密钥，功能可用；生产应注入随机密钥），密钥轮换同步影响通知渠道与触发器/订阅 secret；DEPLOY 文档须写明。
- **审计归因**：已核实审计在 onResponse 钩子读取 request.userId（create-app.ts:511），hook 处理器回填即生效，无需补写；`AUDITED_PREFIXES` 加 `/v1/open` 后触发/管理全量留痕（验签失败也留痕，userId 为空可作探测信号）。
- **schedule 域回归**：本方案只在队列消费侧加 `open_trigger_id` 分支与 source 列透传，不动 executeTask；Vitest 回归覆盖。

## 9. 落地清单

- [ ] V133 迁移（api_token / webhook_trigger（enabled 默认 1）/ message_queue 两列；P3 两表同批或延后）
- [ ] ApiTokenService + jwt-hook 身份层（mao_ 仅 Bearer）+ requireTokenScope / requireJwtIdentity + 限流器
- [ ] audit.interceptor 白名单加 /v1/open
- [ ] OpenRunService + `/v1/open/agents/:agentId/run`（LOCAL 会话拒绝）
- [ ] source 联合类型扩容（task-terminal / inbox / message_queue：enqueue + enqueueHead 双路径落列 + 消费侧；含 shared/contracts `InboxSource`、`ScheduleTaskTerminalService`、streaming-ws-handler 窄接口与透传链，见 §5.6）
- [ ] WebhookTriggerService + 公开路由 + rawBody 捕获 + HMAC 验签 + 失败停用回写
- [ ] OutboundSubscription + GenericHttpWebhookSender + 重试调度
- [ ] desktop OpenApiView（三块卡片分三期上）
- [ ] README / skills/mao-cli 文档同步（DEPLOY 补 APP_NOTIFICATION_WEBHOOK_SECRET 依赖说明）

## 10. 决策记录（相对提案的修正与确认）

1. **异步触发为唯一模式**：REST 触发与 Webhook 一律 202 异步返回（二次评审统一，原 run 端点为 200），不做同步对话 API——同步流式已由 WS 覆盖，重复提供会分裂流式链路。
2. **不重构 schedule 域**：OpenRunService 是 executeTask 的精简同构实现（无 cron 档期推进/在飞守卫/飞书微信回流），约 80 行可控重复；schedule 的在飞守卫与档期回滚逻辑 delicate，收敛抽象另立重构任务。
3. **队列来源绑定复用 scheduledTaskId 模式**：message_queue 增加 `source_type` + `open_trigger_id` 两列，消费侧回写与失败计数挂在既有 scheduledTaskId 回写位置，不引入新调度机制。
4. **Token 授权是 scope 单层**（修正提案的「对齐权限目录 + 角色权限生效」两层模型）：不变式为「token 能力 ≤ 用户交互能力」——交互路径发消息（WS）本无权限码门槛，token 只能对自己的 Agent/会话触发一轮，无提权面。原两层不可行：V121 的 `session:write` 是管理端「归档、删除会话」权限、仅系统管理员持有，复用会让普通用户 token 永远 403，P1 退化为管理员专属；且 webhook 触发路径不经过角色层，两层模型自相矛盾。
5. **scope 与 V121 目录解耦**：openapi 域自有 scope 字典，首期仅 `open:run`；不进 permission 表、不动管理后台（保留「不新增权限码」的初衷）。V121 目录实为 17 个管理端权限码，语义均与「触发执行」不匹配。
6. **验签/签名统一一套方案**（`sha256=<hex(HMAC-SHA256(secret, "timestamp.body"))>` + 时间戳容差），入站出站同构，外部系统接一次逻辑两用。
7. **出站投递新建 outbound_delivery 表**而非复用 task_notification_delivery：后者与钉钉/飞书渠道偏好强耦合（per-user 单 webhook），泛化通道独立建表避免污染既有重试语义；仅复用其调度器模式与 WebhookSender 接口形态。
8. **失败自动停用阈值 5 次**，启用/停用操作即重置计数；停用通知形态（收件箱新 kind vs QUESTION_PENDING 复用）在实施时按 inbox 扩展成本定。
9. **触发器创建即默认启用**（enabled DEFAULT 1）：创建流程只展示一次 secret，默认停用会让忘启用的用户得到无提示的全 404；未启用前 URL+secret 未外发，默认启用无暴露面。
10. **hook 失败响应统一 404**：不存在、停用、验签失败同响应；查无触发器时对 dummy secret 做等长 HMAC 比较防时序区分。path_token 128bit 随机，枚举不现实，此为纵深防御。
11. **CANCELLED 不计失败也不清零**：用户主动停止不属触发器质量问题，不参与 consecutive_failures。
12. **API Token 仅 Bearer 头 + 不可自管理**：token 不进 URL（`resolveToken` 的 query 通道对 `mao_` 前缀关闭）；token/触发器/订阅管理接口由 requireJwtIdentity 守卫，防泄露 token 自我续期/克隆。
13. **开放触发仅支持 CLOUD 会话**：绑定 LOCAL 会话直接参数错误拒绝——LOCAL 依赖桌面在线，机器触发场景失败只会累积自动停用计数。
14. **容差窗口内重放接受**：无 nonce 存储，窗口内同请求重放等价于重复触发一次，受限流与执行预算约束；不做 nonce 去重（多实例/重启下复杂度不值）。
15. **HMAC 以原始字节为准**（二次评审补充）：仓内无 raw body 基础设施（无 addContentTypeParser/preParsing），Fastify 默认 JSON 解析后重序列化不保证还原发送方字节；preParsing 钩子为 hooks 路由捕获 `request.rawBody`，验签与 payload 包装均以原始字节为准。
16. **会话锁共享**（二次评审补充）：`withSessionLock` 从 scheduled-task.service.ts 导出（或提为共享 util），OpenRunService 与 schedule 域同锁串行——第三执行入口若自建新锁，与 schedule 互不可见，check-then-act 窗口只剩 busy 双检兜底；WS 路径维持自身锁 + hasExecutionClaim/isActivePhase 双检的现状口径不变。

## 11. 验收口径

1. 设置页签发 token → `curl -H "Authorization: Bearer mao_..."` 触发 run，返回 sessionId 且会话执行、收件箱条目来源为 API；吊销后同请求 401。
2. 外部系统（如 curl 模拟 CI）按签名规范 POST hook URL → Agent 执行；篡改签名/未知路径/已停用统一 404；连续失败 5 次后触发器停用且属主收到通知（CANCELLED 不计入）。
3. 配置出站订阅后任务完成，目标 URL 收到带合法签名的回调；人为让目标 500 → 观察到 3 次退避重试后 FAILED。
4. token 能力不超过用户交互能力：USER 角色（无任何管理权限码）签发 token 后可完整走通触发流程；携带 `mao_` token 调 token/触发器/订阅管理接口 401；JWT 会话调 run 端点 403。
5. `cd backend-ts && npm test` 全绿，schedule 域回归无差异。
6. 绑定 LOCAL 执行模式会话的 run 请求被参数错误拒绝；未绑定会话的触发器限流档为 10 次/分钟。
