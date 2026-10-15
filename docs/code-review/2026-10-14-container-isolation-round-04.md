# 用户运行时容器隔离（docker 模式）代码审查 — round-04（round-03 复审）

- **日期**：2026-10-14
- **基线**：`main @ 91d4f944` → 审查对象 `feature/user-runtime-container-isolation @ 07047984`（工作区 `mao/.worktrees/user-runtime-isolation`）
- **审查对象**：`git diff 91d4f944..HEAD` 全部功能逻辑变更，共六个提交：`f75b366c` 功能本体 + `a3b7422b` round-01 修复 + `6c878300` round-02 修复 + `b89c9c25` 陈旧条目防护 + `b01394a8` round-03 修复（重点）+ `07047984` 钉钉私聊归属校验补充。**注意：`07047984` 是审查期间作者追加的提交**（不在 round-04 任务描述的五提交之内），本报告已将其纳入，最终结论以 `07047984` 为准。
- **性质**：本文是对 `docs/code-review/2026-10-14-container-isolation-round-03.md` 的复审：核对 N-4a / N-4b / N-4c / N-5 的修复是否真正闭合、是否引入新问题。
- **方法**：① 通读 `b01394a8` 与 `07047984` 全量 diff 与全部新增回归 spec；② **用 round-03 报告的 7 条复现测试（N-4a/N-4b/N-4c/N-5/N-6/N-7/N-8）在当前 HEAD 复跑**——全部通过，独立证明四项缺陷闭合；③ 逐机制审查 `withUserLock` / `rebuildEntry` / `generation` / `dropFailedEntry` / 同名冲突重试 / idle 重建判定 / 建会话归属校验，并走查其余挂载入口；④ 对新发现的 2 个问题各写可运行测试证明真实存在（均对当前代码失败）；⑤ 全量 `npm test` + `npm run build` + `tsc --noEmit`。审查期间未修改任何源码/测试（临时验证 spec 用后即删，`git status` 干净）。

---

## 结论概览

- round-03 的 **N-4a / N-4b / N-4c / N-5 全部闭合**：round-03 报告的 7 条复现测试在当前 HEAD 全部通过（§一），作者的 6 条新回归测试在全量套件中通过；`b01394a8` 的每用户串行锁 + 原地更新条目 + 世代校验 + 失败清理身份校验的改造方向正确，未发现"修一半"。
- 审查期间作者追加 `07047984`（钉钉私聊 `p2p-{userId}` 叶子归属校验）——这与我在审查中独立定位到的同一缺口一致，该提交修复正确（已验证：他人 `p2p-9` 拒绝、本人 `p2p-7` 放行），原缺口已闭合。
- 复审新发现 **2 个 bug**：
  - **F-2【高】** `dockerStart` 的 `docker start` 失败不摘除条目：idle 回收后的容器被 `scripts/container-gc.sh`（本分支自带，按 `status=exited` 清理 `mao-user-*`）或 `docker container prune` 删掉后，`docker start` 报 "No such container"，条目永久卡在 `stopped`，该用户**所有工具调用永远失败、无自愈**，须重启后端才恢复。
  - **F-1【中】** `createAndStart` 的失败清理缺世代校验（`dockerStart` 有、`createAndStart` 没有）：经 `withUserLock` 的 ALS 重入机制（本提交明确设计并测试的场景）重入 recycle 后，外层失败会把并发方刚登记的新条目删掉、按同容器名 `rm -f` 把新容器删掉——N-4c 的同类误伤，只堵了 `dockerStart` 一条路径。
- **结论：不通过复审。** F-2 为生产必然路径（idle 回收 + GC 脚本）上的永久卡死，须修复后合入；F-1 建议同批修复（一行级改动）。

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| F-2 | 高 | container-registry | `dockerStart` 的 `docker start` 失败（容器已不存在）不摘除条目：条目卡死 `stopped`，后续每次 `ensureRunning` 同样失败、永不重建；idle 回收的 exited 容器会被本分支的 `container-gc.sh` 删掉，使该路径在生产必然可达 |
| F-1 | 中 | container-registry | `createAndStart` 失败清理只用对象身份校验（`dropFailedEntry`）+ 按容器名 `rm -f`：原地更新条目后身份恒等，重入 recycle 建成的新条目/新容器会被外层失败清理误删（`dockerStart` 已有世代校验，`createAndStart` 漏改） |

---

## 一、round-03 四项缺陷修复核对表

**独立验证方法**：把 round-03 报告中的 7 条复现测试（原样恢复为临时 spec）在**当前 HEAD `07047984`** 上运行 → **7 passed**。即 N-4a / N-4b / N-4c / N-5 报告中的错误终态（挂载集合丢一个、先到者拿到已删条目、重启超时误伤新容器、他人私聊工作区可挂载）在当前代码上全部不再复现。另核对作者的 6 条新回归测试在全量套件（330 文件 / 4036 用例）中通过。

| round-03 | 修复位置（file:line） | 闭合？ | 证据 |
| --- | --- | --- | --- |
| N-4a（idle 回收后并发 recycle：丢挂载 + 抖动） | `container-registry.ts:211-227`（`withUserLock` 每用户串行锁 + ALS 重入识别）、`:167-201`（`ensureRunningLocked` 全程持锁）、`:292-299`（`rebuildEntry`：停 → rm -f → `createAndStart(existing)` 原地更新）、`:426-437`（同名冲突清掉重试，不再吞） | 是。两个并发调用串行执行，后者只做一次"保留既有挂载、增量并入"的 recycle；条目挂载集合与真实容器一致，后续调用不再重建 | round-03 复现测试（并发两工作区 → 最终两者都在册 + 无再次 `run -d`）当前 HEAD 通过；作者回归 `serializesConcurrentRecyclesAfterIdleReap`（断言 docker 序列 `['rm -f','run -d','stop -t','rm -f','run -d']`） |
| N-4b（创建期并发：先到者拿到已删条目） | 同上（串行锁 + 原地更新：条目对象身份不变，`startedAtMs`/`mountedPaths` 不再错位） | 是。两个调用方拿到同一条目且等于在册条目 | round-03 复现测试（`getEntry(7) === a === b`、两者工作区都在册）当前 HEAD 通过；作者回归 `serializesConcurrentCreateForDifferentChannelWorkspaces` |
| N-4c（dockerStart 失败清理误伤新容器） | `:476-500`（`dockerStart` 捕获 `waitSocketReady` 失败后 `isLive(entry, generation)` 校验才 `entries.delete` + `cleanupHalfCreated`）、`:523-529`（`isLive` = 在册且世代未变） | 是（dockerStart 路径）。并发 recycle 重建后世代 +1，旧路径超时清理被跳过，新容器与新条目存活 | round-03 复现测试（最后一次 `rm -f` 早于最后一次 `run -d`、wsB 仍在册）当前 HEAD 通过；作者回归 `keepsRecycledContainerWhenConcurrentRestartTimesOut`。**但 `createAndStart` 的失败清理没有同等校验 → F-1** |
| N-5（会话工作区归属） | `session.routes.ts:146,603-620`（`assertOwnedSessionWorkspace`：CLOUD workspace 必须在 `{workspaceRoot}/{userId}` 之下）、`container-mount-planner.ts:111-118`（私聊叶子 `private-{userId}` 归属校验）、`07047984`（补 `p2p-{userId}` 钉钉私聊） | 是。用户自建会话无法再指定他人通道工作区；挂载边界对私聊叶子做纵深防御 | round-03 复现测试（`planner.plan(7, [private-8])` 抛错）当前 HEAD 通过；作者回归 `rejectsPrivateChannelWorkspaceOfAnotherUser`、`accepts cloud workspace under own root and rejects foreign channel workspaces`；我另写 `p2p` 用例验证 `07047984`（他人 `p2p-9` 拒绝 / 本人 `p2p-7` 放行）通过 |

**N-5 补充走查（无专门测试、代码核对确认闭合）**：

- `session.workspace` 的唯一用户可控入口是 `POST /v1/sessions`：`PATCH /v1/sessions/:id` 只改 title/summary/projectKey/permissionLevel/modelId 等，**不含 workspace**；`session.service.ts` 仅在 `createSession` 内赋值（`:141/:148/:152`），无更新路径；`session.repository` 无 workspace 更新 SQL。
- 其余 `createSession` 调用方均为内部可信路径：飞书入站（`create-app.ts:1762`）、钉钉入站（`dingtalk/runtime.ts:109-118`，workspace 由 chat 上下文推导且 leaf 与会话 userId 同人）、微信（`weixin/session.service.ts:60`，传 null）、open-api（`openapi/open-run.service.ts:121`，不传 workspace，由 `CloudWorkspaceResolver` 在每用户根下生成）、delegate（`delegate-tool.ts:95`，继承父会话工作区，同用户）。
- 非 CLOUD 会话的工作区不会经工具派发/终端进入挂载判定：`tool-dispatcher.ts:263` 的 `executionMode === 'LOCAL'` 分支在 docker 分支（`:339`）之前全部 return；`terminal.routes.ts:48` 要求会话为 CLOUD。（`send_file` 的 `readBytes` 入口是唯一不校验 executionMode 的挂载入口，见观察 O-4。）
- 三方根路径一致：`session.routes` 的 `pathSandbox` = `new PathSandbox(cfg.app.harness.workspaceRoot)`（`create-app.ts:723`）= `ContainerRegistry` 的 `workspaceRoot`（`create-app.ts:1004`），`getWorkspaceRoot()` 原样返回该根，归属校验与挂载边界同基。

---

## 二、b01394a8 机制逐项审查

| 机制 | 审查结论 |
| --- | --- |
| `withUserLock` 每用户串行锁（`:211-227`） | 正确。链式占位（`.then(section, section)`）保证单个 section 失败不污染后续排队者；ALS 重入识别避免 `requestShutdown`/`waitSocketReady` 回调内同步触发 `ensureRunning` 时自死锁（作者 N-4c 回归测试即构造该重入）。未发现跨用户嵌套加锁，无死锁面 |
| `rebuildEntry` 原地更新（`:292-299`） | 正确。条目对象身份不变 → 并发句柄不错位（N-4b 闭合）；停旧容器后先 `rm -f` 再 `docker run`，消除 connectionDead 重建的同名冲突（作者回归 `removesStoppedContainerBeforeRebuildAndRecoversFromNameConflict` 验证"清掉重试一次"） |
| 同名冲突不再吞（`:426-437`） | 正确。残留容器清掉后重试一次，重试仍失败才抛错并摘条目；不会再登记出"挂载集合与真实容器不符"的条目 |
| `generation` 世代校验 | `dockerStart`（`:492`）与 `stopContainer`（`:509/:514`，requestShutdown 前后各一次）均已按世代校验；**`createAndStart` 的失败清理只用对象身份 → F-1** |
| `dropFailedEntry`（`:470-474`） | 对"新条目被并发方登记"有效；但原地更新语义下对象身份恒等，对"重入 recycle 后同一条目被重建"无效（F-1 根因） |
| idle 回收后 `requiredWorkspace` 参与重建判定（`:181-191`） | 正确，去掉一次无用的 `docker start`；`reapExpired` 锁内复核 state/busy/时间戳有效 |
| `reapExpired` 锁内 `entries.get(userId) !== entry` 复核（`:348`） | 原地更新语义下永假（死代码），无害；实际保护由 state/busy/时间戳复核提供（观察 O-3） |
| `createAndStart` 原地重建不重置 `inContainer` | 新容器 agent 握手后立即补报 `runtime_status`（`runtime-agent.ts:170-171`），陈旧忙计数窗口仅为重连时间，无实际影响（观察 O-2） |

---

## 三、复审新发现

### F-2【高】`dockerStart` 的 `docker start` 失败不摘除条目：用户容器运行时永久卡死

**位置**：`harness/container/container-registry.ts:476-500`（`dockerStart`：`await this.docker.run(['start', entry.containerName], 30_000)` 无 try/catch，失败直接抛出；对照 `createAndStart` 的失败路径 `:435-441,444-452` 有 `dropFailedEntry` + `cleanupHalfCreated` 自愈）。

**问题描述**

`ensureRunningLocked` 对 `state==='stopped' && !connectionDead` 的条目走 `dockerStart`（idle 回收后即此状态）。若此时容器已不存在——**`scripts/container-gc.sh`（本分支自带，设计文档 §6 要求 cron/systemd timer 周期执行）按 `--filter status=exited` 清理 `mao-user-*` 容器，而 idle 回收的 `docker stop` 产生的正是 exited 容器**；`docker container prune` 等运维动作同样如此——`docker start` 抛 "No such container"：

1. 错误直接从 `dockerStart` → `ensureRunningLocked` → `ensureRunning` 抛出（dispatch 侧转为"容器执行环境不可用：…No such container"回传给模型）；
2. 条目停留在 `state='stopped'`、`connectionDead=false`、`mountedPaths` 还是旧集合；
3. 此后每次 `ensureRunning`：`reapExpired` 跳过（非 running）、`hasUnmountedWorkspace` 为 false（DB 里的通道工作区都还在旧 `mountedPaths` 里）→ 再次 `dockerStart` → 再次同样失败。**无自愈、无重建，永久卡死**，只有重启后端（清空内存 entries）或该用户新建一个通道会话（触发 `rebuildEntry`）才可能恢复；
4. 对照：`createAndStart` 的 `docker run` 失败会 `dropFailedEntry` + `cleanupHalfCreated`，下次调用完整重建——两条路径口径不一致。

**复现/验证方式**（对当前代码失败即证明存在）

```ts
it('F-2: dockerStart 的 docker start 失败（容器已被删除）后条目卡死 stopped，无自愈', async () => {
  const base = useTmpDir('mao-r4-dstart-missing-');
  const log: string[] = [];
  const inner = fakeDocker(log);
  let startFails = false;
  const registry = makeRegistry(base, log, {}, {
    async run(args) {
      if (args[0] === 'start' && startFails) {
        throw new Error('docker start failed: Error response from daemon: No such container: mao-user-7');
      }
      return inner.run(args);
    },
  });

  await registry.ensureRunning(7);
  registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
  await registry.reapExpired();                 // → stopped（容器 exited，仍被 Registry 跟踪）
  expect(registry.getEntry(7)?.state).toBe('stopped');

  startFails = true;                            // container-gc.sh / docker container prune 删掉 exited 容器
  log.length = 0;
  await expect(registry.ensureRunning(7)).rejects.toThrow(/No such container/);
  // 期望（正确行为，与 createAndStart 失败路径同口径）：docker start 失败即摘除条目，
  // 下次 ensureRunning 走完整 docker run 重建。实际：条目停留在 stopped
  expect(registry.getEntry(7)).toBeUndefined();   // 实测失败：expected { userId: 7, …(9) } to be undefined
  // 无自愈：后续调用仍然失败，且没有任何 run -d（不会重建）
  await expect(registry.ensureRunning(7)).rejects.toThrow(/No such container/);
  expect(log.filter((l) => l.startsWith('run -d')).length).toBe(0);   // 实测 0
});
```

（`makeRegistry`/`fakeDocker` 为审查用辅助函数：标准 roots + fake docker + `startTimeoutMs: 1000`，与 `container-registry.spec.ts` 同构。）

**建议修复方向**：`dockerStart` 的 `docker.run(['start', …])` 包 try/catch，失败时按 `isLive(entry, generation)` 校验后 `entries.delete` + `cleanupHalfCreated` 并重抛（与 `createAndStart`、`waitSocketReady` 失败路径同口径），让下次 `ensureRunning` 走完整重建；或把"启动失败收尾"收敛为一个带世代校验的共用 helper，两条路径共用。

---

### F-1【中】`createAndStart` 失败清理缺世代校验：重入 recycle 后外层失败误删新条目与新容器

**位置**：`container-registry.ts:444-452`（`waitSocketReady` 失败：`dropFailedEntry(userId, entry)` + `await this.cleanupHalfCreated(name)`）、`:422-443`（`docker run` 失败/重试失败：同样只 `dropFailedEntry` + `cleanupHalfCreated`）、`:470-474`（`dropFailedEntry` 只比对对象身份）。对照已修复的 `dockerStart`（`:492`：`if (this.isLive(entry, generation))`）。

**问题描述**

`b01394a8` 为 recycle 引入了**原地更新条目**（对象身份不变）与 **ALS 重入**（类注释与 `stopContainer` 注释明确：`requestShutdown`/`waitSocketReady` 回调里可能同步触发 `ensureRunning`，作者的 N-4c 回归测试即用 `waitSocketReady` 钩子构造该重入）。在此设计下：

- `dropFailedEntry` 的身份校验对"重入 recycle"无效——原地更新后 `entries.get(userId)` 永远是同一个对象，`current === entry` 恒真；
- `cleanupHalfCreated(entry.containerName)` 按**容器名** `rm -f`，会删掉当时在册的那个容器。

于是：外层 `createAndStart` 等待 `waitSocketReady` 期间，重入的 `ensureRunning`（同一异步上下文，持同一把锁）完成了一次完整 recycle（停 → rm → `docker run` 建新容器并原地更新条目、世代 +1）；随后外层超时失败 → `dropFailedEntry` 把刚登记的新条目删掉 → `cleanupHalfCreated` 把新容器 `rm -f` 掉。终态：注册表空、容器空，重入调用方此前拿到的"就绪"条目其容器已被销毁。docker 序列实测 `["rm -f","run -d","stop -t","rm -f","run -d","stop -t","rm -f","run -d","rm -f"]`——最后一次 `rm -f` 落在最后一次 `run -d` **之后**，`getEntry(7)` 为 null。

这与 N-4c 是同一类误伤；`b01394a8` 只给 `dockerStart` 加了世代校验，`createAndStart` 的两处失败清理漏改。

**复现/验证方式**（对当前代码失败即证明存在）

```ts
it('F-1: createAndStart 失败清理删掉重入 recycle 刚建好的新条目与新容器', async () => {
  const base = useTmpDir('mao-r4-recycle-fail-');
  const log: string[] = [];
  const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
  const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
  mkdirSync(wsA, { recursive: true }); mkdirSync(wsB, { recursive: true });
  let registry: ContainerRegistry | null = null;
  // 0=初始创建放行；1=recycle 的 createAndStart 等待（期间重入 recycle，随后超时）；2=重入新建放行
  let phase = 0;
  registry = makeRegistry(base, log, {
    sessionWorkspacesOf: async () => [],
    waitSocketReady: async () => {
      if (phase === 0) return;
      if (phase === 1) {
        phase = 2;
        await registry!.ensureRunning(7, wsB);      // 重入（ALS 重入机制明确支持的场景）
        throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
      }
    },
  });

  await registry.ensureRunning(7);
  registry.getEntry(7)!.lastUsedAtMs = Date.now() - 100 * 60_000;
  await registry.reapExpired();                     // → stopped
  phase = 1;

  log.length = 0;
  await expect(registry.ensureRunning(7, wsA)).rejects.toThrow(/连接超时/);   // recycle → createAndStart
  console.log('F1_ORDER=', JSON.stringify(dockerOps(log)));
  // 实测 ["rm -f","run -d","stop -t","rm -f","run -d","stop -t","rm -f","run -d","rm -f"]，F1_ENTRY=null
  // 期望：外层失败只清理自己那半成品；重入 recycle 建好的新容器与在册条目存活
  expect(registry.getEntry(7)?.mountedPaths.has(wsB)).toBe(true);   // 实测失败：expected undefined to be true
  const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
  const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
  expect(lastRm).toBeLessThan(lastRun);                             // 实测失败（rm 在 run 之后）
});
```

**建议修复方向**：`createAndStart` 的两个失败分支（`docker run` 失败/重试失败、`waitSocketReady` 超时）在清理前加 `isLive(entry, entry.generation)` 判定（进入失败路径时先捕获世代，与 `dockerStart` 同款）；更稳妥的做法是把"失败收尾"收敛成一个 `dropFailedEntry` + 条件 `cleanupHalfCreated` 的共用 helper，两条路径共用同一套世代语义。

---

## 四、次要观察（不构成功能缺陷，不要求本 round 处理）

- **O-1（已闭合）**：`b01394a8` 的私聊归属正则只覆盖飞书 `private-{userId}`，未覆盖钉钉 `p2p-{userId}`（`dingtalk/runtime.ts:109`：私聊 leaf = `p2p-${maoUserId}`），且其 planner 回归测试用 `dingtalk-chat/bot-1/private-9` 验证"钉钉侧同规则"、与钉钉真实命名不符。审查期间作者追加 `07047984` 修正为正则 `^(?:private|p2p)-(\d+)$` 并改用真实命名回归，我已独立验证通过（他人 `p2p-9` 拒绝、本人 `p2p-7` 放行）。该缺口在 `b01394a8` 时点不可利用（建会话侧全量收口 + DB `user_id` 过滤 + 容器沙箱拦截），属纵深防御层缺口，现已消除。
- **O-2**：`createAndStart` 原地重建不重置 `inContainer`（旧容器的 shellSessions/pendingTasks/attachedTerminals 计数会残留到新条目）；新容器 agent 握手后立即补报 `runtime_status`（`runtime-agent.ts:170-171`）即被覆盖，窗口仅为重连时间，无实际影响。如求严谨可在原地更新时一并清零。
- **O-3**：`reapExpired` 锁内的 `if (this.entries.get(entry.userId) !== entry) return`（`:348`）在"条目原地更新、身份不变"语义下永假（死代码）；实际保护由随后的 state/busy/时间戳复核提供，无害，可删或改为世代复核。
- **O-4（既有语义，非本分支引入）**：`send_file` 的 `readBytes` 入口（`read-bytes-bridge.ts` → `docker-tool-router.ts:110`）只按**用户运行时模式**判定、不校验会话 `executionMode`，因此 LOCAL 会话的 `workspace` 也可能经该入口触发容器挂载（planner 的私聊归属校验会挡住他人 `private-/p2p-` 叶子；群聊 leaf 按设计共享）。LOCAL 模式"工作区即宿主机目录"是 main 既有语义（`main` 的 `POST /v1/sessions` 即原样接受 `executionMode`+`workspace`，`StrictPathResolver` 以会话工作区为唯一根），不构成本分支引入的缺陷；若要求严，建议 `readBytes`/`ensureReady` 也要求 CLOUD 会话。

---

## 五、验证环境与数据

- 全量后端测试：`cd backend-ts && npm test` → `Test Files 330 passed | 1 skipped (331)`、`Tests 4036 passed | 13 skipped (4049)`（退出码 0）；`npm run build`（`tsc -p tsconfig.build.json`）通过；`npx tsc -p tsconfig.build.json --noEmit` 通过。均独立复跑，未依赖任务描述中的结论。
- round-03 修复闭合证据：round-03 报告的 7 条复现测试（N-4a / N-4b / N-4c / N-5 / N-6 / N-7 / N-8）在当前 HEAD `07047984` 上**全部通过**；另写 1 条 `p2p` 归属用例验证 `07047984`，通过。
- 本报告 2 条新发现各 1 条复现测试（F-1 / F-2），均对当前代码失败（即错误行为真实存在）；审查期间未修改任何源码与测试文件，临时验证 spec 用后即删，`git status` 干净（仅剩本报告）。
- 审查期间 HEAD 由 `b01394a8` 前进至 `07047984`（作者追加钉钉归属校验），本报告全部结论均以最终 HEAD `07047984` 复验为准。
