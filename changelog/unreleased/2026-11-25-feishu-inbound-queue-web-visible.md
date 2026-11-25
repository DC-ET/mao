### 后端

- **web 端可见飞书排队队列**：新增 `GET /v1/sessions/:id/inbound-queue`（只读列表）与 `DELETE /v1/sessions/:id/inbound-queue/:queueId`（本人取消，同步 PATCH 飞书排队卡片为「已取消」），并新增 `inbound_queue_updated` 推送事件。
- **飞书排队卡片文案**：改为「已进入飞书队列（第 N 位）」；存在本地排队消息时附加「另有 M 条本地排队消息将在其后执行」。
- **排队展示列**：`feishu_inbound_queue` 新增 `summary` / `sender_label` / `image_count` / `file_count` 列（V210），web 面板读取不再解析 MEDIUMTEXT payload；存量行读时按 payload 回退。

### 前端（桌面 / Web / 安卓）

- **待发送面板展示飞书排队**：本地排队与飞书排队分组展示并标注「下一组」；飞书项支持「取消排队」（仅本人，发送者未绑定账号时由会话 owner 操作），取消后飞书卡片同步为已取消。
- **失败滞留提示**：上一轮任务执行失败且仍有排队消息时，面板顶部提示「排队消息不会自动继续」及恢复方式。
