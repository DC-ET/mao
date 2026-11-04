# 群聊会话运行身份对齐技术方案（定稿 V1.1）

> 日期：2026-11-04　状态：**定稿（V1.1）/ 未实施**
> 目标读者：Mao 后端与容器运行时维护者
> 关联材料：调研 `docs/research/2026-11-04-group-chat-runtime-identity-gap.md`；初稿已被本文件取代（修订对照见附录 B）
> 实施一句话：**一次发布（后端 + 一个可空字段迁移）修正「技能/工具路径与执行容器不一致」；容量优化作为独立第二阶段；隔离边界一行不动。**
> 修订历史：2026-11-04 初稿 → 2026-11-04 定稿 → 2026-11-04 评审补充 V1.1。定稿吸收 13 项自查/评审修订（对照表见附录 B）；V1.1 吸收代码评审发现的 4 项 P1（execute 入口穷尽性含飞书重试、`send_wechat_*` 工具清单、URL 建议可执行性、部署 SOP 命令）+ 6 项 P2（对照见附录 C），**不改变 D1–D10 任何决策**。
> 确认记录：2026-11-04 杨佳毅确认 —— ①「技能集合随发言者变化」可接受；②D4「产物归运行身份」及其跨成员限制面（§7.1）可接受。本轮仅落文档，**不实施**。

---

## 1. 背景与问题（摘要）

飞书群 / 飞书话题 / 钉钉群会话中，**非会话归属成员**发言的那一轮：提示词里的技能路径按「会话归属用户」拼装，工具执行却在「发言者」的容器里，两侧路径空间不同，导致技能文档读取被沙箱拒绝（`Path escape attempt`）、技能 CLI 缺失、任务不可执行。

根因一句话：**同一会话存在两套身份（归属 / 运行），执行侧已按运行身份收窄，资源侧没有跟上。**

规模：全站 21 个群会存在「非归属成员执行」历史（近 7 天 5 个，最大一个 10 个执行用户）；90 个用户中 89 个跟随全局 docker。详细取证见调研文档。

与初稿思路的对应：**V1 = 思路 1（运行身份对齐）+ 思路 3（可解释性）；V2 = 思路 2（共享/去重）的替代实现**；初稿的「agent 级共享视图挂载」经评估废弃（理由见 §6.3）。

## 2. 目标与非目标

### 2.1 目标（验收口径）

| 编号 | 目标 | 验收 |
|---|---|---|
| G1 | 群聊中任一成员发言，技能文档与技能 CLI 可用 | 发言者容器内 `read_file` 技能 `SKILL.md` 成功；CLI 可按技能文档自装到 `deps/{发言者}` 并执行 |
| G2 | 身份语义唯一且可解释 | 执行期资源一律取「运行身份」；提示词在身份不一致时显式声明；越界错误文案可被模型正确理解 |
| G3 | 隔离边界不扩大 | 不挂载他人目录、不放开沙箱允许根；个人技能/凭据/依赖仍严格按人 |
| G4 | 回归零影响 | host 用户、私聊、web 会话、定时任务、LOCAL、子代理恢复行为可预期（见 §5.8） |
| G5 | 可运营 | 一个开关可整体回退到「按会话归属执行」；回退无需改代码 |
| G6 | 容量可控 | 技能视图数据不随群成员数线性增长（第二阶段，见 §6） |

### 2.2 非目标（明确不做，避免范围蔓延）

1. **不做「用某成员账号代操作」**：本次事故里「用王昭文账号改 Apollo」的诉求属于**凭据委派**产品能力，需独立立项（显式授权、可审计、有时效）。本方案只保证「在谁的环境执行、说得清楚」。
2. 不做「群聊共享归属者技能/凭据」；
3. 不做「每会话一个容器」；
4. 不改容器挂载清单、镜像、沙箱允许根（V1 零容器侧变更）；
5. 不改 MCP 身份（见 §7 已知差异）。

## 3. 关键决策（终态）

| 决策 | 内容 | 理由 |
|---|---|---|
| **D1** | 定义运行身份 `runtimeUserId = executionUserId ?? session.userId`，并由 `MAO_RUNTIME_IDENTITY` 开关决定是否启用「执行侧优先」（默认启用）。落为 `AgentExecutionContext.runtimeUserId` | 单一事实源；可回退 |
| **D2** | 运行身份**持久化**到 `session.last_runtime_user_id`（每次 `execute` 更新） | 记忆抽取、崩溃恢复、子代理继承需要同一事实源，避免三套临时机制 |
| **D3** | 技能同步、技能清单、提示词路径、上传目录提示、`dump_user_messages`、`open_web_page` 缓存、生成产物、发送工具统一取运行身份 | 凡「宿主侧写/拼、容器侧读」的路径必须同身份 |
| **D4** | 生成产物（`generate_image` / `edit_image`）归属运行身份 | 与「谁执行、谁可见、谁计费」一致；发送工具才能读到 |
| **D5** | 记忆注入与**抽取**必须同源（运行身份） | 只改注入会造成「B 的记忆写进 A」，比不改更糟 |
| **D6** | 压缩归档**不拆分**：写入与目录保持会话归属身份；非归属身份执行时**不注入归档回读提示** | 会话级数据不做身份级碎片化；避免误导模型读不到 |
| **D7** | 技能同步失败（视图物化失败）→ 本轮从可用技能清单剔除并告警 | 不允许「清单有技能、路径不存在」的组合把错误暴露给模型 |
| **D8** | 提示词身份段仅在 `runtimeUserId != session.userId` 时渲染；PathSandbox 对「他人运行目录」给出专属诊断文案 | 提升可解释性；普通会话前缀零变化 |
| **D9** | 子代理 / 崩溃恢复继承「本次执行身份」；**定时任务、手动压缩、侧任务保持会话归属** | 恢复的是同一次执行；定时任务没有「发言者」语义 |
| **D10** | 第二阶段容量优化采用 **内容寻址 + 硬链接**，**废弃** agent 级共享视图挂载方案 | 不动挂载/沙箱/registry，收益等价，风险低一个量级（对比见 §6.3） |

## 4. 身份模型与生效范围

```
sessionOwnerUserId = session.userId                 // 归属：列表、权限、审计、流式订阅、通知
runtimeUserId      = 开关启用 ? (executionUserId ?? session.userId) : session.userId
                   // 执行：容器、文件、技能、CLI、依赖、凭据缓存、记忆
executionUserId    = 触发人（不变）                  // 审批规则、LLM 计费/预算（维持现状）
```

| 资源 | 身份 | 阶段 |
|---|---|---|
| 技能同步 / 视图 / 会话技能软链 | runtimeUser | V1 |
| 提示词技能路径 / 上传目录提示 / 用户命令 | runtimeUser | V1 |
| docker-only 工具（shell / 文件 / 终端 / MCP 之外） | runtimeUser（现路由即 executionUserId，开关关闭时回落 owner） | V1 |
| `dump_user_messages` / `open_web_page` 缓存 / 生成产物 / 发送工具 | runtimeUser | V1 |
| 记忆注入 + 抽取 | runtimeUser | V1 |
| 压缩归档写入/目录 | **owner（不变）**；非 owner 运行时不注入回读提示 | V1 |
| 子代理 / 崩溃恢复 | 继承 last_runtime_user_id | V1 |
| 定时任务 / 手动压缩 / 侧任务 | owner（不变） | — |
| MCP server 列表与容器寻址 | **owner（不变）**，列为已知差异 | 后续单独评审 |
| 审批规则 / LLM 计费 / 预算 | executionUserId（不变） | — |

---

## 5. V1 实施范围（精确改动清单）

### 5.0 实施顺序（按此顺序落码，每步可编译、可测）

1. 迁移 + `Session.lastRuntimeUserId` + 类型三处（编译通过，空跑迁移）；
2. 开关配置 + `buildContext` 身份解析 + `touchRuntimeUser`（失败仅告警不阻断）+ **execute 入口全量审计**（按 §5.2 终态表逐入口定 `executionUserId`；此时行为尚未改变，仅落字段）；
3. 技能同步目标/清单/提示词路径（**修复生效点**）+ 同步失败剔除；
4. 工具身份表、记忆同源、归档提示抑制、子代理/恢复继承；
5. 可解释性（提示词身份段 + PathSandbox 诊断）；
6. 单测补齐 → 手工冒烟 → 发布。

### 5.1 数据模型

新增迁移 `backend-ts/db/migration/V183__session_last_runtime_user.sql`：

```sql
ALTER TABLE `session`
  ADD COLUMN `last_runtime_user_id` BIGINT NULL COMMENT '最近一次执行的运行身份（= executionUserId ?? user_id）；用于记忆抽取、崩溃恢复与子代理继承' AFTER `memory_injection_disabled`;
```

- `Session` 类型加 `lastRuntimeUserId?: number | null`（`domain/types.ts`、`session/types.ts`、`harness/deps.ts` 三处，与 `memoryInjectionDisabled` 同模式）；
- 行映射走 `SELECT *` 自动 camelCase（与 `memoryInjectionDisabled` 同机制），无需改 `insert/updateById` 字段表；
- 不做数据回填：首轮执行即写入；缺失时一律回落 `session.userId`。

### 5.2 运行身份解析与持久化

| 位置 | 变更 |
|---|---|
| `app-config.ts` | 新增 `app.harness.runtimeIdentityMode`：读 `MAO_RUNTIME_IDENTITY`，取值 `execution`（默认）/`owner`，非法值回落默认；写入 `.env.example` 注释与 `skills/mao-cli/reference/config.md`（环境变量权威表，AGENTS.md 要求 mao-cli 同步；`DEPLOY.md` 现为索引表，顺带提及） |
| `SessionService` | 新增 `touchRuntimeUser(sessionId, userId)`（内部 `sessionRepo.updateFields(id, { lastRuntimeUserId })`） |
| `HarnessService.execute` | 把 `executionUserId` 透传给 `buildContext`（新增第 5 个可选参数） |
| `HarnessService.buildContext` | 加载 session 后立即计算：`runtimeUserId = mode==='owner' ? session.userId : (executionUserId ?? session.userId)`；写入 `context.runtimeUserId`；随后 `touchRuntimeUser(sessionId, runtimeUserId)`（先落身份再同步技能/构建，崩溃恢复窗口最小）；**`touchRuntimeUser` 失败（DB 异常）仅告警不阻断本轮**——身份以 `context.runtimeUserId` 内存值为准，落库失败不影响执行；保持 `context.executionUserId` 语义不变 |
| `AgentExecutionContext` | 新增 `runtimeUserId?: number \| null` |

说明：`touchRuntimeUser` 放在 `buildContext`（全执行链路唯一咽喉），而不是 `execute`——`buildContext` 同时覆盖恢复、手动压缩、侧任务、子代理等路径，语义统一为「最近一次执行的运行身份」。自动压缩不经过 `buildContext` 二次调用（request_start 在 buildContext 内联、mid_loop 复用执行中 context），天然继承运行身份，不存在「压缩把身份打回 owner」问题。已知副作用：`requestCompaction`/`executeSideFirstMessage` 也经此咽喉，会把 `last_runtime_user_id` 覆写成 owner——侧任务写自己的会话行无碍；「B 发言后 owner 手动压缩」会改崩溃恢复身份，可接受（§10 风险 12）。

调用点约定（终态，即 §5.0 第 2 步「execute 入口全量审计」的结果——D1 的正确性依赖此表穷尽，新增执行入口必须显式决策）：

| 调用点 | executionUserId | 说明 |
|---|---|---|
| 飞书入站 `execute`（主路径） | 传触发人 | `feishu/agent-inbound-handler.ts:701-706`，主路径 |
| 飞书失败卡「重试」`execute` | 传 `session.lastRuntimeUserId ?? null` | `agent-inbound-handler.ts:313-317`（`retryExecution`/`runRetry`）。重试基于会话历史续跑、stubContext `senderId: null` 拿不到原发言者，与崩溃恢复同源取持久化身份——失败轮的 `touchRuntimeUser` 已在 buildContext 落过发言者；若期间 owner 触发过手动压缩会覆写，可接受（§10 风险 12） |
| 钉钉入站 `execute`（主路径） | 传触发人 | `dingtalk/agent-inbound-handler.ts:293-297` |
| 钉钉第二入口 `execute` | 实施时审计定：传触发人或显式回落 owner | `dingtalk/agent-inbound-handler.ts:340`（§10 风险 16） |
| 微信入站 `execute` | 不传（owner） | `weixin/agent-inbound-handler.ts:208`。仓内无群会话分支（无 chat_type/group 处理），1:1 下 owner==发言者恒成立；若后续微信支持群需同步改造 |
| WS / 定时任务 / OpenAPI（`executeFromEvent`） | 不传（owner） | `harness-service.ts:111-115`；调用方 `streaming-ws-handler.ts`、`scheduled-task.service.ts`、`open-run.service.ts`。无「发言者」语义，回落 owner 正确 |
| `crash-recovery-runner` | 传 `session.lastRuntimeUserId ?? null` | 恢复同一次执行（§5.8） |
| `background-subagent-manager.buildSubContext` | 传 `child.lastRuntimeUserId ?? null` | 子代理继承（§5.8） |
| `requestCompaction`（手动压缩） | 不传 | owner |
| `executeSideFirstMessage`（侧任务） | 不传 | owner（写自己的侧会话行） |

### 5.3 技能同步与失败语义

`SkillSyncService`：

1. 参数语义改为「运行身份」（`syncToSession(agent, runtimeUserId, sessionId)`，`getUserSkillNames/getUserSkillDocuments/getRemovedSkillNames` 同步改名），类型不变；
2. `syncState` 键改为 `${agentId}:${userId}:${sessionId}`（`getSyncState` 与 `getRemovedSkillNames` 同源），消除群聊内不同发言者互相清链；
3. **返回值**：`Promise<{ failed: string[] }>`（视图物化失败或链接失败且已摘链的技能名集合）；单技能失败仍只影响该技能，不中断其余；
4. 目录布局不变（V1）：`{runtimeRoot}/{runtimeUserId}/{sessionId}/skills/{name} → skill-views/{runtimeUserId}/{name}`（系统）/ `userskills/{runtimeUserId}/{name}`（个人）。

`HarnessService.buildContext`：

5. 调 `syncToSession(agent, runtimeUserId, sessionId)` 后，把 `failed` 中的技能名从 `availableSkillNames` 剔除（同时不影响 `availableSkillDocs` 的全局文档表）；
6. `availableSkillNames/Docs` 的用户技能来源改为 `getUserSkillNames/Documents(runtimeUserId)`；
7. 日志统一带 `session=`, `owner=`, `runtimeUser=` 三个字段。

### 5.4 提示词（`prompt-engine.ts`）

统一 helper：`const runtimeUserId = context.runtimeUserId ?? context.userId`。

| 位置 | 变更 |
|---|---|
| `buildSkillCatalog` | 云端技能路径取 `runtimeUserId`；LOCAL 分支不变 |
| `hasUserSkill` / 用户命令查表 | 取 `runtimeUserId` |
| `incomingFileHint` | 上传目录取 `runtimeUserId`（附已知限制：其他成员历史消息里的 `@{...}@` 引用指向其本人 runtime，跨成员不可读，见 §10） |
| 新增身份段（仅 `runtimeUserId != session.userId` 渲染） | 见 §5.9 |

### 5.5 工具派发（`tool-invocation.ts` / `agent-loop.ts` / `tool-dispatcher.ts`）

1. `ToolInvocation` 新增 `runtimeUserId: number | null`，由 `agent-loop.dispatchTool` 从 `context.runtimeUserId` 填充；`dispatchInvocation → dispatchFullOutcome` 增加同名形参（默认 `null`，兼容旧调用）；
2. `dispatchFullOutcome` 顶部统一取值：

```ts
// runtimeIdentity 来自 ToolInvocation.runtimeUserId
const runtimeUserId = runtimeIdentity ?? executionUserId ?? userId;
const runtimeToolUserId = RUNTIME_SCOPED_TOOLS.has(toolName) ? runtimeUserId : userId;
```

3. `RUNTIME_SCOPED_TOOLS = { dump_user_messages, open_web_page, generate_image, edit_image, feishu_send_image, feishu_send_file, dingtalk_send_image, dingtalk_send_file, send_wechat_image, send_wechat_file }`（微信两个发送工具经评审补入：它们在 SERVER_ONLY 分支，漏列会导致 B 连自己 `uploads/{B}` 的产物都发不出，比 §7.1 描述的「跨成员受限」更糟）；
4. docker-only 分支路由改用 `runtimeUserId`（原为 `executionUserId ?? userId`）；SERVER_ONLY 分支 `callTool(..., runtimeToolUserId, ...)`；宿主回退分支 `toolUserId = (toolName === 'shell' || RUNTIME_SCOPED_TOOLS.has(toolName)) ? runtimeUserId : userId`。注意两类发送工具落在不同分支、须分别回归：`send_wechat_*` 在 SERVER_ONLY（改 `runtimeToolUserId`），feishu/dingtalk send 在宿主回退（改 `toolUserId`）；工具构造与注册处（`tool-registry.ts`）无需改，`callTool → BaseTool.execute` 透传链已确认；
5. 保持 owner 的工具不变：`task_*`、定时任务系列、`ask_user_questions`、`web_search`、`http_*`。

### 5.6 记忆（`harness-service.loadMemories` / `task-terminal.service`）

1. `loadMemories(session, runtimeUserId)`：用 `runtimeUserId` 调 `listForInjection`（定时任务时 `runtimeUserId==owner`，语义正确）；
2. `task-terminal.dispatchMemoryExtraction`：`userId: session.lastRuntimeUserId ?? session.userId`；
3. `memoryInjectionDisabled` 开关不变。

### 5.7 压缩归档（`session-compaction-orchestrator` / `session-history-loader`）

1. `writeArchive(..., context.userId, ...)` **保持不变**（归档目录仍归会话归属身份）；
2. `buildArchiveHint` 增加入参 `runtimeUserId`：`runtimeUserId !== ownerUserId` 时返回 `null`（不注入提示），其余不变；
3. 效果：A 的轮次照旧可用归档回读；B 的轮次不出现「指向 A 目录」的误导提示。跨身份回读能力**明确不承诺**（D6）。

### 5.8 子代理 / 崩溃恢复 / 侧任务

| 对象 | 变更 |
|---|---|
| 子代理创建（`subagent-invocation.service.create`） | `child.lastRuntimeUserId = parent.lastRuntimeUserId ?? parent.userId`（spawn 与 followup 都以父会话当前值刷新） |
| 子代理执行（`background-subagent-manager.buildSubContext`） | `buildContext(child.id, undefined, undefined, undefined, child.lastRuntimeUserId ?? null)`；子代理技能仍清空（现状） |
| 崩溃恢复（`crash-recovery-runner.runRecovery`） | `execute(..., current.lastRuntimeUserId ?? null)` |
| 侧任务 | 保持 owner（非目标） |

### 5.9 可解释性

1. **提示词身份段**（`prompt-engine`，仅不一致时输出）：

```
## 执行身份

- 当前执行身份：用户 #67 秦翌翔（本条消息的发送者；有显示名时展示）。shell、文件、技能、CLI 与凭据都属于该身份。
- 会话归属：用户 #17（本群会话的创建者）。其个人技能、token 缓存与 CLI 依赖不在当前执行环境内，不要假设可用，也不要尝试读取其运行目录。
- 若任务必须使用某位成员自己的账号/凭据，请让该成员本人 @ 机器人触发，或明确告知用户需要其本人操作。
```

2. **PathSandbox 身份诊断**（容器侧）：`PathSandboxOptions` 新增 `identity?: { runtimeRoot; userId }`，`ContainerToolExecutor` 构造时传入；`resolve()` 抛错前判定——路径在 `runtimeRoot` 下且首段非本人 userId 时，抛
   `该路径属于其他用户的会话运行目录（当前执行身份 {uid}），不可访问: <path>`，其余越界保持原文案。覆盖 `read_file/write_file/edit_file/glob_search/grep_search/handleReadBytes`。
   生效路径（评审补充）：容器内代码经 dist ro 挂载与宿主机同源，新文案靠 runtimeBuild 漂移检测→下次空闲自动重启进程加载；容器 busy 会延后、`autoUpgrade`（V178）被关时不自动生效。§8.2 须主动构造跨成员读并断言新文案出现，否则无法区分「已修复」与「代码未加载」。

3. **产物读字节的跨成员诊断**（`send-file-bytes.ts`，host 用户与 docker 降级路径生效；docker 用户本地路径先走容器 `read_bytes` 帧，由第 2 条容器侧文案覆盖）：`loadSendFileBytes` 走 `StrictPathResolver` 拒绝前，若路径落在 `{file.uploadDir}/{其他 uid}` 或 `{runtimeDir}/{其他 uid}` 下，按类别抛出**可执行**的文案——
   - `uploads/{其他 uid}` 下：`该文件属于其他成员的产物目录（当前执行身份 {uid}），本地路径不可读；该文件有公开 URL，请改用其转发: {publicUrl}`。`publicUrl` 由宿主持 `upload.baseUrl` 推导的 origin + `/uploads/{uid}/{file}` 现成拼出（`/uploads/` GET 为公开静态路由，jwt 白名单 + UUID 文件名）——**不要求模型自行换算**：系统提示词与 send-* 工具描述中均无 uploads 公开 base URL（评审实证），模型拿到本地路径无法推知 URL；
   - `runtime/{其他 uid}` 下（shellOutput / userMessages / webPages）：无公开路由，抛 `该文件属于其他成员的会话运行目录（当前执行身份 {uid}），本地路径不可读且无公开 URL；请先复制到本人 uploads 目录或群共享工作区再转发，或让该成员本人操作: <path>`；
   - `edit_image` 沿用同一文案并追加「改图请重新生成，或由该成员本人操作」（它不接受 URL，见 §7.1）。
   另在系统提示词（或 send-* 工具参数描述）补一条 uploads 本地路径 ↔ 公开 URL 的映射规则，让模型在跨成员场景能主动构造 URL，而不是只依赖报错文案（§10 风险 11）。

### 5.10 运营开关

- `MAO_RUNTIME_IDENTITY=execution|owner`（默认 `execution`），重启生效（蓝绿 ~30s）；
- `owner` 语义 = 全部执行期资源按会话归属（群聊里即「以建会话者身份执行」），用于紧急回退；审批/计费仍按触发人；
- 开关为**唯一分叉点**（仅影响 §5.2 的 runtimeUserId 计算），其余代码单一路径；
- 稳定运行一个版本后，评估是否移除开关（保留需在 DEPLOY.md 维护）。

### 5.11 改动文件清单

| # | 文件 | 变更 |
|---|---|---|
| 1 | `backend-ts/db/migration/V183__session_last_runtime_user.sql` | 新增可空列 |
| 2 | `src/domain/types.ts`、`src/session/types.ts`、`src/harness/deps.ts` | `lastRuntimeUserId` 字段 |
| 3 | `src/session/session.service.ts` | `touchRuntimeUser` |
| 4 | `src/config/app-config.ts`、`.env.example`、`skills/mao-cli/reference/config.md`、`DEPLOY.md` | 身份开关（config.md 为环境变量权威表；DEPLOY.md 为索引，顺带提及） |
| 5 | `src/harness/core/harness-service.ts` | 身份解析/持久化、同步目标、清单剔除、记忆 |
| 6 | `src/harness/core/agent-execution-context.ts` | `runtimeUserId` |
| 7 | `src/harness/skill/skill-sync-service.ts` | 语义/state key/返回值 |
| 8 | `src/harness/core/prompt-engine.ts` | 路径/命令/身份段 |
| 9 | `src/harness/tool/tool-invocation.ts`、`src/harness/core/agent-loop.ts`、`src/harness/tool/tool-dispatcher.ts` | runtimeUserId 穿透、工具身份表、docker 路由 |
| 10 | `src/harness/core/session-compaction-orchestrator.ts`、`session-history-loader.ts` | 归档提示抑制 |
| 11 | `src/session/task-terminal.service.ts` | 记忆抽取身份 |
| 12 | `src/harness/delegate/subagent-invocation.service.ts`、`background-subagent-manager.ts` | 子代理身份继承 |
| 13 | `src/harness/core/crash-recovery-runner.ts` | 恢复身份 |
| 14 | `src/harness/safety/path-sandbox.ts`、`src/harness/container/container-tool-executor.ts`、`src/harness/tool/impl/send-file-bytes.ts`、`src/harness/tool/impl/edit-image-tool.ts` | 身份诊断（§5.9 第 2、3 条） |
| 15 | 测试与文档 | 见 §8、CHANGELOG |
| 16 | `src/session/ws/streaming-ws-handler.ts` | 第二处 `syncToSession`（:793，web 路径 userId=WS 认证用户=owner，语义不变）；随 SkillSyncService 签名/state 键改造一并 review，不改行为。另确认 `tool-registry.ts` 无需改（透传链已验） |

---

## 6. 第二阶段（V2）：技能视图容量优化（内容寻址 + 硬链接）

> 独立发布、独立回滚；不改变 §5 的任何行为。

### 6.1 问题

V1 后每个新发言者首次执行会物化一份技能视图（现网均值约 10MB/用户；53 个用户 333MB）。大群多发言者会线性增长。

### 6.2 方案

```
{skillViewsDir}/.content/{fingerprint}/{skillName}/     ← 不可变内容仓（复制一次，按指纹分目录）
{skillViewsDir}/{userId}/{skillName}/                   ← 用户视图（硬链接到内容仓；路径不变）
```

- 指纹沿用现有 `computeSkillTreeFingerprint`；内容仓缺失时从源全量复制一次（暂存 + 原子 rename）；
- 用户视图按原有「暂存 + 原子 rename」换入，文件改为硬链接（同文件系统；失败回落拷贝）；
- 内容仓写入后不再修改（新指纹 = 新目录）；容器内视图仍为 ro 挂载，宿主机不写视图内容；
- GC：低频任务清理「无引用且超过 N 天」的内容仓目录；已存在的视图硬链接继续持有数据，不受目录项删除影响；
- 收益：系统技能磁盘占用从「用户数 × 体积」降为「当前指纹 × 体积 + 链接元数据」；物化耗时下降。

### 6.3 为什么废弃「agent 级共享视图挂载」

| 维度 | agent 级挂载（初稿） | 内容寻址 + 硬链接（定稿） |
|---|---|---|
| 挂载清单 / registry / runtime-agent env / 沙箱允许根 | 全部要改 | **零改动** |
| 容器重建 | 新增「agent 集合变化」触发一类重建 | 无 |
| 隔离边界 | 新增一类跨用户只读挂载（需额外评审） | **不变** |
| 磁盘收益 | 等价 | 等价 |
| 路径稳定性 | 略好（agent 级共享路径） | 不变（V1 已保证身份一致） |
| 实现/回滚风险 | 高 | 低 |

结论：容量目标用 V2 达成；不为非功能收益去动隔离与挂载主链路。

---

## 7. 明确不做与已知差异

| 项 | 结论 | 说明 |
|---|---|---|
| agent 级共享视图挂载 | **不做** | 见 §6.3 |
| MCP 身份 | **保持 owner** | 群聊里 MCP stdio 仍在归属者容器；仅影响同时使用 MCP 的群会话。加一条 warn 日志（`mcp session runtimeUser != owner`）便于观测，后续单独评审 |
| 会话级共享归档目录 | **不做** | 归档保持 owner；非归属身份不注入回读提示（D6） |
| 「用某人账号代操作」 | **不做**（独立需求） | 凭据委派需要显式授权与审计，另立项 |
| 前端 / 进度卡身份提示 | 不做 | 提示词身份段已让模型能解释；UI 文案后续可选 |
| 容器镜像 / 挂载 / 沙箱允许根 | **不改** | V1 零容器侧变更，无需重建容器 |

### 7.1 跨成员可见性矩阵（D4「产物归运行身份」的直接后果）

> 判定标准：一条**本地文件路径**产在身份 X 的目录下（`uploads/{X}`、`runtime/{X}`、`users/{X}`、`deps/{X}`、容器 `/tmp`），身份 Y（Y≠X）能否在后续轮次使用它。
> 结论：docker 模式下「按本地路径引用他成员产物」的超集都不可用，`edit_image` 是其中唯一连 URL 兜底都没有的工具；host 用户（全局 1 个）的只读工具不受影响（非 strict 沙箱）；有 4 条不受限通道兜底（见下）。

**受限（按本地路径）**

| # | 场景 | 行为 | 备注 |
|---|---|---|---|
| 1 | `edit_image`（他人产物/中间图/蒙版） | ❌ 本地路径越界；且不接受 http(s) URL | 唯一「本地 + URL 双不可用」；跨成员改图不可用，引导重新生成或本人操作 |
| 2 | `read_file` / `write_file` / `edit_file` / `glob_search` / `grep_search` / `shell`（docker） | ❌ 他人 `uploads/{uid}`、`runtime/{uid}`、`HOME/{uid}` 越界或不存在 | 容器只挂本人目录；host 用户读绝对路径不受限（现状，不收紧） |
| 3 | `feishu_send_image/file`、`dingtalk_*`、`send_wechat_*`（本地路径入参） | ❌ 他人 `uploads/{uid}` 路径被拒 | **同参数传 http(s) URL 可用**（宿主机抓取；`/uploads/` GET 为公开静态路由） |
| 4 | 会话中间产物按路径引用：`dump_user_messages`（userMessages）、`open_web_page` 全文（webPages）、web 输入框上传（incoming）、`shellOutput` | ❌ 他成员轮次拿路径回读失败 | 均落 `runtime/{uid}/{sid}`；**当轮无问题**（读写同身份） |
| 5 | 容器内 `/tmp` | ❌ 按用户持久挂载（`{tmpDir}/{uid}` → `/tmp`） | 跨成员互不可见 |
| 6 | `deps/{uid}` 已装 CLI、`users/{uid}` HOME 凭据/登录态/缓存、`userskills/{uid}`、`skill-views/{uid}` | ❌ | 按身份隔离属设计预期：各自安装、各自授权 |
| 7 | 压缩归档目录（`runtime/{owner}/{sid}/compaction`） | ❌ 非 owner 不注入回读提示 | D6 已定：归档保持 owner，不拆分 |

**不受限（可用通道）**

| 通道 | 说明 |
|---|---|
| 群共享工作区 `workspace/feishu-chat/{botId}/{chatId}` | 每成员容器都挂（`extraWorkspaces`）；**群内协作产物首选落地处** |
| `share/` 公共共享目录 | 全员 rw |
| http(s) URL | 发送工具宿主机抓取；`/uploads/{uid}/...` GET 公开可读（jwt 白名单，UUID 文件名） |
| 飞书群入站文件 | 落群共享工作区 `chat-files/{date}/`，非成员私有的 incoming |

**产品含义（需知悉）**：典型冲突场景是「B 说：把刚才那张图改成蓝色」——A 触发生成的图在 `uploads/{A}`，B 的轮次：① 读不到（`read_file`）；② 改不了（`edit_image`）；③ 但可以按 URL 转发（`send_*`）。V1 靠提示词身份段 + §5.9 诊断文案让模型主动解释，并给出「重新生成 / 请 A 本人操作 / 存到群工作区」三条出路；不新增共享读通道（与 D4 矛盾，如需另立项）。

---

## 8. 测试计划

### 8.1 单测

| 模块 | 用例 |
|---|---|
| `harness-service.spec` | `buildContext(...,67)` → `syncToSession` 收到 67、`touchRuntimeUser` 收到 67；`execute` 透传 67；B 轮次技能清单不含归属者个人技能；同步 `failed` 的技能被剔除；`loadMemories` 用 67 |
| `prompt-engine.spec` | 技能路径/上传目录取 runtimeUserId；身份段仅在 `runtimeUserId != userId` 渲染；普通会话提示词字节不变 |
| `skill-sync-service.spec` | 状态键按（agent, user, session）隔离；切换发言者各自建链、互不清链；视图失败返回 `failed` 且链接被摘 |
| `tool-dispatcher.spec` | `RUNTIME_SCOPED_TOOLS` 走 runtimeUserId；`task_*`/定时任务走 owner；docker 分支路由 runtimeUserId；开关关闭时全部回落 owner |
| `session-compaction-orchestrator.spec` / `session-history-loader.spec` | 写入仍用 owner；`runtimeUserId != owner` 时 hint 为 null |
| `task-terminal.service.spec` | 抽取用 `lastRuntimeUserId`，缺失回落 `session.userId` |
| `background-subagent-manager.spec` | 子会话继承 `lastRuntimeUserId`；`buildSubContext` 传入该身份 |
| `crash-recovery-runner.spec` | 恢复以 `lastRuntimeUserId` 执行，缺失回落 owner |
| `path-sandbox.spec` | 他人 runtime 目录 → 专属文案；普通越界文案不变；host 侧不启用诊断 |
| `app-config.spec` | `MAO_RUNTIME_IDENTITY` 解析与非法值回落 |

### 8.2 集成 / 手工冒烟（上线前必做）

1. 指定测试群：A（docker）建会话，B（docker）发言；或运维 host 账号建会话 + docker 用户发言；
2. B 发言轮次：提示词技能路径为 `runtime/B/{sid}/skills/...`；`read_file` SKILL.md 成功；`docker logs mao-user-B` 无 `Path escape`；
3. B 的 `skill-views/B` 出现对应技能副本；`deps/B/npm/bin` 可按技能文档自装 CLI 并执行；
4. A 再发言：路径/凭据/CLI 不受 B 影响；
5. `session.last_runtime_user_id` 随轮次在 A/B 间切换；
6. 压缩一次长会话：A 轮次有归档提示且路径可读；B 轮次无归档提示；
7. B 触发 `dump_user_messages` → 返回路径可被 B 的 `read_file` 读取；B 发送容器内文件成功。
8. 【评审补充】重试路径：让 B 的轮次失败 → 点失败卡「重试」→ 验证仍以 B 身份执行（提示词技能路径 `runtime/B`、`[skill-sync]` 日志 `runtimeUser=B`、`last_runtime_user_id` 仍为 B）。
9. 【评审补充】跨成员诊断：B 的轮次 `read_file` A 的 `uploads/{A}` 产物 → 断言容器内新诊断文案出现（同时证明 runtimeBuild 新代码已加载）；按提示用公开 URL 经 feishu/dingtalk/wechat send 转发成功；对 `runtime/{A}` 下文件断言「无公开 URL、先复制」文案。
10. 【评审补充】`send_wechat_image/file`：B 发送**自己** `uploads/{B}` 的产物成功（回归 SERVER_ONLY 分支改造）。

### 8.3 回归矩阵

| 场景 | 期望 |
|---|---|
| host 用户（唯一 1 个） | 行为不变（host 侧本无容器隔离） |
| 飞书/钉钉私聊 | owner == 发言者，路径/提示零变化 |
| web / 桌面会话 | executionUserId 为空 → runtimeUserId = owner |
| LOCAL 模式 | 路径仍为 `~/.mao/runtime/{sid}`，零变化 |
| 定时任务 | owner 执行；`last_runtime_user_id` 更新为 owner |
| 手动压缩 | owner；归档提示按 owner 正常 |
| 崩溃恢复 | 以崩溃前 `lastRuntimeUserId` 恢复；缺失回落 owner |
| 子代理 | 继承父轮次身份；技能仍清空 |
| 侧任务 | owner（现状） |

---

## 9. 上线、验证与回滚

### 9.1 上线前

1. `cd backend-ts && npm test` 全绿；`npm run build` 通过；
2. 迁移在本地/E2E 库执行验证（`V183` 可空列，无数据依赖）；
3. 生产 `backend-ts/.env` 确认未显式设置 `MAO_RUNTIME_IDENTITY`（默认 `execution`）。

### 9.2 发布

`cd /opt/mao && git pull` → 后端构建 → `bash scripts/restart-backend.sh`（蓝绿由 `scripts/lib/blue-green.sh` 完成；该脚本无 `--backend-only` 参数——后端发布即本次全部发布面；无需重建容器、无需前端发布）。注意：仓库内**不存在** `deploy-mao.sh`，勿照旧版本文档操作。

### 9.3 发布后 30 分钟检查点

| 检查 | 命令/位置 | 期望 |
|---|---|---|
| 技能路径 | `docker logs mao-user-{B} 2>&1 \| grep "Path escape"` | 无新增 |
| 同步日志 | 后端日志 `[skill-sync]` | 含 `owner=17 runtimeUser=67` 且无失败 |
| 身份持久化 | `SELECT id,user_id,last_runtime_user_id FROM session WHERE id={sid}` | 与最近发言者一致 |
| 视图/依赖 | `ls skill-views/{B}`、`deps/{B}/npm/bin` | 按需物化/安装 |
| 后端错误率 | 日志 ERROR 计数 | 无异常上升 |

### 9.4 回滚

1. **秒级止血**：`.env` 设 `MAO_RUNTIME_IDENTITY=owner` → 重新构建 → `bash scripts/restart-backend.sh`；群聊回到「按会话归属执行」；
2. **代码回滚**：revert 提交后重新部署；`V183` 列保留（可空，不影响旧代码）；
3. 回滚不涉及数据修复：技能视图/软链为运行期产物，自动重建。

---

## 10. 风险与应对

| # | 风险 | 影响 | 应对 |
|---|---|---|---|
| 1 | 同一群会话的可用技能集合随发言者变化 | 行为差异被误报为 bug | 提示词身份段 + 产品/客服问答口径 + 开关可回退 |
| 2 | 每个新发言者首轮物化 ~10MB 视图 | 大群磁盘增长 | V2 内容寻址+硬链接；监控 `du -sh skill-views` |
| 3 | 新发言者首次需安装技能 CLI | 首轮耗时 | 技能文档已内置安装流程；后续评估镜像预装高频 CLI |
| 4 | 生成产物归运行身份 | 其他成员无法直接 `edit_image` 该文件 | 文档说明；需要共享时发到群/工作区 |
| 5 | 其他成员历史消息里的 `@{...}@` 上传引用不可读 | 个别轮次读文件失败 | 已知限制（V1）；后续按「上传落会话工作区」另行设计 |
| 6 | MCP 容器身份仍是 owner | 使用 MCP 的群会话文件视图不一致 | 已知差异；warn 日志观测；单独评审 |
| 7 | `last_runtime_user_id` 被误用于全局回退 | 定时任务以他人身份执行 | 代码注释 + 评审约束：仅用于恢复/派生/抽取 |
| 8 | `owner` 模式在群聊等于「以归属者身份执行」 | 应急模式的安全语义弱于执行侧 | 仅应急、限时使用、需审计；DEPLOY.md 写明 |
| 9 | 蓝绿期间旧实例不写新列 | 恢复回落 owner | 可接受（仅窗口期） |
| 10 | 记忆写入归属变化 | 群聊记忆归发言者 | 符合 D5；产品需知晓 |
| 11 | 提示词/send 工具描述无 uploads 公开 URL 映射 | 「改用 http(s) URL」建议模型无法执行 | V1.1 吸收：诊断文案按类别给出可执行指引 + 宿主持拼 URL + 提示词补映射规则（§5.9） |
| 12 | 飞书重试无原发言者（stubContext `senderId: null`）；owner 手动压缩会覆写 `last_runtime_user_id` | 重试/恢复身份漂移到 owner | V1.1 吸收：重试传 `lastRuntimeUserId ?? null`（与崩溃恢复同源，§5.2）；覆写场景可接受 |
| 13 | syncState 为内存 Map，部署即清空 | 发布后首轮全量重同步（指纹命中仅换链） | 低峰发布；监控 `[skill-sync]` 日志量与首轮延迟 |
| 14 | 容器侧新诊断文案懒生效（runtimeBuild 漂移→进程重启；busy 延后、autoUpgrade 可关） | 跨成员报错仍是旧文案 | §8.2 冒烟断言新文案出现；autoUpgrade 关闭时运维手工重启容器 |
| 15 | 提示词前缀随发言者切换失效 | prompt cache 命中率略降（同一执行内无影响） | 已知，接受 |
| 16 | 钉钉第二入口、微信入站的身份语义未定 | 群聊钉钉/微信（若支持群）身份回落 owner | §5.0 第 2 步入口审计时定论并回填本文 |

---

## 11. 工作量

| 阶段 | 内容 | 估时 |
|---|---|---|
| V1 实现 | §5.1–5.10（16 个文件，含评审补充的重试/wechat/诊断/入口审计） | 2–2.5 人日 |
| V1 测试 | 单测 + 冒烟 + 回归 | 0.5–1 人日 |
| V2 | 内容寻址 + 硬链接 + GC | 1–1.5 人日 |
| 合计 | 含文档与发布 | 4–5 人日 |

---

## 12. 代码位置索引（当前代码）

| 主题 | 位置 |
|---|---|
| 会话归属创建 | `backend-ts/src/app-feishu-messaging.ts`（会话工厂） |
| 运行身份注入 | `backend-ts/src/harness/core/harness-service.ts`（`execute` / `buildContext`） |
| 技能同步 | `backend-ts/src/harness/skill/skill-sync-service.ts` |
| 技能视图 | `backend-ts/src/harness/skill/skill-view.service.ts` |
| 提示词 | `backend-ts/src/harness/core/prompt-engine.ts` |
| 工具派发 | `backend-ts/src/harness/tool/tool-dispatcher.ts`、`tool-invocation.ts`、`harness/core/agent-loop.ts` |
| docker 路由 | `backend-ts/src/harness/container/docker-tool-router.ts` |
| 容器沙箱 | `backend-ts/src/harness/container/container-tool-executor.ts`、`harness/safety/path-sandbox.ts` |
| 挂载清单 | `backend-ts/src/harness/container/container-mount-planner.ts`、`container-registry.ts` |
| 压缩归档 | `backend-ts/src/harness/core/session-compaction-orchestrator.ts`、`session-history-loader.ts`、`compaction-archive.service.ts` |
| 记忆 | `backend-ts/src/harness/core/harness-service.ts`（`loadMemories`）、`session/task-terminal.service.ts` |
| 发送工具字节 | `backend-ts/src/harness/tool/impl/send-file-bytes.ts`、`harness/container/read-bytes-bridge.ts` |
| MCP 容器寻址 | `backend-ts/src/harness/container/routing-mcp-client-manager.ts`、`app-container-runtime.ts`（`mcpRuntimeProbe`） |
| 子代理 | `backend-ts/src/harness/delegate/subagent-invocation.service.ts`、`background-subagent-manager.ts` |
| 崩溃恢复 | `backend-ts/src/harness/core/crash-recovery-runner.ts` |
| 迁移目录 | `backend-ts/db/migration/`（最新 V182，本次新增 V183） |

---

## 附录 A：生产验收脚本

```bash
# 1) 测试群准备：A(docker) 建会话，B(docker) 发言
#    记录 sid；用 B 发言触发任一需要技能的任务

# 2) 路径与挂载事实
ls -l /opt/mao-data/runtime/<B>/<sid>/skills/ | head
ls -d /opt/mao-data/skill-views/<B>/<skill> /opt/mao-data/deps/<B>

# 3) 容器日志（应无输出）
docker logs mao-user-<B> 2>&1 | grep "Path escape"

# 4) 身份持久化（应为 B）
#    库名与生产 .env 核对（.env.example 为 mao；旧版本文写 workbench_mao，待确认）
mysql -h <host> -u <user> <db> \
  -e "SELECT id,user_id,last_runtime_user_id FROM session WHERE id=<sid>"

# 5) 回退演练（可选，低峰）
#    .env: MAO_RUNTIME_IDENTITY=owner → 重新构建 → bash scripts/restart-backend.sh
#    验证群聊以 A 身份执行；验证后改回 execution 重新部署
#    注意：仓库无 deploy-mao.sh；蓝绿由 scripts/lib/blue-green.sh 完成
```

## 附录 B：定稿修订对照（相对初稿）

| # | 初稿问题 | 定稿处理 |
|---|---|---|
| 1 | 记忆只改注入、抽取仍按 owner → B 的记忆写进 A | D5：注入与抽取同源，新增 `last_runtime_user_id` |
| 2 | 压缩归档按身份拆分 → 回读缺段 | D6：归档不拆，仅抑制非 owner 提示 |
| 3 | 同步失败仍列技能 → 继续撞墙 | D7：失败技能本轮剔除 + 告警 |
| 4 | 缺隐私验收 | §8.1 增加「B 轮次不含归属者个人技能」 |
| 5 | 恢复/子代理/侧任务三套临时方案 | D2 + D9：一个持久化字段统一 |
| 6 | 初稿 P2 为省磁盘动挂载/沙箱，风险错配 | D10：换内容寻址+硬链接（§6） |
| 7 | 初稿 P2 触发源需给 ToolInvocation 加 agentId，侵入大 | 废弃 agent 挂载，无需 agentId 穿透（仅保留 runtimeUserId） |
| 8 | 「用某人账号代操作」诉求未说明 | §2.2 明确非目标，独立立项 |
| 9 | 技能集合随发言者变化被当实现细节 | §10 风险 1 + 提示词身份段 + 产品确认项 |
| 10 | 生成产物归属含糊 | D4 定为运行身份，影响与限制写入 §7/§10 |
| 11 | `incoming` 改动收益低 | 保留（与运行身份一致），跨成员引用列为已知限制（§10 风险 5） |
| 12 | 工作量偏乐观、缺实施顺序 | §11 重估；§5 顺序即实施顺序；本次一次发布 |
| 13 | 「产物归运行身份」的跨成员限制未量化，`edit_image` 被当成孤例 | 新增 §7.1 可见性矩阵（7 类受限 / 4 条可用通道）+ §5.9 第 3 条产物读字节诊断；明确 `edit_image` 是唯一无 URL 兜底的工具 |

---

## 附录 C：评审补充对照（V1.1，相对定稿 V1.0）

> 2026-11-04 代码评审（五路核实：harness-service / 技能同步与提示词 / 工具派发 / 容器沙箱 / 压缩子代理恢复迁移）发现的缺口与吸收情况。决策 D1–D10 不变。

| # | 评审发现 | 严重度 | V1.1 处理 |
|---|---|---|---|
| 1 | 飞书失败卡「重试」`execute`（`agent-inbound-handler.ts:313-317`）不传 `executionUserId`，重试轮以 owner 身份跑——恰好在身份不匹配的失败轮上复现 bug；钉钉 `:340` 同理 | P1 | §5.2 入口表补全并规定重试传 `lastRuntimeUserId ?? null`（stubContext 无原发言者，与崩溃恢复同源）；§8.2 加重试冒烟；§10 风险 12/16 |
| 2 | `RUNTIME_SCOPED_TOOLS` 漏 `send_wechat_image/file`（§7.1 却提到它们）；它们在 SERVER_ONLY 分支按 owner 读字节，B 连自己 `uploads/{B}` 产物都发不出 | P1 | §5.5 清单补入 + 分支差异说明（wechat 走 SERVER_ONLY，feishu/dingtalk 走宿主回退，分别回归）；§8.2 补 wechat 冒烟 |
| 3 | §5.9「转发请改用 http(s) URL」不可执行：提示词无 uploads 公开 base URL（实证），且 `runtime/` 下产物无公开路由 | P1 | §5.9 第 3 条重写为分类可执行文案（uploads→宿主持拼 `publicUrl`；runtime→先复制到 uploads/群工作区）+ 提示词补 uploads 路径↔URL 映射规则；§10 风险 11 |
| 4 | §9.2/§9.4/附录 A 引用不存在的 `deploy-mao.sh --backend-only` | P1 | 改为 `scripts/restart-backend.sh`（蓝绿在 `scripts/lib/blue-green.sh`，无 `--backend-only`） |
| 5 | 容器侧诊断文案生效路径未述（runtimeBuild 漂移→进程懒重启；busy 延后、autoUpgrade=V178 可关） | P2 | §5.9 第 2 条补生效路径；§8.2 断言新文案出现 |
| 6 | §5.11 漏 `streaming-ws-handler.ts:793` 第二处 `syncToSession`（语义正确但需显式 review） | P2 | 清单补第 16 项 |
| 7 | `touchRuntimeUser` 失败语义未定（DB 写失败会废掉本轮） | P2 | §5.2 规定仅告警不阻断，身份以内存值为准 |
| 8 | syncState 为内存 Map，部署后清空→首轮全量重同步 | P2 | §10 风险 13（低峰发布+监控） |
| 9 | 环境变量文档漏 `skills/mao-cli/reference/config.md`（AGENTS.md 要求 mao-cli 同步；DEPLOY.md 已只是索引） | P2 | §5.2/§5.11 补 config.md |
| 10 | 工作量偏乐观 | P2 | §11 V1 实现改 2–2.5 人日，合计 4–5 人日 |
| 11 | 附录 A 库名 `workbench_mao` 与 `.env.example` 的 `mao` 不一致 | P3 | 改为 `<db>` 并标注待核对 |
| 12 | 提示词身份段只有原始 user id；prompt cache 前缀随发言者切换失效未入风险表 | P3 | §5.9 身份段补显示名；§10 风险 15 |

