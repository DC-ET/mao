# Docker 容器隔离维度从「人」到「人+Agent」的可行性调研

> 状态：调研完成（2026-11-07），仅调研，未改任何代码。方案方向与全部 6 项决策点已于 2026-11-07 对话拍板（见 §6.8 决策记录），调研收口。
> 技术方案：[2026-11-07-user-agent-container-isolation-technical-design.md](../plan/2026-11-07-user-agent-container-isolation-technical-design.md)（已据此方案核实修正本文 §3.4/§8 的群聊路由身份表述）。
> 上游讨论：2026-11-07 与用户的架构对话。
> 核心前置：[2026-10-14-user-runtime-container-isolation-design.md](../plan/2026-10-14-user-runtime-container-isolation-design.md)（当前按用户隔离容器的设计）、[2026-10-24-agent-experience-library-technical-design.md](../plan/2026-10-24-agent-experience-library-technical-design.md)（团队经验库）、[2026-10-21-shared-directory-technical-design.md](../plan/2026-10-21-shared-directory-technical-design.md)（share 目录）、[2026-10-29-in-session-agent-switch-technical-design.md](../plan/2026-10-29-in-session-agent-switch-technical-design.md)（会话内切换 Agent，已实施）。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| 提案的动机是否成立 | **成立**。skill 与团队经验在「容器挂载面」上确实是用户全集，容器内 Agent 可以绕过软链直读其他 Agent 的技能视图与经验库（甚至可写他人经验库）。但需注意：**会话可见面**（软链 + 提示词白名单）今天是收窄的，现状是"挂载面 > 可见面"，靠提示词约束兜底 |
| 技术可行性 | **可行，无不可逾越的障碍**。DB 无容器表、宿主机数据布局无需迁移；改造集中在 `harness/container/` 生命周期与通道层 + 派发链路穿线 + admin 管理面 |
| 历史数据兼容性 | **好**。无 DB 迁移；存量容器升级后自动按新键重建（漂移重建机制现成）；经验库天然按 agentId 分目录；skill 视图是可再生物理副本，重组不算迁移 |
| 最大代价 | **会话内切换 Agent（已实施功能）的体验回归**：切 Agent = 中途换容器，keep_session shell、pty 终端、async 后台任务跨轮持久状态失效——**已拍板接受（2026-11-07，见 §6.1 决策记录）** |
| 影响面 | 后端约 15~20 个文件的结构性改动（集中在 `harness/container/` 与派发/终端链路）+ admin 1~2 个视图；desktop/android/agent-cli 零改动 |
| 建议 | 若目标是容器级 Agent 隔离，推荐「(userId, agentId) 粒度 + Agent 维度物化目录」形态（挂载路径恒定，skillNames 变化不触发容器重建，见 §7.1）；方案方向与全部 6 项决策点已于 2026-11-07 拍板（见 §6.8 决策记录），调研收口 |

---

## 1. 背景与调研目标

当前 docker 模式下容器按「人」维度创建和复用（`mao-user-{userId}`，一人一容器）。提案：改为「人 + Agent」联合维度，动机是 Agent 之间的数据隔离——

1. **Skill**：每个 Agent 关联的 skill 不同，同一用户的多个 Agent 共用一容器时，容器内能读到其他 Agent 的 skill；
2. **团队经验**：经验库挂在 Agent 维度（`<shareDir>/agent-experience/<agentId>/`），同理需要按 Agent 隔离。

本调研回答三个问题：① 历史数据兼容性；② 改造对现有功能的影响面；③ 未考虑到的使用场景与潜在风险。

**先交代一个时间线事实**：容器粒度「每用户一个」是 2026-10-14 容器隔离方案拍板的（该方案决策 3，理由是 `users/{userId}` 与 git 凭据都是用户级）。而 Agent 维度的数据——团队经验库（2026-10-24）、共享目录（2026-10-21）——是**之后**才出现的。也就是说，「人维度容器」的决策先于 Agent 维度数据的诞生，Agent 级数据被后置叠加到了用户维度的容器上，才形成今天的不匹配。提案本质上是对新数据类型补齐隔离维度，方向上与原设计不矛盾。

---

## 2. 现状机制核查（代码事实）

### 2.1 容器标识与生命周期：纯 userId 维度

| 事项 | 现状 | 证据 |
|---|---|---|
| 容器名 | `mao-user-{userId}`，唯一构造入口 | `container-registry.ts:235-237` |
| 注册表 | `entries = new Map<number, ContainerEntry>`，按 userId 键 | `container-registry.ts:190` |
| 生命周期锁 | `withUserLock` 按用户串行（创建/重启/回收） | `container-registry.ts:413-429` |
| docker label | `mao.runtime=user`、`mao.user={userId}` | `container-registry.ts:730-731` |
| 通道连接 | `connections = new Map<number, ConnectionImpl>`，**每用户仅一条**容器连接，第二连接踢掉旧连接 | `runtime-channel-server.ts:67,118` |
| socket 路径 | `{channelDir}/{userId}/runtime.sock` | `runtime-channel-server.ts:41-42` |
| 身份校验 | `SO_PEERCRED` 取对端 PID 反查容器名 `mao-user-{userId}` | 设计文档 §5.4 |
| 回收 | idle（默认 60min）/ lifetime（默认 72h）只 stop 不 rm；busy（活跃 shell/在途任务/attach 终端）不回收 | `container-registry.ts:665-689` |
| 运维 | gc 脚本按 `mao-user-*` 名字前缀清理；admin 面板按用户列容器；`POST /v1/users/:id/container/recycle` 按用户重建 | `scripts/container-gc.sh:18`、`admin/src/views/settings/components/ContainerRebuildPanel.vue` |

**容器创建参数里没有任何 Agent 维度的东西**：env（HOME、workspace/runtime/userskills/uploads/share 等路径、`MAO_CHANNEL_TOKEN`）、资源限制、网络全部只与 userId/全局有关。Agent 相关数据（gitTokens、MAO_TOKEN、ECP、经验路标等）不进 `docker run`，而是每次工具调用经 `SessionEnvelopeBuilder` 动态下发（`session-envelope-builder.ts:46-124`）。

### 2.2 Skill 的三层结构与「挂载面 vs 可见面」

```
技能源 skillsDir（/opt/mao/data/skills，全局平铺）          ← 不进容器（G1/G2 决策）
     ↓ ensureView 按需物化（指纹变化即原子重建）
技能视图 skillViews/{userId}/{skillName}/                    ← 整根 ro 挂进容器（按用户）
用户技能 userskills/{userId}/{skillName}/                    ← 整根 rw 挂进容器（按用户）
     ↓ syncToSession 每轮软链（agent.skillNames + 用户全部个人技能）
会话目录 runtime/{userId}/{sessionId}/skills/{skillName}     ← runtime/{userId} 整根 rw 挂进容器
```

- Agent→skill 关联只存 DB `agent.skill_names`（JSON 数组，`agent/types.ts:12`）。
- 会话可见集 = 当前 Agent 的 skillNames ∪ 该用户全部个人技能（`skill-sync-service.ts:25-106`），逐个软链进会话目录；同步失败的从提示清单剔除。
- **挂载面是用户全集**：容器挂的是整个 `skillViews/{userId}`（ro）与 `userskills/{userId}`（rw），与当前会话用哪个 Agent 无关（`container-mount-planner.ts:95,109`）。
- 提示词层兜底：`prompt-engine.ts:466-471` 明确告知模型"环境中还存在未对你开放的技能（可能属于其他租户）"。

### 2.3 团队经验的双轨机制

| 轨道 | 存储 | 注入方式 | Agent 维度 |
|---|---|---|---|
| 短经验（≤300 字） | DB `agent_experience` 表 | 每轮 `listEnabledContents(agent.id)` 拼进上下文（`harness-service.ts:398`） | ✅ 天然按 agentId，纯内存注入，**与容器无关** |
| 经验库（长文档 + INDEX.md） | 文件系统 `<shareDir>/agent-experience/<agentId>/` | 工作区符号链接 `团队经验` → 库目录（`experience-mount.service.ts:27-40`），每轮按当前 agentId 幂等重挂（`harness-service.ts:412`） | ✅ 目录按 agentId 分 |

关键点：**`shareDir` 整根以 rw 挂进每个容器**（`container-mount-planner.ts:105`）。软链只是把"当前 Agent 的库目录"放到工作区显眼位置，容器内 root 沿 `/opt/mao-data/share/agent-experience/` 可直读**任何 Agent** 的经验文档，也可以直写（索引服务甚至专门处理了"容器内进程与宿主进程并发重建索引"的一致性问题，`experience-index.service.ts:22-28` 注释）。同样，`runtime/{userId}` 整根挂载意味着其他会话的 skills 软链（目标 `skillViews/{uid}/{name}` 已在挂载面内）在容器内可解析可读。

### 2.4 结论：提案动机核查

- **"每个 Agent 都可能读到其他 Agent 的 skill"** —— 在容器挂载面层面**成立**（视图根 + runtime 根 + 用户技能根均为用户全集），但会话可见面（软链 + 提示词白名单）今天是收窄的。现状的隔离强度 = "提示词约束 + 软链收口"，不是物理隔离；对**行为混淆**（模型误用他人技能）有防护，对**主动越读**（模型被诱导/注入后越界读取）无效。
- **"团队经验需要按 Agent 隔离"** —— 成立且更严重：不止可读，**rw 挂载下容器内 Agent 可写其他 Agent 的经验库**（软链收口只防误写不防故意写）。
- 另需明确：这里隔离的是**同一用户的不同 Agent 之间**，属"行为/正确性隔离"，不是 2026-10-14 方案解决的"跨用户安全隔离"——同用户的所有 Agent 本就同属一个用户。但 prompt 注入场景下，弱信任 Agent 横向收集其他 Agent 的技能内容与经验，仍有真实的泄露面。

---

## 3. 改为 (userId, agentId) 粒度的五个核心冲突点

### 3.1 冲突一：会话内切换 Agent（最大功能回归）⛔

`PATCH /v1/sessions/:id` 已支持 `agentId`（`session.routes.ts:430`、`session.service.ts:1606`），设计语义是"下一轮零成本生效——系统提示词/工具集/MCP 工作集/经验库路标每轮按当前 agentId 重建，AgentLoop/压缩/审批零改动"（会话内切换方案 §1.1）。经验库挂载正是靠"每轮按当前 agentId 幂等重挂软链"实现无缝切换（`harness-service.ts:412`）。

改为 (user, agent) 容器后，切 Agent = **中途换执行容器**：

- `keep_session` 持久 shell 会话全断（容器内进程内存态，`docker stop/start` 都不恢复）；
- pty 终端断连（attach 中的终端还是容器 idle 豁免条件）；
- `shell async:true` 后台任务丢失，宿主机 `await_async` 拿到"任务不存在"；
- 挂载在 `docker run` 时定型，新容器的挂载集要按新 Agent 重建，冷启动 1~3s。

这不是实现细节，是**产品语义倒退**：需要决策"禁止运行中切换 / 切换时明确告警接受中断 / 保持旧语义（那就得回退到用户维度容器）"三选一。**这一点的答案直接决定方案是否成立。**

### 3.2 冲突二：挂载在 docker run 时定型，Agent 配置是可变的

容器挂载集创建时固化，运行中无法新增（设计文档 §5.1 通道工作区条目注释）。Agent 维度引入两类可变挂载源：

1. `agent.skill_names` 可被 admin/用户编辑 → 按 skillNames 收窄挂载的方案会在每次编辑后触发挂载漂移 → 整容器重建（现有 `standardMountsFingerprint` 漂移机制，`container-registry.ts:467-469`）；
2. 群聊 IM 的 bot.agentId 支持热切换（`feishu-session.ts:42-56`），切 bot 配置即切会话 Agent → 同冲突一。

**化解方向**（推荐）：把"挂载集随 skillNames 变化"转化为"宿主机目录内容维护"——视图按 Agent 维度物化为固定路径 `{skillViewsDir}/{userId}/{agentId}/{skillName}`，容器只挂这个恒定路径（ro）。skillNames 增删只让宿主机重建该目录内容，容器透过 ro 挂载即时可见，**零容器重建**。经验库天然已是固定路径 `<shareDir>/agent-experience/{agentId}`，直接从"整根"改为"只挂子目录"即可。

### 3.3 冲突三：通道层、终端层的"每用户单例"假设

以下结构全部按 userId 键控，多容器/用户后将互相冲突，需改为 (userId, agentId) 复合键：

| 结构 | 现状 | 冲突表现 |
|---|---|---|
| `RuntimeChannelServer.connections` | `Map<userId>`，第二连接**踢掉旧连接**（`runtime-channel-server.ts:67`） | 同用户两个 Agent 容器同时连一个 socket，互踢死循环 |
| socket 目录 | `{channelDir}/{userId}/runtime.sock` | 两容器共用同一 socket 文件 |
| `SO_PEERCRED` 校验 | 反查容器名 `mao-user-{userId}` 与路径 userId 比对 | 容器名规则变化后校验逻辑要同步 |
| `ptyChannelHubs` | `Map<number, PtyChannelHub>` 按 userId（`app-utils.ts:136-141`），按 `startedAtMs` 世代失效 | 终端通道归属哪个容器变得含糊 |
| 容器 env | `MAO_CHANNEL_TOKEN` 每容器一份 | 需按复合键签发 |

### 3.4 冲突四：派发链路没有 agentId

`DockerDispatchContext = { userId, sessionId, workspace }`（`docker-tool-router.ts:27-31`）；`dispatchFullOutcome` 是十参位置签名（`tool-dispatcher.ts:273-285`），全链路（AgentLoop → ToolDispatcher → DockerToolRouter）均未携带 agentId。两种补法：

- **穿线**：改位置签名链——项目内已有"位置签名强转无编译期保护"的高危认知（见会话内切换方案 §4.3 对 `open-run.service.ts` 的护栏注释），改动面大且易错；
- **按 sessionId 查会话**：docker 路由入口查一次 `session.agentId`（每工具调用多一次查库），改动面小。注意会话 Agent 可中途切换，**不能缓存**，或接受短 TTL。

另有一个身份模型事实（**2026-11-07 写技术方案时核实修正**）：容器路由用的是**运行身份 runtimeUserId（发言者）**而非会话归属 owner——`tool-dispatcher.ts:291` `runtimeUserId = runtimeIdentity ?? executionUserId ?? userId`、`:398` `routeUserId = runtimeUserId`（初稿此处写"容器路由用 owner"，系调研子代理误报，已勘误）。技能同步（`syncToSession(agent, runtimeUserId, …)`）、envelope（`runtime/{runtimeUserId}/{sid}`）、容器路由三者在群聊下本来就统一按发言者寻址，因此加入 agent 维度后身份模型仍是"双轨 + 一维"：容器键 = (runtimeUserId, session.agentId)，与技能物化口径天然一致，不存在"三轨缝合"问题。MCP 凭据绑 owner 的 known gap（`harness-service.ts:463-467`）与本方案正交，维持现状。

### 3.5 冲突五：管理、预热、回收、运维全按 userId

- 预热：`SessionActivityHeartbeat` → `ensureRunning(session.userId, …)`（`app-container-runtime.ts:208`），需改为按会话的 (userId, agentId) 预热，并防止"打开客户端预热其全部 Agent 容器"的放大；
- 回收：`recycleUser(userId)`（`container-registry.ts:327`）与 `POST /v1/users/:id/container/recycle` 语义变为"回收该用户哪个 Agent 的容器"；
- admin 面板：`ContainerRebuildPanel.vue` 表格列即"用户 ID / 容器名"，需加 Agent 维度；
- gc 脚本：`scripts/container-gc.sh:18` 按名字前缀 `mao-user-` 清理——新命名保持该前缀（如 `mao-user-{userId}-agent-{agentId}`）则脚本免改；
- 资源：容器数从 N（用户数）变为 Σ(用户 × 其使用中的 Agent 数)。stopped 容器不耗内存/CPU（只占磁盘元数据），**同时活跃**多 Agent 的用户内存按 2G/容器倍增；冷启动窗口数量倍增。

---

## 4. 历史数据兼容性评估

| 数据 | 结论 | 说明 |
|---|---|---|
| DB | **零迁移** | 容器状态全在 `ContainerRegistry` 内存 + docker labels，**没有容器元数据表**（全部迁移中仅 `system_setting` 三项与 `container:manage` 权限和容器相关，V176/V177/V178）。`user.runtime_mode`、`session`、`agent.skill_names`、经验表均不受容器粒度影响 |
| 存量容器 | **自动过渡，无手工迁移** | 升级后 entries 为空，首次 `ensureRunning` 按新键建新容器；旧 `mao-user-*` 容器由 gc 脚本兜底清理（保持前缀命名即可）；挂载指纹漂移重建机制现成，新键条目天然走完整重建 |
| 经验库文件 | **零迁移** | `<shareDir>/agent-experience/<agentId>/` 布局不变，只是容器挂载从"整根"改为"子目录"；INDEX.md 与子文档不动 |
| skill 视图 | **可再生，不算迁移** | 视图本就是源技能的按需物化副本（指纹变化即原子重建，`skill-view.service.ts:109-194`）。若重组为 `{skillViewsDir}/{userId}/{agentId}/`，旧视图目录惰性废弃或一次性重建即可；也可不改布局、按 skillNames 枚举挂载（不推荐，见 §3.2） |
| 用户数据目录（workspace/runtime/users/deps/uploads/tmp） | **布局不变，继续按用户挂载** | 这些是用户级数据，跨该用户的 Agent 容器共享挂载即可；Docker 多容器 bind mount 同一宿主目录在 FS 层无问题（今天同一容器内多会话本就并发访问） |
| 升级窗口在途会话 | 与历次后端重启一致 | crash-recovery 从 DB 恢复（`crash-recovery-runner.ts`），与容器完全解耦 |

**总体**：历史数据兼容性是本方案最不需要担心的部分。

---

## 5. 改造影响面评估

### 5.1 后端 backend-ts（核心工作量）

| 模块 | 改动 | 量级 |
|---|---|---|
| `container-registry.ts` | 键/名/锁/指纹/回收/listEntries 全部改复合键；`withUserLock` 粒度 | 大 |
| `container-mount-planner.ts` | 经验子目录挂载、agent 级视图目录挂载、`assertSafe` 新规则（rw 项含 `/{userId}/` 段的校验要为 agentId 段扩展；share 豁免从"恰为根"改为"恰为 agentId 子目录"） | 中 |
| `runtime-channel-server.ts` | 连接键、socket 路径 `{channelDir}/{userId}/{agentId}/`、身份校验 | 中 |
| `docker-tool-router.ts` / `tool-dispatcher.ts` | `DockerDispatchContext` 加 agentId；按 sessionId 查或穿线 | 中 |
| `app-utils.ts`（pty factory）/ `pty-bridge.ts` | `ptyChannelHubs` 复合键 | 小 |
| `app-container-runtime.ts` | 预热按 (userId, agentId) | 小 |
| `session-envelope-builder.ts` / `runtime-agent.ts` / `container-tool-executor.ts` | 容器内沙箱允许根来自 `MAO_SKILL_VIEWS_DIR` 等 env（`runtime-agent.ts:44-47`），env 指向变化后两侧口径要对齐 | 中 |
| 终端链路 `terminal-manager.ts` / `remote-terminal.ts` | `(sessionId, userId)` 二元组加 agent 维度归属 | 小 |
| MCP `routing-mcp-client-manager.ts` / `container-mcp-bridge.ts` | 连接生命周期按会话（现状），随容器键变化适配 | 小 |
| 会话内切换 `updateSessionAgent` | 切换时容器处置（见 §6.1 决策） | 取决于决策 |
| admin 路由 `container-admin.routes.ts` / `user.routes.ts` | 列表与 recycle 加 Agent 维度 | 小 |

### 5.2 其他端

| 端 | 影响 |
|---|---|
| desktop / Web / android | **零改动**。CLOUD 服务端执行，前端不感知容器粒度（LOCAL 桌面执行与容器无关，本就不受影响） |
| admin | `ContainerRebuildPanel.vue`（列表列 + 重建按钮语义）、可选的 hosts 面板文案 |
| agent-cli / mao-cli | 不涉及 |
| 部署脚本 | `container-gc.sh` 若保持 `mao-user-` 前缀则免改；`deploy-*.sh` / restart 不变 |

### 5.3 资源与体验

- 容器数量：N 用户 → Σ(用户 × 活跃 Agent 数)。以默认 2G 内存/容器计，"同时活跃跑两个 Agent"的用户峰值 4G+；空闲容器 stop 态只占磁盘。
- 冷启动：首次用到某 (user, agent) 组合时 1~3s；预热可覆盖大部分，但预热目标数×Agent。
- idle/lifetime 回收逻辑不变，只是判定对象变多（`startIdleLoop` 遍历 entries，量级无碍）。

### 5.4 测试面

- `container-registry.spec.ts` / `container-mount-planner.spec.ts` / `runtime-mode.spec.ts` / `runtime-agent.spec.ts` 等容器 spec 全量补复合键用例；
- 挂载安全回归：新 assertSafe 规则的正反用例（agentId 段校验、经验子目录越权、视图目录逃逸）；
- 会话内切 Agent 的容器处置回归（按 §6.1 决策结果定用例）；
- E2E（host 模式为主）基本不受影响。

---

## 6. 未考虑到的使用场景与潜在风险

### 6.1 会话内切换 Agent 的处置（最大风险，前述 §3.1）

**现状为什么零成本**：后端 PATCH 已实施（`session.routes.ts:430`、`session.service.ts:1606`），桌面端 `AgentSwitcher.vue` 已落地。切换无感靠三个每轮重建机制——系统提示词/工具集/MCP 每轮按当前 agentId 重建、经验软链每轮幂等重挂（`harness-service.ts:412`）、技能每轮重同步；且容器路由只看 userId（`docker-tool-router.ts:83`），换 Agent 不换执行容器。

**切换时机核实（2026-11-07 追问澄清）**：切换**不限于空闲态**——后端 `updateSessionAgent` 无任何相位校验，前端 `canSwitchAgent`（`TaskInspector.vue:476`）仅按视图类型判断，"运行中可切、下一轮生效"是设计文档明确的产品语义。且即使限制为空闲切换，下表三样东西都是**跨轮次持久**的，照样断裂——"空闲"只保证不打断当前轮。仅当会话从未用过 keep_session / 终端 / async 后台任务时，切换才真正无感（只剩冷启动）。因此 docker 模式选"禁止"实质是**收窄已发布能力**，决策时须计入；"空闲切 + 明示持久状态失效 + 切换即预热"（选项 b+c）是可用的折中。

**新形态下切换 = 该会话的执行容器从 (U,A) 换到 (U,B)**，三层东西断在旧容器里：

| 断裂点 | 机制 | 表现 |
|---|---|---|
| 持久 shell（keep_session） | shell 会话表在容器内 runtime-agent 进程内存，按 sessionId 键控；新容器没有该会话 | 旧 session_id 报"会话不存在"；旧 bash 进程在 (U,A) 沦为孤儿（存活至容器内 shell 空闲超时或容器回收） |
| 终端（pty） | PTY 进程在 (U,A)，无迁移机制 | 分裂脑：工具调用在 (U,B)、还开着的终端连在 (U,A)，进程空间/env/deps 已是两个世界 |
| async 后台任务 | 任务表在容器内存 | `await_async` 路由到 (U,B) 报"任务不存在" |

**实现注意**：容器路由的 agentId 必须**按轮快照**（buildContext 时定、整轮不变），不能每次工具调用现读 `session.agentId`——否则轮中切换会出现"半轮 A 半轮 B"的分裂。按轮快照恰好与现有"下一轮生效"语义对齐。

**处置选项**：

| 选项 | 做法 | 代价 |
|---|---|---|
| a. 禁止 + 引导重开（推荐） | docker 模式下 PATCH agentId 拒绝/前端禁用入口，引导"用其他 Agent 重开"（P2 已有：新会话 + 同 workspace + 接手说明，天然走新容器） | 放弃原地切换；host 模式不受影响保持现状 |
| b. 接受中断 | 确认弹层明示"持久 shell/终端/后台任务将失效"，旧 session_id 报错文案引导重建 shell | 实现最小，体验有坑 |
| c. b + 切换即预热 | PATCH 成功后立即 `ensureRunning(U, 新agent)` 消冷启动 | 解决不了 shell 断裂 |
| d. 会话粘住容器 | 会话记住自己的容器 | 退化为会话级容器（已否决），隔离语义混乱 |

**决策记录（2026-11-07 已拍板）**：选**选项 b——不禁止切换、接受中断**，不收窄"运行中可切"的已发布语义。落定后的完整行为链：

| 时机 | 行为 |
|---|---|
| 运行中切换（轮中） | 当前轮不受影响——路由 agentId **按轮快照**，本轮剩余工具调用仍在旧容器执行（与"下一轮生效"既有语义对齐；不得每次工具调用现读 session.agentId，否则半轮 A 半轮 B） |
| 下一轮开始 | 路由到新容器 (U,B)；首次使用冷启动 1~3s，**建议附带"切换即预热"**（PATCH 成功后立即 ensureRunning 新容器）消掉 |
| 旧 keep_session shell | 下一轮用旧 session_id 报"会话不存在"，报错文案引导重建 shell；旧 bash 进程在旧容器活到 shell 空闲超时/容器回收 |
| 已 attach 终端 | 随旧容器继续存活（分裂脑窗口：终端在旧容器、工具调用在新容器），直到用户关闭或旧容器回收——接受，不主动杀 |
| async 后台任务 | 在旧容器继续跑成孤儿；之后的 await_async 报"任务不存在" |

### 6.2 群聊 IM 的 bot.agentId 热切换
飞书/钉钉 bot 配置变更会热切换既有群会话的 agentId（`feishu-session.ts:42-56`）→ 等效于会话中途换 Agent，同 §6.1 风险，且群聊场景用户无感知，容易踩。需要与 §6.1 同一口径处置。

### 6.3 隔离边界是 (user, agent)，不是会话
同一用户同一 Agent 的多个会话仍共享一个容器：`runtime/{userId}` 整根挂载下，Agent A 的会话 1 仍能读会话 2 的 shellOutput、skills 副本等。若动机里含"会话间隔离"，本方案达不到；那需要会话级容器（2026-10-14 已因启动开销否决）。建议在方案文档里明确写出"本方案的隔离承诺边界"。

### 6.4 用户级共享数据的归属决策
以下目录天然是用户级，(user, agent) 容器粒度下默认继续共享挂载。**已拍板（2026-11-07）：全部维持用户级共享、userSkills 不引入 Agent 绑定（见 §6.8 决策 2/3）**：

| 目录 | 共享的含义 | 风险 |
|---|---|---|
| `deps/{userId}` | agent1 `npm i -g` 装的 CLI，agent2 也能用 | 是否接受？拆分则磁盘×Agent、体验割裂 |
| `users/{userId}`（HOME） | `.gitconfig`、`.npmrc` 凭据跨 Agent 共享 | 与 git 凭据"用户级"的原设计一致，建议保持 |
| `{tmpDir}/{userId}`（容器 /tmp） | agent 间临时文件互见 | 若要隔离需 per-(user,agent) tmpfs/目录，挂载规则再+1 |
| `userSkills/{userId}` | 用户个人技能设计上对所有 Agent 开放（`skill-sync-service.ts:38-48` merge 逻辑） | 是否要给个人技能加 Agent 绑定是**产品决策**；不绑定则该面保持共享 |
| workspace（含 (userId, slug) 项目工作区） | 同用户不同 Agent 的会话可共享同一项目检出（重开功能就依赖这个） | AGENTS.md 等工作区规则跨 Agent 共享；并发写无互斥（今天亦然） |

### 6.5 群聊工作区 × 容器私有性的语义交叉
群聊工作区 `{workspaceRoot}/feishu-chat|dingtalk-chat/{accountId}/{leaf}` 按 DB user_id 挂进各自 owner 的容器。改复合键后，同一群会话（owner 固定）挂在 (owner, bot.agentId) 容器；bot 切 Agent 即换容器，但群工作区不变——"工作区跨容器共享、容器内其他数据隔离"的语义要在挂载校验（`container-mount-planner.ts:155-180` 归属校验）里保持住。

### 6.6 管理员代跑（allowNonOwner）
定时任务支持管理员代跑（`scheduled-task.service.ts:871,1642-1647`）：owner 容器 + 发起者/任务者身份组合已经双轨，加 Agent 维度后要重新核对"代跑会话的容器键取谁"（应仍取 session.userId + session.agentId，即 owner 维度，与现状容器路由口径一致）。

### 6.7 容器重建的触发点与爆炸半径
挂载在 docker run 时定型，新形态下容器重建的触发点收敛为三类：

1. **新通道工作区首挂**：飞书/钉钉新群工作区首次纳入挂载时（继承 2026-10-14 设计 §5.1 的既定代价）。现状机制：新群首条消息建会话 → 首次工具调用 → `ensureWorkspaceMounted` 发现 running 容器未挂该目录 → `rebuildEntry`（force stop → rm → run，增量并入旧工作区，`container-registry.ts:545-576`）；停止态容器在 start 前先查 `hasUnmountedWorkspace` 直接重建（`:381-391`）。重建瞬间容器内所有会话的 in-flight 调用失败、PTY 断、shell 丢。触发频率 = bot 覆盖增长（每个新群/新私聊用户一个新工作区；web 会话工作区在每用户根下始终已挂载，不触发）。
   **新形态下爆炸半径取决于通道挂载的过滤维度**：按 (user, agent) 过滤（只挂该用户该 Agent 会话的工作区）时，新群只影响服务它的 (owner, bot.agent) 容器——容器不存在则直接新建、不发生重建，比今天更精准；保持按 user 过滤时，该用户每个 Agent 容器各重建一次，放大 N 倍。**推荐前者**。群工作区跨用户共享的既有语义与 agent 过滤不冲突；bot 热切换 agentId 使群会话跨容器搬家，等效 §6.1 场景，需同一口径处置；缓解：入站消息建会话时即预热目标容器、沿用现状重建期报错口径；
2. **会话内切换 Agent**：被切换的会话从容器 (U,A) 搬到 (U,B)，其 shell/终端随旧容器内存态丢失（§6.1）——只影响被切换的会话本身；
3. 挂载规则版本升级 / docker run 参数指纹漂移（继承现有 `standardMountsFingerprint` 机制）。

**勘误（2026-11-07 评审对话）**：初稿曾写"用户首次使用新 Agent 会触发旧容器重建、殃及其他 Agent 会话"——不成立。(user, agent) 形态下首次使用新 Agent 是**新建**容器 (U,B)，旧容器 (U,A) 不受影响。恰恰相反，新形态把重建的爆炸半径从今天用户维度容器的"该用户全部会话的 shell/终端"缩小到"单个 Agent 容器内的会话"，是改善而非恶化。技能源更新、admin 编辑 skill_names 在物化目录形态下只改宿主机目录内容（容器 ro 即见），不触发任何重建。

### 6.8 决策点清单（全部已拍板，2026-11-07 对话）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 会话内切 Agent 的处置（§6.1） | 接受中断、不禁止切换；路由 agentId 按轮快照 + 切换即预热（详见 §6.1 决策记录） |
| 2 | deps/HOME/tmp/workspace 归属（§6.4） | **维持用户级共享**，不随 Agent 拆分 |
| 3 | userSkills 是否引入 Agent 绑定（§6.4） | **不引入**，保持"用户个人技能对所有 Agent 开放"的现有产品语义 |
| 4 | 群聊 bot 热切换口径（§6.2） | 与决策点 1 **同口径类推**：热切换保持可用、接受中断 |
| 5 | 容器命名与 gc 约定 | `mao-user-{userId}-agent-{agentId}`，保持 `mao-user-` 前缀使 `scripts/container-gc.sh` 免改 |
| 6 | 资源上限 | **暂不调整**，沿用默认 2G/容器、2CPU；多 Agent 活跃场景如遇瓶颈随技术方案/运维再议 |

---

## 7. 方案对比与建议

### 7.1 候选形态

| 方案 | 内容 | Agent 隔离 | 代价 | 判定 |
|---|---|---|---|---|
| **A. (userId, agentId) 粒度**（提案） | 容器键改复合；skill 视图按 Agent 物化成恒定路径；经验库只挂当前 Agent 子目录；通道/预热/管理面全量改复合键 | 容器级，除用户级共享目录外彻底 | §3 五个冲突点全要解；切 Agent 回归；容器数×Agent | 可行，改动大但路径清晰。额外收益（2026-11-07 追问补充）：① 重建爆炸半径从"该用户全部会话"缩到"单 Agent 会话"；② **资源隔离**——今天同用户所有 Agent 共享单容器的 2G/2CPU，一个 Agent 失控会拖累其他 Agent，拆开后各有独立上限 |
| B. 保持用户容器 + 数据面收窄 | 不改容器粒度，试图通过软链/拷贝收窄可见面 | **达不成容器级隔离**：skillViews 根、runtime 根、share 根仍整根进容器；把技能软链改实体拷贝只是消除 skillViews 根依赖，容器内其他会话副本仍互见；经验库因"容器内直写 + 双端一致性"设计，实体副本方案会引入双写一致性问题 | 小 | 只能作为过渡缓解，不满足提案目标 |
| C. A 的按需灰度版 | 仅对"多 Agent 且需要隔离"的用户/Agent 启用复合键，两套键并存 | 同 A | 双键并存期间代码分叉、心智负担 | 可作为上线策略，不宜作为长期形态 |
| D. 会话级容器 | 每会话一容器 | 最彻底 | 2026-10-14 已否决（启动开销、shell 会话难复用） | 维持否决 |

**对"旧方案是否合理"的定性**：2026-10-14 拍板"每用户一容器"时，经验库/共享目录尚不存在，当时的数据布局（users/workspace/runtime）确实全是用户级，该决策对当时是最优解；是后来新增的 Agent 维度数据让它过时了。另需澄清：新形态下**大多数挂载仍是 user 维度**（workspace/runtime/HOME/deps/uploads），仅 skill 视图与经验库两处变为 agent 维度——容器键是 (user, agent)，挂载清单是两者的函数。

### 7.2 建议

1. **若立项，采用形态 A**，其中两个关键形态选择直接决定改造质量：
   - skill 视图走 **Agent 维度物化目录**（`{skillViewsDir}/{userId}/{agentId}/`，宿主机按 skillNames 维护内容），挂载路径恒定，skillNames 增删/技能源更新都只是宿主机目录内容变化，容器 ro 即见，**零容器重建**（规避 §3.2/§6.7 的重建风暴）；
   - 经验库挂载从 `shareDir` 整根收窄为 `shareDir/agent-experience/{agentId}` 子目录（固定路径，天然适配挂载定型约束）。
2. **切 Agent 口径（已拍板，取代初稿建议的"拒绝切换"）**：接受中断、不禁止，路由按轮快照 + 切换即预热（详见 §6.1 决策记录）；host 模式不受影响保持现状。
3. **分期路径**（若立项后细化）：① 数据面先行——Agent 维度物化目录 + 经验子目录挂载（在现有用户容器上即可先实现"挂载路径恒定"的铺垫，但不产生隔离收益）；② 容器键切换 + 通道层复合键（一次性，灰度靠 `user.runtime_mode` 类比新增用户级开关）；③ admin 面板与运维收尾。
4. **明确写进方案文档的隔离承诺**：隔离的是同用户跨 Agent 的 skill 视图与团队经验库；deps/HOME/tmp/workspace/userSkills 维持用户级共享（决策点 2/3，2026-11-07 拍板）；不承诺会话间隔离。

---

## 8. 调研过程中的关键代码索引

| 事实 | 位置 |
|---|---|
| 容器名构造 `mao-user-{userId}` | `backend-ts/src/harness/container/container-registry.ts:235-237` |
| entries 按用户键控 / withUserLock | `container-registry.ts:190` / `:413-429` |
| 挂载清单（skillViews ro / userSkills rw / share 整根 rw） | `container-mount-planner.ts:95,105,109` |
| skill 会话同步（agentNames + 用户技能 merge → 软链） | `backend-ts/src/harness/skill/skill-sync-service.ts:25-106` |
| 提示词"未开放技能"兜底 | `backend-ts/src/harness/core/prompt-engine.ts:466-471` |
| 经验库目录 `<shareDir>/agent-experience/<agentId>` | `backend-ts/src/harness/experience/experience-index.service.ts:7-8` |
| 经验软链挂载（每轮幂等重挂） | `experience-mount.service.ts:27-40`、`harness-service.ts:412` |
| 通道连接 Map\<userId\>（第二连接踢旧） | `runtime-channel-server.ts:67` |
| 派发上下文无 agentId | `docker-tool-router.ts:27-31`、`tool-dispatcher.ts:403-406` |
| 会话内切换 Agent（已实施） | `session.routes.ts:430`、`session.service.ts:1606` |
| 预热按 userId | `app-container-runtime.ts:208` |
| ptyChannelHubs 按 userId | `app-utils.ts:136-141` |
| 群聊运行身份（容器路由/技能/envelope 均按 runtimeUserId=发言者；勘误：初稿误写"容器路由用 owner"） | `tool-dispatcher.ts:291,398`、`harness-service.ts:113-121` |
| 长期记忆为 DB 注入（不受容器粒度影响） | `harness-service.ts:713-721` |
| 容器无 DB 表（状态全内存） | 全部 Flyway 迁移核查；`container-registry.ts:33,90` |
