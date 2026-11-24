### 后端

- **公司 SSO 换票凭证注入 Agent 任务**：company-sso 换票成功后按用户加密保存本次提交的公司 token（V206 `user_company_sso_token`，每次换票覆盖）。该用户之后的 CLOUD Agent Shell 在每条命令前注入 `COMPANY_SSO_TOKEN`，容器内 Shell 与 MCP 经会话 envelope 下发，云端终端在创建时注入。票过期或该用户没有换票记录时不再注入，并清掉 Shell 会话里的旧值；查询失败时保留会话里已有的值。LOCAL 本机执行和信号哨兵脚本不注入。`COMPANY_SSO_TOKEN` 为平台保留变量，三层环境变量不能覆盖。

### 前端（桌面 / Web / 安卓）

- **环境变量页拒绝配置 `COMPANY_SSO_TOKEN`**：与后端保留键对齐，用户层和工作区层都不能手填这张公司 SSO 票。

### 管理后台

- **系统 Shell 环境变量拒绝配置 `COMPANY_SSO_TOKEN`**：与后端保留键对齐。
