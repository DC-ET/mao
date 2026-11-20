# 飞书进度卡展示运行中子代理（P0）技术方案

- 状态：技术方案，待实施
- 日期：2026-10-19
- 需求来源：群内需求「优化飞书卡片任务状态展示，增加子代理信息」
- 需求澄清：
  1. `delegate` 已废弃，不再展示历史 DELEGATE 执行；
  2. 只做 P0（运行中子代理列表），不做 P1 实时刷新；
  3. 类型文案使用「调研 / 开发 / 审查」+ 任务标题。
- 关联代码（当前 `main`，2026-10-19 拉取）：
  - `backend-ts/src/feishu/progress-card.ts`
  - `backend-ts/src/feishu/patched-progress.ts`
  - `backend-ts/src/harness/delegate/background-subagent-manager.ts`
  - `backend-ts/src/harness/delegate/subagent-execution.mapper.ts`
  - `backend-ts/src/create-app.ts`

## 1. 背景与结论

### 1.1 现状

飞书进度卡目前只呈现主代理的执行状态：状态行、正文、「本轮工具」、提问表单和按钮。子代理运行期间，用户只能从工具行看到 `wait_subagents：等待后台子代理（执行中）`，无法知道当前有哪些子代理在跑、分别做什么。

卡片数据链路：

1. `FeishuCardProgressListener`（`feishu/card-progress-listener.ts`）在工具调用开始、参数流式拼接、轮次结束时调用 `progress.update(status, round, content, tools)`。
2. `createFeishuPatchedProgress`（`feishu/patched-progress.ts:28`）做 250ms 节流并 PATCH 飞书卡片，同时缓存最后一次快照供卡片回调同步重绘（`renderCurrent`）。
3. `buildFeishuProgressCard`（`feishu/progress-card.ts:69`）负责纯渲染，当前只接受主代理维度数据。

子代理数据已具备权威来源：

- `subagent_execution` 表（`db/migration/V040__subagent_delegation.sql`）记录 `parent_session_id`、`child_session_id`、`agent_type`、`task_description`、`status`、`total_rounds`、`started_at`，且 `parent_session_id` 有索引。
- `BackgroundSubagentManager`（`harness/delegate/background-subagent-manager.ts:104`）在内存中维护 `runningByParent` / `runningRefsByTask`，后者能拿到运行中的实时轮次（DB 的 `total_rounds` 只在终态落库）。
- 子代理会话标题在 `session.title`，spawn 时由 `resolveChildTitle` 生成（自定义标题，或 `后台子代理(type): 任务前 40 字`）。

### 1.2 结论

P0 可行，且改动被限制在「卡片渲染 + 子代理快照查询 + 装配」三处：

- 不改 `FeishuCardProgressListener` 的 `update` 接口，因此钉钉复用同一 listener 的行为完全不变；
- 不改 WS 协议、不改主代理循环、不改子代理生命周期；
- 不新增数据库迁移，只新增一条只读查询。

### 1.3 `delegate` 现状核实

结论：`delegate` / `delegate_followup` 已是历史遗留能力，新任务不会再产生 `DELEGATE` 执行。

证据：

1. `harness/tool/tool-registry.ts:110` 的 `createDefaultToolRegistry` 中，子代理相关工具只注册了 `spawn_subagent` / `subagent_followup` / `check_subagent` / `cancel_subagent` / `wait_subagents`（153-157 行），没有 `DelegateTool` / `DelegateFollowupTool`。
2. `harness/core/prompt-engine.ts:618` 的子代理工具指引只描述 spawn / followup / check / wait / cancel，不再向模型暴露 delegate。
3. `delegate-tool.ts`、`SubagentInvocationService.createDelegate`、`harness-service.ts:240-257` 的 `invocation_type = 'DELEGATE'` 兼容逻辑仍在，用于历史记录的恢复与结果交付，不会创建新的执行。

因此 P0 查询明确过滤 `invocation_type IN ('BACKGROUND','FOLLOWUP')`，历史 DELEGATE 的 RUNNING 残留也不会出现在卡片上。

## 2. 目标与非目标

### 2.1 目标

1. 父任务处于 `RUNNING` 且存在运行中的后台子代理时，在卡片正文下方、本轮工具上方展示：
   - 段落标题：`**子代理 · N 个运行中**`；
   - 每行：`- 调研 · 任务标题 · 第 2 轮`（类型中文映射 + 任务标题，必要时带轮次/恢复中）。
2. 列表数据准确反映 `subagent_execution` 中 `RUNNING` / `RECOVERING` 的后台子代理。
3. 无子代理时卡片与现状完全一致；终态卡片不展示该段落。
4. 查询失败、标题为空、标题超长、特殊字符等情况不影响卡片正常更新。
5. 崩溃恢复后的父任务卡片同样能展示运行中子代理（以 DB 为准）。

### 2.2 非目标（P0 明确不做）

- 不做事件驱动的实时刷新（P1）：`wait_subagents` 等待期间子代理完成，不会立即从卡片消失，要等下一次卡片更新。
- 不展示子代理耗时、Token、最近输出、工具摘要或结果。
- 不展示前台 `DELEGATE`（已废弃）。
- 不修改钉钉卡片。
- 不新增 WS 事件、不新增 REST 接口、不新增数据库迁移。
- 不在卡片上提供子代理操作（取消/追问），这些仍走会话详情。

## 3. 方案总览

```
BackgroundSubagentManager.listRunning(parentSessionId)
        │  DB: subagent_execution + session.title（只读）
        │  内存: runningRefsByTask.currentRound 覆盖
        ▼
createPatchedProgress（闭包，绑定 sessionId）
        │  send() 前加载，1s 轻缓存；renderCurrent 用缓存
        ▼
buildFeishuProgressCard(..., subagents)
        │  仅 RUNNING 渲染
        ▼
飞书卡片 PATCH
```

设计原则：

1. **分层不反向**：`BackgroundSubagentManager` 不 import 飞书模块；飞书侧只消费同构的摘要对象，由 `create-app.ts` 装配时映射。
2. **展示层容错**：子代理查询是「锦上添花」，任何异常都降级为空列表/上次快照，绝不阻断主卡片更新。
3. **同步渲染用缓存**：卡片按钮回调要求同步返回卡片 JSON，`renderCurrent` 不能查库，必须使用最近一次加载的快照。
4. **只读、轻量**：单条按索引查询，不联查消息表、不读取结果正文。

## 4. 详细设计

### 4.1 数据层

#### 4.1.1 `SubagentExecutionMapper` 新增查询

文件：`harness/delegate/subagent-execution.mapper.ts`

```ts
listRunningByParent(parentSessionId: number): Promise<RunningSubagentExecutionRow[]> {
  return this.db.query<RunningSubagentExecutionRow>(
    `SELECT e.id,
            e.child_session_id,
            e.agent_type,
            e.task_description,
            e.status,
            e.total_rounds,
            s.title AS child_title
       FROM subagent_execution e
       LEFT JOIN session s ON s.id = e.child_session_id
      WHERE e.parent_session_id = ?
        AND e.status IN ('RUNNING', 'RECOVERING')
        AND e.invocation_type IN ('BACKGROUND', 'FOLLOWUP')
      ORDER BY e.id ASC`,
    [parentSessionId],
  );
}
```

说明：

- `parent_session_id` 命中 `idx_sae_parent`；运行中子代理通常 0-3 条，查询成本可忽略。
- `Db.query` 会把 snake_case 转 camelCase，因此 `child_title` 映射为 `childTitle`。
- 过滤 `invocation_type` 排除历史 `DELEGATE`；`RECOVERING` 是崩溃恢复中的子代理，仍属于「正在运行」。
- 不读取 `result` / `task_description` 以外的长文本；`task_description` 只在标题缺失时兜底使用。

类型放在 `session/types.ts`：

```ts
export interface RunningSubagentExecutionRow {
  id: number;
  childSessionId: number | null;
  agentType: string | null;
  taskDescription: string | null;
  status: string;
  totalRounds: number | null;
  childTitle: string | null;
}
```

#### 4.1.2 `BackgroundSubagentManager.listRunning`

文件：`harness/delegate/background-subagent-manager.ts`

```ts
export interface RunningSubagentSummary {
  taskId: number;
  childSessionId: number | null;
  agentType: string | null;
  title: string;
  status: string;
  round: number;
}

async listRunning(parentSessionId: number): Promise<RunningSubagentSummary[]> {
  let rows: RunningSubagentExecutionRow[];
  try {
    rows = await this.deps.subagentExecutionMapper.listRunningByParent(parentSessionId);
  } catch (e) {
    harnessLog('warn', `Failed to list running subagents for parent ${parentSessionId}: ${(e as Error).message}`);
    return [];
  }
  return rows.map((row) => {
    const refs = this.runningRefsByTask.get(row.id);
    return {
      taskId: row.id,
      childSessionId: row.childSessionId,
      agentType: row.agentType,
      title: runningSubagentTitle(row),
      status: row.status,
      round: refs
        ? Math.max(0, refs.context.currentRound)
        : Math.max(0, row.totalRounds ?? 0),
    };
  });
}
```

标题清洗（模块内函数，复用现有 `cleanTitle`）：

```ts
const AUTO_TITLE_PREFIX = /^后台子代理\([^)]*\):\s*/;

function runningSubagentTitle(row: RunningSubagentExecutionRow): string {
  const raw = row.childTitle != null && row.childTitle.trim() !== ''
    ? row.childTitle.replace(AUTO_TITLE_PREFIX, '')
    : row.taskDescription ?? '';
  const cleaned = cleanTitle(raw);
  return cleaned ?? `子代理 #${row.childSessionId ?? row.id}`;
}
```

规则：

1. 优先 `session.title`；若仍是自动生成前缀（`后台子代理(explorer): …`），去掉前缀避免与类型文案重复。
2. 无标题时回退 `task_description`；再回退 `子代理 #<childSessionId>`。
3. 复用 `cleanTitle`：去控制字符、压缩空白、超 40 字截断。
4. 运行中轮次优先取内存 `runningRefsByTask`；跨重启后内存为空，则用 DB 的 `total_rounds`（通常为 0，卡片不展示轮次）。

#### 4.1.3 飞书侧展示类型

文件：`feishu/progress-card.ts`

```ts
export interface FeishuSubagentSummary {
  taskId: number;
  agentType: string | null;
  title: string;
  status: string;
  round: number;
}
```

`create-app.ts` 装配时从 `RunningSubagentSummary` 映射（字段直接对应，去掉 `childSessionId`，避免不必要的卡片数据面）。

### 4.2 渲染层

#### 4.2.1 类型文案

```ts
const SUBAGENT_TYPE_LABELS: Record<string, string> = {
  explorer: '调研',
  worker: '开发',
  reviewer: '审查',
  default: '通用',
};
```

未知类型直接展示原值（如自定义 agent 类型）；空类型展示「子代理」。

#### 4.2.2 段落位置

`buildFeishuProgressCard` 增加第 10 个可选参数：

```ts
export function buildFeishuProgressCard(
  status: FeishuCardStatus, round: number, content: string, tools: string[],
  action?: FeishuProgressCancelAction, elapsedMs?: number, sessionDetailUrl?: string,
  pendingAsks?: FeishuPendingAsk[], disliked = false,
  subagents: FeishuSubagentSummary[] = [],
): Record<string, unknown>
```

在 `sections` 中插入到正文之后、本轮工具之前（与需求截图红框一致）：

```ts
if (content.trim() !== '') {
  sections.push({ tag: 'markdown', content: content.slice(0, 6000), text_align: 'left', text_size: 'normal_v2' });
}
if (status === 'RUNNING') {
  const section = subagentSection(subagents);
  if (section != null) {
    sections.push({ tag: 'markdown', content: section, text_align: 'left', text_size: 'normal_v2' });
  }
}
if (visibleTools.length > 0) { /* 现有「本轮工具」 */ }
```

#### 4.2.3 段落文本

```ts
const MAX_CARD_SUBAGENTS = 5;

function subagentSection(subagents: FeishuSubagentSummary[]): string | null {
  const visible = subagents.filter((s) => s.title.trim() !== '').slice(0, MAX_CARD_SUBAGENTS);
  if (visible.length === 0) return null;
  const lines = visible.map((s) => {
    const type = SUBAGENT_TYPE_LABELS[s.agentType ?? ''] ?? (s.agentType ?? '子代理');
    const meta: string[] = [];
    if (s.round > 0) meta.push(`第 ${s.round} 轮`);
    if (s.status === 'RECOVERING') meta.push('恢复中');
    return `- ${type} · ${sanitizeInlineTitle(s.title)}${meta.length > 0 ? ` · ${meta.join(' · ')}` : ''}`;
  });
  const rest = subagents.length - visible.length;
  if (rest > 0) lines.push(`- 另有 ${rest} 个运行中`);
  return `**子代理 · ${subagents.length} 个运行中**\n${lines.join('\n')}`;
}

function sanitizeInlineTitle(value: string): string {
  // 长度已由 manager 侧 cleanTitle 截断（40 字 + …），这里只清洗字符，避免把省略号二次截掉
  return value
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/[*_~`\[\]<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
```

渲染效果：

```
状态：正在处理 · 第 121 轮

上一轮的“大小写归一化”会带来新的跨环境风险……

**子代理 · 2 个运行中**
- 调研 · 排查卡片进度链路 · 第 2 轮
- 开发 · 实现子代理展示 · 恢复中

**本轮工具**
- wait_subagents：等待后台子代理（执行中）
```

约束：

- 最多 5 条，剩余折叠为「另有 N 个运行中」；
- 标题由 `cleanTitle` 截断（40 字 + `...`），渲染层压缩空白并去掉会破坏飞书 markdown 的字符；
- 终态、空列表不渲染该段落；
- 段落最长约 300 字符，不触发卡片长度风险。

### 4.3 进度闭包

文件：`feishu/patched-progress.ts`

新增依赖与快照字段：

```ts
export interface FeishuProgressSnapshot {
  status: FeishuCardStatus;
  round: number;
  content: string;
  tools: string[];
  subagents?: FeishuSubagentSummary[];
}
```

```ts
export function createFeishuPatchedProgress(deps: {
  // ...现有字段
  loadSubagents?: () => Promise<FeishuSubagentSummary[]>;
})
```

实现要点：

```ts
const SUBAGENT_CACHE_MS = 1000;
let lastSubagents: FeishuSubagentSummary[] = deps.seed?.subagents ?? [];
let lastSubagentsAt = 0;

async function loadSubagents(force = false): Promise<FeishuSubagentSummary[]> {
  if (deps.loadSubagents == null) return [];
  if (!force && now() - lastSubagentsAt < SUBAGENT_CACHE_MS) return lastSubagents;
  try {
    lastSubagents = await deps.loadSubagents();
  } catch {
    // 保留上次快照；子代理查询失败不能影响主卡片
  }
  lastSubagentsAt = now();
  return lastSubagents;
}
```

`send` 中：

```ts
if (status === 'RUNNING') {
  lastSubagents = await loadSubagents(forceSubagents);
} else {
  lastSubagents = []; // 终态清空，renderCurrent 不再携带
}
const build = (pendingAsks: FeishuPendingAsk[]) => deps.buildCard({
  status, round, content, tools,
  subagents: lastSubagents,
  pendingAsks, elapsedMs, disliked,
});
last = { status, round, content, tools, subagents: lastSubagents };
```

`renderCurrent` 使用缓存：

```ts
return deps.buildCard({
  ...last,
  subagents: last.subagents ?? [],
  pendingAsks, elapsedMs, disliked,
});
```

`refresh()` 强制重新加载：

- 在 `send` 增加内部参数 `forceSubagents`；
- `refresh()` 调用 `send(..., true)`，保证卡片回调触发的刷新能拿到最新子代理列表；
- 1s 缓存避免工具参数流高频更新时重复查库。

### 4.4 装配

文件：`create-app.ts:1960` 的 `createPatchedProgress`：

```ts
const progress = createFeishuPatchedProgress({
  // ...现有 listAsks / clearAsks / patch / startedAtMs / seed
  loadSubagents: async () => {
    const running = await backgroundSubagentManager.listRunning(sessionId);
    return running.map((s) => ({
      taskId: s.taskId,
      agentType: s.agentType,
      title: s.title,
      status: s.status,
      round: s.round,
    }));
  },
  // 关键：buildCard 解构新增 subagents，并作为第 10 个参数传给渲染函数
  buildCard: ({ status, round, content, tools, subagents, pendingAsks, elapsedMs, disliked }) =>
    buildFeishuProgressCard(
      status, round, content, tools, cancelAction ?? undefined, elapsedMs,
      sessionDetailUrl, pendingAsks, disliked, subagents,
    ),
});
```

`backgroundSubagentManager` 在 `create-app.ts:1326` 创建，早于闭包定义，可直接捕获。

注意：`FeishuProgressSnapshot` 新增的 `subagents` 是可选字段，但 `create-app.ts` 的 `buildCard` 必须显式解构并透传，否则数据在装配层被丢弃；`patched-progress.spec.ts` 中的 `buildCard` 桩函数也应同步透传，避免测试只验证了缓存而未验证渲染参数。

三条卡片路径自动生效：

| 路径 | 行为 |
|---|---|
| 正常执行 `createFeishuProgressCard` | 首卡不带子代理；后续每次 `update` 加载 |
| 崩溃恢复 `createFeishuRecoveryProgress` | 首次 `progress.update` 即加载，恢复后仍能看到运行中子代理 |
| 失败重试 `createPatchedProgress` | 同上，重试期间子代理列表正常展示 |

首卡（「任务已接收，正在准备执行。」）直接调用 `buildFeishuProgressCard`，不传 `subagents`，默认空数组，无需改动。

### 4.5 刷新时机与 P0 已知滞后

| 触发点 | 是否重新加载子代理列表 |
|---|---|
| 主代理工具调用开始 | 是 |
| 工具参数流式变化 | 是（1s 缓存内复用） |
| 主代理轮次结束 | 是 |
| 卡片回调 `refresh`（如提交答案） | 是（强制） |
| 卡片回调 `renderCurrent`（点踩/取消） | 否，用缓存 |
| 子代理自身开始/完成 | **否（P0 不做事件驱动）** |
| 父任务终态 | 不展示，清空 |

因此 P0 的准确口径是：**卡片展示的是最近一次主代理事件发生时的运行中子代理快照**。

- `spawn_subagent` / `subagent_followup` 本身是主代理工具调用，卡片会立刻更新并列出新子代理；
- `wait_subagents` 等待期间，列表在进入等待那一刻是准确的；期间某个子代理完成，要等 `wait_subagents` 返回后的下一次卡片更新才会消失；
- 这满足「显示当前有哪些子代理任务正在运行」的核心诉求，避免为 P0 引入定时 PATCH 的频率与闪烁问题。P1 再补 `BackgroundSubagentManager` 活动回调 + 1s debounce 刷新。

## 5. 边界与异常

### 5.1 数据库查询失败

- `listRunning` 内部 try/catch，查询失败返回 `[]` 并打 `harnessLog('warn')`；卡片本次降级为不展示子代理段落，下一次刷新恢复。
- `loadSubagents` 再兜一层：加载器抛异常时保留上次快照；
- 任何情况下 `progress.update` 都继续执行，主卡片的状态/正文/工具不受影响。

### 5.2 标题缺失或异常

| 场景 | 行为 |
|---|---|
| `session.title` 为空 | 回退 `task_description` |
| `task_description` 为空 | 回退 `子代理 #<childSessionId>` |
| 标题仍是 `后台子代理(explorer): …` | 去掉前缀，避免与「调研」重复 |
| 标题含换行/控制字符/Markdown 符号 | 压缩空白、替换特殊字符 |
| 标题超长 | `cleanTitle` 截断为 40 字 + `...`（最多 43 字符），渲染层不再二次截断 |

### 5.3 卡片长度与频控

- 最多 5 条 + 1 条折叠提示，单段落约 300 字符；
- 子代理查询有 1s 缓存，卡片 PATCH 仍走既有 250ms 节流；
- 不新增定时器，不改变现有 PATCH 频率。

### 5.4 跨重启与多实例

- 查询以 `subagent_execution` 为准，父任务崩溃恢复后仍能列出 `RUNNING` / `RECOVERING` 子代理；
- 内存 `runningRefsByTask` 丢失时，轮次回退 DB 值（通常为 0，卡片不显示轮次），不影响「有哪些子代理」；
- 卡片 PATCH 由持有 `FeishuActiveProgressRegistry` handle 的实例执行，查询的是同一 MySQL，数据一致。

### 5.5 终态竞态

- 父任务进入终态时会执行 `cancelAllForParent`，子代理被置为 `CANCELLED`；
- 终态卡片 `send` 时清空 `lastSubagents` 且 `buildFeishuProgressCard` 只在 `RUNNING` 渲染，双重保证不出现「已完成任务仍显示子代理运行中」；
- 查询瞬间子代理刚好完成时，卡片可能短暂显示一次旧状态，下一次卡片更新自动纠正。

### 5.6 群内可见性

- 卡片在群聊中可见，只展示子代理类型与截断后的任务标题；
- 不展示完整 `task_description`、最近输出、结果、Token 或错误信息，避免把子代理内部细节扩散到群内；
- 标题来自模型生成内容，已做长度与特殊字符清洗，不构成卡片结构注入。

### 5.7 历史 `DELEGATE` 数据

- 查询过滤 `invocation_type IN ('BACKGROUND','FOLLOWUP')`；
- 即使历史 DELEGATE 记录因崩溃残留为 `RUNNING`，也不会出现在卡片上，符合「废弃功能不展示」的决策。

## 6. 测试计划

### 6.1 单元测试

| 文件 | 用例 | 断言 |
|---|---|---|
| `feishu/progress-card.spec.ts` | RUNNING + 2 条子代理 | 段落出现在正文后、本轮工具前；类型文案为「调研 / 开发」；含标题与轮次 |
| 同上 | 无子代理 / 空数组 | 不渲染「子代理」段落，卡片与现状一致 |
| 同上 | 终态 + 子代理数据 | 不渲染该段落 |
| 同上 | 6 条子代理 | 只渲染 5 条，出现「另有 1 个运行中」 |
| 同上 | 标题含换行、`*`、超长 | 空白压缩、特殊字符被替换、最长 40 字 |
| 同上 | 未知 agentType / 空类型 | 分别展示原值 / 「子代理」 |
| 同上 | `RECOVERING` 状态 | 行尾出现「恢复中」 |
| `feishu/patched-progress.spec.ts` | 正常 update | `buildCard` 收到 `loadSubagents` 返回的列表 |
| 同上 | `loadSubagents` 抛错 | 卡片仍 PATCH 成功；首次为空、后续保留上次快照 |
| 同上 | 1s 内连续 update | 只调用一次 `loadSubagents` |
| 同上 | `renderCurrent` | 使用缓存，不再次调用 `loadSubagents` |
| 同上 | 终态 update | 不展示子代理，`renderCurrent` 也不携带 |
| `harness/delegate/background-subagent-manager.spec.ts` | 只返回运行中 | 终态行被过滤；`BACKGROUND` / `FOLLOWUP` 保留 |
| 同上 | 内存轮次覆盖 | `runningRefsByTask` 的 `currentRound` 优先于 DB `total_rounds` |
| 同上 | 标题回退 | 自动前缀被去掉；空标题回退 `task_description`；再回退 `子代理 #id` |
| 同上 | 查询抛错 | 返回 `[]`，不抛出 |

说明：`progress-card.spec.ts` 现有调用均为位置参数，新增第 10 个参数可选，不需要批量改旧用例；新用例显式传入。

### 6.2 手工验收

前置：部署后端后，在飞书群聊发起一个包含两个后台子代理的任务，例如：

> 用 spawn_subagent 派一个 explorer 调研飞书卡片进度链路，再派一个 worker 修改一个测试文件，然后用 wait_subagents 等它们完成。

验收步骤：

1. 主代理调用 `spawn_subagent` 后，卡片正文下方出现 `**子代理 · 1 个运行中**`，行为 `- 调研 · <任务标题> · 第 N 轮`；
2. 第二个子代理启动后，标题变为 `2 个运行中`，两行分别展示「调研」「开发」；
3. `wait_subagents` 执行期间，列表仍在，且位于「本轮工具」上方；
4. `wait_subagents` 返回后，卡片下一次更新时列表消失；
5. 任务完成后，完成卡不出现子代理段落，仍在的「点踩 / 会话详情」按钮正常；
6. 无子代理的普通任务，卡片与改动前逐字一致；
7. 崩溃恢复：重启后端后恢复中的父任务，卡片仍能展示 `RECOVERING` 子代理（带「恢复中」）；
8. 钉钉会话完成任务，卡片布局与改动前一致。

### 6.3 回归范围

- 飞书提问表单（`ask_user_questions`）：等待态卡片结构不变；
- 取消任务、点踩、失败重试、会话详情按钮：`renderCurrent` 不因新增字段报错；
- 崩溃恢复进度卡：轮次、耗时、终态 PATCH 不受影响；
- 钉钉进度卡：未改 `FeishuCardProgressListener` 接口，行为不变。

## 7. 上线与回滚

### 7.1 上线

按 Mao 独立发布流程：

1. 工作区完成代码与测试，提交并 push 到 `origin/main`；
2. 在 `/data` 执行 `bash deploy-mao.sh`（含后端构建与蓝绿重启）；
3. 仅前端改动无需重启，但本方案含后端改动，必须完整部署。

### 7.2 回滚

- 无数据库迁移、无数据写入，回滚只需 revert 对应 commit 并重新部署；
- 卡片上的子代理段落属于纯展示，回滚不影响子代理执行与历史数据。

### 7.3 观察点

- `harnessLog('warn')` 中 `Failed to list running subagents` 的频率；
- 飞书卡片 PATCH 失败日志是否因内容变长而增加；
- 群聊实际卡片效果与折叠文案。

## 8. 工作量拆分

| 步骤 | 文件 | 预估 |
|---|---|---|
| 1. 类型 + mapper 查询 | `session/types.ts`、`subagent-execution.mapper.ts` | 30 分钟 |
| 2. `listRunning` 与标题清洗 | `background-subagent-manager.ts` | 45 分钟 |
| 3. 卡片段落渲染 | `feishu/progress-card.ts` | 60 分钟 |
| 4. 进度闭包加载与缓存 | `feishu/patched-progress.ts` | 45 分钟 |
| 5. 装配 | `create-app.ts` | 15 分钟 |
| 6. 单元测试（3 个 spec） | 对应测试文件 | 90 分钟 |
| 7. 手工验收 + CHANGELOG | — | 30 分钟 |
| **合计** | | **约 5 小时（0.5-1 人日）** |

## 9. 风险与决策记录

### 9.1 决策

| 编号 | 决策 | 理由 |
|---|---|---|
| D1 | 不展示 `DELEGATE`，查询只取 `BACKGROUND` / `FOLLOWUP` | `delegate` 已从工具注册表移除，属历史遗留 |
| D2 | 类型文案用「调研 / 开发 / 审查」，`default` 用「通用」 | 与需求澄清一致；未知类型保留原值，避免吞信息 |
| D3 | 最多展示 5 条，其余折叠 | 控制卡片长度，避免子代理多时刷屏 |
| D4 | P0 不做事件驱动实时刷新 | 避免新增定时 PATCH/闪烁；wait 期间列表在进入等待时准确 |
| D5 | 子代理查询失败降级为空/上次快照 | 卡片主流程不能被附属信息拖垮 |
| D6 | 不展示耗时、Token、最近输出 | 信息密度与群内可见性权衡；P0 只回答「有哪些」 |

### 9.2 风险

| 风险 | 影响 | 缓解 |
|---|---|---|
| 卡片在 `wait_subagents` 期间不实时 | 子代理完成后短暂仍显示运行中 | 已在需求范围接受；P1 用活动回调 + debounce 解决 |
| 子代理标题含敏感任务信息 | 群内可见 | 只展示截断标题（40 字），不展示任务详情/输出 |
| 标题特殊字符破坏卡片 | 渲染异常 | 清洗控制字符与 Markdown 符号，截断长度 |
| DB 查询频率过高 | 数据库压力 | 250ms PATCH 节流 + 1s 查询缓存 + 索引查询 |
| 跨重启后轮次丢失 | 行内不显示「第 N 轮」 | 属可接受降级；「运行中」信息仍准确 |
| 历史 DELEGATE 残留 | 卡片出现废弃能力 | 查询层过滤 invocation_type |

## 10. 附录

### 10.1 关键代码位置

| 内容 | 位置 |
|---|---|
| 卡片构建 | `backend-ts/src/feishu/progress-card.ts:69` |
| 进度闭包 | `backend-ts/src/feishu/patched-progress.ts:28` |
| 子代理管理器 | `backend-ts/src/harness/delegate/background-subagent-manager.ts:104` |
| 运行跟踪 | 同文件 `trackRunning` :617 / `untrackRunning` :623 |
| 子代理执行 mapper | `backend-ts/src/harness/delegate/subagent-execution.mapper.ts` |
| 进度卡装配 | `backend-ts/src/create-app.ts:1960` / `createFeishuProgressCard` :1994 |
| 工具注册表 | `backend-ts/src/harness/tool/tool-registry.ts:110`（子代理工具 153-157） |
| 子代理表结构 | `backend-ts/db/migration/V040__subagent_delegation.sql` |

### 10.2 现有卡片结构（顺序）

1. 状态行；
2. 等待提问提示（仅 waiting）；
3. 正文；
4. **子代理段落（本次新增，仅 RUNNING）**；
5. 本轮工具；
6. 分隔线 + 提问表单（仅 waiting）；
7. 按钮行（点踩 / 取消任务 / 重试 / 会话详情）。

### 10.3 术语

- **后台子代理**：通过 `spawn_subagent` / `subagent_followup` 创建，`invocation_type` 为 `BACKGROUND` / `FOLLOWUP`，独立会话异步执行。
- **前台委派**：`delegate` / `delegate_followup`，已废弃，不再注册。
- **恢复中**：`status = RECOVERING`，崩溃后由恢复协调器接管、尚未结束的子代理执行。
