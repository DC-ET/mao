# 用户运行时容器隔离（docker 模式）代码审查 — round-02（round-01 复审）

- **日期**：2026-10-14
- **基线**：`main @ 91d4f944` → 审查对象 `feature/user-runtime-container-isolation @ a3b7422b`（工作区 `mao/.worktrees/user-runtime-isolation`；共两个提交：`f75b366c` 功能本体 + `a3b7422b` 修复）
- **性质**：本文是对 `docs/code-review/2026-10-14-container-isolation-round-01.md` 的**复审**：核对 round-01 全部 12 项缺陷与 5 项次要观察的修复是否真正生效，并检查修复本身是否引入新问题。
- **范围**：`git diff 91d4f944..HEAD` 的全部功能逻辑变更（重点 `a3b7422b` 对 `f75b366c` 的修正）。不含文档变更。
- **方法**：① 通读修复提交全量 diff 与全部新增回归 spec；② **回退验证**——在 `f75b366c` 建临时 worktree（`node_modules` 软链），把 HEAD 的 6 个回归 spec 拷进去运行，确认每条回归测试在修复前确实失败；③ 对复审中新发现的 3 个问题各写可运行测试证明真实存在；④ 全量 `npm test` + `npm run build`。审查期间未修改任何源码/测试（临时验证 spec 用后即删，`git status` 干净）。

---

## 结论概览

- round-01 的 **BUG-1 ~ BUG-12 全部有对应修复，代码路径均闭合**，其中 11 项带回退可验证的回归测试（回退后确实失败，见 §一）；A-1 ~ A-5 次要观察也全部处理到位（A-1 无专门回归测试，A-3 的配套回归测试仍缺失，均不构成功能风险）。
- 复审新发现 **3 个问题**：
  - **N-2【高】** docker 模式下飞书/钉钉**通道会话工作区不在容器挂载清单内**，通道会话的 shell / 文件工具整体静默失效（该缺口自 `f75b366c` 即存在，round-01 的 BUG-11 修复把沙箱收窄到每用户根后问题更明确）。
  - **N-3【中】** BUG-4 只修了**创建**路径：`dockerStart`（重启路径）等待 socket 超时后同样残留毒化 `running` 条目，且不会自愈。
  - **N-1【低】** BUG-8 的 deps env 注入在容器持久 shell 会话里**每次 exec 重复前置 `MAO_DEPS_BIN`**，`PATH` 无界增长。

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| N-2 | 高 | container-mount-planner + create-app/dingtalk | 飞书/钉钉入站会话工作区是 `{workspaceRoot}/feishu-chat\|dingtalk-chat/{bot}/{leaf}`，不在每用户挂载与每用户沙箱根内；docker 模式下容器内该路径不存在，shell exec 返回空输出 + `exit_code -2`，文件工具全部 ENOENT |
| N-3 | 中 | container-registry | `dockerStart` 先置 `state='running'` 再 `waitSocketReady`，失败不清理条目 → 毒化条目被后续 `ensureRunning` 无限复用，所有工具调用固定报"容器未就绪"，须等 idle 回收才可能自愈 |
| N-1 | 低 | shell-session-manager | `refreshUserEnvironment` 每次 exec 都以已含 deps bin 的 `session.currentPath` 为 base 再前置一次，容器会话内 `PATH` 每条命令多一份 `MAO_DEPS_BIN`（无界增长），host 模式零变化 |

---

## 一、round-01 缺陷修复核对表

方法说明：**回退验证**= 在 `f75b366c` 临时 worktree 中运行 HEAD 的回归 spec。共 **6 个文件 / 14 条失败**（下表"回退后失败证据"列），逐条对应 round-01 缺陷；`runtime-agent.spec.ts` 在旧代码上**收集阶段即失败**（import 模块触发 `parseArgs` → `process.exit(1)`，见 BUG-1 行），这本身即证明旧模块不可测、修复（`isMainModule()` 守卫）后才可能回归。验证后 worktree 已删除。

| round-01 | 修复位置（file:line） | 代码路径闭合？ | 回归测试 | 回退后失败证据 | 结论 |
| --- | --- | --- | --- | --- | --- |
| BUG-1（连接自我回收 + 写黑屏） | `container/runtime-agent.ts:126-188`（`ready` 标志 / `fail()` 拒绝并销毁 / `if (this.socket === socket) this.socket = null` 身份判断）、`:190-195`（`send` 守卫）、`:23`（15s 握手超时）、`:311-323`（`isMainModule` 守卫） | 是。握手未完成即 close → reject 进退避重连；旧连接迟到 close 不再置空新连接 | `runtime-agent.spec.ts:74` `keepsConnectionStableAndAnswersInFlightToolCalls` | 该 spec 在旧代码收集期即 `Error: process.exit unexpectedly called with "1"`（`runtime-agent.ts:29`） | 修复 |
| BUG-2（socket 只创建不监听） | `create-app.ts:1008` 注入 `ensureChannelListening`；`container-registry.ts:201` 先 listen 再 `docker run` | 是 | `container-registry.spec.ts:64-77`（listen/token 下标 < run 下标） | `expected [] to deeply equal [ 7 ]`（`listenings` 为空） | 修复 |
| BUG-3（缺 `MAO_CONTAINER_USER_ID`） | `container-registry.ts:214-219`（`-e MAO_CONTAINER_USER_ID / MAO_CHANNEL_TOKEN / MAO_WORKSPACE_ROOT / MAO_RUNTIME_DIR / MAO_USER_HOME_DIR / MAO_USER_SKILLS_DIR`） | 是 | 同 spec 断言 `runArgs` 含 `-e MAO_CONTAINER_USER_ID=7`、`-e MAO_CHANNEL_TOKEN=tok-7` | `expected undefined to be defined` | 修复 |
| BUG-4（毒化 running 条目） | `container-registry.ts:246-254`（条目登记移到 `waitSocketReady` 之后，失败 `entries.delete` + `cleanupHalfCreated`） | **create 路径是；重启路径漏改 → N-3** | `container-registry.spec.ts:101` `doesNotPoisonEntryWhenSocketNeverReady` | `expected { userId: 7, …(6) } to be undefined` | 部分修复 |
| BUG-5（`mcp__*` 进容器派发） | `docker-tool-router.ts:16-20`（`isDockerOnlyTool` 只查 `DOCKER_ONLY_TOOLS`，去掉 MCP 前缀）+ 注释说明 MCP 走 `RoutingMcpClientManager` | 是 | `docker-tool-router.spec.ts` `dockerOnlyListCoversFileAndShellToolsButNotMcp`、`tool-dispatcher.spec.ts:1016` `keepsMcpToolsOutOfTheDockerOnlyList` | `expected true to be false`；`expected "spy" to not be called at all, but actually been called 1 times` | 修复 |
| BUG-6（无 `pty_open_result`） | `pty-hub.ts:63-79`（`open` 返回 `PtyOpenOutcome`）、`runtime-agent.ts:281-288`（成功回 pid / 失败回 error）、`pty-bridge.ts:117-122`（宿主机校验响应类型否则抛错） | 是 | `pty-bridge.spec.ts:113` `reopensOpenWithoutLiveConnection`、`runtime-agent.spec.ts:101,125` | `promise resolved "PtyBridgePty{ …(4) }" instead of rejecting` | 修复 |
| BUG-7（`mcp_connect` 丢 envelope） | `runtime-agent.ts:220`（`handleMcpConnect(..., frame.envelope)`） | 是 | `runtime-agent.spec.ts:145` `passesEnvelopeToMcpConnect` | 旧代码 spec 收集期失败 | 修复 |
| BUG-8（depsEnv 无消费方） | `session-envelope-builder.ts:105-116`（导出 `buildDepsEnv`）、`container-tool-executor.ts:69`（`depsEnvProvider` 取 `currentEnvelope.depsEnv`）、`shell-session-manager.ts:694-699`（`createSession` 应用）、`create-app.ts:1122-1124`（终端 `depsEnvProvider`） | 是（注入侧闭合；消费侧引入 N-1） | `container-tool-executor.spec.ts:171` `injectsDepsEnvIntoShellSessions` | `expected 'NPM=[] PIP=[] BRK=[] BIN=[] PATH=[/pr…' to contain 'NPM=[/var/…]'` | 修复 |
| BUG-9（exitCode 硬编码 0） | `pty-bridge.ts:197-204`（`onPtyExit` 原样透出容器回报码） | 是 | `pty-bridge.spec.ts:74` `passesThroughContainerExitCode` | `expected [ { exitCode: +0 } ] to deeply equal [ { exitCode: 42 } ]` | 修复 |
| BUG-10（pty hub 绑死连接） | `create-app.ts:1069-1090`（`ptyHubGeneration` 按 `entry.startedAtMs` 判定：重建 dispose 旧 hub、同容器换连接 `bindConnection`）、`pty-bridge.ts:82-96,149-156`（`currentConnection` / `bindConnection` / `dispose`） | hub 语义闭合；create-app 世代判定为接线代码，无直接单测（hub 行为有覆盖） | `pty-bridge.spec.ts:85,146` `survivesConnectionReplacement` / `disposeFailsInFlightPtysImmediately` | `hub.bindConnection is not a function` 等 | 修复 |
| BUG-11（全局沙箱根） | `container-tool-executor.ts:50-57`（基路径 `{workspaceRoot}/{userId}` + 每用户允许根 + `/tmp`） | 是（但会话工作区不在每用户根下时走 `sessionWorkspace` 分支 → N-2） | `container-tool-executor.spec.ts:65,132` | `expected rejection for …/runtime/8/secret.txt: expected undefined to be defined` | 修复 |
| BUG-12（enabledFor 无缓存） | `docker-tool-router.ts:40,48,62-72`（`modeCache` + 5s TTL + key 含全局模式） | 是 | `docker-tool-router.spec.ts` `cachesRuntimeModeLookupForShortTtl` / `reflectsGlobalModeSwitchImmediately` | `expected "spy" to be called 1 times, but got 3 times` | 修复 |
| A-1（心跳 off-by-one） | `runtime-channel-server.ts:243`（`>= HEARTBEAT_MISS_LIMIT`） | 是 | 无专门回归测试（单字符比较，code review 核对） | — | 修复（无测试） |
| A-2（永假死代码） | `container-mount-planner.ts:84-86`（改为校验 `mode` 取值合法） | 是 | 随 planner spec 覆盖 | — | 修复 |
| A-3（runtime_status 失效） | `create-app.ts:998`（`onRuntimeStatus → reportRuntimeStatus`）、`runtime-agent.ts:170-171`（重连后立即补报） | 是；但 A-3 要求的"活跃 shell 不被 idle 回收"回归测试仍未补（`reapExpired` busy 分支无测试） | `runtime-agent.spec.ts:96` 断言补报 | — | 修复（配套测试缺口） |
| A-4（lastUsedAtMs 在 await 后刷新） | `docker-tool-router.ts:81-82,110-111,134-135,151-152`（`dispatch`/`readBytes`/`mcpConnect`/`mcpCall` 四处均移到 await 前） | 是 | 随 router/dispatcher spec 覆盖 | — | 修复 |
| A-5（token 隐式文件依赖） | `container-registry.ts:202,215`（`issueChannelToken` 显式落盘 + `-e MAO_CHANNEL_TOKEN=`） | 是 | 随 registry spec 覆盖 | — | 修复 |

**host 模式零变化核对**：宿主机 `ShellSessionManager`（`create-app.ts:967-973`）不传 `askpassDirOverride` / `depsEnvProvider`；宿主机 `PathSandbox` 不传 `strict`；`isDockerOnlyTool` 清单外工具与 `enabledFor()===false` 时不经 docker 分支。以上均与 main 一致，host 主链路行为不变（仅 BUG-12 性能点已由 TTL 缓存消除）。

---

## 二、复审新发现

### N-2【高】docker 模式下飞书/钉钉通道会话工作区不在容器挂载清单内，通道会话工具链整体失效

**位置**

- 工作区生成：`create-app.ts:360-376`（`resolveFeishuChatWorkspace`）、`create-app.ts:1740-1752`（飞书入站建会话）、`dingtalk/workspace.ts:5-9` + `dingtalk/runtime.ts:110-118`（钉钉同构）
- 挂载边界：`harness/container/container-mount-planner.ts:45-56`（`plan(userId)` 只挂 `{userHomeDir}/{u}`、`{workspaceRoot}/{u}`、`{runtimeDir}/{u}`、`{depsDir}/{u}`、`{channelDir}/{u}`、`{userSkillsDir}/{u}` 与两个 ro 根）
- 透传链：`docker-tool-router.ts:83-85`（`envelope.workspace` 原样来自会话）← `agent-loop.ts:688-700`（`workspace: context.workspace`）← `harness-service.ts:313`（`context.workspace = session.workspace`）
- 容器侧消费：`shell-session-manager.ts:677`（`workDir = getEffectiveWorkspaceRoot(workspace)` 作 bash `cwd`）、`path-sandbox.ts:42-50`（`resolve` 以 `sessionWorkspace` 为解析根）、`container-tool-executor.ts:52`（沙箱基路径 `{workspaceRoot}/{u}`）

**问题描述**

web 会话工作区是 `{workspaceRoot}/{userId}/{sessionId}` 或 `{workspaceRoot}/{userId}/projects/{slug}`（`session.service.ts:225-227`、`safety/cloud-workspace-resolver.ts:39-44`），在容器内可见且落在每用户沙箱根内；而**飞书/钉钉入站会话的工作区是 `{workspaceRoot}/feishu-chat/{botId}/{leaf}` 与 `{workspaceRoot}/dingtalk-chat/{botId}/{leaf}`**——既不在任何容器挂载之内，也不在每用户沙箱基路径之内。后果（docker 模式，即该用户 `runtimeMode=docker` 或全局 `MAO_CLOUD_RUNTIME=docker`）：

1. **shell 工具**：bash `cwd` 指向容器内不存在的目录 → `spawn` ENOENT → 会话秒退，工具返回**空输出 + `exit_code -2` + "shell 进程已退出，会话已关闭"**（不是超时，是静默失败）。
2. **文件工具**：相对路径按该工作区解析，全部 ENOENT；飞书入站图片/文件落盘的 `{workspace}/chat-files/...`（`feishu/chat-files.ts:11-12`）与给模型的"图片已保存到会话工作区"提示（`agent-inbound-handler.ts:887`）在容器内均不可读。
3. **沙箱不放拦**：`PathSandbox.resolve(userPath, sessionWorkspace)` 以 `sessionWorkspace` 为根，通道工作区下的路径一律放行——BUG-11 的每用户收窄在这条路径上不生效（失效的只是功能，不是安全性：容器内这些路径本就不存在）。
4. **终端**：`TerminalManager` 的 pty `cwd` 同源，容器内 spawn 失败 → "终端启动失败"。

该缺口自 `f75b366c` 即存在（挂载清单从最初就是每用户粒度），round-01 未覆盖；修复提交的 BUG-11 回归测试只使用 `{workspaceRoot}/{userId}` 工作区，因此缺口被留在原地。

**复现/验证方式**（两条测试，对当前代码均失败/成立即证明问题存在）

```ts
// ① 通道工作区不在容器挂载清单内（docker 语义下容器内不可见）
it('N-2: 通道会话工作区（飞书/钉钉）不在容器挂载清单内', () => {
  const base = useTmpDir('mao-r2-mount-');
  const roots = { userHomeDir: join(base,'users'), runtimeDir: join(base,'runtime'),
    workspaceRoot: join(base,'workspace'), depsDir: join(base,'deps'),
    userSkillsDir: join(base,'userskills'), channelDir: join(base,'runtime','channels'),
    distDir: join(base,'mao','backend-ts','dist'), skillsDir: join(base,'mao','data','skills') };
  for (const dir of Object.values(roots)) mkdirSync(dir, { recursive: true });
  mkdirSync(join(roots.workspaceRoot, '7'), { recursive: true });
  const feishuWs = join(roots.workspaceRoot, 'feishu-chat', 'bot-1', 'oc_chat');
  const dingtalkWs = join(roots.workspaceRoot, 'dingtalk-chat', 'bot-1', 'p2p-7');
  mkdirSync(feishuWs, { recursive: true }); mkdirSync(dingtalkWs, { recursive: true });
  const planner = new ContainerMountPlanner(roots);
  const mounted = planner.plan(7).map((m) => m.containerPath);
  for (const ws of [feishuWs, dingtalkWs]) {
    expect(mounted.some((p) => ws === p || ws.startsWith(p + '/')),
      `${ws} 应被容器挂载覆盖`).toBe(true);   // 实际 false
  }
});

// ② 工作区在容器内不可见时 shell exec 静默失败（对照组正常）
// envelopeOf(workspace, sessionId) 为 RuntimeEnvelope 辅助构造（userId=7、gitTokens={}、depsEnv={}）
it('N-2b: 通道工作区在容器内不可见时 shell exec 静默失败（对照组正常）', async () => {
  const base = useTmpDir('mao-r2-exec-');
  const workspaceRoot = join(base, 'workspace');
  mkdirSync(join(workspaceRoot, '7'), { recursive: true });
  const executor = new ContainerToolExecutor({
    workspaceRoot, runtimeDir: join(base,'runtime'),
    userHomeDir: join(base,'users'), userSkillsDir: join(base,'userskills') }, 7);
  const run = (workspace: string | null, sessionId: number) =>
    JSON.parse(executor.handleToolCall('shell', JSON.stringify({
      action: 'exec', command: 'echo hi', yield_time_ms: 3000 }),
      envelopeOf(workspace, sessionId)) as any);
  const control = await run(join(workspaceRoot, '7'), 21);        // 每用户工作区
  expect(control.output).toContain('hi');                          // 通过
  expect(control.exit_code).toBe(0);                               // 通过
  const broken = await run(join(workspaceRoot, 'feishu-chat', 'bot-1', 'oc_chat'), 22);
  expect(broken.output).toBe('');                                  // 实际 ''（非 'hi\n'）
  expect(broken.exit_code).toBe(-2);                               // 实际 -2（spawn ENOENT）
  expect(broken.message).toContain('shell 进程已退出');             // 实际命中
});
```

实测输出（容器视图 = 该目录不存在，与"未挂载"等价）：实验组 `{"exit_code":-2,"output":"","completed":true,"message":"shell 进程已退出，会话已关闭。…"}`，对照组 `{"exit_code":0,"output":"hi\n"}`。

**建议修复方向**

1. 挂载清单为通道工作区开专属条目（如 `{workspaceRoot}/feishu-chat`、`{workspaceRoot}/dingtalk-chat`，rw，`assertSafe` 增加该前缀白名单并保留"不得为其他数据根父目录"校验）；或
2. 派发前把通道工作区重写/软链到每用户根下（如 `{workspaceRoot}/{userId}/channels/...`），保持"容器内只见到每用户根"的边界不变；或
3. docker 分支对不在每用户根内的 `session.workspace` 明确报错/降级 host，至少不能让模型看到"空输出 + 会话已退出"这种无法归因的静默失败。

---

### N-3【中】BUG-4 只修创建路径：`dockerStart` 等待 socket 超时后同样残留毒化 `running` 条目

**位置**：`harness/container/container-registry.ts:260-269`（`dockerStart`：`entry.state='running'` → `waitSocketReady`，失败既不清理条目也不 `stop`）。对照已修复的 `createAndStart`（`:246-254`）。

**问题描述**

`ensureRunning`（`:122-144`）对 `state==='stopped' && !connectionDead` 的条目走 `dockerStart`（idle 回收后即此状态）。若 `docker start` 成功但容器内 agent 始终未连上 socket（token 失效、`dist` 挂载损坏、镜像内 agent 崩溃等），`waitSocketReady` 抛错：条目停留在 `state='running'`、`connectionDead=false`。此后：

- 每次 `ensureRunning` 命中 `:127-130` 直接返回该"就绪"条目，**不做任何 docker 调用、不重建**；
- `DockerToolRouter.dispatch` 随之在 `channelServer.getConnection()` 处抛"容器运行时通道未就绪（channel 未连接），请稍后重试"——错误信息指向"稍后重试"，但重试永远同样失败；
- 无自愈路径：要等 `reapExpired`（`idleMinutes`，默认配置下以十分钟/小时计）把容器停掉、条目变 `stopped` 后才可能再次 `dockerStart`；若根因未除，则再次毒化，循环失败。

`createAndStart` 已在修复中改为"就绪后才登记 + 失败即清理"，重启路径漏改，属**修一半**。

**复现/验证方式**（对当前代码失败即证明存在）

```ts
it('N-3: dockerStart 等待 socket 超时后条目被固化为 running（毒化）', async () => {
  const base = useTmpDir('mao-r2-reg-');
  for (const d of ['workspace','users','runtime','userskills','skills','channels','dist','deps'])
    mkdirSync(join(base, d), { recursive: true });
  const log: string[] = [];
  let socketReady = true;
  const registry = new ContainerRegistry({ /* config: startTimeoutMs 1000, idleMinutes 60 … */
    ensureChannelListening: async (u) => join(base,'channels',String(u),'runtime.sock'),
    issueChannelToken: () => 'tok-7',
    waitSocketReady: async () => { if (!socketReady) throw new Error('wait socket ready timeout'); },
    requestShutdown: async () => true,
  }, fakeDocker(log));

  await registry.ensureRunning(7);                            // 首建成功
  registry.getEntry(7)!.lastUsedAtMs = Date.now() - 61 * 60_000;
  await registry.reapExpired();                               // idle 回收 → stopped
  expect(registry.getEntry(7)?.state).toBe('stopped');        // 通过

  socketReady = false;                                        // 重启：start 成功但 agent 永不连接
  log.length = 0;
  await expect(registry.ensureRunning(7)).rejects.toThrow(/timeout/);   // 通过（本次调用报错）

  // 期望：与 createAndStart 同口径清理条目。实际：毒化为 running
  expect(registry.getEntry(7)).toBeUndefined();
  // 实测 POISONED_ENTRY = {"userId":7,"state":"running","connectionDead":false,…}

  log.length = 0;
  const again = await registry.ensureRunning(7);              // 不抛错，直接复用
  expect(log.filter((l) => l.startsWith('run -d') || l.startsWith('start'))).toEqual([]);
  expect(again.state).toBe('running');                        // 调用方拿到"就绪"容器
});
```

**建议修复方向**：`dockerStart` 的 `waitSocketReady` 失败时与 `createAndStart` 同口径收尾（`entries.delete(userId)` + `stopContainer`/`cleanupHalfCreated` 后重抛），或把条目登记统一移到"socket 就绪"之后，从结构上消除两类路径的差异。

---

### N-1【低】容器持久 shell 会话每次 exec 重复前置 `MAO_DEPS_BIN`，`PATH` 无界增长

**位置**：`harness/shell/shell-session-manager.ts:545-546`（`applyDepsEnv(env, deps, session.currentPath)`）、`:550`（`session.currentPath = env.PATH`）、`:747-756`（`env.PATH = base ? depsBin + ':' + base : …`）；触发点 `harness/tool/impl/shell-session-tool.ts:182`（及 `:330`）每次 exec 调 `refreshUserEnvironment(session, userId, tokenMap)` 且不传 `depsEnv`；注入源 `container-tool-executor.ts:69`（`depsEnvProvider` 返回当前 envelope 的 deps env）。

**问题描述**

`createSession` 首次注入后 `session.currentPath` 已以 `MAO_DEPS_BIN` 开头；`refreshUserEnvironment` 在**每条 exec 前**都会以 `session.currentPath` 为 base 再前置一份 deps bin，并把增长后的值写回 `currentPath`。容器内 `depsEnvProvider` 恒返回非空 deps，因此：同一持久会话（`keep_session`）里第 N 条命令的 `PATH` 含 N+1 份 deps bin；同时 `refreshEnvironment`（`:244-259`）每次把越来越长的 `export PATH='…'` 写进 shell stdin。影响面：`PATH` 无界增长（长会话下 KB 级并持续写入 stdin）、模型 `echo $PATH` 看到重复项、极端长会话下子进程 env 逼近 `ARG_MAX`。host 模式无 `depsEnvProvider`，`resolveDepsEnv()` 返回 null，行为零变化（已核对）。

**复现/验证方式**（对当前代码失败即证明存在）

```ts
it('N-1: deps bin 在持久 shell 会话中每次 exec 重复前置 PATH（无界增长）', async () => {
  const base = useTmpDir('mao-r2-path-');
  const workspaceRoot = join(base, 'workspace');
  const userWorkspace = join(workspaceRoot, '7');
  const depsUserDir = join(base, 'deps', '7');
  mkdirSync(userWorkspace, { recursive: true });
  mkdirSync(join(depsUserDir, 'npm', 'bin'), { recursive: true });
  const executor = new ContainerToolExecutor({ workspaceRoot,
    runtimeDir: join(base,'runtime'), userHomeDir: join(base,'users'),
    userSkillsDir: join(base,'userskills') }, 7);
  const depsBin = join(depsUserDir, 'npm', 'bin');
  const depsEnv = { NPM_CONFIG_PREFIX: join(depsUserDir,'npm'),
    PIP_TARGET: join(depsUserDir,'py'), PIP_BREAK_SYSTEM_PACKAGES: '1', MAO_DEPS_BIN: depsBin };
  const counts: number[] = [];
  for (let i = 0; i < 6; i++) {
    const res = await executor.handleToolCall('shell', JSON.stringify({
      action: 'exec', command: 'echo $PATH', session_id: 'sh-fixed',
      keep_session: true, yield_time_ms: 8000 }), envelopeOf(userWorkspace, 11, depsEnv));
    counts.push(JSON.parse(res).output.split(depsBin).length - 1);
  }
  expect(counts).toEqual([1, 1, 1, 1, 1, 1]);   // 期望幂等；实测 [2, 3, 4, 5, 6, 7]
});
```

**建议修复方向**：`applyDepsEnv` 幂等化——base 已以 `depsBin`（或 `depsBin + ':'`）开头则不再前置；或在 `refreshUserEnvironment` 中先剥离上次注入的 deps bin 前缀再拼装，避免依赖 `currentPath` 的历史值。

---

## 三、重点复查项结论（复审任务指定）

| 复查项 | 结论 |
| --- | --- |
| pty-bridge `bindConnection` / 宽限期 / 世代管理 | **闭合**。`subscribe` 对已死连接转 `handleConnectionLost`（`pty-bridge.ts:186-191`）；`onClosed` 在连接已关闭时同步回调（`runtime-channel-server.ts:293-303`）；宽限 20s > agent 退避上限 15s，宽限内 `bindConnection` 取消计时并迁移订阅（`:90-96`）；`dispose` 收尾在飞 pty 后允许 hub 换绑（`:149-156`）；create-app 按 `startedAtMs` 换世代、关停时统一 dispose（`create-app.ts:3196-3198`）。`kill → forget` 不回调 onExit 与宿主机 node-pty 同口径（`terminal-manager.ts:275` 注释即此约定），无终端条目泄漏。 |
| ContainerToolExecutor 每用户沙箱根 vs 飞书/钉钉会话工作区 | 沙箱收窄本身正确；但通道工作区既未挂载也未纳入允许根 → **N-2**。 |
| shell `currentPath` × deps env | **N-1**（非幂等，无界增长）。 |
| DockerToolRouter TTL 缓存 vs admin 改 `runtime_mode` | **可接受**。缓存 key 含全局模式（重启切模式立即生效），用户级覆盖最多 5s 延迟，代码注释已声明该取舍。边界情况：模式瞬切会使 MCP 连接与调用落到不同侧（连接在 host、call 进容器 → "容器内 MCP 连接失败"），属管理员主动切换的瞬时窗口，不建议额外加锁。 |
| ContainerRegistry 超时清理路径 | `createAndStart` 已闭合（BUG-4）；`dockerStart` 未闭合 → **N-3**。`reapExpired` 的 busy 判定依赖 `runtime_status`（10s 周期 + 重连即补报），A-3 配套回归测试仍缺失。 |

---

## 四、验证环境与数据

- 全量后端测试：`cd backend-ts && npm test` → `Test Files 329 passed | 1 skipped (330)`、`Tests 4017 passed | 13 skipped (4030)`（退出码 0）。`npm run build`（`tsc -p tsconfig.build.json`）通过。
- 回退验证：`f75b366c` 临时 worktree + `node_modules` 软链 + HEAD 的 6 个回归 spec → `Tests 14 failed | 73 passed (87)`，失败证据见 §一；验证后 worktree 已删除，`git status` 干净。
- 本报告 3 条新发现共 4 条验证用例（N-1 / N-2 / N-2b / N-3），全部对当前代码失败/复现了错误行为；审查期间未修改任何源码与测试文件，临时验证 spec 用后即删。
