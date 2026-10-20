# 会话 Agent 身份可见性技术改造方案

> 版本：v1.0（2026-10-20）
> 状态：已实施（2026-10-20，见 CHANGELOG 0.0.321）
> 范围：桌面 / Web / 安卓三端共用的 `desktop` 前端（纯前端，无后端改动）
> 关联讨论：2026-10-20 管理后台多 Agent 场景下「用户在客户端选错 Agent 且难以察觉」

## 0. 摘要

管理后台可配置多个 Agent，新建会话时静默回填默认 Agent，对话过程中除右侧栏「工作区」分区的一行灰字外没有任何身份标识，导致用户长时间与错误 Agent 对话而不自知。本次改造按确认的范围（原建议中的 1 + 2 + 4）落地三处**只读**身份展示：

| # | 改动 | 落点 | 说明 |
|---|------|------|------|
| 1 | 会话顶部身份条 | `TaskView` 中间区，CenterTabBar 之上 | 头像 + 名称 + 一句话描述，会话级常驻 |
| 2 | 输入栏常驻 Agent 徽标 | `ChatInputToolbar` 工具条左侧 | 对话态也能看到；移动端降级为纯头像 |
| 4 | 右栏 Agent 独立分区 | `TaskInspector` 「任务」tab 首个分区 | 从「工作区」分区拆出，带头像与描述；原折叠态头像改为身份条右侧「详情」入口 |

**本次明确不做**（留待后续，见 §2.2）：新建态取消静默默认（P1）、会话列表 Agent 标签（P1）、会话内切换 Agent（P2，需后端 `PATCH /v1/sessions/:id` 支持 `agentId`）、消息气泡头像。

## 1. 背景与现状

### 1.1 问题

1. **入口静默替选**：`TaskView.resolveNewTaskDefaults` 在未指定 Agent 时取 `isDefault`，无默认则取列表第一个（`views/task/TaskView.vue:811-814`）。而 `ChatInput` 本来有「新建态未选 Agent 不允许发送」的保护（`components/chat/ChatInput.vue:287`），自动回填让该保护事实上失效。
2. **对话中零身份**：所有 Agent 选择器都挂在 `isNewTask` 条件下（`ChatNewTaskConfigBar.vue:3`、`ChatMobileConfigRow.vue:4`、`ChatInputToolbar.vue:15`），已有会话工具条只显示工作区与模型；消息区不渲染 Agent 头像或名称。
3. **唯一可见处极弱**：`TaskInspector.vue:88-93` 把 Agent 名称压在「工作区」分区首行，与文件夹路径共用 `workspace-path`（等宽字体、caption 字号、48% 灰），且右栏折叠时整块 `display:none`（`TaskInspector.vue:971-973`）。
4. **选错不可纠正**：`PATCH /v1/sessions/:id` 只支持 title/summary/projectKey/permissionLevel/memoryInjection/modelId（`backend-ts/src/session/session.routes.ts:370-388`），改不了 `agentId`。因此本次改造的目标是「让用户尽早自己发现」，纠错能力单独立项。

### 1.2 可用的数据与既有能力

| 项 | 现状 | 位置 |
|---|---|---|
| 会话当前 Agent ID | `agentId` ref（字符串），`loadSession` 时由 `GET /v1/sessions/:id` 回填 | `TaskView.vue:108`、`:936` |
| 会话 Agent 名称 | `agentName` ref，由 `ChatPanel` 经 `syncChatState` 上抛（`useChat` 从会话数据取） | `TaskView.vue:137`、`:182-194`、`useChat.ts:982` |
| Agent 头像 / 描述 | `loadSession` 已调用 `agentStore.fetchAgent(agentId)`，结果落在 `activeAgent`（含 `name`/`avatarUrl`/`description`） | `TaskView.vue:949`、`stores/agent.ts:6-14` |
| 列表兜底 | `agentStore.agents`（`GET /v1/agents`，已过滤停用）+ `getAgentById` | `stores/agent.ts:70-72` |
| 头像 URL 解析 | `resolveAvatarUrl`（相对路径拼 API base） | `utils/avatar.ts` |
| 设计 token | `--aw-*` 全套（颜色/圆角/字号/分割线），暗色由 `[data-theme="dark"]` 统一覆盖 | `style.css:5-118`、`:304+` |
| 右栏折叠 | `rightCollapsed` 模块级 ref，移动端默认折叠；折叠 = 整块不渲染 | `composables/usePanelLayout.ts:8-20`、`TaskInspector.vue:971-973` |
| 右栏定向能力 | `TaskInspector` 已有 `defineExpose({ revealInFileTree, refreshFileTree })` 与 `TaskInspectorInstance` 接口 | `TaskInspector.vue:780`、`TaskView.vue:558-566` |

### 1.3 关键约束

1. `agentName` 只在 `ChatPanel` 挂载并加载完会话后才有值；`activeSessionId` 在 `loadSession` 成功后才切换。**切换会话的窗口期内 `agentId`/`agentName` 仍是上一个会话的值**，直接渲染会显示错误 Agent——比不显示更糟，必须用 `activeSessionId === 路由 sessionId` 做就绪判定。
2. 右栏折叠是 `display:none` 而非图标条，**不存在**可挂头像的折叠态容器。原提案里的「折叠态头像」改为身份条右端「详情」按钮（点击展开右栏并滚动到 Agent 分区），避免与 `TopNav` 已有的右栏开关重复造控件。
3. 移动端可折叠右栏默认关闭（`usePanelLayout.ts:8`），所以移动端必须靠顶部身份条 + 工具条头像覆盖。
4. `TaskInspector` 目前只接 `agentName`，没有 `agentId`；需要新增 prop 才能取到头像/描述。

## 2. 目标与非目标

### 2.1 目标

1. 已有会话中，Agent 身份在**顶部、输入框旁、右栏**三处常驻可见，任意一处都能回答「我正在和谁对话」。
2. 身份展示严格只读：不新增写接口、不改变会话归属、不引入新的选择入口。
3. 降级不误导：头像缺失、描述缺失、Agent 已停用/删除、共享 Agent、加载中，各有确定的展示形态。
4. 桌面与移动端（≤768px）均不破坏现有布局，暗色模式与浅色一致。

### 2.2 非目标

- 不做会话内切换 Agent（需后端支持 + 上下文/模型取舍，独立方案）。
- 不调整新建会话的默认 Agent 策略（P1，建议「多 Agent 时不自动回填」）。
- 不在会话列表加 Agent 标签（P1）。
- 不给消息气泡加 Agent 头像（可选增强，本次不做）。
- 不改会话 VO 接口（头像/描述走已有前端 store）。
- 不改 `AgentChip`（新建态选择器），避免把只读展示与可选交互耦合。

## 3. 总体设计

### 3.1 三处落点的信息层级

桌面（右栏展开）：

```
┌─ 左：会话列表 ─┬──────────────── 中：会话区 ────────────────┬─ 右：任务 ─┐
│                │  ● 文档助手   负责合同与制度问答的写作助手  详情 │  智能体    │  ← ① 身份条 40px
│                │ ─────────────────────────────────────────  │  [头像]   │
│                │  [会话] [文件] [Git]                       │  文档助手  │  ← ④ 独立分区
│                │ ─────────────────────────────────────────  │  负责…    │
│                │                                            │ ─────────  │
│                │            消息流 …                        │  工作区    │
│                │                                            │  /path…   │
│                │  ┌──────────────────────────────────────┐  │           │
│                │  │ +  ● 文档助手   云端    模型 ▾    ➤  │  │           │  ← ② 工具条徽标
└────────────────┴──┴──────────────────────────────────────┴───────────┘
```

移动端（≤768px，右栏默认折叠）：

```
┌──────────────────────────────┐
│ ● 文档助手                    │  ← ① 身份条 36px（描述隐藏）
├──────────────────────────────┤
│        消息流 …               │
│  + ●(头像)   云端  模型  ➤   │  ← ② 工具条只留头像
└──────────────────────────────┘
```

### 3.2 数据流

```
GET /v1/sessions/:id ──► agentId(ref)
                            │
GET /v1/agents/:id ──► agentStore.activeAgent（loadSession 已拉，校验 id 一致）
                            │
GET /v1/agents   ──► agentStore.agents（列表兜底）
                            │
useChat(会话数据) ──► agentName(ref，名称兜底)
                            ▼
        resolveAgentIdentity()（纯函数，可单测）
                            ▼
        AgentIdentity { id, name, avatarUrl, description, resolved }
                            ▼
   SessionAgentBar（顶部） / AgentBadge（工具条） / AgentBadge（右栏分区）
```

- 三个落点共用 `AgentAvatar + AgentBadge`，数据源统一为 `resolveAgentIdentity`，避免同一会话三处显示不一致。
- 不使用后端新增字段：`session_vo` 只下发 `agentName`（`session-vo.ts:233-235`），头像与描述由前端 store 补齐；取不到时按 §3.4 降级。

### 3.3 交互规则

| 元素 | 行为 |
|---|---|
| 顶部身份条整条 | 可点击，等价于「详情」：展开右栏（若折叠）→ 切到「任务」tab → 滚动到 Agent 分区 |
| 顶部「详情」按钮 | 同上，键盘可达（`<button>`） |
| 工具条徽标 | 同上；移动端仅头像，点击同样是「详情」 |
| 右栏分区 | 纯展示，不可点击、不提供「切换」（P2 才做） |
| 长名称 | 名称 `max-width` + `text-overflow: ellipsis`；`title` 属性给全称 + 描述 |
| 悬停 | 显示原生 tooltip（`title`），不引入额外浮层组件 |

### 3.4 降级矩阵

| 场景 | 头像 | 名称 | 描述 | `resolved` | 额外标记 |
|---|---|---|---|---|---|
| 正常（activeAgent 命中） | 有则显示 | Agent 名 | 有则显示 | true | — |
| activeAgent 未命中但列表命中 | 有则显示 | Agent 名 | 有则显示 | true | — |
| Agent 已停用/删除（列表不含） | 首字母 fallback | `agentName` 兜底 | 不显示 | false | 灰色「已停用或不可见」徽标 |
| `agentName` 也为空 | 问号 fallback | `未知智能体` | 不显示 | false | 同上 |
| 会话切换中（activeSessionId ≠ 路由 id） | 骨架圆点 | 骨架条 | 不显示 | — | 仅占位，不显示旧 Agent |
| 新建态 | 整条不渲染 | — | — | — | — |
| `agentId` 为空（历史/系统会话，无归属 Agent） | 整条不渲染 | — | — | — | — |
| 无头像 URL | 首字母（首字符大写原样，中文取首字） | 正常 | 正常 | true | — |

> `resolved: false` 时仍展示名称（哪怕来自 `agentName`），因为「名字对但没头像」比「什么都不显示」有用；灰字标记只提示「详情拿不到」，不打断使用。

## 4. 详细改造

### 4.1 新增 `utils/agent-identity.ts`（纯函数 + 类型）

```ts
export interface AgentLike {
  id: string
  name: string
  avatarUrl?: string | null
  description?: string | null
}

export interface AgentIdentity {
  id: string | null
  name: string
  avatarUrl: string | null
  description: string | null
  /** 是否命中真实 Agent 记录（false = 只有名称兜底，需提示「已停用或不可见」） */
  resolved: boolean
}

export const UNKNOWN_AGENT_NAME = '未知智能体'

/**
 * 解析当前会话的 Agent 身份。
 * 优先级：activeAgent（须与 agentId 一致）→ agents 列表 → agentName 兜底 → 未知。
 */
export function resolveAgentIdentity(input: {
  agentId?: string | null
  fallbackName?: string | null
  activeAgent?: AgentLike | null
  agents?: AgentLike[]
}): AgentIdentity
```

规则：

1. `agentId` 为空 → `{ id: null, name: trim(fallbackName) || '', ..., resolved: false }`（调用方按 `agentId` 为空直接不渲染，不做占位）。
2. `activeAgent && String(activeAgent.id) === String(agentId)` → 用 activeAgent，`resolved = true`。
3. `agents.find(a => String(a.id) === String(agentId))` → 用它，`resolved = true`。
4. 否则 → `name = trim(fallbackName) || UNKNOWN_AGENT_NAME`，`resolved = false`。
5. 名称统一 `trim()`；空串按缺失处理。

单测点（`utils/agent-identity.test.ts`）：4 条优先级、id 类型不一致（`'12'` vs `12` 已在类型上规避，但保留 `String()` 比较）、名称空白、activeAgent 指向另一个 Agent 时必须忽略。

### 4.2 新增 `components/agent/AgentAvatar.vue`

```vue
<template>
  <img v-if="resolvedUrl" :src="resolvedUrl" :alt="name" class="agent-avatar" :style="boxStyle" />
  <span v-else class="agent-avatar agent-avatar-fallback" :style="boxStyle">{{ initial }}</span>
</template>
```

| prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `name` | `string` | `''` | fallback 取首字符 |
| `avatarUrl` | `string \| null` | `null` | 经 `resolveAvatarUrl` 处理 |
| `size` | `number` | `22` | 头像直径 px，内部用 `width/height` + `font-size = round(size * 0.44)` |

样式与 `AgentChip` 的 `.chip-avatar` / `.chip-avatar-fallback` 对齐（`AgentChip.vue:211-232`）：圆形、`background: var(--aw-primary)`、字色 `var(--aw-on-primary)`、`font-weight: 600`、`object-fit: cover`。**不回改 AgentChip**（其 fallback 字号 9px 是控件尺寸特例），只保证颜色/圆角一致。

### 4.3 新增 `components/agent/AgentBadge.vue`

只读身份徽标，**工具条与右栏分区共用**（顶部身份条复用 `AgentAvatar` 与同一套解析，不复用本组件的 DOM）。

```vue
<template>
  <span class="agent-badge" :class="[`size-${size}`, { 'is-unresolved': !identity.resolved }]">
    <AgentAvatar :name="identity.name" :avatar-url="identity.avatarUrl" :size="avatarSize" />
    <span class="agent-badge-text">
      <span class="agent-badge-name" :title="tooltip">{{ identity.name }}</span>
      <span v-if="showDescription && identity.description" class="agent-badge-desc">{{ identity.description }}</span>
    </span>
    <span v-if="!identity.resolved" class="agent-badge-hint">已停用或不可见</span>
  </span>
</template>
```

根元素刻意用 `<span>`：工具条要把徽标包在 `<button class="toolbar-agent">` 里，`div` 会构成非法嵌套。

| prop | 类型 | 默认 | 说明 |
|---|---|---|---|
| `agentId` | `string \| null` | `null` | 来自会话 |
| `agentName` | `string \| null` | `null` | 会话 VO 的 `agentName`，名称兜底 |
| `size` | `'sm' \| 'md' \| 'lg'` | `'md'` | 头像 18 / 22 / 36px；字号 12 / 13 / 13px |
| `showDescription` | `boolean` | `false` | 右栏分区与桌面身份条开启 |
| `avatarOnly` | `boolean` | `false` | 只渲染头像（移动端工具条），名称走 `aria-label` |

内部：

```ts
const agentStore = useAgentStore()
const identity = computed(() => resolveAgentIdentity({
  agentId: props.agentId,
  fallbackName: props.agentName,
  activeAgent: agentStore.activeAgent,
  agents: agentStore.agents,
}))
const avatarSize = computed(() => ({ sm: 18, md: 22, lg: 36 }[props.size]))
const tooltip = computed(() => [identity.value.name, identity.value.description].filter(Boolean).join(' · '))
```

`avatarOnly` 模式只渲染 `AgentAvatar`，外层补 `role="img"` + `:aria-label="identity.name"`；其余模式名称与描述直接可读，无需额外 aria。

不主动请求接口：`loadSession` 已拉 `activeAgent`；列表由新建态/设置页拉取，缺失时按 §3.4 降级即可。

### 4.4 新增 `components/agent/SessionAgentBar.vue`

```vue
<template>
  <div v-if="visible" class="session-agent-bar" :class="{ 'is-mobile': isMobileViewport }">
    <!-- 会话切换/加载中：只占位，绝不显示上一个会话的 Agent -->
    <div v-if="!ready" class="bar-skeleton" aria-busy="true">
      <span class="sk-avatar" />
      <span class="sk-line" />
    </div>
    <template v-else>
      <button type="button" class="bar-main" :title="tooltip" @click="emit('open-detail')">
        <AgentAvatar :name="identity.name" :avatar-url="identity.avatarUrl" :size="22" />
        <span class="bar-name">{{ identity.name }}</span>
        <span v-if="identity.description && !isMobileViewport" class="bar-desc">{{ identity.description }}</span>
        <span v-if="!identity.resolved" class="bar-hint">已停用或不可见</span>
      </button>
      <span class="bar-spacer" />
      <button type="button" class="bar-detail" @click="emit('open-detail')">
        {{ isMobileViewport ? '详情' : '查看智能体' }}
      </button>
    </template>
  </div>
</template>
```

| prop | 类型 | 说明 |
|---|---|---|
| `agentId` | `string \| null` | 会话 Agent |
| `agentName` | `string \| null` | 名称兜底 |
| `sessionId` | `string \| null` | 当前路由会话 |
| `activeSessionId` | `string \| null` | store 中的就绪会话，用于防串台 |
| `loading` | `boolean` | 历史加载中 |

```ts
const identity = computed(() => resolveAgentIdentity({
  agentId: props.agentId,
  fallbackName: props.agentName,
  activeAgent: agentStore.activeAgent,
  agents: agentStore.agents,
}))
const visible = computed(() => !!props.agentId && !!props.sessionId && !props.loading)
const ready = computed(() => String(props.activeSessionId || '') === String(props.sessionId || ''))
```

- 身份条**不复用 `AgentBadge` 的 DOM**（需要「整条可点 + 右侧独立按钮」的布局，嵌套 `<button>` 不合规），但身份解析必须共用 `resolveAgentIdentity`，不得另写一套优先级。
- `visible && !ready` → 渲染骨架（同高灰条，`aria-busy="true"`），不渲染任何名称；
- `visible && ready` → 正常渲染；`agentId` 为空（历史/系统会话无归属 Agent）时整条不渲染，避免出现占位文案「Agent」。

尺寸与样式：

| 项 | 桌面 | 移动（≤768px） |
|---|---|---|
| 高度 | 40px | 36px |
| 内边距 | `0 12px` | `0 10px` |
| 头像 | 22px | 20px |
| 名称 | `--aw-text-caption`（14px）→ 覆盖为 13px、500 | 12px、500 |
| 描述 | `--aw-text-fine`（12px）、`--aw-ink-muted-48`、`max-width: 40vw` 单行省略 | 隐藏 |
| 底部 | `1px solid var(--aw-divider-soft)` | 同 |
| 背景 | `var(--aw-canvas)` | 同 |
| 布局 | `display:flex; align-items:center; gap:8px; flex-shrink:0` | 同 |

键盘可达性：两个 `button` 均保留默认焦点环；容器不加 `tabindex`。

### 4.5 `TaskView.vue` 接入

模板（`task-container` 内、`CenterTabBar` 之前）：

```vue
<div class="task-container">
  <SessionAgentBar
    v-if="!isNewTaskMode"
    :agent-id="agentId || null"
    :agent-name="agentName || null"
    :session-id="sessionId"
    :active-session-id="sessionStore.activeSessionId"
    :loading="initialLoading"
    @open-detail="openAgentInspector"
  />
  <CenterTabBar v-if="tabs.length > 1" ... />
  <CenterTabContainer ... />
</div>
```

脚本：

```ts
const { leftCollapsed: panelCollapsed, rightCollapsed, toggleRight } = usePanelLayout()
const inspectorRef = ref<TaskInspectorInstance | null>(null)

function openAgentInspector() {
  if (rightCollapsed.value) toggleRight()
  void nextTick(() => inspectorRef.value?.focusAgentSection())
}

// 供 ChatPanel / 工具条徽标复用「展开右栏并定位 Agent 分区」
provide('openAgentInspector', openAgentInspector)
```

说明：

- 放在 `CenterTabBar` **之上**：身份是会话级信息，tab 是视图级信息；文件/Git tab 激活时身份条仍应可见。
- 身份条不参与 `KeepAlive`（在 TaskView 内，天然随路由切换重建）。
- `initialLoading` 已由 TaskView `provide` 给 ChatPanel（`TaskView.vue:159`），此处直接复用；`sessionStore.activeSessionId` 已有（`stores/session/list.ts:90`）。

### 4.6 `ChatPanel` / `ChatInput` / `ChatInputToolbar` 接入

`ChatPanel`（docked 态输入区）新增两个 prop 透传：

```vue
<ChatInput
  ...
  :session-agent-id="isNewTaskMode ? null : (agentId || null)"
  :session-agent-name="isNewTaskMode ? null : agentName"
  @open-agent-detail="openAgentInspector"
/>
```

`ChatInput` 增加 `sessionAgentId` / `sessionAgentName` props 与 `open-agent-detail` emit，透传给 `ChatInputToolbar`。

`ChatPanel` 侧通过 `inject('openAgentInspector')` 拿到 TaskView 提供的回调（与 `chatFocusInput` 同风格）：

```ts
const openAgentInspector = inject<() => void>('openAgentInspector')!
```

`ChatInputToolbar` 在 `toolbar-left` 的 `+` 之后插入（仅非新建态）：

```vue
<button
  v-if="sessionAgentId"
  type="button"
  class="toolbar-agent"
  :title="`当前智能体：${sessionAgentName || ''}`"
  @click="emit('openAgentDetail')"
>
  <AgentBadge
    :agent-id="sessionAgentId"
    :agent-name="sessionAgentName"
    :size="isMobileViewport ? 'sm' : 'md'"
    :avatar-only="isMobileViewport"
  />
</button>
```

- 桌面：头像 + 名称（`max-width: 120px` 省略），高度 24px，`border-radius: var(--aw-radius-pill)`，hover 背景 `var(--aw-primary-hover)`。
- 移动（≤768px）：`avatar-only` 只渲染 18px 头像（外层按钮 24×24），避免与「云端/工作区」指示、模型选择器抢宽度（375px 下新增宽度 ≤ 32px）。
- 新建态不显示：`ChatPanel` 在该分支传 `null`，同时桌面 centered 态已有可选 `AgentChip`，两者不会同时出现。

`openAgentInspector` 需要从 `TaskView` 传到 `ChatPanel`：沿用现有 `provide/inject` 模式，新增 `provide('openAgentInspector', fn)`，与 `chatFocusInput` 同风格（`TaskView.vue:200-201`）。

### 4.7 `TaskInspector` 独立分区

模板：在 `task-info-section` 之后、原「工作区」分区之前插入：

```vue
<div ref="agentSectionEl" v-if="agentId || agentName" class="inspector-section agent-section">
  <h4 class="section-title">智能体</h4>
  <AgentBadge
    :agent-id="agentId || null"
    :agent-name="agentName || null"
    size="lg"
    show-description
  />
</div>
```

同时删除工作区分区里的 Agent 行，并把条件收敛：

```diff
- <div v-if="workspace || agentName || showEnvVarsEntry" class="inspector-section">
+ <div v-if="workspace || showEnvVarsEntry" class="inspector-section">
    <h4 class="section-title">工作区</h4>
-   <div v-if="agentName" class="task-workspace-row">
-     <el-icon class="workspace-icon"><User /></el-icon>
-     <span class="workspace-path">{{ agentName }}</span>
-   </div>
```

脚本：

```ts
const props = defineProps<{ ...; agentId?: string | null }>()   // 新增
const agentSectionEl = ref<HTMLElement | null>(null)

function focusAgentSection() {
  inspectorActiveTab.value = 'workspace'
  void nextTick(() => agentSectionEl.value?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }))
}

defineExpose({ revealInFileTree, refreshFileTree, focusAgentSection })
```

`TaskView` 侧同步：

```ts
interface TaskInspectorInstance {
  revealInFileTree(relPath: string): Promise<void>
  refreshFileTree(): void
  focusAgentSection(): void
}
```

模板传参：`:agent-id="isNewTaskMode ? null : (agentId || null)"`。

分区样式（`TaskInspector` 的 scoped style，新增）：

```css
.agent-section .agent-badge { gap: 10px; }
.agent-section .agent-badge-desc {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

注意：`.section-title` 现有样式带 `text-transform: uppercase`（`TaskInspector.vue:1022-1029`），中文不受影响，保持与「工作区」「进度」一致，不单独改。

### 4.8 设计 token 使用清单

| 用途 | token |
|---|---|
| 身份条背景 | `--aw-canvas` |
| 分割线 | `--aw-divider-soft` |
| 名称文字 | `--aw-ink` |
| 描述/次要文字 | `--aw-ink-muted-48` |
| 徽标 hover | `--aw-primary-hover` |
| 头像 fallback | `--aw-primary` + `--aw-on-primary` |
| 徽标边框 | `--aw-hairline` |
| 圆角 | `--aw-radius-pill`（胶囊）/ `50%`（头像） |
| 字号 | `--aw-text-caption` / `--aw-text-fine` |
| 焦点环 | `--aw-primary-ring` |

不新增硬编码色值；暗色模式由现有 `[data-theme="dark"]` token 覆盖，无需额外选择器。

## 5. 边界与异常

| # | 场景 | 处理 |
|---|------|------|
| 1 | 新建会话（`isNewTaskMode`） | 身份条不渲染；工具条不渲染只读徽标（新建态已有可选的 `AgentChip`/`AgentSelector`） |
| 2 | 会话切换窗口期 | `activeSessionId !== 路由 sessionId` → 身份条展示同高骨架，绝不显示上一个会话的 Agent |
| 3 | 历史加载中 | `initialLoading === true` → 同上骨架 |
| 4 | 会话 Agent 已停用或用户不可见 | `resolved = false`：名称用 `agentName` 兜底，灰色「已停用或不可见」标记，不阻塞展示 |
| 5 | `agentName` 与 store 都拿不到 | 显示「未知智能体」，仍保留入口（点击可看右栏分区，那里同样显示未知） |
| 6 | Agent 无头像 | 首字母圆形 fallback（中文取首字，英文取首字母大写），与 `AgentChip` 同色系 |
| 7 | 长名称 / 长描述 | 名称单行省略 + `title` 全称；描述桌面单行省略、右栏两行截断 |
| 8 | 右栏折叠 | 身份条「查看智能体」按钮展开右栏并定位分区；工具条徽标同一行为 |
| 9 | 移动端右栏默认折叠 | 顶部身份条（36px）+ 工具条纯头像已覆盖，不新增抽屉 |
| 10 | 边路任务 / 子代理 tab | 身份条属于主会话视图，保持显示主会话 Agent；子代理面板自身不改（其归属由子代理列表表达） |
| 11 | 分享/只读会话 | 身份展示不依赖权限，正常显示（不改动任何写操作） |
| 12 | 多窗口 | `agentId` / `agentName` 是 `TaskView` 局部 ref，不跨窗口共享；仅 `usePanelLayout` 的折叠状态是模块级（与现状一致） |
| 13 | 极窄窗口（<420px） | 身份条名称 `max-width: 45vw`，描述隐藏；「查看智能体」降级为「详情」二字 |
| 14 | 暗色模式 | 全部走 token，无硬编码色值；验收时切 `[data-theme="dark"]` 目视确认对比度 |
| 15 | 键盘弹出（移动端） | 身份条在 flex 顶部不参与滚动，输入区压缩时仍可见；工具条头像不额外增加高度 |
| 16 | `agentId` 为空（`useChat` 对无归属会话会把 `agentName` 兜底成字面量 `Agent`，见 `composables/useChat.ts:175`） | 身份条与工具条徽标都按 `agentId` 为空直接不渲染，避免出现「Agent」这类无意义占位 |

## 6. 测试与验收

### 6.1 单元测试（vitest）

新增 `desktop/src/utils/agent-identity.test.ts`：

1. `activeAgent` 命中且 id 一致 → 返回其 name/avatar/description，`resolved = true`。
2. `activeAgent` 存在但 id 不一致 → 忽略，落到 `agents` 列表。
3. `agents` 命中 → `resolved = true`。
4. 都未命中但有 `fallbackName` → `name = fallbackName`，`resolved = false`。
5. 都未命中且 `fallbackName` 为 `'  '` → `name = '未知智能体'`，`resolved = false`。
6. `agentId` 为空 → `id = null`、`resolved = false`；若同时传了 `fallbackName`，`name` 仍回填（调用方按 `agentId` 为空直接不渲染，不会展示）。

运行：`cd mao/desktop && npx vitest run src/utils/agent-identity.test.ts`（全量：`npm run test:unit`）。

### 6.2 E2E（Playwright，页面级 mock）

新增 `mao/tests/desktop-session-agent-identity.spec.ts`，归入 `desktop-visual` project（`testMatch: /desktop-.*\.spec\.ts$/`，`playwright.config.ts:33-39`），沿用 `desktop.spec.ts` 的 `page.route('**/api/v1/**')` mock 方式：

1. mock `GET /api/v1/sessions/101` → `{ id: 101, agentId: 7, agentName: '文档助手', ... }`；mock `GET /api/v1/agents/7` → `{ id: 7, name: '文档助手', avatarUrl: null, description: '负责合同与制度问答' }`。
2. 断言 `.session-agent-bar .bar-name` 文本为「文档助手」，`.bar-desc` 可见。
3. 断言工具条 `.toolbar-agent` 存在，且 `button[title*="文档助手"]`。
4. 点击「查看智能体」→ 断言右栏 `.agent-section` 可见且包含「智能体」「文档助手」。
5. 再 mock 一个 `agentId: 8` 且 `/agents/8` 404 的会话：断言名称回退、`.bar-hint` 显示「已停用或不可见」。
6. 视口切 375×812：断言 `.bar-desc` 隐藏、`.toolbar-agent` 无文字节点（仅头像）。

运行：`cd mao && npx playwright test --config=tests/playwright.config.ts --project=desktop-visual`（`global-setup.ts` 自动拉起隔离后端 :9180 与前端 :5200/:5201，无需手动起服务）。

### 6.3 手工验收清单

- [ ] 桌面 1280×800：新建会话发首条消息 → 身份条出现正确 Agent 名与描述，输入框工具条同步出现同名徽标。
- [ ] 会话 A（Agent 甲）↔ 会话 B（Agent 乙）来回切换 5 次：身份条无一次显示错 Agent（切换期间为骨架）。
- [ ] 右栏折叠 → 点身份条「查看智能体」→ 右栏展开、定位到「智能体」分区；再点工具条徽标行为一致。
- [ ] 右栏「工作区」分区不再出现 Agent 名称行，`智能体` 分区位于最上方。
- [ ] 无头像 Agent：显示首字母圆形，颜色与新建态 `AgentChip` 一致。
- [ ] 超长 Agent 名（>30 字）+ 超长描述：名称省略 + hover 全称，布局不抖动。
- [ ] 暗色模式目视检查三处文字对比度与分割线。
- [ ] 移动端 375×812（Chrome 设备模拟）：身份条 36px、描述隐藏、工具条仅头像；软键盘弹出后身份条仍可见。
- [ ] 文件 tab / Git tab 激活时身份条仍显示。
- [ ] 边路任务 tab、子代理面板正常渲染，无控制台报错。

### 6.4 回归检查

| 项 | 关注点 |
|---|---|
| 新建态 Agent 选择 | `AgentChip` / `AgentSelector` 未被改动，过滤、选中、移动端 popover 行为不变 |
| 右栏 tab 切换 | 新增分区不影响「任务 / 文件 / Git」切换与 tab bar 显示条件 |
| 文件树 / Git 操作 | `revealInFileTree`、`refreshFileTree` 的 `defineExpose` 仍导出（新增方法不改旧签名） |
| 会话导入/导出、分享 | 不涉及会话数据写入，无影响 |
| 移动端布局 | `toolbar-left` 宽度预算：`+`(30) + 徽标(24) + 工作区指示(≤160) + gap ≤ 375 - padding 24 - 右侧模型/发送(≈134) = 217 → 工作区文本省略显示，不换行、不溢出。若实测 `.workspace-indicator span` 不收缩，在 768px 断点内补 `min-width: 0`（仅样式，不动结构） |

## 7. 发布与回滚

1. 纯前端改动，后端无变更、无数据库迁移。
2. 合并后按 Mao 独立流程：提交并 push 到 `origin/main` → `cd /data && bash deploy-mao.sh --frontend-only`（或完整 `deploy-mao.sh`）。
3. 生效方式：Web/桌面刷新页面即可，安卓为同源远程加载，刷新即生效，无需 OTA。
4. 回滚：`git revert` 本次提交后重新部署前端；无数据兼容问题。
5. 交付物同步：
   - 根 `CHANGELOG.md` 顶部新增一条「前端（桌面 / Web / 安卓）」条目：会话顶部新增 Agent 身份条、输入栏常驻 Agent 徽标、右栏新增「智能体」分区。
   - `skills/mao-cli/reference/desktop.md` 补充三处身份展示与「查看智能体」入口的说明（如该文档有界面结构章节则就近插入）。

## 8. 工作量估算

| 任务 | 文件 | 预估 |
|---|---|---|
| 身份解析纯函数 + 单测 | `utils/agent-identity.ts`、`utils/agent-identity.test.ts` | 0.2 人天 |
| 头像与徽标组件 | `components/agent/AgentAvatar.vue`、`AgentBadge.vue` | 0.3 人天 |
| 顶部身份条 + TaskView 接入 + 详情联动 | `components/agent/SessionAgentBar.vue`、`TaskView.vue` | 0.4 人天 |
| 工具条徽标（含移动端降级） | `ChatPanel.vue`、`ChatInput.vue`、`ChatInputToolbar.vue` | 0.2 人天 |
| 右栏独立分区 + `focusAgentSection` | `TaskInspector.vue` | 0.2 人天 |
| E2E + 手工验收 + 文档/CHANGELOG | `tests/desktop-session-agent-identity.spec.ts`、`CHANGELOG.md`、`skills/mao-cli/reference/desktop.md` | 0.3 人天 |
| **合计** | | **约 1.6 人天** |

## 9. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| 身份条在移动端占 36px 高度 | 消息可视区域变小 | 描述隐藏、字号降级；若实测拥挤，可加「滚动时收起」的后续优化（本次不做） |
| 工具条宽度不足 | 工作区名被压缩 | 移动端仅头像（≤32px）；桌面名称 `max-width: 120px`；工作区指示保留自身 160px 上限并自动省略 |
| 会话切换瞬间显示旧 Agent | 误导性比不显示更强 | 用 `activeSessionId === sessionId` 判定就绪，未就绪一律骨架 |
| `activeAgent` 为全局单例，可能被其他流程覆写 | 三处显示不一致 | 每次渲染校验 `String(activeAgent.id) === agentId`；同时用 `agents` 列表兜底 |
| 三个落点重复实现导致样式漂移 | 视觉不统一 | 统一走 `AgentAvatar` + `AgentBadge`，尺寸仅由 `size` 控制 |
| 视觉噪音（同屏三处 Agent 名） | 用户觉得啰嗦 | 三处信息密度递减：身份条「名+描述+入口」→ 工具条「头像+名」→ 右栏「头像+名+描述」；不做第四处（消息气泡） |

## 10. 后续（不在本次范围）

1. **新建态取消静默默认**（P1）：多 Agent 时默认不选，让 `ChatInput.vue:287` 的「未选 Agent 不允许发送」生效；或保留默认但在选择器与 placeholder 标注「默认」。
2. **会话列表 Agent 标签**（P1）：条目加 Agent 胶囊，配色取自 Agent 名哈希；不改现有工作区分组与别名逻辑。
3. **会话内切换 Agent**（P2）：`PATCH /v1/sessions/:id` 增加 `agentId`；`harness-service.buildContext` 每轮按 `session.agentId` 重读 Agent（`harness/core/harness-service.ts:299-330`），技术上可行，但需处理「会话 `modelId` 优先于新 Agent 默认模型」与历史上下文继承提示，并插入系统消息说明切换。
4. **「以正确 Agent 重开」**（P2）：复制工作区 + 最近 N 轮摘要 + 模型/权限到新会话，旧会话归档。
5. **效果度量**：埋点新建会话后 3 分钟内新建第二条的比例、右栏 Agent 分区点击率，用于验证「选错率」是否下降。

## 附录 A 代码位置索引

| 主题 | 位置 |
|---|---|
| Agent 名称的唯一现有展示 | `desktop/src/components/task/TaskInspector.vue:88-93` |
| 右栏折叠即隐藏 | `TaskInspector.vue:971-973` |
| 会话 Agent ID 回填 | `desktop/src/views/task/TaskView.vue:108`、`:936` |
| 会话 Agent 名称上抛 | `TaskView.vue:137`、`:182-194`；`composables/useChat.ts:982-984` |
| `activeAgent` 拉取 | `TaskView.vue:949`；`stores/agent.ts:35-60` |
| Agent 列表与头像解析 | `stores/agent.ts:6-14`、`:70-72`；`utils/avatar.ts` |
| 新建态默认 Agent 回填 | `TaskView.vue:811-814` |
| 新建态未选拦截 | `components/chat/ChatInput.vue:287` |
| Agent 选择器仅新建态 | `ChatNewTaskConfigBar.vue:3`、`ChatMobileConfigRow.vue:4`、`ChatInputToolbar.vue:15` |
| 工具条结构与宽度 | `ChatInputToolbar.vue:4-56`；`components/chat/chat-input.css:264-350` |
| 右栏实例接口 | `TaskView.vue:558-566`；`TaskInspector.vue:780` |
| 设计 token | `desktop/src/style.css:5-118`、`:304+` |
| 会话 VO 的 Agent 字段 | `backend-ts/src/session/session-vo.ts:25-26`、`:233-235` |
| PATCH 会话不支持改 Agent | `backend-ts/src/session/session.routes.ts:370-388` |
| 运行时按会话重读 Agent | `backend-ts/src/harness/core/harness-service.ts:299-330` |

## 附录 B 组件契约速查

```ts
// AgentAvatar.vue
{ name: string; avatarUrl?: string | null; size?: number }

// AgentBadge.vue
{
  agentId?: string | null
  agentName?: string | null
  size?: 'sm' | 'md' | 'lg'
  showDescription?: boolean
  avatarOnly?: boolean
}

// SessionAgentBar.vue
{
  agentId?: string | null
  agentName?: string | null
  sessionId?: string | null
  activeSessionId?: string | null
  loading?: boolean
}
// emits: open-detail

// TaskInspector 新增
props.agentId?: string | null
expose.focusAgentSection(): void
```
