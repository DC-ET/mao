# 2026-10-24 逻辑 BUG 审查报告（backend-ts）

> 审查范围：`backend-ts`（NestJS + Fastify 后端）。覆盖 44 个域目录、570 个非测试 `.ts` 文件（约 10.5 万行）。前端 `admin` / `desktop`、`agent-cli`、`skills/mao-cli` 在本轮只做旁路核对，未列入正式条目（原因见第六节）。
> 审查方式：按域通读源码（`harness/tool`、`harness/core`、`session`、`admin`、`auth`、`usage`、`budget`、`statistics`、`feishu`、`digest`、`inbox`、`schedule`、`skill`、`http-tool` 等），对每个疑点先写 vitest 用例、实跑确认「预期行为 vs 当前实现」的差异，再回查 `docs/code-review/` 历史报告排重。
> 结论：**确认 10 个逻辑 BUG**（P1 2 条、P2 7 条、P3 1 条），全部有可执行用例复现；另有 3 条高可信疑点因不满足「可单测复现」未计入（见第六节，其中第 1 条已按维护者要求补充修复）。
> **审查阶段未修改产品代码**，只新增验证用例文件与本报告；用例按仓库既有约定命名，断言的是**正确行为**，修复前为红、修复后转绿（同 `2026-10-22-logic-bug-review-02.md` 的节奏）。
>
> **修复状态（2026-10-24 闭环）**：10 条正式 BUG + 第六节候选 1（管理端轮询合并丢上一轮）已全部修复；backend-ts 验证用例 10 文件 / 29 条通过，admin 新增用例 6 条通过，backend-ts 全量 `npm test` 431 文件 / 4919 条通过、`npm run build` 通过，admin `npm run build` 通过，CHANGELOG 记 0.0.341。修复提交留在工作区，由维护者审定后提交。

---

## 修复记录（2026-10-24 闭环）

| # | 修复位置 | 关键改动 |
|---|---------|---------|
| BUG-1 | `harness/tool/danger-assessor.ts` | 只有首行明确 `SAFE` 才免审批；空响应/拒答/不可解析统一 `dangerous:true` +「安全评估输出不可解析，默认需要审批」 |
| BUG-2 | `session/session.service.ts` | clone 前记录 `projectExisted`；失败只在「本次新建」时清理目录，已有项目工作区原样保留 |
| BUG-3 | `session/admin-message-compact.ts` | 失败态嗅探改为头 512 字 + 尾 500 字；`exit_code` 支持负数，非 0 即失败 |
| BUG-4 | `admin/admin-analytics.service.ts`、`admin/src/utils/labels.ts`、`admin/src/views/analytics/chart-options.ts` | `PHASES` 由 `ACTIVE_PHASES` 派生（含 `CANCELLING`），新增 `phaseDistributionOf` 追加未知 phase，保证分布合计 == 会话总数；管理后台阶段标签/配色补「取消中」 |
| BUG-5 | `admin/admin-analytics.service.ts`、`usage/llm-call.repository.ts` | `modelId === 0` 改生成 `model_id IS NULL`，聚合与筛选同口径 |
| BUG-6 | `auth/ecp-identity.repository.ts` | 换票解析返回前按最早绑定补齐 `user.externalProvider`，登录响应与 `/auth/me` 一致 |
| BUG-7 | `harness/tool/impl/task-tools.ts` | `items` 非数组或为空直接 `errorJson`，不再假成功 |
| BUG-8 | `harness/tool/tool-image-result-processor.ts` | 视觉不可用结果补 `error` 键，`normalizeToolResult` 判失败态 |
| BUG-9 | `harness/tool/json.ts`、`read-file-tool.ts`、`task-tools.ts` | 新增 `asIntStrict`（不做 trunc），`offset` 与待办 id 改用它，`1.5`/`-0.5` 报错 |
| BUG-10 | `admin/admin.routes.ts` | 运行监控默认相位集由 `ACTIVE_PHASES + FAILED/CANCELLED` 生成，含 `CANCELLING` |
| 补充（原第六节候选 1） | `admin/src/views/session/utils/messagePageMerge.ts`、`SessionDetailView.vue` | 轮询合并由「按轮次切 current」改为「按消息 id 游标」：早于最新页首条消息的历史全部保留，新开一轮不再丢上一轮 |

同步更新：`CHANGELOG.md`（0.0.341）、`desktop/package.json` + lock（版本 0.0.341）、`admin` 阶段标签与配色、`skills/mao-cli/reference/analytics.md`（8 阶段、modelId=0 口径）、`skills/mao-cli/reference/runtime.md`（默认相位集）。

---

## 一、结论摘要

| # | 位置 | 级别 | 一句话 | 验证用例 |
|---|------|------|--------|----------|
| BUG-1 | `backend-ts/src/harness/tool/danger-assessor.ts:55-66` | **P1** | SMART 档安全评估输出不可解析（空串/拒答）被判成 SAFE，危险命令免审批直接执行 | `danger-assessor.bugcheck.spec.ts` |
| BUG-2 | `backend-ts/src/session/session.service.ts:203-205` | **P1** | `git clone` 失败时无条件递归删除项目工作区：同仓库建第二个会话即删掉上一条会话的整个仓库 | `session-workspace-clone.bugcheck.spec.ts` |
| BUG-3 | `backend-ts/src/session/admin-message-compact.ts:115-120` | **P2** | 失败且输出超 4000 字的 shell 调用被判成成功（只扫末尾 500 字，真实载荷 `exit_code` 在头部） | `admin-message-compact-tool-error.bugcheck.spec.ts` |
| BUG-4 | `backend-ts/src/admin/admin-analytics.service.ts:714` | **P2** | 阶段分布枚举漏 `CANCELLING`：饼图漏数据，分布合计与同响应里的会话总数对不上 | `admin-analytics-phase-list.bugcheck.spec.ts` |
| BUG-5 | `backend-ts/src/admin/admin-analytics.service.ts:376-379`、`backend-ts/src/usage/llm-call.repository.ts:199-202` | **P2** | 「未关联模型」(modelId=0) 下钻恒为空：聚合按 `COALESCE(model_id,0)` 归并，筛选却用 `model_id = 0` | `admin-analytics-null-model-filter.bugcheck.spec.ts` |
| BUG-6 | `backend-ts/src/auth/ecp-identity.repository.ts:31,50`、`backend-ts/src/auth/ecp-auth.service.ts:187` | **P2** | ECP 换票登录返回的 `authSource` 恒为 `LDAP`（用户行缺 `external_provider` 派生列），与 `/auth/me` 的 `ECP` 矛盾 | `ecp-auth-authsource.bugcheck.spec.ts` |
| BUG-7 | `backend-ts/src/harness/tool/impl/task-tools.ts:58` | **P2** | `task_create` 的 `items` 非数组时被当成空数组，仍返回成功 + 「已创建 0 个事项」+「任务已创建」引导 | `task-create-items-shape.bugcheck.spec.ts` |
| BUG-8 | `backend-ts/src/harness/tool/tool-image-result-processor.ts:30-38` | **P2** | 模型不支持视觉时的「读图失败」结果不带 `error` 键，下游判成 success（UI/审计/统计全部记成功） | `tool-image-vision-error.bugcheck.spec.ts` |
| BUG-9 | `backend-ts/src/harness/tool/json.ts:24-30`、`read-file-tool.ts:158`、`task-tools.ts:190` | **P2** | 先 `Math.trunc` 再 `Number.isInteger`：`id=1.9` 被当成 #1 更新、`offset=1.5` 被当成 1、`offset=-0.5` 得到 `-0` 被接受 | `integer-arg-truncation.bugcheck.spec.ts` |
| BUG-10 | `backend-ts/src/admin/admin.routes.ts:147-149` | **P3** | 「运行监控」默认相位集收录两个终态却漏掉活跃态 `CANCELLING`，取消中的会话从监控列表消失 | `admin-runtime-phase-list.bugcheck.spec.ts` |

---

## 二、验证方式与结果

### 2.1 环境

- Node `v22.14.0`，Vitest `3.2.7`，Linux x64。
- 用例直接调用产品代码路径，不依赖 MySQL / 网络 / 外部渠道；需要文件系统的地方使用仓库自带的 `src/testing/tmp-dir.ts`（自动清理）。

### 2.2 运行命令

```bash
cd backend-ts && npx vitest run \
  src/harness/tool/danger-assessor.bugcheck.spec.ts \
  src/session/session-workspace-clone.bugcheck.spec.ts \
  src/session/admin-message-compact-tool-error.bugcheck.spec.ts \
  src/admin/admin-analytics-phase-list.bugcheck.spec.ts \
  src/admin/admin-analytics-null-model-filter.bugcheck.spec.ts \
  src/auth/ecp-auth-authsource.bugcheck.spec.ts \
  src/harness/tool/impl/task-create-items-shape.bugcheck.spec.ts \
  src/harness/tool/tool-image-vision-error.bugcheck.spec.ts \
  src/harness/tool/impl/integer-arg-truncation.bugcheck.spec.ts \
  src/admin/admin-runtime-phase-list.bugcheck.spec.ts
```

### 2.3 实跑结果

修复前（存在性证明）：

```
 Test Files  10 failed (10)
      Tests  17 failed | 10 passed (27)
```

修复后（2026-10-24 闭环）：

```
 Test Files  10 passed (10)
      Tests  29 passed (29)
```

修复前的 17 条失败全部是具体的 `expected / actual` 断言差异，没有 import 失败、语法错误或环境缺失；对照组覆盖「明确 `SAFE` 仍放行、合法整数正常读取、合法数组正常创建、具体模型 id 仍等值筛选、更早绑定其它 provider 时保留原来源」等边界。

### 2.4 基线（证明失败由本次新增用例引入）

```bash
cd backend-ts && npx vitest run src/harness/tool src/session src/admin src/auth \
  --exclude '**/*.bugcheck.spec.ts' --exclude '**/*.reviewcheck.spec.ts'
```

```
 Test Files  89 passed | 1 skipped (90)
      Tests  1355 passed | 13 skipped (1368)
```

即：受影响四个模块的既有用例全绿，本轮新增的 10 个 `.bugcheck.spec.ts` 是唯一的红点。

---

## 三、逐条详述（BUG-1 ~ BUG-5）

### BUG-1（P1，安全）危险命令安全评估 fail-open：输出不可解析即放行

**位置**：`backend-ts/src/harness/tool/danger-assessor.ts:55-66`（`parseVerdict`）

```ts
if (upper.startsWith('DANGEROUS')) { ... return { dangerous: true, reason }; }
harnessLog('info', `Danger assessment for command [${command}]: SAFE`);
return { dangerous: false, reason: null };
```

**触发条件**：SMART 权限档下调用 shell 等工具，`DangerAssessor.assess()` 走到 `LlmAdapter.chat()` 成功但内容为空串、拒答（「我觉得这个命令没问题」）、或格式幻觉（没按 `SAFE` / `DANGEROUS:` 契约输出）。

**实际 vs 期望**：
- 实际：`{ dangerous: false, reason: null }` → `tool-dispatcher.ts` 的 SMART 分支 `needApproval:false`，命令直接执行。
- 期望：评估未给出契约内答案 ⇒ 按危险处理（`dangerous:true` + 「无法评估，默认需要审批」）。

**为什么是 bug（仓库内正确口径）**：
- 同文件 catch 分支（`:50-52`）：LLM 调用异常 → `{ dangerous: true, reason: '安全评估服务异常，默认需要审批' }`。传输失败比「成功但输出不可解析」更轻，两者结论却相反。
- `harness/tool/proxy-approver.ts`：审批输出不可解析 → `ok:false` → 转人工审批；`harness/tool/jev-risk-assessor.ts`：响应畸形 → `ok:false` 降级，不放行。
- `tool-dispatcher.ts` SMART 分支：`approvalModel == null` 时明确 `needApproval:true` +「无法进行安全评估，默认需要审批」。

**验证用例**：`backend-ts/src/harness/tool/danger-assessor.bugcheck.spec.ts`
```
× 空响应按危险处理（当前被判为 SAFE）            expected false to be true
× 自然语言拒答/幻觉按危险处理（当前被判为 SAFE）  expected false to be true
✓ 对照：明确 SAFE 才免审批，明确 DANGEROUS 仍拦截
✓ 对照：适配器抛错已经是 fail-closed
```

**修复方向**：仅当首行严格匹配 `^SAFE\b`（`trim()` 后）才 `dangerous:false`；其余（含空串、无法识别）统一 `dangerous:true, reason:'安全评估输出不可解析，默认需要审批'`。

**排重**：`docs/code-review/` 中 `DangerAssessor` 仅出现在 2026-08-07 的重试体验报告（压缩摘要重试）与 2026-09-30 的代理权限报告（SMART 语义说明），未涉及 fail-open。

---

### BUG-2（P1，数据丢失）`git clone` 失败会删掉已存在的项目工作区

**位置**：`backend-ts/src/session/session.service.ts:197-209`，关键行 `:204`

```ts
const projectPath = CloudWorkspaceResolver.resolveProjectWorkspace(this.pathSandbox, userId, slug);
this.ensureWorkspaceDirectory(projectPath);
const result = await this.gitOperationService.clone(gitCloneUrl, gitBranch, projectPath, ...);
if (!result.success) {
  this.deleteWorkspaceDirectory(projectPath);   // ← 无条件递归删除
  throw new BusinessException(ErrorCode.GIT_CLONE_FAILED, ...);
}
```

`deleteWorkspaceDirectory` 是 `rmSync(path, { recursive: true, force: true })`（`:1581-1589`）。

**触发条件**：同一用户用同一个 Git 地址创建第二个会话（`<workspaceRoot>/<userId>/projects/<slug>` 已存在且非空），或第一次 clone 只成功了一部分后重试。`git clone --depth 1 <url> <非空目录>` 必然以 “destination path already exists and is not an empty directory” 失败，随后整目录被删除——上一条会话的仓库、未提交改动、产物全部消失。

**实际 vs 期望**：
- 实际：clone 失败 → 项目工作区被递归删除；新建会话回滚（`rollbackCreatedSession` 只应删本次新建的会话与空目录）。
- 期望：clone 失败只回滚本次会话；不得动既有的项目工作区。

**为什么是 bug**：项目工作区按 `(userId, slug)` 共享（`CloudWorkspaceResolver.resolveProjectWorkspace`），并非本次会话独占；`rollbackCreatedSession` 删除 `session.workspace` 已有边界，但 clone 失败分支在 `session.workspace` 赋值之前就执行了更危险的全目录删除。仓库对「删除」有明确提升守卫（`session.service.ts` 的 active phase 删除守卫），此处却无任何「是否本次创建」判断。

**验证用例**：`backend-ts/src/session/session-workspace-clone.bugcheck.spec.ts`
```
× 第二次用同一个仓库建会话失败时，上一条会话的仓库文件必须保留
    AssertionError: expected false to be true   // keep-me.txt 已不存在
```

**修复方向**：clone 到临时目录（同盘 `projectPath + '.clone-tmp'`）成功后再原子 rename；或记录 `existedBefore` 并只在「本次新建且为空」时删除。失败时永远不要删一个已有内容的目录。

**排重**：`docs/code-review/` 无 `GIT_CLONE_FAILED` 相关报告；`deleteWorkspaceDirectory` 仅在 2026-08-20 报告出现过（另一路径）。

---

### BUG-3（P2）管理端「失败」的 shell 调用在输出超长时显示成成功

**位置**：`backend-ts/src/session/admin-message-compact.ts:115-120`

```ts
function isToolError(text: string): boolean {
  ...
  return /"exit_code"\s*:\s*(?!0(?:\D|$))\d+/.test(text.slice(-500));
}
```

**触发条件**：shell 命令失败（`exit_code != 0` 或超时 `-1`）且 `output` 使整个结果超过 `TOOL_RESULT_LIMIT = 4000` 字符。管理端会话详情恒定带 `compact: true`（`admin/src/views/session/SessionDetailView.vue:354,378,521`），必然经过 `compactToolResult`。

**实际 vs 期望**：
- 真实载荷键序是 `exit_code, session_id, output, truncated, completed, current_workdir, output_file`（`harness/tool/impl/shell-session-tool.ts:277-285`）——`exit_code` 在**头部**，永远不在末尾 500 字里。
- 实际：截断结果不带 `Tool execution failed` 前缀；前端 `inferToolStatus` 对截断文本 `JSON.parse` 失败 → `startsWith('Tool execution failed')` 为假 → **success**。同一个失败调用，输出短时显示失败、输出长时显示成功。
- `exit_code: -1`（超时/被 kill，`shell-session-tool.ts` 的 `!completed` 分支）即使落在窗口内也匹配不上（正则要求冒号后紧跟数字）。
- 期望：失败态在截断后仍可识别（带前缀或保留 `error`）。

**为什么是 bug**：`tool-result.ts:65-71`、`session/run-trace.service.ts:578`、`session/ws/ws-streaming-event-listener.ts:353` 的权威判定都是读整份载荷 `'exit_code' in node && Number(node.exit_code) !== 0`（含负数）；`isToolError` 自己的注释写「只看结果的头尾」，实现只看了尾部。既有用例 `admin-message-compact.spec.ts:18-23` 用的是 `{"stdout":"…","exit_code":1}` 这种 shell 工具不会产出的形状，所以一直是绿的。

**验证用例**：`backend-ts/src/session/admin-message-compact-tool-error.bugcheck.spec.ts`
```
× exit_code 在头部 + 输出超长时仍应判定失败   expected false to be true
× 超时/被 kill 的 -1 也应判定失败              expected false to be true
✓ 对照：成功的长输出不加失败前缀
✓ 对照：短失败结果原样返回
```

**修复方向**：判定同时看头部（前 200 字）与尾部；能 `JSON.parse` 时直接读 `error` / `exit_code`（任意位置、允许负数），不能解析时再退回正则。正则至少改为 `/-?[1-9]\d*/`，且不要只扫尾部。

**排重**：`docs/code-review/` 无 `compactToolResult` / `isToolError` 记录；2026-08-29 报告提到过 `Tool execution failed` 文案，但讨论的是前端识别，不是截断位置。

---

### BUG-4（P2）阶段分布漏掉 `CANCELLING`，合计与「会话数」自相矛盾

**位置**：`backend-ts/src/admin/admin-analytics.service.ts:714`

```ts
const PHASES = ['IDLE', 'RUNNING', 'RESUMING', 'WAITING_APPROVAL', 'COMPLETED', 'FAILED', 'CANCELLED'];
```

同文件 `sessionsScope`（`:1077`）用 `[...periodPhases.values()].reduce(...)` 得到 `periodTotals.sessions`（对**全部** phase 行求和），而 `phaseDistribution` 按 `PHASES.map(...)` 展开（`:1080`），`livePhases` 同理（`:1087`）。

**触发条件**：窗口内存在 `phase='CANCELLING'` 的会话（用户点停止、取消流程进行中）。

**实际 vs 期望**：
- 实测（fake store 返回 `CANCELLING:4, COMPLETED:1`）：`periodTotals.sessions = 5`，`phaseDistribution` 合计 = **1**；`livePhases` 丢掉 `CANCELLING:3`；`overview` 的实时计数也不含取消中会话。
- 期望：分布之和 == 会话总数；取消中会话出现在阶段分布/实时分布中。

**为什么是 bug**：`session/util/session-group-key.ts:238` 明确 `CANCELLING` 是「取消流程进行中的活跃相位」，`ACTIVE_PHASES` 四态包含它；`session-vo.bugcheck.spec.ts:47` 以 8 个 phase（含 CANCELLING）做全量枚举断言；admin 前端 `SessionDetailView.vue:187` 的 `ACTIVE_PHASES` 也含它。这是全仓最后一处硬编码 phase 列表（没有 `Record<联合类型, …>` 式的编译期穷尽）。

**验证用例**：`backend-ts/src/admin/admin-analytics-phase-list.bugcheck.spec.ts`
```
× phaseDistribution 合计必须等于 periodTotals.sessions
    AssertionError: expected 1 to be 5
```

**修复方向**：不要硬编码。以 `ACTIVE_PHASES` + 终态集合生成本表，或直接对 store 返回的 phase 行做「已知 phase 保序 + 未知 phase 追加」，保证「分布之和 == 总数」这条不变量在任何 phase 新增时自动成立。

**排重**：2026-09-18 报告提过 `phaseDistribution`，但讨论的是前端 `||` 回退导致实时数回落到窗口数；2026-10-22 报告剔除的是 admin `PHASE_LABELS` 缺 CANCELLING（纯展示标签）。本条是后端**数据计算**缺口，不是标签。

---

### BUG-5（P2）「未关联模型」下钻恒为空：NULL 与 0 两种归并口径打架

**位置**：
- 聚合：`backend-ts/src/admin/admin-analytics.service.ts:412,428` `COALESCE(model_id, 0) AS id … GROUP BY COALESCE(model_id, 0)`，`modelStats` 对 `modelId === 0` 命名「未关联模型」（`:1503`）。
- 筛选：`backend-ts/src/admin/admin-analytics.service.ts:376-379` 与 `backend-ts/src/usage/llm-call.repository.ts:199-202`：

```ts
if (filter.modelId != null) { where.push('model_id = ?'); params.push(filter.modelId); }
```

**触发条件**：管理后台模型页点「未关联模型」行（`ModelTab.vue:271-273` → `AnalyticsView.vue` 写入 `modelId=0`），或点同页「调用流水」链接 `/llm-calls?modelId=0`（`ModelTab.vue:112`）。

**实际 vs 期望**：
- 实际：`model_id = 0`，而 `model_id IS NULL` 的行永不命中 → 场景分布为空、调用流水空列表；用户看到「未关联模型」有调用量，点进去却是 0 条。
- 期望：筛选 0 时落 `model_id IS NULL`，返回这些行。

**为什么是 bug**：聚合口径把 NULL 归并为 0 并明确命名为「未关联模型」，说明 0 是「NULL 的逻辑 id」；`2026-10-09-core-logic-bug-review-01.md:609` 还记录过生产上确有 `model_id=NULL` 行（飞书群摘要链路 `modelConfig.id` 缺失），所以这一行真实存在、可点击。

**验证用例**：`backend-ts/src/admin/admin-analytics-null-model-filter.bugcheck.spec.ts`
```
× 分析页场景分布：模型 0 下钻应生成 model_id IS NULL
× 调用明细列表：modelId=0 时应生成 model_id IS NULL（列表与计数同条件）
✓ 对照：具体模型 id 仍按等值筛选
```

**修复方向**：两处统一 `modelId === 0 ? 'model_id IS NULL' : 'model_id = ?'`；建议抽一个共用的 `modelIdClause(modelId)`，避免聚合/筛选再次漂移。

**排重**：`未关联模型` 只在 2026-10-09 报告中出现过（证明 NULL 行存在），未报筛选缺陷。

---

## 四、逐条详述（BUG-6 ~ BUG-10）

### BUG-6（P2）ECP 换票登录返回的 `authSource` 恒为 `LDAP`

**位置**：`backend-ts/src/auth/ecp-identity.repository.ts:31,50`（`SELECT * FROM user`）、`backend-ts/src/auth/ecp-auth.service.ts:187`（`UserService.resolveAuthSource(user)`）

**触发条件**：用户通过 ECP 飞书登录（桌面内嵌窗口或公网回调页），`EcpIdentityRepository.resolve()` 返回的用户行来自裸 `SELECT *`。

**实际 vs 期望**：
- `user.repository.ts:8-10` 专门定义了派生列 `(SELECT e.provider FROM user_external_identity e WHERE e.user_id = user.id ORDER BY e.id LIMIT 1) AS external_provider`，`findById/findByUsername/findByEmail/list` 全部带它；`EcpIdentityRepository` 两处用户查询（`:31`、`:50`）都没带。
- 实际：`resolveAuthSource` 在「无 password_hash、无 feishu_user_id」时兜底 `'LDAP'` → 登录响应 `authSource='LDAP'`（桌面 `ProfileView.vue:57` 直接展示该标签）。
- 同一账号随后调 `/auth/me` 走 `findById`（带派生列）→ `'ECP'`。同一账号、两条登录路径结论不同。
- 期望：ECP 登录返回 `'ECP'`。

**为什么是 bug**：`resolveAuthSource` 的判定顺序依赖 `externalProvider`，而该字段只有在带派生列的查询里才有；`EcpIdentityRepository` 是唯一漏掉它的用户读取路径。`external_provider` 的注释明确写「账号来源判定所需」。

**验证用例**：`backend-ts/src/auth/ecp-auth-authsource.bugcheck.spec.ts`
```
修复前：
× ECP 换票用户行（无 external_provider 派生列）也应返回 ECP，而不是 LDAP
    AssertionError: expected 'LDAP' to be 'ECP'

修复后（用例改为同时覆盖仓储与服务层）：
✓ EcpIdentityRepository 必须补齐 external_provider
✓ 服务层用仓储补齐后的用户行构造登录响应 → ECP
✓ 对照：无 external_provider 的历史形状仍按 resolveAuthSource 兜底（不改判定规则）
✓ 对照：更早绑定其它 provider 时保留最早来源，不硬写成 ecp
```

**修复方向**：`EcpIdentityRepository` 的用户查询统一带 `EXTERNAL_PROVIDER_COLUMN`（或至少在 resolve 返回前设置 `externalProvider: 'ecp'`）；长期看应把这段 SQL 抽成 `user` 域导出的片段，避免第三处 `SELECT *` 再次漂移。

**排重**：`docs/code-review/` 中 `resolveAuthSource` 出现在 2026-08-06 的 SSO 系列报告，讨论的是 `authSource` 筛选/展示口径；`authSource` 相关 9 份报告均未涉及 ECP 换票路径的派生列缺失。

---

### BUG-7（P2）`task_create` 的 `items` 非数组时静默成功「已创建 0 个」

**位置**：`backend-ts/src/harness/tool/impl/task-tools.ts:58`

```ts
const items = Array.isArray(args.items) ? args.items : [];
...
return toJson({ todos, message: `已创建 ${count} 个事项`, hint: '任务已创建。请将第一个 pending 任务标记为 in_progress 后开始执行。' });
```

**触发条件**：模型参数抖动——把数组 `JSON.stringify` 成字符串（`{"items":"[{\"content\":\"a\"}]"}`），或直接给单个对象（`{"items":{"content":"a"}}`）。

**实际 vs 期望**：
- 实际：`items` 被当成 `[]`，返回 `{"todos":[],"message":"已创建 0 个事项","hint":"任务已创建。请将第一个..."}`；`normalizeToolResult` 看不到 `error` 键 → `status:'success'`。模型据此以为待办已建立，继续按「任务已创建」推进，实际 `task_list` 为空。
- 期望：带 `error` 的失败态（「items 必须是数组，收到字符串/对象」），或先按 `ask_user_questions` 的口径解壳后再校验。

**为什么是 bug（仓库内正确口径）**：
- `harness/tool/ask-user-questions-normalize.ts` 专门对 `questions` 的双重编码做解壳，且 `tool-dispatcher.ts:415-417` 在归一化后仍为空时明确报错「questions 不能为空」，而不是返回成功。
- 同文件 `TaskDeleteTool` 的既有修复（`docs/code-review/2026-10-22-logic-bug-review-02.md` BUG-D3）已确立「工具结果里的数量/成功必须与真实副作用一致」，不接受假成功。
- schema 把 `items` 声明为 `type:'array'` 且 `required`，非数组属于契约外输入，不应静默降级。

**验证用例**：`backend-ts/src/harness/tool/impl/task-create-items-shape.bugcheck.spec.ts`
```
× items 被双重编码成 JSON 字符串（当前假成功「已创建 0 个」）  expected undefined to be defined
× items 是单个对象（当前假成功「已创建 0 个」）               expected undefined to be defined
✓ 对照：合法数组正常创建 1 条
```

**修复方向**：`Array.isArray` 为假时直接 `errorJson`；如需容忍字符串化数组，先复用 `ask-user-questions-normalize` 的解壳逻辑再校验。另外 `count === 0` 时不应输出「任务已创建，请将第一个 pending 任务…」的引导语。

**排重**：`task_create` 在 2026-10-02 报告中被报的是「status 无白名单」，在 2026-10-13 报告中被报的是活动分类；都不是 `items` 形状。

---

### BUG-8（P2）不支持视觉时的「读图失败」不带 `error` 键，被判成成功

**位置**：`backend-ts/src/harness/tool/tool-image-result-processor.ts:30-38`

```ts
if (!supportsVision) {
  const errorContent = VISION_ERROR_TEMPLATE.replace('%s', ...);
  return { sanitizedContent: JSON.stringify({ content: errorContent, total_lines: 0 }), ... };
}
```

**触发条件**：模型不支持视觉（`supportsVision === false`）时，工具返回图片结果（`read_file` 读 png 等 `media_type:'image'`）。

**实际 vs 期望**：
- `normalizeToolResult` 只认「JSON 顶层含 `error` 键」或「`exit_code` 非 0」（`tool-result.ts:65-71`）。
- 实际：`{content:'错误：无法读取图片…', total_lines:0}` 不含 `error` → `status:'success'`；`ws-streaming-event-listener.ts:133` 的 `isError` 为 false → 前端工具卡、审计、统计全部记成功。
- 期望：失败态（带 `error` 键），模型侧文案保持不变。

**为什么是 bug（仓库内正确口径）**：`read-file-tool.ts:141-147` 的 `readError()` 注释写得很直白：「必须带 `error` 键——`normalizeToolResult` 以『JSON 顶层含 error 键』判定失败态，缺键会被判成 success，下游 UI、审计与统计会把读失败当成读成功」。其余工具（`grep_search`/`glob_search`/`task_*`）出错都走 `errorJson`。

**验证用例**：`backend-ts/src/harness/tool/tool-image-vision-error.bugcheck.spec.ts`
```
× sanitizedContent 顶层应含 error（当前只有 content/total_lines）
× 下游 normalizeToolResult 必须判为 error（当前判 success）
    AssertionError: expected 'success' to be 'error'
✓ 对照：支持视觉时正常剥离 data_uri 并产出附件，状态成功
```

**修复方向**：`JSON.stringify({ content: errorContent, error: errorContent, total_lines: 0 })`（与 `readError` 同形）；文案保持不变。

**排重**：`docs/code-review/` 无 `无法读取图片` / `VISION_ERROR` 记录。

---

### BUG-9（P2）整数参数先截断后校验：小数被静默接受

**位置**：
- `backend-ts/src/harness/tool/json.ts:24-30`（`asInt` 内部 `Math.trunc`）
- `backend-ts/src/harness/tool/impl/task-tools.ts:190,294`（`const id = asInt(item.id); if (!(id > 0)) ...`）
- `backend-ts/src/harness/tool/impl/read-file-tool.ts:157-163`（`const n = asInt(value, NaN); if (!Number.isInteger(n) || n < 0) throw ...`）

**触发条件**：模型给出小数/负小数 id 或 offset。

**实际 vs 期望**：
- `task_update({"items":[{"id":1.9,"status":"completed"}]})`：`asInt(1.9)` → `1`，`1 > 0` 通过 → **更新 #1** 并回报「已将任务 #1 更新为 completed」；期望报「无效的待办事项 ID: 1.9」。
- `read_file({"path":"a.txt","offset":1.5})`：`asInt` 截成 `1`，`Number.isInteger(1)` 恒真 → 从第 2 行开始返回；期望报错。
- `read_file({"path":"a.txt","offset":-0.5})`：`Math.trunc(-0.5) === -0`，`-0 < 0` 为 false → **负数被接受**，从第 1 行读起；期望报错。
- 三条都返回 `success`（无 `error` 键），模型无法感知入参非法。

**为什么是 bug（仓库内正确口径）**：`read-file-tool.ts:155-158` 的注释明确「非法值（负数、非数字、小数）一律抛错……负数钳到 0 会让模型拿到『空 content + success』」；`docs/code-review/2026-10-22-logic-bug-review-02.md` BUG-D3 把「id 必须为正整数」作为既定契约修过 `null/'' → 0` 的缺口，但 `asInt` 的截断让小数继续绕过该契约。`glob-search-tool.ts:57-59` 用 `Number.isSafeInteger(args.head_limit)` 校验**原始值**，说明仓库的正确做法是校验原值而不是截断后的值。

**验证用例**：`backend-ts/src/harness/tool/impl/integer-arg-truncation.bugcheck.spec.ts`
```
× task_update id=1.9 必须报错（当前把 #1 更新并回报成功）
× read_file offset=1.5 必须报错（当前从第 1 行开始返回）
× read_file offset=-0.5 必须报错（当前落入 -0 分支被接受）
✓ 对照：合法整数 offset 正常读取
```

**修复方向**：新增 `asIntStrict`（`typeof value === 'number' && Number.isInteger(value)`，字符串仅接受 `/^-?\d+$/`），`parseLineIndex`、`task_update`/`task_delete` 的 id 改用它；`asInt` 保留给「容忍型」场景（如 `n`、`head_limit` 的旧路径），并在注释里写清两者差异。

**排重**：`asInt` 在 7 份报告中出现，均为其它语义（空串/负数钳制、`Number.MAX_SAFE_INTEGER` 回落、id 为 `null→0`）；没有一份涉及「小数截断后通过校验」。

---

### BUG-10（P3）「运行监控」默认相位集漏掉活跃态 `CANCELLING`

**位置**：`backend-ts/src/admin/admin.routes.ts:147-149`

```ts
const runtimePhase = !q.phase || q.phase.trim() === ''
  ? 'RUNNING,RESUMING,WAITING_APPROVAL,FAILED,CANCELLED'
  : q.phase;
```

**触发条件**：`GET /v1/admin/runtime/sessions` 不带 `phase`（管理后台运行监控默认视图、`mao-cli runtime sessions` 默认调用）。

**实际 vs 期望**：
- 实际：取消中的会话（`phase='CANCELLING'`）不在列表里；而该默认集已经收录 `FAILED`/`CANCELLED` 两个终态，显然意图是「在跑 + 异常」。
- 期望：包含全部 `ACTIVE_PHASES`（`RUNNING/RESUMING/WAITING_APPROVAL/CANCELLING`）+ `FAILED/CANCELLED`。

**为什么是 bug**：`session/util/session-group-key.ts:238` 定义 `ACTIVE_PHASES` 四态并注释「CANCELLING 是取消流程进行中的活跃相位，漏列会把取消中的会话当空闲」；同文件还导出 `ACTIVE_PHASE_SQL_LIST` 供 SQL 使用，这里却手写了一份漂移的清单。

**验证用例**：`backend-ts/src/admin/admin-runtime-phase-list.bugcheck.spec.ts`
```
× 默认列表必须包含 ACTIVE_PHASES 的每个相位（当前漏 CANCELLING）
    AssertionError: expected [ 'RUNNING', 'RESUMING', …(3) ] to include 'CANCELLING'
✓ 对照：显式传 phase 时原样透传
```

**修复方向**：默认值由 `ACTIVE_PHASES` + `['FAILED','CANCELLED']` 拼接生成，或直接复用 `ACTIVE_PHASE_SQL_LIST`。

**排重**：`RESUMING`/`CANCELLING` 在 2026-10-14、10-16、10-22 报告中出现过，但分别是 `running` 三目、分组排序 SQL、前端 `ACTIVE_PHASES`；没有一份涉及 admin 运行监控默认过滤集。

---

## 五、修复顺序（已执行）

1. **安全 / 数据丢失（P1）**：BUG-1（危险命令 fail-open）→ BUG-2（clone 失败删工作区）。这两条一旦触发后果不可逆，建议优先并单独发版。
2. **用户可见的数据正确性（P2）**：BUG-5（未关联模型下钻恒空）→ BUG-7（task_create 假成功）→ BUG-3（失败显示成功）→ BUG-6（authSource 错误）。
3. **状态/展示口径（P2）**：BUG-8（视觉错误判成功）→ BUG-4（阶段分布漏 CANCELLING）→ BUG-9（整数截断）→ BUG-10（运行监控漏 CANCELLING）。

上述 10 个 `.bugcheck.spec.ts` 已随修复全部转绿（10 文件 / 29 条），无需改 vitest 配置（它们已在默认套件 `src/**/*.spec.ts` 内）。

---

## 六、未计入正式 BUG 的候选（其中候选 1 已补充修复）

以下 3 条是审查阶段经代码追踪**高度可疑**、但因「无法在不改产品代码的前提下单测」或「正确语义需产品确认」未计入正式 BUG 数的疑点。其中候选 1 已按维护者要求补充修复；候选 2、3 留作下一轮输入。

| 候选 | 位置 | 状态与说明 |
|------|------|--------------|
| 管理端轮询合并丢上一轮 | `admin/src/views/session/SessionDetailView.vue:184`（`POLL_ROUND_LIMIT = 1`）、`admin/src/views/session/utils/messagePageMerge.ts` | **✅ 已补充修复（2026-10-24）**。原实现按「最近 1 轮」切掉 current 的最后一轮再拼 latest：`current=[U1,A1,U2,A2]` + `latest=[U3]` → `[U1,A1,U3]`，U2/A2 整轮消失且不自愈。现改为按消息 id 游标合并：早于 `latest[0].id` 的 current 消息全部保留，从该 id 起用 latest 覆盖；非数字 id（旧载荷/乐观消息）退化为只追加去重，绝不删已有内容。纯函数抽到 `utils/messagePageMerge.ts` 并补 6 条单测。 |
| 技能上传的系统同名预检对 YAML 注释失效 | `desktop/src/components/skill/SkillManager.vue:302-318`（`parseSkillMdName`）、`desktop/electron/main.cjs:855` | 行正则取 `name:` 值，`name: mao-cli # 注释` 得到 `mao-cli # 注释`，永远匹配不上系统技能名；后端仍会 409，属「前端预检恒失效 + 失败被算成 failed 而非 skipped」。受 SFC/主进程内联限制，暂无法直接单测。 |
| 管理后台「运行中」筛选漏 `RESUMING`/`CANCELLING` | `admin/src/utils/labels.ts:85-92`（`PHASE_OPTIONS`）+ `backend-ts/src/session/session.service.ts:465-469`（单值 `phase = ?`） | 列表把 `RESUMING` 展示成「运行中」（`session-vo.ts:144` `visiblePhase`），但筛选项只有 `RUNNING`，且后端单值走等值匹配 → 筛选「运行中」会漏掉 RESUMING 会话；`CANCELLING` 也没有筛选项。是否把「运行中」定义为四相位集合属于产品口径，需确认后再改并补用例。 |

**候选 1 的验证**：`admin/src/views/session/utils/messagePageMerge.spec.ts`（6 条，覆盖「轮询期间新开一轮」「同轮刷新覆盖」「保留加载更多历史」「空页」「非数字 id 兜底」）。运行方式（admin 依赖未装全时可用 backend-ts 的 vitest 指定 root）：

```bash
cd backend-ts
cat > vitest.admin-tmp.config.ts <<'EOF'
import { defineConfig } from 'vitest/config';
export default defineConfig({ root: '../admin', test: { include: ['src/views/session/utils/messagePageMerge.spec.ts'], environment: 'node' } });
EOF
npx vitest run --config vitest.admin-tmp.config.ts   # 6 passed
rm vitest.admin-tmp.config.ts
```

常规环境直接 `cd admin && npm test` 即可。

此外，`session.repository.ts` 的 `COMPACT_MESSAGE_COLUMNS` 只对前 5 个附件做 `JSON_REMOVE`（第 6 个起靠 `compactMetadata` JS 兜底）——行为正确，只是 DB→应用多传了 base64，属性能优化项，不计为 BUG。

---

## 七、审查与修复边界

- **审查阶段未改产品源码**；修复阶段（2026-10-24）修改了上表 10 处实现 + 第六节候选 1（管理端轮询合并），并同步 CHANGELOG 0.0.341、desktop 版本、admin 阶段标签/配色与 `skills/mao-cli` 参考文档。修复未做 git commit，留在工作区由维护者审定后提交。
- **未做端到端验证**：上述缺陷均为单元级可复现问题，用例直接调用产品代码；BUG-2 使用真实文件系统临时目录，未连生产。修复后 `backend-ts` 全量 `npm test`（431 文件 / 4919 条通过）与 `npm run build` 通过。
- **未覆盖的范围**：`feishu`/`weixin`/`dingtalk` 的渠道协议细节、`harness/mcp`、前端 SFC 内部逻辑（见第六节）、`agent-cli` 与 `skills/mao-cli` 本轮仅做旁路核对。
- **测试先红后绿**：backend-ts 10 个正式 BUG 用例修复前为红、修复后全部转绿并留在默认套件；admin 轮询合并补充 6 条用例。第六节候选 2、3 仍待后续处理。
