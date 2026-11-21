### 桌面 Electron

- **退出应用不再遗留直播浏览器进程**：优雅退出（before-quit）时对仍在直播的 LOCAL 会话同步补发 sidecar `/stop`（杀浏览器、收 sidecar），修复退出后 sidecar 与 Chrome 孤儿存活到 2 小时硬上限的问题（2026-11-21 Windows 真机 smoke 实证）。
- **修复审批等待期直播发现失效**：shell 工具到达即开始的 live.json 轮询窗口会被审批等待耗尽，且审批通过后的重挂被「在途早退」吞掉、两头落空；现在重挂会重置计数延长窗口，并把轮询上限从 8×1.5s 提高到 12×1.5s（真机实测：批准后 wrapper 仍需数秒才落盘 live.json）。
- **修复画中画窗口在 Windows 不置顶**：`setAlwaysOnTop('floating')`（含缺省 level）在 Windows 不映射为 HWND_TOPMOST，小窗会被主窗口整体遮住；Windows 改用 `screen-saver` 级别，macOS 语义不变。
- **修复画中画窗显示登录页/完整主界面**：画中画窗此前未挂 preload（拿不到令牌被守卫重定向），且 `/#/pip` hash 形式路由在 WebHistory 下永不匹配；现在挂同款 preload 并改用路径形式 `/pip`。
- **画中画窗迟到消费不再停在等待态**：主进程枢纽保留每会话最新帧并纳入 getState 快照，画中画/懒加载组件挂载时灌入初始状态与画面，修复快照早于 watch 注册导致的黑屏。

### 前端（桌面 / Web / 安卓）

- **浏览器直播状态初始快照**：Electron 下 renderer 挂载即从主进程枢纽灌入全量直播状态（含最新帧），不再依赖迟到的事件增量。

- **browser-use wrapper 直播模式判定显式化**：新增 `MAO_BROWSER_LIVE_MODE=local` 口径（桌面端注入），与「有无 MAO_BASE_URL/MAO_TOKEN」的云端启发式并行，防止桌面 LOCAL 场景误触发 cloud 模式导致 runner_auth 拒绝。
