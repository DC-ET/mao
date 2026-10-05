# 代码审查报告（第 3 轮）：重名技能寻址口径 —— 第 2 轮 N1 修复的复审与新 bug 修复

- 日期：2026-10-05
- 审查对象：提交 `b7dfdedf`（第 2 轮 N1 修复）；本轮修复追加于其上（未单独提交，见文末 diff 摘要）
- 第 2 轮报告：`docs/code-review/2026-10-5-round2-asset-distribution.md`；第 1 轮报告 `docs/code-review/2026-10-05-round1-asset-distribution.md`
- 设计对照：`docs/plan/2026-10-05-asset-distribution-technical-design.md` §10 决策 16（用户技能寻址改按 frontmatter 名）
- 范围：仅功能逻辑（backend-ts / admin / desktop），不含文档
- 基线：`cd backend-ts && npm run build`（tsc）exit=0；`cd backend-ts && npm test` 全绿（Test Files 242 passed | 1 skipped，Tests 2715 passed | 13 skipped，exit=0）；`cd admin && npx vue-tsc -b` exit=0；`cd desktop && npx vue-tsc -b` exit=0

## 摘要

### 一、N1 修复本身的复审结论

N1 的修复方向（`getUserSkill`/`deleteUserSkill` 改经 `listUserSkills` 的 `folderPath` 按 frontmatter 名寻址）**语义正确、无回归**：A1–A5 全部以可运行断言正面证实——正常技能照常命中、错位技能（目录 `holder`/frontmatter 名 `theirs`）可查看可删除、按目录名传入仍兼容（后端回归有载）、不存在的名 404、路径穿越/空串/隐藏段 400、前缀名（`dup` vs `dup-extra`）不做子串误命中、跨用户不串目录、admin `listAllUserSkills` 聚合行与 `getUserSkill(row.name)` 自洽。

### 二、复审中发现的新 bug（本轮已修复）

| # | 级别 | 一句话摘要 | 验证 |
|---|---|---|---|
| N2 | **P1** | `resolveUserSkillFolderByName` 用 `skills.find(...)` 取首个命中：同一用户存在**两个 frontmatter 名相同的技能目录**（正常上传即可构造，`validateSkillGroup` 不查重）时，按名删除**删错对象**——UI 删第二行实际删第一个目录，且返回 `code:0` 误报已删除 | `user-skill.service.spec.ts` 新增用例「重名技能…按名寻址失败闭合 409：不误删首个，可按 folderPath 精确删」 |
| N3 | **P2** | 上述歧义使第 2 轮 N1 刚建立的**人工恢复闭环被打断**：`fix-deps` 占用指引让用户"删除 frontmatter 名为 X 的技能"，而按 X 删除命中另一个目录 → 占用状态不消失、重试永远失败，用户还已误删一个无关技能 | `shared-agent.service.spec.ts` 既有闭环用例 + 本轮指引文案改为目录级双标识 |

### 三、修复方案

**失败闭合 + 显式精确寻址**，不在服务端猜用户意图：

1. `resolveUserSkillFolderByName` 增加 `folderPath` 可选入参（列表行级下发）：
   - 传入时按**绝对路径全等**寻址。不用目录 basename 兜底——那会把他人用户的同目录名配进来造成跨用户串删（本轮以回归断言证伪：传入他人 folderPath → 404 且双方目录均不动）。
   - 未传时维持按名寻址，但命中多个目录即 `409` 失败闭合，message 列出全部候选目录及其展示名，引导按行「路径」删除。
2. 路由透传：`GET/DELETE /v1/user-skills/:name` 与 admin 侧 `GET/DELETE /v1/admin/user-skills/:userId/:name` 均接受可选 query `?folder=`（`queryOptStr`）。
3. 前端按行传自身 `folderPath`：`desktop/SkillManager.vue` 的查看与删除、`admin/SkillListView.vue` 的查看与删除。admin `UserDetailDrawer` 只列不删，无需改。
4. `fix-deps` 占用指引改为**目录级双标识**（`目录「name」` + `frontmatter 名为「occupied.name」`）：只说 frontmatter 名在重名时不可寻址（正是 N2）；只说目录名又回到 N1 的 404。当本人存在多个同名展示名时追加"请按列表该行『路径』定位，勿删错"。

### 四、影响面与不做的事

- **不改变"重名技能不可内联导出"的既有决策**（第 1 轮已由 `parseInlineSkillTokens`/`buildRegistryInlineTokens` 全等去重 + registry/文件导出一致性回归覆盖；`agent-bundle.service.spec.ts`「同一用户存在多个同名技能目录 → PARAM_INVALID」与 distribution spec「同名多归属技能 → PARAM_INVALID」本轮重跑仍绿）。
- **运行时与 SkillSync 不做收紧**：重名目录在运行时按名键天然只挂一个（既有语义），本批改动只保证"写盘侧不被误删、读/删侧不猜"。
- **上传侧不加查重拒绝**：会造成历史可上传的技能突然 409 被挡，超出本次缺陷修复范围；以"寻址失败闭合 + 引导整理"收敛。

## 回归用例清单（本轮新增）

| 文件 | 用例 | 断言要点 |
|---|---|---|
| `backend-ts/src/skill/user-skill.service.spec.ts` | 重名技能（两个目录同一 frontmatter 名）按名寻址失败闭合 409：不误删首个，可按 folderPath 精确删 | 按名 get/delete 均 409 且两目录原样；按 second folderPath delete 只删第二行；删剩一个后按名恢复 0 |
| `backend-ts/src/skill/user-skill.service.spec.ts` | folderPath 精确寻址不串用户、不串目录 | 传他人 folderPath → 404 且双方目录均不动；传本用户不存在目录 → 404 |

（第 1/2 轮的闭环用例——占用失败后按展示名删除再重试得 `installed`——本轮重跑确认未被打断。）

## 全量自测

- `cd backend-ts && npm run build` → exit=0
- `cd backend-ts && npm test` → Test Files 242 passed \| 1 skipped；Tests 2715 passed \| 13 skipped；exit=0
- `cd admin && npx vue-tsc -b` → exit=0
- `cd desktop && npx vue-tsc -b` → exit=0
