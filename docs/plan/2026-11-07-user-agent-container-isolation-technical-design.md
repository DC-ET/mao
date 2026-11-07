# 人+Agent 维度容器隔离（User+Agent Container Isolation）技术方案

> 状态：已实施（2026-11-07 开发完成；一期/二期全量落地，backend 5699 用例全绿、admin 构建通过）
> 日期：2026-11-07
> 覆盖端：后端 backend-ts、管理后台 admin。桌面端 desktop、安卓 android、`shared/contracts`、agent-cli、部署脚本**不改**。
> 上游调研：[2026-11-07-container-isolation-user-agent-dimension.md](../research/2026-11-07-container-isolation-user-agent-dimension.md)（可行性、6 项决策已拍板，见本文 §10）。
> 核心前置：[2026-10-14-user-runtime-container-isolation-design.md](2026-10-14-user-runtime-container-isolation-design.md)、[2026-10-24-agent-experience-library-technical-design.md](2026-10-24-agent-experience-library-technical-design.md)、[2026-10-21-shared-directory-technical-design.md](2026-10-21-shared-directory-technical-design.md)。

---

## 1. 需求背景

docker 模式下容器按「人」维度创建复用（`mao-user-{userId}`，一人一容器）。Agent 维度的数据——Agent 关联的 skill 视图、团队经验库——是 2026-10-21/24 之后才出现的数据类型，被叠加到了用户维度的容器上，形成结构性错配：

| 事项 | 现状问题 | 证据 |
|---|---|---|
| 团队经验库 | `shareDir` 整根 rw 挂进每个容器，容器内 Agent 可**直读并直写**任何 Agent 的经验库（软链只防误碰不防主动越界） | `container-mount-planner.ts:105`、`experience-index.service.ts:7-8` |
| skill 视图 | `skillViews/{userId}` 整根 ro 挂载，容器内可读该用户所有 Agent 关联过的技能视图，绕过会话软链白名单 | `container-mount-planner.ts:109`、`prompt-engine.ts:466-471` |
| 资源隔离 | 同用户所有 Agent 共享单容器的 2G/2CPU，一个 Agent 失控拖累其他 Agent | `container-registry.ts:736-739` |
| 重建爆炸半径 | 用户容器一次重建杀掉该用户**全部**会话的 shell/终端 | `container-registry.ts:583-590` |

会话可见面（软链 + 提示词白名单）今天是收窄的，但只防混淆不防越读。本方案把容器隔离维度从「人」改为「人 + Agent」，使数据归属维度与隔离维度对齐。

## 2. 需求描述

### 2.1 要做的

1. **容器键改复合**：容器标识从 userId 改为 `(userId, agentId)` 二元组，容器名 `mao-user-{userId}-agent-{agentId}`；一用户多 Agent 并存多容器。
2. **skill 视图按 (user, agent) 物化**：视图路径从 `{skillViewsDir}/{userId}/{skillName}` 改为 `{skillViewsDir}/{userId}/{agentId}/{skillName}`，容器只 ro 挂载当前 (user, agent) 的视图目录。
3. **经验库按 Agent 收窄挂载**：容器从「挂 `shareDir` 整根」改为「只挂 `<shareDir>/agent-experience/{agentId}` 子目录（rw）」，容器内无法触达其他 Agent 的经验库。
4. **通道层复合键**：socket 目录、连接表、token、PTY hub 全部改为 `(userId, agentId)` 键。
5. **派发链路穿线 agentId**：`ToolInvocation` 增加 `agentId`（按轮快照），docker 路由、`read_bytes`、MCP 派发全部携带。
6. **预热双触发**：心跳预热与"会话内切换 Agent"均按 (userId, agentId) 预热。
7. **admin 管理面**：容器列表按 (user, agent) 展示，回收支持按容器粒度。
8. **切 Agent 接受中断**（已拍板）：不禁止"运行中可切"，切换后持久 shell / async 后台任务随旧容器失效，报错文案引导重建。

### 2.2 不做的

| 项 | 说明 |
|---|---|
| deps/HOME/tmp/workspace 拆分 | **维持用户级共享**（决策 2）：`deps/{userId}`、`users/{userId}`、`{tmpDir}/{userId}`、workspace（含 (userId, slug) 项目工作区）继续整目录挂进该用户的每个 Agent 容器 |
| userSkills 引入 Agent 绑定 | **不做**（决策 3）：`userskills/{userId}` 保持用户级 rw 挂载，个人技能对所有 Agent 开放的现有产品语义不变 |
| 禁止会话内切 Agent | **不做**（决策 1/4）：web 端切换入口、飞书/钉钉 bot 热切换均保持现状语义；切换的容器侧代价按 §5.9 行为链接受 |
| 资源上限调整 | **不做**（决策 6）：沿用 `MAO_CONTAINER_MEMORY_MB=2048` / cpus=2 / pids-limit=512 全局默认 |
| host 模式改造 | **不做**：`DockerToolRouter` 整体短路的行为不变，host 模式代码路径零变化 |
| LOCAL 模式改造 | **不做**：LOCAL 走 WebSocket 委托桌面端执行，与容器无关 |
| 会话间隔离 | **不承诺**：同 (user, agent) 的多会话仍共享一容器，`runtime/{userId}` 整根挂载下会话间数据互见（与现状同粒度） |
| DB 迁移 | **不做**：容器状态全内存 + docker labels，无容器表；`session.agent_id BIGINT NOT NULL`（V001:151）保证每个会话必有 Agent，无需新增列 |
| 旧 skill 视图迁移/清理 | **不做**：`{skillViewsDir}/{userId}/{skillName}` 旧视图与 `.meta/{userId}/` 旧元数据是可再生物理副本，切到新路径后不再被引用，保留在盘上无害 |
| 跨端枚举/工具注册变更 | **不做**：无新增内置工具、无新增 LLM 场景、无跨端枚举——不触及 `toolDisplay.ts` / `tool-result-summarizer.ts` / `no-progress-notice.ts` / `LlmCallScene` 三处同改规范 |
| desktop / android / agent-cli | **不改**：CLOUD 服务端执行，前端不感知容器粒度 |

## 3. 架构总览

### 3.1 容器键与身份模型

```
容器键 key = `${userId}:${agentId}`        （内存 entries / 连接表 / 锁的键）
容器名     = mao-user-{userId}-agent-{agentId}
docker label = mao.runtime=user、mao.user={userId}、mao.agent={agentId}
```

**userId 维度沿用现状「运行身份」口径：路由用 runtimeUserId（执行用户），不是会话归属 owner**。这是本次设计核实的关键事实：`tool-dispatcher.ts:291` 的 `runtimeUserId = runtimeIdentity ?? executionUserId ?? userId`、`:398` 的 `routeUserId = runtimeUserId`——群聊会话中每个发言者的执行本来就跑在发言者自己的容器里，技能同步（`syncToSession(agent, runtimeUserId, sessionId)`）与 envelope（`runtimeDir = runtime/{runtimeUserId}/{sid}`）都按发言者寻址。因此本方案不改变用户维度的口径，只**叠加** agent 维度：

- 群聊（发言者 U2、bot Agent B）：容器 `(U2, B)`，技能视图 `{skillViewsDir}/{U2}/{B}/`，与技能同步的写入口径（`skill-view` 物化于 runtimeUserId）天然一致；
- 普通 web 会话：owner == runtimeUser，容器 `(owner, session.agentId)`；
- 终端：REST 入口 `requireSessionOwner`（`terminal.routes.ts:41`），容器键 `(owner, session.agentId)`，在终端创建时定型，此后不随会话切 Agent 迁移（决策 1：终端随旧容器存活）。

### 3.2 挂载清单变化（唯一的安全边界）

| purpose | 现状 | 本方案后 | 模式 |
|---|---|---|---|
| userHome | `{userHomeDir}/{userId}` | 不变 | rw |
| workspace | `{workspaceRoot}/{userId}` | 不变 | rw |
| runtime | `{runtimeDir}/{userId}` | 不变 | rw |
| deps | `{depsDir}/{userId}` | 不变 | rw |
| channel | `{channelDir}/{userId}` | **`{channelDir}/{userId}/{agentId}`** | rw |
| userSkills | `{userSkillsDir}/{userId}` | 不变（决策 3） | rw |
| uploads | `{uploadDir}/{userId}` | 不变 | rw |
| tmp | `{tmpDir}/{userId}` | 不变（决策 2） | rw |
| dist | `{distDir}` | 不变 | ro |
| **skillViews** | **`{skillViewsDir}/{userId}`** | **`{skillViewsDir}/{userId}/{agentId}`** | ro |
| **share** | **`{shareDir}` 整根** | **`{shareDir}/agent-experience/{agentId}`** | rw |
| sessionWorkspace | 通道会话工作区，按 DB user_id 过滤 | 按 DB (user_id, agent_id) 过滤（§5.2） | rw |

隔离效果：容器内可见的 skill 视图 = 当前 (user, agent) 的技能；可见的经验库 = 当前 Agent 的库目录；其他 Agent 的视图与经验在容器文件系统层面不存在。

### 3.3 一次工具调用的链路变化

```
AgentLoop（宿主机，每轮 buildContext 定快照：context.agentId = agent.id）
  → ToolInvocation { …, runtimeUserId, agentId }          ← 新增 agentId（按轮快照）
    → ToolDispatcher.dispatchFullOutcome
      → DockerToolRouter.dispatch({ userId, agentId, sessionId, workspace })
          ├─ ContainerRegistry.ensureRunning(userId, agentId, workspace)
          ├─ SessionEnvelopeBuilder.build({ userId, … })   ← 不变（用户维度凭据）
          └─ RuntimeChannelServer.request(key(userId, agentId), …)
```

## 4. 技术选型

| 决策点 | 选型 | 理由 | 已否决的备选 |
|---|---|---|---|
| 容器键 | `(runtimeUserId, agentId)` 二元组 | 与技能同步/envelope 的运行身份口径一致；群聊发言者各自容器不串 | 按 owner 路由（与技能同步的 runtimeUserId 口径冲突，群聊技能链接会悬空） |
| agentId 的线程传递 | `ToolInvocation` 加字段（对象式入口 `dispatchInvocation`，唯一调用点 `agent-loop.ts:817`） | 按轮快照语义天然成立（buildContext 每轮重算）；避开 `dispatchFull` 十参位置签名的强转风险 | 每次 `ensureRunning` 时按 sessionId 查库（轮中切 Agent 会读到新值，产生"半轮 A 半轮 B"分裂） |
| dispatcher 对 null agentId 的兜底 | 按 sessionId 查库一次（新增轻量依赖），仍 null 则返回明确工具错误 | 防未来新增调用方漏传；`session.agent_id NOT NULL` 保证兜底必中 | 静默跳过 docker 路由（违反"容器不可达不静默降级"既定原则） |
| skill 视图物化维度 | `{skillViewsDir}/{userId}/{agentId}/{skillName}` | 挂载路径恒定：skillNames 增删/技能源更新只改目录内容（容器 ro 即见），**零容器重建** | 按 skillNames 枚举挂载（集合一变即触发整容器重建） |
| 经验库挂载 | `<shareDir>/agent-experience/{agentId}` 子目录 rw | 固定路径适配挂载定型约束；容器内写路径 realpath 后仍命中该子目录，`ExperienceIndexService` 的 `refreshIfUnderRoot` 首段数字校验照常工作 | 实体副本同步（双写一致性问题，2026-10-24 设计依赖双端直写同目录） |
| 容器内经验沙箱根 | env 新增 `MAO_CONTAINER_AGENT_ID`，沙箱允许根从 `shareDir` 收窄为 `<shareDir>/agent-experience/{agentId}` | 文件系统层（挂载）+ 沙箱层（允许根）双重收口；`ExperienceIndexService` 构造不变（root 仍为 `<shareDir>/agent-experience`） | 改造 `ExperienceIndexService` 接受 agent 目录为根（dirFor 会二次拼接，改动面更大） |
| 通道连接键 | `Map<string>` 键 `userId:agentId`，socket 目录 `{channelDir}/{userId}/{agentId}/` | 单连接踢旧逻辑按键隔离，两容器并存互不干扰；`SO_PEERCRED` 反查容器名与路径双段比对 | 复用用户级 socket（第二连接踢旧 → 同用户多容器互踢死循环） |
| agentless 会话 | **不存在**，无需哨兵值 | `session.agent_id BIGINT NOT NULL`（V001:151），每个会话必有 Agent | agentId=0 哨兵桶（无必要） |
| 挂载源目录 | `createAndStart` 在 `docker run` 前对视图目录与经验子目录显式 `mkdirSync(recursive)` | 预热窗口可能早于首轮技能同步/经验挂载，消除 docker 自动建目录的隐式行为 | 依赖 docker 自动创建（隐式、不可测） |
| 用户级 recycle 语义 | `POST /v1/users/:id/container/recycle` body 增可选 `agentId`：缺省回收该用户**全部**容器，指定则回收单个 | 保持既有运维语义（"重建用户容器"仍是合法操作），admin 面板另有按行回收 | 只允许按 (user, agent) 回收（破坏既有 admin 操作） |
| 上线方式 | 两期合并上线（见 §9）：一期宿主机数据面、二期容器键切换 | 一期产物（per-agent 视图目录）落在旧挂载根之内，窗口期容器照常可读，两期之间无兼容断点 | 单次全量切换（回滚粒度粗） |

## 5. 实现设计

### 5.1 容器注册表（`container-registry.ts`）

- 键与名：`entries = new Map<string, ContainerEntry>`，键 `containerKey(userId, agentId) = \`${userId}:${agentId}\``；`containerName(userId, agentId)` 返回 `mao-user-${userId}-agent-${agentId}`。`ContainerEntry` 增加 `agentId: number` 字段。
- 入口签名：`ensureRunning(userId, agentId, requiredWorkspace?)`；`recycleUser(userId, opts?: { force?: boolean; agentId?: number })`——指定 `agentId` 回收单个，缺省遍历回收该用户全部容器（busy 且未 force 的跳过，聚合返回结果）。`withUserLock` 的锁粒度从 userId 改为复合键（同用户两个 Agent 容器的生命周期操作并行互不阻塞）。
- 生命周期逻辑（创建/复用/漂移重建/idle 回收/`stopAllForShutdown`）全部按复合键运作，判定逻辑不变；idle 与 lifetime 阈值沿用全局配置。
- `createAndStart(userId, agentId, extraWorkspaces, existing?)`：
  - docker args 增加 `--label mao.agent={agentId}` 与 `-e MAO_CONTAINER_AGENT_ID={agentId}`（容器内硬依赖，缺失 `exit(1)`，与 `MAO_CONTAINER_USER_ID` 同口径）；
  - `MAO_SKILL_VIEWS_DIR` 的值从视图根改为 `{skillViewsDir}/{userId}/{agentId}`（消费方 `runtime-agent` 的沙箱登记代码不变，值变了根就变了）；
  - 新增 `-e MAO_EXPERIENCE_AGENT_DIR=<shareDir>/agent-experience/{agentId}`；
  - `ensureChannelListening(userId, agentId)`、`issueChannelToken(userId, agentId)`、`requestShutdown(key)` 按复合键；
  - `docker run` 前对 `{skillViewsDir}/{userId}/{agentId}` 与 `<shareDir>/agent-experience/{agentId}` 执行 `mkdirSync(recursive)`（预热窗口可能早于首轮技能同步/经验挂载，见 §4 选型）。
- `listEntries()`：每行增加 `agentId`，按 `(userId, agentId)` 升序。
- 挂载指纹：`standardMountsFingerprint` 覆盖的标准挂载含两个新的 agent 维度条目（路径按 key 恒定），skillNames 变化不进指纹、不触发重建。

### 5.2 挂载计划（`container-mount-planner.ts`）

- `plan(userId, agentId, sessionWorkspaces)`；skillViews 条目改 `{skillViewsDir}/{userId}/{agentId}`（ro），share 条目改 `<shareDir>/agent-experience/{agentId}`（rw），channel 条目改 `{channelDir}/{userId}/{agentId}`（rw）。
- `assertSafe` 规则修订：
  - rw 项"必须含 `/{userId}/` 段"的既有规则对新增 agent 维度条目按结构豁免的方式与通道工作区一致，另加**agentId 段校验**：skillViews/share 条目的源路径必须恰为 `{登记根}/{userId}/{agentId}`（share 为 `{shareDir}/agent-experience/{agentId}`，第三段必须为纯数字且等于入参 agentId）；
  - `purpose === 'share'` 的"必须恰为登记的 shareDir 根"改为"必须恰为登记的经验子目录"，杜绝借 purpose 挂 share 根或其他 Agent 子目录；
  - `assertShareDirIndependent`（shareDir 不得等值/包含于按用户数据根）与"skillViewsDir 不得位于 shareDir 之内"两条互斥校验保留，语义不变；
  - 符号链接 realpath、父目录防护、只读项不可覆写等既有规则保留。
- 通道会话工作区归属过滤：`sessionWorkspacesOf(userId)` 回调改为 `(userId, agentId)`，底层新增仓库方法 `listWorkspacesByUserAndAgent(userId, agentId)`（`SELECT workspace FROM session WHERE user_id = ? AND agent_id = ? AND workspace IS NOT NULL`），容器只挂"该用户 + 该 Agent"的会话的通道工作区；私聊叶子 `private-{userId}` / `p2p-{userId}` 的本人校验保留。群聊工作区由 `requiredWorkspace` 显式传入的既有路径挂入，行为不变。
- 审计日志（userId + 完整挂载表）增加 agentId 字段。

### 5.3 通道层（`runtime-channel-server.ts` / `runtime-channel-protocol.ts`）

- 连接表 `connections = new Map<string, ConnectionImpl>`，键 `containerKey`；socket 路径 `{channelDir}/{userId}/{agentId}/runtime.sock`；`ensureListening(userId, agentId)` 负责建目录 + 启听；`issueToken(userId, agentId)` 按容器签发。
- "同一键第二连接踢掉旧连接"的语义保留（容器重建场景），跨键互不影响——同用户两个 Agent 容器并存连接互不干扰。
- 对端身份校验：`SO_PEERCRED` 取对端 PID 反查容器名，要求与 socket 路径中的 `(userId, agentId)` 双段一致，不一致立即断开。
- 协议帧格式、消息类型全集、心跳与超时语义不变（`RuntimeEnvelope` 不加字段：凭据与路径本就按用户维度下发）。

### 5.4 skill 视图按 (user, agent) 物化（`skill-view.service.ts` / `skill-sync-service.ts`）

- `ensureView(userId, agentId, skillName, sourceFolder)`：视图目录 `{skillViewsDir}/{userId}/{agentId}/{skillName}`，元数据 `{skillViewsDir}/.meta/{userId}/{agentId}/{skillName}.json`，进程内并发锁键 `{userId}:{agentId}:{skillName}`。指纹短路与"暂存拷贝 → 原子 rename"重建逻辑不变。
- `skill-sync-service.ts` 的 `syncToSession` 已持有 `agent`（`:371` 调用点传参不变），内部调用 `ensureView` 时传 `agent.id`。
- 旧路径产物（`{skillViewsDir}/{userId}/{skillName}` 与 `.meta/{userId}/`）：不迁移、不清理、不读取（§2.2）。

### 5.5 经验库容器内收口（`runtime-agent.ts` / `container-tool-executor.ts`）

- 沙箱允许根：经验相关登记从 `MAO_SHARE_DIR`（shareDir 整根）改为 `MAO_EXPERIENCE_AGENT_DIR`（当前 Agent 的库子目录）；`MAO_SHARE_DIR` env 保留（`ExperienceIndexService` root 构造依赖，见 §5.1）。
- `ExperienceIndexService` 在容器内的构造与索引刷新逻辑**零改动**：写路径 realpath 后落在本容器唯一挂载的 `{agentId}` 子目录内，`refreshIfUnderRoot` 的首段数字校验照常命中。
- 宿主机侧 `pathSandbox.addAllowedRoot(shareDir)`（`create-app.ts:468`）与 admin 经验库管理接口不变（宿主进程本就持有全库权限）。

### 5.6 派发链路穿线 agentId

- `ToolInvocation`（`tool-invocation.ts:8`）增加 `agentId?: number | null`；填充点唯一：`agent-loop.ts:817-832` 的 `dispatchInvocation` 调用，取 `context.agentId`（`harness-service.ts:395` 每轮 `buildContext` 赋值 `agent.id`，即按轮快照）。子代理/边路任务复用同一 AgentLoop，自动携带。
- `dispatchInvocation → dispatchFullOutcome`：新增 `routeAgentId = invocation.agentId`；为 null 时按 `sessionId` 查库兜底（dispatcher 新增轻量依赖 `sessionAgentIdOf(sessionId): Promise<number | null>`），仍为 null 则该工具返回明确错误"容器路由缺少 Agent 维度，无法派发"。
- `DockerDispatchContext`（`docker-tool-router.ts:27`）增加 `agentId: number`；`dispatch` / `ensureChannelReady` / `readBytes` / `mcpConnect` / `mcpCall` 的入参与内部 `ensureRunning`、`getConnection` 全部携带。
- 发送类工具上下文（`send_wechat_*` / `feishu_send_file` / `dingtalk_send_file` 的 ctx，SERVER_ONLY 分支构造）增加 `agentId` 字段，与 `runtimeUserId` 同点填充，供 `read-bytes-bridge.readBytes` 透传。
- `MCP` 链路：`routing-mcp-client-manager` 的 `mcpConnect` / `mcpCall` 入参增加 `agentId`，来源为会话构建处的 `session.agentId`（`harness-service.ts` 的 `loadAgentServers` 调用点）。容器内 `container-mcp-bridge` 的 `Map<sessionId, …>` 会话维度注册表不变。

### 5.7 终端与 PTY（`terminal.routes.ts` / `terminal-manager.ts` / `app-utils.ts` / `pty-bridge.ts`）

- `SpawnPtyOptions` 增加 `agentId`；`terminal.routes.ts` 创建终端时从 `session.agentId` 填充（`requireSessionOwner` 已取到 session）。**终端的容器绑定在创建时定型，之后不随会话切 Agent 迁移**（决策 1：随旧容器存活）。
- `ptyChannelHubs` / `ptyHubGeneration` 的 Map 键从 `number`（userId）改为 `string`（`containerKey`），世代判定（`entry.startedAtMs`）逻辑不变。

### 5.8 预热（`app-container-runtime.ts` / `session.service.ts`）

- 心跳预热（`:203-212`）：`ensureRunning(session.userId, session.agentId, session.workspace ?? null)`；`dockerRouter.enabledFor(session.userId)` 判定不变。
- 切换预热：`sessionService` 新增可选监听器 `onAgentSwitched(userId, agentId, sessionId)`（装配模式同 `touchRuntimeUser` 的可选依赖注入），实现方在 `app-container-runtime.ts`：`dockerRouter.enabledFor(userId)` 通过时 fire-and-forget `ensureRunning(userId, agentId, session.workspace)`，异常 debug 日志不阻断 PATCH。`session.routes.ts:430` 的 PATCH agentId 分支调用 `updateSessionAgent` 后触发监听器。
- 群聊发言者首次执行的冷启动与现状相同（今天 `ensureRunning(speaker)` 同样冷启动），不新增恶化，不做额外处理。

### 5.9 会话内切换 Agent 的容器侧行为链（已拍板，实现按此执行）

| 时机 | 行为 |
|---|---|
| 轮中切换 | 当前轮不受影响：`ToolInvocation.agentId` 按轮快照，本轮剩余工具调用仍在旧容器执行。禁止在工具调用点现读 `session.agentId` |
| 下一轮开始 | 路由到新容器（切换预热已消除冷启动等待） |
| 旧 keep_session shell | 旧 session_id 在新容器报"shell 会话不存在"，报错文案含"该会话已切换 Agent，请重新创建 shell 会话" |
| 已 attach 终端 | 留在旧容器继续存活（绑定创建时不迁移），直到用户关闭或旧容器 idle 回收 |
| async 后台任务 | 留在旧容器成孤儿；`await_async` 报"后台任务不存在" |

### 5.10 admin 管理面

- `GET /v1/admin/containers`（`container-admin.routes.ts`）：每行增加 `agentId`（`listEntries` 已含 containerName），前端表格增加"Agent ID"列。
- `POST /v1/users/:id/container/recycle`（`user.routes.ts`）：body 增可选 `agentId`，语义见 §5.1；`ContainerRebuildPanel.vue` 每行增加回收按钮（携带该行 agentId），保留现有"整用户回收"入口。

## 6. 落地清单

### backend-ts

| 文件 | 改动 |
|---|---|
| `harness/container/container-registry.ts` | 复合键/容器名/label/env/锁/指纹/回收/listEntries/挂载源 mkdir/`ensureRunning(userId, agentId, …)` |
| `harness/container/container-mount-planner.ts` | `plan(userId, agentId, …)`、skillViews/share/channel 三条挂载改路径、assertSafe agentId 段校验、审计日志加 agentId |
| `harness/container/runtime-channel-server.ts` | 连接键/socket 目录/token/`ensureListening(userId, agentId)`/peer 双段校验 |
| `harness/container/docker-tool-router.ts` | `DockerDispatchContext.agentId`、`ensureRunning`/`getConnection`/`readBytes`/`mcpConnect`/`mcpCall` 穿线 |
| `harness/container/runtime-channel-protocol.ts` | 无帧格式改动；`RuntimeEnvelope` 不变（确认项） |
| `harness/container/read-bytes-bridge.ts` | 入参加 agentId 透传 |
| `harness/container/routing-mcp-client-manager.ts` | `mcpConnect`/`mcpCall` 入参加 agentId |
| `harness/container/runtime-agent.ts` | `MAO_CONTAINER_AGENT_ID` 硬依赖（缺失 exit 1）、经验沙箱根改 `MAO_EXPERIENCE_AGENT_DIR` |
| `harness/container/container-tool-executor.ts` | 经验沙箱根消费方对齐 |
| `harness/tool/tool-invocation.ts` | `ToolInvocation.agentId` 字段 |
| `harness/core/agent-loop.ts` | `dispatchInvocation` 填充 `agentId: context.agentId` |
| `harness/tool/tool-dispatcher.ts` | `dispatchFullOutcome` 穿线 routeAgentId + 查库兜底依赖；send 工具 ctx 加 agentId |
| `harness/skill/skill-view.service.ts` | `ensureView` 加 agentId、视图/meta 路径、并发锁键 |
| `harness/skill/skill-sync-service.ts` | `ensureView` 调用传 `agent.id` |
| `harness/terminal/terminal-manager.ts` | `SpawnPtyOptions.agentId` 透传 |
| `session/terminal.routes.ts` | 创建终端传 `session.agentId` |
| `session/session.routes.ts` | PATCH agentId 分支触发切换预热监听器 |
| `session/session.service.ts` | `onAgentSwitched` 可选监听器；`updateSessionAgent` 触发 |
| `session/session.repository.ts` | 新增 `listWorkspacesByUserAndAgent(userId, agentId)` |
| `app-container-runtime.ts` | `sessionWorkspacesOf(userId, agentId)` 回调、心跳预热加 agentId、切换预热监听器实现、`ensureChannelListening`/`issueChannelToken`/`requestShutdown` 回调签名 |
| `app-utils.ts` | `ptyChannelHubs`/`ptyHubGeneration` 复合键、pty factory 穿线 agentId |
| `app-harness-engine.ts` / `create-app.ts` | 装配签名同步（dispatcher 查库兜底依赖、监听器注入） |
| `db/migration/` | **无新增迁移** |

### admin

| 文件 | 改动 |
|---|---|
| `admin/src/views/settings/components/ContainerRebuildPanel.vue` | 表格加"Agent ID"列（容器名列随之含 agent 段），每行加回收按钮（携带 agentId） |
| admin 其他 | 无改动（用户管理页"运行时模式"下拉、经验库管理页均不涉及） |

### 部署脚本

| 文件 | 改动 |
|---|---|
| `scripts/container-gc.sh` | 新增规则：清理**运行中**的旧命名孤儿容器（名称匹配 `mao-user-{纯数字}`、无 `-agent-` 段）；exited/dead 清理规则不变 |

### 不改

desktop、android、`shared/contracts`、agent-cli、`scripts/deploy-*.sh`、`Dockerfile.runtime`（无新依赖）。

### 文档同步（随二期发版同任务完成）

根 `CHANGELOG.md` 顶部新版本"后端""admin"两节；`README.md` / `DEPLOY.md` 容器小节（命名规则、多容器资源说明、切 Agent 行为）；`skills/mao-cli/reference/deploy.md`（容器命名、label、env、gc 说明）；本方案状态改"已确认"。

## 7. 测试要点

**挂载清单**
- 容器 (U, A) 的挂载表：skillViews 恰为 `{views}/{U}/{A}` ro、share 恰为 `{share}/agent-experience/{A}` rw、channel 恰为 `{channel}/{U}/{A}` rw；断言不含其他 userId 尾段、不含其他 agentId 段。
- `assertSafe` 拒绝：share 根整挂、`agent-experience/{其他agentId}`、skillViews 挂到用户根（缺 agentId 段）、agentId 段与入参不一致、符号链接逃逸、只读项覆写（既有用例全保留）。
- `createAndStart` 前视图目录与经验子目录已存在（预热早于首轮同步的场景）。

**生命周期**
- 同用户双 Agent 容器并存：`(U,A)` 与 `(U,B)` 同时 running、socket 各自独立、`withUserLock` 互不阻塞。
- 切 Agent 后首次工具调用路由到新容器，旧容器不受影响；旧容器按 idle 独立回收。
- 指纹漂移重建按复合键各自触发；`recycleUser(userId)` 回收全部、`{agentId}` 只回收单个；busy 跳过语义不变。
- 升级窗口：旧命名容器（`mao-user-{userId}`）不被新 Registry 误认，gc 脚本可清理（名字前缀兼容断言）。

**通道与身份**
- 两容器并发连接同用户 socket 目录树，互不踢；单键第二连接踢旧逻辑保留。
- 伪造对端：容器名与路径 `(userId, agentId)` 任一段不一致即断开。

**派发链路**
- `ToolInvocation.agentId` 从 `context.agentId` 填充（按轮快照断言：轮中 PATCH agentId 后，本轮后续调用仍路由旧容器）。
- `agentId` 缺失走查库兜底；查库仍 null 返回明确工具错误。
- `read_bytes` / `mcpConnect` / `mcpCall` / send 工具 ctx / 终端 pty 全链路 agentId 断言。

**skill 视图**
- 同用户双 Agent 各自物化视图互不可见（目录与 meta 双断言）；并发 `ensureView` 同键串行；指纹变化原子重建。
- skillNames 增删只改目录内容，容器挂载指纹不变（零重建断言）。

**经验库**
- 容器 (U, A) 内读 `agent-experience/{B}/...` 路径不存在；沙箱对经验子目录外路径拒绝。
- 容器内写经验文档 → 索引刷新命中（`refreshIfUnderRoot` 首段校验）；宿主机 admin 读写不受影响。

**功能回归**
- keep_session / 终端 / git clone / `/deps` 持久化 / 读图 / `/tmp` 读写：沿用 2026-10-14 §7 用例口径，断言在新命名容器下全绿。
- host 模式回归：`DockerToolRouter` 短路，行为零变化。
- E2E（host 模式为主）不依赖容器命名，无断言变更。

## 8. 风险与开放问题

1. **升级窗口一次性全量重建**：挂载指纹含新增 agent 维度条目，上线后存量容器首次 `ensureRunning` 全部重建（停→rm→run），与 2026-10-14 上线同款机制；窗口内 in-flight 调用失败、PTY 断。对策：低峰发版，crash-recovery 从 DB 恢复会话（与容器解耦）。
   **旧命名孤儿容器**：升级前已存在的 `mao-user-{userId}` 容器在后端重启后脱离 Registry 管控，运行中的不会被现有 gc 规则（只清 exited/dead）回收。对策：`scripts/container-gc.sh` 新增规则——stop+rm 名称匹配 `mao-user-{纯数字}`（无 `-agent-` 段）的运行中容器；升级后该命名模式必为孤儿，新容器恒含 agent 段，无误伤。
2. **容器数与磁盘增长**：容器数 = Σ(用户 × 使用中的 Agent 数)；stopped 容器只占元数据。决策 6 已接受暂不调资源上限，多 Agent 活跃场景如遇瓶颈随运维再议。
3. **切换预热依赖 PATCH 链路**：切换预热挂在 `updateSessionAgent` 之后的监听器上，若 PATCH 与下一轮执行竞争（切换后立即发消息），预热可能未完成——首轮工具调用落在 `ensureRunning` 上，等价于现状冷启动，可接受。
4. **`MAO_CONTAINER_AGENT_ID` 为容器内硬依赖**：旧镜像 + 新宿主代码的组合会因 env 缺失 exit(1)——镜像与后端同批发布（部署脚本本就同批），`container-gc.sh` 兜底清理半成品。
5. **群聊发言者冷启动**：与现状同粒度（今天发言者首次执行同样冷启动），不新增恶化。
6. **开放问题**：无。6 项决策点已全部拍板（§10）。

## 9. 实现步骤

顺序原则：一期是纯宿主机数据面改造，独立可上线且不影响容器行为；二期一次性切换容器键。每步后跑 `cd backend-ts && npm run build`，一期/二期收尾各跑一次 `cd backend-ts && npm test`（长输出先落盘再 grep 摘要）。

**一期：skill 视图按 (user, agent) 物化**

1. `skill-view.service.ts`：`ensureView` 加 agentId、视图与 meta 路径改 `{userId}/{agentId}`、并发锁键调整；`skill-sync-service.ts` 调用点传 `agent.id`；单测（§7 skill 视节用例）。
2. 构建验证 + 全量测试。此时容器挂的还是旧用户根（新视图目录位于其内），容器内技能链接照常解析——零行为变化，仅数据布局就位。

**二期：容器键与挂载切换**

3. `container-mount-planner.ts`：`plan(userId, agentId, …)` + 三条挂载改路径 + `assertSafe` agentId 段校验 + 审计日志。
4. `container-registry.ts`：复合键/容器名/锁/指纹/`createAndStart`（label、三个 env、mkdir 源目录）/`recycleUser`/`listEntries`。
5. `runtime-channel-server.ts`：连接键/socket 目录/token/peer 校验。
6. 派发链路：`tool-invocation.ts` → `agent-loop.ts` → `tool-dispatcher.ts` → `docker-tool-router.ts` → `read-bytes-bridge.ts` / `routing-mcp-client-manager.ts`（§5.6 全部穿线点）。
7. 终端与 PTY：`terminal.routes.ts` / `terminal-manager.ts` / `app-utils.ts` / `pty-bridge.ts` 复合键。
8. 预热：心跳加 agentId、切换监听器（`session.service.ts` + `app-container-runtime.ts` + `session.routes.ts`）、`session.repository.ts` 新增 `listWorkspacesByUserAndAgent`。
9. `runtime-agent.ts` / `container-tool-executor.ts`：`MAO_CONTAINER_AGENT_ID` 硬依赖、经验沙箱根。
10. admin：`container-admin.routes.ts` VO、`user.routes.ts` recycle body、`ContainerRebuildPanel.vue`。
11. `scripts/container-gc.sh` 旧命名孤儿清理规则 + 全量测试（§7）+ 构建验证。
12. 文档：CHANGELOG、README、DEPLOY、`skills/mao-cli/reference/deploy.md`、本方案状态改"已确认"。

## 10. 已确认决策摘要

下表前 6 项于 2026-11-07 调研对话中逐条拍板（见调研文档 §6.8）；其余为实现层定案，评审时可调。

| # | 决策点 | 结论 | 来源 |
|---|---|---|---|
| 1 | 会话内切 Agent | 接受中断、不禁止；路由按轮快照 + 切换即预热 | 已确认 2026-11-07 |
| 2 | deps/HOME/tmp/workspace | 维持用户级共享 | 已确认 2026-11-07 |
| 3 | userSkills | 不引入 Agent 绑定 | 已确认 2026-11-07 |
| 4 | 群聊 bot 热切换 | 与决策 1 同口径（保持可用、接受中断） | 已确认 2026-11-07 |
| 5 | 容器命名 | `mao-user-{userId}-agent-{agentId}`，gc 前缀兼容 | 已确认 2026-11-07 |
| 6 | 资源上限 | 暂不调整 | 已确认 2026-11-07 |
| 7 | 容器键用户维度 | runtimeUserId（运行身份），沿用现状路由口径 | 本方案定案 |
| 8 | agentId 穿线 | `ToolInvocation` 字段 + 按轮快照 + 查库兜底 | 本方案定案 |
| 9 | skill 视图物化 | `{skillViewsDir}/{userId}/{agentId}/`，挂载路径恒定 | 本方案定案 |
| 10 | 经验库挂载 | 仅挂 `<shareDir>/agent-experience/{agentId}` 子目录 | 本方案定案 |
| 11 | 通道键 | `userId:agentId` 复合键，socket 三级目录 | 本方案定案 |
| 12 | 上线方式 | 两期：宿主机数据面先行，容器键一次性切换 | 本方案定案 |
