# 桌面客户端：登录弹窗改为独立登录页

> 状态：方案待评审
> 版本：v0.1 | 日期：2026-08-24
> 范围：`desktop/` 共用前端（Web / Electron 远程 SPA / 安卓 Capacitor 远程加载）
> 不做：后端 API、管理后台、mao-agent / mao-cli、安卓原生壳、Electron 主进程打包

---

## 1. 背景与目标

### 1.1 现状

客户端登录是 `el-dialog` 盖在主布局上：

1. `Layout.vue` 照常挂载顶栏、任务页、终端抽屉等整套壳。
2. `useLoginDialog().autoOpenIfNeeded()` 在无 token 时弹一次窗（`sessionStorage.loginPrompted` 防重复）。
3. 用户可点「取消」关掉弹窗，只得到 toast「需登录才能使用完整功能」，背后是空任务列表。
4. 401 刷新 token 失败、以及部分 403，再次弹出同一对话框。
5. 顶栏「登录」、未登录点搜索 / Ctrl+K，也是唤起同一对话框。

管理后台已经是独立 `/admin/login` 整页；客户端仍是「半成品壳 + 弹窗」，两端不一致。

### 1.2 问题

| 点 | 说明 |
|----|------|
| 产品形态 | Mao 几乎没有未登录可用的能力（任务、搜索、设置、WebSocket 都要 JWT），却允许取消弹窗进入空壳 |
| 深链 | 未登录打开 `/tasks/123` 先看到空壳，登录后不会自动回到该会话 |
| 安卓 | 420px 对话框 + 系统键盘 + 飞书外开窗口，比整页难用 |
| 401 | 与首次进入共用 `useLoginDialog`，Layout 仍挂着过期会话状态 |
| 一致性 | 管理后台已是登录页；产品文档 / 审查里也常把客户端登录称作「登录页」 |

### 1.3 目标

未登录只渲染独立登录页，不挂载主布局。登录成功后进入原目标路由。登出、token 失效走同一条路，**不再保留登录弹窗**。

---

## 2. 范围

### 2.1 要做

- 新增路由 `/login`（`Layout` 外），页面含密码登录与飞书登录（能力开关与现网一致）
- 路由守卫：无 token 访问受保护路由 → `/login?redirect=…`；已登录访问 `/login` → 回首页或 `redirect`
- 登出、refresh 失败后的 401 → 清本地会话并进入登录页
- 删除 `LoginDialog.vue` / `useLoginDialog.ts` 及所有弹窗调用
- 更新 Playwright、产品文档、CHANGELOG

### 2.2 明确不做

| 事项 | 决策 |
|------|------|
| 后端 / 飞书 OAuth 协议 | **不改**。仍是 `POST /auth/login`、`GET /auth/features`、飞书 qrcode / status / 后端 callback |
| 管理后台登录页 | **不改**（已是 `/admin/login`） |
| 游客模式 / 未登录浏览主界面 | **不做**。取消按钮去掉，登录为硬门槛 |
| 登录弹窗作为 401 降级方案 | **不做**。冷启动与中途失效统一走登录页 |
| 注册、找回密码、改密 | **不做** |
| 记住密码 | **不做**（管理后台也不再存密码） |
| 安卓 APK / Electron 安装包 | **不重打**。这是远程 SPA 前端改动，部署 `desktop/dist` 即可 |
| Nginx 配置 | **不改**。`/login` 走现有桌面 `location /` 的 SPA fallback，与 `/tasks/:id` 相同 |
| `mao-agent` / `mao-cli` 登录 | **不改** |

---

## 3. 现状分析

### 3.1 调用链

```
冷启动无 token
  Layout.onMounted → autoOpenIfNeeded() → LoginDialog 弹出
  用户可 close()；sessionStorage.loginPrompted=1 本标签页不再自动弹

主动登录
  TopNav「登录」 / 搜索图标 / Ctrl+K → useLoginDialog.open()

登录成功
  authStore.login / pollFeishuLogin → notifySuccess()
    → visible=false，loginVersion++
    → TaskView watch(loginVersion) → connect WS + loadTaskIndex + resolveInitialRoute

401
  api 拦截器 refresh 失败 → showReloginDialog()
  403 也会 showReloginDialog()   ← 现有行为不合理，本次一并改掉

登出
  authStore.logout() 清 token / 断 WS / reset session+draft
  仍停在当前路由，顶栏变成「登录」按钮，不再自动弹窗
```

### 3.2 关键文件

| 文件 | 当前职责 | 本次 |
|------|----------|------|
| `desktop/src/components/auth/LoginDialog.vue` | 弹窗 UI + 密码/飞书逻辑 | **删除**，逻辑迁到 LoginView |
| `desktop/src/composables/useLoginDialog.ts` | 全局 visible / loginVersion / 回调 | **删除** |
| `desktop/src/components/common/Layout.vue` | 挂载 LoginDialog、autoOpen | 去掉弹窗与 autoOpen |
| `desktop/src/router/index.ts` | 有 token 才 hydrate 用户，无 token 仍放行 | **加守卫** |
| `desktop/src/api/index.ts` | 401/403 弹登录窗 | 401 → 登录页；403 不再当未登录 |
| `desktop/src/stores/auth.ts` | login / logout / 飞书 | logout 后跳转登录页；抽出清会话 |
| `desktop/src/views/task/TaskView.vue` | `watch(loginVersion)` 登录后拉数据 | 删除该 watch（进 Layout 即会重新挂载） |
| `desktop/src/components/common/TopNav.vue` | 未登录「登录」按钮、Ctrl+K 弹窗 | 未登录分支随 Layout 一起不再出现 |
| `desktop/src/components/search/SessionSearchPopover.vue` | 未登录点搜索弹窗 | 同上 |
| `tests/desktop.spec.ts` | 大量断言未登录就能看到 `.layout` / `.login-dialog` | **必须改** |

### 3.3 三端加载方式（与路由模式）

| 端 | 如何加载前端 | Vue Router | 登录 URL |
|----|--------------|------------|----------|
| Web 生产 | Nginx `desktop/dist`，History | `createWebHistory` | `https://mao.etarch.cn/login` |
| Electron 生产 | 远程加载 `https://mao.etarch.cn` | History | 同上 |
| Electron / Vite 开发 | `http://localhost:5201` | History | `http://localhost:5201/login` |
| 安卓 Capacitor | 远程加载同一 SPA | History | 同上 |
| `file://` 或旧版安卓内嵌包 | 本地 dist | `createWebHashHistory` | `#/login` |

守卫必须同时适用于 History 与 Hash，用 `to.fullPath` / `router.replace`，不要拼死 `window.location.href = '/login'`（Hash 模式下会打到错误地址）。

生产单域已占用的前缀：`/admin/`、`/api/`、`/uploads/`。`/login` 不冲突。不要用 `/auth`，以免和 REST `/api/v1/auth` 口头混淆。

### 3.4 认证存储

`initAuthStorage()` 在 `main.ts` 里、创建路由之前执行：

- Web / 安卓：`localStorage`
- Electron：主进程 `userData/auth.json`，并镜像到 localStorage

守卫读 `getToken()` 时缓存已就绪，不必改存储层。

### 3.5 飞书

协议不变：前端拿 `authUrl` → Electron `openFeishuAuthWindow` 或 Web `window.open` → 轮询 `/auth/feishu/status`。登录页只是换宿主，不改授权窗口。

`/v1/auth/*` 在后端是公开路径。密码错误是业务码 `1005`（HTTP 200 + `code !== 0`），**不会**走 axios 的 HTTP 401 分支，登录页不会自己把自己踢出去。

### 3.6 Playwright 现状（改造后会红）

未登录访问 `/` 时，现用例假定主壳已经在：

- `should load the app shell` 等 `.layout`
- `should render top navigation bar` 等 `.top-nav`
- `should show task layout with panels` 等 `.task-layout`
- 飞书 / Ctrl+K 等 `.login-dialog`

改成登录页后，未登录 `/` 会落到 `/login`，上述壳选择器不存在。必须按「未登录 / 已登录」拆开。

飞书相关用例文案已和实现不完全一致（用例写「飞书扫码登录」/ `.qr-image`，实现是「飞书登录」按钮）。本次一并改到登录页选择器，不要再依赖 `.login-dialog`。

---

## 4. 目标交互

### 4.1 页面结构

独立全屏页，视觉对齐管理后台登录卡，使用桌面端 token（`--aw-*`），带现有 Logo。

```
┌─────────────────────────────────────┐
│  [主题]                        （角落）│
│                                     │
│           [Logo]                    │
│            Mao                      │
│                                     │
│        [ 用户名     ]                │
│        [ 密码       ]                │
│        [    登录    ]                │
│        ☑ 记住用户名                  │
│        [  飞书登录  ]  ← features 开才显示
│                                     │
└─────────────────────────────────────┘
```

飞书模式（点「飞书登录」后）替换表单区：状态文案 + 再次打开授权 + 「返回密码登录」。无「取消」。

记住用户名：与管理后台一致，只记用户名，不记密码。建议做，工作量小，减少重复输入。

主题：登录页没有 TopNav。沿用 `useTheme()` 已写入的 localStorage / 系统偏好；角落放现有风格的主题切换，避免深色用户看到刺眼白页。

### 4.2 状态机

```
无 token 访问任意受保护路由
  → replace /login?redirect=<原 fullPath>
  → 只渲染 LoginView（无 TopNav / TaskView / WS）

已登录访问 /login
  → replace(safeRedirect || '/')

密码/飞书成功
  → replace(safeRedirect || '/')
  → Layout 首次挂载，按现有逻辑拉会话、连 WS
  → redirect 为 /tasks/:id 时直接进入该任务

登出
  → clearLocalSession()（可调用 POST /auth/logout，失败忽略）
  → replace('/login')   // 不带 redirect，避免回跳到需登录页

refresh 失败的 401
  → 与登出相同的本地清理，但不打 /auth/logout（token 已死）
  → replace /login?redirect=<当前 fullPath>（当前已是 /login 则不再跳）
```

### 4.3 Electron 窗体

生产 Electron 是 `titleBarStyle: hiddenInset`，红绿灯压在左上。主界面靠 TopNav `padding-left: 78px` + `-webkit-app-region: drag` 让出空间。

登录页没有顶栏，必须自己处理：

- 顶部保留可拖拽区（约导航栏高度），内容区 `no-drag`
- macOS 下为红绿灯留左上内边距（可用 `html.electron` 或 `window.electronAPI` 判断，避免 Web/安卓出现空白）
- 输入框、按钮必须 `no-drag`，否则点不到

### 4.4 安卓

- 容器用 `min-height: 100dvh`，键盘顶起时卡片仍可用（对齐 admin `LoginView`）
- Splash 仍由 `App.vue` 在 `router.isReady()` 后关掉，登录页足够作为首屏
- `useForegroundRecovery`：登录页不连 WS，`getReadyState()` 为 `-1`，回前台不刷新。**登出时必须 `disconnect()`**（现有 logout 已做），避免 WS 残留 CLOSED 导致误 reload
- 系统返回键：守卫一律 `replace`，避免 `/` → `/login` 在历史栈里叠一层，返回又进空壳再被踢回登录页

OTA / 版本检查现在挂在 TopNav，登录页不会弹更新。登录进主界面后再提示，可接受。

---

## 5. 关键决策

### 5.1 一种入口，不留弹窗

冷启动和中途 401 都进登录页。会话在服务端，URL 里有 `sessionId`，回来后能恢复。两套 UI 长期并存，状态更难维护。

### 5.2 用 `router.replace`，不用 `window.location.href`

| 方式 | 结论 |
|------|------|
| `window.location.href = '/login'` | Hash 模式、Electron 开发、带 redirect 的 query 都容易错；整页重载，Splash 再走一遍 |
| `router.replace({ name: 'Login', query: { redirect } })` | **采用**。三端同一套 history 抽象 |

401 并发用模块级 `isRedirectingToLogin` 防抖，等价于现在的 `isReloginShowing`。

### 5.3 `redirect` 白名单

query `redirect` 只接受站内路径：

- 必须以 `/` 开头
- 不得以 `//` 开头（协议相对 URL）
- 不得为 `http:` / `https:` / `javascript:`
- 不得指向 `/admin`、`/api`、`/uploads` 前缀
- 空、非法、指向 `/login` 自身 → 回 `/`

Hash 模式下 `to.fullPath` 已是 `/tasks/123?x=1` 这种应用路径，直接当 `redirect` 即可，不要把 `#` 写进 query。

### 5.4 401 与 403

| HTTP | 现行为 | 目标 |
|------|--------|------|
| 401 且 refresh 成功 | 重试原请求 | 不变 |
| 401 且 refresh 失败 | 弹登录窗 | 清会话 → 登录页 + redirect |
| 登录页上的 `/auth/login`、`/auth/refresh`、`/auth/feishu/*` 失败 | 可能误走 401 弹窗 | **排除这些 URL**，只展示表单错误 |
| **403** | 也弹登录窗 | **改为普通错误 toast**。403 是已登录无权限，不是未登录 |

这是顺手修正，不是新需求。403 继续当「请重新登录」会把有效会话踢掉。

### 5.5 清会话抽公共函数

```
clearLocalSession()
  token/user = null
  clearTokens()
  useStreamWS().disconnect()
  sessionStore.reset()
  draftStore.reset()
```

- `logout()`：尽量 `POST /auth/logout`，然后 `clearLocalSession()`，再 `replace('/login')`
- 401 强制下线：只 `clearLocalSession()` + `replace('/login?redirect=…')`，不打 logout 接口

`loginVersion` 删除。从登录页进入 Layout 是首次挂载，`TaskView.onMounted` 已会 `loadTaskIndex` + `resolveInitialRoute`。

### 5.6 token 仍在但已失效

守卫：有 token、无 `authStore.user` 时 `fetchUserInfo()`。

- 成功：放行
- 401：交给拦截器（refresh → 失败则强制下线）
- 其它网络错误：不要清 token（避免弱网被踢），放行或停在当前导航，与现守卫「catch 后 next()」接近

### 5.7 顶栏「登录」与未登录搜索

主布局只在已登录后出现，TopNav / SessionSearchPopover / Ctrl+K 的未登录分支成为死代码，**删掉**，不要再 `router.push('/login')`。

---

## 6. 路由设计

```ts
{
  path: '/login',
  name: 'Login',
  component: () => import('../views/auth/LoginView.vue'),
  meta: { public: true }
}
// 现有 Layout 及 children 不变，默认 meta.public !== true → 需登录
```

守卫伪代码：

```
beforeEach(async (to, _from, next) => {
  const token = getToken()
  const isPublic = to.meta.public === true

  if (!token) {
    if (isPublic) return next()
    return next({
      name: 'Login',
      query: { redirect: to.fullPath },
      replace: true
    })
  }

  if (to.name === 'Login') {
    return next({ path: safeRedirect(to.query.redirect) || '/', replace: true })
  }

  if (!authStore.user) {
    try { await authStore.fetchUserInfo() }
    catch { /* 401 由拦截器处理；其它错误不阻断 */ }
  }
  next()
})
```

`App.vue` 仍是 `<router-view />`，登录页与 Layout 互斥，不会双挂载。

---

## 7. 影响面

### 7.1 Web

深链 `https://mao.etarch.cn/tasks/123` 未登录 → `/login?redirect=/tasks/123` → 登录后回该任务。刷新 `/login` 仍停在登录页。

Nginx 不必改：`/login` 无静态文件，与其它前端路由一样落到 `desktop/index.html`。

### 7.2 Electron

生产加载远程 SPA，行为与 Web 相同。开发 `localhost:5201/login` 同样走 History。

额外：登录页拖拽区与红绿灯避让（§4.3）。LOCAL 工具仍要 JWT，未登录不进主界面可接受。

飞书授权子窗口逻辑不变。

### 7.3 安卓

远程 SPA，无原生改动、不打 APK。键盘、返回键、回前台恢复见 §4.4。

### 7.4 后端 / admin / CLI

无接口变更。管理后台继续 `/admin/login`。文档里若写「客户端登录弹窗」改为「登录页」。

### 7.5 前端发版

属于「前端（桌面 / Web / 安卓）」：写 CHANGELOG，部署 `scripts/deploy-desktop.sh`。用户刷新或等 `version.json` 即可。不跑 `build-apk.sh`，不打 Electron 包。

---

## 8. 文件级改造清单

| 动作 | 路径 |
|------|------|
| 新增 | `desktop/src/views/auth/LoginView.vue`（UI + 从 LoginDialog 迁入的密码/飞书逻辑） |
| 新增 | `desktop/src/utils/login-redirect.ts`（`safeRedirect` / `redirectToLogin`，供路由与拦截器共用） |
| 修改 | `desktop/src/router/index.ts` |
| 修改 | `desktop/src/api/index.ts`（401 跳转；403 不再当未登录；排除 `/auth/*`） |
| 修改 | `desktop/src/stores/auth.ts`（`clearLocalSession`；logout 后 replace） |
| 修改 | `desktop/src/components/common/Layout.vue` |
| 修改 | `desktop/src/views/task/TaskView.vue`（去掉 `loginVersion`） |
| 修改 | `desktop/src/components/common/TopNav.vue`（去掉未登录登录按钮与 Ctrl+K 弹窗） |
| 修改 | `desktop/src/components/search/SessionSearchPopover.vue`（去掉未登录分支） |
| 删除 | `desktop/src/components/auth/LoginDialog.vue` |
| 删除 | `desktop/src/composables/useLoginDialog.ts` |
| 修改 | `tests/desktop.spec.ts` |
| 修改 | `docs/plan/session-message-search-design.md` §4.7 一句（未登录改为进不了主界面，不再弹窗） |
| 修改 | 根 `CHANGELOG.md`（实现时写入当时版本） |

产品文档：`skills/mao-cli` 几乎没写弹窗细节，实现时扫一眼 `desktop.md` / `troubleshooting.md` / `android.md`，若出现「登录对话框」则改成登录页。不必为登录页新建手册章节。

---

## 9. 测试

### 9.1 Playwright（`tests/desktop.spec.ts`）

未登录：

- 打开 `/` → URL 为 `/login`，可见登录卡（`.login-card` 或等价），**没有** `.layout`
- 打开 `/tasks/1` → `/login?redirect=` 含 `/tasks/1`
- 飞书开关关闭时无飞书按钮；打开时点飞书会 `window.open` / 进入飞书状态区
- 不再存在 `.login-dialog` 用例
- 不再测「未登录 Ctrl+K 弹窗」：未登录到不了顶栏。改为断言停在登录页、不请求 `/sessions/search`

已登录（沿用 `mockLoggedInDesktopApi` 或 initScript 写入 token）：

- `/` 渲染 `.layout` / `.top-nav` / `.task-layout`（把现在误放在未登录下的壳用例挪过来）
- 访问 `/login` → 重定向离开登录页
- 搜索、任务跳转等现有已登录用例保持

管理后台 `tests/admin.spec.ts` 不动。

### 9.2 手工验收

| 端 | 项 |
|----|----|
| Web | 无 token 打开首页 / 深链 / 刷新登录页；密码错误 toast；成功进任务列表；记住用户名；飞书（若环境启用） |
| Web | 登出回到 `/login`，浏览器返回不会闪进空主界面 |
| Web | 伪造过期 access+refresh，触发 401，应进登录页且 redirect 为原路径，登录后回去 |
| Electron 开发 | 红绿灯不挡表单；窗口可拖；输入框可点 |
| 安卓 WebView | 键盘不把主按钮顶出屏外；切后台再回登录页不整页刷新；登录后任务流正常 |

`cd backend-ts && npm test` 与本次无关，可不跑。改完 desktop 后跑根目录 Playwright desktop 项目。

---

## 10. 风险与边界

| 风险 | 处理 |
|------|------|
| 未登录壳用例大面积失败 | 先改测试再改产品代码，或同一 PR 内一起改 |
| 401 死循环 | 排除 `/auth/login|refresh|feishu`；已在 `/login` 时不再 `replace` |
| open redirect | `safeRedirect` 白名单 |
| Hash 模式拼错 URL | 只用 vue-router，不用写死 `/login` 的整页跳转 |
| 登录页挡红绿灯 / 无法拖窗口 | Electron 专用顶栏占位 |
| 安卓回前台误 reload | 登出/401 必 `disconnect()`，保持 `getReadyState() === -1` |
| 中途 401 丢失未发送草稿 | `draftStore.reset()` 与现 logout 一致；若以后要保留草稿，不在本次范围 |
| 飞书授权中途 401 | 飞书接口是公开的，不应 401；若轮询失败只在页内展示错误 |

---

## 11. 实现顺序

1. `safeRedirect` + 路由 `/login` + 空壳 LoginView，守卫先接通（此时弹窗可暂留，避免半截不可用）
2. 把 LoginDialog 的表单/飞书迁到 LoginView，补 Electron 拖拽与安卓 dvh
3. 拦截器 401、logout、`clearLocalSession`；删除弹窗与 `loginVersion`
4. 删 TopNav / 搜索的未登录分支
5. 改 Playwright 与文档、CHANGELOG
6. 本地 desktop 开发服走一遍 §9；部署 `desktop/dist` 后 Web / 安卓 / Electron 远程壳各点一次

步骤 1–4 建议同一 PR，不要长期「页 + 窗」双入口。

---

## 12. 验收标准

- 无 token 打开客户端任意需登录 URL，只看到登录页，看不到任务壳
- 登录成功进入 `redirect` 或首页，顶栏为已登录态，WS 可连
- 登出、refresh 失败回到登录页
- 403 不踢登录
- 飞书开关与授权方式和现在一致
- Web / Electron / 安卓远程前端行为一致（Electron 仅多拖拽/避让）
- `tests/desktop.spec.ts` 按新约定通过
- 未改后端、admin、APK、Electron 安装包
