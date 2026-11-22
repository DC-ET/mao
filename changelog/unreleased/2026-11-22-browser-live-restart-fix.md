### 后端

- **修复同一会话第二次浏览器直播不显示**：browser-use 直播 sidecar 的 started 闩锁在每次停止后复位（host 进程被复用或 WS 重连后能重新发出 `browser_live_started`）。此前第二场直播只发帧不发 started，前端永远停留在上一场"已结束"。

### 前端（桌面 / Web / 安卓）

- **直播开始时重置帧序号与画面**：`browser_live_started` 到达时清空 `lastSeq` 与上一场冻结帧——sidecar 进程重启后 seq 从 1 重新计数，不清则第二场画面全部被乱序丢弃、旧画面残留。

### 桌面 Electron

- **修复 LOCAL 直播第二场死路**：停止事件到达即断开残留 SSE 并清空旧端口信息，新一轮 shell 触发 attach 时清除上一场停止状态；此前第二次 attach 会早退去连已死旧端口、重连又被停止状态拦截，同会话第二场直播永远连不上。
