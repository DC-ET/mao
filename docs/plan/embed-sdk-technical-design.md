# Embed SDK（Web 嵌入式对话组件）技术方案

> 状态：设计定稿，未开工。本文档为唯一实现依据；开工后如与实现冲突，先改本文档。

## 1. 需求背景

Mao 的 agent 对话能力目前已覆盖 desktop（Electron / Web）、android 壳、agent-cli（mao-agent）、weixin / feishu bot。但内部 Web 业务系统想把 agent 对话能力嵌入自己的页面时，没有任何轻量途径——要么引导用户跳转 Mao，要么整页复制 desktop。

本需求提供 **Web Embed SDK**：内部 Web 系统引入一个脚本文件、调用一次 `MaoChat.init()`，页面即出现浮动入口按钮，点击展开对话浮窗，终端用户可与 Mao agent 就当前页面内容进行完整对话（含流式输出、思考过程、工具执行状态、追问回答、手动停止；工具审批仅 LOCAL 链路存在，embed 会话默认 CLOUD，无审批环节）。

### 已否决的备选方案

- **iframe 浮窗方案**（desktop 加 `/embed/chat` 路由 + 引导脚本）：实现最省，但 SDK 无法沉淀为独立交付物与公开 API 契约，后继向任意第三方站开放时宿主侧要推倒重来。已否决，但 iframe 方案的 `getToken()` / `context()` API 设计被本方案继承。
- **Headless SDK**（只输出协议与状态，宿主自绘 UI）：维护成本转嫁给每个接入方，不符合"一行接入"目标。已否决。

## 2. 需求描述

### 2.1 宿主接入形态（长期契约）

```html
<script src="https://mao.etarch.cn/embed/mao-chat.js"></script>
<script>
  const chat = MaoChat.init({
    serverUrl: 'https://mao.etarch.cn',
    agentId: 3,                                  // 必填，宿主指定页面助手 agent
    getToken: () => fetch('/my-backend/embed-token').then(r => r.json()).then(d => d.accessToken),
    context: () => ({ page: 'order-detail', orderId: currentOrderId }),
    theme: { primary: '#4f6ef7' },               // 可选
    position: 'right',                           // 可选，默认 right
    launcher: { visible: true },                 // 可选，宿主可隐藏自绘按钮并用 chat.open()
    onEvent: (e) => track(e),                    // 可选，phase/error 事件透传
  })
  chat.open(); chat.close(); chat.toggle(); chat.newSession(); chat.setContext(obj); chat.destroy();
</script>
```

### 2.2 功能范围

- 浮动按钮：右下角固定，展示运行状态（空闲 / 执行中转圈 / 需要处理红点）。
- 对话浮窗：Shadow DOM 挂载，含消息流（用户 / 助手气泡、Markdown 渲染、思考过程折叠、工具调用状态卡片）、文本输入框、发送、**手动停止执行**、"新对话"按钮、错误与重连提示。
- 注：工具审批仅存在于 LOCAL 执行链路（Electron 客户端弹窗处理），embed 会话默认 CLOUD、服务端执行工具，无审批环节，浮窗不提供审批 UI。
- 追问卡片：`ask_user_questions` 事件驱动，浮窗内作答并回传。
- 页面上下文：`context()` 返回值做变更检测，变化时以引用块前缀拼入下一条用户消息；宿主页面选中文本自动出现"讨论：xxx"引用 chip。
- 会话：每 (用户, agent) 一个常驻会话，sessionId 持久化于 localStorage，仅复用 SDK 自己创建的会话；desktop 端会话列表可见该会话并可继续（共享列表作为跨端连续性 feature 保留）。
- 懒连接：首次展开浮窗才建立 WS；发送时若连接不在则走重连兜底（同 desktop `sendReliable` 语义）。

### 2.3 身份与集成约定

- 终端用户即 Mao 账号用户，**复用 Mao JWT**，SDK 不新增鉴权体系。
- **refresh token 不进浏览器**：宿主后端持有 Mao 凭据（或代登录 `/api/v1/auth/login`），仅向页面发放短期 access token；SDK 只通过 `getToken()` 取值，内存持有，401 / WS 鉴权失败时重新调用 `getToken()`，**不落 localStorage / sessionStorage**。
- token 生命周期、续期、注销责任在宿主；SDK 无状态。

## 3. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| UI 框架 | Vue 3（SDK 内置 runtime）+ Shadow DOM | 复用 desktop 渲染层经验；Vue 3 对 Shadow DOM 支持成熟 |
| 构建 | Vite lib mode，产物 IIFE 单文件 + ESM 双格式，样式构建期内联注入 Shadow DOM | 与 desktop 工具链一致；`<script>` 一行接入 |
| Markdown | marked + DOMPurify（与 desktop 同依赖） | 直接复用渲染链经验，体积可控 |
| 协议类型 | 新建 `packages/protocol-types`（零运行时 TS 类型） | WS 消息定义单一来源，防 desktop / SDK 协议漂移 |
| WS 客户端 | 从 `desktop/src/composables/useStreamWS.ts` 受控裁剪复制 | 协议行为（重连 / 心跳 / executionId 去重 / 快照对账）已被 desktop 验证 |
| 依赖红线 | 禁止 element-plus、tiptap、monaco、xterm、pdfjs 进入 SDK 产物 | 任一都会击穿包体预算 |
| 包体预算 | ≤ 200KB gzip（预期 ~150KB），构建接 size-limit | 常驻功能型组件的合理上限 |

## 4. 总体设计

### 4.1 目录结构

```
packages/protocol-types/          # WS 帧与事件 payload 的 TS 类型，零运行时
sdk/embed/                        # @mao/chat-embed（仓内标识，不发包）
├── src/
│   ├── index.ts                  # init / 实例 API / destroy
│   ├── core/
│   │   ├── ws-client.ts          # useStreamWS 裁剪版（见 4.2）
│   │   ├── auth.ts               # getToken 契约、401 重取
│   │   ├── session-manager.ts    # 会话创建/复用/新对话，localStorage 持久化
│   │   ├── store.ts              # 消息聚合、delta 拼接、工具状态机（reactive）
│   │   └── tabs.ts               # BroadcastChannel 多 tab 竞态协调
│   ├── ui/                       # Shadow DOM 组件（自绘轻量，视觉对齐 desktop）
│   │   ├── launcher.ts / panel.ts / message-list.ts / composer.ts
│   │   ├── approval-card.ts / question-card.ts / status-banner.ts
│   ├── context/
│   │   ├── collector.ts          # context() 采集 + JSON hash 变化检测 + 8KB 上限
│   │   └── selection.ts          # selectionchange 监听（debounce）→ 引用 chip
│   └── protocol/                 # 协议帧构造与事件路由
├── demo/index.html               # 本地 dev 验收页（模拟宿主：路由切换 + 业务数据）
├── vite.config.ts                # lib mode + css-injected-by-js + size-limit
└── package.json                  # version 0.1.0 独立版本号
```

### 4.2 WS 协议子集（client = `embed`）

**发送帧（保留）**：`auth`（首帧，token 不进握手 URL）、`ping`、`subscribe`、`unsubscribe`、`send_message`、`cancel`（手动停止）、`tool_approval`、`ask_user_questions_result`。

**接收事件（保留并渲染）**：`connected`、`pong`、`content_delta`、`thinking_start/delta/end`、`tool_call_start`、`tool_call_args_delta`、`tool_call_result`、`session_status`（phase 驱动按钮状态与输入框启停）、`message_end`、`user_message_saved`、`error`、`session_snapshot`（重连终态对账）、`ask_user_questions`、`ask_user_questions_cancelled`、`llm_waiting` / `llm_retry` / `llm_stream_reset`、`session_title_updated`。

**明确剔除（不进 SDK）**：`tool_execute`（CLOUD 服务端执行，桌面 LOCAL 专属）、`skill_sync_required` / `mcp_sync_required` / `skill_sync_done`（Electron 专属）、`tool_result` / `tool_error`（同上）、`file_change` / `compaction_*`（一期不做 diff 面板与压缩可视化）、`side_session_created` / `subagent_*` / `session_tree_status`（Side Task 体系不暴露）、`queue_updated` / `queue_message_consumed`（一期不做排队）、`edit_and_resend` / `enqueue_message` / `insert_message` / `delete_queue_message` / `reorder_queue_message` / `retry_execution` / `create_side_session` 发送帧。

**必须继承的 desktop 行为**（裁剪时不可省略）：executionId 去重（stale 事件丢弃）、cancel 后的会话级事件抑制、重连后全量 re-subscribe、`session_snapshot` 终态对账（终结残留工具转圈）、30s 静默判定 + 心跳。

### 4.3 REST 子集（全部现成接口，零后端新增）

- `POST /api/v1/sessions`：创建会话（`agentId` 必传；不传 `workspace` / `cloudProjectKey`，走后端默认）。
- `GET /api/v1/sessions/{id}`：恢复会话（校验归属与 phase）。
- `GET /api/v1/sessions/{id}/messages`：浮窗展开时拉取历史消息。

### 4.4 上下文注入格式

`context()` 结果 JSON 序列化后计算 hash，**仅当 hash 与上一条消息不同**才拼入下一条用户消息（引用块形式，整体上限 8KB，超限截断并附提示）：

```
[页面上下文]
url: https://host/path
title: 页面标题
data: {"page":"order-detail","orderId":"12345"}
```

选中文本作为独立引用块 `quotedSelection` 与上下文块一并拼入。二者均为 SDK 侧文本拼装，**不落独立字段、不进消息 metadata**。

### 4.5 多 tab 竞态

同一浏览器多页签同时初始化时，通过 `BroadcastChannel('mao-embed')` 协调：先到页签宣告 sessionId 所有权，后到者等待短暂窗口后复用，避免重复建会话。

### 4.6 产物与部署链路

- 构建输出：`mao-chat.v{version}.js`（版本锁定）与 `mao-chat.js`（latest 副本），托管路径 `https://mao.etarch.cn/embed/`。
- 接线方式：sdk/embed 构建产物复制到 `desktop/public/embed/`，由 desktop build 打包，随 `scripts/deploy-desktop.sh` rsync 上线。根/CI 的 desktop build 前置 `sdk/embed` build。
- 后端改动仅一处：`streaming-ws-handler.ts` 的 `normalizeClient` 增加 `'embed'` 分支（日志与注册表识别）。

## 5. 实现步骤

1. **packages/protocol-types**：从 `streaming-ws-handler.ts` / `useStreamWS.ts` 提取 WS 帧、事件 payload、REST 关键类型；desktop `useStreamWS.ts` 的类型引用切换至共享包（仅 import 替换，逻辑不动，`vue-tsc` 把关）。
2. **sdk/embed 脚手架 + ws-client**：Vite lib mode、Shadow DOM 挂载骨架；裁剪复制 ws-client（保留 4.2 全部"必须继承"行为），vitest 覆盖状态机（重连、去重、cancel 抑制、快照对账）。
3. **会话管理 + REST**：创建 / 复用 / 新对话 / 历史拉取；localStorage key `mao_embed_session_{agentId}`；BroadcastChannel 协调。
4. **UI 壳**：launcher（状态点）、浮窗、消息流、输入框、停止按钮、新对话、错误 / 重连横幅；`onEvent` 透传 phase / error。
5. **答问卡片**：`ask_user_questions` 请求-回传，复用 desktop 的交互语义（工具审批仅 LOCAL 链路，不实现）。
6. **上下文采集**：collector（hash 检测、8KB 截断）+ selection chip + 发送前拼装。
7. **构建 / 部署接线 + demo 页**：产物双格式输出、size-limit、desktop public 接线、deploy-desktop.sh 验证（dry-run）；demo/index.html 模拟宿主（含路由切换与 context 变化）。
8. **后端 `embed` client 类型**：normalizeClient 一行 + 单测。
9. **文档与 CHANGELOG**：README.md / DEPLOY.md 增补 Embed SDK 章节（含接入文档：CSP `connect-src` 放行 mao 域 ws/wss、token 发放约定、context 数据出边界警示、agentId 权限要求）；`skills/mao-cli/SKILL.md` 同步；根 CHANGELOG.md 顶部新增 `## 0.x.x` 条目，新增 `embed-sdk` 小节。

## 6. 落地清单

### 6.1 新增（要做）

| 位置 | 内容 |
|---|---|
| `packages/protocol-types/` | WS 帧 / 事件 payload / 关键 REST 类型的 TS 定义包（package.json + src + vitest 类型测试） |
| `sdk/embed/` | 完整 SDK 包：`src/{index,core,ui,context,protocol}`、`demo/index.html`、vite lib 构建配置、size-limit 配置、vitest 单测 |
| `desktop/public/embed/` | 构建产物落点：`mao-chat.v{version}.js` + `mao-chat.js`（latest） |
| `docs/plan/embed-sdk-technical-design.md` | 本文档 |
| 根 CI workflow | 新增 sdk/embed 的 build + test job（与 agent-cli 同级） |

### 6.2 修改（要做）

| 位置 | 改动 | 幅度 |
|---|---|---|
| `desktop/src/composables/useStreamWS.ts` | WS 帧类型 import 切换至 `packages/protocol-types`，逻辑零改动 | 仅 import |
| `backend-ts/src/session/ws/streaming-ws-handler.ts` | `normalizeClient` 增加 `'embed'` 分支 | 一行 |
| 对应单测 | embed client 类型断言 | 数行 |
| `desktop/package.json` / 根构建脚本 | desktop build 前置 sdk/embed build + 产物复制 | 数行 |
| `README.md` / `DEPLOY.md` | Embed SDK 接入章节（接入示例、CSP、token 约定、SRI、警示） | 新章节 |
| `skills/mao-cli/SKILL.md` | 同步 Embed SDK 说明 | 新小节 |
| `CHANGELOG.md` | 顶部新版本条目 + `embed-sdk` 小节 | 新条目 |

### 6.3 明确不做（一期）

- 后端 `send_message` 的 `metadata.context` 注入与 PromptEngine 改造（二期评估）。
- session 表 `source=embed` 隔离标记与 desktop 列表过滤（二期评估）。
- 消息排队（queue）、图片上传、浮窗内历史会话切换、重试执行 `retry_execution`、编辑重发。
- 暗色主题、完整主题 API、移动端宿主适配与全屏模式。
- Agent 主动读页面（`page_context_request` 双向协议）。
- embed 项目体系：appKey/appSecret 代签发、域名白名单、配额限流、按项目工具白名单。
- npm 包发布。
- file_change diff 面板、compaction 可视化、Side Task / 子代理面板、终端。
- Playwright e2e（按仓库 CI 惯例，不跑 Playwright）。

### 6.4 验收标准

1. demo 页（vite dev）引入 `mao-chat.js` 后，浮窗可完成：创建会话 → 流式对话 → 追问作答 → 手动停止 → "新对话" → 刷新页面复用同一会话（localStorage）。
2. 双页签同时初始化不产生重复会话（BroadcastChannel 生效）。
3. 断网 30s 内恢复后，WS 自动重连、re-subscribe、`session_snapshot` 对账，无残留转圈；跨该过程的 stale 事件被丢弃。
4. `context()` 返回值变化后，下一条用户消息携带新引用块；未变化则不携带；超 8KB 截断。
5. desktop 端会话列表可见 SDK 会话，双端同一会话可继续对话；并发发送时另一端收到 `session_already_running` 提示。
6. 产物 gzip ≤ 200KB（size-limit 守门）；`normalizeClient` 识别 `embed` 类型。
7. `cd sdk/embed && npm run build && npm test`、desktop `vue-tsc`、backend-ts build+test 全绿；CI 各 job 通过。
