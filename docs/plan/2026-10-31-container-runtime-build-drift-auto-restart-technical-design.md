# 容器运行时版本漂移自动收敛（闭包哈希 + 懒重启）技术方案

> 版本：v1.1（2026-10-31 评审回填）
> 状态：已评审（2026-10-31）：四个开放问题已有结论（见 §10），按结论回填本文；未开发，待排期
> 关联：[2026-10-14-user-runtime-container-isolation-design.md](2026-10-14-user-runtime-container-isolation-design.md)（挂载清单即安全边界、指纹机制先例）、[2026-10-31-container-hosts-injection.md](2026-10-31-container-hosts-injection.md)（`hostsFingerprint` 先例）、CHANGELOG 0.0.393（修复「容器内读会话技能被判符号链接逃逸」时暴露：容器内代码不随后端发布生效，必须人工重启容器）
> 一句话：给容器内运行时（`runtime-agent.js` 的 import 闭包）算一个**闭包指纹**，agent 握手时上报；宿主机在用户下次调工具时比对，漂移且容器空闲就**自动重启容器进程**（不重建、不打断在跑任务），把「发版后容器跑旧代码」从人工操作收敛成懒自愈。

## 0. 决策摘要

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 指纹口径 | **容器内运行时闭包**（`dist/harness/container/runtime-agent.js` 的静态相对 import 图）内容哈希；宿主机侧改动（API / agent loop / prompt / 通道等）不触发 |
| 2 | 指纹生成 | 构建产物生成：`npm run build` 后置步骤写 `dist/harness/container/runtime-build.json`；同源重建幂等（哈希不含时间戳） |
| 3 | 上报通道 | agent 启动时读取 manifest，`hello` 帧新增**可选** `build` 字段；协议 `v:1` 不变、字段级向后兼容 |
| 4 | 宿主机判定 | registry 启动时读同一份 manifest 并缓存（代表本实例加载的代码），`ensureRunning` 时与 agent 上报值比对 |
| 5 | 动作分级 | 代码漂移 → **重启容器进程**（stop + start，保留容器/挂载/env）；挂载 / hosts 漂移 → 重建（沿用现状） |
| 6 | 触发策略 | **懒触发**（`ensureRunning`）+ **仅空闲**：busy 容器只记录，不打断在跑任务 |
| 7 | 防环 | 每「容器 × host build」只自动尝试一次；蓝绿 draining 实例跳过自动升级 |
| 8 | 兼容与退化 | 旧 agent 不报 build 视为 unknown → one-shot 自愈；manifest 缺失（LOCAL/tsx 开发）→ 检查关闭，不误伤 |
| 9 | 配置项 | 新增 kill switch：`system_setting.runtime.container.autoUpgrade`（V178 迁移，默认 true，后台「运行环境 → 容器管理」可切换）；关闭 = 跳过全部自动升级动作。人工入口（后台「重建容器」/ `POST /v1/users/:id/container/recycle`）保留不变 |
| 10 | 管理后台 | **本期含前端**：「容器管理」列表新增「代码版本」（agent build）/「后台版本」（host build）列与漂移、待升级徽标；设置面板新增自动升级开关 |
| 11 | 用户通知 | 不通知（静默处理，靠日志与后台观察） |
| 12 | 非目标 | 不做热加载、不做容器镜像内容漂移检测（见 §9 P2）、不做「发版即全量重启」 |

## 1. 背景与问题

### 1.1 现状（代码事实）

- docker 模式下工具执行在每用户容器的常驻 Node 进程里：容器启动命令 `node {distDir}/harness/container/runtime-agent.js --socket ...`（`container-registry.ts:656`），`dist` 由宿主机目录 **ro 挂载**（`container-registry.ts:240`），容器内路径与宿主机一致。
- Node 无热加载：进程启动时加载模块，之后 dist 文件再变也不生效。容器内运行时闭包约 50 个模块：`container-tool-executor`、文件工具（read/write/edit/glob/grep）、`path-sandbox`、`shell-session-manager`、`pty-hub`、`container-mcp-bridge`、图片处理、git 写入服务等。
- 容器自动重建**只挂钩载指纹漂移**：`mountFingerprint`（挂载清单，`container-registry.ts:54`）、`hostsFingerprint`（`--add-host` 注入，`:61`），判定点在 `ensureRunningLocked`（`:307`）；dist 内容与容器 env 都不在指纹里。
- idle 回收只 `docker stop` 不 rm（`stopContainer` `:798`），下次 `dockerStart`（`:762`）复用同一容器（挂载/env 保持创建时定型），进程重启会加载新 dist —— 但生效时机取决于用户何时再来，不可控。
- 现状操作是人工：发版后 `docker restart mao-user-*` 或后台「重建容器」；漏了就长期静默跑旧代码。

### 1.2 问题定义

「后端已发布 ≠ 容器内已生效」造成三类静默错位：

1. **修复不生效**：如 0.0.393 的符号链接修复，部署后存量容器仍报 `Path escape attempt (symlink)`，需人工重启才收敛；
2. **行为/协议漂移**：新宿主机 + 旧 agent 组合下的工具行为不一致；若未来引入不兼容协议变更，风险更高；
3. **人工步骤易漏**：没有系统性校验，靠发版人记忆。

### 1.3 目标

1. 发版后容器内代码版本**自动收敛**，无需人工操作；
2. 收敛动作尽量轻：代码漂移只重启进程，不重建容器（保挂载/env/容器名）；
3. **不打断在跑任务**：busy 容器延后处理；
4. 判定口径锚定「容器内真正运行的代码」，宿主机侧改动不触发；
5. 失败可观测、可退化：缺 manifest / 旧 agent / 开发环境不误伤；防重复重启风暴。

### 1.4 非目标

- 不做热加载 / 进程内模块重载（Node 生态没有干净方案，重启进程是最小代价）；
- 不做容器**镜像**内容漂移检测（镜像层变化，见 §9 P2）；
- 不做「发版即全量主动重启」（只懒触发；需要立即收敛的场合走人工批量重建）；
- 不替换后台「重建容器」按钮（保留强制入口，force 语义不变）；
- 不改隔离边界、挂载清单与容器创建参数。

## 2. 方案总览

三个部件，一条链路：

```
构建期                容器启动                    用户下次调工具（懒触发）
──────                ────────                    ──────────────────────
tsc 产出 dist           agent 读 runtime-build.json   ensureRunning 比对：
  ↓ 后置脚本              （闭包哈希 buildId）           entry.runtimeBuild(hello 上报)
生成 runtime-build.json        ↓                          vs hostBuild(本实例 manifest)
（闭包遍历 + 哈希）        hello 帧携带 build ──→ 宿主机记录   ├─ 一致 → 复用
                                                        ├─ 漂移 + 空闲 → 自动重启（stop+start）
                                                        └─ 漂移 + 忙碌 → pending，下次再判
```

- 指纹只覆盖「容器内运行时闭包」：宿主机侧改动（NestJS 接口、agent loop、prompt、飞书通道、技能同步等）不触发；
- 收敛动作分两级：**代码漂移 → 重启进程**（轻）；**挂载 / hosts 漂移 → 重建容器**（现状不变）；
- 重启后新进程加载新 dist，`hello` 上报新 build，自然对齐，形成闭环。

## 3. 详细设计

### 3.1 构建期：闭包指纹 manifest

- 新增脚本 `backend-ts/scripts/emit-container-runtime-build.mjs`，接入 `package.json`：
  `"build": "tsc -p tsconfig.build.json && node scripts/emit-container-runtime-build.mjs"`；
- 算法：
  1. 从 `dist/harness/container/runtime-agent.js` 出发，沿静态相对 import 遍历（`from '...'` / `import('...')`），得到闭包文件集（仅 `.js`，排除 `.map` 与 manifest 自身）；
  2. 按相对路径排序，逐个取 `sha256(文件内容)`；
  3. `buildId = sha256(「rel:hash」逐行 join('\n')).slice(0, 16)`；
- 输出 `dist/harness/container/runtime-build.json`：

  ```json
  { "schema": 1, "buildId": "3f9a1c0d2b7e4410", "fileCount": 50, "generatedAt": "2026-10-31T14:00:00Z" }
  ```

- **幂等要求**：`generatedAt` 不参与哈希 —— 无代码变化时重新构建/重新部署产生相同 `buildId`，不会触发无意义重启；`schema` 值纳入哈希输入 —— 遍历/哈希算法本身变更时 `buildId` 自然改变，不会把旧容器误判为同源；
- 失败策略：入口文件不存在 → 脚本非 0 退出（**构建失败**）。宁可构建失败，不可产出缺失 manifest 的部署；本地 `tsx`（LOCAL/dev，无 dist）不经过该步骤，宿主机侧检查自动关闭；
- 与 `container-import-constraints.spec.ts` 的关系：同一条 import 遍历思路，实现抽到 `runtime-build.ts` 共享，测试可复用。

### 3.2 容器侧：agent 读取与上报

- 新增 `src/harness/container/runtime-build.ts`：`loadRuntimeBuildId(moduleUrl)` 读取「与模块同目录」的 `runtime-build.json`；文件缺失 / 解析失败 → 返回 `null` 并 warn 一次（不阻塞启动）；
- `runtime-agent.ts` 启动时读取，`hello` 帧携带（`runtime-agent.ts:154`）：

  ```
  { v: 1, type: 'hello', userId, token, build?: '3f9a1c0d2b7e4410' }
  ```

- 协议层（`runtime-channel-protocol.ts:67`）只加**可选**字段；`validateFrame` 是松校验（`:136-148`），旧宿主机对多余字段无感 → 双向兼容；
- 为什么不放 `runtime_status`：`hello` 每次连接必发（含宿主机重启后的重连），一处即可；`runtime_status` 保持纯「容器内活动状态」语义（idle 判定唯一数据源）。

### 3.3 宿主机侧：版本认知

- `RuntimeChannelServerOptions` 增 `onAgentHello?(userId, info: { build: string | null })`（`runtime-channel-server.ts:40-50` 区域）；hello 校验 token 通过后、回 `hello_result` 前后触发（不含 build 字段时回调 `build: null`）。
- `container-registry.ts`：
  - `ContainerEntry` 增 `runtimeBuild?: string`（agent 上报值，权威来源）与 `upgradeTargetBuild?: string`（防环，见 §3.5）；
  - 新增 `reportAgentHello(userId, build)`，与 `reportRuntimeStatus`（`:503`）同构；
  - 构造时读 `{config.container.distDir}/harness/container/runtime-build.json` → `hostRuntimeBuild`；读失败 → `null` + warn（此后跳过一切 build 检查）；
  - 以上均为内存条目字段，无 DB 迁移。
- 接线在 `app-container-runtime.ts`（`:77-84` 区）：
  ```ts
  onAgentHello: (userId, info) => containerChannelHolder.registry?.reportAgentHello(userId, info.build),
  ```

### 3.4 漂移判定与动作

- 判定：`hostRuntimeBuild != null && entry.runtimeBuild !== hostRuntimeBuild`（`undefined` = unknown，视为漂移，自愈一次）。
- 触发点：`ensureRunningLocked`（`:307`）running 且 `!connectionDead` 分支 —— 先判总开关（关闭则直接跳过，§3.7），再跑现有 `mountPlanDrifted` / `hostsInjectionDrifted`（重建优先，正确性 > 新鲜度），最后判 build 漂移：

  | 情形 | 动作 |
  |------|------|
  | 空闲（`!isBusy`，`:92`） | `restartEntry(entry)` → 重启进程 |
  | 忙碌 | 不改动容器，`harnessLog` 记录 pending；下次调用再判 |

- **stopped 分支不做额外动作**：`dockerStart` 本身就是进程重启，天然加载新 dist；start 后 `hello` 回填 `runtimeBuild` 自会对齐（避免「先 start 再立刻 restart」的一次无用启动）；
- `connectionDead` / 状态异常分支已有「停止 + 重建」路径，覆盖此场景，无需改动；
- 重启实现 `restartEntry(entry)`：`stopContainer(entry, { force: false })`（优雅：先发 `shutdown` 帧，再 `docker stop -t 10`）+ `dockerStart(entry)`（`waitSocketReady` + 失败走 `cleanupFailedStart`）。**不用裸 `docker restart`**：要复用条目状态机、generation 校验与失败清理语义，避免留下「自称 running」的毒化条目；
- 动作语义对照（术语固定）：
  - **restart**：同容器、同挂载/env，只重启进程（本方案用于代码漂移）；
  - **rebuild**：停 → rm → 重新 `docker run`（现状用于挂载/hosts 漂移；env/镜像类漂移见 §9 P1）；
  - **recreate**：条目不存在时的首次创建（现有语义）。

### 3.5 防抖与防环（关键）

1. **one-shot per (容器, host build)**：`entry.upgradeTargetBuild` 记录「已尝试过的目标 build」。仅当 `upgradeTargetBuild !== hostRuntimeBuild` 时才尝试重启；尝试后置位。场景：蓝绿期间旧实例缓存旧 build，容器已被新实例升到新 build —— 不设上限会「每次调用都重启」形成风暴；one-shot 让每个容器对每个 host build 最多动作一次。
2. **draining 实例跳过自动升级**：复用 `isDrainingInstance(runtimeDir, selfPort)`（`deploy-lock.ts:93`），由承接流量的实例执行动作，旧实例只读不写（日志记录 `skipped-draining`）。
3. **host build 读不到** → 检查整体关闭（warn 一次），LOCAL/tsx/异常部署零副作用。

### 3.6 可观测性

- 日志（`harnessLog`）：
  - `[container] runtime build drift: user=7 agent=abc host=def action=restart`（已动作）
  - `... action=deferred-busy`（忙碌延后）
  - `... action=skipped-draining` / `action=skipped-no-host-build` / `action=skipped-disabled`（守卫 / 总开关跳过）
- **管理后台（本期实施）**：`ContainerEntrySummary`（容器列表数据源，`:75`）增 `runtimeBuild` / `hostRuntimeBuild` / `pendingUpgrade` 字段；「容器管理」面板（`admin/src/views/settings/components/ContainerRebuildPanel.vue`）新增「代码版本」「后台版本」两列，以及「待升级」徽标（running 且两者不一致时显示）。
- 不含任何敏感信息（buildId 是内容哈希）。

### 3.7 配置项：自动升级总开关（kill switch）

- 新增设置项 `system_setting.runtime.container.autoUpgrade`（**V178** 迁移插入，category「运行环境」，`true` / `false`，默认 `true`，editable=1），沿用 V176 的插入风格；
- 解析：新增 `container-auto-upgrade.ts`（key 常量 + 解析器），缓存口径对齐 `RuntimeModeResolver`（5s TTL；保存后由 `app-routes.ts` 的 `afterSave` 调 `invalidate()` 即时生效；缺行 / 值非法 / 读库失败一律回落 `true`，保持既有部署行为）；
- 生效点：registry 的 build 漂移分支**最前**判定；关闭时不动容器，仅日志 `action=skipped-disabled`；
- 语义边界：只关「自动」，不关人工「重建容器」（force 语义不变）；关闭期间积攒的漂移，在重新打开后由下一次 `ensureRunning` 照常收敛；
- 保存侧校验：`settings.service#validateValue` 对该 key 限定 `'true' | 'false'`（其余拒绝），避免写入非法值；
- 后台展示：「运行环境」的容器管理面板（`ContainerRebuildPanel.vue`）头部加 `el-switch`（与「包括正在运行任务的容器」同区）。

## 4. 行为矩阵

| # | entry 状态 | 漂移类型 | 空闲？ | 动作 | 与现状对比 |
|---|-----------|---------|--------|------|-----------|
| 1 | running | 无 | - | 复用（现有） | 不变 |
| 2 | running | build | 是 | 自动 restart（一次/目标） | **新增** |
| 3 | running | build | 否 | pending，下次再判 | **新增** |
| 4 | running | mount / hosts | 是/否 | 重建（现有，不看 busy） | 不变（正确性优先，见 §5-6） |
| 5 | stopped | build | - | 仅 `dockerStart`（自然加载新 dist） | 不变 |
| 6 | stopped | mount / hosts | - | 重建（现有） | 不变 |
| 7 | stopped | 新通道工作区 | - | 重建（现有） | 不变 |
| 8 | connectionDead | 任意 | - | 重建（现有） | 不变 |
| 9 | running | build，但 draining 实例 | - | skip + 日志 | **新增** |
| 10 | running | build，hostRuntimeBuild=null | - | skip（检查关闭） | **新增** |
| 11 | running | build（任意） | - | 总开关关闭 → skip + 日志（`skipped-disabled`） | **新增** |

## 5. 故障与边界

1. **旧 agent 不报 build（升级过渡）**：`runtimeBuild=undefined` 视为漂移 → one-shot 自愈一次；重启后 agent 即来自新 dist，必然上报（同一份 dist，天然对齐）。
2. **manifest 缺失**：仅出现在 LOCAL/tsx 开发与「绕过 `npm run build` 的手工构建」；宿主检查关闭并 warn 一次。生产构建链路保证生成（§3.1 失败即构建失败）。
3. **重启失败**：`dockerStart` 失败走现有 `cleanupFailedStart`（摘条目 + `rm -f`），下次调用走完整 `docker run` 重建 —— 与现有失败语义同构，不引入新状态。
4. **蓝绿双实例**：draining 守卫（§3.5-2）保证只由承接方动作；one-shot 守卫兜底极端交错（新实例重启后、旧实例仍在排空窗口内比对）。
5. **忙碌持久**：busy 判定含活跃 shell 会话（idle 30 分钟、lifetime 2 小时上限），长会话会推迟升级 —— 这是有意保守（不打断用户终端）；如需立即收敛，后台「重建容器」（force）人工兜底。
6. **与 mount 漂移的调度差异**：mount/hosts 漂移代表**能力缺失**（新挂载不生效即功能不可用），维持现状「不看 busy 直接重建」；build 漂移只是**新鲜度**，可以等 —— 差异是有意的，不在本方案里改现状。
7. **未来不兼容协议变更**：本期只加字段，无此问题；将来若必须 bump `PROTOCOL_VERSION`，旧容器会被 `validateFrame` 拒绝（现有行为），这类变更无法靠懒触发解决，需在发布流程中先重建在线容器（或做 §9 P3 的批量编排），本方案不覆盖。
8. **回滚**：回滚代码后，容器（新 agent）继续上报 build，旧宿主松校验忽略该字段，无副作用；已发生的自动重启也无需处理。
9. **总开关关闭期间**：容器继续跑旧代码（与现状人工模式一致）；重新打开后由懒触发继续收敛，无需其他操作。

## 6. 测试计划

**单测（新增/扩充）**

| 文件 | 用例 |
|------|------|
| `runtime-build.spec.ts`（新增） | 闭包遍历正确（临时 dist 构造 import 图）；排序无关确定性（同输入两次同 buildId）；`generatedAt` 不影响 buildId；入口缺失 → 抛错非 0；manifest 自身不计入闭包 |
| `runtime-agent.spec.ts` | 有 manifest → `hello` 带 build；无 manifest → 不带且 warn 一次；真实 server 侧 `onAgentHello` 收到正确值（含「不含 build 字段 → `build:null`」与「token 失败不回调」两种） |
| `runtime-channel-protocol.spec.ts` | hello 帧带可选 `build` 仍通过校验（字段级兼容）；缺该字段不报错 |
| `container-registry.spec.ts` | ① 漂移 + 空闲 → docker 操作序列为 `stop` + `start`（无 `rm`/`run`）；② 漂移 + 忙 → 零 docker 操作，解除忙后下一次执行；③ 一致 → 零操作；④ `hostRuntimeBuild=null` → 零操作；⑤ draining 守卫 → 零操作；⑥ one-shot：尝试后 agent 仍报不同 build → 不再重启；⑦ stopped + 漂移 → 仅 `start`；⑧ mount 漂移优先 → 走重建序列；⑨ 总开关关闭 → 零操作，重新开启 → 收敛一次 |
| `container-auto-upgrade.spec.ts`（新增） | 缺行 / 非法值 / 读库失败 → 默认 `true`；`'false'` → 关闭；TTL 缓存与 `invalidate()` 即时生效 |
| `settings.service.spec.ts`（扩充） | `runtime.container.autoUpgrade` 值域校验：仅接受 `true` / `false`，非法拒绝 |
| `tests/admin-settings-cards.spec.ts`（扩充，参考既有容器管理面板用例） | 容器管理面板：自动升级开关渲染与保存、版本列 / 待升级徽标渲染 |

**手工验收**

1. 部署本功能（dist 含 manifest）→ 现状容器 agent 报 unknown → 空闲时自动 restart 一次 → 日志出现 `runtime build drift ... action=restart`；
2. 再改一行容器内代码重新发布 → 重复上述观察，确认容器在空闲后自动收敛，无需人工；
3. 忙碌容器（起一个 keep_session shell）→ 确认 `deferred-busy`，等会话结束后收敛；
4. 重启后 `read_file` 等工具行为与新代码一致；
5. 后台「容器管理」能看到「代码版本 / 后台版本」列与「待升级」徽标，开关保存后即时生效；
6. 关掉总开关再发布一次容器内代码改动 → 容器不自动重启（日志 `skipped-disabled`）；重新打开 → 下次调用收敛。

**回归**：现有 container 域全部单测保持绿；不引入真实 docker 依赖（fake `DockerCli` 注入）。

## 7. 上线与运维

- **发布顺序**：常规 `deploy-mao.sh`（后端蓝绿）即可，无镜像重建；
- **总开关**：`runtime.container.autoUpgrade=false` 可随时停用自动重启（后台「运行环境 → 容器管理」，保存即生效）；恢复 `true` 后由懒触发继续收敛；
- **上线首日预期**：所有存量容器 agent 报 unknown → 每个容器在「空闲 + 下次使用」时 lazy 重启一次（每容器一次性，不是发版风暴）；此后收敛；
- **观察点**：日志关键字 `runtime build drift`；管理后台「容器管理」的代码版本 / 待升级列；
- **回滚**：直接回滚代码，无数据/状态残留（字段级兼容，见 §5-8）；
- **文档同步**：CHANGELOG 记一条；`docs/agents/container-docker-mode.md` 补「发版后容器何时收敛」排查小节。

## 8. 影响文件与工作量

| 文件 | 改动 |
|------|------|
| `backend-ts/scripts/emit-container-runtime-build.mjs` | 新增：闭包遍历 + 哈希 + 写 manifest |
| `backend-ts/package.json` | `build` 串联后置步骤 |
| `backend-ts/db/migration/V178__container_runtime_auto_upgrade.sql` | 新增：插入 `runtime.container.autoUpgrade` 设置项（默认 true） |
| `backend-ts/src/harness/container/runtime-build.ts` | 新增：manifest 读取 + 闭包遍历（宿主/容器共享） |
| `backend-ts/src/harness/container/container-auto-upgrade.ts` | 新增：总开关 key + 解析器（TTL 缓存 + invalidate） |
| `backend-ts/src/harness/container/runtime-agent.ts` | 读 manifest；hello 携带 build |
| `backend-ts/src/harness/container/runtime-channel-protocol.ts` | hello 帧可选 `build` 字段 |
| `backend-ts/src/harness/container/runtime-channel-server.ts` | `onAgentHello` 钩子 |
| `backend-ts/src/harness/container/container-registry.ts` | entry 字段、`reportAgentHello`、漂移判定、`restartEntry`、守卫与开关判定 |
| `backend-ts/src/app-container-runtime.ts` | 接线 `onAgentHello` + draining 守卫 + 开关解析器 |
| `backend-ts/src/settings/settings.service.ts` | 扩充：开关值域校验（true/false） |
| `backend-ts/src/app-routes.ts` | 扩充：`afterSave` 失效开关缓存 |
| `admin/src/views/settings/components/ContainerRebuildPanel.vue` | 扩充：自动升级开关 + 代码版本 / 后台版本列 + 待升级徽标 |
| `admin/src/views/settings/SystemSettingsView.vue` | 如需注册新面板 / 分类（最小改动） |
| `runtime-build.spec.ts`（新增）、`container-auto-upgrade.spec.ts`（新增）、`runtime-agent.spec.ts` / `runtime-channel-protocol.spec.ts` / `container-registry.spec.ts` / `settings.service.spec.ts` / `tests/admin-settings-cards.spec.ts`（扩充） | §6 用例 |
| `CHANGELOG.md` + `docs/agents/container-docker-mode.md` | 记录与排查文档 |

预估：后端 ≈ 1 人日（含测试与迁移）；前端 ≈ 0.5 人日（开关 + 版本列 / 徽标 + 门禁用例）。

## 9. 可选扩展（不在本期）

- **P1 创建参数指纹（env / entry 命令 / 镜像 id）→ rebuild**：与 0.0.393 的 `MAO_SKILLS_DIR` 同类问题（env 定型于 `docker run`，`docker start` 不更新）。做法：创建时记录 `sha256(排序后的 env 键值 + 启动命令 + docker image inspect 的 Id)`，漂移走 rebuild；复用同一「懒触发 + skip-busy」机制。
- **P2 镜像内容漂移**：镜像 tag 可被重建覆盖而不改名；记录 image digest 可检测，但 rebuild 容器并不重建镜像本身，价值有限，暂缓。
- **P3 批量收敛编排接口**：现「重建全部」由前端逐用户调用单用户接口；如需发布脚本集成（「必须立即收敛」场景），可加批量接口（复用 skip-busy 语义）。
- **P4 busy 细化**：shell 会话空闲超过 N 分钟时视为可重启（需要区分「用户挂着终端」与「僵尸会话」，风险偏高，暂缓）。

## 10. 评审结论（2026-10-31）

| # | 问题 | 结论 | 落地位置 |
|---|------|------|---------|
| 1 | 是否加 kill switch | **加**：`system_setting.runtime.container.autoUpgrade`，V178 迁移插入、默认 `true`、后台「运行环境 → 容器管理」可切换 | §3.7、§4-11、§7 |
| 2 | 存量容器 unknown（旧 agent 不报 build） | **视为漂移**，one-shot 自愈一次（每容器最多重启一次） | §3.4、§5-1 |
| 3 | 管理后台展示是否本期 | **本期含前端**：容器管理面板加自动升级开关、代码/后台版本列与「待升级」徽标 | §3.6、§8 |
| 4 | 自动重启是否通知用户 | **不通知**：静默处理，靠日志与后台观察 | §5、§7 |


