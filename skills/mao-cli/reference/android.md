# 安卓 APP

基于 **Capacitor 7** WebView 壳，包名 `cn.etarch.mao.app`。**仅 CLOUD 模式**（无 `electronAPI`，自动禁用 LOCAL）。

生产环境**远程加载**与 Web/Electron 相同的桌面 Web URL（如 `https://mao.etarch.cn`），前端改动**无需打 APK**——部署 Web 后顶栏刷新或等待 `version.json` 提示即可。

## 与桌面 Web 的关系

| 变更类型 | 操作 |
|----------|------|
| 仅 `desktop/` 前端 UI | `deploy-desktop.sh` 或构建 `desktop/dist`，用户刷新 |
| 原生壳（MainActivity、OTA 插件、Capacitor 配置） | 更新发版说明后 `build-apk.sh` |

安卓专用 UI 在 `desktop/` 中用 `android-capacitor` / `Capacitor.isNativePlatform()` 守卫。

## 云端终端（0.0.97 起）

CLOUD 任务可用云端终端（需 `terminal:use` 权限），安卓端额外提供底部虚拟按键条（Esc / Tab / Ctrl 粘滞 / 方向键 / Ctrl+C / Ctrl+D / 粘贴），软键盘弹出时面板自动避让。属纯前端能力，随 Web 部署生效，无需打 APK。LOCAL 任务的本地终端在安卓上仍不可用。详见 [desktop.md](desktop.md#终端)。

## 构建 APK（仅原生壳变更）

环境：JDK 21、Android SDK（`platforms;android-35`、`build-tools;34.0.0`）。

```bash
cd android
export ANDROID_HOME=/opt/android-sdk   # 按本机调整
bash build-apk.sh                      # --dry-run / --version 0.0.x
```

签名：`MAO_KEYSTORE_*` 环境变量或本地 keystore 凭据文件（**勿入 git**）。

默认发布到数据目录 `uploads/releases/`：

- `mao-android-<versionName>-<versionCode>.apk`
- `android-latest.json`（OTA 清单，含原生 changelog）

`versionCode` 脚本按已发布 APK 自增；`versionName` 取自仓库 CHANGELOG 首条版本号。

## 应用内更新

| 类型 | 机制 |
|------|------|
| 页面更新 | 轮询 `version.json`，与 Web/Electron 一致 |
| 原生壳 OTA | `android-latest.json` + `AppUpdate` 插件下载安装 APK |

## 明确不做

LOCAL 能力、工具审批、系统推送、应用商店上架、移动端大改布局、独立后端/admin 功能。

## 部署侧 Nginx

桌面端 `mao.conf` 需反代 `/api/` 与 `/api/ws/`，并可选 `uploads/` 静态别名供 APK 与资源访问。见 [deploy.md](deploy.md)。
