# 审批键盘流技术方案：桌面审批卡片的 Y/N 快捷键与焦点可见性

> 对应提案：[docs/proposals/2026-11-11-approval-keyboard-flow.md](../proposals/2026-11-11-approval-keyboard-flow.md)（批次 29）。零后端、零迁移，改动面收敛在 desktop 的 `ApprovalStack.vue`（键流与焦点）+ 速查表常量 +1 条；审批语义（升级链路 / 规则 / 多端广播）零改动。

## 1. 需求背景（含现状复核修正）

工具审批是打断心流的时刻：Agent 停下来等裁决，用户要做的只有看一眼内容、按一个键。桌面审批卡片今天没有任何键盘交互（`ApprovalStack.vue` 全文件 grep `keydown` 零命中），允许 / 拒绝只能鼠标点击。2026-11-11 复核后的真实现状：

| 场景 | 现状 | 代码证据 |
|---|---|---|
| 审批操作 | 仅鼠标点击；按钮文案实际是 **「执行」/「拒绝」/「总是允许」**（提案写作时称「允许」） | `ApprovalStack.vue:38-65` |
| 顶层卡语义 | 栈内最后一张为 interactive（可交互），其余只显示标题行 | `ApprovalStack.vue:7-8, 19` |
| 防重复提交 | `handledIds` 集合：点击后立即禁用，卡片随服务端响应消失；失败放回队列后重新允许 | `ApprovalStack.vue:104-130` |
| 确认回调 | `confirm(requestId, approved, alwaysAllow)` → emit → 面板的 `confirmApproval`（WS 投票 + 回声 + 本地放行全链） | `ApprovalStack.vue:126-130`、`useChat.ts:86-125` |
| 挂载点 | 主会话 `ChatPanel.vue:165`、边路任务 `SideChatPanel.vue:103`、子代理 `SubagentChatPanel.vue:44` 三处 | 同左 |
| **活跃 Tab 归属（关键结构事实）** | `CenterTabContainer` 对全部 Tab 内容用 `v-if / v-else-if` + `KeepAlive`：**任一时刻 DOM 里只挂着活跃 Tab 的面板**，非活跃面板被 KeepAlive 停活（DOM 脱离文档，`isConnected === false`） | `CenterTabContainer.vue:4-33`、`TaskView.vue:332` 注释 |
| 键盘守卫惯例 | `isTypingTarget`（3 行：INPUT / TEXTAREA / isContentEditable）在 `TopNav.vue:314` 与 `TaskView.vue` 各有一份**刻意重复**，且 `center-tab-efficiency.test.ts:287-296` 有源码级口径锁 | 同左 |
| 文档级 keydown 先例 | 中心页签 Ctrl/Cmd+Alt+←/→ 循环（`document.addEventListener('keydown')` + `e.repeat` 守卫） | `TaskView.vue` `handleTabCycleKeydown` |

**活跃 Tab 归属判定不需要任何 tab-id 接线**：审批栈随面板挂载，非活跃 Tab 的栈不在文档中——组件级 `isConnected` 守卫即可结构性排除后台 Tab 的误批。提案原文的「活跃 Tab 归属判定按中心 Tab 活跃态同源」据此简化。

## 2. 需求描述

| # | 用户故事 | 判定 |
|---|---|---|
| 1 | 活跃 Tab 存在待审批卡片，焦点不在任何输入框 / 编辑器 / 浮层内 | 按 `Y` = 执行（与点击「执行」按钮完全同路径：`confirm(topId, true, false)`）、`N` = 拒绝（`confirm(topId, false, false)`）；卡片随既有流程消失 |
| 2 | 多张卡叠栈 | 只响应栈顶（interactive，`items` 末位）一张；处理完随队列推进自然落到下一张 |
| 3 | 焦点在聊天输入框（TipTap）/ 任何 input / textarea / contenteditable | `Y` / `N` 正常输入文本，**不触发**审批 |
| 4 | 任何 el-dialog / el-drawer（含命令面板、搜索浮窗、用量抽屉）打开时按 Y | 不触发审批（用户在别的交互面上） |
| 5 | 后台 Tab（边路任务 / 子代理）有待审批卡片，当前在主会话 | 按 `Y` / `N` **不响应**后台 Tab 的卡片（该栈不在文档中，结构性排除） |
| 6 | 长按 Y / 中文输入法组合键态 | `e.repeat` 与 `isComposing` 拦截，只触发一次 |
| 7 | 键盘用户看到卡片 | 执行 / 拒绝按钮原生可 Tab 聚焦，`:focus-visible` 有轮廓；按钮 title 注明快捷键（「快捷键 Y」/「快捷键 N」）；速查表 8 条含新条目 |

**要做**：上述七条。

**不做**：

- `A`（总是允许）快捷键——不做（评审拍板：规则写入有副作用，单键误触风险），按钮保持点选，title 不加快捷键提示。
- 自动聚焦到「执行」按钮——不做（评审拍板：防打字抢占与误批）。
- 正向 `tabindex` 全局重排——不做（可达性反模式）；「Tab 一次可达」收窄为「按钮组天然在 Tab 序中 + focus-visible 轮廓可见」（§8 决策 3 记录与提案原文的差异）。
- Enter / Esc 备选键位——不做（评审拍板 Y/N；Esc 与关闭浮层冲突）。
- 审批语义任何改动：升级链路（飞书卡片）、审批规则、多端广播、`clearPendingApprovals`、回声重发——全部零改动，快捷键只是 `confirm()` 的另一个触发器。
- 跨任务审批收口、审批历史 UI（批次 21 已否决方向）。

## 3. 技术选型与决策

| 决策点 | 定案 | 理由 |
|---|---|---|
| 键流宿主 | **`ApprovalStack` 组件自身**注册 `document.addEventListener('keydown')`（onMounted 挂 / onUnmounted 卸），不放 ChatPanel / TaskView | 栈自己持有 `items` 与 `confirm`，Y/N 直接调内部 `confirm()`——与按钮点击调同一函数、同一 `handledIds` 防重，语义单点；放外层反而要把 confirm 回调往回传 |
| 活跃 Tab 归属 | 守卫 `rootRef.value?.isConnected`：KeepAlive 停活的栈 DOM 已脱离文档，守卫为 false 即不响应 | 结构性解决（§1 关键事实），零 tab-id 传递；比「注册表 + activeTabId 比对」少一条状态同步链 |
| 只响应栈顶 | `const top = props.items[props.items.length - 1]`，空栈 / `handledIds.has(top.requestId)` 早退 | 与 interactive 卡渲染判定（`index === items.length - 1`）同口径 |
| 守卫链 | `e.isComposing` → 修饰键排除（Ctrl/Cmd/Alt，Ctrl+Y 是本应用 redo 菜单加速器）→ `e.repeat` → `isTypingTarget(e.target)` → 全屏浮层（`.el-overlay, .el-image-viewer__wrapper, .mermaid-viewer`）→ `isConnected` → 栈顶存在且未处理；各守卫均为纯早退，语义等价，**实现以 §4.1 片段顺序为准** | 输入法组合键、连按、输入焦点、修饰键组合、浮层、后台 Tab 六类误触全覆盖；`.el-overlay` 覆盖 dialog/drawer 家族，`el-image-viewer__wrapper` / `mermaid-viewer` 覆盖两个不挂在 .el-overlay 下的自绘/独立全屏层（评审发现，§10-6） |
| 键位识别 | `e.key.toLowerCase()` 取 `'y'` / `'n'`（大写、CapsLock 天然归一） | 不引入修饰键组合；`Y`/`N` 在非输入场景无浏览器默认绑定 |
| isTypingTarget 来源 | **第三份刻意重复**（与 TopNav / TaskView 同款 3 行 + 同款注释），不抽公共 util | `center-tab-efficiency.test.ts:296` 已把「两处均含 TEXTAREA 与 isContentEditable」锁成口径基准；抽 util 要连带改锁测试与两处既有实现，收益为零风险为正 |
| 焦点可见性 | 按钮 title 补「快捷键 Y / N」；`.action-btn:focus-visible` 加 outline（`--aw-primary`，拒绝钮用 `--aw-danger`） | 不自动 focus（拍板）；outline 走既有令牌零新增色值 |
| 速查表数据源 | 新条目 `{ keys: 'Y / N', action: '审批待决卡片（执行 / 拒绝）' }` 追加到 `utils/shortcutRows.ts` 的 `SHORTCUT_ROWS` 末位（提案 3 已落地的单一数据源），对话框与面板内组自动同步 | 收编迁移已由提案 3 完成；**联动面**：`shortcutRows.test.ts` 的 toEqual 清单与 `command-palette.test.ts:301` 的 `keys: '` 计数断言 7 → 8 必须同任务更新（见 §4.2/§5） |
| Y/N 与多端升级竞态 | 无新增面：键流调用与按钮点击**同一** `confirm()`，服务端投票 / 回声 / 重发链路逐字节复用 | 提案风险表的既有结论，靠「同一函数」结构性保证 |

## 4. 实现步骤

### 4.1 `ApprovalStack.vue`：键流与焦点

1. 模板根 `.approval-stack` 加 `ref="rootRef"`（script 补 `const rootRef = ref<HTMLElement | null>(null)`，vue import 追加 `onMounted, onUnmounted`）；执行 / 拒绝按钮补 `title`（执行钮注意保留无 title 现状 → 改为 `title="快捷键 Y"`；拒绝钮 `title="快捷键 N"`；总是允许钮 title 保持既有 `item.approvalHint.label` 不动）。
2. script 追加（setup 内）：

   ```ts
   /** 文本输入焦点守卫：与 TopNav / TaskView 同款三行（口径由 center-tab-efficiency.test.ts 锁定） */
   function isTypingTarget(target: EventTarget | null): boolean {
     return target instanceof HTMLElement
       && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
   }

   function handleApprovalKeydown(e: KeyboardEvent) {
     if (e.isComposing || e.repeat) return
     if (!isTypingTarget(e.target)) {
       const key = e.key.toLowerCase()
       if (key === 'y' || key === 'n') {
         // KeepAlive 停活的栈不在文档中：后台 Tab 的卡片不响应（活跃 Tab 归属的结构性判定）
         const top = props.items[props.items.length - 1]
         if (!rootRef.value?.isConnected || !top || handledIds.value.has(top.requestId)) return
         if ((e.target as HTMLElement | null)?.closest?.('.el-overlay')) return
         e.preventDefault()
         confirm(top.requestId, key === 'y', false)
       }
     }
   }

   onMounted(() => document.addEventListener('keydown', handleApprovalKeydown))
   onUnmounted(() => document.removeEventListener('keydown', handleApprovalKeydown))
   ```

   守卫顺序按 §3；`closest` 对非 HTMLElement target（如 document）走可选链兜空。
3. 样式追加：`.action-btn.approve:focus-visible`、`.action-btn.reject:focus-visible`、`.action-btn.always-allow:focus-visible` 各加 `outline: 2px solid <对应令牌色>`（approve → `--aw-primary`，reject/always-allow → 各自既有色令牌），`outline-offset: 1px`。

### 4.2 速查表 +1（含计数断言联动）

- `utils/shortcutRows.ts` `SHORTCUT_ROWS` 追加 `{ keys: 'Y / N', action: '审批待决卡片（执行 / 拒绝）' }`（位置殿后）。`ShortcutHelpDialog` 与命令面板快捷键组自动同步（提案 3 已完成收编，无迁移步骤）。
- **计数断言联动（评审补充，缺了会红）**：
  1. `desktop/src/utils/shortcutRows.test.ts` 迁移锁定用例的 `toEqual([...])` 清单追加第 8 条；
  2. `desktop/src/components/palette/command-palette.test.ts:301` 的 `expect(shortcutRowsSrc.match(/keys: '/g)).toHaveLength(7)` → `8`，测试名「快捷键速查 7 条…」同步改措辞（如「快捷键速查落在单一数据源」），文件头注释「速查表 7 条」一并更新；
  3. 命令面板动态组测试的 `SHORTCUT_ROWS.length` 断言是数据驱动的，自动适配，不动。

### 4.3 测试

新增 `desktop/src/components/chat/ApprovalStack.test.ts`（该组件现无测试；jsdom + `createApp` mount 范式与 `ToolShellView.test.ts` 同款）：

1. Y/N 触发：emit `confirm` 收到 `(topRequestId, true, false)` / `(topRequestId, false, false)`；`handledIds` 生效后连按不再 emit。
2. 多卡叠栈：只有末位（interactive）卡片的 requestId 被触发。
3. 守卫：input / textarea / contenteditable 聚焦时不触发；`e.repeat` 不触发；`isComposing` 不触发；事件 target 位于 `.el-overlay` 内不触发。
4. 后台 Tab 模拟：根元素从文档移除（`el.remove()`）后按 Y 不触发（isConnected 守卫直测，不依赖 KeepAlive 集成）。
5. title：执行 / 拒绝按钮 title 为「快捷键 Y」/「快捷键 N」；总是允许 title 仍为 hint label。
6. 回归：`handledIds` 放回队列重新允许的既有语义（:110-124 watch）不受影响——失败放回后 Y 可再次触发（补一条用例）。

## 5. 落地清单

| 类型 | 文件 | 内容 |
|---|---|---|
| 修改 | desktop/src/components/chat/ApprovalStack.vue | document keydown + 守卫链 + isConnected 归属；按钮 title；focus-visible 样式 |
| 修改 | desktop/src/utils/shortcutRows.ts | SHORTCUT_ROWS +1 条（收编已由提案 3 完成，直接追加） |
| 修改 | desktop/src/utils/shortcutRows.test.ts | toEqual 清单追加第 8 条（§4.2 联动） |
| 修改 | desktop/src/components/palette/command-palette.test.ts | `keys: '` 计数断言 7 → 8 + 措辞（§4.2 联动） |
| 新增 | desktop/src/components/chat/ApprovalStack.test.ts | 键流 / 守卫 / 归属 / title 用例 |
| 修改 | desktop/src/components/center/center-tab-efficiency.test.ts | 口径锁从「两处」扩为「三处」（:296 数组迭代式，追加 `['ApprovalStack', …]` 一项即可） |
| CHANGELOG | 根 CHANGELOG.md | 前端（桌面 / Web）小节，版本随发版批次 |
| backend-ts / admin / agent-cli | — | **无改动**（审批协议与升级链路零变化） |
| android | — | **无改动**：无硬件键盘不触发（守卫天然覆盖），按钮点击路径不变 |
| 数据库迁移 | — | **无** |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 误批（Y 按下时内容未看清） | ①不自动焦点（用户必须在看）；②`e.repeat` / `isComposing` 拦截；③仅栈顶一张；④typing + 浮层双守卫挡输入与弹窗场景；⑤速查表明示触发条件；⑥误批兜底仍是既有撤销面（审批规则可关） |
| 跨 Tab 误批（后台任务等待时在主会话按 Y） | `isConnected` 结构性排除：后台栈不在文档，守卫恒 false；后台 Tab 审批仍走鼠标 / 多端升级 |
| KeepAlive 语义踩坑（deactivated 组件监听器仍活着） | 守卫按事件时点查 `isConnected`，不依赖 activated/deactivated 生命周期钩子；组件卸载（会话切换清 Tab）时监听器同步移除 |
| Y/N 与浏览器 / IME 冲突 | `isTypingTarget`（input/textarea/contentEditable 全覆盖）+ `.el-overlay` 浮层守卫 + `isComposing`；Y/N 无浏览器默认绑定 |
| 键盘流与多端升级竞态 | 同一 `confirm()` 函数、同一 `handledIds`，无新增竞态面 |
| 焦点序改动影响既有 Tab 流 | 不做任何 tabindex 重排（拍板收窄），DOM 顺序与 Tab 序零变化 |
| 焦点落在其他非输入面板（如 QuestionPanel 选项按钮）时按 Y | Y/N 语义是「非输入、非浮层即审批」——QuestionPanel 无 Y 键位语义，此处按 Y 恰是用户想要的审批动作，不单独设防（已知边缘，评审确认） |
| 锁测试漂移 | `center-tab-efficiency.test.ts` 口径锁同步扩三处（数组迭代式追加一项），防止未来有人只改两处守卫 |

## 7. 测试要点

1. 待审批卡片出现 → `Y` 执行、`N` 拒绝，emit 参数与按钮点击逐字段相同；卡片随之消失；连续两张审批各自生效。
2. 输入框（TipTap contenteditable / input）聚焦时 Y/N 正常输入不触发；长按只触发一次；输入法组合态不触发。
3. 主会话与边路任务各有待审批卡片时，仅活跃 Tab 的栈顶响应（isConnected 用例 + 手测 KeepAlive 场景）。
4. 命令面板 / 用量抽屉等浮层打开时按 Y 不触发审批。
5. `A`（总是允许）无快捷键；执行 / 拒绝按钮 title 含快捷键提示；速查表 8 条（对话框与面板内组两处同步）。
6. 回归：审批回调、升级链路（飞书卡片）、审批规则、多端广播零变化（`useChat.test.ts` / `useChat.rollback.bugcheck.test.ts` 既有审批用例全绿）；`handledIds` 失败放回后重新允许语义不破。
7. 构建：`npm run build`（desktop）绿。

## 8. 决策记录

1. 键位 = `Y` / `N`（评审拍板）；按钮实际文案是「执行」/「拒绝」（提案原文写「允许」，以代码为准）。
2. 键流放 `ApprovalStack` 组件内而非外层面板：与按钮点击共用同一 `confirm()` / `handledIds`，语义与防重单点。
3. 「显式焦点序」按评审拍板收窄落地：**不自动 focus、不做正 tabindex 重排**（可达性反模式且收益存疑），交付「按钮原生可 Tab 聚焦 + focus-visible 轮廓 + title 快捷键提示」。与提案 §4「tabindex 显式序」表述的差异在此记录。
4. 活跃 Tab 归属用 `isConnected` 结构性判定，不建 tab-id 注册表——`CenterTabContainer` 的 v-if + KeepAlive 已保证文档内只有一个栈。
5. `A`（总是允许）无快捷键（评审拍板）；速查表 +1 条走提案 3 收编的 `shortcutRows.ts` 单一数据源。
6. `isTypingTarget` 第三份刻意重复，跟随仓库既有「重复 + 锁测试」惯例，不抽公共 util。

## 9. 明确不做的（汇总）

- `A`（总是允许）快捷键；Enter/Esc 键位；自动聚焦；正 tabindex 全局重排。
- 审批语义改动（升级链路 / 规则 / 多端广播 / 超时）；跨任务审批收口；审批历史 UI。
- 移动端长按手势；安卓布局改动。
- 后端、admin、agent-cli、数据库迁移的任何改动。

## 10. 评审修订记录（2026-11-12）

1. **速查表 +1 的计数断言联动补齐（关键）**：提案 3 落地后 `SHORTCUT_ROWS` 已在 `utils/shortcutRows.ts`，但两处断言硬编码 7——`command-palette.test.ts:301` 的 `keys: '` 计数与 `shortcutRows.test.ts` 的 toEqual 清单，+1 条不同步更新即红。§3/§4.2/§5 已补联动清单；「提案 3 未落地则本提案先行迁移」的过时口径删除。
2. **口径锁扩展方式精确化**：`center-tab-efficiency.test.ts:296` 是数组迭代式（`[['TaskView', …], ['TopNav', …]]`），扩三处 = 追加 `['ApprovalStack', …]` 一项，不是重写断言。§5。
3. **§4.1 片段补 `rootRef` 声明与 vue import 变更**（原片段引用了未声明的 rootRef）。
4. **QuestionPanel 焦点边缘确认**：焦点在问答回答按钮上按 Y 仍会审批——Y/N 语义「非输入非浮层即审批」下这是预期行为（问答无 Y 键位语义），§6 记录为已知边缘不设防。
5. **挂载点复核**：`ToolSubagentProgressView` / `useChat.ts` 对 ApprovalStack 仅类型/注释引用，非渲染挂载——三处挂载点结论维持。
6. **实现轮 review 采纳 5 项**：①修饰键排除（Ctrl+Y = 本应用菜单 redo 加速器，renderer preventDefault 拦不住，组合键也无审批意图）；②全屏浮层守卫从 `.el-overlay` 扩为三选择器——el-image-viewer（正文图片查看器）与 mermaid-viewer（自绘全屏层）不挂 .el-overlay，原守卫漏防且未记录；③守卫测试补 textarea 用例、KeyboardEventInit 直传（repeat/isComposing 本就是标准成员，原 defineProperty 理由不实）、正向对照；④动态组测试名残留「7 条」清理；⑤§3 守卫链顺序注记（文档与 §4.1 实现顺序差异，语义等价）。
