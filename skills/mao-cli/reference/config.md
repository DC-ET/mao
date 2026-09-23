# 环境变量与配置

部署与开发共用的配置说明。本地安装步骤见 [install.md](install.md)；生产 `.env` 示例见 [deploy.md](deploy.md)。

## 站点域名

文档与命令示例统一用 `https://mao.example.com` 表示**你部署后的对外站点**（把主机名换成自己的域名）。路径约定见 [deploy.md](deploy.md)：桌面 `/`、管理后台 `/admin/`、API `/api/`、上传 `/uploads/`。

`mao-cli` / `mao-agent` 共用 `MAO_BASE_URL`（或 `--base-url`）。推荐写成站点根，例如 `https://mao.example.com`；也接受 `https://mao.example.com/api` 与 `https://mao.example.com/api/v1`，工具会自己归一化。未设置时回落到开源仓库内置的示例域名（`https://mao.etarch.cn`，最低优先级）。**私有化部署后该地址通常不可达**，必须改成自己的实例。

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

### ECP 飞书登录（全站）

管理后台「系统设置 → 集成配置 → ECP 飞书登录」维护，默认关闭。配置键 `auth.ecp.config`（JSON），保存后对新登录与 renew 即时生效。开启后**新增** ECP 飞书登录入口，不关闭密码、LDAP、Mao 飞书 OAuth 与公司 SSO 换票；仅经 ECP 飞书登录的用户会加密保存 ECP `sessionToken` 并在 12 小时内自动 renew，CLOUD shell 将会话票写入虚拟 HOME 的 `~/.config/com.access.accessone/` 供内部 CLI（如 `bigdata-cli`）读取 Bearer，并注入环境变量 `ECP_TOKEN`。开启后飞书机器人通道会额外检查发送者是否有未过期的 ECP 票，没有则发送橙色标题「新用户绑定」的卡片（正文「请先点击下方按钮完成用户绑定（3分钟内有效）。」，按钮「点我绑定」），即使飞书账号已经绑定。

| 后台字段 | 默认 | 说明 |
|------|------|------|
| 启用 ECP 飞书登录 | 关闭 | 开启后新增 ECP 飞书入口，不关闭其它登录方式 |
| appCode | EK0001 | ECP 应用编码 |
| ECP API Base URL | `https://ecp.example.com/api/v1` | 示例网关，部署时改成实际地址 |
| loginVariant | PARTNER | 飞书授权变体，联调可调 |
| 桌面回调 URL | `https://mao.example.com/auth/ecp/feishu-callback` | 须与对外站点同源，并在 ECP 登记 |
| 管理后台回调 URL | `https://mao.example.com/admin/auth/ecp/feishu-callback` | 同上 |

升级需执行 V111 迁移。`mao-cli` 本期不提供浏览器飞书登录，仅 Web/管理后台/Electron 入口。设计见 `docs/plan/2026-09-14-ecp-native-login-technical-design.md`。

### 公司 SSO（Web Embed SDK）

此集成在管理后台「系统设置 → 集成配置 → 公司 SSO」维护，默认关闭。配置以单条 `auth.companySso.config` JSON 保存在系统设置中，保存后对新换票请求及预检即时生效，无需重启；不再读取或自动导入 `SSO_*` 环境变量。业务系统仍在 `MaoChat.init` 的 `auth.checkUrl` 指定校验地址，校验协议仍为公司 checkToken 协议。

| 后台字段 | 默认 | 说明 |
|------|------|------|
| 启用公司 SSO | 关闭 | 开启前必须配置以下两类白名单 |
| 宿主 Origin 白名单 | 空 | 支持精确 HTTPS Origin、`https://*.example.com` 子域模式或 `*` 全来源；不填路径或尾斜杠 |
| 校验域名白名单 | 空 | 如 `example.com,sso.example.com`；每项允许自身及其所有子域名，不填协议、路径、端口或通配符 |
| Access 有效期（秒） | 1800 | 60～3600 秒；实际不超过官方返回的 SSO 剩余有效期，不限制连续使用时长 |
| 校验超时（毫秒） | 3000 | 单次官方校验超时，1～30000 毫秒 |

宿主 Origin 可混合填写以下规则（逗号或换行分隔）：

- `https://admin.example.com`：精确匹配该 Origin。
- `https://*.example.com`：匹配 `https://a.example.com`、`https://a.b.example.com` 等任意层级子域，不包含根域 `https://example.com`，根域需单独登记。仅匹配 HTTPS 默认端口；需要非默认端口时填写 `https://*.example.com:8443`，端口严格匹配。
- `*`：不限制网页来源，包括 HTTP 页面和 `null` Origin；换票 CORS 允许所有来源，但不允许 Cookie 凭据模式。仍须有效 SSO Token，Mao 换票接口和校验 URL 仍要求 HTTPS，校验域名白名单保持独立生效。

子域模式不匹配 `evilexample.com`、`example.com.evil.com`，不允许部分星号、多重星号、路径、查询、片段或用户名密码。配置 `*` 表示配置人员明确放开网页来源限制。

保存需 `settings:write` 权限；完整配置一次保存，非法值不会部分写入。升级需执行 V107 系统设置迁移；旧环境配置不导入，请在后台重新填写。关闭 SSO 后新换票被拒绝，不立即撤销已有 access，也不取消已受理任务。已开始换票请求使用其读取的配置快照。

TLS 终止代理属于服务器基础设施，不是 SSO 业务设置：`TRUSTED_PROXY_ADDRESSES` 仍由部署环境配置，默认不信任代理；必须填直连 Mao 的代理精确 IP，如 `127.0.0.1,::1`，禁止通配符或任意来源转发头。

域名白名单支持完整域名或上级域名：`example.com` 匹配 `example.com`、`a.example.com`、`b.example.com` 及更深子域，不匹配 `evilexample.com` 或 `example.com.evil.com`；`sso.example.com` 仅覆盖自身及其下级子域。所有匹配域名及其路径的身份校验信任由配置人员判定；不另做 DNS 私网地址过滤。不同校验地址必须属于同一员工身份体系，身份源仍为 `company_sso`，不会按 URL 创建新身份源。

`auth.checkUrl` 必须为 HTTPS URL，不带用户名密码、片段或已有 `token` 查询参数；请求不跟随重定向。SDK 每次换票以 JSON `{checkUrl}` 传入地址，SSO Token 仍仅放在 Authorization Header。原 `SSO_CHECK_URL` 不再使用。

仅变更受信代理等启动配置时需重启。Nginx 必须覆盖 `X-Forwarded-Proto` 为 `$scheme` 并设置正确客户端转发链；后端监听端口须受防火墙保护。没有精确信任代理时，HTTP 后端不会因为来路提供 `X-Forwarded-Proto: https` 就接受 SSO 换票。

每 IP 每分钟最多 60 次换票、每个已校验身份每分钟最多 20 次，计数为进程内；多副本必须在网关加聚合限流。换票响应不缓存，SDK Token 不持久化。当前官方协议不要求另加应用密钥；不要把用户 Token 写入 `.env`。

上线前核实邮箱可信且不重分配（测试/生产的公司用户 id 可以不同），完成成功/失效/停用实测。SSO 协议将 Token 放在 query 中，SSO 服务和网关必须对 query 脱敏；Mao 不输出完整上游 URL。接入及限制见 [embed-sdk.md](embed-sdk.md#公司-sso-接入)。

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

上下文压缩（`harness.compaction.*`：开关/上下文窗口/触发比例/摘要上限/循环中途压缩）、LLM 超时与限流重试（`harness.llm.*`）、网页抓取（`harness.webPage.*`：连接/读取超时、原始 HTML 字节上限、正文输出字符上限、User-Agent；`maxOutputLength` 默认 50000 字符，超出即截断并把完整正文落盘到会话 runtime 目录 `webPages/` 供 Agent 按需回读）、Shell 会话（`harness.shell.*`），已全部迁入管理后台「系统设置 → 集成配置」。均为启动时构建，**保存后需重启后端生效**；`application.yml` 不再读取这些键。Agent 级压缩覆盖（agent `configJson` 的 `compaction` 节点）优先于全局默认值。子代理执行无总时长限制（`harness.delegate.*` 已于 0.0.91 废弃）。

### 运维清理调度器（0.0.76 新增）

系统级定时清理 `MAO_RUNTIME_DIR` 下的临时数据（不跑 LLM、不产生消息）：

| 变量 | 默认 | 说明 |
|------|------|------|
| `MAO_CLEANUP_INTERVAL_MS` | 86400000（1 天） | 清理调度间隔 |
| `MAO_CLEANUP_SHELL_MAX_AGE_DAYS` | 7 | 会话 runtime 下 `shellOutput/sh-*.out` 与 `webPages/*.md`（网页全文落盘）的保留天数 |
| `MAO_CLEANUP_SKILLS` | true | 是否清理会话 runtime 下的 skills 链接目录（活跃会话跳过）。技能以符号链接指向源目录，清理只删链接，不影响源与已全局安装的 CLI |

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
| `MAO_BASE_URL` | `mao-cli` 与 `mao-agent` 共用的站点地址，如 `https://mao.example.com`（也接受 `/api` 与 `/api/v1`；未设时的回落见上文「站点域名」） |
| `MAO_TOKEN` / `MAO_REFRESH_TOKEN` | JWT（与 `~/.mao/auth.json` 共用） |

兼容旧名：`MAO_USER_BASE_URL`、`MAO_ADMIN_BASE_URL`。

## 认证方式

| 方式 | 说明 |
|------|------|
| 本地密码 | 默认 |
| LDAP | 部署配置启用 |
| 飞书 OAuth | 部署配置启用 |
| 公司 SSO 换票 | Web Embed SDK 回调提供公司 Token，Mao 官方校验后签发 access，自动续期，不签发 refresh |
| JWT | 桌面/管理后台/CLI 共用；管理接口看权限不看 token 来源 |

云端 CLOUD shell 会为当前会话用户注入短效 `MAO_TOKEN`，供 `mao` CLI 免登录；若该用户经 ECP 飞书登录且票仍有效，同时注入 `ECP_TOKEN`（明文 ECP `sessionToken`）。

## API 前缀与文档

- REST：`/api/v1/`
- WebSocket：`/api/ws/stream`
- Swagger：`<后端>/api/swagger-ui.html`

主要模块：`auth`、`users`、`agents`、`sessions`、`models`、`skills`、`user-skills`（管理端聚合与指定用户上传另有 `admin/user-skills`）、`files`、`scheduled-tasks`、`mcp-servers`、`weixin` 等。
