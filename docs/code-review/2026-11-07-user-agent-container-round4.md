# 人+Agent 维度容器隔离 round-4 审查报告（决策 13 回退后）

> 日期：2026-11-07
> 审查对象：worktree `.worktrees/ua-share-keep`（分支 `fix/keep-share-root-rw`），功能整体 `git diff d14f4d84..b2df53ba`，重点回退提交 `b2df53ba`（决策 13：share 恢复整根 rw）。本子代理从头独立审查，不依赖 round 1-3 结论。
> 验证方式：`npm run build` 通过（tsc + runtime-build manifest）；定向跑 11 个相关 spec 文件（container-mount-planner / container-tool-executor / container-registry / runtime-agent / read-bytes-bridge / docker-tool-router / tool-dispatcher / shell-session-tool / skill-view.service / skill-view.service.race.bugcheck / skill-sync-service）共 238 用例全绿；assertSafe 组合面经代码逐规则推演 + 与既有 spec 断言交叉核对（未改仓库任何文件）。
> 结论：**功能代码无 bug，可收敛**；另附 **2 项文档残留**（评审要求 g 范围，非运行时缺陷）。

---

## 一、功能代码：无 bug

以下为逐面核查记录（对应任务书 5.a–5.f），每项给出核查口径与依据。

### a. 全仓残留引用（MAO_EXPERIENCE_AGENT_DIR / experienceAgentDir）——干净

- `grep -rn "MAO_EXPERIENCE_AGENT_DIR\|experienceAgentDir"`（backend-ts/src、scripts、desktop、admin、agent-cli、shared，排除 node_modules 与 docs/code-review）仅命中两处：
  1. `backend-ts/src/harness/container/container-tool-executor.spec.ts:223-259`——`readsFileUnderShareRoot` 用例的局部 fixture 变量，属任务书明示的预期豁免；
  2. `docs/plan/2026-11-07-user-agent-container-isolation-technical-design.md:158`——「`MAO_EXPERIENCE_AGENT_DIR` env 不引入」的否定性表述，语义正确，非残留。
- planner / registry 均已删除对 `EXPERIENCE_ROOT_SUBDIR` 的 import（`container-mount-planner.ts` 头部、`container-registry.ts:13` 对比 `git show d14f4d84` 确认）；executor 保留 import 是为容器内索引刷新回调（`experienceRefreshCallback` 构造 `{shareDir}/agent-experience` 根），与决策 13 语义一致。

### b. assertSafe 组合漏洞（share 整挂例外恢复后）——闭合

逐规则推演（`container-mount-planner.ts:209-309`）+ 与 spec 断言交叉核对：

1. **share 整挂例外的范围**：`isSharedShareRoot = purpose==='share' && host === path.resolve(shareDir)`（:263）——仅恰为登记根放行，与 d14f4d84（回退前原语义）逐字节一致。借 purpose 挂经验子目录（无 userId 段）被 `containsUserSegment` 拒绝（spec `rejectsSharePurposeSubpathsAndRequiresExactRoot` 实证）；挂上级/其他登记根被 owningRoot + 父目录防护拒绝。
2. **借 purpose='share' 挂 share 子路径且含 userId 段**（如 `{share}/agent-experience/{userId}` 或 `{share}/{userId}`）：推演可过 `containsUserSegment`，但该路径本就在 share 整根 rw 挂载面之内，不产生任何超出标准清单的暴露面；且 `assertSafe` 仅被 `plan()`（固定清单）调用，无外部挂载注入点（全仓 grep 确认 assertSafe 生产调用仅 `plan():130` 一处）——构造型条目不可达，不构成绕过面。
3. **经验子目录形态（{share}/agent-experience/{n}，无 userId 段）**：rw 被拒（上条）；ro 形态虽可过「ro 项位于登记根之下」规则，但 share 整根本身已 rw 挂载，ro 子挂载不放大任何权限，同样仅 spec 构造型可达。
4. **agentId 段校验**：`expectedAgentPaths` 仅含 skillViews / channel（:212-215），均要求恰为 `{登记根}/{userId}/{agentId}`，与 mode 无关（ro/rw 都校验）；share 已移出该表、由整挂例外单独收口——与决策 13 一致，无「半删」状态。
5. **回退新增的独立性与父目录校验仍闭合**：`assertShareDirIndependent` 保留 distDir（:153），share 等值/位于 dist、skills、skillViews 等登记根之下均 fail-fast；`viewsRoot` 不得位于 shareDir 之内（:221-223）；shareDir 为其他登记根父目录时由父目录防护在 share 条目上拒绝（spec `rejectsShareDirAsParentOfRoot` 实测命中 `is a parent of registered root` 分支）。
6. **回退对照 d14f4d84 无弱化**：share 条目 hostPath、assertSafe 例外条件、symlink/父目录/重复容器路径防护与回退前基线完全一致（`git show d14f4d84:container-mount-planner.ts` :105/:232-234 比对），唯一差异是 skillViews/channel 收窄（本功能的加固项）。shareDir 本身为符号链接的边界行为（realpath 逃逸检查对整根条目生效）与基线一致，非本次引入。

### c. 挂载面 vs 沙箱允许根口径——一致

三方对照（`runtime-agent.ts:40-49` resolveRoots → `container-tool-executor.ts:75-97` addAllowedRoot vs `container-mount-planner.ts:100-123` 挂载表 vs `container-registry.ts:776-818` env 注入）：

| 面 | 挂载 | 沙箱允许根 | 一致性 |
|---|---|---|---|
| workspace | `{workspaceRoot}/{u}` rw | PathSandbox 主根 `workspaceRoot/{u}` | ✓ |
| runtime | `{runtimeDir}/{u}` rw | `{runtimeDir}/{u}` | ✓ |
| userHome | `{userHomeDir}/{u}` rw | `{userHomeDir}/{u}` | ✓ |
| userSkills | `{userSkillsDir}/{u}` rw | `{userSkillsDir}/{u}` | ✓ |
| skillViews | `{views}/{u}/{a}` ro（registry mkdirSync 预创建 :755） | `roots.skillViewsDir` = 宿主注入的 `MAO_SKILL_VIEWS_DIR` = `{views}/{u}/{a}`（registry :807 经 `skillViewsAgentDir` path.resolve 注入，与 planner `under()` 同解析基准） | ✓ |
| uploads | `{uploadDir}/{u}` rw | `{uploadDir}/{u}` | ✓ |
| share | `{shareDir}` 整根 rw（缺失由 assertSafe mkdirSync + create-app.ts:287 启动 mkdirSync 双兜底） | `roots.shareDir` 整根 | ✓ |
| tmp | `{tmpDir}/{u}` → /tmp rw（1777） | `/tmp` | ✓ |
| deps / channel / dist / sessionWorkspace | 挂载但不进沙箱允许根 | — | 与 d14f4d84 基线一致（deps 经子进程 env、channel 经 socket 直连、dist 为 agent 代码），非本次改动 |

无「挂载了但沙箱拒」或「沙箱放行了挂载面不存在的路径」的新增不一致。`MAO_SKILL_VIEWS_DIR` 注入值恰为 per-agent 目录本身，executor 允许根与 ro 挂载同域（写操作由 ro 挂载 EROFS 拒绝），strict 符号链接校验对 `{runtime}/{u}/{s}/skills/{name} → {views}/{u}/{a}/{name}` 成立。

### d. 派发链路 agentId 穿线——闭环

1. **填充**：`harness-service.buildContext:344/:395` 每轮以 `session.agentId`（DB NOT NULL，V001:151）取 agent，`context.agentId = agent.id`；`agent-loop.ts:826` 填入 `ToolInvocation.agentId`（全仓唯一 `dispatchInvocation` 调用点，grep 实证）。
2. **docker-only 分支**（`tool-dispatcher.ts:420-443`）：快照优先，缺省按 `sessionMapper.selectById(sessionId)` 查库兜底，仍缺则明确报错不派发（不静默降级宿主机）——spec 三用例（快照路由 / 兜底 / 会话不存在报错）实证。
3. **SEND_BYTES_TOOLS 包裹完整性**：消费 `SendBytesSupport` 的工具全集与 `loadSendFileBytes` 消费方逐一比对（wechat×2 / feishu×2 / dingtalk×2 / edit_image，`grep loadSendFileBytes` 实证无第 8 个），7 个与 `SEND_BYTES_TOOLS`（:89-94）恰好相等；SERVER_ONLY 分支（:320，覆盖 send_wechat_*、edit_image）与兜底分支（:451，覆盖 feishu/dingtalk 四件套——它们不在 SERVER_ONLY_TOOLS、不在 DOCKER_ONLY_TOOLS，实证走兜底分支）均经 `dispatchWithRoundAgent` 包裹，round-2 缺口已补。docker-only 六件套（shell/read_file/write_file/edit_file/glob/grep）不消费 SendBytesSupport，无需包裹。
4. **read-bytes-bridge**：`getStore()?.agentId` 快照优先、查库兜底、不可得明确报错（`read-bytes-bridge.ts:104-110`）；ALS 经 `run → callTool → execute → loadSendFileBytes → readBytes` 全 await 链传播（round-2 已实测，本轮复核实现未变）。
5. **MCP / 终端 / 预热 / 通道**：`RoutingMcpClientManager` 三处（connect/call/close）全带 agentId，会话缺失时 close 静默跳过（连接本已不存在，语义等价）；`terminal.routes.ts:60` 唯一创建点传 `session.agentId`（Session 行映射含 agentId，repository :404/:456），`app-utils.ts:152-156` 缺省明确报错不落宿主机 node-pty；pty hub 键 `{u}:{a}` + `startedAtMs` 世代判定在 dockerStart（重置 startedAtMs）与 rebuild 路径下均正确；`activityHeartbeat.onActivity` 预热与 `notifyAgentSwitched`（PATCH 后 fire-and-forget）均按 (userId, agentId) 复合键；`RuntimeChannelServer` 连接表/socket 目录/token/踢旧全复合键，`getConnection` 全部 6 处调用点双参（grep 实证）。
6. **轮中切 Agent 快照语义**：PATCH 只更新 DB 行 + 预热新容器；本轮 ToolInvocation.agentId 已固化、send 工具 ALS 快照同源，同轮所有容器路由一致；下一轮 buildContext 重算 + 技能按新 agent 重挂（`{views}/{u}/{newAgentId}` 已由预创建 + 预热覆盖）。会话内切 Agent 后 syncState 按新键（`${agentId}:{u}:{s}`）新建、旧 agent 独有技能链接残留——该键结构在 d14f4d84 已存在，属既有语义，非本次引入。

### e. 回退完整性（MAO_CONTAINER_AGENT_ID）——无半删状态

- `MAO_CONTAINER_AGENT_ID` 仅注入（`container-registry.ts:794`）无消费方：`runtime-agent.ts` 不读取、`resolveRoots()` 不依赖、无 exit(1) 检查、planner/executor 无引用（全仓 grep 唯一命中即注入行）——与提交说明「保留注入作容器身份标识（无运行时消费方）」一致，plan 文档 §4 选型表亦如实记录。
- 经验子目录 mkdirSync 已从 `createAndStart` 移除（:752-755 仅创建 skillViews 目录，注释说明 share 根由 create-app.ts:287 启动时创建），无悬挂调用。

### f. spec 与新语义一致性——无按旧语义写但碰巧通过的用例

四个 spec 文件逐一比对回退 diff 与断言语义：

1. **container-mount-planner.spec.ts**：`mountsAgentScopedViewsAndChannelWithWholeShareRoot`（share 恰为整根、skillViews/channel 带 agentId 段、指纹含 agent 维度）、`mountsShareDirReadWrite`（整根 rw）、`shareDirMissingIsTolerated`（rw 缺失自动创建，改为断言 share 根而非经验子目录）、`rejectsSharePurposeSubpathsAndRequiresExactRoot`（恰为根放行 / 经验子目录借 purpose 拒绝 / skillViews-channel 缺 agentId 段拒绝）——断言与新语义一一对应，无旧语义残留断言。
2. **container-tool-executor.spec.ts**：`readsFileUnderShareRoot` 断言管理员投放可读、本 Agent 经验文档可读、**其他 Agent 经验库可达**（决策 13 接受项，`expect(otherAgent).content === 'other-agent'`）、share 内 symlink 逃逸仍拒——语义方向正确；`shellWorkdirUnderShareRootIsAllowed` 同口径。全部 executor 用例构造参数已移除 `experienceAgentDir`。
3. **runtime-agent.spec.ts**：share 默认根用例断言 `/opt/mao-data/share` 整根登记为允许根（:220-221），`MAO_SKILL_VIEWS_DIR` 用例断言允许根 = 注入值本身（per-agent 目录）——与决策 13 一致。
4. **container-registry.spec.ts**：`-e MAO_SHARE_DIR` + `{share}:{share}:rw` 整根断言（:131-132）、双参回调（ensureChannelListening/issueChannelToken/waitSocketReady/sessionWorkspacesOf）、按行回收与整用户聚合（:943-985）——无 `MAO_EXPERIENCE_AGENT_DIR` 断言残留。
5. 配套 spec（dispatcher 的 ALS 兜底分支用例、bridge 快照优先用例、shell-session-tool 引导文案用例、skill-view 三级路径用例）均按新语义编写且本轮实跑全绿。

---

## 二、文档残留 2 项（评审要求 g 范围；非运行时缺陷）

### 文档 1（低）：技术方案 §4/§7 仍声称 `createAndStart` 预创建「经验子目录」，与回退后代码及同文档 §5.2 矛盾

- **位置**：`docs/plan/2026-11-07-user-agent-container-isolation-technical-design.md:113`（§4 技术选型表「挂载源目录」行：「`createAndStart` 在 `docker run` 前对视图目录**与经验子目录**显式 `mkdirSync(recursive)`」）；`:253`（§7 测试计划：「`createAndStart` 前视图目录**与经验子目录**已存在（预热早于首轮同步的场景）」）。
- **问题**：回退提交 b2df53ba 已删除 `createAndStart` 中的经验子目录 mkdirSync（`container-registry.ts:752-755` 现仅创建 `{skillViewsDir}/{userId}/{agentId}`，注释明确「share 根由 create-app 启动时 mkdirSync，无需在此创建」）；同文档 §5.2 `:128` 已改为只写视图目录——§4/§7 两处是回退时漏改的旧表述，且与 §5.2 自相矛盾。
- **影响**：仅文档误导（读者会以为经验子目录有预创建语义），无运行时影响；share 根实际由 create-app 启动 mkdirSync + assertSafe rw 缺失自动创建双兜底。
- **验证**：代码侧 `git show b2df53ba -- backend-ts/src/harness/container/container-registry.ts` 确认删除；文档侧 grep 实证上述三行现状。
- **建议修法**：§4 :113 与 §7 :253 两处删去「与经验子目录」字样（或改写为「视图目录；share 根由 create-app 启动创建」），与 §5.2 :128 对齐。

### 文档 2（低）：调研文档除已勘误的三处外，仍有 7 处未回收的「经验库按 Agent 收窄/隔离」旧语义表述

- **位置**：`docs/research/2026-11-07-container-isolation-user-agent-dimension.md`：
  - `:109`（§3.2 化解方向）：「经验库……直接从『整根』改为『只挂子目录』即可」；
  - `:148`（§4 兼容性表·经验库文件行）：「只是容器挂载从『整根』改为『子目录』」；
  - `:164`（§5.1 改造面表·planner 行）：「经验子目录挂载……share 豁免从『恰为根』改为『恰为 agentId 子目录』」；
  - `:289`（§7.1 候选形态 A 行）：「经验库只挂当前 Agent 子目录」；
  - `:294`（§7.1 末段定性）：「仅 skill 视图与经验库两处变为 agent 维度」；
  - `:302`（§7.2.3 分期路径①）：「Agent 维度物化目录 + 经验子目录挂载」；
  - `:303`（§7.2.4 隔离承诺）：「隔离的是同用户跨 Agent 的 skill 视图**与团队经验库**」。
- **问题**：回退提交仅勘误了文档头（:3）、决策表新增第 13 行（:279）、§7.2.1 第二条（:300 删除线 + 撤回说明）三处；以上 7 处旧语义表述原样保留，其中 `:303` 的「隔离承诺」与决策 13「经验库不做容器级隔离」直接矛盾——读者单看 §7.2.4 会得出「容器内读不到他人经验库」的错误结论，恰是评审要求 g 明令不得残留的表述形态。
- **影响**：仅文档误导，无运行时影响。
- **验证**：`git show b2df53ba -- docs/research/...` 确认该提交仅改 3 处；逐行 grep 实证上述 7 行现状文本。
- **建议修法**：对 7 处逐一补决策 13 勘误标注（最小改动：`:303` 改为「隔离的是同用户跨 Agent 的 skill 视图；经验库维持 share 整根共享（决策 13），跨 Agent 收口靠软链 + 提示词」；`:109/:148/:164/:289/:294/:302` 可比照 `:300` 加删除线 + 「已撤回，决策 13」标注，或在各节首行加一句统一勘误引注指向 §6.8 决策 13 行）。

### CHANGELOG 0.0.473 与 admin 面板——无残留

- CHANGELOG 0.0.473 三段表述（share 整根共享含经验库与管理员投放、软链 + 提示词收口、经验库跨 Agent 收口仍靠软链）与决策 13 及代码一致；「请重新创建 shell 会话」与 shell-session-tool 实际文案（含「已失效（可能因切换 Agent 或容器回收）」）吻合。
- `admin/.../ContainerRebuildPanel.vue`：新增 Agent ID 列、按行 `callRecycle(userId, force, row.agentId)`、`rebuildAll` 逐行回收——与后端 `recycleUser` 的 agentId 语义（缺省整用户、指定单容器）一致；`agentId` 缺省/非法值路径返回 `none`，无 docker 误操作面。

---

## 三、遗留观察（非 bug，round-1 已记录，此处仅存档）

- `backend-ts/src/app-shutdown.ts:52-53` 的 `ptyChannelHubs/ptyHubGeneration: Map<number, …>` 类型标注未随复合键更新为 `Map<string, …>`；该处仅 `values()/clear()` 且经 `app-lifecycle.ts` 的 `any` 通路传入，tsc 不报错、无运行时影响（round-1 结论维持）。下次触碰该文件时可顺手改标注。

## 四、验证记录

- `cd backend-ts && npm run build` → exit 0（runtime-build 287ae91bcaf4ed14，54 files）。
- 定向 vitest（11 文件）：container 相关 6 文件 107 用例全绿；dispatcher/shell/skill 相关 5 文件 131 用例全绿（日志 /tmp/round4-vitest*.log，已删除）。未重跑全量套件（遵任务书）。
- assertSafe 组合推演的结论均有对应既有 spec 断言背书（`rejectsSharePurposeSubpathsAndRequiresExactRoot` / `rejectsParentDirectoryMounts` / `rejectsRwMountsWithoutUserSegment` / `rejectsSymlinkEscapeAndForeignUserPaths` 等），本轮实跑通过。
