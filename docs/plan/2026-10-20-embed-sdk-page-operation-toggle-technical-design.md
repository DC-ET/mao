# Embed SDK 页面操作工具开关（init 可配置）技术方案

- 日期：2026-10-20
- 状态：待评审
- 范围：`sdk/embed`（新增 init 选项 + 禁用态行为）、`shared/contracts`（auth 帧字段 + 1 个错误码）、`backend-ts`（连接级页面能力标记 + 工具注入口径）。**存量已接入业务网站代码零改动**（默认开启）。

## 1. 需求背景

Web Embed SDK（`sdk/embed`，产物 `desktop/public/embed/mao-chat.js`）让外部 Web 系统「一个脚本 + 一次 `MaoChat.init()`」嵌入 Agent 浮窗，并默认具备页面操作能力：只要连接是以 `client=embed` 建立的，后端就会把 `page_inspect` / `page_click` / `page_fill` 等 13 个 `page_*` 工具注入该会话（`backend-ts/src/harness/core/harness-service.ts:346` → `filterPageTools`），Agent 可经后端下发、由 SDK 在用户浏览器本地执行 DOM 动作。

现实中有业务场景不希望 Agent 碰当前页面，例如：

- **纯咨询型嵌入**：只想要「就问当前页面内容聊几句」，不开放任何写操作；
- **敏感页面**：订单支付、权限管理、审计台账等页面，希望从能力层面排除误操作风险，而不是依赖用户每次点确认；
- **合规要求**：部分业务方安全评审要求「Agent 不得操作业务系统 UI」，需要接入方一个显式声明。

当前 SDK 无法满足：`MaoChatInitOptions` 中与页面相关的只有 `page.initialLevel`（初始授权级别）与 `page.screenshotRenderer`（`sdk/embed/src/types.ts:28-33`），授权模型最低档 `per_action` 仍允许滚动/等待等非变更动作，且 `page_inspect` / `page_screenshot` 随时可用（`sdk/embed/src/page/authorization.ts:225-237`）——没有任何入口能整体关掉页面操作。

**硬性约束：之前已经接入的业务网站代码不用改造。** 因此开关必须「缺省开启」：不传 `page`、或传 `page` 但不传新字段，行为与现在完全一致。

### 为什么不是其他方案

| 备选方案 | 结论 | 原因 |
|---|---|---|
| 只在 SDK 侧拒绝执行（后端照常注入工具） | 不作为主方案，仅作兜底 | Agent 工具列表与系统提示里仍有 `page_*`，模型会反复尝试并收到错误，浪费轮次；且 `prompt-engine.ts:475` 的 embed 提示段判定与工具集不一致 |
| 复用授权模型加一档 `off` | 不做 | 授权级别是「用户权限」语义，由用户在浮窗内掌控；宿主 init 级开关是「能力供给」语义，两者方向相反，混用会破坏「宿主不得静默授予/剥夺用户授权」的既定约束（`embed-sdk.md:61`） |
| 管理后台/服务端统一开关 | 本期不做 | 属运营侧管控，与「接入方自行决定」的诉求不同域；且会影响所有接入方，破坏零改动约束。后续如需要另立方案 |
| 按工具粒度开关（如只禁 click） | 本期不做 | 组合爆炸、提示词与文档复杂度陡增；on/off 已覆盖诉求 |

## 2. 需求描述

### 2.1 目标

1. **默认开启**：`MaoChat.init()` 不传页面开关时，页面操作工具与现在完全一致（存量接入零改动、零感知）。
2. **init 可关**：宿主初始化时传 `page: { enabled: false }`，即可整体关闭页面操作工具。
3. **关闭后端到端一致**：Agent 看不到 `page_*` 工具（后端不注入）；SDK 不执行任何页面动作、不读取 DOM；浮窗不展示授权入口、动作确认卡与动作日志；实例页面 API 返回明确的「已关闭」错误而非静默无操作。

### 2.2 功能边界（要做）

1. `MaoChatPageOptions` 新增 `enabled?: boolean`，缺省 `true`。
2. SDK 在 WS 鉴权首帧向服务端声明页面能力（`pageEnabled`）。
3. 后端按连接记录页面能力，会话构建上下文时对「页面能力关闭的 embed 连接」过滤掉全部 `page_*` 工具。
4. SDK 禁用态：不创建 PageEngine（避免任何 DOM/patch 副作用）；`page_tool_request` 到达时立即回传 `page_operation_disabled` 失败（旧后端兜底，不等后端超时——默认 180s，`embedPageToolTimeoutSeconds` 可配）。
5. 浮窗 UI 隐藏页面相关区块：授权下拉（`PageAuthSwitcher`）、动作确认/日志面板（`PageActionPanel`）、元素高亮（`PageHighlight`）。
6. 实例方法禁用态行为定义（见 §4.2.5 行为表）。
7. 契约、后端、SDK 三处同改 + 回归测试；文档（`skills/mao-cli/reference/embed-sdk.md`）与 CHANGELOG 同步。

### 2.3 明确不做

- **不动授权模型**：`per_action` / `task` / `full` 三档、持久化、确认卡机制原样保留；开启态行为逐位不变。
- **不关闭页面上下文注入**：`[页面上下文]`（url / title / 宿主 `context()` 返回值）与「用户选中文本」照常随消息发送。理由：它是全部接入方（含 admin 自家宿主）的基础对话能力，不属于「操作」；且开关语义必须最小化，避免宿主关一个开关意外丢掉上下文导致 Agent「失明」。宿主若不想提供业务数据，不传 `context()` 即可（url/title 为产品基线行为，本期不扩大战线）。
- **不做「只读模式」**：关掉后 Agent 既不能操作也看不到页面内容（无 inspect/截图）；需要「可看不可写」的宿主用默认开启 + `initialLevel: 'per_action'`（只读动作本就无需确认）。
- **不做服务端/管理后台侧开关、不做按工具粒度开关**（见 §1 备选表）。
- **不改桌面端 / admin / agent-cli / android**：admin 宿主不传 `page.enabled`，零改动。

## 3. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| API 形态 | `page.enabled?: boolean`（聚在既有 `page` 选项内） | 页面配置已有归属；缺省开启天然兼容存量；与 `page.initialLevel` 的「宿主只能收紧不能提权」同向 |
| 生效链路 | **端到端**：SDK auth 帧声明 → 后端连接级标记 → `buildContext` 工具过滤 | Agent 侧完全无感（工具不存在），不浪费轮次；`prompt-engine.ts:475` 的 embed 提示段按工具集判定，自动一致，无需改提示词 |
| 能力声明载体 | WS 鉴权首帧 `{ type:'auth', token, client:'embed', pageEnabled }`（`shared/contracts/src/ws.ts:15-19`） | 首帧已是连接级事实的来源（client 类型即如此）；随重连自动重发，无需新增消息类型 |
| 禁用态 PageEngine | **不创建**（`pageEngine: PageEngine \| null`） | `PageSnapshotManager` 构造即 monkey-patch `history.pushState/replaceState` 并挂 3 个 window 监听（`sdk/embed/src/page/snapshot-manager.ts:66-71`）——「创建但禁用」也会动宿主页面，不可接受 |
| 旧后端兜底 | SDK 收到 `page_tool_request` 即回 `page_operation_disabled` 失败 | 新 SDK + 旧后端部署窗口期内行为安全（fail 掉而非执行 DOM） |

## 4. 详细设计

### 4.1 总体链路

```
宿主 init({ page: { enabled: false } })
  → SDK: pageEnabled=false，不创建 PageEngine，隐藏页面 UI
  → SDK auth 帧: { type:'auth', token, client:'embed', pageEnabled:false }
  → 后端 register(): 连接级记录 pageEnabled=false（缺省 true）
  → subscribe 绑定 embed 会话时，绑定关系指向该连接
  → HarnessService.buildContext(): filterPageTools(tools, isEmbedPageSession(sid))
      → 该连接的会话剔除全部 page_* 工具 → Agent 工具列表/提示词均无页面能力
  →（兜底）万一仍收到 page_tool_request：SDK 立即回传 page_operation_disabled
```

涉及文件：

| 端 | 文件 | 改动 |
|---|---|---|
| SDK | `sdk/embed/src/types.ts` | `MaoChatPageOptions.enabled` |
| SDK | `sdk/embed/src/controller.ts` | pageEnabled 计算、引擎条件创建、调用点守卫、禁用短路、UI 状态 |
| SDK | `sdk/embed/src/core/ws-client.ts` | auth 帧携带 pageEnabled |
| SDK | `sdk/embed/src/index.ts` | 实例方法禁用态行为 |
| SDK | `sdk/embed/src/ui/{RootApp,ChatPanel,Composer}.vue` | 条件渲染 + `pageEnabled` prop 下发链 |
| 契约 | `shared/contracts/src/ws.ts` | `WsAuthFrame.pageEnabled?`、`PageToolErrorCode` 增 `'page_operation_disabled'` |
| 后端 | `backend-ts/src/session/ws/streaming-ws-registry.ts` | 连接级 pageEnabled + `isEmbedPageSession` |
| 后端 | `backend-ts/src/session/ws/streaming-ws-handler.ts` | auth 帧解析透传 |
| 后端 | `backend-ts/src/harness/embed-page-tool-registry.ts` | request 禁用防御 |
| 后端 | `backend-ts/src/harness/core/harness-service.ts`、`src/create-app.ts` | 过滤口径切换 + 接线 |
| SDK | `sdk/embed/demo/main.ts` | 开关控件，供手动验证两态 |

### 4.2 SDK 侧（sdk/embed）

#### 4.2.1 选项（types.ts）

```ts
export interface MaoChatPageOptions {
  /**
   * 是否允许 Agent 操作当前页面；缺省 true。
   * false 时：Agent 不会获得 page_* 工具，SDK 不执行任何页面动作，
   * 浮窗不展示授权/确认/日志 UI，实例页面 API 返回 page_operation_disabled。
   * 与 initialLevel 并传时后者被忽略（禁用态无授权语义）。
   */
  enabled?: boolean;
  initialLevel?: PageAuthorizationLevel;
  screenshotRenderer?: ScreenshotRenderer;
}
```

统一判定helper（导出供 controller 与测试用）：`isPageEnabled(options: MaoChatInitOptions): boolean { return options.page?.enabled !== false; }`——`undefined`、`true`、缺省 `page` 均为开启；只有显式 `false` 关闭。

#### 4.2.2 控制器（controller.ts）

1. `createUiState()`（controller.ts:110）新增 `pageEnabled: isPageEnabled(options)`；`UiState` 接口同步加字段。`pageAuthorization` 初始值在禁用态固定 `'per_action'`（不读 `initialLevel`，禁用态无授权语义）。
2. `pageEngine` 声明改为 `readonly pageEngine: PageEngine | null`（controller.ts:241），构造末尾（controller.ts:345-370）改为：

```ts
this.pageEngine = pageEnabled ? new PageEngine({ ...现有 hooks }) : null;
if (this.pageEngine && options.page?.initialLevel) this.pageEngine.setInitialLevel(options.page.initialLevel);
```

3. `WsClient` hooks 增加 `getPageEnabled: () => boolean`（或构造期布尔，二选一——推荐 hook，与 `identity` 等同构，便于将来动态化）。**hook 设为可选字段**，读取处 `this.hooks.getPageEnabled?.() ?? true`：`ws-client.spec.ts` 直接 `new WsClient(...)` 构造的用例（`makeHooks()`）无需同步补 hooks。
4. 全部 `this.pageEngine.xxx` 调用点补空守卫。现状 18 处引用中 :335、:429 已有守卫；需补守卫的位置：:370 `setInitialLevel`、:388 `endTask`、:450 `cancel`、:704 `abortInFlight`、:788 `cancel`、:844 `cancel`、:934 `destroy`、:1002 `prepareNewTask`、:1114 `cancel`、:1156 `setHostLevel`、:1161 `setLevel`、:1165 `resolveConfirmation`。模式统一为先判空再调用（这些路径在禁用态下均无可执行语义：UI 已隐藏、无任务态可同步）。
5. `handlePageToolRequest`（controller.ts:1169）禁用短路：`!this.pageEngine` 时直接回包并 return：

```ts
await this.ws.sendPageToolResult(sessionId, requestId, {
  success: false, error: { code: 'page_operation_disabled', message: '宿主已关闭页面操作能力' },
});
```

（置于缓存查询与 inFlight 判定之前；禁用态不存在幂等缓存与并发执行问题。）
6. `onWsEvent` 的 `page_tool_cancel` 分支（controller.ts:702-705）加判空——禁用态收到也无需动作。

#### 4.2.3 WS 客户端（core/ws-client.ts）

鉴权首帧（ws-client.ts:160）改为：

```ts
socket.send(JSON.stringify({ type: 'auth', token, client: 'embed', pageEnabled: this.hooks.getPageEnabled() }));
```

`auth_refresh` 帧不带该字段（连接级事实在 register 时已定格，刷新不改变能力声明）。

#### 4.2.4 UI（ui/）

RootApp → ChatPanel → Composer 是逐 prop 传递（不传整个 `ui` 对象），开关必须一路显式下发：

- `RootApp.vue`：给 ChatPanel 增绑 `:page-enabled="ui.pageEnabled"`；`<PageHighlight>`（:55）包 `v-if="ui.pageEnabled"`（target 禁用态恒 null，双保险）。
- `ChatPanel.vue`：props 增 `pageEnabled: boolean`；`<PageActionPanel>`（:192）包 `v-if="pageEnabled"`，并把 `pageEnabled` 继续传给 Composer。
- `Composer.vue`：props 增 `pageEnabled: boolean`；`<PageAuthSwitcher>`（:190）包 `v-if="pageEnabled"`。
- `pageAuthorization` prop 链禁用态固定 `'per_action'`（由 `createUiState` 写死，§4.2.2.1），不展示即无交互；`authEl` 引用点均为可选链（`authEl.value?.close()` / `isOpen()`），禁用态无 NPE。
- `RootApp.vue:35` `attention` 计算含 `pageConfirm`：禁用态恒 null，无需改。
- 现状核对：`PageActionPanel` 自带 `visible`（confirm 与 logs 均空即不渲染）、`PageHighlight` 自带 `v-if="target"`，禁用态本就不可见，两处 v-if 属双保险；`PageAuthSwitcher` 是无条件渲染的徽标按钮，必须 v-if。

#### 4.2.5 实例方法禁用态行为（index.ts:60-81）

| 方法 | 禁用态行为 |
|---|---|
| `inspectPage()` | 抛 `Error('页面操作已关闭（init page.enabled=false）')`——宿主主动关闭又主动调用属编程错误，静默返回空快照会被误读为「页面无元素」 |
| `executePageAction(action, snapshotId?)` | resolve `{ success:false, action, pageVersion:'', error:{ code:'page_operation_disabled', message:'宿主已关闭页面操作能力' } }`（返回类型本身就是结果对象，不抛） |
| `capturePageScreenshot(opts?)` | reject 同上错误 |
| `getPageAuthorization()` | 返回 `'per_action'`（类型不变；禁用态无授权语义。实现可取 `ui.pageAuthorization`，禁用态恒为该值） |
| `setPageAuthorization(level)` | no-op（不抛，避免打断宿主调用链） |
| 其余（open/close/newSession/…） | 不受影响 |

### 4.3 契约（shared/contracts/src/ws.ts）

```ts
export interface WsAuthFrame {
  type: 'auth';
  token: string;
  client: WsClientType;
  /** 页面操作能力声明；缺省 true（旧版 SDK 不发送该字段） */
  pageEnabled?: boolean;
}
```

`PageToolErrorCode`（ws.ts:99）增加 `'page_operation_disabled'`。两端消费：SDK 回包、后端工具原样透传给模型（`PageToolError.code` 本就是 `PageToolErrorCode | string`，不加也不会类型报错；加入求穷尽与自文档）。

### 4.4 后端（backend-ts）

#### 4.4.1 连接级能力标记（streaming-ws-registry.ts）

- `register(session, userId, clientType, metadata)`（registry.ts:133）新增第 5 参 `pageEnabled: boolean = true`，存入 `sessionPageEnabled: Map<string /* socket.id */, boolean>`；`unregister` 处随连接清理。
- 新增 `getPageEnabled(session: WsSocket): boolean`（缺省 true，防御 map 未命中）。
- 新增：

```ts
/** embed 会话且页面能力开启：HarnessService 工具过滤的唯一口径。 */
isEmbedPageSession(sessionId: number): boolean {
  const socket = this.getEmbedSessionConnection(sessionId);
  return socket != null && this.getPageEnabled(socket);
}
```

- `isEmbedSession`（registry.ts:368）语义不变（绑定即真），继续服务 `EmbedPageToolRegistry` 的通道判断与 `hasBoundConnection`。

#### 4.4.2 auth 帧解析（streaming-ws-handler.ts）

handler.ts:371-372：

```ts
const clientType = this.normalizeClient(typeof root.client === 'string' ? root.client : undefined);
const pageEnabled = typeof root.pageEnabled === 'boolean' ? root.pageEnabled : true;
this.deps.registry.register(session, metadata.userId, clientType, metadata, pageEnabled);
```

#### 4.4.3 工具过滤口径（harness-service.ts / create-app.ts）

harness-service.ts:346 改为：

```ts
sessionTools = HarnessService.filterPageTools(sessionTools, this.embedSessionLookup?.isEmbedPageSession(sessionId) === true);
```

`filterPageTools` 静态方法（harness-service.ts:597-599）不动。`create-app.ts:1568` 处 `embedSessionLookup` 内联对象增加 `isEmbedPageSession: (sid) => embedPageToolRegistry.isEmbedPageSession(sid)`；`EmbedPageToolRegistry` 新增同名委托方法（内部走 `registry.isEmbedPageSession`）。`HarnessService` 依赖接口（harness-service.ts:76）同步加该可选方法。

`prompt-engine.ts` 无需改动：`isEmbedPageAgent` 按工具集判定（prompt-engine.ts:475-477），工具被过滤后 embed 提示段自动不注入，与现状口径一致。

#### 4.4.4 兜底防御（embed-page-tool-registry.ts）

`request()`（embed-page-tool-registry.ts:66）在 `isEmbedSession` 通过后、取连接前增加：

```ts
if (!this.registry.isEmbedPageSession(sessionId)) {
  return errorResult('page_operation_disabled', '宿主已关闭页面操作能力');
}
```

覆盖两类竞态：连接换绑到「已关闭」连接的在途请求、新旧后端版本交错。错误经 `PageToolBase.call` 原样 JSON 透传给模型（page-tools.ts:57-70），模型读到可解释错误后自行调整。

### 4.5 兼容性矩阵

| SDK \ 后端 | 新后端 | 旧后端（无 pageEnabled 解析） |
|---|---|---|
| 旧 SDK（已部署） | auth 帧无字段 → 默认开启 → **与现状逐位一致** | 不变 |
| 新 SDK，不传 enabled | 开启 → 与现状一致 | 不变 |
| 新 SDK，`page.enabled:false` | 工具不注入 + SDK 禁用态（目标形态） | 后端照常注入并下发；SDK 立即回 `page_operation_disabled`，**不执行任何 DOM 动作**（安全兜底成立，Agent 侧表现为工具全部失败） |

### 4.6 边界与竞态

1. **会话中途声明变化**（用户改代码刷新、或多标签页声明不一致）：flag 随每次 auth 帧重发；`buildContext` 每轮重建工具集，下一轮生效。开启→关闭：在途页面请求因连接换绑被 `failSession` 失败（现有机制，streaming-ws-handler.ts:421-428）；关闭→开启：旧授权仍在 localStorage（按身份/Origin/agent 隔离），恢复开启后继续有效——符合「用户授权不因宿主配置丢失」。
2. **多标签页同会话**：subscribe 换绑时后绑定连接的 flag 生效；旧连接在途请求照旧失败。无跨连接 flag 投票机制（绑定即单点权威）。
3. **断线重连**：flag 随新连接 auth 帧重发，无持久化到会话/DB，不引入迁移。
4. **fail-closed 方向**：任何不确定（字段缺失于旧 SDK 除外——那按开启处理以保兼容）都向「关闭」收敛：连接非 OPEN/未鉴权时 `isEmbedPageSession` 即 false（复用 `getEmbedSessionConnection` 现有校验）。
5. **页面上下文不受开关影响**（见 §2.3），历史消息回显、选中文本、附件上传链路零改动。

## 5. 测试计划

### SDK（sdk/embed，vitest）

- `page.enabled` 缺省/`true`：auth 帧 `pageEnabled: true`；既有 spec 除下述一处精确断言外回归绿（行为不变是硬约束）——`core/ws-client.spec.ts:127` 的首帧 `toEqual({ type: 'auth', token: 'tok', client: 'embed' })` 需补 `pageEnabled: true`（若实现时改为「开启则不发送该字段、缺省即开启」，该断言可原样不动；两种口径二选一，定稿后同步此处）。
- `page.enabled: false`：
  - auth 帧携带 `pageEnabled: false`；
  - PageEngine 未创建（`window.__maoChatInstance` 对应 controller 的 pageEngine 为 null；`history.pushState` 未被 patch——可用 spy 断言）；
  - 模拟服务端下发 `page_tool_request` → 回传 `page_tool_result` 且 `error.code === 'page_operation_disabled'`，DOM 无任何变化（spy scanner/executor 未调用）；
  - 实例方法按 §4.2.5 行为表逐项断言（inspectPage 抛错、executePageAction 返回 disabled、capturePageScreenshot reject、getPageAuthorization 为 per_action、setPageAuthorization no-op）；
  - UI：RootApp 渲染快照中无 PageAuthSwitcher / PageActionPanel / PageHighlight（现有 ChatPanel.spec / RootApp 相关 spec 扩例）。
- `page: { initialLevel: 'task' }`（无 enabled）：既有初始授权 spec 回归。

### 后端（backend-ts，vitest）

- registry：register 带/不带 `pageEnabled` → `getPageEnabled` / `isEmbedPageSession` 正确；连接非 OPEN → false；unregister 清理。
- handler：auth 帧 `pageEnabled:false` 透传；缺省/非布尔按 true。`streaming-ws-handler.spec.ts:688` 的 `expect(registry.register).toHaveBeenCalledWith(connected, 7, 'electron', authMetadata)` 四参精确断言需同步补第 5 参 `true`。
- EmbedPageToolRegistry：embed + disabled 会话 `request()` 返回 `page_operation_disabled` 且 `sendPageToolRequest` 未被调用。
- harness-service：`filterPageTools(tools, false)` 剔除全部 `page_*`（静态方法扩例）；`buildContext` 路径 mock `embedSessionLookup.isEmbedPageSession=false` → `context.tools` 无 `page_*`、无 embed 提示段。
- Playwright E2E 不新增（CI 不跑；手动验证即可）。

### 手动验证清单

1. demo（sdk/embed/demo）加开关跑通两态；
2. 新后端 + 旧产物（禁用开关不生效但无报错）；
3. admin 浮窗不传开关，行为不变。

## 6. 文档与发布

1. `skills/mao-cli/reference/embed-sdk.md`：接入示例补 `page: { enabled: false }` 及关闭后的行为边界（Agent 无 page_* 工具 / 实例 API / UI 变化 / 上下文仍注入）。
2. 根 `CHANGELOG.md` 新增版本小节（用户可见功能）：`sdk/embed` 版本号 bump（0.2.0 → 0.3.0）；`desktop/package.json` 用 `./scripts/changelog-extract.sh sync-desktop` 同步，勿手改。
3. SDK 产物重新构建并提交：`cd sdk/embed && npm run build` 后提交 `desktop/public/embed/mao-chat.js` 与按新版本号命名的 `mao-chat.v0.3.0.js`（产物入 git 是既定约定，见 embed-sdk.md「开发与发布」；只改源码不提交产物，线上 `/embed/` 仍是旧包）。
4. 部署顺序：**先 backend-ts，再 desktop**（新后端兼容旧 SDK；反序时新 SDK 禁用态有 §4.4.4 兜底，同样安全）。
5. 无 DB 迁移、无新增环境变量。

## 7. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 误传 `page.enabled: false` 导致 Agent 无页面能力 | 宿主侧功能缺失 | 文档显式声明缺省即开启；关闭是显式动作 |
| 新旧版本交错窗口 | 已分析（§4.5）：安全方向均正确 | 先部后端 |
| flag 每轮重建工具集带来提示词缓存失效 | 仅禁用态会话；CLOUD 提示词按会话动态构建，无额外成本 | 无需处理 |
| controller 判空遗漏导致禁用态 NPE | 功能缺陷 | §4.2.2 已列全 12 处；单测覆盖禁用态主要路径（发消息/切会话/停止/销毁/重连） |

回滚：后端回滚即恢复「embed 即开放」；SDK 产物回滚到上一版文件即可，无数据/迁移残留。
