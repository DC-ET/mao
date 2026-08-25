# 环境变量与配置

部署与开发共用的配置说明。本地安装步骤见 [install.md](install.md)；生产 `.env` 示例见 [deploy.md](deploy.md)。

## 默认账号

首次 Flyway 迁移创建：

| 用户名 | 密码 | 说明 |
|--------|------|------|
| admin | admin123 | 系统管理员，**上线后立即改密** |

## 数据目录（生产典型）

| 路径 | 用途 |
|------|------|
| `/opt/mao` | Git 仓库（源码 + dist + node_modules + `.env`） |
| `/opt/mao-data/workspace` | Agent 工作区（`WORKSPACE_ROOT`） |
| `/opt/mao-data/skills` | 平台技能（`SKILLS_DIR`） |
| `/opt/mao-data/userskills` | 用户技能（`USER_SKILLS_DIR`） |
| `/opt/mao-data/uploads` | 上传与 APK OTA（`FILE_UPLOAD_DIR`） |
| `/opt/mao-data/users` | CLOUD 用户 HOME（`MAO_USER_HOME_DIR`） |
| `/opt/mao-data/runtime` | 运行时状态、蓝绿部署锁（`MAO_RUNTIME_DIR`） |

开发环境可使用仓库内或自定义路径，在 `backend-ts/.env` 中覆盖。

## 后端环境变量（常用）

| 变量 | 必需 | 说明 |
|------|------|------|
| `MAO_TS_PORT` | 否 | 监听端口，默认 9080 |
| `MAO_ROOT_DIR` | 否 | 仓库根，默认 `/opt/mao` |
| `MAO_LOG_DIR` | 否 | 日志目录 |
| `FLYWAY_ENABLED` | 否 | 启动时迁移，默认 true |
| `MYSQL_URL` / `MYSQL_USERNAME` / `MYSQL_PASSWORD` | **是** | MySQL |
| `JWT_SECRET` | 生产**是** | JWT 签名，禁止默认值 |
| `JWT_SHELL_EXPIRATION` | 否 | CLOUD shell 临时 JWT，默认 2h |
| `APP_GIT_CREDENTIAL_SECRET` | **是** | Git Token AES 密钥；未配置拒绝启动 |
| `APP_NOTIFICATION_WEBHOOK_SECRET` | 建议 | 任务通知 Webhook 加密 |
| `APP_MCP_SECRET` | MCP 时建议 | MCP 环境变量加密 |
| `WORKSPACE_ROOT` | **是** | 工作区根 |
| `SKILLS_DIR` / `USER_SKILLS_DIR` | **是** | 技能目录 |
| `FILE_UPLOAD_DIR` | **是** | 本地上传目录 |
| `UPLOAD_STORAGE_MODE` | 否 | `local` 或 `oss` |
| `UPLOAD_BASE_URL` | local 建议 | 公网访问前缀，如 `https://mao.example.com/api` |
| `MAO_RUNTIME_DIR` | 否 | 运行时目录 |
| `MAO_USER_HOME_DIR` | 否 | CLOUD 用户 HOME |
| `MAO_BLUE_GREEN_DRAIN_SEC` | 否 | 蓝绿切换后停旧实例延迟，默认 60s |
| `TAVILY_API_KEY` | 否 | Tavily 搜索（可选） |

### LDAP（可选）

`LDAP_ENABLED`（默认 false）、`LDAP_URL` 等。启用后支持 LDAP 登录。

### 飞书 SSO（可选）

`FEISHU_ENABLED`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_REDIRECT_URI`（后端公网回调，如 `https://your-domain/api/v1/auth/feishu/callback`）。

### 飞书机器人通道（可选）

| 变量 | 默认 | 说明 |
|------|------|------|
| `FEISHU_BOT_ENABLED` | false | 飞书机器人通道总开关（需同时开启 `FEISHU_ENABLED`，绑定扫码走飞书 OAuth） |
| `APP_FEISHU_BOT_SECRET` | - | 机器人 App Secret 的 AES-GCM 加密密钥；未配置时管理后台无法添加机器人 |
| `FEISHU_BOT_LC_ENABLED` | true | 长连接开关 |
| `FEISHU_BOT_RECONCILE_INTERVAL_MS` | 5000 | 长连接一致性巡检间隔 |
| `FEISHU_BOT_RECONNECT_BASE_MS` | 1000 | 重连初始退避 |
| `FEISHU_BOT_RECONNECT_MAX_MS` | 30000 | 重连最大退避 |
| `FEISHU_BOT_MAX_CONSECUTIVE_FAILURES` | 5 | 连续失败告警阈值 |
| `FEISHU_BOT_GROUP_CONTEXT_MAX_ITEMS` | 30 | 群聊上下文注入的最大消息条数 |

注意：飞书应用需开通「获取用户 union_id」权限，否则无法识别发送者身份，全员按未绑定处理。使用详见 [feishu-bot.md](feishu-bot.md)。

### 微信 Bot（可选，默认多项开启）

`WEIXIN_BOT_ENABLED`、`WEIXIN_BOT_MONITOR_ENABLED` 等。管理后台系统设置可指定 `weixin.agentId`、`weixin.modelId`。

### 任务通知 Worker

`TASK_NOTIFICATION_WORKER_DELAY_MS`、`TASK_NOTIFICATION_BATCH_SIZE`、`TASK_NOTIFICATION_MAX_ATTEMPTS`。

### 阿里云 OSS（可选）

`OSS_*` 系列变量，`UPLOAD_STORAGE_MODE=oss` 时使用。

### 密钥轮换注意

- 更换 `APP_GIT_CREDENTIAL_SECRET` 前需用旧密钥解密、新密钥重加密 `user_git_credential` 表。
- 更换 `APP_NOTIFICATION_WEBHOOK_SECRET` 前需重加密通知偏好与未完成投递记录。

## 前端环境变量

| 变量 | 说明 |
|------|------|
| `VITE_API_BASE_URL` | API 根，如 `/api/v1` 或完整 URL |
| `VITE_WS_BASE_URL` | WebSocket（可选，默认同域推导） |

## mao-cli / mao-agent 环境变量

| 变量 | 说明 |
|------|------|
| `MAO_BASE_URL` | mao-cli API 根，默认 `https://mao.etarch.cn/api/v1` |
| `MAO_TOKEN` / `MAO_REFRESH_TOKEN` | JWT（与 `~/.mao/auth.json` 共用） |
| `MAO_AGENT_BASE_URL` | mao-agent，到 `/api`（不含 `/v1`） |

兼容旧名：`MAO_USER_BASE_URL`、`MAO_ADMIN_BASE_URL`。

## 认证方式

| 方式 | 说明 |
|------|------|
| 本地密码 | 默认 |
| LDAP | 部署配置启用 |
| 飞书 OAuth | 部署配置启用 |
| JWT | 桌面/管理后台/CLI 共用；管理接口看权限不看 token 来源 |

云端 CLOUD shell 会为当前会话用户注入短效 `MAO_TOKEN`，供 `mao` CLI 免登录。

## API 前缀与文档

- REST：`/api/v1/`
- WebSocket：`/api/ws/stream`
- Swagger：`<后端>/api/swagger-ui.html`

主要模块：`auth`、`users`、`agents`、`sessions`、`models`、`skills`、`user-skills`、`files`、`scheduled-tasks`、`mcp-servers`、`weixin` 等。
