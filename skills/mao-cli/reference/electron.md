# Electron 桌面端与 LOCAL 模式

仓库提供 Electron **源码**，不提供官方签名安装包。LOCAL 模式下工具通过 Electron Main 在本机执行：Shell、读写文件、glob/grep、MCP，并支持工具审批。

Web 端能力与 CLOUD 说明见 [desktop.md](desktop.md)。

## 何时用 Electron

- 需要 **LOCAL** 模式访问本机项目目录
- 需要本机 Shell、文件编辑、本地 MCP
- 需要 LOCAL 工具审批流程
- 需要飞书内嵌窗口登录（内网 redirect 场景）

浏览器 `npm run dev` **不能** LOCAL。

## 开发运行

```bash
cd desktop
npm install
npm run dev:electron
```

API 地址由 `desktop/.env.development` 配置（默认 `http://localhost:9080/api/v1`）。

## 生产打包

在**开发机**（非必须服务器）：

```bash
cd desktop
# 修改 .env.production 为部署域名，如 https://mao.example.com/api/v1
npm ci
npm run build
npm run dist
```

产物在 `desktop/release/`。代码签名与内部分发自行处理。

## 自动更新

Electron 壳支持自动更新。默认检查 `https://mao.example.com/uploads/releases/`（与 Web 同域 `uploads`）。私有部署修改 `desktop/package.json` 的 `build.publish[0].url` 后再打包。

Web 前端更新：部署 `desktop/dist` 后刷新；Electron 壳更新需用户安装新包（或走自动更新）。

## LOCAL 执行架构

1. 用户在 Electron 中创建 LOCAL 会话并选本机工作区
2. WebSocket 连接后端 `/api/ws/stream`
3. Harness 将工具调用通过 `tool_execute` 事件发给 Electron
4. `electron/main.cjs` 执行 Shell/文件/MCP，结果回传后端
5. 高风险操作按权限档位弹出审批（preload 桥接）

## 权限与审批

与 Web 端档位一致：只读 / 读写 / 智能审批 / 完全权限。审批前检查命令目录、删除、远程 git、未知依赖等。

`mao-agent --local` 在终端实现类似 LOCAL 能力（工作区信任、默认拒绝清单、`--yolo`），见 [mao-agent.md](mao-agent.md)。

## 技能与 MCP 同步

LOCAL 会话启动时 Electron 可同步技能 zip 与用户 MCP 配置，与云端 Harness 工具列表对齐。

## 与 mao-agent LOCAL 的区别

| | Electron | mao-agent --local |
|---|----------|-------------------|
| 界面 | 完整桌面 UI | 终端 REPL |
| 审批 | 图形审批卡片 | TTY 确认 / 规则 |
| 典型用户 | 日常研发协作 | CI、脚本、无 GUI 环境 |

两者均可作为 LOCAL 工具执行端连接同一后端。

## 飞书登录

Electron 使用内嵌窗口完成飞书 OAuth，避免手机扫码无法访问内网 `redirect_uri` 的问题。
