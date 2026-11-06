# 提案：搭好一个 Agent 不用在五个菜单里来回跑 —— 管理后台关联反查、工具复制与带密文测试

> 在管理后台（`admin`）日常运维模型、Agent、Skills、MCP 服务器和自定义 HTTP 工具时，管理员最常遇到的不是「功能没有」，而是**对象之间的关联全是单向盲盒**：
> 1. **删/停一个模型、MCP 或自定义工具前，不知道有哪些 Agent 正在用它**：`SkillListView.vue:162` 贴心地做了一列「关联 Agent」，但隔壁的**模型列表（`ModelListView`）**、**MCP 服务器列表（`McpServerListView`）**、**自定义 HTTP 工具列表（`HttpToolListView`）** 全都没有显示被哪些 Agent 关联——管理员停用一个旧模型或改一个自定义工具前，只能点开几十个 Agent 的编辑弹窗逐个翻；反过来在 **Agent 列表（`AgentListView`）** 里也只显示了 `Skills` 数量和 `经验数`，看不到每个 Agent 默认绑的是哪个模型、挂了几个 MCP 和自定义工具。
> 2. **自定义 HTTP 工具不支持「一键复制」，且含敏感请求头时无法直接测试**：Agent、模型、信号哨兵都有「复制」按钮，唯独字段最多（URL + 多个 Header + 十几个参数定义 + Body 模板）的**自定义 HTTP 工具（`HttpToolListView.vue`）没有「复制」**，配同一内部网关下的第 2 个接口得把全套鉴权头和公共参数从头手敲一遍；更难受的是第 67 行：一旦工具配了 `Authorization` 等敏感请求头，列表上的「测试」按钮就被**直接禁用**（`disabled="hasSensitiveHeader(row)"`），提示「请从编辑填写真实值后测试」——管理员想验一下已保存的工具今天还通不通，居然得先去找回明文 Token 重填一遍才能测！
- 状态：已落地（见 [README](README.md)）
- 日期：2026-11-02
- 提案总览见 [docs/proposals/README.md](README.md)
- 规模：小~中（两项合计约 1.5~2 人日；**零数据库迁移**，不动执行内核）
- 关联：`admin/src/views/http-tool/HttpToolListView.vue`、`backend-ts/src/http-tool/http-tool-admin.routes.ts`、`backend-ts/src/http-tool/http-tool.service.ts`、`admin/src/views/agent/AgentListView.vue`、`admin/src/views/model/ModelListView.vue`、`admin/src/views/mcp/McpServerListView.vue`

## 1. 背景与现状

### 1.1 现状逐项核对（代码可查）

| 痛点 | 现状 | 代码证据 |
|---|---|---|
| **自定义工具含敏感头时无法测试** | 列表上「测试」按钮写死 `:disabled="hasSensitiveHeader(row)"`，因为测试接口 `POST /v1/admin/http-tools/test` 只接受草稿明文、拒绝掩码 `******`，未支持像编辑保存那样「按工具 `id` 自动沿用库内已存密文」 | `HttpToolListView.vue:67, 421-429`、`http-tool.service.ts:190-198` |
| **自定义工具无「复制」** | `ModelListView`、`AgentListView`、`SignalWatchersView` 均有「复制」，`HttpToolListView` 只有「测试 / 停用 / 编辑 / 删除」 | `HttpToolListView.vue:64-80` |
| **管理后台各能力页缺乏关联反查** | 仅 `SkillListView.vue:162` 展示了「关联 Agent」计数；`ModelListView`、`McpServerListView`、`HttpToolListView` 均不展示关联了该资源的 Agent；`AgentListView` 表格也看不到各行的默认模型名与 MCP / HTTP 工具数 | `AgentListView.vue:48-111`、`ModelListView.vue:64-118`、`McpServerListView.vue:35-115` |

### 1.2 后果

- **维护自定义工具极度繁琐**：内部系统通常有统一的 `Authorization` 头和前缀 URL。现在每加一个接口都要重新输一遍 Token，且保存之后「测试」按钮就灰掉了，日后外部接口报错时管理员根本没法在后台点一下「测试」复现。
- **排障与变更心惊肉跳**：想下线一个模型或停用一个自定义工具时，不知道会影响哪几个 Agent；想在 Agent 列表一眼核对「哪些 Agent 还在用旧的 Sonnet 模型」，只能一个个点开编辑弹窗看。

## 2. 目标 / 非目标

**目标**

1. **P1 自定义 HTTP 工具补齐「一键复制」与「已存凭据直接测试」**：
   - **已存密文直接可测**：后端 `POST /v1/admin/http-tools/test` 增加可选 `toolId?: number` 参数——当传入 `toolId` 且某个敏感请求头的值为掩码 `******` 时，直接复用 `HttpToolService` 已有的 `previousStored` 密文解密逻辑（与 `update()` 保存时的 `encodeHeaders` 同源！），不再报错拒绝；前端去掉 `:disabled="hasSensitiveHeader(row)"`，无论工具是否含加密请求头，列表上和编辑弹窗里都能直接点「测试」实调！
   - **一键复制工具（含敏感请求头继承）**：`HttpToolListView.vue` 操作列增加「复制」按钮，打开预填的新建弹窗（名称自动加 `_copy` 后缀，展示名加 `副本`），若源工具含敏感请求头，保存时传 `copyFromId` 自动从源工具继承密文（与信号哨兵 0.0.361 的 `copyFrom` 机制完全同构）。
2. **P2 管理后台「Agent ⇄ 模型 / MCP / 自定义工具 / Skill」双向关联可见**：
   - **`AgentListView.vue`**：表格新增「默认模型」列（显示模型名称，未配显示「跟随全局默认」），并将原 `Skills` 单列升级为紧凑的能力概览（`Skills · MCP · 自定义工具` 数量徽标，悬停 tooltip 直接列出具体名称）；顶部筛选栏增加「按模型筛选」下拉。
   - **`ModelListView` / `McpServerListView` / `HttpToolListView`**：像 `SkillListView` 一样增加「关联 Agent」列（显示关联的 Agent 数量，悬停或点击 popover 列出具体 Agent 名称，点击名称可直跳 Agent 管理页），删除或停用前一目了然。

**非目标**

- 不改动 Agent 运行时的工具装配与权限校验逻辑。
- 不暴露自定义工具已加密请求头的明文（测试与复制全程在服务端内部解密或沿用密文，前端永远只见 `******`）。

## 3. 与已否决 / 已排除方向的边界

| 方向 | 本提案为何不是它 |
|---|---|
| 提示词回归评测 Evals（2026-10-05 否决） | 不做测试集、评分器或批量跑批；只是修通自定义工具单次「测试」按钮对已存加密头的支持。 |
| 能力体检（2026-10-24 否决） | 不建 `tool_call_log` 新表、不做自动淘汰建议；只是把 `agent` 表里已有的 `default_model_id / mcp_server_ids / http_tool_ids` 关联关系在管理表格里展示出来。 |
| Agent Bundle 导入导出（0.0.389 已移除） | 不做跨实例文件导入导出；「复制」是同实例内的表单预填克隆（与 Agent 复制、模型复制、哨兵复制完全一致）。 |

## 4. 方案设计

### 4.1 P1：自定义工具带密文测试与复制

- **测试支持 `toolId` 密文回填（`http-tool.service.ts`）**：
  - `resolveDraftForExecution(draft, toolId?: number)`：若某个敏感头的值是 `HEADER_VALUE_MASK`（`******`）：
    - 未传 `toolId` → 保持原报错「请填写真实值」；
    - 传了 `toolId` → 查 `repo.findById(toolId)`，从 `previousStored[key]` 解密出真实值用于本次测试请求（测试响应只返回目标接口的 HTTP status / body，绝不回传请求头明文）。
  - 前端 `HttpToolListView.vue`：移除 `hasSensitiveHeader` 对「测试」按钮的禁用；无论在列表行点「测试」还是在「编辑」弹窗里没改敏感头直接点「测试调用」，都带上 `toolId: editingId`，彻底打通「随时可测」。
- **复制支持 `copyFromId`**：
  - `HttpToolDraft` 增加可选 `copyFromId?: number`；`create()` 在 `previousStored` 参数上若传入了 `copyFromId`，则读取源工具的 `headersJson` 作为掩码头的回退源（仅一行改动，与 `update()` 共用同一个 `encodeHeaders(headers, previousStored, cipher)` 函数！）。

### 4.2 P2：双向关联展示（零后端新表，纯前端聚合）

- 管理后台 `SkillListView.vue:344` 已经在用的现成模式：`api.get('/agents', { params: { includeDisabled: true } })` 一次返回全部 Agent（含 `defaultModelId`、`skillNames`、`mcpServerIds`、`httpToolIds`）。
- 抽出一个轻量共享 composable `admin/src/composables/useAgentRelations.ts`：
  - 在 `ModelListView`、`McpServerListView`、`HttpToolListView`、`SkillListView` 中复用，计算出每个资源被哪些 Agent 引用（数量 + Agent 名称列表），悬停即见。
  - 在 `AgentListView` 中同时拉一次 `/models`（或复用选项接口），在表格中直接展示每个 Agent 的「默认模型」名称，以及 `Skills / MCP / HTTP 工具` 的关联详情。

## 5. 改动面

| 端 | 改动 |
|---|---|
| backend-ts | `http-tool.service.ts` / `http-tool-admin.routes.ts`：`test` 接口支持可选 `toolId` 回填已存敏感头密文；`create` 接口支持可选 `copyFromId` 继承敏感头 |
| admin | `HttpToolListView.vue`（开放含敏感头工具的测试按钮 + 新增「复制」按钮 + 关联 Agent 列）；`AgentListView.vue`（展示默认模型与 MCP/HTTP 工具数 + 按模型筛选）；`ModelListView.vue` / `McpServerListView.vue`（新增关联 Agent 列） |
| 数据库迁移 | **无（零迁移）** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 带 `toolId` / `copyFromId` 沿用已存密文后，把 URL 改指外部服务器即可将库内敏感请求头套走 | 已知取舍（2026-11-02 定）：本期**不做** hostname 一致性守卫；工具编辑与测试本就限于管理员，后续如需收紧可在 `resolveDraftForExecution` / `create` 补校验 |
| Agent 数量较多时前端聚合开销 | 单实例 Agent 数量通常在几個到几十个量级，内存 Map 聚合耗时 < 1ms |

## 7. 测试要点

1. 自定义工具测试：含加密请求头的已存工具，传入 `toolId` 后测试调用成功发出真实解密头（不再要求 URL 与保存时一致）；未传 `toolId` 且敏感头仍为掩码 `******` 时，保持提示「请填写真实值」。
2. 自定义工具复制：基于已有工具复制并保留掩码请求头（如同网关下改路径或参数），新工具创建成功且密文正确继承。
3. 管理后台关联展示：Agent 列表正确展示默认模型名称及 Skills / MCP / HTTP 工具计数；模型 / MCP / HTTP 工具列表正确显示关联它的 Agent 数量与名称。
