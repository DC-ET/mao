# Agent 级 Git 凭据域收敛技术方案（用户级凭据按 Agent 过滤注入）

- 状态：**草案（2026-11-06，待评审；本轮只出方案，不进入代码开发）**
- 日期：2026-11-06
- 覆盖端：后端 backend-ts、数据库迁移、管理后台 admin、共享契约 `@mao/contracts`
- 不涉及：桌面 Electron 本地执行链路（LOCAL）、容器运行时协议、agent-cli
- 关联方案：
  - [2026-10-18-env-variables-technical-design.md](./2026-10-18-env-variables-technical-design.md)（同一批凭据注入点，本方案与其 §5.7 合并次序不冲突）
  - [2026-10-14-user-runtime-container-isolation-design.md](./2026-10-14-user-runtime-container-isolation-design.md)（RuntimeEnvelope 与容器凭据下发口径）
- 方案定位：只做**第一层——凭据可见域收敛到 Agent**。不改变凭据归属（仍归用户）、不改变注入形态（仍是 `GIT_TOKEN_<domain>` env + `GIT_ASKPASS`），只把「注入哪些域」从「该用户全部域」收敛为「用户凭据域 ∩ 当前 Agent 允许域」。动态签发（去 env 化）、审计告警、网络隔离均不在本期。

## 0. 名词约定

| 名词 | 含义 |
|---|---|
| 凭据域 | `user_git_credential.domain`，用户配置的 Git 服务 host，如 `git.acg.team` |
| Agent 允许域 | `agent.git_allowed_domains`，本 Agent 的运行环境允许注入凭据的 host 白名单 |
| 有效凭据集 | 某次注入实际下发的 token 集合 = 用户凭据域 ∩ Agent 允许域 |
| 宽松模式 | Agent 允许域为 NULL（未配置）时不限制，保持现有行为（升级默认） |
| 严格模式 | Agent 允许域为 NULL（未配置）时一律不注入（fail-closed） |
| 注入点 | 把 `getTokenMapByUser(userId)` 结果写入子进程环境 / 容器 envelope 的代码位置 |

## 1. 需求背景

### 1.1 现状：凭据挂在用户上，注入不区分 Agent

凭据存储：`user_git_credential`（`V047__add_user_git_credential.sql`），唯一键 `(user_id, domain)`，AES-CBC 加密，**没有 Agent 维度**。

凭据消费：`GitCredentialService.getTokenMapByUser(userId)`（`user/git-credential.service.ts:65`）返回该用户**全部** token，六条通道直接全量消费。行号为撰写时代码快照。

| # | 通道 | 代码位置 | 注入方式 |
|---|---|---|---|
| 1 | Agent shell 工具（exec / write_stdin 刷新） | `harness/tool/impl/shell-session-tool.ts:184,346` → `harness/shell/shell-session-manager.ts:552,720` | `GIT_TOKEN_<domain>` + `GIT_ASKPASS` |
| 2 | 交互式终端（PTY） | `harness/terminal/terminal-manager.ts:440` | 同上 |
| 3 | 容器 envelope → 容器内 shell | `harness/container/session-envelope-builder.ts:48-56` → `harness/container/container-tool-executor.ts:109` | `envelope.gitTokens` |
| 4 | 容器 MCP stdio 子进程 | `harness/container/container-mcp-bridge.ts:107-124` | `envelope.gitTokens` |
| 5 | 建会话 clone | `session/git-operation.service.ts:74-100` | `GIT_TOKEN_<domain>` + `GIT_ASKPASS` |
| 6 | 桌面 / Web Git 面板写操作（commit/pull/push） | `file/git-write-operation.service.ts:503-527` | 同上 |

补充说明：

- `GIT_ASKPASS` 脚本本身已按「git 请求 URL 的 host」选 token（`file/git-write-operation.service.ts:40-56`），缺的不是选择机制，而是**可用 token 集合的边界**；
- `shell-session-manager.ts` 的 `refreshUserEnvironment` 每条命令前先按 `GIT_TOKEN_*` 前缀全清再注入当前 map，因此只要控制传入的 map，历史注入的 token 会在下一条命令前被 unset；
- LOCAL 会话的 git 操作在桌面端本机执行（`desktop/electron/gitOperations.cjs`，本机 `process.env`），不经过平台注入，**不在本问题的注入面内**。

### 1.2 事故：野子拿到了梁子的凭据

- 同一批研发同时在两个 Agent（梁子 = ACG，野子 = 田野）下工作，登录的是同一个 Mao 用户账号，两个域名的 token 都配在该账号下；
- 野子会话的 shell 环境里因此出现了 `GIT_TOKEN_git_acg_team`，它成功 clone 了 ACG 的仓库并用于任务；
- 这不是模型「越权决策」，而是**平台按设计把凭据发给了不该拿到它的 Agent**。提示词约束、操作规范都不构成隔离边界。

### 1.3 为什么必须做硬隔离

1. **模型行为不可控**：任务上下文里的任意文本（README、issue、依赖说明、粘贴内容）都可能诱导 Agent 访问其它公司的仓库，属于典型的间接提示注入面；
2. **凭据是明文进 env 的**：`echo $GIT_TOKEN_x`、`env`、子进程继承都能读走，用户的任何一条命令都可能触发；
3. **Agent 在产品语义上已经是租户边界**：`Agent` 承担「一家公司一个助手」的隔离职责，但当前只是人格 + 技能 + MCP 配置，不是安全边界。本次修复把「凭据可见域」这一条先落成硬边界。

### 1.4 目标

- 同一用户在不同 Agent 下，只能拿到「本 Agent 允许域」的凭据；
- 未配置的存量 Agent 行为不变（平滑升级）；
- 配置一处（Agent 管理员，`agent:write`）即覆盖全部六条注入通道，不新增注入路径；
- 严格模式下 fail-closed，不依赖任何 Agent 的自觉。

## 2. 需求描述

### 2.1 要做的（本期全部）

1. `agent` 表新增 `git_allowed_domains`（三态：未配置 / 空白名单 / 白名单，见 §3.1）；
2. 新增统一解析器 `GitTokenResolver`：`resolveForSession(userId, sessionId)` / `resolveForAgent(userId, agentId)`，内部完成「用户 token ∩ Agent 允许域」；
3. 六条通道全部改走统一解析器；容器侧（通道 3、4）由 envelope 上游过滤后自动生效，不改容器内代码；
4. 管理后台 Agent 表单新增「Git 凭据域」配置；系统设置新增「凭据域策略」开关（宽松 / 严格，默认宽松）；
5. Agent 列表展示配置状态（未配置 / 已禁止 / N 个域），支持找出未收敛的 Agent；
6. 过滤发生时打日志（会话、用户、Agent、注入/丢弃条数；不记域名清单与 token）。

### 2.2 不做的（本期明确排除）

1. 动态签发 / 凭据去 env 化（第二层：askpass 回调凭据端点、按 host 逐次鉴权）；
2. 凭据请求审计与越界告警、网络层 egress 控制（第三层）；
3. `user_env_variable`（三级环境变量）、ECP token、LARK UAT 等其它用户级凭据的同类收敛；
4. `user_git_credential` 增加 `agent_id`（token 显式归属 Agent 的方案）——本期用「域级白名单」，不改凭据表与用户配置流程；
5. LOCAL 桌面执行链路的任何改动；
6. 域名匹配语义变更（子域、端口、IP 直连）——沿用现有 `normalizeDomain` 口径。

## 3. 方案设计

### 3.1 数据模型

迁移 `db/migration/V187__agent_git_allowed_domains.sql`（沿用 `V067`/`V166` 的 `VARCHAR(1024) NULL` JSON 列范式）：

```sql
ALTER TABLE `agent`
    ADD COLUMN `git_allowed_domains` VARCHAR(1024) NULL
    COMMENT '允许注入 Git 凭据的域名白名单（JSON 数组）：NULL=未配置（跟随全局策略），[]=禁止注入，非空=白名单'
    AFTER `http_tool_ids`;
```

三态语义：

| 存储值 | 语义 | 宽松模式实际注入 | 严格模式实际注入 |
|---|---|---|---|
| `NULL` | 未配置 | 用户全部 token（现状） | 无 |
| `'[]'` | 显式禁止 | 无 | 无 |
| `'["git.acg.team"]'` | 白名单 | 交集 | 交集 |

与既有字段的差异说明：`skill_names` / `mcp_server_ids` / `http_tool_ids` 都按「空数组 → 存 NULL」处理（`agent.service.ts` 的既有惯例）。本字段**必须保留 `[]`**，否则无法表达「显式禁止」。`AgentService.createAgent/updateAgent` 对该字段单独处理，其它字段行为不变，并在代码中注释原因。

### 3.2 全局策略开关

`system_setting`：key = `gitToken.scopePolicy`，value = `lenient` | `strict`，缺省（无记录）为 `lenient`。

- 读取：`SystemSettingService.getValue('gitToken.scopePolicy')`（`settings/settings.service.ts:209`）；resolver 每次解析时读取，不做进程内缓存（口径同 `site.baseUrl`，保证开关即时生效）；
- 入口：管理后台「系统设置」（`admin/src/views/settings/SystemSettingsView.vue`），radio 文案：
  - 宽松：未配置允许域的 Agent 不限制（兼容现状）
  - 严格：未配置允许域的 Agent 不注入任何 Git 凭据（fail-closed）
- 用途：解决「存量 Agent 未配置」与「升级不破坏」的矛盾——先宽松上线，两个 Agent 配好后切严格（见 §6）。

### 3.3 统一解析器

- 接口：`backend-ts/src/session/types.ts`（与现有 `GitCredentialLookup` 相邻；harness / session / file 三个域都要引用，放在共有位置避免循环依赖）；
- 实现：`backend-ts/src/user/git-token-resolver.ts`（依赖 `GitCredentialService`、`AgentRepository`、`SessionRepository`、`SystemSettingService`，全部由 `create-app.ts` 装配传入，保持可单测）。

```ts
export interface GitTokenResolver {
  /** 按会话上下文解析：查 session.agent_id 后委托 resolveForAgent */
  resolveForSession(userId: number, sessionId: number | null): Promise<Record<string, string>>;
  /** 按 Agent 上下文解析：用户 token ∩ Agent 允许域，再按全局策略兜底 */
  resolveForAgent(userId: number, agentId: number | null): Promise<Record<string, string>>;
}
```

解析算法（伪代码）：

```
resolveForAgent(userId, agentId):
  tokens = gitCredentialService.getTokenMapByUser(userId)      # 现有能力，不改
  if tokens.isEmpty(): return {}
  policy = settings('gitToken.scopePolicy') ?? 'lenient'

  if agentId == null:
     log('git-scope: no agent context, uid=%s', userId)        # 观察点，见 §9-4
     return policy == 'lenient' ? tokens : {}

  agent = agentRepo.findById(agentId)
  if agent == null:
     log('git-scope: agent not found, agentId=%s', agentId)
     return policy == 'lenient' ? tokens : {}

  raw = agent.gitAllowedDomains
  if raw == null:                                             # 未配置
     log('git-scope: agent unconfigured, agentId=%s', agentId)
     return policy == 'lenient' ? tokens : {}

  allowed = parseDomainList(raw)                              # '[]' → []
  if allowed.isEmpty(): return {}                             # 显式禁止

  result = { d: t for (d, t) in tokens if normalizeGitDomain(d) in allowed }
  log('git-scope: injected=%d dropped=%d agentId=%s uid=%s',
      result.size, tokens.size - result.size, agentId, userId)
  return result

resolveForSession(userId, sessionId):
  if sessionId == null: return resolveForAgent(userId, null)
  session = sessionRepo.selectById(sessionId)
  if session == null: return resolveForAgent(userId, null)
  if session.userId !== userId:                               # 防御性校验，理论上不会发生
     log('git-scope: session owner mismatch, sid=%s uid=%s', sessionId, userId)
     return resolveForAgent(userId, null)
  return resolveForAgent(userId, session.agentId ?? null)
```

性能：每条 shell 命令新增 1 次 session 主键查询 + 1 次 agent 主键查询（本地库毫秒级），不引入缓存，优先保证配置与开关即时生效。若压测显示热点，再按 `agentId` 加 30–60s TTL 缓存（届时需处理严格模式切换的失效问题，单独立项）。

**异常降级口径**：resolver 内部任何异常（查库失败、JSON 解析失败）一律按「空集」返回并打 `warn` 日志——与现有 `SessionEnvelopeBuilder.build` 的 catch 口径一致（`gitTokens` 保持 `{}`），安全优先于可用性。注意这与「无 Agent 上下文」的宽松放行是两回事：前者是故障，后者是配置未就绪。

**调用链路确认**：建会话 clone 走 `SessionService.createSession`，`sessionRepo.insert(session)`（`session.service.ts:180`）先于 `gitOperationService.clone(..., session.id, ...)`（`:267`），因此该通道 `sessionId` 与 `agentId` 均可确定，不存在「新建会话拿不到上下文」的缺口。

### 3.4 匹配规则

- 两侧统一规范化：trim + 小写 + 去 `http://` / `https://` 前缀 + 去首个 `/` 及其后（与 `GitCredentialService.normalizeDomain` 现有口径完全一致，抽公共函数见 §4.2-1）；
- 比较为**精确 host 相等**，不做后缀 / 子域 / 通配符匹配（`git.acg.team.evil.com` 不会命中 `git.acg.team`，`*.acg.team` 不支持）；
- 需要多个域就显式列举多条。

### 3.5 注入点改造（六条通道）

| # | 位置 | 改动 |
|---|---|---|
| 1 | `harness/tool/impl/shell-session-tool.ts:184,346` | 依赖 `GitCredentialLookup` → `GitTokenResolver`；`getTokenMapByUser(userId)` → `resolveForSession(userId, sessionId)` |
| 2 | `harness/terminal/terminal-manager.ts:440` | 同上（`CreateTerminalParams.sessionId` 必填，直接传） |
| 3 | `harness/container/session-envelope-builder.ts:48-56` | deps 改为 resolver；`build()` 内 `resolveForSession(userId, sessionId)`；**下游零改动**（`container-tool-executor.ts:109` 的 `envelopeGitLookup` 与 `container-mcp-bridge.ts` 消费的都是过滤后的 `envelope.gitTokens`） |
| 4 | 容器 MCP 子进程（同 3 的下游） | 无代码改动，随 envelope 自动收敛 |
| 5 | `session/git-operation.service.ts:74-100` | `credentialEnv(userId, sessionId)` 改走 resolver |
| 6 | `file/git-write-operation.service.ts:503-527` | `credentialEnv(session)` 用 `resolveForAgent(session.userId, session.agentId ?? null)`（已有 session 对象，省一次查询） |

不动的部分：

- `harness/shell/shell-session-manager.ts:552,720,772`：只消费传入的 `domainTokenMap`，不改；其「按前缀全清再注入」保证过滤后旧 token 在下一条命令前 unset；
- `harness/container/container-tool-executor.ts`、`container-mcp-bridge.ts`：envelope 消费方，不改。

装配点：

- `create-app.ts:364-367`：`gitLookup` 替换 / 增补为 `gitTokenResolver`；
- `app-container-runtime.ts:141-152`：`envelopeBuilder` 的 `gitCredentialService` 改为 resolver；
- `create-app.ts:631`（TerminalManager）、`create-app.ts:501`（GitOperationService）、Git 写服务装配处同步替换。

### 3.6 契约与 UI

**契约** `shared/contracts/src/agent.ts` — `AgentVO` 增加：

```ts
/** Git 凭据域白名单：null=未配置（跟随全局策略），[]=禁止注入，非空=白名单 */
gitAllowedDomains?: string[] | null;
```

**后端**：

- `agent/types.ts`：`Agent` 增加 `gitAllowedDomains?: string | null`；
- `agent/agent.repository.ts`：`insert` / `updateById` 增加列映射；
- `agent/agent.service.ts`：`createAgent` / `updateAgent` 追加参数（加在参数列表末尾，保持既有调用兼容）；`[]` 存 `'[]'`，不做 null 折叠；
- `agent/agent.routes.ts`：
  - `CreateAgentRequest` / `UpdateAgentRequest` 增加 `gitAllowedDomains?: string[] | null`；
  - 新增校验 `normalizeGitDomains()`：逐项 `normalizeGitDomain` + 去重，限制 ≤32 条 / 单条 ≤253 字符 / JSON 总长 ≤1024，非法抛 `PARAM_INVALID`；
  - `toVO` 反序列化为数组，`null` 原样返回。

**管理后台**：

- `admin/src/views/agent/AgentFormDialog.vue`：「Git 凭据域」表单项，放在「自定义 HTTP 工具」之后——
  - 「启用域名限制」开关：关闭 = `NULL`；开启 + 空列表 = `[]`（提示「空列表 = 禁止注入」）；开启 + 有值 = 数组；
  - 域名输入推荐支持两种方式：从「全站已配置 Git 域」候选中多选（新增只读接口 `GET /v1/admin/git-domains`，`SELECT DISTINCT domain FROM user_git_credential`，`agent:write` 权限），或手工输入；手工输入走同一 `normalizeGitDomain` 校验，避免两侧口径漂移；
- `admin/src/views/agent/AgentListView.vue`：能力摘要 tooltip 增加「Git 域：未配置 / 已禁止 / N 个域」；列表可按「未配置」筛选（收敛存量用）；
- `admin/src/views/settings/SystemSettingsView.vue`：「Git 凭据域策略」radio（宽松 / 严格），同步 `settingsSearchCatalog.ts` 搜索条目。

**桌面端（可选，P2）**：`desktop/src/views/settings/GitCredentialsView.vue` 增一行说明「凭据仅在被 Agent 允许的域名下注入」，不阻塞主链路。

### 3.7 可观测

- resolver 在「过滤发生」「无上下文」「Agent 未配置」三处各打一条 `harnessLog('info')`：`uid / agentId / sessionId / injected / dropped`；
- **不记录域名清单与 token**，避免日志成为新的泄漏面；
- 严格模式切换后关注 `dropped > 0` 的分布，确认是预期收敛而非误伤。

## 4. 实现步骤

### 4.1 数据库

1. 新增 `db/migration/V187__agent_git_allowed_domains.sql`（见 §3.1）；
2. `agent` 表无数据回填，全部为 `NULL`（宽松模式行为不变）。

### 4.2 后端（backend-ts）

1. 抽公共函数 `normalizeGitDomain()` 到 `src/common/git-domain.ts`（现逻辑在 `GitCredentialService.normalizeDomain` / `validateDomain`，含 `DOMAIN_PATTERN`），`GitCredentialService` 改为调用它，行为不变；agent 路由复用同一函数，保证「用户配置的 token 域」与「Agent 允许域」两侧规范化口径一致；
2. `agent/types.ts`、`agent/agent.repository.ts`、`agent/agent.service.ts`、`agent/agent.routes.ts` 增加字段与校验；
3. `session/types.ts` 新增 `GitTokenResolver` 接口；新增实现 `src/user/git-token-resolver.ts`；
4. 五个注入点改造（§3.5 表）+ 装配（create-app / app-container-runtime）；
5. `settings/settings.service.ts` 增加 `getGitScopePolicy(): Promise<'lenient' | 'strict'>`（读 `gitToken.scopePolicy`，缺省 `lenient`）。

### 4.3 契约与前端

1. `shared/contracts/src/agent.ts` 增加 `gitAllowedDomains`；
2. admin 三处：`AgentFormDialog.vue`（表单）、`AgentListView.vue`（状态展示与筛选）、`SystemSettingsView.vue`（策略开关）+ `settingsSearchCatalog.ts`。

### 4.4 文档

1. 根 `CHANGELOG.md` 顶部记一条（用户可见：Agent 可限制可注入的 Git 凭据域）；
2. `skills/mao-cli/` 中与 Agent 配置 / 凭据相关的说明按需同步（实施时确认落点）。

## 5. 改动清单（文件级）

| 类型 | 文件 | 说明 |
|---|---|---|
| 迁移 | `backend-ts/db/migration/V187__agent_git_allowed_domains.sql` | 新增列 |
| 后端 | `backend-ts/src/common/git-domain.ts`（新增） | 域名规范化公共函数 |
| 后端 | `backend-ts/src/user/git-credential.service.ts` | 改用公共函数（行为不变） |
| 后端 | `backend-ts/src/user/git-token-resolver.ts`（新增） | 统一解析器实现 |
| 后端 | `backend-ts/src/session/types.ts` | `GitTokenResolver` 接口 |
| 后端 | `backend-ts/src/agent/types.ts` / `agent.repository.ts` / `agent.service.ts` / `agent.routes.ts` | 字段读写、校验、VO、`GET /v1/admin/git-domains` 候选接口 |
| 后端 | `backend-ts/src/harness/tool/tool-registry.ts` | 工具注册依赖类型替换 |
| 后端 | `backend-ts/src/harness/tool/impl/shell-session-tool.ts` | 注入点 1 |
| 后端 | `backend-ts/src/harness/terminal/terminal-manager.ts` | 注入点 2 |
| 后端 | `backend-ts/src/harness/container/session-envelope-builder.ts` | 注入点 3 |
| 后端 | `backend-ts/src/session/git-operation.service.ts` | 注入点 5 |
| 后端 | `backend-ts/src/file/git-write-operation.service.ts` | 注入点 6 |
| 后端 | `backend-ts/src/create-app.ts` / `src/app-container-runtime.ts` | 装配 |
| 后端 | `backend-ts/src/settings/settings.service.ts` | 策略读取 |
| 契约 | `shared/contracts/src/agent.ts` | VO 字段 |
| admin | `admin/src/views/agent/AgentFormDialog.vue` / `AgentListView.vue` | 表单与列表 |
| admin | `admin/src/views/settings/SystemSettingsView.vue` / `settingsSearchCatalog.ts` | 策略开关 |
| 测试 | 各模块 `*.spec.ts` | 见 §7 |

## 6. 上线与迁移路径（三阶段）

**阶段 1：代码上线（行为零变化）**

- 执行迁移；所有 Agent 的 `git_allowed_domains` 为 `NULL`；策略默认宽松 → 与现状完全一致；
- 回归：shell / 终端 / 容器 / Git 面板的 clone、fetch、push 均正常。

**阶段 2：配置两个 Agent（事故场景立即关闭）**

- 梁子配置 `["git.acg.team"]`（按实际需要补充其它域）；野子配置 `["git.zizaitianye.com"]`；
- 验收（事故回放）：
  - 野子会话内：`env | grep GIT_TOKEN` 无 `git.acg.team` 条目；`git clone https://git.acg.team/...` 因无凭据失败；
  - 梁子会话内：clone / push ACG 仓库正常。

**阶段 3：收敛存量并切严格**

- 管理后台按「未配置」筛选，逐批确认并配置；
- 关键 Agent（或全部）配置完成后，系统设置切「严格模式」；
- 观察 1–2 周日志中 `dropped` 计数与目录内业务反馈，确认无受损后进入常规运维。

**回滚**：策略切回宽松即恢复兼容行为；字段与配置保留，无需回滚数据。

## 7. 测试要点

**解析器单元测试（`git-token-resolver.spec.ts`，核心资产）**

| 场景 | 宽松模式 | 严格模式 |
|---|---|---|
| 用户无 token | `{}` | `{}` |
| Agent 未配置（NULL） | 全量 | `{}` |
| Agent 显式禁止（`[]`） | `{}` | `{}` |
| 白名单命中部分域 | 交集 | 交集 |
| 白名单无命中 | `{}` | `{}` |
| agentId == null / session 查不到 | 全量 + 日志 | `{}` + 日志 |
| session.userId 与 userId 不一致 | 全量 + 告警日志 | `{}` |

- 匹配矩阵：大小写（`Git.ACG.Team`）、带协议 / 路径的配置项规范化、非 git 前缀域名（任意 host 应支持）、后缀混淆（`git.acg.team.evil.com` 不命中 `git.acg.team`）；
- 三态存取：`[]` 必须落 `'[]'` 不得折叠为 NULL（service 单测固定）。

**注入点测试（五处）**

- 各注入点原先 spy `getTokenMapByUser` 的用例改为 spy `GitTokenResolver.resolveForSession/ForAgent`；
- shell 工具：验证传入 `ShellSessionManager` 的 `domainTokenMap` 为过滤后集合；容器 envelope：验证 `envelope.gitTokens` 为过滤后集合（`session-envelope-builder.spec.ts`）。

**回归**

- `shell-session-tool.spec.ts`、`terminal-manager.spec.ts`、`git-operation` 相关 spec、`container-tool-executor.spec.ts`、`agent` 系列 spec 全绿；
- `pnpm/npm run build` + 现有测试全量通过。

**E2E（可选，CLOUD 容器环境）**

- 配好白名单后在容器内执行 `env | grep GIT_TOKEN_` 与 `git clone` 负向断言；
- host 模式下复用既有 shell 测试通道做同样断言。

## 8. 验收标准（事故场景回放）

1. 野子（田野 Agent）会话：注入的 `GIT_TOKEN_*` 只含 `git.zizaitianye.com`；
2. 野子会话内对 `git.acg.team` 的 clone / fetch 无凭据失败（不再"成功拉取"）；
3. 梁子（ACG Agent）会话：ACG 凭据照常可用；
4. 未配置 Agent 在宽松模式下行为与升级前一致；
5. 严格模式下未配置 Agent 不注入任何 Git 凭据；
6. 宿主机 shell / PTY 终端 / 容器 envelope 三处注入形态的过滤结果一致；
7. 既有测试全部通过，无新增回归。

## 9. 风险与回归护栏

1. **存量未配置 Agent（宽松期仍全量注入）**：本方案的收敛依赖「配置动作 + 切严格」，为此提供配置状态可见（列表筛选）与策略开关；验收清单里把「未配置 Agent 清零」列为切严格的前置条件；
2. **`[]` 与 `NULL` 混淆**：`AgentService` 对该字段单独处理并有专项单测，禁止把 `[]` 折叠成 `NULL`；
3. **性能**：每条 shell 命令新增 2 次主键查询；压测若观测到明显延迟，再以 `agentId` 为键加 TTL 缓存（需处理策略开关即时性，另立小方案）；
4. **`session.agentId` 为空的历史会话**：按「无 Agent 上下文」处理（宽松放行 + 日志 / 严格拒绝），并观察日志确认此类调用点是否符合预期；
5. **长驻进程的旧 env**：已 spawn 的 shell / PTY 子进程持有旧 env，需下一条命令的 `refreshUserEnvironment` 或重开终端/会话才会被清掉——与现有 token 轮换口径一致，文档中向使用者说明；
6. **端口 / 子域匹配**：本方案不改变匹配语义；带端口的 remote（`git.acg.team:8443`）与现状行为一致（既有问题，不在本期）；
7. **LOCAL 会话**：不经过平台注入，行为不变；若未来要求「桌面端读取服务端凭据」，另行设计；
8. **误配白名单导致业务受损**：日志中 `dropped` 显著上升时先切回宽松定位，再修配置。

## 10. 开放问题（待讨论，不阻塞主流程）

1. 无 Agent 上下文（无 sessionId / 查不到 Agent）时的兜底口径：当前设计为「宽松全量 + 日志、严格为空」——是否接受；若要求更严，可改为「始终不注入」；
2. Agent 表单交互：推荐「启用开关 + 标签输入」（见 §3.6）；是否需要额外的「一键预设」（如按用户已有 token 域快捷勾选）；
3. 严格模式切换时机与责任人：建议两家公司 Agent 配置验收后由平台管理员切换，切换前跑一次「未配置清单清零」检查；
4. 用户端透明度：是否在桌面设置页展示「我的凭据将在哪些 Agent 生效」（建议下一期，与第二层一起做）；
5. 子域支持：如实际存在 `a.acg.team`、`b.acg.team` 多个服务端，建议显式列举而非引入 `*.` 通配；
6. 与「凭据显式绑 Agent」（`user_git_credential.agent_id`）的关系：本期域级已覆盖当前场景；若未来出现「同一域名在不同 Agent 下需要不同 token」的需求，再把作用域下沉到凭据行，本方案的 resolver 是届时唯一改造点。

