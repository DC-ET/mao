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
| `MAO_RUNTIME_DIR` | 否 | 运行时目录 |
| `MAO_USER_HOME_DIR` | 否 | CLOUD 用户 HOME |
| `MAO_BLUE_GREEN_DRAIN_SEC` | 否 | 蓝绿切换后停旧实例延迟，默认 60s |

### 集成配置（0.0.82 起迁移至管理后台，勿再改环境变量）

LDAP 认证、飞书 OAuth 登录、上传方式（`UPLOAD_STORAGE_MODE` / `UPLOAD_BASE_URL`）、Tavily/TinyFish 搜索（`tools.tavilyApiKey` / `tools.tinyfishApiKey` / `tools.webSearchProvider`）、OSS 及 STS 凭证，已全部迁入管理后台「系统设置 → 集成配置」，保存后**即时生效、无需重启**，密钥 AES-GCM 加密入库。旧环境变量（`LDAP_*`、`FEISHU_ENABLED`、`FEISHU_APP_*`、`TAVILY_API_KEY`、`TINYFISH_API_KEY`、`WEB_SEARCH_PROVIDER`、`OSS_*` 等）仅在升级首次启动时由 SettingsBootstrap 自动导入 DB，之后一律以管理后台为准。

| 变量 | 必需 | 说明 |
|------|------|------|
| `SETTINGS_SECRET` | 加密项建议 | 集成配置密钥（LDAP 密码、飞书 Secret、搜索 Key、OSS 凭证）的 AES 主密钥；未配置时加密项无法保存，可稍后在后台以明文项先行使用 |

### 全网搜索实现（0.0.83 新增）

web_search 工具支持 Tavily / TinyFish 双实现，在管理后台「系统设置 → 集成配置 → 网络工具」切换：`tools.webSearchProvider`（`tavily` 默认 / `tinyfish`）+ `tools.tinyfishApiKey`（AES 加密），切换即时生效无需重启。

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
| `FEISHU_BOT_GROUP_CONTEXT_MAX_ITEMS` | 20 | 群聊上下文注入的最大消息条数 |

注意：飞书应用需开通「获取用户 union_id」权限，否则无法识别发送者身份，全员按未绑定处理。使用详见 [feishu-bot.md](feishu-bot.md)。

### 微信 Bot（可选，默认开启）

`WEIXIN_BOT_ENABLED`（默认 true）为微信 Bot 总开关；语音回复依赖本机 `silk-encoder` / `ffmpeg`。绑定流程见 [weixin.md](weixin.md)。管理后台系统设置可指定 `weixin.agentId`、`weixin.modelId`。

### 任务通知 Worker

`TASK_NOTIFICATION_WORKER_DELAY_MS`、`TASK_NOTIFICATION_BATCH_SIZE`、`TASK_NOTIFICATION_MAX_ATTEMPTS`。

### Harness 调参（0.0.89 起迁移至管理后台，勿再改 yml）

上下文压缩（`harness.compaction.*`：开关/上下文窗口/触发比例/摘要上限/循环中途压缩）、LLM 超时与限流重试（`harness.llm.*`）、网页抓取（`harness.webPage.*`）、Shell 会话（`harness.shell.*`），已全部迁入管理后台「系统设置 → 集成配置」。均为启动时构建，**保存后需重启后端生效**；`application.yml` 不再读取这些键。Agent 级压缩覆盖（agent `configJson` 的 `compaction` 节点）优先于全局默认值。子代理执行无总时长限制（`harness.delegate.*` 已于 0.0.91 废弃）。

### 运维清理调度器（0.0.76 新增）

系统级定时清理 `MAO_RUNTIME_DIR` 下的临时数据（不跑 LLM、不产生消息）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAO_CLEANUP_INTERVAL_MS` | 86400000（1 天） | 清理调度间隔 |
| `MAO_CLEANUP_SHELL_MAX_AGE_DAYS` | 7 | shell 输出文件（`runtime/<uid>/<sid>/shellOutput/`）保留天数 |
| `MAO_CLEANUP_SKILLS` | true | 是否清理会话 runtime 下的 skills 同步副本目录（活跃会话跳过） |

### 密钥轮换注意

- 更换 `APP_GIT_CREDENTIAL_SECRET` 前需用旧密钥解密、新密钥重加密 `user_git_credential` 表。
- 更换 `APP_NOTIFICATION_WEBHOOK_SECRET` 前需重加密通知偏好与未完成投递记录。
- 更换 `SETTINGS_SECRET` 会导致集成配置中已加密的密钥项解密失败（视为未设置），需在管理后台重新填写各密钥。

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
