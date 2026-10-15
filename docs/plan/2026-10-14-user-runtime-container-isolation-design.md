# 用户运行时容器隔离（User Runtime Container Isolation）技术方案

> 状态：已确认（2026-10-14 开发完成；架构级决策见 §10）
> 日期：2026-10-14
> 覆盖端：后端 backend-ts、部署脚本、数据库迁移。桌面端 desktop、管理后台 admin、安卓 android、`shared/contracts` **不改**。
> 上游讨论：本方案由 2026-10-14 与用户的架构对话产出，无独立提案文档。

---

## 1. 需求背景

Mao 当前所有 CLOUD 用户共用同一台 ECS 上的同一个后端进程、同一份操作系统视图。用户数据虽然按用户分目录存放，但**没有任何机制阻止一个用户读到另一个用户的数据**。

### 1.1 现状代码事实（实施前已核对）

| 事项 | 现状 | 说明 |
|---|---|---|
| 数据布局 | `runtime/{userId}/{sessionId}`、`users/{userId}`、`workspace/{userId}/projects/{slug}` | `runtime-data-resolver.ts:27-51`、`cloud-workspace-resolver.ts:38` |
| 目录配置 | `runtimeDir=/opt/mao-data/runtime`、`userHomeDir=/opt/mao-data/users`、`workspaceRoot=./workspace` | `config/app-config.ts:203-205`，环境变量 `MAO_RUNTIME_DIR` / `MAO_USER_HOME_DIR` 可覆盖 |
| 沙箱实现 | `PathSandbox`（`safety/path-sandbox.ts`）有 `resolve`（严格校验）与 `resolveLenient`（**绝对路径与 `../` 均放行**）两个方法 | 这是越界的直接根因 |
| 文件工具 | `read_file` / `write_file` / `glob_search` / `grep_search` / `edit_file` 等**全部调用 `resolveLenient`** | `read-file-tool.ts:56`、`write-file-tool.ts:50`、`glob-search-tool.ts:63`、`grep-search-tool.ts:66`、`edit-file-tool.ts:65` |
| 外部发送工具 | `dingtalk-tools.ts:118`、`wechat-tools.ts:127`、`feishu-tools.ts:280` 同用 `resolveLenient` 读本地附件 | 同类问题；微信的真正实现另有 `weixin/media-tool-support.ts:68`，也走 `resolveLenient` |
| REST 文件服务 | `/v1/files/workspace-*` 的 `dir`/`path` 经 `queryOptStr` 交给 `workspace-browse.service.ts:413` 的 `resolveLenient`，**用户输入完整参与路径解析** | 与 Agent 工具同源的越界面；`file.service.spec.ts:187` 的 `browsesAndReadsPathsOutsideTheWorkspace` 把该行为固化成了测试断言 |
| MCP stdio | `mcp-client-manager.ts` 的 `buildTransport` 用 `StdioClientTransport` 在宿主机 spawn 用户配置的 MCP 进程，`env: { ...process.env, ...env }` | 宿主机环境变量（含 `MYSQL_URL` 等）直接继承进用户可控进程；CLOUD 模式不经 `ToolDispatcher` 的 docker 分支 |
| CLOUD shell | `ShellSessionManager.createSession` 直接 `spawn('bash', ...)`，**无降权、无 chroot、无容器** | 以宿主机进程身份执行 |
| 云端终端 | `RemoteTerminal` 用 node-pty `spawn`（`remote-terminal.ts:99`） | 同上 |
| shell 拦截 | `command-deny-list.ts` 只有两条规则：`pkill node`、`killall` | 仅防误杀后端，与越界无关 |
| 已有缓解 | `sanitizeInheritedEnv` 剥离敏感环境变量；shell 会话按 `conversationId` 校验归属；`HOME` 指向每用户虚拟家目录 | 说明作者有安全意识，但均不构成 OS 级隔离 |
| 后端进程身份 | `scripts/start-backend.sh` 用 `nohup npm run start:dev`；线上 `backend-ts/restart.sh` 走 `setsid nohup node dist/main.js` | 以部署用户（线上为 root）身份运行 |

### 1.2 攻击面（可复现）

1. **Agent 直接读越界**：让模型调用 `read_file`，参数 `path` 传 `/opt/mao-data/users/2/anything`。`resolveLenient` 原样返回，后端进程以 root 读取，内容进入模型上下文并返回给攻击者。
2. **shell 越界**：`shell` 工具执行 `cat ../../users/2/...` 或 `ls /opt/mao-data/users/`。deny-list 不匹配，bash 以 root 执行。
3. **终端越界**：云端终端同理，且是交互式，用户可以反复探测。
4. **搜索遍历**：`grep_search` / `glob_search` 传绝对路径 `/opt/mao-data`，直接跨用户扫描。
5. **REST 越界**：`GET /v1/files/workspace-read?sessionId=<自己的会话>&path=/opt/mao-data/users/2/secret`。`workspace-directory` / `workspace-download` / `workspace-preview` / `workspace-download-zip` 同理。业务上前端只传工作区内相对路径，但接口层没有任何钳制，属可被直接构造的越界面。
6. **MCP stdio 越界 + 宿主机 env 泄漏**：CLOUD 会话配一个 `serverType=stdio` 的 MCP server，宿主机以 `{ ...process.env }` spawn 该进程。用户可用它读任意路径，并直接取走宿主机环境里的 `MYSQL_URL`、`APP_*` 密钥。
7. **凭据横向**：多用户共享一个 shell 会话池时，`sanitizeInheritedEnv` 只清了启动时继承的键；若存在跨用户复用会话的路径，Git token 与 `MAO_TOKEN` 会残留。

其中 1~5 是**同一条根因**：所有执行面共用一个操作系统身份，目录命名约定不是安全边界。6 是同一根因的另一种表现：宿主机进程身份 + 用户可控子进程。

### 1.3 设计目标

| 目标 | 判定标准 |
|---|---|
| 跨用户数据不可读 | 用户在任意工具、shell、终端、REST 文件服务中都拿不到其他用户的 `users/`、`workspace/`、`runtime/` 内容 |
| 容器零平台凭据 | 用户容器内**不存在** MySQL 密码、JWT secret、LLM API key、他人 Git token；仅持有按次下发的用户级凭据 |
| 可灰度 | 全局开关 + 用户级覆盖，可先切少量用户 |
| 不牺牲 host 模式 | `docker` 未启用时行为与现状完全一致 |
| 存量兼容 | 历史用户目录无需迁移即可被容器访问 |

---

## 2. 需求描述

### 2.1 要做的

1. **新增容器运行时模式**：`MAO_CLOUD_RUNTIME=docker|host`（默认 `host`），用户表新增覆盖字段，管理员可在后台按用户切换。
2. **每用户一个 Docker 容器**：容器内 root，只挂载该用户的数据目录；宿主机控制面负责创建、复用、idle 回收。
3. **执行类能力入容器**：`shell`、云端终端、`read_file` / `write_file` / `edit_file` / `glob_search` / `grep_search`、git 操作。
4. **宿主机—容器通道**：宿主机做 server、容器做 client，长度前缀 JSON over Unix socket，socket 目录 bind mount。
5. **容器内常驻 runtime agent**：Node 进程，`backend-ts/dist` 只读挂载，负责接收工具派发并转发到容器内的 bash/pty/fs。
6. **凭据按次下发**：宿主机在每次派发时把该用户的 Git token、`MAO_TOKEN`、`ECP_TOKEN`、workspace、HOME、runtime 目录等打进「会话环境包」，容器用完即弃。
7. **持久依赖目录**：每用户一个挂载目录，pip/npm 安装位置指向它，容器重建后依赖不丢。
8. **容器预热**：复用 `SessionActivityHeartbeat` 的活跃信号，用户打开桌面端即确保容器就绪。
9. **宿主机侧越界收口**（docker 与 host 模式都做）：REST 文件服务与 MCP stdio 的 `resolveLenient` / `process.env` 继承一并收紧，见 §5.9、§5.10。

### 2.2 不做的

| 项 | 说明 |
|---|---|
| AgentLoop 入容器 | loop 留宿主机（控制面）。loop 自身读写的是 MySQL 会话历史，不直接 fs 用户数据目录；容器内仅承接执行类工具 |
| 每会话一个容器 | 粒度为每用户一个，一个会话下的多个持久 shell 可跨会话复用 |
| 容器内 Linux 账号映射 | 容器内 root，不开 userns-remap，靠挂载清单隔离 |
| REST 文件服务入容器 | `/v1/files/workspace-*` 留在宿主机，但**必须先把 `resolveLenient` 换成严格解析**，否则它本身就是一个越界面，见 §5.9 |
| 数据库入容器 | MySQL 始终在宿主机，容器不持有任何连接凭据 |
| 本地模式（LOCAL）改造 | LOCAL 模式继续走 WebSocket 委托桌面端执行，与容器无关 |
| 镜像瘦身 / 多阶段构建优化 | 镜像保持精简即可，不追求极致体积 |
| gRPC / WebSocket 通道 | 见 §4 选型 |
| Windows named pipe | 部署在 Linux ECS、开发在 macOS，均支持 Unix domain socket |

---

## 3. 架构总览

### 3.1 两个平面

```
┌───────────────────────── 宿主机 ECS ─────────────────────────┐
│                                                              │
│  控制面（现有 NestJS 应用，保留 root）                        │
│  ├─ 鉴权 / JWT / 权限拦截器                                  │
│  ├─ MySQL（会话、消息、用户、模型配置）                       │
│  ├─ AgentLoop / PromptEngine / CompactionService             │
│  ├─ LLM 调用（API key 只在此处）                              │
│  ├─ ToolDispatcher（派发前查库取凭据、打环境包）              │
│  ├─ WebSocket 流式转发                                       │
│  ├─ 容器生命周期管理（create / reuse / idle stop）            │
│  └─ RuntimeChannelServer（每用户一个 Unix socket server）     │
│                                                              │
│  执行面（docker 模式）                                       │
│  ├─ container-user-{userId}   ← 只挂该用户目录               │
│  ├─ container-user-{userId}                                  │
│  └─ container-user-{userId}                                  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**切分原则**：凡是需要跨用户数据、平台凭据、集中配置的能力留在控制面；凡是会执行用户可控代码或直接触碰用户文件系统的能力进容器。

### 3.2 一次工具调用的完整链路（docker 模式）

```
AgentLoop (宿主机)
  → ToolDispatcher.dispatchFullOutcome (宿主机)
      ├─ 危险评估 / 审批 / 规则命中（宿主机，不变）
      ├─ 判定该工具是否 docker-only
      └─ DockerToolRouter
           ├─ ContainerRegistry.ensureRunning(userId)   ← 空闲则 docker start / 不存在则 docker run
           ├─ EnvelopeBuilder.build(userId)             ← 查库取 git token / MAO_TOKEN，拼 workspace/HOME/runtime
           └─ RuntimeChannelServer.request(userId, { tool, args, envelope })
                → Unix socket → 容器内 RuntimeAgent
                     ├─ bash spawn（shell）
                     ├─ node-pty spawn（终端）
                     ├─ fs 读写（文件工具）
                     └─ 结果 JSON 回传
```

### 3.3 与 host 模式的关系

`DockerToolRouter` 是本方案唯一的新增派发分支。host 模式下它不存在，`ToolDispatcher` 走原有 `toolRegistry.getTool()` 进程内调用，**代码路径零变化**。

---

## 4. 技术选型

| 决策点 | 选型 | 理由 | 已否决的备选 |
|---|---|---|---|
| 隔离机制 | Docker 容器，每用户一个 | 用户选定；生态成熟、镜像/日志/资源限制现成 | 每用户 Linux 账号（容器内 root 后无必要）、systemd-nspawn、chroot/bubblewrap |
| 容器粒度 | 每用户一个，跨会话复用 | `users/{userId}` 与 git 凭据都是用户级；一个会话下多个 `keep_session` 长任务需跨调用保持进程 | 每会话一个（启动开销大、shell 会话难复用） |
| 容器内身份 | root | 省掉 uid 映射与 chown；历史目录属主为 root，容器 root 天然可读写 | 容器内非 root uid（需改造后端所有写用户目录的代码） |
| 隔离边界 | **挂载清单即边界** | 用户明确不考虑挂错场景；清单由后端集中生成并校验，不在调用点散落 | 依赖权限位（容器 root + DAC_OVERRIDE 使权限位失效） |
| 通信协议 | 长度前缀 JSON over Unix domain socket | 工具是动态的（工具名 + JSON 参数），RPC 类型化收益小；协议跨 Linux/macOS | gRPC（需 protoc 且工具非静态类型）、WebSocket（需在容器内跑 HTTP server、占端口） |
| server / client | 宿主机 server、容器 client | 宿主机管理容器生命周期，天然先启动；重连策略简单 | 容器 server（需处理宿主机重试与 socket 权限） |
| 容器内 runtime | Node 常驻进程，挂载 `backend-ts/dist` | 持久 shell 会话依赖常驻进程；Mao 升级不用重建镜像 | 每次 `docker exec` 起新进程（`keep_session` 长任务会断） |
| 镜像内容 | Node + bash + git + coreutils，**外加与镜像 Node ABI 匹配的 `sharp` 与 `node-pty`** | 容器内复用现有工具实现：`read_file` 读图走 `sharp`（`read-file-tool.ts` 的 `readImage`），pty 走 `node-pty`；两者都是 native module，只读挂载宿主机 `dist` 带不上可用二进制 | 精简到无 native 模块（读图与终端直接不可用）、挂载宿主机 `node_modules`（ABI 与 Node 版本强耦合，宿主机升级即全线崩） |
| 依赖持久化 | 每用户挂载目录，pip/npm 安装位置指向它 | 容器可随时重建，用户装的依赖不丢；用户工具链版本自然漂移，可接受 | 只装容器内（重建即丢）、提交 Dockerfile 快照（实现复杂） |
| 容器内路径空间 | **与宿主机保持绝对路径一致**（不做路径翻译） | 挂载目标即宿主机绝对路径本身，`/opt/mao-data/users/{u}` → 容器内同一路径。宿主机与容器看到同一套路径，`PromptEngine` 的上传文件提示、上传接口返回的 `absolutePath`、shell 的 `current_workdir`、宿主机侧 `edit_image`/`generate_image` 与容器内文件工具天然互通，零翻译层 | 容器内规范化路径（`/workspace`、`/home/mao`）：需要一层路径翻译，且宿主机侧服务端拼接的路径在容器内不可达 |
| MCP stdio 处置 | docker 模式下随用户容器执行（`mcp__*` 工具入容器），宿主机侧 env 改白名单 | stdio MCP 是用户可控子进程，与 shell 同类；留在宿主机等于绕过容器边界，且 `{ ...process.env }` 会把 `MYSQL_URL` 等平台凭据交给用户进程 | 留在宿主机但收紧 env（仍可读任意路径，隔离目标不成立）、禁用 stdio MCP（功能回退过多） |
| REST 文件服务路径校验 | 宿主机执行 + `workspace-browse.service.ts` 换严格 `resolve` | 业务上前端只传工作区内相对路径，收紧后不影响正常使用；不收紧则接口本身即越界面，与容器化无关 | 维持 `resolveLenient`（已知越界，不可接受） |
| 模式开关 | 全局 `MAO_CLOUD_RUNTIME` + 用户级字段覆盖 | 部署级灰度 + 精细覆盖 | 纯全局（无法按用户灰度）、每会话可选（用户可能误选不安全模式） |
| LLM 调用位置 | 宿主机 | loop 留宿主机，无需转发；容器零凭据 | 容器内直连 DB（MySQL 认证是账号级，连上即可读全库） |
| 容器预热 | 复用 `SessionActivityHeartbeat` 活跃信号 | 用户打开桌面端即触发，实际发消息时容器已热 | 预热池（成本高、需维护池大小与回收） |

### 4.1 为什么 AgentLoop 不入容器

loop 的输入输出是数据库中的会话与消息，不是用户文件系统。它读写 `runtime/{userId}/{sessionId}` 的部分只有 compaction 归档与 runtime 中间产物，这些可以由宿主机控制面代为完成（宿主机本就以 root 运行且已持有该权限）。让 loop 入容器会把「跨用户数据访问」的控制面也拖进容器，反而需要额外设计 DB 访问通道，收益不成比例。

**这是本方案与最初「runtime 整体入容器」讨论的分歧点，已与用户确认采用当前切分。**

---

## 5. 实现设计

### 5.1 挂载清单（安全边界）

容器 `mao-user-{userId}` 创建时只挂以下路径，**清单由 `ContainerMountPlanner` 单点生成并校验，调用点不得自行拼接**。

**路径空间原则（决策 15）**：容器内绝对路径与宿主机**逐字节一致**，不做 `/workspace`、`/home/mao` 之类的容器内规范化改写。这样宿主机侧一切「服务端拼路径」的逻辑（`PromptEngine` 的上传文件提示、`file.routes.ts` 上传接口返回的 `absolutePath`、`edit_image` / `generate_image` 这类 `SERVER_ONLY_TOOLS`、shell 返回的 `current_workdir`）在容器内都天然可达，也省掉一整层路径翻译与其漏译风险。

| 宿主机路径 | 容器内路径 | 模式 | 用途 |
|---|---|---|---|
| `/opt/mao-data/users/{userId}` | 同左 | rw | 每用户虚拟 HOME |
| `{workspaceRoot}/{userId}` | 同左 | rw | 用户工作区（`workspace/{userId}/projects/{slug}`） |
| `/opt/mao-data/runtime/{userId}` | 同左 | rw | shellOutput / compaction / webPages / incoming / skills |
| `/opt/mao-data/deps/{userId}` | 同左 | rw | 持久依赖目录 |
| `/opt/mao-data/runtime/channels/{userId}` | 同左 | rw | 控制面 socket（**每用户独立子目录**，见 §5.4） |
| `{deployDir}/backend-ts/dist` | 同左 | **ro** | runtime agent 代码 |
| `/opt/mao/data/skills` | 同左 | **ro** | 外部共享技能（用户明确要求只读） |
| `/opt/mao-data/userskills/{userId}` | 同左 | rw | **用户个人技能目录**（`USER_SKILLS_DIR`，见下） |
| `/tmp` | 同左 | tmpfs | 容器内临时目录，随容器生命周期（见 §5.6） |

关于「用户个人技能目录」：宿主机 `SkillSyncService` 会把用户技能与系统技能以**符号链接**同步进 `runtime/{userId}/{sessionId}/skills/`（`skill-sync-service.ts:56`）。`runtime/{userId}` 已在清单内，链接目标 `${USER_SKILLS_DIR}/{userId}` 若不挂，容器内这些链接会全部悬空，技能内容读不到——这是原方案遗漏的一项。系统技能走 `runtime/.../skills` 的链接 + `/opt/mao/data/skills` 只读挂载，已覆盖。

关于「通道会话工作区」（飞书 / 钉钉入站会话，实施补充）：web 会话工作区在 `{workspaceRoot}/{userId}` 之内、被标准清单覆盖；而飞书 / 钉钉入站会话的工作区位于 `{workspaceRoot}/feishu-chat|dingtalk-chat/{account}/{leaf}`（leaf 为群 chatId / conversationId，或私聊 `private-{userId}`（飞书）/ `p2p-{userId}`（钉钉）），越出上表的每用户根，需作为**附加挂载**进入清单。规则：① 只挂 `{account}/{leaf}` 两级以上的具体会话目录——挂整个通道根或账号目录会把其他用户的私聊工作区一起带进容器，一律拒绝；② 归属校验两侧共同保证：创建容器时按数据库 `user_id` 查出该用户自己的通道工作区（归属校验即 SQL 过滤），planner 侧另对私聊叶子 `private-{userId}` / `p2p-{userId}` 做本人校验（纵深防御），`assertSafe` 的「rw 项必须含 `/{userId}/` 段」规则对这类条目按结构豁免；③ 用户自建会话（`POST /v1/sessions`）的 `workspace` 必须位于本人每用户根之下，通道工作区只由入站消息上下文在内部创建，不接受手工指定；④ 挂载清单在 `docker run` 时定型，运行中 / 停止后启动都无法新增：会话工作区不在集合内时只能重建容器（旧容器内既有 shell/pty/在途任务随重建丢失，这是把新通道会话工作区纳入容器的必要代价，仅在首次用到该工作区时发生一次），既非每用户根也非通道工作区的路径明确报错，绝不静默。群聊工作区由同群多个 mao 用户的会话按设计共享，挂进各自容器不构成跨用户泄漏。目录名在宿主机生成侧与 planner 之间经 `harness/container/channel-workspace.ts` 共用，防字面量漂移。

校验规则（`ContainerMountPlanner.assertSafe`）：

- 每条源路径 resolve 后必须位于已登记的数据根（`userHomeDir` / `runtimeDir` / `workspaceRoot` / `depsDir` / `userSkillsDir` / `channelsDir`）之下；
- 源路径必须包含 `/{userId}/` 或等于 `/{userId}` 形式的尾段，**拒绝任何上级目录**；
- 只读项（`dist`、`/opt/mao/data/skills`）不得被调用方覆写为 rw；
- 源路径不得是另一个已登记数据根的父目录（例如不得挂 `/opt/mao-data/users` 本身）；
- 符号链接源路径必须 `realpath` 后再校验，拒绝指向登记根之外的链接（防链接逃逸）；
- 生成后写入审计日志（userId + 完整挂载表），便于事后追责。

### 5.2 容器生命周期

`ContainerRegistry`（宿主机，单例）：

```
ensureRunning(userId):
  entry = containers.get(userId)
  if entry && entry.state === 'running' && socketConnected: return entry
  if entry && entry.state === 'stopped': dockerStart(entry)      // 数据在挂载卷，秒级恢复
  else: entry = createContainer(userId); dockerStart(entry)
  await waitSocketConnect(entry, timeoutMs = 15_000)
  return entry
```

- **按用户串行（实施补充）**：同一用户的全部生命周期操作（创建、重启、recycle、stop）经每用户锁串行执行。容器名固定为 `mao-user-{userId}`，两个并发调用各自执行「停-删-建」会互相摧毁对方刚建好的容器，并让在册条目的挂载集合与真实容器错位（重复重建、条目被删、容器被 `rm -f`）。recycle 走**原地更新条目**（对象身份不变、世代 +1）：并发调用方持有的句柄始终是在册条目；await 之后的副作用点（`docker stop` / `rm -f` / 摘除条目）按世代识别「条目已被重建」，避免按容器名误伤新容器。锁的重入（`waitSocketReady` / `requestShutdown` 回调内再次 `ensureRunning`）由 `AsyncLocalStorage` 识别并直接放行，不会自锁。
- **启动失败自愈（实施补充）**：`docker run` / `docker start` / 等待 socket 就绪失败时，一律摘除条目 + `rm -f` 半成品容器，下次 `ensureRunning` 走完整重建——不把失败固化成「自称 running 却连不上」或「卡死 stopped」的条目（该用户每次工具调用都同样失败，只有重启后端才恢复）。失败收尾按两道校验防止误伤并发建出的新容器：**世代校验**识别「同一条目对象被原地重建」（recycle 交错）；**在册条目身份校验**识别「首建期间重入方另建新条目并登记」（外层条目从未登记、世代没变，仅按容器名 `rm -f` 会摧毁在册健康容器）。

- **idle 回收**：`MAO_CONTAINER_IDLE_MINUTES`（默认 60）。无工具调用且无 socket 流量的用户容器 `docker stop`（不 `rm`，挂载数据保留）。**idle 判定必须叠加容器内运行时状态**，见 §5.3.1。
- **强制回收**：`MAO_CONTAINER_MAX_LIFETIME_HOURS`（默认 72）。到期 stop，下次 `ensureRunning` 时重建（依赖在 `/deps`，不丢）。
- **名称**：`mao-user-{userId}`，可预测便于运维排查。进程内并发由每用户串行锁消除（见上）；进程外同名残留（上次进程退出未清理）在 `docker run` 撞名时清掉后重试一次，绝不把冲突吞掉、按本次挂载清单登记一个与真实容器不符的条目。
- **资源限制**：`--memory`、`--cpus`、`--pids-limit` 取全局配置，防止单用户吃光宿主机。
- **网络**：`--network bridge`（默认 Docker 网桥），容器可出网访问公网，满足 `npm install` / `pip install` / `curl` 外部 API。容器**不暴露任何端口到宿主机**（`-P`/`--publish` 一律不用），进出容器只走 Unix socket，因此外部无法直连用户容器。
  - 出网限速：`--device-write-bps` 不适用于网络；如需限速走宿主机 `tc` 对 docker0 做整形（P2 可选，默认不限）。
  - 若将来要收紧出网，方案是自建 Docker network + iptables 白名单（如仅放行 80/443/53），不影响本方案的其余部分。
- **启动预检**：`MAO_CLOUD_RUNTIME=docker` 时，应用启动即校验 `docker version` 可用、`MAO_CONTAINER_IMAGE` 镜像存在、socket 根目录可写。任一不满足则**启动失败并给出明确提示**，不留到首次工具调用才报错，也不静默降级到 host 模式。

### 5.3.1 容器回收与内存态生命周期的关系

`ShellSessionManager` 的会话表与 `BackgroundTaskManager` 的任务表都在**容器内进程内存**。`docker stop` 后 `docker start` 只恢复挂载数据，不恢复内存态，因此容器被回收会造成用户可见故障：

- 模型手里的 `session_id` 全部失效，`keep_session` 长任务被杀；
- `shell` 以 `async:true` 提交的后台任务随容器停止丢失，宿主机 agent-loop 若在等 `await_async`，会拿到「后台任务不存在」。

对策：

1. **容器 idle 判定叠加容器内状态**：容器内 runtime agent 周期性上报「活跃 shell 会话数 / 未消费后台任务数」，宿主机 `ContainerRegistry` 的 idle 计时器仅在两者为 0 时才推进。PTY 终端同理（`RemoteTerminal` attach 中视为活跃，与宿主机 `isIdleTimeout` 口径一致）。
2. **阈值错开**：`MAO_CONTAINER_IDLE_MINUTES`（默认 60）必须大于容器内 `sessionIdleTimeoutMinutes`（同为 30 时容器先停、shell 全死），配置文档须写明该约束关系。
3. **回收前通知**：`docker stop` 前向容器内 runtime agent 发 `shutdown` 帧，让其有机会把「有未完成任务」的状态回给宿主机，宿主机据此决定是否推迟回收。

### 5.4 通信协议

**帧格式**：4 字节大端长度 + UTF-8 JSON body。

```jsonc
// 宿主机 → 容器（request）
{
  "id": "req-<uuid>",
  "type": "tool_call",
  "tool": "shell",
  "args": { "action": "exec", "command": "ls -la" },
  "envelope": {
    "userId": 7,
    "sessionId": 11,
    "workspace": "/opt/mao-data/workspace/7/projects/mao",
    "home": "/opt/mao-data/users/7",
    "runtimeDir": "/opt/mao-data/runtime/7/11",
    "gitTokens": { "github.com": "ghp_..." },
    "maoToken": "eyJ...",
    "ecpToken": "ecp-...",
    "larkUat": { "appId": "cli_xxx", "uat": "u-..." }
  }
}
```

```jsonc
// 容器 → 宿主机（response）
{
  "id": "req-<uuid>",
  "type": "tool_result",
  "ok": true,
  "result": "<工具原始返回的 JSON 字符串>",
  "durationMs": 128
}
```

**消息类型全集**（`type` 字段）：

| type | 方向 | 用途 |
|---|---|---|
| `tool_call` / `tool_result` | 双向 | 工具派发与结果 |
| `read_bytes` / `read_bytes_result` | 双向 | 外部发送工具的文件读取（见 §5.8），载荷为 base64 |
| `pty_open` / `pty_data` / `pty_close` | 双向 | 终端通道，**与 `tool_call` 共用同一条连接**（避免每终端一条连接难管理） |
| `ping` / `pong` | 双向 | 心跳 |
| `runtime_status` | 容器→宿主机 | 上报活跃 shell 会话数 / 未消费后台任务数 / attach 中的终端数，供 §5.3.1 的 idle 判定 |
| `shutdown` / `shutdown_ack` | 宿主机→容器 | 容器回收前的优雅停机（见 §5.3.1） |
| `error` | 容器→宿主机 | 协议级错误 |

要点：

- `result` 是不透明字符串，与现有工具返回值完全一致，宿主机侧 `normalizeToolResult` 零改动。
- `envelope` **只在请求内存活**，容器内 runtime agent 用完即从内存清除，不落盘、不写入子进程环境（除 `shell`/`pty` 子进程必需的变量）。
- 协议版本号进 `type` 之外的顶层 `v` 字段，便于将来演进。
- 心跳：宿主机每 30s 发 `ping`，容器回 `pong`；连续 3 次未响应判定容器异常，触发重建。
- 单用户单连接：同一 userId 的第二个连接接入时踢掉旧连接（容器重建场景）。

**连接身份校验（不可省略）**：socket 位于 `/opt/mao-data/runtime/channels/{userId}/`，挂载时**只挂该用户自己的子目录**（见 §5.1），容器内看不到其他用户的 socket 路径。宿主机 accept 到连接后仍须校验对端身份——用 `SO_PEERCRED` 取对端 PID，再反查该 PID 所属容器名是否为 `mao-user-{userId}`，不匹配立即断开。仅靠「目录不可见」不构成身份认证：容器内 root 一旦构造出 socket 路径（路径可预测），即可伪装成该用户接入。

### 5.5 容器内 runtime agent

入口 `backend-ts/src/harness/container/runtime-agent.ts`，容器启动时执行 `node {deployDir}/backend-ts/dist/harness/container/runtime-agent.js`。

职责：

1. 连宿主机 socket（重连 + 指数退避）；
2. 收 `tool_call`，按 `tool` 分发到容器内的执行器；
3. 执行器**复用现有工具实现**，只是把构造参数从宿主机全局改为 envelope 注入：
   - `ShellSessionTool` / `ShellSessionManager`：`spawn('bash')` 不变，凭据从 envelope 注入而非 `gitCredentialService` 查库；
   - `RemoteTerminal`（node-pty）：spawn 不变；
   - 文件工具：`PathSandbox` **必须使用严格 `resolve`**，允许根为 §5.5 列出的容器内根；
   - git：容器内 `git` 二进制，凭据走 `GIT_ASKPASS`（沿用现有 `ASKPASS` 机制）；
   - MCP stdio：容器内 `StdioClientTransport` spawn，env 由白名单 + envelope 组成（见 §5.10）。
4. 回 `tool_result`；
5. 周期性上报 `runtime_status`（见 §5.3.1）。

**容器内 `PathSandbox` 装配**：由于采用「绝对路径一致」（决策 15），容器内的 sandbox 与宿主机**构造参数完全相同**——`workspaceRoot` / `runtimeDir` / `userHomeDir` / `userSkillsDir` 都是同一批绝对路径，`addAllowedRoot` 动态登记的也是同一批路径，因此宿主机那套 `RuntimeDataResolver` + `PathSandbox` 装配逻辑可以原样复用，不需要容器路径版的 resolver 或映射表。这是选择路径一致而非容器内规范化路径的主要收益。

**允许根（容器内严格 `resolve` 的白名单）**：

| 容器内根 | 来源 |
|---|---|
| `{workspaceRoot}/{userId}` | 用户工作区 |
| `/opt/mao-data/users/{userId}` | 虚拟 HOME |
| `/opt/mao-data/runtime/{userId}` | 会话 runtime（shellOutput / webPages / incoming / skills / git-askpass.sh） |
| `/opt/mao-data/userskills/{userId}` | 用户个人技能 |
| `/tmp` | 容器内临时目录（tmpfs，见 §5.6） |
| `{workspaceRoot}/{userId}/projects/{slug}` | 会话工作区（`getEffectiveWorkspaceRoot`） |

`/tmp` 必须进白名单：`read_file` 的工具描述明确承诺「绝对路径可读取工作区外文件（如 /tmp/xxx.jpg）」，Agent 把中间产物写 `/tmp` 是常规操作，§5.6 的外部发送工具场景也依赖它。容器自身即隔离边界，放开 `/tmp` 不削弱安全目标。

**关键约束**：容器内 agent 不得 import 任何触及 MySQL / JWT secret / LLM key 的模块。实施时用一条 ESLint 风格的单测或 import 断言来守住（见 §8）。

### 5.6 容器内 `/tmp` 与符号链接

`/tmp` 以 tmpfs 挂载（`--tmpfs /tmp:size=512m,mode=1777`），随容器生命周期：容器 stop 即清空，与 host 模式下「宿主机 /tmp 由系统清理」的语义差异可接受，且避免把临时文件写进持久挂载。

`PathSandbox.resolve` 当前用 `path.resolve` 做词法解析，**不解析符号链接**（`workspace-write.service.ts` 另行用 `realpathSync` 兜底）。容器内 root + `DAC_OVERRIDE` 使权限位失效，因此符号链接是主要的逃逸面：

- 严格 `resolve` 之外，容器内文件工具对**已存在的目标路径**补一次 `realpathSync` 校验，拒绝指向允许根之外的链接（与 `workspace-write.service.ts:275` 同口径）；
- 挂载清单侧由 `ContainerMountPlanner.assertSafe` 对源路径做 realpath 校验（见 §5.1），两侧共同兜底。

### 5.7 宿主机侧改动

#### 5.7.1 `ToolDispatcher` 新增派发分支

`dispatchFullOutcome` 中，在既有审批/规则逻辑之后、真正执行前，插入路由判定：

```
if (dockerRuntime.enabledFor(userId) && DOCKER_ONLY_TOOLS.has(toolName)):
   return { raw: await dockerToolRouter.dispatch(toolName, argsJson, ctx), llmVerdict: null }
```

- `DOCKER_ONLY_TOOLS = { 'shell', 'read_file', 'write_file', 'edit_file', 'glob_search', 'grep_search', 'mcp__*' }`
- 审批、危险评估、规则命中、审计拦截**全部仍在宿主机**，容器只负责执行已放行的动作。这样审批语义不变，且容器不需要理解权限模型。
- host 模式下该分支整体短路，行为与现状一致。
- **`terminal_*` 不是工具**：tool registry 中不存在该名字（已核对 `tool-registry.ts` 注册清单）。云端终端是 REST + WebSocket 独立链路（`harness/terminal/terminal-ws-handler.ts`），不经 `ToolDispatcher`，其容器化走 §5.7.3 的独立路径，不要与工具派发混在一起。

#### 5.7.2 凭据下发替代容器内查库

现状是同构的凭据注入逻辑散在**四处**，都要改成 envelope 来源：

| 位置 | 注入内容 |
|---|---|
| `harness/tool/impl/shell-session-tool.ts` `injectMaoToken` + `refreshUserEnvironment` | git token map、`MAO_TOKEN`、`ECP_TOKEN`、`LARKSUITE_CLI_*` |
| `harness/shell/shell-session-manager.ts` `createSession` / `refreshUserEnvironment` | 同上（首次 spawn env） |
| `harness/terminal/terminal-manager.ts` `buildEnv` | 同上（pty env） |
| `harness/tool/impl/shell-session-tool.ts:168` workdir | `resolveLenient` 需改严格 `resolve` |

docker 模式下：

- 宿主机侧新增 `SessionEnvelopeBuilder`，在派发前查库取值并组装 envelope，作为上述四处的统一数据源；
- 容器内四个位置改为从 envelope 读取，查库路径仅在 host 模式保留。

`sanitizeInheritedEnv` 逻辑保留：容器内 spawn bash 时同样不继承宿主机敏感键（容器里本来就没有，但代码路径要一致）。

**askpass 脚本路径冲突**：`resolveGitAskpassScript` 指向 `runtime/{u}/{s}/git-askpass.sh`，宿主机 git 服务（`git-write-operation.service.ts:358-363`）写的也是同一文件。docker 模式下容器内也写它会造成两套机制并发写同一路径。对策：容器内 askpass 内容由 envelope 内联提供，写入容器私有路径（如 `/tmp/askpass-{sessionId}.sh`），不复用宿主机共享路径。

#### 5.7.3 终端（node-pty）透传

`RemoteTerminal` 的 `nodePtyFactory` 在容器内改为：向宿主机申请一个 pty 通道（复用同一 socket，`type: 'pty_open'` / `pty_data` / `pty_close`），宿主机把数据流转发给桌面端 WebSocket。这样终端交互语义不变，只是 bash 跑在容器里。

改造入口是 `TerminalManager.create`（`harness/terminal/terminal-manager.ts`）的 `ptyFactory` 注入点，**不是** `ToolDispatcher`。

### 5.8 外部发送工具：容器读字节 + 宿主机发送

**问题**：`send_wechat_image` / `send_wechat_file`（`wechat-tools.ts:127`）、`feishu_send_file`（`feishu-tools.ts:280`）、`dingtalk_send_file`（`dingtalk-tools.ts:118`）共用一个 `loadBytes()`，用 `resolveLenient` 读本地文件后上传到对应平台。两个后果：

1. **与 §1.2 同源**：`resolveLenient` 是越界口子，须一并收紧。微信的真正实现在 `weixin/media-tool-support.ts:68`，同样要改。
2. **功能断裂**：docker 模式下 Agent 可能把文件写到容器内 `/tmp`，宿主机上该路径不存在，`loadBytes` 直接抛「文件不存在」。

**为什么不能整个工具搬进容器**：这三个工具是「读文件」+「调平台 API」两件事。读文件必须进容器（与工作区同视图）；调 API 必须留宿主机——微信 / 飞书 / 钉钉的 appSecret 是**组织级共享凭据**，一旦进容器，用户在自己 shell 里 `env` 即可取得，并用它给任意用户发消息，受害的是其他用户而非泄漏者本人。这与用户自己的 git token（一人一份、泄漏只害自己）有本质区别。

**为什么不让容器直连数据库**（已否决）：MySQL 认证是账号级、无行级权限，容器连上即可 `SELECT * FROM user` / `SELECT * FROM message`，等于把全库对所有用户开放，比原缺陷严重得多。

**采用的切分**：容器只负责读字节并回传，宿主机保留上传与发送。

```
宿主机 ToolDispatcher:
  send_wechat_file / feishu_send_file / dingtalk_send_file
    ├─ args 是 http(s) URL → 宿主机直接 fetchBytesWithLimits（与容器无关，留宿主机）
    └─ args 是本地路径 → read_bytes 请求容器（带 envelope 的 workspace/HOME/runtime）
         ← 容器返回 base64 字节（沿用现有 20MB / 30MB 上限）
         → 宿主机 decode 成 Buffer，走原有 uploadService / sendService 零改动
```

### 5.9 REST 文件服务留宿主机，但必须先收紧路径解析

**结论不变**：`/v1/files/workspace-*` 与 `/v1/files/project-*` 继续留在宿主机执行。它们是「可信服务端代码」——业务上前端只传工作区内相对路径（`desktop/src/composables/workspace-file-provider.ts` 的 `createCloudProvider` / `createProjectProvider` 均只传 `dir` / `path` 相对字段），`project-*` 的根目录由 `CloudWorkspaceResolver` 从 slug 钳制在 `workspace/{userId}/projects/{slug}`。

**但「留在宿主机」不等于「已经安全」**。当前 `workspace-browse.service.ts:413` 的 `resolvePath` 用 `resolveLenient`，而 `file/file.routes.ts:145` 把用户传入的 `path` 原样交给它——**用户输入完整参与路径解析**。`file.service.spec.ts:187` 甚至把这个行为固化成了断言（`browsesAndReadsPathsOutsideTheWorkspace`）。

因此在容器化之前（host 模式同样受益）必须先做：

1. `workspace-browse.service.ts` 的 `resolvePath` 从 `resolveLenient` 改为严格 `resolve` + `realpathSync`，与 `workspace-write.service.ts:275` 同口径；
2. 反转 `file.service.spec.ts:187` 的断言，改为「相对穿越与绝对路径均被拒绝」；
3. docker 模式下这些端点仍走宿主机：挂载清单已保证容器内路径与宿主机一致，宿主机 root 进程访问该用户目录本就是设计内的能力，接口层的归属校验（`requireOwnedSession`）+ 收紧后的路径解析即构成完整边界。

### 5.10 MCP stdio：随用户容器执行

`McpClientManager` 支持 `serverType=stdio` 的 MCP server，CLOUD 模式下由宿主机 `StdioClientTransport` spawn。这是与 shell 同类的「用户可控子进程」执行面，且 `buildTransport` 用 `env: { ...process.env, ...env }`，把宿主机环境变量（含 `MYSQL_URL`、`APP_*` 密钥）直接交给用户进程。

处置：

1. **docker 模式下 `mcp__*` 工具入容器**：连接与 `callTool` 都经 `DockerToolRouter` 派发到容器内 runtime agent，容器内 `StdioClientTransport` spawn。`mcp__*` 加入 §5.7.1 的 `DOCKER_ONLY_TOOLS`。
2. **宿主机侧 env 改白名单**（host 模式也要做）：`buildTransport` 不再继承 `process.env`，只注入 `PATH`、`HOME`、`LANG`、`TERM` 等必要键 + 该 server 自己配置的 `envJson` + envelope 内的用户凭据。`MYSQL_URL` / `APP_*` / `GIT_TOKEN_*` 一律不出现。
3. `McpClientManager` 的客户端注册表随之按 userId 维度挂在容器内，宿主机不再持有 stdio 子进程。
4. HTTP 型 MCP server（StreamableHTTP / SSE）不涉及子进程，继续留宿主机。

### 5.11 存量数据兼容

`/opt/mao-data` 下现有目录属主已是 root，容器内 root 直接可读写，**无需 chown、无需迁移**。需要确认的只有：

- `runtime/{userId}` 下历史 shellOutput 等文件权限是否为 `0644`/`0755`（root 可读写）；
- 若存在个别非 root 属主文件（早期以其他用户跑过），补一个一次性脚本扫描并报告，不改动。

### 5.12 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `MAO_CLOUD_RUNTIME` | `host` | `docker` 启用容器模式 |
| `MAO_CONTAINER_IDLE_MINUTES` | `60` | idle 回收阈值；**必须大于容器内 `sessionIdleTimeoutMinutes`**（见 §5.3.1） |
| `MAO_CONTAINER_MAX_LIFETIME_HOURS` | `72` | 强制回收阈值 |
| `MAO_CONTAINER_MEMORY_MB` | `2048` | 单容器内存上限 |
| `MAO_CONTAINER_CPUS` | `2` | 单容器 CPU 上限 |
| `MAO_CONTAINER_PIDS_LIMIT` | `512` | 单容器进程数上限 |
| `MAO_CONTAINER_IMAGE` | `mao-runtime:latest` | 运行时镜像 |
| `MAO_CONTAINER_NETWORK` | `bridge` | Docker 网络模式；容器可出网、不对外暴露端口 |
| `MAO_CONTAINER_CHANNEL_DIR` | `/opt/mao-data/runtime/channels` | Unix socket 根目录；每用户子目录 `{userId}/` |
| `MAO_CONTAINER_DIST_DIR` | `/opt/mao/backend-ts/dist` | 只读挂载的 dist |
| `MAO_CONTAINER_DEPS_DIR` | `/opt/mao-data/deps` | 持久依赖目录（§5.13） |
| `MAO_CONTAINER_TMPFS_SIZE_MB` | `512` | 容器内 `/tmp` tmpfs 大小 |
| `MAO_CONTAINER_START_TIMEOUT_MS` | `15000` | 等待容器就绪上限 |
| `MAO_USER_RUNTIME_MODE`（DB） | 空 = 跟随全局 | 用户级覆盖：`docker` / `host` |

用户级字段落在 `user` 表，新增迁移 `V0xx__add_user_runtime_mode.sql`，admin 用户管理页加一个下拉（`user:write` 权限）。

### 5.13 依赖持久化落地方式

`/opt/mao-data/deps/{userId}` 挂到容器内同一路径（决策 7）。只挂目录不够，还要让包管理器默认装进去，否则 `npm install -g` 装的 CLI 在容器重建后仍不可见：

| 变量 | 值 | 作用 |
|---|---|---|
| `NPM_CONFIG_PREFIX` | `/opt/mao-data/deps/{userId}/npm` | npm 全局安装根 |
| `PIP_TARGET` | `/opt/mao-data/deps/{userId}/py` | pip 安装目标 |
| `PIP_BREAK_SYSTEM_PACKAGES` | `1` | 新 Debian/Ubuntu 基础镜像的 PEP 668 豁免 |
| `PATH` | 前缀 `/opt/mao-data/deps/{userId}/npm/bin` | 让全局 CLI 可直接执行 |

这些变量由 `SessionEnvelopeBuilder` 随每次派发注入 shell/pty 会话（与 git token 同一机制），不写进镜像，保证宿主机与容器内口径一致。§7 需覆盖「容器重建后 `npm ls -g` / `pip list` 仍可见此前装的包」。

---

## 6. 落地清单

### 后端 backend-ts

**容器基础设施（`src/harness/container/`）**

| 文件 | 改动 |
|---|---|
| `container-mount-planner.ts` | **新建**：挂载清单生成 + `assertSafe` 校验（含 realpath / 父目录 / 只读项规则）+ 审计日志 |
| `container-registry.ts` | **新建**：容器 create/start/stop/reuse、idle 与 lifetime 回收、资源限制、启动预检、`runtime_status` 驱动的 idle 判定 |
| `docker-tool-router.ts` | **新建**：docker 模式派发入口（ensureRunning → envelope → channel.request） |
| `session-envelope-builder.ts` | **新建**：查库取 git token / MAO_TOKEN / ECP_TOKEN / larkUat，组装 envelope；同时产出 §5.13 的依赖目录 env |
| `runtime-channel-server.ts` | **新建**：每用户 Unix socket server、帧编解码、心跳、ping/pong、`SO_PEERCRED` 对端身份校验 |
| `runtime-channel-protocol.ts` | **新建**：帧格式与消息类型定义（跨宿主机/容器共享） |
| `runtime-agent.ts` | **新建**：容器内入口，client 重连 + 工具分发 + `runtime_status` 上报 |
| `container-tool-executor.ts` | **新建**：容器内执行器（复用现有工具，参数改为 envelope 注入） |
| `pty-bridge.ts` | **新建**：容器内 node-pty 与宿主机 WebSocket 的双向桥 |
| `read-bytes-bridge.ts` | **新建**：宿主机侧 `read_bytes` 请求与 base64 解码（§5.8） |
| `container-mcp-bridge.ts` | **新建**：容器内 MCP stdio 连接与 callTool 代理（§5.10） |

**派发与执行面改造**

| 文件 | 改动 |
|---|---|
| `src/harness/tool/tool-dispatcher.ts` | `dispatchFullOutcome` 插入 docker 路由分支（host 模式短路）；`DOCKER_ONLY_TOOLS` 增加 `mcp__*` |
| `src/harness/tool/impl/shell-session-tool.ts` | 凭据来源支持 envelope 注入（host 模式保留查库路径）；`workdir` 的 `resolveLenient` 改严格 `resolve` |
| `src/harness/shell/shell-session-manager.ts` | `createSession` / `refreshUserEnvironment` 凭据来源改 envelope；askpass 脚本写容器私有路径（§5.7.2） |
| `src/harness/terminal/terminal-manager.ts` / `remote-terminal.ts` | docker 模式下 `ptyFactory` 走 pty-bridge（改造入口是 `TerminalManager.create`，不经 ToolDispatcher） |
| `src/harness/mcp/mcp-client-manager.ts` | `buildTransport` 的 `{ ...process.env }` 改白名单 env；docker 模式下 stdio 客户端改由容器内 bridge 持有 |
| `src/harness/tool/impl/wechat-tools.ts` / `feishu-tools.ts` / `dingtalk-tools.ts` | `loadBytes` 改严格解析；本地路径分支改走 `read_bytes`（URL 分支留宿主机） |
| `src/weixin/media-tool-support.ts` | `readLocalFile` 的 `resolveLenient` 改严格解析（§5.8，微信 `loadBytes` 的真正实现） |
| `src/file/workspace-browse.service.ts` | `resolvePath` 从 `resolveLenient` 改严格 `resolve` + `realpathSync`（§5.9） |
| `src/file/file.service.spec.ts` | 反转 `browsesAndReadsPathsOutsideTheWorkspace` 断言为「越界被拒绝」 |

**装配与配置**

| 文件 | 改动 |
|---|---|
| `src/config/app-config.ts` | 新增 §5.12 全部配置项 |
| `src/user/user.repository.ts` / `user.service.ts` | `runtimeMode` 字段读写与覆盖判定 |
| `src/create-app.ts` | 装配 `ContainerRegistry` / `RuntimeChannelServer` / `DockerToolRouter`；心跳触发预热；docker 模式启动预检 |
| `src/session/session-activity-heartbeat.ts` | 活跃时触发 `ensureRunning`（仅 docker 模式） |
| `db/migration/V0xx__add_user_runtime_mode.sql` | **新建**：`user.runtime_mode VARCHAR(16) NULL` |

### admin

| 文件 | 改动 |
|---|---|
| `admin/src/views/`（用户管理页） | 新增「运行时模式」下拉（docker / host / 跟随全局），`user:write` 权限 |

### 部署

| 文件 | 改动 |
|---|---|
| `Dockerfile.runtime`（仓库根或 `backend-ts/`） | **新建**：Node + bash + git + coreutils，**外加与镜像 Node ABI 匹配的 `sharp` 与 `node-pty`**（见 §4 镜像内容） |
| `scripts/build-runtime-image.sh` | **新建**：构建 `mao-runtime` 镜像 |
| `scripts/container-gc.sh` | **新建**：兜底回收异常容器（宿主机 cron 或 systemd timer） |
| `backend-ts/config/application.yml` | 补 §5.12 容器配置项（kebab-case，`${ENV:default}` 形式） |
| `skills/mao-cli/reference/deploy.md` | 补容器模式部署前置条件（Docker 安装、`build-runtime-image.sh` 构建镜像、bridge 出网与端口不暴露、idle 与 shell idle 阈值关系、sharp/node-pty ABI 说明） |

### 不改

- `desktop`：无改动。宿主机与容器路径一致（决策 15），前端拿到的绝对路径在两种模式下都有效。
- `android`、`agent-cli`、`shared/contracts`：无改动。
- MySQL 连接、LLM key、JWT secret：**任何情况下都不进容器**。

---

## 7. 测试要点

**挂载清单**

- 每用户容器挂载表只含该 userId 路径；断言不含任何其他用户尾段。
- `assertSafe` 拒绝：上级目录、符号链接逃逸、只读项被覆写为 rw、未登记的数据根、**挂载另一个已登记数据根的父目录**（如把 `/opt/mao-data` 整体挂进去）、`/opt/mao` 与 `/opt/mao-data` 互为父子导致同一容器内出现第二份 backend-ts。
- 符号链接源路径 `realpath` 后再参与校验（技能目录以 symlink 同步，`realpath` 前是 runtime 路径、之后是用户技能根，两者都必须在白名单内才放行）。
- 审计日志包含 userId 与完整挂载表（每行含容器内路径、宿主机源路径、rw/ro）。

**生命周期**

- `ensureRunning`：不存在 → 创建并等待就绪；stopped → start 且数据仍在；running → 直接复用。
- idle 超时 → stop（不 rm）；lifetime 超时 → stop，下次重建。
- 容器启动超时 → 返回明确错误，不挂起 AgentLoop。
- 并发 `ensureRunning` 同一 userId 不产生双容器。
- **容器回收与内存态**（§5.3.1）：有活跃 shell 会话或未消费后台任务时 idle 不推进；`docker stop/start` 后旧 `session_id` / `task_id` 再次使用返回明确错误（「会话/任务已随容器回收失效」），不静默失败、不伪造成功。

**连接身份**

- socket 按用户隔离在 `{channelDir}/{userId}/`，用户 A 的容器连不到用户 B 的 socket 路径。
- 伪造对端（跨 userId 的容器进程直连他人 socket）被 `SO_PEERCRED` 取 PID → 反查容器名 → 与路径 userId 不一致时拒绝连接。
- 同 userId 第二个连接踢掉旧连接。

**协议**

- 帧编解码：长度前缀边界、超长帧拒绝、非 UTF-8 拒绝、JSON 非法拒绝。
- 心跳：连续 3 次无响应判定异常并重建。
- `envelope` 不在容器内落盘（断言容器内无 token 文件残留）。
- `runtime_status` 上报：宿主机据此推进/暂停 idle 计时器；容器重启后旧连接由新连接替换。

**安全回归（核心）**

- docker 模式下 `read_file` 传 `/opt/mao-data/users/{otherId}/x` → 拒绝。
- docker 模式下 `shell` 执行 `cat /opt/mao-data/users/` → 容器内不存在该路径，命令自然失败。
- docker 模式下 `grep_search` / `glob_search` 传绝对路径越界 → 拒绝。
- 容器内 `env` 不含 `MYSQL_URL` / `APP_*` / `GIT_TOKEN_*` / JWT secret / LLM API key（对 shell 会话逐个 env 断言，并覆盖 §5.13 的依赖目录 env 注入结果）。
- 容器内断言无法 import MySQL / JWT / LLM key 相关模块（静态 import 扫描）。
- 用户 A 容器内 `env` 不含用户 B 的任何 token。
- **MCP stdio**：宿主机侧 spawn 的 MCP server 进程 env 只含白名单键（`PATH`/`HOME`/`LANG` 等），断言不含 `MYSQL_URL` / `APP_*` / `GIT_TOKEN_*`。
- **REST 文件服务越界**（§5.9）：`GET /v1/files/workspace-read?path=/opt/mao-data/users/{otherId}/x` → 拒绝；host 模式同样覆盖（该修复不依赖容器化，两模式都必须生效）。
- host 模式下除 REST 收紧项外，其余用例**不适用**（现状行为），需有单独的 host 模式回归确保零变化。

**功能回归**

- shell 持久会话（`keep_session`）跨多次工具调用存活。
- `write_file` / `edit_file` 的文件锁在容器内仍生效（同容器同进程）。
- git clone（私有仓库）用下发的 token 成功。
- 终端 pty 交互正常（`ls`、`vim`、长命令）。
- `/deps` 持久化：容器重建后 `pip list` / `npm ls -g` 仍可见此前装的包（§5.13 四个 env 变量注入后生效）。
- **`read_file` 读图在容器内可用**（验证镜像内 `sharp` 与镜像 Node ABI 匹配，读 `/opt/mao-data/users/{id}/incoming/...jpg` 返回 `data_uri`）。
- **`/tmp` 可读写**：`read_file` 读 `/tmp/xxx.jpg`（schema 承诺的绝对路径能力）在容器内不回归。
- **技能符号链接不悬空**：用户技能 `runtime/{u}/{s}/skills/{name}` 在容器内 `readFileSync` 成功（§5.1 补挂 `userskills/{userId}` 后）。
- 上传文件提示里的宿主机 `incomingDir` 路径在容器内可写可读（§5.1 路径空间一致，决策 15）。

**外部发送工具切分（§5.8）**

- `send_wechat_file` 传容器内 `/tmp/x.txt` → 容器读到字节、宿主机发送成功。
- 传 http(s) URL → 宿主机直接 fetch，不经过容器（断言未发 `read_bytes`）。
- 传越界绝对路径（他人目录）→ 容器拒绝，工具返回错误。
- **多模态链路断言修正**：`send_wechat_image` 本身只返回 `{success:true}`，不进模型上下文；真正的链路是「容器内 `read_file` 读图 → 返回 `data_uri` → 宿主机 `ToolImageResultProcessor` 继续消费」，按此链路断言不断。
- 三个渠道（微信 / 飞书 / 钉钉）各自的 size 上限仍生效。
- 宿主机侧 `uploadService` / `sendService` 未被改动（既有单测全绿）。

---

## 8. 风险与开放问题

1. **`docker run` 冷启动延迟**（1~3s）：首次调用会卡。缓解：`SessionActivityHeartbeat` 活跃信号预热（§5.2）。仍存在的窗口是「用户首次打开客户端到心跳触发」之间，需实测。
2. **容器出网已确认开启**（决策 17，2026-10-14 确认维持不收紧）：`--network bridge`，容器可访问公网（`npm install` / `pip install` / `curl`），但不对外暴露端口，进出容器仅经 Unix socket。已知副作用：bridge 下容器可达宿主机 localhost 段（9080 / 3306）——3306 无外部凭据连不上，9080 接口本身走鉴权，均与容器化无关。若将来要限制目标地址，走自建 Docker network + iptables 白名单，不影响其余设计。
3. **线上后端裸跑在 ECS 上**（已确认）：无套娃问题，容器与后端是同一宿主机上的平级进程。生产机需预先安装 Docker。
4. **依赖目录版本漂移**：用户 A 装 python3.11、用户 B 装 python3.12，`/deps` 各自独立，互不影响，但运维排障时需按用户看。可接受。
5. **资源争抢**：单用户容器上限 2G/2CPU，N 个活跃用户时宿主机需 ≥ 2N+2 的内存余量。需按实际用户量调 `MAO_CONTAINER_MEMORY_MB`。
6. **审批语义与容器执行的时序**：审批在宿主机完成、执行在容器，中间存在「审批通过后容器已崩溃」的窗口。缓解：`ensureRunning` 失败即返回错误，不静默降级到宿主机执行。
7. **`terminal_*` 命名问题已澄清**：tool registry 中不存在任何 `terminal_*` 工具，云端终端是 REST + WebSocket 独立链路（`harness/terminal/terminal-ws-handler.ts`），不经 `ToolDispatcher`。因此 `DOCKER_ONLY_TOOLS` 不含也不应含 `terminal_*`，终端入容器的改造入口是 `TerminalManager.create` 的 `ptyFactory`（§5.7.3）。
8. **pty 通道的帧类型**（决策 20，已确认与 tool_call 共用一条连接）：pty 数据量大，共用连接时大数据帧可能阻塞同连接上的 tool_call，协议层必须做分帧 + 背压；**不采用每终端一条独立连接**（连接数随终端数增长，宿主机需按终端管理生命周期）。此为实施细节，不影响架构。
9. **native 模块与镜像 Node ABI 绑定**：镜像内的 `sharp`（`read_file` 读图）与 `node-pty`（终端）都是 native 模块，与镜像 Node 版本强绑定。宿主机 Node 升级后必须同步重建 `mao-runtime` 镜像，否则容器内读图/pty 静默失败。缓解：`scripts/build-runtime-image.sh` 固定 Node 版本，部署文档写明「升级宿主机 Node 先重建镜像」。
10. **容器回收导致的内存态丢失**：`docker stop/start` 不恢复容器内 shell 会话与后台任务表，需叠加 §5.3.1 的三条对策（容器内状态驱动的 idle、阈值错开、stop 前 `shutdown` 帧）。其中 `MAO_CONTAINER_IDLE_MINUTES`（默认 60）必须大于容器内 `sessionIdleTimeoutMinutes`（同为 30 时容器先停、shell 全死），配置文档须写明该约束。
11. **存量 shell 会话**：切换到 docker 模式时，宿主机上仍活着的旧 shell 会话如何处理——建议直接终止并提示用户，不做迁移。
12. **审计与追责**：挂载清单审计日志只记录「挂了什么」，不记录「用户在容器里做了什么」。后者由 shellOutput / 运行轨迹既有机制覆盖。

---

## 9. 实现步骤

顺序原则：**宿主机侧越界收口不依赖容器化，可最先独立完成并上线**；native 模块（sharp / node-pty）是步骤 5/6 的阻塞项，需提前在步骤 2 验证；两处 `npm` 命令按 AGENTS.md 拆开执行（`npm run build` 与 `npm test` 分开，禁止用根 `npx vue-tsc --noEmit` 之类的假通过替代）。

1. **宿主机侧越界收口（可先行上线，独立于容器化）**：`workspace-browse.service.ts` 的 `resolveLenient` 改严格 `resolve` + `realpathSync`（§5.9）；反转 `file.service.spec.ts` 的 `browsesAndReadsPathsOutsideTheWorkspace` 断言；`mcp-client-manager.ts` 的 `{ ...process.env }` 改白名单 env + 单测（§5.10）；微信 `media-tool-support.ts` / `wechat-tools.ts` / `feishu-tools.ts` / `dingtalk-tools.ts` 的 `loadBytes` 严格化。此步骤完成后，host 模式的 REST 越界即被堵住，风险不依赖 docker 模式上线。
2. **协议与通道**：`runtime-channel-protocol.ts` + `runtime-channel-server.ts` + `runtime-agent.ts` 最小打通（一个 echo 工具即可）+ 单测。
3. **容器骨架与 native 模块验证（阻塞 5/6，先做）**：`Dockerfile.runtime`（含与镜像 Node ABI 匹配的 `sharp`、`node-pty`）、`scripts/build-runtime-image.sh`、`container-registry.ts`（create/start/stop/reuse + 启动预检）、`container-mount-planner.ts` + 挂载清单单测；在容器内实测 `require('sharp')` 与 `require('node-pty')` 可加载，再继续后续步骤。
4. **首个真实工具入容器**：`shell`（复用 `ShellSessionTool`，envelope 注入凭据 + §5.13 依赖目录 env）+ docker 路由分支接入 `ToolDispatcher`。
5. **文件工具入容器**：`read_file` / `write_file` / `edit_file` / `glob_search` / `grep_search`，`PathSandbox` 改为严格 `resolve` + 越界单测；验证读图（依赖步骤 3 的 sharp）。
6. **pty 入容器**：`pty-bridge.ts` + 终端链路改造（与 `tool_call` 共用连接；依赖步骤 3 的 node-pty）。
7. **git 入容器**：`GIT_ASKPASS` 凭据注入 + 私有仓库 clone 验证。
8. **依赖持久化**：`/deps` 挂载 + `SessionEnvelopeBuilder` 注入四个 env 变量（§5.13）。
9. **外部发送工具切分**：`read-bytes-bridge.ts` + 三个渠道工具的 `loadBytes` 改造 + 容器 `/tmp` 场景验证。
10. **MCP stdio 入容器**：`container-mcp-bridge.ts` + 宿主机 env 白名单下的客户端注册表改造（§5.10）。
11. **配置与灰度**：`app-config.ts` + `backend-ts/config/application.yml` 配置项 + `user.runtime_mode` 迁移 + admin 用户管理页下拉 + 心跳预热。
12. **安全回归套件**：§7 安全回归全量用例（含 host 模式的 REST 收紧项）。
13. **构建验证**：`cd backend-ts && npm run build`；通过后 `cd backend-ts && npm test`。
14. **文档**：CHANGELOG、README、DEPLOY.md、`skills/mao-cli/reference/deploy.md`、本方案状态改「已确认」。

---

## 10. 已确认决策摘要

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 隔离机制 | Docker 容器，每用户一个 |
| 2 | 容器内身份 | root，靠挂载清单隔离，不开 userns-remap |
| 3 | 容器粒度 | 每用户一个，跨会话复用 |
| 4 | AgentLoop 位置 | 留宿主机控制面，**不**入容器 |
| 5 | 通信协议 | 长度前缀 JSON over Unix domain socket（宿主机 server、容器 client） |
| 6 | 容器内 runtime | Node 常驻进程，只读挂载 `{deployDir}/backend-ts/dist`，镜像保持精简（普通发版不重建镜像；**宿主机 Node 升级必须同步重建镜像**，见 §8 第 9 条） |
| 7 | 依赖持久化 | 每用户 `/deps` 挂载目录；pip/npm 安装位置由 `SessionEnvelopeBuilder` 注入 `NPM_CONFIG_PREFIX` / `PIP_TARGET` / `PIP_BREAK_SYSTEM_PACKAGES` / `PATH` 四个 env 变量指向它，不写进镜像（§5.13） |
| 8 | 模式开关 | 全局 `MAO_CLOUD_RUNTIME`（默认 host）+ 用户级 `user.runtime_mode` 覆盖 |
| 9 | 共享技能目录 | 只读挂载；用户技能另挂 `userskills/{userId}` 保证 symlink 不悬空（§5.1） |
| 10 | 凭据 | 宿主机预取后随派发下发；**容器不持有平台级凭据**（无 MySQL 连接、JWT secret、LLM API key、平台级 IM appSecret），仅持有按次下发的用户级凭据，其生命周期与该用户的 shell/pty 会话一致。用户可在自己 shell 内看到自己的 git token（与 host 模式现状一致，泄漏只害自己），**不做宿主机中转** |
| 11 | REST 文件服务 | 留宿主机，但必须先把 `workspace-browse.service.ts` 的 `resolveLenient` 换成与 `workspace-write.service.ts` 同口径的严格解析 + `realpathSync`，否则留宿主机即留下越界口子（§5.9） |
| 12 | 外部发送工具 | 容器读字节（`read_bytes`）+ 宿主机上传发送；容器不持有平台凭据 |
| 13 | 容器直连数据库 | **否决**。MySQL 账号级认证无行级权限，连库即全库对所有用户开放 |
| 14 | 存量数据 | 目录属主已是 root，无需迁移 |
| 15 | 容器预热 | 复用 `SessionActivityHeartbeat` 活跃信号 |
| 16 | 容器内路径空间 | 与宿主机保持绝对路径一致，**不做路径翻译**；宿主机 `PathSandbox` 的 resolver / 挂载装配可原样复用，前端 `resolveWorkspaceFilePath` 的绝对路径直通也天然成立 |
| 17 | 容器出网 | `--network bridge`，可访问公网，不对外暴露端口。**已确认维持 bridge 不做收紧**：bridge 下容器可达宿主机 localhost 段（9080 / 3306）是已知副作用——3306 无外部凭据连不上，9080 全量接口本身走鉴权，均与容器化无关；iptables 规则清单难维护、域名白名单会让用户自装依赖默认不可用，两者均不采纳 |
| 18 | MCP stdio | 随用户容器执行：`mcp__*` 入 `DOCKER_ONLY_TOOLS`，宿主机 spawn 的 env 改白名单（不含 `MYSQL_URL` / `APP_*` / `GIT_TOKEN_*`）；HTTP 型 MCP 留宿主机（§5.10） |
| 19 | 后端运行形态 | 裸跑 ECS，与容器平级；生产机需预装 Docker |
| 20 | pty 通道 | **已确认与 `tool_call` 共用同一条 socket 连接**；代价是 pty 大数据帧可能阻塞同连接上的 tool_call，协议层需分帧 + 背压（不改为每终端一条连接） |
| 21 | 上线灰度 | `MAO_CLOUD_RUNTIME` 默认 `host`；宿主机侧越界收口（§5.9 / §5.10）作为独立步骤**先行上线**（不依赖容器化）；容器模式先用 `user.runtime_mode` 切内部账号观察，再逐步放大 |

以上 21 条均于 2026-10-14 逐条与用户确认。



