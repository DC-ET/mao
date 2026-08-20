# mao-cli

Mao 平台的**可独立分发**知识库与代理入口：产品说明、部署配置、全端使用手册，以及 REST API 命令行工具。

## 这是什么

| 能力 | 说明 |
|------|------|
| **知识库** | 回答「Mao 是什么、怎么装、怎么部署、各端怎么用、如何排障」 |
| **REST CLI** | `mao` / `mao-cli` 调用大部分管理与用户 REST API（不含对话与 WebSocket） |
| **代理入口** | 给 Codex、Cursor 等 Agent 安装本目录后，按 `SKILL.md` 路由阅读文档并执行 CLI |

完整发版记录见 Mao 仓库根目录 `CHANGELOG.md`（独立带走本目录时无该文件，以你拿到的发行包版本为准）。

## 给人类

1. 阅读 [SKILL.md](SKILL.md) 了解路由与 CLI 规则。
2. 安装 CLI（需 Node.js ≥ 18）：

```bash
cd /path/to/mao-cli
npm install . -g
mao auth login --username <用户> --password <密码>
mao --help
```

3. 对话式 Agent 请用 `mao-agent`（见 [reference/mao-agent.md](reference/mao-agent.md)），不要用本 CLI 发消息。

## 给 Agent

1. **先读** [SKILL.md](SKILL.md)，按用户问题路由到 `reference/*.md`。
2. **部署 Mao** 时只读 `reference/install.md`、`reference/deploy.md`、`reference/config.md`，不要假设能访问完整源码仓库。
3. **调 API** 时先 `npm install . -g`（若 `mao` 不可用），再读对应 `reference/<模块>.md`。
4. **跑对话** 时引导用户安装 `mao-agent`，见 `reference/mao-agent.md`。

## 目录结构

```text
SKILL.md              总路由
README.md             本说明
business_process.md   端到端业务流程
reference/
  project.md          项目定位与架构
  install.md          本地开发安装
  deploy.md           生产自托管部署
  config.md           环境变量与默认账号
  admin.md            管理后台使用
  desktop.md          桌面 Web 端使用
  electron.md         Electron LOCAL 模式
  android.md          安卓 APP
  mao-agent.md        终端对话 CLI
  troubleshooting.md  常见问题
  mcp.md              MCP REST CLI
  …                   各 REST 模块 CLI 说明
bin/ lib/ package.json CLI 实现
```
