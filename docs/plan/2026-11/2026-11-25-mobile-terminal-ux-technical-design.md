# 移动端终端体验优化技术方案

- 日期：2026-11-25
- 状态：草案（待评审）
- 前置方案：[云端终端 v2](../2026-09/2026-09-03-cloud-terminal-design-v2.md)（安卓虚拟按键条与软键盘避让的来源）、[本地任务终端跨端开放](2026-11-18-local-terminal-remote-technical-design.md)（中继终端）
- 关联代码：`desktop/src/components/terminal/TerminalPanel.vue`、`desktop/src/components/terminal/TerminalTabs.vue`、`desktop/src/composables/useTerminal.ts`、`desktop/src/composables/useTerminalWS.ts`、`desktop/src/utils/terminal-ime-guard.ts`、`desktop/src/composables/useForegroundRecovery.ts`、`desktop/src/components/common/Layout.vue`、`desktop/src/style.css`（`html.android-capacitor .terminal-*`）、`backend-ts/src/harness/terminal/remote-terminal.ts`、`backend-ts/src/harness/terminal/terminal-ws-handler.ts`

## 0. 结论

移动端（安卓壳、手机浏览器）上的终端「能连上、能敲字」，但看不了历史、按不出常用组合键、复制粘贴基本不可用，屏幕空间也没利用好。主要原因有三个：

1. **滑动翻看历史失效是 xterm 6.0 的回归。** 6.0 把视口换成了 VS Code 的 `SmoothScrollableElement`（`@xterm/xterm/src/browser/Viewport.ts`），它只处理鼠标滚轮。5.x 里 Viewport 自带的 `handleTouchStart / handleTouchMove` 被删了，xterm 本身也不再监听触摸滚动。桌面靠滚轮所以正常，触屏上没有任何手势能滚动 scrollback。必须由我们自己补触摸手势。
2. **按键条只在安卓壳里出现，而且实现上有几处在真实软键盘下不工作。** 渲染条件是 `isAndroidCapacitor()`，手机浏览器（安卓 Chrome、iOS Safari）看不到。粘滞 Ctrl 靠 `keydown` 的 `e.key` 判断字母，但安卓软键盘输入大多上报 `key='Unidentified' / keyCode=229`，所以 Ctrl 实际上只对外接键盘有效。粘贴用 `navigator.clipboard.readText()`，WebView 里常因权限失败；写入用的是 `terminal.input()` 而不是 `terminal.paste()`，绕过了 bracketed paste，多行内容会逐行立即执行。
3. **布局沿用桌面的「底部 300px 面板」。** 手机竖屏弹出键盘后输出区只剩几行。打开面板会自动 `focus()` 弹出键盘，把输出盖住。字号固定 12px 且不能缩放。标签关闭按钮只有 16px、常显，误触就直接结束 PTY。

方案分三期：一期修滑动、按键条和粘贴这几处「用不了」的问题；二期做复制、全屏/字号、按键扩充和回前台恢复；三期改回放协议（增量回放，不再每次清屏重放）。一、二期只改 desktop 前端，不改安卓原生壳，不出 APK。三期改后端和 WS 协议。

## 1. 现状

| 能力 | 桌面 Electron / 桌面浏览器 | 安卓壳（Capacitor） | 手机浏览器 |
|---|---|---|---|
| 翻看历史 | 滚轮 | 不可用 | 不可用 |
| 虚拟按键条 | 无（不需要） | 有：Esc / Tab / Ctrl / ↑↓←→ / Ctrl+C / Ctrl+D / 粘贴，单行横向滚动 | 无 |
| 软键盘避让 | — | `visualViewport` 算遮挡后加 `margin-bottom` | 无 |
| 输入法重复输入修复 | 不安装 | 安装（`terminal-ime-guard`） | 安装（`pointer: coarse`） |
| 复制输出 | 鼠标选区 | 不可用 | 不可用 |
| 搜索 | Ctrl+F | 无入口 | 无入口 |
| 回放 | attach 时 RIS 清屏后全量回放（默认 256KB） | 同左，且断线 / 回前台更频繁 | 同左 |

## 2. 问题清单

优先级：P0 表示功能基本不可用，P1 表示能用但很别扭，P2 表示体验和稳健性的进一步改进。

### 2.1 P0

| # | 问题 | 根因 / 位置 |
|---|---|---|
| A1 | 手指上下滑动无法滚动历史输出。less / vim 等全屏程序里也不能滑动翻页；开了鼠标上报的程序（`tmux set -g mouse on`）同样收不到滚动 | xterm 6.0 `Viewport` 只接滚轮，无触摸处理（见 §0） |
| A2 | 手机浏览器没有按键条，也没有软键盘避让，iOS Safari 的键盘直接盖住终端 | `TerminalPanel.vue` 中 `showKeyBar = isAndroidCapacitor()`，`visualViewport` 监听也用同一守卫 |
| A3 | 点按键条按钮会把焦点从 xterm 的隐藏 textarea 移到按钮上，软键盘收起又弹出，面板跟着抖动、refit（机制如此，需实机确认程度） | 按钮用 `@click`，按下时没有阻止焦点转移 |
| A4 | 粘滞 Ctrl 对软键盘基本无效：点 Ctrl 后再用软键盘敲 `c`，发出去的是 `c` 而不是 `^C` | `handleStickyCtrl` 在 `keydown` 里判断 `e.key` 是否为字母，安卓软键盘上报 `Unidentified / 229` |
| A5 | 粘贴经常失败（提示「无法读取剪贴板」）。即使成功，多行文本会逐行立即执行，vim 插入模式下会触发自动缩进错乱 | `navigator.clipboard.readText()` 在 WebView 受权限限制；写入走 `terminal.input()`，没走 `terminal.paste()`（bracketed paste、换行规范化） |
| A6 | 无法复制终端输出（报错信息、命令结果） | xterm 选区只认鼠标拖拽，触摸长按不能生成选区 |

### 2.2 P1

| # | 问题 | 根因 / 位置 |
|---|---|---|
| B1 | 面板固定 300px（上限 70% 视口），键盘弹出后输出区只剩几行；没有全屏 / 最大化 | `panelHeight = ref(300)`，`MAX_HEIGHT_RATIO = 0.7` |
| B2 | 手机浏览器底部按键条可能被地址栏 / 工具栏遮住 | `Layout.vue` 用 `height: 100vh`，移动浏览器的 `100vh` 大于实际可视高度 |
| B3 | 打开面板、切换标签时自动弹出键盘，只想看输出时得先手动收键盘 | `mountTerminal` / `togglePanel` / `watch(activeTabId)` 都调用 `terminal.focus()` |
| B4 | 字号固定 12px，不能缩放。手机竖屏只有四十多列，长行严重折行 | `buildTerminal()` 写死 `fontSize: 12` |
| B5 | 标签关闭按钮 16×16、常显、紧贴标题，误触就结束远程 PTY，没有确认；关闭按钮没有 `aria-label` / `title`（不符合仓库按钮规范） | `TerminalTabs.vue` |
| B6 | 搜索只能用 Ctrl+F 打开，移动端没有入口 | `handleSearchKeydown` |
| B7 | 按键不全：缺 Alt、Home / End、PgUp / PgDn、Shift+Tab，以及软键盘上不好找的 `\| ~ / - _`，还有 Ctrl+Z / L / R / A / E；方向键不能长按连发；单行横向滚动导致后面的键看不到 | `KEY_BAR` 常量 |
| B8 | 方向键写死 `ESC [ A`，忽略应用光标模式（DECCKM）。个别程序在该模式下只认 `ESC O A` | `KEY_BAR` 的 `data` 字段直接是序列 |

### 2.3 P2

| # | 问题 | 根因 / 位置 |
|---|---|---|
| C1 | 切到后台再回来：如果主对话 WS 已断，`useForegroundRecovery` 整页刷新，终端面板被关掉，需要手动重开；如果不刷新，终端 WS 的心跳定时器在后台被冻结，最长要 30s 才发现死连接，期间敲的键进待发队列甚至被丢 | `useForegroundRecovery.ts`；`useTerminalWS.ts` 的 `SERVER_SILENCE_TIMEOUT_MS` |
| C2 | 每次 attach（切任务、重连、回前台）都 RIS 清屏后全量回放：画面闪一下，本地 5000 行 scrollback 被冲掉，只剩服务端 256KB 环形缓冲里的内容。移动端断线频繁，等于「历史经常只剩最近一截」 | `useTerminal.ts` 的 `onAttached` 写 `\x1bc`；后端 `OutputRingBuffer.read()` 整段返回 |
| C3 | 往上翻看时有新输出，没有任何提示，也没有「回到底部」 | 无 |
| C4 | WebGL 上下文丢失（安卓切后台常见）后直接 dispose，之后一直用 DOM 渲染，不再恢复 | `buildTerminal()` 的 `onContextLoss` |

## 3. 目标与非目标

### 3.1 目标

| # | 内容 |
|---|---|
| G1 | 触屏上单指上下滑动可以滚动历史，带惯性；全屏程序和鼠标上报程序里滑动有合理效果（翻页 / 发滚轮） |
| G2 | 安卓壳和手机浏览器都有按键条和软键盘避让；点按键不收起键盘；Ctrl / Alt 对软键盘输入生效 |
| G3 | 粘贴稳定可用，并且走 bracketed paste；可以复制终端输出 |
| G4 | 移动端可以把终端最大化、调整字号；默认不自动弹键盘 |
| G5 | 回前台、断线重连后终端自动恢复，不丢面板，尽量不清屏 |

### 3.2 非目标

- 不改安卓原生壳：不加 Capacitor 插件（如 `@capacitor/clipboard`），不改 MainActivity / AndroidManifest，不跑 `build-apk.sh`。发版就是部署 `desktop/dist`（三期另需重启后端）。
- 桌面 Electron 和桌面浏览器的交互不变。共用改动只有：`Layout.vue` 的 `dvh`、标签栏的 aria-label、头部的搜索按钮。
- 不做「固定 80 列 + 横向滚动」，不做 shell integration（按命令分段复制），不做 iOS 原生壳。
- 不改 admin、mao-agent 的 TUI。

## 4. 方案

### 4.1 统一「触屏终端」判定

新增 `desktop/src/utils/terminal-touch.ts` 导出 `isTouchTerminal()`，逻辑与 `shouldInstallImeSweeper()` 一致：Capacitor 原生平台为真；Electron 为假；其余看 `matchMedia('(pointer: coarse)')`。`shouldInstallImeSweeper` 改为调用它。

以下行为都以 `isTouchTerminal()` 为守卫（原来是 `isAndroidCapacitor()`）：按键条、软键盘避让、触摸滚动、不自动聚焦、标签栏放大命中区、关闭确认。`style.css` 里 `html.android-capacitor .terminal-*` 的样式改成由面板根元素上的 `.terminal-panel--touch` 类控制，手机浏览器也能吃到。桌面浏览器的主指针是 `fine`，不受影响。

### 4.2 触摸滚动（A1、C3）

新增 `desktop/src/utils/terminal-touch-scroll.ts`：`installTouchScroll(terminal): () => void`。在 `mountTerminal` 里与 IME 清扫器同一处安装，卸载函数放进 `inst.disposers`。

**手势识别**（监听 `terminal.element`，`touchmove` 用 `passive: false`）：

- 单指按下后移动超过 8px，且 `|dy| > |dx|`，进入滚动态，之后 `preventDefault`。点按（未超过阈值）不拦截，xterm 照常聚焦。
- 滚动态下累计像素，按行高（`element.clientHeight / terminal.rows`）换算成整行，余数留到下一次 move，避免慢速滑动时一行都不动。
- 松手时用最近 100ms 的速度做惯性滚动：每帧乘 0.95 衰减，速度低于阈值停止，新的 `touchstart` 立即打断。
- 两指交给 §4.6 的捏合缩放，不进滚动态。

**按终端模式分流**（和桌面滚轮的语义对齐）：

| 条件 | 行为 |
|---|---|
| 普通缓冲且 `modes.mouseTrackingMode === 'none'` | `terminal.scrollLines(-n)`，带惯性 |
| 备用缓冲（less / vim / htop）且未开鼠标上报 | 发 n 次 ↑ / ↓，编码遵守 DECCKM（§4.3），这和 xterm 对滚轮的处理一致；不做惯性，单次手势有上限，避免一甩翻几百行 |
| 开了鼠标上报（tmux mouse、vim `mouse=a`） | 在 `.xterm-screen` 上派发合成 `WheelEvent`（`deltaMode = DOM_DELTA_LINE`），由 xterm 按应用协议编码。xterm 6 的 wheel 监听目前不检查 `isTrusted`，需实机确认；如果不生效，回落到发 ↑ / ↓ |

**回到底部**：订阅 `terminal.onScroll`，当 `buffer.active.viewportY < buffer.active.baseY` 时，在终端右下角显示悬浮按钮「↓ 回到底部」（`aria-label="回到底部"`）。离开底部期间如果有新输出，按钮上加一个圆点。点击调用 `scrollToBottom()`。该按钮全端可用，桌面上也有用。

上游 xterm 如果恢复了触摸滚动，删掉此模块即可。在模块注释里写明对应的 xterm 版本。

### 4.3 按键条重做（A2、A3、A4、B7、B8）

拆出 `TerminalKeyBar.vue` 组件和纯函数模块 `desktop/src/utils/terminal-keys.ts`（按键定义、修饰键编码、DECCKM 编码），方便写单测。

**布局**：两行、等宽、不横向滚动（横向滚动会把后面的键藏起来）。每键最小 36px 高，宽度按屏宽均分。

| 行 | 按键 |
|---|---|
| 第一行 | `Esc` `Tab` `Ctrl` `Alt` `↑` `↓` `←` `→` |
| 第二行 | `^C` `\|` `~` `/` `-` `Home` `End` `粘贴` `⋯` |
| 「⋯」弹层 | `PgUp` `PgDn` `⇧Tab` `^D` `^Z` `^L` `^R` `^A` `^E`、`选择文本`（§4.4）、`搜索`、`字号 −/+`、`最大化`、`收起按键条` |

按键条可以收起，收起后头部留一个「按键条」开关，状态记 localStorage。

**不抢焦点**：在按键条根元素上 `@pointerdown.prevent`，阻止按下时焦点从 xterm textarea 移走，软键盘保持原状；动作在 `click` 里执行。若实机上 `click` 不触发，改为在 `pointerup` 里执行。按键条不主动 `focus()` 终端，尊重用户收起键盘的状态（第一行另加一个「⌨」键用于显示 / 隐藏软键盘：调 `terminal.focus()` / `terminal.textarea.blur()`）。

**修饰键改在 onData 层生效**：新增模块级的修饰键状态（`useTerminalModifiers`，单例），状态有三种：关、单次、锁定。单击进入单次，双击进入锁定，再点关闭。`useTerminal.ts` 里 local / remote 的 `terminal.onData` 回调在写出前调用 `applyModifiers(data)`：

- Ctrl：首字符是 `a-z / A-Z` 时转成 `code & 0x1f`；`@ [ \ ] ^ _` 和空格按标准映射（空格 → `\x00`）。
- Alt：在前面加 `ESC`。
- 单次状态用完即复位；`data` 首字符不是 ASCII（中文输入法整词提交）时原样放行并复位，不误伤中文输入。
- 按键条自身的键（方向键、Home 等）在 `terminal-keys.ts` 里把修饰键编码进 CSI 参数（例如 Ctrl+↑ → `ESC [1;5A`），通过一个不经过 `applyModifiers` 的原始通道写出，避免被重复处理。

这样软键盘、外接键盘、按键条三条输入路径都走同一套修饰键逻辑。删除原来的 `handleStickyCtrl`（`keydown` 捕获阶段监听）。

**DECCKM**：方向键、Home、End 按 `terminal.modes.applicationCursorKeysMode` 选 `ESC O x` 或 `ESC [ x`。PgUp / PgDn 是 `ESC [5~` / `ESC [6~`，Shift+Tab 是 `ESC [Z`。

**长按连发**：方向键、PgUp、PgDn 按住 400ms 后每 50ms 重复一次，`pointerup / pointercancel / pointerleave` 时停止。

### 4.4 粘贴与复制（A5、A6）

**粘贴**：

1. 先尝试 `navigator.clipboard.readText()`。
2. 失败时（WebView 常见）弹出「粘贴到终端」对话框：里面是一个自动聚焦的 textarea，用户长按调出系统菜单粘贴，然后点「发送」。不需要原生插件。
3. 写入统一走 `terminal.paste(text)`：应用开了 bracketed paste 时会被包起来；换行规范化交给 xterm。
4. 文本含换行、而应用没开 bracketed paste（`modes.bracketedPasteMode === false`，即 shell 直接逐行执行）时，先确认「将粘贴 N 行，每行会立即执行」。

**复制（选择文本模式）**：「⋯ → 选择文本」在终端上方覆盖一层全尺寸的 `<pre>`，内容来自 `buffer.active.getLine(i).translateToString(true)`（取最近 2000 行，避免长 scrollback 卡顿），字体、字号和终端一致，初始滚动位置对齐当前视口。在这一层里可以原生滚动、长按选择、用系统菜单复制。顶部条提供「复制全部」「完成」。写剪贴板用 `navigator.clipboard.writeText`，失败时回落到 `document.execCommand('copy')`。

这一层只是快照，进入后终端的新输出不会更新进来，顶部条写明「快照」。

### 4.5 面板布局与软键盘（B1、B2、B3）

- **默认高度**：触屏端首次打开时取可视高度的 50%。用户拖动后的高度记 localStorage（与桌面分开存）。
- **最大化**：头部加「最大化 / 还原」按钮（`aria-label` 跟随状态）。最大化时面板占满顶栏以下的全部可视区域，主区域收缩为 0。
- **高度钳制**：软键盘弹起时，实际高度取 `min(设定高度, visualViewport.height − 顶栏高度 − 8px)`，然后 fit。避免面板加 `margin-bottom` 之后被挤出屏幕。键盘避让对所有触屏端注册（含 iOS Safari）。
- **`dvh`**：`Layout.vue` 改成 `height: 100vh; height: 100dvh;`（前者是兜底）。桌面上两者相等，没有影响。
- **不自动聚焦**：触屏端在 `mountTerminal`、`togglePanel`、切换标签时不调 `focus()`，用户点终端区域才弹键盘。桌面行为不变。
- **待实机确认**：Capacitor 7 + `adjustMarginsForEdgeToEdge: force` 下，键盘弹出时 WebView 自身是否缩小。如果缩小，`occluded` 恒为 0，只需要高度钳制；如果不缩小，就靠现有的 `margin-bottom` 方案。两种情况下钳制逻辑都成立。

### 4.6 字号（B4）

- 「⋯」里提供 `A− / A+`，范围 10–18px，步长 1，触屏端默认 12px。
- 双指捏合缩放：和 §4.2 共用触摸模块，两指时按两指距离变化调整字号，松手后落盘。
- 改字号时同步按比例换算 `letterSpacing`（`buildTerminal` 注释要求字距与 `--aw-tracking` 对齐），然后 `fit()`。fit 会触发 `onResize → sendResize`，PTY 尺寸随之更新。
- 字号存 localStorage，所有终端实例共用。

### 4.7 标签栏与入口（B5、B6）

- 触屏端标签高 36px；关闭按钮用伪元素把命中区扩到 32px；新建按钮 36px。
- 触屏端关闭标签前确认「关闭后该终端的进程会被结束」。桌面不确认，保持现状。
- 关闭按钮加 `aria-label="关闭终端 {标题}"`，新建按钮补 `aria-label="新建终端"`（已有 title）。
- 头部加搜索图标按钮（`aria-label="搜索终端内容"`）。全端都显示，桌面上可点，也可继续用 Ctrl+F。
- 面板关闭按钮的 title 在触屏端去掉「(Ctrl+`)」。

### 4.8 回前台与断线（C1）

- `useTerminalWS` 监听 `visibilitychange`（变为 visible）和 `online` 事件：如果连接不是 OPEN，或距上次收到服务端消息已超过 2 个心跳周期，立即关闭旧连接并重连（重置退避）；否则立刻发一次 ping，不等定时器。
- 面板状态持久化：sessionStorage 记 `{ sessionId, isOpen, activeTabId }`。页面刷新（包括 `useForegroundRecovery` 触发的整页刷新）后，在 `activeSession` 就绪时如果记录是打开状态，自动打开面板并 `restoreRemoteTabs`。仅触屏端启用。
- 断线期间面板头部显示一条细条「终端重连中…」（`useTerminalWS().connected` 已有，直接用）。

### 4.9 增量回放（C2，三期，涉及后端与协议）

现在每次 attach 都「清屏 + 全量回放」。改为按输出序号增量补发：

- **后端**：`RemoteTerminal` 维护单调递增的输出字节序号 `seq`；`OutputRingBuffer` 记录缓冲起点的序号。每个 `output` 帧带上帧尾的 `seq`。
- **attach 帧**新增可选字段 `fromSeq`。服务端判断：`fromSeq` 不早于缓冲起点时，只回放 `[fromSeq, end)`，`attached` 帧带 `replay: 'delta'`；否则全量回放，带 `replay: 'full'`。两种回放都经过 `sanitizeReplayData`（增量部分同样是历史字节，同样可能含应答诱饵）。
- **前端**：每个终端记录已写入的最后 `seq`，attach 时带上。`onAttached` 只在 `replay === 'full'` 时写 RIS 清屏。
- **中继终端**：`local-terminal-relay.ts` 同样用 `new RemoteTerminal(...)` 建终端，缓冲在后端，所以自动获得这项能力，执行端（Electron / mao-agent）不用改。
- 协议向前不兼容也没关系（初版不考虑兼容），前后端同版本发布。

效果：切任务、短暂断线、回前台都不再清屏，xterm 本地 5000 行 scrollback 得以保留；只有断线太久、缓冲已经滚过去的时候才全量回放。

### 4.10 WebGL 恢复（C4，三期）

上下文丢失后仍然先 dispose 回落到 DOM 渲染；回到前台（visible）时尝试重新加载一次 WebGL addon，失败就放弃，在本实例生命周期内不再尝试。同时在中低端安卓机上对比 WebGL 和 DOM 渲染的帧率与内存，如果 DOM 渲染不差，可以考虑触屏端直接不加载 WebGL。

## 5. 改动文件

| 文件 | 改动 | 期 |
|---|---|---|
| `desktop/src/utils/terminal-touch.ts`（新） | `isTouchTerminal()` | 一 |
| `desktop/src/utils/terminal-ime-guard.ts` | `shouldInstallImeSweeper` 复用 `isTouchTerminal` | 一 |
| `desktop/src/utils/terminal-touch-scroll.ts`（新） | 触摸滚动、惯性、模式分流；二期加捏合 | 一 / 二 |
| `desktop/src/utils/terminal-keys.ts`（新） | 按键定义、修饰键编码、DECCKM | 一 |
| `desktop/src/composables/useTerminalModifiers.ts`（新） | Ctrl / Alt 三态与 `applyModifiers` | 一 |
| `desktop/src/components/terminal/TerminalKeyBar.vue`（新） | 按键条组件（一期单行修复，二期两行 + 弹层 + 长按） | 一 / 二 |
| `desktop/src/components/terminal/TerminalPanel.vue` | 换用新组件与判定；粘贴流程；回到底部；最大化 / 高度钳制；搜索按钮；去掉 `handleStickyCtrl` | 一 / 二 |
| `desktop/src/components/terminal/TerminalTabs.vue` | 命中区、aria-label、关闭确认 | 一 |
| `desktop/src/components/terminal/TerminalCopyOverlay.vue`（新） | 选择文本模式 | 二 |
| `desktop/src/composables/useTerminal.ts` | onData 接 `applyModifiers`；触屏端不自动聚焦；安装触摸模块；字号；面板状态持久化；增量回放 seq | 一 / 二 / 三 |
| `desktop/src/composables/useTerminalWS.ts` | 回前台重连；`fromSeq` / `replay` 字段 | 二 / 三 |
| `desktop/src/components/common/Layout.vue` | `100dvh` | 二 |
| `desktop/src/style.css` | `html.android-capacitor .terminal-*` 迁移为 `.terminal-panel--touch` | 一 |
| `backend-ts/src/harness/terminal/remote-terminal.ts`、`terminal-ws-handler.ts` | 输出序号、增量回放（云端与中继终端共用） | 三 |

## 6. 分期

**一期（P0，纯前端）**：§4.1 判定统一；§4.2 触摸滚动和回到底部；§4.3 中的「不抢焦点、修饰键改 onData 层、DECCKM」（按键集合先维持现状，加上 Alt）；§4.4 粘贴；§4.5 中的「不自动聚焦」；§4.7。

**二期（P1，纯前端）**：§4.3 两行布局、弹层、长按连发；§4.4 选择文本；§4.5 默认高度、最大化、钳制、`dvh`；§4.6 字号与捏合；§4.8 回前台。

**三期（P2，前后端）**：§4.9 增量回放；§4.10 WebGL 恢复。

## 7. 测试与验收

**单测（Vitest，desktop）**：

- `terminal-keys`：各键在 DECCKM 开 / 关时的编码；Ctrl / Alt 与方向键组合的 CSI 参数。
- `useTerminalModifiers`：Ctrl + 字母、Ctrl + 符号、Alt 前缀；单次用完复位、锁定保持；非 ASCII（中文整词）放行并复位。
- `terminal-touch-scroll`：像素换算成行时余数会累计；三种模式的分流（假 terminal 注入 `buffer.active.type`、`modes`）；点按不进入滚动态；两指不进入滚动态。
- 粘贴：多行检测；bracketed paste 开 / 关时是否需要确认；`readText` 失败时打开兜底对话框。
- `useTerminalWS`：visible 时连接已断则立即重连、未断则立即 ping。
- `useTerminal.test.ts` 补：触屏端 mount 不调用 `focus()`；onData 经过修饰键处理。

**后端单测（三期）**：`remote-terminal.spec.ts` 覆盖 seq 递增和缓冲起点随截断移动；`terminal-ws-handler.spec.ts` 覆盖 `fromSeq` 命中 / 过旧 / 缺省三种情况，以及增量回放也经过 sanitize。

**构建**：`cd desktop && npm run build`；三期加 `cd backend-ts && npm run build && npm test`。

**实机验收**（安卓壳、安卓 Chrome、iOS Safari 各一遍，竖屏为主，横屏抽查）：

1. bash 里 `seq 1 3000` 后单指上下滑能翻到开头，有惯性；回到底部按钮出现 / 消失正确。
2. `less` 长文件、`vim` 里滑动翻页；`tmux` 开 mouse 后滑动滚动 tmux 历史。
3. 点按键条任意键软键盘不收起；`Ctrl` 后用软键盘敲 `c` 中断 `sleep 100`；`Alt` + `b` 在 bash 里按词左移。
4. Gboard 和一个国产输入法分别输入中英文混合内容，没有重复上屏（回归 `terminal-ime-guard`）。
5. 粘贴单行和多行；在 vim 插入模式粘贴多行，缩进不乱。
6. 「选择文本」复制一段报错，到对话输入框粘贴。
7. 最大化、调字号后 `tput cols` 随之变化；弹出键盘时面板不超出屏幕。
8. 切后台 5 分钟再回来，终端自动恢复（三期：不清屏）。
9. 桌面 Electron 回归：滚轮、选区、Ctrl+F、按键行为和改动前一致，没有按键条。

## 8. 风险与待确认

| 项 | 说明 | 兜底 |
|---|---|---|
| `pointerdown.prevent` 能否保住软键盘 | 各 WebView / 浏览器行为不完全一致 | 改用 `touchstart.prevent` + 在 `touchend` 中执行动作 |
| 合成 `WheelEvent` 是否被 xterm 接受 | 依赖 xterm 不校验 `isTrusted` | 鼠标上报模式下回落为 ↑ / ↓ |
| WebView 的 `clipboard.readText` | 大概率被拒 | 兜底对话框（§4.4） |
| Capacitor 7 edge-to-edge 下键盘是否缩小 WebView | 影响 `occluded` 的取值 | 高度钳制两种情况都成立（§4.5） |
| 输入法预测 / 整词提交 | Gboard 会无视 `autocorrect=off` | 修饰键对非 ASCII 放行；已有 IME 清扫器；实机回归 |
| 触摸滚动与 xterm 未来版本冲突 | 上游若恢复触摸处理会出现双重滚动 | 升级 xterm 时检查 `Viewport.ts`，必要时删除本模块 |

## 9. 文档同步

实施时按期同步：

- `changelog/unreleased/` 新增碎片，小节为「前端（桌面 / Web / 安卓）」；三期另加「后端」。
- `skills/mao-cli/reference/desktop.md` 的「终端」章节：手机浏览器也有按键条、滑动翻看历史、选择文本、粘贴兜底、最大化与字号；三期更新「断线回放」描述（不再每次清屏）。
- `skills/mao-cli/reference/troubleshooting.md` 补「手机上粘贴失败 / 键盘遮挡」的排障说明。
