# 代码审查报告（第 1 轮）：资产分发闭环（依赖一键补装 + registry/URL 导入/检查更新 + 技能 Bundle）

- 日期：2026-10-05
- 审查对象：分支 `feat/asset-distribution` 提交 `aedd2feb`（相对父提交 `615c6cd4` 的全部代码变更）；设计对照 `docs/plan/2026-10-05-asset-distribution-technical-design.md`
- 范围：仅功能逻辑（backend-ts / admin / desktop），不含文档（CHANGELOG、docs/、skills/ 下 .md）
- 基线：`cd backend-ts && npm test` 全绿（Test Files 242 passed | 1 skipped，Tests 2706 passed | 13 skipped，exit=0）；`cd backend-ts && npm run build`（tsc）、`cd admin && npx vue-tsc -b`、`cd desktop && npx vue-tsc -b` 均通过
- 结论：**确认 bug 5 个（P1 ×1、P2 ×4）**，全部以可运行 Vitest 用例实际复现。本分支新增测试覆盖了大部分设计案例，但未覆盖"重复 skillNames""条目 URL 与 origin URL 不一致""解密失败"三条路径。审查用的 3 个临时验证 spec 已保留在工作区（见文末附录，**勿合入**，修复落地后应删除）。

## 摘要

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| 1 | P1 | `registry` 导出对 `agent.skillNames` 含重复项的 Agent 必然失败（路由 409）：`buildRegistryInlineTokens` 对每个出现位置都生成 token，同一技能产生 2 个 token 触发"指定了多个内联归属"；同类 Agent 走文件导出却正常（导出侧本就做了去重） | `__review-verify-round2.spec.ts`（含路由层 409 断言与文件导出对照） |
| 2 | P2 | `check-updates` 条目 `source_url` 与 `origin.source_url` 不一致时，remoteHash 与**错配来源**的基线比较 → 远端内容从未变化也恒报 `changed=true` | `__review-verify-round2.spec.ts` |
| 3 | P2 | registry `accessToken` 解密失败（SETTINGS_SECRET 轮换/实例迁移）时 `getBundleRegistryConfig` fail-open 为 `accessToken: null`，token 校验被静默跳过 | `__review-verify-round3.spec.ts` |
| 4 | P2 | `fixDependencies` 的"缺失"按 frontmatter 名判定、写盘按**目录名**：操作者已存在同名目录且其 frontmatter 名不同的既有用户技能被**无提示、无备份恢复**地替换 | `__review-verify-round1.spec.ts`（Bug A） |
| 5 | P2 | `skillNames` 含重复项时 `fixDependencies` 输出 `installed` + `ambiguous` 两条自相矛盾的报告项（属主列表含操作者本人） | `__review-verify-round1.spec.ts`（Bug B） |

---

## Bug 1（P1）：registry 导出对 skillNames 含重复项的 Agent 必然 409，而文件导出正常

### 问题描述

`exportRegistryBundle`（`agent-bundle.service.ts:174`）为"每个用户技能生成 `name@userId` 显式 token"先调用 `buildRegistryInlineTokens`：

```ts
// agent-bundle.service.ts:179-196
private buildRegistryInlineTokens(agent: Agent): string[] {
    ...
    for (const name of parseStringArray(agent.skillNames)) {   // ← 未去重
      if (this.skillLoader.hasSkill(name)) continue;
      ...
      tokens.push(`${name}@${candidates[0].userId}`);          // ← 重复名 → 重复 token
    }
    return tokens;
}
```

`agent.skillNames` 是 DB 自由文本数组，历史上完全可能出现重复项——`exportBundle` 自己就为这种情况做了去重（`agent-bundle.service.ts:208-213` 的 `emittedSkillNames`），本次分支的注释也写明"历史数据可能含重复 skillNames"。但 registry 路径绕过了该去重：`['web-search','code-review','code-review']` 生成 `['code-review@8','code-review@8']`，`exportBundle` 随后在 `:229-230` 抛：

> 技能「code-review」指定了多个内联归属，请只保留一个 name@userId

该 `PARAM_INVALID` 经路由层（`agent-bundle.routes.ts:93-95`）映射为 **HTTP 409 结构化错误**。即：**任一 skillNames 含重复项的 Agent，registry 端点（URL 导入/检查更新的唯一数据源）完全不可用**，而同一个 Agent 走管理后台文件导出一切正常。设计 §5.7 把 registry 定位为"URL 导入的核心价值依赖内联"，此 bug 直接打断该链路，且 `check-updates` 会对该项持续落 `error`（管理员无法修复，除非先手改 DB 或编辑 Agent 去掉重复项）。

### 触发条件

`agent.skillNames` 的 JSON 数组含同名重复项（历史数据可达；Agent 编辑侧不保证去重）+ 该技能是用户技能（系统技能在 `:182` 被跳过，不受影响）。无需多归属、无需超限。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.service.ts:179-196`（`buildRegistryInlineTokens` 对 `parseStringArray(agent.skillNames)` 直接迭代，未去重即 push token）
- `backend-ts/src/agent/agent-bundle.service.ts:229-230`（`tokensForName.length > 1` 抛 PARAM_INVALID，即 409 的直接来源）
- 对照（正确语义）：`backend-ts/src/agent/agent-bundle.service.ts:208-213`（`emittedSkillNames` 去重，文件导出路径因此正常）
- 路由映射：`backend-ts/src/agent/agent-bundle.routes.ts:93-95`（非 AGENT_NOT_FOUND 的 BusinessException → 409）
- 未覆盖此场景的既有测试：`backend-ts/src/agent/agent-bundle-distribution.spec.ts:200-230`

### 验证方式

运行：`cd backend-ts && npx vitest run src/agent/__review-verify-round2.spec.ts`（2/2 通过）

关键断言（`__review-verify-round2.spec.ts` 第一个用例）：

```ts
// 同一 Agent、同一技能数据：文件导出正常
const { bundle } = await fx.service.exportBundle(1);
expect(bundle.skills.map((s) => s.name)).toEqual(['web-search', 'code-review']);

// registry 导出必然失败
await expect(fx.service.exportRegistryBundle(1)).rejects.toMatchObject({ code: 2001 });

// 路由层映射为 409 结构化错误
const res = await app.inject({ method: 'GET', url: '/v1/agent-bundle/registry/1' });
expect(res.statusCode).toBe(409);
expect(res.json().detail[0]).toContain('多个内联归属');
```

其中 `agent.skillNames = JSON.stringify(['web-search', 'code-review', 'code-review'])`，`code-review` 为 userId=8 的唯一用户技能。

### 建议修复方向

在 `buildRegistryInlineTokens` 内对技能名去重后再生成 token（如 `for (const name of new Set(parseStringArray(agent.skillNames)))`，与 `exportBundle` 的 `emittedSkillNames` 口径对齐）；更稳妥的做法是在 `parseInlineSkillTokens` 侧对完全相同（name、userId 均同）的 token 去重，覆盖所有调用方（CLI `?inlineSkills=a@8,a@8` 同样会中招）。补回归用例：重复 skillNames → registry 导出得 200 且 `skills` 与文件导出一致。

### 严重级别

P1（registry 是 URL 分发链路的唯一数据源；触发条件为可达的历史数据形态；失败闭合、报错明确，但该 Agent 的跨实例分发能力整体不可用，且管理员无法从 UI 侧修复）

---

## Bug 2（P2）：条目 source_url 与 origin 不一致时，remoteHash 与错配基线比较 → 永久假 changed

### 问题描述

`checkUpdates` 收集目标 URL 的规则（`agent-bundle.service.ts:464-478`）实现了设计 §5.8 决策 10"条目 `source_url` 优先于 origin"：

```ts
// agent-bundle.service.ts:465-469
for (const [id, url] of entryUrlByAgent) targets.set(id, url);      // 缺省全量：条目覆盖 origin
...
// agent-bundle.service.ts:516
item.changed = item.remoteHash !== item.originHash;
```

`originHash` 恒为 `origin.content_hash`——**导入时那条 URL 的包**算出的 hash。当管理员在共享条目上维护的 `source_url` 与当初导入的 URL 不是同一个（指向另一个实例 / 另一个 Agent）时，`remoteHash` 来自条目 URL，`originHash` 来自 origin URL，两者语义不对应：只要两个远端的 bundle 内容有任何差异（几乎必然），`changed` 恒为 `true` 且**不随远端内容变化而改变**。

后果：
1. Agent 列表长期挂着"远端有更新"角标（`AgentListView.vue:59` 的 `remoteChanged()` 判定 `changed && !error`），管理员反复点"重新导入"得到的新副本仍会命中同一错配（新副本建立的是自己的 origin，旧 Agent 的错配依旧）；
2. 该假阳性无法通过"应用更新"消除（应用后旧 Agent 的 origin 不变），只能删掉旧 Agent；
3. 更隐蔽的是反向误导：若两端 bundle 恰好一致，`changed=false` 会让管理员以为"已是最新"，实际比对的是两个不同来源。

设计只规定了"URL 以谁为准"，未规定"URL 变更后基线是否仍可比"。

### 触发条件

同一 Agent 同时存在 `agent_import_origin`（URL 导入写入）与 `shared_agent_entry.source_url`（管理员手工维护）且两者 URL 不一致。可达路径：管理员先 URL 导入，之后在 `SharedEntryDialog` 填写的 registry URL 与导入 URL 不同（如换了实例域名、指向另一个 agentId）。

### 涉及文件与行号

- `backend-ts/src/agent/agent-bundle.service.ts:460-475`（targets 收集：条目 URL 覆盖 origin URL）
- `backend-ts/src/agent/agent-bundle.service.ts:502-517`（`checkOneUpdate`：`originHash` 取自 origin 行，`changed` 直接与 remoteHash 比较，未校验两者是否同源）
- 前端消费：`admin/src/views/agent/AgentListView.vue:382-385`（`remoteChanged`）、`:240-246`（重新导入入口）

### 验证方式

运行：`cd backend-ts && npx vitest run src/agent/__review-verify-round2.spec.ts`（2/2 通过）

关键断言（第二个用例）：

```ts
// 从 A 导入 → origin.sourceUrl = http://a.example.com/r/1
const { agentId } = await fx.service.importBundleFromUrl('http://a.example.com/r/1', true, 7) as { agentId: number };
// 管理员在共享条目上维护 B 实例的 URL（条目优先）
fx.entryRepo.rows.set(agentId, { agentId, note: '', sortOrder: 0, sourceUrl: 'http://b.example.com/r/1', createdBy: 7 });

const items = await fx.service.checkUpdates(null);
expect(items[0].sourceUrl).toBe('http://b.example.com/r/1');
expect(items[0].originHash).toMatch(/^[0-9a-f]{64}$/);   // 基线仍是 A 的 hash
expect(items[0].changed).toBe(true);                    // 远端从未变化，却恒报"有更新"
expect(items[0].error).toBeUndefined();
```

fetch stub 对每端返回固定内容，远端内容从头到尾未变。

### 建议修复方向

在 `checkOneUpdate` 中增加同源判定：`origin != null && origin.sourceUrl !== sourceUrl` 时（或做规范化后比较），不产出 `changed: true`，而是落 `error`（如"条目来源与导入来源不一致，请重新导入以建立基线"）或单独字段 `baselineMismatch: true`。注意根治仍需前端配合：`SharedEntryDialog` 保存 `source_url` 时提示"与导入来源不一致时更新检查不可比"。

### 严重级别

P2（提示性功能给出持续错误结论，可误导管理员反复"应用更新"；不产生数据损坏，失败方向为"过度告警"）

---

## Bug 3（P2）：registry accessToken 解密失败时 fail-open，token 校验被静默跳过

### 问题描述

`getBundleRegistryConfig` 通过对 secret 行解密得到 accessToken：

```ts
// settings.service.ts:322-328
async getBundleRegistryConfig(): Promise<BundleRegistrySettings> {
    const [enabled, token] = await Promise.all([this.getBool(BUNDLE_REGISTRY_ENABLED_KEY), this.getSecret(BUNDLE_REGISTRY_ACCESS_TOKEN_KEY)]);
    return { enabled, accessToken: hasText(token) ? token : null };
}
```

而 `getSecret`（`:565-571`）→ `decryptSecret` 对解密失败是**回落空串**（`console.error` 后 `return ''`）——这是本仓库对其它 secret 键的既有宽容策略，但那些键的失败只是"功能不可用"，而 registry token 的失败是**安全门失效**：

- 管理员曾配置 accessToken 并开启 registry；
- 之后 `SETTINGS_SECRET` 轮换 / 实例迁移（`DEPLOY.md` 的实例级配置）导致旧密文解不开；
- `getBundleRegistryConfig` 返回 `{ enabled: true, accessToken: null }`；
- `agent-bundle.routes.ts:74-76` 的 `if (config.accessToken != null)` 整个 token 校验分支被跳过 → **registry 对任何能访问域名的人全量可读**（含完整 systemPrompt、技能文件内容，正是设计 §8 标注的"最高风险项"）。

同一实例下 `list()` 会把该行显示为纯掩码（`:155-164` 的 catch 分支），管理员侧看不出异常，两侧都无告警。

### 触发条件

`bundle.registry.enabled = true` 且 `bundle.registry.accessToken` 有密文，但当前 `SETTINGS_SECRET` 无法解密密文（密钥轮换、跨实例拷贝 DB、手工改库）。

### 涉及文件与行号

- `backend-ts/src/settings/settings.service.ts:322-328`（`getBundleRegistryConfig`：解密失败与"未配置 token"无法区分）
- `backend-ts/src/settings/settings.service.ts:565-571`（`getSecret`）+ `decryptSecret`（catch → `return ''`）
- `backend-ts/src/settings/settings.service.ts:155-164`（`list()` 侧解密失败回落纯掩码，无异常提示）
- 消费方：`backend-ts/src/agent/agent-bundle.routes.ts:78-82`（`config.accessToken != null` 才校验）

### 验证方式

运行：`cd backend-ts && npx vitest run src/settings/__review-verify-round3.spec.ts`（1/1 通过）

关键断言：

```ts
const repo: SystemSettingRepository = {
  findByKey: vi.fn(async (key: string) => key === 'bundle.registry.enabled'
    ? { id: 8, settingKey: key, category: 'Agent 资产', value: 'true', editable: 1, isSecret: 0 }
    : registryRow('some-ciphertext-not-decryptable-with-current-key')),   // 旧密钥密文
  ...
};
const svc = new SystemSettingService(repo, ..., 'current-key');
const cfg = await svc.getBundleRegistryConfig();
expect(cfg.enabled).toBe(true);
expect(cfg.accessToken).toBeNull();   // ← token 校验被整体跳过
```

运行日志可见 `SystemSetting decrypt failed, treat as unset (SETTINGS_SECRET changed?)`。

### 建议修复方向

让"解密失败"与"未配置"可区分：为 registry token 单独提供严格读取（如 `getSecretStrict`，解密失败抛错），`getBundleRegistryConfig` 捕获后返回"拒绝服务"的状态（例如 `{ enabled: false, accessToken: null }` 并在 `list()` 把该行标记为异常），或至少在 `list()` 对该键的解密失败给出显式提示文案。方向上应保持"失败闭合"：解不开就当作没开，而不是当作没配 token。

### 严重级别

P2（安全边界 fail-open；需同时满足"开过 token + 密钥变更"两个条件，但一旦命中即把内网资产全量暴露，且两侧均无告警）

---

## Bug 4（P2）：fix-deps 静默覆盖操作者同名目录下的既有用户技能

### 问题描述

`fixDependencies` 判"缺失"用的是 **SKILL.md frontmatter 名**，而落盘用的是**目录名**：

```ts
// shared-agent.service.ts:184-186
const userSkillNames = new Set((await this.userSkillLookup.listUserSkills(operatorId)).map((s) => s.name));  // frontmatter 名
for (const name of parseNames(agent.skillNames)) {
  ...
  skills.push(await this.installMissingSkill(name, operatorId));   // name 当作目录名落盘
}
```

`installMissingSkill` → `UserSkillService.installUserSkillFiles` → `commitSkillGroups` → `swapStagedSkill` 是**覆盖式**写盘（`renameSync` 前把既有目录移到 backup，成功后 `rmSync` 清掉备份）。设计 §5.2 的假设是"调用后原技能不存在（自检缺失是前置条件）"，但该假设不成立：**上传侧只校验 SKILL.md 自身合法，不校验目录名 == frontmatter 名**（`validateSkillGroup` 只调 `validateSkillMd(content, skillName)`，后者不比对二者），所以"目录名 A、frontmatter 名 B"的技能是可达状态（仓库自己的测试就构造了这种状态，见 `agent-bundle.service.spec.ts:289-318`）。

于是存在这样一条链：操作者已有目录 `theirs/`（frontmatter 名为 `wrong-name`，因此自检认为 `theirs` 缺失）→ 共享 Agent 引用 `theirs`、实例内有唯一属主 → fix-deps 把属主内容写进 `<userSkillsDir>/<operatorId>/theirs/`，**操作者原有的 `theirs/` 内容（含 frontmatter 名为 `wrong-name` 的技能本身）被静默替换**，报告既没有 failed 也没有任何数据丢失提示，`selfCheck.missingSkills` 也归零。

### 触发条件

1. 操作者拥有一个目录名与 frontmatter 名不一致的用户技能，且其目录名恰好是某共享 Agent 引用的技能名（该名在实例内有唯一属主）；
2. 或并发场景：自检与落盘之间另一操作恰好装上了同名技能（设计预留的兜底方向，备份虽存在但成功后即删除）。

### 涉及文件与行号

- `backend-ts/src/agent/shared-agent.service.ts:184-191`（自检按 frontmatter 名判缺失，随后把该名用作目录名）
- `backend-ts/src/agent/shared-agent.service.ts:203-243`（`installMissingSkill`：唯一属主 → 直接安装，无"目标目录是否已存在"检查）
- `backend-ts/src/skill/user-skill.service.ts:145-188`（`installUserSkillFiles` → `commitSkillGroups` → `swapStagedSkill` 覆盖式替换，成功后删除备份）
- 上游根因（可达状态）：`backend-ts/src/skill/user-skill.service.ts:290-296`（`validateSkillGroup` 不校验目录名与 frontmatter 名一致；`validateSkillMd` 只校验 frontmatter 自身合法）

### 验证方式

运行：`cd backend-ts && npx vitest run src/agent/__review-verify-round1.spec.ts`（4/4 通过）

关键断言（Bug A 用例）：

```ts
// 操作者（userId=9）已有目录 theirs，frontmatter 名为 wrong-name
mkdirSync(join(ctx.userSkillsDir, '9', 'theirs'), { recursive: true });
writeFileSync(join(ctx.userSkillsDir, '9', 'theirs', 'SKILL.md'), validSkillMd('wrong-name'));
writeFileSync(join(ctx.userSkillsDir, '9', 'theirs', 'mine.txt'), '操作者自己的内容');
// 属主（userId=8）的技能 theirs（目录名 holder，frontmatter 名 theirs）
mkdirSync(join(ctx.userSkillsDir, '8', 'holder'), { recursive: true });
writeFileSync(join(ctx.userSkillsDir, '8', 'holder', 'SKILL.md'), validSkillMd('theirs'));

const report = await ctx.service.fixDependencies(1, 9);
expect(report.skills[0]).toMatchObject({ name: 'theirs', action: 'installed' });
expect(report.selfCheck.missingSkills).toEqual([]);      // 自检显示"已修复"

// 但操作者原技能被静默替换
expect(readFileSync(join(ctx.userSkillsDir, '9', 'theirs', 'SKILL.md'), 'utf8')).toContain('name: theirs');
expect(existsSync(join(ctx.userSkillsDir, '9', 'theirs', 'mine.txt'))).toBe(false);
expect(ctx.userSkillService.listUserSkills(9).map((s) => s.name)).toEqual(['theirs']);  // 'wrong-name' 消失，无任何提示
```

### 建议修复方向

安装前做目录占用检查：`installMissingSkill` 内先 `existsSync(getUserSkillsDir(operatorId)/name)`，已存在且其 frontmatter 名 !== name 时，把该条目标为 `failed`（detail 说明"本人已存在同名技能目录，请先整理"）而不是覆盖；`installUserSkillFiles` 增加"目标已存在则拒绝"的可选参数（默认拒绝，上传侧显式传允许以保留现有覆盖语义）。另可顺带在 `validateSkillGroup` 增加目录名与 frontmatter 名一致性校验，从源头收敛该状态。

### 严重级别

P2（真实数据丢失、无提示；但触发需要"目录名≠frontmatter 名"这一非标准状态，且仅影响操作者自己的一个技能）

---

## Bug 5（P2）：skillNames 含重复项时 fix-deps 输出 installed + ambiguous 矛盾报告

### 问题描述

`installMissingSkill` 每次调用都重新 `listAllUserSkills()`（`shared-agent.service.ts:209`）——**全量扫描所有用户的技能目录**。第一次安装成功后，操作者本人名下也有了该技能；第二次处理同名条目时，候选变成 `[属主, 操作者本人]` 两条，命中 `candidates.length > 1` 分支：

```ts
// shared-agent.service.ts:215-223
if (candidates.length > 1) {
  const ownerIds = [...new Set(candidates.map((c) => c.userId))];
  return { name, action: 'ambiguous', ownerUserIds, detail: `同名技能存在多个归属（...），请联系管理员整理后重试` };
}
```

于是同一个技能名在报告里出现两条：一条 `installed`（正确）、一条 `ambiguous`（错误——是刚刚装出来的那个造成的）。`AgentSelector.vue:152-156` 会把 `ambiguous` 的 detail 弹给终端用户，提示"请联系管理员整理"，而实际上无需任何人工处理；同时它也掩盖了真实的治理信号（真正的多归属场景下这条 ambiguous 才有意义）。附带副作用：N 个缺失技能 = N 次全量目录扫描（`listAllUserSkills` 逐用户 `readdirSync`），既是性能问题也放大了上述竞态窗口。

### 触发条件

`agent.skillNames` 含同名重复项（与 Bug 1 同一数据形态；历史可达、编辑侧不保证去重）。

### 涉及文件与行号

- `backend-ts/src/agent/shared-agent.service.ts:184-187`（按 `parseNames` 原样迭代，未去重）
- `backend-ts/src/agent/shared-agent.service.ts:209`（`installMissingSkill` 内重复全量扫描，扫描结果随安装推进而变化）
- `backend-ts/src/agent/shared-agent.service.ts:215-223`（`candidates.length > 1` → ambiguous）
- 前端消费：`desktop/src/components/task/AgentSelector.vue:157-163`

### 验证方式

运行：`cd backend-ts && npx vitest run src/agent/__review-verify-round1.spec.ts`（4/4 通过）

关键断言（Bug B 用例）：

```ts
ctx.agentRows.set(1, { ..., skillNames: JSON.stringify(['good', 'good']) } as Agent);
const report = await ctx.service.fixDependencies(1, 9);
expect(report.skills).toHaveLength(2);
expect(report.skills.map((s) => s.action).sort()).toEqual(['ambiguous', 'installed']);
expect(report.skills.find((s) => s.action === 'ambiguous')?.ownerUserIds).toEqual([8, 9]);
expect(report.selfCheck.missingSkills).toEqual([]);   // 实际功能正常，仅报告自相矛盾
```

### 建议修复方向

在 `fixDependencies` 层对技能名去重（`new Set(parseNames(agent.skillNames))`，与 Bug 1 同一处数据形态、可一并修）；顺手把 `listAllUserSkills()` 提到循环外一次获取（同时消除 N+1 扫描与"扫描结果随安装变化"的竞态）。补回归用例：重复 skillNames → 报告只有一条 installed。

### 严重级别

P2（报告口径错误、会给终端用户误导性弹窗，并掩盖真实多归属信号；实际安装结果正确）

---

## 附 A：审查中验证为"无 bug"的重点项（负面对照）

以下为本次审查重点核对项，均有可运行断言支撑，未发现问题：

| 关注点 | 结论 | 依据 |
|---|---|---|
| check-updates 的 hash 基准逻辑 | ✅ 正确 | `X-Mao-Content-Hash`（内存 bundle）与远端 JSON 往返后重算 hash 完全一致（含 MCP 脱敏 env、二进制 warnings、`configJson`、空 `description`）；跨实例"registry 导出 → URL 导入 → check-updates"得 `changed=false`、`originHash===remoteHash`；远端内容变化 → `changed=true`；systemPrompt 漂移 → `localEdited=true`。见 `__review-verify-round1.spec.ts` 两个对照用例 |
| contentHash 剔除 exportedAt / 键递归排序 | ✅ 正确 | 同上（hash 稳定性）+ 分支自带 `agent-bundle-distribution.spec.ts:23-56` |
| import-from-url 两段式 + origin upsert | ✅ 正确 | confirm=false 不落 origin、confirm=true 落库并写入 hash + systemPrompt 快照；`sourceUrl` 回显在预检与确认两份报告中一致 |
| check-updates 单项失败不阻断 / 并发 4 / 显式无来源 agentId 出 error 项 | ✅ 正确 | 分支自带 `agent-bundle-distribution.spec.ts:368-397` |
| fix-deps 权限边界 | ✅ 正确 | 登录即可、安装目标恒为操作者本人、非共享条目/停用 Agent 拒绝；MCP 三分类（dangling 不动 / 无 mcp:write → needs-admin / 有 → enabled 走 `updateStatus`）与设计 §5.3 一致 |
| registry 路由权限与错误映射 | ✅ 正确 | 开关关闭/未登录 → 404 且不触发展出；token 错误 → 404；query `?token=` 与 `X-Mao-Registry-Token` 双通道放行；Agent 不存在/停用 → 404；导出失败 → 409 非 Result 信封；`PUBLIC_PREFIXES` 前缀精确匹配（`/v1/agent-bundle/registry/`），`import-from-url`/`check-updates` 不在放行范围且均有 `agent:write` |
| skill-bundle 路由权限 | ✅ 正确 | 他人用户技能与系统技能导出需 `skill:read`（403），有则 200；`?owner=<他人>` 分支与缺省 owner 分支都不会泄露他人技能；导入需 `skill:write`；穿越校验先于隐藏段过滤（设计 §5.9 顺序） |
| migration SQL 与仓储 SQL 列名匹配 | ✅ 正确 | V133 `agent_import_origin`（含 `uk_import_origin_agent`）与 `AgentImportOriginRepository` 的全部列一致；`shared_agent_entry.source_url` 与 `SharedAgentEntryRepository.upsert` 的 `VALUES(source_url)` 一致；`Db` 层 `toCamelList` 把 `agent_id/imported_system_prompt` 等映射为 camelCase；迁移号 V133 顺延无冲突 |
| 既有测试语义是否被破坏 | ✅ 未破坏 | 本分支对 `agent-bundle.routes.spec.ts` / `agent-bundle.service.spec.ts` / `shared-agent.service.spec.ts` / `settings.service.spec.ts` 的改动均为构造签名扩展、VO 新增字段与 `putEntry` 参数个数适配，无弱化断言；`npm test` 全绿（242 文件 / 2706 用例） |
| 前后端请求/响应契约 | ✅ 一致 | desktop `api.post('/shared-agents/:id/fix-deps')` → `FixDepsReport{skills,mcpServers,selfCheck}`；admin `/agent-bundle/import-from-url`（confirm=false→报告+sourceUrl、confirm=true→`{agentId,report}`）、`/agent-bundle/check-updates` → `CheckUpdateItem[]`；两端 axios 拦截器均返回 Result 信封、`{data}` 解构一致 |
| 代码质量门 | ✅ 通过 | `backend-ts` tsc、`admin`/`desktop` vue-tsc 均无 error；全量 `npm test` 245 文件 / 2713 用例通过（含本报告 3 个验证 spec） |

## 附 B：审查用临时验证 spec（勿合入，修复落地后删除）

| 路径 | 覆盖 bug | 运行命令 |
|---|---|---|
| `backend-ts/src/agent/__review-verify-round1.spec.ts` | Bug 4（fix-deps 覆盖既有技能）、Bug 5（重复 skillNames 矛盾报告）+ 2 个 hash 基准负面对照 | `cd backend-ts && npx vitest run src/agent/__review-verify-round1.spec.ts` |
| `backend-ts/src/agent/__review-verify-round2.spec.ts` | Bug 1（registry 重复 skillNames → 409，含文件导出对照）、Bug 2（条目 URL 与 origin 错配 → 假 changed） | `cd backend-ts && npx vitest run src/agent/__review-verify-round2.spec.ts` |
| `backend-ts/src/settings/__review-verify-round3.spec.ts` | Bug 3（registry token 解密失败 fail-open） | `cd backend-ts && npx vitest run src/settings/__review-verify-round3.spec.ts` |

三个文件均新建于本次审查、未修改任何既有文件；`cd backend-ts && npm test` 在其存在下同样全绿（245 passed | 1 skipped / 2713 passed | 13 skipped）。

## 附 C：修复优先级建议

1. **Bug 1（P1）**：先修；一行去重即可恢复 registry 可用性，建议与 Bug 5 的去重一并处理（同一数据形态）。
2. **Bug 4（P2）**：数据丢失，建议同批修（目录占用检查）。
3. **Bug 2 / Bug 3（P2）**：提示性功能与安全边界，可次批；Bug 3 若近期有 SETTINGS_SECRET 轮换计划应提前。
