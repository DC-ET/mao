# 个人资产与配置体验补完（P1 会话审批规则 / P2 环境变量免重填 / P3 设置页搜索）代码审查报告

- 审查日期：2026-11-03
- 需求方案：`docs/plan/2026-11-03-personal-assets-ux-completeness-technical-design.md`
- 审查范围：`git status` 中未提交改动（仅代码；CHANGELOG.md / README.md / docs/** 按要求未审）
- 结论：**存在 1 个功能 bug（重要 1 项），建议修复后合并**
- 验证方式：新增临时 vitest 用例（已验证、随后删除，工作区无残留）；复用现有 approval-rule / env / memory 三个域共 11 个 spec（169 tests 全通过）；`backend-ts` `tsc` 构建通过；`desktop` `npm run build`（vue-tsc + vite）通过；前端无单测部分按构建 + 人工推演 + 对照 element-plus 行为核验

---

## 一、重要（1 项）

### I-1 `MemoryService.list` 丢弃 `keyword`：长期记忆关键词搜索全程无效（后端三层接缝漏通）

- 位置：
  - `backend-ts/src/memory/memory.service.ts:77-89`（`list()`，第 78 行 `filter` 只挑 `scope / projectKey / status` 三个字段，未含 `keyword`）
  - 对照：`backend-ts/src/memory/memory.routes.ts:67`（路由已正确解析 `keyword`）、`backend-ts/src/memory/memory.repository.ts:198-204`（`buildFilter` 已实现 keyword LIKE 分支）、`desktop/src/views/settings/MemoryView.vue:206-232`（前端防抖后已透传 `keyword`）
- 问题描述：
  P3 的记忆搜索链路四段都写了代码，但 service 层断链：
  1. 桌面 `MemoryView` 输入关键词（300ms 防抖）→ `listMemories({ keyword })` → `GET /v1/memory?keyword=vitest`；
  2. 路由 `listQuery` 正确解析出 `keyword: 'vitest'` 并传给 `memoryService.list`；
  3. `MemoryService.list` 第 78 行用**白名单式挑字段**的方式重建 filter：`{ userId, scope, projectKey, status }`——`keyword` 在此被丢弃，传给 `repo.page` / `repo.count` 的对象里没有 `keyword`；
  4. 仓储 `buildFilter` 的 keyword LIKE 分支（含 `escapeLike` 转义、`ESCAPE '\\'`）因此永不触达。
  最终 SQL 与不带关键词时完全一致（`WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`），即：**搜索框输入任何关键词都返回未过滤的分页结果**，`total` 也是全量计数，`MemoryView` 的「无匹配记忆」空态几乎不可能出现，用户搜索不到目标记忆。技术方案 §4.5 / D8 明确要求「服务端过滤」，该功能实际未生效。
- 为何现有测试全部通过（漏测原因）：三层各自有用例但接缝无用例——`memory.routes.spec.ts` 的 `listPassesKeywordFilter` 只断言 `service.list` **收到** keyword（mock service，通过）；`memory.repository.spec.ts` 的 `pageKeywordFiltersContentOrProjectKeyWithEscapedWildcards` 只断言 `buildFilter` **收到** keyword 时生成正确 SQL（直接调仓储，通过）；没有任何用例覆盖「路由 → 真实 service → 真实仓储」的贯通调用。
- 复现 / 验证（临时用例，均已在当前代码上失败后删除）：
  1. service 层直测（mock 仓储）：
     ```ts
     const service = new MemoryService(mockRepo, { listProjectKeyRows: async () => [] });
     await service.list(7, { keyword: 'vitest', page: 1, pageSize: 20 });
     // 期望 repo.page / repo.count 入参含 keyword: 'vitest'
     // 实测：expected undefined to be 'vitest'（入参无 keyword 字段）
     ```
  2. 端到端直测（真实 `MemoryService` + 真实 `MemoryRepository` + mock Db，走真实路由）：
     ```ts
     const repo = new MemoryRepository(mockDb);
     registerMemoryRoutes(app, { memoryService: new MemoryService(repo, { listProjectKeyRows: async () => [] }) });
     await app.inject({ method: 'GET', url: '/v1/memory?keyword=vitest&page=1&pageSize=20' });
     // 期望捕获到的 SELECT SQL 含 LIKE、参数含 'vitest'
     // 实测：expected 'SELECT * FROM `memory_item` WHERE use…' to contain 'LIKE'
     ```
- 影响面：设置页「长期记忆」搜索功能完全失效（P3 三项子功能之一）；管理员侧 `listForAdmin` 同样走 `list()`，若将来给 admin 记忆列表加关键词也会静默失效。`GET /v1/memory` 的 API 契约（`keyword` 参数）对外已发布，调用方按契约传参会得到错误结果。
- 修复方向（供后续执行，本次未改码）：
  - `memory.service.ts:78` 的 `filter` 增加 `keyword: query.keyword ?? null`（与 `scope / projectKey / status` 同列）；
  - 补一条 service 层用例：`service.list` 透传 keyword 到 `repo.page` / `repo.count`，或补一条「路由 → 真实 service+repo → 断言 SQL 含 LIKE」的贯通用例，堵住接缝。

---

## 二、审查过未发现问题的部分（覆盖说明）

- **P1 后端**：`removeUserRule` 放宽后仍硬校验 `row.userId === userId`（他人规则 3037，spec 覆盖）；`PATCH` 仍走 `findOwnedUserRule` 仅限 USER；`promoteSessionRule` 归一化幂等、denylist 拒绝（3038）、`findByUserAndValue` 同值幂等、复制语义不删原规则、非 SESSION 报 2001，均与方案 D2/D3/D4 一致；`listByUser` 改 `LEFT JOIN session` 后与 `countByUser` 口径一致（JOIN 不改变行数，`session.id` 唯一无扇出）；promote 路由审计与 `requirePathId` 边界（0/负/非整数 → 3037）正确；会话删除会物理删 SESSION 规则（`session.service.ts:595-603`），来源会话跳转探针 `GET /v1/sessions/:id` 带属主校验且 `findById` 过滤 `deleted = 0`，「来源会话已删除」提示路径成立。
- **P2 后端 + 桌面**：`buildPatch` 仅对非空字符串加密覆盖，未传 / null / 空串保留原密文；空 patch 时 `updateBy` 原有 `columns.length === 0 return` 防御仍在；桌面 `EnvVariablesView` 与 `EnvVarsDrawer` 编辑态 `canSubmit` 不再要求重填、提交体空串不下发 `envValue`（axios 会丢弃 `undefined` 字段）、编辑态变量名输入框 `disabled` 故不下发 `envKey` 无副作用；admin `ShellEnvVarsPanel` 的 `canSubmit` 仍要求编辑时重填值，后端放宽不影响其行为（无回归）。
- **P3 桌面前端**（无单测，经 `npm run build` + 人工推演 + element-plus 行为核对）：`ApprovalRulesView` 搜索态 `watch(keyword)` 仅在空↔非空切换时重拉（`pageSize=100`），输入过程只走前端 `ruleValue` 过滤，分页在搜索态隐藏、退出时回第 1 页；scope 二级 Tab 与 type Tab、关键词三者叠加时拉参口径正确（`searching` 时恒 `page=1&pageSize=100`）；`MemoryView` 防抖定时器在 `onBeforeUnmount` 清理，`router.push('/tasks/${id}')` 与路由表 `tasks/:sessionId` 匹配；`CommandManager` 按 `name + content` 即时过滤、空态区分正确；两处 `来源 #id` / `来自会话` 链接均先 `getSession` 探测再跳转。
