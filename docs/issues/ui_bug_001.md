# 前端 UI / 交互问题清单（ui_bug_001）

> 审查范围：`admin/`（管理后台）与 `desktop/`（桌面端）  
> 审查日期：2026-07-20  
> 说明：本次仅梳理问题，**不直接改代码**。优先级为建议修复顺序，非强制排期。

---

## 概览

共整理 **12** 条可优化问题（功能 / UI / 样式 / 交互），覆盖两端：

| # | 端 | 严重程度 | 问题摘要 |
|---|----|----------|----------|
| 1 | desktop | 高 | 边路任务缺少工具审批 UI，审批可能「消失」 |
| 2 | desktop | 高 | `dangerReason` 已下发但审批卡片从不展示 |
| 3 | admin | 高 | 路由仅校验 Token，侧栏无权限过滤 |
| 4 | admin | 高 | 发布通知无校验、无 loading，可重复提交 |
| 5 | desktop | 中 | 「关闭所有文件」会一并清掉边路任务 Tab |
| 6 | desktop | 中 | 边路聊天无自动滚动，流式输出时视野留在顶部 |
| 7 | desktop | 中 | 设计 token `--aw-surface` 未定义，多处背景失效 |
| 8 | desktop | 中 | 登录空用户名/密码时静默失败，无反馈 |
| 9 | desktop | 中 | 主题 `auto` 与系统偏好不同步；切换会丢掉 auto |
| 10 | admin | 中 | Skills「状态」列恒为「可用」，与校验列矛盾 |
| 11 | admin | 中 | 多列表桌面端缺空态；枚举文案中英混用 |
| 12 | 两端 | 低～中 | 可访问性不足；主聊天滚动条被隐藏；提问队列只展示最后一项 |

---

## 1. 边路任务缺少工具审批 UI，LOCAL 审批可能「消失」

| 项 | 内容 |
|---|---|
| **端** | desktop |
| **严重程度** | 高 |
| **类型** | 功能 / 交互 |
| **涉及文件** | `desktop/src/components/chat/SideChatPanel.vue`；`desktop/src/components/chat/ChatPanel.vue`（约 48–52、267–269 行）；`desktop/src/composables/useChat.ts`（约 74–90 行） |

**现象**  
边路任务在 LOCAL 模式触发工具审批时，用户切到 Side Task 标签后看不到「执行 / 拒绝」卡片；主会话侧又因按 `activeSessionId` 过滤而隐藏边路审批。Agent 可能卡在 `WAITING_APPROVAL`，用户却无法操作。

**原因**  
审批 UI 只挂在主聊天 `ChatPanel`，且过滤条件是主会话 ID：

```ts
// ChatPanel.vue
pendingApprovals.value.filter(a => !a.sessionId || a.sessionId === sessionStore.activeSessionId)
```

`SideChatPanel` 有 `QuestionPanel`，但完全没有 `ApprovalStack` / `confirmApproval`。

**建议**  
在 `SideChatPanel` 增加与主聊天一致的 `ApprovalStack`，按边路 `realSessionId` 过滤并调用 `respondToolApproval`；或把审批做成全局浮层，不依赖当前 Tab。

---

## 2. `dangerReason` 已下发但审批卡片从不展示

| 项 | 内容 |
|---|---|
| **端** | desktop |
| **严重程度** | 高 |
| **类型** | UI / 安全交互 |
| **涉及文件** | `desktop/src/components/chat/ApprovalStack.vue`（约 18–40、51–56 行）；`desktop/src/composables/useChat.ts`（约 78–81 行） |

**现象**  
危险命令（高风险 shell 等）与普通写文件审批视觉几乎相同，用户难以感知风险级别，容易误点「执行」。

**原因**  
IPC / WebSocket 已把 `dangerReason` 写入 `ApprovalItem`，但 `ApprovalStack` 模板从未渲染该字段，接口定义形同虚设。

**建议**  
有 `dangerReason` 时用醒目提示（文案 + 更强危险色）；高风险审批默认焦点落在「拒绝」；普通与高风险在样式上明确区分。

---

## 3. 路由仅校验 Token，侧栏无权限过滤

| 项 | 内容 |
|---|---|
| **端** | admin |
| **严重程度** | 高 |
| **类型** | 功能 / 权限 UX |
| **涉及文件** | `admin/src/router/index.ts`（约 104–115 行）；`admin/src/components/SideMenu.vue`；`admin/src/stores/auth.ts` |

**现象**  
只要本地有 `token`，即可进入用户 / 角色 / 系统设置等全部后台页；无权限用户也会看到完整菜单，点击后多半接口 403，体验差且暴露越权入口。

**原因**  
守卫只判断 `localStorage.token` 是否存在，路由 `meta` 无权限码；侧栏菜单写死，不按角色裁剪。

**建议**  
路由增加 `meta.permission` + `beforeEach` 校验；菜单按权限渲染；401/403 提供「无权限」页，而非仅 Toast。

---

## 4. 发布通知无校验、无 loading，可重复提交

| 项 | 内容 |
|---|---|
| **端** | admin |
| **严重程度** | 高 |
| **类型** | 功能 / 交互 |
| **涉及文件** | `admin/src/views/notification/NotificationListView.vue`（约 69–88、139–144 行） |

**现象**  
标题 / 内容为空也能点「发布」；网络慢时连点会发出多条相同通知；按钮无禁用与 loading 反馈。

**原因**  
`saveNotification` 直接 `api.post`，无 `rules`、无 `submitting`；footer 按钮无 `:loading`。对比 `UserFormDialog` / `ModelFormDialog` 已有完整提交态。

**建议**  
必填校验；`submitting` 防重复提交；成功后再关弹窗并刷新列表。

---

## 5. 「关闭所有文件」会一并清掉边路任务 Tab

| 项 | 内容 |
|---|---|
| **端** | desktop |
| **严重程度** | 中 |
| **类型** | 功能 / 交互 |
| **涉及文件** | `desktop/src/composables/useCenterTabs.ts`（约 197–201 行）；`desktop/src/components/center/CenterTabBar.vue`（文案「关闭所有文件」） |

**现象**  
右键「关闭所有文件」后，正在跑的边路任务标签也消失；且未走 `markSideTaskClosed`，刷新后行为可能与用户预期不一致。

**原因**

```ts
function closeAllFileTabs() {
  const state = getSessionState()
  state.tabs = []
  state.activeTabId = 'chat'
}
```

未区分 `file` / `diff` / `side_task`。

**建议**  
只关闭 `type === 'file' | 'diff'`；边路任务单独菜单项，关闭时调用与 `closeTab` 相同的 `markSideTaskClosed`。

---

## 6. 边路聊天无自动滚动，流式输出时视野留在顶部

| 项 | 内容 |
|---|---|
| **端** | desktop |
| **严重程度** | 中 |
| **类型** | 交互 / UX |
| **涉及文件** | `desktop/src/components/chat/SideChatPanel.vue`（约 4 行有 `messagesContainer`，无 scroll 逻辑）；对比 `ChatPanel.vue`（约 334–423 行完整 auto-scroll） |

**现象**  
Side Task 对话变长后，用户需手动滚到底才能看最新流式内容与提问面板；主会话则有跟底滚动，两端体验不一致。

**原因**  
`messagesContainer` 仅声明 ref，未做 `scroll` / `wheel` 监听与 `scrollToBottom`。

**建议**  
复用 `ChatPanel` 的 near-bottom / userScrolledUp 逻辑，或抽成 `useChatAutoScroll` 两边共用。

---

## 7. 设计 token `--aw-surface` 未定义，多处背景失效

| 项 | 内容 |
|---|---|
| **端** | desktop |
| **严重程度** | 中 |
| **类型** | 样式 |
| **涉及文件** | `desktop/src/style.css`（仅有 `--aw-surface-pearl` 等，无 `--aw-surface`）；使用处：`CenterTabBar.vue`、`MessageBubble.vue`、`FileViewer.vue`、`SkillDrawer.vue`、设置页等 |

**现象**  
激活 Tab、消息编辑框、文件预览等背景可能透明或回退异常；暗色模式下对比度更差。

**原因**  
多处写 `background: var(--aw-surface)`，但根变量未定义（部分 Teleport 样式靠 `#fff` fallback，scoped 内没有）。

**建议**  
在 `:root` / `[data-theme="dark"]` 补齐 `--aw-surface`（建议映射到现有 canvas / parchment），并全局排查未定义的 `--aw-surface-hover`、`--aw-ink-muted-64` 等同类 token。

---

## 8. 登录空用户名/密码时静默失败，无反馈

| 项 | 内容 |
|---|---|
| **端** | desktop |
| **严重程度** | 中 |
| **类型** | 交互 |
| **涉及文件** | `desktop/src/components/auth/LoginDialog.vue`（约 144–146 行） |

**现象**  
点「登录」或回车时，若表单空白，按钮无 loading、无校验提示，像「点了没反应」。

**原因**

```ts
async function handleLogin() {
  if (!form.value.username || !form.value.password) return
  // ...
}
```

提前 `return` 且无任何用户提示。

**建议**  
`ElMessage.warning` 或 `el-form` rules；空字段时聚焦对应 input。强制登录场景下，取消按钮也应说明「需登录才能使用」。

---

## 9. 主题 `auto` 与系统偏好不同步；切换会丢掉 auto

| 项 | 内容 |
|---|---|
| **端** | desktop |
| **严重程度** | 中 |
| **类型** | 交互 / 样式 |
| **涉及文件** | `desktop/src/utils/theme.ts`（约 19–52 行）；`desktop/src/components/common/TopNav.vue`（约 54–60 行） |

**现象**  
默认或已存 `auto` 时，改系统深浅色后应用不跟随；点月亮 / 太阳后永久变成 light / dark，无法回到「跟随系统」。

**原因**  
`applyTheme('auto')` 只读一次 `matchMedia`，无 `change` 监听；`toggleTheme` 只在 light / dark 间切换。

**建议**  
`auto` 时监听 `prefers-color-scheme`；导航提供 light / dark / auto 三态，或长按 / 菜单恢复 auto。

---

## 10. Skills「状态」列恒为「可用」，与校验列矛盾

| 项 | 内容 |
|---|---|
| **端** | admin |
| **严重程度** | 中 |
| **类型** | 功能 / UI 误导 |
| **涉及文件** | `admin/src/views/skill/SkillListView.vue`（约 50–64 行） |

**现象**  
校验为「异常」时，状态仍显示绿色「可用」，用户误以为 Skill 可被 Agent 使用。

**原因**  
状态列模板写死：

```vue
<el-tag type="success" size="small">可用</el-tag>
```

未读取 `filePath` / `folderPath`。

**建议**  
与校验同源：异常 →「不可用」/ danger；通过 →「可用」；或去掉冗余「状态」列。

---

## 11. 多列表桌面端缺空态；枚举文案中英混用

| 项 | 内容 |
|---|---|
| **端** | admin |
| **严重程度** | 中 |
| **类型** | UI / 文案 |
| **涉及文件** | `UserListView.vue`、`SessionListView.vue`、`AgentListView.vue`、`NotificationListView.vue`、`SkillListView.vue`、`RuntimeMonitorView.vue` 等 |

**现象**  
1. 桌面筛选无结果时常见空白表头；移动端部分列表有 `el-empty`，体验不一致。  
2. 中文后台里筛选项 / 标签直接显示 `SYSTEM` / `CLOUD` / `RUNNING` / `ACTIVE` 等英文码；Skills 页混用 “Agent Skills / Anthropic”，运营理解成本高。

**原因**  
`el-empty` 多挂在移动卡片区的 `v-else`，`el-table` 未设 `#empty`；选项 `label` 直接用后端枚举值，无中文映射。

**建议**  
统一 `<template #empty><el-empty /></template>`；建立 `labelMap`（如 CLOUD→云端、RUNNING→运行中），表格展示中文，详情可附原始码。

---

## 12. 可访问性不足；主聊天滚动条隐藏；提问队列只展示最后一项

| 项 | 内容 |
|---|---|
| **端** | admin + desktop |
| **严重程度** | 低～中 |
| **类型** | 可访问性 / UX |
| **涉及文件** | `desktop/src/components/common/TopNav.vue`；`ChatPanel.vue`（约 685–691 行）；`QuestionPanel.vue`（约 129–136 行）；`admin/src/components/TabBar.vue`、`Layout.vue` |

**现象**  
1. 桌面顶栏主题 / 面板 / 终端等用 `div.theme-toggle` + `@click`，键盘无法聚焦，读屏缺少名称；管理后台 Tab 关闭同理。  
2. 主聊天 `.messages` 设 `scrollbar-width: none`，长对话不易发现可滚动区域。  
3. `QuestionPanel` 的 `currentQuestions` 取 `items[last]`，多请求排队时旧请求 UI 不可见（仅 badge 数字暗示）。

**原因**  
交互元素未用 `button` / `aria-label`；滚动条被 CSS 完全隐藏；提问面板只渲染队列末项。

**建议**  
顶栏与 Tab 改为 `<button type="button" aria-label="...">`；滚动条改为细条或悬停显示；提问支持切换历史队列项或串行明确提示「还有 N 个待回答」。

---

## 额外观察（未单列，可顺带修）

| 点 | 位置 | 说明 |
|----|------|------|
| 角色权限切换易丢未保存改动 | `RolePermissionView.vue` | 改了勾选后点另一角色，无 dirty 确认 |
| Agent 列表 computed 内写 `total` | `AgentListView.vue` 约 128–135 行 | computed 副作用，标签筛选时页码偶发异常 |
| 弹窗组件不统一 | `UserFormDialog` vs `ModelFormDialog` / `AgentFormDialog` | 有的用 `ResponsiveDialog`，有的用裸 `el-dialog`，窄屏易溢出 |
| 边路提问面板位置不一致 | `SideChatPanel` 在消息滚动区内；`ChatPanel` 在输入区上方 | 边路提问易被滚走 |
| 边路空态硬编码灰 | `SideChatPanel.vue` `#909399` / `#c0c4cc` | 暗色主题不协调 |
| 审批复制无反馈 | `ApprovalStack.copyText` | clipboard 失败静默 |

---

## 建议修复优先级

1. **P0（阻断 / 安全）**：#1 边路审批缺失 → #2 dangerReason 未展示 → #3 管理端权限路由 → #4 通知重复提交  
2. **P1（明显体验缺陷）**：#5 关闭全部误清边路 → #6 边路自动滚动 → #10 Skill 状态误导 → #7 设计 token  
3. **P2（体验打磨）**：#8 登录校验 → #9 主题 auto → #11 空态与文案 → #12 a11y / 滚动条 / 提问队列  

---

## 备注

- 既有文档 `docs/admin-frontend-issues.md` 记录了管理后台历史整改项；本清单侧重**当前仍存在**的问题，并补充 desktop 端发现。  
- 本轮未改代码；若需按优先级落地修复，可指定 P0 / 单项开改。
