[![CI](https://github.com/DC-ET/mao/actions/workflows/ci.yml/badge.svg)](https://github.com/DC-ET/mao/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

<p align="center">
  <img src="docs/assets/logo.png" alt="Mao Logo" width="96" />
</p>

<h1 align="center">Mao</h1>

<p align="center">
  <strong>Self-hosted AI Agent platform for individuals and teams — RBAC, audit trails, and dual execution modes.</strong><br/>
  个人与企业都适用的可私有化部署 AI Agent 管理与协作平台
</p>

<p align="center">
  <a href="skills/mao-cli/reference/install.md">快速开始</a> ·
  <a href="USER_GUIDE.md">用户手册</a> ·
  <a href="skills/mao-cli/reference/project.md">项目说明</a> ·
  <a href="skills/mao-cli/SKILL.md">mao-cli 知识库</a> ·
  <a href="#参与贡献">参与贡献</a>
</p>

---

> **重要提示**：当前项目尚未经过企业级生产环境验证。部署前请充分了解功能限制与适用边界，自行评估风险后再决定是否上线。

Mao 提供可私有化部署的 AI Agent 管理与协作：内置 Think-Act-Observe 引擎，支持 CLOUD / LOCAL 双执行模式、MCP、Skill、定时任务与多端客户端（管理后台、Web/Electron 桌面、安卓 APP、`mao-agent` 终端 CLI）。云端任务还可直接打开跑在服务端的交互式终端（需 `terminal:use` 权限，默认只授管理员）。数据与模型密钥留在你自己的环境。

> **开源说明**：MIT 许可证，仅提供源码与自部署文档。LLM 需在管理后台配置 API Key；界面语言为中文。

## 客户端预览

<p align="center">
  <img src="docs/assets/client.png" alt="Mao 桌面客户端页面样图" width="960" />
</p>

## 产品文档（mao-cli 知识库）

**面向用户与 Agent 的产品说明、部署、配置、全端手册与 REST CLI** 统一维护在 [`skills/mao-cli/`](skills/mao-cli/SKILL.md)，可单独分发。仓库内其他产品向文档以引用为主：

| 文档 | 说明 |
|------|------|
| [skills/mao-cli/SKILL.md](skills/mao-cli/SKILL.md) | 总路由：问答、部署、手册、REST CLI |
| [reference/project.md](skills/mao-cli/reference/project.md) | 定位、架构、与 Codex 对比、核心特性 |
| [reference/install.md](skills/mao-cli/reference/install.md) | 本地开发安装 |
| [reference/deploy.md](skills/mao-cli/reference/deploy.md) | 生产自托管部署 |
| [reference/config.md](skills/mao-cli/reference/config.md) | 环境变量与默认账号 |
| [USER_GUIDE.md](USER_GUIDE.md) | 用户手册索引 |
| [DEPLOY.md](DEPLOY.md) | 部署指南索引 |

## 快速开始

### 仅对话（mao-agent）

```bash
curl -fsSL https://raw.githubusercontent.com/DC-ET/mao/main/scripts/install-mao-agent.sh | bash
mao-agent login
mao-agent
```

详见 [skills/mao-cli/reference/mao-agent.md](skills/mao-cli/reference/mao-agent.md)。

### 本地开发三端

Node.js 22+、MySQL 8.x → 按 [install.md](skills/mao-cli/reference/install.md) 克隆、配库、启动 backend / admin / desktop。默认管理员 `admin` / `admin123`（上线后立即改密）。

### 生产部署

见 [deploy.md](skills/mao-cli/reference/deploy.md)。维护者：真实部署目录为 `/opt/mao`。

### REST 运维（mao-cli）

```bash
cd skills/mao-cli && npm install . -g
mao auth login
```

## Web Embed SDK

在任意内部 Web 系统中一行接入 Mao agent 对话浮窗（详细设计见 [docs/plan/embed-sdk-technical-design.md](docs/plan/embed-sdk-technical-design.md)）。将 `mao.example.com` 换成你的 Mao 站点（占位约定见 [config.md](skills/mao-cli/reference/config.md#站点域名)）：

```html
<script src="https://mao.example.com/embed/mao-chat.js"></script>
<script>
  MaoChat.init({
    serverUrl: 'https://mao.example.com',
    agentId: 1,                       // 页面助手绑定的 agent
    getToken: () => fetch('/your-backend/embed-token').then(r => r.json()).then(d => d.accessToken),
    context: () => ({ page: location.pathname, orderId: window.__orderId }),
  });
</script>
```

- **凭据**：使用现有 `getToken()` 提供短期 Mao access token，或使用下述公司 SSO 模式由 Mao 集中换票与自动续期；两种初始化模式互斥，Token 仅保存在 SDK 内存。
- **上下文**：`context()` 返回值（连同 url / title）变化时自动拼入下一条消息，前缀总长上限 8KB；页面上选中文本自动成为引用（浮窗内部的选中不会被采集，同一段文本不会被连续两条消息重复携带）。发出后用户气泡回显这段选中文字，刷新历史仍保留。
- **附件**：输入框直接粘贴剪切板里的图片或文件即可发送（无上传按钮）：粘贴后显示缩略图/文件 chip，可逐个移除，最多 10 个；超过后台配置上限的文件当场提示。图片随消息发给多模态模型，其他文件落到会话 runtime 目录并以引用写进消息，气泡与历史一并还原。
- **会话**：每用户每 agent 一个常驻会话，desktop 端会话列表可见、可继续；本地记录的会话被删除或不归属当前用户时自动新建
- **历史对话**：浮窗标题栏「历史」入口展开当前 Agent 的历史会话列表（仅 SDK 浮窗创建的会话，最近活跃在前，触底自动翻页），点击切换会话继续对话；进行中的任务不中断，切回自动对账还原。流式输出中也可点「新对话」或切换会话。宿主可用 `MaoChat.toggleHistory()` 控制面板开合。升级前创建的常驻会话首次打开浮窗自动补入列表。
- **入口定位**：鼠标或触摸拖动入口，松手左右贴边并记住高度，刷新恢复；浮窗跟随入口选择上下展开方向并约束在可视区域内。未调整时遵循 `position`，隐藏入口时仍使用原浮窗定位。
- **入口视觉**：对话轮廓与 M 形声波组成矢量标识，圆形底座带轻高光和细内描边；入口与浮窗头像统一，浮窗标题显示当前 Agent 名称，跟随 `theme.primary` 配色，保留运行环与未读提示。
- **执行展示**：流式思考、正文与工具按实际事件顺序穿插呈现；思考和连续工具调用默认折叠，工具摘要保留数量、执行中与失败状态，点击展开查看参数、结果和页面截图缩略图（可点开大图），正文始终可见。等待模型输出时用三点脉动（与桌面端一致）。模型流中断自动重试时保留已完成步骤，只丢掉本次未完成的生成。Agent 输出过程中输入框保持可编辑。
- **Agent 头像**：在管理后台「Agent 管理 → 基本信息」上传，后台、客户端与 Embed SDK 共用；编辑表单按基本信息、角色提示词、最佳实践、推荐问题四个 Tab 分组。角色定义只填身份、业务目标与文风，页面规则由系统注入，详见 [管理后台手册](skills/mao-cli/reference/admin.md#agent-管理)。
- **推荐问题**：管理后台为 Agent 配置最多 5 条推荐问题（单条 ≤100 字）后，SDK 浮窗新会话空白态竖排展示，点击填入输入框由用户确认发送；发送首条消息后隐藏，「新对话」后重新出现。
- **页面操作**：Agent 可在用户授权下查看页面交互元素、截取当前视口截图，并执行滚动、聚焦、填写、下拉选择、勾选、键盘输入和点击；默认每次确认，可切换本次任务授权或完全授权（按身份持久化），浮窗显示目标高亮、带控件名的动作日志和停止入口。自定义远程搜索下拉（如 Vue `el-select`）需先输入关键字再点选建议，不是原生 `select`；多选（`multiple`）填字只做过滤，必须点中 option 并确认选中态后才算已选中。仅支持主文档、同源 iframe 与开放 Shadow DOM，不执行任意脚本/坐标点击，不支持跨域 iframe、闭合 Shadow DOM、文件选择器、新标签页和验证码。
- **宿主 CSP**：需放行 Mao 域名 `connect-src`（wss / https）及 `img-src`（头像、粘贴附件缩略图；页面截图还需 `data:` 与 `blob:`）
- **注意**：`context()` 中的业务数据会随消息发送至 LLM，请勿放入敏感信息

### 公司 SSO 接入

公司后台已有可读取的 SSO Token 时，不需要修改后台后端，只需配置 SDK：

```js
MaoChat.init({
  serverUrl: 'https://mao.company.example',
  agentId: 1,
  auth: {
    type: 'company-sso',
    checkUrl: 'https://sgs.acg.team/api/sso-auth/auth/checkToken',
    getSsoToken: () => companyLogin.getCurrentToken(), // 替换为现有登录 SDK 的真实方法
  },
});
```

须先在管理后台「系统设置 → 集成配置 → 公司 SSO」启用并设置校验域名白名单（例如 `acg.team` 允许自身和全部子域）及宿主 Origin 白名单（精确 HTTPS、`https://*.acg.team` 子域或 `*` 全来源），保存后新换票即时生效，不再使用 SSO 环境变量。业务系统通过 `auth.checkUrl` 指定校验地址，域名信任范围由配置人员决定。官方校验成功后，只按可信邮箱关联已有启用账号（含管理员）或创建普通用户；测试/生产的公司用户 id 可以不同。SDK 在凭证临期前换票并在线更新 WS 认证，SSO 有效期间不限制连续使用时长。换发的 Token 与该 Mao 用户普通登录等权，不是仅能访问某个 Agent 的专用凭证。

详见 [接入手册](skills/mao-cli/reference/embed-sdk.md#公司-sso-接入)。当前适配器针对公司 `checkToken` 协议，不是任意 SSO 的自动适配器。上线前须完成真实 SSO 联调；退出不等于立即撤销已签发 Token，后台任务仍继续。

### ECP 飞书登录（全站 / CLOUD CLI）

需要 CLOUD 定时任务或 Agent shell 调用内部网关 CLI（如 `bigdata-cli`）时，可在管理后台「系统设置 → 集成配置 → ECP 飞书登录」启用。用户通过 ECP 飞书登录 Mao；服务端加密保存 ECP `sessionToken` 并在 12 小时内自动 renew，CLOUD shell 将会话票写入虚拟 HOME 的 AccessOne 兼容目录。开启后不关闭其它登录方式；用户经 ECP 飞书登录后服务端保存 `sessionToken` 供 CLOUD shell 使用。飞书机器人通道在开启后会检查发送者是否有有效 ECP 票，没有则发送卡片「新用户绑定 / 请先点击下方按钮完成用户绑定（3分钟内有效）。 / 点我绑定」。须在 ECP 登记桌面与管理后台飞书回调 URL。详见 [技术方案](docs/plan/ecp-native-login-technical-design.md) 与 [配置参考](skills/mao-cli/reference/config.md)。

### 安全边界（接入前必读）

以下三项为当前既定设计，接入方必须知情：

1. **WS 身份依赖 Token**：握手不校验 Origin；SSO 来源连接支持在线凭证更新和到期关闭。普通 REST 保持原 CORS，SSO 换票按后台 Origin 规则匹配（`*` 放开网页来源），Origin 不替代身份认证。
2. **没有 SDK 专用 Agent 权限范围**：使用当前 Mao 用户的权限，不能将 `agentId` 保密当作授权控制。
3. **短期凭证**：普通 `getToken` 模式应提供短期 Mao Token；公司 SSO 模式由 Mao 负责签发及 SDK 自动续期，不需要后台后端自行换票。

宿主可通过 `onEvent` 接收 `phase` / `error` / `unread` 及 SSO 模式的 `auth` 事件做埋点与状态联动；认证事件使用脱敏分类文案，不包含凭证。

本地验收：`cd sdk/embed && npm install && npm run dev`（demo 页模拟宿主，见 `sdk/embed/demo/`）。

## 测试

```bash
cd backend-ts && npm test && npm run build
cd admin && npm run build
cd desktop && npm run build
cd agent-cli && npm test
cd sdk/embed && npm test && npm run build
```

根目录 `npm test` 为 Playwright E2E（需先启动三端）。

## 参与贡献

欢迎 Issue 与 PR。开始前阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

- Bug / 功能 — [GitHub Issues](https://github.com/DC-ET/mao/issues)
- 安全漏洞 — [SECURITY.md](SECURITY.md)，勿公开披露

## 文档索引

| 文档 | 说明 |
|------|------|
| [skills/mao-cli/](skills/mao-cli/SKILL.md) | **产品知识库 + REST CLI**（部署、手册、排障） |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献与开发指引 |
| [SECURITY.md](SECURITY.md) | 安全策略 |
| [CHANGELOG.md](CHANGELOG.md) | 发版说明 |
| [docs/plan/technical-design.md](docs/plan/technical-design.md) | 技术设计（维护者） |
| [docs/](docs/) | 各专题设计稿 |
| [AGENTS.md](AGENTS.md) / [CLAUDE.md](CLAUDE.md) | AI 辅助开发指引 |
| [agent-cli/README.md](agent-cli/README.md) | mao-agent 开发者说明 |

## 许可证

[MIT License](LICENSE) — Copyright (c) 2026 Mao Contributors
