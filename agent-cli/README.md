# mao-agent CLI

无 GUI 终端对话式 Agent 客户端（`agent-cli/`）。**用户用法与安装**见产品文档：

[skills/mao-cli/reference/mao-agent.md](../skills/mao-cli/reference/mao-agent.md)

与 `mao` CLI 互补：本工具覆盖对话与 WebSocket；元数据与配置用 `mao-cli`。共用 `~/.mao/auth.json`。

## 开发者构建

```bash
cd agent-cli
npm ci && npm run build && npm test
npm link   # 本地安装 mao-agent 命令
```

一条命令安装脚本：`scripts/install-mao-agent.sh`（发布用）。

设计文档（维护者）：[docs/mao-agent-cli-technical-design.md](../docs/mao-agent-cli-technical-design.md)、[docs/mao-agent-cli-ux-design.md](../docs/mao-agent-cli-ux-design.md)
