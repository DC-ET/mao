# 代码审查报告：任务分组重命名全量放开（方案 A，2026-09-28）

## 审查范围

本次未提交改动（按方案 A：全部分组 key 均可右键重命名，`isGroupRenameable` 前后端仅拒绝空 key）：

- `backend-ts/src/preference/task-panel-preference.service.ts` + `task-panel-preference.service.spec.ts`
- `desktop/src/utils/cloud-project.ts` + `cloud-project.test.ts`
- `desktop/src/components/task/TaskIndexPanel.vue`
- `CHANGELOG.md`、`docs/plan/*`、`skills/mao-cli/reference/pref.md`（仅作背景，不作为问题来源）

## 验证情况

- `cd backend-ts && npm test`：2272 passed / 13 skipped，全部通过。
- `cd desktop && npx vitest run src/utils/cloud-project.test.ts`：23 passed。
- 功能链路（右键门禁、`resolveGroupLabel` 别名优先、tooltip/预填带 session）手工推演与单测一致。

## 总体结论

前后端 `isGroupRenameable` 规则已对齐（仅拒绝空白 key），`normalizeAliases` 不再剔除系统桶与渠道分组，`resolveGroupLabel` 全量读别名，tooltip / 重命名预填均已带上 session，飞书/钉钉推导名可正确显示。**核心业务逻辑正确。** 发现 1 个会阻断 E2E 的遗留断言问题。

---

## 问题列表

### 重要

#### 1. E2E 用例仍断言「未设置」分组不可改名，与方案 A 冲突，必然失败

- **位置**：`tests/desktop.spec.ts:582-591`（`should not offer rename for non-renameable groups`）
- **描述**：用例注释与断言仍按旧规则编写——种子里 3 条无 workspace 的 LOCAL 会话落入 `LOCAL:未设置` 分组，右键后要求「重命名」菜单项 `toHaveCount(0)`。方案 A 下 `isGroupRenameable('LOCAL:未设置')` 已返回 `true`（`cloud-project.ts:147-148`），右键菜单**必然出现**「重命名」（`TaskIndexPanel.vue:462`），断言失败。本次改动同步更新了前后端单测矩阵，但漏改了这条 E2E。
- **影响**：`npm test`（Playwright）中该用例必红；且用例名/注释（「不可改名」）与新语义相反，会误导后续维护者认为系统桶仍被锁定。CI 虽不跑 Playwright，但本地/发版前回归会被挡住。
- **修复建议**：按方案 A 重写该用例，例如改为断言「未设置」分组右键**存在**「重命名」，并走一遍改名/重置；或删除该用例（已无「不可改名」分组）。「任务分组右键重命名」另一条用例（demo-project）本身与新语义兼容，无需改动。

### 已检查未发现问题的点

- 前后端 `isGroupRenameable` 规则一致（`key.trim().length > 0`），注释互相锚定；`normalizeAliases` 对空白 key / 空值的剔除与 50 字符截断行为正确，单测已覆盖系统桶与 `FEISHU_*` / `DINGTALK_*` 写入。
- `resolveGroupLabel` 现对全部非空 key 生效「别名 > 推导名」，空白别名回落推导名；`LOCAL:未设置` / `CLOUD:临时工作区` / 渠道分组的 fallback 推导逻辑未被改动。
- `groupAliasTooltip` 传 `group?.sessions?.[0]`、`startGroupRename` 预填走 `group.label`（与分组头同源、带 session），飞书/钉钉不会再显示「未知 Agent」；`resolveGroupLabel(key, {})` 用于 tooltip 时只会取推导名，不会把别名拼进括号，语义正确。
- `renameGroup` / `resetGroupAlias` / 空值等价重置、300ms 防抖 PUT、冲突合并链路本次未改，行为保持。
- 别名仅影响显示，不改分组 key、排序、折叠、会话归属，与设计目标一致。

---

## 备注（非缺陷）

- 设计文档 `2026-09-28-task-group-rename-unlock-all-design.md` 推荐方案 B、并建议保留「未知 key 拒绝」；本次按需求明确采用方案 A 且仅拒绝空 key，`UNKNOWN_KEY` 类垃圾 key 也能写入别名 map。属已确认的产品取舍，不记为缺陷；若后续偏好 map 膨胀可再收紧。
