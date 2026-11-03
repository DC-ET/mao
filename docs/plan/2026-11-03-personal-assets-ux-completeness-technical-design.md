# 个人资产与配置体验补完技术方案（会话审批规则可见可撤可提升、环境变量免重填、设置页搜索）

- 状态：待实施
- 日期：2026-11-03
- 需求来源：[提案：打开设置不再像查字典 —— 个人资产与配置体验补完](../proposals/2026-11-02-personal-assets-ux-completeness.md)（两项决策已定案：会话级规则入口只放设置页、记忆来源链接仅渲染在设置页卡片）
- 规模：小~中（三项合计约 2~3 人日；**零迁移**，不动任何执行内核）

## 1. 需求背景

### 1.1 现状（代码可查）

| 断点 | 后端现状 | 前端现状 | 代码证据 |
|---|---|---|---|
| 会话级审批规则对用户隐形且不可撤销 | `listUserRules` 已支持 `scope='SESSION'` 查询（路由 `scope` 参数白名单直通）；但 `findOwnedUserRule` 写死 `row.scope !== 'USER'` 抛 404（code 3037），PATCH 与 DELETE 都进不去；VO 不带会话标题 | 设置页 `ApprovalRulesView.vue` 只查默认 `scope=USER`；文案承认「可在审批卡片点击总是允许创建会话级规则」，创建完无处可看、无处可撤 | `approval-rule.service.ts:277-283, 235-266`、`approval-rule.routes.ts:42-61`、`ApprovalRulesView.vue:5-8` |
| 编辑环境变量备注强制重填密文 | `EnvVariableUpdateInput.envValue` 注释「必传」；`requireValueOnUpdate` 规定 `value == null` 报错；`buildPatch` 无条件把 `envValue` 放进 patch（空串还会把原密文清空） | `EnvVariablesView.vue:85` 占位符「重新输入变量值（不回显，留空无法保存）」，`canSubmit` 在 `envValue` 为空时禁用保存；`EnvVarsDrawer.vue` 同款；而 Git 凭证（`GitCredentialsView.vue:77,217`）、MCP 环境变量、信号哨兵请求头早已是「留空则保留原值」 | `env-variable.service.ts:336-342, 383-400`、`EnvVariablesView.vue:149-156, 204-229`、`EnvVarsDrawer.vue:268-275, 336-356` |
| 记忆 / 规则 / 指令无搜索 | `memory.repository.ts:buildFilter` 只按 `scope / projectKey / status` 过滤，无 `keyword`；`GET /v1/memory` 路由不解析 keyword；`memory_item` VO 已返回 `originSessionId` 但前端未渲染 | `MemoryView.vue`、`ApprovalRulesView.vue`、`CommandManager.vue` 均无搜索输入框；反观管理后台 `SystemCommandListView` 有关键词搜索 | `memory.repository.ts:178-194`、`memory.routes.ts:60-71`、`memory.service.ts:305-317`（toMemoryVO） |

### 1.2 要解决的问题

1. 用户在会话里点错「总是允许」后只能删整个会话重来；想把好用的会话级规则转为长期规则也没有入口。
2. 给环境变量补一句备注必须翻出密码本重输 API Key。
3. 记忆（ACTIVE 上限 200 条）、审批规则、指令攒多之后只能一页页翻。

### 1.3 关键事实（设计建立在其上）

- 审批规则存储无唯一键，幂等靠应用层查重（`findBySessionAndValue` 同款模式，`approval-rule.repository.ts:27-33`）。
- always-allow 落库的 `ruleValue` 已是归一化值（`createSessionRuleFromAlwaysAllow` 直接收服务端 hint），`normalizeUserInput` 对已归一化值幂等（`buildShellPrefixValue(normalizeShellCommand('git push')) === 'git push'`）。
- 规则只在工具派发进入审批前匹配一次（`ApprovalRuleService.match`），删除规则只影响**下一次**同类命令，不波及在途请求；denylist 在 `match` 入口全量扫描（`approval-rule.service.ts:117`），即使规则残留受保护命令也不会被放行——但创建/提升入口仍应显式拒绝。
- `MysqlEnvVariableRepository.updateBy`（`env-variable.repository.ts:37-56`）本就是部分更新语义：`patch.envValue !== undefined` 才拼 SQL，空 patch 直接 return——Service 层的 `requireValueOnUpdate` 是唯一堵点。
- LIKE 转义在仓内有现成范式：`command.repository.ts:5-8` 的 `escapeLike`（`\` → `\\`、`%` → `\%`、`_` → `\_`）+ `LIKE CONCAT('%', ?, '%') ESCAPE '\\'`（`session.repository.ts:79`）。
- 记忆查询强制 `user_id = ?` 走 `idx_memory_user_scope_status` 索引，单用户 ACTIVE 上限 `MEMORY_ACTIVE_LIMIT = 200`，keyword LIKE 毫秒级。
- 桌面跳会话的既有范式：`router.push('/tasks/' + sessionId)`（`OpenApiView.vue:629-631`）；`TaskView.vue:1433` 对已删除/失效会话已有「遗忘并回退列表首项」的自恢复逻辑。
- 后端存在 `GET /v1/sessions/:id`（属主校验，`session.routes.ts:299-304`），可作为「来源会话是否存在」的零改动探针；desktop api 层尚无对应包装函数。
- admin 端 `pageAdmin` 已有 `LEFT JOIN session` 带出 `sessionTitle` 的 SQL 模式（`approval-rule.repository.ts:133-145`），用户侧列表可直接复用。

## 2. 需求描述

### 2.1 要做的

1. **P1 会话级审批规则可见、可撤、可提升**（后端 + 设置页前端）：
   - 后端：`DELETE /v1/approval-rules/:id` 放宽为本人名下 `USER` / `SESSION` 规则皆可删；新增 `POST /v1/approval-rules/:id/promote` 把 `SESSION` 规则复制为 `USER` 规则（归一化幂等复检 + denylist 拒绝 + 同值幂等去重）；`GET /v1/approval-rules?scope=SESSION` 列表带出 `sessionTitle`。
   - 前端：`ApprovalRulesView.vue` 顶部新增「用户级规则 / 会话级规则」二级 Tab；会话级卡片展示规则值、类型徽标、所属会话标题、放行次数，操作区提供「提升为用户级」与「删除（恢复审批）」两步确认；入口只放设置页。
2. **P2 环境变量编辑免重填密文**（后端 + 两处前端）：
   - 后端：`buildPatch` 仅在 `envValue` 为非空字符串时重新加密写入；未传 / `null` / 空串一律保留原密文。用户级 / 工作区级 / 系统级三个层级同改。
   - 前端：`EnvVariablesView.vue` 与 `EnvVarsDrawer.vue` 编辑态不再要求重填值，占位文案统一为「留空则保留原值；输入新值则覆盖」，提交时空串不下发 `envValue` 字段。
3. **P3 设置页搜索与记忆来源微链**：
   - 长期记忆：后端 `GET /v1/memory` 增加 `keyword` 参数（服务端 LIKE 过滤 `content` / `project_key`，通配符转义）；`MemoryView.vue` 筛选栏加 300ms 防抖搜索框；记忆卡片把 `originSessionId` 渲染为「来源 #id」链接，点击经 `GET /v1/sessions/:id` 探测后跳转或提示已删除。
   - 我的指令：`CommandManager.vue` 列表上方加轻量过滤框（纯前端按 `name + content` 即时过滤）。
   - 审批规则：`ApprovalRulesView.vue` 工具栏加关键词过滤框（纯前端按 `ruleValue` 包含匹配）。

### 2.2 明确不做的

- **不做**记忆就地可见（聊天气泡回执 / 选区「记住这个」/ WS 事件）——2026-10-27 已否决，记忆改动严格收敛在「设置 → 长期记忆」管理页内部。
- **不做**审批规则匹配优先级、归一化算法、denylist 安全边界的任何改动（`match` / `approval-rule-normalize.ts` 零改动）。
- **不做**环境变量明文回显（安全策略不变，只放宽「编辑备注必须重填密文」）。
- **不做**「把变量值改成空字符串」（环境变量无空值配置需求，需要停用直接删除；`''` 与「未传」统一为保留原值）。
- **不做**会话级规则的「编辑」与「启停」：会话级卡片只有「提升」与「删除」两个操作（`PATCH /v1/approval-rules/:id` 保持仅 `USER` 规则可编辑）。
- **不做**审批规则的后端 `keyword` 参数（规则量级小，前端拉取过滤即可，见 D6）。
- **不做**LOCAL 会话右侧（`TaskInspector` / `PermissionLevelSwitcher`）的规则管理入口（2026-11-02 决策 1 定案）。
- **不做**提升后自动删除原会话级规则（复制语义，见 D2）。
- **不做**admin 端改动（admin 已有含 `sessionTitle` 与筛选的只读清单）。
- **不新增**数据库迁移、**不改** `skills/mao-cli`（无 CLI 命令面变化）、**不改** DEPLOY.md。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 会话级规则删除口径 | `removeUserRule` 放宽为 `row.userId === userId` 即可删（`USER` / `SESSION` 皆可）；`updateUserRule`（PATCH）保持仅 `USER` 级 | 撤回点错的「总是允许」是核心诉求；会话级规则值由 always-allow 自动生成，设置页编辑无意义 |
| D2 | 提升语义 | **复制**：新建 `USER` 级同值规则，原 `SESSION` 规则保留（含 `hitCount` 历史），用户自行决定是否删除 | 删除会丢命中统计且改变当前会话行为语义；复制后两类规则在同一会话的匹配结果一致（SESSION 优先但同值同效） |
| D3 | 提升幂等去重 | 新增 `repo.findByUserAndValue(userId, ruleType, ruleValue)`（限 `scope='USER'`）；已存在同值规则直接返回既有 VO，不重复插入 | 表无唯一键，沿用 `findBySessionAndValue` 的应用层查重模式；断线重试重复点「提升」不产生重复行 |
| D4 | 提升的归一化与 denylist | 复用 `normalizeUserInput(row.ruleType, row.ruleValue)`：已归一化值幂等通过、防御历史脏数据；含受保护命令抛 `APPROVAL_RULE_VALUE_INVALID` | 与手动创建同一道门；虽然 `match` 入口 denylist 兜底，创建/提升入口显式拒绝口径必须一致 |
| D5 | `sessionTitle` 带出 | `repo.listByUser` SQL 改 `SELECT r.*, s.title AS sessionTitle ... LEFT JOIN session s ON s.id = r.session_id`（复用 `pageAdmin` 既有 JOIN 模式）；`ApprovalRuleVo` 增加 `sessionTitle: string \| null`（USER 行为 null） | 十行内 SQL；admin 侧同字段已有先例，前端展示「来自会话：xxx」 |
| D6 | 审批规则搜索 | 纯前端：关键词非空时单次拉取 `pageSize=100, page=1`（后端 pageSize 上限即 100，按 `hit_count` 排序）后按 `ruleValue` 包含匹配并隐藏分页；关键词为空恢复服务端分页 | 规则量级小（几十条）；不为它加后端参数与索引；超过 100 条的极端场景用类型 Tab 收窄后再搜 |
| D7 | 环境变量「留空保留原值」语义 | `envValue` 未传 / `null` / `''` 一律不进 patch（保留原密文）；仅非空字符串校验长度后加密覆盖；**废除**「空串显式清空」旧语义并删除 `requireValueOnUpdate` | 与 Git 凭证 / MCP 环境变量 / 哨兵请求头完全统一；空值无配置需求（提案 §6 论证）；底层 `updateBy` 部分更新现成 |
| D8 | 记忆 keyword | 服务端过滤：`MemoryListQuery.keyword` + `buildFilter` 追加 `(content LIKE ... OR project_key LIKE ...) ESCAPE '\\'`，转义复用 `escapeLike` 范式 | 记忆 200 条上限但分页 20 条，前端过滤只筛当前页会漏；服务端过滤分页口径才正确 |
| D9 | 记忆来源跳转 | 点击「来源 #id」→ `GET /v1/sessions/:id`（desktop api 新增 `getSession` 包装）：成功 `router.push('/tasks/' + id)`；失败 `ElMessage.warning('来源会话已删除')` | 属主校验现成、零后端改动；失败即「不存在或非本人」，文案统一为已删除 |
| D10 | 指令过滤 | `CommandManager.vue` 纯前端：`displayedCommands` computed 按 `name + content`（toLowerCase includes）即时过滤；区分「暂无」与「无匹配」空态 | 指令几十条量级，与管理后台 `SystemCommandListView` 同款轻量做法 |
| D11 | 入口收敛 | 会话级规则管理只放「设置 → 审批规则」页二级 Tab | 提案决策 1 定案；对话现场只保留审批卡本身 |

## 4. 实现步骤

### 4.1 P1 后端（`approval-rule` 域）

1. **`approval-rule.repository.ts`**：
   - `listByUser` SQL 改为 `SELECT r.*, s.title AS sessionTitle FROM \`approval_rule\` r LEFT JOIN \`session\` s ON s.id = r.session_id WHERE r.user_id = ? ...`（筛选 / 排序 / 分页子句不变，列引用加 `r.` 前缀）；返回类型放宽为 `ApprovalRuleRow & { sessionTitle?: string | null }`。
   - 新增 `findByUserAndValue(userId, ruleType, ruleValue)`：`SELECT * FROM \`approval_rule\` WHERE user_id = ? AND scope = 'USER' AND rule_type = ? AND rule_value = ? LIMIT 1`。
2. **`approval-rule.service.ts`**：
   - `ApprovalRuleVo`（`types.ts`）增加 `sessionTitle: string | null`；`toVo` 从 row 读取（无该字段时 null）。
   - `removeUserRule`：改查 `repo.findById(id)`，`!row || row.userId !== userId` 抛 `APPROVAL_RULE_NOT_FOUND`（3037），通过后 `deleteById`——不再限制 scope。**保留** `findOwnedUserRule`（仅 `updateUserRule` 继续使用，注释同步收窄为「PATCH 编辑仅限 USER 级」）。
   - 新增 `promoteSessionRule(userId, id): Promise<ApprovalRuleVo>`：
     1. `repo.findById(id)`；`!row || row.userId !== userId` → `APPROVAL_RULE_NOT_FOUND`（不暴露存在性）；
     2. `row.scope !== 'SESSION'` → `PARAM_INVALID`「该规则已是用户级规则，无需提升」；
     3. `normalizeUserInput(row.ruleType, row.ruleValue)`（幂等归一化 + denylist 拒绝）；
     4. `repo.findByUserAndValue(userId, ruleType, ruleValue)` 命中 → 直接返回既有规则 VO（幂等）；
     5. `repo.insert({ userId, scope: 'USER', sessionId: null, ruleType, ruleValue })` → `findById` → `toVo`。
3. **`approval-rule.routes.ts`**：新增
   ```ts
   // 会话级规则提升为用户级（复制语义；归一化复检 + denylist 拒绝 + 同值幂等）
   app.post('/v1/approval-rules/:id/promote', async (request, reply) => {
     const userId = requireUserId(request);
     const id = requirePathId(request);
     const vo = await approvalRuleService.promoteSessionRule(userId, id);
     auditAnd(request, 'CREATE', vo.id, `promoted from session rule ${id}, ruleType=${vo.ruleType}, ruleValue=${vo.ruleValue}`);
     return sendOk(reply, vo);
   });
   ```
   `GET`（scope 已支持）与 `DELETE` 路由代码不动。

### 4.2 P1 桌面端（`ApprovalRulesView.vue` + api 层）

1. **`desktop/src/api/index.ts`**：
   - `ApprovalRule` 接口增加 `sessionTitle?: string | null`。
   - `listApprovalRules` params 增加 `scope?: ApprovalRuleScope | null`。
   - 新增 `promoteApprovalRule(id: number): Promise<ApprovalRule>`（`POST /approval-rules/${id}/promote`）。
2. **`ApprovalRulesView.vue`**：
   - 新增顶层 scope 二级 Tab（`scopeFilter = ref<'USER' | 'SESSION'>('USER')`，「用户级规则 / 会话级规则」），切换即 `reload()`；`fetchList` 透传 `scope`。
   - 会话级 Tab：空态文案「暂无会话级规则，可在审批卡片点击『总是允许』创建」；卡片展示类型徽标 + 规则值 + `来自会话：{{ item.sessionTitle ?? '#' + item.sessionId }}` + `放行 {{ hitCount }} 次` + 最近命中；操作区「提升为用户级」（成功 toast「已提升为用户级规则」）与「删除」（复用 `deletingId` 两步确认，成功 toast「已删除，该命令将恢复审批」）；**无**启停开关与编辑按钮。
   - 用户级 Tab：现有卡片（switch / 编辑 / 删除）不变。
   - 搜索框（工具栏右侧，`clearable` + `Search` 前缀图标）：`keyword = ref('')`，`input` 即过滤；`fetchList` 中关键词 `trim()` 非空时按 `pageSize: 100, page: 1` 拉取后以 `ruleValue.toLowerCase().includes(kw)` 过滤（两个 Tab 均生效），此时隐藏 `el-pagination`；关键词为空恢复常规分页请求。类型 Tab 与关键词叠加生效。
   - 页面描述文案更新：补充「会话内点过的『总是允许』可在『会话级规则』中查看、提升或删除」。

### 4.3 P2 后端（`env-variable.service.ts`）

1. `EnvVariableUpdateInput.envValue` 注释改为：「可选：留空 / 未传保留原密文（编辑免重填）；仅非空字符串覆盖（不回显 → 无法表达空值，需停用直接删除）」。
2. 删除 `requireValueOnUpdate` 方法（唯一调用点在 `buildPatch`）。
3. `buildPatch` 首行改为：
   ```ts
   const patch: EnvVariablePatch = {};
   // 编辑免重填密文：未传 / null / 空串一律保留原密文；仅显式非空字符串才重新加密覆盖
   if (input.envValue != null && input.envValue !== '') {
     patch.envValue = this.encrypt(this.validateValue(input.envValue));
   }
   ```
   `envKey` / `note` 分支不变（`updateBy` 对空 patch 已有 `columns.length === 0 return` 防御）。
4. `updateUser` / `updateWorkspace` / `updateSystem` 三个入口共用 `buildPatch`，自动同改；路由层 `envValue: body.envValue` 透传不动。

### 4.4 P2 桌面端（`EnvVariablesView.vue` & `EnvVarsDrawer.vue`）

1. `EnvVariablesView.vue`：
   - 值输入框占位符：编辑态「留空则保留原值；输入新值则覆盖」，新建态「变量值」。
   - `canSubmit`：移除无条件 `if (!form.value.envValue) return false`，改为 `if (!isEditing.value && !form.value.envValue) return false`（新建仍必填值，编辑态不要求）。
   - `handleSubmit` 编辑分支：`envValue: form.value.envValue === '' ? undefined : form.value.envValue`（空串不下发字段）；新建分支不变。
2. `EnvVarsDrawer.vue`：同三点（占位符 `:placeholder`、`canSubmit` 的 `return form.value.envValue !== ''` 改为编辑态恒可提交、提交体 `envValue` 条件下发），接口路径为 `/user/workspace-env-variables/:id`。
3. 两处的保存成功 toast 不变；编辑说明区补一句「留空表示保留原值」（与 Git 凭证页文案口径一致）。

### 4.5 P3 后端（`memory` 域）

1. **`memory/types.ts`**：`MemoryListQuery` 增加 `keyword?: string | null`。
2. **`memory.routes.ts`**：`GET /v1/memory` 的 `listQuery` 增加解析 `keyword: typeof query.keyword === 'string' && query.keyword.trim() !== '' ? query.keyword.trim() : null`。
3. **`memory.repository.ts`**：
   - 文件头新增 `escapeLike`（与 `command.repository.ts` 逐字同款）。
   - `buildFilter` 追加：
     ```ts
     if (hasText(query.keyword)) {
       conditions.push("(content LIKE CONCAT('%', ?, '%') ESCAPE '\\\\' OR project_key LIKE CONCAT('%', ?, '%') ESCAPE '\\\\')");
       const escaped = escapeLike(query.keyword!.trim());
       params.push(escaped, escaped);
     }
     ```
   - 分页 / 排序 SQL 不变（`listByFilter` 现有结构）。

### 4.6 P3 桌面端（`MemoryView.vue` & `CommandManager.vue` & api 层）

1. **`desktop/src/api/index.ts`**：`MemoryListParams` 增加 `keyword?: string | null`；新增 `getSession(sessionId: number): Promise<unknown>`（`GET /sessions/${sessionId}`，仅供存在性探测与跳转，不消费返回体）。
2. **`MemoryView.vue`**：
   - 筛选行（scope Tabs 与状态下拉之间）加搜索框：`keyword = ref('')`，`el-input clearable` + `Search` 前缀图标，`@input` 300ms 防抖（`setTimeout` + 清理，组件卸载时 `clearTimeout`）后 `reload()`；`fetchList` 透传 `keyword`。
   - 记忆卡片 meta 区：`item.originSessionId != null` 时渲染 `<a class="origin-link" @click="openOrigin(item.originSessionId)">来源 #{{ item.originSessionId }}</a>`（置于「自动/手动」徽标旁）。
   - `openOrigin`：`try { await getSession(id); void router.push(`/tasks/${id}`); } catch { ElMessage.warning('来源会话已删除'); }`（`useRouter` 引入）。
3. **`CommandManager.vue`**：
   - Tabs 与列表之间加过滤框：`commandKeyword = ref('')`，占位「搜索指令」，即时过滤（无防抖）。
   - `displayedCommands` 改为先按 tab 取集合，再按 `cmd.name + ' ' + cmd.content` 的 `toLowerCase().includes(keyword)` 过滤。
   - 空态区分：列表为空且有关键词时显示「无匹配指令」，否则维持现有「暂无个人指令 / 暂无系统指令」。

### 4.7 文档同步

- `CHANGELOG.md`：顶部新增版本小节，按 后端（backend-ts）/ 前端（desktop 共用 UI）分节记录三项变更。
- `README.md`：
  - L49「长期记忆」行补「支持关键词搜索，自动沉淀的记忆可跳回来源会话」；
  - L90「环境变量」行的「值加密存储、保存后不回显」后补「编辑备注时无需重填值（留空保留原值）」；
  - 「审批规则」相关描述（功能列表/使用指南中提及审批的位置）补「会话级规则可在设置页查看、删除与一键提升为用户级规则」。
- `DEPLOY.md`、`skills/mao-cli` **不改**。

## 5. 落地变更清单

| 端 | 文件 | 变更 | 新增/修改 |
|---|---|---|---|
| backend-ts | `src/approval-rule/approval-rule.repository.ts` | `listByUser` LEFT JOIN session 带出 `sessionTitle`；新增 `findByUserAndValue` | 修改 |
| backend-ts | `src/approval-rule/types.ts` | `ApprovalRuleVo` 增加 `sessionTitle` | 修改 |
| backend-ts | `src/approval-rule/approval-rule.service.ts` | `removeUserRule` 放宽 scope；新增 `promoteSessionRule`；`toVo` 带 `sessionTitle` | 修改 |
| backend-ts | `src/approval-rule/approval-rule.routes.ts` | 新增 `POST /v1/approval-rules/:id/promote`（含审计） | 修改 |
| backend-ts | `src/env/env-variable.service.ts` | `buildPatch` 条件写入 `envValue`；删除 `requireValueOnUpdate`；入参注释更新 | 修改 |
| backend-ts | `src/memory/types.ts` | `MemoryListQuery` 增加 `keyword` | 修改 |
| backend-ts | `src/memory/memory.routes.ts` | 解析 `keyword` 查询参数 | 修改 |
| backend-ts | `src/memory/memory.repository.ts` | 新增 `escapeLike`；`buildFilter` 追加 keyword LIKE 子句 | 修改 |
| desktop | `src/api/index.ts` | `ApprovalRule.sessionTitle`、`listApprovalRules` scope、`promoteApprovalRule`、`MemoryListParams.keyword`、`getSession` | 修改 |
| desktop | `src/views/settings/ApprovalRulesView.vue` | scope 二级 Tab + 会话级卡片（提升/删除）+ 关键词过滤 | 修改 |
| desktop | `src/views/settings/EnvVariablesView.vue` | 编辑免重填（占位/canSubmit/提交体） | 修改 |
| desktop | `src/components/chat/EnvVarsDrawer.vue` | 同上（工作区变量） | 修改 |
| desktop | `src/views/settings/MemoryView.vue` | keyword 搜索（300ms 防抖）+ `来源 #id` 跳转链接 | 修改 |
| desktop | `src/components/command/CommandManager.vue` | 指令关键词即时过滤 + 空态区分 | 修改 |
| 测试 | `backend-ts/src/approval-rule/approval-rule.service.spec.ts`、`approval-rule.routes.spec.ts`、`backend-ts/src/env/env-variable.service.spec.ts`、`backend-ts/src/memory/memory.repository.spec.ts` | 新增/调整用例（见 §7） | 修改 |
| 文档 | `CHANGELOG.md`、`README.md` | 同步 | 修改 |
| 数据库迁移 | — | **无（零迁移）** | — |

## 6. 影响面与回归护栏

| 风险 | 护栏 |
|---|---|
| 删除/提升越权（动他人规则） | 两个入口都先 `findById` + `row.userId === userId` 硬校验，不符统一 3037（不暴露存在性）；spec 覆盖他人规则拒绝 |
| 放开 SESSION 删除波及 `updateUserRule` | PATCH 继续走 `findOwnedUserRule`（仅 USER），函数级隔离；spec 断言 PATCH 会话级规则仍 3037 |
| denylist 命令经提升获得跨会话放行 | `promoteSessionRule` 复用 `normalizeUserInput` 的 `hasDenyToken` 拒绝（`APPROVAL_RULE_VALUE_INVALID`）；即使历史脏数据漏网，`match` 入口 denylist 全量扫描兜底（双重防线） |
| 提升重复点击产生重复 USER 规则 | `findByUserAndValue` 幂等查重，命中直接返回既有 VO；spec 断言二次提升不新增行 |
| 环境变量旧语义依赖（前端/调用方利用空串清值） | 仓内唯一调用方是两处桌面编辑表单，本次同步改为「留空不下发」；无其他消费方（grep 验证）；`updateBy` 空 patch 直接 return，不会误写 |
| `updateBy` 空 patch 无列可更 | 既有 `columns.length === 0 return` 防御原样保留；spec 补「patch 为空不执行 SQL」断言 |
| 记忆 keyword LIKE 通配符误匹配 / 注入 | 参数化查询 + `escapeLike` 转义 `\ % _`；spec 覆盖含 `%` / `_` / `\` 的关键词按字面匹配 |
| keyword 与 scope/status/projectKey 叠加查询错序 | `buildFilter` 走同一 conditions/params 追加管线，参数顺序即占位符顺序；spec 断言组合查询 |
| 记忆来源会话已删 | 跳转前 `GET /v1/sessions/:id` 探测，失败 toast「来源会话已删除」；即使竞态删除，`TaskView` 已有失效自恢复（回退列表首项） |
| 审批规则搜索只看 100 条 | D6 明确取舍：检索范围 = 按 `hit_count` 排序的前 100 条；页面空态/文案不承诺全量搜索 |
| 审批规则在途审批请求 | 规则只在派发前匹配一次，删除不影响在途请求（§1.3 已核） |

## 7. 测试要点

### 7.1 后端单测（Vitest）

1. **approval-rule.service.spec.ts**（调整 + 新增）：
   - 调整既有用例：`removeUserRule` 对本人 `SESSION` 规则（原断言 3037）改为**删除成功**；新增他人 `SESSION` 规则仍 3037；
   - `promoteSessionRule`：本人 SESSION 规则提升成功且 `repo.insert` 收到 `{ scope: 'USER', sessionId: null, ruleType, ruleValue }`；他人规则 → 3037；USER 规则 → PARAM_INVALID「该规则已是用户级规则，无需提升」；含 denylist token（如 `sudo rm`）→ `APPROVAL_RULE_VALUE_INVALID`；`findByUserAndValue` 命中时**不 insert** 且返回既有行 VO（幂等）；`SHELL_PREFIX` 值归一化幂等（`git push` 进 `git push` 出）；
   - `listUserRules(scope='SESSION')`：mock `listByUser` 返回带 `sessionTitle` 的行，断言 VO 含 `sessionTitle`；USER scope 行 `sessionTitle` 为 null。
2. **approval-rule.routes.spec.ts**：`POST /v1/approval-rules/:id/promote` 成功返回 VO 并触发 `audit`（action=CREATE）；非本人 → envelope code 3037；非法路径 id → 3037。
3. **env-variable.service.spec.ts**：
   - 调整既有「空串清空」断言为「空串保留原密文」（user / workspace / system 三层如有同款断言一并改）；
   - 新增：更新时**不传** `envValue` 仅传 `note` → `repo.updateX` 收到的 patch **不含** `envValue` 键（`resolveForSession` 解密值不变用例保持通过）；传新值 → patch 含重新加密的 `envValue`；patch 全空（只构造空 input）→ 不执行 UPDATE（repo mock 断言零调用）。
4. **memory.repository.spec.ts**：`buildFilter`/列表查询带 `keyword` → SQL 含 `content LIKE ... OR project_key LIKE ...` 且参数为转义后关键词各一次；含 `%` / `_` / `\` 的关键词转义正确；keyword 与 scope/status 组合时占位符顺序正确；keyword 为空不追加子句。

### 7.2 手工 / 集成验收

1. P1：会话内点「总是允许」→ 设置页「会话级规则」Tab 出现该规则且显示来源会话标题；点「删除」后同会话再执行同类命令重新弹审批卡；点「提升为用户级」后规则出现在用户级 Tab、跨新会话生效、原会话级规则仍在；重复点提升不产生重复规则；含 `sudo` 的规则（若存在）提升被拒。
2. P2：编辑环境变量只改备注 → 保存成功且后续会话解析出的值与改前一致（`resolveForSession` / effective-env 面板核对）；填新值 → 覆盖生效；Git 凭证 / MCP 环境变量页交互口径一致。
3. P3：`GET /v1/memory?keyword=vitest` 只返回匹配行；含 `%` 关键词不发生通配误匹配；记忆卡片「来源 #123」点击跳回会话、删除来源会话后点击 toast「来源会话已删除」；指令过滤输入即收敛、清空恢复；审批规则搜索在两个 Tab 下均可过滤。

### 7.3 构建验证

- `cd backend-ts && npm run build && npm test`（长输出落盘 grep 摘要）；
- `cd desktop && npm run build`（`vue-tsc -b && vite build`，**禁用** `npx vue-tsc --noEmit` 假通过路径）；admin 本期无改动，随 CI 常规构建。

## 8. 实施顺序与验收清单

实施顺序：后端 P1 → 后端 P2 → 后端 P3 → 桌面 P1 → 桌面 P2 → 桌面 P3 → 单测与构建 → 文档 / CHANGELOG。

- [ ] `removeUserRule` 放宽（本人 SESSION 可删、他人 3037、PATCH 口径不变）
- [ ] `POST /v1/approval-rules/:id/promote`（复制语义、幂等去重、denylist 拒绝、审计落 CREATE）
- [ ] `listByUser` 带 `sessionTitle`，`ApprovalRuleVo` 扩字段
- [ ] `buildPatch` 留空保留原密文（三层同改），`requireValueOnUpdate` 移除
- [ ] `GET /v1/memory` keyword 过滤（escapeLike 转义）
- [ ] desktop `ApprovalRulesView.vue`：scope 二级 Tab + 会话级卡片（提升/删除）+ 关键词过滤
- [ ] desktop `EnvVariablesView.vue` / `EnvVarsDrawer.vue`：编辑免重填
- [ ] desktop `MemoryView.vue`：搜索框（300ms 防抖）+ `来源 #id` 链接（存在性探测后跳转/提示）
- [ ] desktop `CommandManager.vue`：即时过滤 + 空态区分
- [ ] 四个 spec 文件用例全绿（含调整后的既有断言）
- [ ] backend build + test 全绿；desktop `npm run build` 全绿
- [ ] CHANGELOG.md、README.md 同步完成
- [ ] 手工验收三件套：会话级规则撤回后恢复审批弹卡；改备注不解密出变化的值；keyword 通配符按字面匹配
