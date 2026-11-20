# 代码审查：Agent 团队经验库（round-02 复审）

- 审查对象：worktree `.worktrees/agent-experience-library`，分支 `feature/agent-experience-library`
- 审查范围：`git diff c0191676..HEAD`，重点复核修复提交 971b3b23（round-01 报告问题的修复）本身是否正确、有无引入新 bug；round-01 已验证的部分不重验
- 审查日期：2026-10-24
- 结论：**四项修复均正确且已验证闭环，未发现新的重大/一般级 bug**；新发现 1 个轻微问题（已验证）与 1 条性能观察，见下。

---

## 一、修复复核（round-01 问题 → 971b3b23）

### 1. Bug1（经挂载链接写入不刷新索引）→ `refreshIfUnderRoot` realpath 回退 ✅

**位置**：`backend-ts/src/harness/experience/experience-index.service.ts:123-142`

**复核**：词法判定不命中时对存在路径 `realpathSync` 后再判定，realpath 抛错（并发删除等）静默 return，无副作用；首段数字校验、失败只记日志的降级语义保持。**端到端验证**（临时 spec，跑毕删除）：复刻 `create-app.ts` 宿主装配（`PathSandbox(workspace)` + `addAllowedRoot(shareDir)` + `ExperienceMountService` 挂链接），用 `WriteFileTool` 以相对路径 `团队经验/2026-10-24-foo.md` 写入 → 写成功且 INDEX.md **立即**含新条目、`count: 1`（round-01 时为 `count: 0`）。修复自带单测（`experience-index.service.spec.ts` refreshIfUnderRoot follows workspace symlink paths）覆盖同一逻辑，合格。

### 2. Bug2（存量会话有路标无挂载）→ `buildContext` 每轮幂等补挂 ✅

**位置**：`backend-ts/src/harness/core/harness-service.ts:345-355` + `app-harness-engine.ts`/`create-app.ts` 装配

**复核**：
- 门控正确：`context.experienceLibrary != null`（即 CLOUD × 开关启用）且 `hasText(session.workspace)` 才补挂；LOCAL 与关开关不补挂、补挂抛错仅 warn 不阻断——三项均有专门测试（`harness-service.spec.ts` experienceLibraryMountBackstop…）。
- 使用 `session.workspace` 而非 `context.workspace`（后者在装配点之后才赋值）正确，注释已说明。
- `HarnessService` 构造器新参位于 `httpToolService` 之后，`assembleHarnessEngine` 调用参数对位无误；未注入（可选参）时行为与 round-01 一致。
- 幂等性复用 `syncForSession`：换 Agent 重绑、关开关会话创建路径移除链接等 round-01 已验证行为不变。

### 3. 轻微（`index.md` 大小写绕过）→ `isIndexFileName` 归一 ✅

**位置**：`experience-index.service.ts`（`writeDoc`/`deleteDoc`/`scanDocs` 三处）+ `agent-experience-library.routes.ts`（PUT/DELETE 两处）

**复核**：大小写不敏感比对齐了全部五个入口；旁路（shell）落盘的小写 `index.md` 也不再进索引（自带测试断言 `rebuild` 后 `count: 0`、`listDocs` 为空）。附带效应：这类文件 admin API 无法删（只能服务器侧清理），与保护语义一致，接受。

### 4. 存疑（scanDocs 无上限）→ 只读头部 64KB ✅

**位置**：`experience-index.service.ts` `readHead`

**复核**：`openSync/readSync/closeSync(finally)` 配对正确；`bytesRead` 截断处理文件在 stat 与 read 之间收缩的竞态；frontmatter 超出 64KB 或在边界截断多字节字符时按既有容错回落（空字段→索引行用文件名），无正确性影响。自带 200KB 用例通过。

## 二、新发现（轻微，已验证）

### N1（轻微）：经验根的配置路径自身含符号链接祖先时，realpath 回退与词法根失配，经链接写入仍不刷新

**位置**：`backend-ts/src/harness/experience/experience-index.service.ts:36-39,130-136`

**问题描述**：`this.root = path.resolve(experienceRoot)` 是**词法**根；回退分支 `realpathSync(文件)` 得到的是**完全解析**路径。当 shareDir 配置路径本身经过符号链接（如 macOS `/tmp → /private/tmp`，或运维把 `MAO_SHARE_DIR` 配成经软链到达的目录）时，`realpath(<ws>/团队经验/x.md) = /private/tmp/...` 与词法根 `/tmp/.../agent-experience` 的 `isUnder` 恒为假 → 回退失效，退化回 round-01 Bug1 的表现（经链接写入不即时刷新，靠会话创建/admin 读取自愈）。注意同库的 `PathSandbox.addAllowedRoot`（`path-sandbox.ts:31-35`）正是为同类问题登记了「词法根 + realpath 根」双根（`allowedRealRoots`），`ExperienceIndexService` 未套用该模式。

**影响评估**：生产默认 `MAO_SHARE_DIR=/opt/mao-data/share` 为真实目录、无符号链接祖先，**不受影响**；仅在非默认配置（路径含软链）下触发，且只是刷新延迟、最终一致仍在。故定轻微。

**复现/验证方式**：临时 spec（跑毕删除）：`mkdtempSync(join(tmpdir(), ...))` 在本机得到 `/tmp/r2-symlink-root-xxx`（`/tmp` 为 `/private/tmp` 软链），以其为 share 根挂载链接后经 `WriteFileTool` 写 `团队经验/2026-10-24-a.md` → 写成功、文件落库目录，但 INDEX.md 保持 `<!-- count: 0 -->`（对照：默认配置下同款端到端用例 `count: 1`）。

**修复建议**：构造器内照 `addAllowedRoot` 双根模式补 `realPathOrSelf(root)` 存为第二根，回退判定对两个根任一命中即通过。

## 三、性能观察（不计为 bug）

- `buildContext` 每轮补挂会走 `syncForSession → ensureFresh`，即每轮全量扫库目录（readdir + 每篇 open/read ≤64KB + stat）；`harness-service.ts:343` 注释称「每轮补挂代价仅一次 lstat」与实际不符。单轮成本相对 LLM 调用可忽略（且有 64KB 上限），功能正确性无影响；如在意可在补挂路径跳过 `ensureFresh`（刷新本就另有触发点）。另外工作区被同名真实目录阻塞时每轮打一条 warn 日志，属可容忍噪音。

## 四、验证命令汇总

- 临时端到端/疑点用例：`cd backend-ts && npx vitest run src/harness/experience/zz-review2-verify.spec.ts` → 2/2 通过（Bug1 修复闭环 `count:1`；N1 疑点复现 `count:0`；跑毕已删除）
- 修复自带回归 + 相关套件：`npx vitest run src/harness/experience src/harness/core/harness-service.spec.ts src/harness/core/prompt-engine.spec.ts src/agent src/harness/tool/impl/file-tools.spec.ts` → 17 files / 309 tests 全过
- 范围核对：`git diff --name-only c0191676..HEAD` 共 42 文件 = round-1 提交 40 + 修复提交新增 round-01 报告与既有文件修改，无其他未审变更
