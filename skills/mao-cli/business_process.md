# 业务流程总览

端到端：首次部署 → 管理员上线 → 日常使用 → REST CLI 辅助。细节分别见 [deploy.md](deploy.md)、[admin.md](admin.md)、[desktop.md](desktop.md)。

## 首次部署（运维）

1. 准备服务器：Node 22+、Nginx、Git、MySQL
2. 克隆到 `/opt/mao`，创建 `/opt/mao-data/*` 数据目录
3. 构建 backend、admin、desktop（改 `desktop/.env.production`）
4. 编写 `backend-ts/.env`（JWT、MySQL、数据目录、加密密钥）
5. `restart.sh` 启动后端，配置 Nginx + HTTPS
6. 登录管理后台（`https://<域名>/admin/`），**改 admin 密码**
7. 配置至少一个可用模型（真实 API Key + 测试连接）
8. 创建角色/用户、Agent、Skill（按需）
9. 桌面端验证 CLOUD 任务；按需验证 Electron LOCAL、微信、定时任务、通知
10. 按下方「管理员上线检查清单」收尾

## 管理员上线检查清单

- [ ] 已修改默认管理员密码
- [ ] 已配置生产环境密钥（`JWT_SECRET`、`APP_GIT_CREDENTIAL_SECRET` 等）
- [ ] 至少一个可用模型 + 默认模型
- [ ] 已创建普通用户或接入 LDAP/飞书
- [ ] 角色权限合理（普通用户无敏感管理权限）
- [ ] 至少一个可用 Agent
- [ ] CLOUD 任务可创建并正常回复
- [ ] 如需 LOCAL：Electron 或 `mao-agent --local` 已验证
- [ ] 如需私有 Git：HTTPS clone + Git 凭证已验证
- [ ] 如需微信：`weixin.agentId` 或默认 Agent + 扫码对话
- [ ] 如需定时任务：创建、暂停、删除与一次真实触发
- [ ] 如需任务通知：Webhook 密钥 + 钉钉/飞书测试通知
- [ ] 如需 Agent 调 REST：已安装 `mao-cli` 并验证权限边界
- [ ] 审计日志可查看
- [ ] 已向用户说明 LOCAL 审批与安全边界

## 日常用户流程（桌面端）

1. 登录桌面 Web 或 Electron
2. 新建任务：Agent → 模式 → 工作区 → 模型/权限 → 输入目标
3. 对话中查看工具调用与文件变更；LOCAL 处理审批
4. 「设置」管理 Git 凭证、定时任务、消息通知、微信、个人 Skill
5. 复杂任务用 Side Task / 子智能体拆分

## 日常管理员流程

1. 管理后台：用户/角色、模型、Agent、Skill、MCP
2. 会话/定时任务/审计/运行监控巡检
3. 升级：`git pull` + 按范围 deploy-admin / deploy-desktop / restart 后端
4. 发版：更新 CHANGELOG，Web 部署后多端刷新；安卓壳变更跑 `build-apk.sh`

## mao-cli 常用操作顺序

1. 登录：`mao auth login`；云端/微信 shell 已注入 `MAO_TOKEN` 则跳过
2. 上下文：`mao agent list`、`mao model list-active`，必要时 `mao session create`
3. 会话元数据：`session update|pin|favorite|archive|mark-read`
4. 偏好：`pref` 任务面板/通知
5. 诊断：`file workspace-*`、`file workspace-git-*`
6. 个人：`skill`、`command`、`quick-command`
7. 集成：`scheduled-task`、`weixin`、`mcp preferences`
8. 管理：`user`/`role`、`model`、`skill-docs`、`mcp` 全局、`admin-session`、`runtime`、`analytics`、`audit`、`settings`

## 模块边界

- 本 CLI 面向 REST，不连接 `/api/ws/stream`。**对话用 mao-agent**
- 不发送对话，不写入/插入/重排消息队列
- 定时任务**创建**多由 Agent 工具 `create_scheduled_task` 完成
- `session`：当前用户会话；`admin-session`：全站检索
- `skill`：个人 `user-skills`；`skill-docs`：全局目录
- MCP 用户级 `mcp me-*`；全局 `mcp list/create/...` 需管理员

## 对话 vs REST 选型

| 需求 | 工具 |
|------|------|
| 与 Agent 多轮对话、工具循环 | mao-agent |
| 查会话列表、改 pin、管用户、配模型 | mao (mao-cli) |
| 云端 Agent 在 shell 里调 API | mao（`MAO_TOKEN` 自动注入） |
