# 静默失败可见化技术方案：加载失败可重试、断线有终态、复制有反馈、编辑态图片可见

- 状态：已实施（2026-11-07；原提案三个开放决策已在本文 §8 全部定案，无遗留待定项。实施后经 3 轮 code review 收敛：round1 修 B1 乐观图片回落 / B2 错误态竞态 / B3 indexError 过期门，round2 修 B2 守卫语义回归，round3 无 bug。报告见 docs/code-review/）
- 日期：2026-11-07
- 需求来源：`docs/proposals/2026-11-06-silent-failure-visibility.md`（提案，含逐项代码证据；本文在其基础上完成定案与四处勘误，见 §3.2）
- 规模：小（纯桌面端状态与 UI，约 250 行改动 + 测试；**零数据库迁移、零后端改动**，不碰任何接口、WS 帧、错误码与执行语义）
- 关联：`desktop/src/composables/useChat.ts`、`desktop/src/composables/useStreamWS.ts`、`desktop/src/views/task/TaskView.vue`、`desktop/src/components/task/TaskIndexPanel.vue`、`desktop/src/components/chat/{ChatPanel,MessageBubble,ChatRoundList}.vue`、`desktop/src/components/common/ConnectionBanner.vue`、`desktop/src/components/chat/{FileReferencePanel,ChatInput}.vue`

## 1. 需求背景

主链路「能转」的部分（发送 / 排队 / 编辑 / 点踩 / 定位 / 全局搜索）完成度很高，缺口集中在「做完之后」——失败和中间态被一串静默 catch 吞掉，用户看到的是假象。四组断点（行号均按当前源码核验）：

1. **历史加载失败 → 「空会话」假象且无重试入口**：`useChat.ts:254-256` `fetchMessages` 的 catch 只有一行注释 `// session might not exist yet`；`useChat.ts:281-282` `loadOlderMessages` 的 catch 直接 `return false`；`TaskView.vue:1334-1336` `loadSession` catch 之后**仍然照常 `setActiveSession(sid)`**。任务列表加载失败更隐蔽：`loadTaskIndex`（`TaskView.vue:1502-1517`）catch 里只置 `initialLoading=false` 并 `return false`，`onMounted` 的 `if (!await loadTaskIndex()) return`（:1596）提前返回，而 `isNewTaskMode` computed 是 `!sessionIdParam && !initialLoading`（:166）——`initialLoading` 一落底，用户**静默掉进「新建任务」态**（中心态显示「今天想完成什么？」），以为历史丢了。
2. **断线没有出手点**：`useStreamWS.ts:452-460` `scheduleReconnect` 退避翻倍至 30s 封顶，**无最大次数、无失败终态**；鉴权被拒只 `console.warn`（:309-313）。断线横幅 `ConnectionBanner.vue` 只有一句「连接已断开，正在自动重连…重连期间发送的消息将在恢复后继续处理」，无任何按钮——后端长时间挂掉时用户对着同一句话刷屏半小时。
3. **复制失败完全静默**：`MessageBubble.vue:799-808` `copyMessage` 的 `if (!ok) return`——`clipboard.ts` 的 `navigator.clipboard` 与 `execCommand` 双路都失败时（http://IP:端口 访问、权限被拒）用户什么都看不到，以为复制成功了，粘贴发现是旧内容。同项目 `ExecutionErrorBanner.vue:57-66` 复制会话 ID 失败是有 `ElMessage.error` 的正确范本。
4. **编辑态图片与 @面板小断点**：编辑态下原消息图片完全不展示（`MessageBubble.vue:44` 的 `&& !isEditing`），确认后 `ChatPanel.confirmEdit`（:651-656）不传 images、`editAndResend` 走「未显式传图保留原图」回落（`useChat.ts:712`）原样重发，用户无法感知也无法去掉某张图。@面板 `FileReferencePanel.vue`：`files.length === 0 && filter` 时落入 `v-else` 分支只渲染组标题「文件」，看起来像坏了而不是没找到；`ChatInput.vue:545-547` `fetchWorkspaceFiles` 的 catch 把 `workspaceFiles` 置空数组静默吞掉。

为什么性价比高：全部是「已有状态的可见性」——错误对象就在 catch 里、重连次数就在调度器里、原图就在 `message.images` 里；复制失败 toast 有现成范本照抄；零后端改动。

## 2. 需求描述

### 2.1 目标（全部要做）

| # | 优先级 | 目标 | 一句话验收 |
|---|---|---|---|
| 1 | P1 | 历史加载失败可见且可重试：`fetchMessages` 失败 → 消息区空态渲染「历史消息加载失败 · [重试]」；`loadOlderMessages` 失败 → 列表顶部重试小条；`loadTaskIndex` 失败 → 任务面板错误条 + 中央错误卡（含显式「仍要新建任务」出口），并门住 `isNewTaskMode` 不再静默进入新建态 | 网络抖动后用户看到的是「加载失败」而不是「空会话 / 新建任务」 |
| 2 | P1 | 断线有终态有出手点：连续重连失败 ≥3 次或鉴权被拒时，横幅升级为「重连失败，网络或服务端异常 · [立即重试] [重新加载页面]」；任一次连接成功立即恢复原文案 | 后端挂掉时用户有两个明确的出手按钮 |
| 3 | P1 | 消息复制失败补 error toast（与 `ExecutionErrorBanner` 同口径） | 双路剪贴板都失败时用户立刻知道 |
| 4 | P2 | 编辑态图片可见可删：编辑态渲染原图缩略 + 移除按钮（tooltip 标注仅影响本次重发）；确认后按剩余图片重发 | 编辑时能看见并去掉不想重发的图 |
| 5 | P2 | @面板空态与失败可见：有 filter 无结果显示「未找到匹配的文件」；拉取失败显示「文件列表加载失败 · [重试]」 | 面板不再「看起来坏了」 |

### 2.2 非目标（明确不做，理由见 §9）

- 不做「流式输出中复制半成品」（需拆 `MessageBubble` 的 `!isAssistantRunning` 门禁，改变流式态操作栏行为面）。
- 不做「主聊天历史锚定条 / 回到最新 / 加载更早指示」（涉及与跟随输出的优先级关系，单独立项）。
- 不做「队列清空 / 键盘排序 / 截断全文」（队列状态机扩展）。
- 不做「重新生成」（需后端按 messageId 回滚重放语义，另立专项）。
- 不做会话内查找 / Markdown 导出（2026-11-02 已否决）。
- 不改后端错误码、错误结构、WS 帧；不改任务列表 / 消息分页的加载策略与返回值语义（`loadOlderMessages` 仍返回 boolean）。

## 3. 技术选型与决策

### 3.1 决策表（全部定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 重连终态阈值 | **连续失败 ≥3 次**升级终态（对应退避前三次窗口，约 7 秒）；**鉴权被拒（`isAuthRejection`）即时升级**；任一次连接成功（`connected` 置真处）归零并恢复原文案；手动重试先归零再连 | 3 次对齐提案风险表口径（短暂抖动不误报）；鉴权失败每轮都会重读 token 自动重试但大概率继续失败，即时提示最诚实 |
| D2 | 编辑态移除图片是否二次确认 | **不确认**。单条移除可随时「取消编辑」整体退回；移除按钮 tooltip 标注「仅本次重发不携带此图，历史消息不受影响」 | 误触成本 = 取消编辑重来，远低于加二次确认的交互噪音（对齐提案 §8.2 倾向） |
| D3 | 错误条文案粒度 | **统一收敛为固定中文文案，不透后端原始 message**：历史「历史消息加载失败」+ 副句「网络异常，请检查连接后重试」；更早消息「加载更早消息失败，点击重试」；任务索引「任务列表加载失败」；@面板「文件列表加载失败」 | catch 到的可能是英文 Error/堆栈（拦截器把业务 message 包成 `Error.message`），透传会把内部信息甩给用户；固定文案 + 重试按钮已满足「知道失败了 + 有出手点」 |
| D4 | 哪些失败算「加载失败」 | **业务拒绝保持静默**：拦截器包装的业务错误带 `code` 字段（`api/index.ts:69-75`，含「会话尚未落库」这类 `fetchMessages` catch 原注释保护的场景，且拦截器已 toast），维持既有行为不置错误态；**仅无 `code` 的网络 / HTTP 层失败**（断网、5xx、超时）置错误态 | 不做这个区分，「新建会话尚未落库就拉历史」会弹假错误；这是提案没考虑到的关键分支（勘误 3） |
| D5 | `editAndResend` 的 images 语义 | 第三参改三态：`undefined`（未传）= 沿用原消息图片（向后兼容）；**数组（含空数组）= 显式指定本次重发的图片集合**。内部 `imagesToSend = images === undefined ? (lastUserMsg.images ?? []) : images` | 现签名 `images.length > 0 ? images : 原图`（:712）下「移除全部图片」无法表达——传 `[]` 会被回落吞掉照发原图（勘误 2）。唯一调用点 ChatPanel.confirmEdit 同步更新 |
| D6 | `indexError` 门与出口 | 门：`isNewTaskMode` 追加 `&& !indexError.value`；失败时**中央错误卡**渲染「任务列表加载失败 · [重试] [仍要新建任务]」——重试成功即清门并继续 `resolveInitialRoute()`，「仍要新建任务」是用户显式动作，点击即清门进 `enterNewTaskMode()`；`!getToken()` 分支（:1503-1507）**不置错**（未登录态由登录重定向处理，不是加载失败） | 只关门不出口会把「想直接建新任务」的用户也堵死；显式点击后进入不算「静默掉入」 |
| D7 | 错误态生命周期 | 错误对象按 `sessionId` 记（`{ sessionId }` 形状），暴露给组件的 computed 与当前 `sessionId` 比对后判定；加载成功**无条件清空**；不做显式清理定时器 | 与 `switchingSession`/`initialLoading` 状态机零耦合（提案风险 1 的对策），切会话旧错误自动失活 |
| D8 | `olderError` 记录位置 | 记在 **`useChat.loadOlderMessages` 的 catch**（错误发生地），`useChatScroll.ts` **零改动**（它只消费 Promise，`.then` 行为不变） | 提案 §4.1 写「useChatScroll 的 loadOlder 失败时置 olderError」位置有误——catch 在 useChat（勘误 1） |

### 3.2 对提案的四处勘误（已按源码修正，随本方案落定）

1. **`olderError` 的归属文件**：`loadOlderMessages` 的 catch 在 `useChat.ts:281-282`，`useChatScroll.ts:266-272` 只消费 `options.loadOlder()` 的 Promise（`!loaded` 直接 return）。错误态记在 useChat，`useChatScroll` 不改。
2. **「移除全部图片」在现签名下无法表达**：`editAndResend` 现回落逻辑 `images.length > 0 ? images : 原图`（`useChat.ts:712`），传 `[]` 照发原图。提案「只差传剩下的图」对「删光图片」场景不成立，需 D5 的三态语义。
3. **`fetchMessages` 的静默语义必须保留一个分支**：原 catch 注释 `// session might not exist yet`（:255）——新建会话在首条消息落库前拉历史会 404/业务拒绝，这是既有依赖行为。错误态只对网络 / HTTP 层失败生效（D4 谓词），否则新会话首屏会弹假错误。
4. **断线横幅的真实路径**：`ConnectionBanner.vue` 在 `desktop/src/components/common/`（`Layout.vue:4` 挂载），不是提案写的 `components/chat/`；且它直接 `useStreamWS()` 解构 `connected, everConnected`（:9-13），`reconnectFailed`/`manualReconnect` 走同一通道暴露即可。

## 4. 实现步骤

### 步骤 1：useChat 错误态 + `editAndResend` 三态 images（P1-1 / P2-4）

1. `useChat.ts` 新增模块内状态：`historyLoadError = ref<{ sessionId: string } | null>(null)`、`olderLoadError = ref<{ sessionId: string } | null>(null)`。
2. `fetchMessages`（:225-257）catch 改为：`const code = (e as { code?: number } | null)?.code; if (code == null) historyLoadError.value = { sessionId: sid };`（业务拒绝静默，D4）；成功路径（`api.get` 返回后）开头无条件 `historyLoadError.value = null`。
3. `loadOlderMessages`（:259-286）catch 改为：同样按 D4 谓词置 `olderLoadError.value = { sessionId: sid }`，仍 `return false`；成功开头清 `olderLoadError.value = null`。
4. 新增并暴露 `retryHistoryLoad()`：`historyLoadError.value = null; await fetchMessages({ forceLatest: true, sessionId: sessionId.value ?? undefined })`（forceLatest 绕过 history-anchored 门 ：228）。
5. `editAndResend`（:691）第三参改 `images?: string[] | null`，:712 改为 `const imagesToSend = images === undefined ? (lastUserMsg.images ?? []) : images`；函数注释说明三态语义。
6. useChat 返回对象追加：`historyLoadError`、`olderLoadError`、`retryHistoryLoad`。
7. 验证：`cd desktop && npm run build`（类型闭环）。

### 步骤 2：useStreamWS 重连终态（P1-2）

1. 模块级新增 `const consecutiveFailures = ref(0)`、`const authRejected = ref(false)`。
2. `scheduleReconnect`（:452-460）入口（`reconnectTimer` 已存在的早退之后）`consecutiveFailures.value += 1`。
3. `onclose` 鉴权分支（:309-313）追加 `authRejected.value = true`；连接成功置 `connected.value = true` 处追加 `consecutiveFailures.value = 0; authRejected.value = false;`。
4. 新增 `const reconnectFailed = computed(() => connected.value ? false : (authRejected.value || consecutiveFailures.value >= 3))`；新增 `manualReconnect()`：清 `reconnectTimer`、`reconnectDelay` 重置初值、`consecutiveFailures = 0`、`authRejected = false`、`void connect().catch(() => {})`。
5. useStreamWS 返回对象追加 `reconnectFailed`、`manualReconnect`。
6. 验证：`npm run build`。

### 步骤 3：断线横幅升级（P1-2）

1. `desktop/src/components/common/ConnectionBanner.vue`：解构追加 `reconnectFailed, manualReconnect`。
2. 模板改为两态：`reconnectFailed` 为真 → 红色系横幅（`--aw-danger` 底）文案「重连失败，网络或服务端异常」+ 两个文字按钮 `[立即重试]`（`manualReconnect()`，显式 `type="button"`）与 `[重新加载页面]`（`location.reload()`）；否则维持现黄色文案不动。
3. 验证：`npm run build`；手工断后端验证升级与恢复（§7 清单 3）。

### 步骤 4：ChatPanel / MessageBubble / ChatRoundList（P1-1 / P1-3 / P2-4）

1. `ChatPanel.vue`：destructure 追加 `historyLoadError`、`olderLoadError`、`retryHistoryLoad`；新增 computed `historyLoadFailed = computed(() => historyLoadError.value?.sessionId === sessionId.value)` 与 `olderLoadFailed = computed(() => olderLoadError.value?.sessionId === sessionId.value)`。
2. 空态分支（:92-100）：原引导分支条件追加 `&& !historyLoadFailed`；其前新增错误分支 `v-else-if="historyLoadFailed && !agentRunning && !initialLoading"`——渲染「历史消息加载失败」+ 副句「网络异常，请检查连接后重试」+ `[重试]` 按钮（`retryHistoryLoad()`）。
3. `.messages` 容器内、`ChatRoundList` 之前新增顶部小条 `v-if="olderLoadFailed"`：「加载更早消息失败，点击重试」（整条可点 → `loadOlderMessages()`）。
4. `confirmEdit`（:651-656）签名改 `async function confirmEdit(messageId: string, newContent: string, images: string[])`，调 `editAndResend(messageId, newContent, images)`。
5. `MessageBubble.vue`：
   - `copyMessage`（:799-808）`if (!ok)` 分支补 `ElMessage.error('复制失败，请手动选择文本复制')`（`ElMessage` 已在 import 清单则复用，否则新增 import；`ExecutionErrorBanner.vue:57-66` 同口径）。
   - 编辑态图片：`removedImages = ref<Set<string>>(new Set())`，`isEditing` watch 置真时重置；编辑区（textarea 下方）渲染 `message.images` 缩略（`el-image` `fit="cover"` 48px 方块），每张右上角移除按钮（tooltip「仅本次重发不携带此图，历史消息不受影响」，点击在 `removedImages` 增删）。
   - `handleConfirm`（:379-383）：`const remaining = (props.message.images ?? []).filter(u => !removedImages.value.has(u)); emit('confirmEdit', editContent.value, remaining)`；emit 签名改 `confirmEdit: [content: string, images: string[]]`。
6. `ChatRoundList.vue`：`confirmEdit` 事件透传签名同步加 `images: string[]`（纯透传）。
7. 验证：`npm run build`。

### 步骤 5：TaskView / TaskIndexPanel 索引错误门（P1-1）

1. `TaskView.vue`：新增 `const indexError = ref(false)`；`loadTaskIndex`（:1502-1517）catch 里追加 `indexError.value = true`（`!getToken()` 分支不置错）；新增 `retryTaskIndex()`：`indexError.value = false; initialLoading.value = true; if (await loadTaskIndex()) await resolveInitialRoute()`；新增 `forceNewTask()`：`indexError.value = false; await enterNewTaskMode()`。
2. `isNewTaskMode`（:166）追加 `&& !indexError.value`。
3. 模板 `task-container` 内、`CenterTabBar`/`CenterTabContainer` 之前新增中央错误卡 `v-if="indexError && !sessionIdParam"`：「任务列表加载失败」+ 副句「网络异常，请检查连接后重试」+ `[重试]`（`retryTaskIndex`）+ `[仍要新建任务]`（`forceNewTask`）。
4. `TaskIndexPanel.vue`：新增可选 prop `loadError?: boolean` 与 emit `retry`；列表区顶部渲染错误条「任务列表加载失败 · [重试]」（`loadError` 为真且列表为空时）；TaskView 挂载处传 `:load-error="indexError"` `@retry="retryTaskIndex"`。
5. 验证：`npm run build`。

### 步骤 6：@面板空态与失败（P2-5）

1. `FileReferencePanel.vue`：新增可选 prop `loadError?: boolean` 与 emit `retry`；分支顺序改为 `loading` → `loadError`（「文件列表加载失败 · [重试]」按钮 emit retry）→ `files.length === 0 && filter`（「未找到匹配的文件」）→ `files.length === 0 && !filter`（既有「工作区内暂无文件」）→ 既有列表。
2. `ChatInput.vue`：新增 `const fileListError = ref(false)`；`fetchWorkspaceFiles`（:515-552）各成功赋值点（seq 校验通过后）`fileListError.value = false`，catch 的 seq 校验通过分支改为 `fileListError.value = true; workspaceFiles.value = []`；FileReferencePanel 挂载处传 `:load-error="fileListError"` `@retry="fetchWorkspaceFiles(filePanelFilter.value)"`。
3. 验证：`npm run build`。

### 步骤 7：CHANGELOG 与全量验证

1. `CHANGELOG.md` 顶部新增版本条目（版本号取提交时顶部最新版本 +1，预期 `0.0.468`），单节「前端（桌面 / Web）」汇总五项。
2. 全量验证：`cd desktop && npm run build && npx vitest run`（日志落盘后 grep 摘要）；`cd backend-ts && npm run build && npm test`（本任务零后端改动，跑全量确认无回归）。
3. 提交：`fix(desktop): 静默失败可见化——加载失败可重试/断线终态/复制反馈/编辑态图片（<版本>）`，推 origin/main。

## 5. 落地清单

| 文件 | 改动 | 步骤 |
|---|---|---|
| `desktop/src/composables/useChat.ts` | 两个错误态 + D4 谓词 catch + `retryHistoryLoad` + `editAndResend` 三态 images | 1 |
| `desktop/src/composables/useStreamWS.ts` | `consecutiveFailures`/`authRejected`/`reconnectFailed`/`manualReconnect` | 2 |
| `desktop/src/components/common/ConnectionBanner.vue` | 终态升级两按钮（D1） | 3 |
| `desktop/src/components/chat/ChatPanel.vue` | 空态错误分支 + older 顶条 + `confirmEdit` images 透传 | 4 |
| `desktop/src/components/chat/MessageBubble.vue` | 复制失败 toast + 编辑态图片/移除 + emit 签名 | 4 |
| `desktop/src/components/chat/ChatRoundList.vue` | `confirmEdit` 透传签名 | 4 |
| `desktop/src/views/task/TaskView.vue` | `indexError` + `isNewTaskMode` 门 + 中央错误卡 + 重试/出口函数 | 5 |
| `desktop/src/components/task/TaskIndexPanel.vue` | `loadError` prop + `retry` emit + 错误条 | 5 |
| `desktop/src/components/chat/FileReferencePanel.vue` | `loadError`/`retry` + 「未找到匹配的文件」分支 | 6 |
| `desktop/src/components/chat/ChatInput.vue` | `fileListError` 置位/清除 + 面板接线 | 6 |
| `CHANGELOG.md` | 新版本条目（前端一节五项） | 7 |

不动：`useChatScroll.ts`（D8）、`clipboard.ts`（双路逻辑本身不动，只补反馈）、`api/index.ts` 拦截器、后端全部、数据库迁移（零）、路由与分页策略。

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 新错误态与 `switchingSession`/`initialLoading` 状态机打架，出现「错误条不消失」 | D7：按 sessionId 记 + 比对暴露，成功无条件清；无定时器 |
| 新建会话尚未落库时弹假「加载失败」 | D4：业务拒绝（拦截器 `Error.code`）保持静默，仅网络/HTTP 层失败置错（勘误 3） |
| 断线终态误报（短暂抖动就升级） | D1 阈值 3 次 + 鉴权即时升级；手动重试成功立即恢复原文案 |
| `indexError` 门让真正的新用户进不了新建态 | D6：门只挡「静默」路径；中央错误卡提供显式「仍要新建任务」出口；`!getToken()` 不置错 |
| 编辑态图片操作与确认链路耦合 | D5 三态语义只动一个默认行为点；唯一调用点同步更新；历史消息与已落库图片零影响（tooltip 明示） |
| 事件签名变更（`confirmEdit` 加参）漏改中间层 | 步骤 4 同时改 MessageBubble emit / ChatRoundList 透传 / ChatPanel 处理三处，`npm run build` 类型闭环兜底 |

## 7. 测试要点

自动：本任务改动均为 SFC 状态与组合式函数粘合层，**不新增组件挂载测试**（与既有聊天组件一致无挂载测试先例）；以 `npm run build`（vue-tsc 类型闭环）+ desktop 全量 vitest + backend 全量 vitest（确认零后端回归）为准绳。

手工验收清单（构建后本地走查，对应提案 §7）：

1. `fetchMessages` 失败：断网进入已有会话 → 空态显示「历史消息加载失败 · [重试]」；恢复网络点重试 → 消息加载且错误态消失；新建会话首条消息发送前后**不**出现假错误（D4 回归）。
2. `loadOlderMessages` 失败：断网上滑长会话 → 顶部小条出现；点重试成功后消失；`loadOlderMessages` 返回值语义不变（滚动定位行为不变）。
3. `loadTaskIndex` 失败：停后端刷新页面 → 任务面板错误条 + 中央错误卡，**不**进入新建任务态；点「仍要新建任务」→ 正常进入；点「重试」后端恢复 → 正常落到最近会话。
4. 断线终态：停后端 ≥3 次退避 → 横幅变红色终态两按钮；点「立即重试」后端恢复 → 恢复黄色自动重连文案并连上；鉴权拒绝场景即时升级。
5. 复制失败：`navigator.clipboard` 权限拒绝环境（http://IP 访问）下点复制 → error toast；正常环境 success 链路不变。
6. 编辑态图片：编辑带图消息 → 缩略可见；移除一张确认 → 重发载荷不含该图（网络面板验证 `edit_and_resend.images`），历史消息图片不变；全部移除确认 → 重发载荷 `images` 为空数组（D5 回归）；未动图片确认 → 行为与改前一致。
7. @面板：输入不匹配 filter → 「未找到匹配的文件」；停后端触发拉取 → 「文件列表加载失败 · [重试]」；重试成功恢复列表。

## 8. 决策记录（原提案 §8 三个待评审项 → 定案）

1. **重连终态阈值**：连续失败 3 次（约 7 秒）+ 鉴权拒绝即时升级。见 D1。
2. **移除图片二次确认**：不确认，tooltip 明示影响范围。见 D2。
3. **错误文案粒度**：统一固定文案、不透原始错误。见 D3（取提案倾向的后者，且不做「详情折叠」——固定文案之下没有需要折叠的详情）。

## 9. 明确不做的（汇总）

1. 流式输出中复制半成品（`!isAssistantRunning` 门禁不动）。
2. 主聊天历史锚定条 / 回到最新 / 加载更早指示（边路会话已有，主聊天适配另立项）。
3. 队列清空 / 键盘排序 / 截断全文（队列状态机扩展）。
4. 「重新生成」（需后端回滚重放语义，另立专项）。
5. 会话内查找 / Markdown 导出（2026-11-02 已否决）。
6. 后端错误码 / 错误结构 / WS 帧任何改动；消息分页与任务列表加载策略本身的改动。
7. `useChatScroll.ts` 与 `clipboard.ts` 的逻辑改动（前者零改动，后者只在上层补反馈）。
