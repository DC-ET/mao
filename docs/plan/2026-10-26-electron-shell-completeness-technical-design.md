# Electron 壳补完（LOCAL 附件 + 托盘 / 通知 / 快捷键 / 自启）技术方案

> 版本：v1.2（2026-10-26 评审后：v1.1 修正事实错误与改动面遗漏；v1.2 按需求方决定将附件落盘从「工作区内」改为「`~/.mao/attachments/` 机器级目录」，连带删除 git exclude 链路，修订记录见 §12；**需求与方案结论：可行**）
> 状态：待评审（§0 决策已于 2026-10-26 与需求方逐条确认：**关窗默认托盘化、附件落盘 `~/.mao/attachments/` 按 host+会话分目录（发送时懒拷贝）、通知可达边界为托盘模式闭环、快捷键默认 Alt+Shift+M**；其余四项按推荐列落定）（提案见 [../proposals/2026-10-25-electron-shell-completeness.md](../proposals/2026-10-25-electron-shell-completeness.md)，第十六批）

## 0. 待确认决策（2026-10-26 已逐条定）

| # | 决策点 | 结论 | 连带影响 |
|---|--------|------|------|
| 1 | 附件落盘目录 | **`~/.mao/attachments/<serverHost>/<sessionId>/`**（机器级、按服务器 host 隔离，仿既有 `~/.mao/runtime/<host>/<sessionId>/` 约定；2026-10-26 评审后由需求方改定，原为 `<workspace>/.mao/attachments/<sid>/`） | 引用改为**绝对路径**（与 CLOUD 懒上传 `@{绝对路径}@` 同形态，`resolveFileRefPaths` 的绝对路径跳过分支天然兼容——但需修 Windows 盘符判断，见 §5.2）；**`ensureGitExclude` 整条链路删除**（不碰用户 git 配置，风险 #8 消除）；放弃工作区内可发现性（Agent 仅凭消息内的绝对路径读取，glob/grep 扫不到——明确接受的取舍）；发送时懒拷贝（新任务态 drop 时 sessionId 不存在，见 §5.2） |
| 2 | 重名策略 | `-1` / `-2` 数字后缀 | 确定性、可单测 |
| 3 | 关窗默认行为 | **默认「最小化到托盘」**；「关窗即退出」为可选项 | 通知闭环默认生效；首次关窗一次性托盘提示；退出经菜单 / Cmd+Q / 托盘三条路径（§5.3） |
| 4 | 系统通知粒度 | 沿用收件箱既有 kind 级偏好 + 总开关 | 只换投递通道，不造第二套偏好 |
| 5 | 全局快捷键 | `Alt+Shift+M`，可改可关 | 注册失败静默降级 + 设置页提示 |
| 6 | 角标范围 | 仅 macOS dock 角标 | Windows overlay 列为后续可选 |
| 7 | 通知可达边界 | 接受边界：托盘模式闭环，退出模式与今天一致 | 验收口径按 §9；不做 main 独立连接 |
| 8 | 自启在 dev 模式 | `app.isPackaged` 守卫，dev 下设置页禁用 | 防 electron 二进制误入登录项 |

## 1. 需求背景

提案（§1）已论证并全部代码核实：

- **LOCAL 递不了任意文件**：`ChatInput.vue:978-979` 非图片文件在 LOCAL 分支被整体拦截（「本地模式不支持文件上传，请使用 @ 引用工作区文件」）。而 CLOUD 侧能力齐全：`chatFileUpload.ts` 把文件传服务端 runtime incoming 目录，以 `@{绝对路径}@` 写进消息（`uploadPendingFiles`）。图片在 LOCAL 反而能传（视觉通道要求消息附件上服务端，0.0.336 URL 注入先例）。**结论：非图片文件是唯一被 LOCAL 拦掉的附件形态。**
- **壳能力整层缺席**：`main.cjs`（2520 行、48 个 ipcMain handler）内零命中 Tray / globalShortcut / setLoginItemSettings / 主进程 Notification / 单实例锁（`requestSingleInstanceLock` 无调用）。
- **通知链路断在窗口关闭**：系统通知由渲染层 `useInboxSystemNotify.ts` 在 `useStreamWS` 的 `inbox_updated` 事件里发出（HTML5 `Notification`，`:130`），触发条件是 `document.hidden || !document.hasFocus()`。**窗口一关渲染层销毁、WS 断开，事件流本身断了**——这是「关窗即失联」的机制根源，不是通知通道问题。因此决策 7：只有「关窗=隐藏」（渲染层存活）模式才有通知闭环；退出模式维持现状，文档明示。
- 既有可复用资产：`serverConfig.cjs`（Electron 侧配置存储 + 测试先例，`serverConfig.test.cjs`）、`gitOperations.cjs`（git 操作服务层 + 测试）、`resolveWorkspacePath()`（`main.cjs:1009`，路径解析 helper——注意不做 workspace containment，见 §3）、`preload.cjs` 的 `exposeInMainWorld` 单一暴露模式、`SettingsView.vue:75` 的 `showServerNav = isElectronClient()` Electron 专属分区先例、`test:unit` 脚本（`vitest run && node --test electron/gitOperations.test.cjs electron/localShell.test.cjs electron/serverConfig.test.cjs`——**显式列文件而非 glob**，新增 `chatAttachment.test.cjs` / `desktopPrefs.test.cjs` 必须同步补进脚本，否则 CI 不执行；或索性改 glob 一劳永逸）。

## 2. 需求描述

### 2.1 目标

1. **P1 LOCAL 附件**：Electron 下拖拽 / 选择任意文件 → 暂存待发列表 → 发送时（会话已落库）拷入 `~/.mao/attachments/<服务器host>/<sessionId>/`（文件不出本机）→ 以 `@{绝对路径}@` 追加进消息文本（与 CLOUD 懒上传同一时机、同款返回）→ Agent 经既有 LOCAL 文件工具读取。
2. **P2 壳常驻**：托盘 + 关窗行为设置（退出 / 最小化到托盘）；通知投递改主进程（窗口隐藏仍可达，退出模式维持现状）；macOS dock 角标（收件箱未读数）；补单实例锁（托盘 / 自启 / dock 复活的必要前置）。
3. **P3 快捷与自启**：全局快捷键唤起 / 隐藏；开机自启（`app.isPackaged` 守卫）；设置页新增「桌面」分区（仅 Electron 显示）。

### 2.2 范围边界

| 维度 | 做 | 不做 |
|------|----|------|
| 附件 | 非图片任意文件，LOCAL + Electron | 不改图片路径（仍上服务端，视觉通道语义）；不动 CLOUD 上传链路 |
| 通知 | 换主进程投递 + 退出模式维持现状 | 不做 main 独立 WS 连接（决策 7）；不做通知历史持久化（站内收件箱已承担） |
| 托盘 | 显示/隐藏 + 新建任务 + 退出；关窗行为可配 | 不做快速发送小窗；不做深链 `mao://` |
| 自启 | packaged 下 `openAsHidden` 登录项 | dev 模式禁用（决策 8） |
| 平台 | Electron（mac/win/linux 文档注明差异） | 不碰安卓壳（系统推送是既有排除项） |
| 后端 | 零改动、零迁移 | 不新增端点、不碰 CLOUD 上传配置 |

## 3. 技术选型

| 项 | 选型 | 理由 |
|----|------|------|
| 附件拷贝 | 新 `electron/chatAttachment.cjs`（纯函数 + node --test 测试），IPC 单 handler 驱动 | 照 `gitOperations.cjs` / `serverConfig.cjs` 既有范式；路径 sanitize 与 host/session 目录构造、home 收敛是可测纯逻辑 |
| 桌面偏好 | 新 `electron/desktopPrefs.cjs`，`userData/desktop-prefs.json`（tmp+rename 原子写、内存缓存） | 仿 `serverConfig.cjs` 的文件布局与坏文件回退；**原子写与内存缓存是本方案新增**（`serverConfig.cjs` 实为 `writeFileSync` 直写、每次读盘无缓存，见其 `readServerConfig`/`setServerConfig`；prefs 会被 close / quit / 快捷键等路径高频读，缓存有必要）；偏好是**机器级**（不随 server 切换、登出不清），与账号级后端 preference 分开 |
| 文件路径获取 | `File.path`（Electron 28 可用，**32.0 起被移除**），preload 预留 `getPathForFile` 通道 | 修正：`webUtils.getPathForFile` 是 **Electron 32.0 新增**（替代同版本移除的 `File.path`），29/30/31 仍走 `File.path`；渲染层 compat 写法 `file.path ?? electronAPI.getPathForFile(file)` 不变，升级到 32 时只改 preload 一处实现 |
| 附件根目录收敛 | `resolveAttachmentTarget(hostKey, sessionId, name)` 内 `path.resolve(os.homedir(), '.mao/attachments', hostKey, String(sessionId), name)` + 对 home 的 `path.relative` 断言不出界；hostKey 由主进程 `getServerHostKey()` 自带（不信任渲染层入参） | 目标本就在 Mao 自管目录，**不再需要 workspace containment**（决策 1 改定后 `resolveWorkspacePath` 与此链路无关）；收敛由「sanitize 后的 basename + host/session 强校验 + 固定前缀 + relative 断言」按构造保证；`~/.mao` 存在且非目录 → 抛错（用户可读文案） |
| 通知 | 主进程 `Notification` + 双向 IPC（`desktop-notify` / `desktop-notification-click`） | 窗口销毁后仍可投递；渲染层只保留「弹不弹」的决策逻辑（diff / 偏好 / 窗口态），不保留投递 |
| 单实例 | `requestSingleInstanceLock` + `second-instance` 唤起主窗 | 托盘 / 自启 / dock 双击的必修项；顺带修掉今天「多开实例争用 auth.json」 |
| 快捷键 | `globalShortcut`（默认 `Alt+Shift+M`） | 注册失败有 `failed` 事件可回传提示 |
| 自启 | `app.setLoginItemSettings({ openAtLogin, openAsHidden: true })` + `app.isPackaged` 守卫 | 决策 8 |
| 角标 | macOS `app.dock.setBadgeCount` | 决策 6 |

## 4. 总体架构

### 4.1 P1 附件链路（与 CLOUD 并行、不交叉）

**懒拷贝时序**（决策 1 的直接后果）：新任务态拖入文件时会话尚未创建（sessionId 不存在），因此拷贝不在 drop 时发生，而是与 CLOUD 的懒上传（`chatFileUpload.ts`：文件暂存 `pendingFiles`、发送时 `ensureSession` 拿到 sid 再上传）**同一时机**——发送时拷贝并追加引用。已有会话中拖入文件同样走暂存 + 发送时拷贝，行为统一。

```
渲染层 ChatInput（LOCAL + Electron 分支）
  drag/drop 或 picker 得到 File 对象 → 暂存 pendingFiles（local 类型，此时不拷贝、不插 chip）
发送时（ensureSession 已拿到 sid，与 uploadPendingFiles 同一 call site）
  → file.path（Electron 32+ 走 preload getPathForFile 兜底）
  → invoke('local-copy-attachment', { sourcePath, sessionId, maxSizeMb })
主进程 chatAttachment.cjs
    → lstatSync 普通文件？/ 大小复核（防御纵深）
    → sanitize 文件名（basename、遍历字符、保留名、长度、控制字符）
    → path.resolve(os.homedir(), '.mao/attachments', getServerHostKey(), String(sessionId), name) + home 相对断言
    → copyFile；冲突追加 -1/-2
    → 返回 { ok: true, absolutePath: '<home>/.mao/attachments/<host>/<sid>/xxx' }（展开后的绝对路径，不用 ~ 简写）
渲染层 chatLocalAttach.ts 把 @{absolutePath}@ 追加进消息文本（与 CLOUD uploadPendingFiles 同款结构）
Agent 侧：绝对路径原样透过 resolveFileRefPaths（跳过分支，见 §5.2 Windows 盘符修正）→ LOCAL 文件工具直接读
```

**与 CLOUD 的形态统一（决策 1 改定后的收益）**：LOCAL 附件引用与 CLOUD 懒上传一样是 `@{绝对路径}@`——只是根目录从服务端 runtime incoming 变成本机 `~/.mao/attachments/<host>/<sid>/`；主路径与边路路径都不再需要相对→绝对的改写分歧（`resolveFileRefPaths` 对绝对路径原样透过），此前 v1.1 §7 #10 的「边路形态不一致」问题随之消失。

**语义边界（必须写进用户可感知的文案与文档）**：图片 = 消息附件，上服务端（视觉通道需要服务端下载，0.0.336 先例，LOCAL 也一样）；其他文件 = 本机 Mao 自管目录（`~/.mao/attachments/`）内的副本，**不出本机**（LOCAL 卖点）。两条路径对用户可见的差别仅在 chip 与提示，对 Agent 是同一条 `@{...}@` 协议。

### 4.2 P2 通知链路改造（前后对比）

```
今天：
  WS(inbox_updated) → renderer diff（knownIds/偏好/窗口态）→ new Notification（渲染层）
  窗口关闭 → 渲染层销毁 → 事件流断 → 无通知

改造后（关窗=隐藏模式）：
  WS(inbox_updated) → renderer diff（逻辑不变）→ invoke('desktop-notify', {title, body, tag, itemId, sessionId})
                                              → 主进程 new Notification（渲染层隐藏也活着）
  通知 click → 主进程 send('desktop-notification-click', {itemId, sessionId}) → 渲染层 show+foucs+路由跳转
  退出模式：渲染层销毁 → 与今天一致（无通知）——文档明示，不承诺
```

主进程是**哑管道**：不缓存偏好、不做 diff、不读收件箱；登出 / 切服务器时渲染层状态清零，主进程无残留可泄。

### 4.3 生命周期（关窗 / 退出 / 登出三态；默认托盘化，决策 3）

```
red-button close / 窗口菜单「关闭」
  ├─ prefs.closeToTray == 'tray'（默认）→ preventDefault + hide（渲染层存活，WS 存活，终端存活）
  │    └─ 首次关窗一次性 ElMessage：「已最小化到托盘，任务完成会通知你；彻底退出请用托盘菜单」
  └─ prefs.closeToTray == 'quit'（可选）→ 现状：win/linux 退出（window-all-closed），mac 销毁窗口 app 存活
退出三条路径（任一都走 app.quit() → before-quit：quitting=true → killAll pty/closeAll shell/MCP 清理）
  tray「退出」/ 应用菜单「退出 Mao」（Cmd+Q / Alt+F4，main.cjs:517 既有 role:quit）/ 登出后的托盘退出
登出 → 渲染层清 auth → 主进程 auth.json 清除不变；desktop-prefs.json 不动（机器级）
```

## 5. 详设

### 5.1 桌面偏好（`electron/desktopPrefs.cjs`）

```ts
interface DesktopPrefs {
  closeToTray: 'quit' | 'tray'        // 默认 'tray'（决策 3）
  trayHintShown?: boolean            // 首次关窗托盘提示已展示（一次性）
  globalShortcut: string | null       // 默认 'Alt+Shift+M'，null=关闭
  autoStart: boolean                  // 默认 false
}
```

- 存储 `userData/desktop-prefs.json`，读时内存缓存、写时 tmp+rename（照 serverConfig 模式），坏文件回退默认值（不阻断启动）。
- 不随 server 切换、不随登出清除；版本演进只加字段，用 `?? default` 兼容。
- `desktop-prefs.test.cjs`：默认值、坏文件回退、并发写原子性（rename 语义用 mock fs 断言）。

### 5.2 P1 附件（`electron/chatAttachment.cjs` + 1 个 IPC + 渲染层懒拷贝）

**时序总原则**：拷贝只发生在**发送时**（会话已落库、sessionId 已知），与 CLOUD 懒上传（`chatFileUpload.ts`：暂存 `pendingFiles` → 发送时上传并追加 `@{绝对路径}@`）严格同时机、同结构。drop 时只暂存路径，不碰磁盘。

纯函数（单测对象）：

| 函数 | 职责 | 边界用例 |
|---|---|---|
| `sanitizeAttachmentName(raw)` | basename 化 + 去控制字符 + 剥路径分隔符 + Windows 保留名（CON/PRN/AUX/NUL/COM1-9/LPT1-9）+ 去尾点尾空格 + 截断（保留扩展名，总长 ≤100） | `../../x`、`a/b.txt`、`.`、`..`、空串、超长、`CON.txt`、`a\tb`、全角点 |
| `resolveAttachmentTarget(homeDir, hostKey, sessionId, name)` | `path.resolve(homeDir, '.mao/attachments', hostKey, String(sessionId), name)` 后对 homeDir 做 `path.relative` 断言不出界；sessionId 强校验正整数、hostKey 强校验非空且不含分隔符（防 `../1` 注入目录名）；`~/.mao` 存在且非目录 → 抛错（用户可读文案） | home 为符号链接（先 resolve 再 relative）、嵌套逃逸名、sessionId 传 `1/../../x`、hostKey 传空串 / `a/b` |
| `uniqueName(dir, name)` | 存在则 `stem-1.ext`、`stem-2.ext`… 确定性递增 | 连续冲突、`x-1.txt` 已存在 |

IPC handler `local-copy-attachment`（main.cjs 注册，preload 暴露）：

```
入参 { sourcePath, sessionId, maxSizeMb }   // 不带 workspace / hostKey：根目录由主进程 os.homedir() + getServerHostKey() 推导，渲染层无法指定落点
1. sessionId 正整数校验（非法 → { ok:false, error:'会话无效' }）
2. lstatSync(sourcePath)（**不跟随符号链接**，对齐提案「拒绝符号链接拖入」承诺）：不存在 → ENOENT 文案（「文件已不存在，可能已被移动或删除」）；isDirectory() → 「请选择文件」；isSymbolicLink() → 「不支持符号链接，请选择实际文件」；size > maxSizeMb*1MB → 超限文案
3. sanitize → resolveAttachmentTarget → mkdir -p '~/.mao/attachments/<host>/<sid>' → uniqueName → copyFile
4. 返回 { ok: true, absolutePath: '<home>/.mao/attachments/<host>/<sid>/xxx' } / { ok: false, error }
```

渲染层接线：

- 新 `src/utils/chatLocalAttach.ts`（**照 `chatFileUpload.ts` 结构**）：`copyLocalPendingFiles(text, files: {file, localPath}[], sessionId)` → 循环 invoke `local-copy-attachment` → 成功拼 `@{absolutePath}@`（`uploadPendingFiles` 同款返回 `{ text, copiedCount }`）；单文件失败 `ElMessage.error` 不阻断其余。返回值字段名与 CLOUD 对齐用 `absolutePath`，消息文本形态与 CLOUD 完全一致。
- **`resolveFileRefPaths` 的绝对路径跳过判断必须修**：现状是 `relPath.startsWith('/')`（`useChat.ts:147`），只认 POSIX 绝对路径；Windows 本地附件路径是 `C:\Users\...`，会被误判为相对路径、拼成 `<workspace>/C:\Users\...` 而损坏引用。改为同时识别盘符：`/^([a-zA-Z]:[\\/]|\/)/`（或抽成 `isAbsoluteRef` 小函数），并补 Windows 形态单测。这条是决策 1 改定的连带必修项——CLOUD 时代服务端路径恒为 POSIX 所以没暴露。
- `guardUploadsBeforeSend`（`chatSessionActions.ts`，主会话 / 边路共用）的失败文案目前写死「上传失败」——LOCAL 拷贝失败时应显示「拷贝 / 加入失败」。给该函数加可选文案参数（如 `failureLabel`，默认「上传」），三个调用点中 LOCAL 分支传「拷贝」；这是纯展示层改动，不影响单测的计数逻辑。
- **三个发送调用点**与 CLOUD 懒上传一一对应（同文件同时改）：`useChat.ts:418`（主发送）、`useChat.ts:814`（队列消费）、`SideChatPanel.vue:764`（边路任务）。发送分流：图片 → 服务端上传（视觉通道，LOCAL 也一样）；非图片且 CLOUD → `uploadPendingFiles`；非图片且 LOCAL+Electron → `copyLocalPendingFiles`。
- `ChatInput.vue`：`addPendingFile` 的 LOCAL 分支从「警告 + 拒绝」改为暂存（`{ file, previewUrl:'', localPath }`，localPath = `file.path ?? electronAPI.getPathForFile(file)`）；pendingFiles 的 10 个上限、大小预检（`getUploadConfig().maxSizeMb`，与 CLOUD 同口径）、0 字节检查保持；提示文案改为「文件将在发送时复制到本机 Mao 目录（`~/.mao/attachments`），不出本机」。
- 编辑重发路径：重发不带附件（现状语义，CLOUD 同款），无需处理。

### 5.3 P2 壳常驻

**单实例锁**（P2 前置，先行合入）：

```js
if (!app.requestSingleInstanceLock()) app.quit()
else app.on('second-instance', () => { const w = mainWindow ?? createWindow(); if (w) { if (w.isMinimized()) w.restore(); w.show(); w.focus() } })
```

**托盘**：app ready 后创建（`electron/tray.cjs` 或 main.cjs 内）。菜单：显示/隐藏主窗、新建任务（`webContents.send('tray-new-task')` → 渲染层复用「新建任务」既有入口）、退出。macOS 用 Template 图标；图标资产清单进 §8 冒烟。

**关窗拦截**（quitting 旗标模式；默认托盘化，决策 3）：

```js
win.on('close', (e) => {
  if (!quitting && desktopPrefs.get().closeToTray === 'tray') {
    e.preventDefault(); win.hide()
    if (!desktopPrefs.get().trayHintShown) {
      win.webContents.send('tray-first-close-hint')   // 渲染层 ElMessage 一次性提示
      desktopPrefs.set({ trayHintShown: true })
    }
  }
})
app.on('before-quit', () => { quitting = true /* 既有清理不动 */ })
```

- 退出路径（默认托盘后必须全部可达）：托盘菜单「退出」；应用菜单「退出 Mao」（`main.cjs:517` 既有 `role:'quit'`，macOS 覆盖 Cmd+Q；**Windows/Linux 的 Alt+F4 是窗口级关闭、走 'close' 被拦截为隐藏，不是退出路径**——见 §7 #3，靠首次关窗提示与文档引导到托盘菜单 / 应用菜单）。窗口菜单「关闭」被拦截为隐藏（预期语义）。
- macOS `activate` 补 `mainWindow.show()`（今天只 createWindow）。
- 隐藏 ≠ 登出：登出后渲染层仍存活但无 token，托盘菜单「退出」照常可用。
- dev 模式同样默认托盘：开发时关窗口 = 隐藏，退出需托盘菜单或终端 Ctrl+C——CONTRIBUTING 冒烟清单注明（防开发者以为 app 卡死）。

**主进程通知**（改 `useInboxSystemNotify.ts` 的投递段，决策 4）：

- diff / `knownIds` / `notifiedIds` / kind 偏好 / `systemNotifyEnabled` / `isInboxNotifyWindowHidden()` 判定**全部不动**（既有单测保留）；只把 `new Notification(...)` 构造替换为 `invoke('desktop-notify', {...})`。
- 主进程 handler：构造 `new Notification({ title, body, tag })`；`on('click')` → `mainWindow.webContents.send('desktop-notification-click', payload)`；`on('failed')` → console + 计数（可选：IPC 回报设置页「测试通知」状态）。
- `notification.onclick` 里的 `window.focus()` + 路由跳转逻辑移入渲染层 `desktop-notification-click` 监听（`openSessionFromNotification` 原样复用）。
- 权限：主进程 Notification 不走 web permission，删除 IPC 路径上的 `requestPermissionOnce`（Electron 主进程通知即系统授权）；macOS 系统授权被拒时设置页「发送测试通知」按钮给出反馈（决策 7 边界文档化）。
- Web/安卓非 Electron：`window.electronAPI?.desktopNotify` 不存在时整体不弹（与今天一致，无 web Notification 回退分支——今天也仅 Electron 有 `useInboxSystemNotify` 挂载）。

**角标**：渲染层监听 inbox unread（服务端权威口径不变）→ `invoke('desktop-badge', { count })` → macOS `app.dock.setBadgeCount(count)`；0 清空；登出清零；win/linux no-op。

### 5.4 P3 快捷键 / 自启 / 设置页

- 快捷键：app ready 读 prefs 注册；`globalShortcut.register` 返回 false / `failed` 事件 → `webContents.send('desktop-shortcut-failed', accel)`；设置页改键：unregister 旧键 + register 新键（IPC `desktop-shortcut-set`，入参校验非空字符串）。`app.on('will-quit')` unregisterAll。
- 自启：`app.isPackaged` 才允许 `setLoginItemSettings`；dev 下 IPC 返回 `{ ok:false, reason:'dev' }`，设置页禁用开关 + tooltip（决策 8）。`openAsHidden: true` 仅在托盘模式有意义，UI 上给出联动提示。
- 设置页「桌面」分区（`SettingsView.vue`，Electron 专属，仿「服务器」分区）：关窗行为（单选，**默认「最小化到托盘」**，切「退出」时提示通知将不可达）、全局快捷键（录制输入 + 清除 + 冲突提示）、开机自启（开关 + dev 禁用态）、系统通知（「发送测试通知」按钮 + 上次投递失败提示）。数据走新 IPC `desktop-prefs-get/set`，机器级存储。

### 5.5 IPC 通道清单（新增，全部经 preload 显式暴露）

| 通道 | 方向 | 用途 |
|---|---|---|
| `local-copy-attachment` | r→m invoke | P1 附件拷贝（发送时调用），入参 `{sourcePath, sessionId, maxSizeMb}`（落点由主进程推导），返回 `{ok, absolutePath?, error?}` |
| `get-path-for-file` | r→m invoke | Electron 32+ 的 `webUtils.getPathForFile` 兜底（28-31 恒走 `file.path`，预留给升级点） |
| `desktop-notify` | r→m invoke | P2 主进程系统通知 |
| `desktop-notification-click` | m→r send | 通知点击回传 `{itemId, sessionId}` |
| `desktop-badge` | r→m invoke | macOS 角标计数 |
| `desktop-prefs-get/set` | r→m invoke | 桌面偏好读写 |
| `desktop-shortcut-set` | r→m invoke | 快捷键热更新 |
| `desktop-shortcut-failed` | m→r send | 注册失败提示 |
| `tray-new-task` | m→r send | 托盘「新建任务」 |
| `tray-first-close-hint` | m→r send | 首次关窗隐藏时的一次性托盘提示（`trayHintShown` 持久化，只发一次） |
| `desktop-notify-result` | m→r send | （可选，§5.3 标注为可选的失败回报若要落地则为必需）`Notification` 的 `failed` 事件回报，供设置页「发送测试通知」状态 / 上次投递失败提示 |

合计 **11 个通道**（`desktop-prefs-get/set` 计两个）。

## 6. 改动面

| 层 | 文件 / 模块 | 改动 |
|---|---|---|
| electron | `chatAttachment.cjs` + `chatAttachment.test.cjs`（新增） | P1 纯逻辑 |
| electron | `desktopPrefs.cjs` + `desktopPrefs.test.cjs`（新增） | 偏好存储 |
| electron | `main.cjs`：单实例锁、close 拦截、托盘、11 个 IPC（§5.5）、activate/quit 调整 | P2/P3 主要工作量 |
| electron | `preload.cjs`：上述通道按既有命名风格暴露 | 小 |
| desktop/src | `src/types/electron.d.ts`：`ElectronAPI` 接口补全部新通道的类型声明（`:296` 起；**vue-tsc 严格模式必需，漏改 `npm run build` 直接失败**） | 小但必需 |
| desktop/src | `ChatInput.vue`（LOCAL 暂存分支 + 文案）、`useChat.ts:418/814` 与 `SideChatPanel.vue:764`（发送分流，与 CLOUD 懒上传同点）、新 `utils/chatLocalAttach.ts`、`useInboxSystemNotify.ts`（投递段）、`chatSessionActions.ts`（`guardUploadsBeforeSend` 失败文案参数） | P1/P2 主要工作量 |
| desktop/src | `SettingsView.vue` 侧栏 nav + **新路由视图 `views/settings/DesktopSettingsView.vue` + `router/index.ts` 注册**（「服务器」分区的完整模式 = nav 在 SettingsView.vue + 内容在独立的 ServerSettingsView.vue，只改 SettingsView.vue 出不来页面）+ IPC 封装 | P3 中 |
| desktop | 托盘图标资产：mac Template png（16/18px，`isTemplate`）、win ico / png、linux png（现有资产只有 `public/AppIcon.icns` 与 `app-icon-small.png`，**需新产出**，无原生依赖） | 小 |
| desktop | `package.json` `test:unit` 脚本补 `chatAttachment.test.cjs` / `desktopPrefs.test.cjs`（显式列文件，不改则新单测不进 CI） | 极小 |
| backend-ts | 无 | 零改动、零迁移 |
| 文档 | CHANGELOG「桌面 Electron」小节；`skills/mao-cli/reference/electron.md` 托盘 / 附件 / 通知说明；CONTRIBUTING 冒烟清单（mac/win 双平台，含 Windows Alt+F4=隐藏与 dev 关窗=隐藏说明）；DEPLOY 无需动（壳能力不涉部署） | 同任务完成 |

## 7. 冲突与风险详表

| # | 冲突 / 风险 | 分析 | 应对 |
|---|---|---|---|
| 1 | **通知可达性的机制边界** | 事件流在渲染层 WS；默认托盘化后「关窗不断流」，但用户主动退出（或选用退出模式）后仍无通知，可能被误认为 bug | 决策 7 已定接受边界；首次关窗提示与设置页均明示「彻底退出后不通知」；CHANGELOG 随托盘默认化一并说明 |
| 2 | 渲染层通知 → 主进程通知的切换期回归 | `useInboxSystemNotify.ts` 单测密集（diff / 基线 / 偏好 / 隐藏判定） | 只换投递一行；diff 逻辑与单测原样保留；主进程投递用 spy 测试 invoke 入参 |
| 3 | 关窗拦截与既有清理链 | `before-quit` 有 killAll/closeAll/MCP 清理（main.cjs:1242）；托盘模式「退出」必须仍走全量清理 | quitting 旗标模式：close 只 hide；托盘 / 菜单 / Cmd+Q 退出 → `app.quit()` → before-quit 照常清理；默认托盘后终端 / MCP 常驻为预期行为（§4.3）。**Alt+F4 修正**：Windows/Linux 的 Alt+F4 是窗口级关闭（走 'close' → 被拦截为隐藏），不经 `role:'quit'`，不能算退出路径；首次关窗提示与设置页需明示「X / Alt+F4 = 隐藏，退出用托盘菜单或应用菜单」，Windows 冒烟验这条 |
| 4 | 登出与托盘共存的语义 | 登出后渲染层存活但无 token；托盘菜单若不退出，后台常驻无账号 app | **现状纠正**：今天登出并不退出应用（`auth.ts:135` logout → clearLocalSession → 回登录页，app 继续运行），本方案维持该语义；托盘默认化后「登出 → 关窗」留下登录页形态的托盘常驻（托盘「显示主窗」回登录页、「退出」照常可用），CHANGELOG 明示此状态；托盘常驻以「登录后关窗」为前提 |
| 5 | 单实例锁缺失 | 无 `requestSingleInstanceLock`：自启 + 手动启动 + dock 双击可多开，争用 `auth.json` | P2 前置先合单实例锁（独立小 PR）；`second-instance` 唤起主窗 |
| 6 | macOS 现状与新模式的语义差 | 今天红点关闭=销毁窗口、app 存活；默认托盘化后（决策 3）红点=隐藏，dock 点击应恢复而非新建 | `activate` 补 `show()`；行为变化在 CHANGELOG「桌面 Electron」节明示；退出模式保留为 opt-out |
| 6b | **懒拷贝的时序与文件生命周期**（决策 1 连带） | 按会话分目录要求 sessionId，但新任务态 drop 时会话未创建；且 drop→发送之间文件可能被移动 / 删除 / 修改 | 拷贝只在发送时发生（§4.1，与 CLOUD 懒上传同时机）；copy 前重新 stat，不存在 / 非文件 → 该文件报错且不阻断其余；以拷贝时刻内容为准（不保证与 drop 时一致，CLOUD 上传同款语义） |
| 7 | Electron 28 `File.path` vs **32.0 移除**（29/30/31 仍可用，`webUtils.getPathForFile` 同为 32 新增） | 拖拽取路径在 28 直接可用；升级到 32 时若无 compat 会静默失效 | 统一走 compat：`file.path ?? electronAPI.getPathForFile(file)`；preload 预留通道；单测锁定 fallback 行为 |
| 8 | ~~附件弄脏 git 状态~~ → **已消除**（决策 1 改定） | 附件不再落工作区，`.mao/` 不进用户项目，`git status` 零影响；连带删除 `ensureGitExclude` 及「worktree rev-parse / 非 git 跳过」全部分支 | 无（链路整体删除，风险关闭） |
| 8b | **`~/.mao/attachments/` 不可见性**（决策 1 改定的新代价） | 目录在 home 下，用户在项目里看不到、也想不到去清理；Agent 的 glob/grep 以 workspace 为根，同样扫不到——附件只能凭消息内的绝对路径被读取 | 明确接受的取舍（需求方选定）；缓解：electron.md 与设置页「桌面」分区明示目录位置；§11 后续项做「删会话联动清理」+ 设置页展示磁盘占用；消息文本内即含绝对路径，Agent 读取无障（与 CLOUD runtime incoming 同机制） |
| 8c | **host 键变更致附件孤立**（决策 1 改定的新风险，低） | 附件路径含 `getServerHostKey()`；用户改服务器地址形态（域名 ↔ IP、http/https）后 key 变，旧附件在新 key 下不可达 | 与 `~/.mao/runtime/<host>/<sid>/` 既有行为一致（skills/shellOutput 同样按 host 隔离）；不做迁移，文档注明 |
| 9 | 路径逃逸 / 目录 / 符号链接 | 恶意文件名（`../../x`）、host/session 注入与丢目录 | basename sanitize + hostKey/sessionId 强校验 + home 相对断言（决策 1 改定后目标是 Mao 自管目录，不再涉及 workspace containment）+ `lstatSync` 拒绝目录与符号链接（对齐提案承诺，`statSync` 会跟随符号链接、symlink→文件会被放过）+ 主进程大小复核；home 自身符号链接先 resolve 再 relative |
| 10 | 与 CLOUD `@{绝对路径}@` 协议混用 | LOCAL 与 CLOUD 现在同为 `@{绝对路径}@`，差异只在根目录（本机 `~/.mao/attachments/<host>/<sid>/` vs 服务端 runtime incoming）；Agent 侧解析路径不同 | 同一 `@{...}@` 协议（FileReferenceNode renderText）；单测断言「追加的绝对路径引用能被 local-read-file 命中」。**`resolveFileRefPaths` 的绝对路径跳过判断必须修**：现状 `startsWith('/')` 只认 POSIX，Windows 本地路径 `C:\...` 会被误判为相对路径拼坏引用（CLOUD 时代服务端路径恒 POSIX 所以没暴露）——改为 `/^([a-zA-Z]:[\\/]|\/)/` 并补 Windows 单测（§5.2）。边路（`SideChatPanel.vue`）不发 resolveFileRefPaths 但绝对路径原样透过，形态与主路径天然一致，v1.1 的边路差异问题随之消失；边路首发用来源会话 id（与 CLOUD 同款），附件落来源会话目录，已知不对称、文档明示 |
| 11 | 图片 / 文件语义不对称的困惑 | 图片上服务端、文件不出本机，用户可能困惑「我的文件传哪了」 | 附件 chip 与提示文案区分；electron.md 明示两条路径与理由（视觉通道要求） |
| 12 | 快捷键系统冲突 | register 失败静默无感 | `failed` 事件 + 返回值回传，设置页红字提示换键 |
| 13 | dev 模式自启误注册 | 会把 electron 二进制写进登录项 | `app.isPackaged` 守卫 + UI 禁用态（决策 8） |
| 14 | macOS 系统通知授权被拒 | 主进程通知无 web permission 探针，被拒无感知 | 「发送测试通知」按钮即探针 + `failed` 事件计数展示 |
| 15 | 托盘图标资产平台差异 | mac Template / win ico（或 png）/ linux png；仓库现有资产只有 `AppIcon.icns` 与 `app-icon-small.png`，**需新产出**（§6 改动面已列） | §8 冒烟清单逐平台核对（mac/win；linux 源码自建口径）；不新增原生依赖 |
| 16 | 托盘模式终端常驻资源 | 隐藏后 pty / MCP 子进程存活 | 有意为之（任务继续跑）；before-quit killAll 已覆盖退出清理；文档说明 |
| 17 | 多服务器配置与桌面偏好关系 | 切 server 不应影响托盘 / 快捷键 / 自启 | 偏好放 userData 机器级；登出不清；切 server 只清 auth.json（现状） |
| 18 | electron-updater 与常驻 | 托盘模式延迟退出，更新安装时机 | 更新仍走退出安装；无行为变更，仅提示文案 |
| 19 | `localShell.cjs` 与 agent-cli 字节同步 | CI 有 `cmp` 防分叉 | 本方案不碰 localShell；新文件独立 |
| 20 | E2E 覆盖不到原生壳 | CI 只跑 desktop build，不跑 Electron 原生功能 | §8 人工冒烟清单进 CONTRIBUTING；纯函数进 node --test 单测兜底逻辑回归 |

## 8. 测试要点

**单测（node --test，electron/*.test.cjs；渲染层 vitest）**

- `sanitizeAttachmentName`：§5.2 边界用例全集（遍历 / 保留名 / 控制字符 / 长度 / 空 / `.`）。
- `resolveAttachmentTarget`：逃逸名抛出；home 符号链接；`~/.mao` 为文件时报错文案；sessionId / hostKey 注入（`1/../../x`、`a/b`、空串）。
- `uniqueName`：连续冲突序列、`x-1.txt` 已存在的跳过。
- IPC handler（mock fs）：超限 / 空文件 / 目录 / **符号链接（lstatSync 拒绝，不跟随）** / 不存在 / 成功五分支；拷贝后 `absolutePath` 位于 `<home>/.mao/attachments/<host>/<sid>/` 下且可被 local-read-file 命中。
- `resolveFileRefPaths`（渲染层 vitest）：POSIX 绝对路径（`/opt/...`、服务端 runtime incoming）原样透过；**Windows 盘符绝对路径（`C:\Users\...\.mao\attachments\...`）原样透过**（本次新增的回归，防拼坏）；相对路径（`@` 手输引用）仍按 workspace 拼接。
- `useInboxSystemNotify`：投递改 invoke 后，diff / 基线 / kind 偏好 / hidden 判定既有断言全绿；`desktop-notification-click` 监听后路由跳转复用 `openSessionFromNotification`。
- `desktopPrefs`：默认值 / 坏文件 / 原子写。

**人工冒烟清单（CONTRIBUTING，mac/win 各一遍）**

> 平台口径修正：`desktop/package.json` 的 build 只配了 mac（dmg/zip）与 win（nsis），**没有 Linux 构建目标**——「三平台」改为 mac/win 双平台；Linux 用户源码自建时托盘需 libappindicator，文档注明即可，不进冒烟清单。

1. P1：LOCAL 会话拖桌面文件 → chip 出现 → 发送 → Agent 读到；重名三次（`~/.mao/attachments/<host>/<sid>/` 下）；**工作区零侵入**（git 仓库与非 git 工作区均：项目目录无新文件、`git status` 无变化、exclude 无写入）；超限 / 目录 / **符号链接** / 0 字节提示。
2. P2：托盘模式关窗 → 任务完成系统通知可达 → 点击通知跳会话；托盘「新建任务」；dock 双击恢复；单实例（双击图标只一个窗口）；macOS 角标增降清；dev 下自启禁用。**注意：macOS 主进程通知在 dev（未打包）下可能不显示，通知验收须用 packaged 构建**（`npm run dist` 产物）。
3. P3：快捷键唤起 / 隐藏 / 冲突替换；自启开启后重启登录（packaged）；退出全量清理（终端 / MCP / 本地 shell）；**Windows 上验证 Alt+F4 与右上角 X 均为「隐藏到托盘」、退出只能走托盘菜单 / 应用菜单（首次提示已明示）**。

**回归**：CLOUD 附件上传 / 图片粘贴 / @ 引用 / 消息发送 / 登出清理 / 多服务器切换 / electron-updater 全链路；`npm run test:unit` + `npm run build`（vue-tsc + vite）通过。

## 9. 验收标准

1. LOCAL 会话：桌面上任意文件拖进输入框（新任务态 / 已有会话态均可）→ 发送 → 文件落在 `~/.mao/attachments/<服务器host>/<会话id>/`，消息内含 `@{绝对路径}@` 引用，Agent 读源文件完成任务；抓包确认无 `/files/upload-incoming` 请求（文件不出本机）。
2. 默认行为：关窗后应用收托盘、任务继续跑；任务完成 / 待审批 / 待提问系统通知照常到达，点击跳回会话；首次关窗出现一次性托盘提示；macOS 角标与收件箱未读一致。
3. 托盘菜单 / 应用菜单「退出 Mao」/ Cmd+Q（mac）均可彻底退出，且退出前 pty / MCP / 本地 shell 全量清理；切换「退出模式」后行为与今天完全一致。Windows 上另验：Alt+F4 与 X 均为隐藏到托盘、托盘菜单可退出（首次关窗提示与文档已明示，不算缺陷）。
4. 工作区全程零侵入：git 仓库与非 git 工作区均无任何变化（项目目录无新文件、`git status` 干净、`.git/info/exclude` 无写入）；附件按 host+会话分目录隔离在 `~/.mao/attachments/` 下。
5. Web / 安卓端零感知；dev 模式自启被禁用并说明；mac/win 冒烟清单全过（含 Windows Alt+F4=隐藏与 dev 关窗=隐藏的说明）。

## 10. 迁移与回滚

- **零后端迁移、零 DB 迁移**。Electron 侧新增 `desktop-prefs.json` 不存在时全默认值，无兼容负担。
- 回滚：功能全部为增量的 IPC + 偏好字段；P1/P2/P3 各自可独立回滚（托盘 / 通知 / 快捷键互不依赖）。通知改造的回滚点是 `useInboxSystemNotify.ts` 单文件（投递段可整体回退 web Notification）。
- 发版口径：纯 Electron 壳能力，走「桌面 Electron」CHANGELOG 小节；用户需自跑 `npm run dist` 更新（无官方签名包，README 既有口径）。

## 11. 排期注意

1. **实施顺序**：单实例锁（先行，独立 PR）→ P1 → P2 → P3；P1 收益最高且零壳风险，可先上线验证。单实例锁与托盘默认化都会改变既有行为，合入时 CHANGELOG「桌面 Electron」节逐条明示。
2. **相邻收敛点**：本方案不碰 `task-terminal.service.ts` / AgentLoop / prompt-engine；`useInboxSystemNotify.ts` 的调用方（`useStreamWS` 的 `inbox_updated` 分支）不动，只改投递段；三个发送分流点与 CLOUD 懒上传同文件同时改，`resolveFileRefPaths`（`useChat.ts:143`）的绝对路径跳过判断需扩展 Windows 盘符识别（§5.2 / §7 #10，本次 P1 的连带必修项）。
3. **文档同步**：CHANGELOG「桌面 Electron」节 + `reference/electron.md`（托盘 / 附件 / 通知三节，附件节写明 `~/.mao/attachments/<host>/<sid>/` 位置与「工作区零侵入」语义）+ CONTRIBUTING 冒烟清单（含 dev 关窗=隐藏说明），与代码同任务；README「客户端与通道」表 Electron 行补一句壳能力。
4. **决策状态**：§0 八项已于 2026-10-26 全部落定（其中决策 3 关窗默认托盘化、决策 1 附件落盘 `~/.mao/attachments/` 为需求方确认值；决策 1 在评审后由「工作区内」改定为「home 机器级目录」，连带删除 git exclude 链路），可开工。
5. **提案措辞取代说明**（提案为历史文档不回改，以本方案为准）：提案 §4.2「关窗行为三态 / 默认维持退出」已被 §0 决策 3（二态、默认托盘化）取代；提案 §4.1「注入 @ 引用节点」已简化为纯文本追加 `@{绝对路径}@`（与 CLOUD 懒上传同结构，语义相同）；提案 §4.1「拷入当前工作区固定子目录 `.mao/attachments/`」已被 §0 决策 1（`~/.mao/attachments/`）取代，exclude 策略随之删除。三处行为变化均需 CHANGELOG「桌面 Electron」节明示。
6. **附件清理边界（v1 不做，列为后续）**：`~/.mao/attachments/<host>/<sid>/` 无删除入口，且目录在 home 下**用户不可见**（决策 1 的代价，见 §7 #8b）——磁盘增长比原工作区方案更难被用户察觉，后续项优先级相应提高：「删会话联动清理附件目录」+ 设置页「桌面」分区展示占用大小；CLOUD runtime incoming 的既有清理策略在实施时对齐，避免两套口径。

## 12. 评审修订记录（v1.0 → v1.2，2026-10-26）

**结论：需求可行、方案可行**（P1/P2/P3 均无架构性阻碍，全部能力有 Electron 内置 API 与既有代码模式支撑；§1 引用的代码位置经逐条核实基本属实）。以下为评审发现并已直接补入本文的修订：

### v1.1：事实性错误（6 处，已改）

1. §3「工作区收敛」：`resolveWorkspacePath()`（main.cjs:1009）不是 containment 判定——绝对路径原样返回，仅做 expandHome 与 join；收敛实际由 §5.2 的 `path.relative` 断言 + basename sanitize 按构造保证。
2. §3「桌面偏好」：`serverConfig.cjs` 并无 tmp+rename 原子写、无内存缓存（`writeFileSync` 直写 + 每次读盘）；原子写 / 缓存是本方案新增改进，不再称「照 serverConfig 模式」。
3. §3「文件路径获取」：`webUtils.getPathForFile` 是 **Electron 32.0 新增**（`File.path` 同版本移除），29/30/31 仍可用 `File.path`；原文「≥29」有误，compat 写法本身不变。
4. §1 / §6：`test:unit` 是显式列三个测试文件而非 glob；新增两个 `electron/*.test.cjs` 必须同步补脚本，否则 CI 不执行。
5. §4.3 / §7 #3 / §9.3：`role:'quit'` 不覆盖 Windows/Linux 的 Alt+F4（窗口级关闭、走 'close' 被拦截为隐藏）；托盘默认化后 Windows 用户习惯的 Alt+F4 不再是退出路径，已改为文档明示 + 冒烟验证。
6. §7 #4：登出现状并非「退出应用」（auth.ts:135 → clearLocalSession → 回登录页、app 继续运行）；已改为维持现状 + 明示「登出后关窗 = 登录页形态托盘常驻」。

### v1.1：改动面遗漏（6 项，已补）

1. `src/types/electron.d.ts` 的 `ElectronAPI` 接口类型声明（漏改则 `npm run build` 的 vue-tsc 直接失败）。
2. 设置页「桌面」分区缺新路由视图与 router 注册（现有模式 = SettingsView.vue nav + 独立 ServerSettingsView.vue，只改 SettingsView.vue 出不来页面）。
3. 托盘图标资产无产出项（仓库仅有 `AppIcon.icns` / `app-icon-small.png`，mac Template / win ico / linux png 需新做）。
4. §5.5 通道数实为 11 个（`desktop-prefs-get/set` 计两个）；「上次投递失败提示」若要落地需补 `desktop-notify-result` 通道（已列为条件必需）。
5. `guardUploadsBeforeSend` 失败文案写死「上传失败」，LOCAL 拷贝路径需加文案参数（「拷贝 / 加入失败」）。
6. 边路面板（`SideChatPanel.vue`）不发 `resolveFileRefPaths`，边路 `@{相对}@` 与主路径绝对路径形态不一致（LOCAL 均可命中，需单测锁定）；边路首发用来源会话 id，附件落来源会话目录——已知不对称，已明示。

### v1.1：口径修正（2 处，已改）

1. 冒烟「三平台」→ mac/win：`package.json` build 无 Linux 目标（仅 mac dmg/zip 与 win nsis），Linux 改为源码自建文档口径（libappindicator）。
2. macOS 主进程通知在 dev（未打包）下可能不显示，通知验收须用 packaged 构建。

### v1.1：与提案的对齐（1 处，已明示）

提案承诺「拒绝符号链接拖入」，v1.0 的 `statSync isFile` 会跟随符号链接、放过 symlink→文件；已改为 `lstatSync` 拒绝（§5.2 / §7 #9 / §8 测试点同步），提案其余承诺不变。

### v1.2：决策 1 改定——附件落盘从工作区改为 `~/.mao/attachments/`（需求方决定，2026-10-26）

1. **§0 决策 1 / §2.1 / §3 / §4.1 / §5.2 / §5.5 / §9**：附件根目录从 `<workspace>/.mao/attachments/<sid>/` 改为 `~/.mao/attachments/<serverHost>/<sid>/`（仿 `~/.mao/runtime/<host>/<sid>/` 既有约定，main.cjs:752-763）；引用从 `@{相对路径}@` 改为 `@{绝对路径}@`，与 CLOUD 懒上传形态完全统一。
2. **连带删除**：`ensureGitExclude` 整条链路（纯函数、IPC 第 4 步、单测 bullet、§3 选型行、§7 #8 原风险）——不再碰用户 git 配置，风险 #8 关闭。
3. **连带必修（新发现）**：`resolveFileRefPaths`（useChat.ts:147）的绝对路径跳过判断 `startsWith('/')` 只认 POSIX；Windows 本地附件路径 `C:\...` 会被误判为相对路径拼坏引用（CLOUD 时代服务端路径恒 POSIX 所以没暴露）。已改为 `/^([a-zA-Z]:[\\/]|\/)/` 并要求补 Windows 单测——这是决策 1 改定后最重要的实施注意点。
4. **新风险登记**：§7 #8b（目录不可见 → 用户难察觉磁盘增长、Agent glob/grep 扫不到，仅凭消息内绝对路径读取——明确接受的取舍）、#8c（host 键变更致旧附件孤立，与 runtime 既有行为一致）；v1.1 改动面遗漏第 6 条（边路形态不一致）随绝对路径化自动消解。
5. **收益侧变化**：v1.1 的「边路 `@{相对}@` 形态不一致」问题消失（绝对路径两条路都原样透过）；代价侧变化：工作区可发现性 / Agent 枚举可见性丧失，§11 清理项优先级提高（设置页展示占用 + 删会话联动清理）。
