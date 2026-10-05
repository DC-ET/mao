# 代码审查报告（第 2 轮）：Agent 资产化（Bundle 导出/导入 + 团队共享目录 + mao-cli）

- 日期：2026-10-04
- 审查对象：第 1 轮报告（`docs/code-review/2026-10-04-agent-bundle-review-01.md`）修复后的未提交代码，范围仅限任务指定的 backend-ts / admin / desktop / mao-cli 改动文件
- 基线：`cd backend-ts && npx vitest run src/agent/ src/skill/` 全绿（Test Files 12 passed，Tests 118 passed）；`admin` 与 `desktop` `npm run build`（含 vue-tsc 类型检查）均通过
- 结论：**第 1 轮 4 个修复全部正确落地、未引入回归**；本轮新确认 bug **2 个（重大 0、一般 2）**，存疑待确认 4 项。两个确认 bug 均以可运行 Vitest 用例实际复现（临时验证文件已于报告完成后删除，验证代码全文附于本报告内）。

## 摘要

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| 1 | 一般 | 共享目录依赖自检 `userSkillDirExists` 按目录名口径，与运行时/导出/导入的 frontmatter 名口径并存：目录名 ≠ frontmatter 名的用户技能会"假缺失"（可用却报缺）或"假通过"（不可用却无角标），两个方向均已复现 | Vitest 复现（2/2 通过） |
| 2 | 一般 | 导出对话框对同名用户技能的多个归属候选用独立复选框，可同时勾选多个 `name@userId` token；后端 `inlineTokens.find` 只取第一个 token 的归属，其余被静默丢弃——导出结果由 token 排列顺序决定，无任何提示 | Vitest 复现（1/1 通过，含顺序反转对照） |

---

## A. 第 1 轮 4 个修复复核结论

| 修复 | 结论 | 依据 |
|---|---|---|
| 1. 导出 inline 用户技能改按 `listAllUserSkills().folderPath` 读盘 | ✅ 正确 | `agent-bundle.service.ts:80-97`（userSkillsCache 携带 folderPath，`readUserSkillFiles(ownerFolder, name)` 仅用 name 作报错文案）；`agent-bundle.service.spec.ts:256-285` 回归用例（Case A 不串技能、Case B 不误报失败）在基线中通过。folderPath 来自服务端自身目录扫描（`user-skill.service.ts:56` `resolve(entry)`），无路径穿越面，第 1 轮存疑 #3（readUserSkillFiles 无围栏）随之消解 |
| 2. 导入 inline 技能新增 frontmatter name == 条目名校验 | ✅ 正确，round-trip 无回归 | 双重防御：`agent-bundle.service.ts:528-534`（预检）+ `staged-skill-writer.ts:36-40`（写盘）。`agent-bundle.service.spec.ts:653-674` 断言 import-failed 不写盘；round-trip 用例（含 inline code-review + docs/guide.md）与导出侧用例在基线中全绿——正常导出→导入不受影响（导出条目名取自 frontmatter 名，天然满足一致性） |
| 3. `GET /v1/agents/:id/bundle` 重复 inlineSkills 参数 join 归一 | ✅ 正确 | `agent-bundle.routes.ts:23-25`（`Array.isArray ? join(',') : rawInline`）；`agent-bundle.routes.spec.ts:63-68` 断言 `?inlineSkills=a&inlineSkills=b%4012` 归一为 `'a,b@12'` 且 200，基线通过 |
| 4. admin AgentImportDialog 移除 `:limit="1"` | ✅ 正确 | `AgentImportDialog.vue:15-23` 已无 `:limit`/`:file-list`；`handleFileChange`（:126-147）每次选择重置 `report/imported` 后重新预检，支持同会话换文件重检。机制性证据见第 1 轮 Playwright 实验（无 limit 时连续 setInputFiles 每次 on-change 均触发） |

结论：4 个修复均未引入新问题。唯一遗留影响是修复 1 改用 frontmatter 名口径后，与共享目录自检的目录名口径形成并存（本轮 Bug 1，见下）。

---

## Bug 1（一般）：共享目录依赖自检"目录名口径"与全链路"frontmatter 名口径"并存 → 假缺失 / 假通过

### Bug 描述

第 1 轮修复后，bundle 导出（候选匹配、读盘）、导入（frontmatter == 条目名强制一致）、运行时会话技能挂载（`SkillSyncService.loadUserSkillDocs` 以 `result[doc.name]`（frontmatter 名）为键索引，`harness-service.ts:375-387` 据此合并挂载）全部统一在 **frontmatter 名**口径上。但共享目录自检 `SharedAgentService.userSkillDirExists`（`shared-agent.service.ts:106-118`）仍按**目录名**口径检查 `userSkillsDir/<userId>/<name>` 目录是否存在。

用户技能的目录名与 frontmatter 名不经任何强制一致（`UserSkillService.validateSkillGroup` → `validateSkillMd` 的 expectedName 仅用于报错文案，标准上传路径即可产生分歧）。分歧存在时，自检在两个方向都给出错误结论：

- **假缺失**：用户技能目录 `holder`、frontmatter `code-review`。运行时按 frontmatter 名可正常挂载（技能可用），但自检查目录 `code-review` 不存在 → 工作台角标报"缺少技能: code-review"。
- **假通过**：用户技能目录 `code-review`、frontmatter `other-skill`。Agent 引用 `code-review`（来自其它用户的技能清单），该用户运行时实际加载不到任何名为 `code-review` 的技能，但自检查目录 `code-review` 存在 → 不报缺失（无角标），能力静默降级。

两个方向都违反验收口径 §11.2"未安装依赖技能的用户看到缺失角标，安装后角标消失"的语义（角标与真实安装态不符）。说明：方案 §5.4 原文写的是 `userSkillsDir/<当前用户>/<name>` 目录口径，实现与方案字面一致；但方案行文时隐含"目录名 == 技能名"假设，第 1 轮修复确立 frontmatter 名为全链路身份标识后，该假设不再成立，应同口径收敛。

### 严重级别

一般（P2 自检展示错误，不阻断导出/导入/运行时；触发需目录名 ≠ frontmatter 名的现实数据）

### 触发条件

任一用户经 `/v1/user-skills/upload`（或桌面端技能上传）安装了目录名与 SKILL.md frontmatter 名不一致的技能，且该技能名出现在已上架 Agent 的 `skillNames` 中，该用户（或目录名恰好撞名的其它用户）打开工作台"团队共享"分区。

### 涉及文件与行号

- `backend-ts/src/agent/shared-agent.service.ts:94-104`（`computeMissingSkills`）、`:106-118`（`userSkillDirExists` 目录名口径，`:111` 拼目录、`:114` `statSync(dir).isDirectory()`）
- 对照口径（均已是 frontmatter 名）：`backend-ts/src/agent/agent-bundle.service.ts:96-99`（导出候选）、`:528-534`（导入一致性校验）、`backend-ts/src/harness/skill/skill-sync-service.ts:116-119`（运行时索引）、`backend-ts/src/harness/core/harness-service.ts:375-387`

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/shared-agent.dircaliber.temp-spec.ts`
（`vitest.config.temp.ts` 为临时配置，仅把 `src/**/*.temp-spec.ts` 加入 include；验证后已删除）

```ts
// shared-agent.dircaliber.temp-spec.ts（审查用临时文件，已删除；还原即复现）
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { SkillSyncService } from '../harness/skill/skill-sync-service.js';
import { SharedAgentService } from './shared-agent.service.js';
import { UserSkillService } from '../skill/user-skill.service.js';
import type { Agent } from './types.js';

function skillMd(name: string, description = '测试技能'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;
}

class MemoryEntryRepo { /* 同 shared-agent.service.spec.ts 的内存表，略 */ }

describe('TEMP 验证：共享目录自检 userSkillDirExists（目录名口径）与运行时/导出导入（frontmatter 名口径）并存', () => {
  // 初始化：skillsDir / userSkillsDir 临时目录、SkillLoader、UserSkillService、
  // SkillSyncService（loadUserSkillDocs 只依赖 userSkillsDir，与 harness-service.ts:375 同一实现）、
  // SharedAgentService（内存 entryRepo + agentRows + 空 mcpLookup）

  it('假缺失：技能目录名 holder / frontmatter 名 code-review —— 运行时可用，自检却报 missing', async () => {
    // 经标准上传路径制造「目录名 ≠ frontmatter 名」（上传侧不拦截）
    await userSkillService.uploadUserSkill(7, [
      { originalFilename: 'holder/SKILL.md', buffer: Buffer.from(skillMd('code-review'), 'utf8') },
    ]);
    putAgent(1, { skillNames: JSON.stringify(['code-review']) });
    await service.putEntry(1, 'note', 0, OPERATOR);

    // 运行时口径：该用户拥有 code-review，会话能挂载
    const runtimeDocs = skillSync.loadUserSkillDocs(7);
    expect(Object.keys(runtimeDocs)).toContain('code-review');

    // 共享目录自检（目录名口径）：却把 code-review 报成缺失
    const list = await service.listSharedAgents(7);
    expect(list[0].missingSkills).toContain('code-review');
  });

  it('假通过：目录名 code-review 里装的是别的技能（frontmatter other-skill）—— 自检通过，运行时却加载不到', async () => {
    await userSkillService.uploadUserSkill(7, [
      { originalFilename: 'code-review/SKILL.md', buffer: Buffer.from(skillMd('other-skill', '另一个技能'), 'utf8') },
    ]);
    putAgent(1, { skillNames: JSON.stringify(['code-review']) });
    await service.putEntry(1, 'note', 0, OPERATOR);

    // 运行时口径：该用户没有名为 code-review 的技能，会话挂载不到
    const runtimeDocs = skillSync.loadUserSkillDocs(7);
    expect(Object.keys(runtimeDocs)).not.toContain('code-review');

    // 共享目录自检（目录名口径）：目录存在 → 不报缺失（无角标）
    const list = await service.listSharedAgents(7);
    expect(list[0].missingSkills).not.toContain('code-review');
  });
});
```

**运行结论**：2 个用例全部通过（即两组矛盾断言全部成立）——
- 假缺失：`loadUserSkillDocs(7)` 明确含 `code-review`（运行时可用），`listSharedAgents(7).missingSkills` 却包含 `code-review`；
- 假通过：`loadUserSkillDocs(7)` 不含 `code-review`（运行时不可用），`missingSkills` 却不含 `code-review`（无角标）。

修复方向（二选一，建议前者）：自检改用 frontmatter 名口径（`UserSkillService.listUserSkills(userId).some(s => s.name === name)`，与运行时/导入同一实现语义）；或在技能上传时强制目录名 == frontmatter 名，从源头消灭分歧。

---

## Bug 2（一般）：导出对话框多归属候选可同时勾选，后端对同一技能的多个 token 静默只导第一个

### Bug 描述

`AgentExportDialog.vue` 中同名用户技能的多个归属候选项渲染为相互独立的 `el-checkbox`（`:111-120`，多候选时默认全不勾选、勾选状态互不约束），可同时勾选 `shared@12` 与 `shared@13`，`collectInlineSkills` 把多个 token 一起发给后端。后端 `exportBundle` 对每个技能名只生成一条 bundle 条目，归属解析用 `inlineTokens.find((t) => t.name === name && t.userId != null)`（`agent-bundle.service.ts:100`）——**只取第一个命中 token**，第二个及以后的归属被静默丢弃：不报 `PARAM_INVALID`（与"未指定归属的多候选"路径不同），导出"成功"，但 bundle 里内联的是哪个用户的技能完全由 token 的排列顺序决定。管理员以为同时勾选了两个归属（或想换选另一个）时，拿到的是无任何提示的任意一方内容，违反验收口径 §11.1"技能与报告一致"的管理员预期。

方案 §5.2 只规定了"多用户同名且未带 `@userId` → PARAM_INVALID 列出候选"，未规定多个显式 token 的语义；UI"并列展示供选择"的意图是单选。当前实现 = UI 允许歧义输入 + 后端静默取首个，两端都没有把歧义暴露给管理员。

### 严重级别

一般（导出不失败、不出错内容，但归属选择结果与管理员操作意图可能不符且无提示）

### 触发条件

某技能名被多个用户拥有（`/admin/user-skills` 多候选），管理员在导出对话框同一技能行勾选 ≥2 个"内联（用户X）"复选框后导出。

### 涉及文件与行号

- `admin/src/views/agent/AgentExportDialog.vue:22-29`（逐候选项渲染独立 el-checkbox）、`:111-120`（`candidates: matches.map(...)` 无互斥约束）、`:127-135`（collectInlineSkills 原样拼接全部勾选 token）
- `backend-ts/src/agent/agent-bundle.service.ts:100-107`（`explicit = inlineTokens.find(...)` 仅取第一个显式 token，后续 token 无任何处理或报错）

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/agent-bundle.multitoken.temp-spec.ts`

```ts
// agent-bundle.multitoken.temp-spec.ts（审查用临时文件，已删除；还原即复现）
it('shared@12,shared@13 两个 token 都给 → 不报错，且只导出用户 12 的内容（13 被静默丢弃）', async () => {
  await userSkillService.uploadUserSkill(12, [
    { originalFilename: 'shared/SKILL.md', buffer: Buffer.from(skillMd('shared', '来自用户12的版本'), 'utf8') },
  ]);
  await userSkillService.uploadUserSkill(13, [
    { originalFilename: 'shared/SKILL.md', buffer: Buffer.from(skillMd('shared', '来自用户13的版本'), 'utf8') },
  ]);
  agent.skillNames = JSON.stringify(['shared']);

  // 不报 PARAM_INVALID（与未指定归属的多候选不同），静默成功
  const { bundle } = await service.exportBundle(1, 'shared@12,shared@13');
  expect(bundle.skills).toHaveLength(1);
  const md = bundle.skills[0].files?.['SKILL.md'] ?? '';
  expect(md).toContain('来自用户12的版本');
  expect(md).not.toContain('来自用户13的版本');

  // token 顺序反过来 → 导出的是用户 13 的内容：导出结果由 token 排列顺序决定
  const flipped = await service.exportBundle(1, 'shared@13,shared@12');
  const md2 = flipped.bundle.skills[0].files?.['SKILL.md'] ?? '';
  expect(md2).toContain('来自用户13的版本');
  expect(md2).not.toContain('来自用户12的版本');
});
```

**运行结论**：用例通过——`shared@12,shared@13` 不报错、bundle 仅含用户 12 的内容；token 顺序反转后变为仅含用户 13 的内容。多勾选的归属被静默丢弃且结果随顺序漂移。

修复方向：UI 侧将同一技能行的归属改为单选（radio / 勾选互斥）；或后端对"同一技能名出现多个 token"报 `PARAM_INVALID`（与未指定归属多候选同口径），两端任改其一即可消除歧义。

---

## 本轮独立复核（第 1 轮"未发现问题"项换视角重查，无新问题）

- **装配**：`create-app.ts` 中 `sharedAgentEntryRepo` 先于 `AgentService` 构造、`AgentBundleService`/`SharedAgentService` 依赖（skillLoader/userSkillService/mcpServerService/mcpMapper/mcpCipher/userSkillsDir）均在其定义点之后；`McpServerService.getForRuntime/decryptEnv`、`McpServerMapper.countByUserIdAndName/countByNameWhereUserIdNot/insert`（insert 落库含 status/description 字段）、`MysqlMcpServerLookup.findById` 接口均实存且语义匹配；`mcpValidator` 复用同一 `MysqlMcpServerLookup` 实例为等价重构。admin/desktop 构建通过。
- **导入字段校验**：name ≤128 对齐 `agent.name VARCHAR(128)`（V001）；`description` 列为 TEXT、经验/推荐问题对齐现有服务常量；MCP NAME_PATTERN/≤64/连续下划线与 `McpServerService` 口径一致；技能名危险字符与 `writeSkillStaged` 双向一致；`createDisabledMcp` 直写字段（userId=0/DISABLED/env 置空加密/args 过滤）与 mapper.insert 落库字段吻合。
- **权限与路由**：新路由均先 `requireUserId`（全局 preHandler 对非公开路径强制登录，`jwt-hook.ts` 公开前缀不含新路径），写路径 `agent:write`；`/v1/agents/:id/bundle`、`/v1/agents/:id/shared-entry` 与既有 `agent.routes.ts` 路由无前缀冲突；导出响应头 filename 经 `[^\w.-]` 清洗，无头注入面；admin blob 透传分支置于信封解析之前、401 刷新重试逻辑不受影响。
- **V132/仓储**：迁移与方案 DDL 一致、编号无冲突；upsert 保留 created_by、`listAll` 排序同 SQL 口径；`AgentService.deleteAgent` 级联在逻辑删除前执行、`selectList(null, true)` 过滤已删除（名称冲突检测不会误中已删 Agent）。
- **admin**：列表 VO 含 `skillNames`（`agent.routes.ts:255-257`），导出对话框技能行数据源成立；`/skill-docs` 或 `/admin/user-skills` 失败时降级为全引用导出且明示告警；SharedEntryDialog 上架/编辑/下架、停用 Agent 上架被后端"请先启用"拒绝且前端有提示。
- **desktop**：`fetchAgents` 用 `Promise.allSettled`，主列表失败置 error、共享分区失败仅置空；空态/重试/角标/缺依赖可选中逻辑与方案 §5.5 一致；共享分区随 `fetchAgents` 刷新，刷新时机与主列表既有语义相同。
- **mao-cli**：`request()` 对无 `code` 字段的 bundle 裸 JSON 原样返回、对 Result 信封错误（code≠0）抛业务错误，export 的 format 契约校验成立；`parseArgs` 支持 `-o` 2 字符短选项与位置参数，`requireNumber/requireString/optionalString/optionalBoolean` 均已从 `../args` 导入；import `--confirm` 透传、报告渲染对缺失字段安全。

---

## 存疑待确认（不计入确认 bug）

1. **导入非事务的中间态**（承第 1 轮存疑 #2）：confirm 阶段写技能 → 建 MCP → Agent 落库无整体事务；Agent 落库失败时已写盘技能与 DISABLED MCP 成为孤儿，重试时同名 MCP 被 `skip-name-conflict` 跳过、Agent 不绑 MCP，与预检报告不一致。方案未要求事务，属设计取舍，建议与方案作者确认。
2. **inline 隐藏文件"预检放行、写盘静默跳过"**（承第 1 轮存疑 #1）：预检 `inlineFilesPathError` 只拒 `..`/空段，`writeSkillStaged`（`staged-skill-writer.ts:51`）对含 `/.` 段静默 `continue`——报告 `will-import/ok` 但隐藏文件未落盘。导出侧本就跳过隐藏文件，仅手工 bundle 可触发，低危。
3. **systemPrompt 无长度上限**：`parseAndValidateBundle` 对 systemPrompt 只查非空，`agent.system_prompt` 与 `agent_prompt_versions.system_prompt` 均为 TEXT（64KB）。超长 systemPrompt 的 bundle 在预检通过后，confirm 阶段 `agentRepo.insert` 于 DB 层失败 → HTTP 500（且叠加存疑 #1 的孤儿数据）。导出侧不可能产出（源列同为 TEXT），仅恶意/手工 bundle 可触发；现有 `POST /v1/agents` 同样无该校验（存量口径），故未计为本次引入的确认 bug，建议导入侧补一条 ≤65535 字节（或业务上限）校验。
4. **bundle 内重复技能名/重复 MCP 名的预检与确认报告不一致**（承第 1 轮存疑 #4）：预检对同名多条目均报 `will-import`/`will-create-disabled`，confirm 阶段第二个降级为 `import-failed`/`skip-name-conflict`（confirm 报告本身正确）。导出自产 bundle 不含重名，仅手工 bundle 可触发。

## 验证环境与临时文件说明

- 验证均在本机实际运行：Vitest（backend-ts，Node 22）。基线 `npx vitest run src/agent/ src/skill/` 12 files / 118 tests 全绿；临时验证 2 files / 3 tests 全部通过；admin 与 desktop `npm run build` 通过。
- 临时验证文件（`backend-ts/src/agent/shared-agent.dircaliber.temp-spec.ts`、`backend-ts/src/agent/agent-bundle.multitoken.temp-spec.ts`、`backend-ts/vitest.config.temp.ts`）已在报告完成后删除，工作区不留临时文件；报告内附代码可直接还原复现。
