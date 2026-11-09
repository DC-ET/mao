# `/opt/mao-data/share` 按 Agent 完全隔离：现状评估与设计思路（v2）

> 状态：调研与设计思路 **v2**（2026-11-09），仅评估、未改任何代码/数据。待评审拍板后出正式技术方案与迁移脚本。
> 需求演进：v1 为「双区拆分（public + 各 Agent 私有）」；**v2 按需求方最新输入修订**——① 取消"公共投放区"概念，管理员投放改为**按 Agent 维度投放**；② 目标升级为 **Agent 之间完全隔离**；③ 已确认"手动迁移可接受、尽量减少代码层兼容"的取向。
> 关联与修订：本文修订 [2026-11-07 容器隔离调研](./2026-11-07-container-isolation-user-agent-dimension.md) 决策 13（share 维持整根 rw）。v2 相对 v1 的变化：公投放区取消（权限拆分不再需要）→ 上一版"兼容甲/乙"二选一**自然消解为零兼容**（原因见 §2.2）；推荐形态收敛为「双树私有 + 无公共区」。
> 复用先例：0.0.474 技能视图"历史路径兼容链接"（`prepareSkillViewCompatLinks`）——本方案默认不需要同类代码，但其"仅补缺失、幂等、失败告警"的护栏原则仍适用于任何后续兼容项。

---

## 0. 结论速览

| 问题 | 结论 |
|---|---|
| "完全隔离"能否达成 | **share 数据面：可以（docker 模式物理级隔离）；全称命题"无任何数据泄露点"：以当前架构还差三块**（host 模式弱边界、用户级共享面旁路、同 Agent 跨用户共享语义）——逐项见 §2.4 核查表，需要你界定"完全隔离"的承诺边界 |
| 推荐形态 | **C′「双树私有 + 零公共区」**：`agent-experience/{agentId}/`（经验库，**原位不动**）+ `agents/{agentId}/`（每 Agent 私有区：投放品、脚本、产物）。管理员投放 = 往目标 Agent 的 `agents/{A}/` 投放（per-agent 分发） |
| 隔离效果 | 每容器只挂本 Agent 的两棵树；其他 Agent 目录**容器文件系统级不存在**（读/写均不可达）；无任何"全员共享"挂载面 |
| 兼容层 | **零（默认）**：经验库原位→最大引用面零变化；投放品/脚本属"共享→拆分"，无单目标可兼容——直接更新引用（清单 ~15 处，§4.1）。如迁移后观察需要，可再加"per-agent 重定向链"（~20 行）作为回退预案 |
| 上下文污染 | 收敛：经验库引用（史料级）全部保持有效；需更新的只剩 settings/scripts 引用（~15 处）+ 最佳实践 4 条 |
| 迁移 | 数据先行"复制保留"→ 引用更新 → 部署代码（挂载切换、容器一次性重建）→ 删旧残留；全程无断点窗口；备份+回滚 10 分钟级 |
| 代码量级 | 后端 ~5 个文件（挂载 2 条、planner 白名单、沙箱/roots、启动建目录）+ 测试；**无兼容代码**；admin/desktop/android/agent-cli 零改动；经验库 admin UI 零改动 |
| 工作量 | **约 2~2.5 人日**（比 v1 更低：经验库不迁移、无兼容层） |

---

## 1. 现状核查（简述，v1 已详列）

share 三类内容今天被"整根 rw"统一对待（`container-mount-planner.ts:116` 单条挂载），这就是隔离缺口的根源：

| 内容类 | 现状路径 | 规模 |
|---|---|---|
| Agent 经验库 | `agent-experience/{1,3,4,5,6}/` | 213 篇 .md（1:26 / 3:1 / 4:1 / 5:174 / 6:11），~1.5MB |
| 管理员投放 | `settings.xml`、`settings_t.xml` | 4KB（含 nexus 只读凭据） |
| 运维/Agent 脚本 | `scripts/`（15 个文件） | ~120KB |

引用面盘点（完整明细见 v1 §1.3）：DB 消息 1229 条/454 会话（不可改）；`agent_experiences` 4 条（每轮注入）；定时任务 4 个（#54/#76 经验路径、#96/#97 脚本路径）；工作区文件 68 个（其中 AGENTS.md 8、工作区 docs 4、历史构建产物 26）；经验文档内引用 8 篇（均为 settings/scripts、无经验库自引用）；技能文档 3 处。试验副本已确认（手动产物，直接删除）。

**v1 核过、v2 继续成立的机制事实**：容器键 `(userId, agentId)`（0.0.473）；挂载清单单点生成、指纹漂移自动重建；容器内路径 = 宿主机路径；容器内 root 可写 `share/` 根（可补链，实测验证）；子路径挂载隔离实测（跨 Agent 目录 ENOENT）。

## 2. 目标形态与隔离完备性

### 2.1 设计原则

1. **隔离维度 = Agent（全局）**：Agent 是跨用户实体，隔离承诺 = 「不同 Agent 互不可见对方的全部共享面」；同一 Agent 的多用户会话仍共享该 Agent 的目录与经验库（团队语义，见 §2.4 边界声明）。
2. **无公共面**：share 下不存在"全员共享"目录；管理员投放按 Agent 维度进行。
3. **路径恒等**：容器内路径与宿主机逐字节一致，不引入翻译（`/tmp` 为既有唯一例外）。
4. **挂载路径恒定、内容变化零重建**：投放/写入只改宿主机目录内容，不触发容器重建。
5. **挂载面即沙箱面**：容器内可见路径集合与沙箱允许根严格一致。
6. **host/docker 模式无缝性**：`runtime_mode` 动态切换时历史会话/运行中会话不出现路径漂移；新增路径"容器内＝宿主"且双模式可达对称。
7. **最小代码 + 手动迁移优先**：能用一次性运维动作解决的，不写长期兼容代码（本版因此收敛为零兼容层）。

### 2.2 形态选择（v2 变更说明）

v1 的两个关键卖点是"public 保留共享投放"与"经验库原位不动"。**v2 取消 public 后，第一个卖点消失，但第二个卖点更重要了**——它直接决定了改动面：

| 形态 | 结构 | 评价 |
|---|---|---|
| **C′ 双树私有（推荐）** | `agent-experience/{A}/`（原位）+ `agents/{A}/`（私有区） | ✅ 经验库零迁移、零引用更新（最大引用面 213 篇文档/软链/任务全不动）；投放品与脚本按归属分发到各 `agents/{A}/`；挂载 2 条、无公共面 |
| B′ 单树合并（备选） | `agents/{A}/{experience,conf,scripts}/`（经验库也迁入） | ⚠️ 结构最统一（一个 Agent 一个目录），但经验库搬家会动：`dirFor`/admin/软链目标 + AGENTS.md×8 + 任务×2 + 工作区 docs + "经验库旧路径"兼容（容器补链 + 宿主软链，两模式对称）。若你更看重"一个 Agent 一个目录"的叙事，可选，代价约 +0.5~1 人日 |
| A′（v1 的 A 去掉 public） | 与 C′ 等价 | 同 C′（本文直接以 C′ 表述） |

**为什么"零兼容层"是自然的**：v1 的甲/乙取舍针对的是"旧 paths（share/scripts、share/settings.xml）还要不要兼容"。取消 public 后，这些旧路径的"全局共享"语义已废止，新语义是"每个 Agent 各有一份"——**旧路径不存在唯一可指向的目标**，任何兼容（如 `share/scripts -> agents/{A}/scripts`）都只是"重定向到本 Agent 的对应物"，属于语义改写而非兼容，且会引入隐含行为。因此直接更新引用（~15 处，全部可枚举）是更干净的选择，也符合你"减代码"的取向。经验库因原位不动，其历史引用（史料级）继续有效，无需任何兼容。

### 2.3 推荐形态（C′）细节

**目标目录结构（宿主机，`MAO_SHARE_DIR` 根下）：**

```
/opt/mao-data/share/
├── README.md                       # 结构说明与投放指引（宿主机/运维可见；容器不挂根，不可见）
├── agent-experience/{agentId}/     # 团队经验库（原位保留，路径不变）
└── agents/{agentId}/               # 每 Agent 私有区（新增）
    ├── settings.xml / settings_t.xml   # 该 Agent 需要的投放品（per-agent 副本）
    ├── scripts/                        # 该 Agent 的脚本（原 share/scripts 按归属拆入）
    └── …                               # 该 Agent 的其它产物（conf/、模板等，自行组织）
```

**每 (user, agent) 容器的挂载面（2 条，容器内路径 = 宿主机路径）：**

| 挂载 | 模式 | 说明 |
|---|---|---|
| `{shareDir}/agent-experience/{A}` | rw | 本 Agent 经验库（工作区 `团队经验/` 软链目标，路径不变） |
| `{shareDir}/agents/{A}` | rw | 本 Agent 私有区（投放品/脚本/产物） |

**管理员投放工作流（无 UI，宿主机直投，即时生效）**：把文件 `cp` 到 `{shareDir}/agents/<目标AgentId>/`（或子目录）。需要多个 Agent 各一份时逐个复制（可写一个 3 行分发脚本，不引入常驻机制）。**投放前须知**：投放即该 Agent 可见；不再存在"一次投放全员可见"。

### 2.4 隔离完备性核查：share 数据会不会泄露？（"无任何数据泄露点"的诚实答案）

**先给结论**：对 **share 数据本身**，改造后 **docker 模式下不存在任何跨 Agent 通路**（逐项见下表）；但"Agent 之间无任何数据泄露点"作为全称命题，**以当前架构还有三块不在这棵树上**（host 模式弱边界、用户级共享面旁路、同 Agent 跨用户共享），需要你确认承诺边界。

| # | 可能的泄露通路 | 改造后状态 | 说明 |
|---|---|---|---|
| 1 | 容器挂载面（整根 share） | ✅ 关闭 | 只挂本 Agent 两棵树；其他 Agent 目录在容器内 `No such file or directory` |
| 2 | 容器内沙箱（文件工具越权读） | ✅ 关闭 | 允许根 = 本 Agent 两棵树（与挂载面一致）；且目标路径本就不存在 |
| 3 | 容器间互访（同宿主其他容器） | ✅ 不存在 | 容器间无共享卷、无 docker socket；各容器只挂各自子路径 |
| 4 | 容器通道/技能视图/终端 | ✅ 已隔离 | 0.0.473 起 socket/连接/PTY/技能视图均为 (user, agent) 键控 |
| 5 | 旧容器（升级前创建，整根挂载） | ✅ 自愈 | 首次使用触发指纹漂移自动重建；未使用的容器不执行任何代码 |
| 6 | 备份/快照文件 | ✅ 默认关闭 | 备份在 `/opt/mao-data/backup`（不在任何容器挂载面）；⚠️ 注意：**不要放 `{tmpDir}/{uid}` 等用户挂载面**（历史曾把经验库备份放 `/tmp`（用户 2 的 tmp），同用户所有 Agent 容器可读——这正是"旁路"的活例） |
| 7 | 网络出口（把 share 数据外发） | ⛔ 不属本项 | Agent 本就能把读到的数据发到任何地方；出域管控属另一专题 |
| 8 | **host 模式直读文件系统** | ⚠️ **残留（弱边界）** | host 模式执行在后端进程内，OS 层全可见（shell 不过沙箱）；**物理隔离做不到**。当前 host 用户仅 user 2（管理员本人，775 会话）。承诺：host 模式为"信任模式"——文件工具沙箱维持 share 根放行（与现状一致，进程级沙箱无法按 Agent 收窄），shell 维持信任边界 |
| 9 | **用户级共享面旁路**（同用户跨 Agent） | ⚠️ **残留（存量决策）** | `workspace/{uid}`、`runtime/{uid}`、`users/{uid}`（HOME）、`{tmpDir}/{uid}`、`deps/{uid}`、`uploads/{uid}`、`userskills/{uid}` 均为用户级共享挂载（2026-11-07 决策 2/3）。**A 把任何数据（含 share 数据副本）写进这些面，同用户的 B 就能读到**；群工作区（feishu-chat 等）还会跨用户共享。**share 改造无法关闭这条旁路**——要"Agent 间零泄露"，需另行决定是否把五件套按 (user, agent) 拆分（影响：CLI 重装×N、HOME 分裂、重开功能、群工作区语义等，工作量大且改产品语义） |
| 10 | 平台层（记忆/会话/技能旧副本） | ⚠️ 存量 | 长期记忆按 user+project 注入（不按 Agent）→ 同用户两个 Agent 会拿到同一份记忆；会话数据属主可见（运行期无跨 Agent 注入）；宿主机上旧技能视图副本（`skill-views/{uid}/{skill}`）不按 Agent 隔离（容器不可见，host 可见） |
| 11 | 管理员/宿主 root/备份管理员 | 信任主体 | 隔离不上抗管理员（平台运维天然全可见） |
| 12 | 同一 Agent 跨用户共享 | 设计语义 | 同一 Agent 被多个用户使用时共享其目录与经验库（团队语义）；本次隔离只承诺"跨 Agent" |

**因此需要你界定"完全隔离"的边界（决策点见 §2.6）**：
- **口径一（推荐一期）**：承诺 = **share 数据在 docker 模式下跨 Agent 零泄露**；host 模式明示为信任模式；五件套/记忆等存量共享面维持现状并写入"平台隔离边界"文档。share 改造可立即落地。
- **口径二**：承诺 = **同用户跨 Agent 也零泄露**（含五件套、记忆等）→ 需要二期专项（本质上是对 2026-11-07 决策 2/3 的重新评估），share 改造作为其中一环先落地。
- 注：口径二也**不能**做到"同一 Agent 内多用户互相隔离"（那会摧毁团队经验语义）；这应作为明确的**不承诺项**。

### 2.5 host/docker 模式切换无缝性核验（沿用 v1，v2 微调）

| 路径 | host 模式 | docker 模式（v2） | 漂移？ |
|---|---|---|---|
| `{shareDir}/agent-experience/{A}/...` | 直接访问 | 子路径挂载 rw | 无（原位、不变） |
| `{shareDir}/agents/{A}/...` | 直接访问 | 子路径挂载 rw | 无 |
| 旧路径 `share/scripts/...`、`share/settings*.xml` | 同步更新引用后不再使用；旧引用两模式一致地断 | 同左 | **对称（都不存在）** |
| 跨 Agent 路径（越界） | 触达（弱边界，既有接受项） | 文件系统级不存在 | 边缘不对称（越界项，见 §2.4 #8/#9） |
| `/tmp` | 宿主共享 /tmp | `{tmpDir}/{userId}` 持久挂载 | 既有唯一例外，不新增 |

不引入任何翻译挂载与第二套路径真相；挂载条目 1→2（比 v1 方案还少一条），指纹漂移照旧一次性重建。

### 2.6 决策点（v2）——**已全部拍板（2026-11-09）**

> 决策记录：形态 **C（双树私有、零公共区、经验库原位）**；本次**仅做 share 维度**（五件套等另立项）；**代码零兼容 + 脚本化迁移**。正式技术方案与迁移脚本见：
> - `docs/plan/2026-11-09-share-per-agent-isolation-technical-design.md`
> - `scripts/migrate-share-per-agent.sh`（plan 只读预演 / apply phase1-3 / verify）

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 形态 C′（双树私有）/ B′（单树合并） | ✅ **C′**（经验库原位，改动最小） |
| 2 | "完全隔离"承诺边界：口径一（share 维度）/ 口径二（含五件套等存量面，二期） | ✅ **口径一先落地**；口径二另立项评估 |
| 3 | 投放品分发方式 | ✅ **脚本化**（迁移脚本 phase1 分发；后续更新可用同一脚本或临时脚本） |
| 4 | 旧共享物（scripts/settings）处理 | ✅ **同步更新引用、无兼容层**（脚本 phase2）；过渡期"复制保留"，phase3 清理 |
| 5 | 经验库是否未来迁入 `agents/{A}/experience` | 维持原位（本次不动；如未来要单树，单独做一次迁移） |
| 6 | host 模式 | 维持弱边界（信任模式），文件工具沙箱维持 share 根放行 |

## 3. 容器目录挂载逻辑调整（代码改造设计）

### 3.1 挂载清单变化

**Before（现状）**：`share` 整根 1 条（rw）。
**After（C′）**：2 条——

```
{shareDir}/agent-experience/{agentId}  -> 同路径 rw
{shareDir}/agents/{agentId}            -> 同路径 rw
```

存量容器：指纹漂移 → 下次使用自动重建（现成机制）；重建后容器内不再出现 `share` 整根。

### 3.2 `container-mount-planner.ts` 校验规则扩展

现状 rw 规则「源路径必须含 `/{userId}/` 段」，share 整根走特例。新条目不含 userId 段，按 v1 §3.2 的思路扩展为**精确路径白名单**：

1. 移除 `purpose='share'` 整根条目；新增/改判两类：
   - `share`（经验库）：**必须恰为** `{shareDir}/agent-experience/{agentId}`；
   - `shareAgent`：**必须恰为** `{shareDir}/agents/{agentId}`。
2. `assertSafe` 增加与 `expectedAgentPaths` 同构的**精确路径断言**（防借 purpose 扩到其他 Agent 或上级）；rw 段校验对这两条显式豁免（豁免条件 = 精确等于上述路径）。
3. 保留 `assertShareDirIndependent`（share 根不得位于/等于任何按用户数据根）等既有校验。
4. `mkdir` 语义：rw 条目缺失时由 `assertSafe` 统一创建（`agents/{A}`、`agent-experience/{A}` 首次使用即就位）。

### 3.3 容器内运行时与沙箱

1. **沙箱允许根**（`ContainerToolExecutor`）：`addAllowedRoot(shareDir)` 替换为上述两条子路径（与挂载面严格一致；`/tmp` 等不变）。
2. **路径推导（减代码）**：不新增 env——容器内由既有 `MAO_SHARE_DIR` + `MAO_CONTAINER_AGENT_ID` 推导两路径（固定子段、无歧义）。备选：显式注入 2 个 env。
3. **经验索引回调**：`ExperienceIndexService` root 仍取 `{shareDir}/agent-experience`（原位，零改动）。
4. **无兼容链**（默认）：不新增 `prepareShareCompatLinks`；如未来观察需要，可加"per-agent 重定向链"（`share/scripts -> agents/{A}/scripts` 等，~20 行），但默认不做。

### 3.4 宿主侧与 admin

1. 启动兜底：`mkdirSync(shareDir)` 之外新增 `mkdirSync(join(shareDir,'agents'))`（`agent-experience` 既有逻辑不变）。
2. 宿主沙箱（host 模式）：**维持 `addAllowedRoot(shareDir)` 整根**（理由同 v1：进程级共享实例无法按 Agent 收窄；收窄会与既有行为/文档打架；host 弱边界为信任模式）。
3. 经验库服务与 admin：**零改动**（`join(shareDir,'agent-experience')`、`dirFor(agentId)` 不变）；会话文件浏览、`团队经验` 软链全部照旧。

### 3.5 改动文件清单（预估）

| 文件 | 改动 | 量级 |
|---|---|---|
| `container-mount-planner.ts` | 挂载条目 1→2、白名单/精确断言 | 中 |
| `container-tool-executor.ts` | 沙箱允许根改两路径 | 小 |
| `runtime-agent.ts` | roots 推导（读 agentId）+ executor roots 接线 | 小 |
| `create-app.ts` | 启动建 `agents/`；宿主沙箱维持（不改） | 极小 |
| 测试 | planner（新条目、精确路径、跨 Agent 拒绝）、executor（允许根）、registry（env 断言若有） | 中 |
| 文档 | `skills/mao-cli/reference/{config,deploy,agent}.md`、`DEPLOY.md`、`.env.example` 注释、`CHANGELOG.md` | 小 |

> desktop / android / agent-cli / admin / shared-contracts：**零改动**。admin 经验库 UI 亦零改动（经验库原位）。

---

## 4. 历史数据迁移方案

### 4.1 迁移范围与映射

**DB**：零迁移。**文件系统**（关键变化：投放品/脚本按归属分发到 `agents/{A}/`）：

| 现路径 | 新路径 | 说明 |
|---|---|---|
| `settings.xml` | `agents/{1,3,4,5}/settings.xml`（每 Agent 一份；2026-11-09 用户决策） | per-agent 副本，更新时逐个分发 |
| `settings_t.xml` | `agents/6/settings_t.xml` | 同上 |
| `scripts/`（14 文件） | `agents/{1,3,4,5,6}/scripts/`（每 Agent 一份；`push_fast.sh` 自引用按副本路径修正） | 脚本会被容器内编辑，须在可写私有区 |
| `agent-experience/{1,3,4,5,6}/**` | **不动**（原位） | 经验库路径不变 |
| `agent-experience/*/share/**`（手动试验产物） | 直接删除 | 已确认无业务含义 |

**引用同步更新清单**（与迁移同批）：

| 位置 | 更新 |
|---|---|
| `agent_experiences` #66（agent6 settings_t） | → `agents/6/settings_t.xml` |
| `agent_experiences` #74/#75/#76（"共享文件放 share"） | 改为："本 Agent 的文件放 `/opt/mao-data/share/agents/<本 Agent ID>/`；不存在跨 Agent 公共共享目录；需要共享给某 Agent 时由管理员投放至其目录" |
| 定时任务 #96/#97 | 脚本路径 → `agents/5/scripts/...`（**历史行同步**：#96 finished=1、#97 deleted=1，仅存档一致，不作回归依据）；#54/#76（经验路径）**无需改**（原位） |
| 经验文档 8 篇 | settings → `agents/{5,6}/settings*.xml`；scripts → `agents/5/scripts/...`；失效 tools 引用顺手清理 |
| AGENTS.md 8 个 | 经验库引用**无需改**；settings_t 引用 1 处 → 新路径 |
| 工作区 docs 4 处（user2/user10） | settings 引用 → 新路径 |
| `skills/mao-cli/reference/{config,deploy,agent}.md` | 结构、投放指引改写 |
| `docs/agents/*`（本工作区 2 篇）、share 脚本自身引用 | 同批更新 |

### 4.2 迁移步骤（推荐顺序：数据先行"复制保留"→ 引用更新 → 部署 → 删旧）

```bash
# 0) 全量备份
tar -czf /opt/mao-data/backup/share-migrate-$(date +%F-%H%M).tgz -C /opt/mao-data share

cd /opt/mao-data/share
# 1) 建新结构 + 分发（复制，先不删源——旧容器/旧引用在过渡窗口内继续可用）
mkdir -p agents/{1,3,4,5,6}
cp settings.xml agents/{1,3,4,5}/ ; cp settings_t.xml agents/6/    # 用户决策（2026-11-09）
for a in 1 3 4 5 6; do cp -a scripts agents/$a/scripts; done       # 每 Agent 一份
# 修正各副本 push_fast.sh 自引用 → agents/<A>/scripts
# 2) 更新引用（任务 prompt / 最佳实践 / 文档）→ 指到 agents/{A}/...（此时旧容器整根挂载亦可见新路径，零断点）
# 3) 删除试验副本；部署代码（挂载 1→2 条，存量容器按指纹自动重建）
# 4) 观察 1~2 天后删除旧残留：share/scripts/、share/settings*.xml（删除前确认无引用残留）
```

> 每一步都与"旧世界"可共存：复制而非移动 + 引用更新先于删除 → 过渡窗口无断点。唯一接受的断链面 = 历史消息中的旧路径（在旧残留删除后失效），由更新后的提示词对照表兜底。

### 4.3 校验清单

```bash
ls -la /opt/mao-data/share/            # README.md + agent-experience/ + agents/（+过渡期旧残留）
ls /opt/mao-data/share/agents/{1,3,4}/settings.xml /opt/mao-data/share/agents/{1,3,4,5,6}/scripts/   # 副本齐全
docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agent-experience/   # 仅 5
docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agents/             # 仅 5
docker exec mao-user-36-agent-5 cat /opt/mao-data/share/agent-experience/6/x 2>&1  # 应 ENOENT
docker exec mao-user-36-agent-5 sh -c 'echo x > /opt/mao-data/share/agents/5/.t && rm /opt/mao-data/share/agents/5/.t'  # 可写
# 业务回归（评审 P1-5 修正）：#96/#97 已完结失效，改手工冒烟——
#   docker exec mao-user-36-agent-5 python3 /opt/mao-data/share/agents/5/scripts/skill-cli-health-check.py --help
#   docker exec mao-user-36-agent-5 bash /opt/mao-data/share/agents/5/scripts/push_flow.sh
#   agent6：mvn -s /opt/mao-data/share/agents/6/settings_t.xml -v
#   host 模式（user2）读 团队经验/ 正常
```

### 4.4 回滚与清理

- **回滚**：恢复备份 tarball + 回滚部署；容器按指纹重建回旧挂载。因"复制保留"，回滚窗口无数据丢失。
- **清理项**：旧残留（`share/scripts`、`share/settings*.xml`，观察期后）；试验副本；`__pycache__`；失效引用。

---

## 5. 路径变更后的上下文引导（v2 收敛版）

### 5.1 新旧对照表（写进 README 与提示词）

| 旧路径 | 新路径 | 兼容 |
|---|---|---|
| `/opt/mao-data/share/settings.xml` | `/opt/mao-data/share/agents/{本Agent}/settings.xml`（1/3/4/5 均有副本） | 无（更新引用） |
| `/opt/mao-data/share/settings_t.xml` | `/opt/mao-data/share/agents/6/settings_t.xml` | 无（更新引用） |
| `/opt/mao-data/share/scripts/<脚本>` | `/opt/mao-data/share/agents/{本Agent}/scripts/<脚本>`（全 Agent 均有副本） | 无（更新引用） |
| `/opt/mao-data/share/agent-experience/{A}` | **不变** | — |
| `/opt/mao-data/share/tools/...`（历史） | 已失效（改用 skills / skill-views） | — |
| （新增） | `/opt/mao-data/share/agents/{A}/`（私有区；含投放品与脚本） | — |
| 工作区 `团队经验/` | **不变**（平台每轮自动指向 `agent-experience/{A}`） | — |

### 5.2 引导机制（v2：两层为主）

- **提示层（主通道）**：更新 `agent_experiences` 4 条——①"本 Agent 的文件放 `agents/<本 Agent ID>/`；不存在跨 Agent 共享目录；公共文件需先投放到对应 Agent 目录"；②settings 路径替换；③如遇历史消息/文档中旧路径不存在，按本对照表映射。系统提示每轮重建 → 存量会话下一轮即生效。
- **工作区规范快照层（评审 P1-3 修正）**：`session_workspace_rules` 为 per-session 冻结（`resolve()` 命中即返回快照文本，仅新会话/压缩提交才重读文件）→ 迁移时定向删除 oc_6783 的 5 行旧快照即时重建；其余工作区在新建会话/压缩后自然生效。
- **文档层**：§4.1 清单逐一更新 + `share/README.md`（宿主机视角结构说明与投放指引）。
- （可选行为层）如迁移后"旧路径失败"类咨询偏多，再加 per-agent 重定向链（~20 行，容器内 `share/scripts -> agents/{A}/scripts` 等；两模式对称需同时做宿主软链——即 v1 的"甲"）。默认不做。
- **不可改面**：1229 条历史消息中的旧路径（多为 scripts/settings 引用），更新引用后其残留引用会指向失效路径——接受（agent 失败后按提示词对照表自愈）。
## 6. 风险、成本与分期

### 6.1 主要风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 存量容器一次性重建打断在途 shell/终端 | 中 | 低峰发布；指纹机制为历次升级既定路径 |
| 旧引用（历史消息/用户习惯）中的 scripts/settings 路径断链 | 中 | §4.1 清单全覆盖更新 + 提示词对照表；观察期可回退到"per-agent 重定向链"预案 |
| 管理员投放习惯变化（不再"投一次全员可见"） | 中 | README + 投放指引；投放频率低，先手动 |
| 投放品多份副本的更新一致性（settings 更新需逐个分发） | 低 | 文件很小、频率低；需要时写分发脚本 |
| host 模式弱边界 + 用户级共享面旁路（§2.4 #8/#9） | 中（已知） | 明确写入"平台隔离边界"文档；如需"零泄露全称"另立项（口径二） |
| 备份误放用户挂载面导致旁路（历史已发生） | 低 | 运维规范：备份只放 `/opt/mao-data/backup` 等非挂载路径 |

### 6.2 工作量估算

| 阶段 | 内容 | 预估 |
|---|---|---|
| ① 数据面：备份 + 建目录 + 分发 + 校验 | 运维脚本/手动 | 0.5 人日 |
| ② 代码：planner/executor/runtime-agent/create-app + 测试（spec 反向改写） | 后端 | 1.5~2 人日 |
| ③ 引导面：最佳实践/任务/文档/技能文档/README | 编辑 | 0.5 人日 |
| ④ 观察与清理 | 含 1 周观察 | 0.5 人日 |
| **合计** | | **约 2.5~3 人日**（选 B′ 单树合并另 +0.5~1 人日） |

### 6.3 分期建议

1. **P0**：拍板 §2.6 决策点（形态 C′/B′、隔离承诺口径、投放分发方式）。
2. **P1**：数据面先行（备份/建结构/复制/引用更新——全程零断点，可先做）。
3. **P2**：部署代码（挂载切换 + 容器重建收敛）。
4. **P3**：观察 1~2 天后删旧残留、更新 README、收尾。
5. **后续可选**：口径二（五件套/记忆等按 (user, agent) 拆分）专项；admin 投放管理页；per-agent 重定向链（若咨询量需要）。

---

## 7. 附录

### 7.1 关键代码索引

| 事实 | 位置 |
|---|---|
| share 整根挂载条目 / 豁免 / 独立性校验 | `container-mount-planner.ts:116`（整根条目）, `135-158`（`assertShareDirIndependent`）, `209 起`（`assertSafe`；263 整根特例） |
| 容器名与指纹漂移重建 | `container-registry.ts:253-255, 511-513, 395` |
| `MAO_SHARE_DIR` env 注入 | `container-registry.ts:816` |
| 容器内沙箱允许根 | `container-tool-executor.ts:80-97` |
| 容器内经验索引构造 | `container-tool-executor.ts:153-155` |
| 宿主沙箱 share 允许根 / 启动 mkdir | `create-app.ts:286-287, 465-468` |
| 经验库服务构造（root=share/agent-experience） | `create-app.ts:527-528` |
| 经验库索引/挂载/路径解析 | `experience-index.service.ts`、`experience-mount.service.ts`、`experience-mount-path.ts` |
| 每轮幂等重挂软链 | `harness-service.ts:412` |
| host/docker 模式解析（动态） | `RuntimeModeResolver`（`app-container-runtime.ts:138-169`）、`app-routes.ts:446`（设置变更即失效缓存） |
| 技能视图历史路径兼容链接（先例） | `runtime-agent.ts` `prepareSkillViewCompatLinks`（0.0.474） |
| e2e 的 share 重定向 | `scripts/e2e-setup.sh:248-267` |

### 7.2 盘点原始数据（2026-11-09）

- share 总量 ~2.9MB；经验库 213 篇 .md（1:26 / 3:1 / 4:1 / 5:174 / 6:11）。
- DB：消息 1229/454 会话；`agent_experiences` 4 条；`scheduled_task` 4 条引用 share（#54/#76 经验路径原位不改；#96/#97 脚本路径待改，均已完结/删除）；`session_workspace_rules` 32 行含 share 字样（仅 5 行含待迁移的 `settings_t.xml` 旧路径，见评审 P1-3）。
- 工作区：68 个引用文件（含 8 个 AGENTS.md、4 个工作区 docs、26 个历史构建产物）。
- 容器：45 个 `(user,agent)` 容器（约 30 运行）+ 75 个旧命名孤儿；运行时 1 个 host 用户（user 2，775 会话）。
- 实测（2026-11-09）：子路径挂载隔离（跨 Agent ENOENT）、容器内 `share/` 根可写、私有区 rw / ro 区 EROFS——均验证通过（测试容器已清理）。


