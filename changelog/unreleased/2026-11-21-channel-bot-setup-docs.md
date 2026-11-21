### 终端 CLI（mao-cli）

- **完善飞书机器人创建文档**：feishu-bot.md 新增「创建飞书机器人（开放平台配置）」小节——机器人能力、批量导入全量权限 JSON、长连接事件订阅（`im.message.receive_v1`）与卡片回调（`card.action.trigger`）配置、版本发布要求；移除代码未消费的 `im.chat.updated_v1` 订阅建议（话题识别读消息事件自带 `thread_id`）。
- **补齐钉钉机器人创建步骤**：dingtalk-bot.md 明确卡片回调与机器人消息共用同一条 Stream 长连接、无需 HTTP 回调地址；按钮 actionId 补上遗漏的 `dislike`（点踩）；发版权限版本时需选定可用范围。
