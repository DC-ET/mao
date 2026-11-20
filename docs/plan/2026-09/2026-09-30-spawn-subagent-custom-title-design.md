# spawn_subagent 支持主代理自定义子代理标题 - 技术方案

> 文档状态：待评审确认  
> 日期：2026-09-30  
> 适用范围：`backend-ts/`（后端 harness）、`desktop/`（前端展示）  
> 关联代码：`backend-ts/src/harness/delegate/background-subagent-manager.ts`、`backend-ts/src/harness/tool/impl/background-subagent-tools.ts`

## 1. 需求背景

主代理通过 `spawn_subagent` 派发后台子代理时，子代理会话的标题由系统固定生成：

```
后台子代理(explorer): {任务描述前40字}...
```

生成逻辑位于 `background-subagent-manager.ts` 的 `spawn()`：

```ts
const childTitle = '后台子代理(' + canonicalType + '): ' + (task.length > 40 ? task.slice(0, 40) + '...' : task);
```

该标题存在以下问题：

1. 任务描述是给子代理的完整指令，开头通常是套话（如"请帮我调研…"），截取前 40 字语义性差，主会话的子代理列表/完成通知里难以一眼区分多个并行子代理。
2. 主代理对任务意图的理解最充分，却没有渠道表达"这个子代理叫什么"。
3. 同一前缀 + 截断的标题在多个子代理并排时辨识度极低。

## 2. 需求描述

### 2.1 要实现的行为

1. `spawn_subagent` 工具新增**可选**参数 `title`：主代理在派发子代理时可以显式提供该子代理会话的标题。
2. 主代理提供 `title` 时，子代理会话标题**完全使用**该自定义标题，不拼接 `后台子代理(类型):` 前缀；子代理类型信息已由子代理列表卡片、WS 事件中的 `agentType` 字段单独承载，不随标题丢失。
3. 服务端对传入标题做基础清洗：trim 首尾空白、移除换行与控制字符、超过 40 字截断并补 `...`。
4. 清洗后标题为空字符串时，回退到现有兜底逻辑：`后台子代理(类型): {任务前40字}`。
5. 主代理未提供 `title` 参数时，行为与现状完全一致（向后兼容）。
6. 工具的 Schema 描述与 Prompt 引导主代理在派发并行子代理时提供**简短、可区分**的标题（建议 4–12 个字，概括任务而非照抄指令）。
7. `spawn_subagent` 的结果摘要（`ToolResultSummarizer`）在主代理提供了标题时展示该标题，便于在工具调用卡片中确认。
8. 前端 `toolDisplay.ts` 的 `spawn_subagent` 参数预览补充 `title` 字段（如有）。

### 2.2 明确不做

1. **不**改动前台委派链路 `delegate` / `delegate_followup` 的标题生成逻辑（仍由系统生成 `子代理(类型): …`）。
2. **不**在 `subagent_followup`（追问/纠偏）上加标题参数——追问复用同一子代理会话，标题不变。
3. **不**用 LLM 为缺省标题做智能生成（现有拼接兜底已够用，不引入额外模型调用与延迟）。
4. **不**新增数据库字段/表结构变更——标题仍存 `session.title`（`VARCHAR(256)`），沿用现有列。
5. **不**改动子代理完成通知卡片（`MessageBubble.vue`）的版式；标题变化经由现有 `title` 字段自然透出。
6. **不**提供用户在 UI 上手动重命名子代理会话标题的入口（本次只做主代理派发时的自定义）。
7. **不**改动 `check_subagent` / `cancel_subagent` / `wait_subagents` 的参数与返回结构。

## 3. 现状与影响面分析

### 3.1 标题生成与流转链路

```
SpawnSubagentTool.executeWithSession
  → BackgroundSubagentManager.spawn(parentSessionId, agentType, task, parentToolCallId)
      ├─ 生成 childTitle = '后台子代理(' + type + '): ' + task.slice(0,40)
      └─ SubagentInvocationService.createBackground(parent, type, task, childTitle, toolCallId)
            └─ 创建子会话（session.title = childTitle）
  → SubAgentVisibilityService.notifySubagentCreated(parent, child, type, task, toolCallId)
        └─ WS 事件携带 child.title → 前端子代理列表/卡片展示
```

关键文件与职责：

| 文件 | 职责 |
|---|---|
| `backend-ts/src/harness/tool/impl/background-subagent-tools.ts` | `SpawnSubagentTool`：Schema 定义、参数解析、调用 manager |
| `backend-ts/src/harness/delegate/background-subagent-manager.ts` | `spawn()`：当前唯一生成 `childTitle` 的位置 |
| `backend-ts/src/harness/delegate/subagent-invocation.service.ts` | `createBackground()`：把 title 落库为子会话标题 |
| `backend-ts/src/harness/delegate/subagent-visibility-service.ts` | WS 事件 `title: childSession.title \|\| '子代理'` 透传 |
| `backend-ts/src/session/util/tool-result-summarizer.ts` | `summarizeSpawnSubagent`：结果摘要 `启动后台子代理 (type) #id (运行中)` |
| `desktop/src/utils/toolDisplay.ts` | `spawn_subagent: '启动后台子代理'` 中文名与参数预览 |
| `desktop/src/stores/session.ts` | `SubagentItem` 缓存与 `updateSubagentMeta` 更新标题 |

### 3.2 数据约束

- `session.title` 为 `VARCHAR(256)`（`V001__init_schema.sql`），40 字截断远小于上限，无迁移需求。
- 前端 `updateSubagentMeta(childSessionId, { title })` 已支持运行时更新子代理标题（当前主要用于其他场景），说明链路对"标题可变"已有支撑；本次只需在创建时把自定义标题写入即可，无需前端结构变更。

## 4. 技术选型与方案决策

| 决策点 | 选定方案 | 理由 |
|---|---|---|
| 作用范围 | 仅 `spawn_subagent` 创建时 | 用户明确诉求；前台 delegate 链路保持现状，范围最小 |
| `title` 参数约束 | 可选参数 | 不传时保留现有兜底，零破坏、向后兼容 |
| 标题组装 | 提供后完全使用自定义标题 | 前缀冗余；类型由卡片/事件的 `agentType` 单独展示 |
| 标题清洗 | trim + 去换行/控制字符 + 超 40 字截断 + 空标题回退兜底 | 防御模型输出异常格式，保证 UI 单行展示稳定 |
| 缺省标题 | 保留 `后台子代理(类型): 任务前40字` 拼接 | 不引入 LLM 生成，无额外延迟与成本 |
| 存储 | 沿用 `session.title`，无 DDL | 现列足够，无需迁移 |

## 5. 实现步骤

### 5.1 后端 `backend-ts`

**Step 1：`SpawnSubagentTool` 增加 `title` 入参**

文件：`backend-ts/src/harness/tool/impl/background-subagent-tools.ts`

- `getInputSchema()` 的 `properties` 增加：

  ```ts
  title: { type: 'string', description: '子代理会话标题（可选）。建议 4-12 个字概括任务，便于在并行子代理列表中区分；不传时系统按任务描述自动生成。' }
  ```

  `required` 仍为 `['agent_type', 'task']`。

- `getToolPrompt()` 的"委派纪律"补一条引导：派发并行子代理时为每个子代理提供简短可区分的 `title`。

- `executeWithSession()`：解析 `const customTitle = asText(args.title)`，透传给 manager：

  ```ts
  const result = await this.manager.spawn(sessionId, normalizeAgentType(agentType), task, toolCallId, customTitle);
  ```

**Step 2：`BackgroundSubagentManager.spawn()` 支持自定义标题**

文件：`backend-ts/src/harness/delegate/background-subagent-manager.ts`

- `spawn()` 签名增加末位可选参数 `customTitle?: string | null`。
- 标题生成逻辑改为：

  ```ts
  const childTitle = resolveChildTitle(customTitle, canonicalType, task);
  ```

  其中 `resolveChildTitle`（本文件内私有函数）：

  ```ts
  function resolveChildTitle(customTitle: string | null | undefined, agentType: string, task: string): string {
    const cleaned = cleanTitle(customTitle);
    if (cleaned) return cleaned;
    return '后台子代理(' + agentType + '): ' + (task.length > 40 ? task.slice(0, 40) + '...' : task);
  }

  function cleanTitle(raw: string | null | undefined): string | null {
    if (raw == null) return null;
    // trim、压缩所有空白（含换行/制表）为单空格、去控制字符
    const normalized = raw.replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!normalized) return null;
    return normalized.length > 40 ? normalized.slice(0, 40) + '...' : normalized;
  }
  ```

**Step 3：结果摘要展示自定义标题**

文件：`backend-ts/src/session/util/tool-result-summarizer.ts`

- `summarizeSpawnSubagent(argumentsJson, result)`：从 `argumentsJson` 提取 `title`；存在时 label 变为 `启动后台子代理「{title}」(type)`，例如 `启动后台子代理「调研登录模块」(explorer) #193 (运行中)`；不存在时保持现状。

**Step 4：后端单测**

- `background-subagent-manager.spec.ts`：新增用例覆盖——
  - 传入合法 `title`：子会话标题完全等于该标题；
  - 传入超长 `title`（>40 字）：截断为 40 字 + `...`；
  - 传入纯空白/换行/控制字符 `title`：回退到拼接兜底；
  - 不传 `title`：与现状一致的拼接标题。
- `tool-result-summarizer` 对应 spec：传入 `title` 时摘要包含标题；缺失参数报错路径不受影响（`title` 可选，不影响"缺少必填参数"用例）。
- `background-subagent-tools` 相关 spec（如存在）：`title` 透传正确。

### 5.2 前端 `desktop`

**Step 5：工具展示参数预览**

文件：`desktop/src/utils/toolDisplay.ts`

- `spawn_subagent` 的参数预览（若按参数白名单展示）补充 `title` 字段的展示；中文名"启动后台子代理"不变。
- 确认子代理列表/卡片展示的标题取自 WS 事件 `title` 字段（`subagent-visibility-service.ts` 已透传 `childSession.title`），无需额外改动；如有按前缀"后台子代理("做正则解析的展示逻辑，需同步适配自定义标题（探索结论：前端展示直接用 `title` 字段，未发现前缀解析逻辑，实施时二次确认）。

### 5.3 文档与发版

**Step 6：CHANGELOG 与规范同步**

- 根 `CHANGELOG.md` 顶部新增版本小节，小节为"后端"，说明：`spawn_subagent` 新增可选 `title` 参数，主代理可自定义后台子代理会话标题。
- 按 AGENTS.md 规范检查 `skills/mao-cli/SKILL.md` 是否涉及该工具描述，若涉及则同步。

## 6. 落地清单

### 要做的

| # | 事项 | 文件 |
|---|---|---|
| 1 | `SpawnSubagentTool` Schema/描述/Prompt 增加可选 `title` 参数并透传 | `backend-ts/src/harness/tool/impl/background-subagent-tools.ts` |
| 2 | `BackgroundSubagentManager.spawn()` 增加 `customTitle` 参数，新增 `resolveChildTitle`/`cleanTitle` | `backend-ts/src/harness/delegate/background-subagent-manager.ts` |
| 3 | 结果摘要展示自定义标题 | `backend-ts/src/session/util/tool-result-summarizer.ts` |
| 4 | 后端单测：标题自定义/截断/清洗回退/兜底 4 组用例 + 摘要用例 | `background-subagent-manager.spec.ts`、`session-utils.spec.ts`（或对应 spec） |
| 5 | 前端工具参数预览补充 `title` | `desktop/src/utils/toolDisplay.ts` |
| 6 | CHANGELOG 新增"后端"小节；按需同步 mao-cli 文档 | `CHANGELOG.md`、`skills/mao-cli/SKILL.md` |

### 不做的

| # | 事项 | 原因 |
|---|---|---|
| 1 | `delegate` / `delegate_followup` 支持自定义标题 | 范围限定后台子代理链路 |
| 2 | `subagent_followup` 标题参数 | 追问复用同一会话，标题不变 |
| 3 | LLM 智能生成缺省标题 | 拼接兜底够用，避免额外延迟/成本 |
| 4 | 数据库迁移 | 沿用 `session.title` VARCHAR(256) |
| 5 | UI 手动重命名子代理标题入口 | 非本次诉求 |
| 6 | 完成通知卡片版式调整 | 标题经现有 `title` 字段自然透出 |
| 7 | 其他后台子代理工具（check/cancel/wait）改动 | 与标题无关 |

## 7. 测试与验证

1. `cd backend-ts && npm run build` 通过（tsc 类型检查）。
2. `cd backend-ts && npm test > /tmp/x.log 2>&1; echo exit=$?`，grep 摘要确认新增用例通过、无回归：
   - `background-subagent-manager.spec.ts` 标题四组用例；
   - 结果摘要含标题的用例（参照现有 `启动后台子代理 (explorer) #193 (运行中)` 断言扩展）。
3. `cd desktop && npx vue-tsc --noEmit`（或项目既有类型检查命令）通过。
4. 手动验证（开发环境）：让主代理派发两个并行子代理并分别提供标题，子代理列表与完成通知中展示自定义标题；不传 `title` 时展示旧式拼接标题。

## 8. 风险与限制

| 风险 | 说明 | 缓解 |
|---|---|---|
| 模型不传或乱传标题 | `title` 为可选参数，模型可能忽略或给出低质量标题 | Prompt 明确引导；服务端清洗 + 空值回退兜底，最差情况退化为现状 |
| 标题同质化 | 并行子代理标题可能仍然雷同（模型自由发挥） | Prompt 建议"简短可区分"；不强制唯一性（标题非标识符，识别仍靠 task_id） |
| 历史会话兼容 | 旧子代理会话标题仍是拼接格式 | 纯展示层差异，无需数据订正 |
