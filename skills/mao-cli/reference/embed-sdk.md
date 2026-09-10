# Web Embed SDK（页面嵌入对话浮窗）

`sdk/embed`（包名 `@mao/chat-embed`）把 Mao 的 agent 对话做成**一个脚本文件**：内部 Web 系统引入后调一次 `MaoChat.init()`，页面右下角出现浮动入口，点开即可就当前页面内容与 agent 对话（流式输出、思考过程、工具执行状态、追问作答、手动停止）。浮窗不展示引擎内部的 LLM 等待阶段（如 `response_headers`），上游真正重试时仍会提示。

产物托管路径 `https://mao.etarch.cn/embed/mao-chat.js`（另有版本锁定副本 `mao-chat.v{version}.js`）。会话为 **CLOUD 模式**，无工具审批环节。

## 接入

```html
<script src="https://mao.etarch.cn/embed/mao-chat.js"></script>
<script>
  const chat = MaoChat.init({
    serverUrl: 'https://mao.etarch.cn',
    agentId: 1,
    getToken: () => fetch('/your-backend/embed-token').then(r => r.json()).then(d => d.accessToken),
    context: () => ({ page: location.pathname, orderId: window.__orderId }),
    position: 'right',              // 可选：'right' | 'left'
    theme: { primary: '#0066cc' },  // 可选：仅主色，默认与 Mao 桌面端一致
    launcher: { visible: true },    // 可选：false 时隐藏自带按钮，用 chat.open() 打开
    onEvent: (e) => console.log(e), // 可选：phase / error / unread
  });
</script>
```

实例方法：`open()` / `close()` / `toggle()` / `newSession()` / `setContext(ctx)` / `destroy()`；页面操作相关：`inspectPage()` / `executePageAction(action, snapshotId?)` / `getPageAuthorization()` / `setPageAuthorization(level)` / `capturePageScreenshot({ maskSensitive?, reason? })`。重复 `init()` 会先销毁旧实例（单实例约束）。

## 页面操作 Agent

在对话中直接要求 Agent 查看或操作当前页面（如「帮我把收货地址填成……」）。业务方仍然只需 `MaoChat.init()`，不需要为按钮/表单增加标记，也不需要提供 selector 或回调。Agent 通过后端 `page_*` 工具请求、由 SDK 在用户浏览器本地执行并回传结果。

```js
const chat = MaoChat.init({
  serverUrl: 'https://mao.etarch.cn',
  agentId: 1,
  getToken: () => fetch('/your-backend/embed-token').then(r => r.json()).then(d => d.accessToken),
  page: {
    initialLevel: 'per_action',       // 可选：默认每次确认；宿主不得借此静默授予高权限
    screenshotRenderer: myRenderer,   // 可选：自定义截图渲染器，缺省用内置视口渲染器
  },
});
```

- **能力**：`page_inspect`（可见交互元素快照）、`page_screenshot`（当前视口截图）、`page_observe`、`page_scroll`、`page_focus`、`page_fill`、`page_select`、`page_check` / `page_uncheck`、`page_click`、`page_keyboard`、`page_wait`、`page_actions`（有序批量）。
- **元素引用**：只使用快照作用域内的 opaque `elementId`；不向 Agent 暴露 selector、XPath、outerHTML 或任意脚本。页面导航、SPA 路由或 DOM 重建后旧引用立即失效，Agent 必须重新 `page_inspect`。
- **授权**：默认 `per_action`（每个写操作前在浮窗确认）；用户可在输入框底部工具栏的授权下拉中切换 `task`（本次任务内有效，任务结束/切换会话/刷新后失效）或 `full`（按 Mao 用户身份、站点 Origin、Agent 持久化到 localStorage，可随时撤销）。授权键按 `serverUrl`、Origin、身份、agentId 和授权版本隔离，不保存 Token。宿主 `page.initialLevel` 与实例方法 `setPageAuthorization()` 只接受 `per_action`/`task`，传 `full` 会被降级；**完全授权只能由用户在浮窗内显式点击授予**，避免宿主一行代码替用户提权。
- **敏感数据**：`per_action` 下快照中密码/验证码/银行卡等字段值脱敏；截图默认遮罩敏感区域，发送未遮罩原图会先请求确认；`full` 在授权范围内允许未遮罩。
- **反馈与停止**：待确认动作（含高风险提示）以卡片出现在输入框上方，并高亮目标元素；用户点输入框停止按钮会终止整个任务（含页面操作），SDK 会取消等待中的确认并让后续动作失败。
- **截图**：只截当前视口，永远排除 SDK 浮窗；内置渲染器把 DOM 编成良好 XML 再放入 SVG foreignObject 光栅化，并剥掉跨域图片/背景以免 canvas 被污染。跨域图片会缺失；若仍无法导出则回退为 DOM 色块+文字。截图随工具卡默认折叠，展开后显示小缩略图，点击可看大图。不要指望用 Markdown `![](attachment://…)` 在回复里再贴一次。需要更完整像素时可传自定义 `screenshotRenderer`。
- **角色定义**：管理后台只需为 Embed Agent 填写身份、业务目标与文风。页面上下文协议、可见范围、page 工具纪律、截图展示与安全边界由引擎在持有 `page_*` 的会话上自动注入，不必每个 Agent 复制一份；旧提示词里的重复段可删掉。

### 明确不支持（会返回可解释错误，不尝试绕过浏览器边界）

- 跨域 iframe、闭合 Shadow DOM 内的元素；
- 文件选择器/上传、下载确认、新标签页与其他标签页、浏览器地址栏；
- 验证码/人机验证、浏览器权限弹窗、系统窗口；
- 任意 JavaScript 执行、坐标点击/拖拽、绕过同源策略/CSP/真实用户手势限制；
- 截图整页拼接（仅当前视口）、SDK 自身 Shadow DOM 的读取与操作。

`page_select` 对 `multiple` 多选只按单值选中一个选项（会替换原有选择），不支持一次选中多个值。

同源 iframe 内元素可被扫描到，但受浏览器跨 realm 限制，iframe 内元素的部分动作（`fill`/`focus`/`select` 等类型判定）可能不可用；需要稳定操作时请优先选择主文档元素。

## 公司 SSO 接入

公司后台已有前端可读取的 SSO Token 时，使用以下模式替代 `getToken`，不改公司后台后端或现有登录流程：

```js
const chat = MaoChat.init({
  serverUrl: 'https://mao.company.example',
  agentId: 1,
  auth: {
    type: 'company-sso',
    checkUrl: 'https://sgs.acg.team/api/sso-auth/auth/checkToken',
    // 必须每次读取最新凭证；companyLogin 是示意，替换为宿主真实 API。
    getSsoToken: async () => companyLogin.getCurrentToken(),
  },
  context: () => ({ page: location.pathname }),
});
```

`auth` 和 `getToken` 必须二选一，不自动探测 Token 类型，也不在 SSO 失败后降级为普通登录。SDK 通过 HTTPS Header 把 SSO Token 交给 `/api/v1/auth/sso/exchange`，由 Mao 调用公司官方 checkToken；普通 REST/WS 只使用换得的 Mao Token。

### 部署与身份要求

1. 在管理后台「系统设置 → 集成配置 → 公司 SSO」启用并登记宿主 Origin（精确 HTTPS、`https://*.acg.team` 子域或 `*` 全来源）、校验域名白名单；保存后新换票即时生效，不使用 `SSO_*` 环境变量，详见 [配置参考](config.md#公司-ssoweb-embed-sdk)。另按部署要求配置 TLS 终止代理的受信 IP。域名白名单支持完整域名或上级域名，每项覆盖自身及所有子域，信任范围由配置人员判定。
2. `auth.checkUrl` 必填，由业务系统指定 HTTPS 校验地址（不带用户名密码、片段或已有 `token` 查询参数），服务端校验域名后调用，禁止重定向。地址可以不同，但仍须采用公司 checkToken 协议：GET query `token`；成功响应须 `code=0`、`success=true`、`data.illegal=false`，可信 claims 提供 `id`、`email`、`realName`、`exp`。所有地址共用同一员工身份体系。
3. **可信邮箱**是唯一身份键（精确匹配、区分大小写）。测试/生产等环境的公司用户 `claims.id` 可以不同，同一邮箱视为同一人。首次登录按邮箱唯一匹配已有启用账号（含管理员），否则创建普通用户；该邮箱已有 `company_sso` 绑定则直接复用。禁用/删除账号、同一邮箱对应多个 Mao 用户时拒绝自动关联。SSO 不授予、不撤销管理员角色。
4. 绑定按邮箱保存，不覆盖原角色、密码或飞书绑定。换票凭证与该用户普通 Mao 登录等权，没有 SDK 专用 Agent/接口范围。公司侧更换邮箱即视为新身份。
5. 公司 SSO 示例没有明确停用/撤销错误契约，未识别的失败按服务异常拒绝换票；上线前必须联调失效和停用场景，不能仅凭成功样例宣称撤销完整生效。

### 连续使用与失败处理

- SDK 在临期前自动取宿主最新 SSO Token 换票，在同一 WS 上更新认证；不每 5 分钟退出，不中断正常流式对话。
- Mao access 默认最多 30 分钟，且不超过 SSO 剩余有效期。没有独立 refresh token；宿主回调必须能持续提供当前凭证，SDK 不替代公司登录 SDK 刷新 SSO。
- 暂时不可用或限流时保留仍有效的 Mao Token，进行有界重试；到期不能继续新访问。明确失效、账号拒绝和身份冲突显示不同错误。
- 页面休眠可能错过轮换，恢复后重新认证并恢复订阅；认证失效不取消已经受理的后台任务。
- 用户变化清理旧账号内容并切换本地缓存空间；不在一条已认证 WS 上直接改 userId。
- SDK 新增 `onEvent` 的 `auth` 事件：`authenticated`、`login_required`、`service_unavailable`、`account_forbidden`、`identity_conflict`、`configuration_error`；事件仅含状态、脱敏文案和已知用户 ID，不包含凭证。
- 公司退出不等于所有 Mao Token 立即撤销：已签发 access 最晚到期失效；现有 shell/终端凭证保持独立生命周期，本期不提供全局注销和任务取消。
- Token 不写入 localStorage、BroadcastChannel、URL 或上下文。上游 SSO 协议要求 query Token，SSO 网关必须脱敏其访问日志。

## 关键行为

| 主题 | 行为 |
|------|------|
| 会话 | 按 Mao 服务地址、用户身份与 Agent 隔离本地会话记录；会话被删除或不归属当前用户时清记录并新建，Token 不落盘 |
| 多页签 | 按服务地址、用户身份与 Agent 隔离的 BroadcastChannel 协调，同身份同时初始化避免重复建会话，不广播 Token |
| 上下文 | `context()` 结果连同 `url` / `title` 一起做变更检测，变化才拼入下一条消息；拼装后的**总前缀**上限 8KB，超限截断并附提示。上下文块只进 LLM 上下文，气泡（含刷新后重拉的历史）只显示用户真正输入的文本 |
| 选中引用 | 宿主页面上选中文本自动成为输入区「讨论」chip；浮窗内部（Shadow DOM）的选中不采集；关闭 chip 后该段文本不再携带（重新选中可恢复）。发出后用户气泡同样回显这段引用（刷新历史可还原），页面上下文 JSON 仍只进 LLM、不上屏；同一段文本不会被连续两条消息重复携带 |
| 连接 | 懒连接（首次展开浮窗才连）；首帧 `auth`、5s 心跳、30s 静默判定、1s→30s 指数退避重连；重连后自动恢复订阅并重拉历史与本地未落库消息合并对账；断线期间仍可输入，发送时自动重连补发。连接状态只在标题栏用指示灯和「在线 / 连接中…」轻量提示，输入区不再另出断连横幅 |
| 输入 | Agent 输出过程中不禁用输入框，可先写下一条；本轮结束前不会发出（无消息队列，避免被服务端拒绝丢掉草稿）；空内容时显示停止 |
| 发送 | 帧写入 socket 后仍需等服务端 `user_message_saved` 落库确认；发送失败与服务端拒绝会回滚气泡并复原上下文与引用；60s 未回执只提示「发送未确认」而不删除消息（可能已在执行），服务端一旦有产出或回执迟到，提示自动撤下 |
| 执行过程 | 流式思考、正文与工具调用按事件顺序穿插，只有相邻同类节点合并；正文保持可见，思考与连续工具调用在执行中及结束后均默认折叠。工具摘要显示数量、执行中与失败状态，展开查看参数、结果和页面截图缩略图（点击可看大图）；后续流事件不重置用户的展开选择。等待模型输出时用三点脉动（与桌面端一致），工具正在执行时不叠一层 loading。模型流中断自动重试时保留已完成的说明和工具调用，只丢掉本次未完成的生成 |
| 历史展示 | 按服务端消息/工具轮次顺序恢复正文、思考和工具组。单条历史消息仅保存聚合思考与正文，无法还原其中的 delta 交错，按思考→正文→工具组展示；工具有结果显示完成（不推断历史成功/失败），缺失结果显示「结果未记录」，不冒充执行中 |
| 样式隔离 | 全部渲染在 Shadow DOM 内，`all: initial` 重置继承；宿主的 `!important` 全局样式不侵入 |
| 入口定位 | 鼠标/触摸直接拖动，移动超过 6px 才视为拖动，松手吸附最近的左右边缘，不误触打开。站点 localStorage 的 `mao_embed_launcher_position` 仅记录边缘和相对高度，刷新恢复、窗口及可视视口变化时自动修正；存储不可用时只保留当次位置。未调整遵循 `position`，浮窗选择上下较宽裕一侧展开；`launcher.visible: false` 不应用拖动定位。清除该 key 后重新初始化可恢复配置默认位置 |
| 入口标识 | 首次打开后获取 Agent 详情：浮窗标题与入口朗读使用管理后台配置的 Agent 名称（未配置时为「Mao 助手」）；已配置头像时入口和浮窗标题展示同一头像，上传路径按 `serverUrl` 解析；未配置时使用对话轮廓 + M 形声波 + 连接圆点的 SVG。保留运行环、未读红点、键盘聚焦与状态朗读 |
| 视觉与主题 | 设计语言对齐 Mao 桌面端：默认主色 `#0066cc`、发丝描边、分层阴影、8/10/14/16px 圆角阶梯。`theme.primary` 只需给一个色值（`#rgb`/`#rrggbb`/`rgb()`/颜色关键字均可），hover 色 / 浅底色 / 聚焦环由 `color-mix` 自动派生（老浏览器落回静态默认值）；传白色、浅黄等高亮度主色时会按 WCAG 亮度自动换成深色文字并补描边，文字不会消失；动效在 `prefers-reduced-motion: reduce` 下自动关闭。暗色模式暂未支持 |
| 移动端 | 浮窗高度按 `100dvh` 计算（手机地址栏不顶出底部）；窄屏（≤480px）下按钮与选项放大到触控推荐尺寸，布局与字号不变 |
| 全局污染 | 只挂 `window.MaoChat` 与 `window.__maoChatInstance` |
| 桌面端可见 | SDK 建的会话在 desktop 会话列表可见、可继续；双端同时发送时另一端收到"该任务仍在运行"提示 |

## 安全边界（接入前必读）

均为当前既定设计，不是缺陷，但接入方必须知情：

1. **WS 握手不校验 origin**：`/api/ws/stream` 的身份依赖连接后 `auth`，SSO 来源连接增加在线更新及到期关闭。普通 REST 保持原 CORS 策略，SSO 换票按后台 Origin 规则匹配，`*` 表示不限制网页来源；Origin 不是身份凭证。
2. **没有 SDK 专用 Agent 权限范围**：持有 Token 的用户沿用 Mao 现有授权，不能靠 `agentId` 保密充当访问控制。
3. **普通登录 access 默认 24 小时有效**：`getToken` 模式应提供更短期凭证；公司 SSO 模式由 Mao 按 SSO 有效期上界签发短期 access，不要求各后台自行签发。
4. `context()` 里的业务数据会随消息发到 LLM，**不要放敏感信息**。

## 宿主侧要求

- **CSP**：放行 Mao 域名的 `connect-src`（`https:` 与 `wss:`）、`script-src` 及 `img-src`（Agent 头像；页面截图还需 `data:` 与 `blob:`）。
- **跨源**：REST 请求带 `Authorization` 会触发预检。后端 CORS 不设静态 `allowedHeaders`，预检反射 `Access-Control-Request-Headers`（含 `Authorization` 以及宿主 APM 注入的 `sw8` 等自定义头）。不要改回 `*`（对 `Authorization` 无效）或静态白名单。生产 Nginx 的 `/api/` 是纯反代、不注入 CORS 头。

## 常见问题

| 现象 | 排查 |
|------|------|
| 浮窗不出现 | 控制台看 `MaoChat.init` 是否抛错（`serverUrl` / `agentId` 必填，`getToken` 与 `auth` 必须二选一）；确认脚本已加载 |
| 标题栏一直是「连接中…」、指示灯不亮 | 尚未鉴权成功：检查 `getToken()` 是否返回有效 token、CSP 是否放行 `wss:`（此状态下仍可输入，发送会先重连） |
| 横幅"登录凭据已失效" | 服务端以 `close(1003)` 拒绝了 token；重新鉴权成功后横幅会自动消失 |
| 横幅"无法连接到助手服务" | WS 连不上（域名 / 证书 / CSP / 网络）；原始错误可从 `onEvent` 的 `error` 事件取到 |
| 跨源请求被浏览器拒绝 | 确认后端版本 ≥ 0.0.111（CORS 预检反射请求头，覆盖 `Authorization` 与宿主 APM 的 `sw8` 等）；生产 Nginx 不要另行覆盖 CORS 头 |
| 换票 503 | Mao 调用 checkToken 未通过：看日志 `detail`。`oversized:<n>` 表示响应超过 1MB；公司 claims 超过 64KB 属正常，需 0.0.111 含 1MB 上限的后端 |
| 截图失败 `screenshot_render_failed` | 内置渲染器把 DOM 编成 SVG 再光栅化。未闭合的 `<br>`/`<input>`、HTML 实体、图标 `xlink:href` 等非法 XML 会让图片加载失败。0.0.113 起改为 XML 序列化；若仍失败，检查宿主 CSP 的 `img-src` 是否放行 `data:` 与 `blob:` |
| 截图失败 `toBlob` / Tainted canvas | 页面含跨域图片或背景图时，画进 canvas 后浏览器禁止导出。0.0.113 起会剥掉外部资源；仍失败则回退为 DOM 绘制（图片可能缺失，文字和布局仍可用） |

## 开发与发布

```bash
cd sdk/embed && npm install
npm run dev     # demo 宿主页（vite :5300）
npm test        # vitest（happy-dom）
npm run build   # vue-tsc + vite lib 构建
npm run size    # size-limit，gzip 预算 200KB
```

产物接线：`desktop/package.json` 的 `prebuild` 会跑 `desktop/scripts/build-embed-sdk.cjs`，把 `sdk/embed/dist/mao-chat.js` 复制进 `desktop/public/embed/`，随 `scripts/deploy-desktop.sh` rsync 上线。**只改 SDK 源码时也要提交更新后的 `desktop/public/embed/*.js`**（产物入 git）。

上线验证与独立 MySQL 测试见仓库 [company-sso-validation.md](../../../docs/guides/company-sso-validation.md)，默认跳过的数据库测试不能算通过。

设计文档：仓库 `docs/plan/embed-sdk-technical-design.md`；评审记录：`docs/plan/embed-sdk-review.md`。
