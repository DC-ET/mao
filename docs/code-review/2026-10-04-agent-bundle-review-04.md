# 代码审查报告（第 4 轮）：Agent 资产化（Bundle 导出/导入 + 团队共享目录 + mao-cli）

- 日期：2026-10-04
- 审查对象：第 3 轮报告（`docs/code-review/2026-10-04-agent-bundle-review-03.md`）修复后的未提交代码，范围仅限任务指定的 backend-ts / admin / desktop / mao-cli 改动文件（desktop/api、TopNav、MemoryView、SettingsView、memory.md、tests/desktop.spec.ts 等用户其它未提交工作不在范围内）
- 基线：`cd backend-ts && npm test` 全绿（Test Files 240 passed | 1 skipped，Tests 2669 passed | 13 skipped，exit=0）；`cd admin && npm run build`（vue-tsc）通过
- 结论：**第 3 轮 2 个 bug 修复与 3 项存疑修复全部正确落地、未引入回归**；本轮新确认 bug **1 个（重大 0、一般 1）**，存疑待确认 4 项。确认 bug 以可运行 Vitest 用例实际复现（临时验证文件已于报告完成后删除，验证代码全文附于本报告内）。

## 摘要

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| 1 | 一般 | 同一用户拥有两个目录、SKILL.md frontmatter 名相同（标准上传路径即可造出）时，显式归属导出静默取 readdir 首个目录，另一目录内容经任何合法请求都不可达且无提示；未带归属的报错文案候选重复「x@12、x@12」不可区分；admin 导出对话框为该场景渲染两个 token/文案完全相同的复选框（勾哪个结果都一样） | Vitest 复现（3/3 通过） |

---

## A. 第 3 轮修复复核结论

### 修复 1：技能名去重（导入侧 `seenSkillNames` + warnings；导出侧 `emittedSkillNames`；admin AgentExportDialog 按名去重行）

**✅ 正确，未引入新问题。** 逐项核实：

| 关注点 | 结论 | 依据 |
|---|---|---|
| 「同名不同 include」条目的去重语义 | ✅ 保留首条、warning 提示、预检与 confirm 一致 | `agent-bundle.service.ts:448-453`（parse 阶段去重，两条均先于 include 处理）；本轮用例「首条 inline + 次条 reference」与反序两条均通过：首条决定 include，次条进 warnings（`技能「x」重复条目已忽略`），预检与 confirm 报告、落库 skillNames、写盘结果完全一致。反序场景 inline 的 files 随次条被丢弃，仅按 reference 语义处理（missing/ok），不产生半写盘状态 |
| 去重后 skillNames 无重复 | ✅ | `agent-bundle.service.ts:300` `parsed.skills.map(s => s.name)`，parsed.skills 已去重；本轮用例断言落库 `['x']` |
| 导出侧去重与单 token 交互 | ✅ | `agent-bundle.service.ts:88-90`（`emittedSkillNames`）+ 第 3 轮 spec「历史重复 skillNames 导出时去重」；本轮用例重复 skillNames + 单 token 仅产出 1 条 inline 条目 |
| 去重 warning 在预检与 confirm 报告中均出现 | ✅ | `buildImportPlan:508` `warnings = [...parsed.warnings]`，两段各自重新 parse，口径相同 |
| admin 对话框去重行 | ✅ | `AgentExportDialog.vue:104-111`（`seen` Set 过滤重复名，`v-for :key="row.name"` 不再有重复 key） |

### 修复 2：停用 Agent 共享条目管理死角（SharedEntryDialog `enabled` 属性 + 始终提供下架按钮 + 提示 alert）

**✅ 正确，未引入新问题。** 逐项核实：

| 关注点 | 结论 | 依据 |
|---|---|---|
| enabled 传参类型 | ✅ | `agent.routes.ts:241` VO 返回布尔（`enabled: agent.enabled !== 0`）；`AgentListView.vue:308` `enabled: row.enabled !== false` 得到布尔，`SharedEntryDialog.vue` 的 `agent.enabled === false` 严格比较成立（不存在 0/1 vs boolean 的错位） |
| 停用后下架入口可达 | ✅ | 停用 Agent 不在 `GET /v1/shared-agents`（`shared-agent.service.ts:92` 过滤）→ `existing=false`，但下架按钮条件 `v-if="existing || agent.enabled === false"`（`SharedEntryDialog.vue:38`）覆盖停用态；`removeEntry` 对停用/不存在的条目均幂等成功（`shared-agent.service.ts:76-78`，spec「下架幂等」覆盖） |
| 停用态保存被双保险阻止 | ✅ | 前端 `:disabled="agent.enabled === false"` + tooltip「请先启用该 Agent」（`:46-59`）；后端 `putEntry` 仍报 PARAM_INVALID「请先启用该 Agent」（`shared-agent.service.ts:56-57`，spec 覆盖），前端仅少一道提示而非绕过校验 |
| 对未上架条目的幂等交互 | ✅ 可接受 | 停用且从未上架的 Agent 打开对话框也有下架按钮，点击 DELETE 空条目静默成功并提示「已下架」——语义无害（幂等），不构成功能错误 |
| 已知显示局限（非 bug） | — | 停用 Agent 的对话框因 `/shared-agents` 过滤而 `existing=false`：标题显示「上架到团队共享」、已存推荐语不回填（空表单）。alert（`:28-34`）已解释停用态语义，编辑本就被禁止，仅"查看已存推荐语"不可达，管理员可启用后查看。属第 3 轮修复方案的既定取舍，不计 bug |
| 行内按钮与对话框状态自愈 | ✅ | 停用→启用后 `sharedEntries` Map 未刷新（`handleToggleEnabled` 只调 `fetchAgents`），行内按钮暂显示「上架」，但点击打开对话框时 `onMounted` 重新拉取 `/shared-agents` → `existing=true`、推荐语回填、保存文案正确（「推荐语已更新」）。仅按钮文案陈旧，无错误动作可达 |

### 修复 3（存疑修复）：AgentImportDialog 预检序号守卫、putEntry sortOrder INT 边界、隐藏路径段口径统一

**✅ 全部正确。**

- **预检序号守卫**：`AgentImportDialog.vue:126`（`precheckSeq`）、`:142-152`（`seq !== precheckSeq` 丢弃过期响应，`committing` 同步守卫）。「确认导入」期间 `committing=true`，`handleConfirm` 入口 `if (bundle.value == null || committing.value) return` 阻断并发 confirm；confirm 在途时选择新文件的残余竞态见存疑 #1（未验证为确认 bug）。
- **sortOrder INT 边界**：`shared-agent.service.ts:64-71`（`Math.abs(n) > 2147483647` → PARAM_INVALID），spec「排序值超出 INT 范围或非整数报 PARAM_INVALID（不落库不 500）」覆盖。
- **隐藏路径段口径**：parse 阶段 `isHiddenRelativePath`（`agent-bundle.service.ts:644-648`，根级 `.file` 与 `目录/.file` 一并丢弃）与 `writeSkillStaged:51` 的跳过规则逐字一致；本轮用例验证「inline 文件全部为隐藏路径段（无 SKILL.md 幸存）」时预检与 confirm 均报 `import-failed`（缺 SKILL.md）且不写盘——预检报告与实际行为一致，第 1/2/3 轮存疑 #1/#3 就此关闭。附带核对：`''` 空路径被 `inlineFilesPathError` 拒绝（import-failed）、`..`/空段两处同拒、反斜杠路径两处同归一，无"预检放行、写盘报错/跳过"的真空档。

---

## Bug 1（一般）：同一用户同名多目录时，显式归属导出静默取首个目录，归属选择不可表达

### Bug 描述

第 2 轮修复确立了"同名用户技能只能指定一个内联归属"的口径：后端对多个 token 报 PARAM_INVALID，前端候选互斥。但该口径隐含"（userId, frontmatter 名）唯一确定一个技能目录"的假设——这个假设不成立：`UserSkillService.uploadUserSkill` 按压缩包内**目录名**分组写盘，`validateSkillGroup` → `validateSkillMd` 只校验 frontmatter 合法性、**不比对 frontmatter 名与目录名**（`user-skill.service.ts:232-238`、`skill-md.ts:46-75`），也不做跨目录 frontmatter 名查重。因此一个用户通过两次标准上传（或一个包含 `alpha/`、`beta/` 两个目录的 zip）即可拥有两个目录、SKILL.md frontmatter 名相同（如均为 `shared`）但内容不同。

此时导出链路（`agent-bundle.service.ts:103-126`）：

1. **显式归属**：`candidates.find((c) => c.userId === explicit.userId)` 对同用户的两个候选返回**第一个命中**（`listAllUserSkills` 排序键 `(userId, name)` 对二者相等，保持 readdir 顺序）——导出哪个目录由文件系统目录顺序决定，**另一目录的内容经任何合法请求都不可达**（token 只有 `shared@12` 一种），不报错、无 warnings、无任何歧义提示。管理员以为选择了归属，实际拿到的内容取决于 readdir 顺序；
2. **未带归属**：`candidates.length > 1` 报 PARAM_INVALID，但候选文案 `${name}@${c.userId}` 拼出 **「shared@12、shared@12」**——两个"不同"候选字面完全相同，管理员无法据此决策（本轮用例 3 复现该文案）；
3. **admin 导出对话框**（`AgentExportDialog.vue:116-129`）：`matches.length === 2` → 渲染两个 `token` 与 `ownerLabel` 完全相同的复选框「内联（用户12）」，互斥逻辑（`onCandidateChange`）对它们无意义——勾选任何一个发出的请求完全相同，UI 呈现的"二选一"是虚假选择。

与第 1 轮 Bug 1（目录名 ≠ frontmatter 名导致读错目录/误报失败）和第 2 轮 Bug 2（多归属 token 静默取第一个）同族，是两轮修复后仍遗留的第三个变体：**同名候选同属一个用户**。正常单目录数据不触发。

### 严重级别

一般（导出不失败、导出的也是合法的同名技能内容之一；但归属选择结果与目录事实可能不符且无任何提示，触发需"同用户同名双目录"数据——该数据可经标准上传路径无告警产生）

### 触发条件

某用户拥有两个目录、SKILL.md frontmatter 名相同（如 zip 内含 `alpha/SKILL.md` 与 `beta/SKILL.md` 且 frontmatter 均为 `name: shared`，或分两次上传），管理员导出绑定该技能的 Agent 并勾选该用户的内联归属（或经 CLI 传 `inlineSkills=shared@12`）。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.service.ts:103`（candidates 过滤）、`:109-116`（`candidates.find((c) => c.userId === explicit.userId)` 仅按 userId 判定，同用户多目录静默取首个）、`:121-124`（无归属报错文案按 `name@userId` 拼接，同用户多候选重复）
- `admin/src/views/agent/AgentExportDialog.vue:116-129`（`matches.map` 生成 token/ownerLabel 完全相同的多个候选复选框）
- 佐证（非本次改动，但构成触发面）：`backend-ts/src/skill/user-skill.service.ts:215-238`（按目录名分组、不校验 frontmatter 名跨目录唯一）

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/review4.temp-spec.ts`
（`vitest.config.temp.ts` 为临时配置，仅把 `src/**/*.temp-spec.ts` 加入 include；验证后已删除）

```ts
// review4.temp-spec.ts（审查用临时文件，已删除；还原即复现；harness 与既有 agent-bundle.service.spec.ts 同构：内存 agentRepo + 临时目录 SkillLoader/UserSkillService）
describe('review4 疑点 1：同一用户两个目录同名（frontmatter 名相同）的导出归属', () => {
  it('标准上传路径可造出：同用户两个目录（alpha/beta）frontmatter 名均为 shared', async () => {
    const r1 = f.userSkillService.uploadUserSkill(12, [
      { originalFilename: 'alpha/SKILL.md', buffer: Buffer.from(skillMd('shared', 'alpha 版本的内容'), 'utf8') },
    ]);
    const r2 = f.userSkillService.uploadUserSkill(12, [
      { originalFilename: 'beta/SKILL.md', buffer: Buffer.from(skillMd('shared', 'beta 版本的内容'), 'utf8') },
    ]);
    expect(r1.code).toBe(0);
    expect(r2.code).toBe(0);
    expect(readdirSync(join(f.root, 'userskills', '12')).sort()).toEqual(['alpha', 'beta']);
    expect(f.userSkillService.listAllUserSkills().filter((s) => s.name === 'shared' && s.userId === 12)).toHaveLength(2);
  });

  it('显式归属 shared@12：静默导出其中一个目录，且无论如何请求都无法导出另一个（无提示）', async () => {
    // 上传 alpha/beta（同上）… agent.skillNames = ['shared']
    const { bundle } = await f.service.exportBundle(1, 'shared@12');
    expect(bundle.skills).toHaveLength(1);
    const md = bundle.skills[0].files?.['SKILL.md'] ?? '';
    const isAlpha = md.includes('alpha 版本的内容');
    const isBeta = md.includes('beta 版本的内容');
    expect(isAlpha || isBeta).toBe(true);   // 导出的是两者之一（readdir 顺序决定）
    expect(isAlpha && isBeta).toBe(false);
    expect(bundle.skills[0].warnings ?? []).toHaveLength(0); // 无任何歧义提示
    const again = await f.service.exportBundle(1, 'shared@12');
    expect(again.bundle.skills[0].files?.['SKILL.md']).toBe(md); // 唯一可表达的请求重复调用结果不变
    // 另一目录内容在合法请求空间内不可达（token 只有 shared@12 一种）
  });

  it('inline token 未带归属（inlineSkills=shared）：报 PARAM_INVALID，但候选文案为「shared@12、shared@12」重复不可区分', async () => {
    // 上传 alpha/beta（同上）… agent.skillNames = ['shared']
    await expect(f.service.exportBundle(1, 'shared')).rejects.toMatchObject({
      message: expect.stringContaining('shared@12、shared@12'),
    });
  });
});
```

**运行结论**：3 个用例全部通过（bug 断言全部成立）——

- 同用户 `alpha`/`beta` 两目录 frontmatter 名均为 `shared`，标准上传均成功（`code=0`），`listAllUserSkills` 返回 2 条同名候选；
- `exportBundle(1, 'shared@12')` 静默导出 readdir 首个目录 `alpha` 的内容，`warnings` 为空；唯一可表达的请求重复调用结果不变，`beta` 的内容在合法请求空间内不可达；
- `inlineSkills=shared`（未带归属）报 PARAM_INVALID，文案含「shared@12、shared@12」——候选列表自身重复，无法区分。

admin 侧两个相同复选框为确定性代码路径（`AgentExportDialog.vue:124-129` 对两条 matches 各生成 `token: 'shared@12'`、相同 `ownerLabel` 的候选），勾选任何一个发出的请求相同，与后端行为互相印证。

修复方向（任一）：后端在 `explicit` 命中后校验 `candidates.filter(c => c.userId === explicit.userId).length === 1`，否则 PARAM_INVALID 并在文案中区分目录（候选展示需携带目录路径）；或无归属多候选的报错文案与导出对话框候选展示引入目录路径维度，使归属可表达。admin 对话框至少应避免渲染 token 完全相同的重复复选框。

---

## 本轮独立复查（换视角逐项，未发现新问题）

**数据一致性（预检 vs confirm、bundle vs 落库）**：
- confirm 完整重算 `parseAndValidateBundle` + `buildImportPlan`（`agent-bundle.service.ts:249-251`），预检报告不参与落库决策；`exists-skip`/`will-import→ok/import-failed`/`will-create-disabled→创建或 skip-name-conflict` 的差异均为 confirm 阶段的防御性降级，confirm 报告本身如实。
- 技能名去重后 `skillNames = parsed.skills.map(s => s.name)` 与 bundle 条目一一对应（本轮用例断言）；`experiencesCount`/`suggestedQuestionsCount` 与实际 sync 条数一致（超限经验的跳过在 parse 阶段完成，计数为过滤后条数）。
- inline frontmatter 名一致性在预检（`:547-552`）与写盘（`staged-skill-writer.ts:36-40`）双重校验，文案一致。
- MCP：`createdNames` 防御 bundle 内同名；`createDisabledMcp` 直写字段（userId=0/DISABLED/env 键保留值置空加密）与 mapper.insert 吻合；bodyLimit 全局 52MB（`create-app.ts:405`），10MB inline bundle 不会触发 413。
- 导出：`emittedSkillNames` 去重 + 多 token PARAM_INVALID + 系统技能拒内联的组合无冲突；`inlineBytesTotal` 跨技能累计检查位置正确（先读后判，见存疑 #2）。

**资源与 IO**：
- `writeSkillStaged` 暂存目录 finally 清理 + `.staging` 父目录仅空时 rmdir；`.staging/<token>/<name>` 布局不会被 `SkillLoader.refreshCache` 误扫（顶层无 SKILL.md，`skill-loader.ts:86-87`）。进程崩溃残留的 `.staging` 不影响技能清单（仅占磁盘）。
- `readUserSkillFiles` 同步读取、无句柄泄漏；readdir 失败抛 PARAM_INVALID、单文件 stat 失败跳过、非 UTF-8 文件跳过并 warnings——与 bundle `warnings` 字段契约一致（导入端不消费该字段属预期：文件本就未入包）。
- 导出读盘内存峰值见存疑 #2（有上传通道大小上限兜底，非功能错误）。

**兼容性（admin/desktop）**：
- admin blob 透传分支置于信封解析之前（`admin/src/api/index.ts:63-65`），401 刷新重试对 blob 请求同样成立（错误分支读 `error.response`，`skipErrorToast` 只影响非 401 提示）；导出失败（HTTP 200 Result 信封 blob）经 `!content-disposition` 分支解析 message 提示。
- `AgentListView`：`fetchSharedEntries` 失败降级空 Map（行内按钮回落"上架"，对话框 onMounted 二次拉取自愈）；`handleToggleEnabled`/`handleDelete` 后 Map 短暂陈旧但无错误动作可达（见 A 节修复 2）；分页/筛选逻辑未受影响；`canWrite=false` 用户不拉取共享条目、不渲染新按钮。
- desktop：`fetchAgents` 用 `Promise.allSettled`，主列表失败置 error、共享分区失败置空不阻塞；未登录早退同时清空两分区；`SharedAgent.agentId`(number) 经 `String()` 与 `Agent.id`(string) 对齐选中态；缺依赖共享 Agent 仍可选中（§5.5）；空态条件 `filteredAgents.length === 0 && sharedAgents.length === 0` 避免共享分区存在时误显"暂无可用智能体"。
- admin/desktop `npm run build`（vue-tsc）通过。

**CLI 与真实响应**：
- export：bundle 裸 JSON 无 `code` 字段 → `http.js:136` 信封分支不命中原样返回，`format` 契约校验成立；业务失败（AGENT_NOT_FOUND/PARAM_INVALID）为 HTTP 200 Result 信封 → `code!==0` 抛错带 message；`-o` 短选项、`--inline-skills` 透传、默认文件名清洗与后端 `bundleFilename` 同规则。
- import：`--confirm` 裸开关/`=false` 均被 `optionalBoolean` 正确解析；预检 `data` 即报告、confirm `data` 含 `agentId/report`，`renderImportReport` 对缺字段安全（`?? {}`、`Array.isArray` 守卫）；positionId 对非正整数报错。

**其它**：V132 与方案 DDL 一致、`uk_shared_agent` 唯一键与 upsert 匹配；`deleteAgent` 级联先于逻辑删（`agent.service.ts:176`），`selectList(null, true)` 使名称冲突检测不误中已删/停用 Agent；`MysqlMcpServerLookup` 复用实例为等价重构；`validateSkillMd` 的 frontmatter 名 slug 规则与 `writeSkillStaged` 目录名强一致，导入路径无穿越面。

---

## 存疑待确认（不计入确认 bug）

1. **AgentImportDialog「确认导入与换文件」竞态**（第 3 轮存疑 #1 的残余面）：预检响应竞态已由 `precheckSeq` 守卫修复，但 `handleConfirm` 在途时选择新文件的交错未被守卫：confirm 完成回调置 `report=旧 bundle 的 confirm 报告、imported=true`，随后新文件预检完成覆盖 `report`——最终"确认导入"按钮被 `v-if="report && !imported"` 隐藏，管理员看到新文件的预检报告却无确认入口（或短暂看到旧 bundle 的 confirm 报告）。服务端不信任预检、最终一致，重选文件/重开对话框可恢复，无数据错误。未验证原因：admin 无单测设施（无 vitest/@vue/test-utils），复刻组件状态机的 Playwright 证据力弱（验证的是复刻而非真实组件），需人为控制两个请求的时序才能构造。建议 `handleFileChange` 对 `committing`（confirm 在途）直接拒绝或给 confirm 也加序号守卫。
2. **导出读盘内存峰值**：`readUserSkillFiles` 对技能目录内全部文件 `readFileSync` 全量进内存（Buffer + UTF-8 解码字符串双份）之后才累计检查 10MB 上限；含大文件的用户技能导出时瞬时内存可达文件体积的数倍。上传通道有 multipart 大小上限兜底（bodyLimit 按其推导），管理员触发、无持久化影响，属性能健壮性而非功能错误。可改为边读边累计、超限即断。
3. **bundle 内重复 MCP 名的预检与 confirm 报告不一致**（承第 1/2/3 轮存疑，维持）：预检对同名多条目均报 `will-create-disabled`，confirm 阶段第二个被 `createdNames` 降级 `skip-name-conflict`。confirm 报告本身正确（防御性降级如实展示），仅手工 bundle 可触发；技能名重复一侧已由第 3 轮去重修复消除（本轮用例验证预检/confirm 一致）。
4. **导入非事务的中间态 / systemPrompt 无长度上限**（承第 1/2/3 轮存疑，维持）：confirm 阶段写技能 → 建 MCP → Agent 落库无整体事务，Agent 落库失败留孤儿；`systemPrompt`/`configJson` 无长度上限，恶意 bundle 依赖 DB TEXT 列溢出报 500。方案未要求事务与该上限，现有 `POST /v1/agents` 同样无 systemPrompt 上限（存量口径），需与方案作者确认取舍。

### 前三轮存疑清单逐项再评估结论

| 前三轮存疑 | 本轮结论 |
|---|---|
| R1#1/R2#3 inline 隐藏文件"预检放行、写盘跳过" | **已解决**（第 3 轮统一口径；本轮用例验证全隐藏场景预检/confirm 一致 import-failed） |
| R1#3 readUserSkillFiles 无围栏 | **已解决**（第 2 轮改用 listAllUserSkills().folderPath，目录来自服务端自扫描） |
| R1#4/R2#4 bundle 内重名预检/confirm 不一致 | 技能名侧**已解决**；MCP 名侧维持存疑（本轮 #3） |
| R1#2/R3#4 导入非事务中间态 | 维持存疑（本轮 #4） |
| R2#1（第 2 轮存疑）systemPrompt 无上限 | 维持存疑（本轮 #4） |
| R3#1 导入对话框换文件竞态 | 预检侧**已解决**；confirm 交叉竞态为新残余（本轮 #1） |
| R3#2 putEntry sortOrder 超 INT | **已解决**（spec 覆盖） |
| R3#3 隐藏路径段根级/嵌套口径 | **已解决**（本轮用例验证） |

## 验证环境与临时文件说明

- 验证均在本机实际运行：Vitest（backend-ts，Node 22）。基线 `npm test` 240 files / 2669 tests 全绿（exit=0）；临时验证 `src/agent/review4.temp-spec.ts` 6 tests 全部通过（exit=0；含 round-3 修复交互复核 3 项）；admin `npm run build` 通过。
- 临时验证文件（`backend-ts/src/agent/review4.temp-spec.ts`、`backend-ts/vitest.config.temp.ts`）已在报告完成后删除，工作区不留临时文件；报告内附代码可直接还原复现。
