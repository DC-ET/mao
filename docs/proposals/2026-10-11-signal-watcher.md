# 提案：信号哨兵（Signal Watcher）—— 让外部世界的变化自己来敲门

- 状态：**已确认**（2026-10-11 评审通过，技术方案见 [../plan/2026-10-11-signal-watcher-technical-design.md](../plan/2026-10-11-signal-watcher-technical-design.md)，决策记录 15 条于 2026-10-11 逐条确认）
- 日期：2026-10-11
- 提案总览：见 `docs/proposals/README.md`

## 1. 背景与现状

今天 Agent 的启动方式有五个：人手动发消息、定时任务（cron）、开放 API 被外部调用、入站 Webhook 被外部推送、渠道入站（飞书 / 钉钉 / 微信有人说话）。前三个是"时间到了"或"有人叫"，后两个是"外部系统 / 人主动推了一把"。

**缺的是第六种：条件满足了。** 具体说：

1. **轮询类需求只能靠 cron 硬扫**。想看"竞品官网更新了没""这个 PR 有没有人 review""库存低于阈值了没"，今天的做法是建一个每分钟 / 每小时的定时任务，让 Agent 每次都跑一遍、自己判断"有没有变化"。绝大多数轮次答案是"没变化"——白烧 token 与模型额度，而且真正的变化发生时还要等下一个 cron tick 才发现。
2. **Webhook 是被动的、要对方配合**。入站 Webhook（`openapi` 域）要求外部系统**主动推送**到 Mao。现实里大量系统（ GitHub、Jira、监控平台、自建系统）要么推送配置麻烦，要么根本不支持推送，只能拉取。对这些源，Mao 今天没有"我帮你盯着"的能力。
3. **开放 API 是"人来调"，不是"变化来调"**。`POST /v1/open/agents/:id/run` 需要外部系统主动决策"现在该叫 Agent 了"。而"什么时候该叫"这个判断本身，恰恰是最适合自动化、也最耗人的部分。

相邻方向的边界：

- **不是定时任务**：定时任务是"时间维度"（cron 到点就跑，不看世界）；哨兵是"条件维度"（轮询外部信号，**只在变化时**触发）。哨兵触发后仍可复用定时任务的执行与通知链路。
- **不是出站 Webhook**（已实施）：那是 Mao 往外推（任务完成 → 你的 HTTPS 端点）；哨兵是**往里拉**（外部 HTTP 状态 → Mao）。方向相反，互补。
- **不是 RAG / 知识库**（已否决）：哨兵不做语料检索，只看"信号值变没变"。
- **不是监控告警系统**（Zabbix / Prometheus）：不采集指标、不做时序存储与阈值告警面板；哨兵的输出是"触发一次 Agent 运行"，把"变化该怎么处理"交给 Agent，而不是自己当监控系统。

## 2. 目标 / 非目标

**目标**

1. **信号定义**：用户可建"哨兵"——一个 HTTP 探针（URL + 方法 + 请求头 + 轮询间隔）+ 一个**变化判定**（内容哈希 / JSON 字段提取后比对 / 状态码变化），加上"变化时执行什么"（目标 Agent + prompt 模板，支持把变化内容作为上下文注入）。
2. **变化即触发**：轮询到判定值变化时，按目标 Agent 发起一次运行（复用开放 API 的投递链路：会话忙时排队），prompt 模板里带上变化摘要（旧值 → 新值，或差异片段）。
3. **静默期与防抖**：无变化不触发、不调 LLM；连续失败按指数退避并累计，达阈值自动暂停哨兵并通知（对齐 Webhook 触发器"连续失败自动停用并通知"的既有交互）。
4. **可观测**：每次轮询留记录（时间、判定值哈希、是否变化、HTTP 状态、耗时），哨兵卡片展示最近 N 次轮询与触发历史；触发产生的会话可从哨兵详情跳转。
5. **安全基线**：URL 限制 http/https + 超时 + 大小上限（对齐出站投递与入站抓取的既有约束）；凭据类请求头加密存储（对齐 MCP env 与开放接口密钥的加密口径）；SSRF 防护（禁止内网 / 环回地址段，除管理员显式放行——评审定）。

**非目标**

- 不做非 HTTP 信号源（数据库变更、消息队列消费、文件系统 watch）——P1 只做 HTTP 探针，覆盖面已够（绝大多数外部系统有 HTTP 面）。
- 不做页面渲染 / JS 执行后的内容抓取（无头浏览器）——探针拿的是原始 HTTP 响应体。
- 不做多步探针链（先 A 再依赖 A 的结果请求 B）。
- 不做阈值型监控（"CPU > 80% 报警"）——哨兵看"变没变"，不看"高不高"；阈值型是变化判定的一个特例，P1 只提供"与上次比对"，不提供常量阈值表达式。
- 不做跨实例共享轮询状态（单后端部署，进程内调度即可）。

## 3. 技术方案

### 3.1 数据模型（迁移号顺延，当前已到 V147）

```sql
CREATE TABLE IF NOT EXISTS `signal_watcher` (
    `id`              BIGINT PRIMARY KEY AUTO_INCREMENT,
    `user_id`         BIGINT NOT NULL COMMENT '属主',
    `agent_id`        BIGINT NOT NULL COMMENT '变化时运行的目标 Agent',
    `name`            VARCHAR(128) NOT NULL COMMENT '哨兵名称',
    `url`             VARCHAR(1024) NOT NULL COMMENT '探针 URL（http/https）',
    `method`          VARCHAR(8) NOT NULL DEFAULT 'GET' COMMENT 'GET/POST',
    `headers_json`    TEXT NULL COMMENT '请求头（敏感值加密存储，脱敏回显）',
    `body`            TEXT NULL COMMENT 'POST 体（可含敏感值，加密存储）',
    `interval_minutes` INT NOT NULL DEFAULT 15 COMMENT '轮询间隔（分钟），钳制 1..1440',
    `compare_mode`    VARCHAR(16) NOT NULL DEFAULT 'HASH' COMMENT 'HASH 内容哈希 / JSON_FIELD 字段提取',
    `json_path`       VARCHAR(255) NULL COMMENT 'compare_mode=JSON_FIELD 时的提取路径',
    `prompt_template` VARCHAR(2000) NOT NULL COMMENT '变化时发给 Agent 的提示词，支持 {diff} {url} {name} 占位',
    `status`          VARCHAR(16) NOT NULL DEFAULT 'ACTIVE' COMMENT 'ACTIVE / PAUSED / DISABLED',
    `last_value_hash` VARCHAR(64) NULL COMMENT '上次判定值哈希',
    `last_checked_at` DATETIME NULL,
    `last_changed_at` DATETIME NULL,
    `consecutive_failures` INT NOT NULL DEFAULT 0,
    `created_at`      DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`      DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_watcher_due` (`status`, `last_checked_at`),
    INDEX `idx_watcher_user` (`user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='信号哨兵：HTTP 探针变化触发 Agent';

CREATE TABLE IF NOT EXISTS `signal_watcher_check` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `watcher_id`  BIGINT NOT NULL,
    `checked_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `http_status` INT NULL,
    `value_hash`  VARCHAR(64) NULL COMMENT '本次判定值哈希，与 watcher.last_value_hash 比对',
    `changed`     TINYINT NOT NULL DEFAULT 0,
    `triggered_session_id` BIGINT NULL COMMENT '变化触发时产生的会话',
    `error`       VARCHAR(500) NULL COMMENT '失败原因（截断）',
    `duration_ms` INT NULL,
    INDEX `idx_check_watcher` (`watcher_id`, `checked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='信号哨兵轮询记录';
```

敏感字段（`headers_json` / `body`）复用 `crypto` 域既有 AES-GCM 加密（与 `api_token.token_cipher`、MCP env 同口径），列表与详情回显时密钥类头打码。

### 3.2 轮询调度器

新增 `src/signal/watcher-scheduler.ts`，结构对齐既有 `InboxCleanupScheduler` / `WebhookDeliveryScheduler`（start/stop + interval）：

- 每 30 秒扫一次 `status='ACTIVE' AND (last_checked_at IS NULL OR last_checked_at < NOW() - interval_minutes)` 的哨兵（索引 `idx_watcher_due` 覆盖）。
- 探针执行：http/https、连接 10s / 读取 15s 双超时、响应体上限 1MB（超限即断，与 `fetch-bytes.ts` 对齐）、禁重定向（对齐出站投递口径）。
- 判定：`HASH` 模式取响应体 SHA-256；`JSON_FIELD` 模式解析 JSON 后按 `json_path`（点分路径，如 `data.items.0.price`）取值再哈希。解析失败记为该次失败。
- **进程内单飞**：同一 watcher 同时只有一个在途探针（Map + in-flight 标记），调度重叠不叠加；重启后从库里恢复 due 状态（无内存态依赖）。
- 失败退避：连续失败 `consecutive_failures` +1，下次检查时间按 `interval * min(2^failures, 32)` 推远；达阈值（默认 10，可配）→ `status='DISABLED'` + 收件箱通知（新 kind `WATCHER_DISABLED`，对齐 `TRIGGER_DISABLED`）；成功后计数清零。

### 3.3 触发执行

- 判定值变化时：`prompt_template` 渲染（`{url}` / `{name}` / `{diff}`，`{diff}` 为"旧值摘要 → 新值摘要"，HASH 模式下为哈希变化 + 响应体前后差异片段截断，JSON_FIELD 模式下为旧值 → 新值原文），经 `open-run.service.ts` 同款投递链路发起运行（可选 `sessionId` 复用会话；会话忙自动入队）。
- 触发调用走**正常 Agent 运行**：计 `llm_call`、受预算准入（BLOCK 时记失败并通知，不特殊绕过）、写 `signal_watcher_check.triggered_session_id`。
- 首轮特殊处理：`last_value_hash` 为空（新哨兵首次轮询）时**只记录不触发**——第一次拿到的值是基线，不是"变化"。

### 3.4 前端与管理后台

- 设置页「信号哨兵」卡片（与开放接口并列）：列表（名称 / URL / 间隔 / 状态 / 上次变化时间 / 连续失败）、新建 / 编辑 / 启停 / 删除、详情（最近轮询记录 + 触发历史 + 跳转会话）。
- 管理后台：全量哨兵清单 + 触发统计（按天 / 按 Agent），复用开放接口调用中心的统计模式；`signal:read` 只读权限。

### 3.5 权限

- 用户级 CRUD：`/v1/signal-watchers`（登录态，本人数据）；启停 / 删除同组。
- 触发链路不新增开放暴露面（触发是内部行为，不是新入站端点）。
- 管理侧：`signal:read`（清单 + 统计）。

## 4. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | 两表 + 调度器（HASH 模式）+ 触发投递 + 设置页哨兵管理（CRUD + 详情） | 中 |
| P2 | JSON_FIELD 模式 + `{diff}` 摘要（HASH 模式的差异片段）+ 失败退避与自动暂停通知 | 小~中 |
| P3 | 管理后台统计页 + POST 探针体模板变量 + SSRF 放行配置 | 小 |

## 5. 风险与开放问题

- **轮询放大**：N 个哨兵 × 每 15 分钟 = 外部请求量可控，但探针响应体 1MB 上限仍可能吃带宽。缓解：HASH 模式流式计算不落盘；大小上限硬断；间隔下限钳制 1 分钟。
- **SSRF 面**：用户配 URL 就能让服务端发请求——可探测内网服务、打云元数据端点（169.254.169.254）。缓解：默认禁止环回 / 链路本地 / 私网段（RFC1918）+ 云元数据 IP；管理员可显式放行内网段（系统设置，审计留痕）。P1 必须有这条基线，不做可选项。
- **误触发风暴**：判定值抖动（页面带时间戳 / CSRF token / 随机数）会让每次轮询都"变化"。缓解：HASH 模式提示用户优先对 API 端点使用；JSON_FIELD 模式正是为此而生（提取稳定字段）；触发频次上限（同一哨兵每小时最多触发 N 次，默认 4，超出记失败不触发）。
- **token 成本**：每次触发就是一次完整 Agent 运行。缓解：触发前预算准入照常；设置页明示"每次变化 = 一次 Agent 运行，会计入用量"；哨兵可停用。
- **凭据泄露**：请求头里的 Bearer token 若明文落库 / 回显即泄露。缓解：加密存储 + 回显打码（对齐 MCP env 脱敏口径），审计不记录明文。
- **开放问题**：哨兵属主删除 / 停用时，在途轮询与已触发未完成的会话怎么处理——建议在途探针跑完不回写、触发照常完成（不杀在途执行），删除哨兵只删定义与记录、不级联删会话。
- **开放问题**：是否需要"变化摘要的 LLM 判重"（两次变化其实说的是同一件事，避免重复触发 Agent）——P1 用哈希精确比对不做语义判重，P3 评估。

## 6. 测试要点

- 调度：到期哨兵被扫到并执行；未到期不执行；同一哨兵并发调度单飞；重启后 due 状态恢复。
- 判定：HASH 模式内容不变不触发、内容变化触发；JSON_FIELD 提取路径正确（嵌套 / 数组下标）、提取失败记失败；首次轮询只建基线不触发。
- 触发：prompt 模板占位渲染正确（`{url}` / `{name}` / `{diff}`）；触发产生会话且可从详情跳转；会话忙时入队不失败；预算 BLOCK 时记失败并通知、不绕过。
- 失败与退避：HTTP 超时 / 非 2xx / 解析失败累计 `consecutive_failures`；退避下次检查时间正确；达阈值自动 DISABLED + 收件箱 kind `WATCHER_DISABLED`；成功清零。
- 安全：环回 / 私网 / 云元数据 IP 被拒（默认策略）；超时与 1MB 上限生效（对端挂起不卡死调度器）；请求头凭据回显打码、库内加密、审计无明文。
- 频次上限：同一哨兵 1 小时内第 5 次变化不触发且记失败原因。
- 前端：CRUD 与启停；详情轮询记录分页；状态徽标（ACTIVE / PAUSED / DISABLED + 连续失败数）。
- 回归：定时任务、开放 API、出站订阅行为零改动；`llm_call` 用量统计口径不受影响（哨兵触发就是普通 scene=agent 调用）。
