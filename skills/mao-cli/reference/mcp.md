# MCP 模块

管理 MCP 服务器：用户级私有 MCP、全局 MCP（管理员）、以及用户对全局/私有 MCP 的启用偏好。

工具注入命名：`mcp__{server}__{tool}`。CLOUD 模式服务端直连；LOCAL 由桌面端/Electron 或 `mao-agent --local` 代理并纳入审批。

生产环境使用 MCP 时建议配置 `APP_MCP_SECRET`（见 [config.md](config.md)）。

## 命令选择

| 场景 | 命令 |
|------|------|
| 查看我可用的 MCP 及启用状态 | `mcp preferences` |
| 启用/禁用某个 MCP（全局或自己的） | `mcp preferences-set` |
| 我的私有 MCP 列表 | `mcp me-list` |
| 创建/改/删/测 私有 MCP | `mcp me-create` / `me-update` / `me-delete` / `me-test` |
| 管理员：列表/详情/CRUD/启停/测试 | `mcp list` / `get` / `create` / `update` / `set-status` / `delete` / `test` |
| 仅已启用的全局 MCP | `mcp enabled` |

全局 MCP 命令需要管理员权限（403 表示非管理员）。

## 服务器类型

| server-type | 字段 |
|-------------|------|
| `stdio` | `--command`、`--args`（逗号分隔）、可选 `--env` JSON |
| `http` | `--url`、可选 `--env` |

`--env` 示例：`--env '{"API_KEY":"xxx"}'`（敏感值由服务端加密存储）。

## 示例

```bash
# 查看偏好
mao mcp preferences --json

# 禁用全局 MCP id=2
mao mcp preferences-set --server-id 2 --enabled false

# 用户私有 stdio MCP
mao mcp me-create --name my-mcp --server-type stdio \
  --command npx --args -y,@modelcontextprotocol/server-filesystem,/tmp

# 测试连接（返回工具列表）
mao mcp me-test --id 3 --json

# 管理员创建全局 HTTP MCP
mao mcp create --name corp-gateway --server-type http \
  --url https://mcp.example.com/mcp --env '{"TOKEN":"secret"}'

mao mcp test --id 1
mao mcp set-status --id 1 --status DISABLED
```

## API 映射

| CLI | HTTP |
|-----|------|
| `preferences` | GET `/mcp-servers/preferences` |
| `preferences-set` | PUT `/mcp-servers/preferences` |
| `me-list` | GET `/mcp-servers/me` |
| `me-create` | POST `/mcp-servers/me` |
| `me-update` | PUT `/mcp-servers/me/:id` |
| `me-delete` | DELETE `/mcp-servers/me/:id` |
| `me-test` | POST `/mcp-servers/me/:id/test` |
| `list` | GET `/mcp-servers` |
| `enabled` | GET `/mcp-servers/enabled` |
| `get` | GET `/mcp-servers/:id` |
| `create` | POST `/mcp-servers` |
| `update` | PUT `/mcp-servers/:id` |
| `set-status` | PUT `/mcp-servers/:id/status` |
| `delete` | DELETE `/mcp-servers/:id` |
| `test` | POST `/mcp-servers/:id/test` |

测试失败时 HTTP 200 但 `code !== 0`，message 含连接错误详情；可用 `--raw` 查看完整 Result。

## 与 UI 的关系

- 管理后台「MCP 服务器」对应全局 `mcp list/create/...`
- 桌面端「MCP」对应 `mcp me-*` 与 `mcp preferences`

对话中 Agent 实际调用 MCP 工具不走本 CLI，走 WebSocket 会话与 Harness。
