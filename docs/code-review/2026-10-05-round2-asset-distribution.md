# 代码审查报告（第 2 轮）：资产分发闭环 —— 第 1 轮 5 处修复的复审

- 日期：2026-10-05
- 审查对象：提交 `419ca825`（相对第 1 轮 `aedd2feb` 的修复改动）；第 1 轮报告 `docs/code-review/2026-10-05-round1-asset-distribution.md`；设计对照 `docs/plan/2026-10-05-asset-distribution-technical-design.md` §10 决策 10-13
- 范围：仅功能逻辑（backend-ts / admin / desktop），不含文档
- 基线：`cd backend-ts && npm run build`（tsc）通过；`cd backend-ts && npm test` 全绿（Test Files 242 passed | 1 skipped，Tests 2711 passed | 13 skipped，exit=0）
- 结论：**第 1 轮 5 个 bug 的修复全部正确落地，且各自补齐了回归用例；未发现修复引入新 bug**（三条重点疑虑——去重口径是否静默放行、失败闭合是否误伤正常配置、409 是否破坏正常补装流程——均已以可运行断言逐条证伪）。**另发现 1 个第 1 轮未覆盖的新 bug（P2）**：用户技能"列表按 frontmatter 名、get/delete 按目录名寻址"的不一致，使"目录名≠frontmatter 名"的技能在 UI 上不可见详情、不可删除，并直接导致第 1 轮 Bug 4 的修复（`fix-deps` 占用即拒绝）在真实数据下**永久无法人工恢复**。

## 摘要

### 一、5 处修复的复审结论

| # | 修复 | 结论 | 关键证据（`__review-verify-round2b.spec.ts` / `settings/__review-verify-round2b.spec.ts`） |
|---|---|---|---|
| 1 | registry `buildRegistryInlineTokens` + `parseInlineSkillTokens` 双重去重 | ✅ 正确 | 重复 skillNames → registry 200、技能集与文件导出一致；导出→URL 导入→check-updates 得 `changed=false`；不同 userId（`a@8,a@9`）与裸 token（`a,a@8`）仍抛 PARAM_INVALID 且路由层 409 |
| 2 | `checkOneUpdate` 双 URL 基线错配落 error | ✅ 正确 | 不一致项 `changed=false`、`remoteHash=null`、error 含"不一致"，且**零网络请求**（`seenUrls` 精确等于仅一致项那一个 URL）；一致项照常比对 |
| 3 | `getBundleRegistryConfig` 解密失败失败闭合 | ✅ 正确 | 解不开 → `{enabled:false}`（密钥整体缺失同样闭合）；registry 端点 404 且不触发展出；**未误伤**：有效密文照常解密、无 token 但显式开启仍放行、掩码回显与回提交语义不变 |
| 4 | fix-deps 占用检查 + `installUserSkillFiles` 409 | ✅ 正确（但补救路径存在新 bug，见下） | 占用目录 → failed 且原内容逐字节保留、无 `.staging` 残留；无冲突时正常补装 `installed`、落盘正确（409 未破坏正常流程） |
| 5 | `missingNames` Set 去重 + `listAllUserSkills` 提出循环 | ✅ 正确 | 重复 skillNames → 单一 `installed`、无 `ambiguous`、自检缺失清零；真实多归属时 `ambiguous` 语义仍保留（去重未掩盖真实歧义） |

### 二、第 1 轮未覆盖的新问题

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| N1 | P2 | 用户技能列表按 frontmatter 名、`getUserSkill`/`deleteUserSkill` 按**目录名**寻址："目录名≠frontmatter 名"的技能（正常上传即可构造）在桌面/后台列表中可见，但查看与删除必然 404；`fix-deps` 的占用拒绝提示"请先整理该目录"也因此**永久不可达**，该共享 Agent 的技能依赖无法修复 | `__review-verify-round2b.spec.ts` 两个【新问题】用例 |

---

## 新 bug N1（P2）：用户技能 get/delete 按目录名寻址，与列表的 frontmatter 名口径不一致

### 问题描述

用户技能在不同接口使用了**两套寻址口径**：

```ts
// user-skill.service.ts:42-70  listUserSkills：name 取 SKILL.md frontmatter 名，目录名只进 folderPath
voList.push({ name: doc.name, description: doc.description, folderPath: resolve(entry) });

// user-skill.service.ts:95-122  getUserSkill：按 name 重拼目录名
const resolved = this.resolveUserSkillFolder(userId, name);   // → resolve(userDir, name)

// user-skill.service.ts:243-258  deleteUserSkill：同样按 name 重拼目录名
const resolved = this.resolveUserSkillFolder(userId, name);
```

而"目录名≠frontmatter 名"是**正常上传通道可达的状态**：`groupSkillFiles` 按上传路径首段（目录名）分组，`validateSkillGroup`（`user-skill.service.ts:294-302`）只调用 `validateSkillMd` 校验 SKILL.md 自身合法（`skill-md.ts:46-72` 的 `expectedName` 参数仅用于错误文案，**从不与 frontmatter name 比对**）。于是上传一个 `holder/SKILL.md`（frontmatter `name: theirs`）即可落地 `<userDir>/holder/`。

后果链条：

1. 桌面 `SkillManager.vue` 与管理后台的用户技能列表都读 `listUserSkills`/`listAllUserSkills`（frontmatter 名），把该技能展示为「theirs」并渲染查看/删除入口；
2. `SkillManager.vue:345` 的 `GET /user-skills/${skill.name}` 与 `:386` 的 `DELETE /user-skills/${skill.name}` 传的都是 frontmatter 名，服务端经 `resolveUserSkillFolder` 拼出 `<userDir>/theirs`——不存在 → **两侧均 404**；
3. 该技能数据本身完好（`holder/` 还在），但用户在 UI 上既打不开也删不掉，只能停留在列表里；
4. 与第 1 轮 Bug 4 的修复叠加后后果放大：`fix-deps` 命中占用检查时报 `本人已存在同名技能目录「theirs」（其 frontmatter 名为「wrong-name」）……请先整理该目录后重试`（`shared-agent.service.ts:225-232`），但用户要"整理"就必须删除该技能，而删除 404 → **该共享 Agent 的技能依赖永久卡死**，自检持续报缺失。

管理后台同病：`GET/DELETE /v1/admin/user-skills/:userId/:name`（`skill.routes.ts:141,152`）同样把列表给出的 frontmatter 名当目录名用。

### 触发条件

用户（或管理员代上传）上传的技能目录名与 SKILL.md frontmatter `name` 不一致。上传侧无任何拦截，属正常使用路径可达；无并发、无特权要求。

### 涉及文件与行号

- `backend-ts/src/skill/user-skill.service.ts:42-70`（`listUserSkills`：name=frontmatter 名，folderPath=实际目录）
- `backend-ts/src/skill/user-skill.service.ts:95-122`（`getUserSkill` 按 name 拼目录 → 404）
- `backend-ts/src/skill/user-skill.service.ts:243-258`（`deleteUserSkill` 按 name 拼目录 → 404）
- `backend-ts/src/skill/user-skill.service.ts:264-275`（`resolveUserSkillFolder`：`resolve(userDir, name)`）
- `backend-ts/src/skill/user-skill.service.ts:294-302`（`validateSkillGroup` 不校验"目录名==frontmatter 名"，是该状态的准入缺口）
- 前端消费：`desktop/src/components/skill/SkillManager.vue:345`（详情）、`:386`（删除）
- 路由透传：`backend-ts/src/skill/skill.routes.ts:34,47,141,152`
- 与分析直接相关的第 1 轮修复：`backend-ts/src/agent/shared-agent.service.ts:225-232`

### 验证方式

运行：`cd backend-ts && npx vitest run src/agent/__review-verify-round2b.spec.ts`（13/13 通过）

关键断言（第一个【新问题】用例）：

```ts
// 上传通道即可构造"目录 holder、frontmatter 名 theirs"
const uploaded = fx.userSkillService.uploadUserSkill(7, [
  { originalFilename: 'holder/SKILL.md', buffer: Buffer.from(validSkillMd('theirs', '错位技能')) },
]);
expect(uploaded.code).toBe(0);

// 列表可见（frontmatter 名）
expect(fx.userSkillService.listUserSkills(7).map((s) => s.name)).toEqual(['theirs']);
expect(listed[0].folderPath).toBe(join(fx.userSkillService.getUserSkillsDir(7), 'holder'));

// 但按该名查看/删除必然 404：UI 的查看与删除入口全部失效
expect(fx.userSkillService.getUserSkill(7, 'theirs').code).toBe(404);
expect(fx.userSkillService.deleteUserSkill(7, 'theirs').code).toBe(404);
// 管理侧同样（admin 列表来自 listAllUserSkills，传回的仍是 frontmatter 名）
expect(fx.userSkillService.getUserSkill(7, adminRow.name).code).toBe(404);
expect(fx.userSkillService.deleteUserSkill(7, adminRow.name).code).toBe(404);
```

关键断言（第二个【新问题】用例，证明对 fix-deps 修复的影响）：

```ts
// 操作者已占用目录 theirs（frontmatter 名 wrong-name）
const first = await fx.service.fixDependencies(1, OPERATOR);
expect(first.skills[0].action).toBe('failed');
expect(first.skills[0].detail).toContain('请先整理该目录后重试');

// 用户按指引整理：列表给的名字是 frontmatter 名 wrong-name → 删除 404，目录删不掉
expect(fx.userSkillService.listUserSkills(OPERATOR).map((s) => s.name)).toEqual(['wrong-name']);
expect(fx.userSkillService.deleteUserSkill(OPERATOR, 'wrong-name').code).toBe(404);
expect(existsSync(opDir)).toBe(true);

// 再跑补装依旧 failed：依赖永久无法修复
const second = await fx.service.fixDependencies(1, OPERATOR);
expect(second.skills[0].action).toBe('failed');
expect(second.selfCheck.missingSkills).toEqual(['theirs']);
```

### 建议修复方向

两个口径必须统一，方向二选一：

1. **寻址改按 frontmatter 名解析**（推荐，与运行时/SkillSync/导出/导入全链路的"frontmatter 名即技能身份"一致）：`getUserSkill`/`deleteUserSkill` 内先 `listUserSkills(userId)` 找到 `name === 入参` 的条目，用其 `folderPath` 定位；找不到再回落 404。路由层无需改。
2. **源头收敛**（第 1 轮报告已提示的顺带项）：`validateSkillGroup`/`uploadUserSkill` 增加"目录名==frontmatter 名"校验，拒绝错位上传；同时对历史错位数据提供一次按 folderPath 的迁移或管理侧按 folderPath 删除的接口。

无论选哪条，都建议同时让 `fix-deps` 占用失败的 detail 指向一个真正可执行的动作（如给出目录名 `theirs` 与 frontmatter 名，便于管理员按 folderPath 处理）。

### 严重级别

P2（触发条件为正常上传路径可达、无特权要求；后果是数据被"锁死"在列表里（不可查看/删除）+ 共享 Agent 的技能依赖永久不可修复；但不丢数据、不影响其他用户、不影响系统其他部分）

---

## 附 A：复审中验证为"无新 bug"的重点项（负面对照）

| 关注点 | 结论 | 依据 |
|---|---|---|
| 去重口径变化是否让本该报错的场景静默通过 | ✅ 未放行 | `parseInlineSkillTokens` 去重键为 `name@userId`：`a@8,a@8` → 1 个 token；`a@8,a@9`、`a,a@8` → 2 个 token，`exportBundle` 仍抛"指定了多个内联归属"；`buildRegistryInlineTokens` 的多归属分支仍抛 PARAM_INVALID 并经路由层 409；fix-deps 的真实多归属仍出 `ambiguous`（去重只压缩同一技能的重复处理，未压缩跨用户歧义） |
| 失败闭合是否误伤正常配置 | ✅ 未误伤 | 有效密文照常返回 `{enabled:true, accessToken:'my-registry-token'}`；**无 token 但管理员显式开启**仍返回 `{enabled:true, accessToken:null}`（保持"未配置 token 即公开只读"的既有设计语义，没有被失败闭合误收紧成关闭）；开关关闭仍为关闭；掩码+尾4位回显、掩码原样回提交不修改密文等语义不变，其他 secret 键仍统一 `******` |
| 409 拒绝是否破坏正常补装流程 | ✅ 未破坏 | 操作者无冲突目录时 `fixDependencies` 正常出 `installed`、selfCheck 缺失清零、落盘 SKILL.md 正确；409 分支发生在暂存交换之前（无 `.staging` 残留），且只影响"目标目录已存在"这一既有冲突场景 |
| check-updates 阻断是否误伤"URL 一致"的正常比对 | ✅ 未误伤 | 条目 URL 与 origin URL 一致（含无条目、按 origin URL 拉取的缺省路径）时照常拉取、`changed` 与 `localEdited` 判定正确；不一致项零网络请求（`seenUrls` 精确等于一致项那一个 URL），证明阻断发生在 fetch 之前 |
| registry 去重后 hash 基线是否仍可比 | ✅ 可比 | 重复 skillNames 的 Agent：registry 导出 200，其 `contentHash` 与 URL 导入落库的 `origin.content_hash` 完全一致，`checkUpdates` 得 `changed=false`（第 1 轮 P1 的完整闭环已恢复） |
| `missingNames` 去重是否漏装不同名技能 | ✅ 未漏 | Set 只对同名去重；用例中 `good`、`dup` 等不同名技能的候选定位、属主归属、ambiguous 归属列表均与预期一致 |
| 既存 5 个修复的回归用例是否真的守住行为 | ✅ 守住 | 修复提交自带的 `agent-bundle-distribution.spec.ts`（3 例）、`agent-bundle.service.spec.ts`、`shared-agent.service.spec.ts`（占用/重复两例）、`settings.service.spec.ts`（2 例）、`user-skill.service.spec.ts`（409 例）均通过，且断言方向与第 1 轮报告的建议一致 |

## 附 B：本轮审查用临时验证 spec（勿合入，修复落地后删除）

| 路径 | 覆盖 | 运行命令 |
|---|---|---|
| `backend-ts/src/agent/__review-verify-round2b.spec.ts` | 修复 1（含端到端 hash 闭环 + 去重口径边界 + 路由 409/200）、修复 2（含零拉取断言）、修复 4（占用保留/正常补装/409 无残留）、修复 5（单一 installed + 真实歧义保留）、新 bug N1（2 例） | `cd backend-ts && npx vitest run src/agent/__review-verify-round2b.spec.ts` |
| `backend-ts/src/settings/__review-verify-round2b.spec.ts` | 修复 3（失败闭合 + 未误伤正常配置/掩码回显/端到端 404） | `cd backend-ts && npx vitest run src/settings/__review-verify-round2b.spec.ts` |

两个文件均新建于本次审查、未修改任何既有文件；合计 18 个用例全部通过。`cd backend-ts && npm test` 在其存在下同样全绿（244 files / 2729 tests）。

## 附 C：修复优先级建议

1. **N1（P2）**：与第 1 轮 Bug 4 的修复直接耦合（该修复的补救指引当前不可达），建议同批处理；首选方向"寻址改按 frontmatter 名解析"，顺带在 `validateSkillGroup` 收口"目录名==frontmatter 名"，避免继续产生新错位数据。
2. 第 1 轮 5 处修复无需返工；`fix-deps` 占用失败的 detail 文案可在 N1 修复后补充可执行的目录名信息。
