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

### 管理端（需 `feedback:read`，默认仅系统管理员）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/feedback/admin/summary?startDate=&endDate=` | 汇总：`{total, byReason:[{reason,label,count}], byDay:[{date,count}]}`；日期可选 |
| GET | `/feedback/admin/list?reason=&startDate=&endDate=&page=&pageSize=` | 分页明细：`{total, items[]}`，单条含 `createdAt/userId/username/displayName/sessionId/agentId/agentName/reason/reasonLabel/contentPreview`；`contentPreview` 为消息内容前 100 字摘要（已剥离内部标记），消息已删除时为 null |

## 数据表

`message_feedback`（V123 迁移）：`message_id` 唯一键，冗余 `session_id/user_id/agent_id` 便于统计。

## 示例

```bash
mao-cli http put /v1/feedback/messages/123/dislike --data '{"reason":"WRONG_RESULT"}'
mao-cli http get "/v1/feedback/admin/summary?startDate=2026-09-01&endDate=2026-09-27"
```
