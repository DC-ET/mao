# mao-agent CLI

无 GUI 终端对话式 Agent 客户端（`agent-cli/`）。**用户用法与安装**见产品文档：

[skills/mao-cli/reference/mao-agent.md](../skills/mao-cli/reference/mao-agent.md)

与 `mao` CLI 互补：本工具覆盖对话与 WebSocket；元数据与配置用 `mao-cli`。共用 `~/.mao/auth.json`。

## 开发者构建

```bash
cd agent-cli
npm ci && npm run build && npm test
npm run typecheck   # 含 test/ 的类型检查（tsconfig.json 的 build 不含 test/）
npm link            # 本地安装 mao-agent 命令
```

一条命令安装脚本：`scripts/install-mao-agent.sh`（发布用）。

## 代码结构

| 目录 | 职责 |
|------|------|
| `src/args.ts` | 声明式参数解析，`FLAG_SPECS` 是选项唯一定义处（解析与 `--help` 同源） |
| `src/commands/` | 子命令入口：chat / login / logout / ls / status / update |
| `src/session/` | `SessionRunner`：一轮任务的生命周期、忙碌重试、退出码 |
| `src/ws/` | WebSocket 客户端、事件类型与过滤 |
| `src/rest/` | REST 客户端（401 静默续期、幂等方法重试） |
| `src/tui/` | 交互层：`keydecode`（按键解码）、`line-editor`（行编辑状态机）、`input-controller`（输入区状态机）、`layout`（高度预算）、`modal-controller`（提问/审批）、`ink-renderer`（编排 + 帧合并）、`app.tsx` / `widgets.tsx` / `input-box.tsx`（Ink 渲染树） |
| `src/render/` | 非交互输出：text / json / stream-json |
| `src/repl/` | 斜杠命令分发（`handleSlash`） |
| `src/local/` | LOCAL 工具执行、路径沙箱、审批、拒绝清单、MCP 代理 |
| `src/config/` | 用户/项目配置、输入历史 |

交互层的两条硬约束：Ink 在「非 static 树高度 ≥ 终端行数」时会整屏重绘并清掉 scrollback，所以活动区高度必须先由 `layout.ts` 裁剪；Ink 3 的 `useInput` 把一次 data chunk 当成单键，所以按键必须走自研 `keydecode.ts`。改动这两处前先看 `test/ink-renderer.spec.ts` 与 `test/keydecode.spec.ts`。

设计文档（维护者）：[docs/plan/mao-agent-cli-technical-design.md](../docs/plan/mao-agent-cli-technical-design.md)、[docs/plan/mao-agent-cli-ux-design.md](../docs/plan/mao-agent-cli-ux-design.md)。两份均为历史设计记录，当前行为以根 `CHANGELOG.md` 与产品文档为准。
