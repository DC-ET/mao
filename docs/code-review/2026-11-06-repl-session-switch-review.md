# 代码审查报告：REPL 会话切换（`/resume`）

- 审查对象：`feat/repl-session-switch` 工作区**未提交**改动（`mao/.worktrees/repl-session-switch`），基线 `e0b85380`
- 审查范围：`agent-cli/src/session/session-filter.ts`（新增）、`session-runner.ts`、`commands/chat.ts`、`repl/repl.ts`、`ui/slash-complete.ts`、`tui/modal-controller.ts`、`tui/types.ts`、`tui/ink-renderer.ts`，以及新增测试；`CHANGELOG.md` / `skills/mao-cli/reference/mao-agent.md` 按要求不审
- 审查方式：逐条对照技术方案（`docs/plan/2026-11-06-agent-cli-repl-session-switch-technical-design.md`）走读代码路径 → 对每个可疑点写可执行用例复现 → 只保留能稳定复现的缺陷
- 验证环境：`agent-cli` 已装依赖；本文用例为 vitest 规格，实际执行方式是在 `/tmp/review-bugs`（第一轮）与 `/tmp/review-bugs2`（第二、三轮）下用 `agent-cli/node_modules/.bin/vitest` 运行（用例以绝对路径 import 工作区源码），**未修改仓库内任何源码或测试文件**；工作区现有 664 个用例全部通过，故以下问题均属现有测试未覆盖的路径
- 结论（第一轮）：**有 4 个 bug**（2 个中危、2 个低危）→ 已全部修复，复核见「第二轮复查」
- 结论（第二轮）：**有 1 个 bug**（Bug 5，低危）→ 已修复，复核见「第三轮复查」
- 结论（第三轮，当前）：**无 bug**

## 结论摘要

| # | 级别 | 位置 | 问题 |
|---|---|---|---|
| 1 | 中 | `commands/chat.ts` `switchSession`（第 8 步）+ `tui/ink-renderer.ts` `setMeta` / `footerMeta` | 切换成功后状态栏仍展示**旧会话**的 Todo 进度与上下文占用；与 `/todo`、`/context` 的输出自相矛盾 |
| 2 | 中 | `tui/modal-controller.ts` `SessionPickController.state` + `tui/ink-renderer.ts` `buildSessionPickPanel` | 终端行数 ≤16 时（tmux 分屏常见），`/resume` 面板实际可画行数小于控制器窗口行数，游标移到列表尾部后**高亮行完全消失**，Enter 会切到一个屏幕上不可见的会话 |
| 3 | 低 | `session/session-runner.ts` `switchTo`（回挂路径） | 新会话 attach 失败、回挂成功后，原会话的 `todos` / `lastContext` 已被清空且不会恢复，`/todo`、`/context` 变空，与「失败保持当前会话不变」不符 |
| 4 | 低 | `session/session-runner.ts` `switchTo`（回挂也失败） | 回挂也失败时进程停在「已指向原会话但客户端未订阅它」的半挂载状态（代码注释明确要避免），且没有方案 E9 要求的「请退出后重开 mao-agent」提示 |

> 说明：上表是**第一轮**（2026-11-06 初）的审查结论。4 项修复已提交，第二轮复查结果见下一节；本轮仍剩 1 个问题（Bug 5）。

---

## 第二轮复查（2026-11-06，验证 4 项修复 + 找剩余问题）

### 修复验证

| 原问题 | 修复实现（当前 worktree） | 复核方式 | 结果 |
|---|---|---|---|
| Bug 1 状态栏残留 | 新增 `InkTuiRenderer.resetSessionMetrics()`（清 `todos` / `contextPct` / `lastRoundText`，`ink-renderer.ts:666-671`）；`chat.ts:348` 在 `setMeta` 之后调用 | 真实 TUI（24 行）复刻「会话 A 产生 todo / context / 回复 → `setMeta` + `resetSessionMetrics`」：footer 的 Todo 与上下文占用为空、`getLastAssistantText()` 为空、frame 不再含 `Todo 1/2` 且已显示新模型名 | ✅ 已修复 |
| Bug 2 矮终端高亮丢失 | 新增纯函数 `pickSessionWindow(total, cursor, maxVisible)`（`modal-controller.ts:297-307`，保证 cursor ∈ [offset, offset+size)）；`buildSessionPickPanel` 按实际预算算可见窗口（`ink-renderer.ts:900`）；controller 不再自算 offset | (a) 真实 TUI：16 行、10 行终端 + 12 条会话，游标移到最后一项 → 有且只有一行高亮且是末项（`#111`），Enter 返回 111，面板行数不超预算；(b) 遍历 8/9/10/12/14/16/17/20/24/30 行 × 1/3/8/12/20 条 × 每个游标位置（共 440 次渲染），断言「恰好一行高亮 + 面板行数 ≤ 预算」全部成立 | ✅ 已修复 |
| Bug 3 回挂丢数据 | `todos` / `lastContext` 的清空移到 `attach` 成功之后（`session-runner.ts:305-307`） | FakeWs：先落 todo / context → 目标 `subscribe` 抛错 → 断言回挂后 `getTodos()` / `getContext()` 保持原值 | ✅ 已修复 |
| Bug 4 回挂失败半挂载 | 回挂也失败时清 `session` / `sessionId` / `snapshotPhase` 并抛含「会话已解除挂载，请退出后重开 mao-agent」（`session-runner.ts:293-301`）；`chat.ts:331` 在 `getSession()` 为空时复位 `attached` | FakeWs：两次 `connect` 失败 → `getSession()` 为 null、`snapshotIsActive` 为 false、抛错文案含重开提示；另验证「解除挂载后再次 `/resume` 到别的会话」能正常挂载 | ✅ 已修复（该分支） |

回归：`agent-cli` 下 `npx vitest run` → 59 文件 / 663 用例全绿；`tsc --noEmit` 通过。上述复核断言均不在现有用例内（在 `/tmp/review-bugs2` 独立执行）。

### 本轮小结

4 项修复本身没有引入可见回归（正常切换仍会清空 todo / context；解除挂载后可用 `/resume` 恢复；面板在各尺寸下高亮可见且在预算内）。但 `switchTo` 的失败分支只覆盖了「有前序会话」的情况，**草稿态（无前序会话）挂载失败仍会留下半挂载**，见 Bug 5。

---

## 第三轮复查（2026-11-06，验证 Bug 5 修复）

### 修复验证

当前 `switchTo` 的 catch 分支（`session-runner.ts:282-307`）已改为：

- 有前序会话 → best-effort 回挂；回挂成功 → 抛原错误（保留原会话 todo / context）；
- **没有可回挂的原会话（草稿态）或回挂失败** → 统一 `session = null / sessionId = 0 / snapshotPhase = null` 解除挂载（`session-runner.ts:293-299`）；
- 只有「有前序会话且回挂失败」才附「会话已解除挂载，请退出后重开 mao-agent」（`300-304`），草稿态只抛原错误（用户可直接重试）。

| 复核点 | 方式（`/tmp/review-bugs2`，全部通过） | 结果 |
|---|---|---|
| 草稿态挂载失败不再半挂载 | FakeWs 让 `connect()` 抛错 → 断言 `getSession()` 为 null、`getSentCancelPayload().sessionId === 0` | ✅ |
| 草稿态失败后可直接重试 | 清除故障后再 `switchTo({id:22})` → 挂载成功、`subscribed` 含 22 | ✅ |
| 草稿态失败后的连带影响消失 | 失败后改切 33：`markRead` 从未被调用（不再误标 22 已读）、`subscribed` 只有 33 | ✅ |
| 有前序会话 + 回挂失败（回归） | 两次 `connect` 失败 → 解除挂载 + 错误文案含重开提示 | ✅ |
| 解除挂载后 `shutdown()`（回归） | 正常 resolve、不误调 `markRead(0)`、关闭 WS | ✅ |
| 成功路径未受影响 | 切到运行中会话（RUNNING 快照）→ `snapshotIsActive` → `waitForCurrentRun` 收到终态返回 COMPLETED | ✅ |
| 前两轮 8 条修复断言（回归） | footer 复位 / 面板高亮与 440 次渲染遍历 / 回挂保留数据 / 解除挂载提示 | ✅ |

另：仓库自带用例 `npm test` → 59 文件 / **664** 用例全绿；`npm run build`、`tsc --noEmit` 通过；`git status` 显示本轮改动仅 `session-runner.ts`（+4 行）与 `test/session-switch.spec.ts`（新增 1 条用例），失败分支的三种出口（回挂成功 / 回挂失败 / 草稿态）均有覆盖。

### 本轮结论

**无 bug**。第一轮 4 个 + 第二轮 1 个问题均已修复并经用例复核；草稿态、有前序会话、回挂失败、解除挂载后 `shutdown()`、运行中会话续接等分支逐条验证通过，未发现新引入的功能问题。

---

## Bug 1（中，第一轮）：切换会话后状态栏残留旧会话的 Todo / 上下文占用　✅ 已修复（见「第二轮复查」）

### 结论

`/resume` 切换成功后，`chat.ts` 只调用 `inkRenderer.setMeta(...)` 刷新状态栏；`setMeta` 只写 Agent / 模型 / 模式 / 上下文窗口四个字段，**不碰渲染器自己缓存的 `todos` 与 `contextPct`**。于是新会话还没跑过任何一轮、Todo 与上下文占用都未知的情况下，状态栏依然显示旧会话的 `Todo 1/2`、`39%`。

### 为什么真实存在（代码路径 + 触发条件）

1. 切换成功后唯一的渲染器状态刷新点，`agent-cli/src/commands/chat.ts:327-341`：

```ts
await runner.switchTo(next);
attached = true;
createdSession = undefined;

// 8. 会话级外部状态同步
rememberLastSession(id);
modelId = next.modelId ?? modelId;
contextWindowTokens = resolveContextWindowTokens(next, modelsCache, modelId);
inkRenderer?.setMeta({              // ← 状态栏刷新只有这一个动作
  agentName: next.agentName,
  modelName: next.modelName,
  executionMode: nextLocal ? 'LOCAL' : 'CLOUD',
  contextWindowTokens,
});
```

2. `setMeta` 只覆盖四个字段（`agent-cli/src/tui/ink-renderer.ts:654-661`），没有清 `todos` / `contextPct`：

```ts
setMeta(meta: { agentName?: string; modelName?: string; executionMode?: string; contextWindowTokens?: number }): void {
  if (meta.agentName) this.agentName = meta.agentName;
  if (meta.modelName) this.modelName = meta.modelName;
  if (meta.executionMode) this.executionMode = meta.executionMode;
  if (meta.contextWindowTokens && meta.contextWindowTokens > 0) this.contextWindowTokens = meta.contextWindowTokens;
  this.render(true);
}
```

3. 状态栏渲染读的正是这两份缓存（`ink-renderer.ts:782-789` 的 `footerMeta()`，`widgets.tsx:99-110` 的 `FooterBar`，其中第 108-109 行渲染 `contextPct` / `todo`）：

```ts
private footerMeta(): FooterMeta {
  return {
    agentName: this.agentName,
    modelName: this.modelName,
    executionMode: this.executionMode,
    contextPct: this.contextPct,          // ← 只在收到 context_window 事件时写
    todo: formatTodoSummary(this.todos),  // ← 只在收到 todo_updated 事件时写
  };
}
```

4. 而这两份缓存只由 WS 事件写入（`ink-renderer.ts:381-383` 的 `todo_updated`、`414-416` 的 `context_window`）。新会话在 `subscribe` 时服务端只回 `session_snapshot`（`backend-ts/src/session/ws/streaming-ws-handler.ts:605-610`，data 只有 `phase` / `thinking` / `executionId`），不含 todo 与 context；`todo_updated: []` 要等新会话下一次 `send_message`（`clearTodos=true`）才下发，`context_window` 要等新会话真正跑一轮才下发。因此切换完成到新会话跑完第一轮之间，状态栏一直是旧会话的数据。

5. 与此同时 `SessionRunner.switchTo` 已经把 runner 侧的副本清空（`session-runner.ts:268-270`）：

```ts
this.snapshotPhase = null;
this.todos = [];
this.lastContext = {};
```

`/todo` 读 `runner.getTodos()`、`/context` 读 `runner.getContext()`（`repl.ts` 的 `case 'todo'` / `case 'context'`），于是同一次切换后出现**状态栏显示 `Todo 1/2`、`/todo` 却输出「(暂无 Todo)」**的矛盾，`/context` 同理。

触发条件：会话 A 跑过至少一轮并收到过 `todo_updated` / `context_window`（正常使用必然发生），随后 `/resume` 切到会话 B，且 B 尚未跑过本轮。

附带同类问题（同一根因，不单列）：`lastRoundText` 只在 `finish()` 里写（`ink-renderer.ts:492`），切换后 `/copy` 复制到的仍是**旧会话**的上一回合回复。

### 验证用例

文件：`agent-cli/test/review-resume-footer-state.spec.ts`

```ts
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle } from '../src/tui/types';

interface FakeOut extends NodeJS.WriteStream { chunks: string[] }

function fakeStdout(rows = 24, columns = 80): FakeOut {
  const s = new PassThrough() as unknown as FakeOut;
  s.chunks = [];
  s.on('data', (c: Buffer) => s.chunks.push(c.toString('utf8')));
  Object.assign(s, { rows, columns, isTTY: true });
  return s;
}

function fakeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(s, { isTTY: true, setRawMode: () => s });
  return s;
}

const mounted: TuiHandle[] = [];
function mount() {
  const out = fakeStdout(24, 80);
  const stdin = fakeStdin();
  const renderer = new InkTuiRenderer({
    stdout: out, stdin,
    welcomeLines: ['mao-agent 测试'],
    agentName: '会话A的Agent', modelName: 'model-a', executionMode: 'CLOUD', contextWindowTokens: 256000,
  });
  mounted.push(renderer.mount());
  return {
    renderer,
    plain: () => out.chunks.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''),
  };
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { while (mounted.length > 0) mounted.pop()?.unmount(); });

describe('切换会话后状态栏的会话级数据（/resume）', () => {
  it('切换后不应继续展示旧会话的 Todo / 上下文占用', async () => {
    const t = mount();
    t.renderer.seedChrome();

    // 会话 A 跑过一轮：状态栏缓存了 todo 与上下文占用
    t.renderer.startRound();
    t.renderer.onEvent({
      type: 'todo_updated',
      todos: [{ status: 'completed', content: '旧会话任务1' }, { status: 'pending', content: '旧会话任务2' }],
    });
    t.renderer.onEvent({ type: 'context_window', estimated: 100000, actual: 0 });
    await tick();

    const before = (t.renderer as unknown as { footerMeta(): { todo?: string; contextPct?: string } }).footerMeta();
    expect(before.todo).toBe('Todo 1/2');
    expect(before.contextPct).toBe('39%');

    // 复刻 chat.ts switchSession 第 8 步：切换后状态栏刷新只有 setMeta 一个动作
    t.renderer.setMeta({ agentName: '会话B的Agent', modelName: 'model-b', executionMode: 'CLOUD', contextWindowTokens: 256000 });
    await tick();

    const after = (t.renderer as unknown as { footerMeta(): { todo?: string; contextPct?: string } }).footerMeta();
    // 新会话还没跑过任何一轮：Todo / 上下文占用都是未知，不应继续展示旧会话的数据
    expect(after.contextPct).toBeUndefined();
    expect(after.todo).toBeUndefined();
    // 屏幕上（最后一帧之外的静态输出同样）不应再出现旧会话的 Todo 计数
    expect(t.plain()).not.toContain('Todo 1/2');
  });
});
```

### 实测结果（失败）

```
× 切换会话后状态栏的会话级数据（/resume） > 切换后不应继续展示旧会话的 Todo / 上下文占用
  → expected '39%' to be undefined
  + Received: "39%"
```

把该断言换成 `expect(after.todo).toBeUndefined()` 后同样失败：`expected 'Todo 1/2' to be undefined`（即两项都残留）。

---

## Bug 2（中，第一轮）：`/resume` 面板在 ≤16 行终端上会丢失高亮行（游标与可见窗口不同步）　✅ 已修复

### 结论

`SessionPickController` 用固定的 8 行窗口计算 `offset`，而 `buildSessionPickPanel` 实际能画的行数由终端高度决定、可能小于 8。两者不一致时，游标越过后半段窗口后，**面板上没有任何一行带高亮**，但 Enter 仍然会切换 `items[cursor]`——用户会在看不见选中项的情况下切到某个会话。

### 为什么真实存在（代码路径 + 触发条件）

1. 控制器的窗口与偏移按 `windowRows = min(8, items.length)` 计算（`agent-cli/src/tui/modal-controller.ts:310-324`）：

```ts
get state(): SessionPickViewState {
  const windowRows = Math.max(1, Math.min(this.maxRows, Math.max(1, this.items.length))); // maxRows 默认 8
  const offset = Math.min(
    Math.max(0, this.cursor - Math.floor(windowRows / 2)),
    Math.max(0, this.items.length - windowRows),
  );
  return { kind: 'session-pick', items: this.items, cursor: this.cursor, offset, total: this.items.length, windowRows };
}
```

2. 面板实际可画行数由布局预算决定（`ink-renderer.ts:703` `panelBudgetRows = Math.max(4, b.rows - 6)`，`ink-renderer.ts:879-911`）：

```ts
private buildSessionPickPanel(controller: SessionPickController, cols: number, maxRows: number): PanelView {
  ...
  const overhead = 2;                                   // 标题 + 底部按键提示
  let room = Math.max(1, maxRows - overhead);
  const showOverflow = s.total > room;
  if (showOverflow) room = Math.max(1, room - 1);       // 溢出提示行
  const rows = Math.min(room, s.windowRows);            // ← 屏幕实际行数可能 < s.windowRows(8)
  for (let i = 0; i < rows; i++) {
    const idx = s.offset + i;                           // ← 起点却来自按 8 行算出的 offset
    const item = s.items[idx];
    if (!item) break;
    ...
    lines.push({ ..., active: idx === s.cursor });      // ← 游标不在 [offset, offset+rows) 内就没人被高亮
  }
```

3. 代入常见终端高度：`b.rows = 终端行数 R` → `maxRows = max(4, R-6)` → `rows = min(max(1, maxRows-2) [-1 若溢出], 8)`。当 `R ≤ 16` 时 `rows ≤ 7 < 8`，而 `offset` 仍按 8 行居中/贴底计算：

- R=16（`maxRows=10`，`rows=7`），12 条会话：游标在最后一项（cursor=11）时 `offset=4`，面板只画 `4..10`，游标 11 落在窗口外 → 全表无 `active` 行。
- R=14（`rows=5`），20 条会话：游标在 `17..19` 时，面板只画 `12..16`，同样全表无高亮。

触发条件：终端高度 ≤16 行（tmux 横向分屏在 1080p 上约 24 行、三分屏约 16 行；768p 笔记本约 12 行），且会话数超过可画行数、用户按 `↓`/`j` 把游标移到列表尾部。24 行及以上的常见终端不受影响（上文 24 行对照用例已固定住该边界）。

### 验证用例

文件：`agent-cli/test/review-resume-pick-window.spec.ts`

```ts
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { InkTuiRenderer } from '../src/tui/ink-renderer';
import type { TuiHandle, PanelView } from '../src/tui/types';

interface FakeOut extends NodeJS.WriteStream { chunks: string[] }
function fakeStdout(rows = 24, columns = 80): FakeOut {
  const s = new PassThrough() as unknown as FakeOut;
  s.chunks = [];
  s.on('data', (c: Buffer) => s.chunks.push(c.toString('utf8')));
  Object.assign(s, { rows, columns, isTTY: true });
  return s;
}
function fakeStdin(): NodeJS.ReadStream {
  const s = new PassThrough() as unknown as NodeJS.ReadStream;
  Object.assign(s, { isTTY: true, setRawMode: () => s });
  return s;
}

const mounted: TuiHandle[] = [];
function mount(rows: number) {
  const out = fakeStdout(rows, 80);
  const stdin = fakeStdin();
  const renderer = new InkTuiRenderer({ stdout: out, stdin, welcomeLines: ['mao-agent 测试'], agentName: 'A', modelName: 'M' });
  mounted.push(renderer.mount());
  return { renderer, stdin };
}
const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));
afterEach(() => { while (mounted.length > 0) mounted.pop()?.unmount(); });

const items = () => Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i, title: `会话 ${100 + i}`, agentName: 'A', updatedAt: '2026-11-06T10:00:00',
}));

/** 走真实 TUI 路径：打开面板 → 用方向键把游标移到最后一项 → 读当前帧的面板。 */
async function panelAfterMovingToLast(rows: number) {
  const t = mount(rows);
  t.renderer.seedChrome();
  const pending = t.renderer.pickSession(items());
  await tick();
  for (let i = 0; i < items().length - 1; i++) t.stdin.emit('data', '\x1b[B'); // ↓
  await tick();
  const props = (t.renderer as unknown as { buildProps(): { panel: PanelView | null } }).buildProps();
  const panel = props.panel!;
  const active = panel.lines.filter((l) => l.active);
  t.stdin.emit('data', '\x1b'); // Esc 收尾
  await pending;
  return { panel, active };
}

describe('/resume 会话选择面板的选中行可见性', () => {
  it('24 行终端（对照）：末项有且只有一行高亮', async () => {
    const { active } = await panelAfterMovingToLast(24);
    expect(active).toHaveLength(1);
  });

  it('16 行终端：游标移到最后一项后没有任何一行被高亮', async () => {
    const { panel, active } = await panelAfterMovingToLast(16);
    // 面板只能画 7 行行项（8 行窗口 → 7 行实际），游标 11 已经滚出可视窗口
    const visibleRows = panel.lines.filter((l) => /#1\d\d/.test(l.text)).length;
    expect(visibleRows).toBe(7);
    // 期望：被选中的那一行始终在窗口里（有且只有一个 active 行）
    expect(active).toHaveLength(1);
  });
});
```

### 实测结果（失败）

```
✓ 24 行终端（对照）：末项有且只有一行高亮
× 16 行终端：游标移到最后一项后没有任何一行被高亮
  → expected [] to have a length of 1 but got +0
```

（`active` 为空数组即面板上没有任何 `inverse` 高亮行；此时按 Enter 仍返回 108，即切换到屏幕上不可见的项。）

---

## Bug 3（低，第一轮）：切换失败并回挂原会话后，原会话的 `/todo`、`/context` 展示态被清空　✅ 已修复

### 结论

`switchTo` 在尝试挂载新会话**之前**就把 `snapshotPhase` / `todos` / `lastContext` 清空，回挂原会话时只重新 `attach`（`attach` 不会恢复这三份数据），于是「切换失败、会话没变」的情况下，`/todo`、`/context` 也变成空——与 `chat.ts` 注释「任一步失败都保持当前会话不变（runner.switchTo 内部负责回挂）」不一致。

### 为什么真实存在（代码路径 + 触发条件）

`agent-cli/src/session/session-runner.ts:258-293`：

```ts
const prev = this.session;
const prevId = this.sessionId;

this.disarmMaxDuration();
this.snapshotPhase = null;   // 268：先清
this.todos = [];             // 269
this.lastContext = {};       // 270
...
try {
  await this.attach(session);            // 283：新会话挂载失败（断网 / 服务端异常 / subscribe 抛错）
} catch (err) {
  if (prev?.id != null) {
    try { await this.attach(prev); }     // 286：回挂只重订阅 + 等快照
    catch { /* ... */ }
  }
  throw err;
}
```

`attach()`（`session-runner.ts:109-120`）只做 `resetRound()` + 重订阅 + `waitForSnapshot`，并不会回填 `todos` / `lastContext`；而服务端 `session_snapshot` 只带 `phase` / `thinking` / `executionId`（`backend-ts/.../streaming-ws-handler.ts:605-610`），没有任何事件会把这两份数据补回来（`todo_updated` 要等下一条消息、`context_window` 要等下一轮）。所以回挂成功后，`/todo` → `runner.getTodos()` 为空、`/context` → `runner.getContext()` 为空。

触发条件：会话 A 已收到过 `todo_updated` / `context_window`（正常跑过一轮），此时 `/resume` 切到 B，B 的 `attach` 失败（`ws.connect()` 抛错或 `subscribe` 抛错），`switchTo` 回挂 A 成功并抛错；用户继续在 A 里使用，`/todo`、`/context` 显示为空。

### 验证用例

文件：`agent-cli/test/review-resume-rollback-state.spec.ts`（与 Bug 4 共用 FakeWs）

```ts
import { describe, expect, it, vi } from 'vitest';
import { SessionRunner } from '../src/session/session-runner';
import type { WsClient } from '../src/ws/ws-client';
import type { RestClient } from '../src/rest/rest-client';
import type { Renderer } from '../src/render/types';
import type { WsEvent } from '../src/ws/event-types';

/** 对齐真实 WsClient 的关键语义：unsubscribe 会把 id 从 subscribed 集合里移除（重连时据此重发订阅）。 */
class FakeWs {
  handlers: Array<(e: WsEvent) => void> = [];
  subscribed: number[] = [];
  unsubscribed: number[] = [];
  /** 接下来 N 次 connect 直接失败（模拟切换期间断网） */
  failConnectTimes = 0;
  /** 这些 id 的 subscribe 抛错（模拟服务端异常） */
  failSubscribeFor = new Set<number>();
  snapshots = new Map<number, Record<string, unknown>>();

  async connect(): Promise<void> {
    if (this.failConnectTimes > 0) {
      this.failConnectTimes -= 1;
      throw new Error('net down');
    }
  }
  subscribe(id: number): void {
    if (this.failSubscribeFor.has(id)) throw new Error('boom');
    this.subscribed.push(id);
    this.emit({ type: 'session_snapshot', sessionId: id, data: this.snapshots.get(id) ?? { phase: 'IDLE' } });
  }
  unsubscribe(id: number): void {
    this.unsubscribed.push(id);
    this.subscribed = this.subscribed.filter((n) => n !== id);
  }
  send(): void {}
  async sendReliable(): Promise<boolean> { return true; }
  close(): void {}
  on(handler: (e: WsEvent) => void): () => void {
    this.handlers.push(handler);
    return () => undefined;
  }
  emit(evt: WsEvent): void { for (const h of this.handlers) h(evt); }
}

function makeRunner(ws: FakeWs) {
  const rest = {
    markRead: vi.fn(async () => undefined),
    getSession: async (n: number) => ({ id: n, phase: 'RUNNING' }),
  } as unknown as RestClient;
  const renderer: Renderer = { onEvent: () => undefined };
  const runner = new SessionRunner({
    rest, ws: ws as unknown as WsClient, renderer,
    printMode: false, ifRunning: 'wait', onQuestion: 'fail',
  });
  return { runner };
}

describe('switchTo 失败回挂后的会话级展示态', () => {
  it('回挂成功后，原会话的 todo / context 不应被清空', async () => {
    const ws = new FakeWs();
    const { runner } = makeRunner(ws);
    await runner.attach({ id: 11, phase: 'IDLE' });

    ws.emit({ type: 'todo_updated', sessionId: 11, data: { todos: [{ status: 'pending', content: 'x' }] } });
    ws.emit({ type: 'context_window', sessionId: 11, data: { estimated: 10, actual: 20 } });
    expect(runner.getTodos()).toHaveLength(1);

    ws.failSubscribeFor.add(22);
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow('boom');

    expect(runner.getSession()?.id).toBe(11);                                   // 回挂成功
    expect(runner.getTodos()).toEqual([{ status: 'pending', content: 'x' }]);   // 期望：保持原样
    expect(runner.getContext()).toEqual({ estimated: 10, actual: 20 });
  });
});
```

### 实测结果（失败）

```
× switchTo 失败回挂后的会话级展示态 > 回挂成功后，原会话的 todo / context 不应被清空
  → expected [] to deeply equal [ { status: 'pending', content: 'x' } ]
```

把该用例第 2 条断言换成 `expect(runner.getContext()).toEqual({ estimated: 10, actual: 20 })` 时同样失败：`expected {} to deeply equal { estimated: 10, actual: 20 }`（`todos` 与 `lastContext` 两份数据都被清空且未恢复）。

---

## Bug 4（低，第一轮）：回挂也失败时停在「已指向原会话但未订阅」的半挂载状态，且没有重开提示　✅ 已修复（该分支）

### 结论

新会话 `attach` 失败、回挂原会话也失败时（例如切换过程中网络断开，两次 `ws.connect()` 都失败），`attach()` 在 `ws.connect()` **之前**就已经把 `this.session` / `this.sessionId` 指向目标会话，于是最终状态是：`runner.getSession()` 回到原会话，但 `WsClient.subscribed` 里既没有新会话也没有原会话。代码注释写的是「保持未挂载状态，**由调用方提示重开进程**」，但 `chat.ts` / `repl.ts` 只把原始错误打印出来，没有任何重开提示；随后重连也只会重发 `subscribed`（空集），该会话的 `session_snapshot` 校准（服务端唯一在 `subscribe` 时回补快照的路径）就永久缺失。

### 为什么真实存在（代码路径 + 触发条件）

1. `attach()` 先改指向、再连 WS（`agent-cli/src/session/session-runner.ts:109-120`）：

```ts
async attach(session: SessionVO): Promise<void> {
  if (session.id == null) throw new CliError('会话缺少 id');
  this.session = session;          // ← 先改指向
  this.sessionId = session.id;
  this.resetRound();
  this.unsub?.();
  this.unsub = this.opts.ws.on((evt) => this.handleWs(evt));
  await this.opts.ws.connect();    // ← 这里抛错时，subscription 还没建立
  this.opts.ws.subscribe(this.sessionId);
  await this.waitForSnapshot(2000);
}
```

2. `switchTo` 的失败分支（`session-runner.ts:272-291`）在尝试前已 `unsubscribe(prevId)`（273 行），因此原会话在 `subscribed` 集合里已被移除；回挂时 `attach(prev)` 又因 `connect()` 再次失败而停在 `subscribe` 之前：

```ts
if (prevId && prevId !== session.id) {
  this.opts.ws.unsubscribe(prevId);        // 273：原会话从 subscribed 移除
  ...
}
try { await this.attach(session); }
catch (err) {
  if (prev?.id != null) {
    try { await this.attach(prev); }       // 286：connect 再失败 → subscribe 未执行
    catch {
      // 回滚也失败：保持未挂载状态，由调用方提示重开进程   ← 288：注释承诺的提示无人实现
    }
  }
  throw err;
}
```

3. 真实 `WsClient` 的语义（`agent-cli/src/ws/ws-client.ts:138-141`、`222-224`）：`unsubscribe` 会 `subscribed.delete(id)`；连接打开时只对 `subscribed` 里的 id 重发 `subscribe`。所以网络恢复后也不会再订阅原会话 → 客户端永远收不到该会话的 `session_snapshot`（服务端只在收到 `subscribe` 帧时回补快照，见 `streaming-ws-handler.ts:600-620`），断线期间错过的终态无法校准。

触发条件：`/resume` 切换瞬间 WS 不可用（如休眠唤醒、token 刷新失败导致 `getToken()` 返回 null → `openOnce()` 抛 `No token`、或握手直接失败），且回挂期间仍然不可用。`chat.ts` 的 `switchSession` 只 `throw err`，REPL 打印 `err.message`（如 `net down`），用户不知道进程已进入需要重启的状态。

### 验证用例

文件同上（`review-resume-rollback-state.spec.ts`，FakeWs 定义见 Bug 3）：

```ts
describe('switchTo 回挂也失败后的订阅状态', () => {
  it('回挂失败后，当前会话必须仍处于已订阅状态（否则重连不再收到它的快照）', async () => {
    const ws = new FakeWs();
    const { runner } = makeRunner(ws);
    await runner.attach({ id: 11, phase: 'IDLE' });
    expect(ws.subscribed).toEqual([11]);

    // 切换时 connect 失败，回挂时依然失败
    ws.failConnectTimes = 2;
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow();

    expect(runner.getSession()?.id).toBe(11);   // attach 先改指向，所以最终仍指回 11
    // 网络恢复后的重连只会重发 subscribed 里的会话；11 必须还在里面
    expect(ws.subscribed).toContain(11);
  });
});
```

### 实测结果（失败）

```
× switchTo 回挂也失败后的订阅状态 > 回挂失败后，当前会话必须仍处于已订阅状态
  → expected [] to include 11
```

（此时 `runner.getSession()?.id === 11` 成立、`ws.subscribed` 为空，即「挂载点指向 11、客户端未订阅 11」的半挂载状态；对应设计 E9 要求的「回滚也失败 → 提示请退出后重开 mao-agent」也没有任何输出。）

---

## Bug 5（低，第二轮新发现）：草稿态（无前序会话）切换失败仍留下「指向未订阅会话」的半挂载　✅ 已修复（见「第三轮复查」）

### 结论

`switchTo` 的失败分支用 `let rolledBack = prev?.id == null;` 判断「是否需要回挂」（`session-runner.ts:284`）。进程还没有任何会话时（交互新建会话在首条消息前不落库，即草稿态）`prev` 为 `null`，该表达式直接得到 `true` → 既不回挂、也不进入「解除挂载」分支，直接 `throw err`；而 `attach()` 在 `await ws.connect()` 之前就已把 `this.session` / `this.sessionId` 指向目标会话（`session-runner.ts:111-116`）。最终状态是：**runner 声称自己挂在目标会话上，客户端却没订阅它**——正是本次修复要消除的半挂载，只是从另一条分支进入。

### 为什么真实存在（代码路径 + 触发条件）

1. 失败分支（`session-runner.ts:283-303`）：

```ts
try {
  await this.attach(session);
} catch (err) {
  // 回挂原会话：成功后保留原会话的 todo / context（清空放在切换成功之后）。
  let rolledBack = prev?.id == null;   // ← 草稿态 prev=null → 这里直接是 true
  if (!rolledBack) {
    try { await this.attach(prev!); rolledBack = true; } catch { /* ignore */ }
  }
  if (!rolledBack) {                   // ← 草稿态永远进不来：不会解除挂载
    this.session = null;
    this.sessionId = 0;
    this.snapshotPhase = null;
    throw new CliError(`...\n会话已解除挂载，请退出后重开 mao-agent。`);
  }
  throw err;
}
```

2. `attach()` 先改指向、再连 WS（`session-runner.ts:109-119`）：

```ts
this.session = session;          // 111：先改指向
this.sessionId = session.id;
...
await this.opts.ws.connect();    // 116：这里抛错时订阅尚未建立
this.opts.ws.subscribe(this.sessionId);
```

3. `chat.ts` 的兜底也拦不住（`chat.ts:328-333`）：

```ts
try {
  await runner.switchTo(next);
} catch (err) {
  if (!runner.getSession()) attached = false;   // 草稿态 getSession() 非空 → 不生效
  throw err;
}
```

4. 用户可见后果（下游都以 `runner.getSession()` 为口径）：
   - `chat.ts:299` 的守卫 `if (runner.getSession()?.id === id) throw new CliError('已经是当前会话 #id')` → **重试 `/resume 22` 被拒绝**（提示「已经是当前会话 #22」，而进程实际并未挂载）；
   - `chat.ts:282` 把 `currentId = runner.getSession()?.id` 传给 `filterSwitchableSessions` → 面板把 22 当作「当前会话」**过滤掉**，用户无法从面板里选它；
   - 之后切到别的会话时，`switchTo` 会把 22 当作「旧会话」执行 `unsubscribe(22)` + `markRead(22)` → **把用户从未打开过的会话标记已读**；
   - `/session` 会打印 `sessionId=22`（实际未挂载）。

触发条件：交互新建（草稿）状态下执行 `/resume <id>`，且此刻 `ws.connect()` 失败（断网、`getToken()` 取不到导致 `openOnce()` 抛 `No token`、WS 升级被代理拦截等；此时 REST 请求是成功的，即「HTTP 通、WS 不通」或「REST 成功后网络瞬断」）。

### 验证用例

文件（本次在 `/tmp/review-bugs2` 下执行，可直接粘为 `agent-cli/test/review-resume-draft-halfmount.spec.ts`）：

```ts
import { describe, expect, it, vi } from 'vitest';
import { SessionRunner } from '../src/session/session-runner';
import type { WsClient } from '../src/ws/ws-client';
import type { RestClient } from '../src/rest/rest-client';
import type { Renderer } from '../src/render/types';
import type { WsEvent } from '../src/ws/event-types';

/** 对齐真实 WsClient：unsubscribe 从 subscribed 移除；connect 可注入失败次数。 */
class FakeWs {
  handlers: Array<(e: WsEvent) => void> = [];
  subscribed: number[] = [];
  unsubscribed: number[] = [];
  failConnectTimes = 0;

  async connect(): Promise<void> {
    if (this.failConnectTimes > 0) { this.failConnectTimes -= 1; throw new Error('net down'); }
  }
  subscribe(id: number): void {
    this.subscribed.push(id);
    this.emit({ type: 'session_snapshot', sessionId: id, data: { phase: 'IDLE' } });
  }
  unsubscribe(id: number): void {
    this.unsubscribed.push(id);
    this.subscribed = this.subscribed.filter((n) => n !== id);
  }
  send(): void {}
  async sendReliable(): Promise<boolean> { return true; }
  close(): void {}
  on(handler: (e: WsEvent) => void): () => void { this.handlers.push(handler); return () => undefined; }
  emit(evt: WsEvent): void { for (const h of this.handlers) h(evt); }
}

function makeRunner(ws: FakeWs) {
  const markRead = vi.fn(async () => undefined);
  const rest = {
    markRead,
    getSession: async (n: number) => ({ id: n, phase: 'IDLE' }),
  } as unknown as RestClient;
  const renderer: Renderer = { onEvent: () => undefined };
  const runner = new SessionRunner({
    rest, ws: ws as unknown as WsClient, renderer,
    printMode: false, ifRunning: 'wait', onQuestion: 'fail',
  });
  return { runner, markRead };
}

describe('草稿态（无前序会话）switchTo 失败后的半挂载状态', () => {
  it('不能「声称挂载在目标会话上、客户端却没有订阅它」', async () => {
    const ws = new FakeWs();
    const { runner } = makeRunner(ws);
    expect(runner.getSession()).toBeNull();          // 草稿态：还没有任何会话

    ws.failConnectTimes = 1;                          // 切换时 WS 连接失败
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow('net down');

    const s = runner.getSession();
    // 期望：要么保持未挂载（session=null），要么已挂载且已订阅
    if (s != null) expect(ws.subscribed).toContain(s.id!);
    else expect(s).toBeNull();
  });

  it('失败后不应声称仍在 #22 上（否则 chat.ts 会拒绝重试 /resume 22）', async () => {
    const ws = new FakeWs();
    const { runner } = makeRunner(ws);
    ws.failConnectTimes = 1;
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow('net down');
    // chat.ts switchSession 第 2 步：if (runner.getSession()?.id === id) throw new CliError(`已经是当前会话 #${id}`)
    expect(runner.getSession()?.id).not.toBe(22);
  });

  it('后续切换到别的会话时不应把从未打开的 #22 标记已读', async () => {
    const ws = new FakeWs();
    const { runner, markRead } = makeRunner(ws);
    ws.failConnectTimes = 1;
    await expect(runner.switchTo({ id: 22, phase: 'IDLE' })).rejects.toThrow('net down');
    await runner.switchTo({ id: 33, phase: 'IDLE' });   // 网络恢复后改切别的会话
    expect(markRead).not.toHaveBeenCalledWith(22);
  });
});
```

### 实测结果（3 条全失败）

```
× 不能「声称挂载在目标会话上、客户端却没有订阅它」   → expected [] to include 22
× 失败后不应声称仍在 #22 上（否则 chat.ts 会拒绝重试） → expected 22 not to be 22
× 后续切换到别的会话时不应把从未打开的 #22 标记已读   → expected "spy" to not be called with arguments: [ 22 ]
```

（对照：有前序会话时的同一条失败路径已被本轮修复覆盖——回挂成功保留数据、回挂失败解除挂载并提示重开，均由上面的复核用例验证通过。）

---

## 已核对且未发现问题的路径（供收敛参考）

| 路径 | 核对内容 |
|---|---|
| `/resume` 分发（`repl.ts` `case 'resume'`） | 数字直达不拉列表；关键词 0/1/多条三分支；面板返回 null → 「已取消」；运行中拒绝；`opts.modelId` 只在切换成功后更新；失败时保持原 `modelId` |
| `chat.ts` `switchSession` 守卫 | 忙拒绝、目标=当前拒绝、跨模式拒绝、LOCAL workspace 边界（与 `LocalExecutor.resolveWorkspace` 同一 `isWorkspaceWithin` 口径）、`--if-running=fail` |
| `chat.ts` `attached` / `createdSession` 收口 | 草稿态切换成功后 `ensureSession` 不再创建会话（不产生空白会话），切回已有会话也正确 |
| `SessionRunner.switchTo` 正常路径 | 旧会话 `unsubscribe` + `markRead`、`snapshotPhase` 置空（新会话快照被真正等待）、`resetRound` 覆盖执行态、事件按 `sessionId` 过滤后旧会话事件被丢弃 |
| 切到运行中的会话 | 集成验证：attach 拿到 `RUNNING` 快照 → `snapshotIsActive=true` → `resumeActiveRun`/`waitForCurrentRun` 收到匹配 `executionId` 的终态后返回（本轮已用真实 `SessionRunner` + FakeWs 跑通） |
| 面板正常尺寸下的交互 | 24 行终端下滚动后高亮跟随、`Enter` 返回 `items[cursor].id`、`Esc` 返回 `null`（对照用例已固定） |
| `session-filter.ts` | 排除当前会话、同模式过滤、LOCAL workspace 边界（等于/子目录通过，父/兄弟/空值拒绝）、`updatedAt DESC, id DESC` 排序、截断 20、不改动入参数组 |
| 其它 | `/help` 与 `SLASH_ITEMS` 文案（含 resume 的 usage/help）、`/session` 提示、`ui.spec` 的补全提交断言、`tsc --noEmit` 通过 |

## 复现方式

1. 用例均以「新增 vitest 规格」形式给出（上文每个 bug 都有独立文件与完整代码），在 `agent-cli` 下运行即可，例如：

   ```bash
   cd agent-cli && npx vitest run test/review-resume-footer-state.spec.ts
   cd agent-cli && npx vitest run test/review-resume-pick-window.spec.ts
   cd agent-cli && npx vitest run test/review-resume-rollback-state.spec.ts
   ```

2. 本次审查实际执行时，为不改动仓库文件，把上述用例放在 `/tmp/review-bugs/` 下（`package.json` + `vitest.config.mts`，`node_modules` 软链到 `agent-cli/node_modules`，用例用绝对路径 import 工作区源码）执行：

   ```bash
   cd /tmp/review-bugs && npx vitest run
   ```

   失败输出与正文「实测结果」一致：3 个文件中共 4 条用例失败，分别对应 Bug 1 / Bug 2 / Bug 3 / Bug 4；其余对照与集成断言（24 行终端对照、面板滚动后 Enter 选中项、切到运行中会话后续接输出）全部通过。

   报告里的三段 spec 另外按仓库内相对路径形式（`agent-cli/test/*.spec.ts`）在 `/tmp/report-verify/agent-cli`（`src`、`node_modules` 软链到本 worktree 的 `agent-cli`）原样执行过：同样是 4 条失败 + 1 条对照通过，可直接粘贴回仓库复现。

3. 回归基线：`cd agent-cli && npx vitest run`（工作区现有改动下 59 个文件 / 663 用例全绿），确认上述问题不在现有用例覆盖范围内。

4. 第二轮复查（修复验证 + Bug 5）在 `/tmp/review-bugs2`（同构：`package.json` + `vitest.config.mts`，`node_modules` 软链到 `agent-cli/node_modules`，用例以绝对路径 import 工作区源码）执行：

   ```bash
   cd /tmp/review-bugs2 && npx vitest run
   ```

   其中 `verify-ui.spec.ts`（原 bug1/bug2 复核）、`verify-runner.spec.ts`（原 bug3/bug4 复核）、`panel-sweep.spec.ts`（面板窗口遍历）、`recovery.spec.ts`（解除挂载后可恢复 + 正常切换仍清空数据）共 8 条断言全部通过；`draft-halfmount-assert.spec.ts`（Bug 5）在第二轮为 3 条失败，第三轮修复后转为 3 条全部通过（与 `round3.spec.ts` 的 5 条回归断言一起跑）。

5. 第三轮复查（Bug 5 修复验证）同样在 `/tmp/review-bugs2` 下执行：

   ```bash
   cd /tmp/review-bugs2 && npx vitest run
   ```

   结果：`draft-halfmount-assert.spec.ts` 3/3、`round3.spec.ts` 5/5、`verify-ui.spec.ts` 3/3、`verify-runner.spec.ts` 2/2、`panel-sweep.spec.ts` 1/1、`recovery.spec.ts` 2/2 全部通过（共 16 条断言）。

## 结论

**无 bug**（第三轮）：第一轮 4 个 bug、第二轮 1 个 bug（Bug 5）均已在当前 worktree 修复并逐条用例复核通过；本轮复核覆盖草稿态 / 有前序会话 / 回挂失败三条失败出口、解除挂载后的重试与 `shutdown()`、成功路径（含切到运行中会话的续接）、状态栏复位与面板窗口遍历，未发现新引入的功能问题。
