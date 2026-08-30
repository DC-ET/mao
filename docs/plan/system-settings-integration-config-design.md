# 系统设置集成配置改造 - 技术方案

> 状态：已评审（2026-08-29 与需求方逐项确认）
> 关联：`backend-ts/src/settings/`、`backend-ts/src/config/app-config.ts`、`admin/src/views/settings/SystemSettingsView.vue`

---

## 1. 需求背景

当前后端配置分两套：

- **静态配置**：`backend-ts/config/application.yml` + 环境变量，启动时经 `loadConfig()`（backend-ts/src/config/app-config.ts:498）一次性加载并缓存，任何修改都必须改文件/环境变量并重启后端。
- **动态配置**：`system_setting` 表（V048 引入）+ `/v1/system-settings` 接口 + 管理后台"系统设置"页。但目前只有 4 个键被真正消费（`weixin.agentId`、`weixin.modelId`、`session.titleModelId`、`git.commitMessageModelId`），`auth.ldap.enabled`、`auth.feishu.enabled` 等行只是启动值的只读回显，不是真配置。

运维痛点：LDAP、飞书登录、上传方式、Tavily Key、OSS 凭证这类"运营期会变"的集成配置散落在 yml/环境变量中，修改需要登录服务器、改文件、重启服务，且容易和环境变量占位符打架。

## 2. 需求描述

### 2.1 做什么（范围内）

将以下 **6 组配置** 从 yml/环境变量抽到 `system_setting` 表，管理后台可视化编辑，保存后即时生效（无需重启）：

| 分组 | 配置项 | 对应环境变量 |
|---|---|---|
| LDAP 认证 | enabled、url、baseDn、userDn、password、userSearchBase | `LDAP_ENABLED`、`LDAP_URL`、`LDAP_BASE_DN`、`LDAP_USER_DN`、`LDAP_PASSWORD`、`LDAP_USER_SEARCH_BASE` |
| 飞书 OAuth 登录 | enabled、appId、appSecret、redirectUri | `FEISHU_ENABLED`、`FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_REDIRECT_URI` |
| 上传配置 | storageMode、baseUrl、file.maxSizeMb | `UPLOAD_STORAGE_MODE`、`UPLOAD_BASE_URL`、`FILE_MAX_SIZE_MB` |
| 网络工具 | tavilyApiKey | `TAVILY_API_KEY` |
| OSS 对象存储 | region、accessKeyId、accessKeySecret | `OSS_REGION`、`OSS_ACCESS_KEY_ID`、`OSS_ACCESS_KEY_SECRET` |
| OSS STS | regionId、endpoint、accessKeyId、accessKeySecret、roleArn、roleSessionName、expire、maxSizeMb | `OSS_STS_REGION_ID`、`OSS_STS_ENDPOINT`、`OSS_STS_ACCESS_KEY_ID`、`OSS_STS_ACCESS_KEY_SECRET`、`OSS_STS_ROLE_ARN`、`OSS_STS_ROLE_SESSION_NAME`、`OSS_STS_EXPIRE`、`OSS_STS_MAX_SIZE_MB` |

配套能力：

1. **加密存储**：secret 类配置（LDAP password、飞书 appSecret、Tavily key、OSS 两组 accessKeySecret）使用 AES-GCM 加密入库，主密钥为新增环境变量 `SETTINGS_SECRET`。
2. **权限控制**：新增 `settings:read` / `settings:write` 权限码接入现有权限体系，修复当前"任何登录用户可读写全部设置"的越权隐患。
3. **测试连接**：LDAP、飞书登录、OSS 三组提供一键测试接口，保存前可验证凭证有效性。
4. **后台 UI**：系统设置页内新增"集成配置"分区（卡片分组、表单式编辑、secret 掩码显示）。
5. **存量迁移**：升级部署时自动将仍在的环境变量值一次性导入 DB（两步迁移，详见 §8）。

### 2.2 明确不做什么（范围外）

| 不做的项 | 理由 |
|---|---|
| 飞书 bot（`feishu.bot.*`）动态化 | 长连接服务，改配置需断开重连逻辑，留待下期。注意：飞书 bot 的 appId/appSecret 本就存于 `feishu_bot` 表（自带 AES-GCM 加密），与本次 OAuth 登录配置无关、互不影响 |
| 微信 bot（`weixin.bot.*`）动态化 | 同上，长连接 + 语音编码器等本机依赖 |
| 数据库连接、Flyway、JWT、server.port | 循环依赖（配置存 DB 需先连 DB）/ 启动引导项 / 安全敏感 |
| 目录类（workspaceRoot、runtimeDir、userHomeDir、skillsDir、file.uploadDir） | 启动引导与部署路径，改了即产生孤儿数据 |
| 线程池、队列、compaction、LLM 超时重试、ws 参数 | 纯性能参数，运维极少调整，且运行中改动影响进行中的 Agent 会话 |
| 飞书 OAuth API 端点（authorizeUrl/tokenUrl/userInfoUrl/appTokenUrl） | 固定官方地址，改为代码常量，不进 DB、不提供覆盖 |
| `oss.maxKeys`、`app.mcp.secretKey`、`app.gitCredential.secretKey` | 性能参数 / 内部加密主密钥，保持环境变量 |
| 配置变更历史、审计回滚 | 现有 onResponse 审计钩子已记录请求，不做专门的历史表 |
| 进程内配置缓存 | 每请求直接读 DB（主键级单表查询，沿用 weixin/session-title 现有模式），不引入缓存失效复杂度 |
| 桌面端/LOCAL 模式的设置入口 | 仅管理后台配置 |

## 3. 技术选型

| 决策点 | 选型 | 说明 |
|---|---|---|
| 存储 | 复用 `system_setting` 表 | 已有 key/value/category/description/editable 结构，仅加 `is_secret` 列 |
| 加密 | 复用 `backend-ts/src/crypto/aes-gcm.ts` | 密文格式 `enc:v1:<iv b64>:<ciphertext b64>` 存入 value；主密钥 `SETTINGS_SECRET` 环境变量 |
| 读取模式 | 每请求现读 DB | 沿用 `SystemSettingService.getValue` 在 weixin/session-title 的既有模式，天然热更新 |
| 权限 | 现有 `requirePermission()` 模式 | 与 `model:write`（model.routes.ts:41）一致 |
| 首次导入 | 启动时 TS 导入（非 SQL） | 自研 Flyway 不支持 SQL 内环境变量；启动时对 value 为 NULL 的行用环境变量值填充 |
| 前端 | 现有 SystemSettingsView 扩展 | 卡片式分区 + 表单控件，复用同一套 settings API |

## 4. 总体设计

### 4.1 settings key 设计

新分类：`集成配置`（`file.maxSizeMb` 保留原分类"文件"，`auth.ldap.enabled`、`auth.feishu.enabled` 两行 UPDATE 归入"集成配置"并把 editable 改为 1）。

```
auth.ldap.enabled          bool     开关
auth.ldap.url              text
auth.ldap.baseDn           text
auth.ldap.userDn           text
auth.ldap.password         secret
auth.ldap.userSearchBase   text     默认 ou=users

auth.feishu.enabled        bool     开关
auth.feishu.appId          text
auth.feishu.appSecret      secret
auth.feishu.redirectUri    text     默认 http://localhost:9080/api/v1/auth/feishu/callback

upload.storageMode         enum     local | oss，默认 local
upload.baseUrl             text
file.maxSizeMb             int      已有行，开始真正消费

tools.tavilyApiKey         secret

oss.region / oss.accessKeyId / oss.accessKeySecret(secret) / oss.bucket
oss.sts.regionId / oss.sts.endpoint / oss.sts.accessKeyId / oss.sts.accessKeySecret(secret)
oss.sts.roleArn / oss.sts.roleSessionName(默认 mao-sts) / oss.sts.expire(默认 3600) / oss.sts.maxSizeMb(默认 50)
```

有效性判定规则（与现状语义一致）：

- LDAP 可用 = `auth.ldap.enabled=true` 且 url 非空。
- 飞书登录可用 = `auth.feishu.enabled=true` 且 appId 非空且 appId ≠ `1234567890`。
- OSS 可用 = region/accessKeyId/accessKeySecret/bucket 四项均非空，否则所有 OSS 相关路由按"未配置"处理（保持现有报错语义）。

### 4.2 存储模型变更（V093 迁移）

`backend-ts/db/migration/V093__settings_integration_config.sql`：

1. `ALTER TABLE system_setting ADD COLUMN is_secret TINYINT NOT NULL DEFAULT 0;`
2. `UPDATE` 现有 `auth.ldap.enabled`、`auth.feishu.enabled`、`file.maxSizeMb` 三行：category 归位、editable=1、description 更新。
3. `INSERT IGNORE` 其余新键（value 置 NULL，表示"从未设置"，触发启动导入）。
4. `INSERT IGNORE` 权限码 `(settings:read, 查看系统设置)`、`(settings:write, 管理系统设置)`，并按 V001 的既有模式授予 ADMIN 角色。

### 4.3 首次导入（settings-bootstrap）

新模块 `backend-ts/src/settings/settings-bootstrap.ts`，在 `createMaoApp` 中 Flyway 迁移完成后、服务启动前执行一次：

- 遍历 §2.1 的 env→key 映射表：若 `system_setting` 中该行 `value IS NULL` 且对应环境变量存在且有值，则写入（secret 类先加密）。
- `value IS NULL` = 从未设置；`value = ''` = 管理员显式确认为空。因此导入天然幂等：管理员在后台保存过（无论值是什么，包括清空）的行永不被覆盖。
- `SETTINGS_SECRET` 未设置时：非 secret 项正常导入；secret 项**跳过并打 WARN 日志**（提示先配置主密钥再重启，避免明文落库）。

### 4.4 读取路径改造（核心）

`settings.service.ts` 新增类型化读取方法，secret 解密后返回：

```ts
getLdapConfig(): Promise<LdapSettings>
getFeishuOAuthConfig(): Promise<FeishuOAuthSettings>
getUploadConfig(): Promise<UploadSettings>          // storageMode/baseUrl/maxSizeMb
getTavilyConfig(): Promise<TavilySettings>
getOssConfig(): Promise<OssSettings | null>          // 未配置返回 null
```

消费方注入方式从"启动时传配置切片"改为"传异步读取函数"：

| 消费方 | 现状 | 改造后 |
|---|---|---|
| `LdapAuthService`（ldap-auth.service.ts:16） | 构造传 `cfg.ldap` | 构造传 `() => Promise<LdapSettings>`，`isConfigured()`/`authenticate()` 每次现读 |
| `FeishuAuthService`（feishu-auth.service.ts:33） | 构造传 `cfg.feishu` | 同上；API 端点用代码常量 |
| `registerUploadRoutes`（create-app.ts:1460） | 启动传静态值 | 改传 `getUploadConfig`，每请求实时返回 |
| `FileService`（create-app.ts:457） | 构造传 `cfg.app.file.maxSizeMb` | maxSizeMb 每请求从 DB 读；uploadDir 仍走 yml |
| `WebSearchTool`（tool-registry.ts:99） | 构造传静态 tavily 对象 | 改传 `() => Promise<TavilySettings>`，每次执行现读 |
| `oss-sts.service` / `oss.routes` | 构造传 `cfg.oss` | 每请求读 `getOssConfig()`，null 时返回"未配置"错误 |

### 4.5 secret 读写语义

- **回显**：GET 列表中 `is_secret=1` 的行 value 一律返回掩码 `******`（无论是否已设置），不回传密文/明文。
- **更新**：PUT 时 `value=null` 表示"不修改"；`value=''` 表示清空；新值则加密覆盖。service 层校验：secret 行提交 `******` 视为无效提交并拒绝（防误保存掩码）。
- **测试连接接口**：body 中 secret 字段为空时自动使用 DB 已存值。

### 4.6 接口设计

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/v1/system-settings?category=` | settings:read | 现有，补权限；secret 掩码 |
| PUT | `/v1/system-settings/:key` | settings:write | 现有，补权限 + secret 语义 |
| PUT | `/v1/system-settings/batch` | settings:write | **新增**，body `{items:[{key,value}]}`，逐条校验任一失败则整体失败，避免多字段保存部分成功 |
| POST | `/v1/system-settings/test/ldap` | settings:write | **新增**，用入参（或已存值）执行 bind+search，返回 ok/错误信息 |
| POST | `/v1/system-settings/test/feishu` | settings:write | **新增**，用 appId/appSecret 换 app_access_token 验证 |
| POST | `/v1/system-settings/test/oss` | settings:write | **新增**，STS AssumeRole 试签验证 |

`applyRuntimeValues` 中的 `auth.ldap.enabled`、`auth.feishu.enabled` 运行时覆盖逻辑删除（改为真配置）；`workspace.root`、`skills.dir` 的只读展示保留。

### 4.7 配置源收敛（清理）

- `application.yml` 删除段落：`ldap:` 整段、`feishu:` 的 enabled/app-id/app-secret/redirect-uri（**保留 bot 段**）、`app.upload:`、`app.file.max-size-mb`（保留 upload-dir）、`app.harness.tavily:`、`oss:` 整段。
- `app-config.ts` 删除 `AppConfig` 对应字段（`ldap`、`feishu` 的 OAuth 四字段、`app.upload`、`app.file.maxSizeMb`、`app.harness.tavily`、`oss`）及 `DEFAULTS`、`coerceTypes` 中相关 env 处理。
- 效果：这批配置的 yml/环境变量在启动后**完全不再被读取**，唯一残留用途是 settings-bootstrap 的首次导入（直接读 `process.env`）。

### 4.8 前端（管理后台）

`admin/src/views/settings/SystemSettingsView.vue`：

- 现有"按分类 Tab + 键值行"保留给简单配置；新增"集成配置"Tab，内部按卡片分组：LDAP、飞书登录、上传、OSS、网络工具。
- 控件：开关用 `el-switch`；枚举用 `el-select`（storageMode: 本地存储/阿里云OSS）；secret 用 `el-input type=password`，placeholder "已设置，留空表示不修改"。
- 保存走 `PUT /v1/system-settings/batch`，按卡片整卡提交。
- LDAP/飞书/OSS 卡片各带"测试连接"按钮，调用对应 test 接口并展示结果。
- 前端不做复杂权限判断（菜单照旧展示），越权操作由后端 403 拦截并 toast 错误。

## 5. 实现步骤

1. **V093 迁移脚本**：is_secret 列、键行 UPDATE/INSERT、权限码。
2. **settings 模块改造**：`types.ts` 增加 is_secret 与各 Settings 类型；`settings.service.ts` 实现 secret 读写语义 + 5 个读取方法；新 `settings-bootstrap.ts` 启动导入；新 `settings-test.service.ts` 测试连接逻辑。
3. **路由改造**：`settings.routes.ts` 补权限、新增 batch 与三个 test 接口。
4. **消费方改造**：按 §4.4 表逐个改造 6 个消费点及 `create-app.ts` 注入。
5. **清理**：yml 段落删除、app-config.ts 字段删除、`app-config.spec.ts` 同步更新。
6. **前端**：SystemSettingsView 集成配置分区 + 测试按钮。
7. **收尾**：单测补齐、`npm test` 全绿、CHANGELOG.md 写入、（如涉及运维方式变化）同步 skills/mao-cli 运维段落。

## 6. 落地清单

### 后端 backend-ts

| 文件 | 动作 |
|---|---|
| `db/migration/V093__settings_integration_config.sql` | 新增 |
| `src/settings/types.ts` | 修改：is_secret、Settings 类型 |
| `src/settings/settings.service.ts` | 修改：secret 语义、5 个读取方法 |
| `src/settings/settings.repository.ts` | 修改：is_secret 读写 |
| `src/settings/settings-bootstrap.ts` | 新增：启动导入 |
| `src/settings/settings-test.service.ts` | 新增：LDAP/飞书/OSS 测试 |
| `src/settings/settings.routes.ts` | 修改：权限 + batch + test 接口 |
| `src/settings/settings.service.spec.ts` | 修改：新增用例 |
| `src/auth/ldap-auth.service.ts` | 修改：动态配置注入 |
| `src/auth/feishu-auth.service.ts` | 修改：动态配置注入、端点常量化 |
| `src/config/upload.routes.ts` | 修改：动态读取 |
| `src/file/file.service.ts` | 修改：maxSizeMb 动态读取 |
| `src/harness/tool/impl/web-search-tool.ts` | 修改：tavily 动态读取 |
| `src/harness/tool/tool-registry.ts` | 修改：deps 类型 |
| `src/oss/oss-properties.ts`、`src/oss/oss-sts.service.ts`、`src/oss/oss.routes.ts` | 修改：动态读取 |
| `src/config/app-config.ts` + `app-config.spec.ts` | 修改：删除范围外字段 |
| `config/application.yml` | 修改：删除 §4.7 段落 |
| `src/create-app.ts` | 修改：注入方式、bootstrap 调用 |

### 前端 admin

| 文件 | 动作 |
|---|---|
| `admin/src/views/settings/SystemSettingsView.vue` | 修改：集成配置分区 |
| `admin/src/api/`（settings 相关 api 封装） | 修改：batch/test 接口 |

### 文档

| 文件 | 动作 |
|---|---|
| `CHANGELOG.md` | 新增版本小节（backend-ts + admin 两条） |
| `skills/mao-cli/SKILL.md` 运维段落 | 同步：配置项改为管理后台维护 |

## 7. 测试

- **单测**（Vitest）：settings.service（secret 掩码/不修改/清空/加密往返、batch 校验、5 个读取方法、LDAP/飞书可用性判定）、settings-bootstrap（NULL 行导入、'' 行不覆盖、无主密钥跳过 secret）、ldap/feishu service（动态配置下 isConfigured 分支）、app-config.spec（字段删除后）。
- **手工验证**：后台修改 LDAP url 后立即用新地址登录；关闭飞书登录开关后登录页立即隐藏；storageMode 切 oss 后 `/v1/upload/config` 即时变化；无 settings:write 权限用户 PUT 返回 403。
- Playwright 不新增用例（现有 spec 勿依赖固定用例数）。

## 8. 部署与存量迁移（两步）

前提：`SETTINGS_SECRET` 已加入部署环境（未设时 secret 类导入会跳过并 WARN）。

1. **部署新版**（旧环境变量保持不动）：启动时 Flyway 执行 V093 → settings-bootstrap 将仍在的环境变量值自动导入 DB（加密）→ 后台"集成配置"分区即显示完整配置。
2. **验证后摘除**：管理员在后台核对各组配置（可点测试连接），确认无误后从部署环境删除这批旧环境变量（LDAP_*、FEISHU_ENABLED/APP_ID/APP_SECRET/REDIRECT_URI、UPLOAD_*、FILE_MAX_SIZE_MB、TAVILY_API_KEY、OSS_*）。`SETTINGS_SECRET` 必须保留。

风险与注意：

- `SETTINGS_SECRET` 丢失则 DB 中 secret 无法解密，需在后台重新填写各凭证——主密钥按敏感凭据妥善保管。
- 两步之间环境变量与 DB 并存但**以 DB 为准**，若发现后台值不对应先改后台，而不是改回环境变量（改了也不会生效）。
