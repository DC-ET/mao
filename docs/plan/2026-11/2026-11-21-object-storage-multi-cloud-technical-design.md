# 多云对象存储技术方案（图片附件直传：阿里 OSS / 腾讯 COS / 华为 OBS）

> 状态：已实施（评审代理以官方 SDK 独立复验三家签名器逐字节一致）
> 关联代码：`backend-ts/src/upload/`、`backend-ts/src/settings/`、`backend-ts/src/config/upload.routes.ts`、`desktop/src/utils/{storageMode,imageUpload,objectStorageUpload}.ts`、`admin/src/views/settings/`、`shared/contracts/src/`、`skills/mao-cli/`
> 适用范围：只改「图片附件上传」（`uploadImages` 链路，聊天输入与头像上传共用）的存储后端；非图片文件、LOCAL 本机附件、微信素材、工具产物图片均不在本次范围。

## 1. 背景与目标

当前 `upload.storageMode` 只支持两值：`local`（服务端磁盘，默认）与 `oss`（阿里云 OSS STS 直传）。部署方若使用华为云或腾讯云，只能选择本地磁盘模式，图片附件落服务端盘、占用实例磁盘且无法借力对象存储的容量与带宽。

目标：

1. 存储模式扩展为四值：`local | oss | cos | obs`（腾讯 COS、华为 OBS）；
2. 三家对象存储统一为「服务端签发预签名 PUT 票据 + 前端直传」，前端上传代码不感知具体云厂商；
3. 现有 `oss` 模式实例平滑迁移到统一链路，不要求管理员重新走 STS 子账号/委托配置。

## 2. 现状分析

### 2.1 影响范围盘点

`storageMode` 只在图片附件上传链路生效，其余上传链路均不读该配置，本次不动：

| 链路 | 入口 | 是否受影响 |
|---|---|---|
| 聊天图片附件（CLOUD） | `desktop/src/utils/imageUpload.ts` → local: `POST /v1/files/upload`；oss: STS 直传 | **是（本次全部改动点）** |
| 非图片文件 | `desktop/src/utils/chatFileUpload.ts` → `POST /v1/files/upload-incoming`（永远落服务端 runtime incoming，返回 `@{absolutePath}@`） | 否 |
| LOCAL 本机附件 | `desktop/src/utils/chatLocalAttach.ts`（Electron 拷贝到 `~/.mao/attachments`） | 否 |
| Agent 工具产物图片 | harness 直接写 uploads 目录（`send-media-tool.ts` 等），无 storageMode 分流 | 否 |
| 微信素材存储 | `backend-ts/src/weixin/file-storage.service.ts`（独立本地盘） | 否 |

两点补充：

- `uploadImages` 的调用方除聊天输入（`useChat.ts`、`SideChatPanel.vue`）外还有个人资料头像上传（`ProfileView.vue:252`）——头像随本方案一并切到新链路，行为等价，无单独改动；
- `path-sandbox.ts` 的 `describeForeignPath` 与 `read-bytes-bridge.ts` 的 `foreignPathMessage` 只对服务器本地绝对路径做「他人 uploads 目录」判定（后者入口 `!path.isAbsolute(src)` 即短路，`read-bytes-bridge.ts:43`），OSS 模式写进消息的是 http(s) URL，不进入该判定；工具产物仍写本地 uploads 目录，两处逻辑不受影响。

### 2.2 现有 oss 直传链路

1. 前端 `getUploadConfig()`（`desktop/src/utils/storageMode.ts`）每 60s 缓存调 `GET /v1/upload/config`，拿到 `{storageMode, baseUrl, maxSizeMb}`；
2. `oss` 分支调 `POST /v1/oss/sts-token`（`backend-ts/src/oss/oss.routes.ts`），`OssStsService` 用 `@alicloud/sts20150401` AssumeRole（inline policy 限定 `oss:PutObject`/`oss:PutObjectAcl` 到 `uploads/*`），带 3 次瞬态重试；
3. 前端 `uploadToOss`（`desktop/src/utils/ossUpload.ts`）用 `ali-oss` SDK 直传，key = `uploads/{ts}_{name}`，返回 bucket 公网 URL 进消息。

### 2.3 现状痛点

- 类型层面：后端 `storageMode` 是宽 `string`（`settings.service.ts:385` 只认 `'oss'` 否则回落 `'local'`）；前端 `UploadConfig.storageMode` 内联 `'oss' | 'local'`（`desktop/src/utils/storageMode.ts:4`），未走 `@mao/contracts`；
- 依赖层面：`ali-oss`（前端 bundle ~数百 KB）+ `@alicloud/sts20150401`（后端）均为阿里云专属；华为 OBS 浏览器 SDK（`esdk-obs-browserjs`）长期停更且依赖 crypto-js，不适合引入；
- 配置层面：`OssSettings.sts` 子配置（regionId/endpoint/STS AK/SK/roleArn/roleSessionName/expire/maxSizeMb 共 8 个 key）是阿里云 STS 专属概念，其他云没有等价物。

## 3. 方案选型

| | 方案 A：每云 STS + 前端 SDK | 方案 B：统一预签名票据（本方案） |
|---|---|---|
| 腾讯 COS | 可行：CAM `GetFederationToken` 支持 policy 限定 `uploads/*`，`cos-js-sdk-v5` 成熟 | 可行 |
| 华为 OBS | 受限：IAM `CreateTemporaryAccessCredentialByAgency` 无 inline policy，需 agency 委托 + IAM 自定义策略绑定，运维配置成本高；浏览器 SDK 停更 | 可行：官方最佳实践即「预签名 URL PUT 直传」 |
| 前端改动 | 每云一套上传分支 + 一套 SDK（bundle 累加） | 一个 PUT 上传器，**可删除 `ali-oss`** |
| 后端改动 | 每云一个 STS/临时凭证服务 | 每云一个纯本地 HMAC 签名函数（无网络调用、无 SDK） |
| 后续加云边际成本 | 每云全套（STS + SDK + 前端分支） | 配置组 + 一个签名函数 |
| 阿里云存量链路 | 不动 | STS → 预签名迁移（见 §7） |

结论：选方案 B。注意三家**签名算法并不统一**（阿里 OSS V4 是 HMAC-SHA256，腾讯 COS 与华为 OBS 是各自文档化的 HMAC-SHA1 算法），统一的不是签名算法，而是**票据协议**：`POST /v1/upload/ticket` 对前端返回同构的 `{uploadUrl, key, publicUrl, expiration}`，前端只管 `PUT uploadUrl`。

## 4. 总体设计

### 4.1 StorageMode 枚举下沉 contracts

新增 `shared/contracts/src/storage.ts`：

```ts
/** 图片附件上传存储模式：local=服务端磁盘；oss/cos/obs=对应云对象存储预签名直传。 */
export type StorageMode = 'local' | 'oss' | 'cos' | 'obs';
```

- 后端 `UploadSettings.storageMode` 改用该类型；`getUploadConfig` 白名单改为 `['oss','cos','obs'].includes(raw) ? raw : 'local'`；
- 前端 `desktop/src/utils/storageMode.ts` 的 `UploadConfig.storageMode` 引用契约类型；catch 回落值由 `'oss'` 改为 `'local'`（取不到配置时落服务端盘是更安全的默认）；
- admin 下拉 options 用 `Record<StorageMode, string>` 汉化表生成，吃编译期穷尽（对齐 `LlmCallScene` 既有口径）；desktop 无 mode 文案展示场景，仅需类型引用契约与 `imageUpload.ts` 按 `local`/非 `local` 两支分流。

### 4.2 配置模型

`system_setting` 虽是 KV 表，但新 key 仍需一条 Flyway 迁移插入种子行：bootstrap 只给已存在的 `value=NULL` 行回填环境变量（缺行直接跳过，`settings-bootstrap.ts:67-70`），`SystemSettingService.update/updateBatch` 对缺行 key 直接抛「系统配置不存在」（`settings.service.ts:253`），admin 面板的行也来自 `GET /system-settings` 列表——无种子行则后台既显示不出也保存不了。种子做法对齐 V093（`backend-ts/db/migration/V093__settings_integration_config.sql`）：`INSERT IGNORE`、`value=NULL`、`category='集成配置'`、`editable=1`，secret 行 `is_secret=1`。三组配置 + bootstrap env 种子：

| 组 | key | 说明 |
|---|---|---|
| 阿里 OSS（既有） | `oss.region`、`oss.accessKeyId`、`oss.accessKeySecret`(secret)、`oss.bucket` | 复用；`oss.sts.*` 八个 key 废弃（见 §7） |
| 腾讯 COS | `cos.region`、`cos.secretId`、`cos.secretKey`(secret)、`cos.bucket` | bucket 形如 `name-1250000000`（自带 appid 后缀）；region 如 `ap-guangzhou` |
| 华为 OBS | `obs.endpoint`、`obs.accessKeyId`、`obs.accessKeySecret`(secret)、`obs.bucket` | endpoint 如 `obs.cn-north-4.myhuaweicloud.com`（华为按 endpoint 定 region，无独立 region 字段） |

对应改动：

- 新增 Flyway 迁移（`backend-ts/db/migration/V0xx__*.sql`）：种 `cos.*` 四行、`obs.*` 四行（含 `is_secret=1` 的 secret 行），见上文；
- `SETTINGS_BOOTSTRAP_ENTRIES`（`settings-bootstrap.ts`）补 `COS_*`、`OBS_*` 环境变量映射（`COS_SECRET_KEY`/`OBS_ACCESS_KEY_SECRET` 为 secret，沿用 SETTINGS_SECRET 加密落库）；
- `types.ts`：`OssSettings` 精简（去 sts 子配置），新增 `CosSettings`、`ObsSettings`；`getOssConfig` 相应简化，新增 `getCosConfig`/`getObsConfig`（任一字段缺省返回 null → 票据服务报「未配置」）；`StorageMode` 类型按仓库约定从 `settings/types.ts` re-export（`@mao/contracts` 下沉 + 域内 re-export 保持既有 import 路径，参照 `usage/llm-call.repository.ts` 做法）；
- **保存校验同步扩值**：`SystemSettingService.validateValue` 对 `UPLOAD_STORAGE_MODE_KEY` 现只放行 `local|oss`（`settings.service.ts:900-902`，报错文案「仅支持 local 或 oss」），须与 §4.1 读侧白名单同批扩为四值，否则 admin 保存 `cos`/`obs` 会被拒；
- admin `integrationFieldCatalog.ts`：上传配置组下拉加「腾讯 COS」「华为云 OBS」两项（options 由 `Record<StorageMode,...>` 生成）；新增 cos/obs 两个配置组；`oss` 组删 STS 字段；同链路三处联动在 `SystemSettingsView.vue`——`INTEGRATION_KEYS` 删 8 个 STS key、补 cos/obs key（`SystemSettingsView.vue:288`）、`INTEGRATION_LABELS` 补两组显示名（`:308`）、`TOC_GROUPS`「文件与存储」分组补两张卡片（`:341`）；
- admin `IntegrationConfigPanel.vue`：`GROUP_BEHAVIOR.oss.testPayload` 删 STS 字段映射（`IntegrationConfigPanel.vue:210-231`），并新增 cos/obs 组的 `testApi`/`testPayload`（「测试连接」按钮按组启用，无 `testApi` 的组不显示该按钮）；
- 后端 `settings.routes.ts`：`POST /v1/system-settings/test/oss`（`settings.routes.ts:117`）删去 sts 合并逻辑与 `createAliyunAssumeRoleClient` 依赖，新增 `/test/cos`、`/test/obs`（沿用 `settings:write` 权限 + 表单 overrides 与已存值合并口径，参照 ldap/feishu 路由）；
- `settings-test.service.ts`：`testOssCredentials`（AssumeRole 试签）改为三家的连通性测试（见 §5.3）。

### 4.3 上传票据服务（替代 OssStsService）

**路由**：`POST /v1/upload/ticket`（`backend-ts/src/config/upload.routes.ts` 旁新增 `backend-ts/src/upload/`，或改造现 `oss/` 目录为 `upload/`，见 §9 实施步骤）：

```
请求：{ }            （sessionId 现阶段未参与签名，参数预留）
响应：{
  uploadUrl: string   // 含签名的完整 PUT URL
  key: string         // 对象 key：uploads/{userId}/{ts}_{sanitizedName}
  publicUrl: string   // 上传成功后的公网访问 URL（前端直接进消息）
  expiration: string  // ISO 时间戳；票据默认 10 分钟有效
}
```

**服务**：`UploadTicketService`，构造注入 `getStorageMode` + `getOssConfig/getCosConfig/getObsConfig` + signer 表：

```ts
interface StorageSigner {
  /** 纯本地 HMAC 计算，无网络调用。抛 BusinessException 表示配置缺失/非法。 */
  signPut(cfg: XSettings, key: string, expiresSeconds: number): { uploadUrl: string; publicUrl: string };
}
```

- 按 `storageMode` 分发到 `ossSigner / cosSigner / obsSigner`；mode 为 `local` 时报错（票据仅对象存储模式使用，前端 local 分支不走此路由）；
- 保留现 `OssStsService` 的瞬态重试语义已不必要——签名无网络调用，失败即配置类错误，直接返回用户可读错误（如「腾讯 COS 未配置，请在管理后台…」），对齐现 `isTransientStsFailure` 中「配置类错误立即返回」的口径；
- key 由服务端生成：`uploads/{userId}/{Date.now()}_{安全化文件名}`（文件名只保留 `[\w.\-]`，中文等替换为 `_`），比现状 `uploads/{ts}_{name}` 多一层 uid 隔离；
- 旧路由 `POST /v1/oss/sts-token` 删除（见 §7 迁移说明）。

**限流/权限**：全局 preHandler 鉴权钩子（`app-hooks.ts`，非公开路径未登录直接 401）自动覆盖新路由；处理器内仍显式 `requireUserId`（对齐现 `oss.routes.ts` 做法）；Audit 拦截器既有规则无需新配置。

### 4.4 前端统一上传器

`desktop/src/utils/ossUpload.ts` 改造为 `objectStorageUpload.ts`：

- 删除 `ali-oss` import 与 `uploadToOss`；`StsToken` 类型删除；
- 新增 `uploadViaTicket(file, ticket): Promise<string>`：`XMLHttpRequest`（保留上传进度能力）`PUT ticket.uploadUrl`，body 为 File，`Content-Type` 设为票据签名时锁定的 MIME；
- `normalizeImageForUpload`（MIME 探测 + 扩展名补齐）保留不动；
- `imageUpload.ts` 分支收敛为两支：`local` → multipart 上传（现状不动）；`object`（oss/cos/obs）→ `POST /upload/ticket` → `uploadViaTicket` → `ticket.publicUrl`。**前端不再出现逐厂商 if/else**；
- 依赖变更：`desktop/package.json` 移除 `ali-oss`，同步删除本地类型声明 `desktop/src/types/ali-oss.d.ts`。

### 4.5 上传流程（新）

```
ChatInput 选图 → getUploadConfig()（60s 缓存）
  ├─ local:  POST /v1/files/upload (multipart) → 服务端落盘 {uploadDir}/{uid}/ → /uploads/ URL
  └─ oss|cos|obs: POST /v1/upload/ticket → { uploadUrl, key, publicUrl }
                  XHR PUT uploadUrl（直传 bucket，数据不过后端）→ 消息里写 publicUrl
```

## 5. 各云签名实现要点

三家签名均为公开文档化的本地 HMAC 计算，**手写实现、零新增依赖**（不引入 `cos-nodejs-sdk-v5` / `esdk-obs-nodejs`，签名器各 ~60-100 行）：

| 云 | 签名算法 | URL 形态 | 关键参数 |
|---|---|---|---|
| 阿里 OSS | V4 签名（HMAC-SHA256 签名密钥链） | `https://{bucket}.oss-{region}.aliyuncs.com/{key}?x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-credential=…&x-oss-date=…&x-oss-expires=600&x-oss-signature=…` | `x-oss-content-sha256: UNSIGNED-PAYLOAD` 参与签名；Content-Type 签入 |
| 腾讯 COS | 请求签名（HMAC-SHA1 两层：SignKey→HttpString→StringToSign→Signature） | `https://{bucket}.cos.{region}.myqcloud.com/{key}?q-sign-algorithm=sha1&q-ak=…&q-sign-time=start;end&q-key-time=…&q-header-list=content-type&q-url-param-list=&q-signature=…` | KeyTime 即有效期区间；单次 PUT 上限 5GB（图片场景无虞） |
| 华为 OBS | URL 授权（HMAC-SHA1，S3 V2 风格） | `https://{bucket}.{endpoint}/{key}?AccessKeyId=…&Expires={epoch}&Signature=…` | 官方最佳实践文档即推荐「预签名 URL PUT 直传」；最大有效期 7 天（本次 10 分钟） |

参考文档：
- 阿里 OSS V4 签名：https://help.aliyun.com/zh/oss/developer-reference/include-the-v4-signature-in-a-url
- 腾讯 COS 请求签名：https://cloud.tencent.com/document/product/436/7778 ；预签名授权上传：https://cloud.tencent.com/document/product/436/68284
- 华为 OBS 预签名直传最佳实践：https://support.huaweicloud.com/bestpractice-obs/obs_05_1203.html

**正确性验证策略**：每个签名器写对拍单测——用官方 SDK（临时 devDependency，或一次性脚本）对同一组 (cfg, key, expires) 生成预签名 URL，与手写实现逐参数比对；官方 SDK 不入 package.json。

### 5.1 签名内容锁定的边界

预签名 PUT 锁定：对象 key（URL 路径）、HTTP 方法、参与签名的头（至少 Content-Type）。**不锁定也不校验 Content-Length**——三家 PUT 预签名均无服务端大小校验。大小限制口径：

- 前端上传前按 `config.maxSizeMb` 预检——图片分支已有该检查（`ChatInput.vue` 的 `addPendingImage` 调 `checkFileSize`，超限移除占位并提示，配置在 `ChatInput.vue:693` 读取），本次无需新增；
- 票据签发时校验 `sessionId` 归属不做（与现状 sts-token 一致），残余风险为「登录用户拿票后可传超限对象到 uploads/ 前缀」——与现状 STS policy 限 `uploads/*` 相当，不劣化；后续如需强约束可演进为 POST Object policy（三家均支持，本次不做）。

### 5.2 CORS（部署要求，三家一致）

直传受 bucket CORS 约束（现状 ali-oss 直传同样需要，非新增负担）。DEPLOY.md 补齐三家配置口径：

- AllowedOrigin：桌面/Web 域名（及 `http://localhost:*` 供开发）；
- AllowedMethod：`PUT`；AllowedHeader：`content-type`；
- 阿里 OSS 控制台 / 腾讯 COS 控制台 / 华为 OBS 控制台均有 CORS 配置入口。

### 5.3 连通性测试（admin「测试」按钮）

每云一组：用当前（表单合并后）配置对固定探针 key `uploads/.mao-probe` 签发 60s 预签名 PUT，真实 `fetch PUT` 一个 <1KB 内容，再按需 `DELETE` 探针对象（成功即证明：AK/SK 有效、bucket 存在且可写、URL 域名正确）。相比现 OSS 的 AssumeRole 试签（只验凭证不验 bucket 权限），新测试验证得更完整。

## 6. 安全与权限

- **最小权限**：预签名一票一对象，key 由服务端生成且含 userId 前缀，用户无法签出 `uploads/` 前缀之外的写权限；建议管理员为三家均配置只含 `{bucket}/uploads/*` PutObject/DeleteObject 的子账号/策略（DEPLOY.md 口径），比阿里 STS roleArn+policy 更简单；
- **凭证存储**：`cos.secretKey` / `obs.accessKeySecret` 沿用 `secret: true` 的 SETTINGS_SECRET AES-GCM 加密落库（对齐 `oss.accessKeySecret` 既有口径）；
- **票据时效**：默认 600s，写死为常量（不开放配置，避免「配置成 7 天」之类的误用）；
- **publicUrl 可读性**：图片 URL 直接进消息供 LLM 多模态读取，延续现状「bucket 公共读」口径（三家一致），DEPLOY.md 写明；私有桶签名 GET 不在本次范围。

## 7. 兼容与迁移

存量已配 `oss` 的实例：

1. `storageMode='oss'` 语义不变（仍是阿里 OSS），但内部链路 STS 直传 → V4 预签名直传；
2. 使用的凭证从 STS 子账号（`oss.sts.accessKeyId/Secret`）切换为 bucket 主 AK/SK（`oss.accessKeyId/accessKeySecret`）——**管理员需确认该 AK/SK 对目标 bucket 有 PutObject 权限**（多数实例本就是主账号 AK/SK，无感知）；RELEASE NOTE 明确提示；
3. `oss.sts.*` 八个 setting key（regionId/endpoint/accessKeyId/accessKeySecret/roleArn/roleSessionName/expire/maxSizeMb）：后端不再读取（`getOssConfig` 删除 sts 子结构），admin 面板删除对应字段（catalog + `SystemSettingsView.vue` 的 `INTEGRATION_KEYS` + `IntegrationConfigPanel.vue` 的 testPayload 映射）；DB 行保留不清理（KV 表，无害），bootstrap entries 同步移除（V093 种的行不动，历史可回溯）。其中 `oss.sts.maxSizeMb` 现状即未被任何代码消费（V093 描述「预留，暂未生效」，前端预检一直用 `file.maxSizeMb`），废弃无行为差异；
4. `POST /v1/oss/sts-token` 与 `OssStsService`、`@alicloud/sts20150401` 依赖删除（接线点：`create-app.ts:612` 服务构造、`app-routes.ts:285,624` 路由注册）。正在升级中的旧桌面端拿 404 后：`imageUpload.ts` 对 ticket/STS 接口的失败提示已按「拦截器 toast + 兜底 toast」处理，行为为「上传失败提示」，不阻断文本消息；新旧前端均部署在同一后端版本之后，窗口期内若用户停留在旧前端仅图片上传不可用（与「管理员切换存储模式」的既有影响面一致，可接受）。**mao-cli 同步**：`mao oss sts-token` 子命令直接调该接口（`skills/mao-cli/lib/commands/oss.js` 调 `/oss/sts-token`，`lib/cli.js` 注册，`reference/oss.md` 与 `SKILL.md` 索引行引用），须随本方案改造（改指 `/v1/upload/ticket` 并同步文档）或删除子命令，不能留 404 接口；
5. 前端 `getUploadConfig` catch 回落 `'oss'` → `'local'`：未配置对象存储的实例在后端不可达时自动落本地盘语义，修复现状「回落 oss 但 sts-token 必然失败」的隐性坑。

## 8. 不做（明确排除）

| 排除项 | 原因 |
|---|---|
| 非图片文件、LOCAL 附件、微信素材接入对象存储 | 与 storageMode 无关，链路语义不同（需要 `@{absolutePath}@` 或本地路径），另行立项 |
| 分片上传 / 大文件 | 图片场景单 PUT 足够；COS 单 PUT 上限 5GB |
| 私有桶 + 签名 GET 下载 | 延续公共读口径，URL 进消息给 LLM 的既有设计不变 |
| 后端代理上传/下载 | 直传数据不过后端是本次选型前提 |
| 前端云厂商 SDK（cos-js-sdk-v5 / esdk-obs-browserjs） | 统一 PUT 上传器后无必要；华为 SDK 停更 |
| STS 临时凭证路线 | 见 §3 选型结论 |
| 历史已上传到旧 OSS 的存量图片迁移 | publicUrl 已写进历史消息，指向原 bucket 继续有效 |

## 9. 实施步骤

**Phase 1：契约与统一链路（含阿里 OSS 迁移）**
1. `shared/contracts/src/storage.ts` 加 `StorageMode` 并入 `index.ts` 导出；backend/desktop/admin 三处引用（desktop `UploadConfig`、admin options 汉化表、backend `UploadSettings` 从 `settings/types.ts` re-export）；`validateValue` 的 storageMode 保存校验同步扩四值（§4.2）；
2. 新建 `backend-ts/src/upload/`：`storage-signer.ts`（接口 + ossSigner）、`upload-ticket.service.ts`、`upload.routes.ts`（`POST /v1/upload/ticket`，在 `app-routes.ts` 与 `registerUploadRoutes` 同处注册）；对拍单测；
3. `settings/types.ts` 精简 `OssSettings`、`getOssConfig`；bootstrap 移除 `oss.sts.*` 八行；admin oss 组删 STS 字段（catalog + `SystemSettingsView.vue` 三处 + `IntegrationConfigPanel.vue` `GROUP_BEHAVIOR`）；`settings.routes.ts` test/oss 重做（§4.2）；`settings-test.service.ts` OSS 测试改探针 PUT；
4. desktop `ossUpload.ts` → `objectStorageUpload.ts`（PUT 上传器），`imageUpload.ts` 接 ticket，删 `ali-oss` 与 `desktop/src/types/ali-oss.d.ts`；
5. 删 `oss/oss-sts.service.ts`、`oss.routes.ts`、`@alicloud/sts20150401`（含 `create-app.ts` / `app-routes.ts` 两处接线）；`oss` 目录并入 `upload/`；mao-cli `oss sts-token` 同步处理（§7-4）；回归 `cd backend-ts && npm test`、两端 `npm run build`。

**Phase 2：腾讯 COS**
1. settings 四件套（Flyway 种子行 / types / service getter / bootstrap）+ admin cos 配置组（catalog、`INTEGRATION_KEYS/LABELS/TOC_GROUPS`、`GROUP_BEHAVIOR`）+ `/test/cos` 路由与连通性测试；
2. `cosSigner` + 对拍单测；`storageMode='cos'` 全链路手工验收；
3. Playwright `admin-settings-integration.spec.ts` 补 cos 卡片断言（如需）。

**Phase 3：华为 OBS**
1. 同 Phase 2 结构：`obsSigner` + obs 配置组（含种子行与 `/test/obs`）+ 测试；
2. `obs.endpoint` 与 bucket 的域名拼接对拍验证（华为 endpoint 已含 region 信息）。

**Phase 4：文档与发布**
1. `README.md` / `DEPLOY.md`：存储模式四值、三家 bucket 公共读 + CORS + 子账号最小权限配置口径；
2. `changelog/unreleased/2026-11-xx-storage-multi-cloud.md`（backend-ts→后端、admin→管理后台、desktop 共用 UI→前端、desktop/electron→桌面 Electron 按实际改动分节）。

## 10. 测试计划

| 层 | 内容 |
|---|---|
| 单测（backend-ts Vitest） | 三个 signer 对拍官方 SDK 签名结果（固定 cfg/key/expires 向量）；`UploadTicketService` 分发/未配置报错/key 生成与文件名安全化；`getUploadConfig` 白名单与回落；settings-test 三云探针 |
| 单测（desktop Vitest） | `uploadViaTicket` 成功/失败/进度；`imageUpload` 按 mode 分流（mock config）；`getUploadConfig` 回落 `local` |
| E2E（Playwright） | admin 集成面板新卡片渲染、掩码、保存；既有用例不回归。已核实 `tests/admin-settings-integration.spec.ts` 不因本次改动而破：卡片标题「OSS 对象存储」不变，round-trip 用例锚定 oss 卡片第一个输入（仍为 `oss.region`，删 STS 字段不影响首位）；新增 cos/obs 卡片可按需补断言（Phase 2-3） |
| 手工验收 | 三云各配真实 bucket：上传 PNG/JPG/WebP → 消息 URL 可访问 → LLM 读图成功；大小超限预检提示；CORS 未配置时的报错文案可定位（浏览器 console + 用户 toast） |
| 构建验证 | `cd backend-ts && npm run build && npm test`；`desktop/admin npm run build`（`vue-tsc -b`，勿用 `npx vue-tsc --noEmit`） |

## 11. 风险与对策

| 风险 | 对策 |
|---|---|
| 手写签名实现出错（三家算法细节，如 V4 的 additional-headers 编码、COS 的 q-header-list 排序） | 对拍单测 + Phase 内逐云真桶验收；签名器彼此独立，单云故障不影响其他模式 |
| 存量实例主 AK/SK 无 PutObject 权限 | RELEASE NOTE 迁移提示 + admin 测试按钮一键验证（探针 PUT 即真实写权限验证） |
| bucket 未配 CORS，直传失败报错难懂 | DEPLOY.md 部署清单 + 失败 toast 文案指明「检查 bucket CORS」 |
| OBS endpoint 误填内网/专线域名 | 预签名 URL 与消息里的 publicUrl 同 host，内网 endpoint 会使桌面/Web 端不可达；DEPLOY.md 明确要求填公网 endpoint，admin 字段 hint 同步提示 |
| 预签名无服务端大小校验 | 前端 maxSizeMb 预检；残余风险与现状 STS policy 相当（§5.1） |
| `oss.sts.*` 废弃后管理员困惑 | admin 组内 hint 注明「STS 配置已废弃，无需填写」；DB 行保留可回溯 |
