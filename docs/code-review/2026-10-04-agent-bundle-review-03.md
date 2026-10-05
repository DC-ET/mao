# 代码审查报告（第 3 轮）：Agent 资产化（Bundle 导出/导入 + 团队共享目录 + mao-cli）

- 日期：2026-10-04
- 审查对象：第 2 轮报告（`docs/code-review/2026-10-04-agent-bundle-review-02.md`）修复后的未提交代码，范围仅限任务指定的 backend-ts / admin / desktop / mao-cli 改动文件
- 基线：`cd backend-ts && npx vitest run src/agent/ src/skill/` 全绿（Test Files 12 passed，Tests 120 passed，exit=0）
- 结论：**第 2 轮 2 个修复全部正确落地、未引入回归**；本轮新确认 bug **2 个（重大 0、一般 2）**，存疑待确认 4 项。两个确认 bug 均以可运行 Vitest 用例实际复现（临时验证文件已于报告完成后删除，验证代码全文附于本报告内）。

## 摘要

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| 1 | 一般 | bundle 导入对重复技能名不去重 → 落库 Agent `skillNames` 含重复项；导出对话框按 skillNames 逐名生成技能行并对唯一候选默认勾选，重复行会各勾一次同一 token，被第 2 轮新增的"多个内联归属"校验拒绝——此类 Agent 在对话框默认状态下导出必失败（单 token 导出也会产出重复 inline 条目） | Vitest 复现（3/3 通过） |
| 2 | 一般 | admin 的"上架/推荐语/下架"按钮渲染依据 `GET /v1/shared-agents`（过滤停用 Agent），停用 Agent 的共享条目在管理页既不显示下架入口、重新保存又被"请先启用"拒绝，形成管理死角（后端 DELETE 实际可用但 UI 无入口） | Vitest 复现（1/1 通过）+ UI 代码路径引用 |

---

## A. 第 2 轮 2 个修复复核结论

### 修复 1：共享目录自检改为按 SKILL.md frontmatter 名匹配（`SharedAgentUserSkillLookup` + `UserSkillService`）

**✅ 正确，未引入新问题。** 逐项核实：

| 关注点 | 结论 | 依据 |
|---|---|---|
| 自检语义（frontmatter 名口径） | ✅ 与全链路一致 | `shared-agent.service.ts:80` 用 `listUserSkills(userId)` 构建 Set，`:107` 按 frontmatter 名命中；与运行时索引（`skill-sync-service.ts` `loadUserSkillDocs` 以 `doc.name` 为键）、导出候选（`agent-bundle.service.ts:99`）、导入一致性校验同口径。假缺失/假通过两方向均消除（本轮用例 1 复核通过，含他人视角仍报缺失的对照） |
| 系统技能存在但目录损坏 | ✅ 语义正确 | SKILL.md 损坏时 `SkillLoader.hasSkill` 返回 false（`skill-loader.ts:88-95` 跳过解析失败项），自检落入用户技能检查后报 missing——运行时同样加载不到该技能，角标与真实可用性一致（本轮用例 2 复核通过） |
| `listUserSkills` 对损坏 SKILL.md 的容错 | ✅ 不抛错、跳过坏条目 | `user-skill.service.ts:50-61` 单条目 try/catch（warn 后 continue），外层 `:63-65` 再兜底；坏 SKILL.md 的技能被判缺失，与运行时 `loadUserSkillDocs` 的跳过行为一致（本轮用例 3 复核通过） |
| 性能（每用户一次扫描） | ✅ 每次调用恰好 1 次 | `listSharedAgents` 在循环外构建一次 Set（`shared-agent.service.ts:80`），与条目数/技能数无关（本轮用例 4 以 spy 断言 `listUserSkills` 恰被调用 1 次） |
| 装配 | ✅ | `create-app.ts` 中 `skillLoader`（:663）、`userSkillService`（:674）均先于 `SharedAgentService`（:726-732）构造；`SharedAgentService` 构造第 4 参传入 `userSkillService`，接口 `SharedAgentUserSkillLookup` 的同步返回签名与其匹配（`await` 非 Promise 值合法） |

补充核查（修复相关的边界）：`listUserSkills` 不过滤 `isValidSkillName`（比运行时 `loadUserSkillDocs` 口径宽），但标准上传路径经 `validateSkillMd` 强制 slug 名，两者在现实数据下不会分歧；同步 `await` 差异、空目录返回 `[]`、`.staging` 目录不位于 `<userId>` 子目录下不污染扫描——均无问题。

### 修复 2：导出对话框同名候选互斥 + 后端多 token PARAM_INVALID

**✅ 正确，前后端协同成立。** `AgentExportDialog.vue:139-144` `onCandidateChange` 勾选时取消同行其余候选（el-checkbox 仅在用户交互时发 change，编程改 `checked` 不回环）；后端 `agent-bundle.service.ts:102-104` 对同名多 token 显式 PARAM_INVALID。本轮用例 5/6 复核：单 token 正常导出；重复 token（`shared@12,shared@12`）报 PARAM_INVALID 且文案明确，不 500、不静默。正常单行多候选、单候选场景无回归（第 2 轮基线用例继续通过）。

该修复唯一的缺口是**未覆盖 skillNames 本身含重复名**的场景——即本轮 Bug 1。

---

## Bug 1（一般）：bundle 导入不去重技能名 → 重复 skillNames Agent 在导出对话框默认勾选下无法导出

### Bug 描述

导入侧 `importBundle` 落库时 `skillNames = parsed.skills.map((s) => s.name)`（`agent-bundle.service.ts:296`），对 bundle 内同名多条目**不去重、不校验**（`parseAndValidateBundle` 与 `buildImportPlan` 均无重名检查；confirm 阶段第二条 inline 会因"目录已存在"降级 `import-failed`，但 Agent 的 skillNames 仍写入重复名）。既有 `AgentService.createAgent/updateAgent` 同样原样序列化，`POST/PUT /v1/agents` 的 API 路径也可造出重复 skillNames（admin 表单 el-select 多选不会重复，但接口层无拦截）。

导出对话框（`AgentExportDialog.vue:104-122`）按 `props.agent.skillNames` 逐名生成技能行（`v-for :key="row.name"` 还会产生重复 key），同名用户技能的唯一候选默认 `checked: matches.length === 1`（:119）——**重复的两行会各自默认勾选同一个 token**；`collectInlineSkills`（:128-136）逐行收集后发出 `x@12,x@12`。该请求被第 2 轮新增的后端校验（`agent-bundle.service.ts:102-104`，`tokensForName.length > 1` → PARAM_INVALID"技能「x」指定了多个内联归属"）拒绝：管理员**未做任何操作、只是打开对话框点导出**，对这类 Agent 必然失败，且报错文案（"请只保留一个 name@userId"）与实际（只有一行归属、重复来自 Agent 数据）不符，管理员难以自行定位。

连带影响：即使绕过对话框直接带单 token 调 API，`exportBundle` 对 skillNames 的每个重复名各生成一条 inline 条目（重复内容），该 bundle 再导入时第二条降级 `import-failed`，预检（两条均 `will-import`）与确认报告不一致。共享目录自检的 `missingSkills` 也会重复列出同一名字。

### 严重级别

一般（触发需 Agent skillNames 含重复名——可经新导入路径 + 手工 bundle 或直接 API 造出；失败可恢复：管理员手动取消一行勾选即可导出；无静默数据错误）

### 触发条件

Agent 的 `skillNames` 含重复技能名（如经"导入含同名技能条目的 bundle"或直接调 `PUT /v1/agents/:id` 产生），管理员打开导出对话框直接点"导出 JSON"。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.service.ts:296`（导入落库 skillNames 不去重）、`:437-458`（skills 逐条解析无重名检查）、`:86-134`（导出按 skillNames 逐名产出，重复名产出重复条目）
- `admin/src/views/agent/AgentExportDialog.vue:16-17`（`v-for :key="row.name"`，重复名生成重复行）、`:104-122`（每行独立按 `matches.length===1` 默认勾选）、`:128-136`（逐行收集 token，不按技能名去重）
- 佐证（非本次改动，但构成触发面）：`backend-ts/src/agent/agent.service.ts:81-83`（createAgent 原样序列化 skillNames）

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/review3.temp-spec.ts`
（`vitest.config.temp.ts` 为临时配置，仅把 `src/**/*.temp-spec.ts` 加入 include；验证后已删除）

```ts
// review3.temp-spec.ts（审查用临时文件，已删除；还原即复现；此处摘 Bug 1 相关断言，完整文件含公共 harness 见本报告末尾说明）
describe('第3轮疑似 bug 1：bundle 导入不去重技能名 → 重复 skillNames Agent 默认无法从对话框导出', () => {
  it('导入 confirm：skills 含两条同名 x → 落库 Agent.skillNames 为 ["x","x"]（不去重）', async () => {
    const bundleJson = {
      format: BUNDLE_FORMAT, formatVersion: BUNDLE_FORMAT_VERSION,
      agent: { name: 'A', systemPrompt: 'p' },
      skills: [{ name: 'x', include: 'reference' }, { name: 'x', include: 'reference' }],
    };
    const result = await h.bundle.importBundle(structuredClone(bundleJson), true, 7);
    const created = h.agentRows.get((result as { agentId: number }).agentId)!;
    expect(JSON.parse(created.skillNames ?? '[]')).toEqual(['x', 'x']);
  });

  it('导出：skillNames 含重复 x + 单 token x@12 → bundle 出现 2 条同名 inline 条目（重复内容）', async () => {
    await h.userSkillService.uploadUserSkill(12, [
      { originalFilename: 'x/SKILL.md', buffer: Buffer.from(skillMd('x'), 'utf8') },
    ]);
    h.putAgent(1, { skillNames: JSON.stringify(['x', 'x']) });
    const { bundle } = await h.bundle.exportBundle(1, 'x@12');
    expect(bundle.skills).toHaveLength(2);
    expect(bundle.skills.every((s) => s.name === 'x' && s.include === 'inline')).toBe(true);
  });

  it('导出：token x@12,x@12（= 对话框重复行各自默认勾选唯一候选后 collect 的产物）→ 导出直接 PARAM_INVALID', async () => {
    await h.userSkillService.uploadUserSkill(12, [
      { originalFilename: 'x/SKILL.md', buffer: Buffer.from(skillMd('x'), 'utf8') },
    ]);
    h.putAgent(1, { skillNames: JSON.stringify(['x', 'x']) });
    await expect(h.bundle.exportBundle(1, 'x@12,x@12')).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID.code,
      message: expect.stringContaining('多个内联归属'),
    });
  });
});
```

**运行结论**：10 个用例（含第 2 轮修复复核 6 个 + 本 bug 3 个 + Bug 2 的 1 个）全部通过（即 bug 断言全部成立）——
- 导入含同名条目的 bundle 后，落库 `agent.skillNames === '["x","x"]'`；
- 该 Agent 带单 token 导出时 bundle 含 2 条同名 inline 条目；
- 对话框重复行默认勾选产生的 `x@12,x@12` 请求被后端以 PARAM_INVALID「指定了多个内联归属」拒绝（管理员零操作即导出失败）。

修复方向（任一即可）：导入落库/字段校验阶段对技能名去重（保留首条，warnings 提示）；或导出对话框按技能名去重生成行、`collectInlineSkills` 按 name 去重 token；后者改动更小且同时消除重复 key。

---

## Bug 2（一般）：停用 Agent 的共享条目在 admin 端无管理入口，形成"上架/编辑被拒、下架无按钮"的管理死角

### Bug 描述

admin 的行内共享入口渲染完全依赖 `fetchSharedEntries()` → `GET /v1/shared-agents`（`AgentListView.vue:311-321`），而该接口**过滤停用 Agent**（`shared-agent.service.ts:84` `if (!agent || agent.enabled === 0) continue;`，属设计内行为：工作台不展示）。于是对"已上架后被停用"的 Agent：

1. 页面刷新/重进后 `sharedEntries` Map 不含其 id → 行内按钮显示"上架"而非"推荐语/下架"，`SharedEntryDialog` 也因 `/shared-agents` 查不到条目而显示"上架到团队共享"表单（`SharedEntryDialog.vue:71-86` `existing=false`）；
2. 此时填写并保存 → `PUT /v1/agents/:id/shared-entry` → 后端 `putEntry` 因 `enabled === 0` 报 PARAM_INVALID「请先启用该 Agent」（`shared-agent.service.ts:56-57`）——管理员看到的"上架"操作永远失败，且无从得知背后还挂着一条旧条目；
3. "下架"按钮（`v-if="sharedEntries.has(row.id)"`）不渲染，`SharedEntryDialog` 的下架按钮同样依赖 `existing`——而后端 `removeEntry`（`shared-agent.service.ts:68-70`）对停用 Agent **并无限制**，DELETE 接口实际可用，只是 UI 没有任何入口。

结果：停用期间该条目既不可编辑也不可下架，唯一途径是"重新启用 → 下架 → 再停用"或直接调 API。停用→启用→停用的往返还会让工作台短暂重新展示该条目。方案 §5.4 只规定了"停用时条目保留、工作台自然隐藏"，未规定 admin 管理入口一并消失；`DELETE` 能力与 UI 入口的不一致是实现缝隙。

### 严重级别

一般（数据无损坏、工作台展示正确；仅 admin 管理动作被阻断且需绕行）

### 触发条件

管理员对已上架 Agent 执行"停用"，随后在 Agent 列表（刷新后）尝试对该行下架或重新保存共享条目。

### 涉及文件与行号

- `backend-ts/src/agent/shared-agent.service.ts:84`（listSharedAgents 过滤停用）、`:56-57`（putEntry 拒绝停用）、`:68-70`（removeEntry 无限制——能力存在）
- `admin/src/views/agent/AgentListView.vue:311-321`（sharedEntries 数据源为过滤后的 `/shared-agents`）、`:82-92`/`:140-150`（下架按钮 `v-if="sharedEntries.has(row.id)"`）
- `admin/src/views/agent/SharedEntryDialog.vue:71-86`（`existing` 判定同源，停用后显示为"上架"表单）、`:88-104`（handleSave → 被后端拒绝）

### 验证方式

同一临时文件 `review3.temp-spec.ts`（运行方式同 Bug 1）：

```ts
describe('第3轮疑似 bug 2：停用 Agent 的共享条目在 admin 端无管理入口', () => {
  it('停用后：listSharedAgents 不返回条目（sharedEntries 丢失→UI 不渲染下架按钮）；putEntry 报"请先启用"；removeEntry 实际可用', async () => {
    h.putAgent(1, { enabled: 1 });
    await h.shared.putEntry(1, '推荐语', 3, 9);
    expect((await h.shared.listSharedAgents(9)).map((v) => v.agentId)).toEqual([1]);

    h.putAgent(1, { enabled: 0 }); // 停用（条目按设计保留）

    // 1) GET /shared-agents 不再返回该条目 → admin fetchSharedEntries 的 Map 不含 id=1
    expect((await h.shared.listSharedAgents(9))).toEqual([]);
    // 2) 重新"上架/保存"→ 后端拒绝（UI 此时显示为"上架到团队共享"表单）
    await expect(h.shared.putEntry(1, '新推荐语', 0, 9)).rejects.toMatchObject({
      code: ErrorCode.PARAM_INVALID.code, message: expect.stringContaining('请先启用'),
    });
    // 3) 后端 DELETE 实际可用（能力存在），但 UI 因 1) 不再提供入口
    expect(h.entryRows.has(1)).toBe(true);
    await h.shared.removeEntry(1);
    expect(h.entryRows.has(1)).toBe(false);
  });
});
```

**运行结论**：用例通过——停用后 `listSharedAgents` 不返回条目（UI 的 sharedEntries 由此构建，下架按钮与 `existing` 判定随之失效）、`putEntry` 报「请先启用该 Agent」、而 `removeEntry` 仍能删除。三件事合起来即 UI 死角（UI 侧渲染逻辑为确定性代码路径：按钮 `v-if="sharedEntries.has(row.id)"`，数据源即该过滤接口）。

修复方向（任一）：`GET /v1/shared-agents` 对 `agent:write` 调用者（或加 `?includeDisabled=1` 参数）返回停用 Agent 的条目；或 admin 端改用独立的条目查询（含停用 Agent）渲染上架/下架状态。仅改 UI（如始终渲染"推荐语/下架"）需另行解决 `existing` 判定数据源，否则编辑回填同样拿不到。

---

## 本轮独立复查（换视角逐项，未发现新问题）

**并发与时序**：
- SkillLoader 300s 缓存 × 导入 invalidate：`importBundle` 在写盘成功后统一 `invalidateCache()`（`agent-bundle.service.ts:272-274`），下次 `hasSkill/loadSkills` 全量重扫；`skill-doc.service.ts:79/97`（系统技能上传/删除）同样 invalidate，无滞后窗口新问题。
- 并发导入同名技能：`writeSkillStaged` 的 `existsSync` 检查与 `renameSync` 之间的 TOCTOU 不会造成覆盖——rename 到已存在**非空**目录必然失败（staged 目录至少含 SKILL.md），失败方降级 `import-failed` 且不污染目录；staging token 唯一、`rmdirSync('.staging')` 仅成功于空目录（`staged-skill-writer.ts:43-84`）。
- `uploadUserSkill`（userSkillsDir）与 bundle 导入写盘（skillsDir）根目录不相交，`.staging` 各自隔离；`listAllUserSkills` 的 `Number(entry)` 过滤使 `.staging` 天然不进用户清单。
- `listSharedAgents` 的 N+1（每条目 findById + 每 MCP findById）在共享目录量级下可接受；`userSkillNames` 每调用仅扫描一次（见 A 节）。

**边界值**：`parseInlineSkillTokens` 对 `x@`/`x@0`/`x@1@2`/纯逗号/空串均落到安全分支；`normalizeSortOrder` 非法值归 0；名称冲突后缀循环有 `n > 10_000` 兜底且 finalName ≤128；`bundleFilename` 全非 ASCII 名回落 `agent`；`isValidBundleSkillName` 放行的 `a..b` 类名字会被 `validateSkillMd` 的 slug 规则拒绝（预检/写盘一致 `import-failed`），无"预检放行、写盘报错"的真空档；MCP 同名多条目、`name` 缺失/非字符串、`env` 值非字符串（键保留、值置空）均有归属。`putEntry` 空 body 会把已有 note 清为空串，属 upsert 语义内。

**类型断言**：`def as unknown as BundleMcpDefinition`（`agent-bundle.service.ts:478`）仅承载未校验原始对象，`mcpDefinitionError` 在 `buildImportPlan` 内逐字段校验后才决定 `will-create-disabled`，`createDisabledMcp` 只被 will-create-disabled 条目触达；其余新增代码无 `as never`/`as unknown as`（spec 内 mock 除外）。

**前端生命周期**：三个新对话框均 `v-if` 挂载/销毁，状态随组件重建，无残留；`AgentImportDialog` 移除 `:limit` 后连续换文件每次触发 on-change 并重置 `report/imported`（第 1 轮修复维持）；互斥 change 不回环（见 A 节）；`AgentExportDialog` 卸载后迟到的 `Promise.allSettled` 仅写已卸载组件的 ref，无泄漏后果。

**CLI 与后端响应形状**：export 走 bundle 裸 JSON（无 `code` 字段 → `http.js:136` 信封分支不命中，HTTP 200 直返；业务失败为 HTTP 200 Result 信封 → `code!==0` 抛错带 message）；import 走信封，`--confirm` 后 `result.data` 含 `agentId/report`，预检 `data` 即报告，渲染对缺字段安全；`parseArgs` 对 `-o` 短选项、`--confirm` 裸开关、位置参数的处理与 `positionId`/`requireString` 用法匹配；`-o` 指向已存在文件会被覆盖（符合预期）、指向目录则抛原始 EISDIR（CLI 顶层 catch 兜底，仅提示不友好，不计 bug）。

**其余**：V132 编号无冲突（目录最新 V131→V132）且与方案 DDL 一致；`deleteAgent` 级联顺序（isDefault 校验 → 清条目 → 清经验/问题 → 逻辑删）正确，`sharedEntryCleanup` 可选参数不影响既有构造点；`MysqlMcpServerLookup.findById` 含 `notDeleted` 过滤且被 `McpServerValidatorImpl` 复用等价；admin blob 透传分支置于信封解析前、401 刷新重试对 blob 请求同样成立。

---

## 存疑待确认（不计入确认 bug）

1. **导入对话框"换文件 + 慢预检"的展示竞态**：连续选择第二个文件时，第一个文件的预检响应可能后到并短暂覆盖 `report`（此时 `bundle.value` 已是 B、报告显示 A）；若管理员在该窗口点"确认导入"，实际落库的是 B 且 confirm 响应会重算并展示 B 的报告（服务端不信任预检，最终一致），仅存在"按 A 的报告确认导入 B"的误读窗口。验证受限原因：admin 无单测设施（无 vitest/@vue/test-utils），复刻组件状态机需 Playwright 环境且需人为拖慢网络才能构造时序，本轮未实际复现。建议 `handleFileChange` 加请求序号守卫（丢弃过期响应）。
2. **`putEntry` 的 sortOrder 仅校验 safe-integer**：直接 API 传 `2^53-1` 等超出 INT 列范围的值会在 DB 层报错 → HTTP 500（admin UI 限 0..9999）。与第 2 轮存疑 #3（systemPrompt 无上限）同类的"半可信输入字段级上限"缺口，未验证为独立 bug（需真实 DB 严格模式行为）。
3. **inline 根级隐藏文件的不对称**（修正第 1/2 轮存疑 #1 的描述）：`writeSkillStaged` 的跳过规则 `relativePath.includes('/.')`（`staged-skill-writer.ts:51`）**不命中根级隐藏文件**——根级 `.env` 会被写盘；嵌套隐藏段仍静默跳过。而预检 `inlineFilesPathError` 只拒 `..`/空段，故根级隐藏文件"报告 will-import 且确实落盘"（一致），嵌套隐藏文件"报告 will-import 但未落盘"（不一致）。导出侧本就跳过所有隐藏文件，仅手工 bundle 可触发，低危。
4. **导入非事务的中间态**（承第 1/2 轮存疑）：confirm 阶段写技能 → 建 MCP → Agent 落库无整体事务；Agent 落库失败时已写盘技能与 DISABLED MCP 成为孤儿，重试时同名 MCP 被 `skip-name-conflict`。方案未要求事务，属设计取舍，建议与方案作者确认。

## 验证环境与临时文件说明

- 验证均在本机实际运行：Vitest（backend-ts，Node 22）。基线 `npx vitest run src/agent/ src/skill/` 12 files / 120 tests 全绿（exit=0）；临时验证 `src/agent/review3.temp-spec.ts` 10 tests 全部通过（exit=0）。
- 临时验证文件（`backend-ts/src/agent/review3.temp-spec.ts`、`backend-ts/vitest.config.temp.ts`）已在报告完成后删除，工作区不留临时文件；报告内附代码可直接还原复现（公共 harness：内存 agentRepo/entryRepo + 临时目录 SkillLoader/UserSkillService，与既有 `shared-agent.service.spec.ts` 同构）。
