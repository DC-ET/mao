# 代码审查报告（第 5 轮）：Agent 资产化（Bundle 导出/导入 + 团队共享目录 + mao-cli）

- 日期：2026-10-04
- 审查对象：第 4 轮报告（`docs/code-review/2026-10-04-agent-bundle-review-04.md`）修复后的未提交代码，范围仅限任务指定的 backend-ts / admin / desktop / mao-cli 改动文件（desktop/api、TopNav、MemoryView、SettingsView、memory.md、tests/desktop.spec.ts 及 session/message-queue、chat 组件等用户其它未提交工作不在范围内）
- 基线：`cd backend-ts && npm test` 全绿（Test Files 240 passed | 1 skipped，Tests 2670 passed | 13 skipped，exit=0）；`cd admin && npm run build`（vue-tsc）与 `cd desktop && npm run build`（vue-tsc）均通过
- 结论：**第 4 轮修复主体正确，但守卫作用域过宽、附带拦截了无歧义的合法导出（本轮唯一确认 bug，一般 1 个）**；前四轮全部修复交叉复核无矛盾，端到端走查未发现其它整体性问题。存疑待确认 6 项（3 项承前、3 项本轮新列）。确认 bug 以可运行 Vitest 用例实际复现（临时验证文件已于报告完成后删除，验证代码全文附于本报告内）。

## 摘要

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| 1 | 一般 | 第 4 轮新增的同名多目录守卫（dirsByUser）检查**全部用户**的候选而非请求所涉归属：用户 13 存在同名双目录时，显式请求 `shared@12`（用户 12 仅一个目录、归属无歧义、修复前可正常导出）也被 PARAM_INVALID 拒绝，且报错指向未被请求的用户 13；admin 导出对话框将该行整体标记 conflict，用户 12 的合法内联候选一并不可勾选 | Vitest 复现（2/2 通过，含对照组） |

---

## A. 第 4 轮修复复核结论

### 修复：同用户同名多目录导出显式 PARAM_INVALID（后端 dirsByUser 检查）+ admin AgentExportDialog `kind='conflict'` 行

**主体正确、回归测试在位，但守卫作用域过宽 → 本轮 Bug 1。** 逐项核实：

| 关注点 | 结论 | 依据 |
|---|---|---|
| 同用户双目录 + 裸 token | ✅ 按修复意图报 PARAM_INVALID | `agent-bundle.service.ts:106-111`（dirsByUser 统计每用户候选数，>1 即报错，文案含用户 id 与技能名）；回归测试 `agent-bundle.service.spec.ts:377-392` 覆盖 |
| 同用户双目录 + 该用户自己的 `name@userId` | ✅ 按修复意图报 PARAM_INVALID | 同上；回归测试第二条断言覆盖 |
| admin conflict 行渲染 | ✅ 与后端口径一致 | `AgentExportDialog.vue:127-132`（perUserCount 与后端同源于 `listAllUserSkills`，`/v1/admin/user-skills` 即调它）；conflict 行不渲染复选框 → 不发 token → 后端走 reference 分支导出成功，对话框永远不会触发后端的冲突报错；tooltip 给出整理指引（`:22-27`） |
| conflict 行导出可用性 | ✅ | 该技能按引用导出（无 token → `agent-bundle.service.ts:145` reference 分支），与 tag 文案「同名目录冲突 · 引用（不可内联）」语义一致 |
| **守卫作用域** | ❌ 过宽 | `dirsByUser` 对**该技能名的全部候选（跨所有用户）**做统计并在任一用户多目录时抛错（`:106-111`），先于显式归属解析（`:117-124`）执行。当多目录问题出现在**未被请求的其它用户**身上时，无歧义的 `name@userId` 请求也被拒绝——见 Bug 1 |

### Bug 1（一般）：同名多目录守卫跨用户过度拦截——其它用户存在同名双目录时，无歧义的显式归属导出被拒绝

### Bug 描述

第 4 轮修复的动机（代码注释 `agent-bundle.service.ts:104-105`）是「name@userId 无法表达（同用户多目录间的）选择，静默取首个会让另一目录内容不可达」——该理由只适用于**请求所涉归属用户自身**存在多个同名目录的情形。但实现把检查放在显式归属解析**之前**、且对**跨全部用户**的候选统计：

```ts
// agent-bundle.service.ts:103-111
const candidates = userSkillsCache.filter((s) => s.name === name);
const dirsByUser = new Map<number, number>();
for (const c of candidates) dirsByUser.set(c.userId, (dirsByUser.get(c.userId) ?? 0) + 1);
const conflictUser = [...dirsByUser.entries()].find(([, n]) => n > 1);
if (conflictUser != null) {
  throw new BusinessException(ErrorCode.PARAM_INVALID, `用户 ${conflictUser[0]} 存在多个同名技能「${name}」目录，无法内联导出，请先在个人技能中整理重名技能后重试`);
}
```

当数据为「用户 12 拥有 1 个 `shared` 目录（干净）+ 用户 13 拥有 2 个 `shared` 目录（同名双目录，标准上传路径即可造出，见第 4 轮验证）」时：

1. 请求 `shared@12`：候选解析本是**无歧义**的（用户 12 恰有一个目录，`candidates.find(c => c.userId === 12)` 唯一命中），但请求在到达归属解析前即被上面的守卫拒绝——该合法导出在修复前（第 4 轮修复落地前）可正常完成，属修复附带引入的功能回归；
2. 报错文案为「用户 13 存在多个同名技能…」，管理员请求的是用户 12 的技能，报错却指向一个未被请求、且管理员无权直接整理其个人技能目录的第三方用户（用户技能归终端用户所有），报错与请求错位、 remediation 路径对管理员不可达；
3. admin 导出对话框（`AgentExportDialog.vue:127-132`）对整行渲染 `conflict`（perUserCount 任一用户 >1 即冲突），用户 12 本可无歧义内联的候选也一并不可勾选——与后端口径一致，但同样把「一个用户的脏数据」扩大成「所有用户对该技能的内联导出不可用」。

未受影响的路径：裸 token 请求（多用户候选本就歧义，报错合理）；reference 导出（不触发守卫）；同用户双目录场景本身（修复意图所在）。触发面为「同一技能名被多个用户安装，且其中一人有同名双目录」——两个条件都可经标准上传路径无告警产生。

### 严重级别

一般（失败闭合、报错显式、reference 导出可绕行，无静默数据错误；但一个此前可用的无歧义合法请求变为必然失败，且报错指向无关用户）

### 触发条件

技能名 `shared` 同时被用户 12（1 个目录）与用户 13（≥2 个同名 frontmatter 目录）拥有；管理员经 CLI 传 `inlineSkills=shared@12` 导出（或打开导出对话框——该行被整体标记冲突，无法内联任何归属）。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.service.ts:106-111`（dirsByUser 对全部候选统计并在任一用户多目录时抛错，先于 `:117-124` 显式归属解析）
- `admin/src/views/agent/AgentExportDialog.vue:127-132`（conflict 判定同为跨用户任一多目录即整行冲突）
- 对照（正确语义的解析逻辑）：`agent-bundle.service.ts:117-124`（`candidates.find(c => c.userId === explicit.userId)` 本可对干净用户唯一命中）
- 关联回归测试（未覆盖跨用户场景）：`backend-ts/src/agent/agent-bundle.service.spec.ts:377-392`

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/review5.temp-spec.ts`
（`vitest.config.temp.ts` 为临时配置，仅把 `src/**/*.temp-spec.ts` 加入 include；验证后已删除）

```ts
// review5.temp-spec.ts（审查用临时文件，已删除；还原即复现）
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { McpSecretCipher } from '../harness/mcp/crypto/mcp-secret-cipher.js';
import { McpServerService } from '../harness/mcp/service/mcp-server.service.js';
import { AgentExperienceService } from './agent-experience.service.js';
import { AgentSuggestedQuestionService } from './agent-suggested-question.service.js';
import { AgentBundleService } from './agent-bundle.service.js';
import { UserSkillService } from '../skill/user-skill.service.js';
import type { Agent } from './types.js';

function skillMd(name: string, description = '测试技能'): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n正文\n`;
}

class MemoryAgentRepo {
  rows = new Map<number, Agent>();
  private nextId = 1;
  async findById(id: number): Promise<Agent | null> {
    const a = this.rows.get(id);
    return a && (a as { deleted?: number }).deleted !== 1 ? a : null;
  }
  async insert(agent: Agent): Promise<number> {
    const id = this.nextId++;
    this.rows.set(id, { ...agent, id, deleted: 0 } as Agent);
    return id;
  }
  async selectList(): Promise<Agent[]> { return [...this.rows.values()]; }
  async updateById(): Promise<void> {}
  async deleteById(id: number): Promise<void> { this.rows.delete(id); }
}
class MemoryEntryRepoForExp { async listByAgentId(): Promise<never[]> { return []; } }
class MemoryEntryRepoForQ { async listByAgentId(): Promise<never[]> { return []; } }

describe('review5：第 4 轮 dirsByUser 冲突守卫的作用域（跨用户过度拦截）', () => {
  let root: string; let service: AgentBundleService; let userSkillService: UserSkillService; let agent: Agent;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mao-review5-'));
    const skillsDir = join(root, 'skills');
    const userSkillsDir = join(root, 'userskills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
    const skillLoader = new SkillLoader(new PathSandbox(join(root, 'ws')), skillsDir, 0);
    userSkillService = new UserSkillService(userSkillsDir);
    const cipher = new McpSecretCipher('unit-test-secret');
    service = new AgentBundleService(
      new MemoryAgentRepo() as never,
      new AgentExperienceService(new MemoryEntryRepoForExp() as never),
      new AgentSuggestedQuestionService(new MemoryEntryRepoForQ() as never),
      skillLoader, userSkillService,
      new McpServerService({ selectById: async () => null } as never, cipher, {} as never),
      {} as never, cipher,
    );
    agent = { id: 1, name: 'A', systemPrompt: 'p' } as Agent;
    (service as unknown as { agentRepo: { findById: (id: number) => Promise<Agent | null> } }).agentRepo = {
      findById: async (id: number) => (id === 1 ? agent : null),
    };
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('对照组：两个用户各一个同名目录时，显式归属 shared@12 正常导出', async () => {
    await userSkillService.uploadUserSkill(12, [
      { originalFilename: 'u12/SKILL.md', buffer: Buffer.from(skillMd('shared', '用户12的版本'), 'utf8') },
    ]);
    await userSkillService.uploadUserSkill(13, [
      { originalFilename: 'u13/SKILL.md', buffer: Buffer.from(skillMd('shared', '用户13的版本'), 'utf8') },
    ]);
    agent.skillNames = JSON.stringify(['shared']);
    const { bundle } = await service.exportBundle(1, 'shared@12');
    expect(bundle.skills).toHaveLength(1);
    expect(bundle.skills[0].files?.['SKILL.md']).toContain('用户12的版本');
  });

  it('bug 演示：用户 13 有同名双目录时，无歧义的显式归属 shared@12（用户 12 仅一个目录）也被 PARAM_INVALID 拒绝', async () => {
    await userSkillService.uploadUserSkill(12, [
      { originalFilename: 'u12/SKILL.md', buffer: Buffer.from(skillMd('shared', '用户12的版本'), 'utf8') },
    ]);
    await userSkillService.uploadUserSkill(13, [
      { originalFilename: 'a/SKILL.md', buffer: Buffer.from(skillMd('shared', '用户13 alpha'), 'utf8') },
    ]);
    await userSkillService.uploadUserSkill(13, [
      { originalFilename: 'b/SKILL.md', buffer: Buffer.from(skillMd('shared', '用户13 beta'), 'utf8') },
    ]);
    agent.skillNames = JSON.stringify(['shared']);
    await expect(service.exportBundle(1, 'shared@12')).rejects.toMatchObject({
      message: expect.stringContaining('用户 13 存在多个同名技能'),
    });
  });
});
```

**运行结论**：2 个用例全部通过（bug 断言成立）——
- 对照组：两用户各一个同名目录时 `exportBundle(1, 'shared@12')` 正常返回，inline 内容为用户 12 的版本（证明守卫在干净数据下不影响显式归属）；
- bug 组：仅用户 13 出现同名双目录后，同样的 `shared@12` 请求被拒绝，错误文案含「用户 13 存在多个同名技能」——报错指向未被请求的用户，用户 12 的无歧义内联导出不可达。

修复方向（供参考）：将守卫收窄到请求实际涉及的归属——显式 token 命中后仅校验该用户目录数是否 >1（或仅在该用户多目录时报错）；无归属请求维持现口径（多候选本就要求消歧）。admin 对话框可同步放宽：仅当**唯一可表达归属的候选也无法内联**时才整行 conflict，否则保留干净用户的候选。若团队评估后认为"任一用户脏数据即全行禁止"属可接受的保守策略，则至少应让报错文案区分"你请求的归属本身无歧义，因其他用户数据问题被连带拒绝"。

---

## B. 前四轮全部修复交叉复核（B1）

逐项核对 9 个修复两两之间的交互，未发现矛盾：

| 修复（轮次） | 交互点 | 结论 |
|---|---|---|
| R1 folderPath 读盘 × R4 dirsByUser | 候选结构与读盘路径同源（userSkillsCache 携带 name/userId/folderPath，`agent-bundle.service.ts:82/99-101`） | ✅ 一致 |
| R1 frontmatter 一致性 × R3 技能名去重 | 去重保留首条（`:456-461`）后，frontmatter 校验作用于幸存条目（`:554-560`），预检/写盘双重校验文案一致 | ✅ 一致 |
| R1 重复 query 参数 join × R3 多 token PARAM_INVALID | `?inlineSkills=a&inlineSkills=b` 归一为 `a,b` 后落入 `tokensForName.length > 1` 报错（`:112-115`），不 500 | ✅ 一致 |
| R1 el-upload 移除 limit × R3 precheckSeq 守卫 | `AgentImportDialog.vue:15-23` 无 limit、`handleFileChange` 每次重置 report/imported，序号守卫 `:126/142-152` 丢弃过期响应 | ✅ 一致 |
| R2 共享自检 frontmatter 口径 × R4 同名双目录 | `listUserSkills` 对同用户双目录返回两条同名条目，Set 按名去重 → 自检通过，与运行时挂载口径一致，无假缺失 | ✅ 一致 |
| R2 多归属互斥 × R4 冲突守卫 | 两者均为 PARAM_INVALID，仅报错文案不同（「多个内联归属」 vs 「多个同名技能」）；执行顺序（冲突守卫在前）不影响结果正确性 | ✅ 一致 |
| R3 导出对话框按名去重 × R4 conflict 行 | 先 `seen` 去重（`AgentExportDialog.vue:111-118`）再对唯一行做 perUserCount 冲突判定（`:127-132`），数据源同 `/admin/user-skills`=`listAllUserSkills`，与后端同口径 | ✅ 一致 |
| R3 停用 Agent 下架出口 × R4（无交集） | `SharedEntryDialog` enabled 传参链（`agent.routes.ts:241` boolean → `AgentListView.vue:308` → dialog 严格比较）维持 R4 复核结论 | ✅ 一致 |
| R3 sortOrder INT 边界 / 隐藏路径段 × 其它 | `shared-agent.service.ts:64-71`、`isHiddenRelativePath`（`agent-bundle.service.ts:653-656`）与 `writeSkillStaged:51-52` 的丢弃/拒绝规则逐字一致（R4 已验证），与 R1/R2 修复无交集 | ✅ 一致 |
| R4 conflict 行 × 后端守卫 | 对话框 conflict 行不发 token → 后端 reference 分支 → 导出成功；对话框永远不会触发后端冲突报错（前端先行拦截），闭环一致 | ✅ 一致（守卫作用域问题即 Bug 1，不属交互矛盾） |

## C. 端到端走查（B2，导出 → 文件 → 导入 → 落库 → 共享目录 → CLI）

以最终交付者视角重走全链路，未发现前四轮因分视角遗漏的整体性问题：

1. **导出**：admin 对话框数据源（`/skill-docs` frontmatter 名 + `/admin/user-skills` 全量含 userId）与后端候选口径一致；行四态（system/user/none/conflict）与后端分支一一对应；唯一候选默认勾选 + 多候选互斥 + 冲突行禁选的组合下，`collectInlineSkills` 产出的 token 串必然通过后端校验（对照 Bug 1 的跨用户场景仅经 CLI 可达）。系统技能指定 inline、归属不存在、多 token、多用户未消歧、同用户多目录均显式 PARAM_INVALID；10MB 上限累计检查位置正确；脱敏（env 值全量 `$MAO_REDACTED`、url 不脱敏）与解密失败即报错与格式文档一致。
2. **文件契约**：bundle 顶层即格式（`format/formatVersion`），导出响应为裸 JSON + Content-Disposition；admin blob 透传分支置于信封解析前，失败分支（HTTP 200 Result 信封 blob）经 `!content-disposition` 解析 message；`bundleFilename` 与 CLI 缺省文件名同规则。
3. **导入**：预检与 confirm 各自完整重算（不信任前端缓存）；名称冲突后缀循环有界且 ≤128；inline 缺 SKILL.md / frontmatter 不一致 / 隐藏段丢弃 / 穿越拒绝在预检与写盘两侧同口径；去重保留首条且 warnings 贯穿两段；MCP 定义校验（STDIO command+非空 args / HTTP url 前缀、NAME_PATTERN+≤64+无连续下划线）与 `McpServerService.validateRequiredFields` 口径一致（导出端不会产出无法通过导入校验的合法存量 MCP）；`createDisabledMcp` 直写字段（userId=0/DISABLED/env 键保留值置空加密）与 mapper.insert 吻合；确认阶段 `createdNames` 防御同名条目。
4. **落库**：`agentRepo.insert` 事务内起提示词版本 v1（对齐 `MysqlAgentRepository.insert`）；skillNames 为去重后条目、mcpServerIds 仅含新建 MCP id；defaultModelId 置空合法（V102 `default_model_id` 可空）；经验/推荐问题 sync 计数与报告一致。
5. **共享目录**：V132 DDL 与仓储 upsert（保留 created_by）/listAll 排序一致；停用/删除 Agent 过滤正确（findById 带 notDeleted，deleteAgent 服务层级联先于逻辑删）；自检 missingSkills 按当前用户 frontmatter 名口径（与运行时挂载同判据）；MCP 自检对 bundle 导入的 DISABLED MCP 如实报「（已停用）」，管理员补齐启用后角标消失——与导入流程闭环一致；desktop `Promise.allSettled` 主列表/共享分区降级互不阻塞，缺依赖仍可选中。
6. **CLI**：`mao agent export` 对 bundle 裸 JSON 的 format 契约校验、`-o` 短选项与 `--inline-skills` 透传实测解析正确（`parseArgs` 冒烟：`{'inline-skills':'shared@12','o':'/tmp/out.json'}`；`--confirm` 解析为 true）；`mao agent import` 预检/confirm 分支与报告渲染对缺字段安全；HTTP 失败经 Result 信封以业务错误抛出。
7. **权限与路由**：新路由全部 `requireUserId`，写路径 `agent:write`，`GET /v1/shared-agents` 登录即可；与既有 `/v1/agents/*` 路由无前缀冲突；装配顺序（sharedAgentEntryRepo → AgentService；bundle/shared 服务依赖均先于构造点定义）正确。

## 存疑待确认（不计入确认 bug）

1. **导入非事务的中间态**（承 R1#2/R2#1/R3#4/R4#4）：confirm 阶段写技能 → 建 MCP → Agent 落库无整体事务；Agent 落库失败留孤儿（已写盘技能、DISABLED MCP），重试时同名 MCP 被 `skip-name-conflict`。方案未要求事务，属设计取舍，建议与方案作者确认。
2. **字段级长度上限缺口**（承 R2#3/R3#2/R4#4，补充 description）：`parseAndValidateBundle` 对 systemPrompt/description/configJson 无长度校验（system_prompt/config_json 为 TEXT/JSON、description 为 TEXT，仅恶意 bundle 可触发 DB 层失败 → 500 并叠加存疑 #1）。现有 `POST /v1/agents` 同无此校验（存量口径），维持存疑。
3. **bundle 内重复 MCP 名的预检与 confirm 报告不一致**（承 R1#4/R2#4/R3#3/R4#3）：预检对同名多条目均报 `will-create-disabled`，confirm 第二条被 `createdNames` 降级 `skip-name-conflict`（confirm 报告本身如实）。技能名一侧已由 R3 去重修复关闭；仅手工 bundle 可触发。
4. **AgentImportDialog「确认导入在途时换文件」的交错**（承 R3#1/R4#1）：预检竞态已由 `precheckSeq` 修复，confirm 在途（`committing=true`）时选择新文件未被拒绝，confirm 完成回调可能短暂展示旧 bundle 的 confirm 报告后被新预检覆盖。服务端不信任预检、最终一致，重选文件可恢复。未验证原因同前两轮：admin 无单测设施，复刻组件状态机的 Playwright 证据力弱，需人为控制双请求时序。
5. **（新）inline token 不匹配任何 skillNames 时静默忽略**：`exportBundle` 对 token 名不在 agent.skillNames 中的情形不报错，该技能按 reference 导出（`agent-bundle.service.ts:87-146` 循环仅按 skillNames 驱动）。admin 对话框只能产出 skillNames 内的 token，不可触发；CLI 手输 typo（如 `code-reveiw@12`）会静默降级为引用导出，bundle 自身 `include` 字段可事后发现。方案 §5.2 未定义未知 token 语义，不计确认 bug；如需收紧可对未知 token 名报 PARAM_INVALID。
6. **（新）导入 inline 技能与目标实例已有用户技能同名时无告警**：inline 导入落点为系统技能目录（方案决议 7），预检只查系统技能同名（`skillLoader.hasSkill` → `exists-skip`），不检查任一用户已有同名个人技能。导入成功后系统技能在运行时按名解析中优先于该用户技能（`harness-service.ts:375-387` 合并去重），该用户的同名个人技能对引用该名字的 Agent 会话被遮蔽。方案未规定用户技能同名碰撞语义；无数据丢失（个人技能目录不动），仅能力来源变化无提示。建议预检对「目标实例存在同名用户技能」追加 warning。

## 验证环境与临时文件说明

- 验证均在本机实际运行：Vitest（backend-ts，Node 22）。基线 `npm test` 240 files / 2670 tests 全绿（exit=0）；临时验证 `src/agent/review5.temp-spec.ts` 2 tests 全部通过（exit=0）；admin 与 desktop `npm run build`（vue-tsc）通过；mao-cli `parseArgs` 冒烟（`-o` 短选项、`--confirm` 开关）实测正确。
- 临时验证文件（`backend-ts/src/agent/review5.temp-spec.ts`、`backend-ts/vitest.config.temp.ts`）已在报告完成后删除，工作区不留临时文件；报告内附代码可直接还原复现。
