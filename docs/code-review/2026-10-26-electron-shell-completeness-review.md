# 代码审查报告：Electron 壳补完（LOCAL 附件 + 托盘/通知/快捷键/自启，0.0.351）

> **第二轮复审结论（2026-10-26，HEAD=7ef48168）**：本报告 3 个 bug 已全部正确修复，且修复本身未引入新问题——快捷键换键的 6 条路径（含 `before-quit` 交互、`clearShortcut(null)`、启动注册失败）逐条探针验证通过。第 2 轮新确认 **2 个低危 bug**（Bug 4/5），与 Bug 2 同属「窗口已销毁状态未处理」这一根因家族，仅影响**退出模式 + macOS**（非默认组合）：窗口销毁后托盘文案停留在「隐藏主窗」（点击反而建窗）、全局快捷键空转无法唤起。另对正式回归 `mainShell.test.cjs` 做了修复前代码反向验证（19 pass / 3 fail，失败的正是三个 bug 回归），确认其非假通过，但指出其覆盖缺口恰好在「窗口已销毁」状态。详见 `2026-10-26-electron-shell-completeness-review-r2.md`。
> 以下为第一轮报告原文。

- 审查对象：`electron-shell-completeness` 分支 commit `e02a726a`（父 `6a337bca`），涉及 desktop（electron 主进程 + 渲染层）与文档
- 审查日期：2026-10-26
- 审查方式：全量 diff 走读 + 关键链路代码追踪；搭了一个「假 electron」harness 在纯 node 下加载 `desktop/electron/main.cjs`，对其 P2/P3 桌面壳逻辑做集成级探针（此前该文件无任何可执行测试）。每个确认的 bug 均以可运行测试复现，复现文件随本报告一并落在 `docs/code-review/repro/2026-10-26-electron-shell/`
- 结论：**确认 3 个 bug**（1 个中、2 个低），全部集中在 `desktop/electron/main.cjs` 的桌面壳逻辑；P1（LOCAL 附件）经排查未发现问题

---

## 确认的 Bug

### Bug 1（中）：`second-instance` 处理器在 app ready 前调 `createWindow()`，主实例启动期崩溃

- 位置：`desktop/electron/main.cjs` L27–33（单实例锁与 `second-instance` 监听）

```js
app.on('second-instance', () => {
  const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : createWindow()
  if (!win || win.isDestroyed()) return
  ...
})
```

- 问题描述：窗口是在 `app.whenReady().then(...)` 里创建的（L1439–1442），`second-instance` 事件却可能在 `whenReady` 尚未 resolve 时就到达。此时 `mainWindow` 为 `null`，处理器走 `createWindow()` 分支；而真实 Electron 在 app ready 前禁止创建 `BrowserWindow`，`new BrowserWindow()` 会抛 `Error: BrowserWindow can only be created after the app is ready`。`main.cjs` 全文没有任何 `process.on('uncaughtException')` 兜底，异常直接逃逸出事件处理器。
- 触发场景：主实例刚启动（`whenReady` 未完成，窗口还没建）时用户又启动了一个实例——双击图标、`open -n`、文件关联打开、自启+手动启动叠加等。次实例拿不到锁后 `app.quit()`，并通过锁套接字把 `second-instance` 发给主实例；主实例此时若还没 ready 就命中该路径。冷启动/机械硬盘/高负载机器上 `whenReady` 到建窗之间的窗口更宽，命中概率更高。后果是主实例启动期抛未捕获异常而终止，反而得不到"唤起主窗"的预期效果。
- 复现测试：`docs/code-review/repro/2026-10-26-electron-shell/main-shell-probes.test.cjs` 用例 1（harness 的 `FakeBrowserWindow` 与真实 Electron 一致：ready 前构造即抛同一错误）。运行方式：

  ```bash
  cd docs/code-review/repro/2026-10-26-electron-shell
  node --test main-shell-probes.test.cjs
  ```

  失败输出摘要（用例 1 以 `assert.throws` 正向断言该异常存在，即"确认缺陷"）：

  ```
  not ok 1 - 候选1：second-instance 先于 app ready 到达时 createWindow 抛异常（主实例崩溃路径）
  ```

  用例 1 的断言体：`assert.throws(() => h.emitApp('second-instance'), /BrowserWindow can only be created after the app is ready/)`——该断言**通过**即证明异常确实会被抛出（harness  faithfully 复刻了真实 Electron 的 ready 前建窗限制）。

- 修复方向：ready 前不建窗，例如 `if (!app.isReady()) return` 或 `if (!mainWindow) { app.whenReady().then(createWindow); return }`；主实例就绪后 `activate`/`ready-to-show` 会自然把窗带出来。
- 严重程度：**中**

---

### Bug 2（低）：窗口销毁重建后，新窗口的 `hide`/`minimize` 不再刷新托盘菜单文案，文案与动作相反

- 位置：`desktop/electron/main.cjs` `initTray()` L1296–1300（刷新监听只挂在第一个窗口）+ `app.on('activate')` L1465–1474（`getAllWindows()===0` 时 `createWindow()` 重建窗口）

```js
const refresh = () => appTray?.refresh()
mainWindow?.on('show', refresh)
mainWindow?.on('hide', refresh)
mainWindow?.on('minimize', refresh)
mainWindow?.on('restore', refresh)
```

- 问题描述：`initTray()` 用 `if (appTray) return` 保证托盘只建一次，四个窗口态刷新监听也只挂在 `initTray()` 那一刻的 `mainWindow` 上。退出模式（`closeToTray: 'quit'`）下关窗会真正销毁窗口（`mainWindow = null`），随后 dock 点击走 `activate` → `getAllWindows()===0` → `createWindow()` 得到**新窗口**；新窗口没有挂任何刷新监听，托盘菜单的"显示/隐藏主窗"文案就此停留在旧状态。
- 触发场景：macOS + 退出模式：关闭窗口（销毁）→ 点 dock 图标重建窗口 → 对新窗口做最小化 / Cmd+H。此时窗口已不可见，托盘文案却仍显示"隐藏主窗"（应为"显示主窗"）。用户按文案点击"隐藏主窗"，`onShowHide` 发现窗口不可见，反而把窗口 `show()` 出来——文案与动作完全相反，且托盘单击自己的 `refresh()` 只会在点击后刷新一次，之后又失同步。托盘模式下窗口是 hide 不销毁，不触发本 bug（基线用例已验证）。
- 复现测试：`docs/code-review/repro/2026-10-26-electron-shell/main-shell-probes.test.cjs` 用例 2。失败输出摘要：

  ```
  not ok 2 - 候选2：退出模式下窗口销毁重建后，新窗口的 hide/minimize 不再刷新托盘文案
    error: 窗口不可见时托盘文案应为「显示主窗」
    '隐藏主窗' !== '显示主窗'
    expected: '显示主窗'
    actual:   '隐藏主窗'
  ```

  附带后果验证（`docs/code-review/repro/2026-10-26-electron-shell/bug2-consequence.cjs`，按文案点击"隐藏主窗"）：

  ```
  最小化后窗口可见: false
  托盘文案(应为「显示主窗」): 隐藏主窗
  点击后窗口可见(用户意图是隐藏, 结果反而): true
  ```

- 修复方向：把 refresh 监听收进 `createWindow()`（每个新窗口都挂），或在 `activate`/`second-instance` 重建窗口后补挂；也可让 `refresh` 改为按需拉取（托盘菜单 `menu.on('menu-will-show')` 时重建）。
- 严重程度：**低**

---

### Bug 3（低）：快捷键热更新注册失败时旧键已被清空且新键未注册，但偏好与设置页仍显示旧键，快捷键静默失效

- 位置：`desktop/electron/main.cjs` `applyGlobalShortcut()` L1309–1336（`unregisterAll()` 先于 `register()`）+ `desktop-shortcut-set` handler L1425–1437

```js
function applyGlobalShortcut(accel) {
  try { globalShortcut.unregisterAll() } catch (e) { ... }   // 先全清
  if (!accel) return { ok: true }
  try {
    const registered = globalShortcut.register(accel, ...)   // 再注册新键
    if (!registered) return { ok: false, error: '快捷键注册失败，可能已被其他程序占用' }
    ...
```

- 问题描述：改键流程是"先 `unregisterAll()` 清掉所有已注册快捷键，再注册新 accel"。当新 accel 注册失败（被其他程序占用，或格式非法走 `catch`），函数返回 `ok:false`，IPC handler 随即 return 失败、**不写偏好文件**。于是出现不一致状态：旧键已被注销、新键没注册上（全局一个快捷键都不生效），但 `desktop-prefs.json` 里仍是旧键，设置页输入框也仍显示旧键。用户看到"设置的是 Ctrl+Alt+K"、按了却没反应，且没有任何持久化的失败痕迹（只有一条会自行消失的 ElMessage），直到重启应用才按偏好重新注册恢复。
- 触发场景：设置页把快捷键从已生效的 A 改成 B，而 B 恰好被其他程序占用（或拼成非法格式）。
- 复现测试：`docs/code-review/repro/2026-10-26-electron-shell/main-shell-probes.test.cjs` 用例 3（先成功设 `Ctrl+Alt+K`，再用 `failNextShortcutRegistration()` 让 `Ctrl+Alt+Y` 注册失败）。失败输出摘要：

  ```
  not ok 3 - 候选3：新快捷键注册失败后旧快捷键已失效，但偏好未更新（设置页仍显示旧键）
    error: 注册失败后旧快捷键应仍然可用
    + actual - expected
    + []
    - ['Ctrl+Alt+K']
  ```

  同时偏好文件里 `globalShortcut` 仍为 `'Ctrl+Alt+K'`（用例内第二条断言印证：UI 显示旧键、实际无键生效）。

- 修复方向：先 `register` 新键、成功后再 `unregister` 旧键（或注册失败时回滚重注册旧键）；失败时至少把偏好与 UI 置为"已停用"以保持状态一致。
- 严重程度：**低**

---

## 低风险观察（未列为确认 bug，仅供加固参考）

1. `main.cjs` L1449–1455 `app.isPackaged` 分支下的 `setTimeout(() => checkForAppUpdate(), 3000)`：若 3 秒内应用退出，定时器回调不会执行，属预期行为；但 `checkForAppUpdate` 未做并发去重保护（`updaterInitialized` 只挡 `setupAutoUpdater`），设置页手动检查与定时检查可能重叠触发 `autoUpdater.checkForUpdates()`。低概率且 electron-updater 自身有状态机兜底。
2. `main.cjs` L1399 `app.dock && typeof app.dock.setBadgeCount === 'function'`：macOS 判定写在运行时分支里而非编译期，Windows/Linux 下 `app.dock` 为 `undefined` 走 no-op，行为正确；仅提示该守卫与 `process.platform === 'darwin'` 重复，可简化为单一判断。
3. `useInboxSystemNotify.ts` 的 `ensureDesktopNotifyBridge` 与 `useDesktopShell.ts` 的 `ensureDesktopShellBridge` 均为模块级单例幂等注册，`useStreamWS` 可能被多个组件实例调用也不会重复挂监听（已用 `resetDesktopShellBridgeForTest` + 重复调用验证：4/4 通过）。仅提示：两处 bridge 的"首次注册时机"都依赖 WS 单例首次活跃，若某条渲染路径不经过 `useStreamWS`（如设置页独立挂载时收 `desktop-shortcut-failed`），提示仍可通过另一条 bridge 送达，无实际遗漏。
4. `chatAttachment.cjs` 的 `sanitizeAttachmentName` 对 Windows 保留名（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`）做了 `_` 前缀转义、控制字符剔除与 100 字截断，落点还有 `resolveAttachmentTarget` 的 home 相对断言兜底；`copyLocalAttachment` 全同步（无 await）+ 单实例锁，排除了并发拷贝的 TOCTOU 竞态（复现文件见附录 C，结论为"不成立"）。仅提示：`maxSizeMb` 由渲染层传入（`payload?.maxSizeMb`），主进程未设下限兜底，极端大的值会导致超大文件被拷入 `~/.mao`。

---

## 已验证无问题的关键链路（供合并决策参考）

- **P1 LOCAL 附件落点与内容**：`local-copy-attachment` 的落点完全由主进程推导（`os.homedir()` + `getServerHostKey()` + sessionId），渲染层无法指定路径；恶意文件名（`../../etc/passwd`、`CON.txt`、含控制字符）均被 sanitize；拷贝后内容与来源逐字节一致（探针用例 16，通过）。
- **P1 图片/CLOUD 附件保持原上传路径**：diff 走读确认 LOCAL 分支只在非图片、非 CLOUD 时追加 `@绝对路径@`，图片仍走既有 `uploadImage` 链路，未被本次改动波及。
- **P1 渲染层串行拷贝**：`copyLocalPendingFiles` 逐文件 `await`，单次发送内部串行；两次发送之间由主进程同步 IPC + 单实例锁串行化，无交错窗口。
- **P2 关窗拦截三态**：托盘模式（hide + 一次性提示 + `trayHintShown` 持久化）、退出模式（正常销毁）、`quitting` 旗标下的退出路径（`app.quit()` → `before-quit` 全量清理：快捷键注销、终端 kill、localShell 关闭、MCP 会话关闭）——4 条基线用例全通过。
- **P2 主进程通知**：`desktop-notify` 标题为空即拒；`click` 先唤起窗口再回传 `desktop-notification-click { itemId, sessionId }`；`failed` 回传失败结果（基线用例通过）。
- **P2 dock 角标**：仅 `darwin` 生效，`count` 做 `Math.max(0, Math.floor())` 归一化（基线用例通过）。
- **P2 托盘**：单击切换显示/隐藏且文案跟随刷新；「新建任务」先唤起窗口再发事件；「退出」走 `app.quit()`（基线用例通过）。
- **P3 快捷键**：回调语义"可见且聚焦→隐藏，否则唤起"；注册失败回传 `desktop-shortcut-failed`；`before-quit` 注销（基线用例通过）。仅热更新失败路径有 Bug 3。
- **P3 自启**：dev 模式拒绝开启且不落盘（`desktop-prefs.json` 不生成）、不清空已开启项（关闭不拒绝）；打包后写入 `{ openAtLogin, openAsHidden: true }`（基线用例通过）。
- **P3 desktopPrefs 持久化**：tmp+rename 原子写、逐字段 normalize 回退、坏 JSON 不炸（走读 + 全量 916 个 vitest 通过）。
- **IPC 契约**：preload 新增 11 个方法与 `electron.d.ts` / `types/desktop.ts` 声明逐一对应，`vue-tsc -b` 全量构建通过。
- **回归**：desktop 全量 vitest 916 passed（103 文件）；`node --test` 80 pass，2 个失败均为**存量已知问题**（`gitOperations.test.cjs` 的「injects identity」受本机全局 git 身份干扰、`localShell.test.cjs` 的 `/var`→`/private/var` 符号链接），与本次改动无关；desktop `npm run build` 通过。

---

## 验证过程说明

- 复现文件共 4 个，已落在 `docs/code-review/repro/2026-10-26-electron-shell/`（harness 内路径按 `__dirname` 相对解析，换检出路径可直接运行）：
  - `main-harness.cjs`：假 electron / electron-updater 注入 `require.cache`，在纯 node 下加载真实 `main.cjs`；`FakeBrowserWindow` 复刻"ready 前建窗即抛"的真实限制，`app.quit()` 会触发 `before-quit` 再关窗，`globalShortcut` 支持 `failNext` 控制
  - `main-shell-probes.test.cjs`：3 个候选 bug 探针 + 13 条基线核对（`node --test main-shell-probes.test.cjs`，当前 14 pass / 2 fail——两个 fail 即 Bug 2/3 的复现，Bug 1 以"断言异常确实抛出"的方式确认）
  - `harness-smoke.test.cjs`：harness 自身健全性（4/4 通过）
  - `chatAttachment-race.test.cjs`：已排除的并发拷贝竞态候选，记录为"同步函数 + 单实例锁 → 无交错窗口"（1/1 通过）
  - `bug2-consequence.cjs`：Bug 2 的用户可感后果（按陈旧文案点击反而把窗口显示出来）
- 三个 bug 的修复均很小（各自一两行），修复后建议把对应探针用例的断言反转为"期望正确行为"，收进 `desktop/electron/` 下的正式测试作为回归守护。

---

## 附录：探针运行结果全貌

```
$ cd docs/code-review/repro/2026-10-26-electron-shell && node --test main-shell-probes.test.cjs
# tests 16
# pass 14
# fail 2
```

16 条中：3 条为候选 bug 探针（用例 1 通过=异常确认存在；用例 2、3 失败=bug 复现），13 条为基线核对（全部通过，证明 harness 行为与设计一致、bug 不是测试假配造成的）。
