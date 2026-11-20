# 管理后台菜单可见性配置技术方案（部署级隐藏不用的功能菜单）

- 状态：待实施
- 日期：2026-11-03
- 需求来源：用户提案——管理后台 22 个菜单在真实部署中常用不到一半，一律全量展示反而碍事；希望在「系统设置」里增加菜单可见性配置，管理员可按部署场景隐藏部分功能菜单
- 已确认决策（2026-11-03）：① 配置范围为**部署级全局**（管理员配一次、所有账号生效），不做每用户偏好；② 仅「系统设置」一个菜单不可隐藏，其余 21 项均可藏（隐藏「用量分析」后首页降级链自动落到下一个可见有权限页）
- 规模：小~中（约 1~1.5 人日；**1 个数据库迁移**，不动执行内核 / Agent 运行时 / 权限模型 / 桌面端 / 安卓）

## 1. 需求背景

### 1.1 现状（代码可查）

| 断点 | 现状 | 代码证据 |
|---|---|---|
| 菜单与路由完全分离 | 侧栏菜单不是从路由生成，而是 `utils/menuNav.ts` 里静态声明的 `menuGroups`：5 个分组（overview / capability / runtime / security / system）共 22 项，`MenuItemDef { index, label, icon, permission? }`，`index` 即路由路径且有唯一性单测守卫 | `admin/src/utils/menuNav.ts:27-95`、`menuNav.spec.ts:11-14` |
| 菜单只按权限过滤 | `SideMenu.vue` 的 `canSee(item)` 仅判 `item.permission`；`visibleGroups` 再剔除变空的分组。搜索（⌘K）、键盘导航、折叠态全部从 `visibleGroups` 派生，过滤链是单一入口 | `admin/src/components/SideMenu.vue:227-248` |
| 同一组件双实例 | 桌面宽屏侧栏与窄屏抽屉都挂 `SideMenu`，computed 在组件内，两处过滤天然一致 | `admin/src/components/Layout.vue`（SideMenu 双挂载） |
| 首页降级链写死 | `pickHomePath(hasPermission)` 按 analytics → session → agent → user → settings → model 顺序降级，4 个调用点（Logo 回首页、TabBar 首页签、403 页、路由守卫 `/analytics` 特判） | `admin/src/utils/home.ts:2-10`；`SideMenu.vue:306`、`Layout.vue:143`、`ForbiddenView.vue:21,25`、`router/index.ts:228` |
| 全局配置存储现成 | `system_setting` 表（key-value + category），`settings.service.ts` 提供 `getValue / update / updateBatch / validateValue`；路由 `GET /v1/system-settings`（settings:read）、`PUT /v1/system-settings/:key` 与 `/batch`（settings:write） | `db/migration/V048__admin_governance_console.sql:21-30`（V093 改 TEXT）；`settings.service.ts:193-260`、`:785` 起；`settings.routes.ts:48-88` |
| 设置页支持专属面板 | `SystemSettingsView.vue` 的 `TOC_GROUPS` 已支持 7 种 section kind（company-sso / ecp / shell-env / container-hosts / container-rebuild / integration / category），`SPECIAL_KEYS` 机制把走专属面板的 key 从通用分类卡片、「其他」兜底、未保存检查中统一排除 | `SystemSettingsView.vue:304-377`、`:389-392`、`:633-656`、`:885-894` |
| 开关类配置有标准范式 | `auth.password.enabled`（V179）示范了完整链路：迁移播种 + service getter + validateValue 分支；`RuntimeModeResolver` 等示范了保存后 invalidate | `V179__password_login_enabled.sql`、`settings.service.ts:43-44`、`:786-794` |

### 1.2 要解决的问题

1. 单实例部署往往只用部分能力（如只用飞书、不用钉钉；不用开放调用、信号哨兵），22 个菜单全量展示，找常用功能要滚动 + 搜索。
2. 隐藏需求是**部署级全局**的（这个实例不装钉钉，所有运营账号都不该看到「钉钉机器人」），不是个人偏好。
3. 隐藏必须**可逆、有兜底**：配置入口本身（系统设置）不能被藏掉，误操作要能一键恢复。

### 1.3 关键事实（设计建立在其上）

- 菜单 index 唯一且有单测守卫（`menuNav.spec.ts:11-14`），以 index（路由路径）作为配置标识符稳定可靠。
- `visibleGroups` 是菜单渲染的唯一数据源，在此叠加一层过滤即可同时覆盖侧栏、抽屉、⌘K 搜索、键盘导航——不需要改任何交互代码。
- `system_setting.value` 恒为字符串，复合配置存 JSON 字符串是既有约定（`auth.companySso.config`、`tools.http.privateAllowlist` 等先例）。
- `validateValue(key, value)` 是后端唯一 per-key 校验中心，`update()` / `updateBatch()` 都经过它；新增分支即自动获得保存期校验。
- `settings.service.ts` 的缺省语义有明确先例：缺行/空值的 getter 自行给默认（`passwordLoginEnabled()` 缺省 true，`shareTokenLinksEnabled()` 缺省 false，注释在 `:210-212`）。
- 前端 fail-open 有先例：`SideMenu.vue:200-204` localStorage 解析失败即放弃持久化、按无配置渲染。
- 管理后台登录态校验集中在路由守卫：`router.beforeEach` 先 `fetchUserInfo()`（fail-closed），再按 `meta.permission` 放行（`router/index.ts:198-255`）。
- 专属面板的调用约定统一：props 收 `can-write`，保存成功 `emit('saved')` 由父级 `fetchSettings()` 重拉（`SystemSettingsView.vue:48-91`）。
- 最新迁移为 V180（`V180__backfill_session_source_feishu.sql`），CHANGELOG 顶部版本 0.0.420，本功能落 0.0.421。
- 审计拦截器覆盖 `/v1/**`（排除 auth/ws），菜单配置的写入自动留痕，无需额外埋点。

## 2. 需求描述

### 2.1 要做的

1. **后端（`settings` 域 + 1 个迁移）**：
   - 新设置行 `admin.menu.hidden`：value = JSON 数组，元素为被隐藏菜单的路由路径（index）；空数组 / 缺行 = 全部显示。
   - `settings.service.ts`：导出 `ADMIN_MENU_HIDDEN_KEY` 与纯函数 `parseAdminMenuHidden(raw)`；新增 `getAdminMenuHidden(): Promise<string[]>`（fail-open：坏 JSON / 非数组 / 缺行一律 `[]`）；`validateValue` 增加形状校验分支（JSON 数组、元素为 `/` 开头字符串、去重后 ≤ 64 项、禁止 `/settings`）。
   - `settings.routes.ts`：新增 `GET /v1/system-settings/menu-visibility`，**仅要求登录、不要求 `settings:read`**（无设置读权限的运营角色也要按部署配置过滤菜单），返回 `{ hidden: string[] }`。
2. **前端（admin，4 处接入 + 1 store + 1 面板）**：
   - 新增 Pinia store `admin/src/stores/menu.ts`：`hidden / loaded / isHidden(index) / fetch() / setHidden(list)`；`fetch()` 失败按「全部显示」处理并标记 loaded，不阻断导航。
   - 路由守卫在 `fetchUserInfo()` 之后、权限校验之前，首次进入时 `await menuStore.fetch()`（首屏即正确过滤；后续导航不再请求）。
   - `utils/menuNav.ts` 新增纯函数 `applyMenuVisibility(groups, hidden)`；`SideMenu.vue` 的 `visibleGroups` 在权限过滤之上再叠加可见性过滤（侧栏 / 抽屉 / 搜索 / 键盘导航自动同时生效）。
   - `utils/home.ts` 的 `pickHomePath(hasPermission, isHidden?)` 增加可选第二参（谓词，默认全不隐藏），首页降级链跳过被隐藏的菜单；4 个调用点显式传入 `menuStore.isHidden`。
   - `SystemSettingsView.vue` 新增 section kind `'menu-visibility'`，挂在「平台与运维」目录组首节，label「菜单可见性」；`admin.menu.hidden` 加入 `SPECIAL_KEYS`（从通用分类卡片、「其他」兜底、未保存检查中排除，数据仍随全量拉取返回）。
   - 新增专属面板 `admin/src/views/settings/MenuVisibilityPanel.vue`：按 5 个分组渲染全部 22 个菜单项的显示开关（label + 路由路径），组级「全选 / 全不选」，底部「恢复默认（全部显示）」与「保存」；「系统设置」项开关禁用并提示不可隐藏；保存走既有 `PUT /system-settings/:key`，成功后 `menuStore.setHidden()` **即时生效**（无需刷新页面）并 `emit('saved')`；写操作沿用 `canWrite`（settings:write）门控。
3. **迁移**：`V181__admin_menu_visibility.sql` 播种该行（`editable=1, is_secret=0`，category=`管理后台`）。
4. **测试与交付同步**：后端 service spec、admin menuNav/home 纯函数 spec；CHANGELOG 0.0.421「管理后台」小节；README 管理后台描述补一句。

### 2.2 明确不做的

- **不做** per-user 菜单偏好（`preference` 域那套）：需求是部署级全局配置，一个实例一份。
- **不做**菜单排序、自定义分组、拖拽布局：本期只做显隐。
- **不做**「隐藏 = 收回访问权限」：路由表、路由守卫的 `meta.permission` 校验、直接输入 URL 访问**一律不变**。隐藏仅影响侧栏/抽屉/首页降级链的可见性（语义边界见 D8）。需要真正的访问控制请用现有「角色权限」。
- **不做**多标签页实时同步：A 标签页改配置，B 标签页刷新后一致；运行中不同步（已知取舍，配置变更频率极低）。
- **不做**「系统设置」菜单的隐藏（后端校验 + 前端禁用双重禁止，见 D2）。
- **不做**桌面端 / 安卓 / agent-cli / skills-mao-cli 的任何改动：菜单体系为 admin 独有。
- **不做** shared/contracts 新增枚举：无跨端枚举外溢（读取端点与响应仅 admin 消费）。
- **不做** admin 组件级测试框架与 Playwright 新用例（admin 单测面为纯函数/utils，CI 不跑 Playwright）：面板靠 `npm run build` + 手工验收清单。

## 3. 技术选型（已定案）

| # | 决策点 | 定案 | 理由 |
|---|---|---|---|
| D1 | 存储形态 | 单条 `system_setting` 行 `admin.menu.hidden`，value = JSON 数组，**存「隐藏集」而非「显示集」** | 存隐藏集：缺行/空数组 = 全部显示，与升级前行为一致；未来新增菜单默认可见，前向兼容。存显示集则每次加菜单都要改配置 |
| D2 | 「系统设置」不可隐藏 | 后端 `validateValue` 拒绝含 `/settings` 的值；前端面板该项 switch disabled + 提示 | 配置入口自身被藏后，管理员虽可直输 URL 找回，但体验割裂且容易误判「功能丢了」；后端拒收是防御纵深（防绕过前端的直接调 API） |
| D3 | 读取通道 | 新端点 `GET /v1/system-settings/menu-visibility`（`requireUserId` 即可，不校验权限码），返回 `{ hidden: string[] }` | 复用 `GET /v1/system-settings` 不行：它要 `settings:read`，普通运营角色没有，菜单就过滤不了。不扩展 `/v1/auth/features`：那是公开端点、语义是登录方式 feature flag 且桌面端共用契约，混入 admin 菜单配置不纯。新端点只暴露隐藏路径列表，不透出任何其它配置值 |
| D4 | 读取失败语义 | fail-open：请求异常 / 坏数据一律按 `[]`（全部显示）处理，`loaded` 仍置 true，不阻断导航 | 配置读取失败不该挡住整个后台使用；「多看几个菜单」远好于「白屏进不去」。与 `SideMenu` localStorage 解析失败的既有取舍一致 |
| D5 | 前端加载时机 | 路由守卫内 `fetchUserInfo()` 之后、权限校验之前：`if (!menuStore.loaded) await menuStore.fetch()` | 守卫本来就 await 用户信息（首屏必经之路），搭车一次轻量 GET 即首屏正确过滤；登录流程（`login()` 已 await `fetchUserInfo`）进入工作台时同样覆盖。后续导航 `loaded=true` 零请求 |
| D6 | 过滤落点 | `menuNav.ts` 新增纯函数 `applyMenuVisibility(groups, hidden)`；`SideMenu.visibleGroups` = 权限过滤 ∘ 可见性过滤 | `visibleGroups` 是菜单渲染唯一数据源，搜索/键盘/折叠全从其派生，一处过滤全端生效；纯函数可单测、无 store 依赖 |
| D7 | 首页降级链 | `pickHomePath(hasPermission, isHidden = () => false)` 增加可选谓词参数，4 个调用点传 `menuStore.isHidden` | 隐藏「用量分析」后 Logo / 返回首页应落到下一个可见且有权限的页面，而非跳到一个菜单里不存在的页面；默认参数保持纯函数旧用法兼容 |
| D8 | 语义边界（写进文档与 UI 提示） | 菜单隐藏 ≠ 访问控制：路由、守卫权限校验、URL 直访均不变 | 防止管理员误以为「藏了 = 收权了」而造成安全误解；面板内放常驻说明文案 |
| D9 | 未知 / 过期 index | 读时前端与 `menuGroups` 求交集（`applyMenuVisibility` 对未知 id 天然无操作）；保存只做形状校验，不校验 id 是否存在 | 后端不镜像前端菜单目录（单一事实来源在 `menuNav.ts`）；未来删/改菜单后旧 id 静默失效，不报错 |
| D10 | 配置面板载体 | 新专属面板 `MenuVisibilityPanel.vue`（kind `'menu-visibility'`），挂「平台与运维」目录组首节；key 加入 `SPECIAL_KEYS` | 值是 JSON 数组，不能走通用分类卡片的输入框/switch 渲染；`SPECIAL_KEYS` 同时把它从「其他」兜底分类和未保存检查中排除（与 container-hosts 等专属面板同等对待） |
| D11 | 保存与即时生效 | `PUT /v1/system-settings/admin.menu.hidden`（body `{ value: JSON.stringify(hidden) }`）→ 成功即 `menuStore.setHidden(hidden)` + `emit('saved')` 父级重拉 | 复用既有写路径与审计；store 本地更新让侧栏即时刷新，保存「系统设置」页所在会话无感 |
| D12 | 多标签页 | 运行中不同步，刷新后一致 | 部署级配置变更频率极低；做 storage 事件广播属过度设计 |

## 4. 实现步骤

### 4.1 后端（`backend-ts`）

**① 迁移 `backend-ts/db/migration/V181__admin_menu_visibility.sql`**（新文件）：

```sql
-- V181: 管理后台菜单可见性配置。value = JSON 数组，元素为被隐藏菜单的路由路径；
-- 空数组 / 缺行 = 全部显示，与升级前行为一致。「系统设置」不可隐藏（后端校验拒绝）。
INSERT IGNORE INTO `system_setting` (`setting_key`, `value`, `category`, `description`, `editable`, `is_secret`) VALUES
('admin.menu.hidden', '[]', '管理后台', '管理后台侧边菜单隐藏列表（JSON 数组，元素为菜单路由路径，如 ["/dingtalk-bots"]；空数组=全部显示；系统设置不可隐藏）', 1, 0);
```

**② `backend-ts/src/settings/settings.service.ts`**：

- 常量区（约 `:97` `SHARE_TOKEN_LINKS_ENABLED_KEY` 附近）追加：

```ts
/** 管理后台侧边菜单隐藏列表（JSON 数组，元素为菜单路由路径）。缺行 / 空值 / 解析失败 = 全部显示。 */
export const ADMIN_MENU_HIDDEN_KEY = 'admin.menu.hidden';
/** 隐藏列表长度上限，防异常大值。 */
const ADMIN_MENU_HIDDEN_MAX = 64;
```

- 模块级纯函数（文件末尾或常量区附近，导出供单测）：

```ts
/** 解析隐藏列表：容错（坏 JSON / 非数组 / 非字符串元素 / 重复项全部忽略或去重），永不抛错。 */
export function parseAdminMenuHidden(raw: string | null | undefined): string[] {
  if (raw == null || raw.trim() === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== 'string') continue;
      const path = item.trim();
      if (path === '' || !path.startsWith('/') || out.includes(path)) continue;
      out.push(path);
    }
    return out;
  } catch {
    return [];
  }
}
```

- getter（放在 `shareTokenLinksEnabled()` 附近，与其它布尔/文本 getter 同风格）：

```ts
/** 管理后台菜单隐藏列表（缺省全部显示）。 */
async getAdminMenuHidden(): Promise<string[]> {
  return parseAdminMenuHidden(await this.getValue(ADMIN_MENU_HIDDEN_KEY));
}
```

- `validateValue`（`:785` 方法体最前，与 `PASSWORD_LOGIN_ENABLED_KEY` 分支并列——必须在 `if (!hasText(value)) return;`（`:821`）**之前**，否则空值会被提前放行、收不到「恢复默认」以外的形状校验；同时空串本身要允许=恢复默认）：

```ts
if (key === ADMIN_MENU_HIDDEN_KEY) {
  this.validateAdminMenuHidden(value);
  return;
}
```

```ts
private validateAdminMenuHidden(value: string | null | undefined): void {
  const raw = (value ?? '').trim();
  // 空值 / 空数组 = 恢复全部显示
  if (raw === '' || raw === '[]') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '菜单隐藏配置必须是 JSON 数组');
  }
  if (!Array.isArray(parsed)) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, '菜单隐藏配置必须是 JSON 数组');
  }
  const seen = new Set<string>();
  for (const item of parsed) {
    if (typeof item !== 'string' || !item.startsWith('/')) {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '菜单隐藏配置的元素必须是以 / 开头的路由路径');
    }
    if (item === '/settings') {
      throw new BusinessException(ErrorCode.PARAM_INVALID, '「系统设置」不可隐藏，否则将无法恢复菜单配置');
    }
    seen.add(item);
  }
  if (seen.size > ADMIN_MENU_HIDDEN_MAX) {
    throw new BusinessException(ErrorCode.PARAM_INVALID, `菜单隐藏配置最多 ${ADMIN_MENU_HIDDEN_MAX} 项`);
  }
}
```

**③ `backend-ts/src/settings/settings.routes.ts`**（`registerSystemSettingRoutes` 内，`GET /v1/system-settings` 之后新增）：

```ts
// 管理后台菜单可见性（部署级全局配置）：仅要求登录，不要求 settings:read——
// 没有设置读权限的运营角色也要按部署配置过滤侧栏菜单。只暴露隐藏路径列表。
app.get('/v1/system-settings/menu-visibility', async (request, reply) => {
  requireUserId(request);
  return sendOk(reply, { hidden: await systemSettingService.getAdminMenuHidden() });
});
```

写入路径零改动：`PUT /v1/system-settings/:key`（key 含 `.` 有既有先例，如 `runtime.container.extraHosts`）自动经 `validateValue` 与审计拦截器。

### 4.2 前端（`admin`）

**① 新 store `admin/src/stores/menu.ts`**：

```ts
import { defineStore } from 'pinia'
import { ref } from 'vue'
import { api } from '../api'

/** 管理后台菜单可见性（部署级全局配置）：被隐藏菜单的路由路径（menuNav 的 index）。 */
export const useMenuStore = defineStore('menu', () => {
  const hidden = ref<string[]>([])
  const loaded = ref(false)

  function isHidden(index: string): boolean {
    return hidden.value.includes(index)
  }

  /** fail-open：请求失败按「全部显示」处理，不阻断后台使用。 */
  async function fetch() {
    try {
      const { data } = await api.get('/system-settings/menu-visibility')
      hidden.value = Array.isArray(data?.hidden)
        ? data.hidden.filter((v: unknown): v is string => typeof v === 'string')
        : []
    } catch {
      hidden.value = []
    } finally {
      loaded.value = true
    }
  }

  /** 设置页保存成功后本地即时生效，无需刷新页面。 */
  function setHidden(list: string[]) {
    hidden.value = [...list]
    loaded.value = true
  }

  return { hidden, loaded, isHidden, fetch, setHidden }
})
```

**② `admin/src/router/index.ts`**（守卫内，`:223` `fetchUserInfo` 的 catch 之后、`:224` 权限校验之前插入）：

```ts
const menuStore = useMenuStore()
if (!menuStore.loaded) await menuStore.fetch()
```

`fetch()` 内部 fail-open 不抛错，不会影响守卫既有 fail-closed 语义。同文件 `:228` 的 `/analytics` 特判调用改为 `pickHomePath((p) => authStore.hasPermission(p), (i) => menuStore.isHidden(i))`。

**③ `admin/src/utils/menuNav.ts`**（`filterMenuGroups` 之后追加纯函数）：

```ts
/**
 * 按部署级隐藏配置过滤菜单：命中 index 的项移除，变空的组整组剔除。
 * 未知 index 静默忽略（菜单删改后旧配置不报错）；空数组原样返回。
 */
export function applyMenuVisibility(groups: MenuGroupDef[], hidden: readonly string[]): MenuGroupDef[] {
  if (hidden.length === 0) return groups
  const hiddenSet = new Set(hidden)
  return groups
    .map(group => ({ ...group, items: group.items.filter(item => !hiddenSet.has(item.index)) }))
    .filter(group => group.items.length > 0)
}
```

**④ `admin/src/components/SideMenu.vue`**（`:227-235`，`canSee` 不变，`visibleGroups` 叠加过滤）：

```ts
import { applyMenuVisibility, filterMenuGroups, flattenMenuItems, menuGroupIdByPath, menuGroups } from '../utils/menuNav'
import { useMenuStore } from '../stores/menu'
// ...
const menuStore = useMenuStore()

const visibleGroups = computed(() =>
  applyMenuVisibility(
    menuGroups.map(group => ({ ...group, items: group.items.filter(canSee) })),
    menuStore.hidden
  ).filter(group => group.items.length > 0)
)
```

搜索（`displayedGroups`）、键盘导航（`flatItems`）、折叠自动展开（`activeMenu` watch 用的 `menuGroups` 是全集，高亮逻辑不受影响）均无需改动。`:306` `goHome` 改为 `pickHomePath((p) => authStore.hasPermission(p), (i) => menuStore.isHidden(i))`。

**⑤ `admin/src/utils/home.ts`**：

```ts
/** 登录后的落地页……isHidden：部署级隐藏的菜单（menuStore.isHidden），降级链跳过隐藏项。 */
export function pickHomePath(
  hasPermission: (permission: string) => boolean,
  isHidden: (index: string) => boolean = () => false
): string {
  if (hasPermission('analytics:read') && !isHidden('/analytics')) return '/analytics'
  if (hasPermission('session:read') && !isHidden('/sessions')) return '/sessions'
  if (hasPermission('agent:read') && !isHidden('/agents')) return '/agents'
  if (hasPermission('user:read') && !isHidden('/users')) return '/users'
  if (hasPermission('settings:read') && !isHidden('/settings')) return '/settings'
  if (hasPermission('model:read') && !isHidden('/models')) return '/models'
  return '/forbidden'
}
```

其余 3 个调用点（`Layout.vue:143`、`ForbiddenView.vue:21,25`）同样显式传入 `menuStore.isHidden`（`ForbiddenView` 的 `canGoHome` computed 一并传）。

**⑥ `admin/src/views/settings/SystemSettingsView.vue`**：

- `TOC_GROUPS`（`:304`）`TocSection.kind` 联合类型加 `'menu-visibility'`；「平台与运维」组（`:366-376`）首节插入 `{ kind: 'menu-visibility', name: 'menu-visibility' }`。
- 常量区加 `const ADMIN_MENU_HIDDEN_KEY = 'admin.menu.hidden'`，并加入 `SPECIAL_KEYS`（`:389-392`）——`categories` / `settingsByCategory` / `hasUnsavedEdits` 均已统一跳过 `SPECIAL_KEYS`，因此不会进通用分类卡片、「其他」兜底与未保存确认，但数据仍随 `GET /system-settings` 全量返回。
- 模板 `v-else-if` 链（`:49-76`）在 `company-sso` 之前加：`<MenuVisibilityPanel v-else-if="section.kind === 'menu-visibility'" :can-write="canWrite" @saved="fetchSettings" />`（与其它专属面板调用约定一致）。
- `tocGroups` 的 id/label 映射（`:687-706`）加分支：id `setting-group-menu-visibility`，label `菜单可见性`。

**⑦ 新面板 `admin/src/views/settings/MenuVisibilityPanel.vue`**：

- 数据源：`menuGroups`（静态导入）+ `useMenuStore()`。本地 draft = `ref<Set<string>>(new Set(menuStore.hidden))`，`onMounted` 时若 `!menuStore.loaded` 先 `await menuStore.fetch()` 再初始化 draft（面板被 keepAlive 缓存时以 store 为准）。
- 渲染：5 个分组各一节，组标题右侧「全选 / 全不选」文字按钮；每项一个 `el-switch`（开=显示），主文案 label、副文案路由 index（灰色小字）；`/settings` 项 `disabled` + 提示「系统设置不可隐藏」。
- 顶部常驻说明（对应 D8 语义边界）：「隐藏仅影响侧边栏菜单展示，不影响访问权限；被隐藏页面的路由与权限校验不变，仍可通过网址直接访问。如需收回访问权限，请使用「角色权限」。」
- 底部操作：「恢复默认（全部显示）」（draft 清空即 `[]`，需保存生效）与「保存」；保存按钮在 `canWrite` 为假或 draft 与 `menuStore.hidden` 一致时禁用。
- 保存：`await api.put('/system-settings/admin.menu.hidden', { value: JSON.stringify([...draft.value]) })` → `menuStore.setHidden([...draft.value])` → `ElMessage.success('菜单可见性已保存')` → `emit('saved')`（父级 `fetchSettings()` 重拉，保持页面数据新鲜）。失败沿用 axios 拦截器统一报错。
- 未保存检查：key 在 `SPECIAL_KEYS` 中，`hasUnsavedEdits()` 天然不覆盖本面板——与 container-hosts / container-rebuild 等专属面板现状一致（本期不扩大 `onActivated` 确认框范围，避免牵连既有面板语义）。

### 4.3 测试与构建

1. `backend-ts/src/settings/settings.service.spec.ts`：
   - `parseAdminMenuHidden`：`null` / 空串 / 坏 JSON / 非数组 / 含非字符串元素 / 重复项 / 合法数组（去重、保序、忽略空白项）。
   - `validateValue('admin.menu.hidden', …)`（经 `update()` 或直接触发）：合法 JSON 数组通过；`'{}'` / 坏 JSON / 元素不以 `/` 开头 / 含 `/settings` / 超 64 项 → `PARAM_INVALID`；空串与 `'[]'` 通过。
   - `getAdminMenuHidden()`：缺行 → `[]`（用既有 repo mock 模式）。
2. `admin/src/utils/menuNav.spec.ts`：`applyMenuVisibility`——空数组原样返回（同一引用）；命中项移除、空组整组剔除、未知 index 忽略、保留组标题与顺序。
3. 新建 `admin/src/utils/home.spec.ts`：`pickHomePath` 带 `isHidden` 时降级链跳过隐藏项（如隐藏 `/analytics` → `/sessions`）；不传第二参时行为与现在逐字一致（回归保护 4 个调用点的默认语义）。
4. `cd admin && npm test`（vitest 纯函数面）、`cd backend-ts && npm test`、`cd admin && npm run build`（vue-tsc + vite，勿用 `npx vue-tsc --noEmit` 假通过）。

### 4.4 手工验收清单（发版前）

1. 隐藏「钉钉机器人 / 开放调用」→ 侧栏与窄屏抽屉同步消失；⌘K 搜索「钉钉」无结果；键盘 ↑↓ 不经过该项。
2. 直接输入 URL `/dingtalk-bots` 仍可打开（证明隐藏 ≠ 收权）；无 `dingtalk-bot:read` 权限的账号行为不变。
3. 刷新页面 / 重新登录后配置仍生效；「恢复默认」后全部回来。
4. 隐藏「用量分析」→ 点 Logo / 返回首页落到「会话管理」（或下一个可见有权限页）；TabBar 不可关闭首页签跟随。
5. 无 `settings:read` 的运营角色登录：菜单同样按部署配置过滤（验证 D3 端点不做权限码校验）；且该角色访问 `/settings` 仍被守卫弹 `/forbidden`（权限模型未被动过）。
6. 设置页保存后侧栏即时刷新，无需 F5；多标签页场景：另一标签页刷新后一致。
7. 「系统设置」项开关禁用；用 curl 直接 `PUT /v1/system-settings/admin.menu.hidden` 提交含 `/settings` 的值被 400 拒绝（防御纵深生效）。

## 5. 风险与回滚

| 风险 | 影响 | 缓解 |
|---|---|---|
| 管理员误藏菜单后找不到入口 | 找不到配置入口 | 「系统设置」双重禁隐；面板内「恢复默认」；URL 直访兜底；隐藏 ≠ 收权，页面始终可达 |
| 配置读取接口异常 | 菜单过滤失效 | fail-open 全显示（D4），后台可用性优先 |
| 升级兼容 | 老实例无此行 | `INSERT IGNORE` 播种 + 缺行即全显示，与升级前行为逐字一致 |
| 未来菜单删改 | 配置里留过期 index | 读时交集忽略（D9），保存仅形状校验，不报错 |
| 前端绕过校验直写坏值 | 渲染异常 | `parseAdminMenuHidden` 容错 + 后端 `validateValue` 形状校验双重兜底 |
| 误以为隐藏=安全 | 安全误解 | 语义边界写进方案（D8）、面板常驻文案、CHANGELOG 明示 |

**回滚**：代码回滚后该设置行无任何消费方（端点、面板、store 一并消失），行留在表中无害；紧急恢复菜单 = 把 `admin.menu.hidden` 值改回 `'[]'`（设置页「恢复默认」或直接 SQL）。

## 6. 交付检查（AGENTS.md 要求）

1. **CHANGELOG.md**：顶部新建 `## 0.0.421 (2026-11-03)`，「管理后台」小节说明：系统设置新增「菜单可见性」配置，可按部署场景隐藏不用的功能菜单（部署级全局生效、隐藏不影响访问权限、「系统设置」不可隐藏、可一键恢复默认）。
2. **README.md**：管理后台功能描述补一句菜单可见性配置（历史设计与 review 文档除外，README 在必更列表）。
3. **DEPLOY.md / skills/mao-cli**：无部署变化、无 CLI 命令面变化，不改。
4. 版本流程按 AGENTS.md：`./scripts/changelog-extract.sh 0.0.421`；desktop/package.json 版本用 `sync-desktop`（本任务无前端发版内容，仅文档提及）。
