### 桌面 Electron

- **修复 Windows 下发送工具传 workspace 内绝对路径被拒**：`delivery_fetch` 路径校验此前一刀切拒绝含反斜杠的路径，而 Windows 绝对路径必然含反斜杠，导致 LOCAL 会话 `send_image` / `send_file` 传本机绝对路径一律失败。现按平台语义放行绝对路径（containment 仍由 realpath 比对兜底），相对路径继续拒绝反斜杠（`/` 为唯一分隔符，防分段走私）。

### 终端 CLI（mao-agent）

- **同构修复 `delivery_fetch` 路径校验**：与桌面端同口径放行 Windows 绝对路径，修复 Windows 上 `send_image` / `send_file` 委托读取本机文件失败的问题。
