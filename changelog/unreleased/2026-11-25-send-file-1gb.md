### 后端

- **`send_file` 单文件上限 30MB → 1GB**：对话页快照改为全链路流式——来源（宿主机 / Docker 容器 / LOCAL 执行端 / http）都边读边写 `FILE_SEND_DIR/.tmp/` 临时文件，本地 `rename` 原子入位、云模式从临时文件单次流式 PUT（显式 Content-Length、空闲 60 秒超时、失败整份重试 1 次），进程内不再同时持有整份文件；写入前按磁盘余量与进程内预留做检查，超过通道上限的大文件另有每用户 1 路 / 全局 4 路的并发闸（对话页没有通道上限，按最严的 20MB 判定），用户点停止会中断传输并删除临时文件、不插表。`send_image` 仍 20MB，微信 / 钉钉 20MB、飞书 30MB 的通道上限不变——超过通道上限的文件只在对话里可见，通道侧标记失败且不读那一份推送字节。
- **Docker / LOCAL 改服务端窗口拉取**：容器通道与执行端 WS 新增区间读取帧（`read_bytes_range` / `delivery_read`），服务端按 512KB × 8 片窗口拉取、边收边写，替代「执行端整份读入后分片推送」；执行端按 streamId 持有句柄、空闲 60 秒回收，逐片校验 size / mtime，读完再比对整份 sha256（不一致即失败）。未绑定设备的会话在多个执行端同时在线时，`open` 由首个成功的执行端认领，后续 `read` / `digest` / `close` 只发给这一条连接，另一台设备不会用「读取流已关闭或不存在」打断发送。旧的 `read_bytes` / `delivery_fetch` 帧与两端实现已删除，旧桌面客户端 / 旧 mao-agent 会明确提示「执行端版本过旧」。
- **通道发送失败时给可下载链接**：`send_image` / `send_file` 在「对话页快照成功、外部通道失败」时（典型：文件超过微信 / 钉钉 20MB、飞书 30MB 上限），工具结果额外返回 `downloadUrl` 与 `downloadUrlExpiresAt`，并在 error 文案里带上链接与「N 小时内有效、请勿转发」，Agent 可以直接把链接发给用户，不必让他自己去网页 / 客户端翻附件。链接用与下载接口同一套无状态票据签发（绑定文件 + 运行身份，12 小时有效），站点 `baseUrl` 未配置时不返回链接。
- **快照下载支持 Range 与短时票据**：`GET /api/v1/files/send-download` 支持 `Range`（本地 206 / 云透传预签名 GET），断线可续传；新增 `POST /api/v1/files/send-download-ticket` 换绑定文件 + 用户的 12 小时无状态票据，下载不再把 JWT 放进 URL；云代读改为连接 10 秒 + 连续 60 秒无数据的空闲超时，不再整次 30 秒墙钟。

### 前端（桌面 / Web / 安卓）

- **大文件下载不再进页面内存**：`send_file` 快照下载改为「换票据 → 交给浏览器 / Chromium 原生下载」，不再 `fetch` 成 Blob、不再 `window.open`（Electron 会把新窗口交给系统浏览器）；超过 20MB 的快照点开只提示「下载后查看」，不把整份载入渲染进程。非快照来源（workspace-download / 活引用）保持原行为。

### 桌面 Electron

- **LOCAL 发送读取改为按区间**：`local-delivery-open` / `local-delivery-read` / `local-delivery-digest` / `local-delivery-close` 四个 IPC 取代一次性 `local-delivery-read-bytes`，主进程按 streamId 持有文件句柄（空闲 60 秒关闭），1GB 不再整份读入主进程内存；`download-url` 交给 Chromium 下载，支持票据 URL。

### 终端 CLI（mao-agent）

- **执行端支持 1GB 发送**：`delivery_read` 的 open / read / digest / close 四段实现替换旧分片推送，单文件上限 1GB、单片 512KB，句柄空闲 60 秒回收；读完向服务端回报整份 sha256。旧版 mao-agent 发送任何大小的 LOCAL 文件都会失败，需升级到本版本。

### 终端 CLI（mao-cli）

- **部署文档补充大文件下载**：Nginx 为 `/api/v1/files/send-download` 单独关闭响应缓冲（`proxy_buffering off` / `proxy_max_temp_file_size 0`），避免网关盘落一份 1GB 临时文件；`FILE_SEND_DIR` 的 `.tmp` 残片清理口径与 1GB 上限写入 `config.md`、`deploy.md`、`desktop.md`。
