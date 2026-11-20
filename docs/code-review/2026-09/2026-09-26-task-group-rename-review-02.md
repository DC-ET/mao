# 代码审查报告：任务分组右键重命名（第 2 轮复查，2026-09-26）

## 复查范围

第 1 轮报告（`2026-09-26-task-group-rename-review-01.md`）6 项问题的修复情况 + 全部未提交改动回归复查（不含 `FileReferencePanel.vue`）。

## 修复验证

| # | 第 1 轮问题 | 结论 |
|---|------------|------|
| 1 | E2E 种子缺 demo-project 会话 | ✅ 已修。`scripts/e2e-setup.sh` 补 execution_mode 列并新增幂等 INSERT（`WHERE NOT EXISTS`）；本地 MySQL 实测重复执行不产生重复行 |
| 2 | function ref 每次重渲染 focus+select 吞输入 | ✅ 已修。`setGroupRenameInput` 只记引用；focus/select 移到 `startGroupRename` 的 `nextTick`。时序正确：Vue ref 回调在 patch 阶段执行，早于 nextTick 回调 |
| 3 | 前端未截断 50 字符 | ✅ 已修，`renameGroup` trim 后 `slice(0, 50)`，与后端一致 |
| 4 | 两类右键菜单可叠加 | ✅ 已修，`openContextMenu`/`openGroupContextMenu` 入口互斥关闭对方 |
| 5 | 非字符串值单测未覆盖 | ✅ 已修，传入 `123` / `{ nested: true }` 验证剔除 |
| 6 | 不可达 try/catch | ✅ 已修，改为同步逻辑并注明失败路径由 persistPrefs warning 兜底 |

回归验证：backend `npm test` 2191 passed；desktop vitest 172 passed；`vue-tsc -b` 通过；Playwright desktop 27 passed（复跑者执行）。

## 总体结论

**无阻塞 / 重要问题，可合并。** 以下 3 项为低风险建议，不阻塞功能正确性。

---

## 问题列表

### 建议

#### 1. 新增种子 INSERT 被外层「已有 session 则跳过」守卫包住，旧 e2e 环境不会获得 demo-project 会话

- **位置**：`scripts/e2e-setup.sh:143-165`
- **描述**：新的 demo-project INSERT（自身已带 `WHERE NOT EXISTS` 幂等保护）被放在 `if [[ "$existing" != "0" ]] then skip else ... fi` 的 **else 分支内**。对于建库后从未清库的旧 e2e 环境（session 表已有数据），整个种子段被跳过，demo-project 行不会插入。
- **影响**：旧 e2e 环境上跑 Playwright 时 `Task Group Rename` 用例仍会因找不到分组失败。当前环境是重建过的所以通过；CI 或同事本地复用旧库时会踩到。
- **修复建议**：把这段幂等 INSERT 移到 `if/else` 之外（它自带 `NOT EXISTS` 守卫，无条件执行也安全）。

#### 2. 未登录期写入 localStorage 的「仅别名、无顺序」数据，登录后不会被同步到服务端

- **位置**：`desktop/src/composables/useTaskPanelPrefs.ts:124-131`（loadPrefs 的 else 分支）
- **描述**：登录后服务端偏好为空、且 localStorage 只有 `task-group-aliases` 没有 `task-group-order` 时，走 else 分支：`groupAliases.value = readLegacyAliases()` 读入本地别名，但 `scheduleSave()` 仅在 `legacyOrder.length > 0` 时触发——只有别名的场景不会推送到服务端。
- **影响**：别名在本端一直可用（后续任何折叠/重命名操作触发 save 时会一并带上），只是多端同步延迟到下一次偏好变更。极边缘场景，无功能破坏。
- **修复建议**：触发条件补上 `|| Object.keys(groupAliases.value).length > 0`。

#### 3. `writeStringMap` 注释与实现不符

- **位置**：`backend-ts/src/preference/task-panel-preference.service.ts:38`
- **描述**：注释写「空 map 写 '[]'」，实际 `JSON.stringify({})` 写出 `'{}'`。行为正确（`parseStringMap` 两种都能解析，MySQL JSON 列均接受），仅注释误导。
- **修复建议**：修正注释文字为「空 map 写 '{}'」。

## 流程提醒（非代码 bug）

- `CHANGELOG.md` 仍未补本功能的 `0.0.x` 小节（第 1 轮已提醒，属发版前必做项）。
- `skills/mao-cli/reference/pref.md` 的 task-panel 文档未提及新增的 `groupAliases` 字段（`get` 返回值新增了该字段；`set` 命令不传 `groupAliases` 时后端保留已有别名，此行为对 CLI 用户不可见）。按仓库规范建议同步。

## 已检查未发现问题的点

- `startGroupRename` 的 nextTick 焦点时序、Enter/Esc/blur 三路径不再双重提交（confirm 置空 `renamingGroupKey` 后 blur 回调短路）。
- 第二个 E2E 用例改为「未设置」分组断言，与种子 3 条无 workspace 会话匹配；`openGroupContextMenu` 对不可改名分组直接 return，断言 `toHaveCount(0)` 成立。
- 后端 save 的 undefined/`{}` 语义、原始 JSON 透传（`row.groupAliases != null` 分支）、insert/update 双路径均有单测覆盖且通过。
- `resolveGroupLabel`/`formatFallbackGroupLabel` 与原 `formatGroupLabel` 行为等价（含 FEISHU/DINGTALK 合成标签），21 个纯函数单测通过。
- 分组 key 未变，拖拽排序（`sortGroups`/`onDragEnd`）、折叠、过滤、分页、聚焦模式 `workspaceLabel` 均按 key 工作不受影响。
- V122 迁移对存量行（NOT NULL 列隐式 NULL）的读取/写入路径已被 `parseStringMap`/`?? '{}'` 兜住（本地 MySQL 实测）。
