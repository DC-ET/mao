# 用户运行时容器隔离（docker 模式）代码审查 — round-03（round-02 复审 + b89c9c25）

- **日期**：2026-10-14
- **基线**：`main @ 91d4f944` → 审查对象 `feature/user-runtime-container-isolation @ b89c9c25`（工作区 `mao/.worktrees/user-runtime-isolation`；共四个提交：`f75b366c` 功能本体 + `a3b7422b` round-01 修复 + `6c878300` round-02 修复 + `b89c9c25` 陈旧条目防护）
- **性质**：本文是对 `docs/code-review/2026-10-14-container-isolation-round-02.md` 的**复审**：逐条核对 N-1 / N-2 / N-3 的修复是否真正闭合（含独立回退验证），审查 `b89c9c25` 防护是否还有遗漏窗口，并检查 N-2 修复本身是否引入新问题。
- **范围**：`git diff 91d4f944..HEAD` 的全部功能逻辑变更（重点 `6c878300` 与 `b89c9c25`）。不含文档变更。
- **方法**：① 通读四个提交全量 diff 与全部新增回归 spec；② **独立回退验证（两轮）**——在 `a3b7422b`（round-02 修复前）临时 worktree 运行 HEAD 的回归 spec 确认 N-1/N-2/N-3 回退后复现，在 `6c878300`（b89c9c25 前）运行确认陈旧条目防护是承重的；③ 对复审中新发现的 4 个问题各写可运行测试证明真实存在；④ 对任务指定的 6 个风险点逐一写测试验证或推翻；⑤ 全量 `npm test` + `npm run build`。审查期间未修改任何源码/测试（临时验证 spec 用后即删，`git status` 干净）。

---

## 结论概览

- round-02 的 **N-1 / N-2 / N-3 三项修复全部闭合**，代码路径完整、边界情况处理到位，且均带回退可失败的回归测试（独立回退验证见 §一）。
- `b89c9c25` 的陈旧条目防护**是承重的且方向正确**（回退后回归测试失败，见 §二）；`reapExpired` 快照迭代与 `stopAllForShutdown` 两条路径被该防护覆盖，无遗漏；但**防护本身只补了 `stopContainer` 一处，`dockerStart` 失败清理路径存在同类遗漏窗口（N-4c）**。
- N-2 修复引入了新的并发面：**recycle 路径没有按用户串行化**，与 `ensureRunning` 的 `creating` 合并、`dockerStart` 失败清理互相竞态，实测复现 3 个缺陷（**N-4a / N-4b / N-4c**）。
- 另发现 **N-5**：`planSessionWorkspace` 只做结构校验不做归属校验，而 `session.workspace` 是用户可控且建会话时原样落库的，docker 模式下可把**其他用户的飞书私聊工作区挂进自己容器（rw）**——round-02 报告中"私聊工作区天然不会进入他人容器"的假设不成立。
- **结论：不通过复审。** 需修复 N-4a / N-4b / N-4c（并发 recycle 串行化）与 N-5（归属校验）后方可合入。

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| N-4a | 高 | container-registry | idle 回收后两个不同通道工作区并发 `ensureRunning`：双重 stop/rm -f + `docker run` 同名冲突被静默合并，最终在册条目的挂载集合与真实容器不符（丢一个工作区），下次调用再触发完整重建（抖动） |
| N-4b | 高 | container-registry | 创建期两个不同通道工作区并发：后到者的 recycle 把先到者刚建好的容器 stop + rm -f，先到者拿到已被销毁的陈旧条目（`startedAtMs`/`mountedPaths` 全部错位） |
| N-4c | 中 | container-registry | `dockerStart` 失败清理（`entries.delete` + `rm -f` 按容器名）无条目身份校验，会把并发 recycle 刚建好的新容器删掉、把在册新条目删掉 |
| N-5 | 高 | container-mount-planner + session | `planSessionWorkspace` 结构校验不含归属校验；`session.workspace` 用户可控且建会话时零校验，可把 `{workspaceRoot}/feishu-chat/{bot}/private-{他人 userId}` 挂进本人容器（rw），构成跨用户读写 |

---

## 一、N-1 / N-2 / N-3 修复核对表（含独立回退验证）

**独立回退验证方法**：在 `a3b7422b`（即 round-02 三项修复之前）建临时 worktree（`node_modules` 软链），把 HEAD 的 5 个相关回归 spec 拷入运行。结果：**`Tests 10 failed | 22 passed (32)`**，失败项与 round-02 三项缺陷一一对应；验证后 worktree 已删除。

| round-02 | 修复位置（file:line） | 代码路径闭合？ | 回归测试 | 回退后失败证据（a3b7422b） | 结论 |
| --- | --- | --- | --- | --- | --- |
| N-1（deps bin 重复前置） | `harness/shell/shell-session-manager.ts:746-761`（`applyDepsEnv`：base 先按 `path.delimiter` 切段并剔除空段与 `depsBin` 本身，再前置一份；`kept` 为空时回落 `DEFAULT_CHILD_PATH`） | 是。`createSession` 首注（base=`env.PATH`）与 `refreshUserEnvironment` 每 exec（base=`session.currentPath` 已含 depsBin）都归一为"恰好一份"；host 模式无 `depsEnvProvider` 行为零变化 | `shell-session-manager.spec.ts` `keepsDepsBinIdempotent…`（6 次 exec 计数恒为 1） | 计数变为 `[2,3,4,5,6,7]`（即 round-02 报告的复现值） | 修复 |
| N-2（通道工作区不挂载） | 新增 `container/channel-workspace.ts`（`FEISHU_CHAT_DIR`/`DINGTALK_CHAT_DIR`/`channelWorkspaceRoots`/`isChannelWorkspace` 两侧同源常量）；`container-mount-planner.ts:59-79`（`plan(userId, extraWorkspaces)` + 去重）、`:90-104`（`planSessionWorkspace` 结构校验）、`:139-147`（`assertSafe` 对 `sessionWorkspace` 的 userId 段豁免）；`container-registry.ts:145-248`（`ensureRunning(requiredWorkspace)` / `sessionWorkspaces` / `isMounted` / `ensureWorkspaceMounted` recycle）；`docker-tool-router.ts:76,82,110`（dispatch / ensureReady / readBytes 传工作区）；`create-app.ts:1027-1036`（`sessionWorkspacesOf` DB 注入）、`:1090`（pty cwd）、`:1115`（预热） | 是。四个入口（工具派发、read_bytes、pty cwd、预热）都带上工作区；未挂载且非通道工作区明确抛错不静默；挂载集合只随完整重建增长，`assertSafe` 仍挡住通道根/账号目录级挂载与符号链接逃逸 | `channel-workspace.spec.ts`、`container-mount-planner.spec.ts`（挂载/拒绝）、`container-registry.spec.ts`（挂载/recycle/明确报错）、`docker-tool-router.spec.ts`（dispatch/readBytes） | `channel-workspace.spec.ts` 收集期失败（模块不存在）；planner 挂载断言 `expected false to be true`；registry recycle / 明确报错用例失败；router 两例失败 | 修复 |
| N-3（dockerStart 毒化条目） | `container-registry.ts:379-389`（`dockerStart` 的 `waitSocketReady` 失败时 `entries.delete` + `cleanupHalfCreated` 后重抛，与 `createAndStart` 同口径） | 是。失败后条目不残留，下次 `ensureRunning` 走完整重建（新容器带新 agent），根因未除也每次都有自愈机会 | `container-registry.spec.ts` `doesNotPoisonEntryWhenRestartSocketNeverReady` | 回退后条目固化为 `state='running'` 且无任何 docker 调用即被复用 | 修复 |

补充核对（非回归测试覆盖、代码走查确认）：

- N-2 的 web 会话（`{workspaceRoot}/{userId}/…`）命中标准清单，`planSessionWorkspace` 返回 null，不会触发重建——已由 planner spec 的 null 分支覆盖。
- N-2 的 recycle 代价（旧容器内 shell/pty/在途任务丢失）在 `ensureRunning` 注释中显式声明，且仅在首次用到新通道工作区时发生一次；pty hub 按 `startedAtMs` 换世代后旧 hub dispose、在飞 pty 按 -1 收尾（见 §四复查项 1）。
- N-1 的 `applyDepsEnv` 同时剔除空段，`PATH` 形态被归一（无害）。

---

## 二、b89c9c25 陈旧条目防护审查

**修复内容**（`container-registry.ts:394-416`）：`stopContainer` 在 `requestShutdown` 通知前后各做一次 `isStaleEntry(entry)` 校验（`entries.get(userId) === entry` 则为新，否则跳过并告警）。针对的竞态：idle 回收执行 `stopContainer` 期间，条目已被 recycle 替换成同容器名（`mao-user-{userId}`）的新容器，旧条目的 `docker stop` 会按容器名误伤新容器。

**承重性验证（独立回退）**：在 `6c878300`（b89c9c25 之前）临时 worktree 运行 HEAD 的 `container-registry.spec.ts` → **仅 `doesNotStopReplacementContainerWhenStaleEntryIsReaped` 一条失败**（`expected 5 to be less than 4`：去掉后置校验后，陈旧条目的 `stop -t 10` 落在重建的 `run -d` 之后）。这同时证明 6c878300 的三项修复在 b89c9c25 之前是自洽的，该防护确为必需。

**遗漏窗口排查（任务指定）**：

| 路径 | 是否有遗漏窗口 | 分析 |
| --- | --- | --- |
| `reapExpired` 快照迭代（`:286-…`） | 无 | 巡检前 `[...this.entries.values()]` 快照，逐条 `stopContainer`；期间发生的 recycle 替换条目后，旧条目的 stop 被 `isStaleEntry` 拦截（正是回归测试的场景）。快照外的新条目本轮不处理，下一轮巡检兜底，无功能性影响 |
| `stopAllForShutdown`（`:275-279`） | 无实质风险 | 同样走 `stopContainer`；关闭期间理论上仍有在途 recycle 可能留下一个未停容器，但 `scripts/container-gc.sh`（按 `mao.runtime=user` label 清理）会兜底，属可接受残留 |
| `dockerStart` 失败清理（`:386-388`） | **有遗漏 → N-4c** | 该 catch 里 `this.entries.delete(entry.userId)` 与 `cleanupHalfCreated(entry.containerName)` 都**没有条目身份校验**：若失败等待期间并发 recycle 已建好新容器并登记新条目，这里会把新条目删掉、并按同容器名 `rm -f` 把新容器删掉。已写测试复现（见 N-4c） |
| recycle 与 idle 回收互相触发 | 无（在已覆盖范围内） | recycle 内部先 `stopContainer`（带校验）再重建；idle 回收看到的要么是旧条目（被拦截）要么是新条目（正常计时） |

结论：b89c9c25 的防护方向正确、位置必要，但只覆盖了 `stopContainer` 一个副作用点；**按容器名操作的 `cleanupHalfCreated` 与按 userId 操作的 `entries.delete` 在其余失败路径上仍是同样的缺口**（N-4c，且 N-4a/N-4b 表明缺口比想象的更宽）。

---

## 三、复审新发现

### N-4a【高】idle 回收后两个通道工作区并发 `ensureRunning`：挂载集合丢一个 + 反复重建

**位置**：`harness/container/container-registry.ts:159-171`（stopped 分支：并发双双走 `dockerStart` 后各自进入 `ensureWorkspaceMounted`）、`:224-248`（`ensureWorkspaceMounted` 的 recycle：`stopContainer` → `cleanupHalfCreated`（按容器名 rm -f）→ `entries.delete` → `createAndStart`）、`:337-346`（`docker run` 同名冲突时静默合并）、`:146-152`（`creating` 合并只覆盖创建期，不覆盖 recycle）。

**问题描述**

容器处于 `stopped`（idle 回收后）时，两个不同飞书群会话（wsA / wsB）的工具调用并发到达（`sessionWorkspacesOf` 查询失败/返回空时 `desired=[]`，两个调用方都判"无需重建"而走 `dockerStart`）。随后两者都发现自己的工作区未挂载，各自执行 recycle：

1. 两者的 `stopContainer(entry)` 在对方 delete 之前都通过 `isStaleEntry`（在册条目仍是同一个）→ **同一容器被 stop 两次**；
2. 两者的 `cleanupHalfCreated('mao-user-7')` 都执行 → **同一容器被 rm -f 两次**；
3. 先者的 `run -d` 建成只挂 wsA 的容器；后者的 `run -d` 撞同名，被 `:342-345` 的 "already in use" 分支**静默吞掉**，却仍然把"挂载集合 = [wsB]"的条目登记为就绪。

终态：**在册条目声称挂了 wsB，真实容器只挂了 wsA**。会话 A 的下一次调用发现 wsA 未挂载 → 再触发一次完整重建（每次在两个群之间交替使用的会话都重建一次容器，容器内 shell/pty/在途任务全部丢失）。实测 docker 调用序列 `[start, start, stop, stop, rm -f, rm -f, run -d, run -d]`，最终 `sessionWorkspaces=[wsB]`（缺 wsA），再次调用 wsA 触发第 3 次 `run -d`。

**复现/验证方式**（对当前代码失败即证明存在）

```ts
it('N-4a: idle 回收后并发两个通道工作区，最终挂载集合丢一个（反复重建）', async () => {
  const base = useTmpDir('mao-r3-race-a-');
  const log: string[] = [];
  // sessionWorkspacesOf 返回 []（DB 查询失败/无会话行的降级形态）
  const registry = makeRegistry(base, log, []);
  const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
  const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
  mkdirSync(wsA, { recursive: true }); mkdirSync(wsB, { recursive: true });

  await registry.ensureRunning(7);
  registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
  await registry.reapExpired();                       // → stopped

  log.length = 0;
  await Promise.all([registry.ensureRunning(7, wsA), registry.ensureRunning(7, wsB)]);
  console.log('ORDER=', log.filter((l) => /^(run -d|rm -f|stop -t 10|start )/.test(l))
    .map((l) => l.split(' ').slice(0, 2).join(' ')));
  // 实测 ["start","start","stop","stop","rm -f","rm -f","run -d","run -d"]，
  // FINAL sessionWorkspaces = [wsB]（wsA 丢失：真实容器只挂了 wsA）
  expect(registry.getEntry(7)!.mountedPaths.has(wsA)).toBe(true);   // 实际 false
  expect(registry.getEntry(7)!.mountedPaths.has(wsB)).toBe(true);

  log.length = 0;
  await registry.ensureRunning(7, wsA);               // wsA 又"未挂载" → 再次完整重建
  expect(log.filter((l) => l.startsWith('run -d')).length).toBe(0); // 实际 1（抖动）
});
```

（`makeRegistry` 为审查用辅助函数：标准 roots + `fakeDocker(log)` + `sessionWorkspacesOf: async () => []`，`waitSocketReady` 立即成功。）

**建议修复方向**：recycle 与 `ensureRunning` 的全部分支按 userId 串行化（每用户 promise 链/mutex，`creating` 合并扩展为"进行中的创建或重建"合并）；recycle 重建后必须校验在册条目是否仍为自己所建（身份校验失败即说明被并发替换，直接返回在册条目或重试），从结构上消除"双重 stop/rm -f"与"同名冲突静默合并出不实条目"。

---

### N-4b【高】创建期两个通道工作区并发：先到调用方拿到已被 stop + rm -f 的陈旧条目

**位置**：`container-registry.ts:146-152`（`creating` 合并：后到者 await 先到者的创建 promise 后进入 `ensureWorkspaceMounted`）、`:234-239`（recycle 的 `stopContainer(entry, {force:true})` + `cleanupHalfCreated`）。

**问题描述**

两个通道会话在容器不存在时并发首调：调用方 A 建容器（挂 wsA）并登记 entryA；调用方 B 合并进同一次创建（`await inFlight`）后发现自己要的 wsB 没挂，走 recycle——此时 `isStaleEntry(entryA)` 为 false（entryA 刚登记），于是 **B 把 A 刚建好的容器 stop 掉、rm -f 掉**，再建一个挂了 [wsA, wsB] 的新容器登记 entryB。终态：在册条目（entryB）与真实容器一致，但**调用方 A 拿到的是 entryA——其容器已被停止并删除**，`startedAtMs`/`lastUsedAtMs`/`mountedPaths` 与在册容器全部错位（A 后续的 pty hub 世代判断、挂载判断、idle 保鲜都基于错误状态）。实测 docker 序列 `[run -d, stop -t 10, rm -f, run -d]`，`getEntry(7)` 既不等于 A 的返回值也不等于 B 的返回值。

**复现/验证方式**（对当前代码失败即证明存在）

```ts
it('N-4b: 创建期并发两个通道工作区，先到的调用方拿到已被停止的条目', async () => {
  const base = useTmpDir('mao-r3-race-b-');
  const log: string[] = [];
  const registry = makeRegistry(base, log, []);
  const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
  const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
  mkdirSync(wsA, { recursive: true }); mkdirSync(wsB, { recursive: true });

  log.length = 0;
  const [a, b] = await Promise.all([registry.ensureRunning(7, wsA), registry.ensureRunning(7, wsB)]);
  console.log('B_ORDER=', log.filter((l) => /^(run -d|rm -f|stop -t 10)/.test(l))
    .map((l) => l.split(' ').slice(0, 2).join(' ')));
  // 实测 ["run -d","stop -t 10","rm -f","run -d"]；B_FINAL = [wsA, wsB]
  expect(registry.getEntry(7)).toBe(a);   // 实际 false（a 的容器已被 B 的 recycle 删掉）
  expect(registry.getEntry(7)).toBe(b);   // 实际 true
});
```

**建议修复方向**：同 N-4a（按用户串行化）。串行化后 B 会看到 A 已登记且只缺 wsB 的条目，走"保留既有挂载、增量并入 wsB"的单次 recycle，A/B 拿到同一条目。

---

### N-4c【中】`dockerStart` 失败清理无身份校验，删掉并发 recycle 刚建好的新容器

**位置**：`container-registry.ts:379-389`（`dockerStart` catch：`this.entries.delete(entry.userId)` + `await this.cleanupHalfCreated(entry.containerName)`——两者都不校验当前在册条目是否还是 `entry`）。这正是 `b89c9c25` 在 `stopContainer` 里防同一类误伤、但漏掉的下一个副作用点（§二）。

**问题描述**

idle 回收后重启：`dockerStart` 已把 `docker start` 发出去，正在 `waitSocketReady`。此时另一会话（飞书群 B）的首个工具调用触发 recycle：停旧容器、rm -f、`run -d` 建新容器并登记新条目。随后旧路径的 `waitSocketReady` 超时抛错 → catch 里 `entries.delete(7)` **把刚登记的健康新条目删掉**，`cleanupHalfCreated('mao-user-7')` **把刚建好的新容器 rm -f 掉**。终态：注册表里该用户没有任何条目（自愈要靠下次调用完整重建，但本次 recycle 的全部工作、以及可能已连上新容器 agent 的连接/pty 都被浪费/打断）。实测 docker 序列 `[start, stop -t 10, rm -f, run -d, rm -f]`（最后一次 `rm -f` 在最后一次 `run -d` **之后**），`getEntry(7)` 为 null。

**复现/验证方式**（对当前代码失败即证明存在）

```ts
it('N-4c: dockerStart 失败清理会 rm -f 掉并发 recycle 刚建好的新容器', async () => {
  const base = useTmpDir('mao-r3-dstart-');
  /* …标准 roots… */
  const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
  mkdirSync(wsB, { recursive: true });
  let armed = false, fired = false;
  const registry = new ContainerRegistry({ /* config: startTimeoutMs 1000 … */
    waitSocketReady: async () => {
      if (!armed) return;                 // 初始创建放行
      if (fired) return; fired = true;
      await registry!.ensureRunning(7, wsB);   // 重启等待期间：群 B 触发 recycle 重建
      throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
    },
    sessionWorkspacesOf: async () => [],
  }, fakeDocker(log));

  await registry.ensureRunning(7);
  registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
  await registry.reapExpired();                     // → stopped
  armed = true;

  log.length = 0;
  await expect(registry.ensureRunning(7)).rejects.toThrow(/连接超时/);
  console.log('C_ORDER=', log.filter((l) => /^(run -d|rm -f|stop -t 10|start )/.test(l))
    .map((l) => l.split(' ').slice(0, 2).join(' ')));
  // 实测 ["start","stop -t 10","rm -f","run -d","rm -f"]，C_ENTRY = null
  const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
  const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
  expect(lastRm).toBeLessThan(lastRun);                       // 实际 false（rm 在 run 后）
  expect(registry.getEntry(7)?.mountedPaths.has(wsB)).toBe(true); // 实际条目已丢失
});
```

**建议修复方向**：失败清理前做身份校验（`this.entries.get(entry.userId) === entry` 才 delete / rm -f；已被替换时只清理自己那半成品且不得触碰在册容器），或与 N-4a 统一的按用户串行化一并解决（串行化后 `dockerStart` 失败等待期间不可能插入 recycle）。

---

### N-5【高】`planSessionWorkspace` 无归属校验 + `session.workspace` 用户可控：可把其他用户私聊工作区挂进本人容器（rw）

**位置**

- 挂载侧：`container-mount-planner.ts:90-104`（`planSessionWorkspace`：只校验"位于通道工作区根下且为 `{account}/{leaf}` 两级以上"，**不校验归属**）、`:139-147`（`assertSafe` 对 `sessionWorkspace` 豁免 userId 段规则，注释 `:20-23` 明示"归属由调用方按数据库 user_id 过滤保证"）
- 归属唯一依赖点：`create-app.ts:1027-1036`（`sessionWorkspacesOf` = `listWorkspacesByUser(userId)` 的 SQL user_id 过滤）
- 被绕过的入口：`session.routes.ts:62,147`（建会话接受 `workspace?: string | null` 并原样下传）→ `session.service.ts:140-141`（CLOUD 分支 `session.workspace = workspace`，**无 `assertUnderUserSandbox` 等任何校验**；`assertUnderUserSandbox` 只在 `CloudWorkspaceResolver.resolveProjectWorkspace` 对生成路径生效）→ `harness-service.ts`/`agent-loop.ts` 把 `session.workspace` 放进 envelope → `docker-tool-router.ts:82`（`ensureRunning(ctx.userId, ctx.workspace)`，requiredWorkspace 来自会话而非 DB 过滤结果）

**问题描述**

`ContainerMount` 注释声称"私聊工作区（`private-{userId}`）只出现在该用户自己的会话里，天然不会进入他人容器"——这个假设的前提是**会话工作区只能由平台生成**。但建会话 API 对 `workspace` 零校验、原样落库，而 `ensureRunning` 的 `requiredWorkspace` 直接取自会话字段。因此 docker 模式用户只要 POST 一个 `workspace = {workspaceRoot}/feishu-chat/{botId}/private-{他人 userId}` 的会话（路径可预测：botId 可见、userId 递增），该目录就会以 **rw** 挂进此人自己的容器——跨用户读写在容器内完成，宿主机的每用户沙箱/挂载边界对此完全放行。群聊工作区（`{account}/{leaf}` 中 leaf 为 chatId）同理会话即可挂载，虽为设计内共享，但"任意路径可挂"本身已超出设计假设。

**复现/验证方式**（对当前代码不抛错即证明存在）

```ts
it('N-5: 通道工作区结构校验只认 {account}/{leaf}，但不校验归属', () => {
  const base = useTmpDir('mao-r3-own-');
  const roots = { /* 标准 roots */ };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  mkdirSync(join(roots.workspaceRoot, '7'), { recursive: true });
  // 另一个 mao 用户（8）的飞书私聊工作区
  const otherPrivate = join(roots.workspaceRoot, 'feishu-chat', 'bot-1', 'private-8');
  mkdirSync(otherPrivate, { recursive: true });
  writeFileSync(join(otherPrivate, 'secret.txt'), 'foreign');

  const planner = new ContainerMountPlanner(roots);
  // 期望：非本人会话工作区不得进入本人容器挂载清单
  expect(() => planner.plan(7, [otherPrivate])).toThrow();   // 实际不抛错，正常生成 rw 挂载
});
```

**建议修复方向**（任一即可，建议 1+2 同做）：

1. 建会话/改会话时对 CLOUD 的 `workspace` 做归属校验：必须位于每用户根之下，或位于通道工作区根下且 leaf 与该用户的通道身份匹配（`private-{userId}` 或该用户参与群的 chatId 列表）；
2. `planSessionWorkspace` 增加归属参数（调用方 userId + 该工作区的归属用户），对 `private-{userId}` 叶子做本人校验，从挂载边界上再收一道（纵深防御，不依赖上游永远正确）。

---

## 四、重点复查项结论（round-02 报告风险点 + 任务指定）

| # | 复查项 | 结论 |
| --- | --- | --- |
| 1 | recycle 后 ptyChannelHubs 世代管理 | **正确**。create-app 按 `entry.startedAtMs` 判定世代（`create-app.ts:1089-1098`）：recycle 换 `startedAtMs` → 旧 hub dispose（在飞 pty 按 -1 收尾，`pty-bridge.ts:149-156`）、新 hub 绑新连接；recycle 由工具派发触发时旧 hub 不立即 dispose，但 hub 的 `currentConnection` 动态解析 + `onClosed` 20s 宽限兜底（`pty-bridge.ts:82-84,162-169`）。世代判断基于"调用方拿到的条目"，N-4b 的陈旧条目会在此错位一次（随 N-4b 修复自然消失） |
| 2 | `sessionWorkspacesOf` 的 DB 查询失败/超时/巨量工作区 | **失败/超时：可接受**（`container-registry.ts:197-201` catch → []，不阻塞创建，通道会话按明确报错失败；`create-app.ts:1028-1032` 同样 catch → []）。**巨量：无上限但实测无功能风险**——400 个通道工作区 → 408 条挂载 / 88,373 字符 docker 参数，`assertSafe` 逐条 existsSync/lstatSync 无异常，`execFile` 限制只约束 stdout 不约束 argv。建议后续加个上限（如 64）防异常数据把 `docker run` 参数撑爆，不构成本轮阻塞项 |
| 3 | 挂载集合只增不减（会话删除后残留） | **无实际问题**。挂载集合只在完整重建时按"当前存活会话"的 DB 查询重算（`sessionWorkspacesOf` 只查未删除会话），残留目录最多多一个空挂载点；容器内沙箱以 sessionWorkspace 为根，残留不影响功能与安全 |
| 4 | `planSessionWorkspace` 每用户根跳过逻辑被利用（符号链接 / `..` / 大小写 / 尾分隔符变体） | **结构上闭合，但归属不校验 → N-5**。`path.resolve` 归一化消除 `..`/尾分隔符；大小写变体在大小写敏感的 Linux 上落在通道根外被拒；符号链接由 `assertSafe` 的 realpath 校验挡住（实测：通道工作区内指向宿主机外文件的 symlink 被拒 "Path escape attempt (symlink)"） |
| 5 | 容器内沙箱（PathSandbox strict）与 sessionWorkspace 挂载的交互（BUG-11 收窄是否被绕过） | **按设计放行、无越权**。通道工作区下的相对路径经 `sessionWorkspace` 分支放行（功能必须）；不带 sessionWorkspace 提示的绝对路径仍被每用户沙箱拒绝（实测 "Path escape attempt"）。BUG-11 的每用户收窄在这条路径上不生效是 round-02 N-2 的既定设计（挂载即授权），真正的收口点是 N-5 的归属校验 |
| 6 | recycle 与 `creating` 并发合并 / idle 回收 `reapExpired` 的交互 | **有缺陷 → N-4a / N-4b / N-4c**（§三）。`creating` 合并只覆盖"创建中"，recycle 期间第二次并发调用会看到 `creating` 已被 `.finally` 清掉或持有旧 promise，双重 recycle 无互斥 |

---

## 五、验证环境与数据

- 全量后端测试：`cd backend-ts && npm test` → `Test Files 330 passed | 1 skipped (331)`、`Tests 4030 passed | 13 skipped (4043)`（退出码 0）；`npm run build`（`tsc -p tsconfig.build.json`）通过。
- 独立回退验证（两轮，worktree 用后即删、`git status` 干净）：
  - `a3b7422b` + HEAD 的 5 个回归 spec → `Tests 10 failed | 22 passed (32)`，失败项对应 N-1 / N-2 / N-3（§一）；
  - `6c878300` + HEAD 的 `container-registry.spec.ts` → 仅 `doesNotStopReplacementContainerWhenStaleEntryIsReaped` 失败（`expected 5 to be less than 4`），证明 b89c9c25 防护承重且 6c878300 三项修复自洽（§二）。
- 本报告 4 条新发现共 6 条验证用例（N-4a / N-4b / N-4c / N-5 / N-6 / N-7 / N-8，其中 N-6 沙箱交互、N-7 巨量工作区、N-8 符号链接逃逸为"验证通过"的反证用例），全部对当前代码复现了错误行为或确认了预期行为；审查期间未修改任何源码与测试文件，临时验证 spec 用后即删。
