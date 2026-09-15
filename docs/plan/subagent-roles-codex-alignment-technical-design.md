# 子代理角色对齐 Codex 并扩展 reviewer 技术方案

> 文档状态：已实施（2026-09-26）
> 日期：2026-09-26
> 已拍板：
> - 基座对齐 Codex：`default` / `explorer` / `worker`；explorer 零工具限制（只读靠提示词）
> - 在基座上 **thin 扩展** 内置 `reviewer`（仅 description + systemPromptOverride，无工具/模型覆盖）
> - 历史数据：`researcher→explorer`、`coder→worker`；**`reviewer` 名保留**，不迁移
> - 未知 `agent_type` 报错并返回 available_types；仅旧名（researcher/coder）归一
> - 本轮不做 desktop 中文角色映射
> 适用范围：`backend-ts/`、`desktop/`（共用 UI 预览文案）、`skills/mao-cli/`（文档同步）、历史数据 Flyway 迁移
> 关联文档：
> - [后台子代理技术方案](./background-subagent-technical-design.md)
> - [移除同步 delegate 技术方案](./subagent-tools-delegate-removal-technical-plan.md)
> - [子代理崩溃恢复](./subagent-crash-recovery-technical-design.md)
> - 外部参考：Codex 子代理角色 `default` / `explorer` / `worker`（见 `~/Downloads/subagent-roles.md` 摘要，非仓内文件）

---

## 1. 需求背景

### 1.1 现状问题

当前内置子代理角色为 `researcher` / `reviewer` / `coder`（`AgentDefinitionRegistry`），存在三类结构性问题：

1. **researcher 与 reviewer 语义重叠**  
   二者运行时几乎同构：均覆盖独立 system prompt、禁用 `edit_file` / `ask_user_questions`、允许 `write_file`。但重叠点在「能力面」而非「任务语义」：调研定位与代码审查其实需要不同的行为指令与输出结构，旧实现用工具黑名单切开角色，反而既笨重又仍难选型。

2. **缺少 generalist（default）**  
   所有子代理都被强制套用窄域 system prompt 与工具黑名单。当父代理只想并行拆一个「与主代理同能力」的分支时，没有可完整继承父会话配置的角色。

3. **协作纪律未落地**  
   Codex 角色体系最有价值的部分是写进角色说明的委派纪律（explorer 并行/复用/信任结论；worker 文件归属权、勿回滚他人改动等）。当前 mao 的 `spawn_subagent` 工具提示与角色 description 几乎只有能力边界描述，缺少编排纪律。

### 1.2 目标

以 Codex 三角色为基座，并 **thin 扩展** 一个审查角色：

| 新角色 | 定位 | 与旧角色映射 |
|---|---|---|
| `default` | 通用子代理，完整继承父会话 | **新增** |
| `explorer` | 只读代码库调研 / 问答，快速权威 | 吸收 `researcher` |
| `worker` | 真正落码的并行执行代理 | 吸收 `coder` |
| `reviewer` | 只读代码审查（严重级别 + 位置 + 建议） | **保留原名**；能力面从「工具黑名单」改为「thin prompt」 |

并角色哲学：

- **角色 = 有界的配置覆盖**，默认只能收窄，不能放大父会话权限；
- **内置角色运行时不改模型 / reasoning / 权限**；差异主要在：给父代理看的 description + 子代理 system 指令（`systemPromptOverride` ≈ Codex `developer_instructions`）；
- **explorer / worker / reviewer / default 均不做工具黑名单**（已拍板对齐 Codex「零配置覆盖、靠提示词」）；
- **委派纪律写入工具描述与角色说明**，让父代理知道何时并行、何时复用、何时本地等待。

角色数量上限约定为 **4**（default / explorer / worker / reviewer）。后续不再随意增角色；新诉求优先写成 task 描述或后续「自定义角色」能力（本轮不做）。

### 1.3 边界说明（要做 / 不做）

| 要做的 | 不做的 |
|---|---|
| 重写内置角色为 `default` / `explorer` / `worker` / `reviewer` | 不改用户侧「智能体」表（`agent`）及 `mao-agent --agent` 语义 |
| Flyway 仅迁移 `researcher`→`explorer`、`coder`→`worker` | 不迁移历史 `reviewer` 行；不迁移会话消息正文 |
| `spawn_subagent` 输入侧规范角色名（researcher/coder 归一） | 不做运行时自定义角色文件 / 管理后台角色编辑 |
| 工具描述与 PromptEngine 写入 Codex 委派纪律 | 不实现 Codex 的 nickname 列表 |
| 崩溃恢复对旧 agentType 兼容（别名解析） | 不为 explorer/reviewer 单独做只读文件系统沙箱 |
| 同步更新受影响测试、desktop 预览测试、mao-cli 文档、CHANGELOG | 不改 `subagent` 工具族的异步语义 / 恢复 / 投递体系 |
| explorer / worker / reviewer 的 description + system prompt | 不给 default 套独立 systemPromptOverride |
| 未知 `agent_type` 仍报错；仅 researcher / coder 归一 | 不把未知类型静默落到 default；**不**把传入的 `reviewer` 再归一成 explorer |
| desktop 本轮继续透传英文 `agent_type` | 不做中文标签映射 |

---

## 2. 角色设计

### 2.1 设计原则（对齐 Codex + thin reviewer）

```text
角色声明
  ├─ description        → 拼进 spawn_subagent 工具描述，指导父代理选型
  ├─ systemPromptOverride → 子代理自身行为指令（可选；default 不设）
  ├─ excludedToolNames  → 可选工具收窄（内置角色本轮一律不设）
  └─ allowedToolNames   → 可选白名单（本轮不使用）
```

硬规则：

1. 角色覆盖只允许**收窄**能力，不得放大父会话权限、workspace、审批策略；
2. 无配置覆盖时，子代理**完全继承**父会话（模型、工具、权限、技能等由既有 `buildContext` 决定）；
3. 子代理仍不得再派生子代理（`buildSubContext` 已剔除全部 `subagent*` / `delegate*` 工具，不变）。

### 2.2 四角色定义

#### `default`

| 字段 | 值 |
|---|---|
| description | 默认子代理，无额外约束。子任务无特殊诉求、或不确定选型时的首选。能力与主代理一致。 |
| systemPromptOverride | **无**（完整继承父会话 system prompt 与人格） |
| excludedToolNames | **无**（仅保留全局子代理工具剔除） |
| 定位 | 通用并行分支 |

#### `explorer`

| 字段 | 值 |
|---|---|
| description | 用于具体的代码库问题，快速且权威；只调研、不改代码。多个独立问题可并行派生多个 explorer；相关问题复用已有 explorer；默认信任其结论，无需额外验证。代码审查请用 reviewer；代码修改请派 worker。 |
| systemPromptOverride | 见 §2.3（只读调研：定位定义、调用链、配置消费点；先结论后证据；禁止修改代码） |
| excludedToolNames | **无**（对齐 Codex「零配置覆盖、靠提示词约束」） |
| 定位 | 只读代码库调研 / 问答代理 |

> 设计取舍（已拍板）：旧 `researcher` 曾硬禁 `edit_file`。explorer 的「只读」由 system prompt + description 约束，不靠工具面。若后续实测出现误写，再在角色上补 `excludedToolNames: ['edit_file']`（仍属收窄，不违反原则），本轮不做。

#### `worker`

| 字段 | 值 |
|---|---|
| description | 用于执行与产出：实现部分功能、修测试或 bug、把大重构拆成独立块。必须显式分配归属权（哪些文件/模块由哪个 worker 负责）；告知 worker「你不是一个人在改代码」，禁止回滚他人改动，应调整自己的实现去适配。代码改动类任务优先派 worker，而不是只让 explorer/reviewer 做只读分析。 |
| systemPromptOverride | 见 §2.3（先读现有实现与项目规范再改；只做分配范围内子任务；完成后编译/测试验证；输出改动说明 + 验证结果；无法与用户交互时自行选择最合理方案并在结果中说明） |
| excludedToolNames | **无**（全局剔除 `ask_user_questions` 与 subagent 系列） |
| 定位 | 真正落代码的并行执行代理 |

#### `reviewer`（thin 扩展）

| 字段 | 值 |
|---|---|
| description | 用于代码审查：只读检查未提交改动或指定范围，按严重程度输出问题清单（位置 + 影响 + 修复建议），不直接改代码。修复请派 worker；审查闭环为 reviewer → worker → followup reviewer 复查。与 explorer 的区别：explorer 回答「代码怎么工作」，reviewer 回答「代码有什么问题」。 |
| systemPromptOverride | 见 §2.3（只读审查；严重级别分类；可验证问题优先；禁止 edit；建议交 worker） |
| excludedToolNames | **无**（thin role：仅 prompt 差异，与 explorer 能力面相同） |
| 定位 | 只读代码审查代理 |

**为何保留独立 reviewer 而不是并入 explorer（已拍板）**

1. 选型成本：`agent_type=reviewer` 比「explorer + 长审查约束 task」更不易漏项；
2. 行为可钉死：审查输出结构（严重级别 / 文件:行 / 可验证问题）与调研结论结构不同，适合独立 systemPromptOverride；
3. 与 Codex 差异可接受：Codex 无 reviewer 是「审查当任务」；mao 审查闭环是高频路径，thin 扩展收益大于角色表膨胀；
4. 仍是 thin role：**不**再引入工具黑名单，避免回到旧 researcher/reviewer 笨重模型。

### 2.3 子代理 system prompt 草案（中文，实施时可微调）

**explorer**

```text
你是一个专注代码库调研的助手。你的任务是针对具体问题，快速、准确地给出可行动的结论。
只做调研与分析，不要修改任何代码或文件。
请优先使用搜索、读取、跳转定义/引用等只读手段；必要时可并行处理多个独立问题。
输出格式：先给出核心结论，再列出支撑证据（文件路径、符号、调用关系）。
若信息不足或存在歧义，明确指出缺口与验证建议，不要编造。
若任务实际是代码审查，请按审查规范输出问题清单（可参考同仓 reviewer 角色约定）；需要改代码时交由 worker。
```

**worker**

```text
你是一个专注编码实现的助手。你的任务是完成边界清晰、逻辑独立的编码工作。
先阅读相关代码，理解现有实现与项目规范，再动手修改；保持与项目现有风格、约定和依赖一致。
只完成分配给你的子任务与文件/模块范围，不要扩大范围或改动无关代码。
你不是一个人在改代码：不要回滚或覆盖他人的改动；若与并行改动冲突，调整自己的实现去适配。
完成后运行相关的编译或测试进行验证，确保改动可用。
输出格式：先说明完成的改动（涉及文件与关键逻辑），再给出验证结果。
你无法与用户交互；遇到需要决策的分歧时选择最合理的方案并在结果中说明。
```

**reviewer**

```text
你是一个专注代码审查的助手。你的任务是只读审查指定代码范围或未提交改动，发现真实问题。
不要修改任何代码或文件；需要修复时在建议中说明应改什么、为何，交给后续 worker 执行。
审查关注：正确性、安全性、性能、可维护性、错误处理、与既有约定的一致性。
优先报告可验证、可复现的问题；避免空泛风格意见与无信息量的「建议加注释」。
输出格式：
1. 总体结论（是否可合并 / 阻塞项数量）；
2. 问题列表：按严重程度（阻塞 / 重要 / 建议）分类，每条含 文件:行、问题描述、影响、修复建议；
3. 若未发现可触发功能 bug 的问题，明确说明，不要编造空报告。
你无法与用户交互；信息不足时列出已检查范围与仍存风险，不要编造。
```

**default**：不注入 `systemPromptOverride`。

### 2.4 旧角色去留与闭环

| 旧名 | 处理 |
|---|---|
| `researcher` | 删除内置定义；运行时映射 → `explorer`；DB 迁移为 explorer |
| `reviewer` | **保留**为 thin 内置角色；DB **不迁移** |
| `coder` | 删除内置定义；运行时映射 → `worker`；DB 迁移为 worker |

审查 → 修复 → 再审查闭环（推荐写进工具 prompt）：

```text
spawn reviewer(审查未提交改动 / 指定 diff，只读输出问题清单)
  → spawn worker(按清单修复，写明文件归属) 或 subagent_followup(worker)
  → subagent_followup(reviewer, 复查修复结果)
```

explorer 仍可做「代码怎么工作」类调研；**不要**再用 explorer 承担正式审查主路径（避免与 reviewer 语义打架）。若模型误把审查派给 explorer，靠 description 分流与后续 review 纠正，不靠工具拒绝。

---

## 3. 技术方案

### 3.1 核心数据流（改造后不变的部分）

```text
主代理 LLM
  → spawn_subagent(agent_type ∈ {default,explorer,worker,reviewer}, task)
  → BackgroundSubagentManager.spawn
      ├─ resolveAgentType（旧名归一，见 §3.3）
      ├─ AgentDefinitionRegistry.getDefinition(canonical)
      ├─ SubagentInvocationService.createBackground（agent_type 写库为 canonical）
      └─ agentExecutor.submit(runBackground)
            → buildSubContext（systemPromptOverride + 全局工具剔除）
            → executeVisible / AgentLoop
            → onCompleted 结果投递父会话
```

崩溃恢复：`SubagentExecutionRecoveryService` 解析 `execution.agentType` 时同样先归一再 `getDefinition`；历史 `reviewer` 无需归一即可命中内置定义。

### 3.2 `AgentDefinitionRegistry` 重写

文件：`backend-ts/src/harness/delegate/agent-definition-registry.ts`

1. 内置注册 `default` / `explorer` / `worker` / `reviewer`；
2. 新增导出常量与别名表（供工具 schema、恢复、spawn 归一复用）：

```ts
export const BUILTIN_AGENT_TYPES = ['default', 'explorer', 'worker', 'reviewer'] as const;
export type BuiltinAgentType = (typeof BUILTIN_AGENT_TYPES)[number];

/**
 * 历史角色名 → 现行角色名。仅用于输入归一与读库解析，不作为对外可选项。
 * 注意：reviewer 不是别名，是正式内置角色，不在本表中。
 */
export const LEGACY_AGENT_TYPE_ALIASES: Record<string, BuiltinAgentType> = {
  researcher: 'explorer',
  coder: 'worker',
};

export function normalizeAgentType(raw: string): string {
  const key = raw.trim().toLowerCase();
  return LEGACY_AGENT_TYPE_ALIASES[key] ?? key;
}
```

3. `getDefinition(name)`：内部先 `normalizeAgentType` 再查 Map；未知仍返回 `undefined`；
4. `getAllDefinitions()`：只返回四个内置角色（别名不进入 enum / 角色清单）。

### 3.3 归一化调用点（必须全覆盖）

| 调用点 | 行为 |
|---|---|
| `SpawnSubagentTool` / 旧 `DelegateTool`（若仍注册）execute | 入口 `normalizeAgentType(agent_type)` 后再校验/落库 |
| `BackgroundSubagentManager.spawn` | 入口再 normalize 一次（防其它调用方绕过工具层） |
| `BackgroundSubagentManager.followup` / `resolveAgentType` | 读库 agentType → normalize → getDefinition |
| `SubagentExecutionRecoveryService.recover` | 同上 |
| `AgentDefinitionRegistry.getDefinition` | 统一 normalize（兜底） |

**写库规则**：新建 execution 的 `agent_type` **只写 canonical**（`default`/`explorer`/`worker`/`reviewer`），不写别名。传入 `reviewer` 时 normalize 后仍为 `reviewer`。

### 3.4 Flyway 历史数据迁移

新增：`backend-ts/db/migration/Vxxx__subagent_agent_type_roles.sql`（版本号按当前最新 V 顺延）

```sql
-- 子代理角色重命名：researcher → explorer，coder → worker
-- reviewer 为正式内置角色，历史行保持不变
UPDATE `subagent_execution`
SET `agent_type` = 'explorer'
WHERE `agent_type` = 'researcher';

UPDATE `subagent_execution`
SET `agent_type` = 'worker'
WHERE `agent_type` = 'coder';
```

说明：

- 仅改维值列，无外键依赖；
- 迁移后 researcher/coder 相关列表/Tab/完成卡片展示变为 explorer/worker；reviewer 展示不变；
- 运行中 recovery 候选行也会被改写，与代码侧 alias 双保险；
- **不**改 `session.title` 历史标题（「后台子代理(researcher): …」保留历史痕迹，可接受；若产品要求标题统一，另开任务批量 UPDATE title 模式串，非本方案必需）。

### 3.5 工具层：`spawn_subagent` 契约

文件：`backend-ts/src/harness/tool/impl/background-subagent-tools.ts`

#### InputSchema

```ts
agent_type: {
  type: 'string',
  enum: BUILTIN_AGENT_TYPES, // ['default','explorer','worker','reviewer']
  description: '子代理类型：\n'
    + registry.getAllDefinitions().map(d => `- ${d.name}：${d.description}`).join('\n'),
}
```

建议 `SpawnSubagentTool` 构造注入 `AgentDefinitionRegistry`（与旧 `DelegateTool` 一致），避免 description/enum 再硬编码。

#### getToolPrompt（委派纪律，对齐 Codex spawn_agent）

在现有「后台子代理」说明基础上，写入：

1. **选型**：不确定用 default；代码库问答/定位用 explorer；代码审查用 reviewer；改代码用 worker。  
2. **计划**：先快速分析整体任务，区分关键路径阻塞任务与可并行 sidecar。  
3. **本地优先**：不要把关键路径上的阻塞工作外包后干等；这类任务留在本地做。  
4. **自包含**：子任务必须具体、自包含，且实质性推进主任务（目标、输入、期望输出、约束）。  
5. **勿重复**：不要在同一未解决线程上重复派发，除非新任务确实不同且必要。  
6. **写入范围**：并行子任务写入范围不得重叠；代码改动优先 worker。  
7. **wait 少用**：`wait_subagents` 仅在下一步被阻塞、必须立刻拿到结果时调用；运行期间做不重叠的本地工作。  
8. **返回后**：先快速审查子代理改动/结论，再集成或细化。  
9. **worker 归属权**：派发多个 worker 时必须在各自 task 中写明负责的文件/模块，并说明存在并行协作者。  
10. **explorer 复用/并行**：多个独立问题并行多个 explorer；相关问题复用已有 explorer；默认信任结论。  
11. **reviewer 闭环**：审查用 reviewer 且不要让其改代码；修复派 worker；必要时 `subagent_followup(reviewer, 复查)`。  
12. 既有约束保留：子代理无法与用户交互、不能再生子代理；主线结束自动挂起等待。

#### description（工具对外一句话）

补充一句「角色见 agent_type 枚举：default 通用 / explorer 调研 / reviewer 审查 / worker 写代码」。

### 3.6 PromptEngine 角色提示

文件：`backend-ts/src/harness/core/prompt-engine.ts` → `subagentToolHints`

在 spawn 段追加简短选型表（与工具 description 互补，不重复全文）：

```text
- default：通用并行，完整继承主代理能力
- explorer：代码库调研/问答，只读，多问题可并行、结论默认可信
- reviewer：代码审查，只读问题清单；修复派 worker，可 followup 复查
- worker：实现与修改代码；多 worker 需划分互不重叠的文件/模块归属
```

并强调：关键路径勿外包干等；`wait_subagents` 慎用。

### 3.7 `buildSubContext`

文件：`background-subagent-manager.ts`

逻辑不变：

- 全局剔除：`delegate`、`delegate_followup`、`spawn_subagent`、`subagent_followup`、`check_subagent`、`cancel_subagent`、`wait_subagents`；
- `default`：无 override、无 excluded → 与父会话工具面一致（除全局剔除）；
- `explorer` / `worker` / `reviewer`：应用各自 `systemPromptOverride`；
- 清空 skills（现状保持；与 Codex「角色可收窄 skills」方向一致，本轮仍全关）。

### 3.8 完成通知与摘要文案

| 位置 | 现状 | 改后 |
|---|---|---|
| `tool-result-summarizer` `spawn_subagent` | `启动后台子代理 (${agentType})` | 逻辑不变（agentType 已是 canonical） |
| 完成通知 `后台子代理（${agentType}）…` | 透传 | 不变 |
| desktop `ToolCallCard` / `toolDisplay` | 透传 `agent_type` | 不变；测试样例改为新名 |
| 可选增强（本轮不做，已拍板） | — | `toolDisplay` 中文映射留二期 |

### 3.9 崩溃恢复

`SubagentExecutionRecoveryService`：

1. `normalizeAgentType(execution.agentType)`（`reviewer` 原样通过）；
2. `definitionRegistry.getDefinition`；
3. 仍失败才 `fail(未知的子代理类型)`。

迁移 + alias 后，恢复路径应无历史类型失败。

---

## 4. 改动清单（按文件）

### 4.1 后端

| 文件 | 改动 |
|---|---|
| `harness/delegate/agent-definition-registry.ts` | 重写四角色；导出 `BUILTIN_AGENT_TYPES` / `LEGACY_AGENT_TYPE_ALIASES` / `normalizeAgentType`；`getDefinition` 归一 |
| `harness/tool/impl/background-subagent-tools.ts` | schema enum + 动态角色清单；getToolPrompt 委派纪律（含 reviewer 闭环）；execute 归一；注入 registry |
| `harness/delegate/background-subagent-manager.ts` | spawn/followup/resolve 入口归一；title 用 canonical |
| `harness/delegate/subagent-execution-recovery.service.ts` | 恢复前归一 agentType |
| `harness/core/prompt-engine.ts` | `subagentToolHints` 四角色选型与纪律 |
| `harness/tool/tool-registry.ts` | `SpawnSubagentTool` 构造传入 `definitionRegistry` |
| `db/migration/Vxxx__subagent_agent_type_roles.sql` | 仅迁 researcher/coder |
| `session/util/tool-result-summarizer.ts` | 无需改逻辑；若摘要对别名有分支则统一 |
| 相关 `*.spec.ts` | 见 §6 |

旧 `delegate-tool.ts`：运行时已不注册；**仅当**测试仍直接 `new DelegateTool` 且断言角色清单时同步改断言，不要求为对齐角色去扩展已下线工具。可选：在 DelegateTool 的 error `available_types` 文案改为新枚举（低优先级）。

### 4.2 前端（desktop）

| 文件 | 改动 |
|---|---|
| `utils/toolDisplay.test.ts` | 样例改为 `worker` / `explorer` / `default` / `reviewer`（reviewer 可保留作透传样例） |
| 其它硬编码角色处 | 按 grep：仅出现在测试与通用透传时，以测试为准 |

无必须的 Vue 逻辑改动（agent_type 透传）。

### 4.3 文档与说明

| 文件 | 改动 |
|---|---|
| `skills/mao-cli/reference/project.md` | 内置子代理角色描述改为四角色 |
| `docs/handoff/embed-page-agent-handoff.md` 等 | 审查主路径 `spawn reviewer` 保持；调研类改为 explorer |
| `CHANGELOG.md` | 用户可见：default 新增、researcher/coder 重命名、reviewer thin 化、历史映射、委派纪律 |
| `README.md` / 其它产品文档 | 若写死旧三角色则同步（按全仓 grep） |

### 4.4 明确不改

- `agent` 表与用户自定义智能体（`agent.service` 里的 name=`coder` 等与本方案无关）；
- `mao-agent` CLI `--agent`（选的是用户智能体，不是 subagent role）；
- subagent 异步执行、wait/cancel/followup、恢复协调器主流程；
- WS 事件名与前端 Tab 基础设施。

---

## 5. 兼容与发布

### 5.1 兼容策略

1. **DB 迁移**改写 researcher/coder 历史行；reviewer 行不动；  
2. **代码 alias** 兜底：滚动窗口内旧前端/旧缓存工具参数仍可能带 `coder`/`researcher`；  
3. **对外 enum 暴露四角色**（含 reviewer），避免模型继续使用 researcher/coder；  
4. **传入 reviewer 不再视为 legacy**：normalize 保持 reviewer，走 thin 审查 prompt。

### 5.2 发布顺序

1. 合入后端 registry + 工具 + 迁移 + 测试；  
2. 部署后端（Flyway 自动跑 `Vxxx`）；  
3. 同步部署 desktop（测试/文案）与文档；  
4. CHANGELOG 写入版本说明。  

### 5.3 回滚

- 代码可回滚到旧 registry；  
- DB 回滚脚本（可选预写在迁移注释中）：

```sql
-- explorer 无法区分原 researcher；reviewer 未迁移无需回滚
UPDATE subagent_execution SET agent_type = 'researcher'
  WHERE agent_type = 'explorer' AND /* 不可精确还原，仅兜底示例 */ 1=0;

UPDATE subagent_execution SET agent_type = 'coder'
  WHERE agent_type = 'worker';
```

说明：`explorer` 无法区分原 `researcher`；`reviewer` 因未迁移可原样保留。回滚代码侧可用 alias 反向：`explorer→researcher`、`worker→coder`（角色行为回退即可）。实施时在迁移文件注释写明「researcher 不可精确逆迁移，回滚以代码 alias 为准；reviewer 未改写」。

---

## 6. 测试计划

### 6.1 后端单测

| 测试 | 要点 |
|---|---|
| `agent-definition-registry`（新/扩） | 注册四角色；`reviewer` 非 alias；`researcher`/`coder` 归一；default 无 override；explorer/worker/reviewer prompt 符合定义且无 excluded |
| `background-subagent-tools.spec` | schema enum=四角色；传 `coder`→`worker`、`researcher`→`explorer`；传 `reviewer` 仍为 `reviewer`；未知类型报错 |
| `background-subagent-manager.spec` | spawn/followup 使用 canonical；followup 读历史 `coder` 可解析；`reviewer` 原样 |
| `subagent-execution-recovery.service.spec` | 历史 `researcher`/`coder` 可恢复；`reviewer` 可恢复；未知仍 fail |
| `delegate-followup-tool.spec`（若保留） | 断言角色清单含四角色 |
| `prompt-engine.spec` | system prompt 含 default/explorer/worker/reviewer 选型提示 |
| `tool-result-summarizer` / `session-utils.spec` | 样例可改用 `explorer`/`reviewer`；旧 `researcher` 输入若入口未归一仍可摘要 |

### 6.2 前端

- `toolDisplay.test.ts`：样例覆盖 `worker` / `explorer` / `default` / `reviewer`。

### 6.3 手工验收

1. 主代理 spawn 四个角色各一次：Tab 标题、完成卡片、check 进度正常；  
2. 对旧会话 followup（库内曾为 coder，迁移后为 worker；reviewer 保持 reviewer）：可纠偏/追问；  
3. explorer 任务「只查不改」与 reviewer「按严重级别出清单」：提示词层行为符合预期；  
4. 审查闭环：spawn reviewer → worker 修复 → followup reviewer 复查；  
5. 并行两个 worker，task 中写明互斥路径：结果文件不互相覆盖；  
6. 重启后端触发 recovery：RUNNING 执行可恢复且 agentType 解析成功（含历史 researcher/coder 与 reviewer）；  
7. 主线未调用 `wait_subagents`、仍有子代理运行时：主线自动挂起等待行为不回归。  

---

## 7. 实施顺序建议

1. Registry + normalize API + 单测；  
2. Manager / Recovery / 工具 schema 与 prompt（含 reviewer 闭环文案）；  
3. PromptEngine hints；  
4. Flyway 迁移（仅 researcher/coder）；  
5. tool-registry 接线与全量 `npm test`；  
6. desktop 测试与文档 / CHANGELOG；  
7. 手工验收 §6.3。  

预估触面小、风险集中在「历史 agentType」与「模型是否遵守新纪律提示」；执行链路（异步 spawn / wait / 投递 / 恢复）零结构性变更。reviewer 因名未改，历史 followup / recovery 兼容成本最低。

---

## 8. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| 模型审查仍派 explorer | description 分流 + prompt 写明「审查用 reviewer」；不靠工具拒绝 |
| explorer/reviewer 职责在提示词层打架 | explorer prompt 弱化正式审查主路径；reviewer 专注问题清单；长期可观察误用率 |
| explorer/reviewer 无工具硬禁导致误写 | 已拍板 zero tool narrowing；二期可补 `edit_file` 排除 |
| default 能力过强（全工具） | 与父会话一致是设计目标；危险工具仍走既有审批/权限 |
| 历史 title 仍含 researcher/coder | 可接受；产品若在意另开 title 清洗 |
| 角色继续膨胀 | 约定上限 4；新诉求走 task 文案或未来自定义角色 |
| 自定义角色 / 模型 / reasoning 覆盖 | 明确 out of scope；结构上 `AgentDefinition` 可扩展字段，本轮不实现 |

---

## 9. 验收标准（DoD）

- [ ] 内置角色为 `default` / `explorer` / `worker` / `reviewer`，且 getDefinition 支持 researcher/coder 归一  
- [ ] `reviewer` 是正式角色而非 alias；历史 DB 行未被改写为 explorer  
- [ ] 新建 execution 的 `agent_type` 只落 canonical  
- [ ] Flyway 已迁移历史 researcher → explorer、coder → worker  
- [ ] `spawn_subagent` enum 与角色清单正确，工具 prompt 含委派纪律与 reviewer 闭环  
- [ ] PromptEngine 含四角色选型提示  
- [ ] 崩溃恢复对迁移前 agentType 及 reviewer 不失败  
- [ ] `backend-ts` 单测、desktop 相关测试通过  
- [ ] CHANGELOG + mao-cli 参考文档已同步  
- [ ] §6.3 手工验收通过  
