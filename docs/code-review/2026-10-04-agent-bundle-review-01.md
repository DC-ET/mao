# 代码审查报告：Agent 资产化（Bundle 导出/导入 + 团队共享目录 + mao-cli）

- 日期：2026-10-04
- 审查对象：Agent 资产化需求（方案 `docs/plan/2026-10-02-agent-asset-bundle.md`）引入的未提交代码，范围仅限任务指定的 backend-ts / admin / desktop / mao-cli 改动文件
- 基线：`cd backend-ts && npx vitest run src/agent/ src/skill/` 全绿（Test Files 12 passed，Tests 115 passed）
- 结论：**确认 bug 4 个（重大 1、一般 3）**，存疑待确认 4 项；所有确认 bug 均已用可运行验证用例实际复现（临时验证文件已于报告完成后删除，验证代码全文附于本报告内）。

## 摘要

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| 1 | 重大 | 导出 inline 用户技能：候选按 SKILL.md frontmatter 名匹配、读盘按目录名拼接，目录名≠frontmatter 名时静默导出错误技能内容或导出失败 | Vitest 复现（2/2 通过） |
| 2 | 一般 | 导入 inline 技能不校验 SKILL.md frontmatter name 与条目名一致：报告报 ok 且写盘，但系统技能按 frontmatter 名索引，导入 Agent 的技能引用永久悬空 | Vitest 复现（含对照组） |
| 3 | 一般 | `GET /v1/agents/:id/bundle` 收到重复 `inlineSkills` 查询参数时 `raw.trim is not a function` → HTTP 500（应为 400） | Fastify inject 复现 |
| 4 | 一般 | admin 导入对话框 `el-upload :limit="1"` 且未处理 on-exceed/清空列表：同一对话框会话内第二次选择 bundle 文件被静默忽略，无法更换文件重新预检 | Playwright 复现（含对照组） |

---

## Bug 1（重大）：导出 inline 用户技能「frontmatter 名 vs 目录名」错位 → 静默导出错误内容 / 导出失败

### Bug 描述

`AgentBundleService.exportBundle` 中，用户技能候选匹配使用 `userSkillService.listAllUserSkills()` 返回的 `name`（**SKILL.md frontmatter 中的 name**），但随后的 `readUserSkillFiles(ownerUserId, name)` 用该名字直接拼**目录路径** `resolve(getUserSkillsDir(userId), name)` 读盘。用户技能的目录名（上传时 zip 内文件夹名）与 frontmatter name 之间没有任何强制一致性的校验（`validateSkillMd` 不比对两者；`uploadUserSkill` 也不拦截）。两者不一致时：

- **Case A（磁盘上恰好存在同名目录）**：导出"成功"，但 bundle 中 inline 的文件内容是**另一个技能**（目录同名者）的文件——静默的数据错误，随后被导入到目标实例；
- **Case B（磁盘上无同名目录）**：该用户明明拥有该技能（frontmatter 名匹配上了候选），导出却报 `PARAM_INVALID「读取用户技能目录失败」`，导出功能失败。

根因是 `listAllUserSkills()` 本身已返回正确的 `folderPath`（`AdminUserSkillVO` 继承 `SkillDocVO.folderPath`），service 丢弃了它而用 name 重新拼目录。方案 §5.2 的"inline 条目读取该用户技能目录全部文件"意图是读取**匹配到的那个**技能的目录，实现把"技能标识名"与"存储目录名"混为一谈。

agent.skillNames 的现实来源（admin 技能选择器，数据源 `/skill-docs` 与 `/admin/user-skills`）均为 frontmatter 名，因此 frontmatter 名是本功能全链路的身份标识；目录名只是存储布局。同类口径混乱还导致：`SharedAgentService.userSkillDirExists`（目录名口径）与 `buildImportPlan` reference 技能存在性检查（frontmatter 名口径）互相矛盾（方案 §5.4 明文写了目录名口径，故该项不计为本 bug，仅在存疑节提示）。

### 严重级别

重大（核心导出功能在合理用户数据下失败，且存在静默导出错误内容的路径，直接违反验收口径 §11.1）

### 触发条件

任意用户通过 `/v1/user-skills/upload` 上传了目录名与 SKILL.md frontmatter `name` 不一致的技能（上传路径不拦截），且管理员导出绑定了该技能的 Agent 并勾选 inline。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.service.ts:94`（candidates 按 frontmatter name 过滤）、`:114`（`readUserSkillFiles(ownerUserId, name)` 按目录名读盘）、`:193`（`dir = resolve(this.userSkillService.getUserSkillsDir(userId), name)`）
- 佐证（非本次改动，但构成触发面）：
  - `backend-ts/src/skill/user-skill.service.ts:69-89`（`listAllUserSkills` 返回 frontmatter name + folderPath）、`:232-238`（`validateSkillGroup` 不校验 frontmatter name == 目录名）
  - `backend-ts/src/harness/skill/skill-md.ts:46-75`（`validateSkillMd` 的 expectedName 仅用于报错文案）

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/agent-bundle.export-dirmismatch.temp-spec.ts`
（`vitest.config.temp.ts` 为临时配置，仅把 `src/**/*.temp-spec.ts` 加入 include；验证后已删除）

```ts
// agent-bundle.export-dirmismatch.temp-spec.ts（审查用临时文件，已删除；还原即复现）
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('TEMP 验证：导出 inline 技能「frontmatter 名 vs 目录名」错位', () => {
  let root: string;
  let service: AgentBundleService;
  let userSkillService: UserSkillService;
  let agent: Agent;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mao-review-export-'));
    const skillsDir = join(root, 'skills');
    const userSkillsDir = join(root, 'userskills');
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(userSkillsDir, { recursive: true });
    const skillLoader = new SkillLoader(new PathSandbox(join(root, 'ws')), skillsDir, 0);
    userSkillService = new UserSkillService(userSkillsDir);
    const cipher = new McpSecretCipher('unit-test-secret');
    const mcpStore = new Map();
    const agentRepo = { findById: async (id: number) => (id === 1 ? agent : null) };
    service = new AgentBundleService(
      agentRepo as never,
      new AgentExperienceService({ listByAgentId: async () => [] } as never),
      new AgentSuggestedQuestionService({ listByAgentId: async () => [] } as never),
      skillLoader,
      userSkillService,
      new McpServerService({ selectById: async () => null } as never, cipher, {} as never),
      {} as never,
      cipher,
    );
    agent = { id: 1, name: 'A', systemPrompt: 'p' } as Agent;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('Case A：目录名≠frontmatter 名且存在同名其它目录 → 导出错误技能的文件内容', async () => {
    // 目录 code-review 内的 SKILL.md frontmatter 名是 other-skill
    await userSkillService.uploadUserSkill(12, [
      { originalFilename: 'code-review/SKILL.md', buffer: Buffer.from(skillMd('other-skill', '另一个技能'), 'utf8') },
    ]);
    // 真正的 code-review 技能在目录 holder 里
    await userSkillService.uploadUserSkill(12, [
      { originalFilename: 'holder/SKILL.md', buffer: Buffer.from(skillMd('code-review', '真正的评审技能'), 'utf8') },
    ]);

    const all = userSkillService.listAllUserSkills();
    const matched = all.find((s) => s.name === 'code-review')!;
    expect(matched.userId).toBe(12);
    expect(matched.folderPath).toBe(join(root, 'userskills', '12', 'holder')); // 正确目录其实已知

    agent.skillNames = JSON.stringify(['code-review']);
    const { bundle } = await service.exportBundle(1, 'code-review');
    const inline = bundle.skills[0];
    expect(inline.include).toBe('inline');
    // BUG：读盘读的是目录 code-review（frontmatter=other-skill），导出了另一个技能的文件
    expect(inline.files?.['SKILL.md']).toContain('name: other-skill');
  });

  it('Case B：目录名≠frontmatter 名且无同名目录 → 该用户拥有技能却导出失败', async () => {
    await userSkillService.uploadUserSkill(13, [
      { originalFilename: 'my-tool/SKILL.md', buffer: Buffer.from(skillMd('skill-x'), 'utf8') },
    ]);
    const all = userSkillService.listAllUserSkills();
    expect(all.find((s) => s.name === 'skill-x')).toBeTruthy();

    agent.skillNames = JSON.stringify(['skill-x']);
    await expect(service.exportBundle(1, 'skill-x')).rejects.toMatchObject({
      message: expect.stringContaining('读取用户技能目录失败'),
    });
  });
});
```

**运行结论**：2 个用例全部通过（即 bug 断言全部成立）——
- Case A：`listAllUserSkills` 明确知道 `code-review` 位于 `holder` 目录，但 `exportBundle` 仍成功导出，且 `bundle.skills[0].files['SKILL.md']` 内容为 `name: other-skill`（**错误技能内容静默出包**）；
- Case B：用户 13 拥有技能 `skill-x`，导出却以 `读取用户技能目录失败` 拒绝（PARAM_INVALID）。

---

## Bug 2（一般）：导入 inline 技能不校验 SKILL.md frontmatter name 与条目名一致 → 报告 ok 但技能引用悬空

### Bug 描述

导入侧对 inline 技能的校验只调用 `validateSkillMd(skillMd, skill.name)`（预检 `buildImportPlan` 与写盘 `writeSkillStaged` 各一次），该函数不比对 frontmatter `name` 与传入的期望名（expectedName 仅用于报错文案）。因此 bundle 中条目名 `foo`、SKILL.md frontmatter `name: bar` 的技能会：

1. 预检报 `will-import`、确认报 `ok`（写盘到 `skills/foo`）；
2. 但 `SkillLoader` 按 frontmatter 名索引技能（`skill-loader.ts:89`），系统技能表里注册的是 `bar` 而非 `foo`；
3. 导入出的 Agent `skillNames=['foo']` 在目标实例上永远解析不到——共享目录自检会持续报"缺少技能 foo"，运行时也不会挂载该技能。

违反验收口径 §11.1"技能与 MCP 状态与报告一致"。自研导出（目录名==frontmatter 名时）不触发；第三方/手工制作的 bundle、或经 Bug 1 Case A 错位导出的 bundle 会触发。建议在预检与 `writeSkillStaged` 中比对 frontmatter name 与条目名（或复用 `parseSkillMdContent` 取 name 后断言相等）。

### 严重级别

一般（半可信输入的校验缝隙；正常导出→导入 round-trip 不触发）

### 触发条件

导入的 bundle 中 inline 技能条目的 `name` 与其 `SKILL.md` frontmatter `name` 不一致，且系统技能目录无同名技能。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.service.ts:520-532`（预检仅 `validateSkillMd`，无名称一致性断言）
- `backend-ts/src/skill/staged-skill-writer.ts:28-35`（写盘同样只调 `validateSkillMd`）
- `backend-ts/src/harness/skill/skill-md.ts:46-75`（`validateSkillMd` 不比对 expectedName 与 metadata.name）
- 关联后果：`backend-ts/src/harness/skill/skill-loader.ts:88-92`（按 frontmatter name 注册）

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/agent-bundle.import-namemismatch.temp-spec.ts`

```ts
// agent-bundle.import-namemismatch.temp-spec.ts（审查用临时文件，已删除；还原即复现）
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
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
import { BUNDLE_FORMAT, BUNDLE_FORMAT_VERSION } from './agent-bundle.types.js';

describe('TEMP 验证：导入 inline 技能 frontmatter name 与条目名不一致', () => {
  let root: string; let skillsDir: string; let skillLoader: SkillLoader;
  let service: AgentBundleService;
  let agentRepo: { rows: Map<number, unknown>; selectList: () => Promise<unknown[]>; insert: (a: never) => Promise<number> };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mao-review-import-'));
    skillsDir = join(root, 'skills');
    mkdirSync(skillsDir, { recursive: true });
    skillLoader = new SkillLoader(new PathSandbox(join(root, 'ws')), skillsDir, 0);
    const cipher = new McpSecretCipher('unit-test-secret');
    let nextId = 1;
    const rows = new Map();
    agentRepo = {
      rows,
      selectList: async () => [...rows.values()],
      insert: async (a: never) => { const id = nextId++; rows.set(id, a); return id; },
    };
    service = new AgentBundleService(
      agentRepo as never,
      new AgentExperienceService({ listByAgentId: async () => [], syncExperiences: async () => undefined } as never),
      new AgentSuggestedQuestionService({ listByAgentId: async () => [], syncSuggestedQuestions: async () => undefined } as never),
      skillLoader,
      new UserSkillService(join(root, 'userskills')),
      new McpServerService({ selectById: async () => null } as never, cipher, {} as never),
      { countByUserIdAndName: async () => 0, countByNameWhereUserIdNot: async () => 0, insert: async () => 1 } as never,
      cipher,
    );
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('条目名 foo / frontmatter name: bar → 报告 ok 且写盘，但 loader 解析不到 foo（Agent 引用悬空）', async () => {
    const bundle = {
      format: BUNDLE_FORMAT,
      formatVersion: BUNDLE_FORMAT_VERSION,
      agent: { name: 'A', systemPrompt: 'p' },
      skills: [{ name: 'foo', include: 'inline', files: { 'SKILL.md': '---\nname: bar\ndescription: 另一个名字\n---\n正文\n' } }],
    };

    const precheck = await service.importBundle(structuredClone(bundle), false, 7);
    expect(precheck.skills[0].action).toBe('will-import'); // 预检即放行

    const result = await service.importBundle(structuredClone(bundle), true, 7);
    if (!('agentId' in result)) throw new Error('expected import result');
    expect(result.report.skills[0].action).toBe('ok'); // 确认报告仍称成功

    expect(existsSync(join(skillsDir, 'foo', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(skillsDir, 'foo', 'SKILL.md'), 'utf8')).toContain('name: bar');

    skillLoader.invalidateCache();
    expect(skillLoader.hasSkill('foo')).toBe(false); // Agent 引用悬空
    expect(skillLoader.hasSkill('bar')).toBe(true);

    const created = agentRepo.rows.get(result.agentId) as { skillNames: string };
    expect(JSON.parse(created.skillNames)).toEqual(['foo']);
  });

  it('对照：条目名与 frontmatter 名一致（foo/foo）时一切正常', async () => {
    const bundle = {
      format: BUNDLE_FORMAT, formatVersion: BUNDLE_FORMAT_VERSION,
      agent: { name: 'A', systemPrompt: 'p' },
      skills: [{ name: 'foo', include: 'inline', files: { 'SKILL.md': '---\nname: foo\ndescription: 一致\n---\n正文\n' } }],
    };
    const result = await service.importBundle(bundle, true, 7);
    if (!('agentId' in result)) throw new Error('expected import result');
    skillLoader.invalidateCache();
    expect(skillLoader.hasSkill('foo')).toBe(true);
  });
});
```

**运行结论**：2 个用例全部通过——错名 bundle 预检 `will-import`、确认 `ok`、文件落在 `skills/foo`，但 `skillLoader.hasSkill('foo') === false`、`hasSkill('bar') === true`，落库 Agent `skillNames=['foo']` 引用悬空；对照组（同名）正常。

---

## Bug 3（一般）：`GET /v1/agents/:id/bundle` 重复 `inlineSkills` 查询参数 → TypeError → HTTP 500

### Bug 描述

路由将 `query.inlineSkills` 以 string 假设直接透传：`const inlineSkills = (request.query as Record<string, string | undefined>).inlineSkills`。Fastify 默认 querystring 解析对重复参数返回**数组**（`?inlineSkills=a&inlineSkills=b` → `['a','b']`），`parseInlineSkillTokens` 中 `raw.trim()` 抛 `TypeError: raw.trim is not a function`，经 `handleError` 变成 HTTP 500「服务内部错误」，而此类客户端输入错误应返回 400 参数错误。admin 前端与 CLI 正常只发单值，属健壮性缺陷（低危），但接口契约上 500 会触发通用错误监控噪音。

### 严重级别

一般（低危；仅畸形请求触发）

### 触发条件

对导出接口发起带重复 `inlineSkills` 参数的请求：`GET /api/v1/agents/<id>/bundle?inlineSkills=a&inlineSkills=b`。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.routes.ts:23`（无类型的 query 透传）
- `backend-ts/src/agent/agent-bundle.service.ts:628-642`（`parseInlineSkillTokens` 直接 `raw.trim()`）

### 验证方式

运行：`cd backend-ts && npx vitest run --config vitest.config.temp.ts src/agent/agent-bundle.queryarray.temp-spec.ts`

```ts
// agent-bundle.queryarray.temp-spec.ts（审查用临时文件，已删除；还原即复现）
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handleError } from '../common/http-error.js';
import { PathSandbox } from '../harness/safety/path-sandbox.js';
import { SkillLoader } from '../harness/skill/skill-loader.js';
import { McpSecretCipher } from '../harness/mcp/crypto/mcp-secret-cipher.js';
import { McpServerService } from '../harness/mcp/service/mcp-server.service.js';
import { AgentExperienceService } from './agent-experience.service.js';
import { AgentSuggestedQuestionService } from './agent-suggested-question.service.js';
import { AgentBundleService } from './agent-bundle.service.js';
import { registerAgentBundleRoutes } from './agent-bundle.routes.js';
import { UserSkillService } from '../skill/user-skill.service.js';
import { BUNDLE_FORMAT } from './agent-bundle.types.js';

describe('TEMP 验证：bundle 导出重复 inlineSkills 查询参数', () => {
  let app: ReturnType<typeof Fastify>;
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'mao-review-query-'));
    const cipher = new McpSecretCipher('unit-test-secret');
    const agentRepo = { findById: async (id: number) => ({ id, name: 'A', systemPrompt: 'p' }) };
    const service = new AgentBundleService(
      agentRepo as never,
      new AgentExperienceService({ listByAgentId: async () => [] } as never),
      new AgentSuggestedQuestionService({ listByAgentId: async () => [] } as never),
      new SkillLoader(new PathSandbox(join(root, 'ws')), join(root, 'skills'), 0),
      new UserSkillService(join(root, 'userskills')),
      new McpServerService({ selectById: async () => null } as never, cipher, {} as never),
      {} as never,
      cipher,
    );
    app = Fastify();
    app.setErrorHandler(handleError);
    app.addHook('preHandler', (req, _r, done) => { (req as { userId?: number }).userId = 7; done(); });
    registerAgentBundleRoutes(app, { agentBundleService: service, permissionService: { hasPermission: async () => true } });
    await app.ready();
  });

  afterEach(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });

  it('单个参数正常返回 bundle', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/agents/1/bundle?inlineSkills=code-review@12' });
    expect(res.statusCode).toBe(200);
    expect(res.json().format).toBe(BUNDLE_FORMAT);
  });

  it('重复参数 ?inlineSkills=a&inlineSkills=b → 500（应为 400 参数错误）', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/agents/1/bundle?inlineSkills=a&inlineSkills=b' });
    console.log('repeated-param status =', res.statusCode, 'body =', res.body.slice(0, 200));
    expect(res.statusCode).toBe(500);
  });
});
```

**运行结论**：2 个用例通过。重复参数请求实际返回 `500`，响应体 `{"code":5001,"message":"服务内部错误",...}`，日志打出 `Unexpected exception TypeError: raw.trim is not a function`；单值参数正常 200 返回 bundle。修复方向：入口处 `typeof inlineSkills === 'string'` 归一（或数组取 `flat().join(',')`），否则 400。

---

## Bug 4（一般）：admin 导入对话框 `el-upload :limit="1"` 导致同一会话内无法更换 bundle 文件

### Bug 描述

`AgentImportDialog.vue` 的上传组件配置为 `:auto-upload="false" :show-file-list="false" :limit="1"`，未绑定 `:file-list`、未处理 `on-exceed`、也无 `clearFiles()` 调用。element-plus 的 upload-content 在 `fileList.length + files.length > limit` 时直接调用 `onExceed` 并 **return**（文件被丢弃，`on-change` 不触发）。el-upload 内部的 fileList 在对话框存活期间持续保留第一次选择的文件（`show-file-list=false` 只是看不见，没有清掉）。后果：管理员在同一对话框会话内：

- 选错了文件想换一个 → 第二次选择被**静默忽略**，预检报告仍是旧文件（或仍是空）；
- 完成 A bundle 导入后想直接导入 B → 同样无效。

必须关闭并重开对话框才能重选。`on-exceed` 未处理导致用户侧零反馈，属于交互功能缺陷。

### 严重级别

一般（业务可通过重开对话框绕过，但操作被静默吞掉且无提示）

### 触发条件

打开"导入 Agent Bundle"对话框，选择过一次 JSON 文件后，再次选择任何文件（不关闭对话框）。

### 涉及文件与行号

- `admin/src/views/agent/AgentImportDialog.vue:15-24`（el-upload 配置）、`:127-148`（`handleFileChange` 无重置机制）
- 佐证（依赖库行为）：`admin/node_modules/element-plus/es/components/upload/src/upload-content.vue_vue_type_script_setup_true_lang.mjs:36-41`：

```js
const { autoUpload, limit, fileList, multiple, onStart, onExceed } = props;
if (limit && fileList.length + files.length > limit) {
  onExceed(files, fileList);
  return; // 文件被丢弃，on-change 不触发
}
```

### 验证方式

运行：`node scripts/tmp-verify-elupload-limit.cjs`（临时脚本，验证后已删除；用 Playwright + 本地 element-plus 2.14 复刻 AgentImportDialog 的 el-upload props，连续两次 `setInputFiles` 并统计 on-change / on-exceed 触发；脚本同时含"无 limit"对照组以证明测试手段有效）

```js
// scripts/tmp-verify-elupload-limit.cjs（核心片段，全文见验证脚本，已删除）
// 页面：与 AgentImportDialog 相同的 props
// <el-upload :auto-upload="false" :show-file-list="false" :limit="1"
//            accept=".json,application/json" :on-change="onChange" :on-exceed="onExceed">
// 对照组页面去掉 :limit
async function selectTwice(page, label) {
  await page.setInputFiles('input[type=file]', [
    { name: 'bundle-a.json', mimeType: 'application/json', buffer: Buffer.from('{"first":true}') },
  ]);
  await page.waitForFunction(() => window.changeEvents.length >= 1);
  const afterFirst = await page.evaluate(() => [...window.changeEvents]);
  await page.setInputFiles('input[type=file]', [
    { name: 'bundle-b.json', mimeType: 'application/json', buffer: Buffer.from('{"second":true}') },
  ]);
  await page.waitForTimeout(300);
  const afterSecond = await page.evaluate(() => [...window.changeEvents]);
  const exceeds = await page.evaluate(() => [...window.exceedEvents]);
  console.log(`[${label}] 第二次选择触发 on-change: ${JSON.stringify(afterSecond)}`);
  return { afterFirst, afterSecond, exceeds };
}
```

**运行结论**（Playwright chromium 实测）：

```
[对照组 无 limit]  第二次选择触发 on-change: ["bundle-a.json","bundle-b.json"]（正常）
[复现组 limit=1]   第一次选择触发 on-change: ["bundle-a.json"]
[复现组 limit=1]   第二次选择触发 on-change: ["bundle-a.json"]      ← 第二次被吞
[复现组 limit=1]   on-exceed 触发: ["exceed"]                        ← 仅回调未处理的钩子
结论：BUG 复现 —— limit=1 时第二次选择文件仅触发 on-exceed（组件未处理），
on-change 不再触发，管理员在同一对话框会话内无法更换 bundle 文件重新预检。
```

修复方向：`:limit="1"` 改为不限并每次覆盖（`:on-change` 里以新文件替换），或 `:on-exceed` 中 `clearFiles()` 后手动重放文件，或绑定 `v-model:file-list` 每次重置为 `[file]`。

---

## 与方案 §5（详细设计）/ §7（测试方案）逐条核对结论

**§7 用例组覆盖情况**：导出组装、脱敏（含序列化全文无密钥断言、解密失败报错）、round-trip（逐字段 + 提示词版本恰为 v1）、导入校验（format/名称冲突递增/confirm 重算/MCP 同名跳过/skip-invalid/exists-skip）、字段级校验（name ≤128 截断加后缀、经验 300 字跳过、推荐问题 5×100、MCP NAME_PATTERN、技能名危险字符）、导出体积 10MB、权限（401/403 + shared-agents 登录即可）、共享目录（停用拒上架、upsert、自检、删除级联）、排序展示——第 7 节各用例组在 `agent-bundle.service.spec.ts` / `agent-bundle.routes.spec.ts` / `shared-agent.service.spec.ts` 中均有对应实现，**无遗漏**。覆盖盲区即 Bug 1 / Bug 2 的"技能名与目录/frontmatter 名一致性"维度（方案本身未明确该口径，实现侧选了不一致的两套口径）。

**§5 其它核对点（未发现问题）**：

- 脱敏：env 值全量替换 `$MAO_REDACTED`，HTTP url 不脱敏（与 §5.1 声明一致）；解密失败直接报错不降级（§8 对策落实）；admin blob 错误分支可达（后端业务异常返回 HTTP 200 + Result 信封，无 Content-Disposition，`AgentExportDialog.handleExport` 的解析分支成立）。
- 两段式：confirm 阶段完整重算 `parseAndValidateBundle` + `buildImportPlan`（§5.3 防并发窗口要求满足）；名称冲突后缀在截断原名上追加且 ≤128；经验/推荐问题/MCP 名/技能名字段级约束与现有服务常量对齐（300 / 5×100 / NAME_PATTERN+≤64+连续下划线 / 64）。
- MCP 直写：`createDisabledMcp` 直写 mapper，userId=0、status=DISABLED、env 键保留值置空、经 cipher 加密——与 §5.3 第 2 步一致；bundle 内同名条目在 confirm 阶段有 `createdNames` 防御。
- inline 写盘：`writeSkillStaged` 拒绝穿越/危险名、目标存在即失败不覆盖、暂存目录 finally 清理、成功后 `invalidateCache`——与 §4 选型一致。
- 共享目录：V132 迁移与 §5.4 DDL 一致；`GET /v1/shared-agents` 登录即可、写路径 agent:write、停用 Agent 拒上架、已删除/停用 Agent 不展示、排序 `sort_order ASC, agent_id ASC`、`AgentService.deleteAgent` 服务层级联（`create-app.ts` 装配顺序正确，`SharedAgentEntryRepository` 先于 `AgentService` 构造；`MysqlMcpServerLookup` 复用给 `McpServerValidatorImpl`）。
- desktop：store `Promise.allSettled` 并行拉取，主列表失败置 error、共享目录失败仅置空分区，语义合理；`AgentSelector` 缺依赖共享 Agent 仍可选中（§5.5 要求），角标 tooltip 列出 missingSkills/mcpIssues。
- mao-cli：export 裸 JSON 响应校验 `format` 契约、`-o` 短参数可用（parseArgs 支持 2 字符短选项）、失败时后端 HTTP 200 Result 信封被 `request()` 以业务错误抛出；import `--confirm` 透传、报告渲染对缺失字段安全。

---

## 存疑待确认（不计入确认 bug）

1. **inline 隐藏文件的"预检放行、写盘静默跳过"**：`writeSkillStaged`（`staged-skill-writer.ts:46`）对含 `/.` 的相对路径静默 `continue`，而预检 `inlineFilesPathError`（`agent-bundle.service.ts:616-625`）只拒绝 `..`/空段——报告会写 `will-import/ok` 但隐藏文件实际未落盘。导出侧本就跳过隐藏文件，故仅手工 bundle 可触发；不阻断、低危，但与"预检报告与实际一致"的注释承诺不完全相符。未验证为独立 bug（行为符合"与上传写入规则对称"的既有口径）。
2. **导入非事务的中间态**：confirm 阶段先写盘技能、再创建 MCP、最后 Agent 落库，无整体事务。若 Agent 落库失败（如 DB 异常），已创建的 DISABLED MCP 与已写盘技能成为孤儿；随后重试时这些 MCP 同名会被 `skip-name-conflict`，Agent 将不绑任何 MCP，与首次预检报告不一致。方案 §5.3/§8 未要求事务，属设计取舍，建议与方案作者确认是否接受或补充补偿逻辑。
3. **导出侧 `readUserSkillFiles` 无目录根围栏**：`resolve(getUserSkillsDir(userId), name)` 对 name 不做穿越检查（对照 `shared-agent.service.ts:106-118` 对 skillNames 做了防护）。`name` 来自 agent.skillNames / inline token，正常数据下受"frontmatter 名候选匹配"前置约束，仅当历史数据或特制 frontmatter name 含 `..` 时可能越出用户技能根目录读文件进 bundle。因导出要求 agent:write（管理员），无权限边界跨越，风险有限；建议与共享目录同口径加围栏。
4. **bundle 内重复技能名/重复 MCP 名的预检口径**：预检对同名多条目均报 `will-import` / `will-create-disabled`，confirm 阶段第二个自动降级（existsSync 失败 / `createdNames` 命中），预检与确认报告可能不一致（confirm 报告本身正确）。导出自产 bundle 不会含重名，仅手工 bundle 可触发。

## 验证环境与临时文件说明

- 验证均在本机实际运行：Vitest（backend-ts，Node 22）与 Playwright chromium（root node_modules 1.61.1 + admin node_modules element-plus 2.14 / vue 3.5 静态页面）。
- 临时验证文件（`backend-ts/src/agent/*.temp-spec.ts` ×3、`backend-ts/vitest.config.temp.ts`、`scripts/tmp-verify-elupload-limit.cjs`）已在报告完成后删除，工作区不留临时文件；报告内附的代码可直接还原复现。
- 复查过现有测试基线：`npx vitest run src/agent/ src/skill/` 全绿（12 files / 115 tests）。
