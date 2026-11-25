# 移动端终端体验优化技术方案

- 日期：2026-11-25
- 状态：草案（2026-11-25 评审：可行；补充已并入各节，标「评审补充」）
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
| C1 | 切到后台再回来：如果主对话 WS 已断，`useForegroundRecovery` 整页刷新，终端面板被关掉，需要手动重开；如果不刷新，终端 WS 的心跳定时器在后台被冻结，最长约 40s（10s 心跳间隔 + 30s 静默阈值）才发现死连接，期间敲的键进待发队列甚至被丢 | `useForegroundRecovery.ts`；`useTerminalWS.ts` 的 `SERVER_SILENCE_TIMEOUT_MS` |
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
- 桌面 Electron 和桌面浏览器的交互不变（`isTouchTerminal()` 为假时全走原路径）。全端共用、但不改变桌面交互的改动：`Layout.vue` 的 `dvh`、标签栏的 aria-label、头部搜索按钮、终端右下角「回到底部」按钮、字号设置。**评审补充**：`pointer: coarse` 的触屏笔记本会命中 `isTouchTerminal()`（出现按键条、不自动聚焦），这是有意行为，用按键条开关收起即可；不要为此再加 UA 判定。
- 不做「固定 80 列 + 横向滚动」，不做 shell integration（按命令分段复制），不做 iOS 原生壳。
- 不改 admin、mao-agent 的 TUI。

## 4. 方案

### 4.1 统一「触屏终端」判定

新增 `desktop/src/utils/terminal-touch.ts` 导出 `isTouchTerminal()`，逻辑与 `shouldInstallImeSweeper()` 一致：Capacitor 原生平台为真；Electron 为假；其余看 `matchMedia('(pointer: coarse)')`。`shouldInstallImeSweeper` 改为调用它。

以下行为都以 `isTouchTerminal()` 为守卫：按键条、软键盘避让（这两项原来是 `isAndroidCapacitor()`）、触摸滚动、不自动聚焦、标签栏放大命中区、关闭确认。`style.css` 里 `html.android-capacitor .terminal-*` 的样式改成由面板根元素上的 `.terminal-panel--touch` 类控制，手机浏览器也能吃到。桌面浏览器的主指针是 `fine`，不受影响。**评审补充**：`isTouchTerminal()` 里的 `matchMedia` / `window` 要做存在性守卫（`desktop/vitest.config.ts` 是 `environment: 'node'`，模块可能在测试 import 阶段被求值），判定顺序按「Capacitor → Electron → `(pointer: coarse)`」。`style.css` 只迁移现有的 3 条 `html.android-capacitor .terminal-*` 规则，不要连带把 `.top-nav` 等其它安卓规则换掉。

### 4.2 触摸滚动（A1、C3）

新增 `desktop/src/utils/terminal-touch-scroll.ts`：`installTouchScroll(terminal): () => void`。在 `mountTerminal` 里与 IME 清扫器同一处安装，卸载函数放进 `inst.disposers`。

**手势识别**（监听 `terminal.element`，`touchmove` 用 `passive: false`）：

- 单指按下后移动超过 8px，且 `|dy| > |dx|`，进入滚动态，之后 `preventDefault`。点按（未超过阈值）不拦截，xterm 照常聚焦。约定 `dy > 0`（手指下拖）表示往回看历史，换算成 `scrollLines(-n)`。
- 滚动态下累计像素，按行高（`element.clientHeight / terminal.rows`）换算成整行，余数留到下一次 move，避免慢速滑动时一行都不动。
- 松手时用最近 100ms 的速度做惯性滚动：每帧乘 0.95 衰减，速度低于阈值停止，新的 `touchstart` 立即打断。
- 两指交给 §4.6 的捏合缩放，不进滚动态；第二指在已进入滚动态后落下时，立即退出滚动态让位给捏合。

**评审补充（触摸手势必须配 CSS）**：只挂 `touchmove` + `preventDefault` 不够。浏览器在首个 `touchmove` 之前就会判定手势归属，判定成页面滚动后会直接给元素发 `touchcancel`，自定义滚动收不到后续 move（iOS Safari 尤其明显）。必须同时加：

```css
.terminal-panel--touch .xterm { touch-action: none; }
.terminal-panel--touch { overscroll-behavior: contain; }
```

`touch-action: none` 只加在触屏面板内，桌面不变。iOS 的页面 pinch 缩放由 `gesturestart/gesturechange` 驱动，`touch-action` 不保证拦得住，见 §4.6。

**按终端模式分流**（和桌面滚轮的语义对齐）：

| 条件 | 行为 |
|---|---|
| 普通缓冲且 `modes.mouseTrackingMode === 'none'` | `terminal.scrollLines(-n)`，带惯性 |
| 备用缓冲（less / vim / htop）且未开鼠标上报 | 发 n 次 ↑ / ↓，编码遵守 DECCKM（§4.3），这和 xterm 对滚轮的处理一致；不做惯性，单次手势有上限，避免一甩翻几百行 |
| 开了鼠标上报（tmux mouse、vim `mouse=a`） | 在 `.xterm-screen` 上派发合成 `WheelEvent`（`deltaMode = DOM_DELTA_LINE`），由 xterm 按应用协议编码。xterm 6 的 wheel 监听目前不检查 `isTrusted`，需实机确认；如果不生效，回落到发 ↑ / ↓ |

**评审补充（合成 wheel 的三个必须项）**：xterm 的 wheel 监听挂在 `.xterm` 根节点上（`CoreBrowserTerminal.bindMouse`），`.xterm-screen` 是其后代，所以事件必须 `bubbles: true`；xterm 用 `clientX/clientY` 算鼠标单元格，坐标默认 (0,0) 会让 tmux 只在左上角窗格滚动，必须带最后一次触摸点坐标；一次手势最多派发约 8 个 wheel（限流），否则一次甩动会把 tmux/vim 翻到底。

**回到底部**：订阅 `terminal.onScroll`，当 `buffer.active.viewportY < buffer.active.baseY` 时，在终端右下角显示悬浮按钮「↓ 回到底部」（`aria-label="回到底部"`）。离开底部期间如果有新输出，按钮上加一个圆点。点击调用 `scrollToBottom()`。该按钮全端可用，桌面上也有用。**评审补充**：惯性滚动期间 `onScroll` 每帧触发，按钮显隐状态用 rAF 合并（或 ~50ms 节流）再写 Vue ref，避免低端安卓每帧触发响应式更新；按钮挂在 `.terminal-container` 内，容器需补 `position: relative`（当前只有 `overflow: hidden`）。

上游 xterm 如果恢复了触摸滚动，删掉此模块即可。在模块注释里写明对应的 xterm 版本。

### 4.3 按键条重做（A2、A3、A4、B7、B8）

拆出 `TerminalKeyBar.vue` 组件和纯函数模块 `desktop/src/utils/terminal-keys.ts`（按键定义、修饰键编码、DECCKM 编码），方便写单测。

**布局**：两行、等宽、不横向滚动（横向滚动会把后面的键藏起来）。每键最小 36px 高，宽度按屏宽均分。

| 行 | 按键 |
|---|---|
| 第一行 | `Esc` `Tab` `Ctrl` `Alt` `↑` `↓` `←` `→` |
| 第二行 | `^C` `\|` `~` `/` `-` `Home` `End` `粘贴` `⋯` |
| 「⋯」弹层 | `PgUp` `PgDn` `⇧Tab` `^D` `^Z` `^L` `^R` `^A` `^E`、`选择文本`（§4.4）、`搜索`、`字号 −/+`、`最大化`、`收起按键条` |

按键条可以收起，收起后头部留一个「按键条」开关，状态记 localStorage。**评审补充**：360px 屏下 9 键等分每键约 32px，`Home`/`End`/`粘贴` 已到极限；320px 屏建议第二行减到 8 键（例如把 `粘贴` 提到第一行或允许该行 10px 字号）。`⋯` 与头部搜索/最大化入口重复，触屏端二选一（建议头部只保留全端的搜索按钮，最大化只放 `⋯`）。按键条按钮补 `touch-action: manipulation` 与 `user-select: none`，否则双击会触发浏览器缩放、长按连发会先弹文本选择菜单。

**不抢焦点**：在按键条根元素上 `@pointerdown.prevent`，阻止按下时焦点从 xterm textarea 移走，软键盘保持原状；动作在 `click` 里执行。若实机上 `click` 不触发，改为在 `pointerup` 里执行。按键条不主动 `focus()` 终端，尊重用户收起键盘的状态（第一行另加一个「⌨」键用于显示 / 隐藏软键盘：调 `terminal.focus()` / `terminal.textarea.blur()`）。

**修饰键改在 onData 层生效**：新增模块级的修饰键状态（`useTerminalModifiers`，单例），状态有三种：关、单次、锁定。单击进入单次，双击进入锁定，再点关闭。`useTerminal.ts` 里 local / remote 的 `terminal.onData` 回调在写出前调用 `applyModifiers(data)`：

- Ctrl：仅当 `data.length === 1` 且首字符是 `a-z / A-Z` 时转成 `code & 0x1f`；`@ [ \ ] ^ _` 和空格按标准映射（空格 → `\x00`）。**评审补充**：Gboard 等会把预测词整词提交（如 `cat`），按首字符转会变成 `^C` + `at`，把一条命令直接变成中断；多字符一律放行并复位。
- Alt：仅当首字符是可打印 ASCII（0x20–0x7e）时在前面加 `ESC`。**评审补充**：首字符是 `ESC` / C0 时原样放行——xterm 对硬件键盘的 Alt 已经自己编了 `ESC` 前缀，鼠标 / 焦点上报也以 `ESC` 开头，再套一层会发出两条序列。
- 单次状态用完即复位；`data` 首字符不是 ASCII（中文输入法整词提交）时原样放行并复位，不误伤中文输入。
- Ctrl 与 Alt 同时置位时先做 Ctrl 转换、再加 Alt 前缀；粘贴路径（§4.4）与 `sendRaw` 路径不经过 `applyModifiers`。
- 修饰键状态在切换 tab、关闭面板、执行粘贴时复位（沿用现有 `ctrlSticky` 在 `watch(activeTabId)` 里的复位点，否则锁定态会串到另一个终端）。
- 按键条自身的键（方向键、Home 等）在 `terminal-keys.ts` 里把修饰键编码进 CSI 参数（例如 Ctrl+↑ → `ESC [1;5A`），通过一个不经过 `applyModifiers` 的原始通道写出，避免被重复处理。**评审补充（原始通道要落到实处）**：`useTerminal` 暴露 `sendRaw(data)`——local 直接调 `window.electronAPI.terminal.write(id, data)`，remote 直接调 `terminalWS.sendInput(id, data)`。不要用 `terminal.input(data, true)` 代替：第二个参数只标记「用户输入」，仍会触发 `onData`，照样被 `applyModifiers` 改写。

这样软键盘、外接键盘、按键条三条输入路径都走同一套修饰键语义：软键盘与外接键盘经 `onData` 的 `applyModifiers`，按键条经 `terminal-keys.ts` 直接编码进序列。删除原来的 `handleStickyCtrl`（`keydown` 捕获阶段监听）。

**评审补充（无障碍）**：`⋯` / `⌨` 是纯图标按钮，按仓库规范补 `aria-label`（「更多按键」「显示 / 隐藏键盘」）；Ctrl / Alt 的粘滞态加 `aria-pressed`，否则读屏用户不知道当前是否处于锁定态。

**DECCKM**：方向键、Home、End 按 `terminal.modes.applicationCursorKeysMode` 选 `ESC O x` 或 `ESC [ x`。PgUp / PgDn 是 `ESC [5~` / `ESC [6~`，Shift+Tab 是 `ESC [Z`。

**长按连发**：方向键、PgUp、PgDn 按住 400ms 后每 50ms 重复一次，`pointerup / pointercancel / pointerleave` 时停止。

### 4.4 粘贴与复制（A5、A6）

**粘贴**：

1. 先尝试 `navigator.clipboard.readText()`。
2. 失败时（WebView 常见）弹出「粘贴到终端」对话框：里面是一个自动聚焦的 textarea，用户长按调出系统菜单粘贴，然后点「发送」。不需要原生插件。
3. 写入统一走 `terminal.paste(text)`：应用开了 bracketed paste 时会被包起来；换行规范化交给 xterm。
4. 文本含换行、而应用没开 bracketed paste（`modes.bracketedPasteMode === false`，即 shell 直接逐行执行）时，先确认「将粘贴 N 行，每行会立即执行」。

**评审补充（粘贴必须绕过修饰键）**：`terminal.paste()` 内部是 `triggerDataEvent` → `onData`，会经过 §4.3 的 `applyModifiers`：粘滞 Ctrl 时粘贴 `cat file` 会变成 `^C` + `at file`。粘贴前清空修饰键状态，或让粘贴走 `sendRaw` 等价通道。另外，兜底对话框在键盘弹起时会被顶到屏幕外（Element Plus 默认垂直居中），用底部弹层或 `align-center` 并允许内容区滚动，保证「发送」按钮可见可点。

**复制（选择文本模式）**：「⋯ → 选择文本」在终端上方覆盖一层全尺寸的 `<pre>`，内容来自 `buffer.active.getLine(i).translateToString(true)`（取最近 2000 行，避免长 scrollback 卡顿），字体、字号和终端一致，初始滚动位置对齐当前视口。在这一层里可以原生滚动、长按选择、用系统菜单复制。顶部条提供「复制全部」「完成」。写剪贴板用 `navigator.clipboard.writeText`，失败时回落到 `document.execCommand('copy')`。

**评审补充（复制层的四个坑）**：
- 逐行 `translateToString(true)` 后要按 `line.isWrapped` 合并续行，否则每个终端宽度处会多一个硬换行，复制长报错会被打断。
- 备用缓冲区（vim/less）只有一屏：`buffer.active.length === rows`，此模式复制的是当前屏幕而不是 scrollback，顶部条要写明。
- 进入时 `terminal.textarea.blur()` 收起键盘（否则 `<pre>` 只剩半屏）；退出时触屏端不自动 `focus()`（与 §4.5 一致）。`execCommand('copy')` 的兜底需要临时 textarea + 选区，不能直接对 `<pre>` 调。
- 覆盖层要显式 `user-select: text` / `-webkit-user-select: text`（xterm 全局是 `user-select: none`），并给 `touch-action: pan-y` 让原生滚动生效。

这一层只是快照，进入后终端的新输出不会更新进来，顶部条写明「快照」。

### 4.5 面板布局与软键盘（B1、B2、B3）

- **默认高度**：触屏端首次打开时取可视高度的 50%。用户拖动后的高度记 localStorage（与桌面分开存）。
- **最大化**：「最大化 / 还原」入口在桌面放头部、触屏放 §4.3 的 `⋯`（`aria-label` 跟随状态）。最大化时面板占满顶栏以下的全部可视区域，主区域收缩为 0。
- **高度钳制**：软键盘弹起时，实际高度取 `min(设定高度, visualViewport.height − 顶栏高度 − 8px)`，然后 fit。避免面板加 `margin-bottom` 之后被挤出屏幕。键盘避让对所有触屏端注册（含 iOS Safari）。
- **`dvh`**：`Layout.vue` 改成 `height: 100vh; height: 100dvh;`（前者是兜底）。桌面上两者相等，没有影响。
- **不自动聚焦**：触屏端在 `mountTerminal`、`togglePanel`、切换标签时不调 `focus()`，用户点终端区域才弹键盘。桌面行为不变。**评审补充**：`closeSearch()` 尾部还有一处 `terminal.focus()`（关搜索栏会重新弹键盘），触屏端要一并守卫。
- **待实机确认**：Capacitor 7 + `adjustMarginsForEdgeToEdge: force` 下，键盘弹出时 WebView 自身是否缩小。如果缩小，`occluded` 恒为 0，只需要高度钳制；如果不缩小，就靠现有的 `margin-bottom` 方案。两种情况下钳制逻辑都成立。

**评审补充（避免 resize 风暴）**：`handleViewportChange` 里的 `fit()` 必须 rAF + 约 100ms 节流。现有实现每次 `visualViewport` 事件都 `fit`，而 iOS 的 `visualViewport.scroll` 在页面滚动、地址栏收起、键盘动画期间会连续触发；fit 会触发 `onResize → sendResize`，等于给 PTY 连发 resize 帧，shell 会不断重绘。高度 / 转屏变化（`window.resize`）也要走同一套「先钳制高度再 fit」。最大化 / 还原要记住还原前的高度，不能把最大化高度写回 localStorage。

### 4.6 字号（B4）

- 「⋯」里提供 `A− / A+`，范围 10–18px，步长 1，触屏端默认 12px。
- 双指捏合缩放：和 §4.2 共用触摸模块，两指时按两指距离变化调整字号，松手后落盘。
- 改字号时同步按比例换算 `letterSpacing`（`buildTerminal` 注释要求字距与 `--aw-tracking` 对齐），然后 `fit()`。fit 会触发 `onResize → sendResize`，PTY 尺寸随之更新。
- 字号存 localStorage，所有终端实例共用。**评审补充**：二选一写清楚——要跨端一致就用全局 key（推荐，只维护一个设置）；要「桌面始终 12px」就用触屏独立 key。不要全局 key + 触屏默认值的混合方案，同一台设备从浏览器切到桌面壳会莫名其妙换字号。

**评审补充（iOS 捏合会缩放整页）**：`desktop/index.html` 的 viewport 没有 `user-scalable=no`，iOS Safari 的双指 pinch 默认缩放整个页面，`touch-action: none` 不保证拦得住（页面 pinch 走 WebKit 的 `gesturestart/gesturechange`）。要在终端元素上 `preventDefault` 这两个事件再自己调字号；若不稳，iOS 只保留 `A− / A+`，捏合作为安卓 / Chrome 的增强。字号按钮是保底路径，不能因为捏合做不出来而阻塞二期。

### 4.7 标签栏与入口（B5、B6）

- 触屏端标签高 36px；关闭按钮用伪元素把命中区扩到 32px；新建按钮 36px。
- 触屏端关闭标签前确认「关闭后该终端的进程会被结束」。桌面不确认，保持现状。**评审补充**：确认逻辑放在 `TerminalPanel` 的关闭回调（用户点击路径），不要放进 `useTerminal.closeTerminal`——进程退出、被回收、`removeTab` 也走那个函数，会在非用户操作时弹确认框。
- 关闭按钮加 `aria-label="关闭终端 {标题}"`，新建按钮补 `aria-label="新建终端"`（已有 title）。
- 头部加搜索图标按钮（`aria-label="搜索终端内容"`）。全端都显示，桌面上可点，也可继续用 Ctrl+F。**评审补充**：与 §4.3「⋯」里的搜索重复，触屏端只留 `⋯` 里的入口；头部按钮给桌面 / Web 用。头部在 360px 宽屏已经很挤（标签 + 搜索 + 最大化 + 关闭 + 按键条开关），不要再把全部入口都堆到头部。
- 面板关闭按钮的 title 在触屏端去掉「(Ctrl+`)」。

### 4.8 回前台与断线（C1）

- `useTerminalWS` 监听 `visibilitychange`（变为 visible）和 `online` 事件：如果连接不是 OPEN，或距上次收到服务端消息已超过 2 个心跳周期，立即关闭旧连接并重连（重置退避）；否则立刻发一次 ping，不等定时器。
- 面板状态持久化：sessionStorage 记 `{ sessionId, isOpen, activeTabId }`。页面刷新（包括 `useForegroundRecovery` 触发的整页刷新）后，在 `activeSession` 就绪时如果记录是打开状态，自动打开面板并 `restoreRemoteTabs`。仅触屏端启用。
- 断线期间面板头部显示一条细条「终端重连中…」（`useTerminalWS().connected` 已有，直接用）。

**评审补充（实现约束）**：
- 监听器不能写在 `useTerminalWS.ts` 模块顶层直接摸 `document` / `window`：`desktop/vitest.config.ts` 是 `environment: 'node'`，`useTerminalWS.test.ts` 会直接 import 该模块，模块顶层访问 `document` 会让整个测试文件在 import 阶段失败。用 `typeof document !== 'undefined'` 守卫，或在 `useTerminalWS()` 里初始化一次。
- `reconnectNow()`：已 `CONNECTING` 时直接返回；关闭旧 socket 时不要置 `intentionalClose = true`（否则 `onclose` 走「主动关闭」分支不再重连）；显式 `ws = null` 后再 `connect()`（`connect()` 对 OPEN 的 socket 会直接返回）；重置 `reconnectDelay`；无 `attachedTerminals` / `handlers` 时不必重连。`pendingFrames` 里的 attach 帧由现有 `dropOldestFrame` 保护，不要整队清空。
- sessionStorage 记录在登出 / `reset()` 时清掉；用户主动收起面板要写 `isOpen=false`（否则刷新后「自动打开」会违背用户意图）；恢复时只有记录的 `sessionId` 与恢复出的 active session 一致才自动打开。
- **整页刷新仍然会清屏**：刷新会重建 xterm 实例，三期增量回放没有 `lastSeq` 可用，只能全量回放。G5 的「尽量不清屏」只对「不刷新的重连 / 切任务」成立；验收项 8 的「三期不清屏」要按这个前提写。

### 4.9 增量回放（C2，三期，涉及后端与协议）

现在每次 attach 都「清屏 + 全量回放」。改为按输出序号增量补发：

- **后端**：`RemoteTerminal` 维护单调递增的输出字节序号 `seq`；`OutputRingBuffer` 记录缓冲起点的序号。每个 `output` 帧带上帧尾的 `seq`。
- **attach 帧**新增可选字段 `fromSeq`。服务端判断：`fromSeq` 不早于缓冲起点时，只回放 `[fromSeq, end)`，`attached` 帧带 `replay: 'delta'`；否则全量回放，带 `replay: 'full'`。两种回放都经过 `sanitizeReplayData`（增量部分同样是历史字节，同样可能含应答诱饵）。
- **前端**：每个终端记录已写入的最后 `seq`，attach 时带上。`onAttached` 只在 `replay === 'full'` 时写 RIS 清屏。
- **中继终端**：`local-terminal-relay.ts` 同样用 `new RemoteTerminal(...)` 建终端，缓冲在后端，所以自动获得这项能力，执行端（Electron / mao-agent）不用改。
- 协议向前不兼容也没关系（初版不考虑兼容），前后端同版本发布。

**评审补充（这一期有一个会让增量回放永久丢数据的漏洞，必须补）**：

1. **背压丢帧会打断 seq 链。** `terminal-ws-handler.ts` 的 `sendOutput` 在 `bufferedAmount > 1MB` 时直接丢整帧（只置 `dropped`，下一帧前补一行提示）。客户端若只记「最后收到的帧尾 seq」，被丢段会被下一帧更大的 seq 覆盖，`lastSeq` 直接跳过缺口，下次 attach 的 `fromSeq` 再也不会覆盖它。两种修法二选一：
   - `output` 帧带 `seq`（帧首）与 `endSeq`（帧尾）：客户端比较 `seq === expectedSeq`，不等就置 `needsFullReplay = true`（下次 attach 不带 `fromSeq`），相等则 `expectedSeq = endSeq`。这也能覆盖服务端重连后补发不连续的情况；
   - 服务端在丢帧时发显式 `seqGap: true`（或让客户端识别既有的 `DROPPED_NOTICE`），客户端据此清掉 `lastSeq`。
2. **缓冲起点 seq 要算上被裁掉的字节。** `OutputRingBuffer` 单帧超限时 `tailWithinBytes` 会砍掉该 chunk 的头部；缓冲区起点必须是 `chunkStartSeq + 被砍掉的字节数`，不能直接取 chunk 起点，否则增量回放会重复或漏掉一段。
3. **`fromSeq` 要校验。** 非整数 / 负数 / 大于当前 seq → 按全量处理；`fromSeq === seq` 时回 `attached(replay:'delta')` 且不发空 `output` 帧。
4. **seq 是原始流的字节偏移。** `sanitizeReplayData` 会删除 / 改写字节，不能用过滤后的长度推进 seq；回放帧的 `seq` 必须是原始流的帧尾。`fromSeq` 落在转义序列中间只对「同一个还活着的 xterm 实例」安全（它保留了前半段解析状态）；新实例（页面刷新、tab 重建）绝不能带 `fromSeq`。`lastSeq` 只存内存，不进 sessionStorage / localStorage。
5. **接口要能带上 fromSeq。** 现在 `useTerminalWS.attach(id)` 没有参数，且重连时 `onAuthenticated` 用 `attachedTerminals: Set<string>` 自动重发 attach。建议：`attach(id, { fromSeq })`，模块内用 `resumeSeq: Map<terminalId, number>` 保存；`registerTerminal` 也可以加 `getResumeSeq?: () => number | null`。`attached` 帧建议同时带当前 `seq`（空回放时客户端靠它推进 `lastSeq`），回放的 `output` 帧也带 `seq`，`onAttached(cols, rows, meta)` 增加 `replay` / `seq`。

效果：切任务、短暂断线、回前台都不再清屏，xterm 本地 5000 行 scrollback 得以保留；只有断线太久、缓冲已经滚过去、或者发生过背压丢帧时才全量回放。整页刷新仍会全量回放（§4.8）。

### 4.10 WebGL 恢复（C4，三期）

上下文丢失后仍然先 dispose 回落到 DOM 渲染；回到前台（visible）时尝试重新加载一次 WebGL addon，失败就放弃，在本实例生命周期内不再尝试。同时在中低端安卓机上对比 WebGL 和 DOM 渲染的帧率与内存，如果 DOM 渲染不差，可以考虑触屏端直接不加载 WebGL。

**评审补充**：重新加载必须 `new WebglAddon()`——已 dispose 的 addon 不能复用；在 `fit()` 之后、`visible` 时装载，用实例级的 `webglRetryUsed` 标记只试一次。`WebglAddon.dispose()` 会把 renderer 换回默认 DOM renderer，所以重装是受支持的。

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
| `desktop/src/components/common/Layout.vue` | `100dvh` | 一 |
| `desktop/src/style.css` | `html.android-capacitor .terminal-*` 迁移为 `.terminal-panel--touch` | 一 |
| `backend-ts/src/harness/terminal/remote-terminal.ts`、`terminal-ws-handler.ts` | 输出序号、增量回放（云端与中继终端共用） | 三 |

## 6. 分期

**一期（P0，纯前端）**：§4.1 判定统一；§4.2 触摸滚动和回到底部；§4.3 中的「不抢焦点、修饰键改 onData 层、DECCKM」（按键集合先维持现状，加上 Alt）；§4.4 粘贴；§4.5 中的「不自动聚焦」和 `dvh`（一期已让手机浏览器出现按键条，没有 `dvh` 底栏会被地址栏盖住）；§4.7。

**二期（P1，纯前端）**：§4.3 两行布局、弹层、长按连发；§4.4 选择文本；§4.5 默认高度、最大化、钳制；§4.6 字号与捏合；§4.8 回前台。

**三期（P2，前后端）**：§4.9 增量回放；§4.10 WebGL 恢复。**评审建议**：三期的收益（切任务/短断线不清屏）明显小于一、二期的「能用」，且协议改动带上面 §4.9 的丢帧缺口处理；如果排期紧，可以先把三期砍掉单独评估，不影响一、二期的交付。

## 7. 测试与验收

**单测（Vitest，desktop）**：

- `terminal-keys`：各键在 DECCKM 开 / 关时的编码；Ctrl / Alt 与方向键组合的 CSI 参数。
- `useTerminalModifiers`：Ctrl + 字母、Ctrl + 符号、Alt 前缀；单次用完复位、锁定保持；非 ASCII（中文整词）放行并复位。
- `terminal-touch-scroll`：像素换算成行时余数会累计；三种模式的分流（假 terminal 注入 `buffer.active.type`、`modes`）；点按不进入滚动态；两指不进入滚动态。
- 粘贴：多行检测；bracketed paste 开 / 关时是否需要确认；`readText` 失败时打开兜底对话框。
- `useTerminalWS`：visible 时连接已断则立即重连、未断则立即 ping。
- `useTerminal.test.ts` 补：触屏端 mount 不调用 `focus()`；onData 经过修饰键处理。

**评审补充（测试可写性）**：`desktop/vitest.config.ts` 是 `environment: 'node'`，jsdom 也不能 `new TouchEvent`。把「像素 → 行 / 速度 / 模式选择」抽成 `terminal-touch-scroll.ts` 里的纯函数单测，DOM 事件装配只留薄层，否则触摸滚动的用例会卡在事件构造上。`useTerminalWS` 的 visibility 用例要 stub `document`（node 环境没有），并断言「CONNECTING 时不重复 connect」「没有 attachedTerminals 时不重连」。另外补：复制层 `isWrapped` 续行合并 / 空缓冲 / 备用缓冲；粘贴与 `sendRaw` 不经过 `applyModifiers`；多字符整词提交不转 Ctrl。

**后端单测（三期）**：`remote-terminal.spec.ts` 覆盖 seq 递增和缓冲起点随截断移动（含单帧超限 `tailWithinBytes` 砍头后的起点）；`terminal-ws-handler.spec.ts` 覆盖 `fromSeq` 命中 / 过旧 / 缺省 / 非法四种情况、`fromSeq === seq` 的空回放，以及增量回放也经过 sanitize；客户端「帧首 seq 缺口 → needsFullReplay」也要有纯函数用例。

**构建**：`cd desktop && npm run build`；三期加 `cd backend-ts && npm run build && npm test`。

**实机验收**（安卓壳、安卓 Chrome、iOS Safari 各一遍，竖屏为主，横屏抽查）：

1. bash 里 `seq 1 3000` 后单指上下滑能翻到开头，有惯性；回到底部按钮出现 / 消失正确。
2. `less` 长文件、`vim` 里滑动翻页；`tmux` 开 mouse 后滑动滚动 tmux 历史。
3. 点按键条任意键软键盘不收起；`Ctrl` 后用软键盘敲 `c` 中断 `sleep 100`；`Alt` + `b` 在 bash 里按词左移。
4. Gboard 和一个国产输入法分别输入中英文混合内容，没有重复上屏（回归 `terminal-ime-guard`）。
5. 粘贴单行和多行；在 vim 插入模式粘贴多行，缩进不乱。
6. 「选择文本」复制一段报错，到对话输入框粘贴。
7. 最大化、调字号后 `tput cols` 随之变化；弹出键盘时面板不超出屏幕。
8. 切后台 5 分钟再回来，终端自动恢复（三期：不触发整页刷新时不清屏；刷新路径仍全量回放，见 §4.8）。
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
| 触摸手势被浏览器判成页面滚动 | 缺 `touch-action` 时首个 move 前就 `touchcancel`，自定义滚动收不到后续事件 | `.terminal-panel--touch .xterm { touch-action: none }` + `overscroll-behavior: contain`（§4.2） |
| iOS 页面 pinch 与字号捏合冲突 | iOS 页面缩放走 `gesturestart/gesturechange`，`touch-action` 不保证拦住 | 拦截 `gesturestart`；不稳则 iOS 只保留字号按钮（§4.6） |
| 背压丢帧打断 seq 链 | 客户端 `lastSeq` 跳过被丢帧，增量回放永久缺口 | `output` 帧带帧首 seq + 缺口检测 → 下次全量（§4.9） |
| 粘贴 / 按键条被修饰键改写 | `terminal.paste()` / `terminal.input()` 都走 `onData` | 粘贴与按键条走 `sendRaw`；修饰键只对单字符软键盘输入生效（§4.3 / §4.4） |
| 整页刷新仍清屏 | 新 xterm 实例没有 `lastSeq`，三期也救不回来 | 写进 G5 与验收项 8；要保留画面只能另做序列化恢复（非目标） |
| `visualViewport` resize 风暴 | iOS 工具栏 / 键盘动画期间连续 `fit`，给 PTY 连发 resize 帧 | rAF + ~100ms 节流，转屏同样走钳制后 fit（§4.5） |

## 9. 文档同步

实施时按期同步：

- `changelog/unreleased/` 新增碎片，小节为「前端（桌面 / Web / 安卓）」；三期另加「后端」。
- `skills/mao-cli/reference/desktop.md` 的「终端」章节：手机浏览器也有按键条、滑动翻看历史、选择文本、粘贴兜底、最大化与字号；三期更新「断线回放」描述（不再每次清屏）。
- `skills/mao-cli/reference/troubleshooting.md` 补「手机上粘贴失败 / 键盘遮挡」的排障说明。
