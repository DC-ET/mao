# Agent 最佳实践经验（Experience）技术方案

> 状态：已实现  

> 日期：2026-07-09  
> 范围：管理后台 Agent 管理 + 后端 Prompt 注入

---

## 1. 需求背景

当前 Agent 的提示词只有单一字段 `agent.system_prompt`，角色设定、工作方式与岗位经验混在一起，难以维护和复用。

岗位经验（例如「CPU 持续 100% 时优先查最近发布与流量」）与角色定义性质不同：

| 维度 | 角色定义（system_prompt） | 最佳实践经验 |
|------|---------------------------|--------------|
| 内容 | 身份、目标、表达方式、工作边界 | 真实岗位积累的思考捷径 |
| 形态 | 一整段文本 | 0～n 条短文本，可独立增删改排序 |
| 变化频率 | 相对稳定 | 随业务沉淀持续追加 |
| 注入方式 | 始终作为人格基底 | 按启用状态与排序拼入 system prompt |

本需求将二者拆开：`system_prompt` 继续承载角色定义；新增 `agent_experiences` 表维护最佳实践经验，并在运行时拼入 Prompt。

---

## 2. 需求描述

### 2.1 要做的

1. **角色定义**：沿用 `agent.system_prompt` 字段；管理后台文案由「系统提示词」改为「角色定义」，用于配置角色、目标、工作内容、表达方式等。
2. **最佳实践经验**：新建 `agent_experiences` 表；一个 Agent 可维护 0～n 条经验。
3. **经验字段**：仅 `content`（正文）+ `sort_order`（排序）+ `enabled`（启用/停用）；**不设独立标题字段**。
4. **启用/停用**：停用后记录保留，但**不注入** Prompt。
5. **Prompt 拼接顺序**（在现有 `PromptEngine.buildSystemPrompt` 中调整）：

```
agent.system_prompt（角色定义）
  → agent_experiences（仅 enabled=1，按 sort_order 升序）
  → ## 工作环境
  → ## 当前时间
  → 工具使用指引 / 可用技能 / 任务管理 / 子代理委派 …
```

6. **经验区块标题**：固定为 `## 最佳实践经验`。
7. **0 条可用经验**（无记录，或全部停用）：**不注入**该区块（不出现空标题）。
8. **单条字数上限**：`content` 最长 **300 字**，前后端均校验（后端硬拒绝超长）。
9. **管理后台**：仍在现有「创建/编辑/复制 Agent」弹窗内，增加可增删改、排序、启停的经验列表。
10. **复制 Agent**：一并复制经验（新 Agent 下新建经验行，不复用原 id）。
11. **API**：
    - **主路径**：创建/更新 Agent 时通过请求体嵌套 `experiences` 数组整体提交；详情/列表返回经验。
    - **辅路径**：提供 `/v1/agents/{id}/experiences` 独立增删改查，便于单条维护与后续扩展。

### 2.2 不做的

| 项 | 说明 |
|----|------|
| 经验跨 Agent 复用 / 共享库 | 经验仅归属单个 Agent |
| 经验版本管理、Prompt 回归测试体系 | 本期不做 |
| 桌面端编辑经验 | 仅管理后台维护 |
| 用户个人级经验 | 仅 Agent 级 |
| 存量 `system_prompt` 自动拆分 | 存量保持原样；经验从空开始人工维护 |
| Subagent（`AgentDefinition`）挂经验表 | 子代理仍用现有 `systemPromptOverride`，不读 `agent_experiences` |
| 经验独立标题（title）字段 | 仅 content |
| 经验软删除 | 单条删除为物理删除；随 Agent 逻辑删除时级联清理物理行 |

---

## 3. 现状与改动切入点

### 3.1 现状

| 层级 | 现状 |
|------|------|
| DB | `agent.system_prompt TEXT NOT NULL`；无经验表。最新迁移为 `V052` |
| 后端 CRUD | `AgentController` / `AgentService`；标签采用「删旧插新」；复制由前端预填后 `POST /agents` |
| 运行时 | `HarnessService.buildContext` 将 `agent.getSystemPrompt()` 写入 `AgentExecutionContext.systemPrompt` |
| Prompt | `PromptEngine.buildSystemPrompt`：`systemPrompt` → 工作环境 → 当前时间 → … |
| 管理后台 | `admin/src/views/agent/AgentFormDialog.vue` 单字段「系统提示词」 |

### 3.2 目标 Prompt 形态（示意）

```text
{角色定义 system_prompt}

## 最佳实践经验

- CPU 持续过高时，优先检查最近是否发布、流量是否突增。
- 排障时不要轻易建议重启，先确认是否有明确的资源泄漏或死锁证据。

## 工作环境
...
## 当前时间
...
```

---

## 4. 技术选型

| 决策点 | 选型 | 理由 |
|--------|------|------|
| 存储 | 独立表 `agent_experiences`，非 JSON 塞进 `config_json` | 需排序、启停、独立 CRUD；与 `agent_tag` 模式一致 |
| 主保存策略 | Agent 创建/更新时嵌套数组整体同步 | 与现有弹窗一次保存体验一致 |
| 辅 API | 独立 experiences REST | 满足方案 C；便于单条启停/调序而不整表单提交 |
| 注入位置 | `PromptEngine` 读取 context 中的经验列表并拼接 | 与工作环境等同属 Prompt 组装职责；避免在 `HarnessService` 里把经验糊进 `systemPrompt` 字符串导致 Side Task 摘要拼接语义混乱 |
| 字数限制 | 后端校验 `content.length() <= 300`；库字段 `VARCHAR(300)` | 硬限制，与「300 字」产品约束一致 |
| 排序 | `sort_order INT`，升序；同值时按 `id` 升序 | 简单稳定 |
| 启停 | `enabled TINYINT NOT NULL DEFAULT 1`（1 启用 / 0 停用） | 停用不删数据 |

**不采用**：把经验拼进 `context.systemPrompt` 再交给 PromptEngine——Side Task 会在 `systemPrompt` 后追加主任务摘要，若经验已糊进该字段，摘要会插在经验之后、工作环境之前，顺序仍可接受，但经验与角色定义边界在 context 层丢失，不利于测试与后续扩展。因此经验以独立字段进入 context。

---

## 5. 数据模型

### 5.1 新表 `agent_experiences`

迁移文件：`backend/src/main/resources/db/migration/V053__agent_experiences.sql`

```sql
CREATE TABLE IF NOT EXISTS `agent_experiences` (
    `id`          BIGINT PRIMARY KEY AUTO_INCREMENT,
    `agent_id`    BIGINT NOT NULL COMMENT '所属 Agent ID',
    `content`     VARCHAR(300) NOT NULL COMMENT '经验正文，最长 300 字',
    `sort_order`  INT NOT NULL DEFAULT 0 COMMENT '排序，升序',
    `enabled`     TINYINT NOT NULL DEFAULT 1 COMMENT '1-启用 0-停用；停用不注入 Prompt',
    `created_at`  DATETIME DEFAULT CURRENT_TIMESTAMP,
    `updated_at`  DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX `idx_agent_experiences_agent` (`agent_id`),
    INDEX `idx_agent_experiences_agent_sort` (`agent_id`, `sort_order`, `id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent 最佳实践经验';
```

说明：

- 不设 DB 外键（与现有 `agent_tag` 等表一致，由应用层维护）。
- Agent 逻辑删除时，在 `AgentService.deleteAgent` 中**物理删除**该 Agent 下全部经验行。

### 5.2 实体

新增 `cn.etarch.mao.agent.entity.AgentExperience`：

| Java 字段 | 列 | 说明 |
|-----------|-----|------|
| id | id | 主键 |
| agentId | agent_id | 所属 Agent |
| content | content | 正文 |
| sortOrder | sort_order | 排序 |
| enabled | enabled | 是否启用 |
| createdAt / updatedAt | … | 时间戳 |

Mapper：`AgentExperienceMapper`（MyBatis-Plus `BaseMapper`）。

---

## 6. API 设计

统一响应仍为 `Result<T>`（`code=0` 成功）。路径前缀：`/api/v1`（Controller 映射 `/v1/...`）。

### 6.1 经验 VO

```json
{
  "id": 1,
  "content": "CPU 持续过高时，优先检查最近是否发布、流量是否突增。",
  "sortOrder": 0,
  "enabled": true
}
```

### 6.2 Agent 主路径（嵌套 experiences）

**扩展现有接口**，不改 URL：

| 方法 | 路径 | 变更 |
|------|------|------|
| GET | `/v1/agents` | 每条 `AgentVO` 增加 `experiences`（含停用项，供后台展示） |
| GET | `/v1/agents/{id}` | 同上 |
| POST | `/v1/agents` | 请求体可带 `experiences`；创建后写入 |
| PUT | `/v1/agents/{id}` | 请求体带 `experiences` 时做**全量同步** |
| DELETE | `/v1/agents/{id}` | 级联删除该 Agent 全部经验 |

**Create/Update 请求体增量：**

```json
{
  "name": "...",
  "description": "...",
  "systemPrompt": "...",
  "skillNames": [],
  "tags": [],
  "experiences": [
    { "id": null, "content": "...", "sortOrder": 0, "enabled": true },
    { "id": 12, "content": "...", "sortOrder": 1, "enabled": false }
  ]
}
```

**全量同步规则（PUT 且 `experiences != null`）：**

1. 请求中带已有 `id` 且属于该 Agent → 更新 content / sortOrder / enabled。
2. 请求中无 `id` 或 `id` 为空 → 新增。
3. 库中已有但请求未出现的 id → 物理删除。
4. `experiences == null`（字段未传）→ **不改动**经验（与 tags 当前「传了才更新」一致）。
5. `experiences: []` → 清空该 Agent 全部经验。

**校验（创建/更新嵌套与独立 API 共用）：**

- `content` 非空、去首尾空白后长度 1～300；超长返回业务错误（建议新增 `ErrorCode`，如 `AGENT_EXPERIENCE_CONTENT_INVALID`）。
- `enabled` 缺省视为 `true`。
- `sortOrder` 缺省按数组下标或 0 处理；前端提交时应显式带上。

**文案**：接口校验消息与管理后台标签统一使用「角色定义」语义时，`systemPrompt` 的 `@NotBlank` 提示可改为「角色定义不能为空」（字段名仍为 `systemPrompt`，避免无意义的 API 改名）。

### 6.3 独立 Experiences API（辅路径）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/v1/agents/{agentId}/experiences` | 列出该 Agent 全部经验（含停用），按 sort_order、id 升序 |
| POST | `/v1/agents/{agentId}/experiences` | 新增一条；body：`content`、`sortOrder?`、`enabled?` |
| PUT | `/v1/agents/{agentId}/experiences/{id}` | 更新 content / sortOrder / enabled |
| DELETE | `/v1/agents/{agentId}/experiences/{id}` | 物理删除 |

实现建议：新建 `AgentExperienceController`，或挂在 `AgentController` 下；Service 抽 `AgentExperienceService`，供 Agent 主路径同步与独立 API 复用。

权限：与现有 `/v1/agents` 一致（当前 AgentController 未单独加 `@RequirePermission`，本期不额外引入新权限码）。

---

## 7. 运行时注入

### 7.1 `AgentExecutionContext`

新增字段，例如：

```java
/** 已启用的最佳实践经验正文，按 sort_order 排序；可为空列表 */
private List<String> experiences;
```

仅放入**启用**且校验通过的正文，避免 PromptEngine 再过滤。

### 7.2 `HarnessService.buildContext`

在设置 `systemPrompt` 之后：

1. 按 `agent_id` 查询 `enabled = 1` 的经验，`ORDER BY sort_order ASC, id ASC`。
2. `context.setExperiences(contents)`。

Side Task / 普通会话均走 `buildContext`，因此主会话与边路任务都会带上同一 Agent 的启用经验。子代理 `DelegateTool` 使用 `systemPromptOverride` 时**不**加载 `agent_experiences`（见「不做」）。

### 7.3 `PromptEngine.buildSystemPrompt`

在追加「工作环境」之前插入：

```java
// 角色定义
append systemPrompt

// 最佳实践经验（仅当 experiences 非空）
if (experiences 非空) {
  sb.append("## 最佳实践经验\n\n");
  for (String exp : experiences) {
    sb.append("- ").append(exp).append("\n");
  }
  sb.append("\n");
}

// ## 工作环境 …
```

列表项使用 `- ` 前缀，与现有技能目录风格一致。

### 7.4 与 Side Task 摘要的关系

`executeSideFirstMessage` 在 `context.systemPrompt` 后追加主任务摘要。经验在 PromptEngine 中位于角色定义之后、工作环境之前，且经验不在 `systemPrompt` 字符串内，因此最终顺序为：

```
角色定义
→ （若 inherit）主任务背景摘要（已并入 context.systemPrompt）
→ 最佳实践经验
→ 工作环境 → …
```

即：摘要作为角色定义的延伸保留在 `systemPrompt` 内；经验仍紧随其后。此顺序可接受且实现简单。**不做**为 Side Task 单独调整经验位置。

---

## 8. 管理后台

### 8.1 改动文件

- `admin/src/views/agent/AgentFormDialog.vue`（主改）
- `admin/src/views/agent/AgentListView.vue`（可选：列表增加「经验数」列，展示 `experiences.length`；**本期要做**，便于运营扫视）

### 8.2 表单交互（弹窗内）

1. 原「系统提示词」表单项改名为 **「角色定义」**；placeholder / 校验文案同步；`prop` 仍为 `systemPrompt`。
2. 新增区块 **「最佳实践经验」**：
   - 列表展示每条：多行输入（content）、启用开关、上移/下移（或拖拽，优先上移/下移按钮以降低复杂度）、删除。
   - 「添加经验」按钮；新增默认 `enabled: true`，`sortOrder` 为当前最大 + 1。
   - 前端校验：content 必填、长度 ≤ 300；超长禁止提交并提示。
   - 允许 0 条。
3. 提交：`POST/PUT` body 带完整 `experiences` 数组（编辑时带 id；复制/创建不带 id）。
4. **复制模式**：从详情带入 experiences，提交前去掉 id，走创建接口，实现经验一并复制。

弹窗宽度可适当加大（如 680 → 760），避免经验列表过挤。

### 8.3 独立 API 在本期 UI 中的使用

弹窗主保存走嵌套全量同步即可。独立 API **本期后端必须实现**；管理后台 UI **可不调用**独立接口（为后续单条操作或脚本预留）。

---

## 9. 实现步骤

| 步骤 | 内容 | 产出 |
|------|------|------|
| 1 | Flyway `V053__agent_experiences.sql` | 新表 |
| 2 | Entity / Mapper / `AgentExperienceService`（校验、列表、CRUD、按 Agent 全量同步、按 Agent 删除） | 领域层 |
| 3 | 扩展 `AgentService` create/update/delete；扩展 `AgentController` VO/Request | 主路径 API |
| 4 | 新增 experiences 独立 REST | 辅路径 API |
| 5 | `AgentExecutionContext` + `HarnessService.buildContext` 加载启用经验 | 运行时数据 |
| 6 | `PromptEngine` 注入 `## 最佳实践经验`；更新 `PromptEngineTest` | Prompt |
| 7 | 管理后台表单 + 列表经验数 | UI |
| 8 | 单测：`AgentExperienceService` / `AgentService` 同步逻辑；Prompt 顺序与 0 条不注入 | 测试 |

建议实现顺序：1 → 2 → 3 → 5 → 6 → 4 → 7 → 8（先打通「保存 → 注入」，再补独立 API 与 UI）。

---

## 10. 落地清单

### 10.1 后端

- [x] `V053__agent_experiences.sql`
- [x] `AgentExperience.java` / `AgentExperienceMapper.java`
- [x] `AgentExperienceService.java`（含 300 字校验、全量同步、级联删除）
- [x] `ErrorCode` 增加经验内容非法码
- [x] `AgentService`：create/update 同步 experiences；delete 级联删
- [x] `AgentController`：Request/VO 增加 `experiences`；`systemPrompt` 校验文案可改为角色定义
- [x] Experiences 独立 Controller 或同 Controller 子路由（GET/POST/PUT/DELETE）
- [x] `AgentExecutionContext.experiences`
- [x] `HarnessService.buildContext` 加载启用经验
- [x] `PromptEngine.buildSystemPrompt` 按约定拼接
- [x] `PromptEngineTest`：有经验时顺序与标题；无经验/全停用不出现区块
- [x] `AgentServiceTest` / 新 Experience 相关单测

### 10.2 管理后台

- [x] `AgentFormDialog.vue`：角色定义文案；经验列表增删改排序启停；提交嵌套数组；复制去 id
- [x] `AgentListView.vue`：增加经验数量列

### 10.3 文档 / 其它

- [x] 本方案文档随实现保持一致（若实现中有偏差回写本节）
- [x] **不**改桌面端
- [x] **不**改 Subagent / Delegate 经验加载
- [x] **不**做存量 system_prompt 迁移拆分

### 10.4 验收标准

1. 管理后台可为 Agent 维护 0～n 条经验，可启停、排序；单条超过 300 字无法保存。
2. 仅启用经验进入 Prompt；区块标题为 `## 最佳实践经验`；位置在角色定义之后、工作环境之前。
3. 无启用经验时，最终 system prompt **不含**「最佳实践经验」字样。
4. 复制 Agent 后新 Agent 拥有相同内容的经验副本（新 id）。
5. 删除 Agent 后其经验行被清除。
6. 独立 REST 可对单条经验完成增删改查，且与主路径数据一致。
7. 现有 Agent 无经验时行为与改前一致（仅多一段空列表查询，Prompt 无新区块）。

---

## 11. 已确认决策摘要

| # | 决策 |
|---|------|
| 字段 | `content` + `sort_order` + `enabled`；无 title |
| UI | 现有 Agent 弹窗内嵌经验列表 |
| 复制 | 一并复制经验 |
| API | 嵌套全量同步为主 + 独立 REST 为辅 |
| 区块标题 | `## 最佳实践经验` |
| 字数 | 硬限制 300 字 |
| 空列表 | 不注入区块 |
| 注入顺序 | 角色定义 → 经验 → 工作环境 → 当前时间 → … |

---

## 12. 风险与注意点

1. **Token 成本**：经验条数 × 约 300 字会进入每次请求的 system prompt；运营侧应控制条数。本期**不做**条数硬上限；若后续需要，可再加「单 Agent 最多 N 条」。
2. **列表接口体积**：`GET /v1/agents` 若返回全部 experiences，Agent 多、经验多时 payload 变大。本期接受（与 tags 一并返回的模式一致）；若后续有性能问题，可改为列表只返回 `experienceCount`、详情再返回全文。
3. **初版无存量兼容压力**：按仓库约定，无需迁移拆分旧 prompt。
