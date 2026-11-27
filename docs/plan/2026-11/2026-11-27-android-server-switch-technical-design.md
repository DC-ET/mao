# 安卓壳多服务器切换与前端同源 API 技术方案

- 状态：已实现（2026-11-27，未发版；发版说明见 `changelog/unreleased/2026-11-27-android-server-switch.md`）
- 日期：2026-11-27
- 一句话：安卓壳支持运行时切换 Mao 站点并允许 HTTP；前端 API/WS/OTA 改为跟随当前站点 origin，一个通用 APK 可连接多套私有部署，不再按域名单独打包。一期只接受站点根；HTTP 站补 `crypto.subtle`/剪贴板兜底；私有站 OTA 只托管官方签名 APK。
- 关联代码（撰写时已核实，行号以当前工作区为准）：
  - 安卓远程地址写死：`android/capacitor.config.json:6`（`server.url = https://mao.etarch.cn`）
  - 构建与 OTA 发布：`android/build-apk.sh:5`、`:87`、`:141`
  - 壳启动与 WebView：`android/android/app/src/main/java/cn/etarch/mao/app/MainActivity.java:109`（onCreate）、`:225`（加载遮罩）、`:385`（configureWebView）、`:437`（版本变更后 `loadUrl(bridge.getAppUrl())`）
  - 已注册插件：`MainActivity.java:113-114`（AppUpdate、OpenUrl）
  - 安卓清单：`android/android/app/src/main/AndroidManifest.xml`（当前未声明 cleartext）
  - 前端 API 基址写死：`desktop/.env.production:2`（`VITE_API_BASE_URL=https://mao.etarch.cn/api/v1`）
  - 前端调用点：`desktop/src/api/index.ts:18,37`、`desktop/src/composables/useStreamWS.ts:290,1345`、`desktop/src/composables/useTerminalWS.ts:76-78`、`desktop/src/composables/workspace-file-provider.ts:511`、`desktop/src/composables/workspace-file-write.ts:6`、`desktop/src/utils/deliveryUrl.ts:4`、`desktop/src/utils/markdownImages.ts:14`、`desktop/src/utils/sessionShare.ts:4`、`desktop/src/utils/avatar.ts:5`、`desktop/src/views/settings/DingtalkBindRedirect.vue:15`
  - 安卓 OTA 清单地址：`desktop/src/composables/useVersionCheck.ts:11-12`
  - 服务器设置页仅 Electron 可编辑：`desktop/src/views/settings/ServerSettingsView.vue:10`；设置导航仅 Electron 显示：`desktop/src/views/settings/SettingsView.vue:83`
  - Electron 多服务器先例：`desktop/electron/serverConfig.cjs:26`（归一化）、`:251`（探测）、`desktop/electron/main.cjs:819`（生效地址）、`:896`（加载内容）、`:935`（切换）
  - 健康检查：`backend-ts/src/app-routes.ts:433`（`GET /api/v1/health`）；免鉴权白名单：`backend-ts/src/auth/jwt-hook.ts:6`
- 关联方案：
  - [桌面客户端多服务器 baseUrl 可配置方案](../2026-09/2026-09-20-desktop-multi-server-baseurl-design.md)（本方案沿用其「壳只负责连哪一站，前端由该站提供」模型；该文 §12 Q6 将安卓明确列为二期）
  - [安卓 APP 技术方案（Capacitor 打包）](../2026-08/2026-08-04-android-app-technical-design.md)

## 1. 背景与目标

### 1.1 现状

安卓壳生产环境远程加载 `https://mao.etarch.cn`，地址在打包时写入 `capacitor.config.json`：

- `build-apk.sh` 在构建前执行 `npx cap copy/update`，把配置同步进 APK assets；
- `MainActivity` 无任何运行时读取/改写服务器地址的逻辑；
- 前端 bundle 在构建时把 `VITE_API_BASE_URL` 内联为 `https://mao.etarch.cn/api/v1`；
- OTA 清单 `android-latest.json` 的 `downloadUrl` 也写死为官方域名。

结果：每套私有部署要么单独改配置重新打 APK，要么在安卓端不可用。Electron 端已经支持在应用内切换服务器（`server-config.json` + 首启选择页 + 设置页），安卓没有对应能力。

### 1.2 目标

1. 安卓壳可在运行时填写/切换站点根地址，持久化，重启后仍生效。
2. 一个通用 APK 可连接多套 Mao 部署，不需要为每个域名单独打包。
3. 切换后 API、WebSocket、上传/静态资源、OTA 清单都跟随当前站点，不串到 `mao.etarch.cn`。
4. 允许 HTTP 站点（内网），但必须有明确风险提示；默认仍只接受 HTTPS。HTTP 站不是安全上下文，`crypto.subtle`、`navigator.clipboard` 等 API 会不可用，需按 §4.9 补齐兜底或明确降级。
5. 每个站点的登录态、localStorage、缓存按 origin 天然隔离；切回旧站保留原登录。
6. 至少四个入口：设置页、登录页、首屏加载失败遮罩、系统桌面长按快捷方式；其中快捷方式不依赖远端页面是否可用。
7. 探测失败、URL 非法、站点不可达时有明确提示，不静默回落旧站。
8. 不改后端协议，不改 admin。

### 1.3 非目标

- 不做同一客户端并行登录多套服务器（多 Profile）。
- 不把 Vue 前端打进 APK，不改变「远程 SPA」架构。
- 不做按站点同步主题、通知偏好等 UI 设置；这些仍按 origin 隔离。
- 不做自签名证书绕过、TLS 校验放宽。
- 不改后端、admin、LOCAL 能力、推送、应用商店上架。
- 不在一期实现 Electron 的 `updateFeedMode`（`follow-site` / `package-default` / `disabled`）完整策略；安卓一期固定跟随当前站点。
- 不做旧 APK 的自动迁移（旧 APK 本身没有运行时配置能力，只能升级到新壳）。
- 不支持站点部署在子路径（如 `https://host/mao`）；一期只接受站点根（origin + port）。子路径站点需独立域名或另立方案。
- 不支持 split-domain 私有站（SPA 与 API 不同源）直接使用通用 `desktop/dist`；这类站点必须继续用 `VITE_API_BASE_URL` 显式覆盖构建。
- 不允许私有部署方自行用不同 keystore 构建可覆盖安装的 APK；一期私有站只托管官方签名 APK。
- 不保证 HTTP 站上所有依赖安全上下文的 Web API；一期补 `gitDiscardDigest` 与剪贴板兜底，其余入口明确提示。

## 2. 现状核实与约束

### 2.1 安卓壳

- 远程 SPA：`android/capacitor.config.json` 的 `server.url`；`androidScheme` 为 `https`；`android.adjustMarginsForEdgeToEdge` 为 `force`。
- `MainActivity` 继承 `BridgeActivity`，在 `onCreate` 里注册 `AppUpdatePlugin`、`OpenUrlPlugin`，然后 `super.onCreate()`。
- 加载遮罩已具备弱网重试：8s 超时后显示「重新连接」按钮（`MainActivity.java:276-296`）。
- 原生插件通过 `window.Capacitor.Plugins.<Name>` 访问，前端未安装 `@capacitor/core` npm 包（见 `desktop/src/utils/capacitor.ts`）。

### 2.2 Capacitor 7 的运行时约束（本方案的关键依据）

已核对 `@capacitor/android@7.6.8` 源码（`Bridge.java`、`BridgeActivity.java`、`CapConfig.java`、`WebViewLocalServer.java`）：

1. `Bridge` 创建时读取 `server.url`，写入 `appUrl` / `localUrl`，随后 `webView.loadUrl(appUrl)`。
2. Capacitor 的 bridge JS 通过 `WebViewCompat.addDocumentStartJavaScript(webView, injector.getScriptString(), Collections.singleton(allowedOrigin))` 注入，`allowedOrigin` 由 `appUrl` 的 scheme + authority 计算。**只有当前 `appUrl` 的 origin 会拿到 bridge**。
3. 因此运行时直接 `webView.loadUrl(新站)` 会变成普通外链：页面能开，但 `AppUpdate`、`OpenUrl` 等插件全部不可用。
4. `BridgeActivity` 的 `load()` 是 `protected` 虚方法，`onCreate` 末尾调用它；`load()` 内部 `bridgeBuilder.setConfig(config).create()`。`BridgeActivity` 还有 `protected CapConfig config` 字段。**覆盖 `load()`、在 `super.load()` 前赋值 `this.config` 是 Capacitor 7 支持的扩展点。**
5. `CapConfig` 有已废弃但可用的构造器 `CapConfig(AssetManager, JSONObject)`，可基于 assets 里的 `capacitor.config.json` 克隆后只改 `server.url`，保留 `android.adjustMarginsForEdgeToEdge` 等全部原配置。`CapConfig.Builder` 没有 `setAdjustMarginsForEdgeToEdge`，不采用 Builder 逐项复制，避免漏项。

> 该扩展点依赖 Capacitor 7 的内部结构；升级 Capacitor 时需回归本文 §8 的动态配置用例。

### 2.3 前端 API 基址

- 生产构建 `desktop/.env.production` 写死官方 API 地址，`vite build` 时内联进 JS。
- 前端十余处直接读 `import.meta.env.VITE_API_BASE_URL`，默认回落到 `http://localhost:9080/api/v1`；WebSocket 两处；钉钉跳转、分享、头像、Markdown 图片、工作区文件读写都受影响。
- 当前 Electron 多服务器方案依赖「每个站点用自己的域名构建 `desktop/dist`」这一部署纪律（Electron 方案 §2.2、§15）。安卓要支持任意站点切换，如果沿用这条纪律，私有站漏配就会「壳在 B 站、接口打 A 站」。
- `admin` 已经是相对路径 `/api/v1`，不受影响。
- 同源化前置：站点必须在同一 origin 提供 `/api/v1` 与 `/uploads`。split-domain 私有站（SPA 与 API 不同源）必须保留 `VITE_API_BASE_URL` 显式覆盖；否则同源推导会把 API 打到 SPA origin（通常没有反代 `/api`）。
- 子路径不支持：`desktop/vite.config.ts` 的 `base: '/'` 与 `createWebHistory()` 决定站点必须部署在根；一期归一化会拒绝 `/mao` 这类地址。
- 注意 Electron 既有配置：主进程 `normalizeServerBaseUrl`/`deriveApiBase` 仍允许子路径；P1 的渲染层同源推导固定 origin 根，因此已有子路径 Electron 配置在 P1 后必须保留 `VITE_API_BASE_URL` 显式覆盖（或迁移到根），否则渲染层 API 会与主进程派生规则不一致。
- 目标站必须部署 P1 之后的 `desktop/dist`；旧 dist 在编译期烘焙了旧 API 域，探测无法识别，切换后仍可能串站。

### 2.4 OTA

- `useVersionCheck.ts:11-12` 由 `VITE_API_BASE_URL` 推导 `ANDROID_MANIFEST_URL`；生产即官方域名。
- `build-apk.sh:141` 把 `downloadUrl` 写成 `https://mao.etarch.cn/uploads/releases/<apk>`。
- `AppUpdatePlugin.downloadAndInstall(url)` 只接受绝对 URL（`new URL(url)`）。
- APK 升级要求：同一签名、`versionCode` 大于当前安装版本（或清单 `minVersionCode` 触发强制更新）。

### 2.5 数据隔离

- WebView 的 localStorage / IndexedDB / Cookie / HTTP 缓存都按 origin 隔离；不同站点天然不共享 token。
- 安卓设备侧没有 Electron 的 LOCAL runtime、本地终端、MCP 子进程；即使界面可触发执行在远端桌面设备上的 LOCAL 任务，执行端也不在本机，切站无需清理本机资源。
- 主题、通知偏好等前端偏好按 origin 存储，切到新站会回到默认值；这是可接受的已知差异。

## 3. 方案与关键决策

### 3.1 架构

```mermaid
flowchart LR
  subgraph APK["安卓壳 APK"]
    Prefs["SharedPreferences<br/>server_base_url / allow_http / history"]
    Picker["ServerPickerActivity<br/>输入 + 探测 + 历史"]
    Plugin["ServerConfig 插件<br/>get / openPicker"]
    Main["MainActivity<br/>load() 读配置"]
    Cap["Capacitor Bridge / WebView"]
  end

  subgraph SiteA["目标站点 A"]
    SPA["desktop/dist"]
    API["/api/v1 + /api/ws/"]
    Rel["/uploads/releases/"]
  end

  Picker --> Prefs
  Plugin --> Picker
  Main --> Prefs
  Main --> Cap
  Cap -->|"loadUrl(appUrl)"| SPA
  SPA -->|"同源请求"| API
  SPA -->|"同源请求"| Rel
```

核心模型与 Electron 一致：**壳只决定连哪一站；站点自己提供前端、API、OTA 清单**。前端 API/WS 改为同源解析后，站点不需要再按域名单独构建。

### 3.2 启动与切换流程

启动：

1. `MainActivity.onCreate` → `registerPlugin(ServerConfigPlugin.class)`。
2. `BridgeActivity.onCreate` 调用被覆盖的 `load()`。
3. `ServerConfigStore.getEffectiveBaseUrl(context)`：已保存地址 → 构建时默认地址 → assets `capacitor.config.json` 的 `server.url`。
4. 读取 assets 配置 JSON，覆盖 `server.url`，构造 `CapConfig`，赋给 `this.config`。
5. `super.load()` 创建 Bridge，WebView 加载目标站点；bridge JS 注入目标 origin。

切换：

1. 用户从设置页/登录页/遮罩/快捷方式打开 `ServerPickerActivity`。
2. 输入地址 → 归一化 → 探测（可跳过，见 §4.7）→ HTTP 确认（如适用）。
3. 写 SharedPreferences（`commit()` 同步落盘）→ 记录历史 → 返回 `changed=true`。
4. 调用方重启 `MainActivity`（清任务栈），新 Activity 按新配置加载。
5. 旧 origin 的 localStorage 保留；新 origin 是独立登录态；旧 token 不会被带到新站。

### 3.3 关键决策

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 切换模型 | 壳重新加载目标站点，不在前端运行时改 axios baseURL 跨域请求 | 与 Electron 一致；localStorage/缓存/登录态按 origin 隔离；无 CORS/CSP 问题 |
| D2 | 动态地址落点 | 覆盖 `BridgeActivity.load()`，用 assets JSON 克隆 `CapConfig` | Capacitor 7 唯一稳定的运行时改 `server.url` 方式；保留全部原配置 |
| D3 | 存储 | `SharedPreferences("mao_server_config")`；历史为 JSON 字符串 | 壳启动前即可读；无需文件 IO 与迁移 |
| D4 | 首次启动 | 不强制选择，默认 assets 里的官方地址；私有分发可用构建参数改默认 | 官方用户零打扰；私有用户可从登录页/快捷方式切换 |
| D5 | HTTP | 允许；默认 HTTPS，勾选「允许 HTTP」并二次确认；清单开启 cleartext；HTTP 下按 §4.9 补 `crypto.subtle`/剪贴板兜底 | 内网部署需要；HTTP 非安全上下文的能力降级必须显式处理 |
| D6 | 前端 API/WS | 生产改为同源运行时解析：`location.origin + /api/v1`；env 仅作显式覆盖（开发） | 一个 dist 可服务所有同源域名；同源私有站不再需要改 `.env.production` |
| D7 | 切换 UI | 原生 `ServerPickerActivity` 统一做输入/探测/历史；Web 只提供入口 | 不依赖远端 SPA 版本；首屏失败时也能改；避免 Vue/Java 两套表单 |
| D8 | 重启方式 | `Intent` 启动 `MainActivity`，`NEW_TASK \| CLEAR_TASK`，结束当前 Activity | 避免 WebView 恢复旧页面/旧历史；确保新 `CapConfig` 生效 |
| D9 | 插件面 | 只暴露 `get()` 与 `openPicker()`；`set`/`probe` 留在原生内部 | 减少远端页面静默改配置的面；改配置必须经过原生 UI 确认 |
| D10 | OTA | 一期固定跟随当前站点：清单相对当前 origin；`downloadUrl` 支持绝对/相对解析 | 私有站可托管官方签名 APK + 私有清单；官方站行为不变 |
| D11 | 默认地址来源 | 优先级：已保存 → `BuildConfig.MAO_DEFAULT_SERVER_URL` → assets `server.url` | 通用包官方默认；私有分发可编译默认；已保存优先 |
| D12 | 数据隔离 | 不主动清 token/缓存；按 origin 保留登录 | 切回旧站免登录；无跨站泄漏（见 §6） |
| D13 | 探测失败 | 默认阻止保存，提供「仍要保存（不推荐）」二次确认 | 防止填错地址；同时允许反向代理屏蔽 health 的内网站 |
| D14 | 重定向 | 探测跟随重定向；若最终 origin 与输入不同，提示并让用户确认改用最终地址 | `bridge` 只注入输入地址 origin，静默跟随会导致插件失效 |
| D15 | 后端 | 不改 | `/api/v1/health` 已存在且免鉴权；同源请求无需 CORS |
| D16 | 子路径 | 一期只接受站点根（origin + port）；归一化拒绝非根路径 | `vite base: '/'` 与 `createWebHistory()` 决定站点在根；避免探测/前端/Electron 三套规则不一致 |
| D17 | 私有站 OTA | 私有站只托管官方签名 APK + 自己的 `android-latest.json`；不允许私有站自行构建 APK | 无私钥无法产出可覆盖安装的包；私有站 releases 目录为空时 versionCode 也会低于已安装版本 |
| D18 | 同源前置 | 站点必须在同一 origin 提供 `/api/v1` 与 `/uploads`；split-domain 必须用 `VITE_API_BASE_URL` 显式覆盖构建 | 同源推导不适用于跨域 API；目标站还需先升级到 P1+ dist |
| D19 | 跨 origin 重定向 | 探测到最终 origin 与输入不同时，只允许保存最终地址，不允许保存输入地址 | bridge 只注入输入 origin；保存输入地址必然插件失效 |
| D20 | HTTP 能力兜底 | `gitDiscardDigest` 增加纯 JS SHA-256；直接剪贴板**写**调用统一到 `copyText`/`copyWithFallback`，读操作保留手动粘贴兜底 | 避免 HTTP 站「撤销全部」「复制分享链接」等静默失败 |

## 4. 详细设计

### 4.1 服务端配置存储与归一化

新增 `ServerConfigStore.java`（包 `cn.etarch.mao.app`）：

- SharedPreferences 文件名：`mao_server_config`（与现有 `mao_webview` 分离）。
- 键：

| 键 | 类型 | 说明 |
|---|---|---|
| `server_base_url` | String | 归一化后的站点根，无尾斜杠 |
| `allow_http` | boolean | 是否允许 HTTP |
| `updated_at` | String | ISO-8601，最近一次保存时间 |
| `history` | String | JSON 数组，MRU，最多 10 条 |

历史项结构：

```json
[
  {
    "serverBaseUrl": "https://mao.example.com",
    "allowHttp": false,
    "lastConnectedAt": "2026-11-27T10:00:00.000Z"
  }
]
```

- `getEffectiveBaseUrl(Context)` 顺序：已保存且归一化通过 → `BuildConfig.MAO_DEFAULT_SERVER_URL` 非空且通过 → assets `capacitor.config.json` 的 `server.url` → 常量 `https://mao.etarch.cn`。
- `lastConnectedAt` / `updated_at` 用 UTC ISO-8601 字符串；minSdk 24 下用 `SimpleDateFormat`（`java.time` 需 API 26+/desugaring，见 §8.1）。
- `save(Context, url, allowHttp)` 使用 `commit()`，确保重启前落盘。
- 历史去重按归一化后的 `serverBaseUrl`，新的置顶，超过 10 条截断。
- 不写 `configured` 标志：有保存值即视为已配置，减少状态。

新增 `ServerUrlNormalizer.java`（纯函数，便于单测）：

| 输入 | 输出 / 结果 |
|---|---|
| `mao.example.com` | `https://mao.example.com` |
| `https://mao.example.com/` | `https://mao.example.com` |
| `https://mao.example.com/api` | `https://mao.example.com` |
| `https://mao.example.com/api/v1` | `https://mao.example.com` |
| `https://mao.example.com/mao` / `.../mao/api/v1` | 拒绝：「仅支持站点根；子路径部署请使用独立域名」 |
| `https://MAO.EXAMPLE.COM` | `https://mao.example.com`（scheme/host 统一小写） |
| `http://10.0.0.8:8080/api` + allowHttp | `http://10.0.0.8:8080` |
| `http://...` 未允许 | 拒绝：「默认仅支持 HTTPS；内网 HTTP 请确认后开启允许」 |
| `https://user:pass@host` | 拒绝：不能包含账号密码 |
| `ftp://host` / `javascript:...` / `file:...` | 拒绝：不支持的协议 |
| 空串、无 host、URI 解析失败 | 拒绝 |

实现要点：

- 无 scheme 时补 `https://`；用 `java.net.URI` 解析；scheme/host 统一转小写。
- 拒绝 query / fragment；保留 port；IPv6 authority 原样处理。
- 非 ASCII/IDN 主机名一期不做自动转 punycode，直接拒绝并提示使用 punycode。
- 去掉尾部 `/`；路径以 `/api/v1` 或 `/api` 结尾时剥掉。
- **只接受站点根**：剥掉 `/api`/`/api/v1` 后 pathname 必须为空或 `/`；否则拒绝（D16）。
- 存储与 `CapConfig.server.url` 一律使用站点根（无尾斜杠）。
- BuildConfig/assets 的构建期默认地址按可信值放行（归一化时允许 HTTP），不受用户 `allow_http` 约束；`ServerConfigPlugin.get()` 的 `allowHttp` 按生效 URL 的 scheme 推导。

### 4.2 动态 Capacitor 配置

`MainActivity` 覆盖 `load()`：

```java
@Override
protected void load() {
    String target = ServerConfigStore.getEffectiveBaseUrl(this);
    try {
        JSONObject asset = readAssetJson("capacitor.config.json");
        JSONObject server = asset.optJSONObject("server");
        if (server == null) {
            server = new JSONObject();
            asset.put("server", server);
        }
        server.put("url", target);
        // 已废弃构造器：保留 assets 里的 android.adjustMarginsForEdgeToEdge 等全部配置
        this.config = new CapConfig(getAssets(), asset);
    } catch (Exception e) {
        Log.w(TAG, "build CapConfig failed for " + target + ", fallback to assets", e);
    }
    super.load();
}

private JSONObject readAssetJson(String name) throws Exception {
    try (InputStream in = getAssets().open(name)) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
        return new JSONObject(out.toString("UTF-8"));
    }
}
```

约束：

- `config` 必须在 `super.load()` 前赋值；`super.load()` 会用它创建 Bridge。
- 解析失败时 `config` 保持 `null`，Capacitor 回落到 assets 默认地址；同时记录日志。不能因为配置异常导致白屏。
- 目标地址已是归一化值；若历史数据损坏，`getEffectiveBaseUrl` 内部回落。
- `configureWebView` 中版本变更后的 `loadUrl(bridge.getAppUrl())` 自动使用新地址，无需改动。
- 废弃构造器 `CapConfig(AssetManager, JSONObject)` 不会传 `Context`，`deserializeConfig(null)` 会让 `webContentsDebuggingEnabled` 与 `loggingEnabled`（`LOG_BEHAVIOR_DEBUG`）在 debug 包也为 false。构造前按 `BuildConfig.DEBUG` 写入 `android.webContentsDebuggingEnabled` / `android.loggingBehavior`，或在 `super.load()` 后 debug 下补 `WebView.setWebContentsDebuggingEnabled(true)`。
- `android/package.json` 精确锁 `7.6.8`（lock 已是 7.6.8）；升级 Capacitor 时把 §8.4 的动态配置用例设为硬门禁。

### 4.3 原生插件 `ServerConfigPlugin`

```java
@CapacitorPlugin(name = "ServerConfig")
public class ServerConfigPlugin extends Plugin {

    @PluginMethod
    public void get(PluginCall call) {
        // serverBaseUrl / allowHttp / shellVersionCode / shellVersionName
    }

    @PluginMethod
    public void openPicker(PluginCall call) {
        Intent intent = new Intent(getActivity(), ServerPickerActivity.class);
        startActivityForResult(call, intent, "pickerResult");
    }

    @ActivityCallback
    private void pickerResult(PluginCall call, ActivityResult result) {
        boolean changed = result.getResultCode() == Activity.RESULT_OK
                && result.getData() != null
                && result.getData().getBooleanExtra(ServerPickerActivity.EXTRA_CHANGED, false);
        if (call != null) call.resolve(new JSObject().put("changed", changed));
        if (changed) {
            // 先让 JS 拿到结果，再重启；否则 WebView 销毁后 Promise 永远不落地
            getActivity().runOnUiThread(() ->
                    new Handler(Looper.getMainLooper()).postDelayed(this::restartApp, 200));
        }
    }

    private void restartApp() {
        Activity activity = getActivity();
        Intent intent = new Intent(activity, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        activity.startActivity(intent);
        activity.finish();
    }
}
```

- 只暴露 `get` / `openPicker`；不在 Web 侧提供 `set` / `probe`，所有写操作必须经过原生 picker 的用户确认。
- `get()` 不返回历史列表；历史由原生 picker 展示，减少远端读取面。
- 注册：`MainActivity.onCreate` 中 `registerPlugin(ServerConfigPlugin.class)`，位置与现有两个插件一致（`super.onCreate` 之前）。
- `ServerConfigPlugin` 只依赖 `ServerConfigStore`，不依赖 WebView 当前页面。

前端封装新增 `desktop/src/utils/android-server-config.ts`：

```ts
import { isAndroidCapacitor } from './capacitor'

export interface AndroidServerInfo {
  serverBaseUrl: string
  allowHttp: boolean
  shellVersionCode?: number
  shellVersionName?: string
}

interface ServerConfigPlugin {
  get(): Promise<AndroidServerInfo>
  openPicker(): Promise<{ changed: boolean }>
}

export function getAndroidServerConfigPlugin(): ServerConfigPlugin | null {
  if (!isAndroidCapacitor()) return null
  return (window as any).Capacitor?.Plugins?.ServerConfig ?? null
}
```

旧 APK 没有该插件时返回 `null`，所有入口隐藏，不影响现有行为。

### 4.4 原生 `ServerPickerActivity`

新增 `ServerPickerActivity.java` + `res/layout/activity_server_picker.xml`：

- 主题沿用 `AppTheme.NoActionBar`，自带一行顶栏：返回箭头 + 标题「服务器设置」。
- 表单：
  - 当前地址（预填 `ServerConfigStore.getEffectiveBaseUrl`）
  - 输入框，提示 `https://mao.example.com`，支持站点根 / `/api` / `/api/v1`（子路径拒绝）
  - 复选框「允许 HTTP（仅内网，传输可能被窃听）」
  - 「检测连通性」按钮 + 状态文本（idle / checking / ok / error）
  - 历史列表（最多 10 条）：点击填入输入框；右侧「删除」
  - 底部「保存并切换」主按钮 + 「取消」
- 交互：
  1. 输入变化后清除上一次探测结果。
  2. 「检测」：归一化 → 探测（§4.7）→ 展示 `API 可达（health）` / `站点可达（version.json）` / 具体错误。
  3. 「保存并切换」：归一化 → 若 `allowHttp` 且为 `http://`，弹确认框 → 探测（未通过则弹「仍要保存（不推荐）」二次确认）→ 写配置/历史 → `setResult(RESULT_OK, changed=true)` → `finish()`。
  4. 取消/返回：`setResult(RESULT_CANCELED)`，不写配置。
- `REDIRECT_ORIGIN`：只允许「使用该地址」保存最终地址；不允许保存输入地址（包括「仍要保存」路径）。否则 bridge 注入 origin 与页面实际 origin 不一致，插件必然失效（D19）。
- `allowHttp` 初始值按当前生效 URL 的 scheme 推导；HTTP 确认只对最终 scheme 为 `http` 的地址生效。
- 历史项点击只填表单，不自动保存；删除历史不影响当前已保存配置。
- HTTP 确认文案：`允许 HTTP 后，登录 token 与内容可能以明文传输。仅建议在可信内网使用。是否继续？`
- 探测失败文案区分：URL 非法 / DNS 失败 / 连接超时 / TLS 失败 / HTTP 状态码 / 不是 Mao 站点。
- 无调用方（从桌面快捷方式打开，`getCallingActivity() == null`）：保存成功后直接启动 `MainActivity`（`NEW_TASK | CLEAR_TASK`）；有调用方时只返回结果，由调用方重启。
- 旋转/进程重建：Activity 自行保存表单状态（`onSaveInstanceState`），避免输入丢失。

### 4.5 `MainActivity` 与入口

1. `load()` 覆写（§4.2）。
2. 加载遮罩（`MainActivity.java:225`）增加第二个按钮「服务器设置」，与「重新连接」一起在 8s 超时后显示：
   - 点击 `startActivityForResult(ServerPickerActivity)`；
   - 返回 `changed=true` 时调用 `restartApp()`（与插件相同的清任务栈重启）。
3. 插件注册（§4.3）。
4. 无其他逻辑改动；`onStart` 的 WebView 探测/自动 reload 在 picker 打开期间因 `onStop` 清空 Handler，不会误触发。

### 4.6 清单、快捷方式与 HTTP

`AndroidManifest.xml`：

- `<application android:usesCleartextTraffic="true" ...>`：允许 HTTP 站点与 HTTP 探测/OTA。
- 新增 `ServerPickerActivity`：

```xml
<activity
    android:name=".ServerPickerActivity"
    android:exported="true"
    android:excludeFromRecents="true"
    android:label="@string/server_settings"
    android:theme="@style/AppTheme.NoActionBar" />
```

- `MainActivity` 内增加静态快捷方式元数据：

```xml
<meta-data
    android:name="android.app.shortcuts"
    android:resource="@xml/shortcuts" />
```

`res/xml/shortcuts.xml`：

```xml
<shortcuts xmlns:android="http://schemas.android.com/apk/res/android">
  <shortcut
      android:shortcutId="server_settings"
      android:enabled="true"
      android:icon="@mipmap/ic_launcher"
      android:shortcutShortLabel="@string/server_settings"
      android:shortcutLongLabel="@string/server_settings_long">
    <intent
        android:action="android.intent.action.VIEW"
        android:targetPackage="cn.etarch.mao.app"
        android:targetClass="cn.etarch.mao.app.ServerPickerActivity" />
  </shortcut>
</shortcuts>
```

- `strings.xml` 新增 `server_settings`、`server_settings_long`。
- 快捷方式从 Android 7.1 起支持；低版本靠设置页/登录页/遮罩入口（设置页/登录页需站点已部署本次前端）。
- `usesCleartextTraffic` 是应用级开关，无法按用户输入的动态域名白名单。应用层仍只在用户勾选 `allowHttp` 后才接受**用户输入**的 `http://`；构建期默认地址按可信值放行（§5.1）；对外链仍走系统浏览器。残余风险见 §6。

### 4.7 站点探测

新增 `ServerProbe.java`（纯网络工具，后台线程调用）：

- 超时：连接 5s、读取 5s；跟随 301/302（最多 5 跳）；不携带 token/cookie；UA `MaoAndroid/<versionName>`。
- 探测顺序：
  1. `GET {base}/api/v1/health`：HTTP 2xx 且响应体包含 `"status"` 与 `"UP"`（或 `"code":0`）→ 通过，detail=`API 可达（health）`。
  2. `GET {base}/version.json`：HTTP 2xx 且 JSON 含非空 `version` → 通过，detail=`站点可达（version.json）`。
  3. `GET {base}/`：HTTP 2xx 且 HTML 包含 `<title>Mao` 或 `id="app"` → 通过，detail=`站点可达（首页）`。
- 失败返回结构化错误：`INVALID_URL` / `DNS` / `TIMEOUT` / `TLS` / `HTTP_<code>` / `NOT_MAO` / `REDIRECT_ORIGIN`。
- 响应体最多读取 64KB，读完关闭流；探测不修改任何配置。
- 重定向：记录最终 URL。若最终 origin（scheme + host + port）与输入 origin 不同：
  - 返回 `REDIRECT_ORIGIN`，附带 `finalBaseUrl`；
  - Picker 提示：`站点重定向到 https://...，请改用该地址`，并提供「使用该地址」按钮回填；
  - 不允许静默保存输入地址，否则 bridge 注入的 origin 与最终页面不一致，插件会失效。
- 探测失败默认阻止保存；用户可在二次确认后「仍要保存（不推荐）」。
- `REDIRECT_ORIGIN` 不允许保存输入地址；见 §4.4/D19。
- 探测通过不代表目标站部署了 P1+ 的同源 dist；旧 dist 可能仍把 API 指向别处。部署文档要求目标站先升级 dist，探测无法识别（D18）。
- 探测只接受站点根，不接受子路径（D16）。
- 自签名证书不做绕过；TLS 失败提示用户使用受信任证书。

### 4.8 构建默认地址与 OTA 清单

`android/android/app/build.gradle`：

```gradle
def maoDefaultServerUrl = project.findProperty('MAO_DEFAULT_SERVER_URL')
        ?: System.getenv('MAO_DEFAULT_SERVER_URL')
        ?: ''
...
defaultConfig {
    ...
    buildConfigField "String", "MAO_DEFAULT_SERVER_URL", "\"${maoDefaultServerUrl}\""
}
```

- 空字符串表示不覆盖，回落到 assets `capacitor.config.json` 的 `server.url`。
- `build-apk.sh` 增加可选参数/环境变量：
  - `--server-url <url>` 或 `MAO_DEFAULT_SERVER_URL` → `-PMAO_DEFAULT_SERVER_URL=...`；
  - `--version-code <n>`：手工指定 versionCode；构建前若目标 `RELEASES_DIR/android-latest.json` 存在且其 `versionCode >= n`，直接报错（D17）；
  - `MAO_PUBLIC_BASE_URL`（默认 `https://mao.etarch.cn`）用于生成 `android-latest.json` 的 `downloadUrl`；
  - 构建日志打印「默认服务器」与「发布基址」。
- `buildConfigField` 的字符串值要转义 `\` 与 `"`，避免 URL/环境变量里的特殊字符破坏 Groovy 字符串。
- `--dry-run` 仍会校验 keystore（脚本现状），文档不要写成完全无前置。
- manifest 的 `downloadUrl` 保持绝对地址（兼容旧 APK 直接 `new URL()`）；前端读取时若遇到相对地址，按清单 URL 解析：

```ts
const manifestUrl = androidReleaseManifestUrl()
const downloadUrl = new URL(manifest.downloadUrl, manifestUrl).href
```

- 私有站 OTA 口径（一期，D17）：
  - 私有站只托管**官方签名 APK**（可直接复制官方发布的 APK）和自己的 `android-latest.json`；不要求部署方持有 keystore，也不允许私有站自行构建 APK。
  - 官方团队给私有站出“默认地址为本站”的 APK 时，仍用 `MAO_DEFAULT_SERVER_URL` 构建，产物仍是官方签名；私有站只托管该产物。
  - 不同签名的 APK 无法覆盖安装；私有站 releases 目录为空时 `build-apk.sh` 的 versionCode 会从 1 开始，低于官方已安装版本，也不能安装——这两点写入文档。
  - `android-latest.json` 的 `downloadUrl` 保持绝对地址；`MAO_PUBLIC_BASE_URL` 用于官方团队给私有站生成清单。
  - `build-apk.sh` 增加可选 `--version-code <n>`：构建前若目标 `RELEASES_DIR/android-latest.json` 存在且其 `versionCode >= 指定值`，直接报错；官方发版也可用它手工指定。
  - 私有站没有 `uploads/releases/android-latest.json` 时保持 not-available 静默。
- 一期不支持私有站自建 APK；未来若支持，必须同一 keystore + 显式 versionCode 下限校验。
- 一期不实现 `package-default` / `disabled`；若站点没有 `uploads/releases/android-latest.json`，现有逻辑 `resp.ok === false` → `not-available`，静默不提示。

### 4.9 桌面前端同源化

新增 `desktop/src/utils/api-base.ts`：

```ts
function trimSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** 生产：跟随当前页面 origin（站点必须部署在根）；开发/显式覆盖：VITE_API_BASE_URL。 */
export function apiBaseUrl(): string {
  const env = (import.meta.env.VITE_API_BASE_URL || '').trim()
  if (env) return trimSlash(env)

  if (typeof window !== 'undefined') {
    const { protocol, origin } = window.location
    if ((protocol === 'http:' || protocol === 'https:') && origin) {
      return `${origin}/api/v1`
    }
  }
  return 'http://localhost:9080/api/v1'
}

export function wsBaseUrl(): string {
  const env = (import.meta.env.VITE_WS_BASE_URL || '').trim()
  if (env) return trimSlash(env)

  const api = apiBaseUrl()
  if (api.startsWith('/')) {
    const scheme = typeof window !== 'undefined' && window.location.protocol === 'https:' ? 'wss' : 'ws'
    const host = typeof window !== 'undefined' ? window.location.host : 'localhost:9080'
    return `${scheme}://${host}${api.replace(/\/api\/v1\/?$/, '/api')}`
  }
  return trimSlash(api.replace(/^http/, 'ws').replace(/\/api\/v1\/?$/, '/api'))
}

/** 站点根：用于 uploads/releases 等非 /api 资源。 */
export function siteBaseUrl(): string {
  return trimSlash(apiBaseUrl().replace(/\/api\/v1\/?$/, ''))
}

/** 安卓壳 OTA 清单：跟随当前站点。 */
export function androidReleaseManifestUrl(): string {
  return `${siteBaseUrl()}/uploads/releases/android-latest.json`
}
```

行为：

- `VITE_API_BASE_URL` 仍可作为显式覆盖（开发、特殊部署）；生产 `.env.production` 删除该值后自动同源。构建环境不要注入该变量；只有 split-domain/子路径特殊部署才显式覆盖，避免把官方域重新烘焙进通用 dist。
- `VITE_WS_BASE_URL` 仍可作为显式覆盖。
- Node 环境（非 jsdom）没有 `window`，回落 `localhost:9080`，与现有测试预期一致；jsdom 用例见下。
- `file:` 等非 http(s) 页面不拼同源，回落 localhost；生产 Electron 不会在 `file://` 跑会话页（未配置服务器时是本地选择页）。
- **同源前置（D18）**：站点必须在同一 origin 提供 `/api/v1` 与 `/uploads`；split-domain 私有站必须继续用 `VITE_API_BASE_URL` 显式覆盖构建，否则 API 会打到 SPA origin（通常没有反代 `/api`）。
- **目标站版本**：切换功能要求目标站部署 P1+ 的 `desktop/dist`；旧 dist 编译期烘焙了旧 API 域，新壳切过去后仍可能串站，探测无法识别。
- **子路径（D16）**：`apiBaseUrl()` 固定 `location.origin + /api/v1`；站点必须部署在根；归一化会拒绝 `/mao`。
- **HTTP 非安全上下文（D20）**：`crypto.subtle` 不可用，`git-manager.ts` 的 `gitDiscardDigest` 需纯 JS SHA-256 兜底（内置小实现或加 `@noble/hashes` 这类纯 JS 依赖，避免 Node-only 依赖）；`ShareDialog.vue`、`WelcomeView.vue` 的剪贴板**写**操作统一到 `utils/clipboard.ts` 的 `copyText`/`copyWithFallback`；`TerminalPanel.vue` 的写操作同样兜底，读操作保留现有手动粘贴兜底。
- **jsdom 单测**：`desktop/src/utils/markdownImages.dom.test.ts` 与 `desktop/src/composables/markdown-image.dom.test.ts` 目前断言 `http://localhost:9080/api/v1`；同源后 jsdom 会得到 `http://localhost:3000/api/v1`，必须改为 stub `VITE_API_BASE_URL` 或断言 `location.origin`，否则 CI 红。
- `siteBaseUrl()` 用于 OTA 清单、上传路径等；API 仍在 origin 根 `/api/v1`（与当前单域 Nginx 一致）。
- 子路径（如 `https://host/mao`）一期不支持：`apiBaseUrl()` 只按 origin 推导，归一化会拒绝；站点必须部署在根（D16）。

调用点替换（全部改为函数调用，模块级常量也保留在模块加载时求值）：

| 文件 | 改法 |
|---|---|
| `desktop/src/api/index.ts:18` | `baseURL: apiBaseUrl()` |
| `desktop/src/api/index.ts:37` | `const baseURL = apiBaseUrl()` |
| `desktop/src/composables/useStreamWS.ts:290` | `const wsBase = wsBaseUrl()` |
| `desktop/src/composables/useStreamWS.ts:1345` | `const apiBase = apiBaseUrl()` |
| `desktop/src/composables/useTerminalWS.ts:76-78` | `const wsBase = wsBaseUrl()` |
| `desktop/src/composables/workspace-file-provider.ts:511` | `const API_BASE = apiBaseUrl()` |
| `desktop/src/composables/workspace-file-write.ts:6` | 同上 |
| `desktop/src/utils/deliveryUrl.ts:4` | 同上 |
| `desktop/src/utils/markdownImages.ts:14` | 同上 |
| `desktop/src/utils/sessionShare.ts:4` | 导入时别名为 `resolveApiBaseUrl`（该文件自身也导出 `apiBaseUrl`），`return resolveApiBaseUrl()` |
| `desktop/src/utils/avatar.ts:5` | `const apiBase = apiBaseUrl()` |
| `desktop/src/views/settings/DingtalkBindRedirect.vue:15` | `const base = apiBaseUrl()`（补 import） |
| `desktop/src/composables/useVersionCheck.ts:11-12` | 清单改为 `androidReleaseManifestUrl()` |
| `desktop/src/composables/useVersionCheck.ts:333` | `_androidDownloadUrl = new URL(manifest.downloadUrl, manifestUrl).href`（`manifestUrl` 不带 `_t`） |
| `desktop/src/utils/git-manager.ts` | 改：`gitDiscardDigest` 增加纯 JS SHA-256 兜底 |
| `desktop/src/components/task/ShareDialog.vue` | 改：复制分享链接走 `copyText` |
| `desktop/src/views/welcome/WelcomeView.vue` | 改：复制部署命令走 `copyText` |
| `desktop/src/components/terminal/TerminalPanel.vue` | 改：剪贴板写兜底；读保留手动粘贴兜底 |
| `desktop/src/utils/markdownImages.dom.test.ts` | 改：stub env / 同源断言 |
| `desktop/src/composables/markdown-image.dom.test.ts` | 改：stub env / 同源断言 |

`desktop/.env.production`：

```bash
# 生产环境：不设置 VITE_API_BASE_URL，运行时按当前页面 origin 解析。
# Web / Electron / 安卓远程 SPA 都自动跟随所连接的站点。
```

`.env.development` / `.env.development.local` 保持不变（本地开发仍显式指向 9080/9081）。

不改：

- `admin`（已经是 `/api/v1` 相对路径）。
- Electron 主进程 `getApiBaseUrl()`（已按配置站点推导，用于 skill-sync 等主进程请求）。
- 后端 CORS（同源请求不需要）。

### 4.10 安卓端 UI 入口

1. 设置页导航：`SettingsView.vue` 的 `showServerNav` 从 `isElectronClient()` 改为 `isElectronClient() || !!getAndroidServerConfigPlugin()`。注意不能只判断 `isAndroidCapacitor()`：老 APK 没有 `ServerConfig` 插件，导航必须按插件能力显示，否则会出现点不动的入口。
2. `ServerSettingsView.vue` 增加 `isAndroid` 分支：
   - 插件存在时显示只读「当前站点：`window.location.origin`」、插件返回的 `allowHttp`、壳版本；
   - 主按钮「打开服务器设置」→ `getAndroidServerConfigPlugin()?.openPicker()`；
   - 插件为 `null`（老壳直接访问 `/settings/server`）时显示「当前安卓壳版本不支持切换服务器，请升级 App」，不渲染按钮；
   - 不展示 Electron 的编辑表单、更新源、环境变量锁定提示；
   - 浏览器（非 Electron 非安卓）保持现有只读提示。
   - `ServerSettingsView.vue:110` 的 `isElectron` 浏览器提示分支要放在新增的 Android 分支之后，避免安卓先显示「当前为浏览器访问」。
3. 登录页 `LoginView.vue` 增加安卓专用入口（表单下方或页脚）：
   - 文案「服务器设置」；
   - 仅当 `getAndroidServerConfigPlugin()` 非空时显示；
   - 点击 `openPicker()`；切换成功后原生会重启，不需要 JS 再跳转。
4. 加载遮罩「服务器设置」按钮（§4.5）。
5. 桌面长按快捷方式（§4.6）。

原生 picker 与桌面快捷方式不依赖远端页面，始终可用；设置页与登录页入口需要该站点已部署本次前端。旧版远端 SPA 没有这些入口时，用户仍可通过快捷方式/加载失败遮罩切换。

## 5. 数据与行为契约

### 5.1 生效地址

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `SharedPreferences.server_base_url` | 用户保存过；归一化失败则忽略 |
| 2 | `BuildConfig.MAO_DEFAULT_SERVER_URL` | 私有分发的编译期默认；空则不生效 |
| 3 | `assets/capacitor.config.json` 的 `server.url` | 官方默认 `https://mao.etarch.cn` |
| 4 | 常量兜底 | `https://mao.etarch.cn` |

- BuildConfig/assets 的构建期默认地址按可信值放行，不受 `allow_http` 约束；`allow_http` 只约束用户在 picker 里的输入。
- `ServerConfigPlugin.get()` 的 `allowHttp` 按生效 URL 的 scheme 推导，而非只看 prefs；避免 HTTP 默认站点显示「未允许 HTTP」。

### 5.2 切换状态机

```text
idle
  └─ 用户输入/选择历史 → editing
editing
  ├─ 检测 → probing → ok / error → editing
  └─ 保存 → [HTTP 确认] → probing → ok → saving → restarting
                                   └─ error → 二次确认 → saving
saving
  └─ 写 prefs 失败 → editing（展示错误）
restarting
  └─ MainActivity 新实例按新配置加载
```

### 5.3 事件契约

| 事件 | 行为 |
|---|---|
| 冷启动 | 读生效地址 → 构造 CapConfig → 加载目标站 |
| 从设置/登录页打开 picker | 原生 Activity 覆盖在当前页上；取消不改配置 |
| 保存成功 | `commit()` 写配置 + 历史；返回 `changed=true`；调用方清任务栈重启 |
| 保存相同地址 | 不重启，返回 `changed=false` |
| 探测失败后「仍要保存」 | 写配置并重启；跨 origin 重定向除外（只允许保存最终地址） |
| HTTP 站点 | 需勾选 allowHttp + 确认；清单/探测/OTA 都允许 cleartext；`crypto.subtle`/剪贴板按 §4.9 兜底 |
| 跨 origin 重定向 | 只允许保存最终地址，不允许保存输入地址 |
| 切换站点 | 旧 origin localStorage 保留；新 origin 独立登录；不主动清缓存 |
| 切回旧站 | 仍登录（token 在旧 origin localStorage）；无需重新登录 |
| OTA 检查 | 清单位于当前站点 `/uploads/releases/android-latest.json` |
| 页面 `version.json` 轮询 | 仍相对当前页面 origin，不变 |
| WebView 版本变更 | `configureWebView` 的 `loadUrl(bridge.getAppUrl())` 使用新地址 |
| 进程被杀后重启 | SharedPreferences 生效；无需重新输入 |
| 清除应用数据 | 配置与 WebView 数据一起清空，回到构建默认地址 |

### 5.4 origin 隔离

| 数据 | 隔离方式 | 切站结果 |
|---|---|---|
| access/refresh token | localStorage，按 origin | 各站独立；旧站保留 |
| Pinia 内存态 | 页面重启后重建 | 清空后按新站拉取 |
| IndexedDB / 草稿 | 按 origin | 各站独立 |
| Cookie | 按 origin | 各站独立 |
| HTTP 缓存 | 按 URL 键，跨 origin 不命中 | 新站重新拉取 |
| 主题 / 通知偏好 | localStorage，按 origin | 新站默认值 |
| 原生 SharedPreferences | 全局一份 | 只存服务器配置 |

## 6. 安全

1. **默认 HTTPS**；用户输入的 `http://` 必须显式勾选 `allowHttp` 并二次确认；构建期默认地址按可信值放行（§5.1）。
2. `usesCleartextTraffic="true"` 是应用级开关，无法只对用户输入的动态域名放行；残余风险是 WebView 内任何 http 资源都可加载。通过「用户输入的 http 站点需要勾选」「构建期默认按可信值」「外链走系统浏览器」「Mixed Content 默认阻止」控制面，文档中明确告知内网使用风险。
3. 地址归一化拒绝：非 http(s)、带账号密码、无 host、query/fragment；不自动跟随跨 origin 重定向。
4. 探测不携带 token/cookie，不修改配置；探测请求由原生发起。
5. 切换不主动清旧 token：token 存在旧 origin 的 localStorage，新 origin 的 JS 读不到；axios 也按同源发请求，不存在把旧 token 发到新站。
6. 插件只暴露 `get` / `openPicker`；远端页面不能静默改服务器。`openPicker` 打开的是原生 UI，保存必须用户点击。
7. `ServerPickerActivity` 从快捷方式导出（`exported=true`），但没有自动保存/自动跳转；任何应用最多把设置页拉到前台。不暴露配置内容给外部 Intent。
8. 自签名证书不绕过；TLS 错误明确提示，不允许「忽略证书错误」。
9. 防钓鱼：保存前探测并显示最终 origin；跨 origin 重定向必须用户确认。
10. **HTTP 非安全上下文**：HTTP 站上 `crypto.subtle`、`navigator.clipboard` 等不可用；一期补 `gitDiscardDigest` 纯 JS SHA-256 与剪贴板**写**兜底，读操作保留手动粘贴；无法兜底的入口明确提示。
11. **跨 origin 重定向**：只允许保存最终地址，不允许保存输入地址；bridge 只注入输入 origin。
12. **私有站 OTA**：只托管官方签名 APK；不允许私有站自建不同签名 APK；`build-apk.sh --version-code` 做 versionCode 下限校验。cleartext OTA 可被 MITM，但 Android 安装器会校验签名；仍建议私有站用 HTTPS。

## 7. 兼容与迁移

- **存量官方 APK**：没有 `mao_server_config`，生效地址回落到 assets 的 `https://mao.etarch.cn`，origin 不变，现有登录/localStorage 不受影响。
- **存量私有 APK**（如果改过 `capacitor.config.json` 再打包）：分两种情况：
  - 新 APK 由官方团队按原方式打包（assets 仍是自定义地址）或构建时传 `MAO_DEFAULT_SERVER_URL`：没有保存值时回落到自定义地址，行为不变；
  - 直接安装通用官方 APK：assets 默认是官方地址，没有 prefs，首次启动会连官方站；用户需用登录页/快捷方式/遮罩切换一次。私有分发应由官方团队构建时传 `MAO_DEFAULT_SERVER_URL`，或接受这次一次性切换。
  - 旧私有 APK 与新 APK 必须使用同一签名才能覆盖安装；签名不同只能卸载重装（会清掉 WebView 登录态）。
- **用户保存过地址后**：prefs 优先于新的 assets/BuildConfig 默认；升级 APK 不会强制改回官方地址。需要强制重置时清除应用数据。
- **前端先部署**：旧 APK 仍按官方地址加载；新前端同源化后，旧 APK 访问官方站也正常。新 APK 上线后即可切换。
- **同源前置**：私有站必须在同一 origin 提供 `/api/v1` 与 `/uploads`；split-domain 必须用 `VITE_API_BASE_URL` 显式覆盖构建；目标站必须部署 P1+ 的 `desktop/dist`。否则旧 APK/Electron/Web 加载新前端后可能串站。
- **子路径**：一期不支持 `https://host/mao`；归一化会拒绝并提示。
- **私有站 OTA**：只托管官方签名 APK + 私有清单；不同签名/低 versionCode 的包无法安装，不在一期支持范围。
- **旧 APK + 新前端（关键兼容路径，以下以官方站或同源私有站为前提）**：
  - 旧壳继续加载官方站，origin 不变；新前端的同源 API/WS 解析结果与旧的绝对地址一致，登录、会话、OTA 不受影响；
  - 新前端的安卓切换入口全部按 `ServerConfig` 插件是否存在做能力检测；老壳没有该插件时，设置导航、登录页入口、设置页按钮均隐藏或显示「请升级 App」，不会出现点不动的按钮或崩溃；
  - 老壳唯一缺少的是「运行时切换服务器/HTTP/快捷方式/遮罩切换按钮」，这些必须安装新 APK 后才能用；老壳可以一直正常使用，不强制升级（OTA 清单 `minVersionCode` 保持 0 即可）；
  - 旧私有 APK 加载同源私有站时，新前端同源化会把 API/WS 指到私有站（如果此前该站前端是用官方 `VITE_API_BASE_URL` 构建的，这是修正而非回归）；split-domain 私有站必须保留 `VITE_API_BASE_URL` 覆盖构建，否则会回归。旧私有壳仍不能切换站点，需要部署方升级到新壳。
- **Electron**：前端同源化后，Electron 加载任意同源站点的 SPA 都用该站点 API；同源私有站不再需要把 `VITE_API_BASE_URL` 改成本域再构建。split-domain 站点仍需显式覆盖。已有子路径 Electron 配置必须保留 `VITE_API_BASE_URL` 覆盖（或迁移到根），否则 P1 后渲染层 API 会打到 origin 根，与主进程 `deriveApiBase` 不一致。这是行为改善，不改变 Electron 的切换逻辑。
- **Web**：同源站点行为不变；split-domain 站点必须保留 `VITE_API_BASE_URL` 覆盖。
- **admin**：不涉及。
- **回滚**：前端可回滚到旧的绝对 env 构建；APK 无法降级安装（Android 限制），需重新安装旧包或提升 versionCode 覆盖。文档写明。

## 8. 测试计划

### 8.1 安卓 Java 单测（`android/android/app/src/test/java/...`）

- `ServerUrlNormalizerTest`：§4.1 表格全部用例；http 允许/拒绝；非法协议；账号密码；query/fragment；子路径拒绝；端口；IPv6。
- `ServerHistoryTest`：MRU 置顶、去重、上限 10、损坏 JSON 容错。
- `ServerProbe` 的响应判定抽成纯函数（`isHealthBody` / `isVersionBody`）做单测；网络部分靠手工。
- 运行：`cd android/android && ./gradlew :app:testDebugUnitTest`（需 Android SDK；CI 目前不跑 Android，作为本地门禁）。
- `android/android/app/src/test` 目前不存在，需新建；`ServerHistoryTest`/`ServerProbe` 若用 `org.json`，加 `testImplementation 'org.json:json:<version>'` 或把解析抽成纯字符串逻辑；`testOptions { unitTests.returnDefaultValues = true }`。
- `minSdk 24`：不要用 `java.time`（API 26+，未开 core library desugaring）；ISO 时间用 `SimpleDateFormat` + UTC 或 epoch millis。
- `getEffectiveBaseUrl` 优先级抽纯函数测试：saved > BuildConfig > assets > 常量；构建期 HTTP 默认值放行；损坏 prefs 回落。
- `ServerUrlNormalizerTest` 增加：子路径拒绝、scheme/host 大小写、尾斜杠、账号密码、query/fragment、IPv6、端口。

### 8.2 前端 Vitest

- 新增 `desktop/src/utils/api-base.test.ts`：
  - env 覆盖优先；
  - 无 env 时返回 `location.origin + /api/v1`；
  - `wsBaseUrl()` 的 http→ws、https→wss、相对路径、尾斜杠；
  - Node 无 window 回落 localhost；
  - `siteBaseUrl()` 去掉 `/api/v1`；
  - `androidReleaseManifestUrl()` 指向当前站点 `/uploads/releases/android-latest.json`。
- 新增 `desktop/src/utils/android-server-config.test.ts`：非安卓返回 null；插件缺失返回 null；`get/openPicker` 透传。
- 回归 `desktop/src/utils/avatar.test.ts`（env 覆盖仍生效）。
- jsdom 回归：`desktop/src/utils/markdownImages.dom.test.ts`、`desktop/src/composables/markdown-image.dom.test.ts` 改为 stub `VITE_API_BASE_URL` 或断言 `location.origin`。
- `git-manager.test.ts` 增加 `crypto.subtle` 不可用时的纯 JS SHA-256 兜底用例；剪贴板相关测试补 HTTP 兜底。
- `api-base.test.ts` 增加：子路径 env 保留路径（仅供显式覆盖）、尾斜杠、jsdom 环境、Node 无 window 回落。
- `useVersionCheck` 增加相对 `downloadUrl` 解析用例（用不带 `_t` 的清单 URL 作 base）。

### 8.3 构建

- `cd desktop && npm run build`（vue-tsc + vite）。
- `cd admin && npm run build`（未改动，CI 回归）。
- `cd backend-ts && npm run build`（未改动，CI 回归）。
- `cd android && bash build-apk.sh --dry-run`（手工，需 JDK 21 / SDK / keystore）。

### 8.4 真机/模拟器手工矩阵

| # | 场景 | 期望 |
|---|---|---|
| 1 | 全新安装，官方默认 | 直接加载官方站；登录正常；插件可用 |
| 2 | 设置页切到私有 HTTPS | 探测通过 → 重启 → 加载私有站；Network 面板 API/WS 指向私有站 |
| 3 | 登录页切到私有 HTTP（内网） | 勾选 allowHttp + 确认 → 加载 → API/WS/OTA 均走 http |
| 4 | 切回旧站 | 旧站登录仍在；草稿/偏好仍在 |
| 5 | 地址写错 / 不可达 | 探测失败提示；不写配置；可重试 |
| 6 | http 站点重定向到 https | 提示最终地址；确认后使用 https；插件正常 |
| 7 | 首屏 8s 失败 | 遮罩出现「重新连接」「服务器设置」；切换后恢复 |
| 8 | 长按桌面图标 → 服务器设置 | 直接打开 picker；保存后加载新站 |
| 9 | 私有站无 releases 目录 | OTA 静默 `not-available`，不弹错 |
| 10 | 私有站有更高 versionCode、官方签名 APK | 提示更新，下载安装成功 |
| 11 | 旧版远端 SPA（无设置页/登录页入口） | 快捷方式/加载失败遮罩仍可切换 |
| 12 | 飞行模式启动 | 显示遮罩与重试/设置入口；不崩溃 |
| 13 | 旧 APK + 新前端（未升级壳） | 设置/登录页不出现切换入口；直接访问 `/settings/server` 显示升级提示；登录/OTA 正常 |
| 14 | HTTP 站复制分享链接 / 终端粘贴 / Git「撤销全部」 | 兜底生效，不静默失败 |
| 15 | 输入 `https://host/mao` 子路径 | 归一化拒绝并提示「仅支持站点根」 |
| 16 | 探测到跨 origin 重定向后点「仍要保存」 | 不允许保存输入地址；只能使用最终地址 |
| 17 | 私有站托管官方签名 APK + 私有清单 | 更新提示与安装成功；不同签名/低 versionCode 安装失败并提示 |
| 18 | split-domain 私有站（SPA/API 不同源） | 文档要求用 `VITE_API_BASE_URL` 覆盖构建；不承诺通用 dist 可用 |

### 8.5 不做

- 不新增 Playwright 安卓 E2E；安卓壳仍以手工矩阵为准。
- 不覆盖自签名证书、企业 MDM 代理等环境。

## 9. 实施阶段

| 阶段 | 交付 | 验收 |
|---|---|---|
| P1 前端同源化 | `api-base.ts`、调用点替换、`.env.production` 清理、OTA 清单同源、HTTP 非安全上下文兜底、单测（含 jsdom 回归） | Web/Electron 构建通过；浏览器 Network 请求同源；Electron 切换私有站 API 正确；jsdom 单测全绿 |
| P2 动态配置 | `ServerConfigStore`、`ServerUrlNormalizer`、`MainActivity.load()` 覆写、`build.gradle` 默认地址 | 手工改 prefs/编译默认后启动加载对应站点；官方默认行为不变 |
| P3 切换 UI | `ServerProbe`、`ServerPickerActivity`、`ServerConfigPlugin`、设置/登录/遮罩/快捷方式、cleartext | 真机矩阵 1–8、11–12、14–17 通过 |
| P4 发布 | `build-apk.sh` 参数（`--server-url`、`--version-code`、`MAO_PUBLIC_BASE_URL`）、官方签名 APK 口径、文档、changelog、回归 | 新 APK 可切多站；OTA 跟随站点；私有站托管官方签名 APK 可安装；文档同步 |

P1 可独立部署（同源站点不影响现有 APK；split-domain 站点需按 §7 保留 `VITE_API_BASE_URL` 覆盖）；P2–P3 必须在同一个 APK 版本发布。

## 10. 改动文件清单

| 文件 | 动作 |
|---|---|
| `android/android/app/src/main/java/cn/etarch/mao/app/ServerConfigStore.java` | 新增：SharedPreferences、历史、生效地址 |
| `android/android/app/src/main/java/cn/etarch/mao/app/ServerUrlNormalizer.java` | 新增：归一化纯函数 |
| `android/android/app/src/main/java/cn/etarch/mao/app/ServerProbe.java` | 新增：health/version/首页探测、重定向检测 |
| `android/android/app/src/main/java/cn/etarch/mao/app/ServerConfigPlugin.java` | 新增：`get` / `openPicker` |
| `android/android/app/src/main/java/cn/etarch/mao/app/ServerPickerActivity.java` | 新增：原生设置页 |
| `android/android/app/src/main/res/layout/activity_server_picker.xml` | 新增：设置页布局 |
| `android/android/app/src/main/res/xml/shortcuts.xml` | 新增：桌面长按快捷方式 |
| `android/android/app/src/main/res/values/strings.xml` | 新增：快捷方式/设置页文案 |
| `android/android/app/src/main/java/cn/etarch/mao/app/MainActivity.java` | 改：`load()` 覆写、插件注册、遮罩「服务器设置」按钮、重启 |
| `android/android/app/src/main/AndroidManifest.xml` | 改：`usesCleartextTraffic`、`ServerPickerActivity`、shortcuts meta-data |
| `android/android/app/build.gradle` | 改：`MAO_DEFAULT_SERVER_URL` BuildConfig（`buildConfig true` 已存在）、`testOptions`（如需要）、`buildConfigField` 转义 |
| `android/build-apk.sh` | 改：`--server-url`/`MAO_DEFAULT_SERVER_URL`、`--version-code`、`MAO_PUBLIC_BASE_URL`、versionCode 下限校验、日志 |
| `android/android/app/src/test/java/cn/etarch/mao/app/ServerUrlNormalizerTest.java` | 新增 |
| `android/android/app/src/test/java/cn/etarch/mao/app/ServerHistoryTest.java` | 新增（如 Store 可拆纯逻辑） |
| `android/android/app/src/test/...` | 新建测试源集；`org.json` 测试依赖按 §8.1 |
| `desktop/src/utils/api-base.ts` | 新增 |
| `desktop/src/utils/api-base.test.ts` | 新增 |
| `desktop/src/utils/android-server-config.ts` | 新增 |
| `desktop/src/utils/android-server-config.test.ts` | 新增 |
| `desktop/src/api/index.ts` | 改：`apiBaseUrl()` |
| `desktop/src/composables/useStreamWS.ts` | 改：`wsBaseUrl()` / `apiBaseUrl()` |
| `desktop/src/composables/useTerminalWS.ts` | 改：`wsBaseUrl()` |
| `desktop/src/composables/workspace-file-provider.ts` | 改：`apiBaseUrl()` |
| `desktop/src/composables/workspace-file-write.ts` | 改：`apiBaseUrl()` |
| `desktop/src/utils/deliveryUrl.ts` | 改：`apiBaseUrl()` |
| `desktop/src/utils/markdownImages.ts` | 改：`apiBaseUrl()` |
| `desktop/src/utils/sessionShare.ts` | 改：`apiBaseUrl()` |
| `desktop/src/utils/avatar.ts` | 改：`apiBaseUrl()` |
| `desktop/src/views/settings/DingtalkBindRedirect.vue` | 改：`apiBaseUrl()` |
| `desktop/src/composables/useVersionCheck.ts` | 改：清单同源、downloadUrl 解析 |
| `desktop/.env.production` | 改：移除写死 API 地址 |
| `desktop/src/views/settings/SettingsView.vue` | 改：安卓显示「服务器」导航 |
| `desktop/src/views/settings/ServerSettingsView.vue` | 改：安卓只读 + 打开 picker |
| `desktop/src/views/auth/LoginView.vue` | 改：安卓「服务器设置」入口 |
| `desktop/src/utils/git-manager.ts` | 改：`gitDiscardDigest` 纯 JS SHA-256 兜底 |
| `desktop/src/components/task/ShareDialog.vue` | 改：复制分享链接走 `copyText` |
| `desktop/src/views/welcome/WelcomeView.vue` | 改：复制部署命令走 `copyText` |
| `desktop/src/components/terminal/TerminalPanel.vue` | 改：剪贴板写兜底；读保留手动粘贴兜底 |
| `desktop/src/utils/markdownImages.dom.test.ts` | 改：同源断言 / stub env |
| `desktop/src/composables/markdown-image.dom.test.ts` | 改：同源断言 / stub env |

不改：`backend-ts/`、`admin/`、`desktop/electron/`、`android/capacitor.config.json`（保留官方默认）。

## 11. 文档与发版

实现时按仓库规则补：

- `changelog/unreleased/2026-11-27-android-server-switch.md`：
  - `### 安卓原生`：可切换服务器、HTTP 支持、快捷方式、OTA 跟随站点；子路径限制与私有站 OTA 口径；
  - `### 前端（桌面 / Web / 安卓）`：API/WS 同源化，切换站点后请求跟随当前站；HTTP 下 `crypto.subtle`/剪贴板兜底；
  - 不写版本号。
- `skills/mao-cli/reference/android.md`：
  - 「服务器与站点」小节：运行时切换、默认地址、HTTP 风险与能力降级、一个通用 APK；
  - 子路径不支持；split-domain 必须用 `VITE_API_BASE_URL` 覆盖；
  - 构建参数 `--server-url` / `--version-code` / `MAO_PUBLIC_BASE_URL`；
  - 私有站 OTA 只托管官方签名 APK + 私有清单；不同签名/低 versionCode 不能安装。
- `skills/mao-cli/reference/electron.md`：
  - 补充「前端 API/WS 已同源化，同源私有站无需按域名改 `.env.production` 再构建；split-domain 仍需显式覆盖」。
- `skills/mao-cli/reference/deploy.md`：
  - 单域 Nginx 下 `/api`、`/uploads` 路径不变；
  - 同源前置：站点必须同 origin 提供 `/api/v1` 与 `/uploads`；split-domain 必须用 `VITE_API_BASE_URL` 覆盖构建；
  - 子路径不支持；
  - 私有站 OTA 只托管官方签名 APK + 私有清单；不同签名/低 versionCode 不能安装。
- `docs/guides/single-domain-nginx-migration.md`：补一句「多服务器/私有站必须同源提供 API 与 uploads」。
- `README.md` / `DEPLOY.md`：如仍描述「安卓地址打包时写死」，同步改为运行时可配；补同源前置与私有站 OTA 口径。
- 已实现：本文状态已改为「已实现」，当前链 `changelog/unreleased/2026-11-27-android-server-switch.md`；发版后补链对应 CHANGELOG 版本。

## 12. 风险与开放问题

| 风险 | 影响 | 缓解 |
|---|---|---|
| Capacitor 升级破坏 `CapConfig` 扩展点 | 壳无法加载自定义地址 | 精确锁 7.6.8；升级时跑动态配置真机用例；必要时改为 fork `BridgeActivity` 或等待官方 API |
| 跨 origin 重定向 | bridge 注入失败，插件不可用 | 探测到最终 origin 与输入不同时只允许保存最终地址，不允许保存输入地址（D19） |
| HTTP 明文 | token/内容被窃听 | 默认 HTTPS；勾选 + 二次确认；文档标注仅内网 |
| `usesCleartextTraffic=true` 全局放开 | 任意 http 资源可加载 | 应用层只允许用户显式选择或构建期默认的 http 站点；外链走浏览器；不引入商店分发 |
| OTA 签名/versionCode 不一致 | 私有站 APK 无法覆盖安装 | 一期只托管官方签名 APK；不同签名/低 versionCode 不在一期支持范围（D17） |
| 私有站未部署前端/版本过旧 | 页面打不开或缺设置入口 | 快捷方式/遮罩始终可切；探测提示 |
| 探测假阴性（health 被反代屏蔽） | 无法保存 | 失败后提供「仍要保存（不推荐）」二次确认 |
| 各站前端版本不一致 | UI/能力差异 | 接受；壳与 SPA 解耦是现有模型 |
| 旧壳加载新前端 | 安卓切换入口不可用或报错 | 所有安卓入口按 `ServerConfig` 插件能力检测；老壳隐藏入口，设置页直连时显示升级提示 |
| 主题/偏好不跨站 | 切站后主题重置 | 已知差异；后续可做原生镜像，非本期 |
| Android 7.1 以下无快捷方式 | 少一个入口 | 设置/登录/遮罩三个入口兜底 |
| 旧 APK 无法降级 | 回滚困难 | 前端可回滚；APK 通过更高 versionCode 修复，不做降级承诺 |
| 子路径站点 | 地址无法保存 | 一期明确不支持；归一化拒绝并提示（D16） |
| HTTP 非安全上下文 | `crypto.subtle`/剪贴板不可用 | 补纯 JS SHA-256、剪贴板写兜底；无法兜底的入口提示（D20） |
| split-domain 私有站 / 旧 dist | API 串站 | 文档要求同源 + P1+ dist；split-domain 用 `VITE_API_BASE_URL` 覆盖（D18） |
| Electron 既有子路径配置 | P1 后渲染层 API 与主进程派生规则不一致 | 保留 `VITE_API_BASE_URL` 覆盖或迁移到根；Android picker 拒绝子路径（D16） |
| 私有站自建 APK | 签名/versionCode 不一致装不上 | 一期只托管官方签名 APK；官方发版用 `--version-code` 做下限校验（D17） |
| jsdom 单测 | CI 红 | 更新 stub/断言（§8.2） |
| `CapConfig` 废弃构造器/内部字段 | Capacitor 升级破坏 | 精确锁 7.6.8；升级回归（§4.2） |

评审已确认（2026-11-27）：

1. 子路径：一期不支持，只接受站点根（D16）。
2. HTTP 能力：补齐 `gitDiscardDigest` 纯 JS SHA-256 与剪贴板写兜底（D20）。
3. 私有站 OTA：只托管官方签名 APK + 私有清单；不允许私有站自建（D17）。
4. split-domain/旧 dist：文档写清同源前置；split-domain 用 `VITE_API_BASE_URL` 覆盖；目标站必须先升级 P1+ dist（D18）。
5. 跨 origin 重定向：只允许保存最终地址（D19）。

仍开放（按推荐默认）：

1. 是否需要在原生 picker 里提供 `package-default` / `disabled` 更新源选项？推荐一期不做，固定 follow-site。
2. 探测失败后的「仍要保存」是否需要管理员/企业策略关闭？推荐一期保留，文案标红。
3. 是否需要把主题偏好按服务器同步？推荐不做。

## 13. 结论

采用「安卓壳可配置站点根 + 远程 SPA + 前端同源 API」：

1. 壳层通过 `ServerConfigStore` + 覆写 `BridgeActivity.load()` 动态构造 `CapConfig`，解决 Capacitor `server.url` 只能在 Bridge 创建时生效、bridge JS 只注入 `appUrl` origin 的硬约束；
2. 前端 API/WS/OTA 改为同源，同源私有部署不再依赖 `VITE_API_BASE_URL` 按域名构建，切换后不会串站；split-domain 仍需显式覆盖；
3. 原生 `ServerPickerActivity` 作为唯一切换 UI，配合设置页、登录页、加载失败遮罩、桌面快捷方式四个入口，首屏失败也能改地址；
4. 登录/草稿/缓存按 origin 隔离，切回旧站保留登录；HTTP 由用户显式开启并承担风险；HTTP 下 `crypto.subtle`/剪贴板按 §4.9 兜底；
5. 一期不做多 Profile、更新源策略、主题跨站同步、子路径、私有站自建 APK，保持范围可控；
6. 同源是部署前置：split-domain 私有站用 `VITE_API_BASE_URL` 覆盖构建，目标站先升级 P1+ dist；私有站 OTA 只托管官方签名 APK。本方案已合并 2026-11-27 评审补充（D16–D20、§8 测试与 §11 文档）。