### 桌面 Electron

- **修复 node-pty 丢 x 位导致中继终端起不来**：`spawn-helper` 被安装 / 打包落成 0644 时 `require` 与 `typeof spawn` 都正常、第一次 spawn 才 `posix_spawnp failed`（表现为「终端启动失败」）；现在加载期幂等补 x 位，`postinstall` 也会顺手修一次。

### 终端 CLI（mao-agent）

- **修复 node-pty 丢 x 位导致中继终端起不来**：`spawn-helper` 被安装 / 打包落成 0644 时 `require` 与 `typeof spawn` 都正常、第一次 spawn 才 `posix_spawnp failed`（表现为「终端启动失败」）；现在 `local --serve` 与交互 LOCAL 模式加载期幂等补 x 位，安装脚本 `scripts/install-mao-agent.sh` 也会顺手修一次，无需手动 `chmod`。
