# 管理后台关联反查与自定义工具体验技术方案（含密文测试、一键复制、Agent ⇄ 模型 / MCP / 工具双向关联）

- 状态：待实施
- 日期：2026-11-03
- 需求来源：[提案：搭好一个 Agent 不用在五个菜单里来回跑 —— 管理后台关联反查、工具复制与带密文测试](../proposals/2026-11-02-admin-capability-linking-and-http-tool-ux.md)（2026-11-02 收窄定案：防凭据外带守卫、Agent 列表去对话两项不做）
- 规模：小~中（两项合计约 1.5~2 人日；**零数据库迁移**，不动执行内核与 Agent 运行时装配）

## 1. 需求背景

### 1.1 现状（代码可查）

| 断点 | 后端现状 | 前端现状 | 代码证据 |
|---|---|---|---|
| 自定义工具含敏感头时无法测试 | `resolveDraftForExecution(draft)` 对任何等于 `******` 的头值直接抛 `PARAM_INVALID`「不允许提交掩码值」，不支持像 `update()` 保存那样按工具 id 沿用库内密文 | 列表「测试」按钮写死 `:disabled="hasSensitiveHeader(row)"`，提示「请从编辑填写真实值后测试」；编辑弹窗内掩码未回填时「发起调用」同样禁用 | `http-tool.service.ts:189-198`、`HttpToolListView.vue:67, 263-265, 284-292, 421-429` |
| 自定义工具无「复制」 | `create()` 的 `encodeHeaders(headers, null, cipher)` 固定传 `previousStored=null`，没有从源工具继承密文的通道（信号哨兵 0.0.361 已有 `copyFrom` 先例：`applyCopyInheritance` 服务端解密继承） | 列表操作列只有「测试 / 停用 / 编辑 / 删除」；模型、Agent、哨兵列表均有「复制」 | `http-tool.service.ts:75`、`HttpToolListView.vue:63-80`、`watcher.service.ts:152-171` |
| 管理后台各能力页缺乏关联反查 | `GET /v1/agents` 列表 VO 已返回 `defaultModelId / skillNames / mcpServerIds / httpToolIds`，无任何后端缺口 | 仅 `SkillListView` 有「关联 Agent」数字列；`ModelListView` / `McpServerListView` / `HttpToolListView` 均无；`AgentListView` 只显示 `Skills` 数量与 `经验数`，看不到默认模型与 MCP / 工具关联，也没有按模型筛选 | `agent.routes.ts:295-341`、`SkillListView.vue:162-164, 458`、`ModelListView.vue:68-117`、`McpServerListView.vue:39-114`、`AgentListView.vue:48-111` |

### 1.2 要解决的问题

1. 管理员停用一个旧模型、停用一个 MCP、停用/删除一个自定义工具前，不知道影响哪些 Agent，只能逐个点开 Agent 编辑弹窗翻。
2. 想核对「哪些 Agent 还在用旧模型」时，Agent 列表给不出默认模型信息，也无法按模型筛。
3. 自定义工具一旦配了 `Authorization` 等敏感头：保存后「测试」按钮永久灰掉，验通只能找回明文 Token 重填；给同一内部网关配第 2 个接口，全套鉴权头和公共参数要手敲一遍。

### 1.3 关键事实（设计建立在其上）

- 掩码沿用语义在 `encodeHeaders(headers, previousStored, cipher)` 已完整实现且 `update()` 在用：值 === `HEADER_VALUE_MASK` → 取 `previousStored[key]`（密文原样保留），取不到 → `PARAM_INVALID`「提交的是掩码值，无法对应到已保存的凭据」；**掩码判断在键敏感性判断之前**（改键名不会把掩码当凭据落库）。`http-tool.service.ts:429-453`
- 存储形态解码已有现成函数：`parseStoredHeaders`（headersJson → Record）、`decodeHeaders`（`enc:` 前缀 + 敏感键 → `cipher.decrypt`，其余明文直用）。`http-tool.service.ts:456-494`
- `resolveDraftForExecution` 全仓唯一调用方是 `POST /v1/admin/http-tools/test` 路由（grep 证实），改成 async 无其它涟漪。
- test 响应体只含 `status / body / truncated / notice / displayName / durationMs / error`，天然不含请求头，服务端解密值不会外泄到响应。
- `/v1/agents?includeDisabled=true` 列表 VO 每行已带 `defaultModelId / skillNames / mcpServerIds / httpToolIds`（`SkillListView` 已在消费该模式，内存过滤 <1ms）。
- Agent 表单的选项端点先例：`/models/active`（全量启用模型）、`/mcp-servers/enabled`、`/admin/http-tools/enabled`（`AgentFormDialog.vue:695-709`）；`/mcp-servers` 返回全量数组含停用行；`GET /v1/admin/http-tools` 分页 `size` 上限 100。
- `agent.defaultModelId` 保存时经 `requireEnabledModel` 校验启用，之后模型可能被停用 → 名称映射必须留 `#id` 兜底；同理 `mcpServerIds / httpToolIds` 允许保留已停用资源的失效 id（`validateForAgent` 的既有语义）。
- admin 路由 `/agents`（`router/index.ts:27`）；`AgentListView` 目前不读 `route.query`。
- 本期不新增内置工具、不新增 LLM 调用场景、不新增收件箱 kind，不触发既有「三处同改」规范。

## 2. 需求描述

### 2.1 要做的

1. **P1 自定义 HTTP 工具带密文测试与一键复制**（后端 + admin 前端）：
   - 后端 `POST /v1/admin/http-tools/test` 增加可选 `toolId` 参数：草稿中出现掩码头且传了 `toolId` 时，从该工具已存 `headersJson` 解析并解密出真实值参与本次实调；未传 `toolId` 时保持现有拒绝口径。
   - 后端 `POST /v1/admin/http-tools` 增加可选 `copyFromId` 参数：新建时从源工具的已存请求头解析掩码（与 `update()` 共用 `encodeHeaders` 同一函数）。
   - admin `HttpToolListView.vue`：列表行「测试」按钮取消敏感头禁用（随时可测）；编辑弹窗与复制弹窗内「测试调用」分别按 `editingId` / `copySourceId` 沿用已存密文；操作列新增「复制」按钮——预填新建弹窗（工具名加 `_copy` 后缀、展示名加 `副本` 后缀），保存时传 `copyFromId` 继承敏感头密文。
2. **P2 管理后台「Agent ⇄ 模型 / MCP / 自定义工具 / Skill」双向关联展示**（纯 admin 前端聚合，零后端新接口）：
   - 新增共享 composable `admin/src/composables/useAgentRelations.ts`（拉全量 Agent 内存聚合）与共享组件 `admin/src/components/RelatedAgentsPopover.vue`（数量 + 悬停列 Agent 名 + 点击跳转）。
   - `ModelListView` / `McpServerListView` / `HttpToolListView` 新增「关联 Agent」列；`SkillListView` 系统技能既有数字列升级为同一 popover 组件。
   - `AgentListView`：新增「默认模型」列；原「Skills」列升级为「能力概览」列（技能 · MCP · 自定义工具 数量，悬停列具体名称）；筛选栏新增「按模型筛选」下拉；移动端卡片同步补两行信息；支持 `?keyword=` 预填搜索。

### 2.2 明确不做的

- **不做** hostname 一致性守卫（带 `toolId` / `copyFromId` 沿用密文后把 URL 改指外部主机即可套走库内凭据）——2026-11-02 提案已定取舍：工具编辑与测试本就限于管理员（`http_tool:write`），后续如需收紧再在 `resolveDraftForExecution` / `create` 补校验。
- **不做**凭据明文回显 / 导出：测试与复制全程服务端内部解密或沿用密文，前端与响应体永远只见 `******`；test 响应结构不变。
- **不做**跨实例导入导出、批量克隆（Agent Bundle 方向 0.0.389 已移除）；「复制」是同实例内的表单预填克隆。
- **不做**删除 / 停用前的强制确认拦截或引用计数阻断：关联信息只做展示（列 + popover），删除确认弹窗文案维持现状。
- **不做**「Agent 列表去对话」等提案已排除项；不动 Agent 运行时工具装配、`validateForAgent` 校验与权限模型。
- **不做**关联数据的后端聚合接口、新表、新列、新迁移：继续复用 `GET /v1/agents?includeDisabled=true` 前端内存聚合（单实例 Agent 几个~几十个量级）。
- **不做**关联 Agent 数量的服务端过滤 / 分页（量级小，popover 全量列出）。
- **不做** `SkillListView` 个人技能 Tab 的关联列：个人技能按 userId 归属，不走 `skillNames` 关联，语义不适用。
- **不做** admin 单测与 Playwright 新用例（admin 无单测面、CI 不跑 Playwright，靠 `npm run build` + 手工验收）。
- **不新增**数据库迁移、**不改** DEPLOY.md、**不改** skills/mao-cli（无 CLI 命令面变化）。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 密文回填的实现位置 | `resolveDraftForExecution(draft, toolId?)` 改 async：掩码值 → `repo.findById(toolId)` → `parseStoredHeaders` → 敏感 `enc:` 键 `cipher.decrypt`、否则明文直用；实现为私有 helper，不绕道 `encodeHeaders` 加解密往返 | 语义直白：执行形态要的就是明文 headers；复用 `parseStoredHeaders` / `ENC_PREFIX` / `isSensitiveHeaderKey` 既有谓词 |
| D2 | 回填失败口径 | `toolId` 查不到工具 → `HTTP_TOOL_NOT_FOUND`「自定义工具不存在，无法沿用已存密文」；掩码键在源工具无存储值 → `PARAM_INVALID`，文案与 `encodeHeaders` 逐字一致「请求头 X 提交的是掩码值，无法对应到已保存的凭据，请填写真实值后重试」 | 与保存链路同一报错语言；改键名 / 新增掩码头的场景前端无需特判 |
| D3 | `copyFromId` 语义 | `create()` 内：`draft.copyFromId != null` → `repo.findById` → `parseStoredHeaders(source.headersJson)` 作 `previousStored` 传给 `encodeHeaders`；未传 → `null`（现状）。源不存在 → `HTTP_TOOL_NOT_FOUND`「源工具不存在」 | 与 `update()` 完全共用同一掩码解析函数（提案预期的「一行改动」落点）；复制后改键名 / 换值 / 清空的行为与编辑保存逐条一致 |
| D4 | `toolId` / `copyFromId` 参数解析 | 路由层从 body 提取并做正整数校验（无效 → `PARAM_INVALID`「toolId 无效」/「copyFromId 无效」）；`toolId` 不进 `HttpToolDraft`（非工具定义字段），`copyFromId` 进 draft 类型 | 与 `requireId` 既有校验风格一致；draft 类型保持「工具定义」纯度 |
| D5 | 关联数据聚合位置 | 纯前端：`useAgentRelations` 拉 `GET /v1/agents?includeDisabled=true` 一次，内存 Map 聚合出 modelId→agents / mcpServerId→agents / httpToolId→agents / skillName→agents | 后端 VO 字段现成；零迁移零新接口；量级小（<1ms） |
| D6 | 展示复用方式 | composable `useAgentRelations.ts`（数据 + 4 个查询函数，fail-soft：请求失败 agents=[] 列显 0）+ 纯展示组件 `RelatedAgentsPopover.vue`（props 传 agents；0 渲染纯文本；popover 列名，停用 Agent 置灰加「已停用」） | 4 个视图共用一份聚合逻辑与 popover 交互；`SkillListView` 内联实现同步收编 |
| D7 | Agent 列表资源名映射数据源 | 模型：`/models/active`；MCP：`/mcp-servers` 全量；HTTP 工具：`/admin/http-tools?page=1&size=100`；未命中 id 显示 `#id`（模型列加「（已停用）」） | 与 AgentFormDialog 选项端点同源；全量源保证停用资源也显示得出名字；HTTP 工具超 100 个的极端场景 `#id` 兜底（已知取舍） |
| D8 | 按模型筛选 | 纯前端：下拉选项来自 `/models/active`（value=modelId），并入 `matchedAgents` 现有 client 筛选管线（与状态筛选同层） | agents 列表本就是全量拉取 + 前端分页，无后端参数可用也无必要 |
| D9 | 关联 Agent 点名直跳 | popover 内 Agent 名可点 → `router.push({ path: '/agents', query: { keyword: name } })`；`AgentListView` onMounted 读 `route.query.keyword` 预填搜索框并查询 | 「直跳」落到可用的过滤结果页而非裸列表；复用现有关键字查询，零后端改动 |
| D10 | 掩码「从哪继承就从哪测」 | 复制弹窗内「测试调用」以 `copySourceId` 作掩码解析源（等价于保存后用新 id 测）；编辑弹窗用 `editingId`；列表行测试用 `row.id`；新建空表单无解析源 → 掩码头仍禁用测试 | 复制场景「先测再存」与保存语义严格一致；避免保存后才能测的别扭流程 |
| D11 | 列表行测试的草稿来源 | 维持现状：`openTestDrawer` 用行 VO 构造草稿（掩码原样）+ `toolId=row.id` 实调；不引入「直接读库定义」的新端点 | 零新接口；草稿即所见，SSRF 判定与正式调用同路径不变 |

## 4. 实现步骤

### 4.1 P1 后端（`http-tool` 域）

1. **`types.ts`**：`HttpToolDraft` 增加可选字段 `copyFromId?: number`（注释：新建复制继承源，仅 create 消费；`HttpToolTestDraft` 经继承自动获得）。`HttpToolRepository` 无需新增方法（`findById` 已有）。
2. **`http-tool.service.ts`**：
   - `create()`：在 `encodeHeaders` 调用前处理继承——
     ```ts
     let previousStored: Record<string, string> | null = null;
     if (draft.copyFromId != null) {
       const source = await this.deps.repo.findById(draft.copyFromId);
       if (source == null) {
         throw new BusinessException(ErrorCode.HTTP_TOOL_NOT_FOUND, '源工具不存在');
       }
       previousStored = parseStoredHeaders(source.headersJson);
     }
     const headersJson = encodeHeaders(normalized.headers ?? {}, previousStored, this.deps.cipher);
     ```
     其余逻辑（重名查重、事务、参数插入）不变。掩码键在源工具无存储值时由 `encodeHeaders` 原样抛 `PARAM_INVALID`。
   - `resolveDraftForExecution(draft, toolId?: number)`：签名改 `Promise<ResolvedHttpToolExecution>`；掩码头解析抽出私有方法：
     ```ts
     private async resolveDraftHeaders(
       headers: Record<string, string>, toolId?: number,
     ): Promise<Record<string, string>> {
       let stored: Record<string, string> | null = null;
       if (toolId != null) {
         const tool = await this.deps.repo.findById(toolId);
         if (tool == null) {
           throw new BusinessException(ErrorCode.HTTP_TOOL_NOT_FOUND, '自定义工具不存在，无法沿用已存密文');
         }
         stored = parseStoredHeaders(tool.headersJson);
       }
       const result: Record<string, string> = {};
       for (const [key, value] of Object.entries(headers)) {
         if (value !== HEADER_VALUE_MASK) { result[key] = value; continue; }
         if (toolId == null) {
           throw new BusinessException(ErrorCode.PARAM_INVALID, `请求头 ${key} 不允许提交掩码值，请填写真实值或清空`);
         }
         const previous = stored?.[key];
         if (previous == null || previous === '') {
           throw new BusinessException(ErrorCode.PARAM_INVALID,
             `请求头 ${key} 提交的是掩码值，无法对应到已保存的凭据，请填写真实值后重试`);
         }
         result[key] = isSensitiveHeaderKey(key) && previous.startsWith(ENC_PREFIX)
           ? this.deps.cipher.decrypt(previous.slice(ENC_PREFIX.length))
           : previous;
       }
       return result;
     }
     ```
     原方法体中内联的掩码循环删除，改为 `const headers = await this.resolveDraftHeaders(normalized.headers ?? {}, toolId);`。掩码判断在键敏感性之前的既有顺序保持不变（非敏感键的掩码值同样走源值回填）。
3. **`http-tool-admin.routes.ts`**：
   - 新增 `optionalPositiveInt(body, key)` 帮助函数：`body[key] == null → undefined`；`Number.isInteger && > 0 → Number`；否则 `PARAM_INVALID`「key 无效」。
   - test 端点：`const toolId = optionalPositiveInt(body, 'toolId');` → `service.resolveDraftForExecution(draft, toolId)` → `await`。响应体结构不变。
   - `toDraft`：增加 `copyFromId: optionalPositiveInt(body, 'copyFromId')`。

### 4.2 P1 admin 前端（`HttpToolListView.vue`）

1. **测试开放**：
   - 删除 `hasSensitiveHeader(row)`、`cardTestTooltip(item)` 及列表按钮上的 `el-tooltip` / `:disabled` 包裹，测试按钮恒可点。
   - 新增 `testToolId = ref<number | null>(null)`：`openTestDrawer(item)` 置 `item.id`；`openTestFromDialog()` 置 `isEditing ? editingId : copySourceId`（D10）；`openCreateDialog` / `resetForm` / `resetTest` 置 `null`。
   - `runTest()` 请求体追加 `toolId: testToolId.value ?? undefined`（`toPayload` 增加可选第二参或在 `runTest` 内展开，取后者，`toPayload` 不动）。
   - 测试抽屉提示三态：`hasMaskedHeader && testToolId != null` → info 提示「敏感请求头将自动沿用已保存的密文实调」；`hasMaskedHeader && testToolId == null` → 维持 warning 文案并禁用「发起调用」（`:disabled="testing || (hasMaskedHeader && testToolId == null)"`）；无掩码 → 无提示。`title` 属性同步调整。
2. **一键复制**：
   - 新增 `copySourceId = ref<number | null>(null)` 与 `openCopyDialog(item)`：`isEditing=false`、`editingId=null`、`copySourceId=item.id`；表单预填——`name`：`item.name.length + 5 <= 64 ? item.name + '_copy' : item.name.slice(0, 59) + '_copy'`；`displayName`：`(item.displayName + '副本').slice(0, 128)`；`headers` 按 VO 原样（敏感头为掩码，保存时由 `copyFromId` 解析）；`description / method / url / params / bodyTemplate / readOnly / timeoutMs / enabled` 原样；弹窗标题「复制自定义工具」（`:title` 三元扩为三分支）。
   - `handleSubmit` create 分支：payload 追加 `copyFromId: copySourceId.value ?? undefined`；成功后清空 `copySourceId`。`resetForm` 同步清空。
   - 操作列「测试」与「停用」之间插入「复制」按钮，操作列宽 220 → 260。
3. **关联 Agent 列（P2）**：表格「启用」列后新增「关联 Agent」列（宽 110，`RelatedAgentsPopover` + `agentsByHttpTool(row.id)`）；页面挂载与 `onActivated` 时调 `useAgentRelations().load()`。

### 4.3 P2 共享 composable 与组件（admin 新增文件）

1. **`admin/src/composables/useAgentRelations.ts`**：
   - `interface RelatedAgent { id: number; name: string; enabled: boolean; defaultModelId: number | null; skillNames: string[]; mcpServerIds: number[]; httpToolIds: number[] }`。
   - `agents = ref<RelatedAgent[]>([])`、`loading`、`async load(): Promise<void>`：`GET /agents?includeDisabled=true`，逐行解析 JSON 字段（容错同后端 `parseHttpToolIds` 口径：非法 → 空数组）；**fail-soft**——请求失败吞错置空数组（无 `agent:read` 权限的管理角色列显 0，不阻塞页面主数据）。
   - 查询函数（每次调用即时过滤，不预建 Map——量级小，避免双向索引的维护成本）：`agentsByModel(modelId)`（`defaultModelId === modelId`）、`agentsByMcpServer(id)`（`includes`）、`agentsByHttpTool(id)`（`includes`）、`agentsBySkill(name)`（`skillNames.includes`）。
2. **`admin/src/components/RelatedAgentsPopover.vue`**：
   - props：`agents: RelatedAgent[]`。
   - `agents.length === 0` → 渲染纯文本 `0`；否则 `<el-popover>` 触发器渲染数量（primary 链接样式），内容为 Agent 名列表——启用的正常色，`enabled === false` 置灰并缀「（已停用）」；每项可点 → `router.push({ path: '/agents', query: { keyword: agent.name } })` 后关闭 popover。
   - 无权限 / 数据缺失场景 `agents` 为空数组，自然落入 0 分支，无需特判。

### 4.4 P2 资源列表视图（admin）

1. **`ModelListView.vue`**：接入 `useAgentRelations`；「上下文窗口」列后新增「关联 Agent」列（宽 110，`RelatedAgentsPopover` + `agentsByModel(row.id)`）。
2. **`McpServerListView.vue`**：接入 composable；「状态」列后新增「关联 Agent」列（`agentsByMcpServer(row.id)`）；挂载 / `onActivated` 时 `load()`。
3. **`HttpToolListView.vue`**：见 §4.2 第 3 点。
4. **`SkillListView.vue`**：删除内联 `agents` ref 与 `/agents` 请求（`fetchSkillDocs` 收敛为只拉 `/skill-docs`），改用 composable；系统技能「关联 Agent」数字列替换为 `RelatedAgentsPopover` + `agentsBySkill(row.name)`（列宽 110 → 120）；个人技能 Tab 不加列（§2.2）。

### 4.5 P2 `AgentListView.vue`

1. **名称映射加载**：`onMounted` 时与 `refreshAgentData` 并行拉三份字典（均 fail-soft，失败置空 Map）——`/models/active` → `modelNameById: Map<number, string>`；`/mcp-servers` → `mcpNameById`（含停用行）；`/admin/http-tools?page=1&size=100` → `toolNameById`（取 `displayName`）。
2. **「默认模型」列**：置于「描述」列后（宽 140，show-overflow-tooltip）——`defaultModelId == null` → 文本「跟随全局默认」（muted 样式）；命中字典 → 模型名；未命中 → `#id（已停用）`。
3. **「能力概览」列**：替换原「Skills」列（宽 84 → 160）——单元格渲染 `技能 n · MCP n · 工具 n`（`skillNames / mcpServerIds / httpToolIds` 长度）；`el-tooltip` 内容按资源分行列具体名称，未命中的 id 显 `#id`，空类别显「—」。「经验数」列保持不变。
4. **「按模型筛选」下拉**：筛选栏「状态」后新增 `el-select`（clearable，选项 `/models/active` 的 `id + name`）；`modelFilter = ref<number | ''>`，`matchedAgents` 追加分支 `row.defaultModelId === modelFilter`；切换时重置页码。
5. **移动端卡片**：`mobile-card-row` 增加默认模型行与能力概览行（纯文本，不做 tooltip）。
6. **keyword 预填**：`onMounted` 读 `route.query.keyword`，为非空字符串时赋 `searchQuery` 再发起查询（配合 D9 直跳）。

### 4.6 文档同步

- `CHANGELOG.md`：顶部新建版本小节，按 **后端**（test 接口 `toolId`、create 接口 `copyFromId`）与 **管理后台**（测试开放、复制、四列表关联列、Agent 列表默认模型 / 能力概览 / 按模型筛选）分节记录。
- `README.md`：自定义 HTTP 工具行（L89 附近）补「已保存的工具可随时在列表直接测试（加密请求头自动沿用已存密文），支持一键复制」；不涉及其它章节。
- `DEPLOY.md`、`skills/mao-cli`：不改（无部署面 / CLI 面变化）。

## 5. 落地变更清单

| 端 | 文件 | 变更 | 新增/修改 |
|---|---|---|---|
| backend-ts | `src/http-tool/types.ts` | `HttpToolDraft.copyFromId` 可选字段 | 修改 |
| backend-ts | `src/http-tool/http-tool.service.ts` | `create` 支持 `copyFromId` 继承 `previousStored`；`resolveDraftForExecution` 改 async + `toolId` 掩码回填（私有 `resolveDraftHeaders`） | 修改 |
| backend-ts | `src/http-tool/http-tool-admin.routes.ts` | `optionalPositiveInt` 帮助函数；test 端点透传 `toolId`；`toDraft` 透传 `copyFromId` | 修改 |
| backend-ts | `src/http-tool/http-tool.service.spec.ts` | 调整 + 新增用例（见 §7.1） | 修改 |
| backend-ts | `src/http-tool/http-tool-admin.routes.spec.ts` | 新增（fastify inject + stub deps，参照 `approval-rule.routes.spec.ts` 模式） | 新增 |
| admin | `src/composables/useAgentRelations.ts` | 共享关联聚合 composable | 新增 |
| admin | `src/components/RelatedAgentsPopover.vue` | 共享关联展示组件 | 新增 |
| admin | `src/views/http-tool/HttpToolListView.vue` | 测试按钮开放 + `testToolId` 数据流 + 掩码提示三态；「复制」按钮 + `copySourceId` 预填 + `copyFromId` 提交；「关联 Agent」列 | 修改 |
| admin | `src/views/model/ModelListView.vue` | 「关联 Agent」列 | 修改 |
| admin | `src/views/mcp/McpServerListView.vue` | 「关联 Agent」列 | 修改 |
| admin | `src/views/skill/SkillListView.vue` | 内联 agents 数据收编进 composable；数字列升级为 popover | 修改 |
| admin | `src/views/agent/AgentListView.vue` | 「默认模型」列 + 「能力概览」列 + 按模型筛选 + 三份名称字典 + 移动端卡片两行 + `?keyword=` 预填 | 修改 |
| 文档 | `CHANGELOG.md`、`README.md` | 同步 | 修改 |
| 数据库迁移 | — | **无（零迁移）** | — |

## 6. 影响面与回归护栏

| 风险 | 护栏 |
|---|---|
| 带 `toolId` / `copyFromId` 后改 URL 即可把库内密文套到任意外部主机 | 已知取舍（提案 §6，2026-11-02 定）：本期不做 hostname 守卫；入口限 `http_tool:write` 管理员；后续收紧点已预留（`resolveDraftForExecution` / `create` 内补校验即可） |
| 解密后的真实凭据经测试响应 / 错误信息外泄 | 响应体结构不变（仅 status/body/notice/durationMs/error，无 headers 字段）；错误文案只引用键名不引用值；`cipher.decrypt` 失败按既有口径上抛、不静默丢头 |
| `resolveDraftForExecution` 改 async 波及调用方 | 全仓唯一调用方是 test 路由（已 grep 证实），同任务内同步 `await` |
| 复制继承把掩码当真实值落库 / 旧密文丢失 | 完全复用 `encodeHeaders` 既有顺序（掩码判断先于键敏感性判断，bugcheck 注释与用例已在位）；源不存在的掩码键直接拒绝保存，与编辑保存同口径 |
| 新建空表单手填 `******` 被误当成掩码 | 与现状一致：无解析源时 test / 保存均拒绝并提示填真实值；`encodeHeaders` 语义不变 |
| 无 `agent:read` 权限的管理角色打开资源列表页 | composable fail-soft：`/agents` 失败置空数组，关联列显 0，不阻塞本页主数据加载 |
| Agent 列表三份字典请求放大 | 三个轻量 GET 与 agents 列表并行一次拉取，页面级 `onMounted` 触发；HTTP 工具字典上限 100 行（`#id` 兜底，D7 已声明取舍） |
| 关联数据展示陈旧（在别的页改了 Agent 关联） | 各页 `onActivated` 重拉 composable / 字典；popover 数据本身允许秒级陈旧（展示用途，不做实时订阅） |
| popover 点击跳转后 Agent 列表未过滤 | `?keyword=` 预填在 `onMounted` 读取并参与服务端 keyword 查询；与既有搜索框状态共用一个 ref，无双源 |
| 名称字典缺项（模型被停用 / id 失效） | 统一 `#id` 兜底文案；不静默吞掉——管理员能看到「有引用但资源已停用」 |

## 7. 测试要点

### 7.1 后端单测（Vitest）

1. **`http-tool.service.spec.ts`**（调整 + 新增）：
   - `resolveDraftForExecution`：含掩码敏感头 + `toolId` → 返回 headers 含解密后的真实值（mock cipher）；掩码 + 未传 `toolId` → `PARAM_INVALID`（既有断言保持）；掩码 + `toolId` 查不到工具 → `HTTP_TOOL_NOT_FOUND`；掩码键在源工具不存在（改名场景）→ `PARAM_INVALID` 且文案含键名；非敏感键的掩码值同样从源回填（顺序回归，防掩码/敏感性判断换位）；非掩码值原样透传且**不**经历加密（mock encrypt 零调用）。
   - `create` + `copyFromId`：掩码敏感头 → 落库 `headersJson` 含源工具同一 `enc:` 密文（`tx.insert` 收到的对象断言）；掩码 + 新明文值 → 新密文 ≠ 源密文；掩码键改名 → `PARAM_INVALID`；`copyFromId` 查不到 → `HTTP_TOOL_NOT_FOUND`「源工具不存在」；不传 `copyFromId` → 行为与现状逐字节一致（`previousStored=null` 路径）。
2. **`http-tool-admin.routes.spec.ts`**（新增）：
   - `POST /v1/admin/http-tools/test`：body 带 `toolId` → service 收到第二参；`toolId=0` / `toolId='abc'` → 400 `PARAM_INVALID`「toolId 无效」；不传 → service 第二参 undefined。
   - `POST /v1/admin/http-tools`：body 带 `copyFromId` → draft 携带；非法值 → 400。
   - 权限：无 `http_tool:write` → 403（沿用现有路由测试口径）。

### 7.2 手工 / 集成验收

1. 含 `Authorization` 的工具保存后：列表直接点「测试」→ 实调成功且目标端收到真实 Token（服务端日志核对），编辑弹窗改 URL 后测试同样走已存密文；清空掩码 → 该头被删除；改名 → 提示填真实值。
2. 复制含密文头的工具 → 新工具列表即刻可见，不改任何字段直接测试 → 通；改路径 / 参数后保存 → 密文正确继承；复制时不传掩码改填新 Token → 新密文生效。
3. `ModelListView` / `McpServerListView` / `HttpToolListView` 的「关联 Agent」列数量与 popover 名单和 Agent 编辑表单的实际关联一致；停用 Agent 置灰标注；点击名单跳 `/agents?keyword=名称` 且列表已过滤。
4. `AgentListView`：默认模型列与编辑弹窗一致、未配显「跟随全局默认」；能力概览 tooltip 与实际 Skills/MCP/工具一致；按模型筛选结果正确、清除恢复；移动端宽度下卡片展示两行新信息。
5. 无 `agent:read` 权限的角色打开上述页面：关联列显 0，页面主功能不受影响。

### 7.3 构建验证

- `cd backend-ts && npm run build && npm test`（长输出落盘 `/tmp/mao-be.log`，grep `Test Files|Tests|FAIL` 摘要）。
- `cd admin && npm run build`（`vue-tsc -b && vite build`，**禁用** `npx vue-tsc --noEmit` 假通过路径）。
- desktop / android / agent-cli 本期零改动，随 CI 常规门禁。

## 8. 实施顺序与验收清单

实施顺序：后端 P1（types → service → routes）→ 后端单测 → admin 共享 composable/组件 → `HttpToolListView`（P1 测试/复制 + P2 关联列）→ `ModelListView` / `McpServerListView` / `SkillListView` → `AgentListView` → 构建验证 → 文档 / CHANGELOG。

- [ ] `HttpToolDraft.copyFromId` + `create` 继承 `previousStored`（源不存在报错、掩码解析与 `update()` 同口径）
- [ ] `resolveDraftForExecution(draft, toolId?)` async 化：掩码回填三态（回填成功 / 无 toolId 拒绝 / 键不匹配拒绝）
- [ ] test 路由透传 `toolId`、create 路由透传 `copyFromId`（正整数校验）
- [ ] `useAgentRelations.ts` + `RelatedAgentsPopover.vue` 落位（fail-soft、点击跳转）
- [ ] `HttpToolListView`：测试按钮开放 + `testToolId` 三来源 + 复制按钮 + `_copy`/`副本` 预填 + 关联列
- [ ] `ModelListView` / `McpServerListView` / `SkillListView` 关联列（Skill 收编 composable）
- [ ] `AgentListView`：默认模型列 + 能力概览列 + 按模型筛选 + 字典加载 + 移动端 + `?keyword=` 预填
- [ ] 两个 spec 文件用例全绿（service 调整 + routes 新增）
- [ ] backend build + test 全绿；admin `npm run build` 全绿
- [ ] CHANGELOG.md、README.md 同步完成
- [ ] 手工验收五件套（§7.2）：密文直测、复制继承、三列表反查、Agent 列表概览与筛选、无权限降级
