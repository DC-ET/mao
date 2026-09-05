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
    theme: { primary: '#4f6ef7' },  // 可选：仅主色
    launcher: { visible: true },    // 可选：false 时隐藏自带按钮，用 chat.open() 打开
    onEvent: (e) => console.log(e), // 可选：phase / error / unread
  });
</script>
```

实例方法：`open()` / `close()` / `toggle()` / `newSession()` / `setContext(ctx)` / `destroy()`。重复 `init()` 会先销毁旧实例（单实例约束）。

## 关键行为

| 主题 | 行为 |
|------|------|
| 会话 | 每浏览器每 agent 一个常驻会话，记录在 `localStorage` 的 `mao_embed_session_{agentId}`；会话被删除或不归属当前用户时自动清记录并新建 |
| 多页签 | `BroadcastChannel('mao-embed')` 协调，同时初始化不会重复建会话 |
| 上下文 | `context()` 结果连同 `url` / `title` 一起做变更检测，变化才拼入下一条消息；拼装后的**总前缀**上限 8KB，超限截断并附提示 |
| 选中引用 | 宿主页面上选中文本自动成为引用块；浮窗内部（Shadow DOM）的选中不采集；关闭引用 chip 后该段文本不再携带（重新选中可恢复）；发出一次后不重复携带 |
| 连接 | 懒连接（首次展开浮窗才连）；首帧 `auth`、5s 心跳、30s 静默判定、1s→30s 指数退避重连；重连后自动恢复订阅并重拉历史与本地未落库消息合并对账；断线期间仍可输入，发送时自动重连补发 |
| 发送 | 帧写入 socket 后仍需等服务端 `user_message_saved` 落库确认；发送失败与服务端拒绝会回滚气泡并复原上下文与引用；60s 未回执只提示「发送未确认」而不删除消息（可能已在执行），服务端一旦有产出或回执迟到，提示自动撤下 |
| 样式隔离 | 全部渲染在 Shadow DOM 内，`all: initial` 重置继承；宿主的 `!important` 全局样式不侵入 |
| 全局污染 | 只挂 `window.MaoChat` 与 `window.__maoChatInstance` |
| 桌面端可见 | SDK 建的会话在 desktop 会话列表可见、可继续；双端同时发送时另一端收到"该任务仍在运行"提示 |

## 安全边界（接入前必读）

均为当前既定设计，不是缺陷，但接入方必须知情：

1. **WS 握手不校验 origin**：`/api/ws/stream` 在公开前缀内，鉴权完全靠连接后首帧 `auth`；结合 CORS 反射任意 origin，安全边界全部落在 **token 发放侧**。
2. **后端不校验 agent 归属**：任何已登录用户可用任意 `agentId` 建会话，embed 的权限边界只靠 `agentId` 保密。
3. **登录接口返回的 access token 默认 24 小时有效**：**不要**把它直接交给页面。宿主后端应签发更短有效期的专用 token 并在 `getToken()` 返回。
4. `context()` 里的业务数据会随消息发到 LLM，**不要放敏感信息**。

## 宿主侧要求

- **CSP**：放行 Mao 域名的 `connect-src`（`https:` 与 `wss:`）与 `script-src`。
- **跨源**：REST 请求带 `Authorization`，会触发预检；后端 CORS 已显式放行 `Authorization`（0.0.105 起）。生产 Nginx 的 `/api/` 是纯反代、不注入 CORS 头。

## 常见问题

| 现象 | 排查 |
|------|------|
| 浮窗不出现 | 控制台看 `MaoChat.init` 是否抛错（`serverUrl` / `agentId` / `getToken` 三者必填）；确认脚本已加载 |
| 指示灯不亮 / 底部提示"连接已断开" | 尚未鉴权成功：检查 `getToken()` 是否返回有效 token、CSP 是否放行 `wss:`（此状态下仍可输入，发送会先重连） |
| 横幅"登录凭据已失效" | 服务端以 `close(1003)` 拒绝了 token；重新鉴权成功后横幅会自动消失 |
| 横幅"无法连接到助手服务" | WS 连不上（域名 / 证书 / CSP / 网络）；原始错误可从 `onEvent` 的 `error` 事件取到 |
| 跨源请求被浏览器拒绝 | 确认后端版本 ≥ 0.0.105（CORS `allowedHeaders` 显式含 `Authorization`） |

## 开发与发布

```bash
cd sdk/embed && npm install
npm run dev     # demo 宿主页（vite :5300）
npm test        # vitest（happy-dom）
npm run build   # vue-tsc + vite lib 构建
npm run size    # size-limit，gzip 预算 200KB
```

产物接线：`desktop/package.json` 的 `prebuild` 会跑 `desktop/scripts/build-embed-sdk.cjs`，把 `sdk/embed/dist/mao-chat.js` 复制进 `desktop/public/embed/`，随 `scripts/deploy-desktop.sh` rsync 上线。**只改 SDK 源码时也要提交更新后的 `desktop/public/embed/*.js`**（产物入 git）。

设计文档：仓库 `docs/plan/embed-sdk-technical-design.md`；评审记录：`docs/plan/embed-sdk-review.md`。
