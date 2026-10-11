# 信号哨兵（Signal Watcher）技术方案

> 状态：已确认（待实施）
> 日期：2026-10-11
> 上游提案：[docs/proposals/2026-10-11-signal-watcher.md](../proposals/2026-10-11-signal-watcher.md)
> 覆盖端：后端 backend-ts、桌面端 desktop、管理后台 admin

---

## 1. 需求背景

Agent 今天的启动方式有五种：人手动发消息、定时任务（cron）、开放 API 被外部调用、入站 Webhook 被外部推送、渠道入站。前三个是「时间到了」或「有人叫」，后两个是「外部系统 / 人主动推了一把」。**缺的是第六种：条件满足了。**

大量外部系统（GitHub、Jira、监控平台、自建系统）只提供 HTTP 拉取面、不支持推送，今天只能靠 cron 每分钟硬扫，让 Agent 每轮都跑一遍自己判断「有没有变化」——绝大多数轮次白烧 token，真正的变化还要等下一个 tick。

本方案落地「信号哨兵」：用户定义一个 HTTP 探针 + 一个变化判定，后端按间隔轮询，**只在判定值变化时**经 `OpenRunService` 同款投递链路发起一次 Agent 运行；无变化不调 LLM；连续失败指数退避，达阈值自动 DISABLED 并发收件箱通知。

### 1.1 现状代码事实（实施前已核对）

| 事项 | 现状 | 本方案的用法 |
|---|---|---|
| `OpenRunService.run(input)` | `openapi/open-run.service.ts:77`，参数 `userId/agentId/message/sessionId/source/triggerId/callLogId`；内部已做 Agent 存在与启用校验、预算 BLOCK 前置检查、会话归属/主会话/CLOUD 校验、`withSessionLock`、busy 时 `messageQueueService.enqueue` 排队、直跑路径 `liveExecution` + 回读真实终态 | 哨兵触发直接复用，只传 `userId/agentId/message/source='SIGNAL'`；不传 `sessionId`（每次新建）、不传 `triggerId/callLogId`（无对应绑定表） |
| `TaskNotifySource` | `session/task-terminal.service.ts:19` = `'MANUAL' \| 'SCHEDULED' \| 'WEBHOOK' \| 'API'` | 新增 `'SIGNAL'`；`OpenRunInput.source` 放宽为 `Extract<TaskNotifySource, 'API' \| 'WEBHOOK' \| 'SIGNAL'>` |
| `MessageQueueSource` | `session/types.ts:81` = `'SCHEDULED' \| 'WEBHOOK' \| 'API'` | 新增 `'SIGNAL'`；busy 入队时落 `message_queue.source_type='SIGNAL'` |
| `QueuedSource` / `queueSettlementOf` | `session/ws/streaming-ws-handler.ts:240-253`，白名单三值 + `scheduledTaskId` 回退 | 白名单加 `'SIGNAL'`；settlement 的 `taskId`/`triggerId` 均为 null（哨兵无排队回写绑定，见 §5.6） |
| `createScheduledLiveExecution(wsHandler)` | `session/ws/streaming-ws-handler.ts:273`，第 7 参 source 类型 `'SCHEDULED'\|'WEBHOOK'\|'API'\|null` | 加 `'SIGNAL'`；装配见 `create-app.ts:1441-1456` |
| 调度器范式 | `OutboundDeliveryScheduler`（`openapi/outbound-delivery.scheduler.ts`，154 行）：setTimeout 链 + `dispatching` 防重入 + `stopped` 标志 + `execute` 注入 + `intervalMs` 可注入 + 批量 BATCH_SIZE=50 + CAS claim | `WatcherScheduler` 照此结构实现，单飞改用进程内 Map 标记（哨兵无 claim 列，见 §5.3） |
| 探针执行器现状 | `harness/tool/impl/fetch-bytes.ts:16` GET-only 且非 2xx 抛错；`openapi/generic-webhook-sender.ts` POST-only + JSON body | 两者均不覆盖「任意方法 + 请求头 + 任意状态码可接受」，新建 `signal/probe-client.ts`（§5.2） |
| SSRF 防护现成实现 | `weixin/qr-login.service.ts:162-203`：`validateCallbackBaseUrl()` + `isPrivateOrReservedHostname(hostname)`，覆盖 localhost/.localhost、RFC1918、127、169.254、0.x/255.x、组播、IPv6 字面量、.local/.internal；**强制 https-only** | 抽 `isPrivateOrReservedHostname` 到公共模块复用；协议校验独立写成 http/https 均可（§5.4） |
| 加密范式 | `ApiTokenCipher`（`openapi/api-token-cipher.ts`，密钥 `cfg.app.openapi.tokenSecretKey` ← `APP_OPENAPI_TOKEN_SECRET`）；底层 `crypto/aes-gcm.ts` 的 `encryptAesGcmNonNull`/`decryptAesGcm`，落库 `nonceB64:cipherB64` | 同款新建 `SignalSecretCipher`，独立密钥 `APP_SIGNAL_SECRET`（决策 4） |
| 连续失败自动停用范式 | `openapi/webhook-trigger.service.ts`：`TRIGGER_DISABLE_AFTER_FAILURES = 5`、`recordOutcome(triggerId, phase, threshold, now)` DB 侧 CAS、停用通知 `TriggerDisableNotifier.notifyTriggerDisabled`（装配层适配 `inboxService.recordTriggerDisabled`，`create-app.ts:1466-1470`）、直跑/排队双路回写 | 哨兵照此实现：阈值 5（决策 8）+ `WATCHER_DISABLED` 通知；但**只有直跑路径**（无排队回写绑定，见 §5.6） |
| 收件箱 kind 体系 | `inbox/types.ts:8` 的 `INBOX_KINDS`（当前 11 种）+ `isInboxKind` 守卫；契约侧 `shared/contracts/src/inbox.ts:7` 的 `InboxKind` 联合；桌面 `stores/inbox/index.ts:23` 白名单、`components/inbox/InboxDrawer.vue:32` 图标映射、`composables/useInboxSystemNotify.ts:43` 通知分支 | 四处同步加 `WATCHER_DISABLED`；通知偏好走 `default: return true`（停用是运维级事件，与 `TRIGGER_DISABLED` 同档，不加新偏好列） |
| `InboxSource` | `shared/contracts/src/inbox.ts:18` = `'MANUAL'\|'SCHEDULED'\|'WEBHOOK'\|'API'`（前端来源徽标） | 同步加 `'SIGNAL'` |
| 系统设置范式 | `settings/settings.service.ts` 顶部常量区 + `getOpt(key)` 回落默认；`openapi.callLogRetentionDays`（默认 90）由 `getOpenApiCallLogRetentionDays()` 读取（`:618-622`） | 新增 `signal.checkRetentionDays`（默认 90，决策 11），读取方式照抄 |
| 清理器范式 | `openapi/open-api-call-log.cleanup.ts`：setInterval + `stopped` + `MAX_BATCHES=20` + `retentionDays()` 注入 | `SignalCheckCleanup` 照此实现 |
| 权限注册范式 | `V145__open_api_call_log.sql` 末段：`INSERT INTO permission ... WHERE NOT EXISTS` + `INSERT IGNORE INTO role_permission SELECT 1, id ... WHERE code IN (...)` | V148 注册 `signal:read` 并授 `role_id=1` |
| 迁移版本 | `backend-ts/db/migration/` 最新 `V147__api_token_cipher.sql` | 新迁移从 **V148** 起 |
| 设置页范式 | `desktop/src/views/settings/SettingsView.vue` 侧边导航（含「开放接口」`/settings/open-api`）+ `OpenApiView.vue`；路由 `desktop/src/router/index.ts:112` | 新增 `/settings/signal-watchers` 导航项与视图；API 客户端函数照 `api/index.ts:663-684` 的 triggers 一组写法 |
| 管理后台范式 | `admin/src/views/openapi/OpenApiCallView.vue` 清单页 + `admin/src/router/index.ts:93-97`（`meta.permission`） | 新增只读清单页 `admin/src/views/signal/SignalWatcherListView.vue` + 路由 `signal-watchers`，`permission: 'signal:read'` |
| `LLM_CALL_SCENES` | `usage/llm-call-context.ts` 封闭集合 | **不改**：哨兵触发就是普通 `scene=agent` 调用，不新增场景 |

### 1.2 上游提案的修正（本方案对提案的实质变更）

1. **判定模式从两种扩到三种**：提案目标 1 写「内容哈希 / JSON 字段 / 状态码变化」三种，但 §3.1 数据模型 `compare_mode` 注释只有 `HASH`/`JSON_FIELD`。按用户决策 14 统一为 **`HASH` / `JSON_FIELD` / `STATUS_CODE`** 三种，`STATUS_CODE` 的判定值为 HTTP 状态码本身（200→503 即变化）。
2. **删除「管理员显式放行内网」**（提案目标 5 与 §5 风险）：用户决策 3 定为 http/https 均可 + 复用私网/环回/链路本地/组播/IPv6 字面量/.local/.internal 拦截，**不放行、不提供配置入口**。P3 的「SSRF 放行配置」取消。
3. **删除「可选 sessionId 复用会话」**（提案 §3.3）：用户决策 5 定为每次触发新建会话。数据模型不增加绑定会话列，`OpenRunService` 调用不传 `sessionId`。
4. **`{diff}` 口径定死**（提案 §3.3「哈希变化 + 响应体前后差异片段截断」表述含糊）：用户决策 6 定为**旧/新各截断 500 字**，不做行级 diff、不引 diff 库。`JSON_FIELD`/`STATUS_CODE` 模式直接给旧值 → 新值原文（各 500 字）。
5. **触发频次上限的处置反转**（提案 §5 风险「超出记失败不触发」）：用户决策 7 定为**照常触发，仅在该次轮询记录上打 warning 标记**，不计 `consecutive_failures`、不停用。理由：频次上限的目的是「让用户看见抖动」，不是「压制真实高频变化」。
6. **自动暂停阈值 10 → 5**（提案 §3.2「默认 10，可配」）：用户决策 8 定为 5，与 `TRIGGER_DISABLE_AFTER_FAILURES` 对齐，且**不做成可配**（两处阈值语义一致比分别可配更有价值）。
7. **删除 P3 的「POST 体模板变量」**：POST 体按用户填写原文发送，不做 `{url}` 类占位替换（prompt 模板的占位符只作用于 prompt，不作用于探针请求）。
8. **管理后台统计取消**（提案 §3.4「触发统计按天/按 Agent」）：用户决策 13 定为只读清单，不做统计图表。
9. **轮询记录保留改为系统设置**（提案未提及）：用户决策 11 定为系统设置项 `signal.checkRetentionDays`（默认 90），清理器照 `OpenApiCallLogCleanup` 实现。
10. **新增 `STATUS_CODE` 模式下的失败口径澄清**：非 2xx 在 `HASH`/`JSON_FIELD` 模式下是**合法判定输入**（响应体照常参与哈希/解析），只有网络错误、超时、超大小上限、JSON 解析失败才算失败；`STATUS_CODE` 模式下任何完成响应的状态码都是合法输入。

---

## 2. 需求描述

### 2.1 要做的

1. **哨兵定义 CRUD**：字段为名称、目标 Agent、探针 URL（http/https）、方法（GET/POST）、请求头（键值对，敏感值加密）、POST 体（可含敏感值，加密）、轮询间隔（分钟，钳制 1..1440）、判定模式（`HASH`/`JSON_FIELD`/`STATUS_CODE`）、`JSON_FIELD` 模式的提取路径、变化时发送的 prompt 模板（支持 `{url}`/`{name}`/`{diff}` 占位）。本人数据，按 `user_id` 过滤。
2. **数量上限**：每用户最多 20 个哨兵（对齐 `MAX_TRIGGERS_PER_USER = 20`）。
3. **轮询调度**：`WatcherScheduler` 每 30 秒扫一次到期哨兵（`status='ACTIVE'` 且 `last_checked_at` 为空或早于 `NOW() - interval_minutes`），批量 50，进程内单飞（同一 watcher 同时只有一个在途探针）。
4. **探针执行**：新建专用客户端，支持任意方法 + 请求头 + body、连接 10s / 读取 15s 双超时、响应体上限 1MB（流式超限即断）、禁重定向、接受任意 HTTP 状态码作为判定输入。
5. **判定与触发**：`HASH` 取响应体 SHA-256；`JSON_FIELD` 按点分路径（支持数组下标，如 `data.items.0.price`）取值后哈希；`STATUS_CODE` 取状态码字符串。判定值与 `last_value_hash` 不同即变化 → 渲染 prompt 模板 → 经 `OpenRunService`（`source='SIGNAL'`）发起运行，写 `signal_watcher_check.triggered_session_id`。
6. **首轮只建基线**：`last_value_hash` 为空时只记录不触发。编辑 URL/方法/请求头/body/判定模式/提取路径任一字段后清空 `last_value_hash` 与 `last_changed_at`，下次轮询重建基线。
7. **失败退避**：连续失败 `consecutive_failures` +1，下次检查时间按 `interval * min(2^failures, 32)` 分钟推远；成功则计数清零、恢复原间隔。
8. **自动停用与通知**：连续失败达 5 次 → `status='DISABLED'` + 收件箱 `WATCHER_DISABLED` 通知（无偏好开关，始终通知）。
9. **可观测**：每次轮询落一行 `signal_watcher_check`（时间、HTTP 状态、判定值哈希、是否变化、触发会话 id、失败原因、耗时、频次超限 warning 标记）；设置页哨兵详情展示最近 N 次轮询记录与触发历史，可跳转会话。
10. **启停与删除**：`PAUSED`/`ACTIVE` 可互切（手动启停）；`DISABLED` 是系统终态，用户可手动重新启用（同时清零 `consecutive_failures` 并重置基线）。删除哨兵级联删其全部 check 记录，不删已产生会话。
11. **安全基线**：URL 限 http/https；禁私网/环回/链路本地/组播/IPv6 字面量/.local/.internal；敏感字段 AES-GCM 加密（独立密钥 `APP_SIGNAL_SECRET`）；列表与详情回显时敏感值打码；审计不记录明文。
12. **触发成本明示**：设置页哨兵卡片与新建表单均提示「每次变化 = 一次 Agent 运行，会计入用量」。
13. **管理后台只读清单**：全量哨兵（名称/属主/URL/间隔/状态/上次变化时间/连续失败），`signal:read` 权限，默认授系统管理员角色。
14. **系统设置**：新增 `signal.checkRetentionDays`（默认 90），配清理器按天滚动删除。

### 2.2 不做的

| 项 | 说明 |
|---|---|
| 非 HTTP 信号源 | 不做数据库变更、消息队列消费、文件系统 watch |
| 页面渲染抓取 | 不做无头浏览器 / JS 执行后内容，探针只拿原始 HTTP 响应体 |
| 多步探针链 | 不支持先 A 再依赖 A 的结果请求 B |
| 阈值型监控表达式 | 只做「与上次比对」，不提供「CPU > 80%」这类常量阈值表达式 |
| 跨实例共享轮询状态 | 单后端部署，进程内调度，不引入分布式锁/共享状态 |
| 管理员内网放行 | 不提供 CIDR 放行配置、不做放行审计（提案 P3 内容取消） |
| 会话绑定 | 不支持把哨兵固定绑定到一个会话反复投递 |
| POST 体模板变量 | 探针请求体按原文发送，不做占位替换 |
| 触发统计图表 | 管理后台只做清单，不做按天/按 Agent 的统计与图表 |
| 语义判重 | 不做「两次变化其实是同一件事」的 LLM 判重 |
| 排队终态回写 | 哨兵触发 busy 入队后，不回写 `consecutive_failures`（无排队绑定，见 §5.6） |
| 新增 LLM 场景 | 不改 `LLM_CALL_SCENES`，哨兵触发即普通 `scene=agent` |
| 自动停用阈值可配 | 固定 5 次，不做系统设置项 |
| 触发频次上限可配 | 固定每小时 4 次，不做系统设置项；超出仅 warning |
| 开放 API 暴露 | 不为哨兵新增入站端点；触发是内部行为 |

---

## 3. 技术选型

| 决策点 | 选型 | 理由 |
|---|---|---|
| 触发来源标识 | 新增 `'SIGNAL'` 到 `TaskNotifySource`/`MessageQueueSource`/`QueuedSource`/`InboxSource`/`liveExecution` 第 7 参 | 收件箱徽标、排队来源、统计口径四处可区分哨兵流量；复用 `'API'` 会把哨兵与开放 Token 混为一谈 |
| 探针执行器 | 新建 `signal/probe-client.ts`（node:http/https 直连，仿 `fetch-bytes.ts` 的双超时 + 流式上限） | `fetch-bytes.ts` GET-only 且非 2xx 抛错、`generic-webhook-sender.ts` POST-only，均不匹配；不动既有工具有回归面 |
| URL 协议 | http/https 均可 | 大量可探测端点是 http（内网设备、开发 API）；https-only 会挡掉它们 |
| SSRF 基线 | 复用 `isPrivateOrReservedHostname`，抽到 `common/ssrf.ts`；**无放行机制** | 现成实现已覆盖绝大部分；放行机制属提案 P3，用户决策本次不做 |
| 敏感字段加密 | 新建 `SignalSecretCipher` + `cfg.app.signal.secretKey` ← `APP_SIGNAL_SECRET` | 与 API Token / 通知 Webhook / MCP 同模式但独立配置独立轮换（用户决策 4） |
| 会话策略 | 每次触发新建会话，不传 `sessionId` | 会话即一次变化事件；prompt 自包含 `{diff}`；避免用户手动聊天与自动触发混在一个会话 |
| `{diff}` 口径 | 旧/新各截断 500 字；`HASH` 模式为响应体片段，`JSON_FIELD`/`STATUS_CODE` 为取值原文 | 不引 diff 库、口径简单可预期；Agent 能知道「变了什么」 |
| 频次上限（4 次/小时） | 超出照常触发，仅在 check 行打 warning | 上限的目的是可见性而非压制；记失败会把真实高频源打成连败停用 |
| 自动停用阈值 | 5 次，与 `TRIGGER_DISABLE_AFTER_FAILURES` 对齐 | 两种「连续失败自动停用」交互一致 |
| 退避 | `interval * min(2^failures, 32)` 分钟，成功清零 | 防对端临时抽风时的密集重试 |
| 记录保留 | 系统设置 `signal.checkRetentionDays`，默认 90，`SignalCheckCleanup` 滚动删 | 用户决策 11；照 `openapi.callLogRetentionDays` 现成范式 |
| 删除级联 | 删哨兵 → 级联删 check 记录；保留会话；在途探针跑完不回写 | 无孤儿数据、不杀在途执行 |
| 管理后台 | 只读清单 + `signal:read` | 无真实数据前统计页价值有限；控制范围 |
| 归属模型 | 本人数据（CRUD 与查询均按 `user_id` 过滤） | 与开放接口 API Token 一致 |

---

## 4. 数据模型

### V148__signal_watcher.sql

```sql
CREATE TABLE IF NOT EXISTS `signal_watcher` (
    `id`                    BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`               BIGINT NOT NULL COMMENT '属主',
    `agent_id`              BIGINT NOT NULL COMMENT '变化时运行的目标 Agent',
    `name`                  VARCHAR(128) NOT NULL COMMENT '哨兵名称',
    `url`                   VARCHAR(1024) NOT NULL COMMENT '探针 URL（http/https）',
    `method`                VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/POST',
    `headers_json`          TEXT NULL COMMENT '请求头（敏感值加密存储，脱敏回显）',
    `body`                  TEXT NULL COMMENT 'POST 体（可含敏感值，加密存储）',
    `interval_minutes`      INT NOT NULL DEFAULT 15 COMMENT '轮询间隔（分钟），钳制 1..1440',
    `compare_mode`          VARCHAR(16) NOT NULL DEFAULT 'HASH' COMMENT 'HASH/JSON_FIELD/STATUS_CODE',
    `json_path`             VARCHAR(255) NULL COMMENT 'compare_mode=JSON_FIELD 时的点分提取路径',
    `prompt_template`       VARCHAR(2000) NOT NULL COMMENT '变化时发给 Agent 的提示词，支持 {diff} {url} {name} 占位',
    `status`                VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE/PAUSED/DISABLED',
    `last_value_hash`       VARCHAR(64) NULL COMMENT '上次判定值哈希；空=待建基线',
    `last_checked_at`       DATETIME NULL COMMENT '上次轮询时刻（退避写入未来时刻）',
    `last_changed_at`       DATETIME NULL COMMENT '上次判定值变化时刻',
    `consecutive_failures`  INT NOT NULL DEFAULT 0 COMMENT '连续失败次数；成功清零',
    `created_at`            DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`            DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY `idx_watcher_due` (`status`, `last_checked_at`),
    KEY `idx_watcher_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='信号哨兵：HTTP 探针变化触发 Agent';

CREATE TABLE IF NOT EXISTS `signal_watcher_check` (
    `id`                    BIGINT PRIMARY KEY AUTO_INCREMENT,
    `watcher_id`            BIGINT NOT NULL COMMENT '所属哨兵',
    `checked_at`            DATETIME DEFAULT CURRENT_TIMESTAMP COMMENT '轮询时刻',
    `http_status`           INT NULL COMMENT '探针 HTTP 状态码；网络失败为 NULL',
    `value_hash`            VARCHAR(64) NULL COMMENT '本次判定值哈希，与 watcher.last_value_hash 比对',
    `changed`               TINYINT NOT NULL DEFAULT 0 COMMENT '本次判定值是否变化',
    `triggered_session_id`  BIGINT NULL COMMENT '变化触发时产生的会话',
    `error`                 VARCHAR(500) NULL COMMENT '失败原因（截断）',
    `duration_ms`           INT NULL COMMENT '探针耗时',
    `warning`               VARCHAR(64) NULL COMMENT '非失败告警：TRIGGER_RATE_LIMITED=触发频次超限',
    KEY `idx_check_watcher` (`watcher_id`, `checked_at`),
    KEY `idx_check_checked_at` (`checked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='信号哨兵轮询记录';

INSERT INTO `permission` (`name`, `code`, `description`)
SELECT '查看信号哨兵', 'signal:read', '查看全量信号哨兵清单'
WHERE NOT EXISTS (SELECT 1 FROM `permission` WHERE `code` = 'signal:read');
INSERT IGNORE INTO `role_permission` (`role_id`, `permission_id`)
SELECT 1, id FROM `permission` WHERE `code` = 'signal:read';

INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`)
VALUES ('signal.checkRetentionDays', '90', '信号哨兵', '哨兵轮询记录保留天数（滚动清理）', 1);
```

要点：

- `idx_check_checked_at` 是清理器的删除条件索引（`OpenApiCallLogCleanup` 同款按 `created_at` 删）。
- `signal_watcher_check` 不加外键：删除哨兵时按 `watcher_id` 显式批量删，与 `open_api_call_log` 一致（库内无外键约束）。
- `warning` 列只放非失败告警；失败走 `error` 列并计 `consecutive_failures`，两者互斥。

---

## 5. 实现设计

新增域目录 `backend-ts/src/signal/`，文件划分：

| 文件 | 职责 |
|---|---|
| `types.ts` | `SignalWatcher` / `SignalWatcherCheck` 行类型、`SignalCompareMode` 联合、`SignalWatcherStatus` 联合 |
| `probe-client.ts` | 探针执行器（§5.2） |
| `probe-validate.ts` | URL 协议 + SSRF 校验、请求头键值校验（§5.4） |
| `signal-cipher.ts` | `SignalSecretCipher`（§5.5） |
| `signal.repository.ts` | 两个表的仓储：listDue/claim-free 单飞、updateCheckResult、recordFailure、recordDisabled、list/listChecks/insert/update/delete |
| `watcher-scheduler.ts` | 轮询调度 + 单飞 + 退避 + 自动停用（§5.3、§5.6） |
| `watcher.service.ts` | 用户级 CRUD + 模板渲染 + 触发编排（§5.6） |
| `watcher.routes.ts` | `/v1/signal-watchers` 路由（登录态，本人数据） |
| `signal-check-cleanup.ts` | 轮询记录滚动清理（§5.7） |
| `signal-admin.routes.ts` | `/v1/admin/signal-watchers` 只读清单（`@RequirePermission('signal:read')`） |
| `*.spec.ts` | 单测（§8） |

### 5.1 source 扩展（决策 1）

五处同源扩展，全部为联合类型加成员，无行为分支改动：

```ts
// session/task-terminal.service.ts:19
export type TaskNotifySource = 'MANUAL' | 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL';

// session/types.ts:81
export type MessageQueueSource = 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL';

// session/ws/streaming-ws-handler.ts:240
type QueuedSource = 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL';

// openapi/open-run.service.ts:50 —— 入参放宽
source: Extract<TaskNotifySource, 'API' | 'WEBHOOK' | 'SIGNAL'>;

// openapi/open-run.service.ts:41 —— liveExecution 第 7 参
liveExecution: ((session: Session, userId: number, executionId: string, savedMessage: Message,
  startedAt?: number, scheduledTaskId?: number | null,
  source?: 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL' | null) => Promise<void>) | null;

// shared/contracts/src/inbox.ts:18
export type InboxSource = 'MANUAL' | 'SCHEDULED' | 'WEBHOOK' | 'API' | 'SIGNAL';
```

`queueSettlementOf`（`streaming-ws-handler.ts:244`）的白名单同步加 `'SIGNAL'`；settlement 的 `taskId`/`triggerId` 取值为 null 的分支已存在，无需改。

### 5.2 探针执行器 `probe-client.ts`

仿 `fetch-bytes.ts` 的 `node:http/https` + 双 timer 结构，差异点：

```ts
export interface ProbeRequest {
  url: string;
  method: string;              // GET/POST
  headers: Record<string, string>;
  body: string | null;
}
export interface ProbeResult {
  ok: boolean;                 // 是否取得完整响应（网络/超时/超大小为 false）
  httpStatus: number | null;
  body: string | null;         // 超限或失败为 null
  error: string | null;
  durationMs: number;
}

const CONNECT_TIMEOUT_MS = 10_000;
const READ_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 1024 * 1024;

export async function executeProbe(req: ProbeRequest): Promise<ProbeResult>
```

实现约束：

1. `lib.request(u, { method, headers })` 而非 `lib.get`；`redirect: 'manual'`，3xx 视为 `ok=false` + `error='重定向未跟随'`（与出站投递口径一致）。
2. **不因状态码非 2xx 而失败**：任何完成响应的状态码都 `ok=true`，`httpStatus` 与 `body` 照常返回，由判定层决定怎么用。
3. 流式累计超 `MAX_BODY_BYTES` 立即 `req.destroy()` 并返回 `ok=false, error='响应体超过 1MB 上限'`。
4. `connectTimer` 在收到响应头时清除，`readTimer` 管响应体读取；两个 timer 都 `req.destroy()` 后 finish。
5. 错误信息只回 `HTTP ${status}` / 超时 / 上限 / `ECONNREFUSED` 类 `err.code`，不拼 URL、不回响应体——防内网探测信息经错误串泄露。
6. 响应体按 utf8 解码；解码失败按 `latin1` 兜底并仍可哈希（哈希的是 Buffer 的 sha256，见 §5.6）。

### 5.3 调度器 `watcher-scheduler.ts`

结构照 `OutboundDeliveryScheduler`（setTimeout 链 + `dispatching` + `stopped` + `execute` 注入 + `intervalMs` 可注入），差异点是**无 claim 列**，单飞用进程内 Map：

```ts
const SCAN_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;
/** 触发频次上限：同一哨兵每小时最多 4 次（决策 7）。 */
export const WATCHER_MAX_TRIGGERS_PER_HOUR = 4;
/** 连续失败自动停用阈值（决策 8，与 webhook-trigger 对齐）。 */
export const WATCHER_DISABLE_AFTER_FAILURES = 5;
/** 退避倍率上限（决策 10）。 */
const BACKOFF_MAX_FACTOR = 32;

export class WatcherScheduler {
  private readonly inFlight = new Set<number>();   // watcherId 单飞标记
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dispatching = false;
  private stopped = true;

  start(): void { this.stopped = false; this.scheduleNext(); }
  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); }

  async dispatchDueWatchers(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const due = await this.deps.watcherRepo.listDue(formatDateTime(new Date()), BATCH_SIZE);
      for (const w of due) {
        if (w.id == null || this.inFlight.has(w.id)) continue;   // 单飞：重叠不叠加
        this.inFlight.add(w.id);
        this.execute(() => this.checkWatcher(w.id!));
      }
    } finally { this.dispatching = false; }
  }

  private async checkWatcher(watcherId: number): Promise<void> {
    try { await this.deps.runCheck(watcherId); }
    catch (e) { console.error(`信号哨兵轮询异常, id=${watcherId}`, e); }
    finally { this.inFlight.delete(watcherId); }
  }
}
```

`listDue` SQL（索引 `idx_watcher_due(status, last_checked_at)` 覆盖）：

```sql
SELECT * FROM signal_watcher
WHERE status = 'ACTIVE'
  AND (last_checked_at IS NULL OR last_checked_at < ?)
ORDER BY last_checked_at IS NOT NULL, last_checked_at
LIMIT ?
```

`?` 为 `NOW()` 的格式化值。**重启无需恢复内存态**：due 判定完全落在 `last_checked_at` 列上，进程重启后扫到即续。

### 5.4 URL 与请求头校验 `probe-validate.ts`

把 `weixin/qr-login.service.ts:181` 的 `isPrivateOrReservedHostname` **原样抽到** `backend-ts/src/common/ssrf.ts`（不新增规则、不改判定），微信侧改为 import 复用，其既有单测随之迁移到 `common/ssrf.spec.ts`。

```ts
export function assertProbeUrl(raw: string): string {
  let parsed: URL;
  try { parsed = new URL(raw.trim()); } catch { throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不合法'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 仅支持 http/https');
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不允许内嵌凭据');
  }
  const host = parsed.hostname.toLowerCase();
  if (isPrivateOrReservedHostname(host)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, 'URL 不允许指向私网/环回/链路本地地址');
  }
  return parsed.toString();
}
```

请求头校验：键非空且不含 `:` 与换行、值不含换行；**禁止覆盖 `Host`、`Content-Length`、`Transfer-Encoding`**（防走私与探测偏移）；键数量上限 20。

**已知边界（记录在 §9）**：DNS 解析在 `node:http` 内部完成，存在 DNS Rebinding 时间窗（校验域名 → 请求时重解析到内网）。P1 不做解析期固定 IP，缓解手段是仅允许公网域名 + 禁止 IPv6 字面量。

### 5.5 敏感字段加密 `signal-cipher.ts`

```ts
export class SignalSecretCipher {
  constructor(private readonly secretKey: string = '') {}
  encrypt(plaintext: string): string { /* 同 ApiTokenCipher，未配置密钥抛 INTERNAL_ERROR，提示设置 APP_SIGNAL_SECRET */ }
  decrypt(ciphertext: string): string { /* 同款 */ }
}
```

配置接入 `config/app-config.ts`：

```ts
// 类型定义（:102 附近的 app 段）
signal: { secretKey: string };
// DEFAULTS（:222 附近）
signal: { secretKey: 'mao-signal-secret-default-key-v1-20261011' },
// loadConfig（:432 附近）
if (process.env.APP_SIGNAL_SECRET) { cfg.app.signal.secretKey = process.env.APP_SIGNAL_SECRET; }
```

存储口径：`headers_json` 与 `body` **整体加密**为一整段密文落库（不是逐值加密），读取时整体解密后 `JSON.parse`。理由：请求头顺序与重复键保持原样；密文只有一处，脱敏逻辑集中在服务层。

脱敏回显：`headers_json` 中键名命中 `authorization`/`cookie`/`x-api-key`/`token`/`secret`/`password`（大小写不敏感、含子串即命中）的值替换为 `******`；其余键值原样回显。`body` 不回显内容，只回显长度。

审计：`signal_watcher` 的增删改走审计时记录 `url`、`compare_mode`、`interval_minutes`，**不记录 `headers_json`/`body` 明文或密文**。

### 5.6 判定、触发与失败回写 `watcher.service.ts`

单次轮询主流程 `runCheck(watcherId)`：

```
1. 读哨兵行（可能已被删/已停用 → 直接返回，不写 check）
2. 解密 headers/body → assertProbeUrl(url)（保存时已校验，此处复校防库内被改）
3. executeProbe(...)
4. 写 signal_watcher_check（http_status / duration_ms / error）
5. 分支：
   a. ok=false（网络/超时/超限/重定向）→ recordFailure + 退避推进 + 达阈值 DISABLED+通知
   b. ok=true → computeValue(compareMode, status, body)：
      - HASH:        sha256hex(bodyBuffer)
      - STATUS_CODE: sha256hex(String(httpStatus))
      - JSON_FIELD:  按 json_path 取值 → sha256hex(String(value))；解析/取值失败按 a 处理
6. 判定：
   - last_value_hash 为空 → 写 last_value_hash + last_checked_at，changed=0，不触发（基线）
   - 与新哈希相同 → changed=0，consecutive_failures 清零
   - 不同 → changed=1：
       · 打 warning 标记：近 1 小时触发次数 ≥ 4 → check.warning='TRIGGER_RATE_LIMITED'（决策 7：
         仅标记可见性，不阻断、不计失败、不停用）
       · 渲染 prompt → openRunService.run({ userId, agentId, message, source:'SIGNAL' })
           - 抛错（预算 BLOCK / Agent 停用 / 会话创建失败）→ recordFailure（预算 BLOCK 计入连败，
             与 webhook-trigger.service.ts:251 同口径，防超限哨兵无限重试刷量）
           - 成功 → 回写 check.triggered_session_id、last_value_hash、last_changed_at、失败清零
```

`computeValue` 的点分路径解析（自研，不引库）：

```ts
/** data.items.0.price → body['data']['items'][0]['price']；任一段缺失或越界抛错 */
export function extractJsonPath(root: unknown, path: string): unknown
```

约束：路径段为空串、段数 > 16、取到的值为 `undefined`/`null` 均视为提取失败（记失败，不静默取空串——空串会让「字段消失」看起来像一次正常变化）。

prompt 模板渲染：

```ts
export function renderWatcherPrompt(template: string, vars: { url: string; name: string; diff: string }): string
```

- 占位符 `{url}` / `{name}` / `{diff}` 用 `split/join` 替换（不用正则，避免用户模板里的 `$` 被当分组引用）。
- `{diff}` 构造：
  - `HASH`：`旧值片段（前 500 字）\n---\n新值片段（前 500 字）`，片段前加 `[响应体前 500 字]` 标注；
  - `JSON_FIELD`：`[字段 data.items.0.price] 旧值：... → 新值：...`（各截 500 字）；
  - `STATUS_CODE`：`[HTTP 状态码] 200 → 503`。
- 渲染结果过 `OPEN_RUN_MESSAGE_MAX_LENGTH`（32000）校验，超长按 `diff` 侧截断。
- 模板不含任何占位符时也能正常发送（`{diff}` 之外用户可写死提示词）。

**失败计数与退避**（`recordFailure`）：

```sql
UPDATE signal_watcher
SET consecutive_failures = consecutive_failures + 1,
    last_checked_at = DATE_ADD(NOW(), INTERVAL ? MINUTE),
    status = IF(consecutive_failures + 1 >= ?, 'DISABLED', status),
    updated_at = NOW()
WHERE id = ?
```

`?` 分别为 `interval_minutes * min(2^failures, 32)` 与阈值 5。`status` 的条件更新保证「同一时刻只从 ACTIVE 变 DISABLED」，PAUSED 不被误改。返回 `affectedRows` 与更新后的行，服务层据 `status === 'DISABLED'` 且变化前为 ACTIVE 发一次通知。

**为什么没有排队回写绑定**：Webhook 触发器靠 `openTriggerId` + `openTriggerSettle` 在队列消费侧回写终态；哨兵触发**每次新建会话**，且哨兵的失败语义是「探针失败」而非「Agent 执行失败」——探针成功即算成功，Agent 后续跑成跑败不影响 `consecutive_failures`。因此哨兵只走直跑路径的回写，busy 入队的消息消费后无回写（§2.2 已列为不做）。

### 5.7 用户级 API `watcher.routes.ts`

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/signal-watchers` | 列表（本人），返回脱敏视图 |
| POST | `/v1/signal-watchers` | 新建；校验数量上限 20 |
| GET | `/v1/signal-watchers/:id` | 详情（脱敏） |
| PUT | `/v1/signal-watchers/:id` | 编辑；命中判定字段则重置基线（决策 9） |
| DELETE | `/v1/signal-watchers/:id` | 删除（级联删 check 记录） |
| POST | `/v1/signal-watchers/:id/status` | 启停：`{ status: 'ACTIVE' \| 'PAUSED' }`；DISABLED → ACTIVE 时清零失败并重置基线 |
| GET | `/v1/signal-watchers/:id/checks` | 轮询记录分页（`page`/`size`，按 `checked_at` 倒序） |
| POST | `/v1/signal-watchers/:id/test` | 立即执行一次探针并返回判定预览（不触发、不写库） |

路由装配沿用 openapi 域的登录态守卫范式（`requireJwtIdentity`）；**不加 `@RequirePermission`**（本人数据无管理语义）。

「立即测试」端点返回 `{ httpStatus, durationMs, valueHash, parseOk, sample }`，`sample` 为响应体前 200 字，让用户在保存前确认 URL 可达、判定模式选对了。

### 5.8 桌面端 `desktop`

1. `api/index.ts` 新增 `SignalWatcherView` 类型与 8 个请求函数（写法照 `listWebhookTriggers` 一组，`:663-684`）。
2. `views/settings/SignalWatchersView.vue`：列表卡片（名称 / URL / 间隔 / 状态徽标 / 上次变化时间 / 连续失败数）+ 新建/编辑对话框 + 启停 + 删除二次确认 + 详情抽屉（最近 50 条轮询记录表 + 触发历史会话链接）。
3. `SettingsView.vue` 侧边导航在「开放接口」后加「信号哨兵」；`router/index.ts` 在 `:112` 后加 `settings/signal-watchers` 路由。
4. 表单约束：间隔 `el-input-number` 1..1440；`compare_mode` 单选，选 `JSON_FIELD` 时才显示并必填 `json_path`；请求头动态键值对编辑器；保存前提示「每次变化 = 一次 Agent 运行，会计入用量」。
5. 敏感字段：编辑时请求头敏感值显示 `******`，留空表示不修改；`body` 显示长度占位。

### 5.9 管理后台 `admin`

1. `views/signal/SignalWatcherListView.vue`：表格列 名称 / 属主 / URL / 方法 / 间隔 / 判定模式 / 状态 / 上次变化时间 / 连续失败 / 创建时间；筛选 状态 + 属主；分页默认第一页。
2. `router/index.ts` 在 `openapi-calls` 后加 `signal-watchers`，`meta: { title: '信号哨兵', keepAlive: true, permission: 'signal:read' }`。
3. 后端 `signal-admin.routes.ts`：`GET /v1/admin/signal-watchers`（分页 + 筛选），`@RequirePermission('signal:read')`；响应同样脱敏。

### 5.10 装配 `create-app.ts`

```ts
// 1. cipher（:1438 附近 openRunService 之前）
const signalCipher = new SignalSecretCipher(cfg.app.signal.secretKey);

// 2. 触发服务（依赖 openRunService）
const watcherService = new WatcherService({
  watcherRepo: new MysqlSignalWatcherRepository(db),
  checkRepo: new MysqlSignalCheckRepository(db),
  cipher: signalCipher,
  openRun: openRunService,                                   // source: 'SIGNAL'
  probe: { execute: executeProbe },
  disableNotifier: { notifyWatcherDisabled: async (i) => inboxService.recordWatcherDisabled(i) },
  maxPerUser: 20,
});

// 3. 调度器（注入线程池 execute，与 outboundDeliveryScheduler 同源）
const watcherScheduler = new WatcherScheduler({
  watcherRepo: new MysqlSignalWatcherRepository(db),
  runCheck: (id) => watcherService.runCheck(id),
  execute: (fn) => agentExecutor.submit(fn),
});
watcherScheduler.start();

// 4. 清理器（照 callLogCleanup）
const signalCheckCleanup = new SignalCheckCleanup(
  new MysqlSignalCheckRepository(db),
  () => settingService.getSignalCheckRetentionDays(),
);
signalCheckCleanup.start();

// 5. onClose（:2928 附近）
watcherScheduler.stop();
signalCheckCleanup.stop();
```

`WatcherService.runCheck` 内部自行读取哨兵行与解密，调度器只负责「到期扫描 + 单飞 + 线程池」，与 `OutboundDeliveryScheduler` 的职责划分一致。

### 5.11 收件箱 `WATCHER_DISABLED`

新增 `InboxService.recordWatcherDisabled({ userId, watcherId, watcherName, failures })`，写法照 `recordTriggerDisabled`（`inbox.service.ts:143`）：无偏好开关、`tail: ${watcherId}:${Date.now()}` 保证可重复通知、`content` 提示「连续失败 N 次，已自动停用；请检查目标地址可达性后重新启用」。

五处同步：

| 文件 | 改动 |
|---|---|
| `shared/contracts/src/inbox.ts:7` | `InboxKind` 加 `'WATCHER_DISABLED'` |
| `backend-ts/src/inbox/types.ts:8` | `INBOX_KINDS` 加 `'WATCHER_DISABLED'` |
| `desktop/src/stores/inbox/index.ts:23` | 白名单加 `'WATCHER_DISABLED'` |
| `desktop/src/components/inbox/InboxDrawer.vue:32` | `WATCHER_DISABLED: { label: '哨兵已停用', icon: '🛰' }` |
| `desktop/src/composables/useInboxSystemNotify.ts` | 与 `TRIGGER_DISABLED` 同分支 `return true` |

---

## 6. 实现步骤

| 步骤 | 内容 | 产出 |
|---|---|---|
| 1 | `common/ssrf.ts` 抽取 + 微信侧改为 import 复用 + 单测迁移 | SSRF 判定单一来源，`common/ssrf.spec.ts` |
| 2 | V148 迁移（两表 + 权限 + 设置项） | `db/migration/V148__signal_watcher.sql` |
| 3 | source 五处扩展（§5.1） | 类型改动 + 既有单测回归 |
| 4 | `SignalSecretCipher` + `app-config.ts` 接入 `APP_SIGNAL_SECRET` | `signal/signal-cipher.ts` + `signal-cipher.spec.ts` |
| 5 | `probe-client.ts` + `probe-validate.ts` + 单测 | 探针执行器与 URL/请求头校验 |
| 6 | `signal/types.ts` + `signal.repository.ts` + 单测 | 行类型与仓储（listDue/recordFailure 等） |
| 7 | `watcher.service.ts`（判定/渲染/触发/退避/停用） + 单测 | 核心编排逻辑 |
| 8 | `watcher-scheduler.ts` + 单测 | 到期扫描 + 单飞 + 重启恢复 |
| 9 | `watcher.routes.ts` + 集成测试 | 用户级 CRUD/启停/记录分页/立即测试 |
| 10 | 收件箱 `WATCHER_DISABLED` 五处同步 + 回归 | 通知链路 |
| 11 | `create-app.ts` 装配 + E2E 冒烟 | 端到端可跑 |
| 12 | `signal-check-cleanup.ts` + 设置项 `getSignalCheckRetentionDays()` + 单测 | 保留策略 |
| 13 | 桌面端视图/路由/API 客户端 + 单测 | 设置页哨兵管理 |
| 14 | 管理后台清单页/路由/后端只读接口 + 单测 | `signal:read` 清单 |
| 15 | `tool-result-summarizer.ts` / `toolDisplay.ts` 无需改动（无新内置工具）；更新 CHANGELOG、README、DEPLOY（`APP_SIGNAL_SECRET`）、mao-cli 技能文档 | 文档同步 |

---

## 7. 落地清单

### 后端 backend-ts

- [ ] `common/ssrf.ts` 抽取 + 微信侧改造 + 单测迁移
- [ ] `db/migration/V148__signal_watcher.sql`
- [ ] `session/task-terminal.service.ts` `TaskNotifySource` 加 `'SIGNAL'`
- [ ] `session/types.ts` `MessageQueueSource` 加 `'SIGNAL'`
- [ ] `session/ws/streaming-ws-handler.ts` `QueuedSource` 白名单 + `liveExecution` source 类型
- [ ] `openapi/open-run.service.ts` `source` 入参与 `liveExecution` 签名放宽
- [ ] `config/app-config.ts` `app.signal.secretKey` + `APP_SIGNAL_SECRET`
- [ ] `signal/signal-cipher.ts` + spec
- [ ] `signal/probe-client.ts` + spec
- [ ] `signal/probe-validate.ts` + spec
- [ ] `signal/types.ts`、`signal.repository.ts` + spec
- [ ] `signal/watcher.service.ts` + spec
- [ ] `signal/watcher-scheduler.ts` + spec
- [ ] `signal/watcher.routes.ts` + 集成测试
- [ ] `signal/signal-admin.routes.ts` + 集成测试
- [ ] `signal/signal-check-cleanup.ts` + spec
- [ ] `settings/settings.service.ts` `SIGNAL_CHECK_RETENTION_DAYS_KEY` + getter
- [ ] `inbox/types.ts` + `inbox.service.ts` `WATCHER_DISABLED`
- [ ] `create-app.ts` 装配 + onClose

### 桌面端 desktop / 契约 shared

- [ ] `shared/contracts/src/inbox.ts` `InboxKind` + `InboxSource`
- [ ] `desktop/src/api/index.ts` `SignalWatcherView` + 8 个请求函数
- [ ] `desktop/src/views/settings/SignalWatchersView.vue`
- [ ] `desktop/src/views/settings/SettingsView.vue` 导航项
- [ ] `desktop/src/router/index.ts` 路由
- [ ] `desktop/src/stores/inbox/index.ts` 白名单
- [ ] `desktop/src/components/inbox/InboxDrawer.vue` 图标映射
- [ ] `desktop/src/composables/useInboxSystemNotify.ts` 通知分支

### 管理后台 admin

- [ ] `admin/src/views/signal/SignalWatcherListView.vue`
- [ ] `admin/src/router/index.ts` 路由 + `signal:read`

### 文档

- [ ] `CHANGELOG.md` 新版本小节（backend-ts / desktop / admin 三条）
- [ ] `README.md` / `DEPLOY.md`：新增 `APP_SIGNAL_SECRET` 环境变量说明
- [ ] `skills/mao-cli/SKILL.md`：新增 signal-watchers 端点说明
- [ ] 提案状态改「已确认」并回链本方案；`docs/proposals/README.md` 加已确认标注

### 不做

- [ ] 非 HTTP 信号源 / 无头浏览器 / 多步探针链 / 阈值表达式 / 跨实例共享状态
- [ ] 管理员内网放行配置 / 会话绑定 / POST 体模板变量 / 触发统计图表 / 语义判重
- [ ] 排队终态回写 / 新 LLM 场景 / 阈值与频次上限可配

---

## 8. 测试要点

**调度**

- 到期哨兵被扫到并执行；未到期不执行；批量上限 50。
- 同一哨兵并发调度单飞（`inFlight` 去重，第二次扫描不叠加）。
- 重启后（新建 scheduler 实例）due 状态从 `last_checked_at` 恢复，不依赖内存态。
- `stop()` 后不再扫描，`dispatching` 防重入。

**判定**

- `HASH`：内容不变不触发、内容变化触发；首次（`last_value_hash` 空）只建基线不触发。
- `JSON_FIELD`：嵌套路径、数组下标取值正确；路径不存在/越界/取到 null/JSON 解析失败均记失败。
- `STATUS_CODE`：200→503 触发、503→503 不触发。
- 编辑 URL/方法/请求头/body/判定模式/路径后基线重置；只改名称/prompt/间隔/启停不重置。

**触发**

- prompt 渲染 `{url}`/`{name}`/`{diff}`；三种模式的 diff 文案口径；模板含 `$` 字符不被当分组引用。
- 触发产生会话且 `triggered_session_id` 回写；详情可跳转。
- 会话 busy 时入队不失败（`queued=true`），且不回写 `consecutive_failures`。
- 预算 BLOCK 时记失败并计连败（防超限哨兵无限重试），不绕过准入。
- Agent 停用 / 不存在时记失败。

**失败与退避**

- 超时 / 连接失败 / 超 1MB / 3xx 重定向 / JSON 解析失败均计 `consecutive_failures`。
- 退避推进 `interval * min(2^n, 32)`；成功后清零并恢复原间隔。
- 达 5 次 → `status='DISABLED'` + 收件箱 `WATCHER_DISABLED`；`PAUSED` 状态不被误改。
- DISABLED 后用户手动启用 → 失败清零 + 基线重置。

**安全**

- `assertProbeUrl` 拒 http/https 之外的协议、内嵌凭据、私网/环回/链路本地/组播/IPv6 字面量/.local/.internal。
- 请求头禁 `Host`/`Content-Length`/`Transfer-Encoding`；键数 > 20 拒绝；值含换行拒绝。
- 加密：`headers_json`/`body` 落库为密文；解密往返一致；密钥未配置抛 `INTERNAL_ERROR`。
- 回显：敏感键值打码；审计不含明文。
- 1MB 上限与双超时生效（对端挂起不卡死调度器，用假 server 单测）。

**频次上限**

- 同一哨兵 1 小时内第 5 次变化：照常触发，check 行 `warning='TRIGGER_RATE_LIMITED'`，`consecutive_failures` 不变。

**清理**

- `SignalCheckCleanup.cleanupOnce()` 按保留天数删；保留天数非正整数回落 90；分批上限生效。

**回归**

- 定时任务、开放 API、出站订阅、入站 Webhook 行为零改动（`session` 域 source 加成员后既有分支不受影响）。
- `llm_call` 统计口径不变（哨兵触发即普通 `scene=agent`）。
- 微信回调 URL 校验行为不变（`common/ssrf.ts` 抽取后原用例迁移通过）。

**前端**

- 桌面：CRUD 与启停；详情轮询记录分页；状态徽标（ACTIVE/PAUSED/DISABLED + 连续失败数）；敏感字段打码与「留空不修改」；数量达 20 时隐藏新建按钮。
- 管理后台：清单分页与筛选；无 `signal:read` 权限不可见。

---

## 9. 风险与开放问题

1. **DNS Rebinding 时间窗**：URL 校验时域名是公网的，`node:http` 真正连接时可能重解析到内网 IP。P1 不固定解析 IP（实现复杂度高），缓解为禁 IPv6 字面量 + 禁内嵌凭据 + 仅 http/https。若后续要收紧，做法是探针前自解析一次并对解析出的 IP 复跑 `isPrivateOrReservedHostname`。
2. **误触发风暴**：页面带时间戳/CSRF token 会让每轮都「变化」。缓解：HASH 模式提示优先对 API 端点使用；`JSON_FIELD` 提取稳定字段；`STATUS_CODE` 只看状态；频次超限打 warning 让用户在记录里看见抖动。不做静默期（提案未提，用户未决策，本次不加）。
3. **token 成本**：每次变化 = 一次完整 Agent 运行。缓解：预算准入照常 + 设置页明示 + 可停用。每小时 4 次上限是 warning 而非阻断（决策 7），极端情况下成本仍可能上升——这是用户已知晓并接受的取舍。
4. **凭据泄露**：`headers_json`/`body` 整体加密，但「整体加密」意味着知道任一字段即知全部；缓解靠密钥独立 + 审计不落 + 回显打码。
5. **探针带宽**：1MB 上限 × N 个哨兵 × 高频间隔仍可能吃带宽。缓解：流式超限即断（不全量进内存）、间隔下限钳制 1 分钟、每用户 20 个上限。
6. **单后端假设**：多实例部署时同一哨兵会被多个进程各扫一次（退避写在库里，实际会互相错开但仍有重复触发风险）。提案已列非目标，P1 接受。
7. **DISABLED 后的在途探针**：探针已在途时被并发置 DISABLED（极端时序），探针结果仍会回写 check 行与 `last_checked_at`，但不会触发（触发前复读状态）。表现为一条多余的轮询记录，无副作用。
8. **开放问题（本次未决策）**：是否需要「连续 N 小时无变化也通知一次确认哨兵还活着」（心跳通知）——未做，用户未提及。
9. **开放问题（本次未决策）**：哨兵的 prompt 模板是否支持引用会话历史（如「结合上次变化判断」）——不支持，因为每次新建会话、无历史可引。

---

## 10. 已确认决策摘要

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 触发来源标识 | 新增独立 `'SIGNAL'`，同步 `TaskNotifySource`/`MessageQueueSource`/`QueuedSource`/`InboxSource`/`liveExecution` 五处 |
| 2 | 探针执行器 | 新建专用 `signal/probe-client.ts`，不改 `fetch-bytes.ts`/`generic-webhook-sender.ts` |
| 3 | URL 协议与 SSRF | http/https 均可；复用 `isPrivateOrReservedHostname`；**不做管理员放行配置** |
| 4 | 凭据密钥 | 新增独立 `APP_SIGNAL_SECRET`（`SignalSecretCipher`） |
| 5 | 会话策略 | 每次触发新建会话，不支持绑定固定会话 |
| 6 | `{diff}` 口径 | 旧/新各截断 500 字；不做行级 diff |
| 7 | 触发频次上限 | 每小时 4 次；超出**照常触发**，仅在 check 行打 `TRIGGER_RATE_LIMITED` warning，不计失败 |
| 8 | 自动暂停阈值 | 5 次，与 `TRIGGER_DISABLE_AFTER_FAILURES` 对齐，不可配 |
| 9 | 编辑后基线 | 编辑判定相关字段（URL/方法/请求头/body/判定模式/路径）重置基线；其余编辑不重置 |
| 10 | 失败退避 | `interval * min(2^failures, 32)` 分钟，成功清零 |
| 11 | 轮询记录保留 | 系统设置 `signal.checkRetentionDays`，默认 90，滚动清理 |
| 12 | 删除级联 | 级联删 check 记录、保留会话、在途探针跑完不回写 |
| 13 | 管理后台范围 | 只读清单 + `signal:read`；统计图表不做 |
| 14 | 判定模式集合 | `HASH` / `JSON_FIELD` / `STATUS_CODE` 三种 |
| 15 | 归属范围 | 仅本人数据（CRUD 与查询按 `user_id` 过滤），不做共享 |

以上 15 条决策均于 2026-10-11 逐条与用户确认。
