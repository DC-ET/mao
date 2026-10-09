# 开放接口调用中心技术方案：入站调用流水 + 统计 + 告警 + 重放

- 状态：技术方案，待实施（2026-10-09 与提案人逐决策点评审后定稿，共 11 项共识，见 §2；同日可行性评审补齐实施缺口，正文以「评审补」标出，不推翻 D1–D11）
- 日期：2026-10-09
- 提案来源：[docs/proposals/2026-10-09-open-api-call-center.md](../proposals/2026-10-09-open-api-call-center.md)
- 前置实现：[开放 API 三件套](../proposals/2026-10-05-open-api-webhook.md)（API Token / 入站 Webhook / 出站订阅，V133 已实施）
- 前置阅读：`openapi/open-run.service.ts`（统一触发执行流）、`session/ws/streaming-ws-handler.ts`（`queueSettlements` / `settleQueuedBinding` / 三个 finisher）、`inbox/inbox.service.ts`（`record()` 去重与偏好门控）、`usage/llm-call.routes.ts`（管理端流水路由范式）、`settings/settings.service.ts`（system_setting 读写）

## 1. 需求背景

开放接口三件套已上线，但入站侧是黑盒：外部系统什么时候调的、带了什么、成功失败、为什么被拒，只能翻服务端日志。本方案把入站调用（API Token 触发 + Webhook 触发）变成可查询、可统计、可告警、可重放的流水，管理后台与设置页都能回答"它被谁、在什么时候、以什么姿势、调用得怎么样"。

## 2. 决策记录（2026-10-09 评审共识）

| # | 决策点 | 共识 |
|---|---|---|
| D1 | 埋点范围 | 两个触发端点（`POST /v1/open/agents/:id/run`、`POST /v1/open/hooks/:pathToken`）**全路径**落流水，含 400/401/403/404/429/预算拒绝；**无效 Token（401）也记一行**（token_id 为空、记来源 IP 与前 12 位）；Token/触发器/订阅的 CRUD 端点不记（已有 HTTP 级 audit_log）；来源 IP 落库 |
| D2 | 终态回写 | 排队执行的终态经 WS 收敛点回调回写；崩溃残留停在 `pending`（直跑未回写）或 `queued`（已入队未 settle），**不猜**，统计中单列"结果未知"。不落 `accepted`（见 I4） |
| D3 | 脱敏策略 | 默认结构化摘要（只记结构与关键字段）；**P1 即实现 Token 级"完整请求体"开关**（默认关、变更写审计、UI 显眼警示） |
| D4 | Token 自动停用 | 默认开启、阈值默认 10 次/小时（管理端可配）；`rejected`+`failed` 计入、`completed` 清零、`cancelled` 不计、**429 限流不计入**；停用后调用 403 并通知，恢复需手动 |
| D5 | 失败通知 | 自动停用通知必达（无偏好开关，对齐 `TRIGGER_DISABLED`）；单次失败通知**默认关**，开启后按 Token+错误码 **10 分钟聚合一条** |
| D6 | 管理后台形态 | 新建**独立页**（llm-call 风格：流水表 + 统计面板 + CSV 导出 + 详情/重放） |
| D7 | 用户侧入口 | 设置页每个 Token/触发器卡片加"调用记录"按钮，弹 dialog 列流水（对齐现有"最近投递记录"dialog） |
| D8 | 配额关系 | 调用流水**只观测不限额**；限额继续走全局/用户/Agent 预算（API 调用本身已按 `scene=agent` 计入 `llm_call`） |
| D9 | 保留期 | 默认 **90 天**滚动清理，保留天数**管理端可配**（`system_setting`） |
| D10 | 请求重放 | P2 做"复制为 cURL" + 服务端"重发"（走正常入口、正常计用量与审计、产生新流水行）；幂等键列后续议题；Webhook 不提供服务端重发（不伪造签名） |
| D11 | 统计口径 | 实时 GROUP BY，默认近 30 天窗口；P95 对窗口内样本内存计算；异常高亮阈值写死；数据量大后再评估物化 |

实现层决策（方案自定，评审时已知会）：

- I1：耗时段名对齐 `llm_call` 用 `duration_ms`（弃用提案的 `latency_ms`），另加 `execution_ms` 记端到端。
- I2：`http_status` 记**逻辑 HTTP 状态**（错误码映射）。原因：`handleError` 把多数业务错误包在 HTTP 200 的 `Result` 信封里，直接记传输状态会让 400/404 拒绝在流水里显示成 200。
- I3：无效 Token 与 Webhook 404 的落行加**按 IP 抑制**（20 条/分钟），防止爆破/扫描放大成写库风暴（现状无效 Token 在 preHandler 即 401，完全绕过限流器）。
- I4：`outcome` 增加 `pending`（建行未定型）。直跑崩溃停在 `pending`，排队崩溃停在 `queued`，二者超时后计"结果未知"。不设 `accepted`：没有任何写入点会落这个值（`markAccepted` 直接落 `queued` 或终态）。
- I8（评审补）：D1「无效 Token 的 token_id 为空」只覆盖**查无此 token**。库里已有行但被拒绝（吊销 / 过期 / 自动停用）必须落 `token_id` + `user_id`；Webhook 验签失败或已停用但触发器已查到时同理落 `trigger_id` + `user_id` + `agent_id`。否则属主在卡片上看不到这些拒绝。
- I5："完整请求体"开关放在桌面端由 **Token 属主自助开启**（联调排障的第一责任人是你自己），管理后台在流水中查看 full 内容。
- I6：`message_queue` 新增 `open_call_log_id` 列承载排队回写绑定（类比现有 `open_trigger_id`）。
- I7：预算拒绝（`BUDGET_EXCEEDED`）逻辑状态映射 403；429 仅限流。

## 3. 提案与代码现状的出入（实施前修正）

1. 提案 §3.1"202 只记已受理+排队位，任务终态后回写 `session_id`"——**实际 accept 时 `session_id` 已已知**（会话在加锁前创建，`open-run.service.ts:119`），只需回写 `message_id`/终态。
2. 提案 §3.1 拒绝码列举"409 会话忙"——**实际 busy 不拒绝**，入队返回 202 `queued:true`（`open-run.service.ts:136-139`）。拒绝路径实为 400/401/403/404/429 + `BUDGET_EXCEEDED`。
3. 提案 §3.1"与 open-run.service.ts 的执行收敛点衔接"——**API 来源的排队行今天没有任何回写目标**（`queueSettlementOf` 只绑 `SCHEDULED→taskId`、`WEBHOOK→triggerId`，`streaming-ws-handler.ts:234-244` 注释明示"API 行无回写目标"），需按 §6.4 新增绑定。
4. 字段名 `latency_ms` 与现有 `llm_call.duration_ms` 分叉，统一为 `duration_ms`（I1）。
5. 既有缺陷备注（本方案不修）：`ErrorCode` 中 `3041` 被 `SHARE_NOT_FOUND` 与 `BUDGET_EXCEEDED` 重复占用；本方案新码取 `3043`。

## 4. 总体数据流

```
外部系统 ──POST /v1/open/agents/:id/run──► preHandler 鉴权（jwt-hook）
                                              │ 无效/吊销/过期/自动停用
                                              ▼
                                    [写入点 A] 落 rejected 行（401/403）
                                              │ 通过
open.routes.ts run handler ───────────────────┤
   └─[写入点 B] begin() 建行(outcome=pending) ─► scope/限流/参数校验 ─► openRun.run
                                              │ 拒绝 ──► markRejected（400/403/404/429/500）
                                              │ 202 受理
              ┌─ 直跑 ── markAccepted（终态 phase 回读，§6.4a）
              └─ 排队 ── enqueue(open_call_log_id) ─► message_queue
                                    │ 队列消费（autoConsumeQueue/插队）
                                    ▼
                    WS runExecution finally → settleQueuedBinding
                                    └─► onOpenApiCallQueueSettled(callLogId, phase, queueWaitMs)
                                          └─► [写入点 D] UPDATE 终态（§6.4b）

Webhook 路径：handleFire 内同构（[写入点 C]），404/429 拒绝也落行
```

## 5. 数据库设计（V142，当前最大版本 V141）

```sql
-- 开放接口入站调用流水（docs/plan/2026-10-09-open-api-call-center-technical-design.md §5）
CREATE TABLE IF NOT EXISTS `open_api_call_log` (
    `id`                   BIGINT PRIMARY KEY AUTO_INCREMENT,
    `token_id`             BIGINT NULL COMMENT 'API Token；查无此 token 时为 NULL',
    `trigger_id`           BIGINT NULL COMMENT '入站 Webhook 触发器',
    `agent_id`             BIGINT NULL COMMENT '路径参数解析失败时为 NULL',
    `user_id`              BIGINT NULL COMMENT 'Token/触发器属主；查无 token 或查无触发器时为 NULL',
    `session_id`           BIGINT NULL COMMENT '受理时即已知（会话先于执行创建）',
    `message_id`           BIGINT NULL COMMENT '直跑保存的用户消息；排队路径终态回写时补',
    `source`               VARCHAR(16) NOT NULL COMMENT 'API/WEBHOOK',
    `source_ip`            VARCHAR(45) NULL COMMENT '客户端 IP（兼容 IPv6）',
    `token_prefix`         VARCHAR(16) NULL COMMENT '无效/自动停用 token 的明文前 12 位',
    `request_summary_json` TEXT NULL COMMENT '脱敏摘要：结构与关键字段，不含全量内容',
    `request_full_json`    MEDIUMTEXT NULL COMMENT '完整请求体（仅该 Token 开启完整记录时落库，仍过黑名单；按字节截断）',
    `http_status`          SMALLINT NULL COMMENT '逻辑 HTTP 状态（错误码映射，见 §6.2）',
    `outcome`              VARCHAR(16) NOT NULL COMMENT 'pending/queued/rejected/completed/failed/cancelled',
    `replay_of_id`         BIGINT NULL COMMENT '管理端重放所依据的原流水 id；非空则不计入 Token 自动停用',
    `error_code`           VARCHAR(64) NULL,
    `error_summary`        VARCHAR(512) NULL COMMENT '截断的错误摘要',
    `duration_ms`          INT NULL COMMENT '受理耗时（建行→202 响应）',
    `queue_wait_ms`        INT NULL COMMENT '排队时长（入队→被队列消费）',
    `execution_ms`         INT NULL COMMENT '端到端耗时（受理→终态），统计 P95 口径',
    `created_at`           DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`           DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    `finished_at`          DATETIME NULL COMMENT '终态回写时刻；结果未知口径见 §6.4c',
    KEY `idx_oacl_created` (`created_at`),
    KEY `idx_oacl_token` (`token_id`, `created_at`),
    KEY `idx_oacl_trigger` (`trigger_id`, `created_at`),
    KEY `idx_oacl_user` (`user_id`, `created_at`),
    KEY `idx_oacl_agent` (`agent_id`, `created_at`),
    KEY `idx_oacl_outcome` (`outcome`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='开放接口入站调用流水';

-- Token 连续失败自动停用（滚动 1h 窗口）+ 完整请求记录开关（D3/D4）
ALTER TABLE `api_token`
    ADD COLUMN `auto_disabled_at`          DATETIME NULL COMMENT '自动停用时刻；非空即拒绝服务（403 TOKEN_AUTO_DISABLED）',
    ADD COLUMN `auto_disable_reason`       VARCHAR(128) NULL COMMENT '停用原因，供通知与详情展示',
    ADD COLUMN `failure_count`             INT NOT NULL DEFAULT 0 COMMENT '滚动 1h 窗口失败次数；completed 清零',
    ADD COLUMN `failure_window_started_at` DATETIME NULL COMMENT '失败窗口起点；超过 1h 重置',
    ADD COLUMN `log_full_body`             TINYINT(1) NOT NULL DEFAULT 0 COMMENT '1=记录完整请求体（默认关，变更走审计）';

-- 排队消息的调用流水绑定（I6，类比 open_trigger_id）：API/WEBHOOK 入队落列，消费终态回写
ALTER TABLE `message_queue`
    ADD COLUMN `open_call_log_id` BIGINT NULL DEFAULT NULL COMMENT 'API/WEBHOOK 入队时的调用流水绑定',
    ADD KEY `idx_mq_open_call_log` (`open_call_log_id`);

-- 收件箱偏好：单次失败聚合通知（D5，默认关）
ALTER TABLE `user_inbox_preference`
    ADD COLUMN `open_api_call_failed_enabled` TINYINT NOT NULL DEFAULT 0 COMMENT '开放调用失败聚合通知（默认关）';

-- 管理后台权限点（默认只授系统管理员 role_id=1，对齐 V121 模式）
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看开放调用', 'openapi:read', '查看开放接口入站调用流水与统计'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'openapi:read');
INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '重放开放调用', 'openapi:replay', '以原 Token 身份重放入站调用'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'openapi:replay');
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` IN ('openapi:read', 'openapi:replay');

-- 系统配置种子（category=开放接口；Days 后缀键由 settings.validateValue 强制正整数）
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('openapi.callLogRetentionDays', '90', '开放接口', '开放调用流水保留天数（滚动清理）', 1);
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('openapi.tokenAutoDisable.enabled', 'true', '开放接口', 'Token 连续失败自动停用总开关', 1);
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('openapi.tokenAutoDisableThreshold', '10', '开放接口', 'Token 连续失败自动停用阈值（次/小时）', 1);
```

索引说明：`created_at` 服务清理与默认时间窗查询；`(token_id, created_at)` / `(trigger_id, created_at)` 服务卡片弹窗按对象查最近流水；`(user_id, created_at)` 服务用户侧列表；`(outcome, created_at)` 服务统计与"结果未知"扫描。`message_queue.open_call_log_id` 单独建索引，供用户删队列项时回写取消、以及"结果未知"排除仍在排队的行。Token 调用频率远低于对话轮次（提案 §5 判断），不加覆盖索引。

## 6. 后端设计

### 6.1 模块与文件清单

新增：

| 文件 | 职责 |
|---|---|
| `openapi/open-api-call-log.service.ts` | 埋点（begin/markAccepted/markRejected/settleQueued/recordInvalid）、脱敏摘要、查询/统计、失败聚合通知器 |
| `openapi/open-api-call-log.repository.ts` | MySQL 增改查删 + 聚合 SQL（对齐 openapi.repository.ts 既有风格） |
| `openapi/open-api-call-log.routes.ts` | `GET /v1/open/calls`、`GET /v1/open/calls/:id`、`GET /v1/admin/openapi/calls`、`GET /v1/admin/openapi/calls/:id`、`GET /v1/admin/openapi/call-stats`、`POST /v1/admin/openapi/calls/:id/replay`（用户+管理端同文件，对齐 `llm-call.routes.ts`） |
| `openapi/open-api-call-log.cleanup.ts` | 每小时滚动清理（保留天数读 system_setting，对齐 `inbox.cleanup.ts` 的 setInterval 模式） |
| `openapi/open-api-call-log.spec.ts` 等 | 单测（§10） |

修改：`common/error-code.ts`（+3043）、`common/http-error.ts`（3043→403 映射）、`auth/jwt-hook.ts`（解析结果判别联合，唯一调用方 `create-app.ts:557`）、`openapi/api-token.service.ts`（`resolveByToken` 判别联合 + `onReject` 钩子 + 失败计数/自动停用 + full-body 置位）、`openapi/openapi.repository.ts`（api_token 新列）、`openapi/open-run.service.ts`（`OpenRunInput.callLogId` + enqueue 透传）、`openapi/webhook-trigger.service.ts`（handleFire 埋点 + callLogId 贯通）、`openapi/open.routes.ts`（run 埋点 + Token full-body/恢复端点）、`session/message-queue.service.ts` + `message-queue.repository.ts` + `session/types.ts`（enqueue 第 8 参 `openCallLogId`）、`session/ws/streaming-ws-handler.ts`（settlement 扩容）、`inbox/*`（两新 kind + 偏好）、`shared/contracts/src/inbox.ts`（kind + 偏好字段）、`settings/settings.service.ts`（3 个 typed getter）、`create-app.ts`（装配）。

### 6.2 埋点写入点与逻辑状态映射

三个写入点（§4 图）：A 鉴权层（401/403-自动停用）、B run 路由（403/400/429/openRun 全部拒绝 + 受理）、C Webhook handleFire（404/429 + 受理）。所有落行方法自身失败仅 `console.warn` 不穿出（对齐 `llm_call` 写入模式）。

逻辑状态映射（I2，`markRejected` 内实现）：

| 场景 | 逻辑 http_status | error_code |
|---|---|---|
| 202 受理 | 202 | NULL |
| 无效/吊销/过期 Token | 401 | `TOKEN_INVALID` / `TOKEN_REVOKED` / `TOKEN_EXPIRED`（reason 落入 error_code 区分） |
| 自动停用 Token（P3） | 403 | `TOKEN_AUTO_DISABLED` |
| 缺少 scope / 非 Token 身份 / 预算超限 | 403 | `FORBIDDEN` / `BUDGET_EXCEEDED` |
| 参数不合法 / Agent 停用 / 会话校验失败 | 400 | `PARAM_INVALID` |
| Agent / 会话不存在 | 404 | `AGENT_NOT_FOUND` / `SESSION_NOT_FOUND` |
| Webhook 不存在/停用/验签失败 | 404 | `OPEN_HOOK_NOT_FOUND` |
| 限流 | 429 | `RATE_LIMITED` |
| 未预期异常 | 500 | `INTERNAL_ERROR` |

**写入点 A（鉴权层）**：`apiTokenService.resolveByToken(plain, opts?)` 返回判别联合：

```ts
type TokenResolveResult =
  | { ok: true; userId: number; scopes: OpenApiScope[]; tokenId: number }
  | { ok: false; reason: 'not_found'; tokenPrefix: string }
  | { ok: false; reason: 'revoked' | 'expired' | 'auto_disabled'; tokenPrefix: string; tokenId: number; userId: number };
```

`opts.onReject` 由 create-app 注入，入参带上上述字段。仅当 URL（剥掉 `/api` 前缀与 query）命中 `POST /v1/open/agents/:id/run` 时落行（D1：CRUD 不记；hooks 是公开路径，不进这个解析器）。`not_found` 的 `token_id`/`user_id` 为 NULL；其余三种 reason 落 `token_id` + `user_id`（I8）。`token_prefix` 只存明文前 12 位（与现有 `TOKEN_PREFIX_LENGTH` 一致），禁止落完整明文。`jwt-hook.authenticateRequest` 返回值扩展为 `{ userId, tokenAutoDisabled }`；preHandler 对 `tokenAutoDisabled` 发 `403 fail(3043)`（P3 接线，P1 只接 401 三种 reason）。`auto_disabled` / `revoked` / `expired` 都在 `touchLastUsed` 之前返回。

**评审补：resolver 覆盖不到的 401。** 现有 `authenticateRequest` 在三种情况下直接 `return null`、不会调用 `resolveByToken`：未带 Bearer、Bearer 不是 `mao_` 前缀、query 里带 `mao_` token（query 通道故意不查库）。这三种打在 run URL 上时，preHandler 发 401 之前补一行 `recordInvalid`（`error_code=TOKEN_INVALID`，能切出前 12 位才记 `token_prefix`，否则为空），与 `onReject` 互斥，避免双写。Webhook 不走这条。

**写入点 B（run 路由）**：handler 顶部 `begin()` 建行（token 身份从 `apiTokenId`/`apiTokenScopes` 取，可空；请求体里的 `sessionId` 合法时同时写入 `session_id` 列，拒绝路径也能跳到会话）。随后 try/catch 包裹全部既有逻辑：早退（限流，`sendJson` 后 `return`，不抛错）与抛错都 `markRejected`，**然后原样返回或原样 rethrow**，客户端看到的状态码与信封保持今天的行为。`openRun.run` 返回后 `markAccepted(callId, result)` 再 202。`markAccepted` 按 `result.queued` 落 `queued`，否则按 `result.terminalPhase` 落 `completed/failed/cancelled` 并写 `finished_at`/`message_id`。`error_code` 存常量名（`BUDGET_EXCEEDED` 等），禁止用数字码反查：`3041` 同时是 `SHARE_NOT_FOUND`。

**耗时（评审补，正文原先没有写入点）**：`begin()` 记下 `t0`。`markRejected` / `markAccepted` 写 `duration_ms = now - t0`（建行到做出 HTTP 响应决定）。直跑同时写 `execution_ms = duration_ms`（直跑的 202 发生在执行结束之后，两者是同一段）。排队的 `execution_ms` 留空，等 §6.4b。

**写入点 C（Webhook）**：`handleFire` 各拒绝分支落 rejected 行，不先 `begin()`。查无 pathToken：`trigger_id`/`user_id`/`agent_id` 均为 NULL。验签失败或已停用但行已查到：三列都记（I8），对外仍是统一 404。限流记 `trigger_id`。通过则 `begin()` 后 `openRun.run({source:'WEBHOOK', triggerId, callLogId})`。`openRun` 抛错（含预算）时先 `markRejected` 再原样上抛；预算分支保留今天的 `recordOutcome(FAILED)`，与流水的 rejected 各记各的，不互相替代。直跑成功走 `markAccepted` + 既有 `handleDirectOutcome`（P3 起触发器计数仍由它承担），排队分支依赖 §6.4b。

**按 IP 抑制（I3）**：`recordInvalid` 与 hook 404（查无 pathToken）落行共用模块级 `FixedWindowRateLimiter`（key=`rejectlog:${ip}`，20 条/分钟，复用 `openapi/rate-limiter.ts`）；被抑制跳过落行不影响响应。已识别的吊销/过期/自动停用、以及已查到触发器的验签失败，不走这道抑制（量级由该 Token/触发器自己的限流器约束）。来源 IP 用 `request.ip`。生产必须配置 `TRUSTED_PROXY_ADDRESSES`（`loadTrustedProxyAddresses` 为空时 Fastify 不信任 `X-Forwarded-For`），否则反代后面所有调用挤在同一个代理 IP 上，这道抑制会把正常的 401/404 流水一起丢掉。

### 6.3 脱敏摘要与完整请求记录

`buildCallSummary(source, body)`：

- API：`{ "messageChars": 120, "sessionId": 42 }`（sessionId 非敏感直接记值；缺省为 null）
- WEBHOOK：`{ "messageChars": 96, "payloadKeys": ["event","data"] }`（只记键名）

**message 正文明文任何默认路径都不落库**。`request_full_json` 仅当 `api_token.log_full_body=1` 时写完整 body JSON：黑名单按键名递归走到每一层（数组元素同样递归），键名匹配 `/pass(word)?|secret|token|api[_-]?key|credential/i` 的值替换为 `"***"`，不限于顶层。截断按 UTF-8 **字节**计，上限 64KB；列用 `MEDIUMTEXT`，避免多字节内容顶满 `TEXT` 的 65535 字节上限后整行 INSERT 失败（落行失败只 `console.warn`，这一行调用会从流水里消失）。

开关（I5）：`PUT /v1/open/tokens/:id/log-full-body { enabled }`（`requireJwtIdentity`，防 token 自我续期同款隔离）。`/v1/open/**` 在 `AUDITED_PREFIXES` 里，开/关都会进 `audit_log`（这里的白名单是「要审计」，不是跳过审计）。桌面端 UI 二次确认 + 开启期间常驻橙色警示条。管理后台流水详情可查看 full 内容（列表端点不返回该列）。用户侧 `GET /v1/open/calls/:id` 同样只返回属主自己的行，别人的 id 回 404，避免靠枚举 id 读到 full 内容。

### 6.4 终态回写

**(a) 直跑路径**：无需新机制。`markAccepted` 直接用 `openRun.run` 回读的 `terminalPhase` 落终态（`open-run.service.ts:154-160` 已有回读）。

**(b) 排队路径**（I6 + settlement 扩容）：

1. `message_queue.open_call_log_id` 新列；`MessageQueueService.enqueue/enqueueHead` 增加第 8 参 `openCallLogId?`；`MessageQueue` 类型与 repo insert 映射同步。
2. `OpenRunInput` 增加 `callLogId?: number | null`；busy 分支 `enqueue(..., input.source, input.triggerId ?? null, input.callLogId ?? null)`。
3. `QueueSettlement` 增加 `callLogId: number | null` 与 `queueWaitMs: number | null`；`queueSettlementOf` 对 API/WEBHOOK 行取 `row.openCallLogId`；`settlementToEnqueueArgs` 回传 `openCallLogId`（回补队首保源）。
4. 两处登记点（`streaming-ws-handler.ts` 插队消费、autoConsume）`queueSettlements.set` 前附着 `queueWaitMs`（解析规则见下文评审补）。回补队首行以重排时刻为基准（近似值，注释说明）。
5. `settleQueuedBinding` 增加分发：`if (settlement.callLogId != null) await this.deps.onOpenApiCallQueueSettled?.(settlement.callLogId, phase, settlement.queueWaitMs, settlement.messageId)`。`messageId` 在 autoConsume / 插队的 `saveMessage` 成功后写进 settlement；补偿回补队首时清掉（消息已删）。回写 `message_id` 只为跳到那条用户消息，拿不到就留空，会话跳转只依赖受理时已写入的 `session_id`。
6. create-app 装配：wsHandler deps 内 `onOpenApiCallQueueSettled` 经 holder 晚绑定（对齐 `openTriggerSettle.current` 模式解循环依赖），落地为 `callLogService.settleQueued(...)`：

```sql
UPDATE open_api_call_log
SET outcome = ?, finished_at = NOW(),
    execution_ms = TIMESTAMPDIFF(MICROSECOND, created_at, NOW()) DIV 1000,
    queue_wait_ms = ?,
    message_id = COALESCE(?, message_id)
WHERE id = ? AND outcome IN ('pending', 'queued')
```

`execution_ms` 在库内用 `created_at` 计算，避免应用时钟与 DATETIME 字符串来回解析。影响 0 行静默，重复 settle 以及已是终态的行都不会被覆盖。`replay_of_id IS NULL` 时才调用 `recordTokenOutcome`（§6.5）。

**评审补：绑定被替换或被用户删掉时不能干等 2 小时。**

- `queueSettlements` 按 sessionId 只留一份。插队消费会 `set` 一份新绑定并打断正在跑的执行；旧执行的 finally 按对象身份对不上，不会再 settle。替换之前若 map 里已有另一份带 `callLogId` 的绑定，先对旧绑定 `settleQueued(CANCELLED)`。旧执行体随后到达的终态因身份不符被跳过，流水保持 `cancelled`（与用户点停止同一语义）。
- `handleDeleteQueueMessage` 删掉仍为 PENDING 的队列项时，若该行 `openCallLogId` 非空，同步 `settleQueued(CANCELLED)`。用户已经明确丢掉这条排队消息，不能让流水停在 `queued`。
- `queueWaitMs` 的 `createdAt` 是 `SELECT *` 映射出来的 DATETIME **字符串**，不是 `Date`。用会话域已有的时间解析（空格分隔的 `YYYY-MM-DD HH:mm:ss`），解析失败则 `queue_wait_ms` 留空，不得抛错阻断 settlement 登记。

**(c) 结果未知与进行中（评审补，原先未定义 inFlight）**：

- `inFlight`：`outcome IN ('pending','queued')` 且年龄不足 2 小时。
- `unknown`：同上且 `created_at < NOW() - INTERVAL 2 HOUR`，并且 `message_queue` 里已经没有 `open_call_log_id = 该行 AND status = 'PENDING' AND deleted = 0` 的队列项。仍在排队（含预算 BLOCK 回补后继续等）的行保持 `inFlight`，不因为等得久就被算成结果未知。
- 直跑没有队列行。直跑超过 2 小时仍未 `markAccepted` 的，统计里先显示 unknown，请求真正结束并回写后自动离开这个桶。这是展示口径，不据此改业务状态（D2）。

### 6.5 Token 连续失败自动停用（P3）

`api-token.service.ts` 新增 `recordTokenOutcome(tokenId, outcome)`，由 call-log service 的统一落终态/拒绝出口触发（`source='API' && token_id != null && replay_of_id IS NULL`；429、已自动停用的 403、以及写入点 A 的 `recordInvalid` 都不触发，D4）：

- `completed` → 单条 `UPDATE api_token SET failure_count=0, failure_window_started_at=NULL WHERE id=?`
- `failed` / `rejected` → 单条条件更新，禁止先读再写：窗口空或 `failure_window_started_at < NOW() - INTERVAL 1 HOUR` 时 `failure_count=1, window=NOW()`，否则 `failure_count=failure_count+1`；`WHERE auto_disabled_at IS NULL AND revoked_at IS NULL`。然后读回计数，`count >= threshold` 时 CAS 停用（`UPDATE ... SET auto_disabled_at=NOW(), auto_disable_reason=? WHERE id=? AND auto_disabled_at IS NULL AND revoked_at IS NULL`），影响 1 行则发 `TOKEN_DISABLED` 通知
- `cancelled` → 不动
- 总开关（`openapi.tokenAutoDisable.enabled=false`）→ 完全不计数

阈值/开关每次读取（`settings.getBool/getPositiveInt`，默认 10），失败事件低频，可接受每次一读。恢复：`POST /v1/open/tokens/:id/re-enable`（`requireJwtIdentity`，仅属主）清空停用三列 + 计数。管理端本方案不提供代为恢复。Webhook 触发器侧机制不变（本方案只把"自动停用"从 Webhook 扩展到 Token）。

### 6.6 收件箱通知（P3）

新 kind 两个（`shared/contracts/src/inbox.ts` + `inbox/types.ts` INBOX_KINDS + `inbox.service.ts`）：

- `TOKEN_DISABLED`：无偏好开关、始终通知（对齐 `TRIGGER_DISABLED`，运维级事件）；`recordTokenDisabled(userId, tokenId, tokenName, failures, threshold)`，tail=`${tokenId}:${Date.now()}`。
- `OPEN_API_CALL_FAILED`：偏好门控（`openApiCallFailedEnabled`，默认关）；**聚合**：call-log service 内 `Map<`${tokenId}:${errorCode}`, {bucket, count, lastSummary, userId, tokenName}>`，bucket=`floor(now/600000)`（10 分钟）；60s `setInterval` flush 已完成 bucket（start/stop 对齐 inbox.cleanup），写 `inbox.recordOpenApiCallFailed(...)`，tail=`${tokenId}:${errorCode}:${bucket}` 走既有 `insertIgnore` 去重——同 bucket 同 Token 同错误码恰一条（D5）。**偏好在 flush 时读取**，关闭后丢弃尚未写出的 bucket，而不是在计数时就丢弃。flush 成功后从 Map 删除。进程重启至多丢一个未 flush bucket（通知不承诺精确，写入说明）。`isKindEnabled` 的 `default` 今天对未知 kind 返回 false，两个新 kind 必须加进 switch，漏了等于永不通知。

偏好链路扩展（对齐 `budgetWarnEnabled` 的 V139 先例）：迁移加列（DEFAULT 0）+ contracts `InboxPreference` 加 `openApiCallFailedEnabled` + `inbox.repository.ts` 的 `findPreference`/`savePreference` + `inbox.service.ts` 的 `DEFAULT_PREFERENCE`/`isKindEnabled` + desktop inbox store 默认值 + `NotificationSettingsView.vue` 开关。

### 6.7 查询与统计 API

- `GET /v1/open/calls`（JWT，`WHERE user_id = me`）：筛选 tokenId/triggerId/agentId/outcome/source/httpStatus/startDate/endDate + page/size（默认 20，上限 100），排序 `created_at DESC, id DESC`。无效 token 与查无触发器的行 `user_id` 为 NULL，仅管理端可见。
- `GET /v1/open/calls/:id`：详情，`WHERE id=? AND user_id=me`，不存在或非属主一律 404。含 `request_full_json`（列表端点不返回该列）。
- `GET /v1/admin/openapi/calls/:id`：详情，含 `request_full_json`。
- `GET /v1/admin/openapi/calls`（`openapi:read`）：全量 + userId 筛选，其余同上。
- `GET /v1/admin/openapi/call-stats`（`openapi:read`）：参数 `granularity=day|token`（默认 day）、startDate/endDate（**默认近 30 天**，D11）、tokenId/agentId 可选。日切与「今日」用连接时区的 `DATE(created_at)` / `CURDATE()`，与现有预算「服务器本地时区」同一口径，本方案不另加时区配置；应用与 MySQL 须处于同一时区。
  - 计数：SQL `GROUP BY`（day → `DATE(created_at)`；token → `token_id`），出 total/completed/failed/cancelled/rejected/inFlight/unknown。`inFlight` / `unknown` 口径见 §6.4c，二者互斥。
  - P95（D11）：窗口内 `SELECT execution_ms, queue_wait_ms ... WHERE outcome IN ('completed','failed') ORDER BY id DESC LIMIT 50000`，内存排序取分位。超限时样本是**最新的 5 万行**（无 ORDER BY 的 LIMIT 会抽到任意行），响应 `p95Truncated: true`。
  - 异常高亮（阈值写死）：`successRateLow`（bucket total≥10 且 completed/(completed+failed) < 0.5，分母为 0 时不标记）；`rejectRateHigh`（bucket total≥10 且 rejected/total ≥ 0.5，专门覆盖「调用都在门口被拒绝、执行成功率无样本」）；`trafficSpike`（token 粒度，且只在查询窗包含 `CURDATE()` 时计算：今日 total ≥ max(10, 5×前 7 天日均））。
- CSV 导出：**前端**分页拉取拼装（对齐 `LlmCallView.vue`：`EXPORT_MAX_ROWS=10000`、`EXPORT_PAGE_SIZE=500`、BOM+CRLF），无后端导出端点（D6 对齐既有口径）。列表接口本来就不返回 `request_full_json`，导出不会带出完整请求体。

### 6.8 请求重放（P2）

`POST /v1/admin/openapi/calls/:id/replay`（`openapi:replay`）：body `{ message?: string }`。校验：行存在、`source='API'`、token 未吊销/过期/自动停用、agent 存在且启用。原 `session_id` 非空时先确认会话仍在且仍属于该用户；会话已删除则 404，不静默新建。`session_id` 为空（当初在进 openRun 之前就被拒绝）才新建会话。

重放**直接调用** `openRun.run`，不经过 run 路由，因此路由层的 `begin()` 不会自动发生。端点自己 `begin()`（`replay_of_id` = 原行 id，`token_id`/`user_id`/`agent_id` 取原行，full 是否落库看该 Token **当前**的 `log_full_body`），再 `markAccepted` / `markRejected`。用量与预算记在原 Token 属主头上，不记在操作的管理员头上；审计拦截器记的是管理员的这次 POST。`replay_of_id` 非空的行不调用 `recordTokenOutcome`，避免管理员排障把用户的 Token 打进自动停用。

`message` 缺省时取 `request_full_json` 的 message；都没有则 400 提示手工粘贴。Webhook 调用不提供重发（D10：不伪造签名）。

**脱敏与重放的张力（D3×D10 的已知代价）**：未开 full 的 Token，"重发"需手工粘贴 message、"复制 cURL"生成占位模板；联调排障的实际路径是临时对目标 Token 开 full（I5 属主自助 + 审计）。此张力写入 CHANGELOG 说明。允许改 `message` 意味着 `openapi:replay` 是「以该用户身份在该会话里再跑一条」的权限，不只是字节级重放；默认只授 role_id=1。

### 6.9 保留期清理

`open-api-call-log.cleanup.ts`：`setInterval` 1h（对齐 `inbox.cleanup.ts`，无 cron 库）；每轮读 `openapi.callLogRetentionDays`（默认 90，D9 管理端可配，`Days` 后缀自动正整数校验）；按批 `DELETE FROM open_api_call_log WHERE created_at < ? ORDER BY id LIMIT 5000`，单轮最多 20 批，避免一次删除锁住大表。create-app start/stop 装配。

### 6.10 配置项（system_setting，category=开放接口）

| key | 默认 | 消费方 |
|---|---|---|
| `openapi.callLogRetentionDays` | 90 | cleanup 每轮读。键名以 `Days` 结尾，现有 `validateValue` 会强制正整数 |
| `openapi.tokenAutoDisable.enabled` | `true` | 失败计数入口。键名必须以小写 `enabled` 结尾：管理端 `isBooleanSetting` 与后端 `endsWith('enabled')` 都是大小写敏感的，写成 `...Enabled` 既不会渲染成开关，也不会校验 true/false。种子值必须是 `true` 不能是 `1`：开关按 `=== 'true'` 显示，`getBool` 虽同时认 `1`，但页面上会显示成关 |
| `openapi.tokenAutoDisableThreshold` | 10 | 失败计数入口。这个键不匹配现有正整数后缀，`validateValue` 要单独加一条；admin `NUMERIC_KEYS` 同时补上本键和 `openapi.callLogRetentionDays` |

`settings.service.ts` 加三个 typed getter（`getPositiveInt(raw) ?? DEFAULT` 模式，现有 `getBool` 是 private，需要新的公开读取方法）。admin `SystemSettingsView.vue` 按 category 自动渲染。

## 7. 前端设计

### 7.1 desktop（设置页「开放接口」OpenApiView.vue）

- Token/触发器 item-card 增加"调用记录"图标按钮 → dialog 完全对齐现有"最近投递记录"（`OpenApiView.vue` 投递记录 dialog）：列 = 时间、outcome 徽标（三色，复用 badge 样式类）、http_status、耗时（用 `desktop/src/utils/llmCallLabels.ts` 的 `formatMs`；不要复用 `RunTracePanel` 里秒进位会变成 `1m 60s` 的那份）、错误摘要截断、"查看会话"跳转；分页简单"加载更多"或前 50 条 + 提示（弹窗不做复杂分页）。
- Token 卡片增加"完整记录"switch：开启二次确认（警示文案：将记录该 Token 调用的完整请求体，含可能的敏感信息，操作留审计）；开启期间卡片常驻橙色警示条。
- P3：自动停用徽标 + "重新启用"按钮（对齐吊销的二次点击确认模式 `:422-438`）。
- `desktop/src/api/index.ts` 开放接口区新增：`listOpenApiCalls`、`getOpenApiCall`、`setTokenLogFullBody`、`reEnableToken`（类型本地声明，跟随现有风格）。

### 7.2 admin（新独立页，D6）

`admin/src/views/openapi/OpenApiCallView.vue`（router 加 `openapi-calls` 路由 + SideMenu 入口，meta 权限 `openapi:read`，对齐 llm-calls 页写法）：

- 筛选 `FilterPanel`：userId/tokenId/triggerId/agentId/outcome/source/httpStatus/startDate/endDate。
- 表格：时间、source、Token/触发器、Agent、用户、来源 IP、http_status、outcome 徽标、耗时、错误摘要、会话跳转；`ResponsivePagination`；URL query 同步 + keepAlive `onActivated` 重拉 + `fetchSeq` 竞态防护（对齐 LlmCallView 范式）。
- 统计区（页顶）：汇总卡（总调用/成功率/P95 端到端/P95 排队）+ 按天表 + 异常徽标（successRateLow / rejectRateHigh / trafficSpike 高亮行）。
- 详情 `ResponsiveDialog`：脱敏摘要 JSON、full JSON（若有）、错误信息、`复制为 cURL`（full → 完整命令，token 明文不可恢复用 `mao_<prefix>...` 占位；无 full → message 占位模板）、`重发`（仅 `openapi:replay` 可见；message textarea 预填 full 或空，确认后调 replay，toast 提示新流水）。页面本身的门槛是 `openapi:read`，两个权限分开，只读角色看不到重发按钮。
- CSV 导出按钮：口径 §6.7。
- 移动端 `useBreakpoint` 卡片降级。

### 7.3 通知设置

`NotificationSettingsView.vue` 增加"开放调用失败通知"switch（默认关，参照 `budgetWarnEnabled` 写法）；inbox store 默认值同步。

## 8. 权限与错误码

- 新权限 `openapi:read` / `openapi:replay`（V142 种子，默认授 role_id=1；菜单对无权限角色隐藏，对齐 V121 借码教训）。
- 新错误码 `TOKEN_AUTO_DISABLED: { code: 3043, message: 'Token 已因连续失败被自动停用，请手动重新启用' }`；`handleError` 增加 3043→403 映射（现有逻辑只映射 1001/1002/401/403，其余业务码走 200 信封）。

## 9. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | V142 迁移（流水表 + api_token/message_queue/preference 列 + 权限 + 配置种子）；三个埋点写入点 + 逻辑状态映射 + per-IP 抑制；脱敏摘要 + full-body 开关与端点；直跑/排队终态回写（settlement 扩容）；用户侧列表/详情 API + desktop 调用记录弹窗；清理调度；settings getter | 中 |
| P2 | admin 独立页（流水 + 统计 + 导出 + 详情）；重放端点与 UI；复制 cURL | 中 |
| P3 | Token 失败计数 + 自动停用 + 403 判别（error-code/http-error/jwt-hook）+ 恢复端点；TOKEN_DISABLED 与 OPEN_API_CALL_FAILED 通知 + 聚合器 + 偏好开关 + 通知设置 UI | 小 |

P1 与 P2/P3 可独立发版；P1 上线后即使暂无管理页，用户侧弹窗 + 数据库已闭环。

## 10. 测试要点

1. **埋点完整性**：run/hook 的 202/400/401/403/404/429/BUDGET_EXCEEDED/未知异常均落行且字段正确（逻辑状态映射逐条断言）；无效 token 401 落行 `token_id=NULL` + prefix + IP；per-IP 抑制（同 IP 第 21 条/分钟不落行）；CRUD 端点不落行。
2. **脱敏**：summary 不含 message 明文；full 关时 `request_full_json` 恒 NULL；full 开后落库，嵌套键也打码，按 UTF-8 字节截断到 64KB；开关端点 403（token 身份）/审计留痕。
3. **回写**：直跑 completed/failed/cancelled 三态正确，且直跑同时写 `duration_ms` 与 `execution_ms`；排队消费后 outcome/queue_wait_ms/execution_ms/finished_at/message_id 正确；重复 settle 幂等（WHERE 影响 0 行）；插队消费与回补队首两条路径覆盖；插队替换绑定前旧 callLog 被标 cancelled，且旧执行体迟到的终态不能覆盖它；用户删除 PENDING 队列项后流水为 cancelled；仍在排队且超过 2h 的行计 inFlight 不计 unknown；绑定已丢失且超过 2h 的 pending/queued 计 unknown。`created_at` 用 DATETIME 字符串解析失败时 queue_wait_ms 为空、settlement 仍登记。
4. **停用（P3）**：阈值达成立即停用 + 通知；completed 清零；429 不计、cancelled 不计、已停用后的 403 不再计数、写入点 A 的 recordInvalid 不计、`replay_of_id` 非空不计；并发失败用单条 UPDATE 累加，CAS 保证只停用一次、只通知一次；总开关关闭不计数；手动恢复后可用。非属主调用 re-enable 被拒绝。
5. **通知（P3）**：TOKEN_DISABLED 无开关必达；OPEN_API_CALL_FAILED 默认不投；开启后同 bucket 恰一条、跨 bucket 多条、count 正确；偏好在 flush 前关闭则该 bucket 丢弃；kind 未注册进 `isKindEnabled` 的回归（漏注册必须失败而不是静默不通知——用已注册的断言锁住）。
6. **查询**：用户只见 `user_id=me` 的行，详情 id 不属于自己时 404；管理员全量 + userId 筛选；筛选/分页/排序正确；full 列仅详情端点返回。未带凭证打 run URL 落一行且与 onReject 不双写；吊销/过期行带 token_id；查无 token 的 token_id 为 NULL。
7. **统计**：与明细同窗 SUM 对账一致；P95 与样本分位一致；三种异常高亮标记正确（含「全是 rejected、completed+failed=0」只出 rejectRateHigh）；`p95Truncated` 时样本是最新 5 万行；默认 30 天窗口；查询窗不含今天时不出 trafficSpike。
8. **导出**：CSV 行数与筛选结果一致（BOM/CRLF/转义单测），且不含 `request_full_json`。
9. **重放**：replay 自己建行（`replay_of_id` 指向原行）且正常执行；token 吊销/自动停用拒绝；无 full 且缺 message 时 400；原会话还在则复用，原会话已删除则 404 不新建；重放失败不增加 `failure_count`；排队重放最终 settle 时同样不计入自动停用。
10. **清理**：保留天数改为 1 天验证删除边界；单批 5000 行、单轮批次数有上限；不影响其他表。
11. **配置**：`openapi.tokenAutoDisable.enabled=1` 在管理端显示为关、保存 `true` 后为开；阈值 `0` / 非整数被 `validateValue` 拒绝。

## 11. 风险与缓解

- **写入放大**：每次入站调用 1 次 INSERT + 1~2 次 UPDATE。Token 调用频率远低于对话轮次，量级可控；无效 token/扫描流量由 per-IP 抑制挡在库外（I3）。抑制依赖 `request.ip`，未配置 `TRUSTED_PROXY_ADDRESSES` 时会误伤。
- **脱敏 vs 排障/重放**：默认摘要在联调深度排障时不够用——缓解即 D3 的 full 开关（属主自助、审计、警示）+ D10 的可编辑重发；此张力是共识代价，写进 CHANGELOG。
- **full 的隐私口子**：默认关、仅属主可开、开关与查看全走审计、UI 常驻警示；full 仍过递归黑名单，用户详情接口按属主隔离。
- **pending / queued 残留**：崩溃或进程内绑定丢失时不猜终态（D2）。仍在 `message_queue` 里 PENDING 的行不算结果未知。插队打断与用户删队列项显式写成 `cancelled`。直跑超过 2 小时才会暂时显示为 unknown，回写后离开该桶。
- **聚合通知丢精度**：进程重启至多丢一个 10 分钟 bucket；通知非承诺精确（写入接口说明）。
- **统计性能**：30 天实时 GROUP BY + 最新样本 5 万封顶；量级增长后按 D11 约定 reevaluate 物化。
- **重放的副作用**：用量与预算算在 Token 属主头上；`message` 可被管理员改写。用 `openapi:replay` 与 `replay_of_id` 把权限和自动停用隔开。
- **`BUDGET_EXCEEDED` 与 `SHARE_NOT_FOUND` 错误码 3041 撞号**（既有缺陷）：本方案不修，新码取 3043；流水 `error_code` 只存常量名。建议后续单独修复。

## 12. 文档同步

- `CHANGELOG.md`：P1/P2/P3 各自发版节点按小节写入（后端 / 前端（桌面 / Web / 安卓）/ admin）。
- `skills/mao-cli/SKILL.md`：开放接口章节补调用流水查询、统计面板、完整记录开关、自动停用与重放说明。
- README/DEPLOY：无部署变化，不涉及。
