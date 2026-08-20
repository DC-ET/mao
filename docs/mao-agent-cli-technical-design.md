# mao-agent（终端 Agent CLI）功能设计与技术方案

> 版本: v0.3（可落地版） | 更新时间: 2026-08-20
> 状态: Phase 1/2（CLOUD）与 Phase 3（LOCAL）已落地
> 定位: 对齐 `cursor-agent` 的无 GUI 终端对话式 Agent 客户端，对接 mao 后端（`backend-ts`）
> 关联文档: [technical-design.md](./technical-design.md)、[android-app-technical-design.md](./android-app-technical-design.md)、[local-tool-ws-merge.md](./local-tool-ws-merge.md)、[shell-session-design.md](./shell-session-design.md)、[shell-unification-design.md](./shell-unification-design.md)、[skills/mao-cli](../skills/mao-cli/SKILL.md)

---

## 0. 一句话总结

在 `desktop`、`android`、`admin` 之外新增**第五端** `mao-agent`：一个零 GUI 的 Node.js 终端 CLI，通过 REST + WebSocket（`/api/ws/stream`）对接现有后端，提供「交互式对话 / 一次性打印 / 脚本化 CI 调用」三种运行形态。首版仅支持 **CLOUD 执行模式**，LOCAL 模式（CLI 本机执行工具）需后端配合，排在 Phase 3。

---

## 0.1 v0.1 → v0.2 关键修正（评审结论）

v0.1 草案的整体判断（复用协议、不改后端、CLOUD 优先、五端定位）是正确的，但有若干**基于假设而非源码**的描述，若照其实现会踩坑。本版逐条核对源码后做了如下修正，实现时请以本版为准：

| # | v0.1 的描述 | 源码事实 | 影响 |
|---|---|---|---|
| 1 | `client=cli` 后端未强校验，可直接用 | `normalizeClient` 把未知值**静默映射为 `browser`**（`streaming-ws-handler.ts:1127`、`streaming-ws-registry.ts:265`） | CLOUD 能跑通，但服务端日志/统计无法区分 CLI；LOCAL 100% 不可用 |
| 2 | CLOUD 模式有工具审批，需处理 `WAITING_APPROVAL` | **CLOUD 模式完全没有审批机制**：`shouldRequireApproval` 只在 `executionMode === 'LOCAL'` 分支调用（`tool-dispatcher.ts:101-126`） | `--yolo`/`--approve-rule`/规则引擎/工作区信任/退出码 4 在首版全部无用，须整体后移 |
| 3 | `permissionLevel` 是「后端侧放行策略」 | CLOUD 路径**传入但从不使用**该参数 | `--permission-level` 在首版实质是「只写库的元数据」，须在 `--help` 里说明 |
| 4 | 拒绝审批 = 发 `tool_approval { approved: false }` | 后端 `handleToolApproval` **不读 `approved` 字段**，只做 `unregister`（`streaming-ws-handler.ts:485-493`） | 照 v0.1 实现会「解锁 phase 但工具永不回结果」→ 会话永久挂住 |
| 5 | `subscribe` 决定收哪些事件 | `deliver()` 按 **userId 广播给该用户所有连接**，`subscribe` 只影响 `session_snapshot` 回放与 LOCAL 映射（`streaming-ws-registry.ts:220-228`） | **CLI 必须按 `sessionId` 本地过滤**，否则 desktop 上另一个会话结束会让 `-p` 提前退出 |
| 6 | `ask_user_questions` 是 Phase 4 | 该工具在 `executionMode` 判断**之前**分发，CLOUD 同样触发，且服务端阻塞等待 **15 分钟**（`ask-user-questions-registry.ts:4`） | 必须提到 Phase 1，否则 Agent 一提问就把执行线程占满 15 分钟 |
| 7 | 建会话默认 `permissionLevel: READ_WRITE`，环境信息传 `environmentInfo` | 服务端默认 **`READ_ONLY`**；环境信息是 `platform` / `shell` / `osVersion` **三个平铺字段**（`session.service.ts:92-96`） | 请求体写错会静默拿到与预期不同的会话 |
| 8 | 从 `@mao/contracts` 消费 `SessionVO` / `MessagePageVO` | contracts 里**没有这两个类型**，也没有任何 WS 事件类型；`SessionVO` 定义在 `backend-ts/src/session/session-vo.ts` | 需要在 CLI 内自建这部分类型 |
| 9 | 后端有 `PermissionInterceptor` / `@RequirePermission` 守卫 | TS 后端**没有**该拦截器；sessions / agents / models 只校验 JWT 有效性 + 会话属主（`create-app.ts:238-245`） | 普通用户 token 即可用，无需申请权限码 |
| 10 | 终端渲染用 `ink`（React for CLI） | 仓库无任何 React 依赖，两个现有 CLI 都是零依赖 CommonJS | 首版引入 React 运行时性价比过低，降级为行式输出（见 §9） |
| 11 | WS token 过期会在运行中被 `1003` 关闭 | 连接建立后**不再校验 JWT**；`1003` 只发生在握手阶段，`1001` 是空闲超时 | 长驻 REPL 不会因 token 过期被踢，只有重连时才需要新 token |

此外补齐了 v0.1 完全缺失、但实现时一定会撞到的机制：`eventId == executionId` 的约定（§7.3）、重连后 `tool_call_start` 会被重放（§7.5）、`session_already_running` 的处理（§6.4）、WS 入站 1MB 上限（§7.6）、服务端 90s 空闲超时（§7.2）。

---

## 1. 背景与目标

### 1.1 背景

- mao 现有三类交互客户端（`admin` / `desktop` / `android`）均依赖浏览器或 WebView 渲染，无法在**纯终端环境**（SSH、容器、CI/CD、tmux、无显示服务器）中使用。
- 已有 `skills/mao-cli` 明确**只覆盖非对话 REST 操作**（用户端元数据 + 管理端运维），其帮助文本直接声明「明确不支持：消息发送、消息队列写操作、WebSocket Agent 运行」。终端场景下驱动 Agent 真正对话执行任务，目前完全空白。
- 业界对标 `cursor-agent`：无 GUI 终端 Agent CLI，支持交互式会话、`--print` 一次性打印、`--output-format text|json|stream-json`、`--resume`/`ls` 会话管理等，广泛用于本地终端与 CI 流水线。

### 1.2 目标

1. 提供命令 `mao-agent`，在终端完成**创建/恢复会话 → 发送消息 → 观察流式输出 → 拿到最终结果**的闭环。
2. 支持三种运行形态：交互式 REPL（默认）、打印模式（`-p`）、结构化输出（`--output-format json|stream-json`）。
3. 复用现有后端协议与鉴权体系。**Phase 1 不需要任何后端改动即可上线**；`client=cli` 识别与 LOCAL 支持是后续阶段的独立小改动（§13）。
4. 复用 `~/.mao/auth.json`，与 `mao-cli` 共享登录态。
5. 面向人机双重使用者：人类交互使用；脚本 / CI / 上层 Agent 通过打印模式与 JSON 输出编排使用。

### 1.3 非目标（首版明确不做）

- 不做图形界面，不做全屏 TUI（`docs/terminal-design.md` 是 Electron GUI 终端，与本设计无关）。
- 不重新设计后端协议；只做「协议的第 N 个消费者」。
- 不做飞书扫码登录（终端无便捷二维码交互通道）。
- 不做 Side Task / 多会话并行 / MCP 上报 / 多模态图片输入（Phase 4）。
- **不做会话元数据管理子命令**（`sessions rm/archive/pin`、`agents`、`models`、`config`）——这些 `mao-cli` 已稳定提供，重复实现只增维护面。CLI 帮助文本中直接引导到 `mao`。
- 不做单文件二进制分发与 `mao-agent update` 自更新（无需求驱动，Phase 4 再评估）。

### 1.4 与现有客户端的关系

| 客户端 | 定位 | 是否对话 | 跑 Agent Loop | WS `client` 值 |
|---|---|---|---|---|
| `desktop`（Electron/Web） | 主力图形对话客户端 | 是 | 是（CLOUD/LOCAL） | `electron` / `browser` |
| `android` | 远程加载 desktop 前端的原生壳 | 是 | 是（仅 CLOUD） | `android` |
| `admin` | 运维管理后台 | 否 | 否 | 无 WS |
| `skills/mao-cli` | 用户端与管理端统一 REST 运维 CLI | 否 | 否 | 无 WS |
| **`mao-agent`（agent-cli/）** | **无 GUI 终端对话式客户端** | **是** | **是（CLOUD）** | `cli` |

`mao-agent` 与 `mao-cli` **互补而非替代**：前者补齐「驱动 Agent 对话执行」的 WebSocket 能力空白，后者继续做非对话元数据与管理运维，两者共用 `~/.mao/auth.json`。

---

## 2. 现状约束核查表（实现前必读）

本节是本文档最重要的部分：所有数值与行为均已核对源码，实现时按此编码，不要凭直觉。

### 2.1 连接与协议约束

| 约束 | 值 | 出处 |
|---|---|---|
| REST 前缀 | `/api/v1/...`（全局 prefix `/api` + 路由 `/v1/...`） | `create-app.ts:209`、`create-app.ts:735` |
| WS 路径 | `/api/ws/stream?token=<accessToken>&client=<type>` | `attach-websocket.ts:20` |
| 后端端口 | 9080（`MAO_TS_PORT`） | `config/application.yml:2` |
| WS 入站单帧上限 | **1 MB**（`maxPayload`），超限直接断连 | `attach-websocket.ts:15` |
| 服务端空闲超时 | **90 s** 无 message/pong 则 `close(1001, 'idle timeout')`，每 15 s 检查 | `attach-websocket.ts:18,29-33` |
| 握手鉴权失败 | `close(1003, 'Missing or invalid token')` | `streaming-ws-handler.ts:132` |
| 连接期间是否重校验 JWT | **不重校验**，长驻连接不会因 token 过期被踢 | `streaming-ws-handler.ts:153` |
| 服务端是否主动发 ping | **不发**（只回应用层 `pong`）；保活完全靠客户端 | `attach-websocket.ts`（无 `socket.ping()`） |
| 事件投递范围 | 按 **userId 广播到该用户所有 WS 连接**；`subscribe` 不参与过滤 | `streaming-ws-registry.ts:220-228` |
| `client` 归一化 | `electron` / `android` / 其余→`browser`（大小写不敏感） | `streaming-ws-handler.ts:1127`、`streaming-ws-registry.ts:265` |
| LOCAL 客户端判定 | `hasLocalClientConnection` 仅认 `clientType === 'electron'` | `streaming-ws-registry.ts:179-184` |
| LOCAL 事件投递 | `sendToLocalClients` 同样仅投给 `electron` | `streaming-ws-registry.ts:226-228` |

### 2.2 会话与执行约束

| 约束 | 值 | 出处 |
|---|---|---|
| `POST /v1/sessions` 默认 `executionMode` | `CLOUD` | `session.service.ts:92` |
| `POST /v1/sessions` 默认 `permissionLevel` | **`READ_ONLY`** | `session.service.ts:93` |
| 默认标题 | `'未命名会话'`，首条用户消息后由 `titleService` 自动改写 | `session.service.ts:90`、`streaming-ws-handler.ts:283` |
| 环境信息字段 | `platform` / `shell` / `osVersion` 三个平铺字段（`shell` 映射到 `shellPath`） | `session.routes.ts:52-67`、`session.service.ts:96` |
| 会话列表默认过滤 | `status='ACTIVE'` 且 `session_type NOT IN ('SUBAGENT','SIDE_TASK')` | `session.service.ts:273-288` |
| 会话列表排序 | `ORDER BY is_pinned DESC, updated_at DESC, id DESC`（**置顶会话会排在最近会话之前**） | `session.service.ts:209` |
| 会话 phase 枚举 | `IDLE` / `RUNNING` / `RESUMING` / `WAITING_APPROVAL` / `COMPLETED` / `FAILED` / `CANCELLED`，外加仅微信入口用的瞬时 `CANCELLING` | `admin-analytics.service.ts:171`、`weixin/agent-inbound-handler.ts:208` |
| 终态 phase | `COMPLETED` / `FAILED` / `CANCELLED` | `task-terminal.service.ts:10` |
| `RESUMING` 的对外呈现 | `session_snapshot` 与 `SessionVO.phase` 都会把它映射为 `RUNNING`（`visiblePhase`），CLI 实际收不到 `RESUMING` | `streaming-ws-handler.ts:212`、`session-vo.ts:124-126,144` |
| 会话活跃时发消息 | 返回 `session_already_running`，**消息不入库、不执行** | `streaming-ws-handler.ts:242-244,1041-1046` |
| 单条消息图片上限 | 10 张，且模型必须 `supportsVision=1` | `streaming-ws-handler.ts:253-263` |
| `data.modelId` 语义 | **持久修改会话模型**（写库），不是本轮覆盖 | `streaming-ws-handler.ts:246-252` |

### 2.3 工具与审批约束（决定首版范围的关键）

| 约束 | 值 | 出处 |
|---|---|---|
| CLOUD 是否有工具审批 | **完全没有**。CLOUD 分支直接 `callTool`，不经 `shouldRequireApproval` | `tool-dispatcher.ts:129-136` |
| CLOUD 下 `permissionLevel` 作用 | 传入但**不参与任何决策** | `tool-dispatcher.ts:80-137` |
| CLOUD 下是否出现 `WAITING_APPROVAL` | 不会（该 phase 仅由 `ApprovalRegistry` 在 LOCAL 路径设置） | `approval-registry.ts` |
| LOCAL 审批矩阵 | `READ_ONLY`：`shell`/`write_file`/`edit_file`/`mcp__*`；`READ_WRITE`：`shell`/`mcp__*`；`SMART`：`mcp__*` 恒需 + `shell` 经 LLM 评估；`FULL`：全放行 | `tool-dispatcher.ts:175-204` |
| `tool_approval` 是否读 `approved` | **不读**，只做 `unregister` 让 phase 回 `RUNNING` | `streaming-ws-handler.ts:485-493` |
| 拒绝工具的正确表达 | 发 `tool_approval`（解锁 phase）**并且**发 `tool_error`（把拒绝理由回给 Agent） | 同上 + `local-tool-session-registry.ts` |
| `ask_user_questions` 适用模式 | **CLOUD + LOCAL 均触发**（在 `executionMode` 判断之前分发） | `tool-dispatcher.ts:91-92,139-173` |
| `ask_user_questions` 服务端超时 | **900 000 ms（15 分钟）**，超时返回 `{"error":"User did not respond within timeout"}` | `ask-user-questions-registry.ts:4,38-46` |
| 无任何 WS 连接时提问 | 直接返回 `{"error":"No connected client to receive questions"}` | `tool-dispatcher.ts:146-148` |
| 服务端专属工具 | `task_*` / `spawn_subagent` / `web_search` / `open_web_page` / `generate_image` / `send_wechat_*` 恒在服务端执行 | `tool-dispatcher.ts:18-23` |

### 2.4 认证约束

| 约束 | 值 | 出处 |
|---|---|---|
| accessToken 有效期 | **24 小时**（`LoginVO.expiresIn = 86400`） | `auth.service.ts:83`、`config/application.yml:25-29` |
| refreshToken 有效期 | **7 天** | 同上 |
| shell 注入 token 有效期 | 2 小时（`JWT_SHELL_EXPIRATION`）——Agent 通过 `shell` 工具调用 CLI 时拿到的就是它 | `jwt.service.ts:24-34` |
| API Key / 服务账号 | **不存在**（`api_key` 表已由 V019 / V049 删除） | `db/migration/V019__drop_api_key.sql` |
| 权限拦截 | 无 `PermissionInterceptor`；sessions/agents/models 只需有效 JWT，会话写操作再校验属主 | `create-app.ts:238-245`、`session.routes.ts:83-88` |
| REST 响应包装 | 一律 `Result<T>`（`{ code, message, data, timestamp }`，`code=0` 成功） | `common/result.ts:6-15` |
| `GET /v1/models/active` 敏感字段 | 响应**含明文 `apiKey`** —— CLI 任何输出/日志都必须过滤 | `model.routes.ts:124` |

### 2.5 可复用资产

| 资产 | 状态 | 复用方式 |
|---|---|---|
| `desktop/src/composables/useStreamWS.ts`（984 行） | 约 300 行协议核心可移植，约 490 行 `routeEvent` 绑定 Pinia | **照抄状态机语义，不共享代码**（见 §12.4） |
| `desktop/electron/localShell.cjs`（514 行） | 已被抽成依赖注入的 CommonJS 工厂 `createLocalShellRuntime({ buildEnv, refreshToken, resolveOutput })` | Phase 3 可**直接 require 复用**，是 LOCAL 模式最大的成本削减项 |
| `skills/mao-user-cli/lib/`（约 2 300 行） | 零依赖 CommonJS：`args.js` / `http.js` / `auth-store.js` / `output.js` | 目录划分与错误文案风格照搬；`auth-store` 逻辑改写为 TS |
| `shared/contracts`（`@mao/contracts`） | **纯类型、无构建**（`types: src/index.ts`）；含 `Result` / `LoginVO` / `UserInfoVO` / `AgentVO` / `ModelVO`，**不含** `SessionVO` / WS 事件 | tsconfig paths 直接引源码；缺失类型在 CLI 内自建 |
| 仓库 CLI 构建先例 | **无**（两个现有 CLI 都是零构建 JS；TS 只在 backend-ts / admin / desktop） | 需新建独立 `package.json` + `tsconfig`（§12） |

---

## 3. 总体架构

### 3.1 五端拓扑

```
                    ┌──────────────────────────────────────┐
                    │        backend-ts (NestJS + Fastify)  │
                    │  REST /api/v1/*   WS /api/ws/stream   │
                    └──┬────────┬────────┬────────┬─────────┘
           ┌───────────┘        │        │        └───────────┐
   ┌───────▼──────┐   ┌─────────▼────┐  ┌▼──────────┐  ┌──────▼────────────┐
   │  desktop      │   │  android     │  │  admin    │  │  mao-agent (本设计)│
   │ Electron/Web  │   │ Capacitor    │  │ Vue 后台  │  │  终端 CLI          │
   │ CLOUD+LOCAL   │   │ 仅 CLOUD     │  │ 纯 REST   │  │  首版仅 CLOUD      │
   └───────────────┘   └──────────────┘  └───────────┘  └───────────────────┘
```

### 3.2 CLI 内部模块

```
┌──────────────────────────────────────────────────────────────────────┐
│                            mao-agent (CLI)                           │
│                                                                      │
│  bin/mao-agent.js → main.ts → ArgParser → Command Router             │
│                                    │                                 │
│                    ┌───────────────▼───────────────┐                 │
│                    │        SessionRunner          │  ← 核心编排器    │
│                    │  一轮对话的完整生命周期         │    UI 无关      │
│                    └───┬───────────────────────┬───┘                 │
│                        │                       │                     │
│              ┌─────────▼────────┐    ┌─────────▼─────────┐           │
│              │   RestClient      │    │    WsClient       │           │
│              │ auth/session/     │    │ 连接·心跳·重连·    │           │
│              │ agent/model       │    │ 订阅·可靠发送      │           │
│              └───────────────────┘    └─────────┬─────────┘           │
│                                                 │                     │
│                              ┌──────────────────▼──────────────────┐  │
│                              │          EventRouter                │  │
│                              │  sessionId 过滤 → executionId 过滤   │  │
│                              │  → 归一化为 CliEvent                 │  │
│                              └────┬────────────────────┬───────────┘  │
│                                   │                    │              │
│                    ┌──────────────▼──────┐  ┌──────────▼───────────┐  │
│                    │      Renderer        │  │  LocalExecutor       │  │
│                    │ repl / text / json / │  │  (Phase 3 才启用)     │  │
│                    │ stream-json          │  │  复用 localShell.cjs  │  │
│                    └──────────────────────┘  └──────────────────────┘  │
│                                                                      │
│   AuthStore(~/.mao/auth.json)   ConfigStore(~/.mao/agent-cli/)        │
│   Logger(--debug/--trace-file，Token 脱敏)                            │
└──────────────────────────────────────────────────────────────────────┘
```

**关键分层原则**：`SessionRunner` 只产出**归一化事件流**（`CliEvent`），`Renderer` 是纯消费者。这样 `text` / `json` / `stream-json` / REPL 四种输出共用同一套编排逻辑，也让 `SessionRunner` 可以在不启动终端的情况下被单测覆盖。

---

## 4. 命令行与交互设计

### 4.1 命令总览（首版收敛）

```
mao-agent [prompt]            无参数进入交互式 REPL；带 prompt 则发送首条消息后进入 REPL
mao-agent -p "prompt"         打印模式：发一条消息，等任务终态后退出（非交互）
mao-agent ls                  列出可恢复的会话
mao-agent resume [sessionId]  恢复会话；省略 id 则恢复最近更新的一个
mao-agent login               用户名密码登录，写入 ~/.mao/auth.json
mao-agent logout              清除本地登录态
mao-agent status              当前登录用户 / token 剩余有效期 / baseUrl / CLI 版本
mao-agent --help / --version
```

会话归档、删除、置顶、Agent/模型列表等元数据操作**不在本 CLI 范围**，`--help` 末尾固定提示：

```
会话与元数据管理请使用 mao CLI，例如：
  mao session list --json
  mao agent list
```

### 4.2 全局选项（首版）

| 选项 | 说明 |
|---|---|
| `-p, --print` | 非交互打印模式 |
| `--output-format <text\|json\|stream-json>` | 输出格式，默认 `text`；非 TTY 时也用它控制 `ls`/`status` 的输出 |
| `--resume [sessionId]` | 恢复会话，省略 id 恢复最近更新的一个 |
| `--continue` | 恢复本地记录的「上次使用会话」 |
| `--agent <id\|name>` | 指定 Agent；缺省用 `isDefault=true` |
| `--model <id\|name>` | 指定模型（注意：会**持久修改**会话模型） |
| `--workspace <path>` | CLOUD 服务端工作区路径 |
| `--cloud-project <key>` | 复用已存在的服务端项目目录（`GET /v1/sessions/cloud-projects`） |
| `--git-clone <url>` `--git-branch <b>` | 建会话时克隆代码到服务端工作区 |
| `--permission-level <READ_ONLY\|READ_WRITE\|SMART\|FULL>` | 写入会话记录。**CLOUD 下不产生审批**，仅影响该会话之后被 desktop 以 LOCAL 打开时的行为；帮助文本须原样注明 |
| `--thinking` | 展开思考内容（默认折叠/抑制） |
| `--if-running <wait\|cancel\|fail>` | resume 时会话仍在跑的策略，默认 `wait` |
| `--on-question <ask\|fail>` | 遇到 `ask_user_questions`：TTY 下默认 `ask`，非 TTY 下默认 `fail` |
| `--max-duration <sec>` | 单次任务墙钟上限，超时发 `cancel` 后退出码 124；默认无上限 |
| `--timeout-ms <n>` | 单次 **REST** 请求超时，默认 30000（与 `mao-cli` 一致） |
| `--base-url <url>` | API 根地址（到 `/api` 为止，不含 `/v1`） |
| `--token <jwt>` | 一次性覆盖本地 token |
| `--no-color` / `--color` | 强制禁用 / 强制启用颜色（`NO_COLOR` 等价于 `--no-color`） |
| `--debug` | 打印 WS 收发帧与 REST 摘要到 **stderr**（脱敏后） |
| `--trace-file <path>` | 完整事件流落盘为 NDJSON |

输出细调选项（可选，默认关闭）：

| 选项 | 说明 |
|---|---|
| `--include-tool-io` | `json` 输出里带上 `toolCalls[].arguments` / `result`（默认省略，因为可能很大且含敏感内容） |
| `--replay-full` | `resume` 时完整打印历史消息，默认只打印最后 3 轮的精简摘要 |
| `--stream-partial-output` | 配合 `--output-format stream-json` 逐 delta 输出（Phase 2） |

**后移到 Phase 3 的选项**（首版不实现，因为 CLOUD 无审批）：`-f/--force`、`--yolo`、`--approve-rule`、`--on-approval`、`--strict-danger-check`、`--i-know-what-im-doing`。首版若检测到这些参数，明确报错「当前版本仅支持 CLOUD 模式，CLOUD 模式不产生工具审批」，而不是静默忽略。

### 4.3 环境变量

| 变量 | 说明 |
|---|---|
| `MAO_AGENT_BASE_URL` | API 根地址，默认 `https://mao.etarch.cn/api` |
| `MAO_TOKEN` / `MAO_REFRESH_TOKEN` | 与 `mao-cli` 同名，云端工作区 / 微信 shell 场景由后端自动注入 |
| `MAO_AGENT_OUTPUT_FORMAT` | 默认输出格式 |
| `NO_COLOR` | 标准约定，禁用颜色 |

> **baseUrl 口径差异（易踩坑）**：`mao-cli` 的 `MAO_BASE_URL` 默认值**含 `/v1`**（`https://mao.etarch.cn/api/v1`），而 mao-agent 需要同时拼 REST(`/v1/...`) 和 WS(`/ws/stream`)，因此 `MAO_AGENT_BASE_URL` 定义为**到 `/api` 为止**。解析时做归一化：若用户传入的地址以 `/v1` 结尾则剥掉，避免复制粘贴 `mao-cli` 配置后拼出 `/api/v1/v1/...`。

### 4.4 交互式 REPL

**一个进程一个会话**（这是首版的显式简化）。切换会话请退出重开，避免多会话事件混流带来的状态机复杂度。

斜杠命令（CLI 本地拦截，不发给 Agent）：

| 命令 | 作用 |
|---|---|
| `/cancel` | 发送 WS `cancel`，中止当前执行 |
| `/model <id\|name>` | 切换当前会话模型 |
| `/todo` | 打印当前 Todo 快照 |
| `/context` | 打印最近一次 `context_window` 用量 |
| `/session` | 打印当前 sessionId、Agent、模型、workspace |
| `/help` | 帮助 |
| `/exit` `/quit` | 退出（`Ctrl+D` 等效） |

- 多行输入：以 `\` 结尾续行；检测到未闭合的 ``` 代码块时自动续行。
- `Ctrl+C`：有任务在跑时第一次发 `cancel` 并停留在 REPL；无任务在跑、或 2 秒内连按两次则退出进程。

### 4.5 打印模式与结构化输出

**`text`（默认）**：只输出**本轮最后一个 assistant 文本块**（定义：最后一次 `tool_call_start` 之后累积的 `content_delta`；整轮无工具调用时即全部文本），不含任何装饰字符，便于 `RESULT=$(mao-agent -p "...")` 捕获。

**`json`**：任务终态后一次性输出单个对象。

```json
{
  "type": "result",
  "sessionId": 123,
  "executionId": "8f2c...-uuid",
  "status": "COMPLETED",
  "result": "已完成……",
  "usage": { "promptTokens": 1200, "completionTokens": 340, "totalTokens": 1540 },
  "toolCalls": [
    { "toolCallId": "tc_1", "toolName": "shell", "status": "SUCCESS" }
  ],
  "fileChanges": [
    { "path": "src/a.ts", "type": "MODIFY", "linesAdded": 12, "linesDeleted": 3 }
  ],
  "durationMs": 8421
}
```

- `usage` 累加本轮所有 `message_end` 事件。
- `toolCalls[].arguments` / `result` 默认**不含**（可能很大且含敏感内容），`--include-tool-io` 时才带上。
- `status` 取自终态 `session_status.data.phase`。

**`stream-json`**：NDJSON，每行一个事件；默认按「assistant 文本块」聚合输出，`--stream-partial-output` 才逐 delta 输出。

```jsonl
{"type":"system","subtype":"session_started","sessionId":123,"executionId":"8f2c..."}
{"type":"assistant","message":{"content":[{"type":"text","text":"我先看一下项目结构"}]}}
{"type":"tool_call","status":"start","tool_call_id":"tc_1","tool_name":"shell","arguments":"{\"command\":\"ls\"}"}
{"type":"tool_call","status":"result","tool_call_id":"tc_1","tool_name":"shell","result":"{...}"}
{"type":"assistant","message":{"content":[{"type":"text","text":"已完成，共修改 2 个文件"}]}}
{"type":"result","status":"COMPLETED","usage":{"totalTokens":1540},"durationMs":8421}
```

约定：新增字段向后兼容（消费者忽略未知字段）；`thinking` 默认抑制（`--thinking` 打开）；`result` 事件始终是权威终态，下游只关心结果时可跳过所有 `assistant` 事件。

**stdout/stderr 纪律**：`json` / `stream-json` 模式下 stdout **只允许**出现 JSON；所有进度、警告、spinner 一律走 stderr。

### 4.6 非 TTY 自动降级

- `stdout` 非 TTY，或 `stdin` 被管道输入且未给 prompt 位置参数时，**自动进入打印模式**，默认 `--output-format text`。
- 管道输入的 stdin 全文作为 prompt（支持 `cat issue.md | mao-agent -p`）；同时给了位置参数时，stdin 内容追加在其后。
- 非 TTY 自动禁用颜色与 spinner，`--on-question` 默认切为 `fail`。

---

## 5. 认证与配置

### 5.1 登录方式

| 方式 | 场景 | 用法 |
|---|---|---|
| 用户名密码交互登录 | 本地终端首次使用 | `mao-agent login` |
| 环境变量注入 | CI / 云端工作区 / 微信 shell（后端已自动注入 `MAO_TOKEN`，2 小时短效） | 无需 login |
| 一次性 Token | 临时排障 | `--token <jwt>` |
| 长期免刷新凭据 | **不支持**：后端无 API Key 体系（§2.4） | — |

不支持飞书扫码登录；需要时提示用户在浏览器/desktop 登录后用 `--token` 传入。

### 5.2 Token 存储与刷新

- 复用 `~/.mao/auth.json`，结构与 `mao-cli` 完全一致：`{ accessToken, refreshToken, expiresIn, user, savedAt }`，文件 `0600`，目录 `0700`。
- 解析优先级：`--token` > `MAO_TOKEN` 环境变量 > `~/.mao/auth.json`（兼容旧名 `MAO_USER_TOKEN` / `MAO_ADMIN_TOKEN`）。
- **WS 的 token 特殊性**（已修正 v0.1 的误述）：
  1. accessToken 走 URL query，握手失败会得到 `close(1003)`。因此**建连前**若判断 accessToken 剩余有效期 < 5 分钟或已过期，先 `POST /v1/auth/refresh`。
  2. 连接建立后服务端**不再校验 JWT**，长驻 REPL 不会因 token 过期被踢。但**每次重连都是一次新握手**，重连前必须重新取 token（过期则先刷新）。若刷新失败，才提示用户重新 `login`。
  3. `refresh` 会同时返回新的 `refreshToken`，必须回写 `auth.json`，否则 7 天窗口无法滚动续期。
- `MAO_TOKEN` 由环境注入时不做刷新（该 token 由外部环境负责轮换），这也是 CI / 自动化推荐路径。

### 5.3 配置文件

`~/.mao/agent-cli/config.json`，优先级：命令行选项 > 环境变量 > 项目级配置 > 此文件 > 内置默认值。

```json
{
  "baseUrl": "https://mao.etarch.cn/api",
  "defaultAgentId": null,
  "defaultModelId": null,
  "permissionLevel": "READ_WRITE",
  "outputFormat": "text",
  "lastSessionId": 123
}
```

项目级覆盖 `.mao/agent.json`（从 cwd 向上查找，止于 git 仓库根或用户主目录），用于团队约定「本项目默认用哪个 Agent」。`approvalRules` / `trustedWorkspaces` 等字段在 Phase 3 引入 LOCAL 模式时再加，首版**不要预留半成品字段**。

---

## 6. 会话生命周期

### 6.1 创建会话

一个 CLI 会话严格对应后端 `session` 表一行。CLOUD 模式的最小请求体：

```json
{
  "agentId": 1,
  "executionMode": "CLOUD",
  "permissionLevel": "READ_WRITE"
}
```

- **不传 `title`**：让后端 `titleService` 依首条用户消息自动生成摘要标题；自造 `"mao-agent: 时间戳"` 会覆盖这个更好的默认行为。
- 不传 `workspace` 时后端自动初始化服务端工作区；要复用已有目录用 `cloudProjectKey`，要拉代码用 `workspaceMode: "git"` + `gitCloneUrl` / `gitBranch`。
- `platform` / `shell` / `osVersion` 三字段在 CLOUD 下可不传（服务端会探测工作区环境）；Phase 3 的 LOCAL 模式必须传（从 `process.platform` / `$SHELL` / `os.release()` 采集）。
- Agent 解析：`--agent` 传数字按 id；传字符串走 `GET /v1/agents?keyword=<name>` 精确匹配 `name`，多个命中则报错要求用 id；未指定则取 `isDefault=true`，没有默认 Agent 时报错而非静默用第一个。

### 6.2 恢复会话

| 操作 | 命令 | 调用 |
|---|---|---|
| 恢复指定 | `resume 123` / `--resume 123` | `GET /v1/sessions/123` → `GET /v1/sessions/123/messages` → WS `subscribe` |
| 恢复最近 | `resume` / `--resume` | `GET /v1/sessions?status=ACTIVE` 后**在 CLI 侧按 `updatedAt` 重排取第一条** |
| 恢复上次使用 | `--continue` | 读 `config.json.lastSessionId`，失效则回退到「恢复最近」 |
| 列表 | `ls` | `GET /v1/sessions?status=ACTIVE` |

> 「恢复最近」不能直接取列表第一条：服务端排序是 `is_pinned DESC, updated_at DESC`，置顶会话会顶到前面（§2.2）。

历史回放：`GET /v1/sessions/:id/messages?roundLimit=N` 返回 `{ messages, hasMore, nextBeforeMessageId, compactionEvents? }`（不是 `MessagePageVO`）。REPL 默认回放最后 3 轮的精简摘要（每条消息首行 + 工具名清单），`--replay-full` 才完整打印。打印模式不回放历史。

### 6.3 恢复时会话仍在运行

`subscribe` 后拿到的 `session_snapshot.data.phase` 若为 `RUNNING`（含被映射的 `RESUMING`）或 `WAITING_APPROVAL`，说明有执行在跑：

- REPL：直接续接流式渲染，不发新消息；`executionId` 取 snapshot 里的值，用于事件过滤。
- 打印模式：按 `--if-running` 处理 —— `wait`（默认，等它跑完再发自己的消息）/ `cancel`（先发 `cancel` 等终态再发）/ `fail`（退出码 1）。

### 6.4 `session_already_running` 的处理

即使做了 §6.3 的预检，仍可能因竞态（例如定时任务同时触发、或 desktop 同时在发）拿到 `session_already_running`。此时**消息没有入库、没有执行**，必须显式处理而不是当成普通 `error`：

- REPL：打印「该会话仍在执行，已放弃本次发送（可 `/cancel` 后重试）」，回到输入提示符。
- 打印模式：按 `--if-running` 重试一次（最多一次，避免打转），仍失败则退出码 1。
- **不要**用 `data.replaceExecution = true` 绕过：它只跳过 phase 检查，仍会被 `executionClaims` 拦下，行为不可预期。

### 6.5 单次任务 vs 长驻交互

- 打印模式：一次 `send_message` + 等本轮终态 + 退出，进程生命周期 == 任务生命周期。
- 交互模式：进程长驻，同一会话内连续多轮对话。
- 两种模式退出前都要 `unsubscribe` + 主动 `close()`（`close()` 后不得触发重连）。终态时可顺手 `PUT /v1/sessions/:id/read` 清掉 `unread`，避免 desktop 侧出现未读红点。

---

## 7. 通信协议对接

> 本节所有事件名、字段、路径均已核对源码。CLI 是纯消费者，不改协议语义。

### 7.1 REST 客户端

沿用 `mao-user-cli/lib/http.js` 的风格（原生 `fetch`、零第三方依赖），改写为 TypeScript：

```ts
interface RestClientOptions {
  baseUrl: string;                                    // 到 /api 为止
  getToken: () => string | null;
  onUnauthorized?: () => Promise<string | null>;      // 触发 refresh，返回新 token
  timeoutMs?: number;                                 // 默认 30000
}

class RestClient {
  login(username: string, password: string): Promise<LoginVO>;
  refresh(refreshToken: string): Promise<LoginVO>;
  me(): Promise<UserInfoVO>;
  listAgents(keyword?: string): Promise<AgentVO[]>;
  listActiveModels(): Promise<ModelVO[]>;
  createSession(req: CreateSessionRequest): Promise<SessionVO>;
  getSession(id: number): Promise<SessionVO>;
  listSessions(params?: { keyword?: string; status?: string }): Promise<SessionVO[]>;
  listMessages(id: number, params?: { roundLimit?: number; beforeMessageId?: number }): Promise<MessagePage>;
  markRead(id: number): Promise<void>;
  listCloudProjects(): Promise<CloudProject[]>;
}
```

实现要点：

1. **每层都要拆 `Result<T>`**：HTTP 200 但 `code !== 0` 是业务错误，错误文案对齐 `mao-user-cli`：`业务错误 code=N: message`。
2. **401 处理**：调用 `onUnauthorized` 刷新后自动重放一次原请求；再失败则区分场景提示（有 `MAO_TOKEN` 环境变量 → 提示检查注入；否则 → 提示 `mao-agent login`）。
3. `AbortController` 超时，错误分类区分超时 / DNS / 连接拒绝 / HTTP / 业务错误。
4. **`SessionVO` / `MessagePage` 等类型在 CLI 内自建**（`@mao/contracts` 没有），并加注释指向 `backend-ts/src/session/session-vo.ts` 作为对齐来源。
5. **`listActiveModels` 的响应含明文 `apiKey`**：解析后立即丢弃该字段，禁止进入日志、`--debug` 输出与 trace 文件。

### 7.2 WebSocket 客户端

```ts
class WsClient {
  connect(): Promise<void>;                    // 内部取 token（必要时先 refresh）
  subscribe(sessionId: number): void;
  unsubscribe(sessionId: number): void;
  send(payload: object): void;                 // fire-and-forget
  sendReliable(payload: object): Promise<boolean>;  // 断线时先重连再发
  close(): void;                               // 之后不再重连
  on(handler: (evt: WsEvent) => void): void;   // { type, sessionId, data }
}
```

**必须原样对齐 desktop 的行为**（数值取自 `useStreamWS.ts`，服务端约束取自 `attach-websocket.ts`）：

| 行为 | 参数 | 说明 |
|---|---|---|
| 应用层心跳 | 每 **5 s** 发 `{ type: 'ping' }` | 服务端不主动 ping，保活全靠客户端；服务端 **90 s** 空闲即 `close(1001)`，5 s 心跳有充足余量 |
| 静默自检 | **30 s** 未收到任何服务端消息则主动 `close()` 触发重连 | 比等 TCP 超时快得多 |
| 重连退避 | 1 s 起，每次 ×2，上限 **30 s**；`onopen` 后重置为 1 s | |
| 重连后恢复 | 对所有历史 `subscribe` 过的 sessionId 重新发 `subscribe` | |
| 主动关闭 | `close()` 置 `intentionalClose`，不再重连 | |
| 可靠上行 | `sendReliable`：OPEN 则直发；否则 `await connect()` 后再发；仍失败返回 false | |

**必须走 `sendReliable` 的上行**（服务端有 Promise 在等，丢失会让会话挂死）：`ask_user_questions_result`；Phase 3 追加 `tool_result` / `tool_error` / `tool_approval` / `skill_sync_done` / `mcp_tools_report`。

**1 MB 入站上限**：`send`/`sendReliable` 发送前检查序列化长度，超过 900 KB 时截断 payload 并在截断处写入明确标记（Phase 3 的 `tool_result` 是唯一现实风险点——大 shell 输出必须像 desktop 一样「预览截断 + 全文落盘」）。

### 7.3 `eventId == executionId`：本轮执行的身份

这是 v0.1 完全没写、但实现时绕不过的核心机制：

`send_message.data.eventId` 会被后端当作本轮 **`executionId`** 使用（`streaming-ws-handler.ts:286` 的 `resolvedEventId`，为空时后端自己生成）。因此**由 CLI 生成 uuid 并传入 `eventId`，就等于提前知道了本轮的 `executionId`**，可以在第一个事件到达之前就建立过滤基准。desktop 就是这么做的（`useChat.ts` 的 `setActiveExecution(sid, eventId)`）。

CLI 实现：

```ts
const executionId = randomUUID();
ws.send({ type: 'send_message', sessionId, data: { content, eventId: executionId, modelId } });
// 之后所有事件按 executionId 归属本轮
```

### 7.4 事件过滤算法（必须实现，否则 `-p` 会误退出）

后端按 **userId 广播**给该用户的所有 WS 连接（§2.1）。也就是说：用户在 desktop 上跑的另一个会话，其 `session_status: COMPLETED` 同样会送到 CLI。若不过滤，打印模式会在别人的会话结束时提前退出并给出错误结果。

```ts
function accept(evt: WsEvent, mySessionId: number, myExecutionId: string | null): boolean {
  // 1. 会话过滤：sessionId 为 null 的是连接级事件（connected/pong），放行
  if (evt.sessionId != null && evt.sessionId !== mySessionId) return false;
  // 2. 执行过滤：仅对携带 executionId 的流事件生效
  const eid = evt.data?.executionId;
  if (eid != null && myExecutionId != null && eid !== myExecutionId) return false;
  return true;
}
```

**终态判定**（打印模式据此退出）：

```
收到 session_status
  && data.phase ∈ { COMPLETED, FAILED, CANCELLED }
  && (data.executionId === myExecutionId
      || (data.executionId == null && 本轮已收到过 phase=RUNNING))
```

终态 `session_status` 一定带 `phase` + `unread: true`，并在 `executionId` 非空时带上它（`task-terminal.service.ts:51-54`），所以上式的第二个分支只是防御性兜底。

### 7.5 重连幂等（必须实现，否则重连后重复渲染）

`subscribe` 会立即回一个 `session_snapshot`，并且**当会话处于活跃态时重放所有进行中的 `tool_call_start` 与待答的 `ask_user_questions`**（`streaming-ws-handler.ts:195-222`）。它不重放消息历史、不重放 `content_delta`、不重放已完成的工具结果。

因此：

- 按 `tool_call_id` 去重工具卡片，重复的 `tool_call_start` 只更新不新增。
- 按 `requestId` 去重问答，重复的 `ask_user_questions` 不重复提问。
- 重连期间丢失的 `content_delta` **无法补回**——这是协议现状。REPL 只需在重连成功后打印一行「⚠ 连接中断已恢复，可能丢失部分输出」；打印模式在 `json` 结果里加 `"reconnected": true` 标记，便于下游判断结果完整性。

### 7.6 下行事件 → CLI 动作

| WS `type` | `data` 关键字段 | CLI 动作 | 首版 |
|---|---|---|---|
| `connected` | `userId` | 标记 WS 就绪 | ✅ |
| `pong` | — | 刷新静默计时 | ✅ |
| `session_snapshot` | `phase`, `executionId?` | 校准状态；`RESUMING` 已被后端映射为 `RUNNING` | ✅ |
| `session_status` | `phase`, `executionId?`, `unread?` | 驱动状态机；终态时 resolve 等待 Promise | ✅ |
| `session_already_running` | `code`, `message`, `executionId?` | 按 §6.4 处理，不当作普通 error | ✅ |
| `user_message_saved` | `messageId`, `tempEventId?` | 记录真实消息 id | ✅ |
| `content_delta` | `delta` | REPL 追加打印；stream-json 聚合为 `assistant` 事件 | ✅ |
| `thinking_start/delta/end` | `delta` | 默认折叠为 spinner；`--thinking` 展开 | ✅ |
| `tool_call_start` | `tool_call_id`, `tool_name`, `arguments` | 渲染工具卡片（按 id 幂等） | ✅ |
| `tool_call_args_delta` | `tool_call_id`, `arguments` | 增量刷新参数预览（超长省略） | ✅ |
| `tool_call_result` | `tool_call_id`, `result`, `status`, `preview?`, `summary?` | 渲染结果摘要（优先用 `summary`/`preview`） | ✅ |
| `file_change` | `path`, `type`, `lines_added`, `lines_deleted` | 打印 `+N -M path`，累积进 `result.fileChanges` | ✅ |
| `message_end` | `prompt_tokens`, `completion_tokens`, `total_tokens` | 累加 usage | ✅ |
| `context_window` | `estimated`, `actual` | 状态栏 token 用量 | ✅ |
| `compaction_start/end` | `savedTokens`, `durationMs` … | 打印压缩提示，避免误判卡死 | ✅ |
| `llm_waiting` | `phase`, `elapsedSeconds` | spinner + 等待秒数 | ✅ |
| `llm_retry` | `reason`, `attempt`, `maxRetries`, `delaySeconds` | 打印重试提示 | ✅ |
| `llm_stream_reset` | — | 丢弃当前未完成文本块 | ✅ |
| `ask_user_questions` | `requestId`, `questions[]` | 见 §8.2（**CLOUD 也会来**） | ✅ |
| `ask_user_questions_cancelled` | `requestId` | 撤销未答问题 | ✅ |
| `error` | `message`, `executionId?` | 打印错误，标记本轮失败 | ✅ |
| `todo_updated` | `todos[]` | 缓存供 `/todo` 打印 | ✅ |
| `activity` | `id`, `type`, `target`, `summary`, `status` | 状态栏当前活动 | 可选 |
| `session_list_update` / `session_title_updated` / `session_tree_status` | … | 首版忽略 | ❌ |
| `queue_updated` / `queue_message_consumed` | … | 首版忽略 | ❌ |
| `side_session_created` / `subagent_session_created` | … | 打印一行提示（不 attach） | ❌ |
| `tool_execute` / `skill_sync_required` / `mcp_sync_required` | … | **仅投给 `electron`，CLI 收不到** | Phase 3 |

### 7.7 上行事件

```ts
ws.send({ type: 'subscribe', sessionId });
ws.send({ type: 'unsubscribe', sessionId });
ws.send({ type: 'send_message', sessionId, data: { content, eventId, images: [], modelId } });
ws.send({ type: 'cancel', sessionId });
ws.send({ type: 'retry_execution', sessionId });
ws.sendReliable({ type: 'ask_user_questions_result', sessionId, data: { requestId, answers } });
ws.send({ type: 'ping' });
```

**注意字段层级不统一**（源码事实，不要凭直觉）：`send_message` / `ask_user_questions_result` 的业务字段在 `data` 里；`tool_result` / `tool_error` / `tool_approval` / `skill_sync_done` 的字段在**顶层**；`edit_and_resend` 也在顶层。Phase 3 实现 LOCAL 上行时按 §17.2 对照表逐个核对。

### 7.8 `client` 标识

CLI 应传 `client=cli`。但后端 `normalizeClient` 会把它**静默归一为 `browser`**（§2.1）。后果：

- **CLOUD 模式完全可用**：`ask_user_questions` 的分发只要求 `hasConnection(userId)`，不区分类型。
- 服务端日志与统计里 CLI 与浏览器不可区分（可观测性损失）。
- **LOCAL 模式完全不可用**：`hasLocalClientConnection` 与 `sendToLocalClients` 都硬编码只认 `electron`。

因此 Phase 1 不需要后端改动即可上线；建议顺带做 §13 的 3 行改动换取可观测性。

---

## 8. 执行模式

### 8.1 CLOUD 模式（首版）

- 会话 `executionMode: 'CLOUD'`。所有工具在**服务端工作区**执行，CLI 是瘦客户端：转发消息、渲染事件、代答问答。
- **CLOUD 没有任何工具审批**（§2.3）。这带来两个必须写进 `--help` 和 README 的结论：
  1. CLI 侧的 `--yolo` / 审批规则引擎 / 工作区信任在首版**无对象可管**，故不实现。
  2. `--permission-level` 只是写入会话记录的元数据，不改变 CLOUD 下的任何执行行为。
- 服务端已有 `PathSandbox` 约束工作区边界，本机风险面为零——这正是首版选 CLOUD 的核心理由。
- 局限：无法操作用户本机文件。想让 Agent 看本机代码，只能 `--git-clone` 到服务端工作区，或用 `--cloud-project` 复用服务端已有目录。

### 8.2 `ask_user_questions`：首版就必须处理

v0.1 把它排到 Phase 4 是排期错误。源码事实（§2.3）：该工具在 `executionMode` 判断**之前**分发，CLOUD 同样触发；服务端 `waitForAnswer` 会**阻塞整个 Agent 执行 15 分钟**；且 CLI 断开时后端直接返回 `No connected client to receive questions`。

处理策略：

| 场景 | 行为 |
|---|---|
| REPL（TTY） | 渲染问题与选项，读取用户输入（支持序号多选 + 自定义文本），`sendReliable({ type:'ask_user_questions_result', sessionId, data:{ requestId, answers } })` |
| 打印模式 `--on-question=fail`（默认） | **先发 `cancel` 释放服务端执行**，等 `CANCELLED` 或 2 s 超时，再以退出码 5 退出。绝不能直接 `process.exit`，否则服务端白等 15 分钟 |
| 打印模式 `--on-question=ask` | 非 TTY 下不允许；显式传入时报参数错误 |

`answers` 的形状对齐工具的 `getOutputSchema`：`[{ question, selectedLabels: string[], customInput?: string }]`。

### 8.3 LOCAL 模式（Phase 3）

LOCAL 下 CLI 要扮演目前 Electron 主进程的角色。**前置条件是后端改动**（§13 #1），在此之前 CLI 传 `executionMode: LOCAL` 会得到 `Local client is not connected. Please ensure the desktop app is running.`。

#### 8.3.1 触发链路

```
WS tool_execute { requestId, toolName, arguments, workspace, needApproval, dangerReason? }
  → 按 toolName 分发
  → needApproval 时先跑审批（工作区信任 → 默认拒绝清单 → 规则引擎 → TTY 交互）
  → 执行
  → sendReliable({ type:'tool_result'|'tool_error', sessionId, requestId, result|error })   ← 字段在顶层
```

#### 8.3.2 工具实现

| 工具 | 实现方式 |
|---|---|
| `shell` | **直接复用 `desktop/electron/localShell.cjs` 的 `createLocalShellRuntime`**（已是依赖注入的 CommonJS 工厂，注入 `buildEnv` / `refreshToken` / `resolveOutput` 即可），沿用其 `exec`/`write_stdin`/`close`/`list` 动作、5 分钟默认 yield、空闲 30 分钟与最长 2 小时回收、进程组 SIGKILL、输出落盘 |
| `read_file` | 本机读取，文本分页 + 图片 base64（对齐 `main.cjs` 的 `handleLocalReadFile`） |
| `write_file` / `edit_file` | 本机写入，返回 diff 统计供渲染 |
| `glob_search` / `grep_search` | ripgrep 子进程，缺失时降级到 Node 实现 |
| MCP 工具（`mcp__*`） | 代理到本机 MCP Server（stdio/SSE） |
| 未识别的 `toolName` | 统一返回 `{ error: "Unknown tool: <name>" }`，与 desktop 一致，禁止「未知工具默认执行」 |

**1 MB 上限是硬约束**：`tool_result` 必须像 desktop 一样做「预览截断 + 全文落盘到 `~/.mao/agent-cli/runtime/{sessionId}/shellOutput/`」，否则大输出会让 WS 直接断连。

#### 8.3.3 审批：拒绝的正确表达（v0.1 的严重错误）

后端 `handleToolApproval` **不读 `approved` 字段**，只做 `unregister` 让 phase 从 `WAITING_APPROVAL` 回到 `RUNNING`（§2.3）。所以：

```ts
// 批准
ws.sendReliable({ type: 'tool_approval', sessionId, requestId });   // 解锁 phase
const result = await runTool(...);
ws.sendReliable({ type: 'tool_result', sessionId, requestId, result });

// 拒绝 —— 两条都必须发
ws.sendReliable({ type: 'tool_approval', sessionId, requestId });   // 解锁 phase
ws.sendReliable({ type: 'tool_error', sessionId, requestId, error: '用户拒绝执行该工具' });
```

只发 `tool_approval` 会让会话回到 `RUNNING` 但 `LocalToolExecutor` 的 Promise 永不 resolve——会话永久挂住。只发 `tool_error` 会让会话卡在 `WAITING_APPROVAL`。

#### 8.3.4 审批门禁顺序

`工作区信任 → 内置默认拒绝清单 → approvalRules → --yolo/--force → TTY 交互兜底`

- **工作区信任**是最上层门禁（类比 VS Code「是否信任此工作区」）：LOCAL 模式首次在某本机目录执行 `shell`/写文件前一次性确认，写入 `config.json.trustedWorkspaces`。未信任目录一律拒绝，`--yolo` 与 `allow` 规则都不豁免。
- **默认拒绝清单**（`rm -rf /`、fork bomb、写 `~/.ssh`、`/etc` 等）优先级高于用户配置的宽泛 `allow`，只能被显式 `--i-know-what-im-doing` 豁免。
- `dangerReason` 非空时无条件在确认提示里高亮原因。
- **非 TTY 下默认 `--on-approval=fail`**（退出码 4），绝不静默放行。

#### 8.3.5 技能与 MCP 同步

- `skill_sync_required { syncUrl, removed, workspace }` → 带 Bearer token `GET` 下载 zip，解压到 `~/.mao/agent-cli/runtime/{sessionId}/skills/`，按 `removed` 清理，完成后 `sendReliable({ type:'skill_sync_done', sessionId, success })`。**同步失败或超时会让后端把会话直接判 `FAILED`**（`streaming-ws-handler.ts:336-341`），必须可靠回执。
- `mcp_sync_required { syncId, servers }` → 连接/刷新本机 MCP Server，`mcp_tools_report` 上报工具清单。
- `send_message` 时随 `data.localSkills` 上报未同步的本地技能（对齐 `desktop/src/utils/localSkills.ts`）。

### 8.4 阶段划分

| 维度 | CLOUD | LOCAL |
|---|---|---|
| 实现复杂度 | 低（转发 + 渲染） | 高（本机执行、审批、MCP 代理） |
| 能否操作本机 | 不能 | 能 |
| 安全风险 | 低（服务端 `PathSandbox`） | 高（等同给 Agent 本机 shell） |
| 是否需后端改动 | **否** | **是**（§13 #1） |
| 阶段 | **Phase 1** | **Phase 3** |

---

## 9. 终端渲染

### 9.1 视觉形态：首版行式滚动，不引入 ink

v0.1 提议用 `ink`（React for CLI）复刻 `cursor-agent` 的「底部常驻边框输入框 + 状态栏」。评审结论是**首版不做**，理由：

1. 仓库不存在任何 React 依赖，引入 ink 意味着 React + reconciler 一整套运行时，与两个现有 CLI 的零依赖风格冲突，也让「无 Node 环境下载即用」更难。
2. Phase 1 的价值全部在协议闭环（能不能可靠跑通一轮任务），不在视觉。局部重绘引擎是纯增量体验，可以后加而不影响架构——因为 `Renderer` 已经和 `SessionRunner` 解耦。
3. 局部重绘与「输出可被管道/`tmux`/`script` 捕获」需要谨慎处理边界，首版行式输出天然无此问题。

**首版渲染规格**：

- 对话历史纯行式打印，一旦输出即进入 scrollback，不重绘。
- 底部**单行**状态栏：仅在 TTY 且非打印模式下启用，用 `\r\x1b[K` 原地重写**一行**（不做多行区域管理），内容 `[Agent] [Model] [Context 18%] [已用 12s]`；每次要打印正式内容前先清掉该行，打印完再重画。
- spinner 同样只占一行，用于 `llm_waiting` / `thinking`。
- 输入提示符 `› `，不加边框。

Phase 2 可选升级为多行局部重绘（手写 ANSI 或届时再评估 ink），届时再引入「边框输入框」与 Todo 面板。

### 9.2 交互模式细节

- **Markdown 轻渲染**：标题 / 列表 / 粗体 / 代码块用 ANSI 简单还原，不引入重型 Markdown 渲染器；代码块不做语法高亮（Phase 2 再议）。
- **工具卡片**：

```
▸ shell  ls -la
  exit_code=0  0.12s
  total 24
  drwxr-xr-x  ...
```

  参数与结果都截断显示（各 20 行 / 2000 字符上限），完整内容在 `--trace-file` 里。
- **文件变更**：逐条 `+12 -3 src/a.ts`，任务结束汇总 `3 files changed: +42 -8`。
- **思考内容**：默认折叠为 `💭 思考中…`，`--thinking` 实时展开。
- **压缩提示**：`compaction_start/end` 打印一行，避免误判卡死。
- **重试提示**：`llm_retry` 打印 `⟳ LLM 重试 2/5（reason，3s 后）`，这是终端场景比 GUI 更需要的反馈——没有 GUI 的默认 loading 视觉。

### 9.3 打印模式渲染

- `text`：只输出最终文本，无装饰字符。
- `json` / `stream-json`：stdout 只有 JSON，人类可读信息全走 stderr。
- 打印模式默认禁用颜色（除非显式 `--color`）。

### 9.4 中断与取消

- REPL `Ctrl+C`：有任务在跑 → 发 `cancel`，停在 REPL；否则/2 秒内连按两次 → 退出（关 WS、清理子进程）。
- 打印模式 `Ctrl+C` / `SIGTERM`：立即发 `cancel`，等 `CANCELLED` 或 5 s 超时后退出，退出码 3。
- `--max-duration` 命中：发 `cancel`，等终态或 5 s 超时，退出码 124。

---

## 10. 安全设计（现实版）

### 10.1 首版（CLOUD）的真实风险面

CLOUD 模式下工具在服务端隔离工作区执行，**CLI 本机风险面近似为零**。首版安全工作因此聚焦在凭据与输出泄漏，而不是审批：

1. `~/.mao/auth.json` 权限 `0600`，目录 `0700`。
2. **脱敏**：`--debug`、`--trace-file` 与任何日志中，`Authorization` / `token` / `accessToken` / `refreshToken` / 模型 `apiKey` 一律替换为 `***`。特别注意 `GET /v1/models/active` 响应含明文 `apiKey`（§2.4）。
3. `--token` 传入的 JWT 不写入 `auth.json`，不进 shell 历史提示（帮助文本建议用环境变量而非命令行参数）。
4. trace / shell 输出落盘目录 `~/.mao/agent-cli/runtime/` 需有清理策略（保留最近 20 个会话或 7 天）。

### 10.2 `permissionLevel` 的真实语义

| `permissionLevel` | LOCAL 下的含义 | CLOUD 下的含义 |
|---|---|---|
| `READ_ONLY` | `shell`/`write_file`/`edit_file`/`mcp__*` 需审批 | **无影响** |
| `READ_WRITE` | `shell`/`mcp__*` 需审批 | **无影响** |
| `SMART` | `mcp__*` 恒需审批；`shell` 经 LLM 危险性评估 | **无影响** |
| `FULL` | 全部自动放行 | **无影响** |

CLI 必须在 `--help` 和 README 中原样说明这张表，否则用户会误以为 `--permission-level READ_ONLY` 能在 CLOUD 下限制 Agent 写文件——**它不能**。真正想只读排障，应该用一个工具集受限的 Agent（`agent.tools` 配置），而不是 `permissionLevel`。这一条是首版最容易造成安全误判的地方。

### 10.3 CI / 无人值守建议

- **CI 场景强制建议 CLOUD**：本机风险面显著更低，即使配置失误也不会波及 runner 的敏感环境。
- CI 用 `MAO_TOKEN`（Secrets 注入）。注意 accessToken 24 h / refreshToken 7 天、无 API Key 体系（§2.4），长期流水线需要轮换机制或接受人工续期。这是产品级约束，不是 CLI 能绕过的（见 §13 #4）。
- LOCAL + 自动放行的组合留到 Phase 3，且默认拒绝清单不可被 `--yolo` 绕过。

---

## 11. 错误处理与退出码

### 11.1 网络异常

- REST：401 触发一次刷新重放；5xx / 网络错误按指数退避重试 2 次；错误分类明确到「超时 / DNS / 连接拒绝 / HTTP / 业务」。
- WS：见 §7.2。长驻模式下重连对用户应几乎无感，仅在连续失败 5 次后提示手动处理。重连成功后按 §7.5 处理幂等。

### 11.2 退出码

| 码 | 含义 | 阶段 |
|---|---|---|
| `0` | 任务成功（终态 `COMPLETED`） | P1 |
| `1` | 一般性错误（参数错误、未登录、网络失败、`session_already_running` 未能恢复） | P1 |
| `2` | 任务失败（终态 `FAILED`） | P1 |
| `3` | 任务被取消（`Ctrl+C` / `SIGTERM` / `/cancel`，终态 `CANCELLED`） | P1 |
| `4` | 需审批但未获授权（仅 LOCAL 有意义） | P3 |
| `5` | 遇到 `ask_user_questions` 且 `--on-question=fail` | P1 |
| `124` | `--max-duration` 超时（对齐 Unix `timeout` 惯例） | P1 |

退出码是 CI 的刚需，须写成单测固化（§15），避免后续演进破坏脚本兼容性。

### 11.3 调试

- `--debug`：WS 收发原始帧（脱敏）+ REST 请求/响应摘要 → stderr。
- `--trace-file <path>`：完整归一化事件流落盘 NDJSON，用于事后复盘与 bug 上报。

---

## 12. 工程实现方案

### 12.1 目录结构

新增顶层目录 **`agent-cli/`**（不叫 `cli/`——未来可能有其他 CLI；也不放 `skills/`——它是独立分发的主力产品，不是配合 Agent 调用的辅助脚本）：

```
agent-cli/
├── package.json              # @mao/agent-cli，bin: { "mao-agent": "bin/mao-agent.js" }
├── tsconfig.json             # paths 指向 ../shared/contracts/src
├── bin/mao-agent.js          # #!/usr/bin/env node，require('../dist/main.js')
├── src/
│   ├── main.ts               # 参数解析 + 命令路由 + 顶层错误处理/退出码
│   ├── args.ts               # 自研参数解析（对齐 mao-user-cli/lib/args.js）
│   ├── commands/             # login / logout / status / ls / resume / chat
│   ├── auth/
│   │   ├── auth-store.ts     # ~/.mao/auth.json（TS 版，格式与 mao-user-cli 一致）
│   │   └── token.ts          # 优先级解析、过期判断、refresh
│   ├── rest/
│   │   ├── rest-client.ts
│   │   └── types.ts          # SessionVO / MessagePage 等 contracts 缺失的类型
│   ├── ws/
│   │   ├── ws-client.ts      # 连接/心跳/重连/sendReliable
│   │   ├── event-filter.ts   # §7.4 的过滤与终态判定（纯函数，易测）
│   │   └── event-types.ts    # 下行事件类型
│   ├── session/
│   │   └── session-runner.ts # 一轮对话的编排器（UI 无关，核心业务逻辑）
│   ├── render/
│   │   ├── repl-renderer.ts
│   │   ├── text-renderer.ts
│   │   └── json-renderer.ts  # json + stream-json
│   ├── repl/repl.ts          # readline 循环、斜杠命令
│   ├── config/config-store.ts
│   └── util/{redact,logger,uuid}.ts
├── local-executor/           # Phase 3
└── test/
    ├── event-filter.spec.ts
    ├── ws-client.spec.ts
    ├── session-runner.spec.ts
    ├── exit-code.spec.ts
    └── fixtures/mock-ws-server.ts
```

### 12.2 技术栈选型

| 决策点 | 选型 | 理由 |
|---|---|---|
| 语言/运行时 | TypeScript + Node ≥ 20 | 状态机复杂度高，值得类型保护；20 而非 22 以扩大运维机器兼容面 |
| 构建 | `tsc` → `dist/`，`bin` 指向 `dist`；`npm run dev` 用 `tsx` | 仓库内无 CLI 构建先例，采用最简 tsc，不引 bundler |
| WebSocket | `ws` ^8 | 与 backend-ts 依赖生态一致；Node 22 的原生 WebSocket 在 20 上不可靠 |
| REST | 原生 `fetch` | 对齐 `mao-user-cli` 零依赖哲学 |
| 参数解析 | 自研（照搬 `mao-user-cli/lib/args.js` 结构） | 首版命令面已收敛到 8 个，不值得引 `commander` |
| 终端渲染 | 手写 ANSI，单行状态栏（§9.1） | 不引 ink/React |
| 测试 | `vitest` | 与 backend-ts 一致，团队已有习惯 |
| 依赖总数 | 目标 ≤ 2 个生产依赖（`ws` + 可选 `adm-zip`（Phase 3）） | 保持可审计、可离线安装 |

### 12.3 与 `@mao/contracts` 集成

`@mao/contracts` 是**纯类型、无构建产物**（`types: src/index.ts`）。因此不用 `dependencies`，而是像 desktop 一样走 tsconfig paths 引源码：

```json
// agent-cli/tsconfig.json
{
  "compilerOptions": {
    "paths": { "@mao/contracts": ["../shared/contracts/src/index.ts"] }
  }
}
```

可直接消费：`Result` / `LoginVO` / `UserInfoVO` / `AgentVO` / `ModelVO`。
**必须自建**：`SessionVO` / `MessagePage` / `CreateSessionRequest` / 全部 WS 事件类型。自建类型文件头部注释指明对齐来源（`backend-ts/src/session/session-vo.ts`、`backend-ts/src/session/ws/`），稳定后再评估反向贡献回 contracts。

### 12.4 与 desktop / mao-cli 的复用策略

- **不共享运行时代码，只对齐语义**。`useStreamWS.ts` 的 984 行里约 490 行绑定 Pinia，直接抽公共包需要改动 desktop 的核心通信层，在 CLI 尚未验证的阶段风险收益不划算。做法：CLI 重写约 300 行协议核心，并在 `ws-client.spec.ts` 里把心跳 5 s / 静默 30 s / 退避 1→30 s 这些常量断言固化；desktop 侧改这些数值时由 code review 保证同步。**Phase 2 结束后**若两边确实稳定，再评估抽 `shared/ws-protocol`。
- **`auth-store` 完全对齐**：同一 `~/.mao/auth.json`、同一优先级、同一错误文案风格，各自维护一份实现（TS vs JS）。注意 desktop Electron 用的是 `userData/auth.json` 且字段名是 `{ token, refreshToken }`，与 CLI 的 `{ accessToken, ... }` 不同，不要混淆。
- **`localShell.cjs` 是唯一直接复用的代码**（Phase 3）：CommonJS + 依赖注入，Node CLI 可以直接 `require`。

### 12.5 分发与发版

1. 用户一条命令安装：`curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash`（sparse clone `agent-cli/` 后 `npm install -g .`）。包内 `vendor/localShell.cjs` 与 desktop 保持同步，独立安装即可跑 LOCAL。
2. 仓库内开发：`cd agent-cli && npm ci && npm run build && npm link`。
3. 需要时发布到 npm（`npm i -g mao-agent`）。
4. CHANGELOG：在根 `CHANGELOG.md` 新增小节 **`### 终端 CLI（mao-agent）`**。
5. CI：`agent-cli` 的 `npm ci && npm run build && npm test`，并 `cmp` vendor 的 `localShell.cjs`。

### 12.6 CI 集成示例

```yaml
- name: Run mao-agent task
  env:
    MAO_TOKEN: ${{ secrets.MAO_CI_TOKEN }}
    MAO_AGENT_BASE_URL: https://mao.etarch.cn/api
  run: |
    mao-agent -p "检查本次 PR 是否有明显的安全问题" \
      --agent security-reviewer \
      --output-format json \
      --max-duration 900 \
      --on-question fail > result.json
    jq -e '.status == "COMPLETED"' result.json
```

---

## 13. 需要后端配合的改动清单

按「是否阻塞」明确分级。**Phase 1 无阻塞项**。

| # | 事项 | 阻塞阶段 | 改动 | 建议 |
|---|---|---|---|---|
| 1 | LOCAL 客户端类型集合 | **阻塞 Phase 3** | `streaming-ws-registry.ts:179-184` 的 `hasLocalClientConnection` 与 `:226-228` 的 `sendToLocalClients` 过滤，从硬编码 `'electron'` 改为共享常量 `LOCAL_CAPABLE_CLIENTS = new Set(['electron','cli'])`；`local-tool-session-registry.ts` 无需改动 | 抽成一个导出常量，两处引用，附单测覆盖 `cli` 也算 local client |
| 2 | `client=cli` 归一化 | 不阻塞（仅可观测性） | `streaming-ws-handler.ts:1127` 与 `streaming-ws-registry.ts:265` 各加一行 `if (c === 'cli') return 'cli'` | 建议随 Phase 1 一起做：3 行改动换来服务端日志可区分 CLI 流量。注意加了之后 `cli` 就不再是 `browser`，需同步确认没有其它地方依赖「非 electron/android 即 browser」的假设 |
| 3 | `tool_approval` 的 `approved` 字段 | 不阻塞 | 现状忽略该字段，语义靠 `tool_result`/`tool_error` 表达 | **不建议改后端**。保持现状，在协议文档与 CLI 实现里写清（§8.3.3）。若将来要改，需同时改 desktop |
| 4 | CI 长期凭据 | 不阻塞（体验受限） | 后端无 API Key / 服务账号（表已删） | 记录为产品级待评估需求：CI 长流水线受 refreshToken 7 天窗口约束。首版接受，文档写明轮换要求 |
| 5 | `client` 取值枚举化 | 不阻塞 | 现状未强校验，未知值静默降级 | 建议后端演进时把 `cli` 正式纳入枚举维护，避免未来加白名单时静默 breaking |
| 6 | WS 入站 1 MB 上限 | 不阻塞（Phase 3 需注意） | `attach-websocket.ts:15` | 不改后端，CLI 侧按 §7.2 做截断 + 落盘 |

---

## 14. 分阶段路线图

| 阶段 | 范围 | 验收标准 |
|---|---|---|
| **Phase 1（MVP）** | 登录（密码 + `MAO_TOKEN`）、CLOUD 模式、REPL、打印模式 `text`/`json`、事件渲染（文本流/工具调用/文件变更/压缩/重试/错误）、**`ask_user_questions` 完整交互**、`ls`/`resume`/`--continue`、`session_already_running` 处理、`Ctrl+C` 取消、退出码规范、**§7.4 事件过滤 + §7.5 重连幂等** | 终端跑通「建会话→发消息→看流式回复与工具调用→拿结果」；desktop 同时在跑另一个会话时 `-p` 不误退出；重连后无重复渲染；单测覆盖 WS 状态机、事件过滤、退出码 |
| **Phase 2（脚本化增强）** | `stream-json` + `--stream-partial-output`、`--debug`/`--trace-file`、配置文件与项目级覆盖、CI 文档与示例、`--max-duration`、多行局部重绘渲染（可选） | 输出 schema 被黄金用例锁定；CI workflow 示例可跑通 |
| **Phase 3（LOCAL 模式）** | 后端 §13 #1 改动 + Local Tool Executor（复用 `localShell.cjs`）+ 文件/搜索工具 + MCP 代理 + 工作区信任 + 审批规则引擎 + TTY 审批 + 技能/MCP 同步 + 默认拒绝清单 | 本机场景端到端可用；拒绝审批不挂死会话；1 MB 截断验证通过；安全测试通过 |
| **Phase 4（高级能力）** | Side Task / 多会话 attach、多模态图片输入（OSS 直传）、消息队列、自更新与二进制分发 | 按需排期，非阻塞 |

**排期变更说明**：`ask_user_questions` 从 v0.1 的 Phase 4 提前到 Phase 1（§8.2 已说明必要性）；`--yolo` 与审批规则引擎从 Phase 1/2 后移到 Phase 3（CLOUD 无审批对象）；ink 渲染从 Phase 1 后移到 Phase 2 可选项。

---

## 15. 测试计划

| 类型 | 内容 |
|---|---|
| 纯函数单测 | `event-filter.ts`：跨会话事件被丢弃、陈旧 `executionId` 被丢弃、终态判定（含 `executionId` 缺失的兜底分支）；`redact.ts`：token / apiKey 脱敏；`args.ts`：选项解析与互斥校验（如 `--on-question=ask` + 非 TTY 报错） |
| `WsClient` 单测 | 基于 `mock-ws-server.ts`：5 s 心跳发出、30 s 静默自断、退避序列 1/2/4…/30 s、重连后重发 `subscribe`、`close()` 后不重连、`sendReliable` 在断线时先重连、超 1 MB payload 被截断 |
| `SessionRunner` 集成测试 | 注入完整事件序列断言编排：正常完成、`FAILED`、`CANCELLED`、`session_already_running`、`ask_user_questions`（答/`fail` 两条路径，`fail` 必须发出 `cancel`）、重连中途注入（断言无重复 `tool_call_start` 渲染）、混入其它会话事件（断言不影响本轮） |
| 退出码测试 | 每个退出码一条用例，固化为回归基线 |
| 输出 schema 黄金用例 | 若干条 `-p --output-format json` / `stream-json` 的期望输出快照，锁定字段不随意 breaking |
| 端到端（手动/半自动） | 对接开发环境真实后端跑通登录→建会话→发消息→工具调用→完成；不进 CI |

CI 只跑前五项（全部离线可跑，无需真实后端）。

---

## 16. 风险与开放问题

| 风险 | 说明 | 缓解 |
|---|---|---|
| **CLOUD 无审批导致的安全误判** | 用户会以为 `--permission-level READ_ONLY` 能限制 CLOUD 下的 Agent 行为，实际完全无效 | `--help`、README、`status` 输出三处显式说明；真要限权用受限工具集的 Agent（§10.2） |
| **广播式事件投递** | 忘记按 sessionId 过滤 → `-p` 提前退出、结果错乱，且只在「用户同时开着 desktop」时才复现，极难排查 | §7.4 算法 + 专项单测（混入其它会话事件） |
| **重连丢 `content_delta`** | 协议不重放文本增量，重连必然丢字 | 显式标注 `reconnected: true` / REPL 提示；不假装完整 |
| 协议演进不同步 | 后端事件字段变更时 CLI 未跟进 | 消费端忽略未知字段；`ws-client.spec.ts` 固化常量；`agent-cli` 进 CI |
| WS 协议常量在两处维护 | CLI 与 desktop 各有一份心跳/退避实现 | 单测固化 + review；Phase 2 后评估抽公共包（§12.4） |
| Token 7 天窗口 | 无 API Key 体系，长驻 CI 需人工轮换 | §13 #4 记录为产品需求；文档写明约束 |
| `ask_user_questions` 15 分钟阻塞 | 打印模式若直接退出，服务端执行线程被白占 15 分钟 | `--on-question=fail` 必须先发 `cancel`（§8.2），并写成单测断言 |
| Phase 3 的 1 MB 限制 | 大 shell 输出会直接断连，表现为「无原因掉线」 | 复用 desktop 的截断 + 落盘策略；单测覆盖 |
| 命名混淆 | `mao-agent` 与后端 `Agent` 领域概念、`agent` 表易混 | 文档与帮助文本首次出现用「mao-agent CLI」全称 |

---

## 17. 附录：协议字典（源码核对版）

### 17.1 WS 下行事件

信封统一为 `{ type, sessionId, data }`（`ws-event.ts:1-9`），字段都在 `data` 里。

| type | 归类 | `data` 关键字段 | 仅投 `electron` |
|---|---|---|---|
| `connected` | 连接 | `userId` | |
| `pong` | 连接 | — | |
| `session_snapshot` | 会话 | `phase`（`RESUMING`→`RUNNING`）, `executionId?` | |
| `session_status` | 会话 | `phase`, `executionId?`, `unread?`（终态恒为 true） | |
| `session_list_update` | 会话 | `phase` | |
| `session_already_running` | 会话 | `code`, `message`, `executionId?` | |
| `session_title_updated` | 会话 | `title`, `parentSessionId`, `sessionType` | |
| `session_tree_status` | 会话树 | `treePendingApprovalCount`, `treePendingQuestionCount`, `treeUnread`, `treeRunning`, `treeFailed` | |
| `user_message_saved` | 消息 | `messageId`, `tempEventId?`, `source?`, `content?` | |
| `content_delta` | Agent 流 | `delta` | |
| `thinking_start` / `thinking_end` | Agent 流 | — | |
| `thinking_delta` | Agent 流 | `delta` | |
| `tool_call_start` | Agent 流 | `tool_call_id`, `tool_name`, `arguments` | |
| `tool_call_args_delta` | Agent 流 | `tool_call_id`, `arguments` | |
| `tool_call_result` | Agent 流 | `tool_call_id`, `result`, `status`, `tool_name?`, `preview?`, `summary?` | |
| `message_end` | Agent 流 | `prompt_tokens`, `completion_tokens`, `total_tokens` | |
| `file_change` | Agent 流 | `path`, `type`, `lines_added`, `lines_deleted`, `tool_call_id` | |
| `activity` | Agent 流 | `id`, `type`, `target`, `summary`, `status` | |
| `todo_updated` | Agent 流 | `todos: [{ id, content, status }]` | |
| `context_window` | Agent 流 | `estimated`, `actual` | |
| `compaction_start` | Agent 流 | `type`, `messageCount`, `estimatedTokens` | |
| `compaction_end` | Agent 流 | `type`, `summaryTokens`, `savedTokens`, `durationMs` | |
| `compaction_marker` | Agent 流 | `id`, `triggerMode`, `prevBoundaryMsgId`, `boundaryMsgId`, `compactedMessageCount`, `summaryTokens`, `savedTokens`, `durationMs` | |
| `llm_waiting` | Agent 流 | `phase`, `elapsedSeconds` | |
| `llm_stream_reset` | Agent 流 | — | |
| `llm_retry` | Agent 流 | `reason`, `attempt`, `maxRetries`, `delaySeconds`, `statusCode?` | |
| `error` | Agent 流 | `message`, `executionId?` | |
| `ask_user_questions` | 交互 | `requestId`, `questions[]`, `metadata?` | |
| `ask_user_questions_cancelled` | 交互 | `requestId` | |
| `side_session_created` | 并行 | `sideSessionId`, `title` | |
| `subagent_session_created` | 并行 | `childSessionId`, `title`, `agentType`, `task`, `toolCallId?` | |
| `queue_updated` | 队列 | `queue: [{ id, sessionId, content, sortOrder, createdAt, images? }]` | |
| `queue_message_consumed` | 队列 | `messageId`, `content`, `images?` | |
| `tool_execute` | LOCAL | `requestId`, `toolName`, `arguments`, `workspace`, `needApproval`, `dangerReason?` | ✅ |
| `skill_sync_required` | LOCAL | `syncUrl`, `removed[]`, `workspace` | ✅ |
| `mcp_sync_required` | LOCAL | `syncId`, `servers[]` | ✅ |

### 17.2 WS 上行消息（注意字段层级）

| type | 顶层字段 | `data` 内字段 |
|---|---|---|
| `subscribe` / `unsubscribe` | `sessionId` | — |
| `send_message` | `sessionId` | `content`*, `eventId?`, `images?`, `modelId?`, `replaceExecution?`, `localSkills?`, `agentsMdContent?` |
| `edit_and_resend` | `sessionId`, `messageId`, `content`, `images?`, `localSkills?`, `agentsMdContent?` | — |
| `cancel` | `sessionId` | — |
| `retry_execution` | `sessionId` | — |
| `ask_user_questions_result` | `sessionId` | `requestId`*, `answers?` |
| `tool_result` | `sessionId`, `requestId`*, `result?` | — |
| `tool_error` | `sessionId`, `requestId`*, `error?` | — |
| `tool_approval` | `sessionId`, `requestId`* | — （`approved` **不被读取**） |
| `skill_sync_done` | `sessionId`, `success?`, `error?` | — |
| `mcp_tools_report` | `sessionId`, `syncId?`, `servers?` | — |
| `enqueue_message` | `sessionId` | `content`*, `images?` |
| `insert_message` / `delete_queue_message` | `sessionId` | `queueId`* |
| `reorder_queue_message` | `sessionId` | `queueId`*, `direction`* |
| `create_side_session` | `sessionId`（父） | `content`*, `inheritContext?`, `modelId?`, `images?` |
| `cancel_side_task` | `sideSessionId`*（**不是** `sessionId`） | — |
| `ping` | — | — |

`*` = 必填；缺失时后端**静默 return**，不回错误。未知 `type` 同样静默忽略——CLI 调试时要意识到「没反应」可能是字段名或层级写错了。

### 17.3 REST 端点（CLI 用到的子集）

完整 URL = `{baseUrl}` + 下列路径，其中 `{baseUrl}` 到 `/api` 为止。响应一律 `Result<T>`。

```
POST   /v1/auth/login              { username, password } → LoginVO
POST   /v1/auth/refresh            { refreshToken } → LoginVO（含新 refreshToken，须回写）
POST   /v1/auth/logout             无副作用，客户端丢弃 token 即可
GET    /v1/users/me                → UserInfoVO
GET    /v1/agents?keyword=         → AgentVO[]（含 isDefault）
GET    /v1/models/active           → ModelVO[]（⚠ 含明文 apiKey，须过滤）
GET    /v1/models/default          → ModelVO | undefined
POST   /v1/sessions                → SessionVO（默认 CLOUD + READ_ONLY）
GET    /v1/sessions?keyword=&status=            → SessionVO[]（无 groupKey 时）
GET    /v1/sessions?groupKey=&offset=&limit=    → { items, total, offset, limit, hasMore }
GET    /v1/sessions/:id            → SessionVO
GET    /v1/sessions/:id/messages?roundLimit=&beforeMessageId=
                                   → { messages, hasMore, nextBeforeMessageId, compactionEvents? }
PUT    /v1/sessions/:id/read       清 unread
GET    /v1/sessions/cloud-projects → { name, path, isGit }[]
```

WebSocket：

```
GET  {baseUrl}/ws/stream?token=<accessToken>&client=cli
```

### 17.4 示例交互

**交互模式**：

```
$ mao-agent
✔ 已登录 demo@etarch.cn
✔ 新建会话 #128（Agent: 通用助手 · Model: gpt-4o · CLOUD）
› 帮我看看这个仓库的 README 写了什么，总结成三句话
💭 思考中…
▸ read_file  README.md
  total_lines=210
这份 README 描述了……（三句话总结）……
  Agent: 通用助手  Model: gpt-4o  CLOUD  Context: 18%  12s
› /exit
```

**打印模式**：

```bash
$ mao-agent -p "检查 backend-ts 是否能通过 npm run build" --output-format json
{
  "type": "result",
  "sessionId": 129,
  "executionId": "8f2c1d3e-...",
  "status": "COMPLETED",
  "result": "backend-ts 编译通过，无 TypeScript 错误。",
  "usage": { "promptTokens": 3400, "completionTokens": 210, "totalTokens": 3610 },
  "toolCalls": [ { "toolCallId": "tc_1", "toolName": "shell", "status": "SUCCESS" } ],
  "durationMs": 15230
}
$ echo $?
0
```

### 17.5 参考

- Cursor CLI 官方文档：`--print` / `--output-format` / `--resume` / `ls` 等形态取自 `cursor-agent`（[output-format 参考](https://cursor.com/docs/cli/reference/output-format)）。
- 内部文档：[local-tool-ws-merge.md](./local-tool-ws-merge.md)、[shell-session-design.md](./shell-session-design.md)、[shell-unification-design.md](./shell-unification-design.md)、[android-app-technical-design.md](./android-app-technical-design.md)（第四端接入范例）。
- 内部代码（本文档所有事实的来源）：`backend-ts/src/session/ws/`（`streaming-ws-handler.ts`、`streaming-ws-registry.ts`、`attach-websocket.ts`、`ws-event.ts`）、`backend-ts/src/harness/tool/tool-dispatcher.ts`、`backend-ts/src/harness/tool/ask-user-questions-registry.ts`、`backend-ts/src/harness/approval/approval-registry.ts`、`backend-ts/src/session/session.service.ts`、`backend-ts/src/session/session.routes.ts`、`backend-ts/src/session/task-terminal.service.ts`、`backend-ts/src/auth/auth.service.ts`、`desktop/src/composables/useStreamWS.ts`、`desktop/src/composables/useChat.ts`、`desktop/electron/localShell.cjs`、`skills/mao-cli/lib/`、`shared/contracts/src/`。
