# 终端 REPL 会话切换（`/resume`）技术方案

- 状态：已评审（2026-11-06，用户确认按建议定案；未实施）
- 日期：2026-11-06
- 需求来源：用户提案「能支持 resume 切换会话吗？」（飞书对话 2026-11-06；附图：REPL `/help` 命令面板，14 项命令中无会话切换）
- 上游设计：
  - `docs/plan/2026-08-20-mao-agent-cli-technical-design.md`（CLI 总体设计；§「一进程一会话」是本方案要突破的显式简化，见 §1.4）
  - `docs/plan/2026-08-20-mao-agent-cli-ux-design.md`（§6.7 冷启动与 resume、welcome 文案）
  - `docs/plan/2026-06-11-session-management-design.md`（会话状态与列表口径）
- 规模：中等（纯 `agent-cli` 客户端改动：REPL 命令 + 会话选择面板 + runner 会话重挂；**零后端改动、零数据库迁移**）
- 关联文件：
  - `agent-cli/src/repl/repl.ts`（斜杠命令分发、启动续接逻辑）
  - `agent-cli/src/ui/slash-complete.ts`（命令唯一数据源）
  - `agent-cli/src/commands/chat.ts`（会话生命周期、`attached` / `createdSession` / `ensureSession`、本地执行器）
  - `agent-cli/src/session/session-runner.ts`（`attach` / `shutdown` / 回合状态）
  - `agent-cli/src/tui/{ink-renderer,modal-controller,types}.ts`（modal 队列与渲染）
  - `agent-cli/src/ui/{welcome,relative-time}.ts`（历史摘要、相对时间）
  - `agent-cli/src/local/{executor,trust}.ts`（本地工作区信任边界）

## 1. 需求背景

### 1.1 现状与问题

用户在 REPL 中找不到「切换会话」的入口：`/help` 的 14 项斜杠命令（`slash-complete.ts` `SLASH_ITEMS`）不含会话切换，`/session` 只打印当前会话信息，并在末尾提示 `换会话: mao-agent resume | mao-agent ls`。

也就是说，换会话必须退出进程、重新启动：

```bash
# 当前唯一路径
Ctrl+D（或 /exit）
mao-agent ls                  # 找 id
mao-agent resume <sessionId>  # 指定会话；省略 id 取最近更新
```

问题：

1. **中断对话流**：正在讨论 A 问题，需要回看/继续 B 会话，必须退出重开；终端 scrollback 保留，但进程内状态（输入草稿、队列、模型选择）全部丢失。
2. **切换成本高**：`ls` 输出无交互选择，用户要手动抄 id；`resume` 只能取「最近更新」或精确 id，无法按关键词找。
3. **与桌面端体验割裂**：桌面端任务列表点一下就切换，CLI 是唯一需要「退出重进」的客户端。

### 1.2 关键事实（设计建立在其上）

| # | 事实 | 依据 |
|---|---|---|
| F1 | `SessionRunner.attach(session)` 已具备挂载任意会话的完整能力：`resetRound()`、重订阅 WS（`ws.subscribe(id)`）、等待会话快照（`waitForSnapshot(2000)`） | `session-runner.ts:109` |
| F2 | `shutdown()` 是进程级收尾：`unsubscribe` + `markRead` + 关本地执行器 + 断 WS。因此「切换会话」不能复用 `shutdown`，需要新增「只换会话、不关进程」的操作 | `session-runner.ts:232` |
| F3 | WS 是进程级单连接，会话订阅是逻辑层（`subscribe` / `unsubscribe`）；断线重连时按 `subscribed` 集合自动重发订阅 | `ws-client.ts:133/138/222` |
| F4 | `attach()` 不重置 `snapshotPhase` / `todos` / `lastContext`。若沿用旧值：`waitForSnapshot` 会因 `snapshotPhase != null` 立即返回（拿不到新快照）；`/todo`、`/context` 显示上一会话数据 | `session-runner.ts:118/656/562/508` |
| F5 | `resetRound()` 已覆盖本轮执行态（executionId、文本、usage、toolCalls、fileChanges、flags），但不清 `todos` / `lastContext` / `snapshotPhase` / `durationTimer` | `session-runner.ts:267` |
| F6 | 消息发送把 REPL 当前 `modelId` 写入 `send_message.data.modelId`。切换后不同步 `opts.modelId` 会把新会话模型改成旧模型的 | `session-runner.ts` `sendMessage` |
| F7 | `LocalExecutor` 的 `workspace` 构造时固定为启动工作区；服务端下发的 workspace 必须「等于它或位于其内部」——这是本地信任边界 | `local/executor.ts:122` `resolveWorkspace` |
| F8 | 已定稿内容写入 Ink `<Static>` 后不可改写；`seedChrome` 有一次性守卫；`announce`（转瞬提示）与 `print`（留痕输出）是两个通道 | `ink-renderer.ts:180/304/309` |
| F9 | 键盘事件走自研 `KeyDecoder`；modal 打开时事件先给 `modalQueue` 队头，不与输入框争抢 | `ink-renderer.ts` `dispatchKeys` |
| F10 | `GET /sessions?status=ACTIVE&keyword=` 返回完整 `SessionVO`（`title/phase/executionMode/workspace/agentName/modelName/updatedAt/unread/running`），无分页；后端固定排除 `SUBAGENT` / `SIDE_TASK`，`keyword` 只按 `title LIKE` 匹配（**不搜消息内容**），排序 `updated_at DESC, id DESC` | `rest-client.ts:88`、`session.service.ts` `baseSessionListQuery` / `listSessions`（2026-11-06 核对） |
| F11 | 实测真实账号活跃会话可达数百条（本次设计核对时为 477 条）→ 面板必须在客户端截断，不能全量铺开 | 生产只读核对（2026-11-06） |
| F12 | 0.0.457 已把交互新建会话**延迟到第一条消息**才落库：切换时不存在需要回收的空会话，未落库的草稿直接废弃即可 | `chat.ts` `resolveSessionTarget` / `ensureSession`、`CHANGELOG.md 0.0.457` |
| F13 | `cmdLs` 已有「按 `updatedAt` 倒序 + id 兜底」的排序与行格式先例；`formatRelativeTime`、`paletteWindow` 可直接复用 | `ls.ts`、`ui/relative-time.ts`、`ui/slash-complete.ts` |

### 1.3 目标与非目标

**目标**

1. REPL 内一条命令切换会话，不退出进程、不丢当前输入上下文。
2. 有可用的会话选择界面（最近会话列表 + 键盘选择），并支持按 id / 关键词直达。
3. 切换后状态完全对齐新会话：历史摘要、`/session`、`/todo`、`/context`、状态栏 Agent/模型/模式、下一条消息的 `modelId`。
4. 不破坏既有纪律：本地工作区信任边界、单 WS 连接、`<Static>` 渲染约束、运行中任务不串流。

**非目标**

1. 不做「多会话并行」：同一时刻仍只有一个活动会话，一个回合仍在原会话跑完。
2. 不做跨模式切换（LOCAL 进程 ↔ CLOUD 会话）——首版明确拒绝，见 D2。
3. 不做会话管理（重命名 / 删除 / 归档）：仍走 `mao` CLI 或桌面端。
4. 不改后端接口与 `mao-agent resume` / `ls` 的进程级入口。

### 1.4 为什么现在可以突破「一进程一会话」

上游设计明确写着：

> **一个进程一个会话**（这是首版的显式简化）。切换会话请退出重开，避免多会话事件混流带来的状态机复杂度。
> —— `docs/plan/2026-08-20-mao-agent-cli-technical-design.md:282`

当时的主要顾虑是「多会话事件混流」。现在这条顾虑已经被现有架构消解：

1. **事件隔离已存在**：`handleWs` 里所有事件先过 `acceptEvent(evt, this.sessionId, this.executionId)`，sessionId 不匹配的事件直接丢弃（`session-runner.ts:375`）。切换后 `sessionId` 指向新会话，旧会话事件不会进入渲染链。
2. **订阅是显式的**：`WsClient` 维护 `subscribed` 集合，`unsubscribe(oldId)` 后服务端不再推旧会话事件，重连也不会重新订阅（`ws-client.ts:138/222`）。
3. **挂载能力已存在**：`attach()` 就是「给一个会话 id，把 runner 指向它」，`resume` 走的正是这条路。
4. **渲染纪律已收敛**：modal 队列、`<Static>` 定稿、`announce`/`print` 双通道都已定型，切换只需按既有方式产出反馈。
5. **空会话问题已解决**：0.0.457 的延迟创建让「切换时丢弃草稿」是零成本操作（F12）。

因此本方案不引入新的状态机，只是把「进程启动时选会话」扩展为「进程内可重选会话」，并把散落在 `chat.ts` 的会话状态收口成一个可复用的切换函数。

## 2. 方案概述

在 REPL 内新增 `/resume` 斜杠命令：

- **无参数** → 弹出「会话选择面板」（最近 20 条，↑↓ 选择、Enter 切换、Esc 取消）。
- **`/resume <纯数字>`** → 直接切换到该会话 id。
- **`/resume <其他文本>`** → 按关键词搜索（后端 `keyword` 参数）：
  - 命中 0 条 → 提示；
  - 命中 1 条 → 直接切换；
  - 命中多条 → 弹面板。

切换成功后，进程继续留在 REPL，当前会话指针、渲染、状态栏、历史摘要全部对齐新会话；未发消息的草稿会话被直接废弃（不落库）。

### 2.1 用户可见行为

**选择面板**

```text
> /resume
╭──────────────────────────────────────────────────────────────╮
│ 切换会话（最近 20 条 · ↑↓ 选择 · Enter 确认 · Esc 取消）        │
│ ❯ #2272  修复登录后 baseUrl 保存      梁子  3 分钟前  ● 运行中  │
│   #2270  mao-agent 切换 baseUrl      梁子  1 小时前           │
│   #2268  运营活动数据核对              小马  2 天前            │
│   #2261  周报数据汇总                  梁子  3 天前            │
╰──────────────────────────────────────────────────────────────╯
```

**切换成功**

```text
── 已切换到会话 #2270 · mao-agent 切换 baseUrl ──
❯ 帮我看看 baseUrl 的默认值在哪
⏺ 在 agent-cli/src/config/base-url.ts，登录时会…（摘要最近 3 轮）
```

- 状态栏即时变为新会话的 Agent / 模型 / 模式。
- `/session`、`/todo`、`/context` 反映新会话。
- 若目标会话正在运行：提示「该会话仍在执行，续接当前输出…」并进入等待（见 D4）。

### 2.2 与既有行为的关系

| 入口 | 行为 |
|---|---|
| `mao-agent resume [id]` / `--resume` / `--continue` | 不变（进程级启动入口） |
| `mao-agent ls` | 不变（`/resume` 面板与其排序口径一致） |
| 打印模式 `-p` | 不涉及（无 REPL） |
| 交互新建（0.0.457 延迟创建） | 兼容：未发消息的草稿在切换时直接废弃，不落库 |
| `/session` | 文案从「退出重开」改为「/resume 本进程内切换」 |

## 3. 技术选型（决策表）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 命令名 | `/resume` | 与 `mao-agent resume` 同词，认知一致；`/switch` 与 `/model` 语义易混；`/session` 保持「查看」语义不扩展 |
| D2 | 跨模式切换（LOCAL 进程 ↔ CLOUD 会话） | **首版禁止**：LOCAL 进程只列 LOCAL 会话、CLOUD 进程只列 CLOUD 会话；跨模式提示「退出后用 `mao-agent resume <id>` 打开」 | 进程的 `localMode` 决定本地执行器是否创建、banner/状态栏、`localExtras`（agentsMd/localSkills）；跨模式要把这些全链路动态化，首版收益低、风险高 |
| D3 | LOCAL 会话 workspace 边界 | 只允许切到「启动工作区或其内部」的会话（复用 `isWorkspaceWithin`）；其他提示新开进程 | 与 `LocalExecutor.resolveWorkspace` 的信任边界一致（F7）；workspace 不同则 executor 与 agentsMd 需重建，成本高 |
| D4 | 切到运行中的会话 | **允许**并自动续接输出；但 `--if-running=fail` 时拒绝（尊重用户显式选择），`--if-running=cancel` 不沿用 | 启动路径已有完整先例（`repl.ts` `snapshotIsActive` 分支 → `waitForCurrentRun`）；「切进去看进度/等它跑完」是合理用例。切换不应 cancel 别的客户端正在跑的任务 |
| D5 | 切换的可见反馈 | **不清屏**：`print` 分隔行 + 历史摘要（最近 3 轮）；banner 保持原样 | `<Static>` 不可改写（F8），清屏重挂（`clearAll`）会丢失 scrollback；分隔行足以澄清「现在是哪个会话」。清屏增强不做（§8 Q5） |
| D6 | 列表数据与截断 | 面板显示按 `updatedAt DESC, id DESC` 重排后的最近 20 条（窗口滚动 8 行）；与 `ls` 口径一致 | 客户端显式重排保证与 `mao-agent ls` 完全一致（后端当前已是同口径，重排可防未来后端排序变化）；生产会话数百条（F11）必须截断 |
| D7 | 面板形态 | 新增 `SessionPickController` + `PanelView kind: 'session-pick'`，复用 `modalQueue` | 与 ask / approval 同一套键盘分发与渲染预算（`buildPanel`），不引入新交互范式 |
| D8 | 运行中守卫 | `runner.isRunning()`（本进程 busy）时拒绝切换；正在等待审批 / 提问同样拒绝（busy 覆盖） | 本进程 busy 时重挂会让消息/审批投递错乱 |
| D9 | 切换失败回滚 | `switchTo` 保存原会话，新会话 attach 失败时 best-effort 回挂原会话并抛错；彻底失败提示重开进程 | 不留「半挂载」状态；attach 失败多为网络/服务端异常 |
| D10 | 目标 = 当前会话 | 不重挂，提示「已经是当前会话」 | 避免无意义的退订/重订阅与快照等待 |
| D11 | 历史摘要轮数 | 固定 3 轮（与 `resume` 默认一致）；`--replay-full` 不放大切换行为 | 防止误切换刷屏；完整历史可用 `mao-agent resume <id> --replay-full` 重开 |
| D12 | 关键词搜索 | 复用 `GET /sessions?keyword=`；不做本地模糊匹配、不做分页加载 | 后端已有能力，避免两套匹配口径 |

## 4. 实现细节

### 4.1 会话列表数据源与过滤

`chat.ts` 新增（注入给 REPL）：

```ts
const RESUME_PICK_LIMIT = 20;

async function listSwitchableSessions(query?: string): Promise<SessionVO[]> {
  const all = await rest.listSessions({ status: 'ACTIVE', keyword: query || undefined });
  const currentId = runner.getSession()?.id;
  return all
    .filter((s) => s.id != null && s.id !== currentId)                 // D10：不显示当前会话
    .filter((s) => (s.executionMode === 'LOCAL') === localMode)         // D2：只列同模式
    .filter((s) => !isLocalWorkspaceBlocked(s))                        // D3：LOCAL 越界不列出
    .sort(byUpdatedDesc)                                               // D6：updatedAt DESC, id DESC
    .slice(0, RESUME_PICK_LIMIT);
}
```

- `isLocalWorkspaceBlocked(s)`：`s.executionMode === 'LOCAL'` 且（`workspace` 为空 或 `!isWorkspaceWithin(s.workspace, localWorkspace)`）。
  - `isWorkspaceWithin(candidate, localWorkspace)` 的入参顺序见 `local/sandbox.ts`：第一个参数是被检查路径。
  - 过滤而不是「列出但拒绝」：避免用户选中后才报错；空结果时给出解释（§5）。
- 排序与 `cmdLs` 一致（`ls.ts`）：`Date.parse(updatedAt) || 0` 倒序，id 倒序兜底。
- 关键词搜索直接透传 `keyword`（后端按**标题** `LIKE` 匹配，不搜消息内容），结果同样经过上面的过滤与截断；`/resume <关键词>` 命中数可能因过滤而变少，以过滤后为准。

### 4.2 `SessionRunner.switchTo()`（新增）

```ts
/**
 * 只换会话、不关进程：退订旧会话并把旧会话标记已读，然后挂载新会话。
 * 与 shutdown() 的区别：不断 WS、不关本地执行器、不解除事件监听。
 */
async switchTo(session: SessionVO): Promise<void> {
  if (session.id == null) throw new CliError('会话缺少 id');
  if (this.busy) throw new CliError('当前任务仍在执行。请等待结束或 /cancel 再切换会话。');

  const prev = this.session;
  const prevId = this.sessionId;

  this.disarmMaxDuration();
  this.snapshotPhase = null;   // 关键：否则 attach 内 waitForSnapshot 立即返回（F4）
  this.todos = [];
  this.lastContext = {};

  if (prevId && prevId !== session.id) {
    this.opts.ws.unsubscribe(prevId);
    try {
      await this.opts.rest.markRead(prevId);
    } catch {
      // 切换不因「标记已读」失败而中断
    }
  }

  try {
    await this.attach(session);   // 内含 resetRound + ws.on + connect + subscribe + waitForSnapshot
  } catch (err) {
    if (prev?.id != null) {
      try {
        await this.attach(prev);  // D9：best-effort 回挂原会话
      } catch {
        // 回滚也失败：保持未挂载状态，由调用方提示重开进程
      }
    }
    throw err;
  }
}
```

要点：

- **不调用 `shutdown()`**：它会关本地执行器与 WS（F2），切换只需要解绑会话。
- `snapshotPhase = null` 是必须的（F4），否则新会话的快照等待直接返回，`snapshotIsActive` 仍反映旧会话。
- `resetRound()` 由 `attach()` 调用，覆盖执行态（F5）；`todos` / `lastContext` 由本方法显式清空。
- `ws.unsubscribe(prevId)` 必须在 `attach()` 之前——`attach` 内部只负责 `subscribe(newId)`，不会退订旧 id。

### 4.3 `chat.ts`：`switchSession()`（新增，注入给 REPL）

守卫与刷新顺序固定，任何一步失败都不改变当前会话：

```ts
async function switchSession(id: number): Promise<SessionVO> {
  // 1. 本进程忙 → 拒绝（D8）；REPL 层已先拦一道，这里兜底
  if (runner.isRunning()) throw new CliError('当前任务仍在执行…');

  // 2. 目标 = 当前会话（D10）
  if (runner.getSession()?.id === id) throw new CliError(`已经是当前会话 #${id}`);

  // 3. 取会话（同时完成归属校验；不存在 → 后端 code=3002）
  const next = await rest.getSession(id);

  // 4. 模式必须一致（D2）
  const nextLocal = next.executionMode === 'LOCAL';
  if (nextLocal !== localMode) {
    throw new CliError(
      `无法切换：该会话是 ${next.executionMode ?? 'CLOUD'} 模式，当前进程是 ${localMode ? 'LOCAL' : 'CLOUD'} 模式。\n` +
      `请退出后用 mao-agent resume ${id} 打开。`,
    );
  }

  // 5. LOCAL 会话的 workspace 必须在启动工作区内（D3）
  if (nextLocal) {
    const target = next.workspace ? path.resolve(next.workspace) : '';
    if (!target || !isWorkspaceWithin(target, localWorkspace)) {
      throw new CliError(
        `无法切换：该会话的本地工作区是 ${next.workspace ?? '(空)'}，不在当前工作区 ${localWorkspace} 内。\n` +
        `请退出后用 mao-agent resume ${id} 打开。`,
      );
    }
  }

  // 6. --if-running=fail：尊重显式选择（D4）
  if (cfg.ifRunning === 'fail' && (next.running || isRunningPhase(next.phase))) {
    throw new CliError(`该会话仍在执行（--if-running=fail）：#${id}`);
  }

  // 7. 真正切换（含回滚）
  await runner.switchTo(next);
  attached = true;            // 草稿状态收口：后续 ensureSession 不再创建新会话
  createdSession = undefined;

  // 8. 会话级外部状态同步
  rememberLastSession(id);
  modelId = next.modelId ?? modelId;
  contextWindowTokens = resolveContextWindowTokens(next, modelsCache, modelId);
  inkRenderer?.setMeta({
    agentName: next.agentName,
    modelName: next.modelName,
    executionMode: nextLocal ? 'LOCAL' : 'CLOUD',
    contextWindowTokens,
  });

  // 9. 留痕输出：分隔行 + 最近 3 轮摘要（D5 / D11）
  const recent = await loadHistory(rest, id, false);
  inkRenderer?.print(
    `── 已切换到会话 #${id}${next.title ? ` · ${next.title}` : ''} ──` +
      (recent.length > 0 ? `\n${recent.join('\n')}` : ''),
  );

  return next;
}
```

配套改动：

- `modelId` 由 `const` 改 `let`；`listActiveModels()` 的结果保存为 `modelsCache`（切换后重算 `contextWindowTokens` 与 banner 模型名时复用，避免再发一次请求；`modelsCache` 为空数组时 `resolveContextWindowTokens` 按缺省窗口处理）。
- `isRunningPhase` 需从 `ws/event-filter` 导入到 `chat.ts`（当前未导入）。
- `attached` / `createdSession` 是 `cmdChat` 闭包变量，切换逻辑必须写在 `cmdChat` 内（不能只写在 REPL 层）——否则 0.0.457 的 `ensureSession` 会在切换后误建新会话。
- `next.modelId` 为空时保留原 `modelId`：新会话没有模型配置时沿用进程当前选择（与 `runPrompt(text, opts.modelId)` 的既有语义一致）。
- 历史摘要复用 `loadHistory(rest, id, false)`（`rest.listMessages(id, { roundLimit: 3 })` + `formatHistorySummary`）。

### 4.4 `repl.ts`：`/resume` 分发

`ReplOptions` 新增（全部可选，便于单测与降级）：

```ts
/** 可切换会话列表（已按模式/工作区过滤、按最近排序、已截断）。query 为空取最近。 */
listSwitchableSessions?: (query?: string) => Promise<SessionVO[]>;
/** 切换会话（chat.ts 内完成守卫、重挂与状态刷新）。失败抛 CliError。 */
switchSession?: (id: number) => Promise<SessionVO>;
/** 会话选择面板；缺省时打印列表并提示 /resume <id>（非 TUI 场景/单测）。 */
pickSession?: (items: SessionVO[]) => Promise<number | null>;
```

`handleSlash` 新增分支：

```ts
case 'resume': {
  if (!opts.switchSession || !opts.listSwitchableSessions) {
    io.print('当前模式不支持切换会话。', 'warn');
    return;
  }
  if (opts.runner.isRunning()) {
    io.hint('当前任务还在执行：等它结束或 /cancel 后再切换。');
    return;
  }

  const byId = /^\d+$/.test(arg);                 // /resume 123：直切，不拉列表
  const items = byId ? [] : await opts.listSwitchableSessions(arg || undefined);
  let targetId: number | null = byId ? Number(arg) : null;

  if (!byId) {
    if (items.length === 1) {
      targetId = items[0].id!;                    // 关键词命中 1 条：直切
    } else if (items.length > 1) {
      if (!opts.pickSession) {
        io.print(formatSessionRows(items));       // 无面板时打印列表，提示 /resume <id>
        return;
      }
      targetId = await opts.pickSession(items);
    }
  }

  if (targetId == null) {
    if (!byId && items.length === 0) io.print(emptyHint(arg));
    else io.hint('已取消。');
    return;
  }

  try {
    const s = await opts.switchSession(targetId);
    opts.modelId = s.modelId ?? opts.modelId;  // F6：下一条消息带新会话模型
    io.hint(`已切换到会话 #${s.id}${s.title ? ` · ${s.title}` : ''}`);
    if (opts.runner.snapshotIsActive) await resumeActiveRun('该会话仍在执行，续接当前输出。可用 /cancel 中止。');
  } catch (err) {
    io.print(err instanceof Error ? err.message : String(err), 'err');
  }
  return;
}
```

- `/resume <纯数字>` 直接 `switchSession`，跳过列表请求（少一次网络往返）；数字形式不经过「模式/工作区过滤」，由 `switchSession` 的守卫给出具体原因。
- `formatSessionRows` / `emptyHint` 是实现时新增的小辅助函数（列表行格式化复用 `ls.ts` 的 `formatRow` 思路；空态文案区分「无会话」与「都被过滤」，见 §5 E11/E12）。
- 面板打开期间输入框由 modal 机制禁用（`app.tsx` 中 `<InputBox enabled={!panel} />`），不会出现并发输入；`handleSubmit` 本身串行。
- `/session` 的两处文案（未创建 / 已有会话）把 `换会话: mao-agent resume | mao-agent ls` 改为 `换会话: /resume（本进程内切换） | mao-agent resume <id>`。

### 4.5 `resumeActiveRun()` 抽取（启动段与切换后共用）

现有启动段逻辑（`repl.ts`）：

```ts
if (opts.firstPrompt) {
  if (opts.runner.snapshotIsActive) { hint('该会话仍在执行，先续接当前输出…'); await opts.runner.waitForCurrentRun(); }
  await handleSubmit(opts.firstPrompt);
} else if (opts.runner.snapshotIsActive) {
  hint('该会话仍在执行，续接当前输出。可用 /cancel 中止。');
  opts.renderer.startRound();
  await opts.runner.waitForCurrentRun();
}
```

改为：

```ts
const resumeActiveRun = async (tip: string): Promise<void> => {
  hint(tip);
  opts.renderer.startRound();
  try {
    await opts.runner.waitForCurrentRun();
  } catch (err) {
    print(err instanceof Error ? err.message : String(err), 'err');
  }
};
```

启动段与 `/resume` 成功后都调用它（提示文案按场景传入）。这样就复用了 `waitForCurrentRun` 已有的「等待占用方结束 / 不 cancel 对方 / 受 `--max-duration` 约束」语义。

### 4.6 会话选择面板

**控制器**（`tui/modal-controller.ts` 新增，约 80 行）：

```ts
export interface SessionPickItem {
  id: number;
  title?: string | null;
  agentName?: string | null;
  updatedAt?: string | null;
  running?: boolean;
  unread?: boolean;
}

export class SessionPickController {
  private cursor = 0;
  constructor(
    readonly items: SessionPickItem[],
    private readonly onDone: (id: number | null) => void,
    private readonly maxRows = 8,
  ) {}
  get state(): SessionPickViewState { /* { kind: 'session-pick', items, cursor, offset, total } */ }
  handleKey(ev: KeyEvent): void {
    // up / k：cursor--（clamp）；down / j：cursor++（clamp）
    // enter：onDone(items[cursor].id)
    // escape / ctrl+c：onDone(null)
    // （可选）char '1'..'9'：快选第 N 条
  }
}
```

**渲染**（`ink-renderer.ts` 新增 `buildSessionPickPanel`）：

```text
切换会话（最近 20 条 · ↑↓ 选择 · Enter 确认 · Esc 取消）
❯ #2272  修复登录后 baseUrl 保存      梁子  3 分钟前  ● 运行中
  #2270  mao-agent 切换 baseUrl      梁子  1 小时前
  #2268  运营活动数据核对              小马  2 天前
共 20 条 · 快速切换：/resume <id> 或 /resume 关键词
```

- 行内容：`#id` + 标题（按终端宽度裁剪，空标题显示「未命名会话」）+ Agent + `formatRelativeTime(updatedAt)` + 运行中/未读标记。
- 窗口滚动复用 `paletteWindow(items, cursor, 8)`。
- `types.ts`：`PanelView.kind` 增加 `'session-pick'`；新增 `SessionPickViewState`（含 `items/cursor/offset/total`）。
- `ink-renderer.ts`：`pickSession(items): Promise<number | null>`（仿 `requestApproval`：入队 → 用户操作 → `closeModal` + resolve）；`ModalEntry` 联合类型增加 `{ kind: 'session-pick'; controller }`；`buildPanel` 增加分支；`dispatchKeys` 无需改动（统一 `head.controller.handleKey`）。

### 4.7 切换后的状态对照表

| 对象 | 刷新动作 | 备注 |
|---|---|---|
| `runner.session` / `sessionId` | `attach(next)` | 内含 `resetRound` + `subscribe` + 等待快照 |
| `runner.snapshotPhase` / `todos` / `lastContext` | `switchTo` 显式重置 | F4 |
| `runner.durationTimer` | `disarmMaxDuration()` | 防止跨会话超时误 cancel |
| REPL `opts.modelId` | `= next.modelId ?? 原值` | F6，由 REPL 在切换成功后设置 |
| 状态栏（Agent/模型/模式/上下文） | `inkRenderer.setMeta(...)` | 构造时传的是初始会话，必须显式更新 |
| scrollback | `print` 分隔行 + 最近 3 轮摘要 | D5 / D11 |
| `rememberLastSession` | 新会话 id | 影响后续 `--continue` |
| `chat.ts` `attached` / `createdSession` | `true` / `undefined` | 草稿废弃，不落库 |
| WS 订阅 | `unsubscribe(旧)` + `subscribe(新)` | `switchTo` + `attach` |
| `/session` `/todo` `/context` | 无需改动 | 全部从 `runner` 取当前会话数据 |

## 5. 边界与错误处理

| # | 场景 | 行为 |
|---|---|---|
| E1 | 本进程任务运行中执行 `/resume` | 拒绝：「当前任务还在执行：等它结束或 /cancel 后再切换。」（REPL + `switchSession` 双保险） |
| E2 | 目标就是当前会话 | 拒绝：「已经是当前会话 #id」（D10） |
| E3 | 跨模式（LOCAL ↔ CLOUD） | 列表不展示；直切时拒绝并提示 `mao-agent resume <id>`（D2） |
| E4 | LOCAL 会话 workspace 越界 / 为空 | 列表不展示；直切时拒绝并给出两边路径（D3） |
| E5 | 目标不存在 / 非本人 | 后端 `code=3002 会话不存在` 原样提示 |
| E6 | 目标运行中，且 `--if-running=fail` | 拒绝（D4） |
| E7 | 目标运行中（默认 / `wait`） | 允许；切换后 `snapshotIsActive` → 提示并 `waitForCurrentRun` 续接 |
| E8 | 目标运行中，`--if-running=cancel` | 不沿用（切换不 cancel 别的客户端任务）；按 `wait` 处理 |
| E9 | `attach` 失败（断网 / 服务端异常） | 回滚原会话（best-effort）后抛错；回滚也失败 → 提示「请退出后重开 mao-agent」 |
| E10 | 面板 Esc / Ctrl+C | 取消，不改变当前会话；提示「已取消。」 |
| E11 | 列表为空（无会话） | 「没有可切换的会话。直接发消息继续当前会话。」 |
| E12 | 列表为空（因模式/工作区过滤） | 「最近会话都与当前进程模式或工作区不匹配；用 mao-agent resume <id> 另开进程打开。」 |
| E13 | 关键词 0 命中 | 「没有匹配「xxx」的会话（按标题匹配）。」 |
| E14 | 关键词命中 1 条 | 直接切换（不弹面板） |
| E15 | 切换过程中用户继续输入 | 切换在 `handleSubmit` 内串行执行；面板期间输入框禁用（E9 既有机制） |
| E16 | 切换后立即发消息 | `ensureSession` 因 `attached=true` 直接跳过；消息发到新会话 |
| E17 | 切换后 Ctrl+D 退出 | `shutdown` 对新会话 `markRead` + 退订，无空白会话产生（F12 回归） |

## 6. 测试计划

### 6.1 单元测试（vitest）

1. **`test/session-switch.spec.ts`（新增）**
   - `SessionRunner.switchTo`：
     - 正常切换：旧会话 `unsubscribe` + `markRead` 各一次、`subscribe(newId)`、`snapshotPhase` 重置、`todos/lastContext` 清空；
     - 目标 = 当前 → 不重复退订；
     - `busy` 时抛错；
     - `attach` 失败 → 回滚 `attach(prev)` 并抛原错；
     - `markRead` 抛错不影响切换。
   - `listSwitchableSessions`（抽出纯函数 `filterSwitchableSessions(all, { currentId, localMode, localWorkspace })` 后直接测）：
     - 排除当前会话；`LOCAL` / `CLOUD` 模式过滤；
     - LOCAL workspace 边界（等于 / 子目录通过，父目录 / 兄弟目录 / 空值拒绝）；
     - 排序（updatedAt 倒序 + id 兜底）、截断 20 条；
     - keyword 透传。
   - 守卫：`--if-running=fail` 拒绝；跨模式拒绝文案包含 `mao-agent resume`。
2. **`test/session-pick-controller.spec.ts`（新增）**
   - ↑↓ / j k 移动与边界 clamp；Enter 返回 id；Esc / Ctrl+C 返回 null；超过 8 条时 offset 跟随滚动；（若实现）数字快选。
3. **`test/slash-resume.spec.ts`（新增，驱动导出的 `handleSlash`）**
   - `/resume` → 调用 `listSwitchableSessions(undefined)` + `pickSession`；
   - `/resume 2270` → 直接 `switchSession(2270)`，不拉列表；
   - `/resume 关键词` → 1 条直切 / 多条弹面板 / 0 条提示；
   - 面板返回 null → 「已取消」且不调用 `switchSession`；
   - 运行中 → 拒绝且不调用 `switchSession`；
   - 切换成功后 `opts.modelId` 更新为 `s.modelId`；
   - `snapshotIsActive` → 调用 `waitForCurrentRun`。
4. **`test/session-defer.spec.ts`（回归增补）**
   - 草稿状态下切换成功后，`ensureSession` 不再创建会话（`attached=true`）。

### 6.2 端到端冒烟（mock server + pty，沿用 0.0.457 的脚手架）

| 场景 | 步骤 | 断言 |
|---|---|---|
| S1 面板切换 | `/resume` → ↓ → Enter → 发一条消息 | `GET /sessions?status=ACTIVE`、`GET /sessions/<new>`、`PUT /sessions/<old>/read`、WS `subscribe` 帧含新 id、`send_message.sessionId = 新 id`、`data.modelId = 新会话模型` |
| S2 直达切换 | `/resume <id>` | 不发列表请求；切换成功；`/session` 显示新 id |
| S3 运行中拒绝 | 触发一个长任务后 `/resume` | 输出拒绝提示；无退订/重订阅帧 |
| S4 草稿切换 | 打开后不发消息，直接 `/resume <id>` → 发消息 | 无 `POST /sessions`（草稿未落库，切换后不再创建）；消息发到切换后的会话；不产生空白会话 |
| S5 退出回归 | 切换后 Ctrl+D | 无新增空白会话；旧会话已 `read` |

> 冒烟注意：`MAO_BASE_URL` / `MAO_TOKEN` 是云端 shell 的既有环境变量，跑 mock 时必须 `env -u` 隔离，否则请求会打到生产（本次 0.0.457 验证时踩过，已清理误建会话）。

## 7. 兼容性与发布

- **纯客户端**：复用既有 `GET /sessions`、`GET /sessions/:id`、`PUT /sessions/:id/read`，无新接口、无迁移、无配置项。
- **老服务端兼容**：接口均已在生产使用（`ls` / `resume` 同源），无版本门槛。
- **回滚**：新命令为增量；出问题可回退 CLI 版本，服务端零感知。
- **文档**：`skills/mao-cli/reference/mao-agent.md`（斜杠命令表 + 交互 REPL 小节 + `/session` 文案）、`CHANGELOG.md` 顶部新版本（实施时按当时的下一版本号；截至本方案定稿远程已到 `0.0.458`）。
- **发布**：按本工作区既有流程——改完本地验证（typecheck / build / test / 冒烟）→ 用户确认 → 提交 push `origin/main`（是否部署另行确认）。

## 8. 已确认事项（2026-11-06 评审结论：按建议定案）

| # | 事项 | 结论 | 备注 |
|---|---|---|---|
| Q1 | 命令名与形态 | `/resume`（无参面板、数字直切、关键词搜索） | 与 `mao-agent resume` 同词 |
| Q2 | 跨模式切换 | 首版禁止，提示另开进程 | D2 生效 |
| Q3 | LOCAL workspace 边界 | 只允许「启动工作区或其内部」，越界不列出 | D3 生效；与本地信任边界一致 |
| Q4 | 运行中会话 | 允许切换并自动续接；`--if-running=fail` 时拒绝 | D4 生效 |
| Q5 | 切换可见反馈 | 不清屏 + 分隔行 + 最近 3 轮摘要 | D5 生效；清屏增强不做 |
| Q6 | 关键词搜索 | 首版包含（按标题匹配） | D12 生效 |
| Q7 | 面板数字快选 | 首版不做 | 后续有需要再评估 |
| Q8 | 面板条数 / 窗口 | 20 条 / 8 行 | `RESUME_PICK_LIMIT = 20` |

> 评审时间：2026-11-06；形式：飞书对话（「按你的建议来决策」）。实施状态：未开始（另行确认后开发）。

## 9. 实施清单（文件级）

| 文件 | 改动 | 预估行数 |
|---|---|---|
| `agent-cli/src/session/session-runner.ts` | 新增 `switchTo()`（状态重置 + 退订/已读 + 回滚） | +55 |
| `agent-cli/src/commands/chat.ts` | `filterSwitchableSessions` / `listSwitchableSessions` / `switchSession`；`modelId` 改 `let`、缓存 models；注入 ReplOptions | +130 |
| `agent-cli/src/repl/repl.ts` | `/resume` 分发；抽取 `resumeActiveRun`；`/session` 文案 | +90 |
| `agent-cli/src/ui/slash-complete.ts` | `SLASH_ITEMS` 增加 `resume` | +3 |
| `agent-cli/src/tui/modal-controller.ts` | `SessionPickController` | +80 |
| `agent-cli/src/tui/types.ts` | `PanelView.kind` + `SessionPickViewState` | +15 |
| `agent-cli/src/tui/ink-renderer.ts` | `pickSession` + `ModalEntry` + `buildSessionPickPanel` | +70 |
| `agent-cli/test/*` | 3 个新 spec + `session-defer` 回归增补 | +350 |
| `skills/mao-cli/reference/mao-agent.md` + `CHANGELOG.md` | 文档与发版说明 | +40 |

合计约 **830 行**（含测试），全部在 `agent-cli` 与文档内；**不改后端、不改数据库、不改桌面端**。

## 10. 已知限制（首版）

1. **不跨模式**：LOCAL 进程看不到也切不到 CLOUD 会话（反之亦然），提示另开进程。
2. **不跨工作区**：LOCAL 进程只能切到启动工作区内的会话。
3. **banner 不重绘**：切换后旧 banner 仍留在 scrollback 顶部，靠分隔行澄清；清屏方案留待后续。
4. **不做会话管理**：重命名 / 删除 / 归档仍走 `mao` CLI 或桌面端。
5. **切到别的设备正在跑的 LOCAL 会话**：能看到输出并等待，但该会话的审批/提问需要原设备处理（CLI 不代为操作）；若用户需要接管，应在同一工作区用 `resume` 重开。
6. **不同 Agent / 子目录 workspace**：切换生效的是会话自身绑定的 Agent；但 `agentsMdContent` 与 `localSkills` 仍来自本进程启动目录（与「同一进程只绑定一个工作区」的既有设计一致），不会按新会话的 workspace 重新读取。

