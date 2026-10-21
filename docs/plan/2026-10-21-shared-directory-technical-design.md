# 共享目录 `/opt/mao-data/share` 技术方案

> 版本：v1.1（2026-10-21 评审补充）
> 状态：已评审（2026-10-21）：需求与技术方案均可行；已按评审意见补充 assertSafe 等式校验、修正测试计划事实、补全文档同步清单与文件数。尚未开发。
> 关联：2026-10-14 用户运行时容器隔离技术方案（挂载清单 §5.1、容器内允许根 §5.5、路径宽松解析为既定设计）
> 决策确认（2026-10-21）：① LOCAL 模式用户不可见该目录（服务端目录，与 workspace 可见性同边界）；② host 模式不强制只读（宽松解析为既定设计，只读保证仅容器模式成立）；③ 共享即公开，管理员不得向该目录投放敏感内容；④ 不在系统提示词中主动提及该目录，由用户指令或 agent 自行探索发现。

## 0. 决策摘要

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | 目录位置 | 新增 `/opt/mao-data/share`，env `MAO_SHARE_DIR` 可覆盖，配置键 `app.harness.shareDir`（与 `skillsDir` 同层：共享数据根，不属于 `MAO_CONTAINER_*` 容器调参系列） |
| 2 | 挂载方式 | 容器模式以 `ro` 挂载进每用户容器，容器内路径与宿主机逐字节一致（决策 15）；复用 `dist` 的 ro 先例，不新增挂载机制 |
| 3 | 沙箱放行 | 容器内 PathSandbox 增加 shareDir 允许根（唯一跨用户共享的允许根；/tmp 宿主机侧仍按 {tmpDir}/{userId} 收窄）；写保护由 ro 挂载强制（EROFS），沙箱层不引入 ro 概念 |
| 4 | host 模式 | 无需代码改动：宽松解析天然放行绝对路径；只读不强制（既定设计） |
| 5 | LOCAL 模式 | 不支持：目录在服务端，用户本地机器不可见（与 workspace 同边界） |
| 6 | 管理员投放 | v1 运维/管理员宿主机直投（cp + 属主），零代码；v2 admin 后台上传管理（后续按需，不在本次范围） |
| 7 | 提示词 | 不主动提及（用户明确要求） |
| 8 | 与 skills 关系 | 并存不合并：skills 是 rw 共享（容器内可安装/更新技能），share 是 ro 共享（公共文件），语义与权限模型不同 |

## 1. 背景与问题

### 1.1 现状

- 容器模式（docker）为每用户起独立容器，挂载清单由 `ContainerMountPlanner.plan()` 单点生成并校验（`backend-ts/src/harness/container/container-mount-planner.ts:75-102`），调用方不得自行拼 `docker -v`。
- 已存在两类跨用户共享目录先例：平台技能 `/opt/mao-data/skills` 以 **rw** 挂载进每用户容器（产品要求容器内可安装/更新共享技能），`dist` 以 **ro** 挂载（运行时 agent 代码）。"共享目录挂进容器"的机制、校验、指纹、审计全部现成。
- 管理后台没有任何文件管理页面：只有会话详情页内嵌的只读文件浏览器（`admin/src/views/session/components/WorkspaceFileDialog.vue`），后端写接口（`workspace-mkdir/write/delete` 等）全部是用户作用域。管理员投放公共文件目前只能走宿主机文件系统。
- host 模式（CLOUD 非容器）工具在宿主机执行，`PathSandbox` 宽松解析，绝对路径直接放行（`backend-ts/src/harness/safety/path-sandbox.ts:58-73`，容器隔离方案已记录此为已知越界面，靠 docker 挂载兜底）。

### 1.2 目标

1. 新增 `/opt/mao-data/share`，管理员可将公共文件投放其中，供全体 CLOUD 用户（host / docker 模式）的 agent 读取。
2. 容器模式下该目录以只读方式挂载进每用户容器，容器内文件工具（read_file / glob_search / grep_search / shell）可访问。
3. 升级零配置：默认路径开箱即用；既有容器经挂载指纹机制自动重建补齐挂载。

### 1.3 非目标

- 不做 admin 后台上传/管理界面（v2 预留方向，见 §6.2）。
- 不做按用户/用户组的目录级授权（共享即公开，见 §11）。
- 不做 host 模式的只读强制、LOCAL 模式支持。
- 不在系统提示词/工具描述中主动暴露该目录路径。
- 不做配额与容量管理（运维监控，见 §7）。

## 2. 现状盘点（代码事实）

| 项 | 现状 | 位置 |
|---|---|---|
| 挂载清单生成 | `plan()` 单点生成：每用户 rw 八项 + dist ro + skills rw；生成后立即 `assertSafe` | `container-mount-planner.ts:75-102` |
| 挂载安全校验 | `assertSafe`：rw 必须含 `/{userId}/` 段（skills 根与通道会话工作区 sessionWorkspace 为例外）；ro 项允许等于登记根自身；不得挂登记根的父目录；symlink realpath 逃逸检测；容器内路径不得重复 | `container-mount-planner.ts:152-227` |
| docker -v 生成 | `toDockerArgs`：`mode === 'ro' ? 'ro' : 'rw'` | `container-mount-planner.ts:230-236` |
| 挂载指纹 | `standardMountsFingerprint`：planner 变更（如新增 uploads 挂载）不重建老容器会缺挂载，指纹漂移即回收重建 | `container-mount-planner.ts:244-246` |
| 容器内允许根 | `ContainerToolExecutor` 构造：workspace/runtime/userHome/userSkills/uploads（均按 userId 收窄）+ /tmp | `container-tool-executor.ts:54-62` |
| 容器 roots 解析 | `resolveRoots`：env 覆盖 + 默认值（workspace/runtime/users/userskills/uploads） | `runtime-agent.ts:37-44` |
| docker run env | `-e MAO_CONTAINER_USER_ID / MAO_CHANNEL_TOKEN / MAO_WORKSPACE_ROOT / MAO_RUNTIME_DIR / MAO_USER_HOME_DIR / MAO_USER_SKILLS_DIR / MAO_UPLOAD_DIR` | `container-registry.ts:454-478` |
| planner roots 装配 | `ContainerRegistry` 构造：harness 级（userHome/runtime/workspace/userSkills/skills/uploads）+ container 级（deps/channel/dist/tmp） | `container-registry.ts:123-134`、`app-container-runtime.ts:73-102` |
| 配置三处 | `app-config.ts` interface + DEFAULTS；`config/application.yml`；`.env.example` | `app-config.ts:105-120`、`:237-250`、`application.yml`、`.env.example:36-42` |
| 目录启动创建 | `uploadDir` 口径：resolve + `mkdirSync(recursive)` | `create-app.ts:272-273` |
| admin 文件管理 | 无独立页面；会话详情只读浏览器；写接口均为用户作用域 | `admin/src/views/session/components/WorkspaceFileDialog.vue`、`file.routes.ts` |

## 3. 总体设计

### 3.1 目录与配置

- 宿主机路径：`/opt/mao-data/share`，env `MAO_SHARE_DIR` 可覆盖。
- 配置键：`app.harness.shareDir`。放在 harness 段而非 `cloudRuntime.container` 段的理由：与 `skillsDir` 同类——harness 级共享数据根（host 模式同样需要知道该路径）；`MAO_CONTAINER_*` 系列是容器调参（内存/CPU/镜像），share 是数据目录，混入会误导。
- 三处配置同步（机制与 skillsDir 相同；默认值取绝对路径口径，与 `runtimeDir`/`userHomeDir` 一致——skillsDir 默认为相对路径 `./skills`，不照搬）：

```ts
// app-config.ts：harness interface 增加
shareDir: string;
// DEFAULTS.harness 增加
shareDir: '/opt/mao-data/share',
```

```yaml
# config/application.yml：app.harness 段增加
share-dir: ${MAO_SHARE_DIR:/opt/mao-data/share}
```

```
# .env.example：与 SKILLS_DIR 等并列
MAO_SHARE_DIR=/opt/mao-data/share
```

- 启动兜底创建（与 uploadDir 同口径，`create-app.ts:272-273` 旁）：

```ts
const shareDir = resolve(expandHome(cfg.app.harness.shareDir));
mkdirSync(shareDir, { recursive: true });
```

### 3.2 与 skills 共享目录的关系

两者并存，不合并：

| | skills（`/opt/mao-data/skills`） | share（`/opt/mao-data/share`） |
|---|---|---|
| 挂载模式 | rw（容器内可安装/更新共享技能） | ro（公共文件，用户只读） |
| 内容语义 | 平台技能（有加载/缓存链路） | 无语义的公共文件 |
| 写入方 | 容器内 agent（产品要求） | 仅宿主机管理员/运维 |
| 沙箱允许根 | 否（技能走 SkillLoader，不经工具沙箱） | 是（文件工具需读取） |

## 4. 容器模式改造

### 4.1 挂载清单（container-mount-planner.ts）

`MountPlannerRoots` 增加 `shareDir: string`（注释标注 ro 共享根），`plan()` 标准清单追加一条（置于 dist 之后、skills 之前，ro 项聚拢）：

```ts
// 公共共享目录：管理员投放，全员只读（容器内路径与宿主机一致，决策 15）
{ hostPath: this.under(this.roots.shareDir, ''), containerPath: this.under(this.roots.shareDir, ''), mode: 'ro', purpose: 'share' },
```

`assertSafe` 的 `registeredRoots` 数组增加 `this.roots.shareDir`。现有规则覆盖大部分场景：

- ro 项允许"源路径等于某个登记根自身"（`:176-180` 现有规则）——share 挂的正是根自身；
- rw 必须含 userId 段的规则不适用于 ro 项；
- 父目录防护（`:195-201`）：shareDir 若被误配为某登记根的父目录（如 `/opt/mao-data`）直接抛 `MountPlanError`，fail-fast；
- 重复容器路径检测（`:222-224`）：shareDir 若等于 distDir/skillsDir（唯二挂在自身路径的登记根）会被拒绝。

**等式盲区（评审补充，需新增一道校验）**：shareDir 若等于 workspaceRoot/runtimeDir/userHomeDir/userSkillsDir/uploadDir/channelDir/depsDir/tmpDir 中任一个、或位于其下（如 `/opt/mao-data/workspace/7`），现有规则全部放行——这些根按 `{root}/{userId}` 挂载，容器路径不重复；父目录防护对等式 `continue` 跳过——整棵每用户数据会以 ro 挂进所有容器，构成跨用户可读，违背"宁可启动失败"的 fail-fast 原则。plan() 装配清单前断言（与 planSessionWorkspace 同口径抛 `MountPlanError`；放在 plan() 而非构造器：host 模式不起容器，不应因误配在启动时炸掉）：

```ts
// shareDir 必须独立于每用户数据根：等于或位于其下都会把该用户数据 ro 带进所有容器
const share = path.resolve(this.roots.shareDir);
const perUserRoots = [
  this.roots.workspaceRoot, this.roots.runtimeDir, this.roots.userHomeDir,
  this.roots.userSkillsDir, this.roots.uploadDir, this.roots.channelDir,
  this.roots.depsDir, this.roots.tmpDir,
].map((r) => path.resolve(r));
for (const root of perUserRoots) {
  if (share === root || share.startsWith(root + path.sep)) {
    throw new MountPlanError(`shareDir ${share} must not be or under per-user data root ${root}`);
  }
}
```

目录不存在时的行为：`assertSafe` 仅对 rw 项强制创建（`:210-215`），ro 项不存在则跳过；`docker -v` 对缺失的 bind mount 源会自动创建空目录。叠加 §3.1 的启动 `mkdirSync` 兜底，双保险。

### 4.2 容器内沙箱（container-tool-executor.ts）

`ContainerRoots` 增加 `shareDir: string`，构造中放行：

```ts
// 公共共享目录（§4.2）：唯一跨用户共享的允许根（/tmp 宿主机侧按 {tmpDir}/{userId}
// 收窄，仍属每用户）——内容对全员公开且挂载为 ro，纵深防御层放行整根；
// 写操作由 ro 挂载以 EROFS 拒绝
this.pathSandbox.addAllowedRoot(roots.shareDir);
```

写保护不在沙箱层实现：`PathSandbox` 无 mode 概念，引入 ro 需改全链路 resolve，收益小于成本；ro 由挂载强制，容器内（含 root）写入返回 EROFS，错误信息对 agent 可见，语义自明。

符号链接：容器内 strict resolve + `assertNoSymlinkEscape`（`path-sandbox.ts:76-88`）对 share 内指向外部的 symlink 做 realpath 逃逸检测并拒绝——行为安全（详见 §11.3）。

### 4.3 env 透传（container-registry.ts / runtime-agent.ts）

`ContainerRegistryOptions` 增加 `shareDir: string`（由 `app-container-runtime.ts` 的 deps 透传，与 `uploadDir`/`userSkillsDir` 同路径），planner 构造传入；`createAndStart` 的 docker run args 在 `-e MAO_UPLOAD_DIR` 后追加：

```ts
'-e', `MAO_SHARE_DIR=${this.opts.shareDir}`,
```

`runtime-agent.ts` 的 `resolveRoots` 同步：

```ts
const shareDir = process.env.MAO_SHARE_DIR ?? '/opt/mao-data/share';
return { workspaceRoot, runtimeDir, userHomeDir, userSkillsDir, uploadDir, shareDir };
```

### 4.4 指纹与容器重建

`standardMountsFingerprint` 取 `plan()` 输出（过滤 sessionWorkspace），share 条目自动进入指纹。上线后既有容器的指纹漂移，`ensureRunning` 时回收重建（现存机制，`container-mount-planner.ts:238-246` 注释即为此设计）：每个用户首次触发容器时重建一次，在途 shell/pty 随重建丢失（一次性代价，与历次挂载变更同口径）。

## 5. host 模式行为

无需代码改动：

- `PathSandbox` 宽松解析，agent 用绝对路径 `/opt/mao-data/share/...` 直接放行；目录存在性由启动 `mkdirSync` 保证。
- 只读**不强制**：宿主机上就是普通目录，host 模式进程可写（与容器隔离方案记录的既定越界面一致）。若只读是硬需求，引导用户切 docker 模式（决策确认 ②）。
- shell 工具同理：host 模式命令内容不经沙箱（既定边界），`cat /opt/mao-data/share/x` 直接可用；容器模式挂载即见，`workdir` 参数经同一沙箱放行（share 在允许根内）。

## 6. 管理员投放方式

### 6.1 v1 运维直投（本次范围）

- 管理员/运维在宿主机直接 `cp` 文件到 `/opt/mao-data/share`（建议属主与后端运行用户一致、权限 755；投放用同一用户或 sudo）。
- **即时生效**：挂载是目录级 bind mount，目录内新增/修改/删除文件无需重建容器，下一个工具调用即可见。
- 零代码，文档写清楚路径与属主即可。

### 6.2 v2 admin 后台（后续按需，不在本次范围）

预留方向：admin 新增「共享文件」页（列表/上传/删除），后端新增 `/admin/share/*` 路由 + 权限码（如 `share:manage`），复用 `file` domain 的部分逻辑但需新作用域（非用户目录，写路径收口到 shareDir）。触发条件：运维直投不够用（多人协作管理、操作审计）。预估 2-3 人日。

## 7. 部署与运维

- 新部署：`.env` 无需显式配置（默认值）；`/opt/mao-data/share` 由后端启动自动创建。
- 存量部署：升级后端即自动创建目录；管理员投放文件即可，无需重启（容器模式用户首次使用时自动重建容器补齐挂载）。
- 误配（如 shareDir 设为某登记根父目录）在容器创建时由 `assertSafe` fail-fast，错误信息明确，不静默降级。
- 容量：共享目录不计入任何用户配额，占满磁盘影响全体——建议纳入运维 `df` 监控（文档提示，不做代码配额）。

## 8. 测试计划

Vitest（`cd backend-ts && npm test`），具体用例：

**container-mount-planner.spec.ts**（roots helper 增加 `shareDir`）：

1. `mountsShareDirReadOnly`：`plan(7)` 含 `purpose=share` 条目，`mode='ro'`，`containerPath === hostPath`，hostPath 恰为 shareDir 根（不含 userId 段，ro 豁免）。
2. `shareDirMissingIsTolerated`：shareDir 不存在时 `plan` 不抛错（ro 不强制创建）。
3. `rejectsShareDirAsParentOfRoot`：shareDir 误配为 workspaceRoot 父目录时 `plan()` 抛 `MountPlanError`；`rejectsShareDirEqualToPerUserRoot`：shareDir 误配为 workspaceRoot 自身、或位于其下（如 `{workspaceRoot}/7`）时同样抛错（§4.1 等式校验）。
4. 指纹：`standardMountsFingerprint` 随 share 配置变化（现有指纹用例同口径补断言）。

**container-tool-executor.spec.ts**：

5. `readsFileUnderShareRoot`：shareDir 下放文件，`read_file` 传绝对路径可读。
6. 现有 9 处 `ContainerToolExecutor` 构造（spec `:47`、`:84`、`:110`、`:150`、`:178`、`:201`、`:220`、`:253`、`:282`）补 `shareDir` 必填字段（TS 强制，漏改即编译错）；`runtime-agent.ts:71` 经 `resolveRoots()` 自动覆盖，无需手改。

**runtime-agent.spec.ts**：

7. `ROOT_ENV_KEYS`（`:16`）增加 `MAO_SHARE_DIR`（注意该清单现有 4 键、不含 `MAO_UPLOAD_DIR`，无既有 env 覆盖用例可搭车，属新增覆盖）；`startAgent`（`:64-67` 显式设 env 处）同步加一行；`resolveRoots` 默认值断言同口径补。

**container-registry.spec.ts**：

8. docker run args 含 `-e MAO_SHARE_DIR={shareDir}` 与 `--volume {shareDir}:{shareDir}:ro`（现有 `:99` 的 `-e MAO_UPLOAD_DIR` 断言同口径）；spec 两处 `new ContainerRegistry`（`:27`、`:389`）的 options 补 `shareDir`（TS 强制）。

**不做单测**：ro 写拒绝（EROFS）无法在单测环境复现（临时目录非真 ro 挂载）。上线后人工验证：容器内 `touch /opt/mao-data/share/x` 应失败、`cat` 应成功。

## 9. 文档同步清单（AGENTS.md 规范：同任务完成）

| 文件 | 改动 |
|---|---|
| CHANGELOG.md | 顶部新增 `## 0.0.325 (日期)`，后端小节：新增共享目录 + 容器只读挂载 |
| `skills/mao-cli/reference/config.md` | 目录表（`:24-29`）加 `/opt/mao-data/share`（`MAO_SHARE_DIR`）；env 表加独立行（非 `MAO_CONTAINER_*` 系列） |
| `skills/mao-cli/reference/deploy.md` | 容器隔离运行时（V0.0.295）小节：数据目录前置条件补 `/opt/mao-data/share`（自动创建、属主建议、ro 挂载、宿主机投放、即时生效） |
| DEPLOY.md | 仅一行链接指向 deploy.md，确认链接有效即可，无需改内容 |
| `backend-ts/.env.example` | 加 `MAO_SHARE_DIR=/opt/mao-data/share` |
| `backend-ts/config/application.yml` | `app.harness` 段加 `share-dir` |
| README.md | 如列数据目录结构则同步（实施时确认） |
| `skills/mao-cli/SKILL.md` | 如提及数据目录则同步 |

## 10. 工作量与分期

| 范围 | 涉及文件 | 估时 |
|---|---|---|
| v1 核心（配置 + 挂载 + 沙箱 + env + 测试 + 文档） | 9 个源文件（app-config、application.yml、.env.example、create-app、app-container-runtime、mount-planner、tool-executor、runtime-agent、container-registry）+ 4 个 spec + 3-4 个文档，约 300-400 行（含测试） | 0.5-1 人日 |
| v2 admin UI（后续按需） | admin 页 + 路由 + 权限码 + 后端 service | 2-3 人日 |

## 11. 风险与边界

1. **共享即公开**：目录对所有 CLOUD 用户（host/docker）可读。管理员向该目录投放敏感内容等于主动公开给全体用户——投放规范写入 DEPLOY.md，v2 后台加上传时同位置提示。
2. **host 模式只读不强制**：宿主机普通目录，host 模式进程可写（既定越界面，容器隔离方案已记录）。只读保证仅容器模式成立（决策确认 ②）。注意 `MAO_CLOUD_RUNTIME` 默认值为 `host`：默认部署下任何用户的 agent 均可改写/删除 share 内容并波及其他用户，重要公共文件投放后需留意；docker 模式才具备 ro 保证。
3. **符号链接**：容器内 share 下指向外部的 symlink 被 strict resolve + realpath 逃逸检测拒绝（读取报错，行为安全）；宿主机 host 模式下 symlink 会被跟随（宽松解析）。管理员投放时避免使用逃逸链接，文档提示。
4. **容量无配额**：共享目录不占用户配额，写满影响全体服务，纳入运维磁盘监控。
5. **容器重建一次性代价**：上线后每个用户首次使用容器时因挂载指纹漂移重建一次，在途 shell/pty 丢失（现存机制，历次挂载变更同口径）。
6. **LOCAL 模式不可见**：目录在服务端，Electron 本地执行用户机器上不存在该路径（与 workspace 可见性同边界，决策确认 ①）。
