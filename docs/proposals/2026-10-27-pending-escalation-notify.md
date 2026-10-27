# 提案：人走开了任务也不卡死 —— 待办「未响应升级」通知与会话级通知开关

> Agent 最常卡住的两个地方是「等审批」和「等回答」。今天的 IM / 邮件提醒只在「用户不在线」时才发，而判断「在线」看的是 WS 连接——桌面端开着、人去开会了，就算在线。于是审批静静地挂 15 分钟后超时，任务带着一条 timeout 错误继续或失败；用户回来看到的是一个白跑的任务。

- 状态：**已确认**（2026-10-27：P2 会话级通知开关、P3 收尾体验驳回；只做未响应升级。技术方案见 [../plan/2026-10-27-pending-escalation-notify-technical-design.md](../plan/2026-10-27-pending-escalation-notify-technical-design.md)，决策 D1–D6）
- 日期：2026-10-27
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小（固定 3 分钟、零迁移、仅后端；原 P2/P3 不做）
- 关联：`backend-ts/src/notification/task/`、`backend-ts/src/harness/local/local-tool-executor.ts`、`backend-ts/src/harness/tool/tool-dispatcher.ts`

> 评审结论以技术方案为准。下文 P2 / P3 与「延迟可调 1～10」保留作提案原文，不再实施。

## 1. 背景与现状

### 1.1 三类「需要人」的时刻，外推覆盖不一致（代码可查）

| 时刻 | 收件箱 | IM / 邮件外推 | 外推条件 | 证据 |
|---|---|---|---|---|
| 任务完成 / 失败 | 有 | 有 | 先等 WS 送达，送达即抑制（`SUPPRESSED_WS`），否则发 | `delivery.service.ts` `prepare` + `resolveWebSocket` |
| 提问等待（ask_user_questions） | 有 | 有 | **仅当用户不在线**且未挂飞书表单；作答后抑制 | `tool-dispatcher.ts:464-474`（`!userOnline && !formMounted`） |
| **本地工具审批等待** | 有 | **无** | —— | `local-tool-executor.ts:55` 只调 `recordApprovalPending`；`TaskNotificationPhase` 只有 `COMPLETED / FAILED / ASK_USER` |

### 1.2 「在线」不等于「人在」

- 审批只发生在 LOCAL 执行，而 LOCAL 执行的前提就是桌面端已连接（`local-tool-executor.ts:32` 未连接直接报错）。也就是说**审批发生时用户按定义总是「在线」**，即使给审批补一个「离线才推」的分支也永远不会触发。
- 提问同理：桌面端常驻（0.0.351 起还有托盘与开机自启），`userOnline` 几乎恒为 true，离线提醒形同虚设。
- 审批等待上限 `localToolTimeoutSeconds = 900`（`app-config.ts:246`）。超时后工具返回 `Local tool execution timed out`，Agent 要么换路子绕过、要么失败收尾——都不是用户想要的。

### 1.3 通知偏好只有一个全局开关

`TaskNotificationPreference` 只有 `enabled + channel + webhook`（`shared/contracts/src/notification.ts`）。现实中的两种诉求都无法表达：

- 「这个跑两小时的迁移任务，完成了一定要推我手机」——但桌面开着，完成通知会被 WS 抑制。
- 「这个每 10 分钟跑一次的定时任务别再推我了」——只能全局关掉，连同其他重要任务一起静音。

### 1.4 一个真实场景

用户下午 2 点让 Agent 在本机整理一个仓库，权限档位是「需审批」。2:10 Agent 要执行 `rm -rf build/`，弹出审批；用户 2:05 已经去会议室。桌面端开着，系统通知弹在了没人看的屏幕上。2:25 审批超时，Agent 判定「无权限清理」，跳过后续步骤并以「部分完成」收尾。3 点用户回来，得到一个需要从头再跑的任务。手机上的飞书全程没有任何动静。

## 2. 目标 / 非目标

**目标**

1. **P1 未响应升级**：审批与提问在 **N 分钟内无人处理**（默认 3 分钟，用户可调 1~10）时，不论 WS 在线与否，经既有任务通知渠道（飞书 / 钉钉 / 邮件）推一条「等你处理」提醒；处理后 / 超时后自动抑制未发出的行。审批纳入通知相位（`APPROVAL`）。
2. **P2 会话级通知开关**：会话头部铃铛三态——**跟随全局 / 必达（完成与失败无视 WS 抑制）/ 静音（本会话一律不外推）**。定时任务与哨兵触发的会话同样适用（静音对「刷屏型」自动化最有用）。
3. **P3 收尾体验**：升级通知卡片带「剩余等待时间」与深链（直达会话并定位到审批 / 提问面板）；审批超时后在会话中留一条可见标记「审批在你离开时超时」，并给出「重试本轮」按钮（复用既有 `retryExecution`）。

**非目标**

- **不做 IM 内远程审批**（飞书卡片按钮直接批准本地命令）：LOCAL 审批批准的是「在用户本机执行命令」，远程一键批准的安全面需单独评审；本提案只负责把人叫回来。
- 不新增通知渠道、不新增收件箱 kind（`APPROVAL_PENDING` / `QUESTION_PENDING` 已有）。
- 不改审批超时时长与审批语义。
- 不做安卓系统推送（既定排除方向）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 渠道人工接管（2026-10-11 否决） | 那是「把会话交给另一个真人」；本提案只是提醒会话主人本人回来处理。 |
| 计划模式（2026-10-09 否决） | 不新增任何执行前门，只补既有审批门的通知。 |
| 安卓原生推送（排除） | 只走既有飞书 / 钉钉 / 邮件 Webhook 投递链路。 |
| 邮件通知渠道（已实施） | 复用其渠道，不改渠道本身。 |

## 4. 方案

### 4.1 P1 未响应升级（零迁移）

- `TaskNotificationPhase` 加 `APPROVAL`（`notification/task/types.ts` + 飞书卡片模板 `feishu-notification-card.ts` 加一行配色与文案「⏳ 等待你的审批」）。
- 新增 `prepareEscalation(kind, sessionId, userId, requestId, title, delayMinutes)`：直接写 `PENDING` 行，`nextRetryAt = now + delay`——**延迟发送由既有调度器天然承担**（调度器本来就只扫 `nextRetryAt <= now` 的行），不新增定时器。
- 挂点：
  - 审批：`local-tool-executor.ts` 注册审批后调用；`finally`（批准 / 拒绝 / 超时 / 断连统一收敛点）调既有 `suppressPending`。
  - 提问：`tool-dispatcher.ts` 现有「离线才推」分支改为「离线立即推；在线则按升级延迟推」，作答后同样 `suppressPending`。已挂飞书表单时维持不推。
- `eventKey` 沿用 `ask-user:{sid}:{rid}` 形态，审批用 `approval:{sid}:{rid}`，天然幂等。
- 延迟配置：`TaskNotificationPreference` 加 `escalationMinutes`（存在既有偏好表上，若该表无此列则放 P2 迁移一并加；P1 先读实例默认值 3）。

### 4.2 P2 会话级通知开关（一个迁移）

- 迁移 `V175__session_notify_mode.sql`：`session.notify_mode VARCHAR(16) NULL`（NULL = 跟随全局；`ALWAYS` / `MUTED`）。
- `delivery.service.ts`：
  - `prepare`：`MUTED` 直接返回 null；`ALWAYS` 写 `PENDING` 而非 `WAITING_WS`（跳过 WS 抑制）。
  - `prepareEscalation`：`MUTED` 返回 null。
  - 全局未启用时 `ALWAYS` 也不生效（无渠道可发），前端铃铛给出「先在设置里配置通知渠道」引导。
- REST：`PATCH /v1/sessions/:id` 允许 `notifyMode`（owner 校验沿用既有会话更新）。
- 前端：会话头部铃铛（三态图标 + 下拉），任务列表右键菜单同款入口；定时任务 / 哨兵会话在面板上显示静音标记。
- `notifyMode` 契约下沉 `@mao/contracts` 的 `session.ts`，前端文案用 `Record<SessionNotifyMode, string>` 吃穷尽。

### 4.3 P3 收尾体验

- 升级卡片：标题 + 「已等待 3 分钟，约 12 分钟后超时」+ 深链 `/?session={id}&focus=approval`（桌面路由已有按会话定位能力，补一个 focus 参数打开审批 / 提问面板）。
- 审批超时标记：`failPending` 时向会话写一条系统事件（不进模型上下文，仅渲染），文案「审批在等待 15 分钟后超时」，旁附「重试本轮」。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | notification/task（相位、prepareEscalation、notify_mode 判断）、local-tool-executor、tool-dispatcher 一处分支、session 更新字段、V175 |
| desktop | 会话头部铃铛、右键菜单、通知设置页加「无人处理 N 分钟后提醒」、深链 focus、超时标记渲染 |
| contracts | `TaskNotificationPhase`（如已下沉）、`SessionNotifyMode` |
| admin / mao-cli | admin 通知投递记录的相位筛选加 `APPROVAL`；mao-cli `session update --notify-mode` |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 用户其实在桌面前，只是想几秒，被推一条多余提醒 | 默认 3 分钟延迟 + 处理即抑制；可调到 10 分钟或关闭升级 |
| 调度器已 claim 成 SENDING 时用户刚好批准 | 复用 `suppressPending` 的 SENDING 兜底 CAS（已有测试覆盖的竞态口径） |
| `ALWAYS` 与 Electron 原生通知重复 | 预期行为：用户显式要求「必达」；文案标明 |
| 审批卡片泄露命令内容 | 卡片只带会话标题与「有一条本地操作待审批」，不带命令与参数 |

## 7. 测试要点

1. 审批注册后 N 分钟未处理 → 产生 `APPROVAL` 投递；N 分钟内批准 / 拒绝 → 行被抑制且不发。
2. 提问在线场景按延迟推、离线场景立即推、挂飞书表单不推三分支各一例。
3. `MUTED` 会话完成 / 失败 / 审批 / 提问全部不产生投递行；`ALWAYS` 会话 WS 送达后仍发送。
4. 调度器 claim 与用户处理并发时不重复发送（SENDING CAS 回归）。
5. 子代理会话、微信会话维持既有跳过逻辑不变。

## 8. 决策（2026-10-27 已确认）

1. **延迟固定 3 分钟**，不可调。不单独提供「关闭升级」：任务通知总开关关闭则升级不写。
2. **提问与审批一起做**。离线提问仍立即推，在线提问改为 3 分钟后推。
3. **P2 驳回**（含「仅失败通知」第四态）。不做会话级必达 / 静音。
4. **P3 驳回**。不做超时标记、剩余时间、focus 深链、重试按钮。
