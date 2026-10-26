# 代码审查报告（第 2 轮）：Electron 壳补完（0.0.351）修复复审

- 审查对象：`7ef48168`（fix: 修复 code review 第1轮 3 个桌面壳 bug）相对 `6a337bca` 的完整变更；重点核对第 1 轮 3 个 bug 的修复、修复本身是否引入新问题，以及全量复查是否遗漏
- 审查日期：2026-10-26
- 审查方式：修复 diff 逐行走读 + 假 electron 集成探针（复用并扩展 `desktop/electron/mainShellHarness.cjs`）+ 对正式回归测试做「修复前代码反向验证」
- 结论：**第 1 轮 3 个 bug 全部正确修复，且修复未引入新问题**（快捷键换键的 6 条路径全部验证正确）。**第 2 轮新确认 2 个 bug（均为低）**，与第 1 轮 Bug 2 同属一个根因家族——「窗口已销毁」状态未处理；仅影响**退出模式 + macOS**这一非默认组合

---

## 一、第 1 轮 3 个 bug 的修复验证

### Bug 1（中）second-instance 未 ready 建窗 —— 已修复

- 修复：`main.cjs` L27–30 加 `if (!app.isReady()) return`，未就绪时直接返回，交由 `whenReady` 链建窗。
- 走读判定：正确。`app.isReady()` 是 Electron 官方就绪判定；提前返回不丢语义——`whenReady().then()` 里本来就会 `createWindow()`，次实例的「唤起」意图由主实例就绪后的正常建窗满足。
- 测试：正式回归 `mainShell.test.cjs` 用例 1（`assert.doesNotThrow` + 窗口数仍为 0）通过。

### Bug 2（低）托盘文案失刷新 —— 已修复（但不完整，见 Bug 4）

- 修复：`initTray()` 里的 4 条刷新监听（L1296–1300）删除，改到 `createWindow()` 末尾（L1258–1266）挂 `show`/`hide`/`minimize`/`restore` → `appTray?.refresh()`。
- 走读判定：方向正确，每个新窗口都会挂监听，覆盖了「退出模式关窗销毁 → activate/second-instance 重建」这条路径。
- 测试：正式回归用例 2 通过（退出模式关窗 → activate 重建 → minimize → 文案翻「显示主窗」→ 点击后翻回「隐藏主窗」，文案与动作一致）。
- **但修复只覆盖了「窗口重建之后」**，没有覆盖「窗口已销毁、尚未重建」这个中间状态——见下方 Bug 4。

### Bug 3（低）快捷键换键失败静默失效 —— 已修复，且换键路径经 6 条探针全量验证

- 修复：`applyGlobalShortcut()` 重写为「先 `register` 新键，成功后再精确 `unregister` 旧键」，新增模块级 `currentShortcutAccel` 跟踪当前键；`desktop-shortcut-set` 的空串判断简化为 `if (next === '')`（`next` 只可能是 `null` 或 trim 后字符串，等价）。
- 逐条路径验证（探针 `shortcut-paths.test.cjs`，A–F 共 6 条全部通过）：

  | 路径 | 结果 |
  | --- | --- |
  | A. 换键失败后旧键保持 + 再换新键成功 | 失败时 `shortcutRegs` 仍为 `['Alt+Shift+M']`、偏好不写；随后换 `Ctrl+Alt+J` 成功且只留新键 |
  | B. 偏好 `globalShortcut: null` 启动 | 不注册、不发 `desktop-shortcut-failed`；之后开启正常 |
  | C. `before-quit` 的 `unregisterAll` 之后再改键 | `before-quit` 清空注册表后 `currentShortcutAccel` 虽陈旧，但再改键只注册新键、无误摘、无双注册 |
  | D. 连续两次 `desktop-shortcut-set(null)` | 幂等，不报错 |
  | E. 空串被拒 | `ok:false`，且不影响启动时已注册的默认键 |
  | F. app ready 且窗口已销毁时 `second-instance` | 重建窗口并正确挂上刷新监听，文案跟随 |

- 特别核对用户点名的两处交互：
  - **`before-quit` 的 `unregisterAll()` 与 `currentShortcutAccel`**：`before-quit` 未重置 `currentShortcutAccel`。因 `main.cjs` 没有 `e.preventDefault()` 打断退出，退出路径必然走完，陈旧值不可达；即使退出被外部因素中止，后续改键也只是 `unregister` 一个已注销的键（no-op），不会误摘或双注册。探针 C 实证。**不构成 bug。**
  - **启动时 `whenReady` 注册失败路径**：`currentShortcutAccel` 保持 `null`，`sendToRenderer('desktop-shortcut-failed')` 回传，之后用户改键正常。**不构成 bug。**
- 测试：正式回归用例 3 通过（失败后旧键仍可用、偏好保持旧键、失败事件回传 1 次）。

---

## 二、第 2 轮新确认的 Bug

两个 bug 共享同一根因：**「窗口已销毁但应用仍在运行」这个状态没有统一处理**。触发前提相同——`closeToTray: 'quit'`（退出模式，非默认）+ macOS。macOS 下 `window-all-closed` 不会退出应用（`main.cjs` L1458–1463 仅非 darwin 才 `app.quit()`），所以关窗后应用仍驻留 dock + 托盘，但 `mainWindow` 已被 `closed` 处理器置 `null`。

> 对照组已验证：默认的托盘模式（`closeToTray: 'tray'`）下关窗只隐藏不销毁，文案与快捷键全部正常（`control-tray.test.cjs` 通过）。故以下两个 bug 的影响面严格限于「退出模式 + macOS」。

### Bug 4（低）：窗口销毁后托盘菜单文案停留在「隐藏主窗」，与点击动作相反

- 位置：`desktop/electron/main.cjs` `createWindow()` 刷新监听清单（L1262–1266）+ `tray.cjs` `refresh()`（L38–51）
- 问题描述：Bug 2 的修复把刷新监听收进 `createWindow()`，挂的是 `show`/`hide`/`minimize`/`restore` 四个事件，**没有 `closed`**。退出模式下关窗走的是「销毁」而非「隐藏」：`close` 不被 `preventDefault` → 窗口销毁 → 触发 `closed`（无监听）→ 没有任何 `refresh()` 被调用。托盘菜单于是停留在窗口最后一次可见时构建的文案「隐藏主窗」。
  而此时 `isWindowVisible()` 因 `mainWindow === null` 返回 `false`，正确文案应是「显示主窗」。用户按「隐藏主窗」点击，`onShowHide` 发现窗口已销毁 → `createWindow()` → **反而把窗口创建并显示出来**，与文案语义完全相反。文案会一直错到用户点击托盘/dock 让窗口重建为止。
- 触发场景：macOS + 设置里把「关窗行为」切为「直接退出」→ 关闭窗口（红点 / Cmd+W）→ 应用驻留托盘 → 点开托盘菜单看到「隐藏主窗」（实际无窗可隐）。
- 复现测试：`docs/code-review/repro/2026-10-26-electron-shell/destroyed-window.test.cjs` 用例 1。失败输出摘要：

  ```
  not ok 1 - 候选4：窗口销毁后托盘菜单文案停留在「隐藏主窗」（与点击动作相反）
    error: 窗口销毁后文案应翻为「显示主窗」
    '隐藏主窗' !== '显示主窗'
    expected: '显示主窗'
    actual:   '隐藏主窗'
  ```

- 修复方向：在 `createWindow()` 的监听清单里补 `mainWindow.on('closed', refreshTray)`（`closed` 时 `mainWindow` 尚未被置 null 也无妨，`refresh()` 读的是最新值）；或在 `onShowHide`/`activate`/`second-instance` 重建窗口后显式 `appTray?.refresh()`。
- 严重程度：**低**

### Bug 5（低）：窗口销毁后全局快捷键完全失效（无法唤起窗口）

- 位置：`desktop/electron/main.cjs` `applyGlobalShortcut()` 回调首行（L1337–1338）
- 问题描述：快捷键回调的守卫是 `const win = mainWindow; if (!win || win.isDestroyed()) return`。退出模式关窗销毁窗口后 `mainWindow` 为 `null`，回调直接返回——**什么都不做**。而快捷键本身仍处于注册状态（`before-quit` 未触发，不会注销），设置页也显示快捷键已启用。这与该函数文档注释声明的语义「触发时窗口可见且聚焦则隐藏，**否则唤起**」直接矛盾：无窗口时应当重建窗口，实际是空转。
  此状态下用户没有任何快捷键途径恢复窗口，只能靠 dock 点击（`activate` → `getAllWindows()===0` → `createWindow`）或托盘点击。
- 触发场景：同上（macOS + 退出模式 + 关窗后）→ 按 Alt+Shift+M（或用户自设键）→ 无任何反应。
- 复现测试：`docs/code-review/repro/2026-10-26-electron-shell/destroyed-window.test.cjs` 用例 2。失败输出摘要：

  ```
  not ok 2 - 候选5：窗口销毁后按全局快捷键完全无效果（无法唤起窗口）
    error: 按快捷键后应重建出可用窗口（设计语义「否则唤起」）
    0 !== 1
    expected: 1
    actual:   0
  ```

- 修复方向：把 `return` 改为 `createWindow()`（与 `onShowHide`、`second-instance` 的既有处理一致），即无窗口时建窗再 focus。
- 严重程度：**低**

---

## 三、低风险观察（未列为确认 bug，仅供加固参考）

1. **退出模式 + macOS 下点击系统通知不回唤窗口**：`desktop-notify` 的 click 处理器（`main.cjs` L1374–1383）只 `sendToRenderer('desktop-notification-click')`，窗口已销毁时不会把窗口带出来，用户点了通知、路由跳了，但眼前没有窗口。**未列为 bug**：设置页切到退出模式时的确认弹窗已明示「系统通知将不再到达（应用未运行）」，设计文档亦写明「退出模式维持现状」，属已告知的取舍。探针见 `docs/code-review/repro/2026-10-26-electron-shell/main-shell-probes.test.cjs` 之外另测（`/tmp` 版 J 用例）。
2. **第 1 轮观察 1（updater 重复检查）已排除**：`checkForAppUpdate()` 有 `updateCheckPromise` 去重（L669–685），重叠调用返回同一 Promise，不存在重复 `checkForUpdates()`。第 1 轮该条观察过于保守，现予更正。
3. **`applyGlobalShortcut` 上方残留两块重复 JSDoc**（`main.cjs` L1311–1316 与 L1317–1323），修复时新增了第二块而未删旧块。纯注释冗余，无功能影响。
4. **「重设成与当前相同的快捷键」的行为依赖 Electron 版本语义**：`applyGlobalShortcut` 在 `currentShortcutAccel === accel` 时仍会先 `register(accel)`。若 Electron 对「本进程已注册的同一 accelerator」返回 `false`，用户会看到一条误导性的「快捷键注册失败，可能已被其他程序占用」toast（旧键仍生效、偏好不写，无功能破坏）。harness 的假 `globalShortcut.register` 恒返回 `true`，无法在此环境证实真实 Electron 的返回值，故不列为 bug；建议修复时加 `if (currentShortcutAccel === accel) return { ok: true }` 早退，一举消掉版本依赖。
5. **`maxSizeMb` 由渲染层传入、主进程未设上限兜底**（`chatAttachment.cjs` L178–180）：极端大的值会让超大文件被拷入 `~/.mao`。渲染层已先做 `checkFileSize` 预检，属纵深防御缺口而非可触发 bug。
6. **`getServerHostKey()` 对 IPv6 服务器 URL 会产生含 `[`/`]`/`:` 的目录名**（`serverConfig.cjs` L93–101），在 Windows 上 `mkdirSync` 会失败。此为**存量行为**（`resolveLocalRuntimeDir` 早已使用同一推导），非本次引入，本次附件落点只是沿用了同一约定。

---

## 四、已验证无问题的关键链路（供合并决策参考）

- **正式回归测试的真实保护力（反向验证）**：把 `main.cjs` 换回修复前版本（`git show e02a726a:desktop/electron/main.cjs`，置于同构目录 `/tmp/r2-reverse2/desktop/electron/` 并软链 `node_modules`），`mainShell.test.cjs` 结果 **19 pass / 3 fail**，失败的正是用例 1/2/3（三个 bug 回归）；换回修复后版本 **22 pass / 0 fail**。证明 22 例不是「假通过」，确实能抓住这三个 bug。
- **P1 LOCAL 附件落点与安全**：`chatAttachment.cjs` 全量走读 + 既有 308 行单测——`sanitizeAttachmentName`（basename 化、控制字符、Windows 保留名、≤100 字截断、幂等）、`isValidHostKey`/`isValidSessionId` 强校验、`resolveAttachmentTarget` 的 home 相对断言、`uniqueName` 的 `-1/-2` 递增、`copyLocalAttachment` 全同步（`lstatSync` 拒目录/符号链接、空文件与大小校验）均正确；第 1 轮怀疑的并发拷贝 TOCTOU 竞态经证实不成立（同步函数 + 单实例锁，无交错窗口），结论记录在 `chatAttachment-race.test.cjs`。
- **P1 渲染层分流**：`prepareAndSendMessage` / `enqueueMessage` / `SideChatPanel.handleChatSend` 三处 LOCAL/CLOUD 分流结构一致，均满足「会话落库后再处理附件 → `guardUploadsBeforeSend` 防线 → `resolveFileRefPaths` → 乐观 UI 与 WS 发送用同一份文本」；`failureLabel` 在 LOCAL 下传「拷贝」。`chat-shared-actions.test.ts` 有主/边路共用导出的守护。
- **文件引用格式**：`@{绝对路径}@` 与后端既有约定完全一致（`prompt-engine.ts`、feishu/dingtalk 入站链路同格式）；`isAbsoluteFileRef` 同时认 POSIX `/` 与 Windows 盘符 `C:\`，Windows 落点不会被误当相对路径拼坏。
- **通知桥接**：`useInboxSystemNotify.ts` 幂等注册（`bridgeSetup` 模块级单例）+ `resetInboxSystemNotifyForTest`；`peekInboxFirstPage` 与「打开抽屉播种」解耦，避免 diff 恒空；dock 角标 watch 随 `unreadCount` 权威值联动。
- **偏好持久化**：`desktopPrefs.cjs` tmp+rename 原子写、逐字段 normalize 回退、坏 JSON 回落默认、`clearDesktopPrefsCache` 供测试隔离。
- **回归**：`npm run test:unit` → vitest 916 passed（103 文件）；`node --test electron/*.test.cjs` → 105 例中 103 通过，2 个失败为**存量已知环境问题**（`gitOperations` 身份注入受本机全局 git 配置干扰、`localShell` 的 `/var`→`/private/var` 符号链接），与本次改动无关。

---

## 五、`mainShell.test.cjs` 假通过风险评估

**总体风险：低。** 已逐项核对 harness 与真实 Electron 的语义一致性，并做了上述反向验证。 faithful 的点包括：ready 前建窗即抛同一错误、`close` 被 `preventDefault` 后不销毁、`isVisible()` 在最小化时为 false、`app.quit()` 先触发 `before-quit` 再关窗、`globalShortcut.unregister(accel)` 按 accel 精确移除、`getAllWindows()` 过滤已销毁窗口、`sendToRenderer` 只发 `mainWindow`。

**已识别的一处分歧（不影响现有用例的保护力）**：假 `globalShortcut.register` 除 `failNext` 外恒返回 `true`，无法建模「同一 accelerator 已被本进程注册时 Electron 返回 false」。若主进程存在「重复注册同一键却误判 `false` 为失败」的缺陷，现有用例抓不到。当前 `main.cjs` 不存在此类缺陷（见观察 4 的版本依赖提示），故不影响结论；建议后续在 harness 里补一个「同键重复注册返回 false」的开关，把这条路径也纳入守护。

**已识别的覆盖缺口（正是 Bug 4/5 的藏身处）**：22 例全部建立在「窗口存在」或「窗口已重建」的前提上，**没有任何一例覆盖「窗口已销毁且尚未重建」状态**。Bug 4（托盘文案）与 Bug 5（快捷键空转）都活在这个状态里，所以正式测试全绿而 bug 真实存在。建议修复后补 2 条用例（`quit` 模式 + `platform: 'darwin'` 下关窗销毁，分别断言托盘文案翻「显示主窗」、快捷键回调能重建窗口），并保留 `control-tray.test.cjs` 作为托盘模式对照组。

---

## 六、验证过程说明

- 第 2 轮新增探针 3 个，已落在 `docs/code-review/repro/2026-10-26-electron-shell/`（`destroyed-window.test.cjs` = Bug 4/5 复现；`control-tray.test.cjs` = 托盘模式对照组；`shortcut-paths.test.cjs` = 快捷键 6 条换键路径 A–F + 托盘重建路径 G）。均通过 `require('<repo>/desktop/electron/mainShellHarness.cjs')` 复用正式 harness，可直接 `node --test` 运行。
- 反向验证方法（可复现）：建同构目录 `<scratch>/desktop/electron/`，放入 `main.cjs` 同级全部 `.cjs` 与 `assets/`，软链 `desktop/node_modules`，再把 `main.cjs` 替换为 `git show e02a726a:desktop/electron/main.cjs`，运行 `node --test electron/mainShell.test.cjs` 得 19 pass / 3 fail。
- 第 1 轮报告（`2026-10-26-electron-shell-completeness-review.md`）中的 3 个 bug 结论与复现文件保持有效；本报告为其第 2 轮复审结论。
