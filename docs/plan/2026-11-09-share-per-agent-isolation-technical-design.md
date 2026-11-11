# share 按 Agent 隔离（形态 C）技术方案

> 状态：**已实施（2026-11-09 晚）**：评审修复 → phase1/phase2 数据迁移 → 代码改造部署（backend 0.0.492，蓝绿切换 9080→9081）→ 部署后校验通过；**观察期 1 天**后执行 phase3 清理。执行记录见 §15。
> 评审报告：[2026-11-09-share-isolation-design-review-01.md](../code-review/2026-11-09-share-isolation-design-review-01.md)（含逐条修复记录）。
> 覆盖端：**backend-ts**（挂载/沙箱/启动兜底）+ 运维迁移脚本与文档。admin / desktop / android / agent-cli / shared-contracts **不改**。
> 上游调研：[2026-11-09-share-per-agent-isolation.md](../research/2026-11-09-share-per-agent-isolation.md)（v2，含泄露面核查与模式无缝性核验）。
> 迁移脚本：[`scripts/migrate-share-per-agent.sh`](../../scripts/migrate-share-per-agent.sh)（plan/verify 只读预演已验证）。
> 关联修订：取代 [2026-10-21 共享目录方案](./2026-10-21-shared-directory-technical-design.md) 的"全局共享投放"语义；修订 [2026-11-07 人+Agent 容器隔离方案](./2026-11-07-user-agent-container-isolation-technical-design.md) 决策 13（share 维持整根 rw）——两份历史文档已加"（部分）已被取代"抬头（2026-11-09）。

---

## 1. 需求背景

`/opt/mao-data/share` 当前以**整根 rw** 挂进每个 `(userId, agentId)` 容器（`container-mount-planner.ts:116`），目录里同时承载三类内容：

| 内容类 | 现路径 | 现状问题 |
|---|---|---|
| Agent 经验库 | `agent-experience/{1,3,4,5,6}/`（213 篇 .md，~1.5MB） | 容器内可直读**直写任何 Agent** 的库，隔离仅靠工作区软链 + 提示词（协作式，不防主动越界） |
| 管理员投放 | `settings.xml`、`settings_t.xml` | 全局一份，所有 Agent 共用；投放即全员可见 |
| 运维/Agent 脚本 | `scripts/`（15 个文件） | 混放共享，Agent 之间可互改 |

**决策演进**：2026-10-21 共享目录方案（全局投放）→ 2026-10-24 D10（经验库上 share、挂载 ro→rw）→ 2026-11-07 决策 13（因"还有管理员投放与运维共享文件"维持整根）→ **2026-11-09 需求方拍板：取消公共投放区、投放按 Agent 维度、实现 share 维度完全隔离**。

---

## 2. 需求描述

### 2.1 要做的（2026-11-09 拍板）

| # | 决策 | 内容 |
|---|---|---|
| 1 | **形态 C：双树私有 + 零公共区** | `agent-experience/{agentId}/`（经验库，**原位不动**）+ `agents/{agentId}/`（每 Agent 私有区：投放品、脚本、产物）；取消 `public` 一类公共面，管理员投放按 Agent 维度进行 |
| 2 | **本次仅做 share 的数据隔离改造** | `workspace / runtime / HOME(/tmp) / deps / uploads` 等用户级共享面维持现状（2026-11-07 决策 2/3），作为"平台隔离边界"明示；如需按 (user, agent) 拆分，另立专项 |
| 3 | **代码层不留兼容逻辑，存量数据迁移用脚本** | 不写运行时补链、不建宿主兼容软链；数据搬迁与引用更新由一次性脚本 `scripts/migrate-share-per-agent.sh` 完成 |
| 4 | **投放归属与节奏（2026-11-09 补充）** | `settings.xml → agents/{1,3,4,5}/`；`settings_t.xml → agents/6/`；`scripts → agents/{1,3,4,5,6}/scripts/`（每 Agent 一份）；phase3 前观察 **1 天**；不公告（当前仅 1 名管理员）；**先完善文档，暂不进入开发** |

### 2.2 不做的（非目标）

| 项 | 说明 |
|---|---|
| 用户级共享面拆分 | workspace/runtime/HOME/tmp/deps/uploads 维持用户级（决策 2）；本文只把它们的"存在事实"写入边界文档 |
| host 模式物理隔离 | host 执行在后端进程内、OS 层全可见，无法物理隔离；定性为"信任模式"（当前 host 用户仅 user 2/管理员本人） |
| 公共投放区 / 投放管理 UI | 取消 public；admin 投放管理页不做（沿用 2026-10-21 预留方向，未做） |
| 运行时/宿主兼容链接 | 决策 3：零兼容。旧路径断链由"引用更新脚本 + 提示词对照表"处理，不引入常驻兼容机制 |
| 经验库路径迁移 | `agent-experience/{A}` 原位保留（B′ 单树合并形态不采用，避免最大引用面变动） |
| 会话间隔离 / 同 Agent 跨用户隔离 | 明确不承诺（前者为既有边界，后者是团队经验库产品语义） |
| 投放品多副本自动同步 | 多 Agent 需要同一文件时逐份复制（文件很小、频率低）；不做分发服务 |

### 2.3 范围边界（承诺 / 不承诺）

- **承诺**：share 数据在 **docker 模式**下跨 Agent 零泄露（其他 Agent 目录在容器文件系统级不存在）；host/docker 模式路径无漂移（`/tmp` 为既有唯一例外）。
- **不承诺**：host 模式物理隔离；同用户跨 Agent 经"用户级共享面"的间接互见（A 把数据写进 workspace/runtime 等，同用户 B 可读）；同一 Agent 跨用户共享；管理员/宿主机 root 的全局可见性。

---

## 3. 架构总览

### 3.1 目录结构（最终态，宿主机 `MAO_SHARE_DIR` 根下）

```
/opt/mao-data/share/
├── README.md                       # 结构说明与投放指引（宿主机可见；容器不挂根，不可见）
├── agent-experience/{agentId}/     # 团队经验库（原位，路径不变；INDEX.md 自动生成）
└── agents/{agentId}/               # 每 Agent 私有区（新增）
    ├── settings.xml                # Maven 私服配置（agents/1,3,4,5 各一份）
    ├── settings_t.xml              # 测试环境 Maven 配置（仅 agents/6 一份）
    ├── scripts/                    # 脚本（原 share/scripts，agents/{1,3,4,5,6} 各一份；push_fast.sh 自引用按副本修正）
    └── …                           # 其它产物（conf/、模板等，自行组织）
```

顶层只保留 `README.md` / `agent-experience/` / `agents/`；原 `scripts/`、`settings*.xml` 迁移后删除（phase3）。

> 未来新增 Agent：平台首用自动建 `agents/{A}/` 空目录；`settings.xml` / `scripts` 等投放品需按需手动投放（**不复用其它 Agent 目录的文件**，避免隐式共享）。
> 现状备注（2026-11-09 复核）：share 根下另有一个**空目录 `repos/`**（2026-11-09 11:54 创建，无内容、无引用，疑似其他会话误建）；不影响本迁移，phase3 前确认归属，无用途则一并清理。

### 3.2 挂载清单变化（唯一的安全边界）

**Before**（现状）：

```
mounts = [userHome, workspace, runtime, deps, channel(u,a), userSkills, uploads, tmp(/tmp), dist(ro),
          share 整根 rw, skillViews(u,a) ro] + sessionWorkspaces
```

**After**（本方案）：

```
mounts = [userHome, workspace, runtime, deps, channel(u,a), userSkills, uploads, tmp(/tmp), dist(ro),
          {shareDir}/agent-experience/{agentId} rw,    ← 本 Agent 经验库
          {shareDir}/agents/{agentId} rw,              ← 本 Agent 私有区
          skillViews(u,a) ro] + sessionWorkspaces
```

- 两条均为**容器内路径 = 宿主机路径**（不引入翻译，路径恒等原则）。
- 挂载清单参与 `standardMountsFingerprint`：计划变更 → 存量容器下次使用**自动重建**一次（现成机制）。
- 隔离效果：`ls /opt/mao-data/share/agent-experience/`、`ls /opt/mao-data/share/agents/` 各只显示本 Agent；其他 Agent 目录 `No such file or directory`（2026-11-09 已用 `mao-runtime` 镜像实测）。

### 3.3 一次文件访问的路径解析

| 执行模式 | `{shareDir}/agent-experience/{A}` | `{shareDir}/agents/{A}` |
|---|---|---|
| docker | 子路径 rw 挂载（与宿主机同路径） | 子路径 rw 挂载 |
| host | 宿主机路径直接访问（沙箱允许根 = share 根，见 §5.6） | 同左 |

两模式路径逐字节一致、可达性对称——满足"host/docker 动态切换无路径漂移"的既有原则（`/tmp` 为唯一例外，见 §5.6）。

### 3.4 投放模型（替代公共区）

- **投放动作**：管理员/运维在宿主机 `cp` 文件到 `{shareDir}/agents/<目标AgentId>/`（或子目录）；目录级挂载即时生效（无需重启/重建容器）。
- **多 Agent 同文件**：逐个复制（可写临时分发脚本，不引入常驻机制）。
- **入口说明**：`share/README.md` 固化"投放指引 + 目录结构 + 迁移说明"（全文见附录 C）。

## 4. 技术选型与备选

| 选项 | 说明 | 结论 |
|---|---|---|
| **形态 C：双树私有（本方案）** | `agent-experience/{A}`（原位）+ `agents/{A}`；挂载 2 条 | ✅ 采用：经验库零迁移、最大引用面（213 篇文档/软链/admin/任务）零变动；改动面最小 |
| 形态 B′：单树合并 | 经验库迁入 `agents/{A}/experience` | ❌ 不采用：需动 `dirFor`/admin/软链目标 + AGENTS.md×8 + 任务×2 + 加经验库旧路径兼容；收益仅"一个 Agent 一个目录"的结构美学 |
| 挂载翻译（容器内把 share 根映射为私有根） | 宿主 `agents/{A}` → 容器 `share/` | ❌ 否决：违背路径恒等原则，host/docker 双模式分裂 |
| 兼容层（运行时补链 / 宿主软链） | 让旧路径继续可解析 | ❌ 不采用（决策 3）：共享物拆分为 per-agent 后旧路径无唯一目标；"重定向到本 Agent 对应物"属语义改写，引入隐含行为。直接更新引用（14 条规则/23 处，全部可枚举）更干净 |

**零兼容为何可行（评审关注点）**：
1. 经验库（最大引用面）原位 → 历史绝对路径引用（史料级）继续有效；
2. 需断的仅是 `share/scripts`、`share/settings*.xml`，其消费方全部可枚举并已清单化（DB 6 行 + 文件 14 条规则），脚本一次更新到位；
3. 历史消息中的旧路径为"不可改面"，接受断链（agent 失败后按提示词对照表自愈）；不为此引入常驻兼容机制。

---

## 5. 实现设计

### 5.1 挂载计划（`harness/container/container-mount-planner.ts`）

**`plan(userId, agentId, extraWorkspaces)` 变更**：

- 删除原 share 整根条目（现 `plan()` 内 `{ hostPath: under(shareDir,''), containerPath: 同, mode:'rw', purpose:'share' }`，L116）。
- 新增两条（用既有 `under(roots.shareDir, ...)` 生成，保证路径规范化一致）：

```ts
{ hostPath: this.under(this.roots.shareDir, 'agent-experience', a), containerPath: 同值, mode: 'rw', purpose: 'share' },
{ hostPath: this.under(this.roots.shareDir, 'agents', a),            containerPath: 同值, mode: 'rw', purpose: 'shareAgent' },
```

**`assertSafe(mounts, userId, agentId)` 变更**：

1. `expectedAgentPaths` 增加两条**精确路径断言**（与 skillViews/channel 同构）：
   - `share` → `{shareDir}/agent-experience/{a}`
   - `shareAgent` → `{shareDir}/agents/{a}`
   任何不等于该值的同 purpose 条目直接抛 `MountPlanError`（防扩到其他 Agent / 上级目录）。
2. rw "必须含 `/{userId}/` 段"规则：删除原 `isSharedShareRoot` 整根特例，替换为 **purpose 绑定的精确路径豁免**：`(purpose === 'share' && host === {shareDir}/agent-experience/{a}) || (purpose === 'shareAgent' && host === {shareDir}/agents/{a})`——不能只按路径判断，否则任意 purpose 只要路径恰好相等即可绕过 rw 段位规则（评审 P2-3）。伪造路径（如 `{shareDir}/agents/5x`、`{shareDir}/agents`、`{shareDir}/agent-experience/6`（agent=5 时））均被拒绝。
3. 保留 `assertShareDirIndependent`（share 根不得位于/等于任何按用户数据根）与 `skillViewsDir` 互斥校验，语义不变。
4. 注释更新：记录 2026-11-09 决策（形态 C，取代 2026-11-07 决策 13）。

**副作用**：
- `standardMountsFingerprint` 变化 → 存量容器一次性重建（预期）。
- `toDockerArgs` 自动产出 2 条 `--volume`，无需额外处理。
- `mkdir` 语义：rw 条目缺失由 `assertSafe` 统一 `mkdirSync`（`agents/{A}`、`agent-experience/{A}` 首用即建）。

### 5.2 容器运行时（`harness/container/runtime-agent.ts`）

1. `resolveRoots(agentId: number)`：由既有 env 推导（**不新增 env**）：
   - `shareDir = process.env.MAO_SHARE_DIR ?? '/opt/mao-data/share'`（现有）
   - `shareExperienceDir = join(shareDir, 'agent-experience', String(agentId))`
   - `shareAgentDir = join(shareDir, 'agents', String(agentId))`
   - 返回 `ContainerRoots`（见 5.3）新增两个字段。
2. 入口 `main`：
   - 读取 `MAO_CONTAINER_AGENT_ID`（既有注入、原先"无消费方"），校验为正整数，非法 `exit(1)`（与 `MAO_CONTAINER_USER_ID` 同口径）；
   - `new RuntimeAgent(socketPath, token, userId, agentId)`（构造器签名 +1 参数，仅多容器运行时内部使用）。
3. 启动顺序保持：时区对齐 → HOME 对齐 → 技能视图兼容链接（0.0.474，保留）→ runtime agent 连接。
4. **为何现在可以做硬依赖（评审 P2-2 补论证）**：原 2026-11-07 方案曾以"无消费方"为由不动 `MAO_CONTAINER_AGENT_ID`；本次把它变为硬依赖的依据：① 后端每次重启后 `entries` 为空，首次使用走 `docker run`，与同名旧容器（无该 env）冲突时经 `cleanupHalfCreated`（`docker rm -f`）清理后**以带 env 的参数重建**；`docker start` 路径不会复用无 env 的存量容器（失败路径已收口）。② 运行时启动失败 → `waitSocketReady` 超时 → 清理 → 下次重建的链路已存在，清理后参数携带 env，不会形成"持续重建失败"死循环。③ 存量容器本来就会因 `standardMountsFingerprint` 变化统一重建（§5.1 副作用），即使个别未被重建也会落到 ①。

### 5.3 容器内工具执行器（`harness/container/container-tool-executor.ts`）

1. `ContainerRoots` 接口：新增 `shareExperienceDir: string; shareAgentDir: string`（保留 `shareDir` 供经验索引根推导）。
2. 沙箱允许根（当前 L80-97，`addAllowedRoot(roots.shareDir)`）：改为：

```ts
this.pathSandbox.addAllowedRoot(roots.shareExperienceDir);
this.pathSandbox.addAllowedRoot(roots.shareAgentDir);
```

   —— 与挂载面严格一致（"挂载面即沙箱面"），不放行 share 根（避免"挂载不存在的路径却可在沙箱层放行"的双口径）。
3. 经验索引回调（L153-155）：`new ExperienceIndexService(path.join(shareDir, EXPERIENCE_ROOT_SUBDIR))` **保持原样**（经验库原位；`refreshIfUnderRoot` 按首段 agentId 定位，逻辑不变）。

### 5.4 启动装配（`create-app.ts` / `config/app-config.ts`）

1. `create-app.ts`（shareDir resolve+mkdir 处，**L286-287**；评审 P2-4 修正行号）：新增 `mkdirSync(join(shareDir, 'agents'), { recursive: true })`。
2. 宿主沙箱（L465-468，`pathSandbox.addAllowedRoot(shareDir)`）：**维持 share 整根不变**（理由见 §5.6）。
3. `config/app-config.ts:264`：仅更新注释（语义从"公共共享目录"改为"share 根（按 Agent 隔离）"），默认值不变。
4. `config/application.yml:76`（`share-dir: ${MAO_SHARE_DIR:/opt/mao-data/share}`）：值不变，实施时补注释说明"share 根，容器内按 Agent 子路径挂载"（评审 P2-7）。

### 5.5 经验库服务与 admin（零改动）

| 组件 | 结论 |
|---|---|
| `create-app.ts:527-528`（`ExperienceIndexService` root = `{shareDir}/agent-experience`） | 不变 |
| `ExperienceMountService`（工作区 `团队经验/` 软链目标 = `agent-experience/{A}`） | 不变 |
| admin 经验库 CRUD 路由（`agent-experience-library.routes.ts`） | 不变 |
| admin 会话文件浏览（`admin-session-files.routes.ts`，`experienceDirForSession`） | 不变 |
| `harness-service.ts:412`（每轮幂等重挂） | 不变 |

### 5.6 host 模式（维持弱边界）

- host 执行在后端进程内，文件系统全可见（shell 不过沙箱）；物理隔离不可实现。
- 沙箱允许根**维持 share 整根**（`create-app.ts:468`）：① 进程级共享实例无法按 Agent 收窄；② 收窄会与"旧路径断链"策略叠加产生新的行为差异；③ 维持现状 = 模式切换零回归。
- 当前 host 用户仅 user 2（管理员本人）。边界写入 §2.3 与投放文档。

### 5.7 显式不做的实现（防过度设计）

- ❌ 不新增 `prepareShareCompatLinks` / 宿主兼容软链 / 旧路径挂载条目；
- ❌ 不新增环境变量（容器内按既有 env 推导）；
- ❌ 不改 `MAO_SHARE_DIR` 语义、不改经验库 `dirFor`、不改 admin/软链目标；
- ❌ 不做 host 沙箱收窄、投放管理页、迁移双写。

## 6. 落地清单

### backend-ts

| 文件 | 改动 | 量级 |
|---|---|---|
| `src/harness/container/container-mount-planner.ts` | plan() 条目 1→2；assertSafe 精确断言 + 豁免替换；注释 | 中 |
| `src/harness/container/runtime-agent.ts` | `resolveRoots(agentId)`；入口读 `MAO_CONTAINER_AGENT_ID` 并校验；构造器签名 | 小 |
| `src/harness/container/container-tool-executor.ts` | `ContainerRoots` 增两字段；沙箱允许根替换 | 小 |
| `src/create-app.ts` | 启动建 `agents/` 目录 | 极小 |
| `src/config/app-config.ts` | 注释更新 | 极小 |
| `config/application.yml` | 注释说明（share 根、容器内按 Agent 子路径挂载；值不变） | 极小 |
| 测试：`container-mount-planner.spec.ts` / `runtime-agent.spec.ts` / `container-tool-executor.spec.ts` / `container-registry.spec.ts`（相关断言） | 见 §9.1 | 中 |

### 运维脚本

| 文件 | 说明 |
|---|---|
| `scripts/migrate-share-per-agent.sh` | 迁移脚本（新增，见 §7）；plan 只读预演已通过 |
| `share/README.md` | 由 phase1 生成（投放指引；全文附录 C） |

### 文档同步

- `skills/mao-cli/reference/{config,deploy,agent}.md`：目录说明、部署章节、经验库/投放段落改写（部署时 `deploy-mao.sh` 自动同步至 `/opt/mao-data/skills/mao-cli`，技能视图随指纹重建）；
- `DEPLOY.md`、`backend-ts/.env.example`（注释）、`CHANGELOG.md`（用户可见变更条目）；
- `docs/plan/2026-10-21-shared-directory-technical-design.md`：正文不改，加"已被 2026-11-09 方案取代"抬头。

### 不改清单

desktop / android / agent-cli / admin / shared-contracts / `deploy-mao.sh` / `e2e-setup.sh`（e2e 临时 shareDir 由 `create-app` 自动建子目录）。

---

## 7. 数据迁移（脚本化）

### 7.1 迁移总览与时序（全程无断点）

```
phase1（数据面，零风险）   备份 → 建 agents/{A} → 分发 settings（1/3/4/5）与 scripts（全 Agent） → README → 删试验副本
        ↓（旧路径继续可用：复制保留 + 旧容器整根挂载 + host 直读）
phase2（引用更新）         DB 前像落盘（db-before.sql）→ DB 6 行更新 + 5 行旧快照删除
        ↓                 + 文件 14 条规则（逐文件先备份；目标缺失即中止）
部署代码                  挂载 1→2 条；存量容器按指纹低峰自动重建
        ↓
verify --pre-phase3 + 回归  结构/残留/DB + 手工冒烟（§9.3）+ host 模式
        ↓（观察 ≥1 天；残留 WARN 收敛，仅剩根目录三项）
phase3（清理）            先打包 phase3-residual.tgz → 删除 share/scripts、share/settings*.xml
        ↓                （旧路径自此失效——已接受项）
verify --post-phase3      全量残留必须为 0（此时命中即 FAIL 的硬门槛）
```

### 7.2 脚本契约（`scripts/migrate-share-per-agent.sh`）

```
bash migrate-share-per-agent.sh plan                     # 默认：只读预演（不动任何文件/数据）
bash migrate-share-per-agent.sh apply --phase=1|2|3      # 分阶段执行（交互确认；--yes 跳过）
bash migrate-share-per-agent.sh verify [--post-phase3]   # 结构与残留校验（默认 pre-phase3 模式）
选项：--share-dir=DIR  --backend-env=FILE（默认 /opt/mao/backend-ts/.env）
     --allow-missing（phase2 规则目标文件缺失时放行）  --no-db（verify 显式跳过 DB 校验）
```

- **幂等**：目标存在即跳过；替换命中 0 次打印 `[0命中]` 并继续（真实性由 verify 残留扫描兜底）。
- **备份**：phase1 生成 `/opt/mao-data/backup/share-migrate-<ts>/share-full.tgz`；phase2 逐文件备份至同目录 `files/`，并在 apply 前导出 DB 前像 `db-before.sql`（REPLACE 语句，含 11 行）；phase3 将待删残留打包 `phase3-residual.tgz`。
- **原子性**：文件替换为 tmp + `os.replace`；目录复制先写临时名再 `mv`，中断重跑不留半截副本；副本内清理 `__pycache__`。
- **失败策略**：phase2 apply 时规则目标文件缺失 → 列出后中止（`--allow-missing` 显式放行）；DB 不可达 → 中止（phase2 必须更新 DB）；verify 的 DB 校验不可达时须 `--no-db` 显式跳过，否则计 FAIL。
- **退出码**：verify 的 FAIL>0 → 非 0。默认 pre-phase3 模式下，"旧路径残留"与"根目录待删项"以 WARN 计数（phase2 完成后应逐一归零）；`--post-phase3` 时全部计 FAIL。
- **凭据**：从 backend `.env` 读取，经 `MYSQL_PWD` 传递，不落盘不打印。
- **预演已验证**（2026-11-09）：plan 在现网只读跑通，14 条规则 23 处命中逐条核对；DB 只读预览正常；verify 迁移前基线为结构性 FAIL + 残留 WARN。

### 7.3 phase1 明细（数据面）

| 步骤 | 动作 | 说明 |
|---|---|---|
| 1 | `tar -czf <备份>/share-full.tgz -C /opt/mao-data share` | 迁移前全量备份（含经验库） |
| 2 | `mkdir -p share/agents/{1,3,4,5,6}` | 存量 Agent 目录 |
| 3 | `cp settings.xml → agents/{1,3,4,5}/`、`settings_t.xml → agents/6/` | 用户决策（2026-11-09）：settings.xml 给 agent 1/3/4/5；settings_t.xml 给 agent 6 |
| 4 | `cp -a scripts → agents/{1,3,4,5,6}/scripts`（每 Agent 一份；临时名 + 原子 mv，清理 `__pycache__`），并修正各副本 `push_fast.sh` 自引用（`/opt/mao-data/share/scripts` → 各自 `agents/<A>/scripts`） | 用户决策：scripts 全 Agent 各一份；task #96/#97 为历史行同步，见 §9.3 |
| 5 | 写 `share/README.md`（已存在则跳过） | 投放指引，附录 C |
| 6 | 删除试验副本 `agent-experience/{1,3,4,5,6}/share/` | 已确认的手动试验产物 |
| — | 复制而非移动 | 旧路径在过渡窗口内继续可用（零断点） |

### 7.4 phase2 明细（引用更新）

**DB（先落前像：`agent_experiences` ×4、`scheduled_task` ×2、`session_workspace_rules` ×5）**：

apply 前用 `mysqldump --no-create-info --skip-extended-insert --replace --skip-lock-tables --set-gtid-purged=OFF` 将三组行导出到 `$BK/db-before.sql`（生产 DB 账号无 RELOAD 权限，不能加 `--single-transaction`；三表分别为 `agent_experiences WHERE id IN (66,74,75,76)`、`scheduled_task WHERE id IN (96,97)`、`session_workspace_rules WHERE source_path='…/oc_6783…/AGENTS.md'`）。

```sql
-- #66（agent 6）
UPDATE agent_experiences SET content = REPLACE(content,
  '/opt/mao-data/share/settings_t.xml', '/opt/mao-data/share/agents/6/settings_t.xml')
WHERE id = 66 AND content LIKE '%/opt/mao-data/share/settings_t.xml%';

-- #74/#75/#76（agent 5/1/6，逐行生成 N=对应 agentId；追加"旧路径已迁移，勿自行重建"）
UPDATE agent_experiences SET content = REPLACE(content,
  '有需要跨用户共享的文件一律放到 /opt/mao-data/share 目录下',
  '本 Agent 的文件一律放到 /opt/mao-data/share/agents/N/ 目录下（share 已按 Agent 隔离，无跨 Agent 公共共享目录；旧路径已迁移，勿自行重建）')
WHERE id = <74|75|76> AND content LIKE '%有需要跨用户共享的文件一律放到 /opt/mao-data/share 目录下%';

-- #96/#97（agent 5；历史行同步：#96 已 finished=1、#97 已 deleted=1，仅保持存档一致，不作为回归依据）
UPDATE scheduled_task SET prompt = REPLACE(prompt,
  '/opt/mao-data/share/scripts/', '/opt/mao-data/share/agents/5/scripts/')
WHERE id IN (96,97) AND prompt LIKE '%/opt/mao-data/share/scripts/%';

-- 快照：删除 oc_6783 AGENTS.md 的 5 行旧快照（下一轮 resolve 未命中即按已更新文件重建）
DELETE FROM session_workspace_rules
WHERE source_path = '/opt/mao-data/workspace/feishu-chat/3/oc_67837a63395d608df8e766ba96919fe0/AGENTS.md'
  AND rules_text LIKE '%/opt/mao-data/share/settings_t.xml%';
```

每条 UPDATE/DELETE 后同连接执行 `SELECT ROW_COUNT();` 打印 affected rows；更新后打印四类旧串计数（期望 0）。

**文件（14 条规则 / 23 处，替换规则 = 路径前缀级）**：

| 替换规则 | 命中文件 | 次数 |
|---|---|---|
| `/opt/mao-data/share/settings.xml` → `.../agents/5/settings.xml` | 经验库 5：Redis 限流、二方包升级；user10 docs ×2 | 6 |
| `/opt/mao-data/share/settings_t.xml` → `.../agents/6/settings_t.xml` | 经验库 6：tag-center、rabbitmq；oc_6783 AGENTS.md | 4 |
| `/opt/mao-data/share/scripts/` → `.../agents/5/scripts/` | 经验库 5：NTX 大促、定时任务性能、ASCM 提前推单；本工作区 docs ×2 | 11 |
| `/opt/mao-data/share/tools/vtn-biz-cli-*` → `skill-views/<uid>/vtn-biz-cli` | 经验库 5：腾炬服务商（失效引用，人工复核措辞） | 2 |

> 完整文件清单（含绝对路径）见附录 A。**快照行为（评审 P1-3 修正）**：`session_workspace_rules` 是 per-session 冻结快照——`resolve()` 命中且 workspace 一致时直接返回快照文本（磁盘变化只打 `changed on disk but snapshot retained` 日志），仅**新会话**或**压缩提交**（`invalidate()`）才重读文件；因此 phase2 定向删除 oc_6783 的 5 行旧快照触发下轮重建，其余会话在新建/压缩后自然生效。工作区 AGENTS.md 的经验库路径引用**不在清单**（原位不变）。

### 7.5 phase3 明细（清理，观察后执行）

前置：① 代码已部署 ② `verify --pre-phase3` FAIL=0（残留 WARN 仅剩根目录三项）③ 观察 ≥1 天（无"旧路径不存在"类异常）。
动作：先打包 `$BK/phase3-residual.tgz`（scripts、settings.xml、settings_t.xml）→ `rm -rf share/scripts`、`rm -f share/settings.xml share/settings_t.xml`（若确认 `repos/` 等无用途空目录，亦在此步一并清理）；顶层复核仅剩 `README.md / agent-experience / agents`。之后 `verify --post-phase3` 必须 FAIL=0。

### 7.6 verify（校验）

- **模式**：默认 `pre-phase3`（待清理/待收敛项记 WARN，不计 FAIL）；`--post-phase3` 时全部残留计 FAIL。
- **结构（硬性）**：README、`agents/{1,3,4,5,6}`、`agents/{1,3,4,5}/settings.xml`、`agents/6/settings_t.xml`、`agents/{1,3,4,5,6}/scripts/skill-cli-health-check.py`、试验副本已清除（find 退出码 + 空输出双重判定）、各副本 `push_fast.sh` 自引用已更新。
- **残留扫描**：`agent-experience/**/*.md`、`agents/{1,3,4,5,6}/scripts`、13 个规则目标文件，模式 `/opt/mao-data/share/{scripts,settings,tools}`；命中输出行号并计数（pre=WARN / post=FAIL）。
- **规则目标文件缺失**：直接 FAIL（提示核对改名/合并，防止 #76 周度合并造成的静默失配）。
- **根目录旧残留**（scripts、settings.xml、settings_t.xml）：pre=WARN / post=FAIL。
- **DB**：四类计数——scheduled_task 旧路径、agent_experiences 旧共享文案、agent_experiences settings_t 旧路径、session_workspace_rules 旧快照；DB 不可达须 `--no-db` 显式跳过，否则 FAIL。
- 输出容器级验证命令（手工执行，§9.2）。

### 7.7 回滚

数据：恢复 `share-migrate-<ts>/`（tarball + 文件副本）+ 回滚部署；容器按指纹重建回旧挂载。DB：`MYSQL_PWD=… mysql -h… <db> < $BK/db-before.sql`（REPLACE 语句，覆盖 11 行前像；快照 5 行无需恢复，下轮自动重建）。因 phase1"复制保留"，回滚窗口无数据丢失；phase3 前任何阶段可回滚，phase3 后回滚需从 `share-full.tgz` / `phase3-residual.tgz` 恢复旧残留。

### 7.8 异常与幂等

| 场景 | 行为 |
|---|---|
| 重复执行同阶段 | 跳过已存在项；替换 0 命中打印 `[0命中]` 并继续（verify 残留扫描兜底真实性） |
| DB 不可达 | phase2 apply 直接中止（DB 更新必做）；plan 预演跳过；verify 须 `--no-db` 显式跳过 |
| 规则目标文件缺失 | phase2 apply 列出清单后中止；核对改名文件更新 FILE_RULES，或 `--allow-missing` 放行（verify 仍会 FAIL 提示） |
| phase1 中断重跑 | 目录复制走临时名 + 原子 mv，不留半截副本；目标已存在且不一致时保留现状并告警 |
| 部分文件被并发修改 | 逐文件"备份 → 原子替换 → 打印命中数"；备份额外兜底 |
| 目标目录已有内容（人工先建） | `[已存在且不一致！保留现状，需人工确认]` 输出告警，不覆盖 |

## 8. 上下文引导（存量引用治理）

### 8.1 机制（两层 + 接受项）

- **提示层（主通道）**：更新 `agent_experiences` 4 条（phase2）→ 系统提示每轮重建，**全部存量会话下一轮即生效**，无需新开会话。
- **工作区规范快照层**：`session_workspace_rules` 为 per-session 冻结（`resolve()` 命中即返回快照文本，仅新会话或压缩提交才重读文件）→ phase2 对 oc_6783 `AGENTS.md` 的 5 行旧快照定向删除以立即重建；其余工作区在新建会话/压缩后自然生效（评审 P1-3）。
- **文档层**：附录 A 清单逐一更新 + `share/README.md` + `skills/mao-cli` 文档。
- **接受项**：历史消息（1229 条/454 会话）中的旧路径不改写；phase3 后其引用失效，agent 失败后按提示词对照表自愈。**不为此引入运行时兼容代码**（决策 3）。

### 8.2 提示词文案终稿（phase2 写入 DB）

- #66（agent 6）替换后：
  > 当前所涉及的项目的Maven配置文件统一使用 /opt/mao-data/share/agents/6/settings_t.xml，禁止使用默认配置文件；找 jar/class 先搜 ~/.m2/repository 和已知仓库，不要 find /。
- #74/#75/#76（agent 5/1/6）替换后（N=对应 agentId）：
  > 避免在工作区根目录下存放临时文件（脚本、工作产物等），不定时的治理工作区子目录/文件以保持工作区结构良好；禁止在系统目录中存放共享文件，本 Agent 的文件一律放到 /opt/mao-data/share/agents/N/ 目录下（share 已按 Agent 隔离，无跨 Agent 公共共享目录；旧路径已迁移，勿自行重建）。

> 附加提示（评审 P2-7）：phase3 后 `/opt/mao-data/share/scripts`、`settings*.xml` 不再存在；容器内 `/opt/mao-data/share` 只是挂载父路径自动创建的空目录——**不要在其中自行重建同名文件/目录**（会造成"本容器可用、他处/重建即失效"的假象）。

### 8.3 新旧路径对照表

| 旧路径 | 新路径 |
|---|---|
| `/opt/mao-data/share/settings.xml` | `/opt/mao-data/share/agents/5/settings.xml` |
| `/opt/mao-data/share/settings_t.xml` | `/opt/mao-data/share/agents/6/settings_t.xml` |
| `/opt/mao-data/share/scripts/<脚本>` | `/opt/mao-data/share/agents/5/scripts/<脚本>` |
| `/opt/mao-data/share/agent-experience/{A}` | **不变** |
| `/opt/mao-data/share/tools/...`（历史） | 已失效（改用 skills / skill-views） |
| （新增） | `/opt/mao-data/share/agents/{A}/`（私有区） |
| 工作区 `团队经验/` | **不变**（平台每轮自动指向 `agent-experience/{A}`） |

---

## 9. 测试要点

### 9.1 单测（backend-ts）

| 用例 | 断言 |
|---|---|
| `mountsIncludeOwnShareTrees` | `plan(7, 5)` 含 `{share}/agent-experience/5` 与 `{share}/agents/5`（rw、容器路径=宿主路径）；**不含** share 整根 |
| `rejectsForeignAgentShareMount` | 伪造 `{share}/agents/6`（agent=5）→ `MountPlanError` |
| `rejectsShareParentPath` | 伪造 `{share}/agents` / `{share}/agent-experience` → 抛错 |
| `rejectsLookalikePath` | `{share}/agents/5x` → 抛错（精确匹配） |
| `shareEntriesRequireExactAgentPath` | purpose=share/shareAgent 且路径不等于期望 → 抛错 |
| `mountFingerprintChanges` | 新计划的 `standardMountsFingerprint` ≠ 旧整根版本（保证存量重建） |
| `runtimeRootsDeriveFromEnv` | `MAO_SHARE_DIR` + `MAO_CONTAINER_AGENT_ID` → 两路径正确；agentId 缺失/非法 → 抛错/退出 |
| `executorAllowedRoots` | 允许根 = 两路径；`agents/6` 路径在 strict 解析下被拒 |
| `shareDirIndependent`（回归） | 既有断言保持（share 根不得位于按用户根下等） |

### 9.2 容器级验证（部署后手工）

```bash
docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agent-experience/     # 仅 5
docker exec mao-user-36-agent-5 ls /opt/mao-data/share/agents/               # 仅 5
docker exec mao-user-36-agent-5 cat /opt/mao-data/share/agent-experience/6/x 2>&1   # ENOENT
docker exec mao-user-36-agent-5 sh -c 'echo x > /opt/mao-data/share/agents/5/.t && rm /opt/mao-data/share/agents/5/.t'  # 可写
docker inspect mao-user-36-agent-5 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}' | grep share   # 仅两条
```

### 9.3 业务回归（评审 P1-5 重写：#96/#97 已失效，改手工冒烟）

- 手工冒烟（容器内执行，验证"脚本新路径可执行"）：
  - agent 5：`python3 /opt/mao-data/share/agents/5/scripts/skill-cli-health-check.py --help`、`bash /opt/mao-data/share/agents/5/scripts/push_flow.sh`（无参/状态类只读子命令）；
  - agent 6：`mvn -s /opt/mao-data/share/agents/6/settings_t.xml -v`；
- 副本齐全性抽查：`ls /opt/mao-data/share/agents/{1,3,4}/settings.xml`、`ls /opt/mao-data/share/agents/{1,3,4,6}/scripts/`（每 Agent 一份）；
- host 模式（user 2）会话：读 `团队经验/`、`agents/5/` 正常；
- admin 经验库列表/预览正常（路径未变）。

> 说明：`scheduled_task` #96（once，finished=1）与 #97（deleted=1）均为已完结历史行，phase2 仅同步 prompt 存档，**不作为回归依据**；当前唯一活跃且引用 share 的任务是 #76（只引用未变的 `agent-experience/5`）。

### 9.4 E2E / 回归范围

- E2E（Playwright，host 模式为主）不受影响（share 无 UI 面；e2e 临时 shareDir 由 create-app 自动建 `agents/`）；
- backend 全量单测绿（含新增用例）；构建产物 `dist` 重启后容器按 `runtimeBuildId` 漂移自动重建。

---

## 10. 发布方案

### 10.1 发布顺序

1. `migrate ... apply --phase=1`（零风险；旧路径继续可用）；
2. `migrate ... apply --phase=2`（引用更新：DB 前像先落盘；旧容器整根挂载亦可见新路径）；
3. 合入代码 → `cd /data && bash deploy-mao.sh --backend-only`（蓝绿切换；`deploy-mao.sh` 自动同步 `skills/mao-cli`）；
4. `migrate ... verify --pre-phase3` + §9.2/§9.3 回归（要求 FAIL=0；残留 WARN 仅剩根目录三项）；
5. 观察 ≥1 天（低峰）→ `migrate ... apply --phase=3` → `migrate ... verify --post-phase3`（要求 FAIL=0）。

### 10.2 观察项与回滚触发

- 观察：容器重建日志（`[container] recreating`）、"路径不存在"类会话反馈、§9.3 手工冒烟结果、admin 经验库读写、后端 ERROR 日志。#96/#97 为已完结历史任务，不再作为观察信号。
- 回滚触发：出现由本改造导致的容器创建失败/挂载异常/任务连续失败 → 回滚部署 + 恢复备份（§7.7）。

### 10.3 运维注意

- **投放习惯变化**：不再有"投一次全员可见"；投放必须落到目标 Agent 目录（写入 README）。
- **备份规范**：备份放 `/opt/mao-data/backup`，**禁止放 `{tmpDir}/{uid}` 等用户挂载面**（用户级共享面会被同用户所有 Agent 容器读到）。
- **旧路径勿自建**：容器内 `/opt/mao-data/share` 只是挂载父路径自动创建的空目录；旧 `scripts/`、`settings*.xml` 不再存在，会话若提示缺失按 §8.3 对照表迁移引用，不要重建同名文件。

---

## 11. 风险与开放问题

### 11.1 风险

| 风险 | 等级 | 缓解 |
|---|---|---|
| 存量容器一次性重建打断在途 shell/终端 | 中 | 低峰发布；机制为历次升级既定路径（0.0.473/474 已两次验证） |
| 旧引用断链（历史消息/用户习惯） | 中 | 清单全覆盖（附录 A）+ 提示词对照表；接受项 |
| 投放品多副本更新一致性 | 低 | 文件小、频率低；需要时写分发脚本 |
| host 模式/用户级共享面旁路 | 中（已知） | 边界写入 §2.3；如需"零泄露全称"另立专项 |
| 迁移脚本误操作 | 低 | 默认 plan 只读；apply 分阶段 + 逐阶段确认；全量备份；幂等 |

### 11.2 决策与待确认项

**已确认（2026-11-09 用户回复）**：

1. **投放归属**：`settings.xml → agents/{1,3,4,5}/`（每 Agent 一份）；`settings_t.xml → agents/6/`；`scripts → agents/{1,3,4,5,6}/scripts/`（每 Agent 一份，`push_fast.sh` 自引用按副本修正）。
2. **phase3 观察期**：**1 天**。
3. **公告**：不公告（当前仅 1 名管理员/运维）。
4. **节奏**：先完善文档，**暂不进入开发与迁移执行**（apply 需用户放行）。
5. **历史方案文档抬头（2026-11-09 补充确认）**：`2026-10-21`、`2026-11-07` 两份历史文档已加"（部分）已被取代"抬头，正文不改。

**待确认**：无（实施已于 2026-11-09 晚执行，见 §15；仅剩 phase3 待 1 天观察期后执行）。

---

## 12. 工作量估算

| 阶段 | 内容 | 预估 |
|---|---|---|
| ① 数据面迁移（脚本已就绪） | 备份 + phase1/2 执行 + 校验 | 0.5 人日 |
| ② 代码改造 + 单测 | planner/runtime-agent/executor/create-app + 测试（spec 需反向改写：`container-tool-executor.spec.ts` 的 `readsFileUnderShareRoot` 断言反转、planner spec 的 `shareDirMissingIsTolerated` 与 share 指纹用例调整） | 1.5~2 人日 |
| ③ 文档与引导面 | agent_experiences/任务（脚本已覆盖）+ 技能文档/CHANGELOG/DEPLOY | 0.5 人日 |
| ④ 发布、回归与观察清理 | 部署 + verify + 观察 + phase3 | 0.5 人日 |
| **合计** | | **约 2.5~3 人日**（评审 P2-7 上调） |

---

## 13. 已确认决策摘要（2026-11-09）

| # | 决策 | 结论 |
|---|---|---|
| 1 | 形态 | **C：双树私有 + 零公共区**（`agent-experience/{A}` 原位 + `agents/{A}`），经验库路径不变 |
| 2 | 范围 | **仅 share 维度**；五件套等用户级共享面另立项 |
| 3 | 兼容与迁移 | **代码零兼容**；存量数据迁移走 `scripts/migrate-share-per-agent.sh`（plan/apply phase1-3/verify，默认只读） |
| 4 | 投放 | 管理员投放按 Agent 维度（目标 Agent 目录），无公共区、无 UI |
| 5 | host 模式 | 信任模式（维持现状沙箱），明示边界 |
| 6 | 投放归属（2026-11-09 补充） | `settings.xml → agents/{1,3,4,5}/`；`settings_t.xml → agents/6/`；`scripts → agents/{1,3,4,5,6}/scripts/`（每 Agent 一份） |
| 7 | 观察期 | phase3 前观察 **1 天** |
| 8 | 公告与节奏 | 不公告（仅 1 名管理员）；先完善文档，暂不进入开发 |

---

## 14. 附录

### A. 引用更新清单（phase2 全量，14 条规则 / 23 处）

| # | 文件（绝对路径） | 替换 |
|---|---|---|
| 1 | `share/agent-experience/5/2026-11-05-应用接入Redis集群限流并发布测试环境.md` | settings.xml ×1 |
| 2 | `share/agent-experience/5/2026-11-03-二方包升级兼容性验证.md` | settings.xml ×2 |
| 3 | `share/agent-experience/5/2026-11-05-NTX大促推单与预售统计口径.md` | scripts ×2 |
| 4 | `share/agent-experience/5/2026-11-06-定时任务性能评估.md` | scripts ×2 |
| 5 | `share/agent-experience/5/2026-10-25-ASCM提前推单.md` | scripts ×3 |
| 6 | `share/agent-experience/5/2026-10-27-腾炬服务商查询鉴权与业绩趋势.md` | tools 失效引用 ×2（人工复核） |
| 7 | `share/agent-experience/6/2026-11-06-tag-center标签数据未找到排查.md` | settings_t.xml ×1 |
| 8 | `share/agent-experience/6/2026-11-06-rabbitmq-406-unknown-delivery-tag排查.md` | settings_t.xml ×1 |
| 9 | `workspace/feishu-chat/3/oc_67837a63395d608df8e766ba96919fe0/AGENTS.md` | settings_t.xml ×2 |
| 10 | `workspace/10/projects/feishu-chat-2-oc_155c79d46f86b12ec34fbb46e12e094e/docs/agents/goods-hulk-redis-limit.md` | settings.xml ×1 |
| 11 | `workspace/10/projects/feishu-chat-2-oc_155c79d46f86b12ec34fbb46e12e094e/docs/agents/market-coupon-service-recbest-combination-cpu.md` | settings.xml ×2 |
| 12 | `workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/docs/agents/skill-cli-health-check.md` | scripts ×2 |
| 13 | `workspace/feishu-chat/2/oc_fb9ef40b6ff5b0c8cae6814f97c59a94/docs/agents/skill-view-deployment.md` | scripts ×2 |
| 14 | （DB）`agent_experiences` #66/#74/#75/#76、`scheduled_task` #96/#97、`session_workspace_rules` oc_6783 ×5 | SQL 见 §7.4（前像导出 db-before.sql） |

**已核查、按历史面接受（评审 P2-6，不改）**：

- `workspace/13/projects/feishu-2-private-13/repos/bill/docs/requirements/20261105-…/{change-list.md,technical-design.md}`：4 处 `mvn -s /opt/mao-data/share/settings.xml`（第三方仓库历史需求文档）；
- `workspace/feishu-chat/2/oc_59b2…/work/tengju/PLAN_4292880.md`：引用已不存在的 `share/tools/vtn-biz-cli-0.8.7`（历史计划稿）；
- 本工作区 `chat-files/analysis/reports/*/*.json`：历史命令快照（含 `share/scripts/mao-mysql.sh`、`share/settings.xml`）。

### B. 关键代码索引

| 事实 | 位置 |
|---|---|
| share 整根挂载条目 / 豁免 / 独立性校验 | `backend-ts/src/harness/container/container-mount-planner.ts:116`（整根条目）, `135-158`（`assertShareDirIndependent`）, `209 起`（`assertSafe`；263 整根特例）, `312`（`toDockerArgs`）, `326`（`standardMountsFingerprint`） |
| 容器名与指纹漂移重建 | `container-registry.ts:253-255, 395（ensureRunning 定义）, 511-513` |
| `MAO_SHARE_DIR` / `MAO_CONTAINER_AGENT_ID` 注入 | `container-registry.ts:799, 816` |
| 容器内沙箱允许根 / 经验索引回调 | `container-tool-executor.ts:80-97, 153-155` |
| 容器运行时 roots 解析入口 | `runtime-agent.ts:40-48`（`resolveRoots`）、入口 main |
| 宿主沙箱 share 允许根 / 启动 mkdir | `create-app.ts:286-287, 465-468` |
| 经验库服务构造 | `create-app.ts:527-528` |
| 经验库索引/挂载/路径解析 | `experience-index.service.ts` / `experience-mount.service.ts` / `experience-mount-path.ts` |
| 每轮幂等重挂软链 | `harness-service.ts:412` |
| host/docker 模式动态解析 | `RuntimeModeResolver`（`app-container-runtime.ts:138-169`） |
| 技能视图历史兼容（对照先例，本方案不新增同类） | `runtime-agent.ts` `prepareSkillViewCompatLinks`（0.0.474） |

### C. `share/README.md` 内容（phase1 生成）

```markdown
# /opt/mao-data/share 结构说明与投放指引（2026-11-09 起）

本目录已按 Agent 隔离，不再有全员共享的公共投放区。

## 结构
- `agent-experience/{agentId}/`：团队经验库（平台管理；Agent 会话内经工作区 `团队经验/` 软链访问）。
- `agents/{agentId}/`：该 Agent 的私有区（脚本、配置、产物、投放品）。

## 管理员/运维投放指引
- 投放：把文件放到 `agents/<目标AgentId>/`——目录级挂载，即时生效（无需重启/重建容器）。
- 多 Agent 需要同一文件时逐个复制（无公共区）。
- 备份请放 `/opt/mao-data/backup`（勿放任何用户挂载面，避免经用户级共享面泄露）。

## 迁移说明（2026-11-09）
- 原 `share/scripts` → `agents/{1,3,4,5,6}/scripts/`（每个 Agent 一份）；`share/settings.xml` → `agents/{1,3,4,5}/`；`share/settings_t.xml` → `agents/6/`。
- `agent-experience/{agentId}/` 路径不变。
```

### D. 迁移脚本

`scripts/migrate-share-per-agent.sh`（本次交付，569 行）：`plan`（默认只读）/ `apply --phase=1|2|3` / `verify [--post-phase3]`；选项 `--yes`、`--share-dir`、`--backend-env`、`--allow-missing`、`--no-db`。阶段与动作见 §7；评审修复记录见 `docs/code-review/2026-11-09-share-isolation-design-review-01.md`。

---

## 15. 执行记录（2026-11-09 晚，实际落地）

| 时间 | 动作 | 结果 |
|---|---|---|
| 20:51 | `apply --phase=1`：全量备份 → 建 `agents/{1,3,4,5,6}` → 分发 settings.xml(1/3/4/5)、settings_t.xml(6)、scripts(5 份，含 push_fast 自引用修正) → README → 删试验副本 | 完成；备份 `backup/share-migrate-20261109-205123/share-full.tgz` |
| 20:52 | **当日新增 agent 7（服务商助手，18:13 创建）后补**：建 `agents/7/scripts`（含自引用修正）；脚本 `AGENTS` 更新为 `1 3 4 5 6 7`；`db_apply_updates` 增 `94:7` | 完成（agent 2 未启用：无经验库/会话，按懒建处理） |
| 20:52 | `apply --phase=2`：DB 前像 `db-before.sql` → #66/#74/#75/#76、#96/#97（历史行）、删 5 行旧快照 → 14 条文件规则（23 处） | 完成；校验后补录 #94 前像（共 12 行） |
| 20:53 | 后补 `agent_experiences #94`（agent 7 共享文案 → `agents/7/`）；修正 agent 1 当日新写经验文档 2 处 `settings.xml` 旧路径 | 完成 |
| 20:53 | `verify --pre-phase3` | OK=39 / FAIL=0 / WARN=1（仅根目录待删残留） |
| 20:55-21:02 | 代码改造 + 单测：`container-mount-planner` / `container-tool-executor` / `runtime-agent` / `create-app`（+app-config/.env.example 注释）+ 4 个 spec 反向改写 | `tsc` 通过；容器 4 spec 91 项、backend 全量 5794 项通过（15 skipped） |
| 21:02 | 提交 `977eab84`（0.0.492，含 CHANGELOG / skills 文档 / DEPLOY.md）并推送（变基至远端 0.0.491 之后） | 完成 |
| 21:03-21:05 | `cd /data && bash deploy-mao.sh --backend-only`：拉取 → 构建（runtime-build `df940c30…`）→ 蓝绿切换 9080→9081，健康检查 HTTP 302 | 完成 |
| 21:05-21:10 | 部署后校验：`verify --pre-phase3` PASS；user5/agent1（21:05）、user58/agent5（21:08）容器已自动重建为新挂载（仅两条 share 子路径）；容器内跨 Agent 访问 ENOENT、私有区可写、`agents/5/settings.xml` 可读、脚本冒烟（`bash -n` 全过、push_flow 用法输出）通过；后端日志无 share 相关错误 | 完成 |
| 11-09 21:10 | **观察期开始（1 天）** | 至 11-10 21:30 观察期满 |
| 11-10 21:30 | 观察期满预检（定时任务，只读）：`verify`（pre-phase3）**OK=38 / FAIL=0 / WARN=2**；容器面 9 个运行中全部新双路径挂载、96 个旧整根容器均为停止态（待用时按指纹重建，观察期内已自动重建 26 次无失败）；24h 日志 **0 条 share/路径类 ERROR**；会话 106 个（103 完成 / 2 取消 / 1 运行中），仅 2 次旧路径调用（`push_flow.sh`），会话均自行改用新路径完成 | 满足 phase3 前置 |
| 11-10 21:30 | 修正经验库 1 处旧路径引用：`agent-experience/5/2026-11-05-NTX大促推单与预售统计口径.md`（11-10 更新文档时带入的「`/opt/mao-data/share/scripts/` 有副本」改为「同版脚本各 Agent 均有一份」） | 完成 |
| 11-10 22:47 | `apply --phase=3 --yes`：自动打包 `backup/share-migrate-20261110-224758/phase3-residual.tgz`（19 个文件，含 scripts 全量 + settings.xml + settings_t.xml）→ 删除根下 `scripts/`、`settings.xml`、`settings_t.xml` | 完成；顶层仅剩 `agent-experience/`、`agents/`、`README.md`、`repos/`（空，按约定忽略） |
| 11-10 22:48 | `verify --post-phase3` | **OK=40 / FAIL=0 / WARN=0，PASS** |
| 11-10 22:48 | 运行容器抽查（mao-user-59-agent-5）：share 根仅 `agent-experience` + `agents`；本 Agent 脚本 14 个齐全；旧根 `scripts/` 已不存在 | 通过 |

> 备注：① 旧容器（尚未使用过的）将在下次使用时按指纹漂移自动重建为新挂载，属预期一次性收敛；② `share/repos` 空目录按用户决定忽略（不清理）；③ 观察期关注「旧路径不存在」类反馈与 `[container] recreating` 日志。



