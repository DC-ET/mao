# OpenCode TUI 实现研究文档

> 研究对象：[opencode-ai/opencode](https://github.com/opencode-ai/opencode)（Go）
> 目标：理解其终端交互架构，对比 mao-agent 现状，提出改进方案。

---

## 1. 核心架构：Bubble Tea + 全屏重绘模型

OpenCode 使用 Charm 家族的 **Bubble Tea**（Elm Architecture）作为 TUI 框架。核心思想是：

```
Model (状态) → Update(Msg) → (新Model, Cmd) → View() → 整屏字符串 → Bubble Tea 渲染
```

### 1.1 全屏重绘，而非逐行操控

Bubble Tea 的渲染机制是：**每次 `View()` 返回整个屏幕的字符串**，Bubble Tea 引擎负责 diff 并输出最小 ANSI 变化序列。开发者不需要手写 `\x1b[K`、`\r`、光标定位等控制序列。

```go
// tui.go - View() 返回完整画面
func (a appModel) View() string {
    components := []string{
        a.pages[a.currentPage].View(),  // 聊天页（含消息列表 + 编辑器）
        a.status.View(),                // 底部状态栏
    }
    appView := lipgloss.JoinVertical(lipgloss.Top, components...)
    // 叠加 overlay（权限对话框、帮助、退出确认等）
    if a.showPermissions {
        overlay := a.permissions.View()
        appView = layout.PlaceOverlay(col, row, overlay, appView, true)
    }
    return appView
}
```

### 1.2 Alt Screen + 虚拟滚动 = 解决 scrollback 问题

```go
// cmd/root.go
program := tea.NewProgram(
    tui.New(app),
    tea.WithAltScreen(),  // 进入备用屏
)
```

**关键点**：OpenCode **确实使用了 alt screen**，但它不依赖终端的 scrollback buffer 来保存历史。它使用 `bubbles/viewport` 组件实现**应用内虚拟滚动**：

- 所有消息渲染为一个大字符串，设置到 `viewport.SetContent()`
- `viewport` 管理可见区域和滚动偏移
- PageUp/PageDown/Ctrl+U/Ctrl+D 在应用内滚动，而非依赖终端 scrollback

```go
// list.go
type messagesCmp struct {
    viewport viewport.Model  // 虚拟滚动组件
    messages []message.Message
    // ...
}

// 消息更新时重新渲染内容到 viewport
func (m *messagesCmp) renderView() {
    // 将所有消息渲染为一个长字符串
    messages := make([]string, 0)
    for _, v := range m.uiMessages {
        messages = append(messages, v.content, "")
    }
    m.viewport.SetContent(
        lipgloss.JoinVertical(lipgloss.Top, messages...)
    )
}

func (m *messagesCmp) View() string {
    return lipgloss.JoinVertical(lipgloss.Top,
        m.viewport.View(),  // 只显示 viewport 可见部分
        m.working(),         // "Generating..." 状态
        m.help(),            // 按键提示
    )
}
```

### 1.3 布局系统：SplitPane + Container

```go
// page/chat.go - NewChatPage
layout.NewSplitPane(
    layout.WithLeftPanel(messagesContainer),   // 消息列表（viewport）
    layout.WithBottomPanel(editorContainer),   // 底部输入框
)
```

- **SplitPaneLayout**：支持上下/左右分割，按比例分配空间
- **Container**：包裹组件，提供 padding/border/背景色
- 底部编辑器固定高度（verticalRatio=0.9，底部占 10%），上方消息区占 90%
- 窗口大小变化时通过 `SetSize()` 级联传递

### 1.4 编辑器：bubbles/textarea

```go
// editor.go
ta := textarea.New()
ta.ShowLineNumbers = false
ta.CharLimit = -1
```

- 使用 `bubbles/textarea` 组件，支持多行编辑、光标移动
- Enter 发送（`\` 续行），Ctrl+E 打开外部编辑器
- 编辑器始终聚焦，消息列表的滚动键被拦截不传递给 textarea

### 1.5 消息渲染

- **Markdown**：使用 `charmbracelet/glamour` 渲染 Markdown（代码高亮、列表、标题等）
- **用户消息**：左边框（thick border）+ Secondary 色标识
- **助手消息**：左边框 + Primary 色标识，底部显示模型名和耗时
- **工具调用**：左边框 + TextMuted 色，显示工具名+参数+结果（结果截断到 maxResultHeight=10 行）
- **缓存**：按消息 ID 和宽度缓存渲染结果，避免重复渲染

### 1.6 状态栏

```go
// status.go - View()
func (m statusCmp) View() string {
    status := getHelpWidget()       // "ctrl+? help" 徽章
    status += tokensStyle.Render(tokens)  // Context: 1.2K, Cost: $0.05
    status += infoStyle.Render(msg)        // 临时信息/警告/错误
    status += diagnostics                 // LSP 诊断
    status += m.model()                   // 当前模型名
    return status
}
```

底栏是单行高度，水平排列多个信息块，整个 appModel 的 `View()` 用 `lipgloss.JoinVertical` 把页面内容和状态栏垂直拼接。

### 1.7 Overlay/模态对话框

通过 `layout.PlaceOverlay()` 在主画面上叠加内容（居中），不破坏底层布局。用于权限请求、会话切换、命令面板、帮助等。

---

## 2. 与 mao-agent 的对比

| 维度 | OpenCode (Go) | mao-agent (Node.js) |
|------|---------------|---------------------|
| **渲染模型** | 全屏重绘（Bubble Tea diff） | 逐行 ANSI 操控（手写 `\r`/`\x1b[K`/`\x1b[<n>A`） |
| **滚动** | 应用内 viewport 虚拟滚动 | 依赖终端 scroll region + 原生 scrollback（失败） |
| **布局** | SplitPane 比例分割 + Container | 手写 scroll region (`\x1b[r`) + 固定行定位 |
| **输入框** | bubbles/textarea（完整多行编辑） | 自写 InputController（单行拼接，功能有限） |
| **Markdown** | glamour（完整渲染） | renderMarkdownLite（简化版） |
| **状态管理** | Elm Architecture（Model-Update-View） | 命令式直接写 stdout/stderr |
| **alt screen** | 使用 + viewport 虚拟滚动 | 之前使用（无 viewport，内容丢失），已去掉但问题仍在 |
| **工具输出** | 左边框 + 参数摘要 + 结果截断 | box.ts 格式化，类似但功能较弱 |
| **模态** | PlaceOverlay 叠加 | 模态拦截按键，但无 overlay 视觉效果 |

### 2.1 mao-agent 的根本问题

mao-agent 之前的实现尝试用 **ANSI scroll region**（`\x1b[top;bottom r`）模拟"固定顶栏 + 滚动中间区 + 固定底栏"的布局。这个方案有根本缺陷：

1. **Scroll region 不扩展终端 scrollback**：终端的 scrollback buffer 只记录超出屏幕顶部的原始行。当 scroll region 激活时，光标被限制在中间区域，内容在区域内滚动，超出区域顶部的内容**不会进入 scrollback**，而是被丢弃。
2. **去掉 alt screen 后仍然不行**：因为 scroll region 仍然在拦截"溢出"的行。终端原生 scrollback 只对主屏的普通滚动有效，scroll region 模式下的内容不会正常推入 scrollback。
3. **手动 ANSI 操控脆弱**：`flushAssistantMarkdown` 用 `\x1b[<n>A` 回退行数重写已输出内容，容易在行数计算错误时破坏画面；流式输出和状态栏/输入框的刷新互相干扰。

---

## 3. 改进方案

### 方案 A：引入 Node.js TUI 框架（推荐）

参考 OpenCode 的架构，在 Node.js 生态中选择类似 Bubble Tea 的全屏重绘框架：

#### 候选框架

| 框架 | 说明 | 适合度 |
|------|------|--------|
| **Ink** (npm: ink) | React for CLI，全屏重绘模型，VDOM diff → ANSI | ★★★★★ |
| **blessed** | 终端 UI 框架，内置 widget | ★★★☆☆ |
| **neo-blessed** | blessed 的现代 fork | ★★★☆☆ |

**推荐 Ink**，原因：

1. **全屏重绘模型**：和 Bubble Tea 一样，`render()` 返回整个画面，Ink 负责 diff 和 ANSI 输出。不再需要手写 `\r`、`\x1b[K`、`\x1b[<n>A`。
2. **组件化**：用 React 组件描述 UI（`<Box>`、`<Text>`），天然支持嵌套布局。
3. **measured-layout**：Ink 内部用 Yoga 布局引擎做 flexbox 布局，自动处理宽度/高度分配，类似 lipgloss 的 JoinVertical/JoinHorizontal。
4. **focus 管理**：ink-text-input / ink-textarea 提供成熟的输入组件。
5. **广验证**：Vercel CLI、Cloudflare Wrangler、Gatsby 等大型 CLI 工具使用 Ink。
6. **useInput 钩子**：处理键盘事件，支持自定义快捷键和模态拦截。

#### 架构重构

```
agent-cli/src/
  tui/
    App.tsx           — 根组件，管理页面和模态
    ChatView.tsx      — 聊天页：消息列表 + 编辑器
    MessageList.tsx   — 消息虚拟滚动（用 ink 的 <Static> + <Box> overflow）
    Editor.tsx        — 输入框（ink-textarea 或自写）
    StatusBar.tsx      — 底部状态栏
    ToolCard.tsx      — 工具调用卡片
    UserMessage.tsx   — 用户消息块
    AssistantMessage.tsx — 助手消息块
    Modal/             — 模态对话框
    hooks/
      useStream.ts     — WS 流式事件 → 状态
      useSession.ts    — 会话管理
```

#### 滚动方案

Ink 提供两种方式处理历史内容：

1. **`<Static>` 组件**：内容一次性写入终端的 scrollback buffer（退出后仍可滚动查看），适合已完成的消息。
2. **应用内滚动**：在 `<Box height={N}>` 内管理滚动偏移，类似 viewport。

推荐混合方案：
- 已完成的消息 → `<Static>` 写入 scrollback（用户可终端原生滚动）
- 当前进行中的回合 → 在 `<Box>` 中动态渲染
- 底部固定编辑器 + 状态栏

这和 Claude Code 的体验完全一致：历史对话在 scrollback 里，底部输入框固定。

### 方案 B：修复现有 ANSI 操控（不推荐，短期补丁）

如果不想引入框架，需要做以下修改：

1. **完全移除 scroll region**（`\x1b[r`）：不设置滚动区域，让所有内容自然流式输出到主屏。
2. **放弃固定顶栏**：顶栏信息（session banner）只在启动时打印一次，进入 scrollback。
3. **底栏用 ANSI 定位而非 scroll region**：每次更新底栏时用 `\x1b[s`（保存光标）→ `\x1b[<row>;1H`（移到底行）→ 写入 → `\x1b[u`（恢复光标）。
4. **流式输出直接写 stdout**：不做 rewind 重渲染。
5. **Markdown 延迟渲染**：回合结束时一次性渲染，而非中途 rewind。

**问题**：这个方案本质上是退回到"简单流式输出"模式，无法实现 Claude Code 那样的"底部固定输入框 + 上方滚动"效果，因为 Node.js 没有类似 bubbles/viewport 的现成组件。

---

## 4. 结论与建议

### OpenCode 的核心思路

OpenCode 之所以能实现 Claude Code 级别的终端交互体验，核心在于：

1. **全屏重绘模型**（Bubble Tea）：开发者只描述"画面应该长什么样"，框架负责 ANSI diff，消除了手写控制序列的复杂性和脆弱性。
2. **应用内虚拟滚动**（viewport）：不依赖终端 scrollback，所有历史消息在 viewport 中管理，PageUp/PageDown 在应用内滚动。
3. **组件化布局**（SplitPane + Container + lipgloss）：声明式描述布局结构，自动处理尺寸分配。
4. **成熟组件**（textarea、spinner、viewport）：不需要自造轮子。

### mao-agent 的改进路径

**强烈推荐方案 A（Ink）**：

- Ink 的全屏重绘模型彻底解决 ANSI 操控脆弱问题
- `<Static>` 组件让历史对话进入终端原生 scrollback，实现 Claude Code 级体验
- React 组件化使 UI 代码可维护性大幅提升
- ink-textarea 等现成组件省去自造输入框

迁移工作量集中在 `ReplRenderer` → Ink 组件的映射，WS 事件处理逻辑（`SessionRunner`、`WsClient`、`event-filter`）可完全复用。

### 与 Claude Code 的对比

Claude Code（Anthropic 的 CLI 工具）使用类似架构：
- 全屏重绘（疑似自研或 Ink 变体）
- 历史内容写入 scrollback，底部固定输入框
- 流式输出时底部状态栏持续可见
- 回合结束后 Markdown 整段着色

Ink + `<Static>` 方案可以完全复现这个体验。
