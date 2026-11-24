### 桌面 Electron

- **修复 Windows 安装后桌面缺少入口图标**：NSIS 原先依赖 electron-builder 默认值（oneClick + per-user + keepShortcuts），覆盖安装时若用户删过桌面图标就不会重建。改为显式声明 `oneClick: false`、`perMachine: true`、`allowToChangeInstallationDirectory: true`、`createDesktopShortcut: "always"`、`createStartMenuShortcut: true`、`shortcutName: "Mao"`，安装向导每次都会无条件创建桌面与开始菜单快捷方式，自动更新路径同样生效。安装位置随之从 `AppData\Local\Programs` 改为 `Program Files`，需要一次 UAC 提权确认，同时可减少杀软对 per-user 目录写入 DLL 的启发式误报。
