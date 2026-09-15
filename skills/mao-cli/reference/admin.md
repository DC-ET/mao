# 管理后台使用

管理后台用于平台治理与配置。默认开发地址 `http://localhost:5200/admin/`；生产与桌面 Web 同一域名，路径为 `https://mao.example.com/admin/`（由部署方配置）。

登录与账号见 [config.md](config.md)。REST 运维可用 `mao` CLI（`user`、`role`、`model`、`skill-docs`、`admin-session`、`audit` 等）。

## 时间显示约定

列表、详情、聊天记录及移动端卡片中的日期时间统一为 `yyyy-MM-dd HH:mm:ss`，使用北京时间（Asia/Shanghai），不随浏览器时区变化。无时区的接口时间按北京时间解释，带时区的时间转换后展示；未登录过、未触发等空时间显示 `-`，异常时间显示「无效时间」。统计图的纯日期坐标与耗时保持原有格式。

## 数据概览

查看用户、Agent、会话、调用等统计。概览上的异常会话可点进运行监控；「Agent 使用排行」为近 7 天口径，周期趋势、环比与 Token 排行见用量分析。

## 模型管理

**使用前必须配置真实模型**。Mao 通过 OpenAI 兼容协议调用 LLM。

| 字段 | 说明 |
|------|------|
| 名称 | 展示名 |
| 供应商 | OpenAI、DeepSeek 等 |
| 模型标识 | API 中的 model ID |
| API 地址 | 兼容接口根，通常 `/v1` 结尾 |
| API Key | 供应商密钥 |
| 上下文窗口 | token 上限 |
| 支持视觉 | 是否接受图片 |
| 默认模型 | 新会话默认 |

注意：初始化占位模型须替换 Key；不支持视觉的模型勿开视觉；保存后可用「测试连接」。文本模型仅测试基础调用，展示通过或失败、模型输出及耗时，不再检测 mid system message 支持；语音模型仍测试合成与试听。

CLI：`mao model list|create|update|delete|set-status|test`（见 [model.md](model.md)）。

## Agent 管理

创建不同职责的智能体（代码、运维、文档等）。创建、编辑和复制共用四个 Tab，切换不会丢失输入；保存统一校验，错误自动定位到对应分组。

| Tab | 内容 |
|------|------|
| 基本信息 | 头像、名称、描述、Skills（留空默认全部）、MCP 服务器（留空不启用）、默认 Agent、默认模型（留空跟随系统默认） |
| 角色提示词 | 角色定义：只填身份、业务目标与表达方式，文本域默认 15 行。页面上下文、工具用法、安全边界等通道规则由系统按会话类型注入，不必写在这里 |
| 最佳实践 | 经验正文、启停与排序 |
| 推荐问题 | Embed SDK 浮窗空白态展示的提问引导：最多 5 条、单条 1～100 字，支持排序；点击后填入输入框由用户手动发送 |

头像区域使用预览卡片，更换与移除按钮横向排列，窄屏自动调整布局；上传中显示进度状态并禁止重复操作。

头像支持 PNG / JPEG / WebP，最大 2 MiB、4096 × 4096 像素，不支持动画；服务端验证、去除元数据并缩放至 512 × 512 范围后转为 PNG。上传或移除后须保存 Agent 才生效；复制继承头像。后台列表、客户端 Agent 选择入口与 Embed SDK 使用同一头像；Embed SDK 浮窗标题同时显示 Agent 名称。未配置头像时使用原有默认标识。头像属于公开展示资源，请勿上传敏感图片。上传与保存需要 `agent:write` 权限。

CLI：`mao agent list|get|create|update` 等（见 [agent.md](agent.md)）。

### 系统提示词版本与回滚

- 在 Agent 列表点击「提示词版本」，查看版本号、保存时间、操作人 ID、回滚来源，并预览当时保存的角色定义（不含运行时注入的通道规则）。此入口和接口均要求 `agent:write` 权限。
- 创建 Agent 时保存 v1；升级时将现有未删除 Agent 的提示词保存为 v1。之后仅在提示词内容实际变化时递增版本，修改名称等其他配置不会产生提示词版本。
- 选中历史版本后点击「回滚到此版本」，确认后立即保存。只恢复系统提示词，不修改名称、经验、Skills、MCP 或默认模型。
- 回滚会新增版本并记录来源，旧版本不会删除，因此可以再次回滚；目标内容与当前一致时不重复生成版本。
- 版本历史只能恢复启用此功能后保存的内容，无法找回此前已经被覆盖的提示词。


## Skills 管理

维护平台 Skill 文档目录。为内部规范、排障流程编写独立 Skill；按 Agent 场景关联子集。

CLI 全局目录：`mao skill-docs`（见 [skill-docs.md](skill-docs.md)）。

## 用户管理

新增/编辑用户、禁用、重置密码、分配角色。

CLI：`mao user ...`（见 [user.md](user.md)）。

## 角色权限

RBAC：创建角色、分配权限点、关联用户。普通用户不应有模型密钥、审计等敏感权限。

CLI：`mao role ...`、`mao permission list`（见 [role.md](role.md)）。

## MCP 服务器

管理全局 MCP（stdio / HTTP）：创建、启停、测试连接、查看工具列表。用户可在桌面端配置私有 MCP；会话按 Agent 注入 `mcp__{server}__{tool}`。

CLI：`mao mcp ...`（见 [mcp.md](mcp.md)）。

## 会话管理

查看全站会话：用户、Agent、状态、消息与工具调用。用户反馈异常时从此定位。

CLI：`mao admin-session ...`（见 [admin-session.md](admin-session.md)）。

## 定时任务

查看 Cron、启用/暂停、删除；定位 `QUEUED`（会话忙时排队）与失败记录。

CLI：`mao scheduled-task ...`（创建通常由 Agent 工具完成）。

## 审计日志

追踪登录失败、用户/角色变更、模型与 Agent 配置变更、敏感操作。

CLI：`mao audit ...`（见 [audit.md](audit.md)）。

## 运行监控

后端在线、WebSocket、长时间运行会话、工具失败、通知/微信连续失败等。

CLI：`mao runtime ...`（见 [runtime.md](runtime.md)）。

## 用量分析

图表看板，按 7 / 30 / 90 天周期统计**窗口内新增**数据，并与紧邻的上一等长窗口做环比：

- KPI 卡：新增会话、消息数、Token 消耗、会话失败率，各带环比与迷你走势
- 趋势：会话与消息双轴折线；Token 堆叠柱（对话 Token + 后台调用 Token，后者来自会话标题、Git 提交信息等后台 LLM 调用）
- 结构：会话结局分布与模型 Token 占比环形图（Top 10 + 其他）；Agent Token 与用户活跃横向排行
- 明细：模型用量表（会话 / 消息 / 对话与后台 Token / 占比），窗口内未被调用的模型不列出

90 天视图默认聚焦最近 30 天，可拖动查看全周期。实时异常（运行中、待审批、卡住会话）与失败会话明细看运行监控，本页阶段分布只统计窗口内创建的会话。

CLI：`mao analytics summary --days 7|30|90` 取同一份数据（见 [analytics.md](analytics.md)）。

## 调用流水

「运行 → 调用流水」查看全站逐次 LLM 调用：时间、用户、场景、模型、入/出/缓存 Token、流式、首字与总耗时、成败。可按用户、会话、模型、场景、时间筛选；详情弹窗展示协议、推理强度、重试次数与错误摘要。

与「用量分析」区别：用量分析是窗口内聚合报表；调用流水是每次 `chat/stream` 一行，含延迟与场景。

CLI：`mao llm-call list`（见 [llm-call.md](llm-call.md)）。

## 系统设置

平台级配置，例如：

- **集成配置**（卡片分组，保存即时生效，密钥 AES 加密存储，LDAP/飞书登录/OSS 提供一键测试连接）：
  - LDAP 认证、飞书 OAuth 登录（0.0.82 起由环境变量迁入）
  - 公司 SSO（0.0.111）：启用开关、校验域名白名单、宿主 Origin 白名单、Access 有效期、校验超时；白名单支持换行或逗号输入，宿主 Origin 可填精确 HTTPS、`https://*.acg.team`（任意层级子域、不含根域、端口严格匹配）或 `*`（所有来源）。以 `auth.companySso.config` 完整快照保存，新换票即时生效，取消 SSO 环境变量。业务系统仍用 `MaoChat.init` 的 `auth.checkUrl` 指定接口地址，详见 [SSO 配置](config.md#公司-ssoweb-embed-sdk)。
  - 上传：存储方式（local/OSS）、访问前缀、单文件大小上限
  - 网络工具：Tavily / TinyFish 搜索实现切换与各自 API Key（0.0.83 新增双实现）
  - 阿里云 OSS 对象存储与 STS 临时凭证
  - Agent 运行 / 任务通知（0.0.88 迁入；通知即时生效，线程池与 WS 超时重启生效）
  - Harness 调参（0.0.89 迁入）：上下文压缩、LLM 超时与重试、网页抓取、Shell 会话，保存后重启后端生效
- `weixin.agentId` / `weixin.modelId`：微信通道 Agent 与模型
- `session.titleModelId`：会话标题生成模型
- `git.commitMessageModelId`：Git 提交信息生成模型

读写需 `settings:read` / `settings:write` 权限；页面左侧目录索引可快速跳转分组。CLI：`mao settings list|set`（见 [settings.md](settings.md)）。

## 飞书机器人通道

「飞书机器人」页面管理飞书自建应用机器人：每个机器人独立配置 App ID / App Secret、Agent、模型，可启用/停用/删除。App Secret 以 `APP_FEISHU_BOT_SECRET` 加密存储，不返回明文；未配置该密钥时无法添加机器人。

启用后服务端与飞书建立长连接接收消息：用户在飞书内私聊或群里 @ 机器人即可触发对应 Agent。用户绑定流程见 [feishu-bot.md](feishu-bot.md)。

REST：`/v1/admin/feishu-bots` 系列（详见 [feishu-bot.md](feishu-bot.md)）。

## 管理员上线清单

正式开放前建议完成 [business_process.md](business_process.md) 中的检查项。
