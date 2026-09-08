# 公司 SSO 接入验证说明

## 自动化验证

实现涉及官方 checkToken 适配器、账号关联、换票、SDK 与 WS 续期。测试使用合成凭证和模拟 SSO 响应，不复用聊天中提供的真实凭证。

标准命令：

```bash
cd backend-ts && npm run build && npm test
cd ../sdk/embed && npm test && npm run build && npm run size
cd ../../desktop && npm run build
cd ../admin && npm run build
```

具体执行结果和代码审查轮次见开发交付说明及 `docs/code-review/`。测试错误输出中出现模拟的认证失败或网络失败属于错误路径测试，不能据此认定实际调用了公司 SSO。

## 本次开发验证结果（2026-09-07）

- 后端：构建通过；完整测试 168 文件通过、1490 项通过，另 12 项真实 MySQL 测试跳过。后续审查修复仅涉及 SDK，未改变后端 SSO 实现。
- SDK：最终 15 文件、155 项测试通过，TypeScript/Vite 构建通过；size-limit 73.38 kB，低于 200 kB 上限。
- desktop/admin：构建通过；desktop 已重新生成并同步两份 public/embed SDK 产物。构建仍有大 chunk 等警告。
- 同一 reviewer 完成 4 轮审查：前三轮报告中的 R1–R7 均已修复并补回归测试；第 4 轮未发现可触发功能 bug，按要求不新增空报告。
- 修复覆盖 WS 到期恢复、同账号订阅/历史恢复、首次临时故障恢复、Retry-After 冷却、切换账号及缓存重连的期限绑定、迟到 401 不误停新票，以及隐藏期间恢复后重新展开。
- 本轮未提交、推送或部署；审查结论不替代下述真实 MySQL 与公司 SSO 上线前联调。

## 动态校验地址增量验证（2026-09-07）

- `auth.checkUrl` 必填，换票 JSON 传入；`SSO_ALLOWED_DOMAINS` 取代固定地址配置。支持域名自身及任意层级子域，域名信任由配置人员决定，不新增 DNS 私网过滤。
- 后端完整构建/测试通过：169 文件、1576 项通过，12 项 MySQL 测试仍跳过。SDK 17 文件、170 项通过，构建通过；size-limit 75.34 kB / 200 kB。计数包含工作区并行任务新增测试。
- desktop 构建通过并同步 SDK 产物；本增量未更改 admin。
- 复用原 reviewer 完成增量第 1 轮审查，无新增可触发 bug，不创建空报告。额外离线跨端验证覆盖首次换票、并发合并、续期保持实际 path/query、欺骗域拒绝；存储与上游为 mock，不代表真实联调。

## 管理后台配置迁移验证（2026-09-08）

- 公司 SSO 配置迁至后台「系统设置 → 集成配置 → 公司 SSO」，V107 新增 `auth.companySso.config`，保存完整五字段 JSON；不读取或导入旧 SSO 业务环境变量。测试隔离 socket 开关仅供测试使用，保持不变。
- 后端 `npm run build && npm test` 通过：171 文件、1615 项通过，12 项真实 MySQL 测试仍跳过。V107 已通过迁移加载的 mock 测试，未在真实 MySQL 执行。
- 管理后台 `npm run build` 通过；根目录 `npm run test:admin -- admin-company-sso.spec.ts` 16 项通过，API 全部 mock，覆盖字段校验、权限、缺失/损坏值禁止保存、完整提交、失败保留输入。
- 复用原 reviewer 完成本次迁移第 1 轮审查，无新增可触发 bug，不生成空报告。复核请求配置快照、动态启停/白名单/TTL/timeout、限流不重置、配置失败拒绝换票及不影响普通 REST。
- 补充全仓测试源码 `tsconfig.json` 类型检查因范围外 spec 类型错误未通过；标准后端生产构建与管理端类型检查均通过，未修改无关测试。
- 未部署或执行真实 SSO/数据库联调。发布后须先完成 V107 迁移，再由管理员填写配置（默认关闭，旧环境变量不导入）。

## 隔离 MySQL 集成测试

`backend-ts/src/auth/company-sso.mysql.integration.spec.ts` 默认跳过，只有显式设置 `SSO_TEST_MYSQL_SOCKET` 才执行。它不加载应用数据库配置，要求独立 `sso-mysql-*` 目录下的真实 Unix socket、MySQL 关闭网络监听，使用随机新建的测试数据库，并只删除该测试数据库。

测试包含12项：V106迁移、同身份和同邮箱并发、普通账号关联、管理员/禁用/删除拒绝、事务回滚与用户邮箱写入竞态。

在安全策略允许的独立测试环境中执行：

```bash
# 由测试环境管理员准备隔离、无网络的 MySQL 8 实例，不指向生产或默认 socket。
cd backend-ts
SSO_TEST_MYSQL_SOCKET=/absolute/test-root/sso-mysql-unique/mysql.sock \
  npm test -- --coverage.enabled=false src/auth/company-sso.mysql.integration.spec.ts
```

当前云端在 `/opt/mao-data/runtime/2/1809/sso-mysql-*` 初始化 mysqld 被 AppArmor 拒绝，未绕过策略，未启动数据库。**12项真实数据库测试尚未通过验证，默认 skip 不能计为通过。** 此项是上线前必须补齐的验证。

## 公司 SSO 上线前联调

- 校验成功、Token到期、撤销、员工停用、服务不可用及 `illegal` 实际含义。
- 确认 `claims.id` 永不复用、邮箱已验证且不重分配；不使用用户名替代稳定ID。
- 当前已知失败仅包含 `illegal=true` 和已过期 claims；未知上游格式返回503并拒绝换票，不能仅靠成功样例认定停用即时生效。
- 确认反向代理精确可信IP、Origin白名单、CSP、公司 SSO query日志脱敏。
- 连续使用超过两个TTL，确认真实发生换票与 WS 更新；验证断网、恢复、休眠、账号切换和并发页签。
- 检查迁移前存量邮箱冲突，不自动合并管理员或数据。
- 验证已签发 access 到期窗口，以及现有 shell/终端凭证不参与统一撤销的边界。

未执行生产部署或公司真实接口请求。上述外部验证完成前，不应将该实现标记为生产接入已验收。
