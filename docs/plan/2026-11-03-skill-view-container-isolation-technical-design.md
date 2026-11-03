# 技能视图（Skill View）：容器技能挂载收口技术方案

> 日期：2026-11-03　状态：**已评审（2026-11-03 确认：用户级 + 视图 ro）/ 未实施**
> 补充评审（2026-11-03）：可行性通过。本轮按代码事实核对与本机复现补齐 10 处（host 沙箱口径、源删除清理逻辑、指纹与 rsync mtime、env 与容器重建耦合、测试/文档引用修正等），索引见 §12。
> 目标读者：Mao 后端与容器运行时维护者
> 相关历史：`66c77a36`（copy → 软链）、`30378b0b`（平台技能目录 ro → rw）、`0.0.393`（docker 读技能被判符号链接逃逸）、`0.0.394`（容器代码漂移自动收敛）

---

## 1. 背景与问题

### 1.1 现状

会话技能同步（`SkillSyncService.syncToSession`）把「系统技能 + 用户技能」以**符号链接**挂到会话 runtime 目录：

```
/opt/mao-data/runtime/{userId}/{sessionId}/skills/{name}
  ├── 系统技能 → /opt/mao-data/skills/{name}
  └── 用户技能 → /opt/mao-data/userskills/{userId}/{name}
```

docker 模式下，容器挂载清单（`ContainerMountPlanner.plan`）包含：

| purpose | 宿主路径 | 模式 | 说明 |
|---|---|---|---|
| `skills` | `/opt/mao-data/skills`（整根） | **rw** | 会话技能软链的目标根；同时用于"容器内安装/更新共享技能" |
| `userSkills` | `/opt/mao-data/userskills/{userId}` | rw | 用户个人技能 |
| `runtime` | `/opt/mao-data/runtime/{userId}` | rw | 含会话技能软链目录 |

实测规模（2026-11-03）：全系统会话技能条目 **828 条，100% 为软链**；当前 33 个会话目录持有技能；全局技能源 17M（去备份 12M / 926 文件 / 30+ 技能）。

### 1.2 问题

1. **授权形同虚设**：`agent.skillNames` 只作用于提示词注入（告诉 Agent 有哪些技能），文件系统层没有任何收口——任何用户容器都能 `ls`、`cat`、`npm install` 全部技能。
2. **跨用户可写**：`skills` 整根 rw 挂载，任一容器内 root 都能修改/删除全局技能，影响所有用户（误操作或恶意注入的代价都是一等公民级）。
3. **写穿透**：会话技能是软链，容器内"编辑技能文件"实际改的是共享源；某次会话的临时改动会静默影响所有人。
4. **沙箱被迫复杂化**：软链要求目标在容器内可见 → `0.0.393` 被迫把 `skillsDir` 登记为 strict 沙箱允许根、注入 `MAO_SKILLS_DIR`；随后为让该修复进容器又催生 `0.0.394` 的构建指纹与懒重启机制。

### 1.3 历史包袱（本次改造需要正视）

- `66c77a36`（2026-09-15）把「copy 到会话目录」改为软链，理由：① 技能内 CLI `npm install . -g` 后副本被清理 → CLI 悬空；② 技能源更新需即时生效；③ 清理副本不动源。**本方案不能把这些理由重新变成问题**。
- `30378b0b`（2026-10-19）把 `skills` 挂载由 ro 改为 rw，为「容器内安装/更新共享技能」留通道。产品侧已确认：**该场景几乎没有，可以取消**。

---

## 2. 目标与非目标

### 2.1 目标

| 编号 | 目标 | 验收口径 |
|---|---|---|
| G1 | 容器内技能可见面收敛到「该用户被授权的技能」 | 容器内不存在 `/opt/mao-data/skills`；可见技能集合 ⊆ 该用户会话被物化的技能 |
| G2 | 共享技能在容器内只读 | 对视图目录的任何写操作返回 `EROFS`；源目录不可见 |
| G3 | 技能与 CLI 正常使用 | 容器内可读 `SKILL.md`、`npm install . -g` 成功、命令可执行、会话清理后 CLI 仍可用 |
| G4 | 技能更新可传播 | 源更新（部署/上传/ECP）后，该用户下次执行会话即生效 |
| G5 | 不破坏既有机制 | 清理器、蓝绿部署、容器懒重建、`0.0.394` 漂移收敛均不受影响 |

### 2.2 非目标

- **会话级 / Agent 级隔离**：容器是每用户一个，同用户多会话共享容器与 root，文件可见性无法按会话细分。做到 Agent 级只能"每会话一个容器"，资源与复杂度成本不值当（详见 §2.3）。
- **容器内更新共享技能**：产品已确认无真实场景，本次直接取消该能力（共享技能更新走部署 / 管理后台 / `skill-docs` API）。
- **LOCAL 模式技能分发**：客户端 zip 解压链路（`writeSyncZip`）不变。

### 2.3 粒度边界（必须向使用方明确）

```
能做到                                     做不到
─────────────────────────────────────     ─────────────────────────────────────
用户 A 的容器看不到/改不了 B 的任何数据        同一用户下 agent1 会话看不到 agent2 的技能文件
容器内只有 A 被授权过的技能                    按会话动态挂载/卸载技能
共享技能源对容器不可见、不可写                  容器内直接发布/更新共享技能
```

原因：容器 = `mao-user-{userId}`，同用户的所有会话共用同一容器、同一 root 用户、同一文件系统；权限位在容器内 root 面前无效。**用户级就是当前架构的隔离上限**，本方案把"全员共享全量"收紧到"个人授权集"。

---

## 3. 方案总览

核心思路：**技能源永不进容器；容器只挂「该用户被授权技能的只读视图」，会话技能目录仍用软链——但目标是视图而不是源。**

```
宿主（持久数据）                                        容器内（同一路径空间）
──────────────────────────────────────────────────     ──────────────────────────────
/opt/mao-data/skills                     ── ✗ 不挂载
  └── {name}/  ← 唯一权威源
/opt/mao-data/skill-views/{userId}/      ── ro ───────→  同路径（视图，按需物化）
└── {name}/         系统技能副本（路径稳定；容器内只见技能，无元数据）
/opt/mao-data/skill-views/.meta/{userId}/{name}.json  指纹与溯源（挂载外，容器不可见）
/opt/mao-data/skill-views/.tmp/{userId}/ ── ✗ 不挂载（原子替换暂存区）
/opt/mao-data/userskills/{userId}/       ── rw ───────→  同路径（个人技能，可编辑）
/opt/mao-data/runtime/{userId}/          ── rw ───────→  同路径
  └── {sessionId}/skills/{name}  → 软链：系统技能指 view / 用户技能指 userskills
```

数据流：

```
源更新（部署 rsync / 管理后台上传 / ECP 下发）
  └→ 下次会话执行前 sync：比对源指纹 → 过期则原子重建视图（宿主侧完成）
       └→ 会话技能软链指向视图路径（路径稳定）→ 容器内立即可读
            └→ Agent 通过 read_file / shell / CLI 消费（视图只读）
```

### 3.1 三个关键决策

1. **为什么是「用户级视图」而不是「copy 到会话目录」**：copy 到会话目录会让 `npm install -g` 的链接指向会话副本，副本被清理即悬空——正是 `66c77a36` 当年要解决的问题。视图是用户级持久目录：CLI 链接经 realpath 指向视图路径，**永不悬空**；磁盘也只占一份（不随会话数增长）。
2. **为什么视图必须只读（ro）**：见 §4.9 决策记录。
3. **为什么保留软链而不是把视图内容直接放会话目录**：软链的"目标路径稳定"让视图原子替换后所有会话即时生效，且存量迁移只需换链接目标（无需拷贝数据、不会写穿）。

---

## 4. 详细设计

### 4.1 数据目录与配置

新增数据根 `skillViewsDir`（登记进 `MountPlannerRoots` 与 `assertSafe` 的 registeredRoots）：

```
{skillViewsDir}/
├── {userId}/
│   └── {skillName}/            ← 系统技能副本（容器内只读挂载的根；目录内只含技能）
├── .meta/{userId}/{skillName}.json  ← { source, fingerprint, syncedAt }（挂载外，容器不可见）
└── .tmp/{userId}/               ← 物化暂存区（不挂载，容器不可见）
```

配置（`config/application.yml`，占位符风格与现有项一致）：

```yaml
harness:
  skill-views-dir: ${SKILL_VIEWS_DIR:./skill-views}
```

- `app-config.ts`：`harness.skillViewsDir` 默认 `'./skill-views'`，类型声明与 `skillsDir` 并列；
- 生产 `.env`（gitignore，**部署前必须人工补**，见 §5.2 第 ① 项）：`SKILL_VIEWS_DIR=/opt/mao-data/skill-views`。
  不配置会回落到 `./skill-views`（相对后端 cwd；生产 systemd `WorkingDirectory=/opt/mao/backend-ts`，即 `/opt/mao/backend-ts/skill-views`）：功能可跑，但偏离 `/opt/mao-data` 数据目录约定（漏备份/漏监控、`git status` 出现未跟踪目录），且容器挂载路径随之漂移；
- 视图目录本身由后端首次物化时自动创建；如需提前纳入监控/备份，可 `mkdir -p /opt/mao-data/skill-views`；
- `runtime-data-resolver.ts`：新增 `resolveUserSkillViewsDir(userId)` 与 `resolveSkillViewDir(userId, skillName)`。

### 4.2 视图物化（新增 `SkillViewService`）

职责：把「系统技能源」按需物化为「用户级只读视图」。

```ts
class SkillViewService {
  constructor(private readonly skillViewsDir: string) {}

  /** 确保 {views}/{u}/{name} 存在且与源一致；返回视图目录路径。失败抛错，调用方降级。 */
  ensureView(userId: number, skillName: string, sourceFolder: string): Promise<string>;
}
```

**版本指纹**：`fingerprint = "{maxMtimeMs}-{fileCount}-{totalBytes}"`（递归统计源树）。

- 读取 `{views}/.meta/{u}/{name}.json`：`fingerprint` 与当前源一致且视图目录存在 → 短路（不拷贝）；
- 进程内可加 `Map<"{u}:{name}", fingerprint>` 缓存减少重复 walk；进程重启后首轮重算一次（926 文件量级，实测毫秒级）；
- 指纹口径与现有 `getLastModified` 一致，覆盖"改文件 / 增删文件 / rsync 覆盖"三类更新；极端情况（同大小、同 mtime 的内容替换）不识别，可由部署时主动清理视图兜底；
- 视图 key 取 sync 侧技能名（frontmatter name，即 merged Map 的 key），源目录名仅用于定位源：`SkillLoader` 不强制「目录名==frontmatter 名」（仅 `staged-skill-writer` 强制），两者不一致时视图目录与 `.meta` 仍以技能名为 key 保持对应；
- 指纹依赖「源 mtime 随内容变更」：技能源同步若 rsync 不带 `-a/--times`，每次部署全部源文件 mtime 刷新 → 全量重拷（见 §5.2、§8）。

**物化流程**（原子替换，路径稳定）：

```
1. 在 {views}/.tmp/{u}/{name}-{pid}-{rand}/ 完成全量拷贝（不暴露给容器）
2. 若 {views}/{u}/{name} 已存在 → rename 到 {views}/.tmp/{u}/{name}.old-{ts}
3. rename 暂存目录 → {views}/{u}/{name}          ← 路径不变，软链与 npm bin 链接继续有效
4. 删除 .old（失败仅告警，留给下次/清理任务）
5. 写 .meta（`{views}/.meta/{u}/{name}.json`，挂载根之外）：先写 `.tmp` 再 rename 覆盖
```

两次 rename 之间的窗口为微秒级；失败时尝试把 `.old` 改回，保证"要么旧版、要么新版，不出现空目录"。

**拷贝规则**（自实现 walk，不用 `cpSync` 一次性拷贝）：

- 目录：`mkdir` + 递归，保留权限位；
- 普通文件：`copyFile` + `chmod(stat.mode)`（技能内 `bin/*.js` 的可执行位必须保留）；
- 软链：
  - 技能根本身是软链（如 `skills/ntxbiz-finance-calculate -> /data/ak-scan-repos/...`）→ `realpath` 后按目录拷贝（**dereference**）；
  - 技能内部软链：`realpath` 必须仍在技能根内，否则**跳过并告警**（防止把宿主任意文件带进视图）；
- 其他类型（socket/fifo）：跳过并告警；
- 不排除 `node_modules`（部分技能 CLI 依赖包内依赖）；`.git` 可选排除。

**并发与幂等**：同一 `{u}:{name}` 的物化在进程内用 `Promise` 串行化；跨实例（蓝绿 drain 窗口内，新旧后端可能对同一用户并发物化）时内容同源，但 POSIX `rename` 把目录改到已存在的非空目录会 `ENOTEMPTY`——实现必须容忍两类竞态：① `old → .old` 时目标已不在（他人先搬）按成功继续；② `tmp → final` 时 final 已存在（他人先到）按成功继续，丢弃或转存自己的 tmp。任何时刻 final 只能是完整旧版或完整新版。

**失败处理**：源缺失、磁盘满、拷贝失败 → 保留旧视图不动、记 `warn/error`、技能目录维持上次可用状态；**不回退到"直连源软链"**（容器内源不可见，回退只会制造悬空链接）。

### 4.3 会话技能软链（`SkillSyncService` 改造）

`syncToSession` 的 merged 逻辑不变（系统技能按 `agent.skillNames` 过滤，用户技能全量、同名覆盖系统技能），只改链接目标：

| 技能来源 | 链接目标（改前） | 链接目标（改后） |
|---|---|---|
| 系统技能 | `/opt/mao-data/skills/{name}` | `/opt/mao-data/skill-views/{userId}/{name}` |
| 用户技能 | `/opt/mao-data/userskills/{userId}/{name}` | 不变 |

- 系统技能先 `await skillViewService.ensureView(...)`，成功后再 `linkSkill(viewPath, sessionPath)`；
- `linkSkill` 现有语义已满足迁移需求：目标不符 → `lstat` 判断 → 软链 `unlink` / 实体目录 `rmSync` → 重建（**存量软链换目标天然安全，不会写穿**）；
- 技能被撤销时 `removeSkillLink` 不变；
- 物化失败：该技能本轮不挂载（删除已有链接）并告警，避免"指向不存在视图"的悬空。

### 4.4 容器挂载清单（`ContainerMountPlanner`）

```diff
- { hostPath: skillsDir,          containerPath: skillsDir,          mode: 'rw', purpose: 'skills' }
+ { hostPath: {skillViewsDir}/{u}, containerPath: {skillViewsDir}/{u}, mode: 'ro', purpose: 'skillViews' }
  { hostPath: {userSkillsDir}/{u}, containerPath: {userSkillsDir}/{u}, mode: 'rw', purpose: 'userSkills' }
```

- `MountPlannerRoots` 增加 `skillViewsDir`；
- `assertSafe`：`registeredRoots` 增加新根；**删除 `isPlatformSkillsRoot` 例外**（不再存在"全局可写共享技能根"）；
- `assertShareDirIndependent` 的 per-user 根列表增加 `skillViewsDir`：该校验只拦「shareDir 位于 skillViewsDir 之内」，拦不住反向包含——需在 `assertSafe` 显式补一条「skillViewsDir 与 shareDir 互不包含」（相等会被既有「容器内路径不得重复」拦下），避免视图根被 share 整根 rw 嵌套覆盖产生挂载语义歧义；
- 注意 `assertSafe` 对挂载源路径做 realpath 校验：若运维把 `skill-views` 软链到其他卷，会按既有行为直接报错（调整配置，勿绕过）；
- 移除 `skills` rw 后，容器内**跨用户可写的共享根仅剩 `shareDir`**（全员 rw，另一方案既有决策）——本次把跨用户可写面从 {skills, share} 收窄为 {share}，需向使用方明确；
- 挂载指纹（`standardMountsFingerprint`）因条目变化而变化 → **存量容器自动重建一次**（既有机制，见 §5）。指纹只含挂载条目（`purpose|hostPath|containerPath|mode`）、**不含 env**：本方案的 env 改名（§4.5）恰伴随挂载变化才触发重建；若未来只改 env 不改挂载，存量容器不会重建（`ensureRunning` 只认挂载指纹与 runtime buildId）。

### 4.5 容器内工具允许根（`ContainerToolExecutor` / `runtime-agent`）

- `ContainerRoots.skillsDir` → `skillViewsDir`；允许根登记 `{skillViewsDir}/{u}`；
- `runtime-agent.ts`：`MAO_SKILLS_DIR` → `MAO_SKILL_VIEWS_DIR`（默认 `/opt/mao-data/skill-views`，仅作开发兜底）；
- `container-registry.ts`：容器启动 env 注入同步替换（移除 `MAO_SKILLS_DIR`）；**注入值必须取自 planner roots 实际值**（与现状 `MAO_SKILLS_DIR=${opts.skillsDir}` 同模式），禁止沿用容器侧硬编码默认——两侧不一致时 strict 沙箱会把视图内读取判成逃逸；
- `MAO_SKILL_VIEWS_DIR` 以 `MAO_` 前缀自动落入 `sensitive-env.ts` 保留前缀黑名单（admin 设置页不可配），无需额外动作；
- `0.0.393` 的"skillsDir 允许根"补丁在本方案中**语义平移**为"视图根允许根"，不再是"为了让平台目录可写而放开"，安全边界收窄；`0.0.394` 机制照旧。

### 4.6 更新传播

| 更新来源 | 落点 | 生效路径 |
|---|---|---|
| `deploy-mao.sh`（rsync `mao-cli`） | 源 | 下次会话执行 → 指纹变化 → 重建该用户视图 → 软链即时可读 |
| 管理后台 / `skill-docs` API 上传、删除 | 源 | 同上（删除技能：源消失 → 视图保留旧副本？**需删除**，见下） |
| 外部 rsync / 部署侧直写 | 源 | 同上 |
| 用户技能上传/编辑 | `userskills/{u}` | 软链直指用户目录，**即时生效**（不经过视图） |

补充规则：**源侧技能被删除**时，`ensureView` 对"源不存在"只做删除 + 返回 null。但该清理是**被动**的：物化入口只在 syncToSession（CLOUD、每次执行）按 merged 列表调用，因此只有「仍有 agent 的 `skillNames` 引用该技能名、且该用户下次执行」时才走到清理；已无 agent 引用（或其用户不再活跃）的技能，视图残留到二期 GC。若要主动收敛，可在删除入口（`skill-doc.service.deleteSkill`）按 users 表批量删各用户视图（低频、IO 可接受），列为可选项（§6）。

（后端不存在 ECP 技能下发写路径，原「ECP 下发」表述已删除，实施时勿寻找不存在的服务。）

`SkillLoader` 的 5 分钟缓存（`skillsCacheSeconds=300`）行为不变：技能增删在提示词目录里最多延迟 5 分钟，属既有语义。

### 4.7 清理与生命周期

- 会话清理器**不变**（`cleanupSkills: true` 时删非活跃会话的 `{s}/skills`，只删软链）；**严禁**把视图纳入会话级清理——否则 CLI 立刻悬空；
- `.tmp` 残留：启动时/每轮清理顺带删除超过 1 小时的暂存目录；
- 视图 GC（二期）：按"该用户所有 agent 的技能并集"收敛残留技能（当前为增量累积：曾经授权、现已撤销的技能会留在视图里，属用户级可见，风险低）；
- 磁盘估算：`12M × 活跃用户数`（不随会话数增长），需纳入监控。

### 4.8 host 模式

- **统一走视图**（与 docker 行为一致，避免两套路径真相）：`syncToSession` 的改造对 host/docker 同时生效；
- host 模式本无容器隔离（shell 可访问全盘），本次收紧的**强边界只对 docker 生效**；host 保持现有 `PathSandbox` 非 strict 行为，不加新的限制；
- 沙箱口径（已核对 `path-sandbox.ts`）：host 的 `read_file`/`edit_file` 走 `resolveLenient` 非 strict 分支 = 纯 `path.resolve`，**不做允许根与 realpath 校验**；软链目标改为视图后，词法路径仍在 `{runtimeDir}/{u}`（已登记允许根）内，读取不受影响，**无需把视图根登记进 host 沙箱**。直接以 `/opt/mao-data/skill-views/{u}/...` 绝对路径访问会被 `resolve()` 拒（非允许根）——可接受，agent 经会话技能目录消费；
- host 模式的"只读"**无强制力**：后端以 root 运行（DAC_OVERRIDE），视图目录权限位（755/644）挡不住宿主 root 写；host 本无隔离，此处仅作语义说明，不为 host 增加 `chattr +i` 等机制；
- `SkillLoader.refreshCache` 仍会把源技能目录登记为文件工具允许根（host 专用），本次不动——登记的是源路径，对视图链路无副作用；
- 技能文档中的操作路径统一改为"会话技能目录"（系统提示注入的 `Folder:` 路径），该写法在 host / docker 都成立。

### 4.9 决策记录：为什么视图必须只读（ro）

如果把 `skill-views/{u}` 改成 rw，会依次出现以下问题：

1. **视图漂移（最直接的坑）**：Agent 在会话内改视图文件 → 源指纹没变 → 下一次 `ensureView` 判定"已是最新"**不会覆盖** → 被改过的技能长期生效，且只影响该用户，形成"同一技能不同人不同行为"的幽灵问题，排查成本极高。要修就得每轮强制重建（性能代价）或引入内容哈希校验（复杂度代价）。
2. **安全边界退化**：rw 的视图从"只读快照"变成"用户级第二技能源"。Agent 可以往视图里塞技能、删技能、改 CLI 入口——用户级投毒。虽然不跨用户，但会污染该用户所有会话的运行时。
3. **重新引入"容器内更新共享技能"的语义**：这正是产品已确认要取消的能力；rw 等于保留一个没人用、但可被利用的写通道。
4. **软链写穿风险需要额外防护**：若物化实现有一天不再 dereference，rw 视图内的软链可能指向宿主任意路径，写操作会穿透到宿主；ro 天然免疫。
5. **一致性承诺失效**：视图存在的意义是"会话使用的技能 = 源的可信快照"；rw 使这个承诺不成立，后续所有"技能版本/审计"类需求都失去基础。
6. **没有任何收益**：实测（2026-11-03）只读目录内 `npm install . -g` 成功、CLI 正常执行；全部技能包只有 `test` 脚本、无 prepare/build、无写自身目录逻辑。CLI 需要写的 home/deps 都在 rw 挂载里。**ro 不阻碍任何合法用法。**
   实测留档（npm 10.9.7 / node 22.22.2，与容器 `node:22-bookworm-slim` 同代）：① 只读目录（555/444）内 `npm install . -g` exit=0，不写 cwd；② npm 10 的全局安装产物是 `lib/node_modules/<pkg> -> 源目录` 的**符号链接**，且经 realpath 指向源真实目录（不是会话软链路径）；③ 删除会话 skills 目录后 CLI 仍可执行——"视图持久 ⇒ CLI 永不悬空"的实证，同时是 66c77a36 历史问题的镜像验证。

合法自定义需求的正确出口：用户想改某个系统技能 → 使用**用户技能**（`userskills/{u}`，rw，同名覆盖系统技能，属于既有机制），或走管理后台发布流程。绝不通过放开共享视图来满足。

**结论：视图保持 ro，不提供 rw 开关。**

---

## 5. 存量迁移与上线

### 5.1 存量状态

| 对象 | 当前状态 | 迁移方式 |
|---|---|---|
| 会话技能（828 条软链） | 指向 `/opt/mao-data/skills/{name}` 或 `userskills/{u}/{name}` | 下次执行时 `linkSkill` 发现目标不符 → `unlink` + 重建为指向视图（**不拷贝存量、不写穿**） |
| 容器（7+ 在线） | 挂载含 `skills`（rw），无 `skillViews` | 挂载指纹变化 → `ensureRunning` 时自动重建（`0.0.394` 机制） |
| 全局 npm CLI 链接 | 指向源目录（持久） | 不受影响；重新安装后指向视图（持久） |
| 视图目录 | 不存在 | 首次执行时按需物化 |

### 5.2 部署人工操作清单（推荐凌晨窗口执行）

本次改造部署时**需要人工执行的操作**总表：

| 时机 | 操作 | 是否必须 | 说明 |
|---|---|---|---|
| 部署前 | ① 生产 `.env` 补 `SKILL_VIEWS_DIR=/opt/mao-data/skill-views` | ✅ 必须 | 见 §4.1；漏补会回落 `./skill-views` |
| 部署前 | ② 确认无运行中会话；定时任务 cron 不落在窗口内 | ✅ 必须 | 检查命令见下 |
| 部署前 | ③ 抽样确认存量会话技能全部是软链（留档） | 推荐 | 防止回滚窗口期误操作 |
| 部署 | ④ `bash deploy-mao.sh`（生产机脚本，**不在 git 内**，路径以现场为准） | ✅ 必须 | 本次无前端改动，可用 `--backend-only` 缩短窗口；另见下方「指纹与 rsync」注 |
| 部署后 | ⑤ 重建存量容器 | 推荐 | 管理后台「系统设置 → 容器管理 → 重建全部」（默认跳过有任务的容器，可勾选「包括正在运行任务的容器」）；不主动重建也会在用户下次调工具时懒重建 |
| 部署后 | ⑥ 清空存量会话 skills 目录（只删软链） | 可选 | 命令见下；加速迁移彻底性 |
| 部署后 | ⑦ 预热验证 | ✅ 必须 | 步骤见下 |
| 部署后 | ⑧ 观察日志 ≥30 分钟 | ✅ 必须 | 日志目录 `/opt/mao/backend-ts/logs` |
| 异常时 | ⑨ 回滚 | 预案 | 见 §5.4 |

**② 前置检查命令**：

```bash
# 无运行中会话（查管理后台会话列表或 DB；phase 不应出现下列值）
# RUNNING / WAITING_APPROVAL / RESUMING / CANCELLING
# 定时任务窗口：检查 scheduled_task 的 cron 是否落在发布窗口
# 抽样确认软链：
find /opt/mao-data/runtime -maxdepth 4 -type l -path '*/skills/*' | wc -l   # 与 §5.1 的 828 条量级对照
```

**指纹与 rsync mtime**：视图指纹用 `maxMtimeMs` 判定源变更，依赖「技能源同步保留 mtime」。若 `deploy-mao.sh` 的 rsync 不带 `-a/--times`，每次部署全部源文件 mtime 刷新 → 所有活跃用户视图全量重拷（功能正确，IO 尖峰）。部署前确认该脚本 rsync 参数；不带 `-t` 时接受全量重建，或改用更强指纹口径。

**⑥ 清空存量会话技能目录**（只删软链，不动源）：

```bash
ls -la /opt/mao-data/runtime/*/*/skills | head        # 抽样确认全是软链
find /opt/mao-data/runtime -maxdepth 4 -type d -name skills -path '*/[0-9]*/[0-9]*/skills' -exec rm -rf {} +
```

下次执行时按新逻辑重建（避免"旧链接指向源"的残留期）。删除后无需重启后端：`syncState` 是进程内 Map，残留技能名会在下次执行 sync 时按 merged 结果重建。

**⑦ 预热验证**（用测试账号触发一次会话执行）：

1. 物化产物：`ls /opt/mao-data/skill-views/<userId>/` 已生成对应技能；`.meta` 在 `/opt/mao-data/skill-views/.meta/<userId>/`（挂载外）；
2. docker 模式（当前生产）：对在跑容器执行 §7.2 第 1~3 项（源不可见 / 视图只读 / `SKILL.md` 可读）；
3. CLI：在会话中对任一技能执行 `npm install . -g` 后运行 `<cli> --help`；留档容器内 `npm -v`（预期 10.x，见 §4.9 实测口径）；
4. 清理回归：删除该会话 `skills` 目录后确认 CLI 仍可用（§7.2 第 5 项）。

**⑧ 观察要点**：`[skill-view]` 物化日志、`Failed to sync skill`、`EROFS` 误报、`[container-mount]` 挂载审计、容器重建日志；新数据根 `/opt/mao-data/skill-views` 纳入磁盘监控（约 12M×活跃用户，50 用户 ≈600MB）；视图可由源重建，备份策略可不覆盖（覆盖亦仅 600MB 级成本）。

**系统自动完成、无需人工**（对照用，避免多余操作）：

- `deploy-mao.sh` 内的技能源同步（rsync `mao-cli` → `/opt/mao-data/skills`）；
- 视图物化与存量会话软链迁移（首次/下次执行时自动，`linkSkill` 比较目标后重建）；
- 容器懒重建判定（挂载指纹比对，`ensureRunning` 时自动）；
- 蓝绿切换（`restart.sh`）；容器内代码漂移收敛（`0.0.394`，容器未主动重建时生效）。

### 5.3 不选凌晨（在线发布）的差异

- 迁移与重建都是惰性的（每轮执行前 sync / 首次调工具时重建），功能可用；
- 需额外注意：切换瞬间若同一会话被执行中的新旧实例交替处理，可能反复替换软链（概率低）；重建窗口会体现为某次工具调用延迟；
- 建议：发布后 30 分钟内观察 `skill-view` 告警与容器重建日志，避免在高峰期发布。

### 5.4 回滚

1. 代码回退并重新部署 → `skills` 挂载恢复、`skillViews` 挂载移除 → 指纹再次变化 → 容器重建；
2. 会话技能软链会在下次执行时由 `linkSkill` 自动指回源（比较目标后重建）；
3. 视图目录可保留（无害）或手工删除；
4. 无数据损失：源目录全程只读，未参与迁移写操作。

---

## 6. 代码改动清单

| 文件 | 改动 |
|---|---|
| `backend-ts/src/harness/skill/skill-view.service.ts` | **新增**：物化、指纹比对、原子替换、源删除清理、`.tmp` 清理 |
| `backend-ts/src/harness/skill/skill-sync-service.ts` | 系统技能链接目标改为视图；注入 `SkillViewService`；物化失败降级（删链接 + 告警）；用户技能不变；L57 `syncState` 注释按视图口径更新（原"链接指向源目录，内容始终最新"） |
| `backend-ts/src/harness/runtime/runtime-data-resolver.ts` | 新增 `resolveUserSkillViewsDir(userId)`、`resolveSkillViewDir(userId, name)` |
| `backend-ts/src/harness/container/container-mount-planner.ts` | roots 增加 `skillViewsDir`；移除 `skills` 挂载；新增 `skillViews`(ro) 挂载；删除 `isPlatformSkillsRoot` 例外；`assertShareDirIndependent` 增加新根 |
| `backend-ts/src/harness/container/container-registry.ts` | opts 增加 `skillViewsDir`；容器 env 改为 `MAO_SKILL_VIEWS_DIR`（移除 `MAO_SKILLS_DIR`）；planner roots 传入 |
| `backend-ts/src/harness/container/runtime-agent.ts` | `resolveRoots()` 使用 `MAO_SKILL_VIEWS_DIR`（默认 `/opt/mao-data/skill-views`） |
| `backend-ts/src/harness/container/container-tool-executor.ts` | `ContainerRoots.skillsDir` → `skillViewsDir`；允许根登记 `{skillViewsDir}/{u}`；更新注释 |
| `backend-ts/src/harness/runtime/runtime-cleanup-scheduler.ts` | 增加 `.tmp` 残留清理（>1h，可选） |
| `backend-ts/src/config/app-config.ts` | `harness.skillViewsDir` 类型与默认值 |
| `backend-ts/config/application.yml` | `skill-views-dir: ${SKILL_VIEWS_DIR:./skill-views}` |
| `backend-ts/.gitignore` | 增加 `skill-views/`（兜底：未配置 `SKILL_VIEWS_DIR` 时不污染工作区） |
| `backend-ts/src/app-container-runtime.ts` | 向 `ContainerRegistry` 传 `skillViewsDir` |
| `backend-ts/src/create-app.ts` | 实例化并注入 `SkillViewService` |
| 单测 | `skill-view.service.spec.ts`（新增）+ 现有 7 个 spec 更新（见 §7.1，含 `container-registry.spec.ts`） |
| `backend-ts/src/skill/skill-doc.service.ts` | （可选）删除系统技能时按 users 表批量清理对应用户视图（§4.6 主动收敛；不做则靠二期 GC） |
| 技能文档 | git 内 2 处：`skills/mao-cli/reference/config.md`、`skills/mao-cli/reference/deploy.md`；`lark-cli-skill` 不在 git（仓库外技能），随其发布渠道同步：路径口径统一改为"会话技能目录" |
| `CHANGELOG.md` | 实施时在顶部新增条目 |

---

## 7. 测试计划

### 7.1 单测

- `skill-view.service.spec.ts`（新增）：
  - 首次物化生成目录与 `.meta`（`.meta` 落在 `{views}/.meta/{u}/`，挂载根之外）；指纹未变时短路；源变更触发重建；源删除清理视图；
  - 原子替换：替换前后路径不变、替换过程中不出现空目录、旧目录最终清理；
  - 技能根本身是软链（dereference）；技能内部软链越出技能根被跳过；
  - 文件可执行位保留；并发 `ensureView` 幂等。
- `skill-sync-service.spec.ts`：系统技能指向视图、用户技能指向 `userskills`、旧软链（指向源）迁移、物化失败时删除链接并告警；源被删除且无 agent 引用时不触发物化（无副作用）。
- `container-mount-planner.spec.ts`：清单含 `skillViews`(ro)、不含 `skills`；指纹变化；`skills` 根不再享有 rw 例外；`shareDir` 与 `skillViewsDir` 互不包含的新断言。
- `container-tool-executor.spec.ts`：经视图软链读取 `SKILL.md` 通过 strict 校验；指向视图之外的软链仍被拒绝。
- `container-registry.spec.ts`：env 注入改为 `-e MAO_SKILL_VIEWS_DIR=<配置值>`（现 spec L120 断言 `-e MAO_SKILLS_DIR=...`，**必改**）；挂载指纹变化触发全量重建（新 env 生效路径）。
- `runtime-agent.spec.ts`：`MAO_SKILL_VIEWS_DIR` 解析与默认值。
- `app-config` spec（`src/config/app-config.spec.ts`）：`skillViewsDir` 默认值不受空 env 影响。
- `runtime-cleanup-scheduler.bugcheck.spec.ts`：`.tmp` 残留清理（>1h）不误删活跃视图。

### 7.2 容器内集成验证

```bash
# 1) 源不可见
docker exec mao-user-N ls /opt/mao-data/skills              # 应不存在
# 2) 视图只读
docker exec mao-user-N ls /opt/mao-data/skill-views/N        # 仅授权技能
docker exec mao-user-N touch /opt/mao-data/skill-views/N/x   # 应 EROFS
# 3) 技能读取
docker exec mao-user-N cat /opt/mao-data/runtime/N/S/skills/<skill>/SKILL.md
# 4) CLI 安装与执行
docker exec -w /opt/mao-data/runtime/N/S/skills/<skill> mao-user-N npm install . -g
docker exec mao-user-N <cli> --help
# 5) 关键回归：删除会话 skills 目录（软链）后 CLI 仍可用
# 6) 更新传播：改源 → 触发一次会话执行 → 视图更新 → 容器内读到新版
# 7) ro 前提留档：确认容器默认能力集无 CAP_SYS_ADMIN、remount 被拒
docker exec mao-user-N grep CapEff /proc/self/status        # 预期 a80425fb（不含 bit21 cap_sys_admin）
docker exec mao-user-N mount -o remount,rw /opt/mao-data/skill-views/N   # 预期失败（EPERM）
# 8) 视图内容面：ls -a 视图根只出现授权技能（无 .meta 等杂物）
docker exec mao-user-N ls -a /opt/mao-data/skill-views/N
```

### 7.3 回归范围

- 存量软链迁移抽样（含指向用户技能、指向 backup 目录的条目，如 `pts-cli -> .../pts-cli.backup-20261017150633`）；
- 容器重建（挂载指纹变化）与蓝绿重启；
- LOCAL 模式技能包下载/解压链路不受影响。

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 物化失败（源缺失/磁盘满） | 技能不可用 | 保留旧视图、告警、不回退直连源 |
| 首次物化延迟 | 首轮 +100~300ms | 用户级一次；部署后预热 |
| 磁盘增长 | 12M/活跃用户 | 监控 + 二期配额/GC |
| 容器重建窗口 | 首次访问延迟 | 凌晨主动重建 + 预热 |
| 文档/经验路径失效 | 按旧路径装 CLI 失败 | 更新 3 处技能文档 + 团队经验 |
| 视图残留已撤销技能 | 用户级可见 | 二期 GC；风险低 |
| 蓝绿并发物化 | 后写覆盖 | 内容同源 + `rename` 原子性 |
| 长任务中途源更新不生效 | 定时任务/长会话全程用旧版技能（原软链即时可见） | 可接受：下次执行/手动压缩时重建视图；如需热更新后续再加"执行中指纹变更即重建" |
| rsync 不带 `-t` 保留 mtime | 每次部署全部活跃用户视图全量重拷（IO 尖峰） | 部署前确认 rsync 参数（§5.2）；或接受全量重建 |
| 原子替换微秒窗口 | rename 交换瞬间路径不存在，恰好读文件的 CLI 报 ENOENT（概率极低） | 接受，重试即可 |
| env 不在挂载指纹内 | 未来只改 env 不改挂载时存量容器不重建 | 本方案恰伴随挂载变化必重建；拆开改时需把 env 纳入指纹或主动重建 |
| host 模式 ro 无强制力 | 宿主 root 可写视图（host 本无隔离） | 语义说明即可，不为 host 加机制（§4.8） |
| 回滚 | 短暂重建 | 代码回退 + 软链自动回指源 |

---

## 9. 备选方案对比

| 方案 | 隔离粒度 | CLI 生命周期 | 更新时效 | 磁盘 | 结论 |
|---|---|---|---|---|---|
| **用户视图 + ro + 软链（本方案）** | 用户级 | 稳定（视图持久） | 下轮执行生效 | 用户数 × 技能集 | ✅ 推荐 |
| copy 到会话目录 | 实际用户级可见 | 悬空（副本被清理） | 下轮执行 | 会话数 × 技能集 | 需改技能安装方式；不推荐 |
| 每技能单独 bind mount | 用户级 | 稳定 | 挂载变更需重建容器 | — | 挂载点爆炸 + 频繁重建；不可取 |
| 每会话容器 | 会话级 | 稳定 | 即时 | 容器数量与内存成本 | 不可接受 |
| 维持现状（全量 rw） | 无 | 稳定 | 即时 | — | 不满足安全目标 |

---

## 10. 二期 / 遗留

- 视图 GC：按"该用户所有 agent 的技能并集"收敛残留技能；
- 视图磁盘配额与告警；
- 团队经验与技能文档路径更新（`团队经验/2026-11-02-access-cli设备授权与CLI重装.md` 等；git 内技能文档 2 处见 §6，仓库外技能随发布渠道同步）；
- 是否对 host 模式做同等收紧（当前无强隔离，收益有限）。

## 11. 术语

- **源**：`/opt/mao-data/skills`（系统技能）、`/opt/mao-data/userskills/{u}`（用户技能）；
- **视图**：`/opt/mao-data/skill-views/{u}`，按需物化的用户级只读技能副本；
- **物化**：从源拷贝到视图，带指纹比对与原子替换；
- **会话技能目录**：`/opt/mao-data/runtime/{u}/{s}/skills`，指向视图/用户技能的软链集合。

---

## 12. 评审修订记录（2026-11-03）

本轮评审（只读核对代码 + 本机复现 npm 实测）后的补齐点，实施时以本节为索引：

1. `.meta` 移出挂载根：`{views}/.meta/{u}/{name}.json`，容器内视图只含技能（§3、§4.1、§4.2、§5.2⑦、§7.2）；
2. host 模式沙箱口径写实：非 strict `resolveLenient` 不校验，视图链路无需登记允许根；host ro 无强制力（§4.8）；
3. 源删除清理改述为被动清理 + 可选主动收敛（§4.6、§6）；
4. 指纹依赖 rsync 保留 mtime，部署清单加确认项（§4.2、§5.2、§8）；
5. env 注入值取自配置、容器侧默认仅兜底；env 不在挂载指纹内的耦合说明（§4.4、§4.5、§8）；
6. `shareDir` 成为移除 `skills` rw 后唯一跨用户可写根；两根互不包含断言（§4.4）；
7. 删除不存在的「ECP 下发」写路径表述（§4.6）；
8. 测试清单补 `container-registry.spec.ts`（L120 断言必改）等至 7 个 spec（§6、§7.1）；
9. 部署脚本/cwd/文档引用按仓库事实修正（§4.1、§5.2、§6、§10）；
10. §4.9 补 npm 只读安装与 CLI 生命周期的实测留档；§7.2 补 ro 前提（能力集/remount）验证项。

---

## 13. 生产规模风险清单（50 活跃用户 / docker 模式，2026-11-03 评审补）

**爆炸半径上限：任何单点失败的最大影响 = 一个用户的一个会话的一次执行；不存在全局停摆路径；源目录全程不被写（不挂载 + 宿主侧物化）。**

| 场景 | 触发条件 | 影响面 | 用户可见表现 | 恢复方式 | 数据损失 |
|---|---|---|---|---|---|
| 技能物化失败（磁盘满/权限/源损坏） | 该用户下次执行 sync | 故障技能 × 相关用户；旧视图保留 + 告警 | 该技能文件读不到（prompt 仍列名，与"源损坏"现状同款） | 修环境后下次执行自动重试（无 `.meta` 即重试，失败不写 meta） | 无 |
| 容器重建潮 | 部署后每用户首次调工具 | 50 用户各一次（秒级/次） | 首次工具调用慢数秒 | 懒重建自愈；⑤ 可主动挪进窗口 | 无 |
| 蓝绿 drain 内新旧代码交替 | 切换后 60s（`MAO_BLUE_GREEN_DRAIN_SEC`）内被两实例交替处理的会话 | 窗口内活跃会话（估 5~15 个）可能多 1~2 次容器重建 | 在途工具调用失败，重发即恢复 | 旧实例退出后自愈 | 无（仅浪费当轮 LLM 输出） |
| 双实例物化竞态 | 上述窗口内同用户被两实例同时物化 | 实现必须容忍 `rename` 目标已存在（`ENOTEMPTY`/`ENOENT`） | 无（实现细节，见 §4.2） | 已在设计内 | 无 |
| rsync 不带 `-t` | 每次部署 | 全部活跃用户视图全量重拷（~600MB，分散在各用户首执行） | 首轮 +100~300ms/技能 | 确认 rsync 参数或接受 | 无 |
| ro 被绕过（理论值） | 需容器获得 `CAP_SYS_ADMIN`/特权（当前 docker run 无） | 仅该用户自己的视图副本 | 无（自查） | 重新物化 | 源未挂载仍不可写；即便被绕过也比现状（rw 共享源）严格更好 |
| 回滚 | 代码回退 + 重新部署 | 第二轮容器重建潮 + 又一个 60s 交替窗口 | 同重建潮 | 软链自动回指源；视图残留无害 | 无 |

**放量口径（对 §5.2 的顺序修正）**：

1. 单账号金丝雀优先：先执行 ⑦ 八项验证（含 §7.2 第 7 项 remount 被拒、CLI 清理回归），全过再决定 ⑤；
2. ⑤「重建全部」建议排在 ⑦ 之后（原 ⑤→⑦ 调整为 ⑦→⑤），避免未验证先动 50 个容器；不主动重建也能懒生效，代价是各用户首次调用慢几秒；
3. 部署后 30 分钟重点看 `[skill-view]` 告警、容器重建日志、`EROFS` 误报三类新签名。
