# Agent 推荐问题（Suggested Questions）技术方案

> 状态：已实现
> 日期：2026-09-11
> 范围：管理后台 Agent 管理 + 后端 Agent 详情接口 + SDK（sdk/embed）对话窗空白态

---

## 1. 需求背景

SDK 对话窗在新会话的空白态只显示静态提示文案（「有什么可以帮你？」），最终用户面对空白输入框缺少提问引导，冷启动成本高。

管理后台已具备「最佳实践经验」的配置能力（`agent_experiences`，见 `docs/plan/agent-experience-design.md`），但那是注入给模型的经验数据，与「给最终用户看的提问引导」是两类语义：

| 维度 | 最佳实践经验 | 推荐问题 |
|------|--------------|----------|
| 受众 | 模型（注入 system prompt） | 最终用户（SDK 空白态展示） |
| 形态 | 0～n 条经验正文 | 最多 5 条可点击的问题文本 |
| 交互 | 不可交互 | 点击填入输入框，引导发送 |
| 变更频率 | 随业务沉淀追加 | 运营按场景定期调整 |

本需求在管理后台 Agent 新建/编辑中新增「推荐问题」配置，并在 SDK 对话窗空白态展示，点击后填入输入框，降低用户的首次提问门槛。

---

## 2. 需求描述

### 2.1 要做的

1. **数据模型**：新建 `agent_suggested_questions` 表；一个 Agent 最多配置 **5 条**推荐问题。
2. **字段**：仅 `content`（正文）+ `sort_order`（排序）；**不设启停开关、不设标题字段**。不需要的直接删除。
3. **字数限制**：单条 `content` 最长 **100 字**（去首尾空白后 1～100），前后端均校验，后端硬拒绝。
4. **管理后台**：`AgentFormDialog.vue` 新增独立 Tab「推荐问题」，与「最佳实践」Tab 同构：
   - 列表式增删、上移/下移排序、多行输入；
   - 前端校验：必填、≤ 100 字、≤ 5 条；
   - 允许 0 条（Tab 内可完全为空）。
5. **保存方式**：创建/更新 Agent 时通过请求体嵌套 `suggestedQuestions` 数组**全量同步**（与 experiences 的同步规则一致，见 §6.2）。
6. **数据下发**：`GET /v1/agents/{id}` 详情响应的 `AgentVO` 增加 `suggestedQuestions` 字段；SDK 与管理后台编辑表单共用该接口，**不新增独立端点**。
7. **SDK 展示**：`sdk/embed` 对话窗空白态（会话无任何消息时）在现有提示文案下方竖排展示推荐问题列表（最多 5 条，按 `sort_order` 升序）。
8. **点击行为**：点击推荐问题 → 文本**填入输入框并聚焦**，由用户确认（可修改）后手动发送；**不直接发送**。
9. **复制 Agent**：推荐问题随详情带入表单，提交时去掉 id 走创建接口，一并复制到新 Agent。
10. **级联删除**：删除 Agent 时物理删除该 Agent 的全部推荐问题行。

### 2.2 不做的

| 项 | 说明 |
|----|------|
| 注入 system prompt | 推荐问题是给用户看的引导，不进 Prompt，不改 `PromptEngine` / 运行时链路 |
| 单条启停开关（enabled） | 字段不设 enabled；不需要的直接删除 |
| 独立 REST 端点 | 不做 `/v1/agents/{id}/suggested-questions` 增删改查；写路径仅嵌套同步，读路径仅详情接口 |
| 配置超过 5 条 | 管理后台与后端均硬限制 5 条，无「配置更多、展示前 5」的隐藏数据 |
| 桌面端 / Web / 飞书 / 微信 / mao-agent 展示 | 仅 SDK（sdk/embed）对话窗展示；数据随详情接口通用下发，其他端后续接入无需后端改动 |
| SDK 热更新 | 数据在 SDK boot 时随 Agent 详情一次性拉取，不做轮询/推送；运营改动在用户下次进入（页面刷新/重开浮窗）后生效 |
| 直接发送 | 点击只填入输入框，不自动发送 |
| Agent 列表接口返回推荐问题 | `GET /v1/agents` 列表不返回该字段，避免 payload 膨胀 |
| SDK 拉取失败兜底展示 | 详情请求失败或该字段为空时，空白态维持现状（仅原提示文案），不展示推荐问题区块、不重试 |

---

## 3. 现状与改动切入点

| 层级 | 现状 |
|------|------|
| DB | 最新迁移 `V108__message_queue_scheduled_task.sql`；无推荐问题表 |
| 后端 | `backend-ts/src/agent/`：`agent.routes.ts`（嵌套 experiences 全量同步 + 详情 VO）、`agent.service.ts`、`agent.repository.ts`（experiences CRUD 可参照） |
| 管理后台 | `admin/src/views/agent/AgentFormDialog.vue` 已有「最佳实践」Tab：增删/上移下移/校验/嵌套提交/复制去 id，可整体参照 |
| SDK | `sdk/embed/src/controller.ts` `boot()` 已请求 `GET /agents/{agentId}` 拿头像与名称；`ui/ChatPanel.vue` 空白态为 `mao-empty` 区块（图标 + 标题 + 提示）；`ui/Composer.vue` 已接收 `quoted-selection` 展示引用文本 |

---

## 4. 技术选型

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 存储 | 独立表 `agent_suggested_questions`，非塞进 `agent.config_json` | 需要排序与独立校验；与 `agent_experiences` 模式一致 |
| 字段 | `content` + `sort_order`，无 enabled | 已确认不做启停；表结构与校验逻辑最小化 |
| 条数限制 | 后端校验 ≤ 5 条 + 库层面无需约束 | 配置量即展示量，业务约束放应用层，后端硬拒绝 |
| 字数限制 | `VARCHAR(100)` + 后端校验 1～100 | 与产品约束一致的硬限制 |
| 读路径 | 随 `GET /v1/agents/{id}` 返回 | SDK boot 已调用该接口，零额外请求；编辑表单同源取数 |
| 写路径 | Agent 创建/更新嵌套数组全量同步 | 与弹窗一次保存体验一致，复用 experiences 同步模式 |
| SDK 状态 | `controller.ts` 新增 `ui.suggestedQuestions`，boot 时赋值；`ChatPanel` 按 `isEmpty && 列表非空` 渲染 | 展示时机已确认：仅空白态 |
| 填入输入框 | `Composer` 新增对外填充方法（如 `setText(text)`），`ChatPanel` emit 事件经 `RootApp`/`controller` 调用 | 复用现有 `composerEl` ref 通道；不动 `quoted-selection` 的既有语义 |

**不采用**：
- 独立推荐问题 REST——本期无独立消费方，多一组路由只增维护成本；
- 将推荐问题挂到 WS 会话流下发——它属于 Agent 静态配置，REST 详情已覆盖，走 WS 反而引入时序问题；
- 随机展示/横向滚动等展示策略——已确认竖排列表 + 固定排序。

---

## 5. 数据模型

### 5.1 新表 `agent_suggested_questions`

迁移文件：`backend-ts/db/migration/V109__agent_suggested_questions.sql`

```sql
CREATE TABLE IF NOT EXISTS `agent_suggested_questions` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`    BIGINT NOT NULL COMMENT '所属 Agent ID',
    `content`     VARCHAR(100) NOT NULL COMMENT '问题正文，最长 100 字',
    `sort_order`  INT NOT NULL DEFAULT 0 COMMENT '排序，升序',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_agent_suggested_questions_agent` (`agent_id`),
    INDEX `idx_agent_suggested_questions_agent_sort` (`agent_id`, `sort_order`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 推荐问题';
```

- 不设 DB 外键（与 `agent_experiences` 一致，由应用层维护）。
- Agent 删除时在 Service 层物理删除该 Agent 全部推荐问题行。
- 无 `enabled` 列。

### 5.2 领域类型

`backend-ts/src/agent/types.ts` 新增：

```ts
export interface AgentSuggestedQuestion {
  id: number;
  agentId: number;
  content: string;
  sortOrder: number;
}

export interface SuggestedQuestionInput {
  id: number | null;
  content: string;
  sortOrder: number;
}
```

`agent.repository.ts` 新增方法（参照 experiences 现有实现）：
`listSuggestedQuestions(agentId)`（全量，`ORDER BY sort_order ASC, id ASC`）、`insertSuggestedQuestion`、`updateSuggestedQuestion`、`deleteSuggestedQuestion`、`deleteSuggestedQuestionsByAgentId`。

---

## 6. API 设计

统一响应 `Result<T>`（code=0）。路径前缀 `/api/v1`。

### 6.1 VO

```json
{ "id": 1, "content": "帮我总结当前页面的主要内容", "sortOrder": 0 }
```

### 6.2 主路径（嵌套全量同步）

| 方法 | 路径 | 变更 |
|------|------|------|
| GET | `/v1/agents/{id}` | VO 增加 `suggestedQuestions`（全量，按 sort_order、id 升序） |
| POST | `/v1/agents` | 请求体可带 `suggestedQuestions`；创建后写入 |
| PUT | `/v1/agents/{id}` | 请求体带 `suggestedQuestions` 时做全量同步 |
| DELETE | `/v1/agents/{id}` | 级联物理删除该 Agent 全部推荐问题 |
| GET | `/v1/agents` | **不变**，列表不返回 `suggestedQuestions` |

**全量同步规则（`suggestedQuestions != null` 时）**：

1. 带已有 `id` 且属于该 Agent → 更新 content / sortOrder；
2. 无 `id` 或 `id` 为空 → 新增；
3. 库中已有但请求未出现的 id → 物理删除；
4. `suggestedQuestions == null`（字段未传）→ 不改动；
5. `suggestedQuestions: []` → 清空。

**校验（新增错误码，`backend-ts/src/common/error-code.ts`）**：

- `AGENT_SUGGESTED_QUESTION_CONTENT_INVALID`：content 必填、去首尾空白后 1～100 字；
- `AGENT_SUGGESTED_QUESTION_LIMIT_EXCEEDED`：单 Agent 最多 5 条（创建与更新同步均校验）；
- `sortOrder` 缺省按数组下标处理；前端提交时显式携带。

### 6.3 权限

不新增权限码。`GET /v1/agents/{id}` 现已被 SDK 用户身份调用（头像/名称），`suggestedQuestions` 属同一非敏感配置面；写路径沿用现有 Agent 创建/更新权限。

---

## 7. 管理后台

改动文件：`admin/src/views/agent/AgentFormDialog.vue`（主改）。

1. 新增第四个 Tab **「推荐问题」**（`el-tab-pane`），区块文案「推荐问题：新会话空白时展示给用户的提问引导，最多 5 条，点击后填入输入框」。
2. 列表交互与「最佳实践」Tab 同构：
   - 每条：多行输入（content）+ 删除 + 上移/下移；
   - 「添加问题」按钮，默认 `sortOrder` 为当前最大 + 1；
   - 前端校验：必填、≤ 100 字；列表长度 > 5 时禁止提交并提示「最多配置 5 条」；
   - 允许 0 条。
3. 提交：POST/PUT body 携带完整 `suggestedQuestions` 数组（编辑时带 id，创建/复制不带 id）。
4. 复制模式：详情带入 `suggestedQuestions`，提交前去 id，与 experiences 的复制处理一致。

---

## 8. SDK（sdk/embed）

### 8.1 数据获取

- `src/types.ts` 的 `AgentVO` 增加 `suggestedQuestions?: SuggestedQuestionVO[]`。
- `controller.ts`：`ui` 状态新增 `suggestedQuestions`；`boot()` 拿到 Agent 详情后赋值（`sort_order` 已由后端排序，前端不再排序）；身份切换（`identityVersion` 变化）时随现有重置逻辑清空。
- 拉取失败或字段为空 → 值为 `[]`，空白态不渲染推荐问题区块。

### 8.2 展示（ChatPanel.vue）

- 条件：`isEmpty && suggestedQuestions.length > 0`（仅空白态）。
- 位置：现有 `mao-empty` 区块（图标 + 「有什么可以帮你？」+ 提示文案）下方。
- 样式：竖排问题列表，圆角按钮式条目，每条完整展示文本（不截断），与现有 SDK 轻量风格一致；最多 5 条由数据侧保证。
- 点击：emit 事件（如 `fillQuestion`）→ `RootApp` 转发 → `controller` 调用 `Composer` 暴露的 `setText(text)` 并聚焦输入框；用户确认后手动发送。
- 发送首条消息后 `isEmpty` 变 false，列表随之消失；「新对话」重置会话后重新出现。

### 8.3 Composer.vue

新增对外方法 `setText(text: string)`（写入内部输入状态并触发必要的输入事件同步），供父组件经 `composerEl` ref 调用；不改变 `quoted-selection` 既有语义。

---

## 9. 实现步骤

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1 | Flyway `V109__agent_suggested_questions.sql` | 新表 |
| 2 | types / repository：推荐问题 CRUD 与按 Agent 删除 | 领域层 |
| 3 | `agent.service.ts`：create/update 全量同步（≤5 条、1～100 字校验）、delete 级联；错误码 | 服务层 |
| 4 | `agent.routes.ts`：Request/VO 增加 `suggestedQuestions`；详情返回 | API |
| 5 | 管理后台 `AgentFormDialog.vue` 新增「推荐问题」Tab | UI |
| 6 | SDK：types + controller boot 赋值 + ChatPanel 空白态列表 + Composer.setText | SDK |
| 7 | 单测：后端 routes/service 同步与校验；SDK ChatPanel/Composer 渲染与点击 | 测试 |

建议顺序：1 → 2 → 3 → 4 → 7（后端闭环）→ 5 → 6 → 7（前端闭环）。

---

## 10. 落地清单

### 10.1 后端（backend-ts）

- [x] `V109__agent_suggested_questions.sql`
- [x] `agent/types.ts`：`AgentSuggestedQuestion` / `SuggestedQuestionInput`
- [x] `agent/agent.repository.ts`：5 个推荐问题方法
- [x] `agent/agent.service.ts`：全量同步 + 校验（≤5 条、1～100 字）+ 级联删除
- [x] `common/error-code.ts`：新增 2 个错误码
- [x] `agent/agent.routes.ts`：Request/VO/详情返回/删除级联
- [x] 单测：`agent.routes.spec.ts` / `agent.service.spec.ts` 覆盖同步规则、校验拒绝、详情返回、级联删除

### 10.2 管理后台（admin）

- [x] `AgentFormDialog.vue`：新增「推荐问题」Tab（增删/排序/校验/嵌套提交/复制去 id）
- [x] `vue-tsc` 构建通过

### 10.3 SDK（sdk/embed）

- [x] `src/types.ts`：`AgentVO.suggestedQuestions`
- [x] `src/controller.ts`：boot 赋值 + 身份切换清空
- [x] `src/ui/ChatPanel.vue`：空白态竖排列表 + 点击 emit
- [x] `src/ui/Composer.vue`：`setText` 对外方法
- [x] Vitest：ChatPanel 空白态渲染/非空不渲染/点击填入；controller 赋值与失败兜底

### 10.4 文档 / 其它

- [x] 本方案文档与实现保持一致（偏差回写）
- [x] CHANGELOG.md 顶部新增版本小节（用户可见改动：后台配置 + SDK 展示）
- [x] 不改：PromptEngine、运行时链路、desktop、飞书/微信、mao-agent、`GET /v1/agents` 列表

### 10.5 验收标准

1. 管理后台可为 Agent 维护 0～5 条推荐问题，可排序、删除；第 6 条被前后端同时拒绝；单条超 100 字无法保存。
2. `GET /v1/agents/{id}` 返回 `suggestedQuestions`，按 sort_order 升序；未配置时为空数组；`GET /v1/agents` 列表不含该字段。
3. SDK 新会话空白态在提示文案下方竖排展示推荐问题（最多 5 条）；未配置或拉取失败时展示与现状完全一致。
4. 点击推荐问题后文本填入输入框并聚焦，不自动发送；发送消息后列表消失，「新对话」后重新出现。
5. 复制 Agent 后新 Agent 拥有相同内容的推荐问题副本（新 id）。
6. 删除 Agent 后其推荐问题行被物理清除。
7. 推荐问题不出现在 system prompt 中（PromptEngine 无改动）。

---

## 11. 已确认决策摘要

| # | 决策 |
|---|------|
| 展示时机 | 仅会话空白态；发消息后消失，新对话重现 |
| 字段 | `content` + `sort_order`；无 enabled、无 title |
| 条数 | 配置硬上限 5 条，配置量=展示量 |
| 字数 | 单条 ≤ 100 字，前后端校验 |
| 读路径 | 随 `GET /v1/agents/{id}` 详情返回；无独立端点 |
| 写路径 | 创建/更新嵌套数组全量同步 |
| 点击行为 | 填入输入框并聚焦，用户手动发送 |
| Prompt | 不注入 system prompt |
| 展示范围 | 仅 SDK 对话窗；其他端不做 |
| 后台 UI | 独立「推荐问题」Tab，与最佳实践同构 |
| 复制 | 一并复制（去 id） |
| 样式 | 空白态文案下方竖排问题列表 |

---

## 12. 风险与注意点

1. **生效时机**：SDK 数据在 boot 时拉取，运营改动配置后，已打开页面的用户需刷新/重开浮窗才能看到；验收时注意区分。
2. **填充与运行态**：会话运行中（RUNNING）点击推荐问题仍填入输入框，但发送按钮受现有 `running` 禁用逻辑控制，不产生额外状态。
3. **多 tab**：SDK 多标签页已通过 `tabs` 协调会话归属；推荐问题为 Agent 静态数据，各 tab 各自拉取，无一致性问题。
4. **初版无存量兼容压力**：按仓库约定，新表从空开始，无需数据迁移。
