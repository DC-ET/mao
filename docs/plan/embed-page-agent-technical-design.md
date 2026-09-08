# Web Embed SDK 页面操作 Agent 技术方案

> 状态：方案已确认，待实现
> 范围：`sdk/embed`、Embed WebSocket 链路、后端 Agent 页面工具、浏览器端页面执行器
> 接入目标：业务项目只增加 SDK 脚本和 `MaoChat.init()`，不修改业务按钮、表单、路由或业务回调。

## 1. 需求背景

当前 Web Embed SDK 已支持将 Mao Agent 嵌入业务页面，并提供页面 URL、标题、宿主 `context()` 和用户选中文本作为对话上下文。实现位于 `sdk/embed/src/`，核心入口为 `sdk/embed/src/index.ts`，上下文采集位于 `sdk/embed/src/context/`，通信采用 Embed WebSocket。

当前 SDK 能够让 Agent“了解用户提供的页面信息”，但不能主动读取页面 DOM、获取页面截图，也不能修改页面内容或触发页面交互。CLOUD 会话中的工具由服务端执行，服务端无法直接访问用户浏览器中的业务页面。

本需求将 SDK 从“嵌入式对话窗口”扩展为“浏览器页面操作执行器”：Agent 负责理解页面、选择观察方式、规划动作；SDK 负责在浏览器本地读取页面、截图、滚动、点击、填写和验证结果。

业务方不需要为按钮和表单增加专用 `data-*` 标记，也不需要实现 selector 映射或页面操作回调。

## 2. 产品目标

用户可以在嵌入式 Mao 对话中要求 Agent：

- 查看当前页面有哪些可操作元素；
- 获取当前可视区域截图，辅助理解视觉布局；
- 滚动页面并重新观察；
- 点击普通按钮、链接、标签和展开控件；
- 填写文本、数字、日期、文本域和可编辑内容；
- 选择下拉、单选和多选项；
- 使用键盘输入和按键；
- 观察动作后的页面变化；
- 在用户授权范围内完成连续或批量页面操作。

执行过程必须可解释、可中止、可验证。Agent 不直接获得 CSS selector 或任意 JavaScript 执行能力，只能使用 SDK 为当前页面快照生成的元素引用。

## 3. 明确范围

### 3.1 本期必须实现

1. 页面交互元素结构化快照。
2. 当前可视区域 DOM 截图。
3. SDK 排除自身 UI 的截图和页面扫描。
4. 页面操作双向 WebSocket 协议。
5. `inspect`、`screenshot`、`scroll`、`focus`、`fill`、`select`、`check`、`uncheck`、`click`、`keyboard`、`wait`、`observe` 动作。
6. 单动作和有序批量动作。
7. `snapshotId + elementId` 作用域内的 opaque 元素引用。
8. 动作前元素有效性检查和动作后结果验证。
9. 用户授权级别：每次确认、本次任务授权、完全授权。
10. 授权跨刷新持久化，按用户、站点 Origin、Agent、操作范围和授权版本隔离。
11. SDK 浮窗中的动作日志、目标元素高亮、执行状态、错误详情和停止任务入口。
12. Agent 主动请求页面快照、截图和页面变化信息；SDK 不主动将 DOM 变化推送给 Agent。
13. 当前标签页 SPA 路由和整页导航感知；导航后旧快照失效。
14. 主文档、同源 iframe、开放 Shadow DOM 的元素发现和操作。
15. 与 React/Vue 受控表单兼容的值写入和事件触发机制。

### 3.2 本期明确不做

1. 任意 JavaScript 执行。
2. 通过屏幕坐标进行点击或拖拽。
3. 整页拼接截图；截图只覆盖当前可视区域。
4. 自动操作新标签页、其他标签页或浏览器地址栏。
5. 跨域 iframe 内的 DOM 读取和操作。
6. 闭合 Shadow DOM 内的 DOM 读取和操作。
7. 文件选择器、文件上传、下载确认和系统级弹窗。
8. 验证码、人机验证和浏览器权限弹窗。
9. 绕过浏览器安全策略、CSP、同源策略或真实用户手势限制。
10. SDK 自身 Shadow DOM 和 UI 的读取、截图和操作。
11. 让业务方提供页面 selector、字段映射或操作回调作为接入前提。
12. SDK 将页面变化持续、自动推送给 Agent。
13. 将页面操作结果伪装成普通用户消息发送。
14. 通过授权绕过浏览器安全边界。

### 3.3 高风险操作边界

完全授权允许所有 SDK 可访问的 DOM 页面操作，包括提交类按钮，但不能突破本方案列出的浏览器和系统边界。

授权级别如下：

| 级别 | 行为 |
|---|---|
| `per_action` | 每个页面动作执行前要求用户确认。 |
| `task` | 用户授权后，本次 Agent 任务内按授权范围执行；任务结束、刷新、切换会话或撤销后失效。 |
| `full` | 用户明确授权后，当前会话及持久化授权范围内允许所有 SDK 可访问的 DOM 页面操作。 |

授权要求：

- 默认级别为 `per_action`；
- 宿主 `init` 可以指定初始级别或收紧动作范围，但不能静默替用户授予高权限；
- 用户可以在 SDK 浮窗中升级、降级和撤销授权；
- 授权策略写入浏览器存储时不保存 Token；
- 授权按 `serverUrl`、用户身份、Origin、`agentId`、操作范围和授权版本隔离；
- 高风险动作在 `per_action` 下必须逐次确认；
- `task` 和 `full` 下仍执行动作前的元素有效性检查、动作后验证和硬性禁止项拦截。

## 4. 用户交互流程

### 4.1 页面观察

```text
用户提出页面任务
  → Agent 请求 page_inspect
  → SDK 返回当前可见交互元素快照
  → Agent 判断信息是否足够
  → 必要时请求 page_screenshot
  → 必要时请求 page_scroll 后再次 inspect/screenshot
```

SDK 默认只采集当前可见区域的交互元素。Agent 需要更多内容时主动请求滚动、局部详情或截图。SDK 不在空闲状态持续上传 DOM。

### 4.2 页面操作

```text
Agent 生成单动作或有序动作批次
  → SDK 校验 snapshotId、elementId、元素状态和授权
  → SDK 展示动作反馈/请求用户确认
  → SDK 执行浏览器动作
  → SDK 等待页面同步和异步变化
  → SDK 验证结果
  → SDK 返回 page_action_result
  → Agent 决定下一步
```

批量动作不是无条件连续执行：每步都必须重新检查引用和权限；页面结构变化、动作失败、导航发生或进入需要确认的动作时，SDK 立即停止剩余动作并返回中间结果。

### 4.3 任务生命周期

- 关闭浮窗不停止当前页面任务；
- 用户点击停止、SDK `destroy()`、页面刷新或会话断开时停止任务；
- 不跨标签页恢复任务；
- 当前页面导航后旧快照全部失效，Agent 必须重新 `inspect`；
- SDK 通过动作结果返回页面版本变化，不主动向 Agent 推送变化事件。

## 5. 技术架构

```text
┌───────────────┐       Embed WebSocket        ┌────────────────┐
│ 后端 AgentLoop │ ◄──────────────────────────► │ sdk/embed      │
│ page_* 工具   │  page_tool_request/result    │ 页面执行器     │
└───────────────┘                              └───────┬────────┘
                                                       │
                                  DOM / iframe / Shadow DOM
                                                       │
                                               ┌───────▼────────┐
                                               │ 业务页面        │
                                               └────────────────┘
```

### 5.1 后端职责

- 注册 Embed 页面工具；
- 向 Agent 暴露工具 schema 和工具权限；
- 发送页面工具请求并等待 SDK 结果；
- 管理工具调用 ID、超时、取消和失败；
- 维护工具执行状态和审计信息；
- 不直接访问浏览器 DOM；
- 不把页面操作结果改写成普通用户消息。

### 5.2 SDK 职责

- 建立页面快照和 opaque 元素引用；
- 生成当前可视区域截图并排除 SDK UI；
- 执行页面动作；
- 校验授权、快照和元素生命周期；
- 触发兼容框架的 DOM 事件；
- 观察动作后的页面状态；
- 向用户显示动作和确认；
- 返回结构化成功、失败和变化结果。

## 6. 技术选型

### 6.1 页面快照

使用浏览器 DOM API 和可访问性语义构建结构化快照：

- 原生元素：`button`、`a`、`input`、`textarea`、`select`；
- 可编辑内容：`contenteditable`；
- ARIA 控件：`role=button/link/textbox/combobox/checkbox/radio/option/menuitem`；
- 标签来源：`label`、`aria-label`、`aria-labelledby`、`title`、`placeholder`、邻近文本；
- 状态：`visible`、`inViewport`、`disabled`、`readonly`、`required`、当前值和选项；
- 几何信息：当前视口中的坐标和尺寸；
- 表单归属：`formId`、`formName`、`action`、`method`。

默认不返回不可见元素、SDK 自身元素或不允许采集的字段。元素快照不向 Agent 暴露 CSS selector、XPath 或完整 `outerHTML`。

### 6.2 元素引用

每次快照生成：

```ts
interface PageSnapshot {
  snapshotId: string
  pageVersion: string
  url: string
  title: string
  viewport: ViewportInfo
  elements: PageElement[]
}

interface PageElement {
  elementId: string
  kind: 'button' | 'form-control' | 'link' | 'other'
  role: string
  type: string
  label: string
  text: string
  value: unknown
  options: PageOption[]
  visible: boolean
  inViewport: boolean
  disabled: boolean
  readonly: boolean
  required: boolean
  rect: Rect
}
```

SDK 内部保存 `snapshotId → elementId → Element` 映射。`elementId` 只在对应快照有效期内使用。页面路由、DOM 重建、关键属性变化或快照过期后，旧引用必须拒绝执行。

### 6.3 截图

首版使用浏览器端 DOM 截图方案生成当前可视区域截图。截图必须：

- 截取当前视口，不生成整页拼接图；
- 使用固定输出尺寸、格式和大小上限；
- 排除 SDK host 及 Shadow DOM；
- 支持截图前按授权级别进行敏感区域遮罩；
- 完全授权允许在授权范围内发送未遮罩截图；
- `per_action` 下发送原图必须显示确认；
- 不将图片写入 `localStorage` 或 BroadcastChannel；
- 失败时返回明确的截图错误，不阻断普通 DOM 观察。

### 6.4 页面通信协议

在现有 Embed WebSocket 上增加页面工具双向协议。工具请求必须包含调用 ID和页面会话标识：

```ts
interface PageToolRequest {
  type: 'page_tool_request'
  requestId: string
  sessionId: number
  tool: PageToolName
  snapshotId?: string
  actions?: PageAction[]
  requireConfirmation?: boolean
}

interface PageToolResult {
  type: 'page_tool_result'
  requestId: string
  success: boolean
  pageVersion: string
  snapshotId?: string
  result?: unknown
  stoppedAt?: number
  error?: {
    code: string
    message: string
    elementId?: string
  }
}
```

工具集合：

```text
page_inspect
page_screenshot
page_scroll
page_focus
page_fill
page_select
page_check
page_uncheck
page_click
page_keyboard
page_wait
page_observe
```

动作可单独传递，也可通过有序 `actions` 批量传递。每个需要元素的动作都绑定 `snapshotId` 和 `elementId`。

### 6.5 页面动作执行

- `fill` 使用目标元素原生 value setter，并触发 `input`、`change`、`blur`；
- 对 React/Vue 受控组件验证 DOM 值与页面状态是否同步；
- `select` 优先操作原生 `select`，对可识别 ARIA 组件执行语义动作；
- `check/uncheck` 验证 `checked` 或对应 ARIA 状态；
- `click` 只对快照中可见且可操作的元素执行，不使用坐标点击；
- `keyboard` 支持文本输入、普通按键和组合键，不执行任意脚本；
- `scroll` 只操作当前页面或可识别的同源可滚动容器；
- `wait` 有最大等待时限；
- `observe` 返回页面版本、URL、标题和结构化变化摘要。

### 6.6 页面变化

SDK 不主动将变化推送给 Agent。页面执行器可以使用本地 `MutationObserver`、URL 监听和短时等待来确定动作结果，但只在收到 Agent 的 `page_observe` 或下一次页面工具请求时返回结构化信息。

变化结果至少包含：

- URL、标题是否变化；
- 页面版本是否变化；
- 新增/移除/更新的交互元素数量；
- 目标元素值或状态是否变化；
- 是否出现可识别错误/成功提示；
- 是否发生导航或弹窗状态变化。

## 7. 授权与安全

### 7.1 页面数据

页面快照默认仅发送当前可见交互元素。密码、验证码、银行卡、支付信息及其他疑似敏感字段按授权规则处理：

- `per_action`：读取或写入前逐次确认；
- `task`：在本次任务授权范围内允许；
- `full`：在持久化授权范围内允许；
- 浏览器不可访问或系统级控件不因授权而可访问。

截图遵循相同授权模型。SDK UI 永远不进入截图和页面快照。

### 7.2 操作安全

- 不接受 Agent 提供的任意 selector、XPath 或脚本；
- 不允许操作快照之外的元素；
- 操作前验证引用、可见性、可操作性和页面版本；
- 操作后验证目标状态和页面变化；
- 工具请求具备超时、取消和 requestId 幂等处理；
- 页面导航后取消旧页面动作；
- 用户可随时停止当前任务；
- 授权策略变更、撤销和关键动作写入 SDK 事件与后端审计日志；
- Token 不进入页面快照、截图、授权存储、URL 或 BroadcastChannel。

## 8. 实现步骤

1. **梳理并固定现有 Embed 协议契约**：读取 `sdk/embed/src/core/ws-client.ts`、`controller.ts`、`core/store.ts` 与后端 `streaming-ws-handler.ts`，定义页面工具请求、结果、取消、错误和超时语义。
2. **新增共享协议类型**：扩展现有共享协议类型，加入页面工具请求、结果、快照、元素、动作和授权类型。
3. **实现页面扫描器**：新增页面交互元素采集模块，覆盖主文档、同源 iframe 和开放 Shadow DOM；排除 SDK host、不可见元素和禁采集字段。
4. **实现快照生命周期**：生成 `snapshotId/pageVersion/elementId`，保存运行时引用，处理导航、DOM 重建和快照失效。
5. **实现截图模块**：生成当前可视区域截图，排除 SDK UI，处理敏感区域遮罩、尺寸上限、跨域图片失败和结果编码。
6. **实现页面执行器**：实现滚动、聚焦、填写、选择、勾选、点击、键盘输入、等待和观察，并补齐 React/Vue 受控控件事件触发与校验。
7. **实现授权中心**：实现 `per_action/task/full`，持久化授权按 Origin、用户、Agent、范围和版本隔离，提供升级、降级、撤销和失效处理。
8. **实现 Embed WS 页面工具通道**：接收后端请求、执行单动作/批量动作、支持确认中断、超时、取消和结构化结果回传。
9. **实现后端 `page_*` 工具**：注册工具和 schema，接入 Agent 工具权限、工具调用状态、结果等待、取消、超时和审计。
10. **实现操作反馈 UI**：新增动作状态、目标元素高亮、确认卡片、执行日志、失败详情和停止入口；确保页面扫描和截图排除 SDK UI。
11. **接入导航和任务生命周期**：监听 URL/title/SPA 路由变化，失效旧快照；在刷新、销毁、断开和用户停止时取消页面任务。
12. **补充测试**：覆盖协议状态机、元素扫描、快照失效、截图排除、授权持久化、单步/批量执行、事件触发、导航取消和安全边界。
13. **更新文档和构建链路**：同步 Embed SDK 接入文档、后端工具说明、CSP/图片上传要求、授权说明和明确不支持清单；按仓库规则更新根 `CHANGELOG.md`，并同步 `skills/mao-cli/`。

## 9. 落地清单

### 9.1 SDK 新增模块

```text
sdk/embed/src/page/
├── page-scanner.ts              # 主文档/同源 iframe/开放 Shadow DOM 扫描
├── snapshot-manager.ts          # snapshotId、pageVersion、elementId 生命周期
├── page-executor.ts             # 页面动作执行和结果校验
├── visibility.ts                # 可见性、遮挡、可编辑状态判断
├── framework-events.ts          # React/Vue/原生控件事件触发
├── screenshot.ts                # 当前视口截图和 SDK UI 排除
├── authorization.ts             # 授权级别、持久化、撤销和失效
├── page-tool-client.ts          # WS 页面工具请求/结果/取消
└── page-types.ts                # SDK 页面能力类型
```

### 9.2 SDK UI 修改

```text
sdk/embed/src/ui/
├── PageActionCard.vue           # 页面动作状态和执行日志
├── PageActionConfirm.vue        # 授权/高风险动作确认
├── PageElementHighlight.vue     # 页面目标元素高亮
└── ChatPanel.vue/RootApp.vue    # 页面任务状态、停止入口和授权入口
```

### 9.3 后端修改

```text
backend-ts/src/harness/
├── tool/impl/page-*.ts          # page_* 内置工具实现
├── tool/                         # 工具注册和 schema
├── ...                           # AgentLoop/ToolDispatcher 页面工具委托

backend-ts/src/session/ws/
├── streaming-ws-handler.ts      # Embed 页面工具请求和结果帧
├── streaming-ws-registry.ts     # 页面工具请求路由和连接生命周期
└── ...                           # 协议类型、超时和取消处理
```

后端页面工具必须只能在 `client=embed` 的页面会话中使用；桌面 LOCAL 工具链不复用页面 DOM 执行器。

### 9.4 测试清单

- 页面快照只返回可见交互元素；
- SDK host 不出现在快照和截图；
- 密码/验证码/敏感字段按授权级别处理；
- 元素引用在页面重渲染和导航后失效；
- 主文档、同源 iframe、开放 Shadow DOM 扫描；
- 跨域 iframe、闭合 Shadow DOM 被明确拒绝；
- 原生和 React/Vue 受控输入值正确更新；
- 下拉、单选、多选、checkbox 状态正确回写；
- 单动作和批量动作在中间失败时停止剩余动作；
- 高风险操作遵循三档授权；
- 授权跨刷新恢复且按用户/Origin/Agent 隔离；
- 用户停止、断开、刷新和导航能取消任务；
- 页面变化由 Agent 主动 `inspect/observe` 获取，不发生 SDK 主动推送；
- 页面截图只生成当前视口且不包含 SDK；
- WebSocket requestId 幂等、超时、取消和重连行为正确；
- Agent 只可使用 opaque elementId，不可注入 selector 或任意脚本。

## 10. 验收标准

1. 业务页面只引入 SDK 脚本并调用 `MaoChat.init()`，无需修改业务按钮、表单、路由或回调。
2. Agent 能主动获取当前可见交互元素快照，并获得稳定的当前快照元素引用。
3. Agent 能按需获取不包含 SDK UI 的当前可视区域截图。
4. Agent 能通过单动作或批量动作完成滚动、聚焦、填写、选择、勾选、键盘输入和点击。
5. 每个页面动作执行前均校验授权和元素引用，执行后均返回结果验证。
6. 页面结构变化或导航后，旧元素引用不能继续执行，Agent 能重新获取快照。
7. 页面操作期间用户能看到目标元素、动作日志、执行状态并能停止任务。
8. 默认每次确认；任务授权和完全授权可由用户明确授予，完全授权可跨刷新持久化。
9. SDK 不主动向 Agent 推送页面变化，Agent 可通过工具请求获取最新状态。
10. 同源 iframe 和开放 Shadow DOM 可操作；跨域 iframe、闭合 Shadow DOM、系统弹窗、文件选择器、验证码和其他标签页明确失败并返回原因。
11. 任何页面操作都不能通过 Agent 参数执行任意 JavaScript、任意 selector 或坐标点击。
12. 后端 Agent、Embed SDK 和协议测试全部通过；SDK 构建产物和接入文档同步更新。

## 11. 主要风险与应对

| 风险 | 应对 |
|---|---|
| 页面自定义组件缺少语义 | 优先使用 DOM/ARIA；无法可靠识别时返回不支持，不猜测操作。 |
| React/Vue 受控状态不同步 | 使用原生 setter、标准事件和结果回读；失败时停止并报告。 |
| 页面重渲染导致 elementId 失效 | 所有引用绑定 snapshotId/pageVersion，失效后强制重新观察。 |
| 截图体积和性能不可控 | 只截当前视口，限制尺寸/格式/大小，Agent 按需请求。 |
| 页面数据泄露 | 默认可见交互元素、授权控制、敏感遮罩、排除 SDK UI、不落盘截图。 |
| Agent 批量误操作 | 每步校验、变化即停、高风险动作确认、支持用户停止。 |
| 跨域和系统控件不可控 | 明确拒绝并返回可解释错误，不尝试绕过浏览器安全机制。 |
| 后端和浏览器状态不一致 | requestId、超时、取消、页面版本和结果验证共同对账。 |

## 12. 结论

该能力可以在当前 Embed SDK 基础上实现，但本质上不是增加一个表单 API，而是新增一条“后端 Agent 页面工具 → 浏览器 SDK 执行器 → 页面工具结果”的双向执行链路。

最核心的产品承诺是：

> 业务项目只需完成 SDK 初始化，Mao Agent 即可在授权范围内观察和操作普通可访问页面；页面交互由 SDK 在浏览器本地执行，Agent 不直接接触 DOM，也不能绕过浏览器安全边界。

方案以 Agent 主动观察、opaque 快照引用、单步/批量执行、动作后验证和可持久化授权为核心，既覆盖常见页面操作，也明确排除了普通 Web SDK 无法安全或可靠实现的浏览器边界。
