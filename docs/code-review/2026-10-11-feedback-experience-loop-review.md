# 负反馈闭环（Feedback → Experience）代码审查报告

- **日期**：2026-10-11
- **分支 / 提交**：`feat/feedback-experience-loop` @ `4f4c70c2`，工作区含 15 个 M + 6 个 ?? 未提交改动（本报告审查范围即这些未提交文件）。
- **设计基准**：`docs/plan/2026-10-11-feedback-experience-loop-technical-design.md`。
- **范围**：仅功能代码（后端 5 个改动源文件 + 2 个新文件 + 2 个迁移 + 前端 2 个 Vue 文件）；文档变更不纳入 bug 判定。
- **方法**：通读源码后出题，每条候选都用临时 Vitest 探针实跑复现（探针只新建临时 spec 文件、跑完即删，未改动任何产品源码与既有 spec）。基线已复核：`vitest run src/feedback src/session/run-trace.service.spec.ts` 6 files / 149 tests 全绿，`tsc -p tsconfig.build.json --noEmit` exit 0。
- **复审记录**：见文末「第二轮复审（2026-10-11，针对三条建议的修复）」。第一轮结论与问题描述保持原样，便于对照修复前后的差异。

---

## 一、总体结论（第一轮）

**可以合并，无阻塞项（0 阻塞 / 0 重要 / 3 建议）。**

本次改动的事务与 CAS 语义、状态机、权限码、路由边界、起草服务的解析/纠错/用量、run-trace 定位口径、前端向导与批量流程，经逐项实跑验证均正确，未发现会导致功能错误或数据不一致的可触发 bug。

3 条「建议」级问题都不改变当前功能行为：两条是契约/提示语层面的口径漂移（均有前端规避或无实际调用方触发），一条是极低概率的字符截断瑕疵。均可在合并前或后续小版本处理。

---

## 二、问题列表

### SUGGEST-1【建议】`buildDetailWhere` 的 `agentId: null` 语义与 service 契约不符（实际退化为「不筛选」）

> **状态：已于第二轮复审确认修复**（`agentId` 三态：`undefined` 不筛 / `null` 筛 `IS NULL` / 具体 id 等值）。修复详情与验证见文末「6.1」。以下为第一轮原始记录。

**位置**：`backend-ts/src/feedback/feedback.repository.ts:249-268`（`buildDetailWhere`，具体在 `if (filter.agentId != null)` 这一分支）

**问题描述**：`FeedbackService.listDetails` 的签名与 spec 明确把 `agentId: null` 定义为「筛选无 Agent 的飞书点踩」（`feedback.service.ts:306-315` 的类型签名 `agentId?: number | null`，`feedback.spec.ts:297-299` 的注释「agentId 允许为 null（筛选「无 Agent」的飞书点踩）」），但仓储层 `if (filter.agentId != null)` 遇到 `null` 时**不追加任何条件**，SQL 变成无 `agent_id` 限定的全表查询——即「筛无 Agent」实际执行成了「不筛 Agent」。二者只能二选一：要么仓储生成 `f.agent_id IS NULL`，要么从签名去掉 `null` 并同步修 spec 注释。

**触发场景**：直接以 `agentId: null` 调 `service.listDetails(...)` 或 `repository.countTotal({ agentId: null })` / `listDetails({ agentId: null })`。当前两个真实调用方都不会触发：
- 路由层 `parseAgentId(query.agentId, false)`（`feedback.routes.ts:66-77`）对空值返回 `undefined` 而非 `null`；
- 前端 `FeedbackView.vue:564 / :574` 的 `filters.agentId = agentId ?? undefined` 也是显式规避。
所以这是**契约漂移 + 潜在误用风险**，不是当前可复现的功能错误。

**影响**：契约与实现不一致，后续任何按 spec 契约传 `null` 的调用方（新接口、脚本、未来二次开发）会静默拿到全表数据，`countTotal` 与 `listDetails` 的 total 也会不一致（total 是全表、items 是分页后的全表子集，看起来像分页错乱）。

**建议修法**：在 `buildDetailWhere` 中区分 `undefined`（不筛选）与 `null`（筛 `agent_id IS NULL`）：
```ts
if (filter.agentId === null) {
  conditions.push('f.agent_id IS NULL');
} else if (filter.agentId !== undefined) {
  conditions.push('f.agent_id = ?');
  params.push(filter.agentId);
}
```
或从 `FeedbackDetailFilter.agentId` 与 `listDetails` 签名中去掉 `null`，并同步修正 `feedback.spec.ts:297-299` 的注释与断言。

**验证测试（临时探针，已跑完删除）**：

```ts
// backend-ts/src/feedback/zz-review-probe-a.spec.ts（节选）
function makeCaptureDb() {
  const captured: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => { captured.push({ sql, params }); return []; }),
    queryOne: vi.fn(async (sql: string, params: unknown[] = []) => { captured.push({ sql, params }); return { c: 1 }; }),
    execute: vi.fn(async (sql: string, params: unknown[] = []) => { captured.push({ sql, params }); return { affectedRows: 1 }; }),
  };
  return { repo: new FeedbackRepository(db as never), captured };
}
it('countTotal agentId=null 时是否追加条件', async () => {
  const { repo, captured } = makeCaptureDb();
  await repo.countTotal({ agentId: null });
  console.log('SQL:', captured[0].sql, 'params:', JSON.stringify(captured[0].params));
});
```

实跑输出：
```
[A1] countTotal agentId=null SQL: SELECT COUNT(*) AS c FROM message_feedback f 
[A1] params: []
[A2] countTotal agentId=undefined SQL: SELECT COUNT(*) AS c FROM message_feedback f 
[A3] countTotal agentId=5 SQL: ... WHERE f.agent_id = ? params: [5]
```
`agentId=null` 与 `undefined` 生成的 SQL 完全一致（均无 agent 条件），证实 null 被当成「不筛选」。

---

### SUGGEST-2【建议】draft 与 convert 对「id 不存在」的错误码不一致

> **状态：已于第二轮复审确认修复**（convert 预校验二拆分为 `PARAM_INVALID` / `FEEDBACK_ALREADY_HANDLED` 两个分支）。修复详情与验证见文末「6.2」「6.3」。以下为第一轮原始记录。

**位置**：
- `backend-ts/src/feedback/feedback.service.ts:332-334`（`buildDraftContext`：`rows.length !== ids.length` → `PARAM_INVALID`「部分反馈记录不存在」）
- `backend-ts/src/feedback/feedback.service.ts:274-283`（`convertToExperience` 预校验二：同一判定 → `FEEDBACK_ALREADY_HANDLED`）

**问题描述**：同一「传入 id 在表中不存在」的失败路径，draft 报 `PARAM_INVALID(2001)`「部分反馈记录不存在」，convert 报 `FEEDBACK_ALREADY_HANDLED(3046)`「该反馈已被处理，请刷新后重试」。技术方案 §5.5 与审查方向 3 明确要求「id 不存在与已处理两种失败路径的错误码一致性」。convert 的提示语对「id 根本不存在」具有误导性（用户会以为是被别人处理了）。

**触发场景**：管理员在已打开的向导里，另一会话/脚本删除了对应反馈行（或手工构造请求传了不存在的 id），点「重新生成」得到 2001、点「确认写入」得到 3046。

**影响**：仅提示语与错误码口径不一致，不影响状态正确性（两个分支都不写任何数据，均实测 `db.log` 为空）。属于可观测性/一致性问题。

**建议修法**：让 convert 的预校验二也区分两种情形——`rows.length !== feedbackIds.length` 时抛 `PARAM_INVALID`（或新增 `FEEDBACK_NOT_FOUND`），`rows.length` 相符但存在非 PENDING 行时才抛 `FEEDBACK_ALREADY_HANDLED`。draft 侧保持不变。

**验证测试（临时探针，已跑完删除）**：

```ts
// backend-ts/src/feedback/zz-review-probe-d.spec.ts（节选）
// listByIds 只返回库中真实存在的行（模拟「id 不存在」）
it('draft / convert 传不存在 id 的错误码', async () => {
  const { db } = makeDbWithRows([{ id: 1, status: 'PENDING', agentId: 2, messageId: 11, sessionId: 5, reason: 'WRONG_RESULT' }]);
  const service = new FeedbackService(new FeedbackRepository(db as unknown as Db), makeLookup(),
    async () => 9, async () => 2, db as unknown as Db, runTrace(), async () => true);
  try { await service.buildDraftContext([1, 42]); } catch (e) {
    console.log(`[D1] draft 不存在 id → code=${(e as BusinessException).code} message="${(e as BusinessException).message}"`);
  }
  try { await service.convertToExperience(9, { feedbackIds: [1, 42], agentId: 7, experiences: [{ content: '一条经验内容。' }] }); } catch (e) {
    console.log(`[D2] convert 不存在 id → code=${(e as BusinessException).code} message="${(e as BusinessException).message}"`);
  }
});
```

实跑输出：
```
[D1] draft 不存在 id → code=2001 message="部分反馈记录不存在"
[D1] log: []
[D2] convert 不存在 id → code=3046 message="该反馈已被处理，请刷新后重试"
[D2] log: []
```
同一输入（id 42 不存在）两种错误码，确认不一致。

---

### SUGGEST-3【建议】`truncate()` 按 UTF-16 码元截断，可能把代理对切成孤立码元

> **状态：已于第二轮复审确认修复**（改为按 Unicode 码点截断，`Array.from`）。修复详情与验证见文末「6.4」。以下为第一轮原始记录。

**位置**：`backend-ts/src/feedback/experience-draft.service.ts:296-298`（`truncate` → `text.slice(0, max)`）

**问题描述**：`String.prototype.slice` 按 UTF-16 码元计数，当截断点恰好落在代理对中间时会产生孤立高位代理，进入 prompt 的是乱码（JSON 序列化后形如 `"\ud83d…"`）。

**触发场景**：轨迹 `target`（`MAX_TRACE_TARGET_CHARS = 120`）或用户原话 / 回复（1000 / 2000 字）在截断边界上正好落在一个 emoji、CJK 扩展 B 等非 BMP 字符的中间。

**影响**：极低。trace target 里出现超长 emoji/CJK 扩展字符串的概率很小，且后果只是模型收到一个乱码字符，不影响流程与状态。已知同类实现 `previewOf`（run-trace）与 `buildPreview` 有同样特征，属既有约定。

**建议修法**：若在意，可改为按码点安全截断：
```ts
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = [...text].slice(0, max).join('').length; // 或直接用 Array.from 取前 max 个码点
  return `${[...text].slice(0, max).join('')}…`;
}
```
（注意这会改变「字数」口径为码点数，需同步评估 `MAX_TRACE_TARGET_CHARS` 等常量的语义。）

**验证测试（临时探针，已跑完删除）**：

```ts
// backend-ts/src/feedback/zz-review-probe-g2.spec.ts（节选）
function makeRun(target: string): RunTraceVO { /* 单工具 run，target 由参数给定 */ }
it('emoji 长串截断点', () => {
  const text = serializeRunTrace(makeRun('echo ' + '😀'.repeat(200)));
  const line = text.split('\n')[0];
  const idx = line.indexOf('…');
  const last = line.slice(0, idx).slice(-1);
  console.log('省略号位置:', idx, '前一字符 codepoint=0x' + last.charCodeAt(0).toString(16),
    '孤立高位代理?', last.charCodeAt(0) >= 0xd800 && last.charCodeAt(0) <= 0xdbff);
});
it('CJK 扩展 B 字符（U+20000）截断', () => {
  const text = serializeRunTrace(makeRun('echo ' + '\u{20000}'.repeat(100)));
  const line = text.split('\n')[0];
  const last = line.slice(0, line.indexOf('…')).slice(-1);
  console.log('前一字符 codepoint=0x' + last.charCodeAt(0).toString(16),
    '孤立高位代理?', last.charCodeAt(0) >= 0xd800 && last.charCodeAt(0) <= 0xdbff);
});
```

实跑输出：
```
[G2-1] 省略号位置: 128 前一字符 codepoint=0xd83d 孤立高位代理? true
[G2-1] 尾部 JSON: "\ude00😀\ud83d… [S"
[G2-2] 前一字符 codepoint=0xd840 孤立高位代理? true
```
emoji 与 CJK 扩展 B 两种字符都被切成孤立高位代理（0xd83d / 0xd840），证实存在。

---

## 三、已验证无问题的高风险点清单

以下均以实跑探针或既有 spec 复核确认，未发现问题。

### 事务与并发（`feedback.service.ts` convert / dismiss）
- `db.transaction` 内新建 `new FeedbackRepository(tx)` / `new MysqlAgentExperienceRepository(tx)` 正确（`Db.transaction` 把连接包成新 `Db`，`db.ts:65-79`）；事务内仓储用的就是 tx。
- CAS 先行：`cas:CONVERTED` 一定早于 `insert:`（既有 spec `feedback-convert.spec.ts` 断言 `log.indexOf('cas...') < log.indexOf('insert:100')`）。
- 影响行数与传入数量不符即抛 `FEEDBACK_ALREADY_HANDLED` 并回滚；内存 fake 的并发用例（`Promise.allSettled` 两个 convert）实测 1 成功 1 失败、经验条数不翻倍。
- 预校验（agentId 存在、反馈存在且 PENDING、内容 ≤300 字）全在事务外，实测三种预校验失败时 `db.log` 均为 `[]`（未开事务）。
- `normalizeBatchIds` 去重后 CAS 数量口径正确（重复传 `[1,1,1]` → `cas:CONVERTED:1/1`，不误判为并发冲突）。
- 批量全或无：混入已处理行时整体失败，第一行也不被写。
- `experience_id` 只记第一条（设计 §5.2 决策 16）。
- `bindExperience` 不校验 `status`，但它只在 CAS 已成功的事务内调用，无越权改写风险。

### SQL 正确性
- V148：4 列 + `idx_feedback_pending(status, agent_id, reason, created_at)`，存量行由列默认值回填 PENDING（与 V125 `source` 同款），无需订正。
- V149：`INSERT ... WHERE NOT EXISTS` + `INSERT IGNORE ... SELECT 1, id FROM permission WHERE code='feedback:write'`，与 V121/V118 惯例一致。
- `buildDetailWhere`：`reason` / `status` / 日期条件与表别名 `f` 匹配（既有 repository spec 逐条断言）；`endDate` 用 `DATE_ADD(?, INTERVAL 1 DAY)` 半开区间正确。
- `countPendingGroupBy`：`GROUP BY f.agent_id, a.name, f.reason WHERE status='PENDING'`，快照口径不 JOIN session，`agent_id IS NULL` 的飞书行单独成组。
- `sameGroupCount` 子查询：`g.agent_id <=> f.agent_id AND g.reason = f.reason AND g.status = 'PENDING'`，用 `<=>` 兼容 NULL，口径与矩阵一致（探针 A6 实测子查询文本正确）。
- `listDetails` 的 4 个 LEFT JOIN（user / user(hu) / agent / message）与 camelCase 行键映射（`mapDetailRow`）正确；`asStatus` / `asSource` 兜底不影响新列。

### 状态机与错误码
- PENDING → CONVERTED / DISMISSED 四列 / 三列写入正确；重复 convert / dismiss 均抛 `FEEDBACK_ALREADY_HANDLED`；终态不可回退。
- 已 CONVERTED 的行再 draft → `FEEDBACK_ALREADY_HANDLED`（探针 B5 实测）。
- 路由层：`parseIds` 对非数组 / 空数组返回 `PARAM_INVALID`（探针 E3 实测 service 调用次数 0）；`parseAgentId(required)` 对缺失 / 0 / 负数 / 1.5 均拒绝（探针 E5 实测），`'8'` 字符串正确解析为 8。
- `experiences` 缺失 `content` → 透传 `content: ''`，由 service 的 `normalizeExperienceContent` 抛 `AGENT_EXPERIENCE_CONTENT_INVALID`（探针 E4 实测路由层放行、service 层拦截）。
- service 抛非 `BusinessException` 时由全局 `handleError` 兜底为 500 + 5001，口径一致（探针未构造，读代码确认；既有 routes spec 已覆盖 `BusinessException` 路径）。

### 起草服务（`experience-draft.service.ts`）
- 模型解析：`feedback.draftModelId` 未配置 / 不存在 / 非法值均回落 `resolveModel(null)`；都无则 `MODEL_NOT_FOUND`（既有 spec 覆盖）。
- 用量：`record(operatorId, null, model.id, SCENE_FEEDBACK_EXPERIENCE_DRAFT, usage, success)`，userId 记操作管理员；纠错场景落两行（既有 spec 断言）。
- 超时走 `cancelFlag`，抛 `LLM_TIMEOUT`；普通失败抛 `LLM_CALL_FAILED`（既有 spec 用 fake timers 覆盖）。
- JSON 解析：单围栏可剥离；**带前缀说明文字或多个围栏**→ 判「输出不是合法 JSON」→ 走一次纠错 → 二次仍失败抛 `LLM_CALL_FAILED`（探针 G4/G5 实测），符合设计 §5.4「一次纠错、不降级」。
- 脱敏：`isSensitive` 命中 `.env` / `.pem` / `token.txt` → `[sensitive]`（既有 spec 覆盖）。
- 超长轨迹只保留最后 60 行（探针 G3 实测行数 61 = 1 提示行 + 60 行）。
- 长命令截断：120 字符 + `…`，整行 146 = 前缀 8 + 121 + 后缀 19（探针 G2 实测）。
- **shell 命令内明文密钥进 prompt**：`curl -H "Authorization: Bearer sk-xxx"` 会原样进 prompt——技术方案 §9 风险 1 已明确记录且「评审已确认接受」，**不算本次引入的 bug**，此处仅作已知风险提示，不建议在本次改动内处理。

### run-trace 定位（`locateRunByMessageId`）
- 与 `buildTrace` 同口径：复用 `selectUserStamps` / `selectRange` / `selectBySessionWindow` / `selectBySessionAll` / `attributeActivities` / `buildRun` / `indexRunMessages`，既有 spec 用 `toEqual(page.runs[0])` 逐字段钉住一致。
- 边界场景实测（探针 F）：锚点之间归属正确、越界 id 归属最后一个 run、早于首条用户消息返回 null、非法 messageId（0/-1/1.5）直接 null 不发查询、会话无用户消息返回 null、软删助手消息定位到的 run 仍含其内容。
- 无 `buildTrace` 行为回归（未改动其代码路径，仅把 `runTraceService` 构造位置上移，`tsc` + 全量 3413 tests 通过）。

### 前端（`FeedbackView.vue`）
- 多选 `isRowSelectable` 只允许 PENDING，从入口拦掉终态行混批。
- `canBatchConvert` 要求 `agentIds.size <= 1`；混批不同 Agent 时按钮禁用，引导在向导里显式选择。
- 向导 `canSubmitWizard` 校验 `wizardAgentId != null` 且每条 content 非空；提交 `experiences: [{content}]`（不带 sortOrder）与后端契约一致（后端 `parseSortOrder` 对缺失返回 undefined，service 回落 `i`）。
- 矩阵单元格 / 整行点击都传 `agentId ?? undefined`，规避 SUGGEST-1 的 null 语义坑。
- 移动端分支（卡片态、抽屉 `size='100%'`）保留；状态筛选 / Agent 筛选 / 重置 / 分页事件均清空选择。
- 系统设置：`MODEL_SELECT_KEYS` 加 `feedback.draftModelId`，`TOC_GROUPS` 新增 `Agent 与模型` 类目，与 V149 的 `category='Agent 与模型'` 一致（该类目为本次新建，V078/V079/V130 分别用「会话」「代码」「记忆」，无历史冲突）。

---

## 四、回归用例保留建议（第一轮）

本次未发现需要新增产品回归用例的 bug。既有 spec 已充分覆盖事务/CAS/状态机/权限/解析/纠错/用量/轨迹定位。若后续处理 SUGGEST-1（仓储支持 `agent_id IS NULL`）或 SUGGEST-2（convert 区分 not found / already handled），应同批补：
- `feedback.repository.spec.ts`：`listDetails({ agentId: null })` 断言 SQL 含 `f.agent_id IS NULL`；
- `feedback-convert.spec.ts`：convert 传不存在 id 断言 `PARAM_INVALID`（或新错误码）。

---
---

# 第二轮复审（2026-10-11）：三条建议的修复验证

- **复审对象**：SUGGEST-1 / SUGGEST-2 / SUGGEST-3 的修复，以及在同样标准下对全部未提交改动的重新过审。
- **复审方法**：同样只用临时 Vitest 探针实跑（探针只新建临时 spec、跑完即删，未改动任何产品源码与既有 spec）。
- **基线复核**：
  - `cd backend-ts && ./node_modules/.bin/vitest run src/feedback src/session/run-trace.service.spec.ts` → 6 files / 152 tests 全绿（第一轮为 149，新增 3 条）。
  - `cd backend-ts && npm test` → 275 files passed / 1 skipped，3416 tests passed / 14 skipped（与修复方报告一致）。
  - `cd backend-ts && ./node_modules/.bin/tsc -p tsconfig.build.json --noEmit` → exit 0。
  - 复审核对：探针清理后 `find src -name "zz-rev2-probe*"` → 0，`git status --porcelain` 与修复前一致（仅多出本报告文件）。

---

## 五、第二轮总体结论

**复审通过。三条修复均正确解决了对应问题，未引入新 bug，也未破坏既有行为。**

三处修复分别验证为：
- SUGGEST-1：三态分支正确，`null` 分支**不占用占位符**，`reason`/`status`/日期条件与 `countTotal`/`listDetails`/`sumByReason`/`sumByDay` 四个入口的 params 顺序全部无错位；
- SUGGEST-2：错误码口径已统一，且 fake db 的 `listByIds` 保真度修复是**必要的**（旧写法会让预校验被绕过，见下方 §6.3）；
- SUGGEST-3：孤立代理对已消除，且纯 ASCII / 纯中文（BMP）的截断位置与第一轮完全一致（无回归）。

另在复审中发现 **1 条「提示」级观察**（不影响功能，见 §6.5）：仓储新增的 `f.agent_id IS NULL` 分支从 HTTP 路由入口**不可达**，只有直接调 service 层才能触发——这使该分支目前只对 spec 契约负责，属可接受但值得知道的事实。

---

## 六、逐条复审

### 6.1 SUGGEST-1：`buildDetailWhere` 三态 —— 修复正确

**修复后代码**（`feedback.repository.ts:249-258`）：
```ts
// agentId 语义三态：undefined 不筛选；null 筛 agent_id IS NULL（飞书点踩无 Agent）；
// 具体 id 走等值。`f.agent_id = NULL` 永远不成立，必须显式 IS NULL
if (filter.agentId === null) {
  conditions.push('f.agent_id IS NULL');
} else if (filter.agentId !== undefined) {
  conditions.push('f.agent_id = ?');
  params.push(filter.agentId);
}
```

**验证点与实跑结果**（探针 `zz-rev2-probe-1.spec.ts`，已删除）：

1. **`null` 分支不占占位符（最关键的风险点）**——若误写成 `conditions.push('f.agent_id IS NULL'); params.push(...)`，后续日期条件与分页参数会整体错位：
```
[R1] SQL: ... WHERE f.reason = ? AND f.status = ? AND f.agent_id IS NULL AND f.created_at >= ? AND f.created_at < DATE_ADD(?, INTERVAL 1 DAY)
[R1] params: ["WRONG_RESULT","PENDING","2026-09-01","2026-09-27"]     ← 4 个条件 4 个参数，无错位
[R2] params: ["WRONG_RESULT","PENDING",5,"2026-09-01","2026-09-27"]   ← 对照：具体 id 时 5 个参数
[R3] listDetails params: ["OTHER","PENDING",20,40]                     ← 分页参数仍追加在 where 参数之后
```
`R1` 的 SQL 有 4 个 `?`（reason / status / startDate / endDate），params 正好 4 个；`R3` 证明 `listDetails` 的 `[...params, limit, offset]` 拼接顺序未被破坏。

2. **三态确实可区分**（回归第一轮 bug）：
```
[R5] undefined SQL: SELECT COUNT(*) AS c FROM message_feedback f
[R5] null      SQL: SELECT COUNT(*) AS c FROM message_feedback f WHERE f.agent_id IS NULL
```
`undefined` 仍不含任何 `agent_id` 条件，`null` 生成 `IS NULL`，二者 SQL 不同。

3. **四个入口同口径**：`countTotal` / `listDetails` / `sumByReason` / `sumByDay` 共用 `buildDetailWhere`，实测 params 一致（`R4`）。

4. **`agentId = 0` 走等值分支**（`R6`：`WHERE f.agent_id = ?`，params `[0]`）——`0` 不会被误判成 `null`，符合「`=== null` 严格判等」的预期。路由层本就拦截 0/负数，此条只是确认仓储层没有把 0 特殊化。

5. **新增 spec 断言充分**：`feedback.repository.spec.ts` 的 `buildDetailWhereDistinguishesNullFromUndefinedAgentId` 同时覆盖 `listDetails`（`params: [10, 0]`，即 null 不占位）、`countTotal`（`params: []`）与 `undefined`（SQL 不含两种 agent 条件）三种入口，与我的探针结论一致。

**结论**：修复正确，无新问题。

### 6.2 SUGGEST-2：convert 错误码口径 —— 修复正确

**修复后代码**（`feedback.service.ts:274-281`）：
```ts
const rows = await this.repository.listByIds(feedbackIds);
if (rows.length !== feedbackIds.length) {
  throw new BusinessException(ErrorCode.PARAM_INVALID, '部分反馈记录不存在');
}
const handled = rows.filter((row) => row.status !== 'PENDING');
if (handled.length > 0) {
  throw new BusinessException(ErrorCode.FEEDBACK_ALREADY_HANDLED);
}
```

**验证点与实跑结果**（探针 `zz-rev2-probe-2.spec.ts`，已删除）——完整错误码矩阵：

| 入口 | 输入 | 结果 |
|---|---|---|
| convert | `[1,42]`（42 不存在） | `2001 "部分反馈记录不存在"` |
| convert | `[1,2]`（2 已 DISMISSED） | `3046 "该反馈已被处理，请刷新后重试"` |
| convert | `[1,3]`（3 已 CONVERTED） | `3046` |
| convert | `[1]`（全 PENDING） | 成功（`cas → insert → bind → commit`） |
| draft | `[1,42]` | `2001` |
| draft | `[1,2]`（2 已 DISMISSED） | `3046` |
| convert | `[42,43]`（全不存在） | `2001` |
| draft | `[42,43]` | `2001` |

convert 与 draft 现在对同一种输入给同一个码，口径统一。事务日志显示失败路径均未开事务（`log` 中无 `cas`/`commit`），成功路径顺序为 `cas:CONVERTED:1/1 → insert:100 → bind:100 → commit`，与第一轮一致。

**`dismiss` 的行为（记录，非问题）**：`dismiss` 没有「id 不存在」预校验，`[1,42]`（42 不存在）与 `[1,2]`（2 已 CONVERTED）都报 `3046`：
```
[S3] dismiss [1,42]（42 不存在）     → 3046
[S3] dismiss [1,2]（2 已 CONVERTED） → 3046
[S3] dismiss [1]                    → 成功
```
这是设计使然：dismiss 是纯 CAS（`UPDATE ... WHERE id IN (...) AND status='PENDING'`），影响行数不符即失败回滚，语义上「不存在」与「已处理」本就不可区分，且不影响正确性（全或无，无部分写入）。若追求提示语精确，可参照 convert 补一个预校验，但**不构成 bug**，本次不要求修改。

### 6.3 fake db 保真度修复 —— 必要且正确

**旧写法的问题（确认修复方判断正确）**：
```ts
// 旧：feedbackRows.get(id)!  —— 传入不存在的 id 返回 {}（展开 undefined 得空对象）
return ids.map((id) => ({ ...feedbackRows.get(id)! })) as T[];
// 新：过滤掉不存在的行，与真实 MySQL 的 IN 语义一致
return ids.map((id) => feedbackRows.get(id)).filter((row) => row != null).map((row) => ({ ...row })) as T[];
```
`{...undefined}` 在 JS 中等于 `{}`（不抛错），所以旧 fake 对 `[1, 42]` 会返回 `[{...row1}, {}]`，长度 2 与传入数量相等 → `rows.length !== feedbackIds.length` 不成立 → 预校验被绕过，直接进事务由 CAS 兜底。这也解释了第一轮为何原 spec 断言 `3046` 却能通过：它测的是 CAS 失败路径，而不是预校验路径。修复后 fake 与真实 MySQL 一致，`listByIds:1/2`（探针日志确认），预校验真正被触发。

这个保真度问题**只影响测试**，不影响产品代码，但它让原本应该失败的用例「意外通过」，属测试有效性问题，修复方主动发现并修是对的。

### 6.4 SUGGEST-3：码点安全截断 —— 修复正确，无回归

**修复后代码**（`experience-draft.service.ts:308-312`）：
```ts
function truncate(text: string, max: number): string {
  const points = Array.from(text);
  if (points.length <= max) return text;
  return `${points.slice(0, max).join('')}…`;
}
```

**验证点与实跑结果**（探针 `zz-rev2-probe-3.spec.ts` / `-4.spec.ts`，已删除）：

1. **孤立代理对已消除**：
```
[T1) emoji 😀: 省略号位置=243 末字符=0xde00 孤立代理=false    ← 低位代理，说明代理对完整
[T1) CJK-B 𠀀: 省略号位置=243 末字符=0xdc00 孤立代理=false
```
对比第一轮探针实测 `0xd83d` / `0xd840`（孤立高位代理），修复生效。

2. **纯 ASCII 无回归**：`(T2)` 行长度 146，与第一轮实测完全一致（前缀 8 + 120 码元 + `…` + 后缀 17）。

3. **BMP 字符（中文）无回归**：`(T3)` 省略号位置 128 = 前缀 8 + 120。第一轮我的探针把期望写成 127 是**我自己算错前缀长度**（`- ` + `shell` + ` ` = 8，不是 7），用探针 4 单独核算确认：
```
[U1] 前缀 "- shell " 长度 = 8（"- "=2 + "shell"=5 + " "=1 = 8）
[U3] 后缀长度 = 17；总计 = 8 + 120 + 1 + 17 = 146
```
所以 BMP 字符下「码点」与「码元」数值相同，行为与修复前一致。

4. **口径变化的确认（已知且可接受）**：非 BMP 字符下「字数」语义从码元变为码点。`(T5)` 实测 `'😀'.repeat(1500)` 截断到 1000 码点后 `.length = 2001`（修复前会是 1001）。这使截断结果比修复前**略长**（UTF-16 码元数翻倍），但：
   - 上限本身是粗粒度的 prompt 防爆阈值（1000/2000 字），不是硬契约；
   - 修复前的行为是「切出乱码」，修复后是「多带几个字符」，后者明显更优；
   - 新增 spec 只断言「不是孤立代理 + JSON 往返一致」，没有把 `.length` 钉死，不会因口径变化而脆弱。

5. **边界无变化**：`(T7)` 恰好 120 字符不截断（`points.length <= max` 提前返回原文）。

**结论**：修复正确，且新增 spec 的断言方式（判孤立代理 + JSON 往返）比钉长度更稳健。

### 6.5 复审中的新观察（提示级，不要求修改）

**`f.agent_id IS NULL` 分支从 HTTP 入口不可达。**

路由层 `parseAgentId(value, required=false)`（`feedback.routes.ts:66-77`）只可能返回 `undefined` 或正整数，**永远不会返回 `null`**。实测（探针 `zz-rev2-probe-5.spec.ts`，已删除）：
```
[V1] agentId="" → code=0 service.agentId=undefined
[V1] agentId="null" / "undefined" / "NULL" → code=2001（Number('null')=NaN 被拒）
[V1] agentId="0" / "abc" / "1.5" / "-1" → code=2001
[V1] agentId="5" → code=0 service.agentId=5
[V2] draft body {"feedbackIds":[1]} / agentId:null / agentId:"" → agentId=null（这是 draft 的目标 Agent，不走 listDetails 筛选）
```
也就是说：`agentId IS NULL` 分支当前只对「直接调 `service.listDetails({ agentId: null })`」的调用方可见（spec 契约、未来新接口、脚本）。前端矩阵点击传的是 `undefined`，因此「无 Agent（飞书）」这一行在 UI 上点了之后实际仍是不筛选（第一轮报告已记录该规避）。

**为何不算 bug**：
- 修复让**契约与实现一致**了（这正是第一轮的建议目标），spec 注释「筛选无 Agent 的飞书点踩」现在名副其实；
- 前端行为未变（仍传 undefined），无用户体验回退；
- 没有引入错误数据或安全问题。

**若希望该能力对 UI 生效**（属增强，非缺陷修复）：可在路由层为 list 增加一个显式的「无 Agent」筛选项（如 `agentId=none` 或独立 query 参数 `noAgent=1`），由路由转成 `null` 传给 service。本次改动范围外，记录备查。

### 6.6 前端 `canWrite` 权限控制 —— 合理

**实现**（`FeedbackView.vue:437-438` + 4 处模板）：
```ts
/** 写操作（转经验 / 忽略）门槛与后端 feedback:write 一致：只读账号看不到入口，避免点了才报 403。 */
const canWrite = computed(() => authStore.hasPermission('feedback:write'))
```
- 批量工具条：`v-if="canWrite && selectedIds.length > 0"`
- 桌面行内：`v-if="canWrite"` 控制「转经验」「忽略」两个按钮，`v-if="!canWrite"` 显示「只读」占位
- 移动端卡片：`v-if="canWrite && row.status === 'PENDING'"` 控制操作区

**评估**：
1. **与后端权限码一致**：后端 draft/convert/dismiss 全部要求 `feedback:write`，list/summary 要求 `feedback:read`（`feedback.routes.spec.ts` 有 403 覆盖）；前端 `canWrite` 用同一个码，不存在「前端放行后端拦截」或反之的错配。
2. **与路由/菜单权限分层正确**：`router/index.ts:102` 与 `SideMenu.vue:129` 的页面入口用 `feedback:read`，页面内写操作用 `feedback:write`——只读账号能进页面看数据但看不到写入口，符合「读权限看板、写权限操作」的拆分意图。
3. **不依赖 `isAdmin` 兜底**：`hasPermission` 直接查 `permissions` 数组，V149 已把 `feedback:write` 授给 role_id=1；其他角色即使有 `feedback:read` 也不会误获写入入口。
4. **纯展示层控制，无安全含义**：即便前端判断被绕过，后端三个写端点仍会 403，不存在越权写。
5. **终端态行本就禁用**：`CONVERTED`/`DISMISSED` 行的操作列是 `disabled` 按钮，与 `canWrite` 叠加后行为一致，无冲突。

**结论**：实现合理，与既有约定（`settings:write` 的 `canWrite` 同款写法）一致。

---

## 六·补、复审中发现的文档口径滞后（提示级，非功能 bug）

用户第一轮明确「只关注功能逻辑，不关注文档变更」，故本条不计入问题列表。但按项目 `AGENTS.md` 规范（功能变更须同任务同步 `skills/mao-cli/`），此处记录供后续同步：

`skills/mao-cli/reference/feedback.md:40` 的写入侧失败口径写的是：

> 反馈 ID 无效 / 超 100 条上限 / 经验条数不为 1～2 / 单条超 300 字均返回 2001；目标 Agent 不存在返回 3001；反馈已被他人处理返回 3046

与 SUGGEST-2 修复后的代码存在两处滞后：

1. **convert 的「id 不存在」现在也是 2001**（修复前是 3046）。文档未反映该变化——`convert` 一行的描述（`:37`）也仍只写「反馈已被处理返回 3046」。
2. **dismiss 传不存在的 id 返回 3046 而非 2001**（dismiss 无「id 不存在」预校验，纯 CAS 口径，见 §6.2 实测 `[S3] dismiss [1,42] → 3046`）。文档的「共用失败口径」把 dismiss 也一并描述成 2001，与实际不符。

**影响**：仅影响 mao-cli 使用者对接口错误码的预期，不影响任何产品行为。
**建议**：将 `:40` 的口径按端点拆分描述（convert/draft 的「id 不存在」= 2001、「已被处理」= 3046；dismiss 的「不存在或已处理」统一 = 3046）。这属文档同步，由后续 worker 处理，本次未改。

---

## 七、第二轮重点验证过的点（汇总）

| # | 验证点 | 结果 |
|---|---|---|
| 1 | `null` 分支是否占用 SQL 占位符（会导致后续条件参数错位） | 否，params 顺序全部正确 |
| 2 | `countTotal` / `listDetails` / `sumByReason` / `sumByDay` 四入口 params 一致性 | 一致 |
| 3 | `undefined` 仍不筛选、`null` 筛 IS NULL、`0` 走等值 | 三态正确区分 |
| 4 | convert/draft 对「不存在」与「已处理」的错误码矩阵（含全不存在、混批） | 2001 / 3046 口径统一 |
| 5 | fake db `listByIds` 保真度修复是否必要 | 必要（旧写法 `{...undefined}` = `{}` 会绕过预校验） |
| 6 | 失败路径是否不开事务 | 是（日志无 cas/commit） |
| 7 | emoji / CJK 扩展 B 孤立代理对 | 已消除（0xde00 / 0xdc00 为完整低位代理） |
| 8 | 纯 ASCII / 纯中文截断位置是否与修复前一致 | 一致（146 / 128） |
| 9 | 码点截断导致的口径变化（`.length` 翻倍） | 已知、可接受、spec 未钉长度 |
| 10 | 路由层能否触发 `IS NULL` 分支 | 不能（`parseAgentId` 永不返回 null）——提示级观察 |
| 11 | 前端 `canWrite` 与后端权限码是否一致 | 一致，无越权风险 |
| 12 | 全量回归 | 275 files / 3416 tests 全绿；tsc exit 0 |
| 13 | `skills/mao-cli/reference/feedback.md` 错误码口径与代码一致 | 滞后 2 处（文档问题，见 §6·补） |

---

## 八、第二轮结论

**复审通过，可以合并。** 三条修复均正确，未引入新 bug。除 §6.5 的提示级观察（`IS NULL` 分支 HTTP 不可达，属可接受的契约对齐副产品）与 §6.2 的 dismiss 错误码精度（设计使然，不影响正确性）外，无其他需要修改的点。另记录 §6·补 的 mao-cli 文档口径滞后 2 处（文档问题，用户明确不关注文档变更，故未计入问题列表，但按 `AGENTS.md` 规范建议后续同步）。临时探针已全部删除，工作区除本报告外无新增改动。
