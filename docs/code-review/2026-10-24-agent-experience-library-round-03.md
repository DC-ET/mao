# 代码审查：Agent 团队经验库（round-03 确认性复审）

- 审查对象：worktree `.worktrees/agent-experience-library`，分支 `feature/agent-experience-library`
- 审查范围：`git diff c0191676..HEAD`，重点复核修复提交 17373b52（round-02 的 N1 与性能观察）是否正确、有无引入新问题；前两轮已验证部分不重验
- 审查日期：2026-10-24
- 结论：**refreshIndex 短路修复完全正确；N1 双根修复存在一个时序性残余缺口（轻微，已验证）**——构造时经验根尚不存在的首个进程生命周期内双根退化为单根。无其他新问题。

---

## 一、修复复核（round-02 → 17373b52）

### 1. 性能观察（每轮全量扫库）→ `syncForSession` 增 `refreshIndex` 参数 ✅

**位置**：`backend-ts/src/harness/experience/experience-mount.service.ts:31-45` + `harness-service.ts:347-355`

**复核**：
- 默认值 `true`：会话创建路径（`session.service.ts` 三参调用）行为不变，技术方案触发点 1（建会话 ensureFresh）保持；
- `buildContext` 每轮兜底传 `false`：链接已正确时 `isCorrectSymlink`（lstat+readlink）短路返回，不再每轮扫库；链接缺失/错指（存量会话首遇、换 Agent 重绑）仍走完整挂载（含 ensureFresh 引导）——自带测试两分支（陈旧索引原样保留 / 链接缺失完整重建）覆盖，逻辑正确；
- `ensureDirSymlink` 复用 `isCorrectSymlink`，判定与原内联逻辑逐字节等价；`enabled=false` 移除链接路径不受参数影响；
- 接口结构类型（`app-harness-engine.ts`/`harness-service.ts`）同步更新，`harness-service.spec.ts` 期望已改为 `(…, true, false)`，注释「代价仅一次 lstat」的失实表述已修正。

### 2. N1（符号链接祖先根失配）→ 构造器缓存 `rootReal` 双根比对 ⚠️ 修复方向正确，但有构造时序残余缺口（见下）

**位置**：`backend-ts/src/harness/experience/experience-index.service.ts:33-42,131-160`

**复核**：`matchRoot`（词法根 / realpath 根任一命中）+ 回退分支 `realpathSync(文件)` 后比对 `matchedRoot`、`firstSegment` 改按命中根取相对路径，逻辑本身正确；自带测试（alias 根构造前已存在）通过。**但存在下述缺口。**

## 二、发现（轻微，已验证）

### R3-1（轻微）：`rootReal` 在构造时缓存，经验根懒创建导致生产首启时序下双根退化为单根，N1 在首个进程生命周期内仍不生效

**位置**：`backend-ts/src/harness/experience/experience-index.service.ts:36-42`（构造器）+ `realPathOrSelf`（L242-248）

**问题描述**：生产时序是 `create-app` 启动阶段构造 `ExperienceIndexService`（create-app.ts L510），而经验根 `<shareDir>/agent-experience` 按**懒创建**（首次挂载 `ensureFresh` 才 `mkdirSync`，启动只建 shareDir 本身）。`realPathOrSelf` 对不存在的路径捕获异常后回退**词法字符串**，因此首启（或全新 share 部署）时 `rootReal === root`（词法），且构造后**永不重算**。之后首次挂载创建了根，`rootReal` 仍是词法根——双根名存实亡。在 round-02 N1 的触发配置（shareDir 路径自身含符号链接祖先，如 macOS `/tmp → /private/tmp`）下，经挂载链接写入的 realpath 回退依旧双根失配，即时刷新在本进程生命周期内持续失效，直到后端重启（重启时根已存在，缓存才正确）。修复自带测试先 `mkdirSync`/`symlinkSync` 建好根再构造，恰好只覆盖了「重启后」时序。

**影响评估**：与 N1 同级且更窄——仅非默认配置（shareDir 配置路径含软链祖先）× 首个进程生命周期；索引最终一致仍由会话创建（refreshIndex=true 全量 ensureFresh）与 admin 读取兜底。轻微。

**复现/验证方式**（临时 spec，跑毕删除；`mkdtempSync(join(tmpdir(), …))` 得到 `/tmp/r3-firstboot-xxx`，`/tmp` 为 `/private/tmp` 软链）：

- 情形 B（生产首启时序）：构造时 `<shareBase>/agent-experience` 不存在 → `syncForSession` 首挂创建根与链接 → 经链接写入 + `refreshIfUnderRoot`（词法工作区路径）→ 不抛错但 INDEX.md 保持 `<!-- count: 0 -->`（缺口复现）；
- 情形 A（对照，重启后时序）：先 `mkdirSync(rootLexical)` 再构造，同样步骤 → INDEX.md 含新条目、`<!-- count: 1 -->`（证明双根本身正确，缺口仅在构造时序）。

- 运行：`cd backend-ts && npx vitest run src/harness/experience/zz-review3-verify.spec.ts` → 2/2 通过。

**修复建议**（任一，改动都很小）：
- a) 懒计算 + 重试：`rootReal` 初值 null，`matchRoot` 双词法根都 miss 时若 `rootReal` 尚未成功 realpath 过则现场 `realPathOrSelf(this.root)` 重算并缓存（成功后不再重算）；
- b) 启动兜底：`create-app.ts` 构造前 `mkdirSync(join(shareDir, EXPERIENCE_ROOT_SUBDIR), { recursive: true })`（shareDir 启动时本就 mkdir，多建一层子目录无副作用），保证构造时根必存在；
- c) `ensureFresh`/`dirFor` 首次创建根目录后回填一次 `rootReal`。

## 三、其余核对

- 提交范围：`git diff --name-only 971b3b23..HEAD` 仅 7 个代码文件 + round-02 报告文档，无未审变更；
- 回归：`npx vitest run src/harness/experience src/harness/core/harness-service.spec.ts` → 4 files / 72 tests 全过；
- 顺带核过一个极边缘场景不列为问题：链接存在且指向正确但库目录被服务器侧整目录删除时，每轮兜底（refreshIndex=false）会短路而不重建目录——需人为删目录才触发，且下次新会话（refreshIndex=true）自愈。
