# 管理后台集成 Web Embed SDK（浮窗对话）技术方案

- 日期：2026-10-16
- 状态：设计已确认，待开发（2026-10-16 评审后修订：修正配置 UI 挂载路径、补 dev 代理与保存期校验，见 §4.2.1 / §4.3.1 / §5）
- 范围：`admin`（管理后台）、`backend-ts`（新增 1 个配置项 + 1 个只读接口）、部署接线与文档。**不改 `sdk/embed` 源码**（SDK 现有能力已满足本需求，全部通过既有公开 API 消费）。

## 1. 需求背景

Mao 已有 Web Embed SDK（`sdk/embed`，产物 `desktop/public/embed/mao-chat.js`，gzip 约 106KB），供内部 Web 业务系统以「一个脚本 + 一次 `MaoChat.init()`」嵌入 agent 对话浮窗，已具备流式对话、思考过程、工具执行状态、追问作答、手动停止、历史会话、页面操作（`page_*`）、上下文注入、公司 SSO 换票等完整能力，并已在外部宿主验证。

但 **Mao 自己的管理后台（`admin`）尚未接入这个 SDK**：管理员在后台做运维（看会话、配 Agent、查用量）时，想问助手「这个页面是干什么的」「帮我把这个 Agent 的提示词改一下」只能切到桌面端，链路割裂。

本需求把管理后台变成 Embed SDK 的第一个「自家宿主」：在 admin 引入 SDK 实现浮窗对话，验证 SDK 作为内部标准接入方案的可复用性，同时给管理员一个随时可用的页面助手。

### 为什么不是其他方案

| 备选方案 | 结论 | 原因 |
|---|---|---|
| 后台里再写一套聊天 UI | 不做 | 重复实现消息流 / WS / 重连 / 工具渲染，与 SDK 双份维护 |
| iframe 嵌 desktop 对话页 | 不做 | 已被 `docs/plan/2026-09-04-embed-sdk-technical-design.md` 明确否决（无法沉淀独立契约），且拿不到页面上下文 |
| 后台顶栏自绘入口 | 本期不做 | 保留 SDK 自带浮动按钮，与外部宿主行为一致、零额外 UI 开发；后续如需融合 admin 视觉可另立方案 |
| 走公司 SSO 换票 | 不做 | admin 用户本身就是 Mao 用户、已持有 Mao access token，绕 SSO 换票是绕远路 |

## 2. 需求描述

### 2.1 目标

管理员登录管理后台后，页面右下角出现 Mao 助手浮动入口；点击展开浮窗，可就当前后台页面与配置的 Agent 对话（流式输出、思考过程、工具状态、追问作答、手动停止、历史会话、粘贴附件）。浮窗接入 Mao 现有账号体系与权限体系，不新增用户侧鉴权链路。

### 2.2 本期功能边界（要做）

1. **接入**：`admin/index.html` 以 `<script>` 引入已发布 SDK 产物 `/embed/mao-chat.js`，与外部宿主接入形态完全一致。
2. **鉴权**：`getToken` 模式复用 admin 登录态（`localStorage.token`），零后端鉴权改造；token 失效时 SDK 重取（admin axios 拦截器 refresh 成功后已写回新 token）。
3. **Agent 配置**：新增系统配置项 `embed.agentId`（管理后台「系统设置」内选择），并可回落系统默认 Agent。
4. **配置读取**：新增只读接口 `GET /v1/embed/admin-config`，任何登录用户可读，不要求 `settings:read`。
5. **浮窗入口**：右下角浮动按钮 + 浮窗，保留 SDK 默认行为（含运行状态、未读红点、历史面板、新对话）。
6. **页面上下文**：采集路由 `name`/`path`/`params`/`query`（结构性信息），供 Agent 理解当前页面；**禁止采集表格数据行与表单值**。
7. **页面操作**：开放 `page_*` 工具，默认 `per_action`（每个写操作前在浮窗确认）；`full` 授权仍只能由用户在浮窗内显式授予（宿主 API 无法静默提权，这是 SDK 既定约束）。
8. **登出联动**：`authStore.logout()` 时同步销毁 SDK 实例，入口与浮窗一并移除；token 被清（`clearAuth`）时同样销毁。
9. **部署接线**：产物由 desktop 部署提供（Nginx root 已覆盖 `/embed/`），`deploy-admin.sh` 无需改构建逻辑。

### 2.3 本期明确不做

- **不改 `sdk/embed` 源码**：不新增 SDK 选项、不改默认行为、不发新 SDK 版本。若后续需要 admin 专属能力（如主题跟随 admin 暗色模式、顶栏入口），另立 SDK 迭代方案。
- **不做移动端专属适配**：浮窗按桌面浏览器设计（SDK 自带窄屏基础适配即用，不为 admin 追加断点逻辑）。
- **不做「把当前后台会话丢给浮窗继续问」等深度整合**：属增强项，另立方案。
- **不做会话管理「来源」筛选/列**：浮窗会话 `source=embed` 在后台会话管理列表原样可见、可检索、可删除，不增加区分能力。
- **不做新的权限码**：浮窗对所有登录用户可见可用，不新增 `embed:use` 之类权限点。
- **不做 SSO 换票接入**：admin 不引入 `auth.company-sso` 模式。
- **不改后端 WS / 会话 / 工具链路**：`source=embed`、`client=embed`、`page_*` 工具链均已实现，零改动。
- **不做 CSP 改造**：admin 同源加载 `/embed/mao-chat.js` 与同源 WS，无跨域、无新增 `connect-src` 需求（详见 §6.3）。

## 3. 技术选型

| 项 | 选型 | 理由 |
|---|---|---|
| SDK 引入方式 | `<script src="/embed/mao-chat.js">`（IIFE 产物） | 与外部宿主接入形态完全一致；admin 与外部宿主跑同一份产物，SDK 升级只需更新产物文件 |
| 鉴权 | SDK `getToken` 模式，回调读 admin 登录 token | admin 用户即 Mao 用户，零后端改造；SDK 401 / WS 鉴权失败时重新回调，天然适配 admin 的 refresh 逻辑 |
| Agent 配置存储 | `system_setting` 表 + 配置项 `embed.agentId` | 与 `weixin.agentId` 同表、同 key 常量与保存校验模式（V056 先例）；分类与初始值按 admin 场景另定（见 §4.2.1，勿照抄「同分类」） |
| 配置读取接口 | `GET /v1/embed/admin-config`（仅要求登录） | `/v1/system-settings` 要求 `settings:read`，会与「全员可用」冲突；新增轻量接口只返回 `{ agentId }` |
| 前端接入层 | 新增 `admin/src/composables/useEmbedChat.ts` + 挂载点 | 集中管理 init/destroy/登录态联动/上下文采集，避免散落在 `App.vue` 与 `Layout.vue` |
| 页面上下文采集 | `admin/src/utils/embedContext.ts`（纯函数） | 只读 vue-router 当前路由，可单测；不依赖具体页面组件 |
| 测试 | 后端 Vitest（配置项解析 + 新接口）+ admin Vitest（上下文采集与回落逻辑）+ 手动验收 | 符合仓库 CI 惯例（admin 新增 vitest 见 §6.1 的基建说明） |

## 4. 总体设计

### 4.1 数据流

```text
管理员登录 admin
  → authStore 写入 localStorage.token（accessToken，24h）
  → useEmbedChat 读 GET /v1/embed/admin-config 得 agentId（未配置回落系统默认 Agent）
  → MaoChat.init({ serverUrl, agentId, getToken: () => localStorage.token, context: () => embedContext() })
  → 用户展开浮窗：懒连接 WS /api/ws/stream?client=embed（同源 wss）
  → 对话走 CLOUD 服务端执行；page_* 工具经 EmbedPageToolRegistry 回到 admin 页面本地执行
```

### 4.2 后端改动

#### 4.2.1 新增配置项 `embed.agentId`

- key：`embed.agentId`；分类：`集成配置`；可编辑（`editable=1`）；非 secret；`value` 初始 NULL（同 `auth.ldap.*`，V093），读取时 NULL / 空串 / 非数字一律视为未配置。
- 语义：浮窗对话使用的 Agent ID；未配置时由后端在 `GET /v1/embed/admin-config` 内回落系统默认 Agent（复用 `AgentService.getDefaultAgent()`）。
- 与 `weixin.agentId` 的差异（实现时勿按「完全同构」照抄）：weixin 的分类是 `微信`（V056）且初始值为 `''`；embed 选 `集成配置` 是为了作为独立分类 section 挂到「系统设置」页「登录认证」分组下（见下方 UI 路径）。已核实 DB 中 `集成配置` 分类的既有 key（V093 的 24 个 + V094 的 2 个 + V107 `auth.companySso.config` + V111 `auth.ecp.config`）全部被前端 `SPECIAL_KEYS`（= `INTEGRATION_KEYS` ∪ SSO/ECP 两个特例 key）排除、改由 `IntegrationConfigPanel` / 专属面板渲染，因此该分类 section 实际只会出现 `embed.agentId` 一行，不会漏出其他配置项。
- NULL 与空串在读取端无行为差异（`hasText` 均视为未配置），初始 NULL 只为与 `auth.ldap.*` 的「从未设置」表述一致；不为「显式清空」设计单独语义（`el-select` 清空后保存的是 `''`，保存一次后 NULL 永不再现）。
- 迁移：`backend-ts/db/migration/V156__embed_agent_id_setting.sql`（序号按实现时仓库最新迁移递增，本文不锁死编号；当前最新为 V155）。参照 `V093__settings_integration_config.sql`：`INSERT IGNORE INTO system_setting (setting_key, value, category, description, editable) VALUES ('embed.agentId', NULL, '集成配置', '管理后台浮窗助手使用的 Agent ID（留空回落系统默认 Agent）', 1);`。
- 配置编辑 UI（评审修正：**不走 `IntegrationConfigPanel`**）：`IntegrationConfigPanel` 的 `select` 字段类型只支持静态 `options`（`FieldDef.options`），没有异步 Agent 数据源能力；`weixin.agentId` 的 Agent 下拉实际在 `SystemSettingsView.vue:114-130` 硬编码单 key 渲染，数据源是该视图自己的 `agents` ref（`api.get('/agents', { includeDisabled: true })`）。因此「复用 weixin 同款 el-select + 同款数据源」的正确最小改动路径是：
  1. `SystemSettingsView.vue` 把 115 行的硬编码单 key 判断泛化：新增 `const AGENT_SELECT_KEYS = new Set(['weixin.agentId', 'embed.agentId'])`，`v-else-if` 改为 `AGENT_SELECT_KEYS.has(row.settingKey)`；
  2. `TOC_GROUPS` 的「登录认证」分组新增 `{ kind: 'category', name: '集成配置' }`（与公司 SSO、LDAP、飞书相邻，属「接入」类配置）；
  3. 不动 `INTEGRATION_KEYS` / `INTEGRATION_LABELS`——那两个集合服务的是 `IntegrationConfigPanel` 分组渲染，不是后端分类 section。
- 保存期校验（评审补充）：`settings.service.ts` 的 `validateValue()` 对 `weixin.agentId` 有保存校验（非数字 / 不存在 / 已停用 → `PARAM_INVALID`；停用但值未变时豁免保存）。`embed.agentId` 应同构补齐——建议把 agent-id 校验抽成私有方法供两个 key 复用，而不是复制一份。否则管理员可保存一个已停用 Agent，浮窗静默回落默认 Agent，要等排查时才发现。

#### 4.2.2 新增只读接口 `GET /v1/embed/admin-config`

- 路由注册在 `backend-ts/src/embed/embed.routes.ts`（新建，`registerEmbedRoutes(app, deps)`），或挂在既有 settings 域；**推荐新建 `embed` 域**，与「Embed 接入」语义对齐，也为后续 embed 侧配置留位置。
- 权限：仅 `requireUserId(request)`，不调 `requirePermission`。理由：浮窗全员可用，不能因缺 `settings:read` 而不可用。
- 响应：标准 `Result<{ agentId: number | null }>`；`agentId` 为解析后的最终值（配置优先，未配置时返回系统默认 Agent 的 id；连默认 Agent 都没有时返回 `null`，前端不初始化浮窗）。
- 失败路径：配置值非数字 / Agent 不存在 / Agent 已停用 → 回落系统默认 Agent；默认 Agent 也不可用 → 返回 `agentId: null`，**不抛 500**（浮窗不可用不该让后台接口报错）。
- 脱敏：不返回任何其他配置内容。
- 接入细节（评审补充）：`create-app.ts` 的全局 `preHandler` 钩子已对所有非公开路径做 JWT 鉴权（未登录直接 401，`request.userId` 自动注入），`requireUserId(request)` 直接可用，路由内无需再判登录；`onResponse` 审计钩子会自动记录该 GET（只读、无 body，无脱敏负担）。新域目录 `backend-ts/src/embed/` 当前不存在，需新建。

```ts
// backend-ts/src/embed/embed.routes.ts（示意）
app.get('/v1/embed/admin-config', async (request, reply) => {
  requireUserId(request);           // 只要求登录；浮窗全员可用，不查 settings:read
  const configured = await systemSettingService.getValue(EMBED_AGENT_ID_KEY);
  let agentId: number | null = null;
  if (hasText(configured)) {
    try {
      const agent = await agentService.getAgent(Number(configured!.trim()));
      if (agent.enabled === 0) console.warn(`Embed 助手 Agent 已停用 (${configured})，回落默认 Agent`);
      else agentId = agent.id!;
    } catch (e) {
      console.warn(`Embed 助手 Agent 配置无效 (${configured})，回落默认 Agent: ${msg(e)}`);
    }
  }
  if (agentId == null) {
    // 与 weixin/session.service.ts resolveWeixinAgent() 同款回落；默认 Agent 也不存在时返回 null
    const fallback = await agentService.getDefaultAgent().catch(() => null);
    agentId = fallback && fallback.enabled !== 0 ? fallback.id! : null;
  }
  return sendOk(reply, { agentId });
});
```

配置解析严格复刻 `weixin/session.service.ts:102 resolveWeixinAgent()` 的既有写法（`hasText` → `Number(trim())` → `getAgent` 抛错即回落），不发明第二套解析规则。

### 4.3 前端改动

#### 4.3.1 `admin/index.html`

```html
<script src="/embed/mao-chat.js"></script>
```

- 放在 `</body>` 前、模块脚本之后。同源相对路径：生产由 Nginx `location /` 直接命中 `desktop/dist/embed/mao-chat.js`（desktop prebuild `scripts/build-embed-sdk.cjs` 会把 sdk/embed 产物拷入 `desktop/public/embed/` 并附版本化副本，deploy-desktop.sh 构建后生效）。**admin 不复制、不打包该产物**，避免两份产物版本漂移。
- dev 需补两处代理（评审补充，否则验收 #1 在 dev 下无法执行）：admin vite `server.proxy` 目前只有 `/api`（`admin/vite.config.ts`），① `/embed/mao-chat.js` 会 404 → `window.MaoChat` 为 undefined → `useEmbedChat` 静默不初始化；② `/api` 代理未开 `ws: true`，SDK 的 `ws://…/api/ws/stream` 升级请求不通。修正：proxy 增加 `'/embed': { target: 'http://localhost:5201', changeOrigin: true }`（desktop dev server 端口 5201，由 `public/` 目录提供该文件）+ `/api` 代理补 `ws: true`。备选：dev 下把 `serverUrl` 直连 `http://localhost:9080`（后端 CORS 对非 exchange 路径为 `origin: true` + `credentials: true`，WS 不校验 Origin，外部宿主已验证可行），但同源代理拓扑与生产一致，优先前者。注意 dev 下需同时跑 desktop dev server（:5201）供 `/embed` 代理。

#### 4.3.2 `admin/src/composables/useEmbedChat.ts`

职责（单文件，约 120 行）：

1. **初始化时机**：`Layout.vue` 挂载后、确认已登录（`authStore.token` 存在）时调用；先 `GET /embed/admin-config`，`agentId` 非空才 `MaoChat.init`。
2. **init 参数**：

```ts
MaoChat.init({
  serverUrl: window.location.origin,          // 同源：/api/v1 与 /api/ws/stream 都由 Nginx 反代
  agentId,
  getToken: () => Promise.resolve(localStorage.getItem('token') ?? ''),
  context: () => collectEmbedContext(),      // 见 4.3.3
  page: { initialLevel: 'per_action' },      // 显式声明默认每次确认
  onEvent: (e) => { /* phase/auth/error 仅 console.warn，不弹 toast，避免打扰后台操作 */ },
});
```

3. **token 供给细节**：admin 的 axios 拦截器在 401 时用 refreshToken 换新 token 并写回 `localStorage.token`，SDK 的 `getToken()` 回调每次重新读 localStorage，因此 refresh 后 SDK 下一次请求自然拿到新 token；SDK 内部 401 会主动 `invalidate()` 并重取一次，与 admin 的刷新链路叠加仍安全（最坏多刷一次）。**不传 refreshToken 给 SDK**（SDK 也不需要）。
4. **登出/失效联动（双保险）**：
   - `Layout.vue` 只在登录后的路由树下挂载，跳 `/login` 会被卸载 → `useEmbedChat` 的 `onScopeDispose` 自动 `destroy()`（`authStore.logout()` 后 `router.push('/login')` 即走这条）。
   - 另加 `watch(() => authStore.token)`，token 变空时也 `destroy()`。实际覆盖路径：路由守卫拉取用户信息遇 401/403 时 `authStore.clearAuth()` + `next('/login')`（`router/index.ts:207/213`）。注意 `api/index.ts` 的 `forceLogout()` 是 `window.location.href` 硬跳转登录页（整页重载，SDK host 随之消失），**并不经过 authStore**，无需也不走这条 watch——原稿「forceLogout 只清存储不跳路由」的描述与代码不符，以此为准。
   - refresh 成功只写 `localStorage`、不更新 `authStore.token` ref，watch 不会误触发 destroy；SDK 的 `getToken` 每次重读 localStorage，自然拿到新 token。
   - `destroy()` 幂等（SDK 内部 `window.__maoChatInstance` 单实例约束 + 重复 init 先销毁旧实例），重复调用无副作用。
5. **单实例保护**：admin 是 SPA，`Layout.vue` 在子路由间切换时保持挂载（`keep-alive` 只作用于内部 `router-view`，不作用于 Layout），实例不重建；不做路由级 init。
6. **错误兜底**：`/embed/mao-chat.js` 加载失败（脚本 404 / 被 CSP 拦）时 `window.MaoChat` 为 undefined，`useEmbedChat` 静默返回，不影响后台任何功能；控制台留一条 warn。

#### 4.3.3 `admin/src/utils/embedContext.ts`

纯函数 + 单测：

```ts
export interface EmbedPageContext {
  route: string;          // route.name ?? route.path
  path: string;
  // vue-router 的 params/query 值可能是 string[]（重复 query 参数），勿窄化为 string
  params: Record<string, string | string[]>;
  query: Record<string, string | string[]>;
}

export function collectEmbedContext(route: RouteLocationNormalized): EmbedPageContext
```

- 只取 `route.name` / `route.path` / `route.params` / `route.query`（vue-router 的值均为 string 或 string[]，`SessionDetail` 的 `:id` 是路由参数，属结构性信息，允许）。
- **禁止**读取任何 store 的表格数据、表单值、用户资料；**禁止**把 `query` 之外的服务端响应体带入上下文。
- 空路由参数/查询不写入对象（`{}` 而非 `{ id: undefined }`），减少无意义的上下文变化导致的重复注入。
- 调用方在 `context()` 里包一层：`() => ({ ...collectEmbedContext(router.currentRoute.value), title: document.title })`。

SDK 侧行为（既有，无需改）：`context()` 结果连同 `url`/`title` 做 hash 变更检测，仅变化时以引用块拼入下一条用户消息，总前缀上限 8KB，超限截断。

#### 4.3.4 挂载点

在 `Layout.vue` 的 `<script setup>` 中调用 `useEmbedChat()`，登录态由 `authStore.token` 驱动；不新增任何模板节点（浮窗自己挂 Shadow DOM host 到 `document.body`）。`App.vue` 不动。

### 4.4 会话与多页签

- 会话归属：SDK 按（`serverUrl`, userId, agentId）隔离持久化（`mao_embed_session_*`，scope 含身份），同一管理员在不同浏览器各自独立，符合「按用户 + 浏览器本地隔离」。
- 多页签：SDK 的 `BroadcastChannel('mao-embed_${scope}_${agentId}')`（`core/tabs.ts`，scope = serverUrl + userId 的 JSON 序列化）已按身份协调，admin 多页签打开不会重复建会话。
- 浮窗历史按 Agent 过滤（评审补充）：SDK 历史列表请求 `/sessions?source=embed&agentId=X`，切换 `embed.agentId` 后旧会话从浮窗历史面板消失（仍存在于后台「会话管理」，可检索、可删除）。这是 SDK 既有行为，属预期，验收时勿判 bug。
- 会话来源：SDK 创建时传 `source: 'embed'`，后台「会话管理」原样可见，本期不做特殊处理。

### 4.5 鉴权边界与风险

| 风险 | 影响 | 处置 |
|---|---|---|
| admin token 24h，SDK 会话内 token 过期 | 401 → SDK 重取，但 admin 的 refresh 由 axios 拦截器负责；SDK 重取时若 refresh 未发生会拿到同一个旧 token | 可接受：下一次 admin 自身请求会触发 refresh 并写回；浮窗重试后即可恢复。最坏情况是浮窗多提示一次「登录凭据已失效」，用户刷新页面即恢复 |
| SDK `getToken` 读 localStorage | 与 admin 现有 token 存储一致，不新增存储面 | token 不出浏览器、不进 URL、不进日志（SDK 既有约束） |
| `page_*` 工具 + admin 页面含敏感数据 | Agent 可读快照（`per_action` 下密码/验证码/银行卡字段值脱敏）、可截图（默认遮罩敏感区域） | SDK 既有脱敏与授权机制；`context()` 禁采数据行作为第二道闸；在方案与接入文档中写明管理员应知悉的风险 |
| 浮窗 Shadow DOM 与 admin 样式 | Shadow DOM `all: initial` 隔离，互不影响 | SDK 既有行为，无需处理 |
| z-index 遮挡 admin 弹窗 | SDK `--mao-z: 2147483000` 极高，会盖在 el-dialog 之上 | 既有 SDK 行为，浮窗默认收起不遮挡；本期限额接受，列入已知限制 |

## 5. 实现步骤

1. **后端配置项**：`V156__embed_agent_id_setting.sql` 插入 `embed.agentId`；`settings.service.ts` 增加 key 常量、`validateValue` 保存校验分支（agent-id 校验抽私有方法与 weixin 复用）与默认值读取；补单测（解析、非数字、空值回落、停用 Agent 保存被拒）。
2. **后端接口**：新建 `backend-ts/src/embed/`（`embed.routes.ts` + `embed.routes.spec.ts`），`GET /v1/embed/admin-config`；在 `create-app.ts` 注册路由并注入依赖；补单测（已配置 / 未配置回落默认 / 默认也不可用返回 null / 停用 Agent 回落 / 未登录 401）。
3. **admin 配置 UI**：`SystemSettingsView.vue` 新增 `AGENT_SELECT_KEYS`（weixin/embed 复用同一 Agent 下拉）+ `TOC_GROUPS` 登录认证组新增 `集成配置` 分类条目；不动 `IntegrationConfigPanel.vue`（其 select 字段类型不支持异步 Agent 数据源）。
4. **admin 接入层**：新增 `useEmbedChat.ts` + `embedContext.ts`（含 vitest 单测）；`index.html` 加 script 标签；`Layout.vue` 调用并联动登出。
5. **admin 测试基建**：`admin` 当前无 vitest（`package.json` 无 test 脚本）。本期新增 `vitest` + `happy-dom` devDependency、`vitest.config.ts`、`npm test` 脚本，与 `sdk/embed` 同套依赖版本；只覆盖纯逻辑（`embedContext`、agentId 回落判定），不引入组件测试框架。注意 `.github/workflows/ci.yml` 的 admin job 当前只跑 build——若希望新单测长期守门，需同任务在 ci.yml admin job 补 `npm test`（需先 `npm ci`），否则仅本地/人工执行。
6. **dev 代理与构建验证**：`admin/vite.config.ts` proxy 补 `/embed`（→ desktop dev :5201）与 `/api` 的 `ws: true`；`cd admin && npm run build`（`vue-tsc -b && vite build`）通过；确认 `dist/index.html` 含 `/embed/mao-chat.js` 引用；起 desktop dev server + admin dev 手动验收（dev 下 SDK 走同源代理，拓扑与生产一致）。
7. **文档与 CHANGELOG**：`README.md` / `DEPLOY.md` 补「管理后台浮窗助手」章节（接入形态、`embed.agentId` 配置、已知限制）；`skills/mao-cli/SKILL.md` 与 `skills/mao-cli/reference/embed-sdk.md` 同步；根 `CHANGELOG.md` 顶部新增条目 + `admin` 小节。

## 6. 落地清单

### 6.1 新增（要做）

| 位置 | 内容 |
|---|---|
| `backend-ts/db/migration/V156__embed_agent_id_setting.sql` | `embed.agentId` 配置行（分类「集成配置」，`editable=1`，`value` 初始 NULL） |
| `backend-ts/src/embed/embed.routes.ts` | `GET /v1/embed/admin-config`（仅登录可读） |
| `backend-ts/src/embed/embed.routes.spec.ts` | 接口单测：配置值有效 / 回落默认 / 默认不可用返回 null / 停用 Agent / 未登录 401 |
| `admin/src/composables/useEmbedChat.ts` | init/destroy、agentId 获取与回落、token 供给、登出联动、加载失败兜底 |
| `admin/src/utils/embedContext.ts` + `.spec.ts` | 路由上下文采集纯函数与单测 |
| `admin/vitest.config.ts`、`admin/package.json` 的 `test` 脚本与 devDependency | admin 单测基建（vitest + happy-dom） |
| `docs/plan/2026-10-16-admin-embed-chat-technical-design.md` | 本文档 |

### 6.2 修改（要做）

| 位置 | 改动 | 幅度 |
|---|---|---|
| `backend-ts/src/settings/settings.service.ts` | 新增 `EMBED_AGENT_ID_KEY` 常量 + `validateValue` 保存校验分支（agent-id 校验抽私有方法与 weixin 复用） | 数行 |
| `backend-ts/src/create-app.ts` | 注册 embed 路由并注入 `systemSettingService` / `agentService` | 数行 |
| `backend-ts/src/settings/settings.service.spec.ts`（或新 spec） | 配置读取解析 + 保存校验单测 | 十余行 |
| `admin/index.html` | 引入 `/embed/mao-chat.js` | 一行 |
| `admin/vite.config.ts` | dev 代理补 `/embed`（→ desktop dev :5201）与 `/api` 的 `ws: true` | 数行 |
| `admin/src/components/Layout.vue` | 调用 `useEmbedChat()` | 数行 |
| `admin/src/views/settings/SystemSettingsView.vue` | `AGENT_SELECT_KEYS` 泛化（weixin/embed 复用同一 Agent 下拉）+ `TOC_GROUPS` 登录认证组新增 `集成配置` 分类条目 | 数行 |
| `README.md` / `DEPLOY.md` | 「管理后台浮窗助手」章节 | 新章节 |
| `skills/mao-cli/SKILL.md`、`skills/mao-cli/reference/embed-sdk.md` | 同步 admin 接入说明 | 新小节 |
| `CHANGELOG.md` | 顶部新版本条目 + `admin` 小节 | 新条目 |

### 6.3 部署与运维（要做）

- 产物链路不变：`desktop/public/embed/mao-chat.js`（latest）随 `scripts/deploy-desktop.sh` 上线；admin 通过 Nginx `location /` 同源读到 `/embed/mao-chat.js`。**必须先部署 desktop 再部署 admin**，否则 admin 页面引用 404（SDK 加载失败时后台功能不受影响，只是浮窗不出现，控制台有 warn）。
- 无后端迁移以外的手工步骤：`embed.agentId` 走 Flyway 自动迁移，值在后台「系统设置 → 集成配置 → Embed 助手」里选。
- CSP：admin 无独立 CSP 头（同源 script + 同源 wss），无需改动；若后续给 admin 加 CSP，需放行 `script-src 'self'` 与 `connect-src 'self' ws:/wss:`。
- 回退：删 script 标签 + 删配置组即可完全回退，无数据残留（`embed.agentId` 行可留空，不影响其他功能）。

## 7. 验收标准

1. 管理员登录后台，右下角出现浮动入口；点击展开浮窗，可发送消息并收到流式回复；工具调用、思考过程、追问卡片渲染正常。（dev 下验收需先完成 §4.3.1 的两处代理修正，并同时运行 desktop dev server :5201）
2. 「系统设置 → 集成配置」可选择 Agent 并保存；保存后**新会话**使用该 Agent（旧会话 agentId 不变、并从浮窗历史面板消失，均属预期，见 §4.4）；留空保存后新会话回落系统默认 Agent。
3. 未配置任何值时（含全新部署），浮窗仍可用并使用系统默认 Agent。
4. 无 `settings:read` 权限的登录用户，浮窗可用（`GET /v1/embed/admin-config` 返回 200 与 `agentId`）。
5. 未登录访问 `/admin/`：跳登录页，无浮窗；登录后浮窗出现。登出后入口与浮窗立即消失，Shadow DOM host 从 `document.body` 移除。
6. 在「会话管理」「Agent 管理」等页面提问，Agent 收到的上下文含路由名/路径；**上下文 JSON 中不含表格数据行内容**（人工检查气泡引用块与服务端收到的消息）。
7. 页面操作：让 Agent 操作当前后台页面（如「帮我把这个筛选改成……」），默认每次确认卡片出现，确认后执行；用户可在浮窗授权下拉切到「本次任务授权」。
8. 多页签打开后台不产生重复会话；同一会话在桌面端会话列表可见、可继续。
9. 附件：浮窗内粘贴图片可发送（走 Mao 上传，同源 `/api/v1`）。
10. `cd backend-ts && npm run build && npm test` 全绿；`cd admin && npm run build` 与 `npm test` 全绿。

## 8. 已知限制（本期接受，不解决）

1. **z-index**：SDK 浮窗层级极高，会覆盖 admin 的 `el-dialog` / `el-drawer`。默认收起态不遮挡；用户在弹窗打开时展开浮窗会互相重叠。
2. **主题**：浮窗是 Mao 桌面端浅色视觉，不跟随 admin 主题（admin 亦无暗色模式），不做主题联动。
3. **token 过期体验**：admin access token 24h，超长挂机会出现一次「登录凭据已失效」提示，刷新页面即恢复（见 §4.5）。
4. **上下文浅**：只采路由信息，Agent 不知道当前表格筛选项、选中行；需要更深上下文时 Agent 可用 `page_*` 自己看页面。
5. **会话可见性**：浮窗会话混在后台「会话管理」列表里，无法按来源筛选；反向地，切换 `embed.agentId` 后浮窗历史面板也不再显示旧 Agent 的会话（SDK 历史按 agentId 过滤，§4.4）。
6. **SDK 升级耦合**：admin 引用 latest 产物（无版本锁），SDK 升级即时影响后台；如需锁定，可改用 `/embed/mao-chat.v{version}.js` 并在方案外单独评估。
