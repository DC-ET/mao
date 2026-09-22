# Embed Web Embed SDK 页面操作 Agent 工作交接

> 交接日期：2026-09-08
> 开发分支：`feat/embed-page-agent`
> Worktree：`/opt/mao-data/workspace/2/projects/mao/.worktrees/embed-page-agent`
> 主工作区：`/opt/mao-data/workspace/2/projects/mao`
> 当前状态：**未提交、未合并、未部署、未推送**

## 1. 目标与产品边界

本任务目标是在 Mao 中实现 Web Embed SDK 页面操作 Agent。业务前端只需要引入 SDK 并调用一段初始化代码，例如 `MaoChat.init()`，不需要修改业务按钮、表单、路由、回调，不需要增加 `data-*` 标记，也不需要提供 selector 映射或适配器。

Agent 通过后端工具规划页面操作，Embed SDK 在用户当前浏览器页面中执行。支持的目标能力包括：

- 页面检查：`inspect`
- 当前视口截图：`screenshot`
- 滚动、聚焦
- 填写输入框
- 选择下拉选项
- 勾选/取消勾选
- 点击
- 键盘输入
- 等待、观察
- 单动作和有序批量动作

SDK 只能操作当前标签页、当前页面可访问的主文档、同源 iframe 和开放 Shadow DOM。必须拒绝或明确报告以下能力：跨域 iframe、闭合 Shadow DOM、文件选择器/上传、浏览器权限弹窗、验证码/人机验证、系统窗口、其他标签页、任意 JavaScript 执行、坐标点击以及真实用户手势限制的浏览器行为。

## 2. 必须遵守的工作区规则

- 只能先在独立 worktree 开发，不能直接修改主工作区。
- 不要覆盖或丢弃已有未提交改动。
- 修改后优先运行最具体的 build/test，再进行全量验证。
- 不要把 `embed` 加入 `LOCAL_CAPABLE_CLIENTS`；LOCAL 能力仍只属于 Electron 和 CLI。
- 页面工具结果绝不能复用 `LocalToolSessionRegistry`。
- 不要把 selector、XPath、outerHTML 或任意 DOM path 暴露给 Agent；元素引用必须是 snapshot 作用域内的 opaque `elementId`。
- 用户没有要求部署，不要部署；没有明确要求不要 push。
- 每次功能变更需要同步更新根目录 `CHANGELOG.md` 和对应文档，并同步 `skills/mao-cli/`（最终实现完成后处理）。

## 3. 当前 worktree 状态

最近状态包含以下源码改动和新增文件：

```text
backend-ts/src/harness/deps.ts
backend-ts/src/harness/local/local-tool-session-registry.ts
backend-ts/src/session/ws/streaming-ws-handler.ts
backend-ts/src/session/ws/streaming-ws-registry.ts
backend-ts/src/harness/embed-page-tool-registry.ts
sdk/embed/src/controller.ts
sdk/embed/src/core/ws-client.ts
sdk/embed/src/index.ts
sdk/embed/src/types.ts
sdk/embed/src/authorization.ts
sdk/embed/src/page.ts
sdk/embed/src/page-scanner.ts
sdk/embed/src/page-scanner.spec.ts
sdk/embed/src/screenshot.ts
shared/contracts/src/ws.ts
shared/contracts/src/index.ts
docs/code-review/*-code-review-*.md
```

本交接文档位于：

```text
docs/handoff/embed-page-agent-handoff.md
```

其中 `node_modules` 是本地安装产物，不应作为源码交付。

## 4. 已完成的实现

### 4.1 SDK 页面类型与页面执行器原型

文件：`sdk/embed/src/page.ts`

已有内容：

- `PageElementKind`
- `PageRect`
- `PageOption`
- `PageElement`
- `PageSnapshot`
- `PageAction`
- `PageActionResult`
- `PageSnapshotManager`
- `visible()`

当前动作均绑定：

```ts
snapshotId + elementId
```

已有动作类型包括 `click`、`focus`、`check`、`uncheck`、`fill`、`keyboard`、`select`、`scroll`。页面快照使用 opaque element ID，并会排除 SDK host。已有基础的 snapshot 校验、disabled/readonly 拦截和若干动作执行逻辑。

但这是原型，不代表产品闭环已完成，见第 5 节。

### 4.2 页面扫描器与测试

文件：

- `sdk/embed/src/page-scanner.ts`
- `sdk/embed/src/page-scanner.spec.ts`

已有测试覆盖：

- 语义控件
- label 解析
- password 脱敏
- SDK host 排除
- 业务控件计数

`page-scanner.ts` 当前主要是对 `PageSnapshotManager` 的导出包装，存在重复/收束空间。

### 4.3 SDK 公共 API 原型

文件：

- `sdk/embed/src/index.ts`
- `sdk/embed/src/types.ts`

已有公开方法原型：

- `inspectPage()`
- `executePageAction(action)`
- `getPageAuthorization()`
- `setPageAuthorization(level)`
- `capturePageScreenshot(render)`

已有授权级别：

```ts
'per_action' | 'task' | 'full'
```

默认级别为 `per_action`。

### 4.4 截图适配器原型

文件：`sdk/embed/src/screenshot.ts`

当前设计要求调用方传入 DOM renderer，SDK 负责：

- 使用当前视口宽高
- 传入排除 SDK host 的 ignore predicate
- 输出 PNG Blob

目前尚未提供默认 renderer，也没有完整接入授权、敏感内容遮罩和 Agent WS。

### 4.5 授权原型

文件：`sdk/embed/src/authorization.ts`

当前支持三个级别：

- `per_action`：每个页面动作执行前确认
- `task`：本次任务内授权，任务结束/刷新/切换会话/撤销后失效
- `full`：允许授权范围内的页面 DOM 操作，并可跨刷新持久化

目前授权实例在 `sdk/embed/src/index.ts` 中仍使用：

```ts
new PageAuthorization(options.serverUrl, options.agentId, 'anonymous', false)
```

这是临时占位，不符合最终用户隔离要求，不能直接作为完成实现。

### 4.6 WS 合同和后端 Embed registry 原型

文件：

- `shared/contracts/src/ws.ts`
- `shared/contracts/src/index.ts`
- `backend-ts/src/session/ws/streaming-ws-registry.ts`
- `backend-ts/src/session/ws/streaming-ws-handler.ts`
- `backend-ts/src/harness/embed-page-tool-registry.ts`

已新增或开始使用：

- `page_tool_request`
- `page_tool_result`
- `WsPageToolRequest`
- `WsPageToolResultFrame`
- `WsEmbedOutboundFrame`
- `StreamingWsRegistry.sendToEmbedClients()`
- `EmbedPageToolRegistry`

当前 `EmbedPageToolRegistry` 负责：

- 按 session 保存 pending request
- 生成 requestId
- 向 Embed client 发送 `page_tool_request`
- 接收完成结果
- 30 秒超时后返回错误
- session 失败时统一 resolve 错误

最近已将 `streaming-ws-handler.ts` 中的 `page_tool_result` 从 LOCAL registry 切换到 `embedPageToolRegistry`，避免协议串线。但该依赖的 create-app 注入和完整测试仍未完成。

## 5. 当前未完成且必须优先处理的事项

### 5.1 后端依赖注入

必须检查：

- `backend-ts/src/create-app.ts`
- `backend-ts/src/harness/deps.ts`
- `backend-ts/src/session/ws/streaming-ws-handler.ts`

需要实例化 `EmbedPageToolRegistry`，提供 session → user 的解析函数，并注入到 handler、harness/tool dispatcher 或其他实际 Agent 调用链。

当前 handler 接口已经增加了类似：

```ts
embedPageToolRegistry: EmbedPageToolRegistry;
```

需要确认所有 `StreamingWsHandler` 构造调用、测试 mock 和依赖类型都同步更新。

### 5.2 SDK 接收并执行 `page_tool_request`

当前 `sdk/embed/src/core/ws-client.ts` 已有发送页面工具结果的初步能力，但 SDK 尚未完成完整请求分发。

正确方向：

1. `EmbedController` 持有唯一的页面执行器实例。
2. `index.ts` 暴露的页面 API 与 controller 使用同一个页面状态/快照管理器，不能分别 `new PageSnapshotManager()`。
3. controller 收到 `page_tool_request` 后按 tool 分发：
   - `page_inspect` → `page.inspect()`
   - `page_scroll` / `page_focus` / `page_fill` / `page_select` / `page_check` / `page_uncheck` / `page_click` / `page_keyboard` → `page.execute()`
   - `page_screenshot` → screenshot adapter
   - `page_wait` → 安全等待
   - `page_observe` → 返回当前快照或页面状态
4. 每次请求校验 sessionId、requestId、授权和页面生命周期。
5. 成功/失败都调用 `sendPageToolResult()`。
6. 不把结果伪装成普通聊天消息。

### 5.3 后端 page Agent 工具

需要参考现有工具实现和 descriptor/schema 模式：

```text
backend-ts/src/harness/tool/tool-registry.ts
backend-ts/src/harness/tool/impl/
backend-ts/src/harness/tool/tool-dispatcher.ts
```

需要实现并注册至少：

- `page_inspect`
- `page_screenshot`
- `page_scroll`
- `page_focus`
- `page_fill`
- `page_select`
- `page_check`
- `page_uncheck`
- `page_click`
- `page_keyboard`
- `page_wait`
- `page_observe`

工具参数必须使用 snapshotId/elementId，不允许 selector、XPath、JS 或坐标。工具执行只允许 Embed session，并通过 `EmbedPageToolRegistry.request()` 等待浏览器结果。需要明确超时、断开、取消和非 Embed session 错误。

### 5.4 连接和页面实例隔离

当前 registry 主要按 userId 的 Embed 连接广播：

```ts
sendToEmbedClients(userId, event)
```

这会导致同一用户多标签页/多页面收到同一个请求，产品上不可接受。必须设计 session 或连接实例绑定：

- 连接注册时记录 client connection/session/page instance
- Agent session 只能路由到绑定的 Embed 连接
- request result 必须校验来源连接和 requestId
- 不允许同用户其他 tab 伪造或接收结果
- 断开连接时清理该连接关联的 pending page requests

同时确保 `LOCAL_CAPABLE_CLIENTS` 仍为：

```ts
new Set(['electron', 'cli'])
```

### 5.5 生命周期、导航和取消

必须实现：

- 用户点击停止 → 取消当前页面任务和 pending request
- session disconnect → 清理 pending request
- `destroy()` → 停止页面任务并移除监听器
- 刷新页面 → task 授权失效、旧快照失效
- SPA 路由/页面重大 DOM 重建 → pageVersion/snapshot 失效
- 页面导航后 Agent 必须重新 inspect
- `task` 不得跨刷新恢复
- `full` 才允许按隔离身份持久化

### 5.6 页面动作正确性

当前原型动作可能出现 DOM API 未抛异常但动作实际没有生效的问题。需要补充结果回读和验证：

- `fill` 支持原生 input/textarea/contenteditable，并正确触发 input/change 事件，兼容 React/Vue 受控组件
- `select` 校验 option 存在、未禁用，并回读最终 value
- `check/uncheck` 校验 checkbox/radio 类型及最终 checked 状态
- 处理 disabled fieldset、ARIA disabled、readonly 和不可编辑元素
- `click` 验证目标状态、导航或 DOM 变化；不能无条件报告成功
- `keyboard` 明确 key/code/modifiers/default 行为，限制为安全的键盘事件模型
- `scroll` 支持 window 与可滚动元素，并回读滚动位置
- 所有动作检查 snapshotId、pageVersion、元素仍存在且语义未发生变化

### 5.7 授权和用户界面

SDK 浮窗必须提供：

- 当前授权级别
- 升级/降级/撤销
- per-action 确认卡片
- 高风险动作详情
- 当前目标元素高亮
- 动作日志
- 执行中/成功/失败状态
- 用户停止入口

授权要求：

- 初始默认 `per_action`
- 宿主可指定初始级别或收紧范围，但不得静默提升权限
- 授权上下文按 server origin、真实 user identity、agentId、操作范围和版本隔离
- 不能继续使用 `anonymous` 作为最终 identity
- `full` 的持久化必须按真实身份隔离
- 用户已经选择：跨刷新持久化、完全授权允许所有可访问 DOM 操作、完全授权时敏感字段也可操作
- 仍需保留浏览器硬边界，授权不能绕过系统级能力

### 5.8 截图

需要决定并实现默认 renderer（或明确要求宿主传入 renderer，但产品文档必须清晰）。此外：

- 截图仅当前视口
- 永远排除 SDK host/Shadow DOM
- `per_action` 默认遮罩敏感内容；发送原图需确认
- `task` 按任务授权范围处理
- `full` 允许授权范围内未遮罩截图
- 截图不写入 localStorage、BroadcastChannel 或 URL
- 增加尺寸限制、超时和失败返回
- 接入 Agent 的 `page_screenshot`

### 5.9 批量动作和反馈

支持有序批量动作。SDK 每一步必须：

- 检查授权
- 检查快照和页面状态
- 执行动作并验证结果
- 记录日志和高亮
- 页面变化、导航、失败或需确认时停止后续动作
- 返回已执行步骤、中断原因和中间结果

## 6. 当前验证情况

最近已知验证：

### SDK

```bash
cd sdk/embed
npm run build
npm test
```

最近结果：构建成功，19 个测试文件、189 个测试通过。

### 后端

```bash
cd backend-ts
npm install
npm run build
```

此前多次构建成功；本轮修改后又启动了一次构建，交接时需要先确认其最终结果。构建命令可能需要等待较长时间。

定向 Vitest 命令曾因全局 coverage threshold 导致进程以非零退出，即使业务断言没有失败，不能将其称为通过：

```bash
npm test -- --run src/session/ws/streaming-ws-registry.spec.ts src/session/ws/streaming-ws-handler.spec.ts
```

不要使用不受 Vitest 支持的 `--runInBand`。

每次修改后至少执行：

```bash
git diff --check
cd backend-ts && npm run build
cd ../sdk/embed && npm run build && npm test
```

## 7. Code review 状态

之前已经产生多轮 review 文档，重要报告包括：

```text
docs/code-review/2026-09-08-code-review-02.md
docs/code-review/2026-09-08-code-review-03.md
docs/code-review/2026-09-08-code-review-04.md
docs/code-review/2026-09-08-code-review-05.md
docs/code-review/2026-09-08-code-review-06.md
docs/code-review/2026-09-08-code-review-07.md
```

最近有效报告明确指出：

- Agent → SDK → 浏览器 → 结果回传闭环未完成
- Embed 连接按 userId 广播，未隔离具体页面
- page result 仍曾与 LOCAL pending 串线
- `WsPageToolRequest` 导出和合同层级需复核
- per-action 没有确认 UI
- 截图授权/遮罩未接入
- task 生命周期和旧快照失效不完整
- SDK 页面实例可能分裂

后续必须：

1. 完成一阶段核心修复。
2. 只审查未提交代码，spawn reviewer，不要让 reviewer 改代码。
3. 读取 review 文档并修复重大问题。
4. 再次 reviewer。
5. 最多十轮，直到没有重大 bug。

## 8. 推荐执行顺序

1. 先确认 worktree 状态、当前后端 build 结果和最近改动。
2. 阅读 `create-app.ts`、`deps.ts`、handler 构造位置和 tool registry 模式。
3. 完成 `EmbedPageToolRegistry` 的注入、连接隔离、超时/取消/断开清理。
4. 完成 SDK controller 的 `page_tool_request` 分发，并统一页面 manager 实例。
5. 实现后端 page tools 并注册到允许 Embed 的 Agent 工具链。
6. 完成授权确认 UI、页面高亮、动作日志和停止任务。
7. 完成页面动作验证、导航失效、iframe/开放 Shadow DOM、受控组件适配。
8. 完成截图 renderer、遮罩、授权和限制。
9. 补协议、registry、SDK 页面执行、授权和 tool dispatcher 测试。
10. 更新 `README.md`/`DEPLOY.md`、`skills/mao-cli/` 和 `CHANGELOG.md`。
11. 运行完整验证和 review 循环。
12. review 无重大问题后，在 worktree 提交；切回主工作区合并；确认合并成功后移除 worktree。

## 9. 合并前检查清单

- [ ] Agent page tools 已注册且可被模型调用
- [ ] SDK 收到并执行 `page_tool_request`
- [ ] 结果回传使用 `page_tool_result`
- [ ] 未使用 LOCAL pending registry
- [ ] Embed 未加入 LOCAL capable client 集合
- [ ] 同用户多 tab 不会串请求
- [ ] session/request/connection 校验完成
- [ ] 超时、取消、断开清理完成
- [ ] per-action 确认 UI 完成
- [ ] task/full 生命周期符合约定
- [ ] 真实 user identity 接入授权隔离
- [ ] 截图授权、遮罩、SDK 排除完成
- [ ] 动作结果回读，不能伪成功
- [ ] 页面高亮、日志、停止入口完成
- [ ] SDK/backend/shared contracts 构建通过
- [ ] 相关测试通过
- [ ] `git diff --check` 通过
- [ ] code review 无重大问题
- [ ] 文档和 changelog 已更新
- [ ] 未部署、未推送，除非后续用户明确要求

## 10. 交接结论

当前代码是“协议和页面执行原型 + 部分后端桥接”，不是完整可用产品。下一位 agent 应优先完成真实的后端 Agent tool 调用链和 SDK WS 请求处理，再处理授权、反馈、截图和页面边界，不能仅凭现有公共 SDK API 宣称功能完成。
