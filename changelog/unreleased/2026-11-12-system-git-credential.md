### 后端

- **系统默认 Git 凭据**：管理员可按域名托管系统默认 Access Token（新增 `system_git_credential` 表，V194，AES 加密存储，与用户凭据共用 `APP_GIT_CREDENTIAL_SECRET`）。凭据解析升级为逐域兜底：用户配了某域 Token 用用户的，未配置的域自动使用系统默认（合并顺序默认在前、用户在后）；系统默认同样受 Agent「允许域」白名单与全局宽松/严格策略约束（严格策略与显式禁止下默认也不注入）。新增管理端 CRUD `GET/POST/PUT/DELETE /v1/admin/git-default-credentials`（`settings:read`/`settings:write`，列表恒掩码 `****`，写操作进审计日志）、全站域枚举 `GET /v1/admin/git-domains`（`agent:read`，用户凭据域 ∪ 系统默认域）与用户端 `GET /v1/user/git-default-credentials`（仅域名与备注，不含 Token）。

### 管理后台

- **系统设置新增「Git 默认凭证」面板**：按域名增删改系统默认 Token（编辑留空不改 Token、删除行内二次确认），提示建议配置只读 Token。
- **Agent 表单「允许域」候选改为全站枚举**：从「当前管理员个人凭证域」切换为用户凭据域 ∪ 系统默认域（需 `agent:read`），解决系统默认域选不到的缺口；加载失败仍可手工输入。

### 前端（桌面 / Web / 安卓）

- **「Git 凭证」设置页展示系统默认覆盖情况**：页头说明系统默认兜底口径；新增「系统默认」灰色行区（域名 + 备注徽标，仅展示不可编辑），已配置同域个人 Token 的域自动隐藏灰行。
