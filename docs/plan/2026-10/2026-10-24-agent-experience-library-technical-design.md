# Agent 团队经验库（渐进式发现）技术方案

日期：2026-10-24。状态：方案已与需求方脑暴收敛，待实施。

## 0. 决策摘要

| # | 决策 | 说明 |
|---|------|------|
| D1 | 仅 CLOUD；按 Agent 一库 | LOCAL（Electron 本地执行）文件工具跑在用户本机，够不到服务器目录，不注入路标、不挂载 |
| D2 | 读写挂载进工作区 | 工作区内符号链接 `团队经验 -> <经验根>/<agentId>`，Agent 用现成文件工具（read/write/edit/grep/glob/shell）读写，**不新增内置工具** |
| D3 | 索引落盘、自动再生成 | `INDEX.md` 由后端扫描子文档 frontmatter 生成；Agent 只写子文档，不手改索引 |
| D4 | 自觉沉淀、无兜底 | 不做会话结束 LLM 摘要兜底（成本高 + 经验膨胀）；文件名带日期；frontmatter 带 `last_verified` |
| D5 | 路标句由后端按状态注入 | 有库才有句（agent 开关 × CLOUD），代码拥有；**不放进「最佳实践经验」**——机制提示与系统状态强一致，防止数据行误删导致功能静默失效 |
| D6 | 现有短经验保留不动 | 短通用经验继续全量注入提示词；长动态经验进库；两套长期并存 |
| D7 | 工作区知识索引并存 | 既有「工作区知识索引」最佳实践经验继续放项目专属知识；新库放跨项目可复用经验；定位在两处路标文案中各说明 |
| D8 | admin 可视可治 | 后台浏览/编辑/删除子文档、重建索引、按 Agent 开关 |
| D9 | 去重合并、备份兜底暂缓 | 信任 Agent 自行修正错误经验；重复条目后续再考虑定时合并 |
| D10 | 经验根为 share 子目录：`/opt/mao-data/share/agent-experience/<agentId>/`；**share 挂载由 ro 改为 rw** | 需求方决策。代价：share 内管理员投放内容从「挂载层只读」退化为「信任 + 备份兜底」，且同根下各 Agent 库可互写（团队内同信任级，接受）；快照建议范围覆盖整个 share |

## 1. 背景与问题

### 1.1 现状

- 「最佳实践经验」挂在 Agent 上（`agent_experiences` 表），管理员在 admin 的 AgentFormDialog 手工维护，单条 ≤300 字（`agent-experience.service.ts` L23），由 `PromptEngine.resolveExperiences` **全量注入**系统提示词。只能放极通用的短经验。
- 需求方已用一条最佳实践经验引导 Agent 在**工作区文档目录**维护知识索引+子文档（项目专属）。只能被当前工作区发现，不跨工作区、不跨成员。
- 团队成员使用 Agent 过程中动态产生大量长篇执行经验（多轮排查后的解法），无法塞进提示词，需要一个跨会话、跨成员共享且**渐进式发现**的载体。

### 1.2 目标

- 每个 Agent 一个团队经验库：服务器目录 + 索引 + 子文档。
- 读：系统提示只加一小节固定「路标」；Agent 接手复杂/陌生任务时先 `grep` 索引，命中再读子文档全文。
- 写：Agent 多轮探索解决重要问题后，自建带日期的子文档沉淀；发现库内经验有误可直接修正。
- admin 后台可视：按 Agent 浏览、编辑、删除、重建索引、开关。

### 1.3 非目标

- LOCAL 模式支持（后续按需）。
- 会话结束 LLM 自动摘要兜底、定时去重合并、向量/语义检索。
- 经验库并入 Agent bundle 导入导出（库是运行期团队资产，不属于 Agent 定义）。
- 写入审核流。

## 2. 现状盘点（代码事实）

- 路径沙箱：`harness/safety/path-sandbox.ts`。`addAllowedRoot()` 支持登记额外允许根；严格（容器）模式 `assertNoSymlinkEscape`（L83-113）对符号链接逐段校验，**目标 realpath 命中已登记允许根即放行**（L109）。宿主模式 `resolveLenient` 不校验符号链接。→ 「工作区符号链接指向已登记的经验根」两种模式都可行。
- `deleteWorkspaceDirectory`（`session/session.service.ts` L1570-1577）用 `rmSync(recursive, force)`，Node fs.rm **不跟随符号链接**（只删链接本身）→ 工作区删除不会波及库内容，需加回归用例锁死该行为。
- 工作区解析：`initializeCloudWorkspace`（session.service.ts L187-233）。git/项目模式 = `{workspaceRoot}/{userId}/projects/{slug}`（跨会话共享）；auto 模式 = `{workspaceRoot}/{userId}/{sessionId}`（每会话一个，删除时整目录清掉）。
- 上下文装配：`harness/core/harness-service.ts` L312 `executionMode = session.executionMode ?? 'CLOUD'`；L332 `context.experiences = await this.experienceService.listEnabledContents(agent.id!)`。新装配点就在这旁边。
- 提示词：`harness/core/prompt-engine.ts` `buildSystemPromptSections` 分节构建；`INJECTED_SECTION_KEYS`（L119-126）登记注入型分节供上下文 manifest 统计（所见即所发）。新增节照此登记。
- 工具注册：`harness/tool/tool-registry.ts` L133 `new WriteFileTool(deps.pathSandbox)`；容器侧 `container/container-tool-executor.ts` L102 另行注册。→ 写后回调从 ToolRegistry deps 注入，两处共用。
- 共享目录既有实现（2026-10-21 方案）：`app.harness.shareDir`（env `MAO_SHARE_DIR`，默认 `/opt/mao-data/share`）、启动 resolve+mkdir（`create-app.ts` L278-281）、容器挂载 ro 条目（`container-mount-planner.ts` L94）+ `assertShareDirIndependent`（L117-129，share 不得位于 per-user 根下）+ env 透传（`container-registry.ts` L475）+ 容器内允许根（`container-tool-executor.ts` L68）。本方案**复用**该根，仅把挂载 mode 由 ro 改 rw；宿主侧沙箱新增 share 允许根登记。
- admin：函数式路由（`agent/agent.routes.ts`，`requirePermission(permissionService, userId, 'agent:write')` 模式），`Result<T>` 信封；视图均为「列表页 + 弹窗」模式，无子路由。
- 迁移最新为 V168，新迁移为 V169。

## 3. 总体设计

### 3.1 目录与配置

```
/opt/mao-data/share/                   # 既有共享目录（MAO_SHARE_DIR，挂载 ro→rw）
  agent-experience/                    # 经验根：share 下固定子目录名
    <agentId>/                         # 每个 Agent 一库，用数字 id，改名不影响路径
      INDEX.md                         # 自动生成的索引（落盘）
      2026-10-24-mysql-deadlock.md     # 经验子文档（Agent / admin 写）
      2026-10-20-feishu-card-rollback.md
```

- **不新增配置项与环境变量**：经验根 = `join(shareDir, 'agent-experience')`，由 create-app 启动时从 `cfg.app.harness.shareDir` 派生一个常量并注入各处（`create-app.ts` 已有 shareDir 的 resolve + mkdir 启动兜底，无需重复）。
- share 根下的既有内容（管理员投放）与 `agent-experience/` 并存；Agent 库目录在首次挂载时 lazy `mkdir`。
- 工作区内挂载点名为常量 `团队经验`（后端固定，不做配置；对 Agent 展示友好，shell/read/grep 相对路径直接可用）。

### 3.2 数据模型与迁移

`db/migration/V169__agent_experience_library.sql`：

```sql
ALTER TABLE agent
  ADD COLUMN experience_library_enabled TINYINT(1) NOT NULL DEFAULT 1
    COMMENT '团队经验库开关：1=挂载并注入路标；0=完全不生效' AFTER client_visible;
```

- 默认开启：新 Agent 开箱即用；admin 可按 Agent 关闭。
- `agent` 域 types/repository/service 透出 `experienceLibraryEnabled`；agent PUT/POST 接受该字段（全量同步风格，同 experiences）。
- bundle 导入导出**不含**该列与库内容（决策见非目标）。

### 3.3 工作区挂载（符号链接）

`initializeCloudWorkspace`（session.service.ts L187-233）在 `ensureWorkspaceDirectory` 之后追加一步 `ensureExperienceMount(workspace, agentId, enabled)`：

1. `enabled=0` 或会话非 CLOUD：若存在旧链接则删除，直接返回（保证关开关后不残留）。
2. `mkdirSync(<经验根>/<agentId>, {recursive:true})`，首次生成空 `INDEX.md`（见 3.5 引导）。
3. `symlinkSync(<经验根>/<agentId>, <workspace>/团队经验, 'dir')`；已存在且指向正确则跳过；指向错误（如换绑过 Agent 的项目工作区）则重建。
4. 若工作区含 `.git/`：向 `.git/info/exclude` 追加 `团队经验`（幂等，先查重）——git/项目工作区是真实检出，避免链接污染 `git status` 与误提交；`.git/info/exclude` 不入库、不影响远端。

auto 模式每会话新目录自然重建链接；git/项目工作区跨会话共享，幂等保证换 Agent 后链接指向该会话 Agent 的库。

### 3.4 经验子文档规范

文件名：`YYYY-MM-DD-<短横线slug>.md`，slug 允许字母数字与中文，**禁 `/`、`\`、空白**（写入侧由文件工具天然保证；admin 侧校验 basename）。日期前缀使同名碰撞概率归零（两个 Agent 同日同 slug 仍可能覆盖，接受；索引再生成会立即反映最终内容）。

frontmatter（宽松解析，缺字段容错，不引 YAML 库——照 `skill/skill-md.ts` 的 `findFrontmatterEnd` 风格自写 `key: value` 行解析）：

```markdown
---
title: MySQL 死锁排查实录
keywords: mysql, 死锁, innodb, 锁等待
summary: 三步定位：锁等待图 → 事务回滚顺序 → 索引缺失加锁放大
applicable: MySQL 8 / backend-ts
last_verified: 2026-10-24
---

正文：现象、排查过程、根因、解法、验证方式，不限长度。
```

`last_verified` 由 Agent 修正经验时顺手更新；再生成器不改写它。字段全可缺省，缺 `title` 时索引行回落用文件名。

### 3.5 索引文档与自动再生成

新服务 `harness/experience/experience-index.service.ts`（新目录 `harness/experience/`，与 skill/ 平级）：

```
ensureFresh(agentDir):
  1. 扫描 *.md（排除 INDEX.md），取每文件 frontmatter + mtime
  2. 陈旧判定：INDEX.md 不存在，或任一子文档 mtime > INDEX.md mtime
  3. 陈旧则重建：按文件名倒序（日期前缀=新在前），每行一条
  4. 原子写：INDEX.md.tmp → rename（并发再生成 last-wins，内容近似，可接受）
```

`INDEX.md` 格式（grep 友好，一行一条）：

```markdown
# 团队经验索引（系统自动生成，请勿手改；检索请 grep 本文件）
<!-- count: 2 -->
- 2026-10-24-mysql-deadlock.md | MySQL 死锁排查实录 | mysql,死锁,innodb,锁等待 | 三步定位：锁等待图→… | 验证 2026-10-24
- 2026-10-20-feishu-card-rollback.md | 飞书卡片回滚 | 飞书,卡片,回滚 | … | 验证 2026-10-20
```

**刷新触发点**（三处，全走 `ensureFresh`）：

1. 会话初始化：`initializeCloudWorkspace` 挂载链接后（兜住 shell 写入等一切路径的最终一致）。
2. 写工具成功回调：`WriteFileTool`/`EditFileTool` 构造函数增加可选 `onFileChanged?: (absPath: string) => void`，成功落盘且路径位于经验根下时调用；`ToolRegistry` deps 与 `container-tool-executor.ts` 各注入一次。不拦截 shell——shell 写入的陈旧窗口由触发点 1/3 自愈。
3. admin 接口：写/删/重建后同步调用。

解析失败（frontmatter 缺失/畸形）不阻塞：索引行以文件名兜底，`title` 缺省、摘要留空。

### 3.6 系统提示注入（路标节）

- `AgentExecutionContext` 新增 `experienceLibrary?: { agentId: number } | null`；`harness-service.ts` L332 旁装配：`agent.experienceLibraryEnabled === 1 && executionMode.toUpperCase() === 'CLOUD'` 时置值，否则 null。
- `prompt-engine.ts` `buildSystemPromptSections` 在「最佳实践经验」节之后追加（memories 节之前），条件 `context.experienceLibrary != null`：

```
## 团队经验库
工作区内 团队经验/ 目录是本 Agent 的团队共享经验库（跨会话、跨成员积累）：
- 接手复杂或陌生任务前，先在 团队经验/INDEX.md 中按关键词检索（grep），命中后读取对应子文档全文再动手。
- 经过多轮探索解决重要问题、且经验可复用时，新建 团队经验/YYYY-MM-DD-主题.md 沉淀（首行 frontmatter：title/keywords/summary/applicable/last_verified）；INDEX.md 由系统生成，不要手改。
- 发现库中经验过时或有误，直接修正子文档并更新 last_verified。
- 项目专属知识仍写工作区知识索引，只有跨项目可复制的经验才进团队经验库。
```

- `INJECTED_SECTION_KEYS` 追加 `'experience-library'`（key）/「团队经验库」（label）→ 上下文 manifest、前缀指纹观测自动纳入（sections 口径所见即所发，无需额外改造）。
- 常开成本 ≈ 一小节固定文案（~150 token）；索引与正文仅在 Agent 主动检索时进入上下文。

### 3.7 沙箱与容器模式（含 share ro→rw 改造）

- 宿主 CLOUD：`create-app.ts` L454 旁新增 `pathSandbox.addAllowedRoot(shareDir)`（现状宿主侧未登记 share，文件工具会被路径沙箱拦截；登记后经验根随 share 整根放行）。符号链接经 `resolveLenient` 正常解析（宿主非严格模式）。
- 容器 CLOUD（若启用）：
  - `container-mount-planner.ts` L94 share 条目 `mode: 'ro'` → `'rw'`（挂载路径、purpose 不变），同步更新该处「ro 挂载以 EROFS 拒写」的注释与 2026-10-21 方案对应说明；
  - **确认挂载 mode 参与容器指纹**：mode 变化必须触发存量容器重建，否则旧容器仍按 ro 挂载导致经验库写入 EROFS；未参与指纹则补上；
  - env 透传与允许根无需改动：`container-registry.ts` 已 `-e MAO_SHARE_DIR`、`runtime-agent.ts` `resolveRoots()` 已读取、`container-tool-executor.ts` L68 已 `addAllowedRoot(shareDir)`；
  - 严格模式 `assertNoSymlinkEscape` L109 对「链接目标命中允许根」放行，链接方案无需特判。
- LOCAL：不挂链接、不注入节、不登记允许根（沙箱无变化）。

## 4. 管理后台（admin）

### 4.1 API（新文件 `agent/agent-experience-library.routes.ts`，app-routes.ts 挂载在 agent 路由旁）

| 方法 | 路径 | 权限 | 说明 |
|------|------|------|------|
| PATCH | `/v1/agents/:id/experience-library` | agent:write | `{enabled}` 开关（同步 agent 表） |
| GET | `/v1/agents/:id/experience-library/docs` | agent:read | 列表：扫描目录（先 `ensureFresh`），返回 `{enabled, docs:[{fileName,title,keywords,summary,applicable,lastVerified,sizeBytes,updatedAt}], indexContent}` |
| GET | `/…/docs/content?file=` | agent:read | 单篇全文。file 必须是 basename（含 `/`、`..`、空串即 400） |
| PUT | `/…/docs/content` | agent:write | `{fileName, content}` upsert（校验 basename + `.md` 后缀）→ `ensureFresh` |
| DELETE | `/…/docs?file=` | agent:write | 删子文档（禁删 INDEX.md）→ `ensureFresh` |
| POST | `/…/index/rebuild` | agent:write | 强制重建索引 |

路径安全统一：`path.resolve(库目录, file)` 后 `isUnder(库目录)` 双保险。Agent 不存在时 404；`enabled=0` 时接口仍可用（admin 可先整理内容再开启）。

### 4.2 UI

- `AgentListView` 操作列新增「经验库」→ 新组件 `views/agent/AgentExperienceLibraryDialog.vue`：顶部开关 + 文档表格（文件名/标题/关键词/最后验证/大小/更新时间）+ 行内「查看编辑」（抽屉或弹窗内嵌 textarea，保存走 PUT）+ 删除（确认框）+「重建索引」按钮 + 可折叠索引原文预览。
- 不加路由（延续「列表页 + 弹窗」模式）；api 调用直接用 `admin/src/api/index.ts` 的 `api` 实例。

## 5. Agent 视角完整流程

1. 会话启动：后端建链接、刷索引、注入路标节（固定一小节）。
2. 接到复杂任务：`grep 关键词 团队经验/INDEX.md` → 命中 → `read 团队经验/2026-10-24-xxx.md` → 按经验执行（省去重复探索）。
3. 任务完成且值得沉淀：`write 团队经验/2026-10-24-新主题.md`（frontmatter+正文）→ 写工具回调自动刷索引 → 其他成员的下个会话即可检索到。
4. 发现旧经验有误：`edit` 修正 + 更新 `last_verified` → 索引行摘要随之更新。

## 6. 风险与对策

| 风险 | 对策 |
|------|------|
| share 改 rw 后，管理员投放的只读内容可被 Agent 会话改写/删除（2026-10-21 方案的 ro 承诺失效） | 需求方决策接受；快照 cron 建议覆盖**整个 share**；运维投放内容本身有源（宿主机），可随时重投 |
| 同根下各 Agent 库可互写（Agent A 会话可绝对路径写 Agent B 的库） | 团队内同信任级，接受；跨 Agent 误写靠约定（路标只引导写本 Agent 库）+ admin 巡检 |
| Agent 执行 `rm -rf 团队经验/`（尾斜杠跟随链接删目标内容）整库被清，且波及同根邻居 | v1 接受（与工作区文件同级信任）；DEPLOY.md 附每日 `tar`/`rsync` 快照 cron 示例；后续可做回收站 |
| 存量容器未随 ro→rw 重建，经验库写入 EROFS | §3.7：挂载 mode 必须参与容器指纹，触发重建；实施时验证 |
| 恶意成员经库内容提示注入影响他人会话 | 与共享工作区同级信任；admin 可视可删；后续可加写入审计报表 |
| 库无限增长、低质堆积 | admin 列表按大小/时间可视，人工清理；去重合并见 D9 后续项 |
| shell 写入导致索引短暂陈旧 | 触发点 1/3 兜底自愈；grep 命中旧索引最坏多读/漏读一篇，无正确性影响 |
| 同日同 slug 覆盖 | 日期命名约定使概率趋零；覆盖后索引立即反映最终内容 |
| git 工作区被链接污染 | `.git/info/exclude` 幂等追加 |

## 7. 测试计划（Vitest）

- `experience-index.service.spec.ts`：空库引导生成、frontmatter 解析（正常/缺失/畸形）、排序、陈旧判定（mtime 比较）、原子写、count 注释。
- `prompt-engine.spec.ts`：CLOUD+开→节存在；LOCAL 或关→节不存在；`INJECTED_SECTION_KEYS` manifest 计数。
- `session.service` 相关 spec：链接创建幂等、换 Agent 重绑、git 工作区 exclude 追加、**`deleteWorkspaceDirectory` 删工作区后库目录内容完好**（锁死 rmSync 不跟随链接的行为）。
- `agent-experience-library.routes.spec.ts`：六接口 happy path、路径穿越（`../`、绝对路径、`INDEX.md` 删除拒绝）、权限码、开关同步。
- `path-sandbox.spec.ts`：严格模式下 `工作区/团队经验 -> 允许根` 逐段校验放行；指向未登记根仍拦截。
- 容器改造用例：mount planner share 条目 mode 为 rw 且指纹较 ro 版本发生变化（ro→rw 触发容器重建）。
- 回归：`tool-result-summarizer` / `no-progress-notice` 无需改（未新增/改名工具），跑既有套件确认。

## 8. 文档同步清单（实施任务内完成，按 AGENTS.md 规范）

- `CHANGELOG.md`：backend-ts（经验库后端 + share 挂载 ro→rw 行为变化）、admin（经验库管理页）小节。
- `DEPLOY.md`：share 挂载改读写的升级说明（存量容器自动重建）、经验库目录说明、快照 cron 建议（覆盖整个 share）。
- `README.md`：功能简介（团队经验库）。
- `skills/mao-cli/SKILL.md`：如有相关问答/运维命令则同步。
- 本方案文档与历史 review 文档不回改。

## 9. 工作量与分期

- **P1 后端**（migration+挂载+索引服务+路标节+admin API+share ro→rw 容器改造+宿主沙箱登记+全部测试）：约 1.5~2 人日。
- **P2 admin UI**（Dialog 组件+列表入口）：约 0.5~1 人日。
- **P3 后续可选**：定时去重合并（D9）、每日快照自动化、LOCAL 支持、bundle 含经验库导出、经验库写入审计报表。
