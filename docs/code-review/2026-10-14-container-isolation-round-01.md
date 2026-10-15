# 用户运行时容器隔离（docker 模式）代码审查 — round-01

- **日期**：2026-10-14
- **基线**：`main @ 91d4f944` → 审查对象 `feature/user-runtime-container-isolation @ f75b366c`（工作区 `mao/.worktrees/user-runtime-isolation`，审查期间未修改任何源码/测试，`git status` 干净）
- **范围**：本次需求引入的全部功能逻辑变更（`backend-ts/src/harness/container/**`、`ToolDispatcher` docker 分支、`TerminalManager`/`ShellSessionManager`/`PathSandbox`/外部发送工具/REST 文件服务的宿主机侧改动、`create-app.ts` 装配、V154 与 admin 契约）。不含文档、部署脚本本身的功能审查（仅核对配置链路）。
- **设计对照**：`docs/plan/2026-10-14-user-runtime-container-isolation-design.md`（§5.1 挂载清单 / §5.2 生命周期 / §5.4 协议 / §5.5 容器 agent / §5.7 宿主机改动 / §5.10 MCP / §5.13 依赖持久化）。
- **方法**：通读全量 diff + 逐文件读源码；每条候选必须**有可运行测试证明真实存在**（探针断言写"正确行为"或直接观测错误行为，对当前代码失败/成立即证明 bug 存在）。共写 6 个临时验证 spec、16 条测试，全部通过后按"不修改代码"要求删除；全量 `npm test` 确认存量无回归（`Test Files 332 passed | 1 skipped (333)` / `Tests 4010 passed | 13 skipped (4023)`，基线为 326 文件 / 3996 测试，多出的 6 文件 14 测试即本审查临时探针）。
- **结论概览**：docker 模式当前**整体不可用**——宿主机 socket 从未监听（BUG-2）、容器 agent 启动即退出（BUG-3）、即便连上也每 500ms 自我回收且响应写不出去（BUG-1）；pty 终端与 MCP 工具在 docker 模式必然失败（BUG-5、BUG-6）。host 模式主链路行为正确，仅存一次多余查库（BUG-12）。

---

## 结论表

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| BUG-1 | 致命 | container/runtime-agent | `connectOnce` 握手完成即 resolve，连接每 ~500ms 被回收替换；旧连接 close 把 `this.socket` 置 null 后容器→宿主机帧几乎全程写不出去，在途请求全部失败 |
| BUG-2 | 致命 | container/runtime-channel-server + create-app | `RuntimeChannelServer` 只 new 不 `ensureListening`，全仓无调用方，宿主机 socket 从不监听，容器 agent 永远连不上 |
| BUG-3 | 致命 | container/container-registry | `docker run` 参数没有任何 `-e`，容器 agent 硬性依赖的 `MAO_CONTAINER_USER_ID` 到不了容器内，启动即 `exit(1)` |
| BUG-4 | 高 | container/container-registry | `createAndStart` 先 `entries.set(running)` 再 `waitSocketReady`，等待超时后残留毒化条目，后续 `ensureRunning` 直接复用（不重试、不等 socket） |
| BUG-5 | 高 | tool-dispatcher + container executor | `mcp__*` 被 docker 分支当普通 `tool_call` 派发进容器，容器执行器只注册 6 个文件/shell 工具，MCP 工具在 docker 模式全灭 |
| BUG-6 | 高 | container/pty-bridge + pty-hub | 容器侧从不回 `pty_open_result`，宿主机 `PtyChannelHub.open` 只能等 20s 超时，docker 终端永远打不开 |
| BUG-7 | 中 | container/runtime-agent | `mcp_connect` 处理丢弃 `frame.envelope`，容器内 MCP stdio 子进程拿不到用户级凭据与依赖目录 env |
| BUG-8 | 中 | container/session-envelope-builder | `depsEnv`（NPM_CONFIG_PREFIX/PIP_TARGET/…）除 MCP 桥外无任何 shell/pty 消费方，容器内依赖安装落临时文件系统，§5.13 持久化目标未落地 |
| BUG-9 | 中 | container/pty-bridge | `PtyChannelHub` 的 pty_exit 分发把退出码硬编码为 0，容器回报的真实 exitCode 被丢弃（host 模式原样透传） |
| BUG-10 | 中 | create-app | `ptyChannelHubs` 按 userId 缓存 hub 且绑定创建时的连接，连接被回收/重建后缓存 hub 仍持死连接：新终端 open 抛错、旧终端 write/resize 静默丢弃 |
| BUG-11 | 中低 | container/container-tool-executor | 容器内 `PathSandbox` 允许根是全局父目录（`runtimeDir`/`userHomeDir`/`userSkillsDir`），非设计 §5.5 的每用户子目录，沙箱放行其他用户路径（生产中被挂载边界掩盖） |
| BUG-12 | 低 | container/docker-tool-router | `enabledFor` 无缓存，host 模式下每个 docker-only 工具调用都多一次 `userRepo.findById`，"host 模式零变化"被破坏（仅性能/行为面） |

---

## BUG-1【致命】runtime-agent 连接每 ~500ms 自我回收，且回收后容器→宿主机响应几乎全程写不出去

### 位置

- 根因 1：`backend-ts/src/harness/container/runtime-agent.ts:142-144`（`connectOnce` 在 `hello_result` 到达即 resolve）
- 根因 2：`backend-ts/src/harness/container/runtime-agent.ts:135-136`（旧连接 `close` 无条件把 `this.socket` 置 null）
- 放大器：`runtime-agent.ts:19`（`RECONNECT_BASE_MS = 500`）+ `:95-97`（connectLoop 无脑重连）；宿主机侧 `runtime-channel-server.ts:166-171`（新连接踢旧连接）

### 代码事实

```ts
// runtime-agent.ts:142-144 —— 握手成功即视为"本轮连接结束"
void ready.then(() => {
  if (!settled) { settled = true; resolve(); }
});
// runtime-agent.ts:135-140 —— 任何一条 socket close 都清空 this.socket（包括已被新连接顶替的旧 socket）
socket.on('close', () => {
  this.socket = null;
  ...
});
```

`connectLoop` 的设计意图应是"连接断了才重连（指数退避）"，实际变成"连上 500ms 后主动重连一次"的无限循环；且宿主机单用户单连接策略会把旧连接上的在途请求全部 `failAll('Runtime channel closed')`（`runtime-channel-server.ts:325`）。

更严重的第二重后果：新连接 `connect`（`this.socket = socket`，:109）与旧连接 `close`（`this.socket = null`，:136）之间只差一个 hello 往返（微秒~毫秒级，且随事件loop繁忙程度变化）。也就是说每个 500ms 周期里，`this.socket` 只有极短瞬间非空，其余时间 `send()` 直接 return——`tool_result` / `pty_data` / `pty_exit` / `runtime_status` / `pong` 全部静默丢弃。

### 问题描述

docker 模式下所有经通道的执行面全部失效：

1. 任何执行时间超过 ~500ms 的工具调用（shell exec、后台任务、MCP 调用）必以 `Runtime channel closed` 失败；
2. 即使瞬时命令也基本拿不到结果（响应due时 `this.socket` 为 null）；
3. `runtime_status` 上报被丢弃 → `ContainerRegistry.reportRuntimeStatus` 永不触发 → `entry.inContainer` 恒为 0 → §5.3.1"容器内有活跃 shell/任务/终端时不推进 idle"的保护失效，长任务容器会被 idle 误回收；
4. `pong` 被丢弃 → 心跳判定形同虚设（被 500ms 重连掩盖）。

### 复现/验证方式

临时 spec（`review-verify-agent.spec.ts`，验证后已删除）启动真实 `RuntimeChannelServer` + 动态 import 真实 `runtime-agent.ts`：

```ts
// 观测 1：在途请求必失败 + 连接被反复替换
const first = server.getConnection(7)!;
const outcome = await first.request({
  v: 1, type: 'tool_call', id: 'tool-sleep', tool: 'shell',
  args: JSON.stringify({ action: 'exec', command: 'sleep 2; echo done', yield_time_ms: 5000 }),
  envelope: envelopeOf(null),
}, 10_000).then((r) => r, (e) => e as Error);
expect((outcome as Error).message ?? '').toMatch(/Runtime channel closed/);   // ✅ 通过（证明失败）
await vi.waitFor(() => expect(server.getConnection(7)).not.toBe(first));      // ✅ 2s 内连接被换人

// 观测 2：越过首次回收后，带 250ms 延迟的命令也拿不到 tool_result
// （门控：先观察到 ≥3 次连接替换；每轮等新连接出现后立刻发请求，响应due时必落在 this.socket=null 期）
for (let i = 0; i < 3; i++) {
  const outcome = await conn.request({ v: 1, type: 'tool_call', id: `probe-${i}`, tool: 'shell',
    args: JSON.stringify({ action: 'exec', command: 'sleep 0.25; echo hi', yield_time_ms: 5000 }),
    envelope: envelopeOf(`${ROOT}/workspace/7`) }, 3000).then((r) => r, (e) => e as Error);
  ...
}
expect(resolved, '没有任何一次拿到 tool_result').toBe(0);   // ✅ 3/3 全部失败
```

另用 `Socket.prototype.write` 猴补丁追踪容器侧全部写出帧，实测时间线（`t` 为 ms）：

```
s1@11:tool_result  s1@97:tool_result ... s1@453:tool_result   ← 首条连接生命周期内正常
s2@453:hello                                                        ← 此后每条新连接只写得出 hello
s3@955:hello   s4@1459:hello ...
```

即首次回收之后再无任何 `tool_result` 写出。连续 3 次运行 4 条测试全部稳定通过。

### 建议修复方向

1. `connectOnce` 只在连接真正断开时 resolve：删掉 `:142-144` 的 `ready.then(resolve)`，改为 `close`  handler 里 `ready` 已满足则 `resolve()`、未满足则 `reject`（`ready` 仅用于"宿主机始终不回 hello_result"的兜底，且兜底也应走 reject/超时而非 resolve）；
2. `close` handler 加身份判断：`if (this.socket === socket) this.socket = null;`，旧连接晚到的 close 不得清空新连接；
3. 补一条回归测试：握手完成后连接对象在 2s 内不变、在途 `tool_call` 能拿到 `tool_result`。

---

## BUG-2【致命】`RuntimeChannelServer` 只创建不监听，全仓没有 `ensureListening` 调用方

### 位置

- 根因：`backend-ts/src/create-app.ts:993-999`（构造 `channelServer`，注入 tokenOf/onConnectionDead/onRuntimeStatus 后直至应用关闭都没有 `ensureListening`）
- 定义处：`backend-ts/src/harness/container/runtime-channel-server.ts:66`（`ensureListening`，创建目录/socket 并 listen）
- 后果链：`create-app.ts:1007-1014`（`waitSocketReady` 轮询 `channelServer.getConnection`）→ `container-registry.ts:233`

### 代码事实

```ts
// create-app.ts:993-999
const channelServer = new RuntimeChannelServer({
  channelDir: cloudRuntimeCfg.container.channelDir,
  tokenOf: (userId): string => channelServer.issueToken(userId),
  onConnectionDead: (userId) => containerChannelHolder.registry?.markConnectionDead(userId),
  onRuntimeStatus: (userId, status) => containerChannelHolder.registry?.reportRuntimeStatus(userId, status),
});
// 之后没有任何 channelServer.ensureListening(...) 调用（全仓 grep 仅 class 定义自身与单测引用）
```

### 问题描述

`ensureListening` 是 socket server 开始监听的唯一入口。不调用它：不创建 `{channelDir}/{userId}/` 目录与 `runtime.sock`、不 listen。于是：

1. 容器 agent `connect(socketPath)` 直接 ENOENT，靠指数退避无限重试；
2. `issueToken` 写的 `.token` 文件所在目录也不存在（`issueToken` 会自建目录，但容器没挂载到对应路径前无意义）；
3. `waitSocketReady` 轮询 `getConnection` 恒为 null → `startTimeoutMs`（默认 15s）后抛"容器运行时通道连接超时" → 触发 BUG-4 的毒化条目；
4. 整条 docker 链路（工具、终端、read_bytes、MCP）全部不可用。

### 复现/验证方式

```ts
// review-verify-registry.spec.ts（验证后已删除）
const source = readFileSync(new URL('../../create-app.ts', import.meta.url), 'utf8');
expect(source).toContain('new RuntimeChannelServer({');
expect(source).not.toContain('ensureListening');          // ✅ 证明生产装配漏掉 listen
// 行为佐证：不调 ensureListening 时无 socket 文件、无连接
const srv = new RuntimeChannelServer({ channelDir: join(base, 'channels'), tokenOf: (u) => srv.issueToken(u) });
expect(srv.getConnection(7)).toBeNull();                  // ✅
expect(existsSync(srv.socketPathOf(7))).toBe(false);      // ✅
```

### 建议修复方向

在 `create-app.ts` 装配完 `channelServer` 后（或应用启动/bootstrap 阶段，与 `containerRegistry.precheck()` 同一时机）对启用 docker 的用户调用 `ensureListening(userId)`；更稳妥的做法是在 `ContainerRegistry.ensureRunning`/`precheck` 前由 registry 统一驱动"先 listen 再 docker run"，避免两个类之间的隐式顺序依赖。补回归测试：装配后 `{channelDir}/{userId}/runtime.sock` 存在且可 accept。

---

## BUG-3【致命】`docker run` 不注入 `MAO_CONTAINER_USER_ID`，容器 agent 启动即退出

### 位置

- 根因：`backend-ts/src/harness/container/container-registry.ts:196-212`（`createAndStart` 的 args 组装，通篇没有一个 `-e`）
- 硬依赖处：`backend-ts/src/harness/container/runtime-agent.ts:258-262`（读不到即 `process.exit(1)`）
- 次级缺口：roots 环境变量（`MAO_WORKSPACE_ROOT`/`MAO_RUNTIME_DIR`/`MAO_USER_HOME_DIR`/`MAO_USER_SKILLS_DIR`）同样没传，`runtime-agent.ts:34-40` 只能回落硬编码 `/opt/mao-data/*` 默认值（与标准部署巧合一致，但配置一改就错）

### 代码事实

```ts
// container-registry.ts:196-212
const args = [
  'run', '-d', '--name', name, '--label', ..., '--memory', ..., '--tmpfs', ...,
  ...this.planner.toDockerArgs(mounts),
  '--restart', 'no',
  c.image,
  'node', path.posix.join(c.distDir, 'harness/container/runtime-agent.js'),
  '--socket', path.join(c.channelDir, String(userId), 'runtime.sock'),
];
// 没有任何 -e MAO_CONTAINER_USER_ID=... / -e MAO_CHANNEL_TOKEN=... / -e MAO_*_ROOT=...
```

```ts
// runtime-agent.ts:258-262
const userId = Number(process.env.MAO_CONTAINER_USER_ID ?? 0');
if (!Number.isFinite(userId) || userId <= 0) {
  console.error('[runtime-agent] missing MAO_CONTAINER_USER_ID');
  process.exit(1);
}
```

全仓检索 `MAO_CONTAINER_USER_ID`：只有 `runtime-agent.ts` 读、临时测试写，Dockerfile.runtime 无 `ENV` 兜底、部署脚本无注入——即没有任何生产路径给它赋值。（`MAO_CHANNEL_TOKEN` 有 `{dir}/.token` 文件回落且 channel 目录按用户挂载，这条链是通的。）

### 问题描述

即便 BUG-2 修复（socket 开始监听），容器起来后 agent 仍在第一行退出：`docker run` 成功、`waitSocketReady` 干等 15s 超时。表现为"容器在跑但任何工具调用都报容器执行环境不可用"。

### 复现/验证方式

```ts
// review-verify-registry.spec.ts（验证后已删除）：捕获真实 docker run 参数
const runArgs = log.find((line) => line.startsWith('run -d'))!;
expect(runArgs).not.toContain('-e ');                          // ✅ 一个环境变量都没传
expect(runArgs).not.toContain('MAO_CONTAINER_USER_ID');        // ✅
expect(runArgs).not.toContain('MAO_WORKSPACE_ROOT');           // ✅ roots 也没传
// 静态佐证：agent 侧是硬性前置；镜像里也没有 ENV 兜底
expect(agentSource).toContain("process.env.MAO_CONTAINER_USER_ID ?? 0");
expect(dockerfile).not.toContain('MAO_CONTAINER_USER_ID');
```

### 建议修复方向

`createAndStart` 的 args 补 `-e MAO_CONTAINER_USER_ID={userId}`；同时把宿主机配置的四个 roots 与 `MAO_CHANNEL_TOKEN`（或明确依赖 token 文件回落）一并注入，避免容器内出现第二套路径真相。补回归测试：`run` 参数包含 `MAO_CONTAINER_USER_ID=<userId>` 且四个 roots 与宿主机配置一致。

---

## BUG-4【高】`waitSocketReady` 超时后残留毒化 `running` 条目，后续 `ensureRunning` 直接复用

### 位置

- 根因：`backend-ts/src/harness/container/container-registry.ts:232-233`（先 `entries.set` 再 `await waitSocketReady`）
- 复用点：`container-registry.ts:118-131`（`ensureRunning` 见到 `state==='running' && !connectionDead` 直接返回）
- 对比设计：技术方案 §5.2 伪代码 `entry = createContainer(...); await waitSocketConnect(...)`——条目应在 socket 就绪后才视为 running

### 代码事实

```ts
// container-registry.ts:223-235
const entry: ContainerEntry = { userId, containerName: name, state: 'running', ..., connectionDead: false };
this.entries.set(userId, entry);                     // ← 先登记为 running
await this.opts.waitSocketReady(userId, c.startTimeoutMs);   // ← 再等 socket；抛错则上面那行已生效
```

`waitSocketReady` 抛错时 `creating` 的 promise 已 reject 并被 `.finally()` 清理，但 `entries` 里的条目留着：`state='running'`、`connectionDead=false`。而连接从未建立过，`onConnectionDead` 也不会回调，`connectionDead` 永远没机会被置 true。

### 问题描述

首次创建超时（正是 BUG-2/BUG-3 发生时的必然路径）后，该用户在进程生命周期内被永久标记为"容器就绪"：后续每次 `ensureRunning` 直接返回毒化条目，不重试 `docker run`、不再等 socket；`DockerToolRouter.dispatch` 随后在 `getConnection()==null` 处抛错，工具调用永远失败。运维即使手动修好 socket/镜像，不重启后端也无法恢复。

### 复现/验证方式

```ts
// review-verify-registry.spec.ts（验证后已删除）：注入必然超时的 waitSocketReady
let waitCalls = 0;
const registry = makeRegistry(base, log, async () => { waitCalls += 1; throw new Error('容器运行时通道连接超时: userId=7 (1000ms)'); });
await expect(registry.ensureRunning(7)).rejects.toThrow(/容器运行时通道连接超时/);   // ✅ 首次如预期抛错
// 第二次：socket 此时已能连上（容器起来晚了），但 registry 直接返回毒化条目
const entry = await registry.ensureRunning(7);
expect(entry.state).toBe('running');                       // ✅ 仍自称 running
expect(log.filter((l) => l.startsWith('run -d')).length).toBe(runCallsBefore);  // ✅ 没有重试
expect(waitCalls).toBe(1);                                 // ✅ 没有再等 socket
```

### 建议修复方向

`createAndStart` 把 `this.entries.set` 移到 `await this.opts.waitSocketReady(...)` 成功之后（超时路径上先 `cleanupHalfCreated(name)` 再抛错）；或在 catch 里 `this.entries.delete(userId)` 并置 `connectionDead`。补回归测试：等待超时后 `getEntry(userId)` 为 undefined，且第二次 `ensureRunning` 会重新 `docker run`。

---

## BUG-5【高】`mcp__*` 被 docker 分支拦截，但容器执行器不支持 MCP 工具，docker 用户 MCP 全灭

### 位置

- 拦截点：`backend-ts/src/harness/tool/tool-dispatcher.ts:339`（`isDockerOnlyTool(toolName)`，位于 sessionTools 查找**之前**）
- 前缀规则：`backend-ts/src/harness/container/docker-tool-router.ts:8-12`（`DOCKER_ONLY_TOOLS` + `mcp__` 前缀）
- 容器侧现实：`backend-ts/src/harness/container/container-tool-executor.ts:78-87`（只注册 shell/read_file/write_file/edit_file/glob_search/grep_search 六个工具）、`:107-111`（未注册工具返回 `ok:true` 的错误串）

### 代码事实

设计 §5.10 的意图是"`mcp__*` 的连接与 `callTool` 都经 `DockerToolRouter` 派发到容器内 runtime agent"——即走 `mcp_connect`/`mcp_call` 协议帧（`container-mcp-bridge.ts` 处理）。但实现把 `mcp__*` 并入了 `isDockerOnlyTool`，于是 `mcp__srv__tool` 被当成普通 `tool_call` 帧发进容器，落在 `ContainerToolExecutor.handleToolCall` 的工具表查找上，表里没有 MCP 工具：

```ts
// container-tool-executor.ts:107-111
const instance = this.tools.get(tool);
if (!instance) {
  return JSON.stringify({ error: `工具 ${tool} 不在容器内执行器支持列表中` });
}
```

注意这是**以 `ok:true` 的工具结果**返回的（`docker-tool-router.ts:84` 原样回传），主模型会把它当普通工具输出，而不是工具失败。同时宿主机 MCP 链路（`RoutingMcpClientManager` → `mcpConnect`/`mcpCall`）被彻底短路：docker 用户连 MCP server 的连接建立都不会发生。

### 问题描述

docker 模式下所有 MCP 工具调用返回"工具 xxx 不在容器内执行器支持列表中"，MCP 功能完全不可用；且错误以成功结果形态出现，排障困难。

### 复现/验证方式

```ts
// review-verify-mcp-dispatch.spec.ts（验证后已删除）：真实 ContainerToolExecutor + 假 dockerRouter
const dockerRouter = { enabledFor: vi.fn(async () => true),
  dispatch: vi.fn(async (tool, args) => executor.handleToolCall(tool, args, envelope)) };
const mcpTool = mockTool('mcp__filesystem__write_file');
mcpTool.execute.mockResolvedValue('{"ok":true,"written":true}');
const result = await dispatcher.dispatch('mcp__filesystem__write_file', '{"path":"a.txt"}',
  'CLOUD', 11, 7, base, null, null, [mcpTool]);
expect(dockerRouter.dispatch).toHaveBeenCalled();        // ✅ 走了 docker 分支
expect(mcpTool.execute).not.toHaveBeenCalled();          // ✅ 宿主 MCP 工具被短路
expect(result).toContain('不在容器内执行器支持列表中');   // ✅ 容器侧返回错误串
// 对照组：enabledFor=false 时同一调用正常执行（证明不是测试写法问题）
```

### 建议修复方向

二选一，需与设计对齐：

- **推荐**：把 `mcp__` 前缀从 `isDockerOnlyTool` 移除，让 `mcp__*` 继续走 sessionTools → `RoutingMcpClientManager`（其 `mcpConnect`/`mcpCall` 已经把连接与调用路由进容器，容器内 `ContainerMcpBridge` 用 `StdioClientTransport` spawn）。这才符合 §5.10"HTTP 型留宿主机、stdio 型进容器"的分工；
- 或：在 `ContainerToolExecutor` 注册 MCP 工具代理（按 `mcp__{server}__{tool}` 反查 server 并转 `mcpBridge.callTool`），并让错误以 `ok:false` 口径回传。

补回归测试：docker 用户调用 `mcp__*` 能拿到真实 MCP 结果（连接在容器内建立）。

---

## BUG-6【高】容器侧从不回 `pty_open_result`，宿主机 `PtyChannelHub.open` 只能等 20s 超时

### 位置

- 宿主机等待方：`backend-ts/src/harness/container/pty-bridge.ts:81-91`（`await this.connection.request({type:'pty_open',...}, PTY_OPEN_TIMEOUT_MS)`，超时 20s，`:6`）
- 容器侧缺口：`backend-ts/src/harness/container/runtime-agent.ts:188-190`（`case 'pty_open': void this.ptyHub.open(frame.ptyId, frame.options)`——只处理不回帧）+ `pty-hub.ts:63-77`（`open` 只可能触发 `sendData`/`sendExit`，没有任何成功 ack）
- 协议与宿主机都就绪：`runtime-channel-protocol.ts:67`（`pty_open_result` 类型定义）、`runtime-channel-server.ts:296`（server 侧 case）

### 问题描述

`pty_open` 是请求/响应语义（宿主机 `request()` 等同名 `pty_open_result`），但容器侧把它当单向帧处理：spawn 成功时没有任何回帧，宿主机必然等到 20s 超时 → `open()` 抛"容器内终端启动失败" → `TerminalManager` 转 `TerminalSpawnError`。docker 用户的云端终端 100% 打不开（叠加 BUG-1 后更无可能）。

### 复现/验证方式

```ts
// review-verify-agent.spec.ts（验证后已删除）：真实 server + 真实 runtime-agent
const conn = server.getConnection(7)!;
const exits: Array<{ ptyId: string; exitCode: number }> = [];
const unsub = conn.onPtyExit((ptyId, exitCode) => exits.push({ ptyId, exitCode }));
const outcome = await conn.request({ v: 1, type: 'pty_open', id: 'open-g', ptyId: 'pty-g',
  options: { shell: '/nonexistent-shell-xyz', args: ['-i'], cwd: '/tmp', cols: 80, rows: 24, env: {} },
}, 2000).then((r) => r, (e) => e as Error);
unsub();
expect(exits).toEqual([{ ptyId: 'pty-g', exitCode: -1 }]);   // ✅ 容器确实处理了 pty_open（spawn 失败走 pty_exit）
expect(outcome).toBeInstanceOf(Error);                       // ✅ 但 pty_open 请求从未被 ack（只可能被连接回收打失败）
expect(agentSource).not.toContain('pty_open_result');        // ✅ 静态佐证：容器侧两个模块零处发送
expect(hubSource).not.toContain('pty_open_result');
```

### 建议修复方向

`PtyHub.open` 返回 spawn 结果（pid 或错误），`runtime-agent` 的 `pty_open` 分支 `await` 后回 `{type:'pty_open_result', id, ok, pid?}` / `{ok:false, error}`。补回归测试：容器内 `pty_open` 成功后宿主机 `PtyChannelHub.open` 能 resolve 且拿到 pid。

---

## BUG-7【中】`mcp_connect` 丢弃 envelope，容器内 MCP stdio 拿不到用户凭据

### 位置

- 根因：`backend-ts/src/harness/container/runtime-agent.ts:180`（`void this.handleMcpConnect(frame.id, frame.sessionId, frame.server, frame.env)`——`frame.envelope` 没往下传）+ `:224-235`（`handleMcpConnect` 签名里没有 envelope 形参）
- 能力已具备未接线：`backend-ts/src/harness/container/container-mcp-bridge.ts:117`（`containerMcpEnv(serverEnv, envelope)` 支持注入 `MAO_TOKEN`/`GIT_TOKEN_*`/`ECP_TOKEN`/`depsEnv`）

### 问题描述

`RuntimeEnvelope` 随 `mcp_connect` 帧到达容器（`runtime-channel-protocol.ts` 的 mcp_connect 帧带 envelope），但 agent 处理时只把 `frame.env`（宿主机白名单 env）传给 bridge，envelope 被丢弃。后果：容器内 spawn 的 MCP stdio 子进程没有任何用户级凭据——需要 git token / MAO_TOKEN / ECP token 的 MCP server 在 docker 模式下全部不可用。§5.10 第 2 条"env 由白名单 + envelope 内的用户凭据组成"只实现了一半。

### 复现/验证方式

```ts
// review-verify-agent.spec.ts（验证后已删除）：spy 住 ContainerMcpBridge.connectAndListTools
const spy = vi.spyOn(ContainerMcpBridge.prototype, 'connectAndListTools').mockResolvedValue([]);
const envelope = { userId: 7, ..., gitTokens: { 'github.com': 'ghp_usertoken' }, maoToken: 'eyJ-user',
                   ecpToken: 'ecp-user', depsEnv: { NPM_CONFIG_PREFIX: '/opt/mao-data/deps/7/npm' } };
// 经真实通道发 mcp_connect（带 envelope），重试直到命中一个稳定窗口
...
const call = spy.mock.calls[spy.mock.calls.length - 1];
expect(call[3]).toBeUndefined();                    // ✅ 第 4 参（envelope）没传
expect(serverEnv.MAO_TOKEN).toBeUndefined();        // ✅ stdio 子进程无 MAO_TOKEN
expect(serverEnv.GIT_TOKEN_github_com).toBeUndefined();  // ✅ 无 git token
expect(serverEnv.NPM_CONFIG_PREFIX).toBeUndefined();     // ✅ 无依赖目录 env
// 对照：bridge 的 env 助手本身支持注入（缺的只是 agent 的传参）
const withEnvelope = containerMcpEnv({ PATH: '/usr/bin:/bin' }, envelope);
expect(withEnvelope.MAO_TOKEN).toBe('eyJ-user');    // ✅
```

### 建议修复方向

`handleMcpConnect` 增加 envelope 形参并在 `connectAndListTools(sessionId, server, env, envelope)` 处透传（`ContainerMcpBridge` 已有对应重载）。补回归测试：容器内 MCP stdio 子进程 env 含 `MAO_TOKEN`/`GIT_TOKEN_<domain>`/`ECP_TOKEN`。

---

## BUG-8【中】`depsEnv` 无 shell/pty 消费方，容器内依赖安装不持久化

### 位置

- 生产方：`backend-ts/src/harness/container/session-envelope-builder.ts:95-104`（`buildDepsEnv` 生成 `NPM_CONFIG_PREFIX`/`PIP_TARGET`/`PIP_BREAK_SYSTEM_PACKAGES`/`MAO_DEPS_BIN`）
- 唯一消费方：`backend-ts/src/harness/container/container-mcp-bridge.ts:117`（且因 BUG-7 实际也拿不到 envelope）
- 缺失方：`backend-ts/src/harness/shell/shell-session-manager.ts:667-675`（shell 会话 env 装配：`sanitizeInheritedEnv(process.env)` + git token，无 depsEnv）、`backend-ts/src/harness/terminal/terminal-manager.ts:381-390`（`buildEnv` 同样没有）

### 问题描述

设计 §5.13 要求"pip/npm 安装位置指向每用户挂载的 `/deps` 目录，容器重建后依赖不丢"。实现只把四个变量打进 envelope，没有任何地方把它们注入 shell/pty 子进程：容器内 `npm i -g` 装进镜像可写层（容器 stop 即丢）、`pip install` 落系统目录。`/deps` 挂载（`container-mount-planner.ts:51`）实际只被 MCP 分支（还坏了）用到。注释"PATH 注入由容器侧拼接"（`session-envelope-builder.ts:101`）所指的容器侧拼接代码不存在。

### 复现/验证方式

```ts
// review-verify-executor.spec.ts（验证后已删除）：真实 bash exec 经 ContainerToolExecutor
const depsEnv = { NPM_CONFIG_PREFIX: join(base, 'deps', '7', 'npm'), PIP_TARGET: join(base, 'deps', '7', 'py'),
                  PIP_BREAK_SYSTEM_PACKAGES: '1', MAO_DEPS_BIN: join(base, 'deps', '7', 'npm', 'bin') };
const result = await executor.handleToolCall('shell', JSON.stringify({
  action: 'exec',
  command: 'echo "NPM=[$NPM_CONFIG_PREFIX] PIP=[$PIP_TARGET] BRK=[$PIP_BREAK_SYSTEM_PACKAGES] BIN=[$MAO_DEPS_BIN]"',
  yield_time_ms: 8000 }), envelopeOf(7, workspace, depsEnv));
expect(parsed.output).toContain('NPM=[]');   // ✅ 四个变量全空
expect(parsed.output).toContain('PIP=[]');
expect(parsed.output).toContain('BRK=[]');
expect(parsed.output).toContain('BIN=[]');
// 对照：git token 走同一条 envelope 链却能注入（证明链路通，缺的只是 depsEnv 接线）
expect(JSON.parse(withToken).output).toContain('TOK=[ghp_probe]');   // ✅
```

### 建议修复方向

在 `ShellSessionManager.createSession` 的 env 装配处接收 depsEnv（经 `ShellSessionTool` 从 `currentEnvelope.depsEnv` 取，与 git token 同机制），并把 `MAO_DEPS_BIN` 前置进 `PATH`；`TerminalManager.buildEnv` 同步补齐。补回归测试：容器内 shell 可见四个变量且 PATH 含 deps bin。

---

## BUG-9【中】pty 退出码被硬编码为 0，docker 用户端永远显示 exit 0

### 位置

- 根因：`backend-ts/src/harness/container/pty-bridge.ts:67-73`（`connection.onPtyExit((ptyId) => { ...; exit?.({ exitCode: 0 }); })`——监听器签名里的 `exitCode` 被丢弃）
- 消费方：`backend-ts/src/harness/terminal/terminal-ws-handler.ts:346-352`（`handleTerminalExit` 把 exitCode 通过 WS `{type:'exit', terminalId, exitCode}` 推给客户端）；`remote-terminal.ts:161-169` 原样透传

### 问题描述

容器回报的 `pty_exit` 帧带真实 `exitCode`（`runtime-channel-protocol.ts`、`pty-hub.ts:69-72` 的 `sendExit(ptyId, exitCode ?? -1)`），宿主机分发时统一改写为 0。host 模式下 node-pty 的 `onExit` 原样透出真实码，因此 docker 用户执行 `exit 42` 后客户端仍看到 exit 0——云端终端的退出状态在两种运行时下行为不一致。

### 复现/验证方式

```ts
// review-verify-pty.spec.ts（验证后已删除）：假连接 + 真实 PtyChannelHub
const conn = new FakeConnection(7);
const hub = new PtyChannelHub(conn);
const pty = await hub.open(7, OPTIONS);
const observed: Array<{ exitCode: number }> = [];
pty.onExit((e) => observed.push(e));
conn.emitPtyExit(pty.ptyId, 42);            // 容器回报真实退出码 42
expect(observed).toEqual([{ exitCode: 0 }]);  // ✅ 宿主机收到的是 0
expect(observed[0].exitCode).not.toBe(42);    // ✅
```

### 建议修复方向

`connection.onPtyExit((ptyId, exitCode) => { ...; exit?.({ exitCode }); })`。补回归测试：容器回报 42 → WS 推送 exitCode 42。

---

## BUG-10【中】`ptyChannelHubs` 缓存绑定过期连接，连接回收后终端链路坏死

### 位置

- 根因：`backend-ts/src/create-app.ts:1065-1076`（`ptyChannelHubs` Map 按 userId 缓存 `PtyChannelHub`，hub 在首次创建时绑定当时的那条 `ChannelConnection`，之后连接被替换也不刷新）
- 结构成因：`pty-bridge.ts:62-75`（hub 构造即订阅固定连接的 `onPtyData`/`onPtyExit`，无换连接能力）

### 问题描述

`PtyChannelHub` 与连接是一对一绑定的。docker 模式下连接会被频繁替换（BUG-1 每 500ms 一次；容器重建时也会换）。缓存 hub 持有死连接后：

1. 新终端 `hub.open()` 走死连接 `request()` → 抛 `Runtime channel not connected` → `TerminalSpawnError`，终端创建失败；
2. 已打开终端的 `write`/`resize` 经死连接 `send()` 静默丢弃（`ConnectionImpl.send` 对 `!alive` 直接 return），用户输入无响应；
3. 新连接上的 `pty_data`/`pty_exit` 没有任何 hub 订阅，终端输出/退出事件丢失。

### 复现/验证方式

```ts
// review-verify-pty.spec.ts（验证后已删除）：复刻 create-app.ts:1065-1082 装配
const hubs = new Map<number, PtyChannelHub>();
const openPty = async (connection: ChannelConnection) => {
  let hub = hubs.get(7);
  if (!hub) { hub = new PtyChannelHub(connection); hubs.set(7, hub); }
  return hub.open(7, OPTIONS);
};
const conn1 = new FakeConnection(7);
const pty1 = await openPty(conn1);
conn1.close();                                  // 连接被回收（BUG-1 / 容器重建）
const conn2 = new FakeConnection(7);
await expect(openPty(conn2)).rejects.toThrow(/Runtime channel not connected/);  // ✅ 新 open 走死连接
pty1.write('ls\n'); pty1.resize(100, 40);
expect(conn1.sent).toEqual([]);                 // ✅ 旧 pty 写入静默丢弃
// 只有按新连接重建 hub 才能恢复
const hub2 = new PtyChannelHub(conn2);
hub2.subscribeData('pty-x', (d) => received.push(d));
conn2.emitPtyData('pty-x', 'hello-from-container');
expect(received).toEqual(['hello-from-container']);   // ✅
```

### 建议修复方向

缓存 key 从 userId 改为 `userId + connection`（或让 hub 持有"当前连接"的 setter，连接替换时迁移订阅）；更根本的随 BUG-1 修复后连接不再频繁替换，风险大降，但容器重建路径仍需处理。补回归测试：连接替换后新终端可打开、旧终端输入可达新连接。

---

## BUG-11【中低】容器内沙箱允许根是全局父目录，非设计 §5.5 的每用户根

### 位置

- 根因：`backend-ts/src/harness/container/container-tool-executor.ts:47-52`

```ts
this.pathSandbox = new PathSandbox(roots.workspaceRoot, { strict: true });
this.runtimeResolver = new RuntimeDataResolver(roots.runtimeDir, roots.userHomeDir);
this.pathSandbox.addAllowedRoot(roots.runtimeDir);      // ← /opt/mao-data/runtime（全部用户）
this.pathSandbox.addAllowedRoot(roots.userHomeDir);     // ← /opt/mao-data/users（全部用户）
this.pathSandbox.addAllowedRoot(roots.userSkillsDir);   // ← /opt/mao-data/userskills（全部用户）
this.pathSandbox.addAllowedRoot('/tmp');
```

设计 §5.5 的允许根是 `{workspaceRoot}/{userId}`、`/opt/mao-data/users/{userId}`、`/opt/mao-data/runtime/{userId}`、`/opt/mao-data/userskills/{userId}`、`/tmp`——即**每用户子目录**。实现把四个全局父目录直接登记为允许根（`PathSandbox.resolve` 对绝对路径只校验"在 workspaceRoot 或某个允许根之下"，`path-sandbox.ts:50`）。

### 问题描述

user 7 的容器执行器可以读取 `users/8/**`、`runtime/8/**`、`userskills/8/**`。当前生产中被挂载清单挡住（只挂 `{root}/{userId}`，容器内看不见别的用户目录），因此不构成现实越权；但这是设计明确的隔离要求被违反、纵深防御缺失：一旦挂载策略调整（如挂整个 users 根做运维）或沙箱被其它路径复用，立即变成真实跨用户读取。另注：workspace 分支因 `envelope.workspace` 把有效根收窄成 `{workspaceRoot}/{userId}` 恰好挡住，三个全局根挡不住。

### 复现/验证方式

```ts
// review-verify-executor.spec.ts（验证后已删除）
const executor = new ContainerToolExecutor({ workspaceRoot: join(base,'workspace'), runtimeDir: join(base,'runtime'),
  userHomeDir: join(base,'users'), userSkillsDir: join(base,'userskills') });
writeFileSync(join(base,'users','8','secret.txt'), 'other-user-home');
const home = await executor.handleToolCall('read_file', JSON.stringify({ path: join(base,'users','8','secret.txt') }),
  envelopeOf(7, workspace, {}));
expect(JSON.parse(home)).not.toHaveProperty('error');   // ✅ user 7 读到了 user 8 的家目录
// runtime/8、userskills/8 同样放行；workspace/8 因 sessionWorkspace 收窄被挡（对照）
```

### 建议修复方向

构造时按 userId 登记每用户根：`addAllowedRoot(join(roots.runtimeDir, String(userId)))` 等四处 + `/tmp`；`PathSandbox` 基座也应是每用户 workspace（或依赖 `envelope.workspace` 收窄，但显式登记更稳）。`RuntimeDataResolver` 的用法同步核对。补回归测试：user 7 读 `users/8/**` 被 `SecurityException` 拒绝。

---

## BUG-12【低】host 模式下每个 docker-only 工具调用都多一次查库，"host 零变化"被破坏

### 位置

- 根因：`backend-ts/src/harness/container/docker-tool-router.ts:47-53`（`enabledFor` 每次调用都 `runtimeModeLookup.runtimeModeOf(userId)`，无缓存）
- 查库实现：`create-app.ts:1033-1039`（`runtimeModeOf` → `userRepo.findById(userId)`）
- 触发面：`tool-dispatcher.ts:339`（每个 shell/read_file/write_file/edit_file/glob_search/grep_search/`mcp__*` 调用都先过 `enabledFor`）

### 问题描述

全局 `MAO_CLOUD_RUNTIME=host`（默认关闭态）时，docker 分支虽会短路，但短路前每遇 docker-only 工具就多一次 `userRepo.findById`。设计 §5.7.1 要求"host 模式下该分支整体短路，行为与现状一致"——功能语义没变，但每次工具调用多一次 DB 往返（高频工具上是实打实的额外负载与延迟），属于 host 模式非零变化。

### 复现/验证方式

```ts
// review-verify-registry.spec.ts（验证后已删除）
const findById = vi.fn(async () => ({ runtimeMode: null }));
const router = new DockerToolRouter({ ..., runtimeModeLookup: { runtimeModeOf: async (userId) => {
  const user = await findById(userId);
  return user?.runtimeMode === 'docker' || user?.runtimeMode === 'host' ? user.runtimeMode : null;
} }, globalMode: () => 'host' });
await router.enabledFor(7); await router.enabledFor(7); await router.enabledFor(7);
expect(findById).toHaveBeenCalledTimes(3);   // ✅ 无任何缓存，每次都打库
```

### 建议修复方向

`enabledFor` 加短 TTL 缓存（如 5~10s，按 userId；用户改 runtime_mode 后最多延迟一个 TTL 生效，可接受）；或全局 host 时直接短路不查库（用户级覆盖仅在有灰度需求时启用查询，可用一个配置开关控制）。补回归测试：TTL 内重复判定只查库一次。

---

## 附录 A：次要观察（不单列 BUG，建议顺手处理）

| # | 位置 | 观察 |
| --- | --- | --- |
| A-1 | `runtime-channel-server.ts:237-243` | 心跳先 `missedPongs += 1` 再发 ping，`> HEARTBEAT_MISS_LIMIT`（3）→ 实际第 4 次未响应（120s）才判定异常，设计 §5.4 为"连续 3 次"（90s）。差一个 off-by-one。 |
| A-2 | `container-mount-planner.ts:91-93` | `if (ro && mount.mode !== 'ro')` 是永假死代码（`ro` 即由 `mount.mode === 'ro'` 得出）。rw 覆写 dist/skills 的防护实际由 userId 段规则（:94-100）兜住，功能无虞，建议删死代码或改为校验 mode 取值合法。 |
| A-3 | `runtime-agent.ts:74-81` | `runtime_status` 每 10s 一条，叠加 BUG-1 后完全发不出去，`ContainerRegistry` 的 idle 忙等保护（§5.3.1）实际失效——修复 BUG-1 后需补一条"容器内有活跃 shell 时不被 idle 回收"的回归测试。 |
| A-4 | `docker-tool-router.ts:60-85` | `dispatch` 成功后 `entry.lastUsedAtMs = Date.now()` 在 `await` 之后，若连接在 await 期间被换（BUG-1 下必然），`entry` 可能是旧对象；修复 BUG-1 后此点自然消解，也可把刷新移到 ensureRunning 返回处更稳。 |
| A-5 | `container-registry.ts:196-212` | `docker run` 未传 `-e MAO_CHANNEL_TOKEN`，依赖 `{channelDir}/{userId}/.token` 文件回落（该目录按用户挂载，链通）。建议在 run 参数里显式注入 token，少一条隐式文件依赖。 |

## 附录 B：验证过程与测试证据

- 临时验证 spec（共 6 文件 16 条测试，全部通过；按"只审查不修改"要求，验证后已全部删除，`git status` 干净）：
  - `review-verify-agent.spec.ts`（4 条）：BUG-1 两条（在途失败+连接替换 / 回收后响应写不出）、BUG-6、BUG-7。用真实 `RuntimeChannelServer` + 真实 `runtime-agent.ts`（env 注入临时 roots），pty 观测需在连接首个 ~500ms 生命周期内发送（回收后容器侧发送即失效，这正是 BUG-1 的证明）。
  - `review-verify-registry.spec.ts`（4 条）：BUG-4、BUG-2、BUG-3、BUG-12。
  - `review-verify-pty.spec.ts`（2 条）：BUG-9、BUG-10（假连接复刻 `create-app` 装配）。
  - `review-verify-executor.spec.ts`（2 条）：BUG-8（真实 bash exec）、BUG-11。
  - `review-verify-mcp-dispatch.spec.ts`（2 条）：BUG-5（真实 `ContainerToolExecutor`）+ host 对照组。
  - `review-verify-protocol.spec.ts`（2 条）：帧编解码/并发/超时基础探针（未发现缺陷，作对照）。
- 全量回归：`cd backend-ts && npm test` → `Test Files 332 passed | 1 skipped (333)` / `Tests 4010 passed | 13 skipped (4023)`，exit=0（存量测试零回归；基线 326 文件 / 3996 测试）。
- 环境备注：本机 vitest 内 node-pty 真实 spawn 失败（`posix_spawnp failed`），pty 相关验证以 spawn 失败路径 + 帧级观测完成，不影响结论（BUG-6 的证明不依赖成功 spawn）。
