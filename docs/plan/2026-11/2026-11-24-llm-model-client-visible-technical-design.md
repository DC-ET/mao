# 模型「客户端可选」技术方案

- 状态：已实现（迁移 `V205`；2026-11-24 按评审意见修正通道误伤、边路会话与前端竞态）
- 日期：2026-11-24
- 评审：2026-11-24 杨佳毅确认守护口径——**后台配置了默认模型的情况下允许用户使用，只是客户端模型列表不展示**。据此定稿 D6，并把「客户端新建会话遵循 Agent 默认模型」纳入本次（§8.2），不再列为后续项。
- 一句话：模型沿用 Agent 已有的 `client_visible` 语义——默认可见；关掉后仍可被 Agent 默认模型、飞书/钉钉/微信机器人与网页浮窗使用，只是不再出现在客户端新建会话与会话内切换模型的候选列表里。
- 关联代码（撰写时已核实，均为当前工作区 `main`，`c7b0a634`）：
  - 模型表与启用位：`backend-ts/db/migration/V001__init_schema.sql:59`（`llm_model`）；`model_type` 见 `V063`/`V066`
  - 启用列表 SQL：`backend-ts/src/model/model.repository.ts:63-67`（`listActiveText`：`status = 1 AND model_type = 'text'`）
  - 客户端唯一的模型选择入口：`desktop/src/components/chat/ModelSelector.vue:72`（`GET /models/active`），由 `ChatInputToolbar.vue:68` 在新建态与会话内共用
  - 新建态默认模型：`desktop/src/views/task/TaskView.vue:1603-1612`（`GET /models/default` 填入 `newTaskModelId`）；`useChat.ts:464-475` → `stores/session/list.ts:517+`（`payload.modelId`）
  - 会话内切换模型：`desktop/src/components/chat/ChatPanel.vue:871-882` → `PATCH /v1/sessions/:id`（`session.routes.ts:508-522` → `session.service.ts:1635-1637`）
  - 另外两条客户端模型入口：WS `send_message` 的 `data.modelId`（`streaming-ws-handler.ts:991-995`，走 `updateModelId`）；WS `create_side_session` 的 `data.modelId`（同文件 `:1634`）直接落库，已补同口径校验
  - 运行时解析链：`backend-ts/src/harness/core/harness-service.ts:345-357`（`session.model_id` → `agent.default_model_id` → 全局默认）
  - Agent 的同名字段（本次的照抄对象）：`V164__agent_client_visible.sql`、`agent.repository.ts:21-31`、`agent.routes.ts:127-138`（`scope=client`）、`agent.service.ts:88-95`（默认 Agent 必须客户端可见）、`AgentFormDialog.vue:129-135`、`AgentListView.vue:91-93`、`session.service.ts:1641-1652`（切换 Agent 时校验）
  - 模型其余消费方：`admin/src/views/agent/AgentFormDialog.vue:744`（Agent 默认模型下拉）、`AgentListView.vue:388`（模型名字典）、`FeishuBotListView.vue:232`、`DingtalkBotListView.vue:188`、`desktop/src/components/usage/UsageFilterBar.vue:60`、`desktop/src/components/chat/ChatPanel.vue:678` 与 `SideChatPanel.vue:573`（视觉能力判断）、`agent-cli/src/rest/rest-client.ts:75`（`mao chat` 选模型）
  - 浮窗助手：`backend-ts/src/embed/embed.routes.ts`（`/v1/embed/admin-config` 只给 `agentId`）、`admin/src/composables/useEmbedChat.ts`、`sdk/embed/src/core/session-manager.ts:63`（创建会话**不传** `modelId`）
- 关联方案：[模型凭证方式双轨](./2026-11-19-llm-model-ecp-token-auth-technical-design.md)（最近一次改 `llm_model` 结构与表单的改动）。Agent 侧的同名字段没有独立方案，直接落在 `V164` 迁移与上述代码里。

## 1. 现状与问题

模型的「客户端能不能选」今天只有 `status` 一个开关：

- `GET /v1/models/active` 直接返回全部 `status = 1 AND model_type = 'text'` 的模型，不看调用者是谁（`model.routes.ts:78-82` → `model.service.ts:180-182` → `model.repository.ts:63-67`）。
- 客户端唯一的模型选择器就吃这份列表（`ModelSelector.vue:72`），新建会话和会话内切换共用同一个组件。`ChatInputToolbar.vue:68` 把它放在输入框工具条上。
- 管理后台可以把任一启用模型配成某个 Agent 的默认模型（`agent.default_model_id`，`V102`），运行时解析链是「会话显式指定 → Agent 默认模型 → 全局默认」（`harness-service.ts:345-357`）。但没有任何字段能把「这个模型只给后台配置用、别出现在客户端选择器里」表达出来。
- 客户端新建会话默认会显式带上 `modelId`：`TaskView.vue:1603-1612` 拉 `/models/default` 填进 `newTaskModelId`，`useChat.ts` 创建会话时作为 `payload.modelId` 落库。也就是说**客户端新建的会话几乎总是固定住了模型，`agent.default_model_id` 只在会话 `model_id` 为空时才生效**。本次不改这个机制，只把预填值的优先级改成「Agent 默认模型优先」（§8.2），让后台配好的默认模型在客户端也真正生效。
- 网页浮窗（`sdk/embed`）创建会话不传 `modelId`（`session-manager.ts:63`），所以它正好走 `agent.default_model_id`。用户描述的「固定渠道用某个模型、客户端不给选」在浮窗这一侧是成立的，缺的只是「不给选」的表达能力。
- 服务端对客户端传入的 `modelId` 没有任何校验：既不看模型是否存在、是否启用，也不看是否允许客户端使用（`session.service.ts:114-170` 只校验 Agent 的 `enabled`）。切模型同理（`updateModelId` 只写字段）。

Agent 侧已经解决了同类问题：`agent.client_visible`（`V164`）与 `GET /v1/agents?scope=client`，客户端 `stores/agent.ts:32` 只拉可见列表。模型没有对应的字段与参数，这就是本次要补齐的差距。

另有一处 Agent 的既有缺口值得记录、但不在本次范围：创建会话时**不**校验 `agent.client_visible`，只有会话内切换 Agent 校验（`session.service.ts:1641-1652`，调用点在 `updateSessionAgent`）。所以「关掉客户端可见」在 Agent 上也只是列表过滤 + 切换校验，不是严格的服务端边界。

## 2. 目标与非目标

### 2.1 目标

1. 模型新增「客户端可选」开关，默认开启；存量模型升级后全部保持可见，行为不变。
2. 关掉后，该模型不再出现在客户端新建会话与会话内切换模型的候选列表里（桌面、Web、安卓、`mao chat`）。
3. 关掉**不影响**：Agent 默认模型（管理后台仍可把它设为任意 Agent 的默认模型，客户端新建会话选中该 Agent 时会用它）、全局默认模型、飞书/钉钉/微信机器人配置、网页浮窗、系统参数（审批预审、压缩摘要、标题生成、语音合成等）、已绑定该模型的会话继续对话。
4. 管理后台模型列表能看出每个模型是否客户端可选，并能按此筛选；新建/编辑对话框能改这个开关。
5. `mao model` 能读写这个字段。

### 2.2 非目标

- **不做模型级授权**（按用户/角色限制「能用哪些模型」）。本需求是「可选性」，不是权限与成本边界。要防成本滥用，应另做「模型可用角色」之类的需求。
- 不改运行时解析链、不改 `agent.default_model_id` 的生效规则。客户端新建会话仍显式落 `model_id`（不改成留空交给后端解析），只是预填值改为「Agent 默认优先」（§8.2）。
- 不改 audio / image 模型的自动挑选（`findFirstActiveByType`，`model.service.ts:184-191`）。客户端本来就没有语音、文生图模型的选择入口，这两类不消费该字段。
- 不改 Agent 的可见性行为（含上面说的创建会话不校验这一处缺口）。
- 不改管理后台的会话查看（只读，没有改模型的入口，`admin-session.routes.ts` 只有查询/归档/删除）。
- 不收紧 `GET /v1/models/:id`：客户端会话回显模型名要用它（`useModelName.ts`），本期维持只要求登录。
- 不做「按 Agent 限制模型候选」或「模型-角色」矩阵。

## 3. 决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 字段 | `llm_model.client_visible TINYINT NOT NULL DEFAULT 1`，含义与 `agent.client_visible` 一致 | 同名字段、同义语义，管理员不需要学第二套概念；默认 1 让升级无感 |
| D2 | 语义边界 | 只影响「客户端选择器的候选列表」。不影响运行时解析、不影响管理端下拉、不影响已绑定会话 | 需求就是「不给用户选」，不是「不许使用」。一旦影响运行时，浮窗与 Agent 默认模型立刻失效 |
| D3 | 过滤点 | 接口加参数：`GET /v1/models/active?scope=client`；**不带** `scope` 保持今天的全量语义 | 与 `GET /v1/agents?scope=client` 完全对称。管理后台的 Agent 默认模型下拉、机器人模型下拉必须能选到隐藏模型，全量默认值让这些调用方一行不改 |
| D4 | 默认模型约束 | `is_default = 1` 的模型必须 `client_visible = 1`，创建/更新时校验，非法组合 400 | 与 Agent「默认 Agent 必须客户端可见」一致。否则客户端新建态从 `/models/default` 拿到的模型不在候选列表里，选择器显示一个选不回来的名字 |
| D5 | 类型范围 | 三个 Tab（text/audio/image）都存、都展示开关；本期只有 text 有消费方 | 表单按 Tab 切换时字段忽然消失更让人困惑；而 audio/image 客户端无选择入口，多一个开关不产生行为差异 |
| D6 | 服务端守护 **（2026-11-24 已确认）** | 客户端路径（创建会话带 `modelId`、`PATCH` 改模型）校验：模型存在未删、`status = 1`；`client_visible = 0` 时**仅当它等于该会话 Agent 的 `default_model_id`** 才放行 | 评审结论：「后台配置了默认模型的情况下允许用户使用，只是客户端模型列表不展示」。这条规则正是这个口径：后台给 Agent 配的默认模型放行，用户自己挑的隐藏模型拒绝 |
| D7 | `/v1/models/:id` | 维持只要求登录，不按 `client_visible` 过滤 | 会话回显、边路对话的模型名与上下文窗口都要按 id 查；靠 id 猜到隐藏模型不构成现实风险 |
| D8 | 隐藏模型与当前会话 | 客户端选择器里若当前模型不在候选列表（历史会话用的隐藏模型），列表顶部追加一条「当前模型」只读项并标「仅管理端」 | 用户能看到自己正在用什么；切走之后确实选不回来，这是设计使然，标注比静默隐藏诚实 |
| D9 | 管理后台列表 | 「客户端可选」放成名称列的标签（`仅管理端`）+ 筛选下拉，与 Agent 列表同款 | 复用既有视觉语言，不新增列宽 |
| D10 | mao-cli | `model create/update` 加 `--client-visible 0\|1`（create 缺省 1，update 传了才改），`model list` 输出该字段；`mao chat` 的候选与按名解析改用 `scope=client`，但显式 `--model <id>` 与配置里的默认模型 id 不受限 | CLI 是客户端，浏览式选择应遵守可见性；脚本里写死的 id 不应因为一次后台配置而报错 |
| D11 | 权限 | 复用 `model:read` / `model:write`，不新增权限点 | 改的是模型配置的一部分，与今天改 `status` 同级 |
| D12 | 迁移 | `V205__llm_model_client_visible.sql`，只加列不回填 | 存量行为即「全部可见」，默认值就是回填结果 |

## 4. 可见性规则

记客户端为「桌面 / Web / 安卓 / `mao chat`」，管理端为「管理后台与所有后台配置」。

```text
客户端候选 = { m | m.deleted = 0, m.status = 1, m.model_type = 'text', m.client_visible = 1 }
运行时可解析 = { m | m.deleted = 0, m.status = 1 }              ← 与今天一致，不看 client_visible
```

三处判断：

1. **列表**：`GET /v1/models/active?scope=client` 只返回「客户端候选」；不带 `scope` 返回「运行时可解析」里的 text 模型（今天的行为）。
2. **创建会话**（`POST /v1/sessions`，`modelId` 非空）与**切换模型**（`PATCH /v1/sessions/:id`，`modelId` 非空）：
   - 模型不存在或已软删 → `MODEL_NOT_FOUND`；
   - `status != 1` → 400「该模型已停用」；
   - `client_visible = 0` 且 `model.id != agent.default_model_id` → 400「该模型不对客户端开放」。
   - 不传 `modelId` 不校验，落 `NULL`，运行时走解析链。
3. **管理端**：`GET /v1/models`（分页，需 `model:read`）返回全量并带 `clientVisible`，支持 `clientVisible=0|1` 筛选。

例子：`gpt-5-pro` 设为「仅管理端」，配成「客服浮窗」Agent 的默认模型。

| 入口 | 结果 |
|---|---|
| 桌面新建会话的模型下拉 | 看不到 `gpt-5-pro` |
| 桌面会话内切换到 `gpt-5-pro` | 看不到；若该会话正用着它（历史遗留），顶部显示当前模型并标「仅管理端」 |
| 网页浮窗（不传 modelId） | 会话 `model_id` 为空 → 解析到 Agent 默认模型 `gpt-5-pro`，正常使用 |
| 桌面新建会话选中该 Agent | 前端按该 Agent 的 `default_model_id` 预填 `gpt-5-pro`（§8.2），会话正常创建并使用；下拉里仍不出现它，只作为「当前模型」只读项 |
| 直接 `curl` 创建会话带 `modelId=<gpt-5-pro>` | 400；除非该 Agent 的 `default_model_id` 就是它 |
| 飞书 / 钉钉机器人的模型下拉 | 仍能选到 `gpt-5-pro` |
| 已绑定 `gpt-5-pro` 的老会话 | 继续对话、压缩、标题生成全部照旧 |

## 5. 数据模型

落地文件：`backend-ts/db/migration/V205__llm_model_client_visible.sql`。撰写时仓库最大为 `V204__system_command_role_visibility.sql`；若先落地了别的迁移，以当时最大号顺延，文件名里的 `V205` 与注释一起改。

```sql
-- 客户端可选性：与 status（启用）分开，避免「只想不在客户端暴露」时被迫停用整个模型。
-- 默认 1：存量模型全部保持客户端可见，升级无感。与 agent.client_visible（V164）同义。
ALTER TABLE `llm_model`
    ADD COLUMN `client_visible` TINYINT NOT NULL DEFAULT 1
        COMMENT '1-客户端新建会话可选 0-仅管理端可配置（Agent 默认模型/渠道仍可用）' AFTER `status`;
```

不加索引：`llm_model` 是小表，列表页与 `listActiveText` 都是全表扫，加索引没有收益。

## 6. 后端

### 6.1 类型与契约

- `backend-ts/src/model/types.ts` 的 `LlmModel` 增加 `clientVisible?: number | null`；`LlmModelRepository` 的 `listActiveText` 改为 `listActiveText(clientVisibleOnly?: boolean)`。
- `shared/contracts/src/model.ts` 的 `ModelVO` 增加 `clientVisible?: boolean`（与 `agent.ts:35` 同风格），`ModelListFilter` 增加 `clientVisible?: number | null`。
- `toVO`（`model.routes.ts:190-218`）输出 `clientVisible: entity.clientVisible !== 0`——与 `agent.routes.ts:361` 的归一写法一致，NULL/缺失一律按可见处理（兼容未跑迁移的旧库与旧前端）。

### 6.2 读写

`MysqlLlmModelRepository`：

- `listActiveText(clientVisibleOnly)`：`clientVisibleOnly` 为真时追加 `AND client_visible = 1`。
- `insert` / `updateById` 增加 `clientVisible: model.clientVisible ?? 1`。
- 新增 `countActiveTextExcept(id)` 不需改（与可见性无关）。

`ModelService`：

- `listActiveModels(clientVisibleOnly?: boolean)` 透传。路由 `GET /v1/models/active` 解析 `scope`：`client` → true，空 → false，其他值 400（照抄 `agent.routes.ts:127-131` 的 `scope 仅支持 'client'`）。
- `createModel` / `updateModel` 增加末位参数 `clientVisible?: number | null`（沿用现有长参数列表的风格，不顺手重构成对象参——不在本次范围）。归一：`clientVisible === 0 → 0，其余 → 1`。
- D4 校验放在 service，创建与更新都要过：
  - `isDefault === 1 && clientVisible === 0` → 400「默认模型必须对客户端可见」。
  - 更新时若只改 `clientVisible = 0` 而该模型当前是默认模型，同样 400（先取消默认再隐藏）。
- `updateStatus` 不动：停用与可见性正交。停用中的模型即使 `client_visible = 1` 也不会出现在两个列表里。

### 6.3 客户端守护（D6）

`SessionService` 新增两个方法（第二个参数语义不同，别传错）：

```ts
/** 客户端选择模型的合法性：存在、启用；不可见模型只放行「该 Agent 的默认模型」。
 *  第二参数是 Agent 的 defaultModelId（调用方已解析好 Agent，避免重复查库）。 */
async assertModelSelectableByClient(modelId: number, agentDefaultModelId: number | null | undefined): Promise<void>

/** 同上，但按 Agent id 解析默认模型：WS 边路会话等拿不到 Agent 对象时用。 */
async assertModelSelectableForAgent(modelId: number, agentId: number | null): Promise<void>
```

- `findById` 为空 → `MODEL_NOT_FOUND`。
- `status !== 1` → `PARAM_INVALID`「该模型已停用」。
- `clientVisible === 0`：取 `agentId` 对应 Agent 的 `defaultModelId`，相等则放行，否则 `PARAM_INVALID`「该模型不对客户端开放」。

调用点与边界（**评审修正**）：

- `createSession` 加了末位可选参数 `opts?: { enforceClientModel?: boolean }`，**只有 `POST /v1/sessions`（客户端 HTTP 入口）传 true**。飞书/钉钉等内部通道用同一方法建会话、把「机器人配置的模型」作为显式 `modelId`，它们不传这个开关 → 不受客户端可见性限制（需求要求关掉可见性后渠道照常可用）。微信通道自建会话、OpenAPI/浮窗不传 `modelId`，同样不受影响。
- `updateModelId(sessionId, modelId)`：先 `sessionRepo.selectById` 拿 `agentId`，再经 `agentLookup.findById` 取默认模型。签名不变。HTTP `PATCH` 与 WS `send_message` 两条客户端入口都覆盖。
- WS `create_side_session`：边路会话直接 `save` 落库、不经 `createSession`，客户端可控 `data.modelId`。只在「显式传入且与父会话模型不同」时调用 `assertModelSelectableForAgent(modelId, parentSession.agentId)`（继承父会话的隐藏模型是合法场景）；失败回 `error` 事件，不建会话。
- `PATCH /v1/sessions/:id` 里 `agentId` 的更新提到 `modelId` 之前：模型可见性按「切换后的 Agent」判定，避免用旧 Agent 的默认模型放行/误拒。

`updateSessionAgent` 与其他 Agent 逻辑均不动。

### 6.4 接口一览

| 方法 | 路径 | 变化 |
|---|---|---|
| GET | `/v1/models` | 新增可选 `clientVisible=0\|1` 筛选；每条记录带 `clientVisible` |
| GET | `/v1/models/active` | 新增可选 `scope=client`；`clientVisible` 字段随 VO 一起返回 |
| GET | `/v1/models/:id` | 无变化（只多一个字段） |
| GET | `/v1/models/default` | 无变化 |
| POST | `/v1/models` | body 增加可选 `clientVisible: boolean \| 0\|1`，缺省可见 |
| PUT | `/v1/models/:id` | 同上；不传则保持原值（与 `status` 的既有写法一致：`updateModel` 会把 undefined 归一成 1，**这里要改成「未传 = 保持」**，见下） |
| PATCH | `/v1/models/:id/status` | 无变化 |
| POST | `/v1/sessions` | `modelId` 走 §6.3 校验 |
| PATCH | `/v1/sessions/:id` | `modelId` 走 §6.3 校验 |

`updateModel` 现有风格就是「传了才改」（`if (name != null) model.name = name`，`model.service.ts:283-301`），`clientVisible` 照这个写法即可：`if (clientVisible != null) model.clientVisible = clientVisible === 0 ? 0 : 1`。`ModelFormDialog` 每次提交都带全量表单，所以后台编辑总是显式写入；CLI/第三方不传时保持原值。

## 7. 管理后台

`admin/src/views/model/ModelListView.vue`：

- 名称列（`:69-84`）在「默认」「ECP」「视觉」标签旁加一个：`row.clientVisible === false` 时显示 `<el-tag type="warning" size="small">仅管理端</el-tag>`，文案与 `AgentListView.vue:91-93` 完全一致。
- 筛选栏加「客户端可选」下拉（全部 / 可选 / 仅管理端），`fetchModels` 把 `params.clientVisible` 传出去（`ModelListView.vue:330-350`）。三个 Tab 都加，不做类型区分。
- 移动端卡片（`:124-150`）在标题行加同一个标签，操作区不变。

`admin/src/views/model/ModelFormDialog.vue`：

- 基本信息 Tab 的「默认模型」项下方加「客户端可选」开关：

  ```vue
  <el-form-item label="客户端可选">
    <el-switch v-model="form.clientVisible" :disabled="form.isDefault" />
    <div class="form-hint">
      关闭后，客户端「新建会话」与「切换模型」不再展示该模型；Agent 默认模型、机器人、浮窗与已绑定会话不受影响。
      默认模型必须保持客户端可选。
    </div>
  </el-form-item>
  ```

- `form` 增加 `clientVisible: true`；`resetForm` 与编辑/复制回显都按 `props.modelData.clientVisible !== false` 取值（与 `AgentFormDialog.vue:683` 同款）。
- 提交 payload 加 `clientVisible: form.clientVisible`（布尔即可，后端归一）。`isDefault` 已在前端互斥禁用，服务端仍兜底校验（D4）。
- 复制（`mode === 'copy'`）沿用源模型的可见性，不强制重置为可见。
- 该开关放在「基本信息」而不是「接入配置」：它描述的是「对外怎么被看到」，与 `isDefault`、`supportsVision` 同类。

其余管理端页面（`AgentFormDialog` 的默认模型下拉、两个机器人页的模型下拉）**不改**：它们不带 `scope`，继续拿全量，这正是「后台配隐藏模型」的入口。Agent 保存时的 `requireEnabledModel`（`agent.service.ts:260-268`）本来就只校验「存在且启用」，不看 `client_visible`，所以把隐藏模型存成 Agent 默认模型不会触发任何额外改动。

## 8. 桌面 / Web / 安卓

### 8.1 选择器（唯一改动点）

`desktop/src/components/chat/ModelSelector.vue:72`：

```ts
const { data } = await api.get('/models/active', { params: { scope: 'client' } })
```

`props.modelId` 不在返回列表且非空时，在列表顶部插入一条只读项（本地构造，靠 `useModelName` 补名字，`supportsVision` 未知按 false 处理），渲染时与普通项区分：右侧加「仅管理端」标签、点击不 emit `select`。会话内它对应「历史会话沿用隐藏模型」；新建态它对应「Agent 默认模型是隐藏模型」（§8.2），两种都要显示，用户才知道当前用的到底是什么。

其余客户端页面**不改**：

- `ChatPanel.vue:678`、`SideChatPanel.vue:573` 用 `/models/active` 判断视觉能力。它们不是选择器；保持全量能少一类「当前会话用的是隐藏模型 → 查不到 → 误判不支持视觉」的回退。已有会话本来就走 `session.modelSupportsVision`（`ChatPanel.vue:552-562`）。
- `UsageFilterBar.vue:60` 是用量页的模型筛选，用户筛的是「自己的调用记录」。保持全量，否则历史用过的隐藏模型在明细里有、筛选项里没有，像 bug。

### 8.2 新建态默认模型：Agent 默认优先（评审定稿）

现状是新建态一律用全局默认模型预填（`TaskView.loadDefaultModel`），它把 Agent 的默认模型覆盖掉了。评审确认「后台配置了默认模型的情况下允许用户使用」，所以这里改为**三级预填**：

```text
用户手动选过模型（newTaskModelTouched = true） → 用用户选的
否则选中的 Agent 有 defaultModelId            → 用 Agent 默认模型（即使 client_visible = 0）
否则                                          → 全局默认模型（D4 保证可见）
```

实现点：

- `desktop/src/stores/agent.ts` 的 `Agent` 类型补 `defaultModelId?: number | null`。`GET /v1/agents` 与 `/v1/agents/:id` 的 VO 已经返回这个字段（`agent.routes.ts:361-363`），后端不用改。
- `ChatPanel.handleNewTaskAgentChange`（`:950-955`）已经在切 Agent 时 `fetchAgent(id)`，拿到详情后按上面的规则重算 `newTaskModelId`；`TaskView.enterNewTaskMode`（`:1308-1365`）同样按规则预填，替换现在的「`defaults.modelId` 有就填、否则 `loadDefaultModel()`」。
- 新增 `newTaskModelTouched`（`TaskView` 提供、`ChatPanel` 的 `handleModelSelect`/`handleModelSwitch` 置 true）：用户手选过模型后，再切 Agent 不覆盖他的选择；没手选过就一直跟随 Agent 默认。`enterNewTaskMode` 进入时重置为 false。
- `previous.modelId` 与 `defaults.modelId`（来自「上次用过的会话」）只在「该模型仍可用」（可见，或等于当前 Agent 的默认模型）时才预填，否则按上面的规则回退。判据用一次 `GET /v1/models/active?scope=client` 的缓存 + 当前 Agent 的 `defaultModelId`；避免给用户一个必然被 §6.3 拒绝的默认值。
- 发送前不再单独校验：服务端已兜底。

### 8.3 浮窗与 SDK

不改。`sdk/embed` 与 `admin/src/composables/useEmbedChat.ts` 不读模型列表、创建会话不传 `modelId`（`session-manager.ts:63`），天然走 Agent 默认模型。给浮窗 Agent 配好隐藏模型即可生效，这正是需求场景。

### 8.4 会话内切换

`ChatPanel.vue:871-882` 与 `SideChatPanel.vue:927-930` 的切换走 `PATCH /v1/sessions/:id`，候选来自 §8.1 的列表。切到不可见模型只可能来自「当前模型项」（不可点）或构造请求，服务端按 §6.3 拒绝，前端已有的失败回滚与「模型切换失败，请重试」提示保持不变。

## 9. mao-cli

`skills/mao-cli/lib/commands/model.js` 与 `skills/mao-cli/reference/model.md`：

| 命令 | 变化 |
|---|---|
| `model list` | 输出增加 `clientVisible`；新增筛选 `--client-visible 0\|1` |
| `model get` | 输出增加 `clientVisible` |
| `model create` | 新增 `--client-visible 0\|1`，缺省 1 |
| `model update` | 同上；不传则不改 |

`agent-cli`（`mao-agent`）里 `mao chat` 的模型列表与按名解析：

- `RestClient.listActiveModels()`（`rest-client.ts:75-77`）增加可选参数，`mao chat` 调用处传 `scope=client`（`commands/chat.ts:76`、`:404`、`session/session-runner.ts:852`）。
- 显式 `--model <id>` 与配置里的 `defaultModelId` 不走列表校验（`resolveModelId` 当前对 `fallbackId` 已直接返回，`session-runner.ts:873`），保持脚本可用。
- 会话已在用隐藏模型时，banner 的名字解析会落到 `spec` 原值（`chat.ts:404-415` 是 `found?.name || spec`），不报错。

## 10. 测试

后端：

- `model.service.spec.ts`
  - `listActiveModels(true)` 只含 `client_visible = 1`；`listActiveModels()` 与 `listActiveModels(false)` 与今天一致。
  - 创建缺省 `clientVisible = 1`；`clientVisible = 0` 落 0。
  - `isDefault = 1 && clientVisible = 0` → 400；更新时把默认模型设为不可见 → 400；先取消默认再隐藏 → 通过。
  - 更新不传 `clientVisible` 时保持原值。
  - 停用与可见性正交：`clientVisible = 1` 但 `status = 0` 的模型不出现在任一列表。
- `model.routes.spec.ts`
  - `GET /v1/models/active` 不带 `scope` = 全量；`scope=client` 只含可见；`scope=foo` → 400。
  - `GET /v1/models?clientVisible=0` 过滤生效；VO 带 `clientVisible`（`0` → `false`）。
  - 创建/更新 body 带 `clientVisible` 透传到 service。
- `session.service.spec.ts`
  - 创建会话带不可见模型的 `modelId` → 400；该模型等于 Agent `defaultModelId` → 通过。
  - 创建会话带停用模型 → 400；带不存在 id → `MODEL_NOT_FOUND`。
  - `updateModelId` 对不可见模型同样拒绝；对 Agent 默认模型放行。
  - 不传 `modelId` → 不查模型，`session.model_id` 为 NULL（现有用例保持通过）。
- `session.routes.spec.ts`：PATCH 的校验错误码透出。

前端：

- `desktop` 现有 `ModelSelector` 相关用例（若有）补一条：请求带 `scope=client`；当前模型不在列表时出现只读的「当前模型」项。
- 新建态预填（单元或组件测试，按现有 TaskView/ChatPanel 测试方式）：
  - 选中 Agent 有 `defaultModelId` 且该模型不可见 → `newTaskModelId` 等于它，创建请求带这个 id；
  - 未手选模型时切换 Agent → 模型跟着新 Agent 的默认模型变；用户手选模型后切换 Agent → 保留用户选择；
  - `previous.modelId` 是隐藏模型且不等于当前 Agent 默认 → 不预填，回退 Agent 默认或全局默认。
- 新增 Playwright `tests/admin-model-client-visible.spec.ts`（照 `tests/admin-agent-client-visible.spec.ts` 的 mock 结构）：列表出现「仅管理端」标签；编辑对话框开关可切换并随 `PUT /models/:id` 提交 `clientVisible: false`；`isDefault` 为真时开关禁用。

手工验收（发布前）：

1. 新建模型 `A` 保持默认可见，新建模型 `B` 关掉「客户端可选」。
2. 桌面新建会话：下拉只有 `A`；会话内下拉只有 `A`。
3. 把 `B` 设为某 Agent 的默认模型，用网页浮窗与该 Agent 新建会话 → 对话正常，用量记录挂在 `B` 上。
4. 飞书/钉钉机器人模型下拉仍能选到 `B`。
5. 把一个可见模型 `C` 停用：客户端与后台下拉都消失（既有行为）。
6. 把 `A`（全局默认）尝试关掉客户端可选 → 保存被拒。

## 11. 文档与发布

实现时同步：

- `changelog/unreleased/` 新增一条：管理后台写「模型可设为仅管理端可选」；桌面/Web/安卓写「新建与切换模型不再展示仅管理端模型；新建会话默认模型改为 Agent 默认优先」；终端 CLI 写 `model --client-visible` 与 `mao chat` 候选变化。
- `skills/mao-cli/reference/model.md`、`reference/admin.md`（模型一节加一句可见性说明）。
- `shared/contracts` 的 `ModelVO` 注释补一句语义（「只影响客户端选择器，不影响运行时解析」）。
- 不改 `docs/plan/2026-11/2026-11-19-llm-model-ecp-token-auth-technical-design.md` 等历史方案。

无单独上线步骤。迁移加列默认 1，先发后端再发前端也不会有行为差异；前端发版前，客户端仍会看到全部启用模型（老行为）。

## 12. 实施顺序

1. 迁移 `V205`；`types.ts` / `contracts` 加字段；repository 的 `listActiveText` 与 insert/update。
2. `ModelService` 的归一与 D4 校验；`GET /models/active` 的 `scope`；`GET /models` 的筛选。
3. `SessionService.assertModelSelectableByClient` 与两个调用点。
4. 后端 spec。
5. 管理后台：列表标签/筛选、表单开关、移动端卡片。
6. 桌面：`ModelSelector` 带 `scope=client` 与「当前模型」项；`Agent` 类型补 `defaultModelId`；`TaskView` / `ChatPanel` 的三级预填与 `newTaskModelTouched`。
7. `mao-cli` 的 `--client-visible`、`mao chat` 的 `scope=client`；reference 与 changelog。
8. 验证：`cd backend-ts && npm test`；`cd admin && npm run build`；`cd desktop && npm run build`；`cd agent-cli && npm run build && npm test`；根目录 `npm test`（含新增 E2E，需先起 admin :5200 / desktop :5201）。

## 13. 风险

1. **它不是权限边界。** 用户绕过前端直接 `POST /v1/sessions` 带隐藏模型 id 会被 §6.3 拒绝，但拿着 id 调 `GET /v1/models/:id` 仍能读到名称与参数，管理后台的 `llm_call` 流水里也能看到该模型的调用。真要按人/角色限制模型，需要独立的授权模型（未在本次范围）。§6.3 的守护是「防误用」，不是「防越权」。
2. **模型优先级变化会改变用户预期。** 之前新建态一律用全局默认模型；本次起，未手选模型时跟随选中 Agent 的默认模型，切换 Agent 也会重算。用 `newTaskModelTouched` 区分「跟随」与「用户已手选」，避免把用户的选择冲掉；但「先选 Agent、再选模型」与「先选模型、再选 Agent」两种操作顺序的结果不同，需要在发布说明里写明。另：会话仍显式落 `model_id`，所以后台事后修改 Agent 默认模型不会影响已建会话。
3. **切走就回不来。** 用户从隐藏模型切到别的模型后，候选里没有它，只能等管理员放开可见性或改 Agent 默认模型。这是「不给选」的必然结果，§7 的说明文案要写清楚。
4. **老客户端不受控。** 未升级的桌面/安卓仍拿全量列表，会显示并允许选择隐藏模型；服务端 §6.3 会拒绝创建，表现是「新建会话报错」而不是「列表里没有」。所以上线顺序是**先发布后端与客户端，再在后台把模型设为仅管理端**：后端先上不会有行为差异（迁移默认 1、`scope` 参数缺省全量），客户端升级到带 `scope=client` 的版本后再隐藏，才能保证「看不到」而不是「选了报错」。changelog 里写明这一条。
5. **`clientVisible = 0` 的默认模型是脏数据来源。** 迁移不回填、老库若有人直接改库把默认模型设成不可见，客户端新建态会拿到一个选不回来的模型（选择器仍会显示当前模型项）。D4 只拦写入路径，不改读取兜底。
6. **压缩/审批/标题等系统参数若配成隐藏模型**（`compaction.modelId`、`approval.modelId`）不受影响，它们不经过客户端列表；但管理后台这些下拉用的是完整模型列表，需要管理员自己确认选的是哪个。
