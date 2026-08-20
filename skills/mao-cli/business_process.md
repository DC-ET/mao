# 业务流程总览

## 常用操作顺序

1. 登录：`mao auth login` 或飞书登录流程，成功后 JWT 写入 `~/.mao/auth.json`。云端/微信 shell 若已注入 `MAO_TOKEN` 则跳过。
2. 选运行上下文：`mao agent list`、`mao model list-active`，必要时 `mao session create`。
3. 非对话配置：用 `session update|pin|favorite|archive|mark-read` 改会话元数据，用 `pref` 改任务面板或任务通知偏好。
4. 文件与工作区诊断：用 `file workspace-*` 浏览/读取文件，用 `file workspace-git-*` 查看 Git 只读状态与差异。
5. 个人能力：用 `skill`、`command`、`quick-command` 管理个人技能与指令。
6. 集成能力：用 `scheduled-task` 维护已创建定时任务，用 `weixin` 管理微信 Bot 绑定。
7. 管理运维：用 `user` / `role` 管账号，用 `model create|update|test` 配模型，用 `skill-docs` 维护全局技能，用 `admin-session` / `runtime` / `analytics` / `audit` / `settings` 做后台巡检。

## 模块边界

- 本 CLI 面向 REST API，不连接 `/api/ws/stream`。对话执行请用 `mao-agent`。
- 不发送对话，不写入/插入/重排消息队列。
- 定时任务创建当前由 Agent 工具 `create_scheduled_task` 完成，不是本 CLI 的 REST 创建能力。
- `session` 只操作当前用户自己的会话；全站检索用 `admin-session`。
- `skill` 是个人 `user-skills`；全局目录是 `skill-docs`。
