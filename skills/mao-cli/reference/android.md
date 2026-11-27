# 安卓 APP

基于 **Capacitor 7** WebView 壳，包名 `cn.etarch.mao.app`。无 `electronAPI`：不能挑选本地目录、本地终端等桌面能力不可用；LOCAL 模式可复用已有本地工作区新建任务（2026-11-18 起，执行端为该工作区绑定的桌面设备），其余场景仍以 CLOUD 为主。

生产环境**远程加载**与 Web/Electron 相同的桌面 Web URL（你部署的站点，如 `https://mao.example.com`），前端改动**无需打 APK**——部署 Web 后顶栏刷新或等待 `version.json` 提示即可。

## 与桌面 Web 的关系

| 变更类型 | 操作 |
|----------|------|
| 仅 `desktop/` 前端 UI | `deploy-desktop.sh` 或构建 `desktop/dist`，用户刷新 |
| 原生壳（MainActivity、OTA 插件、Capacitor 配置） | 更新发版说明后 `build-apk.sh` |

安卓专用 UI 在 `desktop/` 中用 `android-capacitor` / `Capacitor.isNativePlatform()` 守卫。

## 服务器与站点

一个通用 APK 可以连接多套私有部署，切换后立即重启加载新站点，不需要按域名单独打包。

- **默认地址**：优先级为「已保存地址 → 构建期 `--server-url` / `MAO_DEFAULT_SERVER_URL` → `capacitor.config.json` 的 `server.url` → 官方站点」。构建期写入的 HTTP 默认地址视为可信，不受「默认只允许 HTTPS」限制。
- **入口**：启动加载超过 8 秒时遮罩上出现「服务器设置」；登录页底部「服务器设置」；设置 →「服务器」；长按桌面图标的「服务器设置」快捷方式。前三个入口都按原生 `ServerConfig` 插件是否存在显示，旧壳自动隐藏。
- **选择器**：卡片式布局：顶部「当前站点」，中间填写站点根 + 检测连通性，底部固定「取消 / 保存并切换」。最多保留 10 条最近连接记录，每条显示相对连接时间与 HTTP 标签，点「切换」直接生效并重启（当前站点置灰为「当前」）；点卡片可回填编辑。删除有二次确认。探测失败仍可二次确认强制保存（跨 origin 重定向除外，只能保存最终地址）。
- **仅支持站点根**：`https://mao.example.com`、`https://mao.example.com:8443`；带 `/api`、`/api/v1` 会自动去掉，`443`/`80` 默认端口会省略。`https://host/mao` 这类子路径会被拒绝——桌面端 `vite base: '/'` 与 history 路由要求部署在站点根，请改用独立域名。
- **HTTP**：默认只接受 HTTPS；勾选「允许 HTTP」并二次确认后可保存 `http://` 地址。HTTP 页面不是安全上下文，Git 撤销摘要与剪贴板写入已有前端兜底，但 token 和内容为明文传输，仅建议可信内网使用。
- **同源前置**：目标站点必须在同一 origin 提供 `/api/v1` 与 `/uploads`，且已部署包含同源改造的 `desktop/dist`。split-domain（SPA 与 API 不同源）站点必须在构建前端时显式设置 `VITE_API_BASE_URL`，不能直接使用通用 dist。

## 构建 APK（仅原生壳变更）

环境：JDK 21、Android SDK（`platforms;android-35`、`build-tools;34.0.0`）。

```bash
cd android
export ANDROID_HOME=/opt/android-sdk   # 按本机调整
bash build-apk.sh                      # --dry-run / --version 0.0.x
bash build-apk.sh --server-url https://mao.example.com --version-code 12
```

- `--server-url`（或 `MAO_DEFAULT_SERVER_URL`）：写入编译期默认站点，未保存过地址的首次启动直接加载它。
- `--version-code`：显式指定 versionCode；构建前若本机 `uploads/releases/android-latest.json` 的 versionCode 不小于该值会直接报错。用于私有站 OTA 必须严格递增的场景。
- `MAO_PUBLIC_BASE_URL`：生成清单里 `downloadUrl` 的基址，默认官方站点；私有站发版时改成该站域名。

签名：`MAO_KEYSTORE_*` 环境变量或本地 keystore 凭据文件（**勿入 git**）。

默认发布到数据目录 `uploads/releases/`：

- `mao-android-<versionName>-<versionCode>.apk`
- `android-latest.json`（OTA 清单，含原生 changelog）

`versionCode` 脚本按已发布 APK 自增；`versionName` 取自 `changelog/` 归档里最新一条版本号。

## 应用内更新

| 类型 | 机制 |
|------|------|
| 页面更新 | 轮询当前站点 `version.json`，与 Web/Electron 一致 |
| 原生壳 OTA | 当前站点 `/uploads/releases/android-latest.json` + `AppUpdate` 插件下载安装 APK |

OTA 清单与 APK 都从**当前配置的站点**获取，`downloadUrl` 支持相对路径（相对清单地址解析），切换服务器后不需要改壳。

**私有站 OTA 口径**：私有站只托管**官方签名**的 APK 和该站自己的 `android-latest.json`；不要用私有 keystore 重新构建。Android 只允许同签名覆盖安装，签名不同会安装失败；`versionCode` 不高于已装版本同样会被系统拒绝。私有站没有 releases 目录时 OTA 返回 `not-available` 且不弹提示，不影响 App 正常使用。

## 外链打开

App 内点击 http/https/mailto 链接（助手回复、文件预览、下载对话框等）由 `desktop/src/utils/externalLink.ts` 在 document 级统一拦截，经 `openExternalUrl()` 落到原生 `OpenUrl` 插件，用 `ACTION_VIEW` 交给系统浏览器或对应 App。

原因：WebView 未开启多窗口，页面里 `target="_blank"` 的 `window.open` 必然失败，不接管时点击无任何反应。工作区内文件相对链接、锚点跳转不受影响。若设备上没有可处理该链接的应用会给出提示。新增外链协议需同步 `OpenUrlPlugin.openUrl` 的白名单与前端 `EXTERNAL_PROTOCOL_RE`。

## 云端终端（0.0.97 起）

CLOUD 任务可用云端终端（需 `terminal:use` 权限），安卓端额外提供底部虚拟按键条（Esc / Tab / Ctrl 粘滞 / 方向键 / Ctrl+C / Ctrl+D / 粘贴），软键盘弹出时面板自动避让。属纯前端能力，随 Web 部署生效，无需打 APK。LOCAL 任务的终端按绑定设备的主机状态开放（2026-11-19 起）：执行端的桌面客户端或 mao-agent 在线时安卓同样可开中继终端（shell 在那台电脑上），离线 / 版本过旧按按钮 tooltip 提示。详见 [desktop.md](desktop.md#终端)。

## 明确不做

LOCAL 能力、工具审批、系统推送、应用商店上架、移动端大改布局、独立后端/admin 功能。

## 部署侧 Nginx

桌面端 `mao.conf` 需反代 `/api/` 与 `/api/ws/`，并可选 `uploads/` 静态别名供 APK 与资源访问。见 [deploy.md](deploy.md)。
