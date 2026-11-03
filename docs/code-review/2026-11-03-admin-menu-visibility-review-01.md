# 管理后台「菜单可见性」配置代码审查报告

- 审查日期：2026-11-03
- 需求方案：`docs/plan/2026-11-03-admin-menu-visibility-technical-design.md`
- 审查范围：仅本次需求白名单内的未提交改动（后端 `settings` 域 + V182 迁移、admin 的 store / 守卫 / 菜单过滤 / 首页降级 / 设置页面板）。同工作区并行的「会话来源细分」改动（`backend-ts/src/session/**`、`harness/**`、`agent-cli/**`、`desktop/src/**`、`shared/contracts/**`、`V181__backfill_session_source_local_desktop.sql` 等）不在本次审查范围，未审、未改。
- 结论：**无阻塞项（0）；重要问题 1 项、建议 2 项**。后台「菜单可见性」主链路（侧栏 / 抽屉 / ⌘K / 键盘导航 / 首页签 / 设置面板 / 后端读写与校验）经用例验证均正确；重要问题集中在**应用自身的「首页」跳转没有接入可见性降级**（登录落地与后台根地址），与需求承诺不一致。
- 验证方式：补齐临时 vitest 用例（admin 5 个文件、backend 1 个文件，含挂载组件 + Fastify inject，全部实测通过/按预期失败，验证后已删除，工作区无残留）；复用本次改动自带的 `settings.service.spec.ts`（84 passed）、`menuNav.spec.ts` + `home.spec.ts`（22 passed）；未修改任何受审文件。

---

## 一、重要（1 项）

### I-1 登录落地 / 后台根地址 / 404 兜底不走「首页降级链」，隐藏「用量分析」后仍然落到被隐藏页

- 位置（均为本次需求未改动的既有代码，正是本需求漏接的第 5 条「首页」入口）：
  - `admin/src/router/index.ts:25`：`path: '/'` 的 `redirect: '/analytics'`（静态 redirect）
  - `admin/src/router/index.ts:176`：404 兜底 `path: '/:pathMatch(.*)*'` 的 `redirect: '/analytics'`
  - `admin/src/views/auth/LoginView.vue:131`、`:202`：密码登录与飞书/ECP 登录成功后均为 `await router.replace('/')`
  - 本次新代码：`admin/src/utils/home.ts:9-16`（`pickHomePath` 第二参 `isHidden`）、`admin/src/components/Layout.vue:143-157`、`admin/src/components/SideMenu.vue:313-319`、`admin/src/views/auth/ForbiddenView.vue:21-26`、`admin/src/router/index.ts:225-234`（4 个调用点）
- 问题描述：
  本需求把「首页」语义收敛到 `pickHomePath(hasPermission, isHidden)`，并让 Logo / 返回首页 / TabBar 不可关闭首页签 / 403 页 / 守卫的 `/analytics` 特判 4 个调用点传入 `menuStore.isHidden`。但应用里还有一条最常见的「首页」入口没接：根路径 `/` 是**静态** `redirect: '/analytics'`（404 兜底同样是静态 `/analytics`），而登录成功（三种登录方式）都走 `router.replace('/')`。
  vue-router 的 redirect 在导航守卫**之前**解析完成，所以守卫看到的是 `/analytics` 而不是 `/`；守卫里的 `/analytics` 特判只在「没有 `analytics:read`」时才触发降级（`authStore.hasPermission(permission)` 为真则直接放行）。结果是：管理员在面板里隐藏「用量分析」后，只要账号有 `analytics:read`：
  1. 每次登录（密码 / 飞书 / ECP）仍落到被隐藏的「用量分析」页；
  2. 直接访问后台根地址 `/`（最常见书签）同样落到被隐藏页；
  3. 输入任意不存在的地址（404 兜底）也落到被隐藏页；
  4. 此时顶栏「不可关闭首页签」已经是下一个可见页（如「会话管理」），而当前页「用量分析」变成可关闭的普通标签 —— TabBar 语义自相矛盾（`Layout.vue` 的 watch 与 `tabs.ts:118-146` 已按「首页=可见页」重算）。
  这与需求已确认决策「隐藏『用量分析』后首页降级链自动落到下一个可见有权限页」以及 CHANGELOG 0.0.422 的表述不一致；菜单里已经看不到「用量分析」，登录后却仍停在它上面。
- 影响面：菜单可见性功能最核心的诉求场景（某实例不用用量分析）中，用户的主入口体验与配置不符；侧栏 / Logo / 首页签三者表现不一致，容易让管理员误判配置没生效。不涉及权限与数据安全（按 D8「隐藏 ≠ 收权」，直接输入 URL 访问被隐藏页本就允许）。
- 验证（临时用例，实测通过；随后已删除）：
  1. 守卫 / 落地页（`admin/src/router/*.tmp.spec.ts`，mock `api`：`/users/me` 返回含 `analytics:read` 的权限，`/system-settings/menu-visibility` 返回 `{ hidden: ['/analytics'] }`）：
     ```ts
     localStorage.setItem('token', 't'); setActivePinia(createPinia())
     const { default: router } = await import('./index')
     await router.push('/')
     expect(router.currentRoute.value.path).toBe('/analytics')  // 实际：落在被隐藏页
     // 期望：/sessions（pickHomePath 跳过隐藏项）
     ```
  2. Layout 首页签对照（挂载 `Layout.vue`，`hidden=['/analytics']`、当前路由 `/analytics`）：
     ```ts
     expect(router.currentRoute.value.path).toBe('/analytics')                    // 当前页=被隐藏页
     expect(tabs.tabs.find(t => !t.closable)?.path).toBe('/sessions')             // 首页签=下一可见页
     expect(tabs.tabs.find(t => t.path === '/analytics')?.closable).toBe(true)    // 当前页成了可关闭标签
     ```
- 修复方向（供后续执行，本次未改码）：
  - 不再让 `/` 与 404 兜底直接静态指向 `/analytics`，而是交给「可见性感知」的解析：可选做法 A —— 在守卫内用 `to.redirectedFrom`（`/` 或未知路径）识别「这是应用自身的首页/兜底跳转」，在 `menuStore.fetch()` 之后用 `pickHomePath(hasPermission, menuStore.isHidden)` 决定落点；做法 B —— 把 `/` 改成真实组件（或专门的 `/home` 路由，无 `permission`），组件 setup 内 `router.replace(pickHomePath(...))`，此时 store 已由守卫加载完毕。
  - 登录流程无需改：`router.replace('/')` 保持不变，`/` 解析完即可正确落点。
  - 边界：**不要**把「可见性」塞进权限校验（如 `if (isHidden(to.path)) next('/forbidden')`），否则违背 D8「隐藏 ≠ 收权、直接输入网址仍可访问」；只需修「应用自身的首页/兜底跳转」。

---

## 二、建议（2 项，非阻塞）

### S-1 新增读取端点落在审计前缀内，每个后台会话都会写一条无用 READ 审计

- 位置：`backend-ts/src/settings/settings.routes.ts:60`（`GET /v1/system-settings/menu-visibility`）、`backend-ts/src/audit/audit.interceptor.ts:15`（`AUDITED_PREFIXES` 含 `'/v1/system-settings'`，且对任意方法（含 GET）命中即审计）、`backend-ts/src/app-hooks.ts:140-158`（`onResponse` 写审计）
- 问题描述：方案 §1.3 假设「审计拦截器覆盖 `/v1/**`，菜单配置的写入自动留痕」，但实际实现是**前缀内所有方法**都留痕。该端点由路由守卫在**每个后台会话的首次导航**调用（刷新页面 / 重新登录各一次，全站所有账号），因此管理后台「审计日志」里会持续出现 `READ /v1/system-settings/menu-visibility`，且 audit_log 表多出等量行。这不是安全问题（只暴露隐藏路径列表），是审计信噪比问题。
- 验证（临时用例，实测通过）：
  ```ts
  expect(shouldAudit('/v1/system-settings/menu-visibility', 'GET')).toBe(true)
  ```
  并用 Fastify `inject` 跑通 `GET /api/v1/system-settings/menu-visibility` 确认返回 `{ hidden: [...] }`、无需 `settings:read`。
- 修复方向：给该读端点显式排除审计（在 `shouldAudit` 的前缀判断前加一条针对该路径的 read-only 排除，参照 `AUDITED_WRITE_EXCLUDES` 的写法），或把端点挪出 `/v1/system-settings` 与 `/v1/admin` 两个审计前缀（例如 `/v1/menu-visibility`），保持「写留痕、读不留痕」。

### S-2 菜单可见性读取失败会弹全局错误 toast，与 D4「fail-open 不打扰」口径不符

- 位置：`admin/src/stores/menu.ts:20`（`const { data } = await api.get('/system-settings/menu-visibility')`，未传 `skipErrorToast`）；`admin/src/api/index.ts:96-107`（非 401 且未 skip 时统一 `ElMessage.error`）
- 问题描述：`fetch()` 的业务语义是 fail-open（失败按「全部显示」且 `loaded=true`，不阻断导航），但调用未带 `skipErrorToast`，拦截器会弹出「请求失败 / 网络错误 / 服务异常」。后果：后端未升级（404）、网关 5xx、网络抖动时，管理员每次进后台都会先看到一条红色错误提示，误以为后台故障，而实际菜单功能正常。同仓库先例：`admin/src/composables/useEmbedChat.ts:59-60` 对同类「开机拉配置、失败可忽略」的请求显式传了 `skipErrorToast: true`。
- 验证（临时用例，实测通过；用真实 `api` 模块 + 自定义 adapter 返回 500）：
  ```ts
  api.defaults.adapter = async (config) => { throw Object.assign(new Error('boom'), { config, response: { status: 500, data: { code: 500, message: '服务异常' }, headers: {}, config } }) }
  const toast = vi.spyOn(ElMessage, 'error')
  const menu = useMenuStore(); await menu.fetch()
  expect(menu.hidden).toEqual([]); expect(menu.loaded).toBe(true)          // fail-open 生效
  expect(api.get.mock.calls[0]).toEqual(['/system-settings/menu-visibility']) // 未传 skipErrorToast
  expect(toast).toHaveBeenCalledWith('服务异常')                            // 仍然弹了全局错误
  ```
- 修复方向：`api.get('/system-settings/menu-visibility', { skipErrorToast: true })`；面板里的 `PUT` 与其它保存操作保持现状（失败必须提示）。

### S-3 迁移文件与注释里的版本号写成 V181（非功能）

- 位置：`backend-ts/db/migration/V182__admin_menu_visibility.sql:1`（注释 `-- V181: 管理后台菜单可见性配置`）；`admin/src/views/settings/SystemSettingsView.vue:375`、`:397` 注释同样写 V181。
- 说明：文件实际落 V182（V181 被并行任务的 `V181__backfill_session_source_local_desktop.sql` 占用），只影响可读性/回溯，无功能影响。改注释即可，不需要重命名文件（已入库脚本不要重命名）。

---

## 三、审查过、未发现问题的部分（含重点方向逐项结论）

### 后端（`settings` 域 + 迁移）

- **读取端 fail-open**：`getAdminMenuHidden()` → `parseAdminMenuHidden(getValue(...))`；`parseAdminMenuHidden` 对 `null/undefined/空串/纯空白/坏 JSON/非数组/非字符串元素/空串项/非 `/` 开头项/重复项` 全部容错且永不抛错（`settings.service.ts:1021-1038`）；缺行/缺迁移时 `getValue` 返回 `null` → `[]`（旧实例行为与升级前逐字一致）。
- **写侧形状校验是否可被绕过**：`update()` 与 `updateBatch()` 都经 `resolveNextValue()` → `validateValue()`（`settings.service.ts:632-661`、`:795-799`），无双路径缺口（已用 Fastify `inject` 对单条与 `/batch` 分别验证：`'["/settings"]'` 被拒、`row.value` 未被改写、合法值落库）。`/settings` 的变体（`' /settings '`、`'/settings '`、JSON `\u002f` 转义、`'//settings'`、`'/settings/'`）中，前三种被 trim 归一化后拒绝；后两种 trim 后不等于 `/settings`，前端 `Set.has` 为精确匹配也不会命中该项，因此**不存在实际隐藏「系统设置」的绕过路径**。
- **写侧 trim 归一化偏差（方案伪代码无、实现有）是否引入问题**：读侧 `parseAdminMenuHidden` 同样 trim 每一项，写侧校验 trim 后存原串 → 存 `'[" /sessions "]'` 之类值读回仍是 `'/sessions'`，与前端菜单 index 精确匹配；校验口径（trim + 去重计数）与读侧一致，既不误拒合法值，也不产生「校验通过但读回语义不同」的错位。**该偏差无副作用**。
- **权限 / 只读**：`GET /v1/system-settings/menu-visibility` 仅 `requireUserId`，用 `hasPermission: async () => false` 的注入实测仍返回 200 + `{ hidden }`（验证 D3）；`PUT` 仍要求 `settings:write`（未改动）；迁移行 `editable=1, is_secret=0`，`value` 列升级后为 `TEXT`，`description`（60 字符）未超 `VARCHAR(256)`，`category '管理后台'` 未超 `VARCHAR(64)`，且不与既有行重键。
- **返回内容不泄露其它配置**：只返回隐藏路径数组。

### 前端

- **store**（`admin/src/stores/menu.ts`）：`fetch()` 成功/失败都置 `loaded=true`，失败清空为 `[]`（fail-open，实测）；`isHidden` 精确匹配；`setHidden` 替换数组并置 `loaded`。
- **路由守卫加载时机**：`if (!menuStore.loaded) await menuStore.fetch()` 位于 `fetchUserInfo()` 之后、权限校验之前，首屏即正确过滤，后续导航零请求（`fetch` 内部不抛错，不破坏原有 fail-closed 语义）；`useMenuStore()` 在守卫内实例化与既有 `useAuthStore()` 同口径，Pinia 已在 `main.ts` 安装。
- **隐藏项在侧栏 / 抽屉 / ⌘K / 键盘导航生效**：`visibleGroups = applyMenuVisibility(权限过滤结果, menuStore.hidden)` 是唯一数据源，`displayedGroups` / `flatItems` / 渲染均派生自它。实测（挂载 `SideMenu.vue` + 真 Element Plus + 路由）：隐藏 `/analytics`、`/dingtalk-bots` 后 `.menu-item` hrefs 不含这两项、仍含 `/sessions`、`/settings`；搜索「钉钉」显示「未找到」。抽屉与侧栏共用同一组件、同一 store，天然一致。
- **`applyMenuVisibility`**：空数组返回同一引用；命中项移除；空组整组剔除；未知 index 静默忽略；不修改入参（`menuNav.spec.ts` 5 条新用例 + 我的挂载实测）。
- **`pickHomePath` 降级链与 4 个调用点**：4 处（SideMenu 的 `goHome`、Layout 首页签 watch、ForbiddenView 的 `goHome`/`canGoHome`、守卫 `/analytics` 特判）均显式传 `menuStore.isHidden`；不传第二参时行为与改动前逐字一致（`home.spec.ts` 回归用例）。（未覆盖的第 5 条入口见 I-1。）
- **TabBar 首页签联动**：`watch([() => authStore.user, () => menuStore.hidden], …, { immediate: true })` 对 `setHidden` 的**数组替换**正常触发；实测：挂载时 `hidden=['/analytics']` → 首页签 `/sessions`；运行中 `setHidden(['/analytics','/sessions'])` → 首页签变 `/agents`，且旧 `/analytics` 不再是不可关闭标签。`setHomePath` 对 `/forbidden`（全部候选被隐藏）早退、保留旧首页签属边界取舍，需隐藏 6 个首页候选页才会遇到，未列为问题。
- **设置页 SPECIAL_KEYS 完整性**：`admin.menu.hidden` 已进 `SPECIAL_KEYS`，4 个遍历 `settings.value` 的位置全部跳过 —— `syncPlainModel`（`:448-449`）、`categories`（`:646-648`）、`settingsByCategory`（`:659-660`）、`hasUnsavedEdits`（`:899-900`），`buildSettingsLocatorFields` 也以 `coveredKeys: SPECIAL_KEYS` 排除（`:744-750`）。挂载实测：TOC 展开「平台与运维」后有「菜单可见性」、**没有**「管理后台」分类卡片、也没有「其他」兜底分组；面板 `#setting-group-menu-visibility` 渲染存在；搜索目录项 `MENU_VISIBILITY_FIELD_ID='setting-field-admin.menu.hidden'` 与面板锚点 DOM id 完全一致（滚动定位可达；`.settings-content :deep(.is-located)` 高亮样式对子组件元素生效）。
- **面板开关方向 / 保存 / 恢复默认 / 权限门控**（挂载 `MenuVisibilityPanel.vue` + 真 Element Plus，实测 4 组断言全通过）：
  - 开关方向：开=显示。已隐藏项 `aria-checked=false`，未隐藏项 `aria-checked=true`；`/settings` 项 `is-disabled` 且显示「系统设置不可隐藏」。
  - 保存：关闭「会话管理」后点保存 → `PUT /system-settings/admin.menu.hidden`，body `value` 解析后含 `/sessions`、`/dingtalk-bots`、**不含** `/settings`，`menuStore.hidden` 同步更新（侧栏即时刷新）。
  - 恢复默认：清空草稿后保存提交 `[]`，store 变空。
  - 权限门控：`canWrite=false` 时开关与「保存 / 恢复默认」全部禁用，`save()` 内另有 `if (!props.canWrite) return` 兜底。
- **keepAlive 缓存行为**：`onMounted` 内「未 loaded 才 fetch，随后 syncDraft」；`onActivated` 仅在 `loaded && !dirty` 时以 store 为准重同步，保证「切走再回来」不丢未保存草稿；面板 dirty 计算与 store 对称（两侧都过滤 `/settings`），保存成功后 draft 与 store 对齐、dirty 归零。未发现缓存导致的错乱。
- **构建/既有用例**：`cd admin && npm run build`、`cd backend-ts && npm run build` 通过；`settings.service.spec.ts` 84 passed、`menuNav.spec.ts`+`home.spec.ts` 22 passed、`flyway.spec.ts` 14 passed（与任务说明一致，本次未重复跑全量）。

---

## 四、临时验证用例说明（已验证并删除，工作区无残留）

| 用例文件（临时） | 验证内容 | 结果 |
|---|---|---|
| `admin/src/router/mv-landing.tmp.spec.ts` | `router.push('/')` 在 `hidden=['/analytics']` 且账号有 `analytics:read` 时的落点 | 落在 `/analytics`（**问题 I-1**） |
| `admin/src/components/mv-layout.tmp.spec.ts` | Layout 首页签随 `hidden` 变化重算；落地隐藏页时首页签=下一可见页、当前页可关闭 | 3 条通过（其中第 3 条复现 I-1 的不一致） |
| `admin/src/components/mv-sidemenu.tmp.spec.ts` | 侧栏隐藏项消失、⌘K 搜索无结果 | 2 条通过 |
| `admin/src/views/settings/components/mv-panel.tmp.spec.ts` | 开关方向、保存载荷、恢复默认、`canWrite` 门控、`/settings` 禁用 | 4 条通过 |
| `admin/src/views/settings/mv-settings-view.tmp.spec.ts` | TOC/分类卡片/锚点/搜索项一致性 | 1 条通过 |
| `admin/src/stores/mv-store.tmp.spec.ts` | 500 时 fail-open + 全局错误 toast | 1 条通过（**问题 S-2**） |
| `backend-ts/src/settings/mv-route.tmp.spec.ts` | 端点无需 `settings:read`、GET/ PUT/ batch 校验与 `/settings` 变体、审计覆盖 | 6 条通过（**问题 S-1** 的审计断言在内） |

清理核对：`git status --porcelain` 与审查开始时一致（47 项），无任何 `*.tmp.spec.ts` 残留，未修改白名单内外的既有文件。
