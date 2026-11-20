# 脚本探针按运行模式进入容器技术方案

- 状态：已实施（2026-11-10，0.0.503）
- 日期：2026-11-10
- 需求来源：脚本哨兵在 Docker 运行模式下仍由后端进程 `spawn('bash')`，与该模式「用户执行进每用户容器」的隔离边界不一致。本方案取代 [Shell 脚本探针技术方案](2026-11-10-shell-script-signal-watcher-technical-design.md) §2.2 第 2 条与 §8 第 1 条；该文其余条款（探针契约、路径校验、判定管线、间隔下限）继续有效
- 规模：后端约 450 行（通道帧 + 容器内执行 + 路由 + 基础设施失败记账）+ 单测；**零迁移、零新依赖、桌面 / 管理后台 / CLI / 安卓零改动**
- 关联：`backend-ts/src/signal/script-probe.ts`、`backend-ts/src/signal/watcher.service.ts`、`backend-ts/src/harness/container/`、`backend-ts/src/app-openapi-services.ts`、`skills/mao-cli/reference/signal-watcher.md`、`DEPLOY.md`

## 1. 需求背景

Shell 脚本哨兵到点后由后端进程执行 `spawn('bash', [脚本绝对路径])`（`signal/script-probe.ts`）。运行环境切到 Docker 时，会话里的 Shell / 文件工具 / MCP / 终端进入该用户该 Agent 的 `mao-runtime` 容器（`DockerToolRouter.enabledFor`，`docker-tool-router.ts:67-78`）；脚本探针不读这个判定，仍以后端同一系统用户在宿主机执行。

容器隔离靠挂载清单、cgroup 和网络命名空间（`Dockerfile.runtime` 容器内 root，`container-registry.ts` 的 `--memory` / `--cpus` / `--pids-limit` / `--network`）。脚本探针绕过这三层：能读后端用户可读的路径（含其他用户工作区与后端配置，权限允许时），并使用宿主机网络。环境变量白名单只挡住「后端进程 env 整包下发」，挡不住进程起来之后的文件系统和网络。路径校验只约束被执行的那个文件落在本人 `projects/` 内。

这是脚本探针方案里明确接受、并用 DEPLOY.md 声明的缺口，不是漏实现。本方案把 Docker 模式的脚本探针收回与 Shell 工具相同的容器边界，探针契约不变。

硬约束：

- **HTTP 哨兵零行为变化。**
- **host 模式（含用户级覆盖为 host）的脚本探针零行为变化**，仍走现有 `executeScriptProbe`。
- **判定、调度器、触发、自动停用阈值、退避公式零改动。** 只有「容器基础设施失败」新增一条不计入连败的记账（§3.4）。
- **失败不得回退到宿主机执行。** 容器起不来、通道断开、运行时版本不一致，本轮记基础设施失败，下轮再试。

## 2. 需求描述

### 2.1 目标（全部要做）

1. **按哨兵属主分流**：有效运行模式为 docker 时，在该哨兵的 `(userId, agentId)` 容器内执行同一套 `executeScriptProbe`；为 host 时保持宿主机 `spawn`。判定口径与 `DockerToolRouter.enabledFor` 相同（用户级 `user.runtime_mode` 优先，空则跟随全局 `runtime.mode`）。
2. **通道新增一次性帧 `script_probe` / `script_probe_result`**：协议版本保持 `v = 1`。帧内不带 `RuntimeEnvelope`（不送 git token、MAO token、ECP token、飞书 UAT、用户环境变量）。
3. **容器内复用 `executeScriptProbe`**：cwd、stdin 关闭、独立进程组、超时 SIGKILL、stdout 1MB、stderr 8KB、exit code 语义与宿主机逐项一致。容器侧用镜像 PATH 加本人 `MAO_DEPS_BIN`，不用宿主机 PATH，也不继承 `runtime-agent` 进程 env。
4. **容器内再验一次脚本路径**：`realpath` 之后必须落在本人 `{workspaceRoot}/{userId}/projects` 内。
5. **探针占用容器忙状态**：`runtime_status` 增加 `scriptProbes`，进行中的探针挡住 idle 回收、生命周期回收和代码漂移重启。
6. **基础设施失败与脚本失败分开记账**：脚本非 0、超时、超限、路径非法仍走既有 `recordFailure`（连败 + 退避 + 五次停用）。容器未就绪、版本待升级、通道超时只写轮询记录并推进 `last_checked_at`，不增加 `consecutive_failures`，不停用。
7. **「立即测试」走同一条分流**。基础设施失败放进现有 `WatcherTestResult.error`，不写库。
8. **文档**：`skills/mao-cli/reference/signal-watcher.md` 与 `DEPLOY.md` 里「与运行模式无关、一律宿主执行」的句子改成按模式分流；`CHANGELOG.md` 在实施任务里补一节。

### 2.2 非目标（明确不做）

1. **不改 host 模式的执行位置。** host 模式下云端 Agent 的 Shell 本来就在宿主机执行，脚本探针与它同级。要封住 host，需要另一套强制沙箱，本批次不做。
2. **不改容器内用户。** 镜像以 root 运行（`Dockerfile.runtime`）。脚本与 Shell 工具一样是容器内 root，隔离边界是挂载、cgroup 和网络命名空间。`/proc/1/environ` 可读到 `MAO_CHANNEL_TOKEN` 是 Shell 工具既有面，本批次不另做 hidepid 或独立沙箱用户。
3. **不把探针改走 `shell` 工具帧。** Shell 工具的输出是会话 JSON、带 envelope、超时口径不同，套上去会改变判定值。
4. **不用 `docker exec`。** 宿主机杀掉的是 docker 客户端，容器 PID 命名空间里的进程组收不到 `kill(-pid)`。超时回收必须发生在容器内，所以复用 `executeScriptProbe`。
5. **不注入凭据环境变量。** `{{MAO_TOKEN}}` / `{{ECP_TOKEN}}` 与 envelope 里的用户 env 都不进脚本。依赖前缀只给 `buildDepsEnv` 的四个键（§3.2），与「凭据不进脚本」不冲突。
6. **不做脚本内容审查、命令白名单、并发配额。** 每哨兵单飞、硬超时、容器 `--pids-limit` 已覆盖。
7. **不改桌面、管理后台、CLI、安卓。** 失败原因继续走轮询记录的 `error` 与测试结果的 `error`，两端已展示。
8. **不新增数据库列、不改调度扫描 SQL。**

## 3. 技术选型与决策

### 3.1 决策表

| 决策点 | 定案 | 理由 / 证据 |
|---|---|---|
| 分流口径 | 复用 `DockerToolRouter.enabledFor(userId)`，不在哨兵里重写一套 | 用户级覆盖与全局模式的组合已经在 `docker-tool-router.ts:67-78` 定死。两套判定会出现「Shell 在容器、探针在宿主」或反过来 |
| 容器键 | `(watcher.userId, watcher.agentId)` | 容器按 (用户, Agent) 建（`container-registry.ts` `containerName`）。项目工作区在 `{workspaceRoot}/{userId}` 下，标准挂载已覆盖，不需要附加 workspace |
| 执行函数 | 容器内直接调用 `executeScriptProbe` | 超时、进程组、stdout 上限、stdin、cwd 已在 `script-probe.ts` 定案。复制一份会漂移 |
| 传输 | 新帧 `script_probe`，`v` 仍为 1 | 既有帧按 `type` 分发（`runtime-agent.ts:222`）。加类型是加法；旧 agent 对未知 type 只打日志不回包，所以宿主必须先看版本再发（§3.3） |
| 不带 envelope | 帧只含脚本路径、超时、白名单 env、依赖前缀 | `RuntimeEnvelope` 含 git token / MAO token / ECP token / 飞书 UAT（`runtime-channel-protocol.ts:14-33`）。探针用不到，下发即扩大泄露面 |
| PATH | 容器内：进程启动时捕获的镜像 PATH，前置本人 `MAO_DEPS_BIN`。宿主机：维持 `scriptProbeEnv` 现有行为（后端进程 PATH） | 把宿主机 PATH 送进容器会找不到镜像里的 bash/python，或指到容器内不存在的路径。依赖 bin 与 Shell 工具同源（`session-envelope-builder.ts` `buildDepsEnv`） |
| 版本不一致 | 不发帧、不回退宿主。`ensureRunning` 对空闲容器的既有漂移重启照常发生；重启后版本一致再执行 | `applyRuntimeBuildUpgrade` 在容器忙碌时跳过（`container-registry.ts:544-546`）。旧 agent 不认识新帧，干等会把超时吃满（最长 300s） |
| 基础设施失败 | 写 check 行 + 把 `last_checked_at` 写成当前时刻；不动 `consecutive_failures`、哈希、状态 | 到期条件是 `last_checked_at < now - interval_minutes`（`signal.repository.ts:141-152`）。不推进时间戳会每 30 秒打一次 Docker。计入连败会在发版或 Docker 故障时把哨兵停用 |
| 脚本超时起算 | 从容器内 `executeScriptProbe` 启动 bash 起算，不含拉起容器的时间 | 冷启动算进用户配置的 5~300 秒会把正常脚本打成超时 |
| 忙状态 | `runtime_status.scriptProbes` 计入 `isBusy` | 探针最长 300 秒。不计入则 idle 回收或漂移重启会杀掉正在跑的 bash |

### 3.2 帧与环境变量

请求（宿主 → 容器）：

```ts
{
  v: 1,
  type: 'script_probe',
  id: string,                  // newFrameId('probe')
  scriptPath: string,          // 宿主已 realpath，绝对路径
  timeoutSeconds: number,      // 哨兵配置，5~300，缺省 60
  env: {                       // 只有这些键，多出来的容器丢弃
    HOME?: string,
    TZ?: string,
    MAO_WATCHER_ID: string,
    MAO_WATCHER_NAME: string,
  },
  deps: {                      // buildDepsEnv(depsDir, userId) 的四键，路径由容器再验
    NPM_CONFIG_PREFIX: string,
    PIP_TARGET: string,
    PIP_BREAK_SYSTEM_PACKAGES: '1',
    MAO_DEPS_BIN: string,
  } | null,
}
```

响应（容器 → 宿主）：

```ts
{
  v: 1,
  type: 'script_probe_result',
  id: string,
  failureClass: 'script' | 'infrastructure',
  ok: boolean,
  exitCode: number | null,
  stdoutBase64: string | null, // 仅 ok 时有值；原始字节，避免 utf8 往返改变 HASH
  error: string | null,
  durationMs: number,          // bash wall clock，不含拉起容器
}
```

宿主收到 `stdoutBase64` 后解码。解码长度超过 1MB 按脚本失败「输出超限」处理，丢弃字节。`failureClass = 'script'` 映射回现有 `ScriptProbeResult`，判定管线不动。`failureClass = 'infrastructure'` 走 §3.4。

容器侧环境变量组装（在调用 `executeScriptProbe` 之前）：

| 变量 | 来源 | 校验失败时 |
|---|---|---|
| `PATH` | 模块加载时捕获的 `process.env.PATH`（镜像默认）。`deps.MAO_DEPS_BIN` 的 realpath 落在 `{depsDir}/{本容器 userId}` 内才前置 | 前缀不合法则只用镜像 PATH，探针照常跑 |
| `HOME` | 帧内 `env.HOME` | realpath 不在 `{userHomeDir}/{本容器 userId}` 内则丢掉 HOME |
| `TZ` | 帧内 `env.TZ`，缺省不设 | — |
| `MAO_WATCHER_ID` / `MAO_WATCHER_NAME` | 帧内原样 | 缺一不可；缺了按 infrastructure 回「探针参数不完整」，不执行 |
| `NPM_CONFIG_PREFIX` / `PIP_TARGET` | 帧内 `deps` | realpath 必须在本人 deps 目录内，否则丢掉该键 |
| `PIP_BREAK_SYSTEM_PACKAGES` | 仅当值是 `1` 时写入 | 其他值丢弃 |

`MAO_CONTAINER_USER_ID` 取容器自己的环境变量，不取帧里的用户 id。本容器 userId、`MAO_WORKSPACE_ROOT`、`MAO_USER_HOME_DIR`、deps 根都来自容器启动时注入的 env（`container-registry.ts:798-806`），不信任帧。

脚本路径：`realpath` 后必须是普通文件，且 `isUnder(real, {workspaceRoot}/{userId}/projects)`。否则 `failureClass = 'script'`，error 与宿主「脚本路径越出项目工作区」同一句，计入连败。这只约束入口文件。bash 跑起来之后能读的范围等于该容器的挂载清单，与 Shell 工具相同。

### 3.3 版本闸门

`ensureRunning` 返回后：

1. `entry.runtimeBuild === entry.hostRuntimeBuild` 且两者都非空：发帧。
2. 其他情况（旧 agent 未上报、代码漂移、自动升级被跳过、manifest 缺失）：不发帧，本轮基础设施失败，error = `容器运行时版本待升级，本轮跳过`。

`ensureRunning` 内部对空闲容器的漂移重启（`container-registry.ts:417-418`）保持原样。重启成功后 build 一致，同一次调用里就可以发帧。容器忙碌导致升级推迟时，本轮跳过，不把用户配置的超时耗在一个不会回包的旧 agent 上。

自动升级关闭时同样不回退宿主。运维需在「容器管理」里重建容器后，脚本哨兵才会恢复执行。

宿主等待帧的超时 = `timeoutSeconds * 1000 + 15_000`。多出来的 15 秒只覆盖通道开销，脚本自己的超时仍按配置在容器内触发。通道先断开时，`PendingRegistry.failAll` 让宿主立刻记基础设施失败；容器内的计时器继续负责杀掉进程组。

### 3.4 失败记账

| 情况 | check 行 | `consecutive_failures` | `last_checked_at` | 自动停用 |
|---|---|---|---|---|
| exit 0，判定成功 | 既有成功路径 | 清零（既有） | 既有 `markChecked` | 否 |
| 路径非法、文件缺失、非 0、超时、超限、无法启动 bash | 既有 `recordFailure` | +1 | 既有退避（间隔 × min(2^次数, 32)） | 满 5 次（既有） |
| 容器未就绪、版本待升级、通道超时、回包缺字段 | 新写一行：`exit_code = null`，`error` 为原因，`changed = 0` | 不动 | 写成当前时刻（新方法，不改哈希和状态） | 否 |
| 「立即测试」遇到上一行 | 不写库 | 不动 | 不动 | 否，原因放进 `WatcherTestResult.error` |

基础设施失败不使用 `recordFailure`。那个方法会累加连败并在满 5 次时停用（`watcher.service.ts:736-768`）。

`last_checked_at = now` 让下一轮至少隔一个 `interval_minutes`（脚本哨兵最短 5 分钟），避免 30 秒扫描打满 Docker。已有的连败次数保留：下一回真正的脚本失败仍按原指数退避。

### 3.5 行为变化（收口隔离所必需，对用户可见）

Docker 模式的脚本从「宿主机后端用户」改为「该用户该 Agent 的容器」：

- 看得见的文件 = 该容器挂载（本人工作区、HOME、runtime、deps、上传、本 Agent 的 share 与技能视图、只读 dist、`/tmp`）。其他用户目录和后端配置不再可见。
- 网络 = 容器网络，加上既有的 hosts 注入。不再是宿主机网络命名空间。
- PATH = 镜像自带命令（bash、git、coreutils、curl、python3）加本人 deps 里的全局 CLI。宿主机额外安装的二进制不再可见。
- 有活跃脚本哨兵时，`ensureRunning` 会刷新 `lastUsedAtMs`（`container-registry.ts:420`）。间隔短于空闲回收时间（默认 60 分钟，脚本最短 5 分钟）的哨兵会把对应容器保持在运行。这是为了避免每轮冷启动。

host 模式、以及被单独指定为 host 的用户，以上四条都不发生。

## 4. 实现步骤

### 步骤 1：协议帧

`backend-ts/src/harness/container/runtime-channel-protocol.ts`

1. `RuntimeRequestFrame` 增加 `script_probe`（形状见 §3.2）。
2. `RuntimeResponseFrame` 增加 `script_probe_result`。
3. `runtime_status` 增加可选字段 `scriptProbes?: number`。旧 agent 不发这个字段。
4. `validateFrame` 仍只验 `v` 与 `type`（现状）。字段形状由收发双方在处理函数里验，不在解码器里加分支。

`runtime-channel-server.ts`：

1. `RuntimeStatus` 增加 `scriptProbes: number`。
2. `handleFrame` 的 `runtime_status` 分支读 `frame.scriptProbes ?? 0`。
3. `script_probe_result` 与 `tool_result` 一样 `pending.resolve`。

### 步骤 2：容器内执行

新建 `backend-ts/src/harness/container/script-probe-dispatch.ts`，并把它加进 `container-import-constraints.spec.ts` 的 `CONTAINER_MODULES`。

职责：

1. 用本容器 env 的 `MAO_CONTAINER_USER_ID`、`MAO_WORKSPACE_ROOT`、`MAO_USER_HOME_DIR`、deps 根做 §3.2 的路径校验。`isUnder` 直接用 `path-sandbox.ts:203` 的纯函数（三行，无 I/O）。不要从帧里取 userId。
2. 组装白名单 env 后调用 `executeScriptProbe`。禁止把 `process.env` 展开进子进程。
3. 把 `ScriptProbeResult` 收成 `script_probe_result`。路径越界、非文件、`executeScriptProbe` 的超时 / 非 0 / 超限 / 启动失败都是 `failureClass: 'script'`。只有「帧缺字段、本容器 userId env 缺失」才是 `infrastructure`。
4. stdout 用 `stdoutBytes.toString('base64')`。失败时 `stdoutBase64 = null`。

`runtime-agent.ts` 的 `handleFrame` 增加 `script_probe` 分支：

1. 进入时 `scriptProbes++`，立刻 `reportStatus()`（不等 10 秒周期）。
2. `finally` 里减回去并再报一次。计数不为负。
3. `dispose` / `shutdown` 时若仍有探针在跑，现有进程退出会带走子进程；宿主侧通道关闭走基础设施失败。不在本批次加「关机前等探针结束」。

`reportStatus` 的帧带上 `scriptProbes`。

### 步骤 3：忙状态

两处 `isBusy` 都加上 `scriptProbes > 0`：

- `container-registry.ts` 文件级函数（约 `:126`，漂移升级使用）
- `ContainerRegistry.isBusy`（约 `:740`，idle / 生命周期回收使用）

新建条目、停止后清零、漂移重启前清零的 `inContainer` 初值补 `scriptProbes: 0`。缺字段的旧上报按 0。

### 步骤 4：宿主桥

新建 `backend-ts/src/harness/container/container-script-probe.ts`：

```ts
export class ScriptProbeInfrastructureError extends Error {}

export class ContainerScriptProbe {
  enabledFor(userId: number): Promise<boolean>;
  execute(input: {
    userId: number;
    agentId: number;
    scriptPath: string;
    timeoutSeconds: number;
    env: Record<string, string>; // 宿主 scriptProbeEnv 的结果；本类丢掉 PATH
  }): Promise<ScriptProbeResult>;
}
```

依赖（窄接口，测试可注入）：`enabledFor`、`ensureRunning`、`getConnection`、`depsEnvOf(userId)`、`newFrameId`。

`execute` 顺序：

1. `ensureRunning(userId, agentId)`。抛错 → `ScriptProbeInfrastructureError('容器未就绪：…')`。
2. §3.3 版本闸门。不一致 → `ScriptProbeInfrastructureError('容器运行时版本待升级，本轮跳过')`。
3. `getConnection` 为空 → 同样的基础设施错误（`容器运行时通道未连接`）。
4. 从 `env` 只取 `HOME` / `TZ` / `MAO_WATCHER_ID` / `MAO_WATCHER_NAME`，附上 `depsEnvOf` 的四键，发帧。
5. `connection.request(..., timeoutSeconds * 1000 + 15_000)`。超时或通道关闭 → 基础设施错误。
6. 回包 `failureClass === 'infrastructure'` → 基础设施错误。
7. `failureClass === 'script'` → 解码 base64，超 1MB 当成「输出超限」的 `ScriptProbeResult`。返回值交给现有映射。

`depsEnvOf` 在装配时绑定 `buildDepsEnv(cloudRuntimeCfg.container.depsDir, userId)`。

### 步骤 5：哨兵服务接线

`watcher.service.ts` 的 deps 增加可选的 `containerScriptProbe?: ContainerScriptProbe`。未注入时（既有单测）始终走宿主机 `executeScriptProbe`。

`runCheck` 与 `test` 在现有 `resolveScriptForExecution` **成功之后**分流：

1. 路径校验失败维持现状：`runCheck` 走 `recordFailure`，`test` 抛 `BusinessException`。这一步在拉起容器之前，避免为已删除的脚本启动容器。
2. `containerScriptProbe?.enabledFor(userId)` 为 true：调用 `containerScriptProbe.execute`。
3. 得到 `ScriptProbeResult`：与今天宿主机返回值使用同一段映射（`scriptProbeResultToProbeResult`、判定、触发）。
4. 抛 `ScriptProbeInfrastructureError`：`runCheck` 走新的 `recordInfrastructure`；`test` 返回 `{ httpStatus: null, exitCode: null, durationMs, valueHash: null, parseOk: false, sample: '', error: message }`。

`recordInfrastructure`：

1. `checkRepo.insert` 一行，`error` 截断 500 字符，其余判定字段为空 / 0。
2. 新仓储方法 `touchChecked(id)`：`UPDATE signal_watcher SET last_checked_at = ? WHERE id = ? AND status = 'ACTIVE'`，参数是 Node 时钟的当前时刻（与 `markChecked` 同源，不在 SQL 里用 `NOW()`）。不改 `consecutive_failures`、`last_value_hash`、`status`。
3. 更新不到行（哨兵已删或已停用）时删掉刚插入的 check 行，与 `recordFailure` 的孤儿行处理一致。

装配：`assembleContainerRuntime`（`create-app.ts:639`）早于 `assembleOpenApiServices`（`:906`），`dockerRouter` 已经在手。给 `assembleOpenApiServices` 增加参数 `containerScriptProbe`，在 `new WatcherService`（`app-openapi-services.ts:142`）传入。`enabledFor` 直接转调 `dockerRouter.enabledFor`。

### 步骤 6：文档

实施同一任务内改这三处，不改历史方案正文（旧方案文首已指向本文）：

1. `skills/mao-cli/reference/signal-watcher.md` 探测方式表与「执行模型」「安全姿态」两段：Docker 模式在属主容器内执行，host 模式仍在后端宿主执行；失败不回退宿主。
2. `DEPLOY.md` 信号哨兵行：删掉「与用户运行环境模式无关」。改成「Docker 模式在该用户该 Agent 的运行时容器内执行；host 模式仍在后端宿主执行，安全层级与云端 Agent Shell 相同」。ulimit 建议保留给 host 模式。
3. `CHANGELOG.md` 顶部版本的「后端」一节写明分流、基础设施失败不停用、以及 Docker 模式下脚本可见范围与 Shell 对齐。无前端小节。

## 5. 落地清单

| 文件 | 改动 | 类型 |
|---|---|---|
| `backend-ts/src/harness/container/runtime-channel-protocol.ts` | `script_probe` / `script_probe_result`；`runtime_status.scriptProbes?` | 修改 |
| `backend-ts/src/harness/container/runtime-channel-server.ts` | `RuntimeStatus.scriptProbes`；结果帧配对；缺省 0 | 修改 |
| `backend-ts/src/harness/container/script-probe-dispatch.ts` | 容器内路径复核、白名单 env、调用 `executeScriptProbe` | **新建** |
| `backend-ts/src/harness/container/runtime-agent.ts` | 帧分支、`scriptProbes` 计数、状态上报 | 修改 |
| `backend-ts/src/harness/container/container-registry.ts` | 两处 `isBusy`、初值补 0 | 修改 |
| `backend-ts/src/harness/container/container-script-probe.ts` | 宿主桥：模式判定、版本闸门、发帧、错误分类 | **新建** |
| `backend-ts/src/signal/watcher.service.ts` | `runCheck` / `test` 分流；`recordInfrastructure` | 修改 |
| `backend-ts/src/signal/signal.repository.ts` | `touchChecked` | 修改 |
| `backend-ts/src/app-container-runtime.ts` / `create-app.ts` / `app-openapi-services.ts` | 构造桥并注入 `WatcherService` | 修改 |
| `container-import-constraints.spec.ts`、`runtime-agent.spec.ts`、`container-registry.spec.ts`、`watcher.service.spec.ts`、新桥与 dispatch 的 spec | 见 §6 | 修改 / 新建 |
| `skills/mao-cli/reference/signal-watcher.md`、`DEPLOY.md`、`CHANGELOG.md` | §4 步骤 6 | 修改 |
| `script-probe.ts`、`watcher.logic.ts`、`watcher-scheduler.ts`、桌面、管理后台、CLI、安卓、迁移 | **零改动** | — |

## 6. 测试要点

1. **dispatch 单测**（不启 Docker，直接调函数）：本人 projects 内脚本得到与 `executeScriptProbe` 相同的 stdout / exit code；软链指向 projects 外被拒绝且 `failureClass = 'script'`；帧里的 `PATH`、`MAO_CHANNEL_TOKEN` 不会出现在子进程 env（脚本 `printenv`）；`HOME` 越出本人 home 被丢弃；`MAO_DEPS_BIN` 越出本人 deps 不前置；子进程 env 不含 `MAO_CHANNEL_TOKEN`。
2. **runtime-agent 帧**：`script_probe` 期间 `runtime_status.scriptProbes >= 1`，结束后回到 0；未知旧宿主不发该字段时服务端按 0。
3. **isBusy**：`scriptProbes > 0` 时 idle 回收与漂移升级都不停容器；回到 0 后恢复原行为。
4. **桥**：host（`enabledFor` false）不调用 `ensureRunning`；docker 且 build 一致时发帧并还原 stdout 字节（含非 utf8 序列，HASH 与宿主机执行一致）；build 不一致不发帧并抛基础设施错误；`ensureRunning` 抛错、通道超时同样是基础设施错误，且没有第二条「改在宿主执行」的调用。
5. **service**：docker 用户的脚本成功路径仍会建基线、比较、触发，`{diff}` 仍是 stdout；脚本非 0 仍连败并在第 5 次停用；基础设施错误写 check 行、`consecutive_failures` 不变、`last_checked_at` 推进、状态保持 ACTIVE；路径不存在时不调用容器桥；`test` 的基础设施错误只出现在返回值 `error` 里，仓储无写入。
6. **host 回归**：不注入 `containerScriptProbe` 的既有 `watcher.service.spec.ts` 与 `script-probe.spec.ts` 不改断言即可通过。
7. `cd backend-ts && npm run build` 与 `npm test` 通过。无前端改动，不跑 desktop / admin 构建。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| R1 发版窗口旧容器不认识新帧，干等满超时 | §3.3：build 不一致不发帧，立即记基础设施失败。空闲容器由既有漂移重启拉齐后再执行 |
| R2 基础设施失败被算进五次停用，Docker 故障误停哨兵 | §3.4 单独记账，不调用 `recordFailure` |
| R3 不推进 `last_checked_at` 导致每 30 秒打一次 Docker | `touchChecked` 写成当前时刻，下一轮至少隔一个轮询间隔 |
| R4 帧把 envelope 或宿主 PATH 带进容器 | 请求类型不含 envelope；桥只拷贝四个白名单键；容器覆盖 PATH 并不展开 `process.env` |
| R5 帧内路径被改成容器里别的挂载（只读 dist、他人路径） | 容器用自己的 userId 再做 realpath + `isUnder(projects)`，不信任帧内身份 |
| R6 通道超时后容器内脚本继续跑 | 容器内计时器独立 SIGKILL 进程组；宿主超时只结束等待。15 秒余量让正常回包先到 |
| R7 探针把容器闲置回收推迟，多占内存 | 接受。活跃哨兵刷新 `lastUsedAtMs`，避免每轮冷启动吃掉脚本超时。无哨兵的容器回收行为不变 |
| R8 容器内 root 可读 `/proc/1/environ` 的通道 token | 与 Shell 工具同一残留面，§2.2 第 2 条明确不在本批次解决。探针本身不再扩大面：子进程不继承该 env |
| R9 host 模式或用户被指定为 host 时，脚本仍在宿主机 | 与该用户的 Shell 同级，§2.2 第 1 条。本方案修的是 Docker 模式的隔离缺口 |

## 8. 明确不做的（汇总）

1. host 模式改到容器或其它沙箱
2. 容器内降权、hidepid、独立于 `runtime-agent` 的一次性容器
3. 经 `shell` 工具帧或 `docker exec` 执行
4. 凭据与用户环境变量注入
5. 失败后回退宿主机
6. 脚本内容审查、命令白名单、产品化并发配额
7. 桌面 / 管理后台 / CLI / 安卓改动，以及任何数据库迁移
