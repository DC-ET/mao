# 用户运行时容器隔离（docker 模式）代码审查 — round-05（round-04 复审）

- **日期**：2026-10-14
- **基线**：`main @ 91d4f944` → 审查对象 `feature/user-runtime-container-isolation @ d51df1d0`（工作区 `mao/.worktrees/user-runtime-isolation`）
- **审查对象**：`git diff 91d4f944..HEAD` 全部功能逻辑变更，共七个提交：`f75b366c` 功能本体 + `a3b7422b` round-01 修复 + `6c878300` round-02 修复 + `b89c9c25` 陈旧条目防护 + `b01394a8` round-03 修复 + `07047984` 钉钉私聊归属校验 + `d51df1d0` round-04 修复（重点）。**注意：审查期间工作区 HEAD 又前进到 `d55cffc7`（`docs: CHANGELOG 补充容器启动失败自愈与钉钉私聊归属说明`），纯文档提交、无功能逻辑变更**，本报告功能结论以 `d51df1d0` 为准（全套验证在实际 HEAD 上复跑通过）。
- **性质**：本文是对 `docs/code-review/2026-10-14-container-isolation-round-04.md` 的复审：核对 F-1 / F-2 的修复是否真正闭合、是否引入新问题；附带核对 round-03 四项与观察 O-2 的处理。
- **方法**：① 通读 `d51df1d0` 全量 diff 与 2 条新回归 spec；② **用 round-04 报告的 F-1 / F-2 复现测试与 round-03 报告的 7 条复现测试在当前 HEAD 复跑**（F-2 旧断言固化的是 Buggy 行为，按"修复后的正确行为"重写后通过）；③ 逐机制审查 `cleanupFailedStart` / `dropFailedEntry` / 世代校验 / `inContainer` 清零 / 同名冲突重试；④ 对新发现写可运行测试证明真实存在（对当前代码失败），并对建议修复方向做patch 副本验证（不动源码）；⑤ 全量 `npm test` 两轮 + `npm run build` + `tsc --noEmit`。审查期间未修改任何源码/测试（临时验证 spec 用后即删，`git status` 干净）。

---

## 结论概览

- round-04 的 **F-1 / F-2 均已闭合**（§一）：作者的 2 条新回归测试在全量套件通过；我按"修复后正确行为"重写的 2 条验证测试通过；round-03 的 7 条复现测试（N-4a/N-4b/N-4c/N-5/N-6/N-7/N-8）在当前 HEAD 仍全部通过。`d51df1d0` 把"启动失败收尾"收敛为带世代校验的共用 helper `cleanupFailedStart`、两条路径五处失败分支全部改走该 helper，方向正确，未见"修一半"（除下述 G-1 的交错场景）。
- round-04 观察 **O-2（`inContainer` 陈旧忙计数）已处理**：`createAndStart` 与 `dockerStart` 成功路径均清零（`:462` / `:521`），语义正确——新容器内没有任何 shell/pty/在途任务，新 agent 握手后补报真实 `runtime_status`；无新问题。
- 复审新发现 **1 个 bug（G-1）**：`cleanupFailedStart` 的世代校验只能识别"同一条目对象被原地重建"这一种交错，识别不了"首建期间重入方另建新条目并登记"——此时外层失败按容器名 `rm -f` 会摧毁重入方刚建好的容器，把一条自称 `running` 的在册条目毒化（其容器已不存在）。与 F-1 同源：F-1 的修复只覆盖了原地更新那一种交错。
- **结论：不通过复审。** G-1 是 `d51df1d0` 修复的残留缺口。如实说明其边界：可达性仅限 `withUserLock` 的 ALS 重入（生产回调目前不重入，属设计明确支持并测试的场景），且下次调用可经 `markConnectionDead` / 挂载缺检自愈，不构成永久卡死；但错误终态真实存在（已写测试证明，实测在册条目的容器被删），且与代码自身宣称的不变量（N-3"不能把失败固化成自称就绪的毒化状态"）直接矛盾。修复为一行级条件（§三），我已在 patch 副本上验证其闭合 G-1 且不影响 F-1/F-2 与正常失败路径，建议同批补上并补一条首建路径回归测试后合入。

| 编号 | 严重度 | 模块 | 一句话 |
| --- | --- | --- | --- |
| G-1 | 中 | container-registry | `cleanupFailedStart` 世代校验覆盖不了"首建期间重入另建新条目"：外层失败按容器名 `rm -f` 掉重入方刚建好的容器，在册条目被毒化（自称 `running`、容器已不存在），须下次调用才自愈 |

---

## 一、round-04 F-1 / F-2 修复核对表

**独立验证方法**：round-04 报告的 2 条复现测试按"修复后的正确行为"改写后（旧断言固化了 Buggy 行为，修复后自然反转）在当前 HEAD 运行 → 通过；round-03 报告的 7 条复现测试原样复跑 → 7 passed；作者 2 条新回归测试在全量套件（330 文件 / 4038 用例）通过。

| round-04 | 修复位置（file:line） | 闭合？ | 证据 |
| --- | --- | --- | --- |
| F-2（`dockerStart` 的 `docker start` 失败不摘条目，卡死 `stopped`） | `container-registry.ts:502-514`（`docker run(['start', …])` 包 try/catch → `cleanupFailedStart(entry.userId, entry, generation, entry.containerName)` → 抛 `ContainerStartError`）、`:478-490`（`cleanupFailedStart`：世代校验 → `dropFailedEntry` → `cleanupHalfCreated`） | 是。`docker start` 失败（典型 "No such container"）即摘条目，下次 `ensureRunning` 走完整 `docker run` 重建；与 `createAndStart` 失败路径同口径 | 作者回归 `dropsEntryWhenDockerStartFailsSoNextCallRebuilds`（`container-registry.spec.ts:512`）在全量套件通过；我的验证测试（start 失败 → `getEntry(7)` 为 undefined → 下次调用 1 次 `run -d` 且 `running`）通过。round-04 旧复现测试中"第二次调用仍失败"的断言在修复后自然反转（promise resolved instead of rejecting），即修复生效 |
| F-1（`createAndStart` 失败清理缺世代校验，重入 recycle 后误删新条目/新容器） | `:478-490`（共用 helper `cleanupFailedStart`，世代变了只跳过、不删在册新条目不 rm 新容器）、`:424`（`createAndStart` 进入失败路径前捕获 `generation`）、`:438` / `:442` / `:451`（docker run 失败 / 同名冲突重试失败 / `waitSocketReady` 超时三处全部改走 helper）、`:512` / `:530`（`dockerStart` 两处同口径）、`:496-500`（`dropFailedEntry` 保留为纵深防御） | 是（原地重建交错）。重入 recycle 原地更新条目后世代 +1，外层失败清理被跳过，新容器与新条目存活 | 作者回归 `keepsRecycledContainerWhenOuterCreateFailsAfterReentrantRebuild`（`container-registry.spec.ts:550`）通过；我的 round-04 F-1 复现测试在当前 HEAD 通过（`F1_ORDER` 以 `run -d` 收尾、无尾部 `rm -f`，wsB 在册）。**但首建交错未覆盖 → G-1（§三）** |

**O-2 处理核对**：`createAndStart` 成功路径 `:462` 与 `dockerStart` 成功路径 `:521` 均把 `inContainer` 重置为全 0，注释说明"新 agent 握手后会补报真实状态"（`runtime-agent` 握手即报 `runtime_status`）。语义正确：旧容器的 shell/pty/任务随容器销毁而消亡，残留计数只会把 idle 回收挡在门外；清零不会丢真实状态（新 agent 首报即覆盖）。无新问题。

**round-03 四项复核（无回退）**：round-03 报告的 7 条复现测试在当前 HEAD 全部通过。其中 N-4c（`dockerStart` 重启超时误伤新容器）实测 `C_ORDER=["start mao-user-7","stop -t","rm -f","run -d"]`、wsB 在册——该场景现由 `cleanupFailedStart` 的世代校验闭合；N-5（他人私聊工作区）`planner.plan(7, [private-8])` 仍抛错（`container-mount-planner.ts:111-114`，`^(?:private\|p2p)-(\d+)$` 叶子归属校验）。

---

## 二、d51df1d0 机制逐项审查

| 机制 | 审查结论 |
| --- | --- |
| `cleanupFailedStart` 共用 helper（`:478-490`） | 方向正确：五处失败分支（`createAndStart` 三处 + `dockerStart` 两处）共用同一套"世代校验 → 摘条目 → rm 半成品"语义，口径一致；同名冲突重试失败（`:438`）也走该 helper，无遗漏。世代校验对"原地重建"交错有效（F-1 闭合）。**对"首建 + 重入另建新条目"交错无效 → G-1** |
| `dropFailedEntry` 身份校验（`:496-500`） | 纵深防御有效：G-1 场景中它成功挡住"删在册新条目"（`entries.get(7)` 是 E2 ≠ E_new → return），但按容器名的 `cleanupHalfCreated` 仍会摧毁该条目的容器——身份校验只保住"条目"没保住"容器" |
| `generation` 捕获时机（`:424`、`:504`） | 正确：进入失败路径前捕获，await 之后比对 |
| `inContainer` 清零（`:462`、`:521`） | 正确，见 §一 O-2 |
| `cleanupHalfCreated`（`:564-566`） | `rm -f` 失败被吞（`.catch(() => undefined)`），对"容器本来就不存在"（F-2 场景）无副作用，不会把清理失败升级成新异常 |
| 世代校验注释对首建场景的描述（`:422-423`、`:473-476`） | 注释自述"新条目尚未登记时世代恒为进入失败路径时捕获的值，校验通过，照常清理半成品"——这正是 G-1 的场景，但"照常清理"中的 `rm -f` 会误伤重入方的新容器（§三） |

---

## 三、复审新发现

### G-1【中】`cleanupFailedStart` 世代校验覆盖不了"首建期间重入另建新条目"：外层失败 `rm -f` 掉重入方刚建好的容器，在册条目被毒化

**位置**：`harness/container/container-registry.ts:478-490`（`cleanupFailedStart`：`if (entry.generation !== generation) return;` 之后**无条件**执行 `dropFailedEntry(userId, entry)` + `cleanupHalfCreated(name)`）；对照 `:422-424` 与 `:473-476` 的注释——其自述的"新条目尚未登记时校验通过、照常清理半成品"正是本缺陷场景，但"照常清理"会误伤重入方的新容器。

**问题描述**

`d51df1d0` 世代校验的语义是："世代变了 → 在册的已是新容器 → 跳过清理"。它隐含假定"在册条目与 `entry` 是同一个对象"（recycle 原地更新）。在**首建交错**下这个假定不成立：

1. 外层 `ensureRunning(7, wsA)`：无条目 → `createAndStart`（`existing` 为空）→ 构建**尚未登记**的条目对象 E_new（`generation=0`）→ `docker run` 建容器 → 等待 `waitSocketReady`（登记要等 socket 就绪，N-3 语义）；
2. 等待期间，同一异步上下文（`withUserLock` 的 ALS 重入，`container-registry.ts:211-227`，本分支明确设计并以回归测试覆盖的场景）重入 `ensureRunning(7, wsB)`：此刻 `entries.get(7)` 仍是 `undefined`（外层尚未登记）→ 走**创建分支** → 另建条目对象 E2 并登记（世代 0→1）、容器 C2 就绪、返回；
3. 外层随后超时失败 → `cleanupFailedStart(7, E_new, generation=0, 'mao-user-7')`：E_new 的世代从未被原地更新过，仍是 0 → **世代校验通过** → `dropFailedEntry(7, E_new)`：`entries.get(7)` 是 E2 ≠ E_new → 身份校验挡住，E2 条目保住了；但 `cleanupHalfCreated('mao-user-7')` 按**容器名** `rm -f` → **C2 被摧毁**；
4. 终态：E2 在册、自称 `state='running'`、`mountedPaths` 含 wsB，而它的容器已被删掉——正是 N-3 注释里要防的"自称就绪的毒化状态"。

**与 F-1 的关系**：F-1 是"原地更新"交错——外层条目已在册，重入方 recycle 原地更新**同一个对象**、世代 +1 → 校验挡住。G-1 是"首建"交错——外层条目未登记，重入方**另建新对象**并登记 → 外层世代没变 → 校验放行。`d51df1d0` 只闭合了前者。作者的 F-1 回归测试先 `ensureRunning(7)` + `reapExpired()` 造出在册 `stopped` 条目，因此走不到 G-1 这条路径（首建路径无此回归）。

**可达性与影响（如实说明）**

- **可达性**：仅限 `withUserLock` 的 ALS 重入（`waitSocketReady` / `requestShutdown` 等待期间，同一异步上下文再次 `ensureRunning`）。生产接线中 `waitSocketReady`（`create-app.ts:1013-1020`）只轮询 `channelServer.getConnection`、`requestShutdown`（`:1021-1024`）只做 WS 往返，其回调（`onConnectionDead`→`markConnectionDead`、`onRuntimeStatus`→`reportRuntimeStatus`）均不重入 `ensureRunning`，**当前生产不可达**；但该重入是类注释与回归测试明确设计支持的场景（作者自己的 F-1 回归即构造它），属防御性语义的缺口而非纯理论推演。
- **影响**：不是永久卡死。C2 被 `rm -f` 后其 agent 的 socket 关闭 → `RuntimeChannelServer.drop`（`runtime-channel-server.ts:213`）→ `onConnectionDead`（`create-app.ts:999`）→ `markConnectionDead(7)`（`container-registry.ts:302-305`，对在册条目置 `connectionDead=true`）→ 下次 `ensureRunning` 走 connectionDead 重建分支自愈；即使 socket 关闭事件尚未处理，下次调用若带未挂载工作区也会触发 recycle 重建（`hasUnmountedWorkspace`，`:185`）。坏窗口 = 毒化期间落到该用户容器上的工具调用失败（连接已断），窗口以一次调用为界。
- 但错误终态真实存在（测试已证明）：注册表跟踪着一个不存在的容器，且与 N-3 宣称的不变量直接矛盾。

**复现/验证方式**（对当前代码失败即证明存在）

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

/** 标准 roots + fake docker + startTimeoutMs: 1000，与 container-registry.spec.ts 同构；overrides 可覆盖 opts 钩子 */
function makeRegistry(base: string, log: string[], overrides: Partial<ContainerRegistryOptions>, docker?: DockerCli) {
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
  }, docker ?? fakeDocker(log));
}

describe('round-05 review', () => {
  it('G-1: 首建期间重入 recycle 后外层失败，rm -f 掉重入方刚建好的容器（在册条目被毒化）', async () => {
    const base = useTmpDir('mao-r5-firstcreate-');
    const log: string[] = [];
    const wsA = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_a');
    const wsB = join(base, 'workspace', 'feishu-chat', 'bot-1', 'oc_chat_b');
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    let registry: ContainerRegistry | null = null;
    let phase = 0;
    registry = makeRegistry(base, log, {
      sessionWorkspacesOf: async () => [],
      waitSocketReady: async () => {
        if (phase === 0) return;
        if (phase === 1) {
          phase = 2;
          await registry!.ensureRunning(7, wsB);   // 重入：此刻 entries 仍为空 → 也走创建分支
          throw new Error('容器运行时通道连接超时: userId=7 (1000ms)');
        }
      },
    });

    phase = 1;
    log.length = 0;
    await expect(registry.ensureRunning(7, wsA)).rejects.toThrow(/连接超时/);
    // 期望（正确行为）：外层失败只清理自己那半成品；重入方建好的容器与在册条目存活
    expect(registry.getEntry(7)?.mountedPaths.has(wsB)).toBe(true);
    const lastRun = log.map((l) => l.startsWith('run -d')).lastIndexOf(true);
    const lastRm = log.map((l) => l.startsWith('rm -f')).lastIndexOf(true);
    expect(lastRm).toBeLessThan(lastRun);
  });
});
```

实测输出：`G1_ORDER=["run -d","run -d","rm -f"]`（最后一次 `rm -f` 落在最后一次 `run -d` **之后**）、`G1_ENTRY=[wsB]`（在册条目仍声称挂载 wsB）、断言 `expected 2 to be less than 1` 失败。

**建议修复方向（一行级，已在 patch 副本上验证）**

`cleanupFailedStart` 的清理动作前再叠一层"在册条目必须是本人或无人"的判定，把首建交错一并挡住：

```ts
private async cleanupFailedStart(
  userId: number,
  entry: ContainerEntry,
  generation: number,
  name: string,
): Promise<void> {
  const current = this.entries.get(userId);
  if (current !== undefined && current !== entry) {
    harnessLog('warn', `[container] skip cleanup of failed start for user=${userId} (entry replaced concurrently)`);
    return;   // 在册的是重入方的新条目：既不删它，也不按名 rm 它的容器
  }
  if (entry.generation !== generation) {
    harnessLog('warn', `[container] skip cleanup of failed start for user=${userId} (entry rebuilt concurrently)`);
    return;
  }
  this.dropFailedEntry(userId, entry);
  await this.cleanupHalfCreated(name);
}
```

我用带此补丁的 `container-registry.ts` **副本**（未动源码，验证后即删）跑了 4 个场景，全部通过：① G-1 首建交错 → 在册条目与容器都存活；② 作者 F-1 回归场景（原地重建交错）→ 仍然通过；③ F-2 场景（`docker start` 失败、无重入）→ 仍然摘条目 + 下次完整重建；④ 首建正常失败（`docker run` 失败、无重入）→ 仍然 `rm -f` 清掉半成品容器（下次重名不冲突）。建议同时补一条与作者 F-1 回归同构、但走**首建路径**的回归测试（即本节测试）固化该交错。

---

## 四、次要观察（不构成功能缺陷，不要求本 round 处理）

- **O-1（走查后确认非缺陷）**：`createAndStart` 的 `planner.plan`（`:380`）抛 `MountPlanError` 发生在 try/catch 与 `entry.state = 'creating'`（`:421`）**之前**。我原担心原地重建因此把条目遗留在 `creating`，实测状态保持 `stopped`（`stopContainer` 已置位，`:545`），旧容器已被 stop + `rm -f`；后续调用：带未挂载工作区 → 再重建 → planner 再抛（响亮且一致的 `MountPlanError`，无 `docker run` 抖动），坏行消失后即恢复，且 `reapExpired` 跳过非 running 条目不受影响。该情形还需要"DB 里存在他人 `private-/p2p-` 工作区行"，而生产两条入口（建会话归属校验 `session.routes.ts` + SQL `user_id` 过滤）均已收口，当前不可达。
- **O-2（既有语义，承接 round-04 观察 O-4）**：`send_file` 的 `readBytes` 入口只按用户运行时模式判定、不校验会话 `executionMode`，LOCAL 会话的 `workspace` 也可能经该入口触发容器挂载；planner 的私聊叶子归属校验会挡住他人 `private-/p2p-` 叶子。LOCAL"工作区即宿主机目录"是 main 既有语义，非本分支引入；若要求严，可让 `readBytes`/`ensureReady` 也要求 CLOUD 会话。

---

## 五、验证环境与数据

- 全量后端测试：`cd backend-ts && npm test` 两轮。首轮 4 例失败（`signal/probe-client` 1、`weixin/agent-inbound-handler-flow` 1、`harness/core/token-estimator` 1、`harness/tool/impl/file-tools` 1，均与本分支无关），逐个单独复跑共 101 例全部通过，判定为计时性 flake（与 round-04 审查期间遇到的 flake 同型）；**次轮全绿**：`Test Files 330 passed | 1 skipped (331)`、`Tests 4038 passed | 13 skipped (4051)`（退出码 0），与任务描述数字一致。
- `npm run build`（`tsc -p tsconfig.build.json`）通过；`npx tsc -p tsconfig.build.json --noEmit` 通过。
- 修复闭合证据：round-04 F-1/F-2 复现测试（按修复后正确行为改写）通过；round-03 7 条复现测试通过；作者 2 条新回归测试在全量套件通过。
- 新发现 G-1 有 1 条复现测试，对当前代码失败（错误终态真实存在）；建议修复方向在 patch 副本上以 4 个场景验证通过（未动源码）。
- 审查期间未修改任何源码与测试文件，临时验证 spec 与 patch 副本用后即删，`git status` 干净（仅剩本报告）。
- 审查期间工作区 HEAD 由 `d51df1d0` 前进至 `d55cffc7`（纯 CHANGELOG 文档提交），不影响本报告功能结论；全部验证在实际 HEAD 上复跑。
