# feedback — 消息点踩反馈

## 用途

用户对 Agent 任务执行结果不满意时点踩标记；管理员查看汇总统计与明细记录。

## 接口

### 用户端（需登录，操作本人会话内的消息）

| 方法 | 路径 | 说明 |
|------|------|------|
| PUT | `/feedback/messages/:messageId/dislike` | 提交/覆盖点踩，body `{"reason":"WRONG_RESULT\\|SLOW_RESPONSE\\|NOT_SOLVED\\|OTHER"}` |
| DELETE | `/feedback/messages/:messageId/dislike` | 取消点踩 |
| GET | `/feedback/messages/disliked-ids?sessionId=` | 当前用户该会话内已点踩的消息 ID 列表，返回 `{ids:number[]}` |

校验：消息须存在、role=ASSISTANT、所属会话属于当前用户；非本人消息返回 code 3031，消息不存在返回 3030，无效原因返回 2001。每条消息最多 1 条点踩记录，重复 PUT 覆盖原因。

**点踩来源（`source`）**：`desktop`（桌面/Web/安卓端，默认）/ `feishu`（飞书任务完成卡片点踩按钮）。存量记录均为 `desktop`。

**飞书专属原因 `NO_REASON`**：飞书进度卡点踩不弹原因选项，固定写入 `NO_REASON`，后台展示为「未选择原因（飞书）」。服务端放行该值，桌面端原因选项列表不含它。

**飞书点踩按卡归属**：飞书点踩记录落在**被点那张完成卡对应的** ASSISTANT 消息上（不再固定取会话最后一条）——卡片身份取自回调事件的 `open_message_id`，经 `feishu_card_snapshot` 快照表解析到该卡终态时刻的最后一条 ASSISTANT 消息；同一张卡重复点击即 toggle 该消息的记录，点旧卡不影响最新消息的反馈记录与其它卡片。卡片重绘按「内存按卡句柄 → 持久化快照重建 → 会话级兜底」三级降级，兜底仅命中改造前发出的存量卡（无快照行）。被点卡片对应的消息已被清理时，与桌面端口径一致返回「未找到可反馈的任务结果」。桌面/Web/安卓端点踩链路（按 messageId）不变。

### 管理端（需 `feedback:read`，默认仅系统管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/feedback/admin/summary?startDate=&endDate=` | 汇总：`{total, byReason:[{reason,label,count}], byDay:[{date,count}], pendingCount, pendingMatrix:[{agentId,agentName,reason,reasonLabel,count}]}`；日期可选。`pendingCount` 为待处理数（`status=PENDING`，不带日期筛选），`pendingMatrix` 为 Agent × 原因的待处理矩阵（按 `agent_id` 快照口径分组，`agentId` 为 null 即飞书点踩的无 Agent 行） |
| GET | `/feedback/admin/list?reason=&status=&agentId=&startDate=&endDate=&page=&pageSize=` | 分页明细：`{total, items[]}`，单条含 `createdAt/userId/username/displayName/sessionId/agentId/agentName/reason/reasonLabel/source/status/handledBy/handledByName/handledAt/experienceId/sameGroupCount/contentPreview`；`contentPreview` 为消息内容前 100 字摘要（已剥离内部标记），消息已删除时为 null。`source` 为点踩来源：`desktop` / `feishu`。`status` 为处理态：`PENDING` / `CONVERTED` / `DISMISSED`（后两者为终态）；`sameGroupCount` 为同 Agent 同原因的待处理条数（聚集口径）；`agentId` 传具体 id 筛选，缺省不筛选 |

原因筛选项可用值：`WRONG_RESULT` / `SLOW_RESPONSE` / `NOT_SOLVED` / `OTHER` / `NO_REASON`（飞书）。

### 管理端写入（需 `feedback:write`，默认仅系统管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | `/feedback/admin/dismiss` | body `{feedbackIds:number[]}` → `{updated}`。批量忽略，全或无：混入已处理行时整体失败并回滚 |

失败口径：反馈 ID 无效 / 超 100 条上限均返回 2001；反馈已被他人处理返回 3046，前端统一提示「该反馈已被处理，请刷新后重试」。dismiss 无独立的存在性预校验，走纯 CAS，「不存在」与「已处理」都归 3046。

> 「转经验」功能（`draft` / `convert` 端点与管理后台「转为经验」向导）已下线；`status='CONVERTED'` 与 `experience_id` 仅为存量数据，不再产生新行。

## 数据表

`message_feedback`（V123 迁移，V125 加 `source` 列，V148 加处理态四列）：`message_id` 唯一键，冗余 `session_id/user_id/agent_id` 便于统计；`source` 标识点踩来源（`desktop` / `feishu`）；`status`（`PENDING` / `CONVERTED` / `DISMISSED`，后两者为终态；`CONVERTED` 是已下线的转经验功能留下的存量状态）、`handled_by`、`handled_at`、`experience_id` 记录处理结果，存量行由列默认值回填为 `PENDING`。

`feishu_card_snapshot`（V161 迁移）：飞书完成卡终态快照，一行一张 COMPLETED 卡（`card_message_id` 唯一），记录该卡对应的 ASSISTANT `message_id` 与终态 `round` / `elapsed_ms` / `content`（与卡片同口径）。服务于飞书点踩的按卡归属与快照重建：进程重启或点旧完成卡时据此重绘完整卡片；无快照行的存量卡点击走会话级兜底。

## 示例

```bash
mao-cli http put /v1/feedback/messages/123/dislike --data '{"reason":"WRONG_RESULT"}'
mao-cli http get "/v1/feedback/admin/summary?startDate=2026-09-01&endDate=2026-09-27"
mao-cli http get "/v1/feedback/admin/list?status=PENDING&agentId=9"
mao-cli http post /v1/feedback/admin/dismiss --data '{"feedbackIds":[3]}'
```
