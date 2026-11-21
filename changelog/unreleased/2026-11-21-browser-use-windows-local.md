### 后端

- **浏览器依赖按需安装支持 Windows 后端**：检测/安装链覆盖 win32（系统 Chrome 候选 `%ProgramFiles%` / `%ProgramFiles(x86)%` / `%LOCALAPPDATA%`，chromium 缓存 `%LOCALAPPDATA%\ms-playwright`；安装链 npm 全局（用户级，免管理员权限）→ winget 尝试装系统 Chrome（失败静默降级）→ npmmirror 镜像下载 chromium）。npm / playwright-cli / npx 等 `.cmd` shim 命令自动走 shell 化执行。仅后端与桌面同机（自托管单机 / 开发态）时安装发生在本机。

### 前端（桌面 / Web / 安卓）

- **browser-use 技能支持 Windows 桌面端 LOCAL 模式**：技能新增零依赖 node 入口 `browser_cli.mjs`（PowerShell 宿主无 bash，Windows LOCAL 语义与 bash wrapper 等价），Windows 上自动化全流程（open/snapshot/click/type/close）与画中画观看链路打通；SKILL.md 按 `node -e "console.log(process.platform)"` 分流入口，macOS/Linux/CLOUD 行为零变化（仍走 bash wrapper）。
