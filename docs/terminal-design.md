# 内嵌终端模块技术设计文档

> 版本：v1.0 | 日期：2026-06-05 | 状态：设计中

## 1. 需求概述

### 1.1 功能目标

在 Electron 桌面客户端中内置终端模块，替代现有的"打开系统终端"功能，提供类似 VSCode Terminal 的使用体验。

### 1.2 核心需求

| 项目 | 描述 |
|------|------|
| 位置 | 底部面板，挤压上方内容区域 |
| 多终端 | 支持多 Tab，创建、切换、关闭 |
| 默认 cwd | LOCAL 模式跟随任务工作区，CLOUD 模式打开本地 home 目录 |
| Shell | 读取用户 `$SHELL` 环境变量（macOS 默认 zsh，Linux 默认 bash） |
| 审批 | 无审批机制，用户直接操作 |
| 权限 | 所有登录用户可用 |
| 持久化 | 轻量方案，纯内存，关闭/重启后不恢复 |
| 面板高度 | 可拖拽调整，默认收起 |
| 快捷键 | `` Ctrl+` `` 展开/收起终端面板 |

### 1.3 V1 范围

**包含：**
- 底部面板 + 可拖拽高度
- 多终端 Tab（创建、切换、关闭）
- 真实 PTY + xterm.js 渲染
- ANSI 颜色、基本键盘交互
- 自动检测 `$SHELL`
- 默认 cwd 跟随工作区
- 快捷键展开/收起

**不含（V2）：**
- 终端内搜索
- 链接可点击
- 分屏
- 终端字体/主题配置
- cwd 与任务同步
- 终端输出持久化

## 2. 架构设计

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────────┐
│                    Renderer (Vue 3)                      │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  TaskView                                         │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  Chat Area (messages + input)               │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  TerminalPanel (可拖拽高度)                   │  │  │
│  │  │  ┌─────┬─────┬─────┬─────┐                 │  │  │
│  │  │  │Tab 1│Tab 2│Tab 3│  +  │  ← TerminalTabs  │  │  │
│  │  │  └─────┴─────┴─────┴─────┘                 │  │  │
│  │  │  ┌───────────────────────────────────────┐  │  │  │
│  │  │  │  xterm.js Terminal Instance           │  │  │  │
│  │  │  │  (每个 Tab 对应一个 xterm 实例)        │  │  │  │
│  │  │  └───────────────────────────────────────┘  │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
│                        │ window.electronAPI.terminal.*   │
│                        ▼ IPC                             │
│  ┌───────────────────────────────────────────────────┐  │
│  │  Preload Bridge (contextBridge)                   │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────┐
│                    Main Process                          │
│                                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │  TerminalManager                                  │  │
│  │  ┌─────────────────────────────────────────────┐  │  │
│  │  │  terminalSessions: Map<id, TerminalSession>  │  │  │
│  │  │  ┌──────────────┐  ┌──────────────┐        │  │  │
│  │  │  │ Session 1    │  │ Session 2    │  ...   │  │  │
│  │  │  │ pty (node-pty)│  │ pty          │        │  │  │
│  │  │  │ shell: zsh   │  │ shell: bash  │        │  │  │
│  │  │  │ cwd: /workspace│ │ cwd: ~      │        │  │  │
│  │  │  └──────────────┘  └──────────────┘        │  │  │
│  │  └─────────────────────────────────────────────┘  │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 2.2 与现有架构的关系

终端模块是**完全独立的新通道**，不与现有 Agent 工具执行体系耦合：

- **不复用** `shellSessions`（现有 marker 模式 shell 会话）
- **不复用** `handleShellFromWebSocket`（现有工具执行逻辑）
- **不经过** WebSocket 连接后端服务
- **不经过** 工具审批流

IPC 通道完全独立，使用新的 `terminal:*` 命名空间。

## 3. 详细设计

### 3.1 新增依赖

```jsonc
// package.json 新增
{
  "dependencies": {
    "@xterm/xterm": "^5.5.0",           // 终端模拟器 UI
    "@xterm/addon-fit": "^0.10.0",      // 自适应尺寸
    "@xterm/addon-web-links": "^0.11.0" // 链接检测（V2 启用）
  },
  "devDependencies": {
    "node-pty": "^1.0.0"                // 伪终端（原生模块）
  }
}
```

**node-pty 编译配置：**

在 `package.json` 的 `electron-builder` 配置中增加原生模块重建：

```jsonc
{
  "build": {
    "npmRebuild": true,
    "nodeGypRebuild": false,
    // ...
  }
}
```

在 `scripts` 中增加重建命令：

```jsonc
{
  "scripts": {
    "postinstall": "electron-rebuild -f -w node-pty"
  }
}
```

需要额外安装 `electron-rebuild` 作为 devDependency。

### 3.2 Main 进程 — TerminalManager

#### 文件：`desktop/electron/terminalManager.cjs`

独立模块，导出 TerminalManager 类，由 `main.cjs` 引入并初始化。

```javascript
// terminalManager.cjs 核心结构

const pty = require('node-pty');
const os = require('os');
const path = require('path');

class TerminalManager {
  constructor() {
    this.sessions = new Map(); // id -> TerminalSession
    this.nextId = 1;
  }

  /**
   * 创建新的终端会话
   * @param {object} options
   * @param {string} options.cwd - 初始工作目录
   * @param {number} options.cols - 列数
   * @param {number} options.rows - 行数
   * @param {string} [options.shell] - 指定 shell 路径，默认读取 $SHELL
   * @returns {{ id: string }}
   */
  create(options) {
    const id = `term_${this.nextId++}`;
    const shell = options.shell || this._detectShell();
    const cwd = options.cwd || os.homedir();

    const ptyProcess = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: options.cols || 80,
      rows: options.rows || 24,
      cwd: cwd,
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
      },
    });

    const session = {
      id,
      pty: ptyProcess,
      shell,
      cwd,
      createdAt: Date.now(),
    };

    this.sessions.set(id, session);
    return { id };
  }

  /**
   * 向终端写入数据（键盘输入）
   */
  write(id, data) {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.write(data);
    }
  }

  /**
   * 调整终端尺寸
   */
  resize(id, cols, rows) {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.resize(cols, rows);
    }
  }

  /**
   * 关闭终端会话
   */
  kill(id) {
    const session = this.sessions.get(id);
    if (session) {
      session.pty.kill();
      this.sessions.delete(id);
    }
  }

  /**
   * 关闭所有终端会话（应用退出时调用）
   */
  killAll() {
    for (const [id, session] of this.sessions) {
      session.pty.kill();
    }
    this.sessions.clear();
  }

  /**
   * 检测用户默认 shell
   */
  _detectShell() {
    if (process.env.SHELL) {
      return process.env.SHELL;
    }
    // macOS 默认 zsh，其他平台默认 bash
    return process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
  }

  /**
   * 获取终端会话列表
   */
  list() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      shell: s.shell,
      cwd: s.cwd,
      createdAt: s.createdAt,
    }));
  }
}

module.exports = { TerminalManager };
```

#### main.cjs 修改点

```javascript
// 引入 TerminalManager
const { TerminalManager } = require('./terminalManager.cjs');
const terminalManager = new TerminalManager();

// 注册 IPC handlers
ipcMain.handle('terminal:create', (event, options) => {
  const result = terminalManager.create(options);

  // 监听 pty 输出，推送到渲染端
  const session = terminalManager.sessions.get(result.id);
  session.pty.onData((data) => {
    mainWindow.webContents.send('terminal:data', {
      id: result.id,
      data,
    });
  });

  // 监听 pty 退出
  session.pty.onExit(({ exitCode }) => {
    mainWindow.webContents.send('terminal:exit', {
      id: result.id,
      exitCode,
    });
    terminalManager.sessions.delete(result.id);
  });

  return result;
});

ipcMain.on('terminal:data', (event, { id, data }) => {
  terminalManager.write(id, data);
});

ipcMain.on('terminal:resize', (event, { id, cols, rows }) => {
  terminalManager.resize(id, cols, rows);
});

ipcMain.handle('terminal:kill', (event, { id }) => {
  terminalManager.kill(id);
});

ipcMain.handle('terminal:list', () => {
  return terminalManager.list();
});

// 应用退出时清理
app.on('before-quit', () => {
  terminalManager.killAll();
});
```

**IPC 命名规范说明：**

- `terminal:data`（渲染端 → Main）使用 `ipcMain.on`（fire-and-forget，高频键盘输入不需要 Promise）
- `terminal:create`、`terminal:kill`、`terminal:list` 使用 `ipcMain.handle`（需要返回值）
- `terminal:data`、`terminal:exit`（Main → 渲染端）使用 `mainWindow.webContents.send`

### 3.3 Preload Bridge

#### preload.cjs 新增

```javascript
// 在 contextBridge.exposeInMainWorld 的 electronAPI 对象中增加 terminal 命名空间

terminal: {
  // 创建终端，返回 { id }
  create: (options) => ipcRenderer.invoke('terminal:create', options),

  // 向终端写入数据（键盘输入），高频调用用 send 而非 invoke
  write: (id, data) => ipcRenderer.send('terminal:data', { id, data }),

  // 调整终端尺寸
  resize: (id, cols, rows) => ipcRenderer.send('terminal:resize', { id, cols, rows }),

  // 关闭终端
  kill: (id) => ipcRenderer.invoke('terminal:kill', { id }),

  // 获取终端列表
  list: () => ipcRenderer.invoke('terminal:list'),

  // 监听终端输出（Main → Renderer）
  onData: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('terminal:data', handler);
    return () => ipcRenderer.removeListener('terminal:data', handler);
  },

  // 监听终端退出（Main → Renderer）
  onExit: (callback) => {
    const handler = (event, payload) => callback(payload);
    ipcRenderer.on('terminal:exit', handler);
    return () => ipcRenderer.removeListener('terminal:exit', handler);
  },
},
```

**类型声明：** 在 `src/types/electron.d.ts` 中补充 `window.electronAPI.terminal` 的 TypeScript 类型。

### 3.4 Renderer — 组件设计

#### 3.4.1 组件结构

```
src/components/terminal/
├── TerminalPanel.vue      # 底部面板容器（高度拖拽 + 展开/收起）
├── TerminalTabs.vue       # Tab 栏（创建、切换、关闭）
├── TerminalView.vue       # 单个终端实例（xterm.js 封装）
└── useTerminal.ts         # Composable（终端状态管理 + IPC 通信）
```

#### 3.4.2 useTerminal.ts — Composable

```typescript
// src/composables/useTerminal.ts

import { ref, shallowRef, onUnmounted } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface TerminalTab {
  id: string;        // 与 Main 进程 session id 对应
  title: string;     // 显示标题（如 "zsh", "bash"）
  cwd: string;       // 当前工作目录
}

// 模块级单例状态
const tabs = ref<TerminalTab[]>([]);
const activeTabId = ref<string | null>(null);
const isOpen = ref(false);

// 终端实例缓存：id -> { terminal, fitAddon, disposers }
const instances = new Map<string, {
  terminal: Terminal;
  fitAddon: FitAddon;
  disposers: Array<() => void>;
}>();

// IPC 事件清理函数
let removeDataListener: (() => void) | null = null;
let removeExitListener: (() => void) | null = null;

export function useTerminal() {
  // 初始化 IPC 监听（仅执行一次）
  function initListeners() {
    if (removeDataListener) return;

    removeDataListener = window.electronAPI.terminal.onData(
      ({ id, data }: { id: string; data: string }) => {
        const inst = instances.get(id);
        if (inst) {
          inst.terminal.write(data);
        }
      }
    );

    removeExitListener = window.electronAPI.terminal.onExit(
      ({ id, exitCode }: { id: string; exitCode: number }) => {
        // 移除 tab 和实例
        removeTab(id);
      }
    );
  }

  /**
   * 创建新终端
   * @param cwd 初始工作目录
   */
  async function createTerminal(cwd?: string): Promise<string> {
    initListeners();

    const cols = 80;
    const rows = 24;
    const result = await window.electronAPI.terminal.create({ cwd, cols, rows });
    const id = result.id;

    // 创建 xterm 实例
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#ffffff',
        // 更多颜色跟随主题...
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    instances.set(id, { terminal, fitAddon, disposers: [] });

    // 将键盘输入转发到 Main 进程
    const dataDisposer = terminal.onData((data) => {
      window.electronAPI.terminal.write(id, data);
    });

    // 监听 resize 事件（由外部触发 fit 时产生）
    const resizeDisposer = terminal.onResize(({ cols, rows }) => {
      window.electronAPI.terminal.resize(id, cols, rows);
    });

    instances.get(id)!.disposers.push(
      () => dataDisposer.dispose(),
      () => resizeDisposer.dispose()
    );

    // 添加 tab
    const shellName = detectShellName();
    tabs.value.push({ id, title: shellName, cwd: cwd || '~' });
    activeTabId.value = id;

    return id;
  }

  /**
   * 将 xterm 实例挂载到 DOM 元素
   */
  function mountTerminal(id: string, container: HTMLElement) {
    const inst = instances.get(id);
    if (!inst) return;

    inst.terminal.open(container);
    // 延迟 fit，等待 DOM 渲染完成
    requestAnimationFrame(() => {
      inst.fitAddon.fit();
      // 将实际尺寸同步到 Main 进程
      window.electronAPI.terminal.resize(
        id,
        inst.terminal.cols,
        inst.terminal.rows
      );
    });
  }

  /**
   * 触发 fit（窗口 resize 时调用）
   */
  function fitTerminal(id: string) {
    const inst = instances.get(id);
    if (!inst) return;
    inst.fitAddon.fit();
  }

  /**
   * 切换活跃 Tab
   */
  function switchTab(id: string) {
    activeTabId.value = id;
  }

  /**
   * 关闭终端
   */
  async function closeTerminal(id: string) {
    await window.electronAPI.terminal.kill(id);
    removeTab(id);
  }

  /**
   * 内部：移除 tab 和清理实例
   */
  function removeTab(id: string) {
    const inst = instances.get(id);
    if (inst) {
      inst.disposers.forEach(d => d());
      inst.terminal.dispose();
      instances.delete(id);
    }

    const idx = tabs.value.findIndex(t => t.id === id);
    if (idx !== -1) {
      tabs.value.splice(idx, 1);
    }

    // 如果关闭的是当前活跃 tab，切换到相邻 tab
    if (activeTabId.value === id) {
      if (tabs.value.length > 0) {
        const newIdx = Math.min(idx, tabs.value.length - 1);
        activeTabId.value = tabs.value[newIdx].id;
      } else {
        activeTabId.value = null;
        isOpen.value = false; // 所有 tab 关闭后收起面板
      }
    }
  }

  /**
   * 切换面板展开/收起
   */
  function togglePanel() {
    isOpen.value = !isOpen.value;
    // 展开时如果没有终端，自动创建一个
    if (isOpen.value && tabs.value.length === 0) {
      createTerminal();
    }
  }

  /**
   * 获取活跃终端实例（供外部组件使用）
   */
  function getActiveInstance() {
    if (!activeTabId.value) return null;
    return instances.get(activeTabId.value) || null;
  }

  function detectShellName(): string {
    const shell = import.meta.env.VITE_SHELL || '/bin/zsh';
    return shell.split('/').pop() || 'zsh';
  }

  // 清理
  onUnmounted(() => {
    // 不在这里清理全局监听，因为 useTerminal 是单例模式
    // 清理在应用退出时由 Main 进程的 terminalManager.killAll() 处理
  });

  return {
    // 状态
    tabs,
    activeTabId,
    isOpen,
    // 操作
    createTerminal,
    mountTerminal,
    fitTerminal,
    switchTab,
    closeTerminal,
    togglePanel,
    getActiveInstance,
  };
}
```

#### 3.4.3 TerminalPanel.vue — 底部面板

```vue
<!-- 概念结构，非完整代码 -->
<template>
  <div v-show="isOpen" class="terminal-panel" :style="{ height: panelHeight + 'px' }">
    <!-- 拖拽条 -->
    <div class="terminal-resize-handle" @mousedown="startResize" />

    <!-- Tab 栏 -->
    <TerminalTabs
      :tabs="tabs"
      :active-id="activeTabId"
      @switch="switchTab"
      @close="closeTerminal"
      @create="createTerminal"
    />

    <!-- 终端容器 -->
    <div class="terminal-container">
      <!-- 每个 tab 对应一个容器，通过 v-show 控制显隐 -->
      <div
        v-for="tab in tabs"
        :key="tab.id"
        v-show="tab.id === activeTabId"
        :ref="el => setContainerRef(tab.id, el)"
        class="terminal-instance"
      />
    </div>
  </div>
</template>
```

**关键设计决策：**

- 使用 `v-show` 而非 `v-if` 切换终端实例，避免 xterm 实例被销毁重建
- 每个终端实例挂载到独立的 `<div>` 容器
- 通过 `:ref` 回调收集容器引用，在 Tab 切换时调用 `mountTerminal` / `fitTerminal`

#### 3.4.4 面板高度拖拽

```typescript
// TerminalPanel.vue 中的拖拽逻辑

const panelHeight = ref(300); // 默认高度 300px
const MIN_HEIGHT = 100;
const MAX_HEIGHT_RATIO = 0.7; // 最大不超过视口高度的 70%

function startResize(e: MouseEvent) {
  const startY = e.clientY;
  const startHeight = panelHeight.value;

  function onMove(e: MouseEvent) {
    const delta = startY - e.clientY; // 向上拖拽为正值
    const maxHeight = window.innerHeight * MAX_HEIGHT_RATIO;
    panelHeight.value = Math.max(MIN_HEIGHT, Math.min(maxHeight, startHeight + delta));
    // 触发当前活跃终端的 fit
    if (activeTabId.value) {
      fitTerminal(activeTabId.value);
    }
  }

  function onUp() {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
  document.body.style.cursor = 'row-resize';
  document.body.style.userSelect = 'none';
}
```

### 3.5 布局集成

#### TaskView.vue 改造

当前 TaskView 的 `.task-container` 结构：

```
.task-container (flex-column)
  ├── .messages (flex: 1, overflow-y: auto)
  ├── QueuePanel (flex-shrink: 0)
  └── ChatInput (flex-shrink: 0)
```

改造后：

```
.task-container (flex-column)
  ├── .chat-area (flex: 1, min-height: 0, flex-column)
  │   ├── .messages (flex: 1, overflow-y: auto)
  │   ├── QueuePanel (flex-shrink: 0)
  │   └── ChatInput (flex-shrink: 0)
  └── TerminalPanel (flex-shrink: 0, 可拖拽高度, v-show)
```

将原来的 `messages + QueuePanel + ChatInput` 包裹在一个新的 `.chat-area` 容器中，TerminalPanel 放在其下方。TerminalPanel 的高度由拖拽控制，`.chat-area` 自动占据剩余空间。

#### CSS 变量新增

```css
:root {
  --aw-terminal-bg: #1e1e1e;
  --aw-terminal-header-height: 36px;  /* Tab 栏高度 */
}
```

### 3.6 快捷键

在 `Layout.vue` 或 `TaskView.vue` 中注册全局快捷键：

```typescript
// TaskView.vue
useEventListener(document, 'keydown', (e: KeyboardEvent) => {
  // Ctrl+` 或 Cmd+` 切换终端面板
  if ((e.ctrlKey || e.metaKey) && e.key === '`') {
    e.preventDefault();
    togglePanel();
  }
});
```

### 3.7 默认 cwd 逻辑

```typescript
// 在 TaskView.vue 中创建终端时传入 cwd

async function getDefaultCwd(): Promise<string | undefined> {
  const session = sessionStore.activeSession;
  if (!session) return undefined;

  // LOCAL 模式：使用任务工作区
  if (session.executionMode === 'LOCAL' && session.workspace) {
    return session.workspace;
  }

  // CLOUD 模式或无工作区：undefined（Main 进程会使用 os.homedir()）
  return undefined;
}
```

切换活跃任务时，不自动切换已有终端的 cwd（避免打断用户操作）。新创建的终端使用当前任务的工作区。

## 4. 文件变更清单

### 4.1 新增文件

| 文件 | 说明 |
|------|------|
| `desktop/electron/terminalManager.cjs` | Main 进程终端管理器 |
| `desktop/src/composables/useTerminal.ts` | 终端 Composable |
| `desktop/src/components/terminal/TerminalPanel.vue` | 底部面板容器 |
| `desktop/src/components/terminal/TerminalTabs.vue` | Tab 栏组件 |
| `desktop/src/components/terminal/TerminalView.vue` | xterm 实例封装（可选，逻辑可内联到 Panel） |
| `desktop/src/types/electron.d.ts` | electronAPI 类型声明（补充 terminal 命名空间） |

### 4.2 修改文件

| 文件 | 变更 |
|------|------|
| `desktop/package.json` | 新增依赖：@xterm/xterm、@xterm/addon-fit、node-pty；新增 postinstall 脚本 |
| `desktop/electron/main.cjs` | 引入 TerminalManager，注册 terminal:* IPC handlers，before-quit 清理 |
| `desktop/electron/preload.cjs` | 暴露 window.electronAPI.terminal.* API |
| `desktop/src/views/task/TaskView.vue` | 集成 TerminalPanel，改造布局结构，注册快捷键 |
| `desktop/src/components/common/Layout.vue` | 可能需要调整布局（如果终端面板需要跨全宽） |
| `desktop/src/style.css` | 新增终端相关 CSS 变量 |

### 4.3 不变文件

- 后端代码无任何变更
- 现有 Shell 会话管理（`handleShellFromWebSocket`）不变
- WebSocket 连接逻辑不变
- Pinia stores 不变（终端状态在 useTerminal composable 内管理）

## 5. 数据流

### 5.1 创建终端

```
用户点击 "+" 按钮
  → TerminalTabs emit "create"
  → useTerminal.createTerminal(cwd)
  → ipcRenderer.invoke('terminal:create', { cwd, cols, rows })
  → Main: terminalManager.create(options)
  → pty.spawn(shell, [], { cwd, cols, rows, ... })
  → 返回 { id }
  → Renderer: 创建 xterm.Terminal 实例
  → 添加 tab 到 tabs[]
  → activeTabId = id
  → TerminalPanel 渲染新 tab 的容器 div
  → mountTerminal(id, container)
  → terminal.open(container)
  → fitAddon.fit()
```

### 5.2 键盘输入

```
用户在 xterm 中按键
  → xterm.onData callback
  → ipcRenderer.send('terminal:data', { id, data })
  → Main: terminalManager.write(id, data)
  → pty.write(data)
  → pty 产生输出
  → pty.onData callback
  → mainWindow.webContents.send('terminal:data', { id, data })
  → Renderer: ipcRenderer 'terminal:data' handler
  → terminal.write(data)
  → xterm 渲染输出
```

### 5.3 窗口 resize

```
用户拖拽窗口边缘
  → TaskView 监听 resize 事件
  → fitTerminal(activeTabId)
  → fitAddon.fit()
  → xterm.onResize callback
  → ipcRenderer.send('terminal:resize', { id, cols, rows })
  → Main: pty.resize(cols, rows)
```

### 5.4 关闭终端

```
用户点击 Tab 的关闭按钮
  → TerminalTabs emit "close" (id)
  → useTerminal.closeTerminal(id)
  → ipcRenderer.invoke('terminal:kill', { id })
  → Main: pty.kill() + sessions.delete(id)
  → Renderer: terminal.dispose() + 移除 tab
  → 如果无剩余 tab，isOpen = false（面板收起）
```

## 6. node-pty 编译与打包

### 6.1 开发环境

```bash
# 安装依赖后自动执行 electron-rebuild
npm install
# 或手动执行
npx electron-rebuild -f -w node-pty
```

### 6.2 生产打包

electron-builder 默认会处理原生模块的 rebuild。需要确认：

```jsonc
// package.json electron-builder 配置
{
  "build": {
    "npmRebuild": true,
    "mac": {
      "target": "dmg"
    }
  }
}
```

### 6.3 潜在风险

| 风险 | 应对 |
|------|------|
| node-pty 编译失败（缺少 C++ 编译工具链） | 文档中说明需要 Xcode Command Line Tools (macOS) 或 build-essential (Linux) |
| Electron 版本升级后 node-pty 不兼容 | 通过 electron-rebuild 重新编译，node-pty 对 Electron 版本一般兼容 |
| macOS ARM64 vs x64 架构差异 | electron-builder 支持 per-arch 构建，node-pty 支持多架构 |

## 7. 样式规范

遵循现有的 Apple 设计风格（`style.css` 中的设计令牌）：

```css
.terminal-panel {
  background: var(--aw-canvas);
  border-top: 1px solid var(--aw-divider-soft);
  display: flex;
  flex-direction: column;
  position: relative;
}

.terminal-resize-handle {
  position: absolute;
  top: -3px;
  left: 0;
  right: 0;
  height: 6px;
  cursor: row-resize;
  z-index: 10;
}

.terminal-resize-handle:hover {
  background: var(--aw-primary);
  opacity: 0.3;
}

.terminal-tabs {
  height: var(--aw-terminal-header-height);
  display: flex;
  align-items: center;
  padding: 0 12px;
  gap: 4px;
  border-bottom: 1px solid var(--aw-divider-soft);
  background: var(--aw-bg-secondary);
  flex-shrink: 0;
}

.terminal-container {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  background: var(--aw-terminal-bg);
}

.terminal-instance {
  width: 100%;
  height: 100%;
}
```

## 8. 测试验证

### 8.1 功能验证项

- [ ] 快捷键 `` Ctrl+` `` 展开/收起终端面板
- [ ] 点击 "+" 创建新终端 Tab
- [ ] Tab 切换，终端实例保持状态
- [ ] Tab 关闭，实例正确清理
- [ ] 最后一个 Tab 关闭后面板自动收起
- [ ] 键盘输入正确传递，命令执行有输出
- [ ] ANSI 颜色正确渲染
- [ ] 交互式程序（如 `vim`、`top`）可正常使用
- [ ] 拖拽调整面板高度，终端自适应
- [ ] 窗口 resize 后终端自适应
- [ ] LOCAL 模式下默认 cwd 为任务工作区
- [ ] CLOUD 模式下默认 cwd 为 home 目录
- [ ] 应用退出时终端进程正确清理（无僵尸进程）
- [ ] 多终端并行运行不互相干扰
