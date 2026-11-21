### 后端

- **图片附件存储模式扩展为四值**：`local / oss / cos / obs`，新增腾讯云 COS 与华为云 OBS；三家对象存储统一为「服务端签发预签名 PUT 票据（`POST /v1/upload/ticket`）+ 前端直传」，key 由服务端生成（`uploads/{userId}/{ts}_{name}`）、一票一对象、10 分钟有效；新路由需登录，票据仅面向图片 MIME（PNG/JPG/GIF/WebP）
- **下线阿里云 STS 直传链路**：删除 `POST /v1/oss/sts-token` 与 `@alicloud/sts20150401` 依赖；存量 `oss` 模式改用 `oss.accessKeyId/Secret` 主 AK/SK 做 V4 预签名（`oss.sts.*` 八项配置废弃，DB 行标记废弃不再读取；请确认主 AK/SK 对 bucket 有 PutObject 权限，可用「测试连接」探针验证）
- **V201 迁移**：种 `cos.*` / `obs.*` 八行配置（密钥行加密存储），随启动自动执行；`UPLOAD_STORAGE_MODE` / `COS_*` / `OBS_*` 环境变量仅升级首次启动自动导入
- **存储连通性测试改探针**：`settings test oss` 重做为真实预签名 PUT 探针（验证凭证 + bucket 写权限，比原 STS 试签更完整），新增 `cos` / `obs` 两个测试目标
- **存储模式枚举下沉 `@mao/contracts`**（`StorageMode`），后端保存校验与前端回落值同步收口（配置不可达时回落 local）

### 前端（桌面 / Web / 安卓）

- **统一对象存储直传上传器**：按存储模式领票据后 `PUT` 直传（前端不感知具体云厂商），移除 `ali-oss` 依赖（安装包体积相应减小）；本地存储模式链路不变；`getUploadConfig` 取不到配置时回落本地存储

### 管理后台

- **「文件与存储」新增腾讯云 COS / 华为云 OBS 配置组**（含连通性测试按钮），上传配置的存储模式下拉扩为四项；阿里云 OSS 组精简为 Region / Bucket / AK / SK（STS 字段移除）

### 终端 CLI（mao-cli）

- **`mao oss sts-token` 下线**，替换为 `mao oss ticket`（申请预签名上传票据）；`mao settings test` 新增 `cos` / `obs` 目标，`oss` 目标移除 STS 参数
