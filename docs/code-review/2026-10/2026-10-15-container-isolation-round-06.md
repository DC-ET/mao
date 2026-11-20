# 用户运行时容器隔离（docker 模式）代码审查 — round-06（round-05 复审）

- **日期**：2026-10-15
- **基线**：`main @ 91d4f944` → 审查对象 `feature/user-runtime-container-isolation @ 07a4631c`（工作区 `mao/.worktrees/user-runtime-isolation`，`git status` 干净）
- **审查对象**：① `07a4631c`（G-1 修复，重点）；② 前五轮（round-01~05 报告）全部修复的回归核对；③ `git diff f75b366c..HEAD` 全量 diff 中前几轮未覆盖的代码路径：`pty-bridge.ts` / `pty-hub.ts` / `runtime-agent.ts` / `shell-session-manager.ts` / `session-envelope-builder.ts` / `docker-tool-router.ts` / `channel-workspace.ts` / `runtime-channel-server.ts` / `session.repository.ts` / `create-app.ts` 装配层。
- **方法**：① 通读 `07a4631c` 全量 diff 与新回归测试；② 写 6 条测试验证 G-1 闭合且正常失败路径不被破坏（含"新条目首建正常失败的清理是否还被保住"、"warn 分支是否掩盖真实半成品"两个定向问题）；③ 恢复 round-03/04 的复现测试在当前 HEAD 复跑，核对无回归；④ 写 1 条测试证明同家族残留竞态 R-1 真实存在；⑤ 走查未覆盖路径的功能逻辑；⑥ 全量 `npm test` + `npm run build` + `tsc --noEmit`。审查期间未修改任何源码/测试（临时验证 spec 用后即删，`git status` 干净，仅剩本报告）。

---

## 结论概览

- **G-1 修复（`07a4631c`）正确且闭合**：`cleanupFailedStart` 在摘条目后增加「在册条目必须是本人或无人」判定，首建交错下在册是重入方的新条目时跳过 `rm -f` 只记 warn，与世代校验分工明确（世代管"同对象原地重建"、身份管"外层条目从未登记"）。6 条定向测试全部通过（§一）。
- **正常失败路径全部保住**：新条目首建的正常失败（`docker run` 失败 / socket 超时 / 同名冲突重试失败，均无重入）在册无人，照常摘条目 + `rm -f` 清半成品——新校验没有掩盖需要清理的真实半成品（§一测试 2/3/6）。
- **前五轮修复无回归**：round-03 七条复现测试（N-4a/N-4b/N-4c/N-5/N-6/N-7/N-8）、round-04 F-1/F-2 复跑全部通过（§二）。
- **未覆盖路径走查未发现生产可达的功能缺陷**：pty 桥接重连换绑、runtime-agent 握手/重连、deps env 的 PATH 幂等注入、MCP envelope 透传、通道工作区根常量共用等逻辑自洽（§五）。
- **残留观察 R-1【低，不阻塞合入】**：同一"按容器名 `rm -f`"家族还有一个更窄的交错——外层失败清理**先于**重入方登记时，在册无人 → 判定放行 → 仍会 `rm -f` 掉重入方刚建好的容器，在册条目被毒化。已写测试证明真实存在（§四）。可达性需 ALS 重入（生产回调不重入，本需求全家族缺陷的共同前提）+ 亚毫秒级登记/清理时序，且下次调用经 `markConnectionDead` 自愈。建议后续以"在飞创建计数"加固，不要求本 round 处理。
- **对 round-05 报告的一处必要校准（诚实说明）**：round-05 G-1 的实测构造（两次同名 `docker run` 都成功、无 intervening rm）**真实 docker 不可达**——重入方的 `docker run` 必撞同名容器、走冲突分支先 `rm -f` 掉外层容器再重试；真实交错的结果是"双方都成功、外层后写覆盖在册条目（两侧挂载计划同源，终态一致）"或"干净双败"。因此 G-1 的实际严重度低于 round-05 报告的评估；`07a4631c` 作为代码级不变量（不得摧毁在册条目的容器）的加固是正确的，回归测试也有价值（§三）。
- **结论：通过复审。** G-1 已闭合、无回归、无生产可达新缺陷；R-1 为低危残留（生产不可达 + 可自愈 + 需设计级改动），记录在案供后续排期。

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| R-1 | 低（残留，不阻塞） | container-registry | `cleanupFailedStart` 按名 `rm -f` 前只校验"在册条目"，重入方尚未登记时在册无人 → 仍 rm 掉重入方刚建好的容器并毒化在册条目；需 ALS 重入 + 窄时序，可自愈 |

---

## 一、07a4631c 修复核对表

**修复形态**（`container-registry.ts:478-500`）：保留原世代校验（管 recycle 原地重建交错），在 `dropFailedEntry` 之后新增在册身份判定——在册条目是另一对象（首建期间重入方另建并登记）时跳过 `rm -f`，仅 `harnessLog('warn', …)`。与我 round-05 建议的方向一致。

**定向验证矩阵**（6 条测试，对当前 HEAD 全部通过；测试辅助函数与 `container-registry.spec.ts` 同构：标准 roots + fake docker + `startTimeoutMs: 1000`）：

| # | 场景 | 断言 | 结果 |
| --- | --- | --- | --- |
| 1 | G-1 首建交错（外层首建等待期间重入方另建并登记，随后外层超时） | 在册条目 `running`、wsB 已挂载、最后一次 `rm -f` 早于最后一次 `run -d` | 通过（修复生效；作者回归 `keepsReentrantFirstCreateContainerWhenOuterFirstCreateTimesOut` 同构） |
| 2 | **新条目首建正常失败**（`docker run` 抛错、无重入） | 条目不登记 + 半成品容器被 `rm -f`（1 次） | 通过——**正常失败路径的清理仍被保住** |
| 3 | 新条目首建正常失败（`waitSocketReady` 超时、无重入） | 条目摘除 + `rm -f`（1 次） | 通过 |
| 4 | F-2（idle 回收后 `docker start` 报 No such container、无重入） | 条目摘除 + 下次调用 1 次 `run -d` 完整重建 | 通过（无回归） |
| 5 | F-1 原地重建交错（重入 recycle 世代 +1） | 整段跳过、新容器与条目存活、wsB 在册 | 通过（无回归） |
| 6 | 同名冲突重试仍失败（无重入） | 条目摘除 + 2 次 `rm -f`（冲突清理 + 收尾） | 通过 |

**"warn 分支是否会掩盖需要清理的真实半成品"——不会**，论证如下：skip 只在"在册是另一对象"时触发。真实 docker 语义下，重入方若要走到登记，其 `docker run --name mao-user-{userId}` 必与外层已建好的容器**撞名**，进入冲突分支 `cleanupHalfCreated`（`rm -f` 掉外层的容器）再重试——即外层自己的半成品在重入方登记前已被清掉，skip 掉的是一个本来就不该由外层删除的、属于重入方的健康容器，无泄漏、无掩盖。（作者回归测试用的 fake docker 不校验同名，所以测试日志里外层的第一个容器未被清理；但"两个同名容器同时存活"这一交错真实 docker 不可达，见 §三。）

---

## 二、前五轮修复回归核对

**方法**：把 round-03/04 报告的复现测试原样恢复为临时 spec，在当前 HEAD `07a4631c` 复跑。

| 轮次 | 复现测试 | 结果 |
| --- | --- | --- |
| round-03 | N-4a（idle 回收后并发两通道工作区：丢挂载 + 抖动） | 通过 |
| round-03 | N-4b（创建期并发：先到者拿到已删条目） | 通过 |
| round-03 | N-4c（dockerStart 重启超时误伤新容器） | 通过 |
| round-03 | N-5（他人私聊工作区可挂载） | 通过 |
| round-03 | N-6/N-7/N-8（沙箱交互 / 巨量挂载 / 符号链接逃逸） | 通过 |
| round-04 | F-1（createAndStart 失败清理缺世代校验） | 通过 |
| round-04 | F-2（dockerStart 的 docker start 失败卡死 stopped） | 通过（干净版断言：条目摘除 + 下次完整重建；round-04 旧备份测试失败仅因其最后两条断言固化的是 Buggy 行为"第二次调用永远失败、无 run -d"，修复后自然反转为成功自愈，非回归） |
| round-04 观察 O-2 | `inContainer` 忙计数清零（`:462`/`:521`） | 代码未再变动，仍正确 |

---

## 三、G-1 可达性校准（对 round-05 报告的必要修正）

round-05 的 G-1 复现依赖 fake docker 对同名容器不校验：日志里出现两次成功的 `run -d --name mao-user-7`（外层 C1 与重入方 C2 同时"存活"）。真实 docker 的 `--name` 在创建时原子占名，重入方的 `docker run` 必报 "Conflict. The container name … is already in use"，进入 `createAndStart` 的冲突分支：`rm -f` 掉 C1 → 重试 → 建 C2。因此真实交错只有两种结局：

1. **双方都成功**：C2 的 agent 连接后，外层的 `waitSocketReady` 也看到连接（同一 per-user socket）→ 外层成功并把在册条目覆盖为 E_new。两侧挂载计划同源（`sessionWorkspacesOf` 的 DB 查询 + extraWorkspaces 去重，生产库中 wsA/wsB 都在列），终态一致；被覆盖的 E2 仅为被重入调用方持有的孤儿对象，工具派发按 userId 重新取条目，无影响。
2. **干净双败**：C2 的 agent 始终未连上 → 外层超时清理（此时在册无人 → `rm -f` C2）→ 重入方随后也超时清理 → 双方抛错、无条目登记，下次调用全新重建。

即：G-1 报告的毒化终态需要"两个同名容器同时存活"，真实 docker 不可达；该缺陷实际严重度应低于 round-05 的「中」评估（生产不可达、真实交错良性）。`07a4631c` 的修复作为**代码级不变量**（失败清理不得摧毁在册条目所声明的容器）的加固是正确的，新回归测试将该不变量固化，应当保留。

---

## 四、残留观察

### R-1【低，不阻塞合入】外层失败清理先于重入方登记时，按名 `rm -f` 仍会摧毁重入方的容器

**位置**：`harness/container/container-registry.ts:492-499`（`cleanupFailedStart`：`const current = this.entries.get(userId); if (current !== undefined && current !== entry) return;` —— 只覆盖"清理时刻重入方**已登记**"，覆盖不了"重入方**尚未登记**"）。

**问题描述**：首建交错下，外层 `createAndStart` 等待 `waitSocketReady` 期间重入方也走创建分支（真实 docker 下经撞名冲突先清掉外层的容器、再建自己的容器）。若外层先超时失败、而重入方此刻还在等自己的 socket（尚未 `entries.set`），则外层的清理看到"在册无人" → 判定放行 → 按容器名 `rm -f` 掉**重入方刚建好的容器**；随后重入方的 socket 就绪、登记条目 → 在册条目自称 `running`、挂载齐全，而容器已被删——与 G-1 同类的毒化终态，只是交错方向相反（G-1 是"清理晚于登记"，R-1 是"清理早于登记"）。

**可达性与影响（如实说明）**：

- 需 `withUserLock` 的 ALS 重入（生产 `waitSocketReady` 只轮询、`requestShutdown` 只做 WS 往返，两者回调均不重入 `ensureRunning`，**当前生产不可达**——本需求全部重入家族缺陷的共同前提）；
- 在重入前提下还需窄时序：重入方的 agent 连接落在外层最后一次轮询与截止之间（≤200ms 窗口），且重入方的"轮询观察到连接 → 登记"落在外层"截止 → 校验在册 → 发 rm"之后（亚毫秒级竞态）；
- 非永久卡死：`rm -f` 杀死容器 → agent socket 关闭 → `RuntimeChannelServer.drop` → `onConnectionDead`（`create-app.ts:999`）→ `markConnectionDead(7)`（`container-registry.ts:302-305`）→ 在册条目 `connectionDead=true` → 下次 `ensureRunning` 走重建分支自愈；即使 socket 关闭事件尚未处理，`getConnection` 已取不到连接，工具派发快速报错而非悬挂。

**复现/验证方式**（对当前 HEAD `07a4631c` 失败即证明存在）：

```ts
import { describe, expect, it } from 'vitest';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ContainerRegistry, type ContainerRegistryOptions, type DockerCli } from './container-registry.js';
import { useTmpDir } from '../../testing/tmp-dir.js';

function fakeDocker(log: string[]): DockerCli {
  return {
    async run(args) {
      log.push(args.join(' '));
      if (args[0] === 'images') return 'mao-runtime:latest\n';
      if (args[0] === 'version') return '27.0.0\n';
      return 'ok\n';
    },
  };
}

function makeRegistry(base: string, log: string[], overrides: Partial<ContainerRegistryOptions>) {
  for (const d of ['workspace', 'users', 'runtime', 'userskills', 'skills', 'channels', 'dist', 'deps']) {
    mkdirSync(join(base, d), { recursive: true });
  }
  return new ContainerRegistry({
    config: {
      mode: 'docker',
      container: {
        idleMinutes: 60, maxLifetimeHours: 72, memoryMb: 512, cpus: 1, pidsLimit: 100,
        image: 'mao-runtime:latest', network: 'bridge',
        channelDir: join(base, 'channels'), distDir: join(base, 'dist'),
        depsDir: join(base, 'deps'), tmpfsSizeMb: 64, startTimeoutMs: 1000,
      },
    } as ContainerRegistryOptions['config'],
    workspaceRoot: join(base, 'workspace'),
    userHomeDir: join(base, 'users'),
    runtimeDir: join(base, 'runtime'),
    userSkillsDir: join(base, 'userskills'),
    skillsDir: join(base, 'skills'),
    ensureChannelListening: async (u) => join(base, 'channels', String(u), 'runtime.sock'),
    issueChannelToken: () => 'tok-7',
    waitSocketReady: async () => undefined,
    requestShutdown: async () => true,
    ...overrides,
  }, fakeDocker(log));
}

describe('round-06: 残留竞态', () => {
  it('R-1: 外层失败清理先于重入方登记 → 仍按名 rm 掉重入方容器（在册条目被毒化）', async () => {
    const base = useTmpDir('mao-r6-race-');
    const log: string[] = [];
    const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
    const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    let registry: ContainerRegistry | null = null;
    let phase = 0;
    let releaseReentrant: (() => void) | null = null;
    let reentrantSettled: Promise<string> | null = null;
    registry = makeRegistry(base, log, {
      sessionWorkspacesOf: async () => [],
      waitSocketReady: async () => {
        if (phase === 0) return;
        if (phase === 1) {
          phase = 2;
          // 重入方：docker run 已发出（见日志），但其 socket 就绪被推迟到外层放弃之后
          const p = registry!.ensureRunning(7, wsB);
          reentrantSettled = p.then(() => 'ok', (e) => 'fail:' + (e as Error).message);
          await new Promise((r) => setTimeout(r, 20)); // 让重入方跑到 waitSocketReady 并停住
          throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
        }
        // phase === 2：重入方的等待——停住，直到外层已失败并清理完毕
        await new Promise<void>((r) => { releaseReentrant = r; });
      },
    });

    phase = 1;
    log.length = 0;
    await expect(registry.ensureRunning(7, wsA)).rejects.toThrow(/连接超时/);
    // 外层失败时在册无人 → 新身份判定放行 → 按名 rm 掉的是重入方刚建好的容器
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
    expect(lastRm).toBeLessThan(lastRun);   // 实测失败：expected 2 to be less than 1（rm 落在 run 之后）

    releaseReentrant!();
    expect(await reentrantSettled!).toBe('ok');
    // 期望（正确行为）：在册条目声称的容器仍然存在。实际：容器已被外层的按名 rm 删掉
    expect(registry.getEntry(7)?.state).toBe('running');
    expect(registry.getEntry(7)?.mountedPaths.has(wsB)).toBe(true);
  });
});
```

实测输出：外层失败后日志序 `["run -d","run -d","rm -f"]`（`R1_AFTER_OUTER={"lastRun":1,"lastRm":2}`，最后一次 `rm -f` 落在最后一次 `run -d` 之后）；放行重入方后其成功登记，`getEntry(7)` 为 `running` 且挂载 wsB——条目声称的容器已被删。断言 `expected 2 to be less than 1` 失败。

**建议修复方向（设计级，不要求本 round 处理）**：给"在飞创建"记数——`createAndStart` 进入（`docker run` 前）对 `userId` 的 in-flight 计数 +1、`finally` -1；`cleanupFailedStart` 在发 `rm -f` 前若发现该计数 > 1（同用户还有另一次创建/启动在飞、可能拥有该容器名）则同样只记 warn 跳过。这样 G-1（已登记）与 R-1（未登记但在飞）两种交错合并为一道判定。备选：重入方登记前 `docker inspect` 复核容器仍在（每次创建多一次 docker 调用）。

### 次要观察（不构成功能缺陷，不要求处理）

- **O-1**：`PtyBridgePty.kill()` 在连接断开的 20s 宽限窗口内下发不了 `pty_close`（`currentConnection` 为 null，`?.send` 静默丢弃），宿主机侧 `hub.forget` 后容器内 pty 成为孤儿进程，直到容器重建/idle 回收才清理。窗口需 agent 重连才出现，生产影响可忽略。
- **O-2**：容器内交互终端的 env 以 `sanitizeInheritedEnv(process.env)` 为基底（宿主机 PATH 等进入容器 pty，再前置 deps bin）。镜像为 `node:22-bookworm-slim`（`Dockerfile.runtime`），标准路径与宿主机常见 PATH 重合，实际无害；属 `f75b366c` 基线行为、非修复引入。
- **O-3**：`PtyChannelHub` 按 `entry.startedAtMs` 分代（`create-app.ts:1094`）；同毫碰撞理论上会复用旧 hub 导致在飞 pty 不收敛，但重建路径含 `docker stop -t 10`，实际不可能同毫秒。

---

## 五、未覆盖路径走查记录

| 文件（diff 行数） | 走查结论 |
| --- | --- |
| `pty-bridge.ts`（131）/ `pty-hub.ts`（9） | 长生存期 hub + `bindConnection` 换绑迁移订阅、宽限 20s 后才按 -1 收尾在飞 pty、`onClosed` 只通知一次、`dispose` 全量收尾——逻辑自洽；`closedIds` 随 hub 世代重建有界。见 O-1 |
| `runtime-agent.ts`（163） | `connectOnce` 改为"hello_result 后才算就绪连接"（close-before-ready → reject 重连；旧连接晚到的 close 不再清空新 `this.socket`）；15s 握手兜底；重连即补报 `runtime_status`；`pty_open` 请求/响应语义补 `pty_open_result`；`mcp_connect` 透传 envelope（`docker-tool-router.ts:142` 同侧已带）；`isMainModule` 守卫不影响容器入口。未见缺陷 |
| `shell-session-manager.ts`（51） | `refreshEnvironment` 永不 unset PATH；`currentPath` 跟踪 + `applyDepsEnv` 幂等前置（剥历史残留再前置唯一一份，PATH 不随 exec 增长）；spawn 时 PATH 缺失退回 `DEFAULT_CHILD_PATH`；`refreshUserEnvironment` 经 `depsEnvProvider` 回退生效（`shell-session-tool.ts:182/:330` 未显式传参也走提供者），非死代码。host 模式无提供者、行为零变化 |
| `session-envelope-builder.ts`（24） | `buildDepsEnv` 提纯为共用函数（shell 与 pty、MCP stdio 共用），路径与容器挂载逐字节一致（决策 15） |
| `docker-tool-router.ts`（54） | `mcp__*` 移出 `DOCKER_ONLY_TOOLS`（改走 RoutingMcpClientManager，注释已说明理由）；`enabledFor` 5s TTL 缓存 key 含全局模式、语义与旧实现一致；`dispatch`/`readBytes` 带上 `workspace` 参与挂载判定、`lastUsedAtMs` 提前到调用前刷新（长任务不再被 idle 误判） |
| `channel-workspace.ts`（37，新增） | 飞书/钉钉目录名常量共用（`create-app.ts` 与 `dingtalk/workspace.ts` 均改引常量）；`isChannelWorkspace` 的 depth≥2 与 planner 校验一致 |
| `runtime-channel-server.ts`（28） | 新增 `onClosed`（已关闭时同步回调一次）；心跳未回 pong 判定由 `>` 改 `>=`（30s×3=90s，与注释一致） |
| `session.repository.ts`（13） | `listWorkspacesByUser` 按 `user_id` + 未删除 + 非空过滤，归属正确 |
| `create-app.ts`（48） | registry 装配（`ensureChannelListening`/`issueChannelToken`/`sessionWorkspacesOf`）、pty factory 按 `startedAtMs` 分代换 hub、预热带会话工作区、`depsEnvProvider` 仅容器用户注入、关闭时 hub 全量 dispose——与各组件语义一致 |

---

## 六、验证环境与数据

- 全量后端测试（干净树）：`cd backend-ts && npm test` → `Test Files 330 passed | 1 skipped (331)`、`Tests 4039 passed | 13 skipped (4052)`（退出码 0）。比 round-05 多 1 例即作者新增回归 `keepsReentrantFirstCreateContainerWhenOuterFirstCreateTimesOut`。
- `npm run build`（`tsc -p tsconfig.build.json`）通过；`npx tsc -p tsconfig.build.json --noEmit` 通过。
- G-1 闭合性 6 条测试、R-1 复现 1 条测试（对当前 HEAD 失败）、round-03/04 复跑 9 条（8 通过 + round-04 旧 F-2 备份测试因固化 Buggy 行为而预期性失败），均如正文所述。
- 审查期间未修改任何源码与测试文件，临时验证 spec 用后即删，`git status` 干净（仅剩本报告）。
