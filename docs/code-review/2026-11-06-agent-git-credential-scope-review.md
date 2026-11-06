# 代码审查报告：Agent 级 Git 凭据域收敛（feat/agent-git-allowed-domains）

- 审查对象：worktree `.worktrees/git-token-scope` 分支 `feat/agent-git-allowed-domains` 的**未提交改动**（35 个改动文件 + 7 个新增文件，约 600 行）
- 审查范围：`backend-ts`、`admin`、`shared/contracts`、迁移 SQL（文档 / CHANGELOG / skills 变更不在审查范围）
- 审查方式：逐文件读代码 + `tsc -p tsconfig.build.json --noEmit` + `vue-tsc -b` + 相关单测 + 临时探针 spec 复现（已删除，代码见下文）
- 结论日期：2026-11-06

## 1. 总体结论

**可以合并，但有 1 个需要随本次一并修复的重要功能缺陷（P1，非安全方向）**：0 个阻塞项，1 个重要项。

- 安全侧的六条凭据通道、三态语义、fail-closed 兜底、装配顺序、API 权限门、admin 三态映射、迁移种子行均与方案一致，未发现漏改通道或越权放行；
- 但新增的 `session.userId !== userId` 校验与既有「运行身份（runtimeUserId）」机制冲突：**当一次执行不是由会话归属者发起时（飞书 / 钉钉群聊里非建会话的人发言，以及其子代理会话），整条链路的 Git 凭据会被全部丢弃**（宽松模式、Agent 白名单已配置也一样）。改造前这些场景注入的是「发言者自己的」token，属于本次改造引入的功能回归。

## 2. 问题列表

### 重要（P1，建议合并前修复）

#### 2.1 运行身份 ≠ 会话归属时，Git 凭据被整体丢弃（shell / 容器 envelope 通道）

**位置**

- `backend-ts/src/user/git-token-resolver.ts:43-51`（owner 校验，问题根因）
- 触发链路（改造后传的是运行身份）：
  - `backend-ts/src/harness/tool/tool-dispatcher.ts:291,421`：`shell` 工具的 `userId` 取 `runtimeUserId`
  - `backend-ts/src/harness/core/harness-service.ts:113-117,393`：`runtimeUserFor()` 默认 `execution` 模式 = 本次发言者，`context.runtimeUserId` 独立于 `context.userId`（= `session.userId`）
  - `backend-ts/src/app-feishu-handler.ts:141-147`：`executionUserId: triggerUserId`（当前发言人）
  - `backend-ts/src/feishu/message.service.ts:140-145,353-359`：群会话按 `(appId, chatId)` 复用、不按 owner 过滤；会话由**第一条消息的发言人**创建（`app-feishu-messaging.ts:75-80` 用 `user.id` 建 session）
  - `backend-ts/src/dingtalk/runtime.ts:230-235`：`executionUserId: owner`（当前发言人），群会话同样按会话 ID 复用
  - 容器通道同源：`backend-ts/src/harness/container/docker-tool-router.ts:84-86`（`userId: ctx.userId` = 运行身份）→ `session-envelope-builder.ts:47-53`

**问题描述**

`resolveForSession(userId, sessionId)` 把入参 `userId` 当作「会话归属者」来校验：`session.userId !== userId → return {}`。但六条通道里至少有 shell（含 docker 容器内 shell、容器 MCP 的 envelope）传入的 `userId` 是**运行身份**（`runtimeUserId` = 本次发言者），而不是会话归属者；两者在下面场景天然不相等：

1. 飞书群聊：用户 A 首次 @bot 建会话（`session.user_id = A`），随后同一群里已绑定的用户 B 发言 → `executionUserId = B`，`runtimeUserId = B`；
2. 钉钉群聊：同上（群会话按 `conversation_id` 复用，`ownerUserId` 只在创建时落库）；
3. 上述会话派生的子代理（`SUBAGENT`）会话：`userId` 继承父会话 owner（A），`lastRuntimeUserId` / 运行身份是 B（`subagent-invocation.service.ts:26-48,101-108`）；
4. 任何 `lastRuntimeUserId ≠ user_id` 的会话（失败重试 / 崩溃恢复沿用上次运行身份）。

结果是：**B 在自己参与的群会话里执行 `git clone / fetch / push` 时拿不到任何 `GIT_TOKEN_*`**（连 B 自己配置的 token 也被丢弃）。改造前 `getTokenMapByUser(userId)` 取的就是 B 的 token，因此这是本次改动带来的回归，而不是存量问题。注意这与「故障 fail-closed」无关：session 存在且归属者明确，只是发起执行的用户不是归属者。

**影响**

- 飞书 / 钉钉群聊会话（含其子代理、边路任务）在 host 模式下 shell 工具无任何 Git 凭据；docker 模式下容器 shell 与容器 MCP 同样无凭据 → 私有仓库 clone/pull/push 全部失败，表现为「Git 突然连不上」，且日志只有一条 `[git-scope] session owner mismatch`。
- 安全方向不受影响（fail-closed 仍成立），影响面是可用性/功能正确性。

**复现（已实测）**

临时 spec（`backend-ts/src/__review_tmp__/runtime-identity.tmp.spec.ts`，验证后已删除）用**真实** `DefaultGitTokenResolver` + 真实 `ShellSessionTool`：

```ts
const OWNER = 1, SPEAKER = 2, SESSION_ID = 100, AGENT_ID = 10;
const resolver = new DefaultGitTokenResolver({
  gitCredentialService: {
    getTokenMapByUser: async (uid) => new Map([['git.acg.team', `tok-of-${uid}`]]),
    getTokenMapByUserFiltered: async () => new Map(),
  },
  agentLookup: { selectGitAllowedDomainsById: async () => ({ domains: null }) },   // 宽松 + 未配置
  sessionLookup: { selectById: async () => ({ userId: OWNER, agentId: AGENT_ID }) }, // 会话归属 = OWNER
  scopePolicy: { getGitScopePolicy: async () => 'lenient' },
});

// 改造前的口径（旧代码即 getTokenMapByUser(发言者)）：能拿到发言者自己的 token
expect(await resolver.resolveForAgent(SPEAKER, AGENT_ID)).toEqual({ 'git.acg.team': 'tok-of-2' });
// 改造后：owner 不匹配 → 全空
expect(await resolver.resolveForSession(SPEAKER, SESSION_ID)).toEqual({});

// 通道 1 端到端：传 sessionId=100、userId=发言者（与 tool-dispatcher 一致）
await tool.execute('{"command":"git clone https://git.acg.team/a/b.git"}', SESSION_ID, SPEAKER, '/tmp');
expect(sessionManager.getOrCreate.mock.calls.at(-1)?.[4]).toEqual({}); // 会话拿到的 tokenMap 是 {}
```

运行结果（2 个用例均通过，日志佐证）：

```
[git-scope] agent unconfigured agentId=10 uid=2 policy=lenient
[git-scope] session owner mismatch sid=100 uid=2 owner=1
[git-scope] session owner mismatch sid=100 uid=2 owner=1
```

**修复建议**

把「运行身份」纳入 owner 校验，保持其余情况 fail-closed：

1. `GitTokenResolverDeps.sessionLookup.selectById` 的返回类型补 `lastRuntimeUserId?: number | null`（`session` 表已有该列，`findById` 的 `SELECT *` 会带出来）；
2. `resolveForSession` 改成：

   ```ts
   const isOwner = session.userId === userId;
   const isRuntimeUser = session.lastRuntimeUserId != null && session.lastRuntimeUserId === userId;
   if (!isOwner && !isRuntimeUser) { harnessLog('warn', ...); return {}; }
   ```

   （`lastRuntimeUserId` 在每轮 `buildContext` 开始时已落库，运行期等于当前运行身份；子代理会话创建时也会继承，故两种场景都覆盖。）
3. 补两条回归用例：`session.userId === userId`（原有用例）与 `session.lastRuntimeUserId === userId`（新增，断言按发言者取到 token）；再保留一条「两者都不等 → `{}`」的越权用例。

> 说明：方案文档 §3.3 的故障表把「`session.userId !== userId`」一律定义为故障 fail-closed，实现忠实于方案；但方案未考虑「运行身份（2026-11-04 §5.2）」这一既有机制，因此这是方案 + 实现的共同盲点，仍应视为本次改造引入的功能回归。

### 建议（不影响功能，仅供参考，未计入问题数）

无。按本次审查口径（只提可复现的功能 bug），未发现其它需要提的问题。

## 3. 已检查但未发现问题的范围

逐项核对了下列关注点，均未发现可复现的功能 bug（列出以免后续重复排查）：

1. **三态语义全链路**（NULL / `'[]'` / 数组）
   - `V187` 迁移列 `NULL` 默认、种子行 `('gitToken.scopePolicy','lenient','Agent 与模型',…,1,0)` 与既有迁移范式一致，`flyway.spec.ts` 实际跑通；
   - `agent.repository.insert/updateById` 的 `?? null` 只折叠 `undefined`，`'[]'` 原样保留；
   - `AgentService.createAgent`（`!= null`）与 `updateAgent`（`!== undefined`，`null → NULL`）四态正确；
   - `agent.routes.normalizeGitDomains` 四态 + 逐项规范化/去重 + 条数/单长/JSON 总长（≤1024，最后判定）均正确，非法输入不会触达 service；
   - `toVO` 对 `null` / `[]` / 数组的原样透出正确；admin `gitDomains.ts` 的 `enabledOf/listOf/payload` 与后端语义一一对应（`[]` → 开关开 + 空列表，`null` → 开关关）。
2. **解析器 fail-closed 与策略组合**：session 查不到 / owner 不匹配 / agent id 不存在 / DB 异常 → `{}`；`agentId == null` 与 `sessionId == null` 走策略（宽松全量 / 严格空）；`'[]'` 在两种策略下都为 `{}`；`selectGitAllowedDomainsById` 不带 `notDeleted()`（软删 Agent 按原配置解析）。除 §2.1 的「运行身份」场景外均符合方案。
3. **六条注入通道无漏点**：全仓库 `getTokenMapByUser` 的消费方只剩解析器自身（`fullTokenMap`）；`GitCredentialLookup` 已全部替换；shell 工具两处（exec / write_stdin 刷新）、终端、envelope、容器适配器、clone、Git 面板写操作均改走解析器；宿主 MCP env 白名单不含 `GIT_TOKEN_*`（无新增注入面）。
4. **装配顺序 / 依赖注入**：`create-app.ts` 中 resolver 建在 `agentRepo`(385) / `settingService`(436) / `sessionRepo`(468) 之后；`assembleContainerRuntime`、`assembleHarnessEngine`、`createDefaultToolRegistry`、`TerminalManager`、`GitOperationService`、`GitWriteOperationService` 均收到实例（`tsc --noEmit` 通过，无 `undefined` 路径）；`container-tool-executor` 的 envelope 适配器沿用 `this.currentEnvelope` 闭包，语义与改造前一致。
5. **API 权限**：`GET /v1/agents`、`GET /v1/agents/:id` 的 `gitAllowedDomains` 与 `missingGitDomains` 仅对 `agent:read` / `agent:write` 生效（`toVO(..., { includeGitDomains: canManage })`、`missingGitDomains && canManage`）；创建/更新/rollback/enabled 均要求 `agent:write`，默认透出该字段不构成越权。
6. **admin 列表筛选**：参数名两端一致（`missingGitDomains`），`queryOptBool` 兼容 `true/1`，`handleGitDomainFilter` 会重置页码并重拉，「未配置 / 已禁止 / N 个域」三态文案与后端 `null / [] / 数组` 对应。
7. **策略开关**：`getGitScopePolicy`（缺行 / 空串 / 非法值 → lenient，`STRICT` 大小写与空白归一）、`SystemSettingsView` 的 `isGitScopePolicySetting` 分支（`gitToken.scopePolicy` 不会被 `isBooleanSetting` 抢先命中）、种子行 category `Agent 与模型` 确在 `TOC_GROUPS`（模型任务组）内，设置搜索由 `buildSettingsLocatorFields(rows)` 按 description 动态构建，不依赖 `settingsSearchCatalog` 也能搜到。

## 4. 测试与构建记录

- `npx tsc -p tsconfig.build.json --noEmit`：通过
- `cd admin && npx vue-tsc -b --force`：通过
- `npx vitest run src/agent src/user/git-token-resolver.spec.ts src/common/git-domain.spec.ts src/settings/settings.service.spec.ts src/harness/container src/db`：全部通过
- `npx vitest run src/harness src/session src/file src/user src/agent src/settings src/common`：`3105 passed / 1 failed`；唯一失败为 `src/harness/terminal/terminal-manager.spec.ts:196`（断言 `MAO_BASE_URL` 为空，但本机 `process.env.MAO_BASE_URL=https://mao.acg.team` 被 `sanitizeInheritedEnv(process.env)` 继承）。该用例与本 diff 无关（该文件仅改了 `gitCredentials` → `gitTokenResolver` 的 mock 名，`buildEnv` 的 baseUrl 段未改动），属环境下依赖，非本次回归。
- `cd admin && npx vitest run src/views/agent`：通过（5 tests）
- 复现探针：`backend-ts/src/__review_tmp__/runtime-identity.tmp.spec.ts`，2 用例通过后已删除，未改动任何仓库内源码 / 既有测试。

## 5. 第二轮复查（2026-11-06）

**结论：§2.1（P1）已修复并验证关闭；本轮未发现新的 P1 / 阻塞项，仍为「0 阻塞 / 0 重要」。** 仅余 2 条「遗留风险（不阻塞、未计入 bug）」与 1 条文档措辞残留，见文末。

### 5.1 修复内容核对

`backend-ts/src/user/git-token-resolver.ts:38-63`

- `sessionLookup.selectById` 返回类型补 `lastRuntimeUserId?: number | null`，与 `Session` / `domain/types.ts:12` 及 V183 列 `last_runtime_user_id` 一致；
- 资格校验改为 `ownerMatch = session.userId === userId`、`runtimeMatch = session.lastRuntimeUserId != null && session.lastRuntimeUserId === userId`，两者都不命中才 `{}`（仍 fail-closed），`warn` 日志补 `runtime=` 字段（实测 `owner=1 runtime=null` / `owner=1 runtime=2` 均正确输出）；
- 放行后仍用**调用方 userId**（= 运行身份）解析 `resolveForAgent(userId, session.agentId)`，即取「发言者自己的 token ∩ Agent 允许域」，与改造前 `getTokenMapByUser(userId)` 的取值口径一致。

### 5.2 「运行身份早于工具执行落库」核查（修复成立的前提）

`harness.execute()`（`harness-service.ts:153-163`）→ `buildContext(..., executionUserId)` → `runtimeUserFor()`（`:113-117`，默认 `runtimeIdentityMode='execution'`，`config/app-config.ts:273`）→ **`await persistRuntimeUser()`（`:360-361`）** → `sessionRepo.updateFields(sessionId, { lastRuntimeUserId })` → **之后**才 `agentLoop.execute()` 派发工具。`HarnessService` 持有的 `sessionSvc` 是真实 `SessionService`（`create-app.ts:550`、`app-harness-engine.ts:317`），`touchRuntimeUser`（`session.service.ts:1555-1558`）确实会写库。故工具执行时 `last_runtime_user_id` 已是本次运行身份。

各场景逐一核对（执行身份来源）：

| 场景 | 执行身份来源 | 结论 |
|---|---|---|
| 私聊（飞书 p2p / 桌面 WS） | `executionUserId = 发言人 = owner`；WS 走 `executeFromEvent → execute()` 不传，回落 `session.userId` | owner 命中，放行 |
| 群聊（飞书 / 钉钉） | `executionUserId = 当前发言人`（`app-feishu-handler.ts:141-147`、`dingtalk/runtime.ts:230-235`），会话按群复用、owner=首个发言人 | 本轮修复后 `runtimeMatch` 命中，按发言人取 token |
| 子代理（SUBAGENT） | 子会话 `lastRuntimeUserId` 继承父会话（`subagent-invocation.service.ts:26-48,101-108`）；`background-subagent-manager.ts:1034-1040` 用 `child.lastRuntimeUserId ?? parent…` 传入 buildContext 并落库 | 子会话 `runtimeMatch` 命中 |
| 边路任务（SIDE_TASK） | `executeSideFirstMessage → buildContext()` 不传 executionUserId，回落 `sideSession.userId`（= 创建者）并落库 | owner 命中 |
| 失败重试 | 重试前读 `lastRuntimeUserId` 作为 executionUserId → 再落同一值 | 命中 |
| 崩溃恢复 | `harness.execute(sessionId, …, session.lastRuntimeUserId ?? null)`（`crash-recovery-runner.ts:410-413`） | 命中；存量 `NULL` 行回落 owner，owner 命中 |
| 存量行（V183 未回填） | 无回填，但每轮 buildContext 先落库，故群聊首条发言即写入当前发言人 | 不依赖回填 |

### 5.3 探针实测（第二轮）

用真实 `DefaultGitTokenResolver` + 真实 `ShellSessionTool`（`src/__review_tmp2__/runtime-identity-fix.tmp.spec.ts`，5 用例全通过，验证后已删除）：

| 用例 | 结果 |
|---|---|
| owner 相符（白名单 `["other.com"]`） | `{ 'other.com': 'tok-of-1' }` |
| 群聊发言人：`owner=1, lastRuntimeUserId=2`，入参 `uid=2` | `{ 'other.com': 'tok-of-2' }`（发言者自己的 token，非 owner 的） |
| 伪造 `uid=3`（owner/运行身份都不匹配） | `{}` + `warn`（仍 fail-closed） |
| 存量行 `last_runtime_user_id=NULL` 且非 owner | `{}`（跨用户误传不放行） |
| 端到端：`ShellSessionTool.execute(cmd, sessionId, SPEAKER, /tmp)` | `getOrCreate` 收到的 `tokenMap = { 'other.com': 'tok-of-2' }`（修复前为 `{}`） |

对照改造前口径：`resolveForAgent(SPEAKER, ...)` 结果与修复后 `resolveForSession(SPEAKER, ...)` 一致 —— 说明能力恢复且未放大可见域（仍受 Agent 允许域约束）。

### 5.4 是否引入新问题 / 其它通道同类假设复核

- **解析器单元测试**：`npx vitest run src/user/git-token-resolver.spec.ts` → **18 passed**（新增「群聊非首发发言人」「双不匹配」用例，原「跨用户误传」用例已显式写 `lastRuntimeUserId: null`）；
- **类型检查**：`npx tsc -p tsconfig.build.json --noEmit` → 通过；
- **相关域全量**：`src/harness src/session src/file src/user src/agent src/settings src/common src/db` → `3121 passed / 1 failed`，唯一失败仍是既有的环境依赖用例 `terminal-manager.spec.ts:196`（本机 `process.env.MAO_BASE_URL` 被继承），与本次修复无关；
- **终端通道（#2）**：`POST /v1/sessions/:id/terminals` 强制 `session.userId === userId`（`terminal.routes.ts:28-38`），容器 PTY 的 env 也由宿主机按该 userId 计算（`app-utils.ts:144-167`、`pty-bridge.ts:114`），无运行身份假设 —— owner 命中，行为不变；
- **容器 envelope / 容器 MCP（#3/#4）**：`docker-tool-router.ts:84-86,113-115,138` 均以 `userId = runtimeUserId` + `sessionId` 建 envelope，修复后 `runtimeMatch` 生效，与 shell 通道一致收敛；
- **建会话 clone（#5）**：`session.service.ts:267` 传 `session.id` 与创建者 userId（= owner），owner 命中；
- **Git 面板写操作（#6）**：`resolveForAgent(session.userId, …)` + 路由 `requireOwnedSession`（`file.routes.ts:279-311,404-424`）双端都以 owner 为准，二者同源，**不存在**同类「运行身份 vs 归属」错配（非 owner 无法访问该面板；agent 自身也无法以运行身份调用这些路由）。

### 5.5 遗留风险（不阻塞，未计入 bug；仅记录）

1. **并发交叉执行同一会话时的窄窗口**：`last_runtime_user_id` 是单值列，若同一会话被两个身份几乎同时执行（例如 owner 在桌面端、群成员在飞书端同时发言），后落库的 run 会覆盖前一 run 的运行身份；前一 run 后续的 shell 工具调用将 fail-closed（空凭据，方向安全）。平台对同会话执行有排队/占用（feishu 队列 + WS execution claim）基本规避，未能在无完整 harness/DB 环境下复现，故不列为 bug。
2. **`persistRuntimeUser` 失败仅告警不阻断**（`harness-service.ts:120-129`）：极端情况下本次运行身份未落库，群聊非 owner 发言的 shell 会 fail-closed（空凭据），方向安全。
3. **文档措辞残留（非代码）**：方案 §3.3 修订块下方仍保留原句「owner 不匹配应额外打 `warn`（疑似越权访问），不放行。」，与本节修订后的「owner 或最近运行身份命中即放行」口径已不一致，建议下次一并删改（本轮未动其它文件）。

### 5.6 本轮变更范围

仅更新本报告末尾本章节；未修改任何源码 / 既有测试；临时探针 `src/__review_tmp2__/` 已删除（`git status` 中无残留）。
