# 业务流程总览

## 常用操作顺序

1. 登录：`mao-user auth login` 或飞书登录流程，成功后 JWT 写入 `~/.mao/auth.json`。
2. 选运行上下文：`agent list`、`model list-active`，必要时创建 `session create`。
3. 非对话配置：用 `session update|pin|favorite|archive|mark-read` 改会话元数据，用 `pref` 改任务面板或任务通知偏好。
4. 文件与工作区诊断：用 `file workspace-*` 浏览/读取文件，用 `file workspace-git-*` 查看 Git 只读状态与差异。
5. 个人能力：用 `skill`、`command`、`quick-command` 管理个人技能与指令。
6. 集成能力：用 `scheduled-task` 维护已创建定时任务，用 `weixin` 管理微信 Bot 绑定。

## 边界

- 本 CLI 面向用户端 REST API，不连接 `/api/ws/stream`。
- 不发送对话，不执行 Agent 运行，不写入/插入/重排消息队列。
- 定时任务创建当前由 Agent 工具 `create_scheduled_task` 完成，不是本 CLI 的 REST 创建能力。
