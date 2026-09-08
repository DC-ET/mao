# Web Embed SDK（页面嵌入对话浮窗）

`sdk/embed`（包名 `@mao/chat-embed`）把 Mao 的 agent 对话做成**一个脚本文件**：内部 Web 系统引入后调一次 `MaoChat.init()`，页面右下角出现浮动入口，点开即可就当前页面内容与 agent 对话（流式输出、思考过程、工具执行状态、追问作答、手动停止）。

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

实例方法：`open()` / `close()` / `toggle()` / `newSession()` / `setContext(ctx)` / `destroy()`。重复 `init()` 会先销毁旧实例（单实例约束）。

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
3. `claims.id` 作为固定身份键，公司需保证不可回收复用。首次登录按可信邮箱唯一匹配普通账号，否则创建普通用户；管理员、禁用/删除账号、重复邮箱和已有绑定冲突拒绝自动关联。
4. 已绑定身份不随邮箱变化重新匹配，不覆盖原角色、密码或飞书绑定。换票凭证与该用户普通 Mao 登录等权，没有 SDK 专用 Agent/接口范围。
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
| 选中引用 | 宿主页面上选中文本自动成为引用块；浮窗内部（Shadow DOM）的选中不采集；关闭引用 chip 后该段文本不再携带（重新选中可恢复）；发出一次后不重复携带 |
| 连接 | 懒连接（首次展开浮窗才连）；首帧 `auth`、5s 心跳、30s 静默判定、1s→30s 指数退避重连；重连后自动恢复订阅并重拉历史与本地未落库消息合并对账；断线期间仍可输入，发送时自动重连补发 |
| 发送 | 帧写入 socket 后仍需等服务端 `user_message_saved` 落库确认；发送失败与服务端拒绝会回滚气泡并复原上下文与引用；60s 未回执只提示「发送未确认」而不删除消息（可能已在执行），服务端一旦有产出或回执迟到，提示自动撤下 |
| 执行过程 | 流式思考、正文与工具调用按事件顺序穿插，只有相邻同类节点合并；正文保持可见，思考与连续工具调用在执行中及结束后均默认折叠。工具摘要显示数量、执行中与失败状态，展开查看参数和结果；后续流事件不重置用户的展开选择。模型流中断自动重试时保留已完成的说明和工具调用，只丢掉本次未完成的生成 |
| 历史展示 | 按服务端消息/工具轮次顺序恢复正文、思考和工具组。单条历史消息仅保存聚合思考与正文，无法还原其中的 delta 交错，按思考→正文→工具组展示；工具有结果显示完成（不推断历史成功/失败），缺失结果显示「结果未记录」，不冒充执行中 |
| 样式隔离 | 全部渲染在 Shadow DOM 内，`all: initial` 重置继承；宿主的 `!important` 全局样式不侵入 |
| 入口定位 | 鼠标/触摸直接拖动，移动超过 6px 才视为拖动，松手吸附最近的左右边缘，不误触打开。站点 localStorage 的 `mao_embed_launcher_position` 仅记录边缘和相对高度，刷新恢复、窗口及可视视口变化时自动修正；存储不可用时只保留当次位置。未调整遵循 `position`，浮窗选择上下较宽裕一侧展开；`launcher.visible: false` 不应用拖动定位。清除该 key 后重新初始化可恢复配置默认位置 |
| 入口标识 | 首次打开后获取 Agent 详情，已配置头像时入口和浮窗标题展示同一头像，上传路径按 `serverUrl` 解析；未配置时使用对话轮廓 + M 形声波 + 连接圆点的 SVG。保留运行环、未读红点、键盘聚焦与状态朗读 |
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

- **CSP**：放行 Mao 域名的 `connect-src`（`https:` 与 `wss:`）、`script-src` 及 `img-src`（Agent 头像）。
- **跨源**：REST 请求带 `Authorization` 会触发预检。后端 CORS 不设静态 `allowedHeaders`，预检反射 `Access-Control-Request-Headers`（含 `Authorization` 以及宿主 APM 注入的 `sw8` 等自定义头）。不要改回 `*`（对 `Authorization` 无效）或静态白名单。生产 Nginx 的 `/api/` 是纯反代、不注入 CORS 头。

## 常见问题

| 现象 | 排查 |
|------|------|
| 浮窗不出现 | 控制台看 `MaoChat.init` 是否抛错（`serverUrl` / `agentId` 必填，`getToken` 与 `auth` 必须二选一）；确认脚本已加载 |
| 指示灯不亮 / 底部提示"连接已断开" | 尚未鉴权成功：检查 `getToken()` 是否返回有效 token、CSP 是否放行 `wss:`（此状态下仍可输入，发送会先重连） |
| 横幅"登录凭据已失效" | 服务端以 `close(1003)` 拒绝了 token；重新鉴权成功后横幅会自动消失 |
| 横幅"无法连接到助手服务" | WS 连不上（域名 / 证书 / CSP / 网络）；原始错误可从 `onEvent` 的 `error` 事件取到 |
| 跨源请求被浏览器拒绝 | 确认后端版本 ≥ 0.0.111（CORS 预检反射请求头，覆盖 `Authorization` 与宿主 APM 的 `sw8` 等）；生产 Nginx 不要另行覆盖 CORS 头 |

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
