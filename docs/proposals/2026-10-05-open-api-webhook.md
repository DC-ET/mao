# 提案：开放 API —— API Token、入站 Webhook 触发器、出站事件订阅

- 状态：已转入实施（技术方案见 [docs/plan/2026-10-05-open-api-webhook-technical-design.md](../plan/2026-10-05-open-api-webhook-technical-design.md)，其中 §10 含对本文的确认与细化）
- 日期：2026-10-05
- 提案总览：见 `docs/proposals/README.md`
- 出处：roadmap phase-4 遗留"开放 API / SDK"；本文收窄为"让外部系统能驱动 Agent"的最小闭环

## 1. 背景与现状

外部系统今天想"找 mao 的 Agent 干活"，只有三条路：IM 渠道（人来发消息）、定时任务（时间驱动）、embed SDK（页面内挂件，且页面动作绑定宿主页面）。**机器到机器的触发是缺失的**：CI 失败想让 Agent 分析日志、监控告警想让 Agent 定位问题、Git 推送想让 Agent 写周报——都接不进来。

可复用的积木已经齐了：schedule 域验证了"会话忙则 messageQueue 排队、终态写收件箱"的异步执行骨架；task-completion webhook 通知（`docs/plan/2026-07-13-task-completion-webhook-notification-design.md`）已有出站 webhook 雏形；权限目录（2026-09-24 设计）与审计拦截器（覆盖 /v1/**，排除 auth/ws）可直接复用。

## 2. 目标 / 非目标

**目标**

1. 用户可在设置页签发个人 API Token（scope 化、可吊销、有期限），以"机器身份"调用 REST 触发 Agent。
2. 入站 Webhook：每个触发器一个带 HMAC 签名校验的 URL，外部系统 POST 即让指定 Agent 跑一轮。
3. 出站事件订阅：把现有"任务完成 webhook"泛化为可配置事件订阅（完成 / 失败 / 提问待答）。

**非目标**

- 不做对外 SaaS 开放平台、不做第三方开发者生态（定位是自托管内的机器集成）。
- 不做同步对话式 API（触发即返回，结果走会话 / 收件箱 / 回调；同步流式已由 WS 覆盖）。
- 不动 embed SDK（页面场景已自洽）。

## 3. 技术方案

### 3.1 API Token 与 REST 触发（P1）

- 表 `api_token`（id, user_id, name, token_prefix, token_hash SHA-256, scopes JSON, expires_at, revoked_at, last_used_at）。明文只在签发时返回一次。
- 鉴权中间件：解析 Bearer → 换出用户 → 走现有 `@RequirePermission` 与审计链路；scope 与权限目录 code 对齐（如 `session:write`）。
- 触发端点：`POST /api/v1/open/agents/:agentId/run`（body: message, sessionId?）→ 异步触发一轮执行（会话忙则排队），返回 sessionId + messageId，结果走会话 REST 或收件箱。
- 设置页新增"API Token"分区（签发 / 列表 / 吊销）；限流：每 token 固定窗口计数（内存 + 定期落库即可）。

### 3.2 入站 Webhook 触发器（P2）

- 表 `webhook_trigger`（id, user_id, agent_id, session_id NULL=每次新会话, secret, enabled, last_fired_at）；固定路由 `POST /api/v1/open/hooks/:triggerId`。
- 请求处理：HMAC-SHA256 签名校验（header `X-Mao-Signature`，附时间戳 ±5 分钟容差防重放）→ payload 映射为用户消息（P2 先用 JSON 原文截断，模板化放 P3）→ 复用 schedule 执行骨架（忙则排队；source=WEBHOOK）→ 202 返回 sessionId / messageId。
- 结果去向：终态写收件箱（与定时任务同路）；session 固定时外部系统可轮询会话 REST，或订阅出站事件（3.3）。

### 3.3 出站事件订阅（P3）

- 表 `outbound_subscription`（id, user_id, event ENUM('task.completed','task.failed','question.pending'), target_url, secret, enabled）。
- 把 2026-07-13 的 task-completion webhook 泛化：taskTerminal 现有出站点改为查订阅表分发；HMAC 签名 + 指数退避重试 3 次；投递失败写审计。

## 4. 治理

- `/api/v1/open/**` 全部走现有审计拦截器（记录 token id 与触发器 id）；用量自然进入 usage 域按 user 聚合。
- 触发器默认停用、每用户上限 20 个；token 默认 90 天过期，吊销即时生效。
- 成本防护：触发执行沿用会话级预算配置；触发器连续失败自动停用并写收件箱通知。

## 5. 分阶段实施

| 阶段 | 内容 | 规模 |
|---|---|---|
| P1 | api_token 表 + 鉴权中间件 + 设置页管理 + REST 触发端点 | 中 |
| P2 | webhook_trigger + 签名校验 + source=WEBHOOK 落收件箱 | 中 |
| P3 | 出站事件订阅泛化 + 重试退避 + 触发器消息模板 | 小~中 |

## 6. 风险与开放问题

- **滥用与成本**：token 泄露即预算泄露。缓解：scope 最小化、限流、审计、吊销即时生效；token 与触发器签发后均为停用态、需显式启用。
- **重放攻击**：HMAC + 时间戳容差；触发器 URL 不可枚举（id + 随机后缀）。
- **与 IM 渠道的关系**：三渠道面向"人"，本提案面向"系统"；共用入站队列与终态投递骨架，不新增并行机制。
- **开放问题**：payload 模板的最小表达（自由文本 vs 简单字段映射）；触发器是否允许覆盖 Agent 的 skill 集（倾向不允许，跟随 Agent 配置）。

## 7. 测试要点

- Token：hash 存储（库中无明文）、过期/吊销即时生效、scope 越权拒绝、限流触发。
- Webhook：签名正确 / 错误 / 过期时间戳、payload 超长截断、忙时排队、终态收件箱 source=WEBHOOK。
- 出站：签名、重试退避、订阅禁用不投递。
- 触发器连续失败自动停用的通知链路。
