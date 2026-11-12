# 系统默认 Git 凭据（管理员默认 Token 兜底）技术方案

> **文档版本**：v1.1
> **日期**：2026-11-12
> **状态**：已评审（同日评审结论：需求与方案均可行；v1.1 修正迁移号冲突（V193 已被同日 admin-memory-manage 占用，本期改用 V194）与 CHANGELOG 条目口径，其余为评审补充，标注「评审补充」）
> **关联文档**：
> - `docs/plan/2026-11-06-agent-git-credential-scope-technical-design.md`（Agent 级 Git 凭据域收敛：白名单 + 全局策略）
> - `docs/plan/design/user-git-credential-design.md`（用户级 Git Token 原始设计）
> - 迁移 `V047__add_user_git_credential.sql`、`V187__agent_git_allowed_domains.sql`

---

## 1. 背景

当前 Git 凭据完全按用户隔离：用户在桌面端「设置 → Git 凭证」按域名配置自己的 Access Token（`user_git_credential`，AES 加密落库），未配置的用户在云端模式下无法 clone 私有仓库，Agent Shell 里的 `git push/pull` 也无法认证。

实际使用中，绝大多数用户对大多数 Git 站点只需要**读**权限；让每个用户都去申请、配置一遍 Token 是重复劳动，也让新用户上手门槛偏高。

本期引入**系统默认 Git 凭据**：管理员在管理后台按域名配置一组默认 Token（典型是只读 Token，可配置多个域名）。凭据解析时逐域兜底——**用户自己配了某个域的 Token 就用用户的，没配的域自动使用系统默认**；用户想获得更高权限（如写），只需为自己配置该域 Token 覆盖默认即可。

## 2. 目标与非目标

### 2.1 目标

1. 管理员在管理后台配置系统默认 Git 凭据：按域名、可多条、Token 加密存储、列表脱敏回显。
2. 凭据解析口径升级为「**Agent 允许域内逐域兜底**」：用户 Token 优先，缺失域由系统默认补齐。
3. 系统默认凭据**同样受 Agent「允许域」白名单约束**（与 2026-11-06 方案同一条闸，不做例外）。
4. 管理后台 Agent 表单的「允许域」候选域名改为**全站枚举**（用户凭据域 ∪ 系统默认域），解决「只存在于系统默认里的域选不到」的缺口。
5. 用户端「Git 凭证」页展示系统默认覆盖情况：一句说明 + 系统默认域的灰色行（仅展示，不可编辑）。

### 2.2 非目标

| 项 | 说明 |
|---|---|
| 改动注入链路 | 六条注入通道（见 §3.2）零改动，仍只消费 `{domain: token}` 映射 |
| Token 权限校验 / 健康检查 | 不校验默认 Token 是否只读、是否过期，由 Git 服务端裁决，错误原样透传 |
| 强制"默认只读" | 系统不区分读/写 Token，管理员自行保证（文案提示"通常为只读"，不断言） |
| per-Agent 的默认凭据开关 | 不做；域级白名单已是足够细的控制粒度 |
| SSH 协议行为 | 不变，仍只处理 HTTPS |
| 审计新表 / 使用计量 | 不新增审计表；沿用 `[git-scope]` 结构化日志（来源与数量，不含明文） |

## 3. 现状（代码事实）

### 3.1 数据与加密

- `user_git_credential`（`V047`）：`user_id + domain` 唯一，`access_token` 为 AES 密文；域名写入前经 `common/git-domain.ts` 的 `normalizeAndValidateGitDomain`（trim + 小写 + 去协议/路径 + 格式校验）。
- 加解密：`crypto/aes-cbc.ts` 的 `encryptAesCbc / decryptAesCbc`，密钥来自 `cfg.app.gitCredential.secretKey`（环境变量 `APP_GIT_CREDENTIAL_SECRET`，启动时 `assertGitCredentialSecret` 校验非空）。
- 服务：`user/git-credential.service.ts` 的 `GitCredentialService`——CRUD + `getTokenMapByUser(userId)`（全量解密）+ `getTokenMapByUserFiltered(userId, domains)`（SQL `WHERE domain IN (...)`，空数组直接短路）+ `envVarNameForDomain`（`GIT_TOKEN_<domain>` 命名，`.`/`-` → `_`）。

### 3.2 解析器与六条注入通道

`user/git-token-resolver.ts` 的 `DefaultGitTokenResolver` 是**唯一凭据数据源**（技术方案 2026-11-06）：

- `resolveForSession(userId, sessionId)`：查 session → `owner` 或 `lastRuntimeUserId` 命中才放行 → 委托 `resolveForAgent`；任一步故障 fail-closed（返回 `{}` + warn）。
- `resolveForAgent(userId, agentId)`：
  - `agentId == null`（无 Agent 上下文）：全局策略 `gitToken.scopePolicy` 宽松 → 用户全部 Token；严格 → 空；
  - `agent.git_allowed_domains` 为 `NULL`（未配置）：同上按策略兜底；
  - `'[]'`（显式禁止）→ 空；
  - 非空白名单 → `getTokenMapByUserFiltered(userId, allowed)` 求交集；
  - 任何异常 → `{}` + warn。
- 装配：`create-app.ts`，`new DefaultGitTokenResolver({ gitCredentialService, agentLookup: agentRepo, sessionLookup: sessionRepo, scopePolicy: settingService })`。

六条注入点（全部消费 `resolveForSession` 的返回值，形态 `{domain: token}` → `GIT_TOKEN_*` env + `GIT_ASKPASS`）：

| # | 通道 | 位置 |
|---|---|---|
| 1 | Agent Shell 首次创建 | `harness/tool/impl/shell-session-tool.ts` → `harness/shell/shell-session-manager.ts` |
| 2 | Agent Shell 每条命令前刷新 | `shell-session-tool.ts` → `refreshUserEnvironment`（按前缀全清后重注） |
| 3 | 容器 envelope → 容器内 shell | `harness/container/session-envelope-builder.ts` → `container-tool-executor.ts` |
| 4 | 容器 MCP stdio 子进程 | `session-envelope-builder.ts` → `container-mcp-bridge.ts` |
| 5 | 云端交互终端 | `harness/terminal/terminal-manager.ts` |
| 6 | 建会话 clone | `session/git-operation.service.ts` |

### 3.3 管理端现状与相关机制

- 用户端凭证：`GET/POST/PUT/DELETE /v1/user/git-credentials`（`user/git-credential.routes.ts`），响应中 `accessToken` 恒为 `****`（`toVO`）。
- 管理端：`/v1/admin/users/:id/git-credentials` 仅支持按用户查看/删除（`user:read` / `user:write`），无系统级凭据概念。
- Agent 表单「允许域」候选：`admin/src/views/agent/AgentFormDialog.vue` 通过 `GET /user/git-credentials` 取**当前管理员自己**的凭证域名（2026-11-06 D4「不做全站枚举接口，避免横向枚举面」），加载失败可手工输入域名。
- 系统设置 secret 行机制（`system_setting.is_secret` + AES-GCM + `SECRET_MASK`）存在，但一条 key 只能承载一个值，多域名需管理员手写 JSON、且无按行增删改的 UI——不适合作为多域凭据的托管形态。
- 错误码：`GIT_CREDENTIAL_NOT_FOUND`(3021)、`GIT_CREDENTIAL_DOMAIN_DUPLICATE`(3022)、`PARAM_INVALID` 可复用。
- 最新迁移版本：`V193`（`V193__memory_admin_manage.sql`，2026-11-12 管理后台记忆管理任务已占用）；**本期新迁移为 `V194`**（v1.0 误写 V193，Flyway 重复版本号会导致启动失败）。

## 4. 设计决策（对话结论）

| # | 决策 | 说明 |
|---|---|---|
| D1 | **逐域兜底**，而非"用户没配任何 Token 才给默认" | 用户在 git.acg.team 配了自己的写权限 Token，只覆盖该域；其余域继续用系统默认 |
| D2 | 系统默认凭据**同样受 Agent「允许域」白名单约束** | 白名单管"哪些域可注入凭据"，放行后才轮到"用户优先、默认兜底"，避免同一域出现"用户 Token 被拦、默认却漏进去"的不一致 |
| D3 | 存储用**独立表 + 后台管理面板**（支持多域），不复用 `system_setting` secret 行 | secret 行一行一值，多域需手写 JSON，编辑体验差 |
| D4 | Agent 表单「允许域」候选改为**全站枚举**（替代 2026-11-06 的 D4 决策） | 原"避免横向枚举"的收益低于"选不到域"的成本；改由管理员权限（`agent:read`）守门，仅返回域名 |
| D5 | 用户端凭证页**一句说明 + 系统默认域灰色行** | 让用户知道哪些域被兜住；添加同域凭证即覆盖 |
| D6 | **不额外收窄**"默认 Token 可被 `echo $GIT_TOKEN_*` 读出"的暴露面 | 注入机制固有边界，白名单即现有闸；管理员只配只读 Token + 可轮换（记入 §7） |
| D7 | 用户自有 Token 失效时**不回落默认** | 回落会让写操作/读操作静默切换身份，报错更诚实 |

## 5. 方案设计

### 5.1 凭据解析口径矩阵

记 A、B 为域名：用户持有 A 的 Token（`U_A`），系统默认覆盖 B（`S_B`）。

| Agent 允许域 | 策略 | 用户域 | 系统默认域 | 注入结果 |
|---|---|---|---|---|
| `NULL`（未配置） | lenient | A | B | `A: U_A` + `B: S_B` |
| `NULL` | strict | A | B | `{}`（默认凭据同样不注入） |
| `'[]'` | 任意 | A | B | `{}` |
| `["A","B"]` | 任意 | A | B | `A: U_A`（用户优先）+ `B: S_B` |
| `["A"]` | 任意 | A | B | `A: U_A`（B 不在白名单，默认也不注入） |
| `["B"]` | 任意 | 无 | B | `B: S_B` |
| 任意 | 任意 | A | A | `A: U_A`（同域用户覆盖默认） |
| 任意 | 任意 | 无 | 无 | `{}` |

合并顺序：**默认在前、用户在后**（`{...defaults, ...user}`），同域用户 Token 覆盖默认；合并发生在白名单过滤之后，默认凭据只按白名单域查询（不做全量解密）。

### 5.2 数据模型：`system_git_credential`（V194）

新增迁移 `backend-ts/db/migration/V194__system_git_credential.sql`：

```sql
CREATE TABLE IF NOT EXISTS `system_git_credential` (
    `id`           BIGINT PRIMARY KEY AUTO_INCREMENT,
    `domain`       VARCHAR(255) NOT NULL COMMENT 'Git 服务器域名，如 git.acg.team',
    `access_token` VARCHAR(2048) NOT NULL COMMENT 'Access Token（AES 加密存储）',
    `description`  VARCHAR(512) NULL COMMENT '备注，如「只读 Token，写权限请联系 XX」',
    `created_at`   DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`   DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY `uk_system_git_domain` (`domain`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='系统默认 Git 凭据（管理员配置，用户未配置该域时兜底）';
```

- 与 `user_git_credential` 同款加密口径：`encryptAesCbc / decryptAesCbc` + `APP_GIT_CREDENTIAL_SECRET`，**不引入新密钥**。
- 不挂用户、不建外键；无种子数据（表空 = 功能未启用，行为与现状完全一致）。
- 域名写入前统一经 `normalizeAndValidateGitDomain`。

### 5.3 服务层：`SystemGitCredentialService`

新增 `backend-ts/src/user/system-git-credential.service.ts`，结构对齐 `GitCredentialService`：

| 方法 | 说明 |
|---|---|
| `list(): Promise<SystemGitCredential[]>` | 全量列表（供管理面板，token 由路由层脱敏） |
| `create(domain, accessToken, description?)` | 域名规范化 + 格式校验；重复域抛 `GIT_CREDENTIAL_DOMAIN_DUPLICATE`；空 Token 抛 `PARAM_INVALID` |
| `update(id, accessToken?, description?)` | Token 留空（`null/undefined/空串`）不修改；备注口径与 `GitCredentialService.update` 一致（评审补充）：`description` 缺省/null 不改，传空串清空 |
| `delete(id)` | 不存在抛 `GIT_CREDENTIAL_NOT_FOUND` |
| `getTokenMap(): Promise<Map<string, string>>` | 全量解密（lenient 无白名单路径使用） |
| `getTokenMapFiltered(domains: string[]): Promise<Map<string, string>>` | `WHERE domain IN (...)`；空数组直接返回空 Map（防 `IN ()` 非法 SQL） |
| `listDomains(): Promise<string[]>` | `SELECT DISTINCT domain ... ORDER BY domain`（供全站域枚举与用户端提示） |

解密失败口径：**逐行跳过 + warn 日志（只记域名，不记密文/明文）**，不因单行脏数据拖垮整张表——与 `EnvVariableService` 的解密失败处理一致（`src/env/env-variable.service.ts`，评审核对）。用户凭据侧维持现状（`getTokenMapByUser` 抛错由 resolver 外层兜底为空集）。

### 5.4 后端 API

新增 `backend-ts/src/user/system-git-credential.routes.ts`，在 `app-routes.ts` 中与 `registerGitCredentialRoutes` 相邻注册。

| 方法 | 路径 | 权限 | 说明 |
|---|---|---|---|
| GET | `/v1/admin/git-default-credentials` | `settings:read` | 列表；每项 `{id, domain, accessToken: '****', description, createdAt, updatedAt}` |
| POST | `/v1/admin/git-default-credentials` | `settings:write` | Body `{domain, accessToken, description?}` |
| PUT | `/v1/admin/git-default-credentials/:id` | `settings:write` | Body `{accessToken?, description?}`，Token 留空不改 |
| DELETE | `/v1/admin/git-default-credentials/:id` | `settings:write` | 删除 |
| GET | `/v1/admin/git-domains` | `agent:read` | 全站域枚举：`{ domains: string[] }` = `user_git_credential` 的 `DISTINCT domain` ∪ `system_git_credential` 的 `DISTINCT domain`，去重排序；不含 Token、不含用户归属 |
| GET | `/v1/user/git-default-credentials` | 仅登录 | `[{domain, description}]`，**不含 Token**；供桌面端灰色行展示 |

- 管理端接口全部走 `requirePermission`；响应恒为 `sendOk`（`Result<T>` code=0）。
- 列表脱敏恒为 `****`（评审补充：对齐用户端 `toVO` 的常量掩码口径；`GitCredentialService.maskToken` 的「首尾 4 位回显」不用于本面板——settings:read 持有者不应获得 Token 前后缀线索）。
- 审计零代码（评审补充）：五个 `/v1/admin` 路由均命中审计拦截器 `AUDITED_PREFIXES`（`audit.interceptor.ts`），增删改自动全量留痕；`/v1/user/git-default-credentials` 为登录态只读，无需审计。
- 管理面板入口归属「系统设置」，因此权限码沿用 `settings:read/write`（与设置页其它面板一致），不新造权限点。
- 全站域枚举为 Administrator 能力，`agent:read` 与「编辑 Agent」页面权限一致；返回值仅域名，横向枚举风险可接受（D4）。

### 5.5 解析器改造：`DefaultGitTokenResolver`

改动集中在 `backend-ts/src/user/git-token-resolver.ts`，`GitTokenResolver` 接口签名不变（`session/types.ts` 无需改）：

1. `GitTokenResolverDeps` 新增依赖：

```ts
systemGitCredentialService: {
  getTokenMap(): Promise<Map<string, string>>;
  getTokenMapFiltered(domains: string[]): Promise<Map<string, string>>;
};
```

2. `resolveForAgent` 三条路径（`safeDefaultMap` 返回 `Record<string, string>`，评审补充：内部先 `toRecord` 再返回，下方合并写法才能成立——不能把 `Map` 直接展开）：

```ts
// ① 无 Agent 上下文 / NULL 白名单 + lenient：用户全量 ∪ 默认全量（用户优先）
const user = toRecord(await this.deps.gitCredentialService.getTokenMapByUser(userId));
const defaults = await this.safeDefaultMap();            // 异常 → {} + warn
return { ...defaults, ...user };

// ② 白名单：用户交集 ∪ 默认交集（同域用户优先）
const user = toRecord(await this.deps.gitCredentialService.getTokenMapByUserFiltered(userId, allowed));
const defaults = await this.safeDefaultMap(allowed);      // 只查允许域
return { ...defaults, ...user };

// ③ strict 且未配置白名单 / '[]'：直接 {}，不查默认（D2）
```

3. 新增私有方法 `safeDefaultMap(domains?: string[])`：内部 try/catch，异常时 `harnessLog('warn', '[git-scope] default token resolve failed ...')` 并返回空 Map——**默认凭据读取失败只降级为"无默认"，不影响用户自有 Token 的可用性**（该失败不涉及越权泄漏，与白名单解析故障的 fail-closed 语义不同，需在代码注释中写明）。
4. 日志口径升级：`[git-scope] injected=user:1 default:1 allowed=2 agentId=... uid=...`，便于确认默认凭据是否生效；任何日志不出现 Token 明文。
5. 构造装配（`create-app.ts`）：新增 `systemGitCredentials = new SystemGitCredentialService(db, cfg.app.gitCredential.secretKey)`，注入 `gitTokenResolver` 的 deps；并透传给 `app-routes.ts` 注册新路由。

### 5.6 管理后台 UI

**a) 系统设置新增面板** `admin/src/views/settings/components/GitDefaultCredentialsPanel.vue`（新增）：

- 区域标题「Git 默认凭证」，副文案：按域名托管系统默认 Token；用户未配置该域时自动兜底注入，同域用户凭证优先。建议配置只读 Token。
- 列表列：域名、脱敏 Token（恒 `****`）、备注、更新时间、操作（编辑 / 删除）。
- 新增/编辑弹窗：域名（新增时可填，编辑时禁用）、Access Token（password 输入 + 明/密切换；编辑留空不改）、备注（选填）。
- 删除二次确认（行内确认钮，参考桌面端同款交互）；保存后刷新列表。
- 面板样式与锚点对齐既有专属面板：容器 `section.setting-section`，锚点 id `setting-group-git-default-credentials`；顶部集成提示语沿用「加密项保存后仅显示掩码，留空表示不修改」。

**b) 挂载到系统设置页** `admin/src/views/settings/SystemSettingsView.vue`（修改）：

- `TOC_GROUPS`「模型任务」组中，在 `{ kind: 'category', name: '代码' }` 之后插入 `{ kind: 'git-default-credentials', name: 'git-default-credentials' }`。
- `TocSection.kind` 联合类型与模板渲染链新增该分支：`<GitDefaultCredentialsPanel v-else-if="section.kind === 'git-default-credentials'" :can-write="canWrite" />`。
- 该面板不属于 `system_setting` 行，**不注册进设置搜索目录**（`settingsSearchCatalog.ts` 不动，避免搜索定位器出现无法跳转的条目）。

**c) Agent 表单「允许域」候选** `admin/src/views/agent/AgentFormDialog.vue`（修改）：

- `loadOptions` 中 `api.get('/user/git-credentials')` 替换为 `api.get('/admin/git-domains')`，取 `data.domains` 作为候选（原「当前管理员凭证域」逻辑删除）。
- 加载失败不提示不阻塞、仍可手工输入域名（现有兜底行为保留）。

### 5.7 桌面端用户设置页

`desktop/src/views/settings/GitCredentialsView.vue`（修改）：

- 页头说明追加（page-desc）：**「未配置的域名会自动使用管理员配置的系统默认凭证（通常为只读）；需要写权限请添加自己的 Token，同域名添加后即以个人 Token 为准。」**
- 列表区下方新增「系统默认」灰行区：调用 `GET /user/git-default-credentials`，**过滤掉用户已配置的域名**后，逐域渲染灰色卡片——域名、「系统默认」徽标、备注（若有）；无任何操作按钮。
- 空状态调整：用户无个人凭证时保留「暂无 Git 凭证，点击上方按钮添加」引导，但系统默认灰行区照常展示（用户据此知道哪些域已被兜住）。
- 文案注意：不断言"只读"（系统不校验 Token 权限），统一用「通常为只读」。

## 6. 失败与边界

| 场景 | 行为 |
|---|---|
| `system_git_credential` 为空表 | 合并 no-op，行为与现状完全一致 |
| 默认凭据某行解密失败 | 跳过该行 + warn（只记域名）；其余行正常生效 |
| 默认凭据查询异常（DB 故障） | warn + 降级为「仅用户 Token」；用户自有凭据不受影响 |
| 用户凭据查询异常 | 维持现状 fail-closed（`{}` + warn），不因本期改动放宽 |
| strict 策略 + Agent 未配置白名单 | 不注入任何凭据（含默认） |
| Agent 白名单 `'[]'` | 不注入任何凭据（含默认） |
| 用户自有 Token 存在但失效 | Git 服务端报错原样透传，**不回落默认**（D7） |
| 管理员删除/修改默认凭据 | 下一次解析即时生效（resolver 无缓存）；删除后相关用户回落为"无凭据" |
| 用户添加同域 Token 后又删除 | 删除后自动恢复默认兜底（解析每次动态合并，无粘滞状态） |
| 同域用户与默认同时存在 | 用户优先，默认 Token 不参与该域注入（不出现双注入/覆盖冲突） |

## 7. 安全与审计

1. **继承既有暴露面并接受**（D6）：凭据注入为 `GIT_TOKEN_<domain>` 环境变量 + `GIT_ASKPASS`，任何能运行 Shell 的用户理论上可 `echo $GIT_TOKEN_x` 读出该会话注入的 Token——系统默认 Token 因此对所有"白名单放行该域"的会话可见。这是注入机制固有边界（与用户自有 Token 相同），本期不新增缓解机制；控制手段为：管理员只配只读 Token、出事可轮换（删除/重建该行即可）。
2. **API 不回明文**：管理端列表恒 `****`；用户端默认域接口只回域名与备注（备注由管理员撰写，不视为敏感）。
3. **全站域枚举的收敛**：`/v1/admin/git-domains` 仅回域名（无用户归属、无 Token、无计数），由 `agent:read` 守门。
4. **日志**：`[git-scope]` 记录来源计数；日志、错误消息、响应体中不出现 Token 明文（沿用既有清洗口径）。
5. **加密**：默认凭据与用户凭据共用 `APP_GIT_CREDENTIAL_SECRET`，密钥轮换流程与既有一致（解密 → 重加密全表）。

## 8. 兼容性与影响面

- **行为变化点**：无用户 Token 的用户，从"完全无凭据"变为"默认域可读"。配了用户 Token 的域行为不变。
- **零改动**：六条注入通道、容器 envelope 结构与容器内消费方、`GIT_ASKPASS` 机制、`GitTokenResolver` 接口签名、用户凭据 CRUD。
- **性能**：每会话每次解析新增 1 次默认凭据查询（白名单路径为 `IN` 查询，命中唯一索引），量级与现有用户凭据查询相同；无进程内缓存（与既有口径一致，保证后台改动即时生效）。
- **前端**：管理后台面板与桌面灰行均为新增展示，不改现有操作路径。

## 9. 代码改动清单

### 后端（backend-ts）

| 文件 | 类型 | 说明 |
|---|---|---|
| `db/migration/V194__system_git_credential.sql` | 新增 | §5.2 建表 |
| `src/user/system-git-credential.service.ts` | 新增 | §5.3 服务 |
| `src/user/system-git-credential.routes.ts` | 新增 | §5.4 全部新接口 |
| `src/user/system-git-credential.routes.spec.ts` | 新增 | §10.3 路由层用例（评审补充：v1.0 测试计划有路由层断言但改动清单漏列该文件） |
| `src/user/git-token-resolver.ts` | 修改 | deps + 合并逻辑 + `safeDefaultMap` + 日志 |
| `src/create-app.ts` | 修改 | 实例化 service、注入 resolver、透传路由 |
| `src/app-routes.ts` | 修改 | 注册新路由 |
| `src/user/system-git-credential.service.spec.ts` | 新增 | 单测 |
| `src/user/git-token-resolver.spec.ts` | 修改 | 新增矩阵用例（评审补充：既有用例的 fake deps 需同步补 `systemGitCredentialService` 最小实现） |

### 管理后台（admin）

| 文件 | 类型 |
|---|---|
| `src/views/settings/components/GitDefaultCredentialsPanel.vue` | 新增 |
| `src/views/settings/SystemSettingsView.vue` | 修改（TOC + 渲染 + 类型） |
| `src/views/agent/AgentFormDialog.vue` | 修改（候选域接口） |

### 桌面端（desktop）

| 文件 | 类型 |
|---|---|
| `src/views/settings/GitCredentialsView.vue` | 修改（说明文案 + 系统默认灰行区） |

### 文档

| 文件 | 类型 |
|---|---|
| 本方案文档 | 新增 |
| `changelog/unreleased/2026-11-12-system-git-credential.md` | 实施时新增碎片（评审更正：v1.0 误写「根 CHANGELOG.md 顶部加版本条目」——根 `CHANGELOG.md` 只是索引，不得手改；本需求跨后端/管理后台/桌面三端，按 `changelog/unreleased/README.md` 口径写一个碎片，含「后端」「管理后台」「前端（桌面 / Web / 安卓）」三个小节） |

## 10. 测试计划

**单测（vitest）**

1. `git-token-resolver.spec.ts` 新增矩阵（沿用"宽松/严格 × 未配置/禁止/白名单 × 有/无上下文"结构）：
   - NULL 白名单 + lenient：用户 ∪ 默认合并、用户同域优先；
   - NULL 白名单 + strict：`{}` 且不查默认；
   - `'[]'`：`{}` 且不查默认；
   - 白名单：默认只按允许域查询（`getTokenMapFiltered(allowed)`）、交集合并、用户优先；
   - 默认查询异常：降级为用户 Token（不为 `{}`）、仍不抛出；
   - 默认为空表：等价现状。
2. `system-git-credential.service.spec.ts`：域名规范化/重复域/空 Token 校验；加解密往返；`getTokenMapFiltered` 空数组短路不查库；解密失败行跳过。
3. 路由层：写接口权限断言（无 `settings:write` → 403）；列表响应恒 `****`；`/v1/user/git-default-credentials` 不含 token 字段；`/v1/admin/git-domains` 为用户域 ∪ 系统默认域的去重排序并集、不含 Token 与用户归属、无 `agent:read` → 403（评审补充）。

**构建与手工验证**

- `cd backend-ts && npm run build && npm test`；`cd admin && npm run build`；`cd desktop && npm run build`（并跑相关 vitest）。
- 端到端手工用例（测试环境）：
  1. 管理员配默认 Token（域 git.acg.team，只读）→ 无凭据用户开会话（Agent 白名单含该域）→ 容器内 `git clone` 私有库成功、`git push` 被拒；
  2. 同一用户配置自有写权限 Token → `push` 成功（用户覆盖默认）；
  3. 删除自有 Token → 回落默认兜底；
  4. Agent 白名单不含该域 → 不注入（`env | grep GIT_TOKEN` 为空）；
  5. 桌面设置页：灰行展示、加同域凭证后灰行消失；
  6. 管理后台：面板增删改、编辑留空不改 Token、Agent 表单候选包含默认域。

## 11. 实施顺序

1. 迁移 V194 + `SystemGitCredentialService` + 单测；
2. resolver 改造 + 单测 + `create-app` / `app-routes` 装配；
3. 后端新路由 + 权限断言；
4. 管理后台面板（`GitDefaultCredentialsPanel` + SystemSettingsView 挂载）+ Agent 表单候选切换；
5. 桌面端凭证页灰行与文案；
6. 全量构建 + 手工验证 + CHANGELOG 条目。

## 12. 开放项（本期不做，留档）

- 默认凭据的启用/停用开关：删除即停用，暂不加 `enabled` 列；
- 默认凭据面板加入设置搜索目录（需搜索定位器支持非 setting_key 条目）；
- 默认凭据使用情况统计（哪些用户/会话实际享用兜底）；
- 只读性的技术保证（如按 HTTP 方法拦截写请求）：依赖 Git 服务端权限模型，系统不做应用层判断。
