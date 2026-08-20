# LOCAL 模式本机工具执行

`mao-agent --local` 把 CLI 当成 Electron 主进程：接收 `tool_execute` / `skill_sync_required` / `mcp_sync_required`，在本机执行后回 `tool_result` / `tool_error` / `skill_sync_done` / `mcp_tools_report`。

实现位于 `agent-cli/src/local/`。`shell` 优先 `require` 包内 `vendor/localShell.cjs`（与 `desktop/electron/localShell.cjs` 保持一致），独立安装时不必带上整个仓库。

后端前置：`LOCAL_CAPABLE_CLIENTS = { electron, cli }`（`streaming-ws-registry.ts`）。未改后端时会收到 `Local client is not connected`。
