### 后端

- **统一发送图片 / 文件工具**：新增 `send_image` / `send_file` 收编原六个通道发送工具（`send_wechat_image` / `send_wechat_file` / `feishu_send_image` / `feishu_send_file` / `dingtalk_send_image` / `dingtalk_send_file`），旧名字从工具表移除（历史记录里的旧工具卡仍按原名展示）。不绑定通道的会话也能发送；绑定了微信 / 飞书 / 钉钉的会话，同一份字节再推到对应通道，会话副本与通道推送两侧独立成败（`channelStatus` 为 `skipped` / `sent` / `failed`）。每次发送都在 `uploads/{用户}/` 留一份会话副本，结果里的 `delivery` 供任何客户端渲染；图片上限 20MB、文件上限 30MB。图片副本按字节魔数校验格式；可执行内容（html / svg / 脚本等）的副本一律以 `.bin` 保存，避免同源打开执行脚本。
- **LOCAL 会话委托执行端读取发送字节**：服务器读不到本机文件时下发 `delivery_fetch` 帧，由执行端读取 workspace 内文件并分片回传（512KB 一片、20 秒总超时、单文件上限取副本上限）。执行端不在线或版本过旧时工具返回「执行端不在线或版本过旧，无法读取本机文件」，不挂起本轮。

### 前端（桌面 / Web / 安卓）

- **回复下方展示已发送的图片 / 文件**：该轮 `send_image` / `send_file` 的会话副本画在最终回复下方（图片缩略图网格，可点开大图；文件显示名称与大小，可点开查看），与文件变更面板同一层。执行中随工具结果实时出现，刷新后从工具结果回放，同一会话在任何客户端打开都看得到（嵌入浮窗同样展示）。
- **工具卡中文名与预览**：`send_image` / `send_file` 显示「发送图片」/「发送文件」及参数预览（旧工具名保留历史兼容）。

### 桌面 Electron

- **委托读取发送字节**：新增 `local-delivery-read-bytes` IPC，按会话 workspace 校验后读取本机文件并分片回传（支持 workspace 内相对路径与绝对路径，realpath containment、仅普通文件、上限 30MB）；读取失败静默不回包，由服务端超时统一收敛。

### 终端 CLI（mao-agent）

- **支持 `delivery_fetch` 委托帧**：作为 LOCAL 执行端时读取信任工作区内文件并分片回传（512KB 分片；信任外 / 越界 / 符号链接 / 超过上限一律静默不回包）。顺带修复正文图片 `file_fetch` 帧此前未进入 daemon 与交互 REPL 路由、纯 mao-agent 执行端收不到该帧的问题。
