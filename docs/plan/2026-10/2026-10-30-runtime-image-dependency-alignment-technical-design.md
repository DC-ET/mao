# 用户运行时镜像依赖对齐（防漂移）技术方案

> 状态：已确认（2026-10-30：D1–D7 按推荐列落定，D6 保持另排；Q1–Q5 按建议口径落定，Q6 待定）
> 下一步：按 §9 实施 A → B → C → D（E/D6 另排）；本轮仅提交方案文档
> 日期：2026-10-30
> 事故来源：2026-10-30 上午 Docker 模式全面启用后，所有用户工具调用报「容器运行时通道连接超时: userId=N (15000ms)」，根因是运行时镜像缺 `yaml` 依赖。当场止血（0.0.379）已上线：镜像补 `yaml` + precheck 增加加载冒烟。本方案处理止血后的系统性防漂移改造。
> 关联文档：[2026-10-14-user-runtime-container-isolation-design.md](2026-10-14-user-runtime-container-isolation-design.md)（容器隔离基础方案；本方案沿用其 §5 的全部实现约定，不改变隔离模型）
> 覆盖端：backend-ts、部署脚本（仓库内 `scripts/` + `/data/deploy-mao.sh`）、`Dockerfile.runtime`、CI workflow；desktop / contracts 零改动，admin 仅一处「运行环境」状态展示（D4）。
> 一句话：把「镜像依赖」从手写清单改为 lockfile 派生，并在 CI / 切换 / 部署 / 运行期四道关卡上机器化校验，使「镜像与 dist 依赖漂移」从静默 15 秒超时变为当场明确失败。

---

## 0. 决策摘要（2026-10-30 已按推荐列确认）

| # | 决策点 | 推荐做法 | 备选 |
|---|---|---|---|
| D1 | 镜像依赖来源 | 改为 `npm ci --omit=dev`（backend-ts 全量生产依赖，lock 锁定），**删除手写包清单** | 保持手写清单 + D2 强制同步 |
| D2 | 闭包契约测试 | 新增「runtime-agent 的 import 闭包 ⊆ 生产依赖」单测，进现有 CI（backend job 已跑 `npm test`） | 不做，靠 D3/D5 运行时兜底 |
| D3 | 镜像依赖指纹 | 镜像写入 `org.mao.runtime.deps-hash` label（`package-lock.json` sha256 前 16 位）；precheck 比对：不匹配先跑加载冒烟（0.0.379 已有），冒烟失败则拒绝并提示重建 | 不做 label；或严格 fail（lock 一变化就拒绝） |
| D4 | 快速失败与可观测 | docker 模式下预检/激活失败后，工具调用**立即返回明确错误**（带退避重试，不永久毒化），管理后台「运行环境」展示健康状况 | 维持现状（每调用等 15s 超时） |
| D5 | 部署自动对齐 | 部署流程新增：镜像指纹 ≠ 当前 lock → 构建到临时 tag → 冒烟 → 切流前 re-tag `latest`；构建失败中止本次部署（待确认口径，见 §10 Q1） | 仅告警不自动 |
| D6 | 容器侧去宿主耦合 | 本轮不做（2026-10-30 已确认另排），列后续清理项：`container-tool-executor` 不再 import `experience-index.service`（本次 `yaml` 正是由此链路进入闭包），并在契约测试中加「闭包不得进入宿主服务目录」断言 | 本轮一并做（工作量 +0.5d） |
| D7 | 镜像清理与保留 | 每次重建保留 dated tag 最近 2 个，清理 dangling 层 | 只留 `latest` |

---

## 1. 事故回顾与本方案定位

### 1.1 时间线

| 时间 | 事件 |
|---|---|
| 10-20 07:21 | 运行时镜像 `mao-runtime:latest` 构建（手写清单 4 个包：`sharp` / `node-pty` / `@modelcontextprotocol/sdk` / `minimatch`） |
| 10-22 | 上一次容器成功运行（`mao-user-2`，此后镜像未再重建） |
| 10-24 | 团队经验库 0.0.342 合入：`container-tool-executor.ts` 新增 import `../experience/experience-index.service.js` → `experience-frontmatter.ts` → `import 'yaml'`，**`yaml` 自此进入容器侧 import 闭包** |
| 10-29 21:29 | 部署重建 `dist`（含上述引入） |
| 10-30 09:35 | 全局运行模式切 docker。precheck 通过（当时只查 docker 可用 / 镜像存在 / 目录可写），随后 user 8 / 16 的任务全部 15s 连接超时 |
| 10-30 09:37 前后 | 切回 host 止血 |
| 10-30 10:00 前后 | 0.0.379 上线：镜像补 `yaml`；precheck 增加「镜像 + 当前 dist 实际加载一次 runtime-agent 与 sharp / node-pty」的冒烟 |

### 1.2 技术根因

容器侧 `runtime-agent` 的**代码**来自宿主机只读挂载的 `dist`，**第三方依赖全部来自镜像**的 `/opt/mao/backend-ts/node_modules`（Node 模块解析从 dist 向上命中镜像内的 node_modules）。三个事实叠加：

1. `yaml` 在 10-24 之后成为容器闭包的一部分（经经验库 import 链路）；
2. 镜像构建停留在 10-20 的手写清单，没有 `yaml`；
3. 容器内 `node runtime-agent.js` 启动即 `ERR_MODULE_NOT_FOUND` 退出 → 宿主机 `waitSocketReady` 轮询 15s 无连接 → 抛「容器运行时通道连接超时」。

失败形态之所以难定位：容器已被 `cleanupFailedStart` 自动 `rm -f`，事后 `docker ps -a` 查无此容器；错误只表现为每个用户、每次工具调用的 15 秒超时。

### 1.3 为什么现有护栏没有拦住

| 护栏 | 拦不住的原因 |
|---|---|
| `ContainerRegistry.precheck` | 只校验「docker 可用 / 镜像存在 / channelDir 可写」——镜像是存在的，只缺一个包 |
| `container-import-constraints.spec.ts` | 只扫描 5 个容器源文件的**直接** import，且只查禁用模式（MySQL/JWT/LLM）；`yaml` 是三级间接依赖，且「不非法」≠「镜像里有」 |
| 后端启动预检 | DB 设为 docker 时启动预检失败仅打日志继续跑（慢失败），没有阻断也没有可见性 |
| 部署流程 | `deploy-mao.sh` 与镜像构建完全解耦——镜像重建靠人记得，且没有任何检查会提醒 |

### 1.4 止血现状与遗留问题

0.0.379 已解决「这一次」：`yaml` 补进镜像构建链（`Dockerfile.runtime` + `scripts/build-runtime-image.sh`），precheck 增加加载冒烟（此后切 docker 时闭环校验镜像能承载当前 dist）。

**遗留的系统性问题**（本方案要解决的）：

1. 手写清单继续存在——下一个新依赖还会以同样方式漏；
2. 没有"闭包 ⊆ 镜像"的静态契约——CI 阶段零拦截；
3. 部署不联动镜像——dist 与镜像的耦合点没有任何自动检查；
4. DB-docker 模式下预检失败是"慢失败"——用户等 15s、管理员看不见。

---

## 2. 现状机制盘点（方案的事实基础）

### 2.1 镜像与代码的依赖供给关系

| 组成 | 来源 | 更新时机 |
|---|---|---|
| 容器侧代码（`runtime-agent.js` 及其 import 链） | 宿主机 `dist` 只读挂载（路径空间原则：容器内路径与宿主机逐字节一致） | 每次部署（dist 重建） |
| 第三方依赖（`yaml`、`sharp`、`node-pty`、`@modelcontextprotocol/sdk`、`minimatch`） | 镜像内 `/opt/mao/backend-ts/node_modules` | 手动执行 `scripts/build-runtime-image.sh` |
| OS 层（bash / git / python3 / build-essential） | 镜像 | 同上 |

Node ESM 解析规则决定了：从 `dist/.../*.js` 出发的 bare import，会沿 `/opt/mao/backend-ts/dist → /opt/mao/backend-ts/node_modules（镜像内）→ /opt/mao/node_modules → …` 向上查找——**闭包中每个包都必须命中镜像内的那一层**。

### 2.2 依赖漂移的触发事件矩阵

| 事件 | 是否影响"闭包 ⊆ 镜像" | 现在的暴露方式 |
|---|---|---|
| backend-ts 新增 npm 包，容器代码开始使用 | ✅ 镜像缺包 | 容器重建时 agent 启动即崩 → 每用户每次调用 15s 超时（本事故） |
| backend-ts 升级某依赖版本（如 sharp） | 版本漂移 | 镜像按 `^范围` 装到与宿主 lock 可能不同的版本（潜在、未爆过） |
| 宿主机 Node 升级，镜像未重建 | native 模块 ABI 不匹配 | 容器内读图（sharp）/ 终端（node-pty）静默失败（基础方案已记录） |
| 任何一次部署重建 dist | dist 用到的包集合可能变化 | 容器**重建时**才暴露（`docker start` 复用旧容器不重算） |
| 手工改 tag / 多分支镜像混用 | 镜像内容与预期不符 | 无任何检查（precheck 只查名字存在） |

### 2.3 现有护栏及其盲区（截至 0.0.379）

| 护栏 | 现状 | 盲区 |
|---|---|---|
| `precheck()` | docker 可用 + 镜像存在 + 目录可写 + **加载冒烟**（当前 dist 在镜像内实际 import） | 只在「切模式 / 启动」时跑；已处于 docker 模式时部署新代码不会触发 |
| 管理后台切换校验（`validateRuntimeModeSave`） | 预检失败拒绝保存 | 同上，只管"切换那一刻" |
| 后端启动 | env 模式 docker 失败 → `exit(1)`；**DB 模式 docker 失败 → 仅日志告警继续跑** | 慢失败：用户每次调用等 15s |
| 契约测试（import constraints） | 5 个容器源文件的直接 import，查禁用模式 | 不递归、不管"包是否在镜像里" |
| CI（`.github/workflows/ci.yml` backend job） | `npm test` 全量单测 | 无依赖对齐相关测试 |

### 2.4 关键约束与不变量（本方案不得破坏）

1. **隔离模型不变**：安全边界仍是挂载清单；不引入新的宿主机目录进容器。
2. **路径空间原则不变**（基础方案决策 15/16）：不引入容器内路径翻译层。
3. **不静默降级**：宁可显式失败并给出可操作错误，不做"自动回落 host 执行"（安全语义不允许）。
4. **零迁移偏好**：不新增数据库表 / 迁移脚本；状态尽量走内存与只读接口。
5. **host 模式行为零变化**：不启用 docker 的部署不受任何影响。
6. **不把宿主 `node_modules` 挂进容器**（已评估否决）：native 模块按宿主 glibc/Node ABI 构建，与镜像基础环境（`node:22-bookworm-slim`）不保证兼容；且会把后端全部代码依赖带进容器，违背最小化。

---

## 3. 方案总览

### 3.1 目标 / 非目标

**目标**：

- 让"镜像依赖与 dist 需求"的同步**不再依赖人工记忆**：构建自动对齐（D5）、内容可验证（D3）、CI 可拦截（D2）。
- 把该故障从「静默 15 秒超时 × 每用户」变为「**切换/部署时一次性明确报错 + 后台可见**」（D3/D4）。
- 长期收益：新增 npm 依赖零维护成本（D1）。

**非目标**：

- 不改容器隔离架构、挂载清单、通信协议、生命周期管理；
- 不做多机镜像分发（registry），当前单机自建镜像（记为未来成本）；
- 不做容器内自动安装依赖（违背镜像不可变原则）。

### 3.2 改造点总览（按发现时机分层）

```
人写代码时   ▼ D2 闭包契约测试（CI）         ← 新增依赖未同步清单？PR 直接红
镜像构建时   ▼ D1 全量依赖 + D3 label 写入    ← 清单从 lockfile 生成，无手写项
切模式/启动时 ▼ precheck（0.0.379 冒烟）+ D3 指纹比对  ← 镜像过期？当场拒绝并说清原因
部署时       ▼ D5 指纹比对 → 自动重建 → 冒烟 → 切流前生效  ← 人不再需要记得
运行中       ▼ D4 快速失败 + admin 健康状态   ← 万一仍有漏网，秒级可见、不等 15s
```

### 3.3 改造后的事件矩阵（谁发现、怎么恢复）

| 事件 | 发现点 | 结果 |
|---|---|---|
| 新依赖进闭包、清单未同步 | CI（D2） | PR 红，人改 lock 即可（D1 后无需改清单） |
| 新依赖进闭包、镜像未重建 | 部署时（D5） | 自动重建镜像后切流，用户无感 |
| 部署时构建失败 | 部署脚本（D5） | 中止本次部署（旧版本继续跑），明确报错（口径见 §10 Q1） |
| 镜像过期但跳过部署 | 切模式/启动 precheck（D3） | 拒绝切换 / 后台红字；已在 docker 时由 D4 快速失败 + 重试 |
| 宿主机 Node 升级 | precheck 冒烟（0.0.379） | 构建/切换时明确失败（ABI 不匹配） |

---

## 4. 详细设计

### 4.1 镜像构建：依赖来自 lockfile（D1）

**问题**：`Dockerfile.runtime` 手写 4 个包（0.0.379 后 5 个），每加一个进入闭包的依赖都要人工同步，且版本用 `^范围`，与宿主 lock 的精确版本可能不一致。

**做法**：镜像不再手写依赖，直接安装 backend-ts 的全量生产依赖：

```dockerfile
FROM node:22-bookworm-slim

ARG APT_MIRROR=deb.debian.org
# ……apt 层保持现状（bash/git/coreutils/curl/procps/python3/build-essential）……

# 依赖来源 = backend-ts 的 lockfile（单一真相）。dist 只挂代码、不带 node_modules，
# 因此容器闭包里的每个包都必须由这一层提供。
COPY backend-ts/package.json backend-ts/package-lock.json /opt/mao/backend-ts/
RUN cd /opt/mao/backend-ts \
  && npm ci --omit=dev --no-audit --no-fund \
  && npm cache clean --force

CMD ["node", "/opt/mao/backend-ts/dist/harness/container/runtime-agent.js"]
```

`scripts/build-runtime-image.sh` 相应简化：删除 5 个版本读取（`SHARP_VERSION` 等），保留 `APT_MIRROR`；新增 label 写入（§4.3）与可选 dated tag（D7）。

**实测数据（2026-10-30，本机）**：

| 指标 | 现状 | 改造后 |
|---|---|---|
| 镜像内 node_modules | 111MB（6 个顶层包 + 传递依赖） | **292MB / 414 个包** |
| 镜像总体积 | 1.12GB | 约 1.30GB（+180MB） |
| npm 安装耗时 | 数十秒 | 热缓存 3s / 镜像内冷构建 +1~3 分钟 |
| 版本一致性 | `^范围`，可能与宿主 lock 漂移 | **与 `package-lock.json` 严格一致** |

**风险与缓解**：

- *native 构建*：`node-pty` / `bcrypt` 走 node-gyp，`sharp` 拉预编译二进制——镜像已装 `python3` + `build-essential`，构建失败会显式报错。
- *构建网络*：npm registry / apt 均需可达；apt 已踩过 `deb.debian.org` 卡死的坑，脚本保留 `APT_MIRROR=mirrors.aliyun.com` 的用法并在文档标明。
- *体积*：+180MB 磁盘、单机自建镜像无分发成本；历史镜像按 D7 清理。

**不做**：把宿主 `node_modules` 挂进容器（ABI/glibc 不兼容，且扩大容器可见面），见 §2.4-6。

### 4.2 闭包契约测试（D2）

**目标**：把"容器代码能 import 哪些包"从口头约定变成 CI 可执行断言，在 PR 阶段就拦住"新增依赖但镜像没跟上"（D1 后清单自动跟随，但 devDependency 误入、宿主服务目录误入仍需拦截）。

**落点**：新增 `backend-ts/src/harness/container/container-dependency-closure.spec.ts`（与现有 `container-import-constraints.spec.ts` 并列，互不替代）。

**算法**：

```
起点：src/harness/container/runtime-agent.ts
递归：读文件 → 匹配 /(?:from\s+|import\s*\()\s*['"]([^'"]+)['"]/g
  - 相对路径（./ ../）→ 解析后继续递归（.js → .ts；无扩展名补 .ts）
  - node: 前缀 / Node 内置（builtinModules）→ 放行
  - 其余 bare specifier → 取包根（@scope/pkg/sub → @scope/pkg）收集
断言 1：收集结果 ⊆ backend-ts/package.json 的 dependencies（禁止 devDependencies）
断言 2：容器源码中不得出现非字面量的动态 import（import(变量)）——正则兜底，当前 0 处
失败输出：打印完整闭包清单 + 未命中的包名 → 直接告诉开发者缺什么
```

**边界与取舍**：

- 只做静态解析：`import type` 与运行时 import 同语法，一并检查（保守方向正确）。
- 测试跑在 `src` 源码图上，与构建产物 `dist` 的模块说明符一一对应（tsc 不改 import 路径语义），无需先 build。
- 现有 CI（`.github/workflows/ci.yml` 的 backend job）已执行 `npm test`，**零 CI 配置改动**。

**收益**：闭包清单变成可 review 的产物；D6 完成后可再追加「闭包不得进入 `harness/experience/*` 等宿主服务目录」断言（本轮不加，因为当前就会红，见 D6）。

### 4.3 镜像依赖指纹 label（D3）

**目标**：让"镜像是用哪一版 lockfile 构建的"可查询，把 precheck 的错误从"加载失败"升级为"镜像依赖过期，请重建"。

**定义**：

- label：`org.mao.runtime.deps-hash`
- 口径：`sha256(backend-ts/package-lock.json)` 的十六进制前 16 位。
- 写入：`docker build --label org.mao.runtime.deps-hash=<hash>`（构建脚本用 `sha256sum`）。
- 读取：`docker image inspect --format '{{index .Config.Labels "org.mao.runtime.deps-hash"}}' <image>`。

**后端实现**：新增 `backend-ts/src/harness/container/deps-hash.ts`，提供 `depsHashOfLockfile(path)`；lock 路径由 `distDir` 推导（`{distDir}/../package-lock.json`，与镜像内 node_modules 同层）。与构建脚本共享同一口径，单测对拍（同一文件两端结果一致，防"永远不匹配"）。

**precheck 判定矩阵**（0.0.379 的加载冒烟是**硬闸门**，label 负责解释与部署联动）：

| 镜像 | label | 冒烟 | 结论 |
|---|---|---|---|
| 不存在 | — | — | fail：镜像不存在（现有文案） |
| 存在 | 匹配 | 通过 | pass |
| 存在 | 匹配 | 失败 | fail：镜像损坏 / Node ABI 不符，提示重建 |
| 存在 | 不匹配 | 通过 | **pass + warn**（指纹过期但实际可加载；D5 会在部署时补齐） |
| 存在 | 不匹配 | 失败 | fail：「镜像依赖与当前代码不匹配，请执行 scripts/build-runtime-image.sh」 |
| 存在 | 缺失（旧镜像） | 通过 | pass + warn（提示重建以获得指纹） |
| 存在 | 缺失 | 失败 | fail：提示重建 |

**错误文案模板**（统一到「原因 + 处置」）：

```
容器运行时不可用：运行时镜像 mao-runtime:latest 依赖指纹过期（镜像 <hashA> ≠ 当前 <hashB>），
且加载当前 dist 失败：<原始错误>。处置：在部署机执行 bash scripts/build-runtime-image.sh 后重试。
```

**单测**：`deps-hash.spec.ts`（口径对拍）+ `container-registry.spec.ts` 增加 label 分支（fake docker 返回不同 label 组合）。

### 4.4 快速失败与可观测（D4）

**问题**：DB 设为 docker 且启动预检失败时，后端只打一行日志继续跑；此后每个用户的每次工具调用都要走完 `createAndStart → waitSocketReady 15s` 才失败，用户侧是「卡 15 秒然后报错」，管理员侧毫无感知。

**设计**：

1. `ContainerRegistry` 增加预检状态：`lastPrecheck: { ok: boolean; message: string; atMs: number } | null`，由 `precheck()` 成功/失败时维护；`precheck()` 加 single-flight（并发调用共享同一个进行中的 Promise）。
2. 新增 `assertRuntimeReady()`，在 `ensureRunning()` 入口调用（覆盖工具 / 终端 pty / read_bytes / MCP 全部路径）：
   - 从未预检过 → 先跑一次 precheck；
   - `ok=true` → 放行；
   - 失败且在退避窗口内（30s）→ **立即抛**「容器运行时不可用：<message>」，不再等 15s；
   - 退避窗口到期 → 重新 precheck（失败再次记录并抛）。
   - 预检成功则后续容器创建照旧；预检失败**不缓存成永久状态**（避免 docker 抖动把服务钉死，见 §8）。
3. 错误文案统一为「原因 + 处置」，例如：
   `容器运行时不可用：运行时镜像缺少依赖指纹且加载当前 dist 失败（Cannot find package 'yaml'）。处置：执行 bash scripts/build-runtime-image.sh 重建镜像，或在管理后台切回 host。`
4. 管理后台可观测：新增只读端点 `GET /v1/admin/runtime-environment`（admin 权限），返回：

   ```json
   {
     "mode": "docker",
     "image": "mao-runtime:latest",
     "imageExists": true,
     "imageDepsHash": "a1b2c3d4e5f60718",
     "expectedDepsHash": "a1b2c3d4e5f60718",
     "lastPrecheck": { "ok": false, "message": "...", "at": "2026-10-30T10:00:00+08:00" },
     "connectedUsers": [8, 16]
   }
   ```

   「系统设置 → 运行环境」区块展示一行状态（镜像 / 指纹一致 / 最近预检 / 在线容器连接数）；失败红字并带处置提示。`connectedUsers` 直接复用 `RuntimeChannelServer.connectedUserIds()`。
5. 范围控制：v1 只做「后台展示 + 日志 ERROR」，告警推送（飞书/webhook）列为开放问题（§10 Q3）。

### 4.5 部署自动对齐（D5）

**问题**：`deploy-mao.sh` 与镜像构建完全解耦，是本次事故的直接触发条件（部署重建了 dist，镜像停留在旧依赖集）。

**做法**：新增仓库内脚本 `scripts/align-runtime-image.sh`（可独立运行、可测试），部署脚本只加一行调用。伪代码：

```bash
# scripts/align-runtime-image.sh
LOCK=backend-ts/package-lock.json
WANT=$(sha256sum "$LOCK" | cut -c1-16)
HAVE=$(docker image inspect mao-runtime:latest --format '{{index .Config.Labels "org.mao.runtime.deps-hash"}}' 2>/dev/null || true)
[ "$WANT" = "$HAVE" ] && { echo "运行时镜像已对齐（$WANT）"; exit 0; }

TAG="build-$(git rev-parse --short HEAD)-$(date +%Y%m%d%H%M%S)"
bash scripts/build-runtime-image.sh "$TAG"          # 构建到临时 tag，不碰 latest
docker tag "mao-runtime:$TAG" "mao-runtime:$(date +%F)-$(git rev-parse --short HEAD)"   # 保留 dated tag（D7）
# 冒烟：与 precheck 同一条加载命令（dist 只读挂载）
docker run --rm -w /opt/mao/backend-ts \
  -v /opt/mao/backend-ts/dist:/opt/mao/backend-ts/dist:ro \
  "mao-runtime:$TAG" node -e \
  "import('file:///opt/mao/backend-ts/dist/harness/container/runtime-agent.js').catch(e=>{console.error(e.message);process.exit(1)})"
# 仅在此刻把 latest 指向新镜像（切流前一刻）
docker tag "mao-runtime:$TAG" mao-runtime:latest
docker image prune -f >/dev/null 2>&1 || true
```

`deploy-mao.sh` 插入位置（在"构建代码"之后、"后端蓝绿切换"之前）：

```
step "拉取最新代码"
step "构建 admin / desktop / backend"
step "运行时镜像对齐"      # ← 新增：bash scripts/align-runtime-image.sh
step "后端蓝绿部署"        # 原有，不变
```

**关键设计点**：

1. **构建到临时 tag、切流前才指向 `latest`**——避免构建窗口内新建的容器拿到「新镜像 + 旧后端」的组合。
2. **失败策略**：脚本非零退出 → `deploy-mao.sh` 中止（旧版本继续对外服务，不产生半升级状态）。是否区分 host/docker 模式见 §10 Q1。
3. **触发条件**：指纹不一致才重建（lock 未变化的普通部署零成本）。
4. **幂等**：重复执行无副作用；失败可重跑。

---

## 5. 兼容性、迁移与回滚

| 维度 | 结论 |
|---|---|
| 数据库迁移 | **无**。不新增表 / 字段 / 迁移脚本；预检状态是内存态 |
| 历史数据 | **无迁移**。镜像内容变化不影响挂载卷（workspace / runtime / deps / tmp） |
| 存量容器 | 无需手工清理。后端每次部署重启后 registry 为空，用户下次调用走「同名容器残留 → `rm -f` → `docker run`」自然换到新镜像（`container-registry.ts` 的 already-in-use 分支）；容器内瞬态状态（shell / pty / 后台任务）本就随重建丢失，文件数据保留 |
| 存量旧镜像（无 label） | precheck 按「label 缺失」处理：冒烟通过则放行并 warn 提示重建，不会误拦 |
| host 模式 | 行为零变化（D4 的 `assertRuntimeReady` 仅在 docker 路由路径生效） |
| 回滚 | 代码回滚会同步回滚 lock；D5 检测指纹不一致后自动重建对应依赖集的镜像。若关闭自动重建，则按 label 提示手动执行脚本 |
| 多实例部署 | 当前单机自建镜像；未来多实例需要私有 registry 分发，本方案不覆盖（记为未来成本） |

---

## 6. 部署中断语义（本方案不改变既有行为）

结论：**Docker 模式下部署会中断在途任务，但中断机制与时长和当前完全一致**；D5 新增的镜像重建发生在切流之前，不占用中断窗口。

### 6.1 一次部署的时间线（docker 模式）

| 阶段 | 发生什么 | 对在途任务 |
|---|---|---|
| ① 构建代码（+D5 镜像重建） | 旧实例、旧容器照常服务；镜像构建不触碰运行中的容器（按 image ID 引用） | 无影响 |
| ② 新实例启动 + 健康检查 | 旧实例继续接流量 | 无影响 |
| ③ nginx 切流（毫秒级） | 新连接走新实例，已有连接暂留旧实例 | 继续执行、继续流式输出 |
| ④ 旧实例收尾（≤5s 感知） | 静默入站 → 等在途执行收尾，**上限 40s**（drain 60s - 15s 余量、封顶 40s） | 剩余 ≤40s 的任务平稳跑完；跑不完的标记 `RESUMING` |
| ⑤ 旧实例停机 | `stopAllForShutdown` 对受管容器 `docker stop`（数据在挂载卷） | 容器内 shell / pty / 后台任务丢失（既有语义） |
| ⑥ 自动恢复 | 新实例崩溃恢复巡检（30s 节拍；`RESUMING` 静默 ≥45s 可恢复；部署窗口内让路） | 约部署开始后 2 分钟内自动续跑 |

容器侧：新实例 registry 为空，用户下一次活动触发 `ensureRunning` 时走「同名容器残留 → `rm -f` → `docker run`」重建容器，几秒级，与是否实施本方案无关。

### 6.2 与现状对比

| 项 | 现状 | 实施后 | 差异 |
|---|---|---|---|
| 用户可见中断窗口 | 切流 + 收尾 ≤40s | 同 | **无差异** |
| 在途任务恢复 | RESUMING → 自动续跑 | 同 | **无差异** |
| 容器重建时机/耗时 | 部署后首次使用，几秒 | 同 | **无差异** |
| 部署总时长 | T | T + 1~3 分钟（**仅 lock/Dockerfile 变化时**，切流前） | 变长，但不落在中断窗口 |
| 重建后容器可用性 | 缺依赖时每次调用 15s 超时、任务反复失败，直到人工重建镜像 | 0 | **本质差异** |

### 6.3 保证结论成立的两条实施要求

1. 镜像构建放在**切流之前**，构建到临时 tag、切流前一刻再指向 `latest`（避免"新镜像 + 旧后端"窗口）。
2. 镜像构建失败时**中止部署**（旧版本继续跑），不带旧镜像切流——否则正好复现本次事故形态。

---

## 7. 测试与验收

### 7.1 单元测试

| 用例 | 覆盖 |
|---|---|
| `container-dependency-closure.spec.ts`（新增） | 闭包 ⊆ 生产依赖；闭包清单快照；非字面量动态 import 禁止 |
| `deps-hash.spec.ts`（新增） | 与构建脚本 `sha256sum` 口径一致（同一文件两端对拍） |
| `container-registry.spec.ts`（扩展） | precheck 的 label × 冒烟判定矩阵；错误文案包含"重建镜像"指引 |
| `docker-tool-router.spec.ts` / `container-registry.spec.ts`（扩展） | `assertRuntimeReady`：失败 30s 内立即抛错、退避后重试、single-flight 去重 |

### 7.2 集成 / 手工验收

1. **镜像构建**：`bash scripts/build-runtime-image.sh build-test` → `docker image inspect` 见到 label；`docker run --rm` 冒烟通过。
2. **precheck 正例**：真实 docker + 生产 dist，`precheck()` 通过。
3. **precheck 反例**：临时把 label 改成错误值 + 人为让 smoke 失败（例如指向缺依赖的旧 dist）→ 拒绝并给出明确文案。
4. **端到端**：生产挂载起临时容器连接 `RuntimeChannelServer`，出现 `Runtime channel connected: userId=N`（0.0.379 已用此法验证）。
5. **部署演练（预发可选）**：在 lock 变化的分支上跑一次 `deploy-mao.sh`，确认①镜像自动重建②切流前 latest 指向新镜像③在途任务按 §6 恢复。
6. **admin 状态**：docker 故障态下接口返回 `lastPrecheck.ok=false` 与处置文案；恢复后变绿。

### 7.3 验收标准

- 新增一个进入闭包的依赖后：CI 红（未同步 lock 时）/ 部署自动重建镜像（lock 已同步时），**两种路径都不需要人工改 Dockerfile**。
- 镜像过期时切 docker：后台保存被拒绝且文案指向重建命令。
- docker 模式下预检失败：工具调用 <1s 返回明确错误（而非 15s）。
- 常规部署（lock 未变化）时长与现状一致。

---

## 8. 风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| 镜像 +180MB、重建时 dangling 层累积 | 磁盘占用 | D7：dated tag 保留 2 个 + `docker image prune -f`（在 align 脚本尾部） |
| 镜像构建依赖 apt / npm 网络 | 构建失败阻塞部署 | 脚本支持 `APT_MIRROR`；失败即中止（不产出半升级）；可重跑 |
| `npm ci` 全量安装引入 native 构建失败 | 同上 | 镜像已含 python3 + build-essential；失败信息直接可见 |
| label 口径两端不一致 | precheck 永远不匹配 | 共享 `deps-hash` 单测对拍；构建脚本与后端同算法（sha256 前 16 位） |
| 快速失败把临时故障缓存成永久不可用 | 比 15s 慢失败更糟 | 30s 退避重试 + single-flight；只缓存失败，不缓存"禁用" |
| 容器内依赖包从 6 个变 414 个 | 安全面/镜像扫描范围略增 | 包内无密钥；隔离仍靠挂载清单；如需合规将镜像纳入漏洞扫描 |
| 部署时长增加 | 变更窗口变长 | 仅 lock/Dockerfile 变化时触发；其余部署零成本 |
| 多实例部署 | 镜像需分发 | 本方案不覆盖，未来接私有 registry |

---

## 9. 实施拆分与顺序

| 任务包 | 内容 | 依赖 | 预估 |
|---|---|---|---|
| **A. 镜像依赖来源（D1+D3）** | `Dockerfile.runtime` 改 `npm ci`；`build-runtime-image.sh` 简化 + label；`deps-hash.ts`；`precheck` label 比对与文案；单测；**重建一次镜像** | 无 | 0.5d |
| **B. 闭包契约测试（D2）** | 新增 `container-dependency-closure.spec.ts`；接现有 CI | 无（可并行） | 0.25d |
| **C. 部署自动对齐（D5）** | `scripts/align-runtime-image.sh`；`deploy-mao.sh` 插一行；文档（`skills/mao-cli/reference/deploy.md`） | A（label 口径） | 0.25d |
| **D. 快速失败与可观测（D4）** | `assertRuntimeReady` + 退避/single-flight；admin 只读端点 + 页面状态行；单测 | A（复用 precheck 结果） | 0.5d |
| **E. 后续清理（D6）** | 容器侧去掉 `experience-index.service` 依赖；契约测试加"不得进入宿主服务目录"断言 | B | 0.5d（不阻塞本批） |

**建议实施顺序**：A → B → C → D（E 另排）。A+B 可同一 PR；C 依赖 A 的 label；D 独立。

---

## 10. 开放问题（2026-10-30：Q1–Q5 按建议口径确认，Q6 待定）

| # | 问题 | 建议 |
|---|---|---|
| Q1 | 部署时镜像构建失败的策略：一律中止？还是仅 docker 模式生效时中止、host 模式只告警？ | **一律中止**（最简单最安全；镜像只在该次部署涉及 lock 变化时构建，误伤成本低） |
| Q2 | admin 状态展示范围：只做接口，还是同步做页面状态行？ | 接口 + 页面一行状态（工作量很小，故障时第一现场可查） |
| Q3 | 是否需要"连续 N 次容器启动失败 → 通知管理员"？ | v1 不做；观察一段时间后按需接现有通知链路 |
| Q4 | D6（容器侧去宿主服务耦合）是否并入本批？ | 不并入，另开清理项 |
| Q5 | dated tag 保留数量 | 最近 2 个（可回滚一版） |
| Q6 | 镜像是否纳入漏洞扫描 / 合规流程 | 待定，取决于合规要求 |

---

## 11. 变更文件清单（实施时对照）

| 文件 | 动作 |
|---|---|
| `Dockerfile.runtime` | 改为 `COPY package.json + package-lock.json` → `npm ci --omit=dev`；删全部版本 ARG（5 个）；加 label |
| `scripts/build-runtime-image.sh` | 删版本读取；加 label / dated tag；保留 `APT_MIRROR` |
| `scripts/align-runtime-image.sh` | **新增**（指纹比对 → 构建 → 冒烟 → re-tag latest） |
| `/data/deploy-mao.sh`（不在 git 内） | 插入"运行时镜像对齐"步骤 |
| `backend-ts/src/harness/container/deps-hash.ts` | **新增**（lock sha256 前 16 位） |
| `backend-ts/src/harness/container/container-registry.ts` | precheck 加 label 比对与文案；`assertRuntimeReady` + 预检状态 |
| `backend-ts/src/harness/container/container-dependency-closure.spec.ts` | **新增** |
| `backend-ts/src/harness/container/container-registry.spec.ts` | 扩展 label / assertRuntimeReady 用例 |
| `backend-ts/src/admin/*` + `admin/` | 运行环境只读端点与状态行（D4） |
| `.dockerignore` | 注释更新（构建上下文现在需要 package.json / package-lock.json） |
| `CHANGELOG.md` | 一条后端条目 |
| `skills/mao-cli/reference/deploy.md` | 同步部署流程与镜像依赖说明 |



