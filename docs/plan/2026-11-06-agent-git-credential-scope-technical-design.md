# Agent 级 Git 凭据域收敛技术方案（用户级凭据按 Agent 过滤注入）

- 状态：**草案（2026-11-06，已评审并复核补充；本轮只出方案，不进入代码开发）**
- 日期：2026-11-06
- 评审：2026-11-06 对照代码全量核对六条注入通道、装配点、迁移编号、admin 现有范式后修订；同日第二轮复核修正 TOC 分类归属、查询次数口径、MCP 长驻盲点等 6 项（见 §11 末「第二轮复核」），评审记录见 §11。
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
| 注入点 | 把 token map 写入子进程环境 / 容器 envelope 的代码位置（改造后数据源为 `GitTokenResolver`） |

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

1. `agent` 表新增 `git_allowed_domains`（三态：未配置 / 空白名单 / 白名单，见 §3.1）；迁移同时种子插入 `gitToken.scopePolicy` 策略行；
2. 新增统一解析器 `GitTokenResolver`：`resolveForSession(userId, sessionId)` / `resolveForAgent(userId, agentId)`，内部完成「用户 token ∩ Agent 允许域」；
3. 六条通道全部改走统一解析器；容器侧（通道 3、4）由 envelope 上游过滤后自动生效，不改容器内**消费**代码（但 `container-tool-executor.ts` 的装配适配器要随类型变更同步改，见 §3.5）；
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

-- 全局策略开关行（评审补充）：system_setting 缺行时管理后台分类卡片不渲染该控件，
-- 必须随迁移种子插入，否则上线后看不到开关。
-- category 用已存在的分类名 'Agent 与模型'（复核修正：该分类挂在 TOC_GROUPS 的
-- 「模型任务」组下，SystemSettingsView.vue:344；「Agent 引擎」组下只有 integration
-- （:330-337），没有分类。写成组名/不存在的分类会新建卡片并落入「其他」兜底——
-- 因此本开关将出现在「模型任务 → Agent 与模型」卡片，零改 TOC）。
INSERT IGNORE INTO `system_setting`
    (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('gitToken.scopePolicy', 'lenient', 'Agent 与模型',
 'Git 凭据域策略：宽松=未配置允许域的 Agent 不限制；严格=不注入任何 Git 凭据', 1, 0);
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
- 入口：管理后台「系统设置」（`admin/src/views/settings/SystemSettingsView.vue`）。
  **注意不是「加个 radio」**（评审补充）：分类卡片由后端 `system_setting` 行驱动，控件形态由前端谓词分派；且 `description` 列为 `VARCHAR(256)`，放不下两行长文案。照 `isRuntimeModeSetting`（`:632`）/ `isMcpLoadModeSetting`（`:627`）既有范式做：
  1. 新增谓词 `isGitScopePolicySetting(key)` → `key === 'gitToken.scopePolicy'`；
  2. 在通用渲染链（`:138` 的 switch 之后）插一个 `el-select` 分支，option label 中文硬编码在前端：
     - `lenient` → 宽松：未配置允许域的 Agent 不限制（兼容现状）
     - `strict` → 严格：未配置允许域的 Agent 不注入任何 Git 凭据（fail-closed）
  3. `settingsSearchCatalog.ts` 加搜索条目；`SPECIAL_KEYS` **不**加（留在分类卡片内即可）；
  4. `category` 必须是**已存在的分类名**而非 TOC 组名——**复核修正**：`Agent 与模型` 是「模型任务」组下的分类（`TOC_GROUPS`，`SystemSettingsView.vue:344`），「Agent 引擎」组下只有 integration（`:330-337`）；写成组名/不存在的分类会新建卡片并落入「其他」兜底。**定稿选 A：沿用 `Agent 与模型` 分类**（开关出现在「模型任务 → Agent 与模型」卡片），零改 TOC；
  5. 行本身由迁移种子插入（见 §3.1）。
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
  policy = settings('gitToken.scopePolicy') ?? 'lenient'

  if agentId == null:
     log('git-scope: no agent context, uid=%s', userId)        # 观察点，见 §9-4
     return policy == 'lenient' ? fullTokenMap(userId) : {}

  # D1（已定稿）：不过滤软删的轻量查询，只取一列。
  # 查不到行 = agent id 不存在（故障）；查到行且值为 NULL = 未配置——两者必须可区分，
  # 所以不能复用带 notDeleted() 的 findById（软删会退化成「查不到」）。
  row = agentRepo.selectGitAllowedDomainsById(agentId)
  if row == null:
     log('git-scope: agent not found, agentId=%s', agentId)
     return {}                                                 # 故障 → fail-closed

  if row.domains == null:                                      # 未配置
     log('git-scope: agent unconfigured, agentId=%s', agentId)
     return policy == 'lenient' ? fullTokenMap(userId) : {}

  allowed = parseDomainList(row.domains)                       # '[]' → []
  if allowed.isEmpty(): return {}                              # 显式禁止

  # D3（已定稿）：只解密交集，避免把用户全部 token 无谓解密出来
  result = gitCredentialService.getTokenMapByUserFiltered(userId, allowed)
  log('git-scope: injected=%d allowed=%d agentId=%s uid=%s',
      result.size, allowed.size, agentId, userId)
  return result

resolveForSession(userId, sessionId):
  if sessionId == null:
     log('git-scope: no session context, uid=%s', userId)   # 独立观察点（复核修正）：调用方漏传排查
     return resolveForAgent(userId, null)
  session = sessionRepo.selectById(sessionId)
  if session == null:
     log('git-scope: session not found, sid=%s uid=%s', sessionId, userId)
     return {}                                              # 故障 → fail-closed
  if session.userId !== userId:
     log('git-scope: session owner mismatch, sid=%s uid=%s', sessionId, userId)
     return {}                                              # 故障 → fail-closed
  return resolveForAgent(userId, session.agentId ?? null)
```

**「故障」与「配置未就绪」必须分开兜底（评审补充，安全相关；复核修正：`sessionId == null` 单列并加独立日志）**：

| 情况 | 定性 | 兜底 |
|---|---|---|
| `agentId == null`（结构上无 Agent 上下文：历史会话） | 配置未就绪 | 走全局策略（宽松全量 / 严格空） |
| `sessionId == null`（调用方未传会话上下文） | 配置未就绪 + **独立日志**（见伪代码） | 同上；现存调用点中 PTY（必填）、clone（`session.id` 已落库）可确定带值，dispatch 的 `ctx.sessionId` 类型允许 null——先以日志观察来源，确认后再评估收紧为 fail-closed |
| `session == null` / `agent == null` / `session.userId !== userId` | **故障** | **空集 + `warn` 日志**，与 DB 异常同口径 |

owner 不匹配应额外打 `warn`（疑似越权访问），不放行。

**软删 / 停用 Agent（D1，已定稿：选 A）**：此处原稿与上面的故障兜底冲突——`AgentRepository.findById`（`agent.repository.ts:36-38`）**带 `notDeleted()` 过滤**，软删 Agent 会返回 `null`，落到「`agent == null`」分支；而按修正后口径那是**故障 fail-closed → 空集**，等于「软删 Agent 的历史会话立刻断凭据」，且「删除 Agent」会变成隐式的收回凭据操作而 admin 删除确认毫无提示。

定稿口径：resolver **不用 `findById`**，改用不过滤软删的轻量查询 `selectGitAllowedDomainsById(id)`，只取 `git_allowed_domains` 一列：

```sql
SELECT git_allowed_domains FROM agent WHERE id = ?        -- 故意不带 notDeleted()
```

返回三态可区分：**查不到行** = agent id 不存在（故障 → 空集）；**查到行且值为 NULL** = 未配置（走策略）；**`'[]'`** = 显式禁止；**非空 JSON** = 白名单。语义即「Agent 存在过（哪怕已删）就按当时配置解析，id 根本不存在才算故障」。

附带收益：resolver 只需要一列，省掉一次整行读取；也不需要改 `findById`（它的 `notDeleted()` 是既有调用方依赖的行为）。

停用（`enabled=0`）不受影响：`notDeleted()` 只看 `deleted`，停用 Agent 的 `findById` 正常返回，按原配置解析。

**为什么不选 B/C**：B（软删即断凭据）实现最省，但会让删除 Agent 成为隐式收回凭据的入口，需额外在 admin 删除确认里加提示，且会话跑到一半断凭据比按原白名单继续更危险；C（让 `findById` 不过滤软删）会影响 `getAgent` 等所有既有调用方，不可取。

性能：每条 shell 命令新增 **3 次查询**（复核修正）——1 次 session 主键查询 + 1 次 agent 单列查询 + 1 次 `system_setting` 查询（`getGitScopePolicy` 走 `getValue`，`settings.service.ts:209` 每次 `findByKey` 查库、无缓存），本地库毫秒级，不引入缓存，优先保证配置与开关即时生效。若压测显示热点，再按 `agentId` 加 30–60s TTL 缓存（届时需处理严格模式切换的失效问题，单独立项）。

补充说明（评审修正）：

- 热路径只有通道 1（shell 工具，`refreshUserEnvironment` 每命令一次）与通道 2 的 PTY 创建；通道 5（建会话 clone）与通道 6（Git 面板写操作）是**一次性用户操作**，不计入「每条命令」的增量，原估高报了热点面；
- **解密面优化（D3，已定稿纳入本期）**：原实现先 `getTokenMapByUser(userId)` 解密该用户**全部** token 再筛，白名单只放 1 个域时其余域的 token 也被无谓解密。定稿：`GitCredentialService` 增加 `getTokenMapByUserFiltered(userId, domains: string[])`，SQL 带 `WHERE domain IN (...)`，只解密交集；`getTokenMapByUser` 现有签名与行为不动（宽松模式的全量返回仍走它）。这是纯增量，不扩大本期范围。
  - 归一化注意：过滤用的 `domains` 已是规范化后的 host，而 `user_git_credential.domain` 存入时也经过 `normalizeDomain`，两侧口径一致才能命中（见 §4.2-1 的公共函数抽取）。

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
| 3 | `harness/container/session-envelope-builder.ts:48-56` | deps 改为 resolver；`build()` 内 `resolveForSession(userId, sessionId)`；**容器内消费方零改动**（`container-mcp-bridge.ts` 与容器内 `ShellSessionTool` 读到的都是过滤后的 `envelope.gitTokens`；但后者的装配适配器要改，见下方警示块） |
| 4 | 容器 MCP 子进程（同 3 的下游） | 无代码改动，随 envelope 自动收敛 |
| 5 | `session/git-operation.service.ts:74-100` | `credentialEnv(userId, sessionId)` 改走 resolver |
| 6 | `file/git-write-operation.service.ts:503-527` | `credentialEnv(session)` 用 `resolveForAgent(session.userId, session.agentId ?? null)`（已有 session 对象，省一次查询） |

**⚠ 通道 1 的类型变更会波及容器侧（易漏点）**：`ShellSessionTool` 的第 5 个构造参数类型从 `GitCredentialLookup` 换成 `GitTokenResolver` 后，`harness/container/container-tool-executor.ts:108-111` 正在给 `ShellSessionTool` 传 `envelopeGitLookup`，**必须同步改造**，否则 `tsc` 不过：

```ts
const envelopeGitLookup = {
  getTokenMapByUser: async (_userId: number) => this.currentEnvelope?.gitTokens ?? {},
};
// 改为：
const envelopeTokenResolver: GitTokenResolver = {
  resolveForSession: async (_userId: number, _sessionId: number | null) =>
    this.currentEnvelope?.gitTokens ?? {},
  resolveForAgent: async () => this.currentEnvelope?.gitTokens ?? {},
};
```

`container-tool-executor.spec.ts` 的同址 mock 一并更新。此处不是"下游零改动"——容器**内**代码不动，但容器内 `ShellSessionTool` 的**装配适配器**要动。

不动的部分：

- `harness/shell/shell-session-manager.ts:552,720,772`：只消费传入的 `domainTokenMap`，不改；其「按前缀全清再注入」保证过滤后旧 token 在下一条命令前 unset；
- `harness/container/container-mcp-bridge.ts`：只消费 `envelope.gitTokens`，不改；
- `harness/container/container-tool-executor.ts` 的**容器内执行逻辑**不改，仅其 `ShellSessionTool` 装配适配器要改（见上文警示块）。

装配点：

- `create-app.ts`：**不能**在原 `gitLookup`（`:365-368`）处就地替换。`agentRepo`（`:384`）、`settingService`（`:435`）、`sessionRepo`（`:467`）均晚于 `gitLookup` 构造，resolver 依赖这三者，只能在 `:467` 之后新建：
  ```ts
  const gitTokenResolver = new GitTokenResolver(gitCredentials, agentRepo, sessionRepo, settingService);
  ```
  `gitLookup` 保留不动（`user/git-credential.routes.ts` 与 `registerAdminGitCredentialRoutes`（`app-routes.ts:409`）仍需 `GitCredentialService`），仅把下游 5 个消费方改指向 resolver：`gitOps`（`:501`）、`terminalManager`（`:631`）、`createDefaultToolRegistry`（经 `app-harness-engine.ts:189`）、`envelopeBuilder`（`app-container-runtime.ts:143`）、`gitWrite`（`:845`）；
- `app-container-runtime.ts:141-152`：`envelopeBuilder` 的 `gitCredentialService` 改为 resolver；
- `harness/container/container-tool-executor.ts:108-111`：`envelopeGitLookup` → `envelopeTokenResolver` 适配器（见上文警示块）。

### 3.6 契约与 UI

**契约** `shared/contracts/src/agent.ts` — `AgentVO` 增加：

```ts
/** Git 凭据域白名单：null=未配置（跟随全局策略），[]=禁止注入，非空=白名单 */
gitAllowedDomains?: string[] | null;
```

**后端**：

- `agent/types.ts`：`Agent` 增加 `gitAllowedDomains?: string | null`；
- `agent/agent.repository.ts`：`insert` / `updateById` 增加列映射（`updateById` 是全量回写，照 `httpToolIds: agent.httpToolIds ?? null` 写 `gitAllowedDomains: agent.gitAllowedDomains ?? null`，`'[]'` 不会被折叠，安全）；
- `agent/agent.service.ts`：`createAgent` / `updateAgent` 追加参数（加在参数列表末尾，保持既有调用兼容）；`[]` 存 `'[]'`，不做 null 折叠；
- `agent/agent.routes.ts`：
  - `CreateAgentRequest` / `UpdateAgentRequest` 增加 `gitAllowedDomains?: string[] | null`；
  - 新增校验 `normalizeGitDomains()`：逐项 `normalizeGitDomain` + 去重，非法抛 `PARAM_INVALID`；
  - `toVO` 反序列化为数组，`null` 原样返回；**复核修正**：建议 `scope=client` 的列表/详情不返回该字段（普通客户端无需知道 Agent 的凭据访问范围，最小暴露；实现为 `toVO` 加可选开关，管理端路径照常返回）。

**⚠ 三态语义必须区分 `undefined` 与 `null`（评审补充，易错点）**：`updateAgent` 是**部分更新**，现有字段统一 `if (x != null)` 处理，导致 `[]` 和 `null` 都不写库（`agent.service.ts:145-152`）。本字段有四种输入，必须在方案与单测里固定：

| 入参 | 语义 | 落库 |
|---|---|---|
| `undefined`（参数未传） | 不改（PATCH 只改名称时不能被清掉） | 保持原值 |
| `null` | 清空（管理表单关闭开关） | `NULL` |
| `[]` | 显式禁止注入 | `'[]'` |
| `[...]` | 白名单 | JSON 字符串 |

**⚠ 域名条数限制与列宽自相矛盾（评审补充）**：原稿「≤32 条 / 单条 ≤253 字符」与 `VARCHAR(1024)` 冲突——32×256 ≈ 8192 字符，分项全过而总长超限。修正：**`JSON 总长 ≤1024` 作为最终闸门，放在校验末尾**；≤32 条 / ≤253 字符仅用于提前给出友好错误，不得先于总长校验短路。

**管理后台**：

- `admin/src/views/agent/AgentFormDialog.vue`：「Git 凭据域」表单项，放在「自定义 HTTP 工具」之后——
  - 「启用域名限制」开关：关闭 = `NULL`；开启 + 空列表 = `[]`（提示「空列表 = 禁止注入」）；开启 + 有值 = 数组；
  - 回显要能区分后端返回的 `null` 与 `[]`：开关绑定写成 `modelValue !== null && modelValue !== undefined`，否则「开启 + 空」会被显示成关闭；
  - 域名输入：候选多选 + 手工输入。**候选源定稿为「当前管理员自己的」`GET /v1/user/git-credentials`**（D4 已定，零新端点）——原稿的 `GET /v1/admin/git-domains`（`SELECT DISTINCT domain FROM user_git_credential`）会把全站所有用户配过的域名透给持该权限的人，是新的横向枚举面，而唯一用途只是表单提示，性价比不成立；手工输入走同一 `normalizeGitDomain` 校验，避免两侧口径漂移；
  - **不做「一键预设」按钮**（D5 已定）：候选多选本身就是预设——管理员勾选自己已配的域即可，再单独加一个「按我的 token 域填充」按钮是重复交互。若后续反馈勾选繁琐，再作为增强项提。
- `admin/src/views/agent/AgentListView.vue`：能力摘要 tooltip 已有「技能 / MCP」两行（`:98-99`），加「Git 域：未配置 / 已禁止 / N 个域」一行即可；列表按「未配置」筛选需要 **`AgentService.listAgents` 加第四个过滤参数**（现签名仅 `userId / keyword / includeDisabled / clientVisibleOnly`）+ repository 查询条件，这是 §5 清单原先漏掉的改动；**复核修正**：新参数默认关闭，不得改变 `app-harness-engine.ts:189` 的 `listOptions`（`selectList(null, true)`）行为；
- `admin/src/views/settings/SystemSettingsView.vue`：「Git 凭据域策略」下拉（宽松 / 严格，形态见 §3.2），同步 `settingsSearchCatalog.ts` 搜索条目。

**桌面端（可选，P2）**：`desktop/src/views/settings/GitCredentialsView.vue` 增一行说明「凭据仅在被 Agent 允许的域名下注入」，不阻塞主链路。

### 3.7 可观测

- resolver 在「过滤发生」「无上下文」「Agent 未配置」三处各打一条 `harnessLog('info')`：`uid / agentId / sessionId / injected`；
- **`dropped` 计数取消（D3 的连带影响，评审补充）**：定稿只解密交集后，resolver 手里没有「用户全部 token」这个分母，`dropped` 需要额外一次 `COUNT(*)` 查询才能算出来，而它只是观测指标、不值得为它多一次查询或把全部 token 解密出来。改为只记 `injected`（命中数）与 `allowed`（白名单条数，不含域名内容）——`injected < allowed` 即说明有允许域没配 token，`injected` 突降即说明收敛发生，足以支撑判断；
- **不记录域名清单与 token**，避免日志成为新的泄漏面；
- 严格模式切换后关注 `injected` 的分布变化（尤其从 N 掉到 0 的 Agent），确认是预期收敛而非误伤；原「`dropped > 0`」的观测口径随之改为「`injected < allowed`」。

## 4. 实现步骤

### 4.1 数据库

1. 新增 `db/migration/V187__agent_git_allowed_domains.sql`：`ALTER TABLE agent` 加列 + `INSERT IGNORE INTO system_setting` 种子插入 `gitToken.scopePolicy` 行（缺行则管理后台不渲染该控件，见 §3.1 / §3.2）；
2. `agent` 表无数据回填，全部为 `NULL`（宽松模式行为不变）。

### 4.2 后端（backend-ts）

1. 抽公共函数 `normalizeGitDomain()` 到 `src/common/git-domain.ts`（现逻辑在 `GitCredentialService.normalizeDomain` / `validateDomain`，含 `DOMAIN_PATTERN`），`GitCredentialService` 改为调用它，行为不变；agent 路由复用同一函数，保证「用户配置的 token 域」与「Agent 允许域」两侧规范化口径一致。
   **保留两条不同错误文案**：`normalizeDomain` 空值抛「域名不能为空」、`validateDomain` 格式不符抛「域名格式无效，示例: github.com」，是两个 `private` 方法、两条语义，抽取时不得合并成一句，否则 agent 表单复用时的错误提示会退化；
2. `GitCredentialService` 增加 `getTokenMapByUserFiltered(userId, domains)`（D3），SQL 带 `WHERE domain IN (...)`，只解密交集；`domains` 为空时直接返回 `{}`（复核修正：方法作为独立 API 的边界保护，防 `IN ()` 非法 SQL）；`getTokenMapByUser` 签名与行为不动；
3. `AgentRepository` 增加 `selectGitAllowedDomainsById(id)`（D1）——**故意不带 `notDeleted()`**，只取 `git_allowed_domains` 一列，用于区分「agent 不存在（故障）」与「未配置（值为 NULL）」；
4. `agent/types.ts`、`agent/agent.repository.ts`、`agent/agent.service.ts`、`agent/agent.routes.ts` 增加字段与校验；`AgentService.listAgents` 增加「未配置」过滤参数；
5. `session/types.ts` 新增 `GitTokenResolver` 接口；新增实现 `src/user/git-token-resolver.ts`；
6. 五个注入点改造（§3.5 表）+ 装配（create-app / app-container-runtime / **container-tool-executor 适配器**）；
7. `settings/settings.service.ts` 增加 `getGitScopePolicy(): Promise<'lenient' | 'strict'>`（读 `gitToken.scopePolicy`，缺省 `lenient`）。

### 4.3 契约与前端

1. `shared/contracts/src/agent.ts` 增加 `gitAllowedDomains`；
2. admin 三处：`AgentFormDialog.vue`（表单）、`AgentListView.vue`（状态展示与筛选）、`SystemSettingsView.vue`（策略开关）+ `settingsSearchCatalog.ts`。

### 4.4 文档

1. 根 `CHANGELOG.md` 顶部记一条（用户可见：Agent 可限制可注入的 Git 凭据域）；
2. `skills/mao-cli/` 中与 Agent 配置 / 凭据相关的说明按需同步（实施时确认落点）；
3. （评审补充）向使用者说明 PTY 限制：**收紧 Agent 的 Git 凭据域或切换 Agent 后，已开着的交互式终端不会立即失效，需重开终端**（shell 工具会话不受影响，下一条命令即生效）；
4. （评审补充）`README.md` / `DEPLOY.md` 若有凭据注入相关描述，同步补一句「注入域 = 用户凭据域 ∩ Agent 允许域」。

## 5. 改动清单（文件级）

| 类型 | 文件 | 说明 |
|---|---|---|
| 迁移 | `backend-ts/db/migration/V187__agent_git_allowed_domains.sql` | 新增列 + `gitToken.scopePolicy` 种子行 |
| 后端 | `backend-ts/src/common/git-domain.ts`（新增） | 域名规范化公共函数（保留两条错误文案） |
| 后端 | `backend-ts/src/user/git-credential.service.ts` | 改用公共函数（行为不变）；新增 `getTokenMapByUserFiltered`（D3） |
| 后端 | `backend-ts/src/user/git-token-resolver.ts`（新增） | 统一解析器实现 |
| 后端 | `backend-ts/src/session/types.ts` | `GitTokenResolver` 接口 |
| 后端 | `backend-ts/src/agent/types.ts` / `agent.repository.ts` / `agent.service.ts` / `agent.routes.ts` | 字段读写、三态校验、VO、未配置筛选参数；`selectGitAllowedDomainsById`（D1） |
| 后端 | `backend-ts/src/harness/tool/tool-registry.ts` | 工具注册依赖类型替换 |
| 后端 | `backend-ts/src/harness/tool/impl/shell-session-tool.ts` | 注入点 1 |
| 后端 | `backend-ts/src/harness/terminal/terminal-manager.ts` | 注入点 2 |
| 后端 | `backend-ts/src/harness/container/session-envelope-builder.ts` | 注入点 3 |
| 后端 | `backend-ts/src/harness/container/container-tool-executor.ts` | **`envelopeGitLookup` → `envelopeTokenResolver` 适配器（类型变更必改，否则 tsc 不过）** |
| 后端 | `backend-ts/src/session/git-operation.service.ts` | 注入点 5 |
| 后端 | `backend-ts/src/file/git-write-operation.service.ts` | 注入点 6 |
| 后端 | `backend-ts/src/create-app.ts` / `src/app-container-runtime.ts` | 装配（resolver 建于 `sessionRepo` 之后，`gitLookup` 保留） |
| 后端 | `backend-ts/src/settings/settings.service.ts` | 策略读取 |
| 契约 | `shared/contracts/src/agent.ts` | VO 字段 |
| admin | `admin/src/views/agent/AgentFormDialog.vue` / `AgentListView.vue` | 表单与列表 |
| admin | `admin/src/views/settings/SystemSettingsView.vue` / `settingsSearchCatalog.ts` | 策略开关（谓词 + `el-select` 分支） |
| 测试 | 各模块 `*.spec.ts` | 见 §7 |

## 6. 上线与迁移路径（四阶段）

**阶段 1：代码上线（行为零变化）**

- 执行迁移；所有 Agent 的 `git_allowed_domains` 为 `NULL`；策略默认宽松 → 与现状完全一致；
- 回归：shell / 终端 / 容器 / Git 面板的 clone、fetch、push 均正常。

**阶段 1.5：盘点实际所需域（评审补充，勿跳过）**

- 收紧是即时生效的。配白名单前先从 `SELECT user_id, domain FROM user_git_credential` 的分布 + 两个 Agent 历史会话的工作区，反推每个 Agent **实际需要**的域；
- 否则「野子恰好有任务要动 ACG 的某个仓库」这类场景会在配置生效的瞬间失败，且表现为「Git 突然连不上」而非配置问题。

**阶段 2：配置两个 Agent（事故场景立即关闭）**

- 梁子配置 `["git.acg.team"]`（按阶段 1.5 盘点结果补充其它域）；野子配置 `["git.zizaitianye.com"]`；
- **配置后重开两侧已开着的 shell / PTY 终端、重连容器 MCP 连接**：PTY 与容器 MCP 都没有刷新机制（见 §9-5），不重开 / 重连的话旧 token 会一直驻留在已开终端与已建连接里；
- 验收（事故回放）：
  - 野子会话内：`env | grep GIT_TOKEN` 无 `git.acg.team` 条目；`git clone https://git.acg.team/...` 因无凭据失败；
  - 梁子会话内：clone / push ACG 仓库正常。

**阶段 3：收敛存量并切严格**

- 管理后台按「未配置」筛选，逐批确认并配置；
- 关键 Agent（或全部）配置完成后，系统设置切「严格模式」；
- 切严格后同样需要重开各 Agent 的存量终端、重连 MCP 连接（见 §9-5）；
- 观察 1–2 周日志中 `injected` 的分布（口径见 §3.7：`injected < allowed` 说明有允许域没配 token）与目录内业务反馈，确认无受损后进入常规运维。

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
| `agentId == null`（无 Agent 上下文） | 全量 + 日志 | `{}` + 日志 |
| session 查不到 / owner 不匹配 | **`{}` + `warn`（故障 fail-closed）** | `{}` + `warn` |
| agent id 不存在（`selectGitAllowedDomainsById` 查不到行） | **`{}` + `warn`（故障 fail-closed）** | `{}` + `warn` |
| 软删 Agent（`deleted=1`，D1） | 按当时配置解析（查询不过滤软删） | 同左 |
| 停用 Agent（`enabled=0`） | 按原配置解析 | 同左 |
| resolver 内部异常（DB 挂、JSON 解析失败） | `{}` + `warn` | `{}` + `warn` |

D1/D3 的专项断言：`selectGitAllowedDomainsById` 的 SQL **不得含 `notDeleted()`**；白名单场景下断言只解密了交集的 token（spy 解密函数调用次数 = 交集大小，而非用户全部 token 数）。

- 匹配矩阵：大小写（`Git.ACG.Team`）、带协议 / 路径的配置项规范化、非 git 前缀域名（任意 host 应支持）、后缀混淆（`git.acg.team.evil.com` 不命中 `git.acg.team`）；
- 三态存取：`[]` 必须落 `'[]'` 不得折叠为 NULL；`updateAgent` 传 `undefined` 不改、传 `null` 清空（service 单测固定）。

**注入点测试（五处）**

- 各注入点原先 spy `getTokenMapByUser` 的用例改为 spy `GitTokenResolver.resolveForSession/ForAgent`；
- shell 工具：验证传入 `ShellSessionManager` 的 `domainTokenMap` 为过滤后集合；容器 envelope：验证 `envelope.gitTokens` 为过滤后集合（`session-envelope-builder.spec.ts`）；
- **`container-tool-executor.spec.ts` 必须同步改**：`envelopeGitLookup` mock 换成 resolver 形态（见 §3.5 警示块），否则类型不匹配。

**回归**

- `shell-session-tool.spec.ts`、`terminal-manager.spec.ts`、`git-operation` 相关 spec、`container-tool-executor.spec.ts`、`agent` 系列 spec 全绿；
- 一并更新以下仍在 spy `getTokenMapByUser` 的 spec：`harness/core/logic-bug-audit.spec.ts:154`、`session/session-extra.spec.ts:597`、`harness/tool/impl/shell-workdir.spec.ts:53`；
- `pnpm/npm run build` + 现有测试全量通过。

**admin 单测**

- `agent.routes.spec.ts`：`normalizeGitDomains` 边界——空项、超长（>1024 总长）、重复项、大小写混合、带协议/路径；
- `AgentFormDialog` 回显：后端返回 `null` 显示关闭、返回 `[]` 显示「开启 + 空」（同目录有 `cidrAllowlist.spec.ts` / `settingsLocator.spec.ts` 先例）。

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
7. 既有测试全部通过，无新增回归；
8. （评审补充，复核修正）不存在的 sessionId / 跨用户 sessionId 时不注入任何凭据，并落 `warn` 日志；`sessionId == null`（调用方未传）落独立 info 日志；
9. （评审补充）重开终端后，收紧前的旧 `GIT_TOKEN_*` 不再出现在 PTY 环境里；
10. （评审补充）管理后台能看到并切换「Git 凭据域策略」（种子行生效）；
11. （复核修正）重连容器 MCP 连接后，收紧前的旧 `GIT_TOKEN_*` 不再出现在 MCP 子进程环境里。

## 9. 风险与回归护栏

1. **存量未配置 Agent（宽松期仍全量注入）**：本方案的收敛依赖「配置动作 + 切严格」，为此提供配置状态可见（列表筛选）与策略开关；验收清单里把「未配置 Agent 清零」列为切严格的前置条件；
2. **`[]` 与 `NULL` 混淆**：`AgentService` 对该字段单独处理并有专项单测，禁止把 `[]` 折叠成 `NULL`；同时禁止把 `undefined`（不修改）当成 `null`（清空）处理（见 §3.6 三态表）；
3. **性能**：每条 shell 命令新增 3 次查询（复核修正：session + agent + `system_setting`，策略读取当前无缓存）；压测若观测到明显延迟，再以 `agentId` 为键加 TTL 缓存（需处理策略开关即时性，另立小方案）。热路径仅通道 1 与 PTY 创建，通道 5/6 是一次性用户操作，不计入增量；
4. **`session.agentId` 为空的历史会话**：按「无 Agent 上下文」处理（宽松放行 + 日志 / 严格拒绝），并观察日志确认此类调用点是否符合预期；**注意与「故障」区分**——session 查不到、owner 不匹配一律 fail-closed 返回空集，不在宽松模式下放行（见 §3.3）；
5. **长驻进程的旧 env（PTY / 容器 MCP 两个盲点，复核修正）**：已 spawn 的 shell / PTY 子进程持有旧 env。shell 侧有 `for k in ${!GIT_TOKEN_@}; do unset "$k"; done`（`shell-session-manager.ts:582`）在每条命令前全清，收紧后下一条命令即生效；**但两条通道没有刷新机制**——
   - **PTY 终端**：`terminal-manager.ts:440` 仅在创建 PTY 时注入一次，之后无刷新入口、无前缀 unset。收紧白名单或切换 Agent 后，**已开着的 PTY 会一直持有旧 token 直到终端重开**；
   - **容器内 MCP 连接**：`ContainerMcpBridge.connectAndListTools`（`container-mcp-bridge.ts:36-46`）在**连接时**用 `containerMcpEnv(serverEnv, envelope)` 构造 env，之后 `callTool` 复用 `sessionClients` 里的长驻客户端——**不会**随 envelope 更新。收紧变更后需重连 MCP（或重建会话）才生效；
   两条均为已知限制而非缺陷（交互 / 连接语义决定无法逐次注入），须写入使用者文档，并把「重开终端 / 重连 MCP」列入 §6 阶段 2/3 的运维步骤与验收清单；
6. **端口 / 子域匹配**：本方案不改变匹配语义；带端口的 remote（`git.acg.team:8443`）与现状行为一致（既有问题，不在本期）；
7. **LOCAL 会话**：不经过平台注入，行为不变；若未来要求「桌面端读取服务端凭据」，另行设计；
8. **误配白名单导致业务受损**：日志中 `injected` 异常掉到 0（或明显低于 `allowed`）时先切回宽松定位，再修配置；
9. **软删 Agent 的历史会话（D1 已定稿：选 A）**：resolver 用不过滤软删的 `selectGitAllowedDomainsById`，软删 Agent 按当时配置继续解析；agent id 根本不存在才算故障并 fail-closed。**不要**用带 `notDeleted()` 的 `findById`（见 §3.3）。**连带运维口径（复核修正）**：软删后 Agent 在管理后台不可见、无法再改白名单——如需在删除时立即收回凭据，应先将其 `git_allowed_domains` 设为 `[]`（禁止）再删除；建议 admin 删除确认文案加一句提示（可选增强）；
10. **`container-tool-executor` 适配器漏改**：`ShellSessionTool` 依赖类型变更会波及该文件（见 §3.5 警示块），漏改则 `tsc` 直接报错——这是全方案唯一阻断编译的点，实现时优先处理。

## 10. 决策记录（原开放问题，2026-11-06 已全部定稿）

> **决策状态（2026-11-06 全部定稿）**——D1–D6 已按评审建议定稿，无遗留待拍板项：
>
> | # | 事项 | 定稿 | 位置 |
> |---|---|---|---|
> | D1 | 软删 Agent 的会话 | **选 A**：resolver 用不过滤软删的 `selectGitAllowedDomainsById`，软删按当时配置解析；id 不存在才算故障 | §3.3、§9-9 |
> | D2 | `agentId == null`（历史会话）兜底 | **宽松全量 + 日志**（更严方案不采纳：会让所有历史会话直接不可用，收益不足以抵代价） | §3.3 |
> | D3 | 只解密交集 | **纳入本期**：新增 `getTokenMapByUserFiltered(userId, domains)`，`getTokenMapByUser` 不动 | §3.3、§4.2 |
> | D4 | 候选域来源 | **管理员自己的 `/v1/user/git-credentials`**，不做 `GET /v1/admin/git-domains` | §3.6 |
> | D5 | 「一键预设」按钮 | **不做**：候选多选即预设 | §3.6 |
> | D6 | 严格模式切换 | 配置验收后由平台管理员切换，切换前跑「未配置清单清零」检查 | §6 阶段 3 |
>
> 另两项确认后不再讨论：用户端透明度放到下一期与第二层一起做；子域支持本期不做，实际存在多个子域 Git 服务端时显式列举。

1. 无 Agent 上下文（`agentId == null`，如历史会话）时的兜底口径（D2 已定稿）：宽松全量 + 日志。理由——「始终不注入」虽更严，但会让全部历史会话在严格模式下直接不可用，而 `agentId == null` 在本期实际只出现在存量历史会话，收益不足以抵代价；真正的「故障」类已单独 fail-closed（见 §3.3）；
2. Agent 表单交互：定稿「启用开关 + 标签输入 + 候选多选」（见 §3.6）；**不做**额外「一键预设」按钮（D5——候选多选本身就是预设，再加按钮是重复交互）；
3. 严格模式切换时机与责任人（D6 已定稿）：两家公司 Agent 配置验收后由平台管理员切换，切换前跑一次「未配置清单清零」检查；切换后需重开各 Agent 的存量终端（见 §6 阶段 3）；
4. 用户端透明度：**下一期**再议，与第二层（动态签发）一起做，届时在桌面设置页展示「我的凭据将在哪些 Agent 生效」；
5. 子域支持：本期不做，显式列举；若实际存在 `a.acg.team`、`b.acg.team` 多个服务端，逐条写入白名单而非引入 `*.` 通配；
6. 与「凭据显式绑 Agent」（`user_git_credential.agent_id`）的关系：本期域级已覆盖当前场景；若未来出现「同一域名在不同 Agent 下需要不同 token」的需求，再把作用域下沉到凭据行，本方案的 resolver 是届时唯一改造点。

## 11. 评审记录（2026-11-06）

**结论：需求可行，方案可行，但原稿不完善。** 已按评审意见修订，D1–D6 待决策项已全部定稿（见 §10 顶部决策表），无遗留待拍板事项；修订点全部落在上文对应小节，此处仅留索引。

核实通过的关键前提（方案成立的地基，均与代码一致）：

- 六条通道真实存在；`getTokenMapByUser` 是唯一凭据源，6 处生产调用、5 个通道（`container-tool-executor.ts:109` 是 envelope 适配器——生产代码但非注入源，复核修正）；
- `shell-session-manager.ts:582` 的 `for k in ${!GIT_TOKEN_@}; do unset "$k"; done` 前缀全清确实存在——这是「控制传入 map 即可收敛」能成立的关键机制；
- 飞书 / 微信 bot 会话都带 `agentId`（`app-feishu-messaging.ts:66`、`weixin/session.service.ts:40`），不是空悬字段；
- `updateSessionAgent` 允许会话中途切 Agent（`session.service.ts:1579`），方案按注入时实时读 `session.agentId`，天然正确；
- 迁移 V187 空置（最新 V186）；`AFTER http_tool_ids` 合法（V166 所加列）。

已修订的问题：

| # | 问题 | 修订位置 |
|---|---|---|
| 1 | `container-tool-executor.ts` 必须改（`ShellSessionTool` 依赖类型变更会阻断编译），原稿误写「下游零改动」且 §5 清单漏列 | §3.5 警示块、§5、§9-10 |
| 2 | `create-app.ts:364-367` 不能就地替换 `gitLookup`——`agentRepo`(:384)/`settingService`(:435)/`sessionRepo`(:467) 均晚于 `gitLookup`(:365)，resolver 只能建于 467 之后，且 `gitLookup` 须保留给 user/admin 路由 | §3.5 装配点 |
| 3 | 「查不到」在宽松模式下放行全量，等于传错 sessionId / 并发删除 / 跨用户误传都能拿到全部凭据 | §3.3 故障 vs 配置未就绪表、§9-4、§10-1 |
| 4 | 软删 / 停用 Agent 的行为未定义 | §3.3（D1 定稿选 A：不过滤软删的单列查询） |
| 5 | `system_setting` 行必须随迁移种子插入，否则管理后台分类卡片不渲染该控件；`description` 仅 `VARCHAR(256)`，长文案须放前端 | §3.1、§3.2 |
| 6 | admin 策略开关不是「加个 radio」，须照 `isRuntimeModeSetting` 范式加谓词 + `el-select` 分支 + 搜索条目 | §3.2、§3.6、§5 |
| 7 | `updateAgent` 部分更新语义下，`undefined`/`null`/`[]`/`[...]` 四种输入未区分 | §3.6 三态表、§9-2、§7 |
| 8 | 「≤32 条 / ≤253 字符」与 `VARCHAR(1024)` 冲突，须以总长为最终闸门 | §3.6 |
| 9 | `listAgents` 签名要改才能支持「未配置」筛选，原稿与 §5 均漏 | §3.6、§4.2 |
| 10 | `GET /v1/admin/git-domains` 引入全站域名横向枚举面，降级为 P2，推荐改用管理员自己的 `/v1/user/git-credentials` | §3.6 |
| 11 | 性能估高报了热点面（通道 5/6 是一次性操作）；且现实现会先解密全部 token 再筛 | §3.3、§9-3 |
| 12 | PTY 没有前缀全清机制，收紧白名单后旧 token 驻留已开终端 | §9-5、§6 阶段 2/3、§8-9 |
| 13 | 测试清单漏 `container-tool-executor.spec.ts`、`logic-bug-audit.spec.ts:154`、`session-extra.spec.ts:597`、`shell-workdir.spec.ts:53`、admin 单测 | §7 |
| 14 | `normalizeGitDomain` 抽取时两条错误文案不得合并 | §4.2 |
| 15 | 阶段 2 直接配白名单会误伤「野子恰好要动 ACG 仓库」的场景 | §6 阶段 1.5 |

未改动但需知晓的既有约束（本期范围外）：LOCAL 桌面执行链路不经平台注入；带端口 remote 与子域匹配语义沿用现状；`GIT_TOKEN_*` 已在 `common/sensitive-env.ts` 的保留前缀内，用户环境变量无法覆盖它。

### 第二轮复核（2026-11-06）

对评审修订稿逐条对照代码复核，确认 15 项修订基本成立；本轮修正 6 处（正文内联标注「复核修正」）：

| # | 问题 | 修订位置 |
|---|---|---|
| 1 | TOC 归属写错：`Agent 与模型` 是「模型任务」组下分类（`SystemSettingsView.vue:344`），不在「Agent 引擎」组（该组仅 integration）；定稿选 A——沿用该分类、零改 TOC | §3.1、§3.2-4 |
| 2 | 查询次数口径：`getGitScopePolicy` 走 `getValue`（每次 `findByKey` 查库、无缓存），每条命令实为 3 次查询（session + agent + `system_setting`），不是 2 次 | §3.3、§9-3 |
| 3 | 长驻盲点补容器内 MCP 连接（连接时构造 env、`callTool` 复用长驻客户端，需重连才生效） | §9-5、§6、§8-11 |
| 4 | `sessionId == null` 与 `agentId == null` 分离：前者独立打日志（调用方漏传排查），确认来源后再评估 fail-closed | §3.3 |
| 5 | 软删 Agent 的运维缺口：删除后不可见、无法改白名单，删除前应清空白名单；admin 删除确认提示（可选增强） | §9-9 |
| 6 | 小项：`isMcpLoadModeSetting` 行号 627（非 631）；`getTokenMapByUserFiltered` 空数组边界；`scope=client` 最小暴露；`listAgents` 新参数默认值须保持 `listOptions` 行为；§8-8 措辞 | §3.2、§3.6、§4.2、§8 |

复核抽查确认无误的关键行号与事实：`shell-session-manager.ts:582` 前缀全清、`session.service.ts:1579` `updateSessionAgent`、`app-feishu-messaging.ts:66` / `weixin/session.service.ts:40` bot 会话带 agentId、`system_setting` 六列结构与 `description VARCHAR(256)` / `setting_key UNIQUE`、`sensitive-env.ts` 的 `GIT_TOKEN_` 保留前缀、宿主机 MCP env 白名单不含 `GIT_TOKEN_*`（六通道清单无遗漏）、`create-app.ts:845` / `app-harness-engine.ts:189` / `app-routes.ts:409` / `shell-workdir.spec.ts:53` 行号、`agent.deleted`（V052）、V186 为最新迁移（V187 空置）、`normalizeGitDomain` 两条错误文案分离、`DockerDispatchContext.sessionId` 允许 null（据此保留日志观察而非直接 fail-closed）。

