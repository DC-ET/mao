# Mao 桌面客户端

Electron + Vue 3 桌面客户端，提供 Agent 对话、LOCAL 模式本地工具执行与终端能力。

## 开发

```bash
npm install
npm run dev           # 浏览器预览 http://localhost:5201
npm run dev:electron  # Electron 模式（完整本地工具能力）
```

## 构建

```bash
npm run build   # Web 静态资源
npm run dist    # Electron 打包（需自行处理代码签名）
```

部署前请修改 `.env.production` 中的 `VITE_API_BASE_URL` 为你的后端地址。

## 自动更新

桌面壳使用 `electron-updater` + `electron-builder` 的 generic provider。**通用安装包**在运行时配置服务器（首次启动配置页 / 菜单「服务器设置…」/ 设置 → 服务器），配置存于 Electron `userData/server-config.json`。未配置且未设置环境变量时，默认站点为 `https://mao.example.com`。可用环境变量：

- `MAO_DESKTOP_SERVER_URL` — 锁定站点根（优先于配置文件）
- `MAO_DESKTOP_UPDATE_URL` — 覆盖自动更新源

更新源策略（配置文件 `updateFeedMode`）：

| 值 | 行为 |
|----|------|
| `follow-site`（默认） | 从当前服务器 `{site}/api/uploads/releases/` 检查壳更新 |
| `package-default` | 使用 `package.json` 中 `build.publish[0].url`（打包时写死） |
| `disabled` | 不检查壳自动更新 |

私有部署若仍要出厂绑定域名，可改 `package.json` 的 `build.publish[0].url` 或构建时注入上述环境变量。发布新版本时需要：

1. 修改 `package.json` 的 `version`。
2. 执行 `npm run build && npm run dist`。
3. 将 `release/` 下安装包、blockmap 与 `latest*.yml` 元数据上传到更新地址。

macOS 自动更新依赖签名后的 zip 产物，正式分发建议同时完成 notarize；Windows 建议签名 NSIS 安装包。

## Windows 安装包行为

`package.json` 的 `build.nsis` 显式声明了安装器行为，不依赖 electron-builder 默认值：

| 选项 | 值 | 作用 |
|------|----|------|
| `oneClick` | `false` | 走安装向导（而非一键静默装） |
| `perMachine` | `true` | 安装到 `Program Files`，所有用户可用；需要一次 UAC 提权 |
| `allowToChangeInstallationDirectory` | `true` | **关键**：让 NSIS 的 `isTryToKeepShortcuts` 恒为 `false`，跳过 keepShortcuts 分支 |
| `createDesktopShortcut` | `"always"` | 桌面快捷方式（`"always"` 与 `RECREATE_DESKTOP_SHORTCUT` 对应） |
| `createStartMenuShortcut` | `true` | 开始菜单快捷方式 |
| `shortcutName` | `"Mao"` | 快捷方式显示名 |

`allowToChangeInstallationDirectory: true` 是修复「用户删过桌面图标后重装不重建」的必要条件：electron-builder 的 keepShortcuts 机制会读注册表里的旧记录，若旧快捷方式已被手动删除，两个 `${elseif}` 分支都不命中，安装器就不会创建图标且不报错。置 `false` 后 `$keepShortcuts` 恒为 `false`，直接进入无条件 `CreateShortCut` 分支，手动安装与 electron-updater 的 `--updated` 路径都生效。

代价：安装向导多一页「选择安装目录」，且首次安装/更新会弹 UAC。若改回 per-user 安装，需同步评估 360 等杀软对 `AppData\Local\Programs` 目录 DLL 写入的启发式误报。

> 仓库仅提供源码，不提供官方签名安装包。详见根目录 [README.md](../README.md)。

## 相关文档

- [DEPLOY.md](../DEPLOY.md) — 生产部署
- [CONTRIBUTING.md](../CONTRIBUTING.md) — 贡献指南
